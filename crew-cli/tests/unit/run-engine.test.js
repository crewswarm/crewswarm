import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let RunEngine;

describe('RunEngine', async () => {
  before(async () => {
    const mod = await import('../../src/engine/run-engine.ts');
    RunEngine = mod.RunEngine;
  });

  it('completes a simple task with no tool calls', async () => {
    const engine = new RunEngine({ task: 'say hello' });
    const mockLLM = async () => ({ response: 'Hello!', status: 'COMPLETE' });
    const mockTool = async () => 'ok';

    const result = await engine.execute(mockLLM, mockTool);
    assert.ok(result.success);
    assert.equal(result.output, 'Hello!');
    assert.equal(result.runState.phase, 'complete');
  });

  it('executes tool calls and records history', async () => {
    let turnCount = 0;
    const engine = new RunEngine({ task: 'create file', maxTurns: 5 });

    const mockLLM = async () => {
      turnCount++;
      if (turnCount === 1) {
        return {
          response: 'Creating file...',
          toolCalls: [{ tool: 'write_file', params: { file_path: 'hello.ts', content: 'hi' } }]
        };
      }
      return { response: 'Done!', status: 'COMPLETE' };
    };

    const mockTool = async (tool, params) => {
      return { success: true, message: `wrote ${params.file_path}` };
    };

    const result = await engine.execute(mockLLM, mockTool);
    assert.ok(result.success);
    assert.equal(result.history.length, 1);
    assert.equal(result.history[0].tool, 'write_file');
  });

  it('records failures and prevents repeats', async () => {
    let turnCount = 0;
    const engine = new RunEngine({ task: 'fix bug', maxTurns: 10 });

    const mockLLM = async () => {
      turnCount++;
      if (turnCount <= 4) {
        return {
          response: 'Trying...',
          toolCalls: [{ tool: 'shell', params: { command: 'npm test' } }]
        };
      }
      return { response: 'Giving up', status: 'COMPLETE' };
    };

    const mockTool = async () => {
      throw new Error('tests failed');
    };

    const result = await engine.execute(mockLLM, mockTool);
    // First 2 attempts run, then get blocked as repeated failures
    assert.ok(result.failureCount >= 1);
    assert.ok(result.runState.failures.some(f => f.tool === 'shell'));
  });

  it('tracks cost across turns', async () => {
    let turnCount = 0;
    const engine = new RunEngine({ task: 'work', maxTurns: 3, model: 'grok-4' });

    const mockLLM = async () => {
      turnCount++;
      if (turnCount <= 2) {
        return { response: 'working...', costUsd: 0.01, toolCalls: [{ tool: 'read_file', params: { file_path: 'x' } }] };
      }
      return { response: 'done', status: 'COMPLETE', costUsd: 0.005 };
    };

    const mockTool = async () => 'file contents';

    const result = await engine.execute(mockLLM, mockTool);
    assert.ok(result.costUsd >= 0.02);
    assert.ok(result.runState.cost.totalUsd >= 0.02);
  });

  it('respects budget limits', async () => {
    const engine = new RunEngine({ task: 'expensive', maxTurns: 100, maxBudgetUsd: 0.02 });

    const mockLLM = async () => ({
      response: 'working...',
      costUsd: 0.01,
      toolCalls: [{ tool: 'shell', params: { command: 'echo hi' } }]
    });

    const mockTool = async () => 'ok';

    const result = await engine.execute(mockLLM, mockTool);
    // Should stop after ~2 turns due to budget
    assert.ok(result.turns <= 4);
  });

  it('respects abort signal', async () => {
    const controller = new AbortController();
    const engine = new RunEngine({ task: 'long task', maxTurns: 100, abortSignal: controller.signal });

    let turnCount = 0;
    const mockLLM = async () => {
      turnCount++;
      if (turnCount >= 2) controller.abort();
      return { response: 'working...', toolCalls: [{ tool: 'read_file', params: { file_path: 'x' } }] };
    };

    const mockTool = async () => 'ok';

    const result = await engine.execute(mockLLM, mockTool);
    assert.ok(!result.success);
    assert.ok(result.runState.isAborted);
  });

  it('extracts verification goals from task text and commands', () => {
    const engine = new RunEngine({
      task: 'add feature and make sure tests pass',
      verificationCommands: ['npm test', 'npm run lint']
    });
    const goals = engine.state.verificationGoals;
    assert.ok(goals.length >= 2);
    assert.ok(goals.some(g => g.description.includes('npm test')));
    assert.ok(goals.some(g => g.description.includes('npm run lint')));
  });

  it('runs verification commands', async () => {
    let turnCount = 0;
    const engine = new RunEngine({
      task: 'fix code',
      maxTurns: 3,
      verificationCommands: ['npm test']
    });

    const mockLLM = async () => {
      turnCount++;
      if (turnCount === 1) {
        return { response: 'fixing...', toolCalls: [{ tool: 'edit_file', params: { file_path: 'x' } }] };
      }
      return { response: 'done', status: 'COMPLETE' };
    };

    const toolResults = new Map([
      ['edit_file', 'edited'],
      ['run_shell_command', 'all tests passed']
    ]);

    const mockTool = async (tool) => toolResults.get(tool) || 'ok';

    const result = await engine.execute(mockLLM, mockTool);
    assert.ok(result.verificationPassed);
  });

  it('provides complete snapshot for auditing', async () => {
    const engine = new RunEngine({ task: 'audit me', sessionId: 'ses-1', traceId: 'trace-1' });
    const mockLLM = async () => ({ response: 'done', status: 'COMPLETE' });
    const mockTool = async () => 'ok';

    await engine.execute(mockLLM, mockTool);
    const snap = engine.state.snapshot();

    assert.equal(snap.sessionId, 'ses-1');
    assert.equal(snap.traceId, 'trace-1');
    assert.equal(snap.task, 'audit me');
    assert.ok(snap.startedAt);
    assert.ok(snap.endedAt);
    assert.ok(Array.isArray(snap.phases));
    assert.ok(Array.isArray(snap.failures));
    assert.ok(Array.isArray(snap.verificationGoals));
  });
});
