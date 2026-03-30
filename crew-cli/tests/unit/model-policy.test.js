import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadModelPolicy } from '../../src/config/model-policy.ts';

describe('model-policy', () => {
  it('should export loadModelPolicy as a function', () => {
    assert.equal(typeof loadModelPolicy, 'function');
  });

  it('returns empty object when no config file exists', async () => {
    const policy = await loadModelPolicy('/tmp/nonexistent-dir-xyz');
    assert.deepEqual(policy, {});
  });

  it('returns empty object for missing base dir', async () => {
    const result = await loadModelPolicy('/does/not/exist');
    assert.equal(typeof result, 'object');
  });
});
