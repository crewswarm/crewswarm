/**
 * Execution Transcript — immutable append-only log of every tool call per task.
 *
 * Workers can't modify entries after completion.
 * QA gate reads the transcript to mechanically verify work quality.
 */

export interface TranscriptEntry {
  ts: number;              // Date.now()
  toolName: string;
  params: Record<string, unknown>;
  success: boolean;
  outputPreview: string;   // first 200 chars of output/error
  durationMs: number;
  error?: string;
  handled?: boolean;
  recovery?: string;
}

export class ExecutionTranscript {
  private _entries: TranscriptEntry[] = [];
  private _frozen = false;

  /** Append a tool call entry. Throws if transcript is frozen. */
  record(entry: TranscriptEntry): void {
    if (this._frozen) throw new Error('Transcript is frozen — cannot append after completion');
    this._entries.push(Object.freeze(entry) as TranscriptEntry);
  }

  /** Freeze the transcript — no more entries can be added. */
  freeze(): void {
    this._frozen = true;
  }

  /** Read-only access to all entries. */
  get entries(): ReadonlyArray<TranscriptEntry> {
    return this._entries;
  }

  get length(): number {
    return this._entries.length;
  }

  /** All unique tool names used. */
  get toolsUsed(): string[] {
    return [...new Set(this._entries.map(e => e.toolName))];
  }

  /** Count of failed tool calls. */
  get failedCalls(): number {
    return this._entries.filter(e => !e.success).length;
  }

  /** Total duration of all tool calls. */
  get totalDurationMs(): number {
    return this._entries.reduce((sum, e) => sum + e.durationMs, 0);
  }

  /** Files that were read (from read_file/read_many_files calls). */
  get filesRead(): Set<string> {
    const files = new Set<string>();
    for (const e of this._entries) {
      if (!e.success) continue;
      if (e.toolName === 'read_file' && e.params.file_path) {
        files.add(e.params.file_path);
      }
      if (e.toolName === 'read_many_files' && e.params.include) {
        files.add(e.params.include);
      }
    }
    return files;
  }

  /** Files that were edited (replace/edit/append_file). */
  get filesEdited(): Set<string> {
    const files = new Set<string>();
    const editTools = new Set(['replace', 'edit', 'append_file']);
    for (const e of this._entries) {
      if (!e.success) continue;
      if (editTools.has(e.toolName) && e.params.file_path) {
        files.add(e.params.file_path);
      }
    }
    return files;
  }

  /** Files that were written (write_file — new files only). */
  get filesWritten(): Set<string> {
    const files = new Set<string>();
    for (const e of this._entries) {
      if (!e.success) continue;
      if (e.toolName === 'write_file' && e.params.file_path) {
        files.add(e.params.file_path);
      }
    }
    return files;
  }

  /** Files edited without a prior read_file call. */
  get unreadEdits(): string[] {
    const readFiles = this.filesRead;
    const edited = this.filesEdited;
    return [...edited].filter(f => !readFiles.has(f));
  }

  /** Shell commands that failed (non-zero exit or error). */
  get failedShellCommands(): TranscriptEntry[] {
    return this._entries.filter(e =>
      (e.toolName === 'run_shell_command' || e.toolName === 'shell' || e.toolName === 'run_cmd')
      && !e.success
    );
  }

  /** Serialize transcript to JSONL string for persistence. */
  toJSONL(): string {
    return this._entries.map(e => JSON.stringify(e)).join('\n');
  }

  /** Summary stats for logging. */
  toSummary(): {
    totalCalls: number;
    failedCalls: number;
    toolsUsed: string[];
    filesRead: number;
    filesEdited: number;
    filesWritten: number;
    unreadEdits: string[];
    totalDurationMs: number;
  } {
    return {
      totalCalls: this._entries.length,
      failedCalls: this.failedCalls,
      toolsUsed: this.toolsUsed,
      filesRead: this.filesRead.size,
      filesEdited: this.filesEdited.size,
      filesWritten: this.filesWritten.size,
      unreadEdits: this.unreadEdits,
      totalDurationMs: this.totalDurationMs
    };
  }
}
