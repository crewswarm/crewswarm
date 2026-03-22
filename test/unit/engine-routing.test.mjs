/**
 * Unit tests for engine routing (shouldUse*) functions from lib/engines/runners.mjs.
 * Pure logic only — no real engines, no spawning.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const invalidTypes = ["chat.message", "task.completed", "events", null, undefined, ""];

function loadRunners() {
  return import("../../lib/engines/runners.mjs");
}

function baseDeps(overrides = {}) {
  return {
    loadAgentList: () => [],
    getAgentOpenCodeConfig: () => ({
      enabled: false,
      useCursorCli: false,
      cursorCliModel: null,
      claudeCodeModel: null,
    }),
    ...overrides,
  };
}

describe("engine routing — shouldUse*", () => {
  it("returns false for non-task types", async () => {
    const {
      initRunners,
      shouldUseCursorCli,
      shouldUseClaudeCode,
      shouldUseOpenCode,
      shouldUseCodex,
      shouldUseGeminiCli,
    } = await loadRunners();
    initRunners(baseDeps());

    const payload = { runtime: "cursor", agentId: "crew-coder" };
    const prompt = "test";

    for (const t of invalidTypes) {
      assert.equal(shouldUseCursorCli(payload, t), false);
      assert.equal(shouldUseClaudeCode(payload, t), false);
      assert.equal(shouldUseOpenCode(payload, prompt, t), false);
      assert.equal(shouldUseCodex(payload, t), false);
      assert.equal(shouldUseGeminiCli(payload, t), false);
    }
  });

  it("matches cursor via runtime and agent.engine", async () => {
    const { initRunners, shouldUseCursorCli } = await loadRunners();
    initRunners(
      baseDeps({
        loadAgentList: () => [{ id: "crew-main", engine: "cursor" }],
      }),
    );
    assert.equal(shouldUseCursorCli({ runtime: "cursor" }, "command.run_task"), true);
    assert.equal(shouldUseCursorCli({ agentId: "crew-main" }, "command.run_task"), true);
  });

  it("matches claude via runtime and explicit flag", async () => {
    const { initRunners, shouldUseClaudeCode } = await loadRunners();
    initRunners(baseDeps());
    assert.equal(shouldUseClaudeCode({ runtime: "claude" }, "command.run_task"), true);
    assert.equal(shouldUseClaudeCode({ useClaudeCode: true }, "command.run_task"), true);
  });

  it("does not default to OpenCode without explicit assignment", async () => {
    const { initRunners, shouldUseOpenCode } = await loadRunners();
    initRunners(
      baseDeps({
        loadAgentList: () => [{ id: "crew-fixer" }],
        getAgentOpenCodeConfig: () => ({ enabled: false, useCursorCli: false }),
      }),
    );
    assert.equal(
      shouldUseOpenCode({ agentId: "crew-fixer" }, null, "command.run_task"),
      false,
    );
  });

  it("matches codex when claude-code is not globally enabled", async () => {
    // Save and override env to disable higher-priority engines
    const prev = process.env.CREWSWARM_CLAUDE_CODE;
    process.env.CREWSWARM_CLAUDE_CODE = "0";
    process.env.CREWSWARM_CODEX = "1";
    const { initRunners, shouldUseCodex, shouldUseClaudeCode } = await import("../../lib/engines/runners.mjs");
    initRunners(
      baseDeps({
        loadAgentList: () => [{ id: "crew-main", engine: "codex" }],
        getAgentOpenCodeConfig: () => ({
          enabled: false, useCursorCli: false, useClaudeCode: false, useCrewCLI: false,
        }),
      }),
    );
    // With Claude Code disabled, codex should match via runtime
    assert.equal(shouldUseClaudeCode({ runtime: "codex" }, "command.run_task"), false);
    assert.equal(shouldUseCodex({ runtime: "codex" }, "command.run_task"), true);
    // Restore
    if (prev !== undefined) process.env.CREWSWARM_CLAUDE_CODE = prev;
    else delete process.env.CREWSWARM_CLAUDE_CODE;
  });

});
