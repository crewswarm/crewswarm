#!/usr/bin/env node
/**
 * crew-lead.mjs — Conversational commander (HTTP server)
 *
 * Runs a local HTTP server on port 5010.
 * Receives chat messages, responds via LLM, dispatches tasks to agents.
 * Persistent per-session memory. Standalone — no external gateway needed.
 *
 * Usage: node crew-lead.mjs
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import http from "node:http";
import { execSync, spawnSync } from "node:child_process";
import WebSocket from "ws";
import { acquireStartupLock } from "./lib/runtime/startup-guard.mjs";
import {
  loadSystemConfig, loadSwarmConfig, loadAgentList as loadAgentListFromConfig, resolveProvider,
  CREW_LEAD_PORT as PORT,
  CREW_LEAD_PID_PATH as PID_PATH,
  CREW_LEAD_HISTORY_DIR as HISTORY_DIR,
  CREWSWARM_REPO_ROOT,
  PROJECTS_REGISTRY,
  MAX_HISTORY,
  LLM_TIMEOUT,
  CTL_PATH,
  DASH_PORT,
  DASH_HOST,
  DASHBOARD,
  DISPATCH_TIMEOUT_MS,
  DISPATCH_CLAIMED_TIMEOUT_MS,
  loadCursorWavesEnabled,
  loadClaudeCodeEnabled,
  loadTmuxBridgeEnabled
} from "./lib/runtime/config.mjs";
import { _reset as resetTmuxBridge } from "./lib/bridges/tmux-bridge.mjs";
import {
  CREWSWARM_TOOL_NAMES,
  readAgentTools,
  writeAgentTools,
  getRawAgentPrompts,
  getAgentPrompts,
  writeAgentPrompt,
} from "./lib/agents/permissions.mjs";
import { createAgent, removeDynamicAgent } from "./lib/crew-lead/agent-manager.mjs";
import { initTools, execCrewLeadTools } from "./lib/crew-lead/tools.mjs";
import { initBrain, appendToBrain, readGlobalRules, writeGlobalRules, appendGlobalRule, searchWithBrave, searchCodebase } from "./lib/crew-lead/brain.mjs";
import { initPrompts, buildSystemPrompt } from "./lib/crew-lead/prompts.mjs";
import { initClassifier, classifyTask } from "./lib/crew-lead/classifier.mjs";
import { initIntent, writeTaskBrief, parseServiceIntent, messageNeedsSearch, isDispatchIntended } from "./lib/crew-lead/intent.mjs";
import { initBackground, startBackgroundLoop, recordAgentTimeout, getRateLimitFallback, _agentTimeoutCounts, RATE_LIMIT_PATTERN } from "./lib/crew-lead/background.mjs"; // RATE_LIMIT_PATTERN used in RT handler
import { initPipelineManager, pendingProjects, draftProject, confirmProject, parseRoadmapPhases, findNextRoadmapPhase, autoAdvanceRoadmap } from "./lib/pipeline/manager.mjs";
import { initTelemetry, emitTaskLifecycle, readTelemetryEvents, buildTaskText, resolveAgentId, TELEMETRY_SCHEMA_VERSION, recordOpsEvent, bumpOpsCounter } from "./lib/runtime/telemetry.mjs";
import {
  sessionFile,
  loadHistory,
  appendHistory,
  clearHistory,
} from "./lib/chat/history.mjs";
import {
  initDispatchParsers,
  parseDispatch,
  stripDispatch,
  parseDispatches,
  parsePipeline,
  stripPipeline,
  parseProject,
  stripProject,
  parseRegisterProject,
  stripThink,
} from "./lib/dispatch/parsers.mjs";
import {
  initLlmCaller,
  callLLM,
  _callLLMOnce,
  patchMessagesWithActiveModel,
  trimMessagesForFallback,
} from "./lib/crew-lead/llm-caller.mjs";
import { initChatHandler, handleChat } from "./lib/crew-lead/chat-handler.mjs";
import { initHttpServer, createAndStartServer } from "./lib/crew-lead/http-server.mjs";
import { initWsRouter } from "./lib/crew-lead/ws-router.mjs";
import {
  initWaveDispatcher,
  pendingDispatches,
  pendingPipelines,
  dispatchTimeoutInterval,
  setDispatchTimeoutInterval,
  checkDispatchTimeouts,
  markDispatchClaimed,
  savePipelineState,
  deletePipelineState,
  resumePipelines,
  cancelAllPipelines,
  dispatchPipelineWave,
  checkWaveQualityGate,
  failPipelineOnQualityGate,
  dispatchTask,
} from "./lib/crew-lead/wave-dispatcher.mjs";
import { normalizeRtAgentId } from "./lib/agent-registry.mjs";
import { handleAutonomousMentions } from "./lib/chat/autonomous-mentions.mjs";
import { saveProjectMessage } from "./lib/chat/project-messages.mjs";
import { initIntervalManagers } from "./lib/crew-lead/interval-manager.mjs";

// ── Single instance + canonical PID (dashboard / restart-crew-lead.sh use this path) ──
const _crewLeadLock = acquireStartupLock("crew-lead", {
  port: PORT,
  killStale: false,
  pidFile: PID_PATH,
});
if (!_crewLeadLock.ok) {
  console.error(`[crew-lead] Refusing to start: ${_crewLeadLock.message}`);
  console.error(
    `[crew-lead] Stop the other instance (Services tab, or: bash scripts/restart-crew-lead.sh)`,
  );
  console.error(
    `[crew-lead] If it crashed and left a stale PID file: rm -f ${PID_PATH}`,
  );
  process.exit(1);
}

// ── Global state (declared early — referenced throughout) ────────────────────
const sseClients = new Set();
const activeOpenCodeAgents = new Map(); // agentId → { model, since }
const agentLastHeartbeat = new Map();   // agentId → timestamp (ms) — tracks RT bus heartbeats

// SSE message throttling to prevent dashboard flashing
const SSE_THROTTLE_MS = 500; // Only send same agent_working/idle once per 500ms
const sseThrottle = new Map(); // key → lastSentMs



function broadcastSSE(payload) {
  // Throttle high-frequency agent status updates to prevent dashboard flashing
  if (payload?.type === "agent_working" || payload?.type === "agent_idle") {
    const throttleKey = `${payload.type}:${payload.agent}`;
    const now = Date.now();
    const lastSent = sseThrottle.get(throttleKey) || 0;

    if (now - lastSent < SSE_THROTTLE_MS) {
      return; // Throttle: skip this update
    }
    sseThrottle.set(throttleKey, now);
  }

  const event = JSON.stringify(payload);
  const clientCount = sseClients.size;
  if (clientCount === 0 && payload?.type === "chat_message") {
    console.log(`[crew-lead] ⚠️ broadcastSSE called but no SSE clients connected (type=${payload.type})`);
  }
  for (const client of sseClients) {
    try { client.write(`data: ${event}\n\n`); } catch { }
  }
  if (clientCount > 0 && payload?.type === "chat_message") {
    console.log(`[crew-lead] SSE broadcast to ${clientCount} client(s): ${payload.role} message sessionId=${payload.sessionId} (${event.length} bytes)`);
  }
}

let _cursorWavesEnabled = loadCursorWavesEnabled();
let _claudeCodeEnabled = loadClaudeCodeEnabled();
let _tmuxBridgeEnabled = loadTmuxBridgeEnabled();

const BG_CONSCIOUSNESS_INTERVAL_MS = Number(process.env.CREWSWARM_BG_CONSCIOUSNESS_INTERVAL_MS) || 15 * 60 * 1000;
let BG_CONSCIOUSNESS_MODEL = (() => {
  if (process.env.CREWSWARM_BG_CONSCIOUSNESS_MODEL) return process.env.CREWSWARM_BG_CONSCIOUSNESS_MODEL;
  const cfg = loadSystemConfig();
  if (cfg.bgConsciousnessModel) return cfg.bgConsciousnessModel;
  return "groq/llama-3.1-8b-instant";
})();
// Runtime-mutable — can be toggled via dashboard without restart.
// Reads from env first, then from ~/.crewswarm/crewswarm.json bgConsciousness field.
function loadBgConsciousnessEnabled() {
  if (process.env.CREWSWARM_BG_CONSCIOUSNESS) return /^1|true|yes$/i.test(String(process.env.CREWSWARM_BG_CONSCIOUSNESS));
  const cfg = loadSystemConfig();
  if (typeof cfg.bgConsciousness === "boolean") return cfg.bgConsciousness;
  return false;
}
let _bgConsciousnessEnabled = loadBgConsciousnessEnabled();
let _lastBgConsciousnessAt = 0;
// Proxy so existing code using BG_CONSCIOUSNESS_ENABLED still works
const BG_CONSCIOUSNESS_ENABLED_REF = { get enabled() { return _bgConsciousnessEnabled; } };

function loadConfig() {
  const cs = loadSystemConfig();
  const csSwarm = loadSwarmConfig();

  const agents = Array.isArray(csSwarm.agents) ? csSwarm.agents : [];
  const agentCfg = agents.find(a => a.id === "crew-lead");
  const modelString = agentCfg?.model || process.env.CREW_LEAD_MODEL || "groq/llama-3.3-70b-versatile";
  const useGeminiCli =
    modelString === "gemini-cli" ||
    modelString?.toLowerCase().startsWith("gemini-cli/") ||
    agentCfg?.engine === "gemini-cli" ||
    cs?.crewLeadUseGeminiCli === true;
  const [providerKey, ...modelParts] = modelString.split("/");
  const modelId = useGeminiCli ? "cli" : modelParts.join("/");
  const provider = useGeminiCli ? null : (csSwarm?.providers?.[providerKey] || cs?.providers?.[providerKey]);

  const teamAgents = agents
    .filter(a => a.id && a.id !== "crew-lead")
    .map((a) => ({ ...a, id: normalizeRtAgentId(a.id) || a.id }));

  const knownAgents = [...new Set(teamAgents.map(a => a.id))];
  if (!knownAgents.length) {
    knownAgents.push(
      "crew-main", "crew-pm", "crew-coder", "crew-qa", "crew-fixer",
      "crew-security", "crew-coder-front", "crew-coder-back",
      "crew-github", "crew-frontend", "crew-copywriter"
    );
  }

  const agentModels = {};
  for (const a of agents) {
    if (a.id && a.model) agentModels[a.id] = a.model;
  }

  // Full roster: id, display name, emoji, role/theme, model
  const agentRoster = teamAgents.map(a => ({
    id: a.id,
    name: a.identity?.name || a.name || a.id,
    emoji: a.identity?.emoji || a.emoji || "",
    role: a.identity?.theme || "",
    model: a.model || "",
  }));

  const displayName = agentCfg?.identity?.name || "crew-lead";
  const emoji = agentCfg?.identity?.emoji || "🦊";

  let fallbackProvider = null, fallbackModelId = null, fallbackProviderKey = null;
  if (agentCfg?.fallbackModel) {
    const [fbPk, ...fbMp] = agentCfg.fallbackModel.split("/");
    fallbackProviderKey = fbPk;
    fallbackModelId = fbMp.join("/");
    fallbackProvider = csSwarm?.providers?.[fbPk] || cs?.providers?.[fbPk];
  }

  // Canonical string from config (same as crewswarm.json agents[].model for crew-lead)
  const model = modelString;
  return {
    model,
    modelId,
    providerKey,
    provider,
    useGeminiCli,
    knownAgents,
    agentModels,
    agentRoster,
    displayName,
    emoji,
    fallbackModelId,
    fallbackProviderKey,
    fallbackProvider,
    agents,
  };
}

function tryRead(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

/** Read the shared projects registry (same store the dashboard writes autoAdvance to). Returns array of project objects. */
function readProjectsRegistry() {
  const raw = tryRead(PROJECTS_REGISTRY);
  if (!raw) return [];
  // Format is a dict keyed by projectId — convert to array
  return Object.values(raw);
}

