// Shared CrewSwarm agent registry.
// Keep coordinator IDs and built-in canonical agent IDs here so runtime,
// dashboard, and scripts stay in sync.

export const BUILT_IN_RT_AGENTS = [
  "crew-main",
  "crew-pm",
  "crew-qa",
  "crew-fixer",
  "crew-coder",
  "crew-coder-front",
  "crew-coder-back",
  "crew-github",
  "crew-security",
  "crew-frontend",
  "crew-copywriter",
  "crew-telegram",
  "crew-orchestrator",  // Cursor subagent wave orchestrator
  "orchestrator",
];

export const RT_TO_GATEWAY_AGENT_MAP = {
  "crew-main": "main",
  "crew-pm": "pm",
  "crew-qa": "qa",
  "crew-fixer": "fixer",
  "crew-coder": "coder",
  "crew-coder-front": "coder-front",
  "crew-coder-back": "coder-back",
  "crew-github": "github",
  "crew-security": "security",
  "crew-frontend": "frontend",
  "crew-copywriter": "copywriter",
  "crew-telegram": "telegram",
  "crew-orchestrator": "orchestrator", // Cursor wave orchestrator → runs Cursor CLI
  "orchestrator": "orchestrator",
};

export const COORDINATOR_AGENT_IDS = ["crew-main", "crew-pm", "crew-orchestrator", "orchestrator"];

export const NO_PREFIX_AGENT_IDS = new Set(["security", "orchestrator"]);

export function normalizeRtAgentId(agentId = "") {
  const id = String(agentId || "").trim();
  if (!id) return "";
  if (id.startsWith("crew-") || NO_PREFIX_AGENT_IDS.has(id)) return id;
  return `crew-${id}`;
}
