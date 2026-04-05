/**
 * Patch Critic — Per-turn quality evaluation of code changes.
 *
 * After each edit/write tool call, the patch critic evaluates:
 *   - Surgical precision: was the change minimal and targeted?
 *   - Scope discipline: did the change stay within the task scope?
 *   - Read-before-write: was the file read before modification?
 *   - Churn detection: is the agent rewriting the same file repeatedly?
 *   - Pattern quality: does the change follow observed project conventions?
 *
 * The critic produces guidance injected into the next LLM turn,
 * steering the model toward higher-quality changes without blocking.
 *
 * This is a lightweight, deterministic critic — no LLM call needed.
 */

import type { StructuredHistory, FileState } from './structured-history.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CriticSeverity = 'info' | 'warning' | 'error';

export interface CriticFinding {
  severity: CriticSeverity;
  category: CriticCategory;
  message: string;
  file?: string;
  suggestion?: string;
}

export type CriticCategory =
  | 'unread-edit'           // Edited file without reading first
  | 'excessive-churn'       // Same file edited 3+ times
  | 'scope-creep'           // File outside declared scope edited
  | 'large-write'           // Wrote a very large file (possible overwrite)
  | 'missing-verification'  // Made edits but no verification command run
  | 'repeated-pattern'      // Same edit pattern applied multiple times
  | 'overwrite-risk'        // Used write_file on a file that was previously edited
  | 'no-progress'           // Multiple turns with no file changes
  | 'good-practice';        // Positive signal (read-before-write, verification after edit)

export interface CriticReport {
  turn: number;
  findings: CriticFinding[];
  score: number;              // 0-100, higher is better
  guidance: string;           // Formatted text to inject into next LLM turn
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface PatchCriticConfig {
  /** Max edits to same file before warning (default: 3) */
  churnThreshold?: number;
  /** Max lines for a single write_file before warning (default: 500) */
  largeWriteThreshold?: number;
  /** Allowed file paths/patterns for scope checking */
  allowedPaths?: string[];
  /** Turns without file changes before warning (default: 3) */
  noProgressThreshold?: number;
}

// ---------------------------------------------------------------------------
// Patch Critic
// ---------------------------------------------------------------------------

export class PatchCritic {
  private config: Required<PatchCriticConfig>;
  private lastEditTurn = 0;
  private turnsWithoutEdits = 0;
  private editCountByFile = new Map<string, number>();
  private verificationSeen = false;

  constructor(config: PatchCriticConfig = {}) {
    this.config = {
      churnThreshold: config.churnThreshold ?? 3,
      largeWriteThreshold: config.largeWriteThreshold ?? 500,
      allowedPaths: config.allowedPaths ?? [],
      noProgressThreshold: config.noProgressThreshold ?? 3
    };
  }

