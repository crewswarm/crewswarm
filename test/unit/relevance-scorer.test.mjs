/**
 * Unit tests for lib/memory/relevance-scorer.mjs
 *
 * Covers:
 *  - computeRecency:      newer beats older, edge cases
 *  - computeFrequency:    more-accessed beats less-accessed, zero/max edge cases
 *  - computeKeywordMatch: exact match beats partial, empty inputs, long-word weighting
 *  - computeContextMatch: same project/agent/session bonus, mismatches give 0
 *  - scoreMemory:         combined weighted score, missing fields graceful
 *  - rankMemories:        ordering with mixed signals, maxResults, empty array
 *  - maxAccessCount:      utility helper
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeRecency,
  computeFrequency,
  computeKeywordMatch,
  computeContextMatch,
  scoreMemory,
  rankMemories,
  maxAccessCount,
} from '../../lib/memory/relevance-scorer.mjs';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create an ISO timestamp N days in the past relative to nowMs */
function daysAgo(n, nowMs = Date.now()) {
  return new Date(nowMs - n * 24 * 60 * 60 * 1000).toISOString();
}

const NOW = Date.now();

// ─── computeRecency ─────────────────────────────────────────────────────────

describe('computeRecency', () => {
  it('returns 1.0 for a timestamp equal to now', () => {
    const score = computeRecency(new Date(NOW).toISOString(), NOW);
    assert.ok(score > 0.99, `expected ~1, got ${score}`);
  });

  it('newer memory beats older memory', () => {
    const scoreNew = computeRecency(daysAgo(1, NOW), NOW);
    const scoreOld = computeRecency(daysAgo(60, NOW), NOW);
    assert.ok(scoreNew > scoreOld, `new(${scoreNew}) should > old(${scoreOld})`);
  });

  it('score decays toward 0 for very old memories (365 days)', () => {
    const score = computeRecency(daysAgo(365, NOW), NOW);
    assert.ok(score < 0.01, `expected near-zero, got ${score}`);
  });

  it('returns 0 for null/undefined timestamp', () => {
    assert.equal(computeRecency(null, NOW), 0);
    assert.equal(computeRecency(undefined, NOW), 0);
  });

  it('returns 0 for an invalid date string', () => {
    assert.equal(computeRecency('not-a-date', NOW), 0);
  });

  it('accepts epoch milliseconds as a number', () => {
    const score = computeRecency(NOW - 0, NOW);
    assert.ok(score > 0.99);
  });
});

// ─── computeFrequency ────────────────────────────────────────────────────────

describe('computeFrequency', () => {
  it('returns 0 for zero access count', () => {
    assert.equal(computeFrequency(0), 0);
  });

  it('returns 1.0 when accessCount equals maxAccessCount', () => {
    assert.equal(computeFrequency(100, 100), 1);
  });

  it('more-accessed memory scores higher than less-accessed', () => {
    const scoreHigh = computeFrequency(50, 100);
    const scoreLow  = computeFrequency(5, 100);
    assert.ok(scoreHigh > scoreLow, `high(${scoreHigh}) should > low(${scoreLow})`);
  });

  it('result is in [0, 1]', () => {
    for (const count of [0, 1, 10, 100, 1000]) {
      const s = computeFrequency(count, 100);
      assert.ok(s >= 0 && s <= 1.0001, `out of range: ${s} for count ${count}`);
    }
  });

  it('handles negative accessCount gracefully (treated as 0)', () => {
    assert.equal(computeFrequency(-5, 100), 0);
  });
});

// ─── computeKeywordMatch ─────────────────────────────────────────────────────

describe('computeKeywordMatch', () => {
  it('returns 1.0 for identical single-word content and query', () => {
    const score = computeKeywordMatch('authentication', 'authentication');
    assert.ok(score > 0.99, `expected ~1, got ${score}`);
  });

  it('exact full match beats partial match', () => {
    const scoreFull    = computeKeywordMatch('memory retrieval scoring system', 'memory retrieval scoring system');
    const scorePartial = computeKeywordMatch('memory retrieval', 'memory retrieval scoring system');
    assert.ok(scoreFull > scorePartial);
  });

  it('returns 0 for empty query', () => {
    assert.equal(computeKeywordMatch('some memory content', ''), 0);
  });

  it('returns 0 for empty content', () => {
    assert.equal(computeKeywordMatch('', 'query terms here'), 0);
  });

  it('returns 0 when content and query share no tokens', () => {
    const score = computeKeywordMatch('apple orange banana', 'software deployment pipeline');
    assert.equal(score, 0);
  });

  it('longer/rarer query words contribute more weight (IDF proxy)', () => {
    // "authentication" (14 chars) should weigh more than "is" (2 chars)
    // Verify indirectly: a content matching the long word scores > matching short word
    const scoreRare   = computeKeywordMatch('authentication token', 'authentication is');
    const scoreCommon = computeKeywordMatch('is broken', 'authentication is');
    assert.ok(scoreRare > scoreCommon, `rare-word match(${scoreRare}) should > common-word match(${scoreCommon})`);
  });

  it('handles non-string inputs gracefully', () => {
    assert.equal(computeKeywordMatch(null, 'query'), 0);
    assert.equal(computeKeywordMatch('content', null), 0);
    assert.equal(computeKeywordMatch(undefined, undefined), 0);
  });
});

