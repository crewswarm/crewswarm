/**
 * Unit tests for lib/crew-lead/agent-manager.mjs
 *
 * Covers: AGENT_ROLE_PRESETS, createAgent (validation),
 *         listDynamicAgents, removeDynamicAgent (validation)
 *
 * Skips: actual creation/removal (writes to ~/.crewswarm/crewswarm.json)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_ROLE_PRESETS,
  createAgent,
  listDynamicAgents,
  removeDynamicAgent,
} from "../../lib/crew-lead/agent-manager.mjs";

describe("agent-manager – AGENT_ROLE_PRESETS", () => {
  it("has coder, researcher, writer, auditor, ops, generalist presets", () => {
    const keys = Object.keys(AGENT_ROLE_PRESETS);
    for (const role of ["coder", "researcher", "writer", "auditor", "ops", "generalist"]) {
      assert.ok(keys.includes(role), `Missing preset: ${role}`);
    }
  });

  it("each preset has tools array and promptTemplate function", () => {
    for (const [role, preset] of Object.entries(AGENT_ROLE_PRESETS)) {
      assert.ok(Array.isArray(preset.tools), `${role} missing tools`);
      assert.ok(typeof preset.promptTemplate === "function", `${role} missing promptTemplate`);
    }
  });

  it("coder preset includes write_file and read_file", () => {
    const tools = AGENT_ROLE_PRESETS.coder.tools;
    assert.ok(tools.includes("write_file"));
    assert.ok(tools.includes("read_file"));
  });

  it("promptTemplate returns a string containing the agent id", () => {
    const result = AGENT_ROLE_PRESETS.researcher.promptTemplate("crew-test-agent", "testing");
    assert.ok(typeof result === "string");
    assert.ok(result.includes("crew-test-agent"));
  });
});

describe("agent-manager – createAgent validation", () => {
  it("throws if id is missing", () => {
    assert.throws(() => createAgent({}), /id is required/i);
  });
});

describe("agent-manager – listDynamicAgents", () => {
  it("returns an array", () => {
    const result = listDynamicAgents();
    assert.ok(Array.isArray(result));
  });
});

describe("agent-manager – removeDynamicAgent", () => {
  it("throws for a non-existent dynamic agent", () => {
    assert.throws(
      () => removeDynamicAgent("crew-nonexistent-xyz-99999"),
      /not a dynamic agent/i,
    );
  });
});
