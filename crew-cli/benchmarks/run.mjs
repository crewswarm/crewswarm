#!/usr/bin/env node
/**
 * Crew-CLI Benchmark Runner
 *
 * Runs real coding tasks against a fixture Express/TypeScript project
 * to measure the crew-cli pipeline across all tiers (L1-L3).
 *
 * Usage:
 *   node benchmarks/run.mjs                          # run all tasks with default preset
 *   node benchmarks/run.mjs --preset turbo6           # specific preset
 *   node benchmarks/run.mjs --task t2-fix-test        # single task
 *   node benchmarks/run.mjs --tier 2                  # all tier-2 tasks
 *   node benchmarks/run.mjs --check                   # compare to baseline
 *   node benchmarks/run.mjs --update-baseline         # save current results as baseline
 */

import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import {
  readFile, writeFile, mkdir, cp, rm, readdir, stat,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BENCHMARKS_DIR = dirname(new URL(import.meta.url).pathname);
const CREW_CLI_DIR = resolve(BENCHMARKS_DIR, '..');
const CREW_ENTRY = resolve(CREW_CLI_DIR, 'dist', 'crew.mjs');
const TASKS_FILE = join(BENCHMARKS_DIR, 'tasks.json');
const BASELINE_FILE = join(BENCHMARKS_DIR, 'baseline.json');
const FIXTURE_DIR = join(BENCHMARKS_DIR, 'fixture');

const VALID_PRESETS = ['turbo6', 'fast6', 'balanced', 'quality'];
const DEFAULT_TIMEOUT_MS = 120_000;
// Tier-based timeouts: routing questions are fast, execution tasks need more time
const TIER_TIMEOUT_MS = { 1: 60_000, 2: 180_000, 3: 300_000, 4: 300_000 };

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    preset: '',
    taskId: '',
    tier: 0,
    check: false,
    updateBaseline: false,
    timeoutMs: 0,  // 0 = use tier-based default
    verbose: false,
    installDeps: true,
    preserveFailures: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--preset' && argv[i + 1]) { opts.preset = argv[++i]; continue; }
    if (a === '--task' && argv[i + 1]) { opts.taskId = argv[++i]; continue; }
    if (a === '--tier' && argv[i + 1]) { opts.tier = Number(argv[++i]); continue; }
    if (a === '--check') { opts.check = true; continue; }
    if (a === '--update-baseline') { opts.updateBaseline = true; continue; }
    if (a === '--timeout' && argv[i + 1]) { opts.timeoutMs = Number(argv[++i]); continue; }
    if (a === '--verbose' || a === '-v') { opts.verbose = true; continue; }
    if (a === '--no-install') { opts.installDeps = false; continue; }
    if (a === '--preserve-failures') { opts.preserveFailures = true; continue; }
  }

  if (opts.preset && !VALID_PRESETS.includes(opts.preset)) {
    console.error(`Invalid preset: ${opts.preset}. Valid: ${VALID_PRESETS.join(', ')}`);
    process.exit(1);
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Shell helper
// ---------------------------------------------------------------------------

function runShell(cmd, args, cwd, opts = {}) {
  return new Promise((resolve) => {
    const start = performance.now();
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, NODE_ENV: 'test', ...(opts.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: opts.shell || false,
    });

    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, opts.timeoutMs)
      : null;

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout,
        stderr,
        ms: Math.round(performance.now() - start),
        timedOut,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Fixture management
// ---------------------------------------------------------------------------

async function copyFixtureToTmp() {
  const tmpName = `crew-bench-${randomBytes(6).toString('hex')}`;
  const dest = join(tmpdir(), tmpName);
  await cp(FIXTURE_DIR, dest, { recursive: true });
  return dest;
}

async function installFixtureDeps(workDir) {
  const res = await runShell('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], workDir, {
    timeoutMs: 60_000,
  });
  if (res.code !== 0) {
    throw new Error(`npm install failed in ${workDir}: ${res.stderr.slice(-500)}`);
  }
}

async function cleanupTmpDir(dir) {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

async function fileExists(workDir, relPath) {
  try {
    await stat(join(workDir, relPath));
    return true;
  } catch {
    return false;
  }
}

async function fileContains(workDir, relPath, pattern) {
  try {
    const content = await readFile(join(workDir, relPath), 'utf8');
    return content.includes(pattern);
  } catch {
    return false;
  }
}

async function fileNotContains(workDir, relPath, pattern) {
  try {
    const content = await readFile(join(workDir, relPath), 'utf8');
    return !content.includes(pattern);
  } catch {
    // File doesn't exist means it doesn't contain it
    return true;
  }
}

async function verifyResponseContains(stdout, patterns) {
  const failures = [];
  const output = stdout.toLowerCase();
  for (const p of patterns) {
    if (!output.includes(p.toLowerCase())) {
      failures.push(`Response missing pattern: "${p}"`);
    }
  }
  return failures;
}

async function verifyShell(workDir, verify) {
  const failures = [];

  // Run shell commands
  if (verify.commands) {
    for (const cmd of verify.commands) {
      const parts = cmd.split(' ');
      const res = await runShell(parts[0], parts.slice(1), workDir, {
        timeoutMs: 30_000,
        shell: true,
      });
      if (res.code !== 0) {
        failures.push(`Command failed (exit ${res.code}): ${cmd}\n  stderr: ${res.stderr.trim().split('\n').slice(-3).join('\n  ')}`);
      }
    }
  }

  // Check required files
  if (verify.filesMustExist) {
    for (const f of verify.filesMustExist) {
      if (!(await fileExists(workDir, f))) {
        failures.push(`Required file missing: ${f}`);
      }
    }
  }

  // Check file contents
  if (verify.filesMustContain) {
    for (const [file, patterns] of Object.entries(verify.filesMustContain)) {
      for (const p of patterns) {
        if (!(await fileContains(workDir, file, p))) {
          failures.push(`File ${file} missing pattern: "${p}"`);
        }
      }
    }
  }

  // Check file must-not-contain
  if (verify.filesMustNotContain) {
    for (const [file, patterns] of Object.entries(verify.filesMustNotContain)) {
      for (const p of patterns) {
        if (!(await fileNotContains(workDir, file, p))) {
          failures.push(`File ${file} unexpectedly contains: "${p}"`);
        }
      }
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Diff: find changed files after task execution
// ---------------------------------------------------------------------------

async function findChangedFiles(workDir) {
  // Compare against the initial benchmark commit — the pipeline may auto-commit,
  // so we need to diff HEAD against the first commit, not just check unstaged changes.
  const firstCommit = await runShell('git', ['rev-list', '--max-parents=0', 'HEAD'], workDir, { timeoutMs: 5000 });
  const baseRef = firstCommit.code === 0 && firstCommit.stdout.trim()
    ? firstCommit.stdout.trim().split('\n')[0]
    : 'HEAD';

  // Committed changes since initial commit
  const res = await runShell('git', ['diff', '--name-only', baseRef, 'HEAD'], workDir, { timeoutMs: 5000 });
  const committed = res.code === 0 && res.stdout.trim() ? res.stdout.trim().split('\n').filter(Boolean) : [];

  // Staged but not yet committed
  const resCached = await runShell('git', ['diff', '--cached', '--name-only'], workDir, { timeoutMs: 5000 });
  const staged = resCached.code === 0 && resCached.stdout.trim() ? resCached.stdout.trim().split('\n').filter(Boolean) : [];

  // Unstaged modifications + untracked files
  const res2 = await runShell('git', ['status', '--porcelain'], workDir, { timeoutMs: 5000 });
  const working = res2.code === 0 && res2.stdout.trim()
    ? res2.stdout.trim().split('\n').map(line => line.slice(3).trim()).filter(Boolean)
    : [];

  return [...new Set([...committed, ...staged, ...working])];
}

// ---------------------------------------------------------------------------
// Preset env config (matches benchmark-presets.mjs conventions)
// ---------------------------------------------------------------------------

function presetEnv(preset) {
  const base = {
    CREW_USE_UNIFIED_ROUTER: 'true',
    CREW_ALLOW_EXECUTE_LOCAL: 'true',
  };

  switch (preset) {
    case 'turbo6':
      return { ...base, CREW_DUAL_L2_ENABLED: 'false', CREW_QA_LOOP_ENABLED: 'false' };
    case 'fast6':
      return { ...base, CREW_DUAL_L2_ENABLED: 'false', CREW_QA_LOOP_ENABLED: 'true' };
    case 'balanced':
      return { ...base, CREW_DUAL_L2_ENABLED: 'true', CREW_QA_LOOP_ENABLED: 'true' };
    case 'quality':
      return { ...base, CREW_DUAL_L2_ENABLED: 'true', CREW_QA_LOOP_ENABLED: 'true' };
    default:
      return base;
  }
}

// ---------------------------------------------------------------------------
// Task execution
// ---------------------------------------------------------------------------

async function runTask(task, workDir, opts) {
  const env = opts.preset ? presetEnv(opts.preset) : {};

  // Initialize a git repo so we can track changes
  await runShell('git', ['init'], workDir, { timeoutMs: 5000 });
  await runShell('git', ['add', '.'], workDir, { timeoutMs: 5000 });
  await runShell('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@test', 'commit', '-m', 'initial'], workDir, { timeoutMs: 10000 });

  const args = [CREW_ENTRY, 'run', '-t', task.prompt, '--json'];

  if (opts.verbose) {
    console.log(`  CMD: node ${args.join(' ')}`);
    console.log(`  CWD: ${workDir}`);
  }

  const start = performance.now();
  const res = await runShell('node', args, workDir, {
    env,
    timeoutMs: opts.timeoutMs || TIER_TIMEOUT_MS[task.tier] || DEFAULT_TIMEOUT_MS,
  });
  const elapsedMs = Math.round(performance.now() - start);

  return {
    exitCode: res.code,
    stdout: res.stdout,
    stderr: res.stderr,
    elapsedMs,
    timedOut: res.timedOut,
  };
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

function statusIcon(result) {
  if (result.timedOut) return 'TMO';
  if (result.pass) return 'PASS';
  return 'FAIL';
}

function tierLabel(tier) {
  const labels = { 1: 'L1-Route', 2: 'L2-Single', 3: 'L3-Multi', 4: 'L4-QA' };
  return labels[tier] || `T${tier}`;
}

function printSummaryTable(results) {
  console.log('\n' + '='.repeat(80));
  console.log('BENCHMARK RESULTS');
  console.log('='.repeat(80));

  const maxName = Math.max(...results.map(r => r.name.length), 10);

  console.log(
    'Status'.padEnd(6) + ' ' +
    'Tier'.padEnd(10) + ' ' +
    'Name'.padEnd(maxName) + ' ' +
    'Time'.padEnd(8) + ' ' +
    'Failures'
  );
  console.log('-'.repeat(80));

  for (const r of results) {
    const status = statusIcon(r);
    const tier = tierLabel(r.tier);
    const time = r.timedOut ? 'timeout' : `${r.elapsedMs}ms`;
    const failures = r.failures.length > 0 ? r.failures[0] : '';
    console.log(
      status.padEnd(6) + ' ' +
      tier.padEnd(10) + ' ' +
      r.name.padEnd(maxName) + ' ' +
      time.padEnd(8) + ' ' +
      failures
    );
    // Extra failure lines
    for (const f of r.failures.slice(1)) {
      console.log(' '.repeat(6 + 1 + 10 + 1 + maxName + 1 + 8 + 1) + f);
    }
  }

  console.log('-'.repeat(80));

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass && !r.timedOut).length;
  const timedOut = results.filter(r => r.timedOut).length;
  const totalMs = results.reduce((s, r) => s + r.elapsedMs, 0);
  const avgMs = results.length ? Math.round(totalMs / results.length) : 0;

  console.log(`\nTotal: ${results.length} | Passed: ${passed} | Failed: ${failed} | Timed out: ${timedOut}`);
  console.log(`Total time: ${(totalMs / 1000).toFixed(1)}s | Average: ${(avgMs / 1000).toFixed(1)}s`);

  // Per-tier breakdown
  const tiers = [...new Set(results.map(r => r.tier))].sort();
  for (const t of tiers) {
    const tierResults = results.filter(r => r.tier === t);
    const p = tierResults.filter(r => r.pass).length;
    console.log(`  ${tierLabel(t)}: ${p}/${tierResults.length} passed`);
  }

  console.log('');
}

// ---------------------------------------------------------------------------
// Baseline comparison
// ---------------------------------------------------------------------------

function compareToBaseline(results, baseline) {
  const failures = [];

  if (!baseline.results || Object.keys(baseline.results).length === 0) {
    console.log('\nNo baseline data to compare against. Run with --update-baseline first.');
    return failures;
  }

  console.log('\n' + '='.repeat(80));
  console.log('BASELINE COMPARISON');
  console.log('='.repeat(80));

  for (const r of results) {
    const b = baseline.results[r.id];
    if (!b) {
      console.log(`  ${r.id}: NEW (no baseline entry)`);
      continue;
    }

    const passChanged = b.pass !== r.pass;
    const timeDelta = r.elapsedMs - (b.elapsedMs || 0);
    const timePct = b.elapsedMs ? Math.round((timeDelta / b.elapsedMs) * 100) : 0;

    if (passChanged && !r.pass) {
      failures.push(`${r.id}: REGRESSION (was pass, now fail)`);
      console.log(`  ${r.id}: REGRESSION pass->fail`);
    } else if (passChanged && r.pass) {
      console.log(`  ${r.id}: IMPROVEMENT fail->pass`);
    } else if (Math.abs(timePct) > 25) {
      const sign = timeDelta > 0 ? '+' : '';
      console.log(`  ${r.id}: ${sign}${timePct}% time (${b.elapsedMs}ms -> ${r.elapsedMs}ms)`);
      if (timePct > 50) {
        failures.push(`${r.id}: time regression ${sign}${timePct}%`);
      }
    } else {
      console.log(`  ${r.id}: stable`);
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Check crew-cli is built
  if (!existsSync(CREW_ENTRY)) {
    console.error(`crew-cli not built. Run 'npm run build' in ${CREW_CLI_DIR} first.`);
    console.error(`Expected: ${CREW_ENTRY}`);
    process.exit(1);
  }

  // Load tasks
  const tasksData = JSON.parse(await readFile(TASKS_FILE, 'utf8'));
  let tasks = tasksData.tasks;

  // Filter by task ID
  if (opts.taskId) {
    tasks = tasks.filter(t => t.id === opts.taskId);
    if (tasks.length === 0) {
      console.error(`Task not found: ${opts.taskId}`);
      console.error(`Available: ${tasksData.tasks.map(t => t.id).join(', ')}`);
      process.exit(1);
    }
  }

  // Filter by tier
  if (opts.tier) {
    tasks = tasks.filter(t => t.tier === opts.tier);
    if (tasks.length === 0) {
      console.error(`No tasks found for tier ${opts.tier}`);
      process.exit(1);
    }
  }

  const presetLabel = opts.preset || 'default';
  console.log(`\nCrew-CLI Benchmark Suite`);
  console.log(`Preset: ${presetLabel} | Tasks: ${tasks.length} | Timeouts: T1=${TIER_TIMEOUT_MS[1]/1000}s T2=${TIER_TIMEOUT_MS[2]/1000}s T3-4=${TIER_TIMEOUT_MS[3]/1000}s`);
  console.log('-'.repeat(60));

  // Pre-install fixture deps once into the fixture dir (shared node_modules via copy)
  if (opts.installDeps) {
    console.log('Installing fixture dependencies...');
    await installFixtureDeps(FIXTURE_DIR);
    console.log('Dependencies installed.\n');
  }

  const results = [];

  for (const task of tasks) {
    process.stdout.write(`[${tierLabel(task.tier)}] ${task.name}... `);

    let workDir = null;
    try {
      // Copy fixture to temp dir (includes node_modules from pre-install)
      workDir = await copyFixtureToTmp();

      // Run the task
      const exec = await runTask(task, workDir, opts);

      // Verify results
      let failures = [];
      if (task.verify.type === 'response-contains') {
        failures = await verifyResponseContains(exec.stdout, task.verify.patterns);
      } else if (task.verify.type === 'shell') {
        failures = await verifyShell(workDir, task.verify);
      }

      // Find changed files
      const changedFiles = await findChangedFiles(workDir);

      // Check routing decision from structured JSON envelope (--json output)
      let actualDecision = '';
      if (task.expectedDecision) {
        // Parse decision from the crew-cli JSON envelope in stdout.
        // The envelope is pretty-printed ({...}\n), so extract the full JSON object.
        try {
          const jsonStart = exec.stdout.indexOf('{');
          const jsonEnd = exec.stdout.lastIndexOf('}');
          if (jsonStart >= 0 && jsonEnd > jsonStart) {
            const obj = JSON.parse(exec.stdout.slice(jsonStart, jsonEnd + 1));
            // Envelope format: {version, kind, ts, decision, executionPath, ...}
            const d = obj?.decision || obj?.data?.decision;
            if (d) actualDecision = String(d).toLowerCase();
          }
        } catch { /* parse failed */ }
        // Fallback: extract from stderr logs if JSON envelope didn't have it
        if (!actualDecision) {
          const decisionMatch = exec.stderr.match(/L2 Decision:\s*(\S+)/);
          if (decisionMatch) {
            actualDecision = decisionMatch[1].toLowerCase().replace(/[^a-z-]/g, '');
          }
        }
        // Fallback 2: check pipeline checkpoint logs in stderr
        if (!actualDecision) {
          const phaseMatch = exec.stderr.match(/decision["\s:]+(\w[\w-]+)/i);
          if (phaseMatch) {
            actualDecision = phaseMatch[1].toLowerCase();
          }
        }
        // Validate decision against expected
        if (!actualDecision) {
          failures.push(`Expected decision "${task.expectedDecision}" but could not extract actual decision from output`);
        } else {
          const expected = task.expectedDecision.toLowerCase();
          // "execute" matches any execute-* variant; "direct-answer" matches exactly
          const matches = expected === 'execute'
            ? actualDecision.startsWith('execute')
            : expected === 'direct-answer'
              ? actualDecision === 'direct-answer'
              : actualDecision.includes(expected);
          if (!matches) {
            failures.push(`Expected decision "${task.expectedDecision}" but got "${actualDecision}"`);
          }
        }
      }

      const pass = exec.exitCode === 0 && !exec.timedOut && failures.length === 0;

      const result = {
        id: task.id,
        tier: task.tier,
        name: task.name,
        preset: presetLabel,
        pass,
        elapsedMs: exec.elapsedMs,
        timedOut: exec.timedOut,
        exitCode: exec.exitCode,
        failures,
        changedFiles,
        expectedDecision: task.expectedDecision,
        actualDecision: actualDecision || null,
        stderrTail: exec.stderr.trim().split('\n').slice(-5).join('\n'),
      };

      results.push(result);
      console.log(`${statusIcon(result)} (${exec.elapsedMs}ms)`);

      if (opts.verbose && failures.length > 0) {
        for (const f of failures) {
          console.log(`    - ${f}`);
        }
      }
      if (opts.verbose && exec.exitCode !== 0) {
        console.log(`    exit=${exec.exitCode}`);
        console.log(`    stderr: ${result.stderrTail.split('\n').join('\n    ')}`);
      }
    } catch (err) {
      results.push({
        id: task.id,
        tier: task.tier,
        name: task.name,
        preset: presetLabel,
        pass: false,
        elapsedMs: 0,
        timedOut: false,
        exitCode: -1,
        failures: [`Runner error: ${err.message}`],
        changedFiles: [],
        expectedDecision: task.expectedDecision,
        stderrTail: '',
      });
      console.log(`FAIL (runner error: ${err.message})`);
    } finally {
      const lastResult = results[results.length - 1];
      if (workDir && opts.preserveFailures && lastResult && !lastResult.pass) {
        console.log(`    preserved: ${workDir}`);
      } else if (workDir) {
        await cleanupTmpDir(workDir);
      }
    }
  }

  // Print summary
  printSummaryTable(results);

  // Save results JSON
  const outDir = join(CREW_CLI_DIR, '.crew', 'benchmarks');
  await mkdir(outDir, { recursive: true });
  const outFile = join(outDir, `results-${presetLabel}-${Date.now()}.json`);
  const report = {
    timestamp: new Date().toISOString(),
    preset: presetLabel,
    taskCount: tasks.length,
    passCount: results.filter(r => r.pass).length,
    failCount: results.filter(r => !r.pass).length,
    totalMs: results.reduce((s, r) => s + r.elapsedMs, 0),
    results,
  };
  await writeFile(outFile, JSON.stringify(report, null, 2));
  console.log(`Results saved: ${outFile}`);

  // Update baseline
  if (opts.updateBaseline) {
    const baselineData = {
      version: 1,
      createdAt: new Date().toISOString(),
      preset: presetLabel,
      results: {},
    };
    for (const r of results) {
      baselineData.results[r.id] = {
        pass: r.pass,
        elapsedMs: r.elapsedMs,
        tier: r.tier,
      };
    }
    await writeFile(BASELINE_FILE, JSON.stringify(baselineData, null, 2));
    console.log(`Baseline updated: ${BASELINE_FILE}`);
  }

  // Check against baseline
  if (opts.check) {
    let baseline;
    try {
      baseline = JSON.parse(await readFile(BASELINE_FILE, 'utf8'));
    } catch {
      console.error(`\nBaseline not found: ${BASELINE_FILE}`);
      console.error(`Run with --update-baseline first.`);
      process.exit(1);
    }

    const regressions = compareToBaseline(results, baseline);
    if (regressions.length > 0) {
      console.error('\nRegressions detected:');
      for (const r of regressions) console.error(`  - ${r}`);
      process.exit(1);
    }
    console.log('\nNo regressions detected.');
  }

  // Exit with failure if any task failed
  const exitCode = results.every(r => r.pass) ? 0 : 1;
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('Benchmark runner failed:', err);
  process.exit(1);
});
