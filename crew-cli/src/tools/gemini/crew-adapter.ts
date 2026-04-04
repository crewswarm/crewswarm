/**
 * Adapter to use Gemini CLI tools with crew-cli's sandbox
 */

import { Sandbox } from '../../sandbox/index.js';
import { runPreToolUseHooks, runPostToolUseHooks } from '../../hooks/index.js';
import { enterWorktree, exitWorktree, mergeWorktree, listWorktrees } from '../worktree.js';
import { execSync } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  LS_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  SHELL_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  EDIT_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WRITE_TODOS_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  READ_MANY_FILES_TOOL_NAME,
  MEMORY_TOOL_NAME,
  GET_INTERNAL_DOCS_TOOL_NAME,
  ACTIVATE_SKILL_TOOL_NAME,
  ASK_USER_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME
} from './definitions/base-declarations.js';
import type {
  ToolDeclarationSchema,
  TrackerTask,
  LspDiagnostic,
  LspSymbol,
  LspLocation,
  LspCompletionItem,
  NotebookCell,
  Notebook,
  SearchResponse,
  SearchHit,
} from '../../types/common.js';

// ---------------------------------------------------------------------------
// Human-readable activity descriptions for tool calls
// ---------------------------------------------------------------------------
function getActivityDescription(tool: string, p: Record<string, unknown>): string | null {
  const s = (k: string) => String(p[k] || '').replace(/^.*\//, ''); // basename
  const f = (k: string) => String(p[k] || '');
  switch (tool) {
    case 'read_file':         return `Reading ${f('file_path')}`;
    case 'read_many_files':   return `Reading ${Array.isArray(p.paths) ? p.paths.length : '?'} files`;
    case 'write_file':        return `Writing ${f('file_path')}`;
    case 'append_file':       return `Appending to ${f('file_path')}`;
    case 'replace': case 'edit': return `Editing ${f('file_path')}`;
    case 'glob':              return `Globbing ${f('pattern')}`;
    case 'grep': case 'grep_search': case 'grep_search_ripgrep':
                              return `Searching for "${f('pattern')}"${p.path ? ` in ${f('path')}` : ''}`;
    case 'list': case 'list_directory': return `Listing ${f('dir_path') || f('path') || '.'}`;
    case 'mkdir':             return `Creating directory ${f('path')}`;
    case 'shell': case 'run_cmd': case 'run_shell_command':
                              return `Running: ${f('command').slice(0, 80)}${f('command').length > 80 ? '…' : ''}`;
    case 'git':               return `git ${f('command').slice(0, 60)}`;
    case 'google_web_search': case 'web_search':
                              return `Searching web: "${f('query')}"`;
    case 'web_fetch':         return `Fetching ${f('url').slice(0, 60)}`;
    case 'lsp':               return `LSP ${f('action')}${p.file ? ` on ${s('file')}` : ''}`;
    case 'notebook_edit':     return `Notebook ${f('action')} on ${s('path')}`;
    case 'save_memory':       return `Saving memory`;
    case 'write_todos':       return `Writing todos`;
    case 'get_internal_docs': return `Reading internal docs`;
    case 'spawn_agent':       return `Spawning sub-agent: ${f('task').slice(0, 60)}`;
    case 'agent_message':     return `Messaging sub-agent ${s('session_id')}: ${f('message').slice(0, 50)}`;
    case 'enter_worktree': case 'worktree': return `Worktree ${f('action') || 'enter'}`;
    case 'exit_worktree':     return `Exiting worktree`;
    case 'merge_worktree':    return `Merging worktree ${f('branch_name')}`;
    case 'list_worktrees':    return `Listing worktrees`;
    case 'sleep':             return `Sleeping ${p.duration_ms}ms${p.reason ? ` — ${f('reason')}` : ''}`;
    case 'tool_search':       return `Searching tools: "${f('query')}"`;
    case 'check_background_task': return `Checking background task ${f('task_id')}`;
    case 'activate_skill':    return `Activating skill ${f('name') || f('skill')}`;
    case 'enter_plan_mode':   return `Entering plan mode`;
    case 'exit_plan_mode':    return `Exiting plan mode`;
    case 'ask_user':          return null; // don't announce — the question itself is the activity
    case 'tracker_create_task': return `Creating task: ${f('title').slice(0, 40)}`;
    case 'tracker_update_task': return `Updating task ${f('id')}`;
    case 'tracker_get_task':  return `Getting task ${f('id')}`;
    case 'tracker_list_tasks': return `Listing tasks`;
    case 'tracker_add_dependency': return `Adding dependency`;
    case 'tracker_visualize': return `Visualizing task graph`;
    default:                  return `${tool}`;
  }
}

// Minimal adapter types
export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
  handled?: boolean;       // false = worker must address this error
  recovery?: string;       // hint for how to fix (e.g. "call read_file first")
}

// ---------------------------------------------------------------------------
// Constraint levels — filter tools by worker trust
// ---------------------------------------------------------------------------
export type ConstraintLevel = 'read-only' | 'edit' | 'full';

const READ_ONLY_TOOLS = new Set([
  'read_file', 'read_many_files', 'glob', 'grep_search', 'grep_search_ripgrep',
  'list_directory', 'list', 'get_internal_docs', 'web_fetch', 'google_web_search',
  'web_search', 'grep', 'save_memory', 'write_todos',
  'tracker_get_task', 'tracker_list_tasks', 'tracker_visualize',
  'check_background_task', 'ask_user', 'enter_plan_mode', 'exit_plan_mode',
  'lsp', 'git',  // git is read-safe (force-push/--no-verify already blocked)
  'sleep', 'tool_search'  // sleep and tool_search are safe at any constraint level
]);

const EDIT_TOOLS = new Set([
  ...READ_ONLY_TOOLS,
  'replace', 'edit', 'append_file',
  'run_shell_command', 'shell', 'run_cmd',
  'tracker_create_task', 'tracker_update_task', 'tracker_add_dependency',
  'mkdir', 'activate_skill',
  'worktree', 'enter_worktree', 'exit_worktree', 'merge_worktree', 'list_worktrees',
  'notebook_edit'
]);

const FULL_TOOLS = new Set([
  ...EDIT_TOOLS,
  'write_file', 'spawn_agent', 'agent_message'
]);

function toolAllowedAtLevel(toolName: string, level: ConstraintLevel): boolean {
  switch (level) {
    case 'read-only': return READ_ONLY_TOOLS.has(toolName);
    case 'edit':      return EDIT_TOOLS.has(toolName);
    case 'full':      return FULL_TOOLS.has(toolName);
    default:          return true;
  }
}

/** Simple Levenshtein distance (no external deps) */
function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Use two rows for space efficiency
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** Map persona names to constraint levels */
export function constraintLevelForPersona(persona: string): ConstraintLevel {
  const lower = persona.toLowerCase();
  if (lower.includes('planner') || lower.includes('reviewer') || lower.includes('qa') || lower.includes('architect')) {
    return 'read-only';
  }
  if (lower.includes('scaffold') || lower.includes('init') || lower.includes('setup')) {
    return 'full';
  }
  // Default for coders: edit (no write_file to prevent overwrites)
  return 'edit';
}

// Create config adapter for Gemini tools
export class CrewConfig {
  constructor(private workspaceRoot: string) {}
  
  getWorkspaceRoot() {
    return this.workspaceRoot;
  }
  
  getTargetDir() {
    return this.workspaceRoot;
  }
}

// Create message bus adapter (auto-approve for CLI)
export class CrewMessageBus {
  async requestConfirmation(): Promise<{ status: 'approved' }> {
    return { status: 'approved' }; // Auto-approve for CLI
  }
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/** Extract a message string from an unknown caught error */
function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Extract shell command stderr/stdout from Node child_process errors */
function errShell(err: unknown): string {
  const e = err as Record<string, unknown>;
  const stdout = typeof e?.stdout === 'string' ? e.stdout : (e?.stdout as Buffer | undefined)?.toString?.() ?? '';
  const stderr = typeof e?.stderr === 'string' ? e.stderr : (e?.stderr as Buffer | undefined)?.toString?.() ?? '';
  return `${stdout}\n${stderr}`.trim();
}

// Shell timeout: configurable via CREW_SHELL_TIMEOUT env (seconds), default 120s, max 600s
function getShellTimeout(): number {
  const envVal = parseInt(process.env.CREW_SHELL_TIMEOUT || '', 10);
  if (envVal > 0) return Math.min(envVal * 1000, 600000); // max 600s
  return 120000; // default 120s
}

// Dangerous shell commands that should warn (matches Claude Code behavior)
const DANGEROUS_SHELL_PATTERNS = [
  /\brm\s+-rf?\s/,           // rm -r / rm -rf
  /\bgit\s+push\s+.*--force/, // force push
  /\bgit\s+reset\s+--hard/,   // hard reset
  /\bgit\s+clean\s+-f/,       // clean untracked
  /\bdrop\s+table\b/i,        // SQL drop
  /\bdrop\s+database\b/i,     // SQL drop database
  /\bkill\s+-9\b/,            // kill -9
  /\bmkfs\b/,                 // format filesystem
  /\bdd\s+if=/,               // dd (disk destroyer)
];

// Background shell processes tracked by ID
const _backgroundProcesses = new Map<string, { promise: Promise<ToolResult>; startedAt: number }>();

// Main adapter class
export class GeminiToolAdapter {
  private config: CrewConfig;
  private messageBus: CrewMessageBus;
  private _filesRead = new Set<string>(); // Track reads for read-before-edit guard
  private _constraintLevel: ConstraintLevel;

  constructor(private sandbox: Sandbox, constraintLevel: ConstraintLevel = 'full') {
    const workspaceRoot = sandbox.getBaseDir() || process.cwd();
    this.config = new CrewConfig(workspaceRoot);
    this.messageBus = new CrewMessageBus();
    this._constraintLevel = constraintLevel;
  }

  get constraintLevel(): ConstraintLevel {
    return this._constraintLevel;
  }

