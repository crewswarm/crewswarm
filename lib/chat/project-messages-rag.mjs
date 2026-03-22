/**
 * Project Messages Collections Integration
 * 
 * Auto-indexes project messages into Collections for semantic/vector search.
 * Agents can query: "What did we discuss about authentication?"
 * MemoryBroker will include relevant conversation context.
 */

import { createCollection } from '../collections/index.mjs';
import { loadProjectMessages, listProjectsWithMessages } from './project-messages.mjs';

const COLLECTION_NAME = 'project-messages';

/**
 * Get or create project messages collection
 */
export function getProjectMessagesCollection() {
  return createCollection(COLLECTION_NAME);
}

/**
 * Index a single project message into Collections
 * @param {string} projectId - Project identifier
 * @param {object} message - Message object
 * @returns {number} Collection item ID
 */
export function indexProjectMessage(projectId, message) {
  const collection = getProjectMessagesCollection();
  
  const sourceEmoji = {
    dashboard: '💻',
    cli: '⚡',
    'sub-agent': '👷',
    agent: '🤖'
  };
  
  const emoji = sourceEmoji[message.source] || '📝';
  const agentLabel = message.agent ? ` [${message.agent}]` : '';
  const timestamp = new Date(message.ts).toLocaleString();
  
  // Create title with context
  const title = `${emoji} ${message.source}${agentLabel} — ${timestamp}`;
  
  // Content includes message with metadata
  let content = message.content;
  
  // Add context from metadata if present
  if (message.metadata && Object.keys(message.metadata).length > 0) {
    const metaContext = Object.entries(message.metadata)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    content += `\n\nContext: ${metaContext}`;
  }
  
  const itemId = collection.add({
    title,
    content,
    metadata: {
      projectId,
      messageId: message.id,
      source: message.source,
      role: message.role,
      agent: message.agent,
      timestamp: message.ts,
      threadId: message.threadId,
      parentId: message.parentId
    },
    tags: [
      projectId,
      message.source,
      message.role,
      message.agent || 'user'
    ].filter(Boolean)
  });
  
  return itemId;
}

/**
 * Index all messages for a project
 * @param {string} projectId - Project identifier
 * @param {object} options - Indexing options
 * @returns {number} Number of messages indexed
 */
export function indexProjectMessages(projectId, options = {}) {
  const { limit = null } = options;
  
  const messages = loadProjectMessages(projectId, limit ? { limit } : {});
  const collection = getProjectMessagesCollection();
  
  // Remove existing entries for this project
  const existing = collection.list({ limit: 10000 });
  for (const item of existing) {
    // metadata is already an object, not a JSON string
    const metadata = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;
    if (metadata && metadata.projectId === projectId) {
      collection.delete(item.id);
    }
  }
  
  // Index all messages
  let indexed = 0;
  for (const message of messages) {
    try {
      indexProjectMessage(projectId, message);
      indexed++;
    } catch (e) {
      console.warn(`[project-messages-rag] Failed to index message ${message.id}:`, e.message);
    }
  }
  
  return indexed;
}

/**
 * Index all projects (bulk operation)
 * @returns {object} Stats about indexing
 */
export function indexAllProjects() {
  const projects = listProjectsWithMessages();
  const stats = {
    projectsIndexed: 0,
    messagesIndexed: 0,
    errors: []
  };
  
  for (const project of projects) {
    try {
      const indexed = indexProjectMessages(project.projectId);
      stats.projectsIndexed++;
      stats.messagesIndexed += indexed;
    } catch (e) {
      stats.errors.push({ projectId: project.projectId, error: e.message });
    }
  }
  
  return stats;
}

/**
 * Search project messages using semantic/vector search
 * @param {string} query - Natural language query
 * @param {string} [projectId] - Filter to specific project
 * @param {object} options - Search options
 * @returns {Array} Relevant messages with scores
 */
export function searchProjectMessagesSemanticly(query, projectId = null, options = {}) {
  const {
    limit = 10,
    source = null,
    agent = null,
    role = null
  } = options;
  
  const collection = getProjectMessagesCollection();
  
  // Build filters
  const filters = {};
  
  if (projectId) {
    filters.tags = [projectId];
  }
  
  if (source) {
    filters.metadata = { source };
  }
  
  if (agent) {
    filters.metadata = { ...filters.metadata, agent };
  }
  
  if (role) {
    filters.metadata = { ...filters.metadata, role };
  }
  
  // Search
  const results = collection.search(query, filters, limit);
  
  return results.map(result => ({
    projectId: result.metadata.projectId,
    messageId: result.metadata.messageId,
    source: result.metadata.source,
    role: result.metadata.role,
    agent: result.metadata.agent,
    timestamp: result.metadata.timestamp,
    content: result.content.split('\n\nContext:')[0], // Remove metadata context
    snippet: result.matchedText,
    score: result.score,
    threadId: result.metadata.threadId,
    parentId: result.metadata.parentId
  }));
}

/**
 * Get conversation context for agent prompt injection
 * @param {string} projectId - Project identifier
 * @param {string} query - What the agent is working on
 * @param {number} limit - Max messages to return
 * @returns {string} Formatted context for LLM
 */
export function getConversationContext(projectId, query, limit = 5) {
  const results = searchProjectMessagesSemanticly(query, projectId, { limit });
  
  if (results.length === 0) {
    return '';
  }
  
  let context = '## Relevant Conversation History\n\n';
  context += `Found ${results.length} relevant messages from project "${projectId}":\n\n`;
  
  for (const result of results) {
    const emoji = { dashboard: '💻', cli: '⚡', 'sub-agent': '👷' }[result.source] || '📝';
    const agentLabel = result.agent ? ` [${result.agent}]` : '';
    const date = new Date(result.timestamp).toLocaleDateString();
    
    context += `${emoji} **${result.source}**${agentLabel} (${date}):\n`;
    context += `${result.content.slice(0, 300)}${result.content.length > 300 ? '...' : ''}\n\n`;
  }
  
  return context;
}

/**
 * Get collection statistics
 * @returns {object} Stats about indexed messages
 */
export function getIndexStats() {
  const collection = getProjectMessagesCollection();
  
  const allItems = collection.list({ limit: 10000 });
  const byProject = {};
  const bySource = {};
  
  for (const item of allItems) {
    const meta = item.metadata;
    const projectId = meta.projectId;
    const source = meta.source;
    
    byProject[projectId] = (byProject[projectId] || 0) + 1;
    bySource[source] = (bySource[source] || 0) + 1;
  }
  
  return {
    totalIndexed: allItems.length,
    projectCount: Object.keys(byProject).length,
    byProject,
    bySource,
    oldestMessage: allItems.length > 0 ? new Date(Math.min(...allItems.map(i => i.metadata.timestamp))) : null,
    newestMessage: allItems.length > 0 ? new Date(Math.max(...allItems.map(i => i.metadata.timestamp))) : null
  };
}

/**
 * Auto-index hook (call this after saving a message)
 * @param {string} projectId - Project identifier
 * @param {object} message - Message that was just saved
 */
export function autoIndexMessage(projectId, message) {
  try {
    indexProjectMessage(projectId, message);
  } catch (e) {
    // Silent fail — indexing is bonus, not critical
    console.warn('[project-messages-rag] Auto-index failed:', e.message);
  }
}
