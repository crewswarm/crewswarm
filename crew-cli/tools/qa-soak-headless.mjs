#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const gateway = process.env.QA_GATEWAY || 'http://127.0.0.1:5010';
const timeoutMs = Number.parseInt(process.env.QA_TIMEOUT_MS || '120000', 10);
const requireGateway = String(process.env.QA_REQUIRE_GATEWAY || 'false').toLowerCase() === 'true';
const soakMinutes = Math.max(1, Number.parseInt(process.env.QA_SOAK_MINUTES || '30', 10));
const maxIterations = Math.max(1, Number.parseInt(process.env.QA_SOAK_MAX_ITERATIONS || '9999', 10));

function isRateLimited(text) {
  const s = String(text || '').toLowerCase();
  return s.includes('429') || s.includes('rate limit') || s.includes('too many requests');
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

async function writeReport(report) {
  const dir = join(process.cwd(), '.crew');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'soak-report.json');
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return path;
}

async function main() {
  const up = await gatewayReachable();
  if (!up) {
    const msg = `[qa-soak] gateway not reachable at ${gateway}`;
    if (requireGateway) throw new Error(msg);
    console.log(`${msg} (SKIP)`);
    return;
  }

  const start = Date.now();
  const endAt = start + soakMinutes * 60 * 1000;
  const stats = {
    startedAt: new Date(start).toISOString(),
    durationMinutesTarget: soakMinutes,
    pass: 0,
    skipRateLimit: 0,
    fail: 0,
    iterations: 0
  };

  console.log(`[qa-soak] start duration=${soakMinutes}m gateway=${gateway}`);

  while (Date.now() < endAt && stats.iterations < maxIterations) {
    const i = stats.iterations + 1;
    const task = `Reply with exactly QA_SOAK_TICK_${i}`;
    const args = [
      'dispatch',
      process.env.QA_SOAK_AGENT || 'crew-main',
      task,
      '--skip-cost-check',
      '--timeout',
      String(timeoutMs),
      '--gateway',
      gateway
    ];

    const run = await runCrew(args);
    const output = `${run.stdout}\n${run.stderr}`;
    stats.iterations = i;

    if (run.code === 0) {
      stats.pass += 1;
      if (i % 10 === 0) console.log(`[qa-soak] progress pass=${stats.pass} skip=${stats.skipRateLimit} fail=${stats.fail}`);
      continue;
    }

    if (isRateLimited(output)) {
      stats.skipRateLimit += 1;
      continue;
    }

    stats.fail += 1;
    const reportPath = await writeReport({
      ...stats,
      finishedAt: new Date().toISOString(),
      elapsedMs: Date.now() - start,
      fatalSample: output.slice(0, 2000)
    });
    console.error(`[qa-soak] FAIL iteration=${i}`);
    console.error(`[qa-soak] report=${reportPath}`);
    process.exit(1);
  }

  const reportPath = await writeReport({
    ...stats,
    finishedAt: new Date().toISOString(),
    elapsedMs: Date.now() - start
  });

  console.log(
    `[qa-soak] PASS pass=${stats.pass} skip=${stats.skipRateLimit} fail=${stats.fail} ` +
    `iterations=${stats.iterations} report=${reportPath}`
  );
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});

