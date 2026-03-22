import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UnifiedPipeline } from '../../src/pipeline/unified.ts';
import {
  createWorkerTaskEnvelope,
  createAdHocWorkerTask,
  validateWorkerTaskEnvelope,
} from '../../src/pipeline/task-envelope.ts';

// ─── Helper: create a pipeline instance to access private methods at runtime ───
function makePipeline() {
  return new UnifiedPipeline();
}

// ─── 1. normalizeDecision ─────────────────────────────────────────────────────

test('normalizeDecision: execute-direct maps correctly', () => {
  const p = makePipeline();
  assert.equal(p.normalizeDecision('execute-direct'), 'execute-direct');
});

test('normalizeDecision: direct-execute maps to execute-direct', () => {
  const p = makePipeline();
  assert.equal(p.normalizeDecision('direct-execute'), 'execute-direct');
});

test('normalizeDecision: simple maps to execute-direct', () => {
  const p = makePipeline();
  assert.equal(p.normalizeDecision('simple'), 'execute-direct');
});

test('normalizeDecision: direct-answer maps correctly', () => {
  const p = makePipeline();
  assert.equal(p.normalizeDecision('direct-answer'), 'direct-answer');
});

test('normalizeDecision: chat maps to direct-answer', () => {
  const p = makePipeline();
  assert.equal(p.normalizeDecision('chat'), 'direct-answer');
});

test('normalizeDecision: execute-parallel maps correctly', () => {
  const p = makePipeline();
  assert.equal(p.normalizeDecision('execute-parallel'), 'execute-parallel');
});

test('normalizeDecision: dispatch maps to execute-parallel', () => {
  const p = makePipeline();
  assert.equal(p.normalizeDecision('dispatch'), 'execute-parallel');
});

test('normalizeDecision: unknown value defaults to execute-parallel', () => {
  const p = makePipeline();
  assert.equal(p.normalizeDecision('gibberish'), 'execute-parallel');
  assert.equal(p.normalizeDecision(''), 'execute-parallel');
  assert.equal(p.normalizeDecision(null), 'execute-parallel');
  assert.equal(p.normalizeDecision(undefined), 'execute-parallel');
});

test('normalizeDecision: case insensitive', () => {
  const p = makePipeline();
  assert.equal(p.normalizeDecision('EXECUTE-DIRECT'), 'execute-direct');
  assert.equal(p.normalizeDecision('Direct-Answer'), 'direct-answer');
  assert.equal(p.normalizeDecision('SIMPLE'), 'execute-direct');
});

// ─── 2. collectVerificationSignals ────────────────────────────────────────────

test('collectVerificationSignals: shell command success → verificationPassed true', () => {
  const p = makePipeline();
  const task = createAdHocWorkerTask({ id: 'v1', goal: 'Update src/auth/jwt.ts with new token logic' });
  const history = [
    { tool: 'run_shell_command', params: { command: 'npm test' }, result: { output: 'all tests passed', exitCode: 0 } },
  ];
  const parsed = { output: 'Done', validation: [] };
  const result = p.collectVerificationSignals(history, parsed, task);
  assert.equal(result.verificationPassed, true);
  assert.equal(result.escalationNeeded, false);
});

test('collectVerificationSignals: shell command with error → verificationPassed false', () => {
  const p = makePipeline();
  const task = createAdHocWorkerTask({ id: 'v2', goal: 'Update src/auth/jwt.ts with new token logic' });
  const history = [
    { tool: 'run_shell_command', params: { command: 'npm test' }, error: 'Exit code 1' },
  ];
  const parsed = { output: 'Failed', validation: [] };
  const result = p.collectVerificationSignals(history, parsed, task);
  assert.equal(result.verificationPassed, false);
});

