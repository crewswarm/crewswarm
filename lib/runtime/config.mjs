/**
 * Runtime config constants and path definitions — extracted from gateway-bridge.mjs.
 * Dependencies: fs, path, os, crypto
 */

/**
 * @typedef {{ apiKey?: string, baseUrl?: string }} ProviderConfig
 */

/**
 * @typedef {{
 *   id: string,
 *   model?: string,
 *   role?: string,
 *   fallbackModel?: string,
 *   useCrewCLI?: boolean,
 *   engine?: string,
 *   identity?: { name?: string, emoji?: string, theme?: string },
 *   name?: string,
 *   emoji?: string
 * }} AgentConfig
 */

/**
 * @typedef {{
 *   rt?: { authToken?: string },
 *   claudeCode?: boolean,
 *   cursorWaves?: boolean,
 *   bgConsciousness?: boolean,
 *   bgConsciousnessModel?: string,
 *   providers?: Record<string, ProviderConfig>,
 *   loopBrain?: string,
 *   env?: Record<string, string>
 * }} SystemConfig
 */

/**
 * @typedef {{
 *   agents?: AgentConfig[],
 *   providers?: Record<string, ProviderConfig>,
 *   env?: Record<string, string>,
 *   codex?: boolean,
 *   globalFallbackModel?: string
 * }} SwarmConfig
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// ── Path constants ─────────────────────────────────────────────────────────
/** Repo root of this checkout (`lib/runtime` → `../..`). Not `process.cwd()` — crew-lead may start from any cwd. */
const _RUNTIME_DIR = path.dirname(fileURLToPath(import.meta.url));
export const CREWSWARM_REPO_ROOT =
  (process.env.CREWSWARM_REPO_ROOT && String(process.env.CREWSWARM_REPO_ROOT).trim())
    ? path.resolve(process.env.CREWSWARM_REPO_ROOT)
    : path.resolve(_RUNTIME_DIR, "..", "..");

export const LEGACY_STATE_DIR = path.join(os.homedir(), ".openclaw");
export const CREWSWARM_DIR = path.join(os.homedir(), ".crewswarm");
export const CREWSWARM_CONFIG_PATH = path.join(CREWSWARM_DIR, "config.json");
export const CREWSWARM_SWARM_PATH = path.join(CREWSWARM_DIR, "crewswarm.json");
export const TELEGRAM_BRIDGE_CONFIG_PATH = path.join(CREWSWARM_DIR, "telegram-bridge.json");
export const TELEMETRY_DIR = path.join(LEGACY_STATE_DIR, "telemetry");

// ── Unified config readers ────────────────────────────────────────────────
// Single source of truth for reading the two JSON config files.
// Every module should use these instead of inline readFileSync calls.

function _tryReadJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null; // file doesn't exist yet — normal on first run
    // Surface parse errors and permission issues so users don't get silent zero-config
    console.error(`[config] Failed to read ${filePath}: ${err.message}`);
    return null;
  }
}

/**
 * Read ~/.crewswarm/crewswarm.json (system/dashboard config)
 * Contains: rt.authToken, claudeCode, providers, opencodeFallbackModel, etc.
 * @returns {SystemConfig}
 */
export function loadSystemConfig() {
  return _tryReadJSON(CREWSWARM_CONFIG_PATH) || {};
}

/**
 * Read ~/.crewswarm/crewswarm.json (agent definitions, providers, env)
 * Contains: agents[], providers{}, env{}, globalFallbackModel, etc.
 * @returns {SwarmConfig}
 */
export function loadSwarmConfig() {
  return _tryReadJSON(CREWSWARM_SWARM_PATH) || {};
}

/**
 * Load agent list from crewswarm.json (with legacy fallback)
 * Returns the agents array — the most commonly needed config value.
 * @returns {AgentConfig[]}
 */
export function loadAgentList() {
  const swarm = loadSwarmConfig();
  const agents = Array.isArray(swarm.agents) ? swarm.agents
    : Array.isArray(swarm.agents?.list) ? swarm.agents.list
      : [];
  return agents;
}

/**
 * Resolve a provider config by key (checks both config files)
 * @param {string} providerKey - e.g. "groq", "google", "anthropic"
 * @returns {ProviderConfig | null}
 */
export function resolveProvider(providerKey) {
  const swarm = loadSwarmConfig();
  const sys = loadSystemConfig();
  return swarm?.providers?.[providerKey] || sys?.providers?.[providerKey] || null;
}

