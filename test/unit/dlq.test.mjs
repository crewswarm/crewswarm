/**
 * Unit tests for lib/runtime/dlq.mjs
 *
 * Covers:
 *  - writeToDLQ: creates a file with the correct structure and returns the entry
 *  - writeToDLQ: supplies sensible defaults for missing fields
 *  - writeToDLQ: returns null when the directory cannot be written
 *  - shouldDLQ: returns true when retries >= maxRetries
 *  - shouldDLQ: returns true for each catastrophic error keyword
 *  - shouldDLQ: returns false when retries remain and error is retryable
 *  - listDLQEntries: returns an empty array when the DLQ directory is absent
 *  - listDLQEntries: returns all written entries, newest-first
 *  - listDLQEntries: skips corrupt JSON files without throwing
 *  - getDLQEntry: returns null for a missing task ID
 *  - getDLQEntry: returns the correct entry for an existing task ID
 *  - deleteDLQEntry: removes the file and returns true
 *  - deleteDLQEntry: returns false when the entry does not exist
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Temp DLQ directory ──────────────────────────────────────────────────────
// SHARED_MEMORY_DIR must be set before config.mjs (and therefore dlq.mjs)
// is imported, because SWARM_DLQ_DIR is a module-level constant computed
// from process.env.SHARED_MEMORY_DIR at evaluation time.

const TEST_SHARED_MEMORY_DIR = path.join(
  os.tmpdir(),
  `crewswarm-dlq-test-${process.pid}`
);

// Derived the same way config.mjs derives SWARM_DLQ_DIR so we know the
// exact path without importing config at all.
const NAMESPACE = process.env.SHARED_MEMORY_NAMESPACE || "claw-swarm";
const TEST_DLQ_DIR = path.join(
  TEST_SHARED_MEMORY_DIR,
  NAMESPACE,
  "opencrew-rt",
  "dlq"
);

// Set before any import so the module sees the override.
process.env.SHARED_MEMORY_DIR = TEST_SHARED_MEMORY_DIR;

// Dynamic import ensures the env var is already set when the module evaluates.
const { writeToDLQ, shouldDLQ, listDLQEntries, getDLQEntry, deleteDLQEntry } =
  await import("../../lib/runtime/dlq.mjs");

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTask(overrides = {}) {
  return {
    taskId: `task-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    agent: "crew-coder",
    prompt: "Write a hello world function",
    error: "Something went wrong",
    retries: 0,
    payload: { context: "test" },
    correlationId: "corr-abc123",
    ...overrides,
  };
}

// ── Suite ──────────────────────────────────────────────────────────────────

describe("dlq — writeToDLQ", () => {
  before(() => {
    fs.mkdirSync(TEST_DLQ_DIR, { recursive: true });
  });

  after(() => {
    fs.rmSync(TEST_SHARED_MEMORY_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    // Remove all JSON files written during a test so tests stay isolated.
    try {
      for (const f of fs.readdirSync(TEST_DLQ_DIR).filter(f => f.endsWith(".json"))) {
        fs.unlinkSync(path.join(TEST_DLQ_DIR, f));
      }
    } catch { /* directory may not exist yet */ }
  });

  it("returns a DLQ entry object on success", () => {
    const task = makeTask();
    const entry = writeToDLQ(task);

    assert.ok(entry !== null, "writeToDLQ should return an entry, not null");
    assert.equal(typeof entry, "object");
  });

  it("written entry contains required top-level fields", () => {
    const task = makeTask({ taskId: "task-field-check" });
    const entry = writeToDLQ(task);

    assert.ok(entry, "entry must not be null");
    assert.equal(entry.taskId, "task-field-check");
    assert.equal(entry.agent, task.agent);
    assert.equal(entry.prompt, task.prompt);
    assert.equal(entry.error, task.error);
    assert.equal(typeof entry.retries, "number");
    assert.ok(typeof entry.failedAt === "string", "failedAt must be an ISO string");
    assert.ok(typeof entry.ts === "number", "ts must be a numeric timestamp");
    assert.equal(entry.dlqVersion, "1.0");
  });

  it("creates a JSON file named <taskId>.json in the DLQ directory", () => {
    const task = makeTask({ taskId: "task-file-exists" });
    writeToDLQ(task);

    const filePath = path.join(TEST_DLQ_DIR, "task-file-exists.json");
    assert.ok(fs.existsSync(filePath), `expected file at ${filePath}`);
  });

  it("written file is valid JSON matching the returned entry", () => {
    const task = makeTask({ taskId: "task-json-valid" });
    const entry = writeToDLQ(task);

    const raw = fs.readFileSync(path.join(TEST_DLQ_DIR, "task-json-valid.json"), "utf8");
    const parsed = JSON.parse(raw);

    assert.deepEqual(parsed, entry);
  });

  it("stores originalPayload from task.payload", () => {
    const payload = { projectId: "proj-42", priority: "high" };
    const task = makeTask({ taskId: "task-payload", payload });
    const entry = writeToDLQ(task);

    assert.deepEqual(entry.originalPayload, payload);
  });

  it("stores correlationId from task.correlationId", () => {
    const task = makeTask({ taskId: "task-corr", correlationId: "corr-xyz" });
    const entry = writeToDLQ(task);

    assert.equal(entry.correlationId, "corr-xyz");
  });

  it("uses task.task as prompt fallback when task.prompt is absent", () => {
    const task = makeTask({ taskId: "task-task-field", prompt: undefined, task: "fallback via task field" });
    const entry = writeToDLQ(task);

    assert.equal(entry.prompt, "fallback via task field");
  });

  it("uses task.message as prompt fallback when prompt and task are absent", () => {
    const task = makeTask({ taskId: "task-message-field", prompt: undefined, task: undefined, message: "fallback via message" });
    const entry = writeToDLQ(task);

    assert.equal(entry.prompt, "fallback via message");
  });

  it("supplies a generated taskId when task.taskId is absent", () => {
    const task = makeTask({ taskId: undefined });
    const entry = writeToDLQ(task);

    assert.ok(entry !== null);
    assert.ok(typeof entry.taskId === "string" && entry.taskId.length > 0);
  });

  it("defaults agent to 'unknown' when task.agent is absent", () => {
    const task = makeTask({ taskId: "task-no-agent", agent: undefined });
    const entry = writeToDLQ(task);

    assert.equal(entry.agent, "unknown");
  });

  it("defaults error to 'Unknown error' when task.error is absent", () => {
    const task = makeTask({ taskId: "task-no-error", error: undefined });
    const entry = writeToDLQ(task);

    assert.equal(entry.error, "Unknown error");
  });

  it("defaults correlationId to null when absent", () => {
    const task = makeTask({ taskId: "task-no-corr", correlationId: undefined });
    const entry = writeToDLQ(task);

    assert.equal(entry.correlationId, null);
  });

  it("defaults originalPayload to {} when task.payload is absent", () => {
    const task = makeTask({ taskId: "task-no-payload", payload: undefined });
    const entry = writeToDLQ(task);

    assert.deepEqual(entry.originalPayload, {});
  });

  it("returns null when write fails (unwritable path)", () => {
    // Temporarily replace DLQ dir with a regular file so mkdirSync fails.
    fs.rmSync(TEST_DLQ_DIR, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(TEST_DLQ_DIR), { recursive: true });
    fs.writeFileSync(TEST_DLQ_DIR, "not-a-directory");

    const task = makeTask({ taskId: "task-write-fail" });
    const entry = writeToDLQ(task);

    assert.equal(entry, null, "should return null on write failure");

    // Restore the real DLQ directory so afterEach cleanup and later suites work.
    fs.unlinkSync(TEST_DLQ_DIR);
    fs.mkdirSync(TEST_DLQ_DIR, { recursive: true });
  });
});

