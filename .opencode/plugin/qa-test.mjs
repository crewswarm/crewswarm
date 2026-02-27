#!/usr/bin/env node

/**
 * QA Test Script for OpenCode/OpenClaw Plugin
 * Tests all tools in openclaw-bridge.ts and shared-memory.ts
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.chdir(__dirname);

if (!process.env.OPENCLAW_REQUIRE_API_KEY) process.env.OPENCLAW_REQUIRE_API_KEY = '0';
if (!process.env.OPENCLAW_ALLOWED_AGENTS) process.env.OPENCLAW_ALLOWED_AGENTS = '*';
if (!process.env.OPENCLAW_ALLOW_MISSING_CONTEXT) process.env.OPENCLAW_ALLOW_MISSING_CONTEXT = '1';
if (!process.env.CREWSWARM_RT_REQUIRE_TOKEN) process.env.CREWSWARM_RT_REQUIRE_TOKEN = '0';
if (!process.env.CREWSWARM_RT_AUTO_START) process.env.CREWSWARM_RT_AUTO_START = '0';
const TEST_TIMEOUT_MS = Number(process.env.QA_TEST_TIMEOUT_MS || '45000');
const RUN_SLOW_TESTS = process.env.QA_RUN_SLOW === '1';
const RUN_LIVE_GATEWAY = process.env.QA_RUN_LIVE_GATEWAY === '1';
const RUN_MESSAGING = process.env.QA_RUN_MESSAGING === '1';

// Test context simulating main agent
const TEST_CONTEXT = { agent: 'main' };
const TEST_API_KEY = process.env.OPENCLAW_API_KEY || '';

console.log('=== OpenCode/OpenClaw Plugin QA Tests ===\n');
console.log('Environment:');
console.log('  SHARED_MEMORY_DIR:', process.env.SHARED_MEMORY_DIR || '~/.openclaw/workspace/shared-memory');
console.log('  OPENCLAW_BRIDGE_PATH:', process.env.OPENCLAW_BRIDGE_PATH || '~/Desktop/OpenClaw/gateway-bridge.mjs');
console.log('  CREWSWARM_RT_REQUIRE_TOKEN:', process.env.CREWSWARM_RT_REQUIRE_TOKEN);
console.log('  CREWSWARM_RT_AUTO_START:', process.env.CREWSWARM_RT_AUTO_START);
console.log('  QA_RUN_LIVE_GATEWAY:', RUN_LIVE_GATEWAY ? '1' : '0');
console.log('  QA_RUN_MESSAGING:', RUN_MESSAGING ? '1' : '0');
console.log('  Test Context:', JSON.stringify(TEST_CONTEXT));
console.log('');

const bugs = [];
const results = [];

function withTimeout(promise, name, timeoutMs = TEST_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

async function expectThrows(fn, expectedSubstring) {
  try {
    await fn();
    throw new Error(`Expected throw containing: ${expectedSubstring}`);
  } catch (err) {
    const msg = err?.message || String(err);
    if (!msg.includes(expectedSubstring)) {
      throw new Error(`Expected error including "${expectedSubstring}", got: ${msg}`);
    }
    return msg;
  }
}

// Helper to run a test
async function test(name, fn) {
  try {
    console.log(`Testing: ${name}...`);
    const result = await withTimeout(Promise.resolve().then(fn), name);
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    results.push({ name, status: 'PASS', result: text.substring(0, 200) });
    console.log(`  ✓ PASS: ${text.substring(0, 100)}...`);
    return text;
  } catch (err) {
    const msg = err.message || String(err);
    results.push({ name, status: 'FAIL', error: msg });
    console.log(`  ✗ FAIL: ${msg}`);
    bugs.push({ test: name, error: msg });
    return null;
  }
}

// ========================================
// SHARED MEMORY TESTS
// ========================================
console.log('--- Shared Memory Tests ---\n');

const { SharedMemoryPlugin } = await import('./dist/shared-memory.js');
const memPlugin = await SharedMemoryPlugin();
const memTools = memPlugin.tool;

async function testSharedMemory() {
  // 1. memory_write
  await test('memory_write (plain text)', async () => {
    const result = await memTools.memory_write.execute({
      key: 'test-plain',
      value: 'Hello from QA test!'
    }, TEST_CONTEXT);
    if (!result.includes('Written')) throw new Error('Write failed');
    return result;
  });

  // 2. memory_read (plain text)
  await test('memory_read (plain text)', async () => {
    const result = await memTools.memory_read.execute({
      key: 'test-plain'
    }, TEST_CONTEXT);
    if (!result.includes('Hello from QA test')) throw new Error('Read mismatch');
    return result;
  });

  // 3. memory_write append
  await test('memory_write append', async () => {
    await memTools.memory_write.execute({
      key: 'test-append',
      value: 'Line 1'
    }, TEST_CONTEXT);
    const result = await memTools.memory_write.execute({
      key: 'test-append',
      value: 'Line 2',
      append: true
    }, TEST_CONTEXT);
    const readResult = await memTools.memory_read.execute({
      key: 'test-append'
    }, TEST_CONTEXT);
    if (!readResult.includes('Line 1') || !readResult.includes('Line 2')) {
      throw new Error('Append did not work');
    }
    return result;
  });

  // 4. memory_put (structured record)
  await test('memory_put (structured)', async () => {
    const result = await memTools.memory_put.execute({
      key: 'test-struct',
      value: 'Structured data here',
      scope: 'qa-test',
      tags: ['test', 'qa'],
      ttlSeconds: 60
    }, TEST_CONTEXT);
    if (!result.includes('Stored record')) throw new Error('Put failed');
    return result;
  });

  // 5. memory_get (structured)
  await test('memory_get (structured)', async () => {
    const result = await memTools.memory_get.execute({
      key: 'test-struct'
    }, TEST_CONTEXT);
    const parsed = JSON.parse(result);
    if (parsed.value !== 'Structured data here') throw new Error('Value mismatch');
    if (!parsed.scope || parsed.scope !== 'qa-test') throw new Error('Scope mismatch');
    return result;
  });

  // 6. memory_put with JSON value
  await test('memory_put JSON value', async () => {
    const jsonValue = JSON.stringify({ nested: { data: 123 }, array: [1,2,3] });
    const result = await memTools.memory_put.execute({
      key: 'test-json',
      value: jsonValue,
      scope: 'qa-test'
    }, TEST_CONTEXT);
    const getResult = await memTools.memory_get.execute({ key: 'test-json' }, TEST_CONTEXT);
    const parsed = JSON.parse(getResult);
    if (!parsed.value.includes('nested')) throw new Error('JSON not preserved');
    return result;
  });

  // 7. memory_search by query
  await test('memory_search by query', async () => {
    const result = await memTools.memory_search.execute({
      query: 'structured',
      limit: 10
    }, TEST_CONTEXT);
    const parsed = JSON.parse(result);
    if (parsed.count === 0) throw new Error('Search found nothing');
    return result;
  });

  // 8. memory_search by tag
  await test('memory_search by tag', async () => {
    const result = await memTools.memory_search.execute({
      tag: 'qa',
      limit: 10
    }, TEST_CONTEXT);
    const parsed = JSON.parse(result);
    if (parsed.count === 0) throw new Error('Tag search found nothing');
    return result;
  });

  // 9. memory_search by scope
  await test('memory_search by scope', async () => {
    const result = await memTools.memory_search.execute({
      scope: 'qa-test',
      limit: 10
    }, TEST_CONTEXT);
    const parsed = JSON.parse(result);
    if (parsed.count === 0) throw new Error('Scope search found nothing');
    return result;
  });

  // 10. memory_list
  await test('memory_list', async () => {
    const result = await memTools.memory_list.execute({}, TEST_CONTEXT);
    const parsed = JSON.parse(result);
    if (!parsed.textKeys || !parsed.structuredKeys) throw new Error('List format wrong');
    return result;
  });

  // 11. memory_prune (dry run)
  await test('memory_prune dry-run', async () => {
    const result = await memTools.memory_prune.execute({ dryRun: true }, TEST_CONTEXT);
    if (!result.includes('Prune complete')) throw new Error('Prune failed');
    return result;
  });

  // 12. memory_delete (plain text)
  await test('memory_delete plain text', async () => {
    await memTools.memory_write.execute({ key: 'test-delete', value: 'to be deleted' }, TEST_CONTEXT);
    const result = await memTools.memory_delete.execute({ key: 'test-delete' }, TEST_CONTEXT);
    if (!result.includes('Deleted')) throw new Error('Delete failed');
    return result;
  });

  // 13. memory_get non-existent key
  await test('memory_get non-existent', async () => {
    const result = await memTools.memory_get.execute({ key: 'nonexistent-key-12345' }, TEST_CONTEXT);
    if (!result.includes('not found')) throw new Error('Should say not found');
    return result;
  });

  // 14. Test TTL expiration
  await test('memory_put with short TTL', async () => {
    const result = await memTools.memory_put.execute({
      key: 'test-ttl',
      value: 'expires soon',
      ttlSeconds: 1
    }, TEST_CONTEXT);
    // Wait for expiry
    await new Promise(r => setTimeout(r, 1100));
    const getResult = await memTools.memory_get.execute({ key: 'test-ttl' }, TEST_CONTEXT);
    if (!getResult.includes('expired')) throw new Error('Should be expired');
    return result;
  });

  // 15. Invalid key format
  await test('memory_write invalid key', async () => {
    const result = await memTools.memory_write.execute({
      key: 'invalid key with spaces!',
      value: 'test'
    }, TEST_CONTEXT);
    if (!result.includes('Error')) throw new Error('Should error on invalid key');
    return result;
  });

  // 16. memory_put invalid scope
  await test('memory_put invalid scope', async () => {
    const result = await memTools.memory_put.execute({
      key: 'test-scope',
      value: 'test',
      scope: 'invalid scope!'
    }, TEST_CONTEXT);
    if (!result.includes('Error')) throw new Error('Should error on invalid scope');
    return result;
  });
}

// ========================================
// OPENCLAW BRIDGE TESTS
// ========================================
console.log('\n--- OpenClaw Bridge Tests ---\n');

const { OpenClawBridgePlugin } = await import('./dist/openclaw-bridge.js');
const bridgePlugin = await OpenClawBridgePlugin();
const bridgeTools = bridgePlugin.tool;

// ========================================
// CREWSWARM REALTIME TESTS
// ========================================
console.log('\n--- OpenCrew Realtime Tests ---\n');

const { OpenCrewRealtimePlugin } = await import('./dist/opencrew-rt.js');
const rtPlugin = await OpenCrewRealtimePlugin();
const rtTools = rtPlugin.tool;

async function testOpenCrewRealtime() {
  await test('opencrew_rt_server status', async () => {
    const result = await rtTools.opencrew_rt_server.execute({ action: 'status' }, TEST_CONTEXT);
    const parsed = JSON.parse(result);
    if (typeof parsed.running !== 'boolean') throw new Error('Status payload missing running flag');
    return result;
  });

  await test('opencrew_rt_publish + pull', async () => {
    const pub = await rtTools.opencrew_rt_publish.execute({
      channel: 'assign',
      type: 'task.assigned',
      to: 'qa',
      taskId: 'qa-task-1',
      payload: JSON.stringify({ title: 'Validate build output' })
    }, TEST_CONTEXT);
    const pubParsed = JSON.parse(pub);
    if (!pubParsed.ok) throw new Error('Publish failed');

    const pulled = await rtTools.opencrew_rt_pull.execute({
      channel: 'assign',
      forAgent: 'qa',
      limit: 20
    }, TEST_CONTEXT);
    const pullParsed = JSON.parse(pulled);
    const found = (pullParsed.messages || []).some((m) => m.taskId === 'qa-task-1');
    if (!found) throw new Error('Published message not found in pull');
    return pulled;
  });

  await test('opencrew_rt_assign helper', async () => {
    const result = await rtTools.opencrew_rt_assign.execute({
      to: 'fixer',
      taskId: 'bug-42',
      title: 'Fix failing test',
      description: 'Resolve flaky memory test',
      priority: 'high'
    }, TEST_CONTEXT);
    const parsed = JSON.parse(result);
    if (!parsed.ok || parsed.envelope?.type !== 'task.assigned') throw new Error('Assign helper failed');
    return result;
  });

  await test('opencrew_rt_issue helper', async () => {
    const result = await rtTools.opencrew_rt_issue.execute({
      to: 'fixer',
      taskId: 'bug-42',
      issue: 'Regression in protocol ack logic',
      severity: 'high'
    }, TEST_CONTEXT);
    const parsed = JSON.parse(result);
    if (!parsed.ok || parsed.envelope?.type !== 'qa.issue') throw new Error('Issue helper failed');
    return result;
  });

  await test('opencrew_rt_command helper', async () => {
    const result = await rtTools.opencrew_rt_command.execute({
      to: 'openclaw-main',
      taskId: 'cmd-1',
      action: 'run_task',
      payload: JSON.stringify({ prompt: 'Return one word: ok' }),
      priority: 'high'
    }, TEST_CONTEXT);
    const parsed = JSON.parse(result);
    if (!parsed.ok || parsed.envelope?.channel !== 'command') throw new Error('Command helper failed');
    return result;
  });

  await test('opencrew_rt_ack', async () => {
    const pub = await rtTools.opencrew_rt_publish.execute({
      channel: 'status',
      type: 'task.status',
      taskId: 'ack-test',
      payload: JSON.stringify({ phase: 'in_progress' })
    }, TEST_CONTEXT);
    const pubParsed = JSON.parse(pub);
    const messageId = pubParsed.envelope?.id;
    if (!messageId) throw new Error('Publish did not return envelope id');
    const ack = await rtTools.opencrew_rt_ack.execute({
      messageId,
      status: 'received',
      note: 'ack from QA'
    }, TEST_CONTEXT);
    const ackParsed = JSON.parse(ack);
    if (!ackParsed.ok) throw new Error('Ack failed');
    return ack;
  });

  await test('opencrew_rt_server start + stop', async () => {
    const start = await rtTools.opencrew_rt_server.execute({
      action: 'start',
      host: '127.0.0.1',
      port: 18991,
      requireToken: false
    }, TEST_CONTEXT);
    if (!start.includes('Server started') && !start.includes('already running')) {
      throw new Error(`Unexpected start response: ${start}`);
    }
    const stop = await rtTools.opencrew_rt_server.execute({ action: 'stop' }, TEST_CONTEXT);
    if (!stop.includes('Server stopped')) throw new Error('Stop failed');
    return `${start} | ${stop}`;
  });
}

async function testOpenClawBridge() {
  if (!RUN_LIVE_GATEWAY) {
    await test('openclaw bridge live tests', async () => {
      return 'Skipped live bridge tests (set QA_RUN_LIVE_GATEWAY=1 to enable)';
    });
    await test('openclaw_browse invalid action', async () => {
      return await expectThrows(async () => {
        await bridgeTools.openclaw_browse.execute({
          action: 'invalid-action'
        }, TEST_CONTEXT);
      }, 'Invalid action');
    });
    await test('openclaw_exec blocked dangerous', async () => {
      return await expectThrows(async () => {
        await bridgeTools.openclaw_exec.execute({
          command: 'rm -rf /'
        }, TEST_CONTEXT);
      }, 'dangerous pattern');
    });
    await test('openclaw_session_kill invalid ID', async () => {
      return await expectThrows(async () => {
        await bridgeTools.openclaw_session_kill.execute({
          sessionId: 'invalid id!'
        }, TEST_CONTEXT);
      }, 'Invalid session ID format');
    });
    return;
  }

  // 1. openclaw_status
  await test('openclaw_status', async () => {
    const result = await bridgeTools.openclaw_status.execute({}, TEST_CONTEXT);
    // Status may fail if gateway not running, but should not crash
    return result;
  });

  // 2. openclaw_session_list
  await test('openclaw_session_list', async () => {
    const result = await bridgeTools.openclaw_session_list.execute({}, TEST_CONTEXT);
    return result;
  });

  // 3. openclaw_send (basic)
  await test('openclaw_send (basic)', async () => {
    const result = await bridgeTools.openclaw_send.execute({
      message: 'Hello from QA test'
    }, TEST_CONTEXT);
    return result;
  });

  // 4. openclaw_send with reset
  await test('openclaw_send with resetSession', async () => {
    const result = await bridgeTools.openclaw_send.execute({
      message: 'status',
      resetSession: true
    }, TEST_CONTEXT);
    return result;
  });

  // 5. openclaw_send with streaming (simulated)
  await test('openclaw_send with stream', async () => {
    const result = await bridgeTools.openclaw_send.execute({
      message: 'status',
      stream: true
    }, TEST_CONTEXT);
    if (!result.includes('Streamed')) throw new Error('Streaming did not work');
    return result;
  });

  // 6. openclaw_browse status
  await test('openclaw_browse status', async () => {
    const result = await bridgeTools.openclaw_browse.execute({
      action: 'status'
    }, TEST_CONTEXT);
    return result;
  });

  // 7. openclaw_browse tabs
  await test('openclaw_browse tabs', async () => {
    const result = await bridgeTools.openclaw_browse.execute({
      action: 'tabs'
    }, TEST_CONTEXT);
    return result;
  });

  // 8. openclaw_browse invalid action
  await test('openclaw_browse invalid action', async () => {
    return await expectThrows(async () => {
      await bridgeTools.openclaw_browse.execute({
        action: 'invalid-action'
      }, TEST_CONTEXT);
    }, 'Invalid action');
  });

  // 9. openclaw_exec (basic)
  await test('openclaw_exec (basic)', async () => {
    const result = await bridgeTools.openclaw_exec.execute({
      command: 'echo "QA test"'
    }, TEST_CONTEXT);
    return result;
  });

  // 10. openclaw_exec blocked dangerous
  await test('openclaw_exec blocked dangerous', async () => {
    return await expectThrows(async () => {
      await bridgeTools.openclaw_exec.execute({
        command: 'rm -rf /'
      }, TEST_CONTEXT);
    }, 'dangerous pattern');
  });

  // 11. openclaw_session_create
  await test('openclaw_session_create', async () => {
    const result = await bridgeTools.openclaw_session_create.execute({
      title: 'QA Test Session',
      systemPrompt: 'You are a test session'
    }, TEST_CONTEXT);
    return result;
  });

  // 12. openclaw_session_kill (try to kill a non-existent session)
  await test('openclaw_session_kill', async () => {
    const result = await bridgeTools.openclaw_session_kill.execute({
      sessionId: 'nonexistent-session-12345'
    }, TEST_CONTEXT);
    return result;
  });

  // 13. openclaw_session_kill invalid session ID
  await test('openclaw_session_kill invalid ID', async () => {
    return await expectThrows(async () => {
      await bridgeTools.openclaw_session_kill.execute({
        sessionId: 'invalid id!'
      }, TEST_CONTEXT);
    }, 'Invalid session ID format');
  });

  // 14. openclaw_message (will likely fail without config, but shouldn't crash)
  await test('openclaw_message', async () => {
    if (!RUN_SLOW_TESTS || !RUN_MESSAGING) {
      return 'Skipped (set QA_RUN_SLOW=1 and QA_RUN_MESSAGING=1 to include messaging)';
    }
    const result = await bridgeTools.openclaw_message.execute({
      target: '+15551234567',
      message: 'QA test message'
    }, TEST_CONTEXT);
    return result;
  });
}

// ========================================
// COMBINED/EDGE CASE TESTS
// ========================================
console.log('\n--- Combined & Edge Case Tests ---\n');

async function testCombined() {
  // Use both plugins together: store result from bridge in memory
  await test('Bridge + Memory combined', async () => {
    if (!RUN_LIVE_GATEWAY) {
      return 'Skipped bridge+memory integration (set QA_RUN_LIVE_GATEWAY=1 to enable)';
    }
    const status = await bridgeTools.openclaw_status.execute({}, TEST_CONTEXT);
    await memTools.memory_write.execute({
      key: 'bridge-status',
      value: status.substring(0, 500)
    }, TEST_CONTEXT);
    const stored = await memTools.memory_read.execute({ key: 'bridge-status' }, TEST_CONTEXT);
    if (stored.length === 0) throw new Error('Stored data not found');
    return 'Combined test: stored bridge status in memory';
  });

  // Test memory with special characters
  await test('Memory with special characters', async () => {
    const special = 'Test with 🎉 emoji and "quotes" and\nnewlines';
    await memTools.memory_write.execute({
      key: 'test-special',
      value: special
    }, TEST_CONTEXT);
    const result = await memTools.memory_read.execute({ key: 'test-special' }, TEST_CONTEXT);
    if (!result.includes('🎉')) throw new Error('Special chars not preserved');
    return result;
  });

  // Test memory with very long value
  await test('Memory with long value', async () => {
    const longValue = 'x'.repeat(50000);
    await memTools.memory_write.execute({
      key: 'test-long',
      value: longValue
    }, TEST_CONTEXT);
    const result = await memTools.memory_read.execute({ key: 'test-long' }, TEST_CONTEXT);
    if (result.length !== 50000) throw new Error('Long value truncated');
    return 'Long value preserved';
  });

  // Test key length limit (should work at 80 chars)
  await test('Memory key at max length', async () => {
    const longKey = 'a'.repeat(80);
    const result = await memTools.memory_write.execute({
      key: longKey,
      value: 'max key length'
    }, TEST_CONTEXT);
    return result;
  });

  // Test key over limit (should fail)
  await test('Memory key over limit', async () => {
    const longKey = 'a'.repeat(81);
    const result = await memTools.memory_write.execute({
      key: longKey,
      value: 'too long'
    }, TEST_CONTEXT);
    if (!result.includes('Error')) throw new Error('Should reject key > 80 chars');
    return result;
  });

  // Test empty value
  await test('Memory empty value', async () => {
    const result = await memTools.memory_write.execute({
      key: 'test-empty',
      value: ''
    }, TEST_CONTEXT);
    return result;
  });

  // Test context without agent
  await test('Memory without context', async () => {
    const result = await memTools.memory_read.execute({ key: 'test-plain' }, {});
    return result;
  });
}

// Run all tests
async function runAllTests() {
  await testSharedMemory();
  await testOpenClawBridge();
  await testOpenCrewRealtime();
  await testCombined();

  // Summary
  console.log('\n=== Test Summary ===');
  console.log(`Total: ${results.length}`);
  console.log(`Passed: ${results.filter(r => r.status === 'PASS').length}`);
  console.log(`Failed: ${results.filter(r => r.status === 'FAIL').length}`);
  console.log(`Bugs found: ${bugs.length}`);

  if (bugs.length > 0) {
    console.log('\n=== Bugs ===');
    bugs.forEach((b, i) => {
      console.log(`${i + 1}. ${b.test}: ${b.error}`);
    });
  }

  return { bugs, results };
}

runAllTests().then(({ bugs, results }) => {
  // Write results to files
  const bugsPath = './shared-memory/qa-bugs.txt';
  const resultsPath = './shared-memory/qa-results.txt';
  fs.mkdirSync(path.dirname(bugsPath), { recursive: true });

  if (bugs.length > 0) {
    const bugContent = bugs.map((b, i) => `${i + 1}. ${b.test}: ${b.error}`).join('\n');
    fs.writeFileSync(bugsPath, `QA Bugs Found:\n\n${bugContent}\n`);
    console.log(`\nBugs written to: ${bugsPath}`);
  } else {
    fs.writeFileSync(resultsPath, 'ALL TESTS PASSED\n');
    console.log(`\nAll tests passed! Results written to: ${resultsPath}`);
  }

  process.exit(bugs.length > 0 ? 1 : 0);
}).catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
