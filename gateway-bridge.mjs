#!/usr/bin/env node
/**
 * crewswarm Gateway Bridge — agent daemon for real-time LLM calls and tool execution.
 *
 * Usage:
 *   node gateway-bridge.mjs "your message here"
 *   node gateway-bridge.mjs --status
 *   node gateway-bridge.mjs --reset
 *   node gateway-bridge.mjs --history
 *   CREWSWARM_ONE_SHOT=1 node gateway-bridge.mjs "task"  # Exit after task (fresh context)
 */
import { WebSocket } from "ws";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { getProjectDir } from "./lib/project-dir.mjs";
import { rewriteTaskPathsRelativeToProjectRoot } from "./lib/runtime/project-dir.mjs";
import { COORDINATOR_AGENT_IDS } from "./lib/agent-registry.mjs";
import {
  isSharedMemoryAvailable,
  initSharedMemory,
  recallMemoryContext,
  recordTaskMemory,
  rememberFact,
  CREW_MEMORY_DIR,
} from "./lib/memory/shared-adapter.mjs";
import {
  resolveConfig,
  resolveTelegramBridgeConfig,
  loadAgentList,
  loadAgentLLMConfig,
  loadLoopBrainConfig,
  loadProviderMap,
  CREWSWARM_RT_SWARM_AGENTS,
  RT_TO_GATEWAY_AGENT_MAP,
} from "./lib/agents/registry.mjs";
import {
  validateCodingArtifacts,
  assertTaskPromptProtocol,
  initValidation,
} from "./lib/agents/validation.mjs";
import {
  spawnAgentDaemon,
  isAgentDaemonRunning,
  readPid,
  resolveSpawnTargets,
} from "./lib/agents/daemon.mjs";
import {
  acquireTaskLease,
  renewTaskLease,
  releaseTaskLease,
  markTaskDone,
  dispatchKeyForTask,
  shouldUseDispatchGuard,
  shouldRetryTaskFailure,
  isCodingTask,
} from "./lib/agents/dispatch.mjs";

// ── One-shot mode: exit after task completion (fresh context) ────────────────
const ONE_SHOT = process.env.CREWSWARM_ONE_SHOT === '1' || process.argv.includes('--one-shot');
import {
  CREWSWARM_RT_URL,
  CREWSWARM_RT_AGENT,
  CREWSWARM_RT_TOKEN,
  CREWSWARM_RT_CHANNELS,
  CREWSWARM_RT_TLS_INSECURE,
  CREWSWARM_RT_RECONNECT_MS,
  CREWSWARM_RT_DISPATCH_LEASE_MS,
  CREWSWARM_RT_DISPATCH_HEARTBEAT_MS,
  CREWSWARM_RT_DISPATCH_MAX_RETRIES,
  CREWSWARM_RT_DISPATCH_MAX_RETRIES_CODING,
  CREWSWARM_RT_DISPATCH_RETRY_BACKOFF_MS,
  CREWSWARM_OPENCODE_ENABLED,
  CREWSWARM_OPENCODE_BIN,
  CREWSWARM_OPENCODE_AGENT,
  CREWSWARM_OPENCODE_MODEL,
  CREWSWARM_OPENCODE_FALLBACK_DEFAULT,
  CREWSWARM_OPENCODE_TIMEOUT_MS,
  loadGenericEngines,
  SHARED_MEMORY_BASE,
  SHARED_MEMORY_NAMESPACE,
  SWARM_STATUS_LOG,
  SWARM_DISPATCH_DIR,
  SWARM_DLQ_DIR,
  SWARM_RUNTIME_DIR,
  CREWSWARM_RT_COMMAND_TYPES,
  PROTOCOL_VERSION,
  CLI_VERSION,
  RUN_ID,
  GATEWAY_URL,
  TELEMETRY_DIR,
  LEGACY_STATE_DIR,
  CREWSWARM_CONFIG_PATH,
  MEMORY_BOOTSTRAP_AGENT,
  ED25519_SPKI_PREFIX,
  REQUEST_TIMEOUT_MS,
  CHAT_TIMEOUT_MS,
  loadSystemConfig,
  loadSwarmConfig,
} from "./lib/runtime/config.mjs";
import {
  TELEMETRY_LOG,
  formatError,
  formatDuration,
  median,
  percentile,
  readTelemetryEvents,
} from "./lib/runtime/utils.mjs";
import {
  initTaskLease,
  ensureSwarmRuntimeDirs,
  parseTaskState,
  taskIdentity,
  taskKeyFor,
  leasePath,
  taskStatePath,
  lockPath,
  withTaskLock,
  clearStaleTaskState,
  claimTaskLease,
  startTaskLeaseHeartbeat,
  finalizeTaskState,
  releaseRuntimeTaskLease,
} from "./lib/runtime/task-lease.mjs";
import {
  initTools,
  setRtClient,
  pendingCmdApprovals,
  isAutoApproveAgent,
  loadAgentToolPermissions,
  buildToolInstructions,
  loadCmdAllowlist,
  isCommandBlocked,
  isCommandAllowlisted,
  sanitizeToolPath,
  executeToolCalls,
} from "./lib/tools/executor.mjs";
import {
  initSpending,
  loadSpending,
  saveSpending,
  addAgentSpend,
  checkSpendingCap,
  notifyTelegramSpending,
  tokenUsage,
  recordTokenUsage,
} from "./lib/runtime/spending.mjs";
import {
  initSkills,
  resolveSkillAlias,
  loadSkillDef,
  loadPendingSkills,
  savePendingSkills,
  executeSkill,
  notifyTelegramSkillApproval,
} from "./lib/skills/index.mjs";
import {
  initMemory,
  SHARED_MEMORY_DIR,
  SHARED_MEMORY_MAX_FILE_CHARS,
  SHARED_MEMORY_MAX_TOTAL_CHARS,
  SHARED_MEMORY_FILES,
  _AGENT_EXTRA_MEMORY_STATIC,
  _EXTRA_MEMORY_BY_ROLE,
  getAgentExtraMemory,
  loadSharedMemoryBundle,
  getLastHandoffTimestamp,
  loadAgentPrompts,
  buildTaskPrompt,
} from "./lib/runtime/memory.mjs";
import {
  initOuroboros,
  runOuroborosStyleLoop,
} from "./lib/engines/ouroboros.mjs";
import { initRtEnvelope, handleRealtimeEnvelope } from "./lib/engines/rt-envelope.mjs";
import {
  initRunners,
  setRtClientForRunners,
  selectEngine,
  shouldUseCursorCli,
  shouldUseClaudeCode,
  shouldUseOpenCode,
  shouldUseCodex,
  shouldUseGeminiCli,
  shouldUseCrewCLI,
  runGeminiCliTask,
  shouldUseGenericEngine,
  runGenericEngineTask,
  runCursorCliTask,
  runCodexTask,
  shouldUseDockerSandbox,
  runDockerSandboxTask,
  runClaudeCodeTask,
  _rtClientForApprovals,
} from "./lib/engines/runners.mjs";
import { initCrewCLI, runCrewCLITask } from "./lib/engines/crew-cli.mjs";
import { initLlmDirect, callLLMDirect } from "./lib/engines/llm-direct.mjs";
import { initOpenCode, runOpenCodeTask } from "./lib/engines/opencode.mjs";
import { initGatewayWs } from "./lib/bridges/gateway-ws.mjs";

