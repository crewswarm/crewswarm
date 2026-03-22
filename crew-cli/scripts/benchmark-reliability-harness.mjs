#!/usr/bin/env node
/**
 * Reliability benchmark harness for crew-cli dispatch.
 *
 * What it does:
 * 1) Creates an isolated seed project per run under /tmp
 * 2) Dispatches a coding task to an agent via crew-cli (JSON mode)
 * 3) Executes deterministic tests in the run directory
 * 4) Produces JSON + Markdown reports with first-pass success metrics
 */

import { config } from 'dotenv';
config();  // Load .env from CWD

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function parseArgs(argv) {
  const out = {
    runs: 3,
    agent: "crew-coder",
    engine: "",
    model: "",
    gateway: "",
    outputDir: "",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--runs" && v) out.runs = Math.max(1, Number.parseInt(v, 10) || 3);
    if (k === "--agent" && v) out.agent = v;
    if (k === "--engine" && v) out.engine = v;
    if (k === "--model" && v) out.model = v;
    if (k === "--gateway" && v) out.gateway = v;
    if (k === "--output" && v) out.outputDir = v;
  }

  return out;
}

function runCommand(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(cmd, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...(options.env || {}) },  // Merge parent env with options
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    child.on("close", (code) => {
      resolve({
        code: typeof code === "number" ? code : 1,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });
    child.on("error", (err) => {
      resolve({
        code: 1,
        stdout,
        stderr: `${stderr}\n${String(err?.message || err)}`.trim(),
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

async function writeFileSafe(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

async function createSeedProject(runDir) {
  const pkg = {
    name: "crew-bench-retry",
    version: "0.0.1",
    type: "module",
    scripts: {
      test: "node --test tests/retry.test.js",
    },
  };

  const retryJs = `// TODO: implement benchmark target in-place.
// The benchmark agent must make tests pass.
export function createRetryController() {
  throw new Error("not implemented");
}
`;

  const testJs = `import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRetryController } from "../src/retry.js";

test("retries with exponential backoff and deterministic jitter", async () => {
  const delays = [];
  const controller = createRetryController({
    baseDelayMs: 100,
    maxAttempts: 4,
    jitterFn: () => 0.1,
    sleepFn: async (ms) => { delays.push(ms); },
  });

  let attempts = 0;
  const result = await controller.run(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("transient");
    return "ok";
  });

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [110, 220]);
});

test("dedupes by idempotency key", async () => {
  const controller = createRetryController({
    baseDelayMs: 10,
    maxAttempts: 2,
    jitterFn: () => 0,
    sleepFn: async () => {},
  });

  let calls = 0;
  const job = async () => {
    calls += 1;
    return "same-result";
  };

  const a = await controller.run(job, { key: "abc" });
  const b = await controller.run(job, { key: "abc" });
  assert.equal(a, "same-result");
  assert.equal(b, "same-result");
  assert.equal(calls, 1);
});

test("persists and restores retry state", async () => {
  const statePath = path.join(os.tmpdir(), "crew-bench-retry-state.json");
  try { fs.unlinkSync(statePath); } catch {}

  const one = createRetryController({
    baseDelayMs: 50,
    maxAttempts: 3,
    jitterFn: () => 0,
    sleepFn: async () => {},
    statePath,
  });

  const before = one.getState();
  assert.equal(before.totalRuns, 0);
  await one.run(async () => "ok", { key: "persist-1" });
  const after = one.getState();
  assert.equal(after.totalRuns, 1);

  const two = createRetryController({
    baseDelayMs: 50,
    maxAttempts: 3,
    jitterFn: () => 0,
    sleepFn: async () => {},
    statePath,
  });
  const restored = two.getState();
  assert.equal(restored.totalRuns, 1);
});
`;

  await writeFileSafe(path.join(runDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  await writeFileSafe(path.join(runDir, "src", "retry.js"), retryJs);
  await writeFileSafe(path.join(runDir, "tests", "retry.test.js"), testJs);
}

function buildTaskPrompt(runDir) {
  return [
    "Implement the retry controller so all tests pass.",
    "",
    `Project directory: ${runDir}`,
    `Target file: src/retry.js`,
    `Test file (read-only unless absolutely needed): tests/retry.test.js`,
    "",
    "First lines of test file (for module system detection):",
    "```javascript",
    "import test from \"node:test\";",
    "import assert from \"node:assert/strict\";",
    "import fs from \"node:fs\";",
    "import os from \"node:os\";",
    "import path from \"node:path\";",
    "import { createRetryController } from \"../src/retry.js\";",
    "```",
    "(Tests use ESM imports - implementation must use `export` keyword)",
    "",
    "Requirements:",
    "1. Export createRetryController(options).",
    "2. Support baseDelayMs, maxAttempts, jitterFn, sleepFn, statePath.",
    "3. Exponential backoff delay = baseDelayMs * 2^(attempt-1), then apply jitterFn proportionally.",
    "4. Deduplicate by idempotency key: repeated run(job,{key}) returns cached result without re-running job.",
    "5. Persist state (at least totalRuns) to statePath and restore on startup.",
    "6. Keep changes minimal and targeted to retry.js.",
    "",
    "Definition of done: `node --test tests/retry.test.js` passes with exit code 0.",
  ].join("\n");
}

function extractJsonEnvelope(raw) {
  const marker = '"version": "v1"';
  const markerIdx = raw.lastIndexOf(marker);
  if (markerIdx < 0) return null;
  const start = raw.lastIndexOf("{", markerIdx);
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const slice = raw.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

function mdSummary(report) {
  const lines = [];
  lines.push("# Dispatch Reliability Benchmark");
  lines.push("");
  lines.push(`- Timestamp: ${report.meta.timestamp}`);
  lines.push(`- Runs: ${report.meta.runs}`);
  lines.push(`- Agent: ${report.meta.agent}`);
  lines.push(`- Engine: ${report.meta.engine || "(default)"}`);
  lines.push(`- Model: ${report.meta.model || "(default)"}`);
  lines.push(`- First-pass success rate: ${(report.summary.firstPassRate * 100).toFixed(1)}%`);
  lines.push(`- Avg dispatch duration: ${(report.summary.avgDispatchMs / 1000).toFixed(2)}s`);
  lines.push(`- Avg end-to-end duration: ${(report.summary.avgTotalMs / 1000).toFixed(2)}s`);
  lines.push("");
  lines.push("| Run | Dispatch OK | Tests OK | First Pass | Dispatch (s) | Total (s) | Edits |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const r of report.runs) {
    lines.push(`| ${r.run} | ${r.dispatchSuccess ? "1" : "0"} | ${r.testsPass ? "1" : "0"} | ${r.firstPass ? "1" : "0"} | ${(r.dispatchMs / 1000).toFixed(2)} | ${(r.totalMs / 1000).toFixed(2)} | ${r.edits ?? 0} |`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv);
  const now = new Date();
  const stamp = now.toISOString().replaceAll(":", "").replaceAll(".", "");
  const outputDir = args.outputDir || path.join(process.cwd(), ".crew", "benchmarks");
  await fs.mkdir(outputDir, { recursive: true });

  const results = [];
  for (let i = 0; i < args.runs; i += 1) {
    const runId = i + 1;
    const runDir = path.join(os.tmpdir(), `crew-bench-retry-${stamp}-run${runId}`);
    await fs.rm(runDir, { recursive: true, force: true });
    await fs.mkdir(runDir, { recursive: true });
    await createSeedProject(runDir);

    const prompt = buildTaskPrompt(runDir);
    
    // Use compiled crew.mjs for standalone execution
    const crewCliPath = path.join(process.cwd(), "dist", "crew.mjs");
    const dispatchArgs = [
      "run",
      "-t", prompt,
      "--json",
      "--retry-attempts", "1"
    ];
    if (args.model) dispatchArgs.push("--model", args.model);

    const startedAt = Date.now();
    const dispatch = await runCommand(crewCliPath, dispatchArgs, { cwd: runDir });
    const envelope = extractJsonEnvelope(`${dispatch.stdout}\n${dispatch.stderr}`);
    
    // Apply sandbox changes to disk
    const applyResult = await runCommand(crewCliPath, ["apply", "--force"], { cwd: runDir });
    
    const testExec = await runCommand("node", ["--test", "tests/retry.test.js"], { cwd: runDir });

    const dispatchSuccess = dispatch.code === 0 && (envelope?.phase === 'complete' || Boolean(envelope?.success));
    const testsPass = testExec.code === 0;
    const totalMs = Date.now() - startedAt;

    results.push({
      run: runId,
      runDir,
      dispatchSuccess,
      testsPass,
      firstPass: dispatchSuccess && testsPass,
      dispatchMs: dispatch.durationMs,
      totalMs,
      edits: Array.isArray(envelope?.edits) ? envelope.edits.length : 0,
      dispatchCode: dispatch.code,
      testCode: testExec.code,
      dispatchStderrTail: dispatch.stderr.slice(-600),
      testStderrTail: testExec.stderr.slice(-600),
    });

    const badge = dispatchSuccess && testsPass ? "PASS" : "FAIL";
    console.log(`[run ${runId}/${args.runs}] ${badge} dispatch=${(dispatch.durationMs / 1000).toFixed(2)}s total=${(totalMs / 1000).toFixed(2)}s tests=${testsPass ? "ok" : "fail"}`);
  }

  const firstPassCount = results.filter((r) => r.firstPass).length;
  const avgDispatchMs = results.reduce((sum, r) => sum + r.dispatchMs, 0) / results.length;
  const avgTotalMs = results.reduce((sum, r) => sum + r.totalMs, 0) / results.length;

  const report = {
    meta: {
      timestamp: now.toISOString(),
      runs: args.runs,
      agent: args.agent,
      engine: args.engine,
      model: args.model,
      gateway: args.gateway,
    },
    summary: {
      firstPassCount,
      firstPassRate: firstPassCount / results.length,
      avgDispatchMs,
      avgTotalMs,
    },
    runs: results,
  };

  const base = `dispatch-reliability-${stamp}`;
  const jsonPath = path.join(outputDir, `${base}.json`);
  const mdPath = path.join(outputDir, `${base}.md`);
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(mdPath, mdSummary(report), "utf8");

  console.log("");
  console.log(`Report JSON: ${jsonPath}`);
  console.log(`Report MD:   ${mdPath}`);
  console.log(`First-pass success: ${firstPassCount}/${results.length} (${(report.summary.firstPassRate * 100).toFixed(1)}%)`);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});

