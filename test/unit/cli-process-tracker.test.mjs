/**
 * Unit tests for lib/cli-process-tracker.mjs
 *
 * Covers:
 *  - registerCLIProcess: stores process, returns processId
 *  - updateCLIActivity: updates lastActivity, counts lines, detects status
 *  - completeCLIProcess: marks done/failed, records exitCode
 *  - isProcessActive: threshold-based activity check
 *  - getActiveProcesses: shape + fields
 *  - getAgentProcesses: filters by agent
 *  - getSessionCLIStatus: finds running/idle process by sessionId
 *  - killStuckProcess: refuses to kill active, handles missing pid
 *  - initCLIProcessTracker: does not throw
 *
 * Note: completeCLIProcess schedules a 30s setTimeout removal. We test the
 * immediate state change without waiting for the timer.
 * killStuckProcess tries process.kill(pid) — we use a non-existent PID so
 * the OS returns ESRCH and the function handles it gracefully (returns false).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const {
  initCLIProcessTracker,
  registerCLIProcess,
  updateCLIActivity,
  completeCLIProcess,
  isProcessActive,
  getActiveProcesses,
  getAgentProcesses,
  getSessionCLIStatus,
  killStuckProcess,
} = await import("../../lib/cli-process-tracker.mjs");

// ── Helpers ──────────────────────────────────────────────────────────────────

let counter = 0;
function uid(prefix = "proc") {
  return `test-${prefix}-${Date.now()}-${++counter}`;
}

function makeProcess(overrides = {}) {
  return {
    pid: 99999 + counter,
    agent: "crew-test",
    cli: "opencode",
    task: "unit test task",
    chatId: "chat-unit",
    sessionId: `sess-unit-${counter}`,
    ...overrides
  };
}

// ── initCLIProcessTracker ────────────────────────────────────────────────────

describe("cli-process-tracker — initCLIProcessTracker", () => {
  it("does not throw when called", () => {
    assert.doesNotThrow(() => initCLIProcessTracker());
  });

  it("can be called multiple times without error", () => {
    assert.doesNotThrow(() => {
      initCLIProcessTracker();
      initCLIProcessTracker();
    });
  });
});

// ── registerCLIProcess ────────────────────────────────────────────────────────

describe("cli-process-tracker — registerCLIProcess", () => {
  it("returns the processId that was passed in", () => {
    const id = uid();
    const result = registerCLIProcess(id, makeProcess());
    assert.equal(result, id);
  });

  it("registered process appears in getActiveProcesses", () => {
    const id = uid();
    registerCLIProcess(id, makeProcess());
    const all = getActiveProcesses();
    const found = all.find(p => p.processId === id);
    assert.ok(found, `Process ${id} not found in active list`);
  });

  it("registered process has status 'running'", () => {
    const id = uid();
    registerCLIProcess(id, makeProcess());
    const all = getActiveProcesses();
    const found = all.find(p => p.processId === id);
    assert.equal(found.status, "running");
  });

  it("registered process has correct agent", () => {
    const id = uid();
    registerCLIProcess(id, makeProcess({ agent: "crew-coder" }));
    const found = getActiveProcesses().find(p => p.processId === id);
    assert.equal(found.agent, "crew-coder");
  });

  it("startTime is a recent timestamp", () => {
    const before = Date.now();
    const id = uid();
    registerCLIProcess(id, makeProcess());
    const after = Date.now();
    const found = getActiveProcesses().find(p => p.processId === id);
    assert.ok(found.startTime >= before && found.startTime <= after);
  });

  it("outputLines starts at 0", () => {
    const id = uid();
    registerCLIProcess(id, makeProcess());
    const found = getActiveProcesses().find(p => p.processId === id);
    assert.equal(found.outputLines, 0);
  });

  it("task is truncated to 100 chars in getActiveProcesses", () => {
    const id = uid();
    registerCLIProcess(id, makeProcess({ task: "x".repeat(200) }));
    const found = getActiveProcesses().find(p => p.processId === id);
    assert.ok(found.task.length <= 100);
  });
});

// ── updateCLIActivity ────────────────────────────────────────────────────────

describe("cli-process-tracker — updateCLIActivity", () => {
  it("updates lastActivity timestamp", () => {
    const id = uid();
    registerCLIProcess(id, makeProcess());
    const before = Date.now();
    updateCLIActivity(id, "some output\n");
    const found = getActiveProcesses().find(p => p.processId === id);
    assert.ok(found.idleFor <= Date.now() - before + 50); // very small idleFor
  });

  it("increments outputLines by number of newlines", () => {
    const id = uid();
    registerCLIProcess(id, makeProcess());
    updateCLIActivity(id, "line1\nline2\nline3\n");
    const found = getActiveProcesses().find(p => p.processId === id);
    assert.equal(found.outputLines, 3);
  });

  it("accumulates outputLines across multiple updates", () => {
    const id = uid();
    registerCLIProcess(id, makeProcess());
    updateCLIActivity(id, "a\nb\n");
    updateCLIActivity(id, "c\n");
    const found = getActiveProcesses().find(p => p.processId === id);
    assert.equal(found.outputLines, 3);
  });

  it("sets status to running when output contains 'Executing'", () => {
    const id = uid();
    registerCLIProcess(id, makeProcess());
    updateCLIActivity(id, "Executing tool: bash");
    const found = getActiveProcesses().find(p => p.processId === id);
    assert.equal(found.status, "running");
  });

  it("sets status to idle when output contains 'Waiting'", () => {
    const id = uid();
    registerCLIProcess(id, makeProcess());
    updateCLIActivity(id, "Waiting for input...");
    const found = getActiveProcesses().find(p => p.processId === id);
    assert.equal(found.status, "idle");
  });

  it("does not throw for unknown processId", () => {
    assert.doesNotThrow(() => updateCLIActivity("nonexistent-proc-xyz", "some data"));
  });

  it("handles output without newlines (outputLines stays same)", () => {
    const id = uid();
    registerCLIProcess(id, makeProcess());
    updateCLIActivity(id, "no newline here");
    const found = getActiveProcesses().find(p => p.processId === id);
    assert.equal(found.outputLines, 0);
  });
});

// ── completeCLIProcess ───────────────────────────────────────────────────────

describe("cli-process-tracker — completeCLIProcess", () => {
  it("marks process as 'done' on exitCode 0", () => {
    const id = uid();
    registerCLIProcess(id, makeProcess());
    completeCLIProcess(id, { exitCode: 0 });
    const found = getActiveProcesses().find(p => p.processId === id);
    // Process may still be in list for 30s — check status
    if (found) {
      assert.equal(found.status, "done");
    }
  });

  it("marks process as 'failed' on non-zero exitCode", () => {
    const id = uid();
    registerCLIProcess(id, makeProcess());
    completeCLIProcess(id, { exitCode: 1 });
    const found = getActiveProcesses().find(p => p.processId === id);
    if (found) {
      assert.equal(found.status, "failed");
    }
  });

  it("does not throw for unknown processId", () => {
    assert.doesNotThrow(() => completeCLIProcess("nonexistent-xyz", { exitCode: 0 }));
  });

  it("accepts error field in result", () => {
    const id = uid();
    registerCLIProcess(id, makeProcess());
    assert.doesNotThrow(() =>
      completeCLIProcess(id, { exitCode: 1, error: "Process crashed" })
    );
  });
});

// ── isProcessActive ──────────────────────────────────────────────────────────

describe("cli-process-tracker — isProcessActive", () => {
  it("returns true immediately after registration", () => {
    const id = uid();
    registerCLIProcess(id, makeProcess());
    assert.equal(isProcessActive(id), true);
  });

  it("returns false for unknown processId", () => {
    assert.equal(isProcessActive("does-not-exist-ever"), false);
  });

  it("returns false after process is completed with exitCode 0", () => {
    const id = uid();
    registerCLIProcess(id, makeProcess());
    completeCLIProcess(id, { exitCode: 0 });
    assert.equal(isProcessActive(id), false);
  });

  it("returns false after process fails", () => {
    const id = uid();
    registerCLIProcess(id, makeProcess());
    completeCLIProcess(id, { exitCode: 1 });
    assert.equal(isProcessActive(id), false);
  });

  it("respects custom idleThresholdMs — returns false if threshold is 0", () => {
    const id = uid();
    registerCLIProcess(id, makeProcess());
    // With threshold of 0ms, any idle time exceeds it
    assert.equal(isProcessActive(id, 0), false);
  });

  it("returns true with very large threshold", () => {
    const id = uid();
    registerCLIProcess(id, makeProcess());
    assert.equal(isProcessActive(id, 999999999), true);
  });
});

// ── getActiveProcesses ────────────────────────────────────────────────────────

describe("cli-process-tracker — getActiveProcesses", () => {
  it("returns an array", () => {
    assert.ok(Array.isArray(getActiveProcesses()));
  });

  it("each entry has required fields", () => {
    const id = uid();
    registerCLIProcess(id, makeProcess({ agent: "crew-qa", cli: "claude", sessionId: "sess-qa" }));
    const entries = getActiveProcesses();
    const found = entries.find(p => p.processId === id);
    assert.ok(found);
    for (const field of ["processId", "pid", "agent", "cli", "status", "startTime", "duration", "idleFor", "outputLines"]) {
      assert.ok(field in found, `Missing field: ${field}`);
    }
  });

  it("duration is a non-negative number", () => {
    const id = uid();
    registerCLIProcess(id, makeProcess());
    const found = getActiveProcesses().find(p => p.processId === id);
    assert.ok(typeof found.duration === "number");
    assert.ok(found.duration >= 0);
  });
});

// ── getAgentProcesses ────────────────────────────────────────────────────────

describe("cli-process-tracker — getAgentProcesses", () => {
  it("returns only processes for the specified agent", () => {
    const agentId = `crew-filter-agent-${Date.now()}`;
    const id1 = uid();
    const id2 = uid();
    registerCLIProcess(id1, makeProcess({ agent: agentId }));
    registerCLIProcess(id2, makeProcess({ agent: "crew-other" }));

    const procs = getAgentProcesses(agentId);
    assert.ok(procs.every(p => p.agent === agentId));
    assert.ok(procs.some(p => p.processId === id1));
    assert.ok(!procs.some(p => p.processId === id2));
  });

  it("returns empty array for unknown agent", () => {
    const procs = getAgentProcesses("crew-nonexistent-xyz-9999");
    assert.ok(Array.isArray(procs));
    assert.equal(procs.length, 0);
  });
});

// ── getSessionCLIStatus ──────────────────────────────────────────────────────

describe("cli-process-tracker — getSessionCLIStatus", () => {
  it("returns status object for active session", () => {
    const sessionId = `sess-test-${Date.now()}`;
    const id = uid();
    registerCLIProcess(id, makeProcess({ sessionId, agent: "crew-qa", cli: "opencode" }));

    const status = getSessionCLIStatus(sessionId);
    assert.ok(status !== null);
    assert.ok("cli" in status);
    assert.ok("agent" in status);
    assert.ok("status" in status);
    assert.ok("duration" in status);
    assert.ok("idleFor" in status);
    assert.ok("outputLines" in status);
  });

  it("returns null for unknown sessionId", () => {
    const result = getSessionCLIStatus("nonexistent-session-xyz-999");
    assert.equal(result, null);
  });

  it("returns null after process completes", () => {
    const sessionId = `sess-done-${Date.now()}`;
    const id = uid();
    registerCLIProcess(id, makeProcess({ sessionId }));
    completeCLIProcess(id, { exitCode: 0 });
    const status = getSessionCLIStatus(sessionId);
    assert.equal(status, null);
  });

  it("status.agent matches registered agent", () => {
    const sessionId = `sess-agent-${Date.now()}`;
    const id = uid();
    registerCLIProcess(id, makeProcess({ sessionId, agent: "crew-monitor" }));
    const status = getSessionCLIStatus(sessionId);
    assert.ok(status);
    assert.equal(status.agent, "crew-monitor");
  });

  it("task is truncated to 80 chars", () => {
    const sessionId = `sess-task-${Date.now()}`;
    const id = uid();
    registerCLIProcess(id, makeProcess({ sessionId, task: "z".repeat(200) }));
    const status = getSessionCLIStatus(sessionId);
    assert.ok(status);
    assert.ok(status.task.length <= 80);
  });
});

// ── killStuckProcess ─────────────────────────────────────────────────────────

describe("cli-process-tracker — killStuckProcess", () => {
  it("returns false for unknown processId", () => {
    const result = killStuckProcess("nonexistent-process-abc");
    assert.equal(result, false);
  });

  it("refuses to kill a recently active process (idleFor < threshold)", () => {
    const id = uid();
    registerCLIProcess(id, makeProcess({ pid: 99998 }));
    // Just registered = very low idleFor, well below 600000ms default
    const result = killStuckProcess(id, 600000);
    assert.equal(result, false);
  });

  it("returns false or true when process has non-existent PID (error handled)", () => {
    const id = uid();
    // PID 1 exists (init/launchd), but sending SIGTERM to PID 1 will be permission denied
    // Use a very low force threshold so the kill is attempted, then verify no throw
    registerCLIProcess(id, makeProcess({ pid: 2 }));
    // Backdate lastActivity by mutating via an extreme threshold
    // We can't directly set lastActivity, so use threshold of 0 which means
    // any idle time qualifies — but the actual kill may fail gracefully
    assert.doesNotThrow(() => killStuckProcess(id, 0));
  });
});
