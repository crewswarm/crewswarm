import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getNestedValue,
  redactRepoConfigForDisplay,
  readRepoConfig
} from '../../src/config/repo-config.ts';

describe('repo-config', () => {
  it('getNestedValue retrieves deeply nested value', () => {
    const src = { a: { b: { c: 42 } } };
    assert.equal(getNestedValue(src, 'a.b.c'), 42);
  });

  it('getNestedValue returns undefined for missing path', () => {
    assert.equal(getNestedValue({}, 'x.y.z'), undefined);
  });

  it('redactRepoConfigForDisplay masks secret-like keys', () => {
    const input = { api_key: 'sk-abc', name: 'safe' };
    const result = redactRepoConfigForDisplay(input);
    assert.equal(result.api_key, '[REDACTED]');
    assert.equal(result.name, 'safe');
  });

  it('readRepoConfig returns empty for nonexistent dir', async () => {
    const result = await readRepoConfig('/tmp/no-such-dir-xyz', 'team');
    assert.deepEqual(result, {});
  });

  it('getNestedValue handles single-level key', () => {
    assert.equal(getNestedValue({ foo: 'bar' }, 'foo'), 'bar');
  });
});
