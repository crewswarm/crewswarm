/**
 * crew-cli RAG API Server
 * 
 * Exposes codebase RAG (keyword + import graph + semantic) as HTTP API
 * so crew-lead, Telegram, Dashboard can search code files.
 * 
 * Usage:
 *   crew serve --port 5030
 *   GET /api/rag/search?q=auth&projectDir=/path&mode=import-graph
 */

import express from 'express';
import { autoLoadRelevantFiles, shouldUseRag } from '../context/codebase-rag.js';
import type { RagMode, RagResult } from '../context/codebase-rag.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface RagServerOptions {
  port?: number;
  host?: string;
  verbose?: boolean;
}

/**
 * Start crew-cli RAG API server
 */
export async function startRagServer(options: RagServerOptions = {}) {
  const { port = 5030, host = '127.0.0.1', verbose = false } = options;

  const app = express();
  app.use(express.json());

  // Health check
  app.get('/health', (req, res) => {
    res.json({ ok: true, service: 'crew-cli-rag', version: '1.0.0' });
  });

  // GET /api/rag/search?q=auth+endpoint&projectDir=/path&mode=import-graph&tokenBudget=8000&maxFiles=10
  app.get('/api/rag/search', async (req: { query: Record<string, string> }, res: { json(data: unknown): void; status(code: number): { json(data: unknown): void } }) => {
    try {
      const query = String(req.query.q || '');
      const projectDir = resolve(String(req.query.projectDir || process.cwd()));
      const mode = (req.query.mode as RagMode) || 'import-graph';
      const tokenBudget = Number(req.query.tokenBudget || 8000);
      const maxFiles = Number(req.query.maxFiles || 10);

      if (!query) {
        return res.status(400).json({ error: 'Missing query parameter: q' });
      }

      if (!existsSync(projectDir)) {
        return res.status(404).json({ error: `Project directory not found: ${projectDir}` });
      }

      // Check if RAG should run
      const shouldRun = shouldUseRag(query);
      if (!shouldRun && verbose) {
        console.log(`[rag-server] Query "${query}" does not need RAG (no coding keywords)`);
      }

      // Run RAG
      const startTime = Date.now();
      const result: RagResult = await autoLoadRelevantFiles(query, projectDir, {
        mode,
        tokenBudget,
        maxFiles,
        sessionHistory: []
      });

      const elapsed = Date.now() - startTime;

      if (verbose) {
        console.log(`[rag-server] Query: "${query}"`);
        console.log(`[rag-server] Mode: ${mode}`);
        console.log(`[rag-server] Files loaded: ${result.filesLoaded.length}`);
        console.log(`[rag-server] Tokens: ${result.tokenEstimate}`);
        console.log(`[rag-server] Elapsed: ${elapsed}ms`);
      }

      res.json({
        query,
        projectDir,
        mode: result.mode,
        filesLoaded: result.filesLoaded,
        tokenEstimate: result.tokenEstimate,
        context: result.context,
        elapsedMs: elapsed,
        shouldUseRag: shouldRun
      });
    } catch (error) {
      console.error('[rag-server] Search error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/rag/index - Force re-index (for semantic mode)
  app.post('/api/rag/index', async (req: { body: Record<string, string> }, res: { json(data: unknown): void; status(code: number): { json(data: unknown): void } }) => {
    try {
      const projectDir = resolve(req.body.projectDir || process.cwd());

      if (!existsSync(projectDir)) {
        return res.status(404).json({ error: `Project directory not found: ${projectDir}` });
      }

      // Run RAG in semantic mode to force index build
      const result = await autoLoadRelevantFiles('index build', projectDir, {
        mode: 'semantic',
        tokenBudget: 1000,
        maxFiles: 5
      });

      res.json({
        ok: true,
        projectDir,
        message: 'Index built (semantic embeddings)',
        filesIndexed: result.filesLoaded.length
      });
    } catch (error) {
      console.error('[rag-server] Index error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/rag/stats?projectDir=/path - Cache statistics
  app.get('/api/rag/stats', async (req, res) => {
    try {
      const projectDir = resolve(String(req.query.projectDir || process.cwd()));
      const cacheDir = process.env.CREW_RAG_CACHE_DIR || `${projectDir}/.crew/rag-cache`;

      const stats = {
        projectDir,
        cacheDir,
        exists: existsSync(cacheDir),
        modes: {
          keyword: 'always available (no cache)',
          importGraph: 'always available (no cache)',
          semantic: existsSync(`${cacheDir}/embeddings.json`) ? 'cached' : 'not cached'
        }
      };

      res.json(stats);
    } catch (error) {
      console.error('[rag-server] Stats error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Start server
  return new Promise<void>((resolve) => {
    app.listen(port, host, () => {
      console.log(`✅ crew-cli RAG API server running on http://${host}:${port}`);
      console.log(`   GET  /api/rag/search?q=auth&projectDir=/path&mode=import-graph`);
      console.log(`   POST /api/rag/index (body: {projectDir})`);
      console.log(`   GET  /api/rag/stats?projectDir=/path`);
      console.log(`   GET  /health`);
      resolve();
    });
  });
}
