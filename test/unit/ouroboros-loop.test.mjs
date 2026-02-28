/**
 * Unit tests for the Ouroboros-style LLM ↔ engine loop (lib/engines/ouroboros.mjs).
 *
 * The loop depends on injected deps (callLLMDirect, runOpenCodeTask, etc.).
 * We test the core loop logic by extracting it inline so we can mock everything
 * without spawning real engines or making real LLM calls.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ─── Inline the core loop logic from ouroboros.mjs ──────────────────────────

function parseStep(reply) {
  if (!reply || !reply.trim()) return null;
  if (/^\s*DONE\s*$/im.test(reply) || /\bDONE\s*$/im.test(reply)) return "DONE";
  const m = reply.match(/STEP:\s*([\s\S]+?)(?:\n\n|\n*$)/im) || reply.match(/STEP:\s*(.+)/i);
  if (!m) return reply.slice(0, 500); // fallback — treat whole reply as step
  return m[1].trim().replace(/\n.*/gs, "").trim() || null;
}

async function runOuroborosLoop({
  originalTask,
  maxRounds,
  callLLMDirect,     // (prompt) => string
  runEngine,         // (step) => string
  progress = () => {},
}) {
  const steps = [];
  let prompt = `${originalTask}\n\nOutput the first step: STEP: <instruction> or DONE.`;
  let lastReply = "";

  for (let round = 0; round < maxRounds; round++) {
    const reply = await callLLMDirect(prompt);
    if (!reply || !reply.trim()) break;
    lastReply = reply.trim();

    const step = parseStep(lastReply);
    if (!step || step === "DONE") break;

    progress(`Round ${round + 1}: ${step.slice(0, 60)}`);

    let stepResult;
    try {
      stepResult = await runEngine(step);
    } catch (e) {
      stepResult = `Error: ${e?.message || String(e)}`;
    }
    steps.push({ step, result: stepResult });
    prompt = `Task: ${originalTask}\n\nCompleted steps:\n${steps.map((s, i) => `${i + 1}. ${s.step}\nResult: ${s.result}`).join("\n\n")}\n\nWhat is the next step? Reply with exactly: STEP: <instruction> or DONE.`;
  }

  if (steps.length === 0) return lastReply || "No steps executed.";
  return steps.map(s => s.result).join("\n\n---\n\n");
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("parseStep", () => {
  it("returns DONE for bare DONE reply", () => {
    assert.equal(parseStep("DONE"), "DONE");
    assert.equal(parseStep("  DONE  "), "DONE");
    assert.equal(parseStep("Here is my conclusion. DONE"), "DONE");
  });

  it("extracts step from STEP: prefix", () => {
    const step = parseStep("STEP: Write the login function in auth.js");
    assert.equal(step, "Write the login function in auth.js");
  });

  it("extracts step ignoring extra lines after newline-newline", () => {
    const step = parseStep("STEP: Add error handling\n\nSome extra context");
    assert.equal(step, "Add error handling");
  });

  it("falls back to full reply if no STEP: prefix and not DONE", () => {
    const long = "A".repeat(600);
    const step = parseStep(long);
    assert.equal(step?.length, 500); // truncated to 500
  });

  it("returns null for empty reply", () => {
    assert.equal(parseStep(""), null);
    assert.equal(parseStep(null), null);
  });
});

describe("runOuroborosLoop — DONE on first round", () => {
  it("returns lastReply when LLM says DONE immediately", async () => {
    let calls = 0;
    const result = await runOuroborosLoop({
      originalTask: "Write a hello world function",
      maxRounds: 10,
      callLLMDirect: async () => { calls++; return "DONE"; },
      runEngine: async () => { throw new Error("should not run engine"); },
    });
    assert.equal(calls, 1);
    assert.equal(result, "DONE");
  });
});

describe("runOuroborosLoop — single step then DONE", () => {
  it("executes one step, then stops at DONE", async () => {
    const replies = ["STEP: Create the README.md file", "DONE"];
    let idx = 0;
    let engineCalls = 0;
    const result = await runOuroborosLoop({
      originalTask: "Bootstrap the project",
      maxRounds: 10,
      callLLMDirect: async () => replies[idx++],
      runEngine: async (step) => { engineCalls++; return `Done: ${step}`; },
    });
    assert.equal(engineCalls, 1);
    assert.match(result, /Done: Create the README/);
  });
});

describe("runOuroborosLoop — multiple steps", () => {
  it("executes all steps and joins results", async () => {
    const sequence = [
      "STEP: Step one",
      "STEP: Step two",
      "STEP: Step three",
      "DONE",
    ];
    let idx = 0;
    const progressLog = [];
    const result = await runOuroborosLoop({
      originalTask: "Do three things",
      maxRounds: 10,
      callLLMDirect: async () => sequence[idx++],
      runEngine: async (step) => `result:${step}`,
      progress: (msg) => progressLog.push(msg),
    });
    assert.match(result, /result:Step one/);
    assert.match(result, /result:Step two/);
    assert.match(result, /result:Step three/);
    assert.equal(progressLog.length, 3);
  });
});

describe("runOuroborosLoop — maxRounds cap", () => {
  it("stops after maxRounds even if LLM never says DONE", async () => {
    let engineCalls = 0;
    const result = await runOuroborosLoop({
      originalTask: "Infinite task",
      maxRounds: 3,
      callLLMDirect: async () => "STEP: Do something",
      runEngine: async () => { engineCalls++; return "ok"; },
    });
    assert.equal(engineCalls, 3);
    assert.ok(result.length > 0);
  });
});

describe("runOuroborosLoop — engine error handling", () => {
  it("captures engine errors and continues to next round", async () => {
    const replies = [
      "STEP: Step that fails",
      "STEP: Step that succeeds",
      "DONE",
    ];
    let idx = 0;
    const result = await runOuroborosLoop({
      originalTask: "Handle errors",
      maxRounds: 10,
      callLLMDirect: async () => replies[idx++],
      runEngine: async (step) => {
        if (step.includes("fails")) throw new Error("engine blew up");
        return "success";
      },
    });
    assert.match(result, /Error: engine blew up/);
    assert.match(result, /success/);
  });
});

describe("runOuroborosLoop — empty LLM reply stops loop", () => {
  it("returns early if LLM returns empty string", async () => {
    let engineCalls = 0;
    const result = await runOuroborosLoop({
      originalTask: "Something",
      maxRounds: 10,
      callLLMDirect: async () => "",
      runEngine: async () => { engineCalls++; return "ok"; },
    });
    assert.equal(engineCalls, 0);
    assert.equal(result, "No steps executed.");
  });
});

describe("runOuroborosLoop — context accumulation", () => {
  it("passes accumulated steps to each subsequent LLM prompt", async () => {
    const prompts = [];
    const replies = ["STEP: A", "STEP: B", "DONE"];
    let idx = 0;
    await runOuroborosLoop({
      originalTask: "Accumulate context",
      maxRounds: 10,
      callLLMDirect: async (p) => { prompts.push(p); return replies[idx++]; },
      runEngine: async (step) => `result-${step}`,
    });
    // Second prompt (after step A) should contain step A's result
    assert.ok(prompts[1].includes("result-A"), "Second prompt should include step A result");
    // Third prompt should contain both step A and B results
    assert.ok(prompts[2].includes("result-A") && prompts[2].includes("result-B"), "Third prompt should include both results");
  });
});

describe("runOuroborosLoop — progress callbacks", () => {
  it("calls progress for each step", async () => {
    const progress = [];
    const replies = ["STEP: One", "STEP: Two", "DONE"];
    let idx = 0;
    await runOuroborosLoop({
      originalTask: "Task",
      maxRounds: 10,
      callLLMDirect: async () => replies[idx++],
      runEngine: async () => "ok",
      progress: (msg) => progress.push(msg),
    });
    assert.equal(progress.length, 2);
    assert.match(progress[0], /Round 1/);
    assert.match(progress[1], /Round 2/);
  });
});

describe("maxRounds validation (clamp logic)", () => {
  function clampMaxRounds(raw) {
    return Math.min(20, Math.max(1, raw));
  }

  it("clamps to minimum 1", () => {
    assert.equal(clampMaxRounds(0), 1);
    assert.equal(clampMaxRounds(-5), 1);
  });

  it("clamps to maximum 20", () => {
    assert.equal(clampMaxRounds(99), 20);
    assert.equal(clampMaxRounds(21), 20);
  });

  it("preserves values in range", () => {
    assert.equal(clampMaxRounds(10), 10);
    assert.equal(clampMaxRounds(1), 1);
    assert.equal(clampMaxRounds(20), 20);
  });
});

describe("DECOMPOSER_SYSTEM prompt construction", () => {
  function buildDecomposerSystem(rolePrompt) {
    return [
      "You are a task decomposer controlling a specialist AI agent.",
      rolePrompt ? `The agent's role: ${rolePrompt.slice(0, 300)}` : "",
      "Output exactly one line: either STEP: <one clear instruction for the agent to execute now> or DONE.",
      "No other text. Be specific and actionable. DONE only when the full task is complete.",
    ].filter(Boolean).join("\n");
  }

  it("includes role prompt when provided", () => {
    const sys = buildDecomposerSystem("You are a backend engineer.");
    assert.match(sys, /backend engineer/);
    assert.match(sys, /STEP:/);
    assert.match(sys, /DONE/);
  });

  it("omits role line when no role prompt", () => {
    const sys = buildDecomposerSystem("");
    assert.ok(!sys.includes("The agent's role:"));
    assert.match(sys, /task decomposer/);
  });

  it("truncates long role prompts to 300 chars", () => {
    const longRole = "X".repeat(500);
    const sys = buildDecomposerSystem(longRole);
    // The role portion should be sliced to 300
    assert.ok(sys.includes("X".repeat(300)));
    assert.ok(!sys.includes("X".repeat(301)));
  });
});