test('collectVerificationSignals: no shell commands → verificationPassed false with reason', () => {
  const p = makePipeline();
  const task = createAdHocWorkerTask({ id: 'v3', goal: 'Update src/auth/jwt.ts with new token logic' });
  const history = [
    { tool: 'read_file', params: { file_path: 'src/auth/jwt.ts' }, result: { output: 'contents' } },
    { tool: 'write_file', params: { file_path: 'src/auth/jwt.ts' }, result: { output: 'wrote file' } },
  ];
  const parsed = { output: 'Done', validation: [] };
  const result = p.collectVerificationSignals(history, parsed, task);
  assert.equal(result.verificationPassed, false);
  assert.equal(result.escalationNeeded, true);
  assert.equal(result.escalationReason, 'No shell verification command was executed');
});

test('collectVerificationSignals: prose keywords do NOT trigger verification', () => {
  const p = makePipeline();
  const task = createAdHocWorkerTask({ id: 'v4', goal: 'Update src/auth/jwt.ts with new token logic' });
  const history = [
    { tool: 'read_file', params: { file_path: 'src/auth/jwt.ts' }, result: { output: 'contents' } },
  ];
  // Output contains "verified" and "test passed" but no shell command ran
  const parsed = { output: 'I verified the changes. The test passed successfully.', validation: [] };
  const result = p.collectVerificationSignals(history, parsed, task);
  assert.equal(result.verificationPassed, false, 'Prose keywords should NOT trigger verification');
  assert.equal(result.escalationNeeded, true);
});

test('collectVerificationSignals: check_background_task counts as shell verification', () => {
  const p = makePipeline();
  const task = createAdHocWorkerTask({ id: 'v5', goal: 'Update src/auth/jwt.ts with new token logic' });
  const history = [
    { tool: 'check_background_task', params: { task_id: 'bg-1' }, result: { output: 'test suite passed' } },
  ];
  const parsed = { output: 'Done', validation: [] };
  const result = p.collectVerificationSignals(history, parsed, task);
  assert.equal(result.verificationPassed, true);
});

test('collectVerificationSignals: empty history → escalation needed', () => {
  const p = makePipeline();
  const task = createAdHocWorkerTask({ id: 'v6', goal: 'Update src/auth/jwt.ts with new token logic' });
  const result = p.collectVerificationSignals([], { output: 'Done', validation: [] }, task);
  assert.equal(result.verificationPassed, false);
  assert.equal(result.escalationNeeded, true);
});

// ─── 3. extractShellResults ───────────────────────────────────────────────────

test('extractShellResults: extracts command, exitCode, output from shell history', () => {
  const p = makePipeline();
  const history = [
    { tool: 'run_shell_command', params: { command: 'npm test' }, result: { output: 'ok', exitCode: 0 } },
    { tool: 'run_shell_command', params: { command: 'npm run lint' }, error: 'lint failed' },
  ];
  const results = p.extractShellResults(history);
  assert.equal(results.length, 2);
  assert.equal(results[0].command, 'npm test');
  assert.equal(results[0].exitCode, 0);
  assert.equal(results[0].output, 'ok');
  assert.equal(results[1].command, 'npm run lint');
  assert.equal(results[1].exitCode, 1);
});

test('extractShellResults: ignores non-shell tool calls', () => {
  const p = makePipeline();
  const history = [
    { tool: 'read_file', params: { file_path: 'foo.ts' }, result: { output: 'contents' } },
    { tool: 'write_file', params: { file_path: 'foo.ts' }, result: { output: 'wrote' } },
    { tool: 'grep_search', params: { query: 'hello' }, result: { output: 'match' } },
  ];
  const results = p.extractShellResults(history);
  assert.equal(results.length, 0);
});

test('extractShellResults: truncates output to 500 chars', () => {
  const p = makePipeline();
  const longOutput = 'x'.repeat(1000);
  const history = [
    { tool: 'run_shell_command', params: { command: 'cat bigfile' }, result: { output: longOutput } },
  ];
  const results = p.extractShellResults(history);
  assert.equal(results[0].output.length, 500);
});

test('extractShellResults: empty history → empty array', () => {
  const p = makePipeline();
  assert.deepEqual(p.extractShellResults([]), []);
  assert.deepEqual(p.extractShellResults(undefined), []);
});

