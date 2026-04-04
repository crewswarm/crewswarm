/**
 * Codebase RAG - Auto-load relevant files for LLM context
 *
 * Three modes:
 * 1. Keyword-based (fast, local, no cost)
 * 2. Import graph (smarter, local, no cost)
 * 3. Semantic (best, requires embeddings API or uses local hashed vectors)
 *
 * CodebaseIndex: persistent, incremental embedding index that auto-builds
 * in the background on startup and re-embeds only changed files.
 */

import { execSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { relative, join } from 'node:path';
import { buildRepositoryGraph } from '../mapping/index.js';
import type { RepositoryGraph } from '../mapping/index.js';

export type RagMode = 'keyword' | 'import-graph' | 'semantic' | 'auto' | 'off';

export interface RagOptions {
  mode?: RagMode;
  tokenBudget?: number;
  maxFiles?: number;
  sessionHistory?: Array<{ output?: string }>;
  cacheDir?: string;
}

export interface RagResult {
  context: string;
  filesLoaded: string[];
  mode: RagMode;
  tokenEstimate: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractKeywords(query: string): string[] {
  return (query
    .toLowerCase()
    .match(/\b[a-z]{3,}\b/g) || [])
    .filter(kw => !STOP_WORDS.has(kw));
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'are', 'was', 'were',
  'will', 'can', 'could', 'should', 'would', 'add', 'create', 'make', 'write',
  'update', 'fix', 'change', 'modify', 'delete', 'remove', 'get', 'set'
]);

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// ── Local hashed vector (zero-cost fallback) ──────────────────────────────

function toHashedVector(text: string, dim = 256): Float64Array {
  const vec = new Float64Array(dim);
  const tokens = text.toLowerCase().split(/\W+/).filter(t => t.length > 2);
  for (const token of tokens) {
    let h = 0;
    for (let i = 0; i < token.length; i++) {
      h = ((h << 5) - h + token.charCodeAt(i)) | 0;
    }
    const idx = ((h % dim) + dim) % dim;
    vec[idx] += 1;
  }
  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}

function cosineSimilarity(a: number[] | Float64Array, b: number[] | Float64Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// ── Embedding providers ───────────────────────────────────────────────────

type EmbeddingProvider = 'openai' | 'gemini' | 'local';

function detectEmbeddingProvider(): EmbeddingProvider {
  const explicit = String(process.env.CREW_EMBEDDING_PROVIDER || '').toLowerCase();
  if (explicit === 'openai' || explicit === 'gemini' || explicit === 'local') return explicit;
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return 'gemini';
  return 'local';
}

async function generateEmbedding(text: string, provider?: EmbeddingProvider): Promise<number[]> {
  const p = provider || detectEmbeddingProvider();

  if (p === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 8000) })
    });
    if (!response.ok) throw new Error(`OpenAI embedding failed: ${response.statusText}`);
    const data = await response.json();
    return (data as { data: Array<{ embedding: number[] }> }).data[0].embedding;
  }

  if (p === 'gemini') {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'models/text-embedding-004',
          content: { parts: [{ text: text.slice(0, 8000) }] }
        })
      }
    );
    if (!response.ok) throw new Error(`Gemini embedding failed: ${response.statusText}`);
    const data = await response.json();
    return (data as { embedding?: { values?: number[] } }).embedding?.values || [];
  }

  // Local: hashed vector (zero-cost, ~80% as good for code search)
  return Array.from(toHashedVector(text));
}

// ── CodebaseIndex (persistent, incremental) ───────────────────────────────

interface IndexEntry {
  file: string;
  embedding: number[];
  hash: string;
}

interface IndexMeta {
  provider: EmbeddingProvider;
  dim: number;
  fileCount: number;
  lastUpdated: string;
}

export class CodebaseIndex {
  private cwd: string;
  private cacheDir: string;
  private entries: IndexEntry[] = [];
  private entryMap = new Map<string, IndexEntry>();
  private meta: IndexMeta | null = null;
  private loaded = false;
  private building = false;
  private provider: EmbeddingProvider;

