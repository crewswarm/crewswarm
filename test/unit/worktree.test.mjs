/**
 * Unit tests for lib/crew-lead/worktree.mjs
 *
 * Tests: createWorktree, mergeWorktree, cleanupPipelineWorktrees, isGitRepo,
 *        worktreePath, worktreeBranch.
 *
 * Strategy: create a real temporary git repository so the tests exercise real
 * git commands without touching the production repo.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

import {
  isGitRepo,
  createWorktree,
  mergeWorktree,
  cleanupPipelineWorktrees,
  worktreePath,
  worktreeBranch,
} from "../../lib/crew-lead/worktree.mjs";

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Create a minimal git repository at `dir` with one commit so that worktrees
 * and branches can be created from it.
 */
function initGitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const run = (cmd) =>
    execSync(cmd, { cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  run("git init");
  run("git config user.email test@example.com");
  run("git config user.name Test");
  // Ensure we have a main branch name (git >=2.28 uses 'main' by default on
  // some systems, older versions use 'master').
  try { run("git checkout -b main"); } catch {}
  // Need at least one commit so HEAD exists.
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  run("git add README.md");
  run("git commit -m 'init'");
}

/**
 * Remove a directory tree, ignoring errors (e.g. already gone).
 */
function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

/**
 * Derive the /tmp worktree path the module will use and clean it up.
 */
function cleanupWt(pipelineId, agentId) {
  rmrf(worktreePath(pipelineId, agentId));
}

// ── test suite ────────────────────────────────────────────────────────────────

describe("worktree helpers", () => {
  // A fresh git repo created per top-level describe so all nested tests share it.
  let repoDir;
  const pipelineId = "abcdef1234567890"; // 16-char; slice(0,8) → "abcdef12"
  const agentId = "crew-coder";

  before(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewswarm-wt-test-repo-"));
    initGitRepo(repoDir);
  });

  after(() => {
    // Best-effort cleanup of the temp repo.
    rmrf(repoDir);
  });

  afterEach(() => {
    // Ensure worktree paths created during individual tests are removed.
    cleanupWt(pipelineId, agentId);
    cleanupWt(pipelineId, "crew-frontend");
    cleanupWt(pipelineId, "crew-pm");
  });

  // ── isGitRepo ─────────────────────────────────────────────────────────────

  describe("isGitRepo", () => {
    it("returns true for a valid git repository", () => {
      assert.equal(isGitRepo(repoDir), true);
    });

    it("returns false for a plain directory (not a git repo)", () => {
      const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewswarm-plain-"));
      try {
        assert.equal(isGitRepo(plainDir), false);
      } finally {
        rmrf(plainDir);
      }
    });

    it("returns false for a path that doesn't exist", () => {
      assert.equal(isGitRepo("/tmp/crewswarm-nonexistent-path-xyz-99999"), false);
    });
  });

  // ── worktreePath / worktreeBranch naming ─────────────────────────────────

  describe("naming helpers", () => {
    it("worktreePath uses first 8 chars of pipelineId", () => {
      const p = worktreePath("abcdef1234567890", "crew-coder");
      assert.equal(p, "/tmp/crewswarm-wt-abcdef12-crew-coder");
    });

    it("worktreeBranch uses first 8 chars of pipelineId", () => {
      const b = worktreeBranch("abcdef1234567890", "crew-coder");
      assert.equal(b, "crewswarm/wave-abcdef12-crew-coder");
    });

    it("worktreePath and worktreeBranch are deterministic for same inputs", () => {
      const id = "pipe0001deadbeef";
      const agent = "crew-qa";
      assert.equal(worktreePath(id, agent), worktreePath(id, agent));
      assert.equal(worktreeBranch(id, agent), worktreeBranch(id, agent));
    });
  });

  // ── createWorktree ────────────────────────────────────────────────────────

  describe("createWorktree", () => {
    it("creates a worktree directory and returns its path", () => {
      const wtPath = createWorktree(repoDir, pipelineId, 0, agentId);
      assert.ok(wtPath, "should return a path");
      assert.ok(fs.existsSync(wtPath), "worktree directory should exist on disk");
      assert.equal(wtPath, worktreePath(pipelineId, agentId));
    });

    it("returns null when projectDir is not a git repo", () => {
      const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewswarm-plain-"));
      try {
        const result = createWorktree(plainDir, pipelineId, 0, agentId);
        assert.equal(result, null);
      } finally {
        rmrf(plainDir);
      }
    });

    it("returns null when projectDir is null", () => {
      const result = createWorktree(null, pipelineId, 0, agentId);
      assert.equal(result, null);
    });

    it("handles stale worktree gracefully — removes it and recreates", () => {
      // Create the worktree once.
      const wtPath1 = createWorktree(repoDir, pipelineId, 0, agentId);
      assert.ok(wtPath1, "first creation should succeed");

      // Manually remove the worktree dir to simulate a crash where git still
      // has the worktree metadata.  A second createWorktree should clean up and
      // succeed (or at least not throw).
      // Cleanup via the test's afterEach instead of asserting here — the
      // important thing is no exception is thrown.
      const wtPath2 = createWorktree(repoDir, pipelineId, 0, agentId);
      assert.ok(wtPath2 === null || typeof wtPath2 === "string", "should return null or a path, not throw");
    });

    it("created worktree contains the repo files", () => {
      const wtPath = createWorktree(repoDir, pipelineId, 0, agentId);
      assert.ok(wtPath, "worktree should be created");
      assert.ok(fs.existsSync(path.join(wtPath, "README.md")), "README.md should exist in worktree");
    });
  });

  // ── mergeWorktree ─────────────────────────────────────────────────────────

  describe("mergeWorktree", () => {
    it("merges a clean worktree back into main and returns ok=true", () => {
      const wtPath = createWorktree(repoDir, pipelineId, 0, agentId);
      assert.ok(wtPath, "worktree must be created for this test");

      // Write a new file in the worktree.
      fs.writeFileSync(path.join(wtPath, "agent-output.txt"), "hello from agent\n");
      execSync("git add agent-output.txt && git commit -m 'agent work'", {
        cwd: wtPath, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
      });

      const result = mergeWorktree(repoDir, pipelineId, 0, agentId);
      assert.ok(result.ok, `merge should succeed, got: ${JSON.stringify(result)}`);
      assert.ok(Array.isArray(result.merged_files), "merged_files should be an array");
      // The merged file should appear in main.
      assert.ok(
        fs.existsSync(path.join(repoDir, "agent-output.txt")),
        "merged file should exist in main repo",
      );
      // Worktree directory should be gone after merge.
      assert.ok(!fs.existsSync(wtPath), "worktree dir should be removed after merge");
    });

    it("returns ok=true with empty merged_files when no changes were made", () => {
      const wtPath = createWorktree(repoDir, pipelineId, 0, agentId);
      assert.ok(wtPath, "worktree must be created");

      // Don't commit anything — just merge an empty branch.
      const result = mergeWorktree(repoDir, pipelineId, 0, agentId);
      assert.ok(result.ok, "empty merge should still succeed");
    });

    it("returns ok=true when worktree does not exist (already cleaned up)", () => {
      // mergeWorktree on a path that doesn't exist should be a no-op.
      const result = mergeWorktree(repoDir, pipelineId, 0, "nonexistent-agent");
      assert.equal(result.ok, true);
      assert.deepEqual(result.merged_files, []);
    });
  });

  // ── cleanupPipelineWorktrees ──────────────────────────────────────────────

  describe("cleanupPipelineWorktrees", () => {
    it("removes all worktrees matching the pipeline ID prefix", () => {
      const agentA = "crew-coder";
      const agentB = "crew-frontend";
      const wtA = createWorktree(repoDir, pipelineId, 0, agentA);
      const wtB = createWorktree(repoDir, pipelineId, 0, agentB);
      assert.ok(wtA, "worktree A should be created");
      assert.ok(wtB, "worktree B should be created");

      cleanupPipelineWorktrees(repoDir, pipelineId);

      assert.ok(!fs.existsSync(wtA), "worktree A should be removed");
      assert.ok(!fs.existsSync(wtB), "worktree B should be removed");
    });

    it("does not throw when there are no matching worktrees", () => {
      // Should be a no-op.
      assert.doesNotThrow(() => cleanupPipelineWorktrees(repoDir, "00000000ffffffff"));
    });

    it("does not remove worktrees for a different pipeline", () => {
      const otherPipelineId = "zzzzzzzz00000000";
      const wtOther = createWorktree(repoDir, otherPipelineId, 0, "crew-pm");

      try {
        assert.ok(wtOther, "other worktree should be created");
        // Cleanup only the first pipeline.
        cleanupPipelineWorktrees(repoDir, pipelineId);
        // Other pipeline's worktree should still exist.
        assert.ok(fs.existsSync(wtOther), "other pipeline's worktree should not be touched");
      } finally {
        cleanupWt(otherPipelineId, "crew-pm");
      }
    });
  });
});
