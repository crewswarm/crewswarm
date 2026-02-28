/**
 * Integration tests for lib/runtime/spending.mjs
 * Tests loadSpending, saveSpending, and addAgentSpend.
 * Uses hermetic test mode to avoid corrupting live data.
 */
import { test, describe, before, after } from "node:test";
import assert from "assert/strict";
import { setupHermeticTest } from "../helpers/hermetic.mjs";
import { loadSpending, saveSpending, addAgentSpend } from "../../lib/runtime/spending.mjs";

before(() => setupHermeticTest());

describe("loadSpending", () => {
  test("returns an object with date, global, and agents fields", () => {
    const s = loadSpending();
    assert.ok(s.date, "should have date");
    assert.ok(typeof s.global === "object", "should have global object");
    assert.ok(typeof s.global.tokens === "number", "global.tokens should be a number");
    assert.ok(typeof s.global.costUSD === "number", "global.costUSD should be a number");
    assert.ok(typeof s.agents === "object", "should have agents object");
  });

  test("date matches today's ISO date (YYYY-MM-DD)", () => {
    const s = loadSpending();
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(s.date, today);
  });
});

describe("saveSpending + loadSpending round-trip", () => {
  test("saves and reloads spending data correctly", () => {
    const today = new Date().toISOString().slice(0, 10);
    const testData = {
      date: today,
      global: { tokens: 9999, costUSD: 1.23 },
      agents: { "test-agent": { tokens: 100, costUSD: 0.01 } },
    };
    saveSpending(testData);
    const loaded = loadSpending();
    assert.equal(loaded.global.tokens, 9999);
    assert.equal(loaded.global.costUSD, 1.23);
    assert.ok(loaded.agents["test-agent"]);
  });
});

describe("addAgentSpend", () => {
  test("accumulates tokens for a new agent", () => {
    const before = loadSpending();
    const initialGlobal = before.global.tokens;
    addAgentSpend("test-crew-agent", 500, 0.05);
    const after = loadSpending();
    assert.ok(after.global.tokens >= initialGlobal + 500);
    assert.ok(after.agents["test-crew-agent"]);
    assert.ok(after.agents["test-crew-agent"].tokens >= 500);
  });

  test("accumulates additional spend for existing agent", () => {
    const before = loadSpending();
    const initialTokens = (before.agents["test-crew-agent"] || { tokens: 0 }).tokens;
    addAgentSpend("test-crew-agent", 200, 0.02);
    const after = loadSpending();
    assert.ok(after.agents["test-crew-agent"].tokens >= initialTokens + 200);
  });

  test("accumulates costUSD correctly", () => {
    const before = loadSpending();
    const prevCost = before.global.costUSD;
    addAgentSpend("test-crew-agent-b", 1000, 0.10);
    const after = loadSpending();
    assert.ok(after.global.costUSD >= prevCost + 0.10 - 0.001);
  });
});
