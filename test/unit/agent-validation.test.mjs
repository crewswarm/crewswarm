import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  validateAgentReply,
  validateCodingArtifacts,
  HOLLOW_REPLY_PATTERNS,
  WEASEL_ONLY_PATTERNS,
} from "../../lib/agents/validation.mjs";

describe("HOLLOW_REPLY_PATTERNS", () => {
  test("all patterns are RegExp objects", () => {
    assert.ok(Array.isArray(HOLLOW_REPLY_PATTERNS));
    for (const p of HOLLOW_REPLY_PATTERNS) {
      assert.ok(p instanceof RegExp, `expected RegExp, got ${typeof p}`);
    }
  });

  test("matches AI refusal pattern", () => {
    const text = "As an AI, I can't do that.";
    const matched = HOLLOW_REPLY_PATTERNS.some(p => p.test(text));
    assert.ok(matched, `No HOLLOW_REPLY pattern matched: "${text}"`);
  });

  test("matches 'I am not able to write' pattern", () => {
    const text = "I'm not able to write files directly.";
    const matched = HOLLOW_REPLY_PATTERNS.some(p => p.test(text));
    assert.ok(matched);
  });
});

describe("validateAgentReply", () => {
  test("rejects empty reply", () => {
    const r = validateAgentReply("", "code", "write a file");
    assert.equal(r.valid, false);
    assert.match(r.reason, /empty/i);
  });

  test("rejects reply shorter than 15 chars", () => {
    const r = validateAgentReply("ok done.", "code", "write a file");
    assert.equal(r.valid, false);
  });

  test("rejects hollow AI refusal", () => {
    const r = validateAgentReply(
      "As an AI, I cannot access the filesystem.",
      "code",
      "write hello.js"
    );
    assert.equal(r.valid, false);
  });

  test("accepts a valid code reply", () => {
    const r = validateAgentReply(
      "I've written the file at /tmp/hello.js.\n\n```js\nconsole.log('hello');\n```\n\n@@WRITE_FILE /tmp/hello.js\nconsole.log('hello');\n@@END_FILE",
      "code",
      "write hello.js"
    );
    assert.equal(r.valid, true);
  });

  test("accepts a long non-coding reply", () => {
    const r = validateAgentReply(
      "Here is a detailed plan for your project. First, we will set up the infrastructure. Then we will implement the core features. After that, we will test everything thoroughly and deploy to production.",
      "task",
      "plan the project"
    );
    assert.equal(r.valid, true);
  });

  test("rejects short coding reply with only weasel words and no action", () => {
    const r = validateAgentReply(
      "I will implement this for you.",
      "code",
      "write a new auth module"
    );
    assert.equal(r.valid, false);
  });

  test("accepts short coding reply that contains action evidence", () => {
    const r = validateAgentReply(
      "I will implement this — done ✅ wrote auth.js",
      "code",
      "write a new auth module"
    );
    assert.equal(r.valid, true);
  });
});

describe("validateCodingArtifacts", () => {
  test("delegates to validateAgentReply", () => {
    const r1 = validateAgentReply("As an AI, I cannot do this.", "code", "build");
    const r2 = validateCodingArtifacts("As an AI, I cannot do this.", "code", "build", {});
    assert.equal(r1.valid, r2.valid);
  });
});
