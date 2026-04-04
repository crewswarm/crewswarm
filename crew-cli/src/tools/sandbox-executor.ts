/**
 * Sandbox-safe tool executor for crew-cli
 * All tools stage changes in sandbox instead of direct filesystem writes
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { DockerSandbox } from './docker-sandbox.js';
import type { Sandbox } from '../sandbox/index.js';

export interface ToolResult {
  message: string;
  success: boolean;
  toolType: string;
}

// Singleton Docker sandbox instance
let dockerSandbox: DockerSandbox | null = null;
let dockerAvailable: boolean | null = null;

async function getDockerSandbox(): Promise<DockerSandbox | null> {
  if (dockerSandbox) return dockerSandbox;
  
  dockerSandbox = new DockerSandbox();
  dockerAvailable = await dockerSandbox.isDockerAvailable();
  
  if (!dockerAvailable) {
    console.warn('[Sandbox] Docker not available - commands will run natively (less safe)');
    return null;
  }
  
  // Ensure Node image is available
  await dockerSandbox.ensureImage();
  return dockerSandbox;
}

export interface ToolResult {
  message: string;
  success: boolean;
  toolType: string;
}

/**
 * Execute all @@TOOL commands from LLM output, staging changes in sandbox
 */
export async function executeToolsWithSandbox(
  reply: string,
  sandbox: Sandbox,
  options: { allowRun?: boolean; allowWeb?: boolean } = {}
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];

  // Helper: Strip markdown code fences from file contents
  const stripMarkdownFences = (content: string): string => {
    // Strip opening fence: ```language or just ```
    content = content.replace(/^```[a-z]*\n/i, '');
    // Strip closing fence: ``` at end
    content = content.replace(/\n```\s*$/, '');
    return content;
  };

  // ── @@WRITE_FILE ──────────────────────────────────────────────────────────
  const writeRe = /@@WRITE_FILE[ \t]+([^\n]+)\n([\s\S]*?)@@END_FILE/g;
  let m;
  while ((m = writeRe.exec(reply)) !== null) {
    const filePath = m[1].trim();
    let contents = m[2];
    
    // Strip markdown code fences if present
    contents = stripMarkdownFences(contents);
    
    try {
      console.log(`[sandbox-executor] Calling sandbox.addChange("${filePath}", ${contents.length} bytes)`);
      await sandbox.addChange(filePath, contents);
      console.log(`[sandbox-executor] sandbox.addChange succeeded`);
      results.push({
        message: `Staged ${contents.length} bytes → ${filePath}`,
        success: true,
        toolType: 'write_file'
      });
    } catch (err) {
      console.error(`[sandbox-executor] sandbox.addChange failed: ${(err as Error).message}`);
      results.push({
        message: `Failed to stage ${filePath}: ${(err as Error).message}`,
        success: false,
        toolType: 'write_file'
      });
    }
  }

  // ── @@APPEND_FILE ─────────────────────────────────────────────────────────
  const appendRe = /@@APPEND_FILE[ \t]+([^\n]+)\n([\s\S]*?)@@END_FILE/g;
  while ((m = appendRe.exec(reply)) !== null) {
    const filePath = m[1].trim();
    let newContent = m[2];
    
    // Strip markdown code fences if present
    newContent = stripMarkdownFences(newContent);
    
    try {
      // Read existing content from sandbox or filesystem
      let existingContent = '';
      const pendingPaths = sandbox.getPendingPaths();
      if (pendingPaths.includes(filePath)) {
        // Get from sandbox
        const branch = sandbox.state?.branches?.[sandbox.getActiveBranch()];
        existingContent = branch?.[filePath]?.modified || '';
      } else if (fs.existsSync(filePath)) {
        // Get from filesystem
        existingContent = fs.readFileSync(filePath, 'utf8');
      }
      
      const combined = existingContent + newContent;
      await sandbox.addChange(filePath, combined);
      results.push({
        message: `Appended ${newContent.length} bytes → ${filePath}`,
        success: true,
        toolType: 'append_file'
      });
    } catch (err) {
      results.push({
        message: `Failed to append ${filePath}: ${(err as Error).message}`,
        success: false,
        toolType: 'append_file'
      });
    }
  }

  // ── @@READ_FILE ───────────────────────────────────────────────────────────
  const readRe = /@@READ_FILE[ \t]+([^\n@@]+)/g;
  while ((m = readRe.exec(reply)) !== null) {
    const filePath = m[1].trim();
    try {
      // Try to read from sandbox first, then filesystem
      let content = '';
      const pendingPaths = sandbox.getPendingPaths();
      if (pendingPaths.includes(filePath)) {
        const branch = sandbox.state?.branches?.[sandbox.getActiveBranch()];
        content = branch?.[filePath]?.modified || '';
      } else {
        content = fs.readFileSync(filePath, 'utf8');
      }
      
      const isDoc = /\.(md|txt|json|yaml|yml|toml)$/i.test(filePath);
      const limit = isDoc ? 12000 : 4000;
      const snippet = content.length > limit ? content.slice(0, limit) + '\n...[truncated]' : content;
      
      results.push({
        message: `📄 ${filePath} (${content.length} bytes):\n${snippet}`,
        success: true,
        toolType: 'read_file'
      });
    } catch (err) {
      results.push({
        message: `Cannot read ${filePath}: ${(err as Error).message}`,
        success: false,
        toolType: 'read_file'
      });
    }
  }

  // ── @@MKDIR ───────────────────────────────────────────────────────────────
  const mkdirRe = /@@MKDIR[ \t]+([^\n@@]+)/g;
  while ((m = mkdirRe.exec(reply)) !== null) {
    const dirPath = m[1].trim();
    try {
      // Stage a .gitkeep file to represent the directory
      await sandbox.addChange(path.join(dirPath, '.gitkeep'), '');
      results.push({
        message: `Staged directory: ${dirPath}`,
        success: true,
        toolType: 'mkdir'
      });
    } catch (err) {
      results.push({
        message: `Failed to stage directory ${dirPath}: ${(err as Error).message}`,
        success: false,
        toolType: 'mkdir'
      });
    }
  }

  // ── @@RUN_CMD ─────────────────────────────────────────────────────────────
  if (options.allowRun) {
    const cmdRe = /@@RUN_CMD[ \t]+([^\n]+)/g;
    while ((m = cmdRe.exec(reply)) !== null) {
      const cmd = m[1].trim();
      
      // Block dangerous commands
      const blocked = [
        /\brm\s+-[rf]{1,2}f?\b/,
        /\bsudo\b/,
        /curl[^|\n]*\|\s*(bash|sh)/i,
        /:\(\)\s*\{\s*:\|:&\s*\};?\s*:/
      ];
      
      if (blocked.some(re => re.test(cmd))) {
        results.push({
          message: `Blocked dangerous command: ${cmd}`,
          success: false,
          toolType: 'run_cmd'
        });
        continue;
      }
      
      try {
        // Check if we have staged files - if so, use Docker sandbox
        const hasStagedFiles = sandbox.getPendingPaths().length > 0;
        const docker = await getDockerSandbox();
        
        if (hasStagedFiles && docker) {
          // Run in Docker sandbox with staged files
          console.log(`[Sandbox] Running command in Docker with ${sandbox.getPendingPaths().length} staged file(s)`);
          const result = await docker.runCommand(cmd, sandbox, {
            workDir: process.cwd(),
            timeout: 30000
          });
          
          results.push({
            message: `$ ${cmd} [Docker sandbox]\n${result.output.slice(0, 2000)}${result.output.length > 2000 ? '\n...[truncated]' : ''}`,
            success: result.success,
            toolType: 'run_cmd'
          });
        } else {
          // No staged files or Docker unavailable - run natively
          if (hasStagedFiles) {
            console.warn(`[Sandbox] Running natively (Docker unavailable) - command may not see staged files!`);
          }
          
          const output = execSync(cmd, { 
            timeout: 15000, 
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe']
          });
          results.push({
            message: `$ ${cmd}\n${output.slice(0, 2000)}`,
            success: true,
            toolType: 'run_cmd'
          });
        }
      } catch (err: any) {
        results.push({
          message: `$ ${cmd}\n${err.message || err.stdout || err.stderr}`,
          success: false,
          toolType: 'run_cmd'
        });
      }
    }
  }

  // ── @@WEB_SEARCH ──────────────────────────────────────────────────────────
  if (options.allowWeb) {
    const searchRe = /@@WEB_SEARCH[ \t]+([^\n]+)/g;
    while ((m = searchRe.exec(reply)) !== null) {
      const query = m[1].trim();
      try {
        // Try Brave Search if API key available
        const braveKey = process.env.BRAVE_API_KEY;
        if (!braveKey) {
          results.push({
            message: `Web search unavailable (no BRAVE_API_KEY)`,
            success: false,
            toolType: 'web_search'
          });
          continue;
        }
        
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
        
        if (!res.ok) {
          results.push({
            message: `Search API error ${res.status}`,
            success: false,
            toolType: 'web_search'
          });
          continue;
        }
        
        const data = await res.json() as any;
        const hits = (data.web?.results || []).slice(0, 5);
        const formatted = hits.map((r: any, i: number) =>
          `${i + 1}. **${r.title}** — ${r.url}\n   ${r.description || ''}`
        ).join('\n');
        
        results.push({
          message: `🔍 Results for "${query}":\n${formatted}`,
          success: true,
          toolType: 'web_search'
        });
      } catch (err) {
        results.push({
          message: `Search failed: ${(err as Error).message}`,
          success: false,
          toolType: 'web_search'
        });
      }
    }
  }

  // ── @@WEB_FETCH ───────────────────────────────────────────────────────────
  if (options.allowWeb) {
    const fetchRe = /@@WEB_FETCH[ \t]+(https?:\/\/[^\n]+)/g;
    while ((m = fetchRe.exec(reply)) !== null) {
      const url = m[1].trim();
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'crewswarm-CLI/1.0' },
          signal: AbortSignal.timeout(12000)
        });
        
        if (!res.ok) {
          results.push({
            message: `HTTP ${res.status} fetching: ${url}`,
            success: false,
            toolType: 'web_fetch'
          });
          continue;
        }
        
        let text = await res.text();
        const ct = res.headers.get('content-type') || '';
        
        // Strip HTML
        if (ct.includes('html')) {
          text = text
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim();
        }
        
        const snippet = text.length > 8000 ? text.slice(0, 8000) + '\n...[truncated]' : text;
        results.push({
          message: `🌐 ${url} (${text.length} chars):\n${snippet}`,
          success: true,
          toolType: 'web_fetch'
        });
      } catch (err) {
        results.push({
          message: `Fetch failed: ${(err as Error).message}`,
          success: false,
          toolType: 'web_fetch'
        });
      }
    }
  }

  // ── @@GREP ────────────────────────────────────────────────────────────────
  const grepRe = /@@GREP[ \t]+"([^"]+)"[ \t]+([^\n]+)/g;
  while ((m = grepRe.exec(reply)) !== null) {
    const pattern = m[1];
    const searchPath = m[2].trim();
    
    try {
      // Try ripgrep first, fall back to grep
      let output: string;
      try {
        output = execSync(`rg -n "${pattern}" ${searchPath} 2>/dev/null`, {
          encoding: 'utf8',
          timeout: 10000,
          maxBuffer: 1024 * 512
        });
      } catch {
        output = execSync(`grep -rn "${pattern}" ${searchPath} 2>/dev/null || echo "No matches found"`, {
          encoding: 'utf8',
          timeout: 10000,
          maxBuffer: 1024 * 512
        });
      }
      
      const lines = output.split('\n').slice(0, 30);
      const truncated = lines.length >= 30 ? '\n...[truncated]' : '';
      
      results.push({
        message: `🔍 grep "${pattern}" in ${searchPath}:\n${lines.join('\n')}${truncated}`,
        success: true,
        toolType: 'grep'
      });
    } catch (err) {
      results.push({
        message: `Grep failed: ${(err as Error).message}`,
        success: false,
        toolType: 'grep'
      });
    }
  }

  // ── @@GLOB ────────────────────────────────────────────────────────────────
  const globRe = /@@GLOB[ \t]+([^\n]+)/g;
  while ((m = globRe.exec(reply)) !== null) {
    const pattern = m[1].trim();
    
    try {
      const fg = await import('fast-glob');
      const files = await fg.default(pattern, {
        ignore: ['**/node_modules/**', '**/.git/**'],
        onlyFiles: true,
        absolute: false
      });
      
      const limited = files.slice(0, 50);
      const truncated = files.length > 50 ? `\n...[${files.length - 50} more files]` : '';
      
      results.push({
        message: `📁 glob "${pattern}":\n${limited.join('\n')}${truncated}`,
        success: true,
        toolType: 'glob'
      });
    } catch (err) {
      results.push({
        message: `Glob failed: ${(err as Error).message}`,
        success: false,
        toolType: 'glob'
      });
    }
  }

  // ── @@LIST ────────────────────────────────────────────────────────────────
  const listRe = /@@LIST[ \t]+([^\n]+)/g;
  while ((m = listRe.exec(reply)) !== null) {
    const dirPath = m[1].trim();
    
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const formatted = entries.map(e => {
        const type = e.isDirectory() ? '📁' : '📄';
        let size = '';
        if (e.isFile()) {
          const stats = fs.statSync(path.join(dirPath, e.name));
          size = ` (${(stats.size / 1024).toFixed(1)}KB)`;
        }
        return `${type} ${e.name}${size}`;
      }).join('\n');
      
      results.push({
        message: `📂 ${dirPath}:\n${formatted}`,
        success: true,
        toolType: 'list'
      });
    } catch (err) {
      results.push({
        message: `List failed: ${(err as Error).message}`,
        success: false,
        toolType: 'list'
      });
    }
  }

  // ── @@EDIT ────────────────────────────────────────────────────────────────
  const editRe = /@@EDIT[ \t]+"([^"]+)"[ \t]*→[ \t]*"([^"]+)"[ \t]+([^\n]+)/g;
  while ((m = editRe.exec(reply)) !== null) {
    const oldText = m[1];
    const newText = m[2];
    const filePath = m[3].trim();
    
    try {
      // Read current content (from sandbox or filesystem)
      let content = '';
      const pendingPaths = sandbox.getPendingPaths();
      if (pendingPaths.includes(filePath)) {
        const branch = sandbox.state?.branches?.[sandbox.getActiveBranch()];
        content = branch?.[filePath]?.modified || '';
      } else if (fs.existsSync(filePath)) {
        content = fs.readFileSync(filePath, 'utf8');
      } else {
        throw new Error(`File not found: ${filePath}`);
      }
      
      // Count occurrences
      const occurrences = (content.match(new RegExp(oldText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
      
      if (occurrences === 0) {
        results.push({
          message: `No matches found for "${oldText}" in ${filePath}`,
          success: false,
          toolType: 'edit'
        });
      } else {
        // Replace and stage
        const newContent = content.replace(new RegExp(oldText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), newText);
        await sandbox.addChange(filePath, newContent);
        
        results.push({
          message: `Replaced ${occurrences} occurrence(s) of "${oldText}" → "${newText}" in ${filePath}`,
          success: true,
          toolType: 'edit'
        });
      }
    } catch (err) {
      results.push({
        message: `Edit failed: ${(err as Error).message}`,
        success: false,
        toolType: 'edit'
      });
    }
  }

  // ── @@GIT ─────────────────────────────────────────────────────────────────
  const gitRe = /@@GIT[ \t]+([^\n]+)/g;
  while ((m = gitRe.exec(reply)) !== null) {
    const gitCmd = m[1].trim();
    
    // Only allow safe git commands
    const allowedCommands = ['status', 'diff', 'log', 'show', 'branch', 'add', 'commit', 'reset'];
    const mainCmd = gitCmd.split(/\s+/)[0];
    
    if (!allowedCommands.includes(mainCmd)) {
      results.push({
        message: `Git command "${mainCmd}" not allowed. Allowed: ${allowedCommands.join(', ')}`,
        success: false,
        toolType: 'git'
      });
      continue;
    }
    
    try {
      const output = execSync(`git ${gitCmd}`, {
        encoding: 'utf8',
        cwd: process.cwd(),
        timeout: 10000,
        maxBuffer: 1024 * 1024
      });
      
      results.push({
        message: `$ git ${gitCmd}\n${output.slice(0, 3000)}${output.length > 3000 ? '\n...[truncated]' : ''}`,
        success: true,
        toolType: 'git'
      });
    } catch (err: any) {
      results.push({
        message: `$ git ${gitCmd}\n${err.message}`,
        success: false,
        toolType: 'git'
      });
    }
  }

  // ── @@LSP ─────────────────────────────────────────────────────────────────
  const lspRe = /@@LSP[ \t]+(goto|refs|hover|symbols)[ \t]+([^\n]+)/g;
  while ((m = lspRe.exec(reply)) !== null) {
    const command = m[1].trim();
    const args = m[2].trim();
    
    try {
      if (command === 'goto') {
        // Parse: "file.ts:line:col" or just "symbolName"
        const match = args.match(/^(.+):(\d+):(\d+)$/);
        
        if (match) {
          const [, filePath, line, col] = match;
          
          // Fallback: use grep to find definition
          const symbolMatch = fs.readFileSync(filePath, 'utf8')
            .split('\n')[parseInt(line) - 1]
            ?.match(/\b(\w+)\b/);
          
          if (symbolMatch) {
            const symbol = symbolMatch[1];
            const grepResult = execSync(
              `rg -n "^(class|interface|function|const|let|var|type|enum)\\s+${symbol}\\b" . 2>/dev/null || grep -rn "^(class|interface|function|const|let|var)\\s*${symbol}\\b" . 2>/dev/null || echo "Symbol not found"`,
              { encoding: 'utf8', timeout: 5000, maxBuffer: 512 * 1024 }
            ).split('\n').slice(0, 5).join('\n');
            
            results.push({
              message: `LSP goto-definition for "${symbol}" at ${filePath}:${line}:${col}:\n${grepResult}`,
              success: true,
              toolType: 'lsp'
            });
          } else {
            results.push({
              message: `Cannot extract symbol from ${filePath}:${line}:${col}`,
              success: false,
              toolType: 'lsp'
            });
          }
        } else {
          // args is a symbol name
          const symbol = args;
          const grepResult = execSync(
            `rg -n "^(class|interface|function|const|let|var|type|enum)\\s+${symbol}\\b" . 2>/dev/null || grep -rn "^(class|interface|function|const|let|var)\\s*${symbol}\\b" . 2>/dev/null || echo "Symbol not found"`,
            { encoding: 'utf8', timeout: 5000, maxBuffer: 512 * 1024 }
          ).split('\n').slice(0, 5).join('\n');
          
          results.push({
            message: `LSP goto-definition for "${symbol}":\n${grepResult}`,
            success: true,
            toolType: 'lsp'
          });
        }
      } else if (command === 'refs') {
        // Find references using grep
        const symbol = args;
        const grepResult = execSync(
          `rg -n "\\b${symbol}\\b" . 2>/dev/null || grep -rn "\\b${symbol}\\b" . 2>/dev/null || echo "No references found"`,
          { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 512 }
        ).split('\n').slice(0, 20).join('\n');
        
        results.push({
          message: `LSP find-references for "${symbol}":\n${grepResult}${grepResult.split('\n').length >= 20 ? '\n...[truncated]' : ''}`,
          success: true,
          toolType: 'lsp'
        });
      } else if (command === 'symbols') {
        // List symbols in file
        const filePath = args;
        const content = fs.readFileSync(filePath, 'utf8');
        const symbols = content.match(/^(export\s+)?(class|interface|function|const|let|var|type|enum)\s+(\w+)/gm) || [];
        
        results.push({
          message: `LSP symbols in ${filePath}:\n${symbols.slice(0, 30).join('\n')}`,
          success: true,
          toolType: 'lsp'
        });
      } else {
        results.push({
          message: `LSP command "${command}" not yet implemented`,
          success: false,
          toolType: 'lsp'
        });
      }
    } catch (err) {
      results.push({
        message: `LSP ${command} failed: ${(err as Error).message}`,
        success: false,
        toolType: 'lsp'
      });
    }
  }

  return results;
}

/**
 * Build tool instructions for system prompts
 */
export function buildSandboxToolInstructions(projectDir: string): string {
  return `
## Available Tools

Output these commands directly in your response. Files are staged for review.

### File Operations

@@WRITE_FILE path/to/file.ext
file contents here
@@END_FILE

@@APPEND_FILE path/to/file.ext
content to append
@@END_FILE

@@READ_FILE path/to/file.ext

@@MKDIR path/to/directory

@@EDIT "old text" → "new text" path/to/file.ext
(Replace text in existing file - cheaper than rewriting)

### Discovery Tools

@@GREP "pattern" path/
(Search file contents - finds where code is used)

@@GLOB **/*.test.js
(Find files matching pattern)

@@LIST path/to/directory
(List directory contents with sizes)

### Code Intelligence

@@LSP goto file.ts:12:5
(Jump to definition at line:col)

@@LSP refs symbolName
(Find all references to symbol)

@@LSP symbols file.ts
(List all symbols/exports in file)

### Git Operations

@@GIT status
@@GIT diff
@@GIT add file.js
@@GIT commit -m "message"
@@GIT log --oneline -5

### Shell Commands (limited)

@@RUN_CMD npm test
@@RUN_CMD npm install package

### Web Research (if enabled)

@@WEB_SEARCH your query here
@@WEB_FETCH https://example.com

## Critical Rules

- Files are STAGED for review (not written immediately)
- User runs 'crew preview' to review changes
- User runs 'crew apply' to write to disk
- Use @@EDIT for small changes (cheaper than @@WRITE_FILE)
- Use @@GREP to find before editing
- Use @@GLOB to discover files
- Use @@LIST to see directory structure
- Use absolute or relative paths from: ${projectDir}
- Chain multiple tools in one response
- @@END_FILE must be on its own line
`;
}
