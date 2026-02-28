/**
 * Coordinator-only dispatch tests.
 *
 * Covers:
 *  - COORDINATOR_AGENT_IDS membership (agent-registry)
 *  - Canonical JSON dispatch format: @@DISPATCH {"agent":"...","task":"..."}
 *  - Legacy pipe format: @@DISPATCH:agent-id|task
 *  - Non-coordinator agents are blocked from dispatching (@@DISPATCH ignored)
 *  - Self-dispatch blocked even for coordinators
 *  - dispatchTask queue cap (CREWSWARM_DISPATCH_QUEUE_LIMIT)
 *  - correlationId generated and stored per dispatch
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  COORDINATOR_AGENT_IDS,
  BUILT_IN_RT_AGENTS,
} from "../../lib/agent-registry.mjs";

import {
  initWaveDispatcher,
  dispatchTask,
  pendingDispatches,
} from "../../lib/crew-lead/wave-dispatcher.mjs";

// ── Helpers ────────────────────────────────────────────────────────────────

function createMockDeps(overrides = {}) {
  const broadcastSSE = (payload) => (broadcastSSE.calls = broadcastSSE.calls || []).push(payload);
  broadcastSSE.calls = [];
  return {
    broadcastSSE,
    appendHistory: () => {},
    isAgentOnRtBus: async () => false,
    getRtPublish: () => null,
    loadConfig: () => ({}),
    resolveAgentId: (_cfg, agent) => agent,
    buildTaskText: (task) => (typeof task === "string" ? task : task?.task ?? ""),
    emitTaskLifecycle: () => {},
    bumpOpsCounter: () => {},
    recordOpsEvent: () => {},
    dispatchTimeoutMs: 100,
    dispatchClaimedTimeoutMs: 200,
    ...overrides,
  };
}

/**
 * Simulate the coordinator-guard logic from rt-envelope.mjs without importing the
 * full module (which has heavy side-effects).  Keep this in sync with the
 * implementation at lib/engines/rt-envelope.mjs ~line 647.
 */
