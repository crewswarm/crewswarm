/**
 * Top of Mind — persistent instructions injected into every LLM turn.
 *
 * Users create .crew/instructions.md (project-level) or
 * ~/.crewswarm/instructions.md (global) with persistent context
 * that should always be available to the agent:
 *   - Code style preferences
 *   - Project conventions
 *   - "Always use TypeScript strict mode"
 *   - "Never modify package-lock.json"
 *   - Team-specific patterns
 *
 * Instructions are injected into the system prompt before every
 * LLM call, after the base system prompt but before task context.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

let _cachedInstructions: string | null = null;
let _cachedProjectDir: string | null = null;

/**
 * Load top-of-mind instructions from project and global config.
 * Cached per project directory for the duration of the process.
 */
export async function loadTopOfMind(projectDir: string = process.cwd()): Promise<string> {
  if (_cachedInstructions !== null && _cachedProjectDir === projectDir) {
    return _cachedInstructions;
  }

  const sections: string[] = [];

  // Global instructions (~/.crewswarm/instructions.md)
  const globalPath = join(homedir(), '.crewswarm', 'instructions.md');
  if (existsSync(globalPath)) {
    try {
      const content = await readFile(globalPath, 'utf8');
      if (content.trim()) {
        sections.push(`## Global Instructions\n${content.trim()}`);
      }
    } catch {}
  }

  // Project instructions (.crew/instructions.md)
  const projectPath = join(projectDir, '.crew', 'instructions.md');
  if (existsSync(projectPath)) {
    try {
      const content = await readFile(projectPath, 'utf8');
      if (content.trim()) {
        sections.push(`## Project Instructions\n${content.trim()}`);
      }
    } catch {}
  }

  // Also check CLAUDE.md style files
  const claudeMdPath = join(projectDir, 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    try {
      const content = await readFile(claudeMdPath, 'utf8');
      if (content.trim()) {
        sections.push(`## Project Guidelines (CLAUDE.md)\n${content.trim()}`);
      }
    } catch {}
  }

  _cachedInstructions = sections.length > 0
    ? `\n\n## Top of Mind — Always Follow These Instructions\n${sections.join('\n\n')}\n`
    : '';
  _cachedProjectDir = projectDir;

  return _cachedInstructions;
}

/**
 * Clear the cache (for testing or when switching projects).
 */
export function clearTopOfMindCache(): void {
  _cachedInstructions = null;
  _cachedProjectDir = null;
}
