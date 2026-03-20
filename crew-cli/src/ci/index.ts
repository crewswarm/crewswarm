// @ts-nocheck
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentRouter } from '../agent/router.js';
import { Orchestrator } from '../orchestrator/index.js';
import { Sandbox } from '../sandbox/index.js';
import { SessionManager } from '../session/manager.js';

const execAsync = promisify(exec);

export interface CheckRunResult {
  success: boolean;
  command: string;
  stdout: string;
  stderr: string;
}

export async function runCheckCommand(command: string, cwd = process.cwd()): Promise<CheckRunResult> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      maxBuffer: 1024 * 1024 * 4
    });
    return {
      success: true,
      command,
      stdout: String(stdout || ''),
      stderr: String(stderr || '')
    };
  } catch (error) {
    return {
      success: false,
      command,
      stdout: String(error?.stdout || ''),
      stderr: String(error?.stderr || error?.message || '')
    };
  }
}

export interface CiFixOptions {
  command: string;
  maxAttempts: number;
  cwd?: string;
  router: AgentRouter;
  orchestrator: Orchestrator;
  sandbox: Sandbox;
  session: SessionManager;
}

export async function runCiFixLoop(options: CiFixOptions) {
  const cwd = options.cwd || process.cwd();
  const attempts = Math.max(1, options.maxAttempts || 3);
  const runHistory: Array<{ attempt: number; success: boolean; stderr: string }> = [];

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const checkResult = await runCheckCommand(options.command, cwd);
    runHistory.push({
      attempt,
      success: checkResult.success,
      stderr: checkResult.stderr
    });

    if (checkResult.success) {
      return {
        success: true,
        attemptsUsed: attempt,
        history: runHistory
      };
    }

    const task = [
      `CI check failed on attempt ${attempt}/${attempts}.`,
      `Command: ${options.command}`,
      'Please return concrete file edits in FILE: path + SEARCH/REPLACE or full content blocks.',
      '',
      'STDOUT:',
      checkResult.stdout.slice(0, 6000),
      '',
      'STDERR:',
      checkResult.stderr.slice(0, 6000)
    ].join('\n');

    const fixResult = await options.router.dispatch('crew-fixer', task, {
      sessionId: await options.session.getSessionId(),
      project: cwd
    });

    await options.orchestrator.parseAndApplyToSandbox(String(fixResult.result || ''));
    if (options.sandbox.hasChanges()) {
      await options.sandbox.apply();
    }
  }

  return {
    success: false,
    attemptsUsed: attempts,
    history: runHistory
  };
}
