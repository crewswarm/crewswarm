#!/usr/bin/env node --import=tsx
/**
 * FULL PIPELINE TEST (Write + QA/Fixer Loop)
 *
 * Flow:
 * 1) L1 -> L2A -> L2B -> L3 generation
 * 2) Materialize response into FILE: blocks
 * 3) Parse/apply via sandbox -> write files to disk
 * 4) QA audit
 * 5) If QA fails, run fixer and re-audit (max rounds)
 * 6) Final QA sign-off required
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from 'dotenv';
import { UnifiedPipeline } from '../src/pipeline/unified.js';
import { Orchestrator } from '../src/orchestrator/index.js';
import { Sandbox } from '../src/sandbox/index.js';
import { SessionManager } from '../src/session/manager.js';
import { LocalExecutor } from '../src/executor/local.js';

function loadEnvFromCandidates() {
  const candidates = [
    process.env.CREW_ENV_FILE,
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '..', '.env'),
    path.resolve(process.cwd(), '..', '..', '.env')
  ].filter(Boolean);

  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const res = config({ path: p, override: false });
    if (!res.error) {
      console.log(`[ENV] Loaded: ${p}`);
      return p;
    }
  }
  console.log('[ENV] No .env file loaded from standard locations');
  return '';
}

loadEnvFromCandidates();

const OUTPUT_DIR = process.env.OUTPUT_DIR || path.resolve(process.cwd(), 'tmp/benchmark-vscode-grok-WRITE-QA');
const MAX_FIX_ROUNDS = 2;
const RUN_STATUS_FILE = process.env.RUN_STATUS_FILE || '/tmp/crew-pipeline-run-status.jsonl';
const REQUIRED_FILES = [
  'package.json',
  'src/extension.ts',
  'src/api-client.ts',
  'src/webview/chat.html',
  'src/webview/chat.js',
  'src/webview/styles.css',
  'src/diff-handler.ts',
  'README.md',
  'tests/extension.test.ts'
];

const TASK = `Build MVP Phase 1 VS Code extension for CrewSwarm.

Output to: ${OUTPUT_DIR}

Requirements:
1. Extension scaffold (package.json)
2. Webview chat UI with message bridge
3. API client for /v1/chat
4. Action parser, diff handler
5. Status bar, branding

Files: ${REQUIRED_FILES.join(', ')}`;

function logFatal(prefix, err) {
  const message = (err && err.message) ? err.message : String(err);
  // Mirror to stdout and stderr so tee captures it even without 2>&1.
  console.error(`\n${prefix}: ${message}`);
  console.log(`\n${prefix}: ${message}`);
}

function markPhase(phase, details = {}) {
  const entry = {
    ts: new Date().toISOString(),
    pid: process.pid,
    phase,
    ...details
  };
  try {
    fs.appendFileSync(RUN_STATUS_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Best-effort diagnostic trail.
  }
  console.log(`[PHASE] ${phase}`);
}

process.on('unhandledRejection', (reason) => {
  markPhase('fatal:unhandledRejection', { reason: String(reason) });
  logFatal('UNHANDLED_REJECTION', reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  markPhase('fatal:uncaughtException', { error: String(error) });
  logFatal('UNCAUGHT_EXCEPTION', error);
  process.exit(1);
});

process.on('SIGTERM', () => {
  markPhase('signal:SIGTERM');
  console.log('\nFAILED: received SIGTERM');
  process.exit(143);
});

process.on('SIGINT', () => {
  markPhase('signal:SIGINT');
  console.log('\nFAILED: received SIGINT');
  process.exit(130);
});

process.on('SIGHUP', () => {
  markPhase('signal:SIGHUP');
  console.log('\nFAILED: received SIGHUP');
  process.exit(129);
});

class MockRouter {
  async dispatch() { return { result: 'ok' }; }
}

async function listFilesRecursive(dir) {
  const out = [];
  async function walk(current) {
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        out.push(path.relative(dir, full));
      }
    }
  }
  await walk(dir);
  return out.sort();
}

async function buildProjectSnapshot(baseDir, maxChars = 120000) {
  if (!fs.existsSync(baseDir)) return '';
  const files = await listFilesRecursive(baseDir);
  let out = '';
  for (const rel of files) {
    const full = path.join(baseDir, rel);
    const content = await fs.promises.readFile(full, 'utf8');
    const block = `FILE: ${rel}\n${content}\n\n`;
    if ((out.length + block.length) > maxChars) break;
    out += block;
  }
  return out;
}

function extractJsonObject(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('No JSON object found in model output');
  }
  return JSON.parse(text.slice(start, end + 1));
}

async function materializeToFiles(executor, generatedOutput) {
  const prompt = `You are a code materializer.

Convert the following generated output into concrete files.

Rules:
1) Output ONLY FILE blocks in this exact format:
FILE: relative/path
<full file content>
2) No markdown fences.
3) No prose.
4) Include every required file exactly once.

Required files:
${REQUIRED_FILES.map(f => `- ${f}`).join('\n')}

Generated source material:
${generatedOutput}`;

  return executor.execute(prompt, {
    model: process.env.CREW_EXECUTION_MODEL,
    temperature: 0.2,
    maxTokens: 8000  // DeepSeek max is 8192, use 8000 to be safe
  });
}

async function qaAudit(executor, baseDir, round) {
  const snapshot = await buildProjectSnapshot(baseDir);
  const prompt = `You are crew-qa. Audit this generated project.

Return ONLY JSON:
{
  "approved": true|false,
  "summary": "short summary",
  "issues": [
    {
      "severity": "high|medium|low",
      "file": "relative/path",
      "problem": "what is wrong",
      "requiredFix": "what to change"
    }
  ]
}

Approval rules:
- approved=true only when project is runnable and coherent for MVP scope.
- Any missing required file => approved=false.
- Syntax/runtime blockers => approved=false.

Round: ${round}
Required files:
${REQUIRED_FILES.map(f => `- ${f}`).join('\n')}

Project snapshot:
${snapshot}`;

  const res = await executor.execute(prompt, {
    model: process.env.CREW_QA_MODEL || process.env.CREW_CHAT_MODEL || process.env.CREW_EXECUTION_MODEL,
    temperature: 0.1,
    maxTokens: 4000
  });
  const parsed = extractJsonObject(res.result || '{}');
  return {
    raw: res.result,
    costUsd: Number(res.costUsd || 0),
    approved: Boolean(parsed.approved),
    summary: String(parsed.summary || ''),
    issues: Array.isArray(parsed.issues) ? parsed.issues : []
  };
}

async function fixerPass(executor, baseDir, issues, round) {
  const snapshot = await buildProjectSnapshot(baseDir);
  const issuesText = JSON.stringify(issues, null, 2);
  const prompt = `You are crew-fixer. Fix only the QA issues below.

Output format rules:
1) Output ONLY FILE blocks in this exact format:
FILE: relative/path
<full file content>
2) No markdown fences.
3) No prose.
4) Only include files that must be changed to fix issues.

Round: ${round}
QA issues:
${issuesText}

Current project snapshot:
${snapshot}`;

  return executor.execute(prompt, {
    model: process.env.CREW_EXECUTION_MODEL,
    temperature: 0.2,
    maxTokens: 8000  // DeepSeek max is 8192
  });
}

async function run() {
  markPhase('run:start', { outputDir: OUTPUT_DIR });
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   FULL PIPELINE TEST (WRITE + QA/FIXER LOOP)                ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  if (fs.existsSync(OUTPUT_DIR)) {
    fs.rmSync(OUTPUT_DIR, { recursive: true });
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Core pipeline flags
  process.env.CREW_USE_UNIFIED_ROUTER = 'true';
  process.env.CREW_DUAL_L2_ENABLED = 'true';
  process.env.CREW_ALLOW_CRITICAL = process.env.CREW_ALLOW_CRITICAL || 'true';
  
  // Model selection (defaults to Grok, can override)
  process.env.CREW_CHAT_MODEL = process.env.CREW_CHAT_MODEL || 'grok-4-1-fast-reasoning';
  process.env.CREW_REASONING_MODEL = process.env.CREW_REASONING_MODEL || 'grok-4-1-fast-reasoning';
  process.env.CREW_EXECUTION_MODEL = process.env.CREW_EXECUTION_MODEL || 'grok-4-1-fast-reasoning';
  
  // Context pack optimizations (reduce token spend by 13%, time by 16%)
  process.env.CREW_CONTEXT_BUDGET_CHARS = process.env.CREW_CONTEXT_BUDGET_CHARS || '5000';
  process.env.CREW_CONTEXT_MAX_CHUNKS = process.env.CREW_CONTEXT_MAX_CHUNKS || '6';
  process.env.CREW_CONTEXT_PACK_TTL_HOURS = process.env.CREW_CONTEXT_PACK_TTL_HOURS || '24';
  
  // Disable internal UnifiedPipeline QA loop by default here.
  // This script runs its own write->QA->fixer->QA loop after materialization.
  process.env.CREW_QA_LOOP_ENABLED = process.env.CREW_QA_LOOP_ENABLED || 'false';
  process.env.CREW_QA_MAX_ROUNDS = process.env.CREW_QA_MAX_ROUNDS || '3';

  const started = Date.now();
  const pipeline = new UnifiedPipeline();
  const executor = new LocalExecutor();
  const sandbox = new Sandbox(OUTPUT_DIR);
  await sandbox.load();
  const session = new SessionManager(OUTPUT_DIR);
  await session.ensureInitialized();
  const orchestrator = new Orchestrator(new MockRouter(), sandbox, session);

  let totalExtraCost = 0;
  try {
    markPhase('pipeline:start');
    console.log('Running L1 -> L2A -> L2B -> L3 generation...\n');
    const pipelineResult = await pipeline.execute({
      userInput: TASK,
      context: 'Full pipeline with write + QA loop',
      sessionId: `full-write-qa-${Date.now()}`
    });
    markPhase('pipeline:done', { executionPath: pipelineResult.executionPath });

    console.log(`Pipeline done: ${pipelineResult.executionPath.join(' -> ')}`);
    console.log(`Pipeline cost: $${pipelineResult.totalCost.toFixed(6)}\n`);

    console.log('Materializing output into FILE blocks...');
    markPhase('materialize:start');
    const materialized = await materializeToFiles(executor, pipelineResult.response);
    totalExtraCost += Number(materialized.costUsd || 0);
    markPhase('materialize:done', { chars: String(materialized.result || '').length });

    markPhase('apply:start');
    const changed = await orchestrator.parseAndApplyToSandbox(materialized.result || '');
    await sandbox.apply();
    markPhase('apply:done', { changedFiles: changed.length });
    console.log(`Wrote ${changed.length} file(s) to disk.\n`);

    let approved = false;
    let qaResult = null;
    for (let round = 1; round <= (MAX_FIX_ROUNDS + 1); round++) {
      markPhase('qa:start', { round });
      qaResult = await qaAudit(executor, OUTPUT_DIR, round);
      totalExtraCost += qaResult.costUsd;
      markPhase('qa:done', { round, approved: qaResult.approved, issues: qaResult.issues.length });
      console.log(`QA round ${round}: approved=${qaResult.approved} issues=${qaResult.issues.length}`);

      if (qaResult.approved) {
        approved = true;
        break;
      }
      if (round > MAX_FIX_ROUNDS) break;

      console.log(`Running fixer round ${round}...`);
      markPhase('fixer:start', { round });
      const fix = await fixerPass(executor, OUTPUT_DIR, qaResult.issues, round);
      totalExtraCost += Number(fix.costUsd || 0);
      const fixed = await orchestrator.parseAndApplyToSandbox(fix.result || '');
      await sandbox.apply();
      markPhase('fixer:done', { round, changedFiles: fixed.length });
      console.log(`Fixer updated ${fixed.length} file(s).`);
    }

    const totalMs = Date.now() - started;
    const totalCost = Number(pipelineResult.totalCost || 0) + totalExtraCost;
    const files = await listFilesRecursive(OUTPUT_DIR);

    console.log('\n══════════════════════════════════════════════════════════════');
    console.log('FINAL SUMMARY');
    console.log('══════════════════════════════════════════════════════════════');
    console.log(`Output dir: ${OUTPUT_DIR}`);
    console.log(`Total time: ${(totalMs / 1000).toFixed(1)}s`);
    console.log(`Total cost: $${totalCost.toFixed(6)} (pipeline + materialize + qa/fixer)`);
    console.log(`Files written: ${files.length}`);
    console.log(`Final QA approval: ${approved ? 'YES' : 'NO'}`);
    if (qaResult) {
      console.log(`Final QA summary: ${qaResult.summary || '(none)'}`);
      if (!approved) {
        console.log(`Remaining issues: ${qaResult.issues.length}`);
      }
    }

    if (!approved) {
      markPhase('run:completed-with-qa-fail');
      process.exitCode = 2;
    } else {
      markPhase('run:success');
    }
  } catch (err) {
    markPhase('run:failed', { error: (err && err.message) ? err.message : String(err) });
    logFatal('FAILED', err);
    process.exit(1);
  }
}

run();
