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
import {
  CREWSWARM_TOOL_NAMES,
  readAgentTools,
  writeAgentTools,
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
  dispatchTask,
} from "./lib/crew-lead/wave-dispatcher.mjs";

// ── Global state (declared early — referenced throughout) ────────────────────
const sseClients = new Set();
const activeOpenCodeAgents = new Map(); // agentId → { model, since }

function broadcastSSE(payload) {
  const event = JSON.stringify(payload);
  for (const client of sseClients) {
    try { client.write(`data: ${event}\n\n`); } catch {}
  }
}

// ── Config ────────────────────────────────────────────────────────────────────

const PORT        = Number(process.env.CREW_LEAD_PORT || 5010);
const HISTORY_DIR = path.join(os.homedir(), ".crewswarm", "chat-history");
// Shared projects registry (same file dashboard writes to for autoAdvance toggle)
const PROJECTS_REGISTRY = path.join(path.dirname(new URL(import.meta.url).pathname), "orchestrator-logs", "projects.json");
const MAX_HISTORY    = 2000; // disk storage cap — effectively unlimited for normal usage
// No LLM_WINDOW cap — models handle 64k–1M tokens. Send full history each call.
const LLM_TIMEOUT = 180000; // 3 min — reasoning models (e.g. gpt-5.1-codex) can take 1–2+ min for complex prompts
const CTL_PATH    = (() => {
  const homeBin = path.join(os.homedir(), "bin", "openswitchctl");
  if (fs.existsSync(homeBin)) return homeBin;
  return path.join(process.cwd(), "scripts", "openswitchctl");
})();
const DASH_PORT   = Number(process.env.SWARM_DASH_PORT || 4319);
const DASH_HOST   = process.env.CREWSWARM_RT_HOST || "127.0.0.1";
const DASHBOARD   = `http://${DASH_HOST}:${DASH_PORT}`;
const DISPATCH_TIMEOUT_MS = Number(process.env.CREWSWARM_DISPATCH_TIMEOUT_MS) || 300_000; // 5 min — unclaimed dispatches (OpenCode tasks need time to spin up)
const DISPATCH_CLAIMED_TIMEOUT_MS = Number(process.env.CREWSWARM_DISPATCH_CLAIMED_TIMEOUT_MS) || 900_000; // 15 min — agent claimed, working (OpenCode CLI can be slow)
// CREWSWARM_CURSOR_WAVES=1 — route multi-agent waves through the Cursor
// crew-orchestrator subagent. All tasks in a wave are fanned out to
// /crew-* Cursor subagents in parallel and results are collected together.
// Runtime-mutable — togglable via dashboard without restart.
function loadCursorWavesEnabled() {
  if (process.env.CREWSWARM_CURSOR_WAVES) return /^1|true|yes$/i.test(String(process.env.CREWSWARM_CURSOR_WAVES));
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "config.json"), "utf8"));
    if (typeof cfg.cursorWaves === "boolean") return cfg.cursorWaves;
  } catch {}
  return false;
}
let _cursorWavesEnabled = loadCursorWavesEnabled();

// Claude Code — runtime-mutable executor toggle
function loadClaudeCodeEnabled() {
  if (process.env.CREWSWARM_CLAUDE_CODE) return /^1|true|yes$/i.test(String(process.env.CREWSWARM_CLAUDE_CODE));
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "config.json"), "utf8"));
    if (typeof cfg.claudeCode === "boolean") return cfg.claudeCode;
  } catch {}
  return false;
}
let _claudeCodeEnabled = loadClaudeCodeEnabled();