test('extractShellResults: check_background_task uses task_id as command', () => {
  const p = makePipeline();
  const history = [
    { tool: 'check_background_task', params: { task_id: 'bg-123' }, result: { output: 'done' } },
  ];
  const results = p.extractShellResults(history);
  assert.equal(results[0].command, 'bg-123');
});

// ─── 4. buildStructuredEvidence ───────────────────────────────────────────────

test('buildStructuredEvidence: returns empty array for no execution results', () => {
  const p = makePipeline();
  assert.deepEqual(p.buildStructuredEvidence(undefined), []);
  assert.deepEqual(p.buildStructuredEvidence(null), []);
  assert.deepEqual(p.buildStructuredEvidence({ results: [] }), []);
});

test('buildStructuredEvidence: returns structured data from execution results', () => {
  const p = makePipeline();
  const executionResults = {
    results: [{
      workUnitId: 'u1',
      persona: 'executor-code',
      output: 'Updated jwt.ts',
      filesChanged: ['src/auth/jwt.ts'],
      shellResults: [{ command: 'npm test', exitCode: 0, output: 'ok' }],
      verificationPassed: true,
      verification: ['Command succeeded: npm test'],
      escalationNeeded: false,
      cost: 0.01,
    }]
  };
  const evidence = p.buildStructuredEvidence(executionResults);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].workUnitId, 'u1');
  assert.deepEqual(evidence[0].filesChanged, ['src/auth/jwt.ts']);
  assert.equal(evidence[0].verificationPassed, true);
  assert.equal(evidence[0].workerOutput, 'Updated jwt.ts');
  assert.equal(evidence[0].shellResults.length, 1);
});

test('buildStructuredEvidence: no verification → evidence shows reason', () => {
  const p = makePipeline();
  const executionResults = {
    results: [{
      workUnitId: 'u2',
      persona: 'executor-code',
      output: 'Done',
      filesChanged: [],
      shellResults: [],
      verificationPassed: false,
      verification: [],
      escalationNeeded: true,
      escalationReason: 'No shell verification command was executed',
      cost: 0.01,
    }]
  };
  const evidence = p.buildStructuredEvidence(executionResults);
  assert.equal(evidence[0].verificationEvidence, 'No shell verification command was executed');
  assert.equal(evidence[0].escalationNeeded, true);
});

// ─── 5. Task envelope optional fields ─────────────────────────────────────────

test('createWorkerTaskEnvelope: minimal unit without optional fields produces valid envelope', () => {
  const envelope = createWorkerTaskEnvelope({
    id: 'unit-min',
    description: 'Update src/auth/jwt.ts to add token refresh',
    requiredPersona: 'executor-code',
    dependencies: [],
    requiredCapabilities: ['code-generation'],
  });
  assert.equal(envelope.id, 'unit-min');
  assert.ok(envelope.goal.includes('jwt.ts'));
  assert.equal(envelope.persona, 'executor-code');
  assert.ok(Array.isArray(envelope.allowedPaths));
  assert.ok(Array.isArray(envelope.verification));
  // sourceRefs should be absent (not an empty array)
  assert.equal(envelope.sourceRefs, undefined);
});

test('createWorkerTaskEnvelope: populates optional fields when provided', () => {
  const envelope = createWorkerTaskEnvelope({
    id: 'unit-full',
    description: 'Update src/auth/jwt.ts to add token refresh',
    requiredPersona: 'executor-code',
    dependencies: [],
    requiredCapabilities: ['code-generation'],
    sourceRefs: ['ROADMAP.md#auth'],
    estimatedComplexity: 'high',
    escalationHints: ['Escalate if auth changes are unclear'],
    maxFilesTouched: 2,
  });
  assert.deepEqual(envelope.sourceRefs, ['ROADMAP.md#auth']);
  assert.equal(envelope.estimatedComplexity, 'high');
  assert.ok(envelope.escalationHints.includes('Escalate if auth changes are unclear'));
  assert.equal(envelope.maxFilesTouched, 2);
});

