import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorkerTaskEnvelope,
  createAdHocWorkerTask,
  validateWorkerTaskEnvelope,
} from '../../src/pipeline/task-envelope.ts';

test('createWorkerTaskEnvelope prefers explicit planner scope fields', () => {
  const task = createWorkerTaskEnvelope({
    id: 'unit-1',
    description: 'Update src/auth/jwt.ts to issue access tokens',
    requiredPersona: 'executor-code',
    dependencies: [],
    estimatedComplexity: 'medium',
    requiredCapabilities: ['code-generation', 'file-write'],
    sourceRefs: ['ROADMAP.md#auth'],
    allowedPaths: ['src/auth/jwt.ts'],
    verification: ['Run npm test -- jwt', 'Confirm src/auth/jwt.ts changed'],
    escalationHints: ['Escalate if auth changes spill into middleware'],
    maxFilesTouched: 1,
  });

  assert.deepEqual(task.allowedPaths, ['src/auth/jwt.ts']);
  assert.deepEqual(task.verification, ['Run npm test -- jwt', 'Confirm src/auth/jwt.ts changed']);
  assert.deepEqual(task.escalationHints, ['Escalate if auth changes spill into middleware']);
  assert.equal(task.maxFilesTouched, 1);
});

test('validateWorkerTaskEnvelope rejects broad tasks and invalid file budgets', () => {
  const task = {
    id: 'unit-2',
    goal: 'Update the entire project and refactor everything',
    persona: 'executor-code',
    dependencies: [],
    allowedPaths: [],
    verification: ['Confirm the requested changes exist.'],
    requiredCapabilities: ['code-generation'],
    sourceRefs: ['ROADMAP.md#broad-task'],
    estimatedComplexity: 'medium',
    escalationHints: ['Escalate if scope is unclear.'],
    maxFilesTouched: 0,
  };

  const result = validateWorkerTaskEnvelope(task);
  assert.equal(result.ok, false);
  const merged = result.errors.join(' | ');
  assert.match(merged, /task\.goal too broad/);
  assert.match(merged, /task\.maxFilesTouched invalid/);
});
