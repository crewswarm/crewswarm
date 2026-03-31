/**
 * Deterministic QA Gate — mechanical validation from execution transcript.
 *
 * Runs BEFORE any LLM-based QA. If these checks fail, no LLM review needed.
 * If all pass, optional LLM review can run for semantic quality checks.
 */

import type { ExecutionTranscript } from './transcript.js';

export interface QACheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface QAGateResult {
  passed: boolean;
  checks: QACheck[];
  summary: string;
}

/**
 * Run deterministic QA checks against an execution transcript.
 */
export function runDeterministicQA(
  transcript: ExecutionTranscript,
  options: {
    maxTurns?: number;
    requireFileChanges?: boolean;
  } = {}
): QAGateResult {
  const checks: QACheck[] = [];

  // 1. All edited files were read first?
  const unreadEdits = transcript.unreadEdits;
  checks.push({
    name: 'read-before-edit',
    passed: unreadEdits.length === 0,
    detail: unreadEdits.length > 0
      ? `Files edited without prior read: ${unreadEdits.join(', ')}`
      : undefined
  });

  // 2. No file overwrites (write_file should only create new files)?
  const editedFiles = transcript.filesEdited;
  const writtenFiles = transcript.filesWritten;
  const overwrites = [...writtenFiles].filter(f => editedFiles.has(f));
  checks.push({
    name: 'no-overwrites',
    passed: overwrites.length === 0,
    detail: overwrites.length > 0
      ? `Files both written and edited (possible overwrite): ${overwrites.join(', ')}`
      : undefined
  });

  // 3. Shell commands succeeded?
  const failedShell = transcript.failedShellCommands;
  checks.push({
    name: 'shell-success',
    passed: failedShell.length === 0,
    detail: failedShell.length > 0
      ? `${failedShell.length} shell command(s) failed: ${failedShell.map(e => e.params.command || '?').join('; ').slice(0, 200)}`
      : undefined
  });

  // 4. Worker stayed within turn/token budget?
  const maxTurns = options.maxTurns ?? 25;
  const toolCallCount = transcript.length;
  // Rough heuristic: each turn might have 1-3 tool calls, so budget is ~3x maxTurns
  const toolBudget = maxTurns * 3;
  checks.push({
    name: 'within-budget',
    passed: toolCallCount <= toolBudget,
    detail: toolCallCount > toolBudget
      ? `${toolCallCount} tool calls exceeds budget of ${toolBudget} (${maxTurns} turns × 3)`
      : undefined
  });

  // 5. Files actually changed on disk?
  if (options.requireFileChanges !== false) {
    const anyFileChanges = transcript.filesEdited.size > 0 || transcript.filesWritten.size > 0;
    checks.push({
      name: 'files-changed',
      passed: anyFileChanges,
      detail: !anyFileChanges
        ? 'No file edits or writes recorded in transcript'
        : undefined
    });
  }

  // 6. No unhandled errors?
  const unhandledErrors = transcript.entries.filter(e => !e.success && e.handled === false);
  checks.push({
    name: 'no-unhandled-errors',
    passed: unhandledErrors.length === 0,
    detail: unhandledErrors.length > 0
      ? `${unhandledErrors.length} unhandled error(s): ${unhandledErrors.map(e => e.error || '?').join('; ').slice(0, 200)}`
      : undefined
  });

  // 7. No repeated identical failing tool calls (stuck loop)?
  const failedSignatures = transcript.entries
    .filter(e => !e.success)
    .map(e => `${e.toolName}:${JSON.stringify(e.params)}`);
  const failedCounts = new Map<string, number>();
  for (const sig of failedSignatures) {
    failedCounts.set(sig, (failedCounts.get(sig) || 0) + 1);
  }
  const stuckLoops = [...failedCounts.entries()].filter(([, count]) => count >= 3);
  checks.push({
    name: 'no-stuck-loops',
    passed: stuckLoops.length === 0,
    detail: stuckLoops.length > 0
      ? `Repeated failing tool calls detected (stuck loop): ${stuckLoops.map(([sig]) => sig.slice(0, 80)).join('; ')}`
      : undefined
  });

  const passed = checks.every(c => c.passed);
  const failed = checks.filter(c => !c.passed);
  const summary = passed
    ? `All ${checks.length} QA checks passed`
    : `${failed.length}/${checks.length} QA checks failed: ${failed.map(c => c.name).join(', ')}`;

  return { passed, checks, summary };
}
