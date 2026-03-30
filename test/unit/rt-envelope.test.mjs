/**
 * Unit tests for lib/engines/rt-envelope.mjs
 *
 * Tests the exported functions: initRtEnvelope, handleRealtimeEnvelope.
 * All dependencies are mocked — no network calls, no file I/O.
 *
 * Run with: node --test test/unit/rt-envelope.test.mjs
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { initRtEnvelope, handleRealtimeEnvelope } from "../../lib/engines/rt-envelope.mjs";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeMockClient() {
  const calls = { ack: [], publish: [] };
  return {
    calls,
    ack(msg) { calls.ack.push(msg); },
    publish(msg) { calls.publish.push(msg); },
  };
}

function makeDeps(overrides = {}) {
  return {
    CREWSWARM_RT_AGENT: "crew-coder",
    CREWSWARM_RT_COMMAND_TYPES: new Set([
      "task", "command.spawn_agent", "command.collect_status",
      "cmd.approved", "cmd.rejected", "command.run_task",
    ]),
    pendingCmdApprovals: new Map(),
    resolveSpawnTargets: (payload) => payload?.agents || [],
    spawnAgentDaemon: (agent) => ({ agent, spawned: true }),
    isAgentDaemonRunning: () => false,
    readPid: () => null,
    dispatchKeyForTask: () => "key",
    shouldUseDispatchGuard: () => false,
    acquireTaskLease: async () => true,
    renewTaskLease: async () => {},
    releaseTaskLease: async () => {},
    markTaskDone: async () => {},
    telemetry: { recordTask: () => {} },
    buildTaskPrompt: async () => "prompt",
    getOpencodeProjectDir: () => "/tmp",
    assertTaskPromptProtocol: () => {},
    selectEngine: () => ({ engine: "mock", label: "mock" }),
    runGenericEngineTask: async () => ({ reply: "ok" }),
    loadGenericEngines: async () => [],
    progress: { update: () => {}, done: () => {} },
    getAgentOpenCodeConfig: () => ({}),
    buildMiniTaskForOpenCode: () => "",
    runOuroborosStyleLoop: async () => ({ reply: "ok" }),
    runCursorCliTask: async () => ({ reply: "ok" }),
    runClaudeCodeTask: async () => ({ reply: "ok" }),
    runCodexTask: async () => ({ reply: "ok" }),
    runDockerSandboxTask: async () => ({ reply: "ok" }),
    runGeminiCliTask: async () => ({ reply: "ok" }),
    runCrewCLITask: async () => ({ reply: "ok" }),
    runOpenCodeTask: async () => ({ reply: "ok" }),
    callLLMDirect: async () => "reply",
    extractProjectDirFromTask: () => "/tmp",
    loadAgentPrompts: async () => ({ system: "", user: "" }),
    stripThink: (s) => s,
    executeToolCalls: async () => [],
    validateCodingArtifacts: async () => ({ valid: true }),
    isCodingTask: () => false,
    shouldRetryTaskFailure: () => false,
    CREWSWARM_RT_DISPATCH_LEASE_MS: 60000,
    CREWSWARM_RT_DISPATCH_HEARTBEAT_MS: 10000,
    CREWSWARM_RT_DISPATCH_MAX_RETRIES: 3,
    CREWSWARM_RT_DISPATCH_MAX_RETRIES_CODING: 5,
    CREWSWARM_RT_DISPATCH_RETRY_BACKOFF_MS: 1000,
    CREWSWARM_OPENCODE_AGENT: "crew-coder",
    CREWSWARM_OPENCODE_MODEL: "gpt-4",
    OPENCODE_FREE_MODEL_CHAIN: [],
    RT_TO_GATEWAY_AGENT_MAP: {},
    SHARED_MEMORY_DIR: "/tmp/shared-memory",
    SWARM_DLQ_DIR: "/tmp/dlq",
    COORDINATOR_AGENT_IDS: new Set(["crew-lead"]),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("rt-envelope", () => {
  beforeEach(() => {
    initRtEnvelope(makeDeps());
  });

  describe("initRtEnvelope", () => {
    it("accepts deps without throwing", () => {
      assert.doesNotThrow(() => initRtEnvelope(makeDeps()));
    });
  });

  describe("handleRealtimeEnvelope — routing guard", () => {
    it("skips envelopes addressed to a different agent", async () => {
      const client = makeMockClient();
      await handleRealtimeEnvelope(
        { id: "msg-1", type: "task", to: "crew-qa", payload: {} },
        client,
        null,
      );
      assert.equal(client.calls.ack.length, 1);
      assert.equal(client.calls.ack[0].status, "skipped");
      assert.ok(client.calls.ack[0].note.includes("not for us"));
    });

    it("processes envelopes addressed to broadcast", async () => {
      const client = makeMockClient();
      // "task" is in CREWSWARM_RT_COMMAND_TYPES, addressed to broadcast
      // This will proceed past the routing guard (may fail later, but not skip)
      await handleRealtimeEnvelope(
        { id: "msg-2", type: "task", to: "broadcast", payload: { prompt: "hello" } },
        client,
        null,
      );
      // Should NOT have "skipped" with "not for us"
      const skipForUs = client.calls.ack.filter(
        (a) => a.status === "skipped" && a.note?.includes("not for us"),
      );
      assert.equal(skipForUs.length, 0);
    });

    it("processes envelopes addressed to our agent", async () => {
      const client = makeMockClient();
      await handleRealtimeEnvelope(
        { id: "msg-3", type: "task", to: "crew-coder", payload: { prompt: "hello" } },
        client,
        null,
      );
      const skipForUs = client.calls.ack.filter(
        (a) => a.status === "skipped" && a.note?.includes("not for us"),
      );
      assert.equal(skipForUs.length, 0);
    });
  });

  describe("handleRealtimeEnvelope — unsupported type", () => {
    it("skips envelopes with an unsupported type", async () => {
      const client = makeMockClient();
      await handleRealtimeEnvelope(
        { id: "msg-4", type: "unknown.type", to: "broadcast", payload: {} },
        client,
        null,
      );
      assert.equal(client.calls.ack.length, 1);
      assert.equal(client.calls.ack[0].status, "skipped");
      assert.ok(client.calls.ack[0].note.includes("unsupported type"));
    });
  });

  describe("handleRealtimeEnvelope — cmd approval", () => {
    it("resolves a pending approval on cmd.approved", async () => {
      let resolved = null;
      const pendingCmdApprovals = new Map();
      pendingCmdApprovals.set("approval-1", {
        resolve: (v) => { resolved = v; },
        timer: setTimeout(() => {}, 60000),
      });
      initRtEnvelope(makeDeps({ pendingCmdApprovals }));

      const client = makeMockClient();
      await handleRealtimeEnvelope(
        {
          id: "msg-5",
          type: "cmd.approved",
          to: "broadcast",
          payload: { approvalId: "approval-1" },
        },
        client,
        null,
      );

      assert.equal(resolved, true, "approval should resolve with true");
      assert.equal(pendingCmdApprovals.size, 0, "pending map should be cleared");
    });

    it("resolves a pending approval on cmd.rejected with false", async () => {
      let resolved = null;
      const pendingCmdApprovals = new Map();
      pendingCmdApprovals.set("approval-2", {
        resolve: (v) => { resolved = v; },
        timer: setTimeout(() => {}, 60000),
      });
      initRtEnvelope(makeDeps({ pendingCmdApprovals }));

      const client = makeMockClient();
      await handleRealtimeEnvelope(
        {
          id: "msg-6",
          type: "cmd.rejected",
          to: "broadcast",
          payload: { approvalId: "approval-2" },
        },
        client,
        null,
      );

      assert.equal(resolved, false, "rejection should resolve with false");
    });
  });

  describe("handleRealtimeEnvelope — spawn agent", () => {
    it("spawns agents and publishes results", async () => {
      const spawned = [];
      initRtEnvelope(
        makeDeps({
          resolveSpawnTargets: () => ["crew-qa", "crew-fixer"],
          spawnAgentDaemon: (agent) => { spawned.push(agent); return { agent, ok: true }; },
        }),
      );

      const client = makeMockClient();
      await handleRealtimeEnvelope(
        {
          id: "msg-7",
          type: "command.spawn_agent",
          from: "crew-lead",
          to: "broadcast",
          payload: {},
        },
        client,
        null,
      );

      assert.deepEqual(spawned, ["crew-qa", "crew-fixer"]);
      assert.equal(client.calls.publish.length, 1);
      assert.equal(client.calls.publish[0].type, "task.done");
      assert.equal(client.calls.publish[0].payload.action, "spawn_agent");
      assert.equal(client.calls.ack[0].status, "done");
    });
  });

  describe("handleRealtimeEnvelope — collect status", () => {
    it("collects status for requested agents", async () => {
      initRtEnvelope(
        makeDeps({
          resolveSpawnTargets: () => ["crew-qa"],
          isAgentDaemonRunning: (a) => a === "crew-qa",
          readPid: (a) => (a === "crew-qa" ? 12345 : null),
        }),
      );

      const client = makeMockClient();
      await handleRealtimeEnvelope(
        {
          id: "msg-8",
          type: "command.collect_status",
          from: "crew-lead",
          to: "broadcast",
          payload: {},
        },
        client,
        null,
      );

      assert.equal(client.calls.publish.length, 1);
      const status = client.calls.publish[0].payload.status;
      assert.equal(status.length, 1);
      assert.equal(status[0].agent, "crew-qa");
      assert.equal(status[0].running, true);
      assert.equal(status[0].pid, 12345);
    });
  });

  describe("handleRealtimeEnvelope — unsupported command action", () => {
    it("rejects unknown command actions", async () => {
      const client = makeMockClient();
      await handleRealtimeEnvelope(
        {
          id: "msg-9",
          type: "command.custom_stuff",
          to: "broadcast",
          payload: { action: "custom_stuff" },
        },
        client,
        null,
      );

      // "command.custom_stuff" is not in CREWSWARM_RT_COMMAND_TYPES → skip as unsupported type
      assert.equal(client.calls.ack.length, 1);
      assert.equal(client.calls.ack[0].status, "skipped");
    });
  });

  describe("handleRealtimeEnvelope — null/missing fields", () => {
    it("handles null envelope gracefully by throwing", async () => {
      const client = makeMockClient();
      // null envelope causes a TypeError when accessing envelope.id — this is expected
      // because the function assumes a valid envelope object
      await assert.rejects(
        () => handleRealtimeEnvelope(null, client, null),
        TypeError,
      );
    });

    it("handles empty object envelope", async () => {
      const client = makeMockClient();
      await handleRealtimeEnvelope({}, client, null);
      assert.equal(client.calls.ack.length, 1);
      assert.equal(client.calls.ack[0].status, "skipped");
    });

    it("handles envelope with payload but no type", async () => {
      const client = makeMockClient();
      await handleRealtimeEnvelope({ payload: { prompt: "test" } }, client, null);
      // type defaults to "event" → unsupported
      assert.equal(client.calls.ack[0].status, "skipped");
    });
  });
});
