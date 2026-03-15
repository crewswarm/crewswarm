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
  
  console.error('[engine-registry] 🔧 Initializing with runners:', Object.keys(engineRunners || {}));
  
  loadAllEngines();
  
  console.error('[engine-registry] 📋 Loaded engines:', _engines.map(e => `${e.id}(${e.priority})`).join(', '));
  console.error('[engine-registry] 🎯 Registered runners:', Object.keys(_engineRunners));
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
  
  // No longer sorting by priority - explicit config takes precedence
  console.error(`[engine-registry] Loaded ${_engines.length} engines (priority system disabled)`);
}

/**
 * Evaluate shouldUse logic from JSON config
 */
function evaluateShouldUse(engineDef, payload, incomingType) {
  const engineId = engineDef.id;
  
  if (incomingType !== "command.run_task" && incomingType !== "task.assigned") {
    return false;
  }
  
  const { shouldUse } = engineDef;
  if (!shouldUse) return false;
  
  // Debug logging for crew-cli
  if (engineId === "crew-cli") {
    console.error(`[engine-registry] 🔍 Evaluating crew-cli for agent: ${payload?.agentId || payload?.agent}`);
    console.error(`[engine-registry]   payload.runtime: ${payload?.runtime}`);
    console.error(`[engine-registry]   payload.executor: ${payload?.executor}`);
    console.error(`[engine-registry]   payload.engine: ${payload?.engine}`);
    console.error(`[engine-registry]   payload.useCrewCLI: ${payload?.useCrewCLI}`);
  }
  
  // Check runtime/executor
  const runtime = String(payload?.runtime || payload?.executor || payload?.engine || "").toLowerCase();
  if (shouldUse.runtime && Array.isArray(shouldUse.runtime)) {
    if (shouldUse.runtime.includes(runtime)) {
      if (engineId === "crew-cli") console.error(`[engine-registry] ✅ crew-cli MATCHED via runtime: ${runtime}`);
      return true;
    }
  }
  
  // Check payload key
  if (shouldUse.payloadKey && payload?.[shouldUse.payloadKey] === true) {
    if (engineId === "crew-cli") console.error(`[engine-registry] ✅ crew-cli MATCHED via payloadKey: ${shouldUse.payloadKey}`);
    return true;
  }
  
  // Check agent config
  if (shouldUse.agentConfigKey && _loadAgentList) {
    const agentId = String(payload?.agentId || payload?.agent || "").toLowerCase();
    try {
      const agents = _loadAgentList();
      const cfg = agents.find(a => a.id === agentId || a.id === `crew-${agentId}`);
      
      if (engineId === "crew-cli") {
        console.error(`[engine-registry]   Agent found: ${cfg?.id}`);
        console.error(`[engine-registry]   Agent.useCrewCLI: ${cfg?.useCrewCLI}`);
        console.error(`[engine-registry]   Agent.engine: ${cfg?.engine}`);
      }
      
      const cfgEngine = String(cfg?.engine || "").toLowerCase();
      const runtimeAliases = Array.isArray(shouldUse.runtime) ? shouldUse.runtime : [];

      if (cfg?.[shouldUse.agentConfigKey] === true) {
        if (engineId === "crew-cli") console.error(`[engine-registry] ✅ crew-cli MATCHED via agentConfigKey`);
        return true;
      }
      if (cfgEngine && runtimeAliases.includes(cfgEngine)) {
        if (engineId === "crew-cli") console.error(`[engine-registry] ✅ crew-cli MATCHED via cfg.engine: ${cfgEngine}`);
        return true;
      }
    } catch (e) {
      if (engineId === "crew-cli") console.error(`[engine-registry] ❌ Error loading agents: ${e.message}`);
    }
  }
  
  // Check env var
  if (shouldUse.envVar && process.env[shouldUse.envVar] === "1") {
    if (engineId === "crew-cli") console.error(`[engine-registry] ✅ crew-cli MATCHED via envVar: ${shouldUse.envVar}`);
    return true;
  }
  
  if (engineId === "crew-cli") {
    console.error(`[engine-registry] ❌ crew-cli NO MATCH (all checks failed)`);
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
  console.error(`[engine-registry] 🔍 selectEngine called for ${payload?.agentId || payload?.agent}, type: ${incomingType}`);
  console.error(`[engine-registry]   Engines to evaluate: ${_engines.length}`);
  
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
        const runner = _engineRunners[engine.id];
        console.error(`[engine-registry] ✅ EXPLICIT CONFIG MATCH: ${engine.id} (via ${key})`);
        return {
          ...engine,
          run: runner || null
        };
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
      const runner = _engineRunners[runtimeEngine.id];
      console.error(`[engine-registry] ✅ RUNTIME MATCH: ${runtimeEngine.id} (via runtime=${runtime})`);
      return {
        ...runtimeEngine,
        run: runner || null
      };
    }
  }
  
  // PRIORITY 3: Fallback to first engine that matches via evaluateShouldUse
  // (No longer uses priority sorting - just finds first match)
  for (const engine of _engines) {
    console.error(`[engine-registry]   Checking ${engine.id}...`);
    if (evaluateShouldUse(engine, payload, incomingType)) {
      const runner = _engineRunners[engine.id];
      console.error(`[engine-registry] ✅ FALLBACK MATCH: ${engine.id}, runner exists: ${!!runner}`);
      return {
        ...engine,
        run: runner || null
      };
    }
  }
  
  console.error(`[engine-registry] ❌ NO ENGINES MATCHED`);
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
