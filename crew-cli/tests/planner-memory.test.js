import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Planner } from '../src/planner/index.ts';
import { AgentKeeper } from '../src/memory/agentkeeper.ts';

const hasLLMKey = !!(
  process.env.OPENAI_API_KEY ||
  process.env.ANTHROPIC_API_KEY ||
  process.env.GEMINI_API_KEY ||
  process.env.GROQ_API_KEY
);

test('Planner records memory and recalls it into prompt context', { skip: 'Planner now uses DualL2Planner internally — requires live LLM with valid JSON responses' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crew-planner-memory-'));
  const prompts = [];
  const router = {
    dispatch: async (_agent, prompt) => {
      prompts.push(String(prompt || ''));
      return { result: '1. step one\n2. step two' };
    }
  };

  const planner = new Planner(router, undefined, dir);
  await planner.generatePlan('Implement auth flow', {
    useMemory: true,
    runId: 'mem-run-1'
  });

  await planner.generatePlan('Implement auth flow', {
    useMemory: true,
    useCache: false,
    runId: 'mem-run-2'
  });

  assert.ok(prompts.length >= 2);
  assert.ok(prompts[1].includes('Prior Task Memory'));

  const keeper = new AgentKeeper(dir);
  const stats = await keeper.stats();
  assert.ok((stats.byTier.planner || 0) >= 2);
});