// Wire injected deps into extracted modules
initTaskLease({ telemetry, sleep, parseJsonSafe });
initTools({
  resolveConfig, resolveTelegramBridgeConfig, loadAgentList, getOpencodeProjectDir,
  loadSkillDef, loadPendingSkills, savePendingSkills, notifyTelegramSkillApproval, executeSkill
});
initSpending({ resolveConfig, resolveTelegramBridgeConfig });
initSkills({ resolveConfig, resolveTelegramBridgeConfig });
initMemory({ telemetry, ensureSharedMemoryFiles, loadAgentList, loadAgentToolPermissions, buildToolInstructions, getOpencodeProjectDir });
initValidation({ telemetry });

// Initialize shared memory (CLI-style) for cross-system memory sharing
const sharedMemoryInit = initSharedMemory();
if (sharedMemoryInit.ok) {
  console.log(`[gateway-bridge] Shared memory initialized: ${sharedMemoryInit.path}`);
  if (!isSharedMemoryAvailable()) {
    console.warn('[gateway-bridge] CLI memory modules not available — run: cd crew-cli && npm run build');
  } else {
    console.log('[gateway-bridge] CLI shared memory integration enabled (AgentKeeper + AgentMemory + MemoryBroker)');
  }
} else {
  console.warn(`[gateway-bridge] Shared memory init failed: ${sharedMemoryInit.error}`);
}

function getOpencodeProjectDir() {
  return getProjectDir("") || "";
}

// ── Per-agent OpenCode session persistence ─────────────────────────────────
// Each agent maintains a session ID so `opencode run -s <id>` continues from
// where the last task left off, rather than starting cold every time.
// Sessions are stored in ~/.crewswarm/sessions/<agentId>.session
const OPENCODE_SESSION_DIR = path.join(os.homedir(), ".crewswarm", "sessions");

// Free OpenCode models for fallback rotation when primary hits rate limit
const OPENCODE_FREE_MODEL_CHAIN = [
  "groq/moonshotai/kimi-k2-instruct-0905",
  "groq/qwen/qwen3-32b",
  "groq/llama-3.3-70b-versatile",
  "opencode/gpt-5.1-codex-mini",
];

function readAgentSessionId(agentId) {
  if (!agentId) return null;
  try {
    const f = path.join(OPENCODE_SESSION_DIR, `${agentId}.session`);
    if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim() || null;
  } catch (e) {
    console.error(`[gateway-bridge] Failed to read session ID for ${agentId}: ${e.message}`);
  }
  return null;
}

function writeAgentSessionId(agentId, sessionId) {
  if (!agentId || !sessionId) return;
  try {
    fs.mkdirSync(OPENCODE_SESSION_DIR, { recursive: true });
    fs.writeFileSync(path.join(OPENCODE_SESSION_DIR, `${agentId}.session`), sessionId, "utf8");
  } catch (e) {
    console.error(`[gateway-bridge] Failed to write session ID for ${agentId}: ${e.message}`);
  }
}

function clearAgentSessionId(agentId) {
  if (!agentId) return;
  try {
    const f = path.join(OPENCODE_SESSION_DIR, `${agentId}.session`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch (e) {
    console.error(`[gateway-bridge] Failed to clear session ID for ${agentId}: ${e.message}`);
  }
}


// Parse the most-recent session ID from `opencode session list` stdout.
// If agentPrefix is provided (e.g. "[crew-coder]"), only match sessions whose
// title contains that prefix — prevents race conditions when multiple agents
// finish simultaneously and each would otherwise grab the globally-first session.
function parseMostRecentSessionId(listOutput, agentPrefix) {
  for (const line of listOutput.split("\n")) {
    const m = line.trim().match(/^(ses_[A-Za-z0-9]+)\s+(.*)/);
    if (!m) continue;
    if (agentPrefix) {
      // Title is everything after the session ID; check it contains the agent tag
      if (m[2].includes(agentPrefix)) return m[1];
    } else {
      return m[1];
    }
  }
  return null;
}


// Detect a rate-limited OpenCode session: process exited null and only printed the banner.
// Pattern: ANSI codes + "> agentname · modelname" with no actual tool output.
function isOpencodeRateLimitBanner(output) {
  const stripped = output.replace(/\x1b\[[0-9;]*m/g, "").trim();
  return /^>\s+\S+\s+·\s+\S+\s*$/.test(stripped);
}

function getOpencodeFallbackModel() {
  if (process.env.CREWSWARM_OPENCODE_FALLBACK_MODEL) return process.env.CREWSWARM_OPENCODE_FALLBACK_MODEL;
  const cfg = loadSystemConfig();
  if (cfg.opencodeFallbackModel && String(cfg.opencodeFallbackModel).trim()) return String(cfg.opencodeFallbackModel).trim();
  const swarm = loadSwarmConfig();
  if (swarm.globalFallbackModel && String(swarm.globalFallbackModel).trim()) return String(swarm.globalFallbackModel).trim();
  return CREWSWARM_OPENCODE_FALLBACK_DEFAULT;
}
console.log(`[bridge] Registered ${CREWSWARM_RT_SWARM_AGENTS.length} RT agents: ${CREWSWARM_RT_SWARM_AGENTS.join(", ")}`);

// callLLMDirect → lib/engines/llm-direct.mjs

// ─── Crypto helpers ─────────────────────────────────────────────────────────
function b64url(buf) { return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, ""); }
function deriveRaw(pem) {
  const spki = crypto.createPublicKey(pem).export({ type: "spki", format: "der" });
  return spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
    ? spki.subarray(ED25519_SPKI_PREFIX.length) : spki;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function progress(msg) { process.stderr.write(`• ${msg}\n`); }

function telemetry(event, metadata = {}) {
  try {
    fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
    fs.appendFileSync(TELEMETRY_LOG, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      runId: RUN_ID,
      version: CLI_VERSION,
      metadata,
    })}\n`);
  } catch (e) {
    console.error(`[gateway-bridge] Failed to write telemetry event ${event}: ${e.message}`);
  }
}

function transientError(err) {
  const msg = String(err?.message ?? err ?? "").toLowerCase();
  return ["timeout", "timed out", "econnrefused", "ehostunreach", "econnreset", "socket hang up", "websocket is not open", "connection closed", "broken pipe"].some((s) => msg.includes(s));
}

async function withRetry(fn, { retries = 2, baseDelayMs = 300, label = "request" } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !transientError(err)) throw err;
      attempt += 1;
      const delayMs = baseDelayMs * (2 ** (attempt - 1));
      telemetry("retry_attempt", { label, attempt, delayMs, error: err?.message ?? String(err) });
      progress(`Retrying ${label} (${attempt}/${retries}) in ${delayMs}ms...`);
      await sleep(delayMs);
    }
  }
}

function parseTextContent(content) {
  return typeof content === "string" ? content
    : Array.isArray(content) ? content.filter((c) => c.type === "text").map((c) => c.text).join("") : "";
}

/** Remove <think>...</think> reasoning blocks and Gemini-style chain-of-thought so they are not shown in task.done. */
function stripThink(text) {
  if (!text || typeof text !== "string") return text;

  return text
    // Strip standard <think> XML tags (DeepSeek, etc.)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/think>/g, "")
    .replace(/<think>/g, "")

    // Strip Gemini/Grok-style thinking headers
    .replace(/\*\*\[Grok-\d+[^\]]*:[\s\S]*?\.\]\*\*/g, "")

    // Strip "My Chain of Thought" statements
    .replace(/My Chain of Thought (is active|has been updated)[.\n]*/gi, "")

    // Strip "Project context confirmed" 
    .replace(/Project context confirmed:[^\n]*\n*/g, "")

    // Strip other thinking-style prefixes
    .replace(/\*\*My (thinking|analysis|approach):\*\*/gi, "")
    .replace(/\n*\*\*Chain of Thought\*\*:[\s\S]*?(?=\n\n|\n\*\*|$)/gi, "")
    .trim();
}

function parseJsonSafe(raw, fallback = {}) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function currentUtcLabel(date = new Date()) {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function isoNow() {
  return new Date().toISOString();
}

function memoryTemplate(fileName) {
  const now = currentUtcLabel();
  if (fileName === "current-state.md") {
    return [
      "# Current State",
      "",
      `Last updated: ${now}`,
      `Updated by: ${MEMORY_BOOTSTRAP_AGENT}`,
      "",
      "## Project Snapshot",
      "",
      "- Status: initialization pending",
      "- Active objective: define current objective",
      "- Current phase: startup",
      "",
      "## In Progress",
      "",
      "- None yet.",
      "",
      "## Next Steps",
      "",
      "1. Confirm project objective.",
      "2. Execute first concrete task.",
      "3. Update this state after execution.",
      "",
      "## Constraints and Defaults",
      "",
      "- Memory files in `memory/` are source of truth.",
      "- If memory and chat conflict, prefer latest timestamped memory entry.",
      "- Do not remove historical entries from append-only logs.",
    ].join("\n");
  }
  if (fileName === "decisions.md") {
    return [
      "# Decisions",
      "",
      "Record durable choices here. Append new decisions at the top.",
      "",
      "## Template",
      "",
      "```",
      "## [DEC-000] Title",
      "- Date: YYYY-MM-DD HH:MM UTC",
      "- Owner: agent-name-or-id",
      "- Context: why this decision was needed",
      "- Decision: what was chosen",
      "- Impact: what this changes",
      "- Revisit trigger: when to revisit this decision",
      "```",
      "",
      "## Entries",
      "",
      "- None yet.",
    ].join("\n");
  }
  if (fileName === "open-questions.md") {
    return [
      "# Open Questions",
      "",
      "Track unresolved items. Move resolved questions to `memory/session-log.md` with outcome.",
      "",
      "## Template",
      "",
      "```",
      "## [Q-000] Question title",
      "- Opened: YYYY-MM-DD HH:MM UTC",
      "- Opened by: agent-name-or-id",
      "- Why it matters: impact on execution",
      "- Needed input: exact answer needed",
      "- Default if no answer: safe fallback",
      "- Status: open | blocked | answered",
      "```",
      "",
      "## Entries",
      "",
      "- None currently open.",
    ].join("\n");
  }
  if (fileName === "agent-handoff.md") {
    return [
      "# Agent Handoff",
      "",
      "Use this file for a fast restart brief. Overwrite sections each session; keep stable structure.",
      "",
      `Last updated: ${now}`,
      `Updated by: ${MEMORY_BOOTSTRAP_AGENT}`,
      "",
      "## What just happened",
      "",
      "- Memory bootstrap initialized required files.",
      "",
      "## Current truth",
      "",
      "- Canonical memory path: `memory/`",
      "- Required files are present.",
      "",
      "## Next best action",
      "",
      "1. Execute the incoming task.",
      "2. Record outcomes in state and logs.",
      "",
      "## Risks",
      "",
      "- Context quality depends on keeping this file current.",
      "",
      "## If blocked",
      "",
      "- Use defaults from `memory/current-state.md` and log assumptions in `memory/session-log.md`.",
    ].join("\n");
  }
  if (fileName === "session-log.md") {
    return [
      "# Session Log",
      "",
      "Append-only execution log for all agents.",
      "",
      "## Template",
      "",
      "```",
      "## YYYY-MM-DD HH:MM UTC | agent-name-or-id | task-id",
      "- Intent: what the agent attempted",
      "- Actions: key steps taken",
      "- Result: success | partial | failed",
      "- Artifacts: files changed / commands run",
      "- Decisions: links to DEC ids (if any)",
      "- Follow-ups: immediate next steps",
      "```",
      "",
      "## Entries",
      "",
    ].join("\n");
  }
  return "";
}