const BRAIN_PATH = path.join(CREWSWARM_REPO_ROOT, "memory", "brain.md");
const GLOBAL_RULES_PATH = path.join(os.homedir(), ".crewswarm", "global-rules.md");
const CREWSWARM_CFG_FILE = path.join(os.homedir(), ".crewswarm", "crewswarm.json");

// ── Shared state ──────────────────────────────────────────────────────────
// rtPublish is set once the RT connection is established
let rtPublish = null;
let crewLeadHeartbeat = null;

// Rolling log of RT bus traffic so crew-lead has eyes on the system
const RT_ACTIVITY_MAX = 60;
const rtActivityLog = [];
function pushRtActivity(entry) {
  rtActivityLog.push(entry);
  if (rtActivityLog.length > RT_ACTIVITY_MAX) rtActivityLog.shift();
}

const autonomousPmLoopSessions = new Set();

// Auto-retry tracking — prevents infinite retry loops
const autoRetryAttempts = new Map(); // taskId → { questionRetry, planRetry, bailRetry, timestamp }
const AUTO_RETRY_TTL = 10 * 60 * 1000; // 10 min

function shouldAutoRetry(taskId, retryType) {
  const existing = autoRetryAttempts.get(taskId);
  if (!existing) {
    autoRetryAttempts.set(taskId, { [retryType]: true, timestamp: Date.now() });
    return true;
  }
  if (existing[retryType]) return false; // Already retried this type
  existing[retryType] = true;
  existing.timestamp = Date.now();
  return true;
}

