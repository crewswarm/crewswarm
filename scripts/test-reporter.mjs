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
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";

const ROOT = process.env.TEST_RESULTS_DIR || path.join(process.cwd(), "test-results");
const LOG_PATH = path.join(ROOT, "test-log.jsonl");
const SUMMARY_PATH = path.join(ROOT, ".last-run.json");
const CURRENT_RUN_PATH = path.join(ROOT, ".current-run.json");
const RUNS_DIR = path.join(ROOT, "runs");

fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(RUNS_DIR, { recursive: true });

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const results = [];
let passed = 0;
let failed = 0;
let skipped = 0;
let totalDuration = 0;
const fileFingerprintCache = new Map();
const testArtifacts = new Map();

function safeExec(command) {
  try {
    return execSync(command, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

function truncate(value, limit = 800) {
  const text = String(value ?? "");
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function slugify(value) {
  return String(value || "unnamed")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "unnamed";
}

function buildTestId(filePath, name) {
  return `${slugify(path.relative(process.cwd(), filePath || "no-file"))}__${slugify(name || "unnamed-test")}`;
}

function buildRerunCommand(filePath, testName) {
  return `node --test --test-reporter=./scripts/test-reporter.mjs --test-name-pattern=${shellQuote(testName)} ${shellQuote(filePath)}`;
}

function getArtifactDir(testId) {
  return path.join(RUNS_DIR, runId, testId);
}

function ensureArtifactDir(testId) {
  const artifactDir = getArtifactDir(testId);
  fs.mkdirSync(artifactDir, { recursive: true });
  return artifactDir;
}

function writeArtifactJson(testId, filename, value) {
  const artifactDir = ensureArtifactDir(testId);
  fs.writeFileSync(path.join(artifactDir, filename), JSON.stringify(value, null, 2) + "\n");
}

function upsertTestArtifact(entry) {
  const current = testArtifacts.get(entry.testId) || {};
  testArtifacts.set(entry.testId, { ...current, ...entry });
}

function fingerprintFile(filePath) {
  if (!filePath) return null;
  if (fileFingerprintCache.has(filePath)) return fileFingerprintCache.get(filePath);
  try {
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath);
    const fingerprint = {
      file: filePath,
      relative_file: path.relative(process.cwd(), filePath),
      size_bytes: stat.size,
      mtime: stat.mtime.toISOString(),
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
      git_blob: safeExec(`git hash-object ${JSON.stringify(filePath)}`),
    };
    fileFingerprintCache.set(filePath, fingerprint);
    return fingerprint;
  } catch {
    return null;
  }
}

const runMeta = {
  runId,
  entry_type: "run",
  phase: "start",
  timestamp: new Date().toISOString(),
  cwd: process.cwd(),
  hostname: os.hostname(),
  platform: process.platform,
  arch: process.arch,
  node_version: process.version,
  test_results_dir: ROOT,
  test_command: process.argv.join(" "),
  git_branch: safeExec("git branch --show-current"),
  git_commit: safeExec("git rev-parse HEAD"),
  git_dirty: !!safeExec("git status --short"),
  package_version: (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")).version || null;
    } catch {
      return null;
    }
  })(),
};

fs.writeFileSync(CURRENT_RUN_PATH, JSON.stringify(runMeta, null, 2) + "\n");
fs.mkdirSync(path.join(RUNS_DIR, runId), { recursive: true });
fs.writeFileSync(path.join(RUNS_DIR, runId, "run.json"), JSON.stringify(runMeta, null, 2) + "\n");

export default async function* reporter(source) {
  const logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });
  logStream.write(JSON.stringify(runMeta) + "\n");

  for await (const event of source) {
    if (event.type === "test:start" && event.data?.details?.type !== "suite") {
      const testId = buildTestId(event.data.file, event.data.name);
      const artifactDir = ensureArtifactDir(testId);
      const startEntry = {
        runId,
        timestamp: new Date().toISOString(),
        entry_type: "result",
        phase: "start",
        status: "start",
        testId,
        artifactDir,
        name: event.data.name,
        file: event.data.file,
        file_fingerprint: fingerprintFile(event.data.file),
        details_type: event.data.details?.type || null,
        nesting: event.data.nesting ?? null,
        line: event.data.line ?? null,
        column: event.data.column ?? null,
        rerun_command: buildRerunCommand(event.data.file, event.data.name),
      };
      upsertTestArtifact({
        testId,
        artifactDir,
        name: event.data.name,
        file: event.data.file,
        status: "start",
        line: event.data.line ?? null,
        column: event.data.column ?? null,
      });
      writeArtifactJson(testId, "manifest.json", startEntry);
      logStream.write(JSON.stringify(startEntry) + "\n");
    }

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
        entry_type: "result",
        phase: "finish",
        status,
        testId: buildTestId(event.data.file, event.data.name),
        artifactDir: getArtifactDir(buildTestId(event.data.file, event.data.name)),
        name: event.data.name,
        file: event.data.file,
        file_fingerprint: fingerprintFile(event.data.file),
        duration_ms: Math.round(duration * 100) / 100,
        details_type: event.data.details?.type || null,
        nesting: event.data.nesting ?? null,
        line: event.data.line ?? null,
        column: event.data.column ?? null,
        rerun_command: buildRerunCommand(event.data.file, event.data.name),
        ...(status === "fail" && event.data.details?.error
          ? {
              error: truncate(event.data.details.error.message || event.data.details.error),
              error_name: event.data.details.error.name || null,
              error_code: event.data.details.error.code || null,
              error_stack: truncate(event.data.details.error.stack || ""),
              timeout_detected: /timeout|cancelled|did not finish/i.test(
                String(event.data.details.error.message || event.data.details.error)
              ),
            }
          : {}),
      };

      results.push(entry);
      upsertTestArtifact({
        testId: entry.testId,
        artifactDir: entry.artifactDir,
        name: entry.name,
        file: entry.file,
        status: entry.status,
        duration_ms: entry.duration_ms,
        error: entry.error,
        error_name: entry.error_name,
        timeout_detected: entry.timeout_detected,
      });
      writeArtifactJson(entry.testId, "manifest.json", {
        ...testArtifacts.get(entry.testId),
        result: entry,
      });
      if (status === "fail") {
        writeArtifactJson(entry.testId, "failure.json", entry);
      }
      logStream.write(JSON.stringify(entry) + "\n");
    }

    if (event.type === "test:skip") {
      skipped++;
      const entry = {
        runId,
        timestamp: new Date().toISOString(),
        entry_type: "result",
        phase: "finish",
        status: "skip",
        testId: buildTestId(event.data.file, event.data.name),
        artifactDir: getArtifactDir(buildTestId(event.data.file, event.data.name)),
        name: event.data.name,
        file: event.data.file,
        skip_reason: truncate(
          event.data.skipReason ||
          event.data.details?.skip ||
          event.data.details?.message ||
          "skipped"
        ),
        rerun_command: buildRerunCommand(event.data.file, event.data.name),
      };
      results.push(entry);
      upsertTestArtifact({
        testId: entry.testId,
        artifactDir: entry.artifactDir,
        name: entry.name,
        file: entry.file,
        status: "skip",
      });
      writeArtifactJson(entry.testId, "manifest.json", entry);
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

  // Write summary
  const summary = {
    runId,
    timestamp: new Date().toISOString(),
    entry_type: "run",
    phase: "finish",
    status: failed > 0 ? "failed" : "passed",
    passed,
    failed,
    skipped,
    total: passed + failed + skipped,
    duration_ms: Math.round(totalDuration * 100) / 100,
    failedTests: results
      .filter((r) => r.status === "fail")
      .map((r) => ({
        testId: r.testId,
        name: r.name,
        file: r.file,
        error: r.error,
        error_name: r.error_name,
        timeout_detected: r.timeout_detected || false,
        artifactDir: r.artifactDir,
        rerun_command: r.rerun_command,
      })),
    skippedTests: results
      .filter((r) => r.status === "skip")
      .map((r) => ({
        testId: r.testId,
        name: r.name,
        file: r.file,
        skip_reason: r.skip_reason || "skipped",
        artifactDir: r.artifactDir,
        rerun_command: r.rerun_command,
      })),
  };
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2) + "\n");
  fs.writeFileSync(path.join(RUNS_DIR, runId, "summary.json"), JSON.stringify(summary, null, 2) + "\n");

  const markdown = [
    `# Test Run ${runId}`,
    "",
    `- Status: ${summary.status}`,
    `- Passed: ${summary.passed}`,
    `- Failed: ${summary.failed}`,
    `- Skipped: ${summary.skipped}`,
    `- Duration: ${(summary.duration_ms / 1000).toFixed(2)}s`,
    `- Commit: ${runMeta.git_commit || "unknown"}`,
    `- Branch: ${runMeta.git_branch || "unknown"}`,
    `- Node: ${runMeta.node_version}`,
    "",
    "## Failed Tests",
  ];
  if (summary.failedTests.length === 0) {
    markdown.push("", "None.");
  } else {
    for (const failure of summary.failedTests) {
      markdown.push(
        "",
        `### ${failure.name}`,
        `- Test ID: \`${failure.testId}\``,
        `- File: \`${failure.file}\``,
        `- Error: ${failure.error || "unknown"}`,
        `- Error Name: ${failure.error_name || "n/a"}`,
        `- Timeout: ${failure.timeout_detected ? "yes" : "no"}`,
        `- Artifacts: \`${failure.artifactDir}\``,
        `- Re-run: \`${failure.rerun_command}\``
      );
    }
  }
  markdown.push("", "## Skipped Tests");
  if (summary.skippedTests.length === 0) {
    markdown.push("", "None.");
  } else {
    for (const skippedTest of summary.skippedTests) {
      markdown.push(
        "",
        `### ${skippedTest.name}`,
        `- Test ID: \`${skippedTest.testId}\``,
        `- File: \`${skippedTest.file}\``,
        `- Reason: ${skippedTest.skip_reason}`,
        `- Artifacts: \`${skippedTest.artifactDir}\``,
        `- Re-run: \`${skippedTest.rerun_command}\``
      );
    }
  }
  markdown.push("", "## Artifact Directories", "");
  for (const artifact of [...testArtifacts.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    markdown.push(`- \`${artifact.name}\` → \`${artifact.artifactDir}\``);
  }
  fs.writeFileSync(path.join(RUNS_DIR, runId, "summary.md"), markdown.join("\n") + "\n");

  logStream.write(JSON.stringify(summary) + "\n");
  logStream.end();

  yield `\n─────────────────────────────────────\n`;
  yield `  ${passed} passed, ${failed} failed, ${skipped} skipped (${results.length} total)\n`;
  yield `  Duration: ${(totalDuration / 1000).toFixed(1)}s\n`;
  yield `  Results:  ${LOG_PATH}\n`;
  yield `─────────────────────────────────────\n`;
}
