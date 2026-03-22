/**
 * Unified Project Messages — Central store for all project chat activity
 * 
 * Captures messages from all sources:
 * - crew-lead dashboard chat (with projectId)
 * - CLI chat sessions (crew chat, crew exec)
 * - Sub-agent completions (crew-coder, crew-qa, etc.)
 * - Direct agent chat (via /api/chat-agent)
 * 
 * Storage: ~/.crewswarm/project-messages/{projectId}/messages.jsonl
 * Format: { id, ts, source, role, content, agent, metadata }
 */

import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import { getStatePath } from "../runtime/paths.mjs";

const MAX_MESSAGES = 10000; // High limit since project chats can span months

function getProjectMessagesDir(projectId) {
  if (!projectId) throw new Error("projectId is required");
  const sanitized = String(projectId).replace(/[^a-z0-9_.-]/gi, "_").slice(0, 80);
  const dir = path.join(getStatePath("project-messages"), sanitized);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getMessagesFile(projectId) {
  return path.join(getProjectMessagesDir(projectId), "messages.jsonl");
}

/**
 * Save a message to project history
 * @param {string} projectId - Project identifier
 * @param {object} message - Message object
 * @param {string} message.source - Message source (dashboard, cli, agent, sub-agent)
 * @param {string} message.role - user or assistant
 * @param {string} message.content - Message content
 * @param {string} [message.agent] - Agent ID if from an agent
 * @param {string} [message.threadId] - Thread ID for linking related messages
 * @param {string} [message.parentId] - Parent message ID (for threading)
 * @param {object} [message.metadata] - Additional metadata
 * @returns {string} The message ID
 */
export function saveProjectMessage(projectId, message) {
  if (!projectId) {
    console.warn('[project-messages] No projectId provided, skipping save');
    return null;
  }
  
  if (!message.content || !message.role || !message.source) {
    console.warn('[project-messages] Invalid message, skipping save:', message);
    return null;
  }
  
  const entry = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    source: message.source,
    role: message.role,
    content: message.content,
    agent: message.agent || null,
    threadId: message.threadId || null,
    parentId: message.parentId || null,
    metadata: message.metadata || {}
  };
  
  const file = getMessagesFile(projectId);
  fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  
  // Auto-index into Collections/RAG (async, non-blocking)
  try {
    import('./project-messages-rag.mjs').then(rag => {
      rag.autoIndexMessage(projectId, entry);
    }).catch(() => {
      // Silent fail — RAG indexing is bonus
    });
  } catch (e) {
    // Silent fail
  }
  
  return entry.id; // Return ID for threading
}

/**
 * Load project messages
 * @param {string} projectId - Project identifier
 * @param {object} options - Filter options
 * @param {number} [options.limit] - Max messages to return (from end)
 * @param {string} [options.source] - Filter by source
 * @param {string} [options.agent] - Filter by agent
 * @param {number} [options.since] - Unix timestamp (ms) - only messages after this
 * @returns {Array} Messages sorted by timestamp (oldest first)
 */
export function loadProjectMessages(projectId, options = {}) {
  if (!projectId) return [];
  
  const file = getMessagesFile(projectId);
  if (!fs.existsSync(file)) return [];
  
  const messages = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      
      // Apply filters
      if (options.source && msg.source !== options.source) continue;
      if (options.agent && msg.agent !== options.agent) continue;
      if (options.since && msg.ts < options.since) continue;
      if (options.threadId && msg.threadId !== options.threadId) continue;
      if (options.parentId && msg.parentId !== options.parentId) continue;
      if (options.excludeDirect && msg.metadata?.directChat) continue;
      if (
        options.mentionedAgent &&
        !Array.isArray(msg.metadata?.mentions)
      ) {
        continue;
      }
      if (
        options.mentionedAgent &&
        !msg.metadata.mentions.includes(options.mentionedAgent)
      ) {
        continue;
      }
      
      messages.push(msg);
    } catch (e) {
      // Corrupt line, skip
    }
  }
  
  // Sort by timestamp (oldest first)
  messages.sort((a, b) => a.ts - b.ts);
  
  // Apply limit from end
  if (options.limit && messages.length > options.limit) {
    return messages.slice(-options.limit);
  }
  
  return messages.slice(-MAX_MESSAGES);
}

/**
 * Format project messages for LLM context
 * @param {string} projectId - Project identifier
 * @param {object} options - Format options
 * @param {number} [options.limit=50] - Max messages to include
 * @param {boolean} [options.includeSource=false] - Include source indicator in content
 * @param {boolean} [options.includeAgent=true] - Include agent name for sub-agent messages
 * @returns {Array} Formatted messages [{role, content}]
 */
