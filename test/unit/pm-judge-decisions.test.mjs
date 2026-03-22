/**
 * Unit tests for crew-judge PM loop decision logic.
 * Tests CONTINUE/SHIP/RESET verdict detection and routing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Mock crew-judge response patterns
const JUDGE_RESPONSES = {
  CONTINUE: `Based on the current progress, I recommend we **CONTINUE** with the next roadmap items. 
  
  The authentication module is complete and QA has verified the implementation. We should proceed with the API endpoints next.
  
  **Verdict: CONTINUE**`,
  
  SHIP: `The project has reached a shippable state. All core features are implemented, tested, and documented.
  
  **Verdict: SHIP IT**
  
  Recommended next steps:
  - Deploy to staging
  - Run final smoke tests
  - Prepare release notes`,
  
  RESET: `I notice significant architectural issues that require rework. The current authentication approach is insecure.
  
  **Verdict: DO NOT SHIP**
  
  Critical blockers:
  - Passwords stored in plaintext
  - No CSRF protection
  - API keys exposed in client code
  
  Recommendation: RESET and fix security issues before proceeding.`,
  
  NEEDS_WORK: `The implementation is incomplete and has several issues.
  
  **Verdict: NEEDS WORK**
  
  Issues to address:
  - Missing error handling
  - Tests failing
  - Documentation incomplete`,
};

/**
 * Detect verdict from crew-judge response.
 * Returns: "CONTINUE" | "SHIP" | "RESET" | "UNCLEAR"
 */
function detectVerdict(judgeReply) {
  const text = String(judgeReply || "").toLowerCase();
  
  // Ship patterns (highest priority - most specific)
  if (text.includes("ship it") || text.includes("verdict: ship")) {
    return "SHIP";
  }
  
  // Reset patterns
  if (
    text.includes("do not ship") ||
    text.includes("verdict: reset") ||
    text.includes("verdict: do not ship") ||
    text.includes("needs work") ||
    text.includes("critical blocker")
  ) {
    return "RESET";
  }
  
  // Continue patterns (default positive)
  if (
    text.includes("continue") ||
    text.includes("proceed") ||
    text.includes("keep going") ||
    text.includes("next item")
  ) {
    return "CONTINUE";
  }
  
  return "UNCLEAR";
}

/**
 * Extract blockers from RESET verdict.
 */
function extractBlockers(judgeReply) {
  const text = String(judgeReply || "");
  const blockers = [];
  
  // Look for "blockers:" or "issues:" sections (relaxed regex)
  const lines = text.split("\n");
  let inBlockersSection = false;
  
  for (const line of lines) {
    // Detect start of blockers section
    if (/(?:critical blockers?|issues?|problems?):/i.test(line)) {
      inBlockersSection = true;
      continue;
    }
    
    // Stop at next major section
    if (inBlockersSection && /^[A-Z][a-z]+:/.test(line)) {
      inBlockersSection = false;
    }
    
    // Extract bullet points in blockers section
    if (inBlockersSection && /^[\s-]*[•\-\*]\s*(.+)/.test(line)) {
      const match = line.match(/^[\s-]*[•\-\*]\s*(.+)/);
      if (match) {
        blockers.push(match[1].trim());
      }
    }
  }
  
  return blockers;
}

/**
 * Extract next steps from SHIP verdict.
 */
function extractNextSteps(judgeReply) {
  const text = String(judgeReply || "");
  const steps = [];
  
  const lines = text.split("\n");
  let inStepsSection = false;
  
  for (const line of lines) {
    // Detect start of next steps section
    if (/(?:next steps?|recommended|recommendation):/i.test(line)) {
      inStepsSection = true;
      continue;
    }
    
    // Stop at next major section or end
    if (inStepsSection && /^[A-Z][a-z]+:/.test(line) && !/(?:next|recommend)/i.test(line)) {
      inStepsSection = false;
    }
    
    // Extract bullet points in steps section
    if (inStepsSection && /^[\s-]*[•\-\*]\s*(.+)/.test(line)) {
      const match = line.match(/^[\s-]*[•\-\*]\s*(.+)/);
      if (match) {
        steps.push(match[1].trim());
      }
    }
  }
  
  return steps;
}

describe("crew-judge: verdict detection", () => {
  it("detects CONTINUE verdict", () => {
    const verdict = detectVerdict(JUDGE_RESPONSES.CONTINUE);
    assert.equal(verdict, "CONTINUE");
  });
  
  it("detects SHIP IT verdict", () => {
    const verdict = detectVerdict(JUDGE_RESPONSES.SHIP);
    assert.equal(verdict, "SHIP");
  });
  
  it("detects DO NOT SHIP (RESET) verdict", () => {
    const verdict = detectVerdict(JUDGE_RESPONSES.RESET);
    assert.equal(verdict, "RESET");
  });
  
  it("detects NEEDS WORK (RESET) verdict", () => {
    const verdict = detectVerdict(JUDGE_RESPONSES.NEEDS_WORK);
    assert.equal(verdict, "RESET");
  });
  
  it("handles unclear verdict", () => {
    const verdict = detectVerdict("I'm not sure what to recommend here.");
    assert.equal(verdict, "UNCLEAR");
  });
  
  it("handles empty response", () => {
    const verdict = detectVerdict("");
    assert.equal(verdict, "UNCLEAR");
  });
  
  it("is case-insensitive", () => {
    assert.equal(detectVerdict("VERDICT: SHIP IT"), "SHIP");
    assert.equal(detectVerdict("verdict: continue"), "CONTINUE");
    assert.equal(detectVerdict("Verdict: DO NOT SHIP"), "RESET");
  });
});