// ── Built-in provider base URLs — users only need to supply apiKey ──────────
export const PROVIDER_REGISTRY = {
  groq: { baseUrl: "https://api.groq.com/openai/v1" },
  fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1" },
  anthropic: { baseUrl: "https://api.anthropic.com/v1" },
  openai: { baseUrl: "https://api.openai.com/v1" },
  perplexity: { baseUrl: "https://api.perplexity.ai" },
  mistral: { baseUrl: "https://api.mistral.ai/v1" },
  deepseek: { baseUrl: "https://api.deepseek.com/v1" },
  together: { baseUrl: "https://api.together.xyz/v1" },
  nvidia: { baseUrl: "https://integrate.api.nvidia.com/v1" },
  google: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  xai: { baseUrl: "https://api.x.ai/v1" },
  ollama: { baseUrl: "http://localhost:11434/v1" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1" },
  "openai-compatible": { baseUrl: null }, // user must supply baseUrl
};

// ── Memory / RT constants ────────────────────────────────────────────────────
export const MEMORY_BOOTSTRAP_AGENT = "gateway-bridge";
export const GATEWAY_URL = "ws://127.0.0.1:18889";

// MEMORY_PROTOCOL_MARKER is used with getLastHandoffTimestamp — must be a fn that returns the full protocol
// For config export we only need the marker string; the full SHARED_MEMORY_PROTOCOL is built in memory.mjs
export const MEMORY_PROTOCOL_MARKER = "Mandatory memory protocol (apply for this task):";

// ── RT config from process.env ──────────────────────────────────────────────
export const CREWSWARM_RT_URL = process.env.CREWSWARM_RT_URL || "ws://127.0.0.1:18889";
export const CREWSWARM_RT_AGENT = process.env.CREWSWARM_RT_AGENT || "crew-main";

export function getRTToken() {
  let token = process.env.CREWSWARM_RT_AUTH_TOKEN || "";
  if (!token) {
    const cfg = loadSystemConfig();
    token = cfg?.rt?.authToken || cfg?.env?.CREWSWARM_RT_AUTH_TOKEN || "";
  }
  return typeof token === "string" ? token.trim() : "";
}

export const CREWSWARM_RT_TOKEN = getRTToken();
export const CREWSWARM_RT_CHANNELS = (process.env.CREWSWARM_RT_CHANNELS || "command,assign,handoff,reassign,events")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const CREWSWARM_RT_TLS_INSECURE = process.env.CREWSWARM_RT_TLS_INSECURE === "1";
export const CREWSWARM_RT_RECONNECT_MS = Number(process.env.CREWSWARM_RT_RECONNECT_MS || "1500");
export const CREWSWARM_RT_DISPATCH_ENABLED = (process.env.CREWSWARM_RT_DISPATCH_ENABLED || "1") !== "0";
export const CREWSWARM_RT_DISPATCH_LEASE_MS = Number(process.env.CREWSWARM_RT_DISPATCH_LEASE_MS || "45000");
export const CREWSWARM_RT_DISPATCH_HEARTBEAT_MS = Number(process.env.CREWSWARM_RT_DISPATCH_HEARTBEAT_MS || "10000");
export const CREWSWARM_RT_DISPATCH_MAX_RETRIES = Number(process.env.CREWSWARM_RT_DISPATCH_MAX_RETRIES || "2");
export const CREWSWARM_RT_DISPATCH_MAX_RETRIES_CODING = Number(process.env.CREWSWARM_RT_DISPATCH_MAX_RETRIES_CODING || "3");
export const CREWSWARM_RT_DISPATCH_RETRY_BACKOFF_MS = Number(process.env.CREWSWARM_RT_DISPATCH_RETRY_BACKOFF_MS || "2000");
export const CREWSWARM_OPENCODE_ENABLED = (process.env.CREWSWARM_OPENCODE_ENABLED || "1") !== "0";
export const CREWSWARM_CURSOR_WAVES = process.env.CREWSWARM_CURSOR_WAVES === "1";
export const CREWSWARM_CLAUDE_CODE = (() => {
  if (process.env.CREWSWARM_CLAUDE_CODE) return /^1|true|yes$/i.test(String(process.env.CREWSWARM_CLAUDE_CODE));
  const cfg = loadSystemConfig();
  if (typeof cfg.claudeCode === "boolean") return cfg.claudeCode;
  return false;
})();
export const CREWSWARM_OPENCODE_FORCE = process.env.CREWSWARM_OPENCODE_FORCE === "1";
export const CREWSWARM_OPENCODE_BIN = process.env.CREWSWARM_OPENCODE_BIN || path.join(os.homedir(), ".opencode", "bin", "opencode");
export const CREWSWARM_OPENCODE_AGENT = process.env.CREWSWARM_OPENCODE_AGENT || "admin";
export const CREWSWARM_OPENCODE_MODEL = process.env.CREWSWARM_OPENCODE_MODEL || "groq/moonshotai/kimi-k2-instruct-0905";
export const CREWSWARM_OPENCODE_FALLBACK_DEFAULT = "groq/llama-3.3-70b-versatile";
export const CREWSWARM_OPENCODE_TIMEOUT_MS = Number(process.env.CREWSWARM_OPENCODE_TIMEOUT_MS || "300000");

// ── Generic drop-in engine loader ───────────────────────────────────────────
export const ENGINES_BUNDLED_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "engines");
export const ENGINES_USER_DIR = path.join(os.homedir(), ".crewswarm", "engines");

