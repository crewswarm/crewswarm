/**
 * Autonomous Worker Loop
 * Implements OpenOrca-style THINK → ACT → OBSERVE pattern
 *
 * @license
 * Copyright 2026 CrewSwarm
 */

import { partitionToolCalls } from '../executor/tool-batching.js';
import { clearOldToolResults } from '../executor/tool-result-clearing.js';
import { compactMessages } from '../executor/context-compaction.js';
import {
  runPostSamplingHooks,
  type PostSamplingHook,
  type HookContext
} from '../executor/post-sampling-hooks.js';

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
  /** Feature 5: Post-sampling hooks — run after each LLM+tool turn */
  hooks?: PostSamplingHook[];
  /** Feature 5: Project directory for hook context */
  projectDir?: string;
  /** Feature 6 (Max Output Token Recovery): model name for compaction */
  model?: string;
}

const DEFAULT_MAX_TURNS = 25;
const DEFAULT_REPEAT_THRESHOLD = 10;

// ─── Feature 7 (Reactive Compaction): context-length error detection ──

/**
 * Returns true if `err` looks like a context-too-long rejection from any
 * supported provider (OpenAI, Anthropic, Gemini, Groq, etc.).
 */
function isContextLengthError(err: any): boolean {
  const msg = String(err?.message || '').toLowerCase();
  return (
    msg.includes('context length') ||
    msg.includes('too long') ||
    msg.includes('payload size') ||
    msg.includes('context_length_exceeded') ||
    msg.includes('max_tokens') ||
    msg.includes('token limit') ||
    msg.includes('prompt is too long') ||
    msg.includes('maximum context') ||
    msg.includes('request payload size exceeds')
  );
}

// ─── Feature 6 (Max Output Token Recovery): finish-reason detection ───

/**
 * Returns true when the provider indicates the output was truncated
 * mid-generation (i.e., hit the model's max-output-token limit).
 */
function isTruncated(finishReason: string | undefined): boolean {
  if (!finishReason) return false;
  return finishReason === 'length' || finishReason === 'max_tokens';
}

/**
 * Returns true when the tool-call list produced by the LLM looks incomplete
 * (empty JSON objects, zero tool calls despite a non-empty response, etc.).
 * Used to decide whether to compact+retry vs. just continuing with a prompt.
 */
function hasIncompleteToolCalls(toolCalls: ToolCall[] | undefined, response: string): boolean {
  if (!toolCalls || toolCalls.length === 0) return false;
  // Heuristic: last tool call has an empty or clearly-truncated params object
  const last = toolCalls[toolCalls.length - 1];
  if (!last.params || Object.keys(last.params).length === 0) return true;
  // Heuristic: response ends mid-JSON (no closing brace/bracket)
  const trimmed = response.trimEnd();
  if (trimmed.endsWith(',') || trimmed.endsWith('{') || trimmed.endsWith('[')) return true;
  return false;
}

/**
 * Execute task autonomously with up to MAX_TURNS iterations.
 *
 * Features added:
 *  - Feature 3: AbortController — checks config.abortSignal before each turn
 *    and before each tool execution; also passes the signal to fetch calls via
 *    the executeLLM callback (callers that build fetch requests should forward it).
 *  - Feature 4: Budget limits — each LLM turn can return a `costUsd` field;
 *    execution stops when the cumulative cost exceeds config.maxBudgetUsd.
 *  - Feature 5: Post-sampling hooks — after tool execution each turn, runs all
 *    registered hooks. Stop/retry actions are honoured; continue messages are
 *    appended to the next turn's context via the task string.
 *  - Feature 6: Max output token recovery — when finish_reason is 'length' or
 *    'max_tokens', compact history and retry (up to 2 times) if tool calls were
 *    truncated, or append a continuation prompt for plain text truncation.
 *  - Feature 7: Reactive compaction — when the API rejects with a
 *    context-too-long error, compact history and retry automatically (once
 *    per turn to prevent infinite loops).
 */
