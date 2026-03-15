#!/usr/bin/env node
/**
 * Entrypoint for crewswarm orchestration.
 * Delegates to unified-orchestrator.mjs.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CREWSWARM_DIR = process.env.CREWSWARM_DIR || process.env.OPENCLAW_DIR || join(__dirname, '..');
const ORCHESTRATOR = join(CREWSWARM_DIR, 'unified-orchestrator.mjs');

const requirement = process.argv.slice(2).join(' ');
if (!requirement) {
  console.log(`
crewswarm — Multi-agent orchestration

Usage:
  node scripts/run.mjs "<requirement>"

Example:
  node scripts/run.mjs "Build a todo API in test-output/todo-api with CRUD endpoints and tests"

Prerequisites: openswitchctl status (rt:up, agents:7/7)
`);
  process.exit(1);
}

const proc = spawn('node', [ORCHESTRATOR, requirement], {
  cwd: CREWSWARM_DIR,
  stdio: 'inherit',
  env: { ...process.env },
});

proc.on('close', (code) => process.exit(code ?? 0));
proc.on('error', (err) => {
  console.error('Failed to run orchestrator:', err.message);
  process.exit(1);
});
