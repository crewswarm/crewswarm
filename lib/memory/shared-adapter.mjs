/**
 * Shared Memory Adapter — bridges CLI's AgentKeeper/AgentMemory with main crewswarm
 * 
 * This adapter allows all agents (CLI, Gateway, Cursor, OpenCode, etc.) to share
 * the same persistent memory store. Uses CLI's MemoryBroker underneath for unified
 * retrieval across AgentKeeper (task memory) + AgentMemory (fact memory) + Collections (RAG).
 * 
 * Storage: CREW_MEMORY_DIR env var or ~/.crewswarm/shared-memory/
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { rankMemories, maxAccessCount } from './relevance-scorer.mjs';

const require = createRequire(import.meta.url);

// Resolve CLI memory export bundle
const CLI_MEMORY_PATH = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../crew-cli/dist/memory.mjs');
let AgentKeeper, AgentMemory, MemoryBroker, Collections;

try {
  const memoryModule = await import(CLI_MEMORY_PATH);
  AgentKeeper = memoryModule.AgentKeeper;
  AgentMemory = memoryModule.AgentMemory;
  MemoryBroker = memoryModule.MemoryBroker;
  Collections = memoryModule.Collections;
} catch (err) {
  console.warn('[shared-adapter] CLI memory bundle not found — shared memory disabled. Run: cd crew-cli && npm run build');
  AgentKeeper = null;
  AgentMemory = null;
  MemoryBroker = null;
  Collections = null;
}

// Shared memory root (env var or default)
export const CREW_MEMORY_DIR = process.env.CREW_MEMORY_DIR || path.join(os.homedir(), '.crewswarm', 'shared-memory');

// Cache project-messages-rag module to avoid dynamic import() on every call
let _projectMessagesRag = null;
async function getProjectMessagesRag() {
  if (_projectMessagesRag === null) {
    try {
      _projectMessagesRag = await import('../chat/project-messages-rag.mjs');
    } catch {
      _projectMessagesRag = false; // mark as unavailable
    }
  }
  return _projectMessagesRag || null;
}

/**
 * Get or create AgentKeeper instance for task memory.
 * @param {string} projectDir - Project root directory
 * @returns {AgentKeeper|null}
 */
export function getAgentKeeper(projectDir) {
  if (!AgentKeeper) return null;
  return new AgentKeeper(projectDir || process.cwd(), {
    storageDir: CREW_MEMORY_DIR
  });
}

/**
 * Get or create AgentMemory instance for fact memory.
 * @param {string} agentId - Agent identifier
 * @returns {AgentMemory|null}
 */
export function getAgentMemory(agentId = 'crew-lead') {
  if (!AgentMemory) return null;
  return new AgentMemory(agentId, {
    storageDir: CREW_MEMORY_DIR
  });
}

/**
 * Get MemoryBroker instance for unified retrieval.
 * @param {string} projectDir - Project root directory
 * @param {object} options - Additional options
 * @returns {MemoryBroker|null}
 */
export function getMemoryBroker(projectDir, options = {}) {
  if (!MemoryBroker) return null;
  return new MemoryBroker(projectDir || process.cwd(), {
    storageDir: CREW_MEMORY_DIR,
    crewId: options.crewId || 'crew-lead'
  });
}

/**
 * Record task result to AgentKeeper (shared task memory).
 * @param {string} projectDir - Project directory
 * @param {object} entry - Memory entry (tier, task, result, agent, model, etc.)
 * @returns {Promise<{ok: boolean, entry?: object, error?: string}>}
 */
export async function recordTaskMemory(projectDir, entry) {
  const keeper = getAgentKeeper(projectDir);
  if (!keeper) return { ok: false, error: 'AgentKeeper not available' };
  
  return await keeper.recordSafe({
    runId: entry.runId || 'unknown',
    tier: entry.tier || 'worker',
    task: entry.task || '',
    result: entry.result || '',
    structured: entry.structured,
    agent: entry.agent,
    model: entry.model,
    metadata: entry.metadata || {}
  });
}

/**
 * Remember a fact in AgentMemory (shared cognitive memory).
 * @param {string} agentId - Agent identifier
 * @param {string} content - Fact content
 * @param {object} options - { critical?, tags?, provider? }
 * @returns {string|null} - Fact ID or null if disabled
 */
export function rememberFact(agentId, content, options = {}) {
  const memory = getAgentMemory(agentId);
  if (!memory) return null;
  return memory.remember(content, options);
}