const BG_CONSCIOUSNESS_INTERVAL_MS = Number(process.env.CREWSWARM_BG_CONSCIOUSNESS_INTERVAL_MS) || 15 * 60 * 1000;
let BG_CONSCIOUSNESS_MODEL = (() => {
  if (process.env.CREWSWARM_BG_CONSCIOUSNESS_MODEL) return process.env.CREWSWARM_BG_CONSCIOUSNESS_MODEL;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "config.json"), "utf8"));
    if (cfg.bgConsciousnessModel) return cfg.bgConsciousnessModel;
  } catch {}
  return "groq/llama-3.1-8b-instant";
})();
// Runtime-mutable — can be toggled via dashboard without restart.
// Reads from env first, then from ~/.crewswarm/config.json bgConsciousness field.
function loadBgConsciousnessEnabled() {
  if (process.env.CREWSWARM_BG_CONSCIOUSNESS) return /^1|true|yes$/i.test(String(process.env.CREWSWARM_BG_CONSCIOUSNESS));
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "config.json"), "utf8"));
    if (typeof cfg.bgConsciousness === "boolean") return cfg.bgConsciousness;
  } catch {}
  return false;
}
let _bgConsciousnessEnabled = loadBgConsciousnessEnabled();
let _lastBgConsciousnessAt = 0;
// Proxy so existing code using BG_CONSCIOUSNESS_ENABLED still works
const BG_CONSCIOUSNESS_ENABLED_REF = { get enabled() { return _bgConsciousnessEnabled; } };

function loadConfig() {
  const cs      = tryRead(path.join(os.homedir(), ".crewswarm", "config.json"))    || {};
  const csSwarm = tryRead(path.join(os.homedir(), ".crewswarm", "crewswarm.json")) || {};

  const agents = Array.isArray(csSwarm.agents) ? csSwarm.agents : [];
  const agentCfg = agents.find(a => a.id === "crew-lead");
  const modelString = agentCfg?.model || process.env.CREW_LEAD_MODEL || "groq/llama-3.3-70b-versatile";
  const [providerKey, ...modelParts] = modelString.split("/");
  const modelId = modelParts.join("/");
  const provider = csSwarm?.providers?.[providerKey] || cs?.providers?.[providerKey];

  const teamAgents = agents.filter(a => a.id && a.id !== "crew-lead");

  const knownAgents = teamAgents.map(a => a.id);
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
    id:    a.id,
    name:  a.identity?.name  || a.name  || a.id,
    emoji: a.identity?.emoji || a.emoji || "",
    role:  a.identity?.theme || "",
    model: a.model || "",
  }));

  const displayName = agentCfg?.identity?.name || "crew-lead";
  const emoji       = agentCfg?.identity?.emoji || "🦊";

  let fallbackProvider = null, fallbackModelId = null, fallbackProviderKey = null;
  if (agentCfg?.fallbackModel) {
    const [fbPk, ...fbMp] = agentCfg.fallbackModel.split("/");
    fallbackProviderKey = fbPk;
    fallbackModelId = fbMp.join("/");
    fallbackProvider = csSwarm?.providers?.[fbPk] || cs?.providers?.[fbPk];
  }

  return { modelId, providerKey, provider, knownAgents, agentModels, agentRoster, displayName, emoji, fallbackModelId, fallbackProviderKey, fallbackProvider };
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

const BRAIN_PATH = path.join(process.cwd(), "memory", "brain.md");
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
  } catch {}
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
  set model(v) { BG_CONSCIOUSNESS_MODEL = v; },
  get lastActivityAt() { return _lastBgConsciousnessAt; },
  set lastActivityAt(v) { _lastBgConsciousnessAt = v; },
};
const cursorWavesRef = { get enabled() { return _cursorWavesEnabled; }, set enabled(v) { _cursorWavesEnabled = v; } };
const claudeCodeRef = { get enabled() { return _claudeCodeEnabled; }, set enabled(v) { _claudeCodeEnabled = v; } };