async function isAgentOnRtBus(agentId) {
  try {
    const rtHost = process.env.CREWSWARM_RT_HOST || "127.0.0.1";
    const rtPort = Number(process.env.CREWSWARM_RT_PORT || 18889);
    const resp = await fetch(`http://${rtHost}:${rtPort}/status`, { signal: AbortSignal.timeout(3000) });
    const data = await resp.json();
    return Array.isArray(data.agents) && data.agents.includes(agentId);
  } catch { return false; }
}

// ── Init extracted modules ────────────────────────────────────────────────
initTools({ historyDir: HISTORY_DIR, crewswarmCfgFile: CREWSWARM_CFG_FILE });
initBrain({ brainPath: BRAIN_PATH, globalRulesPath: GLOBAL_RULES_PATH });
initPrompts({ crewswarmCfgFile: CREWSWARM_CFG_FILE, historyDir: HISTORY_DIR, getAgentPrompts, tryRead, maxDynamicAgents: Number(process.env.CREWSWARM_MAX_DYNAMIC_AGENTS || "5") });
initClassifier({ loadConfig });
initIntent({ loadConfig, classifyTask });
initTelemetry({ broadcastSSE });
initIntervalManagers({
  sseThrottle,
  activeOpenCodeAgents,
  broadcastSSE,
  autoRetryAttempts,
});


