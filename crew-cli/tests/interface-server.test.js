import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startUnifiedServer } from '../src/interface/server.ts';
import { Sandbox } from '../src/sandbox/index.ts';
import { SessionManager } from '../src/session/manager.ts';

async function setupAuthForTest(dir) {
  const crewswarmDir = join(dir, '.crewswarm');
  await mkdir(crewswarmDir, { recursive: true });
  const testToken = 'test-token-' + Math.random().toString(36);
  await writeFile(
    join(crewswarmDir, 'config.json'),
    JSON.stringify({ rt: { authToken: testToken } }),
    'utf8'
  );
  const origHome = process.env.HOME;
  process.env.HOME = dir;
  return { testToken, origHome };
}

function makeRouter() {
  return {
    getDefaultAgents() {
      return [{ name: 'crew-coder', role: 'Full Stack Coder', status: 'ready' }];
    },
    async getStatus() {
      return { gateway: 'ok', queueDepth: 0 };
    }
  };
}

function makeOrchestrator(sandbox) {
  return {
    async route(input) {
      if (String(input).toLowerCase().includes('hello')) {
        return { decision: 'CHAT', response: 'hi there' };
      }
      return { decision: 'CODE', task: input };
    },
    async executePipeline(input) {
      if (String(input).toLowerCase().includes('hello')) {
        return { response: 'hi there', traceId: 'trace-mock', executionPath: ['pipeline'], totalCost: 0 };
      }
      return { response: `executed: ${input}`, traceId: 'trace-mock', executionPath: ['pipeline'], totalCost: 0.01 };
    },
    async executeLocally(task) {
      return { success: true, result: `executed: ${task}`, costUsd: 0.01 };
    },
    async parseAndApplyToSandbox() {
      await sandbox.addChange('src/generated.ts', 'export const x = 1;\n');
      return ['src/generated.ts'];
    },
    getTrace() {
      return { composedPrompts: [], plannerTrace: [] };
    }
  };
}

