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
import {
  BUILT_IN_RT_AGENTS,
  COORDINATOR_AGENT_IDS,
  RT_TO_GATEWAY_AGENT_MAP as REGISTRY_RT_TO_GATEWAY_AGENT_MAP,
} from "./lib/agent-registry.mjs";

const LEGACY_STATE_DIR = path.join(os.homedir(), ".openclaw");
const CREWSWARM_DIR = path.join(os.homedir(), ".crewswarm");
const CREWSWARM_CONFIG_PATH = path.join(CREWSWARM_DIR, "config.json");
const TELEGRAM_BRIDGE_CONFIG_PATH = path.join(CREWSWARM_DIR, "telegram-bridge.json");
const TELEMETRY_DIR = path.join(LEGACY_STATE_DIR, "telemetry");

// ── Built-in provider base URLs — users only need to supply apiKey ──────────
const PROVIDER_REGISTRY = {
  groq:        { baseUrl: "https://api.groq.com/openai/v1" },
  anthropic:   { baseUrl: "https://api.anthropic.com/v1" },
  openai:      { baseUrl: "https://api.openai.com/v1" },
  perplexity:  { baseUrl: "https://api.perplexity.ai" },
  mistral:     { baseUrl: "https://api.mistral.ai/v1" },
  deepseek:    { baseUrl: "https://api.deepseek.com/v1" },
  nvidia:      { baseUrl: "https://integrate.api.nvidia.com/v1" },
  google:      { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  xai:         { baseUrl: "https://api.x.ai/v1" },
  ollama:      { baseUrl: "http://localhost:11434/v1" },
  "openai-compatible": { baseUrl: null }, // user must supply baseUrl
};

// ── Config resolver: ~/.crewswarm/config.json first, ~/.openclaw/openclaw.json fallback ──
function resolveConfig() {
  const paths = [CREWSWARM_CONFIG_PATH, path.join(LEGACY_STATE_DIR, "openclaw.json")];
  for (const p of paths) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
      cfg.__source = p;
      return cfg;
    } catch { /* try next */ }
  }
  return {};
}

/** Load ~/.crewswarm/telegram-bridge.json for @@TELEGRAM (token + default chat). */
function resolveTelegramBridgeConfig() {
  try {
    return JSON.parse(fs.readFileSync(TELEGRAM_BRIDGE_CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function resolveProviderConfig(cfg, providerKey) {
  const explicit = cfg?.models?.providers?.[providerKey] || cfg?.providers?.[providerKey];
  const builtin  = PROVIDER_REGISTRY[providerKey];
  if (!explicit && !builtin) return null;
  return {
    baseUrl: explicit?.baseUrl || builtin?.baseUrl,
    apiKey:  explicit?.apiKey  || cfg?.env?.[`${providerKey.toUpperCase()}_API_KEY`] || null,
  };
}
const TELEMETRY_LOG = path.join(TELEMETRY_DIR, "events.log");
const SHARED_MEMORY_DIR = path.resolve(process.cwd(), "memory");
const SHARED_MEMORY_MAX_FILE_CHARS = 8000;
const SHARED_MEMORY_MAX_TOTAL_CHARS = 40000;
const SHARED_MEMORY_FILES = [
  "law.md",                    // Crew laws — no harm, no unauthorized access, don't break machine, create value
  "current-state.md",          // System overview — what CrewSwarm is, CRITICAL task guidance
  "agent-handoff.md",          // Current status, last completed work, agent rules
  "orchestration-protocol.md", // Agent roster, tool permissions, dispatch syntax
  "brain.md",                  // Accumulated project knowledge — read this to avoid repeating mistakes
  // "decisions.md"            // Architectural decisions — only load when needed
  // "telegram-context.md"     // Telegram chat history — too noisy for code tasks
];

// Extra memory files injected for specific agents (static) + dynamic agents by _role
const _AGENT_EXTRA_MEMORY_STATIC = {
  "crew-fixer":    ["lessons.md"],
  "crew-coder":    ["lessons.md"],
  "crew-coder-front": ["lessons.md"],
  "crew-coder-back":  ["lessons.md"],
};
const _EXTRA_MEMORY_BY_ROLE = { coder: ["lessons.md"], ops: ["lessons.md"] };

function getAgentExtraMemory(agentId) {
  const bareId = agentId.startsWith("crew-") ? `crew-${agentId.slice(5)}` : agentId;
  if (_AGENT_EXTRA_MEMORY_STATIC[agentId]) return _AGENT_EXTRA_MEMORY_STATIC[agentId];
  if (_AGENT_EXTRA_MEMORY_STATIC[bareId]) return _AGENT_EXTRA_MEMORY_STATIC[bareId];
  try {
    const agents = loadAgentList();
    const cfg = agents.find(a => a.id === agentId);
    if (cfg?._role && _EXTRA_MEMORY_BY_ROLE[cfg._role]) return _EXTRA_MEMORY_BY_ROLE[cfg._role];
  } catch {}
  return [];
}
const MEMORY_BOOTSTRAP_AGENT = "gateway-bridge";
const SHARED_MEMORY_PROTOCOL = [
  "Memory loaded. Current UTC: `$(date -u +%Y-%m-%d\\ %H:%M\\ UTC)`; last handoff: `${getLastHandoffTimestamp()}`.",
  "",
  "Complete your task using available tools. When done, briefly note what you did.",
  "Your reply is sent back to whoever dispatched this task (e.g. crew-pm or crew-lead); keep it concise and actionable so they can update the plan or assign next steps.",
  "When you create or edit files, always report the full absolute path of each file (e.g. /Users/.../project/tests/file.js) in your reply so the user knows exactly where output went."
].join("\n");
const MEMORY_PROTOCOL_MARKER = "Mandatory memory protocol (apply for this task):";
const GATEWAY_URL = "ws://127.0.0.1:18789";
const OPENCREW_RT_URL = process.env.OPENCREW_RT_URL || "ws://127.0.0.1:18889";
const OPENCREW_RT_AGENT = process.env.OPENCREW_RT_AGENT || "crew-main";
function getRTToken() {
  let token = process.env.OPENCREW_RT_AUTH_TOKEN || "";
  if (!token) {
    try {
      const cfg = JSON.parse(fs.readFileSync(CREWSWARM_CONFIG_PATH, "utf8"));
      token = cfg?.rt?.authToken || cfg?.env?.OPENCREW_RT_AUTH_TOKEN || "";
    } catch {}
  }
  if (!token) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(LEGACY_STATE_DIR, "openclaw.json"), "utf8"));
      token = cfg?.env?.OPENCREW_RT_AUTH_TOKEN || "";
    } catch {}
  }
  return typeof token === "string" ? token.trim() : "";
}
const OPENCREW_RT_TOKEN = getRTToken();
const OPENCREW_RT_CHANNELS = (process.env.OPENCREW_RT_CHANNELS || "command,assign,handoff,reassign,events")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const OPENCREW_RT_TLS_INSECURE = process.env.OPENCREW_RT_TLS_INSECURE === "1";
const OPENCREW_RT_RECONNECT_MS = Number(process.env.OPENCREW_RT_RECONNECT_MS || "1500");
const OPENCREW_RT_DISPATCH_ENABLED = (process.env.OPENCREW_RT_DISPATCH_ENABLED || "1") !== "0";
const OPENCREW_RT_DISPATCH_LEASE_MS = Number(process.env.OPENCREW_RT_DISPATCH_LEASE_MS || "45000");
const OPENCREW_RT_DISPATCH_HEARTBEAT_MS = Number(process.env.OPENCREW_RT_DISPATCH_HEARTBEAT_MS || "10000");
const OPENCREW_RT_DISPATCH_MAX_RETRIES = Number(process.env.OPENCREW_RT_DISPATCH_MAX_RETRIES || "2");
const OPENCREW_RT_DISPATCH_MAX_RETRIES_CODING = Number(process.env.OPENCREW_RT_DISPATCH_MAX_RETRIES_CODING || "3");
const OPENCREW_RT_DISPATCH_RETRY_BACKOFF_MS = Number(process.env.OPENCREW_RT_DISPATCH_RETRY_BACKOFF_MS || "2000");
const OPENCREW_OPENCODE_ENABLED = (process.env.OPENCREW_OPENCODE_ENABLED || "1") !== "0";  // ON by default
// CREWSWARM_CURSOR_WAVES=1 — route multi-agent waves through Cursor subagents
// instead of dispatching each agent independently. The crew-orchestrator subagent
// fans all tasks in a wave out to /crew-* subagents in parallel.
const CREWSWARM_CURSOR_WAVES = process.env.CREWSWARM_CURSOR_WAVES === "1";
// CREWSWARM_CLAUDE_CODE=1 — route tasks through Claude Code CLI (`claude -p`)
// Uses ANTHROPIC_API_KEY. Per-agent opt-in via useClaudeCode:true in crewswarm.json.
const CREWSWARM_CLAUDE_CODE = process.env.CREWSWARM_CLAUDE_CODE === "1";
const OPENCREW_OPENCODE_FORCE = process.env.OPENCREW_OPENCODE_FORCE === "1";
const OPENCREW_OPENCODE_BIN = process.env.OPENCREW_OPENCODE_BIN || path.join(os.homedir(), ".opencode", "bin", "opencode");
function getOpencodeProjectDir() {
  return getProjectDir("") || "";
}
const OPENCREW_OPENCODE_AGENT = process.env.OPENCREW_OPENCODE_AGENT || "admin";
// Primary OpenCode model: kimi-k2 is reliable at exact file edits on Groq (free tier).
// openai/gpt-5.x-codex models are rate-limited and fall back to imprecise smaller models.
const OPENCREW_OPENCODE_MODEL = process.env.OPENCREW_OPENCODE_MODEL || "groq/moonshotai/kimi-k2-instruct-0905";
const OPENCREW_OPENCODE_FALLBACK_DEFAULT = "groq/llama-3.3-70b-versatile";
const OPENCREW_OPENCODE_TIMEOUT_MS = Number(process.env.OPENCREW_OPENCODE_TIMEOUT_MS || "300000");

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
  if (process.env.OPENCREW_OPENCODE_FALLBACK_MODEL) return process.env.OPENCREW_OPENCODE_FALLBACK_MODEL;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "config.json"), "utf8"));
    if (cfg.opencodeFallbackModel && String(cfg.opencodeFallbackModel).trim()) return String(cfg.opencodeFallbackModel).trim();
  } catch {}
  try {
    // Also check crewswarm.json for globalFallbackModel — set from the dashboard
    const swarm = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "crewswarm.json"), "utf8"));
    if (swarm.globalFallbackModel && String(swarm.globalFallbackModel).trim()) return String(swarm.globalFallbackModel).trim();
  } catch {}
  return OPENCREW_OPENCODE_FALLBACK_DEFAULT;
}
// ── Auto-load agents from crewswarm.json / openclaw.json (legacy) so new agents added via the dashboard
//    are immediately available without editing this file.
function buildAgentMapsFromConfig() {
  const BUILT_IN_MAP = { ...REGISTRY_RT_TO_GATEWAY_AGENT_MAP };

  if (process.env.OPENCREW_RT_SWARM_AGENTS) {
    // Fully overridden by env — build map from env list, fall back to built-in map values
    const list = process.env.OPENCREW_RT_SWARM_AGENTS.split(",").map(s => s.trim()).filter(Boolean);
    const map = {};
    for (const a of list) map[a] = BUILT_IN_MAP[a] || a.replace(/^crew-/, "");
    return { list, map };
  }

  // Merge built-in agents with all agents from crewswarm.json (canonical) + openclaw.json (legacy)
  const map = { ...BUILT_IN_MAP };
  const listSet = new Set(BUILT_IN_RT_AGENTS);

  const cfgSources = [
    path.join(os.homedir(), ".crewswarm", "crewswarm.json"),
    path.join(os.homedir(), ".openclaw", "openclaw.json"),
  ];

  for (const cfgPath of cfgSources) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      const cfgAgents = Array.isArray(cfg.agents) ? cfg.agents
                      : Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];

      for (const agent of cfgAgents) {
        const rawId = agent.id;
        const bareId = rawId.replace(/^crew-/, "");
        const rtId   = "crew-" + bareId;
        if (!map[rtId]) { map[rtId] = bareId; listSet.add(rtId); }
        if (rawId === bareId && !map[bareId]) { map[bareId] = bareId; listSet.add(bareId); }
      }
    } catch {}
  }

  return { list: [...listSet], map };
}

const { list: OPENCREW_RT_SWARM_AGENTS, map: RT_TO_GATEWAY_AGENT_MAP } = buildAgentMapsFromConfig();
console.log(`[bridge] Registered ${OPENCREW_RT_SWARM_AGENTS.length} RT agents: ${OPENCREW_RT_SWARM_AGENTS.join(", ")}`);

// ── Direct LLM call — bypasses legacy gateway, uses agent's configured model directly ──

// Load agent list — checks crewswarm.json first (canonical), falls back to openclaw.json
function loadAgentList() {
  const sources = [
    path.join(os.homedir(), ".crewswarm", "crewswarm.json"),
    path.join(os.homedir(), ".openclaw",  "openclaw.json"),
  ];
  for (const p of sources) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
      const agents = Array.isArray(cfg.agents) ? cfg.agents : (cfg.agents?.list || []);
      if (agents.length > 0) return agents;
    } catch {}
  }
  return [];
}

// Load provider map — checks crewswarm.json providers, then config.json providers, then openclaw.json models.providers
function loadProviderMap() {
  const sources = [
    path.join(os.homedir(), ".crewswarm", "crewswarm.json"),
    path.join(os.homedir(), ".crewswarm", "config.json"),
    path.join(os.homedir(), ".openclaw",  "openclaw.json"),
  ];
  const merged = {};
  for (const p of sources) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
      // Support both cfg.providers and cfg.models.providers
      const provs = cfg.providers || cfg.models?.providers || {};
      for (const [k, v] of Object.entries(provs)) {
        if (!merged[k] && v?.apiKey && v?.baseUrl) merged[k] = v;
      }
    } catch {}
  }
  return merged;
}

function loadAgentLLMConfig(ocAgentId) {
  try {
    const agents = loadAgentList();
    const crewId = ocAgentId.startsWith("crew-") ? ocAgentId : `crew-${ocAgentId}`;
    const bareId = ocAgentId.startsWith("crew-") ? ocAgentId.slice(5) : ocAgentId;
    const agent = agents.find(a => a.id === ocAgentId) ||
                  agents.find(a => a.id === crewId) ||
                  agents.find(a => a.id === bareId);
    if (!agent?.model) return null;

    const [providerKey, ...modelParts] = agent.model.split("/");
    const modelId = modelParts.join("/");
    const providers = loadProviderMap();
    const provider = providers[providerKey];
    if (!provider?.baseUrl || !provider?.apiKey) {
      console.warn(`[bridge] No provider config for "${providerKey}" (agent ${ocAgentId}) — check ~/.crewswarm/config.json providers`);
      return null;
    }

    return { baseUrl: provider.baseUrl, apiKey: provider.apiKey, modelId, agentId: agent.id, providerKey, fallbackModel: agent.fallbackModel || null };
  } catch (e) {
    console.warn(`[bridge] loadAgentLLMConfig error: ${e.message}`);
    return null;
  }
}

async function callLLMDirect(prompt, ocAgentId, systemPrompt) {
  const llm = loadAgentLLMConfig(ocAgentId);
  if (!llm) return null; // fall through to legacy gateway

  // ── Spending cap pre-check ─────────────────────────────────────────────────
  const capResult = checkSpendingCap(ocAgentId, llm.providerKey || llm.modelId.split("/")[0]);
  if (capResult.exceeded) {
    if (capResult.action === "stop")
      throw new Error(`SPENDING_CAP_STOP: ${capResult.message}`);
    if (capResult.action === "pause") {
      notifyTelegramSpending(`⚠️ ${capResult.message} — ${ocAgentId} paused`).catch(() => {});
      throw new Error(`SPENDING_CAP_PAUSE: ${capResult.message}`);
    }
    if (capResult.action === "notify") {
      notifyTelegramSpending(`⚠️ ${capResult.message} — continuing`).catch(() => {});
      console.warn(`[spending] ${capResult.message} (notify-only, continuing)`);
    }
  }

  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  try {
    const res = await fetch(`${llm.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify({ model: llm.modelId, messages, max_tokens: 8192, stream: false }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      if (res.status === 429) throw Object.assign(new Error(`RATE_LIMITED: ${err.slice(0, 200)}`), { isRateLimit: true });
      throw new Error(`LLM API ${res.status}: ${err.slice(0, 200)}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || "";
    if (!text) throw new Error("Empty response from LLM");
    recordTokenUsage(llm.modelId, data.usage, ocAgentId);
    console.log(`[direct-llm] ${ocAgentId} via ${llm.modelId} — ${text.length} chars${data.usage ? ` (${(data.usage.prompt_tokens||0)+(data.usage.completion_tokens||0)} tokens)` : ""}`);
    return text;
  } catch (e) {
    if (e.isRateLimit) {
      console.error(`[direct-llm] ${ocAgentId} rate-limited (429) on ${llm.modelId} — waiting 10s then retry`);
      await new Promise(r => setTimeout(r, 10000));
      try {
        const res2 = await fetch(`${llm.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${llm.apiKey}` },
          body: JSON.stringify({ model: llm.modelId, messages, max_tokens: 8192, stream: false }),
          signal: AbortSignal.timeout(120000),
        });
        if (res2.ok) {
          const data2 = await res2.json();
          const text2 = data2?.choices?.[0]?.message?.content || "";
          if (text2) { console.log(`[direct-llm] ${ocAgentId} retry succeeded`); return text2; }
        }
      } catch {}
      console.error(`[direct-llm] ${ocAgentId} retry also failed — checking per-agent fallback`);
    } else {
      console.error(`[direct-llm] ${ocAgentId} failed: ${e.message} — checking per-agent fallback`);
    }

    // ── Per-agent fallback model ─────────────────────────────────────────────
    if (llm.fallbackModel) {
      try {
        const [fbProviderKey, ...fbModelParts] = llm.fallbackModel.split("/");
        const fbModelId = fbModelParts.join("/");
        const fbProviders = loadProviderMap();
        const fbProvider = fbProviders[fbProviderKey];
        if (fbProvider?.baseUrl && fbProvider?.apiKey) {
          console.warn(`[direct-llm] ${ocAgentId} → per-agent fallback (${llm.fallbackModel})`);
          const resFb = await fetch(`${(fbProvider.baseUrl || "").replace(/\/$/, "")}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${fbProvider.apiKey}` },
            body: JSON.stringify({ model: fbModelId, messages, max_tokens: 8192, stream: false }),
            signal: AbortSignal.timeout(60000),
          });
          if (resFb.ok) {
            const dataFb = await resFb.json();
            const textFb = dataFb?.choices?.[0]?.message?.content || "";
            if (textFb) {
              recordTokenUsage(fbModelId, dataFb.usage);
              console.log(`[direct-llm] ${ocAgentId} per-agent fallback succeeded (${textFb.length} chars)`);
              return textFb;
            }
          }
          console.error(`[direct-llm] Per-agent fallback also failed (${resFb.status}) — trying Groq global fallback`);
        } else {
          console.warn(`[direct-llm] Per-agent fallback provider "${fbProviderKey}" not configured — skipping`);
        }
      } catch (fbErr) {
        console.error(`[direct-llm] Per-agent fallback error: ${fbErr.message}`);
      }
    }

    // ── Global Groq fallback ─────────────────────────────────────────────────
    // If the agent's primary provider fails (key missing, rate limit, outage),
    // retry on Groq llama-3.3-70b-versatile which is fast and free-tier eligible.
    try {
      const providers = loadProviderMap();
      const groq = providers["groq"];
      if (groq?.apiKey && groq?.baseUrl) {
        const GROQ_FALLBACK_MODEL = process.env.GROQ_FALLBACK_MODEL || "llama-3.3-70b-versatile";
        console.warn(`[direct-llm] ${ocAgentId} → Groq fallback (${GROQ_FALLBACK_MODEL})`);
        const res = await fetch(`${(groq.baseUrl || "").replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${groq.apiKey}` },
          body: JSON.stringify({ model: GROQ_FALLBACK_MODEL, messages, max_tokens: 8192, stream: false }),
          signal: AbortSignal.timeout(60000),
        });
        if (res.ok) {
          const data = await res.json();
          const text = data?.choices?.[0]?.message?.content || "";
          if (text) {
            recordTokenUsage(GROQ_FALLBACK_MODEL, data.usage);
            console.log(`[direct-llm] ${ocAgentId} Groq fallback succeeded (${text.length} chars)`);
            return text;
          }
        }
        console.error(`[direct-llm] Groq fallback also failed (${res.status}) — giving up`);
      } else {
        console.warn(`[direct-llm] No Groq provider configured — cannot fallback`);
      }
    } catch (groqErr) {
      console.error(`[direct-llm] Groq fallback error: ${groqErr.message}`);
    }
    return null;
  }
}
const SHARED_MEMORY_BASE = process.env.SHARED_MEMORY_DIR || path.join(os.homedir(), ".crewswarm", "workspace", "shared-memory");
const SHARED_MEMORY_NAMESPACE = process.env.SHARED_MEMORY_NAMESPACE || "claw-swarm";
const SWARM_STATUS_LOG = path.join(SHARED_MEMORY_BASE, SHARED_MEMORY_NAMESPACE, "opencrew-rt", "channels", "status.jsonl");
const SWARM_DISPATCH_DIR = path.join(SHARED_MEMORY_BASE, SHARED_MEMORY_NAMESPACE, "opencrew-rt", "dispatch");
const SWARM_DLQ_DIR = path.join(SHARED_MEMORY_BASE, SHARED_MEMORY_NAMESPACE, "opencrew-rt", "dlq");
const SWARM_HEARTBEAT_WINDOW_SEC = Number(process.env.OPENCREW_RT_HEARTBEAT_WINDOW_SEC || "90");
const OPENCREW_RT_TASK_LEASE_MS = Number(process.env.OPENCREW_RT_TASK_LEASE_MS || "120000");
const OPENCREW_RT_TASK_HEARTBEAT_MS = Number(process.env.OPENCREW_RT_TASK_HEARTBEAT_MS || "15000");
const OPENCREW_RT_TASK_RETRY_MAX = Number(process.env.OPENCREW_RT_TASK_RETRY_MAX || "2");
const OPENCREW_RT_TASK_STATE_TTL_MS = Number(process.env.OPENCREW_RT_TASK_STATE_TTL_MS || "21600000");
const SWARM_RUNTIME_DIR = path.join(SHARED_MEMORY_BASE, SHARED_MEMORY_NAMESPACE, "opencrew-rt", "runtime");
const SWARM_TASK_LEASE_DIR = path.join(SWARM_RUNTIME_DIR, "task-leases");
const SWARM_TASK_STATE_DIR = path.join(SWARM_RUNTIME_DIR, "task-state");
const OPENCREW_RT_COMMAND_TYPES = new Set([
  "command.spawn_agent",
  "command.run_task",
  "command.cancel_task",
  "command.collect_status",
  "task.assigned",
  "task.reassigned",
  "system.broadcast",
  "cmd.approved",
  "cmd.rejected",
]);
const PROTOCOL_VERSION = 3;
const CLI_VERSION = "1.2.0";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const REQUEST_TIMEOUT_MS = 60000;
const CHAT_TIMEOUT_MS = 55000;
const RUN_ID = crypto.randomUUID();

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

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function ensureDispatchDir() {
  fs.mkdirSync(SWARM_DISPATCH_DIR, { recursive: true });
  return SWARM_DISPATCH_DIR;
}