function resolveSkillAlias(skillName) {
  const skillsDir = path.join(os.homedir(), ".crewswarm", "skills");
  const exact = path.join(skillsDir, `${skillName}.json`);
  if (fs.existsSync(exact)) return skillName;
  try {
    const files = fs.readdirSync(skillsDir).filter(f => f.endsWith(".json"));
    for (const f of files) {
      const real = f.replace(".json", "");
      const def = JSON.parse(fs.readFileSync(path.join(skillsDir, f), "utf8"));
      const aliases = def.aliases || [];
      if (aliases.includes(skillName)) return real;
    }
  } catch { }
  return skillName;
}

/** Execute a skill from crew-lead (used when crew-lead emits @@SKILL in its reply). */
async function executeSkillFromCrewLead(skillName, params) {
  const resolved = resolveSkillAlias(skillName);
  const skillsDir = path.join(os.homedir(), ".crewswarm", "skills");
  const skillFile = path.join(skillsDir, `${resolved}.json`);
  if (!fs.existsSync(skillFile)) throw new Error(`Skill "${skillName}" not found`);
  const skillDef = JSON.parse(fs.readFileSync(skillFile, "utf8"));
  const swarmCfg = tryRead(path.join(os.homedir(), ".crewswarm", "crewswarm.json")) || {};
  const merged = { ...(skillDef.defaultParams || {}), ...params };

  // cmd-type skill: run a shell command with interpolated params
  if (skillDef.type === "cmd") {
    const allowed = skillDef.allowedValues || {};
    for (const [key, whitelist] of Object.entries(allowed)) {
      if (merged[key] !== undefined && !whitelist.includes(String(merged[key]))) {
        throw new Error(`Skill ${skillName}: invalid value for "${key}": ${merged[key]}. Allowed: ${whitelist.join(", ")}`);
      }
    }
    let cmd = skillDef.cmd || "";
    for (const [k, v] of Object.entries(merged)) cmd = cmd.replace(new RegExp(`\\{${k}\\}`, "g"), String(v).replace(/[^a-zA-Z0-9._\-\/]/g, ""));
    console.log(`[crew-lead] @@SKILL ${skillName} → cmd: ${cmd}`);
    const { execSync } = await import("child_process");
    const output = execSync(cmd, { timeout: skillDef.timeout || 10000, encoding: "utf8" });
    return { output };
  }
  const aliases = skillDef.paramAliases || {};
  for (const [param, map] of Object.entries(aliases)) {
    if (merged[param] != null && map[merged[param]] != null) merged[param] = map[merged[param]];
  }
  let urlStr;
  const urlParam = (skillDef.url || "").match(/\{(\w+)\}/);
  const emptyKey = urlParam ? urlParam[1] : null;
  const paramEmpty = emptyKey && (merged[emptyKey] === undefined || merged[emptyKey] === null || String(merged[emptyKey] || "").trim() === "");
  if (skillDef.listUrl && paramEmpty) {
    urlStr = skillDef.listUrl;
  } else {
    urlStr = skillDef.url || "";
    for (const [k, v] of Object.entries(merged)) urlStr = urlStr.replace(`{${k}}`, encodeURIComponent(String(v)));
  }
  const headers = { "Content-Type": "application/json", ...(skillDef.headers || {}) };
  if (skillDef.auth) {
    const auth = skillDef.auth;
    let token = auth.token || "";
    if (auth.keyFrom) {
      if (auth.keyFrom.startsWith("env.")) token = process.env[auth.keyFrom.slice(4)] || "";
      else { let val = swarmCfg; for (const p of auth.keyFrom.split(".")) val = val?.[p]; if (val) token = String(val); }
    }
    if (token) {
      if (auth.type === "bearer" || !auth.type) headers["Authorization"] = `Bearer ${token}`;
      else if (auth.type === "header") headers[auth.header || "X-API-Key"] = token;
    }
  }
  const method = (skillDef.method || "POST").toUpperCase();
  const reqOpts = { method, headers, signal: AbortSignal.timeout(skillDef.timeout || 30000) };
  if (method !== "GET" && method !== "HEAD") reqOpts.body = JSON.stringify(merged);
  console.log(`[crew-lead] @@SKILL ${skillName} → ${method} ${urlStr}`);
  const r = await fetch(urlStr, reqOpts);
  const text = await r.text();
  console.log(`[crew-lead] @@SKILL ${skillName} ← ${r.status} ${text.slice(0, 120).replace(/\n/g, " ")}`);
  if (!r.ok) throw new Error(`Skill ${skillName}: ${r.status} ${text.slice(0, 150)}`);
  try { return JSON.parse(text); } catch { return { response: text }; }
}


