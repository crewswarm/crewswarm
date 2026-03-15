#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { lookup } from 'node:dns/promises';
import { config as loadDotenv } from 'dotenv';

const PRESETS = ['turbo6', 'fast6', 'balanced', 'quality'];
const DEFAULT_TASKS = [
  'Create src/hello.ts with a typed greet(name) function and unit test.',
  'Refactor a small auth helper to add input validation and tests.'
];

function parseArgs(argv) {
  const out = {
    tasks: [],
    check: false,
    updateBaseline: false,
    baseline: 'benchmarks/presets-baseline.json',
    tasksFile: '',
    out: '.crew/benchmarks/presets-latest.json',
    maxRegressionPct: Number(process.env.CREW_BENCH_MAX_REGRESSION_PCT || 25),
    minPassRate: Number(process.env.CREW_BENCH_MIN_PASS_RATE || 0.5),
    skipIfUnavailable: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '').trim();
    if (!arg) continue;
    if (arg === '--check') { out.check = true; continue; }
    if (arg === '--update-baseline') { out.updateBaseline = true; continue; }
    if (arg === '--baseline' && argv[i + 1]) { out.baseline = String(argv[++i]); continue; }
    if (arg === '--tasks-file' && argv[i + 1]) { out.tasksFile = String(argv[++i]); continue; }
    if (arg === '--out' && argv[i + 1]) { out.out = String(argv[++i]); continue; }
    if (arg === '--max-regression-pct' && argv[i + 1]) { out.maxRegressionPct = Number(argv[++i]); continue; }
    if (arg === '--min-pass-rate' && argv[i + 1]) { out.minPassRate = Number(argv[++i]); continue; }
    if (arg === '--skip-if-unavailable') { out.skipIfUnavailable = true; continue; }
    out.tasks.push(arg);
  }

  if (!Number.isFinite(out.maxRegressionPct) || out.maxRegressionPct < 0) out.maxRegressionPct = 25;
  if (!Number.isFinite(out.minPassRate) || out.minPassRate < 0 || out.minPassRate > 1) out.minPassRate = 0.5;
  return out;
}

function runCommand(cmd, args, cwd) {
  return new Promise((resolve) => {
    const start = performance.now();
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('close', (code) => {
      const ms = performance.now() - start;
      resolve({ code: Number(code || 0), stdout, stderr, ms });
    });
  });
}

function summarize(results) {
  const summary = {};
  for (const preset of PRESETS) {
    const rows = results.filter(r => r.preset === preset);
    const avgMs = rows.length ? Math.round(rows.reduce((s, r) => s + r.ms, 0) / rows.length) : 0;
    const passCount = rows.filter(r => r.ok).length;
    const failCount = rows.length - passCount;
    const passRate = rows.length ? Number((passCount / rows.length).toFixed(3)) : 0;
    summary[preset] = {
      avgMs,
      passCount,
      failCount,
      total: rows.length,
      passRate
    };
  }
  return summary;
}

async function loadJson(path) {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw);
}

async function saveJson(path, data) {
  const abs = resolve(path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, JSON.stringify(data, null, 2), 'utf8');
}

