#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const resultsDir = process.env.TEST_RESULTS_DIR || path.join(process.cwd(), "test-results");
const summaryPath = path.join(resultsDir, ".last-run.json");

if (!fs.existsSync(summaryPath)) {
  console.error(`No summary found at ${summaryPath}`);
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
const runDir = path.join(resultsDir, "runs", summary.runId);
const markdownPath = path.join(runDir, "summary.md");

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function rerunCommand(test) {
  return test.rerun_command || `node --test --test-reporter=./scripts/test-reporter.mjs --test-name-pattern=${shellQuote(test.name)} ${shellQuote(test.file)}`;
}

console.log(`Run: ${summary.runId}`);
console.log(`Status: ${summary.status}`);
console.log(`Passed: ${summary.passed}  Failed: ${summary.failed}  Skipped: ${summary.skipped}`);
console.log(`Duration: ${(summary.duration_ms / 1000).toFixed(2)}s`);
console.log(`Artifacts: ${runDir}`);

if (summary.failedTests?.length) {
  console.log("\nFailed tests:");
  for (const failure of summary.failedTests) {
    console.log(`- ${failure.name}`);
    console.log(`  file: ${failure.file}`);
    console.log(`  reason: ${failure.reason_code} (${failure.reason_summary})`);
    console.log(`  error: ${failure.error || "unknown"}`);
    if (failure.engine?.engine || failure.engine?.provider || failure.engine?.model) {
      console.log(`  engine: ${failure.engine?.engine || "n/a"} | provider: ${failure.engine?.provider || "n/a"} | model: ${failure.engine?.model || "n/a"}`);
    }
    console.log(`  artifacts: ${failure.artifactDir}`);
    console.log(`  rerun: ${rerunCommand(failure)}`);
  }
}

if (summary.skippedTests?.length) {
  console.log("\nSkipped tests:");
  for (const skipped of summary.skippedTests) {
    console.log(`- ${skipped.name}`);
    console.log(`  file: ${skipped.file}`);
    console.log(`  reason: ${skipped.reason_code} (${skipped.reason_summary})`);
    console.log(`  reason: ${skipped.skip_reason}`);
    console.log(`  artifacts: ${skipped.artifactDir}`);
    console.log(`  rerun: ${rerunCommand(skipped)}`);
  }
}

if (fs.existsSync(markdownPath)) {
  console.log(`\nMarkdown summary: ${markdownPath}`);
}
