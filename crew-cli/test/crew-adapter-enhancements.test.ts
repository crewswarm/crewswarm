/**
 * Tests for crew-adapter.ts enhancements:
 * - Read-before-edit guard
 * - replace_all flag
 * - Edit uniqueness enforcement
 * - Background shell execution
 * - Git safety guards
 * - Dangerous command detection
 * - Enhanced grep output modes
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiToolAdapter } from '../src/tools/gemini/crew-adapter.js';
import { Sandbox } from '../src/sandbox/index.js';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function makeTempProject(): Promise<{ dir: string; sandbox: Sandbox; adapter: GeminiToolAdapter }> {
  const dir = await mkdtemp(join(tmpdir(), 'crew-test-'));
  await mkdir(join(dir, '.crew'), { recursive: true });
  const sandbox = new Sandbox(dir);
  const adapter = new GeminiToolAdapter(sandbox);
  return { dir, sandbox, adapter };
}

describe('crew-adapter enhancements', () => {

  // ── Read-before-edit guard ──────────────────────────────────────────

  describe('read-before-edit guard', () => {
    it('rejects edit on unread file', async () => {
      const { dir, adapter } = await makeTempProject();
      await writeFile(join(dir, 'foo.ts'), 'const x = 1;\nconst y = 2;\n');

      const result = await adapter.executeTool('edit', {
        file_path: 'foo.ts',
        old_string: 'const x = 1;',
        new_string: 'const x = 42;'
      });

      assert.equal(result.success, false);
      assert.ok(result.error?.includes('must read_file'), `Expected read guard error, got: ${result.error}`);
    });

    it('allows edit after read', async () => {
      const { dir, adapter } = await makeTempProject();
      await writeFile(join(dir, 'foo.ts'), 'const x = 1;\nconst y = 2;\n');

      // Read first
      await adapter.executeTool('read_file', { file_path: 'foo.ts' });

      // Now edit should work
      const result = await adapter.executeTool('edit', {
        file_path: 'foo.ts',
        old_string: 'const x = 1;',
        new_string: 'const x = 42;'
      });

      assert.equal(result.success, true);
    });
  });

  // ── Edit uniqueness ─────────────────────────────────────────────────

  describe('edit uniqueness', () => {
    it('rejects ambiguous edit (multiple matches)', async () => {
      const { dir, adapter } = await makeTempProject();
      await writeFile(join(dir, 'dup.ts'), 'foo\nbar\nfoo\nbaz\n');

      await adapter.executeTool('read_file', { file_path: 'dup.ts' });

      const result = await adapter.executeTool('replace', {
        file_path: 'dup.ts',
        old_string: 'foo',
        new_string: 'qux'
      });

      assert.equal(result.success, false);
      assert.ok(result.error?.includes('2 locations'), `Expected uniqueness error, got: ${result.error}`);
    });

    it('replace_all replaces every occurrence', async () => {
      const { dir, sandbox, adapter } = await makeTempProject();
      await writeFile(join(dir, 'dup.ts'), 'foo\nbar\nfoo\nbaz\n');

      await adapter.executeTool('read_file', { file_path: 'dup.ts' });

      const result = await adapter.executeTool('replace', {
        file_path: 'dup.ts',
        old_string: 'foo',
        new_string: 'qux',
        replace_all: true
      });

      assert.equal(result.success, true);
      assert.ok(result.output?.includes('2 replacements'), `Expected 2 replacements, got: ${result.output}`);
    });
  });

  // ── Git safety ──────────────────────────────────────────────────────

  describe('git safety', () => {
    it('blocks force push', async () => {
      const { adapter } = await makeTempProject();
      const result = await adapter.executeTool('git', { command: 'push --force origin main' });
      assert.equal(result.success, false);
      assert.ok(result.error?.includes('Force push'), result.error);
    });

    it('blocks --no-verify', async () => {
      const { adapter } = await makeTempProject();
      const result = await adapter.executeTool('git', { command: 'commit -m "test" --no-verify' });
      assert.equal(result.success, false);
      assert.ok(result.error?.includes('--no-verify'), result.error);
    });

    it('blocks git reset --hard', async () => {
      const { adapter } = await makeTempProject();
      const result = await adapter.executeTool('git', { command: 'reset --hard HEAD~1' });
      assert.equal(result.success, false);
      assert.ok(result.error?.includes('destructive'), result.error);
    });

    it('allows expanded subcommands', async () => {
      const { adapter } = await makeTempProject();
      // stash should be allowed (even if it fails due to no git repo)
      const result = await adapter.executeTool('git', { command: 'stash list' });
      // It'll fail because temp dir isn't a git repo, but it shouldn't be "not allowed"
      assert.ok(!result.error?.includes('not allowed'), `stash should be allowed, got: ${result.error}`);
    });

    it('rejects disallowed subcommand', async () => {
      const { adapter } = await makeTempProject();
      const result = await adapter.executeTool('git', { command: 'gc --aggressive' });
      assert.equal(result.success, false);
      assert.ok(result.error?.includes('not allowed'), result.error);
    });
  });

  // ── Background shell ───────────────────────────────────────────────

  describe('background shell execution', () => {
    it('returns task ID for background command', async () => {
      const { adapter } = await makeTempProject();
      const result = await adapter.executeTool('run_shell_command', {
        command: 'echo hello',
        run_in_background: true
      });

      assert.equal(result.success, true);
      assert.ok(result.output?.includes('Background task started'), result.output);
      assert.ok(result.output?.includes('bg_'), result.output);
    });

    it('check_background_task returns result when done', async () => {
      const { adapter } = await makeTempProject();

      // Start background task
      const bgResult = await adapter.executeTool('run_shell_command', {
        command: 'echo "done"',
        run_in_background: true
      });

      const taskId = bgResult.output?.match(/bg_\S+/)?.[0];
      assert.ok(taskId, 'Should have task ID');

      // Wait a moment then check
      await new Promise(r => setTimeout(r, 200));

      const checkResult = await adapter.executeTool('check_background_task', { task_id: taskId });
      assert.equal(checkResult.success, true);
      assert.ok(checkResult.output?.includes('done'), checkResult.output);
    });

    it('check_background_task fails for unknown ID', async () => {
      const { adapter } = await makeTempProject();
      const result = await adapter.executeTool('check_background_task', { task_id: 'bg_nonexistent' });
      assert.equal(result.success, false);
    });
  });

  // ── Enhanced grep ──────────────────────────────────────────────────

  describe('enhanced grep', () => {
    it('files output mode returns only file paths', async () => {
      const { dir, adapter } = await makeTempProject();
      await writeFile(join(dir, 'a.ts'), 'hello world\n');
      await writeFile(join(dir, 'b.ts'), 'hello there\n');

      const result = await adapter.executeTool('grep_search', {
        pattern: 'hello',
        path: dir,
        output_mode: 'files'
      });

      assert.equal(result.success, true);
      // Should have file paths, not line content
      assert.ok(result.output?.includes('a.ts'), result.output);
      assert.ok(!result.output?.includes('world'), `files mode should not include line content: ${result.output}`);
    });

    it('no matches returns success with message instead of error', async () => {
      const { dir, adapter } = await makeTempProject();
      await writeFile(join(dir, 'a.ts'), 'hello world\n');

      const result = await adapter.executeTool('grep_search', {
        pattern: 'zzzznonexistent',
        path: dir
      });

      assert.equal(result.success, true);
      assert.ok(result.output?.includes('no matches'), result.output);
    });
  });

  // ── Tool count ─────────────────────────────────────────────────────

  describe('tool declarations', () => {
    it('has 31+ tools declared', () => {
      const { adapter } = { adapter: null as any };
      // Use static declarations as proxy
      const tmp = new GeminiToolAdapter(new Sandbox());
      const decls = tmp.getToolDeclarations();
      assert.ok(decls.length >= 31, `Expected 31+ tools, got ${decls.length}`);
    });
  });
});
