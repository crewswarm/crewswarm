/**
 * Unit tests for crew-cli src/executor/post-sampling-hooks.ts
 *
 * Covers:
 *  - runPostSamplingHooks: action aggregation (continue/stop/retry)
 *  - lintCheckHook: skips when no file-write tools ran
 *  - autoCommitHook: skips when no successful results
 *  - fileSizeGuardHook: warns for large files, passes for small ones
 *  - Hook errors are isolated (don't crash the loop)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  runPostSamplingHooks,
  lintCheckHook,
  autoCommitHook,
  fileSizeGuardHook
} from '../../src/executor/post-sampling-hooks.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCtx(overrides = {}) {
  return {
    turn: 1,
    response: 'Test response',
    toolCalls: [],
    toolResults: [],
    history: [],
    projectDir: '/tmp',
    ...overrides
  };
}

// ─── runPostSamplingHooks ────────────────────────────────────────────────────

describe('runPostSamplingHooks', () => {
  it('returns continue when hook list is empty', async () => {
    const result = await runPostSamplingHooks([], makeCtx());
    assert.equal(result.action, 'continue');
    assert.equal(result.message, undefined);
  });

  it('returns continue when all hooks return void', async () => {
    const hooks = [async () => undefined, async () => undefined];
    const result = await runPostSamplingHooks(hooks, makeCtx());
    assert.equal(result.action, 'continue');
  });

  it('returns stop immediately when a hook returns stop', async () => {
    const stopHook = async () => ({ action: 'stop', message: 'Halting execution' });
    const neverHook = async () => { throw new Error('should not be called'); };
    const result = await runPostSamplingHooks([stopHook, neverHook], makeCtx());
    assert.equal(result.action, 'stop');
    assert.equal(result.message, 'Halting execution');
  });

  it('returns retry when a hook returns retry', async () => {
    const retryHook = async () => ({ action: 'retry', message: 'Retry this turn' });
    const result = await runPostSamplingHooks([retryHook], makeCtx());
    assert.equal(result.action, 'retry');
    assert.equal(result.message, 'Retry this turn');
  });

  it('collects messages from multiple continue hooks', async () => {
    const hookA = async () => ({ action: 'continue', message: 'Message A' });
    const hookB = async () => ({ action: 'continue', message: 'Message B' });
    const result = await runPostSamplingHooks([hookA, hookB], makeCtx());
    assert.equal(result.action, 'continue');
    assert.ok(result.message.includes('Message A'));
    assert.ok(result.message.includes('Message B'));
  });

  it('isolates hook errors — other hooks still run', async () => {
    const badHook = async () => { throw new Error('boom'); };
    const goodHook = async () => ({ action: 'continue', message: 'good output' });
    const result = await runPostSamplingHooks([badHook, goodHook], makeCtx());
    assert.equal(result.action, 'continue');
    assert.ok(result.message.includes('good output'));
  });
});

// ─── lintCheckHook ──────────────────────────────────────────────────────────

describe('lintCheckHook', () => {
  it('returns void when no file-write tool results exist', async () => {
    const ctx = makeCtx({
      toolResults: [{ turn: 1, tool: 'read_file', params: { path: '/tmp/x' }, result: 'data' }]
    });
    const result = await lintCheckHook(ctx);
    assert.equal(result, undefined);
  });

  it('returns void when file-write results are from a different turn', async () => {
    const ctx = makeCtx({
      turn: 2,
      toolResults: [{ turn: 1, tool: 'write_file', params: { path: '/tmp/x.js' }, result: 'ok' }]
    });
    const result = await lintCheckHook(ctx);
    assert.equal(result, undefined);
  });
});

// ─── autoCommitHook ─────────────────────────────────────────────────────────

describe('autoCommitHook', () => {
  it('returns void when there are no successful tool results this turn', async () => {
    const ctx = makeCtx({
      toolResults: [{ turn: 1, tool: 'write_file', params: {}, result: null, error: 'write failed' }]
    });
    const result = await autoCommitHook(ctx);
    assert.equal(result, undefined);
  });

  it('returns void when not inside a git repository', async () => {
    // Use /tmp which is unlikely to be a git repo root
    const ctx = makeCtx({
      projectDir: '/tmp',
      toolResults: [{ turn: 1, tool: 'write_file', params: { path: '/tmp/foo.js' }, result: 'ok' }]
    });
    // Should not throw; result may be void
    const result = await autoCommitHook(ctx);
    assert.equal(result, undefined);
  });
});

// ─── fileSizeGuardHook ───────────────────────────────────────────────────────

describe('fileSizeGuardHook', () => {
  const TEST_DIR = join('/tmp', `crew-fsg-test-${Date.now()}`);

  it('returns void when no write_file tool results exist', async () => {
    const ctx = makeCtx({
      toolResults: [{ turn: 1, tool: 'shell', params: {}, result: 'done' }]
    });
    const result = await fileSizeGuardHook(ctx);
    assert.equal(result, undefined);
  });

  it('returns void when written file is small', async () => {
    await mkdir(TEST_DIR, { recursive: true });
    const smallFile = join(TEST_DIR, 'small.js');
    await writeFile(smallFile, 'const x = 1;\n');
    const ctx = makeCtx({
      toolResults: [{ turn: 1, tool: 'write_file', params: { path: smallFile }, result: 'ok' }]
    });
    const result = await fileSizeGuardHook(ctx);
    assert.equal(result, undefined);
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('returns a continue warning when written file exceeds 100 KB', async () => {
    await mkdir(TEST_DIR, { recursive: true });
    const bigFile = join(TEST_DIR, 'huge.js');
    await writeFile(bigFile, 'x'.repeat(110 * 1024)); // 110 KB
    const ctx = makeCtx({
      toolResults: [{ turn: 1, tool: 'write_file', params: { path: bigFile }, result: 'ok' }]
    });
    const result = await fileSizeGuardHook(ctx);
    assert.ok(result, 'expected a result');
    assert.equal(result.action, 'continue');
    assert.ok(result.message.includes('large'));
    assert.ok(result.message.includes(bigFile));
    await rm(TEST_DIR, { recursive: true, force: true });
  });
});
