/**
 * Unit tests for crew-cli src/session/manager.ts
 *
 * Covers:
 *  - SessionManager constructor: sets up paths correctly
 *  - ensureInitialized: creates .crew directory and default files
 *  - getSessionId / setSessionId: read and write session ID
 *  - appendHistory: adds entries to session history
 *  - clear: removes state directory and re-initializes
 *  - loadCost / trackCost: cost tracking round-trip
 *  - trackCacheSavings: accumulates cache metrics
 *  - compact: trims history and cost entries
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionManager } from '../../src/session/manager.ts';

// ── Test directory ─────────────────────────────────────────────────────────

const TEST_BASE_DIR = path.join(os.tmpdir(), `crewswarm-session-test-${process.pid}`);

function cleanup() {
  try { fs.rmSync(TEST_BASE_DIR, { recursive: true, force: true }); } catch {}
}

// ── Constructor ────────────────────────────────────────────────────────────

describe('SessionManager — constructor', () => {
  it('creates an instance with the given base directory', () => {
    const sm = new SessionManager(TEST_BASE_DIR);
    assert.ok(sm instanceof SessionManager);
  });

  it('defaults to process.cwd() when no baseDir is provided', () => {
    const sm = new SessionManager();
    assert.ok(sm instanceof SessionManager);
  });
});

// ── ensureInitialized ──────────────────────────────────────────────────────

describe('SessionManager — ensureInitialized', () => {
  before(() => cleanup());
  after(() => cleanup());

  it('creates .crew directory and default files', async () => {
    const sm = new SessionManager(TEST_BASE_DIR);
    await sm.ensureInitialized();

    const stateDir = path.join(TEST_BASE_DIR, '.crew');
    assert.ok(fs.existsSync(stateDir), '.crew directory should exist');
    assert.ok(fs.existsSync(path.join(stateDir, 'session.json')), 'session.json should exist');
    assert.ok(fs.existsSync(path.join(stateDir, 'routing.log')), 'routing.log should exist');
    assert.ok(fs.existsSync(path.join(stateDir, 'cost.json')), 'cost.json should exist');
    assert.ok(fs.existsSync(path.join(stateDir, 'sandbox.json')), 'sandbox.json should exist');
  });

  it('session.json contains a valid UUID sessionId', async () => {
    const sm = new SessionManager(TEST_BASE_DIR);
    await sm.ensureInitialized();

    const raw = fs.readFileSync(path.join(TEST_BASE_DIR, '.crew', 'session.json'), 'utf8');
    const data = JSON.parse(raw);
    assert.ok(typeof data.sessionId === 'string');
    assert.match(data.sessionId, /^[0-9a-f-]{36}$/);
    assert.ok(Array.isArray(data.history));
  });

  it('cost.json has correct initial structure', async () => {
    const dir = path.join(TEST_BASE_DIR, 'cost-test');
    const sm = new SessionManager(dir);
    await sm.ensureInitialized();

    const raw = fs.readFileSync(path.join(dir, '.crew', 'cost.json'), 'utf8');
    const data = JSON.parse(raw);
    assert.equal(data.totalUsd, 0);
    assert.deepEqual(data.byModel, {});
    assert.ok(Array.isArray(data.entries));
    assert.ok(typeof data.cacheSavings === 'object');
    assert.ok(typeof data.memoryMetrics === 'object');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is idempotent — calling twice does not overwrite session', async () => {
    const dir = path.join(TEST_BASE_DIR, 'idempotent-test');
    const sm = new SessionManager(dir);
    await sm.ensureInitialized();
    const id1 = await sm.getSessionId();

    await sm.ensureInitialized();
    const id2 = await sm.getSessionId();

    assert.equal(id1, id2, 'sessionId should not change on second init');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── getSessionId / setSessionId ────────────────────────────────────────────

describe('SessionManager — getSessionId / setSessionId', () => {
  before(() => cleanup());
  after(() => cleanup());

  it('getSessionId returns the session UUID', async () => {
    const sm = new SessionManager(TEST_BASE_DIR);
    const id = await sm.getSessionId();
    assert.ok(typeof id === 'string');
    assert.match(id, /^[0-9a-f-]{36}$/);
  });

  it('setSessionId changes the session ID', async () => {
    const sm = new SessionManager(TEST_BASE_DIR);
    const originalId = await sm.getSessionId();

    await sm.setSessionId('custom-session-id-abc');
    const newId = await sm.getSessionId();

    assert.equal(newId, 'custom-session-id-abc');
    assert.notEqual(newId, originalId);
  });
});

// ── appendHistory ──────────────────────────────────────────────────────────

describe('SessionManager — appendHistory', () => {
  before(() => cleanup());
  after(() => cleanup());

  it('adds an entry to the session history', async () => {
    const sm = new SessionManager(TEST_BASE_DIR);
    await sm.ensureInitialized();

    await sm.appendHistory({ input: 'hello', output: 'world', route: 'direct', agent: 'crew-coder' });

    const session = await sm.loadSession();
    assert.equal(session.history.length, 1);
    assert.equal(session.history[0].input, 'hello');
    assert.equal(session.history[0].output, 'world');
    assert.equal(session.history[0].route, 'direct');
    assert.equal(session.history[0].agent, 'crew-coder');
    assert.ok(typeof session.history[0].timestamp === 'string');
  });

  it('appends multiple entries in order', async () => {
    const dir = path.join(TEST_BASE_DIR, 'history-multi');
    const sm = new SessionManager(dir);
    await sm.ensureInitialized();

    await sm.appendHistory({ input: 'first' });
    await sm.appendHistory({ input: 'second' });
    await sm.appendHistory({ input: 'third' });

    const session = await sm.loadSession();
    assert.equal(session.history.length, 3);
    assert.equal(session.history[0].input, 'first');
    assert.equal(session.history[2].input, 'third');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── clear ──────────────────────────────────────────────────────────────────

describe('SessionManager — clear', () => {
  it('removes state directory and re-initializes with fresh session', async () => {
    const dir = path.join(TEST_BASE_DIR, 'clear-test');
    const sm = new SessionManager(dir);
    await sm.ensureInitialized();
    const oldId = await sm.getSessionId();

    await sm.appendHistory({ input: 'before clear' });

    await sm.clear();

    const newId = await sm.getSessionId();
    const session = await sm.loadSession();

    // Session ID should be different after clear
    assert.notEqual(newId, oldId);
    // History should be empty after clear
    assert.equal(session.history.length, 0);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── trackCost / loadCost ───────────────────────────────────────────────────

describe('SessionManager — trackCost', () => {
  it('accumulates cost entries', async () => {
    const dir = path.join(TEST_BASE_DIR, 'cost-track');
    const sm = new SessionManager(dir);
    await sm.ensureInitialized();

    await sm.trackCost({ usd: 0.05, model: 'gpt-4o', promptTokens: 1000, completionTokens: 500 });
    await sm.trackCost({ usd: 0.02, model: 'gemini-2.5-flash', promptTokens: 2000, completionTokens: 300 });

    const cost = await sm.loadCost();
    assert.ok(Math.abs(cost.totalUsd - 0.07) < 0.001);
    assert.ok(Math.abs(cost.byModel['gpt-4o'] - 0.05) < 0.001);
    assert.ok(Math.abs(cost.byModel['gemini-2.5-flash'] - 0.02) < 0.001);
    assert.equal(cost.entries.length, 2);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── trackCacheSavings ──────────────────────────────────────────────────────

describe('SessionManager — trackCacheSavings', () => {
  it('accumulates cache hit/miss/savings metrics', async () => {
    const dir = path.join(TEST_BASE_DIR, 'cache-track');
    const sm = new SessionManager(dir);
    await sm.ensureInitialized();

    await sm.trackCacheSavings({ hit: true, tokensSaved: 500, usdSaved: 0.01 });
    await sm.trackCacheSavings({ hit: true, tokensSaved: 300, usdSaved: 0.005 });
    await sm.trackCacheSavings({ miss: true });

    const cost = await sm.loadCost();
    assert.equal(cost.cacheSavings.hits, 2);
    assert.equal(cost.cacheSavings.misses, 1);
    assert.equal(cost.cacheSavings.tokensSaved, 800);
    assert.ok(Math.abs(cost.cacheSavings.usdSaved - 0.015) < 0.001);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── compact ────────────────────────────────────────────────────────────────

describe('SessionManager — compact', () => {
  it('trims history and cost entries to specified limits', async () => {
    const dir = path.join(TEST_BASE_DIR, 'compact-test');
    const sm = new SessionManager(dir);
    await sm.ensureInitialized();

    // Add many history entries
    for (let i = 0; i < 10; i++) {
      await sm.appendHistory({ input: `entry-${i}` });
    }
    // Add many cost entries
    for (let i = 0; i < 10; i++) {
      await sm.trackCost({ usd: 0.01, model: 'test-model' });
    }

    const result = await sm.compact({ keepHistory: 3, keepCostEntries: 5 });

    assert.equal(result.historyBefore, 10);
    assert.equal(result.historyAfter, 3);
    assert.equal(result.costBefore, 10);
    assert.equal(result.costAfter, 5);

    // Verify the data was actually trimmed
    const session = await sm.loadSession();
    assert.equal(session.history.length, 3);
    assert.equal(session.history[0].input, 'entry-7'); // kept last 3

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── JIT Context ────────────────────────────────────────────────────────────

describe('SessionManager — JIT context', () => {
  it('saves and loads JIT discovered files', async () => {
    const dir = path.join(TEST_BASE_DIR, 'jit-test');
    const sm = new SessionManager(dir);
    await sm.ensureInitialized();

    const files = ['src/foo.ts', 'src/bar.ts', 'README.md'];
    await sm.saveJITContext(files);

    const loaded = await sm.loadJITContext();
    assert.deepEqual(loaded, files);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty array when no JIT context exists', async () => {
    const dir = path.join(TEST_BASE_DIR, 'jit-empty');
    const sm = new SessionManager(dir);
    await sm.ensureInitialized();

    const loaded = await sm.loadJITContext();
    assert.deepEqual(loaded, []);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('trims to max 200 files', async () => {
    const dir = path.join(TEST_BASE_DIR, 'jit-trim');
    const sm = new SessionManager(dir);
    await sm.ensureInitialized();

    const files = Array.from({ length: 300 }, (_, i) => `file-${i}.ts`);
    await sm.saveJITContext(files);

    const loaded = await sm.loadJITContext();
    assert.equal(loaded.length, 200);
    // Should keep the last 200
    assert.equal(loaded[0], 'file-100.ts');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
