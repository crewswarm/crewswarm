#!/usr/bin/env node
/**
 * benchmark-l3-executor.mjs — L3 Executor-only quality benchmark
 *
 * Same tasks as benchmark-quality.mjs but calls runAgenticWorker directly,
 * skipping L1 routing and L2 planning. Tests pure model coding quality
 * without pipeline overhead.
 *
 * Usage: CREW_EXECUTION_MODEL=gemini-2.5-flash node scripts/benchmark-l3-executor.mjs
 *        CREW_EXECUTION_MODEL=ollama:glm-5.1:cloud node scripts/benchmark-l3-executor.mjs
 */

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Fixture (same as benchmark-quality.mjs)
// ---------------------------------------------------------------------------

async function seedFixture(dir) {
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(join(dir, 'test'), { recursive: true });

  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'bench-l3-fixture',
    version: '1.0.0',
    type: 'module',
    scripts: {
      test: 'node --experimental-strip-types test/math.test.ts',
      build: 'node --experimental-strip-types --check src/math.ts src/utils.ts',
      'test:all': 'node --experimental-strip-types test/math.test.ts; node --experimental-strip-types test/utils.test.ts'
    }
  }, null, 2));

  await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'ESNext', moduleResolution: 'Node',
      strict: true, noEmit: true, esModuleInterop: true, skipLibCheck: true
    },
    include: ['src/**/*.ts']
  }, null, 2));

  await writeFile(join(dir, 'src', 'math.ts'), `
export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

// BUG: does not handle division by zero
export function divide(a: number, b: number): number {
  return a / b;
}
`.trimStart());

  await writeFile(join(dir, 'src', 'utils.ts'), `
export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// BUG: does not collapse consecutive hyphens — slugify("hello---world") returns "hello---world"
export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/^-|-$/g, '');
}

export function truncate(str: string, length: number): string {
  if (str.length <= length) return str;
  return str.slice(0, length) + '...';
}
`.trimStart());

  await writeFile(join(dir, 'test', 'math.test.ts'), `
import { add, subtract, multiply, divide } from '../src/math.ts';

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean) {
  if (condition) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name); }
}

assert('add(2,3)=5', add(2, 3) === 5);
assert('add(-1,1)=0', add(-1, 1) === 0);
assert('subtract(5,3)=2', subtract(5, 3) === 2);
assert('multiply(3,4)=12', multiply(3, 4) === 12);
assert('divide(10,2)=5', divide(10, 2) === 5);
assert('divide(1,0) throws', (() => {
  try { divide(1, 0); return false; } catch { return true; }
})());

console.log('\\nResults: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
`.trimStart());

  await writeFile(join(dir, 'test', 'utils.test.ts'), `
import { clamp, slugify, truncate } from '../src/utils.ts';

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean) {
  if (condition) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name); }
}

assert('clamp(-5,0,10)=0', clamp(-5, 0, 10) === 0);
assert('clamp(15,0,10)=10', clamp(15, 0, 10) === 10);
assert('clamp(5,0,10)=5', clamp(5, 0, 10) === 5);
assert('slugify(Hello World!)=hello-world', slugify('Hello World!') === 'hello-world');
assert('slugify(hello---world)=hello-world', slugify('hello---world') === 'hello-world');
assert('truncate(hello,3)=hel...', truncate('hello', 3) === 'hel...');
assert('truncate(hi,5)=hi', truncate('hi', 5) === 'hi');

console.log('\\nResults: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
`.trimStart());

  try {
    execSync('git init && git add -A && git commit -m "initial fixture"', { cwd: dir, stdio: 'pipe' });
  } catch {}
}

// ---------------------------------------------------------------------------
// Tasks (same as benchmark-quality.mjs)
// ---------------------------------------------------------------------------

