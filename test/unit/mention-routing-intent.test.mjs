import test from "node:test";
import assert from "node:assert/strict";

import {
  classifySharedChatMention,
  hasExplicitHandoffChatIntent,
  hasExplicitWorkIntent,
  hasSpecificWorkOrder,
  stripMentionHandles,
} from "../../lib/chat/mention-routing-intent.mjs";

test("treats casual single-agent mentions as direct chat", () => {
  const result = classifySharedChatMention("@crew-researcher what's good?");
  assert.equal(result.mode, "direct");
  assert.equal(result.targetAgent, "crew-researcher");
  assert.equal(result.directMessage, "what's good?");
});

test("treats explicit work phrasing as dispatch intent", () => {
  const result = classifySharedChatMention(
    "@crew-researcher research pricing for Cursor",
  );
  assert.equal(result.mode, "dispatch");
  assert.equal(result.targetAgent, "crew-researcher");
});

test("requires a specific work order before auto-dispatching", () => {
  assert.equal(hasExplicitWorkIntent("@crew-coder-back get on it"), false);
  assert.equal(hasSpecificWorkOrder("@crew-coder-back get on it"), false);

  const result = classifySharedChatMention("@crew-coder-back get on it");
  assert.equal(result.mode, "direct");
  assert.equal(result.targetAgent, "crew-coder-back");
});

test("treats a note to crew-lead as direct chat", () => {
  const result = classifySharedChatMention(
    "@crew-lead note this for later: browser automation needs exact work orders",
  );
  assert.equal(result.mode, "direct");
  assert.equal(result.targetAgent, "crew-lead");
});

test("treats handoff phrasing as direct chat for a single mentioned agent", () => {
  const result = classifySharedChatMention(
    "@crew-researcher ask crew-pm to review your findings",
  );
  assert.equal(result.mode, "direct");
  assert.equal(result.targetAgent, "crew-researcher");
  assert.equal(
    hasExplicitHandoffChatIntent(
      "@crew-researcher ask crew-pm to review your findings",
    ),
    true,
  );
});

test("keeps strong execution requests as dispatch even if they include a later send-to phrase", () => {
  const result = classifySharedChatMention(
    "@crew-researcher research OpenClaw and then send your findings to crew-pm",
  );
  assert.equal(result.mode, "dispatch");
});

test("treats send findings to another agent as direct chat", () => {
  const result = classifySharedChatMention(
    "@crew-researcher send your findings to crew-pm",
  );
  assert.equal(result.mode, "direct");
});

test("treats speculative kickoff questions as direct chat, not dispatch", () => {
  const result = classifySharedChatMention(
    "Next? @crew-main kick off browser automation phase?",
  );
  assert.equal(result.mode, "direct");
  assert.equal(result.targetAgent, "crew-main");
});

test("treats single CLI mentions as direct chat", () => {
  const result = classifySharedChatMention("@codex hi");
  assert.equal(result.mode, "direct");
  assert.equal(result.targetParticipant?.id, "codex");
  assert.equal(result.targetParticipant?.kind, "cli");
});

test("treats explicit single CLI work orders as dispatch", () => {
  const result = classifySharedChatMention(
    "@claude inspect /tmp/demo.js and explain the bug",
  );
  assert.equal(result.mode, "dispatch");
  assert.equal(result.targetParticipant?.id, "claude");
  assert.equal(result.targetParticipant?.kind, "cli");
});

test("expands @crew-all into a direct fanout broadcast", () => {
  const result = classifySharedChatMention("@crew-all hi team");
  assert.equal(result.mode, "direct_multi");
  assert.ok(result.targetParticipants.length > 2);
  assert.ok(result.targetParticipants.some((participant) => participant.id === "crew-main"));
  assert.ok(result.targetParticipants.every((participant) => participant.kind === "agent"));
});

test("does not classify multiple mentions as direct chat", () => {
  const result = classifySharedChatMention("@crew-pm and @crew-coder check this");
  assert.equal(result.mode, "direct_multi");
  assert.deepEqual(result.targetAgents, ["crew-pm", "crew-coder"]);
});

test("strips mention handles before intent detection", () => {
  assert.equal(stripMentionHandles("@crew-coder hi there"), "hi there");
  assert.equal(hasExplicitWorkIntent("@crew-coder hi there"), false);
});
