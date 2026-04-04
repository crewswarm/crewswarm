/**
 * Context Compaction — Feature 2
 *
 * When message history exceeds 80% of the model's context window,
 * automatically compress older messages to keep the agent running
 * without hitting context limits.
 *
 * This is a thin wrapper around the existing token-compaction infrastructure
 * that presents a simpler API for the autonomous loop.
 */

import { estimateTokens, getContextWindow } from '../context/token-compaction.js';
import type { ChatMessage } from '../types/common.js';

/** Approximate tokens used by system prompt + current task */
const SYSTEM_OVERHEAD_TOKENS = 2000;

/**
 * Check whether the current message history is approaching the
 * model's context limit (threshold: 80%).
 */
export function shouldCompact(messages: ChatMessage[], model: string): boolean {
  if (messages.length === 0) return false;

  const contextWindow = getContextWindow(model);
  const threshold = contextWindow * 0.80;

  let estimatedTokens = SYSTEM_OVERHEAD_TOKENS;
  for (const msg of messages) {
    const text = typeof msg === 'string'
      ? msg
      : (msg.content || msg.text || JSON.stringify(msg));
    estimatedTokens += estimateTokens(String(text));
  }

  return estimatedTokens >= threshold;
}

/**
 * Compress the message history to reduce token usage.
 *
 * Strategy:
 *  - Keep the first message (system context) intact.
 *  - Keep the last 5 turns intact (most relevant recent work).
 *  - Compress the middle turns into one-line summaries.
 *
 * @param messages  Flat array of messages (any provider format)
 * @returns         Compacted array with fewer tokens
 */
export function compactMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= 7) return messages; // Nothing meaningful to compact

  const first = messages.slice(0, 1);         // System message
  const tail = messages.slice(-10);           // Last 5 turns = ~10 messages (assistant+user pairs)
  const middle = messages.slice(1, messages.length - 10);

  if (middle.length === 0) return messages;

  // Summarise each middle message to a single compact line
  const summaryLines = middle.map((msg, i) => {
    const role = msg.role || 'unknown';
    let preview = '';

    if (typeof msg.content === 'string') {
      preview = msg.content.slice(0, 120).replace(/\n/g, ' ');
    } else if (Array.isArray(msg.content)) {
      // OpenAI / Anthropic structured content blocks
      for (const block of msg.content) {
        if (block.text) { preview = block.text.slice(0, 120).replace(/\n/g, ' '); break; }
        if (block.type === 'tool_use') { preview = `[tool_use: ${block.name}]`; break; }
        if (block.type === 'tool_result') { preview = `[tool_result: ${String(block.content || '').slice(0, 80)}]`; break; }
        if (block.function) { preview = `[fn: ${block.function.name}]`; break; }
      }
    } else if (msg.parts) {
      // Gemini format
      for (const part of (msg.parts || [])) {
        if (part.text) { preview = part.text.slice(0, 120).replace(/\n/g, ' '); break; }
        if (part.functionCall) { preview = `[functionCall: ${part.functionCall.name}]`; break; }
        if (part.functionResponse) { preview = `[functionResponse: ${part.functionResponse.name}]`; break; }
      }
    }

    return `Turn ${i + 1} (${role}): ${preview || '(no preview)'}`;
  });

  const summaryText = `[Context compacted — ${middle.length} earlier messages summarised]\n${summaryLines.join('\n')}`;

  // Insert a synthetic summary message in the position of the middle messages.
  // Use a user-role message so all providers accept it.
  const summaryMsg = {
    role: 'user',
    content: summaryText
  };

  return [...first, summaryMsg, ...tail];
}
