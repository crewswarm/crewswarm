// @ts-nocheck
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Logger } from '../utils/logger.js';
import { EngineSessionLayer, buildSessionPromptEnvelope } from './session-layer.js';
import { ConversationTranscriptStore, buildConversationHydrationPrompt } from '../session/conversation-transcript.js';
import { NativeEngineSessionManager, buildEngineShellCommand } from './native-session.js';
import { ToolAuditStore, buildReplayPlan, extractToolCalls, previewAuditOutput } from './tool-audit.js';
const logger = new Logger({ level: process.env.CREW_LOG_LEVEL || 'info' });
const nativeSessionManagers = new Map<string, NativeEngineSessionManager>();

export interface EngineRunOptions {
  model?: string;
  cwd?: string;
  timeoutMs?: number;
  sessionId?: string;
  sessionTurns?: number;
  projectDir?: string;
  systemPrompt?: string;
  runId?: string;
  onEvent?: (event: EngineRunEvent) => void;
}

export interface EngineRunResult {
  success: boolean;
  engine: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface EngineRunEvent {
  type: 'start' | 'chunk' | 'end' | 'error' | 'tool-audit';
  ts: string;
  engine: string;
  runId?: string;
  sessionId?: string;
  text?: string;
  exitCode?: number;
  success?: boolean;
  mode?: string;
  toolCount?: number;
}

function emitEngineEvent(options: EngineRunOptions, engine: string, event: Omit<EngineRunEvent, 'ts' | 'engine'>): void {
  const cb = options.onEvent;
  if (!cb) return;
  try {
    cb({
      ts: new Date().toISOString(),
      engine,
      ...event
    });
  } catch {
    // ignore callback failures
  }
}

function sessionLayerEnabled(): boolean {
  const raw = String(process.env.CREW_ENGINE_SESSION_ENABLED || 'true').trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'off' && raw !== 'no';
}

function nativeEngineSessionEnabled(): boolean {
  const raw = String(process.env.CREW_ENGINE_NATIVE_SESSION_ENABLED || 'true').trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'off' && raw !== 'no';
}

function isCliEngine(engine: string): boolean {
  const e = String(engine || '').trim().toLowerCase();
  return e === 'codex-cli' || e === 'claude-cli' || e === 'cursor-cli' || e === 'cursor' || e === 'gemini-cli' || e === 'opencode-cli' || e === 'opencode';
}

function getNativeSessionManager(baseDir: string): NativeEngineSessionManager {
  const key = String(baseDir || process.cwd());
  if (!nativeSessionManagers.has(key)) {
    nativeSessionManagers.set(key, new NativeEngineSessionManager(key));
  }
  return nativeSessionManagers.get(key)!;
}

async function preparePromptWithSession(
  engine: string,
  prompt: string,
  options: EngineRunOptions
): Promise<{
  effectivePrompt: string;
  engineStore: EngineSessionLayer | null;
  transcriptStore: ConversationTranscriptStore | null;
}> {
  if (!sessionLayerEnabled()) {
    return {
      effectivePrompt: options.systemPrompt ? buildSessionPromptEnvelope({ systemPrompt: options.systemPrompt, history: [], prompt }) : prompt,
      engineStore: null,
      transcriptStore: null
    };
  }

  const sessionId = String(options.sessionId || '').trim();
  const systemPrompt = String(options.systemPrompt || '').trim();
  if (!sessionId) {
    if (!systemPrompt) {
      return {
        effectivePrompt: prompt,
        engineStore: null,
        transcriptStore: null
      };
    }
    return {
      effectivePrompt: buildSessionPromptEnvelope({ systemPrompt, history: [], prompt }),
      engineStore: null,
      transcriptStore: null
    };
  }

  const baseDir = String(options.projectDir || options.cwd || process.cwd());
  const engineStore = new EngineSessionLayer(baseDir);
  const transcriptStore = new ConversationTranscriptStore(baseDir);
  const maxTurns = Math.max(1, Number(options.sessionTurns || 6));
  const [engineHistory, conversationHistory] = await Promise.all([
    engineStore.getRecentTurns(engine, sessionId, maxTurns),
    transcriptStore.getRecentTurns(sessionId, Math.max(2, maxTurns * 2))
  ]);
  const withConversation = buildConversationHydrationPrompt({
    turns: conversationHistory,
    currentPrompt: prompt
  });
  const effectivePrompt = buildSessionPromptEnvelope({
    systemPrompt,
    history: engineHistory,
    prompt: withConversation
  });
  return { effectivePrompt, engineStore, transcriptStore };
}

async function persistEngineTurn(
  engineStore: EngineSessionLayer | null,
  transcriptStore: ConversationTranscriptStore | null,
  engine: string,
  prompt: string,
  options: EngineRunOptions,
  result: EngineRunResult,
  durationMs: number
): Promise<void> {
  const sessionId = String(options.sessionId || '').trim();
  if (!sessionId) {
    return;
  }
  try {
    if (engineStore) {
      await engineStore.appendTurn({
        engine,
        sessionId,
        prompt,
        response: result.success ? result.stdout : result.stderr,
        success: result.success,
        exitCode: Number(result.exitCode || 0),
        model: options.model,
        durationMs,
        keepTurns: Number(process.env.CREW_ENGINE_SESSION_KEEP_TURNS || 20)
      });
    }
    if (transcriptStore) {
      await transcriptStore.appendTurn({
        sessionId,
        role: 'user',
        text: prompt,
        engine,
        keepTurns: Number(process.env.CREW_CONVERSATION_KEEP_TURNS || 40)
      });
      await transcriptStore.appendTurn({
        sessionId,
        role: 'assistant',
        text: result.success ? result.stdout : result.stderr,
        engine,
        keepTurns: Number(process.env.CREW_CONVERSATION_KEEP_TURNS || 40)
      });
    }
  } catch (err) {
    logger.warn(`[engine-session] failed to persist turn: ${(err as Error).message}`);
  }
}

async function runCommand(command: string, args: string[], options: EngineRunOptions = {}, stdin?: string): Promise<EngineRunResult> {
  const engineLabel = String(command || '');
  emitEngineEvent(options, engineLabel, {
    type: 'start',
    runId: options.runId,
    sessionId: options.sessionId,
    mode: 'spawn'
  });
  return new Promise(resolve => {
    // Strip env vars that prevent CLI engines from running inside other sessions
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE;
    if (/(^|[\\/])claude$/.test(engineLabel)) {
      delete cleanEnv.ANTHROPIC_API_KEY;
    }

    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: cleanEnv
    });

    let stdinWritten = false;
    if (stdin && child.stdin) {
      try {
        child.stdin.write(stdin, 'utf8', (err) => {
          if (err) {
            logger.error(`[${command}] stdin write error:`, err);
          }
          // Give the process a moment to start reading before closing stdin
          setTimeout(() => {
            if (child.stdin && !child.stdin.destroyed) {
              child.stdin.end();
            }
          }, 50);
        });
        stdinWritten = true;
      } catch (err) {
        logger.error(`[${command}] failed to write stdin:`, err);
      }
    }

    const timeoutMs = options.timeoutMs || 600000;
    let stdout = '';
    let stderr = '';
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      logger.error(`[${command}] Timing out after ${timeoutMs}ms. stdout: ${stdout.slice(0, 200)}, stderr: ${stderr.slice(0, 200)}`);
      child.kill('SIGTERM');
      // Give process 2s to clean up, then SIGKILL if needed
      setTimeout(() => {
        if (!done && !child.killed) {
          child.kill('SIGKILL');
        }
      }, 2000);
      done = true;
      resolve({
        success: false,
        engine: command,
        stdout,
        stderr: `${stderr}\nTimed out after ${timeoutMs}ms`,
        exitCode: -1
      });
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      const text = String(chunk);
      stdout += text;
      emitEngineEvent(options, engineLabel, {
        type: 'chunk',
        runId: options.runId,
        sessionId: options.sessionId,
        text
      });
    });
    child.stderr.on('data', chunk => {
      const text = String(chunk);
      stderr += text;
      emitEngineEvent(options, engineLabel, {
        type: 'chunk',
        runId: options.runId,
        sessionId: options.sessionId,
        text
      });
    });

    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      logger.error(`[${command}] process error:`, err);
      resolve({
        success: false,
        engine: command,
        stdout,
        stderr: `${stderr}\nProcess error: ${err.message}`,
        exitCode: -1
      });
    });

    child.on('close', code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        success: code === 0,
        engine: command,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? -1
      });
      emitEngineEvent(options, engineLabel, {
        type: 'end',
        runId: options.runId,
        sessionId: options.sessionId,
        exitCode: code ?? -1,
        success: code === 0,
        mode: 'spawn'
      });
    });
  });
}