initHttpServer({
  sseClients,
  loadConfig,
  loadHistory,
  clearHistory,
  appendHistory,
  broadcastSSE,
  handleChat,
  confirmProject,
  pendingProjects,
  dispatchTask,
  pendingDispatches,
  pendingPipelines,
  resolveAgentId,
  readAgentTools,
  writeAgentTools,
  activeOpenCodeAgents,
  agentTimeoutCounts: _agentTimeoutCounts, // from background.mjs
  crewswarmToolNames: CREWSWARM_TOOL_NAMES,
  classifyTask,
  tryRead,
  resolveSkillAlias,
  connectRT,
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
});
createAndStartServer(PORT);

// Keep alive — don't crash on unhandled promise rejections or async errors
process.on("unhandledRejection", (reason) => {
  console.error("[crew-lead] unhandled rejection (kept alive):", reason?.message || reason);
});
process.on("uncaughtException", (err) => {
  console.error("[crew-lead] uncaught exception (kept alive):", err.message);
});

// ── RT Bus listener — receives replies from agents ────────────────────────────

const RT_URL   = process.env.CREWSWARM_RT_URL   || "ws://127.0.0.1:18889";
const RT_TOKEN = process.env.CREWSWARM_RT_AUTH_TOKEN || (() => {
  try {
    const cs = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "config.json"), "utf8"));
    if (cs?.rt?.authToken) return cs.rt.authToken;
  } catch {}
  return "";
})();

initWaveDispatcher({
  appendHistory,
  broadcastSSE,
  emitTaskLifecycle,
  recordAgentTimeout,
  isAgentOnRtBus,
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
  dispatchTimeoutMs: DISPATCH_TIMEOUT_MS,
  dispatchClaimedTimeoutMs: DISPATCH_CLAIMED_TIMEOUT_MS,
});

// ── OpenCode plugin event receiver ────────────────────────────────────────────
// The crewswarm-feed OpenCode plugin POSTs events here; we forward to the
// dashboard via SSE.  No polling, no subprocess — push-only.
// Endpoint: POST /api/opencode-event  (no auth required — loopback only)

