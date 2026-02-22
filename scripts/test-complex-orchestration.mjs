#!/usr/bin/env node
/**
 * Complex orchestration test
 *
 * Runs unified-orchestrator with a multi-agent task:
 * - PM plans
 * - Codex implements
 * - QA tests
 *
 * Prereqs:
 * - RT daemons running (openswitchctl status)
 * - GROQ_API_KEY set (for groq/llama-3.3-70b-versatile)
 * - All agents configured in ~/.crewswarm/crewswarm.json
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';

const CREWSWARM_DIR = process.env.CREWSWARM_DIR || process.env.OPENCLAW_DIR || join(process.env.HOME || '', 'Desktop', 'CrewSwarm');
const ORCHESTRATOR = join(CREWSWARM_DIR, 'unified-orchestrator.mjs');

// Complex task: multi-step, multi-agent
const COMPLEX_TASK = `Create a simple module in test-output/complex-api/: 
1) Create lib/greet.js that exports a function greet(name) returning "Hello, " + name
2) Create package.json with name "complex-api-test"
3) Create README.md with usage examples
4) Have QA create test/greet.test.js that verifies greet("World") returns "Hello, World"`;

const customTask = process.argv.slice(2).join(' ');
const task = customTask || COMPLEX_TASK;

console.log('🧪 Complex orchestration test');
console.log('   Models: groq/llama-3.3-70b-versatile (ensure ~/.crewswarm/crewswarm.json)');
console.log('   Orchestrator: unified-orchestrator.mjs');
console.log('');
console.log('Task:', task);
console.log('');

const proc = spawn('node', [ORCHESTRATOR, task], {
  cwd: CREWSWARM_DIR,
  stdio: 'inherit',
  env: { ...process.env },
});

proc.on('close', (code) => {
  process.exit(code ?? 0);
});

proc.on('error', (err) => {
  console.error('Failed to run orchestrator:', err.message);
  process.exit(1);
});
