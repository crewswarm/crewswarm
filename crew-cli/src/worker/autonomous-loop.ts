/**
 * Autonomous Worker Loop
 * Implements OpenOrca-style THINK → ACT → OBSERVE pattern
 *
 * @license
 * Copyright 2026 CrewSwarm
 */

import { partitionToolCalls } from '../executor/tool-batching.js';
import { clearOldToolResults } from '../executor/tool-result-clearing.js';

export interface ToolCall {
  tool: string;
  params: Record<string, any>;
}

export interface TurnResult {
  turn: number;
  tool: string;
  params: Record<string, any>;
  result: any;
  error?: string;
}

export interface AutonomousResult {
  success: boolean;
  turns: number;
  history: TurnResult[];
  finalResponse?: string;
  reason?: string;
  /** Feature 4: total estimated cost accumulated across all turns */
  totalCostUsd?: number;
}

export interface AutonomousConfig {
  maxTurns?: number;
  repeatThreshold?: number;
  tools: any[];
  onProgress?: (turn: number, action: string) => void;
  /** Feature 3: AbortController signal — cancel execution cleanly mid-turn */
  abortSignal?: AbortSignal;
  /** Feature 4: Budget limit in USD — stop when cumulative cost exceeds this */
  maxBudgetUsd?: number;
}

const DEFAULT_MAX_TURNS = 25;
const DEFAULT_REPEAT_THRESHOLD = 10;

/**
 * Execute task autonomously with up to MAX_TURNS iterations.
 *
 * Features added:
 *  - Feature 3: AbortController — checks config.abortSignal before each turn
 *    and before each tool execution; also passes the signal to fetch calls via
 *    the executeLLM callback (callers that build fetch requests should forward it).
 *  - Feature 4: Budget limits — each LLM turn can return a `costUsd` field;
 *    execution stops when the cumulative cost exceeds config.maxBudgetUsd.
 */
