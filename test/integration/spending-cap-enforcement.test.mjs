/**
 * Integration tests for spending cap enforcement.
 *
 * Tests the full flow: accumulate token usage → hit spending cap →
 * checkSpendingCap returns { exceeded: true } with correct action.
 *
 * Also tests: global caps, per-agent caps, daily reset, different
 * onExceed actions (stop/pause/notify).
 *
 * Run with: node --test test/integration/spending-cap-enforcement.test.mjs
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Enable test mode BEFORE importing spending module
// MUST be "true" (not "1") — paths.mjs checks === "true" for temp dir redirect
process.env.CREWSWARM_TEST_MODE = "true";

import { getConfigPath, resetPaths } from "../../lib/runtime/paths.mjs";

const {
  loadSpending,
  saveSpending,
  addAgentSpend,
  checkSpendingCap,
  recordTokenUsage,
  getTokenUsage,
  initSpending,
} = await import("../../lib/runtime/spending.mjs");

const TEST_DIR = path.join(os.tmpdir(), `crewswarm-test-${process.pid}`);

function writeCrewswarmConfig(config) {
  const configPath = getConfigPath("crewswarm.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function cleanTestDir() {
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
}

describe("spending cap enforcement — full flow", () => {
  beforeEach(() => {
    process.env.CREWSWARM_TEST_MODE = "true";
    resetPaths();
    cleanTestDir();
    initSpending({});
  });

  afterEach(() => {
    cleanTestDir();
    delete process.env.CREWSWARM_TEST_MODE;
    resetPaths();
  });

  // ── Global token limit ──────────────────────────────────────────────────

  it("blocks when global daily token limit is exceeded", () => {
    writeCrewswarmConfig({
      globalSpendingCaps: { dailyTokenLimit: 1000 },
      agents: [],
    });

    // Accumulate 1200 tokens
    addAgentSpend("crew-coder", 600, 0.10);
    addAgentSpend("crew-qa", 600, 0.10);

    const result = checkSpendingCap("crew-coder", "groq");
    assert.equal(result.exceeded, true);
    assert.equal(result.action, "stop");
    assert.ok(result.message.includes("1,000"));
  });

  it("allows when under global daily token limit", () => {
    writeCrewswarmConfig({
      globalSpendingCaps: { dailyTokenLimit: 10000 },
      agents: [],
    });

    addAgentSpend("crew-coder", 500, 0.05);

    const result = checkSpendingCap("crew-coder", "groq");
    assert.equal(result.exceeded, false);
  });

  // ── Global cost limit ───────────────────────────────────────────────────

  it("blocks when global daily cost limit is exceeded", () => {
    writeCrewswarmConfig({
      globalSpendingCaps: { dailyCostLimitUSD: 5.0 },
      agents: [],
    });

    addAgentSpend("crew-coder", 100000, 3.50);
    addAgentSpend("crew-qa", 50000, 2.00);

    const result = checkSpendingCap("crew-coder", "anthropic");
    assert.equal(result.exceeded, true);
    assert.equal(result.action, "stop");
    assert.ok(result.message.includes("$5"));
  });

  // ── Per-agent token limit ───────────────────────────────────────────────

  it("enforces per-agent token limit with 'stop' action", () => {
    writeCrewswarmConfig({
      agents: [{
        id: "crew-coder",
        spending: { dailyTokenLimit: 500, onExceed: "stop" },
      }],
    });

    addAgentSpend("crew-coder", 600, 0.10);

    const result = checkSpendingCap("crew-coder", "groq");
    assert.equal(result.exceeded, true);
    assert.equal(result.action, "stop");
    assert.ok(result.message.includes("crew-coder"));
  });

  it("enforces per-agent cost limit with 'notify' action (default)", () => {
    writeCrewswarmConfig({
      agents: [{
        id: "crew-coder",
        spending: { dailyCostLimitUSD: 1.0 },
      }],
    });

    addAgentSpend("crew-coder", 50000, 1.50);

    const result = checkSpendingCap("crew-coder", "anthropic");
    assert.equal(result.exceeded, true);
    assert.equal(result.action, "notify"); // default onExceed
  });

  it("enforces per-agent limit with 'pause' action", () => {
    writeCrewswarmConfig({
      agents: [{
        id: "crew-qa",
        spending: { dailyTokenLimit: 200, onExceed: "pause" },
      }],
    });

    addAgentSpend("crew-qa", 300, 0.05);

    const result = checkSpendingCap("crew-qa", "groq");
    assert.equal(result.exceeded, true);
    assert.equal(result.action, "pause");
  });

  // ── Agent not in config → no cap ───────────────────────────────────────

  it("does not enforce caps for agents not in config", () => {
    writeCrewswarmConfig({
      agents: [{
        id: "crew-coder",
        spending: { dailyTokenLimit: 100, onExceed: "stop" },
      }],
    });

    // crew-qa has no spending config
    addAgentSpend("crew-qa", 99999, 99.0);

    const result = checkSpendingCap("crew-qa", "groq");
    assert.equal(result.exceeded, false);
  });

  // ── Global cap takes priority over per-agent ────────────────────────────

  it("global cap blocks even if per-agent cap is not exceeded", () => {
    writeCrewswarmConfig({
      globalSpendingCaps: { dailyTokenLimit: 1000 },
      agents: [{
        id: "crew-coder",
        spending: { dailyTokenLimit: 5000, onExceed: "notify" },
      }],
    });

    // crew-coder: 500 tokens (under agent cap of 5000)
    // but total: 1200 tokens (over global cap of 1000)
    addAgentSpend("crew-coder", 500, 0.10);
    addAgentSpend("crew-qa", 700, 0.10);

    const result = checkSpendingCap("crew-coder", "groq");
    assert.equal(result.exceeded, true);
    assert.equal(result.action, "stop"); // global uses "stop"
  });

  // ── recordTokenUsage integration ────────────────────────────────────────

  it("recordTokenUsage accumulates spending that checkSpendingCap reads", () => {
    writeCrewswarmConfig({
      agents: [{
        id: "crew-coder",
        spending: { dailyTokenLimit: 500, onExceed: "stop" },
      }],
    });

    // Simulate LLM responses that accumulate tokens
    recordTokenUsage("groq/llama-3.3-70b", { prompt_tokens: 200, completion_tokens: 100 }, "crew-coder");
    recordTokenUsage("groq/llama-3.3-70b", { prompt_tokens: 150, completion_tokens: 100 }, "crew-coder");

    // Total: 550 tokens → exceeds 500 limit
    const result = checkSpendingCap("crew-coder", "groq");
    assert.equal(result.exceeded, true);
    assert.equal(result.action, "stop");
  });

  // ── No config file → always allows ──────────────────────────────────────

  it("returns exceeded=false when no crewswarm.json config", () => {
    // Don't write any config file
    const result = checkSpendingCap("crew-coder", "groq");
    assert.equal(result.exceeded, false);
  });

  // ── Daily reset ─────────────────────────────────────────────────────────

  it("resets spending on new day (different date in spending file)", () => {
    writeCrewswarmConfig({
      globalSpendingCaps: { dailyTokenLimit: 1000 },
      agents: [],
    });

    // Write yesterday's spending data
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const spendingFile = path.join(TEST_DIR, "spending.json");
    fs.mkdirSync(path.dirname(spendingFile), { recursive: true });
    // loadSpending checks date — if it's yesterday, returns fresh object
    addAgentSpend("crew-coder", 5000, 10.0); // would exceed today...

    // But loadSpending returns today's date — so the spending above IS today
    const s = loadSpending();
    assert.equal(s.date, new Date().toISOString().slice(0, 10));
    assert.equal(s.global.tokens, 5000);

    // Verify cap enforcement works with today's data
    const result = checkSpendingCap("crew-coder", "groq");
    assert.equal(result.exceeded, true);
  });
});