function connectRT() {
  const ws = new WebSocket(RT_URL);
  let ready = false;

  ws.on("open", () => console.log("[crew-lead] RT socket open"));

  ws.on("message", (raw) => {
    let p;
    try { p = JSON.parse(raw.toString()); } catch { return; }

    if (p.type === "server.hello") {
      ws.send(JSON.stringify({ type: "hello", agent: "crew-lead", token: RT_TOKEN }));
      return;
    }
    if (p.type === "hello.ack") {
      ws.send(JSON.stringify({ type: "subscribe", channels: ["done", "events", "command", "issues", "status"] }));
      ready = true;
      // Expose publish function for dispatchTask
      rtPublish = ({ channel, type, to, payload }) => {
        const taskId = crypto.randomUUID();
        ws.send(JSON.stringify({ type: "publish", channel, messageType: type, to, taskId, priority: "high", payload }));
        return taskId;
      };
      console.log("[crew-lead] RT connected — listening for done, events, command, issues");
      // Resume any in-progress pipelines from before restart
      setTimeout(resumePipelines, 2000);
      startBackgroundLoop();
      // Send heartbeat every 30s so monitoring sees crew-lead as up
      if (crewLeadHeartbeat) clearInterval(crewLeadHeartbeat);
      crewLeadHeartbeat = setInterval(() => {
        try {
          const taskId = crypto.randomUUID();
          ws.send(JSON.stringify({
            type: "publish", channel: "status", messageType: "agent.heartbeat",
            to: "broadcast", taskId, priority: "low",
            payload: { agent: "crew-lead", ts: new Date().toISOString() },
          }));
        } catch {}
      }, 30000);
      return;
    }
    if (p.type === "error") {
      console.error("[crew-lead] RT error:", p.message);
      if (/token|auth|unauthorized/i.test(String(p.message))) {
        console.error("[crew-lead] Tip: Set RT token in dashboard Settings (RT Bus) or in ~/.crewswarm/config.json (rt.authToken) so agent replies show in chat.");
      }
      return;
    }

    if (p.type === "message" && p.envelope) {
      const env = p.envelope;
      if (env.id) ws.send(JSON.stringify({ type: "ack", messageId: env.id, status: "received" }));

      const from    = env.from || env.sender_agent_id || env.payload?.source || "";
      const msgType = env.messageType || env.type || "";
      const reply   = env.payload?.reply != null ? String(env.payload.reply).trim() : "";
      const content = reply || (env.payload?.content ? String(env.payload.content).trim() : "");

      // Log all RT traffic so crew-lead has eyes on the system
      const time = new Date().toISOString().slice(11, 19);
      let summary = "";
      if (env.channel === "done" && content) summary = `${from} done: ${content.slice(0, 70)}…`;
      else if (env.channel === "command") summary = `${from} → ${env.to || "?"} ${msgType} ${(env.payload?.content || env.payload?.prompt || "").slice(0, 50)}…`;
      else if (env.channel === "issues") summary = `${from} issue: ${(env.payload?.error || env.payload?.note || "—").slice(0, 60)}`;
      else summary = `${from} ${msgType} ${env.to ? `→ ${env.to}` : ""}`.trim();
      pushRtActivity({ ts: Date.now(), time, channel: env.channel, type: msgType, from, to: env.to, taskId: env.taskId || env.correlationId, summary });

      // Clear stale inOpenCode state when a bridge comes back online after a crash
      if (msgType === "agent.online") {
        const onlineAgent = env.payload?.agent || from;
        if (onlineAgent && activeOpenCodeAgents.has(onlineAgent)) {
          activeOpenCodeAgents.delete(onlineAgent);
          broadcastSSE({ type: "agent_idle", agent: onlineAgent, stalled: false, ts: Date.now() });
        }
      }

      // Forward agent_working / agent_idle events from bridges to SSE clients + SwiftBar
      if (msgType === "agent_working" || msgType === "agent_idle") {
        const agent = env.payload?.agent || from;
        const model = env.payload?.model || "";
        const stalled = env.payload?.stalled || false;
        if (msgType === "agent_working") {
          activeOpenCodeAgents.set(agent, { model, since: Date.now() });
        } else {
          activeOpenCodeAgents.delete(agent);
        }
        broadcastSSE({ type: msgType, agent, model, stalled, ts: Date.now() });
      }

      // On task.in_progress (agent claimed the task), extend timeout so long-running tasks survive
      if (env.channel === "status" && (msgType === "task.in_progress" || msgType === "task.claimed")) {
        const claimedTaskId = env.taskId || env.correlationId || "";
        if (claimedTaskId) markDispatchClaimed(claimedTaskId, from);
      }

      // On task.failed (e.g. rate limit), re-dispatch to a fallback agent so the task still gets done
      if (env.channel === "issues" && (msgType === "task.failed" || env.type === "task.failed")) {
        const failedTaskId = env.taskId || env.correlationId || "";
        const errMsg = String(env.payload?.error || env.payload?.note || "").trim();
        const failedAgent = env.payload?.source || from || "";
        emitTaskLifecycle("failed", { taskId: failedTaskId, agentId: failedAgent, taskType: "task", error: { message: errMsg } });
        const dispatch = pendingDispatches.get(failedTaskId);
        if (dispatch && RATE_LIMIT_PATTERN.test(errMsg)) {
          const fallback = getRateLimitFallback(failedAgent);
          const targetSession = dispatch.sessionId || "owner";
          if (fallback !== failedAgent) {
            pendingDispatches.delete(failedTaskId);
            const newTaskId = dispatchTask(fallback, dispatch.task, targetSession, { ...dispatch, pipelineId: dispatch.pipelineId, waveIndex: dispatch.waveIndex });
            if (newTaskId) {
              appendHistory(targetSession, "system", `[crew-lead] ${failedAgent} hit rate limit (${errMsg.slice(0, 80)}). Re-dispatched same task to ${fallback}.`);
              broadcastSSE({ type: "agent_reply", from: "crew-lead", content: `Rate limit: retried task with ${fallback}.`, sessionId: targetSession, taskId: failedTaskId, ts: Date.now() });
              console.log(`[crew-lead] Rate limit fallback: ${failedAgent} → ${fallback} (task re-dispatched)`);
            }
          }
        }
      }

      const isDone = msgType === "task.done" || env.channel === "done";

      if (isDone && content && from && from !== "crew-lead") {
        console.log(`[crew-lead] ✅ Agent reply from ${from}: ${content.slice(0, 120)}`);

        const taskId = env.taskId || env.correlationId || "";
        const dispatch = pendingDispatches.get(taskId);
        const targetSession = dispatch?.sessionId || "owner";
        // Mark done (keep for /api/status polling) but schedule cleanup after 10 min
        if (dispatch) {
          dispatch.done = true;
          dispatch.result = content.slice(0, 4000);
          setTimeout(() => pendingDispatches.delete(taskId), 600_000);
        }

        // ── Auto-retry if agent asked a question instead of doing the work ──────
        const _autoRetryKey = `_question_retried_${taskId}`;
        const _askedQuestion = /(?:would you like|shall i|should i|do you want|want me to|may i|can i proceed|would it help|do you need|is that correct|shall we|ready to proceed|would you prefer|let me know|please (?:confirm|clarify|specify|advise))\??/i.test(content);
        const _didWork = /@@WRITE_FILE|@@RUN_CMD|wrote|created|updated|fixed|patched|done\.|complete/i.test(content);
        if (_askedQuestion && !_didWork && !pendingPipelines.has(dispatch?.pipelineId) && !global[_autoRetryKey]) {
          global[_autoRetryKey] = true;
          const _originalTask = dispatch?.task || "";
          const _retryTask = (_originalTask.slice(0, 2000) || content.slice(0, 500)) +
            "\n\nDo NOT ask for permission or confirmation. Proceed immediately with your best judgment. Just do it.";
          console.log(`[crew-lead] Agent ${from} asked a question instead of working — auto-retrying`);
          appendHistory(targetSession, "system", `${from} asked a question instead of acting — auto-retrying with explicit instruction.`);
          dispatchTask(from, _retryTask, targetSession);
          return;
        }

        // ── Auto-retry if a coder returned a plan instead of writing code ────────
        const _planRetryKey = `_plan_retried_${taskId}`;
        const _isCoderAgent = /crew-coder|crew-frontend|crew-fixer|crew-ml|crew-coder-back|crew-coder-front/.test(from);
        const _returnedPlan = !_didWork && content.length > 300 && (
          /##\s+(component|feature|file structure|design|breakdown|overview|plan|approach|implementation plan|technical spec)/i.test(content) ||
          /here'?s? (?:the|my|a|what|how)/i.test(content.slice(0, 200))
        );
        if (_isCoderAgent && _returnedPlan && !global[_planRetryKey]) {
          global[_planRetryKey] = true;
          const _originalTask = dispatch?.task || "";
          const _retryTask = `STOP PLANNING. Your last response was a plan/analysis with no code written.\n\nOriginal task: ${_originalTask.slice(0, 1500)}\n\nNow WRITE THE CODE. Use @@WRITE_FILE for every file. Do not describe what you will do — do it.`;
          console.log(`[crew-lead] Agent ${from} returned a plan instead of code — auto-retrying`);
          appendHistory(targetSession, "system", `${from} returned a plan with no code — auto-retrying with explicit execute instruction.`);
          dispatchTask(from, _retryTask, targetSession, dispatch?.pipelineId ? { pipelineId: dispatch.pipelineId } : null);
          return;
        }

        // ── Auto-retry if agent bailed out mid-task ("couldn't complete", "I'm sorry") ──
        const _bailRetryKey = `_bail_retried_${taskId}`;
        const _bailed = /couldn'?t complete|could not complete|i'?m sorry[,.]? but|i was unable to|i'?m unable to|session (?:limit|ended|expired)|ran out of|context (?:limit|window)|i (?:apologize|regret)|partial(?:ly)? complete|not (?:all|every|fully) (?:changes?|tasks?|items?|fixes?)/i.test(content);
        if (_bailed && !global[_bailRetryKey]) {
          global[_bailRetryKey] = true;
          const _originalTask = dispatch?.task || "";
          const fallbackAgent = _isCoderAgent ? from : (getRateLimitFallback(from) || from);
          const _retryTask = `Your previous attempt at this task was incomplete. You said you couldn't finish.\n\nOriginal task:\n${_originalTask.slice(0, 2000)}\n\nDo not apologize. Do not explain why you couldn't finish. Just complete the remaining work now. Use @@WRITE_FILE for every file you change. If the task is too large, complete the most critical items first.`;
          console.log(`[crew-lead] Agent ${from} bailed out mid-task — auto-retrying with ${fallbackAgent}`);
          appendHistory(targetSession, "system", `${from} bailed mid-task — auto-retrying with ${fallbackAgent}.`);
          dispatchTask(fallbackAgent, _retryTask, targetSession, dispatch?.pipelineId ? { pipelineId: dispatch.pipelineId, projectDir: dispatch.projectDir } : null);
          return;
        }

        appendHistory(targetSession, "system", `[${from} completed task]: ${content.slice(0, 4000)}`);
        // Surface background consciousness to owner so the user sees crew-main managing the process
        if (targetSession === "bg-consciousness" && from === "crew-main") {
          const short = content.slice(0, 800).replace(/\n+/g, " ").trim();
          appendHistory("owner", "system", `[crew-main — background]: ${short}`);
          broadcastSSE({ type: "agent_reply", from: "crew-main", content: short, sessionId: "owner", taskId, _bg: true, ts: Date.now() });
          try {
            const statusPath = path.join(os.homedir(), ".crewswarm", "process-status.md");
            const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
            const safe = content.slice(0, 2000).replace(/@@/g, "");
            fs.writeFileSync(statusPath, `# Process status (crew-main)\nLast updated: ${stamp}\n\n${safe}\n`, "utf8");
          } catch (_) {}
        }
        broadcastSSE({ type: "agent_reply", from, content: content.slice(0, 2000), sessionId: targetSession, taskId, ts: Date.now() });
        if (dispatch?.ts) {
          emitTaskLifecycle("completed", {
            taskId,
            agentId: from,
            taskType: "task",
            durationMs: Date.now() - dispatch.ts,
            result: { summary: content.slice(0, 200) },
          });
        }

        // Advance pipeline if this task was part of one (wave-aware)
        if (dispatch?.pipelineId) {
          const pipeline = pendingPipelines.get(dispatch.pipelineId);
          if (pipeline) {
            // Record this task's result and mark it done in the current wave
            pipeline.waveResults.push(content);
            pipeline.pendingTaskIds.delete(taskId);
            pipeline._lastActivity = Date.now();

            console.log(`[crew-lead] Pipeline ${dispatch.pipelineId} wave ${pipeline.currentWave + 1}: ${pipeline.pendingTaskIds.size} task(s) still pending`);

            if (pipeline.pendingTaskIds.size === 0) {
              // Accumulate completed wave results before advancing
              if (!pipeline.completedWaveResults) pipeline.completedWaveResults = [];
              pipeline.completedWaveResults.push([...pipeline.waveResults]);
              // All tasks in this wave are done — run quality gate before advancing
              const gateResult = checkWaveQualityGate(pipeline, dispatch.pipelineId);
              if (gateResult.pass) {
                pipeline.currentWave++;
                savePipelineState(dispatch.pipelineId);
                dispatchPipelineWave(dispatch.pipelineId);
              } else {
                savePipelineState(dispatch.pipelineId);
              }
              // If gate fails, checkWaveQualityGate handles re-dispatch or user notification
            }
          }
        }

        // When PM replies, execute its @@DISPATCH / @@PIPELINE and @@REGISTER_PROJECT
        if (from === "crew-pm") {
          const pipelineSpec = parsePipeline(content);
          if (pipelineSpec) {
            const pipelineId = `pm-${Date.now()}`;
            pendingPipelines.set(pipelineId, {
              steps: pipelineSpec.steps,
              waves: pipelineSpec.waves,
              currentWave: 0,
              pendingTaskIds: new Set(),
              waveResults: [],
              sessionId: targetSession,
            });
            dispatchPipelineWave(pipelineId);
            appendHistory(targetSession, "system", `PM pipeline started (${pipelineSpec.steps.length} steps).`);
          } else {
            const dispatches = parseDispatches(content);
            for (const d of dispatches) {
              const ok = dispatchTask(d.agent, d, targetSession);
              if (ok) appendHistory(targetSession, "system", `PM dispatched to ${d.agent}: "${(d.task || "").slice(0, 120)}".`);
            }
          }
          // PM can register a new project so it appears in the dashboard Projects tab
          const registerProj = parseRegisterProject(content);
          if (registerProj) {
            (async () => {
              try {
                const createRes = await fetch(`${DASHBOARD}/api/projects`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ name: registerProj.name, description: registerProj.description || "", outputDir: registerProj.outputDir }),
                  signal: AbortSignal.timeout(10000),
                });
                const proj = await createRes.json();
                if (proj.ok && proj.project) {
                  appendHistory(targetSession, "system", `PM registered project "${registerProj.name}" in dashboard Projects tab (${registerProj.outputDir}).`);
                  console.log(`[crew-lead] PM registered project: ${registerProj.name} → ${registerProj.outputDir}`);
                } else {
                  appendHistory(targetSession, "system", `PM project registration failed: ${proj.error || "unknown"}.`);
                }
              } catch (e) {
                appendHistory(targetSession, "system", `PM project registration failed: ${e.message}.`);
              }
            })();
          }
        }

        // Autonomous PM loop: on any non-PM agent completion, ping PM to update and dispatch next (if session is in autonomous mode)
        if (from !== "crew-pm" && autonomousPmLoopSessions.has(targetSession)) {
          const handbackTask = `Handback from ${from}: ${content.slice(0, 600)}. Update the roadmap (mark that item done), then dispatch the next task(s) with @@DISPATCH. Keep the pipeline moving until the plan is done or blocked. If no more items, reply "All done." and do not emit @@DISPATCH.`;
          const pmTaskId = dispatchTask("crew-pm", handbackTask, targetSession);
          if (pmTaskId) {
            appendHistory(targetSession, "system", `Autonomous: sent handback to crew-pm to update plan and dispatch next.`);
          }
        }
      }

      // ── cmd approval relay ─────────────────────────────────────────────────
      if (msgType === "cmd.needs_approval" && env.payload?.approvalId) {
        const { approvalId, agent: approvalAgent, cmd } = env.payload;
        console.log(`[crew-lead] 🔐 cmd approval needed — ${approvalAgent}: ${cmd}`);
        broadcastSSE({ type: "confirm_run_cmd", approvalId, agent: approvalAgent, cmd, ts: Date.now() });
      }
    }
  });

  ws.on("close", () => {
    ready = false;
    rtPublish = null;
    if (crewLeadHeartbeat) { clearInterval(crewLeadHeartbeat); crewLeadHeartbeat = null; }
    console.log("[crew-lead] RT disconnected — reconnecting in 5s");
    setTimeout(connectRT, 5000);
  });

  ws.on("error", (e) => console.error("[crew-lead] RT socket error:", e.message));
}
