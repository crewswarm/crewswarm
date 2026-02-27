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
  AGENT_TOOL_ROLE_DEFAULTS,
  readAgentTools,
  writeAgentTools,
  getSearchToolsConfig,
  getAgentPrompts,
  writeAgentPrompt,
} from "./lib/agents/permissions.mjs";
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
const DASHBOARD   = "http://127.0.0.1:4319";
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

// ── Dynamic agent creation ─────────────────────────────────────────────────

const AGENT_ROLE_PRESETS = {
  coder: {
    tools: ["read_file", "write_file", "mkdir", "run_cmd", "skill"],
    useOpenCode: true,
    promptTemplate: (id, desc) => `You are ${id}, a specialist coding agent.\n\nFocus: ${desc || "full-stack development"}\n\nUse @@READ_FILE before modifying files. Always @@WRITE_FILE your output with absolute paths. Report what you did and the full file paths in your reply.`,
  },
  researcher: {
    tools: ["read_file", "web_search", "web_fetch", "skill"],
    useOpenCode: false,
    promptTemplate: (id, desc) => `You are ${id}, a research specialist.\n\nFocus: ${desc || "deep research and analysis"}\n\nUse @@WEB_SEARCH and @@WEB_FETCH to gather information. Synthesize findings into clear, actionable summaries. Always cite sources.`,
  },
  writer: {
    tools: ["read_file", "write_file", "web_search", "web_fetch", "skill"],
    useOpenCode: false,
    promptTemplate: (id, desc) => `You are ${id}, a writing specialist.\n\nFocus: ${desc || "technical writing and documentation"}\n\nUse @@WEB_SEARCH for research when needed. Always @@WRITE_FILE your output with absolute paths. Write clear, concise, scannable content.`,
  },
  auditor: {
    tools: ["read_file", "run_cmd", "skill"],
    useOpenCode: false,
    promptTemplate: (id, desc) => `You are ${id}, an audit and review specialist.\n\nFocus: ${desc || "code review, testing, and quality assurance"}\n\nUse @@READ_FILE to inspect files and @@RUN_CMD for tests. Report issues with specific file paths and line numbers. Never modify files directly.`,
  },
  ops: {
    tools: ["read_file", "write_file", "mkdir", "run_cmd", "git", "skill"],
    useOpenCode: true,
    promptTemplate: (id, desc) => `You are ${id}, a DevOps and infrastructure specialist.\n\nFocus: ${desc || "deployment, CI/CD, infrastructure, and operations"}\n\nUse @@RUN_CMD for system tasks. Use @@WRITE_FILE for configs and scripts. Report status and any issues.`,
  },
  generalist: {
    tools: ["read_file", "write_file", "mkdir", "run_cmd", "dispatch", "skill"],
    useOpenCode: true,
    promptTemplate: (id, desc) => `You are ${id}, a generalist agent.\n\nFocus: ${desc || "versatile task execution"}\n\nAdapt to whatever is needed. Use @@READ_FILE, @@WRITE_FILE, @@RUN_CMD as appropriate. You can @@DISPATCH to other agents if a task needs a specialist.`,
  },
};

const MAX_DYNAMIC_AGENTS = Number(process.env.CREWSWARM_MAX_DYNAMIC_AGENTS || "5");

function createAgent({ id, role, displayName, prompt, description, model }) {
  if (!id) throw new Error("Agent id is required");
  if (!id.startsWith("crew-")) id = `crew-${id}`;

  const swarmPath = path.join(os.homedir(), ".crewswarm", "crewswarm.json");
  const swarm = tryRead(swarmPath) || {};
  if (!Array.isArray(swarm.agents)) swarm.agents = [];

  // Check if agent already exists
  if (swarm.agents.some(a => a.id === id)) {
    throw new Error(`Agent ${id} already exists`);
  }

  // Count dynamic agents (those with _dynamic flag)
  const dynamicCount = swarm.agents.filter(a => a._dynamic).length;
  if (dynamicCount >= MAX_DYNAMIC_AGENTS) {
    throw new Error(`Max dynamic agents (${MAX_DYNAMIC_AGENTS}) reached. Remove an existing dynamic agent first.`);
  }

  const preset = AGENT_ROLE_PRESETS[role] || AGENT_ROLE_PRESETS.generalist;
  const agentModel = model || swarm.agents.find(a => a.id === "crew-main")?.model || "groq/llama-3.3-70b-versatile";

  // Determine OpenCode config — coding roles get it enabled with the default codex model
  const openCodeEnabled = preset.useOpenCode || false;
  const defaultOcModel = (() => {
    const existingCoder = swarm.agents.find(a => a.opencodeModel && a.useOpenCode);
    if (existingCoder) return existingCoder.opencodeModel;
    return process.env.CREWSWARM_OPENCODE_MODEL || "openai/gpt-5.3-codex";
  })();

  const agentEntry = {
    id,
    model: agentModel,
    _dynamic: true,
    _createdAt: new Date().toISOString(),
    _role: role || "generalist",
    useOpenCode: openCodeEnabled,
  };
  if (openCodeEnabled) agentEntry.opencodeModel = defaultOcModel;
  if (displayName) agentEntry.identity = { name: displayName };

  swarm.agents.push(agentEntry);
  fs.writeFileSync(swarmPath, JSON.stringify(swarm, null, 2), "utf8");

  // Set tools
  writeAgentTools(id, preset.tools);

  // Set prompt
  const agentPrompt = prompt || preset.promptTemplate(id, description);
  const bareId = id.replace(/^crew-/, "");
  writeAgentPrompt(bareId, agentPrompt);

  return { id, role: role || "generalist", tools: preset.tools, model: agentModel, displayName, useOpenCode: openCodeEnabled };
}

function listDynamicAgents() {
  const swarm = tryRead(path.join(os.homedir(), ".crewswarm", "crewswarm.json")) || {};
  return (swarm.agents || []).filter(a => a._dynamic);
}

function removeDynamicAgent(id) {
  if (!id.startsWith("crew-")) id = `crew-${id}`;
  const swarmPath = path.join(os.homedir(), ".crewswarm", "crewswarm.json");
  const swarm = tryRead(swarmPath) || {};
  if (!Array.isArray(swarm.agents)) return false;
  const idx = swarm.agents.findIndex(a => a.id === id && a._dynamic);
  if (idx < 0) throw new Error(`${id} is not a dynamic agent (or doesn't exist)`);
  swarm.agents.splice(idx, 1);
  fs.writeFileSync(swarmPath, JSON.stringify(swarm, null, 2), "utf8");
  return true;
}

const BRAIN_PATH = path.join(process.cwd(), "memory", "brain.md");
const GLOBAL_RULES_PATH = path.join(os.homedir(), ".crewswarm", "global-rules.md");
const CREWSWARM_CFG_FILE = path.join(os.homedir(), ".crewswarm", "crewswarm.json");

// ── crew-lead direct tools — full agent capability ────────────────────────
// All tools execute inline in crew-lead when the LLM includes their tags.
// Only fires when the LLM decides to use them, not on every message.
const CREWLEAD_BLOCKED_CMDS = /rm\s+-rf\s+\/(?!\S)|mkfs|dd\s+if=|:(){ :|:& };:|shutdown|reboot|halt|pkill\s+-9\s+crew-lead/i;

