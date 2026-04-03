/**
 * Unit tests for checkWaveQualityGate() in wave-dispatcher.mjs
 *
 * Tests: question detection, planning agent file refs, PM PDD/ROADMAP check,
 * build agent file output, QA FAIL auto-fix, retry with feedback, halt on max retries,
 * cursor-wave combined output parsing.
 *
 * Run with: node --test test/unit/quality-gate.test.mjs
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resetPaths } from "../../lib/runtime/paths.mjs";

import {
  initWaveDispatcher,
  checkWaveQualityGate,
  pendingDispatches,
  pendingPipelines,
  dispatchTask,
} from "../../lib/crew-lead/wave-dispatcher.mjs";

function createMockDeps(overrides = {}) {
  const broadcastSSE = (payload) => (broadcastSSE.calls = broadcastSSE.calls || []).push(payload);
  broadcastSSE.calls = [];
  const appendHistory = (sid, role, msg) => (appendHistory.calls = appendHistory.calls || []).push({ sid, role, msg });
  appendHistory.calls = [];
  return {
    broadcastSSE,
    appendHistory,
    isAgentOnRtBus: async () => false,
    getRtPublish: () => () => `task-${Date.now()}`,
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
    ...overrides,
  };
}

function makePipeline(waveSteps, waveResults, extra = {}) {
  return {
    sessionId: "test-session",
    waves: [waveSteps, ...(extra.nextWaves || [])],
    currentWave: 0,
    waveResults,
    pendingTaskIds: new Set(),
    projectDir: extra.projectDir || "/tmp/test-project",
    ...extra,
  };
}

describe("checkWaveQualityGate", () => {
  beforeEach(() => {
    process.env.CREWSWARM_TEST_MODE = "true";
    delete process.env.CREWSWARM_PIPELINE_ADVANCE_ON_QUALITY_FAIL;
    resetPaths();
    pendingDispatches.clear();
    pendingPipelines.clear();
  });

  afterEach(() => {
    pendingDispatches.clear();
    pendingPipelines.clear();
    try { fs.rmSync(path.join(os.tmpdir(), `crewswarm-test-${process.pid}`), { recursive: true, force: true }); } catch {}
    delete process.env.CREWSWARM_TEST_MODE;
    delete process.env.CREWSWARM_PIPELINE_ADVANCE_ON_QUALITY_FAIL;
    resetPaths();
  });

  // ── PASS scenarios ──────────────────────────────────────────────────────

  it("passes when build agent wrote files via @@WRITE_FILE", () => {
    const deps = createMockDeps();
    initWaveDispatcher(deps);
    const pipeline = makePipeline(
      [{ agent: "crew-coder", task: "build it" }],
      ["@@WRITE_FILE /tmp/test-project/src/index.js\nconsole.log('hi');\n@@END_FILE"],
    );
    const result = checkWaveQualityGate(pipeline, "pipe-1");
    assert.equal(result.pass, true);
  });

  it("passes when build agent output contains 'wrote /path/to/file.js'", () => {
    const deps = createMockDeps();
    initWaveDispatcher(deps);
    const pipeline = makePipeline(
      [{ agent: "crew-coder", task: "build it" }],
      ["I wrote to /tmp/test-project/src/app.js with the new component."],
    );
    const result = checkWaveQualityGate(pipeline, "pipe-2");
    assert.equal(result.pass, true);
  });

  it("passes when non-build agent produces any output (no file check)", () => {
    const deps = createMockDeps();
    initWaveDispatcher(deps);
    const pipeline = makePipeline(
      [{ agent: "crew-security", task: "audit" }],
      ["Security audit complete. No critical issues found."],
    );
    const result = checkWaveQualityGate(pipeline, "pipe-3");
    assert.equal(result.pass, true);
  });

  it("passes for planning agent that includes file paths when builders follow", () => {
    const deps = createMockDeps();
    initWaveDispatcher(deps);
    const pipeline = makePipeline(
      [{ agent: "crew-pm", task: "plan" }],
      ["Here is the plan:\n- Create /src/components/Header.tsx\n- Update /src/App.tsx\n\nROADMAP.md has been updated."],
      { nextWaves: [[{ agent: "crew-coder", task: "build" }]] },
    );
    const result = checkWaveQualityGate(pipeline, "pipe-4");
    assert.equal(result.pass, true);
  });

  // ── Question detection ──────────────────────────────────────────────────

  it("flags agent that asked a question instead of producing output", () => {
    const deps = createMockDeps();
    initWaveDispatcher(deps);
    const pipeline = makePipeline(
      [{ agent: "crew-coder", task: "build it" }],
      ["Should I use React or Vue for this component? Which framework do you want me to use?"],
    );
    const result = checkWaveQualityGate(pipeline, "pipe-q1");
    assert.equal(result.pass, false);
    assert.ok(result.retried || result.halted);
  });

  it("does NOT flag question if agent also wrote files", () => {
    const deps = createMockDeps();
    initWaveDispatcher(deps);
    const pipeline = makePipeline(
      [{ agent: "crew-coder", task: "build" }],
      ["Should I add tests? Anyway, here's what I did:\n@@WRITE_FILE /src/app.js\nconsole.log('done');\n@@END_FILE"],
    );
    const result = checkWaveQualityGate(pipeline, "pipe-q2");
    assert.equal(result.pass, true);
  });

  // ── Planning agent checks ──────────────────────────────────────────────

  it("flags crew-pm when no PDD.md or ROADMAP.md mentioned and builders follow", () => {
    const deps = createMockDeps();
    initWaveDispatcher(deps);
    const pipeline = makePipeline(
      [{ agent: "crew-pm", task: "plan this project" }],
      ["I think we should build a dashboard with React. It will be great."],
      { nextWaves: [[{ agent: "crew-coder", task: "build" }]] },
    );
    const result = checkWaveQualityGate(pipeline, "pipe-pm1");
    assert.equal(result.pass, false);
  });

  it("passes crew-pm when PDD.md is mentioned and builders follow", () => {
    const deps = createMockDeps();
    initWaveDispatcher(deps);
    const pipeline = makePipeline(
      [{ agent: "crew-pm", task: "plan this" }],
      ["Created PDD.md with full spec. Files: /src/index.js, /src/api.js"],
      { nextWaves: [[{ agent: "crew-coder", task: "build" }]] },
    );
    const result = checkWaveQualityGate(pipeline, "pipe-pm2");
    assert.equal(result.pass, true);
  });

  it("does not check crew-pm for PDD when no builders in next wave", () => {
    const deps = createMockDeps();
    initWaveDispatcher(deps);
    const pipeline = makePipeline(
      [{ agent: "crew-pm", task: "plan" }],
      ["High-level plan: we need a dashboard."],
      // No next wave with builders
    );
    const result = checkWaveQualityGate(pipeline, "pipe-pm3");
    assert.equal(result.pass, true);
  });

  // ── Build agent file output ─────────────────────────────────────────────

  it("flags build agent that did not write any files", () => {
    const deps = createMockDeps();
    initWaveDispatcher(deps);
    const pipeline = makePipeline(
      [{ agent: "crew-coder", task: "implement the feature" }],
      ["I analyzed the codebase and here is my recommendation for the architecture."],
    );
    const result = checkWaveQualityGate(pipeline, "pipe-build1");
    assert.equal(result.pass, false);
  });

  it("passes build agent with cursor-style 'is in place at' output", () => {
    const deps = createMockDeps();
    initWaveDispatcher(deps);
    const pipeline = makePipeline(
      [{ agent: "crew-coder-front", task: "build UI" }],
      ["`src/components/Header.tsx` is in place at: /project/src/components/Header.tsx"],
    );
    const result = checkWaveQualityGate(pipeline, "pipe-build2");
    assert.equal(result.pass, true);
  });

  it("passes build agent with opencode-style output", () => {
    const deps = createMockDeps();
    initWaveDispatcher(deps);
    const pipeline = makePipeline(
      [{ agent: "crew-coder", task: "code it" }],
      ["← Write ../src/main.js\nWrote file successfully"],
    );
    const result = checkWaveQualityGate(pipeline, "pipe-build3");
    assert.equal(result.pass, true);
  });

  it("passes build agent with 'Done. Created' pattern", () => {
    const deps = createMockDeps();
    initWaveDispatcher(deps);
    const pipeline = makePipeline(
      [{ agent: "crew-coder", task: "code it" }],
      ["Done. Created the prototype with full routing and state management."],
    );
    const result = checkWaveQualityGate(pipeline, "pipe-build4");
    assert.equal(result.pass, true);
  });

  // ── QA FAIL auto-fix ───────────────────────────────────────────────────

  it("triggers auto-fix when QA agent returns verdict: FAIL", () => {
    const deps = createMockDeps();
    initWaveDispatcher(deps);
    const pipeline = makePipeline(
      [{ agent: "crew-qa", task: "audit the code" }],
      ["## QA Report\n\nverdict: FAIL\n\n### CRITICAL\n- SQL injection in auth.js line 42"],
    );
    pendingPipelines.set("pipe-qa1", pipeline);
    const result = checkWaveQualityGate(pipeline, "pipe-qa1");
    assert.equal(result.pass, false);
    assert.equal(result.qaAutoFix, true);
    // Should have inserted fixer + QA re-run waves
    assert.ok(pipeline.waves.length >= 3, "should insert fixer and QA re-run waves");
    assert.equal(pipeline.waves[1][0].agent, "crew-fixer");
  });

  it("triggers auto-fix when QA has 2+ CRITICAL issues", () => {
    const deps = createMockDeps();
    initWaveDispatcher(deps);
    const pipeline = makePipeline(
      [{ agent: "crew-qa", task: "audit" }],
      ["### CRITICAL\n- XSS in form.js\n### CRITICAL\n- Auth bypass in login.js"],
    );
    pendingPipelines.set("pipe-qa2", pipeline);
    const result = checkWaveQualityGate(pipeline, "pipe-qa2");
    assert.equal(result.pass, false);
    assert.equal(result.qaAutoFix, true);
  });

  it("stops auto-fix after MAX_QA_FIX_LOOPS (2)", () => {
    const deps = createMockDeps();
    initWaveDispatcher(deps);
    const pipeline = makePipeline(
      [{ agent: "crew-qa", task: "audit" }],
      ["verdict: FAIL\n### CRITICAL\n- still broken"],
    );
    pipeline[`_qa_fix_retries_wave_0`] = 2; // already at max
    pendingPipelines.set("pipe-qa3", pipeline);
    const result = checkWaveQualityGate(pipeline, "pipe-qa3");
    // Should NOT trigger qaAutoFix, falls through to normal quality gate
    assert.ok(!result.qaAutoFix);
  });

  // ── Retry with feedback ─────────────────────────────────────────────────

  it("retries wave with feedback on first failure (MAX_WAVE_RETRIES=1)", () => {
    const deps = createMockDeps();
    initWaveDispatcher(deps);
    const pipeline = makePipeline(
      [{ agent: "crew-coder", task: "build the feature" }],
      ["I'm not sure what to do. Can you clarify the requirements?"],
    );
    pendingPipelines.set("pipe-retry1", pipeline);
    const result = checkWaveQualityGate(pipeline, "pipe-retry1");
    assert.equal(result.pass, false);
    assert.equal(result.retried, true);
    // Task should have feedback appended
    assert.ok(pipeline.waves[0][0].task.includes("[Quality gate feedback"));
  });

  // ── Halt after max retries ──────────────────────────────────────────────

  it("halts pipeline after retries exhausted (no advance env)", () => {
    const deps = createMockDeps();
    initWaveDispatcher(deps);
    const pipeline = makePipeline(
      [{ agent: "crew-coder", task: "build it" }],
      ["I need more context. What framework should I use?"],
    );
    pipeline[`_retries_wave_0`] = 1; // already retried once
    pendingPipelines.set("pipe-halt1", pipeline);
    const result = checkWaveQualityGate(pipeline, "pipe-halt1");
    assert.equal(result.pass, false);
    assert.equal(result.halted, true);
    assert.ok(Array.isArray(result.issues));
    assert.ok(result.issues.length > 0);
  });

  it("advances anyway when CREWSWARM_PIPELINE_ADVANCE_ON_QUALITY_FAIL=1", () => {
    process.env.CREWSWARM_PIPELINE_ADVANCE_ON_QUALITY_FAIL = "1";
    const deps = createMockDeps();
    initWaveDispatcher(deps);
    const pipeline = makePipeline(
      [{ agent: "crew-coder", task: "build" }],
      ["I'm confused, should I use Python or Node?"],
    );
    pipeline[`_retries_wave_0`] = 1; // already retried once
    const result = checkWaveQualityGate(pipeline, "pipe-advance1");
    assert.equal(result.pass, true, "should pass when advance env is set");
  });

  // ── Cursor wave combined output parsing ─────────────────────────────────

  it("parses per-agent sections from cursor wave combined output", () => {
    const deps = createMockDeps();
    initWaveDispatcher(deps);
    const combinedResult = `=== WAVE 1 RESULTS ===
[crew-coder]: @@WRITE_FILE /src/app.js
console.log('hello');
@@END_FILE

[crew-qa]: All tests passing. No issues found.
=== END WAVE ===`;
    const pipeline = makePipeline(
      [
        { agent: "crew-coder", task: "code" },
        { agent: "crew-qa", task: "test" },
      ],
      [combinedResult], // Single combined result for multiple steps
    );
    const result = checkWaveQualityGate(pipeline, "pipe-cursor1");
    assert.equal(result.pass, true);
  });

  it("flags issue in cursor wave when one agent didn't write files", () => {
    const deps = createMockDeps();
    initWaveDispatcher(deps);
    const combinedResult = `=== WAVE 1 RESULTS ===
[crew-coder]: I think we should restructure the codebase first.

[crew-coder-front]: @@WRITE_FILE /src/ui.jsx
export default () => <div>Hello</div>;
@@END_FILE
=== END WAVE ===`;
    const pipeline = makePipeline(
      [
        { agent: "crew-coder", task: "backend" },
        { agent: "crew-coder-front", task: "frontend" },
      ],
      [combinedResult],
    );
    const result = checkWaveQualityGate(pipeline, "pipe-cursor2");
    assert.equal(result.pass, false);
    // crew-coder should be flagged for not writing files
    assert.ok(result.retried || result.halted);
  });

  // ── SSE broadcasts ──────────────────────────────────────────────────────

  it("broadcasts pipeline_quality_gate SSE on issues", () => {
    const deps = createMockDeps();
    initWaveDispatcher(deps);
    const pipeline = makePipeline(
      [{ agent: "crew-coder", task: "build" }],
      ["What should I build?"],
    );
    pendingPipelines.set("pipe-sse1", pipeline);
    checkWaveQualityGate(pipeline, "pipe-sse1");
    assert.ok(deps.broadcastSSE.calls.some(c => c.type === "pipeline_quality_gate"));
  });

  it("broadcasts pipeline_qa_fail_autofix SSE on QA FAIL", () => {
    const deps = createMockDeps();
    initWaveDispatcher(deps);
    const pipeline = makePipeline(
      [{ agent: "crew-qa", task: "audit" }],
      ["verdict: FAIL\n### CRITICAL\n- broken"],
    );
    pendingPipelines.set("pipe-sse2", pipeline);
    checkWaveQualityGate(pipeline, "pipe-sse2");
    assert.ok(deps.broadcastSSE.calls.some(c => c.type === "pipeline_qa_fail_autofix"));
  });

  // ── Multi-step waves ────────────────────────────────────────────────────

  it("passes multi-step wave where all agents produce valid output", () => {
    const deps = createMockDeps();
    initWaveDispatcher(deps);
    const pipeline = makePipeline(
      [
        { agent: "crew-coder", task: "backend" },
        { agent: "crew-coder-front", task: "frontend" },
      ],
      [
        "@@WRITE_FILE /src/api.js\nmodule.exports = {};\n@@END_FILE",
        "@@WRITE_FILE /src/ui.jsx\nexport default () => null;\n@@END_FILE",
      ],
    );
    const result = checkWaveQualityGate(pipeline, "pipe-multi1");
    assert.equal(result.pass, true);
  });

  it("flags only the failing agent in a multi-step wave", () => {
    const deps = createMockDeps();
    initWaveDispatcher(deps);
    const pipeline = makePipeline(
      [
        { agent: "crew-coder", task: "backend" },
        { agent: "crew-coder-front", task: "frontend" },
      ],
      [
        "@@WRITE_FILE /src/api.js\nmodule.exports = {};\n@@END_FILE",
        "I looked at the codebase and I'm not sure what UI framework to use.",
      ],
    );
    pendingPipelines.set("pipe-multi2", pipeline);
    const result = checkWaveQualityGate(pipeline, "pipe-multi2");
    assert.equal(result.pass, false);
  });
});
