import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseServiceIntent,
  messageNeedsSearch,
  isDispatchIntended,
  DISPATCH_INTENT_REQUIRED,
  DISPATCH_NEVER_PATTERNS,
} from "../../lib/crew-lead/intent.mjs";

describe("parseServiceIntent", () => {
  test("parses 'restart all agents'", () => {
    const r = parseServiceIntent("restart all agents");
    assert.equal(r.action, "restart");
    assert.equal(r.id, "agents");
  });

  test("parses 'restart telegram'", () => {
    const r = parseServiceIntent("restart the telegram bridge");
    assert.equal(r.action, "restart");
    assert.equal(r.id, "telegram");
  });

  test("parses 'restart crew-coder'", () => {
    const r = parseServiceIntent("restart crew-coder");
    assert.equal(r.action, "restart");
    assert.equal(r.id, "crew-coder");
  });

  test("parses 'stop telegram'", () => {
    const r = parseServiceIntent("stop the telegram bot");
    assert.equal(r.action, "stop");
    assert.equal(r.id, "telegram");
  });

  test("parses 'bring agents back online'", () => {
    const r = parseServiceIntent("bring agents back online");
    assert.equal(r.action, "restart");
    assert.equal(r.id, "agents");
  });

  test("returns null for unrelated messages", () => {
    assert.equal(parseServiceIntent("write a login page"), null);
    assert.equal(parseServiceIntent("what is the weather today"), null);
    assert.equal(parseServiceIntent(""), null);
  });
});

describe("messageNeedsSearch", () => {
  test("returns true for 'search for' phrases", () => {
    assert.equal(messageNeedsSearch("search for the latest news"), true);
    assert.equal(messageNeedsSearch("go search typescript docs"), true);
    assert.equal(messageNeedsSearch("look up the API docs"), true);
  });

  test("returns false for delegation patterns", () => {
    assert.equal(messageNeedsSearch("ask crew-researcher to search for docs"), false);
    assert.equal(messageNeedsSearch("tell the pm to research this"), false);
  });

  test("returns false for very short messages", () => {
    assert.equal(messageNeedsSearch("hi"), false);
    assert.equal(messageNeedsSearch("ok"), false);
  });

  test("returns false for messages without search triggers", () => {
    assert.equal(messageNeedsSearch("build the new dashboard"), false);
    assert.equal(messageNeedsSearch("how does this work?"), false);
  });
});

describe("DISPATCH_INTENT_REQUIRED", () => {
  test("all entries are RegExp", () => {
    for (const p of DISPATCH_INTENT_REQUIRED) {
      assert.ok(p instanceof RegExp);
    }
  });

  test("matches 'go build' pattern", () => {
    assert.ok(DISPATCH_INTENT_REQUIRED.some(re => re.test("go build the new feature")));
  });

  test("matches 'have crew-coder write' pattern", () => {
    assert.ok(DISPATCH_INTENT_REQUIRED.some(re => re.test("have crew-coder write the API")));
  });

  test("matches 'dispatch to crew-pm' pattern", () => {
    assert.ok(DISPATCH_INTENT_REQUIRED.some(re => re.test("dispatch to crew-pm the roadmap task")));
  });
});

describe("DISPATCH_NEVER_PATTERNS", () => {
  test("all entries are RegExp", () => {
    for (const p of DISPATCH_NEVER_PATTERNS) {
      assert.ok(p instanceof RegExp);
    }
  });

  test("matches simple greetings", () => {
    assert.ok(DISPATCH_NEVER_PATTERNS.some(re => re.test("hi")));
    assert.ok(DISPATCH_NEVER_PATTERNS.some(re => re.test("ok")));
  });

  test("matches questions", () => {
    assert.ok(DISPATCH_NEVER_PATTERNS.some(re => re.test("what is the plan?")));
    assert.ok(DISPATCH_NEVER_PATTERNS.some(re => re.test("how does this work?")));
  });
});

describe("isDispatchIntended", () => {
  test("returns false for empty/null input", () => {
    assert.equal(isDispatchIntended(""), false);
    assert.equal(isDispatchIntended(null), false);
  });

  test("returns false for single-word greetings", () => {
    assert.equal(isDispatchIntended("hi"), false);
    assert.equal(isDispatchIntended("ok"), false);
    assert.equal(isDispatchIntended("yes"), false);
  });

  test("returns false for questions", () => {
    assert.equal(isDispatchIntended("what is the status of the build?"), false);
    assert.equal(isDispatchIntended("how does the pipeline work?"), false);
  });

  test("returns true for explicit 'go build' directive", () => {
    assert.equal(isDispatchIntended("go build the new API endpoint"), true);
  });

  test("returns true for 'have crew-X do' pattern", () => {
    assert.equal(isDispatchIntended("have crew-coder write the auth module"), true);
  });

  test("returns true for 'tell crew-X to' pattern", () => {
    assert.equal(isDispatchIntended("tell crew-qa to audit the codebase"), true);
  });

  test("returns false for short messages without dispatch patterns", () => {
    assert.equal(isDispatchIntended("nice job"), false);
    assert.equal(isDispatchIntended("looks good"), false);
  });
});
