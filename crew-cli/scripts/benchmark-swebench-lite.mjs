#!/usr/bin/env node
/**
 * SWE-bench-lite style benchmark runner for crew-cli.
 *
 * Input JSONL format (one case per line):
 * {"id":"case-1","projectDir":"/abs/repo","task":"Fix bug ...","testCmd":"pytest -q tests/test_x.py"}
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

function parseArgs(argv) {
  const out = {
    instancesFile: path.join(process.cwd(), 'external', 'swebench-lite', 'instances.jsonl'),
    num: 10
  };
  for (let i = 2; i < argv.length; i += 1) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--instances-file' && v) out.instancesFile = v;
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
    child.stdin.end();
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

async function loadCases(filePath, maxCases) {
  const raw = await fs.readFile(filePath, 'utf8');
  const lines = raw.split('\n').map(x => x.trim()).filter(Boolean);
  const parsed = lines.map((line, idx) => {
    try {
      const row = JSON.parse(line);
      return {
        id: String(row.id || row.instance_id || `case-${idx + 1}`),
        projectDir: String(row.projectDir || row.repo_path || row.repo || ''),
        task: String(row.task || row.problem_statement || row.instruction || ''),
        testCmd: String(row.testCmd || row.test_command || 'pytest -q'),
        setupCmd: String(row.setupCmd || row.setup_command || '')
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
  return parsed.slice(0, maxCases);
}

function buildTaskPrompt(task, testCmd) {
  return [
    task,
    '',
    'Execution constraints:',
    '1. Implement code changes directly in this repository.',
    '2. Preserve existing architecture and language patterns.',
    `3. Validation command to satisfy: ${testCmd}`,
    '4. Return concrete file edits (not analysis-only).'
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const entries = await loadCases(args.instancesFile, args.num);
  if (entries.length === 0) {
    throw new Error(`No valid cases in ${args.instancesFile}`);
  }

  const crewCliPath = path.join(process.cwd(), 'dist', 'crew.mjs');
  const results = [];

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const cwd = path.resolve(entry.projectDir || process.cwd());
    const prompt = buildTaskPrompt(entry.task, entry.testCmd);

    if (entry.setupCmd) {
      await runCommand('bash', ['-lc', entry.setupCmd], { cwd });
    }

    const dispatch = await runCommand(
      'node',
      [crewCliPath, 'run', '-t', prompt, '--json', '--retry-attempts', '1'],
      { cwd }
    );
    const apply = await runCommand(
      'node',
      [crewCliPath, 'apply', '--force', '--no-validate'],
      { cwd }
    );
    const test = await runCommand('bash', ['-lc', entry.testCmd], { cwd });
    const success = test.code === 0;

    results.push({
      id: entry.id,
      projectDir: cwd,
      success,
      dispatchCode: dispatch.code,
      applyCode: apply.code,
      testCode: test.code,
      testCmd: entry.testCmd,
      dispatchSeconds: Number((dispatch.durationMs / 1000).toFixed(2)),
      totalSeconds: Number(((dispatch.durationMs + apply.durationMs + test.durationMs) / 1000).toFixed(2))
    });

    console.log(`[${i + 1}/${entries.length}] ${entry.id} ${success ? 'PASS' : 'FAIL'} dispatch=${(dispatch.durationMs / 1000).toFixed(2)}s test=${(test.durationMs / 1000).toFixed(2)}s`);
  }

  const passed = results.filter(r => r.success).length;
  const report = {
    timestamp: new Date().toISOString(),
    instancesFile: args.instancesFile,
    num: entries.length,
    passed,
    rate: passed / entries.length,
    results
  };

  const outDir = path.join(process.cwd(), '.crew', 'benchmarks');
  await fs.mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
  const outPath = path.join(outDir, `swebench-lite-${stamp}.json`);
  await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nSWE-bench-lite pass rate: ${passed}/${entries.length} (${(report.rate * 100).toFixed(1)}%)`);
  console.log(`Report: ${outPath}`);
}

main().catch(err => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
