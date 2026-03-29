import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationTranscriptStore } from '../../src/session/conversation-transcript.ts';
import { rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = join('/tmp', `crew-transcript-test-${Date.now()}`);

test('appendTurn creates JSONL file with one line per turn', async () => {
  const store = new ConversationTranscriptStore(TEST_DIR);
  await store.appendTurn({ sessionId: 'test-1', role: 'user', text: 'Hello' });
  await store.appendTurn({ sessionId: 'test-1', role: 'assistant', text: 'Hi there' });

  const raw = readFileSync(join(TEST_DIR, '.crew', 'transcript-test-1.jsonl'), 'utf8');
  const lines = raw.trim().split('\n');
  assert.equal(lines.length, 2);

  const turn1 = JSON.parse(lines[0]);
  assert.equal(turn1.role, 'user');
  assert.equal(turn1.text, 'Hello');
  assert.ok(turn1.estimatedTokens > 0);

  const turn2 = JSON.parse(lines[1]);
  assert.equal(turn2.role, 'assistant');
  assert.equal(turn2.text, 'Hi there');
});

test('loadTurns reads all turns from JSONL', async () => {
  const store = new ConversationTranscriptStore(TEST_DIR);
  const turns = await store.loadTurns('test-1');
  assert.equal(turns.length, 2);
  assert.equal(turns[0].role, 'user');
  assert.equal(turns[1].role, 'assistant');
});

test('loadTurns skips corrupt lines gracefully', async () => {
  const store = new ConversationTranscriptStore(TEST_DIR);
  // Append a corrupt line manually
  const { appendFile } = await import('node:fs/promises');
  await appendFile(join(TEST_DIR, '.crew', 'transcript-test-1.jsonl'), 'NOT VALID JSON\n');
  await store.appendTurn({ sessionId: 'test-1', role: 'user', text: 'After corrupt' });

  const turns = await store.loadTurns('test-1');
  assert.equal(turns.length, 3); // 2 valid + 1 new, corrupt skipped
  assert.equal(turns[2].text, 'After corrupt');
});

test('getRecentTurns respects maxTurns limit', async () => {
  const store = new ConversationTranscriptStore(TEST_DIR);
  const turns = await store.getRecentTurns('test-1', 2);
  assert.equal(turns.length, 2);
  assert.equal(turns[1].text, 'After corrupt'); // Most recent
});

test('listSessions finds all session transcripts', async () => {
  const store = new ConversationTranscriptStore(TEST_DIR);
  await store.appendTurn({ sessionId: 'test-2', role: 'user', text: 'Second session' });

  const sessions = await store.listSessions();
  assert.ok(sessions.length >= 2);
  const ids = sessions.map(s => s.sessionId);
  assert.ok(ids.includes('test-1'));
  assert.ok(ids.includes('test-2'));
});

test('getSessionSummary returns correct metadata', async () => {
  const store = new ConversationTranscriptStore(TEST_DIR);
  const summary = await store.getSessionSummary('test-1');
  assert.ok(summary);
  assert.equal(summary.sessionId, 'test-1');
  assert.ok(summary.turnCount >= 3);
  assert.ok(summary.firstMessage.includes('Hello'));
  assert.ok(summary.totalTokens > 0);
  assert.ok(summary.lastActivity);
});

test('getSessionSummary returns null for nonexistent session', async () => {
  const store = new ConversationTranscriptStore(TEST_DIR);
  const summary = await store.getSessionSummary('nonexistent');
  assert.equal(summary, null);
});

test('separate sessions have separate files', async () => {
  const store = new ConversationTranscriptStore(TEST_DIR);
  const t1 = await store.loadTurns('test-1');
  const t2 = await store.loadTurns('test-2');
  assert.ok(t1.length >= 3);
  assert.equal(t2.length, 1);
});

// Cleanup
test('cleanup test directory', async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});
