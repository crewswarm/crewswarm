/**
 * Integration tests for pipeline crash recovery.
 *
 * Simulates crew-lead crash mid-pipeline by:
 *   1. Creating a pipeline with savePipelineState()
 *   2. Clearing in-memory state (simulating process death)
 *   3. Calling resumePipelines() (as startup would)
 *   4. Verifying pipeline resumes from correct wave
 *
 * Also tests: stale pipeline cleanup, retry counter preservation,
 * and dynamic key restoration.
 *
 * Run with: node --test test/integration/crash-recovery.test.mjs
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getStatePath, resetPaths } from "../../lib/runtime/paths.mjs";

import {
  initWaveDispatcher,
  savePipelineState,
  deletePipelineState,
  resumePipelines,
  dispatchPipelineWave,
  pendingDispatches,
  pendingPipelines,
} from "../../lib/crew-lead/wave-dispatcher.mjs";

function getPipelineStateDir() {
  return getStatePath("pipelines");
}

function createMockDeps(overrides = {}) {
  const broadcastSSE = (payload) => (broadcastSSE.calls = broadcastSSE.calls || []).push(payload);
  broadcastSSE.calls = [];
  const dispatched = [];
  return {
    broadcastSSE,
    appendHistory: () => {},
    isAgentOnRtBus: async () => false,
    getRtPublish: () => (channel, msg) => {
      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      dispatched.push({ channel, msg, taskId });
      return taskId;
    },
    loadConfig: () => ({}),
    resolveAgentId: (cfg, agent) => agent,
    buildTaskText: (t) => (typeof t === "string" ? t : t?.task ?? ""),
    emitTaskLifecycle: () => {},
    bumpOpsCounter: () => {},
    recordOpsEvent: () => {},
    tryRead: () => null,
    dispatchTimeoutMs: 100,
    dispatchClaimedTimeoutMs: 200,
    dispatchQueueLimit: 50,
    _dispatched: dispatched,
    ...overrides,
  };
}

describe("crash recovery — pipeline state persistence", () => {
  beforeEach(() => {
    process.env.CREWSWARM_TEST_MODE = "true";
    resetPaths();
    pendingDispatches.clear();
    pendingPipelines.clear();
  });

  afterEach(() => {
    pendingDispatches.clear();
    pendingPipelines.clear();
    try { fs.rmSync(path.join(os.tmpdir(), `crewswarm-test-${process.pid}`), { recursive: true, force: true }); } catch {}
    delete process.env.CREWSWARM_TEST_MODE;
    resetPaths();
  });

  it("saves and resumes a pipeline at the correct wave", () => {
    const deps = createMockDeps();
    initWaveDispatcher(deps);

    const pipelineId = `crash-test-${Date.now()}`;
    const pipeline = {
      sessionId: "owner",
      steps: [
        { agent: "crew-pm", task: "plan" },
        { agent: "crew-coder", task: "build" },
        { agent: "crew-qa", task: "test" },
      ],
      waves: [
        [{ agent: "crew-pm", task: "plan" }],
        [{ agent: "crew-coder", task: "build" }],
        [{ agent: "crew-qa", task: "test" }],
      ],
      currentWave: 1, // Mid-pipeline — wave 1 was in progress
      waveResults: [],
      completedWaveResults: [["Plan created: PDD.md"]],
      pendingTaskIds: new Set(["task-abc"]),
      projectDir: "/tmp/test-project",
    };
    pendingPipelines.set(pipelineId, pipeline);

    // Save state (simulating periodic save during execution)
    savePipelineState(pipelineId);

    // Verify file was written
    const stateFile = path.join(getPipelineStateDir(), `${pipelineId}.json`);
    assert.ok(fs.existsSync(stateFile));
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(saved.currentWave, 1);
    assert.equal(saved.status, "in_progress");
    assert.equal(saved.projectDir, "/tmp/test-project");

    // ── Simulate crash: clear all in-memory state ──
    pendingPipelines.clear();
    pendingDispatches.clear();

    // ── Simulate restart: resumePipelines() ──
    resumePipelines();
    assert.ok(pendingPipelines.has(pipelineId));

    const recovered = pendingPipelines.get(pipelineId);
    assert.equal(recovered.sessionId, "owner");
    assert.equal(recovered.currentWave, 1);
    assert.equal(recovered.waves.length, 3);
    assert.equal(recovered.projectDir, "/tmp/test-project");
  });

  it("preserves retry counters and dynamic keys across crash", () => {
    const deps = createMockDeps();
    initWaveDispatcher(deps);

    const pipelineId = `retry-crash-${Date.now()}`;
    const pipeline = {
      sessionId: "owner",
      steps: [{ agent: "crew-coder", task: "build" }],
      waves: [[{ agent: "crew-coder", task: "build" }]],
      currentWave: 0,
      waveResults: [],
      completedWaveResults: [],
      pendingTaskIds: new Set(),
      _retries_wave_0: 1,
      _qa_fix_retries_wave_0: 2,
      _customFlag: "preserved",
    };
    pendingPipelines.set(pipelineId, pipeline);
    savePipelineState(pipelineId);

    // Simulate crash + restart
    pendingPipelines.clear();
    resumePipelines();

    const recovered = pendingPipelines.get(pipelineId);
    assert.equal(recovered._retries_wave_0, 1, "retry counter should be preserved");
    assert.equal(recovered._qa_fix_retries_wave_0, 2, "QA fix retry counter should be preserved");
    assert.equal(recovered._customFlag, "preserved", "custom dynamic keys should be preserved");
  });

  it("drops stale pipelines older than 2 hours", () => {
    const deps = createMockDeps();
    initWaveDispatcher(deps);

    const pipelineId = `stale-${Date.now()}`;
    const pipeline = {
      sessionId: "owner",
      steps: [{ agent: "crew-coder", task: "build" }],
      waves: [[{ agent: "crew-coder", task: "build" }]],
      currentWave: 0,
      waveResults: [],
      completedWaveResults: [],
      pendingTaskIds: new Set(),
    };
    pendingPipelines.set(pipelineId, pipeline);
    savePipelineState(pipelineId);

    // Tamper with savedAt to make it 3 hours old
    const stateFile = path.join(getPipelineStateDir(), `${pipelineId}.json`);
    const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    raw.savedAt = Date.now() - 3 * 60 * 60 * 1000;
    fs.writeFileSync(stateFile, JSON.stringify(raw));

    // Simulate crash + restart
    pendingPipelines.clear();
    resumePipelines();

    assert.equal(pendingPipelines.size, 0, "stale pipeline should not be resumed");
    assert.ok(!pendingPipelines.has(pipelineId));
    assert.ok(!fs.existsSync(stateFile), "stale pipeline file should be deleted");
  });

  it("skips non-in_progress pipeline states", () => {
    const deps = createMockDeps();
    initWaveDispatcher(deps);

    const pipelineId = `done-${Date.now()}`;
    const pipeline = {
      sessionId: "owner",
      steps: [],
      waves: [[]],
      currentWave: 0,
      waveResults: [],
      completedWaveResults: [],
      pendingTaskIds: new Set(),
    };
    pendingPipelines.set(pipelineId, pipeline);
    savePipelineState(pipelineId);

    // Tamper with status
    const stateFile = path.join(getPipelineStateDir(), `${pipelineId}.json`);
    const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    raw.status = "completed";
    fs.writeFileSync(stateFile, JSON.stringify(raw));

    pendingPipelines.clear();
    resumePipelines();
    assert.equal(pendingPipelines.size, 0);
    assert.ok(!fs.existsSync(stateFile), "completed pipeline file should be cleaned up");
  });

  it("resumes multiple pipelines simultaneously", () => {
    const deps = createMockDeps();
    initWaveDispatcher(deps);

    for (let i = 0; i < 3; i++) {
      const pid = `multi-${i}-${Date.now()}`;
      pendingPipelines.set(pid, {
        sessionId: "owner",
        steps: [{ agent: "crew-coder", task: `task-${i}` }],
        waves: [[{ agent: "crew-coder", task: `task-${i}` }]],
        currentWave: 0,
        waveResults: [],
        completedWaveResults: [],
        pendingTaskIds: new Set(),
      });
      savePipelineState(pid);
    }

    pendingPipelines.clear();
    resumePipelines();
    assert.equal(pendingPipelines.size, 3);
  });

  it("handles corrupted pipeline state file gracefully", () => {
    const deps = createMockDeps();
    initWaveDispatcher(deps);

    // Write a valid pipeline
    const validPid = `valid-${Date.now()}`;
    pendingPipelines.set(validPid, {
      sessionId: "owner",
      steps: [{ agent: "crew-coder", task: "x" }],
      waves: [[{ agent: "crew-coder", task: "x" }]],
      currentWave: 0,
      waveResults: [],
      completedWaveResults: [],
      pendingTaskIds: new Set(),
    });
    savePipelineState(validPid);

    // Write a corrupted file alongside it
    const corruptFile = path.join(getPipelineStateDir(), "corrupt-pipeline.json");
    fs.writeFileSync(corruptFile, "{{{{not json");

    pendingPipelines.clear();
    // Should not throw — should skip corrupt file and resume valid one
    resumePipelines();
    assert.equal(pendingPipelines.size, 1);
    assert.ok(pendingPipelines.has(validPid));
  });

  it("deletePipelineState removes file on clean shutdown", () => {
    const deps = createMockDeps();
    initWaveDispatcher(deps);

    const pipelineId = `cleanup-${Date.now()}`;
    pendingPipelines.set(pipelineId, {
      sessionId: "owner",
      steps: [],
      waves: [[]],
      currentWave: 0,
      waveResults: [],
      completedWaveResults: [],
      pendingTaskIds: new Set(),
    });
    savePipelineState(pipelineId);
    const stateFile = path.join(getPipelineStateDir(), `${pipelineId}.json`);
    assert.ok(fs.existsSync(stateFile));

    deletePipelineState(pipelineId);
    assert.ok(!fs.existsSync(stateFile));
  });
});
