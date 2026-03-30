import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runSrcCli, createSrcBatchPlan } from '../../src/sourcegraph/index.ts';

describe('sourcegraph', () => {
  it('should export runSrcCli', () => {
    assert.equal(typeof runSrcCli, 'function');
  });

  it('should export createSrcBatchPlan', () => {
    assert.equal(typeof createSrcBatchPlan, 'function');
  });

  it('createSrcBatchPlan fails with missing query', async () => {
    const result = await createSrcBatchPlan({ query: '', repos: [] });
    assert.equal(result.success, false);
    assert.ok(result.message.includes('Missing --query'));
  });
});
