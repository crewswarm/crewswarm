/**
 * RunEngine — Central execution engine for crew-cli.
 *
 * Wraps the autonomous loop with RunState, failure memory, and
 * verification-first execution. This is the single owner of a
 * task execution lifecycle.
 *
 * Usage:
 *   const engine = new RunEngine({ task, sessionId });
 *   const result = await engine.execute(executeLLM, executeTool, config);
 *
 * The engine:
 *   1. Injects failure-avoidance context into each LLM turn
 *   2. Records failures and prevents repeated bad moves
 *   3. Extracts and tracks verification goals from the task
 *   4. Runs a verification-first loop after the main execution
 *   5. Provides a complete RunState snapshot for auditing
 */

import { RunState, type RunPhase, type FailureRecord } from './run-state.js';
import type { ToolCall, TurnResult, AutonomousConfig, AutonomousResult } from '../worker/autonomous-loop.js';
import { clearOldToolResults } from '../executor/tool-result-clearing.js';
import { partitionToolCalls } from '../executor/tool-batching.js';
import { buildTurnGuidance, type TaskMode } from '../execution/agentic-guidance.js';
import { buildActionRankingPrompt } from '../execution/action-ranking.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunEngineConfig {
  task: string;
  sessionId?: string;
  traceId?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  abortSignal?: AbortSignal;
  tools?: unknown[];
  model?: string;
  /** Task mode for strategy selection and action ranking */
  taskMode?: TaskMode;
  /** Verification commands to run after execution (e.g., ['npm test', 'npm run lint']) */
  verificationCommands?: string[];
  /** Max verification retry cycles */
  maxVerificationCycles?: number;
  /** Max extra turns allowed for verification-first gate (default: 3) */
  maxVerificationGateTurns?: number;
  onProgress?: (turn: number, action: string) => void;
}

export interface RunEngineResult {
  success: boolean;
  output: string;
  history: TurnResult[];
  runState: RunState;
  verificationPassed: boolean;
  failureCount: number;
  turns: number;
  costUsd: number;
}

type ExecuteLLMFn = (
  prompt: string,
  tools: unknown[],
  history: TurnResult[],
  abortSignal?: AbortSignal
) => Promise<{
  toolCalls?: ToolCall[];
  response: string;
  status?: string;
  costUsd?: number;
  finishReason?: string;
}>;

type ExecuteToolFn = (
  tool: string,
  params: Record<string, unknown>,
  abortSignal?: AbortSignal
) => Promise<unknown>;

// ---------------------------------------------------------------------------
// RunEngine
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TURNS = 25;
const DEFAULT_REPEAT_THRESHOLD = 10;
const DEFAULT_MAX_VERIFICATION_CYCLES = 2;
const DEFAULT_MAX_VERIFICATION_GATE_TURNS = 3;

export class RunEngine {
  readonly state: RunState;
  private config: RunEngineConfig;

  constructor(config: RunEngineConfig) {
    this.config = config;
    this.state = new RunState({
      task: config.task,
      sessionId: config.sessionId,
      traceId: config.traceId
    });

    // Extract verification goals from task and explicit commands
    this.extractVerificationGoals(config);
  }