// ─── computeContextMatch ─────────────────────────────────────────────────────

describe('computeContextMatch', () => {
  it('returns 0 when neither memory nor context have matching fields', () => {
    const score = computeContextMatch(
      { projectId: 'proj-a', agentId: 'agent-x' },
      { projectId: 'proj-b', agentId: 'agent-y' }
    );
    assert.equal(score, 0);
  });

  it('same projectId adds 0.5', () => {
    const score = computeContextMatch(
      { projectId: 'proj-1' },
      { projectId: 'proj-1' }
    );
    assert.equal(score, 0.5);
  });

  it('same agentId adds 0.3', () => {
    const score = computeContextMatch(
      { agentId: 'crew-coder' },
      { agentId: 'crew-coder' }
    );
    assert.equal(score, 0.3);
  });

  it('same sessionId adds 0.2', () => {
    const score = computeContextMatch(
      { sessionId: 'sess-abc' },
      { sessionId: 'sess-abc' }
    );
    assert.equal(score, 0.2);
  });

  it('all three matching caps at 1.0', () => {
    const score = computeContextMatch(
      { projectId: 'p', agentId: 'a', sessionId: 's' },
      { projectId: 'p', agentId: 'a', sessionId: 's' }
    );
    assert.equal(score, 1.0);
  });

  it('same project beats same agent alone', () => {
    const scoreProject = computeContextMatch(
      { projectId: 'proj-x', agentId: 'agent-1' },
      { projectId: 'proj-x', agentId: 'agent-2' }
    );
    const scoreAgent = computeContextMatch(
      { projectId: 'proj-a', agentId: 'agent-1' },
      { projectId: 'proj-b', agentId: 'agent-1' }
    );
    assert.ok(scoreProject > scoreAgent, `project(${scoreProject}) should > agent(${scoreAgent})`);
  });

  it('returns 0 for null/empty context', () => {
    assert.equal(computeContextMatch({ projectId: 'p' }, {}), 0);
    assert.equal(computeContextMatch({ projectId: 'p' }, null), 0);
  });
});

// ─── scoreMemory ─────────────────────────────────────────────────────────────

describe('scoreMemory', () => {
  it('returns a number in [0, 1]', () => {
    const mem = {
      content: 'authentication and OAuth token management',
      timestamp: daysAgo(5, NOW),
      accessCount: 10,
      projectId: 'proj-1',
      agentId: 'crew-coder'
    };
    const score = scoreMemory(mem, 'OAuth token', { projectId: 'proj-1' }, { nowMs: NOW });
    assert.ok(typeof score === 'number');
    assert.ok(score >= 0 && score <= 1, `out of range: ${score}`);
  });

  it('high-relevance memory scores above 0.5', () => {
    const mem = {
      content: 'OAuth authentication token management for API access',
      timestamp: daysAgo(1, NOW),
      accessCount: 50,
      projectId: 'proj-x',
      agentId: 'crew-coder'
    };
    const score = scoreMemory(
      mem,
      'OAuth authentication token',
      { projectId: 'proj-x', agentId: 'crew-coder' },
      { nowMs: NOW }
    );
    assert.ok(score > 0.5, `expected > 0.5, got ${score}`);
  });

  it('returns 0 for null memory', () => {
    assert.equal(scoreMemory(null, 'query'), 0);
  });

  it('handles memory with no optional fields', () => {
    const score = scoreMemory({ content: 'simple fact' }, 'simple', {}, { nowMs: NOW });
    assert.ok(typeof score === 'number' && score >= 0);
  });

  it('newer memory scores higher than identical older memory', () => {
    const base = { content: 'deployment pipeline step', accessCount: 0 };
    const scoreNew = scoreMemory({ ...base, timestamp: daysAgo(1, NOW) }, 'deployment', {}, { nowMs: NOW });
    const scoreOld = scoreMemory({ ...base, timestamp: daysAgo(90, NOW) }, 'deployment', {}, { nowMs: NOW });
    assert.ok(scoreNew > scoreOld, `new(${scoreNew}) should > old(${scoreOld})`);
  });
});

// ─── rankMemories ─────────────────────────────────────────────────────────────

