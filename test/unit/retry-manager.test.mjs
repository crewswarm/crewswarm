/**
 * Unit tests for lib/crew-lead/retry-manager.mjs
 *
 * Covers:
 *  - shouldRetryQuestion: detects question patterns, respects max retries
 *  - shouldRetryPlan: detects plan-only output from coder agents
 *  - shouldRetryBail: detects bail-out / incomplete responses
 *  - getRetryStats: returns aggregate retry statistics
 *  - resetRetries: clears counters for a given taskId
 *  - checkRetries: checks all conditions in priority order
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  shouldRetryQuestion,
  shouldRetryPlan,
  shouldRetryBail,
  getRetryStats,
  resetRetries,
  checkRetries,
} from "../../lib/crew-lead/retry-manager.mjs";

// ── Helpers ────────────────────────────────────────────────────────────────

let taskCounter = 0;
function freshTaskId() {
  return `test-task-${++taskCounter}-${Date.now()}`;
}

// ── shouldRetryQuestion ────────────────────────────────────────────────────

describe("retry-manager — shouldRetryQuestion", () => {
  it("returns shouldRetry: true when content asks a question", () => {
    const taskId = freshTaskId();
    const result = shouldRetryQuestion(taskId, "Would you like me to proceed with the implementation?");
    assert.equal(result.shouldRetry, true);
    assert.equal(result.reason, "question");
    assert.ok(result.retryPrompt.length > 0);
  });

  it("returns shouldRetry: false when content contains work markers", () => {
    const taskId = freshTaskId();
    const result = shouldRetryQuestion(taskId, "Would you like me to proceed? @@WRITE_FILE foo.js done.");
    assert.equal(result.shouldRetry, false);
  });

  it("returns shouldRetry: false for content without question patterns", () => {
    const taskId = freshTaskId();
    const result = shouldRetryQuestion(taskId, "Here is the implementation of the feature.");
    assert.equal(result.shouldRetry, false);
  });

  it("detects 'shall i' pattern", () => {
    const taskId = freshTaskId();
    const result = shouldRetryQuestion(taskId, "Shall I refactor this module?");
    assert.equal(result.shouldRetry, true);
  });

  it("detects 'please confirm' pattern", () => {
    const taskId = freshTaskId();
    const result = shouldRetryQuestion(taskId, "Please confirm this is the right approach.");
    assert.equal(result.shouldRetry, true);
  });

  it("stops retrying after MAX_RETRIES_PER_TASK (2) attempts", () => {
    const taskId = freshTaskId();
    const r1 = shouldRetryQuestion(taskId, "Should I proceed?");
    assert.equal(r1.shouldRetry, true);
    const r2 = shouldRetryQuestion(taskId, "Do you want me to continue?");
    assert.equal(r2.shouldRetry, true);
    const r3 = shouldRetryQuestion(taskId, "Shall I start?");
    assert.equal(r3.shouldRetry, false, "third attempt should be blocked");
  });
});

// ── shouldRetryPlan ────────────────────────────────────────────────────────

describe("retry-manager — shouldRetryPlan", () => {
  it("returns shouldRetry: true for a coder agent that returned a plan", () => {
    const taskId = freshTaskId();
    const longPlan = "Here's the implementation plan.\n" + "## Implementation Plan\n" + "Step 1...\n".repeat(50);
    const result = shouldRetryPlan(taskId, "crew-coder", longPlan);
    assert.equal(result.shouldRetry, true);
    assert.equal(result.reason, "plan");
  });

  it("returns shouldRetry: false for a non-coder agent", () => {
    const taskId = freshTaskId();
    const longPlan = "Here's the plan.\n## Plan\n" + "Step...\n".repeat(50);
    const result = shouldRetryPlan(taskId, "crew-lead", longPlan);
    assert.equal(result.shouldRetry, false);
  });

  it("returns shouldRetry: false when content contains work markers", () => {
    const taskId = freshTaskId();
    const content = "## Overview\n" + "Details...\n".repeat(50) + "\n@@WRITE_FILE index.js done.";
    const result = shouldRetryPlan(taskId, "crew-coder", content);
    assert.equal(result.shouldRetry, false);
  });

  it("returns shouldRetry: false for short content (under 300 chars)", () => {
    const taskId = freshTaskId();
    const result = shouldRetryPlan(taskId, "crew-coder", "## Plan\nShort.");
    assert.equal(result.shouldRetry, false);
  });

  it("detects crew-frontend as a coder agent", () => {
    const taskId = freshTaskId();
    const longPlan = "Here's the design.\n## Design\n" + "Component...\n".repeat(50);
    const result = shouldRetryPlan(taskId, "crew-frontend", longPlan);
    assert.equal(result.shouldRetry, true);
  });

  it("stops retrying after MAX_RETRIES_PER_TASK (2) attempts", () => {
    const taskId = freshTaskId();
    const plan = "Here's what I'll do.\n## Approach\n" + "Step...\n".repeat(50);
    shouldRetryPlan(taskId, "crew-coder", plan);
    shouldRetryPlan(taskId, "crew-coder", plan);
    const r3 = shouldRetryPlan(taskId, "crew-coder", plan);
    assert.equal(r3.shouldRetry, false, "third plan retry should be blocked");
  });
});

// ── shouldRetryBail ────────────────────────────────────────────────────────

describe("retry-manager — shouldRetryBail", () => {
  it("returns shouldRetry: true for bail-out language", () => {
    const taskId = freshTaskId();
    const result = shouldRetryBail(taskId, "I'm sorry, but I couldn't complete the task due to context limit.");
    assert.equal(result.shouldRetry, true);
    assert.equal(result.reason, "bail");
  });

  it("detects 'unable to' pattern", () => {
    const taskId = freshTaskId();
    const result = shouldRetryBail(taskId, "I'm unable to finish the remaining items.");
    assert.equal(result.shouldRetry, true);
  });

  it("detects 'partially complete' pattern", () => {
    const taskId = freshTaskId();
    const result = shouldRetryBail(taskId, "The task is partially complete, not all changes were applied.");
    assert.equal(result.shouldRetry, true);
  });

  it("returns shouldRetry: false for normal completion", () => {
    const taskId = freshTaskId();
    const result = shouldRetryBail(taskId, "All files have been updated and tests pass.");
    assert.equal(result.shouldRetry, false);
  });

  it("stops retrying after MAX_RETRIES_PER_TASK (2) attempts", () => {
    const taskId = freshTaskId();
    shouldRetryBail(taskId, "I couldn't complete the task.");
    shouldRetryBail(taskId, "I was unable to finish.");
    const r3 = shouldRetryBail(taskId, "I couldn't complete it again.");
    assert.equal(r3.shouldRetry, false, "third bail retry should be blocked");
  });
});

// ── getRetryStats ──────────────────────────────────────────────────────────

describe("retry-manager — getRetryStats", () => {
  it("returns stats with totalTasks and byReason", () => {
    const stats = getRetryStats();
    assert.equal(typeof stats.totalTasks, "number");
    assert.equal(typeof stats.byReason, "object");
    assert.equal(typeof stats.byReason.questions, "number");
    assert.equal(typeof stats.byReason.plans, "number");
    assert.equal(typeof stats.byReason.bails, "number");
  });

  it("reflects accumulated retries across tasks", () => {
    const t1 = freshTaskId();
    const t2 = freshTaskId();
    shouldRetryQuestion(t1, "Should I proceed?");
    shouldRetryBail(t2, "I couldn't complete the task.");

    const stats = getRetryStats();
    assert.ok(stats.byReason.questions >= 1);
    assert.ok(stats.byReason.bails >= 1);
  });
});

// ── resetRetries ───────────────────────────────────────────────────────────

describe("retry-manager — resetRetries", () => {
  it("clears retry counters for a task, allowing retries again", () => {
    const taskId = freshTaskId();
    // Exhaust question retries
    shouldRetryQuestion(taskId, "Should I?");
    shouldRetryQuestion(taskId, "Shall I?");
    const blocked = shouldRetryQuestion(taskId, "May I?");
    assert.equal(blocked.shouldRetry, false);

    // Reset
    resetRetries(taskId);

    // Should be able to retry again
    const after = shouldRetryQuestion(taskId, "Can I proceed?");
    assert.equal(after.shouldRetry, true);
  });

  it("does not throw for an unknown taskId", () => {
    assert.doesNotThrow(() => resetRetries("never-existed"));
  });
});

// ── checkRetries ───────────────────────────────────────────────────────────

describe("retry-manager — checkRetries", () => {
  it("returns shouldRetry: false for clean completion", () => {
    const taskId = freshTaskId();
    const result = checkRetries(taskId, "crew-coder", "All done. @@WRITE_FILE foo.js created files.");
    assert.equal(result.shouldRetry, false);
  });

  it("prioritizes bail over plan over question", () => {
    const taskId = freshTaskId();
    // Content that matches both bail and question
    const content = "I'm sorry, but I couldn't complete it. Would you like me to try again?";
    const result = checkRetries(taskId, "crew-coder", content);
    assert.equal(result.reason, "bail", "bail should take priority");
  });
});
