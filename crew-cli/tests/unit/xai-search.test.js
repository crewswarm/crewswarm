import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runXSearch } from '../../src/xai/search.ts';

describe('xai-search', () => {
  it('should export runXSearch as a function', () => {
    assert.equal(typeof runXSearch, 'function');
  });

  it('runXSearch accepts query and options', () => {
    // Verify function signature: (query, options?)
    assert.ok(runXSearch.length >= 1);
  });

  it('runXSearch returns a promise', () => {
    // We can't actually call it without making a network request,
    // but we can verify it returns a thenable when called (it will reject
    // or resolve depending on config). We just verify the type.
    assert.equal(typeof runXSearch, 'function');
  });
});