async function maybeRunViaNativeSession(engine: string, prompt: string, options: EngineRunOptions): Promise<EngineRunResult | null> {
  if (!nativeEngineSessionEnabled()) return null;
  if (!isCliEngine(engine)) return null;
  const sessionId = String(options.sessionId || '').trim();
  if (!sessionId) return null;

  const cwd = String(options.cwd || options.projectDir || process.cwd());
  const command = buildEngineShellCommand(engine, prompt, options.model, cwd);
  if (!command) return null;
  const manager = getNativeSessionManager(cwd);
  emitEngineEvent(options, engine, {
    type: 'start',
    runId: options.runId,
    sessionId,
    mode: 'native-shell'
  });
  const result = await manager.runInSession({
    engine,
    sessionId,
    cwd,
    command,
    timeoutMs: options.timeoutMs,
    onChunk: (text: string) => {
      emitEngineEvent(options, engine, {
        type: 'chunk',
        runId: options.runId,
        sessionId,
        text
      });
    }
  });

  if (result.mode === 'fallback') return null;
  emitEngineEvent(options, engine, {
    type: result.success ? 'end' : 'error',
    runId: options.runId,
    sessionId,
    exitCode: result.exitCode,
    success: result.success,
    mode: result.mode
  });
  return {
    success: result.success,
    engine,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.exitCode
  };
}

