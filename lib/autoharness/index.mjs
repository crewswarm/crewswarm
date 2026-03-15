import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getStatePath } from "../runtime/paths.mjs";

function isAutoHarnessDisabled() {
  const flag = String(process.env.CREWSWARM_DISABLE_AUTOHARNESS || "").trim().toLowerCase();
  return flag === "1" || flag === "true" || process.env.NODE_ENV === "test";
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function canWriteDir(dir) {
  const probe = path.join(dir, `.write-test-${process.pid}-${Date.now()}`);
  try {
    ensureDir(dir);
    fs.writeFileSync(probe, "", "utf8");
    fs.unlinkSync(probe);
    return true;
  } catch {
    try {
      if (fs.existsSync(probe)) fs.unlinkSync(probe);
    } catch {}
    return false;
  }
}

function resolveAutoHarnessRoot() {
  if (isAutoHarnessDisabled()) return null;
  const preferred = getStatePath("autoharness");
  if (canWriteDir(preferred)) return preferred;
  const fallback = path.join(os.tmpdir(), "crewswarm-autoharness");
  ensureDir(fallback);
  return fallback;
}

function safeKey(value, fallback = "global") {
  return String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || fallback;
}

function appendJsonl(file, entry) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
}

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function loadJsonl(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function normalizeCommandPrefix(command = "") {
  const text = String(command || "").trim().toLowerCase();
  if (!text) return "";
  const parts = text.split(/\s+/).slice(0, 2);
  return parts.join(" ");
}

function classifyFailureReason(text = "") {
  const msg = String(text || "");
  if (/dangerous command/i.test(msg)) return "dangerous_command";
  if (/rejected or timed out/i.test(msg)) return "approval_rejected";
  if (/does not have .* permission/i.test(msg)) return "permission_denied";
  if (/cannot read|failed to write|failed to append|failed:/i.test(msg)) return "io_failure";
  if (/CODING_ARTIFACT_MISSING/i.test(msg)) return "artifact_missing";
  return "generic_failure";
}

export function getAutoHarnessPaths(agentId, projectId = "global") {
  const rootDir = resolveAutoHarnessRoot();
  if (!rootDir) return null;
  const agentKey = safeKey(agentId, "agent");
  const projectKey = safeKey(projectId, "global");
  const rulesDir = ensureDir(path.join(rootDir, "rules", agentKey));
  const tracesDir = ensureDir(path.join(rootDir, "traces", agentKey));
  return {
    rootDir,
    rulesDir,
    tracesDir,
    rulesFile: path.join(rulesDir, `${projectKey}.json`),
    taskTraceFile: path.join(tracesDir, `${projectKey}.tasks.jsonl`),
    toolTraceFile: path.join(tracesDir, `${projectKey}.tools.jsonl`),
  };
}

export function extractToolActions(reply = "") {
  const text = String(reply || "");
  const actions = [];
  let match;

  const writeRe = /@@WRITE_FILE[ \t]+([^\n]+)\n([\s\S]*?)@@END_FILE/g;
  while ((match = writeRe.exec(text)) !== null) {
    actions.push({
      tool: "write_file",
      target: match[1].trim(),
      bytes: match[2].length,
    });
  }

  const appendRe = /@@APPEND_FILE[ \t]+([^\n]+)\n([\s\S]*?)@@END_FILE/g;
  while ((match = appendRe.exec(text)) !== null) {
    actions.push({
      tool: "append_file",
      target: match[1].trim(),
      bytes: match[2].length,
    });
  }

  const readRe = /@@READ_FILE[ \t]+([^\n@@]+)/g;
  while ((match = readRe.exec(text)) !== null) {
    actions.push({
      tool: "read_file",
      target: match[1].trim(),
    });
  }

  const mkdirRe = /@@MKDIR[ \t]+([^\n@@]+)/g;
  while ((match = mkdirRe.exec(text)) !== null) {
    actions.push({
      tool: "mkdir",
      target: match[1].trim(),
    });
  }

  const cmdRe = /@@RUN_CMD[ \t]+([^\n]+)/g;
  while ((match = cmdRe.exec(text)) !== null) {
    const command = match[1].trim();
    actions.push({
      tool: "run_cmd",
      command,
      commandPrefix: normalizeCommandPrefix(command),
    });
  }

  return actions;
}

export function recordTaskTrace({
  agentId,
  projectId = "global",
  taskId,
  incomingType,
  prompt,
  reply,
  error,
  engineUsed,
  success,
}) {
  if (!agentId) return;
  const paths = getAutoHarnessPaths(agentId, projectId);
  if (!paths) return;
  const { taskTraceFile } = paths;
  appendJsonl(taskTraceFile, {
    ts: new Date().toISOString(),
    agentId,
    projectId,
    taskId,
    incomingType,
    prompt: String(prompt || "").slice(0, 4000),
    reply: String(reply || "").slice(0, 4000),
    error: error ? String(error).slice(0, 2000) : null,
    errorClass: classifyFailureReason(error),
    engineUsed: engineUsed || null,
    success: Boolean(success),
    actions: extractToolActions(reply),
  });
}

export function recordToolTrace({
  agentId,
  projectId = "global",
  taskId,
  tool,
  target,
  command,
  outcome,
  reason,
}) {
  if (!agentId || !tool) return;
  const paths = getAutoHarnessPaths(agentId, projectId);
  if (!paths) return;
  const { toolTraceFile } = paths;
  appendJsonl(toolTraceFile, {
    ts: new Date().toISOString(),
    agentId,
    projectId,
    taskId,
    tool,
    target: target || null,
    command: command || null,
    commandPrefix: command ? normalizeCommandPrefix(command) : null,
    outcome: outcome || "unknown",
    reason: reason || null,
    reasonClass: classifyFailureReason(reason),
  });
}

export function loadHarness(agentId, projectId = "global") {
  if (!agentId) return null;
  const projectPaths = getAutoHarnessPaths(agentId, projectId);
  if (!projectPaths) return null;
  const globalPaths = getAutoHarnessPaths(agentId, "global");
  return loadJson(projectPaths.rulesFile, null) || loadJson(globalPaths?.rulesFile, null);
}

export function evaluateHarnessAction(agentId, projectId, action) {
  const harness = loadHarness(agentId, projectId);
  if (!harness || !Array.isArray(harness.rules) || !action?.tool) {
    return { allowed: true, harness: null, rule: null };
  }

  for (const rule of harness.rules) {
    if (rule.tool !== action.tool) continue;
    if (rule.commandPrefix && rule.commandPrefix !== normalizeCommandPrefix(action.command)) continue;
    if (rule.targetPrefix && !String(action.target || "").startsWith(rule.targetPrefix)) continue;
    return {
      allowed: rule.action !== "block",
      harness,
      rule,
    };
  }

  return { allowed: true, harness, rule: null };
}

export function synthesizeHarness(agentId, projectId = "global", { minFailures = 2 } = {}) {
  const paths = getAutoHarnessPaths(agentId, projectId);
  if (!paths) return null;
  const { toolTraceFile, rulesFile } = paths;
  const traces = loadJsonl(toolTraceFile);
  const grouped = new Map();

  for (const trace of traces) {
    if (!trace?.tool) continue;
    const isBadOutcome =
      trace.outcome === "blocked" ||
      trace.outcome === "rejected" ||
      trace.outcome === "failed";
    if (!isBadOutcome) continue;

    const key =
      trace.tool === "run_cmd" && trace.commandPrefix
        ? `run_cmd:${trace.commandPrefix}`
        : trace.target
          ? `${trace.tool}:target:${trace.target}`
          : `${trace.tool}:misc`;

    const existing = grouped.get(key) || {
      tool: trace.tool,
      commandPrefix: trace.commandPrefix || null,
      targetPrefix: trace.target || null,
      failures: 0,
      reasons: new Set(),
    };
    existing.failures++;
    if (trace.reasonClass) existing.reasons.add(trace.reasonClass);
    grouped.set(key, existing);
  }

  const rules = [];
  for (const entry of grouped.values()) {
    if (entry.failures < minFailures) continue;
    if (entry.tool === "run_cmd" && entry.commandPrefix) {
      rules.push({
        id: `${entry.tool}-${entry.commandPrefix.replace(/[^a-z0-9]+/gi, "-")}`,
        tool: entry.tool,
        commandPrefix: entry.commandPrefix,
        action: "block",
        reason: `Observed ${entry.failures} repeated failing/rejected executions (${[...entry.reasons].join(", ") || "generic_failure"}).`,
      });
    } else if (entry.targetPrefix) {
      rules.push({
        id: `${entry.tool}-${safeKey(entry.targetPrefix, "target")}`,
        tool: entry.tool,
        targetPrefix: entry.targetPrefix,
        action: "block",
        reason: `Observed ${entry.failures} repeated failing actions on this target.`,
      });
    }
  }

  const harness = {
    version: 1,
    agentId,
    projectId,
    generatedAt: new Date().toISOString(),
    minFailures,
    traceCount: traces.length,
    rules,
  };

  ensureDir(path.dirname(rulesFile));
  fs.writeFileSync(rulesFile, JSON.stringify(harness, null, 2), "utf8");
  return harness;
}

export function scoreHarness(agentId, projectId = "global") {
  const harness = loadHarness(agentId, projectId);
  const paths = getAutoHarnessPaths(agentId, projectId);
  if (!paths) {
    return {
      harness,
      stats: {
        traces: 0,
        predictedBlocks: 0,
        badOutcomes: 0,
        blockedBadOutcomes: 0,
        falseBlocks: 0,
        precision: 0,
        recall: 0,
      },
    };
  }
  const { toolTraceFile } = paths;
  const traces = loadJsonl(toolTraceFile);

  const stats = {
    traces: traces.length,
    predictedBlocks: 0,
    badOutcomes: 0,
    blockedBadOutcomes: 0,
    falseBlocks: 0,
  };

  for (const trace of traces) {
    const badOutcome =
      trace.outcome === "blocked" ||
      trace.outcome === "rejected" ||
      trace.outcome === "failed";
    if (badOutcome) stats.badOutcomes++;

    const action = {
      tool: trace.tool,
      target: trace.target,
      command: trace.command,
    };
    const decision = harness
      ? evaluateHarnessAction(agentId, projectId, action)
      : { allowed: true };
    if (!decision.allowed) {
      stats.predictedBlocks++;
      if (badOutcome) stats.blockedBadOutcomes++;
      else stats.falseBlocks++;
    }
  }

  const precision =
    stats.predictedBlocks > 0
      ? stats.blockedBadOutcomes / stats.predictedBlocks
      : 0;
  const recall =
    stats.badOutcomes > 0 ? stats.blockedBadOutcomes / stats.badOutcomes : 0;

  return {
    harness,
    stats: {
      ...stats,
      precision: Number(precision.toFixed(3)),
      recall: Number(recall.toFixed(3)),
    },
  };
}
