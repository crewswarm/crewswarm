import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { resetPaths } from "../lib/runtime/paths.mjs";

import {
  clearProjectMessages,
  loadProjectMessages,
  saveProjectMessage,
} from "../lib/chat/project-messages.mjs";

const PROJECT_ID = "test-chat-protocol";

beforeEach(() => {
  process.env.CREWSWARM_TEST_MODE = "true";
  resetPaths();
  clearProjectMessages(PROJECT_ID);
});

after(() => {
  process.env.CREWSWARM_TEST_MODE = "true";
  resetPaths();
  clearProjectMessages(PROJECT_ID);
});

test("filters messages by mentioned agent", () => {
  saveProjectMessage(PROJECT_ID, {
    source: "dashboard",
    role: "user",
    content: "@crew-main check this",
    metadata: { mentions: ["crew-main"] },
  });
  saveProjectMessage(PROJECT_ID, {
    source: "dashboard",
    role: "assistant",
    content: "plain reply",
    metadata: {},
  });

  const messages = loadProjectMessages(PROJECT_ID, {
    mentionedAgent: "crew-main",
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, "@crew-main check this");
});

test("filters messages by thread id", () => {
  saveProjectMessage(PROJECT_ID, {
    source: "dashboard",
    role: "user",
    content: "thread a",
    threadId: "thread-a",
  });
  saveProjectMessage(PROJECT_ID, {
    source: "dashboard",
    role: "assistant",
    content: "thread b",
    threadId: "thread-b",
  });

  const messages = loadProjectMessages(PROJECT_ID, {
    threadId: "thread-a",
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].threadId, "thread-a");
});
