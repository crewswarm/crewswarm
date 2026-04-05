#!/usr/bin/env node
/**
 * benchmark-l2-planner.mjs — L2 planner quality benchmark
 *
 * Tests whether the planner produces correct work graphs for complex tasks.
 * Uses CREW_FORCE_L2=true to get the plan without executing L3 workers.
 *
 * Scores:
 *   - Does it decompose into reasonable units?
 *   - Are dependencies correct (tests depend on implementation)?
 *   - Are personas appropriate (backend → crew-coder-back, tests → crew-qa)?
 *   - Does it include acceptance criteria?
 *   - Is the scope estimate reasonable?
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Tasks — complex enough to need planning
// ---------------------------------------------------------------------------

const TASKS = [
  {
    id: 'rest-api',
    description: 'Build a REST API with Express that has: 1) GET /users endpoint returning a list of users, 2) POST /users endpoint to create a user with name and email validation, 3) Unit tests for both endpoints, 4) A README.md documenting the API.',
    expectUnits: { min: 3, max: 6 },
    expectPersonas: ['crew-coder', 'crew-coder-back', 'crew-qa', 'crew-copywriter'],
    expectDependencies: true, // tests should depend on implementation
    expectFiles: ['src/', 'test/', 'README.md'],
    difficulty: 'medium'
  },
  {
    id: 'refactor-split',
    description: 'Refactor src/utils.ts by splitting it into three modules: src/string-utils.ts (slugify, truncate), src/number-utils.ts (clamp, round), and src/index.ts that re-exports everything. Update all imports in test/utils.test.ts. All existing tests must still pass.',
    expectUnits: { min: 2, max: 5 },
    expectPersonas: ['crew-coder', 'crew-qa'],
    expectDependencies: true,
    expectFiles: ['src/string-utils.ts', 'src/number-utils.ts', 'src/index.ts', 'test/'],
    difficulty: 'medium'
  },
  {
    id: 'full-feature',
    description: 'Add a user authentication system: 1) Create src/auth.ts with login(email, password) and register(email, password) functions using bcrypt for password hashing, 2) Create src/middleware.ts with an auth middleware that checks JWT tokens, 3) Add tests for auth functions and middleware, 4) Update README.md with auth documentation, 5) Add a security review checklist.',
    expectUnits: { min: 4, max: 8 },
    expectPersonas: ['crew-coder-back', 'crew-security', 'crew-qa', 'crew-copywriter'],
    expectDependencies: true,
    expectFiles: ['src/auth.ts', 'src/middleware.ts', 'test/', 'README.md'],
    difficulty: 'hard'
  }
];

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function scorePlan(task, plan) {
  const scores = {};
  let total = 0;
  let maxTotal = 0;

  // 1. Has work graph with units? (20 pts)
  maxTotal += 20;
  const units = plan.workGraph?.units || [];
  if (units.length >= task.expectUnits.min && units.length <= task.expectUnits.max) {
    scores.unitCount = 20;
    total += 20;
  } else if (units.length > 0) {
    scores.unitCount = 10;
    total += 10;
  } else {
    scores.unitCount = 0;
  }

  // 2. Appropriate personas? (20 pts)
  maxTotal += 20;
  const usedPersonas = new Set(units.map(u => u.requiredPersona || u.persona || ''));
  const expectedHits = task.expectPersonas.filter(p =>
    [...usedPersonas].some(up => up.includes(p.replace('crew-', '')) || p.includes(up.replace('crew-', '')))
  );
  const personaScore = Math.round((expectedHits.length / Math.max(task.expectPersonas.length, 1)) * 20);
  scores.personas = personaScore;
  total += personaScore;

  // 3. Dependencies make sense? (20 pts)
  maxTotal += 20;
  if (task.expectDependencies) {
    const hasDeps = units.some(u => Array.isArray(u.dependencies) && u.dependencies.length > 0);
    // Check: test units depend on implementation units
    const testUnits = units.filter(u =>
      (u.requiredPersona || u.persona || '').includes('qa') ||
      (u.description || u.goal || '').toLowerCase().includes('test')
    );
    const implUnits = units.filter(u =>
      !(u.requiredPersona || u.persona || '').includes('qa') &&
      !(u.description || u.goal || '').toLowerCase().match(/^(write |create )?(test|spec)/)
    );
    const testsDependOnImpl = testUnits.some(t =>
      (t.dependencies || []).some(dep => implUnits.some(i => i.id === dep))
    );
    if (testsDependOnImpl) {
      scores.dependencies = 20;
      total += 20;
    } else if (hasDeps) {
      scores.dependencies = 10;
      total += 10;
    } else {
      scores.dependencies = 0;
    }
  } else {
    scores.dependencies = 20;
    total += 20;
  }

  // 4. Mentions expected files/paths? (20 pts)
  maxTotal += 20;
  const allText = JSON.stringify(plan).toLowerCase();
  const fileHits = task.expectFiles.filter(f => allText.includes(f.toLowerCase().replace('/', '')));
  const fileScore = Math.round((fileHits.length / Math.max(task.expectFiles.length, 1)) * 20);
  scores.files = fileScore;
  total += fileScore;

  // 5. Has acceptance criteria? (10 pts)
  maxTotal += 10;
  const hasAC = plan.workGraph?.acceptanceCriteria?.length > 0 ||
    plan.workGraph?.planningArtifacts?.acceptanceCriteria?.length > 0;
  scores.acceptanceCriteria = hasAC ? 10 : 0;
  total += scores.acceptanceCriteria;

  // 6. Reasonable complexity estimate? (10 pts)
  maxTotal += 10;
  const complexity = plan.workGraph?.totalComplexity;
  if (typeof complexity === 'number' && complexity > 0) {
    scores.complexity = 10;
    total += 10;
  } else {
    scores.complexity = 0;
  }

  return { scores, total, maxTotal, unitCount: units.length, personas: [...usedPersonas] };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runTask(task) {
  const dir = await mkdtemp(join(tmpdir(), `crew-l2-bench-${task.id}-`));

  // Seed fixture for refactor task
  if (task.id === 'refactor-split') {
    await mkdir(join(dir, 'src'), { recursive: true });
    await mkdir(join(dir, 'test'), { recursive: true });
    await writeFile(join(dir, 'src', 'utils.ts'),
      'export function slugify(t: string) { return t.toLowerCase().replace(/[^a-z0-9]+/g, "-"); }\n' +
      'export function truncate(s: string, n: number) { return s.length <= n ? s : s.slice(0, n) + "..."; }\n' +
      'export function clamp(v: number, min: number, max: number) { return Math.min(Math.max(v, min), max); }\n' +
      'export function round(v: number, d: number) { const f = 10 ** d; return Math.round(v * f) / f; }\n'
    );
    await writeFile(join(dir, 'test', 'utils.test.ts'),
      'import { slugify, truncate, clamp, round } from "../src/utils.ts";\n' +
      'console.log(slugify("Hello World") === "hello-world" ? "PASS" : "FAIL");\n'
    );
  }

  // Seed package.json
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'bench-l2', version: '1.0.0', type: 'module',
    scripts: { test: 'echo "no tests yet"', build: 'echo "ok"' }
  }, null, 2));

  try { execSync('git init && git add -A && git commit -m init', { cwd: dir, stdio: 'pipe' }); } catch {}

  const crewCli = resolve(process.cwd(), 'dist', 'crew.mjs');
  const start = Date.now();

  try {
    let result = '';
    try {
      result = execSync(
        `node ${crewCli} run -t ${JSON.stringify(task.description)} --json 2>&1`,
        {
          cwd: dir,
          stdio: 'pipe',
          encoding: 'utf8',
          timeout: 180000,
          env: {
            ...process.env,
            CREW_FORCE_L2: 'true',
            CREW_DUAL_L2_ENABLED: 'true'
          }
        }
      );
    } catch (execErr) {
      // Command may exit non-zero but still produce output
      result = String(execErr.stdout || '') + String(execErr.stderr || '');
    }
    const elapsed = Date.now() - start;

    // Parse the JSON output to find the plan
    // The pipeline writes logs to cwd/.crew/ (which may be the crew-cli dir, not the temp dir)
    // Also check the JSON output directly for the work graph
    let plan = null;

    // Method 1: Parse JSON lines from stdout for the work graph
    const lines = result.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        // The run.result response contains the plan text — but we need the structured graph
        if (obj.kind === 'run.result' && obj.response) {
          // Plan text is in response but we need the structured JSON from pipeline logs
        }
      } catch {}
    }

    // Method 2: Check pipeline logs in both the temp dir AND cwd
    const { readdirSync, readFileSync } = await import('node:fs');
    const searchDirs = [
      join(dir, '.crew', 'pipeline-runs'),
      join(process.cwd(), '.crew', 'pipeline-runs')
    ];

    for (const pipelineDir of searchDirs) {
      if (plan) break;
      try {
        const files = readdirSync(pipelineDir).sort().reverse(); // newest first
        for (const f of files) {
          const content = readFileSync(join(pipelineDir, f), 'utf8');
          for (const logLine of content.split('\n').filter(Boolean)) {
            try {
              const entry = JSON.parse(logLine);
              if (entry.plan?.workGraph?.units?.length > 0) {
                // Check timestamp is recent (within last 3 minutes)
                const entryTime = new Date(entry.ts || 0).getTime();
                if (Date.now() - entryTime < 180000) {
                  plan = entry.plan;
                }
              }
            } catch {}
          }
          if (plan) break;
        }
      } catch {}
    }

    // Method 3: Parse the work graph directly from stderr/stdout JSON blocks
    if (!plan) {
      const jsonBlocks = result.match(/\{[\s\S]*?"units"[\s\S]*?\}/g) || [];
      for (const block of jsonBlocks) {
        try {
          const parsed = JSON.parse(block);
          if (parsed.units?.length > 0) {
            plan = { workGraph: parsed, decision: 'execute-parallel' };
          }
        } catch {}
      }
    }

    if (!plan) {
      return { taskId: task.id, error: 'No plan found in output', elapsed, total: 0, maxTotal: 100 };
    }

    const score = scorePlan(task, plan);
    return { taskId: task.id, elapsed, ...score, plan: { decision: plan.decision, unitCount: score.unitCount, personas: score.personas } };
  } catch (err) {
    return { taskId: task.id, error: err.message?.slice(0, 100), elapsed: Date.now() - start, total: 0, maxTotal: 100 };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
const filteredArgs = args.filter((a, i) => i !== outIdx && (outIdx < 0 || i !== outIdx + 1));
const taskFilter = filteredArgs.find(a => !a.startsWith('-'));

const tasksToRun = taskFilter ? TASKS.filter(t => t.id.includes(taskFilter)) : TASKS;

console.log(`\nRunning ${tasksToRun.length} L2 planner benchmark task(s)...\n`);
console.log(`Model: ${process.env.CREW_EXECUTION_MODEL || process.env.CREW_L2A_MODEL || 'default'}\n`);

const results = [];
for (const task of tasksToRun) {
  console.log(`=== ${task.id} (${task.difficulty}) ===`);
  const result = await runTask(task);
  results.push(result);

  if (result.error) {
    console.log(`  ERROR: ${result.error}`);
  } else {
    console.log(`  Score: ${result.total}/${result.maxTotal}`);
    console.log(`  Units: ${result.unitCount} | Personas: ${result.personas.join(', ')}`);
    console.log(`  Breakdown: units=${result.scores.unitCount} personas=${result.scores.personas} deps=${result.scores.dependencies} files=${result.scores.files} AC=${result.scores.acceptanceCriteria} complexity=${result.scores.complexity}`);
  }
  console.log(`  Time: ${Math.round(result.elapsed / 1000)}s`);
  console.log('');
}

const avg = results.reduce((s, r) => s + (r.total || 0), 0) / results.length;
console.log(`=== SUMMARY ===`);
console.log(`Average: ${avg.toFixed(0)}/100`);
console.log(`Tasks: ${results.filter(r => r.total >= 80).length}/${results.length} high quality (80+)`);

if (outFile) {
  await writeFile(outFile, JSON.stringify({ ts: new Date().toISOString(), model: process.env.CREW_EXECUTION_MODEL || 'default', results, avg }, null, 2));
  console.log(`\nSaved: ${outFile}`);
}
