#!/usr/bin/env node
/**
 * Provider comparison benchmark — runs the same bugfix task across
 * Claude OAuth, OpenAI OAuth, and Gemini to compare execution quality.
 *
 * Usage:
 *   node scripts/benchmark-provider-compare.mjs
 *   node scripts/benchmark-provider-compare.mjs --task "Add a modulo function to src/math.ts"
 *   node scripts/benchmark-provider-compare.mjs --providers claude,openai
 *   node scripts/benchmark-provider-compare.mjs --max-turns 10
 *
 * Requires:
 *   - Fixture project at /tmp/crew-tune-bench (git repo with src/math.ts, test/math.test.ts, package.json)
 *   - OAuth credentials for Claude (macOS Keychain) and/or OpenAI (~/.codex/auth.json)
 *   - Gemini API key in GEMINI_API_KEY env var
 *
 * Setup fixture (one-time):
 *   mkdir -p /tmp/crew-tune-bench && cd /tmp/crew-tune-bench && git init
 *   # Create src/math.ts, src/utils.ts, test/math.test.ts, package.json
 *   # See memory: project_engine_architecture.md for fixture details
 */

import { execSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const CREW_CLI = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const CREW_ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

const { runAgenticWorker, Sandbox } = await import(`${CREW_CLI}/dist/engine.mjs`);
const { scoreTaskTrajectory } = await import(`${CREW_ROOT}/lib/autoharness/index.mjs`);

const DEFAULT_TASK = 'Fix the divide function in src/math.ts to throw an error on division by zero instead of returning Infinity';
const FIXTURE_DIR = '/tmp/crew-tune-bench';

const ALL_PROVIDERS = [
  { name: 'claude-opus',   model: 'claude-opus-4-6' },
  { name: 'claude-sonnet', model: 'claude-sonnet-4-6' },
  { name: 'openai-gpt5',  model: 'gpt-5.4' },
  { name: 'gemini-flash',  model: 'gemini-2.5-flash' },
];

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    task:       { type: 'string', default: DEFAULT_TASK },
    providers:  { type: 'string', default: 'claude-opus,openai-gpt5,gemini-flash' },
    'max-turns': { type: 'string', default: '8' },
    verbose:    { type: 'boolean', default: true },
    help:       { type: 'boolean', short: 'h', default: false },
  },
  strict: false,
});

if (args.help) {
  console.log(`Usage: node scripts/benchmark-provider-compare.mjs [options]
  --task <string>       Task to run (default: bugfix divide-by-zero)
  --providers <list>    Comma-separated provider names (default: claude-opus,openai-gpt5,gemini-flash)
  --max-turns <n>       Max turns per run (default: 8)
  --verbose             Show per-turn output (default: true)
  -h, --help            Show this help

Available providers: ${ALL_PROVIDERS.map(p => p.name).join(', ')}`);
  process.exit(0);
}

const selectedNames = new Set(args.providers.split(',').map(s => s.trim()));
const providers = ALL_PROVIDERS.filter(p => selectedNames.has(p.name));
const maxTurns = parseInt(args['max-turns'], 10);
const task = args.task;

if (providers.length === 0) {
  console.error(`No matching providers. Available: ${ALL_PROVIDERS.map(p => p.name).join(', ')}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runOne(provider) {
  // Reset fixture between runs
  try { execSync('git checkout -- .', { cwd: FIXTURE_DIR, stdio: 'pipe' }); } catch {}

  // OAuth routing is model-aware — no env hacks needed
  delete process.env.CREW_NO_OAUTH;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`PROVIDER: ${provider.name} (${provider.model})`);
  console.log('='.repeat(60));

  const sandbox = new Sandbox(FIXTURE_DIR);
  const startMs = Date.now();

  try {
    const result = await runAgenticWorker(task, sandbox, {
      model: provider.model,
      maxTurns,
      verbose: args.verbose,
      projectDir: FIXTURE_DIR,
    });

    const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);

    const trajectory = scoreTaskTrajectory({
      success: result.success,
      actions: (result.history || []).map(h => ({
        tool: h.tool,
        target: h.params?.file_path || h.params?.path || h.params?.command,
        commandPrefix: h.params?.command ? String(h.params.command).split(' ')[0] : undefined,
      })),
    });

    console.log(`\nRESULT: ${result.success ? 'SUCCESS' : 'FAILED'} (${elapsedSec}s)`);
    console.log(`Provider: ${result.providerId || 'unknown'} / ${result.modelUsed || 'unknown'}`);
    console.log(`Turns: ${result.turns} | Cost: $${(result.cost || 0).toFixed(4)} | Tools: ${(result.toolsUsed || []).join(', ')}`);

    if (result.history) {
      for (const h of result.history) {
        const target = h.params?.file_path || h.params?.command || '';
        console.log(`  [T${h.turn}] ${h.tool}(${String(target).slice(0, 50)}) ${h.error ? '✗ ' + h.error.slice(0, 50) : '✓'}`);
      }
    }

    console.log(`Score: ${trajectory.trajectoryScore} | Verified: ${trajectory.hasVerification} | R/W: ${trajectory.readBeforeWriteRatio}`);
    if (result.output) console.log(`Output: ${result.output.slice(0, 200)}`);

    return {
      provider: provider.name,
      model: result.modelUsed || provider.model,
      success: result.success,
      turns: result.turns,
      score: trajectory.trajectoryScore,
      verified: trajectory.hasVerification,
      readWrite: trajectory.readBeforeWriteRatio,
      cost: result.cost || 0,
      elapsed: elapsedSec,
    };
  } catch (err) {
    const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
    console.error(`ERROR (${elapsedSec}s): ${err.message}`);
    return {
      provider: provider.name,
      model: provider.model,
      success: false,
      turns: 0,
      score: 0,
      verified: false,
      readWrite: 0,
      cost: 0,
      elapsed: elapsedSec,
      error: err.message.slice(0, 60),
    };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`Task: ${task.slice(0, 80)}...`);
console.log(`Providers: ${providers.map(p => p.name).join(', ')}`);
console.log(`Max turns: ${maxTurns}`);

const results = [];
for (const provider of providers) {
  results.push(await runOne(provider));
}

console.log(`\n\n${'='.repeat(70)}`);
console.log('PROVIDER COMPARISON');
console.log('='.repeat(70));
console.table(results.map(r => ({
  provider: r.provider,
  model: r.model,
  success: r.success,
  turns: r.turns,
  score: r.score,
  verified: r.verified,
  'r/w': r.readWrite,
  cost: `$${r.cost.toFixed(4)}`,
  time: `${r.elapsed}s`,
  error: r.error || '',
})));

// Write results to JSON for tracking
const outPath = `${CREW_CLI}/.crew/benchmarks/provider-compare-latest.json`;
try {
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(`${CREW_CLI}/.crew/benchmarks`, { recursive: true });
  await writeFile(outPath, JSON.stringify({ task, timestamp: new Date().toISOString(), results }, null, 2));
  console.log(`\nResults written to ${outPath}`);
} catch {}
