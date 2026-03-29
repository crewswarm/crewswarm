import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  inferDispatchEngine,
  getNextCoderEngine,
  buildEngineFallbackMeta,
} from "../../lib/crew-lead/ws-router.mjs";

describe("ws-router engine fallback helpers", () => {
  it("detects Claude from dispatch flags", () => {
    assert.equal(inferDispatchEngine({ useClaudeCode: true }), "claude");
  });

  it("detects Codex from failed task payload text", () => {
    assert.equal(
      inferDispatchEngine({}, "Codex CLI hit a rate limit on gpt-5.3-codex"),
      "codex",
    );
  });

  it("maps Claude to Codex and Codex to Claude before Cursor", () => {
    assert.equal(getNextCoderEngine("claude"), "codex");
    assert.equal(getNextCoderEngine("codex"), "claude");
    assert.equal(getNextCoderEngine("cursor"), null);
  });

  it("builds explicit Claude retry flags from a Codex failure", () => {
    const meta = buildEngineFallbackMeta(
      { projectDir: "/tmp/demo", useCodex: true, codexModel: "gpt-5.4" },
      "codex",
      "rate-limit-engine-fallback",
    );

    assert.equal(meta.useCodex, false);
    assert.equal(meta.useClaudeCode, true);
    assert.equal(meta.useCursorCli, false);
    assert.equal(meta.runtime, "claude");
    assert.equal(meta.engineFallbackFrom, "codex");
    assert.equal(meta.engineFallbackTo, "claude");
  });

  it("builds explicit Codex retry flags from a Claude failure", () => {
    const meta = buildEngineFallbackMeta(
      { projectDir: "/tmp/demo", useClaudeCode: true },
      "claude",
      "rate-limit-engine-fallback",
    );

    assert.equal(meta.useClaudeCode, false);
    assert.equal(meta.useCodex, true);
    assert.equal(meta.useCursorCli, false);
    assert.equal(meta.runtime, "codex");
    assert.equal(meta.engineFallbackFrom, "claude");
    assert.equal(meta.engineFallbackTo, "codex");
    assert.equal(meta.projectDir, "/tmp/demo");
    assert.equal(meta.triggeredBy, "rate-limit-engine-fallback");
  });
});