function appendMemoryBootstrapLog(createdFiles) {
  if (!Array.isArray(createdFiles) || !createdFiles.length) return;
  try {
    const sessionLogPath = path.join(SHARED_MEMORY_DIR, "session-log.md");
    const ts = currentUtcLabel();
    const lines = [
      `## ${ts} | ${MEMORY_BOOTSTRAP_AGENT} | memory-bootstrap`,
      "- Intent: Auto-create missing required memory files before task execution.",
      `- Actions: Created templates for ${createdFiles.join(", ")}.`,
      "- Result: success",
      `- Artifacts: ${createdFiles.map((f) => `memory/${f}`).join(", ")}`,
      "- Decisions: none",
      "- Follow-ups: Confirm and refine bootstrap content during normal task shutdown updates.",
      "",
    ];
    fs.appendFileSync(sessionLogPath, `\n${lines.join("\n")}`);
  } catch (err) {
    telemetry("shared_memory_bootstrap_log_error", { message: err?.message ?? String(err) });
  }
}

function ensureSharedMemoryFiles() {
  try {
    fs.mkdirSync(SHARED_MEMORY_DIR, { recursive: true });
    const created = [];
    for (const fileName of SHARED_MEMORY_FILES) {
      const fullPath = path.join(SHARED_MEMORY_DIR, fileName);
      if (fs.existsSync(fullPath)) continue;
      fs.writeFileSync(fullPath, memoryTemplate(fileName), "utf8");
      created.push(fileName);
      telemetry("shared_memory_file_created", { fileName });
    }
    appendMemoryBootstrapLog(created);
    return { created, error: null };
  } catch (err) {
    telemetry("shared_memory_bootstrap_error", { message: err?.message ?? String(err) });
    return { created: [], error: err };
  }
}

function getAgentOpenCodeConfig(agentId) {
  const agents = loadAgentList();
  const cfg = agents.find(a => a.id === agentId);
  const fallback = cfg?.opencodeFallbackModel || getOpencodeFallbackModel();
  const loop = cfg?.opencodeLoop === true || process.env.CREWSWARM_ENGINE_LOOP === "1";
  const cursorCliModel = cfg?.cursorCliModel || null;
  const claudeCodeModel = cfg?.claudeCodeModel || null;
  const codexModel = cfg?.codexModel || null;
  const geminiCliModel = cfg?.geminiCliModel || null;
  const crewCliModel = cfg?.crewCliModel || null;
  const agentModel = cfg?.model || null;  // ← Get the agent's base model
  if (!cfg) {
    return {
      enabled: false,
      model: null,
      fallbackModel: fallback,
      loop: false,
      useCursorCli: false,
      cursorCliModel: null,
      claudeCodeModel: null,
      useClaudeCode: false,
      useCodex: false,
      codexModel: null,
      useGeminiCli: false,
      geminiCliModel: null,
      useCrewCLI: false,
      crewCliModel: null,
      engine: null,
    };
  }

  const assignedEngine = String(cfg.engine || "").toLowerCase() || null;
  const useCursorCli = cfg.useCursorCli === true || assignedEngine === "cursor";
  const useClaudeCode = cfg.useClaudeCode === true || assignedEngine === "claude";
  const useCodex = cfg.useCodex === true || assignedEngine === "codex";
  const useGeminiCli =
    cfg.useGeminiCli === true ||
    assignedEngine === "gemini" ||
    assignedEngine === "gemini-cli";
  const useCrewCLI =
    cfg.useCrewCLI === true ||
    assignedEngine === "crew-cli";

  if (cfg.useOpenCode === true || assignedEngine === "opencode") {
    return {
      enabled: true,
      model: cfg.opencodeModel || agentModel,
      fallbackModel: fallback,
      loop,
      useCursorCli,
      cursorCliModel,
      claudeCodeModel,
      useClaudeCode,
      useCodex,
      codexModel,
      useGeminiCli,
      geminiCliModel,
      useCrewCLI,
      crewCliModel,
      engine: assignedEngine,
    };
  }

  if (cfg.useOpenCode === false || (assignedEngine && assignedEngine !== "opencode")) {
    return {
      enabled: false,
      model: agentModel,
      fallbackModel: fallback,
      loop: false,
      useCursorCli,
      cursorCliModel,
      claudeCodeModel,
      useClaudeCode,
      useCodex,
      codexModel,
      useGeminiCli,
      geminiCliModel,
      useCrewCLI,
      crewCliModel,
      engine: assignedEngine,
    };
  }

  return {
    enabled: false,
    model: cfg.opencodeModel || agentModel,
    fallbackModel: fallback,
    loop: false,
    useCursorCli,
    cursorCliModel,
    claudeCodeModel,
    useClaudeCode,
    useCodex,
    codexModel,
    useGeminiCli,
    geminiCliModel,
    engine: assignedEngine,
  };
}

