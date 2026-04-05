import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let recallSearch, buildRecallContext;

describe('ChatRecall', async () => {
  before(async () => {
    const mod = await import('../../src/engine/chat-recall.ts');
    recallSearch = mod.recallSearch;
    buildRecallContext = mod.buildRecallContext;
  });

  it('returns empty for non-existent directory', async () => {
    const result = await recallSearch('test query', '/tmp/nonexistent-' + Date.now());
    assert.equal(result.entries.length, 0);
    assert.equal(result.totalSearched, 0);
  });

  it('buildRecallContext returns empty for no results', () => {
    const ctx = buildRecallContext({ query: 'test', entries: [], totalSearched: 0 });
    assert.equal(ctx, '');
  });

  it('buildRecallContext formats results', () => {
    const ctx = buildRecallContext({
      query: 'test',
      entries: [{
        sessionId: 's1',
        timestamp: '2026-04-05T00:00:00Z',
        input: 'fix the bug',
        output: 'done',
        score: 0.8
      }],
      totalSearched: 1
    });
    assert.ok(ctx.includes('fix the bug'));
    assert.ok(ctx.includes('Relevant past'));
  });
});
