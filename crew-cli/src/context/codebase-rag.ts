/**
 * Codebase RAG - Auto-load relevant files for LLM context
 * 
 * Three modes:
 * 1. Keyword-based (fast, local, no cost)
 * 2. Import graph (smarter, local, no cost)
 * 3. Semantic (best, requires embeddings, ~$0.02 one-time)
 */

import { execSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { relative, join } from 'node:path';
import { buildRepositoryGraph } from '../mapping/index.js';
import type { RepositoryGraph } from '../mapping/index.js';

export type RagMode = 'keyword' | 'import-graph' | 'semantic' | 'off';

export interface RagOptions {
  mode?: RagMode;
  tokenBudget?: number;
  maxFiles?: number;
  sessionHistory?: any[];
  cacheDir?: string;
}

export interface RagResult {
  context: string;
  filesLoaded: string[];
  mode: RagMode;
  tokenEstimate: number;
}

/**
 * Extract keywords from user query
 */
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

/**
 * Phase 1: Keyword-based file matching
 */
async function keywordBasedSearch(
  query: string,
  cwd: string,
  options: RagOptions
): Promise<Array<{ file: string; score: number }>> {
  const keywords = extractKeywords(query);
  
  if (keywords.length === 0) return [];
  
  try {
    // Grep for files containing keywords
    const pattern = keywords.slice(0, 5).join('|');
    const stdout = execSync(
      `rg -l "${pattern}" --type-add 'code:*.{ts,js,tsx,jsx,py,go,rs,java}' -t code`,
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        stdio: ['pipe', 'pipe', 'ignore']
      }
    );
    
    const files = stdout.trim().split('\n').filter(Boolean);
    
    // Score files by keyword density in filename
    return files.map(file => {
      let score = 0;
      const lowerFile = file.toLowerCase();
      
      for (const kw of keywords) {
        if (lowerFile.includes(kw)) score += 2;
      }
      
      // Boost recently accessed files
      for (const entry of options.sessionHistory || []) {
        if (entry.output?.includes(file)) score += 3;
      }
      
      return { file, score };
    });
  } catch (err) {
    // Grep failed or no matches
    return [];
  }
}

/**
 * Phase 2: Import graph expansion
 */
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
        // Add direct imports
        for (const importPath of node.imports.slice(0, 5)) {
          expanded.add(importPath);
        }
        
        // Add what imports this file (reverse dependencies)
        for (const importedByPath of node.importedBy.slice(0, 3)) {
          expanded.add(importedByPath);
        }
      }
    }
  } catch (err) {
    // Graph building failed, return original files
    console.warn('[RAG] Import graph expansion failed:', err.message);
  }
  
  return expanded;
}

/**
 * Phase 3: Semantic search using embeddings
 */
interface EmbeddingEntry {
  file: string;
  embedding: number[];
  hash: string;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function generateEmbedding(text: string): Promise<number[]> {
  // Check for OpenAI API key
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not set - required for semantic RAG');
  }
  
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text.slice(0, 8000) // Max ~8K chars
    })
  });
  
  if (!response.ok) {
    throw new Error(`Embedding API failed: ${response.statusText}`);
  }
  
  const data = await response.json();
  return data.data[0].embedding;
}