// Wire dispatch parsers — must come after loadConfig + resolveAgentId are defined
initDispatchParsers({ loadConfig, resolveAgentId });
initLlmCaller({ llmTimeout: LLM_TIMEOUT });

// handleChat → lib/crew-lead/chat-handler.mjs

// ── HTTP server ───────────────────────────────────────────────────────────────

initChatHandler({
  loadConfig,
  loadHistory,
  appendHistory,
  BRAIN_PATH,
  DASHBOARD,
  PORT,
  broadcastSSE,
  parseServiceIntent,
  messageNeedsSearch,
  parseDispatch,
  parsePipeline,
  parseProject,
  stripDispatch,
  stripPipeline,
  stripProject,
  stripThink,
  callLLM,
  buildSystemPrompt,
  execCrewLeadTools,
  tryRead,
  readAgentTools,
  writeAgentTools,
  getRawAgentPrompts,
  getAgentPrompts,
  writeAgentPrompt,
  searchWithBrave,
  searchCodebase,
  draftProject,
  resolveAgentId,
  dispatchTask,
  dispatchPipelineWave,
  pendingPipelines,
  isDispatchIntended,
  appendToBrain,
  appendGlobalRule,
  createAgent,
  removeDynamicAgent,
  executeSkillFromCrewLead,
  resolveSkillAlias,
  cancelAllPipelines,
  orchestratorLogsDir: path.join(path.dirname(new URL(import.meta.url).pathname), "orchestrator-logs"),
  autonomousPmLoopSessions,
  rtActivityLog,
  getRtPublish: () => rtPublish,
  getRTToken: () => RT_TOKEN,
});

