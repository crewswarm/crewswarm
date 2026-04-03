/**
 * Comprehensive unit tests for lib/agents/registry.mjs
 *
 * Covers: buildAgentMapsFromConfig, CREWSWARM_RT_SWARM_AGENTS,
 *         RT_TO_GATEWAY_AGENT_MAP, and re-exported config helpers.
 *
 * Note: this module also re-exports resolveConfig, resolveTelegramBridgeConfig,
 * resolveProviderConfig, loadProviderMap, loadAgentLLMConfig,
 * loadLoopBrainConfig, loadAgentList from lib/runtime/config.mjs —
 * their presence on the namespace is verified here.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  buildAgentMapsFromConfig,
  CREWSWARM_RT_SWARM_AGENTS,
  RT_TO_GATEWAY_AGENT_MAP,
  resolveConfig,
  resolveTelegramBridgeConfig,
  resolveProviderConfig,
  loadProviderMap,
  loadAgentLLMConfig,
  loadLoopBrainConfig,
  loadAgentList,
} from "../../lib/agents/registry.mjs";

// ── Re-exported config helpers ───────────────────────────────────────────────

describe("registry – re-exported config helpers", () => {
  it("resolveConfig is a function", () => {
    assert.equal(typeof resolveConfig, "function");
  });

  it("resolveTelegramBridgeConfig is a function", () => {
    assert.equal(typeof resolveTelegramBridgeConfig, "function");
  });

  it("resolveProviderConfig is a function", () => {
    assert.equal(typeof resolveProviderConfig, "function");
  });

  it("loadProviderMap is a function", () => {
    assert.equal(typeof loadProviderMap, "function");
  });

  it("loadAgentLLMConfig is a function", () => {
    assert.equal(typeof loadAgentLLMConfig, "function");
  });

  it("loadLoopBrainConfig is a function", () => {
    assert.equal(typeof loadLoopBrainConfig, "function");
  });

  it("loadAgentList is a function", () => {
    assert.equal(typeof loadAgentList, "function");
  });
});

// ── CREWSWARM_RT_SWARM_AGENTS ────────────────────────────────────────────────

describe("CREWSWARM_RT_SWARM_AGENTS – type and content", () => {
  it("is a non-empty array", () => {
    assert.ok(Array.isArray(CREWSWARM_RT_SWARM_AGENTS));
    assert.ok(CREWSWARM_RT_SWARM_AGENTS.length > 0);
  });

  it("all entries are non-empty strings", () => {
    for (const agent of CREWSWARM_RT_SWARM_AGENTS) {
      assert.equal(typeof agent, "string", `expected string, got ${typeof agent}`);
      assert.ok(agent.length > 0, "found empty string entry");
    }
  });

  it("contains core coordinator agents", () => {
    const core = ["crew-main", "crew-pm", "crew-lead"];
    for (const agent of core) {
      assert.ok(
        CREWSWARM_RT_SWARM_AGENTS.includes(agent),
        `missing core agent: ${agent}`,
      );
    }
  });

  it("contains no duplicates", () => {
    const unique = [...new Set(CREWSWARM_RT_SWARM_AGENTS)];
    assert.equal(
      CREWSWARM_RT_SWARM_AGENTS.length,
      unique.length,
      "CREWSWARM_RT_SWARM_AGENTS has duplicates",
    );
  });
});

// ── RT_TO_GATEWAY_AGENT_MAP ──────────────────────────────────────────────────

describe("RT_TO_GATEWAY_AGENT_MAP – type and structure", () => {
  it("is a plain object", () => {
    assert.equal(typeof RT_TO_GATEWAY_AGENT_MAP, "object");
    assert.ok(RT_TO_GATEWAY_AGENT_MAP !== null);
    assert.ok(!Array.isArray(RT_TO_GATEWAY_AGENT_MAP));
  });

  it("is non-empty", () => {
    assert.ok(Object.keys(RT_TO_GATEWAY_AGENT_MAP).length > 0);
  });

  it("all keys are non-empty strings", () => {
    for (const key of Object.keys(RT_TO_GATEWAY_AGENT_MAP)) {
      assert.equal(typeof key, "string");
      assert.ok(key.length > 0);
    }
  });

  it("all values are non-empty strings", () => {
    for (const [key, val] of Object.entries(RT_TO_GATEWAY_AGENT_MAP)) {
      assert.equal(typeof val, "string", `${key}: expected string value`);
      assert.ok(val.length > 0, `${key}: empty value`);
    }
  });

  it("crew- prefixed keys map to bare IDs without the crew- prefix", () => {
    for (const [rt, gw] of Object.entries(RT_TO_GATEWAY_AGENT_MAP)) {
      if (rt.startsWith("crew-")) {
        assert.ok(
          !gw.startsWith("crew-"),
          `${rt} should map to bare id, got: ${gw}`,
        );
      }
    }
  });

  it("core coordinator agents are present in the map", () => {
    for (const agent of ["crew-main", "crew-pm", "crew-lead"]) {
      assert.ok(agent in RT_TO_GATEWAY_AGENT_MAP, `missing: ${agent}`);
    }
  });
});

// ── buildAgentMapsFromConfig ─────────────────────────────────────────────────

describe("buildAgentMapsFromConfig – return shape", () => {
  it("returns an object with list and map", () => {
    const result = buildAgentMapsFromConfig();
    assert.ok(typeof result === "object" && result !== null);
    assert.ok("list" in result, "missing list");
    assert.ok("map" in result, "missing map");
  });

  it("list is a non-empty array of strings", () => {
    const { list } = buildAgentMapsFromConfig();
    assert.ok(Array.isArray(list));
    assert.ok(list.length > 0);
    for (const item of list) {
      assert.equal(typeof item, "string");
    }
  });

  it("map is a plain object with string values", () => {
    const { map } = buildAgentMapsFromConfig();
    assert.equal(typeof map, "object");
    assert.ok(map !== null);
    for (const [k, v] of Object.entries(map)) {
      assert.equal(typeof k, "string");
      assert.equal(typeof v, "string");
    }
  });

  it("list contains no duplicates", () => {
    const { list } = buildAgentMapsFromConfig();
    const unique = [...new Set(list)];
    assert.equal(list.length, unique.length, "list has duplicates");
  });

  it("every list item has a corresponding map entry", () => {
    const { list, map } = buildAgentMapsFromConfig();
    for (const agent of list) {
      assert.ok(agent in map, `list agent "${agent}" missing from map`);
    }
  });
});

describe("buildAgentMapsFromConfig – CREWSWARM_RT_SWARM_AGENTS env override", () => {
  let savedEnv;

  before(() => {
    savedEnv = process.env.CREWSWARM_RT_SWARM_AGENTS;
  });

  after(() => {
    if (savedEnv === undefined) {
      delete process.env.CREWSWARM_RT_SWARM_AGENTS;
    } else {
      process.env.CREWSWARM_RT_SWARM_AGENTS = savedEnv;
    }
  });

  it("uses env list when CREWSWARM_RT_SWARM_AGENTS is set", () => {
    process.env.CREWSWARM_RT_SWARM_AGENTS = "crew-coder,crew-qa,crew-pm";
    const { list } = buildAgentMapsFromConfig();
    assert.ok(list.includes("crew-coder"));
    assert.ok(list.includes("crew-qa"));
    assert.ok(list.includes("crew-pm"));
  });

  it("filters empty tokens from env list", () => {
    process.env.CREWSWARM_RT_SWARM_AGENTS = "crew-coder,,  ,crew-pm";
    const { list } = buildAgentMapsFromConfig();
    // Empty/whitespace entries should be filtered out
    for (const item of list) {
      assert.ok(item.trim().length > 0, "found empty/whitespace entry in list");
    }
  });

  it("produces a map from env list where each key equals its entry", () => {
    process.env.CREWSWARM_RT_SWARM_AGENTS = "crew-coder,crew-qa";
    const { list, map } = buildAgentMapsFromConfig();
    for (const agent of list) {
      assert.ok(agent in map, `${agent} missing from map`);
    }
  });

  it("without env override returns at least the built-in core agents", () => {
    delete process.env.CREWSWARM_RT_SWARM_AGENTS;
    const { list } = buildAgentMapsFromConfig();
    const core = ["crew-main", "crew-pm", "crew-lead"];
    for (const agent of core) {
      assert.ok(list.includes(agent), `missing core agent: ${agent}`);
    }
  });
});

describe("buildAgentMapsFromConfig – crew- prefix normalization in map", () => {
  let savedEnv;

  before(() => {
    savedEnv = process.env.CREWSWARM_RT_SWARM_AGENTS;
    delete process.env.CREWSWARM_RT_SWARM_AGENTS;
  });

  after(() => {
    if (savedEnv === undefined) {
      delete process.env.CREWSWARM_RT_SWARM_AGENTS;
    } else {
      process.env.CREWSWARM_RT_SWARM_AGENTS = savedEnv;
    }
  });

  it("crew- prefixed keys map to bare id without crew- prefix", () => {
    const { map } = buildAgentMapsFromConfig();
    for (const [rt, gw] of Object.entries(map)) {
      if (rt.startsWith("crew-")) {
        assert.ok(
          !gw.startsWith("crew-"),
          `${rt} should not map to another crew- id, got: ${gw}`,
        );
      }
    }
  });

  it("crew-main maps to 'main'", () => {
    const { map } = buildAgentMapsFromConfig();
    if ("crew-main" in map) {
      assert.equal(map["crew-main"], "main");
    }
  });

  it("crew-pm maps to 'pm'", () => {
    const { map } = buildAgentMapsFromConfig();
    if ("crew-pm" in map) {
      assert.equal(map["crew-pm"], "pm");
    }
  });
});