// Engine runners → lib/engines/runners.mjs

function shouldConnectGateway(args) {
  if (process.env.CREWSWARM_FORCE_GATEWAY === "1") return true;
  if (args.includes("--broadcast")) return false;
  if (args[0] === "--send") return false;
  // In RT-daemon mode: skip legacy gateway unless explicitly forced.
  // Agents use direct LLM calls; legacy gateway is optional.
  if (args.includes("--rt-daemon")) {
    if (process.env.CREWSWARM_GATEWAY_ENABLED === "1") return true;
    return false;
  }
  return true;
}

function createOpenCodeOnlyBridge() {
  return {
    kind: "opencode",
    chat: async (msg) => runOpenCodeTask(msg, {}),
    close: () => { },
  };
}

// ---------------------------------------------------------------------------
// runCursorWaveTask — dispatch a full wave of tasks to Cursor subagents in
// parallel via the crew-orchestrator subagent. The orchestrator receives the
// wave manifest as JSON and fans out to /crew-* subagents simultaneously,
// returning a combined === WAVE [n] RESULTS === report.
// ---------------------------------------------------------------------------
async function runCursorWaveTask(waveIndex, tasks, payload = {}) {
  const projectDir = payload?.projectDir || getOpencodeProjectDir() || process.cwd();
  const context = payload?.priorWaveContext || "";

  const manifest = {
    wave: waveIndex + 1,
    projectDir,
    context: context ? context.slice(0, 2000) : undefined,
    tasks: tasks.map(t => ({ agent: t.agent, task: t.task })),
  };

  // Build the orchestrator prompt: instruct it to dispatch all tasks in parallel
  const orchestratorPrompt = [
    `[crew-orchestrator] Execute this wave manifest — dispatch ALL tasks to subagents in parallel:`,
    "```json",
    JSON.stringify(manifest, null, 2),
    "```",
    `Dispatch all ${tasks.length} task(s) simultaneously using the Task tool. Return combined results.`,
  ].join("\n");

  console.error(`[CursorWave] Wave ${waveIndex + 1}: dispatching ${tasks.length} tasks via crew-orchestrator in parallel`);
  tasks.forEach(t => console.error(`  → ${t.agent}: ${String(t.task).slice(0, 80)}`));

  return runCursorCliTask(orchestratorPrompt, {
    ...payload,
    agentId: "crew-orchestrator",
    projectDir,
  });
}

// runOpenCodeTask → lib/engines/opencode.mjs


/** Extract project root from task text when it contains absolute paths (e.g. /Users/.../Desktop/polymarket-ai-strat/...). */
function extractProjectDirFromTask(taskText) {
  if (!taskText || typeof taskText !== "string") return null;
  // Match /Users/<user>/Desktop/<project-name> with optional trailing slash or /subpath
  const m = taskText.match(/\/Users\/[^/]+\/Desktop\/[^/\s]+/);
  if (!m) return null;
  return m[0];
}

/** Minimal prompt for OpenCode: task + project path only. Enhanced with shared memory from CLI. */
async function buildMiniTaskForOpenCode(taskText, agentId, projectDir) {
  let dir = projectDir || getOpencodeProjectDir() || null;
  if (!dir || dir === process.cwd()) {
    const fromTask = extractProjectDirFromTask(taskText);
    if (fromTask) dir = fromTask;
  }
  dir = dir || process.cwd();
  const taskForPrompt = rewriteTaskPathsRelativeToProjectRoot(taskText, dir);

  // Prepend condensed memory — now using shared memory adapter
  const readSafe = (p) => { try { return fs.readFileSync(p, "utf8").trim(); } catch { return ""; } };
  const memParts = [];

  const globalRules = readSafe(path.join(os.homedir(), ".crewswarm", "global-rules.md"));
  if (globalRules) memParts.push(`Global rules:\n${globalRules}`);

  // Use CLI's MemoryBroker if available (blends AgentKeeper + AgentMemory + Collections)
  // crew-cli gets MINIMAL context (it has its own L2 RAG + planning)
  // BUT we DO want to pass project-specific hints (constraints, decisions), not cross-project generic stuff
  const agents = loadAgentList();
  const agentConfig = agents.find(a => a.id === agentId);
  const usingCrewCLI = agentConfig?.engine === 'crew-cli';

  let sharedMemoryContext = '';
  if (isSharedMemoryAvailable() && !usingCrewCLI) {
    try {
      // Adaptive memory result scaling based on task complexity
      const taskTokens = taskForPrompt.split(/\s+/).length;
      const maxResults = taskTokens < 50 ? 3    // Simple: "write hello.js"
        : taskTokens < 150 ? 5   // Medium: "build auth endpoint"
          : 8;                     // Complex: detailed requirements

      // Skip memory recall for chat-only agents (crew-loco)
      // They should only see their own conversation history, not project work
      if (agentId !== 'crew-loco') {
        sharedMemoryContext = await recallMemoryContext(dir, taskForPrompt, {
          maxResults,
          includeDocs: true,
          includeCode: false,
          preferSuccessful: true,
          crewId: agentId || 'crew-lead'
        });
      }
    } catch (err) {
      console.warn(`[gateway-bridge] Shared memory recall failed: ${err.message}`);
    }
  } else if (usingCrewCLI && dir) {
    // For crew-cli: Pass ONLY project-specific hints (decisions/constraints, not full code)
    // crew-cli's L2 RAG will load the actual files it needs automatically
    try {
      const projectHints = await recallMemoryContext(dir, taskForPrompt, {
        maxResults: 2,  // Minimal - just key decisions
        includeDocs: false,  // crew-cli loads its own docs via L2 RAG
        includeCode: false,
        preferSuccessful: true,
        crewId: agentId || 'crew-lead'
      });
      if (projectHints) {
        // Extract just decision/constraint lines, no code blocks
        const lines = projectHints.split('\n').filter(line =>
          !line.includes('```') &&  // No code blocks
          !line.includes('@@') &&   // No tool calls  
          line.trim().length > 0 &&
          line.trim().length < 200  // No long paragraphs
        );
        sharedMemoryContext = lines.slice(0, 5).join('\n');  // Max 5 hint lines
        if (sharedMemoryContext) {
          console.log(`[gateway-bridge] crew-cli: passing ${lines.length} project hint lines (${sharedMemoryContext.length} chars)`);
        }
      }
    } catch (err) {
      console.warn(`[gateway-bridge] Project hints failed: ${err.message}`);
    }
  }

  // Fallback to legacy brain.md if shared memory not available or empty
  // Skip for crew-cli (it has its own context management)
  if (!sharedMemoryContext && !usingCrewCLI) {
    const lessons = readSafe(path.join(SHARED_MEMORY_DIR, "lessons.md"));
    if (lessons) memParts.push(`Lessons learned:\n${lessons}`);

    const brain = readSafe(path.join(SHARED_MEMORY_DIR, "brain.md")).slice(-1500);
    if (brain) memParts.push(`Shared brain (recent):\n${brain}`);

    // Project-specific brain if projectDir has one
    if (dir) {
      const projBrain = readSafe(path.join(dir, ".crewswarm", "brain.md")).slice(-1000);
      if (projBrain) memParts.push(`Project brain:\n${projBrain}`);

      const roadmap = readSafe(path.join(dir, "ROADMAP.md")).slice(-1500);
      if (roadmap) memParts.push(`Active ROADMAP:\n${roadmap}`);
    }
  } else if (sharedMemoryContext) {
    memParts.push(sharedMemoryContext);
  }

  const memHeader = memParts.length > 0
    ? `[Memory context — read before acting]\n${memParts.join("\n\n")}\n[End memory context]\n\n`
    : "";

  // crew-cli gets minimal prompt with optional project hints
  // crew-cli has its own L2 RAG, memory broker, and context management
  // We pass project-specific constraints/decisions as hints, but let crew-cli load files itself
  if (usingCrewCLI) {
    const contextInfo = sharedMemoryContext
      ? `\n\nProject constraints/decisions:\n${sharedMemoryContext}`
      : '';
    console.log(`[gateway-bridge] crew-cli: minimal context${contextInfo ? ` + ${sharedMemoryContext.length} char hints` : ' (no hints)'}`);
    return `[${agentId}] ${taskText}${contextInfo}\n\nProject directory: ${dir}. crew-cli will load relevant files automatically via L2 RAG.`;
  }

  return `${memHeader}[${agentId}] ${taskText}\n\nProject directory: ${dir}. Use the project files to complete this task only.`;
}

