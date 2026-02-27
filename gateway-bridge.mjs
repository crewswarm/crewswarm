#!/usr/bin/env node
/**
 * CrewSwarm Gateway Bridge — agent daemon for real-time LLM calls and tool execution.
 *
 * Usage:
 *   node gateway-bridge.mjs "your message here"
 *   node gateway-bridge.mjs --status
 *   node gateway-bridge.mjs --reset
 *   node gateway-bridge.mjs --history
 */
import { WebSocket } from "ws";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { getProjectDir } from "./lib/project-dir.mjs";
import { COORDINATOR_AGENT_IDS } from "./lib/agent-registry.mjs";
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
  AGENT_TOOL_ROLE_DEFAULTS,
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
  shouldUseCursorCli,
  shouldUseClaudeCode,
  shouldUseOpenCode,
  shouldUseCodex,
  shouldUseGeminiCli,
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
import { initLlmDirect, callLLMDirect } from "./lib/engines/llm-direct.mjs";
import { initOpenCode, runOpenCodeTask } from "./lib/engines/opencode.mjs";

// Wire injected deps into extracted modules
initTaskLease({ telemetry, sleep, parseJsonSafe });
initTools({ resolveConfig, resolveTelegramBridgeConfig, loadAgentList, getOpencodeProjectDir,
  loadSkillDef, loadPendingSkills, savePendingSkills, notifyTelegramSkillApproval, executeSkill });
initSpending({ resolveConfig, resolveTelegramBridgeConfig });
initSkills({ resolveConfig, resolveTelegramBridgeConfig });
initMemory({ telemetry, ensureSharedMemoryFiles, loadAgentList, loadAgentToolPermissions, buildToolInstructions, getOpencodeProjectDir });
initValidation({ telemetry });

function getOpencodeProjectDir() {
  return getProjectDir("") || "";
}

// ── Per-agent OpenCode session persistence ─────────────────────────────────
// Each agent maintains a session ID so `opencode run -s <id>` continues from
// where the last task left off, rather than starting cold every time.
// Sessions are stored in ~/.crewswarm/sessions/<agentId>.session
const OPENCODE_SESSION_DIR = path.join(os.homedir(), ".crewswarm", "sessions");

function readAgentSessionId(agentId) {
  if (!agentId) return null;
  try {
    const f = path.join(OPENCODE_SESSION_DIR, `${agentId}.session`);
    if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim() || null;
  } catch {}
  return null;
}

function writeAgentSessionId(agentId, sessionId) {
  if (!agentId || !sessionId) return;
  try {
    fs.mkdirSync(OPENCODE_SESSION_DIR, { recursive: true });
    fs.writeFileSync(path.join(OPENCODE_SESSION_DIR, `${agentId}.session`), sessionId, "utf8");
  } catch {}
}

function clearAgentSessionId(agentId) {
  if (!agentId) return;
  try {
    const f = path.join(OPENCODE_SESSION_DIR, `${agentId}.session`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch {}
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

// Free OpenCode model rotation chain — tried in order when primary hits rate limit.
const OPENCODE_FREE_MODEL_CHAIN = [
  "groq/moonshotai/kimi-k2-instruct-0905",
  "groq/qwen/qwen3-32b",
  "groq/llama-3.3-70b-versatile",
  "opencode/gpt-5.1-codex-mini",
];

// Detect a rate-limited OpenCode session: process exited null and only printed the banner.
// Pattern: ANSI codes + "> agentname · modelname" with no actual tool output.
function isOpencodeRateLimitBanner(output) {
  const stripped = output.replace(/\x1b\[[0-9;]*m/g, "").trim();
  return /^>\s+\S+\s+·\s+\S+\s*$/.test(stripped);
}

function getOpencodeFallbackModel() {
  if (process.env.CREWSWARM_OPENCODE_FALLBACK_MODEL) return process.env.CREWSWARM_OPENCODE_FALLBACK_MODEL;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "config.json"), "utf8"));
    if (cfg.opencodeFallbackModel && String(cfg.opencodeFallbackModel).trim()) return String(cfg.opencodeFallbackModel).trim();
  } catch {}
  try {
    // Also check crewswarm.json for globalFallbackModel — set from the dashboard
    const swarm = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "crewswarm.json"), "utf8"));
    if (swarm.globalFallbackModel && String(swarm.globalFallbackModel).trim()) return String(swarm.globalFallbackModel).trim();
  } catch {}
  return CREWSWARM_OPENCODE_FALLBACK_DEFAULT;
}
console.log(`[bridge] Registered ${CREWSWARM_RT_SWARM_AGENTS.length} RT agents: ${CREWSWARM_RT_SWARM_AGENTS.join(", ")}`);