async function callJsonApi(url: string, apiKey: string | null, body: unknown): Promise<string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text.slice(0, 500)}`);
  }

  const data = await response.json() as any;
  return data?.content?.[0]?.text
    || data?.candidates?.[0]?.content?.parts?.[0]?.text
    || data?.output_text
    || JSON.stringify(data);
}

export async function runGeminiApi(prompt: string, options: EngineRunOptions = {}): Promise<EngineRunResult> {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) {
    return {
      success: false,
      engine: 'gemini-api',
      stdout: '',
      stderr: 'Missing GEMINI_API_KEY/GOOGLE_API_KEY',
      exitCode: 1
    };
  }

  const model = options.model || 'gemini-2.0-flash';
  try {
    const text = await callJsonApi(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
      null,
      { contents: [{ parts: [{ text: prompt }] }] }
    );
    return { success: true, engine: 'gemini-api', stdout: text, stderr: '', exitCode: 0 };
  } catch (error) {
    return { success: false, engine: 'gemini-api', stdout: '', stderr: (error as Error).message, exitCode: 1 };
  }
}

export async function runClaudeApi(prompt: string, options: EngineRunOptions = {}): Promise<EngineRunResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return {
      success: false,
      engine: 'claude-api',
      stdout: '',
      stderr: 'Missing ANTHROPIC_API_KEY',
      exitCode: 1
    };
  }

  const model = options.model || 'claude-3-5-sonnet-latest';
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API error ${response.status}: ${text.slice(0, 500)}`);
    }
    const data = await response.json() as any;
    const text = data?.content?.[0]?.text || JSON.stringify(data);
    return { success: true, engine: 'claude-api', stdout: text, stderr: '', exitCode: 0 };
  } catch (error) {
    return { success: false, engine: 'claude-api', stdout: '', stderr: (error as Error).message, exitCode: 1 };
  }
}

export async function runGeminiCli(prompt: string, options: EngineRunOptions = {}): Promise<EngineRunResult> {
  const args = ['-p', prompt];
  if (options.model) {
    args.push('-m', options.model);
  }
  return runCommand('gemini', args, options);
}

export async function runCodexCli(prompt: string, options: EngineRunOptions = {}): Promise<EngineRunResult> {
  const args = ['-a', 'never', 'exec', '--sandbox', 'danger-full-access', '--json'];
  return runCommand('codex', args, options, prompt);
}

export async function runClaudeCli(prompt: string, options: EngineRunOptions = {}): Promise<EngineRunResult> {
  const args = ['-p', '--setting-sources', 'user'];
  if (process.env.CREW_CLAUDE_SKIP_PERMISSIONS === 'true') {
    args.push('--dangerously-skip-permissions');
  }
  return runCommand('claude', args, options, prompt);
}

/**
 * Cursor engine: use the Cursor **agent** CLI (`agent`), same as gateway bypass
 * (`lib/engines/runners.mjs` / `CURSOR_CLI_BIN`). The `cursor` binary on PATH is
 * often the IDE opener (Electron) — not compatible with `--execute`.
 */
function resolveCursorAgentBin(): string {
  const fromEnv = String(process.env.CURSOR_CLI_BIN || '').trim();
  if (fromEnv) return fromEnv;
  const agentLocal = path.join(os.homedir(), '.local', 'bin', 'agent');
  if (fs.existsSync(agentLocal)) return agentLocal;
  return 'agent';
}