/**
 * Ouroboros-style LLM ↔ engine loop (see https://github.com/joi-lab/ouroboros).
 * LLM decomposes task into steps; each step is executed by the chosen engine (OpenCode, Cursor CLI,
 * or Claude Code); results are fed back until LLM says DONE or max rounds is reached.
 * engine: "opencode" | "cursor" | "claude" — selects which execution backend runs each step.
 */
// callLLMDirect → lib/engines/llm-direct.mjs
initLlmDirect({ loadAgentLLMConfig, checkSpendingCap, notifyTelegramSpending, recordTokenUsage, loadProviderMap });

// runOpenCodeTask → lib/engines/opencode.mjs
initOpenCode({
  CREWSWARM_OPENCODE_BIN, CREWSWARM_RT_AGENT, CREWSWARM_OPENCODE_MODEL,
  CREWSWARM_OPENCODE_TIMEOUT_MS, CREWSWARM_OPENCODE_AGENT,
  getAgentOpenCodeConfig, getOpencodeProjectDir,
  extractProjectDirFromTask, readAgentSessionId, writeAgentSessionId,
  parseMostRecentSessionId, isOpencodeRateLimitBanner,
  get _rtClientForApprovals() { return _rtClientForApprovals; },
});

// Engine runners → lib/engines/runners.mjs
initRunners({ getAgentOpenCodeConfig, loadAgentList, getOpencodeProjectDir, buildMiniTaskForOpenCode, runOpenCodeTask, loadGenericEngines });

// crew-cli engine → lib/engines/crew-cli.mjs
initCrewCLI({
  CREWSWARM_RT_AGENT,
  getAgentOpenCodeConfig,
  getOpencodeProjectDir,
});

// runOuroborosStyleLoop → lib/engines/ouroboros.mjs
initOuroboros({
  loadAgentList,
  loadLoopBrainConfig,
  loadAgentPrompts,
  callLLMDirect,
  buildMiniTaskForOpenCode,
  runCursorCliTask,
  runClaudeCodeTask,
  runCodexTask,
  runOpenCodeTask,
});

// handleRealtimeEnvelope → lib/engines/rt-envelope.mjs
initRtEnvelope({
  // dispatch lease (gateway-bridge local)
  acquireTaskLease,
  renewTaskLease,
  releaseTaskLease,
  markTaskDone,
  dispatchKeyForTask,
  // spawn / status
  resolveSpawnTargets,
  spawnAgentDaemon,
  isAgentDaemonRunning,
  readPid,
  pendingCmdApprovals,
  // routing
  selectEngine,
  shouldUseCursorCli,
  shouldUseClaudeCode,
  shouldUseCodex,
  shouldUseDockerSandbox,
  shouldUseGeminiCli,
  shouldUseOpenCode,
  shouldUseGenericEngine,
  loadGenericEngines,
  // runners
  runCursorCliTask,
  runClaudeCodeTask,
  runCodexTask,
  runGeminiCliTask,
  runGenericEngineTask,
  runDockerSandboxTask,
  runCrewCLITask,
  runOpenCodeTask,
  runOuroborosStyleLoop,
  // llm + prompt
  callLLMDirect,
  buildTaskPrompt,
  buildMiniTaskForOpenCode,
  // tools
  executeToolCalls,
  // memory
  loadAgentPrompts,
  // validation
  validateCodingArtifacts,
  isCodingTask,
  stripThink,
  shouldUseDispatchGuard,
  shouldRetryTaskFailure,
  assertTaskPromptProtocol,
  // utils
  telemetry,
  progress,
  extractProjectDirFromTask,
  getAgentOpenCodeConfig,
  getOpencodeProjectDir,
  // consts
  CREWSWARM_RT_AGENT,
  CREWSWARM_RT_COMMAND_TYPES,
  CREWSWARM_RT_DISPATCH_LEASE_MS,
  CREWSWARM_RT_DISPATCH_HEARTBEAT_MS,
  CREWSWARM_RT_DISPATCH_MAX_RETRIES,
  CREWSWARM_RT_DISPATCH_MAX_RETRIES_CODING,
  CREWSWARM_RT_DISPATCH_RETRY_BACKOFF_MS,
  CREWSWARM_OPENCODE_AGENT,
  CREWSWARM_OPENCODE_MODEL,
  OPENCODE_FREE_MODEL_CHAIN,
  RT_TO_GATEWAY_AGENT_MAP,
  SHARED_MEMORY_DIR,
  SWARM_DLQ_DIR,
  COORDINATOR_AGENT_IDS,
});

function printMemoryStatus() {
  const bundle = loadSharedMemoryBundle();
  console.log(`Shared memory directory: ${SHARED_MEMORY_DIR}`);
  console.log(`Files expected: ${SHARED_MEMORY_FILES.length}`);
  console.log(`Files included: ${bundle.included.length}`);
  if (bundle.included.length) {
    for (const f of bundle.included) console.log(`- ok: ${f}`);
  }
  if (bundle.missing.length) {
    for (const f of bundle.missing) console.log(`- missing: ${f}`);
  }
  console.log(`Context bytes prepared: ${bundle.bytes}`);
}

