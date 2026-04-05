/**
 * RunState — Central run ownership for crew-cli execution engine.
 *
 * Every task execution (L1 → L2 → L3) is wrapped in a RunState that owns:
 *   - Phase lifecycle (plan → execute → review → qa → complete/failed)
 *   - Cost tracking per phase and per tool
 *   - Failure memory (what failed, how, don't repeat)
 *   - Verification goals (what proof is needed, what's been proven)
 *   - Context budget and compaction decisions
 *   - Full audit trail
 *
 * This replaces the fragmented state scattered across autonomous-loop,
 * agentic-executor, unified pipeline, and multi-turn-drivers.
 */

import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Phase lifecycle
// ---------------------------------------------------------------------------

export type RunPhase =
  | 'init'
  | 'planning'
  | 'executing'
  | 'reviewing'
  | 'qa'
  | 'complete'
  | 'failed'
  | 'aborted';

export interface PhaseRecord {
  phase: RunPhase;
  startedAt: number;
  endedAt?: number;
  costUsd: number;
  turns: number;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Failure memory
// ---------------------------------------------------------------------------

export interface FailureRecord {
  turn: number;
  tool: string;
  params: Record<string, unknown>;
  error: string;
  signature: string;        // tool:params hash for dedup
  count: number;            // how many times this exact failure repeated
  category: FailureCategory;
}

export type FailureCategory =
  | 'bad-file-selection'    // edited wrong file or nonexistent file
  | 'bad-tool-choice'       // used wrong tool for the situation
  | 'bad-retry'             // retried same failing action
  | 'syntax-error'          // generated code with syntax errors
  | 'test-failure'          // tests failed after edit
  | 'scope-violation'       // touched files outside allowed paths
  | 'context-overflow'      // hit context length limit
  | 'timeout'               // exceeded time/turn budget
  | 'unknown';

// ---------------------------------------------------------------------------
// Verification goals
// ---------------------------------------------------------------------------

export interface VerificationGoal {
  id: string;
  description: string;      // "tests pass", "file exists", "lint clean"
  status: 'pending' | 'proven' | 'failed' | 'skipped';
  provenAt?: number;
  provenBy?: string;         // tool call that proved it
  attempts: number;
}

// ---------------------------------------------------------------------------
// Cost tracking
// ---------------------------------------------------------------------------

export interface CostBreakdown {
  totalUsd: number;
  byPhase: Record<string, number>;
  byTool: Record<string, number>;
  byModel: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

// ---------------------------------------------------------------------------
// RunState
// ---------------------------------------------------------------------------

export interface RunStateSnapshot {
  id: string;
  sessionId: string;
  traceId: string;
  task: string;
  phase: RunPhase;
  phases: PhaseRecord[];
  failures: FailureRecord[];
  verificationGoals: VerificationGoal[];
  cost: CostBreakdown;
  turns: number;
  startedAt: number;
  endedAt?: number;
  abortReason?: string;
}

export class RunState {
  readonly id: string;
  readonly sessionId: string;
  readonly traceId: string;
  readonly task: string;
  readonly startedAt: number;

  private _phase: RunPhase = 'init';
  private _phases: PhaseRecord[] = [];
  private _currentPhase: PhaseRecord | null = null;
  private _failures: FailureRecord[] = [];
  private _failureSignatures = new Map<string, FailureRecord>();
  private _verificationGoals: VerificationGoal[] = [];
  private _cost: CostBreakdown = {
    totalUsd: 0,
    byPhase: {},
    byTool: {},
    byModel: {},
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0
  };
  private _turns = 0;
  private _endedAt?: number;
  private _abortReason?: string;

  constructor(options: {
    task: string;
    sessionId?: string;
    traceId?: string;
  }) {
    this.id = randomUUID();
    this.sessionId = options.sessionId || randomUUID();
    this.traceId = options.traceId || randomUUID();
    this.task = options.task;
    this.startedAt = Date.now();
  }

  // ── Phase lifecycle ─────────────────────────────────────────────────────

