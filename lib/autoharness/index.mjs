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

function isVerificationCommand(command = "") {
  const text = String(command || "").trim().toLowerCase();
  if (!text) return false;
  return (
    /\b(node\s+--test|npm\s+test|npm\s+run\s+test|pnpm\s+test|pnpm\s+run\s+test|yarn\s+test|pytest|go\s+test|cargo\s+test|bun\s+test)\b/.test(text) ||
    /\b(tsc\b|tsc\s+--noemit|npm\s+run\s+build|pnpm\s+build|yarn\s+build|vite\s+build|next\s+build|npm\s+run\s+lint|pnpm\s+lint|yarn\s+lint)\b/.test(text)
  );
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function scoreTaskTrajectory(trace = {}) {
  const actions = Array.isArray(trace.actions) ? trace.actions : [];
  const commands = actions.filter((action) => action?.tool === "run_cmd");
  const verificationCommands = commands.filter((action) => isVerificationCommand(action.command));
  const writeActions = actions.filter((action) => action?.tool === "write_file" || action?.tool === "append_file");
  const readActions = actions.filter((action) => action?.tool === "read_file");

  const commandPrefixCounts = new Map();
  const targetCounts = new Map();
  for (const action of actions) {
    if (action?.commandPrefix) {
      commandPrefixCounts.set(action.commandPrefix, (commandPrefixCounts.get(action.commandPrefix) || 0) + 1);
    }
    if (action?.target) {
      targetCounts.set(action.target, (targetCounts.get(action.target) || 0) + 1);
    }
  }

  const repeatedCommandPrefixes = [...commandPrefixCounts.values()].filter((count) => count > 1).length;
  const repeatedTargets = [...targetCounts.values()].filter((count) => count > 1).length;
  const uniqueTools = new Set(actions.map((action) => action?.tool).filter(Boolean)).size;
  const readBeforeWriteRatio = writeActions.length === 0
    ? 1
    : clamp01(readActions.length / writeActions.length);
  const verificationScore = commands.length === 0
    ? 0
    : clamp01(verificationCommands.length / commands.length);
  const churnPenalty = clamp01((repeatedCommandPrefixes * 0.12) + (repeatedTargets * 0.08));
  const diversityScore = clamp01(uniqueTools / 4);

  let score = 0;
  score += trace.success ? 0.45 : 0.15;
  score += verificationScore * 0.20;
  score += readBeforeWriteRatio * 0.20;
  score += diversityScore * 0.15;
  score -= churnPenalty;

  return {
    actionCount: actions.length,
    commandCount: commands.length,
    verificationCommandCount: verificationCommands.length,
    hasVerification: verificationCommands.length > 0,
    writeCount: writeActions.length,
    readCount: readActions.length,
    uniqueToolCount: uniqueTools,
    repeatedCommandPrefixes,
    repeatedTargets,
    readBeforeWriteRatio: Number(readBeforeWriteRatio.toFixed(3)),
    verificationScore: Number(verificationScore.toFixed(3)),
    trajectoryScore: Number(clamp01(score).toFixed(3)),
  };
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
  metrics,
}) {
  if (!agentId) return;
  const paths = getAutoHarnessPaths(agentId, projectId);
  if (!paths) return;
  const { taskTraceFile } = paths;
  const actions = extractToolActions(reply);
  const derivedMetrics = scoreTaskTrajectory({
    success: Boolean(success),
    actions,
  });
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
    actions,
    metrics: metrics && typeof metrics === "object"
      ? { ...derivedMetrics, ...metrics }
      : derivedMetrics,
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
  const taskTraces = loadJsonl(paths.taskTraceFile);

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

  const taskMetrics = taskTraces
    .map((trace) => trace?.metrics && typeof trace.metrics === "object"
      ? trace.metrics
      : scoreTaskTrajectory(trace))
    .filter(Boolean);

  const taskStats = {
    tasks: taskMetrics.length,
    avgTrajectoryScore: taskMetrics.length
      ? Number((taskMetrics.reduce((sum, item) => sum + Number(item.trajectoryScore || 0), 0) / taskMetrics.length).toFixed(3))
      : 0,
    verificationRate: taskMetrics.length
      ? Number((taskMetrics.filter((item) => item.hasVerification).length / taskMetrics.length).toFixed(3))
      : 0,
    avgReadBeforeWriteRatio: taskMetrics.length
      ? Number((taskMetrics.reduce((sum, item) => sum + Number(item.readBeforeWriteRatio || 0), 0) / taskMetrics.length).toFixed(3))
      : 0,
  };

  return {
    harness,
    stats: {
      ...stats,
      precision: Number(precision.toFixed(3)),
      recall: Number(recall.toFixed(3)),
      taskStats,
    },
  };
}

/**
 * Extract trajectory feedback from task traces for the adaptive weight system.
 * Returns data in the format expected by action-ranking.ts loadAdaptiveWeights().
 */
export function extractTrajectoryFeedback(agentId, projectId = "global") {
  const paths = getAutoHarnessPaths(agentId, projectId);
  if (!paths) return [];

  const taskTraces = loadJsonl(paths.taskTraceFile);
  if (!taskTraces.length) return [];

  const READ_TOOLS = new Set(["read_file", "read_many_files", "glob", "grep_search", "list_directory", "lsp"]);
  const SEARCH_TOOLS = new Set(["grep_search", "glob", "search_files", "find_definition"]);
  const EDIT_TOOLS = new Set(["replace", "edit", "append_file", "write_file", "notebook_edit"]);
  const SHELL_TOOLS = new Set(["run_shell_command", "shell", "run_cmd", "check_background_task"]);

  function classifyAction(tool) {
    if (READ_TOOLS.has(tool)) return "read";
    if (SEARCH_TOOLS.has(tool)) return "search";
    if (EDIT_TOOLS.has(tool)) return "edit";
    if (SHELL_TOOLS.has(tool)) return "verify";
    return null;
  }

  function detectMode(task = "") {
    const t = task.toLowerCase();
    if (/(failing tests?|test failure|fix tests?|fix the test|test.*(fail|broken))/.test(t)) return "test_repair";
    if (/(fix|bug|broken|error|regression|crash)/.test(t)) return "bugfix";
    if (/(refactor|cleanup|restructure|rename|simplify)/.test(t)) return "refactor";
    if (/(add|implement|create|build|support|introduce)/.test(t)) return "feature";
    return "analysis";
  }

  return taskTraces.map((trace) => {
    const actions = Array.isArray(trace.actions) ? trace.actions : [];
    const total = actions.length || 1;
    const dist = { read: 0, search: 0, edit: 0, test: 0, build: 0, verify: 0, delegate: 0 };

    for (const action of actions) {
      const type = classifyAction(action?.tool);
      if (type && type in dist) dist[type] += 1 / total;
    }

    const metrics = trace.metrics || scoreTaskTrajectory(trace);
    return {
      mode: detectMode(trace.task || trace.agentId || ""),
      score: Number(metrics.trajectoryScore || 0),
      toolDistribution: dist,
      success: Boolean(trace.success),
    };
  });
}
