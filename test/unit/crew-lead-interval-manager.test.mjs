/**
 * Unit tests for lib/crew-lead/interval-manager.mjs
 * Tests: initIntervalManagers — verifies it registers 3 intervals with the
 * correct periods, and that each interval's cleanup logic behaves correctly.
 *
 * Strategy: Patch globalThis.setInterval before calling initIntervalManagers to
 * capture the (fn, ms) pairs. Then invoke each callback directly with test data.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { initIntervalManagers } from "../../lib/crew-lead/interval-manager.mjs";

// ── Capture the three intervals by patching setInterval around the init call ──

const capturedIntervals = [];
const origSetInterval = globalThis.setInterval;

// Build a fresh set of shared test Maps
const sseThrottle = new Map();
const activeOpenCodeAgents = new Map();
const autoRetryAttempts = new Map();
const broadcastCalls = [];
const broadcastSSE = (payload) => broadcastCalls.push(payload);

// Patch → call → restore
globalThis.setInterval = (fn, ms) => {
  capturedIntervals.push({ fn, ms });
  // Return a real handle that is immediately unref'd so the process can exit
  const handle = origSetInterval(() => {}, 999999999);
  if (typeof handle?.unref === "function") handle.unref();
  return handle;
};

initIntervalManagers({ sseThrottle, activeOpenCodeAgents, broadcastSSE, autoRetryAttempts });

globalThis.setInterval = origSetInterval;

// ── Interval registration ─────────────────────────────────────────────────

describe("interval-manager — initIntervalManagers registers 3 intervals", () => {
  it("captures exactly 3 setInterval calls", () => {
    assert.equal(
      capturedIntervals.length,
      3,
      `Expected 3 intervals, got ${capturedIntervals.length}`,
    );
  });

  it("first interval has 5-minute period (sseThrottle cleanup)", () => {
    assert.equal(capturedIntervals[0]?.ms, 5 * 60 * 1000);
  });

  it("second interval has 60-second period (opencode agent cleanup)", () => {
    assert.equal(capturedIntervals[1]?.ms, 60_000);
  });

  it("third interval has 5-minute period (autoRetryAttempts cleanup)", () => {
    assert.equal(capturedIntervals[2]?.ms, 5 * 60 * 1000);
  });

  it("all captured intervals have callable fn properties", () => {
    for (const { fn } of capturedIntervals) {
      assert.equal(typeof fn, "function");
    }
  });
});

// ── initIntervalManagers does not throw ───────────────────────────────────

describe("interval-manager — initIntervalManagers does not throw", () => {
  it("accepts all required deps without throwing", () => {
    const captured = [];
    const _orig = globalThis.setInterval;
    globalThis.setInterval = (fn, ms) => {
      captured.push({ fn, ms });
      const h = _orig(() => {}, 999999999);
      if (h?.unref) h.unref();
      return h;
    };
    assert.doesNotThrow(() => {
      initIntervalManagers({
        sseThrottle: new Map(),
        activeOpenCodeAgents: new Map(),
        broadcastSSE: () => {},
        autoRetryAttempts: new Map(),
      });
    });
    globalThis.setInterval = _orig;
  });

  it("accepts Maps with pre-populated data without throwing", () => {
    const sse = new Map([["k", Date.now()]]);
    const agents = new Map([["crew-coder", { since: Date.now() }]]);
    const retries = new Map([["t1", { timestamp: Date.now(), attempts: 1 }]]);
    const _orig = globalThis.setInterval;
    globalThis.setInterval = (fn, ms) => {
      const h = _orig(() => {}, 999999999);
      if (h?.unref) h.unref();
      return h;
    };
    assert.doesNotThrow(() => {
      initIntervalManagers({ sseThrottle: sse, activeOpenCodeAgents: agents, broadcastSSE: () => {}, autoRetryAttempts: retries });
    });
    globalThis.setInterval = _orig;
  });
});

// ── Interval callback 1: sseThrottle cleanup ─────────────────────────────

describe("interval-manager — sseThrottle cleanup callback (interval 0)", () => {
  it("deletes stale entries older than 5 minutes", () => {
    const map = new Map();
    const staleTs = Date.now() - 6 * 60 * 1000;
    const freshTs = Date.now() - 60 * 1000;
    map.set("stale-key", staleTs);
    map.set("fresh-key", freshTs);

    // Simulate what the interval does
    const stale = 5 * 60 * 1000;
    const now = Date.now();
    for (const [key, ts] of map.entries()) {
      if (now - ts > stale) map.delete(key);
    }

    assert.ok(!map.has("stale-key"), "stale entry should be deleted");
    assert.ok(map.has("fresh-key"), "fresh entry should be retained");
  });

  it("invokes captured callback and deletes stale entry from shared map", () => {
    sseThrottle.clear();
    broadcastCalls.length = 0;

    const staleTs = Date.now() - 6 * 60 * 1000;
    sseThrottle.set("stale-captured", staleTs);
    sseThrottle.set("fresh-captured", Date.now());

    // Call the actual captured callback
    capturedIntervals[0].fn();

    assert.ok(!sseThrottle.has("stale-captured"), "stale entry not removed by callback");
    assert.ok(sseThrottle.has("fresh-captured"), "fresh entry incorrectly removed");
  });

  it("leaves an empty map unchanged", () => {
    const map = new Map();
    const stale = 5 * 60 * 1000;
    const now = Date.now();
    for (const [key, ts] of map.entries()) {
      if (now - ts > stale) map.delete(key);
    }
    assert.equal(map.size, 0);
  });

  it("retains all entries when all are fresh", () => {
    const map = new Map([["a", Date.now() - 1000], ["b", Date.now() - 2000]]);
    const stale = 5 * 60 * 1000;
    const now = Date.now();
    for (const [key, ts] of map.entries()) {
      if (now - ts > stale) map.delete(key);
    }
    assert.equal(map.size, 2);
  });

  it("deletes multiple stale entries in one pass", () => {
    const map = new Map();
    const OLD = Date.now() - 10 * 60 * 1000;
    map.set("old-1", OLD);
    map.set("old-2", OLD);
    map.set("old-3", OLD);
    map.set("new-1", Date.now());
    const stale = 5 * 60 * 1000;
    const now = Date.now();
    for (const [key, ts] of map.entries()) {
      if (now - ts > stale) map.delete(key);
    }
    assert.equal(map.size, 1);
    assert.ok(map.has("new-1"));
  });
});

// ── Interval callback 2: activeOpenCodeAgents cleanup ────────────────────

describe("interval-manager — activeOpenCodeAgents cleanup callback (interval 1)", () => {
  it("invokes captured callback and removes stale agent, broadcasts agent_idle", () => {
    activeOpenCodeAgents.clear();
    broadcastCalls.length = 0;

    const STALE = Date.now() - 20 * 60 * 1000;
    const FRESH = Date.now() - 5 * 60 * 1000;
    activeOpenCodeAgents.set("crew-coder", { since: STALE });
    activeOpenCodeAgents.set("crew-qa", { since: FRESH });

    capturedIntervals[1].fn();

    assert.ok(!activeOpenCodeAgents.has("crew-coder"), "stale agent not removed");
    assert.ok(activeOpenCodeAgents.has("crew-qa"), "fresh agent incorrectly removed");
    assert.equal(broadcastCalls.length, 1);
    assert.equal(broadcastCalls[0].type, "agent_idle");
    assert.equal(broadcastCalls[0].agent, "crew-coder");
    assert.equal(broadcastCalls[0].stale, true);
  });

  it("deletes stale agent sessions and broadcasts agent_idle (logic test)", () => {
    const agents = new Map();
    const calls = [];
    const broadcast = (p) => calls.push(p);

    const staleThresholdMs = 15 * 60 * 1000;
    const STALE = Date.now() - 20 * 60 * 1000;
    const FRESH = Date.now() - 5 * 60 * 1000;

    agents.set("crew-coder", { since: STALE });
    agents.set("crew-qa", { since: FRESH });

    const now = Date.now();
    for (const [agentId, { since }] of agents.entries()) {
      if (now - since > staleThresholdMs) {
        agents.delete(agentId);
        broadcast({ type: "agent_idle", agent: agentId, ts: now, stale: true });
      }
    }

    assert.ok(!agents.has("crew-coder"), "stale agent not removed");
    assert.ok(agents.has("crew-qa"), "fresh agent incorrectly removed");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, "agent_idle");
    assert.equal(calls[0].stale, true);
  });

  it("broadcasts nothing when all agents are fresh", () => {
    const agents = new Map([["crew-coder", { since: Date.now() - 60_000 }]]);
    const calls = [];
    const staleThresholdMs = 15 * 60 * 1000;
    const now = Date.now();
    for (const [agentId, { since }] of agents.entries()) {
      if (now - since > staleThresholdMs) {
        agents.delete(agentId);
        calls.push({ type: "agent_idle" });
      }
    }
    assert.equal(calls.length, 0);
    assert.ok(agents.has("crew-coder"));
  });

  it("handles empty map without broadcasting", () => {
    const agents = new Map();
    const calls = [];
    const staleThresholdMs = 15 * 60 * 1000;
    const now = Date.now();
    for (const [agentId, { since }] of agents.entries()) {
      if (now - since > staleThresholdMs) calls.push(agentId);
    }
    assert.equal(calls.length, 0);
  });

  it("removes multiple stale agents in one pass", () => {
    const agents = new Map();
    const calls = [];
    const broadcast = (p) => calls.push(p);
    const STALE = Date.now() - 30 * 60 * 1000;
    agents.set("crew-coder", { since: STALE });
    agents.set("crew-qa", { since: STALE });
    agents.set("crew-pm", { since: Date.now() - 60_000 });

    const staleThresholdMs = 15 * 60 * 1000;
    const now = Date.now();
    for (const [agentId, { since }] of agents.entries()) {
      if (now - since > staleThresholdMs) {
        agents.delete(agentId);
        broadcast({ type: "agent_idle", agent: agentId, ts: now, stale: true });
      }
    }

    assert.equal(agents.size, 1);
    assert.ok(agents.has("crew-pm"));
    assert.equal(calls.length, 2);
    assert.ok(calls.every((c) => c.type === "agent_idle" && c.stale === true));
  });
});

// ── Interval callback 3: autoRetryAttempts cleanup ───────────────────────

describe("interval-manager — autoRetryAttempts cleanup callback (interval 2)", () => {
  it("invokes captured callback and removes stale tasks", () => {
    autoRetryAttempts.clear();
    autoRetryAttempts.set("task-old", { timestamp: Date.now() - 11 * 60 * 1000, attempts: 3 });
    autoRetryAttempts.set("task-fresh", { timestamp: Date.now() - 2 * 60 * 1000, attempts: 1 });

    capturedIntervals[2].fn();

    assert.ok(!autoRetryAttempts.has("task-old"), "old task not deleted by callback");
    assert.ok(autoRetryAttempts.has("task-fresh"), "fresh task incorrectly deleted");
  });

  it("deletes entries older than 10 minutes (logic test)", () => {
    const retries = new Map();
    const AUTO_RETRY_TTL = 10 * 60 * 1000;
    retries.set("task-old", { timestamp: Date.now() - 11 * 60 * 1000, attempts: 3 });
    retries.set("task-fresh", { timestamp: Date.now() - 2 * 60 * 1000, attempts: 1 });

    const now = Date.now();
    for (const [taskId, data] of retries.entries()) {
      if (now - data.timestamp > AUTO_RETRY_TTL) retries.delete(taskId);
    }

    assert.ok(!retries.has("task-old"), "old task not deleted");
    assert.ok(retries.has("task-fresh"), "fresh task incorrectly deleted");
  });

  it("leaves empty map unchanged", () => {
    const retries = new Map();
    const AUTO_RETRY_TTL = 10 * 60 * 1000;
    const now = Date.now();
    for (const [taskId, data] of retries.entries()) {
      if (now - data.timestamp > AUTO_RETRY_TTL) retries.delete(taskId);
    }
    assert.equal(retries.size, 0);
  });

  it("keeps entries exactly at the TTL boundary", () => {
    const retries = new Map();
    const AUTO_RETRY_TTL = 10 * 60 * 1000;
    const BOUNDARY_TS = Date.now() - AUTO_RETRY_TTL + 500;
    retries.set("task-boundary", { timestamp: BOUNDARY_TS, attempts: 1 });

    const now = Date.now();
    for (const [taskId, data] of retries.entries()) {
      if (now - data.timestamp > AUTO_RETRY_TTL) retries.delete(taskId);
    }
    assert.ok(retries.has("task-boundary"), "entry at boundary should not be deleted");
  });

  it("deletes all stale tasks when all are over TTL", () => {
    const retries = new Map();
    const AUTO_RETRY_TTL = 10 * 60 * 1000;
    const OLD = Date.now() - 20 * 60 * 1000;
    for (let i = 0; i < 5; i++) {
      retries.set(`task-${i}`, { timestamp: OLD, attempts: i + 1 });
    }

    const now = Date.now();
    for (const [taskId, data] of retries.entries()) {
      if (now - data.timestamp > AUTO_RETRY_TTL) retries.delete(taskId);
    }
    assert.equal(retries.size, 0);
  });
});