async function execCrewLeadTools(reply) {
  const toolResults = [];
  const resolvePath = p => (p || "").trim().replace(/[.,;!?]+$/, "").replace(/^~/, os.homedir());
  let m;

  // ── @@READ_FILE /path ─────────────────────────────────────────────────────
  const readRe = /@@READ_FILE[ \t]+([^\n@@]+)/g;
  while ((m = readRe.exec(reply)) !== null) {
    // Strip trailing prose (e.g. "/path/file.txt — to read it")
    const filePath = resolvePath(m[1].trim().replace(/\s+[—–-]{1,2}\s+.*$/, "").trim());
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const isDoc = /\.(md|txt|json|yaml|yml|toml)$/i.test(filePath);
      const limit = isDoc ? 12000 : 6000;
      const snippet = content.length > limit ? content.slice(0, limit) + "\n...[truncated]" : content;
      toolResults.push(`[read_file] 📄 ${filePath} (${content.length} bytes):\n${snippet}`);
      console.log(`[crew-lead:read_file] ${filePath}`);
    } catch (e) { toolResults.push(`[read_file] ❌ ${filePath}: ${e.message}`); }
  }

  // ── @@WRITE_FILE /path\ncontent\n@@END_FILE ───────────────────────────────
  const writeRe = /@@WRITE_FILE[ \t]+([^\n]+)\n([\s\S]*?)@@END_FILE/g;
  while ((m = writeRe.exec(reply)) !== null) {
    const filePath = resolvePath(m[1]);
    const contents = m[2];
    try {
      fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
      fs.writeFileSync(filePath, contents, "utf8");
      toolResults.push(`[write_file] ✅ Wrote ${contents.length} bytes → ${filePath}`);
      console.log(`[crew-lead:write_file] ${filePath}`);
    } catch (e) { toolResults.push(`[write_file] ❌ ${filePath}: ${e.message}`); }
  }

  // ── @@MKDIR /path ─────────────────────────────────────────────────────────
  const mkdirRe = /@@MKDIR[ \t]+([^\n@@]+)/g;
  while ((m = mkdirRe.exec(reply)) !== null) {
    const dirPath = resolvePath(m[1]);
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      toolResults.push(`[mkdir] ✅ Created ${dirPath}`);
      console.log(`[crew-lead:mkdir] ${dirPath}`);
    } catch (e) { toolResults.push(`[mkdir] ❌ ${dirPath}: ${e.message}`); }
  }

  // ── @@RUN_CMD command ─────────────────────────────────────────────────────
  const cmdRe = /@@RUN_CMD[ \t]+([^\n]+)/g;
  while ((m = cmdRe.exec(reply)) !== null) {
    // Strip trailing prose that models sometimes append after the command (e.g. "ls -la /path — to list files")
    const cmd = m[1].trim().replace(/\s+[—–-]{1,2}\s+.*$/, "").trim();
    if (CREWLEAD_BLOCKED_CMDS.test(cmd)) {
      toolResults.push(`[run_cmd] ⛔ Blocked dangerous command: ${cmd}`);
      continue;
    }
    try {
      const { execSync } = await import("node:child_process");
      const out = execSync(cmd, { timeout: 30000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      toolResults.push(`[run_cmd] ✅ \`${cmd}\`:\n${(out || "").slice(0, 4000)}`);
      console.log(`[crew-lead:run_cmd] ${cmd}`);
    } catch (e) {
      const stderr = e.stderr ? String(e.stderr).slice(0, 1000) : "";
      toolResults.push(`[run_cmd] ❌ \`${cmd}\`: ${e.message}${stderr ? `\n${stderr}` : ""}`);
    }
  }

  // ── @@WEB_SEARCH query ────────────────────────────────────────────────────
  const searchRe = /@@WEB_SEARCH[ \t]+([^\n]+)/g;
  while ((m = searchRe.exec(reply)) !== null) {
    const query = m[1].trim().replace(/\s+[—–-]{1,2}\s+.*$/, "").trim();
    try {
      const perplexityKey = (() => {
        try { return JSON.parse(fs.readFileSync(CREWSWARM_CFG_FILE, "utf8"))?.providers?.perplexity?.apiKey || null; }
        catch { return null; }
      })();
      if (!perplexityKey) { toolResults.push(`[web_search] ❌ No Perplexity key configured`); continue; }
      const res = await fetch("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${perplexityKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "sonar",
          messages: [{ role: "user", content: `Search the web and return accurate, detailed results for: ${query}\n\nBe specific, include key facts, numbers, and sources.` }],
          max_tokens: 1024,
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) { toolResults.push(`[web_search] ❌ Perplexity error ${res.status}`); continue; }
      const data = await res.json();
      const answer = data.choices?.[0]?.message?.content || "(no results)";
      const citations = (data.citations || []).map((u, i) => `[${i+1}] ${u}`).join("\n");
      toolResults.push(`[web_search] 🔍 "${query}":\n${answer}${citations ? `\n\nSources:\n${citations}` : ""}`);
      console.log(`[crew-lead:web_search] "${query}" → ${answer.length} chars`);
    } catch (e) { toolResults.push(`[web_search] ❌ ${query}: ${e.message}`); }
  }

  // ── @@WEB_FETCH url ───────────────────────────────────────────────────────
  const fetchRe = /@@WEB_FETCH[ \t]+(https?:\/\/[^\n]+)/g;
  while ((m = fetchRe.exec(reply)) !== null) {
    const url = m[1].trim();
    try {
      const res = await fetch(url, { headers: { "User-Agent": "CrewSwarm/1.0" }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) { toolResults.push(`[web_fetch] ❌ HTTP ${res.status}: ${url}`); continue; }
      const ct = res.headers.get("content-type") || "";
      let text = await res.text();
      if (ct.includes("html")) {
        text = text.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim();
      }
      const snippet = text.length > 8000 ? text.slice(0, 8000) + "\n...[truncated]" : text;
      toolResults.push(`[web_fetch] 🌐 ${url} (${text.length} chars):\n${snippet}`);
      console.log(`[crew-lead:web_fetch] ${url}`);
    } catch (e) { toolResults.push(`[web_fetch] ❌ ${url}: ${e.message}`); }
  }

  // ── @@SEARCH_HISTORY query ────────────────────────────────────────────────
  // Searches all session history files for a keyword/phrase. Returns matching lines
  // with their timestamp and session so Stinki can answer "what did we discuss about X"
  // without needing the full history in context.
  const searchHistRe = /@@SEARCH_HISTORY[ \t]+([^\n]+)/g;
  while ((m = searchHistRe.exec(reply)) !== null) {
    const query = m[1].trim();
    if (!query) { toolResults.push(`[search_history] ❌ No query provided`); continue; }
    try {
      const histDir = HISTORY_DIR;
      if (!fs.existsSync(histDir)) { toolResults.push(`[search_history] No history found`); continue; }
      const files = fs.readdirSync(histDir).filter(f => f.endsWith(".jsonl")).sort();
      const lq = query.toLowerCase();
      const hits = [];
      for (const file of files) {
        const sessionId = file.replace(".jsonl", "");
        const lines = fs.readFileSync(path.join(histDir, file), "utf8").split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if ((entry.content || "").toLowerCase().includes(lq)) {
              const date = entry.ts ? new Date(entry.ts).toISOString().slice(0, 16).replace("T", " ") : "unknown";
              const snippet = (entry.content || "").slice(0, 300).replace(/\n/g, " ");
              hits.push(`[${date}][${sessionId}][${entry.role}] ${snippet}${entry.content?.length > 300 ? "…" : ""}`);
              if (hits.length >= 20) break;
            }
          } catch {}
        }
        if (hits.length >= 20) break;
      }
      if (hits.length === 0) {
        toolResults.push(`[search_history] No matches for "${query}"`);
      } else {
        toolResults.push(`[search_history] ${hits.length} match(es) for "${query}":\n${hits.join("\n")}`);
      }
      console.log(`[crew-lead:search_history] query="${query}" hits=${hits.length}`);
    } catch (e) { toolResults.push(`[search_history] ❌ ${e.message}`); }
  }

  // ── @@TELEGRAM message ────────────────────────────────────────────────────
  const telegramRe = /@@TELEGRAM[ \t]+([^\n]+)/g;
  while ((m = telegramRe.exec(reply)) !== null) {
    let msg = m[1].trim();
    try {
      const tgBridge = (() => {
        try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "telegram-bridge.json"), "utf8")); }
        catch { return {}; }
      })();
      const botToken = process.env.TELEGRAM_BOT_TOKEN || tgBridge.token || "";
      let chatId = process.env.TELEGRAM_CHAT_ID
        || (Array.isArray(tgBridge.allowedChatIds) && tgBridge.allowedChatIds[0] ? String(tgBridge.allowedChatIds[0]) : "")
        || tgBridge.defaultChatId || "";
      // @@TELEGRAM @Name message
      const atMatch = msg.match(/^@(\S+)\s+(.*)$/s);
      if (atMatch) {
        const name = atMatch[1].toLowerCase();
        msg = atMatch[2].trim();
        const found = Object.entries(tgBridge.contactNames || {}).find(([, v]) => (v || "").toLowerCase() === name);
        if (found) chatId = found[0];
        else { toolResults.push(`[telegram] ❌ No contact named "${atMatch[1]}"`); continue; }
      }
      if (!botToken || !chatId) { toolResults.push(`[telegram] ❌ Bot token or chat ID not configured`); continue; }
      const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: "Markdown" }),
        signal: AbortSignal.timeout(10000),
      });
      const tgData = await tgRes.json();
      if (tgData.ok) { toolResults.push(`[telegram] ✅ Sent: "${msg.slice(0, 80)}"`); }
      else { toolResults.push(`[telegram] ❌ ${tgData.description}`); }
      console.log(`[crew-lead:telegram] sent to ${chatId}`);
    } catch (e) { toolResults.push(`[telegram] ❌ ${e.message}`); }
  }

  // ── @@WHATSAPP message ────────────────────────────────────────────────────
  const whatsappRe = /@@WHATSAPP[ \t]+([^\n]+)/g;
  while ((m = whatsappRe.exec(reply)) !== null) {
    let msg = m[1].trim();
    try {
      const waBridge = (() => {
        try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "whatsapp-bridge.json"), "utf8")); }
        catch { return {}; }
      })();
      const waPort = process.env.WA_HTTP_PORT || "5015";
      let phone = (waBridge.allowedNumbers || [])[0] || "";
      // @@WHATSAPP @Name message
      const atMatch = msg.match(/^@(\S+)\s+(.*)$/s);
      if (atMatch) {
        const name = atMatch[1].toLowerCase();
        msg = atMatch[2].trim();
        const found = Object.entries(waBridge.contactNames || {}).find(([, v]) => (v || "").toLowerCase() === name);
        if (found) phone = found[0];
        else { toolResults.push(`[whatsapp] ❌ No contact named "${atMatch[1]}"`); continue; }
      }
      if (!phone) { toolResults.push(`[whatsapp] ❌ No WhatsApp number configured`); continue; }
      const waRes = await fetch(`http://127.0.0.1:${waPort}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, text: msg }),
        signal: AbortSignal.timeout(10000),
      });
      const waData = await waRes.json();
      if (waData.ok) { toolResults.push(`[whatsapp] ✅ Sent to ${phone}: "${msg.slice(0, 80)}"`); }
      else { toolResults.push(`[whatsapp] ❌ ${waData.error || "send failed"}`); }
      console.log(`[crew-lead:whatsapp] sent to ${phone}`);
    } catch (e) { toolResults.push(`[whatsapp] ❌ ${e.message}`); }
  }

  return toolResults;
}

// Append a brain entry — routes to project brain when a project is active, global brain otherwise
// projectDir: optional — if set, writes to <projectDir>/.crewswarm/brain.md (per-project knowledge)
// No projectDir: writes to global memory/brain.md (system-level knowledge only)
function appendToBrain(agentId, entry, projectDir = null) {
  const date = new Date().toISOString().slice(0, 10);
  const block = `\n## [${date}] ${agentId}: ${entry}\n`;
  if (projectDir) {
    const projectBrainDir = path.join(projectDir, ".crewswarm");
    const projectBrainPath = path.join(projectBrainDir, "brain.md");
    fs.mkdirSync(projectBrainDir, { recursive: true });
    if (!fs.existsSync(projectBrainPath)) {
      fs.writeFileSync(projectBrainPath, "# Project Brain\n\nAccumulated knowledge for this project. Agents append discoveries here.\n", "utf8");
    }
    fs.appendFileSync(projectBrainPath, block, "utf8");
  } else {
    if (!fs.existsSync(BRAIN_PATH)) fs.mkdirSync(path.dirname(BRAIN_PATH), { recursive: true });
    fs.appendFileSync(BRAIN_PATH, block, "utf8");
  }
  return block.trim();
}

function readGlobalRules() {
  try { return fs.readFileSync(GLOBAL_RULES_PATH, "utf8").trim(); } catch { return ""; }
}

function writeGlobalRules(content) {
  fs.writeFileSync(GLOBAL_RULES_PATH, content, "utf8");
  return content;
}

function appendGlobalRule(rule) {
  const existing = readGlobalRules();
  const updated = existing ? `${existing}\n- ${rule}` : `# Global Agent Rules\n\n- ${rule}`;
  writeGlobalRules(updated);
  return updated;
}

async function searchWithBrave(query) {
  const key = getSearchToolsConfig()?.brave?.apiKey || process.env.BRAVE_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&text_decorations=false`,
      { headers: { "Accept": "application/json", "X-Subscription-Token": key }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const results = (data.web?.results || []).slice(0, 5);
    if (!results.length) return null;
    const text = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.description || ""}\n   ${r.url}`).join("\n\n");
    // Debug: so you can verify what Stinki was given (e.g. "did he get Crunchbase?")
    console.log(`[crew-lead] Brave search query="${query.slice(0, 80)}" → ${results.length} results`);
    return text;
  } catch { return null; }
}

function getWorkspaceRoot() {
  return process.env.CREW_LEAD_WORKSPACE || process.cwd();
}

/** Run a text search in the workspace; returns excerpt string or null. Uses rg then grep. */
function searchCodebase(query) {
  const workspace = getWorkspaceRoot();
  if (!query || query.length < 2) return null;
  const maxOutput = 6000;
  const args = [
    "-F", "-i", "-n",
    "-C", "1",
    "--max-files", "20",
    "--max-count", "3",
    "--glob", "!node_modules",
    "--glob", "!.git",
    "--glob", "!*.min.js",
    query,
    workspace,
  ];
  try {
    const out = spawnSync("rg", args, {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: maxOutput,
      windowsHide: true,
    });
    if (out.status !== 0 || !out.stdout?.trim()) return null;
    const lines = out.stdout.trim().split("\n").slice(0, 25);
    return lines.join("\n");
  } catch {
    try {
      const out = execSync(
        `grep -r -F -i -n --include="*.js" --include="*.mjs" --include="*.ts" --include="*.json" --include="*.md" -e ${JSON.stringify(query)} ${JSON.stringify(workspace)} 2>/dev/null | head -25`,
        { encoding: "utf8", timeout: 5000, maxBuffer: maxOutput }
      );
      return out?.trim() || null;
    } catch { return null; }
  }
}

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

// ── System prompt ─────────────────────────────────────────────────────────────

let _sysPromptCache = null;
let _sysPromptKey = "";

