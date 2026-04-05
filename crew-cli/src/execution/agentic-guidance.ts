import type { TurnResult } from '../worker/autonomous-loop.js';

export type TaskMode = 'bugfix' | 'feature' | 'refactor' | 'test_repair' | 'analysis';

const READ_TOOLS = new Set(['read_file', 'read_many_files', 'glob', 'grep_search', 'list_directory', 'lsp']);
const EDIT_TOOLS = new Set(['replace', 'edit', 'append_file', 'write_file', 'notebook_edit']);
const VERIFY_TOOLS = new Set(['run_shell_command', 'shell', 'run_cmd', 'check_background_task']);

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function extractTarget(params: Record<string, unknown>): string | undefined {
  const candidate = params.file_path
    ?? params.path
    ?? params.include
    ?? params.pattern
    ?? params.command;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
}

function isReadTool(result: TurnResult): boolean {
  return READ_TOOLS.has(result.tool);
}

function isEditTool(result: TurnResult): boolean {
  return EDIT_TOOLS.has(result.tool);
}

function isVerificationTool(result: TurnResult): boolean {
  return VERIFY_TOOLS.has(result.tool);
}

function isSuccessfulVerification(result: TurnResult): boolean {
  if (!isVerificationTool(result) || result.error) return false;
  const output = typeof result.result === 'string'
    ? result.result
    : JSON.stringify(result.result ?? '');
  const normalized = normalizeText(output);
  return !normalized.includes('error') && !normalized.includes('failed');
}

function unreadEditTargets(history: TurnResult[]): string[] {
  const reads = new Set(
    history
      .filter(r => !r.error && isReadTool(r))
      .map(r => extractTarget(r.params))
      .filter((value): value is string => Boolean(value))
  );

  return history
    .filter(r => !r.error && isEditTool(r))
    .map(r => extractTarget(r.params))
    .filter((value): value is string => Boolean(value))
    .filter(target => !reads.has(target));
}

function repeatedFailure(history: TurnResult[]): string | undefined {
  const recentFailures = history
    .slice(-6)
    .filter(r => Boolean(r.error))
    .map(r => `${r.tool}:${JSON.stringify(r.params)}`);
  if (recentFailures.length < 2) return undefined;
  const counts = new Map<string, number>();
  for (const signature of recentFailures) {
    counts.set(signature, (counts.get(signature) || 0) + 1);
  }
  const repeated = [...counts.entries()].find(([, count]) => count >= 2);
  return repeated?.[0];
}

export function detectTaskMode(task: string): TaskMode {
  const normalized = normalizeText(task);
  if (/(failing tests?|test failure|fix tests?|fix the test|make tests? pass|regression test|unit test|test.*(fail|broken|error))/.test(normalized)) {
    return 'test_repair';
  }
  if (/(fix|bug|broken|error|regression|crash|issue|failure)/.test(normalized)) {
    return 'bugfix';
  }
  if (/(refactor|cleanup|restructure|rename|simplify|extract)/.test(normalized)) {
    return 'refactor';
  }
  if (/(add|implement|create|build|support|introduce)/.test(normalized)) {
    return 'feature';
  }
  return 'analysis';
}

export function buildTaskModeGuidance(mode: TaskMode): string {
  const strategyByMode: Record<TaskMode, string> = {
    bugfix: 'Task mode: bugfix. Reproduce the failure with the smallest useful signal, make the narrowest fix, then run the most targeted verification command before stopping.',
    feature: 'Task mode: feature. Read the affected files first, implement the smallest complete change that satisfies the request, then verify the touched path with focused checks.',
    refactor: 'Task mode: refactor. Preserve behavior, prefer small surgical edits, and run typecheck or the narrowest affected tests before finishing.',
    test_repair: 'Task mode: test repair. Start from the failing test signal, change only what explains the failure, and rerun the targeted test before broader verification.',
    analysis: 'Task mode: analysis. Gather only the context needed for the task, avoid speculative edits, and verify any code changes with the smallest useful command.'
  };
  return strategyByMode[mode];
}

export function buildTurnGuidance(
  mode: TaskMode,
  history: TurnResult[],
  turnResults: TurnResult[]
): string | undefined {
  const messages: string[] = [];
  const editedThisTurn = turnResults.some(r => !r.error && isEditTool(r));
  const verifiedAtLeastOnce = history.some(isSuccessfulVerification);

  const unreadTargets = unreadEditTargets(history);
  if (unreadTargets.length > 0) {
    messages.push(`Read before editing on the next step. Re-open the exact file section for: ${[...new Set(unreadTargets)].slice(0, 3).join(', ')}.`);
  }

  if (editedThisTurn && !verifiedAtLeastOnce) {
    const verificationHint = mode === 'test_repair'
      ? 'Run the failing test or the narrowest related test command before more edits.'
      : mode === 'refactor'
        ? 'Run typecheck or the narrowest affected test before declaring the refactor done.'
        : 'Run the smallest useful verification command before finishing.';
    messages.push(verificationHint);
  }

  const repeated = repeatedFailure(history);
  if (repeated) {
    messages.push(`Do not repeat the same failing action again: ${repeated.slice(0, 120)}. Switch tactics or inspect a narrower target.`);
  }

  return messages.length > 0
    ? `Execution guidance:\n- ${messages.join('\n- ')}`
    : undefined;
}
