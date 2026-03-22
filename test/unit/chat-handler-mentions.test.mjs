import test from "node:test";
import assert from "node:assert/strict";

import { shouldForceMentionReply } from "../../lib/crew-lead/chat-handler.mjs";

test("forces retry when user asks to use mention system but reply has no literal mention", () => {
  const result = shouldForceMentionReply({
    message:
      "you dispatched - didnt use the @mention system - the at mention you only use @ and then the crew-name and you can chat with them - try it",
    reply:
      "You're right, I messed that one up. What do you want me to ask or say to an agent using the @mention system?",
    channelMode: true,
  });

  assert.equal(result, true);
});

test("does not force retry when reply already contains a literal @mention", () => {
  const result = shouldForceMentionReply({
    message: "try again and use the @mention system",
    reply: "@crew-main acknowledge this with a short reply",
    channelMode: true,
  });

  assert.equal(result, false);
});

test("does not force retry outside shared chat mode", () => {
  const result = shouldForceMentionReply({
    message: "use the @mention system",
    reply: "I can do that.",
    channelMode: false,
  });

  assert.equal(result, false);
});
