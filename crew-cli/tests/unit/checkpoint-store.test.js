import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CheckpointStore } from '../../src/checkpoint/store.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('CheckpointStore', () => {
  it('should be constructable', () => {
    const store = new CheckpointStore('/tmp/test-cp');
    assert.ok(store);
  });

  it('load returns null for nonexistent run', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'cp-'));
    try {
      const store = new CheckpointStore(tmp);
      const result = await store.load('nonexistent');
      assert.equal(result, null);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('beginRun creates a run and load retrieves it', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'cp-'));
    try {
      const store = new CheckpointStore(tmp);
      const run = await store.beginRun({ runId: 'r1', mode: 'plan', task: 'test task' });
      assert.equal(run.runId, 'r1');
      assert.equal(run.status, 'running');
      assert.deepEqual(run.events, []);
      const loaded = await store.load('r1');
      assert.equal(loaded.runId, 'r1');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('completedPlanSteps extracts step IDs', () => {
    const run = {
      runId: 'r1', mode: 'plan', task: 't', createdAt: '', updatedAt: '', status: 'running',
      events: [
        { ts: '', type: 'plan.step.completed', data: { stepId: 1 } },
        { ts: '', type: 'plan.step.completed', data: { stepId: 3 } },
        { ts: '', type: 'other', data: {} }
      ]
    };
    const steps = CheckpointStore.completedPlanSteps(run);
    assert.deepEqual(steps, [1, 3]);
  });

  it('list returns empty for fresh store', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'cp-'));
    try {
      const store = new CheckpointStore(tmp);
      const runs = await store.list();
      assert.deepEqual(runs, []);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
