#!/usr/bin/env node

import { spawn } from 'node:child_process';

const gateway = process.env.QA_GATEWAY || 'http://127.0.0.1:5010';
const timeoutMs = Number.parseInt(process.env.QA_TIMEOUT_MS || '120000', 10);
const requireGateway = String(process.env.QA_REQUIRE_GATEWAY || 'false').toLowerCase() === 'true';

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

async function main() {
  const up = await gatewayReachable();
  if (!up) {
    const msg = `[pm-loop-e2e] gateway not reachable at ${gateway}`;
    if (requireGateway) throw new Error(msg);
    console.log(`${msg} (SKIP)`);
    return;
  }

  const planPrompt = [
    'Create a short implementation plan for this task:',
    'Add a health-check helper function.',
    'Return only concise numbered steps.'
  ].join(' ');

  const pm = await runCrew([
    'dispatch',
    'crew-pm',
    planPrompt,
    '--skip-cost-check',
    '--timeout',
    String(timeoutMs),
    '--gateway',
    gateway
  ]);

  const pmOutput = `${pm.stdout}\n${pm.stderr}`;
  if (pm.code !== 0) {
    if (isRateLimited(pmOutput)) {
      console.log('[pm-loop-e2e] SKIP_RATE_LIMIT (pm step)');
      return;
    }
    throw new Error(`[pm-loop-e2e] crew-pm dispatch failed:\n${pmOutput.slice(0, 1000)}`);
  }

  const coder = await runCrew([
    'dispatch',
    'crew-coder',
    'Implement a tiny canary change idea and explain in 3 lines max.',
    '--skip-cost-check',
    '--timeout',
    String(timeoutMs),
    '--gateway',
    gateway
  ]);

  const coderOutput = `${coder.stdout}\n${coder.stderr}`;
  if (coder.code !== 0) {
    if (isRateLimited(coderOutput)) {
      console.log('[pm-loop-e2e] SKIP_RATE_LIMIT (coder step)');
      return;
    }
    throw new Error(`[pm-loop-e2e] crew-coder dispatch failed:\n${coderOutput.slice(0, 1000)}`);
  }

  const preview = await runCrew(['preview']);
  if (preview.code !== 0) {
    throw new Error(`[pm-loop-e2e] preview failed:\n${preview.stderr.slice(0, 500)}`);
  }

  console.log('[pm-loop-e2e] PASS pm->coder->preview flow');
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});

