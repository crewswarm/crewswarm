import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  TASK_VERBS,
  QUESTION_START,
  STATUS_CHECK,
  classifyTask,
} from "../../lib/crew-lead/classifier.mjs";

describe("TASK_VERBS regex", () => {
  test("matches common coding action verbs", () => {
    const verbs = ["build", "create", "write", "fix", "implement", "deploy", "refactor", "add", "update"];
    for (const verb of verbs) {
      assert.ok(TASK_VERBS.test(verb), `TASK_VERBS should match "${verb}"`);
    }
  });

  test("does not match generic non-action words", () => {
    assert.ok(!TASK_VERBS.test("the"), "should not match 'the'");
    assert.ok(!TASK_VERBS.test("is"), "should not match 'is'");
  });
});

describe("QUESTION_START regex", () => {
  test("matches question-opening words", () => {
    const questions = ["what is", "how does", "why is", "can you", "explain", "tell me", "show me"];
    for (const q of questions) {
      assert.ok(QUESTION_START.test(q), `QUESTION_START should match "${q}"`);
    }
  });

  test("does not match action imperatives", () => {
    assert.ok(!QUESTION_START.test("build the API"), "should not match 'build the API'");
    assert.ok(!QUESTION_START.test("write the function"), "should not match 'write the function'");
  });
});

describe("STATUS_CHECK regex", () => {
  test("matches status check phrases", () => {
    const checks = ["verify the setup", "check the health", "is it working", "confirm the status"];
    for (const c of checks) {
      assert.ok(STATUS_CHECK.test(c), `STATUS_CHECK should match "${c}"`);
    }
  });

  test("does not match plain build commands", () => {
    assert.ok(!STATUS_CHECK.test("write a new feature"), "should not match 'write a new feature'");
  });
});

describe("classifyTask", () => {
  test("returns null for short messages (< 10 words)", async () => {
    const result = await classifyTask("build the app", {});
    assert.equal(result, null);
  });

  test("returns null for messages starting with a question word", async () => {
    const msg = "What is the best way to implement authentication in Node.js?";
    const result = await classifyTask(msg, {});
    assert.equal(result, null);
  });

  test("returns null for status check messages", async () => {
    const msg = "can you verify the agents are running and check if there are any timeout issues with the system";
    const result = await classifyTask(msg, {});
    assert.equal(result, null);
  });

  test("returns null for messages with no task verbs", async () => {
    const msg = "the system is up and running and everything looks good and seems fine today";
    const result = await classifyTask(msg, {});
    assert.equal(result, null);
  });

  test("returns null when no API key configured (no network call)", async () => {
    const msg = "build a new authentication system with JWT tokens and refresh capabilities for the API";
    const result = await classifyTask(msg, { providers: {} });
    assert.equal(result, null, "should return null when no groq/cerebras key");
  });
});
