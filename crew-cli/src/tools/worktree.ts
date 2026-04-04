/**
 * Git Worktree Isolation for Parallel Agent Work
 *
 * Creates isolated git worktrees so subagents can work on separate branches
 * without conflicting with each other or the main working directory.
 *
 * Flow:
 * 1. enterWorktree() — creates a new worktree + branch
 * 2. Agent works in the isolated directory
 * 3. exitWorktree() — if changes made, returns branch name for merge; if no changes, cleans up
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';

export interface WorktreeInfo {
  worktreePath: string;
  branchName: string;
  baseBranch: string;
  createdAt: string;
}

/** Active worktrees tracked in memory */
const activeWorktrees = new Map<string, WorktreeInfo>();

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf8', timeout: 30000 }).trim();
}

function isGitRepo(dir: string): boolean {
  try {
    git('rev-parse --is-inside-work-tree', dir);
    return true;
  } catch {
    return false;
  }
}

function getCurrentBranch(cwd: string): string {
  try {
    return git('rev-parse --abbrev-ref HEAD', cwd);
  } catch {
    return 'main';
  }
}

function hasUncommittedChanges(cwd: string): boolean {
  try {
    const status = git('status --porcelain', cwd);
    return status.length > 0;
  } catch {
    return false;
  }
}

/**
 * Create an isolated git worktree for an agent to work in.
 * Returns the worktree path and branch name.
 */
export function enterWorktree(
  projectDir: string,
  opts?: { branchPrefix?: string; agentId?: string }
): WorktreeInfo {
  const cwd = resolve(projectDir);
  if (!isGitRepo(cwd)) {
    throw new Error('Not a git repository — cannot create worktree');
  }

  const baseBranch = getCurrentBranch(cwd);
  const prefix = opts?.branchPrefix || 'crew-agent';
  const suffix = (opts?.agentId || randomUUID()).slice(0, 8);
  const branchName = `${prefix}/${suffix}`;

  // Worktrees go in .crew/worktrees/
  const worktreeBase = join(cwd, '.crew', 'worktrees');
  const worktreePath = join(worktreeBase, suffix);

  // Create the worktree with a new branch
  try {
    execSync(`mkdir -p "${worktreeBase}"`, { cwd });
    git(`worktree add -b "${branchName}" "${worktreePath}" HEAD`, cwd);
  } catch (err) {
    throw new Error(`Failed to create worktree: ${err.message}`);
  }

  const info: WorktreeInfo = {
    worktreePath,
    branchName,
    baseBranch,
    createdAt: new Date().toISOString()
  };

  activeWorktrees.set(branchName, info);
  return info;
}

/**
 * Exit a worktree. If changes were made, keeps the branch for merging.
 * If no changes, cleans up the worktree and branch entirely.
 *
 * Returns: { hasChanges, branchName, commitCount }
 */
export async function exitWorktree(
  projectDir: string,
  branchName: string
): Promise<{ hasChanges: boolean; branchName: string; commitCount: number; worktreePath?: string }> {
  const cwd = resolve(projectDir);
  const info = activeWorktrees.get(branchName);

  if (!info) {
    throw new Error(`No active worktree found for branch: ${branchName}`);
  }

  const wt = info.worktreePath;

  // Check if any commits were made on the branch beyond the base
  let commitCount = 0;
  try {
    const log = git(`log ${info.baseBranch}..${branchName} --oneline`, cwd);
    commitCount = log ? log.split('\n').filter(l => l.trim()).length : 0;
  } catch {
    commitCount = 0;
  }

  // Check for uncommitted changes in the worktree
  const uncommitted = existsSync(wt) && hasUncommittedChanges(wt);

  // If uncommitted changes, auto-commit them
  if (uncommitted) {
    try {
      git('add -A', wt);
      git('commit -m "Auto-commit: agent work in progress"', wt);
      commitCount++;
    } catch {
      // Commit failed (maybe nothing to commit after all)
    }
  }

  const hasChanges = commitCount > 0;

  // Remove the worktree
  try {
    git(`worktree remove "${wt}" --force`, cwd);
  } catch {
    // Manual cleanup if git worktree remove fails
    try {
      await rm(wt, { recursive: true, force: true });
      git('worktree prune', cwd);
    } catch { /* best effort */ }
  }

  // If no changes, also delete the branch
  if (!hasChanges) {
    try {
      git(`branch -D "${branchName}"`, cwd);
    } catch { /* branch might not exist */ }
  }

  activeWorktrees.delete(branchName);

  return {
    hasChanges,
    branchName,
    commitCount,
    worktreePath: hasChanges ? wt : undefined
  };
}

/**
 * List all active worktrees.
 */
export function listWorktrees(): WorktreeInfo[] {
  return [...activeWorktrees.values()];
}

/**
 * Merge a worktree branch back into the base branch.
 */
export function mergeWorktree(
  projectDir: string,
  branchName: string,
  strategy: 'merge' | 'squash' = 'squash'
): { success: boolean; message: string } {
  const cwd = resolve(projectDir);

  try {
    if (strategy === 'squash') {
      git(`merge --squash "${branchName}"`, cwd);
      git(`commit -m "Merge agent work from ${branchName}"`, cwd);
    } else {
      git(`merge "${branchName}" --no-edit`, cwd);
    }

    // Clean up the branch after merge
    try {
      git(`branch -D "${branchName}"`, cwd);
    } catch { /* already deleted */ }

    return { success: true, message: `Merged ${branchName} into current branch` };
  } catch (err) {
    return { success: false, message: `Merge failed: ${err.message}` };
  }
}