function _loadAllEngineJSONs() {
  const engines = [];
  for (const dir of [ENGINES_BUNDLED_DIR, ENGINES_USER_DIR]) {
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
      for (const file of files) {
        try {
          const def = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
          if (def?.id) engines.push(def);
        } catch { }
      }
    } catch { }
  }
  return engines;
}

/**
 * Load all engines from JSON files (both bundled and user-defined)
 * NOTE: Now fully dynamic - all engines (including built-ins) route via engine-registry.mjs
 */
export function loadAllEngines() {
  return _loadAllEngineJSONs().filter(e => e.id && e.shouldUse);
}

/**
 * Legacy: Load only "generic" engines (for backwards compatibility)
 * Now delegates to loadAllEngines since hardcoded distinction is removed
 */
export function loadGenericEngines() {
  return loadAllEngines().filter(e => e.bin && e.args?.run);
}

// ── Shared memory paths ─────────────────────────────────────────────────────
export const SHARED_MEMORY_BASE = process.env.SHARED_MEMORY_DIR || path.join(os.homedir(), ".crewswarm", "workspace", "shared-memory");
export const SHARED_MEMORY_NAMESPACE = process.env.SHARED_MEMORY_NAMESPACE || "claw-swarm";
export const SWARM_STATUS_LOG = path.join(SHARED_MEMORY_BASE, SHARED_MEMORY_NAMESPACE, "opencrew-rt", "channels", "status.jsonl");
export const SWARM_DISPATCH_DIR = path.join(SHARED_MEMORY_BASE, SHARED_MEMORY_NAMESPACE, "opencrew-rt", "dispatch");
export const SWARM_DLQ_DIR = path.join(SHARED_MEMORY_BASE, SHARED_MEMORY_NAMESPACE, "opencrew-rt", "dlq");
export const SWARM_HEARTBEAT_WINDOW_SEC = Number(process.env.CREWSWARM_RT_HEARTBEAT_WINDOW_SEC || "90");
export const CREWSWARM_RT_TASK_LEASE_MS = Number(process.env.CREWSWARM_RT_TASK_LEASE_MS || "120000");
export const CREWSWARM_RT_TASK_HEARTBEAT_MS = Number(process.env.CREWSWARM_RT_TASK_HEARTBEAT_MS || "15000");
export const CREWSWARM_RT_TASK_RETRY_MAX = Number(process.env.CREWSWARM_RT_TASK_RETRY_MAX || "2");
export const CREWSWARM_RT_TASK_STATE_TTL_MS = Number(process.env.CREWSWARM_RT_TASK_STATE_TTL_MS || "21600000");
export const SWARM_RUNTIME_DIR = path.join(SHARED_MEMORY_BASE, SHARED_MEMORY_NAMESPACE, "opencrew-rt", "runtime");
export const SWARM_TASK_LEASE_DIR = path.join(SWARM_RUNTIME_DIR, "task-leases");
export const SWARM_TASK_STATE_DIR = path.join(SWARM_RUNTIME_DIR, "task-state");

