import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectHighSeverityFindings } from '../../src/review/index.ts';

describe('review', () => {
  it('detects critical keyword', () => {
    const result = detectHighSeverityFindings('This is a critical issue');
    assert.equal(result.hasHighSeverity, true);
    assert.ok(result.matches.length > 0);
  });

  it('detects "do not merge"', () => {
    const result = detectHighSeverityFindings('do not merge this PR');
    assert.equal(result.hasHighSeverity, true);
  });

  it('no findings for clean text', () => {
    const result = detectHighSeverityFindings('looks good to me');
    assert.equal(result.hasHighSeverity, false);
    assert.deepEqual(result.matches, []);
  });

  it('handles empty string', () => {
    const result = detectHighSeverityFindings('');
    assert.equal(result.hasHighSeverity, false);
  });
});
