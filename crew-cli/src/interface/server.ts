import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { AgentRouter } from '../agent/router.js';
import type { Orchestrator } from '../orchestrator/index.js';
import type { Sandbox } from '../sandbox/index.js';
import type { SessionManager } from '../session/manager.js';
import { buildCollectionIndex, searchCollection, type CollectionIndex, type CollectionChunk } from '../collections/index.js';
import { handleMcpRequest } from './mcp-handler.js';
import { loadPipelineMetricsSummary } from '../metrics/pipeline.js';
import { runEngine, listNativeEngineSessions, closeNativeEngineSessions, getToolAuditRuns, getToolAuditReplayPlan } from '../engines/index.js';
import { EngineSessionLayer } from '../engines/session-layer.js';
import { GeminiToolAdapter } from '../tools/gemini/crew-adapter.js';

type InterfaceMode = 'connected' | 'standalone';

export interface UnifiedServerOptions {
  mode: InterfaceMode;
  host: string;
  port: number;
  gateway?: string;
  router: AgentRouter;
  orchestrator: Orchestrator;
  sandbox: Sandbox;
  session: SessionManager;
  projectDir: string;
  logger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
}

interface TaskRecord {
  id: string;
  status: 'queued' | 'running' | 'done' | 'error';
  result?: unknown;
  error?: string;
  traceId?: string;
  costUsd?: number;
  createdAt: number;
}

const taskStore = new Map<string, TaskRecord>();

function evictStaleTasks() {
  const maxAge = 3_600_000; // 1 hour
  const now = Date.now();
  for (const [id, task] of taskStore) {
    if ((task.status === 'done' || task.status === 'error') && now - task.createdAt > maxAge) {
      taskStore.delete(id);
    }
  }
}

// Run eviction every 10 minutes
setInterval(evictStaleTasks, 600_000).unref();

let latestIndex: CollectionIndex | null = null;
let latestIndexStats: { files: number; chunks: number } = { files: 0, chunks: 0 };
let latestIndexId = '';

interface OpenAIMessage {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

function readRtToken(): string {
  try {
    const p = join(homedir(), '.crewswarm', 'crewswarm.json');
    const cfg = JSON.parse(readFileSync(p, 'utf8'));
    return String(cfg?.rt?.authToken || '');
  } catch {
    return '';
  }
}

function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
  const token = readRtToken();
  if (!token) return true; // No token configured = no auth required
  const auth = req.headers['authorization'];
  if (auth === `Bearer ${token}`) return true;
  json(res, 401, { error: 'Unauthorized' });
  return false;
}

function json(res: ServerResponse, code: number, payload: unknown) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET,POST,OPTIONS'
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function getPath(req: IncomingMessage): string {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  return url.pathname;
}

function getQuery(req: IncomingMessage): URLSearchParams {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  return url.searchParams;
}

