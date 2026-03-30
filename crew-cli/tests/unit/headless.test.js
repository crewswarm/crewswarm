import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getHeadlessState, setHeadlessPaused } from '../../src/headless/index.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('headless', () => {
  it('getHeadlessState returns paused boolean', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'hl-'));
    try {
      const state = await getHeadlessState(tmp);
      assert.equal(typeof state.paused, 'boolean');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('default state is not paused', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'hl-'));
    try {
      const state = await getHeadlessState(tmp);
      assert.equal(state.paused, false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('setHeadlessPaused changes state', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'hl-'));
    try {
      await setHeadlessPaused(true, tmp);
      const state = await getHeadlessState(tmp);
      assert.equal(state.paused, true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