  /**
   * Execute the task end-to-end: plan → execute → verify.
   */
  async execute(
    executeLLM: ExecuteLLMFn,
    executeTool: ExecuteToolFn
  ): Promise<RunEngineResult> {
    const {
      maxTurns = DEFAULT_MAX_TURNS,
      maxBudgetUsd,
      abortSignal,
      tools = [],
      onProgress,
      taskMode = 'analysis' as TaskMode,
      maxVerificationCycles = DEFAULT_MAX_VERIFICATION_CYCLES,
      maxVerificationGateTurns = DEFAULT_MAX_VERIFICATION_GATE_TURNS
    } = this.config;

    const history: TurnResult[] = [];
    let lastResponseText = '';
    let staleCount = 0;
    let pendingContext = '';
    let finalResponse = '';
    let verificationGateTurnsUsed = 0;

    // ── Execute phase ─────────────────────────────────────────────────
    this.state.enterPhase('executing');

    for (let turn = 0; turn < maxTurns; turn++) {
      if (abortSignal?.aborted) {
        this.state.abort('Aborted by caller');
        break;
      }

      if (maxBudgetUsd && this.state.isOverBudget(maxBudgetUsd)) {
        this.state.addPhaseNote(`Budget exceeded: $${this.state.cost.totalUsd.toFixed(4)} >= $${maxBudgetUsd}`);
        break;
      }

      this.state.recordTurn();
      onProgress?.(turn + 1, 'THINKING');

      // Build context with failure avoidance + verification goals + action ranking
      const failureCtx = this.state.buildFailureContext();
      const verifyCtx = this.state.buildVerificationContext();
      const actionCtx = buildActionRankingPrompt(history, taskMode);
      const extraContext = [failureCtx, verifyCtx, actionCtx].filter(Boolean).join('\n\n');
      const effectiveTask = [this.config.task, extraContext, pendingContext].filter(Boolean).join('\n\n');
      pendingContext = '';

      // Clear old tool results to save context
      const clearedHistory = clearOldToolResults(history);

      // Call LLM
      let response: { toolCalls?: ToolCall[]; response: string; status?: string; costUsd?: number; finishReason?: string };
      try {
        response = await executeLLM(effectiveTask, tools, clearedHistory, abortSignal);
      } catch (err) {
        const msg = (err as Error).message || String(err);
        if (isContextLengthError(msg)) {
          this.state.addPhaseNote('Context exceeded — compacting history');
          // Compact and retry once
          const compacted = compactTurnHistory(clearedHistory);
          try {
            response = await executeLLM(effectiveTask, tools, compacted, abortSignal);
          } catch {
            this.state.enterPhase('failed');
            break;
          }
        } else {
          this.state.enterPhase('failed');
          break;
        }
      }

      // Track cost
      if (response!.costUsd) {
        this.state.recordCost({
          usd: response!.costUsd,
          model: this.config.model
        });
      }

      // Stale response detection
      if (response!.response === lastResponseText) {
        staleCount++;
        if (staleCount >= DEFAULT_REPEAT_THRESHOLD) {
          this.state.addPhaseNote('Stale response detected — stopping');
          break;
        }
      } else {
        staleCount = 0;
      }
      lastResponseText = response!.response;
      finalResponse = response!.response;

      // ── Completion check with verification gate ─────────────────
      if (!response!.toolCalls || response!.toolCalls.length === 0) {
        const unprovenGoal = this.state.nextUnprovenGoal();
        if (unprovenGoal && verificationGateTurnsUsed < maxVerificationGateTurns) {
          // Hard gate: don't stop — force verification
          verificationGateTurnsUsed++;
          this.state.addPhaseNote(`Verification gate: forcing verification for "${unprovenGoal.description}"`);
          pendingContext = [
            '## STOP — verification required before completing',
            `You indicated completion, but this goal is unproven: "${unprovenGoal.description}"`,
            'Run the verification command or test that proves this goal before finishing.',
            this.config.verificationCommands?.length
              ? `Available verification commands: ${this.config.verificationCommands.join(', ')}`
              : 'Run the most targeted test or check command for the changes you made.'
          ].join('\n');
          continue; // force another turn
        }
        break;
      }

      // Execute tool calls with failure tracking
      if (response!.toolCalls && response!.toolCalls.length > 0) {
        const batches = partitionToolCalls(response!.toolCalls);

        for (const batch of batches) {
          if (abortSignal?.aborted) break;

          for (const call of batch.calls) {
            // ── Failure memory: check if this would repeat a known failure
            const wouldRepeat = this.state.wouldRepeatFailure(call.tool, call.params);
            if (wouldRepeat) {
              const skipMsg = `Skipped: already failed ${wouldRepeat.count}x with same params`;
              history.push({
                turn: turn + 1,
                tool: call.tool,
                params: call.params,
                result: null,
                error: skipMsg
              });
              this.state.addPhaseNote(`Blocked repeated failure: ${call.tool}`);
              continue;
            }

            onProgress?.(turn + 1, `EXECUTING: ${call.tool}`);

            try {
              const result = await executeTool(call.tool, call.params, abortSignal);
              history.push({ turn: turn + 1, tool: call.tool, params: call.params, result });

              // Check if this tool call proves a verification goal
              this.checkVerificationProof(call, result);
            } catch (error) {
              const errMsg = (error as Error).message || 'tool execution failed';
              history.push({ turn: turn + 1, tool: call.tool, params: call.params, result: null, error: errMsg });

              // Record failure for future avoidance
              this.state.recordFailure({
                turn: turn + 1,
                tool: call.tool,
                params: call.params,
                error: errMsg
              });
            }
          }
        }
      }

      // ── Per-turn guidance: task-mode coaching + action ranking ────
      const turnResults = history.filter(h => h.turn === turn + 1);
      const turnGuidance = buildTurnGuidance(taskMode, history, turnResults);
      if (turnGuidance) {
        pendingContext = pendingContext
          ? `${pendingContext}\n\n${turnGuidance}`
          : turnGuidance;
      }
    }

    // ── Verification phase ────────────────────────────────────────────
    let verificationPassed = false;

    if (this.state.phase !== 'failed' && this.state.phase !== 'aborted') {
      this.state.enterPhase('qa');

      // Run verification commands if provided
      if (this.config.verificationCommands && this.config.verificationCommands.length > 0) {
        for (let cycle = 0; cycle < maxVerificationCycles; cycle++) {
          const allPassed = await this.runVerificationCycle(
            executeTool,
            history,
            abortSignal
          );

          if (allPassed) {
            verificationPassed = true;
            break;
          }

          // If verification failed and we have cycles left, let LLM fix
          if (cycle < maxVerificationCycles - 1) {
            this.state.addPhaseNote(`Verification cycle ${cycle + 1} failed — retrying`);
            const fixPrompt = this.buildVerificationFixPrompt();
            pendingContext = fixPrompt;

            // One more LLM turn to fix
            const clearedHistory = clearOldToolResults(history);
            const fixContext = [this.config.task, fixPrompt, this.state.buildFailureContext()].filter(Boolean).join('\n\n');
            try {
              const fixResponse = await executeLLM(fixContext, tools, clearedHistory, abortSignal);
              if (fixResponse.toolCalls) {
                for (const call of fixResponse.toolCalls) {
                  try {
                    const result = await executeTool(call.tool, call.params, abortSignal);
                    history.push({ turn: this.state.turns + 1, tool: call.tool, params: call.params, result });
                    this.state.recordTurn();
                  } catch (error) {
                    const errMsg = (error as Error).message || 'fix failed';
                    history.push({ turn: this.state.turns + 1, tool: call.tool, params: call.params, result: null, error: errMsg });
                    this.state.recordFailure({ turn: this.state.turns + 1, tool: call.tool, params: call.params, error: errMsg });
                  }
                }
              }
            } catch {
              // Fix attempt failed, continue to next cycle
            }
          }
        }
      } else {
        // No explicit verification commands — check goal satisfaction
        verificationPassed = this.state.allGoalsProven() || this.state.verificationGoals.length === 0;
      }

      this.state.enterPhase(verificationPassed ? 'complete' : 'failed');
    }

    return {
      success: this.state.phase === 'complete',
      output: finalResponse,
      history,
      runState: this.state,
      verificationPassed,
      failureCount: this.state.failures.length,
      turns: this.state.turns,
      costUsd: this.state.cost.totalUsd
    };
  }

