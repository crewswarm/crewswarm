/**
 * Unit tests for lib/chat/history.mjs
 *
 * Uses CREWSWARM_STATE_DIR pointing to a per-process temp directory for full
 * isolation from ~/.crewswarm.
 *
 * Exports under test:
 *   sessionFile, loadHistory, appendHistory, clearHistory, listUserSessions
 */

import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Must be set BEFORE paths.mjs is first imported
const TEST_DIR = path.join(os.tmpdir(), `chat-history-test-${process.pid}`);
process.env.CREWSWARM_STATE_DIR = TEST_DIR;

import { resetPaths } from "../../lib/runtime/paths.mjs";

import {
  sessionFile,
  loadHistory,
  appendHistory,
  clearHistory,
  listUserSessions,
} from "../../lib/chat/history.mjs";

// ── Setup / teardown ──────────────────────────────────────────────────────────

before(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  resetPaths();
});

afterEach(() => {
  // Wipe chat-history dir between tests so each test is isolated
  const histDir = path.join(TEST_DIR, "chat-history");
  if (fs.existsSync(histDir)) {
    fs.rmSync(histDir, { recursive: true, force: true });
  }
});

// ── sessionFile ───────────────────────────────────────────────────────────────

describe("sessionFile", () => {
  it("returns a string path ending in .jsonl", () => {
    const p = sessionFile("user1", "sess1");
    assert.ok(typeof p === "string");
    assert.ok(p.endsWith(".jsonl"));
  });

  it("defaults to 'default' user and session", () => {
    const p = sessionFile();
    assert.ok(p.includes("default"));
  });

  it("includes userId and sessionId in the path", () => {
    const p = sessionFile("alice", "session-abc");
    assert.ok(p.includes("alice"));
    assert.ok(p.includes("session-abc"));
  });

  it("sanitizes userId with special characters", () => {
    // sanitizeId replaces [^a-z0-9_.-] with underscores — slashes become '_'
    // so "alice/evil/../path" → "alice_evil_.._path", which is safe (no dir sep)
    const p = sessionFile("alice/evil/../path", "session");
    assert.ok(typeof p === "string");
    // The resulting path segment must not contain a forward or back slash
    // within the userId component (path.basename of the directory)
    const userSegment = p.split(path.sep).slice(-2, -1)[0]; // parent dir = userId part
    assert.ok(!userSegment.includes("/"));
    assert.ok(!userSegment.includes("\\"));
  });

  it("sanitizes sessionId with special characters", () => {
    // sanitizeId replaces slashes with underscores; dots are allowed
    const p = sessionFile("user", "sess/evil/../path");
    assert.ok(typeof p === "string");
    // The file basename (without .jsonl) must not contain path separators
    const filename = path.basename(p, ".jsonl");
    assert.ok(!filename.includes("/"));
    assert.ok(!filename.includes("\\"));
  });

  it("creates the user directory as a side effect", () => {
    const p = sessionFile("new-user-xyz", "s");
    const dir = path.dirname(p);
    assert.ok(fs.existsSync(dir));
  });

  it("truncates very long IDs to 80 characters", () => {
    const longId = "a".repeat(200);
    const p = sessionFile(longId, "s");
    const parts = p.split(path.sep);
    const userPart = parts[parts.length - 2]; // parent directory = sanitized userId
    assert.ok(userPart.length <= 80);
  });
});

// ── appendHistory / loadHistory ───────────────────────────────────────────────

