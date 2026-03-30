/**
 * Unit tests for lib/autoharness/index.mjs
 *
 * Covers:
 *  - extractToolActions: parse @@WRITE_FILE, @@APPEND_FILE, @@READ_FILE, @@MKDIR, @@RUN_CMD
 *  - evaluateHarnessAction: allowed/blocked logic based on harness rules
 *  - synthesizeHarness: generate rules from tool traces
 *  - scoreHarness: precision/recall statistics
 *  - recordTaskTrace / recordToolTrace: JSONL append
 *  - getAutoHarnessPaths: path structure
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Force NODE_ENV=test OFF so autoharness is not disabled during tests.
// The module checks NODE_ENV==="test" to disable itself.
const origNodeEnv = process.env.NODE_ENV;
delete process.env.NODE_ENV;

// Redirect autoharness root to a temp directory
const TEST_ROOT = path.join(os.tmpdir(), `crewswarm-autoharness-test-${process.pid}-${Date.now()}`);
fs.mkdirSync(TEST_ROOT, { recursive: true });

// Patch getStatePath so resolveAutoHarnessRoot uses our temp dir
process.env.CREWSWARM_STATE_DIR = TEST_ROOT;

const {
  extractToolActions,
  getAutoHarnessPaths,
  recordToolTrace,
  recordTaskTrace,
  evaluateHarnessAction,
  synthesizeHarness,
  scoreHarness,
  loadHarness,
} = await import("../../lib/autoharness/index.mjs");

after(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  if (origNodeEnv !== undefined) process.env.NODE_ENV = origNodeEnv;
});

// ── extractToolActions ──────────────────────────────────────────────────────

describe("autoharness — extractToolActions", () => {
  it("extracts @@WRITE_FILE actions", () => {
    const reply = `@@WRITE_FILE src/main.js\nconsole.log("hello");\n@@END_FILE`;
    const actions = extractToolActions(reply);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].tool, "write_file");
    assert.equal(actions[0].target, "src/main.js");
    assert.equal(actions[0].bytes, 'console.log("hello");\n'.length);
  });

  it("extracts @@APPEND_FILE actions", () => {
    const reply = `@@APPEND_FILE log.txt\nentry 1\n@@END_FILE`;
    const actions = extractToolActions(reply);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].tool, "append_file");
    assert.equal(actions[0].target, "log.txt");
  });

  it("extracts @@READ_FILE actions", () => {
    const reply = `@@READ_FILE src/config.json`;
    const actions = extractToolActions(reply);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].tool, "read_file");
    assert.equal(actions[0].target, "src/config.json");
  });

  it("extracts @@MKDIR actions", () => {
    const reply = `@@MKDIR src/utils`;
    const actions = extractToolActions(reply);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].tool, "mkdir");
    assert.equal(actions[0].target, "src/utils");
  });

  it("extracts @@RUN_CMD actions with commandPrefix", () => {
    const reply = `@@RUN_CMD npm install express`;
    const actions = extractToolActions(reply);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].tool, "run_cmd");
    assert.equal(actions[0].command, "npm install express");
    assert.equal(actions[0].commandPrefix, "npm install");
  });

  it("extracts multiple actions from mixed reply", () => {
    const reply = [
      "@@WRITE_FILE a.js\ncode\n@@END_FILE",
      "@@READ_FILE b.js",
      "@@RUN_CMD echo hello",
    ].join("\n");
    const actions = extractToolActions(reply);
    assert.equal(actions.length, 3);
  });

  it("returns empty array for empty string", () => {
    assert.deepEqual(extractToolActions(""), []);
    assert.deepEqual(extractToolActions(null), []);
    assert.deepEqual(extractToolActions(undefined), []);
  });
});

// ── getAutoHarnessPaths ─────────────────────────────────────────────────────

describe("autoharness — getAutoHarnessPaths", () => {
  it("returns path structure for valid agentId", () => {
    const paths = getAutoHarnessPaths("crew-coder");
    assert.ok(paths, "should not be null");
    assert.ok(paths.rootDir);
    assert.ok(paths.rulesDir);
    assert.ok(paths.tracesDir);
    assert.ok(paths.rulesFile.endsWith(".json"));
    assert.ok(paths.taskTraceFile.endsWith(".jsonl"));
    assert.ok(paths.toolTraceFile.endsWith(".jsonl"));
  });
});

// ── evaluateHarnessAction ───────────────────────────────────────────────────

describe("autoharness — evaluateHarnessAction", () => {
  it("returns allowed:true when no harness exists", () => {
    const result = evaluateHarnessAction("nonexistent-agent", "global", {
      tool: "write_file",
      target: "foo.js",
    });
    assert.equal(result.allowed, true);
    assert.equal(result.harness, null);
  });

  it("returns allowed:true when action has no tool", () => {
    const result = evaluateHarnessAction("crew-coder", "global", {});
    assert.equal(result.allowed, true);
  });
});

// ── synthesizeHarness + scoreHarness ────────────────────────────────────────

describe("autoharness — synthesizeHarness + scoreHarness", () => {
  const testAgentId = `test-synth-${Date.now()}`;

  it("generates rules from repeated failures", () => {
    // Record several failing tool traces
    for (let i = 0; i < 3; i++) {
      recordToolTrace({
        agentId: testAgentId,
        projectId: "global",
        tool: "run_cmd",
        command: "rm -rf /",
        outcome: "blocked",
        reason: "dangerous command",
      });
    }

    const harness = synthesizeHarness(testAgentId, "global", { minFailures: 2 });
    assert.ok(harness, "should produce a harness");
    assert.equal(harness.version, 1);
    assert.ok(Array.isArray(harness.rules));
    assert.ok(harness.rules.length > 0, "should have at least one rule");
    assert.equal(harness.rules[0].action, "block");
  });

  it("evaluateHarnessAction blocks after synthesized rules", () => {
    const result = evaluateHarnessAction(testAgentId, "global", {
      tool: "run_cmd",
      command: "rm -rf /",
    });
    assert.equal(result.allowed, false);
  });

  it("scoreHarness returns precision/recall stats", () => {
    const score = scoreHarness(testAgentId, "global");
    assert.ok(score.stats);
    assert.equal(typeof score.stats.traces, "number");
    assert.equal(typeof score.stats.precision, "number");
    assert.equal(typeof score.stats.recall, "number");
    assert.ok(score.stats.traces > 0);
  });
});

// ── recordTaskTrace ─────────────────────────────────────────────────────────

describe("autoharness — recordTaskTrace", () => {
  it("does nothing when agentId is empty", () => {
    // Should not throw
    recordTaskTrace({ agentId: "", prompt: "test" });
  });

  it("writes a task trace entry", () => {
    const agentId = `test-task-trace-${Date.now()}`;
    recordTaskTrace({
      agentId,
      projectId: "global",
      taskId: "t1",
      incomingType: "test",
      prompt: "do something",
      reply: "done",
      success: true,
    });

    const paths = getAutoHarnessPaths(agentId);
    assert.ok(fs.existsSync(paths.taskTraceFile));
    const lines = fs.readFileSync(paths.taskTraceFile, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.taskId, "t1");
    assert.equal(entry.success, true);
  });
});
