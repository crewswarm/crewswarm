#!/usr/bin/env node

import { spawn } from 'node:child_process';

const gateway = process.env.QA_GATEWAY || 'http://127.0.0.1:5010';
const timeoutMs = Number.parseInt(process.env.QA_TIMEOUT_MS || '90000', 10);
const requireGateway = String(process.env.QA_REQUIRE_GATEWAY || 'false').toLowerCase() === 'true';
const runNegativeControl = String(process.env.QA_ENGINE_NEGATIVE_CONTROL || 'true').toLowerCase() !== 'false';

function isRateLimited(text) {
  const s = String(text || '').toLowerCase();
  return s.includes('429') || s.includes('rate limit') || s.includes('too many requests');
}

function defaultMatrix() {
  return [
    { name: 'cursor', engine: 'cursor', model: process.env.QA_CURSOR_MODEL || '', agent: 'crew-coder' },
    { name: 'claude-cli', engine: 'claude-cli', model: process.env.QA_CLAUDE_MODEL || '', agent: 'crew-coder' },
    { name: 'codex-cli', engine: 'codex-cli', model: process.env.QA_CODEX_MODEL || '', agent: 'crew-coder' },
    { name: 'gemini-cli', engine: 'gemini-cli', model: process.env.QA_GEMINI_MODEL || '', agent: 'crew-coder' },
    { name: 'opencode', engine: 'opencode', model: process.env.QA_OPENCODE_MODEL || '', agent: 'crew-coder' }
  ];
}

function loadMatrix() {
  const raw = process.env.QA_ENGINE_MATRIX_JSON;
  if (!raw) return defaultMatrix();
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : defaultMatrix();
  } catch {
    return defaultMatrix();
  }
}

async function runCrew(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['bin/crew.js', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function gatewayReachable() {
  try {
    const response = await fetch(`${gateway}/status`);
    return response.ok;
  } catch {
    return false;
  }
}

async function main() {
  const up = await gatewayReachable();
  if (!up) {
    const msg = `[engine-matrix] gateway not reachable at ${gateway}`;
    if (requireGateway) throw new Error(msg);
    console.log(`${msg} (SKIP)`);
    return;
  }

  const matrix = loadMatrix();
  if (!matrix.length) {
    console.log('[engine-matrix] no engines configured (SKIP)');
    return;
  }

  const results = [];

  for (const item of matrix) {
    const args = [
      'dispatch',
      item.agent || 'crew-coder',
      item.task || `Reply with exactly QA_ENGINE_CANARY_${(item.name || item.engine || 'X').toUpperCase()}`,
      '--skip-cost-check',
      '--timeout',
      String(Math.max(5000, timeoutMs)),
      '--gateway',
      gateway,
      '--direct',
      '--engine',
      String(item.engine || '')
    ];

    if (item.model) {
      args.push('--model', String(item.model));
    }

    const res = await runCrew(args);
    const combined = `${res.stdout}\n${res.stderr}`;

    if (res.code === 0) {
      console.log(`[engine-matrix] PASS ${item.name || item.engine}`);
      results.push({ engine: item.engine, status: 'PASS' });
      continue;
    }

    if (isRateLimited(combined)) {
      console.log(`[engine-matrix] SKIP_RATE_LIMIT ${item.name || item.engine}`);
      results.push({ engine: item.engine, status: 'SKIP_RATE_LIMIT' });
      continue;
    }

    console.error(`[engine-matrix] FAIL ${item.name || item.engine}`);
    console.error(combined.slice(0, 800));
    results.push({ engine: item.engine, status: 'FAIL' });
  }

  if (runNegativeControl) {
    const invalidEngine = process.env.QA_INVALID_ENGINE || '__invalid_engine__';
    const controlArgs = [
      'dispatch',
      process.env.QA_INVALID_ENGINE_AGENT || 'crew-coder',
      'Reply with exactly QA_ENGINE_NEGATIVE_CONTROL',
      '--skip-cost-check',
      '--timeout',
      String(Math.max(5000, timeoutMs)),
      '--gateway',
      gateway,
      '--direct',
      '--engine',
      invalidEngine
    ];

    const control = await runCrew(controlArgs);
    const controlOutput = `${control.stdout}\n${control.stderr}`;

    if (control.code === 0) {
      console.error(`[engine-matrix] FAIL provenance control: invalid engine "${invalidEngine}" unexpectedly succeeded`);
      console.error(controlOutput.slice(0, 800));
      results.push({ engine: invalidEngine, status: 'FAIL_PROVENANCE_CONTROL' });
    } else if (isRateLimited(controlOutput)) {
      console.log('[engine-matrix] SKIP_RATE_LIMIT provenance control');
      results.push({ engine: invalidEngine, status: 'SKIP_RATE_LIMIT' });
    } else {
      console.log(`[engine-matrix] PASS provenance control (invalid engine "${invalidEngine}" rejected)`);
      results.push({ engine: invalidEngine, status: 'PASS' });
    }
  }

  const failCount = results.filter(x => x.status.startsWith('FAIL')).length;
  const passCount = results.filter(x => x.status === 'PASS').length;
  const skipCount = results.filter(x => x.status.startsWith('SKIP')).length;

  console.log(`[engine-matrix] summary pass=${passCount} skip=${skipCount} fail=${failCount}`);
  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
