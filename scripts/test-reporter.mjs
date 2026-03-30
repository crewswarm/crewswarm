#!/usr/bin/env node

/**
 * Custom Node.js test reporter that logs every test result (pass/fail/skip)
 * with timestamps to a JSONL file at test-results/test-log.jsonl.
 *
 * Also updates test-results/.last-run.json with summary + timestamp.
 *
 * Usage:  node --test --test-reporter=./scripts/test-reporter.mjs test/unit/*.test.mjs
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.env.TEST_RESULTS_DIR || path.join(process.cwd(), "test-results");
const LOG_PATH = path.join(ROOT, "test-log.jsonl");
const SUMMARY_PATH = path.join(ROOT, ".last-run.json");

fs.mkdirSync(ROOT, { recursive: true });

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const results = [];
let passed = 0;
let failed = 0;
let skipped = 0;
let totalDuration = 0;

export default async function* reporter(source) {
  const logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });

  for await (const event of source) {
    if (event.type === "test:pass" || event.type === "test:fail") {
      // Only log leaf tests (not suite/describe wrappers)
      if (event.data.details?.type === "suite") continue;

      const status = event.type === "test:pass" ? "pass" : "fail";
      const duration = event.data.details?.duration_ms ?? 0;
      totalDuration += duration;

      if (status === "pass") passed++;
      else failed++;

      const entry = {
        runId,
        timestamp: new Date().toISOString(),
        status,
        name: event.data.name,
        file: event.data.file,
        duration_ms: Math.round(duration * 100) / 100,
        ...(status === "fail" && event.data.details?.error
          ? { error: String(event.data.details.error.message || event.data.details.error).slice(0, 500) }
          : {}),
      };

      results.push(entry);
      logStream.write(JSON.stringify(entry) + "\n");
    }

    if (event.type === "test:skip") {
      skipped++;
      const entry = {
        runId,
        timestamp: new Date().toISOString(),
        status: "skip",
        name: event.data.name,
        file: event.data.file,
      };
      results.push(entry);
      logStream.write(JSON.stringify(entry) + "\n");
    }

    // Pass through to default spec output
    if (event.type === "test:pass") {
      yield `  ✓ ${event.data.name}\n`;
    } else if (event.type === "test:fail") {
      yield `  ✗ ${event.data.name}\n`;
      if (event.data.details?.error) {
        const msg = String(event.data.details.error.message || event.data.details.error);
        yield `    ${msg.split("\n")[0]}\n`;
      }
    } else if (event.type === "test:skip") {
      yield `  - ${event.data.name} (skipped)\n`;
    } else if (event.type === "test:diagnostic") {
      yield `${event.data.message}\n`;
    } else if (event.type === "test:start") {
      if (event.data.file) yield `\n${path.basename(event.data.file)}\n`;
    }
  }

  logStream.end();

  // Write summary
  const summary = {
    runId,
    timestamp: new Date().toISOString(),
    status: failed > 0 ? "failed" : "passed",
    passed,
    failed,
    skipped,
    total: passed + failed + skipped,
    duration_ms: Math.round(totalDuration * 100) / 100,
    failedTests: results
      .filter((r) => r.status === "fail")
      .map((r) => ({ name: r.name, file: r.file, error: r.error })),
  };
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2) + "\n");

  yield `\n─────────────────────────────────────\n`;
  yield `  ${passed} passed, ${failed} failed, ${skipped} skipped (${results.length} total)\n`;
  yield `  Duration: ${(totalDuration / 1000).toFixed(1)}s\n`;
  yield `  Results:  ${LOG_PATH}\n`;
  yield `─────────────────────────────────────\n`;
}