function dispatchKeyForTask({ taskId, incomingType, prompt, idempotencyKey }) {
  const stableTaskId = String(taskId || "").trim();
  if (stableTaskId) return `task-${stableTaskId}`;
  const stableIdempotency = String(idempotencyKey || "").trim();
  if (stableIdempotency) return `idem-${stableIdempotency}`;
  const hash = crypto.createHash("sha256")
    .update(`${incomingType || "event"}\n${prompt || ""}`, "utf8")
    .digest("hex")
    .slice(0, 24);
  return `hash-${hash}`;
}

function leasePathForKey(key) {
  return path.join(ensureDispatchDir(), `${key}.lease`);
}

function donePathForKey(key) {
  return path.join(ensureDispatchDir(), `${key}.done.json`);
}

function readTaskDoneRecord(key) {
  return safeReadJson(donePathForKey(key));
}

function isDoneRecordFresh(record) {
  if (!record?.doneAt) return false;
  const doneAtMs = Date.parse(record.doneAt);
  if (!Number.isFinite(doneAtMs)) return false;
  return (Date.now() - doneAtMs) <= OPENCREW_RT_TASK_STATE_TTL_MS;
}

function readLeaseRecord(leaseDir) {
  return safeReadJson(path.join(leaseDir, "lease.json"));
}

function writeLeaseRecord(leaseDir, leaseRecord) {
  fs.writeFileSync(path.join(leaseDir, "lease.json"), JSON.stringify(leaseRecord, null, 2));
}

function acquireTaskLease({ key, source, incomingType, from, leaseMs }) {
  const leaseDir = leasePathForKey(key);
  const donePath = donePathForKey(key);
  const doneRecord = readTaskDoneRecord(key);
  if (doneRecord) {
    if (isDoneRecordFresh(doneRecord)) {
      return { acquired: false, reason: "already_done", doneRecord };
    }
    try {
      fs.rmSync(donePath, { force: true });
    } catch {}
  }

  const now = Date.now();
  const claimId = `${OPENCREW_RT_AGENT}-${process.pid}-${crypto.randomUUID()}`;
  const leaseRecord = {
    key,
    claimId,
    agent: OPENCREW_RT_AGENT,
    source,
    from,
    incomingType,
    leaseMs,
    leasedAt: isoNow(),
    leaseExpiresAt: new Date(now + leaseMs).toISOString(),
    updatedAt: isoNow(),
  };

  const writeNewLease = () => {
    fs.mkdirSync(leaseDir);
    writeLeaseRecord(leaseDir, leaseRecord);
    return { acquired: true, claimId, leaseDir };
  };

  try {
    return writeNewLease();
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
  }

  const existing = readLeaseRecord(leaseDir);
  const existingExpiry = Date.parse(existing?.leaseExpiresAt || "");
  if (Number.isFinite(existingExpiry) && existingExpiry > now) {
    return {
      acquired: false,
      reason: "claimed",
      claimedBy: existing?.agent || "unknown",
      leaseExpiresAt: existing?.leaseExpiresAt || null,
    };
  }

  try {
    fs.rmSync(leaseDir, { recursive: true, force: true });
    return writeNewLease();
  } catch {
    return {
      acquired: false,
      reason: "claimed",
      claimedBy: existing?.agent || "unknown",
      leaseExpiresAt: existing?.leaseExpiresAt || null,
    };
  }
}

function renewTaskLease({ key, claimId, leaseMs }) {
  const leaseDir = leasePathForKey(key);
  const current = readLeaseRecord(leaseDir);
  if (!current || current.claimId !== claimId || current.agent !== OPENCREW_RT_AGENT) return false;
  const now = Date.now();
  current.updatedAt = isoNow();
  current.leaseMs = leaseMs;
  current.leaseExpiresAt = new Date(now + leaseMs).toISOString();
  writeLeaseRecord(leaseDir, current);
  return true;
}

