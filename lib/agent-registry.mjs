// Shared crewswarm agent registry.
// Dynamically loads agents from ~/.crewswarm/crewswarm.json so new agents
// are automatically discovered without code changes.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Minimal built-in fallback for core coordinator agents
// Plus agents used in tests (so tests pass on CI without config file)
const CORE_AGENTS = [
  "crew-main",
  "crew-pm",
  "crew-pm-cli",
  "crew-pm-frontend",
  "crew-pm-core",
  "crew-orchestrator",
  "crew-lead",
  "crew-judge",
  // Test agents (needed for CI)
  "crew-coder",
  "crew-coder-back",
  "crew-coder-front",
  "crew-researcher",
  "crew-qa",
  "crew-copywriter",
  "crew-fixer",
  "crew-github",
  "crew-frontend",
  "crew-security",
];

const CORE_MAP = {
  "crew-main": "main",
  "crew-pm": "pm",
  "crew-pm-cli": "pm-cli",
  "crew-pm-frontend": "pm-frontend",
  "crew-pm-core": "pm-core",
  "crew-orchestrator": "orchestrator",
  "crew-lead": "lead",
  "crew-judge": "judge",
  // Test agents
  "crew-coder": "coder",
  "crew-coder-back": "coder-back",
  "crew-coder-front": "coder-front",
  "crew-researcher": "researcher",
  "crew-qa": "qa",
  "crew-copywriter": "copywriter",
  "crew-fixer": "fixer",
  "crew-github": "github",
  "crew-frontend": "frontend",
  "crew-security": "security",
};

/**
 * Build agent registry dynamically from config files.
 * Reads ~/.crewswarm/crewswarm.json and discovers all configured agents.
 */
function buildAgentRegistry() {
  const map = { ...CORE_MAP };
  const listSet = new Set(CORE_AGENTS);

  const cfgPaths = [
    path.join(os.homedir(), ".crewswarm", "crewswarm.json"),
    path.join(os.homedir(), ".openclaw", "openclaw.json"),
  ];

  for (const cfgPath of cfgPaths) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      const agents = Array.isArray(cfg.agents) ? cfg.agents
                   : Array.isArray(cfg.agents?.list) ? cfg.agents.list
                   : [];

      for (const agent of agents) {
        const rawId = String(agent.id || "").trim();
        if (!rawId) continue;

        // Normalize to RT format (crew-xxx)
        const bareId = rawId.replace(/^crew-/, "");
        const rtId = rawId.startsWith("crew-") ? rawId : `crew-${bareId}`;

        // Always keep canonical RT IDs in the exported list
        if (!map[rtId]) {
          map[rtId] = bareId;
          listSet.add(rtId);
        }
        // Support bare alias lookup (e.g. "orchestrator", "security")
        // without adding duplicate non-RT IDs to BUILT_IN_RT_AGENTS.
        if (rawId === bareId && !map[bareId]) {
          map[bareId] = bareId;
        }
      }
    } catch (err) {
      // Config file not found or invalid JSON — use core agents only
      if (process.env.DEBUG) {
        console.warn(`[agent-registry] Could not load ${cfgPath}: ${err.message}`);
      }
    }
  }

  return { list: [...listSet].sort(), map };
}

// Build registry on module load
const { list, map } = buildAgentRegistry();

export const BUILT_IN_RT_AGENTS = list;
export const RT_TO_GATEWAY_AGENT_MAP = map;

// Core agents that MUST exist - system breaks if missing
export const REQUIRED_AGENTS = new Set([
  "crew-lead",      // Fatal: no chat handler, no dispatch
  "crew-main",      // Fatal: no synthesis, no fallback coordinator
  "crew-pm",        // Fatal: PM-loop breaks, no roadmap processing
  "crew-orchestrator", // Fatal: pipeline dispatch fails
  "crew-coder",     // Fatal: PM-loop's default worker
  "crew-judge"      // Fatal: PM-loop judge decisions fail (if PM_USE_JUDGE=on)
]);

// Coordinator agents that can dispatch to other agents
export const COORDINATOR_AGENT_IDS = [
  "crew-main",
  "crew-pm",
  "crew-pm-cli",
  "crew-pm-frontend",
  "crew-pm-core",
  "crew-orchestrator"
];

/**
 * Check if an agent ID is a coordinator (can dispatch to other agents)
 * Handles both RT format (crew-xxx) and bare aliases (xxx)
 * @param {string} agentId - Agent ID to check
 * @returns {boolean} True if agent is a coordinator
 */
export function isCoordinator(agentId = "") {
  const id = String(agentId || "").trim();
  if (!id) return false;
  
  // Check RT format directly
  if (COORDINATOR_AGENT_IDS.includes(id)) return true;
  
  // Check bare alias by normalizing to RT format
  const rtId = normalizeRtAgentId(id);
  return COORDINATOR_AGENT_IDS.includes(rtId);
}

/**
 * Validate that all required agents exist in config
 * @param {Array} agents - Agent list from config
 * @returns {Object} { valid: boolean, missing: string[] }
 */
export function validateRequiredAgents(agents = []) {
  const agentIds = new Set(
    agents
      .map((a) => normalizeRtAgentId(a?.id))
      .filter(Boolean)
  );
  const missing = [];
  
  for (const required of REQUIRED_AGENTS) {
    if (!agentIds.has(required)) {
      missing.push(required);
    }
  }
  
  return {
    valid: missing.length === 0,
    missing
  };
}

// Agents that don't get "crew-" prefix normalization
export const NO_PREFIX_AGENT_IDS = new Set(["security"]);

/**
 * Normalize agent ID to RT format (crew-xxx).
 * @param {string} agentId - Raw agent ID
 * @returns {string} Normalized RT agent ID
 */
export function normalizeRtAgentId(agentId = "") {
  const id = String(agentId || "").trim();
  if (!id) return "";
  if (id.startsWith("crew-") || NO_PREFIX_AGENT_IDS.has(id)) return id;
  return `crew-${id}`;
}
