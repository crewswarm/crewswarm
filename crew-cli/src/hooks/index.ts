/**
 * crewswarm Hook System
 *
 * Hooks allow users to run shell commands before/after tool execution.
 * Configuration lives in .crew/hooks.json or CREW_HOOKS_FILE env var.
 *
 * Hook commands receive tool input as JSON on stdin and can:
 * - PreToolUse: allow/deny/modify tool execution
 * - PostToolUse: log, alert, or transform results
 *
 * Example .crew/hooks.json:
 * {
 *   "hooks": {
 *     "PreToolUse": [
 *       { "matcher": "shell|run_cmd", "command": "node .crew/validate-shell.js", "timeout": 5000 }
 *     ],
 *     "PostToolUse": [
 *       { "matcher": ".*", "command": "node .crew/log-tool.js", "timeout": 3000 }
 *     ]
 *   }
 * }
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type HookEvent = 'PreToolUse' | 'PostToolUse';

export interface HookDefinition {
  matcher: string;       // Regex pattern to match tool names
  command: string;       // Shell command to execute
  timeout?: number;      // Timeout in ms (default 10000)
}

export interface HookConfig {
  hooks: Partial<Record<HookEvent, HookDefinition[]>>;
}

export interface PreToolUseResult {
  decision: 'allow' | 'deny' | 'ask';
  reason?: string;
  updatedInput?: Record<string, any>;
}

export interface PostToolUseResult {
  message?: string;
}

interface HookOutput {
  permissionDecision?: 'allow' | 'deny' | 'ask';
  permissionDecisionReason?: string;
  updatedInput?: Record<string, any>;
  message?: string;
}

let cachedConfig: HookConfig | null = null;
let configPath: string | null = null;

function getConfigPath(baseDir: string = process.cwd()): string {
  return process.env.CREW_HOOKS_FILE || join(baseDir, '.crew', 'hooks.json');
}

export async function loadHookConfig(baseDir?: string): Promise<HookConfig> {
  const path = getConfigPath(baseDir);
  if (cachedConfig && configPath === path) return cachedConfig;

  if (!existsSync(path)) {
    cachedConfig = { hooks: {} };
    configPath = path;
    return cachedConfig;
  }

  try {
    const raw = await readFile(path, 'utf8');
    cachedConfig = JSON.parse(raw) as HookConfig;
    configPath = path;
    return cachedConfig;
  } catch {
    cachedConfig = { hooks: {} };
    configPath = path;
    return cachedConfig;
  }
}

/** Clear cached config (for testing or after config changes) */
export function clearHookCache(): void {
  cachedConfig = null;
  configPath = null;
}

function matchesHook(toolName: string, hook: HookDefinition): boolean {
  try {
    return new RegExp(hook.matcher).test(toolName);
  } catch {
    return false;
  }
}

async function executeHookCommand(
  command: string,
  stdinData: string,
  timeoutMs: number
): Promise<HookOutput> {
  return new Promise((resolve) => {
    const proc = spawn('sh', ['-c', command], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('error', () => {
      resolve({});
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        // Non-zero exit = deny for PreToolUse
        resolve({
          permissionDecision: 'deny',
          permissionDecisionReason: stderr.trim() || `Hook exited with code ${code}`
        });
        return;
      }

      // Try to parse JSON output from hook
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(parsed);
      } catch {
        // No JSON output = passthrough (allow)
        resolve({ message: stdout.trim() || undefined });
      }
    });

    // Pipe tool input as JSON on stdin
    proc.stdin.write(stdinData);
    proc.stdin.end();
  });
}

/**
 * Run PreToolUse hooks for a tool call.
 * Returns the decision and optionally modified input.
 */
export async function runPreToolUseHooks(
  toolName: string,
  toolInput: Record<string, any>,
  baseDir?: string
): Promise<PreToolUseResult> {
  const config = await loadHookConfig(baseDir);
  const hooks = config.hooks.PreToolUse || [];

  for (const hook of hooks) {
    if (!matchesHook(toolName, hook)) continue;

    const stdinData = JSON.stringify({ tool: toolName, input: toolInput });
    const result = await executeHookCommand(hook.command, stdinData, hook.timeout || 10000);

    if (result.permissionDecision === 'deny') {
      return {
        decision: 'deny',
        reason: result.permissionDecisionReason || 'Denied by PreToolUse hook'
      };
    }

    if (result.permissionDecision === 'ask') {
      return {
        decision: 'ask',
        reason: result.permissionDecisionReason
      };
    }

    // Hook can modify input
    if (result.updatedInput) {
      return { decision: 'allow', updatedInput: result.updatedInput };
    }
  }

  return { decision: 'allow' };
}

/**
 * Run PostToolUse hooks for a tool call.
 */
export async function runPostToolUseHooks(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOutput: unknown,
  baseDir?: string
): Promise<PostToolUseResult> {
  const config = await loadHookConfig(baseDir);
  const hooks = config.hooks.PostToolUse || [];

  for (const hook of hooks) {
    if (!matchesHook(toolName, hook)) continue;

    const stdinData = JSON.stringify({ tool: toolName, input: toolInput, output: toolOutput });
    const result = await executeHookCommand(hook.command, stdinData, hook.timeout || 10000);

    if (result.message) {
      return { message: result.message };
    }
  }

  return {};
}