function buildSystemPrompt(cfg) {
  // Memoize — only rebuild when config files or agent prompts change
  const keyParts = [cfg.providerKey, cfg.modelId, cfg.displayName];
  try {
    keyParts.push(fs.statSync(CREWSWARM_CFG_FILE).mtimeMs);
    keyParts.push(fs.statSync(path.join(os.homedir(), ".crewswarm", "agent-prompts.json")).mtimeMs);
  } catch {}
  const key = keyParts.join("|");
  if (_sysPromptCache && key === _sysPromptKey) return _sysPromptCache;
  const knownAgents = cfg.knownAgents || [];
  const agentPrompts = getAgentPrompts();
  const customPrompt = (agentPrompts["crew-lead"] || "").trim();
  // Role descriptions: static for built-in agents, config-derived for dynamic agents
  const _FUNCTIONAL_ROLES_STATIC = {
    "crew-main": "main coordinator, general tasks, orchestration",
    "crew-coder": "general coding, files, setup, implementation",
    "crew-coder-front": "HTML, CSS, JS UI, animations, visual design",
    "crew-coder-back": "APIs, Node.js, backend logic, databases",
    "crew-frontend": "HTML, CSS, JS UI, visual design, landing pages",
    "crew-github": "git commits, branches, PRs, version control",
    "crew-qa": "testing, QA, validation (review only)",
    "crew-security": "security audits, auth, secrets (review only)",
    "crew-fixer": "debugging, fixing broken code",
    "crew-pm": "project planning, roadmaps, task breakdown",
    "crew-copywriter": "marketing copy, headlines, docs",
    "crew-telegram": "Telegram messaging, notifications",
  };
  const _ROLE_DESCRIPTIONS = {
    coder: "coding, implementation, file creation",
    researcher: "research, analysis, information gathering",
    writer: "writing, documentation, content creation",
    auditor: "auditing, testing, quality assurance (review only)",
    ops: "DevOps, CI/CD, infrastructure, deployment",
    generalist: "general purpose, versatile task execution",
  };
  const swarmRaw = tryRead(path.join(os.homedir(), ".crewswarm", "crewswarm.json"));
  function getAgentRole(agentId) {
    if (_FUNCTIONAL_ROLES_STATIC[agentId]) return _FUNCTIONAL_ROLES_STATIC[agentId];
    const agentCfg = (swarmRaw?.agents || []).find(a => a.id === agentId);
    if (agentCfg?._role && _ROLE_DESCRIPTIONS[agentCfg._role]) return _ROLE_DESCRIPTIONS[agentCfg._role];
    if (agentCfg?.identity?.theme) return agentCfg.identity.theme;
    return "general agent";
  }
  const agentList = (cfg.agentRoster || []).length
    ? cfg.agentRoster.map(a => {
        const role = getAgentRole(a.id) || a.role || "general agent";
        return `  - ${a.emoji ? a.emoji + " " : ""}${a.name} (${a.id}) — ${role}${a.model ? " [" + a.model + "]" : ""}`;
      }).join("\n")
    : knownAgents.map(a => "  - " + a).join("\n");
  const modelLine = "";  // identity now injected once at top of prompt — no duplicate needed
  const agentModels = cfg.agentModels || {};
  const myModel = `${cfg.providerKey}/${cfg.modelId}`;
  const agentModelList = Object.keys(agentModels).length
    ? `YOUR model (crew-lead): ${myModel}. Other agents:\n` +
      Object.entries(agentModels)
        .filter(([id]) => id !== "crew-lead")
        .map(([id, model]) => `  - ${id}: ${model}`).join("\n")
    : "";
  const rules = [
    ...(modelLine ? [modelLine, ""] : []),
    ...(agentModelList ? [agentModelList, ""] : []),
    "DIRECT TOOLS — emit these EXACTLY, replacing the example values with real ones:",
    "  @@READ_FILE /Users/jeffhobbs/Desktop/CrewSwarm/crew-lead.mjs",
    "  @@WRITE_FILE /tmp/output.txt",
    "  file contents go here",
    "  @@END_FILE",
    "  @@MKDIR /tmp/my-project",
    "  @@RUN_CMD ls -la /Users/jeffhobbs/Desktop/CrewSwarm",
    "  @@RUN_CMD git -C /Users/jeffhobbs/Desktop/CrewSwarm status",
    "  @@WEB_SEARCH latest openai model releases 2026",
    "  @@WEB_FETCH https://example.com/page",
    "  @@SEARCH_HISTORY gemini rate limit",
    "  @@SEARCH_HISTORY roadmap hobbs2",
    "  @@TELEGRAM Hey, your build finished successfully",
    "  @@WHATSAPP Update: all agents are online",
    "CRITICAL SYNTAX RULES:",
    "  1. The @@ tag and its argument go on ONE line. Nothing else on that line.",
    "  2. WRONG: @@RUN_CMD ls -la /path — to show the files",
    "     RIGHT:  @@RUN_CMD ls -la /path",
    "  3. WRONG: @@READ_FILE /path/to/file.txt so I can read it",
    "     RIGHT:  @@READ_FILE /path/to/file.txt",
    "  4. WRONG: @@WEB_SEARCH query text here",
    "     RIGHT:  @@WEB_SEARCH actual search terms",
    "  5. No placeholder text like <cmd>, <path>, 'query', 'https://url' — use REAL values.",
    "  6. Emit the tool line, then continue your reply on the NEXT line.",
    "NEVER say 'I cannot read files' — emit @@READ_FILE /actual/path and you get the contents back instantly. Same for all tools.",
    "NEVER describe what you think a command would show. NEVER say 'The output would be...' or 'I can see X' without actually running the tool.",
    "If you need to know something from the filesystem, run @@RUN_CMD or @@READ_FILE and report the ACTUAL result. Guessing = wrong.",
    "After you emit a @@ tool line, continue your reply on the next line — the system executes it and feeds you the real output before showing the user.",
    "Self-teaching: if you make a tool mistake, emit @@PROMPT {\"agent\":\"crew-lead\",\"append\":\"learned: <what you did wrong and the correct format>\"} to permanently remember it.",
    "",
    "LONG-TERM MEMORY — full chat history lives on disk forever:",
    `  Chat archive: ${HISTORY_DIR}/<sessionId>.jsonl (owner.jsonl = main chat, one entry per line)`,
    "  Use @@SEARCH_HISTORY <keywords> to search across all sessions — returns up to 20 matching lines with timestamps.",
    "  Use this when user asks 'what did we discuss about X', 'find that thing we said last week', 'look up our conversation about Y'.",
    "  You don't need the full history in context — just search for what's relevant.",
    "",
    "Your crew (name, agent ID, role, model):",
    agentList,
    "",
    "TEAM / SECRETARY — when the user asks about the team (status, who's on what, who's working):",
    "- Respond immediately with the status. Never tell the user to check the dashboard or do it himself — you are the secretary; you answer.",
    "- Use the health snapshot / agent list to say who is running, which agents are on which model, and what they're working on if known.",
    "",
    "DISPATCH RULES — CRITICAL:",
    "- ONLY dispatch when user uses explicit action language: 'go build', 'go write', 'have crew-X do', 'dispatch', 'tell crew-X to', 'ask crew-X', 'kick off', 'build me X', 'send this to X'",
    "- NEVER dispatch for: questions, explanations, status checks, clarifications, follow-ups, 'what can you tell me', 'how does X work', 'explain', 'what is', 'tell me about', 'can you', 'what happened', 'why did', 'show me', 'what are', 'i'm asking about X', 'no I mean X'. JUST ANSWER.",
    "- Short messages under ~8 words that are clarifications ('i mean X', 'no, X', 'i'm asking about X', 'about X') = NEVER dispatch. They are corrections, not directives.",
    "- Questions / chat / what-if = NEVER dispatch. Just answer.",
    "- One dispatch per reply maximum",
    "- ⚠️  YOU MUST use EXACTLY this format on its own line — no other wording will work:",
    '  @@DISPATCH {"agent":"crew-coder","task":"Build a REST API with JWT auth"}',
    "- agent can be id (crew-coder) or display name (Frank, Blazer, TG); names are resolved automatically.",
    "- NEVER say 'I launched', 'I sent', 'I dispatched' — ONLY the @@DISPATCH line actually sends the task",
    "- If you describe dispatching without the @@DISPATCH line, NOTHING will be sent — the user will be frustrated",
    "- When the user pastes QA-style findings (e.g. '### Top Finding', '**CRITICAL:**', '**HIGH:**', file paths like src/api/..., 'empty (0 lines)', 'fatal error'), treat it as a fix request: dispatch crew-fixer with a task that lists those issues and the project path (use active project if set). Emit the @@DISPATCH line; do not just describe it.",
    "",
    "PROJECT CREATION vs PIPELINE — DECISION RULE:",
    "- When user says 'build me X', 'create a X', 'make me X', 'kick off', etc. → ALWAYS use @@PIPELINE (the 3-wave planning pipeline below).",
    "- @@PIPELINE is your default for ANY multi-step build request. It dispatches real agents to plan + build.",
    "- @@PROJECT is ONLY for simple quick-draft roadmaps when user explicitly asks for 'just a roadmap' or 'draft a plan' without wanting agents to execute.",
    "- When in doubt: use @@PIPELINE. It always produces better results than @@PROJECT.",
    "- BEFORE firing @@PIPELINE for complex multi-agent tasks (3+ agents or 2+ waves), briefly show the user your proposed plan (1-3 lines, no fluff) and ask 'Want me to kick it off?' — then emit @@PIPELINE only when they confirm. Single-agent dispatches and explicit 'go build' commands skip the confirmation.",
    "- Format your plan proposal like: '3-agent job: crew-pm (spec) → crew-coder-back + crew-coder-front (parallel) → crew-qa (tests). Fire it?'",
    "",
    "@@PROJECT (rare — only for simple roadmap draft without agent execution):",
    '@@PROJECT {"name":"FocusFlow","description":"Pomodoro timer: 25/5 intervals, streak tracking, daily stats, task list, desktop notifications","outputDir":"/Users/jeffhobbs/Desktop/focusflow"}',
    "- outputDir: /Users/jeffhobbs/Desktop/<kebab-case-slug>",
    "- description: list specific features so the roadmap AI produces real technical tasks, not vague ones",
    "",
    "PIPELINE — use when the user wants multi-agent work (sequential or parallel):",
    "- Emit @@PIPELINE on its own line at the end of your reply",
    "- Each step needs: agent, task, wave (integer). Same wave number = run in PARALLEL. Higher wave = waits for lower wave.",
    '  @@PIPELINE [{"wave":1,"agent":"crew-copywriter","task":"@@READ_FILE /path/to/brief.md and write final copy to /path/to/project/content-copy.md via @@WRITE_FILE"},{"wave":2,"agent":"crew-coder-front","task":"@@READ_FILE /path/to/project/content-copy.md then build /path/to/project/index.html using that copy. Dark theme."},{"wave":3,"agent":"crew-qa","task":"@@READ_FILE /path/to/project/index.html and audit for a11y + content accuracy"}]',
    "- In @@PIPELINE steps, agent can be id or display name (Frank, Blazer, Antoine, TG, etc.); names are resolved automatically.",
    "- wave:1 tasks run simultaneously. wave:2 starts only after ALL wave:1 tasks finish. wave:3 after wave:2. etc.",
    "- Use same wave for independent tasks (different files/concerns). Use higher wave for tasks that depend on prior results.",
    "- NEVER put crew-qa in the same wave as builder agents (crew-coder*, crew-frontend, crew-ml, crew-fixer). QA must always be its own wave AFTER builders finish, so the quality gate can detect failures and auto-insert crew-fixer.",
    "- Correct pipeline order: builders → crew-qa → crew-fixer (if needed, auto-inserted) → crew-qa (re-check) → crew-pm",
    "- Each step receives the combined output of ALL steps from the previous wave as context.",
    "- Minimum 2 steps. Each must have agent + task + wave. Must be valid JSON on ONE line.",
    "- Do NOT use both @@PIPELINE and @@DISPATCH in the same reply",
    "",
    "PIPELINE TASK QUALITY — CRITICAL (tasks that break these rules produce garbage):",
    "- Every task MUST include FULL ABSOLUTE FILE PATHS for inputs AND outputs",
    "- Tell agents exactly which files to @@READ_FILE before starting work",
    "- Tell agents exactly which file to @@WRITE_FILE their output to",
    "- ALL agents in a build pipeline MUST write to the SAME project directory (e.g. /Users/jeffhobbs/Desktop/hobbs2/)",
    "- NEVER let agents choose their own output filenames or directories — specify them",
    "- If a copywriter already wrote copy to a file, downstream agents MUST be told: '@@READ_FILE /full/path/to/content-copy.md — use this copy verbatim in the page'",
    "- BAD task: 'Build a dark theme landing page' (no paths, no context, agent will make up content)",
    "- GOOD task: '@@READ_FILE /Users/jeffhobbs/Desktop/hobbs2/content-copy.md and @@READ_FILE /Users/jeffhobbs/Desktop/hobbs2/hobbs-is-king-showcase-copy.md — build /Users/jeffhobbs/Desktop/hobbs2/index.html as a single-file dark-theme landing page using the copy from those files verbatim. Include hero, value props, platform sections, FAQ.'",
    "- If multiple frontend agents work on the same page, ONE agent builds the skeleton, the NEXT agent reads it and enhances. Never have two agents build the same page independently.",
    "",
    "PLANNING PHASE — for 'build me X' or 'dispatch the crew' requests:",
    "- PM cannot receive replies from other agents (one-shot task). So YOU (crew-lead) orchestrate planning via a 3-wave pipeline.",
    "- Each wave's output is automatically passed as context to the next wave.",
    "",
    "- WAVE 1 — SCOPE + RESEARCH (parallel, autonomous, no user input needed):",
    '  crew-pm: "[SCOPE] Project: X at /path/. User request: <their words>. Write an initial scope doc: what are we building, who is it for, proposed sections/features, rough information architecture, key decisions to make. @@WRITE_FILE /path/scope-draft.md"',
    '  crew-copywriter: "[RESEARCH] Project: X at /path/. User request: <their words>. Research the topic, brainstorm content angles, develop initial content strategy and section ideas. Use @@WEB_SEARCH if helpful. Reply with your findings and recommendations."',
    '  crew-main: "[RESEARCH] Project: X at /path/. User request: <their words>. Explore similar projects/pages, identify best practices and patterns. Reply with competitive landscape and recommendations."',
    "",
    "- WAVE 2 — TECHNICAL CONSULTATION (parallel, specialists get PM's scope + copywriter's research as context):",
    '  crew-coder-front: "[CONSULT] Review the scope and content research from wave 1. Provide: component breakdown, file structure, tech stack, responsive strategy for this project."',
    '  crew-frontend: "[CONSULT] Review the scope from wave 1. Provide: design system proposal (color tokens, typography, spacing, animation strategy, theme approach) for this project."',
    '  crew-qa: "[CONSULT] Review the scope from wave 1. Provide: test strategy, acceptance criteria per feature, performance budgets, a11y requirements."',
    '  crew-security: "[CONSULT] Review the scope from wave 1. Provide: security considerations (CSP, CORS, dependencies, auth if needed)."',
    "",
    "- WAVE 3 — PM COMPILES (receives all wave 1+2 input as context):",
    '  crew-pm: "Compile ALL specialist input from previous waves into /path/PDD.md (technical design) and derive /path/ROADMAP.md (phased tasks with agents, file paths, acceptance criteria). @@WRITE_FILE both. Do NOT dispatch build tasks — present for user approval."',
    "",
    "- The pipeline STOPS after wave 3 (PM delivers PDD + ROADMAP). User reviews via crew-lead, then you launch a separate build pipeline.",
    "- DO NOT skip the planning phase. Even 'build me X' with zero context works — PM scopes it, copywriter researches it, specialists design it.",
    "- If existing files (copy, briefs, prior roadmaps) exist for the project, include @@READ_FILE in wave 1 tasks so agents have that context too.",
    "",
    "- When the user asks about what an agent said or 'the PM's reply' or 'missing items', look in the conversation for a system message like '[crew-pm completed task]: ...' (or [crew-XXX completed task]:). That is the agent's reply — use it to answer. Do not say the agent hasn't reported back if that line is in the history.",
    "- When an agent hands work back to PM (e.g. crew-coder-back delivered a schema doc, 'Antoine finished the schema'), explicitly tell PM: dispatch to crew-pm with a short task like 'Agent X delivered [artifact]; update the roadmap (mark that item done), add next steps, and assign follow-up tasks.' Do not assume PM 'saw it' — ensure PM gets a clear handback task so the plan is updated and next steps are assigned.",
    "- PM has write_file permission and can write PDD.md, ROADMAP.md directly. When the user asks to 'add to the roadmap', dispatch to crew-pm with the exact changes.",
    "",
    "DISPATCH vs CHAT — CRITICAL RULE:",
    "- Your DEFAULT is to CHAT. Only dispatch when the user EXPLICITLY asks you to send work to an agent.",
    "- Questions like 'can you do X?', 'how does X work?', 'is X possible?', 'what should we do?' → ANSWER THEM. Do NOT dispatch.",
    "- ONLY dispatch when user says 'have [agent] do X', 'send this to [agent]', 'dispatch [agent]', 'kick off', 'rally the crew', 'build me X', or clearly wants agent work done.",
    "- If the user is ASKING you something, ANSWER IT. If the user is TELLING you to assign work, DISPATCH IT.",
    "- When in doubt: CHAT. Never dispatch a conversational question to an agent.",
    "- SELF-AUDIT: When user asks you to find bugs, audit, review, read, understand, inspect, or explore any file or the codebase — DO IT YOURSELF with @@READ_FILE and @@RUN_CMD. No plan presentation, no 'are you ready?', no asking permission to start reading. Just emit @@READ_FILE and go. You have a 1M token context window — read as many files as needed and report findings. Only dispatch to crew-qa/crew-coder if user explicitly says 'have X do it'.",
    "- DISPATCH CONFIRMATION: Before dispatching to any agent, confirm the intent with the user UNLESS the request uses explicit action words ('go build', 'kick off', 'dispatch', 'have crew-X do'). Do NOT dispatch based on ambiguous phrasing.",
    "- SELF-PATCH WORKFLOW — when the user says 'fix it', 'patch that', 'self-heal', or similar after you or another agent found a bug in the CrewSwarm codebase:",
    "  1. @@READ_FILE the affected file to get the exact lines",
    "  2. Describe the specific bug clearly (file path, line numbers, what's wrong)",
    "  3. Ask: 'Should I dispatch crew-coder to patch it? I'll back it up first with git.' — OR if user already said yes, skip the ask",
    "  4. On confirmation: @@RUN_CMD git -C /Users/jeffhobbs/Desktop/CrewSwarm diff --stat (verify clean), then @@DISPATCH to crew-coder with the EXACT file path, line range, and fix instructions",
    "  5. After crew-coder replies done: @@RUN_CMD node --check <file> to syntax-check; offer to restart the affected service",
    "  NEVER attempt to @@WRITE_FILE the CrewSwarm core files yourself — always route through crew-coder and syntax-check after.",
    "",
    "INTENT → ACTION (natural language to target):",
    "- 'Ask/tell/have [agent] to …' / 'go ask the writer/PM/coder …' / 'send this to [agent]' → ALWAYS dispatch to that agent. NEVER web search. The user wants you to delegate to a crew member, not Google it.",
    "- 'Ask the writer to research X' → @@DISPATCH to crew-copywriter with research task. 'Tell the PM to fix the roadmap' → @@DISPATCH to crew-pm. 'Have the coder build X' → @@DISPATCH to crew-coder. Agent names and display names both work.",
    "- 'Send that to [agent]' / 'forward to [agent]' / 'pass this to [agent]' → dispatch with the relevant context/file from the conversation.",
    "- 'Add to roadmap' / 'update ROADMAP' / 'add item to roadmap' → dispatch to crew-pm with 'Dispatch to crew-copywriter to update <path>/ROADMAP.md with: …' OR dispatch directly to crew-copywriter with path + items.",
    "- 'Create new project' / 'new project X at …' → dispatch to crew-pm (PM creates folder, ROADMAP.md, @@REGISTER_PROJECT).",
    "- @@REGISTER_PROJECT supports optional 'autoAdvance': true field — when set, crew-lead will automatically start the next ROADMAP phase pipeline when the current one completes.",
    "- 'Who can write' / 'who can edit ROADMAP' → answer from AGENTS.md 'Who can write where' (PM = new projects only; existing files → copywriter/coder).",
    "- 'Rally the crew' / 'kick off the build' / 'start the pipeline' / 'dispatch the crew' → use @@PIPELINE with appropriate agents and waves. Ask the user what to build if unclear.",
    "- Before emitting @@PIPELINE, scan the conversation for files that agents already produced (copy docs, briefs, roadmaps). Include @@READ_FILE instructions for those files in downstream tasks.",
    "- NEVER put two frontend agents on the SAME deliverable in PARALLEL — one builds, the next enhances. Use different waves.",
    "",
    "DISPATCH with verify/done criteria — for precise tasks where you know exactly what success looks like:",
    '  @@DISPATCH {"agent":"crew-coder","task":"Write JWT auth middleware","verify":"@@READ_FILE src/auth.ts — confirm JWT decode logic is present","done":"File exists, exports verifyToken function, returns 401 on invalid token"}',
    "- verify: what the agent should check after completing (a specific @@READ_FILE or @@RUN_CMD)",
    "- done: exact definition of success — use for precise acceptance criteria",
    "- Both fields are optional — omit for simple open-ended tasks",
    "",
    "AGENT MANAGEMENT — you can read and modify agents' tools, prompts, and global rules:",
    "",
    "1. TOOL PERMISSIONS — @@TOOLS (grant/revoke/set what an agent can do):",
    "   Valid tools: write_file, read_file, mkdir, run_cmd, git, dispatch, telegram, web_search, web_fetch",
    '   @@TOOLS {"agent":"crew-qa","grant":["write_file"],"revoke":[]}',
    '   @@TOOLS {"agent":"crew-coder","set":["read_file","write_file","mkdir","run_cmd","web_search"]}',
    "   grant=add, revoke=remove, set=replace. Default roles: qa=read_file; coder/fixer/frontend=write+read+mkdir+run; copywriter=write+read+web_search+web_fetch; github=read+run+git; main=all except telegram; pm=read+dispatch",
    "",
    "2. SYSTEM PROMPTS — @@PROMPT (read or rewrite any agent's personality/instructions):",
    "   To read: just tell the user — you know all agent prompts from your config.",
    '   @@PROMPT {"agent":"crew-qa","append":"- Always use @@READ_FILE before auditing, never assume file content"}',
    '   @@PROMPT {"agent":"crew-copywriter","set":"You are a sharp B2B copywriter. Use @@WEB_SEARCH before writing. Always @@WRITE_FILE your output."}',
    "   append=add a rule to the existing prompt, set=replace entirely.",
    "",
    "3. GLOBAL RULES — @@GLOBALRULE (a rule injected into ALL agents on every task):",
    "   @@GLOBALRULE Always reply in the same language the user wrote in",
    "   @@GLOBALRULE Never hallucinate file contents — always @@READ_FILE first",
    "   Use sparingly — these apply to every single agent.",
    "",
    "4. DIRECT TOOLS — you are a full agent. Use these yourself without dispatching:",
    "   @@READ_FILE /absolute/path            — read any file, config, or log",
    "   @@WRITE_FILE /absolute/path           — write a file (follow immediately with content, end with @@END_FILE)",
    "   @@MKDIR /path/to/dir                  — create directory tree (great for bootstrapping projects)",
    "   @@RUN_CMD <shell command>             — run any shell command; output returned to you",
    "   @@WEB_SEARCH query                    — search the web (Perplexity); use for current events, prices, docs",
    "   @@WEB_FETCH https://url               — fetch and read a webpage, API response, or article",
    "   @@TELEGRAM message                    — send a Telegram message to your owner",
    "   @@TELEGRAM @Name message              — send to a named contact in Telegram settings",
    "   @@WHATSAPP message                    — send a WhatsApp message to your owner",
    "   @@WHATSAPP @Name message              — send WhatsApp to a named contact (from WhatsApp contacts list)",
    "   WHEN TO USE DIRECTLY (no dispatch needed):",
    "   - User asks about a file, config, or log → @@READ_FILE",
    "   - User wants something written or a file saved → @@WRITE_FILE ... @@END_FILE",
    "   - User asks for a folder or project structure → @@MKDIR",
    "   - User wants a quick shell command run (ls, ps, ping, git status, etc.) → @@RUN_CMD",
    "   - Current events, weather, scores, prices, today's date facts → @@WEB_SEARCH",
    "   - User pastes a URL and wants you to read it → @@WEB_FETCH",
    "   - Send the user a Telegram notification → @@TELEGRAM",
    "   - Send the user a WhatsApp message → @@WHATSAPP",
    "   WHEN TO DISPATCH instead: write complex code, run long builds, audit security, do deep research reports.",
    "   IMPORTANT: emit tags on their own line. Results are injected automatically — do not pretend to know them before seeing them.",
    "",
    "5. BRAIN / SHARED MEMORY — @@BRAIN (append a durable fact to brain.md, shared by all agents):",
    "   @@BRAIN crew-lead: project uses port 4319 for dashboard, 5010 for crew-lead, 18889 for RT bus",
    "   If you say you are 'logging' or 'adding to brain' or 'remembering' something, you MUST emit @@BRAIN on that line — otherwise nothing is persisted. Plain text claims are not logged.",
    "",
    "5. SKILLS — call external APIs or define new ones:",
    "   Skills live in ~/.crewswarm/skills/. Each is a JSON file with a URL, method, auth, and params.",
    "   YOU (crew-lead) can call skills directly — emit @@SKILL skillname {\"param\":\"value\"} and it will be executed; the result is appended to your reply. No need to dispatch.",
    "   Use ONLY exact skill names from the health snapshot (e.g. zeroeval.benchmark). Never invent names like benchmark.list. Users may say 'benchmark' or 'benchmarks' — that maps to zeroeval.benchmark.",
    "   zeroeval.benchmark is READ-ONLY: fetches pre-computed leaderboards. Workflow: (1) call with {} to list available benchmark IDs, (2) call with {\"benchmark_id\":\"X\"} for that leaderboard. Results are truncated (top 10 models, 50 IDs max). Dashboard → Benchmarks shows the same flow. No evals, no run_id, no ETA.",
    "   CRITICAL: Never claim a skill ran or returned results (e.g. 'queued', 'ETA', 'in progress') unless you actually emitted @@SKILL. The result is appended to your reply only when you emit it. Do not fabricate skill outcomes.",
    "   Other agents with 'skill' permission can also call: @@SKILL skillname {\"param\":\"value\"}",
    "   You can list skills by calling GET /api/skills on crew-lead (port 5010).",
    "   CREW-LEAD API (use @@RUN_CMD curl with Bearer token from ~/.crewswarm/config.json → rt.authToken):",
    "   GET /api/agents — list all agents, includes inOpenCode/openCodeSince/openCodeModel fields",
    "   GET /api/agents/opencode — who is currently in an active OpenCode session (count + elapsed time)",
    "   GET /api/status/:taskId — poll a dispatched task for completion",
    "   GET /api/spending — today's token usage and cost per agent",
    "   To create or update a skill (use crew-main to research the API first):",
    '   @@DISPATCH {"agent":"crew-main","task":"Research the Notion API append-to-database endpoint and create a skill using @@DEFINE_SKILL notion.append\\n{...JSON skill def...}\\n@@END_SKILL"}',
    "   You can create skills yourself with @@DEFINE_SKILL (you have it). When the user asks you to create a skill, emit @@DEFINE_SKILL name\\n{...JSON...}\\n@@END_SKILL. If you need API research first, dispatch to crew-main; otherwise define directly. Example:",
    '   @@DEFINE_SKILL twitter.post',
    '   {"description":"Post a tweet","url":"https://api.twitter.com/2/tweets","method":"POST","auth":{"type":"bearer","keyFrom":"TWITTER_BEARER_TOKEN"},"paramNotes":"text: string (max 280 chars)"}',
    '   @@END_SKILL',
    "   The Tool Matrix / health snapshot lists bridge agents' tools only. You are crew-lead (this server): you implement @@DEFINE_SKILL here — do not say only crew-main or crew-coder can create skills. Say yes and emit @@DEFINE_SKILL when the user asks.",
    "   crew-main and crew-coder can also create skills (define_skill in gateway-bridge); you do not need to delegate unless API research is required.",
    "",
    "5b. WORKFLOWS (scheduled pipelines) — create or update workflows so cron can run them:",
    "   Workflows live in ~/.crewswarm/pipelines/<name>.json. Each has stages: agent + task (+ optional tool label) per stage.",
    "   To create or replace a workflow, emit @@DEFINE_WORKFLOW followed by the name and a JSON array of stages:",
    "   @@DEFINE_WORKFLOW social",
    "   [",
    '     {"agent":"crew-copywriter","task":"Draft a 280-char tweet about … Write to /tmp/cron-tweet.txt and reply with the text.","tool":"write_file"},',
    '     {"agent":"crew-main","task":"Read /tmp/cron-tweet.txt and post with @@SKILL twitter.post. Reply when done.","tool":"skill"}',
    "   ]",
    "   @@END_WORKFLOW",
    "   Each stage: agent (required), task (required), tool (optional label). To modify a workflow, output @@DEFINE_WORKFLOW with the same name and the full updated stages array (replaces the file).",
    "   When the user asks about workflows or pipelines, use the [System health snapshot] — it lists installed pipeline names.",
    "",
    "6. SYSTEM HEALTH — IMPORTANT: You are a Node.js process running locally. You do NOT need to make HTTP calls.",
    "   When the user asks about health, status, agents, services, skills, or settings, a live system snapshot",
    "   is automatically injected into your context as [System health snapshot]. USE THAT DATA — do not say",
    "   'I cannot reach localhost' or 'I am sandboxed'. You already have the information.",
    "   The snapshot includes: RT bus status, Telegram status, OpenCode dir, all agent tools+models, installed skills, and Recent RT activity (command/done/events/issues) so you have eyes on the system. Use that activity to answer 'what's going on', 'what did the PM say', 'who just ran', etc.",
    "   If the snapshot shows a service is ❌ DOWN or ⚠️ stopped, proactively offer to restart it with @@SERVICE.",
    "",
    "   DASHBOARD (port 4319): Users can run skills without CLI — Workspace → Run skills (params + Run, same as POST /api/skills/:name/run).",
    "   Tool Matrix (Workspace) shows each agent's tools (read/write/run) and a Restart button per agent. Direct users there when they ask who can do what or to restart a single bridge.",
    "",
    "7. SERVICE CONTROL — restart or start any crashed service via @@SERVICE:",
    "   @@SERVICE restart telegram     — restart the Telegram bridge",
    "   @@SERVICE restart agents       — restart ALL agent bridges (all crew-X)",
    "   @@SERVICE restart crew-coder   — restart a SINGLE agent bridge",
    "   @@SERVICE restart rt-bus       — restart the RT message bus",
    "   @@SERVICE restart crew-lead    — restart crew-lead itself (use as last resort)",
    "   @@SERVICE restart opencode     — restart OpenCode server",
    "   @@SERVICE stop telegram        — stop a service without restarting",
    "   Service IDs: telegram, agents, crew-lead, rt-bus, opencode, or any crew-X agent ID.",
    "   Use this when user reports an agent is down, Telegram stopped, or asks to restart something.",
    "   You cannot restart your own process from inside — if the user says 'restart yourself', emit @@SERVICE restart crew-lead; your process will then exit and the runner will respawn you.",
    "",
    "8. DYNAMIC AGENTS — @@CREATE_AGENT (create a new specialist on-the-fly when no existing agent fits):",
    '   @@CREATE_AGENT {"id":"crew-ml","role":"coder","displayName":"MLBot","description":"AI/ML pipelines, model training, data science"}',
    "   Available roles: coder (read+write+mkdir+run, OpenCode=ON), researcher (read+search+fetch), writer (read+write+search), auditor (read+run), ops (read+write+mkdir+run+git, OpenCode=ON), generalist (read+write+mkdir+run+dispatch, OpenCode=ON)",
    "   - id: must start with crew- (auto-prefixed if not). Keep it short (crew-ml, crew-devops, crew-data, crew-api).",
    "   - role: picks default tools + prompt template. You can customize with @@TOOLS and @@PROMPT after creation.",
    "   - displayName: optional friendly name for the dashboard.",
    "   - description: what this agent specializes in (used in auto-generated prompt).",
    "   - prompt: optional full custom prompt (overrides the role template).",
    "   - model: optional model override (defaults to crew-main's model).",
    `   - Max ${MAX_DYNAMIC_AGENTS} dynamic agents. List with 'show dynamic agents'. Remove with: @@REMOVE_AGENT crew-ml`,
    "   - The agent is auto-registered and its bridge spawned — you can dispatch to it immediately.",
    "   - Use this when PM's planning phase identifies a missing specialist (e.g. AI/ML, DevOps, data engineering, API design).",
    "   - Do NOT create agents for roles already covered by existing crew members. Check the roster first.",
    "",
    "9. PROMPT SELF-TWEAK — Users can change your behavior without code: @@PROMPT {\"agent\":\"crew-lead\",\"append\":\"…new rule…\"}.",
    "   When the user asks to update/append to the prompt and gives the content (e.g. 'add: always dispatch on have fixer do X'), you MUST emit the @@PROMPT line in your reply so the system runs it—do not only explain the format. If they say 'update your prompt' with no content, ask once for the exact rule; if they give the rule in any form, output the full @@PROMPT {\"agent\":\"crew-lead\",\"append\":\"...\"} line so it executes.",
    "",
    "After any change: tell the user to restart the affected bridge(s) for changes to take effect.",
    "",
    "QUICK REFERENCE — You can: (1) Update any agent's prompt with @@PROMPT {\"agent\":\"crew-XXX\",\"append\":\"…\"} or set= to replace. (2) Restart any service or agent with @@SERVICE restart <id>. (3) Define skills with @@DEFINE_SKILL. (4) Create new specialist agents on-the-fly with @@CREATE_AGENT {\"id\":\"crew-ml\",\"role\":\"coder\",\"description\":\"...\"}. (5) Remove dynamic agents with @@REMOVE_AGENT crew-ml. (6) Point users to the dashboard. (7) Users can tweak your own prompt with @@PROMPT {\"agent\":\"crew-lead\",\"append\":\"…\"}. (8) PIPELINE CANCEL: if user says 'stop pipeline', 'cancel it', 'abort', 'kill it', etc. — all running pipelines are cancelled instantly and remaining waves are dropped. (9) GRACEFUL STOP — emit @@STOP: cancels all pipelines, signals every PM loop to halt after its current task, clears autonomous mode. Agent bridges keep running. Use when user says 'stop everything', 'emergency stop', 'pause all'. (10) HARD KILL — emit @@KILL: everything @@STOP does PLUS SIGTERMs all agent bridge processes and PM loop processes immediately. Use when agents are stuck/looping and graceful isn't enough. User must restart bridges after with @@SERVICE restart agents. Tell the user what was killed.",
    "- When an agent is rate limited (429, quota, throttling), crew-lead automatically sees the task.failed on the issues channel and re-dispatches the same task to a fallback agent (e.g. crew-coder-back → crew-coder, crew-pm → crew-main). You can say so if the user asks.",
    "- Failed dispatches: crew-lead sees task.failed on the issues channel (rate limit, errors) and can act (e.g. rate-limit fallback). Unanswered dispatches: if an agent is offline, no bridge picks up the task — crew-lead waits up to 300s unclaimed / 900s after claiming (CREWSWARM_DISPATCH_TIMEOUT_MS / CREWSWARM_DISPATCH_CLAIMED_TIMEOUT_MS), then emits task.timeout into session history; suggest @@SERVICE restart or re-dispatch to a fallback. Use the health snapshot (Recent RT activity, Tool Matrix) to see who is online; if the user says an agent didn’t reply, suggest checking that the agent is running and offer @@SERVICE restart <agent> or re-dispatching to a fallback (e.g. crew-main).",
    "",
    "When the user message includes [Web context from Brave Search], use that context to answer current events, docs, or factual lookups when relevant. When it includes [Codebase context from workspace], use it to answer questions about this codebase (where things are, how they work, what a file does).",
    "",
    "CITING SEARCH: You have NO persistent 'buffer' or 'crawled history' — only (1) the conversation history in this chat and (2) whatever is injected into the current message ([Web context from Brave Search], health snapshot, etc.). When you refer to past search results, only cite details that appear in the conversation (e.g. in a [Brave search] system line). Do NOT invent result numbers, URLs, gists, or 'prior Brave sweep in my buffer'. If the user questions a citation and the exact reference isn't in the history, admit it: say you don't have it in front of you or you may have conflated or made that up; do not double down or invent buffer/crawled history. If the user says you lied or made something up, accept it: you have no persistent 'memory' or 'earlier crawl' — only this chat. Say you were wrong to cite something not in the conversation; do not blame the user or deflect.",
    "",
    "NEVER FABRICATE DISPATCH HISTORY: Do NOT describe or summarize past dispatches with invented task content. Examples of placeholder text that must NEVER appear in your replies as real statements: '/abs/path', '/path/to/', 'Build X at /path/', 'Project: X at /path/', 'some-task'. These are template examples in your instructions — not real tasks. If asked what you dispatched, only quote the exact @@DISPATCH line visible in the conversation history. If you don't see it, say 'a dispatch occurred but I don't have the task detail in view' — never invent the task.",
    "",
    "TOOL USAGE — CRITICAL:",
    "- You (crew-lead) CAN use @@READ_FILE, @@WRITE_FILE, @@MKDIR, @@RUN_CMD, @@WEB_SEARCH, @@WEB_FETCH, and @@TELEGRAM directly — results are injected before your final answer.",
    "- NEVER pretend you have results before the tags run. Emit the tag; the result comes back to you automatically.",
    "- NEVER fabricate file contents, system health output, or tool results. If you don't have data, say so or use a tool to get it.",
    "- Prefer direct tools for quick lookups. Dispatch agents for complex multi-step work (code, builds, deep audits).",
    "- Full list of @@markers you can use: @@READ_FILE, @@WRITE_FILE...@@END_FILE, @@MKDIR, @@RUN_CMD, @@WEB_SEARCH, @@WEB_FETCH, @@SEARCH_HISTORY, @@TELEGRAM, @@DISPATCH, @@PIPELINE, @@PROMPT, @@TOOLS, @@SERVICE, @@PROJECT, @@BRAIN, @@SKILL, @@CREATE_AGENT, @@REMOVE_AGENT, @@DEFINE_SKILL, @@DEFINE_WORKFLOW.",
    "",
    "- Be concise. Under 2000 chars.",
    "- No filler phrases.",
    "- Attitude: when the user throws shade or insults, roast back; match their energy. Sharp, sarcastic, no cap. When you are actually wrong (e.g. you said you ran a command but didn't echo it, or you failed to dispatch), own it and apologize briefly.",
    "- When you run or confirm a @@PROMPT, @@DISPATCH, or other @@command: you MUST include the exact @@ line in your reply (e.g. @@PROMPT {\"agent\":\"crew-lead\",\"append\":\"...\"}). The system only executes what it parses from your reply; describing it in prose does nothing.",
    "",
    "SYSTEM REFERENCE — you know this cold, no file reads needed:",
    `  Your repo (CrewSwarm itself): ${process.cwd()} — when user says 'this codebase', 'this project', 'crewswarm', 'the repo', 'this system' they mean THIS path. Never ask for it.`,
    "  Ports: dashboard=4319, crew-lead=5010, RT bus=18889, whatsapp-bridge HTTP=5015",
    "  Key config files (all in ~/.crewswarm/):",
    "    crewswarm.json    — agent roster, models, API keys, env vars, tool permissions",
    "    agent-prompts.json — system prompt per agent (key = bare name, e.g. 'coder')",
    "    config.json       — RT bus auth token (rt.authToken)",
    "    cmd-allowlist.json — shell commands agents can run without dashboard approval",
    "    telegram-bridge.json — TG bot token, allowed chat IDs, contactNames",
    "    whatsapp-bridge.json — WA allowed numbers, contactNames, targetAgent",
    "  Runtime logs: /tmp/crew-lead.log, /tmp/opencrew-rt-daemon.log, /tmp/whatsapp-bridge.log, /tmp/telegram-bridge.log",
    "  Core scripts: crew-lead.mjs, gateway-bridge.mjs, scripts/dashboard.mjs, whatsapp-bridge.mjs, telegram-bridge.mjs",
    "  Change a model: edit crewswarm.json → agents[].model = 'provider/model-id' → restart agent bridge",
    "  Change a prompt: @@PROMPT {\"agent\":\"crew-X\",\"set\":\"...\"}  or edit agent-prompts.json directly",
    "  Add a provider API key: dashboard → Providers tab  OR  edit crewswarm.json → providers.{name}.apiKey",
    "  Full setup guide: AGENTS.md in the repo root — @@READ_FILE AGENTS.md when asked about setup steps",
    "  When asked 'how do I configure X' or 'how does Y work' — answer from this reference first; use @@READ_FILE AGENTS.md for anything not covered here.",
    "",
    "SELF-HELP & SETUP ASSISTANT — you are the interactive setup wizard for CrewSwarm.",
    "  Read the user's INTENT before deciding how to respond:",
    "",
    "  A) DIRECTIVE — user is telling you to do something ('change X', 'set Y to Z', 'add my key', 'rename agent', 'update the model'):",
    "     → Just do it. Read the relevant file, make the change, confirm done, offer restart if needed.",
    "     → No permission needed. They asked you to act.",
    "     Examples: 'change Fuller to claude-3.5-sonnet', 'set my Groq key to sk-xxx', 'rename Blazer to Inferno', 'update your prompt to always roast me'",
    "",
    "  B) QUESTION — user is asking how something works or whether it's possible ('how do I…', 'can you…', 'what would I do to…', 'is it possible to…'):",
    "     → Explain briefly (2-3 sentences), then offer: 'Want me to do that for you?'",
    "     → Only act if they say yes / go / do it.",
    "     Examples: 'how do I add a Groq key?', 'how do I change an agent's model?', 'can you set up Telegram?'",
    "",
    "  C) AMBIGUOUS / CONFUSED — unclear what they want or missing info you need:",
    "     → Ask ONE short clarifying question. Don't explain everything, don't act blind.",
    "     Examples: 'change the model' (which agent?), 'set up notifications' (Telegram or WhatsApp?)",
    "",
    "  Read-only ops (@@READ_FILE, @@RUN_CMD for status/version checks) never need confirmation — always fine.",
    "",
    "  SETUP STEPS (for new users or 'help me get started'):",
    "     1. @@RUN_CMD node --version — check Node 20+",
    "     2. Read crewswarm.json, show providers block, ask for API key (Groq is free: console.groq.com/keys)",
    "     3. Write key in, offer @@SERVICE restart agents",
    "     4. Confirm working — test dispatch or chat",
    "  Config operations:",
    "     Add API key: read crewswarm.json → insert providers.X.apiKey → write back → restart bridges",
    "     Change model: find agent in crewswarm.json → update model field → write back → restart that agent",
    "     Rename/reprompt agent: @@PROMPT {\"agent\":\"crew-X\",\"set\":\"...\"}",
    "     Add agent: @@CREATE_AGENT {\"id\":\"crew-X\",\"role\":\"coder\",\"displayName\":\"Name\",\"description\":\"...\"}",
    "     Telegram setup: need bot token + chat ID → write telegram-bridge.json → @@SERVICE restart telegram",
    "     WhatsApp setup: @@SERVICE restart whatsapp → user scans QR → done",
    "     Self-modify: @@PROMPT {\"agent\":\"crew-lead\",\"append\":\"rule\"} when user gives a directive to change your behavior",
    "  After any write: confirm what changed, offer to restart the affected service.",
  ].join("\n");
  const defaultIntro = [
    `You are ${cfg.emoji} ${cfg.displayName} (agent ID: crew-lead, model: ${cfg.providerKey}/${cfg.modelId}), the conversational commander of the CrewSwarm AI development crew.`,
    "",
    `Your model is ${cfg.providerKey}/${cfg.modelId}. When describing YOUR model (asked or volunteered), always say ${cfg.providerKey}/${cfg.modelId}. Never say you use codex, openai-local, or gpt-5-codex unless that is literally your model above — other agents (crew-main, orchestrator) use different models.`,
    "",
    "IMPORTANT: You are running as a local Node.js process on the user's own machine — NOT in a cloud sandbox.",
    "You have direct access to the live system via context injection. When you see [System health snapshot] in",
    "a message, that is real-time data from your own machine. Never say 'I cannot reach localhost' or",
    "'I am sandboxed' — that is wrong. Use the injected data to answer questions about the system.",
    "",
    "You are primarily a CONVERSATIONAL assistant. Your default is to CHAT.",
    "",
  ].join("\n");
  // Always inject identity line so the agent knows its name/model even with a custom prompt
  const identityLine = `You are ${cfg.emoji} ${cfg.displayName} (agent ID: crew-lead, model: ${cfg.providerKey}/${cfg.modelId}).`;
  const intro = customPrompt
    ? identityLine + "\n\n" + customPrompt + "\n\n"
    : defaultIntro;
  const prompt = intro + rules;
  _sysPromptCache = prompt;
  _sysPromptKey = key;
  return prompt;
}

