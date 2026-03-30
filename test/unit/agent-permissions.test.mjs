/**
 * Unit tests for lib/agents/permissions.mjs
 *
 * Covers: CREWSWARM_TOOL_NAMES, AGENT_TOOL_ROLE_DEFAULTS, readAgentTools,
 *         getSearchToolsConfig, getRawAgentPrompts
 *
 * Skips: writeAgentTools, writeAgentPrompt (write to disk in user homedir)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CREWSWARM_TOOL_NAMES,
  AGENT_TOOL_ROLE_DEFAULTS,
  readAgentTools,
  getSearchToolsConfig,
  getRawAgentPrompts,
} from "../../lib/agents/permissions.mjs";

describe("permissions – CREWSWARM_TOOL_NAMES", () => {
  it("is a Set with expected core tools", () => {
    assert.ok(CREWSWARM_TOOL_NAMES instanceof Set);
    assert.ok(CREWSWARM_TOOL_NAMES.has("read_file"));
    assert.ok(CREWSWARM_TOOL_NAMES.has("write_file"));
    assert.ok(CREWSWARM_TOOL_NAMES.has("run_cmd"));
    assert.ok(CREWSWARM_TOOL_NAMES.has("git"));
  });

  it("does not contain unknown tools", () => {
    assert.ok(!CREWSWARM_TOOL_NAMES.has("fly_drone"));
  });
});

describe("permissions – AGENT_TOOL_ROLE_DEFAULTS", () => {
  it("has entries for known agents", () => {
    assert.ok(Array.isArray(AGENT_TOOL_ROLE_DEFAULTS["crew-coder"]));
    assert.ok(Array.isArray(AGENT_TOOL_ROLE_DEFAULTS["crew-qa"]));
    assert.ok(Array.isArray(AGENT_TOOL_ROLE_DEFAULTS["crew-github"]));
  });

  it("crew-qa has only read_file by default", () => {
    assert.deepEqual(AGENT_TOOL_ROLE_DEFAULTS["crew-qa"], ["read_file"]);
  });

  it("crew-github includes git", () => {
    assert.ok(AGENT_TOOL_ROLE_DEFAULTS["crew-github"].includes("git"));
  });
});

describe("permissions – readAgentTools", () => {
  it("returns an object with source and tools array", () => {
    const result = readAgentTools("crew-coder");
    assert.ok(typeof result.source === "string");
    assert.ok(Array.isArray(result.tools));
  });

  it("returns role-default source for a known agent", () => {
    const result = readAgentTools("crew-qa");
    // Could be config or role-default depending on local setup
    assert.ok(["config", "role-default"].includes(result.source));
  });

  it("returns fallback tools for an unknown agent", () => {
    const result = readAgentTools("crew-nonexistent-xyz-12345");
    assert.ok(result.tools.length > 0);
  });
});

describe("permissions – getSearchToolsConfig", () => {
  it("returns an object (empty if config missing)", () => {
    const cfg = getSearchToolsConfig();
    assert.ok(typeof cfg === "object" && cfg !== null);
  });
});

describe("permissions – getRawAgentPrompts", () => {
  it("returns an object", () => {
    const prompts = getRawAgentPrompts();
    assert.ok(typeof prompts === "object" && prompts !== null);
  });
});
