import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enterWorktree, exitWorktree, listWorktrees } from '../../src/tools/worktree.ts';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';

// Create a temp git repo for testing
const TEST_REPO = mkdtempSync(join(tmpdir(), 'crew-wt-test-'));
execSync('git init && git config user.email "test@test.com" && git config user.name "Test" && git commit --allow-empty -m "init"', { cwd: TEST_REPO });

test('enterWorktree creates a worktree and branch', () => {
  const info = enterWorktree(TEST_REPO, { branchPrefix: 'test-wt', agentId: 'abc123' });
  assert.ok(info.worktreePath.includes('.crew/worktrees'));
  assert.ok(info.branchName.startsWith('test-wt/'));
  assert.ok(info.baseBranch); // main or master
  assert.ok(info.createdAt);
});

test('listWorktrees shows the active worktree', () => {
  const trees = listWorktrees();
  assert.ok(trees.length >= 1);
  assert.ok(trees[0].branchName.startsWith('test-wt/'));
});

test('exitWorktree cleans up when no changes made', async () => {
  const trees = listWorktrees();
  const branch = trees[0].branchName;
  const result = await exitWorktree(TEST_REPO, branch);
  assert.equal(result.hasChanges, false);
  assert.equal(result.commitCount, 0);
  assert.equal(listWorktrees().length, 0);
});

test('exitWorktree keeps branch when changes are committed', async () => {
  const info = enterWorktree(TEST_REPO, { branchPrefix: 'wt-changes', agentId: 'def456' });

  // Make a change in the worktree
  writeFileSync(join(info.worktreePath, 'new-file.txt'), 'agent work');
  execSync('git config user.email "test@test.com" && git config user.name "Test" && git add -A && git commit -m "agent work"', { cwd: info.worktreePath });

  const result = await exitWorktree(TEST_REPO, info.branchName);
  assert.equal(result.hasChanges, true);
  assert.ok(result.commitCount >= 1);
  assert.equal(result.branchName, info.branchName);
});

test('exitWorktree auto-commits uncommitted changes', async () => {
  const info = enterWorktree(TEST_REPO, { branchPrefix: 'wt-uncommitted', agentId: 'ghi789' });

  // Make a change but don't commit
  writeFileSync(join(info.worktreePath, 'uncommitted.txt'), 'not committed yet');

  const result = await exitWorktree(TEST_REPO, info.branchName);
  assert.equal(result.hasChanges, true);
  assert.ok(result.commitCount >= 1); // Should auto-commit
});

test('enterWorktree throws for non-git directory', () => {
  assert.throws(() => enterWorktree('/tmp'), /Not a git repository/);
});

test('exitWorktree throws for unknown branch', async () => {
  await assert.rejects(
    () => exitWorktree(TEST_REPO, 'nonexistent-branch'),
    /No active worktree found/
  );
});

// Cleanup
test('cleanup test repo', async () => {
  // Prune any remaining worktrees
  try { execSync('git worktree prune', { cwd: TEST_REPO }); } catch {}
  await rm(TEST_REPO, { recursive: true, force: true });
});