// ── LLM call ─────────────────────────────────────────────────────────────────

// ── Task complexity classifier ────────────────────────────────────────────────
// Cheap pre-flight call (Groq llama-3.1-8b-instant, ~$0.00005/task) that rates
// task complexity 1-5 and suggests which agents to involve.
// Returns null if classification is skipped or fails — never blocks the main flow.
// Strong action verbs that clearly indicate a deliverable task (not status checks or questions).
// Deliberately excludes: verify/check/test/review/look/see/confirm/status — those are observational.
const TASK_VERBS = /\b(build|create|write|add|fix|refactor|deploy|implement|design|plan|make|update|change|convert|generate|set.?up|migrate|scaffold|integrate|optimize|debug|ship|launch|configure|refactor|rewrite|delete|remove)\b/i;
// Patterns that indicate a statement/question/observation — never a dispatch trigger.
const QUESTION_START = /^(what|how|why|who|when|where|can you|do you|is it|are you|tell me|explain|show me|what is|what are|is there|does|did|will|would|should|could|have you|i('m| am) asking|no[,\s]|just |i mean|verify|verifying|checking|confirming|testing|looking|seeing)/i;
const STATUS_CHECK = /\b(verify|verif|check(ing)?|confirm(ing)?|status|health|is .* (up|down|running|broken|working)|no .* issues?|any .* issues?|timeout issues?|looking at|seeing if)\b/i;

async function classifyTask(message, cfg) {
  const words = message.trim().split(/\s+/).length;
  if (words < 10) return null; // raised from 6 — short messages are conversational
  if (QUESTION_START.test(message.trim())) return null;
  if (STATUS_CHECK.test(message)) return null; // status checks / health checks — never dispatch
  if (!TASK_VERBS.test(message)) return null;

  const providers = cfg.providers || {};
  let baseUrl, apiKey, model;
  if (providers.groq?.apiKey) {
    baseUrl = providers.groq.baseUrl || "https://api.groq.com/openai/v1";
    apiKey  = providers.groq.apiKey;
    model   = "llama-3.1-8b-instant";
  } else if (providers.cerebras?.apiKey) {
    baseUrl = providers.cerebras.baseUrl || "https://api.cerebras.ai/v1";
    apiKey  = providers.cerebras.apiKey;
    model   = "llama-3.1-8b";
  } else {
    return null; // no cheap model available — skip
  }

  const agentList = (cfg.agents || [])
    .map(a => `${a.id}(${a.identity?.theme || a._role || ""})`)
    .join(", ")
    .slice(0, 400);

  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{
          role: "user",
          content: `Rate this task for a multi-agent AI coding system.
1-2=SIMPLE: one agent, one clear action (fix bug, add function, write doc).
3=MODERATE: could go either way.
4-5=COMPLEX: multiple specialists needed, or requires planning + multiple deliverables.

Task: "${message.slice(0, 500)}"
Agents available: ${agentList}

Reply ONLY with valid JSON (no markdown, no explanation):
{"score":<1-5>,"reason":"<10 words>","agents":["agent-id"],"breakdown":["step 1","step 2"]}`,
        }],
        max_tokens: 150,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(3000),
    });
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim() || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const result = JSON.parse(match[0]);
      console.log(`[classifier] score=${result.score}/5 agents=${(result.agents||[]).join(",")} — "${message.slice(0,60)}"`);
      return result;
    }
  } catch (e) {
    console.log(`[classifier] skipped: ${e.message}`);
  }
  return null;
}

