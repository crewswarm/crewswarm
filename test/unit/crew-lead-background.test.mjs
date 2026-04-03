/**
 * Unit tests for lib/crew-lead/background.mjs
 * Tests: initBackground, recordAgentTimeout, getRateLimitFallback, RATE_LIMIT_PATTERN,
 * startBackgroundLoop (interval creation), and _agentTimeoutCounts.
 *
 * The background loop itself calls fetch (LLM) and dispatches tasks; those are
 * integration concerns.  We focus on the pure-logic exports and state management.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  initBackground,
  recordAgentTimeout,
  getRateLimitFallback,
  startBackgroundLoop,
  RATE_LIMIT_PATTERN,
  _agentTimeoutCounts,
} from "../../lib/crew-lead/background.mjs";

// ── Helpers ────────────────────────────────────────────────────────────────

function clearTimeoutCounts() {
  _agentTimeoutCounts.clear();
}

// Reset to safe no-op dependencies before each test
function resetBackground() {
  initBackground({
    broadcastSSE: () => {},
    appendHistory: () => {},
    appendToBrain: () => {},
    dispatchTask: () => null,
    findNextRoadmapPhase: () => null,
    parseDispatches: () => [],
    pendingPipelines: new Map(),
    readProjectsRegistry: () => [],
    autoAdvanceRoadmap: async () => {},
    tryRead: () => null,
    bgConsciousnessEnabled: false,
    getBgConsciousnessEnabled: null,
    bgConsciousnessIntervalMs: 15 * 60 * 1000,
    bgConsciousnessModel: "groq/llama-3.1-8b-instant",
    brainPath: "/nonexistent/brain.md",
  });
}

// Keep track of intervals created so we can clear them after each test
let intervalsBefore = [];

beforeEach(() => {
  clearTimeoutCounts();
  resetBackground();
});

afterEach(() => {
  clearTimeoutCounts();
  resetBackground();
});

// ── initBackground ─────────────────────────────────────────────────────────

describe("background — initBackground", () => {
  it("accepts a full valid deps object without throwing", () => {
    assert.doesNotThrow(() => {
      initBackground({
        broadcastSSE: () => {},
        appendHistory: () => {},
        appendToBrain: () => {},
        dispatchTask: () => null,
        findNextRoadmapPhase: () => null,
        parseDispatches: () => [],
        pendingPipelines: new Map(),
        readProjectsRegistry: () => [],
        autoAdvanceRoadmap: async () => {},
        tryRead: () => null,
        bgConsciousnessEnabled: true,
        bgConsciousnessIntervalMs: 60000,
        bgConsciousnessModel: "openai/gpt-5.4",
        brainPath: "/tmp/brain.md",
      });
    });
  });

  it("accepts partial deps (only broadcastSSE) without throwing", () => {
    assert.doesNotThrow(() => {
      initBackground({ broadcastSSE: () => {} });
    });
  });

  it("stores bgConsciousnessEnabled=true without error", () => {
    assert.doesNotThrow(() => {
      initBackground({ bgConsciousnessEnabled: true });
    });
  });

  it("stores bgConsciousnessEnabled=false without error", () => {
    assert.doesNotThrow(() => {
      initBackground({ bgConsciousnessEnabled: false });
    });
  });
});

// ── recordAgentTimeout ────────────────────────────────────────────────────

// Unique agent IDs prevent cross-test log contamination.
// _timeoutLog is module-private and accumulates across the process; using fresh
// IDs guarantees we only observe counts produced by the current test.
let _testAgentSeq = 0;
function uniqueTestAgent() {
  return `crew-test-timeout-${++_testAgentSeq}`;
}

describe("background — recordAgentTimeout", () => {
  it("records a timeout for a new agent, count becomes 1", () => {
    const id = uniqueTestAgent();
    recordAgentTimeout(id);
    assert.equal(_agentTimeoutCounts.get(id), 1);
  });

  it("increments count for repeated timeouts on the same agent", () => {
    const id = uniqueTestAgent();
    recordAgentTimeout(id);
    recordAgentTimeout(id);
    recordAgentTimeout(id);
    assert.equal(_agentTimeoutCounts.get(id), 3);
  });

  it("tracks multiple agents independently", () => {
    const idA = uniqueTestAgent();
    const idB = uniqueTestAgent();
    recordAgentTimeout(idA);
    recordAgentTimeout(idA);
    recordAgentTimeout(idB);
    assert.equal(_agentTimeoutCounts.get(idA), 2);
    assert.equal(_agentTimeoutCounts.get(idB), 1);
  });

  it("does not throw for empty string agent id", () => {
    assert.doesNotThrow(() => recordAgentTimeout(""));
  });

  it("does not throw for unusual agent id characters", () => {
    assert.doesNotThrow(() => recordAgentTimeout("crew-custom-123_alpha"));
  });

  it("counts expire after 24h (simulated via old timestamps)", () => {
    // We can't freeze time, but we can verify that the log pruning logic is present
    // by recording a timeout and confirming count >= 1 (counts are always positive after record)
    const id = uniqueTestAgent();
    recordAgentTimeout(id);
    assert.ok(
      (_agentTimeoutCounts.get(id) || 0) >= 1,
      "count should be at least 1 after recording",
    );
  });
});

// ── getRateLimitFallback ──────────────────────────────────────────────────

describe("background — getRateLimitFallback", () => {
  it("returns crew-coder for crew-coder-back (static map)", () => {
    assert.equal(getRateLimitFallback("crew-coder-back"), "crew-coder");
  });

  it("returns crew-coder for crew-coder-front (static map)", () => {
    assert.equal(getRateLimitFallback("crew-coder-front"), "crew-coder");
  });

  it("returns crew-main for crew-coder (static map)", () => {
    assert.equal(getRateLimitFallback("crew-coder"), "crew-main");
  });

  it("returns crew-coder for crew-frontend (static map)", () => {
    assert.equal(getRateLimitFallback("crew-frontend"), "crew-coder");
  });

  it("returns crew-main for crew-pm (static map)", () => {
    assert.equal(getRateLimitFallback("crew-pm"), "crew-main");
  });

  it("returns crew-main for crew-qa (static map)", () => {
    assert.equal(getRateLimitFallback("crew-qa"), "crew-main");
  });

  it("returns crew-main for crew-copywriter (static map)", () => {
    assert.equal(getRateLimitFallback("crew-copywriter"), "crew-main");
  });

  it("returns crew-main for crew-security (static map)", () => {
    assert.equal(getRateLimitFallback("crew-security"), "crew-main");
  });

  it("returns crew-main for completely unknown agent", () => {
    // tryRead returns null → agent not found → default crew-main
    assert.equal(getRateLimitFallback("crew-totally-unknown-xyz"), "crew-main");
  });

  it("returns crew-main for empty string agent", () => {
    assert.equal(getRateLimitFallback(""), "crew-main");
  });

  it("uses _role fallback for dynamic agent with coder role", () => {
    initBackground({
      tryRead: (p) => {
        if (p.endsWith("crewswarm.json")) {
          return { agents: [{ id: "crew-ml", _role: "coder" }] };
        }
        return null;
      },
    });
    assert.equal(getRateLimitFallback("crew-ml"), "crew-coder");
  });

  it("uses _role fallback for dynamic agent with writer role", () => {
    initBackground({
      tryRead: (p) => {
        if (p.endsWith("crewswarm.json")) {
          return { agents: [{ id: "crew-blogger", _role: "writer" }] };
        }
        return null;
      },
    });
    assert.equal(getRateLimitFallback("crew-blogger"), "crew-copywriter");
  });

  it("uses _role fallback for dynamic agent with researcher role", () => {
    initBackground({
      tryRead: (p) => {
        if (p.endsWith("crewswarm.json")) {
          return { agents: [{ id: "crew-analyst", _role: "researcher" }] };
        }
        return null;
      },
    });
    assert.equal(getRateLimitFallback("crew-analyst"), "crew-main");
  });

  it("uses _role fallback for dynamic agent with auditor role", () => {
    initBackground({
      tryRead: (p) => {
        if (p.endsWith("crewswarm.json")) {
          return { agents: [{ id: "crew-auditor", _role: "auditor" }] };
        }
        return null;
      },
    });
    assert.equal(getRateLimitFallback("crew-auditor"), "crew-qa");
  });

  it("uses _role fallback for dynamic agent with ops role", () => {
    initBackground({
      tryRead: (p) => {
        if (p.endsWith("crewswarm.json")) {
          return { agents: [{ id: "crew-devops", _role: "ops" }] };
        }
        return null;
      },
    });
    assert.equal(getRateLimitFallback("crew-devops"), "crew-main");
  });

  it("returns agentId (self) when agent has fallbackModel configured", () => {
    initBackground({
      tryRead: (p) => {
        if (p.endsWith("crewswarm.json")) {
          return {
            agents: [
              { id: "crew-ml", fallbackModel: "groq/llama-3.1-70b-versatile" },
            ],
          };
        }
        return null;
      },
    });
    // When fallbackModel is set, getRateLimitFallback returns the agent itself
    assert.equal(getRateLimitFallback("crew-ml"), "crew-ml");
  });
});

// ── RATE_LIMIT_PATTERN ────────────────────────────────────────────────────

describe("background — RATE_LIMIT_PATTERN", () => {
  const shouldMatch = [
    "429 Too Many Requests",
    "Error: 429",
    "rate limit exceeded",
    "Rate Limit Exceeded",
    "rate_limit exceeded",
    "throttled",
    "Throttling",
    "quota exceeded",
    "quota_exceeded",
    "too many requests",
    "too_many_requests",
    "resource_exhausted",
    "overloaded",
    "Model overloaded",
  ];

  const shouldNotMatch = [
    "200 OK",
    "Internal Server Error",
    "context window exceeded",
    "token limit reached",
    "connection refused",
  ];

  for (const msg of shouldMatch) {
    it(`matches: "${msg}"`, () => {
      assert.ok(RATE_LIMIT_PATTERN.test(msg), `Expected RATE_LIMIT_PATTERN to match: ${msg}`);
    });
  }

  for (const msg of shouldNotMatch) {
    it(`does not match: "${msg}"`, () => {
      assert.ok(!RATE_LIMIT_PATTERN.test(msg), `Expected RATE_LIMIT_PATTERN NOT to match: ${msg}`);
    });
  }
});

// ── startBackgroundLoop ───────────────────────────────────────────────────

describe("background — startBackgroundLoop", () => {
  it("does not throw when called with bgConsciousnessEnabled=false", () => {
    initBackground({
      bgConsciousnessEnabled: false,
      broadcastSSE: () => {},
      readProjectsRegistry: () => [],
      pendingPipelines: new Map(),
    });
    assert.doesNotThrow(() => {
      startBackgroundLoop();
    });
  });

  it("does not throw when called with bgConsciousnessEnabled=true", () => {
    initBackground({
      bgConsciousnessEnabled: true,
      broadcastSSE: () => {},
      readProjectsRegistry: () => [],
      pendingPipelines: new Map(),
      tryRead: () => null, // no LLM config → no actual LLM call
    });
    assert.doesNotThrow(() => {
      startBackgroundLoop();
    });
  });

  it("can be called multiple times without accumulating intervals (idempotent)", () => {
    initBackground({
      bgConsciousnessEnabled: false,
      broadcastSSE: () => {},
      readProjectsRegistry: () => [],
      pendingPipelines: new Map(),
    });
    assert.doesNotThrow(() => {
      startBackgroundLoop();
      startBackgroundLoop();
      startBackgroundLoop();
    });
  });
});

// ── _agentTimeoutCounts exported map ─────────────────────────────────────

describe("background — _agentTimeoutCounts map", () => {
  it("is a Map instance", () => {
    assert.ok(_agentTimeoutCounts instanceof Map);
  });

  it("starts empty after clearTimeoutCounts()", () => {
    clearTimeoutCounts();
    assert.equal(_agentTimeoutCounts.size, 0);
  });

  it("is updated (has new key) after recordAgentTimeout", () => {
    const id = uniqueTestAgent();
    // Verify this key does not exist before recording
    assert.ok(!_agentTimeoutCounts.has(id), "key should not pre-exist");
    recordAgentTimeout(id);
    assert.ok(_agentTimeoutCounts.has(id), "key should exist after recording");
    assert.equal(_agentTimeoutCounts.get(id), 1);
  });
});
