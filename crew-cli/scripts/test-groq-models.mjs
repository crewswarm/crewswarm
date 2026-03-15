#!/usr/bin/env node
/**
 * Groq Model Test Suite
 * Tests all Groq models from the reference list
 * 
 * Usage: node scripts/test-groq-models.mjs
 */

const TEST_PROMPT = "Write a simple function to validate an email address. Just show the function, no explanation.";

// Groq models from reference
const GROQ_MODELS = [
  { id: 'gpt-oss-20b-128k', name: 'GPT OSS 20B 128k', input: 0.075, output: 0.30, tps: 1000 },
  { id: 'gpt-oss-safeguard-20b', name: 'GPT OSS Safeguard 20B', input: 0.075, output: 0.30, tps: 1000 },
  { id: 'gpt-oss-120b-128k', name: 'GPT OSS 120B 128k', input: 0.15, output: 0.60, tps: 500 },
  { id: 'kimi-k2-0905-1t-256k', name: 'Kimi K2-0905 1T 256k', input: 1.00, output: 3.00, tps: 200 },
  { id: 'llama-4-scout', name: 'Llama 4 Scout (17Bx16E) 128k', input: 0.11, output: 0.34, tps: 594 },
  { id: 'llama-4-maverick', name: 'Llama 4 Maverick (17Bx128E) 128k', input: 0.20, output: 0.60, tps: 562 },
  { id: 'qwen3-32b-131k', name: 'Qwen3 32B 131k', input: 0.29, output: 0.59, tps: 662 },
  { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile 128k', input: 0.59, output: 0.79, tps: 394 },
  { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B Instant 128k', input: 0.05, output: 0.08, tps: 840 }
];

const results = [];

async function testGroqModel(model) {
  const start = Date.now();
  try {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw new Error('GROQ_API_KEY not set');

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: model.id,
        messages: [{ role: 'user', content: TEST_PROMPT }]
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
      hasCode: data.choices[0].message.content.includes('function') || data.choices[0].message.content.includes('def'),
      responseLength: data.choices[0].message.content.length,
      tokens: { input: data.usage?.prompt_tokens, output: data.usage?.completion_tokens },
      cost: cost,
      tps: model.tps,
      pricing: { input: model.input, output: model.output }
    };
  } catch (err) {
    return { 
      model: model.name, 
      modelId: model.id,
      success: false, 
      error: err.message, 
      timeMs: Date.now() - start,
      tps: model.tps,
      pricing: { input: model.input, output: model.output }
    };
  }
}

async function runTests() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║              GROQ MODEL TEST SUITE                           ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log('Test prompt:', TEST_PROMPT.substring(0, 60) + '...\n');

  for (const model of GROQ_MODELS) {
    console.log(`\nTesting ${model.name}...`);
    const result = await testGroqModel(model);
    results.push(result);
    printResult(result);
    await sleep(1000); // Rate limit protection
  }

  printSummary();
}

function printResult(result) {
  if (result.success) {
    console.log(`  ✅ SUCCESS`);
    console.log(`     Time: ${result.timeMs}ms`);
    console.log(`     Cost: $${result.cost.toFixed(6)}`);
    console.log(`     Tokens: ${result.tokens.input}→${result.tokens.output}`);
    console.log(`     Has code: ${result.hasCode ? 'YES' : 'NO'}`);
    console.log(`     Throughput: ${result.tps} TPS`);
  } else {
    console.log(`  ❌ FAILED: ${result.error}`);
    console.log(`     Pricing: $${result.pricing.input}/$${result.pricing.output} per 1M tokens`);
  }
}

function printSummary() {
  console.log('\n\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                       SUMMARY                                ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  console.log(`✅ WORKING: ${successful.length}/${results.length} models\n`);
  
  if (successful.length > 0) {
    console.log('| Model | Time | Cost | TPS | Price (in/out) |');
    console.log('|-------|------|------|-----|----------------|');
    successful.forEach(r => {
      console.log(`| ${r.model.padEnd(35)} | ${r.timeMs}ms | $${r.cost.toFixed(6)} | ${r.tps} | $${r.pricing.input}/$${r.pricing.output} |`);
    });
  }

  if (failed.length > 0) {
    console.log(`\n\n❌ FAILED: ${failed.length}/${results.length} models\n`);
    failed.forEach(r => {
      console.log(`   ${r.model.padEnd(40)} ${r.error}`);
    });
  }

  if (successful.length > 0) {
    console.log('\n\n📊 PERFORMANCE RANKINGS:\n');

    console.log('🏃 FASTEST (lowest latency):');
    const bySpeed = [...successful].sort((a, b) => a.timeMs - b.timeMs);
    bySpeed.slice(0, 3).forEach((r, i) => {
      console.log(`  ${i+1}. ${r.model.padEnd(40)} ${r.timeMs}ms`);
    });

    console.log('\n💰 CHEAPEST (per request):');
    const byCost = [...successful].sort((a, b) => a.cost - b.cost);
    byCost.slice(0, 3).forEach((r, i) => {
      console.log(`  ${i+1}. ${r.model.padEnd(40)} $${r.cost.toFixed(6)}`);
    });

    console.log('\n⚡ HIGHEST THROUGHPUT:');
    const byTPS = [...successful].sort((a, b) => b.tps - a.tps);
    byTPS.slice(0, 3).forEach((r, i) => {
      console.log(`  ${i+1}. ${r.model.padEnd(40)} ${r.tps} TPS`);
    });

    console.log('\n\n💡 RECOMMENDED FOR CREWSWARM:\n');

    const cheapest = byCost[0];
    const fastest = bySpeed[0];
    const highThroughput = byTPS[0];

    console.log(`  L1 (Chat - need speed): ${fastest.model}`);
    console.log(`     → ${fastest.timeMs}ms, $${fastest.cost.toFixed(6)} per request`);
    
    console.log(`\n  L3 (Execution - need cheap): ${cheapest.model}`);
    console.log(`     → ${cheapest.timeMs}ms, $${cheapest.cost.toFixed(6)} per request`);
    
    if (highThroughput.modelId !== cheapest.modelId && highThroughput.modelId !== fastest.modelId) {
      console.log(`\n  Parallel work (need TPS): ${highThroughput.model}`);
      console.log(`     → ${highThroughput.tps} TPS, ${highThroughput.timeMs}ms`);
    }

    console.log('\n\n🆚 COMPARISON VS GEMINI:\n');
    console.log('  Gemini 2.5 Flash Lite: ~951ms, $0.0004 per request');
    console.log(`  Groq ${fastest.model}: ${fastest.timeMs}ms, $${fastest.cost.toFixed(6)} per request`);
    
    if (fastest.timeMs < 951) {
      console.log(`\n  ✅ Groq is ${(951 - fastest.timeMs)}ms FASTER`);
    } else {
      console.log(`\n  ⚠️  Gemini is ${(fastest.timeMs - 951)}ms faster`);
    }

    const geminiCost = 0.0004;
    if (cheapest.cost < geminiCost) {
      console.log(`  ✅ Groq ${cheapest.model} is ${((geminiCost - cheapest.cost) / geminiCost * 100).toFixed(1)}% CHEAPER`);
    } else {
      console.log(`  ⚠️  Gemini is ${((cheapest.cost - geminiCost) / geminiCost * 100).toFixed(1)}% cheaper`);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

runTests().catch(console.error);
