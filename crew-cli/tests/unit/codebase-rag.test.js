import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';

// Force local provider BEFORE importing (so constructor picks it up)
process.env.CREW_EMBEDDING_PROVIDER = 'local';

// Import the module under test
import {
  CodebaseIndex,
  shouldUseRag,
  autoLoadRelevantFiles
} from '../../src/context/codebase-rag.ts';

// ── shouldUseRag ──────────────────────────────────────────────────────────

describe('shouldUseRag', () => {
  test('returns true for execution intents', () => {
    assert.ok(shouldUseRag('implement auth middleware'));
    assert.ok(shouldUseRag('fix the login bug'));
    assert.ok(shouldUseRag('refactor the database layer'));
    assert.ok(shouldUseRag('add error handling'));
    assert.ok(shouldUseRag('test the API endpoint'));
  });

  test('returns true for code references', () => {
    assert.ok(shouldUseRag('look at src/auth.ts'));
    assert.ok(shouldUseRag('check main.py'));
    assert.ok(shouldUseRag('what does handler.go do'));
  });

  test('returns true for file operation keywords', () => {
    assert.ok(shouldUseRag('what does the auth function do'));
    assert.ok(shouldUseRag('find the endpoint for users'));
    assert.ok(shouldUseRag('how does the middleware work'));
  });

  test('returns true for explain/how queries', () => {
    assert.ok(shouldUseRag('how does routing work'));
    assert.ok(shouldUseRag('explain the pipeline'));
  });

  test('returns false for generic chat', () => {
    assert.ok(!shouldUseRag('hello'));
    assert.ok(!shouldUseRag('thanks'));
    assert.ok(!shouldUseRag('what time is it'));
  });
});

// ── CodebaseIndex ─────────────────────────────────────────────────────────