  get phase(): RunPhase {
    return this._phase;
  }

  enterPhase(phase: RunPhase): void {
    // Close current phase
    if (this._currentPhase) {
      this._currentPhase.endedAt = Date.now();
      this._phases.push(this._currentPhase);
    }

    this._phase = phase;
    this._currentPhase = {
      phase,
      startedAt: Date.now(),
      costUsd: 0,
      turns: 0,
      notes: []
    };

    if (phase === 'complete' || phase === 'failed' || phase === 'aborted') {
      this._currentPhase.endedAt = Date.now();
      this._phases.push(this._currentPhase);
      this._currentPhase = null;
      this._endedAt = Date.now();
    }
  }

  addPhaseNote(note: string): void {
    this._currentPhase?.notes.push(note);
  }

  // ── Turn tracking ───────────────────────────────────────────────────────

  get turns(): number {
    return this._turns;
  }

  recordTurn(): void {
    this._turns += 1;
    if (this._currentPhase) {
      this._currentPhase.turns += 1;
    }
  }

  // ── Cost tracking ───────────────────────────────────────────────────────

  get cost(): Readonly<CostBreakdown> {
    return this._cost;
  }

  recordCost(entry: {
    usd: number;
    tool?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
  }): void {
    this._cost.totalUsd += entry.usd;
    if (this._currentPhase) {
      this._currentPhase.costUsd += entry.usd;
      this._cost.byPhase[this._currentPhase.phase] =
        (this._cost.byPhase[this._currentPhase.phase] || 0) + entry.usd;
    }
    if (entry.tool) {
      this._cost.byTool[entry.tool] = (this._cost.byTool[entry.tool] || 0) + entry.usd;
    }
    if (entry.model) {
      this._cost.byModel[entry.model] = (this._cost.byModel[entry.model] || 0) + entry.usd;
    }
    this._cost.inputTokens += entry.inputTokens || 0;
    this._cost.outputTokens += entry.outputTokens || 0;
    this._cost.cachedTokens += entry.cachedTokens || 0;
  }

  // ── Failure memory ──────────────────────────────────────────────────────

  get failures(): ReadonlyArray<FailureRecord> {
    return this._failures;
  }

  recordFailure(entry: {
    turn: number;
    tool: string;
    params: Record<string, unknown>;
    error: string;
    category?: FailureCategory;
  }): FailureRecord {
    const signature = `${entry.tool}:${stableHash(entry.params)}`;
    const existing = this._failureSignatures.get(signature);

    if (existing) {
      existing.count += 1;
      existing.error = entry.error; // update with latest error
      return existing;
    }

    const record: FailureRecord = {
      turn: entry.turn,
      tool: entry.tool,
      params: entry.params,
      error: entry.error,
      signature,
      count: 1,
      category: entry.category || classifyFailure(entry.tool, entry.error)
    };

    this._failures.push(record);
    this._failureSignatures.set(signature, record);
    return record;
  }

  /**
   * Check if a proposed tool call has already failed.
   * Returns the failure record if it's a known bad move, null otherwise.
   */
  wouldRepeatFailure(tool: string, params: Record<string, unknown>): FailureRecord | null {
    const signature = `${tool}:${stableHash(params)}`;
    const record = this._failureSignatures.get(signature);
    if (record && record.count >= 2) return record;
    return null;
  }

  /**
   * Build a failure-avoidance prompt for the LLM.
   * Tells the model what NOT to do based on observed failures.
   */
  buildFailureContext(): string {
    if (this._failures.length === 0) return '';

    const repeated = this._failures.filter(f => f.count >= 2);
    const recent = this._failures.slice(-5);
    const relevant = [...new Set([...repeated, ...recent])];

    if (relevant.length === 0) return '';

    const lines = relevant.map(f => {
      const paramPreview = JSON.stringify(f.params).slice(0, 100);
      return `- ${f.tool}(${paramPreview}) failed ${f.count}x: ${f.error.slice(0, 120)}`;
    });

    return [
      '## Known failures in this run — do NOT repeat these:',
      ...lines,
      '',
      'Choose a different approach or different parameters.'
    ].join('\n');
  }

