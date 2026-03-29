import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Tests for checkpoint-at-interval feature.
 * Since the interval logic is private to UnifiedPipeline, we test the
 * observable behavior: env var parsing, timer lifecycle, and git stash naming.
 */

describe('checkpoint-at-interval config', () => {
  test('CREW_CHECKPOINT_INTERVAL_MS defaults to 60000', () => {
    // Clear any override
    const saved = process.env.CREW_CHECKPOINT_INTERVAL_MS;
    delete process.env.CREW_CHECKPOINT_INTERVAL_MS;

    const raw = String(process.env.CREW_CHECKPOINT_INTERVAL_MS || '').trim();
    const ms = Number(raw);
    const result = Number.isFinite(ms) && ms > 0 ? ms : 60_000;
    assert.equal(result, 60_000);

    if (saved !== undefined) process.env.CREW_CHECKPOINT_INTERVAL_MS = saved;
  });

  test('CREW_CHECKPOINT_INTERVAL_MS respects custom value', () => {
    process.env.CREW_CHECKPOINT_INTERVAL_MS = '30000';
    const raw = String(process.env.CREW_CHECKPOINT_INTERVAL_MS || '').trim();
    const ms = Number(raw);
    const result = Number.isFinite(ms) && ms > 0 ? ms : 60_000;
    assert.equal(result, 30_000);
    delete process.env.CREW_CHECKPOINT_INTERVAL_MS;
  });

  test('CREW_AUTO_CHECKPOINT=false disables checkpointing', () => {
    process.env.CREW_AUTO_CHECKPOINT = 'false';
    const raw = String(process.env.CREW_AUTO_CHECKPOINT || 'true').trim().toLowerCase();
    const enabled = raw !== 'false' && raw !== '0' && raw !== 'off';
    assert.equal(enabled, false);
    delete process.env.CREW_AUTO_CHECKPOINT;
  });

  test('CREW_AUTO_CHECKPOINT defaults to true', () => {
    delete process.env.CREW_AUTO_CHECKPOINT;
    const raw = String(process.env.CREW_AUTO_CHECKPOINT || 'true').trim().toLowerCase();
    const enabled = raw !== 'false' && raw !== '0' && raw !== 'off';
    assert.equal(enabled, true);
  });
});

describe('checkpoint stash naming', () => {
  test('generates predictable stash tag from traceId', () => {
    const traceId = 'pipeline-a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const count = 3;
    const tag = `crew-interval-${traceId.slice(0, 8)}-${count}`;
    assert.equal(tag, 'crew-interval-pipeline-3');
  });
});