async function loadEmbeddingsIndex(cacheDir: string): Promise<EmbeddingEntry[]> {
  const indexPath = join(cacheDir, 'embeddings.json');
  
  if (!existsSync(indexPath)) {
    return [];
  }
  
  try {
    const raw = await readFile(indexPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveEmbeddingsIndex(
  cacheDir: string,
  embeddings: EmbeddingEntry[]
): Promise<void> {
  const indexPath = join(cacheDir, 'embeddings.json');
  await mkdir(cacheDir, { recursive: true });
  await writeFile(indexPath, JSON.stringify(embeddings, null, 2), 'utf8');
}

async function semanticSearch(
  query: string,
  cwd: string,
  options: RagOptions
): Promise<Array<{ file: string; score: number }>> {
  const cacheDir = options.cacheDir || join(cwd, '.crew', 'rag-cache');
  
  // Load existing embeddings
  let embeddings = await loadEmbeddingsIndex(cacheDir);
  
  // If empty, need to build index first
  if (embeddings.length === 0) {
    console.log('[RAG] No embeddings index found. Building index...');
    console.log('[RAG] This is a one-time operation (~30s for 1K files)');
    
    try {
      // Find all code files
      const stdout = execSync(
        `rg --files --type-add 'code:*.{ts,js,tsx,jsx,py,go,rs,java}' -t code`,
        { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 }
      );
      
      const files = stdout.trim().split('\n').filter(Boolean).slice(0, 1000); // Max 1K files
      
      console.log(`[RAG] Generating embeddings for ${files.length} files...`);
      
      // Generate embeddings (batched)
      const batchSize = 10;
      for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);
        
        for (const file of batch) {
          try {
            const content = await readFile(join(cwd, file), 'utf8');
            const embedding = await generateEmbedding(content);
            embeddings.push({
              file,
              embedding,
              hash: '' // Could add content hash for staleness detection
            });
          } catch (err) {
            console.warn(`[RAG] Failed to embed ${file}:`, err.message);
          }
        }
        
        // Progress
        console.log(`[RAG] Progress: ${Math.min(i + batchSize, files.length)}/${files.length}`);
      }
      
      // Save index
      await saveEmbeddingsIndex(cacheDir, embeddings);
      console.log(`[RAG] Index saved to ${cacheDir}/embeddings.json`);
    } catch (err) {
      console.warn('[RAG] Failed to build embeddings index:', err.message);
      return [];
    }
  }
  
  // Generate query embedding
  const queryEmbedding = await generateEmbedding(query);
  
  // Compute similarities
  const scored = embeddings.map(entry => ({
    file: entry.file,
    score: cosineSimilarity(queryEmbedding, entry.embedding)
  }));
  
  scored.sort((a, b) => b.score - a.score);
  
  return scored;
}

/**
 * Main entry point - auto-load relevant files
 */
export async function autoLoadRelevantFiles(
  query: string,
  cwd: string,
  options: RagOptions = {}
): Promise<RagResult> {
  const mode = options.mode || 'keyword';
  const tokenBudget = options.tokenBudget || 8000;
  const maxFiles = options.maxFiles || 10;
  
  if (mode === 'off') {
    return {
      context: '',
      filesLoaded: [],
      mode: 'off',
      tokenEstimate: 0
    };
  }
  
  let scoredFiles: Array<{ file: string; score: number }> = [];
  
  // Step 1: Get initial matches
  if (mode === 'semantic') {
    try {
      scoredFiles = await semanticSearch(query, cwd, options);
    } catch (err) {
      console.warn('[RAG] Semantic search failed, falling back to keyword:', err.message);
      scoredFiles = await keywordBasedSearch(query, cwd, options);
    }
  } else {
    scoredFiles = await keywordBasedSearch(query, cwd, options);
  }
  
  if (scoredFiles.length === 0) {
    return {
      context: '',
      filesLoaded: [],
      mode,
      tokenEstimate: 0
    };
  }
  
  // Step 2: Expand with imports (if mode is import-graph or semantic)
  let filesToLoad = scoredFiles.map(x => x.file);
  
  if (mode === 'import-graph' || mode === 'semantic') {
    const expanded = await expandWithImports(filesToLoad.slice(0, 5), cwd);
    filesToLoad = Array.from(expanded);
  }
  
  // Step 3: Load files within budget
  const loaded: string[] = [];
  let contextParts: string[] = [];
  let charsUsed = 0;
  const charBudget = tokenBudget * 4; // ~4 chars per token
  
  // Re-score expanded files (prioritize original matches)
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
      
      if (charsUsed + content.length > charBudget) {
        // Budget exceeded, stop loading
        break;
      }
      
      const relPath = relative(cwd, file);
      contextParts.push(`\n=== ${relPath} ===\n${content}`);
      loaded.push(relPath);
      charsUsed += content.length;
    } catch (err) {
      // File read failed, skip
      console.warn(`[RAG] Failed to read ${file}:`, err.message);
    }
  }
  
  if (loaded.length === 0) {
    return {
      context: '',
      filesLoaded: [],
      mode,
      tokenEstimate: 0
    };
  }
  
  const context = `## Relevant Codebase Context (${loaded.length} files loaded)\n${contextParts.join('\n\n')}`;
  const tokenEstimate = Math.ceil(charsUsed / 4);
  
  return {
    context,
    filesLoaded: loaded,
    mode,
    tokenEstimate
  };
}

/**
 * Check if query should trigger RAG
 */
export function shouldUseRag(query: string): boolean {
  const lower = query.toLowerCase();
  
  // Execution intents
  const hasExecutionIntent = /\b(implement|create|build|write|fix|refactor|modify|update|add|patch|test)\b/.test(lower);
  
  // Code references
  const hasCodeReference = /\/src\/|\.ts\b|\.js\b|\.tsx\b|\.py\b|\.go\b/.test(query);
  
  // File operations
  const hasFileOperation = /\b(file|function|class|component|endpoint|route|middleware)\b/.test(lower);
  
  return hasExecutionIntent || hasCodeReference || hasFileOperation;
}

/**
 * Rebuild embeddings index (for semantic mode)
 */
export async function rebuildEmbeddingsIndex(
  cwd: string,
  cacheDir?: string
): Promise<void> {
  const dir = cacheDir || join(cwd, '.crew', 'rag-cache');
  
  // Clear existing index
  const indexPath = join(dir, 'embeddings.json');
  if (existsSync(indexPath)) {
    await writeFile(indexPath, '[]', 'utf8');
  }
  
  // Trigger rebuild by running a semantic search
  await semanticSearch('rebuild index', cwd, { cacheDir: dir });
}