  /**
   * Evaluate a tool execution and produce findings.
   * Call this after each tool call completes.
   */
  evaluate(
    turn: number,
    tool: string,
    params: Record<string, unknown>,
    result: unknown,
    error: string | undefined,
    history: StructuredHistory
  ): CriticReport {
    const findings: CriticFinding[] = [];
    const filePath = String(params.file_path || params.path || '');

    // ── Check: unread edit ──────────────────────────────────────────
    if (isWriteTool(tool) && filePath) {
      const fileState = history.getFileState(filePath);
      if (!fileState || !fileState.readBeforeWrite) {
        findings.push({
          severity: 'warning',
          category: 'unread-edit',
          message: `Edited ${filePath} without reading it first`,
          file: filePath,
          suggestion: `Read ${filePath} before editing to understand existing content`
        });
      } else {
        // Positive signal
        findings.push({
          severity: 'info',
          category: 'good-practice',
          message: `Good: read ${filePath} before editing`
        });
      }
    }

    // ── Check: excessive churn ──────────────────────────────────────
    if (isWriteTool(tool) && filePath) {
      const count = (this.editCountByFile.get(filePath) || 0) + 1;
      this.editCountByFile.set(filePath, count);
      this.lastEditTurn = turn;
      this.turnsWithoutEdits = 0;

      if (count >= this.config.churnThreshold) {
        findings.push({
          severity: 'warning',
          category: 'excessive-churn',
          message: `${filePath} has been edited ${count} times — consider a single comprehensive edit`,
          file: filePath,
          suggestion: 'Read the full file, plan all changes, then apply once'
        });
      }
    }

    // ── Check: overwrite risk ───────────────────────────────────────
    if (tool === 'write_file' && filePath) {
      const fileState = history.getFileState(filePath);
      if (fileState && fileState.editCount > 0) {
        findings.push({
          severity: 'warning',
          category: 'overwrite-risk',
          message: `write_file on ${filePath} which was previously edited — may overwrite partial changes`,
          file: filePath,
          suggestion: 'Use edit_file for incremental changes to existing files'
        });
      }
    }

    // ── Check: large write ──────────────────────────────────────────
    if (tool === 'write_file' && params.content) {
      const lines = String(params.content).split('\n').length;
      if (lines > this.config.largeWriteThreshold) {
        findings.push({
          severity: 'info',
          category: 'large-write',
          message: `Large file write: ${filePath} (${lines} lines)`,
          file: filePath
        });
      }
    }

    // ── Check: scope creep ─────────────────────────────────────���────
    if (isWriteTool(tool) && filePath && this.config.allowedPaths.length > 0) {
      const inScope = this.config.allowedPaths.some(
        allowed => filePath === allowed || filePath.startsWith(allowed) || filePath.startsWith(`${allowed}/`)
      );
      if (!inScope) {
        findings.push({
          severity: 'error',
          category: 'scope-creep',
          message: `${filePath} is outside the allowed scope`,
          file: filePath,
          suggestion: `Stay within: ${this.config.allowedPaths.join(', ')}`
        });
      }
    }

    // ── Check: verification after edits ─────────────────────────────
    if (isVerificationTool(tool)) {
      this.verificationSeen = true;
      if (!error) {
        findings.push({
          severity: 'info',
          category: 'good-practice',
          message: 'Good: ran verification after changes'
        });
      }
    }

    // ── Check: missing verification ─────────────────────────────────
    if (!isWriteTool(tool) && !isVerificationTool(tool) && !isReadTool(tool)) {
      // Non-edit, non-verify turn
    }
    const totalEdits = [...this.editCountByFile.values()].reduce((a, b) => a + b, 0);
    if (totalEdits >= 3 && !this.verificationSeen) {
      findings.push({
        severity: 'warning',
        category: 'missing-verification',
        message: `${totalEdits} edits made with no verification — run tests or checks`,
        suggestion: 'Run tests, lint, or build to verify your changes are correct'
      });
    }

    // ── Check: no progress ──────────────────────────────────────────
    if (!isWriteTool(tool) && !isReadTool(tool)) {
      this.turnsWithoutEdits++;
    }
    if (this.turnsWithoutEdits >= this.config.noProgressThreshold && totalEdits === 0) {
      findings.push({
        severity: 'warning',
        category: 'no-progress',
        message: `${this.turnsWithoutEdits} turns without any file changes`,
        suggestion: 'Make concrete progress: read a file, plan an edit, execute it'
      });
    }

    // Score
    const score = computeScore(findings);

    // Build guidance
    const guidance = buildGuidance(findings);

    return { turn, findings, score, guidance };
  }

  /**
   * Reset state (for new task or after review cycle).
   */
  reset(): void {
    this.editCountByFile.clear();
    this.verificationSeen = false;
    this.turnsWithoutEdits = 0;
    this.lastEditTurn = 0;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isWriteTool(tool: string): boolean {
  return ['write_file', 'edit_file', 'replace', 'append_file'].includes(tool);
}

function isReadTool(tool: string): boolean {
  return ['read_file', 'read_many_files', 'grep_search', 'glob', 'list_directory'].includes(tool);
}

function isVerificationTool(tool: string): boolean {
  return ['run_shell_command', 'shell', 'check_background_task'].includes(tool);
}

function computeScore(findings: CriticFinding[]): number {
  let score = 100;
  for (const f of findings) {
    if (f.severity === 'error') score -= 25;
    else if (f.severity === 'warning') score -= 10;
    else if (f.category === 'good-practice') score += 5;
  }
  return Math.max(0, Math.min(100, score));
}

function buildGuidance(findings: CriticFinding[]): string {
  const actionable = findings.filter(f => f.severity !== 'info' && f.suggestion);
  if (actionable.length === 0) return '';

  const lines = actionable.map(f =>
    `- [${f.severity.toUpperCase()}] ${f.message}${f.suggestion ? `\n  → ${f.suggestion}` : ''}`
  );

  return `## Patch quality feedback:\n${lines.join('\n')}`;
}
