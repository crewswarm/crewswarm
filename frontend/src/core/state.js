// Shared in-memory state — mutate via the exported object properties
export const state = {
  // OpenCode session selection (Sessions tab)
  selected: null,

  // Agent list (loaded from /api/agents)
  agents: [],

  // Active chat project
  chatActiveProjectId: '',

  // Project registry cache (populated by loadProjects)
  projectsData: {},
};

export const AGENT_RANK = {
  'crew-lead': 0,
  'orchestrator': 1, 'crew-main': 2,
  'crew-pm': 3, 'crew-architect': 4,
  'crew-coder': 5, 'crew-coder-back': 6, 'crew-coder-front': 7, 'crew-frontend': 8,
  'crew-ml': 9, 'crew-fixer': 10,
  'crew-qa': 11, 'crew-security': 12,
  'crew-researcher': 13, 'crew-copywriter': 14, 'crew-seo': 15,
  'crew-github': 16, 'crew-db-migrator': 17,
  'crew-telegram': 18, 'crew-mega': 19,
};

export function sortAgents(arr) {
  return (arr || []).sort((a, b) => (AGENT_RANK[a.id] ?? 50) - (AGENT_RANK[b.id] ?? 50));
}