  private buildDynamicDeclarations(): ToolDeclarationSchema[] {
    // Pull canonical names from Gemini base declarations and hydrate schemas from static declarations.
    const staticDecls = this.getStaticToolDeclarations();
    const staticByName = new Map<string, ToolDeclarationSchema>(staticDecls.map((d) => [d.name, d]));
    const canonicalNames = [
      READ_FILE_TOOL_NAME,
      WRITE_FILE_TOOL_NAME,
      EDIT_TOOL_NAME,
      GLOB_TOOL_NAME,
      GREP_TOOL_NAME,
      LS_TOOL_NAME,
      SHELL_TOOL_NAME,
      WEB_SEARCH_TOOL_NAME,
      WEB_FETCH_TOOL_NAME,
      READ_MANY_FILES_TOOL_NAME,
      MEMORY_TOOL_NAME,
      WRITE_TODOS_TOOL_NAME,
      GET_INTERNAL_DOCS_TOOL_NAME,
      ACTIVATE_SKILL_TOOL_NAME,
      ASK_USER_TOOL_NAME,
      ENTER_PLAN_MODE_TOOL_NAME,
      EXIT_PLAN_MODE_TOOL_NAME,
      'grep_search_ripgrep',
      'tracker_create_task',
      'tracker_update_task',
      'tracker_get_task',
      'tracker_list_tasks',
      'tracker_add_dependency',
      'tracker_visualize',
      'spawn_agent',
      'agent_message',
      'notebook_edit',
      'check_background_task',
      'worktree',
      'sleep',
      'tool_search'
    ];
    const canonical = canonicalNames.map((name) => {
      const found = staticByName.get(name);
      if (found) return found;
      return {
        name,
        description: `${name} tool`,
        parameters: { type: 'object', properties: {} }
      };
    });

    const aliases = [
      { alias: 'read_file', target: 'read_file' },
      { alias: 'write_file', target: 'write_file' },
      { alias: 'append_file', target: 'write_file' },
      { alias: 'edit', target: 'replace' },
      { alias: 'replace', target: 'replace' },
      { alias: 'glob', target: 'glob' },
      { alias: 'grep', target: 'grep_search' },
      { alias: 'grep_search', target: 'grep_search' },
      { alias: 'grep_search_ripgrep', target: 'grep_search_ripgrep' },
      { alias: 'list', target: 'list_directory' },
      { alias: 'list_directory', target: 'list_directory' },
      { alias: 'shell', target: 'run_shell_command' },
      { alias: 'run_cmd', target: 'run_shell_command' },
      { alias: 'run_shell_command', target: 'run_shell_command' },
      { alias: 'web_search', target: 'google_web_search' },
      { alias: 'google_web_search', target: 'google_web_search' },
      { alias: 'web_fetch', target: 'web_fetch' },
      { alias: 'save_memory', target: 'save_memory' },
      { alias: 'write_todos', target: 'write_todos' },
      { alias: 'get_internal_docs', target: 'get_internal_docs' },
      { alias: 'ask_user', target: 'ask_user' },
      { alias: 'enter_plan_mode', target: 'enter_plan_mode' },
      { alias: 'exit_plan_mode', target: 'exit_plan_mode' },
      { alias: 'activate_skill', target: 'activate_skill' },
      { alias: 'tracker_create_task', target: 'tracker_create_task' },
      { alias: 'tracker_update_task', target: 'tracker_update_task' },
      { alias: 'tracker_get_task', target: 'tracker_get_task' },
      { alias: 'tracker_list_tasks', target: 'tracker_list_tasks' },
      { alias: 'tracker_add_dependency', target: 'tracker_add_dependency' },
      { alias: 'tracker_visualize', target: 'tracker_visualize' },
      { alias: 'mkdir', target: 'write_file' },
      { alias: 'git', target: 'run_shell_command' },
      // LSP is not yet implemented — don't alias to read_file (misleads the model)
      // { alias: 'lsp', target: 'read_file' }
    ];

    const byName = new Map<string, ToolDeclarationSchema>();
    for (const decl of canonical) byName.set(decl.name, decl);
    for (const a of aliases) {
      const target = byName.get(a.target);
      if (!target) continue;
      if (!byName.has(a.alias)) {
        byName.set(a.alias, { ...target, name: a.alias });
      }
    }
    // Local compatibility schemas for non-Gemini built-ins we support in adapter.
    byName.set('mkdir', {
      name: 'mkdir',
      description: 'Create a directory path (staged via sandbox).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to create' },
          dir_path: { type: 'string', description: 'Alternative directory path field' }
        }
      }
    });
    byName.set('git', {
      name: 'git',
      description: 'Run limited git subcommands (status/diff/log/add/commit/show/branch).',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Git subcommand and args' }
        },
        required: ['command']
      }
    });
    byName.set('lsp', {
      name: 'lsp',
      description: 'Language Server Protocol code intelligence: diagnostics, go-to-definition, find references, hover type info, completions. Uses TypeScript language service or grep-based fallback.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['diagnostics', 'definition', 'references', 'hover', 'completions'], description: 'LSP action' },
          file: { type: 'string', description: 'Source file path' },
          line: { type: 'number', description: '1-based line number' },
          column: { type: 'number', description: '1-based column number' },
          symbol: { type: 'string', description: 'Symbol name for grep-based lookups' }
        },
        required: ['action', 'file']
      }
    });
    byName.set('notebook_edit', {
      name: 'notebook_edit',
      description: 'Edit Jupyter notebooks (.ipynb files). Actions: read, add_cell, edit_cell, delete_cell, run_cell.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add_cell', 'edit_cell', 'delete_cell', 'run_cell', 'read'], description: 'Notebook action' },
          path: { type: 'string', description: 'Path to .ipynb file' },
          index: { type: 'number', description: '0-based cell index' },
          cell_type: { type: 'string', enum: ['code', 'markdown'], description: 'Cell type for add_cell' },
          content: { type: 'string', description: 'Cell source content for add_cell/edit_cell' }
        },
        required: ['action', 'path']
      }
    });
    return Array.from(byName.values());
  }

  private getStaticToolDeclarations() {
    return [
      { name: 'read_file', description: 'Read file', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
      { name: 'write_file', description: 'Write file', parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } },
      { name: 'replace', description: 'Replace text in file. old_string must uniquely match one location (use replace_all:true for all occurrences). You MUST read_file before editing.', parameters: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean', description: 'Replace ALL occurrences (useful for renames). Default: false (unique match required)' } }, required: ['file_path', 'old_string', 'new_string'] } },
      { name: 'glob', description: 'Glob search', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
      { name: 'grep_search', description: 'Search for regex/text in files. Supports output modes (content/files/count), context lines, case insensitivity, file type filters.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, dir_path: { type: 'string' }, output_mode: { type: 'string', description: 'content (matching lines), files (file paths only), count (match counts)' }, context: { type: 'number', description: 'Lines of context around matches' }, before: { type: 'number' }, after: { type: 'number' }, case_insensitive: { type: 'boolean' }, type: { type: 'string', description: 'File type filter (js, py, ts, go, etc.)' }, max_results: { type: 'number' } }, required: ['pattern'] } },
      { name: 'grep_search_ripgrep', description: 'Alias for grep_search with same capabilities', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, dir_path: { type: 'string' }, output_mode: { type: 'string' }, context: { type: 'number' }, case_insensitive: { type: 'boolean' }, type: { type: 'string' }, max_results: { type: 'number' } }, required: ['pattern'] } },
      { name: 'list_directory', description: 'List directory', parameters: { type: 'object', properties: { dir_path: { type: 'string' }, path: { type: 'string' } } } },
      { name: 'run_shell_command', description: 'Run shell command (configurable timeout, Docker isolation when staged files exist). Use run_in_background:true for long-running commands.', parameters: { type: 'object', properties: { command: { type: 'string' }, run_in_background: { type: 'boolean', description: 'Run in background and return task ID. Use check_background_task to get result.' }, description: { type: 'string', description: 'Brief description of what the command does' } }, required: ['command'] } },
      { name: 'google_web_search', description: 'Web search', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
      { name: 'web_fetch', description: 'Fetch URL', parameters: { type: 'object', properties: { url: { type: 'string' }, prompt: { type: 'string' } } } },
      { name: 'read_many_files', description: 'Read many files', parameters: { type: 'object', properties: { include: { type: 'string' }, exclude: { type: 'string' }, recursive: { type: 'boolean' } } } },
      { name: 'save_memory', description: 'Save memory fact', parameters: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] } },
      { name: 'write_todos', description: 'Write todos', parameters: { type: 'object', properties: { todos: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, done: { type: 'boolean' } } } } }, required: ['todos'] } },
      { name: 'get_internal_docs', description: 'Read internal docs', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'ask_user', description: 'Ask user placeholder', parameters: { type: 'object', properties: { questions: { type: 'array', items: { type: 'object', properties: { question: { type: 'string' } } } } } } },
      { name: 'enter_plan_mode', description: 'Enter plan mode', parameters: { type: 'object', properties: { reason: { type: 'string' } } } },
      { name: 'exit_plan_mode', description: 'Exit plan mode', parameters: { type: 'object', properties: { plan_path: { type: 'string' } } } },
      { name: 'activate_skill', description: 'Activate skill', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
      { name: 'tracker_create_task', description: 'Create tracker task', parameters: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, type: { type: 'string' }, parentId: { type: 'string' }, dependencies: { type: 'array', items: { type: 'string' } } }, required: ['title', 'description', 'type'] } },
      { name: 'tracker_update_task', description: 'Update tracker task', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      { name: 'tracker_get_task', description: 'Get tracker task', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      { name: 'tracker_list_tasks', description: 'List tracker tasks', parameters: { type: 'object', properties: { status: { type: 'string' }, type: { type: 'string' }, parentId: { type: 'string' } } } },
      { name: 'tracker_add_dependency', description: 'Add tracker dependency', parameters: { type: 'object', properties: { taskId: { type: 'string' }, dependencyId: { type: 'string' } }, required: ['taskId', 'dependencyId'] } },
      { name: 'tracker_visualize', description: 'Visualize tracker graph', parameters: { type: 'object', properties: {} } },
      { name: 'spawn_agent', description: 'Spawn a sub-agent to handle a task autonomously. Returns a session_id you can use with agent_message for follow-up conversations. The sub-agent runs in an isolated sandbox branch with a cheaper model.', parameters: { type: 'object', properties: { task: { type: 'string', description: 'Clear task description for the sub-agent' }, tools: { type: 'array', items: { type: 'string' }, description: 'Optional subset of tool names the sub-agent may use' }, maxTurns: { type: 'number', description: 'Max turns for sub-agent (default: 15, max: 25)' }, model: { type: 'string', description: 'Optional model override (default: cheapest configured model)' } }, required: ['task'] } },
      { name: 'agent_message', description: 'Send a follow-up message to an existing sub-agent session. The sub-agent resumes with its full prior conversation context and file access. Use this for multi-turn collaboration: spawn an agent, review its work, then send corrections or next steps.', parameters: { type: 'object', properties: { session_id: { type: 'string', description: 'Session ID returned by spawn_agent' }, message: { type: 'string', description: 'Follow-up message or instruction for the sub-agent' }, max_turns: { type: 'number', description: 'Max turns for this follow-up (default: 10, max: 25)' } }, required: ['session_id', 'message'] } },
      { name: 'notebook_edit', description: 'Edit Jupyter notebooks (.ipynb files). Actions: read (view structure), add_cell, edit_cell, delete_cell, run_cell.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['add_cell', 'edit_cell', 'delete_cell', 'run_cell', 'read'], description: 'Notebook action' }, path: { type: 'string', description: 'Path to .ipynb file' }, index: { type: 'number', description: '0-based cell index' }, cell_type: { type: 'string', enum: ['code', 'markdown'], description: 'Cell type for add_cell' }, content: { type: 'string', description: 'Cell source content for add_cell/edit_cell' } }, required: ['action', 'path'] } },
      { name: 'check_background_task', description: 'Check the status/result of a background shell command. Returns result if done, or elapsed time if still running.', parameters: { type: 'object', properties: { task_id: { type: 'string', description: 'Task ID returned by run_shell_command with run_in_background:true' } }, required: ['task_id'] } },
      { name: 'worktree', description: 'Manage git worktrees to isolate agent work on separate branches. Actions: enter (create), exit (remove), merge (merge branch), list (list active).', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['enter', 'exit', 'merge', 'list'], description: 'Worktree action' }, branch: { type: 'string', description: 'Branch name for enter/exit/merge' }, merge: { type: 'boolean', description: 'Merge on exit (default: true)' }, projectDir: { type: 'string', description: 'Override project directory' } }, required: ['action'] } },
      { name: 'sleep', description: 'Pause execution for a specified duration (max 60s). Useful for polling, rate limiting, or waiting for external processes.', parameters: { type: 'object', properties: { duration_ms: { type: 'number', description: 'Sleep duration in milliseconds (max 60000)' }, reason: { type: 'string', description: 'Why the agent is sleeping' } }, required: ['duration_ms'] } },
      { name: 'tool_search', description: 'Search the tool registry to discover available tools by name or capability. Returns tool names, descriptions, and parameter schemas.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search term matched against tool name and description' }, max_results: { type: 'number', description: 'Max results to return (default: 10)' } }, required: ['query'] } }
    ];
  }

  /**
   * Execute a tool call from LLM (with PreToolUse/PostToolUse hooks)
   */
  async executeTool(toolName: string, params: Record<string, unknown>): Promise<ToolResult> {
    // Constraint level enforcement — hard block even if LLM hallucinates a removed tool
    if (!toolAllowedAtLevel(toolName, this._constraintLevel)) {
      return {
        success: false,
        error: `Tool "${toolName}" is not available at constraint level "${this._constraintLevel}". Use allowed tools only.`,
        handled: false,
        recovery: this._constraintLevel === 'read-only'
          ? 'This is a read-only worker. Use read_file, grep_search, glob, or list_directory.'
          : 'This is an edit worker. Use replace/edit for changes, not write_file.'
      };
    }

    // Print human-readable activity description
    const activity = getActivityDescription(toolName, params);
    if (activity) process.stdout.write(`\x1b[90m  ⚙ ${activity}\x1b[0m\n`);

    // Run PreToolUse hooks
    const preResult = await runPreToolUseHooks(toolName, params);
    if (preResult.decision === 'deny') {
      return { success: false, error: `Blocked by hook: ${preResult.reason || 'denied'}` };
    }
    // Allow hooks to modify input
    const effectiveParams = preResult.updatedInput || params;

    const result = await this._executeTool(toolName, effectiveParams);

    // Run PostToolUse hooks (fire-and-forget, don't block)
    runPostToolUseHooks(toolName, effectiveParams, result).catch(() => {});

    return result;
  }

  private async _executeTool(toolName: string, params: Record<string, unknown>): Promise<ToolResult> {
    try {
      switch (toolName) {
        // Canonical Gemini names + local aliases
        case 'write_file':
          return await this.writeFile(params);
        case 'replace':
          return await this.editFile({
            file_path: params.file_path,
            old_string: params.old_string,
            new_string: params.new_string,
            replace_all: params.replace_all
          });
        case 'append_file':
          return await this.appendFile(params);
        case 'read_file':
          return await this.readFile(params);
        case 'edit':
          return await this.editFile(params);
        case 'read_many_files':
          return await this.readManyFilesTool(params);
        case 'save_memory':
          return await this.saveMemoryTool(params);
        case 'write_todos':
          return await this.writeTodosTool(params);
        case 'get_internal_docs':
          return await this.getInternalDocsTool(params);
        case 'ask_user':
          return await this.askUserTool(params);
        case 'enter_plan_mode':
          return await this.enterPlanModeTool(params);
        case 'exit_plan_mode':
          return await this.exitPlanModeTool(params);
        case 'activate_skill':
          return await this.activateSkillTool(params);
        case 'mkdir':
          return await this.mkdirTool(params);
        case 'list':
          return await this.listTool(params);
        case 'list_directory':
          return await this.listTool({ dir_path: params.dir_path || params.path });
        case 'glob':
          return await this.globTool(params);
        case 'grep':
          return await this.grepTool(params);
        case 'grep_search':
        case 'grep_search_ripgrep':
          return await this.grepTool({
            pattern: params.pattern,
            path: params.dir_path || params.path,
            output_mode: params.output_mode,
            context: params.context,
            before: params.before,
            after: params.after,
            case_insensitive: params.case_insensitive,
            type: params.type,
            max_results: params.max_results
          });
        case 'git':
          return await this.gitTool(params);
        case 'shell':
        case 'run_cmd':
        case 'run_shell_command':
          return await this.shellTool(params);
        case 'lsp':
          return await this.lspTool(params);
        case 'notebook_edit':
          return await this.notebookEditTool(params);
        case 'web_search':
        case 'google_web_search':
          return await this.webSearchTool(params);
        case 'web_fetch':
          return await this.webFetchTool(params);
        case 'tracker_create_task':
          return await this.trackerCreateTaskTool(params);
        case 'tracker_update_task':
          return await this.trackerUpdateTaskTool(params);
        case 'tracker_get_task':
          return await this.trackerGetTaskTool(params);
        case 'tracker_list_tasks':
          return await this.trackerListTasksTool(params);
        case 'tracker_add_dependency':
          return await this.trackerAddDependencyTool(params);
        case 'tracker_visualize':
          return await this.trackerVisualizeTool();
        case 'spawn_agent':
          return await this.spawnAgentTool(params);
        case 'agent_message':
          return await this.agentMessageTool(params as any);
        case 'check_background_task':
          return await this.checkBackgroundTask(params);
        case 'enter_worktree':
          return this.enterWorktreeTool(params);
        case 'exit_worktree':
          return await this.exitWorktreeTool(params);
        case 'merge_worktree':
          return this.mergeWorktreeTool(params);
        case 'list_worktrees':
          return this.listWorktreesTool();
        case 'worktree':
          return await this.worktreeUnifiedTool(params);
        case 'sleep':
          return await this.sleepTool(params);
        case 'tool_search':
          return this.toolSearchTool(params);
        default:
          return {
            success: false,
            error: `Unknown tool: ${toolName}`
          };
      }
    } catch (err: unknown) {
      return {
        success: false,
        error: errMsg(err)
      };
    }
  }

  private async writeFile(params: { file_path: string; content: string }): Promise<ToolResult> {
    const isAbsolute = params.file_path.startsWith('/');
    const { existsSync } = await import('node:fs');

    // Guard: reject write_file on existing files — use replace/append instead
    const checkPath = isAbsolute ? params.file_path : resolve(this.config.getWorkspaceRoot(), params.file_path);
    if (existsSync(checkPath)) {
      const { statSync } = await import('node:fs');
      const size = statSync(checkPath).size;
      if (size > 0) {
        return {
          success: false,
          error: `File "${params.file_path}" already exists (${size} bytes). Use "replace" tool to edit existing files (read_file first, then replace with old_string/new_string). Use "append_file" to add content at the end. write_file is only for creating NEW files.`,
          handled: false,
          recovery: `Read the file first with read_file, then use replace with old_string/new_string for surgical edits.`
        };
      }
    }

    if (isAbsolute) {
      try {
        const { mkdir, writeFile } = await import('node:fs/promises');
        const { dirname } = await import('node:path');
        const dir = dirname(params.file_path);
        await mkdir(dir, { recursive: true });
        await writeFile(params.file_path, params.content, 'utf8');
        return {
          success: true,
          output: `Wrote ${params.file_path} (${params.content.length} bytes)`
        };
      } catch (err: unknown) {
        return { success: false, error: `Write failed: ${errMsg(err)}` };
      }
    }

    // Relative paths: stage in sandbox with path traversal guard
    const fullPath = resolve(this.config.getWorkspaceRoot(), params.file_path);
    const wsRoot = resolve(this.config.getWorkspaceRoot());
    if (!fullPath.startsWith(wsRoot + '/') && fullPath !== wsRoot) {
      return { success: false, error: `Access denied: path "${params.file_path}" resolves outside workspace root.` };
    }
    await this.sandbox.addChange(params.file_path, params.content);
    return {
      success: true,
      output: `Staged ${params.file_path} (${params.content.length} bytes)`
    };
  }

  private async appendFile(params: { file_path: string; content: string }): Promise<ToolResult> {
    const filePath = resolve(this.config.getWorkspaceRoot(), params.file_path);

    // Read-before-edit guard: must read_file before appending to existing files
    const { existsSync } = await import('node:fs');
    if (existsSync(filePath) && !this._filesRead.has(params.file_path) && !this._filesRead.has(filePath)) {
      return {
        success: false,
        error: `You must read_file "${params.file_path}" before appending to it. Read first to understand the existing content and where your addition should go.`,
        handled: false,
        recovery: `Call read_file with file_path="${params.file_path}" first, then retry append_file.`
      };
    }

    let existing = '';
    try {
      const stagedContent = this.sandbox.getStagedContent?.(params.file_path)
        || this.sandbox.getStagedContent?.(filePath);
      existing = stagedContent ?? await readFile(filePath, 'utf8');
    } catch {
      existing = '';
    }
    const combined = `${existing}${params.content || ''}`;
    await this.sandbox.addChange(params.file_path, combined);
    return {
      success: true,
      output: `Appended ${params.file_path} (${(params.content || '').length} bytes)`
    };
  }
  
  private async readFile(params: { file_path: string; start_line?: number; end_line?: number }): Promise<ToolResult> {
    const filePath = resolve(this.config.getWorkspaceRoot(), params.file_path);

    // Path traversal guard: ensure resolved path is within workspace
    const wsRoot = resolve(this.config.getWorkspaceRoot());
    if (!filePath.startsWith(wsRoot + '/') && filePath !== wsRoot) {
      return { success: false, error: `Access denied: path "${params.file_path}" resolves outside workspace root.` };
    }

    // Track that this file has been read (for read-before-edit guard)
    this._filesRead.add(params.file_path);
    this._filesRead.add(filePath);

    // Check sandbox first for staged (not yet applied) changes
    const stagedContent = this.sandbox.getStagedContent?.(params.file_path)
      || this.sandbox.getStagedContent?.(filePath);
    const content = stagedContent ?? await readFile(filePath, 'utf8');
    
    if (params.start_line || params.end_line) {
      const lines = content.split('\n');
      const start = (params.start_line || 1) - 1;
      const end = params.end_line || lines.length;
      const slice = lines.slice(start, end).join('\n');
      return { success: true, output: slice };
    }
    
    return { success: true, output: content };
  }
  
  private async editFile(params: { file_path: string; old_string: string; new_string: string; replace_all?: boolean }): Promise<ToolResult> {
    const filePath = resolve(this.config.getWorkspaceRoot(), params.file_path);

    // Path traversal guard
    const wsRoot = resolve(this.config.getWorkspaceRoot());
    if (!filePath.startsWith(wsRoot + '/') && filePath !== wsRoot) {
      return { success: false, error: `Access denied: path "${params.file_path}" resolves outside workspace root.` };
    }

    // Read-before-edit guard: require the file to have been read first (matches Claude Code)
    if (!this._filesRead.has(params.file_path) && !this._filesRead.has(filePath)) {
      return {
        success: false,
        error: `You must read_file "${params.file_path}" before editing it. Never guess at file contents.`,
        handled: false,
        recovery: `Call read_file with file_path="${params.file_path}" first, then retry this edit.`
      };
    }

    // Read current content (could be staged)
    const stagedContent = this.sandbox.getStagedContent?.(params.file_path)
      || this.sandbox.getStagedContent?.(filePath);
    const content = stagedContent ?? await readFile(filePath, 'utf8');

    // ── Edit Strategy Chain: exact → whitespace-flex → regex-ish token match → fuzzy ──
    const { match, strategy, occurrences } = this.findEditMatch(content, params.old_string);

    if (!match) {
      return {
        success: false,
        error: `String not found in ${params.file_path}. Tried: exact match, flexible whitespace, fuzzy (Levenshtein).`,
        handled: false,
        recovery: `Re-read the file with read_file and use the exact text from the file as old_string.`
      };
    }

    // replace_all mode: replace every occurrence (useful for renames)
    if (params.replace_all) {
      const updated = content.split(match).join(params.new_string);
      await this.sandbox.addChange(params.file_path, updated);
      const diagnostics = await this.shadowValidate(params.file_path);
      return {
        success: true,
        output: `Edited ${params.file_path} (${occurrences} replacements, strategy: ${strategy})${diagnostics}`
      };
    }

    // Default: unique match required
    if (occurrences > 1) {
      return {
        success: false,
        error: `old_string matches ${occurrences} locations in ${params.file_path}. Provide more context to make it unique, or use replace_all:true to replace all occurrences.`
      };
    }

    const updated = content.replace(match, params.new_string);
    await this.sandbox.addChange(params.file_path, updated);

    // Shadow validation: run diagnostics on the edited file (Cursor-style)
    const diagnostics = await this.shadowValidate(params.file_path);

    return {
      success: true,
      output: `Edited ${params.file_path}${strategy !== 'exact' ? ` (matched via ${strategy})` : ''}${diagnostics}`
    };
  }

  /**
   * Edit strategy chain: exact → flexible whitespace → regex-ish token match → fuzzy.
   * Returns the actual matched string in the content and which strategy succeeded.
   */
  private findEditMatch(content: string, oldString: string): { match: string | null; strategy: string; occurrences: number } {
    // Strategy 1: Exact match
    if (content.includes(oldString)) {
      return { match: oldString, strategy: 'exact', occurrences: content.split(oldString).length - 1 };
    }

    // Strategy 2: Flexible whitespace — normalize whitespace in both sides
    const normalizeWS = (s: string) => s.replace(/[ \t]+/g, ' ').replace(/\r\n/g, '\n');
    const normOld = normalizeWS(oldString);
    const normContent = normalizeWS(content);
    if (normContent.includes(normOld)) {
      // Find the actual text in original content that matches
      const lines = content.split('\n');
      const normLines = normContent.split('\n');
      const normOldLines = normOld.split('\n');
      // Find start line
      const firstNormLine = normOldLines[0];
      for (let i = 0; i <= lines.length - normOldLines.length; i++) {
        if (normLines[i].includes(firstNormLine) || normLines[i] === firstNormLine) {
          // Check if all lines match
          const candidate = lines.slice(i, i + normOldLines.length).join('\n');
          if (normalizeWS(candidate) === normOld) {
            return { match: candidate, strategy: 'whitespace-flex', occurrences: 1 };
          }
        }
      }
      // Fallback: just use the normalized match on the normalized content
      // and find it by position
      const idx = normContent.indexOf(normOld);
      if (idx >= 0) {
        // Map back to original by counting chars (approximate)
        let origIdx = 0, normIdx = 0;
        while (normIdx < idx && origIdx < content.length) {
          if (/[ \t]/.test(content[origIdx]) && origIdx + 1 < content.length && /[ \t]/.test(content[origIdx + 1])) {
            origIdx++;
            continue;
          }
          origIdx++;
          normIdx++;
        }
        // Extract same-length chunk from original
        const chunk = content.substring(origIdx, origIdx + oldString.length + 50);
        // Find the actual boundary in original that matches when normalized
        for (let len = oldString.length - 5; len <= oldString.length + 20; len++) {
          const tryChunk = content.substring(origIdx, origIdx + len);
          if (normalizeWS(tryChunk) === normOld) {
            return { match: tryChunk, strategy: 'whitespace-flex', occurrences: 1 };
          }
        }
      }
    }

    // Strategy 3: Regex-ish token match that tolerates formatting differences around punctuation.
    const escaped = oldString
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '\\s+')
      .replace(/\\([(){}\[\]:;,=<>+\-/*])/g, '\\s*$1\\s*');
    if (escaped.length > 0) {
      try {
        const regex = new RegExp(escaped, 'm');
        const matches = content.match(new RegExp(escaped, 'gm'));
        const regexMatch = content.match(regex);
        if (regexMatch?.[0]) {
          return { match: regexMatch[0], strategy: 'regex', occurrences: matches?.length || 1 };
        }
      } catch {
        // Fall through to fuzzy matching.
      }
    }

    // Strategy 4: Fuzzy match (Levenshtein) — find best-matching substring
    const FUZZY_THRESHOLD = 0.10; // Allow up to 10% weighted difference
    const lines = content.split('\n');
    const oldLines = oldString.split('\n');
    const oldLen = oldString.length;

    if (oldLen > 0 && oldLen < 5000) { // Don't fuzzy-match huge strings
      let bestMatch = '';
      let bestDist = Infinity;

      // Sliding window over content lines
      for (let i = 0; i <= lines.length - oldLines.length; i++) {
        const candidate = lines.slice(i, i + oldLines.length).join('\n');
        const dist = levenshteinDistance(candidate, oldString);
        const maxLen = Math.max(candidate.length, oldLen);
        const ratio = dist / maxLen;

        if (ratio < FUZZY_THRESHOLD && dist < bestDist) {
          bestDist = dist;
          bestMatch = candidate;
        }
      }

      if (bestMatch) {
        return { match: bestMatch, strategy: 'fuzzy', occurrences: 1 };
      }
    }

    return { match: null, strategy: 'none', occurrences: 0 };
  }

  /**
   * Shadow validation: after an edit, check for type/lint errors using LSP.
   * Returns empty string if clean, or diagnostic summary if errors found.
   * Non-fatal — silently returns empty on any failure.
   */
  private async shadowValidate(filePath: string): Promise<string> {
    // Only validate TypeScript/JavaScript files
    if (!/\.(ts|tsx|js|jsx|mjs|mts)$/.test(filePath)) return '';

    try {
      const lsp = await import('../../lsp/index.js');
      const diags = await lsp.typeCheckProject(this.config.getWorkspaceRoot(), [filePath]);

      // Filter to only errors in the edited file
      const fileErrors = diags.filter((d: LspDiagnostic) =>
        d.category === 'error' && d.file?.endsWith(filePath)
      );

      if (fileErrors.length === 0) return '';

      const errorLines = fileErrors.slice(0, 5).map((d: LspDiagnostic) =>
        `  ${d.file}:${d.line} — ${d.message}`
      );

      return `\n\n⚠️ Shadow validation found ${fileErrors.length} error(s) after edit:\n${errorLines.join('\n')}${fileErrors.length > 5 ? `\n  ... and ${fileErrors.length - 5} more` : ''}\nFix these before moving on.`;
    } catch {
      // LSP not available or failed — non-fatal
      return '';
    }
  }

  private async mkdirTool(params: { path?: string; dir_path?: string }): Promise<ToolResult> {
    const dir = (params.path || params.dir_path || '').trim();
    if (!dir) return { success: false, error: 'mkdir requires path' };
    const keep = join(dir, '.gitkeep');
    await this.sandbox.addChange(keep, '');
    return { success: true, output: `Staged directory ${dir}` };
  }

  private async listTool(params: { path?: string; dir_path?: string }): Promise<ToolResult> {
    const target = (params.path || params.dir_path || '.').trim();
    const abs = resolve(process.cwd(), target);
    const items = await readdir(abs, { withFileTypes: true });
    const lines = items.map(i => `${i.isDirectory() ? 'd' : 'f'} ${i.name}`);
    return { success: true, output: lines.join('\n') };
  }

  private async globTool(params: { pattern: string }): Promise<ToolResult> {
    const pattern = String(params.pattern || '').trim();
    if (!pattern) return { success: false, error: 'glob requires pattern' };
    try {
      const out = execSync(`rg --files -g ${JSON.stringify(pattern)}`, { cwd: process.cwd(), stdio: 'pipe', encoding: 'utf8' });
      return { success: true, output: out.trim() };
    } catch (err: unknown) {
      return { success: false, error: errShell(err) || errMsg(err) || 'glob failed' };
    }
  }

  private async grepTool(params: {
    pattern: string;
    path?: string;
    output_mode?: 'content' | 'files' | 'count';
    context?: number;
    before?: number;
    after?: number;
    case_insensitive?: boolean;
    type?: string;
    max_results?: number;
  }): Promise<ToolResult> {
    const pattern = String(params.pattern || '').trim();
    const searchPath = String(params.path || '.').trim();
    if (!pattern) return { success: false, error: 'grep requires pattern' };

    const args = ['rg'];

    // Output mode (matches Claude Code's Grep tool)
    const mode = params.output_mode || 'content';
    if (mode === 'files') {
      args.push('-l'); // files_with_matches
    } else if (mode === 'count') {
      args.push('-c'); // count
    } else {
      args.push('-n'); // line numbers for content mode
    }

    // Context flags
    if (params.context) args.push(`-C${params.context}`);
    else {
      if (params.before) args.push(`-B${params.before}`);
      if (params.after) args.push(`-A${params.after}`);
    }

    // Case insensitive
    if (params.case_insensitive) args.push('-i');

    // File type filter
    if (params.type) args.push(`--type=${params.type}`);

    // Max results
    if (params.max_results) args.push(`-m${params.max_results}`);

    args.push(JSON.stringify(pattern), JSON.stringify(searchPath));

    try {
      const out = execSync(args.join(' '), {
        cwd: process.cwd(),
        stdio: 'pipe',
        encoding: 'utf8'
      });
      return { success: true, output: out.trim() };
    } catch (err: unknown) {
      const text = errShell(err);
      // rg returns exit code 1 for no matches — that's not an error
      const errStatus = (err as Record<string, unknown>)?.status;
      if (errStatus === 1 && !text) return { success: true, output: '(no matches)' };
      return { success: false, error: text || errMsg(err) || 'grep failed' };
    }
  }

  private async gitTool(params: { command: string }): Promise<ToolResult> {
    const command = String(params.command || '').trim();
    if (!command) return { success: false, error: 'git requires command' };

    // Expanded allowed subcommands (matches Claude Code git safety protocol)
    const allowed = ['status', 'diff', 'log', 'add', 'commit', 'show', 'branch', 'stash', 'tag', 'blame', 'checkout', 'switch', 'restore', 'rev-parse', 'remote', 'fetch', 'pull', 'push', 'merge', 'rebase', 'reset', 'cherry-pick', 'worktree'];
    const verb = command.split(/\s+/)[0];
    if (!allowed.includes(verb)) {
      return { success: false, error: `git subcommand not allowed: ${verb}. Allowed: ${allowed.join(', ')}` };
    }

    // Safety guards (Claude Code pattern: never force push, never skip hooks)
    if (/--force|--force-with-lease/.test(command) && verb === 'push') {
      return { success: false, error: 'Force push is not allowed. Use a regular push or create a new branch.' };
    }
    if (/--no-verify/.test(command)) {
      return { success: false, error: 'Skipping hooks (--no-verify) is not allowed. Fix the hook issue instead.' };
    }
    if (verb === 'reset' && /--hard/.test(command)) {
      return { success: false, error: 'git reset --hard is destructive. Use git stash or git checkout <file> instead.' };
    }

    // Reject shell metacharacters to prevent command injection
    if (/[;&|`$(){}\\!<>]/.test(command)) {
      return { success: false, error: 'git command contains disallowed shell characters. Use only git arguments.' };
    }

    try {
      const args = command.split(/\s+/).filter(Boolean);
      const { execFileSync } = await import('node:child_process');
      const out = execFileSync('git', args, {
        cwd: this.config.getWorkspaceRoot(),
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: 30000
      });
      return { success: true, output: out.trim() };
    } catch (err: unknown) {
      const text = errShell(err);
      return { success: false, error: text || errMsg(err) || 'git failed' };
    }
  }

  private async shellTool(params: { command: string; run_in_background?: boolean; description?: string }): Promise<ToolResult> {
    const command = String(params.command || '').trim();
    if (!command) return { success: false, error: 'shell requires command' };

    // Dangerous command detection — block destructive patterns
    for (const pat of DANGEROUS_SHELL_PATTERNS) {
      if (pat.test(command)) {
        return { success: false, error: `Blocked: destructive command detected (${command.slice(0, 60)}). Use a safer alternative.` };
      }
    }

    // Background execution: run command asynchronously, return task ID
    if (params.run_in_background) {
      const taskId = `bg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const bgPromise = (async (): Promise<ToolResult> => {
        try {
          const { spawn } = await import('node:child_process');
          return new Promise((resolve) => {
            const proc = spawn('sh', ['-c', command], {
              cwd: this.config.getWorkspaceRoot(),
              stdio: 'pipe'
            });
            let stdout = '', stderr = '';
            proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
            proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
            const timeout = setTimeout(() => { proc.kill('SIGTERM'); resolve({ success: false, error: 'Background task timed out' }); }, getShellTimeout());
            proc.on('close', (code: number | null) => {
              clearTimeout(timeout);
              resolve(code === 0
                ? { success: true, output: stdout.trim() }
                : { success: false, error: (stderr || stdout).trim() || `exit code ${code}` });
            });
          });
        } catch (err: unknown) {
          return { success: false, error: errMsg(err) };
        }
      })();
      _backgroundProcesses.set(taskId, { promise: bgPromise, startedAt: Date.now() });
      return { success: true, output: `Background task started: ${taskId}\nUse check_background_task with this ID to get the result.` };
    }
    
    try {
      // Check if we have staged files - if so, use Docker sandbox
      const hasStagedFiles = this.sandbox.getPendingPaths().length > 0;
      
      if (hasStagedFiles) {
        const { DockerSandbox } = await import('../docker-sandbox.js');
        const docker = new DockerSandbox();
        const dockerAvailable = await docker.isDockerAvailable();
        
        if (dockerAvailable) {
          console.log(`[GeminiAdapter] Running command in Docker with ${this.sandbox.getPendingPaths().length} staged file(s)`);
          const result = await docker.runCommand(command, this.sandbox, {
            workDir: this.config.getWorkspaceRoot(),
            timeout: getShellTimeout()
          });
          return {
            success: result.success,
            output: result.output,
            error: result.success ? undefined : result.output
          };
        } else {
          console.warn('[GeminiAdapter] Docker unavailable - running natively (staged files not available to command)');
        }
      }
      
      // Fallback: run natively from workspace root
      const out = execSync(command, {
        cwd: this.config.getWorkspaceRoot(),
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: getShellTimeout()
      });
      return { success: true, output: out.trim() };
    } catch (err: unknown) {
      const text = errShell(err);
      return { success: false, error: text || errMsg(err) || 'shell failed' };
    }
  }

  private async webSearchTool(params: { query: string }): Promise<ToolResult> {
    const query = String(params.query || '').trim();
    if (!query) return { success: false, error: 'web_search requires query' };
    const braveKey = process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY;
    if (!braveKey) return { success: false, error: 'web_search unavailable (missing BRAVE_API_KEY)' };
    try {
      const res = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
        {
          headers: {
            'Accept': 'application/json',
            'X-Subscription-Token': braveKey
          },
          signal: AbortSignal.timeout(10000)
        }
      );
      if (!res.ok) return { success: false, error: `web_search failed: HTTP ${res.status}` };
      const data = await res.json() as SearchResponse;
      const hits = ((data?.web as { results?: SearchHit[] })?.results || []).slice(0, 5) as SearchHit[];
      const formatted = hits.map((r: SearchHit, i: number) =>
        `${i + 1}. ${r.title || '(untitled)'}\n${r.url || ''}\n${r.description || ''}`
      ).join('\n\n');
      return { success: true, output: formatted || 'No results' };
    } catch (err: unknown) {
      return { success: false, error: errMsg(err) || 'web_search failed' };
    }
  }

  private async webFetchTool(params: { url: string }): Promise<ToolResult> {
    const url = String(params.url || '').trim();
    if (!url || !/^https?:\/\//i.test(url)) {
      return { success: false, error: 'web_fetch requires valid http(s) url' };
    }
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'crewswarm-CLI/1.0' },
        signal: AbortSignal.timeout(12000)
      });
      if (!res.ok) return { success: false, error: `web_fetch failed: HTTP ${res.status}` };
      const ct = String(res.headers.get('content-type') || '');
      let text = await res.text();
      if (ct.includes('html')) {
        text = text
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .trim();
      }
      return { success: true, output: text.slice(0, 12000) };
    } catch (err: unknown) {
      return { success: false, error: errMsg(err) || 'web_fetch failed' };
    }
  }

  private async readManyFilesTool(params: {
    include?: string;
    exclude?: string | string[];
    recursive?: boolean;
  }): Promise<ToolResult> {
    const include = String(params.include || '**/*').trim();
    try {
      const out = execSync(`rg --files -g ${JSON.stringify(include)}`, {
        cwd: this.config.getWorkspaceRoot(),
        stdio: 'pipe',
        encoding: 'utf8'
      });
      const files = out.split('\n').filter(Boolean).slice(0, 20);
      const chunks: string[] = [];
      for (const rel of files) {
        const full = resolve(this.config.getWorkspaceRoot(), rel);
        try {
          const content = await readFile(full, 'utf8');
          chunks.push(`--- ${rel} ---\n${content.slice(0, 2000)}`);
        } catch {
          // Skip unreadable/non-text
        }
      }
      return { success: true, output: chunks.join('\n\n') || 'No readable files matched' };
    } catch (err: unknown) {
      return { success: false, error: errMsg(err) || 'read_many_files failed' };
    }
  }

  private async saveMemoryTool(params: { fact: string }): Promise<ToolResult> {
    const fact = String(params.fact || '').trim();
    if (!fact) return { success: false, error: 'save_memory requires fact' };
    const memDir = resolve(this.config.getWorkspaceRoot(), '.crew');
    await mkdir(memDir, { recursive: true });
    const memFile = resolve(memDir, 'memory-facts.log');
    let prior = '';
    try { prior = await readFile(memFile, 'utf8'); } catch {}
    await writeFile(memFile, `${prior}${new Date().toISOString()} ${fact}\n`, 'utf8');
    return { success: true, output: 'Memory saved' };
  }

  private async writeTodosTool(params: { todos: unknown[] }): Promise<ToolResult> {
    const todos = Array.isArray(params.todos) ? params.todos : [];
    const memDir = resolve(this.config.getWorkspaceRoot(), '.crew');
    await mkdir(memDir, { recursive: true });
    const todoFile = resolve(memDir, 'todos.json');
    await writeFile(todoFile, JSON.stringify(todos, null, 2), 'utf8');
    return { success: true, output: `Saved ${todos.length} todos` };
  }

  private async getInternalDocsTool(params: { path?: string }): Promise<ToolResult> {
    const target = String(params.path || 'AGENTS.md').trim();
    const abs = resolve(this.config.getWorkspaceRoot(), target);
    try {
      const content = await readFile(abs, 'utf8');
      return { success: true, output: content.slice(0, 12000) };
    } catch (err: unknown) {
      return { success: false, error: `get_internal_docs failed: ${errMsg(err) || target}` };
    }
  }

  private async askUserTool(params: { questions?: unknown[] }): Promise<ToolResult> {
    const qs = Array.isArray(params.questions) ? params.questions : [];
    if (qs.length === 0) {
      return { success: false, error: 'ask_user requires at least one question' };
    }
    const now = new Date().toISOString();
    const request = {
      id: `ask-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      ts: now,
      status: 'pending',
      questions: qs
    };
    const crewDir = this.crewDirPath();
    await mkdir(crewDir, { recursive: true });
    await this.appendJsonLine(this.askUserRequestsPath(), request);
    await writeFile(this.askUserLatestPath(), JSON.stringify(request, null, 2), 'utf8');
    const summary = qs.map((q: unknown, i: number) => `${i + 1}. ${(q as Record<string, unknown>)?.question || 'question'}`).join('\n');
    return {
      success: true,
      output: `User input required (non-interactive runtime).\nSaved request: ${this.relativeCrewPath(this.askUserLatestPath())}\nQuestions:\n${summary}`
    };
  }

  private async enterPlanModeTool(params: { reason?: string }): Promise<ToolResult> {
    const crewDir = this.crewDirPath();
    await mkdir(crewDir, { recursive: true });
    const state = {
      active: true,
      enteredAt: new Date().toISOString(),
      exitedAt: null,
      reason: String(params?.reason || '').trim() || null,
      planPath: null
    };
    await writeFile(this.planModeStatePath(), JSON.stringify(state, null, 2), 'utf8');
    return {
      success: true,
      output: `Plan mode entered${state.reason ? `: ${state.reason}` : ''} (${this.relativeCrewPath(this.planModeStatePath())})`
    };
  }

  private async exitPlanModeTool(params: { plan_path?: string }): Promise<ToolResult> {
    const crewDir = this.crewDirPath();
    await mkdir(crewDir, { recursive: true });
    let prior: Record<string, unknown> = {};
    try {
      prior = JSON.parse(await readFile(this.planModeStatePath(), 'utf8')) as Record<string, unknown>;
    } catch {
      prior = {};
    }
    const state = {
      ...prior,
      active: false,
      exitedAt: new Date().toISOString(),
      planPath: String(params?.plan_path || '').trim() || prior?.planPath || null
    };
    await writeFile(this.planModeStatePath(), JSON.stringify(state, null, 2), 'utf8');
    return {
      success: true,
      output: `Plan mode exited${state.planPath ? `: ${state.planPath}` : ''} (${this.relativeCrewPath(this.planModeStatePath())})`
    };
  }

  private async activateSkillTool(params: { name?: string }): Promise<ToolResult> {
    const name = String(params?.name || '').trim();
    if (!name) return { success: false, error: 'activate_skill requires name' };
    const crewDir = this.crewDirPath();
    await mkdir(crewDir, { recursive: true });
    let state: { active?: unknown[] } = { active: [] };
    try {
      state = JSON.parse(await readFile(this.activeSkillsPath(), 'utf8')) as { active?: unknown[] };
    } catch {
      state = { active: [] };
    }
    const active = new Set(Array.isArray(state?.active) ? state.active : []);
    active.add(name);
    const next = {
      active: Array.from(active).sort(),
      updatedAt: new Date().toISOString()
    };
    await writeFile(this.activeSkillsPath(), JSON.stringify(next, null, 2), 'utf8');
    return { success: true, output: `Skill activated: ${name} (${this.relativeCrewPath(this.activeSkillsPath())})` };
  }

  private crewDirPath() {
    return resolve(this.config.getWorkspaceRoot(), '.crew');
  }

  private askUserRequestsPath() {
    return resolve(this.crewDirPath(), 'ask-user-requests.jsonl');
  }

  private askUserLatestPath() {
    return resolve(this.crewDirPath(), 'ask-user-latest.json');
  }

  private planModeStatePath() {
    return resolve(this.crewDirPath(), 'plan-mode.json');
  }

  private activeSkillsPath() {
    return resolve(this.crewDirPath(), 'active-skills.json');
  }

  private relativeCrewPath(absPath: string) {
    return absPath.replace(this.config.getWorkspaceRoot(), '.');
  }

  private async appendJsonLine(filePath: string, data: unknown): Promise<void> {
    let prior = '';
    try {
      prior = await readFile(filePath, 'utf8');
    } catch {
      prior = '';
    }
    const line = `${JSON.stringify(data)}\n`;
    await writeFile(filePath, `${prior}${line}`, 'utf8');
  }

  private trackerFilePath() {
    return resolve(this.config.getWorkspaceRoot(), '.crew', 'tracker.json');
  }

  private async readTracker(): Promise<TrackerTask[]> {
    try {
      const raw = await readFile(this.trackerFilePath(), 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async writeTracker(tasks: TrackerTask[]): Promise<void> {
    const dir = resolve(this.config.getWorkspaceRoot(), '.crew');
    await mkdir(dir, { recursive: true });
    await writeFile(this.trackerFilePath(), JSON.stringify(tasks, null, 2), 'utf8');
  }

  private mkTrackerId() {
    return Math.random().toString(16).slice(2, 8);
  }

  private async trackerCreateTaskTool(params: Record<string, unknown>): Promise<ToolResult> {
    const tasks = await this.readTracker();
    const task: TrackerTask = {
      id: this.mkTrackerId(),
      title: String(params?.title || 'Untitled'),
      description: String(params?.description || ''),
      type: String(params?.type || 'task'),
      status: 'pending',
      parentId: typeof params?.parentId === 'string' ? params.parentId : undefined,
      dependencies: Array.isArray(params?.dependencies) ? (params.dependencies as string[]) : []
    };
    tasks.push(task);
    await this.writeTracker(tasks);
    return { success: true, output: JSON.stringify(task, null, 2) };
  }

  private async trackerUpdateTaskTool(params: Record<string, unknown>): Promise<ToolResult> {
    const tasks = await this.readTracker();
    const id = String(params?.id || '');
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx < 0) return { success: false, error: `Task not found: ${id}` };
    tasks[idx] = { ...tasks[idx], ...params };
    await this.writeTracker(tasks);
    return { success: true, output: JSON.stringify(tasks[idx], null, 2) };
  }

  private async trackerGetTaskTool(params: Record<string, unknown>): Promise<ToolResult> {
    const tasks = await this.readTracker();
    const id = String(params?.id || '');
    const task = tasks.find((t) => t.id === id);
    if (!task) return { success: false, error: `Task not found: ${id}` };
    return { success: true, output: JSON.stringify(task, null, 2) };
  }

  private async trackerListTasksTool(params: Record<string, unknown>): Promise<ToolResult> {
    const tasks = await this.readTracker();
    const filtered = tasks.filter((t) => {
      if (params?.status && t.status !== params.status) return false;
      if (params?.type && t.type !== params.type) return false;
      if (params?.parentId && t.parentId !== params.parentId) return false;
      return true;
    });
    return { success: true, output: JSON.stringify(filtered, null, 2) };
  }

  private async trackerAddDependencyTool(params: Record<string, unknown>): Promise<ToolResult> {
    const tasks = await this.readTracker();
    const taskId = String(params?.taskId || '');
    const depId = String(params?.dependencyId || '');
    const idx = tasks.findIndex((t) => t.id === taskId);
    if (idx < 0) return { success: false, error: `Task not found: ${taskId}` };
    const deps = new Set(Array.isArray(tasks[idx].dependencies) ? tasks[idx].dependencies : []);
    deps.add(depId);
    tasks[idx].dependencies = Array.from(deps);
    await this.writeTracker(tasks);
    return { success: true, output: JSON.stringify(tasks[idx], null, 2) };
  }

  private async trackerVisualizeTool(): Promise<ToolResult> {
    const tasks = await this.readTracker();
    const lines = tasks.map((t) => {
      const deps = Array.isArray(t.dependencies) && t.dependencies.length
        ? ` -> [${t.dependencies.join(', ')}]`
        : '';
      return `${t.id} [${t.status}] ${t.title}${deps}`;
    });
    return { success: true, output: lines.join('\n') || '(no tasks)' };
  }

  private async lspTool(params: { query?: string; action?: string; file?: string; line?: number; column?: number; symbol?: string }): Promise<ToolResult> {
    // New action-based interface — inlined to avoid importing tools.ts (which has upstream missing deps)
    if (params.action && params.file) {
      return this.lspActionTool(params as { action: string; file: string; line?: number; column?: number; symbol?: string });
    }

    // Legacy query-based interface for backward compatibility
    const query = String(params.query || '').trim();
    if (!query) return { success: false, error: 'lsp requires action+file or legacy query string' };
    const lower = query.toLowerCase();
    const lsp = await import('../../lsp/index.js');
    if (lower.startsWith('symbols')) {
      const file = query.slice('symbols'.length).trim();
      if (!file) return { success: false, error: 'lsp symbols requires file path' };
      const symbols = await lsp.getDocumentSymbols(process.cwd(), file);
      return { success: true, output: symbols.map((s: LspSymbol) => `${file}:${s.line}:${s.column} ${s.kind} ${s.name}`).join('\n') };
    }
    if (lower.startsWith('refs')) {
      const target = query.slice('refs'.length).trim();
      const match = target.match(/^(.+):(\d+)(?::(\d+))?$/);
      if (match) {
        const refs = await lsp.getReferences(process.cwd(), match[1], Number(match[2]), Number(match[3] || '1'));
        return { success: true, output: refs.map((r: LspLocation) => `${r.file}:${r.line}:${r.column}`).join('\n') };
      }
      if (target) return this.grepTool({ pattern: `\\b${target}\\b`, path: '.' });
      return { success: false, error: 'lsp refs requires symbol or file:line[:col]' };
    }
    if (lower.startsWith('goto')) {
      const target = query.slice('goto'.length).trim();
      const match = target.match(/^(.+):(\d+)(?::(\d+))?$/);
      if (!match) return { success: false, error: 'lsp goto format: file:line[:col]' };
      const defs = await lsp.getDefinitions(process.cwd(), match[1], Number(match[2]), Number(match[3] || '1'));
      return { success: true, output: defs.map((d: LspLocation) => `${d.file}:${d.line}:${d.column}`).join('\n') };
    }
    if (lower.startsWith('diagnostics') || lower === 'check') {
      const diags = await lsp.typeCheckProject(process.cwd(), []);
      return { success: true, output: diags.map((d: LspDiagnostic) => `${d.file}:${d.line}:${d.column} [${d.category}] ${d.message}`).join('\n') };
    }
    if (lower.startsWith('complete')) {
      const target = query.slice('complete'.length).trim();
      const match = target.match(/^(.+):(\d+):(\d+)(?:\s+(.+))?$/);
      if (!match) return { success: false, error: 'lsp complete format: file:line:col [prefix]' };
      const items = await lsp.getCompletions(process.cwd(), match[1], Number(match[2]), Number(match[3]), 50, match[4] || '');
      return { success: true, output: items.map((i: LspCompletionItem) => `${i.name} (${i.kind})`).join('\n') };
    }
    return { success: false, error: `Unsupported lsp query: ${query}` };
  }

  /** Inline implementation of LSP action-based interface (avoids importing tools.ts) */
  private async lspActionTool(params: { action: string; file: string; line?: number; column?: number; symbol?: string }): Promise<ToolResult> {
    const { action, file, line, column, symbol } = params;
    const workspaceRoot = this.config.getWorkspaceRoot();
    const absFile = file.startsWith('/') ? file : resolve(workspaceRoot, file);
    const lsp = await import('../../lsp/index.js');
    const ext = absFile.slice(absFile.lastIndexOf('.') + 1).toLowerCase();
    const isTs = ext === 'ts' || ext === 'tsx';
    const isJs = ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs';

    try {
      if (action === 'diagnostics') {
        if (isTs || isJs) {
          try {
            const diags = await lsp.typeCheckProject(workspaceRoot, [absFile]);
            if (diags.length === 0) return { success: true, output: 'No diagnostics found.' };
            return { success: true, output: diags.map((d: LspDiagnostic) => `${d.file}:${d.line}:${d.column} [${d.category}] TS${d.code}: ${d.message}`).join('\n') };
          } catch {
            const out = execSync(`npx tsc --noEmit 2>&1 || true`, { cwd: workspaceRoot, encoding: 'utf8', timeout: 30000 });
            return { success: true, output: out.trim() || 'No diagnostics found.' };
          }
        }
        if (ext === 'py') {
          const out = execSync(`python -m py_compile ${JSON.stringify(absFile)} 2>&1 || true`, { cwd: workspaceRoot, encoding: 'utf8', timeout: 10000 });
          return { success: true, output: out.trim() || 'No syntax errors found.' };
        }
        return { success: false, error: `Diagnostics not supported for .${ext} files` };
      }

      if (action === 'definition') {
        if ((isTs || isJs) && line != null) {
          try {
            const defs = await lsp.getDefinitions(workspaceRoot, absFile, line, column ?? 1);
            if (defs.length === 0) return { success: true, output: 'No definition found.' };
            return { success: true, output: defs.map((d: LspLocation) => `${d.file}:${d.line}:${d.column}`).join('\n') };
          } catch { /* fall through to grep */ }
        }
        const sym = symbol || 'unknown';
        try {
          const out = execSync(`grep -rn -E "export (function|class|const|let|var|interface|type|enum) ${sym}|def ${sym}|func ${sym}|function ${sym}" .`, { cwd: workspaceRoot, encoding: 'utf8', timeout: 15000 });
          return { success: true, output: out.trim() || 'No definition found.' };
        } catch (e: unknown) {
          const es = e as Record<string, unknown>;
          return { success: true, output: es?.status === 1 ? 'No definition found.' : `grep failed: ${errMsg(e)}` };
        }
      }

      if (action === 'references') {
        if ((isTs || isJs) && line != null) {
          try {
            const refs = await lsp.getReferences(workspaceRoot, absFile, line, column ?? 1);
            if (refs.length === 0) return { success: true, output: 'No references found.' };
            return { success: true, output: refs.map((r: LspLocation) => `${r.file}:${r.line}:${r.column}`).join('\n') };
          } catch { /* fall through to grep */ }
        }
        const sym = symbol || 'unknown';
        try {
          const out = execSync(`grep -rn "\\b${sym}\\b" --include="*.ts" --include="*.js" --include="*.py" --include="*.go" .`, { cwd: workspaceRoot, encoding: 'utf8', timeout: 15000 });
          return { success: true, output: out.trim() || 'No references found.' };
        } catch (e: unknown) {
          const es = e as Record<string, unknown>;
          return { success: true, output: es?.status === 1 ? 'No references found.' : `grep failed: ${errMsg(e)}` };
        }
      }

      if (action === 'hover') {
        if (line == null) return { success: false, error: 'hover requires line' };
        if (isTs || isJs) {
          try {
            const symbols = await lsp.getDocumentSymbols(workspaceRoot, absFile);
            const near = symbols.filter((s: LspSymbol) => Math.abs(s.line - line) <= 1);
            if (near.length > 0) return { success: true, output: near.map((s: LspSymbol) => `${s.kind} ${s.name} (line ${s.line}:${s.column})`).join('\n') };
          } catch { /* fall through */ }
        }
        try {
          const content = await readFile(absFile, 'utf8');
          const lines = content.split('\n');
          return { success: true, output: lines[(line - 1)] || '' };
        } catch (e: unknown) {
          return { success: false, error: `Could not read file: ${errMsg(e)}` };
        }
      }

      if (action === 'completions') {
        if (line == null || column == null) return { success: false, error: 'completions requires line and column' };
        if (isTs || isJs) {
          try {
            const items = await lsp.getCompletions(workspaceRoot, absFile, line, column, 30, '');
            if (items.length === 0) return { success: true, output: 'No completions found.' };
            return { success: true, output: items.map((i: LspCompletionItem) => `${i.name} (${i.kind})`).join('\n') };
          } catch (e: unknown) {
            return { success: false, error: `completions failed: ${errMsg(e)}` };
          }
        }
        return { success: false, error: `Completions not supported for .${ext} files` };
      }

      return { success: false, error: `Unknown lsp action: ${action}` };
    } catch (err: unknown) {
      return { success: false, error: `LSP error: ${errMsg(err)}` };
    }
  }

  /** Inline implementation of notebook-edit actions (avoids importing tools.ts) */
  private async notebookEditTool(params: { action: string; path: string; index?: number; cell_type?: 'code' | 'markdown'; content?: string }): Promise<ToolResult> {
    const { action, index, content, cell_type } = params;
    const nbPath = params.path.startsWith('/') ? params.path : resolve(this.config.getWorkspaceRoot(), params.path);

    // Load notebook
    async function loadNb() {
      try {
        const raw = await readFile(nbPath, 'utf8');
        return JSON.parse(raw);
      } catch (e: unknown) {
        throw new Error(`Cannot read notebook ${params.path}: ${errMsg(e)}`);
      }
    }

    async function saveNb(nb: Notebook) {
      await mkdir(dirname(nbPath), { recursive: true });
      await writeFile(nbPath, JSON.stringify(nb, null, 1), 'utf8');
    }

    function toLines(src: string): string[] {
      if (!src) return [];
      const parts = src.split('\n');
      return parts.map((l, i) => i < parts.length - 1 ? `${l}\n` : l);
    }

    try {
      if (action === 'read') {
        const nb = await loadNb();
        const cells = (nb.cells || []).map((c: NotebookCell, i: number) => {
          const src = (Array.isArray(c.source) ? c.source.join('') : c.source || '').slice(0, 200);
          const outs = Array.isArray(c.outputs) && c.outputs.length ? ` [${c.outputs.length} output(s)]` : '';
          return `[${i}] ${c.cell_type}${outs}:\n${src}`;
        });
        const summary = `Notebook: ${params.path}\nFormat: ${nb.nbformat}.${nb.nbformat_minor}\nCells: ${nb.cells.length}\n\n${cells.join('\n\n')}`;
        return { success: true, output: summary };
      }

      if (action === 'add_cell') {
        if (content == null) return { success: false, error: "add_cell requires 'content'" };
        const nb = await loadNb();
        const newCell: NotebookCell = { cell_type: cell_type ?? 'code', source: toLines(content), metadata: {}, outputs: [], execution_count: null };
        if (index != null && index >= 0 && index <= nb.cells.length) nb.cells.splice(index, 0, newCell);
        else nb.cells.push(newCell);
        await saveNb(nb);
        return { success: true, output: `Added ${newCell.cell_type} cell at index ${index ?? nb.cells.length - 1}` };
      }

      if (action === 'edit_cell') {
        if (index == null) return { success: false, error: "edit_cell requires 'index'" };
        if (content == null) return { success: false, error: "edit_cell requires 'content'" };
        const nb = await loadNb();
        if (index < 0 || index >= nb.cells.length) return { success: false, output: `Cell index ${index} out of range (notebook has ${nb.cells.length} cells)` };
        nb.cells[index].source = toLines(content);
        if (nb.cells[index].cell_type === 'code') { nb.cells[index].outputs = []; nb.cells[index].execution_count = null; }
        await saveNb(nb);
        return { success: true, output: `Edited cell ${index}` };
      }

      if (action === 'delete_cell') {
        if (index == null) return { success: false, error: "delete_cell requires 'index'" };
        const nb = await loadNb();
        if (index < 0 || index >= nb.cells.length) return { success: false, output: `Cell index ${index} out of range (notebook has ${nb.cells.length} cells)` };
        nb.cells.splice(index, 1);
        await saveNb(nb);
        return { success: true, output: `Deleted cell ${index} (${nb.cells.length} cells remaining)` };
      }

      if (action === 'run_cell') {
        if (index == null) return { success: false, error: "run_cell requires 'index'" };
        const nb = await loadNb();
        if (index < 0 || index >= nb.cells.length) return { success: false, error: `Cell index ${index} out of range` };
        const cell = nb.cells[index];
        if (cell.cell_type !== 'code') return { success: false, error: `Cell ${index} is ${cell.cell_type}, only code cells can be run` };
        const src = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
        try {
          const out = execSync(`python3 -c ${JSON.stringify(src)}`, { cwd: this.config.getWorkspaceRoot(), encoding: 'utf8', timeout: 30000 });
          return { success: true, output: `Cell ${index} executed:\n${out.trim() || '(no output)'}` };
        } catch (pyErr: unknown) {
          const stderr = errShell(pyErr).trim() || errMsg(pyErr) || 'execution failed';
          return { success: false, error: `Cell ${index} execution failed:\n${stderr}` };
        }
      }

      return { success: false, error: `Unknown notebook_edit action: ${action}` };
    } catch (err: unknown) {
      return { success: false, error: `NotebookEdit error: ${errMsg(err)}` };
    }
  }

  private async checkBackgroundTask(params: { task_id: string }): Promise<ToolResult> {
    const taskId = String(params.task_id || '').trim();
    if (!taskId) return { success: false, error: 'check_background_task requires task_id' };
    const bg = _backgroundProcesses.get(taskId);
    if (!bg) return { success: false, error: `No background task found with ID: ${taskId}` };

    // Check if done (non-blocking with race against a resolved promise)
    const done = await Promise.race([
      bg.promise.then(r => ({ done: true as const, result: r })),
      new Promise<{ done: false }>(resolve => setTimeout(() => resolve({ done: false }), 50))
    ]);

    if (!done.done) {
      const elapsed = Math.round((Date.now() - bg.startedAt) / 1000);
      return { success: true, output: `Task ${taskId} still running (${elapsed}s elapsed). Check again later.` };
    }

    _backgroundProcesses.delete(taskId);
    return done.result;
  }

  // Track sub-agent depth to prevent infinite recursion
  private static _spawnDepth = 0;
  private static readonly MAX_SPAWN_DEPTH = 3;

  // ─── Multi-turn sub-agent sessions ──────────────────────────────────────
  // Each session tracks its conversation history, branch, and model so the
  // parent agent can send follow-up messages to an existing sub-agent.
  private static _agentSessions = new Map<string, {
    history: Array<{ role: string; content: string }>;
    branch: string;
    model: string;
    totalCost: number;
    totalTurns: number;
  }>();

  private async spawnAgentTool(params: { task: string; model?: string; max_turns?: number }): Promise<ToolResult> {
    const task = String(params.task || '').trim();
    if (!task) return { success: false, error: 'spawn_agent requires task' };

    if (GeminiToolAdapter._spawnDepth >= GeminiToolAdapter.MAX_SPAWN_DEPTH) {
      return { success: false, error: `Sub-agent depth limit reached (max ${GeminiToolAdapter.MAX_SPAWN_DEPTH}). Complete this task directly instead.` };
    }

    const maxTurns = Math.min(params.max_turns || 15, 25);
    const model = params.model || process.env.CREW_WORKER_MODEL || process.env.CREW_EXECUTION_MODEL || '';
    const sessionId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const branchName = `sub-agent-${sessionId}`;

    try {
      // Create isolated sandbox branch for sub-agent
      await this.sandbox.createBranch(branchName);

      GeminiToolAdapter._spawnDepth++;

      const { runAgenticWorker } = await import('../../executor/agentic-executor.js');
      const result = await runAgenticWorker(task, this.sandbox, {
        model,
        maxTurns,
        stream: false,
        verbose: Boolean(process.env.CREW_DEBUG),
        tier: 'fast'
      });

      GeminiToolAdapter._spawnDepth--;

      // Store session for multi-turn follow-ups (don't merge yet)
      GeminiToolAdapter._agentSessions.set(sessionId, {
        history: [
          { role: 'user', content: task },
          { role: 'assistant', content: result.output || '' }
        ],
        branch: branchName,
        model,
        totalCost: result.cost || 0,
        totalTurns: result.turns || 0,
      });

      // Merge sub-agent changes back to parent branch
      const parentBranch = this.sandbox.getActiveBranch();
      if (parentBranch !== branchName) {
        await this.sandbox.mergeBranch(branchName, parentBranch);
      } else {
        const branches = this.sandbox.getBranches();
        const parent = branches.find(b => b !== branchName) || 'main';
        await this.sandbox.switchBranch(parent);
        await this.sandbox.mergeBranch(branchName, parent);
      }

      const output = [
        `Sub-agent completed in ${result.turns || 0} turns (${result.modelUsed || 'unknown'})`,
        `Session: ${sessionId} (use agent_message to send follow-ups)`,
        result.cost ? `Cost: $${result.cost.toFixed(4)}` : '',
        `Status: ${result.success ? 'SUCCESS' : 'FAILED'}`,
        '',
        result.output?.slice(0, 3000) || '(no output)'
      ].filter(Boolean).join('\n');

      return { success: result.success, output };
    } catch (err: unknown) {
      GeminiToolAdapter._spawnDepth = Math.max(0, GeminiToolAdapter._spawnDepth - 1);
      try { await this.sandbox.switchBranch('main'); } catch { /* ignore */ }
      try { await this.sandbox.deleteBranch(branchName); } catch { /* ignore */ }
      return { success: false, error: `Sub-agent failed: ${errMsg(err)}` };
    }
  }

  // ─── agent_message: send follow-up to an existing sub-agent session ─────
  private async agentMessageTool(params: { session_id: string; message: string; max_turns?: number }): Promise<ToolResult> {
    const sessionId = String(params.session_id || '').trim();
    const message = String(params.message || '').trim();
    if (!sessionId) return { success: false, error: 'agent_message requires session_id' };
    if (!message) return { success: false, error: 'agent_message requires message' };

    const session = GeminiToolAdapter._agentSessions.get(sessionId);
    if (!session) {
      const available = [...GeminiToolAdapter._agentSessions.keys()];
      return {
        success: false,
        error: `No active session "${sessionId}". Active sessions: ${available.length ? available.join(', ') : '(none)'}`
      };
    }

    if (GeminiToolAdapter._spawnDepth >= GeminiToolAdapter.MAX_SPAWN_DEPTH) {
      return { success: false, error: `Sub-agent depth limit reached (max ${GeminiToolAdapter.MAX_SPAWN_DEPTH}).` };
    }

    const maxTurns = Math.min(params.max_turns || 10, 25);

    // Build a combined task with conversation history as context
    const historyContext = session.history
      .map(h => `[${h.role}]: ${h.content.slice(0, 1500)}`)
      .join('\n\n');
    const continuationTask = [
      '## Prior conversation with this sub-agent:',
      historyContext,
      '',
      '## New follow-up message:',
      message,
      '',
      'Continue the work from where you left off. You have the same file access and tools.',
    ].join('\n');

    // Switch to the sub-agent's branch
    try {
      await this.sandbox.switchBranch(session.branch);
    } catch {
      // Branch may have been cleaned up — work on current branch
    }

    GeminiToolAdapter._spawnDepth++;

    try {
      const { runAgenticWorker } = await import('../../executor/agentic-executor.js');
      const result = await runAgenticWorker(continuationTask, this.sandbox, {
        model: session.model,
        maxTurns,
        stream: false,
        verbose: Boolean(process.env.CREW_DEBUG),
        tier: 'fast'
      });

      GeminiToolAdapter._spawnDepth--;

      // Update session history
      session.history.push(
        { role: 'user', content: message },
        { role: 'assistant', content: result.output || '' }
      );
      session.totalCost += result.cost || 0;
      session.totalTurns += result.turns || 0;

      // Merge changes back
      try {
        const parentBranch = this.sandbox.getActiveBranch();
        if (parentBranch === session.branch) {
          const branches = this.sandbox.getBranches();
          const parent = branches.find(b => b !== session.branch) || 'main';
          await this.sandbox.switchBranch(parent);
          await this.sandbox.mergeBranch(session.branch, parent);
        } else {
          await this.sandbox.mergeBranch(session.branch, parentBranch);
        }
      } catch { /* merge may not be needed */ }

      const output = [
        `Sub-agent follow-up completed in ${result.turns || 0} turns`,
        `Session: ${sessionId} (${session.history.length / 2} exchanges, $${session.totalCost.toFixed(4)} total)`,
        `Status: ${result.success ? 'SUCCESS' : 'FAILED'}`,
        '',
        result.output?.slice(0, 3000) || '(no output)'
      ].filter(Boolean).join('\n');

      return { success: result.success, output };
    } catch (err: unknown) {
      GeminiToolAdapter._spawnDepth = Math.max(0, GeminiToolAdapter._spawnDepth - 1);
      try { await this.sandbox.switchBranch('main'); } catch { /* ignore */ }
      return { success: false, error: `Sub-agent follow-up failed: ${errMsg(err)}` };
    }
  }

  /**
   * Get tool declarations for LLM function calling
   */
  getToolDeclarations() {
    const dynamicEnabled = process.env.CREW_GEMINI_DYNAMIC_DECLARATIONS !== 'false';
    let allDecls: ToolDeclarationSchema[] | undefined;
    if (dynamicEnabled) {
      try {
        const decls = this.buildDynamicDeclarations();
        allDecls = decls.length > 0 ? decls : undefined;
      } catch {
        // Fallback to static declarations below.
      }
    }
    if (!allDecls) {
      allDecls = [
      {
        name: 'read_file',
        description: 'Read the contents of a file. ALWAYS read files before editing them. Use start_line/end_line for large files.',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Relative path from project root' },
            start_line: { type: 'number', description: 'Start line number (1-based, optional)' },
            end_line: { type: 'number', description: 'End line number (inclusive, optional)' }
          },
          required: ['file_path']
        }
      },
      {
        name: 'glob',
        description: 'Find files matching a glob pattern. Use this to discover file structure. Examples: "**/*.ts", "src/**/*.tsx", "*.json"',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Glob pattern (e.g. "src/**/*.ts")' }
          },
          required: ['pattern']
        }
      },
      {
        name: 'grep',
        description: 'Search for text/regex patterns in files. Returns matching lines with file paths and line numbers.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Regex or text pattern to search for' },
            path: { type: 'string', description: 'Directory or file to search in (default: ".")' }
          },
          required: ['pattern']
        }
      },
      {
        name: 'grep_search',
        description: 'Canonical alias for grep. Search for regex/text in files.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Regex/text pattern' },
            dir_path: { type: 'string', description: 'Path to search (default: .)' }
          },
          required: ['pattern']
        }
      },
      {
        name: 'grep_search_ripgrep',
        description: 'Ripgrep-optimized canonical name. Routed to grep tool in this adapter.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Regex/text pattern' },
            dir_path: { type: 'string', description: 'Path to search (default: .)' },
            path: { type: 'string', description: 'Alternative path field' }
          },
          required: ['pattern']
        }
      },
      {
        name: 'write_file',
        description: 'Write content to a file (creates or overwrites). Changes are staged in sandbox. Use for new files or full rewrites.',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Relative path from project root' },
            content: { type: 'string', description: 'Complete file content' }
          },
          required: ['file_path', 'content']
        }
      },
      {
        name: 'append_file',
        description: 'Append content to an existing file. Creates file if it does not exist. Changes are staged in sandbox.',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Relative path from project root' },
            content: { type: 'string', description: 'Content to append' }
          },
          required: ['file_path', 'content']
        }
      },
      {
        name: 'edit',
        description: 'Edit a file by replacing an exact string match. ALWAYS read the file first to get the exact string. Use for targeted changes.',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Relative path from project root' },
            old_string: { type: 'string', description: 'Exact string to find (must match precisely)' },
            new_string: { type: 'string', description: 'Replacement string' }
          },
          required: ['file_path', 'old_string', 'new_string']
        }
      },
      {
        name: 'replace',
        description: 'Canonical alias for edit. Replace exact old_string with new_string.',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Relative path from project root' },
            old_string: { type: 'string', description: 'Exact string to replace' },
            new_string: { type: 'string', description: 'Replacement string' }
          },
          required: ['file_path', 'old_string', 'new_string']
        }
      },
      {
        name: 'shell',
        description: 'Run a shell command (e.g. npm test, node script.js, cat, ls). Use for build verification, running tests, or commands not covered by other tools.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to execute' }
          },
          required: ['command']
        }
      },
      {
        name: 'run_cmd',
        description: 'Alias for shell. Run a shell command. Prefer this for compatibility with existing prompts.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to execute' }
          },
          required: ['command']
        }
      },
      {
        name: 'run_shell_command',
        description: 'Canonical alias for shell/run_cmd.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to execute' }
          },
          required: ['command']
        }
      },
      {
        name: 'mkdir',
        description: 'Create a directory (staged via .gitkeep in sandbox).',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path to create' },
            dir_path: { type: 'string', description: 'Alternate directory path field' }
          },
          required: []
        }
      },
      {
        name: 'list',
        description: 'List files and directories for a path.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to list (default: .)' },
            dir_path: { type: 'string', description: 'Alternate path field' }
          },
          required: []
        }
      },
      {
        name: 'list_directory',
        description: 'Canonical alias for list.',
        parameters: {
          type: 'object',
          properties: {
            dir_path: { type: 'string', description: 'Directory path to list (default: .)' }
          },
          required: []
        }
      },
      {
        name: 'git',
        description: 'Run git subcommands (status, diff, log, show, branch). Use to understand repo state and recent changes.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Git subcommand (e.g. "diff HEAD~3", "log --oneline -10")' }
          },
          required: ['command']
        }
      },
      {
        name: 'lsp',
        description: 'Code intelligence: "symbols <file>" for outline, "refs <file:line:col>" for references, "goto <file:line:col>" for definition, "diagnostics" for type errors.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'LSP query (e.g. "symbols src/app.ts", "goto src/app.ts:42:5")' }
          },
          required: ['query']
        }
      },
      {
        name: 'web_search',
        description: 'Search the web via Brave Search API (requires BRAVE_API_KEY).',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' }
          },
          required: ['query']
        }
      },
      {
        name: 'google_web_search',
        description: 'Canonical alias for web_search.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' }
          },
          required: ['query']
        }
      },
      {
        name: 'web_fetch',
        description: 'Fetch content from a URL and return cleaned text for analysis.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'http(s) URL to fetch' }
          },
          required: ['url']
        }
      },
      {
        name: 'read_many_files',
        description: 'Read multiple files by include glob and return concatenated excerpts.',
        parameters: {
          type: 'object',
          properties: {
            include: { type: 'string', description: 'Glob include pattern (default: **/*)' },
            exclude: { type: 'string', description: 'Optional exclude glob' },
            recursive: { type: 'boolean', description: 'Recursive search (optional)' }
          },
          required: []
        }
      },
      {
        name: 'save_memory',
        description: 'Save a memory fact to local project memory log.',
        parameters: {
          type: 'object',
          properties: {
            fact: { type: 'string', description: 'Memory fact to persist' }
          },
          required: ['fact']
        }
      },
      {
        name: 'write_todos',
        description: 'Persist todo items for the current project.',
        parameters: {
          type: 'object',
          properties: {
            todos: { type: 'array', description: 'Todo items array' }
          },
          required: ['todos']
        }
      },
      {
        name: 'get_internal_docs',
        description: 'Read internal docs by relative path (default AGENTS.md).',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative doc path' }
          },
          required: []
        }
      },
      {
        name: 'ask_user',
        description: 'Non-interactive placeholder for ask-user; returns summarized questions.',
        parameters: {
          type: 'object',
          properties: {
            questions: { type: 'array', description: 'Question descriptors' }
          },
          required: []
        }
      },
      {
        name: 'enter_plan_mode',
        description: 'Enter plan mode (no-op marker in CLI adapter).',
        parameters: {
          type: 'object',
          properties: {
            reason: { type: 'string', description: 'Plan mode reason' }
          },
          required: []
        }
      },
      {
        name: 'exit_plan_mode',
        description: 'Exit plan mode (no-op marker in CLI adapter).',
        parameters: {
          type: 'object',
          properties: {
            plan_path: { type: 'string', description: 'Optional plan file path' }
          },
          required: []
        }
      },
      {
        name: 'activate_skill',
        description: 'Activate a named skill (adapter acknowledgment).',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Skill name' }
          },
          required: ['name']
        }
      },
      {
        name: 'tracker_create_task',
        description: 'Create tracker task in local .crew/tracker.json.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            type: { type: 'string' },
            parentId: { type: 'string' },
            dependencies: { type: 'array' }
          },
          required: ['title', 'description', 'type']
        }
      },
      {
        name: 'tracker_update_task',
        description: 'Update tracker task by id.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            status: { type: 'string' },
            dependencies: { type: 'array' }
          },
          required: ['id']
        }
      },
      {
        name: 'tracker_get_task',
        description: 'Get tracker task by id.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string' }
          },
          required: ['id']
        }
      },
      {
        name: 'tracker_list_tasks',
        description: 'List tracker tasks with optional filters.',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            type: { type: 'string' },
            parentId: { type: 'string' }
          },
          required: []
        }
      },
      {
        name: 'tracker_add_dependency',
        description: 'Add dependency between tracker tasks.',
        parameters: {
          type: 'object',
          properties: {
            taskId: { type: 'string' },
            dependencyId: { type: 'string' }
          },
          required: ['taskId', 'dependencyId']
        }
      },
      {
        name: 'tracker_visualize',
        description: 'Visualize tracker tasks as ASCII list.',
        parameters: {
          type: 'object',
          properties: {},
          required: []
        }
      }
    ];
    }

    // Filter by constraint level — removes tools the worker shouldn't see
    if (this._constraintLevel !== 'full') {
      allDecls = allDecls.filter((d) => toolAllowedAtLevel(d.name, this._constraintLevel));
    }
    return allDecls;
  }

  // ─── Worktree Isolation Tools ────────────────────────────────────

  private enterWorktreeTool(params: { branch_prefix?: string; agent_id?: string }): ToolResult {
    try {
      const info = enterWorktree(this.sandbox.getBaseDir() || process.cwd(), {
        branchPrefix: params.branch_prefix,
        agentId: params.agent_id
      });
      return {
        success: true,
        output: JSON.stringify({
          worktreePath: info.worktreePath,
          branchName: info.branchName,
          baseBranch: info.baseBranch,
          message: `Created worktree at ${info.worktreePath} on branch ${info.branchName}`
        })
      };
    } catch (err: unknown) {
      return { success: false, error: errMsg(err) };
    }
  }

  private async exitWorktreeTool(params: { branch_name: string }): Promise<ToolResult> {
    if (!params.branch_name) return { success: false, error: 'exit_worktree requires branch_name' };
    try {
      const result = await exitWorktree(this.sandbox.getBaseDir() || process.cwd(), params.branch_name);
      return {
        success: true,
        output: JSON.stringify({
          hasChanges: result.hasChanges,
          branchName: result.branchName,
          commitCount: result.commitCount,
          message: result.hasChanges
            ? `Worktree exited with ${result.commitCount} commits on ${result.branchName}. Use merge_worktree to merge.`
            : `Worktree cleaned up — no changes were made.`
        })
      };
    } catch (err: unknown) {
      return { success: false, error: errMsg(err) };
    }
  }

  private mergeWorktreeTool(params: { branch_name: string; strategy?: 'merge' | 'squash' }): ToolResult {
    if (!params.branch_name) return { success: false, error: 'merge_worktree requires branch_name' };
    try {
      const result = mergeWorktree(
        this.sandbox.getBaseDir() || process.cwd(),
        params.branch_name,
        params.strategy || 'squash'
      );
      return { success: result.success, output: result.message, error: result.success ? undefined : result.message };
    } catch (err: unknown) {
      return { success: false, error: errMsg(err) };
    }
  }

  private listWorktreesTool(): ToolResult {
    const trees = listWorktrees();
    if (trees.length === 0) {
      return { success: true, output: 'No active worktrees.' };
    }
    return {
      success: true,
      output: JSON.stringify(trees.map(t => ({
        branch: t.branchName,
        path: t.worktreePath,
        baseBranch: t.baseBranch,
        createdAt: t.createdAt
      })), null, 2)
    };
  }

  // ─── Unified Worktree Tool (dispatches to sub-actions) ───────────────────

  private async worktreeUnifiedTool(params: {
    action: 'enter' | 'exit' | 'merge' | 'list';
    branch?: string;
    merge?: boolean;
    projectDir?: string;
  }): Promise<ToolResult> {
    const { action, branch, projectDir } = params;
    const cwd = projectDir || this.sandbox.getBaseDir() || process.cwd();

    switch (action) {
      case 'enter':
        return this.enterWorktreeTool({ branch_prefix: branch, agent_id: undefined });
      case 'exit':
        if (!branch) return { success: false, error: 'branch is required for exit action' };
        return await this.exitWorktreeTool({ branch_name: branch });
      case 'merge':
        if (!branch) return { success: false, error: 'branch is required for merge action' };
        return this.mergeWorktreeTool({ branch_name: branch, strategy: 'merge' });
      case 'list':
        return this.listWorktreesTool();
      default:
        return { success: false, error: `Unknown worktree action: ${action}` };
    }
  }

  // ─── Sleep Tool ──────────────────────────────────────────────────────────

  private async sleepTool(params: { duration_ms: number; reason?: string }): Promise<ToolResult> {
    const MAX_SLEEP_MS = 60_000;
    const requested = typeof params.duration_ms === 'number' ? params.duration_ms : 0;
    const actual = Math.min(Math.max(0, requested), MAX_SLEEP_MS);
    const reason = params.reason || 'no reason given';

    await new Promise<void>(resolve => setTimeout(resolve, actual));

    const cappedNote = requested > MAX_SLEEP_MS ? ` (requested ${requested}ms, capped at ${MAX_SLEEP_MS}ms)` : '';
    return {
      success: true,
      output: JSON.stringify({ sleptMs: actual, reason, cappedNote: cappedNote || undefined }, null, 2)
    };
  }

  // ─── Tool Search Tool ────────────────────────────────────────────────────

  private toolSearchTool(params: { query: string; max_results?: number }): ToolResult {
    const query = (params.query || '').trim().toLowerCase();
    if (!query) return { success: false, error: 'query is required' };
    const maxResults = Math.max(1, params.max_results ?? 10);

    // Use static declarations as the source of truth in adapter context
    const allDecls = this.buildDynamicDeclarations();

    const scored = allDecls
      .map((decl) => {
        const name = (decl.name || '').toLowerCase();
        const desc = (decl.description || '').toLowerCase();
        let score = 0;
        if (name === query) score += 100;
        else if (name.startsWith(query)) score += 60;
        else if (name.includes(query)) score += 40;
        if (desc.includes(query)) score += 20;
        return { decl, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);

    if (scored.length === 0) {
      return { success: true, output: `No tools found matching "${params.query}".` };
    }

    const results = scored.map(({ decl }) => ({
      name: decl.name,
      description: decl.description,
      parameterSchema: decl.parameters || {}
    }));

    return {
      success: true,
      output: JSON.stringify({ query: params.query, count: results.length, results }, null, 2)
    };
  }
}
