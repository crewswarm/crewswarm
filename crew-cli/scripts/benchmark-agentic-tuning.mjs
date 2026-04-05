#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const DEFAULT_CANDIDATES = [
  {
    name: 'baseline',
    actionRankingThreshold: 0.4,
    verificationGateTurns: 3,
    verificationRetryCycles: 2,
    repeatThreshold: 10,
    failureRepeatCount: 2,
    churnCommandWeight: 0.12,
    churnTargetWeight: 0.08,
  },
  {
    name: 'strict-verify',
    actionRankingThreshold: 0.35,
    verificationGateTurns: 4,
    verificationRetryCycles: 3,
    repeatThreshold: 10,
    failureRepeatCount: 2,
    churnCommandWeight: 0.12,
    churnTargetWeight: 0.08,
  },
  {
    name: 'lighter-gate',
    actionRankingThreshold: 0.45,
    verificationGateTurns: 2,
    verificationRetryCycles: 1,
    repeatThreshold: 8,
    failureRepeatCount: 2,
    churnCommandWeight: 0.12,
    churnTargetWeight: 0.08,
  },
  {
    name: 'higher-repeat-tolerance',
    actionRankingThreshold: 0.4,
    verificationGateTurns: 3,
    verificationRetryCycles: 2,
    repeatThreshold: 12,
    failureRepeatCount: 3,
    churnCommandWeight: 0.1,
    churnTargetWeight: 0.06,
  },
];

function parseArgs(argv) {
  const out = {
    tasksFile: 'benchmarks/presets-corpus.json',
    timeoutMs: 120000,
    limit: 0,
    dryRun: false,
    keepWorktree: false,
    candidateFile: '',
    out: '.crew/benchmarks/agentic-tuning-latest.json',
    benchmarkScript: 'scripts/benchmark-presets.mjs',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tasks-file' && argv[i + 1]) out.tasksFile = String(argv[++i]);
    else if (arg === '--timeout-ms' && argv[i + 1]) out.timeoutMs = Number(argv[++i]) || out.timeoutMs;
    else if (arg === '--limit' && argv[i + 1]) out.limit = Number(argv[++i]) || 0;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--keep-worktree') out.keepWorktree = true;
    else if (arg === '--candidate-file' && argv[i + 1]) out.candidateFile = String(argv[++i]);
    else if (arg === '--out' && argv[i + 1]) out.out = String(argv[++i]);
    else if (arg === '--benchmark-script' && argv[i + 1]) out.benchmarkScript = String(argv[++i]);
  }

  return out;
}

function run(cmd, args, cwd, env = {}, timeoutMs = 0) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, timeoutMs)
      : null;
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: Number(code ?? -1), stdout, stderr, timedOut });
    });
  });
}

async function fileExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function loadCandidates(candidateFile) {
  if (!candidateFile) return DEFAULT_CANDIDATES;
  return JSON.parse(await fs.readFile(candidateFile, 'utf8'));
}

async function createTempWorktree(repoRoot) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewswarm-agentic-tuning-'));
  const result = await run('git', ['worktree', 'add', '--detach', tempDir, 'HEAD'], repoRoot, {}, 120000);
  if (result.code !== 0) {
    await fs.cp(repoRoot, tempDir, {
      recursive: true,
      filter: (source) => {
        const rel = path.relative(repoRoot, source);
        if (!rel) return true;
        if (rel === '.git') return false;
        if (rel.startsWith('.git/')) return false;
        if (rel === 'crew-cli/node_modules') return false;
        if (rel.startsWith('crew-cli/node_modules/')) return false;
        return true;
      },
    });
  }
  const sourceNodeModules = path.join(repoRoot, 'crew-cli', 'node_modules');
  const targetNodeModules = path.join(tempDir, 'crew-cli', 'node_modules');
  if (!(await fileExists(targetNodeModules))) {
    await fs.symlink(sourceNodeModules, targetNodeModules, 'dir');
  }
  return {
    path: tempDir,
    mode: result.code === 0 ? 'worktree' : 'copy',
  };
}

async function removeTempWorktree(repoRoot, tempInfo) {
  if (tempInfo.mode === 'worktree') {
    await run('git', ['worktree', 'remove', '--force', tempInfo.path], repoRoot, {}, 120000);
    return;
  }
  await fs.rm(tempInfo.path, { recursive: true, force: true });
}

async function replaceInFile(file, replacer) {
  const original = await fs.readFile(file, 'utf8');
  const next = replacer(original);
  if (next === original) {
    return false;
  }
  await fs.writeFile(file, next, 'utf8');
  return true;
}

