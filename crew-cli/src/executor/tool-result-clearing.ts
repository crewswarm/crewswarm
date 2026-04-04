/**
 * Tool Result Clearing
 *
 * When message history grows long, old tool results consume most of the context
 * window.  This module replaces result bodies for older turns with a compact
 * placeholder while preserving the tool name and an approximate size hint.
 *
 * The LLM is instructed (via a system-prompt addendum) to write down any
 * important data it will need later, because old results will be cleared.
 */

import type { TurnResult } from '../worker/autonomous-loop.js';

export interface ClearingConfig {
  /**
   * Keep this many of the most-recent turns' results fully intact.
   * Default: 5
   */
  keepRecent?: number;

  /**
   * Truncate individual results that exceed this character length even within
   * the "keep recent" window.  0 = no per-result truncation.
   * Default: 2000
   */
  maxResultLength?: number;
}

const DEFAULT_KEEP_RECENT = 5;
const DEFAULT_MAX_RESULT_LENGTH = 2000;

/**
 * Returns a new history array where tool results for all but the most-recent
 * `keepRecent` turns are replaced with a compact placeholder string.
 *
 * Results within the recent window are returned as-is, unless their string
 * representation exceeds `maxResultLength` — in that case they are truncated
 * and a note is appended.
 *
 * The original array is never mutated.
 */
export function clearOldToolResults(history: TurnResult[], config?: ClearingConfig): TurnResult[] {
  const keepRecent = config?.keepRecent ?? DEFAULT_KEEP_RECENT;
  const maxResultLength = config?.maxResultLength ?? DEFAULT_MAX_RESULT_LENGTH;

  if (history.length === 0) return [];

  // Index of the first turn that is considered "recent"
  const cutoff = Math.max(0, history.length - keepRecent);

  return history.map((entry, idx): TurnResult => {
    if (idx < cutoff) {
      // Compute original byte count for the placeholder
      const resultStr =
        typeof entry.result === 'string'
          ? entry.result
          : JSON.stringify(entry.result ?? '');
      const bytes = Buffer.byteLength(resultStr, 'utf8');

      return {
        ...entry,
        result: `[Result cleared — ${entry.tool} returned ${bytes} bytes]`,
      };
    }

    // Recent turn — keep intact but optionally truncate
    if (maxResultLength > 0) {
      const resultStr =
        typeof entry.result === 'string'
          ? entry.result
          : JSON.stringify(entry.result ?? '');
      if (resultStr.length > maxResultLength) {
        const truncated =
          typeof entry.result === 'string'
            ? entry.result.slice(0, maxResultLength) +
              `\n[...truncated ${resultStr.length - maxResultLength} chars]`
            : resultStr.slice(0, maxResultLength) +
              `\n[...truncated ${resultStr.length - maxResultLength} chars]`;
        return { ...entry, result: truncated };
      }
    }

    return entry;
  });
}

/**
 * System-prompt addendum to append when tool-result clearing is active.
 * Encourages the model to write down key data before results are cleared.
 */
export const TOOL_RESULT_CLEARING_PROMPT =
  '\n\nWhen working with tool results, write down any important information ' +
  'you might need later in your response, as the original tool result may be ' +
  'cleared later to free up context space.';
