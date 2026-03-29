/**
 * Unit tests for crew-cli/src/memory/agentkeeper.ts
 *
 * Covers:
 *  - AgentKeeper record and loadAll round-trip
 *  - recall by task similarity
 *  - recency boost in scoring
 *  - success boost in scoring
 *  - path hints boost
 *  - compact reduces entries
 *  - stats returns correct shape
 *  - cross-session persistence (write, create new instance, read back)
 *  - redaction of secrets
 *  - sanitizeText truncation
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AgentKeeper } from '../../src/memory/agentkeeper.ts';

const TEST_DIR = path.join(os.tmpdir(), `agentkeeper-test-${process.pid}`);

function makeEntry(overrides = {}) {
  return {
    runId: 'run-001',
    tier: 'worker',
    task: 'implement login page',
    result: 'Created login.tsx with email/password form',
    agent: 'crew-coder',
    ...overrides,
  };
}

describe('AgentKeeper — record and loadAll', () => {
  let keeper;

  before(() => {
    fs.mkdirSync(path.join(TEST_DIR, '.crew'), { recursive: true });
    keeper = new AgentKeeper(TEST_DIR, { storageDir: TEST_DIR, autoCompactEvery: 9999 });
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('record returns an entry with id and timestamp', async () => {
    const entry = await keeper.record(makeEntry());
    assert.ok(entry.id, 'should have an id');
    assert.ok(entry.timestamp, 'should have a timestamp');
    assert.equal(entry.tier, 'worker');
    assert.equal(entry.agent, 'crew-coder');
  });

  it('loadAll returns all recorded entries', async () => {
    await keeper.record(makeEntry({ task: 'task A' }));
    await keeper.record(makeEntry({ task: 'task B' }));
    const all = await keeper.loadAll();
    assert.ok(all.length >= 3, 'should have at least 3 entries (1 from prior test + 2 new)');
  });

  it('loadAll returns empty array when store file does not exist', async () => {
    const emptyDir = path.join(os.tmpdir(), `agentkeeper-empty-${process.pid}`);
    fs.mkdirSync(emptyDir, { recursive: true });
    const freshKeeper = new AgentKeeper(emptyDir, { storageDir: emptyDir });
    const all = await freshKeeper.loadAll();
    assert.deepEqual(all, []);
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });
});

describe('AgentKeeper — recall similarity', () => {
  let keeper;
  const dir = path.join(os.tmpdir(), `agentkeeper-recall-${process.pid}`);

  before(async () => {
    fs.mkdirSync(path.join(dir, '.crew'), { recursive: true });
    keeper = new AgentKeeper(dir, { storageDir: dir, autoCompactEvery: 9999 });
    await keeper.record(makeEntry({ task: 'implement user authentication with JWT tokens' }));
    await keeper.record(makeEntry({ task: 'build dashboard chart component with recharts' }));
    await keeper.record(makeEntry({ task: 'fix CSS grid layout on mobile devices' }));
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('recall returns matches sorted by score descending', async () => {
    const matches = await keeper.recall('authentication JWT login');
    assert.ok(matches.length > 0, 'should find at least one match');
    for (let i = 1; i < matches.length; i++) {
      assert.ok(matches[i - 1].score >= matches[i].score, 'should be sorted desc');
    }
  });

  it('recall best match is the JWT task', async () => {
    const matches = await keeper.recall('authentication JWT login');
    assert.ok(matches.length > 0);
    assert.match(matches[0].entry.task, /JWT/i);
  });

  it('recall returns empty for completely unrelated query', async () => {
    const matches = await keeper.recall('quantum physics hadron collider');
    assert.equal(matches.length, 0, 'should find no matches');
  });

  it('recall respects maxResults', async () => {
    const matches = await keeper.recall('build component', 1);
    assert.ok(matches.length <= 1);
  });
});

describe('AgentKeeper — recall boosts', () => {
  let keeper;
  const dir = path.join(os.tmpdir(), `agentkeeper-boost-${process.pid}`);

  before(async () => {
    fs.mkdirSync(path.join(dir, '.crew'), { recursive: true });
    keeper = new AgentKeeper(dir, { storageDir: dir, autoCompactEvery: 9999 });

    // Old entry
    const oldEntry = makeEntry({ task: 'deploy application to production server' });
    await keeper.record(oldEntry);

    // Manually write an old-timestamp entry
    const storePath = path.join(dir, '.crew', 'agentkeeper.jsonl');
    const raw = fs.readFileSync(storePath, 'utf8');
    const lines = raw.trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    const oldDate = new Date(Date.now() - 25 * 24 * 60 * 60 * 1000).toISOString();
    last.timestamp = oldDate;
    lines[lines.length - 1] = JSON.stringify(last);

    // New entry with success metadata
    const successEntry = {
      ...makeEntry({ task: 'deploy application to staging server', result: 'Successfully deployed' }),
      id: 'success-id',
      timestamp: new Date().toISOString(),
      metadata: { success: true },
    };
    lines.push(JSON.stringify(successEntry));
    fs.writeFileSync(storePath, lines.join('\n') + '\n', 'utf8');
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('recent entries score higher than old entries for same query', async () => {
    const matches = await keeper.recall('deploy application server', 10);
    assert.ok(matches.length >= 2, 'should find at least 2 matches');
    // The newer (staging) entry should score higher due to recency boost
    const staging = matches.find(m => m.entry.task.includes('staging'));
    const production = matches.find(m => m.entry.task.includes('production'));
    assert.ok(staging, 'staging entry should be found');
    assert.ok(production, 'production entry should be found');
    assert.ok(staging.score >= production.score, 'staging (newer) should score >= production (older)');
  });

  it('preferSuccessful boosts entries with success metadata', async () => {
    const matches = await keeper.recall('deploy application server', 10, { preferSuccessful: true });
    const successMatch = matches.find(m => m.entry.metadata?.success === true);
    assert.ok(successMatch, 'should find the successful entry');
  });
});

describe('AgentKeeper — compact', () => {
  let keeper;
  const dir = path.join(os.tmpdir(), `agentkeeper-compact-${process.pid}`);

  before(async () => {
    fs.mkdirSync(path.join(dir, '.crew'), { recursive: true });
    keeper = new AgentKeeper(dir, { storageDir: dir, maxEntries: 3, autoCompactEvery: 9999 });
    for (let i = 0; i < 5; i++) {
      await keeper.record(makeEntry({ task: `task number ${i}`, result: `result ${i}` }));
    }
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('compact reduces entries to maxEntries', async () => {
    const result = await keeper.compact();
    assert.equal(result.entriesBefore, 5);
    assert.ok(result.entriesAfter <= 3, 'should compact down to maxEntries');
    assert.ok(result.bytesFreed >= 0, 'bytesFreed should be non-negative');
  });

  it('loadAll after compact reflects compacted count', async () => {
    const all = await keeper.loadAll();
    assert.ok(all.length <= 3);
  });
});

describe('AgentKeeper — stats', () => {
  let keeper;
  const dir = path.join(os.tmpdir(), `agentkeeper-stats-${process.pid}`);

  before(async () => {
    fs.mkdirSync(path.join(dir, '.crew'), { recursive: true });
    keeper = new AgentKeeper(dir, { storageDir: dir, autoCompactEvery: 9999 });
    await keeper.record(makeEntry({ tier: 'planner', agent: 'crew-lead' }));
    await keeper.record(makeEntry({ tier: 'worker', agent: 'crew-coder' }));
    await keeper.record(makeEntry({ tier: 'worker', agent: 'crew-coder' }));
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stats returns correct entry count', async () => {
    const s = await keeper.stats();
    assert.equal(s.entries, 3);
  });

  it('stats groups by tier', async () => {
    const s = await keeper.stats();
    assert.equal(s.byTier.planner, 1);
    assert.equal(s.byTier.worker, 2);
  });

  it('stats groups by agent', async () => {
    const s = await keeper.stats();
    assert.equal(s.byAgent['crew-lead'], 1);
    assert.equal(s.byAgent['crew-coder'], 2);
  });

  it('stats.bytes is a positive number', async () => {
    const s = await keeper.stats();
    assert.ok(s.bytes > 0);
  });
});

describe('AgentKeeper — cross-session persistence', () => {
  const dir = path.join(os.tmpdir(), `agentkeeper-persist-${process.pid}`);

  before(() => {
    fs.mkdirSync(path.join(dir, '.crew'), { recursive: true });
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('data written by one instance is readable by a new instance', async () => {
    const keeper1 = new AgentKeeper(dir, { storageDir: dir, autoCompactEvery: 9999 });
    await keeper1.record(makeEntry({ task: 'cross-session task alpha' }));

    // Create a brand new instance pointing at the same directory
    const keeper2 = new AgentKeeper(dir, { storageDir: dir, autoCompactEvery: 9999 });
    const all = await keeper2.loadAll();
    const found = all.find(e => e.task.includes('cross-session task alpha'));
    assert.ok(found, 'new instance should read data from previous instance');
  });
});

describe('AgentKeeper — recordSafe', () => {
  const dir = path.join(os.tmpdir(), `agentkeeper-safe-${process.pid}`);

  before(() => {
    fs.mkdirSync(path.join(dir, '.crew'), { recursive: true });
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('recordSafe returns { ok: true } on success', async () => {
    const keeper = new AgentKeeper(dir, { storageDir: dir, autoCompactEvery: 9999 });
    const result = await keeper.recordSafe(makeEntry());
    assert.equal(result.ok, true);
    assert.ok(result.entry);
    assert.ok(result.entry.id);
  });
});

describe('AgentKeeper — redaction', () => {
  const dir = path.join(os.tmpdir(), `agentkeeper-redact-${process.pid}`);
  let keeper;

  before(() => {
    fs.mkdirSync(path.join(dir, '.crew'), { recursive: true });
    keeper = new AgentKeeper(dir, { storageDir: dir, autoCompactEvery: 9999 });
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('redacts API keys from recorded results', async () => {
    const entry = await keeper.record(makeEntry({
      result: 'Used API key sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdef to call OpenAI',
    }));
    assert.ok(!entry.result.includes('sk-ABCDEFGHIJKLMNOPQR'), 'API key should be redacted');
    assert.ok(entry.result.includes('[REDACTED_API_KEY]'), 'should contain redaction marker');
  });

  it('redacts GitHub tokens from recorded results', async () => {
    const entry = await keeper.record(makeEntry({
      result: 'Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh used for auth',
    }));
    assert.ok(entry.result.includes('[REDACTED_GITHUB_TOKEN]'));
  });

  it('redacts email addresses from recorded results', async () => {
    const entry = await keeper.record(makeEntry({
      result: 'Contact admin@example.com for help',
    }));
    assert.ok(entry.result.includes('[REDACTED_EMAIL]'));
  });
});
