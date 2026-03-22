#!/usr/bin/env node
/**
 * Direct LLM Test - Baseline performance
 * Tests Grok (x.ai), Gemini (Google), and DeepSeek directly (no 3-tier pipeline)
 * 
 * Usage: node scripts/test-direct-llm.mjs
 */

const TASKS = {
  simple: 'What is the best way to handle authentication in a REST API?',
  medium: 'Write a Node.js function that validates JWT tokens with proper error handling',
  complex: 'Create a roadmap for building an authentication system with user registration, login, JWT tokens, password reset, and email verification'
};

const PRICING = {
  'grok-3': { input: 5.0, output: 15.0 },
  'gemini-2.5-flash': { input: 0.0, output: 0.0 },
  'deepseek-chat': { input: 0.14, output: 0.28 },
  'llama-3.1-8b-instant': { input: 0.05, output: 0.08 }
};

function calcCost(model, promptTok, completionTok) {
  const p = PRICING[model];
  if (!p) return 0;
  return (promptTok / 1_000_000) * p.input + (completionTok / 1_000_000) * p.output;
}

async function testGrok(task) {
  const start = Date.now();
  try {
    const key = process.env.XAI_API_KEY;
    if (!key) return { provider: 'Grok (x.ai)', timeMs: Date.now() - start, success: false, error: 'XAI_API_KEY not set (skipped)', skipped: true };

    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: 'grok-3',
        messages: [{ role: 'user', content: task }]
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || res.statusText);
    
    return {
      provider: 'Grok (x.ai)',
      cost: calcCost('grok-3', data.usage?.prompt_tokens || 0, data.usage?.completion_tokens || 0),
      timeMs: Date.now() - start,
      tokens: `${data.usage?.prompt_tokens || 0}→${data.usage?.completion_tokens || 0}`,
      success: true
    };
  } catch (err) {
    return { provider: 'Grok (x.ai)', timeMs: Date.now() - start, success: false, error: err.message };
  }
}

async function testGemini(task) {
  const start = Date.now();
  try {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return { provider: 'Gemini', timeMs: Date.now() - start, success: false, error: 'GEMINI_API_KEY not set (skipped)', skipped: true };

    // Use gemini-2.5-flash (latest stable model)
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: task }] }]
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || res.statusText);

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    return {
      provider: 'Gemini',
      cost: 0,
      timeMs: Date.now() - start,
      tokens: `${Math.ceil(task.length/4)}→${Math.ceil(text.length/4)}`,
      success: true
    };
  } catch (err) {
    return { provider: 'Gemini', timeMs: Date.now() - start, success: false, error: err.message };
  }
}

async function testDeepSeek(task) {
  const start = Date.now();
  try {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) return { provider: 'DeepSeek', timeMs: Date.now() - start, success: false, error: 'DEEPSEEK_API_KEY not set (skipped)', skipped: true };

    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: task }]
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || res.statusText);

    return {
      provider: 'DeepSeek',
      cost: calcCost('deepseek-chat', data.usage?.prompt_tokens || 0, data.usage?.completion_tokens || 0),
      timeMs: Date.now() - start,
      tokens: `${data.usage?.prompt_tokens || 0}→${data.usage?.completion_tokens || 0}`,
      success: true
    };
  } catch (err) {
    return { provider: 'DeepSeek', timeMs: Date.now() - start, success: false, error: err.message };
  }
}

async function testGroq(task) {
  const start = Date.now();
  try {
    const key = process.env.GROQ_API_KEY;
    if (!key) return { provider: 'Groq', timeMs: Date.now() - start, success: false, error: 'GROQ_API_KEY not set (skipped)', skipped: true };

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: task }]
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || res.statusText);

    return {
      provider: 'Groq',
      cost: calcCost('llama-3.1-8b-instant', data.usage?.prompt_tokens || 0, data.usage?.completion_tokens || 0),
      timeMs: Date.now() - start,
      tokens: `${data.usage?.prompt_tokens || 0}→${data.usage?.completion_tokens || 0}`,
      success: true
    };
  } catch (err) {
    return { provider: 'Groq', timeMs: Date.now() - start, success: false, error: err.message };
  }
}

async function run() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║        DIRECT LLM BASELINE TEST (No 3-Tier Pipeline)        ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log('PRIMARY TESTS: Grok (x.ai), Gemini, DeepSeek, Groq\n');

  const results = [];

  for (const [level, task] of Object.entries(TASKS)) {
    console.log(`\n📝 ${level.toUpperCase()}: "${task.substring(0, 50)}..."\n`);

    // PRIMARY TESTS: Grok, Gemini, DeepSeek, Groq
    for (const testFn of [testGrok, testGemini, testDeepSeek, testGroq]) {
      const result = await testFn(task);
      results.push({ ...result, level });

      if (result.success) {
        console.log(`  ✓ ${result.provider.padEnd(15)} ${result.timeMs}ms | $${result.cost.toFixed(4)} | ${result.tokens}`);
      } else {
        const symbol = result.skipped ? '⊘' : '✗';
        console.log(`  ${symbol} ${result.provider.padEnd(15)} ${result.error}`);
      }

      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.log('\n\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                       SUMMARY                                ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  for (const provider of ['Grok (x.ai)', 'Gemini', 'DeepSeek', 'Groq']) {
    const pResults = results.filter(r => r.provider === provider && r.success);
    const allResults = results.filter(r => r.provider === provider);
    const skipped = allResults.every(r => r.skipped);
    
    if (skipped) {
      console.log(`⊘ ${provider}: Skipped (API key not set)`);
      continue;
    }
    
    if (pResults.length === 0) {
      console.log(`❌ ${provider}: All tests failed`);
      const failed = results.find(r => r.provider === provider);
      if (failed) console.log(`   Error: ${failed.error}\n`);
      continue;
    }

    const totalCost = pResults.reduce((sum, r) => sum + r.cost, 0);
    const avgTime = Math.round(pResults.reduce((sum, r) => sum + r.timeMs, 0) / pResults.length);

    console.log(`✅ ${provider}`);
    console.log(`   Tests: ${pResults.length}/3 | Total cost: $${totalCost.toFixed(4)} | Avg time: ${avgTime}ms\n`);
  }

  console.log('\n💡 Set API keys to test all providers:');
  console.log('   export XAI_API_KEY="your-grok-key"');
  console.log('   export GEMINI_API_KEY="your-gemini-key"');  
  console.log('   export DEEPSEEK_API_KEY="your-deepseek-key"');
  console.log('   export GROQ_API_KEY="your-groq-key"');
  console.log('\n💡 Compare these results with 3-tier stack:');
  console.log('   Set your stack: export CREW_CHAT_MODEL="grok" CREW_REASONING_MODEL="deepseek" CREW_EXECUTION_MODEL="gemini"');
  console.log('   crew repl --mode builder');
  console.log('   > write a JWT validator');
  console.log('   > /trace');
}

run().catch(console.error);