  // ── Verification helpers ────────────────────────────────────────────

  private extractVerificationGoals(config: RunEngineConfig): void {
    // Extract from explicit commands
    if (config.verificationCommands) {
      for (const cmd of config.verificationCommands) {
        this.state.addVerificationGoal(`Command passes: ${cmd}`);
      }
    }

    // Extract from task text (heuristic)
    const task = config.task.toLowerCase();
    if (task.includes('test') && !task.includes('don\'t test')) {
      this.state.addVerificationGoal('Tests pass after changes');
    }
    if (task.includes('lint') || task.includes('typecheck') || task.includes('type-check')) {
      this.state.addVerificationGoal('Lint/typecheck passes');
    }
    if (task.includes('build')) {
      this.state.addVerificationGoal('Build succeeds');
    }
  }

  private checkVerificationProof(call: ToolCall, result: unknown): void {
    const output = String(result || '');

    // Shell commands can prove verification goals
    if (call.tool === 'run_shell_command' || call.tool === 'shell') {
      const command = String(call.params.command || '');
      for (const goal of this.state.verificationGoals) {
        if (goal.status !== 'pending') continue;

        // Match command to goal
        if (goal.description.includes(command) ||
            (command.includes('test') && goal.description.includes('test')) ||
            (command.includes('lint') && goal.description.includes('lint')) ||
            (command.includes('build') && goal.description.includes('build'))) {
          // Check if it passed (no error in output)
          if (!output.includes('FAIL') && !output.includes('error') && !output.includes('Error')) {
            this.state.proveGoal(goal.id, `${call.tool}: ${command}`);
          } else {
            this.state.failGoal(goal.id);
          }
        }
      }
    }
  }

