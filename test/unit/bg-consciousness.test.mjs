/**
 * Unit tests for background consciousness loop (lib/crew-lead/background.mjs).
 *
 * The module uses internal module-level state injected via initBackground().
 * We test the observable behavior: timer/interval logic, LLM gating,
 * dispatch routing, @@BRAIN/@@DISPATCH parsing, and NO_ACTION suppression.
 * No live LLM or real timers needed.
 */
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ─── Inline the pure logic from background.mjs ────────────────────────────
// (avoids importing a module with side-effect timers in setInterval)

function getBgConsciousnessLLM(model, providers) {
  const [providerKey, ...modelParts] = String(model).split("/");
  const modelId = modelParts.join("/") || "llama-3.1-8b-instant";
  const p = providers[providerKey];
  if (!p?.apiKey) return null;
  const baseUrl = p.baseUrl || (providerKey === "groq" ? "https://api.groq.com/openai/v1" : "");
  if (!baseUrl) return null;
  return { baseUrl, apiKey: p.apiKey, modelId, providerKey };
}

function parseDispatches(content) {
  const dispatches = [];
  const re = /@@DISPATCH\s+(\{[\s\S]*?\})/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      if (obj.agent && obj.task) dispatches.push({ agent: obj.agent, task: obj.task });
    } catch { /* ignore malformed */ }
  }
  return dispatches;
}

function parseBrainLines(content) {
  const lines = [];
  const re = /@@BRAIN\s+([^\n]+)/g;
  let m;
  while ((m = re.exec(content)) !== null) lines.push(m[1].trim());
  return lines;
}

function isNoAction(content) {
  const short = content.trim();
  return /^NO_ACTION/i.test(short) || short.length < 10;
}

// Simulate the consciousness-cycle guard (enabled + interval elapsed)
function shouldRunCycle(enabled, lastAt, intervalMs, pendingPipelines) {
  if (!enabled) return false;
  if (pendingPipelines.size > 0) return false;
  return Date.now() - lastAt >= intervalMs;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("getBgConsciousnessLLM", () => {
  const groqProviders = {
    groq: { apiKey: "sk-groq-test", baseUrl: "https://api.groq.com/openai/v1" },
  };
  const noProviders = {};

  it("returns config when groq key exists", () => {
    const cfg = getBgConsciousnessLLM("groq/llama-3.1-8b-instant", groqProviders);
    assert.ok(cfg);
    assert.equal(cfg.providerKey, "groq");
    assert.equal(cfg.modelId, "llama-3.1-8b-instant");
    assert.ok(cfg.baseUrl.startsWith("https://api.groq.com"));
  });

  it("returns null when provider has no apiKey", () => {
    const cfg = getBgConsciousnessLLM("groq/llama-3.1-8b-instant", noProviders);
    assert.equal(cfg, null);
  });

  it("uses default groq baseUrl if not specified in provider config", () => {
    const providers = { groq: { apiKey: "sk-test" } }; // no baseUrl
    const cfg = getBgConsciousnessLLM("groq/llama-3.3-70b-versatile", providers);
    assert.ok(cfg);
    assert.equal(cfg.baseUrl, "https://api.groq.com/openai/v1");
  });

  it("returns null for unknown provider with no baseUrl", () => {
    const providers = { mystery: { apiKey: "sk-test" } };
    const cfg = getBgConsciousnessLLM("mystery/model-x", providers);
    assert.equal(cfg, null);
  });

  it("handles multi-slash model IDs (e.g. google/gemini-2.0/flash)", () => {
    const providers = { google: { apiKey: "sk-g", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" } };
    const cfg = getBgConsciousnessLLM("google/gemini-2.0/flash", providers);
    assert.ok(cfg);
    assert.equal(cfg.modelId, "gemini-2.0/flash");
  });
});

describe("parseDispatches", () => {
  it("extracts a single @@DISPATCH", () => {
    const content = `Here is a follow-up:
@@DISPATCH {"agent":"crew-coder","task":"Fix the login bug in auth.js"}`;
    const dispatches = parseDispatches(content);
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].agent, "crew-coder");
    assert.match(dispatches[0].task, /Fix the login/);
  });

  it("extracts multiple @@DISPATCH blocks", () => {
    const content = `Two things:
@@DISPATCH {"agent":"crew-coder","task":"Task A"}
@@DISPATCH {"agent":"crew-qa","task":"Task B"}`;
    const dispatches = parseDispatches(content);
    assert.equal(dispatches.length, 2);
    assert.equal(dispatches[0].agent, "crew-coder");
    assert.equal(dispatches[1].agent, "crew-qa");
  });

  it("ignores malformed JSON in @@DISPATCH", () => {
    const content = `@@DISPATCH {bad json here}`;
    const dispatches = parseDispatches(content);
    assert.equal(dispatches.length, 0);
  });

  it("ignores @@DISPATCH without required agent/task fields", () => {
    const content = `@@DISPATCH {"note":"no agent or task"}`;
    const dispatches = parseDispatches(content);
    assert.equal(dispatches.length, 0);
  });

  it("returns empty array when no @@DISPATCH in content", () => {
    const dispatches = parseDispatches("All clear, no actions needed.");
    assert.equal(dispatches.length, 0);
  });
});

describe("parseBrainLines", () => {
  it("extracts a single @@BRAIN entry", () => {
    const lines = parseBrainLines("@@BRAIN crew-main: User needs to review auth changes");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /User needs to review/);
  });

  it("extracts multiple @@BRAIN entries", () => {
    const content = "@@BRAIN crew-main: Fact A\nSome reply text\n@@BRAIN crew-main: Fact B";
    const lines = parseBrainLines(content);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /Fact A/);
    assert.match(lines[1], /Fact B/);
  });

  it("returns empty array with no @@BRAIN in content", () => {
    const lines = parseBrainLines("NO_ACTION");
    assert.equal(lines.length, 0);
  });
});

