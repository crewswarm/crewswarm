/**
 * Chat Recall — semantic search across conversation history.
 *
 * Indexes past session entries (commands, outputs, tool results)
 * and provides keyword + fuzzy search across all sessions.
 *
 * Uses the existing session history stored in .crew/session.json
 * and builds a lightweight inverted index for fast lookup.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecallEntry {
  sessionId: string;
  timestamp: string;
  input: string;
  output?: string;
  route?: string;
  agent?: string;
  score: number;
}

export interface RecallResult {
  query: string;
  entries: RecallEntry[];
  totalSearched: number;
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

interface IndexedSession {
  sessionId: string;
  entries: Array<{
    timestamp: string;
    input: string;
    output?: string;
    route?: string;
    agent?: string;
    tokens: string[];
  }>;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_.-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2);
}

function scoreMatch(queryTokens: string[], entryTokens: string[]): number {
  if (queryTokens.length === 0 || entryTokens.length === 0) return 0;
  const entrySet = new Set(entryTokens);
  let matches = 0;
  for (const qt of queryTokens) {
    // Exact match
    if (entrySet.has(qt)) { matches += 2; continue; }
    // Prefix match
    for (const et of entrySet) {
      if (et.startsWith(qt) || qt.startsWith(et)) { matches += 1; break; }
    }
  }
  return matches / (queryTokens.length * 2); // normalize to 0-1
}

// ---------------------------------------------------------------------------
// Load & Search
// ---------------------------------------------------------------------------

/**
 * Load all session histories from a project directory.
 */
async function loadSessionHistories(projectDir: string): Promise<IndexedSession[]> {
  const sessions: IndexedSession[] = [];

  // Current session
  const sessionPath = join(projectDir, '.crew', 'session.json');
  if (existsSync(sessionPath)) {
    try {
      const raw = await readFile(sessionPath, 'utf8');
      const session = JSON.parse(raw);
      if (session.history?.length) {
        sessions.push({
          sessionId: session.sessionId || 'current',
          entries: session.history.map((h: Record<string, unknown>) => ({
            timestamp: String(h.timestamp || ''),
            input: String(h.input || ''),
            output: h.output ? String(h.output) : undefined,
            route: h.route ? String(h.route) : undefined,
            agent: h.agent ? String(h.agent) : undefined,
            tokens: tokenize(`${h.input || ''} ${h.output || ''} ${h.route || ''} ${h.agent || ''}`)
          }))
        });
      }
    } catch {}
  }

  // Past session logs (.crew/sessions/ directory if exists)
  const sessionsDir = join(projectDir, '.crew', 'sessions');
  if (existsSync(sessionsDir)) {
    try {
      const files = await readdir(sessionsDir);
      for (const file of files.filter(f => f.endsWith('.json'))) {
        try {
          const raw = await readFile(join(sessionsDir, file), 'utf8');
          const session = JSON.parse(raw);
          if (session.history?.length) {
            sessions.push({
              sessionId: session.sessionId || file.replace('.json', ''),
              entries: session.history.map((h: Record<string, unknown>) => ({
                timestamp: String(h.timestamp || ''),
                input: String(h.input || ''),
                output: h.output ? String(h.output) : undefined,
                route: h.route ? String(h.route) : undefined,
                agent: h.agent ? String(h.agent) : undefined,
                tokens: tokenize(`${h.input || ''} ${h.output || ''} ${h.route || ''} ${h.agent || ''}`)
              }))
            });
          }
        } catch {}
      }
    } catch {}
  }

  // Routing log (.crew/routing.log — JSONL format)
  const routingPath = join(projectDir, '.crew', 'routing.log');
  if (existsSync(routingPath)) {
    try {
      const raw = await readFile(routingPath, 'utf8');
      const entries = raw.split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
      if (entries.length > 0) {
        sessions.push({
          sessionId: 'routing-log',
          entries: entries.map((e: Record<string, unknown>) => ({
            timestamp: String(e.timestamp || ''),
            input: String(e.task || e.input || ''),
            output: String(e.decision || e.route || ''),
            route: String(e.route || e.decision || ''),
            agent: String(e.agent || ''),
            tokens: tokenize(JSON.stringify(e).slice(0, 500))
          }))
        });
      }
    } catch {}
  }

  return sessions;
}

/**
 * Search across all session history for a query.
 */
export async function recallSearch(
  query: string,
  projectDir: string = process.cwd(),
  options: { maxResults?: number; minScore?: number } = {}
): Promise<RecallResult> {
  const maxResults = options.maxResults ?? 10;
  const minScore = options.minScore ?? 0.2;
  const queryTokens = tokenize(query);

  if (queryTokens.length === 0) {
    return { query, entries: [], totalSearched: 0 };
  }

  const sessions = await loadSessionHistories(projectDir);
  const scored: RecallEntry[] = [];
  let totalSearched = 0;

  for (const session of sessions) {
    for (const entry of session.entries) {
      totalSearched++;
      const score = scoreMatch(queryTokens, entry.tokens);
      if (score >= minScore) {
        scored.push({
          sessionId: session.sessionId,
          timestamp: entry.timestamp,
          input: entry.input,
          output: entry.output,
          route: entry.route,
          agent: entry.agent,
          score
        });
      }
    }
  }

  // Sort by score descending, then by timestamp descending
  scored.sort((a, b) => b.score - a.score || b.timestamp.localeCompare(a.timestamp));

  return {
    query,
    entries: scored.slice(0, maxResults),
    totalSearched
  };
}

/**
 * Build a context string from recall results for injection into LLM prompt.
 */
export function buildRecallContext(result: RecallResult, maxChars: number = 2000): string {
  if (result.entries.length === 0) return '';

  const lines: string[] = ['## Relevant past interactions:'];
  let chars = lines[0].length;

  for (const entry of result.entries) {
    const line = `- [${entry.timestamp?.split('T')[0] || '?'}] ${entry.input?.slice(0, 120)}${entry.output ? ' → ' + entry.output.slice(0, 80) : ''}`;
    if (chars + line.length > maxChars) break;
    lines.push(line);
    chars += line.length;
  }

  return lines.join('\n');
}
