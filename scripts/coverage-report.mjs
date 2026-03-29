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

  const report = `# Repo Coverage Report

Generated: ${new Date().toISOString()}

## Root unit coverage

\`\`\`
${extractCoverageTail(rootCoverage.output)}
\`\`\`

## Root integration verification

Exit code: ${rootIntegration.status}

\`\`\`
${rootIntegration.output.trim() || "No output."}
\`\`\`

## crew-cli coverage

\`\`\`
${extractCoverageTail(crewCliCoverage.output)}
\`\`\`

## Notes

- Root coverage currently reports hermetic unit coverage only.
- Integration and E2E surfaces are reported separately because many depend on running services or external credentials.
- Use `docs/CANONICAL/COVERAGE-MATRIX.md` for feature-by-feature status.

## Logs

- coverage/root-unit-coverage.log
- coverage/root-integration-bounded.log
- coverage/crew-cli-coverage.log
`;

  const reportPath = path.join(OUT_DIR, "coverage-report.md");
  fs.writeFileSync(reportPath, report);
  console.log(`\nWrote ${path.relative(ROOT, reportPath)}`);
} catch (error) {
  console.error(`\nCoverage report failed: ${error.message}`);
  process.exit(1);
}
