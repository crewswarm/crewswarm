/**
 * Action Ranking — Real-time next-action scorer for the execution loop.
 *
 * Each turn, scores candidate action types based on execution state:
 * what's been read, edited, verified, what failed, and the task mode.
 * Returns ranked suggestions injected into the LLM prompt to steer
 * behavior toward the highest-value next step.
 */

import type { TurnResult } from '../worker/autonomous-loop.js';
import type { TaskMode } from './agentic-guidance.js';

// ---------------------------------------------------------------------------
// Action types
// ---------------------------------------------------------------------------

export type ActionType =
  | 'read'       // read/inspect a file
  | 'search'     // grep/glob/find
  | 'edit'       // write/replace/append
  | 'test'       // run tests
  | 'build'      // compile/typecheck/lint
  | 'verify'     // any verification command
  | 'delegate';  // sub-agent dispatch

export interface ActionScore {
  action: ActionType;
  score: number;      // 0–1, higher = more valuable right now
  reason: string;     // human-readable explanation for the LLM
}

// ---------------------------------------------------------------------------
// Tool classification
// ---------------------------------------------------------------------------

const READ_TOOLS = new Set([
  'read_file', 'read_many_files', 'glob', 'list_directory', 'lsp'
]);
const SEARCH_TOOLS = new Set([
  'grep_search', 'glob', 'search_files', 'find_definition'
]);
const EDIT_TOOLS = new Set([
  'replace', 'edit', 'append_file', 'write_file', 'notebook_edit'
]);
const SHELL_TOOLS = new Set([
  'run_shell_command', 'shell', 'run_cmd', 'check_background_task'
]);

function classifyTool(tool: string): ActionType | null {
  if (READ_TOOLS.has(tool)) return 'read';
  if (SEARCH_TOOLS.has(tool)) return 'search';
  if (EDIT_TOOLS.has(tool)) return 'edit';
  if (SHELL_TOOLS.has(tool)) return isTestCommand(tool) ? 'test' : 'verify';
  return null;
}

function isTestCommand(command: string): boolean {
  const lower = command.toLowerCase();
  return /\b(test|spec|jest|vitest|pytest|mocha)\b/.test(lower);
}

function isBuildCommand(command: string): boolean {
  const lower = command.toLowerCase();
  return /\b(build|tsc|typecheck|lint|eslint)\b/.test(lower);
}

function extractTarget(params: Record<string, unknown>): string | undefined {
  const candidate = params.file_path ?? params.path ?? params.include ?? params.pattern ?? params.command;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
}

// ---------------------------------------------------------------------------
// State analysis
// ---------------------------------------------------------------------------

interface ExecutionSnapshot {
  filesRead: Set<string>;
  filesEdited: Set<string>;
  unverifiedEdits: Set<string>;   // edited but no test/build since
  hasRunTests: boolean;
  hasRunBuild: boolean;
  recentFailureTools: Set<string>;
  totalTurns: number;
  editTurns: number;              // turns that contained edits
  lastActionType: ActionType | null;
  consecutiveSameAction: number;
}

