/**
 * Unit tests for crew-cli/src/context/augment.ts
 *
 * Tests pure utility functions: collectOption, clip (via buildFileContextBlock),
 * inferImageMime (via buildImageContextBlock), mergeTaskWithContext,
 * estimateTokens, enforceContextBudget, buildFileContextBlock,
 * buildImageContextBlock.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let mod;
async function loadMod() {
  if (mod) return mod;
  mod = await import('../../src/context/augment.ts');
  return mod;
}

// ── collectOption ────────────────────────────────────────────────────────────

describe('collectOption', () => {
  it('appends value to previous array', async () => {
    const m = await loadMod();
    const result = m.collectOption('foo', ['bar']);
    assert.deepEqual(result, ['bar', 'foo']);
  });

  it('creates new array when previous is empty', async () => {
    const m = await loadMod();
    const result = m.collectOption('first', []);
    assert.deepEqual(result, ['first']);
  });

  it('returns previous when value is empty string', async () => {
    const m = await loadMod();
    const result = m.collectOption('', ['existing']);
    assert.deepEqual(result, ['existing']);
  });

  it('uses default empty array when previous is undefined', async () => {
    const m = await loadMod();
    const result = m.collectOption('val');
    assert.deepEqual(result, ['val']);
  });
});

// ── estimateTokens ───────────────────────────────────────────────────────────

describe('estimateTokens', () => {
  it('estimates roughly length/4', async () => {
    const m = await loadMod();
    assert.equal(m.estimateTokens('1234567890123456'), 4); // 16 chars / 4
  });

  it('returns 0 for empty string', async () => {
    const m = await loadMod();
    assert.equal(m.estimateTokens(''), 0);
  });

  it('returns 0 for falsy input', async () => {
    const m = await loadMod();
    assert.equal(m.estimateTokens(null), 0);
    assert.equal(m.estimateTokens(undefined), 0);
  });

  it('rounds up', async () => {
    const m = await loadMod();
    assert.equal(m.estimateTokens('abc'), 1); // ceil(3/4) = 1
  });
});

// ── mergeTaskWithContext ─────────────────────────────────────────────────────

describe('mergeTaskWithContext', () => {
  it('returns task alone when blocks are empty', async () => {
    const m = await loadMod();
    assert.equal(m.mergeTaskWithContext('do stuff', []), 'do stuff');
  });

  it('appends non-empty blocks separated by newlines', async () => {
    const m = await loadMod();
    const result = m.mergeTaskWithContext('task', ['block1', 'block2']);
    assert.ok(result.startsWith('task'));
    assert.ok(result.includes('block1'));
    assert.ok(result.includes('block2'));
  });

  it('filters out empty and whitespace-only blocks', async () => {
    const m = await loadMod();
    const result = m.mergeTaskWithContext('task', ['', '  ', 'real']);
    assert.ok(result.includes('real'));
    assert.ok(!result.includes('\n\n\n\n'));
  });

  it('handles null/undefined blocks gracefully', async () => {
    const m = await loadMod();
    const result = m.mergeTaskWithContext('task', [null, undefined, 'ok']);
    assert.ok(result.includes('ok'));
  });
});

// ── enforceContextBudget ─────────────────────────────────────────────────────

describe('enforceContextBudget', () => {
  it('returns merged text when under budget', async () => {
    const m = await loadMod();
    const result = m.enforceContextBudget('task', ['ctx'], 1000);
    assert.equal(result.trimmed, false);
    assert.equal(result.exceeded, false);
    assert.ok(result.task.includes('task'));
    assert.ok(result.task.includes('ctx'));
  });

  it('trims when over budget in trim mode', async () => {
    const m = await loadMod();
    const bigBlock = 'x'.repeat(10000);
    const result = m.enforceContextBudget('task', [bigBlock], 100, 'trim');
    assert.equal(result.trimmed, true);
    assert.equal(result.exceeded, false);
    assert.ok(result.estimatedTokens <= 100);
  });

  it('marks exceeded in stop mode without trimming', async () => {
    const m = await loadMod();
    const bigBlock = 'x'.repeat(10000);
    const result = m.enforceContextBudget('task', [bigBlock], 100, 'stop');
    assert.equal(result.trimmed, false);
    assert.equal(result.exceeded, true);
    assert.ok(result.estimatedTokens > 100);
  });

  it('returns merged when maxTokens is 0 or undefined', async () => {
    const m = await loadMod();
    const result = m.enforceContextBudget('task', ['ctx'], 0);
    assert.equal(result.trimmed, false);
    assert.equal(result.exceeded, false);

    const result2 = m.enforceContextBudget('task', ['ctx']);
    assert.equal(result2.trimmed, false);
  });

  it('estimatedTokens is always a number', async () => {
    const m = await loadMod();
    const result = m.enforceContextBudget('a', ['b'], 1000);
    assert.equal(typeof result.estimatedTokens, 'number');
    assert.ok(result.estimatedTokens > 0);
  });
});

// ── buildFileContextBlock ────────────────────────────────────────────────────

describe('buildFileContextBlock', () => {
  const tmpDir = join(tmpdir(), `augment-test-${Date.now()}`);

  it('returns empty string for no paths', async () => {
    const m = await loadMod();
    const result = await m.buildFileContextBlock([]);
    assert.equal(result, '');
  });

  it('includes file content for existing files', async () => {
    const m = await loadMod();
    mkdirSync(tmpDir, { recursive: true });
    const filePath = join(tmpDir, 'sample.txt');
    writeFileSync(filePath, 'Hello from test file');

    const result = await m.buildFileContextBlock([filePath]);
    assert.ok(result.includes('Hello from test file'));
    assert.ok(result.includes('File Context'));

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('handles missing files gracefully', async () => {
    const m = await loadMod();
    const result = await m.buildFileContextBlock(['/tmp/nonexistent-file-xyz']);
    assert.ok(result.includes('unavailable'));
  });

  it('truncates large files', async () => {
    const m = await loadMod();
    mkdirSync(tmpDir, { recursive: true });
    const filePath = join(tmpDir, 'big.txt');
    writeFileSync(filePath, 'x'.repeat(20000));

    const result = await m.buildFileContextBlock([filePath], 100);
    assert.ok(result.includes('truncated'));

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── buildImageContextBlock ───────────────────────────────────────────────────

describe('buildImageContextBlock', () => {
  const tmpDir = join(tmpdir(), `augment-img-test-${Date.now()}`);

  it('returns empty string for no paths', async () => {
    const m = await loadMod();
    const result = await m.buildImageContextBlock([]);
    assert.equal(result, '');
  });

  it('includes base64 data URI for PNG files', async () => {
    const m = await loadMod();
    mkdirSync(tmpDir, { recursive: true });
    const filePath = join(tmpDir, 'test.png');
    writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await m.buildImageContextBlock([filePath]);
    assert.ok(result.includes('data:image/png;base64,'));
    assert.ok(result.includes('Image Context'));

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects unsupported image types', async () => {
    const m = await loadMod();
    mkdirSync(tmpDir, { recursive: true });
    const filePath = join(tmpDir, 'test.bmp');
    writeFileSync(filePath, Buffer.from([0x42, 0x4d]));

    const result = await m.buildImageContextBlock([filePath]);
    assert.ok(result.includes('unsupported'));

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── loadImageAttachments ─────────────────────────────────────────────────────

describe('loadImageAttachments', () => {
  const tmpDir = join(tmpdir(), `augment-attach-test-${Date.now()}`);

  it('returns empty array for no paths', async () => {
    const m = await loadMod();
    const result = await m.loadImageAttachments([]);
    assert.deepEqual(result, []);
  });

  it('returns attachment for valid image file', async () => {
    const m = await loadMod();
    mkdirSync(tmpDir, { recursive: true });
    const filePath = join(tmpDir, 'test.jpg');
    writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));

    const result = await m.loadImageAttachments([filePath]);
    assert.equal(result.length, 1);
    assert.equal(result[0].mimeType, 'image/jpeg');
    assert.ok(result[0].data.length > 0);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips unsupported image types', async () => {
    const m = await loadMod();
    mkdirSync(tmpDir, { recursive: true });
    const filePath = join(tmpDir, 'test.tiff');
    writeFileSync(filePath, Buffer.from([0x49, 0x49]));

    const result = await m.loadImageAttachments([filePath]);
    assert.equal(result.length, 0);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
