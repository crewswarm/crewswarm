#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "coverage");
fs.mkdirSync(OUT_DIR, { recursive: true });

function runStep(name, command, cwd = ROOT, allowFailure = false) {
  console.log(`\n== ${name} ==`);
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
  const combined = `${result.stdout || ""}${result.stderr || ""}`;
  fs.writeFileSync(path.join(OUT_DIR, `${name}.log`), combined);
  if (combined.trim()) process.stdout.write(combined);
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${name} failed with exit code ${result.status}`);
  }
  return { output: combined, status: result.status ?? 0 };
}

function extractCoverageTail(output) {
  const lines = output.split("\n");
  const start = lines.findIndex((line) => /^\s*file\s*\|/i.test(line) || /^\s*all files\s*\|/i.test(line));
  if (start === -1) return "Coverage summary not found in command output.";
  return lines.slice(start).join("\n").trim();
}

/**
 * Parse the "all files" summary line from Node's --experimental-test-coverage output.
 * Format: `ℹ all files  | <line%> | <branch%> | <funcs%> |`
 * Returns { lines, branches, functions } or null if not found.
 */
function parseCoverageSummary(output) {
  const lines = output.split("\n");
  for (const line of lines) {
    const match = line.match(/all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/);
    if (match) {
      return {
        lines: parseFloat(match[1]),
        branches: parseFloat(match[2]),
        functions: parseFloat(match[3]),
        // Node's built-in coverage reports line% (which is effectively statements)
        statements: parseFloat(match[1]),
      };
    }
  }
  return null;
}

/**
 * Compute a weighted average of two metric objects.
 * Uses a simple average (equal weight) since we don't have file counts per suite.
 */
function averageMetrics(a, b) {
  if (!a && !b) return { statements: 0, branches: 0, functions: 0, lines: 0 };
  if (!a) return b;
  if (!b) return a;
  const round1 = (n) => Math.round(n * 10) / 10;
  return {
    statements: round1((a.statements + b.statements) / 2),
    branches: round1((a.branches + b.branches) / 2),
    functions: round1((a.functions + b.functions) / 2),
    lines: round1((a.lines + b.lines) / 2),
  };
}

try {
  const rootCoverage = runStep(
    "root-unit-coverage",
    "node --test --experimental-test-coverage test/unit/*.test.mjs"
  );
  const rootIntegration = runStep(
    "root-integration-bounded",
    "node scripts/run-integration-bounded.mjs",
    ROOT,
    true
  );
  const crewCliCoverage = runStep(
    "crew-cli-coverage",
    "npm run test:coverage",
    path.join(ROOT, "crew-cli")
  );

  // Parse metrics from each suite
  const rootMetrics = parseCoverageSummary(rootCoverage.output);
  const crewCliMetrics = parseCoverageSummary(crewCliCoverage.output);
  const overallMetrics = averageMetrics(rootMetrics, crewCliMetrics);

  // Build machine-readable summary JSON
  const summaryJson = {
    timestamp: new Date().toISOString(),
    root: rootMetrics
      ? { statements: rootMetrics.statements, branches: rootMetrics.branches, functions: rootMetrics.functions, lines: rootMetrics.lines }
      : null,
    crewCli: crewCliMetrics
      ? { statements: crewCliMetrics.statements, branches: crewCliMetrics.branches, functions: crewCliMetrics.functions, lines: crewCliMetrics.lines }
      : null,
    overall: overallMetrics
      ? { statements: overallMetrics.statements, branches: overallMetrics.branches, functions: overallMetrics.functions, lines: overallMetrics.lines }
      : null,
  };

  const summaryPath = path.join(OUT_DIR, "coverage-summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify(summaryJson, null, 2) + "\n");

  // Build markdown report
  function metricsTable(metrics) {
    if (!metrics) return "Coverage metrics could not be parsed.";
    return `| Metric     | Value   |
|------------|---------|
| Statements | ${metrics.statements.toFixed(1)}%  |
| Branches   | ${metrics.branches.toFixed(1)}%  |
| Functions  | ${metrics.functions.toFixed(1)}%  |
| Lines      | ${metrics.lines.toFixed(1)}%  |`;
  }

  const report = `# Repo Coverage Report

Generated: ${summaryJson.timestamp}

## Root unit coverage

${metricsTable(rootMetrics)}

<details><summary>Full file-by-file report</summary>

\`\`\`
${extractCoverageTail(rootCoverage.output)}
\`\`\`

</details>

## Root integration verification

Exit code: ${rootIntegration.status}

<details><summary>Output</summary>

\`\`\`
${rootIntegration.output.trim() || "No output."}
\`\`\`

</details>

## crew-cli coverage

${metricsTable(crewCliMetrics)}

<details><summary>Full file-by-file report</summary>

\`\`\`
${extractCoverageTail(crewCliCoverage.output)}
\`\`\`

</details>

## Overall (average across suites)

${metricsTable(overallMetrics)}

## Notes

- Root coverage currently reports hermetic unit coverage only.
- Integration and E2E surfaces are reported separately because many depend on running services or external credentials.
- Use \`docs/CANONICAL/COVERAGE-MATRIX.md\` for feature-by-feature status.
- Machine-readable metrics: \`coverage/coverage-summary.json\`

## Logs

- coverage/root-unit-coverage.log
- coverage/root-integration-bounded.log
- coverage/crew-cli-coverage.log
`;

  const reportPath = path.join(OUT_DIR, "coverage-report.md");
  fs.writeFileSync(reportPath, report);

  // Print summary to stdout
  console.log("\n========================================");
  console.log("  Coverage Summary");
  console.log("========================================");
  if (rootMetrics) {
    console.log(`  Root:     ${rootMetrics.lines.toFixed(1)}% lines | ${rootMetrics.branches.toFixed(1)}% branches | ${rootMetrics.functions.toFixed(1)}% funcs`);
  } else {
    console.log("  Root:     (metrics not available)");
  }
  if (crewCliMetrics) {
    console.log(`  crew-cli: ${crewCliMetrics.lines.toFixed(1)}% lines | ${crewCliMetrics.branches.toFixed(1)}% branches | ${crewCliMetrics.functions.toFixed(1)}% funcs`);
  } else {
    console.log("  crew-cli: (metrics not available)");
  }
  if (overallMetrics) {
    console.log(`  Overall:  ${overallMetrics.lines.toFixed(1)}% lines | ${overallMetrics.branches.toFixed(1)}% branches | ${overallMetrics.functions.toFixed(1)}% funcs`);
  }
  console.log("========================================");
  console.log(`\nWrote ${path.relative(ROOT, reportPath)}`);
  console.log(`Wrote ${path.relative(ROOT, summaryPath)}`);
} catch (error) {
  console.error(`\nCoverage report failed: ${error.message}`);
  process.exit(1);
}
