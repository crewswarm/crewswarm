/**
 * engine-registry.mjs — Dynamic engine registration and routing
 * Engines load from JSON; selection is explicit (payload + per-agent config) then deterministic fallback.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadAgentList as _defaultLoadAgentList } from "../runtime/config.mjs";
import { isCodingTask } from "../agents/dispatch.mjs";

const ENGINES_BUNDLED_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "engines");
const ENGINES_USER_DIR = path.join(os.homedir(), ".crewswarm", "engines");

let _engines = [];
let _engineRunners = {}; // id → run function
let _loadAgentList = _defaultLoadAgentList;

/** Map dashboard / config `engine` strings → canonical engine id */
const ENGINE_ALIAS_TO_ID = Object.freeze({
  codex: "codex",
  "codex-cli": "codex",
  claude: "claude-code",
  "claude-code": "claude-code",
  cursor: "cursor",
  "cursor-cli": "cursor",
  opencode: "opencode",
  gpt5: "opencode",
  "gpt-5": "opencode",
  "gemini-cli": "gemini-cli",
  gemini: "gemini-cli",
  "crew-cli": "crew-cli",
  crewcli: "crew-cli",
  "docker-sandbox": "docker-sandbox",
});

/**
 * Single preferred engine for this task from crewswarm.json (use* flags + `engine` string).
 * Returns null → no explicit per-agent preference (global env toggles may still apply in fallback).
 */
function resolveAgentPreferredEngineId(payload) {
  const agentId = String(payload?.agentId || payload?.agent || "").toLowerCase();
  if (!agentId || !_loadAgentList) return null;
  try {
    const agents = _loadAgentList() || [];
    const cfg = agents.find((a) => a.id === agentId || a.id === `crew-${agentId}`);
    if (!cfg) return null;
    if (cfg.useCodex === true) return "codex";
    if (cfg.useClaudeCode === true) return "claude-code";
    if (cfg.useOpenCode === true) return "opencode";
    if (cfg.useCursorCli === true || cfg.useCursor === true) return "cursor";
    if (cfg.useGeminiCli === true) return "gemini-cli";
    if (cfg.useCrewCLI === true) return "crew-cli";
    if (cfg.useDockerSandbox === true) return "docker-sandbox";
    const raw = String(cfg.engine || "").toLowerCase();
    if (!raw || raw === "direct" || raw === "api" || raw === "llm") return null;
    if (ENGINE_ALIAS_TO_ID[raw]) return ENGINE_ALIAS_TO_ID[raw];
    if (_engines.some((e) => e.id === raw)) return raw;
    return null;
  } catch {
    return null;
  }
}

/**
 * Initialize registry with dependencies
 */
export function initEngineRegistry({ loadAgentList, engineRunners }) {
  if (loadAgentList) _loadAgentList = loadAgentList;
  if (engineRunners) _engineRunners = engineRunners;
  loadAllEngines();
}

/**
 * Load all engines from JSON files
 */
function loadAllEngines() {
  _engines = [];

  for (const dir of [ENGINES_BUNDLED_DIR, ENGINES_USER_DIR]) {
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
      for (const file of files) {
        try {
          const def = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
          if (def?.id && def?.shouldUse) {
            _engines.push(def);
          }
        } catch (err) {
          console.warn(`[engine-registry] Failed to load ${file}:`, err.message);
        }
      }
    } catch {}
  }
  _engines.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/**
 * Evaluate shouldUse logic from JSON config
 */
function evaluateShouldUse(engineDef, payload, incomingType) {
  if (incomingType !== "command.run_task" && incomingType !== "task.assigned") {
    return false;
  }

  const { shouldUse } = engineDef;
  if (!shouldUse) return false;

  // Check runtime/executor
  const runtime = String(payload?.runtime || payload?.executor || payload?.engine || "").toLowerCase();
  if (shouldUse.runtime && Array.isArray(shouldUse.runtime)) {
    if (shouldUse.runtime.includes(runtime)) return true;
  }

  // Check payload key
  if (shouldUse.payloadKey && payload?.[shouldUse.payloadKey] === true) {
    return true;
  }

  // Check agent config
  if (shouldUse.agentConfigKey && _loadAgentList) {
    const agentId = String(payload?.agentId || payload?.agent || "").toLowerCase();
    try {
      const agents = _loadAgentList();
      const cfg = agents.find(a => a.id === agentId || a.id === `crew-${agentId}`);

      const cfgEngine = String(cfg?.engine || "").toLowerCase();
      const runtimeAliases = Array.isArray(shouldUse.runtime) ? shouldUse.runtime : [];

      if (cfg?.[shouldUse.agentConfigKey] === true) return true;
      if (cfgEngine && runtimeAliases.includes(cfgEngine)) return true;
    } catch {}
  }

  // Check env var — global toggle must NOT override a different per-agent engine choice
  if (shouldUse.envVar && process.env[shouldUse.envVar] === "1") {
    const preferred = resolveAgentPreferredEngineId(payload);
    if (preferred && preferred !== engineDef.id) return false;
    return true;
  }

  // Special logic for cursor orchestrator waves
  if (shouldUse.specialLogic === "orchestrator-waves") {
    const agentId = String(payload?.agentId || payload?.agent || "").toLowerCase();
    if (agentId === "crew-orchestrator" || agentId === "orchestrator") {
      if (process.env.CREWSWARM_CURSOR_WAVES === "1") return true;
    }
  }

  return false;
}

