import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearOldToolResults,
  TOOL_RESULT_CLEARING_PROMPT,
} from '../../src/executor/tool-result-clearing.ts';

function makeTurn(turn, tool, result, error) {
  return { turn, tool, params: {}, result: result ?? null, error };
}

describe('clearOldToolResults', () => {
  it('returns empty array for empty input', () => {
    assert.deepEqual(clearOldToolResults([]), []);
  });

  it('leaves history untouched when length <= keepRecent (default 5)', () => {
    const history = [1, 2, 3].map(i => makeTurn(i, 'grep', `result-${i}`));
    const out = clearOldToolResults(history);
    assert.equal(out.length, 3);
    assert.equal(out[0].result, 'result-1');
    assert.equal(out[2].result, 'result-3');
  });

  it('replaces results for turns older than keepRecent', () => {
    const history = [1, 2, 3, 4, 5, 6, 7].map(i => makeTurn(i, 'grep', 'x'.repeat(100)));
    const out = clearOldToolResults(history, { keepRecent: 5 });
    assert.equal(out.length, 7);
    // First 2 turns should be cleared
    assert.ok(out[0].result.startsWith('[Result cleared'), `got: ${out[0].result}`);
    assert.ok(out[1].result.startsWith('[Result cleared'), `got: ${out[1].result}`);
    // Last 5 turns should be intact
    assert.equal(out[2].result, 'x'.repeat(100));
    assert.equal(out[6].result, 'x'.repeat(100));
  });

  it('placeholder includes tool name and byte count', () => {
    const history = [
      makeTurn(1, 'file_read', 'hello world'),
    ];
    // keepRecent=0 so this one entry gets cleared
    const out = clearOldToolResults(history, { keepRecent: 0 });
    const placeholder = out[0].result;
    assert.ok(typeof placeholder === 'string');
    assert.ok(placeholder.includes('file_read'), `placeholder: ${placeholder}`);
    assert.ok(placeholder.includes('bytes'), `placeholder: ${placeholder}`);
  });

  it('does not mutate the original history array', () => {
    const history = [makeTurn(1, 'grep', 'original')];
    clearOldToolResults(history, { keepRecent: 0 });
    assert.equal(history[0].result, 'original');
  });

  it('respects custom keepRecent value', () => {
    const history = [1, 2, 3, 4, 5].map(i => makeTurn(i, 'glob', `data-${i}`));
    const out = clearOldToolResults(history, { keepRecent: 2 });
    // Turns 1-3 cleared, 4-5 intact
    assert.ok(out[0].result.startsWith('[Result cleared'));
    assert.ok(out[1].result.startsWith('[Result cleared'));
    assert.ok(out[2].result.startsWith('[Result cleared'));
    assert.equal(out[3].result, 'data-4');
    assert.equal(out[4].result, 'data-5');
  });

  it('truncates oversized recent results', () => {
    const bigResult = 'a'.repeat(5000);
    const history = [makeTurn(1, 'read_file', bigResult)];
    const out = clearOldToolResults(history, { keepRecent: 1, maxResultLength: 2000 });
    assert.ok(out[0].result.length < bigResult.length);
    assert.ok(out[0].result.includes('[...truncated'));
  });

  it('does not truncate when maxResultLength is 0', () => {
    const bigResult = 'b'.repeat(5000);
    const history = [makeTurn(1, 'read_file', bigResult)];
    const out = clearOldToolResults(history, { keepRecent: 1, maxResultLength: 0 });
    assert.equal(out[0].result, bigResult);
  });

  it('handles object results in cleared turns', () => {
    const history = [makeTurn(1, 'git_status', { files: ['a.ts', 'b.ts'] })];
    const out = clearOldToolResults(history, { keepRecent: 0 });
    assert.ok(out[0].result.startsWith('[Result cleared'));
    assert.ok(out[0].result.includes('bytes'));
  });

  it('preserves error field on cleared turns', () => {
    const history = [{ ...makeTurn(1, 'bash', null, 'command not found') }];
    const out = clearOldToolResults(history, { keepRecent: 0 });
    assert.equal(out[0].error, 'command not found');
  });
});

describe('TOOL_RESULT_CLEARING_PROMPT', () => {
  it('is a non-empty string', () => {
    assert.ok(typeof TOOL_RESULT_CLEARING_PROMPT === 'string');
    assert.ok(TOOL_RESULT_CLEARING_PROMPT.length > 10);
  });

  it('mentions writing down important information', () => {
    assert.ok(TOOL_RESULT_CLEARING_PROMPT.toLowerCase().includes('write down'));
  });
});