function analyzeHistory(history: TurnResult[]): ExecutionSnapshot {
  const filesRead = new Set<string>();
  const filesEdited = new Set<string>();
  const unverifiedEdits = new Set<string>();
  let hasRunTests = false;
  let hasRunBuild = false;
  const recentFailureTools = new Set<string>();
  let editTurns = 0;
  let lastActionType: ActionType | null = null;
  let consecutiveSameAction = 0;

  let lastTurnHadEdit = false;

  for (const turn of history) {
    const actionType = classifyTool(turn.tool);

    // Track consecutive same-action
    if (actionType === lastActionType) {
      consecutiveSameAction++;
    } else {
      consecutiveSameAction = 1;
      lastActionType = actionType;
    }

    // Read tracking
    if (READ_TOOLS.has(turn.tool) && !turn.error) {
      const target = extractTarget(turn.params);
      if (target) filesRead.add(target);
    }

    // Edit tracking
    if (EDIT_TOOLS.has(turn.tool) && !turn.error) {
      const target = extractTarget(turn.params);
      if (target) {
        filesEdited.add(target);
        unverifiedEdits.add(target);
      }
      if (!lastTurnHadEdit) {
        editTurns++;
        lastTurnHadEdit = true;
      }
    } else {
      lastTurnHadEdit = false;
    }

    // Shell command analysis
    if (SHELL_TOOLS.has(turn.tool)) {
      const cmd = String(turn.params.command || '');
      if (isTestCommand(cmd) && !turn.error) {
        hasRunTests = true;
        unverifiedEdits.clear(); // tests cover all edits
      }
      if (isBuildCommand(cmd) && !turn.error) {
        hasRunBuild = true;
      }
    }

    // Recent failures (last 5 turns)
    if (turn.error) {
      recentFailureTools.add(turn.tool);
    }
  }

  // Only keep recent failures (last 5)
  const recentHistory = history.slice(-5);
  recentFailureTools.clear();
  for (const turn of recentHistory) {
    if (turn.error) recentFailureTools.add(turn.tool);
  }

  return {
    filesRead,
    filesEdited,
    unverifiedEdits,
    hasRunTests,
    hasRunBuild,
    recentFailureTools,
    totalTurns: history.length,
    editTurns,
    lastActionType,
    consecutiveSameAction
  };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Mode-specific base weights for action types. */
const DEFAULT_MODE_WEIGHTS: Record<TaskMode, Record<ActionType, number>> = {
  bugfix: {
    read: 0.3, search: 0.3, edit: 0.2, test: 0.8, build: 0.3, verify: 0.7, delegate: 0.1
  },
  feature: {
    read: 0.5, search: 0.3, edit: 0.4, test: 0.6, build: 0.4, verify: 0.5, delegate: 0.2
  },
  refactor: {
    read: 0.4, search: 0.2, edit: 0.3, test: 0.5, build: 0.7, verify: 0.6, delegate: 0.1
  },
  test_repair: {
    read: 0.4, search: 0.2, edit: 0.3, test: 0.9, build: 0.2, verify: 0.4, delegate: 0.1
  },
  analysis: {
    read: 0.7, search: 0.6, edit: 0.1, test: 0.2, build: 0.1, verify: 0.2, delegate: 0.3
  }
};

// ---------------------------------------------------------------------------
// Adaptive weights — learn from autoharness trajectory scores
// ---------------------------------------------------------------------------

/** Trajectory feedback from past runs, keyed by task mode */
export interface TrajectoryFeedback {
  mode: TaskMode;
  score: number;           // 0–1 trajectory score
  toolDistribution: Record<ActionType, number>;  // fraction of actions per type
  success: boolean;
}

/**
 * Compute adjusted weights from historical trajectory feedback.
 * High-scoring runs boost the weights of their dominant action types.
 * Low-scoring runs penalize theirs.
 */
export function computeAdaptiveWeights(
  feedback: TrajectoryFeedback[],
  baseWeights: Record<TaskMode, Record<ActionType, number>> = DEFAULT_MODE_WEIGHTS
): Record<TaskMode, Record<ActionType, number>> {
  if (feedback.length === 0) return baseWeights;

  const result: Record<string, Record<string, number>> = {};
  for (const [mode, weights] of Object.entries(baseWeights)) {
    result[mode] = { ...weights };
  }

  // Group feedback by mode
  const byMode = new Map<string, TrajectoryFeedback[]>();
  for (const f of feedback) {
    const arr = byMode.get(f.mode) || [];
    arr.push(f);
    byMode.set(f.mode, arr);
  }

  for (const [mode, runs] of byMode) {
    if (!result[mode] || runs.length < 3) continue; // need enough signal

    const weights = result[mode];
    const LEARNING_RATE = 0.1;

    for (const run of runs) {
      // Score deviation from 0.5 midpoint — positive means good run, negative means bad
      const signal = (run.score - 0.5) * (run.success ? 1 : -0.5);

      for (const [action, fraction] of Object.entries(run.toolDistribution)) {
        if (action in weights && fraction > 0.05) {
          // Boost weights for actions that dominated high-scoring runs,
          // penalize weights for actions that dominated low-scoring runs
          weights[action] = Math.max(0.05, Math.min(0.95,
            weights[action] + signal * fraction * LEARNING_RATE
          ));
        }
      }
    }
  }

  return result as Record<TaskMode, Record<ActionType, number>>;
}

// Active weights — starts as defaults, updated by loadAdaptiveWeights()
let MODE_WEIGHTS: Record<TaskMode, Record<ActionType, number>> = { ...DEFAULT_MODE_WEIGHTS };

/**
 * Load adaptive weights from autoharness trajectory data.
 * Call once at startup or periodically to refresh.
 */
export function loadAdaptiveWeights(feedback: TrajectoryFeedback[]): void {
  MODE_WEIGHTS = computeAdaptiveWeights(feedback, DEFAULT_MODE_WEIGHTS);
}

/** Get the current active weights (default or adaptive) */
export function getActiveWeights(): Record<TaskMode, Record<ActionType, number>> {
  return MODE_WEIGHTS;
}

/**
 * Score all action types for the current turn.
 * Returns sorted (highest first) with reasons.
 */
export function rankActions(
  history: TurnResult[],
  taskMode: TaskMode
): ActionScore[] {
  const snap = analyzeHistory(history);
  const baseWeights = MODE_WEIGHTS[taskMode];
  const scores: ActionScore[] = [];

  for (const action of Object.keys(baseWeights) as ActionType[]) {
    let score = baseWeights[action];
    let reason = '';

    // ── Contextual adjustments ──────────────────────────────────────

    // Boost read if we've edited files we haven't read
    if (action === 'read') {
      const unreadEdits = [...snap.filesEdited].filter(f => !snap.filesRead.has(f));
      if (unreadEdits.length > 0) {
        score += 0.3;
        reason = `${unreadEdits.length} edited file(s) not yet read — read before more edits`;
      } else if (snap.filesRead.size === 0 && snap.totalTurns < 3) {
        score += 0.2;
        reason = 'No files read yet — understand context first';
      }
    }

    // Boost search early in the task
    if (action === 'search') {
      if (snap.totalTurns < 4 && snap.filesRead.size < 2) {
        score += 0.15;
        reason = 'Early in task — search to locate relevant code';
      }
    }

    // Penalize edit if nothing has been read
    if (action === 'edit') {
      if (snap.filesRead.size === 0) {
        score -= 0.3;
        reason = 'Nothing read yet — read first before editing';
      } else if (snap.unverifiedEdits.size > 2) {
        score -= 0.2;
        reason = 'Multiple unverified edits — verify before more changes';
      }
    }

    // Boost test/verify if there are unverified edits
    if (action === 'test' || action === 'verify') {
      if (snap.unverifiedEdits.size > 0) {
        score += 0.35;
        reason = reason || `${snap.unverifiedEdits.size} unverified edit(s) — run verification`;
      }
      if (snap.editTurns > 0 && !snap.hasRunTests && action === 'test') {
        score += 0.25;
        reason = reason || 'Edits made but no tests run yet';
      }
    }

    // Boost build/typecheck for refactors
    if (action === 'build' && taskMode === 'refactor') {
      if (snap.filesEdited.size > 0 && !snap.hasRunBuild) {
        score += 0.3;
        reason = 'Refactor edits need typecheck/build verification';
      }
    }

    // Penalize consecutive same action (diminishing returns)
    if (action === snap.lastActionType && snap.consecutiveSameAction >= 2) {
      const penalty = Math.min(0.4, snap.consecutiveSameAction * 0.1);
      score -= penalty;
      reason = reason || `${snap.consecutiveSameAction} consecutive ${action} actions — switch tactics`;
    }

    // Penalize recently-failed tool types (strong penalty — don't retry what just broke)
    if (snap.recentFailureTools.size > 0) {
      const failedActionTypes = new Set<ActionType>();
      for (const tool of snap.recentFailureTools) {
        const at = classifyTool(tool);
        if (at) failedActionTypes.add(at);
      }
      if (failedActionTypes.has(action)) {
        score -= 0.35;
        reason = `DO NOT retry ${action} — recent failures. Try a completely different approach`;
      }
    }

    scores.push({
      action,
      score: Math.max(0, Math.min(1, score)),
      reason
    });
  }

  // Sort descending by score
  scores.sort((a, b) => b.score - a.score);
  return scores;
}

/**
 * Build a prompt-injectable action ranking summary.
 * Only includes the top recommendations (score > threshold).
 */
export function buildActionRankingPrompt(
  history: TurnResult[],
  taskMode: TaskMode,
  threshold = 0.4
): string {
  const ranked = rankActions(history, taskMode);
  const top = ranked.filter(r => r.score >= threshold).slice(0, 3);

  if (top.length === 0) return '';

  // Also surface any strong warnings (score near 0)
  const warnings = ranked.filter(r => r.score < 0.15 && r.reason?.startsWith('DO NOT'));

  const lines = top.map((r, i) => {
    const label = i === 0 ? 'RECOMMENDED' : 'also good';
    const reasonSuffix = r.reason ? ` — ${r.reason}` : '';
    return `- [${label}] ${r.action}${reasonSuffix}`;
  });

  const warningLines = warnings.map(r => `- [AVOID] ${r.action} — ${r.reason}`);

  return [
    '## Next action priority (follow this guidance):',
    ...lines,
    ...(warningLines.length > 0 ? ['', '## Actions to AVOID:',  ...warningLines] : [])
  ].join('\n');
}
