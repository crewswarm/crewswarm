#!/usr/bin/env node

/**
 * Test Claude Code bypass mode
 * Tests the stdin handling fix for Claude CLI
 */

import { spawn } from 'child_process';

const TEST_PROMPT = 'Write a simple hello world function in JavaScript and explain it briefly.';

console.log('🧪 Testing Claude Code CLI bypass mode...\n');
console.log(`Prompt: "${TEST_PROMPT}"\n`);

const child = spawn('claude', ['-p', '--dangerously-skip-permissions'], {
  cwd: process.cwd(),
  stdio: ['pipe', 'pipe', 'pipe']
});

let stdout = '';
let stderr = '';
let timeoutHit = false;

const timeout = setTimeout(() => {
  timeoutHit = true;
  console.error('⏰ TIMEOUT after 30s - killing process');
  child.kill('SIGTERM');
  setTimeout(() => {
    if (!child.killed) {
      console.error('⚠️  SIGTERM failed, sending SIGKILL');
      child.kill('SIGKILL');
    }
  }, 2000);
}, 30000);

child.stdin.write(TEST_PROMPT, 'utf8', (err) => {
  if (err) {
    console.error('❌ stdin write error:', err);
  } else {
    console.log('✅ stdin written, closing after 50ms...');
  }
  setTimeout(() => {
    if (!child.stdin.destroyed) {
      child.stdin.end();
      console.log('✅ stdin closed\n');
    }
  }, 50);
});

child.stdout.on('data', chunk => {
  stdout += String(chunk);
  // Show progress
  process.stdout.write('.');
});

child.stderr.on('data', chunk => {
  stderr += String(chunk);
});

child.on('error', (err) => {
  clearTimeout(timeout);
  console.error('\n❌ Process error:', err.message);
  process.exit(1);
});

child.on('close', code => {
  clearTimeout(timeout);
  
  if (timeoutHit) {
    console.error('\n❌ TEST FAILED - Process hung and was killed');
    console.log('\nStdout captured:', stdout.slice(0, 500));
    console.log('\nStderr captured:', stderr.slice(0, 500));
    process.exit(1);
  }
  
  console.log(`\n\n✅ Process completed with exit code: ${code}`);
  console.log('\n--- STDOUT ---');
  console.log(stdout || '(empty)');
  
  if (stderr) {
    console.log('\n--- STDERR ---');
    console.log(stderr);
  }
  
  if (code === 0 && stdout.length > 0) {
    console.log('\n✅ TEST PASSED - Claude Code responded successfully');
  } else {
    console.error('\n❌ TEST FAILED - No output or error code');
  }
  
  process.exit(code === 0 && stdout.length > 0 ? 0 : 1);
});
