import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokens,
  getContextWindow,
  adaptiveCompressionRatio,
  calculateTokenBudget,
  compactConversation
} from '../../src/context/token-compaction.ts';

// ─── estimateTokens ─────────────────────────────────────────────────

test('estimateTokens returns 0 for empty string', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
});

test('estimateTokens produces reasonable estimates', () => {
  // "Hello world" is ~3 tokens in most tokenizers
  const tokens = estimateTokens('Hello world');
  assert.ok(tokens >= 2 && tokens <= 5, `Expected 2-5, got ${tokens}`);
});

test('estimateTokens scales with text length', () => {
  const short = estimateTokens('hi');
  const long = estimateTokens('a'.repeat(1000));
  assert.ok(long > short * 10);
});

// ─── getContextWindow ────────────────────────────────────────────────

test('getContextWindow returns correct sizes for known models', () => {
  assert.equal(getContextWindow('gemini-2.5-flash'), 1_048_576);
  assert.equal(getContextWindow('gpt-4o'), 128_000);
  assert.equal(getContextWindow('claude-opus-4-6'), 200_000);
  assert.equal(getContextWindow('grok-4-1-fast'), 131_072);
  assert.equal(getContextWindow('deepseek-chat'), 128_000);
});

test('getContextWindow returns default for unknown models', () => {
  assert.equal(getContextWindow('some-unknown-model'), 128_000);
});

test('getContextWindow is case-insensitive', () => {
  assert.equal(getContextWindow('Gemini-2.5-Flash'), 1_048_576);
});

// ─── adaptiveCompressionRatio ────────────────────────────────────────

test('adaptiveCompressionRatio returns light compression at low usage', () => {
  const { firstN, lastN } = adaptiveCompressionRatio(20, 0.3);
  assert.equal(firstN, 5);
  assert.equal(lastN, 8);
});

test('adaptiveCompressionRatio returns standard compression at medium usage', () => {
  const { firstN, lastN } = adaptiveCompressionRatio(20, 0.6);
  assert.equal(firstN, 3);
  assert.equal(lastN, 5);
});

test('adaptiveCompressionRatio returns aggressive compression at high usage', () => {
  const { firstN, lastN } = adaptiveCompressionRatio(20, 0.8);
  assert.equal(firstN, 1);
  assert.equal(lastN, 3);
});

// ─── calculateTokenBudget ────────────────────────────────────────────

test('calculateTokenBudget reports correct context window', () => {
  const budget = calculateTokenBudget([{ content: 'test' }], 'gpt-4o', 0);
  assert.equal(budget.contextWindow, 128_000);
});

test('calculateTokenBudget shouldCompact is false when under threshold', () => {
  const budget = calculateTokenBudget([{ content: 'short' }], 'gpt-4o', 100);
  assert.equal(budget.shouldCompact, false);
});

test('calculateTokenBudget shouldCompact is true when over threshold', () => {
  // Create a huge message that exceeds 75% of context
  const bigContent = 'x'.repeat(400_000); // ~108K tokens > 75% of 128K
  const budget = calculateTokenBudget([{ content: bigContent }], 'gpt-4o', 0);
  assert.equal(budget.shouldCompact, true);
});

// ─── compactConversation ─────────────────────────────────────────────

test('compactConversation returns unchanged if fewer messages than keepFirst+keepLast', async () => {
  const messages = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' }
  ];
  const result = await compactConversation(messages);
  assert.equal(result.length, 2);
});

test('compactConversation compresses middle messages', async () => {
  const messages = [];
  for (let i = 0; i < 20; i++) {
    messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Message ${i}: ${'x'.repeat(100)}` });
  }
  const result = await compactConversation(messages, { keepFirst: 2, keepLast: 2 });
  assert.ok(result.length < messages.length, `Expected fewer messages, got ${result.length}`);
  // Should have: 2 head + 1 summary + 2 tail = 5
  assert.equal(result.length, 5);
  assert.ok(result[2].isCompacted === true);
});
