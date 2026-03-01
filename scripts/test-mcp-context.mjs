#!/usr/bin/env node
/**
 * Test MCP OpenAI Wrapper Context Forwarding
 * Verifies that system messages, conversation history, and multi-turn context
 * are properly forwarded to crew-lead and agents
 */

const MCP_URL = 'http://127.0.0.1:5020';

const tests = [
  {
    name: 'Simple single-turn',
    model: 'crewswarm',
    messages: [
      { role: 'user', content: 'What is JWT?' }
    ],
    expectMsgCount: 1,
    expectSystem: 0,
    expectUser: 1
  },
  {
    name: 'With system prompt',
    model: 'crewswarm',
    messages: [
      { role: 'system', content: 'You are a coding assistant for Node.js projects.' },
      { role: 'user', content: 'How do I validate JWT tokens?' }
    ],
    expectMsgCount: 2,
    expectSystem: 1,
    expectUser: 1
  },
  {
    name: 'Full conversation history',
    model: 'crewswarm',
    messages: [
      { role: 'system', content: 'You are helping with a CrewSwarm authentication system.' },
      { role: 'user', content: 'Where are the auth files?' },
      { role: 'assistant', content: 'Auth files are in scripts/auth.js and lib/auth-utils.js' },
      { role: 'user', content: 'Show me the JWT validation code' }
    ],
    expectMsgCount: 4,
    expectSystem: 1,
    expectAssistant: 1,
    expectUser: 2
  },
  {
    name: 'Agent dispatch with context',
    model: 'crew-coder',
    messages: [
      { role: 'system', content: 'You are writing Node.js REST API code.' },
      { role: 'user', content: 'Write a JWT validation middleware function' }
    ],
    expectMsgCount: 2,
    expectSystem: 1,
    expectUser: 1,
    isDispatch: true
  }
];

async function runTest(test) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Test: ${test.name}`);
  console.log('='.repeat(60));
  console.log(`Model: ${test.model}`);
  console.log(`Messages: ${test.messages.length}`);
  test.messages.forEach((m, i) => {
    const preview = m.content.substring(0, 50);
    console.log(`  ${i + 1}. [${m.role}] ${preview}${m.content.length > 50 ? '...' : ''}`);
  });

  const start = Date.now();
  try {
    const res = await fetch(`${MCP_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: test.model,
        messages: test.messages,
        temperature: 0.7
      })
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`HTTP ${res.status}: ${error}`);
    }

    const data = await res.json();
    const elapsed = Date.now() - start;

    console.log(`\n✅ SUCCESS (${elapsed}ms)`);
    console.log(`Usage: ${data.usage.prompt_tokens} prompt → ${data.usage.completion_tokens} completion (${data.usage.total_tokens} total)`);
    console.log(`Response preview:`);
    const lines = data.choices[0].message.content.split('\n').slice(0, 5);
    lines.forEach(line => console.log(`  ${line}`));
    if (data.choices[0].message.content.split('\n').length > 5) {
      console.log(`  ... (${data.choices[0].message.content.split('\n').length - 5} more lines)`);
    }

    return { success: true, elapsed, usage: data.usage };
  } catch (err) {
    console.log(`\n❌ FAILED: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║      MCP OpenAI Wrapper Context Forwarding Tests            ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // Check server is up
  try {
    const health = await fetch(`${MCP_URL}/health`);
    const data = await health.json();
    console.log(`MCP Server: ${data.ok ? '✓ Running' : '✗ Down'}`);
    console.log(`Agents: ${data.agents} | Skills: ${data.skills}\n`);
  } catch (err) {
    console.error('❌ MCP server not reachable at', MCP_URL);
    console.error('   Start it with: node scripts/mcp-server.mjs');
    process.exit(1);
  }

  const results = [];
  for (const test of tests) {
    const result = await runTest(test);
    results.push({ ...test, ...result });
    await new Promise(r => setTimeout(r, 2000)); // Rate limiting
  }

  console.log('\n\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                         SUMMARY                              ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  console.log(`✅ Passed: ${successful.length}/${results.length}`);
  if (successful.length > 0) {
    console.log('\n| Test | Model | Msgs | Time | Tokens |');
    console.log('|------|-------|------|------|--------|');
    successful.forEach(r => {
      console.log(`| ${r.name.padEnd(25)} | ${r.model.padEnd(12)} | ${r.expectMsgCount} | ${r.elapsed}ms | ${r.usage.total_tokens} |`);
    });
  }

  if (failed.length > 0) {
    console.log(`\n❌ Failed: ${failed.length}/${results.length}\n`);
    failed.forEach(r => {
      console.log(`   ${r.name}: ${r.error}`);
    });
  }

  console.log('\n💡 Check server logs for context forwarding details:');
  console.log('   tail -f /tmp/mcp-server.log | grep "openai-wrapper"');
  console.log('\n📊 Expected log format:');
  console.log('   [openai-wrapper] model=X route=Y msgs=N (sys:S,asst:A,usr:U) contextChars=C latencyMs=L');
}

main().catch(console.error);
