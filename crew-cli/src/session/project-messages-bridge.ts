/**
 * CLI Project Message Bridge
 * 
 * Saves CLI chat/exec messages to unified project message store
 * Call this from crew-cli when commands run in project context
 */

import { saveProjectMessage, loadProjectMessages } from '../../../lib/chat/project-messages.mjs';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Save CLI command and result to project messages
 * @param {string} projectDir - Project directory path
 * @param {string} input - User command/input
 * @param {string} output - CLI output/result
 * @param {string} route - Routing info (e.g., 'opencode', 'cursor', 'direct')
 * @param {string} agent - Agent used (if any)
 */
export function saveCliToProjectMessages(projectDir, { input, output, route, agent }) {
  if (!projectDir || !input) return;
  
  // Try to determine project ID from projectDir
  const projectId = extractProjectIdFromDir(projectDir);
  if (!projectId) return;
  
  // Save user input
  saveProjectMessage(projectId, {
    source: 'cli',
    role: 'user',
    content: input,
    metadata: { projectDir, route }
  });
  
  // Save assistant output if present
  if (output) {
    saveProjectMessage(projectId, {
      source: 'cli',
      role: 'assistant',
      content: output,
      agent: agent || 'cli',
      metadata: { projectDir, route }
    });
  }
}

/**
 * Extract project ID from directory path.
 * Checks the dashboard projects registry first, falls back to directory name.
 */
function extractProjectIdFromDir(projectDir) {
  // Try to look up project ID from dashboard projects registry
  try {
    const registryPath = join(
      process.env.HOME || process.env.USERPROFILE || '',
      '.crewswarm',
      'projects.json'
    );
    if (existsSync(registryPath)) {
      const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
      const projects = Array.isArray(registry) ? registry : (registry.projects || []);
      const match = projects.find(p =>
        p.path === projectDir ||
        p.directory === projectDir ||
        p.dir === projectDir
      );
      if (match && (match.id || match.projectId)) {
        return match.id || match.projectId;
      }
    }
  } catch {
    // Registry lookup failed — fall back to directory name
  }

  // Fallback: use directory basename as projectId
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
  const projectId = extractProjectIdFromDir(projectDir);
  if (!projectId) return [];
  
  return loadProjectMessages(projectId, {
    ...options,
    source: 'cli'
  });
}