// callLLMDirect → lib/engines/llm-direct.mjs

// ─── Crypto helpers ─────────────────────────────────────────────────────────
function b64url(buf) { return buf.toString("base64").replaceAll("+","-").replaceAll("/","_").replace(/=+$/g,""); }
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
  } catch {}
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

/** Remove <think>...</think> reasoning blocks so they are not shown in task.done (e.g. local Codex / reasoning models). */
function stripThink(text) {
  if (!text || typeof text !== "string") return text;
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/think>/g, "")
    .replace(/<think>/g, "")
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

function agentDefaultsToOpenCode(agentId) {
  const defaults = AGENT_TOOL_ROLE_DEFAULTS[agentId];
  if (defaults) return defaults.has("write_file") && defaults.has("run_cmd");
  // Dynamic/unknown agents: check their explicit tool config in crewswarm.json
  const agents = loadAgentList();
  const cfg = agents.find(a => a.id === agentId);
  const tools = cfg?.tools?.crewswarmAllow || [];
  if (tools.includes("write_file") && tools.includes("run_cmd")) return true;
  return false;
}

function getAgentOpenCodeConfig(agentId) {
  const agents = loadAgentList();
  const cfg = agents.find(a => a.id === agentId);
  const fallback = cfg?.opencodeFallbackModel || getOpencodeFallbackModel();
  const loop = cfg?.opencodeLoop === true || process.env.CREWSWARM_ENGINE_LOOP === "1";
  const cursorCliModel = cfg?.cursorCliModel || null;
  const claudeCodeModel = cfg?.claudeCodeModel || null;
  if (!cfg) return { enabled: agentDefaultsToOpenCode(agentId), model: null, fallbackModel: fallback, loop: false, useCursorCli: false, cursorCliModel: null, claudeCodeModel: null };
  if (cfg.useOpenCode === true) return { enabled: true, model: cfg.opencodeModel || null, fallbackModel: fallback, loop, useCursorCli: cfg.useCursorCli === true, cursorCliModel, claudeCodeModel };
  if (cfg.useOpenCode === false) return { enabled: false, model: null, fallbackModel: fallback, loop: false, useCursorCli: cfg.useCursorCli === true, cursorCliModel, claudeCodeModel };
  return { enabled: agentDefaultsToOpenCode(agentId), model: cfg.opencodeModel || null, fallbackModel: fallback, loop, useCursorCli: cfg.useCursorCli === true, cursorCliModel, claudeCodeModel };
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
    close: () => {},
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

function createRealtimeClient({ onEnvelope, agentName = CREWSWARM_RT_AGENT, token = CREWSWARM_RT_TOKEN, channels = CREWSWARM_RT_CHANNELS }) {
  return new Promise((resolveConnect, rejectConnect) => {
    const ws = new WebSocket(CREWSWARM_RT_URL, CREWSWARM_RT_URL.startsWith("wss://") && CREWSWARM_RT_TLS_INSECURE
      ? { rejectUnauthorized: false }
      : undefined);
    let ready = false;
    let settled = false;

    function sendFrame(frame) {
      if (ws.readyState !== WebSocket.OPEN) {
        throw new Error("realtime socket is not open");
      }
      ws.send(JSON.stringify(frame));
    }

    const client = {
      publish({ channel, type, to = "broadcast", taskId, correlationId, priority = "medium", payload = {} }) {
        sendFrame({
          type: "publish",
          channel,
          messageType: type,
          to,
          taskId,
          correlationId,
          priority,
          payload,
        });
      },
      ack({ messageId, status = "received", note = "" }) {
        sendFrame({ type: "ack", messageId, status, note });
      },
      close() {
        ws.close();
      },
      isReady() {
        return ready;
      },
    };

    ws.on("open", () => {
      telemetry("realtime_open", { url: CREWSWARM_RT_URL, agent: agentName });
    });

    ws.on("message", async (d) => {
      const p = parseJsonSafe(d.toString(), null);
      if (!p) return;

      if (p.type === "server.hello") {
        sendFrame({ type: "hello", agent: agentName, token });
        return;
      }

      if (p.type === "hello.ack") {
        sendFrame({ type: "subscribe", channels });
        ready = true;
        if (!settled) {
          settled = true;
          resolveConnect(client);
        }
        telemetry("realtime_ready", { channels, agent: agentName });
        return;
      }

      if (p.type === "error") {
        const err = new Error(`realtime error: ${p.message || "unknown"}`);
        telemetry("realtime_error", { message: err.message });
        if (!settled) {
          settled = true;
          rejectConnect(err);
        }
        return;
      }

      if (p.type === "message" && p.envelope && typeof onEnvelope === "function") {
        try {
          await onEnvelope(p.envelope, client);
        } catch (err) {
          telemetry("realtime_handler_error", { message: err?.message ?? String(err) });
        }
      }
    });

    ws.on("close", () => {
      ready = false;
      telemetry("realtime_closed", { url: CREWSWARM_RT_URL });
      if (!settled) {
        settled = true;
        rejectConnect(new Error("realtime connection closed before ready"));
      }
    });

    ws.on("error", (e) => {
      ready = false;
      telemetry("realtime_socket_error", { message: e?.message ?? String(e) });
      if (!settled) {
        settled = true;
        rejectConnect(e);
      }
    });
  });
}


/** Extract project root from task text when it contains absolute paths (e.g. /Users/.../Desktop/polymarket-ai-strat/...). */
function extractProjectDirFromTask(taskText) {
  if (!taskText || typeof taskText !== "string") return null;
  // Match /Users/<user>/Desktop/<project-name> with optional trailing slash or /subpath
  const m = taskText.match(/\/Users\/[^/]+\/Desktop\/[^/\s]+/);
  if (!m) return null;
  return m[0];
}

/** Minimal prompt for OpenCode: task + project path only. No shared memory or tool doc — OpenCode reads files. */
function buildMiniTaskForOpenCode(taskText, agentId, projectDir) {
  let dir = projectDir || getOpencodeProjectDir() || null;
  if (!dir || dir === process.cwd()) {
    const fromTask = extractProjectDirFromTask(taskText);
    if (fromTask) dir = fromTask;
  }
  dir = dir || process.cwd();

  // Prepend condensed memory so OpenCode/Cursor/Claude Code agents have context
  // without needing to read files themselves. Kept short to avoid prompt bloat.
  const readSafe = (p) => { try { return fs.readFileSync(p, "utf8").trim(); } catch { return ""; } };
  const memParts = [];

  const globalRules = readSafe(path.join(os.homedir(), ".crewswarm", "global-rules.md"));
  if (globalRules) memParts.push(`Global rules:\n${globalRules}`);

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

  const memHeader = memParts.length > 0
    ? `[Memory context — read before acting]\n${memParts.join("\n\n")}\n[End memory context]\n\n`
    : "";

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

  console.log("CrewSwarm Metrics");
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
  const cfgPath = fs.existsSync(path.join(os.homedir(), ".crewswarm", "crewswarm.json"))
    ? path.join(os.homedir(), ".crewswarm", "crewswarm.json")
    : path.join(LEGACY_STATE_DIR, "openclaw.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  const gatewayToken = cfg.gateway?.auth?.token;
  // Prefer gateway token when gateway is in token mode (avoids device token mismatch)
  if (cfg.gateway?.auth?.mode === "token" && gatewayToken) {
    return { dev, authToken: gatewayToken };
  }
  let deviceToken;
  try {
    const da = JSON.parse(fs.readFileSync(path.join(LEGACY_STATE_DIR, "identity/device-auth.json"), "utf8"));
    deviceToken = da?.tokens?.operator?.token;
  } catch {}
  return { dev, authToken: deviceToken || gatewayToken };
}

// ─── Load credentials ───────────────────────────────────────────────────────
// Loaded lazily in main for better first-run errors.

// ─── Bridge ─────────────────────────────────────────────────────────────────
function createBridge({ dev, authToken }) {
  return new Promise((resolveConnect, rejectConnect) => {
    const ws = new WebSocket(GATEWAY_URL);
    const pending = new Map();
    let settled = false;
    let reply = "";
    let replyDone = false;
    let onDone = null;

    function send(method, params) {
      return new Promise((res, rej) => {
        if (ws.readyState !== WebSocket.OPEN) {
          rej(new Error(`websocket is not open for ${method}`));
          return;
        }
        const id = crypto.randomUUID();
        const timeout = setTimeout(() => {
          pending.delete(id);
          rej(new Error(`timeout: ${method}`));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, {
          resolve: (v) => { clearTimeout(timeout); res(v); },
          reject: (e) => { clearTimeout(timeout); rej(e); },
        });
        ws.send(JSON.stringify({ type: "req", id, method, params }));
      });
    }

    function doConnect(nonce) {
      const role = "operator", scopes = ["operator.admin"], signedAtMs = Date.now();
      const ver = nonce ? "v2" : "v1";
      const payloadStr = [ver, dev.deviceId, "gateway-client", "ui", role, scopes.join(","), String(signedAtMs), authToken || "", ...(nonce ? [nonce] : [])].join("|");
      const sig = b64url(crypto.sign(null, Buffer.from(payloadStr, "utf8"), crypto.createPrivateKey(dev.privateKeyPem)));

      send("connect", {
        minProtocol: PROTOCOL_VERSION, maxProtocol: PROTOCOL_VERSION,
        client: { id: "gateway-client", displayName: "crewHQ", version: "1.0.0", platform: process.platform, mode: "ui", instanceId: crypto.randomUUID() },
        caps: ["tool-events"], role, scopes,
        device: { id: dev.deviceId, publicKey: b64url(deriveRaw(dev.publicKeyPem)), signature: sig, signedAt: signedAtMs, ...(nonce ? { nonce } : {}) },
        ...(authToken ? { auth: { token: authToken } } : {}),
      }).then(() => {
        settled = true;
        resolveConnect({
          send, ws,
          chat: (msg, sessionKey = CREWSWARM_RT_AGENT || "main", options = {}) => {
            reply = ""; replyDone = false;
            return new Promise((res, rej) => {
              onDone = (text) => res(text);
              const idempotencyKey = String(options?.idempotencyKey || crypto.randomUUID());
              ws.send(JSON.stringify({
                type: "req", id: crypto.randomUUID(), method: "chat.send",
                params: { sessionKey, message: msg, thinking: "low", idempotencyKey },
              }));
              setTimeout(() => {
                if (!replyDone) { replyDone = true; res(reply || "(timeout - no reply)"); }
              }, CHAT_TIMEOUT_MS);
            });
          },
          close: () => ws.close(),
        });
      }).catch(rejectConnect);
    }

    ws.on("message", (d) => {
      const p = JSON.parse(d.toString());
      if (p.event === "connect.challenge") { doConnect(p.payload?.nonce); return; }
      if (p.event === "tick" || p.event === "health") return;

      // Streaming: agent events carry cumulative text
      if (p.event === "agent" && p.payload?.stream === "text") {
        const data = p.payload?.data;
        if (typeof data === "string") reply = data;
        else if (data?.text) reply = data.text;
        return;
      }

      // Chat done event carries final message
      if (p.event === "chat") {
        const msg = p.payload?.message;
        if (msg) {
          const text = parseTextContent(msg.content);
          if (text) reply = text;
        }
        const state = p.payload?.state;
        if (state === "idle" || state === "done" || state === "error") {
          replyDone = true;
          onDone?.(reply);
        }
        return;
      }

      // Response frames
      if (p.id && pending.has(p.id)) {
        const h = pending.get(p.id);
        pending.delete(p.id);
        if (p.ok) h.resolve(p.payload); else h.reject(new Error(p.error?.message ?? "unknown"));
      }
    });

    ws.on("error", (e) => {
      if (!settled) rejectConnect(e);
    });
    ws.on("close", () => {
      for (const h of pending.values()) h.reject(new Error("connection closed"));
      pending.clear();
      if (!settled) rejectConnect(new Error("connection closed before connect response"));
    });
    ws.on("open", () => setTimeout(() => doConnect(null), 1200));
  });
}

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

    // CrewSwarm tool → OpenCode permission keys
    const TOOL_TO_OC = {
      write_file: { write: "allow", edit: "allow" },
      read_file:  { read: "allow", glob: "allow", grep: "allow" },
      run_cmd:    { bash: "allow" },
      dispatch:   { task: "allow" },
      // git handled separately below — bash allow is too broad
    };

    // CrewSwarm agent-id → OpenCode agent profile name
    const AGENT_TO_OC_PROFILE = {
      "crew-coder":         "coder",
      "crew-coder-front":   "coder-front",
      "crew-coder-back":    "coder-back",
      "crew-fixer":         "fixer",
      "crew-frontend":      "frontend",
      "crew-qa":            "qa",
      "crew-security":      "security",
      "crew-pm":            "pm",
      "crew-main":          "main",
      "crew-copywriter":    "copywriter",
      "crew-github":        "github",
      "crew-orchestrator":  "orchestrator",
      "orchestrator":       "orchestrator",
    };

    const agents = loadAgentList();
    if (!agents?.length) return;

    // Resolve profile name: use static map, fall back to stripping crew- prefix
    const resolveProfile = (agentId) =>
      AGENT_TO_OC_PROFILE[agentId] || agentId.replace(/^crew-/, "");

    let raw = fs.readFileSync(ocCfgPath, "utf8");
    // Strip single-line comments so JSON.parse works
    const stripped = raw.replace(/\/\/[^\n]*/g, "");
    let cfg;
    try { cfg = JSON.parse(stripped); } catch { return; }
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

async function runRealtimeDaemon(bridge) {
  syncOpenCodePermissions();
  progress(`Starting OpenCrew realtime daemon via ${CREWSWARM_RT_URL}...`);
  let stopRequested = false;
  let currentClient = null;
  let heartbeat = null;

  const shutdown = () => {
    stopRequested = true;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    try {
      currentClient?.publish({ channel: "events", type: "agent.offline", payload: { agent: CREWSWARM_RT_AGENT } });
    } catch {}
    try {
      currentClient?.close();
    } catch {}
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (!stopRequested) {
    try {
      const rt = await withRetry(() => createRealtimeClient({
        onEnvelope: async (envelope, client) => handleRealtimeEnvelope(envelope, client, bridge),
      }), { retries: 2, baseDelayMs: 300, label: "realtime connect" });

      currentClient = rt;
      setRtClient(rt); // wire into tool executor for cmd approval requests
      setRtClientForRunners(rt); // wire into engine runners for agent_working/agent_idle
      rt.publish({
        channel: "events",
        type: "agent.online",
        to: "broadcast",
        priority: "high",
        payload: {
          agent: CREWSWARM_RT_AGENT,
          gateway: GATEWAY_URL,
          mode: "daemon",
        },
      });

      console.log(`OpenCrew daemon online: ${CREWSWARM_RT_AGENT}`);
      console.log(`- gateway: ${GATEWAY_URL}`);
      console.log(`- realtime: ${CREWSWARM_RT_URL}`);
      console.log(`- subscribed: ${CREWSWARM_RT_CHANNELS.join(", ")}`);

      heartbeat = setInterval(() => {
        try {
          rt.publish({
            channel: "status",
            type: "agent.heartbeat",
            to: "broadcast",
            payload: { agent: CREWSWARM_RT_AGENT, ts: new Date().toISOString() },
          });
        } catch {}
      }, 30000);

      await new Promise((resolve) => {
        const poll = setInterval(() => {
          if (stopRequested || !rt.isReady()) {
            clearInterval(poll);
            resolve();
          }
        }, 1000);
      });

      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      try { rt.close(); } catch {}
      currentClient = null;
      if (!stopRequested) {
        progress(`Realtime disconnected. Reconnecting in ${CREWSWARM_RT_RECONNECT_MS}ms...`);
        await sleep(CREWSWARM_RT_RECONNECT_MS);
      }
    } catch (err) {
      telemetry("realtime_daemon_error", { message: err?.message ?? String(err) });
      progress(`Realtime daemon error: ${err?.message ?? String(err)}`);
      if (!stopRequested) await sleep(CREWSWARM_RT_RECONNECT_MS);
    }
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
    // Clear both OpenCode and Cursor CLI session IDs for a specific agent.
    // Called by the dashboard "Reset context window" button.
    const targetAgent = args[1];
    clearAgentSessionId(targetAgent);
    clearCursorSessionId(targetAgent);
    console.log(`OpenCode + Cursor CLI sessions cleared for ${targetAgent}. Next task will start a fresh session.`);
  } else if (args.includes("--reset-session")) {
    // No agent specified — list which sessions exist
    try {
      const files = fs.readdirSync(OPENCODE_SESSION_DIR);
      if (files.length === 0) { console.log("No saved sessions."); }
      else { console.log("Saved sessions:\n" + files.map(f => `  ${f.replace(".session","")}`).join("\n")); }
    } catch { console.log("No session directory found."); }
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
    
    // For RT swarm agents, poll done.jsonl instead of WebSocket
    const isRTAgent = CREWSWARM_RT_SWARM_AGENTS.includes(CREWSWARM_RT_AGENT);
    let reply;
    
    if (isRTAgent) {
      // Poll done.jsonl for RT agent replies
      const DONE_CHANNEL = path.join(SHARED_MEMORY_BASE, SHARED_MEMORY_NAMESPACE, "opencrew-rt", "channels", "done.jsonl");
      const startTime = Date.now();
      const startPos = fs.existsSync(DONE_CHANNEL) ? fs.statSync(DONE_CHANNEL).size : 0;
      
      // Send via gateway (it will route to RT agent)
      bridge.chat(finalPrompt, targetAgent).catch(() => {}); // Fire and forget
      
      // Poll done.jsonl for reply
      const pollInterval = 500; // 500ms
      const timeout = 90000; // 90s timeout
      let found = false;
      
      while (Date.now() - startTime < timeout && !found) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        
        if (!fs.existsSync(DONE_CHANNEL)) continue;
        
        const content = fs.readFileSync(DONE_CHANNEL, 'utf8');
        const newContent = content.substring(startPos);
        const lines = newContent.split('\n').filter(l => l.trim());
        
        for (const line of lines) {
          try {
            const msg = JSON.parse(line);
            
            // Match by agent ID and recent timestamp
            if (msg.from === CREWSWARM_RT_AGENT && 
                new Date(msg.ts).getTime() > startTime - 2000 &&
                msg.payload?.reply) {
              reply = msg.payload.reply;
              found = true;
              break;
            }
          } catch (err) {
            // Skip invalid JSON
          }
        }
      }
      
      if (!found || !reply) {
        reply = "(no reply received from RT agent - check done.jsonl)";
      }
    } else {
      // Use standard WebSocket chat for gateway agents
      reply = await bridge.chat(finalPrompt, targetAgent);
    }
    
    telemetry("chat_done", { sessionKey: targetAgent, replyChars: reply.length });
    process.stderr.write("✅ Reply received\n");
    console.log(reply);
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
