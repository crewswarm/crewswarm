/**
 * AgentKeeper — cross-tier persistent task memory.
 *
 * Stores planner decisions, worker outputs, and task results in a local
 * append-only JSONL store (`.crew/agentkeeper.jsonl`).  Supports retrieval
 * of prior entries by task similarity so repeated tasks can reuse earlier
 * decomposition patterns.  Compaction keeps the store bounded.
 */

import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryEntry {
  id: string;
  runId: string;
  tier: 'planner' | 'worker' | 'orchestrator';
  task: string;
  result: string;
  structured?: {
    problem?: string;
    plan?: string[];
    edits?: Array<{ path?: string; summary?: string }>;
    validation?: { lintPassed?: boolean; testsPassed?: boolean; notes?: string };
    outcome?: string;
  };
  agent?: string;
  model?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export interface MemoryMatch {
  entry: MemoryEntry;
  score: number;
}

export interface CompactionResult {
  entriesBefore: number;
  entriesAfter: number;
  bytesFreed: number;
}

interface AgentKeeperOptions {
  storageDir?: string;
  maxEntries?: number;
  maxBytes?: number;
  maxAgeDays?: number;
  autoCompactEvery?: number;
  semanticDedupe?: boolean;
  dedupeThreshold?: number;
}

interface RecallOptions {
  preferSuccessful?: boolean;
  pathHints?: string[];
  nowMs?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2)
  );
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  return intersection / Math.max(a.size, b.size);
}

// ---------------------------------------------------------------------------
// AgentKeeper class
// ---------------------------------------------------------------------------

export class AgentKeeper {
  private storePath: string;
  private maxEntries: number;
  private maxBytes: number;
  private maxAgeDays: number;
  private autoCompactEvery: number;
  private semanticDedupe: boolean;
  private dedupeThreshold: number;
  private writeCount = 0;

  constructor(baseDir: string, options: AgentKeeperOptions = {}) {
    const storageBase = options.storageDir || process.env.CREW_MEMORY_DIR || baseDir;
    this.storePath = join(storageBase, '.crew', 'agentkeeper.jsonl');
    this.maxEntries = options.maxEntries ?? 500;
    this.maxBytes = options.maxBytes ?? 2_000_000;
    this.maxAgeDays = options.maxAgeDays ?? 30;
    this.autoCompactEvery = options.autoCompactEvery ?? 20;
    this.semanticDedupe = options.semanticDedupe ?? true;
    this.dedupeThreshold = options.dedupeThreshold ?? 0.9;
  }