function printMetrics() {
  const events = readTelemetryEvents();
  if (!events.length) {
    console.log("No telemetry events yet. Run --quickstart first.");
    return;
  }

  const byRun = new Map();
  for (const ev of events) {
    const key = ev.runId ?? "unknown";
    if (!byRun.has(key)) byRun.set(key, []);
    byRun.get(key).push(ev);
  }

  const connectSuccess = events.filter((e) => e.event === "connect_success").length;
  const connectError = events.filter((e) => e.event === "connect_error").length;
  const chatStarted = events.filter((e) => e.event === "chat_started").length;
  const chatDone = events.filter((e) => e.event === "chat_done").length;
  const retries = events.filter((e) => e.event === "retry_attempt").length;

  const ttfvMs = [];
  const chatLatencyMs = [];

  for (const runEvents of byRun.values()) {
    runEvents.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const onboarding = runEvents.find((e) => e.event === "onboarding_started");
    const connected = runEvents.find((e) => e.event === "connect_success");
    if (onboarding && connected) {
      const delta = new Date(connected.timestamp).getTime() - new Date(onboarding.timestamp).getTime();
      if (delta >= 0) ttfvMs.push(delta);
    }

    const started = runEvents.find((e) => e.event === "chat_started");
    const done = runEvents.find((e) => e.event === "chat_done");
    if (started && done) {
      const delta = new Date(done.timestamp).getTime() - new Date(started.timestamp).getTime();
      if (delta >= 0) chatLatencyMs.push(delta);
    }
  }

  const connectAttempts = connectSuccess + connectError;
  const connectRate = connectAttempts ? ((connectSuccess / connectAttempts) * 100).toFixed(1) : "n/a";
  const chatCompletion = chatStarted ? ((chatDone / chatStarted) * 100).toFixed(1) : "n/a";

  console.log("crewswarm Metrics");
  console.log(`- Sessions observed: ${byRun.size}`);
  console.log(`- Connect success rate: ${connectRate}${connectRate === "n/a" ? "" : "%"} (${connectSuccess}/${connectAttempts || 0})`);
  console.log(`- Chat completion rate: ${chatCompletion}${chatCompletion === "n/a" ? "" : "%"} (${chatDone}/${chatStarted || 0})`);
  console.log(`- Retry attempts: ${retries}`);
  if (ttfvMs.length) {
    const p95 = percentile(ttfvMs, 95);
    console.log(`- Time-to-first-value: median ${formatDuration(median(ttfvMs))}, p95 ${formatDuration(p95)}`);
  } else {
    console.log("- Time-to-first-value: n/a (run --quickstart a few times)");
  }
  if (chatLatencyMs.length) {
    const p95 = percentile(chatLatencyMs, 95);
    console.log(`- Chat latency: median ${formatDuration(median(chatLatencyMs))}, p95 ${formatDuration(p95)}`);
  } else {
    console.log("- Chat latency: n/a");
  }
}

function loadCredentials() {
  const dev = JSON.parse(fs.readFileSync(path.join(LEGACY_STATE_DIR, "identity/device.json"), "utf8"));
  // Try crewswarm.json first, fall back to openclaw.json
  let cfg = loadSwarmConfig();
  if (!cfg || !Object.keys(cfg).length) {
    try { cfg = JSON.parse(fs.readFileSync(path.join(LEGACY_STATE_DIR, "openclaw.json"), "utf8")); } catch { cfg = {}; }
  }
  const gatewayToken = cfg.gateway?.auth?.token;
  // Prefer gateway token when gateway is in token mode (avoids device token mismatch)
  if (cfg.gateway?.auth?.mode === "token" && gatewayToken) {
    return { dev, authToken: gatewayToken };
  }
  let deviceToken;
  try {
    const da = JSON.parse(fs.readFileSync(path.join(LEGACY_STATE_DIR, "identity/device-auth.json"), "utf8"));
    deviceToken = da?.tokens?.operator?.token;
  } catch (e) {
    console.error(`[gateway-bridge] Failed to read device-auth.json: ${e.message}`);
  }
  return { dev, authToken: deviceToken || gatewayToken };
}

// ─── Load credentials ───────────────────────────────────────────────────────
// Loaded lazily in main for better first-run errors.

// ─── Bridge ─────────────────────────────────────────────────────────────────
const { createRealtimeClient, createBridge, runRealtimeDaemon } = initGatewayWs({
  WebSocket,
  crypto,
  CREWSWARM_RT_URL,
  CREWSWARM_RT_TLS_INSECURE,
  CREWSWARM_RT_TOKEN,
  GATEWAY_URL,
  PROTOCOL_VERSION,
  REQUEST_TIMEOUT_MS,
  CHAT_TIMEOUT_MS,
  CREWSWARM_RT_AGENT,
  CREWSWARM_RT_CHANNELS,
  CREWSWARM_RT_RECONNECT_MS,
  telemetry,
  progress,
  parseJsonSafe,
  parseTextContent,
  withRetry,
  sleep,
  b64url,
  deriveRaw,
  syncOpenCodePermissions,
  handleRealtimeEnvelope,
  setRtClient,
  setRtClientForRunners,
});

// ─── Main ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const usage = "Usage: node gateway-bridge.mjs \"message\" | --send <agent> \"message\" | --broadcast \"message\" | --status | ...";