export async function executeAutonomous(
  task: string,
  executeLLM: (prompt: string, tools: any[], history: TurnResult[], abortSignal?: AbortSignal) => Promise<{ toolCalls?: ToolCall[]; response: string; status?: string; costUsd?: number; finishReason?: string }>,
  executeTool: (tool: string, params: Record<string, any>, abortSignal?: AbortSignal) => Promise<any>,
  config: AutonomousConfig
): Promise<AutonomousResult> {
  const maxTurns = config.maxTurns || DEFAULT_MAX_TURNS;
  const repeatThreshold = config.repeatThreshold || DEFAULT_REPEAT_THRESHOLD;
  const history: TurnResult[] = [];
  const { abortSignal, maxBudgetUsd, hooks = [], projectDir = process.cwd(), model = '' } = config;

  let lastResponseText = '';
  let staleCount = 0;
  let totalCostUsd = 0;
  // Continuation messages injected by hooks or truncation recovery
  let pendingContext = '';

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
    let clearedHistory = clearOldToolResults(history);

    // Build effective task prompt, injecting any pending continuation context
    const effectiveTask = pendingContext ? `${task}\n\n${pendingContext}` : task;
    pendingContext = ''; // consumed

    // ── Feature 7: Reactive Compaction ────────────────────────────────
    // Wrap the executeLLM call to catch context-too-long errors and compact
    // history once before rethrowing.
    let reactiveCompacted = false;
    let response: { toolCalls?: ToolCall[]; response: string; status?: string; costUsd?: number; finishReason?: string };

    try {
      response = await executeLLM(effectiveTask, config.tools, clearedHistory, abortSignal);
    } catch (err) {
      if (isContextLengthError(err) && !reactiveCompacted) {
        reactiveCompacted = true;
        console.error('[crew-cli] Context exceeded — compacted history and retrying');
        clearedHistory = compactMessages(clearedHistory, model);
        response = await executeLLM(effectiveTask, config.tools, clearedHistory, abortSignal);
      } else {
        throw err;
      }
    }

    // ── Feature 6: Max Output Token Recovery ──────────────────────────
    let recoveryAttempts = 0;
    while (
      isTruncated(response.finishReason) &&
      hasIncompleteToolCalls(response.toolCalls, response.response) &&
      recoveryAttempts < 2
    ) {
      recoveryAttempts++;
      console.error(`[crew-cli] Output truncated (finish_reason=${response.finishReason}) — compacting and retrying (attempt ${recoveryAttempts}/2)`);
      clearedHistory = compactMessages(clearedHistory, model);
      try {
        response = await executeLLM(effectiveTask, config.tools, clearedHistory, abortSignal);
      } catch (err) {
        if (isContextLengthError(err) && !reactiveCompacted) {
          reactiveCompacted = true;
          console.error('[crew-cli] Context exceeded during recovery — compacting again');
          clearedHistory = compactMessages(clearedHistory, model);
          response = await executeLLM(effectiveTask, config.tools, clearedHistory, abortSignal);
        } else {
          throw err;
        }
      }
    }

    // If response was text-truncated (no tool calls), schedule continuation
    if (isTruncated(response.finishReason) && (!response.toolCalls || response.toolCalls.length === 0)) {
      pendingContext = '[Response was truncated. Continue from where you left off.]';
    }

    // ── Feature 4: Accumulate cost and stop if over budget ────────────
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
    const turnResults: TurnResult[] = [];

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
            const tr: TurnResult = { turn: turn + 1, tool: r.value.call.tool, params: r.value.call.params, result: r.value.result };
            history.push(tr);
            turnResults.push(tr);
          } else {
            const tr: TurnResult = { turn: turn + 1, tool: call.tool, params: call.params, result: null, error: r.reason?.message || 'concurrent execution failed' };
            history.push(tr);
            turnResults.push(tr);
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
            const tr: TurnResult = { turn: turn + 1, tool: call.tool, params: call.params, result };
            history.push(tr);
            turnResults.push(tr);
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
            const tr: TurnResult = { turn: turn + 1, tool: call.tool, params: call.params, result: null, error: error.message };
            history.push(tr);
            turnResults.push(tr);
          }
        }
      }
    }

    // ── Feature 5: Post-sampling hooks ────────────────────────────────
    if (hooks.length > 0) {
      const hookCtx: HookContext = {
        turn: turn + 1,
        response: response.response,
        toolCalls: response.toolCalls,
        toolResults: turnResults,
        history,
        projectDir
      };

      const hookResult = await runPostSamplingHooks(hooks, hookCtx);

      if (hookResult.action === 'stop') {
        return {
          success: false,
          turns: turn + 1,
          history,
          finalResponse: response.response,
          reason: hookResult.message || 'Stopped by post-sampling hook',
          totalCostUsd
        };
      }

      if (hookResult.action === 'retry') {
        // Roll back the last turn's results from history and redo the turn
        for (const tr of turnResults) {
          const idx = history.lastIndexOf(tr);
          if (idx !== -1) history.splice(idx, 1);
        }
        // Prepend hook message to pending context so the LLM sees it
        if (hookResult.message) {
          pendingContext = hookResult.message;
        }
        turn--; // decrement so the for-loop increment lands on the same turn index
        continue;
      }

      // action === 'continue': append any hook messages to next turn context
      if (hookResult.message) {
        pendingContext = pendingContext
          ? `${pendingContext}\n\n${hookResult.message}`
          : hookResult.message;
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
