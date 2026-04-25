import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rankActions, buildActionRankingPrompt } from '../../src/execution/action-ranking.ts';

// Helper: build a TurnResult
function tr(turn, tool, params = {}, result = 'ok', error) {
  return { turn, tool, params, result, error };
}

describe('action-ranking', () => {
  describe('rankActions', () => {
    it('returns all 7 action types sorted by score', () => {
      const ranked = rankActions([], 'bugfix');
      assert.equal(ranked.length, 7);
      // Scores descending
      for (let i = 1; i < ranked.length; i++) {
        assert.ok(ranked[i - 1].score >= ranked[i].score,
          `${ranked[i - 1].action}(${ranked[i - 1].score}) >= ${ranked[i].action}(${ranked[i].score})`);
      }
    });

    it('boosts read when nothing has been read yet', () => {
      const ranked = rankActions([], 'feature');
      const readAction = ranked.find(r => r.action === 'read');
      assert.ok(readAction.score >= 0.5, `read score ${readAction.score} should be >= 0.5`);
    });

    it('boosts test/verify when there are unverified edits', () => {
      const history = [
        tr(1, 'read_file', { file_path: 'src/foo.ts' }),
        tr(2, 'replace', { file_path: 'src/foo.ts' }),
      ];
      const ranked = rankActions(history, 'bugfix');
      const testAction = ranked.find(r => r.action === 'test');
      const verifyAction = ranked.find(r => r.action === 'verify');
      // Both should be boosted
      assert.ok(testAction.score >= 0.8, `test score ${testAction.score} should be >= 0.8 with unverified edits`);
      assert.ok(verifyAction.score >= 0.7, `verify score ${verifyAction.score} should be >= 0.7 with unverified edits`);
    });

    it('penalizes edit when nothing has been read', () => {
      const ranked = rankActions([], 'feature');
      const editAction = ranked.find(r => r.action === 'edit');
      assert.ok(editAction.score <= 0.2, `edit score ${editAction.score} should be <= 0.2 with no reads`);
    });

    it('penalizes edit when many unverified edits exist', () => {
      const history = [
        tr(1, 'read_file', { file_path: 'a.ts' }),
        tr(2, 'replace', { file_path: 'a.ts' }),
        tr(3, 'replace', { file_path: 'b.ts' }),
        tr(4, 'replace', { file_path: 'c.ts' }),
      ];
      const ranked = rankActions(history, 'feature');
      const editAction = ranked.find(r => r.action === 'edit');
      assert.ok(editAction.score < 0.4, `edit score ${editAction.score} should be < 0.4 with 3 unverified edits`);
    });

    it('boosts build for refactor mode with edits and no build', () => {
      const history = [
        tr(1, 'read_file', { file_path: 'src/foo.ts' }),
        tr(2, 'replace', { file_path: 'src/foo.ts' }),
      ];
      const ranked = rankActions(history, 'refactor');
      const buildAction = ranked.find(r => r.action === 'build');
      assert.ok(buildAction.score >= 0.7, `build score ${buildAction.score} should be >= 0.7 for refactor with unverified edits`);
    });

    it('reflects task mode differences', () => {
      const bugfixRanked = rankActions([], 'bugfix');
      const analysisRanked = rankActions([], 'analysis');
      const bugfixTest = bugfixRanked.find(r => r.action === 'test').score;
      const analysisTest = analysisRanked.find(r => r.action === 'test').score;
      assert.ok(bugfixTest > analysisTest,
        `bugfix test score (${bugfixTest}) > analysis test score (${analysisTest})`);
    });

    it('penalizes consecutive same action type', () => {
      const history = [
        tr(1, 'read_file', { file_path: 'a.ts' }),
        tr(2, 'read_file', { file_path: 'b.ts' }),
        tr(3, 'read_file', { file_path: 'c.ts' }),
      ];
      const ranked = rankActions(history, 'feature');
      const readAction = ranked.find(r => r.action === 'read');
      // Should still be reasonable but penalized
      const baselineRead = rankActions([], 'feature').find(r => r.action === 'read').score;
      assert.ok(readAction.score < baselineRead,
        `read after 3 consecutive reads (${readAction.score}) < baseline (${baselineRead})`);
    });

    it('penalizes action types with recent failures', () => {
      const history = [
        tr(1, 'read_file', { file_path: 'a.ts' }),
        tr(2, 'replace', { file_path: 'a.ts' }, null, 'syntax error in file'),
      ];
      const ranked = rankActions(history, 'feature');
      const editAction = ranked.find(r => r.action === 'edit');
      // edit should be penalized because replace (an edit tool) failed recently
      assert.ok(editAction.score <= 0.3, `edit score ${editAction.score} after recent edit failure`);
    });
  });

  describe('buildActionRankingPrompt', () => {
    it('returns empty string when no actions score above threshold', () => {
      const result = buildActionRankingPrompt([], 'analysis', 0.99);
      assert.equal(result, '');
    });

    it('returns formatted prompt with top actions', () => {
      const result = buildActionRankingPrompt([], 'bugfix');
      assert.ok(result.includes('Next action priority'));
      assert.ok(result.includes('RECOMMENDED'));
    });

    it('limits to 3 recommendations', () => {
      const result = buildActionRankingPrompt([], 'bugfix', 0);
      const lines = result.split('\n').filter(l => l.startsWith('- ['));
      assert.ok(lines.length <= 3, `should have at most 3 recommendations, got ${lines.length}`);
    });

    it('includes reasons when present', () => {
      const history = [
        tr(1, 'read_file', { file_path: 'a.ts' }),
        tr(2, 'replace', { file_path: 'a.ts' }),
      ];
      const result = buildActionRankingPrompt(history, 'bugfix');
      // Should mention unverified edits
      assert.ok(result.includes('unverified') || result.includes('verification'),
        `prompt should mention verification: ${result}`);
    });
  });
});
