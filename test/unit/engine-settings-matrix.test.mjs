import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { initEngineRegistry, selectEngine } from "../../lib/engines/engine-registry.mjs";
import {
  initRunners,
  shouldUseClaudeCode,
  shouldUseCodex,
  shouldUseCrewCLI,
  shouldUseCursorCli,
  shouldUseDockerSandbox,
  shouldUseGeminiCli,
  shouldUseOpenCode,
} from "../../lib/engines/runners.mjs";

function engineRunners() {
  return {
    "claude-code": async () => "ok",
    codex: async () => "ok",
    "crew-cli": async () => "ok",
    cursor: async () => "ok",
    "docker-sandbox": async () => "ok",
    "gemini-cli": async () => "ok",
    opencode: async () => "ok",
  };
}

function baseRunnerDeps(overrides = {}) {
  return {
    loadAgentList: () => [],
    getAgentOpenCodeConfig: () => ({
      enabled: false,
      useCursorCli: false,
      useClaudeCode: false,
      useCodex: false,
      useGeminiCli: false,
      useCrewCLI: false,
      useDockerSandbox: false,
    }),
    ...overrides,
  };
}

describe("engine settings matrix — selectEngine", () => {
  const matrix = [
    ["cursor", { useCursorCli: true }, "cursor"],
    ["claude-code", { useClaudeCode: true }, "claude-code"],
    ["codex", { useCodex: true }, "codex"],
    ["gemini-cli", { useGeminiCli: true }, "gemini-cli"],
    ["crew-cli", { useCrewCLI: true }, "crew-cli"],
    ["opencode", { useOpenCode: true }, "opencode"],
    ["docker-sandbox", { useDockerSandbox: true }, "docker-sandbox"],
  ];

  for (const [label, cfg, expected] of matrix) {
    it(`respects saved ${label} route`, () => {
      initEngineRegistry({
        loadAgentList: () => [{ id: "crew-coder", ...cfg }],
        engineRunners: engineRunners(),
      });

      const selected = selectEngine(
        { agentId: "crew-coder", task: "refactor the auth module" },
        "command.run_task",
      );

      assert.equal(selected?.id, expected);
    });
  }

  it("prefers explicit payload engine over saved config", () => {
    initEngineRegistry({
      loadAgentList: () => [{ id: "crew-coder", useCodex: true, codexModel: "gpt-5.3-codex" }],
      engineRunners: engineRunners(),
    });

    const selected = selectEngine(
      {
        agentId: "crew-coder",
        task: "fix lint errors",
        useCursorCli: true,
        cursorCliModel: "composer-2-fast",
      },
      "command.run_task",
    );

    assert.equal(selected?.id, "cursor");
  });

  it("uses direct LLM when agent has only a conversation model and no engine", () => {
    process.env.CREWSWARM_CODEX = "1";
    initEngineRegistry({
      loadAgentList: () => [{ id: "crew-main", model: "openai/gpt-5.4" }],
      engineRunners: engineRunners(),
    });

    const selected = selectEngine(
      { agentId: "crew-main", task: "explain the architecture" },
      "command.run_task",
    );

    assert.equal(selected, null);
    delete process.env.CREWSWARM_CODEX;
  });

  it("does not let a global env toggle override a different saved engine", () => {
    process.env.CREWSWARM_CLAUDE_CODE = "1";
    initEngineRegistry({
      loadAgentList: () => [{ id: "crew-fixer", useCrewCLI: true, crewCliModel: "openai/gpt-5.4" }],
      engineRunners: engineRunners(),
    });

    const selected = selectEngine(
      { agentId: "crew-fixer", task: "fix the failing tests" },
      "command.run_task",
    );

    assert.equal(selected?.id, "crew-cli");
    delete process.env.CREWSWARM_CLAUDE_CODE;
  });
});

describe("engine settings matrix — shouldUse* helpers", () => {
  it("keeps lower-priority engines off when a higher-priority saved engine is active", () => {
    initRunners(
      baseRunnerDeps({
        loadAgentList: () => [{ id: "crew-coder", useCursorCli: true, cursorCliModel: "composer-2-fast" }],
      }),
    );

    const payload = { agentId: "crew-coder" };
    assert.equal(shouldUseCursorCli(payload, "command.run_task"), true);
    assert.equal(shouldUseClaudeCode(payload, "command.run_task"), false);
    assert.equal(shouldUseCodex(payload, "command.run_task"), false);
    assert.equal(shouldUseGeminiCli(payload, "command.run_task"), false);
    assert.equal(shouldUseCrewCLI(payload, "command.run_task"), false);
    assert.equal(shouldUseDockerSandbox(payload, "command.run_task"), false);
  });

  it("does not activate any engine helpers for non-task events", () => {
    initRunners(baseRunnerDeps());

    const payload = { agentId: "crew-main", useCrewCLI: true, useOpenCode: true };
    assert.equal(shouldUseCrewCLI(payload, "chat.message"), false);
    assert.equal(shouldUseOpenCode(payload, "implement auth middleware", "chat.message"), false);
    assert.equal(shouldUseGeminiCli(payload, "chat.message"), false);
  });
});
