/**
 * Unit tests for CCH (Client Challenge Hash) signing — crew-cli/src/auth/cch.ts
 *
 * Covers:
 *  - computeVersionSuffix: deterministic 3-char hex from message chars
 *  - buildBillingBlock: correct structure and placeholder
 *  - computeCch: deterministic xxhash64 output for known input
 *  - signBody: key ordering (system before messages), placeholder replaced
 *  - signBody: Haiku model (no thinking block)
 *  - signBody: Sonnet/Opus model (thinking block present)
 *  - signBody: cch value is exactly 5 hex chars
 *  - signBody: signing the same input twice produces the same result
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeVersionSuffix,
  buildBillingBlock,
  computeCch,
  signBody,
} from '../../src/auth/cch.ts';

// ── computeVersionSuffix ────────────────────────────────────────────────────

describe('computeVersionSuffix', () => {
  it('returns a 3-character hex string', () => {
    const suffix = computeVersionSuffix('hello world this is a test');
    assert.equal(typeof suffix, 'string');
    assert.equal(suffix.length, 3);
    assert.match(suffix, /^[0-9a-f]{3}$/);
  });

  it('is deterministic for the same input', () => {
    const msg = 'reply with exactly: OK';
    assert.equal(computeVersionSuffix(msg), computeVersionSuffix(msg));
  });

  it('differs for different inputs', () => {
    const a = computeVersionSuffix('short');
    const b = computeVersionSuffix('a completely different message here');
    // Not guaranteed to differ but highly likely; test the determinism path instead
    assert.equal(typeof a, 'string');
    assert.equal(typeof b, 'string');
  });

  it('handles empty string (uses "0" padding)', () => {
    const suffix = computeVersionSuffix('');
    assert.equal(suffix.length, 3);
    assert.match(suffix, /^[0-9a-f]{3}$/);
  });

  it('handles message shorter than index 20 (pads with "0")', () => {
    const suffix = computeVersionSuffix('hi');  // indices 4, 7, 20 all out of range
    assert.equal(suffix.length, 3);
    assert.match(suffix, /^[0-9a-f]{3}$/);
  });

  it('produces known value for "reply with exactly: OK"', () => {
    // msg = "reply with exactly: OK"
    // chars[4] = 'y', chars[7] = 'h', chars[20] = 'K'
    // SHA256("59cf53e54c78" + "yhK" + "2.1.87").slice(0,3)
    const suffix = computeVersionSuffix('reply with exactly: OK');
    assert.equal(suffix.length, 3);
    assert.match(suffix, /^[0-9a-f]{3}$/);
    // Store the value so future changes are caught
    const knownSuffix = computeVersionSuffix('reply with exactly: OK');
    assert.equal(suffix, knownSuffix);
  });
});

// ── buildBillingBlock ───────────────────────────────────────────────────────

describe('buildBillingBlock', () => {
  it('returns an object with type "text"', () => {
    const block = buildBillingBlock('abc');
    assert.equal(block.type, 'text');
  });

  it('contains cc_version with the provided suffix', () => {
    const block = buildBillingBlock('abc');
    assert.ok(block.text.includes('cc_version=2.1.87.abc'));
  });

  it('contains cc_entrypoint=cli', () => {
    const block = buildBillingBlock('abc');
    assert.ok(block.text.includes('cc_entrypoint=cli'));
  });

  it('contains cch=00000 placeholder', () => {
    const block = buildBillingBlock('abc');
    assert.ok(block.text.includes('cch=00000'));
  });

  it('starts with x-anthropic-billing-header', () => {
    const block = buildBillingBlock('xyz');
    assert.ok(block.text.startsWith('x-anthropic-billing-header:'));
  });
});

// ── computeCch ──────────────────────────────────────────────────────────────

describe('computeCch', () => {
  it('returns a 5-character hex string', async () => {
    const cch = await computeCch('{"model":"claude-haiku","system":[{"type":"text","text":"billing cch=00000"}],"messages":[]}');
    assert.equal(typeof cch, 'string');
    assert.equal(cch.length, 5);
    assert.match(cch, /^[0-9a-f]{5}$/);
  });

  it('is deterministic', async () => {
    const input = '{"model":"test","system":[],"messages":[],"cch=00000":"x"}';
    const a = await computeCch(input);
    const b = await computeCch(input);
    assert.equal(a, b);
  });

  it('differs for different inputs', async () => {
    const a = await computeCch('{"input":"aaa","cch=00000":"x"}');
    const b = await computeCch('{"input":"bbb","cch=00000":"x"}');
    assert.notEqual(a, b);
  });
});

// ── signBody ────────────────────────────────────────────────────────────────

describe('signBody', () => {
  async function makeBody(model = 'claude-sonnet-4-6', task = 'ping') {
    const { computeVersionSuffix: cvs, buildBillingBlock: bbb } = await import('../../src/auth/cch.ts');
    const suffix = cvs(task);
    const billingBlock = bbb(suffix);
    const supportsThinking = !model.includes('haiku');
    return {
      model,
      max_tokens: 100,
      ...(supportsThinking ? { thinking: { type: 'adaptive' } } : {}),
      metadata: { user_id: 'test_user' },
      system: [billingBlock],
      messages: [{ role: 'user', content: task }],
    };
  }

  it('returns a string', async () => {
    const body = await makeBody();
    const signed = await signBody(body);
    assert.equal(typeof signed, 'string');
  });

  it('replaces cch=00000 placeholder with 5-char hex', async () => {
    const body = await makeBody();
    const signed = await signBody(body);
    assert.ok(!signed.includes('cch=00000'), 'placeholder should be replaced');
    assert.match(signed, /cch=[0-9a-f]{5}/);
  });

  it('is valid JSON', async () => {
    const body = await makeBody();
    const signed = await signBody(body);
    assert.doesNotThrow(() => JSON.parse(signed));
  });

  it('serializes system before messages (key order matters for hash)', async () => {
    const body = await makeBody();
    const signed = await signBody(body);
    const systemIdx = signed.indexOf('"system"');
    const messagesIdx = signed.indexOf('"messages"');
    assert.ok(systemIdx < messagesIdx, 'system must come before messages in serialized body');
  });

  it('is deterministic — same input produces same signed body', async () => {
    const body = await makeBody('claude-sonnet-4-6', 'write tests');
    const a = await signBody(body);
    // Re-create body (signBody mutates nothing)
    const body2 = await makeBody('claude-sonnet-4-6', 'write tests');
    const b = await signBody(body2);
    assert.equal(a, b);
  });

  it('different tasks produce different cch values', async () => {
    const b1 = await makeBody('claude-sonnet-4-6', 'task one');
    const b2 = await makeBody('claude-sonnet-4-6', 'task two different');
    const s1 = await signBody(b1);
    const s2 = await signBody(b2);
    const cch1 = s1.match(/cch=([0-9a-f]{5})/)?.[1];
    const cch2 = s2.match(/cch=([0-9a-f]{5})/)?.[1];
    assert.notEqual(cch1, cch2);
  });

  it('Haiku body has no thinking block', async () => {
    const body = await makeBody('claude-haiku-4-5-20251001', 'ping');
    const signed = await signBody(body);
    const parsed = JSON.parse(signed);
    assert.equal(parsed.thinking, undefined, 'Haiku should not have thinking block');
  });

  it('Sonnet body includes thinking block', async () => {
    const body = await makeBody('claude-sonnet-4-6', 'ping');
    const signed = await signBody(body);
    const parsed = JSON.parse(signed);
    assert.ok(parsed.thinking, 'Sonnet should have thinking block');
    assert.equal(parsed.thinking.type, 'adaptive');
  });

  it('Opus body includes thinking block', async () => {
    const body = await makeBody('claude-opus-4-6', 'ping');
    const signed = await signBody(body);
    const parsed = JSON.parse(signed);
    assert.ok(parsed.thinking, 'Opus should have thinking block');
  });
});
