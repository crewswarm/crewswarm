import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let StructuredHistory;

describe('StructuredHistory', async () => {
  before(async () => {
    const mod = await import('../../src/engine/structured-history.ts');
    StructuredHistory = mod.StructuredHistory;
  });

  it('records LLM turns', () => {
    const h = new StructuredHistory();
    h.recordLLMTurn({ turn: 1, model: 'grok-4', provider: 'xai', response: 'hello', toolCalls: [], costUsd: 0.01, inputTokens: 100, outputTokens: 50, cachedTokens: 0, wasRetry: false, hadThinking: false });
    assert.equal(h.llmTurns.length, 1);
    assert.equal(h.llmTurns[0].model, 'grok-4');
  });

  it('records tool executions and tracks file state', () => {
    const h = new StructuredHistory();
    h.recordToolExecution({ turn: 1, tool: 'read_file', params: { file_path: 'a.ts' }, result: 'contents', durationMs: 10, filesAffected: ['a.ts'], readOnly: true });
    h.recordToolExecution({ turn: 1, tool: 'edit_file', params: { file_path: 'a.ts' }, result: 'ok', durationMs: 20, filesAffected: ['a.ts'], readOnly: false });

    assert.equal(h.toolExecutions.length, 2);
    const state = h.getFileState('a.ts');
    assert.ok(state);
    assert.equal(state.readCount, 1);
    assert.equal(state.editCount, 1);
    assert.ok(state.readBeforeWrite);
  });

  it('detects unread writes', () => {
    const h = new StructuredHistory();
    h.recordToolExecution({ turn: 1, tool: 'write_file', params: { file_path: 'b.ts' }, result: 'ok', durationMs: 10, filesAffected: ['b.ts'], readOnly: false });
    assert.deepEqual(h.unreadWrites, ['b.ts']);
  });

  it('tracks goals', () => {
    const h = new StructuredHistory();
    h.addGoal('tests pass');
    h.addGoal('lint clean');
    assert.equal(h.activeGoals.length, 2);
    h.resolveGoal('tests pass');
    assert.equal(h.activeGoals.length, 1);
    assert.equal(h.resolvedGoals.length, 1);
  });

  it('records compactions', () => {
    const h = new StructuredHistory();
    h.recordCompaction({ reason: 'reactive', turnsBefore: 20, turnsAfter: 8, tokensBefore: 50000, tokensAfter: 20000, preservedTurns: [1, 18, 19, 20], droppedTurns: [2, 3, 4, 5] });
    assert.equal(h.compactions.length, 1);
    assert.equal(h.compactions[0].reason, 'reactive');
  });

  it('computes total cost and tokens', () => {
    const h = new StructuredHistory();
    h.recordLLMTurn({ turn: 1, model: 'x', provider: 'y', response: '', toolCalls: [], costUsd: 0.01, inputTokens: 100, outputTokens: 50, cachedTokens: 20, wasRetry: false, hadThinking: false });
    h.recordLLMTurn({ turn: 2, model: 'x', provider: 'y', response: '', toolCalls: [], costUsd: 0.02, inputTokens: 200, outputTokens: 100, cachedTokens: 0, wasRetry: false, hadThinking: false });
    assert.equal(h.totalCostUsd, 0.03);
    assert.deepEqual(h.totalTokens, { input: 300, output: 150, cached: 20 });
  });

  it('builds execution summary', () => {
    const h = new StructuredHistory();
    h.addGoal('tests pass');
    h.recordToolExecution({ turn: 1, tool: 'write_file', params: { file_path: 'x.ts' }, result: 'ok', durationMs: 10, filesAffected: ['x.ts'], readOnly: false });
    const summary = h.buildExecutionSummary();
    assert.ok(summary.includes('Active goals'));
    assert.ok(summary.includes('x.ts'));
    assert.ok(summary.includes('WARNING'));
  });

  it('serializes to JSON', () => {
    const h = new StructuredHistory();
    h.recordLLMTurn({ turn: 1, model: 'x', provider: 'y', response: 'hi', toolCalls: [], costUsd: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, wasRetry: false, hadThinking: false });
    h.addGoal('test');
    const json = h.toJSON();
    assert.equal(json.records.length, 1);
    assert.equal(json.activeGoals.length, 1);
  });
});
