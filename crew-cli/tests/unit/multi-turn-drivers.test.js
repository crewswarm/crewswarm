/**
 * Unit tests for crew-cli src/executor/multi-turn-drivers.ts
 *
 * Covers:
 *  - detectProvider: maps model names to provider types
 *  - providerSupportsToolCalling: returns true/false per provider
 *  - getProviderConfig: returns URL + key when env var is set, null otherwise
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { detectProvider, providerSupportsToolCalling, getProviderConfig } from '../../src/executor/multi-turn-drivers.ts';

// ── detectProvider ─────────────────────────────────────────────────────────

describe('multi-turn-drivers — detectProvider', () => {
  it('detects gemini models', () => {
    assert.equal(detectProvider('gemini-2.5-flash'), 'gemini');
    assert.equal(detectProvider('google/gemini-2.5-pro'), 'gemini');
  });

  it('detects anthropic models', () => {
    assert.equal(detectProvider('claude-3-5-sonnet-20241022'), 'anthropic');
    assert.equal(detectProvider('anthropic/claude-opus-4-6'), 'anthropic');
  });

  it('detects openai models', () => {
    assert.equal(detectProvider('gpt-4o'), 'openai');
    assert.equal(detectProvider('o1-preview'), 'openai');
    assert.equal(detectProvider('o3-mini'), 'openai');
  });

  it('detects grok models', () => {
    assert.equal(detectProvider('grok-beta'), 'grok');
    assert.equal(detectProvider('xai/grok-4-1-fast-reasoning'), 'grok');
  });

  it('detects deepseek models', () => {
    assert.equal(detectProvider('deepseek-chat'), 'deepseek');
    assert.equal(detectProvider('deepseek/deepseek-reasoner'), 'deepseek');
  });

  it('detects groq models (llama, mixtral)', () => {
    assert.equal(detectProvider('llama-3.3-70b-versatile'), 'groq');
    assert.equal(detectProvider('mixtral-8x7b'), 'groq');
  });

  it('detects mistral models', () => {
    assert.equal(detectProvider('mistral-large'), 'mistral');
  });

  it('detects cerebras models', () => {
    assert.equal(detectProvider('cerebras-llama'), 'cerebras');
  });

  it('returns markers-only for unknown models', () => {
    assert.equal(detectProvider('some-random-model'), 'markers-only');
    assert.equal(detectProvider(''), 'markers-only');
  });

  it('handles null/undefined gracefully', () => {
    assert.equal(detectProvider(null), 'markers-only');
    assert.equal(detectProvider(undefined), 'markers-only');
  });

  it('is case-insensitive', () => {
    assert.equal(detectProvider('GEMINI-2.5-flash'), 'gemini');
    assert.equal(detectProvider('Claude-3-5-sonnet'), 'anthropic');
    assert.equal(detectProvider('GPT-4o'), 'openai');
  });

  it('strips provider prefix before matching', () => {
    assert.equal(detectProvider('openai/gpt-4o'), 'openai');
    assert.equal(detectProvider('google/gemini-2.5-flash'), 'gemini');
  });
});

// ── providerSupportsToolCalling ────────────────────────────────────────────

describe('multi-turn-drivers — providerSupportsToolCalling', () => {
  it('returns true for openai', () => {
    assert.equal(providerSupportsToolCalling('openai'), true);
  });

  it('returns true for anthropic', () => {
    assert.equal(providerSupportsToolCalling('anthropic'), true);
  });

  it('returns true for grok', () => {
    assert.equal(providerSupportsToolCalling('grok'), true);
  });

  it('returns true for deepseek', () => {
    assert.equal(providerSupportsToolCalling('deepseek'), true);
  });

  it('returns true for groq', () => {
    assert.equal(providerSupportsToolCalling('groq'), true);
  });

  it('returns true for mistral', () => {
    assert.equal(providerSupportsToolCalling('mistral'), true);
  });

  it('returns false for gemini', () => {
    assert.equal(providerSupportsToolCalling('gemini'), false);
  });

  it('returns false for markers-only', () => {
    assert.equal(providerSupportsToolCalling('markers-only'), false);
  });

  it('returns false for cerebras', () => {
    assert.equal(providerSupportsToolCalling('cerebras'), false);
  });
});

// ── getProviderConfig ──────────────────────────────────────────────────────

describe('multi-turn-drivers — getProviderConfig', () => {
  // Save and restore env vars around each test
  const savedEnv = {};
  const envKeys = [
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'XAI_API_KEY',
    'DEEPSEEK_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'CEREBRAS_API_KEY'
  ];

  beforeEach(() => {
    for (const k of envKeys) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
      else delete process.env[k];
    }
  });

  it('returns null when no API key is set for openai', () => {
    assert.equal(getProviderConfig('openai', 'gpt-4o'), null);
  });

  it('returns config with URL and key when OPENAI_API_KEY is set', () => {
    process.env.OPENAI_API_KEY = 'test-key-openai';
    const config = getProviderConfig('openai', 'gpt-4o');
    assert.ok(config);
    assert.equal(config.apiKey, 'test-key-openai');
    assert.ok(config.apiUrl.includes('openai.com'));
  });

  it('returns config for anthropic provider', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key-anthropic';
    const config = getProviderConfig('anthropic', 'claude-3-5-sonnet');
    assert.ok(config);
    assert.equal(config.apiKey, 'test-key-anthropic');
    assert.ok(config.apiUrl.includes('anthropic.com'));
  });

  it('returns config for grok provider (XAI_API_KEY)', () => {
    process.env.XAI_API_KEY = 'test-key-xai';
    const config = getProviderConfig('grok', 'grok-beta');
    assert.ok(config);
    assert.equal(config.apiKey, 'test-key-xai');
    assert.ok(config.apiUrl.includes('x.ai'));
  });

  it('returns config for deepseek provider', () => {
    process.env.DEEPSEEK_API_KEY = 'test-key-ds';
    const config = getProviderConfig('deepseek', 'deepseek-chat');
    assert.ok(config);
    assert.equal(config.apiKey, 'test-key-ds');
    assert.ok(config.apiUrl.includes('deepseek.com'));
  });

  it('returns config for groq provider', () => {
    process.env.GROQ_API_KEY = 'test-key-groq';
    const config = getProviderConfig('groq', 'llama-3.3-70b');
    assert.ok(config);
    assert.equal(config.apiKey, 'test-key-groq');
    assert.ok(config.apiUrl.includes('groq.com'));
  });

  it('returns config for mistral provider', () => {
    process.env.MISTRAL_API_KEY = 'test-key-mistral';
    const config = getProviderConfig('mistral', 'mistral-large');
    assert.ok(config);
    assert.equal(config.apiKey, 'test-key-mistral');
    assert.ok(config.apiUrl.includes('mistral.ai'));
  });

  it('returns config for cerebras provider', () => {
    process.env.CEREBRAS_API_KEY = 'test-key-cerebras';
    const config = getProviderConfig('cerebras', 'cerebras-llama');
    assert.ok(config);
    assert.equal(config.apiKey, 'test-key-cerebras');
    assert.ok(config.apiUrl.includes('cerebras.ai'));
  });

  it('returns null for gemini provider', () => {
    assert.equal(getProviderConfig('gemini', 'gemini-2.5-flash'), null);
  });

  it('returns null for markers-only provider', () => {
    assert.equal(getProviderConfig('markers-only', 'unknown'), null);
  });
});