  // ── Verification goals ──────────────────────────────────────────────────

  get verificationGoals(): ReadonlyArray<VerificationGoal> {
    return this._verificationGoals;
  }

  addVerificationGoal(description: string): VerificationGoal {
    const goal: VerificationGoal = {
      id: randomUUID(),
      description,
      status: 'pending',
      attempts: 0
    };
    this._verificationGoals.push(goal);
    return goal;
  }

  proveGoal(id: string, provenBy: string): void {
    const goal = this._verificationGoals.find(g => g.id === id);
    if (goal) {
      goal.status = 'proven';
      goal.provenAt = Date.now();
      goal.provenBy = provenBy;
    }
  }

  failGoal(id: string): void {
    const goal = this._verificationGoals.find(g => g.id === id);
    if (goal) {
      goal.status = 'failed';
      goal.attempts += 1;
    }
  }

  /**
   * Check if all verification goals are satisfied.
   */
  allGoalsProven(): boolean {
    return this._verificationGoals.length > 0 &&
      this._verificationGoals.every(g => g.status === 'proven' || g.status === 'skipped');
  }

  /**
   * Get the next unproven goal (for verification-first loop).
   */
  nextUnprovenGoal(): VerificationGoal | null {
    return this._verificationGoals.find(g => g.status === 'pending') || null;
  }

  /**
   * Build a verification prompt for the LLM.
   */
  buildVerificationContext(): string {
    if (this._verificationGoals.length === 0) return '';

    const lines = this._verificationGoals.map(g => {
      const status = g.status === 'proven' ? '[PROVEN]'
        : g.status === 'failed' ? `[FAILED x${g.attempts}]`
        : '[PENDING]';
      return `${status} ${g.description}`;
    });

    return [
      '## Verification goals — prove each one before declaring done:',
      ...lines
    ].join('\n');
  }

  // ── Abort ───────────────────────────────────────────────────────────────

  abort(reason: string): void {
    this._abortReason = reason;
    this.enterPhase('aborted');
  }

  get isAborted(): boolean {
    return this._phase === 'aborted';
  }

  // ── Budget checks ───────────────────────────────────────────────────────

  isOverBudget(maxUsd: number): boolean {
    return this._cost.totalUsd >= maxUsd;
  }

  isOverTurns(maxTurns: number): boolean {
    return this._turns >= maxTurns;
  }

  // ── Snapshot for persistence/logging ────────────────────────────────────

  snapshot(): RunStateSnapshot {
    return {
      id: this.id,
      sessionId: this.sessionId,
      traceId: this.traceId,
      task: this.task,
      phase: this._phase,
      phases: [...this._phases],
      failures: [...this._failures],
      verificationGoals: [...this._verificationGoals],
      cost: { ...this._cost },
      turns: this._turns,
      startedAt: this.startedAt,
      endedAt: this._endedAt,
      abortReason: this._abortReason
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stableHash(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();
  const parts = keys.map(k => `${k}:${JSON.stringify(obj[k]) || ''}`);
  return parts.join('|').slice(0, 200);
}

function classifyFailure(tool: string, error: string): FailureCategory {
  const e = error.toLowerCase();
  if (e.includes('no such file') || e.includes('enoent') || e.includes('not found')) {
    return 'bad-file-selection';
  }
  if (e.includes('syntax') || e.includes('parse error') || e.includes('unexpected token')) {
    return 'syntax-error';
  }
  if (e.includes('test') && (e.includes('fail') || e.includes('assert'))) {
    return 'test-failure';
  }
  if (e.includes('context') && (e.includes('length') || e.includes('too long'))) {
    return 'context-overflow';
  }
  if (e.includes('timeout') || e.includes('timed out')) {
    return 'timeout';
  }
  if (e.includes('scope') || e.includes('outside allowed') || e.includes('permission')) {
    return 'scope-violation';
  }
  return 'unknown';
}