describe('rankMemories', () => {
  it('returns empty array for empty input', () => {
    assert.deepEqual(rankMemories([], 'query'), []);
  });

  it('returns empty array for non-array input', () => {
    assert.deepEqual(rankMemories(null, 'query'), []);
    assert.deepEqual(rankMemories(undefined, 'query'), []);
  });

  it('respects maxResults limit', () => {
    const memories = Array.from({ length: 20 }, (_, i) => ({
      content: `memory item number ${i}`,
      timestamp: daysAgo(i, NOW),
      accessCount: i
    }));
    const ranked = rankMemories(memories, 'memory item', {}, 5, { nowMs: NOW });
    assert.equal(ranked.length, 5);
  });

  it('attaches relevanceScore to each result', () => {
    const memories = [
      { content: 'alpha beta', timestamp: daysAgo(1, NOW), accessCount: 1 },
      { content: 'gamma delta', timestamp: daysAgo(2, NOW), accessCount: 0 }
    ];
    const ranked = rankMemories(memories, 'alpha', {}, 10, { nowMs: NOW });
    for (const m of ranked) {
      assert.ok('relevanceScore' in m, 'missing relevanceScore');
      assert.ok(typeof m.relevanceScore === 'number');
    }
  });

  it('higher-relevance memories appear first (keyword signal)', () => {
    const memories = [
      { content: 'unrelated topic about cooking recipes', timestamp: daysAgo(1, NOW), accessCount: 0 },
      { content: 'OAuth authentication and JWT token validation', timestamp: daysAgo(1, NOW), accessCount: 0 }
    ];
    const ranked = rankMemories(memories, 'OAuth JWT token', {}, 10, { nowMs: NOW });
    assert.ok(ranked[0].content.includes('OAuth'), `expected OAuth first, got: ${ranked[0].content}`);
  });

  it('same-project memory beats cross-project with weaker keyword match', () => {
    const inProject = {
      content: 'database migration step',
      timestamp: daysAgo(1, NOW),
      accessCount: 0,
      projectId: 'proj-target'
    };
    const crossProject = {
      content: 'database migration query execution plan details and rollback procedures',
      timestamp: daysAgo(1, NOW),
      accessCount: 0,
      projectId: 'proj-other'
    };
    // Strong context signal should help in-project item compete
    const ranked = rankMemories(
      [crossProject, inProject],
      'database migration',
      { projectId: 'proj-target' },
      10,
      { nowMs: NOW }
    );
    // The in-project item should rank first (context +0.5 outweighs marginal keyword advantage)
    assert.equal(ranked[0].projectId, 'proj-target', 'same-project memory should rank first');
  });

  it('more-accessed memory beats less-accessed with same content and age', () => {
    const highFreq = { content: 'shared config pattern', timestamp: daysAgo(10, NOW), accessCount: 80 };
    const lowFreq  = { content: 'shared config pattern', timestamp: daysAgo(10, NOW), accessCount: 2  };
    const ranked = rankMemories([lowFreq, highFreq], 'shared config', {}, 10, { nowMs: NOW, maxAccessCount: 100 });
    assert.ok(ranked[0].accessCount === 80, 'high-frequency memory should rank first');
  });

  it('combined ranking: newer + matching keyword + context all contribute', () => {
    const best = {
      content: 'API rate limiting and token bucket algorithm',
      timestamp: daysAgo(2, NOW),
      accessCount: 30,
      projectId: 'proj-api',
      agentId: 'crew-backend'
    };
    const worst = {
      content: 'irrelevant historical note from a different team',
      timestamp: daysAgo(180, NOW),
      accessCount: 0,
      projectId: 'proj-other',
      agentId: 'crew-frontend'
    };
    const middle = {
      content: 'token bucket algorithm overview',
      timestamp: daysAgo(20, NOW),
      accessCount: 5,
      projectId: 'proj-other'
    };

    const ranked = rankMemories(
      [worst, middle, best],
      'API rate limiting token',
      { projectId: 'proj-api', agentId: 'crew-backend' },
      10,
      { nowMs: NOW }
    );

    assert.equal(ranked[0].content, best.content,  'best should rank first');
    assert.equal(ranked[2].content, worst.content, 'worst should rank last');
  });
});

// ─── maxAccessCount ───────────────────────────────────────────────────────────

describe('maxAccessCount', () => {
  it('returns 0 for empty array', () => {
    assert.equal(maxAccessCount([]), 0);
  });

  it('returns 0 for null/undefined', () => {
    assert.equal(maxAccessCount(null), 0);
    assert.equal(maxAccessCount(undefined), 0);
  });

  it('returns the maximum accessCount across all memories', () => {
    const memories = [
      { accessCount: 5 },
      { accessCount: 42 },
      { accessCount: 17 }
    ];
    assert.equal(maxAccessCount(memories), 42);
  });

  it('handles memories without accessCount field (treats as 0)', () => {
    const memories = [{ content: 'no count' }, { accessCount: 10 }];
    assert.equal(maxAccessCount(memories), 10);
  });
});
