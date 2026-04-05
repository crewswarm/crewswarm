#!/usr/bin/env node
/**
 * Automated sweep over action ranking weights.
 *
 * Runs benchmark tasks with different weight configurations and
 * collects trajectory scores to find optimal defaults.
 *
 * Usage:
 *   node scripts/benchmark-sweep-weights.mjs
 *   node scripts/benchmark-sweep-weights.mjs --iterations 5
 *   node scripts/benchmark-sweep-weights.mjs --mode bugfix
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const CREW_CLI = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const CREW_ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

const { runAgenticWorker, Sandbox, RunEngine } = await import(`${CREW_CLI}/dist/engine.mjs`);
const { scoreTaskTrajectory } = await import(`${CREW_ROOT}/lib/autoharness/index.mjs`);
const { computeAdaptiveWeights } = await import(`${CREW_CLI}/dist/engine.mjs`).then(m => m).catch(() => ({}));

const { values: args } = parseArgs({
  options: {
    iterations: { type: 'string', default: '3' },
    mode: { type: 'string', default: 'all' },
    model: { type: 'string', default: 'gemini-2.5-flash' },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: false,
});

if (args.help) {
  console.log(`Usage: node scripts/benchmark-sweep-weights.mjs [options]
  --iterations <n>   Runs per weight config (default: 3)
  --mode <mode>      Task mode to sweep (bugfix|feature|refactor|test_repair|analysis|all)
  --model <id>       Model to use (default: gemini-2.5-flash)
  -h, --help         Show this help`);
  process.exit(0);
}

// Force API key routing for consistency
process.env.CREW_NO_OAUTH = 'true';

const ITERATIONS = parseInt(args.iterations, 10);
const MODEL = args.model;

// Tasks by mode
const TASKS = {
  bugfix: {
    task: 'Fix the divide function in src/math.ts to throw an error on division by zero instead of returning Infinity',
    fixture: 'math',
  },
  feature: {
    task: 'Add a modulo(a, b) function to src/math.ts that returns the remainder, and export it',
    fixture: 'math',
  },
  refactor: {
    task: 'Refactor src/utils.ts: rename the clamp function to clampValue and update all references',
    fixture: 'utils',
  },
  test_repair: {
    task: 'The test in test/utils.test.ts for truncate is wrong — it expects truncate("hello world", 5) to return "hello" but the implementation returns "hello...". Fix the test to match the actual behavior, then run the tests.',
    fixture: 'utils',
  },
  analysis: {
    task: 'Analyze src/utils.ts and src/math.ts: list all exported functions, their parameter types, and suggest which ones need input validation',
    fixture: 'both',
  },
};

// Weight variations to test
const WEIGHT_CONFIGS = [
  { name: 'default', weights: null }, // use current defaults
  { name: 'verify-heavy', adjust: { test: 0.15, verify: 0.15, edit: -0.1, read: -0.1 } },
  { name: 'read-first', adjust: { read: 0.2, search: 0.1, edit: -0.15, test: -0.05 } },
  { name: 'action-bias', adjust: { edit: 0.15, test: 0.1, read: -0.1, search: -0.1 } },
  { name: 'balanced', adjust: { read: 0.05, edit: 0.05, test: 0.05, verify: 0.05, search: -0.05, delegate: -0.05 } },
];

const FIXTURES = {
  math: {
    'src/math.ts': `export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function subtract(a: number, b: number): number {\n  return a - b;\n}\n\nexport function multiply(a: number, b: number): number {\n  return a * b;\n}\n\n// BUG: division by zero not handled\nexport function divide(a: number, b: number): number {\n  return a / b;\n}\n`,
    'test/math.test.ts': `import { add, subtract, multiply, divide } from '../src/math.ts';\nconsole.log('add:', add(2, 3) === 5 ? 'PASS' : 'FAIL');\nconsole.log('subtract:', subtract(5, 3) === 2 ? 'PASS' : 'FAIL');\nconsole.log('multiply:', multiply(3, 4) === 12 ? 'PASS' : 'FAIL');\nconsole.log('divide-by-zero:', (() => { try { const r = divide(1, 0); return r === Infinity ? 'FAIL — should throw' : 'PASS'; } catch { return 'PASS'; } })());\n`,
  },
  utils: {
    'src/utils.ts': `export function clamp(value: number, min: number, max: number): number {\n  if (value < min) return min;\n  if (value > max) return max;\n  return value;\n}\n\nexport function slugify(text: string): string {\n  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');\n}\n\nexport function truncate(str: string, length: number): string {\n  if (str.length <= length) return str;\n  return str.slice(0, length) + '...';\n}\n`,
    'test/utils.test.ts': `import { clamp, slugify, truncate } from '../src/utils.ts';\nconsole.log('clamp-low:', clamp(-5, 0, 10) === 0 ? 'PASS' : 'FAIL');\nconsole.log('clamp-high:', clamp(15, 0, 10) === 10 ? 'PASS' : 'FAIL');\nconsole.log('slugify:', slugify('Hello World!') === 'hello-world' ? 'PASS' : 'FAIL');\nconsole.log('truncate:', truncate('hello world', 5) === 'hello' ? 'PASS' : 'FAIL');\nconsole.log('truncate-short:', truncate('hi', 5) === 'hi' ? 'PASS' : 'FAIL');\n`,
  },
};

async function setupFixture(dir, fixtureType) {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { execSync } = await import('node:child_process');

  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'sweep-fixture', version: '1.0.0', type: 'module',
    scripts: { test: 'node --experimental-strip-types test/*.test.ts', build: 'node --experimental-strip-types --check src/*.ts' }
  }, null, 2));

  const files = fixtureType === 'both'
    ? { ...FIXTURES.math, ...FIXTURES.utils }
    : FIXTURES[fixtureType] || FIXTURES.math;

  for (const [path, content] of Object.entries(files)) {
    const dir2 = join(dir, path.includes('/') ? path.split('/').slice(0, -1).join('/') : '');
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir, path), content);
  }

  try { execSync('git init && git add -A && git commit -m init', { cwd: dir, stdio: 'pipe' }); } catch {}
}

async function runOne(task, fixtureType, model) {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'sweep-'));

  try {
    await setupFixture(dir, fixtureType);
    const sandbox = new Sandbox(dir);
    const result = await runAgenticWorker(task, sandbox, {
      model, maxTurns: 8, projectDir: dir,
    });

    const trajectory = scoreTaskTrajectory({
      success: result.success,
      actions: (result.history || []).map(h => ({
        tool: h.tool,
        target: h.params?.file_path || h.params?.path || h.params?.command,
        commandPrefix: h.params?.command ? String(h.params.command).split(' ')[0] : undefined,
      })),
    });

    return {
      success: result.success,
      turns: result.turns,
      score: trajectory.trajectoryScore,
      verified: trajectory.hasVerification,
      readWrite: trajectory.readBeforeWriteRatio,
      cost: result.cost || 0,
    };
  } catch (err) {
    return { success: false, turns: 0, score: 0, verified: false, readWrite: 0, cost: 0, error: err.message };
  } finally {
    const { rmSync } = await import('node:fs');
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Main sweep
// ---------------------------------------------------------------------------

const modes = args.mode === 'all'
  ? Object.keys(TASKS)
  : [args.mode];

console.log(`Sweep: ${modes.length} modes × ${WEIGHT_CONFIGS.length} configs × ${ITERATIONS} iterations = ${modes.length * WEIGHT_CONFIGS.length * ITERATIONS} runs`);
console.log(`Model: ${MODEL}\n`);

const allResults = [];

for (const mode of modes) {
  const { task, fixture } = TASKS[mode];
  console.log(`\n${'='.repeat(60)}`);
  console.log(`MODE: ${mode}`);
  console.log('='.repeat(60));

  for (const config of WEIGHT_CONFIGS) {
    const scores = [];
    process.stdout.write(`  ${config.name.padEnd(15)}`);

    for (let i = 0; i < ITERATIONS; i++) {
      const result = await runOne(task, fixture, MODEL);
      scores.push(result);
      process.stdout.write(result.success ? '✓' : '✗');
    }

    const avgScore = scores.reduce((s, r) => s + r.score, 0) / scores.length;
    const passRate = scores.filter(r => r.success).length / scores.length;
    const avgTurns = scores.reduce((s, r) => s + r.turns, 0) / scores.length;

    console.log(`  score=${avgScore.toFixed(3)} pass=${passRate.toFixed(1)} turns=${avgTurns.toFixed(1)}`);

    allResults.push({
      mode, config: config.name,
      avgScore, passRate, avgTurns,
      runs: scores,
    });
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'='.repeat(60)}`);
console.log('SWEEP RESULTS');
console.log('='.repeat(60));

// Find best config per mode
for (const mode of modes) {
  const modeResults = allResults.filter(r => r.mode === mode);
  modeResults.sort((a, b) => b.avgScore - a.avgScore);
  const best = modeResults[0];
  console.log(`${mode}: best=${best.config} score=${best.avgScore.toFixed(3)} pass=${best.passRate.toFixed(1)}`);
  for (const r of modeResults) {
    const marker = r === best ? ' ★' : '';
    console.log(`  ${r.config.padEnd(15)} score=${r.avgScore.toFixed(3)} pass=${r.passRate.toFixed(1)} turns=${r.avgTurns.toFixed(1)}${marker}`);
  }
}

// Save results
const outPath = join(CREW_CLI, '.crew', 'benchmarks', 'sweep-latest.json');
try {
  mkdirSync(join(CREW_CLI, '.crew', 'benchmarks'), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ timestamp: new Date().toISOString(), model: MODEL, modes, results: allResults }, null, 2));
  console.log(`\nResults saved to ${outPath}`);
} catch {}
