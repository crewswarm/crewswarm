#!/usr/bin/env node
/**
 * benchmark-quality.mjs — L3 worker quality benchmark
 *
 * Tests whether agents produce correct, compilable code that passes tests.
 * Unlike benchmark-presets (which checks "did files get created?"), this
 * checks "does the code actually work?"
 *
 * Each task has:
 *   - A fixture project (package.json, tsconfig, src, tests)
 *   - A task description (bugfix, feature, refactor)
 *   - Expected outcomes (which tests should pass, which files should change)
 *   - Quality checks (tsc --strict, test pass rate, diff size)
 */

import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Fixture: a small TypeScript project with bugs and tests
// ---------------------------------------------------------------------------

async function seedFixture(dir) {
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(join(dir, 'test'), { recursive: true });

  // package.json with test + build scripts
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'bench-quality-fixture',
    version: '1.0.0',
    type: 'module',
    scripts: {
      test: 'node --experimental-strip-types test/math.test.ts',
      build: 'node --experimental-strip-types --check src/math.ts src/utils.ts',
      'test:all': 'node --experimental-strip-types test/math.test.ts && node --experimental-strip-types test/utils.test.ts'
    }
  }, null, 2));

  // tsconfig.json
  await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Node',
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      skipLibCheck: true
    },
    include: ['src/**/*.ts']
  }, null, 2));

  // src/math.ts — has a division-by-zero bug
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

  // src/utils.ts — working code, used for refactor tasks
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

  // test/math.test.ts — tests that verify the bugfix
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

  // test/utils.test.ts
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

  // Init git
  try {
    execSync('git init && git add -A && git commit -m "initial fixture"', { cwd: dir, stdio: 'pipe' });
  } catch {}
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const TASKS = [
  {
    id: 'bugfix-divide-by-zero',
    description: 'Fix the divide function in src/math.ts to throw an Error when dividing by zero instead of returning Infinity.',
    verify: 'npm test',
    expectTests: 6,
    expectPass: 6,
    expectFiles: ['src/math.ts'],
    difficulty: 'easy'
  },
  {
    id: 'feature-modulo',
    description: 'Add a modulo(a: number, b: number): number function to src/math.ts that returns the remainder. Export it. Add a test for modulo(7, 3) === 1 in test/math.test.ts.',
    verify: 'node --experimental-strip-types test/math.test.ts',
    expectTests: 7,
    expectPass: 6,  // 5 original passing + 1 new modulo test (divide-by-zero still fails in fixture)
    expectFiles: ['src/math.ts', 'test/math.test.ts'],
    difficulty: 'medium'
  },
  {
    id: 'refactor-rename-clamp',
    description: 'Rename the clamp function in src/utils.ts to clampValue. Update the export and update test/utils.test.ts to use the new name. All tests must still pass.',
    verify: 'node --experimental-strip-types test/utils.test.ts',
    expectPass: 7,
    expectFiles: ['src/utils.ts', 'test/utils.test.ts'],
    difficulty: 'medium'
  },
  // ── Hard tier: multi-file, requires planning ──
  {
    id: 'multi-file-calculator',
    description: 'Create a new file src/calculator.ts that imports add, subtract, multiply, divide from src/math.ts and exports an evaluate(expr: string) function that parses simple expressions like "2 + 3" or "10 / 5" (operands separated by spaces) and returns the numeric result. It should throw an Error for unknown operators. Also create test/calculator.test.ts with tests for +, -, *, /, unknown operator error, and division by zero error. Fix the divide-by-zero bug in src/math.ts first so the test passes. Run all tests.',
    verify: 'node --experimental-strip-types test/calculator.test.ts',
    expectPass: 6,
    expectFiles: ['src/calculator.ts', 'test/calculator.test.ts', 'src/math.ts'],
    difficulty: 'hard'
  },
  {
    id: 'multi-file-extract-module',
    description: 'Extract the slugify function from src/utils.ts into a new file src/slugify.ts. The new file should export slugify. Remove slugify from src/utils.ts and add a re-export: export { slugify } from "./slugify.ts". Update test/utils.test.ts to also import from src/slugify.ts directly and add a test that slugify("  Lots   of   Spaces  ") === "lots-of-spaces". All existing tests must still pass. Run the tests.',
    verify: 'node --experimental-strip-types test/utils.test.ts',
    expectPass: 7,
    expectFiles: ['src/slugify.ts', 'src/utils.ts', 'test/utils.test.ts'],
    difficulty: 'hard'
  },
  {
    id: 'bugfix-chain',
    description: 'There are two bugs to fix across two files: (1) divide in src/math.ts returns Infinity on division by zero — it should throw an Error, and (2) slugify in src/utils.ts does not collapse consecutive hyphens — slugify("hello---world") returns "hello---world" instead of "hello-world" (the regex replace needs a + quantifier on the character class). Fix both bugs, then run npm run test:all to verify both test suites pass.',
    verify: 'npm run test:all',
    expectPass: 13,
    expectFiles: ['src/math.ts', 'src/utils.ts'],
    difficulty: 'hard'
  }
];

