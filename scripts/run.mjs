#!/usr/bin/env node
/**
 * Entrypoint for OpenCrewHQ orchestration.
 * Delegates to unified-orchestrator.mjs.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const OPENCLAW_DIR = process.env.OPENCLAW_DIR || join(__dirname, '..');
const ORCHESTRATOR = join(OPENCLAW_DIR, 'unified-orchestrator.mjs');

const requirement = process.argv.slice(2).join(' ');
if (!requirement) {
  console.log(`
OpenCrewHQ — Multi-agent orchestration for OpenClaw

Usage:
  node scripts/run.mjs "<requirement>"

Example:
  node scripts/run.mjs "Build a todo API in test-output/todo-api with CRUD endpoints and tests"

Prerequisites: openswitchctl status (rt:up, agents:7/7)
`);
  process.exit(1);
}

const proc = spawn('node', [ORCHESTRATOR, requirement], {
  cwd: OPENCLAW_DIR,
  stdio: 'inherit',
  env: { ...process.env },
});

proc.on('close', (code) => process.exit(code ?? 0));
proc.on('error', (err) => {
  console.error('Failed to run orchestrator:', err.message);
  process.exit(1);
});
