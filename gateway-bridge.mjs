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
import { spawn } from "node:child_process";

const LEGACY_STATE_DIR = path.join(os.homedir(), ".openclaw");
const CREWSWARM_DIR = path.join(os.homedir(), ".crewswarm");
const CREWSWARM_CONFIG_PATH = path.join(CREWSWARM_DIR, "config.json");
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
  "current-state.md",          // System overview — what CrewSwarm is, CRITICAL task guidance
  "agent-handoff.md",          // Current status, last completed work, agent rules
  "orchestration-protocol.md", // Agent roster, tool permissions, dispatch syntax
  "brain.md",                  // Accumulated project knowledge — read this to avoid repeating mistakes
  // "decisions.md"            // Architectural decisions — only load when needed
  // "telegram-context.md"     // Telegram chat history — too noisy for code tasks
];

// Extra memory files injected only for specific agents
const AGENT_EXTRA_MEMORY = {
  "crew-fixer":    ["lessons.md"],  // mistake patterns captured by crew-scribe
  "crew-coder":    ["lessons.md"],
  "crew-coder-front": ["lessons.md"],
  "crew-coder-back":  ["lessons.md"],
};
const MEMORY_BOOTSTRAP_AGENT = "gateway-bridge";
const SHARED_MEMORY_PROTOCOL = [
  "Memory loaded. Current UTC: `$(date -u +%Y-%m-%d\\ %H:%M\\ UTC)`; last handoff: `${getLastHandoffTimestamp()}`.",
  "",
  "Complete your task using available tools. When done, briefly note what you did."
].join("\n");
const MEMORY_PROTOCOL_MARKER = "Mandatory memory protocol (apply for this task):";
const GATEWAY_URL = "ws://127.0.0.1:18789";
const OPENCREW_RT_URL = process.env.OPENCREW_RT_URL || "ws://127.0.0.1:18889";
const OPENCREW_RT_AGENT = process.env.OPENCREW_RT_AGENT || "crew-main";
function getRTToken() {
  if (process.env.OPENCREW_RT_AUTH_TOKEN) return process.env.OPENCREW_RT_AUTH_TOKEN;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(LEGACY_STATE_DIR, "openclaw.json"), "utf8"));
    return cfg.env?.OPENCREW_RT_AUTH_TOKEN || "";
  } catch {
    return "";
  }
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
const OPENCREW_OPENCODE_FORCE = process.env.OPENCREW_OPENCODE_FORCE === "1";
const OPENCREW_OPENCODE_BIN = process.env.OPENCREW_OPENCODE_BIN || path.join(os.homedir(), ".opencode", "bin", "opencode");
const OPENCREW_OPENCODE_PROJECT = process.env.OPENCREW_OPENCODE_PROJECT || process.cwd();
const OPENCREW_OPENCODE_AGENT = process.env.OPENCREW_OPENCODE_AGENT || "admin";
const OPENCREW_OPENCODE_MODEL = process.env.OPENCREW_OPENCODE_MODEL || "opencode/glm-5-free";
const OPENCREW_OPENCODE_TIMEOUT_MS = Number(process.env.OPENCREW_OPENCODE_TIMEOUT_MS || "180000");
// ── Auto-load agents from crewswarm.json / openclaw.json (legacy) so new agents added via the dashboard
//    are immediately available without editing this file.
function buildAgentMapsFromConfig() {
  const BUILT_IN_RT_AGENTS = "crew-main,crew-pm,crew-qa,crew-fixer,crew-coder,crew-coder-front,crew-coder-back,crew-github,crew-security,crew-frontend,crew-copywriter";
  const BUILT_IN_MAP = {
    "crew-main": "main", "crew-pm": "pm", "crew-qa": "qa",
    "crew-fixer": "fixer", "crew-coder": "coder",
    "crew-coder-front": "coder-front", "crew-coder-back": "coder-back",
    "crew-github": "github", "crew-security": "security",
    "crew-frontend": "frontend", "crew-copywriter": "copywriter",
  };

  if (process.env.OPENCREW_RT_SWARM_AGENTS) {
    // Fully overridden by env — build map from env list, fall back to built-in map values
    const list = process.env.OPENCREW_RT_SWARM_AGENTS.split(",").map(s => s.trim()).filter(Boolean);
    const map = {};
    for (const a of list) map[a] = BUILT_IN_MAP[a] || a.replace(/^crew-/, "");
    return { list, map };
  }

  // Merge built-in agents with any extra agents defined in crewswarm.json or openclaw.json (legacy)
  try {
    const cfgPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const cfgAgents = Array.isArray(cfg.agents) ? cfg.agents
                    : Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];

    const map = { ...BUILT_IN_MAP };
    const listSet = new Set(BUILT_IN_RT_AGENTS.split(",").map(s => s.trim()).filter(Boolean));

    for (const agent of cfgAgents) {
      const rawId = agent.id;                                        // may be "coder-front" OR "crew-coder-front"
      const bareId = rawId.replace(/^crew-/, "");                   // always "coder-front"
      const rtId   = "crew-" + bareId;                              // always "crew-coder-front"
      if (!map[rtId]) { map[rtId] = bareId; listSet.add(rtId); }   // register crew-X → bare
      // Only also register the bare form if the config stored it without prefix
      if (rawId === bareId && !map[bareId]) { map[bareId] = bareId; listSet.add(bareId); }
    }

    return { list: [...listSet], map };
  } catch (e) {
    // Config unreadable — fall back to built-in list
    const list = BUILT_IN_RT_AGENTS.split(",").map(s => s.trim()).filter(Boolean);
    return { list, map: BUILT_IN_MAP };
  }
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

    return { baseUrl: provider.baseUrl, apiKey: provider.apiKey, modelId, agentId: agent.id, providerKey };
  } catch (e) {
    console.warn(`[bridge] loadAgentLLMConfig error: ${e.message}`);
    return null;
  }
}