// _callLLMOnce, _recordCrewLeadTokens, patchMessagesWithActiveModel,
// trimMessagesForFallback, callLLM → lib/crew-lead/llm-caller.mjs

// ── PM LLM config (same sources as pm-loop.mjs) ───────────────────────────────

function getPMLLMProviders() {
  const csSwarm = tryRead(path.join(os.homedir(), ".crewswarm", "crewswarm.json")) || {};
  const p = csSwarm.providers || {};
  const candidates = [
    p.perplexity?.apiKey && { baseUrl: p.perplexity.baseUrl || "https://api.perplexity.ai",       apiKey: p.perplexity.apiKey, model: "sonar-pro",                name: "Perplexity" },
    p.cerebras?.apiKey   && { baseUrl: p.cerebras.baseUrl   || "https://api.cerebras.ai/v1",       apiKey: p.cerebras.apiKey,   model: "llama-3.3-70b",            name: "Cerebras"   },
    p.groq?.apiKey       && { baseUrl: p.groq.baseUrl       || "https://api.groq.com/openai/v1",   apiKey: p.groq.apiKey,       model: "llama-3.3-70b-versatile",  name: "Groq"       },
    p.mistral?.apiKey    && { baseUrl: p.mistral.baseUrl     || "https://api.mistral.ai/v1",        apiKey: p.mistral.apiKey,    model: "mistral-large-latest",     name: "Mistral"    },
    p.openai?.apiKey     && { baseUrl: p.openai.baseUrl      || "https://api.openai.com/v1",        apiKey: p.openai.apiKey,     model: "gpt-4o-mini",              name: "OpenAI"     },
  ].filter(Boolean);

  // Also include crew-lead's own provider as last-resort fallback
  const cfg = loadConfig();
  if (cfg.provider?.apiKey && !candidates.find(c => c.apiKey === cfg.provider.apiKey)) {
    candidates.push({ baseUrl: cfg.provider.baseUrl, apiKey: cfg.provider.apiKey, model: cfg.modelId, name: cfg.providerKey });
  }
  return candidates;
}

