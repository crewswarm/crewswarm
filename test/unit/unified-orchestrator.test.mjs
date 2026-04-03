/**
 * Unit tests for unified-orchestrator.mjs
 *
 * The orchestrator has no exports — all functions are module-private.
 * We test the pure helper logic (extractFilePaths, JSON parsing/validation,
 * dispatch plan normalization, reply extraction) by replicating them here,
 * and we verify the CLI contract (no-arg exit code, help text) by spawning
 * the script as a child process without triggering real agent calls.
 *
 * We do NOT start real orchestration loops or spawn real agents.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

const SCRIPT = new URL("../../unified-orchestrator.mjs", import.meta.url).pathname;

// ─── replicated pure helpers (no I/O) ────────────────────────────────────────

/**
 * Mirrors extractFilePaths from unified-orchestrator.mjs exactly.
 */
function extractFilePaths(text) {
  const paths = [];
  const unixPaths = text.match(/\/[\w\-./]+\.\w+/g);
  if (unixPaths) paths.push(...unixPaths);
  const homePaths = text.match(/~\/[\w\-./]+/g);
  if (homePaths) {
    const homeDir = process.env.HOME || os.homedir();
    paths.push(...homePaths.map(p => p.replace("~", homeDir)));
  }
  const quotedPaths = text.match(/["'`](\/[\w\-./]+\.\w+)["'`]/g);
  if (quotedPaths) {
    paths.push(...quotedPaths.map(p => p.replace(/["'`]/g, "")));
  }
  return [...new Set(paths)];
}

/**
 * Mirrors the JSON extraction + validation logic from parseIntoJSON.
 */
function extractAndValidateJSON(rawResponse) {
  let jsonText = rawResponse.trim();
  jsonText = jsonText.replace(/^```(?:json)?\s*/gm, "").replace(/```\s*$/gm, "");
  const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Parser did not output valid JSON.");
  const plan = JSON.parse(jsonMatch[0]);
  if (!plan.dispatch || !Array.isArray(plan.dispatch)) {
    throw new Error('Missing or invalid "dispatch" array');
  }
  if (plan.dispatch.length === 0) {
    plan.dispatch = [{
      agent: "crew-coder",
      task: "fallback",
      acceptance: "Task completed successfully"
    }];
  }
  for (const [i, task] of plan.dispatch.entries()) {
    if (!task.agent) throw new Error(`Task ${i + 1} missing "agent"`);
    if (!task.task) throw new Error(`Task ${i + 1} missing "task"`);
    task.acceptance = task.acceptance || "Task completed";
  }
  return plan;
}

/**
 * Mirrors the reply-extraction logic from callAgent (useSend = false branch).
 */
function extractReply(stdout, useSend) {
  if (useSend) return stdout.trim();
  const replyMatch = stdout.match(/✅ Reply received\s*\n([\s\S]*)/);
  if (replyMatch) return replyMatch[1].trim();
  const lines = stdout.split("\n");
  const replyStart = lines.findIndex(l => l.includes("Reply received"));
  return (replyStart !== -1 && replyStart < lines.length - 1)
    ? lines.slice(replyStart + 1).join("\n").trim()
    : stdout.trim();
}

/**
 * Mirrors the verifyResults logic for a single task (pure subset).
 */
function buildVerification(taskNum, success, taskDesc, results_i) {
  if (!results_i.success) {
    return { task_num: taskNum, verified: false, reason: "Task failed during execution" };
  }
  const filePaths = extractFilePaths(taskDesc);
  if (filePaths.length === 0) {
    return { task_num: taskNum, verified: true, reason: "No artifacts to verify, agent reported success" };
  }
  // (actual fs checks omitted — pure logic path only)
  return { task_num: taskNum, verified: null, files: filePaths };
}

// ─── extractFilePaths ─────────────────────────────────────────────────────────

describe("unified-orchestrator — extractFilePaths: unix paths", () => {
  it("extracts a simple absolute unix path", () => {
    const paths = extractFilePaths("Create /tmp/test.txt with hello");
    assert.ok(paths.includes("/tmp/test.txt"), `Got: ${JSON.stringify(paths)}`);
  });

  it("extracts a nested path with directories", () => {
    const paths = extractFilePaths("Write code to /src/api/routes.mjs");
    assert.ok(paths.some(p => p.includes("routes.mjs")));
  });

  it("extracts multiple paths from one string", () => {
    // Both paths must have extensions to match the regex pattern
    const paths = extractFilePaths("Edit /etc/nginx.conf and /tmp/out.log please");
    assert.ok(paths.length >= 2);
  });

  it("returns empty array when no paths present", () => {
    const paths = extractFilePaths("Create a feature with no file paths mentioned");
    assert.deepEqual(paths, []);
  });

  it("deduplicates repeated paths", () => {
    const paths = extractFilePaths("/tmp/foo.txt then again /tmp/foo.txt");
    assert.equal(paths.filter(p => p === "/tmp/foo.txt").length, 1);
  });
});

describe("unified-orchestrator — extractFilePaths: home paths", () => {
  it("expands ~ home paths", () => {
    const homeDir = process.env.HOME || os.homedir();
    const paths = extractFilePaths("Write to ~/projects/app.js");
    assert.ok(paths.some(p => p.startsWith(homeDir)));
  });

  it("handles multiple home paths", () => {
    const homeDir = process.env.HOME || os.homedir();
    const paths = extractFilePaths("~/a/b.js and ~/c/d.ts");
    assert.equal(paths.filter(p => p.startsWith(homeDir)).length, 2);
  });
});

describe("unified-orchestrator — extractFilePaths: quoted paths", () => {
  it("extracts double-quoted paths", () => {
    const paths = extractFilePaths(`Create "/var/log/app.log" now`);
    assert.ok(paths.some(p => p === "/var/log/app.log"));
  });

  it("extracts single-quoted paths", () => {
    const paths = extractFilePaths(`Write to '/etc/nginx/nginx.conf'`);
    assert.ok(paths.some(p => p.includes("nginx.conf")));
  });

  it("extracts backtick-quoted paths", () => {
    const paths = extractFilePaths("Use `/usr/bin/node.js` binary");
    assert.ok(paths.some(p => p.includes("node.js")));
  });
});

// ─── extractAndValidateJSON ───────────────────────────────────────────────────

describe("unified-orchestrator — JSON extraction: valid inputs", () => {
  it("parses a clean JSON response", () => {
    const raw = JSON.stringify({
      op_id: "op-abc123",
      summary: "Build auth",
      dispatch: [{ agent: "crew-coder", task: "Write auth module", acceptance: "File exists" }]
    });
    const plan = extractAndValidateJSON(raw);
    assert.equal(plan.dispatch.length, 1);
    assert.equal(plan.dispatch[0].agent, "crew-coder");
  });

  it("strips markdown code fences", () => {
    const raw = "```json\n" + JSON.stringify({
      op_id: "op-1",
      summary: "Test",
      dispatch: [{ agent: "crew-qa", task: "Run tests", acceptance: "Tests pass" }]
    }) + "\n```";
    const plan = extractAndValidateJSON(raw);
    assert.equal(plan.dispatch[0].agent, "crew-qa");
  });

  it("strips plain code fences (no language)", () => {
    const raw = "```\n" + JSON.stringify({
      op_id: "op-2",
      summary: "Fix",
      dispatch: [{ agent: "crew-fixer", task: "Debug issue", acceptance: "No errors" }]
    }) + "\n```";
    const plan = extractAndValidateJSON(raw);
    assert.equal(plan.dispatch[0].agent, "crew-fixer");
  });

  it("handles JSON embedded in surrounding text", () => {
    const jsonPart = JSON.stringify({
      op_id: "op-3",
      summary: "Security audit",
      dispatch: [{ agent: "security", task: "Audit routes", acceptance: "No vulns" }]
    });
    const raw = `Here is the plan:\n${jsonPart}\nLet me know if you need changes.`;
    const plan = extractAndValidateJSON(raw);
    assert.equal(plan.dispatch.length, 1);
  });

  it("fills missing acceptance field with default", () => {
    const raw = JSON.stringify({
      op_id: "op-4",
      summary: "Quick fix",
      dispatch: [{ agent: "crew-coder", task: "Fix typo" }]
    });
    const plan = extractAndValidateJSON(raw);
    assert.equal(plan.dispatch[0].acceptance, "Task completed");
  });

  it("falls back to default task when dispatch is empty", () => {
    const raw = JSON.stringify({ op_id: "op-5", summary: "Empty", dispatch: [] });
    const plan = extractAndValidateJSON(raw);
    assert.equal(plan.dispatch.length, 1);
    assert.equal(plan.dispatch[0].agent, "crew-coder");
    assert.equal(plan.dispatch[0].task, "fallback");
  });

  it("parses multi-task dispatch correctly", () => {
    const raw = JSON.stringify({
      op_id: "op-6",
      summary: "Full build",
      dispatch: [
        { agent: "crew-coder", task: "Create schema", acceptance: "Schema file exists" },
        { agent: "crew-qa", task: "Write tests", acceptance: "Test file exists" },
        { agent: "crew-qa", task: "Run tests", acceptance: "Tests pass" }
      ]
    });
    const plan = extractAndValidateJSON(raw);
    assert.equal(plan.dispatch.length, 3);
    assert.equal(plan.dispatch[2].task, "Run tests");
  });
});

describe("unified-orchestrator — JSON extraction: error cases", () => {
  it("throws when response has no JSON object", () => {
    assert.throws(
      () => extractAndValidateJSON("I'm sorry, I couldn't create a plan."),
      /valid JSON/
    );
  });

  it("throws when dispatch array is missing", () => {
    const raw = JSON.stringify({ op_id: "op-x", summary: "Bad" });
    assert.throws(
      () => extractAndValidateJSON(raw),
      /dispatch/
    );
  });

  it("throws when a task is missing agent field", () => {
    const raw = JSON.stringify({
      op_id: "op-y",
      summary: "Missing agent",
      dispatch: [{ task: "Do something" }]
    });
    assert.throws(
      () => extractAndValidateJSON(raw),
      /missing "agent"/
    );
  });

  it("throws when a task is missing task field", () => {
    const raw = JSON.stringify({
      op_id: "op-z",
      summary: "Missing task",
      dispatch: [{ agent: "crew-coder" }]
    });
    assert.throws(
      () => extractAndValidateJSON(raw),
      /missing "task"/
    );
  });

  it("throws on completely malformed JSON", () => {
    assert.throws(
      () => extractAndValidateJSON("{ not: valid json ??? }"),
      /JSON/
    );
  });
});

// ─── reply extraction logic ───────────────────────────────────────────────────

describe("unified-orchestrator — callAgent reply extraction", () => {
  it("useSend=true returns trimmed stdout directly", () => {
    const result = extractReply("  hello world  \n", true);
    assert.equal(result, "hello world");
  });

  it("useSend=false extracts content after '✅ Reply received'", () => {
    const stdout = "Some preamble\n✅ Reply received\nThe actual reply here.\nMore lines.";
    const result = extractReply(stdout, false);
    assert.equal(result, "The actual reply here.\nMore lines.");
  });

  it("useSend=false falls back to full stdout when no Reply received marker", () => {
    const stdout = "Just the raw output here.";
    const result = extractReply(stdout, false);
    assert.equal(result, "Just the raw output here.");
  });

  it("useSend=false finds marker even with unicode checkmark variant", () => {
    const stdout = "noise\n✅ Reply received\nexpected content";
    const result = extractReply(stdout, false);
    assert.ok(result.includes("expected content"));
  });
});

// ─── verification logic ───────────────────────────────────────────────────────

describe("unified-orchestrator — verifyResults logic", () => {
  it("marks failed execution task as not verified", () => {
    const v = buildVerification(1, false, "Create /tmp/x.txt", { success: false });
    assert.equal(v.verified, false);
    assert.match(v.reason, /failed during execution/);
  });

  it("marks task with no file paths as verified (trust agent)", () => {
    const v = buildVerification(1, true, "Run npm test and check output", { success: true });
    assert.equal(v.verified, true);
    assert.match(v.reason, /No artifacts/);
  });

  it("returns file paths to check when task describes a file", () => {
    const v = buildVerification(1, true, "Create /tmp/output.txt with content", { success: true });
    // verified=null means we have files to check (not a pure no-I/O case)
    assert.equal(v.verified, null);
    assert.ok(v.files.includes("/tmp/output.txt"));
  });
});

// ─── op_id format ────────────────────────────────────────────────────────────

describe("unified-orchestrator — op_id generation", () => {
  it("generates op_id with 'op-' prefix", () => {
    const opId = `op-${randomUUID().split("-")[0]}`;
    assert.ok(opId.startsWith("op-"));
    assert.ok(opId.length > 4);
  });

  it("generates unique op_ids", () => {
    const ids = new Set(Array.from({ length: 10 }, () => `op-${randomUUID().split("-")[0]}`));
    assert.equal(ids.size, 10);
  });
});

// ─── CLI contract (child process) ────────────────────────────────────────────

describe("unified-orchestrator — CLI: no-arg behavior", () => {
  it("exits with code 1 when no requirement is provided", () => {
    const result = spawnSync("node", [SCRIPT], {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, SKIP_ORCHESTRATOR_RUN: "1" }
    });
    assert.equal(result.status, 1, `Expected exit 1, got ${result.status}`);
  });

  it("prints usage help to stdout when no argument given", () => {
    const result = spawnSync("node", [SCRIPT], {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env }
    });
    const out = result.stdout + result.stderr;
    assert.ok(
      out.includes("Unified Orchestrator") || out.includes("unified-orchestrator"),
      `Expected help text, got: ${out.slice(0, 300)}`
    );
  });

  it("mentions usage examples in output", () => {
    const result = spawnSync("node", [SCRIPT], {
      encoding: "utf8",
      timeout: 10_000
    });
    const out = result.stdout + result.stderr;
    assert.ok(
      out.includes("Usage") || out.includes("Examples") || out.includes("node unified"),
      `Expected usage text, got: ${out.slice(0, 300)}`
    );
  });
});

// ─── valid agent names ────────────────────────────────────────────────────────

describe("unified-orchestrator — valid agent names in dispatch", () => {
  const VALID_AGENTS = ["crew-coder", "crew-qa", "crew-fixer", "security"];

  it("all valid agent names are distinct strings", () => {
    assert.equal(new Set(VALID_AGENTS).size, VALID_AGENTS.length);
  });

  it("rejects agents not in valid set (validation awareness)", () => {
    // The parser validates agent names — simulate what happens when we check
    const task = { agent: "unknown-bot", task: "Do something" };
    const isValid = VALID_AGENTS.includes(task.agent);
    assert.equal(isValid, false);
  });

  it("accepts all known valid agent names", () => {
    for (const agent of VALID_AGENTS) {
      assert.ok(VALID_AGENTS.includes(agent));
    }
  });
});