async function callLLMDirect(prompt, ocAgentId, systemPrompt) {
  const llm = loadAgentLLMConfig(ocAgentId);
  if (!llm) return null; // fall through to legacy gateway

  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  try {
    const res = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify({ model: llm.modelId, messages, max_tokens: 8192 }),
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
    recordTokenUsage(llm.modelId, data.usage);
    console.log(`[direct-llm] ${ocAgentId} via ${llm.modelId} — ${text.length} chars${data.usage ? ` (${(data.usage.prompt_tokens||0)+(data.usage.completion_tokens||0)} tokens)` : ""}`);
    return text;
  } catch (e) {
    if (e.isRateLimit) {
      console.error(`[direct-llm] ${ocAgentId} rate-limited (429) on ${llm.modelId} — waiting 10s then retry`);
      await new Promise(r => setTimeout(r, 10000));
      try {
        const res2 = await fetch(`${llm.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${llm.apiKey}` },
          body: JSON.stringify({ model: llm.modelId, messages, max_tokens: 8192 }),
          signal: AbortSignal.timeout(120000),
        });
        if (res2.ok) {
          const data2 = await res2.json();
          const text2 = data2?.choices?.[0]?.message?.content || "";
          if (text2) { console.log(`[direct-llm] ${ocAgentId} retry succeeded`); return text2; }
        }
      } catch {}
      console.error(`[direct-llm] ${ocAgentId} retry also failed — trying Groq global fallback`);
    } else {
      console.error(`[direct-llm] ${ocAgentId} failed: ${e.message} — trying Groq global fallback`);
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
        const res = await fetch(`${groq.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${groq.apiKey}` },
          body: JSON.stringify({ model: GROQ_FALLBACK_MODEL, messages, max_tokens: 8192 }),
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

function validateCodingArtifacts(reply, incomingType, prompt, payload) {
  // TEMP DISABLED: Validation was rejecting valid responses
  // TODO: Fix this properly - agents ARE creating files but validation thinks they're just chatting
  return { valid: true, reason: "validation temporarily disabled" };
  
  // Original validation code below (commented out for now)
  /*
  if (!isCodingTask(incomingType, prompt, payload)) {
    return { valid: true, reason: "not a coding task" };
  }
  
  const text = String(reply || "").toLowerCase();
  const replyLength = text.length;
  
  if (replyLength < 50) {
    return { valid: false, reason: "reply too short for coding task (< 50 chars)" };
  }
  
  if (replyLength < 200 && /memory|loading|processing|working/i.test(reply)) {
    return { valid: true, reason: "status message, likely followed by file operations" };
  }
  
  const hasFileChanges = /file[s]? (changed|modified|created|updated|edited)/i.test(reply);
  const hasCodeBlocks = (reply.match(/```/g) || []).length >= 2;
  const hasDiff = /diff|patch|\+\+\+|---|modified:/i.test(reply);
  const hasToolCalls = /tool[_\s]call|function|invoke|execute/i.test(reply);
  const hasNativeToolCalls = /<function\(|<invoke|<tool_call>/i.test(reply);
  const hasWriteFile = /<function\(write\)|write_file|edit_file|search_replace/i.test(reply);
  const hasSuccessMessage = /successfully (created|modified|updated|wrote)|completed|done creating/i.test(reply);
  
  const isPureChat = !hasFileChanges && !hasCodeBlocks && !hasDiff && !hasToolCalls && !hasNativeToolCalls && !hasWriteFile && !hasSuccessMessage;
  const hasWeaselWords = /will|would|should|could|might|suggest|recommend|propose/i.test(text);
  
  if (isPureChat && replyLength < 500) {
    return { valid: false, reason: "reply appears to be pure chat without code artifacts" };
  }
  
  if (isPureChat && hasWeaselWords && replyLength < 1000) {
    return { valid: false, reason: "reply contains suggestions but no concrete code changes" };
  }
  
  return { valid: true, reason: "appears to contain code artifacts" };
  */
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
// (system-level agents trusted to run commands as part of their role)
const AUTO_APPROVE_CMD_AGENTS = new Set(["crew-fixer", "crew-github", "crew-pm"]);

// Pending command approvals: approvalId → { resolve, timer }
const pendingCmdApprovals = new Map();

// Module-level RT client ref so executeToolCalls can publish approval requests
let _rtClientForApprovals = null;

// Per-role tool defaults — used when agent has no explicit alsoAllow in config
const AGENT_TOOL_ROLE_DEFAULTS = {
  'crew-qa':          new Set(['read_file']),
  'crew-coder':       new Set(['write_file','read_file','mkdir','run_cmd']),
  'crew-coder-front': new Set(['write_file','read_file','mkdir','run_cmd']),
  'crew-coder-back':  new Set(['write_file','read_file','mkdir','run_cmd']),
  'crew-frontend':    new Set(['write_file','read_file','mkdir','run_cmd']),
  'crew-fixer':       new Set(['write_file','read_file','mkdir','run_cmd']),
  'crew-github':      new Set(['read_file','run_cmd','git']),
  'crew-pm':          new Set(['read_file','dispatch']),
  'crew-main':        new Set(['read_file','write_file','run_cmd','dispatch']),
  'crew-security':    new Set(['read_file','run_cmd']),
  'crew-copywriter':  new Set(['write_file','read_file']),
  'crew-telegram':    new Set(['telegram','read_file']),
  'crew-lead':        new Set(['dispatch']),
};

// CrewSwarm @@TOOL permission names — distinct from legacy gateway tool names
const CREWSWARM_TOOL_NAMES = new Set(['write_file','read_file','mkdir','run_cmd','git','dispatch']);

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
  // Unknown agent — allow read/write/mkdir/run by default
  return new Set(['read_file','write_file','mkdir','run_cmd']);
}

function buildToolInstructions(allowed) {
  const tools = [];
  if (allowed.has('write_file')) tools.push(`### Write a file to disk:
@@WRITE_FILE /absolute/path/to/file.html
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
  if (!tools.length) return ""; // agent has no tools — instructions not needed

  return `
## Agent Tools — ACTIVE for this session

When your task requires actions on disk or network, output the tool markers below directly in your reply.
The system detects and executes them automatically. ALWAYS use absolute paths.

${tools.join("\n\n")}

CRITICAL RULES:
- Output the @@TOOL markers directly — do NOT describe or simulate what you would do.
- Use @@WRITE_FILE to write files — never just show code in markdown blocks.
- @@END_FILE MUST appear on its own line immediately after the last line of file content.
- ALL tool calls go in a SINGLE reply — do NOT stop after @@MKDIR and wait for results. Chain @@MKDIR then @@WRITE_FILE immediately in the same response.
- Do NOT write "**Tool execution results:**" — the system appends that automatically.
- Do NOT wrap file contents in markdown fences inside @@WRITE_FILE...@@END_FILE blocks.
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

// ── Token/cost accumulator ────────────────────────────────────────────────────
const TOKEN_USAGE_FILE = path.join(os.homedir(), ".crewswarm", "token-usage.json");

const tokenUsage = (() => {
  try { return JSON.parse(fs.readFileSync(TOKEN_USAGE_FILE, "utf8")); } catch {}
  return { calls: 0, prompt: 0, completion: 0, byModel: {}, sessionStart: new Date().toISOString() };
})();

function recordTokenUsage(modelId, usage) {
  if (!usage) return;
  const p = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const c = Number(usage.completion_tokens || usage.output_tokens || 0);
  if (!p && !c) return;
  tokenUsage.calls++;
  tokenUsage.prompt     += p;
  tokenUsage.completion += c;
  if (!tokenUsage.byModel[modelId]) tokenUsage.byModel[modelId] = { calls: 0, prompt: 0, completion: 0 };
  tokenUsage.byModel[modelId].calls++;
  tokenUsage.byModel[modelId].prompt     += p;
  tokenUsage.byModel[modelId].completion += c;
  // Flush to disk every 5 calls
  if (tokenUsage.calls % 5 === 0) {
    try {
      fs.mkdirSync(path.dirname(TOKEN_USAGE_FILE), { recursive: true });
      fs.writeFileSync(TOKEN_USAGE_FILE, JSON.stringify(tokenUsage, null, 2));
    } catch {}
  }
}

// Sanitize paths from agent replies — strip markdown/hallucination (backticks, trailing punctuation)
function sanitizeToolPath(raw) {
  if (typeof raw !== "string") return "";
  let s = raw.trim().replace(/\s+/g, " ").replace(/`/g, "");
  while (s.length > 1 && (s.endsWith(".") || s.endsWith(","))) s = s.slice(0, -1).trim();
  s = s.replace(/^~/, os.homedir());
  return s;
}

async function executeToolCalls(reply, agentId) {
  const allowed = loadAgentToolPermissions(agentId);
  const results = [];

  // ── @@WRITE_FILE ──────────────────────────────────────────────────────────
  const writeRe = /@@WRITE_FILE[ \t]+([^\n]+)\n([\s\S]*?)@@END_FILE/g;
  let m;
  while ((m = writeRe.exec(reply)) !== null) {
    if (!allowed.has('write_file')) {
      results.push(`[tool:write_file] ⛔ ${agentId} does not have write_file permission`);
      continue;
    }
    const filePath = sanitizeToolPath(m[1]);
    const contents = m[2];
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, contents, "utf8");
      const msg = `[tool:write_file] ✅ Wrote ${contents.length} bytes → ${filePath}`;
      results.push(msg);
      console.log(`[${agentId}] ${msg}`);
    } catch (err) {
      const msg = `[tool:write_file] ❌ Failed to write ${filePath}: ${err.message}`;
      results.push(msg);
      console.error(`[${agentId}] ${msg}`);
    }
  }

  // ── @@READ_FILE ───────────────────────────────────────────────────────────
  const readRe = /@@READ_FILE[ \t]+([^\n]+)/g;
  while ((m = readRe.exec(reply)) !== null) {
    if (!allowed.has('read_file')) {
      results.push(`[tool:read_file] ⛔ ${agentId} does not have read_file permission`);
      continue;
    }
    const filePath = sanitizeToolPath(m[1]);
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const snippet = content.length > 4000 ? content.slice(0, 4000) + "\n...[truncated]" : content;
      results.push(`[tool:read_file] 📄 ${filePath} (${content.length} bytes):\n${snippet}`);
    } catch (err) {
      results.push(`[tool:read_file] ❌ Cannot read ${filePath}: ${err.message}`);
    }
  }

  // ── @@MKDIR ───────────────────────────────────────────────────────────────
  const mkdirRe = /@@MKDIR[ \t]+([^\n]+)/g;
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
    const needsApproval = !isGit && !AUTO_APPROVE_CMD_AGENTS.has(agentId) && !isCommandAllowlisted(cmd) && _rtClientForApprovals;
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

  return results;
}

function shouldUseOpenCode(payload, prompt, incomingType) {
  if (!OPENCREW_OPENCODE_ENABLED) return false;
  if (OPENCREW_OPENCODE_FORCE) return true;

  if (incomingType !== "command.run_task" && incomingType !== "task.assigned") return false;

  // Only use OpenCode if explicitly requested via runtime flag or payload hint.
  // All other tasks route through legacy gateway using the agent's configured model.
  const runtime = String(payload?.runtime || payload?.executor || payload?.engine || "").toLowerCase();
  if (runtime === "opencode" || runtime === "codex" || runtime === "gpt5" || runtime === "gpt-5") return true;
  if (payload?.useOpenCode === true) return true;
  return false;
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

function runOpenCodeTask(prompt, payload = {}) {
  return new Promise((resolve, reject) => {
    // Skip protocol check for OpenCode - it doesn't need memory wrapper
    const bin = fs.existsSync(OPENCREW_OPENCODE_BIN) ? OPENCREW_OPENCODE_BIN : "opencode";
    const model = String(payload?.model || OPENCREW_OPENCODE_MODEL);
    const agent = String(payload?.agent || OPENCREW_OPENCODE_AGENT || "").trim();
    const projectDir = String(payload?.projectDir || OPENCREW_OPENCODE_PROJECT || process.cwd());
    
    // Fixed: use --model (not -m), and proper command structure
    const args = ["run", String(prompt), "--model", model, "--dir", projectDir];
    if (agent) args.push("--agent", agent);

    console.error(`[OpenCode] Running: ${bin} ${args.join(' ')}`); // Debug log

    const cleanEnv = { ...process.env };
    delete cleanEnv.OPENCODE_SERVER_USERNAME;
    delete cleanEnv.OPENCODE_SERVER_PASSWORD;
    delete cleanEnv.OPENCODE_CLIENT;
    delete cleanEnv.OPENCODE;

    const child = spawn(bin, args, {
      cwd: projectDir,
      env: cleanEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`OpenCode timeout after ${OPENCREW_OPENCODE_TIMEOUT_MS}ms`));
    }, OPENCREW_OPENCODE_TIMEOUT_MS);

    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        console.error(`[OpenCode] Failed: ${stderr || stdout}`); // Debug log
        reject(new Error(`OpenCode exited ${code}: ${stderr || stdout || "unknown error"}`));
        return;
      }
      const out = (stdout || stderr || "").trim();
      console.error(`[OpenCode] Success: ${out.substring(0, 200)}...`); // Debug log
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

function buildTaskPrompt(taskText, sourceLabel, agentId) {
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

  // Load agent-specific extra memory (e.g. lessons.md for coders + fixer)
  const extraMemoryFiles = AGENT_EXTRA_MEMORY[agentId] || (bareId && AGENT_EXTRA_MEMORY[`crew-${bareId}`]) || [];
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
      const model       = agentCfg.model || "unknown model";
      identityHeader = `You are ${emoji ? emoji + " " : ""}${displayName} (agent ID: ${agentId}, model: ${model}).`;
    }
  }

  const parts = [];
  if (identityHeader) parts.push(identityHeader);
  if (agentSystemPrompt) parts.push(agentSystemPrompt);
  if (toolInstructions) parts.push(toolInstructions);
  if (sharedMemory.text) parts.push(sharedMemory.text);
  if (extraMemorySections.length > 0) parts.push(extraMemorySections.join("\n\n"));
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
 */
async function runSendToAgent(agentId, message, { timeoutMs = Number(process.env.OPENCREW_RT_SEND_TIMEOUT_MS || "120000") } = {}) {
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

  try {
    rt.publish({
      channel: "command",
      type: "command.run_task",
      to: agentId,
      taskId,
      correlationId,
      priority: "high",
      payload: {
        action: "run_task",
        prompt: message,
        message,
        source: sender,
        idempotencyKey: correlationId,
      },
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
    const { finalPrompt, sharedMemory } = buildTaskPrompt(prompt, `Realtime task from ${from} (${incomingType})`, OPENCREW_RT_AGENT);
    if (sharedMemory.loadFailed || finalPrompt === "MEMORY_LOAD_FAILED") {
      throw new Error("MEMORY_LOAD_FAILED");
    }
    assertTaskPromptProtocol(finalPrompt, "realtime");

    const useOpenCode = shouldUseOpenCode(payload, prompt, incomingType);
    if (useOpenCode) {
      const routeAgent = String(payload?.agent || OPENCREW_OPENCODE_AGENT || "default");
      const routeModel = String(payload?.model || OPENCREW_OPENCODE_MODEL);
      progress(`Routing realtime task to OpenCode (${routeAgent}/${routeModel})...`);
      telemetry("realtime_route_opencode", { taskId, incomingType, from, model: routeModel, agent: routeAgent });
    }
    let reply;
    if (useOpenCode) {
      try {
        reply = await runOpenCodeTask(finalPrompt, payload);
      } catch (opencodeErr) {
        const msg = opencodeErr?.message ?? String(opencodeErr);
        if (bridge?.kind === "gateway") {
          telemetry("realtime_opencode_fallback", { taskId, incomingType, error: msg });
          progress(`OpenCode route failed, falling back to legacy gateway model: ${msg.slice(0, 120)}`);
          const gatewayAgentId = RT_TO_GATEWAY_AGENT_MAP[OPENCREW_RT_AGENT] || "main";
          reply = await bridge.chat(finalPrompt, gatewayAgentId, { idempotencyKey: dispatchKey });
        } else {
          throw opencodeErr;
        }
      }
    } else {
      // Try direct LLM call first (uses agent's configured model/provider from crewswarm.json)
      const ocAgentId = RT_TO_GATEWAY_AGENT_MAP[OPENCREW_RT_AGENT] || "main";
      const agentSysPrompt = loadAgentPrompts()[ocAgentId] || null;
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

    // Execute any tool calls embedded in the agent's reply
    const toolResults = await executeToolCalls(reply, OPENCREW_RT_AGENT);
    if (toolResults.length > 0) {
      reply = reply + "\n\n---\n**Tool execution results:**\n" + toolResults.join("\n");
      telemetry("agent_tools_executed", { taskId, agent: OPENCREW_RT_AGENT, count: toolResults.length });
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

    // Parse and execute @@DISPATCH commands from coordinator agents (crew-main, crew-pm only).
    // Format: @@DISPATCH:agent-id|task description
    // Non-coordinator agents are blocked from dispatching to prevent loops.
    const COORDINATOR_AGENTS = new Set(["crew-main", "crew-pm"]);
    const dispatchMatches = COORDINATOR_AGENTS.has(OPENCREW_RT_AGENT)
      ? [...reply.matchAll(/@@DISPATCH:([a-z0-9_-]+)\|([^\n@@]+)/g)]
      : [];
    if (dispatchMatches.length > 0) {
      for (const m of dispatchMatches) {
        const targetAgent = m[1].trim();
        const taskText = m[2].trim();
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

async function runRealtimeDaemon(bridge) {
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

  progress("Loading local identity/config...");
  const creds = loadCredentials();
  if (args.includes("--quickstart")) telemetry("onboarding_started", { source: "--quickstart" });

  if (shouldConnectGateway(args)) {
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
    const reply = await runSendToAgent(agentId, message);
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
