import test from "node:test";
import assert from "node:assert/strict";

import {
  clearThreadBinding,
  getThreadBinding,
  setThreadBinding,
} from "../../lib/chat/thread-binding.mjs";

test("stores and retrieves a thread binding", () => {
  clearThreadBinding("proj-a", "proj-a:session-1");
  const binding = setThreadBinding("proj-a", "proj-a:session-1", {
    participantId: "crew-main",
    kind: "agent",
    runtime: "groq/llama-3.3-70b-versatile",
    displayName: "crew-main",
  });
  assert.equal(binding?.participantId, "crew-main");

  const loaded = getThreadBinding("proj-a", "proj-a:session-1");
  assert.equal(loaded?.participantId, "crew-main");
  assert.equal(loaded?.runtime, "groq/llama-3.3-70b-versatile");
});
