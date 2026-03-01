#!/usr/bin/env node
/**
 * Task Decomposition Quality Test
 * Compares grok-code vs grok-4-1-reasoning vs claude for breaking down tasks
 * 
 * Usage: node scripts/compare-task-breakdown.mjs
 */

const COMPLEX_TASK = `Build a complete authentication system with:
- User registration with email verification
- Login with JWT tokens
- Password reset flow
- Rate limiting on auth endpoints
- Unit and integration tests
- API documentation

Break this down into specific, actionable work units with dependencies.`;

const results = [];

async function testGrokCode() {
  const start = Date.now();
  try {
    const key = process.env.XAI_API_KEY;
    if (!key) throw new Error('XAI_API_KEY not set');

    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: 'grok-code-fast-1',
        messages: [{ role: 'user', content: COMPLEX_TASK }]
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || res.statusText);
    
    return {
      model: 'grok-code-fast-1',
      success: true,
      timeMs: Date.now() - start,
      response: data.choices[0].message.content,
      tokens: { input: data.usage?.prompt_tokens, output: data.usage?.completion_tokens },
      cost: (data.usage?.prompt_tokens / 1000000) * 0.20 + (data.usage?.completion_tokens / 1000000) * 1.50
    };
  } catch (err) {
    return { model: 'grok-code-fast-1', success: false, error: err.message, timeMs: Date.now() - start };
  }
}

async function testGrok41Reasoning() {
  const start = Date.now();
  try {
    const key = process.env.XAI_API_KEY;
    if (!key) throw new Error('XAI_API_KEY not set');

    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: 'grok-4-1-fast-reasoning',
        messages: [{ role: 'user', content: COMPLEX_TASK }]
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || res.statusText);
    
    return {
      model: 'grok-4-1-fast-reasoning',
      success: true,
      timeMs: Date.now() - start,
      response: data.choices[0].message.content,
      tokens: { input: data.usage?.prompt_tokens, output: data.usage?.completion_tokens },
      cost: (data.usage?.prompt_tokens / 1000000) * 0.20 + (data.usage?.completion_tokens / 1000000) * 0.50
    };
  } catch (err) {
    return { model: 'grok-4-1-fast-reasoning', success: false, error: err.message, timeMs: Date.now() - start };
  }
}

async function testClaude() {
  const start = Date.now();
  try {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY not set');

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 2000,
        messages: [{ role: 'user', content: COMPLEX_TASK }]
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || res.statusText);
    
    return {
      model: 'claude-3-5-sonnet',
      success: true,
      timeMs: Date.now() - start,
      response: data.content[0].text,
      tokens: { input: data.usage?.input_tokens, output: data.usage?.output_tokens },
      cost: (data.usage?.input_tokens / 1000000) * 3.00 + (data.usage?.output_tokens / 1000000) * 15.00
    };
  } catch (err) {
    return { model: 'claude-3-5-sonnet', success: false, error: err.message, timeMs: Date.now() - start };
  }
}

