#!/usr/bin/env node
import { readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const options = {
  timeoutMs: Number.parseInt(process.env.INTEGRATION_FILE_TIMEOUT_MS || "120000", 10),
  pattern: "",
  files: [],
  failFast: false,
};

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--timeout") {
    options.timeoutMs = Number.parseInt(args[i + 1] || "", 10);
    i += 1;
    continue;
  }
  if (arg === "--pattern") {
    options.pattern = args[i + 1] || "";
    i += 1;
    continue;
  }
  if (arg === "--file") {
    options.files.push(args[i + 1] || "");
    i += 1;
    continue;
  }
  if (arg === "--fail-fast") {
    options.failFast = true;
    continue;
  }
  if (arg === "--help" || arg === "-h") {
    printHelp();
    process.exit(0);
  }
  throw new Error(`Unknown argument: ${arg}`);
}

if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
  throw new Error(`Invalid timeout: ${options.timeoutMs}`);
}

const repoRoot = process.cwd();
const integrationDir = path.join(repoRoot, "test", "integration");
const candidates = options.files.length > 0
  ? options.files.map((file) => normalizeFile(file))
  : readdirSync(integrationDir)
      .filter((file) => file.endsWith(".test.mjs"))
      .map((file) => path.join("test", "integration", file))
      .sort();

const files = options.pattern
  ? candidates.filter((file) => file.includes(options.pattern))
  : candidates;

if (files.length === 0) {
  console.error("No integration test files matched.");
  process.exit(1);
}

const results = [];
for (const file of files) {
  const result = await runFile(file, options.timeoutMs);
  results.push(result);
  printResult(result);
  if (options.failFast && result.status !== "PASS") {
    break;
  }
}

printSummary(results, options.timeoutMs);
process.exit(results.every((result) => result.status === "PASS") ? 0 : 1);

function normalizeFile(file) {
  if (!file) {
    throw new Error("--file requires a path");
  }
  return file.startsWith("test/") ? file : path.join("test", "integration", file);
}

function printHelp() {
  console.log(`Usage: node scripts/run-integration-bounded.mjs [options]

Options:
  --timeout <ms>     Per-file timeout in milliseconds
  --pattern <text>   Run matching integration files only
  --file <path>      Run a specific file (repeatable)
  --fail-fast        Stop after the first FAIL or TIMEOUT

Env:
  INTEGRATION_FILE_TIMEOUT_MS   Default per-file timeout (ms)
  PM_LOOP_TEST_MODE             Defaults to 1 if unset
`);
}

function printResult(result) {
  const prefix = `[${result.status}]`;
  const duration = `${result.durationMs}ms`;
  console.log(`${prefix} ${result.file} (${duration})`);
  if (result.status !== "PASS" && result.tail) {
    console.log(result.tail);
  }
}

function printSummary(results, timeoutMs) {
  const counts = { PASS: 0, FAIL: 0, TIMEOUT: 0 };
  for (const result of results) counts[result.status] += 1;
  console.log("");
  console.log("Summary");
  console.log(`  timeout per file: ${timeoutMs}ms`);
  console.log(`  total files run: ${results.length}`);
  console.log(`  pass: ${counts.PASS}`);
  console.log(`  fail: ${counts.FAIL}`);
  console.log(`  timeout: ${counts.TIMEOUT}`);
}

async function runFile(file, timeoutMs) {
  const startedAt = Date.now();
  const child = spawn(process.execPath, ["--test", file], {
    cwd: repoRoot,
    env: { ...process.env, PM_LOOP_TEST_MODE: process.env.PM_LOOP_TEST_MODE || "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  let combinedOutput = "";
  child.stdout.on("data", (chunk) => {
    combinedOutput += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    combinedOutput += chunk.toString();
  });

  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    terminateChild(child);
  }, timeoutMs);

  const exit = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    clearTimeout(timeoutId);
  });

  const durationMs = Date.now() - startedAt;
  const tail = formatTail(combinedOutput);

  if (timedOut) {
    return { file, status: "TIMEOUT", durationMs, tail };
  }

  if (exit.code === 0) {
    return { file, status: "PASS", durationMs, tail: "" };
  }

  return { file, status: "FAIL", durationMs, tail };
}

function terminateChild(child) {
  if (process.platform === "win32") {
    child.kill("SIGTERM");
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 1000).unref();
}

function formatTail(output) {
  const lines = output.trim().split("\n").filter(Boolean);
  if (lines.length === 0) return "";
  return lines.slice(-20).join("\n");
}
