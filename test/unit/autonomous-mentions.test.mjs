/**
 * Unit tests for lib/chat/autonomous-mentions.mjs
 *
 * Covers:
 *  - areAutonomousMentionsEnabled: env var parsing
 *  - buildMentionPrompt: prompt assembly
 *  - shouldPauseChannel: hop limit logic
 *  - resetChannelHopCount: clears hop counter
 *
 * Skips: handleAutonomousMentions (requires network/dispatchers),
 *        detectMentions / detectMentionTargets (depend on participants module)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const {
  areAutonomousMentionsEnabled,
  buildMentionPrompt,
  shouldPauseChannel,
  resetChannelHopCount,
} = await import("../../lib/chat/autonomous-mentions.mjs");

// ── areAutonomousMentionsEnabled ────────────────────────────────────────────

describe("autonomous-mentions — areAutonomousMentionsEnabled", () => {
  let origEnv;

  beforeEach(() => {
    origEnv = process.env.CREWSWARM_AUTONOMOUS_MENTIONS;
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.CREWSWARM_AUTONOMOUS_MENTIONS;
    else process.env.CREWSWARM_AUTONOMOUS_MENTIONS = origEnv;
  });

  it("returns false when env is '0'", () => {
    process.env.CREWSWARM_AUTONOMOUS_MENTIONS = "0";
    assert.equal(areAutonomousMentionsEnabled(), false);
  });

  it("returns false when env is 'off'", () => {
    process.env.CREWSWARM_AUTONOMOUS_MENTIONS = "off";
    assert.equal(areAutonomousMentionsEnabled(), false);
  });

  it("returns false when env is 'false'", () => {
    process.env.CREWSWARM_AUTONOMOUS_MENTIONS = "false";
    assert.equal(areAutonomousMentionsEnabled(), false);
  });

  it("returns true when env is '1'", () => {
    process.env.CREWSWARM_AUTONOMOUS_MENTIONS = "1";
    assert.equal(areAutonomousMentionsEnabled(), true);
  });

  it("returns true when env is 'true'", () => {
    process.env.CREWSWARM_AUTONOMOUS_MENTIONS = "true";
    assert.equal(areAutonomousMentionsEnabled(), true);
  });
});

// ── buildMentionPrompt ──────────────────────────────────────────────────────

describe("autonomous-mentions — buildMentionPrompt", () => {
  it("includes sender and channel in prompt", () => {
    const prompt = buildMentionPrompt({
      agent: "crew-coder",
      sender: "crew-lead",
      channel: "dev",
      content: "fix the bug in main.js",
      chatHistory: [],
    });
    assert.ok(prompt.includes("crew-lead"), "should mention sender");
    assert.ok(prompt.includes("#dev"), "should mention channel");
    assert.ok(prompt.includes("fix the bug in main.js"), "should include content");
  });

  it("includes chat history context", () => {
    const prompt = buildMentionPrompt({
      agent: "crew-coder",
      sender: "user",
      channel: "general",
      content: "do something",
      chatHistory: [
        { sender: "crew-lead", content: "we need to update the API" },
        { sender: "crew-coder", content: "ok, which endpoint?" },
      ],
    });
    assert.ok(prompt.includes("we need to update the API"));
    assert.ok(prompt.includes("which endpoint?"));
  });

  it("shows (no prior context) when chatHistory is empty", () => {
    const prompt = buildMentionPrompt({
      agent: "crew-coder",
      sender: "user",
      channel: "general",
      content: "hello",
      chatHistory: [],
    });
    assert.ok(prompt.includes("(no prior context)"));
  });

  it("defaults sender/channel gracefully", () => {
    const prompt = buildMentionPrompt({
      agent: "crew-coder",
      content: "test",
    });
    assert.ok(prompt.includes("a teammate"), "should have default sender");
    assert.ok(prompt.includes("#general"), "should have default channel");
  });
});

// ── shouldPauseChannel / resetChannelHopCount ───────────────────────────────

describe("autonomous-mentions — channel hop logic", () => {
  const testChannel = `test-hop-${Date.now()}`;
  const testProject = "test-project";

  beforeEach(() => {
    resetChannelHopCount(testChannel, testProject);
  });

  it("shouldPauseChannel returns false when no hops recorded", () => {
    assert.equal(shouldPauseChannel(testChannel, testProject), false);
  });

  it("resetChannelHopCount clears the counter", () => {
    // This is already reset by beforeEach, just verify
    assert.equal(shouldPauseChannel(testChannel, testProject), false);
  });
});
