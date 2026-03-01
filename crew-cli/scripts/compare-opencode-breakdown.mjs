#!/usr/bin/env node
/**
 * OpenCode Task Breakdown Test
 * Compare GPT 5.3 Codex vs Claude 4.6 vs Qwen3 Coder for task decomposition
 * 
 * Usage: OPENCODE_API_KEY=xxx node scripts/compare-opencode-breakdown.mjs
 */

const COMPLEX_TASK = `Build a complete authentication system with:
- User registration with email verification
- Login with JWT tokens
- Password reset flow
- Rate limiting on auth endpoints
- Unit and integration tests
- API documentation

Break this down into specific, actionable work units with dependencies.`;

const MODELS = [
  { id: 'gpt-5.3-codex', name: 'GPT 5.3 Codex', input: 1.75, output: 14.00 },
  { id: 'gpt-5.1-codex-mini', name: 'GPT 5.1 Codex Mini', input: 0.25, output: 2.00 },
  { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6', input: 3.00, output: 15.00 },
  { id: 'qwen3-coder-480b', name: 'Qwen3 Coder 480B', input: 0.45, output: 1.50 },
  { id: 'kimi-k2.5', name: 'Kimi K2.5', input: 0.60, output: 3.00 }
];

const results = [];

async function testModel(model) {
  const start = Date.now();
  try {
    const key = process.env.OPENCODE_API_KEY;
    if (!key) throw new Error('OPENCODE_API_KEY not set');

    const res = await fetch('https://api.opencode.dev/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: model.id,
        messages: [{ role: 'user', content: COMPLEX_TASK }]
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || res.statusText);
    
    const cost = (data.usage?.prompt_tokens / 1000000) * model.input + (data.usage?.completion_tokens / 1000000) * model.output;
    
    return {
      model: model.name,
      modelId: model.id,
      success: true,
      timeMs: Date.now() - start,
      response: data.choices[0].message.content,
      tokens: { input: data.usage?.prompt_tokens, output: data.usage?.completion_tokens },
      cost: cost
    };
  } catch (err) {
    return { model: model.name, modelId: model.id, success: false, error: err.message, timeMs: Date.now() - start };
  }
}

function analyzeQuality(response) {
  const analysis = {
    hasSteps: (response.match(/\d+\.|step \d+|task \d+/gi) || []).length,
    hasDependencies: /depend|after|before|requires|prerequisite|blocks?/i.test(response),
    hasCodeBlocks: (response.match(/```/g) || []).length / 2,
    hasTestPlan: /test|spec|assert|coverage/i.test(response),
    hasTimeEstimates: /hour|day|week|time|duration/i.test(response),
    organized: /phase|stage|milestone|sprint/i.test(response),
    hasAPI: /api|endpoint|route/i.test(response),
    hasDB: /database|schema|migration/i.test(response),
    length: response.length
  };

  let score = 0;
  if (analysis.hasSteps >= 8) score += 25;
  else if (analysis.hasSteps >= 5) score += 15;
  if (analysis.hasDependencies) score += 20;
  if (analysis.hasCodeBlocks >= 2) score += 20;
  else if (analysis.hasCodeBlocks > 0) score += 10;
  if (analysis.hasTestPlan) score += 15;
  if (analysis.hasAPI && analysis.hasDB) score += 10;
  if (analysis.organized) score += 10;

  return { ...analysis, qualityScore: score };
}

async function runComparison() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║    OPENCODE TASK DECOMPOSITION COMPARISON                    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log('Complex task:');
  console.log(COMPLEX_TASK);
  console.log('\n');

  for (const model of MODELS) {
    console.log(`Testing ${model.name}...`);
    const result = await testModel(model);
    if (result.success) {
      result.quality = analyzeQuality(result.response);
    }
    results.push(result);
    printResult(result);
    await sleep(2000);
  }

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
      console.log(`     Steps: ${result.quality.hasSteps} | Deps: ${result.quality.hasDependencies ? 'Y' : 'N'} | Code: ${result.quality.hasCodeBlocks}`);
    }
  } else {
    console.log(`  ❌ FAILED: ${result.error}`);
  }
  console.log('');
}

function printComparison() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                   COMPARISON RESULTS                         ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const successful = results.filter(r => r.success);

  if (successful.length === 0) {
    console.log('❌ No models succeeded\n');
    return;
  }

  console.log('| Model | Time | Cost | Quality | Steps | Deps | Code | Value |\n');
  console.log('|-------|------|------|---------|-------|------|------|-------|\n');

  successful.forEach(r => {
    const value = r.quality.qualityScore / r.cost;
    console.log(`| ${r.model.padEnd(22)} | ${r.timeMs}ms | $${r.cost.toFixed(3)} | ${r.quality.qualityScore}/100 | ${r.quality.hasSteps} | ${r.quality.hasDependencies ? 'Y' : 'N'} | ${r.quality.hasCodeBlocks} | ${value.toFixed(0)} |`);
  });

  const sortedByQuality = [...successful].sort((a, b) => b.quality.qualityScore - a.quality.qualityScore);
  const sortedByCost = [...successful].sort((a, b) => a.cost - b.cost);
  const sortedByValue = [...successful].sort((a, b) => (b.quality.qualityScore / b.cost) - (a.quality.qualityScore / a.cost));

  console.log('\n\n🏆 WINNERS:\n');
  console.log(`  Quality: ${sortedByQuality[0].model} (${sortedByQuality[0].quality.qualityScore}/100)`);
  console.log(`  Cost: ${sortedByCost[0].model} ($${sortedByCost[0].cost.toFixed(4)})`);
  console.log(`  Value: ${sortedByValue[0].model} (${(sortedByValue[0].quality.qualityScore / sortedByValue[0].cost).toFixed(0)} points/$)`);

  console.log('\n\n📊 DETAILED BREAKDOWN:\n');

  successful.forEach(r => {
    console.log(`${r.model}:`);
    console.log(`  Quality: ${r.quality.qualityScore}/100`);
    console.log(`  Cost: $${r.cost.toFixed(4)}`);
    console.log(`  Time: ${r.timeMs}ms`);
    console.log(`  Value: ${(r.quality.qualityScore / r.cost).toFixed(0)} quality points per dollar`);
    console.log(`  Steps identified: ${r.quality.hasSteps}`);
    console.log(`  Has dependencies: ${r.quality.hasDependencies ? 'YES' : 'NO'}`);
    console.log(`  Code examples: ${r.quality.hasCodeBlocks}`);
    console.log(`  Preview: ${r.response.substring(0, 200)}...`);
    console.log('');
  });

  console.log('\n💡 RECOMMENDATION FOR L2 (PLANNING/REASONING):\n');

  const gpt53 = successful.find(r => r.modelId === 'gpt-5.3-codex');
  const qwen3 = successful.find(r => r.modelId === 'qwen3-coder-480b');
  const claude = successful.find(r => r.modelId === 'claude-sonnet-4.6');

  if (gpt53) {
    console.log(`  GPT 5.3 Codex: Quality ${gpt53.quality.qualityScore}/100, $${gpt53.cost.toFixed(4)}`);
  }
  if (claude) {
    console.log(`  Claude Sonnet 4.6: Quality ${claude.quality.qualityScore}/100, $${claude.cost.toFixed(4)}`);
  }
  if (qwen3) {
    console.log(`  Qwen3 Coder 480B: Quality ${qwen3.quality.qualityScore}/100, $${qwen3.cost.toFixed(4)}`);
  }

  const winner = sortedByValue[0];
  console.log(`\n  ✅ BEST CHOICE: ${winner.model}`);
  console.log(`     Best value (${(winner.quality.qualityScore / winner.cost).toFixed(0)} points/$)`);
  console.log(`     Quality: ${winner.quality.qualityScore}/100`);
  console.log(`     Cost: $${winner.cost.toFixed(4)} per request`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

runComparison().catch(console.error);