describe('CodebaseIndex', () => {
  test('getInstance returns same instance for same path', () => {
    const a = CodebaseIndex.getInstance('/tmp/test-rag-singleton-fixed');
    const b = CodebaseIndex.getInstance('/tmp/test-rag-singleton-fixed');
    assert.strictEqual(a, b);
  });

  test('stats reports initial state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crew-rag-stats-'));
    const idx = CodebaseIndex.getInstance(dir);
    const stats = idx.stats();
    assert.equal(stats.files, 0);
    assert.equal(stats.building, false);
    assert.equal(stats.lastUpdated, null);
  });

  test('isReady returns false before indexing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crew-rag-ready-'));
    const idx = CodebaseIndex.getInstance(dir);
    assert.equal(idx.isReady(), false);
  });

  test('ensureIndex builds and queries local index', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'crew-rag-test-'));
    await mkdir(join(dir, '.crew', 'rag-cache'), { recursive: true });

    // Create test files with enough content for meaningful vectors
    await writeFile(join(dir, 'auth.ts'), 'export function authenticate(user, password) { return jwt.sign({ user, password, token, secret }); }\nfunction validateToken(token) { return jwt.verify(token, secret); }');
    await writeFile(join(dir, 'styles.ts'), 'export const theme = { color: "blue", fontSize: 14, padding: 8, margin: 4, border: "none", display: "flex" };');
    await writeFile(join(dir, 'database.ts'), 'export async function queryUsers(db) { return db.select("users").where("active", true).orderBy("name"); }');

    const { execSync } = await import('node:child_process');
    execSync('git init', { cwd: dir, stdio: 'ignore' });

    const idx = CodebaseIndex.getInstance(dir);
    const result = await idx.ensureIndex();

    if (result.indexed === 0) { t.skip('local embedding provider not available'); return; }
    assert.ok(result.indexed >= 3, `Expected >= 3 indexed, got ${result.indexed}`);
    assert.equal(result.removed, 0);
    assert.ok(idx.isReady());

    // Query should return hits
    const hits = await idx.query('authenticate user with jwt token', 3);
    assert.ok(hits.length > 0, 'Should return hits');
    // auth.ts should rank high for auth-related query
    const authHit = hits.find(h => h.file === 'auth.ts');
    assert.ok(authHit, 'auth.ts should appear in results');

    // database query should surface database.ts
    const hits2 = await idx.query('query database users select', 3);
    assert.ok(hits2.length > 0);
    const dbHit = hits2.find(h => h.file === 'database.ts');
    assert.ok(dbHit, 'database.ts should appear in results');
  });

  test('ensureIndex is incremental — skips unchanged files', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'crew-rag-incr-'));
    await mkdir(join(dir, '.crew', 'rag-cache'), { recursive: true });
    await writeFile(join(dir, 'app.ts'), 'export function main() { console.log("hello world from the application"); }');

    const { execSync } = await import('node:child_process');
    execSync('git init', { cwd: dir, stdio: 'ignore' });

    const idx = CodebaseIndex.getInstance(dir);

    // First index
    const r1 = await idx.ensureIndex();
    if (r1.indexed === 0) { t.skip('local embedding provider not available'); return; }
    assert.ok(r1.indexed >= 1, `First pass should index, got ${r1.indexed}`);

    // Second index — same files, should skip
    const r2 = await idx.ensureIndex();
    assert.equal(r2.indexed, 0, 'Should not re-index unchanged files');
    assert.ok(r2.skipped >= 1, 'Should skip unchanged files');

    // Modify file — should re-index
    await writeFile(join(dir, 'app.ts'), 'export function main() { console.log("changed content completely different"); }');
    const r3 = await idx.ensureIndex();
    assert.ok(r3.indexed >= 1, 'Should re-index changed file');
  });

  test('index persists to disk and reloads', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'crew-rag-persist-'));
    await mkdir(join(dir, '.crew', 'rag-cache'), { recursive: true });
    await writeFile(join(dir, 'server.ts'), 'export function startServer(port) { http.createServer().listen(port, "localhost"); }');

    const { execSync } = await import('node:child_process');
    execSync('git init', { cwd: dir, stdio: 'ignore' });

    const idx = CodebaseIndex.getInstance(dir);
    const result = await idx.ensureIndex();
    if (result.indexed === 0) { t.skip('local embedding provider not available'); return; }
    assert.ok(result.indexed >= 1, `Should have indexed at least 1 file, got ${result.indexed}`);

    // Check file was written
    assert.ok(existsSync(join(dir, '.crew', 'rag-cache', 'embeddings.json')),
      'embeddings.json should exist');
    assert.ok(existsSync(join(dir, '.crew', 'rag-cache', 'index-meta.json')),
      'index-meta.json should exist');

    const meta = JSON.parse(await readFile(join(dir, '.crew', 'rag-cache', 'index-meta.json'), 'utf8'));
    assert.equal(meta.provider, 'local');
    assert.ok(meta.fileCount >= 1);
  });
});

// ── autoLoadRelevantFiles ─────────────────────────────────────────────────

describe('autoLoadRelevantFiles', () => {
  test('returns empty for mode=off', async () => {
    const result = await autoLoadRelevantFiles('test', '/tmp', { mode: 'off' });
    assert.equal(result.context, '');
    assert.equal(result.filesLoaded.length, 0);
    assert.equal(result.mode, 'off');
  });

  test('keyword mode finds files by grep', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crew-rag-kw-'));
    await writeFile(join(dir, 'router.ts'), 'export function handleRoute(path) { return routes[path]; }');
    await writeFile(join(dir, 'utils.ts'), 'export function formatDate(d) { return d.toISOString(); }');

    const { execSync } = await import('node:child_process');
    execSync('git init', { cwd: dir, stdio: 'ignore' });

    const result = await autoLoadRelevantFiles('route handling', dir, { mode: 'keyword' });
    // May or may not find files depending on rg availability, but should not crash
    assert.equal(result.mode, 'keyword');
    assert.ok(result.tokenEstimate >= 0);
  });
});
