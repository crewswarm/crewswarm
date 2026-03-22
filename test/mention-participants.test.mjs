import test from "node:test";
import assert from "node:assert/strict";

import {
  detectMentionParticipants,
  resolveChatParticipant,
} from "../lib/chat/participants.mjs";
import { detectMentions } from "../lib/chat/autonomous-mentions.mjs";

test("resolves CLI participants and agent aliases", () => {
  assert.equal(resolveChatParticipant("codex")?.kind, "cli");
  assert.equal(resolveChatParticipant("claude-code")?.runtime, "claude");
  assert.equal(resolveChatParticipant("pm")?.id, "crew-pm");
});

test("detects unique mixed mentions", () => {
  const participants = detectMentionParticipants(
    "@codex inspect this and @crew-pm plan it with @pm too",
  );
  assert.deepEqual(
    participants.map((participant) => participant.id),
    ["codex", "crew-pm"],
  );
});

test("detectMentions returns canonical participant ids", () => {
  assert.deepEqual(
    detectMentions("@cursor and @crew-coder please coordinate"),
    ["cursor", "crew-coder"],
  );
});

test("detectMentions ignores mentions inside appended original task blocks", () => {
  const reply = [
    "Got it, boss! No PM action required for this @mention test.",
    "",
    "---",
    "**[ORIGINAL TASK]:**",
    "@crew-pm Hey, the user wants to test the @mention system.",
    "",
    "Does this work?",
  ].join("\n");

  assert.deepEqual(detectMentions(reply), []);
});
