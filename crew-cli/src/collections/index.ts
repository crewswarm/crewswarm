/**
 * Collections Search — lightweight local RAG over docs and markdown files.
 *
 * Indexes markdown / text files under configurable paths, builds a simple
 * TF-IDF–style term index, and returns ranked chunks with source attribution.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CollectionChunk {
  /** Relative path from the collection root */
  source: string;
  /** 1-based line number where the chunk starts */
  startLine: number;
  /** The raw text of the chunk */
  text: string;
  /** Relevance score (higher = more relevant) */
  score: number;
}

export interface CollectionIndex {
  root: string;
  fileCount: number;
  chunkCount: number;
  /** term → Set of chunk indices */
  terms: Map<string, Set<number>>;
  chunks: CollectionChunk[];
}

export interface BuildCollectionOptions {
  includeCode?: boolean;
}

export interface SearchResult {
  query: string;
  hits: CollectionChunk[];
  totalChunks: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst', '.adoc']);
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json',
  '.py', '.go', '.rs', '.java', '.kt', '.swift',
  '.sh', '.bash', '.zsh', '.yaml', '.yml', '.toml'
]);

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.crew',
  '.next', '.turbo', 'coverage', '__pycache__'
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

function hashToken(token: string, dim: number): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % dim;
}

function toHashedVector(text: string, dim = 256): Float64Array {
  const vec = new Float64Array(dim);
  const toks = tokenize(text);
  for (const t of toks) {
    vec[hashToken(t, dim)] += 1;
  }
  // l2 normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) vec[i] /= norm;
  }
  return vec;
}

function cosineSimilarity(a: Float64Array, b: Float64Array): number {
  const dim = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < dim; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Split a file into chunks — one chunk per heading section, or fixed-size
 * paragraphs for files without headings.
 */
function chunkFile(content: string, source: string): CollectionChunk[] {
  const lines = content.split('\n');
  const chunks: CollectionChunk[] = [];
  let currentLines: string[] = [];
  let currentStart = 1;

  const flush = () => {
    const text = currentLines.join('\n').trim();
    if (text.length > 0) {
      chunks.push({ source, startLine: currentStart, text, score: 0 });
    }
    currentLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Split on markdown headings
    if (/^#{1,4}\s/.test(line) && currentLines.length > 0) {
      flush();
      currentStart = i + 1;
    }
    currentLines.push(line);

    // Also split on large paragraphs (every ~40 lines if no heading)
    if (currentLines.length >= 40 && !/^#{1,4}\s/.test(line)) {
      flush();
      currentStart = i + 2;
    }
  }
  flush();
  return chunks;
}

// ---------------------------------------------------------------------------
// Walk & Index
// ---------------------------------------------------------------------------

async function walkDocs(rootDir: string, includeCode = false): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry)) continue;
      const fullPath = join(dir, entry);
      let st;
      try {
        st = await stat(fullPath);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        await walk(fullPath);
      } else {
        const ext = extname(entry).toLowerCase();
        if (DOC_EXTENSIONS.has(ext) || (includeCode && CODE_EXTENSIONS.has(ext))) {
        files.push(fullPath);
        }
      }
    }
  }

  await walk(rootDir);
  return files;
}

export async function buildCollectionIndex(
  paths: string[],
  options: BuildCollectionOptions = {}
): Promise<CollectionIndex> {
  const allChunks: CollectionChunk[] = [];
  const roots = paths.map(p => resolve(p));
  let fileCount = 0;

  for (const rootPath of roots) {
    let st;
    try {
      st = await stat(rootPath);
    } catch {
      continue;
    }

    const files = st.isDirectory() ? await walkDocs(rootPath, Boolean(options.includeCode)) : [rootPath];

    for (const file of files) {
      let content: string;
      try {
        content = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      fileCount++;
      const rel = relative(resolve(rootPath, st.isDirectory() ? '.' : '..'), file);
      const chunks = chunkFile(content, rel);
      allChunks.push(...chunks);
    }
  }

  // Build inverted term index
  const terms = new Map<string, Set<number>>();
  for (let i = 0; i < allChunks.length; i++) {
    const tokens = tokenize(allChunks[i].text);
    for (const token of tokens) {
      if (!terms.has(token)) terms.set(token, new Set());
      terms.get(token)!.add(i);
    }
  }

  return {
    root: roots[0] || '.',
    fileCount,
    chunkCount: allChunks.length,
    terms,
    chunks: allChunks
  };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export function searchCollection(
  index: CollectionIndex,
  query: string,
  maxResults = 10
): SearchResult {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return { query, hits: [], totalChunks: index.chunkCount };
  }

  // Score each chunk by number of matching query terms + term rarity (IDF-like)
  const scores = new Float64Array(index.chunkCount);

  for (const token of queryTokens) {
    const matchingChunks = index.terms.get(token);
    if (!matchingChunks) continue;
    // IDF-like weight: rarer terms score higher
    const idf = Math.log(1 + index.chunkCount / matchingChunks.size);
    for (const idx of matchingChunks) {
      scores[idx] += idf;
    }
  }

  // Collect non-zero scores
  const candidates: Array<{ idx: number; score: number }> = [];
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] > 0) {
      candidates.push({ idx: i, score: scores[i] });
    }
  }

  // Sort descending by score
  candidates.sort((a, b) => b.score - a.score);

  const queryVector = toHashedVector(query);
  const maxTfidf = candidates.length > 0 ? candidates[0].score : 1;
  const tfidfWeight = 0.7;
  const vectorWeight = 0.3;

  const hybrid = candidates.map(c => {
    const chunk = index.chunks[c.idx];
    const chunkVector = toHashedVector(chunk.text);
    const cosine = Math.max(0, cosineSimilarity(queryVector, chunkVector));
    const tfidfNorm = maxTfidf > 0 ? (c.score / maxTfidf) : 0;
    const hybridScore = (tfidfNorm * tfidfWeight) + (cosine * vectorWeight);
    return { idx: c.idx, score: hybridScore };
  });

  hybrid.sort((a, b) => b.score - a.score);

  const hits = hybrid.slice(0, maxResults).map(c => ({
    ...index.chunks[c.idx],
    score: Math.round(c.score * 1000) / 1000
  }));

  return { query, hits, totalChunks: index.chunkCount };
}
