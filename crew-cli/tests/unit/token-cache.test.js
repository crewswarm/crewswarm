import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TokenCache } from '../../src/cache/token-cache.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('TokenCache', () => {
  it('hashKey should return a hex string', () => {
    const hash = TokenCache.hashKey('test-input');
    assert.equal(typeof hash, 'string');
    assert.match(hash, /^[a-f0-9]{64}$/);
  });

  it('hashKey should be deterministic', () => {
    assert.equal(TokenCache.hashKey('foo'), TokenCache.hashKey('foo'));
  });

  it('hashKey handles empty string', () => {
    const hash = TokenCache.hashKey('');
    assert.equal(typeof hash, 'string');
    assert.equal(hash.length, 64);
  });

  it('get returns miss for nonexistent key', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'tc-'));
    try {
      const cache = new TokenCache(tmp);
      const result = await cache.get('ns', 'missing-key');
      assert.equal(result.hit, false);
      assert.equal(result.value, undefined);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('set then get returns hit', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'tc-'));
    try {
      const cache = new TokenCache(tmp);
      await cache.set('ns', 'key1', { data: 42 }, 3600);
      const result = await cache.get('ns', 'key1');
      assert.equal(result.hit, true);
      assert.deepEqual(result.value, { data: 42 });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
