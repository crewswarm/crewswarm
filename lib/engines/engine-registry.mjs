/**
 * engine-registry.mjs — Dynamic engine registration with priority-based routing
 * All engines load from JSON — zero hardcoded logic.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadAgentList as _defaultLoadAgentList } from "../runtime/config.mjs";

const ENGINES_BUNDLED_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "engines");
const ENGINES_USER_DIR = path.join(os.homedir(), ".crewswarm", "engines");

let _engines = [];
let _engineRunners = {}; // id → run function
let _loadAgentList = _defaultLoadAgentList;

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

  // Check env var
  if (shouldUse.envVar && process.env[shouldUse.envVar] === "1") {
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
 * Select engine based on EXPLICIT agent configuration first, then fallback to priority
 */
export function selectEngine(payload, incomingType) {
  // PRIORITY 1: Check for EXPLICIT agent configuration (overrides all priorities)
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

  // PRIORITY 3: Fallback to first engine that matches via evaluateShouldUse
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
 * List all registered engines (sorted by priority)
 */
export function listEngines() {
  return _engines.map(e => ({
    id: e.id,
    label: e.label || e.id,
    priority: e.priority,
    color: e.color,
    icon: e.icon,
    bestFor: e.bestFor
  }));
}

/**
 * Reload engines (for hot-reloading in dev)
 */
export function reloadEngines() {
  loadAllEngines();
}