// ── shouldDLQ ──────────────────────────────────────────────────────────────

describe("dlq — shouldDLQ", () => {
  it("returns true when retries equal maxRetries", () => {
    assert.equal(shouldDLQ({ retries: 3 }, 3), true);
  });

  it("returns true when retries exceed maxRetries", () => {
    assert.equal(shouldDLQ({ retries: 5 }, 3), true);
  });

  it("returns false when retries are below maxRetries and error is retryable", () => {
    assert.equal(shouldDLQ({ retries: 1, error: "network timeout" }, 3), false);
  });

  it("returns false for zero retries with a benign error", () => {
    assert.equal(shouldDLQ({ retries: 0, error: "temporary blip" }, 3), false);
  });

  it("returns true for ENOENT catastrophic error regardless of retry count", () => {
    assert.equal(shouldDLQ({ retries: 0, error: "ENOENT: no such file" }, 10), true);
  });

  it("returns true for EACCES catastrophic error", () => {
    assert.equal(shouldDLQ({ retries: 0, error: "EACCES: permission denied" }, 10), true);
  });

  it("returns true for 'Module not found' catastrophic error", () => {
    assert.equal(shouldDLQ({ retries: 0, error: "Module not found: cannot resolve 'lodash'" }, 10), true);
  });

  it("returns true for 'Syntax error' catastrophic error", () => {
    assert.equal(shouldDLQ({ retries: 0, error: "Syntax error on line 42" }, 10), true);
  });

  it("returns true for 'Invalid configuration' catastrophic error", () => {
    assert.equal(shouldDLQ({ retries: 0, error: "Invalid configuration supplied" }, 10), true);
  });

  it("catastrophic error matching is case-insensitive", () => {
    assert.equal(shouldDLQ({ retries: 0, error: "enoent file missing" }, 10), true);
    assert.equal(shouldDLQ({ retries: 0, error: "SYNTAX ERROR detected" }, 10), true);
  });

  it("handles missing error field without throwing", () => {
    assert.doesNotThrow(() => shouldDLQ({ retries: 0 }, 3));
    assert.equal(shouldDLQ({ retries: 0 }, 3), false);
  });

  it("handles numeric error coerced to string without throwing", () => {
    assert.doesNotThrow(() => shouldDLQ({ retries: 0, error: 404 }, 3));
  });
});

