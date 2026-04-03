/**
 * Comprehensive unit tests for lib/agents/validation.mjs
 *
 * Covers: initValidation, HOLLOW_REPLY_PATTERNS, WEASEL_ONLY_PATTERNS,
 *         validateAgentReply, validateCodingArtifacts, assertTaskPromptProtocol
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  initValidation,
  HOLLOW_REPLY_PATTERNS,
  WEASEL_ONLY_PATTERNS,
  validateAgentReply,
  validateCodingArtifacts,
  assertTaskPromptProtocol,
} from "../../lib/agents/validation.mjs";

// ── initValidation ───────────────────────────────────────────────────────────

describe("initValidation", () => {
  it("does not throw when called with no arguments", () => {
    assert.doesNotThrow(() => initValidation());
  });

  it("does not throw when called with empty object", () => {
    assert.doesNotThrow(() => initValidation({}));
  });

  it("accepts a telemetry function", () => {
    assert.doesNotThrow(() => initValidation({ telemetry: () => {} }));
  });

  it("invokes the telemetry function when assertTaskPromptProtocol fires", () => {
    let captured = null;
    initValidation({
      telemetry: (event, data) => {
        captured = { event, data };
      },
    });
    try {
      assertTaskPromptProtocol("", "test-source");
    } catch {
      // expected throw
    }
    assert.ok(captured !== null, "telemetry was not called");
    assert.equal(captured.event, "memory_protocol_missing");
    assert.equal(captured.data.source, "test-source");
    // Reset to no-op so other tests are not affected
    initValidation({ telemetry: () => {} });
  });
});

// ── HOLLOW_REPLY_PATTERNS ────────────────────────────────────────────────────

describe("HOLLOW_REPLY_PATTERNS – structure", () => {
  it("is a non-empty array", () => {
    assert.ok(Array.isArray(HOLLOW_REPLY_PATTERNS));
    assert.ok(HOLLOW_REPLY_PATTERNS.length > 0);
  });

  it("all entries are RegExp instances", () => {
    for (const pat of HOLLOW_REPLY_PATTERNS) {
      assert.ok(pat instanceof RegExp, `expected RegExp, got ${typeof pat}`);
    }
  });

  it("all patterns are case-insensitive (i flag)", () => {
    for (const pat of HOLLOW_REPLY_PATTERNS) {
      assert.ok(pat.flags.includes("i"), `pattern missing i flag: ${pat}`);
    }
  });
});

describe("HOLLOW_REPLY_PATTERNS – matches", () => {
  const shouldMatch = [
    ["As an AI, I can't do that.", "AI refusal"],
    ["as a language model, I cannot access files", "language model refusal"],
    ["As an LLM, I don't have access to that.", "LLM refusal"],
    ["I'm not able to access the filesystem.", "not able to access"],
    ["I am not able to write to disk.", "not able to write"],
    ["I'm not able to execute commands.", "not able to execute"],
    ["I don't have access to that file.", "don't have access"],
    ["I don't have permission to do that.", "don't have permission"],
    ["I don't have the ability to run that.", "don't have ability"],
    ["Please wait.", "please wait"],
    ["Hold on.", "hold on"],
    ["Stand by!", "stand by"],
    ["I'll get that for you", "I'll get that"],
    ["I'll check that for you", "I'll check that for you"],
    ["I'll fetch that for you", "I'll fetch that"],
    ["I'll read that for you", "I'll read that"],
    ["I do not have any tools to write files.", "do not have tools to write"],
    ["I don't have capabilities to execute.", "don't have capabilities to execute"],
    ["Invalid Realtime Token", "invalid realtime token"],
    ["realtime daemon error: connection refused", "realtime daemon error"],
  ];

  for (const [text, label] of shouldMatch) {
    it(`matches: ${label}`, () => {
      const matched = HOLLOW_REPLY_PATTERNS.some((p) => p.test(text));
      assert.ok(matched, `No pattern matched: "${text}"`);
    });
  }
});

describe("HOLLOW_REPLY_PATTERNS – non-matches", () => {
  const shouldNotMatch = [
    "Here is the code you requested.",
    "I have written the file to disk.",
    "Done. The function has been updated.",
    "The authentication module is complete.",
    "@@WRITE_FILE /tmp/hello.js\nconsole.log('hi');\n@@END_FILE",
    "Successfully created 3 files.",
  ];

  for (const text of shouldNotMatch) {
    it(`does not match: "${text.slice(0, 50)}"`, () => {
      const matched = HOLLOW_REPLY_PATTERNS.some((p) => p.test(text));
      assert.ok(!matched, `Unexpected pattern match for: "${text}"`);
    });
  }
});

// ── WEASEL_ONLY_PATTERNS ─────────────────────────────────────────────────────

describe("WEASEL_ONLY_PATTERNS – structure", () => {
  it("is a non-empty array", () => {
    assert.ok(Array.isArray(WEASEL_ONLY_PATTERNS));
    assert.ok(WEASEL_ONLY_PATTERNS.length > 0);
  });

  it("all entries are RegExp instances with i flag", () => {
    for (const pat of WEASEL_ONLY_PATTERNS) {
      assert.ok(pat instanceof RegExp);
      assert.ok(pat.flags.includes("i"));
    }
  });
});

describe("WEASEL_ONLY_PATTERNS – matches", () => {
  const weaselPhrases = [
    "I will implement this feature.",
    "I would do that if I could.",
    "I can handle that task.",
    "I could refactor this.",
    "I should update the file.",
    "I might be able to help.",
    "I plan to implement it.",
    "I recommend using TypeScript.",
    "I suggest we start with tests.",
  ];

  for (const text of weaselPhrases) {
    it(`matches weasel phrase: "${text}"`, () => {
      const matched = WEASEL_ONLY_PATTERNS.every((p) => p.test(text));
      assert.ok(matched, `Weasel pattern did not match: "${text}"`);
    });
  }
});

// ── validateAgentReply ───────────────────────────────────────────────────────

describe("validateAgentReply – empty / missing replies", () => {
  it("rejects empty string", () => {
    const r = validateAgentReply("", "task", "do something");
    assert.equal(r.valid, false);
    assert.match(r.reason, /empty/i);
  });

  it("rejects null", () => {
    const r = validateAgentReply(null, "task", "do something");
    assert.equal(r.valid, false);
  });

  it("rejects undefined", () => {
    const r = validateAgentReply(undefined, "task", "do something");
    assert.equal(r.valid, false);
  });

  it("rejects whitespace-only string", () => {
    const r = validateAgentReply("   \n\t  ", "task", "do something");
    assert.equal(r.valid, false);
  });

  it("rejects very short reply (< 15 chars) without exact-output prompt", () => {
    const r = validateAgentReply("ok done.", "code", "write a file");
    assert.equal(r.valid, false);
    assert.match(r.reason, /empty|short/i);
  });
});

describe("validateAgentReply – exact-output prompt bypass", () => {
  const exactPrompts = [
    "Reply with exactly SWARM_ROUTE_OK and nothing else.",
    "Respond with exactly the word 'yes'",
    "Output only the number",
    "Return only true or false",
    "Reply only with the status code",
  ];

  for (const prompt of exactPrompts) {
    it(`allows short reply for: "${prompt.slice(0, 50)}"`, () => {
      const r = validateAgentReply("YES", "task", prompt);
      assert.equal(r.valid, true, `should pass for exact-output prompt: ${prompt}`);
    });
  }

  it("does not bypass hollow pattern check for exact-output prompt", () => {
    const r = validateAgentReply(
      "As an AI, I can't do that.",
      "task",
      "Reply with exactly what you can do and nothing else.",
    );
    assert.equal(r.valid, false);
  });
});

describe("validateAgentReply – hollow pattern rejection", () => {
  // These are all long enough (>= 15 chars) to pass the length gate so the
  // hollow-pattern check is the one that rejects them.
  const hollowReplies = [
    ["As an AI, I cannot access the filesystem.", "write hello.js"],
    ["As a language model, I don't have permission to do that.", "create a file"],
    ["I'm not able to execute that command.", "run npm install"],
    ["I don't have access to write files.", "update auth.js"],
    ["I'll get that for you", "fetch the data"],
    ["invalid realtime token — please try again", "connect to the service"],
  ];

  for (const [reply, prompt] of hollowReplies) {
    it(`rejects hollow reply: "${reply.slice(0, 50)}"`, () => {
      const r = validateAgentReply(reply, "code", prompt);
      assert.equal(r.valid, false);
      assert.match(r.reason, /hollow/i);
    });
  }

  it("rejects very short 'please wait' style reply (length check fires first)", () => {
    // These are < 15 chars so valid=false regardless; reason is 'too short'
    const r = validateAgentReply("Please wait.", "code", "process the request");
    assert.equal(r.valid, false);
    assert.match(r.reason, /short|empty/i);
  });
});

describe("validateAgentReply – valid replies", () => {
  it("accepts a long coding reply with action tool output", () => {
    const r = validateAgentReply(
      "I've written the file at /tmp/hello.js.\n\n```js\nconsole.log('hello');\n```\n\n@@WRITE_FILE /tmp/hello.js\nconsole.log('hello');\n@@END_FILE",
      "code",
      "write hello.js",
    );
    assert.equal(r.valid, true);
  });

  it("accepts a long planning reply", () => {
    const r = validateAgentReply(
      "Here is a detailed plan for your project. First, we will set up the infrastructure. Then we will implement the core features. After that, we will test everything thoroughly and deploy to production.",
      "task",
      "plan the project",
    );
    assert.equal(r.valid, true);
    assert.equal(r.reason, "ok");
  });

  it("accepts a reply with action evidence token (done)", () => {
    const r = validateAgentReply(
      "I will implement this — done, wrote auth.js successfully.",
      "code",
      "write a new auth module",
    );
    assert.equal(r.valid, true);
  });

  it("accepts a reply with @@READ_FILE action evidence", () => {
    const r = validateAgentReply(
      "I will read the file — @@READ_FILE /tmp/config.json",
      "code",
      "read the config",
    );
    assert.equal(r.valid, true);
  });

  it("accepts a reply with checkmark action evidence", () => {
    const r = validateAgentReply(
      "I will build this — ✅ created the module",
      "code",
      "build auth module",
    );
    assert.equal(r.valid, true);
  });

  it("accepts a reply with 'updated' action evidence", () => {
    const r = validateAgentReply(
      "I will update this — updated the function",
      "code",
      "update auth function",
    );
    assert.equal(r.valid, true);
  });

  it("accepts a reply with 'complete' action evidence", () => {
    const r = validateAgentReply(
      "I will finish this — complete, all tests pass",
      "code",
      "implement the feature",
    );
    assert.equal(r.valid, true);
  });
});

describe("validateAgentReply – short coding weasel rejection", () => {
  it("rejects short coding reply that is all weasel words with no action", () => {
    const r = validateAgentReply(
      "I will implement this for you.",
      "code",
      "write a new auth module",
    );
    assert.equal(r.valid, false);
    assert.match(r.reason, /weasel/i);
  });

  it("does not weasel-reject a long coding reply (>= 300 chars)", () => {
    const longReply = "I will implement this. "
      .repeat(20)
      .padEnd(320, "x");
    const r = validateAgentReply(longReply, "code", "write auth module");
    assert.equal(r.valid, true);
  });

  it("does not weasel-reject a non-coding prompt", () => {
    const r = validateAgentReply(
      "I will summarise this for you.",
      "task",
      "summarise the document",
    );
    // Not a coding prompt so weasel check is skipped; but reply is < 15 chars
    // after trim... no, 30 chars so length passes; no hollow pattern — should pass
    assert.equal(r.valid, true);
  });
});

describe("validateAgentReply – return shape", () => {
  it("always returns an object with valid (boolean) and reason (string)", () => {
    const cases = [
      ["", "code", "write file"],
      ["some text here that is long enough", "task", "do something"],
      [null, "code", "build"],
    ];
    for (const [reply, type, prompt] of cases) {
      const r = validateAgentReply(reply, type, prompt);
      assert.equal(typeof r.valid, "boolean");
      assert.equal(typeof r.reason, "string");
    }
  });

  it("reason is 'ok' for valid replies", () => {
    const r = validateAgentReply(
      "Here is a comprehensive answer to your question with sufficient detail.",
      "task",
      "explain the concept",
    );
    assert.equal(r.valid, true);
    assert.equal(r.reason, "ok");
  });
});

// ── validateCodingArtifacts ──────────────────────────────────────────────────

describe("validateCodingArtifacts", () => {
  it("delegates to validateAgentReply (same result for hollow reply)", () => {
    const r1 = validateAgentReply("As an AI, I cannot do this.", "code", "build");
    const r2 = validateCodingArtifacts("As an AI, I cannot do this.", "code", "build", {});
    assert.equal(r1.valid, r2.valid);
    assert.equal(r1.valid, false);
  });

  it("delegates to validateAgentReply (same result for valid reply)", () => {
    const longReply = "I have completed the implementation. The new auth module has been written to disk. All edge cases are handled with proper error handling and unit tests included.\n\n@@WRITE_FILE /src/auth.js\nexport function auth() {}\n@@END_FILE";
    const r1 = validateAgentReply(longReply, "code", "write auth module");
    const r2 = validateCodingArtifacts(longReply, "code", "write auth module", { payload: "extra" });
    assert.equal(r1.valid, r2.valid);
    assert.equal(r1.valid, true);
  });

  it("ignores the payload argument gracefully", () => {
    assert.doesNotThrow(() =>
      validateCodingArtifacts("A valid response that is long enough", "task", "do something", null),
    );
  });

  it("returns object with valid and reason", () => {
    const r = validateCodingArtifacts("Short", "code", "build", {});
    assert.equal(typeof r.valid, "boolean");
    assert.equal(typeof r.reason, "string");
  });
});

// ── assertTaskPromptProtocol ─────────────────────────────────────────────────

describe("assertTaskPromptProtocol – throws on bad input", () => {
  it("throws MEMORY_PROTOCOL_MISSING for empty string", () => {
    assert.throws(
      () => assertTaskPromptProtocol(""),
      (err) => err.message === "MEMORY_PROTOCOL_MISSING",
    );
  });

  it("throws for null", () => {
    assert.throws(
      () => assertTaskPromptProtocol(null),
      (err) => err.message === "MEMORY_PROTOCOL_MISSING",
    );
  });

  it("throws for undefined", () => {
    assert.throws(
      () => assertTaskPromptProtocol(undefined),
      (err) => err.message === "MEMORY_PROTOCOL_MISSING",
    );
  });

  it("throws for non-string value (number)", () => {
    assert.throws(
      () => assertTaskPromptProtocol(42),
      (err) => err.message === "MEMORY_PROTOCOL_MISSING",
    );
  });

  it("throws for non-string value (object)", () => {
    assert.throws(
      () => assertTaskPromptProtocol({ text: "prompt" }),
      (err) => err.message === "MEMORY_PROTOCOL_MISSING",
    );
  });

  it("throws for the sentinel value MEMORY_LOAD_FAILED", () => {
    assert.throws(
      () => assertTaskPromptProtocol("MEMORY_LOAD_FAILED"),
      (err) => err.message === "MEMORY_PROTOCOL_MISSING",
    );
  });
});

describe("assertTaskPromptProtocol – passes on valid input", () => {
  it("does not throw for a non-empty string prompt", () => {
    assert.doesNotThrow(() =>
      assertTaskPromptProtocol("You are a helpful assistant. Please implement the feature."),
    );
  });

  it("does not throw for a single-character prompt", () => {
    assert.doesNotThrow(() => assertTaskPromptProtocol("x"));
  });

  it("uses default source parameter 'task'", () => {
    // Should not throw, source defaults to 'task'
    assert.doesNotThrow(() =>
      assertTaskPromptProtocol("Valid system prompt goes here."),
    );
  });

  it("accepts explicit source parameter", () => {
    assert.doesNotThrow(() =>
      assertTaskPromptProtocol("Valid system prompt.", "custom-source"),
    );
  });
});

describe("assertTaskPromptProtocol – telemetry integration", () => {
  it("passes source to telemetry on failure", () => {
    const events = [];
    initValidation({
      telemetry: (event, data) => events.push({ event, data }),
    });

    try { assertTaskPromptProtocol("", "my-source"); } catch { /* expected */ }

    assert.ok(events.length > 0);
    assert.equal(events[0].event, "memory_protocol_missing");
    assert.equal(events[0].data.source, "my-source");

    // Reset
    initValidation({ telemetry: () => {} });
  });

  it("does not call telemetry for a valid prompt", () => {
    const events = [];
    initValidation({
      telemetry: (event, data) => events.push({ event, data }),
    });

    assertTaskPromptProtocol("Valid prompt text.");
    assert.equal(events.length, 0, "telemetry should not fire for valid prompt");

    initValidation({ telemetry: () => {} });
  });
});