export async function runCursorCli(prompt: string, options: EngineRunOptions = {}): Promise<EngineRunResult> {
  const bin = resolveCursorAgentBin();
  const projectDir = options.cwd || options.projectDir || process.cwd();
  const cursorDefault = process.env.CREWSWARM_CURSOR_MODEL || 'composer-2-fast';
  let model = options.model;
  if (!model || String(model).trim() === '') {
    model = cursorDefault;
  } else if (String(model).includes('/')) {
    model = cursorDefault;
  } else if (String(model).includes('sonnet-4.6')) {
    model = 'sonnet-4.5';
  }
  const args = [
    '-p',
    '--force',
    '--trust',
    '--output-format',
    'stream-json',
    prompt,
    '--model',
    model,
    '--workspace',
    projectDir
  ];
  return runCommand(bin, args, { ...options, cwd: projectDir });
}

export async function runOpenCodeCli(prompt: string, options: EngineRunOptions = {}): Promise<EngineRunResult> {
  const args = ['run'];
  if (options.model) {
    args.push('--model', options.model);
  }
  args.push(prompt);
  return runCommand('opencode', args, options);
}

export async function runEngine(engine: string, prompt: string, options: EngineRunOptions = {}): Promise<EngineRunResult> {
  const normalizedEngine = String(engine || '').trim().toLowerCase();
  const start = Date.now();
  const runId = String(options.runId || `eng-${randomUUID()}`);
  const optionsWithRunId: EngineRunOptions = { ...options, runId };
  const { effectivePrompt, engineStore, transcriptStore } = await preparePromptWithSession(normalizedEngine, prompt, options);
  let result: EngineRunResult;

  const native = await maybeRunViaNativeSession(normalizedEngine, effectivePrompt, optionsWithRunId);
  if (native) {
    result = native;
    await persistEngineTurn(engineStore, transcriptStore, normalizedEngine, prompt, optionsWithRunId, result, Date.now() - start);
    await maybeRecordToolAudit(runId, normalizedEngine, prompt, result, optionsWithRunId);
    return result;
  }

  switch (normalizedEngine) {
    case 'gemini-api':
      result = await runGeminiApi(effectivePrompt, options);
      break;
    case 'claude-api':
      result = await runClaudeApi(effectivePrompt, options);
      break;
    case 'gemini-cli':
      result = await runGeminiCli(effectivePrompt, options);
      break;
    case 'codex-cli':
      result = await runCodexCli(effectivePrompt, options);
      break;
    case 'claude-cli':
      result = await runClaudeCli(effectivePrompt, options);
      break;
    case 'cursor':
    case 'cursor-cli':
      result = await runCursorCli(effectivePrompt, options);
      break;
    case 'opencode':
    case 'opencode-cli':
      result = await runOpenCodeCli(effectivePrompt, options);
      break;
    default:
      result = {
        success: false,
        engine: normalizedEngine,
        stdout: '',
        stderr: `Unknown engine "${normalizedEngine}"`,
        exitCode: 1
      };
      break;
  }

  await persistEngineTurn(engineStore, transcriptStore, normalizedEngine, prompt, optionsWithRunId, result, Date.now() - start);
  await maybeRecordToolAudit(runId, normalizedEngine, prompt, result, optionsWithRunId);
  return result;
}

async function maybeRecordToolAudit(
  runId: string,
  engine: string,
  prompt: string,
  result: EngineRunResult,
  options: EngineRunOptions
): Promise<void> {
  const raw = result.success ? result.stdout : result.stderr;
  const toolCalls = extractToolCalls(raw);
  const store = new ToolAuditStore(String(options.projectDir || options.cwd || process.cwd()));
  await store.record({
    runId,
    ts: new Date().toISOString(),
    engine,
    sessionId: options.sessionId,
    prompt: previewAuditOutput(prompt),
    success: result.success,
    exitCode: result.exitCode,
    toolCalls,
    rawOutputPreview: previewAuditOutput(raw)
  });
  emitEngineEvent(options, engine, {
    type: 'tool-audit',
    runId,
    sessionId: options.sessionId,
    toolCount: toolCalls.length
  });
}

export async function listNativeEngineSessions(baseDir = process.cwd()): Promise<Record<string, unknown>> {
  const manager = getNativeSessionManager(baseDir);
  return manager.list();
}

export async function closeNativeEngineSessions(baseDir = process.cwd()): Promise<void> {
  const manager = getNativeSessionManager(baseDir);
  await manager.closeAll();
}

export async function getToolAuditRuns(baseDir = process.cwd(), limit = 30): Promise<Array<Record<string, unknown>>> {
  const store = new ToolAuditStore(baseDir);
  return store.list(limit);
}

export async function getToolAuditReplayPlan(baseDir: string, runId: string): Promise<ReturnType<typeof buildReplayPlan> | null> {
  const store = new ToolAuditStore(baseDir);
  const run = await store.loadRun(runId);
  if (!run) return null;
  return buildReplayPlan(run);
}