function parseDispatchCommands(agentId, reply) {
  const COORDINATOR_AGENTS = new Set(COORDINATOR_AGENT_IDS);
  if (!COORDINATOR_AGENTS.has(agentId)) return [];

  const results = [];

  // Canonical JSON format
  for (const m of reply.matchAll(/@@DISPATCH\s+(\{[^}]+\})/g)) {
    try {
      const d = JSON.parse(m[1]);
      if (d.agent && d.task) {
        results.push({ targetAgent: d.agent.trim(), taskText: d.task.trim() });
      }
    } catch {}
  }

  // Legacy pipe format
  for (const m of reply.matchAll(/@@DISPATCH:([a-z0-9_-]+)\|([^\n@@]+)/g)) {
    results.push({ targetAgent: m[1].trim(), taskText: m[2].trim() });
  }

  // Block self-dispatch and empty targets
  return results.filter(
    ({ targetAgent, taskText }) => targetAgent && taskText && targetAgent !== agentId
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("coordinator-dispatch: agent-registry", () => {
  it("COORDINATOR_AGENT_IDS is a non-empty array", () => {
    assert.ok(Array.isArray(COORDINATOR_AGENT_IDS));
    assert.ok(COORDINATOR_AGENT_IDS.length > 0);
  });

  it("crew-main is a coordinator", () => {
    assert.ok(COORDINATOR_AGENT_IDS.includes("crew-main"));
  });

  it("crew-pm is a coordinator", () => {
    assert.ok(COORDINATOR_AGENT_IDS.includes("crew-pm"));
  });

  it("crew-orchestrator is a coordinator", () => {
    assert.ok(COORDINATOR_AGENT_IDS.includes("crew-orchestrator"));
  });

  it("crew-coder is NOT a coordinator", () => {
    assert.ok(!COORDINATOR_AGENT_IDS.includes("crew-coder"));
  });

  it("crew-qa is NOT a coordinator", () => {
    assert.ok(!COORDINATOR_AGENT_IDS.includes("crew-qa"));
  });

  it("crew-fixer is NOT a coordinator", () => {
    assert.ok(!COORDINATOR_AGENT_IDS.includes("crew-fixer"));
  });

  it("crew-github is NOT a coordinator", () => {
    assert.ok(!COORDINATOR_AGENT_IDS.includes("crew-github"));
  });

  it("all coordinators appear in BUILT_IN_RT_AGENTS", () => {
    for (const id of COORDINATOR_AGENT_IDS) {
      assert.ok(
        BUILT_IN_RT_AGENTS.includes(id),
        `${id} is a coordinator but missing from BUILT_IN_RT_AGENTS`
      );
    }
  });
});

describe("coordinator-dispatch: @@DISPATCH parsing — coordinators CAN dispatch", () => {
  it("crew-main parses canonical JSON format", () => {
    const reply = 'I will dispatch this.\n@@DISPATCH {"agent":"crew-coder","task":"write hello.js"}';
    const results = parseDispatchCommands("crew-main", reply);
    assert.equal(results.length, 1);
    assert.equal(results[0].targetAgent, "crew-coder");
    assert.equal(results[0].taskText, "write hello.js");
  });

  it("crew-pm parses canonical JSON format", () => {
    const reply = '@@DISPATCH {"agent":"crew-frontend","task":"build landing page"}';
    const results = parseDispatchCommands("crew-pm", reply);
    assert.equal(results.length, 1);
    assert.equal(results[0].targetAgent, "crew-frontend");
  });

  it("crew-orchestrator parses canonical JSON format", () => {
    const reply = '@@DISPATCH {"agent":"crew-coder-back","task":"create API route"}';
    const results = parseDispatchCommands("crew-orchestrator", reply);
    assert.equal(results.length, 1);
    assert.equal(results[0].targetAgent, "crew-coder-back");
  });

  it("parses legacy pipe format: @@DISPATCH:agent|task", () => {
    const reply = "@@DISPATCH:crew-coder|write a REST endpoint for /users";
    const results = parseDispatchCommands("crew-main", reply);
    assert.equal(results.length, 1);
    assert.equal(results[0].targetAgent, "crew-coder");
    assert.equal(results[0].taskText, "write a REST endpoint for /users");
  });

  it("parses multiple dispatches in one reply", () => {
    const reply = [
      '@@DISPATCH {"agent":"crew-coder","task":"write backend"}',
      '@@DISPATCH {"agent":"crew-frontend","task":"write UI"}',
    ].join("\n");
    const results = parseDispatchCommands("crew-main", reply);
    assert.equal(results.length, 2);
    const agents = results.map((r) => r.targetAgent);
    assert.ok(agents.includes("crew-coder"));
    assert.ok(agents.includes("crew-frontend"));
  });

  it("ignores malformed JSON gracefully", () => {
    const reply = '@@DISPATCH {agent:"crew-coder",task:broken}';
    const results = parseDispatchCommands("crew-main", reply);
    assert.equal(results.length, 0);
  });

  it("ignores @@DISPATCH with missing agent field", () => {
    const reply = '@@DISPATCH {"task":"do something"}';
    const results = parseDispatchCommands("crew-main", reply);
    assert.equal(results.length, 0);
  });

  it("ignores @@DISPATCH with missing task field", () => {
    const reply = '@@DISPATCH {"agent":"crew-coder"}';
    const results = parseDispatchCommands("crew-main", reply);
    assert.equal(results.length, 0);
  });
});

describe("coordinator-dispatch: non-coordinators CANNOT dispatch", () => {
  it("crew-coder is blocked — returns empty array", () => {
    const reply = '@@DISPATCH {"agent":"crew-qa","task":"review everything"}';
    const results = parseDispatchCommands("crew-coder", reply);
    assert.equal(results.length, 0);
  });

  it("crew-qa is blocked — returns empty array", () => {
    const reply = '@@DISPATCH {"agent":"crew-fixer","task":"fix all bugs"}';
    const results = parseDispatchCommands("crew-qa", reply);
    assert.equal(results.length, 0);
  });

  it("crew-fixer is blocked — returns empty array", () => {
    const reply = '@@DISPATCH {"agent":"crew-coder","task":"rebuild it"}';
    const results = parseDispatchCommands("crew-fixer", reply);
    assert.equal(results.length, 0);
  });

  it("crew-github is blocked — returns empty array", () => {
    const reply = "@@DISPATCH:crew-coder|write tests";
    const results = parseDispatchCommands("crew-github", reply);
    assert.equal(results.length, 0);
  });

  it("crew-copywriter is blocked — returns empty array", () => {
    const reply = '@@DISPATCH {"agent":"crew-coder","task":"build it"}';
    const results = parseDispatchCommands("crew-copywriter", reply);
    assert.equal(results.length, 0);
  });

  it("unknown / arbitrary agent is blocked", () => {
    const reply = '@@DISPATCH {"agent":"crew-coder","task":"do work"}';
    const results = parseDispatchCommands("some-rogue-agent", reply);
    assert.equal(results.length, 0);
  });
});

describe("coordinator-dispatch: self-dispatch blocked", () => {
  it("crew-main cannot dispatch to itself", () => {
    const reply = '@@DISPATCH {"agent":"crew-main","task":"do something"}';
    const results = parseDispatchCommands("crew-main", reply);
    assert.equal(results.length, 0);
  });

  it("crew-pm cannot dispatch to itself", () => {
    const reply = '@@DISPATCH {"agent":"crew-pm","task":"plan again"}';
    const results = parseDispatchCommands("crew-pm", reply);
    assert.equal(results.length, 0);
  });

  it("allows cross-coordinator dispatch (crew-main → crew-pm)", () => {
    const reply = '@@DISPATCH {"agent":"crew-pm","task":"build the roadmap"}';
    const results = parseDispatchCommands("crew-main", reply);
    assert.equal(results.length, 1);
    assert.equal(results[0].targetAgent, "crew-pm");
  });
});

describe("coordinator-dispatch: dispatchTask queue cap", () => {
  beforeEach(() => pendingDispatches.clear());
  afterEach(() => pendingDispatches.clear());

  it("rejects dispatch when queue is at limit, broadcasts task.queue_full", () => {
    const sseCalls = [];
    const LIMIT = 2;
    let taskCounter = 0;

    const deps = createMockDeps({
      dispatchQueueLimit: LIMIT,
      broadcastSSE: (p) => sseCalls.push(p),
      getRtPublish: () => () => `task-${++taskCounter}`,
    });
    initWaveDispatcher(deps);

    // Fill queue to limit
    dispatchTask("crew-coder", "task one", "owner");
    dispatchTask("crew-coder", "task two", "owner");
    assert.equal(pendingDispatches.size, LIMIT);

    // This one should be rejected
    const result = dispatchTask("crew-coder", "task three — should be rejected", "owner");
    assert.equal(result, false, "dispatch past limit should return false");
    assert.equal(pendingDispatches.size, LIMIT, "queue size unchanged after rejection");

    const queueFullEvent = sseCalls.find((e) => e.type === "task.queue_full");
    assert.ok(queueFullEvent, "task.queue_full SSE event should be broadcast");
    assert.equal(queueFullEvent.agent, "crew-coder");
  });

  it("allows dispatch again after a task is marked done", () => {
    const LIMIT = 1;
    let taskCounter = 0;

    const deps = createMockDeps({
      dispatchQueueLimit: LIMIT,
      getRtPublish: () => () => `task-${++taskCounter}`,
    });
    initWaveDispatcher(deps);

    dispatchTask("crew-coder", "first task", "owner");
    assert.equal(pendingDispatches.size, 1);

    // Mark it done
    const [firstId] = pendingDispatches.keys();
    pendingDispatches.get(firstId).done = true;

    // Now queue has 0 active — should allow another dispatch
    const result = dispatchTask("crew-coder", "second task", "owner");
    assert.notEqual(result, false, "should dispatch after previous task marked done");
  });
});

describe("coordinator-dispatch: correlationId", () => {
  beforeEach(() => pendingDispatches.clear());
  afterEach(() => pendingDispatches.clear());

  it("auto-generates a correlationId for each dispatch", () => {
    let taskCounter = 0;
    const deps = createMockDeps({
      getRtPublish: () => () => `task-${++taskCounter}`,
    });
    initWaveDispatcher(deps);

    dispatchTask("crew-coder", "write hello", "owner");

    const [entry] = pendingDispatches.values();
    assert.ok(entry.correlationId, "correlationId should be set");
    assert.equal(typeof entry.correlationId, "string");
  });

  it("uses pipelineId as correlationId when provided in pipelineMeta", () => {
    let taskCounter = 0;
    const deps = createMockDeps({
      getRtPublish: () => () => `task-${++taskCounter}`,
    });
    initWaveDispatcher(deps);

    dispatchTask("crew-coder", "write hello", "owner", { pipelineId: "pipe-abc123" });

    const [entry] = pendingDispatches.values();
    assert.equal(entry.correlationId, "pipe-abc123");
  });

  it("prefers explicit correlationId over pipelineId in pipelineMeta", () => {
    let taskCounter = 0;
    const deps = createMockDeps({
      getRtPublish: () => () => `task-${++taskCounter}`,
    });
    initWaveDispatcher(deps);

    dispatchTask("crew-coder", "write hello", "owner", {
      pipelineId: "pipe-abc",
      correlationId: "corr-xyz",
    });

    const [entry] = pendingDispatches.values();
    assert.equal(entry.correlationId, "corr-xyz");
  });

  it("two dispatches get different auto-generated correlationIds", () => {
    let taskCounter = 0;
    const deps = createMockDeps({
      getRtPublish: () => () => `task-${++taskCounter}`,
    });
    initWaveDispatcher(deps);

    dispatchTask("crew-coder", "first", "owner");
    dispatchTask("crew-qa", "second", "owner");

    const ids = [...pendingDispatches.values()].map((e) => e.correlationId);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1], "each dispatch should get a unique correlationId");
  });

  it("correlationId is included in the RT payload", () => {
    const rtPayloads = [];
    const deps = createMockDeps({
      getRtPublish: () => (msg) => {
        rtPayloads.push(msg);
        return "task-rt-1";
      },
    });
    initWaveDispatcher(deps);

    dispatchTask("crew-coder", "write code", "owner", { correlationId: "corr-explicit" });

    assert.equal(rtPayloads.length, 1);
    assert.equal(rtPayloads[0].payload.correlationId, "corr-explicit");
  });
});