function releaseTaskLease({ key, claimId }) {
  const leaseDir = leasePathForKey(key);
  try {
    const current = readLeaseRecord(leaseDir);
    if (!current || current.claimId !== claimId || current.agent !== OPENCREW_RT_AGENT) return false;
    fs.rmSync(leaseDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function markTaskDone({ key, claimId, taskId, incomingType, from, attempt, idempotencyKey, reply }) {
  const donePath = donePathForKey(key);
  const replyText = String(reply || "");
  const doneRecord = {
    key,
    taskId,
    incomingType,
    from,
    claimId,
    idempotencyKey,
    agent: OPENCREW_RT_AGENT,
    attempt,
    reply: replyText.slice(0, 24000),
    replyHash: crypto.createHash("sha256").update(replyText, "utf8").digest("hex"),
    doneAt: isoNow(),
  };
  fs.writeFileSync(donePath, JSON.stringify(doneRecord, null, 2));
}

function shouldUseDispatchGuard(incomingType) {
  if (!OPENCREW_RT_DISPATCH_ENABLED) return false;
  return incomingType === "command.run_task" || incomingType === "task.assigned" || incomingType === "task.reassigned";
}

function shouldRetryTaskFailure(err) {
  const msg = String(err?.message ?? err ?? "");
  if (!msg) return false;
  if (msg.includes("MEMORY_PROTOCOL_MISSING") || msg.includes("MEMORY_LOAD_FAILED")) return false;
  if (msg.includes("CODING_ARTIFACT_MISSING")) return true; // Retry if agent didn't deliver code
  return transientError(err) || msg.toLowerCase().includes("timeout");
}

function isCodingTask(incomingType, prompt, payload) {
  if (!incomingType) return false;
  const codingTypes = ["command.run_task", "task.assigned", "task.reassigned"];
  if (!codingTypes.includes(incomingType)) return false;
  
  // Explicit action exemptions (NOT coding tasks)
  const action = String(payload?.action || "").toLowerCase();
  if (action === "collect_status" || action === "status" || action === "heartbeat") return false;
  
  // Check for status/reporting prompts (NOT coding)
  const text = String(prompt || "").toLowerCase();
  if (text.includes("report status") || text.includes("reply with agent id")) return false;
  if (text.includes("busy/idle") || text.includes("active task")) return false;
  
  // Check for coding keywords
  const codingKeywords = [
    "implement", "build", "create", "fix", "refactor", "add", "update", "modify",
    "code", "function", "class", "component", "api", "endpoint", "route", "test",
    "bug", "error", "issue", "file", "script", "module", "package"
  ];
  return codingKeywords.some(kw => text.includes(kw));
}

// ── Agent reply quality gate ───────────────────────────────────────────────
// Catches hollow replies BEFORE they get returned to crew-lead, preventing
// the "bad response → retry loop" that was burning tokens and cycling tasks.
//
// Design notes:
// - OpenCode agents write files on disk and confirm; they do NOT show code blocks
//   in their replies. So we NEVER check for ``` presence.
// - Direct-API agents do show code — but we still don't require it; we just
//   reject clearly hollow/broken patterns.
// - Validation is intentionally lenient: only hard-fail on patterns that are
//   definitively wrong. False negatives (letting a weak reply through) are
//   much cheaper than false positives (rejecting a valid reply and retrying).

const HOLLOW_REPLY_PATTERNS = [
  // AI refusals
  /^(sorry,?\s+)?(as an? (AI|language model|llm|assistant))[,.]?\s+i (can'?t|cannot|don'?t|am not able)/i,
  /i('?m| am) not able to (access|read|write|execute|run|perform)/i,
  /i don'?t have (access|permission|the ability) to/i,
  // Naked stall / forwarding without content
  /^(please|kindly)?\s*(wait|hold on|one moment|stand by)[.!]*$/i,
  /^i'?ll? (get|check|look|fetch|read) (that|this|it) (for you\s*)?$/i,
  // Pure error echo-back (realtime token noise should be filtered already, but belt+suspenders)
  /^(•\s*)?realtime (daemon )?error:/i,
  /invalid realtime token/i,
  // OpenCode "I have no tools" bailout
  /i (don'?t|do not) have (any )?(tools?|the ability|capabilities?) (to|for) (write|create|modify|execute|run)/i,
];

const WEASEL_ONLY_PATTERNS = [
  // These alone (with no action) are hollow for coding tasks
  /\b(i will|i would|i can|i could|i should|i might|i plan to|i recommend|i suggest)\b/i,
];

function validateAgentReply(reply, incomingType, prompt) {
  const text = String(reply || "").trim();

  // Empty reply is always bad
  if (!text || text.length < 15) {
    return { valid: false, reason: "reply too short or empty" };
  }

  // Hard-fail: hollow/broken patterns
  for (const pat of HOLLOW_REPLY_PATTERNS) {
    if (pat.test(text)) {
      return { valid: false, reason: `hollow reply pattern: ${pat.toString().slice(0, 60)}` };
    }
  }

  // For coding/writing tasks only: reject weasel-only replies that never act
  const isCoding = /code|write|build|create|implement|fix|refactor|generate|edit|update|add|remove/i.test(String(prompt || ""));
  if (isCoding && text.length < 300) {
    const allWeasel = WEASEL_ONLY_PATTERNS.every(p => p.test(text));
    const hasAction = /@@WRITE_FILE|@@RUN_CMD|@@READ_FILE|✅|wrote|created|updated|fixed|done|complete/i.test(text);
    if (allWeasel && !hasAction) {
      return { valid: false, reason: "short coding reply is all weasel words with no action evidence" };
    }
  }

  return { valid: true, reason: "ok" };
}

function validateCodingArtifacts(reply, incomingType, prompt, payload) {
  return validateAgentReply(reply, incomingType, prompt);
}

function assertTaskPromptProtocol(prompt, source = "task") {
  // Simplified: just check if prompt exists
  if (typeof prompt !== "string" || !prompt || prompt === "MEMORY_LOAD_FAILED") {
    const err = new Error("MEMORY_PROTOCOL_MISSING");
    telemetry("memory_protocol_missing", { source });
    throw err;
  }
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

function looksLikeCodingTask(prompt = "") {
  const p = String(prompt).toLowerCase();
  return [
    "implement", "write code", "refactor", "fix bug", "unit test", "integration test",
    "build", "compile", "typescript", "javascript", "python", "go ", "rust",
    "repo", "pull request", "pr ", "commit", "lint", "migrate",
  ].some((kw) => p.includes(kw));
}

// ── Agent Tool Execution ───────────────────────────────────────────────────
// Agents embed tool calls in their LLM reply using these markers.
// gateway-bridge parses and executes them, returning a summary of actions.
//
// Supported tools:
//   @@WRITE_FILE /absolute/path/to/file
//   <file contents>
//   @@END_FILE
//
//   @@READ_FILE /absolute/path/to/file
//
//   @@MKDIR /absolute/path/to/dir
//
//   @@RUN_CMD <shell command>  (whitelist-controlled)
//

// Agents that auto-approve @@RUN_CMD without requiring user confirmation
const _AUTO_APPROVE_STATIC = new Set(["crew-fixer", "crew-github", "crew-pm"]);
const _AUTO_APPROVE_ROLES = new Set(["coder", "ops", "generalist"]);

function isAutoApproveAgent(agentId) {
  if (_AUTO_APPROVE_STATIC.has(agentId)) return true;
  const agents = loadAgentList();
  const cfg = agents.find(a => a.id === agentId);
  if (cfg?.tools?.autoApproveCmd) return true;
  return cfg?._role ? _AUTO_APPROVE_ROLES.has(cfg._role) : false;
}

// Pending command approvals: approvalId → { resolve, timer }
const pendingCmdApprovals = new Map();

// Module-level RT client ref so executeToolCalls can publish approval requests
let _rtClientForApprovals = null;

// Per-role tool defaults — used when agent has no explicit alsoAllow in config
const AGENT_TOOL_ROLE_DEFAULTS = {
  'crew-qa':          new Set(['read_file','skill']),
  'crew-coder':       new Set(['write_file','read_file','mkdir','run_cmd','skill','define_skill']),
  'crew-coder-front': new Set(['write_file','read_file','mkdir','run_cmd','skill']),
  'crew-coder-back':  new Set(['write_file','read_file','mkdir','run_cmd','skill']),
  'crew-frontend':    new Set(['write_file','read_file','mkdir','run_cmd','skill']),
  'crew-fixer':       new Set(['write_file','read_file','mkdir','run_cmd','skill']),
  'crew-github':      new Set(['read_file','run_cmd','git','skill']),
  'crew-pm':          new Set(['read_file','write_file','mkdir','dispatch','skill']),
  'crew-main':        new Set(['read_file','write_file','run_cmd','dispatch','skill','define_skill']),
  'crew-security':    new Set(['read_file','run_cmd']),
  'crew-copywriter':  new Set(['write_file','read_file','skill']),
  'crew-telegram':    new Set(['telegram','read_file']),
  'crew-lead':        new Set(['read_file','write_file','mkdir','run_cmd','web_search','web_fetch','skill','define_skill','dispatch','telegram','whatsapp']),
};

// CrewSwarm @@TOOL permission names — distinct from legacy gateway tool names
const CREWSWARM_TOOL_NAMES = new Set(['write_file','read_file','mkdir','run_cmd','git','dispatch','skill','define_skill','telegram','web_search','web_fetch']);

function loadAgentToolPermissions(agentId) {
  // Check config files for explicit CrewSwarm-style tool permissions.
  // tools.alsoAllow in crewswarm.json may contain legacy gateway tool names (exec, web_search, etc.)
  // — only use it if it contains at least one CrewSwarm @@TOOL name.
  try {
    const cfgPaths = [
      path.join(os.homedir(), ".crewswarm", "crewswarm.json"),
      path.join(os.homedir(), ".crewswarm", "config.json"),
      path.join(os.homedir(), ".openclaw", "openclaw.json"),
    ];
    for (const p of cfgPaths) {
      if (!fs.existsSync(p)) continue;
      const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
      const agents = Array.isArray(cfg.agents) ? cfg.agents : (cfg.agents?.list || []);
      const crewId = agentId.startsWith("crew-") ? agentId : `crew-${agentId}`;
      const bareId = agentId.startsWith("crew-") ? agentId.slice(5) : agentId;
      const agent = agents.find(a => a.id === agentId || a.id === crewId || a.id === bareId);
      // Only accept if the list contains CrewSwarm-style tool names, not just legacy gateway names
      const allow = agent?.tools?.crewswarmAllow || agent?.tools?.alsoAllow || [];
      const crewswarmTools = allow.filter(t => CREWSWARM_TOOL_NAMES.has(t));
      if (crewswarmTools.length > 0) {
        return new Set(crewswarmTools);
      }
    }
  } catch {}
  // Fall back to role defaults (covers crew-coder, crew-qa, crew-fixer, etc.)
  if (AGENT_TOOL_ROLE_DEFAULTS[agentId]) return AGENT_TOOL_ROLE_DEFAULTS[agentId];
  // Fuzzy match — e.g. crew-coder-3 → coder defaults
  for (const [key, val] of Object.entries(AGENT_TOOL_ROLE_DEFAULTS)) {
    if (agentId.startsWith(key)) return val;
  }
  // Dynamic agents: derive tools from _role in crewswarm.json
  try {
    const agents = loadAgentList();
    const cfg = agents.find(a => a.id === agentId);
    if (cfg?._role) {
      const ROLE_TOOL_DEFAULTS = {
        coder:      new Set(['write_file','read_file','mkdir','run_cmd','skill']),
        researcher: new Set(['read_file','web_search','web_fetch','skill']),
        writer:     new Set(['write_file','read_file','web_search','web_fetch','skill']),
        auditor:    new Set(['read_file','run_cmd','skill']),
        ops:        new Set(['read_file','write_file','mkdir','run_cmd','git','skill']),
        generalist: new Set(['read_file','write_file','mkdir','run_cmd','dispatch','skill']),
      };
      if (ROLE_TOOL_DEFAULTS[cfg._role]) return ROLE_TOOL_DEFAULTS[cfg._role];
    }
  } catch {}
  // Unknown agent — allow read/write/mkdir/run by default
  return new Set(['read_file','write_file','mkdir','run_cmd']);
}

function buildToolInstructions(allowed) {
  const projectDir = getOpencodeProjectDir() || process.cwd();
  const tools = [];
  if (allowed.has('write_file')) tools.push(`### Write a file to disk:
@@WRITE_FILE ${projectDir}/file.html
<!DOCTYPE html>
<html>...full file contents here...</html>
@@END_FILE`);
  if (allowed.has('read_file')) tools.push(`### Read a file from disk:
@@READ_FILE /absolute/path/to/file.txt`);
  if (allowed.has('mkdir')) tools.push(`### Create a directory:
@@MKDIR /absolute/path/to/directory`);
  if (allowed.has('run_cmd') || allowed.has('git')) {
    const gitNote = allowed.has('git') ? " Git commands (git status, git add, git commit, git push, git log) are also allowed." : "";
    tools.push(`### Run a shell command (safe subset only — no rm, no sudo):${gitNote}
@@RUN_CMD ls /some/path`);
  }
  if (allowed.has('web_search')) tools.push(`### Search the web (Brave Search):
@@WEB_SEARCH your search query here
Returns top 5 results with title, URL, and snippet. Use this to research facts, find examples, or verify information before writing.`);
  if (allowed.has('web_fetch')) tools.push(`### Fetch a URL and read its content:
@@WEB_FETCH https://example.com/page
Returns the page text (up to 8000 chars). Use to read docs, articles, or any URL before summarising or referencing.`);
  if (allowed.has('telegram')) tools.push(`### Send a Telegram message:
@@TELEGRAM your message text here
@@TELEGRAM @ContactName message text here
Sends a message to the configured Telegram chat (or to a contact by name if you use @Name). Contact names are set in Dashboard → Settings → Telegram → Contact names. Use to notify humans of task completion, errors, or important findings.`);
  if (allowed.has('skill')) {
    const skillList = (() => {
      try {
        if (!fs.existsSync(SKILLS_DIR)) return "(none installed yet)";
        const entries = [];
        // JSON skills
        const jsonFiles = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith(".json"));
        for (const f of jsonFiles) {
          try {
            const d = JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, f), "utf8"));
            const name     = f.replace(".json","");
            const approval = d.requiresApproval ? " ⚠️ requires-approval" : "";
            const urlLine  = d.url  ? `\n      URL: ${d.method||"POST"} ${d.url}` : "";
            const notes    = d.paramNotes ? `\n      Params: ${d.paramNotes}` : "";
            const defaults = d.defaultParams && Object.keys(d.defaultParams).length
              ? `\n      Defaults: ${JSON.stringify(d.defaultParams)}` : "";
            entries.push(`  - ${name}${approval} — ${d.description || ""}${urlLine}${notes}${defaults}`);
          } catch { entries.push(`  - ${f.replace(".json","")}`); }
        }
        // SKILL.md skills (AgentSkills / ClawHub format)
        const dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
          .filter(e => e.isDirectory() && fs.existsSync(path.join(SKILLS_DIR, e.name, "SKILL.md")));
        for (const dir of dirs) {
          const md = loadSkillMd(dir.name);
          if (md) {
            const tag = md.url ? "" : " 📄 instruction-card";
            entries.push(`  - ${dir.name}${tag} — ${md.description}`);
          }
        }
        // Standalone .md skills
        const mdFiles = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith(".md"));
        for (const f of mdFiles) {
          const name = f.replace(".md","");
          if (!jsonFiles.some(j => j.replace(".json","") === name)) {
            const md = loadSkillMd(name);
            if (md) entries.push(`  - ${name} 📄 — ${md.description}`);
          }
        }
        return entries.length ? entries.join("\n") : "(none installed yet)";
      } catch { return ""; }
    })();
    tools.push(`### Call an external skill (API integration):
@@SKILL skillname {"param":"value"}
Available skills:\n${skillList}
Replace skillname with the skill name. Include any required params as inline JSON on the same line.
Example: @@SKILL fly.deploy {"app":"myapp"}
Example: @@SKILL elevenlabs.tts {"text":"Hello world","voice_id":"21m00Tcm4TlvDq8ikWAM"}`);
    if (allowed.has('define_skill')) {
      tools.push(`### Define or update a skill (create a reusable API integration):
@@DEFINE_SKILL skillname
{
  "description": "What this skill does",
  "url": "https://api.example.com/endpoint/{param}",
  "method": "POST",
  "auth": {"type": "bearer", "keyFrom": "providers.PROVIDER.apiKey"},
  "defaultParams": {"model": "default"},
  "paramNotes": "Required: param1. Optional: param2 (default: x).",
  "requiresApproval": false
}
@@END_SKILL
Use @@WEB_SEARCH and @@WEB_FETCH to research the API first, then define the skill.
Auth types: "bearer" (Authorization: Bearer <key>), "header" (custom header + "header" field).
keyFrom format: "providers.PROVIDER.apiKey" (reads from crewswarm.json) or "env.ENV_VAR_NAME".`);
    }
  }
  if (!tools.length) return ""; // agent has no tools — instructions not needed

  const externalProjectHint =
    projectDir === process.cwd()
      ? `- If the task refers to an external project by name (e.g. polymarket-ai-strat), its root is typically ${path.join(os.homedir(), "Desktop", "<project-name>")}, not under PROJECT DIRECTORY. Do not use paths like .../CrewSwarm/<project-name>/...; use .../Desktop/<project-name>/... instead.`
      : "";

  return `
## Agent Tools — ACTIVE for this session

When your task requires actions on disk or network, output the tool markers below directly in your reply.
The system detects and executes them automatically. ALWAYS use absolute paths.

PROJECT DIRECTORY (write all output files here): ${projectDir}

${tools.join("\n\n")}

CRITICAL RULES:
${externalProjectHint ? externalProjectHint + "\n" : ""}- Output the @@TOOL markers directly — do NOT describe or simulate what you would do.
- Use @@WRITE_FILE to write files — never just show code in markdown blocks.
- @@END_FILE MUST appear on its own line immediately after the last line of file content.
- ALL tool calls go in a SINGLE reply — do NOT stop after @@MKDIR and wait for results. Chain @@MKDIR then @@WRITE_FILE immediately in the same response.
- Do NOT write "**Tool execution results:**" — the system appends that automatically.
- Do NOT wrap file contents in markdown fences inside @@WRITE_FILE...@@END_FILE blocks.
- Write ALL output files under ${projectDir}/ unless the task explicitly specifies a different absolute path.
- Disabled tools: ${['write_file','read_file','mkdir','run_cmd','git'].filter(t => !allowed.has(t)).join(', ') || 'none'}
- To log a durable discovery to the shared knowledge base (brain.md), include this anywhere in your reply:
  @@BRAIN: <one-line fact worth remembering for future tasks>
`;
}

// Commands that are always blocked regardless of agent permissions or allowlist
const BLOCKED_CMD_PATTERNS = [
  /\brm\s+-[rf]{1,2}f?\b/,
  /\bsudo\b/,
  /curl[^|\n]*\|\s*(bash|sh|zsh|fish)\b/i,
  /wget[^|\n]*\|\s*(bash|sh|zsh|fish)\b/i,
  /:\(\)\s*\{\s*:\|:&\s*\};?\s*:/,   // fork bomb
  /\bdd\s+if=/,
  /\bmkfs\b/,
  /\bfdisk\b/,
  /\bchmod\s+[0-9]*7[0-9]*\s+\/\b/,  // chmod 777 /...
  /\bkillall\b/,
];

const SAFE_GIT_CMD_WHITELIST = /^(git (status|log|diff|add|commit|push|pull|fetch|branch|checkout|show|rev-parse|remote|tag|stash))\b/;

// Allowlist — patterns stored in ~/.crewswarm/cmd-allowlist.json
const CMD_ALLOWLIST_FILE = path.join(os.homedir(), ".crewswarm", "cmd-allowlist.json");

function loadCmdAllowlist() {
  try { return JSON.parse(fs.readFileSync(CMD_ALLOWLIST_FILE, "utf8")); } catch { return []; }
}

function isCommandBlocked(cmd) {
  return BLOCKED_CMD_PATTERNS.some(re => re.test(cmd));
}

function isCommandAllowlisted(cmd) {
  const list = loadCmdAllowlist();
  return list.some(pattern => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}`, "i").test(cmd.trim());
  });
}

// ── Skills system ─────────────────────────────────────────────────────────────
const SKILLS_DIR         = path.join(os.homedir(), ".crewswarm", "skills");
const PENDING_SKILLS_FILE = path.join(os.homedir(), ".crewswarm", "pending-skills.json");

// ── AgentSkills SKILL.md loader ───────────────────────────────────────────────
// Supports ClawHub-compatible skills: drop a folder with a SKILL.md into
// ~/.crewswarm/skills/<name>/SKILL.md and it works alongside JSON skills.
// SKILL.md uses YAML frontmatter (name, description, aliases, url, method).
// If the skill has a url in frontmatter → executes like a JSON skill.
// If not → injects the SKILL.md content as the skill result (instruction card).

function parseSkillMdFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const front = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (!m) continue;
    let val = m[2].trim();
    // parse simple arrays: ["a","b"] or [a, b]
    if (val.startsWith("[")) {
      try { val = JSON.parse(val.replace(/'/g, '"')); } catch { val = val.slice(1,-1).split(",").map(s => s.trim().replace(/^['"]|['"]$/g,"")); }
    }
    front[m[1]] = val;
  }
  return front;
}

/** Run clawscan on a skill directory/file. Returns { safe, score, findings } */
function clawscanSkill(skillPath) {
  try {
    const dir = skillPath.endsWith("SKILL.md") ? path.dirname(skillPath) : skillPath;
    const { execSync } = require("child_process");
    const out = execSync(`npx clawscan scan "${dir}" --json 2>/dev/null || npx clawscan scan "${dir}" 2>&1`, {
      timeout: 15000, encoding: "utf8", stdio: ["pipe","pipe","pipe"],
    });
    // Try JSON output first
    try {
      const j = JSON.parse(out);
      return { safe: (j.score || 0) < 40, score: j.score || 0, findings: j.findings || [] };
    } catch {}
    // Fallback: parse text output
    const scoreMatch = out.match(/score:\s*(\d+)/i);
    const score = scoreMatch ? parseInt(scoreMatch[1]) : 0;
    const dangerous = /🔴|DANGEROUS|CRITICAL/i.test(out);
    const warning   = /🟡|WARNING/i.test(out);
    return { safe: !dangerous, score, findings: [], raw: out.slice(0, 500) };
  } catch (e) {
    // clawscan unavailable — skip scan, log warning
    console.warn("[skill-scan] clawscan unavailable, skipping scan for", skillPath, e?.message?.slice(0,80));
    return { safe: true, score: -1, skipped: true };
  }
}

function loadSkillMd(skillName) {
  // Try ~/.crewswarm/skills/<name>/SKILL.md  or  ~/.crewswarm/skills/<name>.md
  const candidates = [
    path.join(SKILLS_DIR, skillName, "SKILL.md"),
    path.join(SKILLS_DIR, skillName + ".md"),
  ];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    try {
      const raw  = fs.readFileSync(f, "utf8");
      const meta = parseSkillMdFrontmatter(raw);
      const body = raw.replace(/^---[\s\S]*?---\r?\n/, "").trim();
      // ── Security scan ──────────────────────────────────────────────────────
      const scan = clawscanSkill(f);
      if (!scan.safe && !scan.skipped) {
        console.error(`[skill-scan] ⛔ BLOCKED skill "${skillName}" — clawscan score ${scan.score}/100. Remove from ~/.crewswarm/skills/ to suppress.`);
        return null; // refuse to load
      }
      if (scan.score >= 20 && !scan.skipped) {
        console.warn(`[skill-scan] ⚠️  Skill "${skillName}" scored ${scan.score}/100 — loaded with caution.`);
      }
      // ───────────────────────────────────────────────────────────────────────
      return {
        _type:       "skill-md",
        name:        meta.name || skillName,
        description: meta.description || "",
        aliases:     Array.isArray(meta.aliases) ? meta.aliases : (meta.aliases ? [meta.aliases] : []),
        url:         meta.url || null,
        method:      meta.method || "GET",
        defaultParams: meta.defaultParams ? (typeof meta.defaultParams === "string" ? JSON.parse(meta.defaultParams) : meta.defaultParams) : {},
        _body:       body,
        _file:       f,
        _scanScore:  scan.score,
      };
    } catch { continue; }
  }
  // Also scan subdirs for aliases
  try {
    const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const f = path.join(SKILLS_DIR, ent.name, "SKILL.md");
      if (!fs.existsSync(f)) continue;
      try {
        const raw  = fs.readFileSync(f, "utf8");
        const meta = parseSkillMdFrontmatter(raw);
        const aliases = Array.isArray(meta.aliases) ? meta.aliases : (meta.aliases ? [meta.aliases] : []);
        if (aliases.includes(skillName) || (meta.name && meta.name === skillName)) {
          const body = raw.replace(/^---[\s\S]*?---\r?\n/, "").trim();
          return { _type:"skill-md", name: meta.name || ent.name, description: meta.description||"", aliases, url: meta.url||null, method: meta.method||"GET", defaultParams:{}, _body: body, _file: f };
        }
      } catch { continue; }
    }
  } catch {}
  return null;
}

/** Resolve skill name alias to actual skill file name. E.g. "benchmark" → "zeroeval.benchmark". */
function resolveSkillAlias(skillName) {
  const exact = path.join(SKILLS_DIR, skillName + ".json");
  if (fs.existsSync(exact)) return skillName;
  try {
    const files = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith(".json"));
    for (const f of files) {
      const real = f.replace(".json", "");
      const def = JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, f), "utf8"));
      const aliases = def.aliases || [];
      if (aliases.includes(skillName)) return real;
    }
  } catch {}
  return skillName;
}

function loadSkillDef(skillName) {
  const resolved = resolveSkillAlias(skillName);
  const file = path.join(SKILLS_DIR, resolved + ".json");
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  }
  // Fall back to SKILL.md format (AgentSkills / ClawHub)
  return loadSkillMd(skillName);
}

function loadPendingSkills() {
  try { return JSON.parse(fs.readFileSync(PENDING_SKILLS_FILE, "utf8")); } catch { return {}; }
}
function savePendingSkills(map) {
  try {
    fs.mkdirSync(path.dirname(PENDING_SKILLS_FILE), { recursive: true });
    fs.writeFileSync(PENDING_SKILLS_FILE, JSON.stringify(map, null, 2));
  } catch {}
}

async function executeSkill(skillDef, params) {
  // AgentSkills / ClawHub SKILL.md — instruction card with no URL → return content
  if (skillDef._type === "skill-md" && !skillDef.url) {
    const paramStr = Object.keys(params).length ? `\nCalled with params: ${JSON.stringify(params)}` : "";
    return `[Skill: ${skillDef.name}]\n${skillDef._body}${paramStr}`;
  }
  // SKILL.md with a url → treat exactly like a JSON skill (fall through)
  const cfg = resolveConfig();
  let url;
  const merged = { ...(skillDef.defaultParams || {}), ...params };
  const aliases = skillDef.paramAliases || {};
  for (const [param, map] of Object.entries(aliases)) {
    if (merged[param] != null && map[merged[param]] != null) merged[param] = map[merged[param]];
  }
  const urlParamEmpty = (skillDef.url || "").match(/\{(\w+)\}/);
  const emptyKey = urlParamEmpty ? urlParamEmpty[1] : null;
  const isParamEmpty = emptyKey && (merged[emptyKey] === undefined || merged[emptyKey] === null || String(merged[emptyKey] || "").trim() === "");
  if (skillDef.listUrl && isParamEmpty) {
    url = skillDef.listUrl;
  } else {
    url = skillDef.url;
    for (const [k, v] of Object.entries(merged)) {
      url = url.replace(`{${k}}`, encodeURIComponent(String(v)));
    }
  }
  const headers = { "Content-Type": "application/json", ...(skillDef.headers || {}) };
  // Auth resolution
  if (skillDef.auth) {
    const auth = skillDef.auth;
    let token = auth.token || "";
    if (auth.keyFrom) {
      // e.g. "providers.elevenlabs.apiKey" → walk config
      let val = cfg;
      for (const part of auth.keyFrom.split(".")) { val = val?.[part]; }
      if (val) token = String(val);
    }
    if (token) {
      if (auth.type === "bearer" || !auth.type) headers["Authorization"] = `Bearer ${token}`;
      else if (auth.type === "header") headers[auth.header || "X-API-Key"] = token;
      else if (auth.type === "basic") headers["Authorization"] = `Basic ${Buffer.from(token).toString("base64")}`;
    }
  }
  const method  = (skillDef.method || "POST").toUpperCase();
  const timeout = skillDef.timeout || 30000;
  const reqOpts = { method, headers, signal: AbortSignal.timeout(timeout) };
  if (method !== "GET" && method !== "HEAD") reqOpts.body = JSON.stringify(merged);
  console.log(`[gateway] skill fetch → ${method} ${url}`);
  const res  = await fetch(url, reqOpts);
  const text = await res.text();
  console.log(`[gateway] skill fetch ← ${res.status} ${text.slice(0, 100).replace(/\n/g, " ")}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return { response: text }; }
}

async function notifyTelegramSkillApproval(agentId, skillName, params, approvalId) {
  const cfg = resolveConfig();
  const tgBridge = resolveTelegramBridgeConfig();
  const botToken = process.env.TELEGRAM_BOT_TOKEN || cfg?.env?.TELEGRAM_BOT_TOKEN || cfg?.TELEGRAM_BOT_TOKEN || tgBridge.token || "";
  const chatId   = process.env.TELEGRAM_CHAT_ID   || cfg?.env?.TELEGRAM_CHAT_ID   || cfg?.TELEGRAM_CHAT_ID
    || (Array.isArray(tgBridge.allowedChatIds) && tgBridge.allowedChatIds.length ? String(tgBridge.allowedChatIds[0]) : "") || tgBridge.defaultChatId || "";
  const chatIdVal = chatId.trim();
  if (!botToken || !chatIdVal) return;
  const msg = `🔔 *Skill approval needed*\n*${agentId}* → *${skillName}*\nParams: \`${JSON.stringify(params).slice(0, 200)}\`\n\nApprove: POST /api/skills/approve {"approvalId":"${approvalId}"}\nOr reply approve/${approvalId} here`;
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatIdVal, text: msg, parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[
        { text: "✅ Approve", callback_data: `skill_approve:${approvalId}` },
        { text: "❌ Reject",  callback_data: `skill_reject:${approvalId}`  },
      ]]}
    }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => {});
}

// ── 2-level spending caps ─────────────────────────────────────────────────────
const SPENDING_FILE = path.join(os.homedir(), ".crewswarm", "spending.json");
// Approximate cost per 1M tokens per provider (USD)
const COST_PER_1M = { groq:0.05, anthropic:3.00, openai:5.00, perplexity:1.00, mistral:0.70, google:0.15, xai:2.00, deepseek:0.27, nvidia:1.00, cerebras:0.10 };

function loadSpending() {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const d = JSON.parse(fs.readFileSync(SPENDING_FILE, "utf8"));
    if (d.date === today) return d;
  } catch {}
  return { date: today, global: { tokens: 0, costUSD: 0 }, agents: {} };
}
function saveSpending(s) {
  try { fs.mkdirSync(path.dirname(SPENDING_FILE), { recursive: true }); fs.writeFileSync(SPENDING_FILE, JSON.stringify(s, null, 2)); } catch {}
}
function addAgentSpend(agentId, tokens, costUSD) {
  const s = loadSpending();
  s.global.tokens  += tokens;
  s.global.costUSD += costUSD;
  if (!s.agents[agentId]) s.agents[agentId] = { tokens: 0, costUSD: 0 };
  s.agents[agentId].tokens  += tokens;
  s.agents[agentId].costUSD += costUSD;
  saveSpending(s);
}
function checkSpendingCap(agentId, providerKey) {
  try {
    const csw = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "crewswarm.json"), "utf8"));
    const s   = loadSpending();
    const gl  = csw.globalSpendingCaps || {};
    // Global cap check
    if (gl.dailyTokenLimit && s.global.tokens >= gl.dailyTokenLimit)
      return { exceeded: true, action: "stop", message: `Global daily token limit ${gl.dailyTokenLimit.toLocaleString()} reached` };
    if (gl.dailyCostLimitUSD && s.global.costUSD >= gl.dailyCostLimitUSD)
      return { exceeded: true, action: "stop", message: `Global daily cost limit $${gl.dailyCostLimitUSD} reached` };
    // Per-agent cap check
    const agent    = (csw.agents || []).find(a => a.id === agentId);
    const agentCap = agent?.spending;
    if (agentCap) {
      const used = s.agents[agentId] || { tokens: 0, costUSD: 0 };
      if (agentCap.dailyTokenLimit && used.tokens >= agentCap.dailyTokenLimit)
        return { exceeded: true, action: agentCap.onExceed || "notify", message: `${agentId} daily token limit ${agentCap.dailyTokenLimit.toLocaleString()} reached` };
      if (agentCap.dailyCostLimitUSD && used.costUSD >= agentCap.dailyCostLimitUSD)
        return { exceeded: true, action: agentCap.onExceed || "notify", message: `${agentId} daily cost limit $${agentCap.dailyCostLimitUSD} reached` };
    }
  } catch {}
  return { exceeded: false };
}
async function notifyTelegramSpending(message) {
  const cfg = resolveConfig();
  const tgBridge = resolveTelegramBridgeConfig();
  const botToken = process.env.TELEGRAM_BOT_TOKEN || cfg?.env?.TELEGRAM_BOT_TOKEN || cfg?.TELEGRAM_BOT_TOKEN || tgBridge.token || "";
  const chatId   = process.env.TELEGRAM_CHAT_ID   || cfg?.env?.TELEGRAM_CHAT_ID   || cfg?.TELEGRAM_CHAT_ID
    || (Array.isArray(tgBridge.allowedChatIds) && tgBridge.allowedChatIds.length ? String(tgBridge.allowedChatIds[0]) : "") || tgBridge.defaultChatId || "";
  const chatIdVal = chatId.trim();
  if (!botToken || !chatIdVal) return;
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatIdVal, text: `💸 Spending alert: ${message}`, parse_mode: "Markdown" }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

// ── Token/cost accumulator ────────────────────────────────────────────────────
const TOKEN_USAGE_FILE = path.join(os.homedir(), ".crewswarm", "token-usage.json");

const tokenUsage = (() => {
  try { return JSON.parse(fs.readFileSync(TOKEN_USAGE_FILE, "utf8")); } catch {}
  return { calls: 0, prompt: 0, completion: 0, byModel: {}, sessionStart: new Date().toISOString() };
})();

