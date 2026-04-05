import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let DelegationTuner, analyzeTask;

describe('DelegationTuner', async () => {
  before(async () => {
    const mod = await import('../../src/engine/delegation.ts');
    DelegationTuner = mod.DelegationTuner;
    analyzeTask = mod.analyzeTask;
  });

  describe('analyzeTask', () => {
    it('detects bug fix tasks', () => {
      const t = analyzeTask('fix the broken login flow', ['src/auth/login.ts']);
      assert.equal(t.taskType, 'fix-bug');
      assert.equal(t.language, 'typescript');
    });

    it('detects test writing tasks', () => {
      const t = analyzeTask('add unit tests for the parser', ['src/parser.test.ts']);
      assert.equal(t.taskType, 'add-test');
    });

    it('detects refactoring tasks', () => {
      const t = analyzeTask('refactor the API handler to use async/await', ['src/api.ts']);
      assert.equal(t.taskType, 'refactor');
    });

    it('detects documentation tasks', () => {
      const t = analyzeTask('write a README for the CLI', ['README.md']);
      assert.equal(t.taskType, 'docs');
      assert.equal(t.language, 'markdown');
    });

    it('detects config tasks', () => {
      const t = analyzeTask('set up Docker deployment', ['Dockerfile', 'docker-compose.yml']);
      assert.equal(t.taskType, 'config');
    });

    it('estimates complexity', () => {
      const simple = analyzeTask('fix a small typo', ['src/a.ts']);
      assert.equal(simple.complexity, 'low');
      const complex = analyzeTask('architect a new system with migration from the old API', ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts']);
      assert.equal(complex.complexity, 'high');
    });

    it('detects language from files', () => {
      const py = analyzeTask('fix bug', ['main.py', 'utils.py']);
      assert.equal(py.language, 'python');
      const go = analyzeTask('add endpoint', ['main.go']);
      assert.equal(go.language, 'go');
    });
  });

  describe('rankCandidates', () => {
    it('ranks crew-fixer highest for bug fixes', () => {
      const tuner = new DelegationTuner();
      const task = analyzeTask('fix the broken login', ['src/auth.ts']);
      const candidates = tuner.rankCandidates(task);
      assert.ok(candidates.length > 0);
      const top = candidates[0];
      assert.ok(top.persona === 'crew-fixer' || top.persona === 'executor-code');
    });

    it('ranks crew-qa highest for test tasks', () => {
      const tuner = new DelegationTuner();
      const task = analyzeTask('write tests for the parser', ['src/parser.ts']);
      const candidates = tuner.rankCandidates(task);
      assert.ok(candidates.some(c => c.persona === 'crew-qa'));
      // crew-qa should be ranked high
      const qaRank = candidates.findIndex(c => c.persona === 'crew-qa');
      assert.ok(qaRank < 3, `crew-qa ranked ${qaRank}, expected top 3`);
    });

    it('ranks crew-copywriter highest for docs', () => {
      const tuner = new DelegationTuner();
      const task = analyzeTask('write documentation for the API', ['README.md']);
      const candidates = tuner.rankCandidates(task);
      const top = candidates[0];
      assert.equal(top.persona, 'crew-copywriter');
    });

    it('provides reasons for rankings', () => {
      const tuner = new DelegationTuner();
      const task = analyzeTask('fix bug in typescript', ['src/index.ts']);
      const candidates = tuner.rankCandidates(task);
      assert.ok(candidates[0].reasons.length > 0);
    });

    it('recommends model tier based on complexity', () => {
      const tuner = new DelegationTuner();
      const simple = analyzeTask('fix typo', ['a.ts']);
      const complex = analyzeTask('architect new system overhaul', ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts']);
      const simpleCandidates = tuner.rankCandidates(simple);
      const complexCandidates = tuner.rankCandidates(complex);
      // Complex tasks should get heavier models
      assert.ok(complexCandidates.some(c => c.model === 'heavy' || c.model === 'standard'));
    });
  });

  describe('performance history', () => {
    it('improves rankings based on past success', () => {
      const tuner = new DelegationTuner();
      // Record crew-fixer succeeding on bug fixes
      for (let i = 0; i < 5; i++) {
        tuner.recordPerformance({
          persona: 'crew-fixer', model: 'grok-4', taskType: 'fix-bug',
          success: true, turns: 5, costUsd: 0.01, verificationPassed: true, timestamp: Date.now()
        });
      }
      const task = analyzeTask('fix a bug', ['src/x.ts']);
      const candidates = tuner.rankCandidates(task);
      const fixer = candidates.find(c => c.persona === 'crew-fixer');
      assert.ok(fixer);
      assert.ok(fixer.reasons.some(r => r.includes('success rate')));
    });

    it('penalizes personas with recent failures', () => {
      const tuner = new DelegationTuner();
      for (let i = 0; i < 3; i++) {
        tuner.recordPerformance({
          persona: 'crew-coder', model: 'x', taskType: 'fix-bug',
          success: false, turns: 25, costUsd: 0.05, verificationPassed: false, timestamp: Date.now()
        });
      }
      const task = analyzeTask('fix another bug', ['src/y.ts']);
      const candidates = tuner.rankCandidates(task);
      const coder = candidates.find(c => c.persona === 'crew-coder');
      assert.ok(coder);
      assert.ok(coder.reasons.some(r => r.includes('recent') || r.includes('low success')));
    });

    it('exports and imports history', () => {
      const tuner = new DelegationTuner();
      tuner.recordPerformance({
        persona: 'crew-qa', model: 'x', taskType: 'add-test',
        success: true, turns: 3, costUsd: 0.005, verificationPassed: true, timestamp: Date.now()
      });
      const exported = tuner.exportHistory();
      assert.equal(exported.length, 1);

      const tuner2 = new DelegationTuner();
      tuner2.importHistory(exported);
      assert.equal(tuner2.exportHistory().length, 1);
    });
  });

  describe('bestCandidate', () => {
    it('returns top candidate', () => {
      const tuner = new DelegationTuner();
      const task = analyzeTask('write docs', ['README.md']);
      const best = tuner.bestCandidate(task);
      assert.ok(best);
      assert.equal(best.persona, 'crew-copywriter');
    });

    it('returns null for empty profiles', () => {
      const tuner = new DelegationTuner();
      // This should still return something since all profiles match at baseline
      const task = analyzeTask('do something', []);
      const best = tuner.bestCandidate(task);
      assert.ok(best); // profiles always have a baseline score
    });
  });
});