function printStatusSummary(res) {
  const channels = Array.isArray(res?.channels) ? res.channels : [];
  if (!channels.length) {
    console.log("No channel list available; raw status follows:");
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  console.log(`Channels: ${channels.length}`);
  for (const ch of channels.slice(0, 12)) {
    const name = ch.name ?? ch.id ?? "unknown";
    const state = ch.state ?? ch.status ?? "unknown";
    const detail = ch.mode ? ` (${ch.mode})` : "";
    console.log(`- ${name}: ${state}${detail}`);
  }
}

async function runRealtimeStatusCheck() {
  progress(`Connecting to OpenCrew RT ${CREWSWARM_RT_URL}...`);
  const rt = await withRetry(() => createRealtimeClient({ onEnvelope: null }), {
    retries: 2,
    baseDelayMs: 300,
    label: "realtime connect",
  });
  console.log(`OpenCrew RT connected as ${CREWSWARM_RT_AGENT}`);
  console.log(`- URL: ${CREWSWARM_RT_URL}`);
  console.log(`- Channels: ${CREWSWARM_RT_CHANNELS.join(", ")}`);
  console.log(`- Token configured: ${CREWSWARM_RT_TOKEN ? "yes" : "no"}`);
  rt.close();
}

async function runBroadcastTask(message, { timeoutMs = 25000 } = {}) {
  const taskId = `broadcast-${Date.now()}`;
  const sender = process.env.CREWSWARM_RT_BROADCAST_SENDER || "orchestrator";
  const replies = [];
  let deliveredExpected = 0;

  const rt = await withRetry(() => createRealtimeClient({
    agentName: sender,
    channels: ["done", "issues"],
    onEnvelope: async (envelope) => {
      if (!envelope || envelope.taskId !== taskId) return;
      if (envelope.channel !== "done" && envelope.channel !== "issues") return;
      replies.push({
        from: envelope.from || "unknown",
        channel: envelope.channel,
        type: envelope.type,
        payload: envelope.payload || {},
      });
    },
  }), { retries: 2, baseDelayMs: 300, label: "realtime broadcast connect" });

  try {
    rt.publish({
      channel: "command",
      type: "command.run_task",
      to: "broadcast",
      taskId,
      priority: "high",
      payload: {
        action: "run_task",
        prompt: message,
        source: "crewswarm-broadcast",
      },
    });

    const startedAt = Date.now();
    const waitForReplies = async () => {
      while (Date.now() - startedAt < timeoutMs) {
        await sleep(300);
        const uniqueResponders = new Set(replies.map((r) => r.from)).size;
        if (deliveredExpected > 0 && uniqueResponders >= deliveredExpected) break;
      }
    };

    await waitForReplies();

    const grouped = new Map();
    for (const r of replies) {
      if (!grouped.has(r.from)) grouped.set(r.from, []);
      grouped.get(r.from).push(r);
    }

    const lines = [];
    lines.push(`Broadcast sent as ${sender} (taskId: ${taskId})`);
    lines.push(`Responses: ${grouped.size}`);
    for (const [agent, entries] of grouped.entries()) {
      const latest = entries[entries.length - 1];
      if (latest.channel === "done") {
        const reply = String(latest.payload?.reply || "ok").replace(/\s+/g, " ").slice(0, 220);
        lines.push(`- ${agent}: done - ${reply}`);
      } else {
        const err = String(latest.payload?.error || "failed").replace(/\s+/g, " ").slice(0, 220);
        lines.push(`- ${agent}: issue - ${err}`);
      }
    }

    return lines.join("\n");
  } finally {
    rt.close();
  }
}

/**
 * Send a task to a specific RT agent (targeted delegation). Only that agent processes it.
 * Use this for PM-led orchestration: PM plan → send each subtask to the assigned agent.
 * When agentId is crew-main and task is synthesis, the crew-main daemon routes to OpenCode
 * (OPENCODE_AGENTS); pass projectDir so OpenCode runs in the PM output dir.
 */
async function runSendToAgent(agentId, message, { timeoutMs = Number(process.env.CREWSWARM_RT_SEND_TIMEOUT_MS || "120000"), projectDir } = {}) {
  const taskId = `send-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const correlationId = crypto.randomUUID();
  const sender = process.env.CREWSWARM_RT_SEND_SENDER || "orchestrator";
  let reply = null;
  let done = false;

  const rt = await withRetry(() => createRealtimeClient({
    agentName: sender,
    channels: ["done", "issues"],
    onEnvelope: (envelope) => {
      if (done) return;
      if (envelope.channel !== "done" && envelope.channel !== "issues") return;
      if (envelope.from !== agentId) return;
      const match = envelope.taskId === taskId ||
        envelope.correlationId === correlationId ||
        (envelope.payload?.idempotencyKey && String(envelope.payload.idempotencyKey) === correlationId);
      if (!match) return;
      if (envelope.channel === "issues") {
        reply = String(envelope.payload?.error || envelope.payload?.note || "agent reported issue").trim();
        done = true;
        return;
      }
      reply = envelope.payload?.reply != null ? String(envelope.payload.reply) : "";
      done = true;
    },
  }), { retries: 2, baseDelayMs: 300, label: "realtime send connect" });

  const payload = {
    action: "run_task",
    prompt: message,
    message,
    source: sender,
    idempotencyKey: correlationId,
  };
  if (projectDir) payload.projectDir = projectDir;

  try {
    rt.publish({
      channel: "command",
      type: "command.run_task",
      to: agentId,
      taskId,
      correlationId,
      priority: "high",
      payload,
    });

    const startedAt = Date.now();
    while (!done && Date.now() - startedAt < timeoutMs) {
      await sleep(400);
    }

    if (!done) {
      throw new Error(`Timeout waiting for ${agentId} (${timeoutMs}ms)`);
    }
    return reply != null ? reply : "(no reply body)";
  } finally {
    rt.close();
  }
}

// handleRealtimeEnvelope → lib/engines/rt-envelope.mjs

// Sync dashboard tool permissions → OpenCode agent profiles in .opencode/opencode.jsonc
// Called at daemon startup so the two permission systems stay in sync automatically.
function syncOpenCodePermissions() {
  try {
    const ocCfgPath = path.join(process.cwd(), ".opencode", "opencode.jsonc");
    if (!fs.existsSync(ocCfgPath)) return;

    // crewswarm tool → OpenCode permission keys
    const TOOL_TO_OC = {
      write_file: { write: "allow", edit: "allow" },
      read_file: { read: "allow", glob: "allow", grep: "allow" },
      run_cmd: { bash: "allow" },
      dispatch: { task: "allow" },
      // git handled separately below — bash allow is too broad
    };

    // crewswarm agent-id → OpenCode agent profile name
    const AGENT_TO_OC_PROFILE = {
      "crew-coder": "coder",
      "crew-coder-front": "coder-front",
      "crew-coder-back": "coder-back",
      "crew-fixer": "fixer",
      "crew-frontend": "frontend",
      "crew-qa": "qa",
      "crew-security": "security",
      "crew-pm": "pm",
      "crew-main": "main",
      "crew-copywriter": "copywriter",
      "crew-github": "github",
      "crew-orchestrator": "orchestrator",
      "orchestrator": "orchestrator",
    };

    const agents = loadAgentList();
    if (!agents?.length) return;

    // Resolve profile name: use static map, fall back to stripping crew- prefix
    const resolveProfile = (agentId) =>
      AGENT_TO_OC_PROFILE[agentId] || agentId.replace(/^crew-/, "");

    let raw = fs.readFileSync(ocCfgPath, "utf8");
    const stripped = raw.replace(/\/\/[^\n]*/g, "");
    let cfg;
    try {
      cfg = JSON.parse(stripped);
    } catch (e) {
      console.error(`[gateway-bridge] Failed to parse OpenCode config: ${e.message}`);
      return;
    }
    if (!cfg.agent) cfg.agent = {};

    for (const agentCfg of agents) {
      const agentId = agentCfg.id || agentCfg.agentId;
      if (!agentId) continue;
      const profile = resolveProfile(agentId);

      const tools = loadAgentToolPermissions(agentId); // reads crewswarm.json → role defaults
      const ocPerms = {};

      for (const [tool, perms] of Object.entries(TOOL_TO_OC)) {
        if (tools.has(tool)) {
          Object.assign(ocPerms, perms);
        }
      }

      // git tool: allow git commands in bash (don't grant full bash)
      if (tools.has("git") && !tools.has("run_cmd")) {
        ocPerms.bash = typeof ocPerms.bash === "object" ? ocPerms.bash : {};
        if (ocPerms.bash !== "allow") {
          ocPerms.bash["git *"] = "allow";
          ocPerms.bash["git diff*"] = "allow";
          ocPerms.bash["git log*"] = "allow";
          ocPerms.bash["git status*"] = "allow";
        }
      }

      // Always deny dangerous stuff for non-admin agents
      if (profile !== "admin") {
        ocPerms.question = "deny";
        ocPerms.plan_enter = "deny";
        ocPerms.plan_exit = "deny";
      }

      // Merge into existing profile, preserving model/prompt/mode
      if (!cfg.agent[profile]) cfg.agent[profile] = {};
      cfg.agent[profile].permission = {
        ...cfg.agent[profile].permission,
        ...ocPerms,
      };
    }

    // Re-serialize preserving the comment header
    const headerComment = raw.match(/^(\s*\/\/[^\n]*\n)*/)?.[0] || "";
    const newJson = JSON.stringify(cfg, null, "\t");
    // Restore the schema comment at top if it was there
    fs.writeFileSync(ocCfgPath, newJson + "\n");
    console.error(`[sync-oc-perms] Synced ${agents.length} agents → ${ocCfgPath}`);
  } catch (err) {
    console.error("[sync-oc-perms] Failed:", err.message);
  }
}


let bridge;
let connected = false;
try {
  telemetry("cli_started", { args: args.join(" ") || "(none)", platform: process.platform });
  if (args.includes("--metrics")) {
    printMetrics();
    process.exit(0);
  }

  if (args.includes("--memory-status")) {
    printMemoryStatus();
    process.exit(0);
  }

  if (args.includes("--rt-status")) {
    await runRealtimeStatusCheck();
    process.exit(0);
  }

  if (!args.length) {
    console.error(`${usage}\nTip: start with --quickstart for a guided setup check.`);
    process.exit(1);
  }

  if (args.includes("--quickstart")) telemetry("onboarding_started", { source: "--quickstart" });

  if (shouldConnectGateway(args)) {
    progress("Loading local identity/config...");
    const creds = loadCredentials();
    progress(`Connecting to gateway ${GATEWAY_URL}...`);
    bridge = await withRetry(() => createBridge(creds), { retries: 2, baseDelayMs: 350, label: "gateway connect" });
    bridge.kind = "gateway";
    connected = true;
    telemetry("connect_success", { url: GATEWAY_URL });
    process.stderr.write("✅ Connected to gateway\n");
  } else {
    progress("Starting in OpenCode-only worker mode (no gateway chat bridge)...");
    bridge = createOpenCodeOnlyBridge();
    telemetry("connect_skipped", { mode: "opencode_only", agent: CREWSWARM_RT_AGENT });
    process.stderr.write("✅ OpenCode-only worker mode enabled\n");
  }

  if (args.includes("--quickstart")) {
    progress("Running quickstart checks...");
    const res = await withRetry(() => bridge.send("channels.status", {}), { retries: 2, label: "channels.status" });
    console.log("Quickstart complete. Gateway is reachable.");
    printStatusSummary(res);
    console.log("\nTargets:");
    console.log("- Time-to-first-value: under 60s");
    console.log("- Connect success rate: above 95%");
    console.log("\nTry this command:");
    console.log("node gateway-bridge.mjs \"Give me a 3-bullet channel health summary\"");
    console.log("\nThen check metrics:");
    console.log("node gateway-bridge.mjs --metrics");
  } else if (args.includes("--status")) {
    progress("Fetching channel status...");
    const res = await withRetry(() => bridge.send("channels.status", {}), { retries: 2, label: "channels.status" });
    console.log(JSON.stringify(res, null, 2));
  } else if (args[0] === "--reset-session" && args[1]) {
    // Clear OpenCode session ID for a specific agent.
    // Called by the dashboard "Reset context window" button.
    const targetAgent = args[1];
    clearAgentSessionId(targetAgent);
    console.log(`OpenCode session cleared for ${targetAgent}. Next task will start a fresh session.`);
  } else if (args.includes("--reset-session")) {
    // No agent specified — list which sessions exist
    try {
      const files = fs.readdirSync(OPENCODE_SESSION_DIR);
      if (files.length === 0) { console.log("No saved sessions."); }
      else { console.log("Saved sessions:\n" + files.map(f => `  ${f.replace(".session", "")}`).join("\n")); }
    } catch (e) {
      console.error(`[gateway-bridge] Failed to list sessions: ${e.message}`);
      console.log("No session directory found.");
    }
  } else if (args.includes("--reset")) {
    progress("Resetting main session...");
    await withRetry(() => bridge.send("sessions.reset", { key: "main" }), { retries: 2, label: "sessions.reset" });
    console.log("Session reset.");
  } else if (args.includes("--history")) {
    progress("Fetching recent chat history...");
    const res = await withRetry(() => bridge.send("chat.history", { sessionKey: "main" }), { retries: 2, label: "chat.history" });
    const msgs = res?.messages ?? [];
    for (const m of msgs.slice(-10)) {
      const role = m.role ?? "?";
      const text = parseTextContent(m.content);
      if (text.trim()) console.log(`[${role}] ${text.slice(0, 300)}`);
    }
  } else if (args.includes("--rt-daemon")) {
    await runRealtimeDaemon(bridge);
  } else if (args.includes("--broadcast")) {
    const message = args.filter(a => !a.startsWith("--")).join(" ").trim();
    if (!message) {
      console.error("Broadcast message is required. Example: --broadcast \"All agents report status\"");
      process.exit(1);
    }
    const result = await runBroadcastTask(message);
    console.log(result);
  } else if (args[0] === "--send" && args[1]) {
    const agentId = args[1];
    const message = args.slice(2).join(" ").trim();
    if (!message) {
      console.error("Usage: node gateway-bridge.mjs --send <agentId> \"task message\"");
      console.error("Example: node gateway-bridge.mjs --send crew-coder \"Create server.js with Express\"");
      process.exit(1);
    }
    if (!CREWSWARM_RT_SWARM_AGENTS.includes(agentId)) {
      console.error(`Unknown agent: ${agentId}. Known: ${CREWSWARM_RT_SWARM_AGENTS.join(", ")}`);
      process.exit(1);
    }
    process.stderr.write(`📤 Sending to ${agentId} only (no broadcast)...\n`);
    const projectDir = getOpencodeProjectDir() || null;
    const reply = await runSendToAgent(agentId, message, { projectDir });
    process.stderr.write("✅ Reply received\n");
    console.log(reply);
    telemetry("send_to_agent", { agentId, replyChars: reply.length });
  } else {
    const message = args.filter(a => !a.startsWith("--")).join(" ");
    if (!message) { console.error(usage); process.exit(1); }
    if (message.trim().startsWith("/broadcast ")) {
      const payload = message.trim().slice("/broadcast ".length).trim();
      if (!payload) {
        console.error("Usage: /broadcast <message>");
        process.exit(1);
      }
      const result = await runBroadcastTask(payload);
      console.log(result);
      telemetry("chat_broadcast", { chars: payload.length });
      process.exit(0);
    }
    progress("Loading persistent shared memory...");
    const { finalPrompt, sharedMemory } = buildTaskPrompt(message, "User request");
    if (sharedMemory.loadFailed || finalPrompt === "MEMORY_LOAD_FAILED") {
      telemetry("chat_memory_load_failed", { sessionKey: "main", sharedMemoryMissing: sharedMemory.missing });
      console.log("MEMORY_LOAD_FAILED");
      process.exit(2);
    }
    assertTaskPromptProtocol(finalPrompt, "direct-chat");

    // Check if we should route to OpenCode instead of legacy gateway
    if (shouldUseOpenCode({}, finalPrompt, null)) {
      console.error("[OpenCode] Routing to OpenCode CLI...");
      // Pass raw message to OpenCode (no memory wrapper)
      const reply = await runOpenCodeTask(message, { model: CREWSWARM_OPENCODE_MODEL });
      console.log(reply);
      telemetry("chat_done_opencode", { sessionKey: CREWSWARM_RT_AGENT, replyChars: reply.length });
      process.exit(0);
    }

    telemetry("chat_started", {
      sessionKey: "main",
      messageChars: message.length,
      sharedMemoryIncluded: Boolean(sharedMemory.text),
      sharedMemoryBytes: sharedMemory.bytes,
      sharedMemoryMissing: sharedMemory.missing,
    });
    process.stderr.write(`📤 ${CREWSWARM_RT_AGENT || "main"} ${message.slice(0, 80)}\n`);
    process.stderr.write("⏳ Waiting for assistant reply...\n");
    const targetAgent = RT_TO_GATEWAY_AGENT_MAP[CREWSWARM_RT_AGENT] || "main";
    const reply = await bridge.chat(finalPrompt, targetAgent);

    telemetry("chat_done", { sessionKey: targetAgent, replyChars: reply.length });
    process.stderr.write("✅ Reply received\n");
    console.log(reply);

    // One-shot mode: exit after task completion (fresh context next run)
    if (ONE_SHOT) {
      process.stderr.write("[gateway-bridge] ONE-SHOT: Exiting after task completion\n");
      process.exit(0);
    }
  }
  telemetry("cli_finished", { ok: true });
} catch (err) {
  if (!connected) telemetry("connect_error", { message: err?.message ?? String(err) });
  telemetry("error_shown", { message: err?.message ?? String(err) });
  telemetry("cli_finished", { ok: false, message: err?.message ?? String(err) });
  console.error(formatError(err));
  process.exit(1);
} finally {
  bridge?.close();
}
