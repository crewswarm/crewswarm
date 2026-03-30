import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// CumulativeDiffSandbox extends Sandbox which has complex deps.
// We smoke-test the import.
describe('cumulative-diff', () => {
  it('should export CumulativeDiffSandbox class', async () => {
    const mod = await import('../../src/sandbox/cumulative-diff.ts');
    assert.equal(typeof mod.CumulativeDiffSandbox, 'function');
  });
});