test('Unified interface server (standalone) serves chat/tasks/sandbox/status', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crew-iface-'));
  const docsDir = join(dir, 'docs');
  await mkdir(docsDir, { recursive: true });
  await writeFile(join(docsDir, 'auth.md'), '# Auth\nToken login flow.\n', 'utf8');

  const { testToken, origHome } = await setupAuthForTest(dir);

  const sandbox = new Sandbox(dir);
  await sandbox.load();
  const session = new SessionManager(dir);
  await session.ensureInitialized();
  const router = makeRouter();
  const orchestrator = makeOrchestrator(sandbox);

  let svc;
  try {
    svc = await startUnifiedServer({
      mode: 'standalone',
      host: '127.0.0.1',
      port: 0,
      router,
      orchestrator,
      sandbox,
      session,
      projectDir: dir
    });
  } catch (err) {
    process.env.HOME = origHome;
    if (String(err?.code || '').includes('EPERM') || String(err?.message || '').includes('operation not permitted')) {
      return;
    }
    throw err;
  }

  try {
    const chatRes = await fetch(`${svc.address}/v1/chat`, {
      method: 'POST',
      headers: { 
        'content-type': 'application/json',
        'authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({ message: 'hello crew' })
    });
    assert.strictEqual(chatRes.status, 200);
    const chat = await chatRes.json();
    assert.strictEqual(chat.reply, 'hi there');

    const codeRes = await fetch(`${svc.address}/v1/chat`, {
      method: 'POST',
      headers: { 
        'content-type': 'application/json',
        'authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({ message: 'build auth api' })
    });
    assert.strictEqual(codeRes.status, 200);
    const code = await codeRes.json();
    assert.ok(String(code.reply).includes('executed:'));
    assert.ok(code.pendingChanges >= 1);

    const taskRes = await fetch(`${svc.address}/v1/tasks`, {
      method: 'POST',
      headers: { 
        'content-type': 'application/json',
        'authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({ agent: 'crew-coder', task: 'do thing' })
    });
    assert.ok(taskRes.status === 200 || taskRes.status === 202);
    const task = await taskRes.json();
    assert.ok(task.taskId);

    let status = null;
    for (let i = 0; i < 10; i += 1) {
      const statusRes = await fetch(`${svc.address}/v1/tasks/${task.taskId}`, {
        headers: { 'authorization': `Bearer ${testToken}` }
      });
      status = await statusRes.json();
      if (status.status === 'done') break;
      await new Promise(r => setTimeout(r, 20));
    }
    assert.strictEqual(status.status, 'done');

    const sandboxRes = await fetch(`${svc.address}/v1/sandbox`, {
      headers: { 'authorization': `Bearer ${testToken}` }
    });
    const sand = await sandboxRes.json();
    assert.strictEqual(sand.branch, 'main');
    assert.ok(typeof sand.changedFiles === 'number');

    const statusRes = await fetch(`${svc.address}/v1/status`, {
      headers: { 'authorization': `Bearer ${testToken}` }
    });
    const state = await statusRes.json();
    assert.strictEqual(state.mode, 'standalone');
    assert.ok(state.pipeline);
    assert.strictEqual(typeof state.pipeline.runs, 'number');
  } finally {
    process.env.HOME = origHome;
    await svc?.close?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Unified interface server index endpoints rebuild and search', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crew-iface-index-'));
  const docsDir = join(dir, 'docs');
  await mkdir(docsDir, { recursive: true });
  await writeFile(join(docsDir, 'security.md'), '# Security\nJWT token verification and auth rules.\n', 'utf8');

  const { testToken, origHome } = await setupAuthForTest(dir);

  const sandbox = new Sandbox(dir);
  await sandbox.load();
  const session = new SessionManager(dir);
  await session.ensureInitialized();

  let svc;
  try {
    svc = await startUnifiedServer({
      mode: 'standalone',
      host: '127.0.0.1',
      port: 0,
      router: makeRouter(),
      orchestrator: makeOrchestrator(sandbox),
      sandbox,
      session,
      projectDir: dir
    });
  } catch (err) {
    process.env.HOME = origHome;
    if (String(err?.code || '').includes('EPERM') || String(err?.message || '').includes('operation not permitted')) {
      return;
    }
    throw err;
  }

  try {
    const rebuild = await fetch(`${svc.address}/v1/index/rebuild`, {
      method: 'POST',
      headers: { 
        'content-type': 'application/json',
        'authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({ paths: [docsDir], includeDocs: true, includeCode: false })
    });
    assert.strictEqual(rebuild.status, 200);
    const reb = await rebuild.json();
    assert.ok(reb.indexId);

    const search = await fetch(`${svc.address}/v1/index/search?q=jwt`, {
      headers: { 'authorization': `Bearer ${testToken}` }
    });
    assert.strictEqual(search.status, 200);
    const result = await search.json();
    assert.ok(Array.isArray(result.hits));
  } finally {
    process.env.HOME = origHome;
    await svc?.close?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Unified interface server exposes OpenAI-compatible models/completions and preserves message context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crew-iface-openai-'));

  const { testToken, origHome } = await setupAuthForTest(dir);

  const sandbox = new Sandbox(dir);
  await sandbox.load();
  const session = new SessionManager(dir);
  await session.ensureInitialized();

  const routedInputs = [];
  const orchestrator = {
    async route(input) {
      routedInputs.push(String(input || ''));
      return { decision: 'CHAT', response: 'context-aware reply' };
    },
    async executePipeline(input) {
      routedInputs.push(String(input || ''));
      return { response: 'context-aware reply', traceId: 'trace-mock', executionPath: ['pipeline'], totalCost: 0 };
    },
    async executeLocally(task) {
      return { success: true, result: `executed: ${task}`, costUsd: 0.01 };
    },
    async parseAndApplyToSandbox() {
      return [];
    },
    getTrace() {
      return { composedPrompts: [], plannerTrace: [] };
    }
  };

  let svc;
  try {
    svc = await startUnifiedServer({
      mode: 'standalone',
      host: '127.0.0.1',
      port: 0,
      router: makeRouter(),
      orchestrator,
      sandbox,
      session,
      projectDir: dir
    });
  } catch (err) {
    process.env.HOME = origHome;
    if (String(err?.code || '').includes('EPERM') || String(err?.message || '').includes('operation not permitted')) {
      return;
    }
    throw err;
  }

  try {
    const modelsRes = await fetch(`${svc.address}/v1/models`, {
      headers: { 'authorization': `Bearer ${testToken}` }
    });
    assert.strictEqual(modelsRes.status, 200);
    const models = await modelsRes.json();
    assert.ok(Array.isArray(models.data));
    assert.ok(models.data.some((m) => m.id === 'crewswarm'));

    const completionRes = await fetch(`${svc.address}/v1/chat/completions`, {
      method: 'POST',
      headers: { 
        'content-type': 'application/json',
        'authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({
        model: 'crewswarm',
        messages: [
          { role: 'system', content: 'You are Cursor assistant context' },
          { role: 'assistant', content: 'Prior assistant output' },
          { role: 'user', content: 'Please refactor auth middleware' }
        ]
      })
    });
    assert.strictEqual(completionRes.status, 200);
    const completion = await completionRes.json();
    assert.ok(Array.isArray(completion.choices));
    assert.strictEqual(completion.choices[0]?.message?.content, 'context-aware reply');

    assert.ok(routedInputs.length > 0);
    const mergedInput = routedInputs[0];
    assert.ok(mergedInput.includes('Please refactor auth middleware'));
    assert.ok(mergedInput.includes('SYSTEM INSTRUCTIONS:'));
    assert.ok(mergedInput.includes('RECENT CONTEXT:'));
  } finally {
    process.env.HOME = origHome;
    await svc?.close?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Unified interface server OpenAI wrapper emits tool_calls and consumes tool results context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crew-iface-tools-'));

  const { testToken, origHome } = await setupAuthForTest(dir);

  const sandbox = new Sandbox(dir);
  await sandbox.load();
  const session = new SessionManager(dir);
  await session.ensureInitialized();

  const routedInputs = [];
  const orchestrator = {
    async route(input) {
      routedInputs.push(String(input || ''));
      return { decision: 'CHAT', response: 'final answer after tool result' };
    },
    async executePipeline(input) {
      routedInputs.push(String(input || ''));
      return { response: 'final answer after tool result', traceId: 'trace-mock', executionPath: ['pipeline'], totalCost: 0 };
    },
    async executeLocally(task) {
      return { success: true, result: `executed: ${task}`, costUsd: 0.01 };
    },
    async parseAndApplyToSandbox() {
      return [];
    },
    getTrace() {
      return { composedPrompts: [], plannerTrace: [] };
    }
  };

  let svc;
  try {
    svc = await startUnifiedServer({
      mode: 'standalone',
      host: '127.0.0.1',
      port: 0,
      router: makeRouter(),
      orchestrator,
      sandbox,
      session,
      projectDir: dir
    });
  } catch (err) {
    process.env.HOME = origHome;
    if (String(err?.code || '').includes('EPERM') || String(err?.message || '').includes('operation not permitted')) {
      return;
    }
    throw err;
  }

  try {
    const first = await fetch(`${svc.address}/v1/chat/completions`, {
      method: 'POST',
      headers: { 
        'content-type': 'application/json',
        'authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({
        model: 'crewswarm',
        tool_choice: 'required',
        tools: [
          {
            type: 'function',
            function: {
              name: 'read_file',
              description: 'Read file content',
              parameters: { type: 'object', properties: { path: { type: 'string' } } }
            }
          }
        ],
        messages: [{ role: 'user', content: 'Read src/index.ts and summarize.' }]
      })
    });
    assert.strictEqual(first.status, 200);
    const firstJson = await first.json();
    const firstChoice = firstJson.choices?.[0];
    assert.strictEqual(firstChoice?.finish_reason, 'tool_calls');
    assert.ok(Array.isArray(firstChoice?.message?.tool_calls));
    assert.strictEqual(firstChoice?.message?.tool_calls?.[0]?.function?.name, 'read_file');

    const second = await fetch(`${svc.address}/v1/chat/completions`, {
      method: 'POST',
      headers: { 
        'content-type': 'application/json',
        'authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({
        model: 'crewswarm',
        messages: [
          { role: 'user', content: 'Read src/index.ts and summarize.' },
          { role: 'tool', name: 'read_file', content: 'export const x = 1;' },
          { role: 'user', content: 'Now summarize what you found.' }
        ]
      })
    });
    assert.strictEqual(second.status, 200);
    const secondJson = await second.json();
    assert.strictEqual(secondJson.choices?.[0]?.message?.content, 'final answer after tool result');
    assert.ok(routedInputs.length > 0);
    assert.ok(routedInputs.at(-1)?.includes('TOOL RESULTS:'));
  } finally {
    process.env.HOME = origHome;
    await svc?.close?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Unified interface server supports dashboard passthrough compatibility endpoints', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crew-iface-pass-'));

  const { testToken, origHome } = await setupAuthForTest(dir);

  const sandbox = new Sandbox(dir);
  await sandbox.load();
  const session = new SessionManager(dir);
  await session.ensureInitialized();

  let svc;
  try {
    svc = await startUnifiedServer({
      mode: 'standalone',
      host: '127.0.0.1',
      port: 0,
      router: makeRouter(),
      orchestrator: makeOrchestrator(sandbox),
      sandbox,
      session,
      projectDir: dir
    });
  } catch (err) {
    process.env.HOME = origHome;
    if (String(err?.code || '').includes('EPERM') || String(err?.message || '').includes('operation not permitted')) {
      return;
    }
    throw err;
  }

  try {
    const passRes = await fetch(`${svc.address}/api/engine-passthrough`, {
      method: 'POST',
      headers: { 
        'content-type': 'application/json',
        'authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({ engine: 'unknown-engine', message: 'hello' })
    });
    assert.strictEqual(passRes.status, 200);
    const sseText = await passRes.text();
    assert.match(sseText, /data: /);
    assert.match(sseText, /"type":"done"/);

    const passWithSession = await fetch(`${svc.address}/api/engine-passthrough`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({ engine: 'unknown-engine', message: 'hello again', sessionId: 's-pass' })
    });
    assert.strictEqual(passWithSession.status, 200);
    const passWithSessionText = await passWithSession.text();
    assert.match(passWithSessionText, /"type":"done"/);

    const chatPassRes = await fetch(`${svc.address}/v1/chat`, {
      method: 'POST',
      headers: { 
        'content-type': 'application/json',
        'authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({
        message: 'run direct',
        mode: 'bypass',
        options: { engine: 'unknown-engine' }
      })
    });
    assert.strictEqual(chatPassRes.status, 502);
    const chatPassJson = await chatPassRes.json();
    assert.ok(String(chatPassJson.error || '').toLowerCase().includes('unknown engine'));

    const sessionsRes = await fetch(`${svc.address}/api/passthrough-sessions`, {
      headers: { 'authorization': `Bearer ${testToken}` }
    });
    assert.strictEqual(sessionsRes.status, 200);
    const sessions = await sessionsRes.json();
    assert.ok(sessions.sessions);
    assert.ok(sessions.nativeSessions);
    assert.ok(sessions.sessions['unknown-engine::s-pass']);
    assert.strictEqual(sessions.sessions['unknown-engine::s-pass'].totalTurns >= 1, true);

    const auditRes = await fetch(`${svc.address}/api/tool-audit`, {
      headers: { 'authorization': `Bearer ${testToken}` }
    });
    assert.strictEqual(auditRes.status, 200);
    const audit = await auditRes.json();
    assert.ok(Array.isArray(audit.runs));
    assert.strictEqual(audit.runs.length >= 1, true);
    const replayRes = await fetch(`${svc.address}/api/tool-audit/replay`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({ runId: String(audit.runs[0]?.runId || ''), execute: false })
    });
    assert.strictEqual(replayRes.status, 200);
    const replay = await replayRes.json();
    assert.strictEqual(replay.ok, true);
    assert.strictEqual(replay.dryRun, true);

    const clearRes = await fetch(`${svc.address}/api/passthrough-sessions`, {
      method: 'DELETE',
      headers: { 'authorization': `Bearer ${testToken}` }
    });
    assert.strictEqual(clearRes.status, 200);
    const afterClearRes = await fetch(`${svc.address}/api/passthrough-sessions`, {
      headers: { 'authorization': `Bearer ${testToken}` }
    });
    const afterClear = await afterClearRes.json();
    assert.deepStrictEqual(afterClear.sessions, {});
  } finally {
    process.env.HOME = origHome;
    await svc?.close?.();
    await rm(dir, { recursive: true, force: true });
  }
});