function replaceModeWeights(source, candidate) {
  return source
    .replace('read: 0.3, search: 0.3, edit: 0.2, test: 0.8, build: 0.3, verify: 0.7, delegate: 0.1', `read: 0.3, search: 0.3, edit: 0.2, test: ${candidate.bugfixTestWeight ?? 0.8}, build: 0.3, verify: ${candidate.bugfixVerifyWeight ?? 0.7}, delegate: 0.1`)
    .replace('read: 0.5, search: 0.3, edit: 0.4, test: 0.6, build: 0.4, verify: 0.5, delegate: 0.2', `read: 0.5, search: 0.3, edit: 0.4, test: ${candidate.featureTestWeight ?? 0.6}, build: 0.4, verify: ${candidate.featureVerifyWeight ?? 0.5}, delegate: 0.2`)
    .replace('read: 0.4, search: 0.2, edit: 0.3, test: 0.5, build: 0.7, verify: 0.6, delegate: 0.1', `read: 0.4, search: 0.2, edit: 0.3, test: 0.5, build: ${candidate.refactorBuildWeight ?? 0.7}, verify: 0.6, delegate: 0.1`)
    .replace('read: 0.4, search: 0.2, edit: 0.3, test: 0.9, build: 0.2, verify: 0.4, delegate: 0.1', `read: 0.4, search: 0.2, edit: 0.3, test: ${candidate.testRepairTestWeight ?? 0.9}, build: 0.2, verify: 0.4, delegate: 0.1`)
    .replace('read: 0.7, search: 0.6, edit: 0.1, test: 0.2, build: 0.1, verify: 0.2, delegate: 0.3', `read: ${candidate.analysisReadWeight ?? 0.7}, search: ${candidate.analysisSearchWeight ?? 0.6}, edit: 0.1, test: 0.2, build: 0.1, verify: 0.2, delegate: 0.3`)
    .replace('threshold = 0.4', `threshold = ${candidate.actionRankingThreshold}`);
}

function replaceRunEngineConstants(source, candidate) {
  return source
    .replace(/const DEFAULT_REPEAT_THRESHOLD = \d+;/, `const DEFAULT_REPEAT_THRESHOLD = ${candidate.repeatThreshold};`)
    .replace(/const DEFAULT_MAX_VERIFICATION_CYCLES = \d+;/, `const DEFAULT_MAX_VERIFICATION_CYCLES = ${candidate.verificationRetryCycles};`)
    .replace(/const DEFAULT_MAX_VERIFICATION_GATE_TURNS = \d+;/, `const DEFAULT_MAX_VERIFICATION_GATE_TURNS = ${candidate.verificationGateTurns};`);
}

function replaceRunStateConstants(source, candidate) {
  return source
    .replace(/if \(record && record\.count >= \d+\) return record;/, `if (record && record.count >= ${candidate.failureRepeatCount}) return record;`)
    .replace(/const repeated = this\._failures\.filter\(f => f\.count >= \d+\);/, `const repeated = this._failures.filter(f => f.count >= ${candidate.failureRepeatCount});`);
}

function replaceHarnessWeights(source, candidate) {
  return source.replace(
    /const churnPenalty = clamp01\(\(repeatedCommandPrefixes \* [0-9.]+\) \+ \(repeatedTargets \* [0-9.]+\)\);/,
    `const churnPenalty = clamp01((repeatedCommandPrefixes * ${candidate.churnCommandWeight}) + (repeatedTargets * ${candidate.churnTargetWeight}));`
  );
}

async function patchCandidate(repoRoot, candidate) {
  await replaceInFile(
    path.join(repoRoot, 'crew-cli', 'src', 'execution', 'action-ranking.ts'),
    (source) => replaceModeWeights(source, candidate)
  );
  await replaceInFile(
    path.join(repoRoot, 'crew-cli', 'src', 'engine', 'run-engine.ts'),
    (source) => replaceRunEngineConstants(source, candidate)
  );
  await replaceInFile(
    path.join(repoRoot, 'crew-cli', 'src', 'engine', 'run-state.ts'),
    (source) => replaceRunStateConstants(source, candidate)
  );
  await replaceInFile(
    path.join(repoRoot, 'lib', 'autoharness', 'index.mjs'),
    (source) => replaceHarnessWeights(source, candidate)
  );
}

async function loadJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function loadTaskMetrics(traceRoot) {
  const tasks = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith('.tasks.jsonl')) {
        const raw = await fs.readFile(full, 'utf8');
        for (const line of raw.split('\n').filter(Boolean)) {
          try {
            const row = JSON.parse(line);
            if (row?.metrics) tasks.push(row.metrics);
          } catch {}
        }
      }
    }
  }
  if (await fileExists(traceRoot)) await walk(traceRoot);
  return tasks;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length : 0;
}

function computeComposite(candidateResult, bestLatency) {
  const passRate = average(Object.values(candidateResult.summary || {}).map((item) => item.passRate || 0));
  const avgLatency = average(Object.values(candidateResult.summary || {}).map((item) => item.avgMs || 0));
  const avgTrajectory = candidateResult.taskStats.avgTrajectoryScore || 0;
  const verificationRate = candidateResult.taskStats.verificationRate || 0;
  const latencyScore = bestLatency > 0 && avgLatency > 0 ? Math.min(1, bestLatency / avgLatency) : 0;
  return Number(((passRate * 0.45) + (avgTrajectory * 0.35) + (verificationRate * 0.1) + (latencyScore * 0.1)).toFixed(3));
}