function recordTokenUsage(modelId, usage, agentId) {
  if (!usage) return;
  const p = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const c = Number(usage.completion_tokens || usage.output_tokens || 0);
  if (!p && !c) return;
  const today = new Date().toISOString().slice(0, 10);
  tokenUsage.calls++;
  tokenUsage.prompt     += p;
  tokenUsage.completion += c;
  if (!tokenUsage.byModel[modelId]) tokenUsage.byModel[modelId] = { calls: 0, prompt: 0, completion: 0 };
  tokenUsage.byModel[modelId].calls++;
  tokenUsage.byModel[modelId].prompt     += p;
  tokenUsage.byModel[modelId].completion += c;
  // Daily rollup
  if (!tokenUsage.byDay) tokenUsage.byDay = {};
  if (!tokenUsage.byDay[today]) tokenUsage.byDay[today] = { calls: 0, prompt: 0, completion: 0, byModel: {} };
  tokenUsage.byDay[today].calls++;
  tokenUsage.byDay[today].prompt     += p;
  tokenUsage.byDay[today].completion += c;
  if (!tokenUsage.byDay[today].byModel[modelId]) tokenUsage.byDay[today].byModel[modelId] = { calls: 0, prompt: 0, completion: 0 };
  tokenUsage.byDay[today].byModel[modelId].calls++;
  tokenUsage.byDay[today].byModel[modelId].prompt     += p;
  tokenUsage.byDay[today].byModel[modelId].completion += c;
  // Flush to disk every 5 calls
  if (tokenUsage.calls % 5 === 0) {
    try {
      fs.mkdirSync(path.dirname(TOKEN_USAGE_FILE), { recursive: true });
      fs.writeFileSync(TOKEN_USAGE_FILE, JSON.stringify(tokenUsage, null, 2));
    } catch {}
  }
  // Track per-agent spending for caps
  if (agentId) {
    const total = p + c;
    const providerKey = modelId.split("/")[0] || "unknown";
    const costPer1M   = COST_PER_1M[providerKey] || 1.0;
    const costUSD     = (total / 1_000_000) * costPer1M;
    addAgentSpend(agentId, total, costUSD);
  }
}

// Sanitize paths from agent replies — strip markdown/hallucination (backticks, trailing punctuation)
function sanitizeToolPath(raw) {
  if (typeof raw !== "string") return "";
  let s = raw.trim().replace(/\s+/g, " ").replace(/`/g, "");
  while (s.length > 1 && (s.endsWith(".") || s.endsWith(","))) s = s.slice(0, -1).trim();
  s = s.replace(/^~/, os.homedir());
  // Resolve relative paths against the configured project dir so agents
  // that output bare filenames don't accidentally write to the CrewSwarm root.
  if (!path.isAbsolute(s)) {
    const base = getOpencodeProjectDir() || process.cwd();
    s = path.join(base, s);
  }
  return s;
}

async function executeToolCalls(reply, agentId, { suppressWriteIfSearchPending = false } = {}) {
  const allowed = loadAgentToolPermissions(agentId);
  const results = [];

  // If the reply contains both @@WEB_SEARCH/@@WEB_FETCH and @@WRITE_FILE in the same
  // message, the model is writing before it has seen real search results — suppress
  // the write so the caller can do a follow-up call with actual search data.
  const hasPendingSearches = /@@WEB_SEARCH[ \t]+\S|@@WEB_FETCH[ \t]+https?:\/\//.test(reply);
  const hasWrite = /@@WRITE_FILE[ \t]+\S/.test(reply);
  const blockWrite = suppressWriteIfSearchPending && hasPendingSearches && hasWrite;

  // ── @@WRITE_FILE ──────────────────────────────────────────────────────────
  const writeRe = /@@WRITE_FILE[ \t]+([^\n]+)\n([\s\S]*?)@@END_FILE/g;
  let m;
  while ((m = writeRe.exec(reply)) !== null) {
    if (blockWrite) {
      results.push(`[tool:write_file] ⏸ Write suppressed — waiting for search results first`);
      continue;
    }
    if (!allowed.has('write_file')) {
      results.push(`[tool:write_file] ⛔ ${agentId} does not have write_file permission`);
      continue;
    }
    const filePath = sanitizeToolPath(m[1]);
    const absPath = path.resolve(filePath);
    const contents = m[2];
    try {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, contents, "utf8");
      const msg = `[tool:write_file] ✅ Wrote ${contents.length} bytes → ${absPath}`;
      results.push(msg);
      console.log(`[${agentId}] ${msg}`);
    } catch (err) {
      const msg = `[tool:write_file] ❌ Failed to write ${absPath}: ${err.message}`;
      results.push(msg);
      console.error(`[${agentId}] ${msg}`);
    }
  }

  // ── @@READ_FILE ───────────────────────────────────────────────────────────
  // Path stops at newline or next @@ so multiple @@READ_FILE on one line are parsed separately
  const readRe = /@@READ_FILE[ \t]+([^\n@@]+)/g;
  while ((m = readRe.exec(reply)) !== null) {
    if (!allowed.has('read_file')) {
      results.push(`[tool:read_file] ⛔ ${agentId} does not have read_file permission`);
      continue;
    }
    const filePath = sanitizeToolPath(m[1]);
    try {
      const content = fs.readFileSync(filePath, "utf8");
      // Docs/briefs get a higher limit — they are reference material, not code blobs
      const isDoc = /\.(md|txt|json|yaml|yml|toml)$/i.test(filePath);
      const readLimit = isDoc ? 12000 : 4000;
      const snippet = content.length > readLimit ? content.slice(0, readLimit) + "\n...[truncated]" : content;
      results.push(`[tool:read_file] 📄 ${filePath} (${content.length} bytes):\n${snippet}`);
    } catch (err) {
      results.push(`[tool:read_file] ❌ Cannot read ${filePath}: ${err.message}`);
    }
  }

  // ── @@MKDIR ───────────────────────────────────────────────────────────────
  const mkdirRe = /@@MKDIR[ \t]+([^\n@@]+)/g;
  while ((m = mkdirRe.exec(reply)) !== null) {
    if (!allowed.has('mkdir')) {
      results.push(`[tool:mkdir] ⛔ ${agentId} does not have mkdir permission`);
      continue;
    }
    const dirPath = sanitizeToolPath(m[1]);
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      results.push(`[tool:mkdir] ✅ Created directory: ${dirPath}`);
    } catch (err) {
      results.push(`[tool:mkdir] ❌ Failed: ${err.message}`);
    }
  }

  // ── @@RUN_CMD ─────────────────────────────────────────────────────────────
  const cmdRe = /@@RUN_CMD[ \t]+([^\n]+)/g;
  while ((m = cmdRe.exec(reply)) !== null) {
    const cmd = m[1].trim();
    const isGit = SAFE_GIT_CMD_WHITELIST.test(cmd);

    // Hard block — dangerous patterns regardless of permissions
    if (isCommandBlocked(cmd)) {
      results.push(`[tool:run_cmd] ⛔ Blocked dangerous command: ${cmd}`);
      continue;
    }
    if (isGit && !allowed.has('git') && !allowed.has('run_cmd')) {
      results.push(`[tool:run_cmd] ⛔ ${agentId} does not have git permission`);
      continue;
    }
    if (!isGit && !allowed.has('run_cmd')) {
      results.push(`[tool:run_cmd] ⛔ ${agentId} does not have run_cmd permission`);
      continue;
    }

    // ── Approval gate — skip for git, auto-approved agents, or allowlisted commands ─
    const needsApproval = !isGit && !isAutoApproveAgent(agentId) && !isCommandAllowlisted(cmd) && _rtClientForApprovals;
    if (needsApproval) {
      const approvalId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        _rtClientForApprovals.publish({
          channel: "events",
          type: "cmd.needs_approval",
          to: "broadcast",
          payload: { approvalId, agent: agentId, cmd, ts: new Date().toISOString() },
        });
      } catch (pubErr) {
        console.warn(`[${agentId}] Could not publish cmd.needs_approval: ${pubErr?.message}`);
      }

      console.log(`[${agentId}] ⏳ Awaiting approval to run: ${cmd}`);
      const approved = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingCmdApprovals.delete(approvalId);
          console.warn(`[${agentId}] cmd approval timed out (60s): ${cmd}`);
          resolve(false);
        }, 60000);
        pendingCmdApprovals.set(approvalId, { resolve, timer });
      });

      if (!approved) {
        results.push(`[tool:run_cmd] ⛔ Command rejected or timed out: \`${cmd}\``);
        continue;
      }
      console.log(`[${agentId}] ✅ cmd approved, executing: ${cmd}`);
    }

    try {
      const { execSync } = await import("node:child_process");
      const out = execSync(cmd, { timeout: 15000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      results.push(`[tool:run_cmd] ✅ $ ${cmd}\n${out.slice(0, 2000)}`);
    } catch (err) {
      results.push(`[tool:run_cmd] ❌ $ ${cmd}\n${err.message}`);
    }
  }

  // ── @@WEB_SEARCH ──────────────────────────────────────────────────────────
  // Uses Perplexity sonar (web-grounded LLM) as primary, falls back to Brave
  const webSearchRe = /@@WEB_SEARCH[ \t]+([^\n]+)/g;
  while ((m = webSearchRe.exec(reply)) !== null) {
    if (!allowed.has('web_search')) {
      results.push(`[tool:web_search] ⛔ ${agentId} does not have web_search permission`);
      continue;
    }
    const query = m[1].trim();
    try {
      // ── Try Perplexity sonar first (web-grounded, accurate results) ──
      const perplexityKey = (() => {
        try {
          const cfg = JSON.parse(fs.readFileSync(path.join(CREWSWARM_DIR, "crewswarm.json"), "utf8"));
          return cfg?.providers?.perplexity?.apiKey || null;
        } catch { return null; }
      })();

      if (perplexityKey) {
        const pRes = await fetch("https://api.perplexity.ai/chat/completions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${perplexityKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "sonar",
            messages: [{ role: "user", content: `Search the web and return accurate, detailed results for: ${query}\n\nInclude: key facts, URLs of official sources, pricing if relevant, and any important technical details. Be specific and factual.` }],
            max_tokens: 1024,
          }),
          signal: AbortSignal.timeout(20000),
        });
        if (pRes.ok) {
          const pData = await pRes.json();
          const answer = pData.choices?.[0]?.message?.content || "";
          const citations = (pData.citations || []).map((u, i) => `[${i+1}] ${u}`).join("\n");
          const out = answer + (citations ? `\n\nSources:\n${citations}` : "");
          results.push(`[tool:web_search] 🔍 Results for "${query}":\n${out}`);
          console.log(`[${agentId}] web_search (perplexity): "${query}" → ${answer.length} chars`);
          continue;
        }
      }

      // ── Fallback: Brave search ──
      const braveKey = (() => {
        const stPaths = [
          path.join(CREWSWARM_DIR, "search-tools.json"),
          path.join(LEGACY_STATE_DIR, "search-tools.json"),
        ];
        for (const p of stPaths) {
          try { return JSON.parse(fs.readFileSync(p, "utf8"))?.brave?.apiKey; } catch {}
        }
        return process.env.BRAVE_API_KEY || null;
      })();
      if (!braveKey) {
        results.push(`[tool:web_search] ❌ No search provider available (no Perplexity or Brave key)`);
        continue;
      }
      const res = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&text_decorations=false`,
        { headers: { Accept: "application/json", "X-Subscription-Token": braveKey }, signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) {
        results.push(`[tool:web_search] ❌ Brave API error ${res.status} for: ${query}`);
        continue;
      }
      const data = await res.json();
      const hits = (data.web?.results || []).slice(0, 5);
      if (!hits.length) {
        results.push(`[tool:web_search] ℹ️ No results for: ${query}`);
        continue;
      }
      const formatted = hits.map((r, i) =>
        `${i + 1}. **${r.title}** — ${r.url}\n   ${r.description || ""}`
      ).join("\n");
      results.push(`[tool:web_search] 🔍 Results for "${query}":\n${formatted}`);
      console.log(`[${agentId}] web_search (brave): "${query}" → ${hits.length} results`);
    } catch (err) {
      results.push(`[tool:web_search] ❌ Search failed: ${err.message}`);
    }
  }

  // ── @@WEB_FETCH ───────────────────────────────────────────────────────────
  const webFetchRe = /@@WEB_FETCH[ \t]+(https?:\/\/[^\n]+)/g;
  while ((m = webFetchRe.exec(reply)) !== null) {
    if (!allowed.has('web_fetch')) {
      results.push(`[tool:web_fetch] ⛔ ${agentId} does not have web_fetch permission`);
      continue;
    }
    const url = m[1].trim();
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "CrewSwarm/1.0 (agent fetch)" },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) {
        results.push(`[tool:web_fetch] ❌ HTTP ${res.status} fetching: ${url}`);
        continue;
      }
      const ct = res.headers.get("content-type") || "";
      let text = await res.text();
      // Strip HTML tags to extract readable text
      if (ct.includes("html")) {
        text = text
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s{2,}/g, " ")
          .trim();
      }
      const snippet = text.length > 8000 ? text.slice(0, 8000) + "\n...[truncated]" : text;
      results.push(`[tool:web_fetch] 🌐 ${url} (${text.length} chars):\n${snippet}`);
      console.log(`[${agentId}] web_fetch: ${url} → ${text.length} chars`);
    } catch (err) {
      results.push(`[tool:web_fetch] ❌ Fetch failed for ${url}: ${err.message}`);
    }
  }

  // ── @@TELEGRAM ────────────────────────────────────────────────────────────
  // Supports: @@TELEGRAM message  (default chat) or @@TELEGRAM @Name message  (contact by name)
  const telegramRe = /@@TELEGRAM[ \t]+([^\n]+)/g;
  while ((m = telegramRe.exec(reply)) !== null) {
    if (!allowed.has('telegram')) {
      results.push(`[tool:telegram] ⛔ ${agentId} does not have telegram permission`);
      continue;
    }
    let message = m[1].trim();
    try {
      const cfg = resolveConfig();
      const tgBridge = resolveTelegramBridgeConfig();
      const botToken = process.env.TELEGRAM_BOT_TOKEN || cfg?.env?.TELEGRAM_BOT_TOKEN || cfg?.TELEGRAM_BOT_TOKEN || tgBridge.token || "";
      let chatId = process.env.TELEGRAM_CHAT_ID || cfg?.env?.TELEGRAM_CHAT_ID || cfg?.TELEGRAM_CHAT_ID
        || (Array.isArray(tgBridge.allowedChatIds) && tgBridge.allowedChatIds.length ? String(tgBridge.allowedChatIds[0]) : "")
        || tgBridge.defaultChatId || "";
      const contactNames = tgBridge.contactNames || {};
      const atNameMatch = message.match(/^@(\S+)\s+(.*)$/s);
      if (atNameMatch) {
        const name = atNameMatch[1];
        message = atNameMatch[2].trim();
        const nameLower = name.toLowerCase();
        const found = Object.entries(contactNames).find(([, v]) => (v || "").toLowerCase() === nameLower);
        if (found) chatId = found[0];
        else {
          results.push(`[tool:telegram] ❌ No contact named "${name}" in Settings → Telegram → Contact names`);
          continue;
        }
      }
      chatId = chatId.trim();
      if (!botToken || !chatId) {
        results.push(`[tool:telegram] ❌ TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set in env, ~/.crewswarm/config.json, or ~/.crewswarm/telegram-bridge.json (token + allowedChatIds or defaultChatId)`);
        continue;
      }
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: `[${agentId}] ${message}`, parse_mode: "Markdown" }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      if (!data.ok) {
        results.push(`[tool:telegram] ❌ Telegram error: ${data.description}`);
      } else {
        results.push(`[tool:telegram] ✅ Sent: ${message.slice(0, 80)}${message.length > 80 ? "…" : ""}`);
        console.log(`[${agentId}] telegram: sent message`);
      }
    } catch (err) {
      results.push(`[tool:telegram] ❌ Send failed: ${err.message}`);
    }
  }

  // ── @@SKILL ───────────────────────────────────────────────────────────────
  // Format: @@SKILL skillname {"param":"value"}
  const skillRe = /@@SKILL[ \t]+([a-zA-Z0-9_\-\.]+)[ \t]*(\{[^\n]*\})?/g;
  while ((m = skillRe.exec(reply)) !== null) {
    if (!allowed.has('skill')) {
      results.push(`[tool:skill] ⛔ ${agentId} does not have skill permission`);
      continue;
    }
    const skillName = m[1].trim();
    let params = {};
    if (m[2]) {
      try { params = JSON.parse(m[2]); } catch { results.push(`[tool:skill] ❌ ${skillName}: bad JSON params — ${m[2].slice(0, 100)}`); continue; }
    }
    const skillDef = loadSkillDef(skillName);
    if (!skillDef) {
      results.push(`[tool:skill] ❌ Skill "${skillName}" not found in ${SKILLS_DIR}`);
      continue;
    }
    // Merge defaults
    const merged = { ...(skillDef.defaultParams || {}), ...params };
    // Check requiresApproval
    if (skillDef.requiresApproval) {
      const crypto = await import("crypto");
      const approvalId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36);
      const pending = loadPendingSkills();
      pending[approvalId] = { agentId, skillName, params: merged, skillDef, createdAt: Date.now() };
      savePendingSkills(pending);
      await notifyTelegramSkillApproval(agentId, skillName, merged, approvalId);
      results.push(`[tool:skill] 🔔 "${skillName}" requires approval. Approval ID: ${approvalId}. Approve via POST /api/skills/approve {"approvalId":"${approvalId}"} or Telegram.`);
      console.log(`[${agentId}] skill:${skillName} awaiting approval (${approvalId})`);
      continue;
    }
    try {
      console.log(`[${agentId}] skill:${skillName} → ${skillDef.url?.slice(0, 60)}`);
      const result = await executeSkill(skillDef, merged);
      let preview;
      const isBenchmark = skillName === "zeroeval.benchmark" || skillName === "benchmark" || skillName === "benchmarks";
      if (isBenchmark && Array.isArray(result) && result.length) {
        const list = result.slice(0, 30).map(b => typeof b === "object" ? b.benchmark_id : b).join(", ");
        preview = `${result.length} benchmarks (sample): ${list}${result.length > 30 ? ` … +${result.length - 30} more` : ""}`;
      } else if (isBenchmark && result?.models?.length) {
        const top = result.models.slice(0, 5).map(m => `${m.model_name}: ${((m.normalized_score ?? m.score ?? 0) * 100).toFixed(1)}%`);
        preview = `${result.name || "Benchmark"} — top 5: ${top.join("; ")}`;
      } else {
        preview = typeof result === "string" ? result : JSON.stringify(result);
        if (preview.length > 400) preview = preview.slice(0, 400) + "…";
      }
      results.push(`[tool:skill] ✅ ${skillName}: ${preview}`);
    } catch (err) {
      results.push(`[tool:skill] ❌ ${skillName} failed: ${err.message.slice(0, 200)}`);
      console.error(`[${agentId}] skill:${skillName} error: ${err.message}`);
    }
  }

  // ── @@DEFINE_SKILL ────────────────────────────────────────────────────────
  // Format: @@DEFINE_SKILL skillname\n{json}\n@@END_SKILL
  const defineSkillRe = /@@DEFINE_SKILL[ \t]+([a-zA-Z0-9_\-\.]+)\n([\s\S]*?)@@END_SKILL/g;
  while ((m = defineSkillRe.exec(reply)) !== null) {
    if (!allowed.has('define_skill')) {
      results.push(`[tool:define_skill] ⛔ ${agentId} does not have define_skill permission`);
      continue;
    }
    const skillName = m[1].trim();
    const rawJson   = m[2].trim();
    let def;
    try { def = JSON.parse(rawJson); } catch(e) {
      results.push(`[tool:define_skill] ❌ ${skillName}: invalid JSON — ${e.message}`);
      continue;
    }
    try {
      fs.mkdirSync(SKILLS_DIR, { recursive: true });
      const outPath = path.join(SKILLS_DIR, skillName + ".json");
      fs.writeFileSync(outPath, JSON.stringify(def, null, 2), "utf8");
      results.push(`[tool:define_skill] ✅ Skill "${skillName}" saved to ${outPath}`);
      console.log(`[${agentId}] define_skill:${skillName} → ${outPath}`);
    } catch(e) {
      results.push(`[tool:define_skill] ❌ Failed to save skill "${skillName}": ${e.message}`);
    }
  }

  return results;
}

// Coding tool IDs — agents whose role defaults include write_file are considered
// "coding" roles and default to useOpenCode=true when no explicit config is set.
const OPENCODE_CODING_TOOLS = new Set(["write_file"]);

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
  const loop = cfg?.opencodeLoop === true || process.env.OPENCREW_OPENCODE_LOOP === "1";
  const cursorCliModel = cfg?.cursorCliModel || null; // separate model for Cursor CLI vs OpenCode
  if (!cfg) return { enabled: agentDefaultsToOpenCode(agentId), model: null, fallbackModel: fallback, loop: false, useCursorCli: false, cursorCliModel: null };
  if (cfg.useOpenCode === true) return { enabled: true, model: cfg.opencodeModel || null, fallbackModel: fallback, loop, useCursorCli: cfg.useCursorCli === true, cursorCliModel };
  if (cfg.useOpenCode === false) return { enabled: false, model: null, fallbackModel: fallback, loop: false, useCursorCli: cfg.useCursorCli === true, cursorCliModel };
  return { enabled: agentDefaultsToOpenCode(agentId), model: cfg.opencodeModel || null, fallbackModel: fallback, loop, useCursorCli: cfg.useCursorCli === true, cursorCliModel };
}

function shouldUseCursorCli(payload, incomingType) {
  if (incomingType !== "command.run_task" && incomingType !== "task.assigned") return false;
  const runtime = String(payload?.runtime || payload?.executor || "").toLowerCase();
  if (runtime === "cursor" || runtime === "cursor-cli") return true;
  if (payload?.useCursorCli === true) return true;
  const agentId = String(payload?.agentId || payload?.agent || OPENCREW_RT_AGENT || "").toLowerCase();
  // crew-orchestrator always runs through Cursor CLI — it IS a Cursor subagent orchestrator
  if (agentId === "crew-orchestrator" || agentId === "orchestrator") return CREWSWARM_CURSOR_WAVES;
  return getAgentOpenCodeConfig(agentId).useCursorCli === true;
}

function shouldUseClaudeCode(payload, incomingType) {
  if (incomingType !== "command.run_task" && incomingType !== "task.assigned") return false;
  // Cursor CLI always takes priority over Claude Code
  if (shouldUseCursorCli(payload, incomingType)) return false;
  const runtime = String(payload?.runtime || payload?.executor || "").toLowerCase();
  if (runtime === "claude" || runtime === "claude-code") return true;
  if (payload?.useClaudeCode === true) return true;
  const agentId = String(payload?.agentId || payload?.agent || OPENCREW_RT_AGENT || "").toLowerCase();
  try {
    const agents = loadAgentList();
    const cfg = agents.find(a => a.id === agentId || a.id === `crew-${agentId}`);
    if (cfg?.useClaudeCode === true) return true;
  } catch {}
  return CREWSWARM_CLAUDE_CODE;
}

function shouldUseOpenCode(payload, prompt, incomingType) {
  if (!OPENCREW_OPENCODE_ENABLED) return false;
  if (OPENCREW_OPENCODE_FORCE) return true;
  // Cursor CLI takes precedence when configured — different execution backend
  if (shouldUseCursorCli(payload, incomingType)) return false;

  if (incomingType !== "command.run_task" && incomingType !== "task.assigned") return false;

  // Explicit override via runtime flag or payload hint
  const runtime = String(payload?.runtime || payload?.executor || payload?.engine || "").toLowerCase();
  if (runtime === "opencode" || runtime === "codex" || runtime === "gpt5" || runtime === "gpt-5") return true;
  if (payload?.useOpenCode === true) return true;

  // Config-driven: check crewswarm.json useOpenCode field (or role-based default)
  const agentId = String(payload?.agentId || payload?.agent || OPENCREW_RT_AGENT || "").toLowerCase();
  const ocCfg = getAgentOpenCodeConfig(agentId);
  return ocCfg.enabled;
}

function shouldConnectGateway(args) {
  if (process.env.OPENCREW_FORCE_GATEWAY === "1") return true;
  if (args.includes("--broadcast")) return false;
  if (args[0] === "--send") return false;
  // In RT-daemon mode: skip legacy gateway unless explicitly forced.
  // Agents use direct LLM calls; legacy gateway is optional.
  if (args.includes("--rt-daemon")) {
    if (process.env.OPENCREW_GATEWAY_ENABLED === "1") return true;
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

// ── Cursor CLI backend ─────────────────────────────────────────────────────
// Uses `agent -p --force` (Cursor's headless CLI) instead of OpenCode.
// Advantages: $0 marginal cost (Cursor subscription), full workspace index,
//             semantic search, same models as Cursor GUI.
// Session continuity: `agent --resume=<chatId>` mirrors OpenCode `-s`.
// Session IDs stored in ~/.crewswarm/sessions/<agentId>.cursor-session

// Cursor CLI installs to ~/.local/bin/agent on macOS via curl installer
const CURSOR_CLI_BIN = process.env.CURSOR_CLI_BIN ||
  (fs.existsSync(path.join(os.homedir(), ".local", "bin", "agent"))
    ? path.join(os.homedir(), ".local", "bin", "agent")
    : "agent");
const CURSOR_SESSION_DIR = OPENCODE_SESSION_DIR; // same dir, different extension

function readCursorSessionId(agentId) {
  if (!agentId) return null;
  try {
    const f = path.join(CURSOR_SESSION_DIR, `${agentId}.cursor-session`);
    if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim() || null;
  } catch {}
  return null;
}

function writeCursorSessionId(agentId, chatId) {
  if (!agentId || !chatId) return;
  try {
    fs.mkdirSync(CURSOR_SESSION_DIR, { recursive: true });
    fs.writeFileSync(path.join(CURSOR_SESSION_DIR, `${agentId}.cursor-session`), chatId, "utf8");
  } catch {}
}

function clearCursorSessionId(agentId) {
  if (!agentId) return;
  try {
    const f = path.join(CURSOR_SESSION_DIR, `${agentId}.cursor-session`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch {}
}

// Parse chat ID from `agent ls` output — format: "<chatId>  <title>  <date>"
function parseMostRecentCursorChatId(lsOutput, agentPrefix) {
  for (const line of lsOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("Chat") || trimmed.startsWith("─")) continue;
    const parts = trimmed.split(/\s{2,}/);
    const chatId = parts[0];
    if (!chatId) continue;
    if (agentPrefix) {
      if ((parts[1] || "").includes(agentPrefix)) return chatId;
    } else {
      return chatId;
    }
  }
  return null;
}

async function runCursorCliTask(prompt, payload = {}) {
  // NOTE: Cursor CLI -p (print/headless) has a known bug where the process
  // never exits after completing (reported: cursor.com forum, Feb 2026).
  // Workaround: use --output-format stream-json, detect {"type":"result"}
  // event as the completion signal, capture output, then kill the process.
  return new Promise((resolve, reject) => {
    const agentId = String(payload?.agentId || payload?.agent || OPENCREW_RT_AGENT || "");
    const configuredDir = getOpencodeProjectDir();
    let projectDir = payload?.projectDir || configuredDir || process.cwd();
    projectDir = String(projectDir).replace(/[.,;!?]+$/, "");

    const agentPrefix = agentId ? `[${agentId}]` : "";
    const titledPrompt = agentPrefix ? `${agentPrefix} ${String(prompt)}` : String(prompt);

    // Use stream-json so we can detect completion via {"type":"result"} event
    // and kill the process ourselves (workaround for the no-exit bug).
    const args = ["-p", "--force", "--trust", "--output-format", "stream-json", titledPrompt];

    // Model selection: cursorCliModel takes priority (separate from OpenCode model),
    // then payload override, then subscription default (auto)
    const agentCfg = getAgentOpenCodeConfig(agentId);
    const model = payload?.cursorCliModel || agentCfg.cursorCliModel || payload?.model || null;
    if (model) args.push("--model", model);

    args.push("--workspace", projectDir);

    // Session continuity
    const existingChatId = readCursorSessionId(agentId);
    if (existingChatId) {
      args.push(`--resume=${existingChatId}`);
      console.error(`[CursorCLI:${agentId}] Resuming chat ${existingChatId}`);
    }

    console.error(`[CursorCLI:${agentId}] Running: ${CURSOR_CLI_BIN} -p --force --output-format stream-json (workspace=${projectDir})`);

    _rtClientForApprovals?.publish({ channel: "events", type: "agent_working", to: "broadcast",
      payload: { agent: agentId, model: model || "cursor/auto", ts: Date.now() } });

    const child = spawn(CURSOR_CLI_BIN, args, {
      cwd: projectDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let lineBuffer = "";
    let accumulatedText = "";
    let resultReceived = false;
    let resultChatId = null;

    const hardTimer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!resultReceived) reject(new Error(`CursorCLI timeout after ${OPENCREW_OPENCODE_TIMEOUT_MS}ms`));
    }, OPENCREW_OPENCODE_TIMEOUT_MS);

    function handleLine(line) {
      line = line.trim();
      if (!line) return;
      try {
        const ev = JSON.parse(line);
        // Accumulate text from assistant messages
        if (ev.type === "assistant") {
          const content = ev.message?.content;
          if (Array.isArray(content)) {
            for (const c of content) {
              if (c.type === "text" && c.text) accumulatedText += c.text;
            }
          } else if (typeof content === "string") {
            accumulatedText += content;
          }
        }
        // "result" event = task fully done — kill the process and resolve
        if (ev.type === "result" && !resultReceived) {
          resultReceived = true;
          resultChatId = ev.chatId || null;
          clearTimeout(hardTimer);
          child.kill("SIGTERM");
          const out = accumulatedText.trim() || "(cursor agent completed with no text output)";
          console.log(`[CursorCLI:${agentId}] Done via stream-json result event — ${out.length} chars`);
          _rtClientForApprovals?.publish({ channel: "events", type: "agent_idle", to: "broadcast",
            payload: { agent: agentId, ts: Date.now() } });
          // Persist session ID
          if (agentId && resultChatId) {
            writeCursorSessionId(agentId, resultChatId);
            console.error(`[CursorCLI:${agentId}] Chat session saved: ${resultChatId}`);
          }
          resolve(out);
        }
      } catch {
        // Non-JSON line (Ink UI escape codes etc.) — ignore
      }
    }

    child.stdout.on("data", (d) => {
      lineBuffer += d.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop(); // keep incomplete last line in buffer
      lines.forEach(handleLine);
    });
    child.stderr.on("data", (d) => {
      // stderr is usually Ink rendering noise — only log for debugging
      const s = d.toString().trim();
      if (s && !s.startsWith("\x1b")) console.error(`[CursorCLI:${agentId}] stderr: ${s.slice(0, 120)}`);
    });

    child.on("error", (err) => {
      clearTimeout(hardTimer);
      if (!resultReceived) reject(err);
    });

    child.on("close", () => {
      clearTimeout(hardTimer);
      // If we already resolved via result event, nothing to do.
      // If not (process died without result), reject.
      if (!resultReceived) {
        reject(new Error(`CursorCLI exited without a result event. Output so far: ${accumulatedText.slice(0, 300)}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Claude Code backend
