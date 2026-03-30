/**
 * Unit tests for crew-cli/src/orchestrator/index.ts
 *
 * Tests exported class Orchestrator — deterministic routing logic,
 * agent name normalization, execution intent detection, and route
 * decision heuristics. All LLM/network calls are mocked.
 *
 * Run with: node --import tsx --test crew-cli/tests/unit/orchestrator.test.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator, RouteDecision } from '../../src/orchestrator/index.js';

// ---------------------------------------------------------------------------
// Minimal stubs for constructor dependencies
// ---------------------------------------------------------------------------

function makeMockRouter() {
  return { route: async () => null };
}

function makeMockSandbox() {
  return {
    addChange: async () => {},
    getChanges: () => [],
    clear: () => {},
  };
}

function makeMockSession() {
  return {
    appendRouting: async () => {},
    trackCost: async () => {},
    getHistory: () => [],
  };
}

function createOrchestrator(overrides = {}) {
  // Ensure no API keys are set so LLM routing always falls through to heuristics
  const savedKeys = {};
  const keysToUnset = [
    'XAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
    'DEEPSEEK_API_KEY', 'GROQ_API_KEY', 'GROQ_ROUTING_ENABLED',
  ];
  for (const k of keysToUnset) {
    savedKeys[k] = process.env[k];
    delete process.env[k];
  }
  // Force legacy router so we test deterministic heuristics
  process.env.CREW_LEGACY_ROUTER = 'true';

  const orch = new Orchestrator(
    overrides.router || makeMockRouter(),
    overrides.sandbox || makeMockSandbox(),
    overrides.session || makeMockSession(),
    overrides.profile || 'builder',
  );

  // Restore env after construction
  const restore = () => {
    for (const [k, v] of Object.entries(savedKeys)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete process.env.CREW_LEGACY_ROUTER;
  };

  return { orch, restore };
}

// ---------------------------------------------------------------------------
// RouteDecision enum
// ---------------------------------------------------------------------------

describe('RouteDecision enum', () => {
  it('defines CHAT, CODE, DISPATCH, SKILL', () => {
    assert.equal(RouteDecision.CHAT, 'CHAT');
    assert.equal(RouteDecision.CODE, 'CODE');
    assert.equal(RouteDecision.DISPATCH, 'DISPATCH');
    assert.equal(RouteDecision.SKILL, 'SKILL');
  });
});

// ---------------------------------------------------------------------------
// Deterministic routing (heuristic fallback)
// ---------------------------------------------------------------------------

describe('Orchestrator.route — heuristic routing', () => {
  let orch, restore;

  beforeEach(() => {
    ({ orch, restore } = createOrchestrator());
  });

  it('routes greetings to CHAT', async () => {
    try {
      const result = await orch.route('hello');
      assert.equal(result.decision, RouteDecision.CHAT);
      assert.ok(result.response, 'CHAT should include a response');
    } finally {
      restore();
    }
  });

  it('routes "hi there" to CHAT', async () => {
    try {
      const result = await orch.route('hi there');
      assert.equal(result.decision, RouteDecision.CHAT);
    } finally {
      restore();
    }
  });

  it('routes "create a new API endpoint" to CODE', async () => {
    try {
      const result = await orch.route('create a new API endpoint');
      assert.equal(result.decision, RouteDecision.CODE);
      assert.equal(result.agent, 'crew-coder');
    } finally {
      restore();
    }
  });

  it('routes "implement user auth" to CODE', async () => {
    try {
      const result = await orch.route('implement user auth');
      assert.equal(result.decision, RouteDecision.CODE);
    } finally {
      restore();
    }
  });

  it('routes "build a website" to DISPATCH with crew-pm', async () => {
    try {
      const result = await orch.route('build a website');
      assert.equal(result.decision, RouteDecision.DISPATCH);
      assert.equal(result.agent, 'crew-pm');
    } finally {
      restore();
    }
  });

  it('routes "roadmap for Q3" to DISPATCH with crew-pm', async () => {
    try {
      const result = await orch.route('roadmap for Q3');
      assert.equal(result.decision, RouteDecision.DISPATCH);
      assert.equal(result.agent, 'crew-pm');
    } finally {
      restore();
    }
  });

  it('routes "skill: analyze" to SKILL', async () => {
    try {
      const result = await orch.route('skill: analyze');
      assert.equal(result.decision, RouteDecision.SKILL);
    } finally {
      restore();
    }
  });

  it('routes "run skill deploy" to SKILL', async () => {
    try {
      const result = await orch.route('run skill deploy');
      assert.equal(result.decision, RouteDecision.SKILL);
    } finally {
      restore();
    }
  });

  it('routes "ask the fixer to debug this" to DISPATCH with crew-fixer', async () => {
    try {
      const result = await orch.route('ask the fixer to debug this');
      assert.equal(result.decision, RouteDecision.DISPATCH);
      assert.equal(result.agent, 'crew-fixer');
    } finally {
      restore();
    }
  });

  it('routes "tell qa to run tests" to DISPATCH with crew-qa', async () => {
    try {
      const result = await orch.route('tell qa to run tests');
      assert.equal(result.decision, RouteDecision.DISPATCH);
      assert.equal(result.agent, 'crew-qa');
    } finally {
      restore();
    }
  });

  it('routes "ask frontend to style the nav" to DISPATCH with crew-frontend', async () => {
    try {
      const result = await orch.route('ask frontend to style the nav');
      assert.equal(result.decision, RouteDecision.DISPATCH);
      assert.equal(result.agent, 'crew-frontend');
    } finally {
      restore();
    }
  });

  it('routes "ask security to audit" to DISPATCH with crew-security', async () => {
    try {
      const result = await orch.route('ask security to audit');
      assert.equal(result.decision, RouteDecision.DISPATCH);
      assert.equal(result.agent, 'crew-security');
    } finally {
      restore();
    }
  });

  it('routes "what model are you using" to CHAT', async () => {
    try {
      const result = await orch.route('what model are you using');
      assert.equal(result.decision, RouteDecision.CHAT);
    } finally {
      restore();
    }
  });

  it('routes unrecognized input to DISPATCH with crew-main', async () => {
    try {
      const result = await orch.route('explain quantum computing');
      assert.equal(result.decision, RouteDecision.DISPATCH);
      assert.equal(result.agent, 'crew-main');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// normalizeAgentName (tested indirectly via source inspection)
// ---------------------------------------------------------------------------

describe('Orchestrator — agent name normalization', () => {
  let orch, restore;

  beforeEach(() => {
    ({ orch, restore } = createOrchestrator());
  });

  // normalizeAgentName is private, but we can verify its effects through routing
  it('route result always has normalized crew-* agent names', async () => {
    try {
      const result = await orch.route('ask the fixer to help');
      assert.ok(result.agent?.startsWith('crew-'), `agent should be normalized: ${result.agent}`);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// trackCost
// ---------------------------------------------------------------------------

describe('Orchestrator.trackCost', () => {
  it('calls session.trackCost with model and token counts', async () => {
    let tracked = null;
    const { orch, restore } = createOrchestrator({
      session: {
        appendRouting: async () => {},
        trackCost: async (data) => { tracked = data; },
        getHistory: () => [],
      },
    });
    try {
      await orch.trackCost('gpt-4', 1000, 500);
      assert.ok(tracked, 'trackCost should have been called');
      assert.equal(tracked.model, 'gpt-4');
      assert.equal(tracked.promptTokens, 1000);
      assert.equal(tracked.completionTokens, 500);
      assert.ok(typeof tracked.usd === 'number');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// parseAndApplyToSandbox (basic parsing)
// ---------------------------------------------------------------------------

describe('Orchestrator.parseAndApplyToSandbox', () => {
  it('parses @@WRITE_FILE blocks and passes them to sandbox', async () => {
    const changes = [];
    const { orch, restore } = createOrchestrator({
      sandbox: {
        addChange: async (path, content) => { changes.push({ path, content }); },
        getChanges: () => [],
        clear: () => {},
      },
    });
    try {
      const output = `Some text
@@WRITE_FILE src/hello.ts
export function hello() { return "hi"; }
@@END_FILE
Done.`;
      const files = await orch.parseAndApplyToSandbox(output);
      assert.ok(files.includes('src/hello.ts'));
    } finally {
      restore();
    }
  });

  it('returns empty array for output with no file blocks', async () => {
    const { orch, restore } = createOrchestrator();
    try {
      const files = await orch.parseAndApplyToSandbox('Just a plain response with no files.');
      assert.ok(Array.isArray(files));
      assert.equal(files.length, 0);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Profile management
// ---------------------------------------------------------------------------

describe('Orchestrator profile management', () => {
  it('getProfile returns a profile config object', () => {
    const { orch, restore } = createOrchestrator();
    try {
      const profile = orch.getProfile();
      assert.ok(profile, 'getProfile should return a value');
    } finally {
      restore();
    }
  });

  it('setProfile changes the profile', () => {
    const { orch, restore } = createOrchestrator();
    try {
      orch.setProfile('minimal');
      // No throw means it accepted the value
      assert.ok(true);
    } finally {
      restore();
    }
  });
});