describe("isNoAction", () => {
  it("detects NO_ACTION prefix", () => {
    assert.ok(isNoAction("NO_ACTION"));
    assert.ok(isNoAction("no_action — nothing to report"));
  });

  it("treats very short content as no-action", () => {
    assert.ok(isNoAction("ok"));
    assert.ok(isNoAction(""));
  });

  it("does not suppress real content", () => {
    assert.equal(isNoAction("The authentication PR was merged. Consider running QA next."), false);
  });
});

describe("shouldRunCycle", () => {
  it("returns false when disabled", () => {
    const pending = new Map();
    assert.equal(shouldRunCycle(false, 0, 900_000, pending), false);
  });

  it("returns false when pipelines are pending", () => {
    const pending = new Map([["p1", {}]]);
    assert.equal(shouldRunCycle(true, 0, 900_000, pending), false);
  });

  it("returns false when interval has not elapsed", () => {
    const pending = new Map();
    const lastAt = Date.now() - 60_000; // only 1 minute ago
    assert.equal(shouldRunCycle(true, lastAt, 900_000, pending), false);
  });

  it("returns true when enabled, idle, and interval elapsed", () => {
    const pending = new Map();
    const lastAt = Date.now() - 20 * 60 * 1000; // 20 minutes ago
    assert.equal(shouldRunCycle(true, lastAt, 900_000, pending), true);
  });

  it("returns true on first run (lastAt = 0)", () => {
    const pending = new Map();
    assert.equal(shouldRunCycle(true, 0, 900_000, pending), true);
  });
});