const TASKS = [
  {
    id: 'bugfix-divide-by-zero',
    description: 'Fix the divide function in src/math.ts to throw an Error when dividing by zero instead of returning Infinity.',
    verify: 'node --experimental-strip-types test/math.test.ts',
    expectPass: 6,
    difficulty: 'easy'
  },
  {
    id: 'feature-modulo',
    description: 'Add a modulo(a: number, b: number): number function to src/math.ts that returns the remainder. Export it. Add a test for modulo(7, 3) === 1 in test/math.test.ts.',
    verify: 'node --experimental-strip-types test/math.test.ts',
    expectPass: 6,
    difficulty: 'medium'
  },
  {
    id: 'refactor-rename-clamp',
    description: 'Rename the clamp function in src/utils.ts to clampValue. Update the export and update test/utils.test.ts to use the new name. All tests must still pass.',
    verify: 'node --experimental-strip-types test/utils.test.ts',
    expectPass: 6,
    difficulty: 'medium'
  },
  {
    id: 'multi-file-calculator',
    description: 'Create a new file src/calculator.ts that imports add, subtract, multiply, divide from src/math.ts and exports an evaluate(expr: string) function that parses simple expressions like "2 + 3" or "10 / 5" (operands separated by spaces) and returns the numeric result. It should throw an Error for unknown operators. Also create test/calculator.test.ts with tests for +, -, *, /, unknown operator error, and division by zero error. Fix the divide-by-zero bug in src/math.ts first so the test passes. Run all tests.',
    verify: 'node --experimental-strip-types test/calculator.test.ts',
    expectPass: 6,
    difficulty: 'hard'
  },
  {
    id: 'multi-file-extract-module',
    description: 'Extract the slugify function from src/utils.ts into a new file src/slugify.ts. The new file should export slugify. Remove slugify from src/utils.ts and add a re-export: export { slugify } from "./slugify.ts". Update test/utils.test.ts to also import from src/slugify.ts directly and add a test that slugify("  Lots   of   Spaces  ") === "lots-of-spaces". All existing tests must still pass. Run the tests.',
    verify: 'node --experimental-strip-types test/utils.test.ts',
    expectPass: 7,
    difficulty: 'hard'
  },
  {
    id: 'bugfix-chain',
    description: 'There are two bugs to fix across two files: (1) divide in src/math.ts returns Infinity on division by zero — it should throw an Error, and (2) slugify in src/utils.ts does not collapse consecutive hyphens — slugify("hello---world") returns "hello---world" instead of "hello-world" (the regex replace needs a + quantifier on the character class). Fix both bugs, then run npm run test:all to verify both test suites pass.',
    verify: 'npm run test:all',
    expectPass: 13,
    difficulty: 'hard'
  }
];

// ---------------------------------------------------------------------------
// Quality checks (same as benchmark-quality.mjs)
// ---------------------------------------------------------------------------

function runCommand(cmd, cwd) {
  try {
    const output = execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf8', timeout: Number(process.env.CREW_BENCHMARK_TIMEOUT || 600) * 1000 });
    return { ok: true, output: output.trim(), exitCode: 0 };
  } catch (err) {
    return { ok: false, output: String(err.stdout || '') + String(err.stderr || ''), exitCode: err.status || 1 };
  }
}

function checkTypeScript(dir) {
  const tsc = runCommand('npx tsc --noEmit 2>&1 || node --experimental-strip-types --check src/math.ts src/utils.ts', dir);
  return { name: 'typecheck', ...tsc };
}

function checkTests(dir, verifyCmd) {
  const result = runCommand(verifyCmd, dir);
  const passes = (result.output.match(/^PASS /gm) || []).length;
  const fails = (result.output.match(/^FAIL /gm) || []).length;
  return { name: 'tests', ...result, passes, fails, total: passes + fails };
}

function checkDiffSize(dir) {
  const initialCommit = runCommand('git rev-list --max-parents=0 HEAD', dir);
  const baseRef = initialCommit.ok && initialCommit.output.trim() ? initialCommit.output.trim() : 'HEAD';
  const diff = runCommand(`git diff --stat ${baseRef} -- . ":(exclude).crew"`, dir);
  const lines = diff.output.split('\n').filter(l => l.trim());
  const insertions = (diff.output.match(/(\d+) insertion/)?.[1] || '0');
  const deletions = (diff.output.match(/(\d+) deletion/)?.[1] || '0');
  return { name: 'diff', filesChanged: lines.length > 1 ? lines.length - 1 : 0, insertions: Number(insertions), deletions: Number(deletions), ok: true };
}

function checkUtilsUnbroken(dir) {
  const result = runCommand('node --experimental-strip-types test/utils.test.ts', dir);
  const passes = (result.output.match(/^PASS /gm) || []).length;
  return { name: 'no-regression', ok: result.ok, passes };
}

function computeQualityScore(task, tests, typecheck, diff, noRegression, baselineTests = null) {
  let score = 0;
  if (tests.total > 0) {
    const target = task.expectPass || tests.total;
    const baselinePasses = baselineTests?.passes || 0;
    const newPasses = Math.max(0, tests.passes - baselinePasses);
    const neededPasses = Math.max(1, target - baselinePasses);
    const passRatio = Math.min(1, newPasses / neededPasses);
    score += Math.round(passRatio * 50);
  }
  if (typecheck.ok) score += 20;
  if (noRegression.ok) score += 15;
  const totalChanges = diff.insertions + diff.deletions;
  const diffThresholds = {
    easy:   { full: 5,  mid: 15, low: 30 },
    medium: { full: 15, mid: 25, low: 50 },
    hard:   { full: 30, mid: 60, low: 100 }
  };
  const t = diffThresholds[task.difficulty] || diffThresholds.medium;
  if (totalChanges <= t.full) score += 15;
  else if (totalChanges <= t.mid) score += 10;
  else if (totalChanges <= t.low) score += 5;
  return Math.min(100, score);
}

