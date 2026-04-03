/**
 * Comprehensive unit tests for lib/agents/tool-instructions.mjs
 *
 * Covers: buildToolInstructions, getPreferredCLI, hasEngineConfigured,
 *         getToolPermissions — happy paths, edge cases, boundary values.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildToolInstructions,
  getPreferredCLI,
  hasEngineConfigured,
  getToolPermissions,
} from "../../lib/agents/tool-instructions.mjs";

// ── getPreferredCLI ─────────────────────────────────────────────────────────

describe("getPreferredCLI – null / empty input", () => {
  it("returns null when agentConfig is null", () => {
    assert.equal(getPreferredCLI(null), null);
  });

  it("returns null when agentConfig is undefined", () => {
    assert.equal(getPreferredCLI(undefined), null);
  });

  it("returns null when agentConfig has no engine-related flags", () => {
    assert.equal(getPreferredCLI({}), null);
  });
});

describe("getPreferredCLI – flag-based detection", () => {
  it("returns crew-cli when useCrewCLI is true", () => {
    assert.equal(getPreferredCLI({ useCrewCLI: true }), "crew-cli");
  });

  it("returns crew-cli when engine is 'crew-cli'", () => {
    assert.equal(getPreferredCLI({ engine: "crew-cli" }), "crew-cli");
  });

  it("returns opencode when useOpenCode is true", () => {
    assert.equal(getPreferredCLI({ useOpenCode: true }), "opencode");
  });

  it("returns opencode when engine is 'opencode'", () => {
    assert.equal(getPreferredCLI({ engine: "opencode" }), "opencode");
  });

  it("returns cursor when useCursorCli is true", () => {
    assert.equal(getPreferredCLI({ useCursorCli: true }), "cursor");
  });

  it("returns cursor when engine is 'cursor'", () => {
    assert.equal(getPreferredCLI({ engine: "cursor" }), "cursor");
  });

  it("returns claude when useClaudeCode is true", () => {
    assert.equal(getPreferredCLI({ useClaudeCode: true }), "claude");
  });

  it("returns claude when engine is 'claude'", () => {
    assert.equal(getPreferredCLI({ engine: "claude" }), "claude");
  });

  it("returns codex when useCodex is true", () => {
    assert.equal(getPreferredCLI({ useCodex: true }), "codex");
  });

  it("returns codex when engine is 'codex'", () => {
    assert.equal(getPreferredCLI({ engine: "codex" }), "codex");
  });

  it("returns gemini when useGeminiCli is true", () => {
    assert.equal(getPreferredCLI({ useGeminiCli: true }), "gemini");
  });

  it("returns gemini when engine is 'gemini'", () => {
    assert.equal(getPreferredCLI({ engine: "gemini" }), "gemini");
  });

  it("useCrewCLI takes priority over engine: opencode", () => {
    // Priority order: crew-cli > opencode > cursor > claude > codex > gemini
    assert.equal(getPreferredCLI({ useCrewCLI: true, engine: "opencode" }), "crew-cli");
  });

  it("useOpenCode takes priority over engine: cursor", () => {
    assert.equal(getPreferredCLI({ useOpenCode: true, engine: "cursor" }), "opencode");
  });
});

// ── hasEngineConfigured ─────────────────────────────────────────────────────

describe("hasEngineConfigured – null / empty input", () => {
  it("returns false when agentConfig is null", () => {
    assert.equal(hasEngineConfigured(null), false);
  });

  it("returns false when agentConfig is undefined", () => {
    assert.equal(hasEngineConfigured(undefined), false);
  });

  it("returns false when agentConfig is empty object", () => {
    assert.equal(hasEngineConfigured({}), false);
  });
});

describe("hasEngineConfigured – positive cases", () => {
  it("returns true when useOpenCode is set", () => {
    assert.equal(hasEngineConfigured({ useOpenCode: true }), true);
  });

  it("returns true when useCursorCli is set", () => {
    assert.equal(hasEngineConfigured({ useCursorCli: true }), true);
  });

  it("returns true when useClaudeCode is set", () => {
    assert.equal(hasEngineConfigured({ useClaudeCode: true }), true);
  });

  it("returns true when useCodex is set", () => {
    assert.equal(hasEngineConfigured({ useCodex: true }), true);
  });

  it("returns true when useGeminiCli is set", () => {
    assert.equal(hasEngineConfigured({ useGeminiCli: true }), true);
  });

  it("returns true when useCrewCLI is set", () => {
    assert.equal(hasEngineConfigured({ useCrewCLI: true }), true);
  });

  it("returns true when generic engine field is present", () => {
    assert.equal(hasEngineConfigured({ engine: "some-engine" }), true);
  });

  it("returns false when all flags are falsy", () => {
    assert.equal(
      hasEngineConfigured({
        useOpenCode: false,
        useCursorCli: false,
        useClaudeCode: false,
        useCodex: false,
        useGeminiCli: false,
        useCrewCLI: false,
      }),
      false,
    );
  });
});

// ── getToolPermissions ──────────────────────────────────────────────────────

describe("getToolPermissions – built-in agent defaults", () => {
  it("crew-pm gets cli, dispatch, and web", () => {
    const p = getToolPermissions("crew-pm", null);
    assert.equal(p.cli, true);
    assert.equal(p.dispatch, true);
    assert.equal(p.web, true);
  });

  it("crew-coder gets cli, dispatch, and web", () => {
    const p = getToolPermissions("crew-coder", null);
    assert.equal(p.cli, true);
    assert.equal(p.dispatch, true);
    assert.equal(p.web, true);
  });

  it("crew-security gets no cli, no dispatch, only web", () => {
    const p = getToolPermissions("crew-security", null);
    assert.equal(p.cli, false);
    assert.equal(p.dispatch, false);
    assert.equal(p.web, true);
  });

  it("crew-researcher gets no cli, no dispatch, only web", () => {
    const p = getToolPermissions("crew-researcher", null);
    assert.equal(p.cli, false);
    assert.equal(p.dispatch, false);
    assert.equal(p.web, true);
  });

  it("crew-loco gets no cli, no dispatch, only web", () => {
    const p = getToolPermissions("crew-loco", null);
    assert.equal(p.cli, false);
    assert.equal(p.dispatch, false);
    assert.equal(p.web, true);
  });

  it("crew-copywriter gets cli and web but no dispatch", () => {
    const p = getToolPermissions("crew-copywriter", null);
    assert.equal(p.cli, true);
    assert.equal(p.dispatch, false);
    assert.equal(p.web, true);
  });

  it("crew-lead gets full permissions", () => {
    const p = getToolPermissions("crew-lead", null);
    assert.equal(p.cli, true);
    assert.equal(p.dispatch, true);
    assert.equal(p.web, true);
  });

  it("unknown agent id falls back to full permissions", () => {
    const p = getToolPermissions("crew-does-not-exist-xyz", null);
    assert.equal(p.cli, true);
    assert.equal(p.dispatch, true);
    assert.equal(p.web, true);
  });
});

describe("getToolPermissions – crewswarmAllow config overrides", () => {
  it("crewswarmAllow with run_cmd grants cli", () => {
    const p = getToolPermissions("crew-security", {
      tools: { crewswarmAllow: ["run_cmd"] },
    });
    assert.equal(p.cli, true);
  });

  it("crewswarmAllow with write_file grants cli", () => {
    const p = getToolPermissions("crew-security", {
      tools: { crewswarmAllow: ["write_file"] },
    });
    assert.equal(p.cli, true);
  });

  it("crewswarmAllow with dispatch grants dispatch", () => {
    const p = getToolPermissions("crew-security", {
      tools: { crewswarmAllow: ["dispatch"] },
    });
    assert.equal(p.dispatch, true);
  });

  it("crewswarmAllow with web_search grants web", () => {
    const p = getToolPermissions("crew-security", {
      tools: { crewswarmAllow: ["web_search"] },
    });
    assert.equal(p.web, true);
  });

  it("crewswarmAllow with web_fetch grants web", () => {
    const p = getToolPermissions("crew-security", {
      tools: { crewswarmAllow: ["web_fetch"] },
    });
    assert.equal(p.web, true);
  });

  it("crewswarmAllow with only read_file grants no cli, no dispatch, no web", () => {
    const p = getToolPermissions("crew-coder", {
      tools: { crewswarmAllow: ["read_file"] },
    });
    assert.equal(p.cli, false);
    assert.equal(p.dispatch, false);
    assert.equal(p.web, false);
  });

  it("empty crewswarmAllow array falls back to defaults", () => {
    const p = getToolPermissions("crew-coder", {
      tools: { crewswarmAllow: [] },
    });
    // Empty array means no override — use default (crew-coder: all true)
    assert.equal(p.cli, true);
  });

  it("null agentConfig falls back to defaults", () => {
    const p = getToolPermissions("crew-pm", null);
    assert.equal(p.cli, true);
    assert.equal(p.dispatch, true);
  });
});

// ── buildToolInstructions – structure & presence ────────────────────────────

describe("buildToolInstructions – returns a string", () => {
  it("always returns a non-empty string", () => {
    const result = buildToolInstructions({ agentId: "crew-coder", permissions: {}, hasEngine: false });
    assert.equal(typeof result, "string");
    assert.ok(result.length > 0);
  });

  it("always includes the ## Available Tools heading", () => {
    const result = buildToolInstructions({ agentId: "crew-coder", permissions: {}, hasEngine: false });
    assert.ok(result.includes("## Available Tools"));
  });

  it("always includes the @@READ_FILE direct tool", () => {
    const result = buildToolInstructions({ agentId: "crew-qa", permissions: {}, hasEngine: false });
    assert.ok(result.includes("@@READ_FILE"));
  });

  it("always includes @@WRITE_FILE direct tool", () => {
    const result = buildToolInstructions({ agentId: "crew-qa", permissions: {}, hasEngine: false });
    assert.ok(result.includes("@@WRITE_FILE"));
  });

  it("always includes @@RUN_CMD direct tool", () => {
    const result = buildToolInstructions({ agentId: "crew-coder", permissions: {}, hasEngine: false });
    assert.ok(result.includes("@@RUN_CMD"));
  });

  it("always includes the Hard Protocol section", () => {
    const result = buildToolInstructions({ agentId: "crew-coder", permissions: {}, hasEngine: false });
    assert.ok(result.includes("## Hard Protocol"));
  });
});

describe("buildToolInstructions – CLI section gating", () => {
  it("includes @@CLI section when permissions.cli AND hasEngine are both true", () => {
    const result = buildToolInstructions({
      agentId: "crew-coder",
      permissions: { cli: true },
      hasEngine: true,
    });
    assert.ok(result.includes("@@CLI"));
  });

  it("omits @@CLI section when hasEngine is false even if permissions.cli is true", () => {
    const result = buildToolInstructions({
      agentId: "crew-coder",
      permissions: { cli: true },
      hasEngine: false,
    });
    assert.ok(!result.includes("@@CLI crew-cli"));
    assert.ok(!result.includes("@@CLI opencode"));
  });

  it("shows 'not configured' note when cli permission set but no engine", () => {
    const result = buildToolInstructions({
      agentId: "crew-coder",
      permissions: { cli: true },
      hasEngine: false,
    });
    assert.ok(result.includes("not configured"));
  });

  it("omits CLI Tools section header when permissions.cli is false", () => {
    const result = buildToolInstructions({
      agentId: "crew-researcher",
      permissions: { cli: false },
      hasEngine: true,
    });
    // The Hard Protocol footer always mentions @@CLI as a format example,
    // but the CLI Tools section itself (with crew-cli / opencode / cursor)
    // should not appear.
    assert.ok(!result.includes("### CLI Tools"));
    assert.ok(!result.includes("@@CLI crew-cli"));
    assert.ok(!result.includes("@@CLI opencode"));
  });
});

describe("buildToolInstructions – preferred CLI logic", () => {
  it("shows only crew-cli when agentConfig.useCrewCLI is true", () => {
    const result = buildToolInstructions({
      agentId: "crew-coder",
      permissions: { cli: true },
      hasEngine: true,
      agentConfig: { useCrewCLI: true },
    });
    assert.ok(result.includes("@@CLI crew-cli"));
    assert.ok(!result.includes("@@CLI opencode"));
  });

  it("shows only opencode when agentConfig.engine is opencode", () => {
    const result = buildToolInstructions({
      agentId: "crew-coder",
      permissions: { cli: true },
      hasEngine: true,
      agentConfig: { engine: "opencode" },
    });
    assert.ok(result.includes("@@CLI opencode"));
    assert.ok(!result.includes("@@CLI crew-cli"));
  });

  it("shows all CLIs when no preference is set", () => {
    const result = buildToolInstructions({
      agentId: "crew-coder",
      permissions: { cli: true },
      hasEngine: true,
      agentConfig: {},
    });
    assert.ok(result.includes("@@CLI crew-cli"));
    assert.ok(result.includes("@@CLI opencode"));
    assert.ok(result.includes("@@CLI cursor"));
  });

  it("shows all CLIs when agentConfig is null but hasEngine true", () => {
    const result = buildToolInstructions({
      agentId: "crew-coder",
      permissions: { cli: true },
      hasEngine: true,
      agentConfig: null,
    });
    assert.ok(result.includes("@@CLI crew-cli"));
  });
});

describe("buildToolInstructions – web tools section", () => {
  it("includes @@WEB_SEARCH when permissions.web is true", () => {
    const result = buildToolInstructions({
      agentId: "crew-researcher",
      permissions: { web: true },
      hasEngine: false,
    });
    assert.ok(result.includes("@@WEB_SEARCH"));
    assert.ok(result.includes("@@WEB_FETCH"));
  });

  it("omits web tools when permissions.web is false", () => {
    const result = buildToolInstructions({
      agentId: "crew-coder",
      permissions: { web: false },
      hasEngine: false,
    });
    assert.ok(!result.includes("@@WEB_SEARCH"));
  });

  it("omits web tools when permissions is empty object (no web key)", () => {
    const result = buildToolInstructions({
      agentId: "crew-coder",
      permissions: {},
      hasEngine: false,
    });
    assert.ok(!result.includes("@@WEB_SEARCH"));
  });
});

describe("buildToolInstructions – dispatch section", () => {
  it("includes @@DISPATCH when permissions.dispatch is true", () => {
    const result = buildToolInstructions({
      agentId: "crew-pm",
      permissions: { dispatch: true },
      hasEngine: false,
    });
    assert.ok(result.includes("@@DISPATCH"));
  });

  it("omits Delegation Tools section when permissions.dispatch is false", () => {
    const result = buildToolInstructions({
      agentId: "crew-researcher",
      permissions: { dispatch: false },
      hasEngine: false,
    });
    // The Hard Protocol footer references @@DISPATCH as a format example,
    // but the Delegation Tools section should not appear.
    assert.ok(!result.includes("### Delegation Tools"));
    assert.ok(!result.includes("Delegate to specialist agent"));
  });
});

describe("buildToolInstructions – agent-specific guidance", () => {
  it("includes PM guidance for crew-pm agent", () => {
    const result = buildToolInstructions({
      agentId: "crew-pm",
      permissions: {},
      hasEngine: false,
    });
    assert.ok(result.includes("As a PM agent"));
  });

  it("includes PM guidance for crew-pm-frontend variant", () => {
    const result = buildToolInstructions({
      agentId: "crew-pm-frontend",
      permissions: {},
      hasEngine: false,
    });
    assert.ok(result.includes("As a PM agent"));
  });

  it("includes PM guidance for crew-pm-core variant", () => {
    const result = buildToolInstructions({
      agentId: "crew-pm-core",
      permissions: {},
      hasEngine: false,
    });
    assert.ok(result.includes("As a PM agent"));
  });

  it("includes coder guidance for crew-coder agent", () => {
    const result = buildToolInstructions({
      agentId: "crew-coder",
      permissions: {},
      hasEngine: false,
    });
    assert.ok(result.includes("As a coding agent"));
  });

  it("includes coder guidance for crew-coder-front", () => {
    const result = buildToolInstructions({
      agentId: "crew-coder-front",
      permissions: {},
      hasEngine: false,
    });
    assert.ok(result.includes("As a coding agent"));
  });

  it("includes coder guidance for crew-coder-back", () => {
    const result = buildToolInstructions({
      agentId: "crew-coder-back",
      permissions: {},
      hasEngine: false,
    });
    assert.ok(result.includes("As a coding agent"));
  });

  it("includes coder guidance for crew-fixer", () => {
    const result = buildToolInstructions({
      agentId: "crew-fixer",
      permissions: {},
      hasEngine: false,
    });
    assert.ok(result.includes("As a coding agent"));
  });

  it("includes coder guidance for crew-frontend", () => {
    const result = buildToolInstructions({
      agentId: "crew-frontend",
      permissions: {},
      hasEngine: false,
    });
    assert.ok(result.includes("As a coding agent"));
  });

  it("does NOT include PM guidance for non-PM agents", () => {
    const result = buildToolInstructions({
      agentId: "crew-coder",
      permissions: {},
      hasEngine: false,
    });
    assert.ok(!result.includes("As a PM agent"));
  });

  it("does NOT include coder guidance for non-coder agents", () => {
    const result = buildToolInstructions({
      agentId: "crew-pm",
      permissions: {},
      hasEngine: false,
    });
    assert.ok(!result.includes("As a coding agent"));
  });

  it("generic agent (crew-lead) gets neither PM nor coder guidance", () => {
    const result = buildToolInstructions({
      agentId: "crew-lead",
      permissions: {},
      hasEngine: false,
    });
    assert.ok(!result.includes("As a PM agent"));
    assert.ok(!result.includes("As a coding agent"));
  });
});

describe("buildToolInstructions – defaults", () => {
  it("hasEngine defaults to false when not provided", () => {
    const result = buildToolInstructions({
      agentId: "crew-coder",
      permissions: { cli: true },
    });
    // With hasEngine=false (default), CLI section should show "not configured" note
    assert.ok(result.includes("not configured"));
  });

  it("permissions defaults to empty object when not provided", () => {
    const result = buildToolInstructions({ agentId: "crew-coder" });
    assert.ok(typeof result === "string");
    assert.ok(result.length > 0);
  });

  it("agentConfig defaults to null when not provided", () => {
    const result = buildToolInstructions({
      agentId: "crew-coder",
      permissions: { cli: true },
      hasEngine: true,
    });
    // null agentConfig -> no preference -> show all CLIs
    assert.ok(result.includes("@@CLI crew-cli"));
  });
});

describe("buildToolInstructions – full permissions integration", () => {
  it("produces all sections when all permissions are true with engine configured", () => {
    const result = buildToolInstructions({
      agentId: "crew-pm",
      permissions: { cli: true, dispatch: true, web: true },
      hasEngine: true,
      agentConfig: { useCrewCLI: true },
    });
    assert.ok(result.includes("@@READ_FILE"));
    assert.ok(result.includes("@@WRITE_FILE"));
    assert.ok(result.includes("@@RUN_CMD"));
    assert.ok(result.includes("@@CLI crew-cli"));
    assert.ok(result.includes("@@WEB_SEARCH"));
    assert.ok(result.includes("@@DISPATCH"));
    assert.ok(result.includes("## Hard Protocol"));
  });

  it("produces minimal output when all permissions are false, no engine", () => {
    const result = buildToolInstructions({
      agentId: "crew-loco",
      permissions: { cli: false, dispatch: false, web: false },
      hasEngine: false,
    });
    assert.ok(result.includes("@@READ_FILE"));
    // Sections that should be absent (Hard Protocol footer references these
    // as format examples but the actual tool sections should not appear)
    assert.ok(!result.includes("### CLI Tools"));
    assert.ok(!result.includes("@@CLI crew-cli"));
    assert.ok(!result.includes("@@WEB_SEARCH"));
    assert.ok(!result.includes("### Delegation Tools"));
  });
});