  private static instances = new Map<string, CodebaseIndex>();

  static getInstance(cwd: string): CodebaseIndex {
    const existing = CodebaseIndex.instances.get(cwd);
    if (existing) return existing;
    const inst = new CodebaseIndex(cwd);
    CodebaseIndex.instances.set(cwd, inst);
    return inst;
  }

  private constructor(cwd: string) {
    this.cwd = cwd;
    this.cacheDir = join(cwd, '.crew', 'rag-cache');
    this.provider = detectEmbeddingProvider();
  }

  private indexPath() { return join(this.cacheDir, 'embeddings.json'); }
  private metaPath() { return join(this.cacheDir, 'index-meta.json'); }

  /** Load index from disk if not already loaded. */
  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      if (existsSync(this.indexPath())) {
        const raw = await readFile(this.indexPath(), 'utf8');
        this.entries = JSON.parse(raw);
        this.entryMap.clear();
        for (const e of this.entries) this.entryMap.set(e.file, e);
      }
      if (existsSync(this.metaPath())) {
        this.meta = JSON.parse(await readFile(this.metaPath(), 'utf8'));
      }
    } catch { /* corrupt index — will rebuild */ }
    this.loaded = true;
  }

  /** Save index to disk. */
  private async save(): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
    await writeFile(this.indexPath(), JSON.stringify(this.entries), 'utf8');
    this.meta = {
      provider: this.provider,
      dim: this.entries[0]?.embedding.length || 0,
      fileCount: this.entries.length,
      lastUpdated: new Date().toISOString()
    };
    await writeFile(this.metaPath(), JSON.stringify(this.meta, null, 2), 'utf8');
  }

  /** List code files in the repo (respects .gitignore). */
  private listFiles(): string[] {
    try {
      const maxFiles = Number(process.env.CREW_RAG_MAX_FILES || 2000);
      const stdout = execSync(
        `rg --files --type-add 'code:*.{ts,js,tsx,jsx,py,go,rs,java,rb,php,c,cpp,h,hpp,cs,swift,kt,scala,lua,sh,bash,zsh,sql,proto,graphql,vue,svelte}' -t code`,
        { cwd: this.cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] }
      );
      return stdout.trim().split('\n').filter(Boolean).slice(0, maxFiles);
    } catch {
      return [];
    }
  }

  /**
   * Ensure the index is built and up-to-date. Incrementally re-embeds only changed files.
   * Safe to call from background — non-blocking if already building.
   */
  async ensureIndex(opts?: { onProgress?: (done: number, total: number) => void }): Promise<{ indexed: number; skipped: number; removed: number }> {
    if (this.building) return { indexed: 0, skipped: 0, removed: 0 };
    this.building = true;

    try {
      await this.load();

      const files = this.listFiles();
      if (files.length === 0) return { indexed: 0, skipped: 0, removed: 0 };

      // If provider changed, invalidate entire index
      if (this.meta && this.meta.provider !== this.provider) {
        this.entries = [];
        this.entryMap.clear();
      }

      const currentFiles = new Set(files);
      let indexed = 0;
      let skipped = 0;

      // Remove entries for deleted files
      const removed = this.entries.filter(e => !currentFiles.has(e.file)).length;
      this.entries = this.entries.filter(e => currentFiles.has(e.file));
      this.entryMap.clear();
      for (const e of this.entries) this.entryMap.set(e.file, e);

      // Process files — skip unchanged (same content hash)
      const batchSize = Number(process.env.CREW_RAG_BATCH_SIZE || 20);
      for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);

        const work: Array<{ file: string; content: string; hash: string }> = [];
        for (const file of batch) {
          try {
            const content = await readFile(join(this.cwd, file), 'utf8');
            if (content.length < 10) continue; // skip near-empty files
            if (content.length > 100_000) continue; // skip massive generated files
            const hash = contentHash(content);
            const existing = this.entryMap.get(file);
            if (existing && existing.hash === hash) {
              skipped++;
              continue;
            }
            work.push({ file, content, hash });
          } catch { /* skip unreadable */ }
        }

        // Embed in parallel (up to batchSize concurrently)
        const results = await Promise.allSettled(
          work.map(async ({ file, content, hash }) => {
            const embedding = await generateEmbedding(content, this.provider);
            return { file, embedding, hash };
          })
        );

        for (const result of results) {
          if (result.status === 'fulfilled') {
            const entry = result.value;
            // Update or insert
            const existing = this.entryMap.get(entry.file);
            if (existing) {
              existing.embedding = entry.embedding;
              existing.hash = entry.hash;
            } else {
              this.entries.push(entry);
              this.entryMap.set(entry.file, entry);
            }
            indexed++;
          }
        }

        opts?.onProgress?.(Math.min(i + batchSize, files.length), files.length);
      }

      // Save if anything changed
      if (indexed > 0 || removed > 0) {
        await this.save();
      }

      return { indexed, skipped, removed };
    } finally {
      this.building = false;
    }
  }

  /** Query the index for files most relevant to a query string. */
  async query(query: string, topK = 10): Promise<Array<{ file: string; score: number }>> {
    await this.load();
    if (this.entries.length === 0) return [];

    const queryEmb = await generateEmbedding(query, this.provider);
    const scored = this.entries.map(entry => ({
      file: entry.file,
      score: cosineSimilarity(queryEmb, entry.embedding)
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /** Get index stats. */
  stats(): { files: number; provider: string; lastUpdated: string | null; building: boolean } {
    return {
      files: this.entries.length,
      provider: this.provider,
      lastUpdated: this.meta?.lastUpdated || null,
      building: this.building
    };
  }

  isReady(): boolean {
    return this.loaded && this.entries.length > 0 && !this.building;
  }
}

// ── Phase 1: Keyword-based file matching ──────────────────────────────────

async function keywordBasedSearch(
  query: string,
  cwd: string,
  options: RagOptions
): Promise<Array<{ file: string; score: number }>> {
  const keywords = extractKeywords(query);
  if (keywords.length === 0) return [];

  try {
    const pattern = keywords.slice(0, 5).join('|');
    const stdout = execSync(
      `rg -l "${pattern}" --type-add 'code:*.{ts,js,tsx,jsx,py,go,rs,java}' -t code`,
      { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] }
    );

    const files = stdout.trim().split('\n').filter(Boolean);
    return files.map(file => {
      let score = 0;
      const lowerFile = file.toLowerCase();
      for (const kw of keywords) {
        if (lowerFile.includes(kw)) score += 2;
      }
      for (const entry of options.sessionHistory || []) {
        if (entry.output?.includes(file)) score += 3;
      }
      return { file, score };
    });
  } catch {
    return [];
  }
}

// ── Phase 2: Import graph expansion ───────────────────────────────────────

async function expandWithImports(
  files: string[],
  cwd: string,
  maxDepth: number = 1
): Promise<Set<string>> {
  const expanded = new Set<string>(files);
  try {
    const graph = await buildRepositoryGraph(cwd);
    for (const file of files) {
      const node = graph.nodes.find(n => n.path === file || join(cwd, n.path) === file);
      if (node) {
        for (const importPath of node.imports.slice(0, 5)) expanded.add(importPath);
        for (const importedByPath of node.importedBy.slice(0, 3)) expanded.add(importedByPath);
      }
    }
  } catch (err) {
    console.warn('[RAG] Import graph expansion failed:', (err as Error).message);
  }
  return expanded;
}

// ── Main entry point ──────────────────────────────────────────────────────

export async function autoLoadRelevantFiles(
  query: string,
  cwd: string,
  options: RagOptions = {}
): Promise<RagResult> {
  const rawMode = options.mode || String(process.env.CREW_RAG_MODE || 'auto').toLowerCase() as RagMode;
  const tokenBudget = options.tokenBudget || Number(process.env.CREW_RAG_TOKEN_BUDGET || 8000);
  const maxFiles = options.maxFiles || Number(process.env.CREW_RAG_MAX_FILES_LOAD || 10);

  // Resolve 'auto': use semantic index if available, else keyword
  let mode: RagMode = rawMode;
  if (mode === 'auto') {
    const index = CodebaseIndex.getInstance(cwd);
    mode = index.isReady() ? 'semantic' : 'keyword';
  }

  if (mode === 'off') {
    return { context: '', filesLoaded: [], mode: 'off', tokenEstimate: 0 };
  }

  let scoredFiles: Array<{ file: string; score: number }> = [];

  if (mode === 'semantic') {
    try {
      const index = CodebaseIndex.getInstance(cwd);
      scoredFiles = await index.query(query, maxFiles * 2);
    } catch (err) {
      console.warn('[RAG] Semantic search failed, falling back to keyword:', (err as Error).message);
      scoredFiles = await keywordBasedSearch(query, cwd, options);
    }
  } else {
    scoredFiles = await keywordBasedSearch(query, cwd, options);
  }

  if (scoredFiles.length === 0) {
    return { context: '', filesLoaded: [], mode, tokenEstimate: 0 };
  }

  // Expand with imports (for import-graph and semantic modes)
  let filesToLoad = scoredFiles.map(x => x.file);
  if (mode === 'import-graph' || mode === 'semantic') {
    const expanded = await expandWithImports(filesToLoad.slice(0, 5), cwd);
    filesToLoad = Array.from(expanded);
  }

  // Load files within token budget
  const loaded: string[] = [];
  const contextParts: string[] = [];
  let charsUsed = 0;
  const charBudget = tokenBudget * 4;

  const originalSet = new Set(scoredFiles.slice(0, 10).map(x => x.file));
  const finalScored = filesToLoad.map(file => ({
    file,
    score: originalSet.has(file) ? 10 : 1
  }));
  finalScored.sort((a, b) => b.score - a.score);

  for (const { file } of finalScored.slice(0, maxFiles)) {
    try {
      const fullPath = join(cwd, file);
      const content = await readFile(fullPath, 'utf8');
      if (charsUsed + content.length > charBudget) break;
      const relPath = relative(cwd, file);
      contextParts.push(`\n=== ${relPath} ===\n${content}`);
      loaded.push(relPath);
      charsUsed += content.length;
    } catch {
      // skip unreadable
    }
  }

  if (loaded.length === 0) {
    return { context: '', filesLoaded: [], mode, tokenEstimate: 0 };
  }

  const context = `## Relevant Codebase Context (${loaded.length} files loaded via ${mode} RAG)\n${contextParts.join('\n\n')}`;
  const tokenEstimate = Math.ceil(charsUsed / 4);

  return { context, filesLoaded: loaded, mode, tokenEstimate };
}

/** Check if query should trigger RAG. */
export function shouldUseRag(query: string): boolean {
  const lower = query.toLowerCase();
  const hasExecutionIntent = /\b(implement|create|build|write|fix|refactor|modify|update|add|patch|test|debug|investigate|explain|how)\b/.test(lower);
  const hasCodeReference = /\/src\/|\.ts\b|\.js\b|\.tsx\b|\.py\b|\.go\b/.test(query);
  const hasFileOperation = /\b(file|function|class|component|endpoint|route|middleware|module|service|handler|controller)\b/.test(lower);
  return hasExecutionIntent || hasCodeReference || hasFileOperation;
}

/** Rebuild the entire index (clears cache). */
export async function rebuildEmbeddingsIndex(
  cwd: string,
  cacheDir?: string
): Promise<void> {
  const dir = cacheDir || join(cwd, '.crew', 'rag-cache');
  const indexPath = join(dir, 'embeddings.json');
  if (existsSync(indexPath)) {
    await writeFile(indexPath, '[]', 'utf8');
  }
  const index = CodebaseIndex.getInstance(cwd);
  await index.ensureIndex();
}
