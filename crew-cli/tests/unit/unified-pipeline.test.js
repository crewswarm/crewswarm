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

test('buildWorkerExecutionResult escalates file-write tasks with no file changes', () => {
  const pipeline = new UnifiedPipeline();
  const task = {
    ...createAdHocWorkerTask({
      id: 'unit-3',
      goal: 'Update src/auth/jwt.ts',
      maxFilesTouched: 1,
    }),
    requiredCapabilities: ['code-generation', 'file-write'],
  };

  const result = pipeline.buildWorkerExecutionResult(
    task,
    { output: 'Updated logic and verified it.', validation: ['Verified behavior'] },
    {
      success: true,
      cost: 0.01,
      toolsUsed: ['read_file', 'run_shell_command'],
      history: [
        { tool: 'read_file', params: { file_path: 'src/auth/jwt.ts' }, result: { output: 'contents' } },
        { tool: 'run_shell_command', params: { command: 'npm test -- auth' }, result: { output: 'ok' } },
      ],
      stopReason: 'complete',
      turns: 2,
    }
  );

  assert.equal(result.escalationNeeded, true);
  assert.match(String(result.escalationReason), /without producing any file changes/);
});

test('buildWorkerExecutionResult escalates repeated failed tool actions', () => {
  const pipeline = new UnifiedPipeline();
  const task = createAdHocWorkerTask({
    id: 'unit-4',
    goal: 'Update src/auth/jwt.ts',
    maxFilesTouched: 1,
  });

  const result = pipeline.buildWorkerExecutionResult(
    task,
    { output: 'Could not complete.', validation: [] },
    {
      success: false,
      cost: 0.01,
      toolsUsed: ['replace'],
      history: [
        { tool: 'replace', params: { file_path: 'src/auth/jwt.ts', old_string: 'a', new_string: 'b' }, error: 'String not found' },
        { tool: 'replace', params: { file_path: 'src/auth/jwt.ts', old_string: 'a', new_string: 'b' }, error: 'String not found' },
      ],
      stopReason: 'Detected repeated actions, stopping to prevent infinite loop',
      turns: 2,
    }
  );

  assert.equal(result.escalationNeeded, true);
  assert.match(String(result.escalationReason), /repeated the same failing tool action|Detected repeated actions/);
});