// ── Misc constants ─────────────────────────────────────────────────────────
export const CREWSWARM_RT_COMMAND_TYPES = new Set([
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
export const PROTOCOL_VERSION = 3;
export const CLI_VERSION = "1.2.0";
export const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
export const REQUEST_TIMEOUT_MS = 60000;
export const CHAT_TIMEOUT_MS = 55000;
export const RUN_ID = crypto.randomUUID();

// ── crew-lead.mjs constants ───────────────────────────────────────────────
export const CREW_LEAD_PORT = Number(process.env.CREW_LEAD_PORT || 5010);
export const CREW_LEAD_PID_PATH = path.join(os.homedir(), ".crewswarm", "logs", "crew-lead.pid");
export const CREW_LEAD_HISTORY_DIR = path.join(os.homedir(), ".crewswarm", "chat-history");
export const PROJECTS_REGISTRY = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "crew-lead", "orchestrator-logs", "projects.json");
export const MAX_HISTORY = 2000;
export const LLM_TIMEOUT = 180000;
export const CTL_PATH = (() => {
  const homeBin = path.join(os.homedir(), "bin", "openswitchctl");
  if (fs.existsSync(homeBin)) return homeBin;
  return path.join(process.cwd(), "scripts", "openswitchctl");
})();
export const DASH_PORT = Number(process.env.SWARM_DASH_PORT || 4319);
export const DASH_HOST = process.env.CREWSWARM_RT_HOST || "127.0.0.1";
export const DASHBOARD = `http://${DASH_HOST}:${DASH_PORT}`;
export const DISPATCH_TIMEOUT_MS = Number(process.env.CREWSWARM_DISPATCH_TIMEOUT_MS) || 300_000;
export const DISPATCH_CLAIMED_TIMEOUT_MS = Number(process.env.CREWSWARM_DISPATCH_CLAIMED_TIMEOUT_MS) || 900_000;

export function loadCursorWavesEnabled() {
  if (process.env.CREWSWARM_CURSOR_WAVES) return /^1|true|yes$/i.test(String(process.env.CREWSWARM_CURSOR_WAVES));
  const cfg = loadSystemConfig();
  if (typeof cfg.cursorWaves === "boolean") return cfg.cursorWaves;
  return false;
}

export function loadClaudeCodeEnabled() {
  if (process.env.CREWSWARM_CLAUDE_CODE) return /^1|true|yes$/i.test(String(process.env.CREWSWARM_CLAUDE_CODE));
  const cfg = loadSystemConfig();
  if (typeof cfg.claudeCode === "boolean") return cfg.claudeCode;
  return false;
}
// ── Configuration Parsers (Migrated from registry.mjs) ───────────────────
export function resolveConfig() {
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

export function resolveTelegramBridgeConfig() {
  try {
    return JSON.parse(fs.readFileSync(TELEGRAM_BRIDGE_CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function loadProviderMap() {
  const sources = [
    CREWSWARM_SWARM_PATH,
    CREWSWARM_CONFIG_PATH,
  ];
  const merged = {};
  for (const p of sources) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
      const provs = cfg.providers || cfg.models?.providers || {};
      for (const [k, v] of Object.entries(provs)) {
        if (!merged[k] && v?.apiKey && v?.baseUrl) merged[k] = v;
      }
    } catch { }
  }
  return merged;
}

export function loadAgentLLMConfig(ocAgentId) {
  try {
    const agents = loadAgentList();
    const crewId = ocAgentId.startsWith("crew-") ? ocAgentId : `crew-${ocAgentId}`;
    const bareId = ocAgentId.startsWith("crew-") ? ocAgentId.slice(5) : ocAgentId;
    const agent = agents.find(a => a.id === ocAgentId) ||
      agents.find(a => a.id === crewId) ||
      agents.find(a => a.id === bareId);
    if (!agent?.model) return null;

    const [providerKey, ...modelParts] = agent.model.split("/");
    let modelId = modelParts.join("/");
    const providers = loadProviderMap();
    const provider = providers[providerKey];
    if (!provider?.baseUrl || !provider?.apiKey) {
      console.warn(`[bridge] No provider config for "${providerKey}" (agent ${ocAgentId}) — check ~/.crewswarm/crewswarm.json providers`);
      return null;
    }
    // OpenRouter requires full ID (e.g. openrouter/hunter-alpha), not bare "hunter-alpha"
    if ((providerKey === "openrouter" || (provider.baseUrl || "").includes("openrouter.ai")) && modelId && !modelId.startsWith("openrouter/")) {
      modelId = "openrouter/" + modelId;
    }

    return { baseUrl: provider.baseUrl, apiKey: provider.apiKey, modelId, agentId: agent.id, providerKey, fallbackModel: agent.fallbackModel || null };
  } catch (e) {
    console.warn(`[bridge] loadAgentLLMConfig error: ${e.message}`);
    return null;
  }
}

export function loadLoopBrainConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CREWSWARM_CONFIG_PATH, "utf8"));
    const loopBrain = cfg.loopBrain || process.env.CREWSWARM_LOOP_BRAIN || null;
    if (!loopBrain) return null;
    const [providerKey, ...modelParts] = loopBrain.split("/");
    let modelId = modelParts.join("/");
    const providers = loadProviderMap();
    const provider = providers[providerKey];
    if (!provider?.baseUrl || !provider?.apiKey) return null;
    // OpenRouter requires full ID (e.g. openrouter/hunter-alpha), not bare "hunter-alpha"
    if ((providerKey === "openrouter" || (provider.baseUrl || "").includes("openrouter.ai")) && modelId && !modelId.startsWith("openrouter/")) {
      modelId = "openrouter/" + modelId;
    }
    return { baseUrl: provider.baseUrl, apiKey: provider.apiKey, modelId, providerKey };
  } catch { return null; }
}

export function resolveProviderConfig(cfg, providerKey) {
  const explicit = cfg?.models?.providers?.[providerKey] || cfg?.providers?.[providerKey];
  const builtin = PROVIDER_REGISTRY[providerKey];
  if (!explicit && !builtin) return null;
  return {
    baseUrl: explicit?.baseUrl || builtin?.baseUrl,
    apiKey: explicit?.apiKey || cfg?.env?.[`${providerKey.toUpperCase()}_API_KEY`] || null,
  };
}