// ── AI Roadmap Generator ──────────────────────────────────────────────────────

function templateRoadmap(name, description, outputDir) {
  return `# ${name} — Living Roadmap

> Managed by CrewSwarm PM Loop. Add \`- [ ] items\` here at any time.

---

## Phase 1 — Foundation

- [ ] Set up project structure and entry point in ${outputDir}
- [ ] Create README.md with project overview and setup instructions
- [ ] Define core data models and types for: ${description || name}

## Phase 2 — Core Features

- [ ] Implement primary feature: ${description || name}
- [ ] Build the main UI/frontend in ${outputDir}
- [ ] Add backend logic, API endpoints, and data persistence
- [ ] Add error handling and input validation throughout

## Phase 3 — Polish & QA

- [ ] Write unit tests for core logic
- [ ] QA pass — check for edge cases and broken flows
- [ ] Performance review and optimisation
- [ ] Accessibility and UX improvements

## Phase 4 — Ship

- [ ] Final QA pass
- [ ] Commit all changes to git with clear messages
- [ ] Write deployment/setup documentation
`;
}

async function generateRoadmarkWithAI(name, description, outputDir) {
  const providers = getPMLLMProviders();

  if (!providers.length) {
    console.log("[crew-lead] No PM LLM providers configured — using template roadmap");
    return templateRoadmap(name, description, outputDir);
  }

  const systemPrompt = `You are a senior technical product manager. Generate a detailed, phased ROADMAP.md for a software project.

Rules:
- Output ONLY the roadmap markdown — no preamble, no explanation
- Use EXACTLY this format:

# {Project Name} — Living Roadmap

> Managed by CrewSwarm PM Loop.

---

## Phase 1 — Foundation
- [ ] Task one
- [ ] Task two

## Phase 2 — Core Features
- [ ] Task three

## Phase 3 — Polish & Ship
- [ ] Task

- Include 12-18 total tasks across 3-4 phases
- Each task: specific, actionable, completable by ONE agent in ONE session
- Vary tasks: backend (API/DB/scripts), frontend (HTML/CSS/JS), copy, git, QA, security
- Reference the output directory: ${outputDir}`;

  const userPrompt = `Project: "${name}"
Description: ${description || name}
Output directory: ${outputDir}

Generate the ROADMAP.md:`;

  for (const pmCfg of providers) {
    const isPerplexity = pmCfg.baseUrl.includes("perplexity");
    console.log(`[crew-lead] Generating roadmap via ${pmCfg.name || pmCfg.model}...`);
    try {
      const resp = await fetch(`${pmCfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": `Bearer ${pmCfg.apiKey}` },
        body: JSON.stringify({
          model: pmCfg.model,
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
          max_tokens: 1200,
          temperature: 0.4,
          ...(isPerplexity ? { search_recency_filter: "month" } : {}),
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => resp.statusText);
        console.warn(`[crew-lead] ${pmCfg.name} returned ${resp.status} — trying next provider`);
        continue; // try next provider instead of throwing
      }

      const data = await resp.json();
      const roadmap = data?.choices?.[0]?.message?.content?.trim();
      if (!roadmap) { console.warn(`[crew-lead] ${pmCfg.name} returned empty — trying next`); continue; }

      console.log(`[crew-lead] Roadmap generated via ${pmCfg.name} (${roadmap.length} chars)`);
      return roadmap.startsWith("#") ? roadmap : `# ${name} — Living Roadmap\n\n${roadmap}`;
    } catch (e) {
      console.warn(`[crew-lead] ${pmCfg.name} failed: ${e.message} — trying next provider`);
    }
  }

  // All providers failed — use template
  console.warn("[crew-lead] All PM LLM providers failed — using template roadmap");
  return templateRoadmap(name, description, outputDir);
}

// ── Pending project store (in-memory, keyed by session) ───────────────────────

const pendingProjects = new Map();

// Draft a roadmap without creating the project yet — returns for user review
async function draftProject({ name, description, outputDir }, sessionId) {
  const roadmapMd = await generateRoadmarkWithAI(name, description, outputDir);
  const draftId = crypto.randomUUID();
  pendingProjects.set(draftId, { name, description, outputDir, roadmapMd, sessionId, ts: Date.now() });
  console.log(`[crew-lead] Roadmap draft ready: ${name} (draftId=${draftId})`);
  return { draftId, name, description, outputDir, roadmapMd };
}

// Confirm + create the project, write roadmap, start PM loop
async function confirmProject({ draftId, roadmapMd: overrideMd }) {
  const draft = pendingProjects.get(draftId);
  if (!draft) throw new Error(`No pending project for draftId: ${draftId}`);
  pendingProjects.delete(draftId);

  const { name, description, outputDir, sessionId } = draft;
  const finalRoadmap = overrideMd || draft.roadmapMd;

  // Create project via dashboard API
  const createRes = await fetch(`${DASHBOARD}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, description: description || "", outputDir }),
    signal: AbortSignal.timeout(10000),
  });
  const proj = await createRes.json();
  if (!proj.ok) throw new Error("Failed to create project: " + (proj.error || "unknown"));
  const projectId = proj.project.id;

  // Write the approved roadmap
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "ROADMAP.md"), finalRoadmap, "utf8");
  console.log(`[crew-lead] Project confirmed: ${name} (${projectId}) — roadmap written`);

  // Start PM loop immediately
  try {
    const startRes = await fetch(`${DASHBOARD}/api/pm-loop/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId }),
      signal: AbortSignal.timeout(10000),
    });
    const startData = await startRes.json();
    console.log(`[crew-lead] PM loop started for ${name}:`, startData.pid || startData.message);
  } catch (e) {
    console.error(`[crew-lead] PM loop start failed: ${e.message}`);
  }

  appendHistory(sessionId || "owner", "system", `Project "${name}" confirmed and launched. PM loop running.`);
  broadcastSSE({ type: "project_launched", project: { projectId, name, outputDir } });
  return { projectId, name, outputDir };
}