export function formatProjectMessages(projectId, options = {}) {
  const {
    limit = 50,
    includeSource = false,
    includeAgent = true
  } = options;
  
  const messages = loadProjectMessages(projectId, { limit });
  
  const sourceEmoji = {
    dashboard: '💻',
    cli: '⚡',
    agent: '🤖',
    'sub-agent': '👷'
  };
  
  return messages.map(msg => {
    let content = msg.content;
    
    // Prepend source indicator if requested
    if (includeSource) {
      const emoji = sourceEmoji[msg.source] || '📝';
      content = `${emoji} ${content}`;
    }
    
    // Prepend agent name for sub-agent messages
    if (includeAgent && msg.agent && msg.source === 'sub-agent') {
      content = `[${msg.agent}] ${content}`;
    }
    
    return {
      role: msg.role,
      content
    };
  });
}

/**
 * Get project message statistics
 * @param {string} projectId - Project identifier
 * @returns {object} Stats about the project's messages
 */
export function getProjectMessageStats(projectId) {
  const messages = loadProjectMessages(projectId);
  
  const stats = {
    total: messages.length,
    bySo: {},
    byAgent: {},
    oldestMessage: null,
    newestMessage: null,
    userMessages: 0,
    assistantMessages: 0
  };
  
  stats.bySource = {};
  
  for (const msg of messages) {
    // Count by source
    stats.bySource[msg.source] = (stats.bySource[msg.source] || 0) + 1;
    
    // Count by agent
    if (msg.agent) {
      stats.byAgent[msg.agent] = (stats.byAgent[msg.agent] || 0) + 1;
    }
    
    // Count by role
    if (msg.role === 'user') stats.userMessages++;
    if (msg.role === 'assistant') stats.assistantMessages++;
  }
  
  // Get oldest and newest timestamps
  if (messages.length > 0) {
    stats.oldestMessage = new Date(messages[0].ts);
    stats.newestMessage = new Date(messages[messages.length - 1].ts);
  }
  
  return stats;
}

/**
 * Delete all messages for a project
 * @param {string} projectId - Project identifier
 */
export function clearProjectMessages(projectId) {
  if (!projectId) return;
  
  const file = getMessagesFile(projectId);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
}

/**
 * List all projects with messages
 * @returns {Array<{projectId, messageCount, lastActivity}>}
 */
export function listProjectsWithMessages() {
  const baseDir = getStatePath("project-messages");
  if (!fs.existsSync(baseDir)) return [];
  
  const projects = [];
  
  for (const dir of fs.readdirSync(baseDir)) {
    const messagesFile = path.join(baseDir, dir, "messages.jsonl");
    if (fs.existsSync(messagesFile)) {
      const messages = loadProjectMessages(dir);
      if (messages.length > 0) {
        projects.push({
          projectId: dir,
          messageCount: messages.length,
          lastActivity: messages[messages.length - 1].ts
        });
      }
    }
  }
  
  // Sort by last activity (most recent first)
  projects.sort((a, b) => b.lastActivity - a.lastActivity);
  
  return projects;
}

/**
 * Search project messages by text query
 * @param {string} projectId - Project identifier
 * @param {string} query - Search query
 * @param {object} options - Search options
 * @param {boolean} [options.caseSensitive=false] - Case sensitive search
 * @param {string} [options.source] - Filter by source
 * @param {string} [options.agent] - Filter by agent
 * @param {number} [options.limit=50] - Max results
 * @returns {Array} Matching messages with highlighted snippets
 */
export function searchProjectMessages(projectId, query, options = {}) {
  if (!projectId || !query) return [];
  
  const {
    caseSensitive = false,
    source = null,
    agent = null,
    limit = 50
  } = options;
  
  const messages = loadProjectMessages(projectId, { source, agent });
  const searchQuery = caseSensitive ? query : query.toLowerCase();
  const results = [];
  
  for (const msg of messages) {
    const content = caseSensitive ? msg.content : msg.content.toLowerCase();
    
    if (content.includes(searchQuery)) {
      // Find match position and create snippet
      const matchIndex = content.indexOf(searchQuery);
      const snippetStart = Math.max(0, matchIndex - 40);
      const snippetEnd = Math.min(msg.content.length, matchIndex + query.length + 40);
      
      let snippet = msg.content.slice(snippetStart, snippetEnd);
      if (snippetStart > 0) snippet = '...' + snippet;
      if (snippetEnd < msg.content.length) snippet = snippet + '...';
      
      results.push({
        ...msg,
        snippet,
        matchIndex
      });
      
      if (results.length >= limit) break;
    }
  }
  
  return results;
}

