/**
 * Git worktree isolation helpers for parallel wave dispatch.
 * Each agent in a multi-agent wave gets its own git worktree so they can't
 * conflict with each other on the filesystem.
 *
 * All operations are wrapped in try/catch — if git fails, callers fall back
 * to the shared directory.
 */

import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

// ── Naming helpers ───────────────────────────────────────────────────────────

/**
 * Return the deterministic worktree path for an agent in a pipeline wave.
 * Format: /tmp/crewswarm-wt-{pipelineId.slice(0,8)}-{agentId}
 */
export function worktreePath(pipelineId, agentId) {
  return `/tmp/crewswarm-wt-${pipelineId.slice(0, 8)}-${agentId}`;
}

/**
 * Return the deterministic branch name for an agent in a pipeline wave.
 * Format: crewswarm/wave-{pipelineId.slice(0,8)}-{agentId}
 */
export function worktreeBranch(pipelineId, agentId) {
  return `crewswarm/wave-${pipelineId.slice(0, 8)}-${agentId}`;
}

// ── Core helpers ─────────────────────────────────────────────────────────────

/**
 * Check if a directory is inside a git repository.
 * Returns true if git reports it is inside a work tree, false otherwise.
 */
export function isGitRepo(dir) {
  try {
    const result = execSync("git rev-parse --is-inside-work-tree", {
      cwd: dir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim();
    return result === "true";
  } catch {
    return false;
  }
}

/**
 * Create a git worktree for an agent's wave task.
 *
 * @param {string} projectDir - The shared project directory (must be a git repo).
 * @param {string} pipelineId - The pipeline ID (used for naming).
 * @param {number} waveIndex  - The zero-based wave index (informational, used in logs).
 * @param {string} agentId    - The agent ID (used for naming).
 * @returns {string|null} The worktree path, or null if git isn't available or
 *                        projectDir isn't a git repo.
 */
export function createWorktree(projectDir, pipelineId, waveIndex, agentId) {
  try {
    if (!projectDir || !isGitRepo(projectDir)) {
      console.log(`[worktree] ${agentId}: projectDir is not a git repo — skipping worktree`);
      return null;
    }

    const wtPath = worktreePath(pipelineId, agentId);
    const branch = worktreeBranch(pipelineId, agentId);

    // Remove stale worktree at the same path if it exists (e.g. crashed previous run).
    if (fs.existsSync(wtPath)) {
      console.log(`[worktree] ${agentId}: stale worktree found at ${wtPath} — removing`);
      try {
        execSync(`git worktree remove --force "${wtPath}"`, {
          cwd: projectDir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 10000,
        });
      } catch {
        // If git worktree remove fails, try cleaning up the directory directly.
        try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch {}
      }
      // Also delete the branch if it was left dangling.
      try {
        execSync(`git branch -D "${branch}"`, {
          cwd: projectDir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000,
        });
      } catch {}
    }

    // Create the worktree on a new branch forked from the current HEAD.
    execSync(`git worktree add -b "${branch}" "${wtPath}" HEAD`, {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15000,
    });

    console.log(`[worktree] wave ${waveIndex + 1} ${agentId}: created worktree at ${wtPath} (branch: ${branch})`);
    return wtPath;
  } catch (e) {
    console.error(`[worktree] ${agentId}: failed to create worktree — ${e.message}`);
    return null;
  }
}

/**
 * Merge a worktree branch back into the current branch (usually main/HEAD) and
 * clean up the worktree + branch.
 *
 * @param {string} projectDir - The shared project directory.
 * @param {string} pipelineId - The pipeline ID.
 * @param {number} waveIndex  - The zero-based wave index (informational).
 * @param {string} agentId    - The agent ID.
 * @returns {{ ok: boolean, conflicts?: string[], merged_files?: string[] }}
 */
export function mergeWorktree(projectDir, pipelineId, waveIndex, agentId) {
  const wtPath = worktreePath(pipelineId, agentId);
  const branch = worktreeBranch(pipelineId, agentId);

  // If the worktree path doesn't even exist, nothing to do.
  if (!fs.existsSync(wtPath)) {
    console.log(`[worktree] ${agentId}: worktree at ${wtPath} not found — skipping merge`);
    return { ok: true, merged_files: [] };
  }

  try {
    // Collect files that changed in the worktree branch vs the shared repo HEAD
    // so we can report them even if the merge is a no-op.
    let mergedFiles = [];
    try {
      const diffOutput = execSync(`git diff --name-only HEAD "${branch}"`, {
        cwd: projectDir,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10000,
      }).trim();
      mergedFiles = diffOutput ? diffOutput.split("\n").filter(Boolean) : [];
    } catch {}

    // Perform the merge (--no-ff to keep history readable).
    execSync(`git merge --no-ff -m "crewswarm: merge wave ${waveIndex + 1} ${agentId}" "${branch}"`, {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    });

    console.log(`[worktree] wave ${waveIndex + 1} ${agentId}: merged ${mergedFiles.length} file(s) from ${branch}`);
    _cleanupWorktree(projectDir, wtPath, branch);
    return { ok: true, merged_files: mergedFiles };
  } catch (e) {
    // Check if it's a merge conflict.
    const isConflict = /CONFLICT|Automatic merge failed/i.test(e.message || "");
    if (isConflict) {
      // Collect conflict file names.
      let conflicts = [];
      try {
        const conflictOutput = execSync("git diff --name-only --diff-filter=U", {
          cwd: projectDir,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 5000,
        }).trim();
        conflicts = conflictOutput ? conflictOutput.split("\n").filter(Boolean) : [];
      } catch {}

      // Abort the merge so the repo stays clean.
      try {
        execSync("git merge --abort", {
          cwd: projectDir,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 10000,
        });
      } catch {}

      console.error(`[worktree] wave ${waveIndex + 1} ${agentId}: merge conflicts in ${conflicts.length} file(s): ${conflicts.join(", ")}`);
      _cleanupWorktree(projectDir, wtPath, branch);
      return { ok: false, conflicts };
    }

    // Other error — still attempt cleanup.
    console.error(`[worktree] ${agentId}: merge failed — ${e.message}`);
    _cleanupWorktree(projectDir, wtPath, branch);
    return { ok: false, conflicts: [] };
  }
}

/**
 * Clean up all worktrees for a pipeline (called on pipeline completion or cancellation).
 *
 * @param {string} projectDir - The shared project directory.
 * @param {string} pipelineId - The pipeline ID whose worktrees should be removed.
 */
export function cleanupPipelineWorktrees(projectDir, pipelineId) {
  const prefix = `/tmp/crewswarm-wt-${pipelineId.slice(0, 8)}-`;
  const branchPrefix = `crewswarm/wave-${pipelineId.slice(0, 8)}-`;

  // Find all matching worktree paths under /tmp.
  let wtDirs = [];
  try {
    wtDirs = fs.readdirSync("/tmp")
      .filter(name => name.startsWith(`crewswarm-wt-${pipelineId.slice(0, 8)}-`))
      .map(name => path.join("/tmp", name));
  } catch {}

  for (const wtPath of wtDirs) {
    // Derive the agentId from the path suffix after the pipeline prefix.
    const agentId = wtPath.slice(prefix.length);
    const branch = `${branchPrefix}${agentId}`;
    _cleanupWorktree(projectDir, wtPath, branch);
  }

  if (wtDirs.length > 0) {
    console.log(`[worktree] pipeline ${pipelineId.slice(0, 8)}: cleaned up ${wtDirs.length} worktree(s)`);
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Remove a worktree directory and delete its tracking branch.
 * Silently ignores errors so callers always continue.
 */
function _cleanupWorktree(projectDir, wtPath, branch) {
  // git worktree remove
  if (fs.existsSync(wtPath)) {
    try {
      execSync(`git worktree remove --force "${wtPath}"`, {
        cwd: projectDir,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10000,
      });
      console.log(`[worktree] removed worktree at ${wtPath}`);
    } catch (e) {
      // Last resort: rm -rf the directory.
      console.warn(`[worktree] git worktree remove failed for ${wtPath} — ${e.message}; falling back to rm`);
      try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch {}
    }
  }

  // Delete the branch.
  if (projectDir && branch) {
    try {
      execSync(`git branch -D "${branch}"`, {
        cwd: projectDir,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      });
      console.log(`[worktree] deleted branch ${branch}`);
    } catch {
      // Branch may already be gone — that's fine.
    }
  }
}
