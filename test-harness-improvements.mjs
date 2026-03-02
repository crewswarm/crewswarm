#!/usr/bin/env node
/**
 * Test harness improvements (Weeks 1 & 2)
 * Tests: adaptive memory, token budgets, reasoning, task spec persistence
 */

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import os from 'os';

const API_BASE = 'http://127.0.0.1:5010';
const AUTH_TOKEN = (() => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.crewswarm', 'config.json'), 'utf8'));
    return cfg.rt?.authToken;
  } catch {
    console.error('❌ Cannot read auth token from ~/.crewswarm/config.json');
    process.exit(1);
  }
})();

const headers = {
  'Authorization': `Bearer ${AUTH_TOKEN}`,
  'Content-Type': 'application/json'
};

async function dispatchTask(agent, task) {
  const res = await fetch(`${API_BASE}/api/dispatch`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ agent, task })
  });
  return await res.json();
}

async function pollStatus(taskId, maxWait = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const res = await fetch(`${API_BASE}/api/status/${taskId}`, { headers });
    const data = await res.json();
    if (data.status === 'completed' || data.status === 'failed') {
      return data;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return { status: 'timeout' };
}

console.log('🧪 Testing Harness Improvements (Weeks 1 & 2)\n');

// Test 1: Adaptive Memory Scaling
console.log('📊 Test 1: Adaptive Memory Scaling');
console.log('Simple task → should use 3 memory results');
const test1 = await dispatchTask('crew-coder', 'Write hello.js that prints "Hello World"');
console.log(`  Dispatched: ${test1.taskId}`);
const result1 = await pollStatus(test1.taskId, 30000);
console.log(`  Status: ${result1.status}`);
console.log(`  Reply length: ${result1.reply?.length || 0} chars\n`);

// Test 2: Token Budget Warning (use large context)
console.log('⏰ Test 2: Token Budget Warning');
console.log('Large context task → should trigger 70% warning');
const largeContext = 'a'.repeat(200000); // ~50K tokens
const test2 = await dispatchTask('crew-coder', `Read this data and summarize: ${largeContext}`);
console.log(`  Dispatched: ${test2.taskId}`);
const result2 = await pollStatus(test2.taskId, 30000);
console.log(`  Status: ${result2.status}`);
const hasWarning = result2.reply?.includes('Context Budget') || result2.reply?.includes('⏰');
console.log(`  Budget warning triggered: ${hasWarning ? '✅ YES' : '❌ NO'}\n`);

// Test 3: Adaptive Reasoning Budget
console.log('🧠 Test 3: Adaptive Reasoning Budget');
console.log('Planning task → should use xhigh reasoning');
const test3 = await dispatchTask('crew-pm', 'Design the architecture for a real-time collaborative document editor');
console.log(`  Dispatched: ${test3.taskId}`);
const result3 = await pollStatus(test3.taskId, 45000);
console.log(`  Status: ${result3.status}`);
console.log(`  Reply length: ${result3.reply?.length || 0} chars\n`);

// Test 4: Task Spec Persistence
console.log('📋 Test 4: Task Spec Persistence');
console.log('Multi-step task → reply should include [ORIGINAL TASK]');
const test4 = await dispatchTask('crew-coder', 'Create auth.js with JWT login, bcrypt hashing, and rate limiting middleware');
console.log(`  Dispatched: ${test4.taskId}`);
const result4 = await pollStatus(test4.taskId, 45000);
console.log(`  Status: ${result4.status}`);
const hasTaskSpec = result4.reply?.includes('[ORIGINAL TASK]');
console.log(`  Task spec injected: ${hasTaskSpec ? '✅ YES' : '❌ NO'}\n`);

// Check telemetry
console.log('📈 Checking Telemetry Logs...');
const telemetryLog = '/tmp/opencrew-rt-daemon.log';
if (fs.existsSync(telemetryLog)) {
  const logs = fs.readFileSync(telemetryLog, 'utf8');
  const budgetWarnings = (logs.match(/token_budget_warning/g) || []).length;
  const taskSpecs = (logs.match(/task_spec_injected/g) || []).length;
  const reasoningEvents = (logs.match(/reasoningBudget/g) || []).length;
  
  console.log(`  Token budget warnings: ${budgetWarnings}`);
  console.log(`  Task spec injections: ${taskSpecs}`);
  console.log(`  Reasoning budget events: ${reasoningEvents}\n`);
} else {
  console.log(`  ⚠️ Log file not found: ${telemetryLog}\n`);
}

// Summary
console.log('✅ Test Suite Complete\n');
console.log('Results:');
console.log(`  Test 1 (Adaptive Memory): ${result1.status}`);
console.log(`  Test 2 (Token Budget): ${result2.status} - Warning: ${hasWarning ? 'YES' : 'NO'}`);
console.log(`  Test 3 (Reasoning): ${result3.status}`);
console.log(`  Test 4 (Task Spec): ${result4.status} - Injected: ${hasTaskSpec ? 'YES' : 'NO'}`);

console.log('\n💡 Next: Check individual task replies for detailed verification');
console.log(`   Dashboard: http://127.0.0.1:4319`);