/**
 * Get message threads (grouped by threadId)
 * @param {string} projectId - Project identifier
 * @param {string} [threadId] - Specific thread ID, or null for all threads
 * @returns {Array|Object} All threads or specific thread messages
 */
export function getMessageThreads(projectId, threadId = null) {
  if (!projectId) return threadId ? [] : {};
  
  const messages = loadProjectMessages(projectId);
  
  // If specific thread requested, return just those messages
  if (threadId) {
    return messages.filter(m => m.threadId === threadId);
  }
  
  // Group all messages by threadId
  const threads = {};
  
  for (const msg of messages) {
    if (!msg.threadId) continue;
    
    if (!threads[msg.threadId]) {
      threads[msg.threadId] = [];
    }
    threads[msg.threadId].push(msg);
  }
  
  return threads;
}

/**
 * Build message tree from parent/child relationships
 * @param {string} projectId - Project identifier
 * @param {string} [rootId] - Root message ID, or null for all roots
 * @returns {Array} Tree structure with nested children
 */
export function buildMessageTree(projectId, rootId = null) {
  if (!projectId) return [];
  
  const messages = loadProjectMessages(projectId);
  const messageMap = new Map();
  const roots = [];
  
  // Index all messages
  for (const msg of messages) {
    messageMap.set(msg.id, { ...msg, children: [] });
  }
  
  // Build tree structure
  for (const msg of messages) {
    const node = messageMap.get(msg.id);
    
    if (msg.parentId && messageMap.has(msg.parentId)) {
      // Add to parent's children
      messageMap.get(msg.parentId).children.push(node);
    } else if (!msg.parentId || rootId === msg.id) {
      // Root node (no parent) or requested root
      roots.push(node);
    }
  }
  
  // If specific root requested, return just that subtree
  if (rootId && messageMap.has(rootId)) {
    return [messageMap.get(rootId)];
  }
  
  return roots;
}

/**
 * Export project messages in various formats
 * @param {string} projectId - Project identifier
 * @param {string} format - Export format: 'json', 'markdown', 'csv', 'txt'
 * @param {object} options - Export options
 * @param {number} [options.limit] - Max messages
 * @param {boolean} [options.includeMetadata=false] - Include metadata
 * @returns {string} Formatted export
 */
export function exportProjectMessages(projectId, format = 'markdown', options = {}) {
  if (!projectId) return '';
  
  const {
    limit = null,
    includeMetadata = false
  } = options;
  
  const messages = loadProjectMessages(projectId, limit ? { limit } : {});
  
  if (format === 'json') {
    return JSON.stringify(messages, null, 2);
  }
  
  if (format === 'markdown') {
    const sourceEmoji = {
      dashboard: '💻',
      cli: '⚡',
      'sub-agent': '👷',
      agent: '🤖'
    };
    
    let md = `# Project Chat: ${projectId}\n\n`;
    md += `**Total messages:** ${messages.length}\n`;
    md += `**Date range:** ${new Date(messages[0]?.ts).toLocaleString()} - ${new Date(messages[messages.length - 1]?.ts).toLocaleString()}\n\n`;
    md += '---\n\n';
    
    for (const msg of messages) {
      const emoji = sourceEmoji[msg.source] || '📝';
      const agentLabel = msg.agent ? ` [${msg.agent}]` : '';
      const timestamp = new Date(msg.ts).toLocaleTimeString();
      
      md += `### ${emoji}${agentLabel} ${msg.role} — ${timestamp}\n\n`;
      md += `${msg.content}\n\n`;
      
      if (includeMetadata && Object.keys(msg.metadata).length > 0) {
        md += `<details>\n<summary>Metadata</summary>\n\n`;
        md += '```json\n';
        md += JSON.stringify(msg.metadata, null, 2);
        md += '\n```\n</details>\n\n';
      }
    }
    
    return md;
  }
  
  if (format === 'csv') {
    let csv = 'timestamp,source,role,agent,content\n';
    
    for (const msg of messages) {
      const timestamp = new Date(msg.ts).toISOString();
      const content = msg.content.replace(/"/g, '""').replace(/\n/g, ' ');
      csv += `"${timestamp}","${msg.source}","${msg.role}","${msg.agent || ''}","${content}"\n`;
    }
    
    return csv;
  }
  
  if (format === 'txt') {
    let txt = '';
    
    for (const msg of messages) {
      const timestamp = new Date(msg.ts).toLocaleString();
      const agentLabel = msg.agent ? ` [${msg.agent}]` : '';
      txt += `[${timestamp}] ${msg.source}${agentLabel} (${msg.role}):\n`;
      txt += `${msg.content}\n\n`;
    }
    
    return txt;
  }
  
  return '';
}
