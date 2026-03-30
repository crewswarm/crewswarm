#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const resultsDir = process.env.TEST_RESULTS_DIR || path.join(process.cwd(), "test-results");
const runsDir = path.join(resultsDir, "runs");

function latestRunId() {
  const dirs = fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return dirs.at(-1) || null;
}

function parseArgs(argv) {
  const args = {
    runId: null,
    testId: null,
    failed: false,
    skipped: false,
    exec: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--run" && argv[i + 1]) args.runId = argv[++i];
    else if (arg === "--test-id" && argv[i + 1]) args.testId = argv[++i];
    else if (arg === "--failed") args.failed = true;
    else if (arg === "--skipped") args.skipped = true;
    else if (arg === "--exec") args.exec = true;
  }
  return args;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function rerunCommand(test) {
  return test.rerun_command || `node --test --test-reporter=./scripts/test-reporter.mjs --test-name-pattern=${shellQuote(test.name)} ${shellQuote(test.file)}`;
}

const args = parseArgs(process.argv.slice(2));
const runId = args.runId || latestRunId();

if (!runId) {
  console.error("No test runs found.");
  process.exit(1);
}

const summaryPath = path.join(runsDir, runId, "summary.json");
if (!fs.existsSync(summaryPath)) {
  console.error(`Missing summary for run ${runId}`);
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
let tests = [];
if (args.testId) {
  tests = [...(summary.failedTests || []), ...(summary.skippedTests || [])].filter((test) => test.testId === args.testId);
} else if (args.failed) {
  tests = summary.failedTests || [];
} else if (args.skipped) {
  tests = summary.skippedTests || [];
} else {
  tests = [...(summary.failedTests || []), ...(summary.skippedTests || [])];
}

if (tests.length === 0) {
  console.log("No matching tests found.");
  process.exit(0);
}

for (const test of tests) {
  console.log(`${test.testId}`);
  console.log(rerunCommand(test));
  if (args.exec) {
    const result = spawnSync("/bin/zsh", ["-lc", rerunCommand(test)], {
      cwd: process.cwd(),
      stdio: "inherit",
      env: process.env,
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
