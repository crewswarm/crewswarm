/**
 * Unit tests for wave-dispatcher.mjs — dispatchTask, cancelAllPipelines,
 * checkDispatchTimeouts, savePipelineState, deletePipelineState, markDispatchClaimed.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  initWaveDispatcher,
  dispatchTask,
  cancelAllPipelines,
  checkDispatchTimeouts,
  savePipelineState,
  deletePipelineState,
  markDispatchClaimed,
  dispatchPipelineWave,
  pendingDispatches,
  pendingPipelines,
} from "../../lib/crew-lead/wave-dispatcher.mjs";

const PIPELINE_STATE_DIR = path.join(os.homedir(), ".crewswarm", "pipelines");

function createMockDeps(overrides = {}) {
  const broadcastSSE = (payload) => (broadcastSSE.calls = broadcastSSE.calls || []).push(payload);
  broadcastSSE.calls = [];
  return {
    broadcastSSE,
    appendHistory: () => {},
    isAgentOnRtBus: async () => false,
    getRtPublish: () => null,
    loadConfig: () => ({}),
    resolveAgentId: (cfg, agent) => agent,
    buildTaskText: (task) => (typeof task === "string" ? task : task?.task ?? ""),
    emitTaskLifecycle: () => {},
    bumpOpsCounter: () => {},
    recordOpsEvent: () => {},
    dispatchTimeoutMs: 100,
    dispatchClaimedTimeoutMs: 200,
    ...overrides,
  };
}

describe("wave-dispatcher", () => {
  beforeEach(() => {
    pendingDispatches.clear();
    pendingPipelines.clear();
  });

  afterEach(() => {
    pendingDispatches.clear();
    pendingPipelines.clear();
  });

  describe("dispatchTask", () => {
    it("dispatches task via RT publish, returns taskId, adds to pendingDispatches", () => {
      const taskId = "task-123";
      const mockPublish = () => taskId;
      const deps = createMockDeps({
        getRtPublish: () => mockPublish,
      });
      initWaveDispatcher(deps);

      const result = dispatchTask("crew-coder", "write a hello world", "owner");

      assert.equal(result, taskId);
      assert.ok(pendingDispatches.has(taskId));
      const d = pendingDispatches.get(taskId);
      assert.equal(d.agent, "crew-coder");
      assert.equal(d.sessionId, "owner");
      assert.equal(d.task, "write a hello world");
    });

    it("falls back gracefully when getRtPublish returns null (no throw)", () => {
      const deps = createMockDeps({ getRtPublish: () => null });
      initWaveDispatcher(deps);

      assert.doesNotThrow(() => {
        const result = dispatchTask("crew-coder", "write hello", "owner");
        assert.ok(result === true || result === false, "returns boolean when no RT");
      });
    });

    it("normalizes task string from object via buildTaskText", () => {
      const taskId = "task-456";
      const deps = createMockDeps({
        getRtPublish: () => () => taskId,
        buildTaskText: (t) => (typeof t === "string" ? t : t?.task ?? ""),
      });
      initWaveDispatcher(deps);

      const result = dispatchTask("crew-coder", { task: "write hello from object" }, "owner");

      assert.equal(result, taskId);
      assert.equal(pendingDispatches.get(taskId).task, "write hello from object");
    });
  });

  describe("cancelAllPipelines", () => {
    it("cancels 2 pipelines, returns 2, clears map, calls broadcastSSE with pipeline_cancelled", () => {
      const deps = createMockDeps();
      initWaveDispatcher(deps);

      const p1 = {
        sessionId: "owner",
        waves: [[{ agent: "crew-coder", task: "x" }]],
        currentWave: 0,
        pendingTaskIds: new Set(),
      };
      const p2 = {
        sessionId: "owner",
        waves: [[{ agent: "crew-qa", task: "y" }]],
        currentWave: 0,
        pendingTaskIds: new Set(),
      };
      pendingPipelines.set("pipe-1", p1);
      pendingPipelines.set("pipe-2", p2);

      const n = cancelAllPipelines("owner");

      assert.equal(n, 2);
      assert.equal(pendingPipelines.size, 0);
      assert.equal(deps.broadcastSSE.calls.length, 2);
      assert.ok(deps.broadcastSSE.calls.every((c) => c.type === "pipeline_cancelled"));
    });

    it("returns 0 when map is empty", () => {
      const deps = createMockDeps();
      initWaveDispatcher(deps);

      const n = cancelAllPipelines("owner");

      assert.equal(n, 0);
    });
  });

  describe("checkDispatchTimeouts", () => {
    it("removes stale dispatch with _autoExtended, calls broadcastSSE with task.timeout", () => {
      const deps = createMockDeps();
      initWaveDispatcher(deps);

      const taskId = "stale-task";
      pendingDispatches.set(taskId, {
        sessionId: "owner",
        agent: "crew-coder",
        task: "x",
        ts: Date.now() - 99999,
        _autoExtended: true,
      });

      checkDispatchTimeouts();

      assert.ok(!pendingDispatches.has(taskId));
      assert.ok(deps.broadcastSSE.calls.some((c) => c.type === "task.timeout"));
    });

    it("does NOT remove fresh dispatch", () => {
      const deps = createMockDeps();
      initWaveDispatcher(deps);

      const taskId = "fresh-task";
      pendingDispatches.set(taskId, {
        sessionId: "owner",
        agent: "crew-coder",
        task: "x",
        ts: Date.now(),
      });

      checkDispatchTimeouts();

      assert.ok(pendingDispatches.has(taskId));
    });
  });

  describe("savePipelineState / deletePipelineState", () => {
    it("savePipelineState writes JSON file to pipelines dir", () => {
      const deps = createMockDeps();
      initWaveDispatcher(deps);

      const pipelineId = `test-pipeline-${Date.now()}`;
      pendingPipelines.set(pipelineId, {
        sessionId: "owner",
        steps: [{ agent: "crew-coder", task: "x" }],
        waves: [[{ agent: "crew-coder", task: "x" }]],
        currentWave: 0,
        completedWaveResults: [],
      });

      savePipelineState(pipelineId);

      const filePath = path.join(PIPELINE_STATE_DIR, `${pipelineId}.json`);
      assert.ok(fs.existsSync(filePath));
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      assert.equal(raw.pipelineId, pipelineId);
      assert.equal(raw.currentWave, 0);
      assert.equal(raw.status, "in_progress");

      deletePipelineState(pipelineId);
      assert.ok(!fs.existsSync(filePath));
    });

    it("deletePipelineState removes the file", () => {
      const deps = createMockDeps();
      initWaveDispatcher(deps);

      const pipelineId = `test-delete-${Date.now()}`;
      pendingPipelines.set(pipelineId, {
        sessionId: "owner",
        steps: [],
        waves: [[]],
        currentWave: 0,
        completedWaveResults: [],
      });
      savePipelineState(pipelineId);
      assert.ok(fs.existsSync(path.join(PIPELINE_STATE_DIR, `${pipelineId}.json`)));

      deletePipelineState(pipelineId);
      assert.ok(!fs.existsSync(path.join(PIPELINE_STATE_DIR, `${pipelineId}.json`)));
    });
  });

  describe("markDispatchClaimed", () => {
    it("sets claimed=true and claimedAt on unclaimed dispatch", () => {
      const deps = createMockDeps();
      initWaveDispatcher(deps);

      const taskId = "claim-me";
      const d = {
        sessionId: "owner",
        agent: "crew-coder",
        task: "x",
        ts: Date.now(),
      };
      pendingDispatches.set(taskId, d);

      markDispatchClaimed(taskId, "crew-coder");

      assert.equal(d.claimed, true);
      assert.ok(typeof d.claimedAt === "number");
      assert.ok(d.claimedAt >= d.ts);
    });
  });
});
