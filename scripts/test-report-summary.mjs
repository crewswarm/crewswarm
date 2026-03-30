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
    console.log(`  error: ${failure.error || "unknown"}`);
    console.log(`  artifacts: ${failure.artifactDir}`);
  }
}

if (fs.existsSync(markdownPath)) {
  console.log(`\nMarkdown summary: ${markdownPath}`);
}