initPipelineManager({ dashboard: DASHBOARD, broadcastSSE, appendHistory, handleChat, loadConfig });
initBackground({
  broadcastSSE,
  appendHistory,
  appendToBrain,
  dispatchTask,
  findNextRoadmapPhase,
  parseDispatches,
  pendingPipelines,
  readProjectsRegistry,
  autoAdvanceRoadmap,
  tryRead,
  getBgConsciousnessEnabled: () => _bgConsciousnessEnabled,
  bgConsciousnessIntervalMs: BG_CONSCIOUSNESS_INTERVAL_MS,
  bgConsciousnessModel: BG_CONSCIOUSNESS_MODEL,
  brainPath: BRAIN_PATH,
});

// HTTP server → lib/crew-lead/http-server.mjs

const bgConsciousnessRef = {
  get enabled() { return _bgConsciousnessEnabled; },
  set enabled(v) { _bgConsciousnessEnabled = v; },
  get model() { return BG_CONSCIOUSNESS_MODEL; },
  set model(v) {
    BG_CONSCIOUSNESS_MODEL = v;
    // Persist to config so it survives restart
    try {
      const cfgPath = path.join(os.homedir(), ".crewswarm", "crewswarm.json");
      const cfg = loadSystemConfig();
      cfg.bgConsciousnessModel = v;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
    } catch (e) {
      console.error(`[crew-lead] Failed to persist bgConsciousnessModel: ${e.message}`);
    }
  },
  get lastActivityAt() { return _lastBgConsciousnessAt; },
  set lastActivityAt(v) { _lastBgConsciousnessAt = v; },
};
const cursorWavesRef = { get enabled() { return _cursorWavesEnabled; }, set enabled(v) { _cursorWavesEnabled = v; } };
const claudeCodeRef = { get enabled() { return _claudeCodeEnabled; }, set enabled(v) { _claudeCodeEnabled = v; } };
const tmuxBridgeRef = {
  get enabled() { return _tmuxBridgeEnabled; },
  set enabled(v) {
    _tmuxBridgeEnabled = v;
    // Sync env var and reset detection cache so tmux-bridge module picks up runtime changes
    process.env.CREWSWARM_TMUX_BRIDGE = v ? "1" : "0";
    resetTmuxBridge();
  },
};

// connectRT is initialized after RT_URL/RT_TOKEN — use a mutable ref so HTTP server can call it
let _connectRT = () => { throw new Error("connectRT not initialized yet"); };

initHttpServer({
  sseClients,
  loadConfig,
  loadHistory,
  clearHistory,
  appendHistory,
  broadcastSSE,
  handleChat,
  callLLM,
  confirmProject,
  pendingProjects,
  dispatchTask,
  pendingDispatches,
  pendingPipelines,
  dispatchPipelineWave,
  resolveAgentId,
  readAgentTools,
  writeAgentTools,
  activeOpenCodeAgents,
  agentLastHeartbeat,
  agentTimeoutCounts: _agentTimeoutCounts, // from background.mjs
  crewswarmToolNames: CREWSWARM_TOOL_NAMES,
  classifyTask,
  tryRead,
  resolveSkillAlias,
  connectRT: () => _connectRT(),
  historyDir: HISTORY_DIR,
  dispatchTimeoutMs: DISPATCH_TIMEOUT_MS,
  dispatchTimeoutInterval,
  setDispatchTimeoutInterval,
  checkDispatchTimeouts,
  getRTToken: () => RT_TOKEN,
  getRtPublish: () => rtPublish,
  telemetrySchemaVersion: TELEMETRY_SCHEMA_VERSION,
  readTelemetryEvents,
  bgConsciousnessRef,
  bgConsciousnessIntervalMs: BG_CONSCIOUSNESS_INTERVAL_MS,
  cursorWavesRef,
  claudeCodeRef,
  tmuxBridgeRef,
});
createAndStartServer(PORT);

