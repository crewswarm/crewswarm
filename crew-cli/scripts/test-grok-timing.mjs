#!/usr/bin/env node
/**
 * Direct Grok API Test - Measure L2 Routing Time
 * 
 * Tests how long Grok takes to make routing decision
 */

import fs from 'fs';

const ROADMAP = fs.readFileSync('/Users/jeffhobbs/CrewSwarm/crew-cli/ide-extension/ROADMAP.md', 'utf8');
const PDD = fs.readFileSync('/Users/jeffhobbs/CrewSwarm/crew-cli/ide-extension/PDD.md', 'utf8');

const TASK = `Build the MVP (Phase 1) of a VS Code extension for CrewSwarm per the specs in the roadmap.

Output to: /Users/jeffhobbs/Desktop/benchmark-vscode-grok

Requirements from ROADMAP Phase 1:
1. Extension scaffold with package.json
2. Webview chat UI with message bridge
3. API client for POST /v1/chat with streaming
4. Action parser for patches/files/commands
5. Diff preview and apply via WorkspaceEdit
6. Status bar with connection status
7. Basic branding

Create these files:
- package.json
- src/extension.ts
- src/api-client.ts
- src/webview/chat.html
- src/webview/chat.js
- src/webview/styles.css
- src/diff-handler.ts
- README.md
- tests/extension.test.ts`;

const TESTS = [
  {
    name: 'L2 ROUTING (No Context)',
    prompt: `Analyze this request and decide:

1. DIRECT-ANSWER: Simple question, greeting, or status check → Provide immediate response
2. EXECUTE-LOCAL: Single-task execution (write code, refactor, etc) → Use local executor
3. EXECUTE-PARALLEL: Complex multi-step task requiring coordination → Use dual-L2 planner

Return ONLY valid JSON:
{
  "decision": "direct-answer|execute-local|execute-parallel",
  "reasoning": "why this path was chosen",
  "directResponse": "if direct-answer, provide response here",
  "complexity": "low|medium|high",
  "estimatedCost": 0.001
}

User request: ${TASK}`,
    includeContext: false
  },
  {
    name: 'L2 ROUTING (With ROADMAP)',
    prompt: `Analyze this request and decide routing.

ROADMAP.md content:
${ROADMAP}

Return JSON decision for:
${TASK}`,
    includeContext: true
  },
  {
    name: 'L2 ROUTING (With ROADMAP + PDD)',
    prompt: `Analyze this request and decide routing.

ROADMAP.md:
${ROADMAP}

PDD.md:
${PDD}

Return JSON decision for:
${TASK}`,
    includeContext: true
  },
  {
    name: 'DIRECT CODE GENERATION',
    prompt: TASK,
    includeContext: false,
    directCodeGen: true
  }
];

async function testGrokCall(test) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`🧪 ${test.name}`);
  console.log('─'.repeat(70));
  
  const promptLength = test.prompt.length;
  console.log(`Prompt length: ${promptLength} chars (${Math.round(promptLength/4)} tokens est.)`);
  console.log(`Includes context: ${test.includeContext}`);
  console.log('');

  const startTime = Date.now();
  
  try {
    const key = process.env.XAI_API_KEY;
    if (!key) throw new Error('XAI_API_KEY not set');

    console.log('📤 Calling Grok API...');
    
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model: 'grok-4-1-fast-reasoning',
        messages: [{ role: 'user', content: test.prompt }],
        temperature: test.directCodeGen ? 0.7 : 0.3,
        max_tokens: test.directCodeGen ? 4000 : 1000
      })
    });

    const elapsed = Date.now() - startTime;

    if (!response.ok) {
      const error = await response.text();
      console.log(`❌ FAILED (${elapsed}ms): HTTP ${response.status}`);
      console.log(`   Error: ${error.substring(0, 200)}`);
      return { success: false, time: elapsed, error: `HTTP ${response.status}` };
    }

    const data = await response.json();
    const content = data.choices[0].message.content;
    
    console.log(`✅ SUCCESS (${elapsed}ms)`);
    console.log(`   Input tokens: ${data.usage.prompt_tokens}`);
    console.log(`   Output tokens: ${data.usage.completion_tokens}`);
    console.log(`   Total tokens: ${data.usage.total_tokens}`);
    
    const cost = (data.usage.prompt_tokens / 1000000) * 0.20 + (data.usage.completion_tokens / 1000000) * 0.50;
    console.log(`   Cost: $${cost.toFixed(6)}`);
    console.log('');
    
    console.log('📥 RESPONSE (first 500 chars):');
    console.log(content.substring(0, 500));
    if (content.length > 500) console.log('...');
    
    return {
      success: true,
      time: elapsed,
      cost: cost,
      tokens: data.usage,
      responseLength: content.length,
      response: content
    };
    
  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.log(`❌ FAILED (${elapsed}ms): ${err.message}`);
    return { success: false, time: elapsed, error: err.message };
  }
}

async function runTests() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║        DIRECT GROK API TIMING TEST - L2 ROUTING             ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Testing to see:');
  console.log('  1. How long Grok takes for L2 routing decision');
  console.log('  2. If including roadmap/PDD affects timing');
  console.log('  3. What the actual response looks like');
  console.log('');

  const results = [];

  for (const test of TESTS) {
    const result = await testGrokCall(test);
    results.push({ name: test.name, ...result });
    
    console.log('\n⏳ Waiting 3s before next test...\n');
    await new Promise(r => setTimeout(r, 3000));
  }

  // Summary
  console.log('\n\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                       SUMMARY                                ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  if (successful.length > 0) {
    console.log('| Test | Time | Cost | Tokens (in→out) |');
    console.log('|------|------|------|-----------------|');
    successful.forEach(r => {
      const tokens = r.tokens ? `${r.tokens.prompt_tokens}→${r.tokens.completion_tokens}` : 'N/A';
      console.log(`| ${r.name.substring(0, 30).padEnd(30)} | ${(r.time/1000).toFixed(1)}s | $${r.cost.toFixed(4)} | ${tokens} |`);
    });

    const avgTime = successful.reduce((sum, r) => sum + r.time, 0) / successful.length;
    const totalCost = successful.reduce((sum, r) => sum + r.cost, 0);

    console.log('');
    console.log(`Average time: ${(avgTime/1000).toFixed(1)}s`);
    console.log(`Total cost: $${totalCost.toFixed(4)}`);
    console.log('');

    console.log('🔍 ANALYSIS:\n');
    
    const noContext = successful.find(r => r.name.includes('No Context'));
    const withRoadmap = successful.find(r => r.name.includes('With ROADMAP)'));
    
    if (noContext && withRoadmap) {
      const diff = withRoadmap.time - noContext.time;
      console.log(`  Context overhead: ${(diff/1000).toFixed(1)}s (${((diff/noContext.time)*100).toFixed(0)}%)`);
    }

    if (avgTime > 30000) {
      console.log(`  ⚠️  Average ${(avgTime/1000).toFixed(1)}s > 30s timeout - TIMEOUT TOO SHORT`);
    } else {
      console.log(`  ✅ Average ${(avgTime/1000).toFixed(1)}s < 30s timeout - timeout is adequate`);
    }
  }

  if (failed.length > 0) {
    console.log(`\n❌ FAILED: ${failed.length} tests\n`);
    failed.forEach(r => {
      console.log(`  ${r.name}: ${r.error}`);
    });
  }

  console.log('\n✅ TEST COMPLETE\n');
}

runTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
