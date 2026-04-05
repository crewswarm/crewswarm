import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// Dynamic import for ESM compatibility
let RunState;

describe('RunState', async () => {
  before(async () => {
    const mod = await import('../../src/engine/run-state.ts');
    RunState = mod.RunState;
  });

  describe('phase lifecycle', () => {
    it('starts in init phase', () => {
      const state = new RunState({ task: 'test task' });
      assert.equal(state.phase, 'init');
    });

    it('transitions through phases', () => {
      const state = new RunState({ task: 'test task' });
      state.enterPhase('planning');
      assert.equal(state.phase, 'planning');
      state.enterPhase('executing');
      assert.equal(state.phase, 'executing');
      state.enterPhase('complete');
      assert.equal(state.phase, 'complete');
    });

    it('records phase history in snapshot', () => {
      const state = new RunState({ task: 'test task' });
      state.enterPhase('planning');
      state.enterPhase('executing');
      state.enterPhase('complete');
      const snap = state.snapshot();
      assert.equal(snap.phases.length, 3);
      assert.equal(snap.phases[0].phase, 'planning');
      assert.equal(snap.phases[1].phase, 'executing');
      assert.equal(snap.phases[2].phase, 'complete');
    });
  });

  describe('failure memory', () => {
    it('records and deduplicates failures', () => {
      const state = new RunState({ task: 'test' });
      state.enterPhase('executing');
      state.recordFailure({ turn: 1, tool: 'write_file', params: { file_path: 'a.ts' }, error: 'ENOENT' });
      state.recordFailure({ turn: 2, tool: 'write_file', params: { file_path: 'a.ts' }, error: 'ENOENT' });
      assert.equal(state.failures.length, 1);
      assert.equal(state.failures[0].count, 2);
    });

    it('detects repeated failures', () => {
      const state = new RunState({ task: 'test' });
      state.recordFailure({ turn: 1, tool: 'shell', params: { command: 'npm test' }, error: 'exit 1' });
      state.recordFailure({ turn: 2, tool: 'shell', params: { command: 'npm test' }, error: 'exit 1' });
      const repeat = state.wouldRepeatFailure('shell', { command: 'npm test' });
      assert.ok(repeat);
      assert.equal(repeat.count, 2);
    });

    it('does not block first attempt', () => {
      const state = new RunState({ task: 'test' });
      state.recordFailure({ turn: 1, tool: 'shell', params: { command: 'npm test' }, error: 'exit 1' });
      const repeat = state.wouldRepeatFailure('shell', { command: 'npm test' });
      assert.equal(repeat, null); // only 1 failure, threshold is 2
    });

    it('classifies failure categories', () => {
      const state = new RunState({ task: 'test' });
      const f1 = state.recordFailure({ turn: 1, tool: 'read_file', params: {}, error: 'ENOENT: no such file' });
      assert.equal(f1.category, 'bad-file-selection');
      const f2 = state.recordFailure({ turn: 2, tool: 'shell', params: { command: 'x' }, error: 'SyntaxError: unexpected token' });
      assert.equal(f2.category, 'syntax-error');
    });

    it('builds failure avoidance context', () => {
      const state = new RunState({ task: 'test' });
      state.recordFailure({ turn: 1, tool: 'shell', params: { command: 'bad' }, error: 'fail' });
      state.recordFailure({ turn: 2, tool: 'shell', params: { command: 'bad' }, error: 'fail' });
      const ctx = state.buildFailureContext();
      assert.ok(ctx.includes('Known failures'));
      assert.ok(ctx.includes('shell'));
      assert.ok(ctx.includes('2x'));
    });

    it('returns empty string when no failures', () => {
      const state = new RunState({ task: 'test' });
      assert.equal(state.buildFailureContext(), '');
    });
  });

  describe('verification goals', () => {
    it('adds and tracks goals', () => {
      const state = new RunState({ task: 'test' });
      const goal = state.addVerificationGoal('tests pass');
      assert.equal(goal.status, 'pending');
      assert.equal(state.verificationGoals.length, 1);
    });

    it('proves goals', () => {
      const state = new RunState({ task: 'test' });
      const goal = state.addVerificationGoal('tests pass');
      state.proveGoal(goal.id, 'npm test');
      assert.equal(state.verificationGoals[0].status, 'proven');
    });

    it('tracks failed goals with attempt count', () => {
      const state = new RunState({ task: 'test' });
      const goal = state.addVerificationGoal('tests pass');
      state.failGoal(goal.id);
      state.failGoal(goal.id);
      assert.equal(state.verificationGoals[0].status, 'failed');
      assert.equal(state.verificationGoals[0].attempts, 2);
    });

    it('allGoalsProven returns true when all proven', () => {
      const state = new RunState({ task: 'test' });
      const g1 = state.addVerificationGoal('tests');
      const g2 = state.addVerificationGoal('lint');
      state.proveGoal(g1.id, 'test');
      state.proveGoal(g2.id, 'lint');
      assert.ok(state.allGoalsProven());
    });

    it('allGoalsProven returns false with pending goals', () => {
      const state = new RunState({ task: 'test' });
      state.addVerificationGoal('tests');
      state.addVerificationGoal('lint');
      assert.ok(!state.allGoalsProven());
    });

    it('nextUnprovenGoal returns first pending', () => {
      const state = new RunState({ task: 'test' });
      const g1 = state.addVerificationGoal('tests');
      state.addVerificationGoal('lint');
      state.proveGoal(g1.id, 'x');
      const next = state.nextUnprovenGoal();
      assert.ok(next);
      assert.equal(next.description, 'lint');
    });

    it('builds verification context', () => {
      const state = new RunState({ task: 'test' });
      const g = state.addVerificationGoal('tests pass');
      state.proveGoal(g.id, 'npm test');
      state.addVerificationGoal('lint clean');
      const ctx = state.buildVerificationContext();
      assert.ok(ctx.includes('[PROVEN]'));
      assert.ok(ctx.includes('[PENDING]'));
    });
  });

  describe('cost tracking', () => {
    it('accumulates cost by phase and model', () => {
      const state = new RunState({ task: 'test' });
      state.enterPhase('executing');
      state.recordCost({ usd: 0.01, model: 'grok-4', tool: 'shell', inputTokens: 100, outputTokens: 50 });
      state.recordCost({ usd: 0.02, model: 'grok-4', tool: 'write_file', inputTokens: 200, outputTokens: 100 });
      assert.equal(state.cost.totalUsd, 0.03);
      assert.equal(state.cost.byModel['grok-4'], 0.03);
      assert.equal(state.cost.byTool['shell'], 0.01);
      assert.equal(state.cost.inputTokens, 300);
    });

    it('checks budget', () => {
      const state = new RunState({ task: 'test' });
      state.recordCost({ usd: 0.5 });
      assert.ok(!state.isOverBudget(1.0));
      assert.ok(state.isOverBudget(0.5));
    });
  });

  describe('abort', () => {
    it('sets aborted state', () => {
      const state = new RunState({ task: 'test' });
      state.enterPhase('executing');
      state.abort('user cancelled');
      assert.ok(state.isAborted);
      assert.equal(state.phase, 'aborted');
    });
  });

  describe('snapshot', () => {
    it('captures complete state', () => {
      const state = new RunState({ task: 'build feature', sessionId: 's1', traceId: 't1' });
      state.enterPhase('executing');
      state.recordTurn();
      state.recordCost({ usd: 0.01 });
      state.recordFailure({ turn: 1, tool: 'shell', params: {}, error: 'fail' });
      state.addVerificationGoal('tests pass');
      state.enterPhase('complete');

      const snap = state.snapshot();
      assert.equal(snap.task, 'build feature');
      assert.equal(snap.sessionId, 's1');
      assert.equal(snap.traceId, 't1');
      assert.equal(snap.phase, 'complete');
      assert.equal(snap.turns, 1);
      assert.equal(snap.failures.length, 1);
      assert.equal(snap.verificationGoals.length, 1);
      assert.ok(snap.endedAt);
    });
  });
});