/**
 * Recall memory context for a task using MemoryBroker (blends AgentKeeper + AgentMemory + Collections).
 * ENHANCED: Applies relevance scoring (recency + frequency + keyword + context) and tracks access metadata.
 * ENHANCED: Also includes relevant conversation history from project messages.
 * @param {string} projectDir - Project directory
 * @param {string} query - Task description or search query
 * @param {object} options - { maxResults?, includeDocs?, includeCode?, pathHints?, preferSuccessful?, userId?, projectId?, agentId?, sessionId? }
 * @returns {Promise<string>} - Formatted context block
 */
export async function recallMemoryContext(projectDir, query, options = {}) {
  const broker = getMemoryBroker(projectDir, { crewId: options.crewId || 'crew-lead' });

  let memoryContext = '';

  // Get standard memory (AgentKeeper + AgentMemory + Collections)
  // Fetch a larger candidate set so the relevance ranker has room to reorder
  if (broker) {
    const maxResults = options.maxResults || 5;
    const candidateLimit = Math.max(maxResults * 3, 15);

    // Pull raw structured hits when available, fall back to formatted context
    let rawHits = null;
    if (typeof broker.recall === 'function') {
      try {
        rawHits = await broker.recall(query, {
          maxResults: candidateLimit,
          includeDocs: options.includeDocs !== false,
          includeCode: Boolean(options.includeCode),
          pathHints: options.pathHints || [],
          preferSuccessful: options.preferSuccessful !== false,
          minScore: 0.7,
          excludeFailed: true,
          excludeErrors: true,
          excludeTimeouts: true
        });
      } catch {
        rawHits = null;
      }
    }

    if (rawHits && Array.isArray(rawHits) && rawHits.length > 0) {
      // Build a relevance context for the ranker
      const scoringContext = {
        projectId: options.projectId,
        agentId:   options.agentId,
        sessionId: options.sessionId
      };

      // Normalise hits to the shape scoreMemory expects
      const now = Date.now();
      const normalised = rawHits.map(hit => ({
        ...hit,
        content:     hit.text || hit.content || '',
        timestamp:   hit.metadata?.timestamp || hit.timestamp || new Date(now - 86400000).toISOString(),
        accessCount: (hit.accessCount || 0) + 1,  // count this retrieval
        lastAccessed: new Date(now).toISOString(),
        projectId:   hit.metadata?.projectId || hit.projectId,
        agentId:     hit.metadata?.agentId   || hit.agentId,
        sessionId:   hit.metadata?.sessionId || hit.sessionId
      }));

      const scoringOpts = { nowMs: now, maxAccessCount: maxAccessCount(normalised) };
      const ranked = rankMemories(normalised, query, scoringContext, maxResults, scoringOpts);

      // Re-serialise to context string (mirrors broker.recallAsContext format)
      if (ranked.length > 0) {
        const lines = ranked.map((hit, i) => {
          const score = hit.relevanceScore.toFixed(3);
          const source = hit.source || hit.metadata?.source || 'memory';
          const title  = hit.title  || hit.metadata?.title  || `Result ${i + 1}`;
          return `[${source}] ${title} (relevance: ${score})\n${hit.content}`;
        });
        memoryContext = lines.join('\n\n---\n\n');
      }
    } else {
      // Fallback: broker doesn't expose raw hits — use formatted context as-is
      try {
        memoryContext = await broker.recallAsContext(query, {
          maxResults: options.maxResults || 5,
          includeDocs: options.includeDocs !== false,
          includeCode: Boolean(options.includeCode),
          pathHints: options.pathHints || [],
          preferSuccessful: options.preferSuccessful !== false,
          // Quality filters to prevent context contamination
          minScore: 0.7,
          excludeFailed: true,
          excludeErrors: true,
          excludeTimeouts: true
        });
      } catch {
        memoryContext = '';
      }
    }
  }

  // ENHANCEMENT: Add relevant conversation history from project messages
  // This lets agents see past discussions about the same topic
  if (options.projectId) {
    try {
      const ragModule = await getProjectMessagesRag();
      const conversationContext = ragModule?.getConversationContext(options.projectId, query, 3);

      if (conversationContext) {
        memoryContext += (memoryContext ? '\n\n' : '') + conversationContext;
      }
    } catch (e) {
      // Silent fail — conversation context is bonus
      console.warn('[shared-adapter] Failed to load conversation context:', e.message);
    }
  }

  return memoryContext;
}

/**
 * Search memory (returns structured hits instead of formatted context).
 * @param {string} projectDir - Project directory
 * @param {string} query - Search query
 * @param {object} options - Same as recallMemoryContext
 * @returns {Promise<Array<{source, score, title, text, metadata}>>}
 */
