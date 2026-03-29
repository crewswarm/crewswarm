import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { initEngineRegistry, selectEngine } from "../../lib/engines/engine-registry.mjs";

describe("engine-registry selection", () => {
  it("matches agent.engine assignments", () => {
    initEngineRegistry({
      loadAgentList: () => [{ id: "crew-main", engine: "codex" }],
      engineRunners: {
        codex: async () => "ok",
      },
    });

    const selected = selectEngine(
      { agentId: "crew-main", agent: "crew-main", engine: "codex", prompt: "implement a new function" },
      "command.run_task",
    );

    assert.ok(selected, "expected an engine to be selected");
    assert.equal(selected.id, "codex");
  });
});