// ---------------------------------------------------------------------------
// Quality checks
// ---------------------------------------------------------------------------

function runCommand(cmd, cwd) {
  try {
    const output = execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf8', timeout: 180000 });
    return { ok: true, output: output.trim(), exitCode: 0 };
  } catch (err) {
    return {
      ok: false,
      output: String(err.stdout || '') + String(err.stderr || ''),
      exitCode: err.status || 1
    };
  }
}

function checkTypeScript(dir) {
  // Try tsc --noEmit if available, else use node --check
  const tsc = runCommand('npx tsc --noEmit 2>&1 || node --experimental-strip-types --check src/math.ts src/utils.ts', dir);
  return { name: 'typecheck', ...tsc };
}

function checkTests(dir, verifyCmd) {
  const result = runCommand(verifyCmd, dir);
  // Count PASS/FAIL lines
  const passes = (result.output.match(/^PASS /gm) || []).length;
  const fails = (result.output.match(/^FAIL /gm) || []).length;
  return { name: 'tests', ...result, passes, fails, total: passes + fails };
}

function checkDiffSize(dir) {
  // Exclude .crew/ metadata from diff — only count real source changes
  const diff = runCommand('git diff --stat HEAD -- . ":(exclude).crew"', dir);
  const lines = diff.output.split('\n').filter(l => l.trim());
  const insertions = (diff.output.match(/(\d+) insertion/)?.[1] || '0');
  const deletions = (diff.output.match(/(\d+) deletion/)?.[1] || '0');
  return {
    name: 'diff',
    filesChanged: lines.length > 1 ? lines.length - 1 : 0, // last line is summary
    insertions: Number(insertions),
    deletions: Number(deletions),
    ok: true
  };
}

