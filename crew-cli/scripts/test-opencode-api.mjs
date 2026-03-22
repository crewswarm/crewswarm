#!/usr/bin/env node
/**
 * OpenCode API Test Suite
 * Tests models from OpenCode API including GPT 5.x Codex, Claude, Gemini, etc.
 * 
 * Usage: OPENCODE_API_KEY=xxx node scripts/test-opencode-api.mjs
 */

const TEST_PROMPT = "Write a simple function to validate an email address. Just show the function, no explanation.";

// OpenCode API models - focusing on best candidates for our stack
const OPENCODE_MODELS = [
  // FREE MODELS - test these first!
  { id: 'big-pickle', name: 'Big Pickle', input: 0, output: 0, category: 'free' },
  { id: 'minimax-m2.5-free', name: 'MiniMax M2.5 Free', input: 0, output: 0, category: 'free' },
  { id: 'gpt-5-nano', name: 'GPT 5 Nano', input: 0, output: 0, category: 'free' },
  
  // GPT 5.x CODEX - the coding specialists
  { id: 'gpt-5.3-codex', name: 'GPT 5.3 Codex', input: 1.75, output: 14.00, cache: 0.175, category: 'codex' },
  { id: 'gpt-5.2-codex', name: 'GPT 5.2 Codex', input: 1.75, output: 14.00, cache: 0.175, category: 'codex' },
  { id: 'gpt-5.1-codex', name: 'GPT 5.1 Codex', input: 1.07, output: 8.50, cache: 0.107, category: 'codex' },
  { id: 'gpt-5.1-codex-mini', name: 'GPT 5.1 Codex Mini', input: 0.25, output: 2.00, cache: 0.025, category: 'codex' },
  
  // CLAUDE - for comparison
  { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6', input: 3.00, output: 15.00, cache: 0.30, category: 'claude' },
  { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', input: 1.00, output: 5.00, cache: 0.10, category: 'claude' },
  
  // GEMINI
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash', input: 0.50, output: 3.00, cache: 0.05, category: 'gemini' },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', input: 2.00, output: 12.00, cache: 0.20, category: 'gemini' },
  
  // CODING SPECIALISTS
  { id: 'qwen3-coder-480b', name: 'Qwen3 Coder 480B', input: 0.45, output: 1.50, category: 'coder' },
  { id: 'kimi-k2.5', name: 'Kimi K2.5', input: 0.60, output: 3.00, cache: 0.08, category: 'kimi' },
  
  // CHEAP OPTIONS
  { id: 'minimax-m2.5', name: 'MiniMax M2.5', input: 0.30, output: 1.20, cache: 0.06, category: 'cheap' },
  { id: 'glm-4.7', name: 'GLM 4.7', input: 0.60, output: 2.20, cache: 0.10, category: 'cheap' }
];

const results = [];

async function testOpenCodeModel(model) {
  const start = Date.now();
  try {
    const key = process.env.OPENCODE_API_KEY;
    if (!key) throw new Error('OPENCODE_API_KEY not set');

    const res = await fetch('https://api.opencode.dev/v1/chat/completions', {
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
      category: model.category,
      success: true,
      timeMs: Date.now() - start,
      hasCode: data.choices[0].message.content.includes('function') || data.choices[0].message.content.includes('def') || data.choices[0].message.content.includes('=>'),
      responseLength: data.choices[0].message.content.length,
      response: data.choices[0].message.content,
      tokens: { input: data.usage?.prompt_tokens, output: data.usage?.completion_tokens },
      cost: cost,
      pricing: { input: model.input, output: model.output, cache: model.cache }
    };
  } catch (err) {
    return { 
      model: model.name, 
      modelId: model.id,
      category: model.category,
      success: false, 
      error: err.message, 
      timeMs: Date.now() - start,
      pricing: { input: model.input, output: model.output, cache: model.cache }
    };
  }
}

async function runTests() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║           OPENCODE API MODEL TEST SUITE                      ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log('Test prompt:', TEST_PROMPT, '\n');

  // Test by category
  const categories = ['free', 'codex', 'claude', 'gemini', 'coder', 'cheap', 'kimi'];
  
  for (const category of categories) {
    const models = OPENCODE_MODELS.filter(m => m.category === category);
    if (models.length === 0) continue;
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`${category.toUpperCase()} MODELS`);
    console.log('='.repeat(60));
    
    for (const model of models) {
      console.log(`\nTesting ${model.name}...`);
      const result = await testOpenCodeModel(model);
      results.push(result);
      printResult(result);
      await sleep(1500);
    }
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
    console.log(`     Response: ${result.response.substring(0, 150)}...`);
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
    console.log('| Model | Time | Cost | Price (in/out) | Category |');
    console.log('|-------|------|------|----------------|----------|');
    successful.forEach(r => {
      console.log(`| ${r.model.padEnd(25)} | ${r.timeMs}ms | $${r.cost.toFixed(6)} | $${r.pricing.input}/$${r.pricing.output} | ${r.category} |`);
    });
  }

  if (failed.length > 0) {
    console.log(`\n\n❌ FAILED: ${failed.length}/${results.length} models\n`);
    failed.forEach(r => {
      console.log(`   ${r.model.padEnd(30)} ${r.error}`);
    });
  }

  if (successful.length > 0) {
    console.log('\n\n📊 PERFORMANCE RANKINGS:\n');

    console.log('🏃 FASTEST:');
    const bySpeed = [...successful].sort((a, b) => a.timeMs - b.timeMs);
    bySpeed.slice(0, 3).forEach((r, i) => {
      console.log(`  ${i+1}. ${r.model.padEnd(30)} ${r.timeMs}ms`);
    });

    console.log('\n💰 CHEAPEST:');
    const byCost = [...successful].sort((a, b) => a.cost - b.cost);
    byCost.slice(0, 5).forEach((r, i) => {
      console.log(`  ${i+1}. ${r.model.padEnd(30)} $${r.cost.toFixed(6)}`);
    });

    console.log('\n💎 BEST VALUE (speed/cost ratio):');
    const byValue = [...successful].map(r => ({
      ...r,
      value: r.timeMs / (r.cost || 0.000001) // lower is better
    })).sort((a, b) => a.value - b.value);
    byValue.slice(0, 3).forEach((r, i) => {
      console.log(`  ${i+1}. ${r.model.padEnd(30)} ${r.timeMs}ms @ $${r.cost.toFixed(6)}`);
    });

    // Category winners
    console.log('\n\n🏆 CATEGORY WINNERS:\n');
    const categories = ['free', 'codex', 'claude', 'coder', 'cheap'];
    categories.forEach(cat => {
      const catModels = successful.filter(r => r.category === cat);
      if (catModels.length > 0) {
        const winner = catModels.sort((a, b) => a.timeMs - b.timeMs)[0];
        console.log(`  ${cat.toUpperCase()}: ${winner.model}`);
        console.log(`     → ${winner.timeMs}ms, $${winner.cost.toFixed(6)}, ${winner.tokens.input}→${winner.tokens.output} tokens`);
      }
    });

    console.log('\n\n💡 CREWSWARM STACK RECOMMENDATIONS:\n');

    const freeModels = successful.filter(r => r.category === 'free' && r.hasCode);
    const codexModels = successful.filter(r => r.category === 'codex');
    const cheapModels = successful.filter(r => ['cheap', 'coder'].includes(r.category));

    console.log('🆓 FREE TIER (for development/testing):');
    if (freeModels.length > 0) {
      const bestFree = freeModels.sort((a, b) => a.timeMs - b.timeMs)[0];
      console.log(`   L1/L2/L3: ${bestFree.model} - ${bestFree.timeMs}ms, FREE!`);
    } else {
      console.log('   ⚠️  No free models working');
    }

    console.log('\n💰 BUDGET TIER (cheapest that works):');
    if (cheapModels.length > 0) {
      const bestCheap = cheapModels.sort((a, b) => a.cost - b.cost)[0];
      console.log(`   L1/L3: ${bestCheap.model}`);
      console.log(`      → ${bestCheap.timeMs}ms, $${bestCheap.cost.toFixed(6)} per request`);
    }

    console.log('\n🚀 QUALITY TIER (best coding models):');
    if (codexModels.length > 0) {
      const bestCodex = codexModels.sort((a, b) => a.cost - b.cost)[0]; // cheapest codex
      const topCodex = codexModels.find(r => r.modelId === 'gpt-5.3-codex');
      
      if (topCodex && topCodex.success) {
        console.log(`   L2 (Reasoning): ${topCodex.model}`);
        console.log(`      → ${topCodex.timeMs}ms, $${topCodex.cost.toFixed(6)} per request`);
      }
      
      console.log(`   L3 (Execution): ${bestCodex.model}`);
      console.log(`      → ${bestCodex.timeMs}ms, $${bestCodex.cost.toFixed(6)} per request`);
    }

    console.log('\n\n🆚 COMPARISON VS GROQ:\n');
    console.log('  Groq Llama 3.1 8B: 243ms, $0.000010');
    const fastest = bySpeed[0];
    const cheapest = byCost[0];
    
    if (fastest.timeMs < 243) {
      console.log(`  ✅ OpenCode ${fastest.model} is ${(243 - fastest.timeMs)}ms FASTER`);
    } else {
      console.log(`  ⚠️  Groq is ${(fastest.timeMs - 243)}ms faster than ${fastest.model}`);
    }
    
    if (cheapest.cost < 0.000010) {
      console.log(`  ✅ OpenCode ${cheapest.model} is ${((0.000010 - cheapest.cost) / 0.000010 * 100).toFixed(1)}% CHEAPER`);
    } else if (cheapest.cost === 0) {
      console.log(`  🎉 OpenCode ${cheapest.model} is FREE!`);
    } else {
      console.log(`  ⚠️  Groq is ${((cheapest.cost - 0.000010) / 0.000010 * 100).toFixed(1)}% cheaper than ${cheapest.model}`);
    }

    // Code quality comparison
    console.log('\n\n📝 CODE QUALITY ANALYSIS:\n');
    successful.slice(0, 3).forEach(r => {
      console.log(`\n${r.model}:`);
      console.log(r.response.substring(0, 300));
      console.log('...\n');
    });
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

runTests().catch(console.error);
