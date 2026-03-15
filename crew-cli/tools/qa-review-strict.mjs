#!/usr/bin/env node

import { spawn } from 'node:child_process';

const gateway = process.env.QA_GATEWAY || 'http://127.0.0.1:5010';
const timeoutMs = Number.parseInt(process.env.QA_TIMEOUT_MS || '120000', 10);
const requireGateway = String(process.env.QA_REQUIRE_GATEWAY || 'false').toLowerCase() === 'true';
const reviewAgent = process.env.QA_REVIEW_AGENT || 'crew-qa';

function runCmd(cmd, args) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, {
      cwd: process.cwd(),
      env: { ...process.env, CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
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

async function hasAnyDiff() {
  const unstaged = await runCmd('git', ['diff', '--name-only']);
  const staged = await runCmd('git', ['diff', '--staged', '--name-only']);
  const changed = `${unstaged.stdout}\n${staged.stdout}`.trim();
  return Boolean(changed);
}

async function main() {
  if (!(await hasAnyDiff())) {
    console.log('[qa-review-strict] no git diff detected (SKIP)');
    return;
  }

  const up = await gatewayReachable();
  if (!up) {
    const msg = `[qa-review-strict] gateway not reachable at ${gateway}`;
    if (requireGateway) throw new Error(msg);
    console.log(`${msg} (SKIP)`);
    return;
  }

  const args = ['bin/crew.js', 'review', '--strict', '--agent', reviewAgent, '--gateway', gateway];
  const run = await runCmd(process.execPath, args);
  if (run.code === 0) {
    console.log('[qa-review-strict] PASS');
    return;
  }

  console.error('[qa-review-strict] FAIL');
  console.error(`${run.stdout}\n${run.stderr}`.slice(0, 2000));
  process.exit(run.code || 1);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});

