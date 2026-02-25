#!/usr/bin/env node
/**
 * OpenCrew RT Test Client
 * Tests the realtime protocol with PM/QA/Fixer workflow
 */
import WebSocket from 'ws';

const HOST = process.env.OPENCREW_RT_HOST || '127.0.0.1';
const PORT = Number(process.env.OPENCREW_RT_PORT || '18889');
const AGENT_ID = process.env.OPENCREW_AGENT_ID || 'qa-engineer-test';
const TOKEN = process.env.OPENCREW_RT_AUTH_TOKEN || '';

const ws = new WebSocket(`ws://${HOST}:${PORT}`);

let connected = false;
const pending = new Map();

ws.on('open', () => {
  console.log(`[${AGENT_ID}] Connected to ws://${HOST}:${PORT}`);
  
  // Send hello
  ws.send(JSON.stringify({
    type: 'hello',
    agentId: AGENT_ID,
    token: TOKEN,
  }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  
  if (msg.type === 'hello.ack') {
    console.log(`[${AGENT_ID}] Authenticated:`, msg);
    connected = true;
    runTests();
  } else if (msg.type === 'message') {
    console.log(`[${AGENT_ID}] Received:`, JSON.stringify(msg.envelope, null, 2));
  } else if (msg.type === 'publish.ack') {
    const resolve = pending.get(msg.id);
    if (resolve) {
      resolve(msg);
      pending.delete(msg.id);
    }
  } else if (msg.type === 'error') {
    console.error(`[${AGENT_ID}] Error:`, msg);
  }
});

function publish(channel, envelope) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const msg = { type: 'publish', id, channel, envelope };
    pending.set(id, resolve);
    ws.send(JSON.stringify(msg));
    
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('Timeout waiting for publish.ack'));
      }
    }, 5000);
  });
}

async function runTests() {
  console.log('\n=== OpenCrew RT Test Suite ===\n');
  
  try {
    // Test 1: Subscribe to channels
    console.log('Test 1: Subscribe to channels...');
    ws.send(JSON.stringify({ type: 'subscribe', channels: ['assign', 'status', 'issues', 'done'] }));
    await new Promise(r => setTimeout(r, 500));
    console.log('✅ Subscribed\n');
    
    // Test 2: Publish task assignment (simulating PM -> QA)
    console.log('Test 2: Publish task.assigned...');
    const assignEnv = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      channel: 'assign',
      from: 'orchestrator',
      to: 'qa-engineer-gpt5',
      type: 'task.assigned',
      taskId: 'test-task-001',
      priority: 'high',
      payload: { title: 'Test QA Check', description: 'Verify OpenCrew RT works' },
    };
    await publish('assign', assignEnv);
    console.log('✅ Task assigned\n');
    
    // Test 3: Post status update (QA working)
    console.log('Test 3: Post status update...');
    const statusEnv = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      channel: 'status',
      from: AGENT_ID,
      to: 'orchestrator',
      type: 'status.update',
      taskId: 'test-task-001',
      payload: { state: 'in_progress', progress: 50 },
    };
    await publish('status', statusEnv);
    console.log('✅ Status update posted\n');
    
    // Test 4: Post QA issue (if testing fixer flow)
    console.log('Test 4: Post qa.issue...');
    const issueEnv = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      channel: 'issues',
      from: AGENT_ID,
      to: 'fixer',
      type: 'qa.issue',
      taskId: 'test-task-001',
      priority: 'medium',
      payload: { issue: 'Minor issue found', severity: 'medium' },
    };
    await publish('issues', issueEnv);
    console.log('✅ QA issue posted\n');
    
    // Test 5: Post task done
    console.log('Test 5: Post task.done...');
    const doneEnv = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      channel: 'done',
      from: AGENT_ID,
      to: 'orchestrator',
      type: 'task.done',
      taskId: 'test-task-001',
      payload: { result: 'All tests passed', artifacts: [] },
    };
    await publish('done', doneEnv);
    console.log('✅ Task done posted\n');
    
    console.log('=== All Tests Passed ===\n');
    
  } catch (err) {
    console.error('Test failed:', err.message);
  }
  
  // Keep connection open briefly then close
  setTimeout(() => {
    ws.close();
    console.log('[${AGENT_ID}] Disconnected');
    process.exit(0);
  }, 2000);
}

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
  process.exit(1);
});