async function runCandidate(tempRoot, repoRoot, candidate, args) {
  const stateDir = path.join(tempRoot, '.tuning-state', candidate.name);
  await fs.mkdir(stateDir, { recursive: true });

  await patchCandidate(tempRoot, candidate);

  if (args.dryRun) {
    return {
      candidate,
      skipped: true,
      dryRun: true,
      summary: {},
      taskStats: { tasks: 0, avgTrajectoryScore: 0, verificationRate: 0, avgReadBeforeWriteRatio: 0 },
    };
  }

  const build = await run('npm', ['run', 'build'], path.join(tempRoot, 'crew-cli'), {}, args.timeoutMs);
  if (build.code !== 0) {
    return {
      candidate,
      failed: true,
      stage: 'build',
      stdout: build.stdout,
      stderr: build.stderr,
      summary: {},
      taskStats: { tasks: 0, avgTrajectoryScore: 0, verificationRate: 0, avgReadBeforeWriteRatio: 0 },
    };
  }

  const reportFile = path.join(stateDir, 'benchmark-report.json');
  const benchmark = await run(
    'node',
    [args.benchmarkScript, '--tasks-file', path.resolve(repoRoot, 'crew-cli', args.tasksFile), '--out', reportFile, '--skip-if-unavailable'],
    path.join(tempRoot, 'crew-cli'),
    {
      CREWSWARM_STATE_DIR: stateDir,
      CREWSWARM_DISABLE_AUTOHARNESS: '',
    },
    args.timeoutMs
  );

  const report = await loadJson(reportFile);
  const taskMetrics = await loadTaskMetrics(path.join(stateDir, 'autoharness', 'traces'));
  const taskStats = {
    tasks: taskMetrics.length,
    avgTrajectoryScore: Number(average(taskMetrics.map((item) => item.trajectoryScore || 0)).toFixed(3)),
    verificationRate: taskMetrics.length ? Number((taskMetrics.filter((item) => item.hasVerification).length / taskMetrics.length).toFixed(3)) : 0,
    avgReadBeforeWriteRatio: Number(average(taskMetrics.map((item) => item.readBeforeWriteRatio || 0)).toFixed(3)),
  };

  return {
    candidate,
    skipped: Boolean(report.skipped),
    failed: benchmark.code !== 0 && !report.skipped,
    stdout: benchmark.stdout,
    stderr: benchmark.stderr,
    summary: report.summary || {},
    taskStats,
  };
}

async function saveJson(file, data) {
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await fs.writeFile(path.resolve(file), JSON.stringify(data, null, 2), 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(process.cwd(), '..');
  const candidates = await loadCandidates(args.candidateFile);
  const selected = args.limit > 0 ? candidates.slice(0, args.limit) : candidates;

  if (args.dryRun) {
    const report = {
      ts: new Date().toISOString(),
      tasksFile: args.tasksFile,
      dryRun: true,
      candidates: selected.map((candidate) => ({
        candidate,
        skipped: true,
        dryRun: true,
        compositeScore: 0,
        summary: {},
        taskStats: {
          tasks: 0,
          avgTrajectoryScore: 0,
          verificationRate: 0,
          avgReadBeforeWriteRatio: 0,
        },
      })),
    };
    await saveJson(path.resolve(repoRoot, 'crew-cli', args.out), report);
    console.log(`Saved tuning report: ${path.resolve(repoRoot, 'crew-cli', args.out)}`);
    for (const item of report.candidates) {
      console.log(`- ${item.candidate.name}: dry-run`);
    }
    return;
  }

  const results = [];
  for (const candidate of selected) {
    const tempInfo = await createTempWorktree(repoRoot);
    try {
      const result = await runCandidate(tempInfo.path, repoRoot, candidate, args);
      results.push(result);
    } finally {
      if (!args.keepWorktree) {
        await removeTempWorktree(repoRoot, tempInfo);
      }
    }
  }

  const bestLatency = Math.min(
    ...results
      .map((result) => average(Object.values(result.summary || {}).map((item) => item.avgMs || 0)))
      .filter((value) => Number.isFinite(value) && value > 0),
    Infinity
  );

  const ranked = results.map((result) => ({
    ...result,
    compositeScore: computeComposite(result, Number.isFinite(bestLatency) ? bestLatency : 0),
  })).sort((a, b) => b.compositeScore - a.compositeScore);

  const report = {
    ts: new Date().toISOString(),
    tasksFile: args.tasksFile,
    dryRun: args.dryRun,
    candidates: ranked,
  };

  await saveJson(path.resolve(repoRoot, 'crew-cli', args.out), report);

  console.log(`Saved tuning report: ${path.resolve(repoRoot, 'crew-cli', args.out)}`);
  for (const item of ranked) {
    console.log(`- ${item.candidate.name}: composite=${item.compositeScore} trajectory=${item.taskStats.avgTrajectoryScore} verification=${item.taskStats.verificationRate} skipped=${Boolean(item.skipped)}`);
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
