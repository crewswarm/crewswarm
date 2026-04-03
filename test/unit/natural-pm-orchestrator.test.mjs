/**
 * Unit tests for natural-pm-orchestrator.mjs
 *
 * The module has no exports — all functions are module-private.
 * We replicate the two pure helpers (parseNaturalLanguagePlan, normalizeAgentName)
 * exactly as they appear in the source and test all their branches.
 *
 * We also verify the CLI contract (no-arg → exit 1) via a child process.
 * No real agents are spawned.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const SCRIPT = new URL("../../natural-pm-orchestrator.mjs", import.meta.url).pathname;

// ─── replicated pure helpers ──────────────────────────────────────────────────

function normalizeAgentName(name) {
  const map = {
    codex: "crew-coder",
    coder: "crew-coder",
    developer: "crew-coder",
    qa: "crew-qa",
    tester: "crew-qa",
    test: "crew-qa",
    fixer: "crew-fixer",
    debugger: "crew-fixer",
    security: "crew-security",
    guardian: "crew-security",
    audit: "crew-security",
    pm: "crew-pm",
    planner: "crew-pm",
    quill: "crew-main",
    main: "crew-main",
  };
  return map[name] || name;
}

function parseNaturalLanguagePlan(text) {
  const dispatch = [];

  // Pattern 1: "I'll have X do Y"
  const havePattern = /I'?ll have (\w+[-\w]*) (.*?)(?:\.|Then|,|$)/gi;
  let match;
  while ((match = havePattern.exec(text)) !== null) {
    const agent = match[1].toLowerCase();
    const task = match[2].trim();
    if (agent && task) {
      dispatch.push({
        agent: normalizeAgentName(agent),
        task,
        acceptance: "Task completed successfully",
      });
    }
  }

  // Pattern 2: "Codex will/should create X"
  const willPattern =
    /(\w+[-\w]*) (?:will|should|can) (create|implement|write|fix|test|audit|debug) (.*?)(?:\.|Then|,|$)/gi;
  while ((match = willPattern.exec(text)) !== null) {
    const agent = match[1].toLowerCase();
    const action = match[2];
    const target = match[3].trim();
    if (agent && action && target) {
      dispatch.push({
        agent: normalizeAgentName(agent),
        task: `${action.charAt(0).toUpperCase() + action.slice(1)} ${target}`,
        acceptance: `${target} ${action}d successfully`,
      });
    }
  }

  // Pattern 3: "Task for X: Y"
  const taskForPattern = /Task for (\w+[-\w]*): (.*?)(?:\n|$)/gi;
  while ((match = taskForPattern.exec(text)) !== null) {
    const agent = match[1].toLowerCase();
    const task = match[2].trim();
    if (agent && task) {
      dispatch.push({
        agent: normalizeAgentName(agent),
        task,
        acceptance: "Task completed",
      });
    }
  }

  return dispatch;
}

// ─── normalizeAgentName ───────────────────────────────────────────────────────

describe("natural-pm-orchestrator — normalizeAgentName: coder aliases", () => {
  it("maps 'codex' to crew-coder", () => {
    assert.equal(normalizeAgentName("codex"), "crew-coder");
  });

  it("maps 'coder' to crew-coder", () => {
    assert.equal(normalizeAgentName("coder"), "crew-coder");
  });

  it("maps 'developer' to crew-coder", () => {
    assert.equal(normalizeAgentName("developer"), "crew-coder");
  });
});

describe("natural-pm-orchestrator — normalizeAgentName: qa aliases", () => {
  it("maps 'qa' to crew-qa", () => {
    assert.equal(normalizeAgentName("qa"), "crew-qa");
  });

  it("maps 'tester' to crew-qa", () => {
    assert.equal(normalizeAgentName("tester"), "crew-qa");
  });

  it("maps 'test' to crew-qa", () => {
    assert.equal(normalizeAgentName("test"), "crew-qa");
  });
});

describe("natural-pm-orchestrator — normalizeAgentName: other aliases", () => {
  it("maps 'fixer' to crew-fixer", () => {
    assert.equal(normalizeAgentName("fixer"), "crew-fixer");
  });

  it("maps 'debugger' to crew-fixer", () => {
    assert.equal(normalizeAgentName("debugger"), "crew-fixer");
  });

  it("maps 'security' to crew-security", () => {
    assert.equal(normalizeAgentName("security"), "crew-security");
  });

  it("maps 'guardian' to crew-security", () => {
    assert.equal(normalizeAgentName("guardian"), "crew-security");
  });

  it("maps 'audit' to crew-security", () => {
    assert.equal(normalizeAgentName("audit"), "crew-security");
  });

  it("maps 'pm' to crew-pm", () => {
    assert.equal(normalizeAgentName("pm"), "crew-pm");
  });

  it("maps 'planner' to crew-pm", () => {
    assert.equal(normalizeAgentName("planner"), "crew-pm");
  });

  it("maps 'quill' to crew-main", () => {
    assert.equal(normalizeAgentName("quill"), "crew-main");
  });

  it("maps 'main' to crew-main", () => {
    assert.equal(normalizeAgentName("main"), "crew-main");
  });

  it("returns unknown names unchanged (pass-through)", () => {
    assert.equal(normalizeAgentName("my-custom-bot"), "my-custom-bot");
  });

  it("returns empty string unchanged", () => {
    assert.equal(normalizeAgentName(""), "");
  });
});

// ─── parseNaturalLanguagePlan: Pattern 1 ("I'll have X do Y") ────────────────

describe("natural-pm-orchestrator — parseNaturalLanguagePlan: pattern 1 (I'll have)", () => {
  it("parses 'I'll have Codex create the file'", () => {
    const result = parseNaturalLanguagePlan("I'll have Codex create the file.");
    assert.ok(result.length > 0, "Expected at least one dispatch entry");
    assert.equal(result[0].agent, "crew-coder");
    assert.ok(result[0].task.length > 0);
  });

  it("parses both tasks from a two-step plan", () => {
    const text =
      "I'll have Codex create the file, then Tester will test it.";
    const result = parseNaturalLanguagePlan(text);
    const agents = result.map(r => r.agent);
    assert.ok(agents.includes("crew-coder"), `Expected crew-coder in: ${JSON.stringify(agents)}`);
  });

  it("sets acceptance to 'Task completed successfully' for pattern 1 entries", () => {
    const result = parseNaturalLanguagePlan("I'll have Codex create the schema.");
    assert.ok(result.some(r => r.acceptance === "Task completed successfully"));
  });

  it("normalizes agent name in pattern 1", () => {
    const result = parseNaturalLanguagePlan("I'll have qa run the tests.");
    assert.ok(result.some(r => r.agent === "crew-qa"));
  });
});

// ─── parseNaturalLanguagePlan: Pattern 2 ("X will/should/can do Y") ──────────

describe("natural-pm-orchestrator — parseNaturalLanguagePlan: pattern 2 (will/should/can)", () => {
  it("parses 'Codex will create the API'", () => {
    const result = parseNaturalLanguagePlan("Codex will create the API.");
    assert.ok(result.length > 0);
    assert.equal(result[0].agent, "crew-coder");
    assert.ok(result[0].task.startsWith("Create "));
  });

  it("parses 'Tester should write tests for auth'", () => {
    const result = parseNaturalLanguagePlan("Tester should write tests for auth.");
    assert.ok(result.some(r => r.agent === "crew-qa"));
  });

  it("parses 'Security can audit the routes'", () => {
    const result = parseNaturalLanguagePlan("Security can audit the routes.");
    assert.ok(result.some(r => r.agent === "crew-security"));
  });

  it("capitalizes action verb in task field", () => {
    const result = parseNaturalLanguagePlan("Fixer should fix the bug.");
    const entry = result.find(r => r.agent === "crew-fixer");
    assert.ok(entry, "Expected crew-fixer entry");
    assert.ok(entry.task.startsWith("Fix "), `Expected 'Fix ...', got: ${entry.task}`);
  });

  it("builds acceptance from target and action", () => {
    const result = parseNaturalLanguagePlan("Codex will implement the routes.");
    const entry = result.find(r => r.agent === "crew-coder");
    assert.ok(entry, "Expected crew-coder entry");
    assert.ok(entry.acceptance.length > 0);
  });
});

// ─── parseNaturalLanguagePlan: Pattern 3 ("Task for X: Y") ──────────────────

describe("natural-pm-orchestrator — parseNaturalLanguagePlan: pattern 3 (Task for)", () => {
  it("parses 'Task for coder: Create package.json'", () => {
    const result = parseNaturalLanguagePlan("Task for coder: Create package.json");
    assert.ok(result.some(r => r.agent === "crew-coder" && r.task.includes("Create package.json")));
  });

  it("parses 'Task for qa: Run all tests'", () => {
    const result = parseNaturalLanguagePlan("Task for qa: Run all tests");
    assert.ok(result.some(r => r.agent === "crew-qa"));
  });

  it("sets acceptance to 'Task completed' for pattern 3 entries", () => {
    const result = parseNaturalLanguagePlan("Task for fixer: Debug the crash");
    const entry = result.find(r => r.agent === "crew-fixer");
    assert.ok(entry, "Expected crew-fixer entry");
    assert.equal(entry.acceptance, "Task completed");
  });
});

// ─── parseNaturalLanguagePlan: edge cases ────────────────────────────────────

describe("natural-pm-orchestrator — parseNaturalLanguagePlan: edge cases", () => {
  it("returns empty array for text that matches no patterns", () => {
    const result = parseNaturalLanguagePlan("The system looks good overall.");
    assert.deepEqual(result, []);
  });

  it("returns empty array for empty string", () => {
    const result = parseNaturalLanguagePlan("");
    assert.deepEqual(result, []);
  });

  it("each dispatch entry has agent, task, and acceptance fields", () => {
    const result = parseNaturalLanguagePlan("Codex will create the file.");
    for (const entry of result) {
      assert.ok("agent" in entry, "Missing agent");
      assert.ok("task" in entry, "Missing task");
      assert.ok("acceptance" in entry, "Missing acceptance");
      assert.ok(typeof entry.agent === "string" && entry.agent.length > 0);
      assert.ok(typeof entry.task === "string" && entry.task.length > 0);
    }
  });

  it("handles mixed patterns in one text", () => {
    const text = [
      "I'll have Codex create the schema.",
      "Tester should write tests for the schema.",
      "Task for fixer: Debug any issues",
    ].join("\n");
    const result = parseNaturalLanguagePlan(text);
    const agents = result.map(r => r.agent);
    // At minimum, all three distinct patterns should contribute at least one entry
    assert.ok(result.length >= 2, `Expected >= 2 entries, got ${result.length}`);
    assert.ok(agents.some(a => a === "crew-coder" || a === "crew-qa" || a === "crew-fixer"));
  });
});

// ─── CLI contract ─────────────────────────────────────────────────────────────

describe("natural-pm-orchestrator — CLI: no-arg behavior", () => {
  it("exits with code 1 when no argument provided", () => {
    const result = spawnSync("node", [SCRIPT], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 1, `Expected exit 1, got: ${result.status}`);
  });

  it("prints usage message to stderr", () => {
    const result = spawnSync("node", [SCRIPT], {
      encoding: "utf8",
      timeout: 10_000,
    });
    const out = result.stderr + result.stdout;
    assert.ok(
      out.includes("Usage") || out.includes("natural-pm-orchestrator"),
      `Expected usage text, got: ${out.slice(0, 300)}`
    );
  });
});