// ── listDLQEntries ─────────────────────────────────────────────────────────

describe("dlq — listDLQEntries", () => {
  before(() => {
    fs.mkdirSync(TEST_DLQ_DIR, { recursive: true });
  });

  afterEach(() => {
    try {
      for (const f of fs.readdirSync(TEST_DLQ_DIR).filter(f => f.endsWith(".json"))) {
        fs.unlinkSync(path.join(TEST_DLQ_DIR, f));
      }
    } catch { }
  });

  it("returns an empty array when the DLQ directory is empty", () => {
    const entries = listDLQEntries();
    assert.ok(Array.isArray(entries));
    assert.equal(entries.length, 0);
  });

  it("returns an empty array when the DLQ directory does not exist", () => {
    fs.rmSync(TEST_DLQ_DIR, { recursive: true, force: true });

    const entries = listDLQEntries();

    assert.ok(Array.isArray(entries));
    assert.equal(entries.length, 0);

    // Restore for subsequent tests.
    fs.mkdirSync(TEST_DLQ_DIR, { recursive: true });
  });

  it("returns one entry after writing one task", () => {
    writeToDLQ(makeTask({ taskId: "task-list-one" }));

    const entries = listDLQEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].taskId, "task-list-one");
  });

  it("returns all entries when multiple tasks are written", () => {
    writeToDLQ(makeTask({ taskId: "task-list-a" }));
    writeToDLQ(makeTask({ taskId: "task-list-b" }));
    writeToDLQ(makeTask({ taskId: "task-list-c" }));

    const entries = listDLQEntries();
    assert.equal(entries.length, 3);

    const ids = entries.map(e => e.taskId);
    assert.ok(ids.includes("task-list-a"));
    assert.ok(ids.includes("task-list-b"));
    assert.ok(ids.includes("task-list-c"));
  });

  it("entries are returned newest-first (reverse sort order)", () => {
    // Write files with deliberate name ordering to verify sort direction.
    fs.writeFileSync(path.join(TEST_DLQ_DIR, "task-aaa.json"), JSON.stringify({ taskId: "task-aaa" }));
    fs.writeFileSync(path.join(TEST_DLQ_DIR, "task-zzz.json"), JSON.stringify({ taskId: "task-zzz" }));

    const entries = listDLQEntries();
    assert.equal(entries[0].taskId, "task-zzz", "zzz should come before aaa in reverse sort");
    assert.equal(entries[1].taskId, "task-aaa");
  });

  it("skips corrupt JSON files and returns only valid entries", () => {
    writeToDLQ(makeTask({ taskId: "task-valid" }));
    fs.writeFileSync(path.join(TEST_DLQ_DIR, "task-corrupt.json"), "{ not valid json !!!");

    const entries = listDLQEntries();
    // Only the valid entry should appear; corrupt file is silently skipped.
    assert.equal(entries.length, 1);
    assert.equal(entries[0].taskId, "task-valid");
  });

  it("ignores non-.json files in the DLQ directory", () => {
    writeToDLQ(makeTask({ taskId: "task-only-json" }));
    fs.writeFileSync(path.join(TEST_DLQ_DIR, "readme.txt"), "ignore me");
    fs.writeFileSync(path.join(TEST_DLQ_DIR, "task.json.bak"), "ignore me too");

    const entries = listDLQEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].taskId, "task-only-json");
  });
});

