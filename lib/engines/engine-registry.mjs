/**
 * engine-registry.mjs — Dynamic engine registration with priority-based routing
 * All engines load from JSON — zero hardcoded logic.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ENGINES_BUNDLED_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "engines");
const ENGINES_USER_DIR = path.join(os.homedir(), ".crewswarm", "engines");

let _engines = [];
let _engineRunners = {}; // id → run function
let _loadAgentList = null;

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
          if (def?.id && def?.priority && def?.shouldUse) {
            _engines.push(def);
          }
        } catch (err) {
          console.warn(`[engine-registry] Failed to load ${file}:`, err.message);
        }
      }
    } catch {}
  }
  
  // Sort by priority (highest first)
  _engines.sort((a, b) => b.priority - a.priority);
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
      if (cfg?.[shouldUse.agentConfigKey] === true) return true;
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
 * Select the highest-priority engine that matches
 */
export function selectEngine(payload, incomingType) {
  for (const engine of _engines) {
    if (evaluateShouldUse(engine, payload, incomingType)) {
      return {
        ...engine,
        run: _engineRunners[engine.id] || null
      };
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
