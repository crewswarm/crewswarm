/**
 * Conversation Transcript Store — JSONL append-only format
 *
 * Each turn is appended as a single JSON line to .crew/transcript-{sessionId}.jsonl
 * This is crash-safe: a mid-write crash only loses the last incomplete line.
 * On load, lines are parsed individually so partial corruption doesn't lose the whole file.
 */

import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { estimateTokens } from '../context/token-compaction.js';

export interface ConversationTurn {
  ts: string;
  role: 'user' | 'assistant';
  text: string;
  engine?: string;
  estimatedTokens?: number;
  sessionId?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function clip(text: string, maxChars: number): string {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

export class ConversationTranscriptStore {
  private readonly stateDir: string;

  constructor(baseDir: string = process.cwd()) {
    const root = resolve(baseDir);
    this.stateDir = join(root, '.crew');
  }

  private transcriptPath(sessionId: string): string {
    // Sanitize session ID for safe filenames
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(this.stateDir, `transcript-${safe}.jsonl`);
  }

  async ensureInitialized(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
  }

  /**
   * Append a turn to the transcript — single atomic append, crash-safe.
   */
  async appendTurn(params: {
    sessionId: string;
    role: 'user' | 'assistant';
    text: string;
    engine?: string;
    keepTurns?: number;
  }): Promise<void> {
    const sessionId = String(params.sessionId || '').trim();
    if (!sessionId) return;
    await this.ensureInitialized();

    const clippedText = clip(params.text, 8000);
    const turn: ConversationTurn = {
      ts: nowIso(),
      role: params.role,
      text: clippedText,
      engine: params.engine,
      estimatedTokens: estimateTokens(clippedText),
      sessionId
    };

    // Append single line — atomic on most filesystems for < 4KB
    const line = JSON.stringify(turn) + '\n';
    await appendFile(this.transcriptPath(sessionId), line, 'utf8');
  }

  /**
   * Load all turns for a session from JSONL file.
   * Skips corrupt/incomplete lines gracefully.
   */
  async loadTurns(sessionId: string): Promise<ConversationTurn[]> {
    const key = String(sessionId || '').trim();
    if (!key) return [];

    const path = this.transcriptPath(key);
    if (!existsSync(path)) return [];

    try {
      const raw = await readFile(path, 'utf8');
      const turns: ConversationTurn[] = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          turns.push(JSON.parse(trimmed) as ConversationTurn);
        } catch {
          // Skip corrupt line — this is the crash-safety benefit
        }
      }
      return turns;
    } catch {
      return [];
    }
  }

  /**
   * Get recent turns with token-aware trimming.
   */
  async getRecentTurns(sessionId: string, maxTurns = 8): Promise<ConversationTurn[]> {
    const turns = await this.loadTurns(sessionId);
    if (turns.length === 0) return [];

    // Token-aware trimming
    const maxSessionTokens = Number(process.env.CREW_MAX_SESSION_TOKENS) || 100_000;
    let totalTokens = 0;
    const result: ConversationTurn[] = [];

    // Walk backwards to keep most recent turns within budget
    for (let i = turns.length - 1; i >= 0 && result.length < maxTurns; i--) {
      const t = turns[i];
      const tokens = t.estimatedTokens || estimateTokens(t.text);
      if (totalTokens + tokens > maxSessionTokens && result.length >= 4) break;
      totalTokens += tokens;
      result.unshift(t);
    }

    return result;
  }

  /**
   * List all session IDs that have transcripts.
   */
  async listSessions(): Promise<Array<{ sessionId: string; path: string; lines: number }>> {
    await this.ensureInitialized();
    const sessions: Array<{ sessionId: string; path: string; lines: number }> = [];

    try {
      const files = await readdir(this.stateDir);
      for (const f of files) {
        const match = f.match(/^transcript-(.+)\.jsonl$/);
        if (!match) continue;
        const sessionId = match[1];
        const fullPath = join(this.stateDir, f);
        try {
          const raw = await readFile(fullPath, 'utf8');
          const lines = raw.split('\n').filter(l => l.trim()).length;
          sessions.push({ sessionId, path: fullPath, lines });
        } catch {
          sessions.push({ sessionId, path: fullPath, lines: 0 });
        }
      }
    } catch { /* empty dir */ }

    return sessions;
  }

  /**
   * Get a summary of a session (first user message + turn count + last activity).
   */
  async getSessionSummary(sessionId: string): Promise<{
    sessionId: string;
    turnCount: number;
    firstMessage: string;
    lastActivity: string;
    totalTokens: number;
  } | null> {
    const turns = await this.loadTurns(sessionId);
    if (turns.length === 0) return null;

    const firstUser = turns.find(t => t.role === 'user');
    return {
      sessionId,
      turnCount: turns.length,
      firstMessage: clip(firstUser?.text || '(no user message)', 80),
      lastActivity: turns[turns.length - 1].ts,
      totalTokens: turns.reduce((sum, t) => sum + (t.estimatedTokens || estimateTokens(t.text)), 0)
    };
  }
}

export function buildConversationHydrationPrompt(params: {
  turns: ConversationTurn[];
  currentPrompt: string;
}): string {
  const turns = Array.isArray(params.turns) ? params.turns : [];
  if (turns.length === 0) return String(params.currentPrompt || '');

  const lines: string[] = [];
  lines.push('SHARED SESSION CONTEXT (engine-agnostic):');
  for (const t of turns) {
    const role = t.role === 'assistant' ? 'ASSISTANT' : 'USER';
    lines.push(`[${role} @ ${t.ts}${t.engine ? ` via ${t.engine}` : ''}]`);
    lines.push(clip(String(t.text || ''), 1600));
  }
  lines.push('Continue from this shared conversation state.');
  lines.push('CURRENT USER MESSAGE:');
  lines.push(String(params.currentPrompt || ''));
  return lines.join('\n\n');
}