  private async runVerificationCycle(
    executeTool: ExecuteToolFn,
    history: TurnResult[],
    abortSignal?: AbortSignal
  ): Promise<boolean> {
    if (!this.config.verificationCommands) return true;

    let allPassed = true;
    for (const cmd of this.config.verificationCommands) {
      try {
        const result = await executeTool('run_shell_command', { command: cmd }, abortSignal);
        const output = String(result || '');
        history.push({
          turn: this.state.turns + 1,
          tool: 'run_shell_command',
          params: { command: cmd },
          result
        });

        // Find matching goal
        const goal = this.state.verificationGoals.find(
          g => g.status === 'pending' && g.description.includes(cmd)
        );

        if (output.includes('FAIL') || output.includes('error')) {
          allPassed = false;
          if (goal) this.state.failGoal(goal.id);
          this.state.recordFailure({
            turn: this.state.turns,
            tool: 'run_shell_command',
            params: { command: cmd },
            error: `Verification failed: ${output.slice(0, 200)}`
          });
        } else {
          if (goal) this.state.proveGoal(goal.id, `verification: ${cmd}`);
        }
      } catch (error) {
        allPassed = false;
        const errMsg = (error as Error).message || 'verification command failed';
        history.push({
          turn: this.state.turns + 1,
          tool: 'run_shell_command',
          params: { command: cmd },
          result: null,
          error: errMsg
        });
      }
    }
    return allPassed;
  }

  private buildVerificationFixPrompt(): string {
    const failed = this.state.verificationGoals.filter(g => g.status === 'failed');
    if (failed.length === 0) return '';

    return [
      '## Verification failed — fix these issues:',
      ...failed.map(g => `- ${g.description} (failed ${g.attempts}x)`),
      '',
      'Fix the code so these checks pass, then I will re-verify.'
    ].join('\n');
  }
}

// ---------------------------------------------------------------------------
// Helpers (duplicated from autonomous-loop to avoid circular deps)
// ---------------------------------------------------------------------------

function isContextLengthError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes('context length') ||
    lower.includes('too long') ||
    lower.includes('payload size') ||
    lower.includes('context_length_exceeded') ||
    lower.includes('max_tokens') ||
    lower.includes('token limit') ||
    lower.includes('prompt is too long')
  );
}

function compactTurnHistory(history: TurnResult[]): TurnResult[] {
  if (history.length <= 7) return history;
  const first = history.slice(0, 1);
  const tail = history.slice(-5);
  const middle = history.slice(1, history.length - 5);
  if (middle.length === 0) return history;
  const summary: TurnResult = {
    turn: first[0]?.turn ?? 0,
    tool: 'context_compaction',
    params: { compactedTurns: middle.length },
    result: `[Context compacted: ${middle.length} earlier tool results summarized]`
  };
  return [...first, summary, ...tail];
}
