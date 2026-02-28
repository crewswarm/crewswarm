/**
 * engine-registry.mjs — Dynamic engine registration with priority-based routing
 * 
 * Eliminates hardcoded cross-checks between shouldUse*() functions.
 * Engines are evaluated in priority order (highest first).
 */

import fs from "node:fs";
import path from "node:path";
import os from "os:homedir";

/**
 * Engine definition structure:
 * {
 *   id: string,              // "cursor-cli", "claude-code", etc.
 *   priority: number,        // 100 (highest), 90, 80, 70... 10 (lowest)
 *   shouldUse: (payload, incomingType, context) => boolean,
 *   run: (prompt, payload) => Promise<string>,
 *   label: string,           // "Cursor CLI", "Claude Code", etc.
 *   telemetryKey: string     // "realtime_route_cursor_cli"
 * }
 */

const ENGINES = [];

/**
 * Register an engine with the global registry
 */
export function registerEngine(engine) {
  if (!engine.id || !engine.priority || !engine.shouldUse || !engine.run) {
    throw new Error(`Invalid engine registration: ${JSON.stringify(engine)}`);
  }
  
  // Remove existing engine with same ID
  const idx = ENGINES.findIndex(e => e.id === engine.id);
  if (idx !== -1) ENGINES.splice(idx, 1);
  
  // Insert in priority order (highest first)
  const insertIdx = ENGINES.findIndex(e => e.priority < engine.priority);
  if (insertIdx === -1) {
    ENGINES.push(engine);
  } else {
    ENGINES.splice(insertIdx, 0, engine);
  }
}

/**
 * Find the first engine that should handle this task
 * 
 * @param {object} payload - Task payload
 * @param {string} incomingType - "command.run_task" | "task.assigned"
 * @param {object} context - Additional context (prompt, etc.)
 * @returns {object|null} Engine definition or null
 */
export function selectEngine(payload, incomingType, context = {}) {
  // Build context for shouldUse checks
  const ctx = {
    ...context,
    higherPriorityEngines: [], // Tracks which engines were checked before this one
  };
  
  for (const engine of ENGINES) {
    try {
      if (engine.shouldUse(payload, incomingType, ctx)) {
        return engine;
      }
      ctx.higherPriorityEngines.push(engine.id);
    } catch (err) {
      console.error(`[engine-registry] Error in ${engine.id}.shouldUse():`, err.message);
    }
  }
  
  return null;
}

/**
 * Get engine by ID
 */
export function getEngine(id) {
  return ENGINES.find(e => e.id === id) || null;
}

/**
 * List all registered engines (sorted by priority)
 */
export function listEngines() {
  return ENGINES.map(e => ({
    id: e.id,
    priority: e.priority,
    label: e.label || e.id,
  }));
}

/**
 * Helper: Check if an agent config has a specific engine enabled
 */
export function agentHasEngine(agentId, engineField, loadAgentList) {
  try {
    const agents = loadAgentList();
    const cfg = agents.find(a => a.id === agentId || a.id === `crew-${agentId}`);
    return cfg?.[engineField] === true;
  } catch {
    return false;
  }
}

/**
 * Helper: Check runtime/executor payload flags
 */
export function runtimeMatches(payload, ...values) {
  const runtime = String(payload?.runtime || payload?.executor || payload?.engine || "").toLowerCase();
  return values.some(v => runtime === v);
}

/**
 * Helper: Read global flag from config.json
 */
export function getGlobalFlag(flagName) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "config.json"), "utf8"));
    if (typeof cfg[flagName] === "boolean") return cfg[flagName];
  } catch {}
  return false;
}
