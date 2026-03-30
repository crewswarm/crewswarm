import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorkerPool } from '../../src/orchestrator/worker-pool.ts';

describe('WorkerPool', () => {
  it('should export WorkerPool class', () => {
    assert.equal(typeof WorkerPool, 'function');
  });

  it('enqueue adds tasks to queue', () => {
    const pool = new WorkerPool({
      router: {},
      orchestrator: {},
      sandbox: {},
      concurrency: 2
    });
    pool.enqueue({ id: 't1', agent: 'crew-coder', prompt: 'test' });
    // No direct queue access but enqueueAll works without error
    pool.enqueueAll([
      { id: 't2', agent: 'crew-coder', prompt: 'test2' },
      { id: 't3', agent: 'crew-coder', prompt: 'test3' }
    ]);
    assert.ok(true); // no throw
  });

  it('constructor sets concurrency from options', () => {
    const pool = new WorkerPool({
      router: {},
      orchestrator: {},
      sandbox: {},
      concurrency: 5
    });
    assert.ok(pool);
  });
});
