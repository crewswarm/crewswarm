/**
 * Unified History Wrapper for Chat Handler
 * 
 * Wraps loadHistory/appendHistory to use unified history when available.
 * Falls back to platform-specific history for users without linked identities.
 */

import { loadHistory as loadPlatformHistory, appendHistory as appendPlatformHistory } from '../chat/history.mjs';
import { shouldUseUnifiedHistory, formatUnifiedHistory } from '../chat/unified-history.mjs';

/**
 * Load history with unified identity support
 * @param {string} userId - User ID (e.g., "owner", "telegram:123", etc.)
 * @param {string} sessionId - Session ID
 * @param {string|null} projectId - Optional project ID
 * @returns {Array} History messages
 */
export function loadHistoryUnified(userId, sessionId = "default", projectId = null) {
  // Check if this user has unified identity
  if (shouldUseUnifiedHistory(userId)) {
    // Load unified history from all linked platforms
    return formatUnifiedHistory(userId);
  }
  
  // Otherwise, use platform-specific history (existing behavior)
  return loadPlatformHistory(userId, sessionId, projectId);
}

/**
 * Append history (no change needed - platform bridges handle this)
 * @param {string} userId - User ID
 * @param {string} sessionId - Session ID
 * @param {string} role - "user", "assistant", or "system"
 * @param {string} content - Message content
 * @param {string|null} projectId - Optional project ID
 */
export function appendHistoryUnified(userId, sessionId, role, content, projectId = null) {
  // Always append to platform-specific history
  // (Unified loader will pick it up on next load)
  appendPlatformHistory(userId, sessionId, role, content, projectId);
}
