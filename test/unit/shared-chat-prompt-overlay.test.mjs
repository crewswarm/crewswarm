import test from "node:test";
import assert from "node:assert/strict";

import { getSharedChatPromptOverlay } from "../../lib/chat/shared-chat-prompt-overlay.mjs";

test("shared chat overlay tells agents to use literal @mentions for mention-system tests", () => {
  const overlay = getSharedChatPromptOverlay("crew-lead");

  assert.match(overlay, /use the @mention system/i);
  assert.match(overlay, /literal `@participant` message/i);
  assert.match(overlay, /prefer a direct in-channel line/i);
  assert.doesNotMatch(overlay, /plain `@mentions` are informational-only/i);
});
