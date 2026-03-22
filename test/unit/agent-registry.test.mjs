import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRtAgentId,
  BUILT_IN_RT_AGENTS,
  RT_TO_GATEWAY_AGENT_MAP,
  COORDINATOR_AGENT_IDS,
  coordinate_aget_ids,
  NO_PREFIX_AGENT_IDS,
} from "../../lib/agent-registry.mjs";

describe("normalizeRtAgentId", () => {
  test("returns empty string for empty input", () => {
    assert.equal(normalizeRtAgentId(""), "");
    assert.equal(normalizeRtAgentId(), "");
    assert.equal(normalizeRtAgentId(null), "");
  });

  test("passes through already-prefixed crew- IDs", () => {
    assert.equal(normalizeRtAgentId("crew-coder"), "crew-coder");
    assert.equal(normalizeRtAgentId("crew-qa"), "crew-qa");
    assert.equal(normalizeRtAgentId("crew-main"), "crew-main");
  });

  test("adds crew- prefix to bare agent names", () => {
    assert.equal(normalizeRtAgentId("coder"), "crew-coder");
    assert.equal(normalizeRtAgentId("pm"), "crew-pm");
    assert.equal(normalizeRtAgentId("fixer"), "crew-fixer");
  });

  test("passes through NO_PREFIX_AGENT_IDS without adding crew-", () => {
    for (const id of NO_PREFIX_AGENT_IDS) {
      assert.equal(normalizeRtAgentId(id), id);
    }
  });

  test("trims whitespace before normalizing", () => {
    assert.equal(normalizeRtAgentId("  coder  "), "crew-coder");
  });
});

describe("BUILT_IN_RT_AGENTS", () => {
  test("is a non-empty array of strings", () => {
    assert.ok(Array.isArray(BUILT_IN_RT_AGENTS));
    assert.ok(BUILT_IN_RT_AGENTS.length > 0);
    for (const id of BUILT_IN_RT_AGENTS) {
      assert.equal(typeof id, "string");
    }
  });

  test("all built-in agents start with crew- or are orchestrator", () => {
    for (const id of BUILT_IN_RT_AGENTS) {
      assert.ok(id.startsWith("crew-") || id === "orchestrator", `unexpected id: ${id}`);
    }
  });
});

describe("RT_TO_GATEWAY_AGENT_MAP", () => {
  test("all crew- keys map to bare agent IDs without crew-", () => {
    for (const [rt, gw] of Object.entries(RT_TO_GATEWAY_AGENT_MAP)) {
      if (rt.startsWith("crew-")) {
        assert.ok(!gw.startsWith("crew-") || gw === "orchestrator",
          `Expected bare id for ${rt}, got ${gw}`);
      }
    }
  });

  test("all BUILT_IN_RT_AGENTS have a mapping", () => {
    for (const id of BUILT_IN_RT_AGENTS) {
      assert.ok(id in RT_TO_GATEWAY_AGENT_MAP, `${id} missing from RT_TO_GATEWAY_AGENT_MAP`);
    }
  });
});

describe("COORDINATOR_AGENT_IDS", () => {
  test("contains expected coordinator IDs", () => {
    assert.ok(COORDINATOR_AGENT_IDS.includes("crew-pm"));
    assert.ok(COORDINATOR_AGENT_IDS.includes("crew-main"));
    assert.ok(COORDINATOR_AGENT_IDS.includes("crew-orchestrator"));
  });

  test("exports the backward-compatible typo alias", () => {
    assert.equal(coordinate_aget_ids, COORDINATOR_AGENT_IDS);
  });
});