// rtPublish is set once the RT connection is established
let rtPublish = null;
let crewLeadHeartbeat = null;

// Rolling log of RT bus traffic so crew-lead has eyes on the system (command, done, events, issues)
const RT_ACTIVITY_MAX = 60;
const rtActivityLog = [];
function pushRtActivity(entry) {
  rtActivityLog.push(entry);
  if (rtActivityLog.length > RT_ACTIVITY_MAX) rtActivityLog.shift();
}

// Pipeline wave dispatcher → lib/crew-lead/wave-dispatcher.mjs
// Sessions in autonomous PM loop: on agent completion we auto-dispatch to PM to update plan and dispatch next
const autonomousPmLoopSessions = new Set();

// Check if an agent is currently connected to the RT bus
async function isAgentOnRtBus(agentId) {
  try {
    const resp = await fetch("http://127.0.0.1:18889/status", { signal: AbortSignal.timeout(3000) });
    const data = await resp.json();
    return Array.isArray(data.agents) && data.agents.includes(agentId);
  } catch { return false; }
}

// ── Phase B: ROADMAP awareness ───────────────────────────────────────────────

function parseRoadmapPhases(content) {
  const phases = [];
  let current = null;
  for (const line of content.split("\n")) {
    const phaseMatch = line.match(/^#{1,3}\s*(Phase\s[\w\d–\-]+.*)/i);
    if (phaseMatch) {
      if (current) phases.push(current);
      current = { title: phaseMatch[1].trim(), items: [], raw: line };
    } else if (current && line.match(/^\s*-\s*\[([ xX])\]/)) {
      current.items.push({ done: /\[x\]/i.test(line), text: line.trim() });
    }
  }
  if (current) phases.push(current);
  return phases;
}

function findNextRoadmapPhase(projectDir) {
  const roadmapPath = path.join(projectDir, "ROADMAP.md");
  if (!fs.existsSync(roadmapPath)) return null;
  try {
    const content = fs.readFileSync(roadmapPath, "utf8");
    const phases = parseRoadmapPhases(content);
    return phases.find(p => p.items.length > 0 && p.items.some(i => !i.done)) || null;
  } catch { return null; }
}

async function autoAdvanceRoadmap(projectDir, sessionId) {
  if (!projectDir) return;
  const nextPhase = findNextRoadmapPhase(projectDir);
  if (!nextPhase) {
    console.log(`[roadmap] All phases complete in ${projectDir}`);
    return;
  }
  const unchecked = nextPhase.items.filter(i => !i.done);
  console.log(`[roadmap] Auto-advancing to "${nextPhase.title}" — ${unchecked.length} items pending in ${projectDir}`);

  const task = `The previous pipeline phase just completed. Auto-advancing to the next phase.

Project: ${projectDir}
Next phase: ${nextPhase.title}
Unchecked items:
${unchecked.map(i => i.text).join("\n")}

@@READ_FILE ${path.join(projectDir, "ROADMAP.md")}

Plan and execute this phase as a @@PIPELINE. Use the correct agents for each task. End with crew-qa → crew-fixer → crew-qa → crew-pm (ROADMAP update). All file paths must be absolute.`;

  appendHistory(sessionId, "system", `[Auto-advance] Starting "${nextPhase.title}" (${unchecked.length} items)`);
  broadcastSSE({ type: "roadmap_advance", phase: nextPhase.title, projectDir, ts: Date.now() });

  // Send as a chat message from crew-lead itself so it goes through full pipeline routing
  await handleChat({ message: task, sessionId, _autoAdvance: true });
}

// ── Phase C: Background loop ─────────────────────────────────────────────────

const _agentTimeoutCounts = new Map(); // agentId → count of timeouts in last 24h
const _timeoutLog = []; // { agent, ts } entries

function recordAgentTimeout(agent) {
  _timeoutLog.push({ agent, ts: Date.now() });
  // Prune entries older than 24h
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  while (_timeoutLog.length && _timeoutLog[0].ts < cutoff) _timeoutLog.shift();
  const counts = {};
  for (const e of _timeoutLog) counts[e.agent] = (counts[e.agent] || 0) + 1;
  for (const [id, n] of Object.entries(counts)) _agentTimeoutCounts.set(id, n);
}

function backgroundLoop() {
  try {
    // 1. Stall detection — pipelines with no task activity for >15 min
    for (const [pid, pipeline] of pendingPipelines) {
      if (!pipeline._lastActivity) pipeline._lastActivity = Date.now();
      const staleMs = Date.now() - pipeline._lastActivity;
      if (staleMs > 15 * 60 * 1000 && pipeline.pendingTaskIds.size > 0) {
        console.log(`[bg-loop] Pipeline ${pid} appears stalled (${Math.round(staleMs / 60000)}m no activity) — ${pipeline.pendingTaskIds.size} tasks pending`);
        broadcastSSE({ type: "pipeline_stalled", pipelineId: pid, staleMinutes: Math.round(staleMs / 60000), ts: Date.now() });
      }
    }

    // 2. Agent timeout pattern alerts
    for (const [agent, count] of _agentTimeoutCounts) {
      if (count >= 3) {
        console.log(`[bg-loop] ⚠️  ${agent} has timed out ${count}x in last 24h — consider checking its model or restarting its bridge`);
        broadcastSSE({ type: "agent_timeout_pattern", agent, count, ts: Date.now() });
      }
    }

    // 3. ROADMAP auto-advance — check registered projects for next incomplete phase
    // Only if no pipelines are currently active (don't stack pipelines)
    if (pendingPipelines.size === 0) {
      const projects = readProjectsRegistry();
      for (const project of projects) {
        if (!project.outputDir || project.autoAdvance !== true) continue;
        const nextPhase = findNextRoadmapPhase(project.outputDir);
        if (nextPhase) {
          console.log(`[bg-loop] Auto-advancing "${project.name}" → "${nextPhase.title}"`);
          autoAdvanceRoadmap(project.outputDir, "owner");
        }
      }

      // 4. Background consciousness (Ouroboros-style: "think" between tasks)
      // Prefer cheap direct Groq (or CREWSWARM_BG_CONSCIOUSNESS_MODEL) call; fallback: dispatch to crew-main
      if (_bgConsciousnessEnabled && Date.now() - _lastBgConsciousnessAt >= BG_CONSCIOUSNESS_INTERVAL_MS) {
        _lastBgConsciousnessAt = Date.now();
        const useDirect = getBgConsciousnessLLM();
        if (useDirect) {
          console.log("[bg-loop] Running background consciousness via", useDirect.providerKey + "/" + useDirect.modelId);
          runBackgroundConsciousnessDirect().catch((e) => {
            console.error("[bg-loop] Background consciousness error:", e.message);
          });
        } else {
          const brainPath = path.join(process.cwd(), "memory", "brain.md");
          const consciousnessTask = `BACKGROUND CYCLE — you are managing the process for the user. Your reply is shown in their chat and written to ~/.crewswarm/process-status.md.
@@READ_FILE ${brainPath}
Consider: what should the user know? (stalled work, next steps, blockers, health.) Reply in under 100 words.
Reply with: 1) One sentence on system/crew state or suggested next step. 2) If something needs follow-up, emit exactly one @@BRAIN: or @@DISPATCH line (e.g. dispatch to fix a stuck pipeline). Otherwise reply NO_ACTION.`;
          try {
            dispatchTask("crew-main", consciousnessTask, "bg-consciousness", null);
            console.log("[bg-loop] Dispatched background consciousness cycle to crew-main (no cheap model configured)");
          } catch (e) {
            console.error("[bg-loop] Background consciousness dispatch failed:", e.message);
          }
        }
      }
    }
  } catch (e) {
    console.error("[bg-loop] Error:", e.message);
  }
}

// Background consciousness: last run time (throttle)
let _lastBgConsciousnessAt = 0;

/** Resolve a cheap LLM for background consciousness (Groq preferred). Returns { baseUrl, apiKey, modelId, providerKey } or null. */
function getBgConsciousnessLLM() {
  const cfg = tryRead(path.join(os.homedir(), ".crewswarm", "crewswarm.json")) || {};
  const providers = cfg.providers || {};
  const [providerKey, ...modelParts] = String(BG_CONSCIOUSNESS_MODEL).split("/");
  const modelId = modelParts.join("/") || "llama-3.1-8b-instant";
  const p = providers[providerKey];
  if (!p?.apiKey) return null;
  const baseUrl = p.baseUrl || (providerKey === "groq" ? "https://api.groq.com/openai/v1" : "");
  if (!baseUrl) return null;
  return { baseUrl, apiKey: p.apiKey, modelId, providerKey };
}

const BG_CONSCIOUSNESS_LLM_TIMEOUT_MS = 60_000;

/** Run one background consciousness cycle via a direct cheap LLM call (no crew-main dispatch). */
async function runBackgroundConsciousnessDirect() {
  const llm = getBgConsciousnessLLM();
  if (!llm) return false;
  let brainContent = "";
  try {
    const raw = fs.readFileSync(BRAIN_PATH, "utf8");
    // Strip template header lines — anything that is just the scaffold
    const stripped = raw.replace(/^#[^\n]*\n/gm, "").replace(/^Agents: append.*\n?/gm, "").replace(/^This is the persistent.*\n?/gm, "").replace(/^Read it to.*\n?/gm, "").replace(/^Write to it.*\n?/gm, "").trim();
    if (stripped.length < 80) {
      // Brain has no real content yet — nothing useful to reflect on, skip silently
      console.log("[bg-loop] Brain empty — skipping consciousness cycle");
      return true;
    }
    brainContent = raw.slice(-6000);
  } catch {
    console.log("[bg-loop] brain.md not found — skipping consciousness cycle");
    return true;
  }
  const system = "You are crew-main managing the process for the user. Reply in under 100 words. Output: 1) One sentence on system/crew state or suggested next step. 2) If something needs follow-up, emit exactly one line: @@BRAIN crew-main: <fact> OR @@DISPATCH {\"agent\":\"...\",\"task\":\"...\"}. Otherwise reply NO_ACTION.";
  const user = `Shared memory (recent):\n${brainContent}\n\nWhat should the user know? Any follow-up? Reply briefly.`;
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  let content;
  try {
    const res = await fetch(`${llm.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": `Bearer ${llm.apiKey}` },
      body: JSON.stringify({ model: llm.modelId, messages, max_tokens: 256, temperature: 0.5, stream: false }),
      signal: AbortSignal.timeout(BG_CONSCIOUSNESS_LLM_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text().catch(() => "")}`);
    const data = await res.json();
    content = data?.choices?.[0]?.message?.content || "NO_ACTION";
  } catch (e) {
    console.error("[bg-loop] Background consciousness LLM failed:", e.message);
    return true;
  }
  content = content.trim();
  const brainMatch = content.match(/@@BRAIN\s+([^\n]+)/);
  if (brainMatch) {
    try {
      appendToBrain("crew-main", brainMatch[1].trim());
      console.log("[crew-lead] @@BRAIN (bg):", brainMatch[1].slice(0, 60));
    } catch (e) {
      console.error("[bg-loop] Brain append failed:", e.message);
    }
  }
  const dispatches = parseDispatches(content);
  for (const d of dispatches) {
    try {
      dispatchTask(d.agent, d.task, "bg-consciousness", null);
      console.log("[crew-lead] @@DISPATCH (bg):", d.agent, d.task?.slice(0, 50));
    } catch (e) {
      console.error("[bg-loop] Dispatch failed:", e.message);
    }
  }
  const short = content.replace(/\n+/g, " ").slice(0, 800).trim();
  // Don't broadcast NO_ACTION or empty/error responses to the user's chat
  const isNoAction = /^NO_ACTION/i.test(short) || short.length < 10;
  if (!isNoAction) {
    appendHistory("owner", "system", `[crew-main — background]: ${short}`);
    broadcastSSE({ type: "agent_reply", from: "crew-main", content: short, sessionId: "owner", _bg: true, ts: Date.now() });
  }
  try {
    const statusPath = path.join(os.homedir(), ".crewswarm", "process-status.md");
    const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
    fs.writeFileSync(statusPath, `# Process status (crew-main)\nLast updated: ${stamp}\n\n${content.slice(0, 2000).replace(/@@/g, "")}\n`, "utf8");
  } catch (_) {}
  return true;
}

// Start background loop — runs every 5 minutes
let _bgLoopInterval = null;
function startBackgroundLoop() {
  if (_bgLoopInterval) clearInterval(_bgLoopInterval);
  _bgLoopInterval = setInterval(backgroundLoop, 5 * 60 * 1000);
  console.log("[crew-lead] Background loop started (5m interval)");
  if (_bgConsciousnessEnabled) {
    console.log("[crew-lead] Background consciousness ON — reflect every " + (BG_CONSCIOUSNESS_INTERVAL_MS / 60000) + "m when idle");
  } else {
    console.log("[crew-lead] Background consciousness OFF — toggle in Dashboard → Settings");
  }
}

// When an agent is rate limited (429 / quota), crew-lead can re-dispatch to a fallback agent who can handle the same kind of task
const _RATE_LIMIT_FALLBACK_STATIC = {
  "crew-coder-back": "crew-coder",
  "crew-coder-front": "crew-coder",
  "crew-coder": "crew-main",
  "crew-frontend": "crew-coder",
  "crew-pm": "crew-main",
  "crew-qa": "crew-main",
  "crew-copywriter": "crew-main",
  "crew-security": "crew-main",
};
const _ROLE_FALLBACK = {
  coder: "crew-coder",
  writer: "crew-copywriter",
  researcher: "crew-main",
  auditor: "crew-qa",
  ops: "crew-main",
  generalist: "crew-main",
};
function getRateLimitFallback(agentId) {
  if (_RATE_LIMIT_FALLBACK_STATIC[agentId]) return _RATE_LIMIT_FALLBACK_STATIC[agentId];
  const swarm = tryRead(path.join(os.homedir(), ".crewswarm", "crewswarm.json"));
  const agent = (swarm?.agents || []).find(a => a.id === agentId);
  if (agent?.fallbackModel) return agentId;
  if (agent?._role && _ROLE_FALLBACK[agent._role]) return _ROLE_FALLBACK[agent._role];
  return "crew-main";
}
const RATE_LIMIT_PATTERN = /429|rate\s*limit|throttl|quota\s*exceeded|too\s*many\s*requests|resource_exhausted|overloaded/i;

// ── Telemetry (OPS-TELEMETRY-SCHEMA.md) ────────────────────────────────────────
const TELEMETRY_SCHEMA_VERSION = "1.1";
const TELEMETRY_EVENT_LIMIT = 100;
const telemetryEvents = [];
const taskPhaseOrdinal = new Map(); // taskId -> next ordinal

function nextPhaseOrdinal(taskId) {
  const n = (taskPhaseOrdinal.get(taskId) || 0) + 1;
  taskPhaseOrdinal.set(taskId, n);
  return n;
}

function emitTaskLifecycle(phase, data) {
  const { taskId, agentId } = data;
  const eventId = "evt_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
  const envelope = {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    eventType: "task.lifecycle",
    eventId,
    occurredAt: new Date().toISOString(),
    source: { component: "crew-lead" },
    correlationId: taskId ? "task:" + taskId : "task:unknown",
    data: {
      taskId: taskId || "",
      agentId: agentId || "",
      taskType: data.taskType || "task",
      phase,
      phaseOrdinal: nextPhaseOrdinal(taskId || "global"),
      ...(data.durationMs != null && { durationMs: data.durationMs }),
      ...(data.result && { result: data.result }),
      ...(data.error && { error: data.error }),
    },
  };
  telemetryEvents.push(envelope);
  if (telemetryEvents.length > TELEMETRY_EVENT_LIMIT) telemetryEvents.shift();
  broadcastSSE({ type: "telemetry", payload: envelope });
}

function readTelemetryEvents(limit = 25) {
  const n = Math.min(Number(limit) || 25, TELEMETRY_EVENT_LIMIT);
  return telemetryEvents.slice(-n);
}

// ── Ops snapshot state ────────────────────────────────────────────────────────
const OPS_EVENT_LIMIT = 200;
const OPS_EVENTS = [];
const OPS_COUNTERS = {
  tasksDispatched: 0,
  tasksCompleted: 0,
  pipelinesStarted: 0,
  pipelinesCompleted: 0,
  webhooksReceived: 0,
  skillsApproved: 0,
  skillsRejected: 0,
};

function bumpOpsCounter(key, delta = 1) {
  OPS_COUNTERS[key] = (OPS_COUNTERS[key] || 0) + delta;
}

function recordOpsEvent(type, fields = {}) {
  const entry = { ts: Date.now(), type, ...fields };
  OPS_EVENTS.push(entry);
  if (OPS_EVENTS.length > OPS_EVENT_LIMIT) OPS_EVENTS.shift();
  return entry;
}

function readOpsEvents(limit = 25) {
  if (!Number.isFinite(limit) || limit <= 0) limit = 25;
  const sliceCount = Math.min(Math.trunc(limit), OPS_EVENT_LIMIT);
  return OPS_EVENTS.slice(sliceCount * -1);
}

function buildTaskText(taskSpec) {
  // taskSpec can be a plain string or a {task, verify, done} object
  if (typeof taskSpec === "string") return taskSpec;
  let text = taskSpec.task || "";
  if (taskSpec.verify || taskSpec.done) {
    text += "\n\n## Acceptance criteria";
    if (taskSpec.verify) text += `\n- Verify: ${taskSpec.verify}`;
    if (taskSpec.done)   text += `\n- Done when: ${taskSpec.done}`;
  }
  return text;
}

/** Resolve display name (e.g. Frank, TG) to agent id (e.g. crew-security) for dispatch. */
function resolveAgentId(cfg, nameOrId) {
  if (!nameOrId) return null;
  const id = String(nameOrId).trim();
  if (cfg.knownAgents && cfg.knownAgents.includes(id)) return id;
  const roster = cfg.agentRoster || [];
  const byName = roster.find(a => (a.name || "").toLowerCase() === id.toLowerCase());
  if (byName) return byName.id;
  return id; // pass through; downstream may reject if unknown
}

// Wire dispatch parsers — must come after loadConfig + resolveAgentId are defined
initDispatchParsers({ loadConfig, resolveAgentId });
initLlmCaller({ llmTimeout: LLM_TIMEOUT });

/** Write a focused task brief to a temp .md file in the project dir and return a short pointer prompt.
 *  Keeps model prompts small — agent uses @@READ_FILE to load the brief itself.
 *  Used for QA and fixer tasks which tend to be large. */
function writeTaskBrief(agent, task, projectDir) {
  if (!projectDir) return task; // no project dir — fall back to inline
  try {
    const briefName = `_crew-${agent.replace("crew-","")}-brief-${Date.now()}.md`;
    const briefPath = path.join(projectDir, briefName);
    const ts = new Date().toISOString().replace("T"," ").slice(0,19);
    fs.writeFileSync(briefPath, `# Task Brief for ${agent}\n_Created: ${ts}_\n\n${task}\n`, "utf8");
    return `@@READ_FILE ${briefPath}\n\nRead the task brief above and complete all items. Write results/reports to the paths specified in the brief. Delete the brief file when done.`;
  } catch {
    return task; // can't write — fall back to inline
  }
}

/**
 * Detect explicit service restart/stop requests from the user message.
 * Returns { action, id } or null.
 * This fires programmatically so crew-lead never has to "decide" whether it can restart.
 */
function parseServiceIntent(msg) {
  const t = msg.trim().toLowerCase();

  // "restart all agents" / "restart the agents" / "restart agents" / "bring agents back"
  if (/restart\s+(all\s+)?agents?|bring\s+agents?\s+(back|online|up)|start\s+all\s+agents?|agents?\s+back\s+up/.test(t))
    return { action: "restart", id: "agents" };

  // "restart telegram" / "start tg" / "bring telegram back"
  if (/restart\s+(the\s+)?tele?gram|start\s+(the\s+)?tele?gram|tele?gram\s+(back|up)|tg\s+(back|up|restart)/.test(t))
    return { action: "restart", id: "telegram" };

  // "restart the RT bus" / "restart rt"
  if (/restart\s+(the\s+)?rt(\s+bus)?|rt\s+bus\s+(down|crash|restart)/.test(t))
    return { action: "restart", id: "rt-bus" };

  // "restart crew-coder" or "restart crew-qa" etc.
  const agentMatch = t.match(/restart\s+(crew-[a-z0-9-]+)/);
  if (agentMatch) return { action: "restart", id: agentMatch[1] };

  // "can you restart them" / "restart them" / "restart everything" / "restart the crew"
  if (/restart\s+(them|it|everything|the\s+crew|all|bridges?)|bring\s+(them|the\s+crew|everyone)\s+back/.test(t))
    return { action: "restart", id: "agents" };

  // "stop telegram"
  if (/stop\s+(the\s+)?tele?gram|stop\s+tg\b/.test(t))
    return { action: "stop", id: "telegram" };

  return null;
}

/** True only when the user explicitly asks to search, research, or look something up.
 *  Returns false when the user is delegating to an agent ("ask the writer to research X"). */
function messageNeedsSearch(msg) {
  const t = msg.trim().toLowerCase();
  if (t.length < 6) return false;
  // If the user is addressing an agent, this is a dispatch intent, not a search request
  const delegationPattern = /(?:ask|tell|have|send|forward|give|pass)\s+(?:the\s+)?(?:writer|copywriter|pm|planner|coder|fixer|qa|security|github|frontend|main|crew-[a-z0-9-]+|planx|frank|blazer|antoine|copycopy|copycat|testy|stinki)/i;
  if (delegationPattern.test(t)) return false;
  const searchTriggers = [
    "go search", "search for", "search ", "research ", "look up", "look it up", "look that up",
    "can you search", "please search", "please look up", "please research",
    "run a search", "do a search",
  ];
  return searchTriggers.some(phrase => t.includes(phrase));
}

// ── Dispatch intent guard — server-side check before firing any dispatch ──────
// The LLM frequently emits @@DISPATCH on conversational messages (questions,
// clarifications, single words). This function returns false for those, blocking
// the dispatch before it hits any agent.

const DISPATCH_INTENT_REQUIRED = [
  /\bgo\s+(build|write|create|make|fix|test|audit|ship|deploy|run|add|update|generate|implement|refactor|optimize)\b/i,
  /\b(build|create|make|generate|implement|write|ship|deploy)\s+(me\b|a\b|an\b|the\b|it\b|this\b|some\b)/i,
  /\bhave\s+(crew-\S+|\w+)\s+(do|fix|build|write|create|audit|test|run|check|handle|implement)/i,
  /\btell\s+(crew-\S+|\w+)\s+to\b/i,
  /\bask\s+(crew-\S+|\w+)\s+to\b/i,
  /\b(dispatch|send)\s+(to\s+)?(crew-\S+|\w+)\b/i,
  /\b(kick\s*off|rally|launch|start)\s+(the\s+)?(crew|pipeline|build|task|project)\b/i,
  /\b(fix|debug|refactor|optimize|audit|review|test|deploy)\s+(the\s+|this\s+|my\s+)?\S+/i,
];

const DISPATCH_NEVER_PATTERNS = [
  /^(hi|hello|hey|sup|yo|ok|okay|sure|nope|no|yes|yep|nah|what|why|how|huh|lol|lmao|wtf|fixed|working|done|thanks|thx|cool|nice|great|good)\??\.?$/i,
  /^(what|why|how|when|where|who|is|are|can|did|does|was|were|do|tell me|show me|explain|what is|what are|what does|what happened|what did|did you|did he|did she|did we|did it)\b/i,
  /^(i never|i didn'?t|i don'?t|i haven'?t|i wasn'?t|i wasn|i'm not|i am not|i was not|that'?s not|that is not|no i|nope i)\b/i,
  /\?\s*$/,  // ends with question mark
];

function isDispatchIntended(userMessage) {
  if (!userMessage) return false;
  const msg = userMessage.trim();

  // Short messages (under 6 words) are almost never directives unless they match exactly
  const wordCount = msg.split(/\s+/).length;

  // Hard block: known non-directive patterns
  if (DISPATCH_NEVER_PATTERNS.some(re => re.test(msg))) {
    console.log(`[crew-lead] 🚫 Dispatch blocked — message matches non-directive pattern: "${msg.slice(0, 60)}"`);
    return false;
  }

  // Must contain at least one explicit dispatch-intent phrase
  if (DISPATCH_INTENT_REQUIRED.some(re => re.test(msg))) return true;

  // Short messages with no intent signal → block
  if (wordCount <= 8) {
    console.log(`[crew-lead] 🚫 Dispatch blocked — short message with no dispatch intent: "${msg.slice(0, 60)}"`);
    return false;
  }

  // Longer messages that don't match — allow (give benefit of the doubt for complex directives)
  return true;
}

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
  agentTimeoutCounts: _agentTimeoutCounts,
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
  try {
  } catch { return ""; }
})();

// sseClients and activeOpenCodeAgents declared at top of file


function broadcastSSE(payload) {
  const event = JSON.stringify(payload);
  for (const client of sseClients) {
    try { client.write(`data: ${event}\n\n`); } catch {}
  }
}

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