// Uses `claude -p --dangerously-skip-permissions --output-format stream-json`
// Requires ANTHROPIC_API_KEY. Session continuity via --resume <sessionId>.
// Subagents defined in .claude/agents/*.md (same YAML format as .cursor/agents/).
// ---------------------------------------------------------------------------

const CLAUDE_CODE_BIN = process.env.CLAUDE_CODE_BIN || "claude";
const CLAUDE_SESSION_DIR = OPENCODE_SESSION_DIR; // ~/.crewswarm/sessions/

function readClaudeSessionId(agentId) {
  if (!agentId) return null;
  try {
    const f = path.join(CLAUDE_SESSION_DIR, `${agentId}.claude-session`);
    if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim() || null;
  } catch {}
  return null;
}

function writeClaudeSessionId(agentId, sessionId) {
  if (!agentId || !sessionId) return;
  try {
    fs.mkdirSync(CLAUDE_SESSION_DIR, { recursive: true });
    fs.writeFileSync(path.join(CLAUDE_SESSION_DIR, `${agentId}.claude-session`), sessionId, "utf8");
  } catch {}
}

function clearClaudeSessionId(agentId) {
  if (!agentId) return;
  try {
    const f = path.join(CLAUDE_SESSION_DIR, `${agentId}.claude-session`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch {}
}

async function runClaudeCodeTask(prompt, payload = {}) {
  // Claude Code CLI: `claude -p --dangerously-skip-permissions --output-format stream-json`
  // stream-json emits newline-delimited events; we accumulate text from content_block_delta
  // events and resolve on the {"type":"result"} event (same pattern as runCursorCliTask).
  return new Promise((resolve, reject) => {
    const agentId = String(payload?.agentId || payload?.agent || OPENCREW_RT_AGENT || "");
    const configuredDir = getOpencodeProjectDir();
    let projectDir = payload?.projectDir || configuredDir || process.cwd();
    projectDir = String(projectDir).replace(/[.,;!?]+$/, "");

    // Prefix prompt with agent identity so Claude knows its role in the crew
    const agentPrefix = agentId ? `[${agentId}]` : "";
    const titledPrompt = agentPrefix ? `${agentPrefix} ${String(prompt)}` : String(prompt);

    const args = [
      "-p",
      "--dangerously-skip-permissions",
      "--output-format", "stream-json",
    ];

    // Model override (claude-code supports --model claude-opus-4-5 etc.)
    const agentCfg = getAgentOpenCodeConfig(agentId);
    const model = payload?.claudeCodeModel || agentCfg.claudeCodeModel || payload?.model || null;
    if (model && !model.includes("/")) {
      // Only pass bare model names (e.g. claude-sonnet-4-5), not provider/model strings
      args.push("--model", model);
    }

    // Session continuity: resume previous session for this agent
    const existingSession = readClaudeSessionId(agentId);
    if (existingSession) {
      args.push("--resume", existingSession);
      console.error(`[ClaudeCode:${agentId}] Resuming session ${existingSession}`);
    }

    args.push(titledPrompt);

    console.error(`[ClaudeCode:${agentId}] Running: ${CLAUDE_CODE_BIN} -p --dangerously-skip-permissions (cwd=${projectDir})`);

    _rtClientForApprovals?.publish({ channel: "events", type: "agent_working", to: "broadcast",
      payload: { agent: agentId, model: model || "claude/auto", ts: Date.now() } });

    const child = spawn(CLAUDE_CODE_BIN, args, {
      cwd: projectDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let lineBuffer = "";
    let accumulatedText = "";
    let resultReceived = false;
    let resultSessionId = null;

    const hardTimer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!resultReceived) reject(new Error(`ClaudeCode timeout after ${OPENCREW_OPENCODE_TIMEOUT_MS}ms`));
    }, OPENCREW_OPENCODE_TIMEOUT_MS);

    function handleLine(line) {
      line = line.trim();
      if (!line) return;
      try {
        const ev = JSON.parse(line);

        // stream-json text delta: {"type":"stream_event","event":{"type":"content_block_delta",...}}
        if (ev.type === "stream_event") {
          const inner = ev.event;
          if (inner?.type === "content_block_delta" && inner?.delta?.type === "text_delta") {
            accumulatedText += inner.delta.text || "";
          }
        }

        // assistant message (non-streaming path)
        if (ev.type === "assistant") {
          const content = ev.message?.content;
          if (Array.isArray(content)) {
            for (const c of content) {
              if (c.type === "text" && c.text) accumulatedText += c.text;
            }
          } else if (typeof content === "string") {
            accumulatedText += content;
          }
        }

        // {"type":"result"} — task done
        if (ev.type === "result" && !resultReceived) {
          resultReceived = true;
          // Claude Code returns session_id in the result event
          resultSessionId = ev.session_id || ev.sessionId || ev.chatId || null;
          clearTimeout(hardTimer);
          child.kill("SIGTERM");
          // Prefer ev.result (plain text summary) over accumulated streaming text
          const out = (ev.result || accumulatedText).trim() || "(claude code completed with no text output)";
          console.log(`[ClaudeCode:${agentId}] Done — ${out.length} chars`);
          _rtClientForApprovals?.publish({ channel: "events", type: "agent_idle", to: "broadcast",
            payload: { agent: agentId, ts: Date.now() } });
          if (agentId && resultSessionId) {
            writeClaudeSessionId(agentId, resultSessionId);
            console.error(`[ClaudeCode:${agentId}] Session saved: ${resultSessionId}`);
          }
          resolve(out);
        }
      } catch {
        // Non-JSON stderr noise — ignore
      }
    }

    child.stdout.on("data", (d) => {
      lineBuffer += d.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop();
      lines.forEach(handleLine);
    });
    child.stderr.on("data", (d) => {
      const s = d.toString().trim();
      if (s && !s.startsWith("\x1b")) console.error(`[ClaudeCode:${agentId}] stderr: ${s.slice(0, 160)}`);
    });
    child.on("error", (err) => {
      clearTimeout(hardTimer);
      if (!resultReceived) reject(err);
    });
    child.on("close", () => {
      clearTimeout(hardTimer);
      if (!resultReceived) {
        reject(new Error(`ClaudeCode exited without a result event. Output so far: ${accumulatedText.slice(0, 300)}`));
      }
    });
  });
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

function runOpenCodeTask(prompt, payload = {}) {
  return new Promise((resolve, reject) => {
    const bin = fs.existsSync(OPENCREW_OPENCODE_BIN) ? OPENCREW_OPENCODE_BIN : "opencode";
    // Model priority: explicit payload > per-agent opencodeModel > global default
    const agentId = String(payload?.agentId || payload?.agent || OPENCREW_RT_AGENT || "");
    const agentOcCfg = getAgentOpenCodeConfig(agentId);
    const model = String(payload?.model || agentOcCfg.model || OPENCREW_OPENCODE_MODEL);
    const OC_AGENT_MAP = {
      "crew-coder":       "coder",
      "crew-coder-front": "coder-front",
      "crew-coder-back":  "coder-back",
      "crew-fixer":       "fixer",
      "crew-frontend":    "frontend",
      "crew-qa":          "qa",
      "crew-security":    "security",
      "crew-pm":          "pm",
    };
    const ocAgentName = OC_AGENT_MAP[agentId] || payload?.agent || OPENCREW_OPENCODE_AGENT || "admin";
    const agent = String(ocAgentName).trim();
    const configuredDir = getOpencodeProjectDir();
    let projectDir = payload?.projectDir || configuredDir || null;
    // Only fall through to task-text extraction when NO dir is configured at all.
    // Avoid when configuredDir === process.cwd() — extractProjectDirFromTask can
    // pick up sentence-ending periods (e.g. "…/CrewSwarm.") producing an invalid cwd.
    if (!projectDir) {
      const fromTask = extractProjectDirFromTask(prompt);
      if (fromTask) projectDir = fromTask;
    }
    // Strip trailing punctuation that sentence parsing may have attached to the path.
    projectDir = String(projectDir || process.cwd()).replace(/[.,;!?]+$/, "");
    if (!payload?.projectDir && !configuredDir && projectDir === process.cwd()) {
      console.warn(`[OpenCode] No project dir configured — writing to cwd (${process.cwd()}). Set one in Dashboard → Settings → OpenCode Project Directory.`);
    }
    const agentPrefix = agentId ? `[${agentId}] ` : "";
    const titledPrompt = agentPrefix + String(prompt);
    // Omit --dir to avoid triggering opencode's rg (ripgrep) spawn without stdin:ignore
    // (opencode bug: rg hangs waiting for stdin when --dir is passed — PR pending).
    // cwd on the spawn call below sets the working directory equivalently.
    const args = ["run", titledPrompt, "--model", model];
    if (agent) args.push("--agent", agent);

    // Session continuity: reuse the agent's last session so it remembers previous work
    const existingSessionId = readAgentSessionId(agentId);
    if (existingSessionId) {
      args.push("--session", existingSessionId);
      console.error(`[OpenCode] Continuing session ${existingSessionId} for ${agentId}`);
    }

    console.error(`[OpenCode] Running: ${bin} run [prompt] --model ${model} (cwd=${projectDir})`);

    const cleanEnv = { ...process.env };
    delete cleanEnv.OPENCODE_SERVER_USERNAME;
    delete cleanEnv.OPENCODE_SERVER_PASSWORD;
    delete cleanEnv.OPENCODE_CLIENT;
    delete cleanEnv.OPENCODE;

    // Helper: restart opencode serve if it's not responding (causes ENOENT on spawn)
    async function ensureOpencodeServe() {
      try {
        const r = await fetch("http://127.0.0.1:4096/", { signal: AbortSignal.timeout(2000) }).catch(() => null);
        if (r && r.ok) return; // serve is healthy
      } catch {}
      // Serve is down — kill any stale instance and restart
      console.warn("[OpenCode] serve not responding — restarting...");
      try { spawn("pkill", ["-f", "opencode serve"], { stdio: "ignore" }); } catch {}
      await new Promise(r => setTimeout(r, 1500));
      const serveProc = spawn(bin, ["serve", "--port", "4096", "--hostname", "127.0.0.1"], {
        detached: true, stdio: "ignore", env: cleanEnv,
      });
      serveProc.unref();
      await new Promise(r => setTimeout(r, 3000)); // wait for serve to be ready
      console.warn("[OpenCode] serve restarted");
    }

    const child = spawn(bin, args, {
      cwd: projectDir,
      env: cleanEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let lastProgressAt = Date.now();
    const agentLabel = agentId || OPENCREW_RT_AGENT || "opencode";

    // Emit agent_working event so dashboard + SwiftBar can show live indicator
    _rtClientForApprovals?.publish({ channel: "events", type: "agent_working", to: "broadcast", payload: { agent: agentLabel, model, ts: Date.now() } });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`OpenCode timeout after ${OPENCREW_OPENCODE_TIMEOUT_MS}ms`));
    }, OPENCREW_OPENCODE_TIMEOUT_MS);

    // Stream progress to log and RT bus so you can watch it live
    child.stdout.on("data", (d) => {
      const chunk = d.toString("utf8");
      stdout += chunk;
      lastProgressAt = Date.now();
      const lines = chunk.split("\n").map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        console.log(`[OpenCode:${agentLabel}] ${line}`);
      }
    });
    // Lines from OpenCode stderr that are known-harmless and must NOT be returned
    // as task output or logged as errors — they would poison agent conversation history.
    const OC_NOISE_PATTERNS = [
      /realtime\s+daemon\s+error/i,
      /invalid\s+realtime\s+token/i,
      /realtime\s+error:/i,
      /ExperimentalWarning/i,
      /--experimental/i,
    ];
    const isOcNoise = (line) => OC_NOISE_PATTERNS.some(p => p.test(line));

    child.stderr.on("data", (d) => {
      const chunk = d.toString("utf8");
      lastProgressAt = Date.now();
      const lines = chunk.split("\n").map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        if (isOcNoise(line)) continue; // swallow — don't accumulate, don't log
        stderr += line + "\n";
        console.log(`[OpenCode:${agentLabel}] ${line}`);
      }
    });
    // Stall detector — kill and reject if no output for too long so fallback can kick in
    const STALL_TIMEOUT_MS = 180_000;
    const stallCheck = setInterval(() => {
      const stalledMs = Date.now() - lastProgressAt;
      if (stalledMs > STALL_TIMEOUT_MS) {
        clearTimeout(timer);
        clearInterval(stallCheck);
        child.kill("SIGTERM");
        console.warn(`[OpenCode:${agentLabel}] No output for ${Math.round(stalledMs/1000)}s — killing and triggering fallback`);
        _rtClientForApprovals?.publish({ channel: "events", type: "agent_idle", to: "broadcast", payload: { agent: agentLabel, stalled: true, ts: Date.now() } });
        reject(new Error(`OpenCode stalled (no output for ${Math.round(stalledMs/1000)}s)`));
      } else if (stalledMs > 60000) {
        console.warn(`[OpenCode:${agentLabel}] No output for ${Math.round(stalledMs/1000)}s — may be stalled`);
      }
    }, 30000);
    child.on("error", (err) => {
      clearTimeout(timer);
      clearInterval(stallCheck);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearInterval(stallCheck);
      // stdout is the actual task reply; stderr (already noise-filtered above) is diagnostics only.
      // Never let stderr noise (realtime token errors etc.) become the returned output.
      const out = (stdout || stderr || "").trim();
      if (code !== 0) {
        // If the only non-empty output is noise that slipped through, treat as unknown error
        const cleanOut = out.replace(/• ?(realtime daemon error|invalid realtime token)[^\n]*/gi, "").trim();
        const bannerOnly = isOpencodeRateLimitBanner(cleanOut || out);
        if (bannerOnly) {
          console.warn(`[OpenCode:${agentLabel}] Rate limit detected (banner-only exit null) — will rotate model`);
          reject(new Error(`OpenCode rate limited (banner-only): ${model}`));
        } else {
          const errMsg = cleanOut || "unknown error (possibly realtime token noise — task may have succeeded)";
          console.error(`[OpenCode:${agentLabel}] Failed (exit ${code}): ${errMsg.slice(0, 300)}`);
          reject(new Error(`OpenCode exited ${code}: ${errMsg}`));
        }
        return;
      }
      console.log(`[OpenCode:${agentLabel}] Done — ${out.length} chars output`);
      _rtClientForApprovals?.publish({ channel: "events", type: "agent_idle", to: "broadcast", payload: { agent: agentLabel, ts: Date.now() } });

      // Persist the session ID for this agent so the next task continues from here.
      // Filter by agentPrefix (e.g. "[crew-coder]") so parallel agents don't steal
      // each other's most-recent session when finishing at the same time.
      if (agentId) {
        try {
          const listOut = execFileSync(bin, ["session", "list"], {
            cwd: projectDir, env: cleanEnv, timeout: 8000, encoding: "utf8",
          });
          const prefix = agentId ? `[${agentId}]` : null;
          const newSessionId = parseMostRecentSessionId(listOut, prefix);
          if (newSessionId) {
            writeAgentSessionId(agentId, newSessionId);
            console.error(`[OpenCode:${agentLabel}] Session saved: ${newSessionId}`);
          } else {
            console.warn(`[OpenCode:${agentLabel}] No matching session found for prefix "${prefix}" — session not saved`);
          }
        } catch (sessErr) {
          console.warn(`[OpenCode:${agentLabel}] Could not save session: ${sessErr.message}`);
        }
      }

      resolve(out || "(opencode completed with no output)");
    });
  });
}

