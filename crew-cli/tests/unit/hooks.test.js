import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHookConfig, clearHookCache, runPreToolUseHooks, runPostToolUseHooks } from '../../src/hooks/index.ts';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const TEST_DIR = join('/tmp', `crew-hooks-test-${Date.now()}`);

test('loadHookConfig returns empty hooks when no file exists', async () => {
  clearHookCache();
  const config = await loadHookConfig('/tmp/nonexistent-dir');
  assert.deepEqual(config.hooks, {});
});

test('loadHookConfig loads valid hooks.json', async () => {
  await mkdir(join(TEST_DIR, '.crew'), { recursive: true });
  await writeFile(join(TEST_DIR, '.crew', 'hooks.json'), JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'shell', command: 'echo ok', timeout: 1000 }]
    }
  }));
  clearHookCache();
  const config = await loadHookConfig(TEST_DIR);
  assert.equal(config.hooks.PreToolUse.length, 1);
  assert.equal(config.hooks.PreToolUse[0].matcher, 'shell');
  await rm(TEST_DIR, { recursive: true, force: true });
});

test('runPreToolUseHooks allows by default when no hooks configured', async () => {
  clearHookCache();
  const result = await runPreToolUseHooks('shell', { command: 'ls' }, '/tmp/nonexistent');
  assert.equal(result.decision, 'allow');
});

test('runPreToolUseHooks allows when matcher does not match', async () => {
  await mkdir(join(TEST_DIR, '.crew'), { recursive: true });
  await writeFile(join(TEST_DIR, '.crew', 'hooks.json'), JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'shell', command: 'exit 1', timeout: 1000 }]
    }
  }));
  clearHookCache();
  // 'read_file' should not match 'shell' pattern
  const result = await runPreToolUseHooks('read_file', { path: '/tmp/x' }, TEST_DIR);
  assert.equal(result.decision, 'allow');
  await rm(TEST_DIR, { recursive: true, force: true });
});

test('runPreToolUseHooks denies when hook exits non-zero', async () => {
  await mkdir(join(TEST_DIR, '.crew'), { recursive: true });
  await writeFile(join(TEST_DIR, '.crew', 'hooks.json'), JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'shell', command: 'exit 1', timeout: 2000 }]
    }
  }));
  clearHookCache();
  const result = await runPreToolUseHooks('shell', { command: 'rm -rf /' }, TEST_DIR);
  assert.equal(result.decision, 'deny');
  await rm(TEST_DIR, { recursive: true, force: true });
});

test('runPreToolUseHooks allows when hook exits zero', async () => {
  await mkdir(join(TEST_DIR, '.crew'), { recursive: true });
  await writeFile(join(TEST_DIR, '.crew', 'hooks.json'), JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'shell', command: 'echo ok', timeout: 2000 }]
    }
  }));
  clearHookCache();
  const result = await runPreToolUseHooks('shell', { command: 'ls' }, TEST_DIR);
  assert.equal(result.decision, 'allow');
  await rm(TEST_DIR, { recursive: true, force: true });
});

test('runPostToolUseHooks completes without error', async () => {
  clearHookCache();
  const result = await runPostToolUseHooks('shell', { command: 'ls' }, { output: 'file.txt' }, '/tmp/nonexistent');
  assert.deepEqual(result, {});
});
