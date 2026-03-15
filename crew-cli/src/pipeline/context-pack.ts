import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PlanningArtifacts } from '../prompts/dual-l2.js';

interface ContextChunk {
  id: string;
  source: 'PDD.md' | 'ROADMAP.md' | 'ARCH.md' | 'SCAFFOLD.md' | 'CONTRACT-TESTS.md' | 'DOD.md' | 'GOLDEN-BENCHMARKS.md';
  ordinal: number;
  text: string;
  terms: string[];
}

interface ContextPack {
  id: string;
  traceId: string;
  createdAt: string;
  chunks: ContextChunk[];
}

export class ContextPackManager {
  private packs = new Map<string, ContextPack>();
  private cacheDir = resolve(process.cwd(), '.crew', 'context-packs');
  private ttlHours = this.resolveTtlHours();

  createPack(traceId: string, artifacts: PlanningArtifacts): string {
    this.ensureCacheDir();
    this.compactCache();
    const key = this.computePackKey(artifacts);
    const id = `pack-${key.slice(0, 12)}`;
    const path = join(this.cacheDir, `${key}.json`);
    const nowIso = new Date().toISOString();

    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        const chunks = Array.isArray(parsed?.chunks) ? parsed.chunks : [];
        const cached: ContextPack = {
          id,
          traceId,
          createdAt: String(parsed?.createdAt || nowIso),
          chunks
        };
        this.packs.set(id, cached);
        return id;
      } catch {
        // Rebuild cache on parse failure.
      }
    }

    const chunks: ContextChunk[] = [
      ...this.chunkDoc('PDD.md', artifacts.pdd),
      ...this.chunkDoc('ROADMAP.md', artifacts.roadmap),
      ...this.chunkDoc('ARCH.md', artifacts.architecture),
      ...this.chunkDoc('SCAFFOLD.md', artifacts.scaffold),
      ...this.chunkDoc('CONTRACT-TESTS.md', artifacts.contractTests),
      ...this.chunkDoc('DOD.md', artifacts.definitionOfDone),
      ...this.chunkDoc('GOLDEN-BENCHMARKS.md', artifacts.goldenBenchmarks)
    ];
    const pack: ContextPack = {
      id,
      traceId,
      createdAt: nowIso,
      chunks
    };
    this.packs.set(id, pack);
    writeFileSync(path, JSON.stringify({ createdAt: nowIso, chunks }, null, 2), 'utf8');
    return id;
  }

  retrieve(packId: string, options: {
    query: string;
    sourceRefs?: string[];
    budgetChars?: number;
    maxChunks?: number;
  }): string {
    const pack = this.packs.get(packId);
    if (!pack) return '';

    const queryTerms = this.extractTerms(options.query || '');
    const refSources = new Set(
      (options.sourceRefs || [])
        .map(ref => String(ref || '').trim())
        .filter(Boolean)
        .map(ref => {
          const file = ref.split('#')[0] || '';
          if (file.endsWith('PDD.md')) return 'PDD.md';
          if (file.endsWith('ROADMAP.md')) return 'ROADMAP.md';
          if (file.endsWith('ARCH.md')) return 'ARCH.md';
          if (file.endsWith('SCAFFOLD.md')) return 'SCAFFOLD.md';
          if (file.endsWith('CONTRACT-TESTS.md')) return 'CONTRACT-TESTS.md';
          if (file.endsWith('DOD.md')) return 'DOD.md';
          if (file.endsWith('GOLDEN-BENCHMARKS.md')) return 'GOLDEN-BENCHMARKS.md';
          return '';
        })
        .filter(Boolean)
    );

    const scored = pack.chunks.map(chunk => {
      let score = 0;
      if (refSources.has(chunk.source)) score += 100;
      for (const term of queryTerms) {
        if (chunk.terms.includes(term)) score += 3;
      }
      return { chunk, score };
    });

    scored.sort((a, b) => b.score - a.score || a.chunk.ordinal - b.chunk.ordinal);

    const maxChunks = Math.max(1, Number(options.maxChunks || 6));
    const budget = Math.max(1200, Number(options.budgetChars || 6000));
    const selected: ContextChunk[] = [];
    let used = 0;

    for (const item of scored) {
      if (selected.length >= maxChunks) break;
      const block = `[${item.chunk.source}#${item.chunk.ordinal}]\n${item.chunk.text}\n`;
      if (used + block.length > budget) continue;
      selected.push(item.chunk);
      used += block.length;
    }

    return selected
      .map(c => `[${c.source}#${c.ordinal}]\n${c.text}`)
      .join('\n\n');
  }

  getPackStats(packId: string): { chunks: number } {
    const pack = this.packs.get(packId);
    return { chunks: pack?.chunks.length || 0 };
  }

  private resolveTtlHours(): number {
    const raw = Number(process.env.CREW_CONTEXT_PACK_TTL_HOURS || 24);
    if (!Number.isFinite(raw) || raw < 1) return 24;
    return Math.min(24 * 14, Math.floor(raw));
  }

  private ensureCacheDir() {
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  private computePackKey(artifacts: PlanningArtifacts): string {
    const body = [
      artifacts.pdd,
      artifacts.roadmap,
      artifacts.architecture,
      artifacts.scaffold,
      artifacts.contractTests,
      artifacts.definitionOfDone,
      artifacts.goldenBenchmarks
    ].join('\n---\n');
    return createHash('sha256').update(body).digest('hex');
  }

  private compactCache() {
    if (!existsSync(this.cacheDir)) return;
    const now = Date.now();
    const ttlMs = this.ttlHours * 60 * 60 * 1000;
    for (const entry of readdirSync(this.cacheDir)) {
      const full = join(this.cacheDir, entry);
      try {
        const stat = statSync(full);
        if ((now - stat.mtimeMs) > ttlMs) {
          unlinkSync(full);
        }
      } catch {
        // Best effort cleanup.
      }
    }
  }

  private chunkDoc(source: ContextChunk['source'], text: string): ContextChunk[] {
    const raw = String(text || '').trim();
    if (!raw) return [];
    const normalized = raw.replace(/\r\n/g, '\n');
    const chunkSize = 2200;
    const overlap = 200;
    const out: ContextChunk[] = [];
    let start = 0;
    let ordinal = 1;
    while (start < normalized.length) {
      const end = Math.min(normalized.length, start + chunkSize);
      const slice = normalized.slice(start, end);
      out.push({
        id: `${source}-${ordinal}`,
        source,
        ordinal,
        text: slice,
        terms: this.extractTerms(slice)
      });
      if (end >= normalized.length) break;
      start = Math.max(start + 1, end - overlap);
      ordinal += 1;
    }
    return out;
  }

  private extractTerms(input: string): string[] {
    const words = String(input || '')
      .toLowerCase()
      .split(/[^a-z0-9_.#-]+/g)
      .filter(w => w.length >= 3);
    return Array.from(new Set(words)).slice(0, 300);
  }
}