function analyzeQuality(response) {
  const analysis = {
    hasSteps: (response.match(/\d+\.|step \d+/gi) || []).length,
    hasDependencies: /depend|after|before|requires|prerequisite/i.test(response),
    hasCodeBlocks: (response.match(/```/g) || []).length / 2,
    hasTestPlan: /test|spec|assert/i.test(response),
    hasTimeEstimates: /hour|day|week|time/i.test(response),
    organized: /phase|stage|milestone/i.test(response),
    length: response.length
  };

  // Calculate quality score (0-100)
  let score = 0;
  if (analysis.hasSteps >= 5) score += 20;
  if (analysis.hasDependencies) score += 20;
  if (analysis.hasCodeBlocks > 0) score += 15;
  if (analysis.hasTestPlan) score += 15;
  if (analysis.hasTimeEstimates) score += 10;
  if (analysis.organized) score += 20;

  return { ...analysis, qualityScore: score };
}

async function runComparison() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║      TASK DECOMPOSITION QUALITY COMPARISON                   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log('Complex task:');
  console.log(COMPLEX_TASK);
  console.log('\n');

  // Test grok-code
  console.log('Testing grok-code-fast-1...');
  const grokCode = await testGrokCode();
  if (grokCode.success) {
    grokCode.quality = analyzeQuality(grokCode.response);
  }
  results.push(grokCode);
  printResult(grokCode);
  await sleep(3000);

  // Test grok-4-1-reasoning
  console.log('\nTesting grok-4-1-fast-reasoning...');
  const grok41 = await testGrok41Reasoning();
  if (grok41.success) {
    grok41.quality = analyzeQuality(grok41.response);
  }
  results.push(grok41);
  printResult(grok41);
  await sleep(3000);

  // Test claude
  console.log('\nTesting claude-3-5-sonnet...');
  const claude = await testClaude();
  if (claude.success) {
    claude.quality = analyzeQuality(claude.response);
  }
  results.push(claude);
  printResult(claude);

  // Print comparison
  printComparison();
}

function printResult(result) {
  if (result.success) {
    console.log(`  ✅ SUCCESS`);
    console.log(`     Time: ${result.timeMs}ms`);
    console.log(`     Cost: $${result.cost.toFixed(4)}`);
    console.log(`     Tokens: ${result.tokens.input}→${result.tokens.output}`);
    if (result.quality) {
      console.log(`     Quality Score: ${result.quality.qualityScore}/100`);
      console.log(`     Steps identified: ${result.quality.hasSteps}`);
      console.log(`     Has dependencies: ${result.quality.hasDependencies ? 'YES' : 'NO'}`);
      console.log(`     Has code examples: ${result.quality.hasCodeBlocks > 0 ? 'YES' : 'NO'}`);
      console.log(`     Response: ${result.response.substring(0, 200)}...`);
    }
  } else {
    console.log(`  ❌ FAILED: ${result.error}`);
  }
}

function printComparison() {
  console.log('\n\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                   COMPARISON RESULTS                         ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const successful = results.filter(r => r.success);

  if (successful.length === 0) {
    console.log('❌ No models succeeded\n');
    return;
  }

  console.log('| Model | Time | Cost | Quality | Steps | Deps | Code |\n');
  console.log('|-------|------|------|---------|-------|------|------|\n');

  successful.forEach(r => {
    console.log(`| ${r.model.padEnd(28)} | ${r.timeMs}ms | $${r.cost.toFixed(4)} | ${r.quality.qualityScore}/100 | ${r.quality.hasSteps} | ${r.quality.hasDependencies ? 'Y' : 'N'} | ${r.quality.hasCodeBlocks > 0 ? 'Y' : 'N'} |`);
  });

  // Winner analysis
  const sortedByQuality = [...successful].sort((a, b) => b.quality.qualityScore - a.quality.qualityScore);
  const sortedByCost = [...successful].sort((a, b) => a.cost - b.cost);

  console.log('\n\n🏆 WINNER BY QUALITY:');
  console.log(`   ${sortedByQuality[0].model} (${sortedByQuality[0].quality.qualityScore}/100)`);

  console.log('\n💰 WINNER BY COST:');
  console.log(`   ${sortedByCost[0].model} ($${sortedByCost[0].cost.toFixed(4)})`);

  console.log('\n\n📊 DETAILED ANALYSIS:\n');

  successful.forEach(r => {
    console.log(`\n${r.model}:`);
    console.log(`  Quality: ${r.quality.qualityScore}/100`);
    console.log(`  Cost: $${r.cost.toFixed(4)}`);
    console.log(`  Time: ${r.timeMs}ms`);
    console.log(`  Cost per quality point: $${(r.cost / r.quality.qualityScore).toFixed(6)}`);
  });

  console.log('\n\n💡 RECOMMENDATION:\n');

  const grokCode = successful.find(r => r.model === 'grok-code-fast-1');
  const grok41 = successful.find(r => r.model === 'grok-4-1-fast-reasoning');

  if (grokCode && grok41) {
    const qualityDiff = grokCode.quality.qualityScore - grok41.quality.qualityScore;
    const costDiff = grokCode.cost - grok41.cost;

    if (qualityDiff > 20 && costDiff < 0.01) {
      console.log('  ✅ USE grok-code-fast-1');
      console.log(`     Significantly better quality (+${qualityDiff} points)`);
      console.log(`     Similar cost (+$${costDiff.toFixed(4)})`);
    } else if (qualityDiff < -10) {
      console.log('  ✅ USE grok-4-1-fast-reasoning');
      console.log(`     Better quality (+${Math.abs(qualityDiff)} points)`);
      console.log(`     Cheaper ($${Math.abs(costDiff).toFixed(4)} less)`);
    } else {
      console.log('  ⚠️  MARGINAL DIFFERENCE');
      console.log(`     Quality diff: ${qualityDiff > 0 ? '+' : ''}${qualityDiff} points`);
      console.log(`     Cost diff: ${costDiff > 0 ? '+' : ''}$${costDiff.toFixed(4)}`);
      console.log(`     STICK WITH grok-4-1-fast-reasoning (3x cheaper output)`);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

runComparison().catch(console.error);
