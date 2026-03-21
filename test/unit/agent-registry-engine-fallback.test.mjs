/**
 * @version 1.0.0
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { agentMustNotUseEngineLlmFallback } from "../../lib/agent-registry.mjs";

describe("agentMustNotUseEngineLlmFallback", () => {
  test("crew-qa and crew-security require engine (no LLM-only fallback)", () => {
    assert.equal(agentMustNotUseEngineLlmFallback("crew-qa"), true);
    assert.equal(agentMustNotUseEngineLlmFallback("qa"), true);
    assert.equal(agentMustNotUseEngineLlmFallback("crew-security"), true);
  });

  test("crew-main may use conversational fallback", () => {
    assert.equal(agentMustNotUseEngineLlmFallback("crew-main"), false);
    assert.equal(agentMustNotUseEngineLlmFallback("crew-lead"), false);
  });

  test("crew-pm variants require engine", () => {
    assert.equal(agentMustNotUseEngineLlmFallback("crew-pm"), true);
    assert.equal(agentMustNotUseEngineLlmFallback("crew-pm-cli"), true);
  });
});