function checkUtilsUnbroken(dir) {
  // Verify utils tests still pass (no regressions)
  const result = runCommand('node --experimental-strip-types test/utils.test.ts', dir);
  const passes = (result.output.match(/^PASS /gm) || []).length;
  return { name: 'no-regression', ok: result.ok, passes };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runTask(task, model, envOverrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), `crew-quality-${task.id}-`));
  await seedFixture(dir);

  // Verify fixture: tests should fail before fix (for bugfix tasks)
  if (task.id.startsWith('bugfix')) {
    const before = checkTests(dir, task.verify);
    if (before.ok) {
      console.log(`  [pre-check] Tests already pass — fixture may be wrong`);
    }
  }

  // Run the agent
  const start = Date.now();
  const env = {
    ...process.env,
    CREW_NO_OAUTH: 'true',
    ...envOverrides
  };

  try {
    const crewCli = resolve(process.cwd(), 'dist', 'crew.mjs');
    const result = runCommand(
      `node ${crewCli} run -t ${JSON.stringify(task.description)} --json`,
      dir
    );
    const elapsed = Date.now() - start;

    // Ensure filesystem is synced before quality checks
    try { execSync('sync', { cwd: dir, stdio: 'ignore', timeout: 5000 }); } catch {}

    // Quality checks
    const typecheck = checkTypeScript(dir);
    const tests = checkTests(dir, task.verify);
    const diff = checkDiffSize(dir);
    const noRegression = checkUtilsUnbroken(dir);

    // Debug: show individual test results when not all pass
    if (!tests.ok && process.env.CREW_BENCH_VERBOSE) {
      console.log('  [test output] ' + tests.output.replace(/\n/g, '\n  [test output] '));
    }

    const score = {
      taskId: task.id,
      difficulty: task.difficulty,
      model,
      elapsed,
      agentSuccess: result.ok,
      typecheckPasses: typecheck.ok,
      testsPassed: tests.passes,
      testsFailed: tests.fails,
      testsTotal: tests.total,
      allTestsPass: tests.ok,
      noRegression: noRegression.ok,
      diffInsertions: diff.insertions,
      diffDeletions: diff.deletions,
      diffFiles: diff.filesChanged,
      // Composite quality score (0-100)
      qualityScore: computeQualityScore(task, tests, typecheck, diff, noRegression)
    };

    return score;
  } catch (err) {
    return {
      taskId: task.id,
      difficulty: task.difficulty,
      model,
      elapsed: Date.now() - start,
      error: err.message,
      qualityScore: 0
    };
  } finally {
    // Cleanup — skip when verbose for debugging
    if (!process.env.CREW_BENCH_VERBOSE) {
      try { await rm(dir, { recursive: true, force: true }); } catch {}
    } else {
      console.log('  [debug] Preserved: ' + dir);
    }
  }
}

function computeQualityScore(task, tests, typecheck, diff, noRegression) {
  let score = 0;

  // Tests pass (50 points max)
  if (tests.total > 0) {
    score += Math.round((tests.passes / Math.max(tests.total, task.expectPass || 1)) * 50);
  }

  // Typecheck passes (20 points)
  if (typecheck.ok) score += 20;

  // No regressions (15 points)
  if (noRegression.ok) score += 15;

  // Diff efficiency (15 points) — smaller is better
  const totalChanges = diff.insertions + diff.deletions;
  if (totalChanges <= 5) score += 15;
  else if (totalChanges <= 15) score += 10;
  else if (totalChanges <= 30) score += 5;

  return Math.min(100, score);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
// Skip --out and its value when looking for task filter
const filteredArgs = args.filter((a, i) => i !== outIdx && (outIdx < 0 || i !== outIdx + 1));
const taskFilter = filteredArgs.find(a => !a.startsWith('-'));

const tasksToRun = taskFilter
  ? TASKS.filter(t => t.id.includes(taskFilter))
  : TASKS;

console.log(`\nRunning ${tasksToRun.length} quality benchmark task(s)...\n`);

const results = [];
for (const task of tasksToRun) {
  console.log(`=== ${task.id} (${task.difficulty}) ===`);
  console.log(`  Task: ${task.description.slice(0, 80)}...`);
  const score = await runTask(task, process.env.CREW_EXECUTION_MODEL || 'default');
  results.push(score);
  console.log(`  Result: quality=${score.qualityScore}/100 tests=${score.testsPassed}/${score.testsTotal} typecheck=${score.typecheckPasses ? 'PASS' : 'FAIL'} regression=${score.noRegression ? 'NONE' : 'YES'} diff=+${score.diffInsertions}-${score.diffDeletions} (${Math.round(score.elapsed / 1000)}s)`);
  console.log('');
}

// Summary
console.log('=== SUMMARY ===');
const avgScore = results.reduce((s, r) => s + (r.qualityScore || 0), 0) / results.length;
const allPass = results.every(r => r.allTestsPass);
console.log(`Average quality score: ${avgScore.toFixed(0)}/100`);
console.log(`All tests pass: ${allPass}`);
console.log(`Tasks: ${results.filter(r => r.qualityScore >= 80).length}/${results.length} high quality (80+)`);

if (outFile) {
  await writeFile(outFile, JSON.stringify({ ts: new Date().toISOString(), results, avgScore }, null, 2));
  console.log(`\nSaved: ${outFile}`);
}