// ---------------------------------------------------------------------------
// Runner — calls runAgenticWorker directly (NO L1/L2 pipeline)
// ---------------------------------------------------------------------------

async function runTask(task, model) {
  const dir = await mkdtemp(join(tmpdir(), `crew-l3-${task.id}-`));
  await seedFixture(dir);
  const baselineRegression = checkUtilsUnbroken(dir);
  const baselineTests = checkTests(dir, task.verify);

  const start = Date.now();
  try {
    const { Sandbox, runAgenticWorker } = await import('../dist/engine.mjs');
    const sandbox = new Sandbox(dir);

    const result = await runAgenticWorker(task.description, sandbox, {
      model: model,
      maxTurns: 25,
      projectDir: dir,
      verbose: Boolean(process.env.CREW_VERBOSE),
    });

    // Apply sandbox changes
    if (sandbox.hasChanges?.()) {
      await sandbox.apply();
    }

    const elapsed = Date.now() - start;
    try { execSync('sync', { cwd: dir, stdio: 'ignore', timeout: 5000 }); } catch {}

    const typecheck = checkTypeScript(dir);
    const tests = checkTests(dir, task.verify);
    const diff = checkDiffSize(dir);
    const afterRegression = checkUtilsUnbroken(dir);
    const noRegression = { ...afterRegression, ok: afterRegression.passes >= baselineRegression.passes };

    return {
      taskId: task.id,
      difficulty: task.difficulty,
      model,
      elapsed,
      agentSuccess: result.success ?? true,
      typecheckPasses: typecheck.ok,
      testsPassed: tests.passes,
      testsFailed: tests.fails,
      testsTotal: tests.total,
      allTestsPass: tests.ok,
      noRegression: noRegression.ok,
      diffInsertions: diff.insertions,
      diffDeletions: diff.deletions,
      diffFiles: diff.filesChanged,
      qualityScore: computeQualityScore(task, tests, typecheck, diff, noRegression, baselineTests),
      turns: result.turns || 0,
      toolsUsed: result.toolsUsed || [],
      cost: result.cost || 0,
    };
  } catch (err) {
    return {
      taskId: task.id, difficulty: task.difficulty, model,
      elapsed: Date.now() - start, error: err.message, qualityScore: 0
    };
  } finally {
    if (!process.env.CREW_BENCH_VERBOSE) {
      try { await rm(dir, { recursive: true, force: true }); } catch {}
    } else {
      console.log('  [debug] Preserved: ' + dir);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const model = process.env.CREW_EXECUTION_MODEL || 'default';
const args = process.argv.slice(2);
const taskFilter = args.find(a => !a.startsWith('-'));
const tasksToRun = taskFilter ? TASKS.filter(t => t.id.includes(taskFilter)) : TASKS;

console.log(`\nL3 Executor Benchmark (no L1/L2) — model: ${model}\n`);

const results = [];
for (const task of tasksToRun) {
  console.log(`=== ${task.id} (${task.difficulty}) ===`);
  console.log(`  Task: ${task.description.slice(0, 80)}...`);
  const score = await runTask(task, model);
  results.push(score);
  const turnsStr = score.turns ? ` turns=${score.turns}` : '';
  const costStr = score.cost ? ` cost=$${score.cost.toFixed(4)}` : '';
  const toolsStr = score.toolsUsed?.length ? ` tools=${score.toolsUsed.join(',')}` : '';
  console.log(`  Result: quality=${score.qualityScore}/100 tests=${score.testsPassed}/${score.testsTotal} typecheck=${score.typecheckPasses ? 'PASS' : 'FAIL'} regression=${score.noRegression ? 'NONE' : 'YES'} diff=+${score.diffInsertions}-${score.diffDeletions} (${Math.round(score.elapsed / 1000)}s)${turnsStr}${costStr}${toolsStr}`);
  console.log('');
}

console.log('=== SUMMARY ===');
const avgScore = results.reduce((s, r) => s + (r.qualityScore || 0), 0) / results.length;
const allPass = results.every(r => r.allTestsPass);
console.log(`Average quality score: ${avgScore.toFixed(0)}/100`);
console.log(`All tests pass: ${allPass}`);
console.log(`Tasks: ${results.filter(r => r.qualityScore >= 80).length}/${results.length} high quality (80+)`);

const modelSlug = model.replace(/[/:]/g, '-').replace(/^-+|-+$/g, '');
const resultsDir = join(process.cwd(), 'benchmarks', 'results', 'l3');
await mkdir(resultsDir, { recursive: true });
const outFile = join(resultsDir, `${modelSlug}.json`);
await writeFile(outFile, JSON.stringify({
  ts: new Date().toISOString(),
  model,
  benchmark: 'l3-executor',
  avgScore,
  allPass,
  highQuality: results.filter(r => r.qualityScore >= 80).length,
  totalTasks: results.length,
  results
}, null, 2));
console.log(`\nSaved: ${outFile}`);
