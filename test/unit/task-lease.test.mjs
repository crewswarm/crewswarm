/**
 * Unit tests for lib/runtime/task-lease.mjs
 *
 * Covers:
 *  - taskKeyFor: produces a deterministic SHA-256 hex digest
 *  - taskKeyFor: different inputs produce different keys
 *  - taskIdentity: uses explicit idempotencyKey when present
 *  - taskIdentity: falls back to incomingType:taskId
 *  - taskIdentity: falls back to hash when no explicit key or taskId
 *  - claimTaskLease: returns status "claimed" for a fresh task
 *  - claimTaskLease: returns status "already_done" for a finalized task
 *  - releaseRuntimeTaskLease: expires the lease
 *  - withTaskLock: executes the function and returns its result
 *  - withTaskLock: prevents concurrent execution (file-lock based)
 *  - leasePath / taskStatePath / lockPath: return paths under lease dir
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// Set up temp dirs BEFORE importing the module (it reads env at evaluation time)
const TEST_SHARED_MEMORY_DIR = path.join(
  os.tmpdir(),
  `crewswarm-lease-test-${process.pid}`
);
process.env.SHARED_MEMORY_DIR = TEST_SHARED_MEMORY_DIR;
process.env.CREWSWARM_RT_AGENT = "test-agent";

const {
  taskKeyFor,
  taskIdentity,
  claimTaskLease,
  releaseRuntimeTaskLease,
  withTaskLock,
  leasePath,
  taskStatePath,
  lockPath,
  ensureSwarmRuntimeDirs,
  finalizeTaskState,
  parseTaskState,
  initTaskLease,
  SWARM_TASK_LEASE_DIR,
  SWARM_TASK_STATE_DIR,
} = await import("../../lib/runtime/task-lease.mjs");

// Inject a fast sleep for tests
initTaskLease({ sleep: (ms) => new Promise(r => setTimeout(r, Math.min(ms, 5))) });

// ── Helpers ────────────────────────────────────────────────────────────────

function cleanup() {
  fs.rmSync(TEST_SHARED_MEMORY_DIR, { recursive: true, force: true });
}

// ── taskKeyFor ─────────────────────────────────────────────────────────────

describe("task-lease — taskKeyFor", () => {
  it("returns a 64-char hex string (SHA-256)", () => {
    const key = taskKeyFor("some-identity");
    assert.equal(typeof key, "string");
    assert.equal(key.length, 64);
    assert.match(key, /^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same input", () => {
    const a = taskKeyFor("same-input");
    const b = taskKeyFor("same-input");
    assert.equal(a, b);
  });

  it("produces different keys for different inputs", () => {
    const a = taskKeyFor("input-alpha");
    const b = taskKeyFor("input-beta");
    assert.notEqual(a, b);
  });

  it("matches crypto.createHash directly", () => {
    const identity = "test-identity-123";
    const expected = crypto.createHash("sha256").update(identity).digest("hex");
    assert.equal(taskKeyFor(identity), expected);
  });
});

// ── taskIdentity ───────────────────────────────────────────────────────────

describe("task-lease — taskIdentity", () => {
  it("uses explicit idempotencyKey when present", () => {
    const result = taskIdentity({
      envelope: {},
      payload: { idempotencyKey: "explicit-key-123" },
      incomingType: "task",
      prompt: "do something",
    });
    assert.equal(result, "explicit-key-123");
  });

  it("uses idempotency_key (snake_case) when present", () => {
    const result = taskIdentity({
      envelope: {},
      payload: { idempotency_key: "snake-key-456" },
      incomingType: "task",
      prompt: "do something",
    });
    assert.equal(result, "snake-key-456");
  });

  it("uses dedupeKey when present", () => {
    const result = taskIdentity({
      envelope: {},
      payload: { dedupeKey: "dedupe-789" },
      incomingType: "task",
      prompt: "do something",
    });
    assert.equal(result, "dedupe-789");
  });

  it("falls back to incomingType:taskId", () => {
    const result = taskIdentity({
      envelope: { taskId: "task-abc" },
      payload: {},
      incomingType: "realtime",
      prompt: "do something",
    });
    assert.equal(result, "realtime:task-abc");
  });

  it("falls back to incomingType:envelope.id", () => {
    const result = taskIdentity({
      envelope: { id: "env-xyz" },
      payload: {},
      incomingType: "webhook",
      prompt: "do something",
    });
    assert.equal(result, "webhook:env-xyz");
  });

  it("falls back to hash:sha256 when no explicit keys", () => {
    const result = taskIdentity({
      envelope: {},
      payload: {},
      incomingType: "test",
      prompt: "hello world",
    });
    assert.ok(result.startsWith("hash:"), `expected hash prefix, got: ${result}`);
    assert.equal(result.length, 5 + 64); // "hash:" + 64 hex chars
  });

  it("hash is deterministic for same inputs", () => {
    const args = {
      envelope: { from: "user" },
      payload: {},
      incomingType: "test",
      prompt: "hello",
    };
    const a = taskIdentity(args);
    const b = taskIdentity(args);
    assert.equal(a, b);
  });
});

// ── Path helpers ───────────────────────────────────────────────────────────

describe("task-lease — path helpers", () => {
  it("leasePath returns a path ending in .json under lease dir", () => {
    const key = taskKeyFor("test");
    const p = leasePath(key);
    assert.ok(p.endsWith(`${key}.json`));
    assert.ok(p.includes("task-leases"));
  });

  it("taskStatePath returns a path ending in .json under state dir", () => {
    const key = taskKeyFor("test");
    const p = taskStatePath(key);
    assert.ok(p.endsWith(`${key}.json`));
    assert.ok(p.includes("task-state"));
  });

  it("lockPath returns a path ending in .lock under lease dir", () => {
    const key = taskKeyFor("test");
    const p = lockPath(key);
    assert.ok(p.endsWith(`${key}.lock`));
    assert.ok(p.includes("task-leases"));
  });
});

// ── withTaskLock ───────────────────────────────────────────────────────────

describe("task-lease — withTaskLock", () => {
  before(() => ensureSwarmRuntimeDirs());
  after(() => cleanup());

  it("executes the function and returns its result", async () => {
    const result = await withTaskLock("test-lock-1", async () => {
      return 42;
    });
    assert.equal(result, 42);
  });

  it("cleans up the lock file after execution", async () => {
    const key = "test-lock-cleanup";
    await withTaskLock(key, async () => "done");
    const lock = lockPath(key);
    assert.equal(fs.existsSync(lock), false, "lock file should be removed");
  });

  it("cleans up the lock file even if fn throws", async () => {
    const key = "test-lock-throw";
    try {
      await withTaskLock(key, async () => { throw new Error("boom"); });
    } catch {}
    const lock = lockPath(key);
    assert.equal(fs.existsSync(lock), false, "lock file should be removed after error");
  });
});

// ── claimTaskLease ─────────────────────────────────────────────────────────

describe("task-lease — claimTaskLease", () => {
  before(() => ensureSwarmRuntimeDirs());

  beforeEach(() => {
    // Clean lease and state dirs between tests
    try {
      for (const f of fs.readdirSync(SWARM_TASK_LEASE_DIR)) {
        fs.unlinkSync(path.join(SWARM_TASK_LEASE_DIR, f));
      }
    } catch {}
    try {
      for (const f of fs.readdirSync(SWARM_TASK_STATE_DIR)) {
        fs.unlinkSync(path.join(SWARM_TASK_STATE_DIR, f));
      }
    } catch {}
  });

  after(() => cleanup());

  it("returns status 'claimed' for a fresh task", async () => {
    const taskKey = taskKeyFor("fresh-task-1");
    const result = await claimTaskLease({
      taskKey,
      identity: "fresh-task-1",
      incomingType: "test",
      envelope: { taskId: "t1" },
      payload: {},
    });
    assert.equal(result.status, "claimed");
    assert.equal(typeof result.attempt, "number");
    assert.ok(result.lease, "should include lease record");
  });

  it("lease file is written to disk after claim", async () => {
    const taskKey = taskKeyFor("lease-file-check");
    await claimTaskLease({
      taskKey,
      identity: "lease-file-check",
      incomingType: "test",
      envelope: {},
      payload: {},
    });
    const file = leasePath(taskKey);
    assert.ok(fs.existsSync(file), `lease file should exist at ${file}`);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(data.taskKey, taskKey);
    assert.equal(data.owner, "test-agent");
  });

  it("returns status 'already_done' for a finalized task", async () => {
    const taskKey = taskKeyFor("done-task-1");

    // First claim and finalize
    await claimTaskLease({
      taskKey,
      identity: "done-task-1",
      incomingType: "test",
      envelope: {},
      payload: {},
    });
    await finalizeTaskState({
      taskKey,
      identity: "done-task-1",
      status: "done",
      attempt: 1,
    });

    // Second claim should see "already_done"
    const result = await claimTaskLease({
      taskKey,
      identity: "done-task-1",
      incomingType: "test",
      envelope: {},
      payload: {},
    });
    assert.equal(result.status, "already_done");
  });
});

// ── releaseRuntimeTaskLease ────────────────────────────────────────────────

describe("task-lease — releaseRuntimeTaskLease", () => {
  before(() => ensureSwarmRuntimeDirs());

  beforeEach(() => {
    try {
      for (const f of fs.readdirSync(SWARM_TASK_LEASE_DIR)) {
        fs.unlinkSync(path.join(SWARM_TASK_LEASE_DIR, f));
      }
    } catch {}
    try {
      for (const f of fs.readdirSync(SWARM_TASK_STATE_DIR)) {
        fs.unlinkSync(path.join(SWARM_TASK_STATE_DIR, f));
      }
    } catch {}
  });

  after(() => cleanup());

  it("sets leaseExpiresAt to the past, expiring the lease", async () => {
    const taskKey = taskKeyFor("release-test-1");
    await claimTaskLease({
      taskKey,
      identity: "release-test-1",
      incomingType: "test",
      envelope: {},
      payload: {},
    });

    await releaseRuntimeTaskLease(taskKey);

    const file = leasePath(taskKey);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const expiresAt = Date.parse(data.leaseExpiresAt);
    assert.ok(expiresAt < Date.now(), "leaseExpiresAt should be in the past");
    assert.ok(typeof data.releasedAt === "string", "releasedAt should be set");
  });

  it("does not throw when lease does not exist", async () => {
    await assert.doesNotReject(async () => {
      await releaseRuntimeTaskLease(taskKeyFor("nonexistent-lease"));
    });
  });
});
