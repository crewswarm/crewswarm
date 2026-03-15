/**
 * Unit tests for autonomous mode detection patterns in chat-handler.
 *
 * Tests the regex patterns that control autonomous PM loop start/stop
 * and the @@STOP / @@KILL signal detection.
 * These are pure pattern tests — no network calls, no filesystem.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Pattern mirrors from lib/crew-lead/chat-handler.mjs ───────────────────
const AUTONOMOUS_START = /run\s+until\s+done|autonomous\s+build|build\s+until\s+done/i;
const AUTONOMOUS_STOP  = /stop\s+autonomous|stop\s+(the\s+)?build/i;
const STOP_SIGNAL      = /^@@STOP\b/;
const KILL_SIGNAL      = /^@@KILL\b/;

// ── Tests ──────────────────────────────────────────────────────────────────

describe("autonomous mode — start detection", () => {
  it("matches 'run until done'", () => {
    assert.ok(AUTONOMOUS_START.test("run until done"), "should match exact phrase");
  });

  it("matches 'Run Until Done' (case-insensitive)", () => {
    assert.ok(AUTONOMOUS_START.test("Run Until Done"));
  });

  it("matches 'autonomous build'", () => {
    assert.ok(AUTONOMOUS_START.test("let's do an autonomous build"));
  });

  it("matches 'build until done'", () => {
    assert.ok(AUTONOMOUS_START.test("build until done please"));
  });

  it("does NOT match 'build the feature' (partial match guard)", () => {
    assert.ok(!AUTONOMOUS_START.test("build the feature"), "should not trigger on random 'build'");
  });

  it("does NOT match 'done building'", () => {
    assert.ok(!AUTONOMOUS_START.test("done building now"), "reversed phrase should not match");
  });

  it("does NOT match empty string", () => {
    assert.ok(!AUTONOMOUS_START.test(""));
  });
});

describe("autonomous mode — stop detection", () => {
  it("matches 'stop autonomous'", () => {
    assert.ok(AUTONOMOUS_STOP.test("stop autonomous"), "should match exact phrase");
  });

  it("matches 'stop the build'", () => {
    assert.ok(AUTONOMOUS_STOP.test("stop the build"));
  });

  it("matches 'Stop Build' (case-insensitive)", () => {
    assert.ok(AUTONOMOUS_STOP.test("Stop Build"));
  });

  it("matches 'please stop autonomous mode'", () => {
    assert.ok(AUTONOMOUS_STOP.test("please stop autonomous mode"));
  });

  it("does NOT match 'don't stop the music'", () => {
    assert.ok(!AUTONOMOUS_STOP.test("don't stop the music"), "should not false-positive on 'stop the'");
  });

  it("does NOT match empty string", () => {
    assert.ok(!AUTONOMOUS_STOP.test(""));
  });
});

describe("@@STOP signal detection", () => {
  it("matches bare @@STOP", () => {
    assert.ok(STOP_SIGNAL.test("@@STOP"));
  });

  it("matches @@STOP with trailing content", () => {
    assert.ok(STOP_SIGNAL.test("@@STOP all pipelines"));
  });

  it("does NOT match @@STOP inside a sentence", () => {
    assert.ok(!STOP_SIGNAL.test("please @@STOP everything"), "anchored to line start");
  });

  it("does NOT match @@STOPPER (word boundary)", () => {
    assert.ok(!STOP_SIGNAL.test("@@STOPPERsomething"), "\\b prevents partial match");
  });
});

describe("@@KILL signal detection", () => {
  it("matches bare @@KILL", () => {
    assert.ok(KILL_SIGNAL.test("@@KILL"));
  });

  it("matches @@KILL with trailing content", () => {
    assert.ok(KILL_SIGNAL.test("@@KILL all agents"));
  });

  it("does NOT match @@KILL inside a sentence", () => {
    assert.ok(!KILL_SIGNAL.test("please @@KILL everything"), "anchored to line start");
  });

  it("does NOT match @@KILLSWITCH (word boundary)", () => {
    assert.ok(!KILL_SIGNAL.test("@@KILLSWITCHon"), "\\b prevents partial match");
  });
});

describe("autonomous mode — Set semantics (session tracking)", () => {
  it("add and has work correctly", () => {
    const sessions = new Set();
    sessions.add("session-abc");
    assert.ok(sessions.has("session-abc"), "session should be tracked");
  });

  it("delete removes session", () => {
    const sessions = new Set();
    sessions.add("session-abc");
    sessions.delete("session-abc");
    assert.ok(!sessions.has("session-abc"), "session should be removed");
  });

  it("clear removes all sessions (@@STOP behavior)", () => {
    const sessions = new Set(["s1", "s2", "s3"]);
    sessions.clear();
    assert.equal(sessions.size, 0, "all sessions should be cleared on @@STOP");
  });

  it("deleting non-existent session does not throw", () => {
    const sessions = new Set();
    assert.doesNotThrow(() => sessions.delete("no-such-session"));
  });
});