test('createWorkerTaskEnvelope: empty sourceRefs array → not set on envelope', () => {
  const envelope = createWorkerTaskEnvelope({
    id: 'unit-empty-refs',
    description: 'Update src/auth/jwt.ts to add token refresh',
    requiredPersona: 'executor-code',
    dependencies: [],
    requiredCapabilities: [],
    sourceRefs: [],
  });
  assert.equal(envelope.sourceRefs, undefined);
});

test('createWorkerTaskEnvelope: invalid estimatedComplexity → not set', () => {
  const envelope = createWorkerTaskEnvelope({
    id: 'unit-bad-complexity',
    description: 'Update src/auth/jwt.ts to add token refresh',
    requiredPersona: 'executor-code',
    dependencies: [],
    requiredCapabilities: [],
    estimatedComplexity: 'extreme',
  });
  assert.equal(envelope.estimatedComplexity, undefined);
});

test('createWorkerTaskEnvelope: maxFilesTouched 0 → not set', () => {
  const envelope = createWorkerTaskEnvelope({
    id: 'unit-zero-files',
    description: 'Update src/auth/jwt.ts to add token refresh',
    requiredPersona: 'executor-code',
    dependencies: [],
    requiredCapabilities: [],
    maxFilesTouched: 0,
  });
  // Should fall back to allowedPaths.length
  assert.ok(envelope.maxFilesTouched === undefined || envelope.maxFilesTouched >= 1);
});

test('validateWorkerTaskEnvelope: accepts envelope with missing optional fields', () => {
  const envelope = {
    id: 'valid-1',
    goal: 'Update src/auth/jwt.ts to add token refresh logic',
    persona: 'executor-code',
    dependencies: [],
    allowedPaths: ['src/auth/jwt.ts'],
    verification: ['Confirm changes exist'],
    requiredCapabilities: ['code-generation'],
    // No sourceRefs, no estimatedComplexity, no escalationHints, no maxFilesTouched
  };
  const result = validateWorkerTaskEnvelope(envelope);
  assert.equal(result.ok, true, `Errors: ${result.errors.join(', ')}`);
});

test('validateWorkerTaskEnvelope: validates optional fields when present', () => {
  const envelope = {
    id: 'valid-2',
    goal: 'Update src/auth/jwt.ts to add token refresh logic',
    persona: 'executor-code',
    dependencies: [],
    allowedPaths: ['src/auth/jwt.ts'],
    verification: ['Confirm changes exist'],
    requiredCapabilities: ['code-generation'],
    sourceRefs: 'not-an-array', // invalid
    maxFilesTouched: 0, // invalid
    estimatedComplexity: 'extreme', // invalid
  };
  const result = validateWorkerTaskEnvelope(envelope);
  assert.equal(result.ok, false);
  const merged = result.errors.join(' | ');
  assert.ok(merged.includes('sourceRefs'), 'Should flag invalid sourceRefs');
  assert.ok(merged.includes('maxFilesTouched'), 'Should flag invalid maxFilesTouched');
  assert.ok(merged.includes('estimatedComplexity'), 'Should flag invalid estimatedComplexity');
});

// ─── 6. Legacy file command detection ─────────────────────────────────────────

test('containsLegacyFileCommands: detects @@WRITE_FILE', () => {
  const p = makePipeline();
  assert.equal(p.containsLegacyFileCommands('@@WRITE_FILE src/foo.ts\ncontent'), true);
});

test('containsLegacyFileCommands: detects FILE: pattern', () => {
  const p = makePipeline();
  assert.equal(p.containsLegacyFileCommands('FILE: src/foo.ts\ncontent'), true);
});

test('containsLegacyFileCommands: detects @@MKDIR', () => {
  const p = makePipeline();
  assert.equal(p.containsLegacyFileCommands('@@MKDIR src/new-dir'), true);
});

test('containsLegacyFileCommands: detects write: pattern', () => {
  const p = makePipeline();
  assert.equal(p.containsLegacyFileCommands('write: src/foo.ts\ncontent'), true);
});