/**
 * Select engine: payload flags → payload runtime → per-agent crewswarm.json → fallback rules
 */
export function selectEngine(payload, incomingType) {
  // PRIORITY 0: Chat messages always use direct LLM, not CLI engines.
  // CLI engines (claude-code, cursor, codex, etc.) are only for coding tasks.
  // The agent's configured model handles conversational replies directly.
  const prompt = payload?.prompt || payload?.task || payload?.message || "";
  if (!isCodingTask(incomingType, prompt, payload)) {
    return null;
  }

  // PRIORITY 1: Payload flags (from enriched task)
  const explicitEngines = [
    { key: 'useCodex', id: 'codex' },
    { key: 'useCursor', id: 'cursor' },
    { key: 'useCursorCli', id: 'cursor' },
    { key: 'useClaudeCode', id: 'claude-code' },
    { key: 'useGeminiCli', id: 'gemini-cli' },
    { key: 'useCrewCLI', id: 'crew-cli' },
    { key: 'useOpenCode', id: 'opencode' },
    { key: 'useDockerSandbox', id: 'docker-sandbox' }
  ];

  for (const { key, id } of explicitEngines) {
    if (payload?.[key] === true) {
      const engine = _engines.find(e => e.id === id);
      if (engine) {
        return { ...engine, run: _engineRunners[engine.id] || null };
      }
    }
  }

  // PRIORITY 2: Check runtime/executor explicit request
  const runtime = String(payload?.runtime || payload?.executor || payload?.engine || "").toLowerCase();
  if (runtime) {
    const runtimeEngine = _engines.find(e =>
      e.id === runtime ||
      (e.shouldUse?.runtime && e.shouldUse.runtime.includes(runtime))
    );
    if (runtimeEngine) {
      return { ...runtimeEngine, run: _engineRunners[runtimeEngine.id] || null };
    }
  }

  // PRIORITY 2.3: Per-agent engine from crewswarm.json (`engine` + use* flags), not global env alone
  const preferredFromCfg = resolveAgentPreferredEngineId(payload);
  if (preferredFromCfg) {
    const preferredEngine = _engines.find((e) => e.id === preferredFromCfg);
    if (preferredEngine) {
      return { ...preferredEngine, run: _engineRunners[preferredEngine.id] || null };
    }
  }

  // PRIORITY 2.5: If agent explicitly opted out of ALL CLI engines, skip fallback — use direct LLM
  const agentId = String(payload?.agentId || payload?.agent || "").toLowerCase();
  if (agentId && _loadAgentList) {
    try {
      const agents = _loadAgentList() || [];
      const agentCfg = agents.find(a => a.id === agentId || a.id === `crew-${agentId}`);
      if (agentCfg && agentCfg.useCrewCLI === false) {
        return null;
      }
    } catch {}
  }

  // PRIORITY 3: Fallback — first matching engine (stable alphabetical order by id)
  for (const engine of _engines) {
    if (evaluateShouldUse(engine, payload, incomingType)) {
      return { ...engine, run: _engineRunners[engine.id] || null };
    }
  }

  return null;
}

/**
 * Get engine by ID
 */
export function getEngineById(id) {
  const engine = _engines.find(e => e.id === id);
  if (!engine) return null;
  return {
    ...engine,
    run: _engineRunners[engine.id] || null
  };
}

/**
 * List all registered engines (sorted by id)
 */
export function listEngines() {
  return [..._engines]
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((e, i) => ({
      id: e.id,
      label: e.label || e.id,
      sortOrder: i,
      color: e.color,
      icon: e.icon,
      bestFor: e.bestFor,
    }));
}

/**
 * Reload engines (for hot-reloading in dev)
 */
export function reloadEngines() {
  loadAllEngines();
}
