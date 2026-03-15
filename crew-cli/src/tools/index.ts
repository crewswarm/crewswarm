/**
 * Tool Integration Layer
 * Uses Gemini CLI tools directly with VirtualFS injection
 * 
 * @license
 * Copyright 2026 CrewSwarm
 */

import { Sandbox } from '../sandbox/index.js';
import { createVirtualFS, type VirtualFS } from './virtual-fs.js';

// Import Gemini CLI tools directly
import type { EditToolParams } from '../../external/gemini-cli/packages/core/src/tools/edit.js';
import type { WriteFileToolParams } from '../../external/gemini-cli/packages/core/src/tools/write-file.js';
import type { ShellToolParams } from '../../external/gemini-cli/packages/core/src/tools/shell.js';
import type { ReadFileToolParams } from '../../external/gemini-cli/packages/core/src/tools/read-file.js';

// Tool declarations for function calling
export const CREW_TOOL_DECLARATIONS = [
  {
    name: 'write_file',
    description: 'Write content to a file. Stages in sandbox for preview.',
    parameters: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: 'Path to file' },
        content: { type: 'string', description: 'File content' }
      },
      required: ['file_path', 'content']
    }
  },
  {
    name: 'read_file',
    description: 'Read file contents. Checks sandbox first, then disk.',
    parameters: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: 'Path to file' },
        start_line: { type: 'number', description: 'Start line (optional)' },
        end_line: { type: 'number', description: 'End line (optional)' }
      },
      required: ['file_path']
    }
  },
  {
    name: 'edit_file',
    description: 'Edit file via search/replace. Stages changes in sandbox.',
    parameters: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: 'Path to file' },
        old_string: { type: 'string', description: 'String to find' },
        new_string: { type: 'string', description: 'Replacement string' },
        allow_multiple: { type: 'boolean', description: 'Replace all occurrences' }
      },
      required: ['file_path', 'old_string', 'new_string']
    }
  },
  {
    name: 'shell',
    description: 'Execute shell command. Uses Docker if files are staged.',
    parameters: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'Shell command to run' }
      },
      required: ['command']
    }
  }
];

/**
 * Tool executor that uses VirtualFS for file operations
 */
export class CrewToolExecutor {
  private vfs: VirtualFS;

  constructor(private sandbox: Sandbox) {
    this.vfs = createVirtualFS(sandbox);
  }

  async execute(toolName: string, params: any): Promise<any> {
    switch (toolName) {
      case 'write_file':
        return this.writeFile(params);
      
      case 'read_file':
        return this.readFile(params);
      
      case 'edit_file':
        return this.editFile(params);
      
      case 'shell':
        return this.shell(params);
      
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  private async writeFile(params: WriteFileToolParams) {
    const { file_path, content } = params;
    
    // Read original if exists
    let original = '';
    try {
      original = await this.vfs.readFile(file_path);
    } catch {
      // New file
    }

    // Write to VirtualFS (stages in sandbox)
    await this.vfs.writeFile(file_path, content);

    return {
      success: true,
      message: `Staged ${file_path} in sandbox`,
      path: file_path,
      size: content.length,
      isNew: !original
    };
  }

  private async readFile(params: ReadFileToolParams) {
    const { file_path, start_line, end_line } = params;
    
    let content = await this.vfs.readFile(file_path);

    // Apply line range if specified
    if (start_line !== undefined || end_line !== undefined) {
      const lines = content.split('\n');
      const start = (start_line || 1) - 1;
      const end = end_line || lines.length;
      content = lines.slice(start, end).join('\n');
    }

    return {
      success: true,
      content,
      path: file_path,
      lines: content.split('\n').length,
      staged: this.vfs.isStaged(file_path)
    };
  }

  private async editFile(params: EditToolParams) {
    const { file_path, old_string, new_string, allow_multiple } = params;
    
    // Read current content
    const original = await this.vfs.readFile(file_path);

    // Count occurrences
    const occurrences = (original.match(new RegExp(old_string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;

    if (occurrences === 0) {
      throw new Error(`String "${old_string}" not found in ${file_path}`);
    }

    if (occurrences > 1 && !allow_multiple) {
      throw new Error(`Found ${occurrences} occurrences. Set allow_multiple=true to replace all.`);
    }

    // Perform replacement
    const modified = allow_multiple
      ? original.split(old_string).join(new_string)
      : original.replace(old_string, new_string);

    // Write to VirtualFS
    await this.vfs.writeFile(file_path, modified);

    return {
      success: true,
      message: `Replaced ${occurrences} occurrence(s) in ${file_path}`,
      path: file_path,
      occurrences
    };
  }

  private async shell(params: ShellToolParams) {
    const { command } = params;

    // Check if we have staged files → use Docker
    if (this.sandbox.hasChanges()) {
      const { getDockerSandbox } = await import('./docker-sandbox.js');
      const docker = await getDockerSandbox();
      
      if (docker) {
        console.log(`[Crew] Running in Docker (${this.sandbox.getPendingPaths().length} files staged)`);
        return docker.runCommand(command, this.sandbox);
      }
    }

    // Fall back to native execution
    const { execSync } = await import('child_process');
    try {
      const output = execSync(command, {
        encoding: 'utf-8',
        stdio: 'pipe',
        cwd: process.cwd()
      });
      
      return {
        success: true,
        stdout: output,
        exitCode: 0
      };
    } catch (error: any) {
      return {
        success: false,
        stdout: error.stdout || '',
        stderr: error.stderr || '',
        exitCode: error.status || 1
      };
    }
  }
}

/**
 * Get tool declarations for LLM function calling
 */
export function getToolDeclarations() {
  return CREW_TOOL_DECLARATIONS;
}

/**
 * Create tool executor instance
 */
export function createToolExecutor(sandbox: Sandbox) {
  return new CrewToolExecutor(sandbox);
}
