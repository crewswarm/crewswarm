import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GeminiToolAdapter } from '../../src/tools/gemini/crew-adapter.ts';

function createAdapter(baseDir) {
  return new GeminiToolAdapter({
    baseDir,
    getBaseDir: () => baseDir,
    addChange: async () => {},
    getStagedContent: () => null
  });
}

test('ask_user persists pending request files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crew-adapter-'));
  try {
    const adapter = createAdapter(dir);
    const res = await adapter.executeTool('ask_user', {
      questions: [{ question: 'Which model?', options: [{ label: 'A' }, { label: 'B' }] }]
    });
    assert.equal(res.success, true);
    assert.match(String(res.output || ''), /Saved request:/);

    const latestRaw = await readFile(join(dir, '.crew', 'ask-user-latest.json'), 'utf8');
    const latest = JSON.parse(latestRaw);
    assert.equal(latest.status, 'pending');
    assert.equal(Array.isArray(latest.questions), true);
    assert.equal(latest.questions.length, 1);

    const jsonl = await readFile(join(dir, '.crew', 'ask-user-requests.jsonl'), 'utf8');
    assert.match(jsonl, /"status":"pending"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('plan mode enter/exit writes state transitions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crew-adapter-'));
  try {
    const adapter = createAdapter(dir);
    const enter = await adapter.executeTool('enter_plan_mode', { reason: 'break down roadmap' });
    assert.equal(enter.success, true);
    let state = JSON.parse(await readFile(join(dir, '.crew', 'plan-mode.json'), 'utf8'));
    assert.equal(state.active, true);
    assert.equal(state.reason, 'break down roadmap');

    const exit = await adapter.executeTool('exit_plan_mode', { plan_path: 'ROADMAP.md' });
    assert.equal(exit.success, true);
    state = JSON.parse(await readFile(join(dir, '.crew', 'plan-mode.json'), 'utf8'));
    assert.equal(state.active, false);
    assert.equal(state.planPath, 'ROADMAP.md');
    assert.ok(state.exitedAt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('activate_skill persists deduped skill state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crew-adapter-'));
  try {
    const adapter = createAdapter(dir);
    const a = await adapter.executeTool('activate_skill', { name: 'code-review' });
    const b = await adapter.executeTool('activate_skill', { name: 'code-review' });
    assert.equal(a.success, true);
    assert.equal(b.success, true);

    const raw = await readFile(join(dir, '.crew', 'active-skills.json'), 'utf8');
    const state = JSON.parse(raw);
    assert.deepEqual(state.active, ['code-review']);
    assert.ok(state.updatedAt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
