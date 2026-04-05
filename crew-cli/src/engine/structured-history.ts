/**
 * Structured History Preservation
 *
 * Instead of flattening tool history into text between layers, this module
 * preserves rich structured data across the execution lifecycle.
 *
 * Key problems solved:
 *   - Provider turn state lost when multi-turn-drivers return only text+toolCalls
 *   - Intermediate worker outputs lost during review/fix cycles
 *   - Sandbox filesystem state not captured per-turn
 *   - Compaction decisions opaque to callers
 *
 * Usage:
 *   const history = new StructuredHistory();
 *   history.recordLLMTurn({ ... });
 *   history.recordToolExecution({ ... });
 *   history.recordCompaction({ ... });
 *   const context = history.buildProviderContext('anthropic', tokenBudget);
 */

// ---------------------------------------------------------------------------
// Turn types — preserve what each layer produces
// ---------------------------------------------------------------------------

export interface LLMTurnRecord {
  type: 'llm';
  turn: number;
  ts: number;
  model: string;
  provider: string;
  response: string;
  toolCalls: Array<{ tool: string; params: Record<string, unknown> }>;
  finishReason?: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Whether this turn was a retry after compaction */
  wasRetry: boolean;
  /** Whether extended thinking was present (o1, o3 models) */
  hadThinking: boolean;
}

export interface ToolExecutionRecord {
  type: 'tool';
  turn: number;
  ts: number;
  tool: string;
  params: Record<string, unknown>;
  result: unknown;
  error?: string;
  durationMs: number;
  /** Files read/written/edited by this tool call */
  filesAffected: string[];
  /** Whether this was a read-only operation */
  readOnly: boolean;
}

export interface CompactionRecord {
  type: 'compaction';
  ts: number;
  reason: 'proactive' | 'reactive' | 'budget';
  turnsBefore: number;
  turnsAfter: number;
  tokensBefore: number;
  tokensAfter: number;
  /** What was preserved vs dropped */
  preservedTurns: number[];
  droppedTurns: number[];
}

export interface ReviewRecord {
  type: 'review';
  ts: number;
  cycle: number;
  approved: boolean;
  issues: Array<{ severity: string; problem: string }>;
  fixAttempted: boolean;
}

export type HistoryRecord = LLMTurnRecord | ToolExecutionRecord | CompactionRecord | ReviewRecord;

// ---------------------------------------------------------------------------
// File state tracking
// ---------------------------------------------------------------------------

export interface FileState {
  path: string;
  lastReadAt?: number;
  lastWrittenAt?: number;
  lastEditedAt?: number;
  readCount: number;
  writeCount: number;
  editCount: number;
  /** Was the file read before first edit/write? */
  readBeforeWrite: boolean;
}

// ---------------------------------------------------------------------------
// StructuredHistory
// ---------------------------------------------------------------------------

export class StructuredHistory {
  private _records: HistoryRecord[] = [];
  private _fileStates = new Map<string, FileState>();
  private _activeGoals: string[] = [];
  private _resolvedGoals: string[] = [];

  // ── Recording ─────────────────────────────────────────────────────────

  recordLLMTurn(entry: Omit<LLMTurnRecord, 'type' | 'ts'>): void {
    this._records.push({ ...entry, type: 'llm', ts: Date.now() });
  }

  recordToolExecution(entry: Omit<ToolExecutionRecord, 'type' | 'ts'>): void {
    const record: ToolExecutionRecord = { ...entry, type: 'tool', ts: Date.now() };
    this._records.push(record);

    // Track file state
    for (const file of entry.filesAffected) {
      this.trackFileAccess(file, entry.tool, entry.readOnly);
    }
  }

  recordCompaction(entry: Omit<CompactionRecord, 'type' | 'ts'>): void {
    this._records.push({ ...entry, type: 'compaction', ts: Date.now() });
  }

  recordReview(entry: Omit<ReviewRecord, 'type' | 'ts'>): void {
    this._records.push({ ...entry, type: 'review', ts: Date.now() });
  }

  // ── File state ────────────────────────────────────────────────────────

  private trackFileAccess(path: string, tool: string, readOnly: boolean): void {
    let state = this._fileStates.get(path);
    if (!state) {
      state = {
        path,
        readCount: 0,
        writeCount: 0,
        editCount: 0,
        readBeforeWrite: false
      };
      this._fileStates.set(path, state);
    }

    const isRead = readOnly || tool === 'read_file' || tool === 'read_many_files' || tool === 'grep_search' || tool === 'glob';
    const isWrite = tool === 'write_file';
    const isEdit = tool === 'edit_file' || tool === 'replace' || tool === 'append_file';

    if (isRead) {
      state.readCount += 1;
      state.lastReadAt = Date.now();
      // If this is the first access and it's a read, mark read-before-write
      if (state.writeCount === 0 && state.editCount === 0) {
        state.readBeforeWrite = true;
      }
    }
    if (isWrite) {
      state.writeCount += 1;
      state.lastWrittenAt = Date.now();
    }
    if (isEdit) {
      state.editCount += 1;
      state.lastEditedAt = Date.now();
    }
  }