describe("appendHistory + loadHistory", () => {
  it("appended message is returned by loadHistory", () => {
    appendHistory("u1", "s1", "user", "hello");
    const history = loadHistory("u1", "s1");
    assert.equal(history.length, 1);
    assert.equal(history[0].role, "user");
    assert.equal(history[0].content, "hello");
  });

  it("returns empty array when no file exists", () => {
    assert.deepEqual(loadHistory("nobody", "nothing"), []);
  });

  it("accumulates multiple messages in order", () => {
    appendHistory("u2", "s2", "user", "first");
    appendHistory("u2", "s2", "assistant", "second");
    appendHistory("u2", "s2", "user", "third");
    const history = loadHistory("u2", "s2");
    assert.equal(history.length, 3);
    assert.equal(history[0].content, "first");
    assert.equal(history[1].content, "second");
    assert.equal(history[2].content, "third");
  });

  it("each entry has a ts timestamp", () => {
    appendHistory("u3", "s3", "user", "msg");
    const history = loadHistory("u3", "s3");
    assert.ok(typeof history[0].ts === "number");
    assert.ok(history[0].ts > 0);
  });

  it("includes agent field on assistant messages when provided", () => {
    appendHistory("u4", "s4", "assistant", "response", "crew-coder");
    const history = loadHistory("u4", "s4");
    assert.equal(history[0].agent, "crew-coder");
  });

  it("does not set agent on user messages even when supplied", () => {
    appendHistory("u5", "s5", "user", "question", "some-agent");
    const history = loadHistory("u5", "s5");
    assert.ok(!("agent" in history[0]));
  });

  it("omits agent field when not provided for assistant messages", () => {
    appendHistory("u6", "s6", "assistant", "reply");
    const history = loadHistory("u6", "s6");
    assert.ok(!("agent" in history[0]));
  });

  it("defaults userId and sessionId to 'default'", () => {
    appendHistory(undefined, undefined, "user", "default-user-msg");
    const history = loadHistory();
    assert.ok(history.some((m) => m.content === "default-user-msg"));
  });

  it("isolates different users from each other", () => {
    appendHistory("alice", "s", "user", "alice says hi");
    appendHistory("bob", "s", "user", "bob says hi");
    const aliceHistory = loadHistory("alice", "s");
    const bobHistory = loadHistory("bob", "s");
    assert.equal(aliceHistory.length, 1);
    assert.equal(aliceHistory[0].content, "alice says hi");
    assert.equal(bobHistory.length, 1);
    assert.equal(bobHistory[0].content, "bob says hi");
  });

  it("isolates different sessions for the same user", () => {
    appendHistory("user-x", "session-A", "user", "A");
    appendHistory("user-x", "session-B", "user", "B");
    const histA = loadHistory("user-x", "session-A");
    const histB = loadHistory("user-x", "session-B");
    assert.equal(histA.length, 1);
    assert.equal(histA[0].content, "A");
    assert.equal(histB.length, 1);
    assert.equal(histB[0].content, "B");
  });

  it("skips corrupt JSONL lines silently", () => {
    appendHistory("u7", "s7", "user", "good message");
    const file = sessionFile("u7", "s7");
    fs.appendFileSync(file, "CORRUPT_JSON\n");
    appendHistory("u7", "s7", "user", "after corrupt");
    const history = loadHistory("u7", "s7");
    assert.equal(history.length, 2);
    assert.equal(history[0].content, "good message");
    assert.equal(history[1].content, "after corrupt");
  });

  it("applies MAX_HISTORY limit (last 2000 messages)", () => {
    // Write 2005 messages directly to test the slice
    const file = sessionFile("u-limit", "slimit");
    for (let i = 0; i < 2005; i++) {
      fs.appendFileSync(file, JSON.stringify({ role: "user", content: `msg-${i}`, ts: i }) + "\n");
    }
    const history = loadHistory("u-limit", "slimit");
    assert.equal(history.length, 2000);
    // Should return the last 2000 (messages 5 through 2004)
    assert.equal(history[0].content, "msg-5");
    assert.equal(history[1999].content, "msg-2004");
  });
});

// ── clearHistory ──────────────────────────────────────────────────────────────

describe("clearHistory", () => {
  it("removes the session file", () => {
    appendHistory("u-clr", "s-clr", "user", "will be cleared");
    clearHistory("u-clr", "s-clr");
    assert.deepEqual(loadHistory("u-clr", "s-clr"), []);
  });

  it("does not throw when file does not exist", () => {
    assert.doesNotThrow(() => clearHistory("nonexistent-user-xyz", "no-session"));
  });

  it("only clears the specific session (other sessions intact)", () => {
    appendHistory("u-clr2", "sess-A", "user", "keep me");
    appendHistory("u-clr2", "sess-B", "user", "delete me");
    clearHistory("u-clr2", "sess-B");
    assert.equal(loadHistory("u-clr2", "sess-A").length, 1);
    assert.deepEqual(loadHistory("u-clr2", "sess-B"), []);
  });

  it("defaults to 'default' user and session", () => {
    appendHistory(undefined, undefined, "user", "default-clear-me");
    clearHistory();
    assert.deepEqual(loadHistory(), []);
  });
});

// ── listUserSessions ──────────────────────────────────────────────────────────

describe("listUserSessions", () => {
  it("returns empty array for non-existent user", () => {
    const sessions = listUserSessions("ghost-user-xyz");
    assert.deepEqual(sessions, []);
  });

  it("lists sessions the user has created", () => {
    appendHistory("user-list", "session-1", "user", "msg");
    appendHistory("user-list", "session-2", "user", "msg");
    const sessions = listUserSessions("user-list");
    assert.ok(sessions.includes("session-1"));
    assert.ok(sessions.includes("session-2"));
  });

  it("does not include non-.jsonl files", () => {
    // Create a non-jsonl file in the user dir manually
    const userDir = path.join(TEST_DIR, "chat-history", "user-nonjsonl");
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, "readme.txt"), "ignore me");
    appendHistory("user-nonjsonl", "real-session", "user", "msg");
    const sessions = listUserSessions("user-nonjsonl");
    assert.ok(!sessions.includes("readme"));
    assert.ok(sessions.includes("real-session"));
  });

  it("returns session IDs without the .jsonl extension", () => {
    appendHistory("user-ext", "my-session", "user", "hello");
    const sessions = listUserSessions("user-ext");
    assert.ok(sessions.every((s) => !s.endsWith(".jsonl")));
    assert.ok(sessions.includes("my-session"));
  });

  it("defaults to 'default' user", () => {
    appendHistory(undefined, "default-sess-list", "user", "hi");
    const sessions = listUserSessions();
    assert.ok(sessions.includes("default-sess-list"));
  });
});

// ── Module smoke test ─────────────────────────────────────────────────────────

describe("history module exports smoke test", () => {
  it("exports all expected functions", async () => {
    const mod = await import("../../lib/chat/history.mjs");
    const expected = ["sessionFile", "loadHistory", "appendHistory", "clearHistory", "listUserSessions"];
    for (const fn of expected) {
      assert.equal(typeof mod[fn], "function", `Missing export: ${fn}`);
    }
  });
});
