/**
 * Autonomous Worker Loop
 * Implements OpenOrca-style THINK → ACT → OBSERVE pattern
 * 
 * @license
 * Copyright 2026 CrewSwarm
 */

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
}

export interface AutonomousConfig {
  maxTurns?: number;
  repeatThreshold?: number;
  tools: any[];
  onProgress?: (turn: number, action: string) => void;
}

const DEFAULT_MAX_TURNS = 25;
const DEFAULT_REPEAT_THRESHOLD = 10;

/**
 * Execute task autonomously with up to MAX_TURNS iterations
 */
export async function executeAutonomous(
  task: string,
  executeLLM: (prompt: string, tools: any[], history: TurnResult[]) => Promise<{ toolCalls?: ToolCall[]; response: string; status?: string }>,
  executeTool: (tool: string, params: Record<string, any>) => Promise<any>,
  config: AutonomousConfig
): Promise<AutonomousResult> {
  const maxTurns = config.maxTurns || DEFAULT_MAX_TURNS;
  const repeatThreshold = config.repeatThreshold || DEFAULT_REPEAT_THRESHOLD;
  const history: TurnResult[] = [];

  let lastResponseText = '';
  let staleCount = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    config.onProgress?.(turn + 1, 'THINKING');

    // THINK: LLM decides next action
    const response = await executeLLM(task, config.tools, history);

    // Check if task is complete
    if (response.status === 'COMPLETE' || !response.toolCalls || response.toolCalls.length === 0) {
      return {
        success: true,
        turns: turn + 1,
        history,
        finalResponse: response.response
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
            reason: 'Detected stale response (same output repeated), treating as complete'
          };
        }
      } else {
        staleCount = 0;
      }
      lastResponseText = response.response;
    }

    // ACT: Execute all tool calls
    for (const call of response.toolCalls) {
      config.onProgress?.(turn + 1, `EXECUTING: ${call.tool}`);

      try {
        const result = await executeTool(call.tool, call.params);

        // OBSERVE: Add to history
        history.push({
          turn: turn + 1,
          tool: call.tool,
          params: call.params,
          result
        });
      } catch (error: any) {
        history.push({
          turn: turn + 1,
          tool: call.tool,
          params: call.params,
          result: null,
          error: error.message
        });
      }
    }

    // Safety check: Detect if stuck in a loop
    if (turn > repeatThreshold && isRepeating(history, 3)) {
      return {
        success: false,
        turns: turn + 1,
        history,
        reason: 'Detected repeated actions, stopping to prevent infinite loop'
      };
    }
  }

  return {
    success: false,
    turns: maxTurns,
    history,
    reason: 'Maximum turns exceeded without completing task'
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