describe("background loop — stall detection (simulated)", () => {
  function detectStalls(pipelines, staleThresholdMs = 15 * 60 * 1000) {
    const stalled = [];
    for (const [pid, pipeline] of pipelines) {
      const lastActivity = pipeline._lastActivity || Date.now();
      const staleMs = Date.now() - lastActivity;
      if (staleMs > staleThresholdMs && (pipeline.pendingTaskIds?.size ?? 0) > 0) {
        stalled.push({ pid, staleMs });
      }
    }
    return stalled;
  }

  it("detects a stalled pipeline (no activity in 20 minutes)", () => {
    const pipelines = new Map([
      ["p1", {
        _lastActivity: Date.now() - 20 * 60 * 1000,
        pendingTaskIds: new Set(["task-1"]),
      }],
    ]);
    const stalled = detectStalls(pipelines);
    assert.equal(stalled.length, 1);
    assert.equal(stalled[0].pid, "p1");
  });

  it("does not flag an active pipeline", () => {
    const pipelines = new Map([
      ["p2", {
        _lastActivity: Date.now() - 2 * 60 * 1000, // 2 min ago
        pendingTaskIds: new Set(["task-a"]),
      }],
    ]);
    const stalled = detectStalls(pipelines);
    assert.equal(stalled.length, 0);
  });

  it("does not flag a pipeline with no pending tasks", () => {
    const pipelines = new Map([
      ["p3", {
        _lastActivity: Date.now() - 60 * 60 * 1000, // 1 hour ago
        pendingTaskIds: new Set(), // nothing pending
      }],
    ]);
    const stalled = detectStalls(pipelines);
    assert.equal(stalled.length, 0);
  });

  it("detects multiple stalled pipelines", () => {
    const pipelines = new Map([
      ["a", { _lastActivity: Date.now() - 30 * 60 * 1000, pendingTaskIds: new Set(["t1"]) }],
      ["b", { _lastActivity: Date.now() - 45 * 60 * 1000, pendingTaskIds: new Set(["t2", "t3"]) }],
      ["c", { _lastActivity: Date.now() - 1 * 60 * 1000, pendingTaskIds: new Set(["t4"]) }],
    ]);
    const stalled = detectStalls(pipelines);
    assert.equal(stalled.length, 2);
    const ids = stalled.map(s => s.pid);
    assert.ok(ids.includes("a"));
    assert.ok(ids.includes("b"));
    assert.ok(!ids.includes("c"));
  });
});

describe("background loop — agent timeout tracking", () => {
  function buildTimeoutTracker() {
    const log = [];
    const counts = new Map();
    return {
      record(agent) {
        log.push({ agent, ts: Date.now() });
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        while (log.length && log[0].ts < cutoff) log.shift();
        const c = {};
        for (const e of log) c[e.agent] = (c[e.agent] || 0) + 1;
        for (const [id, n] of Object.entries(c)) counts.set(id, n);
      },
      getCounts() { return counts; },
      getLog() { return log; },
    };
  }

  it("accumulates timeout counts correctly", () => {
    const tracker = buildTimeoutTracker();
    tracker.record("crew-coder");
    tracker.record("crew-coder");
    tracker.record("crew-qa");
    assert.equal(tracker.getCounts().get("crew-coder"), 2);
    assert.equal(tracker.getCounts().get("crew-qa"), 1);
  });

  it("flags agents with 3+ timeouts", () => {
    const tracker = buildTimeoutTracker();
    for (let i = 0; i < 3; i++) tracker.record("crew-coder-front");
    const problematic = [...tracker.getCounts().entries()].filter(([, n]) => n >= 3);
    assert.equal(problematic.length, 1);
    assert.equal(problematic[0][0], "crew-coder-front");
  });

  it("counts are per-agent (different agents don't interfere)", () => {
    const tracker = buildTimeoutTracker();
    tracker.record("crew-a");
    tracker.record("crew-b");
    tracker.record("crew-a");
    assert.equal(tracker.getCounts().get("crew-a"), 2);
    assert.equal(tracker.getCounts().get("crew-b"), 1);
  });
});

describe("getRateLimitFallback (static map)", () => {
  const FALLBACK = {
    "crew-coder-back": "crew-coder",
    "crew-coder-front": "crew-coder",
    "crew-coder": "crew-main",
    "crew-frontend": "crew-coder",
    "crew-pm": "crew-main",
    "crew-qa": "crew-main",
    "crew-copywriter": "crew-main",
    "crew-security": "crew-main",
  };

  function getRateLimitFallback(agentId) {
    return FALLBACK[agentId] ?? "crew-main";
  }

  it("returns crew-coder for crew-coder-front", () => {
    assert.equal(getRateLimitFallback("crew-coder-front"), "crew-coder");
  });

  it("returns crew-main for crew-pm", () => {
    assert.equal(getRateLimitFallback("crew-pm"), "crew-main");
  });

  it("returns crew-main as default for unknown agents", () => {
    assert.equal(getRateLimitFallback("crew-unknown-x"), "crew-main");
  });

  it("covers all expected fallback keys", () => {
    const expected = ["crew-coder-back","crew-coder-front","crew-coder","crew-frontend","crew-pm","crew-qa","crew-copywriter","crew-security"];
    for (const id of expected) {
      assert.ok(getRateLimitFallback(id), `Missing fallback for ${id}`);
    }
  });
});

