/**
 * Per-Session Scratchpad Directory
 *
 * Each agent session gets an isolated temp directory for working files.
 * This avoids polluting the project directory or colliding with other agents
 * running in parallel on the same machine.
 *
 * Usage:
 *   const dir = createScratchpad(sessionId);
 *   // ... pass dir to LLM via getScratchpadInstructions() ...
 *   cleanupScratchpad(sessionId);
 */

import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Create (or ensure existence of) the scratchpad directory for a session.
 * Returns the absolute path to the directory.
 */
export function createScratchpad(sessionId: string): string {
  const dir = join(tmpdir(), `crew-cli-scratch-${sessionId}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Delete the scratchpad directory and all its contents.
 * Safe to call even if the directory no longer exists.
 */
export function cleanupScratchpad(sessionId: string): void {
  const dir = join(tmpdir(), `crew-cli-scratch-${sessionId}`);
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Build the system-prompt snippet that tells the LLM about its scratchpad.
 */
export function getScratchpadInstructions(scratchDir: string): string {
  return (
    '\n\nYou have a dedicated scratchpad directory for temporary files:\n' +
    `  ${scratchDir}\n` +
    'Use this instead of /tmp for drafts, intermediate files, or working copies.' +
    ' It will be cleaned up when the session ends.'
  );
}
