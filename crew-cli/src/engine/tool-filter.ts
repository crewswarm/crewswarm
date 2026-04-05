/**
 * Tool Auto-Filtering — reduce tool count based on task type.
 *
 * Instead of sending all 41 tools to every LLM call, filter to the
 * relevant subset based on task analysis. This:
 *   - Reduces context/token usage
 *   - Improves model accuracy (fewer irrelevant options)
 *   - Fixes GPT-5.4 Responses API degradation with 20+ tools
 *
 * Tools are grouped by capability domain. The task description
 * determines which domains are active.
 */

export interface ToolDeclarationLike {
  name: string;
  description?: string;
  parameters?: unknown;
}

// ---------------------------------------------------------------------------
// Tool domain groups
// ---------------------------------------------------------------------------

const CORE_TOOLS = new Set([
  'read_file', 'write_file', 'replace', 'edit', 'glob', 'grep_search',
  'list_directory', 'run_shell_command', 'shell'
]);

const GIT_TOOLS = new Set([
  'git', 'worktree', 'enter_worktree', 'exit_worktree', 'merge_worktree', 'list_worktrees'
]);

const WEB_TOOLS = new Set([
  'google_web_search', 'web_search', 'web_fetch'
]);

const MEMORY_TOOLS = new Set([
  'save_memory', 'write_todos', 'get_internal_docs'
]);

const AGENT_TOOLS = new Set([
  'spawn_agent', 'agent_message', 'activate_skill', 'tool_search'
]);

const CODE_INTEL_TOOLS = new Set([
  'lsp', 'notebook_edit'
]);

const PLANNING_TOOLS = new Set([
  'enter_plan_mode', 'exit_plan_mode', 'ask_user'
]);

const TRACKER_TOOLS = new Set([
  'tracker_create_task', 'tracker_update_task', 'tracker_get_task',
  'tracker_list_tasks', 'tracker_add_dependency', 'tracker_visualize'
]);

const EXTRA_TOOLS = new Set([
  'read_many_files', 'append_file', 'mkdir', 'grep_search_ripgrep',
  'list', 'run_cmd', 'grep', 'check_background_task', 'sleep'
]);

// ---------------------------------------------------------------------------
// Task → domain mapping
// ---------------------------------------------------------------------------

export type TaskDomain =
  | 'coding'        // file read/write/edit + shell
  | 'research'      // web search + docs
  | 'git'           // version control
  | 'planning'      // plan mode + tracker
  | 'testing'       // shell + code intel
  | 'docs'          // file write + memory
  | 'full';         // everything

export function detectTaskDomains(task: string): Set<TaskDomain> {
  const lower = task.toLowerCase();
  const domains = new Set<TaskDomain>();

  // Always include coding (core tools)
  domains.add('coding');

  if (/\b(search|find.*online|web|url|http|fetch.*page|research|google)\b/.test(lower)) {
    domains.add('research');
  }
  if (/\b(git|commit|branch|merge|push|pull|diff|blame|worktree|rebase)\b/.test(lower)) {
    domains.add('git');
  }
  if (/\b(plan|roadmap|break.*down|decompose|architect|design.*system)\b/.test(lower)) {
    domains.add('planning');
  }
  if (/\b(tests?|spec|assert|coverage|jest|mocha|vitest|verify|validate)\b/.test(lower)) {
    domains.add('testing');
  }
  if (/\b(doc|readme|guide|tutorial|comment|explain|write.*about)\b/.test(lower)) {
    domains.add('docs');
  }
  // Complex tasks get everything
  if (lower.length > 500 || /\b(entire|whole|project|refactor.*across|migration)\b/.test(lower)) {
    domains.add('full');
  }

  return domains;
}

/**
 * Filter tools to only those relevant for the detected task domains.
 * Always includes core tools. Returns the filtered list.
 */
export function filterToolsForTask<T extends ToolDeclarationLike>(
  tools: T[],
  task: string,
  options: {
    /** Maximum tools to return (0 = no limit) */
    maxTools?: number;
    /** Force include these tool names regardless of domain */
    alwaysInclude?: string[];
  } = {}
): T[] {
  const domains = detectTaskDomains(task);

  // Full domain = return everything
  if (domains.has('full')) {
    return options.maxTools ? tools.slice(0, options.maxTools) : tools;
  }

  const allowed = new Set<string>(CORE_TOOLS);

  // Add domain-specific tools
  if (domains.has('git')) for (const t of GIT_TOOLS) allowed.add(t);
  if (domains.has('research')) for (const t of WEB_TOOLS) allowed.add(t);
  if (domains.has('planning')) {
    for (const t of PLANNING_TOOLS) allowed.add(t);
    for (const t of TRACKER_TOOLS) allowed.add(t);
  }
  if (domains.has('testing')) for (const t of CODE_INTEL_TOOLS) allowed.add(t);
  if (domains.has('docs')) for (const t of MEMORY_TOOLS) allowed.add(t);

  // Always include extra common tools
  for (const t of EXTRA_TOOLS) allowed.add(t);

  // Force-include specific tools
  if (options.alwaysInclude) {
    for (const t of options.alwaysInclude) allowed.add(t);
  }

  const filtered = tools.filter(t => allowed.has(t.name));

  if (options.maxTools && filtered.length > options.maxTools) {
    return filtered.slice(0, options.maxTools);
  }

  return filtered;
}

/**
 * Get a human-readable summary of which domains were detected.
 */
export function describeFiltering(task: string, totalTools: number, filteredCount: number): string {
  const domains = detectTaskDomains(task);
  return `[ToolFilter] ${filteredCount}/${totalTools} tools (domains: ${[...domains].join(', ')})`;
}