describe("process-status.md path (bg consciousness)", () => {
  it("process-status.md lives in ~/.crewswarm/", async () => {
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const statusPath = join(homedir(), ".crewswarm", "process-status.md");
    assert.ok(statusPath.endsWith(".crewswarm/process-status.md"));
  });
});

// ── Tests for actual exports from background.mjs ─────────────────────────────

describe("recordAgentTimeout (exported)", () => {
  it("records timeouts and updates _agentTimeoutCounts", async () => {
    const bg = await import("../../lib/crew-lead/background.mjs");
    // Clear any existing state
    bg._agentTimeoutCounts.clear();
    bg.recordAgentTimeout("crew-test-agent");
    bg.recordAgentTimeout("crew-test-agent");
    bg.recordAgentTimeout("crew-test-other");
    assert.equal(bg._agentTimeoutCounts.get("crew-test-agent"), 2);
    assert.equal(bg._agentTimeoutCounts.get("crew-test-other"), 1);
  });
});

describe("RATE_LIMIT_PATTERN (exported)", () => {
  it("matches 429 status codes", async () => {
    const bg = await import("../../lib/crew-lead/background.mjs");
    assert.ok(bg.RATE_LIMIT_PATTERN.test("Error 429: Too many requests"));
  });

  it("matches rate limit phrases", async () => {
    const bg = await import("../../lib/crew-lead/background.mjs");
    assert.ok(bg.RATE_LIMIT_PATTERN.test("rate limit exceeded"));
    assert.ok(bg.RATE_LIMIT_PATTERN.test("throttled by provider"));
    assert.ok(bg.RATE_LIMIT_PATTERN.test("quota exceeded for model"));
    assert.ok(bg.RATE_LIMIT_PATTERN.test("too many requests"));
    assert.ok(bg.RATE_LIMIT_PATTERN.test("resource_exhausted"));
    assert.ok(bg.RATE_LIMIT_PATTERN.test("server overloaded"));
  });

  it("does not match normal error messages", async () => {
    const bg = await import("../../lib/crew-lead/background.mjs");
    assert.equal(bg.RATE_LIMIT_PATTERN.test("connection refused"), false);
    assert.equal(bg.RATE_LIMIT_PATTERN.test("syntax error in file"), false);
    assert.equal(bg.RATE_LIMIT_PATTERN.test("timeout after 30s"), false);
  });
});

describe("initBackground (exported)", () => {
  it("accepts configuration without throwing", async () => {
    const bg = await import("../../lib/crew-lead/background.mjs");
    assert.doesNotThrow(() => {
      bg.initBackground({
        broadcastSSE: () => {},
        appendHistory: () => {},
        appendToBrain: () => {},
        bgConsciousnessEnabled: false,
        bgConsciousnessIntervalMs: 60000,
        brainPath: "/tmp/test-brain.md",
      });
    });
  });
});

describe("getRateLimitFallback (exported)", () => {
  it("returns expected fallback for known agents", async () => {
    const bg = await import("../../lib/crew-lead/background.mjs");
    assert.equal(bg.getRateLimitFallback("crew-coder-back"), "crew-coder");
    assert.equal(bg.getRateLimitFallback("crew-coder"), "crew-main");
    assert.equal(bg.getRateLimitFallback("crew-qa"), "crew-main");
  });

  it("returns crew-main for completely unknown agents", async () => {
    const bg = await import("../../lib/crew-lead/background.mjs");
    assert.equal(bg.getRateLimitFallback("crew-nonexistent-xyz"), "crew-main");
  });
});
