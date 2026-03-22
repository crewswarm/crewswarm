import test from "node:test";
import assert from "node:assert/strict";
import {
  wantsDeterministicAgentRoster,
  formatDeterministicAgentRoster,
} from "../../lib/crew-lead/chat-handler.mjs";

test("wantsDeterministicAgentRoster — user phrasing from production", () => {
  assert.equal(
    wantsDeterministicAgentRoster(
      "full agent list - one line pr agent - name - role - model",
    ),
    true,
  );
  assert.equal(wantsDeterministicAgentRoster("yo"), false);
  assert.equal(wantsDeterministicAgentRoster("list all agents"), true);
});

test("formatDeterministicAgentRoster — one line per agent incl. crew-lead", () => {
  const cfg = {
    providerKey: "xai",
    modelId: "grok-test",
    displayName: "Stinki",
    emoji: "🧠",
    agentRoster: [
      {
        id: "crew-main",
        name: "Main",
        emoji: "🦊",
        role: "",
        model: "groq/llama",
      },
      {
        id: "crew-pm",
        name: "PM",
        emoji: "",
        role: "custom role",
        model: "anthropic/claude",
      },
    ],
  };
  const out = formatDeterministicAgentRoster(cfg);
  assert.match(out, /crew-lead.*coordinator.*xai\/grok-test/);
  assert.match(out, /crew-main.*main coordinator.*groq\/llama/);
  assert.match(out, /crew-pm.*custom role.*anthropic\/claude/);
  const linesInBlock = out.match(/```\n([\s\S]*)\n```/)[1].split("\n");
  assert.equal(linesInBlock.length, 3);
});
