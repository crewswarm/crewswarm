/**
 * Adapter to use Gemini CLI tools with crew-cli's sandbox
 */

import { Sandbox } from '../../sandbox/index.js';
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

// Minimal adapter types
export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
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

// Main adapter class
export class GeminiToolAdapter {
  private config: CrewConfig;
  private messageBus: CrewMessageBus;
  
  constructor(private sandbox: Sandbox) {
    const workspaceRoot = (sandbox as any).baseDir || process.cwd();
    this.config = new CrewConfig(workspaceRoot);
    this.messageBus = new CrewMessageBus();
  }

  private buildDynamicDeclarations(): any[] {
    // Pull canonical names from Gemini base declarations and hydrate schemas from static declarations.
    const staticDecls = this.getStaticToolDeclarations();
    const staticByName = new Map<string, any>(staticDecls.map((d: any) => [d.name, d]));
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
      'tracker_visualize'
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
      { alias: 'lsp', target: 'read_file' }
    ];

    const byName = new Map<string, any>();
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
      description: 'Run code-intel queries (symbols/refs/goto/diagnostics/complete).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'LSP query string' }
        },
        required: ['query']
      }
    });
    return Array.from(byName.values());
  }

  private getStaticToolDeclarations() {
    return [
      { name: 'read_file', description: 'Read file', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
      { name: 'write_file', description: 'Write file', parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } },
      { name: 'replace', description: 'Replace text in file', parameters: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['file_path', 'old_string', 'new_string'] } },
      { name: 'glob', description: 'Glob search', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
      { name: 'grep_search', description: 'Grep search', parameters: { type: 'object', properties: { pattern: { type: 'string' }, dir_path: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
      { name: 'grep_search_ripgrep', description: 'Ripgrep search', parameters: { type: 'object', properties: { pattern: { type: 'string' }, dir_path: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
      { name: 'list_directory', description: 'List directory', parameters: { type: 'object', properties: { dir_path: { type: 'string' }, path: { type: 'string' } } } },
      { name: 'run_shell_command', description: 'Run shell command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
      { name: 'google_web_search', description: 'Web search', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
      { name: 'web_fetch', description: 'Fetch URL', parameters: { type: 'object', properties: { url: { type: 'string' }, prompt: { type: 'string' } } } },
      { name: 'read_many_files', description: 'Read many files', parameters: { type: 'object', properties: { include: { type: 'string' }, exclude: { type: 'string' }, recursive: { type: 'boolean' } } } },
      { name: 'save_memory', description: 'Save memory fact', parameters: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] } },
      { name: 'write_todos', description: 'Write todos', parameters: { type: 'object', properties: { todos: { type: 'array' } }, required: ['todos'] } },
      { name: 'get_internal_docs', description: 'Read internal docs', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'ask_user', description: 'Ask user placeholder', parameters: { type: 'object', properties: { questions: { type: 'array' } } } },
      { name: 'enter_plan_mode', description: 'Enter plan mode', parameters: { type: 'object', properties: { reason: { type: 'string' } } } },
      { name: 'exit_plan_mode', description: 'Exit plan mode', parameters: { type: 'object', properties: { plan_path: { type: 'string' } } } },
      { name: 'activate_skill', description: 'Activate skill', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
      { name: 'tracker_create_task', description: 'Create tracker task', parameters: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, type: { type: 'string' }, parentId: { type: 'string' }, dependencies: { type: 'array' } }, required: ['title', 'description', 'type'] } },
      { name: 'tracker_update_task', description: 'Update tracker task', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      { name: 'tracker_get_task', description: 'Get tracker task', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      { name: 'tracker_list_tasks', description: 'List tracker tasks', parameters: { type: 'object', properties: { status: { type: 'string' }, type: { type: 'string' }, parentId: { type: 'string' } } } },
      { name: 'tracker_add_dependency', description: 'Add tracker dependency', parameters: { type: 'object', properties: { taskId: { type: 'string' }, dependencyId: { type: 'string' } }, required: ['taskId', 'dependencyId'] } },
      { name: 'tracker_visualize', description: 'Visualize tracker graph', parameters: { type: 'object', properties: {} } }
    ];
  }

  /**
   * Execute a tool call from LLM
   */
  async executeTool(toolName: string, params: any): Promise<ToolResult> {
    try {
      switch (toolName) {
        // Canonical Gemini names + local aliases
        case 'write_file':
          return await this.writeFile(params);
        case 'replace':
          return await this.editFile({
            file_path: params.file_path,
            old_string: params.old_string,
            new_string: params.new_string
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
            path: params.dir_path || params.path
          });
        case 'git':
          return await this.gitTool(params);
        case 'shell':
        case 'run_cmd':
        case 'run_shell_command':
          return await this.shellTool(params);
        case 'lsp':
          return await this.lspTool(params);
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
        default:
          return {
            success: false,
            error: `Unknown tool: ${toolName}`
          };
      }
    } catch (err: any) {
      return {
        success: false,
        error: err.message
      };
    }
  }
  
  private async writeFile(params: { file_path: string; content: string }): Promise<ToolResult> {
    // Stage in sandbox instead of writing directly
    await this.sandbox.addChange(params.file_path, params.content);
    return {
      success: true,
      output: `Staged ${params.file_path} (${params.content.length} bytes)`
    };
  }

  private async appendFile(params: { file_path: string; content: string }): Promise<ToolResult> {
    const filePath = resolve(this.config.getWorkspaceRoot(), params.file_path);
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
  
  private async editFile(params: { file_path: string; old_string: string; new_string: string }): Promise<ToolResult> {
    const filePath = resolve(this.config.getWorkspaceRoot(), params.file_path);
    const content = await readFile(filePath, 'utf8');
    
    if (!content.includes(params.old_string)) {
      return {
        success: false,
        error: `String not found in ${params.file_path}`
      };
    }
    
    const updated = content.replace(params.old_string, params.new_string);
    await this.sandbox.addChange(params.file_path, updated);
    
    return {
      success: true,
      output: `Edited ${params.file_path}`
    };
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
    } catch (err: any) {
      return { success: false, error: err?.stderr?.toString?.() || err?.message || 'glob failed' };
    }
  }

  private async grepTool(params: { pattern: string; path?: string }): Promise<ToolResult> {
    const pattern = String(params.pattern || '').trim();
    const searchPath = String(params.path || '.').trim();
    if (!pattern) return { success: false, error: 'grep requires pattern' };
    try {
      const out = execSync(`rg -n ${JSON.stringify(pattern)} ${JSON.stringify(searchPath)}`, {
        cwd: process.cwd(),
        stdio: 'pipe',
        encoding: 'utf8'
      });
      return { success: true, output: out.trim() };
    } catch (err: any) {
      const text = `${err?.stdout?.toString?.() || ''}\n${err?.stderr?.toString?.() || ''}`.trim();
      return { success: false, error: text || err?.message || 'grep failed' };
    }
  }

  private async gitTool(params: { command: string }): Promise<ToolResult> {
    const command = String(params.command || '').trim();
    if (!command) return { success: false, error: 'git requires command' };
    const allowed = ['status', 'diff', 'log', 'add', 'commit', 'show', 'branch'];
    const verb = command.split(/\s+/)[0];
    if (!allowed.includes(verb)) {
      return { success: false, error: `git subcommand not allowed: ${verb}` };
    }
    try {
      const out = execSync(`git ${command}`, { cwd: process.cwd(), stdio: 'pipe', encoding: 'utf8' });
      return { success: true, output: out.trim() };
    } catch (err: any) {
      const text = `${err?.stdout?.toString?.() || ''}\n${err?.stderr?.toString?.() || ''}`.trim();
      return { success: false, error: text || err?.message || 'git failed' };
    }
  }

  private async shellTool(params: { command: string }): Promise<ToolResult> {
    const command = String(params.command || '').trim();
    if (!command) return { success: false, error: 'shell requires command' };
    
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
            timeout: 10000
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
        timeout: 10000
      });
      return { success: true, output: out.trim() };
    } catch (err: any) {
      const text = `${err?.stdout?.toString?.() || ''}\n${err?.stderr?.toString?.() || ''}`.trim();
      return { success: false, error: text || err?.message || 'shell failed' };
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
      const data: any = await res.json();
      const hits = (data?.web?.results || []).slice(0, 5);
      const formatted = hits.map((r: any, i: number) =>
        `${i + 1}. ${r.title || '(untitled)'}\n${r.url || ''}\n${r.description || ''}`
      ).join('\n\n');
      return { success: true, output: formatted || 'No results' };
    } catch (err: any) {
      return { success: false, error: err?.message || 'web_search failed' };
    }
  }

  private async webFetchTool(params: { url: string }): Promise<ToolResult> {
    const url = String(params.url || '').trim();
    if (!url || !/^https?:\/\//i.test(url)) {
      return { success: false, error: 'web_fetch requires valid http(s) url' };
    }
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'CrewSwarm-CLI/1.0' },
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
    } catch (err: any) {
      return { success: false, error: err?.message || 'web_fetch failed' };
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
    } catch (err: any) {
      return { success: false, error: err?.message || 'read_many_files failed' };
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

  private async writeTodosTool(params: { todos: any[] }): Promise<ToolResult> {
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
    } catch (err: any) {
      return { success: false, error: `get_internal_docs failed: ${err?.message || target}` };
    }
  }

  private async askUserTool(params: { questions?: any[] }): Promise<ToolResult> {
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
    const summary = qs.map((q: any, i: number) => `${i + 1}. ${q?.question || 'question'}`).join('\n');
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
    let prior: any = {};
    try {
      prior = JSON.parse(await readFile(this.planModeStatePath(), 'utf8'));
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
    let state: any = { active: [] };
    try {
      state = JSON.parse(await readFile(this.activeSkillsPath(), 'utf8'));
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

  private async appendJsonLine(filePath: string, data: any): Promise<void> {
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

  private async readTracker(): Promise<any[]> {
    try {
      const raw = await readFile(this.trackerFilePath(), 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async writeTracker(tasks: any[]): Promise<void> {
    const dir = resolve(this.config.getWorkspaceRoot(), '.crew');
    await mkdir(dir, { recursive: true });
    await writeFile(this.trackerFilePath(), JSON.stringify(tasks, null, 2), 'utf8');
  }

  private mkTrackerId() {
    return Math.random().toString(16).slice(2, 8);
  }

  private async trackerCreateTaskTool(params: any): Promise<ToolResult> {
    const tasks = await this.readTracker();
    const task = {
      id: this.mkTrackerId(),
      title: String(params?.title || 'Untitled'),
      description: String(params?.description || ''),
      type: String(params?.type || 'task'),
      status: 'open',
      parentId: params?.parentId || null,
      dependencies: Array.isArray(params?.dependencies) ? params.dependencies : []
    };
    tasks.push(task);
    await this.writeTracker(tasks);
    return { success: true, output: JSON.stringify(task, null, 2) };
  }

  private async trackerUpdateTaskTool(params: any): Promise<ToolResult> {
    const tasks = await this.readTracker();
    const id = String(params?.id || '');
    const idx = tasks.findIndex((t: any) => t.id === id);
    if (idx < 0) return { success: false, error: `Task not found: ${id}` };
    tasks[idx] = { ...tasks[idx], ...params };
    await this.writeTracker(tasks);
    return { success: true, output: JSON.stringify(tasks[idx], null, 2) };
  }

  private async trackerGetTaskTool(params: any): Promise<ToolResult> {
    const tasks = await this.readTracker();
    const id = String(params?.id || '');
    const task = tasks.find((t: any) => t.id === id);
    if (!task) return { success: false, error: `Task not found: ${id}` };
    return { success: true, output: JSON.stringify(task, null, 2) };
  }

  private async trackerListTasksTool(params: any): Promise<ToolResult> {
    const tasks = await this.readTracker();
    const filtered = tasks.filter((t: any) => {
      if (params?.status && t.status !== params.status) return false;
      if (params?.type && t.type !== params.type) return false;
      if (params?.parentId && t.parentId !== params.parentId) return false;
      return true;
    });
    return { success: true, output: JSON.stringify(filtered, null, 2) };
  }

  private async trackerAddDependencyTool(params: any): Promise<ToolResult> {
    const tasks = await this.readTracker();
    const taskId = String(params?.taskId || '');
    const depId = String(params?.dependencyId || '');
    const idx = tasks.findIndex((t: any) => t.id === taskId);
    if (idx < 0) return { success: false, error: `Task not found: ${taskId}` };
    const deps = new Set(Array.isArray(tasks[idx].dependencies) ? tasks[idx].dependencies : []);
    deps.add(depId);
    tasks[idx].dependencies = Array.from(deps);
    await this.writeTracker(tasks);
    return { success: true, output: JSON.stringify(tasks[idx], null, 2) };
  }

  private async trackerVisualizeTool(): Promise<ToolResult> {
    const tasks = await this.readTracker();
    const lines = tasks.map((t: any) => {
      const deps = Array.isArray(t.dependencies) && t.dependencies.length
        ? ` -> [${t.dependencies.join(', ')}]`
        : '';
      return `${t.id} [${t.status}] ${t.title}${deps}`;
    });
    return { success: true, output: lines.join('\n') || '(no tasks)' };
  }

  private async lspTool(params: { query: string }): Promise<ToolResult> {
    const query = String(params.query || '').trim();
    if (!query) return { success: false, error: 'lsp requires query' };
    const lower = query.toLowerCase();
    const lsp = await import('../../lsp/index.js');
    if (lower.startsWith('symbols')) {
      const file = query.slice('symbols'.length).trim();
      if (!file) return { success: false, error: 'lsp symbols requires file path' };
      const symbols = await lsp.getDocumentSymbols(process.cwd(), file);
      return { success: true, output: symbols.map(s => `${file}:${s.line}:${s.column} ${s.kind} ${s.name}`).join('\n') };
    }
    if (lower.startsWith('refs')) {
      const target = query.slice('refs'.length).trim();
      const match = target.match(/^(.+):(\d+)(?::(\d+))?$/);
      if (match) {
        const refs = await lsp.getReferences(process.cwd(), match[1], Number(match[2]), Number(match[3] || '1'));
        return { success: true, output: refs.map(r => `${r.file}:${r.line}:${r.column}`).join('\n') };
      }
      if (target) return this.grepTool({ pattern: `\\b${target}\\b`, path: '.' });
      return { success: false, error: 'lsp refs requires symbol or file:line[:col]' };
    }
    if (lower.startsWith('goto')) {
      const target = query.slice('goto'.length).trim();
      const match = target.match(/^(.+):(\d+)(?::(\d+))?$/);
      if (!match) return { success: false, error: 'lsp goto format: file:line[:col]' };
      const defs = await lsp.getDefinitions(process.cwd(), match[1], Number(match[2]), Number(match[3] || '1'));
      return { success: true, output: defs.map(d => `${d.file}:${d.line}:${d.column}`).join('\n') };
    }
    if (lower.startsWith('diagnostics') || lower === 'check') {
      const diags = await lsp.typeCheckProject(process.cwd(), []);
      return { success: true, output: diags.map(d => `${d.file}:${d.line}:${d.column} [${d.category}] ${d.message}`).join('\n') };
    }
    if (lower.startsWith('complete')) {
      const target = query.slice('complete'.length).trim();
      const match = target.match(/^(.+):(\d+):(\d+)(?:\s+(.+))?$/);
      if (!match) return { success: false, error: 'lsp complete format: file:line:col [prefix]' };
      const items = await lsp.getCompletions(process.cwd(), match[1], Number(match[2]), Number(match[3]), 50, match[4] || '');
      return { success: true, output: items.map(i => `${i.name} (${i.kind})`).join('\n') };
    }
    return { success: false, error: `Unsupported lsp query: ${query}` };
  }
  
  /**
   * Get tool declarations for LLM function calling
   */
  getToolDeclarations() {
    const dynamicEnabled = process.env.CREW_GEMINI_DYNAMIC_DECLARATIONS !== 'false';
    if (dynamicEnabled) {
      try {
        const decls = this.buildDynamicDeclarations();
        if (decls.length > 0) return decls;
      } catch {
        // Fallback to static declarations below.
      }
    }
    return [
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
}
