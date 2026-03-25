/**
 * CLI Project Message Bridge
 * 
 * Saves CLI chat/exec messages to unified project message store
 * Call this from crew-cli when commands run in project context
 */

import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { readFileSync, existsSync } from 'fs';

// Lazy import - resolve at runtime, not build time
let saveProjectMessage, loadProjectMessages;

async function ensureImports() {
  if (saveProjectMessage) return;
  
  // Find CrewSwarm root by looking for package.json with "name": "crewswarm"
  let currentDir = process.cwd();
  let crewswarmRoot = null;
  
  for (let i = 0; i < 10; i++) {
    const pkgPath = join(currentDir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        if (pkg.name === 'crewswarm' || existsSync(join(currentDir, 'lib/chat/project-messages.mjs'))) {
          crewswarmRoot = currentDir;
          break;
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
  
  if (!crewswarmRoot) {
    throw new Error('[CLI Bridge] Cannot find CrewSwarm root from: ' + process.cwd());
  }
  
  const modulePath = join(crewswarmRoot, 'lib/chat/project-messages.mjs');
  console.log('[CLI Bridge] Loading from:', modulePath);
  const imported = await import(`file://${modulePath}`);
  saveProjectMessage = imported.saveProjectMessage;
  loadProjectMessages = imported.loadProjectMessages;
}

/**
 * Save CLI command and result to project messages
 * @param {string} projectDir - Project directory path
 * @param {object} entry - CLI entry
 * @param {string} entry.input - User command/input (for CHAT)
 * @param {string} entry.task - User command/input (for DISPATCH)
 * @param {string} [entry.output] - CLI output/result
 * @param {string} [entry.response] - CLI response (alternative field)
 * @param {string} [entry.result] - CLI result (alternative field)
 * @param {string} [entry.route] - Routing info (e.g., 'opencode', 'cursor', 'direct')
 * @param {string} [entry.agent] - Agent used (if any)
 * @param {string} [entry.type] - Entry type (repl_chat, repl_request, repl_result, etc.)
 */
export async function saveCliToProjectMessages(projectDir, entry) {
  if (!projectDir || !entry) return;
  
  // Ensure imports are loaded
  await ensureImports();
  
  // Normalize input field from various CLI entry types
  const userInput = entry.input || entry.task;
  const assistantOutput = entry.output || entry.response || entry.result;
  
  if (!userInput && !assistantOutput) {
    console.log('[CLI Bridge] Skipping - no content to save');
    return;
  }
  
  // Try to determine project ID from projectDir
  const projectId = extractProjectIdFromDir(projectDir);
  if (!projectId) {
    console.log('[CLI Bridge] No projectId extracted from:', projectDir);
    return;
  }
  
  console.log('[CLI Bridge] Saving message to project:', projectId, '(type:', entry.type, ')');
  
  // Save user input if present
  if (userInput && entry.type !== 'repl_result') {
    saveProjectMessage(projectId, {
      source: 'cli',
      role: 'user',
      content: userInput,
      metadata: { 
        projectDir, 
        route: entry.route,
        cliEntryType: entry.type 
      }
    });
  }
  
  // Save assistant output if present
  if (assistantOutput && entry.type !== 'repl_request') {
    saveProjectMessage(projectId, {
      source: 'cli',
      role: 'assistant',
      content: typeof assistantOutput === 'object' ? JSON.stringify(assistantOutput) : String(assistantOutput),
      agent: entry.agent || 'cli',
      metadata: { 
        projectDir, 
        route: entry.route,
        cliEntryType: entry.type,
        success: entry.success
      }
    });
  }
}

/**
 * Extract project ID from directory path
 * Looks for registered projects in dashboard and returns matching ID
 */
function extractProjectIdFromDir(projectDir) {
  // For now, use directory name as projectId
  // Uses directory name as projectId — dashboard projects registry lookup deferred
  const parts = projectDir.split('/');
  const dirName = parts[parts.length - 1] || parts[parts.length - 2];
  return dirName || null;
}

/**
 * Load project CLI history
 * @param {string} projectDir - Project directory path
 * @param {object} options - Filter options
 * @returns {Array} CLI messages for this project
 */
export function loadCliProjectHistory(projectDir, options = {}) {
  if (!loadProjectMessages) {
    console.warn('[CLI Bridge] Not initialized - cannot load history');
    return [];
  }
  
  const projectId = extractProjectIdFromDir(projectDir);
  if (!projectId) return [];
  
  return loadProjectMessages(projectId, {
    ...options,
    source: 'cli'
  });
}
