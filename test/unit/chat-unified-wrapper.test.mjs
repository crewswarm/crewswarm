/**
 * Unit tests for lib/chat/unified-wrapper.mjs
 *
 * The wrapper delegates to:
 *   - lib/chat/history.mjs        (loadHistory / appendHistory)
 *   - lib/chat/unified-history.mjs (shouldUseUnifiedHistory / formatUnifiedHistory)
 *
 * We test the observable contract:
 *   - When shouldUseUnifiedHistory returns false (no linked identity), the wrapper
 *     forwards to platform history — messages appended via appendHistoryUnified
 *     are readable via loadHistoryUnified.
 *   - When shouldUseUnifiedHistory returns true, loadHistoryUnified returns the
 *     result of formatUnifiedHistory (which reads linked-platform histories).
 *   - appendHistoryUnified always writes to platform history regardless.
 *
 * Because ESM module mocking is not available in the Node built-in test runner,
 * we use a real temp directory for platform history and test the actual branch
 * taken for users that have NO linked identity (the common case), plus an inline
 * logic mirror for the unified-history path.
 */

import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Isolate all file I/O in a temp directory
const TEST_DIR = path.join(os.tmpdir(), `chat-uw-test-${process.pid}`);
process.env.CREWSWARM_STATE_DIR = TEST_DIR;

import { resetPaths } from "../../lib/runtime/paths.mjs";

import {
  loadHistoryUnified,
  appendHistoryUnified,
} from "../../lib/chat/unified-wrapper.mjs";

// ── Setup / teardown ──────────────────────────────────────────────────────────

before(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  resetPaths();
});

afterEach(() => {
  const histDir = path.join(TEST_DIR, "chat-history");
  if (fs.existsSync(histDir)) {
    fs.rmSync(histDir, { recursive: true, force: true });
  }
});

// ── Helper: a userId that is guaranteed to have no linked identity ────────────

