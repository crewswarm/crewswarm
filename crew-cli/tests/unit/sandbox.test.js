/**
 * Unit tests for crew-cli/src/sandbox/index.ts
 *
 * Tests: constructor, createBranch, switchBranch, getActiveBranch,
 * addChange (stageFile), getPendingPaths (getStagedFiles), rollback,
 * preview, apply, deleteBranch, mergeBranch, hasChanges, getStagedContent.
 *
 * Uses a temp directory to avoid touching real project state.
 */

import { test, describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Sandbox } from '../../src/sandbox/index.ts';

let TEST_DIR;

before(async () => {
  TEST_DIR = await mkdtemp(join(tmpdir(), 'crew-sandbox-test-'));
});

after(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

// ── Constructor ─────────────────────────────────────────────────────────────

describe('Sandbox — constructor', () => {
  it('creates a sandbox with default state', () => {
    const sb = new Sandbox(TEST_DIR);
    assert.equal(sb.getActiveBranch(), 'main');
    assert.deepEqual(sb.getBranches(), ['main']);
  });

  it('defaults active branch to main', () => {
    const sb = new Sandbox(TEST_DIR);
    assert.equal(sb.getActiveBranch(), 'main');
  });

  it('has no changes initially', () => {
    const sb = new Sandbox(TEST_DIR);
    assert.equal(sb.hasChanges(), false);
  });

  it('getPendingPaths returns empty array initially', () => {
    const sb = new Sandbox(TEST_DIR);
    assert.deepEqual(sb.getPendingPaths(), []);
  });
});

// ── createBranch ────────────────────────────────────────────────────────────

describe('Sandbox — createBranch', () => {
  it('creates a new branch and switches to it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-branch-'));
    try {
      const sb = new Sandbox(dir);
      await sb.createBranch('feature-1');
      assert.equal(sb.getActiveBranch(), 'feature-1');
      assert.ok(sb.getBranches().includes('feature-1'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws when creating a duplicate branch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-dup-'));
    try {
      const sb = new Sandbox(dir);
      await sb.createBranch('dupe');
      await assert.rejects(() => sb.createBranch('dupe'), /already exists/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('deep-copies changes from the source branch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-copy-'));
    try {
      const sb = new Sandbox(dir);
      await sb.addChange('file.txt', 'modified content');
      await sb.createBranch('copy-branch', 'main');
      // The new branch should have the same staged change
      assert.deepEqual(sb.getPendingPaths('copy-branch'), ['file.txt']);
      // Modifying the new branch should not affect main
      await sb.addChange('file.txt', 'further modified');
      const mainContent = sb.getStagedContent('file.txt', 'main');
      assert.equal(mainContent, 'modified content');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── switchBranch ────────────────────────────────────────────────────────────

describe('Sandbox — switchBranch', () => {
  it('switches to an existing branch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-switch-'));
    try {
      const sb = new Sandbox(dir);
      await sb.createBranch('dev');
      await sb.switchBranch('main');
      assert.equal(sb.getActiveBranch(), 'main');
      await sb.switchBranch('dev');
      assert.equal(sb.getActiveBranch(), 'dev');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws when switching to a non-existent branch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-noswitch-'));
    try {
      const sb = new Sandbox(dir);
      await assert.rejects(() => sb.switchBranch('nope'), /does not exist/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── getActiveBranch ─────────────────────────────────────────────────────────

describe('Sandbox — getActiveBranch', () => {
  it('reflects the current branch after creation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-active-'));
    try {
      const sb = new Sandbox(dir);
      assert.equal(sb.getActiveBranch(), 'main');
      await sb.createBranch('test-branch');
      assert.equal(sb.getActiveBranch(), 'test-branch');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── addChange (stageFile) ───────────────────────────────────────────────────

describe('Sandbox — addChange (stageFile)', () => {
  it('stages a new file change', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-stage-'));
    try {
      const sb = new Sandbox(dir);
      await sb.addChange('src/app.ts', 'console.log("hello");');
      assert.deepEqual(sb.getPendingPaths(), ['src/app.ts']);
      assert.equal(sb.getStagedContent('src/app.ts'), 'console.log("hello");');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('overwrites an existing staged change preserving original', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-overwrite-'));
    try {
      const sb = new Sandbox(dir);
      await sb.addChange('file.ts', 'v1');
      await sb.addChange('file.ts', 'v2');
      assert.equal(sb.getStagedContent('file.ts'), 'v2');
      // Original should still be empty string (file didn't exist on disk)
      const state = sb.getState();
      assert.equal(state.branches.main['file.ts'].original, '');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads original content from disk if file exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-origdisk-'));
    try {
      await writeFile(join(dir, 'existing.txt'), 'original disk content');
      const sb = new Sandbox(dir);
      await sb.addChange('existing.txt', 'new content');
      const state = sb.getState();
      assert.equal(state.branches.main['existing.txt'].original, 'original disk content');
      assert.equal(state.branches.main['existing.txt'].modified, 'new content');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('hasChanges returns true after staging', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-haschanges-'));
    try {
      const sb = new Sandbox(dir);
      assert.equal(sb.hasChanges(), false);
      await sb.addChange('file.ts', 'content');
      assert.equal(sb.hasChanges(), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── getStagedContent (getStagedFiles) ───────────────────────────────────────

describe('Sandbox — getStagedContent', () => {
  it('returns undefined for unstaged file', () => {
    const sb = new Sandbox(TEST_DIR);
    assert.equal(sb.getStagedContent('nonexistent.ts'), undefined);
  });

  it('returns undefined for nonexistent branch', () => {
    const sb = new Sandbox(TEST_DIR);
    assert.equal(sb.getStagedContent('file.ts', 'no-branch'), undefined);
  });

  it('returns modified content for staged file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-content-'));
    try {
      const sb = new Sandbox(dir);
      await sb.addChange('test.ts', 'staged content');
      assert.equal(sb.getStagedContent('test.ts'), 'staged content');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── rollback ────────────────────────────────────────────────────────────────

describe('Sandbox — rollback', () => {
  it('clears all changes for the specified branch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-rollback-'));
    try {
      const sb = new Sandbox(dir);
      await sb.addChange('a.ts', 'content-a');
      await sb.addChange('b.ts', 'content-b');
      assert.equal(sb.hasChanges(), true);
      await sb.rollback();
      assert.equal(sb.hasChanges(), false);
      assert.deepEqual(sb.getPendingPaths(), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not affect other branches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-rollback-other-'));
    try {
      const sb = new Sandbox(dir);
      await sb.addChange('file.ts', 'main content');
      await sb.createBranch('feature');
      await sb.addChange('other.ts', 'feature content');
      await sb.rollback('feature');
      assert.equal(sb.hasChanges('feature'), false);
      assert.equal(sb.hasChanges('main'), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is safe to call on a branch with no changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-rollback-noop-'));
    try {
      const sb = new Sandbox(dir);
      await assert.doesNotReject(() => sb.rollback());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── preview ─────────────────────────────────────────────────────────────────

describe('Sandbox — preview', () => {
  it('returns "No pending changes." when branch is clean', () => {
    const sb = new Sandbox(TEST_DIR);
    assert.equal(sb.preview(), 'No pending changes.');
  });

  it('returns a unified diff string for staged changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-preview-'));
    try {
      const sb = new Sandbox(dir);
      await sb.addChange('hello.txt', 'new content');
      const diff = sb.preview();
      assert.ok(diff.includes('a/hello.txt'));
      assert.ok(diff.includes('b/hello.txt'));
      assert.ok(diff.includes('+new content'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns error message for nonexistent branch', () => {
    const sb = new Sandbox(TEST_DIR);
    const result = sb.preview('no-such-branch');
    assert.ok(result.includes('not found'));
  });
});

// ── apply ───────────────────────────────────────────────────────────────────

describe('Sandbox — apply', () => {
  it('writes staged changes to disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-apply-'));
    try {
      const sb = new Sandbox(dir);
      await sb.addChange('output.txt', 'applied content');
      await sb.apply();
      const content = await readFile(join(dir, 'output.txt'), 'utf8');
      assert.equal(content, 'applied content');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('clears changes after applying (rollback)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-apply-clear-'));
    try {
      const sb = new Sandbox(dir);
      await sb.addChange('file.txt', 'content');
      await sb.apply();
      assert.equal(sb.hasChanges(), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('creates nested directories as needed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-apply-nested-'));
    try {
      const sb = new Sandbox(dir);
      await sb.addChange('deep/nested/dir/file.txt', 'deep content');
      await sb.apply();
      const content = await readFile(join(dir, 'deep/nested/dir/file.txt'), 'utf8');
      assert.equal(content, 'deep content');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── deleteBranch ────────────────────────────────────────────────────────────

describe('Sandbox — deleteBranch', () => {
  it('removes a branch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-delbranch-'));
    try {
      const sb = new Sandbox(dir);
      await sb.createBranch('temp');
      await sb.switchBranch('main');
      await sb.deleteBranch('temp');
      assert.ok(!sb.getBranches().includes('temp'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws when deleting main branch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-delmain-'));
    try {
      const sb = new Sandbox(dir);
      await assert.rejects(() => sb.deleteBranch('main'), /Cannot delete main/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('switches to main when deleting the active branch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-delactive-'));
    try {
      const sb = new Sandbox(dir);
      await sb.createBranch('active-del');
      assert.equal(sb.getActiveBranch(), 'active-del');
      await sb.deleteBranch('active-del');
      assert.equal(sb.getActiveBranch(), 'main');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── persist / load ──────────────────────────────────────────────────────────

describe('Sandbox — persist and load', () => {
  it('round-trips state through persist and load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-persist-'));
    try {
      const sb1 = new Sandbox(dir);
      await sb1.addChange('roundtrip.txt', 'saved content');
      await sb1.createBranch('saved-branch');

      const sb2 = new Sandbox(dir);
      await sb2.load();
      assert.equal(sb2.getActiveBranch(), 'saved-branch');
      assert.ok(sb2.getBranches().includes('main'));
      assert.ok(sb2.getBranches().includes('saved-branch'));
      // The staged content from main should survive round-trip
      assert.equal(sb2.getStagedContent('roundtrip.txt', 'main'), 'saved content');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('load handles missing state file gracefully', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-nostate-'));
    try {
      const sb = new Sandbox(dir);
      await assert.doesNotReject(() => sb.load());
      assert.equal(sb.getActiveBranch(), 'main');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── mergeBranch ─────────────────────────────────────────────────────────────

describe('Sandbox — mergeBranch', () => {
  it('copies changes from source to target branch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-merge-'));
    try {
      const sb = new Sandbox(dir);
      await sb.addChange('main-file.txt', 'main content');
      await sb.createBranch('feature');
      await sb.addChange('feature-file.txt', 'feature content');
      await sb.switchBranch('main');
      await sb.mergeBranch('feature', 'main');
      assert.ok(sb.getPendingPaths('main').includes('feature-file.txt'));
      assert.equal(sb.getStagedContent('feature-file.txt', 'main'), 'feature content');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws for nonexistent source branch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-merge-nosrc-'));
    try {
      const sb = new Sandbox(dir);
      await assert.rejects(() => sb.mergeBranch('ghost', 'main'), /not found/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
