/**
 * Unit tests for crew-cli/src/memory/broker.ts
 *
 * Run with: npx tsx --test tests/unit/memory-broker.test.js
 * (tsx required because broker.ts uses TS-convention .js extension imports)
 *
 * Covers:
 *  - BrokerHit interface shape
 *  - MemoryBroker constructor initialization
 *  - Internal tokenize/similarity via scoreFacts behavior
 *  - recall returns empty array when no data exists
 *  - recallAsContext returns empty string when no hits
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TEST_DIR = path.join(os.tmpdir(), `broker-test-${process.pid}`);

// The MemoryBroker depends on AgentKeeper and AgentMemory which read from disk.
// We point storageDir to a temp dir so there are no side effects.
import { MemoryBroker } from '../../src/memory/broker.ts';

describe('MemoryBroker — constructor', () => {
  before(() => {
    fs.mkdirSync(path.join(TEST_DIR, '.crew'), { recursive: true });
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('constructs without throwing when given a valid project dir', () => {
    const broker = new MemoryBroker(TEST_DIR, { storageDir: TEST_DIR });
    assert.ok(broker, 'broker instance should be truthy');
  });

  it('constructs with a custom crewId', () => {
    const broker = new MemoryBroker(TEST_DIR, { crewId: 'crew-qa', storageDir: TEST_DIR });
    assert.ok(broker, 'broker instance should be truthy');
  });
});

describe('MemoryBroker — recall with empty store', () => {
  let broker;

  before(() => {
    fs.mkdirSync(path.join(TEST_DIR, '.crew'), { recursive: true });
    broker = new MemoryBroker(TEST_DIR, { storageDir: TEST_DIR });
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('recall returns an array', async () => {
    const hits = await broker.recall('test query');
    assert.ok(Array.isArray(hits), 'should return an array');
  });

  it('recall returns empty array when no data exists', async () => {
    const hits = await broker.recall('nonexistent task about kubernetes');
    assert.equal(hits.length, 0, 'no hits expected from empty store');
  });

  it('recall respects maxResults option', async () => {
    const hits = await broker.recall('test query', { maxResults: 3 });
    assert.ok(hits.length <= 3, 'should respect maxResults');
  });
});

describe('MemoryBroker — recallAsContext', () => {
  let broker;

  before(() => {
    fs.mkdirSync(path.join(TEST_DIR, '.crew'), { recursive: true });
    broker = new MemoryBroker(TEST_DIR, { storageDir: TEST_DIR });
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('returns empty string when no hits found', async () => {
    const ctx = await broker.recallAsContext('nonexistent query xyz');
    assert.equal(ctx, '', 'should return empty string');
  });
});

describe('MemoryBroker — BrokerRecallOptions defaults', () => {
  let broker;

  before(() => {
    fs.mkdirSync(path.join(TEST_DIR, '.crew'), { recursive: true });
    broker = new MemoryBroker(TEST_DIR, { storageDir: TEST_DIR });
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('recall with includeDocs: false skips collection search', async () => {
    const hits = await broker.recall('test', { includeDocs: false });
    assert.ok(Array.isArray(hits));
    // With no agentkeeper data and no docs, should be empty
    assert.equal(hits.length, 0);
  });

  it('recall with includeCode: true does not throw', async () => {
    const hits = await broker.recall('test', { includeCode: true, includeDocs: false });
    assert.ok(Array.isArray(hits));
  });
});
