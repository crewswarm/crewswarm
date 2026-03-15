#!/usr/bin/env node
/**
 * Minimal APPS-style benchmark runner for crew-cli.
 *
 * Expected dataset layout:
 *   <problems-dir>/<id>/question.txt
 *   <problems-dir>/<id>/input_output.json
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function parseArgs(argv) {
  const out = {
    problemsDir: path.join(process.cwd(), 'external', 'apps', 'train'),
    num: 10
  };
  for (let i = 2; i < argv.length; i += 1) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--problems-dir' && v) out.problemsDir = v;
    if (k === '--num' && v) out.num = Math.max(1, Number.parseInt(v, 10) || 10);
  }
  return out;
}

function runCommand(cmd, args, options = {}) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const child = spawn(cmd, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false
    });
    let stdout = '';
    let stderr = '';
    if (options.stdin) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('close', code => {
      resolve({
        code: typeof code === 'number' ? code : 1,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt
      });
    });
    child.on('error', err => {
      resolve({
        code: 1,
        stdout,
        stderr: `${stderr}\n${String(err?.message || err)}`.trim(),
        durationMs: Date.now() - startedAt
      });
    });
  });
}

async function loadProblem(problemDir) {
  const question = await fs.readFile(path.join(problemDir, 'question.txt'), 'utf8');
  const ioRaw = await fs.readFile(path.join(problemDir, 'input_output.json'), 'utf8');
  const io = JSON.parse(ioRaw);
  const inputs = Array.isArray(io.inputs) ? io.inputs : [];
  const outputs = Array.isArray(io.outputs) ? io.outputs : [];
  return {
    question,
    cases: inputs.map((input, i) => ({
      input: String(input ?? ''),
      output: String(outputs[i] ?? '')
    }))
  };
}

function buildTaskPrompt(runDir, question) {
  return [
    'Solve this programming problem in Python.',
    '',
    `Project directory: ${runDir}`,
    'Target file: solution.py',
    '',
    'Requirements:',
    '1. Write complete Python 3 solution in solution.py',
    '2. Read from stdin, write to stdout',
    '3. Do not add explanations to the file',
    '',
    'Problem statement:',
    question
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const entries = (await fs.readdir(args.problemsDir, { withFileTypes: true }))
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort()
    .slice(0, args.num);

  if (entries.length === 0) {
    throw new Error(`No problems found in ${args.problemsDir}`);
  }

  const crewCliPath = path.join(process.cwd(), 'dist', 'crew.mjs');
  const results = [];

  for (let i = 0; i < entries.length; i += 1) {
    const id = entries[i];
    const problemDir = path.join(args.problemsDir, id);
    const { question, cases } = await loadProblem(problemDir);
    const runDir = path.join(os.tmpdir(), `crew-bench-apps-${Date.now()}-${id}`);
    await fs.rm(runDir, { recursive: true, force: true });
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'solution.py'), '# TODO\n', 'utf8');

    const prompt = buildTaskPrompt(runDir, question);
    const dispatch = await runCommand(crewCliPath, ['run', '-t', prompt, '--json', '--retry-attempts', '1'], { cwd: runDir });
    await runCommand(crewCliPath, ['apply', '--force', '--no-validate'], { cwd: runDir });

    let passed = 0;
    for (const tc of cases) {
      const exec = await runCommand('python3', ['solution.py'], { cwd: runDir, stdin: tc.input });
      if (exec.code === 0 && String(exec.stdout || '').trim() === String(tc.output || '').trim()) {
        passed += 1;
      }
    }

    const ok = cases.length > 0 && passed === cases.length;
    results.push({
      id,
      success: ok,
      passed,
      total: cases.length,
      dispatchCode: dispatch.code
    });
    console.log(`[${i + 1}/${entries.length}] ${id} ${ok ? 'PASS' : 'FAIL'} (${passed}/${cases.length})`);
  }

  const passedCount = results.filter(r => r.success).length;
  const report = {
    timestamp: new Date().toISOString(),
    problemsDir: args.problemsDir,
    num: entries.length,
    passed: passedCount,
    rate: passedCount / entries.length,
    results
  };

  const outDir = path.join(process.cwd(), '.crew', 'benchmarks');
  await fs.mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
  const outPath = path.join(outDir, `apps-benchmark-${stamp}.json`);
  await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nAPPS pass rate: ${passedCount}/${entries.length} (${(report.rate * 100).toFixed(1)}%)`);
  console.log(`Report: ${outPath}`);
}

main().catch(err => {
  console.error(err?.stack || String(err));
  process.exit(1);
});

