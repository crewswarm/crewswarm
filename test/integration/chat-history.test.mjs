/**
 * Integration tests for lib/chat/history.mjs
 * Uses hermetic test mode to isolate from real history.
 */

// IMPORTANT: Setup hermetic mode BEFORE other imports
import { setupHermeticTest, generateTestSessionId } from "../helpers/hermetic.mjs";
setupHermeticTest();

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sessionFile, loadHistory, appendHistory, clearHistory } from "../../lib/chat/history.mjs";

const TEST_USER = "test-user";
const TEST_SESSION = generateTestSessionId("chat");

describe("sessionFile", () => {
  test("returns a path string ending in .jsonl", () => {
    const p = sessionFile("test-user", "my-session");
    assert.equal(typeof p, "string");
    assert.ok(p.endsWith(".jsonl"), `expected .jsonl, got ${p}`);
  });

  test("sanitizes special characters from session ID", () => {
    const p = sessionFile("test-user", "my session/with:chars");
    assert.ok(!p.includes("/my session"), "path should not contain raw special chars in session name");
  });
});

describe("loadHistory + appendHistory + clearHistory", () => {
  before(() => {
    clearHistory(TEST_USER, TEST_SESSION);
  });

  test("loadHistory returns empty array for new session", () => {
    const history = loadHistory(TEST_USER, TEST_SESSION);
    assert.deepEqual(history, []);
  });

  test("appendHistory writes a message that loadHistory reads back", () => {
    appendHistory(TEST_USER, TEST_SESSION, "user", "hello from test");
    const history = loadHistory(TEST_USER, TEST_SESSION);
    assert.equal(history.length, 1);
    assert.equal(history[0].role, "user");
    assert.equal(history[0].content, "hello from test");
    assert.ok(typeof history[0].ts === "number", "ts should be a number");
  });

  test("appendHistory accumulates multiple messages in order", () => {
    appendHistory(TEST_USER, TEST_SESSION, "assistant", "hello back");
    appendHistory(TEST_USER, TEST_SESSION, "user", "second message");
    const history = loadHistory(TEST_USER, TEST_SESSION);
    assert.equal(history.length, 3);
    assert.equal(history[0].role, "user");
    assert.equal(history[1].role, "assistant");
    assert.equal(history[2].role, "user");
  });

  test("clearHistory removes the session file", () => {
    clearHistory(TEST_USER, TEST_SESSION);
    const history = loadHistory(TEST_USER, TEST_SESSION);
    assert.deepEqual(history, []);
    assert.ok(!fs.existsSync(sessionFile(TEST_USER, TEST_SESSION)));
  });

  test("clearHistory is safe to call on non-existent session", () => {
    assert.doesNotThrow(() => clearHistory("test-user", "nonexistent-session-xyz-999"));
  });
});
