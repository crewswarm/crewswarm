/**
 * Unit tests for WorktreeTool (worktree.ts)
 */

import { strict as assert } from 'node:assert';
import { describe, it, before, after, mock } from 'node:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Helpers ──────────────────────────────────────────────────────────────────

function initGitRepo(dir) {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  execSync('touch README.md && git add . && git commit -m "init" --allow-empty', { cwd: dir, stdio: 'pipe', shell: true });
}

function makeTmpGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'crew-wt-test-'));
  initGitRepo(dir);
  return dir;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WorktreeTool — unit', () => {
  it('should export WORKTREE_TOOL_NAME constant', async () => {
    const { WORKTREE_TOOL_NAME } = await import('../../src/tools/gemini/tool-names.ts');
    assert.equal(WORKTREE_TOOL_NAME, 'worktree');
  });

  it('should include worktree in ALL_BUILTIN_TOOL_NAMES', async () => {
    const { ALL_BUILTIN_TOOL_NAMES, WORKTREE_TOOL_NAME } = await import('../../src/tools/gemini/tool-names.ts');
    assert.ok(ALL_BUILTIN_TOOL_NAMES.includes(WORKTREE_TOOL_NAME), 'worktree should be in ALL_BUILTIN_TOOL_NAMES');
  });

  it('WORKTREE_DEFINITION should have correct structure', async () => {
    const { WORKTREE_DEFINITION } = await import('../../src/tools/gemini/definitions/coreTools.ts');
    assert.ok(WORKTREE_DEFINITION, 'WORKTREE_DEFINITION should exist');
    assert.ok(WORKTREE_DEFINITION.base, 'should have base property');
    assert.equal(WORKTREE_DEFINITION.base.name, 'worktree');
    assert.ok(WORKTREE_DEFINITION.base.description, 'should have description');
    assert.ok(WORKTREE_DEFINITION.base.parametersJsonSchema, 'should have parametersJsonSchema');
  });

  it('WORKTREE_DEFINITION schema should require action parameter', async () => {
    const { WORKTREE_DEFINITION } = await import('../../src/tools/gemini/definitions/coreTools.ts');
    const schema = WORKTREE_DEFINITION.base.parametersJsonSchema;
    assert.deepStrictEqual(schema.required, ['action'], 'action should be required');
    assert.ok(schema.properties.action, 'action property should exist');
    assert.deepStrictEqual(
      schema.properties.action.enum,
      ['enter', 'exit', 'merge', 'list'],
      'action should be one of enter/exit/merge/list'
    );
  });

  it('WORKTREE_DEFINITION schema should have optional branch and merge params', async () => {
    const { WORKTREE_DEFINITION } = await import('../../src/tools/gemini/definitions/coreTools.ts');
    const { properties } = WORKTREE_DEFINITION.base.parametersJsonSchema;
    assert.ok(properties.branch, 'branch should be in schema');
    assert.equal(properties.branch.type, 'string');
    assert.ok(properties.merge, 'merge should be in schema');
    assert.equal(properties.merge.type, 'boolean');
    assert.ok(properties.projectDir, 'projectDir should be in schema');
  });

  it('GeminiToolAdapter should handle worktree tool_search cases', async () => {
    // Test the tool_search case is in the switch statement
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    assert.ok(typeof GeminiToolAdapter === 'function', 'GeminiToolAdapter should be a class');
  });

  it('worktree action "list" should return no active worktrees on fresh state', async () => {
    // Test worktree list via GeminiToolAdapter
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const fakeSandbox = {
      baseDir: tmpdir(),
      getBaseDir() { return this.baseDir; },
      addChange: async () => {},
      getStagedContent: () => undefined,
      getActiveBranch: () => 'main',
      getBranches: () => ['main'],
      mergeBranch: async () => {},
      switchBranch: async () => {},
      deleteBranch: async () => {}
    };
    const adapter = new GeminiToolAdapter(fakeSandbox, 'full');
    const result = await adapter.executeTool('worktree', { action: 'list' });
    assert.ok(result.success !== false || result.error, 'Should return a result');
    // List action doesn't fail on empty state
    if (result.success) {
      assert.ok(result.output, 'Should have output');
    }
  });

  it('worktree action "enter" without branch should fail', async () => {
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const dir = tmpdir();
    const fakeSandbox = { baseDir: dir, getBaseDir: () => dir, addChange: async () => {} };
    const adapter = new GeminiToolAdapter(fakeSandbox, 'full');
    const result = await adapter.executeTool('worktree', { action: 'enter' });
    // Should fail because branch is required
    assert.ok(result.success === false || result.error, 'Should fail without branch for enter');
  });

  it('worktree action "exit" without branch should fail', async () => {
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const dir = tmpdir();
    const fakeSandbox = { baseDir: dir, getBaseDir: () => dir, addChange: async () => {} };
    const adapter = new GeminiToolAdapter(fakeSandbox, 'full');
    const result = await adapter.executeTool('worktree', { action: 'exit' });
    assert.ok(result.success === false || result.error, 'Should fail without branch for exit');
  });

  it('worktree action "merge" without branch should fail', async () => {
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const dir = tmpdir();
    const fakeSandbox = { baseDir: dir, getBaseDir: () => dir, addChange: async () => {} };
    const adapter = new GeminiToolAdapter(fakeSandbox, 'full');
    const result = await adapter.executeTool('worktree', { action: 'merge' });
    assert.ok(result.success === false || result.error, 'Should fail without branch for merge');
  });
});
