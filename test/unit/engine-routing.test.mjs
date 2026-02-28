/**
 * Unit tests for engine routing (shouldUse*) functions from lib/engines/runners.mjs.
 * Pure logic only — no real engines, no spawning.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");

const validTypes = ["command.run_task", "task.assigned"];
const invalidTypes = ["chat.message", "task.completed", "events", null, undefined, ""];

function loadRunners() {
  return import("../../lib/engines/runners.mjs");
}

describe("engine routing — shouldUse*", () => {
  describe("wrong incomingType → all return false", () => {
    it("returns false for non-task types", async () => {
      const { initRunners, shouldUseCursorCli, shouldUseClaudeCode, shouldUseOpenCode, shouldUseCodex, shouldUseGeminiCli } = await loadRunners();
      initRunners({});

      const payload = { runtime: "cursor", agentId: "crew-coder" };
      const prompt = "test";

      for (const t of invalidTypes) {
        assert.equal(shouldUseCursorCli(payload, t), false, `shouldUseCursorCli with type ${t}`);
        assert.equal(shouldUseClaudeCode(payload, t), false, `shouldUseClaudeCode with type ${t}`);
        assert.equal(shouldUseOpenCode(payload, prompt, t), false, `shouldUseOpenCode with type ${t}`);
        assert.equal(shouldUseCodex(payload, t), false, `shouldUseCodex with type ${t}`);
        assert.equal(shouldUseGeminiCli(payload, t), false, `shouldUseGeminiCli with type ${t}`);
      }
    });
  });

  describe("shouldUseCursorCli", () => {
    it("payload.runtime = 'cursor' → returns true", async () => {
      const { initRunners, shouldUseCursorCli } = await loadRunners();
      initRunners({});
      assert.equal(shouldUseCursorCli({ runtime: "cursor" }, "command.run_task"), true);
      assert.equal(shouldUseCursorCli({ runtime: "cursor-cli" }, "task.assigned"), true);
    });

    it("payload.useCursorCli = true → returns true", async () => {
      const { initRunners, shouldUseCursorCli } = await loadRunners();
      initRunners({});
      assert.equal(shouldUseCursorCli({ useCursorCli: true }, "command.run_task"), true);
    });

    it("agent config injection: _getAgentOpenCodeConfig returns useCursorCli:true → returns true", async () => {
      const { initRunners, shouldUseCursorCli } = await loadRunners();
      initRunners({
        getAgentOpenCodeConfig: (agentId) =>
          agentId === "crew-coder-front" ? { useCursorCli: true } : { useCursorCli: false },
      });
      assert.equal(shouldUseCursorCli({ agentId: "crew-coder-front" }, "command.run_task"), true);
    });
  });

  describe("shouldUseClaudeCode", () => {
    it("payload.runtime = 'claude' → returns true", async () => {
      const { initRunners, shouldUseClaudeCode } = await loadRunners();
      initRunners({});
      assert.equal(shouldUseClaudeCode({ runtime: "claude" }, "command.run_task"), true);
      assert.equal(shouldUseClaudeCode({ runtime: "claude-code" }, "task.assigned"), true);
    });

    it("payload.useClaudeCode = true → returns true", async () => {
      const { initRunners, shouldUseClaudeCode } = await loadRunners();
      initRunners({});
      assert.equal(shouldUseClaudeCode({ useClaudeCode: true }, "command.run_task"), true);
    });

    it("Cursor CLI takes priority: when cursor would match, shouldUseClaudeCode returns false", async () => {
      const { initRunners, shouldUseClaudeCode } = await loadRunners();
      initRunners({});
      const payload = { runtime: "cursor" };
      assert.equal(shouldUseClaudeCode(payload, "command.run_task"), false);
      const payload2 = { useCursorCli: true };
      assert.equal(shouldUseClaudeCode(payload2, "command.run_task"), false);
    });
  });

  describe("shouldUseOpenCode", () => {
    it("payload.useOpenCode = true → returns true", async () => {
      const { initRunners, shouldUseOpenCode } = await loadRunners();
      initRunners({});
      assert.equal(shouldUseOpenCode({ useOpenCode: true }, null, "command.run_task"), true);
    });

    it("CREWSWARM_OPENCODE_ENABLED=0 → returns false (subprocess)", () => {
      const script = `
        process.env.CREWSWARM_OPENCODE_ENABLED = "0";
        const m = await import("./lib/engines/runners.mjs");
        m.initRunners({});
        const result = m.shouldUseOpenCode({ useOpenCode: true }, null, "command.run_task");
        console.log(result ? "true" : "false");
      `;
      const r = spawnSync(process.execPath, ["-e", script], {
        encoding: "utf8",
        cwd: PROJECT_ROOT,
      });
      assert.equal(r.stdout?.trim(), "false", "shouldUseOpenCode must return false when CREWSWARM_OPENCODE_ENABLED=0");
    });
  });

  describe("shouldUseCodex", () => {
    it("payload.runtime = 'codex' → returns true", async () => {
      const { initRunners, shouldUseCodex } = await loadRunners();
      initRunners({});
      assert.equal(shouldUseCodex({ runtime: "codex" }, "command.run_task"), true);
      assert.equal(shouldUseCodex({ runtime: "codex-cli" }, "task.assigned"), true);
    });
  });

  describe("shouldUseGeminiCli", () => {
    it("payload.useGeminiCli = true → returns true", async () => {
      const { initRunners, shouldUseGeminiCli } = await loadRunners();
      initRunners({});
      assert.equal(shouldUseGeminiCli({ useGeminiCli: true }, "command.run_task"), true);
    });

    it("payload.runtime = 'gemini' → returns true", async () => {
      const { initRunners, shouldUseGeminiCli } = await loadRunners();
      initRunners({});
      assert.equal(shouldUseGeminiCli({ runtime: "gemini" }, "command.run_task"), true);
      assert.equal(shouldUseGeminiCli({ runtime: "gemini-cli" }, "task.assigned"), true);
    });
  });
});
