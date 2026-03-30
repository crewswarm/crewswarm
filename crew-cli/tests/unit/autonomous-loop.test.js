import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeAutonomous, formatAutonomousResult } from '../../src/worker/autonomous-loop.ts';

describe('autonomous-loop', () => {
  it('completes when LLM returns no tool calls', async () => {
    const llm = async () => ({ response: 'Done!', toolCalls: [] });
    const tool = async () => ({});
    const result = await executeAutonomous('test task', llm, tool, { tools: [], maxTurns: 5 });
    assert.equal(result.success, true);
    assert.equal(result.turns, 1);
    assert.equal(result.finalResponse, 'Done!');
  });

  it('completes when LLM returns COMPLETE status', async () => {
    const llm = async () => ({ response: 'All done', status: 'COMPLETE', toolCalls: [{ tool: 'x', params: {} }] });
    const tool = async () => ({});
    const result = await executeAutonomous('test', llm, tool, { tools: [] });
    assert.equal(result.success, true);
  });

  it('stops at maxTurns', async () => {
    let turn = 0;
    const llm = async () => ({ response: `turn-${++turn}`, toolCalls: [{ tool: 'noop', params: {} }] });
    const tool = async () => 'ok';
    const result = await executeAutonomous('test', llm, tool, { tools: [], maxTurns: 3, repeatThreshold: 100 });
    assert.equal(result.success, false);
    assert.equal(result.turns, 3);
    assert.ok(result.reason.includes('Maximum turns'));
  });

  it('formatAutonomousResult returns a string', () => {
    const result = { success: true, turns: 1, history: [], finalResponse: 'done' };
    const formatted = formatAutonomousResult(result);
    assert.equal(typeof formatted, 'string');
    assert.ok(formatted.includes('Autonomous Execution'));
  });
});