test('containsLegacyFileCommands: normal text returns false', () => {
  const p = makePipeline();
  assert.equal(p.containsLegacyFileCommands('Just a normal response about writing code'), false);
  assert.equal(p.containsLegacyFileCommands('Updated the file successfully'), false);
});

// ─── 7. buildWorkerExecutionResult with new verification ──────────────────────

test('buildWorkerExecutionResult: shell verification passes → no escalation', () => {
  const p = makePipeline();
  const task = createAdHocWorkerTask({ id: 'bw1', goal: 'Update src/auth/jwt.ts with new logic' });
  const result = p.buildWorkerExecutionResult(
    task,
    { output: 'Done', validation: ['Confirmed'] },
    {
      success: true,
      cost: 0.01,
      toolsUsed: ['write_file', 'run_shell_command'],
      history: [
        { tool: 'write_file', params: { file_path: 'src/auth/jwt.ts' }, result: { output: 'wrote' } },
        { tool: 'run_shell_command', params: { command: 'npm test' }, result: { output: 'ok', exitCode: 0 } },
      ],
      stopReason: 'complete',
    }
  );
  assert.equal(result.verificationPassed, true);
  assert.equal(result.escalationNeeded, false);
});

test('buildWorkerExecutionResult: no shell command → escalation with reason', () => {
  const p = makePipeline();
  const task = createAdHocWorkerTask({ id: 'bw2', goal: 'Update src/auth/jwt.ts with new logic' });
  const result = p.buildWorkerExecutionResult(
    task,
    { output: 'I verified everything works. The test passed.', validation: [] },
    {
      success: true,
      cost: 0.01,
      toolsUsed: ['write_file'],
      history: [
        { tool: 'write_file', params: { file_path: 'src/auth/jwt.ts' }, result: { output: 'wrote' } },
      ],
      stopReason: 'complete',
    }
  );
  assert.equal(result.verificationPassed, false);
  assert.equal(result.escalationNeeded, true);
  assert.ok(String(result.escalationReason).includes('No shell verification'));
});

test('buildWorkerExecutionResult: includes shellResults in output', () => {
  const p = makePipeline();
  const task = createAdHocWorkerTask({ id: 'bw3', goal: 'Update src/auth/jwt.ts with new logic' });
  const result = p.buildWorkerExecutionResult(
    task,
    { output: 'Done', validation: [] },
    {
      success: true,
      cost: 0.01,
      toolsUsed: ['run_shell_command'],
      history: [
        { tool: 'write_file', params: { file_path: 'src/auth/jwt.ts' }, result: { output: 'wrote' } },
        { tool: 'run_shell_command', params: { command: 'npm test' }, result: { output: 'passed', exitCode: 0 } },
      ],
      stopReason: 'complete',
    }
  );
  assert.ok(Array.isArray(result.shellResults), 'shellResults should be an array');
  assert.equal(result.shellResults.length, 1);
  assert.equal(result.shellResults[0].command, 'npm test');
});

// ─── 8. buildExecutionAuditContext includes structured data ───────────────────

test('buildExecutionAuditContext: includes JSON evidence fields', () => {
  const p = makePipeline();
  const executionResults = {
    results: [{
      workUnitId: 'audit-1',
      persona: 'executor-code',
      output: 'Updated jwt.ts',
      filesChanged: ['src/auth/jwt.ts'],
      shellResults: [{ command: 'npm test', exitCode: 0, output: 'ok' }],
      verificationPassed: true,
      verification: ['Command succeeded: npm test'],
      escalationNeeded: false,
      cost: 0.01,
    }]
  };
  const context = p.buildExecutionAuditContext(executionResults);
  // Should contain JSON-formatted data, not just prose
  assert.ok(context.includes('Shell results:'), 'Should include shell results');
  assert.ok(context.includes('npm test'), 'Should include command name');
  assert.ok(context.includes('Verification passed: true'), 'Should include verification status');
});

test('buildExecutionAuditContext: no results → fallback message', () => {
  const p = makePipeline();
  const context = p.buildExecutionAuditContext(undefined);
  assert.equal(context, 'No execution metadata available.');
});