export async function searchMemory(projectDir, query, options = {}) {
  const broker = getMemoryBroker(projectDir, { crewId: options.crewId || 'crew-lead' });
  if (!broker) return [];
  
  return await broker.recall(query, {
    maxResults: options.maxResults || 5,
    includeDocs: options.includeDocs !== false,
    includeCode: Boolean(options.includeCode),
    pathHints: options.pathHints || [],
    preferSuccessful: options.preferSuccessful !== false
  });
}

/**
 * Get memory statistics.
 * @param {string} agentId - Agent identifier
 * @returns {object|null} - { totalFacts, criticalFacts, providers, oldestFact, newestFact }
 */
export function getMemoryStats(agentId = 'crew-lead') {
  const memory = getAgentMemory(agentId);
  if (!memory) return null;
  return memory.stats();
}

/**
 * Get AgentKeeper statistics.
 * @param {string} projectDir - Project directory
 * @returns {Promise<object|null>} - { entries, byTier, byAgent, bytes }
 */
export async function getKeeperStats(projectDir) {
  const keeper = getAgentKeeper(projectDir);
  if (!keeper) return null;
  return await keeper.stats();
}

/**
 * Compact AgentKeeper store (dedupe + prune old entries).
 * @param {string} projectDir - Project directory
 * @returns {Promise<object|null>} - { entriesBefore, entriesAfter, bytesFreed }
 */
export async function compactKeeperStore(projectDir) {
  const keeper = getAgentKeeper(projectDir);
  if (!keeper) return null;
  return await keeper.compact();
}

/**
 * Check if shared memory is available.
 * @returns {boolean}
 */
export function isSharedMemoryAvailable() {
  return Boolean(AgentKeeper && AgentMemory && MemoryBroker);
}

/**
 * Initialize shared memory directory structure.
 * @returns {{ ok: boolean, path: string, error?: string }}
 */
export function initSharedMemory() {
  try {
    fs.mkdirSync(CREW_MEMORY_DIR, { recursive: true });
    fs.mkdirSync(path.join(CREW_MEMORY_DIR, '.crew'), { recursive: true });
    fs.mkdirSync(path.join(CREW_MEMORY_DIR, '.crew', 'agent-memory'), { recursive: true });
    
    return { ok: true, path: CREW_MEMORY_DIR };
  } catch (err) {
    return { ok: false, path: CREW_MEMORY_DIR, error: err.message };
  }
}

/**
 * Migrate brain.md entries to AgentMemory.
 * Reads brain.md from memory/ dir and converts each line to a memory fact.
 * @param {string} brainPath - Path to brain.md
 * @param {string} agentId - Agent to store facts under
 * @returns {{ ok: boolean, imported: number, skipped: number, errors: number }}
 */
export async function migrateBrainToMemory(brainPath, agentId = 'crew-lead') {
  const memory = getAgentMemory(agentId);
  if (!memory) return { ok: false, imported: 0, skipped: 0, errors: 1, error: 'AgentMemory not available' };
  
  try {
    const content = fs.readFileSync(brainPath, 'utf8');
    const lines = content.split('\n');
    let imported = 0;
    let skipped = 0;
    let errors = 0;
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      // Skip empty lines, headers, and meta markers
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[') || trimmed.length < 10) {
        skipped++;
        continue;
      }
      
      // Extract tags from markdown list items
      const tags = [];
      let factContent = trimmed;
      
      // Extract date tags (YYYY-MM-DD)
      const dateMatch = factContent.match(/\b(\d{4}-\d{2}-\d{2})\b/);
      if (dateMatch) tags.push('dated', dateMatch[1]);

      // Extract agent mentions
      const agentMatch = factContent.match(/\b(crew-\w+)\b/);
      if (agentMatch) tags.push('agent', agentMatch[1]);

      // Determine criticality (heuristic: lines with CRITICAL, ERROR, WARNING, or !)
      const critical = /\b(CRITICAL|ERROR|WARNING|!)\b/i.test(factContent) || factContent.includes('MUST') || factContent.includes('NEVER');

      try {
        memory.remember(factContent, {
          critical,
          tags: tags.length > 0 ? tags : ['brain-migration'],
          provider: 'brain-migration'
        });
        imported++;
      } catch (err) {
        errors++;
      }
    }
    
    return { ok: true, imported, skipped, errors };
  } catch (err) {
    return { ok: false, imported: 0, skipped: 0, errors: 1, error: err.message };
  }
}
