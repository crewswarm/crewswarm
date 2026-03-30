import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WholeFileStrategy, SearchReplaceStrategy, getStrategy } from '../../src/strategies/index.ts';

describe('strategies', () => {
  it('WholeFileStrategy replaces entire content', () => {
    const s = new WholeFileStrategy();
    assert.equal(s.name, 'whole-file');
    assert.equal(s.apply('old content', 'new content'), 'new content');
  });

  it('SearchReplaceStrategy applies search/replace block', () => {
    const s = new SearchReplaceStrategy();
    const original = 'hello world';
    const change = '<<<<<< SEARCH\nhello\n======\ngoodbye\n>>>>>> REPLACE';
    const result = s.apply(original, change);
    assert.equal(result, 'goodbye world');
  });

  it('SearchReplaceStrategy throws when search block not found', () => {
    const s = new SearchReplaceStrategy();
    const change = '<<<<<< SEARCH\nnotfound\n======\nreplacement\n>>>>>> REPLACE';
    assert.throws(() => s.apply('original', change), /Search block not found/);
  });

  it('getStrategy returns WholeFileStrategy by default', () => {
    const s = getStrategy('unknown');
    assert.equal(s.name, 'whole-file');
  });

  it('getStrategy returns SearchReplaceStrategy for editblock alias', () => {
    const s = getStrategy('editblock');
    assert.equal(s.name, 'search-replace');
  });
});
