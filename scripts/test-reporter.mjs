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
import { buildDependencySnapshot, getWorkspaceState } from "./test-blast-radius.mjs";

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
const workspaceStateAtRunStart = getWorkspaceState();

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

function compactText(value) {
  return truncate(String(value ?? "").replace(/\s+/g, " ").trim());
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

function buildSelector(filePath, testName) {
  return {
    file: filePath || null,
    test_name: testName || null,
    test_name_pattern: testName || null,
    command: buildRerunCommand(filePath, testName),
  };
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

function artifactPath(testId, filename) {
  return path.join(getArtifactDir(testId), filename);
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

function readEvidence(testId) {
  const evidencePath = artifactPath(testId, "evidence.jsonl");
  if (!fs.existsSync(evidencePath)) return [];
  try {
    return fs.readFileSync(evidencePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function collectTestContext(testId) {
  const evidence = readEvidence(testId);
  const engineContext = [...evidence].reverse().find((entry) => entry.category === "engine_context") || null;
  const latestHttp = [...evidence].reverse().find((entry) => entry.category === "http") || null;
  const latestFileVerification = [...evidence].reverse().find((entry) => entry.category === "file_verification") || null;
  const latestTimeout = [...evidence].reverse().find((entry) =>
    entry.category === "task_timeout" || entry.category === "passthrough_timeout"
  ) || null;
  const latestPassthroughError = [...evidence].reverse().find((entry) => entry.category === "passthrough_error") || null;
  const latestWorkflowEvent = [...evidence].reverse().find((entry) =>
    /workflow|dispatch|task/i.test(String(entry.category || ""))
  ) || null;
  return {
    evidence_count: evidence.length,
    engine_context: engineContext,
    latest_http: latestHttp,
    latest_file_verification: latestFileVerification,
    latest_timeout: latestTimeout,
    latest_passthrough_error: latestPassthroughError,
    latest_workflow_event: latestWorkflowEvent,
  };
}

function extractSkipReason(data = {}) {
  return data.skipReason ||
    data.skip ||
    data.details?.skipReason ||
    data.details?.skip ||
    (data.details?.skipped ? data.details?.message || "skipped" : null) ||
    (data.details?.status === "skipped" ? data.details?.message || "skipped" : null) ||
    null;
}

function classifyFailure(entry, context) {
  const errorText = compactText([
    entry.error,
    entry.error_name,
    entry.error_code,
    context.latest_timeout?.error,
    context.latest_passthrough_error?.error,
    context.latest_http?.error,
    context.latest_workflow_event?.last_result_preview,
  ].filter(Boolean).join(" | "));

  const checks = [
    {
      code: "timeout",
      matches: /timeout|timed out|did not finish|deadline exceeded/i,
      summary: "test or engine timed out",
    },
    {
      code: "cancelled",
      matches: /cancelled|canceled|abort|aborted/i,
      summary: "test was cancelled",
    },
    {
      code: "agent_unreachable",
      matches: /rt bus not connected|agent unreachable|econnrefused|connect econrefused|socket hang up/i,
      summary: "agent or service was unreachable",
    },
    {
      code: "missing_task_id",
      matches: /no taskid|missing taskid/i,
      summary: "dispatch returned no task id",
    },
    {
      code: "file_missing",
      matches: /should exist|file not found|enoent/i,
      summary: "expected output file was missing",
    },
    {
      code: "empty_response",
      matches: /non-empty response|returned nothing|response length/i,
      summary: "engine returned an empty or unusable response",
    },
    {
      code: "http_error",
      matches: /dispatch failed: \d+|http|status code|unexpected status/i,
      summary: "http request or api contract failed",
    },
    {
      code: "assertion",
      matches: /assert|expected .* got/i,
      summary: "assertion failed",
    },
  ];

  const match = checks.find((item) => item.matches.test(errorText));
  return {
    reason_code: match?.code || "unknown_failure",
    reason_summary: match?.summary || "unclassified failure",
    reason_detail: errorText || "no detailed failure message captured",
  };
}

function classifySkip(entry) {
  const reasonText = compactText(entry.skip_reason || "skipped");
  const checks = [
    {
      code: "service_down",
      matches: /not running|service unavailable|health check/i,
      summary: "required local service was not running",
    },
    {
      code: "engine_unavailable",
      matches: /not available|not installed|missing/i,
      summary: "required engine or dependency was unavailable",
    },
    {
      code: "explicit_skip",
      matches: /skip|skipped/i,
      summary: "test was skipped intentionally",
    },
  ];
  const match = checks.find((item) => item.matches.test(reasonText));
  return {
    reason_code: match?.code || "unknown_skip",
    reason_summary: match?.summary || "unclassified skip",
    reason_detail: reasonText,
  };
}

export { buildSelector, classifyFailure, classifySkip };

function buildFailureBundle(entry) {
  const context = collectTestContext(entry.testId);
  const classification = classifyFailure(entry, context);
  const engineRuntime = context.engine_context?.engine_runtime || {};
  const agentRuntime = context.engine_context?.agent_runtime || {};
  return {
    ...entry,
    ...classification,
    selector: buildSelector(entry.file, entry.name),
    isolation: {
      isolated_rerun_command: entry.rerun_command,
      latest_http_status: context.latest_http?.status ?? null,
      latest_http_operation: context.latest_http?.operation ?? null,
      latest_timeout_ms: context.latest_timeout?.timeout_ms ?? context.engine_context?.timeout_ms ?? null,
      evidence_count: context.evidence_count,
    },
    engine: {
      engine: context.engine_context?.engine || entry.engine || null,
      provider: engineRuntime.provider || agentRuntime.provider || null,
      model: agentRuntime.model || agentRuntime.cursorCliModel || agentRuntime.opencodeModel || null,
      agent: context.engine_context?.agent || null,
      binary_path: engineRuntime.binary?.path || null,
      binary_version: engineRuntime.binary?.version || null,
      route_flags: agentRuntime.routeFlags || null,
      enabled_route: agentRuntime.enabledRoute || null,
    },
    artifacts: {
      artifact_dir: entry.artifactDir,
      manifest_json: artifactPath(entry.testId, "manifest.json"),
      failure_json: artifactPath(entry.testId, "failure.json"),
      evidence_jsonl: artifactPath(entry.testId, "evidence.jsonl"),
      triage_json: artifactPath(entry.testId, "triage.json"),
    },
    latest_evidence: {
      http: context.latest_http || null,
      file_verification: context.latest_file_verification || null,
      timeout: context.latest_timeout || null,
      passthrough_error: context.latest_passthrough_error || null,
      workflow: context.latest_workflow_event || null,
    },
  };
}

function buildSkipBundle(entry) {
  const classification = classifySkip(entry);
  return {
    ...entry,
    ...classification,
    selector: buildSelector(entry.file, entry.name),
    isolation: {
      isolated_rerun_command: entry.rerun_command,
    },
    artifacts: {
      artifact_dir: entry.artifactDir,
      manifest_json: artifactPath(entry.testId, "manifest.json"),
      evidence_jsonl: artifactPath(entry.testId, "evidence.jsonl"),
      triage_json: artifactPath(entry.testId, "triage.json"),
    },
  };
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
  workspace_state: workspaceStateAtRunStart,
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
        selector: buildSelector(event.data.file, event.data.name),
        dependency_snapshot: buildDependencySnapshot(event.data.file),
      };
      upsertTestArtifact({
        testId,
        artifactDir,
        name: event.data.name,
        file: event.data.file,
        status: "start",
        line: event.data.line ?? null,
        column: event.data.column ?? null,
        dependency_snapshot: startEntry.dependency_snapshot,
      });
      writeArtifactJson(testId, "manifest.json", startEntry);
      logStream.write(JSON.stringify(startEntry) + "\n");
    }

    if (event.type === "test:pass" || event.type === "test:fail") {
      // Only log leaf tests (not suite/describe wrappers)
      if (event.data.details?.type === "suite") continue;

      const inferredSkipReason = event.type === "test:pass" ? extractSkipReason(event.data) : null;
      const status = inferredSkipReason ? "skip" : event.type === "test:pass" ? "pass" : "fail";
      const duration = event.data.details?.duration_ms ?? 0;
      totalDuration += duration;

      if (status === "pass") passed++;
      else if (status === "skip") skipped++;
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
        selector: buildSelector(event.data.file, event.data.name),
        dependency_snapshot: (testArtifacts.get(buildTestId(event.data.file, event.data.name)) || {}).dependency_snapshot || buildDependencySnapshot(event.data.file),
        ...(status === "skip" ? { skip_reason: truncate(inferredSkipReason || "skipped") } : {}),
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
        writeArtifactJson(entry.testId, "triage.json", buildFailureBundle(entry));
      } else if (status === "skip") {
        writeArtifactJson(entry.testId, "triage.json", buildSkipBundle(entry));
      }
      logStream.write(JSON.stringify(entry) + "\n");
    }

    if (event.type === "test:skip") {
      if (event.data.details?.type === "suite") continue;
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
        skip_reason: truncate(extractSkipReason(event.data) || "skipped"),
        rerun_command: buildRerunCommand(event.data.file, event.data.name),
        selector: buildSelector(event.data.file, event.data.name),
        dependency_snapshot: (testArtifacts.get(buildTestId(event.data.file, event.data.name)) || {}).dependency_snapshot || buildDependencySnapshot(event.data.file),
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
      writeArtifactJson(entry.testId, "triage.json", buildSkipBundle(entry));
      logStream.write(JSON.stringify(entry) + "\n");
    }

    // Pass through to default spec output
    if (event.type === "test:pass" && extractSkipReason(event.data)) {
      yield `  - ${event.data.name} (skipped)\n`;
    } else if (event.type === "test:pass") {
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
    workspace_state_at_run_start: workspaceStateAtRunStart,
    tests: results.map((r) => ({
      testId: r.testId,
      name: r.name,
      file: r.file,
      status: r.status,
      artifactDir: r.artifactDir,
      rerun_command: r.rerun_command,
      reason_code: r.reason_code || null,
      reason_summary: r.reason_summary || null,
      skip_reason: r.skip_reason || null,
      dependency_snapshot: r.dependency_snapshot || null,
      engine: r.engine || null,
    })),
    failedTests: results
      .filter((r) => r.status === "fail")
      .map((r) => buildFailureBundle(r)),
    skippedTests: results
      .filter((r) => r.status === "skip")
      .map((r) => buildSkipBundle(r)),
  };
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2) + "\n");
  fs.writeFileSync(path.join(RUNS_DIR, runId, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  fs.writeFileSync(path.join(RUNS_DIR, runId, "failures.json"), JSON.stringify(summary.failedTests, null, 2) + "\n");
  fs.writeFileSync(path.join(RUNS_DIR, runId, "skips.json"), JSON.stringify(summary.skippedTests, null, 2) + "\n");
  fs.writeFileSync(path.join(RUNS_DIR, runId, "rerun-plan.json"), JSON.stringify({
    runId,
    generated_at: new Date().toISOString(),
    failed: summary.failedTests.map((test) => ({
      testId: test.testId,
      name: test.name,
      reason_code: test.reason_code,
      reason_summary: test.reason_summary,
      rerun_command: test.rerun_command,
    })),
    skipped: summary.skippedTests.map((test) => ({
      testId: test.testId,
      name: test.name,
      reason_code: test.reason_code,
      reason_summary: test.reason_summary,
      rerun_command: test.rerun_command,
    })),
  }, null, 2) + "\n");

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
        `- Reason Code: ${failure.reason_code}`,
        `- Reason Summary: ${failure.reason_summary}`,
        `- Timeout: ${failure.timeout_detected ? "yes" : "no"}`,
        `- Engine: ${failure.engine.engine || "n/a"}`,
        `- Provider: ${failure.engine.provider || "n/a"}`,
        `- Model: ${failure.engine.model || "n/a"}`,
        `- Agent: ${failure.engine.agent || "n/a"}`,
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
        `- Reason Code: ${skippedTest.reason_code}`,
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
