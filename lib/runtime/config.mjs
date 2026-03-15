/**
 * Runtime config constants and path definitions — extracted from gateway-bridge.mjs.
 * Dependencies: fs, path, os, crypto
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// ── Path constants ─────────────────────────────────────────────────────────
export const LEGACY_STATE_DIR = path.join(os.homedir(), ".openclaw");
export const CREWSWARM_DIR = path.join(os.homedir(), ".crewswarm");
export const CREWSWARM_CONFIG_PATH = path.join(CREWSWARM_DIR, "config.json");
export const TELEGRAM_BRIDGE_CONFIG_PATH = path.join(CREWSWARM_DIR, "telegram-bridge.json");
export const TELEMETRY_DIR = path.join(LEGACY_STATE_DIR, "telemetry");

// ── Built-in provider base URLs — users only need to supply apiKey ──────────
export const PROVIDER_REGISTRY = {
  groq:        { baseUrl: "https://api.groq.com/openai/v1" },
  anthropic:   { baseUrl: "https://api.anthropic.com/v1" },
  openai:      { baseUrl: "https://api.openai.com/v1" },
  perplexity:  { baseUrl: "https://api.perplexity.ai" },
  mistral:     { baseUrl: "https://api.mistral.ai/v1" },
  deepseek:   { baseUrl: "https://api.deepseek.com/v1" },
  nvidia:     { baseUrl: "https://integrate.api.nvidia.com/v1" },
  google:     { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  xai:        { baseUrl: "https://api.x.ai/v1" },
  ollama:     { baseUrl: "http://localhost:11434/v1" },
  "openai-compatible": { baseUrl: null }, // user must supply baseUrl
};

// ── Memory / RT constants ────────────────────────────────────────────────────
export const MEMORY_BOOTSTRAP_AGENT = "gateway-bridge";
export const GATEWAY_URL = "ws://127.0.0.1:18789";

// MEMORY_PROTOCOL_MARKER is used with getLastHandoffTimestamp — must be a fn that returns the full protocol
// For config export we only need the marker string; the full SHARED_MEMORY_PROTOCOL is built in memory.mjs
export const MEMORY_PROTOCOL_MARKER = "Mandatory memory protocol (apply for this task):";

// ── RT config from process.env ──────────────────────────────────────────────
export const CREWSWARM_RT_URL = process.env.CREWSWARM_RT_URL || "ws://127.0.0.1:18889";
export const CREWSWARM_RT_AGENT = process.env.CREWSWARM_RT_AGENT || "crew-main";

export function getRTToken() {
  let token = process.env.CREWSWARM_RT_AUTH_TOKEN || "";
  if (!token) {
    try {
      const cfg = JSON.parse(fs.readFileSync(CREWSWARM_CONFIG_PATH, "utf8"));
      token = cfg?.rt?.authToken || cfg?.env?.CREWSWARM_RT_AUTH_TOKEN || "";
    } catch {}
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
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "config.json"), "utf8"));
    if (typeof cfg.claudeCode === "boolean") return cfg.claudeCode;
  } catch {}
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
        } catch {}
      }
    } catch {}
  }
  return engines;
}

/**
 * Load all engines from JSON files (both bundled and user-defined)
 * NOTE: Now fully dynamic - all engines (including built-ins) route via engine-registry.mjs
 */
export function loadAllEngines() {
  return _loadAllEngineJSONs().filter(e => e.id && e.priority !== undefined && e.shouldUse);
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