  getFileState(path: string): FileState | undefined {
    return this._fileStates.get(path);
  }

  get fileStates(): ReadonlyMap<string, FileState> {
    return this._fileStates;
  }

  /** Files that were written/edited without being read first */
  get unreadWrites(): string[] {
    return [...this._fileStates.values()]
      .filter(s => (s.writeCount > 0 || s.editCount > 0) && !s.readBeforeWrite)
      .map(s => s.path);
  }

  // ── Goal tracking ─────────────────────────────────────────────────────

  addGoal(goal: string): void {
    this._activeGoals.push(goal);
  }

  resolveGoal(goal: string): void {
    const idx = this._activeGoals.indexOf(goal);
    if (idx >= 0) {
      this._activeGoals.splice(idx, 1);
      this._resolvedGoals.push(goal);
    }
  }

  get activeGoals(): ReadonlyArray<string> {
    return this._activeGoals;
  }

  get resolvedGoals(): ReadonlyArray<string> {
    return this._resolvedGoals;
  }

  // ── Queries ───────────────────────────────────────────────────────────

  get records(): ReadonlyArray<HistoryRecord> {
    return this._records;
  }

  get length(): number {
    return this._records.length;
  }

  get llmTurns(): LLMTurnRecord[] {
    return this._records.filter((r): r is LLMTurnRecord => r.type === 'llm');
  }

  get toolExecutions(): ToolExecutionRecord[] {
    return this._records.filter((r): r is ToolExecutionRecord => r.type === 'tool');
  }

  get failedTools(): ToolExecutionRecord[] {
    return this.toolExecutions.filter(t => t.error);
  }

  get compactions(): CompactionRecord[] {
    return this._records.filter((r): r is CompactionRecord => r.type === 'compaction');
  }

  /** Total cost across all LLM turns */
  get totalCostUsd(): number {
    return this.llmTurns.reduce((sum, t) => sum + t.costUsd, 0);
  }

  /** Total tokens used */
  get totalTokens(): { input: number; output: number; cached: number } {
    return this.llmTurns.reduce(
      (acc, t) => ({
        input: acc.input + t.inputTokens,
        output: acc.output + t.outputTokens,
        cached: acc.cached + t.cachedTokens
      }),
      { input: 0, output: 0, cached: 0 }
    );
  }

  // ── Context building ──────────────────────────────────────────────────

  /**
   * Build a summary of execution state for injection into LLM context.
   * Preserves critical state that naive compaction would lose:
   *   - Active/unresolved goals
   *   - Files currently being worked on
   *   - Recent failures and what was learned
   *   - Verification status
   */
  buildExecutionSummary(): string {
    const sections: string[] = [];

    // Active goals
    if (this._activeGoals.length > 0) {
      sections.push(`Active goals: ${this._activeGoals.join('; ')}`);
    }
    if (this._resolvedGoals.length > 0) {
      sections.push(`Completed: ${this._resolvedGoals.join('; ')}`);
    }

    // Files in progress
    const activeFiles = [...this._fileStates.values()]
      .filter(s => s.editCount > 0 || s.writeCount > 0)
      .map(s => s.path);
    if (activeFiles.length > 0) {
      sections.push(`Files modified: ${activeFiles.join(', ')}`);
    }

    // Unread writes (problems)
    const unread = this.unreadWrites;
    if (unread.length > 0) {
      sections.push(`WARNING — edited without reading first: ${unread.join(', ')}`);
    }

    // Recent failures
    const recentFails = this.failedTools.slice(-3);
    if (recentFails.length > 0) {
      const lines = recentFails.map(f => `  ${f.tool}: ${(f.error || '').slice(0, 80)}`);
      sections.push(`Recent failures:\n${lines.join('\n')}`);
    }

    // Compaction history
    if (this.compactions.length > 0) {
      const last = this.compactions[this.compactions.length - 1];
      sections.push(`Context was compacted (${last.reason}): ${last.turnsBefore}→${last.turnsAfter} turns`);
    }

    return sections.length > 0
      ? `## Execution state\n${sections.join('\n')}`
      : '';
  }

  /**
   * Export a JSON-serializable snapshot for persistence.
   */
  toJSON(): {
    records: HistoryRecord[];
    fileStates: Array<[string, FileState]>;
    activeGoals: string[];
    resolvedGoals: string[];
  } {
    return {
      records: [...this._records],
      fileStates: [...this._fileStates.entries()],
      activeGoals: [...this._activeGoals],
      resolvedGoals: [...this._resolvedGoals]
    };
  }
}