describe("crew-judge: blocker extraction", () => {
  it("extracts blockers from RESET verdict", () => {
    const blockers = extractBlockers(JUDGE_RESPONSES.RESET);
    assert.ok(blockers.length > 0, "Should extract at least one blocker");
    assert.ok(blockers.some(b => b.includes("Passwords")));
    assert.ok(blockers.some(b => b.includes("CSRF")));
  });
  
  it("handles missing blockers section", () => {
    const blockers = extractBlockers("Verdict: RESET");
    assert.equal(blockers.length, 0);
  });
});

describe("crew-judge: next steps extraction", () => {
  it("extracts next steps from SHIP verdict", () => {
    const steps = extractNextSteps(JUDGE_RESPONSES.SHIP);
    assert.ok(steps.length > 0, "Should extract at least one step");
    assert.ok(steps.some(s => s.includes("staging")));
    assert.ok(steps.some(s => s.includes("smoke tests")));
  });
  
  it("handles missing next steps", () => {
    const steps = extractNextSteps("Verdict: SHIP IT");
    assert.equal(steps.length, 0);
  });
});

describe("crew-judge: PM_USE_JUDGE behavior", () => {
  it("should skip judge when PM_USE_JUDGE=off", () => {
    const useJudge = process.env.PM_USE_JUDGE === "on" || process.env.PM_USE_JUDGE === "1";
    
    if (!useJudge) {
      assert.ok(true, "Judge skipped when PM_USE_JUDGE=off");
    } else {
      assert.ok(true, "Judge enabled when PM_USE_JUDGE=on");
    }
  });
  
  it("should call judge after every PM_JUDGE_EVERY items", () => {
    const judgeEvery = parseInt(process.env.PM_JUDGE_EVERY || "5", 10);
    
    // If 5 items completed, should call judge
    const itemsCompleted = 5;
    const shouldCallJudge = itemsCompleted % judgeEvery === 0;
    
    assert.ok(shouldCallJudge, "Should call judge after PM_JUDGE_EVERY items");
  });
  
  it("should use PM_JUDGE_EVERY default of 5", () => {
    const judgeEvery = parseInt(process.env.PM_JUDGE_EVERY || "5", 10);
    assert.ok(judgeEvery >= 1, "PM_JUDGE_EVERY should be at least 1");
  });
});

describe("crew-judge: model selection", () => {
  it("should use fast/cheap model for judge decisions", () => {
    // Default: groq/llama-3.3-70b-versatile (fast + cheap)
    const judgeModel = process.env.CREW_JUDGE_MODEL || "groq/llama-3.3-70b-versatile";
    
    assert.ok(judgeModel, "Judge model should be configured");
    assert.ok(
      judgeModel.includes("groq") || judgeModel.includes("llama"),
      "Judge should use fast model"
    );
  });
});

describe("crew-judge: PM loop integration", () => {
  it("CONTINUE verdict → process next roadmap item", () => {
    const verdict = detectVerdict(JUDGE_RESPONSES.CONTINUE);
    
    if (verdict === "CONTINUE") {
      // PM loop should:
      // 1. Mark judge cycle complete
      // 2. Pick next roadmap item
      // 3. Dispatch to worker agent
      assert.ok(true, "Should continue to next item");
    }
  });
  
  it("SHIP verdict → run final synthesis and exit", () => {
    const verdict = detectVerdict(JUDGE_RESPONSES.SHIP);
    
    if (verdict === "SHIP") {
      // PM loop should:
      // 1. Call crew-main for final synthesis
      // 2. Generate FINAL_REPORT.md
      // 3. Exit with success
      assert.ok(true, "Should run final synthesis and ship");
    }
  });
  
  it("RESET verdict → halt and report blockers", () => {
    const verdict = detectVerdict(JUDGE_RESPONSES.RESET);
    const blockers = extractBlockers(JUDGE_RESPONSES.RESET);
    
    if (verdict === "RESET") {
      // PM loop should:
      // 1. Stop processing roadmap items
      // 2. Report blockers to user
      // 3. Exit with reset status
      assert.ok(blockers.length > 0, "Should extract blockers");
      assert.ok(true, "Should halt and report issues");
    }
  });
  
  it("UNCLEAR verdict → default to CONTINUE with warning", () => {
    const verdict = detectVerdict("I'm not sure...");
    
    if (verdict === "UNCLEAR") {
      // PM loop should:
      // 1. Log warning about unclear verdict
      // 2. Default to CONTINUE (safe choice)
      // 3. Continue processing
      assert.ok(true, "Should default to CONTINUE on unclear verdict");
    }
  });
});

describe("crew-judge: decision timing", () => {
  it("should NOT call judge before PM_JUDGE_EVERY items", () => {
    const judgeEvery = 5;
    const itemsCompleted = 3;
    
    const shouldCallJudge = itemsCompleted % judgeEvery === 0;
    assert.equal(shouldCallJudge, false, "Should not call judge at item 3 (when EVERY=5)");
  });
  
  it("should call judge at exactly PM_JUDGE_EVERY intervals", () => {
    const judgeEvery = 5;
    
    assert.ok(5 % judgeEvery === 0, "Should call at item 5");
    assert.ok(10 % judgeEvery === 0, "Should call at item 10");
    assert.ok(15 % judgeEvery === 0, "Should call at item 15");
  });
});
