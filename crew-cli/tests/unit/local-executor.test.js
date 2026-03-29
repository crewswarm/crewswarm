/**
 * Unit tests for crew-cli src/executor/local.ts
 *
 * Covers:
 *  - LocalExecutor constructor: creates instance without error
 *  - getDefaultModel: returns model based on env vars
 *  - getDefaultModel: falls back to grok-beta when no keys are set
 *  - calculateCost: returns correct cost for known models
 *  - calculateCost: uses fallback rates for unknown models
 *  - getTimeoutMs: reads from env or defaults to 90000
 *
 * Note: These tests exercise private methods via the class prototype
 * or by observing behavior through public APIs. No network calls are made.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { LocalExecutor } from '../../src/executor/local.ts';

// ── Helpers ────────────────────────────────────────────────────────────────

// Save and restore env vars
const envKeys = [
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'XAI_API_KEY',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'DEEPSEEK_API_KEY', 'GROQ_API_KEY',
  'CREW_EXECUTION_MODEL', 'CREW_CHAT_MODEL', 'CREW_REASONING_MODEL',
  'CREW_EXECUTOR_TIMEOUT_MS', 'CREW_EXECUTION_PROVIDER_ORDER'
];

let savedEnv = {};

function saveEnv() {
  savedEnv = {};
  for (const k of envKeys) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
}

function restoreEnv() {
  for (const k of envKeys) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
    else delete process.env[k];
  }
}

// Access private methods via prototype bind
function callPrivate(instance, methodName, ...args) {
  const method = instance[methodName] || instance.__proto__[methodName];
  if (!method) throw new Error(`No method ${methodName} found`);
  return method.call(instance, ...args);
}

// ── Constructor ────────────────────────────────────────────────────────────

describe('LocalExecutor — constructor', () => {
  it('creates an instance without throwing', () => {
    const executor = new LocalExecutor();
    assert.ok(executor instanceof LocalExecutor);
  });
});

// ── getDefaultModel ────────────────────────────────────────────────────────

describe('LocalExecutor — getDefaultModel', () => {
  beforeEach(() => saveEnv());
  afterEach(() => restoreEnv());

  it('returns CREW_EXECUTION_MODEL when set', () => {
    process.env.CREW_EXECUTION_MODEL = 'custom-model-v1';
    const executor = new LocalExecutor();
    const model = callPrivate(executor, 'getDefaultModel');
    assert.equal(model, 'custom-model-v1');
  });

  it('returns CREW_CHAT_MODEL when CREW_EXECUTION_MODEL is not set', () => {
    process.env.CREW_CHAT_MODEL = 'chat-model-v2';
    const executor = new LocalExecutor();
    const model = callPrivate(executor, 'getDefaultModel');
    assert.equal(model, 'chat-model-v2');
  });

  it('returns CREW_REASONING_MODEL as third priority', () => {
    process.env.CREW_REASONING_MODEL = 'reason-model-v3';
    const executor = new LocalExecutor();
    const model = callPrivate(executor, 'getDefaultModel');
    assert.equal(model, 'reason-model-v3');
  });

  it('returns gpt-4o when only OPENAI_API_KEY is set', () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const executor = new LocalExecutor();
    const model = callPrivate(executor, 'getDefaultModel');
    assert.equal(model, 'gpt-4o');
  });

  it('returns claude model when only ANTHROPIC_API_KEY is set', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const executor = new LocalExecutor();
    const model = callPrivate(executor, 'getDefaultModel');
    assert.equal(model, 'claude-3-5-sonnet-20241022');
  });

  it('returns grok-beta when only XAI_API_KEY is set', () => {
    process.env.XAI_API_KEY = 'test-key';
    const executor = new LocalExecutor();
    const model = callPrivate(executor, 'getDefaultModel');
    assert.equal(model, 'grok-beta');
  });

  it('returns gemini model when GEMINI_API_KEY is set', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const executor = new LocalExecutor();
    const model = callPrivate(executor, 'getDefaultModel');
    assert.equal(model, 'gemini-2.5-flash');
  });

  it('returns gemini model when GOOGLE_API_KEY is set', () => {
    process.env.GOOGLE_API_KEY = 'test-key';
    const executor = new LocalExecutor();
    const model = callPrivate(executor, 'getDefaultModel');
    assert.equal(model, 'gemini-2.5-flash');
  });

  it('returns deepseek-chat when only DEEPSEEK_API_KEY is set', () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    const executor = new LocalExecutor();
    const model = callPrivate(executor, 'getDefaultModel');
    assert.equal(model, 'deepseek-chat');
  });

  it('falls back to grok-beta when no keys are set', () => {
    const executor = new LocalExecutor();
    const model = callPrivate(executor, 'getDefaultModel');
    assert.equal(model, 'grok-beta');
  });

  it('prefers env model over API key detection', () => {
    process.env.CREW_EXECUTION_MODEL = 'my-custom-model';
    process.env.OPENAI_API_KEY = 'test-key';
    const executor = new LocalExecutor();
    const model = callPrivate(executor, 'getDefaultModel');
    assert.equal(model, 'my-custom-model');
  });
});

// ── calculateCost ──────────────────────────────────────────────────────────

describe('LocalExecutor — calculateCost', () => {
  it('calculates cost for grok-beta', () => {
    const executor = new LocalExecutor();
    // grok-beta: prompt=5, completion=15 per 1M tokens
    const cost = callPrivate(executor, 'calculateCost', 'grok-beta', 1_000_000, 1_000_000);
    assert.equal(cost, 5 + 15); // $20
  });

  it('calculates cost for gemini-2.5-flash', () => {
    const executor = new LocalExecutor();
    // gemini-2.5-flash: prompt=0.075, completion=0.30 per 1M tokens
    const cost = callPrivate(executor, 'calculateCost', 'gemini-2.5-flash', 1_000_000, 1_000_000);
    assert.ok(Math.abs(cost - 0.375) < 0.001);
  });

  it('calculates cost for claude-3-5-sonnet', () => {
    const executor = new LocalExecutor();
    // claude-3-5-sonnet: prompt=3, completion=15 per 1M tokens
    const cost = callPrivate(executor, 'calculateCost', 'claude-3-5-sonnet-20241022', 1_000_000, 1_000_000);
    assert.equal(cost, 18);
  });

  it('uses fallback rates for unknown models', () => {
    const executor = new LocalExecutor();
    // fallback: prompt=1, completion=3 per 1M tokens
    const cost = callPrivate(executor, 'calculateCost', 'unknown-model-xyz', 1_000_000, 1_000_000);
    assert.equal(cost, 4);
  });

  it('returns 0 for zero tokens', () => {
    const executor = new LocalExecutor();
    const cost = callPrivate(executor, 'calculateCost', 'grok-beta', 0, 0);
    assert.equal(cost, 0);
  });

  it('scales linearly with token count', () => {
    const executor = new LocalExecutor();
    const cost1k = callPrivate(executor, 'calculateCost', 'grok-beta', 1000, 1000);
    const cost2k = callPrivate(executor, 'calculateCost', 'grok-beta', 2000, 2000);
    assert.ok(Math.abs(cost2k - cost1k * 2) < 0.0001);
  });
});

// ── getTimeoutMs ───────────────────────────────────────────────────────────

describe('LocalExecutor — getTimeoutMs (via timeoutMs field)', () => {
  beforeEach(() => saveEnv());
  afterEach(() => restoreEnv());

  it('defaults to 90000 when env var is not set', () => {
    const executor = new LocalExecutor();
    // timeoutMs is set in the constructor via getTimeoutMs()
    assert.equal(executor['timeoutMs'], 90000);
  });

  it('reads from CREW_EXECUTOR_TIMEOUT_MS env var', () => {
    process.env.CREW_EXECUTOR_TIMEOUT_MS = '120000';
    const executor = new LocalExecutor();
    assert.equal(executor['timeoutMs'], 120000);
  });

  it('falls back to 90000 for invalid values', () => {
    process.env.CREW_EXECUTOR_TIMEOUT_MS = 'not-a-number';
    const executor = new LocalExecutor();
    assert.equal(executor['timeoutMs'], 90000);
  });

  it('falls back to 90000 for values below 1000', () => {
    process.env.CREW_EXECUTOR_TIMEOUT_MS = '500';
    const executor = new LocalExecutor();
    assert.equal(executor['timeoutMs'], 90000);
  });
});

// ── getConfiguredProviderOrder ─────────────────────────────────────────────

describe('LocalExecutor — getConfiguredProviderOrder', () => {
  beforeEach(() => saveEnv());
  afterEach(() => restoreEnv());

  it('returns only providers with API keys set', () => {
    process.env.OPENAI_API_KEY = 'test';
    process.env.GROQ_API_KEY = 'test';
    const executor = new LocalExecutor();
    const order = callPrivate(executor, 'getConfiguredProviderOrder');
    assert.ok(order.includes('openai'));
    assert.ok(order.includes('groq'));
    assert.ok(!order.includes('anthropic'));
  });

  it('respects CREW_EXECUTION_PROVIDER_ORDER env var', () => {
    process.env.CREW_EXECUTION_PROVIDER_ORDER = 'groq,openai';
    process.env.GROQ_API_KEY = 'test';
    process.env.OPENAI_API_KEY = 'test';
    const executor = new LocalExecutor();
    const order = callPrivate(executor, 'getConfiguredProviderOrder');
    assert.equal(order[0], 'groq');
    assert.equal(order[1], 'openai');
  });

  it('returns empty array when no API keys are set', () => {
    const executor = new LocalExecutor();
    const order = callPrivate(executor, 'getConfiguredProviderOrder');
    assert.equal(order.length, 0);
  });
});