// ── getDLQEntry ────────────────────────────────────────────────────────────

describe("dlq — getDLQEntry", () => {
  before(() => {
    fs.mkdirSync(TEST_DLQ_DIR, { recursive: true });
  });

  afterEach(() => {
    try {
      for (const f of fs.readdirSync(TEST_DLQ_DIR).filter(f => f.endsWith(".json"))) {
        fs.unlinkSync(path.join(TEST_DLQ_DIR, f));
      }
    } catch { }
  });

  it("returns null for a task ID that does not exist", () => {
    const entry = getDLQEntry("task-does-not-exist");
    assert.equal(entry, null);
  });

  it("returns the entry object for an existing task ID", () => {
    writeToDLQ(makeTask({ taskId: "task-get-me" }));

    const entry = getDLQEntry("task-get-me");
    assert.ok(entry !== null);
    assert.equal(entry.taskId, "task-get-me");
  });

  it("returned entry matches the exact data written to disk", () => {
    const task = makeTask({ taskId: "task-get-exact", agent: "crew-qa", retries: 2 });
    const written = writeToDLQ(task);
    const retrieved = getDLQEntry("task-get-exact");

    assert.deepEqual(retrieved, written);
  });

  it("returns null when the entry file contains corrupt JSON", () => {
    const corruptId = "task-get-corrupt";
    fs.writeFileSync(path.join(TEST_DLQ_DIR, `${corruptId}.json`), "{ bad json");

    const entry = getDLQEntry(corruptId);
    assert.equal(entry, null);
  });
});

// ── deleteDLQEntry ─────────────────────────────────────────────────────────

describe("dlq — deleteDLQEntry", () => {
  before(() => {
    fs.mkdirSync(TEST_DLQ_DIR, { recursive: true });
  });

  afterEach(() => {
    try {
      for (const f of fs.readdirSync(TEST_DLQ_DIR).filter(f => f.endsWith(".json"))) {
        fs.unlinkSync(path.join(TEST_DLQ_DIR, f));
      }
    } catch { }
  });

  it("returns false when the task ID does not exist", () => {
    const result = deleteDLQEntry("task-never-written");
    assert.equal(result, false);
  });

  it("returns true after deleting an existing entry", () => {
    writeToDLQ(makeTask({ taskId: "task-delete-me" }));

    const result = deleteDLQEntry("task-delete-me");
    assert.equal(result, true);
  });

  it("removes the file from disk", () => {
    writeToDLQ(makeTask({ taskId: "task-gone" }));
    const filePath = path.join(TEST_DLQ_DIR, "task-gone.json");
    assert.ok(fs.existsSync(filePath), "file should exist before delete");

    deleteDLQEntry("task-gone");

    assert.ok(!fs.existsSync(filePath), "file should not exist after delete");
  });

  it("entry is no longer retrievable via getDLQEntry after deletion", () => {
    writeToDLQ(makeTask({ taskId: "task-del-verify" }));
    deleteDLQEntry("task-del-verify");

    const entry = getDLQEntry("task-del-verify");
    assert.equal(entry, null);
  });

  it("entry is no longer listed by listDLQEntries after deletion", () => {
    writeToDLQ(makeTask({ taskId: "task-del-list" }));
    writeToDLQ(makeTask({ taskId: "task-keep" }));

    deleteDLQEntry("task-del-list");

    const entries = listDLQEntries();
    const ids = entries.map(e => e.taskId);
    assert.ok(!ids.includes("task-del-list"), "deleted entry should not appear in list");
    assert.ok(ids.includes("task-keep"), "surviving entry should still appear in list");
  });

  it("calling deleteDLQEntry twice on the same ID returns false the second time", () => {
    writeToDLQ(makeTask({ taskId: "task-double-del" }));

    const first = deleteDLQEntry("task-double-del");
    const second = deleteDLQEntry("task-double-del");

    assert.equal(first, true);
    assert.equal(second, false);
  });
});