function evaluateRegression(currentSummary, baselineSummary, { maxRegressionPct, minPassRate }) {
  const failures = [];
  for (const preset of PRESETS) {
    const cur = currentSummary[preset];
    const base = baselineSummary?.[preset];
    if (!cur || !base) {
      failures.push(`${preset}: missing baseline or current summary`);
      continue;
    }

    if (Number(cur.total || 0) > 0 && Number(cur.passCount || 0) === 0) {
      failures.push(`${preset}: no successful runs (${cur.failCount}/${cur.total} failed)`);
      continue;
    }

    const allowedAvg = Math.round(Number(base.avgMs || 0) * (1 + (maxRegressionPct / 100)));
    if (allowedAvg > 0 && Number(cur.avgMs || 0) > allowedAvg) {
      failures.push(`${preset}: avg latency regression ${cur.avgMs}ms > allowed ${allowedAvg}ms (baseline ${base.avgMs}ms, +${maxRegressionPct}%)`);
    }

    const baselinePassRate = Number(base.passRate || 0);
    const requiredPassRate = Math.max(Number(minPassRate || 0), baselinePassRate);
    if (Number(cur.passRate || 0) < requiredPassRate) {
      failures.push(`${preset}: pass-rate regression ${cur.passRate} < required ${requiredPassRate}`);
    }
  }
  return failures;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  loadDotenv({ path: resolve(cwd, '.env'), override: false });
  loadDotenv({ path: resolve(cwd, '..', '.env'), override: false });
  await loadProviderEnvFallback();
  const preflight = await runAvailabilityPreflight();

  if (!preflight.available) {
    const report = {
      ts: new Date().toISOString(),
      cwd,
      presets: PRESETS,
      tasks: [],
      config: {
        maxRegressionPct: parsed.maxRegressionPct,
        minPassRate: parsed.minPassRate,
        skipIfUnavailable: parsed.skipIfUnavailable
      },
      skipped: true,
      skipReason: preflight.reason,
      preflight,
      summary: {},
      results: []
    };
    await saveJson(parsed.out, report);
    process.stdout.write(`\nBenchmark skipped: ${preflight.reason}\n`);
    process.stdout.write(`Saved report: ${resolve(parsed.out)}\n`);
    if (parsed.skipIfUnavailable) process.exit(0);
    process.exit(1);
  }

  let runTasks = parsed.tasks.length > 0 ? parsed.tasks : DEFAULT_TASKS;
  if (parsed.tasksFile) {
    const content = await loadJson(resolve(parsed.tasksFile));
    const fileTasks = Array.isArray(content?.tasks) ? content.tasks.map((t) => String(t)).filter(Boolean) : [];
    if (fileTasks.length > 0) runTasks = fileTasks;
  }

  const results = [];
  for (const preset of PRESETS) {
    for (const task of runTasks) {
      const args = ['--import', 'tsx', 'src/cli/index.ts', 'run', '-t', task, '--json', '--preset', preset];
      const res = await runCommand('node', args, cwd);
      const stderrPreview = String(res.stderr || '').trim().split('\n').filter(Boolean).slice(-4).join('\n');
      results.push({
        preset,
        task,
        ms: Math.round(res.ms),
        code: res.code,
        ok: res.code === 0,
        stderrPreview
      });
      process.stdout.write(`${preset.padEnd(8)} ${res.code === 0 ? 'ok ' : 'ERR'} ${Math.round(res.ms)}ms  ${task.slice(0, 70)}\n`);
      if (res.code !== 0 && stderrPreview) {
        process.stdout.write(`          ${stderrPreview.replace(/\n/g, '\n          ')}\n`);
      }
    }
  }

  const summary = summarize(results);
  const report = {
    ts: new Date().toISOString(),
    cwd,
    presets: PRESETS,
    tasks: runTasks,
    config: {
      maxRegressionPct: parsed.maxRegressionPct,
      minPassRate: parsed.minPassRate
    },
    summary,
    results
  };

  await saveJson(parsed.out, report);
  process.stdout.write(`\nSaved report: ${resolve(parsed.out)}\n`);

  process.stdout.write('\nSummary (avg ms):\n');
  for (const preset of PRESETS) {
    const s = summary[preset];
    process.stdout.write(`- ${preset}: ${s.avgMs}ms avg, ${s.passCount}/${s.total} passed (${s.passRate})\n`);
  }

  if (parsed.updateBaseline) {
    const baselinePayload = {
      updatedAt: new Date().toISOString(),
      sourceReport: resolve(parsed.out),
      summary
    };
    await saveJson(parsed.baseline, baselinePayload);
    process.stdout.write(`\nUpdated baseline: ${resolve(parsed.baseline)}\n`);
  }

  if (parsed.check) {
    let baseline;
    try {
      baseline = await loadJson(resolve(parsed.baseline));
    } catch (err) {
      process.stderr.write(`\nBenchmark check failed: baseline not found at ${resolve(parsed.baseline)}\n`);
      process.stderr.write(`Create it with: node scripts/benchmark-presets.mjs --update-baseline\n`);
      process.exit(1);
    }

    const failures = evaluateRegression(summary, baseline.summary || {}, {
      maxRegressionPct: parsed.maxRegressionPct,
      minPassRate: parsed.minPassRate
    });
    if (failures.length > 0) {
      process.stderr.write('\nBenchmark regression check failed:\n');
      for (const f of failures) process.stderr.write(`- ${f}\n`);
      process.exit(1);
    }
    process.stdout.write('\nBenchmark regression check passed.\n');
  }
}

async function loadProviderEnvFallback() {
  const needsAny = !process.env.XAI_API_KEY && !process.env.GEMINI_API_KEY && !process.env.DEEPSEEK_API_KEY;
  if (!needsAny) return;
  try {
    const cfgPath = join(homedir(), '.crewswarm', 'crewswarm.json');
    const raw = await readFile(cfgPath, 'utf8');
    const cfg = JSON.parse(raw);
    const providers = cfg?.providers || {};
    if (!process.env.XAI_API_KEY && providers?.xai?.apiKey) process.env.XAI_API_KEY = String(providers.xai.apiKey);
    if (!process.env.GEMINI_API_KEY && providers?.google?.apiKey) process.env.GEMINI_API_KEY = String(providers.google.apiKey);
    if (!process.env.GEMINI_API_KEY && providers?.gemini?.apiKey) process.env.GEMINI_API_KEY = String(providers.gemini.apiKey);
    if (!process.env.DEEPSEEK_API_KEY && providers?.deepseek?.apiKey) process.env.DEEPSEEK_API_KEY = String(providers.deepseek.apiKey);
  } catch {
    // optional fallback only
  }
}

function getProviderSignal() {
  const has = {
    openai: Boolean(process.env.OPENAI_API_KEY),
    gemini: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
    xai: Boolean(process.env.XAI_API_KEY),
    deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY)
  };
  const any = Object.values(has).some(Boolean);
  return { has, any };
}

async function checkAnyDns(hosts) {
  for (const host of hosts) {
    try {
      await lookup(host);
      return { ok: true, host };
    } catch {
      // try next
    }
  }
  return { ok: false, host: '' };
}

async function runAvailabilityPreflight() {
  const provider = getProviderSignal();
  if (!provider.any) {
    return {
      available: false,
      reason: 'No provider API keys found (set at least one of OPENAI/GEMINI/GOOGLE/XAI/DEEPSEEK/ANTHROPIC).',
      provider
    };
  }

  const hosts = [];
  if (provider.has.openai) hosts.push('api.openai.com');
  if (provider.has.gemini) hosts.push('generativelanguage.googleapis.com');
  if (provider.has.xai) hosts.push('api.x.ai');
  if (provider.has.deepseek) hosts.push('api.deepseek.com');
  if (provider.has.anthropic) hosts.push('api.anthropic.com');
  if (hosts.length === 0) hosts.push('api.openai.com');

  const dns = await checkAnyDns(hosts);
  if (!dns.ok) {
    return {
      available: false,
      reason: `Network/DNS unavailable for provider hosts: ${hosts.join(', ')}`,
      provider,
      dns
    };
  }

  return {
    available: true,
    reason: '',
    provider,
    dns
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
