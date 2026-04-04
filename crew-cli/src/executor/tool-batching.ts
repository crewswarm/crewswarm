/**
 * Smart Tool Batching
 *
 * Partitions LLM tool calls into smart batches:
 *   - Read-only tools run concurrently in a batch
 *   - Write tools run one at a time, serially
 *   - Mixed sequences are split into alternating concurrent/serial batches
 *
 * Example: [grep, grep, file_write, file_read]
 *   → batch1 = concurrent [grep, grep]
 *   → batch2 = serial     [file_write]
 *   → batch3 = concurrent [file_read]
 */

import type { ToolCall } from '../worker/autonomous-loop.js';

export type { ToolCall };

/**
 * Tool names that are safe to run concurrently — they only read state,
 * never mutate the filesystem or execute processes.
 */
const READ_ONLY_TOOLS = new Set([
  'file_read',
  'read_file',
  'read_many_files',
  'grep',
  'grep_search',
  'glob',
  'find_files',
  'search_code',
  'web_search',
  'google_web_search',
  'web_fetch',
  'find_functions',
  'find_classes',
  'list_directory',
  'ls',
  'git_log',
  'git_diff',
  'git_status',
  'git_show',
  'git_blame',
  'get_internal_docs',
]);

/**
 * Returns true if this tool name is safe to run concurrently with other
 * read-only tools.  Any tool not in the allow-list is treated as a write.
 */
export function isConcurrencySafe(toolName: string): boolean {
  return READ_ONLY_TOOLS.has(toolName);
}

export interface ToolBatch {
  /** When true, all calls in this batch may run in parallel. */
  concurrent: boolean;
  calls: ToolCall[];
}

/**
 * Partition an ordered list of tool calls into ToolBatches.
 *
 * Consecutive read-only calls collapse into a single concurrent batch.
 * Each write call becomes its own serial batch (so side-effects remain ordered).
 *
 * An empty input returns an empty array.
 */
export function partitionToolCalls(calls: ToolCall[]): ToolBatch[] {
  if (calls.length === 0) return [];

  const batches: ToolBatch[] = [];
  let current: ToolBatch | null = null;

  for (const call of calls) {
    const safe = isConcurrencySafe(call.tool);

    if (safe) {
      // Append to open concurrent batch or start a new one
      if (current && current.concurrent) {
        current.calls.push(call);
      } else {
        current = { concurrent: true, calls: [call] };
        batches.push(current);
      }
    } else {
      // Write tool: always gets its own serial batch
      current = { concurrent: false, calls: [call] };
      batches.push(current);
      // Reset so the next read-only starts a fresh concurrent batch
      current = null;
    }
  }

  return batches;
}
