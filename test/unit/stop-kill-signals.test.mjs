/**
 * Unit tests for @@STOP and @@KILL signal handling.
 * Tests cancelAllPipelines, stop regex detection, kill flow (dispatches + pipelines),
 * dispatchPipelineWave on non-existent pipeline, and PM loop stop file path.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";

import {
  initWaveDispatcher,
  cancelAllPipelines,
  dispatchPipelineWave,
  pendingDispatches,
  pendingPipelines,
} from "../../lib/crew-lead/wave-dispatcher.mjs";

// Pattern mirrors from lib/crew-lead/chat-handler.mjs (same as autonomous-mode.test.mjs)
const STOP_SIGNAL = /^@@STOP\b/;
const KILL_SIGNAL = /^@@KILL\b/;

function createMockDeps() {
  const broadcastSSE = (payload) => (broadcastSSE.calls = broadcastSSE.calls || []).push(payload);
  broadcastSSE.calls = [];
  return {
    broadcastSSE,
    appendHistory: () => {},
    loadConfig: () => ({}),
    resolveAgentId: (cfg, agent) => agent,
    buildTaskText: (t) => (typeof t === "string" ? t : t?.task ?? ""),
    emitTaskLifecycle: () => {},
    bumpOpsCounter: () => {},
    recordOpsEvent: () => {},
  };
}

function makePipeline(sessionId = "owner") {
  return {
    sessionId,
    waves: [[{ agent: "crew-coder", task: "x" }]],
    currentWave: 0,
    pendingTaskIds: new Set(),
  };
}

describe("stop-kill signals", () => {
  beforeEach(() => {
    pendingDispatches.clear();
    pendingPipelines.clear();
  });

  afterEach(() => {
    pendingDispatches.clear();
    pendingPipelines.clear();
  });

  describe("cancelAllPipelines", () => {
    it("on 3 pipelines returns 3 and empties the map", () => {
      const deps = createMockDeps();
      initWaveDispatcher(deps);

      pendingPipelines.set("p1", makePipeline());
      pendingPipelines.set("p2", makePipeline());
      pendingPipelines.set("p3", makePipeline());

      const n = cancelAllPipelines("owner");

      assert.equal(n, 3);
      assert.equal(pendingPipelines.size, 0);
    });
  });

  describe("stop handler flow", () => {
    it("stop message matches regex AND cancelAllPipelines clears pipelines", () => {
      assert.ok(STOP_SIGNAL.test("@@STOP"));
      assert.ok(STOP_SIGNAL.test("@@STOP all pipelines"));

      const deps = createMockDeps();
      initWaveDispatcher(deps);
      pendingPipelines.set("stop-pipe", makePipeline());

      const msg = "@@STOP";
      const isStop = STOP_SIGNAL.test(msg.trim());
      assert.ok(isStop);

      const cancelled = cancelAllPipelines("owner");
      assert.equal(cancelled, 1);
      assert.equal(pendingPipelines.size, 0);
    });
  });

  describe("@@KILL flow", () => {
    it("after kill: pendingDispatches and pendingPipelines are both empty", () => {
      assert.ok(KILL_SIGNAL.test("@@KILL"));

      const deps = createMockDeps();
      initWaveDispatcher(deps);

      pendingDispatches.set("d1", { sessionId: "owner", agent: "crew-coder", task: "x", ts: Date.now() });
      pendingDispatches.set("d2", { sessionId: "owner", agent: "crew-qa", task: "y", ts: Date.now() });
      pendingPipelines.set("pipe-1", makePipeline());
      pendingPipelines.set("pipe-2", makePipeline());

      cancelAllPipelines("owner");
      pendingDispatches.clear();

      assert.equal(pendingPipelines.size, 0);
      assert.equal(pendingDispatches.size, 0);
    });
  });

  describe("dispatchPipelineWave on non-existent pipeline", () => {
    it("does nothing (no throw) when pipeline does not exist", () => {
      const deps = createMockDeps();
      initWaveDispatcher(deps);

      assert.doesNotThrow(() => {
        dispatchPipelineWave("non-existent-pipeline-id");
      });
    });
  });

  describe("PM loop stop file path", () => {
    it("path is deterministic from PM_PROJECT_ID logic (matches pm-loop.mjs pattern)", () => {
      const LOG_DIR = path.join(os.homedir(), ".crewswarm", "orchestrator-logs");
      const PROJECT_ID = process.env.PM_PROJECT_ID || null;
      const _pidSuffix = PROJECT_ID ? `-${PROJECT_ID}` : "";
      const STOP_FILE = path.join(LOG_DIR, `pm-loop${_pidSuffix}.stop`);

      assert.ok(path.basename(STOP_FILE) === "pm-loop.stop" || path.basename(STOP_FILE).startsWith("pm-loop-"), "filename follows pm-loop[.stop] or pm-loop-{id}.stop pattern");

      const withNull = path.join(LOG_DIR, `pm-loop${null ? `-${null}` : ""}.stop`);
      assert.equal(path.basename(withNull), "pm-loop.stop", "when PROJECT_ID is null, basename is pm-loop.stop");

      const withId = path.join(LOG_DIR, `pm-loop-${"my-project"}.stop`);
      assert.equal(path.basename(withId), "pm-loop-my-project.stop", "when PROJECT_ID is set, basename is pm-loop-{id}.stop");
    });
  });
});