// Graceful error handling — log but allow critical errors to kill the process
process.on("unhandledRejection", (reason) => {
  const msg = reason?.message || String(reason);

  // Benign errors: SSE/fetch aborted, client disconnects — keep alive
  if (msg === "terminated" || msg === "aborted" || /client.*disconnect/i.test(msg)) {
    return; // Silent — normal operation
  }

  console.error("[crew-lead] unhandled rejection:", msg);
  console.error("Stack:", reason?.stack);

  // Critical errors: DB corruption, port conflicts, OOM — die gracefully
  if (/EADDRINUSE|EACCES|out of memory|cannot allocate/i.test(msg)) {
    console.error("[crew-lead] FATAL — exiting");
    process.exit(1);
  }
  // Non-critical: keep alive but warn
});

process.on("uncaughtException", (err) => {
  console.error("[crew-lead] uncaught exception:", err?.stack || err?.message);

  // Always exit on uncaught exceptions — they leave process in undefined state
  console.error("[crew-lead] FATAL — exiting due to uncaught exception");
  process.exit(1);
});

// ── RT Bus listener — receives replies from agents ────────────────────────────

const RT_URL = process.env.CREWSWARM_RT_URL || "ws://127.0.0.1:18889";
const RT_TOKEN = process.env.CREWSWARM_RT_AUTH_TOKEN || (() => {
  const cs = loadSystemConfig();
  return cs?.rt?.authToken || "";
})();

initWaveDispatcher({
  appendHistory,
  broadcastSSE,
  emitTaskLifecycle,
  recordAgentTimeout,
  isAgentOnRtBus,
  loadSystemConfig,
  loadConfig,
  resolveAgentId,
  writeTaskBrief,
  buildTaskText,
  getRtPublish: () => rtPublish,
  execSync,
  CTL_PATH,
  readProjectsRegistry,
  autoAdvanceRoadmap,
  recordOpsEvent,
  bumpOpsCounter,
  tryRead,
  _cursorWavesEnabled,
  getClaudeCodeEnabled: () => _claudeCodeEnabled,
  dispatchTimeoutMs: DISPATCH_TIMEOUT_MS,
  dispatchClaimedTimeoutMs: DISPATCH_CLAIMED_TIMEOUT_MS,
});

// ── OpenCode plugin event receiver ────────────────────────────────────────────
// The crewswarm-feed OpenCode plugin POSTs events here; we forward to the
// dashboard via SSE.  No polling, no subprocess — push-only.
// Endpoint: POST /api/opencode-event  (no auth required — loopback only)

const connectRT = initWsRouter({
  WebSocket,
  RT_URL,
  RT_TOKEN,
  setRtPublish: (fn) => { rtPublish = fn; },
  startBackgroundLoop,
  resumePipelines,
  agentLastHeartbeat,
  pushRtActivity,
  activeOpenCodeAgents,
  broadcastSSE,
  markDispatchClaimed,
  emitTaskLifecycle,
  pendingDispatches,
  getRateLimitFallback,
  RATE_LIMIT_PATTERN,
  dispatchTask,
  appendHistory,
  pendingPipelines,
  handleAutonomousMentions,
  saveProjectMessage,
  checkWaveQualityGate,
  failPipelineOnQualityGate,
  savePipelineState,
  dispatchPipelineWave,
  parsePipeline,
  parseDispatches,
  parseRegisterProject,
  DASHBOARD,
  autonomousPmLoopSessions
});
_connectRT = connectRT;

// Connect to RT bus on startup
connectRT();
