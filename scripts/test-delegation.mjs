#!/usr/bin/env node
/**
 * Proper delegation test:
 * 1. Run natural-pm-orchestrator with a single task (create file in project).
 * 2. Capture stderr to detect if RT --send was used or legacy fallback.
 * 3. Verify artifact: file exists with correct content.
 * 4. Report: agents picked it up (RT) vs one-off process (fallback).
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const OPENCLAW_DIR = process.env.OPENCLAW_DIR || join(process.env.HOME || '', 'Desktop', 'OpenClaw');
const ORCHESTRATOR = join(OPENCLAW_DIR, 'natural-pm-orchestrator.mjs');
const ARTIFACT = join(OPENCLAW_DIR, 'test-output', 'delegation-proper-test.txt');
const EXPECTED_CONTENT = 'Delegation proper test: artifact verified.\n';

async function main() {
  const task = `Create test-output/delegation-proper-test.txt with content 'Delegation proper test: artifact verified.'`;
  console.log('🧪 Delegation test (proper)\n');
  console.log('Task:', task);
  console.log('Artifact:', ARTIFACT);
  console.log('');

  const proc = spawn('node', [ORCHESTRATOR, task], {
    cwd: OPENCLAW_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d) => { stdout += d.toString(); });
  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  const code = await new Promise((resolve) => proc.on('close', resolve));

  const usedSend = /Dispatching to crew-coder only/.test(stderr) && !/RT send failed \(token\?\)/.test(stderr);
  const usedFallback = /RT send failed \(token\?\), using legacy spawn/.test(stderr);

  console.log('--- Result ---');
  console.log('Exit code:', code);
  console.log('RT --send used (agent picked up):', usedSend ? 'YES' : 'NO');
  console.log('Legacy fallback used (one-off process):', usedFallback ? 'YES' : 'NO');
  console.log('');

  if (code !== 0) {
    console.error('Stderr (last 800 chars):');
    console.error(stderr.slice(-800));
    process.exit(1);
  }

  if (!existsSync(ARTIFACT)) {
    console.error('❌ Artifact missing:', ARTIFACT);
    process.exit(1);
  }

  const content = readFileSync(ARTIFACT, 'utf8');
  const contentOk = content.trim() === EXPECTED_CONTENT.trim();
  if (!contentOk) {
    console.error('❌ Artifact content mismatch.');
    console.error('Expected:', JSON.stringify(EXPECTED_CONTENT.trim()));
    console.error('Got:', JSON.stringify(content.trim()));
    process.exit(1);
  }

  console.log('✅ Artifact OK:', ARTIFACT);
  console.log('✅ Content verified');
  if (usedSend) {
    console.log('\n✅ Agents picked it up (RT --send worked).');
  } else if (usedFallback) {
    console.log('\n⚠️  One-off process did the work (RT token invalid; set valid OPENCREW_RT_AUTH_TOKEN for agent pickup).');
  }
  console.log('');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
