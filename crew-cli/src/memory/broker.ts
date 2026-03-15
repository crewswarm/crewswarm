import { resolve, join } from 'node:path';
import { AgentKeeper, type MemoryMatch } from './agentkeeper.js';
import { AgentMemory, type MemoryFact } from '../pipeline/agent-memory.js';
import { buildCollectionIndex, searchCollection, type CollectionChunk } from '../collections/index.js';

export interface BrokerHit {
  source: 'agentkeeper' | 'agent-memory' | 'collections';
  score: number;
  title: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface BrokerRecallOptions {
  maxResults?: number;
  includeDocs?: boolean;
  includeCode?: boolean;
  docsPaths?: string[];
  preferSuccessful?: boolean;
  pathHints?: string[];
}

function tokenize(text: string): Set<string> {
  return new Set(
    String(text || '')
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
    if (b.has(token)) intersection += 1;
  }
  return intersection / Math.max(a.size, b.size);
}

function mapKeeperHit(m: MemoryMatch): BrokerHit {
  return {
    source: 'agentkeeper',
    score: Number(m.score || 0),
    title: `[${m.entry.tier}] ${m.entry.task}`,
    text: m.entry.result,
    metadata: {
      agent: m.entry.agent,
      runId: m.entry.runId,
      timestamp: m.entry.timestamp
    }
  };
}

function mapFactHit(f: MemoryFact, score: number): BrokerHit {
  return {
    source: 'agent-memory',
    score: Number(score.toFixed(3)),
    title: `[${f.critical ? 'CRITICAL' : 'INFO'}] ${f.tags.join(', ') || 'memory-fact'}`,
    text: f.content,
    metadata: {
      critical: f.critical,
      tags: f.tags,
      timestamp: f.timestamp,
      provider: f.provider
    }
  };
}

function mapCollectionHit(c: CollectionChunk): BrokerHit {
  return {
    source: 'collections',
    score: Number(c.score || 0),
    title: `${c.source}:${c.startLine}`,
    text: c.text,
    metadata: {
      path: c.source,
      startLine: c.startLine
    }
  };
}

function normalizeCollectionPathForDedupe(input: string): string {
  const value = String(input || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (value.startsWith('docs/')) return value.slice('docs/'.length);
  return value;
}

export class MemoryBroker {
  private readonly projectDir: string;
  private readonly keeper: AgentKeeper;
  private readonly factMemory: AgentMemory;
  private readonly docsIndexCache = new Map<string, Awaited<ReturnType<typeof buildCollectionIndex>>>();

  constructor(projectDir: string, options: { crewId?: string; storageDir?: string } = {}) {
    this.projectDir = resolve(projectDir);
    this.keeper = new AgentKeeper(this.projectDir, {
      storageDir: options.storageDir || process.env.CREW_MEMORY_DIR
    });
    this.factMemory = new AgentMemory(options.crewId || 'crew-lead', {
      storageDir: options.storageDir || process.env.CREW_MEMORY_DIR || this.projectDir
    });
  }

  private scoreFacts(query: string, facts: MemoryFact[], max: number): BrokerHit[] {
    const queryTokens = tokenize(query);
    const scored = facts.map(f => {
      const sim = similarity(queryTokens, tokenize(f.content));
      const criticalBoost = f.critical ? 0.3 : 0;  // Increased from 0.1
      const tagBoost = f.tags.some(t => query.toLowerCase().includes(t.toLowerCase())) ? 0.15 : 0;
      return { fact: f, score: sim + criticalBoost + tagBoost };
    }).filter(x => x.score > 0.08);  // Lowered from 0.12 to catch critical facts

    // Force critical facts to top even if similarity is lower
    scored.sort((a, b) => {
      if (a.fact.critical && !b.fact.critical) return -1;
      if (!a.fact.critical && b.fact.critical) return 1;
      return b.score - a.score;
    });
    
    return scored.slice(0, max).map(x => mapFactHit(x.fact, x.score));
  }

  private async getDocsIndex(paths: string[], includeCode: boolean) {
    const key = `${paths.map(p => resolve(p)).join('|')}::${includeCode ? 'code' : 'docs'}`;
    if (this.docsIndexCache.has(key)) return this.docsIndexCache.get(key)!;
    const idx = await buildCollectionIndex(paths, { includeCode });
    this.docsIndexCache.set(key, idx);
    return idx;
  }

  async recall(query: string, options: BrokerRecallOptions = {}): Promise<BrokerHit[]> {
    const maxResults = Math.max(1, Number(options.maxResults || 5));
    const includeDocs = options.includeDocs !== false;
    const includeCode = Boolean(options.includeCode);
    const docsPaths = (options.docsPaths && options.docsPaths.length > 0)
      ? options.docsPaths
      : [join(this.projectDir, 'docs'), this.projectDir];

    const [keeperHits, factHits, collectionHits] = await Promise.all([
      this.keeper.recall(query, Math.max(maxResults, 8), {
        preferSuccessful: options.preferSuccessful !== false,
        pathHints: options.pathHints || []
      }),
      this.factMemory.search(query, { maxResults: Math.max(maxResults, 8) }),
      includeDocs
        ? (async () => {
          const index = await this.getDocsIndex(docsPaths, includeCode);
          return searchCollection(index, query, Math.max(maxResults, 8)).hits;
        })()
        : Promise.resolve([])
    ]);

    const merged = [
      ...keeperHits.map(mapKeeperHit),
      ...this.scoreFacts(query, factHits, Math.max(maxResults, 8)),
      ...collectionHits.map(mapCollectionHit)
    ];

    merged.sort((a, b) => b.score - a.score);

    // Dedupe near-identical collection hits that appear when both docs/ and repo root
    // are indexed together (same chunk can be surfaced twice with different source paths).
    const seen = new Set<string>();
    const deduped: BrokerHit[] = [];
    for (const hit of merged) {
      let signature = `${hit.source}|${hit.title}|${hit.text.slice(0, 180)}`;
      if (hit.source === 'collections') {
        const path = normalizeCollectionPathForDedupe(String(hit.metadata?.path || hit.title.split(':')[0] || ''));
        const startLine = Number(hit.metadata?.startLine || 0);
        signature = `${hit.source}|${path}|${startLine}|${hit.text.slice(0, 220)}`;
      }
      if (seen.has(signature)) continue;
      seen.add(signature);
      deduped.push(hit);
      if (deduped.length >= maxResults) break;
    }
    return deduped;
  }

  async recallAsContext(query: string, options: BrokerRecallOptions = {}): Promise<string> {
    const hits = await this.recall(query, options);
    if (hits.length === 0) return '';
    const lines = ['## Shared Memory + RAG Context'];
    for (const h of hits) {
      const preview = h.text.length > 260 ? `${h.text.slice(0, 260)}...` : h.text;
      lines.push(`### [${h.source}] ${h.title} (score: ${h.score.toFixed(3)})`);
      lines.push(preview);
      lines.push('');
    }
    return lines.join('\n');
  }
}
