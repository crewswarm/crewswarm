/**
 * Unit tests for lib/runtime/spending.mjs
 *
 * Covers:
 *  - recordTokenUsage: accumulates prompt/completion/cached tokens
 *  - recordTokenUsage: tracks per-model breakdown in byModel
 *  - recordTokenUsage: skips recording when usage is null or zero
 *  - recordTokenUsage: handles various cache field names (OpenAI, DeepSeek, Anthropic)
 *  - getTokenUsage: returns accumulated stats
 *  - getTokenUsage: initializes with zero counters on first call
 *  - loadSpending / saveSpending / addAgentSpend: round-trip spending data
 *  - checkSpendingCap: returns { exceeded: false } when no config exists
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Enable test mode so spending.mjs redirects file I/O to /tmp
process.env.CREWSWARM_TEST_MODE = "1";

// Dynamic import after env var is set
const {
  recordTokenUsage,
  getTokenUsage,
  tokenUsage,
  loadSpending,
  saveSpending,
  addAgentSpend,
  checkSpendingCap,
  initSpending,
} = await import("../../lib/runtime/spending.mjs");

// ── Helpers ────────────────────────────────────────────────────────────────

const TEST_DIR = path.join(os.tmpdir(), `crewswarm-test-${process.pid}`);

function resetTokenUsageCache() {
  // Reset the module-level _tokenUsage cache so each test starts fresh.
  // We do this by zeroing out the proxy-accessible fields.
  const tu = getTokenUsage();
  tu.calls = 0;
  tu.prompt = 0;
  tu.completion = 0;
  tu.cached = 0;
  tu.byModel = {};
  tu.byDay = {};
}

// ── Suite ──────────────────────────────────────────────────────────────────

describe("spending — getTokenUsage", () => {
  beforeEach(() => resetTokenUsageCache());

  it("returns an object with expected initial fields", () => {
    const tu = getTokenUsage();
    assert.equal(typeof tu, "object");
    assert.equal(typeof tu.calls, "number");
    assert.equal(typeof tu.prompt, "number");
    assert.equal(typeof tu.completion, "number");
    assert.ok(typeof tu.sessionStart === "string");
  });

  it("initial counters are zero after reset", () => {
    const tu = getTokenUsage();
    assert.equal(tu.calls, 0);
    assert.equal(tu.prompt, 0);
    assert.equal(tu.completion, 0);
  });
});

describe("spending — tokenUsage proxy", () => {
  beforeEach(() => resetTokenUsageCache());

  it("proxy reads reflect underlying getTokenUsage() state", () => {
    const tu = getTokenUsage();
    tu.calls = 42;
    assert.equal(tokenUsage.calls, 42);
  });

  it("proxy writes update underlying getTokenUsage() state", () => {
    tokenUsage.calls = 7;
    assert.equal(getTokenUsage().calls, 7);
  });
});

describe("spending — recordTokenUsage", () => {
  beforeEach(() => resetTokenUsageCache());

  it("does nothing when usage is null", () => {
    recordTokenUsage("test-model", null);
    assert.equal(getTokenUsage().calls, 0);
  });

  it("does nothing when usage has zero tokens", () => {
    recordTokenUsage("test-model", { prompt_tokens: 0, completion_tokens: 0 });
    assert.equal(getTokenUsage().calls, 0);
  });

  it("accumulates prompt and completion tokens", () => {
    recordTokenUsage("test-model", { prompt_tokens: 100, completion_tokens: 50 });
    const tu = getTokenUsage();
    assert.equal(tu.calls, 1);
    assert.equal(tu.prompt, 100);
    assert.equal(tu.completion, 50);
  });

  it("accumulates across multiple calls", () => {
    recordTokenUsage("test-model", { prompt_tokens: 100, completion_tokens: 50 });
    recordTokenUsage("test-model", { prompt_tokens: 200, completion_tokens: 100 });
    const tu = getTokenUsage();
    assert.equal(tu.calls, 2);
    assert.equal(tu.prompt, 300);
    assert.equal(tu.completion, 150);
  });

  it("accepts input_tokens / output_tokens (Anthropic style)", () => {
    recordTokenUsage("anthropic/claude", { input_tokens: 80, output_tokens: 40 });
    const tu = getTokenUsage();
    assert.equal(tu.prompt, 80);
    assert.equal(tu.completion, 40);
  });

  it("tracks per-model breakdown in byModel", () => {
    recordTokenUsage("google/gemini-2.5-flash", { prompt_tokens: 100, completion_tokens: 50 });
    recordTokenUsage("openai/gpt-4o", { prompt_tokens: 200, completion_tokens: 100 });
    recordTokenUsage("google/gemini-2.5-flash", { prompt_tokens: 50, completion_tokens: 25 });

    const tu = getTokenUsage();
    const gemini = tu.byModel["google/gemini-2.5-flash"];
    const openai = tu.byModel["openai/gpt-4o"];

    assert.ok(gemini, "gemini model entry should exist");
    assert.equal(gemini.calls, 2);
    assert.equal(gemini.prompt, 150);
    assert.equal(gemini.completion, 75);

    assert.ok(openai, "openai model entry should exist");
    assert.equal(openai.calls, 1);
    assert.equal(openai.prompt, 200);
    assert.equal(openai.completion, 100);
  });

  it("tracks cached tokens from OpenAI format (prompt_tokens_details.cached_tokens)", () => {
    recordTokenUsage("openai/gpt-4o", {
      prompt_tokens: 500,
      completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 300 },
    });
    const tu = getTokenUsage();
    assert.equal(tu.cached, 300);
    assert.equal(tu.byModel["openai/gpt-4o"].cached, 300);
  });

  it("tracks cached tokens from DeepSeek format (prompt_cache_hit_tokens)", () => {
    recordTokenUsage("deepseek/deepseek-chat", {
      prompt_tokens: 400,
      completion_tokens: 80,
      prompt_cache_hit_tokens: 200,
    });
    assert.equal(getTokenUsage().cached, 200);
  });

  it("tracks cached tokens from Anthropic format (cache_read_input_tokens)", () => {
    recordTokenUsage("anthropic/claude", {
      input_tokens: 600,
      output_tokens: 120,
      cache_read_input_tokens: 400,
    });
    assert.equal(getTokenUsage().cached, 400);
  });

  it("tracks daily breakdown in byDay", () => {
    recordTokenUsage("test-model", { prompt_tokens: 100, completion_tokens: 50 });
    const tu = getTokenUsage();
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(tu.byDay, "byDay should exist");
    assert.ok(tu.byDay[today], `byDay[${today}] should exist`);
    assert.equal(tu.byDay[today].calls, 1);
    assert.equal(tu.byDay[today].prompt, 100);
  });
});

describe("spending — loadSpending / saveSpending / addAgentSpend", () => {
  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("loadSpending returns a fresh structure for today", () => {
    const s = loadSpending();
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(s.date, today);
    assert.equal(typeof s.global, "object");
    assert.equal(typeof s.agents, "object");
  });

  it("saveSpending + loadSpending round-trips data", () => {
    const today = new Date().toISOString().slice(0, 10);
    const data = { date: today, global: { tokens: 500, costUSD: 0.05 }, agents: { "crew-coder": { tokens: 500, costUSD: 0.05 } } };
    saveSpending(data);
    const loaded = loadSpending();
    assert.equal(loaded.global.tokens, 500);
    assert.equal(loaded.agents["crew-coder"].tokens, 500);
  });

  it("addAgentSpend increments global and per-agent totals", () => {
    // Start fresh
    const today = new Date().toISOString().slice(0, 10);
    saveSpending({ date: today, global: { tokens: 0, costUSD: 0 }, agents: {} });

    addAgentSpend("crew-qa", 1000, 0.01);
    addAgentSpend("crew-qa", 500, 0.005);
    addAgentSpend("crew-coder", 2000, 0.02);

    const s = loadSpending();
    assert.equal(s.global.tokens, 3500);
    assert.ok(Math.abs(s.global.costUSD - 0.035) < 0.0001);
    assert.equal(s.agents["crew-qa"].tokens, 1500);
    assert.equal(s.agents["crew-coder"].tokens, 2000);
  });
});

describe("spending — checkSpendingCap", () => {
  it("returns { exceeded: false } when no config file exists", () => {
    const result = checkSpendingCap("crew-coder", "openai");
    assert.equal(result.exceeded, false);
  });
});
