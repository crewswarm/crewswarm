#!/usr/bin/env node

/**
 * Prints the most recent coverage summary from coverage/coverage-summary.json
 * without re-running any tests.
 *
 * Usage: node scripts/coverage-summary.mjs
 *   or:  npm run test:coverage:summary
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const summaryPath = path.join(ROOT, "coverage", "coverage-summary.json");

if (!fs.existsSync(summaryPath)) {
  console.error(
    `No coverage summary found at ${summaryPath}\n` +
    `Run "npm run test:coverage" first to generate coverage data.`
  );
  process.exit(1);
}

let data;
try {
  data = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
} catch (err) {
  console.error(`Failed to parse ${summaryPath}: ${err.message}`);
  process.exit(1);
}

function fmtRow(label, metrics) {
  if (!metrics) return `  ${label.padEnd(12)} (no data)`;
  return `  ${label.padEnd(12)} ${String(metrics.lines.toFixed(1) + "%").padStart(7)} lines | ${String(metrics.branches.toFixed(1) + "%").padStart(7)} branches | ${String(metrics.functions.toFixed(1) + "%").padStart(7)} funcs`;
}

console.log("========================================");
console.log("  Coverage Summary");
console.log(`  Generated: ${data.timestamp}`);
console.log("========================================");
console.log(fmtRow("Root", data.root));
console.log(fmtRow("crew-cli", data.crewCli));
console.log(fmtRow("Overall", data.overall));
console.log("========================================");
console.log(`\nFull report: coverage/coverage-report.md`);
console.log(`JSON data:   coverage/coverage-summary.json`);
