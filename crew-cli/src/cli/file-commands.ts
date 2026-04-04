/**
 * Direct File Command Parser for crew-cli
 * 
 * Adds support for @@WRITE_FILE...@@END_FILE syntax similar to
 * OpenCode/Codex/Gemini CLI protocols.
 * 
 * Usage:
 *   crew chat "@@WRITE_FILE hello.txt
 *   Hello World
 *   @@END_FILE"
 */

export interface FileCommand {
  type: 'write' | 'mkdir' | 'delete';
  path: string;
  content?: string;
}

/**
 * Parse @@WRITE_FILE...@@END_FILE blocks from input
 */
export function parseDirectFileCommands(input: string): FileCommand[] {
  const commands: FileCommand[] = [];
  
  // Match @@WRITE_FILE path\ncontent\n@@END_FILE
  const writeFileRegex = /@@WRITE_FILE\s+([^\n]+)\n([\s\S]*?)@@END_FILE/g;
  
  let match;
  while ((match = writeFileRegex.exec(input)) !== null) {
    const path = match[1].trim();
    const content = match[2] || '';
    
    commands.push({
      type: 'write',
      path,
      content
    });
  }
  
  // Match @@MKDIR path
  const mkdirRegex = /@@MKDIR\s+([^\n]+)/g;
  while ((match = mkdirRegex.exec(input)) !== null) {
    commands.push({
      type: 'mkdir',
      path: match[1].trim()
    });
  }
  
  return commands;
}

/**
 * Parse write: syntax (OpenCode/Codex style)
 * Format: write: path/to/file.txt
 * Content follows on next lines until next command or EOF
 */
export function parseWriteSyntax(input: string): FileCommand[] {
  const commands: FileCommand[] = [];
  const lines = input.split('\n');
  
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    
    if (line.startsWith('write:')) {
      const path = line.substring(6).trim();
      const contentLines: string[] = [];
      
      i++;
      // Collect content until next command or EOF
      while (i < lines.length) {
        const nextLine = lines[i];
        if (nextLine.trim().match(/^(write:|mkdir:|delete:|@@\w+)/)) {
          break;
        }
        contentLines.push(nextLine);
        i++;
      }
      
      commands.push({
        type: 'write',
        path,
        content: contentLines.join('\n')
      });
    } else if (line.startsWith('mkdir:')) {
      commands.push({
        type: 'mkdir',
        path: line.substring(6).trim()
      });
      i++;
    } else {
      i++;
    }
  }
  
  return commands;
}

/**
 * Remove direct command blocks from input (for LLM processing)
 */
export function stripDirectCommands(input: string): string {
  let stripped = input;
  
  // Remove @@WRITE_FILE...@@END_FILE blocks
  stripped = stripped.replace(/@@WRITE_FILE\s+[^\n]+\n[\s\S]*?@@END_FILE/g, '');
  
  // Remove @@MKDIR commands
  stripped = stripped.replace(/@@MKDIR\s+[^\n]+/g, '');
  
  // Remove write:/mkdir: blocks
  stripped = stripped.replace(/^(write|mkdir):\s+[^\n]+(\n(?!write:|mkdir:|@@)[^\n]*)*$/gm, '');
  
  return stripped.trim();
}

/**
 * Check if input contains any direct commands
 */
export function hasDirectCommands(input: string): boolean {
  return /@@WRITE_FILE|@@MKDIR|^write:|^mkdir:/m.test(input);
}

/**
 * Execute direct commands using sandbox
 */
export async function executeDirectCommands(
  commands: FileCommand[],
  sandbox: { addChange(path: string, content: string): Promise<void> },
  logger?: { info(msg: string): void; error?(msg: string): void }
): Promise<string[]> {
  const appliedFiles: string[] = [];
  
  for (const cmd of commands) {
    try {
      if (cmd.type === 'write') {
        await sandbox.addChange(cmd.path, cmd.content || '');
        appliedFiles.push(cmd.path);
        logger?.info(`Staged: ${cmd.path}`);
      } else if (cmd.type === 'mkdir') {
        // For mkdir, we can create an empty .gitkeep file
        const keepPath = `${cmd.path}/.gitkeep`;
        await sandbox.addChange(keepPath, '');
        appliedFiles.push(keepPath);
        logger?.info(`Created directory: ${cmd.path}`);
      }
    } catch (err) {
      logger?.error(`Failed to stage ${cmd.path}: ${(err as Error).message}`);
    }
  }
  
  return appliedFiles;
}

/**
 * Example usage in crew chat command:
 * 
 * ```typescript
 * const directCommands = [
 *   ...parseDirectFileCommands(input),
 *   ...parseWriteSyntax(input)
 * ];
 * 
 * if (directCommands.length > 0) {
 *   const appliedFiles = await executeDirectCommands(
 *     directCommands,
 *     sandbox,
 *     logger
 *   );
 *   
 *   // Strip direct commands from input before LLM call
 *   const llmInput = stripDirectCommands(input);
 *   
 *   if (llmInput) {
 *     // Continue with LLM for remaining natural language
 *   } else {
 *     // Pure direct commands, no LLM needed
 *     return { appliedFiles, response: `Staged ${appliedFiles.length} files` };
 *   }
 * }
 * ```
 */
