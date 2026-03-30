import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TokenFinder } from '../../src/auth/token-finder.ts';

describe('TokenFinder', () => {
  it('should be constructable', () => {
    const tf = new TokenFinder();
    assert.ok(tf);
  });

  it('findTokens should return an object', async () => {
    const tf = new TokenFinder();
    const tokens = await tf.findTokens();
    assert.equal(typeof tokens, 'object');
    // AuthTokens fields are all optional strings
    for (const key of ['claude', 'cursor', 'gemini', 'openai']) {
      if (tokens[key] !== undefined) {
        assert.equal(typeof tokens[key], 'string');
      }
    }
  });

  it('findTokens result should not throw', async () => {
    const tf = new TokenFinder();
    await assert.doesNotReject(() => tf.findTokens());
  });
});