export async function executeAutonomous(
  task: string,
  executeLLM: (prompt: string, tools: any[], history: TurnResult[], abortSignal?: AbortSignal) => Promise<{ toolCalls?: ToolCall[]; response: string; status?: string; costUsd?: number }>,
  executeTool: (tool: string, params: Record<string, any>, abortSignal?: AbortSignal) => Promise<any>,
  config: AutonomousConfig
): Promise<AutonomousResult> {
  const maxTurns = config.maxTurns || DEFAULT_MAX_TURNS;
  const repeatThreshold = config.repeatThreshold || DEFAULT_REPEAT_THRESHOLD;
  const history: TurnResult[] = [];
  const { abortSignal, maxBudgetUsd } = config;

  let lastResponseText = '';
  let staleCount = 0;
  let totalCostUsd = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    // Feature 3: Check abort at start of each turn
    if (abortSignal?.aborted) {
      return {
        success: false,
        turns: turn,
        history,
        reason: 'Aborted by caller',
        totalCostUsd
      };
    }

    config.onProgress?.(turn + 1, 'THINKING');

    // Feature: Tool-result clearing — replace old result bodies with compact
    // placeholders to free context space before sending history to the LLM.
    const clearedHistory = clearOldToolResults(history);

    // THINK: LLM decides next action
    const response = await executeLLM(task, config.tools, clearedHistory, abortSignal);

    // Feature 4: Accumulate cost and stop if over budget
    if (response.costUsd) {
      totalCostUsd += response.costUsd;
      if (maxBudgetUsd !== undefined && totalCostUsd > maxBudgetUsd) {
        return {
          success: false,
          turns: turn + 1,
          history,
          finalResponse: response.response,
          reason: `Budget limit exceeded: $${totalCostUsd.toFixed(4)} > $${maxBudgetUsd.toFixed(4)}`,
          totalCostUsd
        };
      }
    }

    // Check if task is complete
    if (response.status === 'COMPLETE' || !response.toolCalls || response.toolCalls.length === 0) {
      return {
        success: true,
        turns: turn + 1,
        history,
        finalResponse: response.response,
        totalCostUsd
      };
    }

    // Stale response detection: if LLM gives same text 2x in a row, it's done
    if (response.response && response.response.length > 20) {
      if (response.response === lastResponseText) {
        staleCount++;
        if (staleCount >= 2) {
          return {
            success: true,
            turns: turn + 1,
            history,
            finalResponse: response.response,
            reason: 'Detected stale response (same output repeated), treating as complete',
            totalCostUsd
          };
        }
      } else {
        staleCount = 0;
      }
      lastResponseText = response.response;
    }

    // ACT: Execute tool calls using smart batching.
    // Read-only tools in a batch run concurrently; write tools run serially one
    // at a time.  This preserves correctness for mutations while maximising
    // throughput for reads.
    // Feature 3: Check abort before starting any tool execution
    if (abortSignal?.aborted) {
      return {
        success: false,
        turns: turn + 1,
        history,
        reason: 'Aborted before tool execution',
        totalCostUsd
      };
    }

    const batches = partitionToolCalls(response.toolCalls);

    for (const batch of batches) {
      // Feature 3: check abort between batches
      if (abortSignal?.aborted) {
        return {
          success: false,
          turns: turn + 1,
          history,
          reason: 'Aborted between tool batches',
          totalCostUsd
        };
      }

      if (batch.concurrent && batch.calls.length > 1) {
        // Concurrent batch — run all read-only calls in parallel
        config.onProgress?.(turn + 1, `EXECUTING ${batch.calls.length} tools concurrently`);
        const results = await Promise.allSettled(
          batch.calls.map(async (call) => {
            if (abortSignal?.aborted) throw new Error('AbortError');
            config.onProgress?.(turn + 1, `EXECUTING: ${call.tool}`);
            return { call, result: await executeTool(call.tool, call.params, abortSignal) };
          })
        );
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          const call = batch.calls[i];
          if (r.status === 'fulfilled') {
            history.push({ turn: turn + 1, tool: r.value.call.tool, params: r.value.call.params, result: r.value.result });
          } else {
            history.push({ turn: turn + 1, tool: call.tool, params: call.params, result: null, error: r.reason?.message || 'concurrent execution failed' });
          }
        }
      } else {
        // Serial batch (write tool, or single read-only) — run each call in order
        for (const call of batch.calls) {
          if (abortSignal?.aborted) {
            return {
              success: false,
              turns: turn + 1,
              history,
              reason: 'Aborted during tool execution',
              totalCostUsd
            };
          }
          config.onProgress?.(turn + 1, `EXECUTING: ${call.tool}`);
          try {
            const result = await executeTool(call.tool, call.params, abortSignal);
            history.push({ turn: turn + 1, tool: call.tool, params: call.params, result });
          } catch (error: any) {
            if (abortSignal?.aborted || error?.name === 'AbortError') {
              return {
                success: false,
                turns: turn + 1,
                history,
                reason: 'Aborted during tool execution',
                totalCostUsd
              };
            }
            history.push({ turn: turn + 1, tool: call.tool, params: call.params, result: null, error: error.message });
          }
        }
      }
    }

    // Safety check: Detect if stuck in a loop
    if (turn > repeatThreshold && isRepeating(history, 3)) {
      return {
        success: false,
        turns: turn + 1,
        history,
        reason: 'Detected repeated actions, stopping to prevent infinite loop',
        totalCostUsd
      };
    }
  }

  return {
    success: false,
    turns: maxTurns,
    history,
    reason: 'Maximum turns exceeded without completing task',
    totalCostUsd
  };
}

/**
 * Detect if the agent is repeating the same actions
 */
function isRepeating(history: TurnResult[], windowSize: number = 3): boolean {
  if (history.length < windowSize * 2) return false;

  const recentActions = history
    .slice(-windowSize)
    .map(h => `${h.tool}:${JSON.stringify(h.params)}`);

  const previousActions = history
    .slice(-windowSize * 2, -windowSize)
    .map(h => `${h.tool}:${JSON.stringify(h.params)}`);

  return JSON.stringify(recentActions) === JSON.stringify(previousActions);
}

/**
 * Format autonomous execution result for display
 */
export function formatAutonomousResult(result: AutonomousResult): string {
  let output = `\n🤖 Autonomous Execution ${result.success ? '✓' : '✗'}\n`;
  output += `Turns: ${result.turns}/${result.history.length}\n\n`;

  for (const turn of result.history) {
    output += `Turn ${turn.turn}: ${turn.tool}\n`;
    if (turn.error) {
      output += `  ✗ Error: ${turn.error}\n`;
    } else {
      const resultStr = typeof turn.result === 'string' 
        ? turn.result.slice(0, 100) 
        : JSON.stringify(turn.result).slice(0, 100);
      output += `  ✓ ${resultStr}${resultStr.length >= 100 ? '...' : ''}\n`;
    }
  }

  if (result.finalResponse) {
    output += `\n📝 Final Response:\n${result.finalResponse}\n`;
  }

  if (result.reason) {
    output += `\n⚠️  Stopped: ${result.reason}\n`;
  }

  return output;
}