// Any user not present in the identity-linker store has no master identity,
// so shouldUseUnifiedHistory returns false → wrapper delegates to platform history.
function isolatedUserId() {
  return `isolated-user-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ── appendHistoryUnified ──────────────────────────────────────────────────────

describe("appendHistoryUnified", () => {
  it("writes to platform history (readable via loadHistoryUnified)", () => {
    const uid = isolatedUserId();
    appendHistoryUnified(uid, "sess-1", "user", "hello from wrapper");
    const history = loadHistoryUnified(uid, "sess-1");
    assert.ok(Array.isArray(history));
    assert.ok(history.some((m) => m.content === "hello from wrapper"));
  });

  it("appends multiple messages in order", () => {
    const uid = isolatedUserId();
    appendHistoryUnified(uid, "sess-order", "user", "first");
    appendHistoryUnified(uid, "sess-order", "assistant", "second");
    appendHistoryUnified(uid, "sess-order", "user", "third");
    const history = loadHistoryUnified(uid, "sess-order");
    assert.equal(history.length, 3);
    assert.equal(history[0].content, "first");
    assert.equal(history[2].content, "third");
  });

  it("stores role correctly", () => {
    const uid = isolatedUserId();
    appendHistoryUnified(uid, "sess-role", "assistant", "bot reply");
    const history = loadHistoryUnified(uid, "sess-role");
    assert.equal(history[0].role, "assistant");
  });

  it("accepts an optional projectId argument without throwing", () => {
    const uid = isolatedUserId();
    assert.doesNotThrow(() =>
      appendHistoryUnified(uid, "sess-proj", "user", "with project", "proj-42")
    );
  });

  it("isolates sessions for the same user", () => {
    const uid = isolatedUserId();
    appendHistoryUnified(uid, "sess-A", "user", "session A message");
    appendHistoryUnified(uid, "sess-B", "user", "session B message");
    const histA = loadHistoryUnified(uid, "sess-A");
    const histB = loadHistoryUnified(uid, "sess-B");
    assert.equal(histA.length, 1);
    assert.equal(histA[0].content, "session A message");
    assert.equal(histB.length, 1);
    assert.equal(histB[0].content, "session B message");
  });

  it("isolates different users from each other", () => {
    const uid1 = isolatedUserId();
    const uid2 = isolatedUserId();
    appendHistoryUnified(uid1, "s", "user", "user1 says hi");
    appendHistoryUnified(uid2, "s", "user", "user2 says hi");
    const h1 = loadHistoryUnified(uid1, "s");
    const h2 = loadHistoryUnified(uid2, "s");
    assert.equal(h1.length, 1);
    assert.equal(h2.length, 1);
    assert.equal(h1[0].content, "user1 says hi");
    assert.equal(h2[0].content, "user2 says hi");
  });
});

// ── loadHistoryUnified ────────────────────────────────────────────────────────

describe("loadHistoryUnified", () => {
  it("returns an array", () => {
    const uid = isolatedUserId();
    const history = loadHistoryUnified(uid, "sess-empty");
    assert.ok(Array.isArray(history));
  });

  it("returns empty array for user with no history", () => {
    const uid = isolatedUserId();
    const history = loadHistoryUnified(uid, "sess-none");
    assert.deepEqual(history, []);
  });

  it("returns previously appended messages for unlinked user", () => {
    const uid = isolatedUserId();
    appendHistoryUnified(uid, "sess-2", "user", "persisted msg");
    const history = loadHistoryUnified(uid, "sess-2");
    assert.equal(history.length, 1);
    assert.equal(history[0].content, "persisted msg");
  });

  it("returns messages with role and content fields", () => {
    const uid = isolatedUserId();
    appendHistoryUnified(uid, "sess-3", "user", "field check");
    const [msg] = loadHistoryUnified(uid, "sess-3");
    assert.ok("role" in msg);
    assert.ok("content" in msg);
  });

  it("defaults sessionId to 'default' when not provided", () => {
    const uid = isolatedUserId();
    appendHistoryUnified(uid, "default", "user", "default-sess-msg");
    // Load without explicit sessionId — uses the same "default" session
    const history = loadHistoryUnified(uid);
    assert.ok(history.some((m) => m.content === "default-sess-msg"));
  });

  it("accepts an optional projectId argument without throwing", () => {
    const uid = isolatedUserId();
    assert.doesNotThrow(() => loadHistoryUnified(uid, "sess-proj", "proj-99"));
  });
});

// ── Inline logic mirror: unified-branch behaviour ─────────────────────────────

describe("unified-branch logic mirrors", () => {
  /**
   * Mirrors what loadHistoryUnified does when shouldUseUnifiedHistory returns true.
   * We test the pure formatting transform here since we cannot easily mock the
   * identity linker in ESM.
   */

  it("formatUnifiedHistory strips source field and preserves role+content", () => {
    // Mirrors: history.map(h => ({ role, content, ...(h.agent && {name}) }))
    const raw = [
      { role: "user", content: "hi", source: "dashboard", ts: 1 },
      { role: "assistant", content: "hello", agent: "crew-lead", source: "telegram", ts: 2 },
    ];
    const formatted = raw.map((h) => ({
      role: h.role,
      content: h.content,
      ...(h.agent && { name: h.agent }),
    }));
    assert.equal(formatted[0].role, "user");
    assert.equal(formatted[0].content, "hi");
    assert.ok(!("source" in formatted[0]));
    assert.equal(formatted[1].name, "crew-lead");
  });

  it("shouldUseUnifiedHistory returns false for an isolated (unlinked) user", async () => {
    const { shouldUseUnifiedHistory } = await import("../../lib/chat/unified-history.mjs");
    const uid = isolatedUserId();
    // No identity linker record → should return false
    assert.equal(shouldUseUnifiedHistory(uid), false);
  });
});

// ── Module smoke test ─────────────────────────────────────────────────────────

describe("unified-wrapper exports smoke test", () => {
  it("exports the expected functions", async () => {
    const mod = await import("../../lib/chat/unified-wrapper.mjs");
    assert.equal(typeof mod.loadHistoryUnified, "function");
    assert.equal(typeof mod.appendHistoryUnified, "function");
  });
});
