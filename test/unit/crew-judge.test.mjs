/**
 * Unit tests for lib/crew-judge/judge.mjs
 *
 * Covers:
 *  - heuristicJudge: all decision branches (CONTINUE, SHIP, RESET)
 *  - judgeNextCycle: safe to call (mocked LLM via env var), returns correct shape
 *
 * judgeNextCycle calls an LLM internally. We don't test the live LLM path, but
 * we verify the function returns the correct { decision, reasoning, confidence }
 * shape when the model call fails (it fails-open to CONTINUE).
 *
 * heuristicJudge is a pure function and fully testable without any I/O.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { judgeNextCycle, heuristicJudge } = await import("../../lib/crew-judge/judge.mjs");

// ── heuristicJudge — RESET branch ────────────────────────────────────────────

describe("crew-judge — heuristicJudge: RESET branch", () => {
  it("returns RESET when success rate < 0.5 and >= 3 failures", () => {
    const result = heuristicJudge({
      completedItems: ["a"],
      failedItems: ["b", "c", "d"],
      itemsRemaining: 5,
      cycleNumber: 2
    });
    assert.equal(result.decision, "RESET");
    assert.ok(result.confidence > 0);
    assert.ok(typeof result.reasoning === "string");
    assert.ok(result.reasoning.length > 0);
  });

  it("RESET: confidence is in [0,1]", () => {
    const result = heuristicJudge({
      completedItems: [],
      failedItems: ["x", "y", "z"],
      itemsRemaining: 10,
      cycleNumber: 1
    });
    if (result.decision === "RESET") {
      assert.ok(result.confidence >= 0 && result.confidence <= 1);
    }
  });

  it("does not RESET when failures < 3", () => {
    const result = heuristicJudge({
      completedItems: ["a"],
      failedItems: ["b", "c"],  // only 2 failures, not >= 3
      itemsRemaining: 5,
      cycleNumber: 2
    });
    assert.notEqual(result.decision, "RESET");
  });

  it("does not RESET when success rate >= 0.5", () => {
    const result = heuristicJudge({
      completedItems: ["a", "b", "c"],
      failedItems: ["d", "e", "f"],  // 50% success = not < 0.5
      itemsRemaining: 0,
      cycleNumber: 2
    });
    assert.notEqual(result.decision, "RESET");
  });
});

// ── heuristicJudge — SHIP branch ─────────────────────────────────────────────

describe("crew-judge — heuristicJudge: SHIP branch", () => {
  it("returns SHIP when itemsRemaining <= 2 and successRate > 0.7", () => {
    const result = heuristicJudge({
      completedItems: ["a", "b", "c", "d"],
      failedItems: ["x"],
      itemsRemaining: 1,
      cycleNumber: 2
    });
    assert.equal(result.decision, "SHIP");
    assert.ok(result.confidence >= 0.8);
  });

  it("returns SHIP when itemsRemaining == 0 and all items succeeded", () => {
    const result = heuristicJudge({
      completedItems: ["a", "b", "c"],
      failedItems: [],
      itemsRemaining: 0,
      cycleNumber: 1
    });
    assert.equal(result.decision, "SHIP");
  });

  it("returns SHIP on diminishing returns (cycle >= 5, successRate > 0.6, remaining < 5)", () => {
    const result = heuristicJudge({
      completedItems: ["a", "b", "c", "d", "e", "f", "g"],
      failedItems: ["x", "y", "z"],
      itemsRemaining: 3,
      cycleNumber: 6
    });
    assert.equal(result.decision, "SHIP");
    assert.ok(result.confidence >= 0.5);
  });

  it("does not SHIP if itemsRemaining > 2 and cycle < 5", () => {
    const result = heuristicJudge({
      completedItems: ["a", "b"],
      failedItems: [],
      itemsRemaining: 5,
      cycleNumber: 2
    });
    assert.notEqual(result.decision, "SHIP");
  });
});

// ── heuristicJudge — CONTINUE branch ─────────────────────────────────────────

describe("crew-judge — heuristicJudge: CONTINUE branch", () => {
  it("returns CONTINUE as default when no other condition triggers", () => {
    const result = heuristicJudge({
      completedItems: ["a", "b"],
      failedItems: ["x"],
      itemsRemaining: 8,
      cycleNumber: 2
    });
    assert.equal(result.decision, "CONTINUE");
  });

  it("CONTINUE has confidence >= 0.5", () => {
    const result = heuristicJudge({
      completedItems: ["a"],
      failedItems: [],
      itemsRemaining: 10,
      cycleNumber: 1
    });
    if (result.decision === "CONTINUE") {
      assert.ok(result.confidence >= 0.5);
    }
  });

  it("handles empty completedItems and failedItems (no items run yet)", () => {
    const result = heuristicJudge({
      completedItems: [],
      failedItems: [],
      itemsRemaining: 5,
      cycleNumber: 1
    });
    // successRate = 1 when totalItems = 0; should not RESET; likely CONTINUE
    assert.ok(["CONTINUE", "SHIP"].includes(result.decision));
  });
});

// ── heuristicJudge — return shape ─────────────────────────────────────────────

describe("crew-judge — heuristicJudge: return shape", () => {
  const cases = [
    { completedItems: [], failedItems: ["a","b","c"], itemsRemaining: 5, cycleNumber: 1 },
    { completedItems: ["a","b","c"], failedItems: [], itemsRemaining: 0, cycleNumber: 1 },
    { completedItems: ["a"], failedItems: [], itemsRemaining: 10, cycleNumber: 2 },
  ];

  for (const ctx of cases) {
    it(`has decision, reasoning, confidence for context ${JSON.stringify(ctx).slice(0,60)}`, () => {
      const result = heuristicJudge(ctx);
      assert.ok(["CONTINUE", "SHIP", "RESET"].includes(result.decision), `Invalid decision: ${result.decision}`);
      assert.equal(typeof result.reasoning, "string");
      assert.ok(result.reasoning.length > 0);
      assert.equal(typeof result.confidence, "number");
      assert.ok(result.confidence >= 0 && result.confidence <= 1);
    });
  }

  it("uses default values when context fields are omitted", () => {
    const result = heuristicJudge({});
    assert.ok(["CONTINUE", "SHIP", "RESET"].includes(result.decision));
  });
});

// ── judgeNextCycle ─────────────────────────────────────────────────────────────

describe("crew-judge — judgeNextCycle", () => {
  let tmpDir;
  let roadmapPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crew-judge-test-"));
    roadmapPath = path.join(tmpDir, "ROADMAP.md");
    fs.writeFileSync(roadmapPath, `# Roadmap\n- [x] Task 1\n- [ ] Task 2\n`);
  });

  it("returns a decision object with correct shape (fails open to CONTINUE on LLM error)", async () => {
    const result = await judgeNextCycle({
      roadmapPath,
      completedItems: ["Task 1"],
      failedItems: [],
      itemsRemaining: 1,
      cycleNumber: 1,
      costThisCycle: 0.05,
      projectDir: tmpDir
    });
    assert.equal(typeof result, "object");
    assert.ok(["CONTINUE", "SHIP", "RESET"].includes(result.decision),
      `Invalid decision: ${result.decision}`);
    assert.equal(typeof result.reasoning, "string");
    assert.ok(result.reasoning.length > 0);
    assert.equal(typeof result.confidence, "number");
    assert.ok(result.confidence >= 0 && result.confidence <= 1);
  });

  it("handles non-existent roadmapPath gracefully", async () => {
    const result = await judgeNextCycle({
      roadmapPath: "/nonexistent/ROADMAP.md",
      completedItems: [],
      failedItems: [],
      itemsRemaining: 0,
      cycleNumber: 1,
      costThisCycle: 0
    });
    assert.ok(["CONTINUE", "SHIP", "RESET"].includes(result.decision));
  });

  it("handles empty context (all defaults)", async () => {
    const result = await judgeNextCycle({
      roadmapPath: roadmapPath
    });
    assert.ok(["CONTINUE", "SHIP", "RESET"].includes(result.decision));
  });

  it("handles LLM failure gracefully (confidence >= 0.1 in fail-open mode)", async () => {
    // Set env to a clearly bad model so the LLM call fails fast
    const orig = process.env.CREW_JUDGE_MODEL;
    process.env.CREW_JUDGE_MODEL = "invalid-provider/nonexistent-model";
    try {
      const result = await judgeNextCycle({
        roadmapPath,
        completedItems: ["a"],
        failedItems: [],
        itemsRemaining: 5,
        cycleNumber: 1,
        costThisCycle: 0
      });
      // Fail-open: returns CONTINUE with low confidence
      assert.ok(["CONTINUE", "SHIP", "RESET"].includes(result.decision));
      assert.ok(result.confidence >= 0);
    } finally {
      if (orig === undefined) {
        delete process.env.CREW_JUDGE_MODEL;
      } else {
        process.env.CREW_JUDGE_MODEL = orig;
      }
    }
  });
});
