import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UnifiedPipeline } from '../../src/pipeline/unified.ts';
import { createAdHocWorkerTask } from '../../src/pipeline/task-envelope.ts';

test('buildWorkerExecutionResult escalates out-of-scope file writes', () => {
  const pipeline = new UnifiedPipeline();
  const task = createAdHocWorkerTask({
    id: 'unit-1',
    goal: 'Update src/auth/jwt.ts',
    maxFilesTouched: 1,
  });

  const result = pipeline.buildWorkerExecutionResult(
    task,
    { output: 'Done', validation: ['Confirmed update'] },
    {
      success: true,
      cost: 0.01,
      toolsUsed: ['write_file', 'run_shell_command'],
      history: [
        { tool: 'write_file', params: { file_path: 'src/other.ts' }, result: { output: 'wrote file' } },
        { tool: 'run_shell_command', params: { command: 'npm test -- jwt' }, result: { output: 'ok' } },
      ],
      stopReason: 'complete',
    }
  );

  assert.equal(result.escalationNeeded, true);
  assert.match(String(result.escalationReason), /outside allowed scope/);
});

test('buildWorkerExecutionResult escalates when file budget is exceeded', () => {
  const pipeline = new UnifiedPipeline();
  const task = {
    ...createAdHocWorkerTask({
      id: 'unit-2',
      goal: 'Update auth module files',
      maxFilesTouched: 1,
    }),
    allowedPaths: ['src/auth'],
  };

  const result = pipeline.buildWorkerExecutionResult(
    task,
    { output: 'Done', validation: ['Confirmed update'] },
    {
      success: true,
      cost: 0.02,
      toolsUsed: ['write_file'],
      history: [
        { tool: 'write_file', params: { file_path: 'src/auth/jwt.ts' }, result: { output: 'wrote file' } },
        { tool: 'write_file', params: { file_path: 'src/auth/session.ts' }, result: { output: 'wrote file' } },
        { tool: 'run_shell_command', params: { command: 'npm test -- auth' }, result: { output: 'ok' } },
      ],
      stopReason: 'complete',
    }
  );

  assert.equal(result.escalationNeeded, true);
  assert.match(String(result.escalationReason), /task budget/);
});
