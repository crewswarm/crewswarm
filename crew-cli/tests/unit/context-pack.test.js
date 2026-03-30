/**
 * Unit tests for crew-cli/src/pipeline/context-pack.ts
 *
 * Tests the ContextPackManager class: createPack, retrieve, getPackStats,
 * chunkDoc, extractTerms, and cache management. Uses temp directories
 * for file I/O and cleans up after.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let ContextPackManager;

async function loadClass() {
  if (ContextPackManager) return;
  const m = await import('../../src/pipeline/context-pack.ts');
  ContextPackManager = m.ContextPackManager;
}

function makeArtifacts(overrides = {}) {
  return {
    pdd: 'pdd' in overrides ? overrides.pdd : 'Product design document content.',
    roadmap: 'roadmap' in overrides ? overrides.roadmap : 'Phase 1: Setup. Phase 2: Build.',
    architecture: 'architecture' in overrides ? overrides.architecture : 'Monolith with service layer.',
    scaffold: 'scaffold' in overrides ? overrides.scaffold : 'src/ lib/ test/',
    contractTests: 'contractTests' in overrides ? overrides.contractTests : 'Test: API returns 200.',
    definitionOfDone: 'definitionOfDone' in overrides ? overrides.definitionOfDone : 'All tests pass.',
    goldenBenchmarks: 'goldenBenchmarks' in overrides ? overrides.goldenBenchmarks : 'Benchmark: 50ms p99.',
  };
}

const tmpBase = join(tmpdir(), `context-pack-test-${Date.now()}`);
let testDir;

describe('ContextPackManager', () => {
  beforeEach(async () => {
    await loadClass();
    testDir = join(tmpBase, `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(testDir, { recursive: true });
    // Override cwd so the manager writes to our temp dir
    process.chdir(testDir);
  });

  afterEach(() => {
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  });

  it('createPack returns a string ID starting with "pack-"', () => {
    const mgr = new ContextPackManager();
    const id = mgr.createPack('trace-1', makeArtifacts());
    assert.ok(typeof id === 'string');
    assert.ok(id.startsWith('pack-'));
  });

  it('createPack is idempotent for same artifacts', () => {
    const mgr = new ContextPackManager();
    const arts = makeArtifacts();
    const id1 = mgr.createPack('trace-1', arts);
    const id2 = mgr.createPack('trace-2', arts);
    assert.equal(id1, id2);
  });

  it('createPack returns different IDs for different artifacts', () => {
    const mgr = new ContextPackManager();
    const id1 = mgr.createPack('t1', makeArtifacts({ pdd: 'Version A' }));
    const id2 = mgr.createPack('t2', makeArtifacts({ pdd: 'Version B' }));
    assert.notEqual(id1, id2);
  });

  it('createPack writes cache file to .crew/context-packs/', () => {
    const mgr = new ContextPackManager();
    mgr.createPack('trace-1', makeArtifacts());
    const cacheDir = join(testDir, '.crew', 'context-packs');
    assert.ok(existsSync(cacheDir));
    const files = readdirSync(cacheDir);
    assert.ok(files.length >= 1);
    assert.ok(files[0].endsWith('.json'));
  });

  it('getPackStats returns chunk count', () => {
    const mgr = new ContextPackManager();
    const id = mgr.createPack('trace-1', makeArtifacts());
    const stats = mgr.getPackStats(id);
    assert.ok(typeof stats.chunks === 'number');
    assert.ok(stats.chunks > 0);
  });

  it('getPackStats returns 0 chunks for unknown pack', () => {
    const mgr = new ContextPackManager();
    const stats = mgr.getPackStats('pack-nonexistent');
    assert.equal(stats.chunks, 0);
  });

  it('retrieve returns empty string for unknown pack', () => {
    const mgr = new ContextPackManager();
    const result = mgr.retrieve('pack-nonexistent', { query: 'test' });
    assert.equal(result, '');
  });

  it('retrieve returns relevant chunks for matching query', () => {
    const mgr = new ContextPackManager();
    const arts = makeArtifacts({ pdd: 'Authentication login flow with OAuth2 tokens.' });
    const id = mgr.createPack('trace-1', arts);
    const result = mgr.retrieve(id, { query: 'authentication login' });
    assert.ok(result.length > 0);
    assert.ok(result.includes('PDD.md') || result.includes('authentication') || result.includes('login'));
  });

  it('retrieve respects source ref filtering', () => {
    const mgr = new ContextPackManager();
    const arts = makeArtifacts({
      pdd: 'PDD content about the product.',
      roadmap: 'Roadmap content about phases.',
    });
    const id = mgr.createPack('trace-1', arts);
    const result = mgr.retrieve(id, {
      query: 'content',
      sourceRefs: ['PDD.md'],
    });
    // Should prefer PDD chunks due to sourceRef boost
    assert.ok(result.includes('PDD.md'));
  });

  it('retrieve respects budgetChars limit', () => {
    const mgr = new ContextPackManager();
    const arts = makeArtifacts({ pdd: 'x'.repeat(5000) });
    const id = mgr.createPack('trace-1', arts);
    const result = mgr.retrieve(id, { query: 'test', budgetChars: 500 });
    assert.ok(result.length <= 600); // some overhead from headers
  });

  it('retrieve respects maxChunks limit', () => {
    const mgr = new ContextPackManager();
    const arts = makeArtifacts({ pdd: 'word '.repeat(2000) });
    const id = mgr.createPack('trace-1', arts);
    const result = mgr.retrieve(id, { query: 'word', maxChunks: 1 });
    const chunkHeaders = result.match(/\[PDD\.md#\d+\]/g) || [];
    assert.ok(chunkHeaders.length <= 1);
  });

  it('chunks large documents with overlap', () => {
    const mgr = new ContextPackManager();
    const largePdd = 'A'.repeat(6000);
    const arts = makeArtifacts({ pdd: largePdd });
    const id = mgr.createPack('trace-1', arts);
    const stats = mgr.getPackStats(id);
    // 6000 chars with 2200 chunk size should produce multiple chunks
    assert.ok(stats.chunks > 3); // at least PDD chunks + other doc chunks
  });

  it('handles empty artifact fields gracefully', () => {
    const mgr = new ContextPackManager();
    const arts = makeArtifacts({
      pdd: '',
      roadmap: '',
      architecture: '',
      scaffold: '',
      contractTests: '',
      definitionOfDone: '',
      goldenBenchmarks: '',
    });
    const id = mgr.createPack('trace-1', arts);
    const stats = mgr.getPackStats(id);
    assert.equal(stats.chunks, 0);
  });

  it('loads from cache on second createPack call', () => {
    const mgr = new ContextPackManager();
    const arts = makeArtifacts();
    const id1 = mgr.createPack('trace-1', arts);

    // Create a new manager instance (simulates restart)
    const mgr2 = new ContextPackManager();
    const id2 = mgr2.createPack('trace-2', arts);
    assert.equal(id1, id2);
    // Should still have chunks from cache
    const stats = mgr2.getPackStats(id2);
    assert.ok(stats.chunks > 0);
  });
});
