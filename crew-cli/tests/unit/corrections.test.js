import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CorrectionStore } from '../../src/learning/corrections.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('CorrectionStore', () => {
  it('should be constructable', () => {
    const store = new CorrectionStore('/tmp/test-corr');
    assert.ok(store);
    assert.equal(typeof store.baseDir, 'string');
  });

  it('record and loadAll round-trip', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'corr-'));
    try {
      const store = new CorrectionStore(tmp);
      await store.record({ prompt: 'p1', original: 'o1', corrected: 'c1' });
      const all = await store.loadAll();
      assert.equal(all.length, 1);
      assert.equal(all[0].prompt, 'p1');
      assert.ok(all[0].timestamp);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('summary returns count', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'corr-'));
    try {
      const store = new CorrectionStore(tmp);
      const s = await store.summary();
      assert.equal(s.count, 0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('loadAll returns empty for fresh store', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'corr-'));
    try {
      const store = new CorrectionStore(tmp);
      const all = await store.loadAll();
      assert.deepEqual(all, []);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
