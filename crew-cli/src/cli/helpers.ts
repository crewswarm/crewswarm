/**
 * CLI helper functions extracted from src/cli/index.ts.
 *
 * Pure utilities, type definitions, and small shared routines used by the
 * commander program and its sub-commands.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AgentRouter } from '../agent/router.js';
import type { Orchestrator } from '../orchestrator/index.js';
import type { Logger } from '../utils/logger.js';
import type { CheckpointStore } from '../checkpoint/store.js';
import type { PipelineRunEvent, DispatchOptions } from '../types/common.js';
import { isRetryableError } from '../runtime/execution-policy.js';

// ── Exported types ──────────────────────────────────────────────────────

export type SubscriptionEngineId = 'cursor' | 'claude-cli' | 'codex-cli';

export interface SubscriptionEngineProbe {
  id: SubscriptionEngineId;
  binary: string;
  installed: boolean;
  authenticated: boolean;
  ready: boolean;
  notes: string[];
  version: string;
}

// ── Headless shortcut arg parser ────────────────────────────────────────

export function parseHeadlessShortcutArgs(args: string[]) {
  const enabled = args.includes('--headless');
  if (!enabled) return { enabled: false };

  const readValue = (...names: string[]) => {
    for (let i = 0; i < args.length; i += 1) {
      if (names.includes(args[i])) return args[i + 1];
    }
    return undefined;
  };

  return {
    enabled: true,
    json: args.includes('--json'),
    alwaysApprove: args.includes('--always-approve'),
    out: readValue('--out'),
    task: readValue('-t', '--task'),
    agent: readValue('--agent'),
    gateway: readValue('-g', '--gateway')
  };
}

// ── Validation signal extraction ────────────────────────────────────────

export function extractValidationSignals(result: Record<string, unknown>, requireValidation: boolean) {
  if (!requireValidation) {
    return {
      required: false,
      passed: true,
      lintPassed: undefined as boolean | undefined,
      testsPassed: undefined as boolean | undefined,
      notes: ''
    };
  }

  const candidates = [
    result?.validation,
    result?.metadata?.validation,
    result?.meta?.validation
  ].filter(Boolean);
  const merged = Object.assign({}, ...candidates);

  let lintPassed: boolean | undefined;
  let testsPassed: boolean | undefined;
  const hasLint = typeof merged?.lintPassed === 'boolean' || typeof result?.lintPassed === 'boolean';
  const hasTests = typeof merged?.testsPassed === 'boolean' || typeof result?.testsPassed === 'boolean';
  if (hasLint) lintPassed = Boolean(merged?.lintPassed ?? result?.lintPassed);
  if (hasTests) testsPassed = Boolean(merged?.testsPassed ?? result?.testsPassed);

  let explicitPass: boolean | undefined;
  if (typeof merged?.passed === 'boolean') explicitPass = merged.passed;
  else if (typeof merged?.ok === 'boolean') explicitPass = merged.ok;
  else if (typeof merged?.success === 'boolean') explicitPass = merged.success;

  if (explicitPass === undefined && !hasLint && !hasTests) {
    const text = String(result?.result || '').toLowerCase();
    if (/\btests?\s+(all\s+)?passed\b/.test(text)) testsPassed = true;
    if (/\b(?:lint|eslint|typecheck|type-check)\s+passed\b/.test(text)) lintPassed = true;
    if (/\btests?\s+failed\b/.test(text)) testsPassed = false;
    if (/\b(?:lint|eslint|typecheck|type-check)\s+failed\b/.test(text)) lintPassed = false;
  }

  const anySignal = explicitPass !== undefined || lintPassed !== undefined || testsPassed !== undefined;
  const checks: boolean[] = [];
  if (explicitPass !== undefined) checks.push(explicitPass);
  if (lintPassed !== undefined) checks.push(lintPassed);
  if (testsPassed !== undefined) checks.push(testsPassed);
  const passed = anySignal && checks.every(Boolean);
  const notes = passed
    ? 'validation-signals-present'
    : anySignal
      ? 'validation-failed'
      : 'validation-signals-missing';

  return {
    required: true,
    passed,
    lintPassed,
    testsPassed,
    notes
  };
}

// ── Binary / system detection helpers ───────────────────────────────────

export function hasBinary(bin: string): boolean {
  try {
    execSync(`command -v ${bin}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function readBinaryVersion(bin: string): string {
  try {
    return String(execSync(`${bin} --version`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim();
  } catch {
    return '';
  }
}

export function commandOutput(command: string): { ok: boolean; output: string } {
  try {
    const output = String(execSync(`${command} 2>&1`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
    return { ok: true, output };
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string };
    const output = String(execError.stdout || execError.stderr || '').trim();
    return { ok: false, output };
  }
}

export function detectCliAuthStatus(): { claude: boolean; codex: boolean; cursor: boolean } {
  const claude = hasBinary('claude')
    ? (() => {
      const result = commandOutput('claude auth status');
      const text = (result.output || '').toLowerCase();
      if (!text) return false;
      if (/"loggedin"\s*:\s*true/.test(text)) return true;
      if (text.includes('logged in')) return true;
      return false;
    })()
    : false;

  const codex = hasBinary('codex')
    ? (() => {
      const result = commandOutput('codex login status');
      const text = (result.output || '').toLowerCase();
      return text.includes('logged in');
    })()
    : false;

  const cursor = hasBinary('cursor') && existsSync(join(homedir(), '.cursor', 'User', 'globalStorage', 'state.vscdb'));

  return { claude, codex, cursor };
}

export function detectSubscriptionEngines(tokens: Record<string, string | undefined>): SubscriptionEngineProbe[] {
  const cursorInstalled = hasBinary('cursor');
  const claudeInstalled = hasBinary('claude');
  const codexInstalled = hasBinary('codex');
  const cliAuth = detectCliAuthStatus();

  const cursorAuth = Boolean(tokens.cursor || cliAuth.cursor);
  const claudeAuth = Boolean(tokens.claude || cliAuth.claude);
  const codexAuth = Boolean(tokens.openai || process.env.OPENAI_API_KEY || cliAuth.codex);

  return [
    {
      id: 'cursor',
      binary: 'cursor',
      installed: cursorInstalled,
      authenticated: cursorAuth,
      ready: cursorInstalled && cursorAuth,
      notes: [
        cursorInstalled ? 'binary-ok' : 'missing-binary',
        cursorAuth ? 'auth-ok' : 'auth-not-detected'
      ],
      version: cursorInstalled ? readBinaryVersion('cursor') : ''
    },
    {
      id: 'claude-cli',
      binary: 'claude',
      installed: claudeInstalled,
      authenticated: claudeAuth,
      ready: claudeInstalled && claudeAuth,
      notes: [
        claudeInstalled ? 'binary-ok' : 'missing-binary',
        claudeAuth ? 'auth-ok' : 'auth-not-detected'
      ],
      version: claudeInstalled ? readBinaryVersion('claude') : ''
    },
    {
      id: 'codex-cli',
      binary: 'codex',
      installed: codexInstalled,
      authenticated: codexAuth,
      ready: codexInstalled && codexAuth,
      notes: [
        codexInstalled ? 'binary-ok' : 'missing-binary',
        codexAuth ? 'auth-ok' : 'auth-not-detected'
      ],
      version: codexInstalled ? readBinaryVersion('codex') : ''
    }
  ];
}

// ── Dispatch / retry helpers ────────────────────────────────────────────

export function shouldRetryWithFallback(error: unknown): boolean {
  const text = String((error as Error)?.message || '').toLowerCase();
  return isRetryableError(error) || text.includes('empty');
}

export function printJsonEnvelope(kind: string, payload: Record<string, unknown>) {
  console.log(JSON.stringify({
    version: 'v1',
    kind,
    ts: new Date().toISOString(),
    ...payload
  }, null, 2));
}

// ── Pipeline / resume helpers ───────────────────────────────────────────

export async function loadPipelineRunEvents(traceId: string, baseDir = process.cwd()): Promise<PipelineRunEvent[]> {
  const path = join(baseDir, '.crew', 'pipeline-runs', `${traceId}.jsonl`);
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function inferResumeTask(events: PipelineRunEvent[]): { task: string; phase: string } | null {
  if (!Array.isArray(events) || events.length === 0) return null;
  const firstPlan = events.find(e => String(e?.phase || '') === 'plan' && typeof e?.userInput === 'string');
  const last = events[events.length - 1];
  if (!firstPlan?.userInput) return null;
  return {
    task: String(firstPlan.userInput),
    phase: String(last?.phase || 'unknown')
  };
}

export function extractResumeArtifacts(events: PipelineRunEvent[]): {
  priorPlan?: unknown;
  priorResponse?: string;
  priorExecutionResults?: unknown;
} {
  const planEvent = [...events].reverse().find(e => String(e?.phase || '') === 'plan.completed' && e?.plan);
  const validateInput = [...events].reverse().find(e => String(e?.phase || '') === 'validate.input');
  return {
    priorPlan: planEvent?.plan,
    priorResponse: typeof validateInput?.response === 'string' ? validateInput.response : undefined,
    priorExecutionResults: validateInput?.executionResults
  };
}

// ── Validation commands ─────────────────────────────────────────────────

export async function runValidationCommands(commands: string[] = [], cwd = process.cwd()) {
  if (!Array.isArray(commands) || commands.length === 0) {
    return { passed: true, failedCommand: '', output: '' };
  }
  for (const cmd of commands) {
    try {
      const out = execSync(cmd, {
        cwd,
        stdio: 'pipe',
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024
      });
      if (String(out || '').trim().length > 0) {
        // keep deterministic side-effect free behavior, no streaming here.
      }
    } catch (error) {
      const execError = error as { stderr?: string };
      return {
        passed: false,
        failedCommand: cmd,
        output: String(execError.stderr || (error as Error)?.message || '')
      };
    }
  }
  return { passed: true, failedCommand: '', output: '' };
}

// ── LSP auto-fix cycle ──────────────────────────────────────────────────

export async function runLspAutoFixCycle(
  projectDir: string,
  maxAttempts: number,
  options: {
    router: AgentRouter;
    orchestrator: Orchestrator;
    sessionId: string;
    gateway?: string;
    model?: string;
    fallbackModels?: string[];
    checkpoints?: CheckpointStore;
    runId?: string;
    logger: Logger;
  }
): Promise<{ fixed: boolean; attempts: number; remainingDiagnostics: number }> {
  const { typeCheckProject } = await import('../lsp/index.js');
  const cappedAttempts = Math.max(1, maxAttempts);
  let diagnostics = await typeCheckProject(projectDir, []);
  if (diagnostics.length === 0) return { fixed: true, attempts: 0, remainingDiagnostics: 0 };

  let attempts = 0;
  while (attempts < cappedAttempts && diagnostics.length > 0) {
    attempts += 1;
    const top = diagnostics.slice(0, 30);
    const summary = top
      .map(d => `${d.file}:${d.line}:${d.column} [${d.category}] TS${d.code} ${d.message}`)
      .join('\n');
    const task = [
      'Run a targeted TypeScript auto-fix pass for the following diagnostics.',
      'Apply minimal safe changes only.',
      'Diagnostics:',
      summary
    ].join('\n');

    const dispatched = await dispatchWithFallback(
      options.router,
      'crew-fixer',
      task,
      {
        project: projectDir,
        sessionId: options.sessionId,
        gateway: options.gateway,
        model: options.model
      },
      options.fallbackModels || [],
      options.checkpoints,
      options.runId
    );
    const response = String(dispatched.result?.result || '');
    const edits = await options.orchestrator.parseAndApplyToSandbox(response);
    options.logger.info(`LSP auto-fix attempt ${attempts}: ${diagnostics.length} diagnostics, ${edits.length} sandbox edit(s).`);
    await options.checkpoints?.append(String(options.runId || ''), 'lsp.autofix.attempt', {
      attempt: attempts,
      diagnostics: diagnostics.length,
      edits: edits.length
    });
    diagnostics = await typeCheckProject(projectDir, []);
  }

  return {
    fixed: diagnostics.length === 0,
    attempts,
    remainingDiagnostics: diagnostics.length
  };
}

// ── Dispatch with fallback model chain ──────────────────────────────────

export async function dispatchWithFallback(
  router: AgentRouter,
  agent: string,
  task: string,
  options: DispatchOptions,
  fallbackModels: string[] = [],
  checkpoint?: CheckpointStore,
  runId?: string
) {
  const tried: string[] = [];
  const primary = String(options.model || '').trim();
  if (primary) tried.push(primary);
  const chain = [primary, ...fallbackModels].map(x => String(x || '').trim()).filter(Boolean);
  if (chain.length === 0) {
    const result = await router.dispatch(agent, task, options);
    return { result, usedModel: primary || 'default', attempts: tried };
  }

  let lastError: Error | null = null;
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    tried.push(model);
    try {
      if (checkpoint && runId) {
        await checkpoint.append(runId, 'dispatch.model.attempt', { model, index: i + 1 });
      }
      const result = await router.dispatch(agent, task, { ...options, model });
      if (checkpoint && runId) {
        await checkpoint.append(runId, 'dispatch.model.success', { model, index: i + 1 });
      }
      return { result, usedModel: model, attempts: tried };
    } catch (error) {
      lastError = error as Error;
      if (checkpoint && runId) {
        await checkpoint.append(runId, 'dispatch.model.failed', { model, error: String((error as Error).message || error) });
      }
      const retryable = shouldRetryWithFallback(error);
      const hasNext = i < chain.length - 1;
      if (!retryable || !hasNext) break;
    }
  }

  throw lastError || new Error('Dispatch failed across fallback chain');
}

// ── Config value parser ─────────────────────────────────────────────────

export function parseConfigValue(raw: string, asJson = false): unknown {
  const text = String(raw ?? '').trim();
  if (asJson) {
    return JSON.parse(text);
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}
