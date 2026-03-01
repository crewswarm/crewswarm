import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { AgentRouter } from '../agent/router.js';
import type { Orchestrator } from '../orchestrator/index.js';
import type { Sandbox } from '../sandbox/index.js';
import type { SessionManager } from '../session/manager.js';
import { buildCollectionIndex, searchCollection } from '../collections/index.js';
import { handleMcpRequest } from './mcp-handler.js';

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
  logger?: { info?: (...args: any[]) => void; warn?: (...args: any[]) => void; error?: (...args: any[]) => void };
}

interface TaskRecord {
  id: string;
  status: 'queued' | 'running' | 'done' | 'error';
  result?: any;
  error?: string;
  traceId?: string;
  costUsd?: number;
}

const taskStore = new Map<string, TaskRecord>();

let latestIndex: any = null;
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
    const p = join(homedir(), '.crewswarm', 'config.json');
    const cfg = JSON.parse(readFileSync(p, 'utf8'));
    return String(cfg?.rt?.authToken || '');
  } catch {
    return '';
  }
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

async function readJson(req: IncomingMessage): Promise<any> {
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
  const lastUser = userTurns.at(-1)?.text || '';
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

function buildToolCallResponse(params: {
  model: string;
  stream: boolean;
  toolName: string;
  message: string;
}): { status: number; data: any } {
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

function selectToolCallName(body: any, userMessage: string): string | null {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  if (tools.length === 0) return null;
  const names = tools
    .map((t: any) => String(t?.function?.name || '').trim())
    .filter(Boolean);
  if (names.length === 0) return null;

  const choice = body?.tool_choice;
  if (choice === 'none') return null;
  if (choice && typeof choice === 'object') {
    const forced = String(choice?.function?.name || '').trim();
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
): Promise<{ status: number; ok: boolean; data: any }> {
  const token = readRtToken();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data: any = { raw: text };
  try {
    data = JSON.parse(text);
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

async function handleStandaloneChat(options: UnifiedServerOptions, body: any) {
  const message = String(body?.message || '').trim();
  if (!message) return { status: 400, data: { error: 'message is required' } };
  const context = String(body?.context || '').trim();
  const mergedInput = context ? `${message}\n\n${context}` : message;

  const route = await options.orchestrator.route(mergedInput);
  const decision = String(route?.decision || '');
  if (decision === 'CHAT' && route.response) {
    return {
      status: 200,
      data: {
        reply: route.response,
        traceId: body?.traceId || '',
        executionPath: executionPathForDecision(decision),
        costUsd: 0,
        pendingChanges: options.sandbox.getPendingPaths(options.sandbox.getActiveBranch()).length
      }
    };
  }

  const local = await options.orchestrator.executeLocally(route.task || mergedInput, {
    model: body?.options?.model
  });
  const responseText = String(local?.result || '');
  const edits = await options.orchestrator.parseAndApplyToSandbox(responseText);
  return {
    status: 200,
    data: {
      reply: responseText,
      traceId: body?.traceId || '',
      executionPath: executionPathForDecision(decision || 'CODE'),
      costUsd: Number(local?.costUsd || 0),
      pendingChanges: edits.length
    }
  };
}

async function handleConnectedChat(options: UnifiedServerOptions, body: any) {
  const message = String(body?.message || '').trim();
  if (!message) return { status: 400, data: { error: 'message is required' } };
  const gateway = body?.gateway || options.gateway || 'http://127.0.0.1:5010';
  const forwarded = await forwardJson(gateway, '/chat', 'POST', {
    message,
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

async function handleOpenAIChatCompletions(options: UnifiedServerOptions, body: any) {
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
      model: typeof body?.metadata?.modelOverride === 'string' ? body.metadata.modelOverride : undefined
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

async function enqueueStandaloneTask(options: UnifiedServerOptions, body: any) {
  const taskText = String(body?.task || '').trim();
  if (!taskText) return { status: 400, data: { error: 'task is required' } };
  const taskId = randomUUID();
  taskStore.set(taskId, { id: taskId, status: 'queued' });
  queueMicrotask(async () => {
    const rec = taskStore.get(taskId);
    if (!rec) return;
    rec.status = 'running';
    try {
      const result = await options.orchestrator.executeLocally(taskText, {
        model: body?.options?.model
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

async function enqueueConnectedTask(options: UnifiedServerOptions, body: any) {
  const gateway = body?.gateway || options.gateway || 'http://127.0.0.1:5010';
  const payload = {
    agent: body?.agent,
    task: body?.task,
    sessionId: body?.sessionId || 'api',
    ...(body?.options || {})
  };
  const forwarded = await forwardJson(gateway, '/api/dispatch', 'POST', payload);
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
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        return json(res, 204, {});
      }

      const path = getPath(req);

      if (req.method === 'POST' && path === '/v1/chat') {
        const body = await readJson(req);
        const out = options.mode === 'connected'
          ? await handleConnectedChat(options, body)
          : await handleStandaloneChat(options, body);
        return json(res, out.status, out.data);
      }

      if (req.method === 'GET' && path === '/v1/models') {
        const agents = options.router.getDefaultAgents().map((a: any) => ({
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
        const agents = options.router.getDefaultAgents().map((a: any) => ({
          id: a.name,
          role: a.role,
          status: a.status
        }));
        return json(res, 200, { agents });
      }

      if (req.method === 'GET' && path === '/v1/status') {
        let gatewayStatus = 'local';
        let queueDepth = 0;
        if (options.mode === 'connected') {
          try {
            const status = await options.router.getStatus();
            gatewayStatus = status?.gateway || 'unknown';
            queueDepth = Number(status?.queueDepth || 0);
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
          queueDepth
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
        const body = await readJson(req);
        const branch = body?.branch || options.sandbox.getActiveBranch();
        const files = options.sandbox.getPendingPaths(branch);
        await options.sandbox.apply(branch);
        return json(res, 200, {
          success: true,
          appliedFiles: files
        });
      }

      if (req.method === 'POST' && path === '/v1/sandbox/rollback') {
        const body = await readJson(req);
        const branch = body?.branch || options.sandbox.getActiveBranch();
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
        const body = await readJson(req);
        const paths = Array.isArray(body?.paths) && body.paths.length > 0
          ? body.paths
          : [join(options.projectDir, 'docs'), options.projectDir];
        latestIndex = await buildCollectionIndex(paths, {
          includeCode: Boolean(body?.includeCode)
        });
        latestIndexId = `idx-${randomUUID()}`;
        latestIndexStats = {
          files: Number(latestIndex?.docs?.length || 0),
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
            files: Number(latestIndex?.docs?.length || 0),
            chunks: Number(latestIndex?.chunks?.length || 0)
          };
        }
        const result = searchCollection(latestIndex, q, 8);
        const hits = (result?.hits || []).map((h: any) => ({
          path: h.source,
          score: Number(h.score || 0),
          snippet: h.text
        }));
        return json(res, 200, { hits });
      }

      // MCP endpoint
      if (req.method === 'POST' && path === '/mcp') {
        const body = await readJson(req);
        const mcpResponse = await handleMcpRequest(options, body);
        return json(res, 200, mcpResponse);
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
