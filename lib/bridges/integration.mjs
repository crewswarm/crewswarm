/**
 * Bridge Integration — Modular Project Message Saving
 * 
 * Provides a unified interface for all bridges (Telegram, WhatsApp, Slack, Discord)
 * to save conversations to project RAG automatically.
 * 
 * Usage:
 *   import { saveBridgeMessage } from './lib/bridges/integration.mjs';
 *   saveBridgeMessage('telegram', projectId, chatId, role, content, agent, metadata);
 */

import { saveProjectMessage } from '../chat/project-messages.mjs';
import { indexProjectMessage } from '../chat/project-messages-rag.mjs';

/**
 * Platform-specific configuration
 */
const PLATFORM_CONFIG = {
  telegram: {
    enabled: true,
    sourcePrefix: 'telegram-topic',
    excludeAgents: ['crew-loco'], // Chat-only agents
    icon: '📱'
  },
  whatsapp: {
    enabled: true,
    sourcePrefix: 'whatsapp',
    excludeAgents: ['crew-loco'],
    icon: '💬'
  },
  slack: {
    enabled: true,
    sourcePrefix: 'slack-channel',
    excludeAgents: [],
    icon: '🔷'
  },
  discord: {
    enabled: true,
    sourcePrefix: 'discord-channel',
    excludeAgents: [],
    icon: '💜'
  },
  'crew-chat': {
    enabled: true,
    sourcePrefix: 'crew-chat',
    excludeAgents: [],
    icon: '💻'
  }
};

/**
 * Save a message from any bridge to project RAG
 * 
 * @param {string} platform - Platform name (telegram, whatsapp, slack, discord)
 * @param {string} projectId - Project ID (or null for multi-project detection)
 * @param {string} chatId - Platform-specific chat/channel ID
 * @param {string} role - 'user' or 'assistant'
 * @param {string} content - Message content
 * @param {string|null} agent - Agent ID if from an agent (e.g., 'crew-pm')
 * @param {object} metadata - Additional metadata (threadId, username, etc.)
 * @returns {boolean} true if saved, false if skipped
 */
export function saveBridgeMessage(platform, projectId, chatId, role, content, agent = null, metadata = {}) {
  // Get platform config
  const config = PLATFORM_CONFIG[platform];
  if (!config || !config.enabled) {
    return false;
  }
  
  // Skip if agent is excluded (e.g., crew-loco chat-only mode)
  if (agent && config.excludeAgents.includes(agent)) {
    return false;
  }
  
  // Skip if no project context
  if (!projectId || projectId === 'general' || projectId === 'none') {
    return false;
  }
  
  try {
    // Build message object
    const message = {
      source: config.sourcePrefix,
      role,
      content,
      agent: agent || null,
      metadata: {
        platform,
        chatId,
        ...metadata
      }
    };
    
    // Save to project messages
    saveProjectMessage(projectId, message);
    
    // Index for semantic search
    indexProjectMessage(projectId, message);
    
    console.log(`[bridge-integration] ${config.icon} Saved ${platform} message to project "${projectId}" (agent: ${agent || 'user'})`);
    
    return true;
  } catch (error) {
    console.error(`[bridge-integration] Failed to save ${platform} message:`, error.message);
    return false;
  }
}

/**
 * Check if a platform/agent should save to project RAG
 * 
 * @param {string} platform - Platform name
 * @param {string|null} agent - Agent ID
 * @returns {boolean} true if should save
 */
export function shouldSaveToProjectRAG(platform, agent = null) {
  const config = PLATFORM_CONFIG[platform];
  if (!config || !config.enabled) return false;
  if (agent && config.excludeAgents.includes(agent)) return false;
  return true;
}

/**
 * Get all enabled platforms
 * @returns {string[]} List of platform names
 */
export function getEnabledPlatforms() {
  return Object.entries(PLATFORM_CONFIG)
    .filter(([_, config]) => config.enabled)
    .map(([platform, _]) => platform);
}

/**
 * Register a new platform (for dynamic bridge loading)
 * 
 * @param {string} platform - Platform name
 * @param {object} config - Platform configuration
 */
export function registerPlatform(platform, config) {
  PLATFORM_CONFIG[platform] = {
    enabled: true,
    sourcePrefix: config.sourcePrefix || platform,
    excludeAgents: config.excludeAgents || [],
    icon: config.icon || '📡'
  };
  console.log(`[bridge-integration] Registered platform: ${platform}`);
}

/**
 * Multi-project detection for platforms without explicit project selection
 * 
 * When a message mentions a project name or uses dispatch syntax,
 * automatically detect and route to that project.
 * 
 * @param {string} content - Message content
 * @param {Array} allProjects - List of all projects { id, name, outputDir }
 * @returns {string|null} Detected project ID or null
 */
export function detectProjectFromMessage(content, allProjects) {
  if (!content || !allProjects?.length) return null;
  
  const lowerContent = content.toLowerCase();
  
  // Pattern 1: Explicit dispatch with project
  // "dispatch crew-coder to website project: implement feature"
  const dispatchMatch = lowerContent.match(/(?:dispatch|send|ask).*?(?:to|for)\s+(\w+[\w-]*)\s+project/i);
  if (dispatchMatch) {
    const projectName = dispatchMatch[1];
    const match = allProjects.find(p => 
      p.name.toLowerCase() === projectName.toLowerCase() || 
      p.id.toLowerCase() === projectName.toLowerCase()
    );
    if (match) return match.id;
  }
  
  // Pattern 2: Project mention
  // "work on the api-server project"
  // "in the website project"
  for (const project of allProjects) {
    const projectPattern = new RegExp(`\\b${project.name}\\s+project\\b`, 'i');
    if (projectPattern.test(content)) {
      return project.id;
    }
  }
  
  // Pattern 3: File path mentions
  // "edit website/src/index.html"
  for (const project of allProjects) {
    if (project.outputDir) {
      const dirName = project.outputDir.split('/').pop();
      const pathPattern = new RegExp(`\\b${dirName}/`, 'i');
      if (pathPattern.test(content)) {
        return project.id;
      }
    }
  }
  
  return null;
}

/**
 * Batch save multiple messages (for history sync)
 * 
 * @param {string} platform - Platform name
 * @param {string} projectId - Project ID
 * @param {Array} messages - Array of { role, content, agent, metadata }
 * @returns {number} Number of messages saved
 */
export function saveBridgeMessages(platform, projectId, messages) {
  if (!projectId || projectId === 'general') return 0;
  
  let saved = 0;
  for (const msg of messages) {
    if (saveBridgeMessage(platform, projectId, msg.chatId, msg.role, msg.content, msg.agent, msg.metadata)) {
      saved++;
    }
  }
  
  return saved;
}

export default {
  saveBridgeMessage,
  shouldSaveToProjectRAG,
  getEnabledPlatforms,
  registerPlatform,
  detectProjectFromMessage,
  saveBridgeMessages
};
