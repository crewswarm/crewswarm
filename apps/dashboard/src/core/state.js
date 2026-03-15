// Shared in-memory state — mutate via the exported object properties
// Restored from sessionStorage on page load to survive refresh

const STORAGE_KEY = 'crewswarm_ui_state';

function loadSaved() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

const saved = loadSaved();

export const state = {
  // OpenCode session selection (Sessions tab)
  selected: saved.selected || null,
  
  // Selected CLI engine for Sessions tab (opencode, claude, codex, gemini, crew-cli)
  selectedEngine: saved.selectedEngine || 'opencode',

  // Agent list (loaded from /api/agents)
  agents: saved.agents || [],

  // Active chat project
  chatActiveProjectId: saved.chatActiveProjectId || '',

  // Active shared channel/project for the Swarm tab
  swarmChatProjectId: saved.swarmChatProjectId || '',

  // Project registry cache (populated by loadProjects)
  projectsData: saved.projectsData || {},

  // Active tab (for scroll restoration)
  activeTab: saved.activeTab || 'chat',

  // Per-tab scroll positions { tabName: scrollTop }
  scrollPositions: saved.scrollPositions || {},
};

/** Persist current state to sessionStorage (call after meaningful state changes). */
export function persistState() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      selected: state.selected,
      selectedEngine: state.selectedEngine,
      chatActiveProjectId: state.chatActiveProjectId,
      swarmChatProjectId: state.swarmChatProjectId,
      projectsData: state.projectsData,
      activeTab: state.activeTab,
      scrollPositions: state.scrollPositions,
      // Don't persist agents list — it's large and gets stale
    }));
  } catch { /* quota exceeded or private mode — ignore */ }
}

/** Save scroll position for the current active tab. */
export function saveScrollPosition(tabName) {
  const main = document.querySelector('.view.active');
  if (main) {
    state.scrollPositions[tabName || state.activeTab] = main.scrollTop;
    persistState();
  }
}

/** Restore scroll position for a tab after re-render. */
export function restoreScrollPosition(tabName) {
  const pos = state.scrollPositions[tabName];
  if (pos != null) {
    requestAnimationFrame(() => {
      const main = document.querySelector('.view.active');
      if (main) main.scrollTop = pos;
    });
  }
}

export const AGENT_RANK = {
  'crew-lead': 0,
  'crew-orchestrator': 1, 'orchestrator': 1, 'crew-main': 2,
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
