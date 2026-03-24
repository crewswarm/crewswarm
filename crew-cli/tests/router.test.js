/**
 * Basic tests for AgentRouter
 * Run with: node --test tests/router.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { AgentRouter } from '../src/agent/router.js';
import { ConfigManager } from '../src/config/manager.js';
import { ToolManager } from '../src/tools/manager.js';

test('AgentRouter - should instantiate correctly', () => {
  const config = new ConfigManager();
  const toolManager = new ToolManager(config);
  const router = new AgentRouter(config, toolManager);

  assert.ok(router, 'Router should be instantiated');
  assert.ok(router.dispatch, 'Router should have dispatch method');
  assert.ok(router.listAgents, 'Router should have listAgents method');
  assert.ok(router.getStatus, 'Router should have getStatus method');
});

test('AgentRouter - dispatch should require agent and task', async () => {
  const config = new ConfigManager();
  const toolManager = new ToolManager(config);
  const router = new AgentRouter(config, toolManager);

  await assert.rejects(
    async () => await router.dispatch(),
    { message: 'Agent name and task are required' },
    'Should reject when agent is missing'
  );

  await assert.rejects(
    async () => await router.dispatch('crew-coder'),
    { message: 'Agent name and task are required' },
    'Should reject when task is missing'
  );
});

test('AgentRouter - getDefaultAgents should return agent list', () => {
  const config = new ConfigManager();
  const toolManager = new ToolManager(config);
  const router = new AgentRouter(config, toolManager);

  const agents = router.getDefaultAgents();
  assert.ok(Array.isArray(agents), 'Should return an array');
  assert.ok(agents.length > 0, 'Should return at least one agent');
  assert.ok(agents[0].name, 'Agent should have name');
  assert.ok(agents[0].role, 'Agent should have role');
  assert.ok(agents[0].status, 'Agent should have status');
});

test('AgentRouter - getAgentRole should return correct roles', () => {
  const config = new ConfigManager();
  const toolManager = new ToolManager(config);
  const router = new AgentRouter(config, toolManager);

  assert.strictEqual(router.getAgentRole('crew-coder'), 'Full Stack Coder');
  assert.strictEqual(router.getAgentRole('crew-qa'), 'Quality Assurance');
  assert.strictEqual(router.getAgentRole('crew-fixer'), 'Bug Fixer');
  assert.strictEqual(router.getAgentRole('unknown-agent'), 'Agent');
});

test('AgentRouter - getStatus should handle unreachable gateway', async () => {
  const config = new ConfigManager();
  // Override with a non-existent gateway
  config.set('crewLeadUrl', 'http://localhost:99999');

  const toolManager = new ToolManager(config);
  const router = new AgentRouter(config, toolManager);

  const status = await router.getStatus();
  assert.ok(status, 'Should return status object');
  assert.strictEqual(status.agentsOnline, 0, 'Should show 0 agents when unreachable');
  assert.ok(status.gateway.includes('error'), 'Gateway status should indicate error');
});

test('AgentRouter - listAgents should handle unreachable gateway', async () => {
  const config = new ConfigManager();
  // Override with a non-existent gateway
  config.set('crewLeadUrl', 'http://localhost:99999');

  const toolManager = new ToolManager(config);
  const router = new AgentRouter(config, toolManager);

  const agents = await router.listAgents();
  assert.ok(Array.isArray(agents), 'Should return default agents array');
  assert.ok(agents.length > 0, 'Should return default agents');
  assert.strictEqual(agents[0].status, 'unknown', 'Status should be unknown when gateway unreachable');
});

test('AgentRouter - dispatch should auto-inject git context', async () => {
  const config = new ConfigManager();
  const toolManager = new ToolManager(config);
  const router = new AgentRouter(config, toolManager);

  const originalFetch = global.fetch;
  let capturedBody = null;

  global.fetch = async (_url, options = {}) => {
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ taskId: null })
    };
  };

  try {
    const result = await router.dispatch('crew-coder', 'Implement feature X', {
      gateway: 'http://localhost:5010'
    });

    assert.ok(result.success, 'Dispatch should succeed in fallback mode');
    assert.ok(capturedBody, 'Dispatch body should be captured');
    assert.ok(
      capturedBody.task.includes('## Git Context'),
      'Task payload should include auto-injected git context'
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('AgentRouter - dispatch should forward model/engine/direct/bypass/session metadata', async () => {
  const config = new ConfigManager();
  const toolManager = new ToolManager(config);
  const router = new AgentRouter(config, toolManager);

  const originalFetch = global.fetch;
  let capturedBody = null;

  global.fetch = async (_url, options = {}) => {
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ taskId: null })
    };
  };

  try {
    const result = await router.dispatch('crew-coder', 'Implement feature Y', {
      gateway: 'http://localhost:5010',
      sessionId: 'session-abc',
      model: 'anthropic/claude-3-5-sonnet',
      engine: 'cursor',
      direct: true,
      bypass: true
    });

    assert.ok(result.success, 'Dispatch should succeed in fallback mode');
    assert.ok(capturedBody, 'Dispatch body should be captured');
    assert.strictEqual(capturedBody.model, 'anthropic/claude-3-5-sonnet');
    assert.strictEqual(capturedBody.engine, 'cursor');
    assert.strictEqual(capturedBody.runtime, 'cursor-cli');
    assert.strictEqual(capturedBody.useCursorCli, true);
    assert.strictEqual(capturedBody.direct, true);
    assert.strictEqual(capturedBody.bypass, true);
    assert.strictEqual(capturedBody.sessionId, 'session-abc');
    assert.ok(capturedBody.session, 'Session metadata should be included');
    assert.strictEqual(capturedBody.session.id, 'session-abc');
  } finally {
    global.fetch = originalFetch;
  }
});

test('AgentRouter - dispatch should inject CLI_SYSTEM_PROMPT', async () => {
  const config = new ConfigManager();
  const toolManager = new ToolManager(config);
  const router = new AgentRouter(config, toolManager);

  const originalFetch = global.fetch;
  let capturedBody = null;

  global.fetch = async (_url, options = {}) => {
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ taskId: null })
    };
  };

  try {
    await router.dispatch('crew-coder', 'Verify prompt injection', {
      gateway: 'http://localhost:5010'
    });

    assert.ok(capturedBody, 'Dispatch body should be captured');
    assert.ok(
      capturedBody.task.includes('You are Gunns') || capturedBody.task.includes('CrewSwarm'),
      'Task payload should include CLI_SYSTEM_PROMPT'
    );
    assert.ok(
      capturedBody.task.includes('--- USER REQUEST ---'),
      'Task payload should include user request marker'
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('AgentRouter - dispatch should fail immediately on gateway task error', async () => {
  const config = new ConfigManager();
  const toolManager = new ToolManager(config);
  const router = new AgentRouter(config, toolManager);
  const originalFetch = global.fetch;

  global.fetch = async (url, _options = {}) => {
    if (String(url).includes('/api/dispatch')) {
      return {
        ok: true,
        json: async () => ({ taskId: 'task-123' })
      };
    }
    if (String(url).includes('/api/status/task-123')) {
      return {
        ok: true,
        json: async () => ({ status: 'error', error: 'Cursor CLI exit code 1: rate limit 429' })
      };
    }
    return {
      ok: true,
      json: async () => ({ status: 'pending' })
    };
  };

  try {
    await assert.rejects(
      async () => router.dispatch('crew-coder', 'Do work', {
        gateway: 'http://localhost:5010',
        engine: 'cursor',
        direct: true,
        timeout: '10000'
      }),
      /exit code 1|rate limit|429|Cursor CLI/i
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('AgentRouter - dispatch should fail when done result contains non-zero exit code', async () => {
  const config = new ConfigManager();
  const toolManager = new ToolManager(config);
  const router = new AgentRouter(config, toolManager);
  const originalFetch = global.fetch;

  global.fetch = async (url, _options = {}) => {
    if (String(url).includes('/api/dispatch')) {
      return {
        ok: true,
        json: async () => ({ taskId: 'task-456' })
      };
    }
    if (String(url).includes('/api/status/task-456')) {
      return {
        ok: true,
        json: async () => ({
          status: 'done',
          result: {
            engine: 'cursor',
            exitCode: 1,
            stderr: 'Cursor CLI exit code 1: model required'
          }
        })
      };
    }
    return {
      ok: true,
      json: async () => ({ status: 'pending' })
    };
  };

  try {
    await assert.rejects(
      async () => router.dispatch('crew-coder', 'Do passthrough work', {
        gateway: 'http://localhost:5010',
        engine: 'cursor',
        direct: true,
        timeout: '10000'
      }),
      /exit code 1|model required|Cursor CLI/i
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('AgentRouter - dispatch should fail when done result reports success:false', async () => {
  const config = new ConfigManager();
  const toolManager = new ToolManager(config);
  const router = new AgentRouter(config, toolManager);
  const originalFetch = global.fetch;

  global.fetch = async (url, _options = {}) => {
    if (String(url).includes('/api/dispatch')) {
      return {
        ok: true,
        json: async () => ({ taskId: 'task-789' })
      };
    }
    if (String(url).includes('/api/status/task-789')) {
      return {
        ok: true,
        json: async () => ({
          status: 'done',
          result: {
            success: false,
            message: 'gateway reported worker failure'
          }
        })
      };
    }
    return {
      ok: true,
      json: async () => ({ status: 'pending' })
    };
  };

  try {
    await assert.rejects(
      async () => router.dispatch('crew-coder', 'Handle malformed success', {
        gateway: 'http://localhost:5010',
        timeout: '10000'
      }),
      /worker failure|failed/i
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('AgentRouter - dispatch should fail on empty done result for direct mode', async () => {
  const config = new ConfigManager();
  const toolManager = new ToolManager(config);
  const router = new AgentRouter(config, toolManager);
  const originalFetch = global.fetch;

  global.fetch = async (url, _options = {}) => {
    if (String(url).includes('/api/dispatch')) {
      return {
        ok: true,
        json: async () => ({ taskId: 'task-999' })
      };
    }
    if (String(url).includes('/api/status/task-999')) {
      return {
        ok: true,
        json: async () => ({
          status: 'done',
          result: ''
        })
      };
    }
    return {
      ok: true,
      json: async () => ({ status: 'pending' })
    };
  };

  try {
    await assert.rejects(
      async () => router.dispatch('crew-coder', 'Expect output', {
        gateway: 'http://localhost:5010',
        direct: true,
        engine: 'cursor',
        timeout: '10000'
      }),
      /empty direct\/bypass response|no textual output/i
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('AgentRouter - dispatch should fail on engine provenance mismatch in direct mode', async () => {
  const config = new ConfigManager();
  const toolManager = new ToolManager(config);
  const router = new AgentRouter(config, toolManager);
  const originalFetch = global.fetch;

  global.fetch = async (url, _options = {}) => {
    if (String(url).includes('/api/dispatch')) {
      return {
        ok: true,
        json: async () => ({ taskId: 'task-prov-1' })
      };
    }
    if (String(url).includes('/api/status/task-prov-1')) {
      return {
        ok: true,
        json: async () => ({
          status: 'done',
          result: '(claude code completed with no text output)'
        })
      };
    }
    return {
      ok: true,
      json: async () => ({ status: 'pending' })
    };
  };

  try {
    await assert.rejects(
      async () => router.dispatch('crew-coder', 'prove routing', {
        gateway: 'http://localhost:5010',
        direct: true,
        engine: 'cursor',
        timeout: '10000'
      }),
      /Engine provenance mismatch/i
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('AgentRouter - callSkill should require name', async () => {
  const config = new ConfigManager();
  const toolManager = new ToolManager(config);
  const router = new AgentRouter(config, toolManager);

  await assert.rejects(
    async () => router.callSkill(''),
    { message: 'Skill name is required' }
  );
});

test('AgentRouter - callSkill should post to gateway and return result', async () => {
  const config = new ConfigManager();
  const toolManager = new ToolManager(config);
  const router = new AgentRouter(config, toolManager);
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url, options = {}) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true,
      json: async () => ({ output: 'ok' })
    };
  };

  try {
    const result = await router.callSkill('zeroeval.benchmark', { benchmark_id: 'mmlu' }, {
      gateway: 'http://localhost:5010'
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.skill, 'zeroeval.benchmark');
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].url.includes('/api/skills/zeroeval.benchmark/run'));
    assert.strictEqual(calls[0].body.benchmark_id, 'mmlu');
  } finally {
    global.fetch = originalFetch;
  }
});