function ensureSwarmRuntimeDirs() {
  fs.mkdirSync(SWARM_RUNTIME_DIR, { recursive: true });
  fs.mkdirSync(SWARM_TASK_LEASE_DIR, { recursive: true });
  fs.mkdirSync(SWARM_TASK_STATE_DIR, { recursive: true });
  fs.mkdirSync(SWARM_DLQ_DIR, { recursive: true });
}

function parseTaskState(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return parseJsonSafe(raw, null);
  } catch {
    return null;
  }
}

function taskIdentity({ envelope, payload, incomingType, prompt }) {
  const explicit = String(payload?.idempotencyKey || payload?.idempotency_key || payload?.dedupeKey || "").trim();
  if (explicit) return explicit;
  const taskId = String(envelope?.taskId || "").trim();
  if (taskId) return `${incomingType}:${taskId}`;
  const envelopeId = String(envelope?.id || "").trim();
  if (envelopeId) return `${incomingType}:${envelopeId}`;
  const base = JSON.stringify({
    incomingType,
    from: envelope?.from || "unknown",
    prompt: String(prompt || "").slice(0, 2000),
  });
  return `hash:${crypto.createHash("sha256").update(base).digest("hex")}`;
}

function taskKeyFor(identity) {
  return crypto.createHash("sha256").update(String(identity)).digest("hex");
}

function leasePath(taskKey) {
  return path.join(SWARM_TASK_LEASE_DIR, `${taskKey}.json`);
}

function taskStatePath(taskKey) {
  return path.join(SWARM_TASK_STATE_DIR, `${taskKey}.json`);
}

function lockPath(taskKey) {
  return path.join(SWARM_TASK_LEASE_DIR, `${taskKey}.lock`);
}

async function withTaskLock(taskKey, fn) {
  ensureSwarmRuntimeDirs();
  const file = lockPath(taskKey);
  const deadline = Date.now() + Math.max(200, OPENCREW_RT_DISPATCH_HEARTBEAT_MS);
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(file, "wx");
      try {
        return await fn();
      } finally {
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(file); } catch {}
      }
    } catch (err) {
      lastErr = err;
      if (err?.code !== "EEXIST") throw err;
      await sleep(40);
    }
  }
  throw new Error(`task lock timeout for ${taskKey}: ${lastErr?.message || "unknown"}`);
}

function clearStaleTaskState() {
  try {
    ensureSwarmRuntimeDirs();
    const now = Date.now();
    for (const fileName of fs.readdirSync(SWARM_TASK_STATE_DIR)) {
      if (!fileName.endsWith(".json")) continue;
      const fullPath = path.join(SWARM_TASK_STATE_DIR, fileName);
      const row = parseTaskState(fullPath);
      if (!row) continue;
      const ts = Date.parse(String(row.completedAt || row.updatedAt || ""));
      if (!Number.isFinite(ts)) continue;
      if (now - ts > OPENCREW_RT_TASK_STATE_TTL_MS) {
        try { fs.unlinkSync(fullPath); } catch {}
      }
    }
  } catch {}
}

async function claimTaskLease({ taskKey, identity, incomingType, envelope, payload }) {
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  return withTaskLock(taskKey, async () => {
    clearStaleTaskState();
    const stateFile = taskStatePath(taskKey);
    const existingState = parseTaskState(stateFile);
    if (existingState?.status === "done") {
      return {
        status: "already_done",
        owner: existingState.owner || "unknown",
      };
    }

    const leaseFile = leasePath(taskKey);
    const existingLease = parseTaskState(leaseFile) || {};
    const leaseExpiresAtMs = Date.parse(String(existingLease.leaseExpiresAt || ""));
    const leaseActive = Number.isFinite(leaseExpiresAtMs) && leaseExpiresAtMs > nowMs;
    if (leaseActive && existingLease.owner && existingLease.owner !== OPENCREW_RT_AGENT) {
      return {
        status: "claimed_by_other",
        owner: existingLease.owner,
        leaseExpiresAt: existingLease.leaseExpiresAt,
      };
    }

    const previousAttempts = Number(existingLease.attempt || payload?.retryCount || 0);
    const attempt = leaseActive && existingLease.owner === OPENCREW_RT_AGENT
      ? Math.max(1, previousAttempts)
      : previousAttempts + 1;

    const leaseRecord = {
      taskKey,
      identity,
      incomingType,
      owner: OPENCREW_RT_AGENT,
      source: envelope?.from || "unknown",
      attempt,
      taskId: envelope?.taskId || "",
      messageId: envelope?.id || "",
      claimedAt: nowIso,
      heartbeatAt: nowIso,
      leaseExpiresAt: new Date(nowMs + OPENCREW_RT_DISPATCH_LEASE_MS).toISOString(),
    };
    fs.writeFileSync(leaseFile, `${JSON.stringify(leaseRecord, null, 2)}\n`, "utf8");
    telemetry("realtime_task_claimed", {
      taskKey,
      identity,
      attempt,
      incomingType,
      owner: OPENCREW_RT_AGENT,
    });
    return {
      status: "claimed",
      attempt,
      lease: leaseRecord,
    };
  });
}

function startTaskLeaseHeartbeat(taskKey) {
  return setInterval(async () => {
    try {
      await withTaskLock(taskKey, async () => {
        const leaseFile = leasePath(taskKey);
        const existingLease = parseTaskState(leaseFile);
        if (!existingLease || existingLease.owner !== OPENCREW_RT_AGENT) return;
        const nowMs = Date.now();
        existingLease.heartbeatAt = new Date(nowMs).toISOString();
        existingLease.leaseExpiresAt = new Date(nowMs + OPENCREW_RT_DISPATCH_LEASE_MS).toISOString();
        fs.writeFileSync(leaseFile, `${JSON.stringify(existingLease, null, 2)}\n`, "utf8");
      });
    } catch (err) {
      telemetry("realtime_task_heartbeat_error", { taskKey, message: err?.message ?? String(err) });
    }
  }, Math.max(1000, OPENCREW_RT_DISPATCH_HEARTBEAT_MS));
}

async function finalizeTaskState({ taskKey, identity, status, attempt, error = "", note = "" }) {
  const completedAt = new Date().toISOString();
  await withTaskLock(taskKey, async () => {
    const stateFile = taskStatePath(taskKey);
    const leaseFile = leasePath(taskKey);
    const state = {
      taskKey,
      identity,
      status,
      owner: OPENCREW_RT_AGENT,
      attempt,
      error,
      note,
      completedAt,
      updatedAt: completedAt,
    };
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    try { fs.unlinkSync(leaseFile); } catch {}
  });
}

async function releaseRuntimeTaskLease(taskKey) {
  await withTaskLock(taskKey, async () => {
    const leaseFile = leasePath(taskKey);
    const lease = parseTaskState(leaseFile);
    if (!lease || lease.owner !== OPENCREW_RT_AGENT) return;
    lease.leaseExpiresAt = new Date(Date.now() - 1).toISOString();
    lease.releasedAt = new Date().toISOString();
    fs.writeFileSync(leaseFile, `${JSON.stringify(lease, null, 2)}\n`, "utf8");
  });
}

function agentRuntimeDir() {
  const dir = path.join(STATE_DIR, "rt-agents");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function agentPidPath(agent) {
  return path.join(agentRuntimeDir(), `${agent}.pid`);
}

function agentLogPath(agent) {
  return path.join(agentRuntimeDir(), `${agent}.log`);
}

function readPid(agent) {
  try {
    return Number(fs.readFileSync(agentPidPath(agent), "utf8").trim());
  } catch {
    return 0;
  }
}

function isPidAlive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isAgentDaemonRunning(agent) {
  const heartbeatAge = latestHeartbeatAgeSec(agent);
  if (heartbeatAge !== null && heartbeatAge <= SWARM_HEARTBEAT_WINDOW_SEC) return true;
  const pid = readPid(agent);
  if (isPidAlive(pid)) return true;
  return false;
}

function latestHeartbeatAgeSec(agent) {
  try {
    if (!fs.existsSync(SWARM_STATUS_LOG)) return null;
    const lines = fs.readFileSync(SWARM_STATUS_LOG, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row?.type !== "agent.heartbeat") continue;
      const hbAgent = row?.payload?.agent || row?.from;
      if (hbAgent !== agent) continue;
      const ts = Date.parse(row?.ts || "");
      if (!Number.isFinite(ts)) return null;
      return (Date.now() - ts) / 1000;
    }
    return null;
  } catch {
    return null;
  }
}

function spawnAgentDaemon(agent) {
  if (isAgentDaemonRunning(agent)) {
    return { agent, status: "already_running" };
  }
  const logFile = agentLogPath(agent);
  const out = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [path.join(process.cwd(), "gateway-bridge.mjs"), "--rt-daemon"], {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      OPENCREW_RT_AGENT: agent,
      OPENCREW_RT_CHANNELS,
    },
  });
  child.unref();
  fs.writeFileSync(agentPidPath(agent), `${child.pid}`);
  return { agent, status: "started", pid: child.pid, logFile };
}

function resolveSpawnTargets(payload) {
  const all = [...new Set(OPENCREW_RT_SWARM_AGENTS)];
  if (Array.isArray(payload?.agents)) {
    const agents = payload.agents.map((a) => String(a).trim()).filter(Boolean);
    return agents.length ? agents : all;
  }
  if (typeof payload?.agent === "string" && payload.agent.trim()) {
    if (payload.agent.trim().toLowerCase() === "all") return all;
    return [payload.agent.trim()];
  }
  if (typeof payload?.target === "string" && payload.target.trim()) {
    if (payload.target.trim().toLowerCase() === "all") return all;
    return [payload.target.trim()];
  }
  return all;
}

