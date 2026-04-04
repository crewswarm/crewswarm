/**
 * Post-Sampling Hooks — Feature 5
 *
 * After each LLM response and tool execution, run registered hook functions
 * that can inspect results and trigger actions (continue, stop, or retry).
 *
 * Built-in hooks:
 *  - lintCheckHook: after file writes, run a quick lint check and surface errors
 *  - autoCommitHook: auto-stage modified files for review (no commit)
 *  - fileSizeGuardHook: warn when written files are suspiciously large (>100KB)
 */

import { stat } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import type { ToolCall, TurnResult } from '../worker/autonomous-loop.js';

const execAsync = promisify(exec);

// ─── Public types ──────────────────────────────────────────────────────

export type HookContext = {
  turn: number;
  response: string;
  toolCalls: ToolCall[];
  toolResults: TurnResult[];
  history: TurnResult[];
  projectDir: string;
};

export type HookAction = {
  action: 'continue' | 'stop' | 'retry';
  message?: string;
};

export type PostSamplingHook = (ctx: HookContext) => Promise<HookAction | void>;

// ─── Built-in hooks ────────────────────────────────────────────────────

/**
 * After file writes, run a quick lint check.
 * If lint errors are found, return a 'continue' action with the error
 * text appended to the next turn's context so the agent can fix them.
 */
export const lintCheckHook: PostSamplingHook = async (ctx) => {
  // Find all file-write tool results in this turn
  const writtenFiles = ctx.toolResults
    .filter(r => r.turn === ctx.turn && (r.tool === 'write_file' || r.tool === 'create_file' || r.tool === 'str_replace'))
    .map(r => (r.params?.path || r.params?.file_path || '') as string)
    .filter(Boolean);

  if (writtenFiles.length === 0) return;

  // Prefer project-local eslint, then fallback to npx
  const lintCmd = `cd "${ctx.projectDir}" && npx --no eslint --no-eslintrc --rule '{}' ${writtenFiles.map(f => `"${f}"`).join(' ')} 2>&1 || true`;

  try {
    const { stdout } = await execAsync(lintCmd, { timeout: 10_000 });
    const output = stdout.trim();
    // Only surface real errors (not the "0 problems" line)
    if (output && !output.includes('0 problems') && output.length > 0) {
      return {
        action: 'continue',
        message: `Lint check found issues in written files:\n${output.slice(0, 1000)}`
      };
    }
  } catch {
    // Lint tool not available or failed — silently skip
  }
};

/**
 * After successful tool executions that modified files, auto-stage
 * those changes for review. Does not commit.
 */
export const autoCommitHook: PostSamplingHook = async (ctx) => {
  // Only stage if there were successful tool results this turn
  const successfulResults = ctx.toolResults.filter(
    r => r.turn === ctx.turn && !r.error
  );

  if (successfulResults.length === 0) return;

  // Check if this is a git repo
  try {
    await execAsync(`git -C "${ctx.projectDir}" rev-parse --is-inside-work-tree`, { timeout: 5_000 });
  } catch {
    return; // Not a git repo — skip
  }

  // Stage all modified tracked files
  try {
    await execAsync(`git -C "${ctx.projectDir}" add -u`, { timeout: 10_000 });
  } catch {
    // Staging failed silently — non-critical
  }
};

/**
 * Check if any files written this turn are suspiciously large (>100KB).
 * Warn the agent so it can review before continuing.
 */
export const fileSizeGuardHook: PostSamplingHook = async (ctx) => {
  const SIZE_LIMIT_BYTES = 100 * 1024; // 100 KB

  const writtenFiles = ctx.toolResults
    .filter(r => r.turn === ctx.turn && !r.error && (r.tool === 'write_file' || r.tool === 'create_file'))
    .map(r => (r.params?.path || r.params?.file_path || '') as string)
    .filter(Boolean);

  if (writtenFiles.length === 0) return;

  const oversized: string[] = [];

  for (const filePath of writtenFiles) {
    try {
      const info = await stat(filePath);
      if (info.size > SIZE_LIMIT_BYTES) {
        oversized.push(`${filePath} (${(info.size / 1024).toFixed(1)} KB)`);
      }
    } catch {
      // File may not exist yet — skip
    }
  }

  if (oversized.length > 0) {
    return {
      action: 'continue',
      message: `Warning: the following files written this turn are unusually large and should be reviewed:\n${oversized.join('\n')}`
    };
  }
};

// ─── Hook runner ───────────────────────────────────────────────────────

/**
 * Run all registered post-sampling hooks sequentially.
 *
 * Returns:
 *  - The first non-void result with action 'stop' or 'retry' if any hook
 *    triggers one of those actions.
 *  - All 'continue' messages collected into a single combined message.
 *  - If no hook triggers stop/retry, returns { action: 'continue', message? }
 */
export async function runPostSamplingHooks(
  hooks: PostSamplingHook[],
  ctx: HookContext
): Promise<HookAction> {
  const continueMessages: string[] = [];

  for (const hook of hooks) {
    let result: HookAction | void;
    try {
      result = await hook(ctx);
    } catch {
      // Individual hook errors should not crash the loop
      continue;
    }

    if (!result) continue;

    if (result.action === 'stop' || result.action === 'retry') {
      return result;
    }

    if (result.action === 'continue' && result.message) {
      continueMessages.push(result.message);
    }
  }

  return {
    action: 'continue',
    message: continueMessages.length > 0 ? continueMessages.join('\n\n') : undefined
  };
}