function extractMessageText(content: OpenAIMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => (part?.type === 'text' || !part?.type ? String(part?.text || '') : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function normalizeOpenAIMessages(messages: unknown): Array<{ role: string; text: string }> {
  if (!Array.isArray(messages)) return [];
  return (messages as OpenAIMessage[])
    .map(m => ({
      role: String(m?.role || '').trim().toLowerCase(),
      text: extractMessageText(m?.content).trim()
    }))
    .filter(m => Boolean(m.role) && Boolean(m.text));
}

function composeChatPayloadFromOpenAI(messages: unknown): {
  message: string;
  context: string;
  inputChars: number;
} {
  const normalized = normalizeOpenAIMessages(messages);
  const system = normalized.filter(m => m.role === 'system').map(m => m.text);
  const assistant = normalized.filter(m => m.role === 'assistant').map(m => m.text);
  const userTurns = normalized.filter(m => m.role === 'user');
  const lastUser = (userTurns.length > 0 ? userTurns[userTurns.length - 1]?.text : '') || '';
  const priorUser = userTurns.slice(0, -1).map(m => m.text);
  const historyTail = [...priorUser, ...assistant].slice(-8);
  const contextSections: string[] = [];
  if (system.length > 0) contextSections.push(`SYSTEM INSTRUCTIONS:\n${system.join('\n\n')}`);
  if (historyTail.length > 0) contextSections.push(`RECENT CONTEXT:\n${historyTail.join('\n\n')}`);
  const toolResults = normalized
    .filter(m => m.role === 'tool')
    .map(m => m.text)
    .filter(Boolean);
  if (toolResults.length > 0) {
    contextSections.push(`TOOL RESULTS:\n${toolResults.join('\n\n')}`);
  }
  const context = contextSections.join('\n\n');
  const inputChars = normalized.reduce((sum, m) => sum + m.text.length, 0);
  return {
    message: lastUser,
    context,
    inputChars
  };
}

interface ChatCompletionResponse {
  status: number;
  data: Record<string, unknown>;
}

function buildToolCallResponse(params: {
  model: string;
  stream: boolean;
  toolName: string;
  message: string;
}): ChatCompletionResponse {
  const completionId = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const toolCallId = `call_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const toolCall = {
    id: toolCallId,
    type: 'function',
    function: {
      name: params.toolName,
      arguments: JSON.stringify({ task: params.message })
    }
  };
  if (params.stream) {
    return {
      status: 200,
      data: {
        _sse: true,
        model: params.model,
        chunks: [
          {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model: params.model,
            choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [toolCall] }, finish_reason: null }]
          },
          {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model: params.model,
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
          }
        ]
      }
    };
  }
  return {
    status: 200,
    data: {
      id: completionId,
      object: 'chat.completion',
      created,
      model: params.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [toolCall]
          },
          finish_reason: 'tool_calls'
        }
      ],
      usage: {
        prompt_tokens: Math.ceil(params.message.length / 4),
        completion_tokens: 1,
        total_tokens: Math.ceil(params.message.length / 4) + 1
      }
    }
  };
}

function selectToolCallName(body: Record<string, unknown>, userMessage: string): string | null {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  if (tools.length === 0) return null;
  const names = tools
    .map((t: Record<string, unknown>) => String((t?.function as Record<string, unknown>)?.name || '').trim())
    .filter(Boolean);
  if (names.length === 0) return null;

  const choice = body?.tool_choice;
  if (choice === 'none') return null;
  if (choice && typeof choice === 'object') {
    const forced = String((choice as any)?.function?.name || '').trim();
    if (forced && names.includes(forced)) return forced;
  }
  if (choice === 'required') return names[0];
  if (choice && choice !== 'auto') return null;

  const lower = userMessage.toLowerCase();
  const likelyAction = /\b(build|implement|write|create|edit|refactor|fix|change|update|run|test|analyze)\b/.test(lower);
  return likelyAction ? names[0] : null;
}

async function forwardJson(
  baseUrl: string,
  path: string,
  method: 'GET' | 'POST',
  body?: unknown
): Promise<{ status: number; ok: boolean; data: Record<string, unknown> }> {
  const token = readRtToken();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data: Record<string, unknown> = { raw: text };
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, ok: res.ok, data };
}

function executionPathForDecision(decision?: string): string[] {
  if (decision === 'CHAT') return ['l1-interface', 'l2-orchestrator', 'l2-direct-response'];
  if (decision === 'CODE') return ['l1-interface', 'l2-orchestrator', 'l3-executor-single'];
  if (decision === 'DISPATCH') return ['l1-interface', 'l2-orchestrator', 'l3-executor-parallel'];
  return ['l1-interface', 'l2-orchestrator'];
}

function getChatControl(body: Record<string, unknown>): {
  mode: string;
  model: string;
  engine: string;
  direct: boolean;
  bypass: boolean;
  passthroughRequested: boolean;
} {
  const options = (body?.options && typeof body.options === 'object')
    ? body.options as Record<string, unknown>
    : {} as Record<string, unknown>;
  const mode = String(body?.mode || options?.mode || '').trim().toLowerCase();
  const model = String(options?.model || body?.model || '').trim();
  const engine = String(options?.engine || body?.engine || '').trim().toLowerCase();
  const direct = Boolean(
    body?.direct === true ||
    options?.direct === true ||
    mode === 'direct'
  );
  const bypass = Boolean(
    body?.bypass === true ||
    options?.bypass === true ||
    mode === 'bypass'
  );
  return {
    mode,
    model,
    engine,
    direct,
    bypass,
    passthroughRequested: direct || bypass
  };
}

function normalizeStandaloneEngine(rawEngine: string): string {
  const e = String(rawEngine || '').trim().toLowerCase();
  if (!e) return '';
  if (e === 'claude' || e === 'claude-code' || e === 'claude-cli') return 'claude-cli';
  if (e === 'codex' || e === 'codex-cli') return 'codex-cli';
  if (e === 'cursor' || e === 'cursor-cli') return 'cursor-cli';
  if (e === 'opencode' || e === 'opencode-cli') return 'opencode-cli';
  if (e === 'gemini' || e === 'gemini-cli') return 'gemini-cli';
  if (e === 'gemini-api') return 'gemini-api';
  if (e === 'claude-api') return 'claude-api';
  return e;
}

async function handleStandaloneChat(options: UnifiedServerOptions, body: Record<string, unknown>) {
  const message = String(body?.message || '').trim();
  if (!message) return { status: 400, data: { error: 'message is required' } };
  const context = String(body?.context || '').trim();
  const mergedInput = context ? `${message}\n\n${context}` : message;
  const control = getChatControl(body);

  if (control.passthroughRequested || control.engine) {
    const engine = normalizeStandaloneEngine(control.engine || '');
    if (!engine) {
      return { status: 400, data: { error: 'engine is required for direct/bypass mode in standalone' } };
    }
    const run = await runEngine(engine, mergedInput, {
      model: control.model || undefined,
      cwd: String(body?.projectDir || options.projectDir || process.cwd()),
      projectDir: String(body?.projectDir || options.projectDir || process.cwd()),
      sessionId: String(body?.sessionId || ''),
      timeoutMs: Number((body?.options as any)?.timeoutMs || body?.timeoutMs || 600000)
    });
    if (!run.success) {
      return {
        status: 502,
        data: {
          error: run.stderr || `engine ${engine} failed`,
          engine,
          exitCode: run.exitCode
        }
      };
    }
    return {
      status: 200,
      data: {
        reply: String(run.stdout || ''),
        traceId: body?.traceId || '',
        executionPath: ['l1-interface', 'engine-passthrough', engine],
        costUsd: 0,
        pendingChanges: options.sandbox.getPendingPaths(options.sandbox.getActiveBranch()).length,
        engine,
        exitCode: run.exitCode
      }
    };
  }

  // crew-cli is a code execution engine — always use the full pipeline
  // The pipeline handles CHAT vs CODE routing internally
  const sessionId = String(body?.sessionId || 'api');
  const result = await options.orchestrator.executePipeline(
    mergedInput, '', sessionId
  );
  const responseText = String(result?.response || result?.result || '');
  const edits = await options.orchestrator.parseAndApplyToSandbox(responseText);
  return {
    status: 200,
    data: {
      reply: responseText,
      traceId: result?.traceId || body?.traceId || '',
      executionPath: result?.executionPath || ['pipeline'],
      costUsd: Number(result?.totalCost || 0),
      pendingChanges: edits.length
    }
  };
}

async function handleConnectedChat(options: UnifiedServerOptions, body: Record<string, unknown>) {
  const message = String(body?.message || '').trim();
  if (!message) return { status: 400, data: { error: 'message is required' } };
  const context = String(body?.context || '').trim();
  const mergedInput = context ? `${message}\n\n${context}` : message;
  const control = getChatControl(body);
  const gateway = String(body?.gateway || options.gateway || 'http://127.0.0.1:5010');

  if (control.passthroughRequested || control.engine) {
    try {
      const agent = String(body?.agent || 'crew-main');
      const dispatched = await options.router.dispatch(agent, mergedInput, {
        gateway,
        sessionId: body?.sessionId || 'api',
        model: control.model || undefined,
        engine: control.engine || undefined,
        direct: control.direct,
        bypass: control.bypass,
        skipPreamble: true,
        injectGitContext: false,
        project: String(body?.projectDir || options.projectDir || process.cwd())
      });
      const reply = String(dispatched?.result || '');
      return {
        status: 200,
        data: {
          reply,
          traceId: String(body?.traceId || ''),
          executionPath: ['l1-interface', 'gateway-dispatch', control.engine || 'direct'],
          costUsd: 0,
          pendingChanges: options.sandbox.getPendingPaths(options.sandbox.getActiveBranch()).length
        }
      };
    } catch (err) {
      return {
        status: 502,
        data: {
          error: String((err as Error)?.message || err)
        }
      };
    }
  }

  const forwarded = await forwardJson(gateway, '/chat', 'POST', {
    message: mergedInput,
    sessionId: body?.sessionId || 'api'
  });
  const reply =
    forwarded.data?.reply ??
    forwarded.data?.result ??
    forwarded.data?.message ??
    forwarded.data?.raw ??
    '';
  return {
    status: forwarded.ok ? 200 : forwarded.status,
    data: {
      reply: String(reply || ''),
      traceId: String(body?.traceId || ''),
      executionPath: ['l1-interface', 'l2-orchestrator', 'l3-workers'],
      costUsd: 0,
      pendingChanges: options.sandbox.getPendingPaths(options.sandbox.getActiveBranch()).length
    }
  };
}

async function handleOpenAIChatCompletions(options: UnifiedServerOptions, body: Record<string, unknown>) {
  const model = String(body?.model || 'crewswarm');
  const stream = Boolean(body?.stream);
  const composed = composeChatPayloadFromOpenAI(body?.messages);
  if (!composed.message) {
    return {
      status: 400,
      data: { error: { message: 'No user message found', type: 'invalid_request_error' } }
    };
  }

  const selectedTool = selectToolCallName(body, composed.message);
  if (selectedTool) {
    return buildToolCallResponse({
      model,
      stream,
      toolName: selectedTool,
      message: composed.message
    });
  }

  const chatBody = {
    message: model === 'crewswarm'
      ? composed.message
      : `${composed.message}\n\nPREFERRED_AGENT: ${model}`,
    context: composed.context,
    options: {
      model: typeof (body?.metadata as any)?.modelOverride === 'string' ? (body!.metadata as any).modelOverride : undefined
    }
  };

  const out = options.mode === 'connected'
    ? await handleConnectedChat(options, chatBody)
    : await handleStandaloneChat(options, chatBody);
  const reply = String(out?.data?.reply || '');

  const completionId = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const promptTokens = Math.ceil(composed.inputChars / 4);
  const completionTokens = Math.ceil(reply.length / 4);

  if (stream) {
    return {
      status: 200,
      data: {
        _sse: true,
        model,
        chunks: [
          {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }]
          },
          {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
          }
        ]
      }
    };
  }

  return {
    status: out.status,
    data: {
      id: completionId,
      object: 'chat.completion',
      created,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens
      }
    }
  };
}

async function enqueueStandaloneTask(options: UnifiedServerOptions, body: Record<string, unknown>) {
  const taskText = String(body?.task || '').trim();
  if (!taskText) return { status: 400, data: { error: 'task is required' } };
  const taskId = randomUUID();
  taskStore.set(taskId, { id: taskId, status: 'queued', createdAt: Date.now() });
  queueMicrotask(async () => {
    const rec = taskStore.get(taskId);
    if (!rec) return;
    rec.status = 'running';
    try {
      const result = await options.orchestrator.executeLocally(taskText, {
        model: (body?.options as any)?.model
      });
      rec.status = 'done';
      rec.result = result?.result || '';
      rec.costUsd = Number(result?.costUsd || 0);
      taskStore.set(taskId, rec);
    } catch (err) {
      rec.status = 'error';
      rec.error = String((err as Error)?.message || err);
      taskStore.set(taskId, rec);
    }
  });
  return { status: 202, data: { accepted: true, taskId } };
}

async function enqueueConnectedTask(options: UnifiedServerOptions, body: Record<string, unknown>) {
  const gateway = String(body?.gateway || options.gateway || 'http://127.0.0.1:5010');
  const payload = {
    agent: body?.agent,
    task: body?.task,
    sessionId: body?.sessionId || 'api',
    ...(body?.options || {})
  };
  const forwarded = await forwardJson(String(gateway), '/api/dispatch', 'POST', payload);
  const taskId = forwarded.data?.taskId || '';
  return {
    status: forwarded.ok ? 202 : forwarded.status,
    data: {
      accepted: forwarded.ok,
      taskId
    }
  };
}

export async function startUnifiedServer(options: UnifiedServerOptions): Promise<{
  close: () => Promise<void>;
  address: string;
}> {
  const passthroughSessions = new EngineSessionLayer(options.projectDir || process.cwd());
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        return json(res, 204, {});
      }

      const path = getPath(req);

      if (req.method === 'POST' && path === '/v1/chat') {
        if (!checkAuth(req, res)) return;
        const body = await readJson(req);
        const out = options.mode === 'connected'
          ? await handleConnectedChat(options, body)
          : await handleStandaloneChat(options, body);
        return json(res, out.status, out.data);
      }

      // Dashboard compatibility: direct engine passthrough stream API.
      if (req.method === 'POST' && path === '/api/engine-passthrough') {
        if (!checkAuth(req, res)) return;
        const body = await readJson(req);
        const message = String(body?.message || '').trim();
        const requestedEngine = String(body?.engine || '').trim().toLowerCase();
        if (!message) return json(res, 400, { error: 'message is required' });
        if (!requestedEngine) return json(res, 400, { error: 'engine is required' });

        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'content-type, authorization',
          'access-control-allow-methods': 'GET,POST,OPTIONS'
        });

        if (options.mode === 'connected') {
          const gateway = String(body?.gateway || options.gateway || 'http://127.0.0.1:5010');
          const token = readRtToken();
          const headers: Record<string, string> = { 'content-type': 'application/json' };
          if (token) headers.authorization = `Bearer ${token}`;
          const upstream = await fetch(`${gateway}/api/engine-passthrough`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              engine: requestedEngine,
              message,
              model: body?.model,
              sessionId: body?.sessionId,
              projectDir: body?.projectDir
            })
          });
          if (!upstream.ok || !upstream.body) {
            const text = await upstream.text().catch(() => '');
            res.write(`data: ${JSON.stringify({ type: 'chunk', text: `Error ${upstream.status}: ${text || 'upstream failure'}` })}\n\n`);
            res.write(`data: ${JSON.stringify({ type: 'done', exitCode: 1 })}\n\n`);
            res.end();
            return;
          }
          const reader = upstream.body.getReader();
          const decoder = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(decoder.decode(value, { stream: true }));
          }
          res.end();
          return;
        }

        const engine = normalizeStandaloneEngine(requestedEngine);
        const sessionId = String(body?.sessionId || '');
        const run = await runEngine(engine, message, {
          model: String(body?.model || '').trim() || undefined,
          cwd: String(body?.projectDir || options.projectDir || process.cwd()),
          projectDir: String(body?.projectDir || options.projectDir || process.cwd()),
          sessionId,
          timeoutMs: Number(body?.timeoutMs || 300000),
          onEvent: (event) => {
            if (!event) return;
            if (event.type === 'chunk' && typeof event.text === 'string') {
              res.write(`data: ${JSON.stringify({ type: 'chunk', text: event.text })}\n\n`);
              return;
            }
            res.write(`data: ${JSON.stringify({
              type: 'event',
              event: event.type,
              runId: event.runId || '',
              mode: event.mode || '',
              exitCode: event.exitCode,
              success: event.success,
              toolCount: event.toolCount
            })}\n\n`);
          }
        });
        const chunkText = run.success ? (run.stdout || '') : (run.stderr || `engine ${engine} failed`);
        if (chunkText.trim().length > 0) {
          res.write(`data: ${JSON.stringify({ type: 'chunk', text: chunkText })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ type: 'done', exitCode: run.exitCode })}\n\n`);
        res.end();
        return;
      }

      // Dashboard compatibility: passthrough session presence checks.
      if (req.method === 'GET' && path === '/api/passthrough-sessions') {
        const sessions = await passthroughSessions.listSummaries();
        const nativeSessions = await listNativeEngineSessions(String(options.projectDir || process.cwd()));
        return json(res, 200, { sessions, nativeSessions });
      }

      if (req.method === 'GET' && path === '/api/tool-audit') {
        if (!checkAuth(req, res)) return;
        const query = getQuery(req);
        const limit = Number(query.get('limit') || 30);
        const rows = await getToolAuditRuns(String(options.projectDir || process.cwd()), limit);
        return json(res, 200, { runs: rows });
      }

      if (req.method === 'POST' && path === '/api/tool-audit/replay') {
        if (!checkAuth(req, res)) return;
        const body = await readJson(req);
        const runId = String(body?.runId || '').trim();
        if (!runId) return json(res, 400, { error: 'runId is required' });
        const dryRun = body?.execute !== true;
        const plan = await getToolAuditReplayPlan(String(options.projectDir || process.cwd()), runId);
        if (!plan) return json(res, 404, { error: `run ${runId} not found` });
        if (dryRun) {
          return json(res, 200, { ok: true, dryRun: true, plan });
        }

        const adapter = new GeminiToolAdapter(options.sandbox as any);
        const applied: Array<{ name: string; success: boolean; error?: string }> = [];
        await options.sandbox.load();
        for (const call of plan.supportedMutations || []) {
          const toolName = String(call?.name || '').toLowerCase();
          const args = (call?.args && typeof call.args === 'object') ? call.args : {};
          const result = await adapter.executeTool(toolName, args);
          applied.push({
            name: toolName,
            success: Boolean(result?.success),
            error: result?.error
          });
        }
        await options.sandbox.save();
        return json(res, 200, {
          ok: true,
          dryRun: false,
          runId,
          replayed: applied.length,
          applied
        });
      }

      // ── crew-cli RAG API ───────────────────────────────────────────────────────
      // GET /api/rag/search?q=auth&projectDir=/path&mode=import-graph
      if (req.method === 'GET' && path === '/api/rag/search') {
        if (!checkAuth(req, res)) return;
        
        try {
          const { autoLoadRelevantFiles, shouldUseRag } = await import('../context/codebase-rag.js');
          const query = getQuery(req);
          const q = query.get('q') || '';
          const projectDir = query.get('projectDir') || options.projectDir;
          const mode = (query.get('mode') as any) || 'import-graph';
          const tokenBudget = Number(query.get('tokenBudget') || 8000);
          const maxFiles = Number(query.get('maxFiles') || 10);
          
          if (!q) {
            return json(res, 400, { error: 'Missing query parameter: q' });
          }
          
          const startTime = Date.now();
          const result = await autoLoadRelevantFiles(q, projectDir, {
            mode,
            tokenBudget,
            maxFiles,
            sessionHistory: []
          });
          
          return json(res, 200, {
            query: q,
            projectDir,
            mode: result.mode,
            filesLoaded: result.filesLoaded,
            tokenEstimate: result.tokenEstimate,
            context: result.context,
            elapsedMs: Date.now() - startTime,
            shouldUseRag: shouldUseRag(q)
          });
        } catch (error: unknown) {
          options.logger?.error?.('[rag] search error:', error);
          return json(res, 500, { error: (error as Error).message });
        }
      }
      
      // POST /api/rag/index - Force re-index
      if (req.method === 'POST' && path === '/api/rag/index') {
        if (!checkAuth(req, res)) return;
        
        try {
          const { autoLoadRelevantFiles } = await import('../context/codebase-rag.js');
          const body = await readJson(req);
          const projectDir = String(body?.projectDir || options.projectDir);
          
          const result = await autoLoadRelevantFiles('index build', projectDir, {
            mode: 'semantic',
            tokenBudget: 1000,
            maxFiles: 5
          });
          
          return json(res, 200, {
            ok: true,
            projectDir,
            message: 'Index built (semantic embeddings)',
            filesIndexed: result.filesLoaded.length
          });
        } catch (error: unknown) {
          options.logger?.error?.('[rag] index error:', error);
          return json(res, 500, { error: (error as Error).message });
        }
      }
      
      // GET /api/rag/stats?projectDir=/path
      if (req.method === 'GET' && path === '/api/rag/stats') {
        if (!checkAuth(req, res)) return;
        
        try {
          const { existsSync } = await import('node:fs');
          const query = getQuery(req);
          const projectDir = query.get('projectDir') || options.projectDir;
          const cacheDir = process.env.CREW_RAG_CACHE_DIR || `${projectDir}/.crew/rag-cache`;
          
          return json(res, 200, {
            projectDir,
            cacheDir,
            exists: existsSync(cacheDir),
            modes: {
              keyword: 'always available (no cache)',
              importGraph: 'always available (no cache)',
              semantic: existsSync(`${cacheDir}/embeddings.json`) ? 'cached' : 'not cached'
            }
          });
        } catch (error: unknown) {
          options.logger?.error?.('[rag] stats error:', error);
          return json(res, 500, { error: (error as Error).message });
        }
      }

      // Health check
      if (req.method === 'GET' && path === '/health') {
        return json(res, 200, { ok: true, mode: options.mode });
      }
      if (req.method === 'DELETE' && path === '/api/passthrough-sessions') {
        await closeNativeEngineSessions(String(options.projectDir || process.cwd()));
        await passthroughSessions.clear();
        return json(res, 200, { ok: true });
      }

      if (req.method === 'GET' && path === '/v1/models') {
        const agents = options.router.getDefaultAgents().map((a: Record<string, unknown>) => ({
          id: a.name,
          object: 'model',
          created: 1700000000,
          owned_by: 'crewswarm'
        }));
        return json(res, 200, {
          object: 'list',
          data: [
            { id: 'crewswarm', object: 'model', created: 1700000000, owned_by: 'crewswarm' },
            ...agents
          ]
        });
      }

      if (req.method === 'POST' && path === '/v1/chat/completions') {
        if (!checkAuth(req, res)) return;
        const body = await readJson(req);
        const out = await handleOpenAIChatCompletions(options, body);
        if ((out.data as any)?._sse) {
          const streamPayload = out.data as any;
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
            'access-control-allow-origin': '*',
            'access-control-allow-headers': 'content-type, authorization',
            'access-control-allow-methods': 'GET,POST,OPTIONS'
          });
          for (const chunk of streamPayload.chunks || []) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        return json(res, out.status, out.data);
      }

      if (req.method === 'POST' && path === '/v1/tasks') {
        if (!checkAuth(req, res)) return;
        const body = await readJson(req);
        const out = options.mode === 'connected'
          ? await enqueueConnectedTask(options, body)
          : await enqueueStandaloneTask(options, body);
        return json(res, out.status, out.data);
      }

      if (req.method === 'GET' && path.startsWith('/v1/tasks/')) {
        const taskId = path.slice('/v1/tasks/'.length);
        if (options.mode === 'connected') {
          const gateway = options.gateway || 'http://127.0.0.1:5010';
          const forwarded = await forwardJson(gateway, `/api/status/${encodeURIComponent(taskId)}`, 'GET');
          const status = String(forwarded.data?.status || '').toLowerCase();
          const mapped =
            status === 'done' ? 'done' :
            status === 'error' ? 'error' :
            status === 'running' ? 'running' :
            'queued';
          return json(res, forwarded.ok ? 200 : forwarded.status, {
            status: mapped,
            result: forwarded.data?.result ?? forwarded.data,
            traceId: '',
            costUsd: 0,
            error: forwarded.data?.error
          });
        }
        const rec = taskStore.get(taskId);
        if (!rec) return json(res, 404, { error: 'task not found' });
        return json(res, 200, {
          status: rec.status,
          result: rec.result,
          traceId: rec.traceId || '',
          costUsd: rec.costUsd || 0,
          error: rec.error
        });
      }

      if (req.method === 'GET' && path === '/v1/agents') {
        if (options.mode === 'connected') {
          const gateway = options.gateway || 'http://127.0.0.1:5010';
          const forwarded = await forwardJson(gateway, '/api/agents', 'GET');
          const agents = Array.isArray(forwarded.data) ? forwarded.data : (forwarded.data?.agents || []);
          return json(res, forwarded.ok ? 200 : forwarded.status, { agents });
        }
        const agents = options.router.getDefaultAgents().map((a: Record<string, unknown>) => ({
          id: a.name,
          role: a.role,
          status: a.status
        }));
        return json(res, 200, { agents });
      }

      if (req.method === 'GET' && path === '/v1/status') {
        let gatewayStatus = 'local';
        let queueDepth = 0;
        const pipelineMetrics = await loadPipelineMetricsSummary(options.projectDir);
        if (options.mode === 'connected') {
          try {
            const status = await options.router.getStatus();
            gatewayStatus = (status as any)?.gateway || 'unknown';
            queueDepth = Number((status as any)?.queueDepth || 0);
          } catch {
            gatewayStatus = 'error';
          }
        } else {
          queueDepth = Array.from(taskStore.values()).filter(t => t.status === 'queued' || t.status === 'running').length;
        }

        return json(res, 200, {
          mode: options.mode,
          gateway: gatewayStatus,
          l2: {
            unifiedRouter: process.env.CREW_USE_UNIFIED_ROUTER === 'true',
            dualL2: process.env.CREW_DUAL_L2_ENABLED === 'true'
          },
          queueDepth,
          pipeline: {
            runs: pipelineMetrics.runs,
            qaApproved: pipelineMetrics.qaApproved,
            qaRejected: pipelineMetrics.qaRejected,
            qaRoundsAvg: pipelineMetrics.runs > 0
              ? Number((pipelineMetrics.qaRoundsTotal / pipelineMetrics.runs).toFixed(2))
              : 0,
            contextChunksUsed: pipelineMetrics.contextChunksUsed,
            contextCharsSavedEst: pipelineMetrics.contextCharsSaved
          }
        });
      }

      if (req.method === 'GET' && path === '/v1/sandbox') {
        const branch = options.sandbox.getActiveBranch();
        const changedFiles = options.sandbox.getPendingPaths(branch).length;
        return json(res, 200, {
          branch,
          changedFiles,
          diffPreview: options.sandbox.preview(branch)
        });
      }

      if (req.method === 'POST' && path === '/v1/sandbox/apply') {
        if (!checkAuth(req, res)) return;
        const body = await readJson(req);
        const branch = String(body?.branch || options.sandbox.getActiveBranch());
        const files = options.sandbox.getPendingPaths(branch);
        await options.sandbox.apply(branch);
        return json(res, 200, {
          success: true,
          appliedFiles: files
        });
      }

      if (req.method === 'POST' && path === '/v1/sandbox/rollback') {
        if (!checkAuth(req, res)) return;
        const body = await readJson(req);
        const branch = String(body?.branch || options.sandbox.getActiveBranch());
        await options.sandbox.rollback(branch);
        return json(res, 200, { success: true });
      }

      if (req.method === 'GET' && path.startsWith('/v1/traces/')) {
        const traceId = path.slice('/v1/traces/'.length);
        const trace = options.orchestrator.getTrace(traceId);
        return json(res, 200, {
          composedPrompts: trace?.composedPrompts || [],
          plannerTrace: trace?.plannerTrace || [],
          events: []
        });
      }

      if (req.method === 'POST' && path === '/v1/index/rebuild') {
        if (!checkAuth(req, res)) return;
        const body = await readJson(req);
        const paths = Array.isArray(body?.paths) && body.paths.length > 0
          ? body.paths
          : [join(options.projectDir, 'docs'), options.projectDir];
        latestIndex = await buildCollectionIndex(paths, {
          includeCode: Boolean(body?.includeCode)
        });
        latestIndexId = `idx-${randomUUID()}`;
        latestIndexStats = {
          files: Number(latestIndex?.fileCount || 0),
          chunks: Number(latestIndex?.chunks?.length || 0)
        };
        return json(res, 200, {
          indexId: latestIndexId,
          stats: latestIndexStats
        });
      }

      if (req.method === 'GET' && path === '/v1/index/search') {
        const q = String(getQuery(req).get('q') || '').trim();
        if (!q) return json(res, 400, { error: 'q is required' });
        if (!latestIndex) {
          const fallback = await buildCollectionIndex([join(options.projectDir, 'docs'), options.projectDir], {
            includeCode: false
          });
          latestIndex = fallback;
          latestIndexId = `idx-${randomUUID()}`;
          latestIndexStats = {
            files: Number(latestIndex?.fileCount || 0),
            chunks: Number(latestIndex?.chunks?.length || 0)
          };
        }
        const result = searchCollection(latestIndex, q, 8);
        const hits = (result?.hits || []).map((h: CollectionChunk) => ({
          path: h.source,
          score: Number(h.score || 0),
          snippet: h.text
        }));
        return json(res, 200, { hits });
      }

      // MCP endpoint
      if (req.method === 'POST' && path === '/mcp') {
        if (!checkAuth(req, res)) return;
        const body = await readJson(req);
        const mcpResponse = await handleMcpRequest(options, body as any);
        if (mcpResponse && !(mcpResponse as any)._skip) {
          return json(res, 200, mcpResponse);
        } else {
          // Notifications should not advertise a JSON body. Some MCP clients
          // attempt to decode an empty 200/application-json response and log
          // a transport error during initialized.
          res.writeHead(204);
          res.end();
          return;
        }
      }

      // MCP health check  
      if (req.method === 'GET' && path === '/mcp/health') {
        return json(res, 200, {
          ok: true,
          server: 'crew-cli-mcp',
          mode: options.mode,
          version: '1.0.0',
          tools: 8
        });
      }

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      options.logger?.error?.('[serve] request failed', err);
      return json(res, 500, { error: String((err as Error)?.message || err) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => resolve());
  });
  const bound = server.address();
  const actualPort = typeof bound === 'object' && bound ? bound.port : options.port;
  const address = `http://${options.host}:${actualPort}`;
  options.logger?.info?.(`[serve] unified API listening on ${address} (${options.mode})`);
  return {
    address,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  };
}