function createRealtimeClient({ onEnvelope, agentName = OPENCREW_RT_AGENT, token = OPENCREW_RT_TOKEN, channels = OPENCREW_RT_CHANNELS }) {
  return new Promise((resolveConnect, rejectConnect) => {
    const ws = new WebSocket(OPENCREW_RT_URL, OPENCREW_RT_URL.startsWith("wss://") && OPENCREW_RT_TLS_INSECURE
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
      telemetry("realtime_open", { url: OPENCREW_RT_URL, agent: agentName });
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
      telemetry("realtime_closed", { url: OPENCREW_RT_URL });
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

function formatError(err) {
  const msg = err?.message ?? String(err);
  const lower = msg.toLowerCase();
  let hint = "Hint: run --quickstart to verify connection and channel status.";
  if (lower.includes("enoent") || lower.includes("device.json") || lower.includes("openclaw.json")) {
    hint = `Hint: initialize config (e.g. run install) so identity/config exist under ~/.crewswarm or legacy path.`;
  } else if (lower.includes("econnrefused") || lower.includes("connect") || lower.includes("websocket")) {
    hint = "Hint: start the local gateway service, then re-run with --quickstart.";
  } else if (lower.includes("timeout")) {
    hint = "Hint: gateway may be busy; retry in a few seconds or use --status to verify responsiveness.";
  }
  return `❌ ${msg}\n${hint}`;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function median(numbers) {
  if (!numbers.length) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function percentile(numbers, p) {
  if (!numbers.length) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

function readTelemetryEvents(limit = 20000) {
  try {
    if (!fs.existsSync(TELEMETRY_LOG)) return [];
    const lines = fs.readFileSync(TELEMETRY_LOG, "utf8").split("\n").filter(Boolean);
    const tail = lines.slice(-limit);
    const events = [];
    for (const line of tail) {
      try {
        const row = JSON.parse(line);
        if (row?.event && row?.timestamp) events.push(row);
      } catch {}
    }
    return events;
  } catch {
    return [];
  }
}

function loadSharedMemoryBundle() {
  try {
    const ensureResult = ensureSharedMemoryFiles();
    if (ensureResult.error) {
      return {
        text: "",
        missing: SHARED_MEMORY_FILES,
        included: [],
        files: {},
        bytes: 0,
        loadFailed: true,
        bootstrapCreated: ensureResult.created,
      };
    }

    if (!fs.existsSync(SHARED_MEMORY_DIR)) {
      return {
        text: "",
        missing: SHARED_MEMORY_FILES,
        included: [],
        files: {},
        bytes: 0,
        loadFailed: true,
        bootstrapCreated: ensureResult.created,
      };
    }

    const included = [];
    const missing = [];
    const files = {};
    const sections = [];
    let totalChars = 0;

    for (const fileName of SHARED_MEMORY_FILES) {
      const fullPath = path.join(SHARED_MEMORY_DIR, fileName);
      if (!fs.existsSync(fullPath)) {
        missing.push(fileName);
        continue;
      }

      let content = fs.readFileSync(fullPath, "utf8");
      if (content.length > SHARED_MEMORY_MAX_FILE_CHARS) {
        // For append-only files keep the TAIL (newest entries); for others keep the HEAD
        const TAIL_FIRST_FILES = new Set(["brain.md", "session-log.md", "telegram-context.md"]);
        if (TAIL_FIRST_FILES.has(fileName)) {
          content = `[…older entries trimmed]\n\n${content.slice(-SHARED_MEMORY_MAX_FILE_CHARS)}`;
        } else {
          content = `${content.slice(0, SHARED_MEMORY_MAX_FILE_CHARS)}\n\n[truncated]`;
        }
      }

      files[fileName] = content;
      const section = `### ${fileName}\n${content}`;
      if (totalChars + section.length > SHARED_MEMORY_MAX_TOTAL_CHARS) break;

      sections.push(section);
      included.push(fileName);
      totalChars += section.length;
    }

    if (!sections.length) {
      return {
        text: "",
        missing,
        included,
        files,
        bytes: 0,
        loadFailed: false,
        bootstrapCreated: ensureResult.created,
      };
    }

    const text = [
      "Persistent shared memory (load this before answering):",
      ...sections,
      "End persistent memory.",
    ].join("\n\n");
    return {
      text,
      missing,
      included,
      files,
      bytes: Buffer.byteLength(text, "utf8"),
      loadFailed: false,
      bootstrapCreated: ensureResult.created,
    };
  } catch (err) {
    telemetry("shared_memory_load_error", { message: err?.message ?? String(err) });
    return {
      text: "",
      missing: SHARED_MEMORY_FILES,
      included: [],
      files: {},
      bytes: 0,
      loadFailed: true,
      bootstrapCreated: [],
    };
  }
}

function getLastHandoffTimestamp(sharedMemory) {
  const handoff = sharedMemory?.files?.["agent-handoff.md"] || "";
  const match = handoff.match(/^Last updated:\s*(.+)$/m);
  return match ? match[1].trim() : "unknown";
}

function loadAgentPrompts() {
  const candidates = [
    path.join(os.homedir(), ".crewswarm", "agent-prompts.json"),
    path.join(os.homedir(), ".openclaw",  "agent-prompts.json"),
  ];
  for (const p of candidates) {
    try {
      const prompts = JSON.parse(fs.readFileSync(p, "utf8"));
      if (Object.keys(prompts).length > 0) return prompts;
    } catch {}
  }
  return {};
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
  return `[${agentId}] ${taskText}\n\nProject directory: ${dir}. Use the project files to complete this task only.`;
}

/**
 * Ouroboros-style LLM ↔ OpenCode loop (see https://github.com/joi-lab/ouroboros).
 * LLM decomposes task into steps; each step is executed by OpenCode; results fed back until DONE or max rounds.
 */
async function runOuroborosStyleLoop(originalTask, agentId, projectDir, payload, progress) {
  const DECOMPOSER_SYSTEM = "You are a task decomposer. Output exactly one line: either STEP: <one clear instruction to do now> or DONE. No other text.";
  const maxRounds = Math.min(20, Math.max(1, parseInt(process.env.OPENCREW_OPENCODE_LOOP_MAX_ROUNDS || "10", 10)));
  const steps = [];
  let prompt = `${originalTask}\n\nOutput the first step: STEP: <instruction> or DONE.`;
  let lastReply = "";

  for (let round = 0; round < maxRounds; round++) {
    const reply = await callLLMDirect(prompt, agentId, DECOMPOSER_SYSTEM);
    if (!reply || !reply.trim()) break;
    lastReply = reply.trim();

    if (/^\s*DONE\s*$/im.test(lastReply) || /\bDONE\s*$/im.test(lastReply)) break;

    const stepMatch = lastReply.match(/STEP:\s*([\s\S]+?)(?:\n\n|\n*$)/im) || lastReply.match(/STEP:\s*(.+)/i);
    const step = stepMatch ? stepMatch[1].trim().replace(/\n.*/gs, "").trim() : lastReply.slice(0, 500);
    if (!step) break;

    progress(`Round ${round + 1}/${maxRounds}: ${step.slice(0, 60)}${step.length > 60 ? "…" : ""}`);
    let ocResult;
    try {
      ocResult = await runOpenCodeTask(buildMiniTaskForOpenCode(step, agentId, projectDir), payload);
    } catch (e) {
      ocResult = `Error: ${e?.message || String(e)}`;
    }
    steps.push({ step, result: ocResult });
    prompt = `Task: ${originalTask}\n\nCompleted steps:\n${steps.map((s, i) => `${i + 1}. ${s.step}\nResult: ${s.result}`).join("\n\n")}\n\nWhat is the next step? Reply with exactly: STEP: <instruction> or DONE.`;
  }

  if (steps.length === 0) return lastReply || "No steps executed.";
  return steps.map(s => s.result).join("\n\n---\n\n");
}

function buildTaskPrompt(taskText, sourceLabel, agentId, options = {}) {
  const { projectDir: taskProjectDir } = options;
  const sharedMemory = loadSharedMemoryBundle();
  if (sharedMemory.loadFailed) {
    return { finalPrompt: "MEMORY_LOAD_FAILED", sharedMemory };
  }
  const lastHandoffTimestamp = getLastHandoffTimestamp(sharedMemory);
  
  const contextNote = `[Shared memory loaded — UTC: ${new Date().toISOString().slice(0,16).replace('T',' ')} | Last handoff: ${lastHandoffTimestamp.slice(0,16) || 'none'}]`;

  // Inject agent-specific system prompt if one exists
  const agentPrompts = loadAgentPrompts();
  const bareId = agentId ? agentId.replace(/^crew-/, "") : null;
  const agentSystemPrompt = (agentId && agentPrompts[agentId]) || (bareId && agentPrompts[bareId]) || null;

  const agentAllowed = loadAgentToolPermissions(agentId || "crew-main");
  const toolInstructions = buildToolInstructions(agentAllowed);

  // Load global rules — injected into every agent if the file exists
  const globalRulesPath = path.join(os.homedir(), ".crewswarm", "global-rules.md");
  const globalRules = (() => {
    try {
      const txt = fs.readFileSync(globalRulesPath, "utf8").trim();
      return txt ? `## Global Rules (apply to all agents)\n${txt}` : "";
    } catch { return ""; }
  })();

  // Load agent-specific extra memory (e.g. lessons.md for coders + fixer)
  const extraMemoryFiles = getAgentExtraMemory(agentId);
  const extraMemorySections = [];
  for (const fileName of extraMemoryFiles) {
    const fullPath = path.join(SHARED_MEMORY_DIR, fileName);
    if (!fs.existsSync(fullPath)) continue;
    try {
      let content = fs.readFileSync(fullPath, "utf8").trim();
      if (content.length > 6000) content = content.slice(-6000); // tail-trim
      if (content) extraMemorySections.push(`### ${fileName}\n${content}`);
    } catch {}
  }

  // Inject agent identity — name, model, and ID so every agent knows who it is
  let identityHeader = "";
  if (agentId) {
    const agentList = loadAgentList();
    const agentCfg = agentList.find(a => a.id === agentId);
    if (agentCfg) {
      const displayName = agentCfg.identity?.name || agentCfg.name || agentId;
      const emoji       = agentCfg.identity?.emoji || agentCfg.emoji || "";
      const role        = agentCfg.identity?.theme || "";
      const model       = agentCfg.model || "unknown model";
      identityHeader = `You are ${emoji ? emoji + " " : ""}${displayName} (agent ID: ${agentId}${role ? ", role: " + role : ""}, model: ${model}).`;
    }
  }

  // Fixer: when a path in the task doesn't exist, discover it by searching the project (so wrong paths like src/api/routers/main.py → find src/api/main.py)
  const projectRoot = taskProjectDir || (agentId === "crew-fixer" ? getOpencodeProjectDir() : null);
  const desktopProjectsHint = path.join(os.homedir(), "Desktop", "<project-name>");
  let projectDiscoveryRule = "";
  if (agentId === "crew-fixer") {
    if (projectRoot) {
      projectDiscoveryRule = `## Project discovery (apply when a path in the task is missing or wrong)\nProject root: ${projectRoot}\n- If a path in the task does not exist, search the project first: use @@RUN_CMD find "${projectRoot}" -name '<filename>' (e.g. main.py) or ls to locate the file. Do not report "file not found" until you have tried to resolve the path within this project.`;
    } else {
      projectDiscoveryRule = `## Project discovery (external projects)\n- External projects (e.g. polymarket-ai-strat) are NOT inside the CrewSwarm repo. Their root is typically ${desktopProjectsHint}. If a path contains "CrewSwarm/<project-name>/", replace that with "${path.join(os.homedir(), "Desktop")}/<project-name>/". Example: polymarket-ai-strat main.py is at ${path.join(os.homedir(), "Desktop", "polymarket-ai-strat", "src/api/main.py")} (not under CrewSwarm, and not src/api/routers/main.py). Use @@RUN_CMD find to locate files if unsure.`;
    }
  }

  // Load per-project memory from <projectDir>/.crewswarm/context.md and brain.md
  // context.md = static facts (GitHub, tech stack, danger zones) — human-authored
  // brain.md   = accumulated knowledge — agents append via @@BRAIN when project selected
  const projectMemorySections = [];
  if (taskProjectDir) {
    const projectMemoryDir = path.join(taskProjectDir, ".crewswarm");
    for (const fname of ["context.md", "brain.md"]) {
      const fpath = path.join(projectMemoryDir, fname);
      try {
        let content = fs.readFileSync(fpath, "utf8").trim();
        if (content.length > 8000) content = content.slice(-8000);
        if (content) projectMemorySections.push(`### Project ${fname} (${taskProjectDir})\n${content}`);
      } catch { /* file doesn't exist — skip silently */ }
    }
  }

  const parts = [];
  if (identityHeader) parts.push(identityHeader);
  if (agentSystemPrompt) parts.push(agentSystemPrompt);
  if (globalRules) parts.push(globalRules);
  if (toolInstructions) parts.push(toolInstructions);
  if (projectDiscoveryRule) parts.push(projectDiscoveryRule);
  if (sharedMemory.text) parts.push(sharedMemory.text);
  if (extraMemorySections.length > 0) parts.push(extraMemorySections.join("\n\n"));
  if (projectMemorySections.length > 0) parts.push(projectMemorySections.join("\n\n"));
  parts.push(contextNote);
  parts.push(taskText);

  const finalPrompt = parts.join("\n\n");
  
  return { finalPrompt, sharedMemory };
}

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
          chat: (msg, sessionKey = OPENCREW_RT_AGENT || "main", options = {}) => {
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
  progress(`Connecting to OpenCrew RT ${OPENCREW_RT_URL}...`);
  const rt = await withRetry(() => createRealtimeClient({ onEnvelope: null }), {
    retries: 2,
    baseDelayMs: 300,
    label: "realtime connect",
  });
  console.log(`OpenCrew RT connected as ${OPENCREW_RT_AGENT}`);
  console.log(`- URL: ${OPENCREW_RT_URL}`);
  console.log(`- Channels: ${OPENCREW_RT_CHANNELS.join(", ")}`);
  console.log(`- Token configured: ${OPENCREW_RT_TOKEN ? "yes" : "no"}`);
  rt.close();
}

async function runBroadcastTask(message, { timeoutMs = 25000 } = {}) {
  const taskId = `broadcast-${Date.now()}`;
  const sender = process.env.OPENCREW_RT_BROADCAST_SENDER || "orchestrator";
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
async function runSendToAgent(agentId, message, { timeoutMs = Number(process.env.OPENCREW_RT_SEND_TIMEOUT_MS || "120000"), projectDir } = {}) {
  const taskId = `send-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const correlationId = crypto.randomUUID();
  const sender = process.env.OPENCREW_RT_SEND_SENDER || "orchestrator";
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

async function handleRealtimeEnvelope(envelope, client, bridge) {
  const payload = envelope?.payload && typeof envelope.payload === "object" ? envelope.payload : {};
  const taskId = envelope?.taskId || "";
  const incomingType = envelope?.type || "event";
  const from = envelope?.from || "unknown";
  const to = envelope?.to || "broadcast";
  const correlationId = envelope?.id || undefined;

  // Per-agent routing: skip tasks not addressed to us (unless broadcast)
  if (to !== "broadcast" && to !== OPENCREW_RT_AGENT) {
    client.ack({ messageId: envelope.id, status: "skipped", note: `not for us (to=${to}, we=${OPENCREW_RT_AGENT})` });
    return;
  }

  if (!OPENCREW_RT_COMMAND_TYPES.has(incomingType)) {
    client.ack({ messageId: envelope.id, status: "skipped", note: `unsupported type ${incomingType}` });
    return;
  }

  // ── cmd approval resolution (from crew-lead via RT bus) ───────────────────
  if (incomingType === "cmd.approved" || incomingType === "cmd.rejected") {
    const approvalId = payload?.approvalId;
    if (approvalId && pendingCmdApprovals.has(approvalId)) {
      const pending = pendingCmdApprovals.get(approvalId);
      clearTimeout(pending.timer);
      pendingCmdApprovals.delete(approvalId);
      pending.resolve(incomingType === "cmd.approved");
      console.log(`[${OPENCREW_RT_AGENT}] cmd ${incomingType === "cmd.approved" ? "✅ approved" : "⛔ rejected"}: ${approvalId}`);
    }
    try { client.ack({ messageId: envelope.id, status: "done", note: `cmd ${incomingType}` }); } catch {}
    return;
  }

  const action = String(payload.action || payload.command || "run_task").trim().toLowerCase();
  if (incomingType === "command.spawn_agent") {
    const targets = resolveSpawnTargets(payload);
    const results = targets.map((agent) => spawnAgentDaemon(agent));
    client.publish({
      channel: "done",
      type: "task.done",
      to: from,
      taskId,
      correlationId,
      priority: "high",
      payload: {
        source: OPENCREW_RT_AGENT,
        incomingType,
        action: "spawn_agent",
        results,
      },
    });
    client.ack({ messageId: envelope.id, status: "done", note: `spawned ${results.length} agent(s)` });
    return;
  }

  if (incomingType === "command.collect_status") {
    const targets = resolveSpawnTargets(payload);
    const status = targets.map((agent) => ({ agent, running: isAgentDaemonRunning(agent), pid: readPid(agent) || null }));
    client.publish({
      channel: "done",
      type: "task.done",
      to: from,
      taskId,
      correlationId,
      priority: "medium",
      payload: {
        source: OPENCREW_RT_AGENT,
        incomingType,
        action: "collect_status",
        status,
      },
    });
    client.ack({ messageId: envelope.id, status: "done", note: `status for ${status.length} agent(s)` });
    return;
  }

  if (incomingType.startsWith("command.") && action !== "run_task" && action !== "collect_status") {
    client.publish({
      channel: "issues",
      type: "command.unsupported",
      to: from,
      taskId,
      correlationId,
      priority: "medium",
      payload: {
        source: OPENCREW_RT_AGENT,
        action,
        note: "Legacy bridge supports run_task and collect_status command actions",
      },
    });
    client.ack({ messageId: envelope.id, status: "failed", note: `unsupported action ${action}` });
    return;
  }

  const prompt = payload.prompt || payload.message || payload.description || [payload.title, payload.description].filter(Boolean).join("\n\n");
  if (!prompt || typeof prompt !== "string") {
    client.ack({ messageId: envelope.id, status: "failed", note: "missing prompt/message" });
    return;
  }

  const dispatchAttempt = Number(payload?._dispatchAttempt || 0);
  const dispatchKey = dispatchKeyForTask({
    taskId,
    incomingType,
    prompt,
    idempotencyKey: payload?._dispatchIdempotencyKey || payload?.idempotencyKey,
  });
  const dispatchGuardEnabled = shouldUseDispatchGuard(incomingType);
  let dispatchClaim = null;
  let dispatchHeartbeat = null;

  if (dispatchGuardEnabled) {
    try {
      dispatchClaim = acquireTaskLease({
        key: dispatchKey,
        source: incomingType,
        incomingType,
        from,
        leaseMs: OPENCREW_RT_DISPATCH_LEASE_MS,
      });
    } catch (err) {
      telemetry("dispatch_claim_error", {
        key: dispatchKey,
        taskId,
        incomingType,
        error: err?.message ?? String(err),
      });
      client.ack({ messageId: envelope.id, status: "failed", note: "dispatch claim error" });
      return;
    }

    if (!dispatchClaim?.acquired) {
      const reason = dispatchClaim?.reason || "claimed";
      telemetry("dispatch_claim_skipped", {
        key: dispatchKey,
        taskId,
        incomingType,
        reason,
        claimedBy: dispatchClaim?.claimedBy || null,
      });
      const note = reason === "already_done"
        ? "duplicate task already completed"
        : `task claimed by ${dispatchClaim?.claimedBy || "another agent"}`;
      if (reason === "already_done" && dispatchClaim?.doneRecord?.reply) {
        client.publish({
          channel: "done",
          type: "task.done",
          to: from,
          taskId,
          correlationId,
          priority: "medium",
          payload: {
            source: OPENCREW_RT_AGENT,
            incomingType,
            reply: dispatchClaim.doneRecord.reply,
            duplicate: true,
            idempotencyKey: dispatchKey,
            completedBy: dispatchClaim.doneRecord.agent || null,
            completedAt: dispatchClaim.doneRecord.doneAt || null,
          },
        });
      }
      client.ack({ messageId: envelope.id, status: "skipped", note });
      return;
    }

    dispatchHeartbeat = setInterval(() => {
      const renewed = renewTaskLease({
        key: dispatchKey,
        claimId: dispatchClaim.claimId,
        leaseMs: OPENCREW_RT_DISPATCH_LEASE_MS,
      });
      if (!renewed) {
        telemetry("dispatch_lease_lost", {
          key: dispatchKey,
          taskId,
          incomingType,
          claimId: dispatchClaim?.claimId,
        });
      }
    }, OPENCREW_RT_DISPATCH_HEARTBEAT_MS);

    telemetry("dispatch_claim_acquired", {
      key: dispatchKey,
      taskId,
      incomingType,
      claimId: dispatchClaim.claimId,
      attempt: dispatchAttempt,
    });
  }

  client.ack({ messageId: envelope.id, status: "received", note: `crewswarm accepted ${incomingType}` });
  client.publish({
    channel: "status",
    type: "task.in_progress",
    to: from,
    taskId,
    correlationId,
    priority: "high",
    payload: {
      source: OPENCREW_RT_AGENT,
      note: `Processing ${incomingType}`,
      action,
      idempotencyKey: dispatchKey,
      attempt: dispatchAttempt,
    },
  });

  try {
    const taskProjectDir = payload?.projectDir || getOpencodeProjectDir() || null;
    const { finalPrompt, sharedMemory } = buildTaskPrompt(prompt, `Realtime task from ${from} (${incomingType})`, OPENCREW_RT_AGENT, { projectDir: taskProjectDir });
    if (sharedMemory.loadFailed || finalPrompt === "MEMORY_LOAD_FAILED") {
      throw new Error("MEMORY_LOAD_FAILED");
    }
    assertTaskPromptProtocol(finalPrompt, "realtime");

    const useCursorCli = shouldUseCursorCli(payload, incomingType);
    const useClaudeCode = shouldUseClaudeCode(payload, incomingType);
    const useOpenCode = shouldUseOpenCode(payload, prompt, incomingType);
    if (useCursorCli) {
      progress(`Routing realtime task to Cursor CLI (agent -p --force)...`);
      telemetry("realtime_route_cursor_cli", { taskId, incomingType, from, agent: OPENCREW_RT_AGENT });
    } else if (useClaudeCode) {
      progress(`Routing realtime task to Claude Code (claude -p)...`);
      telemetry("realtime_route_claude_code", { taskId, incomingType, from, agent: OPENCREW_RT_AGENT });
    } else if (useOpenCode) {
      const routeAgent = String(payload?.agent || OPENCREW_OPENCODE_AGENT || "default");
      const ocAgentCfg = getAgentOpenCodeConfig(OPENCREW_RT_AGENT);
      const routeModel = String(payload?.model || ocAgentCfg.model || OPENCREW_OPENCODE_MODEL);
      progress(`Routing realtime task to OpenCode (${routeAgent}/${routeModel})...`);
      telemetry("realtime_route_opencode", { taskId, incomingType, from, model: routeModel, agent: routeAgent });
    }
    // Emit working indicator for ALL tasks (not just OpenCode)
    _rtClientForApprovals?.publish({ channel: "events", type: "agent_working", to: "broadcast", payload: { agent: OPENCREW_RT_AGENT, ts: Date.now() } });

    let reply;
    let ocAgentId = null;
    let agentSysPrompt = null;
    if (useCursorCli) {
      // ── Cursor CLI backend ─────────────────────────────────────────────
      let projectDir = payload?.projectDir || getOpencodeProjectDir() || process.cwd();
      projectDir = String(projectDir).replace(/[.,;!?]+$/, "");
      try {
        reply = await runCursorCliTask(prompt, { ...payload, agentId: OPENCREW_RT_AGENT, projectDir });
      } catch (e) {
        const msg = e?.message ?? String(e);
        progress(`Cursor CLI failed: ${msg.slice(0, 120)} — falling back to OpenCode`);
        telemetry("cursor_cli_fallback", { taskId, error: msg });
        const ocPrompt = buildMiniTaskForOpenCode(prompt, OPENCREW_RT_AGENT, projectDir);
        reply = await runOpenCodeTask(ocPrompt, payload);
      }
    } else if (useClaudeCode) {
      // ── Claude Code backend ────────────────────────────────────────────
      let projectDir = payload?.projectDir || getOpencodeProjectDir() || process.cwd();
      projectDir = String(projectDir).replace(/[.,;!?]+$/, "");
      try {
        reply = await runClaudeCodeTask(prompt, { ...payload, agentId: OPENCREW_RT_AGENT, projectDir });
      } catch (e) {
        const msg = e?.message ?? String(e);
        progress(`Claude Code failed: ${msg.slice(0, 120)} — falling back to direct LLM`);
        telemetry("claude_code_fallback", { taskId, error: msg });
        // Fall back to direct LLM via standard OpenAI-compat call
        reply = await callLLMDirect(finalPrompt, OPENCREW_RT_AGENT, null);
      }
    } else if (useOpenCode) {
      let projectDir = payload?.projectDir || getOpencodeProjectDir() || null;
      if (!projectDir || projectDir === process.cwd()) {
        const fromTask = extractProjectDirFromTask(prompt);
        if (fromTask) projectDir = fromTask;
      }
      projectDir = projectDir || process.cwd();
      const ocAgentCfg = getAgentOpenCodeConfig(OPENCREW_RT_AGENT);
      let opencodeErr;

      if (ocAgentCfg.loop) {
        // Ouroboros-style: LLM decomposes → OpenCode executes each step → repeat until DONE
        progress("OpenCode loop mode: LLM ↔ OpenCode until DONE...");
        try {
          reply = await runOuroborosStyleLoop(prompt, OPENCREW_RT_AGENT, projectDir, payload, progress);
        } catch (e) {
          opencodeErr = e;
          progress(`OpenCode loop failed: ${e?.message?.slice(0, 80)} — falling back to single shot`);
          const ocPrompt = buildMiniTaskForOpenCode(prompt, OPENCREW_RT_AGENT, projectDir);
          reply = await runOpenCodeTask(ocPrompt, payload);
        }
      } else {
        // Single-shot: mini task only (no shared memory / tool doc — OpenCode reads files)
        const ocPrompt = buildMiniTaskForOpenCode(prompt, OPENCREW_RT_AGENT, projectDir);
        try {
          reply = await runOpenCodeTask(ocPrompt, payload);
        } catch (e) {
        opencodeErr = e;
        const msg = e?.message ?? String(e);
        const isRateLimit = /429|rate\s*limit|usage.*limit|quota.*exceeded|too\s*many\s*requests|banner-only/i.test(msg);
        const isTimeout  = /timeout|timed\s*out|stall/i.test(msg);
        if (isRateLimit || isTimeout) {
          // Build rotation chain: free models first, then configured fallback, deduplicated
          // Track ALL tried models (primary + each fallback attempt) to avoid re-trying failed ones
          const primaryModel = String(payload?.model || OPENCREW_OPENCODE_MODEL);
          const configFallback = getAgentOpenCodeConfig(OPENCREW_RT_AGENT).fallbackModel;
          const triedModels = new Set([primaryModel]);
          // Per-agent opencodeFallbackModel goes FIRST, then global free chain as safety net
          const chain = [...(configFallback ? [configFallback] : []), ...OPENCODE_FREE_MODEL_CHAIN]
            .filter((m, i, arr) => m !== primaryModel && arr.indexOf(m) === i);
          for (const fbModel of chain) {
            if (triedModels.has(fbModel)) continue; // skip already-tried models
            triedModels.add(fbModel);
            const reason = isTimeout ? "timed out" : "rate limited";
            progress(`OpenCode ${primaryModel} ${reason} — rotating to ${fbModel}`);
            telemetry("realtime_opencode_fallback", { taskId, incomingType, error: msg, fallbackModel: fbModel });
            try {
              reply = await runOpenCodeTask(ocPrompt, { ...payload, model: fbModel });
              if (reply) break;
            } catch (fbErr) {
              opencodeErr = fbErr;
              const fbMsg = fbErr?.message ?? String(fbErr);
              const fbRateLimit = /429|rate\s*limit|usage.*limit|quota.*exceeded|banner-only|stall/i.test(fbMsg);
              if (!fbRateLimit) break; // non-rate-limit/stall error — stop rotating
              // rate-limited/stalled on this fallback too — continue to next in chain
            }
          }
        }
        if (!reply && bridge?.kind === "gateway") {
          telemetry("realtime_opencode_fallback", { taskId, incomingType, error: opencodeErr?.message || msg });
          progress(`OpenCode failed, falling back to legacy gateway: ${(opencodeErr?.message || msg).slice(0, 120)}`);
          const gatewayAgentId = RT_TO_GATEWAY_AGENT_MAP[OPENCREW_RT_AGENT] || "main";
          reply = await bridge.chat(finalPrompt, gatewayAgentId, { idempotencyKey: dispatchKey });
        } else if (!reply) {
          throw opencodeErr;
        }
      }
      }
    } else {
      // Try direct LLM call first (uses agent's configured model/provider from crewswarm.json)
      ocAgentId = RT_TO_GATEWAY_AGENT_MAP[OPENCREW_RT_AGENT] || "main";
      agentSysPrompt = loadAgentPrompts()[ocAgentId] || null;
      progress(`Trying direct LLM for ${OPENCREW_RT_AGENT} (mapped: ${ocAgentId})...`);
      reply = await callLLMDirect(finalPrompt, ocAgentId, agentSysPrompt);

      if (!reply) {
        // Fall through to legacy gateway (uses its default model)
        progress(`No direct LLM config for ${ocAgentId}, falling back to legacy gateway...`);
        telemetry("realtime_direct_llm_fallback", { taskId, ocAgentId, incomingType });
        assertTaskPromptProtocol(finalPrompt, "realtime-gateway-chat");
        reply = await bridge.chat(finalPrompt, ocAgentId, { idempotencyKey: dispatchKey });
      }
    }
    if (!reply || reply === "(timeout - no reply)") {
      throw new Error("Chat timeout while processing realtime task");
    }
    reply = stripThink(reply);

    // Execute any tool calls — suppress @@WRITE_FILE if searches are pending in the same reply
    const toolResults = await executeToolCalls(reply, OPENCREW_RT_AGENT, { suppressWriteIfSearchPending: true });
    if (toolResults.length > 0) {
      reply = reply + "\n\n---\n**Tool execution results:**\n" + toolResults.join("\n");
      telemetry("agent_tools_executed", { taskId, agent: OPENCREW_RT_AGENT, count: toolResults.length });

      // Do a follow-up LLM call whenever:
      // (a) searches ran (agent needs to see results before writing), OR
      // (b) write was suppressed (agent tried to write before searching)
      const hasSearchResults = toolResults.some(r => r.includes("[tool:web_search]") || r.includes("[tool:web_fetch]") || r.includes("[tool:read_file]"));
      const writeSuppressed = toolResults.some(r => r.includes("⏸ Write suppressed"));
      const didWriteFile = toolResults.some(r => r.includes("[tool:write_file] ✅"));

      if (hasSearchResults && (!didWriteFile || writeSuppressed)) {
        try {
          const followUpPrompt = `${agentSysPrompt || ""}\n\n[Original task]:\n${finalPrompt}\n\n[Tool results from your searches]:\n${toolResults.join("\n")}\n\nUsing ONLY the search results above (not your training data), write the complete output now using @@WRITE_FILE. Do not search again — just synthesize and write.`;
          let followUpReply = ocAgentId
            ? await callLLMDirect(followUpPrompt, ocAgentId, agentSysPrompt)
            : null;
          if (!followUpReply) followUpReply = await bridge.chat(followUpPrompt, ocAgentId || "main", { idempotencyKey: dispatchKey + "-followup" });
          followUpReply = stripThink(followUpReply);
          const followUpTools = await executeToolCalls(followUpReply, OPENCREW_RT_AGENT);
          reply = reply + "\n\n" + followUpReply;
          if (followUpTools.length > 0) {
            reply = reply + "\n\n---\n**Follow-up tool results:**\n" + followUpTools.join("\n");
          }
        } catch (err) {
          console.warn(`[bridge] Follow-up synthesis call failed: ${err.message}`);
        }
      }
    }

    // Validate coding artifacts for coding tasks
    const validation = validateCodingArtifacts(reply, incomingType, prompt, payload);
    if (!validation.valid) {
      telemetry("coding_artifact_validation_failed", {
        taskId,
        incomingType,
        reason: validation.reason,
        replyLength: reply.length,
      });
      
      // Send feedback to agent before retrying
      client.publish({
        channel: "issues",
        type: "task.artifact_missing",
        to: OPENCREW_RT_AGENT, // Send feedback to self for learning
        taskId,
        correlationId,
        priority: "high",
        payload: {
          source: "gateway",
          error: `CODING_ARTIFACT_MISSING: ${validation.reason}`,
          feedback: "Your reply must include: (1) Files changed with paths, (2) What changed in each file, (3) Command outputs (build/test/lint), (4) Verification steps. Do not reply with only suggestions or 'Done' without evidence.",
          originalPrompt: String(prompt).slice(0, 500),
          replyPreview: String(reply).slice(0, 500),
        },
      });
      
      throw new Error(`CODING_ARTIFACT_MISSING: ${validation.reason}`);
    }

    if (dispatchGuardEnabled && dispatchClaim?.acquired) {
      markTaskDone({
        key: dispatchKey,
        claimId: dispatchClaim.claimId,
        taskId,
        incomingType,
        from,
        attempt: dispatchAttempt,
        idempotencyKey: dispatchKey,
        reply,
      });
      telemetry("dispatch_task_done", {
        key: dispatchKey,
        taskId,
        incomingType,
        claimId: dispatchClaim.claimId,
      });
    }

    // Parse @@LESSON: tags — write to project brain (if projectDir) or global lessons.md
    // This is how agents contribute durable knowledge without polluting system prompts
    const lessonMatches = [...reply.matchAll(/@@LESSON:\s*([^\n]+)/g)];
    if (lessonMatches.length > 0) {
      const date = new Date().toISOString().slice(0, 10);
      for (const m of lessonMatches) {
        const entry = m[1].trim();
        if (!entry) continue;
        try {
          if (projectDir) {
            const projectMemDir = path.join(projectDir, ".crewswarm");
            fs.mkdirSync(projectMemDir, { recursive: true });
            const projectBrainPath = path.join(projectMemDir, "brain.md");
            if (!fs.existsSync(projectBrainPath)) {
              fs.writeFileSync(projectBrainPath, "# Project Brain\n\nAccumulated knowledge for this project.\n", "utf8");
            }
            fs.appendFileSync(projectBrainPath, `\n## [${date}] ${OPENCREW_RT_AGENT}: ${entry}\n`, "utf8");
          } else {
            const lessonsPath = path.join(SHARED_MEMORY_DIR, "lessons.md");
            fs.appendFileSync(lessonsPath, `\n## [${date}] ${OPENCREW_RT_AGENT}: ${entry}\n`, "utf8");
          }
          console.log(`[bridge:${OPENCREW_RT_AGENT}] @@LESSON → ${projectDir ? path.basename(projectDir) + "/.crewswarm/brain.md" : "lessons.md"}: ${entry.slice(0, 80)}`);
        } catch (e) {
          console.warn(`[bridge:${OPENCREW_RT_AGENT}] @@LESSON write failed: ${e.message}`);
        }
      }
    }

    // Parse and execute @@DISPATCH commands from coordinator agents only.
    // Canonical format: @@DISPATCH {"agent":"crew-coder","task":"..."}
    // Legacy format also supported: @@DISPATCH:agent-id|task description
    // Non-coordinator agents are blocked from dispatching to prevent loops.
    const COORDINATOR_AGENTS = new Set(COORDINATOR_AGENT_IDS);
    const rawDispatches = COORDINATOR_AGENTS.has(OPENCREW_RT_AGENT)
      ? (() => {
          const results = [];
          // Canonical JSON format
          for (const m of reply.matchAll(/@@DISPATCH\s+(\{[^}]+\})/g)) {
            try {
              const d = JSON.parse(m[1]);
              if (d.agent && d.task) results.push({ targetAgent: d.agent.trim(), taskText: d.task.trim() });
            } catch {}
          }
          // Legacy pipe format (still supported, normalized here)
          for (const m of reply.matchAll(/@@DISPATCH:([a-z0-9_-]+)\|([^\n@@]+)/g)) {
            results.push({ targetAgent: m[1].trim(), taskText: m[2].trim() });
          }
          return results;
        })()
      : [];
    if (rawDispatches.length > 0) {
      for (const { targetAgent, taskText } of rawDispatches) {
        // Block self-dispatch and empty targets
        if (!targetAgent || !taskText || targetAgent === OPENCREW_RT_AGENT) continue;
        try {
          // For audit/QA tasks, inject file contents so the agent can actually read them
          let enrichedTask = taskText;
          const filePaths = [...taskText.matchAll(/([~/\w.-]+\.(?:html|css|js|mjs|ts|md|json))/g)].map(m => m[1]);
          if (filePaths.length > 0) {
            const fileSnippets = [];
            for (const fp of filePaths.slice(0, 3)) {
              try {
                const absPath = fp.startsWith("~") ? fp.replace("~", os.homedir()) : fp;
                const content = fs.readFileSync(absPath, "utf8");
                const lines = content.split("\n");
                // Include full file for small files, truncated for large ones
                const snippet = lines.length <= 600
                  ? content
                  : lines.slice(0, 300).join("\n") + `\n\n... (${lines.length - 300} more lines truncated) ...\n` + lines.slice(-100).join("\n");
                fileSnippets.push(`\n\n--- FILE: ${absPath} (${lines.length} lines) ---\n${snippet}\n--- END FILE ---`);
              } catch { /* file not readable, skip */ }
            }
            if (fileSnippets.length > 0) {
              enrichedTask = taskText + "\n\nFile contents for your audit:" + fileSnippets.join("");
            }
          }
          const dispatchTaskId = "dispatch-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
          client.publish({
            channel: "command",
            type: "command.run_task",
            to: targetAgent,
            taskId: dispatchTaskId,
            priority: "high",
            payload: {
              action: "run_task",
              prompt: enrichedTask,
              dispatchedBy: OPENCREW_RT_AGENT,
              parentTaskId: taskId,
            },
          });
          telemetry("crew_dispatch_forwarded", { from: OPENCREW_RT_AGENT, to: targetAgent, taskId: dispatchTaskId });
          progress(`Dispatched task to ${targetAgent}: ${taskText.slice(0, 60)}`);
        } catch (dispErr) {
          console.error(`[bridge] CREW_DISPATCH to ${targetAgent} failed:`, dispErr?.message);
        }
      }
    }

    client.publish({
      channel: "done",
      type: "task.done",
      to: from,
      taskId,
      correlationId,
      priority: "high",
      payload: {
        source: OPENCREW_RT_AGENT,
        reply,
        incomingType,
        idempotencyKey: dispatchKey,
      },
    });
    _rtClientForApprovals?.publish({ channel: "events", type: "agent_idle", to: "broadcast", payload: { agent: OPENCREW_RT_AGENT, ts: Date.now() } });
    client.ack({ messageId: envelope.id, status: "done", note: "task completed" });
  } catch (err) {
    const message = err?.message ?? String(err);
    const isCoding = isCodingTask(incomingType, prompt, payload);
    const maxRetries = isCoding ? OPENCREW_RT_DISPATCH_MAX_RETRIES_CODING : OPENCREW_RT_DISPATCH_MAX_RETRIES;
    const shouldRetry = dispatchGuardEnabled
      && dispatchClaim?.acquired
      && shouldRetryTaskFailure(err)
      && dispatchAttempt < maxRetries;

    if (shouldRetry) {
      const retryAttempt = dispatchAttempt + 1;
      const retryAfterMs = OPENCREW_RT_DISPATCH_RETRY_BACKOFF_MS * (2 ** dispatchAttempt);
      telemetry("dispatch_retry_scheduled", {
        key: dispatchKey,
        taskId,
        incomingType,
        attempt: retryAttempt,
        retryAfterMs,
        error: message,
      });
      client.publish({
        channel: "status",
        type: "task.retrying",
        to: from,
        taskId,
        correlationId,
        priority: "high",
        payload: {
          source: OPENCREW_RT_AGENT,
          incomingType,
          attempt: retryAttempt,
          retryAfterMs,
          error: message,
          idempotencyKey: dispatchKey,
        },
      });

      setTimeout(() => {
        try {
          client.publish({
            channel: "command",
            type: incomingType,
            to: OPENCREW_RT_AGENT,  // Retry to SELF, not broadcast (prevents 7x amplification)
            taskId,
            priority: "high",
            payload: {
              ...payload,
              _dispatchAttempt: retryAttempt,
              _dispatchIdempotencyKey: dispatchKey,
              _dispatchRetryOf: dispatchAttempt,
              _dispatchLastError: message,
            },
          });
        } catch (publishErr) {
          telemetry("dispatch_retry_publish_error", {
            key: dispatchKey,
            taskId,
            incomingType,
            attempt: retryAttempt,
            error: publishErr?.message ?? String(publishErr),
          });
        }
      }, retryAfterMs);

      return;
    }

    // Write to DLQ if all retries exhausted
    if (dispatchGuardEnabled && dispatchClaim?.acquired && dispatchAttempt >= maxRetries) {
      const dlqPath = path.join(SWARM_DLQ_DIR, `${dispatchKey}.json`);
      const dlqEntry = {
        key: dispatchKey,
        taskId,
        incomingType,
        from,
        agent: OPENCREW_RT_AGENT,
        attempt: dispatchAttempt,
        error: message,
        prompt: String(prompt).slice(0, 2000),
        payload,
        failedAt: new Date().toISOString(),
        envelope,
      };
      try {
        fs.writeFileSync(dlqPath, JSON.stringify(dlqEntry, null, 2), "utf8");
        telemetry("dlq_write", { key: dispatchKey, taskId, incomingType });
      } catch (dlqErr) {
        telemetry("dlq_write_error", { key: dispatchKey, error: dlqErr?.message });
      }

      // ── Auto-escalate to crew-fixer when coding agents exhaust retries ─────
      const ESCALATABLE_AGENTS = new Set([
        "crew-coder", "crew-coder-front", "crew-coder-back", "crew-frontend", "crew-copywriter",
      ]);
      const isSelf = OPENCREW_RT_AGENT === "crew-fixer"; // prevent fixer→fixer loop
      if (ESCALATABLE_AGENTS.has(OPENCREW_RT_AGENT) && !isSelf) {
        const fixerTaskId = `fixer-escalation-${Date.now()}`;
        const fixerPrompt =
          `⚠️ Auto-escalation from ${OPENCREW_RT_AGENT} (failed after ${dispatchAttempt + 1} attempts).\n\n` +
          `**Original task:**\n${String(prompt).slice(0, 1500)}\n\n` +
          `**Error:**\n${message.slice(0, 500)}\n\n` +
          `Use @@READ_FILE to inspect any relevant files, identify the root cause, and fix it.`;
        try {
          client.publish({
            channel: "command",
            type: "command.run_task",
            to: "crew-fixer",
            taskId: fixerTaskId,
            priority: "high",
            payload: { action: "run_task", prompt: fixerPrompt, escalatedFrom: OPENCREW_RT_AGENT, parentTaskId: taskId },
          });
          telemetry("task_escalated_to_fixer", { fromAgent: OPENCREW_RT_AGENT, taskId, fixerTaskId });
          console.log(`[${OPENCREW_RT_AGENT}] ⬆️ Escalated failed task to crew-fixer (${fixerTaskId})`);
        } catch (escErr) {
          console.error(`[${OPENCREW_RT_AGENT}] Escalation to crew-fixer failed:`, escErr?.message);
        }
      }
      // ─────────────────────────────────────────────────────────────────────────
    }

    client.publish({
      channel: "issues",
      type: "task.failed",
      to: from,
      taskId,
      correlationId,
      priority: "high",
      payload: {
        source: OPENCREW_RT_AGENT,
        error: message,
        idempotencyKey: dispatchKey,
        attempt: dispatchAttempt,
      },
    });
    client.ack({ messageId: envelope.id, status: "failed", note: message.slice(0, 240) });
  } finally {
    if (dispatchHeartbeat) {
      clearInterval(dispatchHeartbeat);
      dispatchHeartbeat = null;
    }
    if (dispatchGuardEnabled && dispatchClaim?.acquired) {
      const released = releaseTaskLease({ key: dispatchKey, claimId: dispatchClaim.claimId });
      telemetry("dispatch_claim_released", {
        key: dispatchKey,
        taskId,
        incomingType,
        claimId: dispatchClaim.claimId,
        released,
      });
    }
  }
}

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
      "crew-coder":       "coder",
      "crew-coder-front": "coder",
      "crew-coder-back":  "coder",
      "crew-fixer":       "fixer",
      "crew-frontend":    "coder",
      "crew-qa":          "qa",
      "crew-security":    "security",
      "crew-pm":          "pm",
    };

    const agents = loadAgentList();
    if (!agents?.length) return;

    let raw = fs.readFileSync(ocCfgPath, "utf8");
    // Strip single-line comments so JSON.parse works
    const stripped = raw.replace(/\/\/[^\n]*/g, "");
    let cfg;
    try { cfg = JSON.parse(stripped); } catch { return; }
    if (!cfg.agent) cfg.agent = {};

    for (const agentCfg of agents) {
      const agentId = agentCfg.id || agentCfg.agentId;
      if (!agentId) continue;
      const profile = AGENT_TO_OC_PROFILE[agentId];
      if (!profile) continue;

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
  progress(`Starting OpenCrew realtime daemon via ${OPENCREW_RT_URL}...`);
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
      currentClient?.publish({ channel: "events", type: "agent.offline", payload: { agent: OPENCREW_RT_AGENT } });
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
      _rtClientForApprovals = rt; // allow executeToolCalls to publish approval requests
      rt.publish({
        channel: "events",
        type: "agent.online",
        to: "broadcast",
        priority: "high",
        payload: {
          agent: OPENCREW_RT_AGENT,
          gateway: GATEWAY_URL,
          mode: "daemon",
        },
      });

      console.log(`OpenCrew daemon online: ${OPENCREW_RT_AGENT}`);
      console.log(`- gateway: ${GATEWAY_URL}`);
      console.log(`- realtime: ${OPENCREW_RT_URL}`);
      console.log(`- subscribed: ${OPENCREW_RT_CHANNELS.join(", ")}`);

      heartbeat = setInterval(() => {
        try {
          rt.publish({
            channel: "status",
            type: "agent.heartbeat",
            to: "broadcast",
            payload: { agent: OPENCREW_RT_AGENT, ts: new Date().toISOString() },
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
        progress(`Realtime disconnected. Reconnecting in ${OPENCREW_RT_RECONNECT_MS}ms...`);
        await sleep(OPENCREW_RT_RECONNECT_MS);
      }
    } catch (err) {
      telemetry("realtime_daemon_error", { message: err?.message ?? String(err) });
      progress(`Realtime daemon error: ${err?.message ?? String(err)}`);
      if (!stopRequested) await sleep(OPENCREW_RT_RECONNECT_MS);
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
    telemetry("connect_skipped", { mode: "opencode_only", agent: OPENCREW_RT_AGENT });
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
    if (!OPENCREW_RT_SWARM_AGENTS.includes(agentId)) {
      console.error(`Unknown agent: ${agentId}. Known: ${OPENCREW_RT_SWARM_AGENTS.join(", ")}`);
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
      const reply = await runOpenCodeTask(message, { model: OPENCREW_OPENCODE_MODEL });
      console.log(reply);
      telemetry("chat_done_opencode", { sessionKey: OPENCREW_RT_AGENT, replyChars: reply.length });
      process.exit(0);
    }
    
    telemetry("chat_started", {
      sessionKey: "main",
      messageChars: message.length,
      sharedMemoryIncluded: Boolean(sharedMemory.text),
      sharedMemoryBytes: sharedMemory.bytes,
      sharedMemoryMissing: sharedMemory.missing,
    });
    process.stderr.write(`📤 ${OPENCREW_RT_AGENT || "main"} ${message.slice(0, 80)}\n`);
    process.stderr.write("⏳ Waiting for assistant reply...\n");
    const targetAgent = RT_TO_GATEWAY_AGENT_MAP[OPENCREW_RT_AGENT] || "main";
    
    // For RT swarm agents, poll done.jsonl instead of WebSocket
    const isRTAgent = OPENCREW_RT_SWARM_AGENTS.includes(OPENCREW_RT_AGENT);
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
            if (msg.from === OPENCREW_RT_AGENT && 
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