  private redactText(input: string): string {
    let out = String(input || '');
    const replacements: Array<[RegExp, string]> = [
      [/\bsk-[A-Za-z0-9]{16,}\b/g, '[REDACTED_API_KEY]'],
      [/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
      [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]'],
      [/\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/g, '[REDACTED_JWT]'],
      [/\b[A-Fa-f0-9]{40,}\b/g, '[REDACTED_HEX_TOKEN]'],
      [/\b[A-Za-z0-9+/]{80,}={0,2}\b/g, '[REDACTED_BASE64_BLOB]']
    ];
    for (const [rx, replacement] of replacements) {
      out = out.replace(rx, replacement);
    }
    return out;
  }

  private sanitizeText(input: string, maxChars = 6000): string {
    const redacted = this.redactText(String(input || ''));
    if (redacted.length <= maxChars) return redacted;
    return `${redacted.slice(0, maxChars)}\n... [truncated ${redacted.length - maxChars} chars]`;
  }

  private sanitizeMetadata(value: unknown, depth = 0): unknown {
    if (depth > 3) return '[TRUNCATED_DEPTH]';
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return this.sanitizeText(value, 1000);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, 50).map(item => this.sanitizeMetadata(item, depth + 1));
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
        out[k] = this.sanitizeMetadata(v, depth + 1);
      }
      return out;
    }
    return String(value);
  }

  private normalizeStructured(structured: MemoryEntry['structured']): MemoryEntry['structured'] | undefined {
    if (!structured) return undefined;
    const out: NonNullable<MemoryEntry['structured']> = {};
    if (structured.problem) out.problem = this.sanitizeText(structured.problem, 1200);
    if (Array.isArray(structured.plan)) {
      out.plan = structured.plan.slice(0, 50).map(step => this.sanitizeText(step, 300));
    }
    if (Array.isArray(structured.edits)) {
      out.edits = structured.edits.slice(0, 100).map(edit => ({
        path: edit.path ? this.sanitizeText(edit.path, 300) : undefined,
        summary: edit.summary ? this.sanitizeText(edit.summary, 300) : undefined
      }));
    }
    if (structured.validation) {
      out.validation = {
        lintPassed: Boolean(structured.validation.lintPassed),
        testsPassed: Boolean(structured.validation.testsPassed),
        notes: structured.validation.notes ? this.sanitizeText(structured.validation.notes, 600) : undefined
      };
    }
    if (structured.outcome) out.outcome = this.sanitizeText(structured.outcome, 600);
    return out;
  }

  private estimateStoreBytes(entries: MemoryEntry[]): number {
    return entries.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry) + '\n', 'utf8'), 0);
  }

  private pruneEntries(entries: MemoryEntry[]): MemoryEntry[] {
    const now = Date.now();
    const maxAgeMs = Math.max(1, this.maxAgeDays) * 24 * 60 * 60 * 1000;
    let kept = entries.filter(entry => {
      const ts = Date.parse(entry.timestamp || '');
      if (!Number.isFinite(ts)) return true;
      return now - ts <= maxAgeMs;
    });

    if (kept.length > this.maxEntries) {
      kept = kept.slice(-this.maxEntries);
    }

    while (kept.length > 1 && this.estimateStoreBytes(kept) > this.maxBytes) {
      kept = kept.slice(1);
    }

    return kept;
  }

  private dedupeSemantically(entries: MemoryEntry[]): MemoryEntry[] {
    if (!this.semanticDedupe || entries.length < 2) return entries;

    const keptNewestFirst: MemoryEntry[] = [];
    const keptTokens: Array<Set<string>> = [];
    const descending = entries.slice().reverse();

    for (const entry of descending) {
      const entryText = `${entry.task || ''}\n${String(entry.result || '').slice(0, 1200)}`;
      const entryTokenSet = tokenize(entryText);
      if (entryTokenSet.size < 6) {
        keptNewestFirst.push(entry);
        keptTokens.push(entryTokenSet);
        continue;
      }
      let duplicate = false;

      for (let i = 0; i < keptNewestFirst.length; i += 1) {
        const existing = keptNewestFirst[i];
        if (existing.tier !== entry.tier) continue;
        if ((existing.agent || '') !== (entry.agent || '')) continue;
        if (keptTokens[i].size < 6) continue;
        const sim = similarity(entryTokenSet, keptTokens[i]);
        if (sim >= this.dedupeThreshold) {
          duplicate = true;
          break;
        }
      }

      if (!duplicate) {
        keptNewestFirst.push(entry);
        keptTokens.push(entryTokenSet);
      }
    }

    return keptNewestFirst.reverse();
  }

  private async maybeAutoCompact(): Promise<void> {
    this.writeCount += 1;
    if (this.writeCount % this.autoCompactEvery !== 0) return;
    try {
      await this.compact();
    } catch {
      // Never fail runtime flows due to maintenance compaction.
    }
  }

  /** Append a new memory entry. */
  async record(entry: Omit<MemoryEntry, 'id' | 'timestamp'>): Promise<MemoryEntry> {
    await mkdir(dirname(this.storePath), { recursive: true });
    const full: MemoryEntry = {
      ...entry,
      id: randomUUID(),
      task: this.sanitizeText(entry.task, 1200),
      result: this.sanitizeText(entry.result, 6000),
      structured: this.normalizeStructured(entry.structured),
      metadata: this.sanitizeMetadata(entry.metadata) as Record<string, unknown> | undefined,
      timestamp: new Date().toISOString()
    };
    const line = JSON.stringify(full) + '\n';
    await appendFile(this.storePath, line, 'utf8');
    await this.maybeAutoCompact();
    return full;
  }

  /** Best-effort append: never throws, returns success state. */
  async recordSafe(entry: Omit<MemoryEntry, 'id' | 'timestamp'>): Promise<{ ok: boolean; entry?: MemoryEntry; error?: string }> {
    try {
      const saved = await this.record(entry);
      return { ok: true, entry: saved };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  /** Load all entries from the JSONL store. */
  async loadAll(): Promise<MemoryEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.storePath, 'utf8');
    } catch {
      return [];
    }
    const entries: MemoryEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }
    return entries;
  }

  /**
   * Retrieve entries similar to the given task description.
   * Returns up to `maxResults` matches sorted by similarity score descending.
   */
  async recall(task: string, maxResults = 5, options: RecallOptions = {}): Promise<MemoryMatch[]> {
    const entries = await this.loadAll();
    if (entries.length === 0) return [];

    const queryTokens = tokenize(task);
    const now = options.nowMs || Date.now();
    const hints = new Set((options.pathHints || []).map(x => String(x || '').trim()).filter(Boolean));
    const scored: MemoryMatch[] = [];

    for (const entry of entries) {
      const entryTokens = tokenize(entry.task);
      const sim = similarity(queryTokens, entryTokens);

      let recencyBoost = 0;
      const ts = Date.parse(entry.timestamp || '');
      if (Number.isFinite(ts)) {
        const ageDays = Math.max(0, (now - ts) / (24 * 60 * 60 * 1000));
        recencyBoost = Math.max(0, 1 - Math.min(ageDays, 30) / 30) * 0.15;
      }

      let successBoost = 0;
      const success = Boolean(entry.metadata?.success)
        || Boolean(entry.structured?.outcome?.toLowerCase().includes('success'));
      if (options.preferSuccessful !== false && success) {
        successBoost = 0.1;
      }

      let pathBoost = 0;
      if (hints.size > 0) {
        const entryPaths = new Set<string>();
        for (const edit of entry.structured?.edits || []) {
          if (edit.path) entryPaths.add(edit.path);
        }
        const metadataPaths = entry.metadata?.paths;
        if (Array.isArray(metadataPaths)) {
          for (const p of metadataPaths) {
            entryPaths.add(String(p || ''));
          }
        }
        let overlap = 0;
        for (const h of hints) {
          if (entryPaths.has(h)) overlap += 1;
        }
        if (overlap > 0) {
          pathBoost = Math.min(0.2, overlap / Math.max(1, hints.size) * 0.2);
        }
      }

      const score = sim + recencyBoost + successBoost + pathBoost;
      if (score > 0.15) {
        scored.push({ entry, score: Math.round(score * 100) / 100 });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults);
  }

  /**
   * Format recalled memories into a context block for prompt injection.
   * Recent entries shown full, older entries compressed (progressive disclosure pattern).
   */
  async recallAsContext(task: string, maxResults = 3, options: RecallOptions = {}): Promise<string> {
    const matches = await this.recall(task, maxResults, options);
    if (matches.length === 0) return '';

    const lines = ['## Prior Task Memory'];
    const keepFullCount = Math.min(5, Math.ceil(matches.length * 0.5)); // Keep top 50% full
    
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const isFull = i < keepFullCount;
      
      // Full version for recent/high-scoring entries
      if (isFull) {
        const resultPreview = m.entry.result.length > 400
          ? m.entry.result.slice(0, 400) + '...'
          : m.entry.result;
        lines.push(`### [${m.entry.tier}] ${m.entry.task} (score: ${m.score})`);
        if (m.entry.agent) lines.push(`Agent: ${m.entry.agent}`);
        lines.push(`Result: ${resultPreview}`);
        lines.push('');
      } else {
        // Compressed version for older/lower-scoring entries
        const hasError = /error|failed|exception/i.test(m.entry.result);
        const statusIcon = hasError ? '❌' : '✓';
        const preview = m.entry.result.slice(0, 120);
        lines.push(`### ${statusIcon} [${m.entry.tier}] ${m.entry.task}`);
        lines.push(`${preview}... [${hasError ? 'failed' : 'completed'}]`);
        lines.push('');
      }
    }
    return lines.join('\n');
  }

  /**
   * Compact the store: keep only the most recent `maxEntries` entries.
   */
  async compact(): Promise<CompactionResult> {
    const entries = await this.loadAll();
    const entriesBefore = entries.length;

    let bytesBefore = 0;
    try {
      const st = await stat(this.storePath);
      bytesBefore = st.size;
    } catch {
      bytesBefore = 0;
    }

    const deduped = this.dedupeSemantically(entries);
    const kept = this.pruneEntries(deduped);
    if (kept.length === entries.length) {
      return { entriesBefore, entriesAfter: kept.length, bytesFreed: 0 };
    }
    const content = kept.map(e => JSON.stringify(e)).join('\n') + '\n';
    await writeFile(this.storePath, content, 'utf8');

    let bytesAfter = 0;
    try {
      const st = await stat(this.storePath);
      bytesAfter = st.size;
    } catch {
      bytesAfter = content.length;
    }

    return {
      entriesBefore,
      entriesAfter: kept.length,
      bytesFreed: Math.max(0, bytesBefore - bytesAfter)
    };
  }

  /** Get summary stats. */
  async stats(): Promise<{ entries: number; byTier: Record<string, number>; byAgent: Record<string, number>; bytes: number }> {
    const entries = await this.loadAll();
    const byTier: Record<string, number> = {};
    const byAgent: Record<string, number> = {};
    for (const e of entries) {
      byTier[e.tier] = (byTier[e.tier] || 0) + 1;
      if (e.agent) byAgent[e.agent] = (byAgent[e.agent] || 0) + 1;
    }
    return { entries: entries.length, byTier, byAgent, bytes: this.estimateStoreBytes(entries) };
  }
}
