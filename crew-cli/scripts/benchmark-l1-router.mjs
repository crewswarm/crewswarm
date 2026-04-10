#!/usr/bin/env node
/**
 * benchmark-l1-router.mjs — L1 Router accuracy benchmark
 *
 * Tests whether a model can correctly classify tasks into:
 *   - direct-answer: greetings, identity questions
 *   - execute-direct: single-file fixes, simple questions about code
 *   - execute-parallel: multi-file features, complex implementations
 *
 * Usage: CREW_EXECUTION_MODEL=gemini-2.5-flash node scripts/benchmark-l1-router.mjs
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const TASKS = [
  // direct-answer (should NOT trigger any coding)
  { input: 'hi', expected: 'direct-answer', category: 'greeting' },
  { input: 'hello, who are you?', expected: 'direct-answer', category: 'greeting' },
  { input: 'what can you do?', expected: 'direct-answer', category: 'identity' },
  { input: 'what model are you running?', expected: 'direct-answer', category: 'identity' },

  // execute-direct (single file, simple task)
  { input: 'Fix the divide function in src/math.ts to throw an Error when dividing by zero', expected: 'execute-direct', category: 'bugfix' },
  { input: 'Add a modulo function to src/math.ts', expected: 'execute-direct', category: 'feature' },
  { input: 'Rename the clamp function to clampValue in src/utils.ts', expected: 'execute-direct', category: 'refactor' },
  { input: 'What files are in the src directory?', expected: 'execute-direct', category: 'question' },
  { input: 'Read package.json and tell me the version', expected: 'execute-direct', category: 'question' },
  { input: 'Fix the typo on line 5 of README.md', expected: 'execute-direct', category: 'bugfix' },

  // execute-parallel (multi-file, complex)
  { input: 'Build a REST API with Express that has /users and /posts endpoints, JWT auth middleware, and unit tests for each route', expected: 'execute-parallel', category: 'feature' },
  { input: 'Create a calculator module with add, subtract, multiply, divide functions, a CLI interface, and comprehensive tests', expected: 'execute-parallel', category: 'feature' },
  { input: 'Refactor the auth system: extract token validation into its own module, update all imports across 5 files, and add integration tests', expected: 'execute-parallel', category: 'refactor' },
  { input: 'Set up a new React project with TypeScript, routing, a dashboard page, and a settings page with theme switching', expected: 'execute-parallel', category: 'feature' },
  { input: 'There are bugs in 3 files: math.ts has divide-by-zero, utils.ts has a regex bug, and config.ts has a missing default. Fix all three and run the test suite.', expected: 'execute-parallel', category: 'bugfix' },
];

async function testRouter(model) {
  // Create a minimal project dir for the router to scan
  const dir = await mkdtemp(join(tmpdir(), 'crew-l1-bench-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'test', type: 'module' }));
  await writeFile(join(dir, 'src/math.ts'), 'export function add(a: number, b: number) { return a + b; }');

  // Import the pipeline
  const { UnifiedPipeline } = await import('../dist/crew.mjs');
  const { Sandbox } = await import('../dist/engine.mjs');
  const sandbox = new Sandbox(dir);
  const pipeline = new UnifiedPipeline(sandbox, { logger: { info: () => {}, warn: () => {}, error: () => {} } });

  const results = [];
  let correct = 0;

  for (const task of TASKS) {
    const start = Date.now();
    try {
      // Call executePipeline but abort after getting the L1 decision
      // We set a very short timeout since we only need the routing decision
      const result = await Promise.race([
        pipeline.executePipeline(task.input, '', 'bench-l1'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 30000))
      ]);

      const decision = result?.plan?.decision || 'unknown';
      const match = decision === task.expected;
      if (match) correct++;

      results.push({
        input: task.input.slice(0, 60),
        expected: task.expected,
        got: decision,
        match,
        elapsed: Date.now() - start,
        category: task.category
      });

      console.log(`  ${match ? '✅' : '❌'} "${task.input.slice(0, 50)}..." → ${decision} (expected ${task.expected}) ${Math.round((Date.now() - start) / 1000)}s`);
    } catch (e) {
      // Timeout or error — still record
      results.push({
        input: task.input.slice(0, 60),
        expected: task.expected,
        got: 'error',
        match: false,
        elapsed: Date.now() - start,
        category: task.category,
        error: e.message?.slice(0, 100)
      });
      console.log(`  ❌ "${task.input.slice(0, 50)}..." → ERROR (expected ${task.expected}) ${e.message?.slice(0, 50)}`);
    }
  }

  return { correct, total: TASKS.length, accuracy: Math.round((correct / TASKS.length) * 100), results };
}

// Main
const model = process.env.CREW_EXECUTION_MODEL || 'default';
console.log(`\nL1 Router Benchmark — model: ${model}\n`);

const result = await testRouter(model);

console.log(`\n=== SUMMARY ===`);
console.log(`Accuracy: ${result.accuracy}% (${result.correct}/${result.total})`);
console.log(`By category:`);
const byCat = {};
for (const r of result.results) {
  if (!byCat[r.category]) byCat[r.category] = { correct: 0, total: 0 };
  byCat[r.category].total++;
  if (r.match) byCat[r.category].correct++;
}
for (const [cat, stats] of Object.entries(byCat)) {
  console.log(`  ${cat}: ${stats.correct}/${stats.total}`);
}

// Save results
const modelSlug = model.replace(/[/:]/g, '-').replace(/^-+|-+$/g, '');
const resultsDir = join(process.cwd(), 'benchmarks', 'results', 'l1');
await mkdir(resultsDir, { recursive: true });
const outFile = join(resultsDir, `${modelSlug}.json`);
await writeFile(outFile, JSON.stringify({
  ts: new Date().toISOString(),
  model,
  benchmark: 'l1-router',
  accuracy: result.accuracy,
  correct: result.correct,
  total: result.total,
  results: result.results
}, null, 2));
console.log(`\nSaved: ${outFile}`);
