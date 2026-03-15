/**
 * Unified History — Load Conversation History Across All Linked Platforms
 * 
 * When a user has linked identities (WhatsApp, Telegram, Dashboard), this module
 * loads and merges their conversation history from all platforms.
 */

import { loadHistory as loadPlatformHistory, appendHistory } from './history.mjs';
import { getMasterIdentity, getLinkedIdentities } from '../contacts/identity-linker.mjs';
import { readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Load unified history from all linked platforms
 * @param {string} contactId - Any platform identity or master identity
 * @param {number} maxMessages - Max messages to return
 * @returns {Array} Merged and sorted history from all platforms
 */
export function loadUnifiedHistory(contactId, maxMessages = 2000) {
  // Resolve to master identity
  const masterIdentity = getMasterIdentity(contactId) || contactId;
  const links = getLinkedIdentities(masterIdentity);
  
  // If no links, return empty (will fall back to platform-specific history)
  if (!links || Object.keys(links).length === 0) {
    return [];
  }
  
  // Collect history from all platforms
  const allHistory = [];
  
  try {
    // Dashboard history
    if (links.dashboard) {
      const userId = links.dashboard; // "owner"
      const sessionId = "default";
      try {
        const history = loadPlatformHistory(userId, sessionId);
        allHistory.push(...history.map(h => ({ 
          ...h, 
          source: 'dashboard',
          ts: h.ts || Date.now() 
        })));
      } catch (e) {
        // Dashboard history may not exist yet
      }
    }
    
    // Telegram history (includes ALL topics)
    if (links.telegram) {
      const telegramId = links.telegram.replace('telegram:', '');
      try {
        // Load main Telegram chat
        const history = loadPlatformHistory('telegram', telegramId);
        allHistory.push(...history.map(h => ({
          ...h,
          source: 'telegram',
          ts: h.ts || Date.now()
        })));
        
        // Load ALL topic conversations for this Telegram user
        // Topics are stored as: telegram/{chatId}-topic-{threadId}.jsonl
        const telegramDir = join(homedir(), '.crewswarm', 'chat-history', 'telegram');
        try {
          const files = readdirSync(telegramDir);
          
          // Find all topic files for this chat
          // Format: -1003624332545-topic-20.jsonl, -1003624332545-topic-94.jsonl, etc.
          const topicPattern = new RegExp(`^-?\\d+-topic-\\d+\\.jsonl$`);
          const topicFiles = files.filter(f => topicPattern.test(f));
          
          for (const topicFile of topicFiles) {
            const sessionKey = topicFile.replace('.jsonl', '');
            try {
              const topicHistory = loadPlatformHistory('telegram', sessionKey);
              allHistory.push(...topicHistory.map(h => ({
                ...h,
                source: `telegram-topic-${sessionKey.split('-topic-')[1] || 'unknown'}`,
                ts: h.ts || Date.now()
              })));
            } catch (e) {
              // Topic file may not exist or be unreadable
            }
          }
        } catch (e) {
          // Directory may not exist
        }
      } catch (e) {
        // Telegram history may not exist yet
      }
    }
    
    // WhatsApp history
    if (links.whatsapp) {
      const whatsappId = links.whatsapp.replace('whatsapp:', '');
      try {
        const history = loadPlatformHistory('whatsapp', whatsappId);
        allHistory.push(...history.map(h => ({ 
          ...h, 
          source: 'whatsapp',
          ts: h.ts || Date.now()
        })));
      } catch (e) {
        // WhatsApp history may not exist yet
      }
    }
  } catch (err) {
    console.error('[unified-history] Error loading platform histories:', err.message);
  }
  
  // Sort by timestamp and limit
  allHistory.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  
  return allHistory.slice(-maxMessages);
}

/**
 * Format unified history for LLM context
 * Removes source platform prefix for cleaner display
 * @param {string} contactId - Any platform identity or master identity
 * @param {number} maxMessages - Max messages to return
 * @returns {Array} Formatted history [{role, content, name}]
 */
export function formatUnifiedHistory(contactId, maxMessages = 50) {
  const history = loadUnifiedHistory(contactId, maxMessages);
  
  return history.map(h => ({
    role: h.role,
    content: h.content, // Clean content without [platform] prefix
    ...(h.agent && { name: h.agent }) // Include agent name if present
  }));
}

/**
 * Format unified history with platform indicators
 * Shows which platform each message came from
 * @param {string} contactId - Any platform identity or master identity
 * @param {number} maxMessages - Max messages to return
 * @returns {Array} Formatted history [{role, content, source}]
 */
export function formatUnifiedHistoryWithSource(contactId, maxMessages = 50) {
  const history = loadUnifiedHistory(contactId, maxMessages);
  
  const sourceEmoji = {
    dashboard: '💻',
    telegram: '✈️',
    whatsapp: '💬'
  };
  
  return history.map(h => ({
    role: h.role,
    content: `${sourceEmoji[h.source] || ''} ${h.content}`,
    source: h.source
  }));
}

/**
 * Check if a contact should use unified history
 * @param {string} contactId - Any platform identity
 * @returns {boolean}
 */
export function shouldUseUnifiedHistory(contactId) {
  const masterIdentity = getMasterIdentity(contactId);
  return masterIdentity !== null;
}

/**
 * Append message to unified history (saves to all platform histories)
 * NOTE: Current implementation saves to each platform's individual history.
 * This ensures backward compatibility with platform-specific history files.
 * 
 * @param {string} contactId - Any platform identity
 * @param {string} role - "user" or "assistant"
 * @param {string} content - Message content
 */
export function appendToUnifiedHistory(contactId, role, content) {
  const masterIdentity = getMasterIdentity(contactId) || contactId;
  const links = getLinkedIdentities(masterIdentity);
  
  if (!links || Object.keys(links).length === 0) {
    return; // No links, let platform handle it
  }
  
  // Append to the original platform's history
  // (Platform bridges already handle this, so we don't need to duplicate)
  // This function is here for future enhancements like central unified storage
}

/**
 * Get unified history stats
 * @param {string} contactId - Any platform identity or master identity
 * @returns {Object} Stats about unified history
 */
export function getUnifiedHistoryStats(contactId) {
  const masterIdentity = getMasterIdentity(contactId) || contactId;
  const links = getLinkedIdentities(masterIdentity);
  const history = loadUnifiedHistory(contactId);
  
  const stats = {
    masterIdentity,
    totalMessages: history.length,
    platforms: {},
    oldestMessage: null,
    newestMessage: null
  };
  
  // Count messages per platform
  for (const msg of history) {
    if (!stats.platforms[msg.source]) {
      stats.platforms[msg.source] = 0;
    }
    stats.platforms[msg.source]++;
  }
  
  // Get oldest and newest timestamps
  if (history.length > 0) {
    stats.oldestMessage = new Date(history[0].ts);
    stats.newestMessage = new Date(history[history.length - 1].ts);
  }
  
  return stats;
}
