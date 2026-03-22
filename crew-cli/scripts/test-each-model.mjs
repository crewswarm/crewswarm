#!/usr/bin/env node
/**
 * Individual Model Test Suite
 * Tests each model one-by-one to verify they work
 * 
 * Usage: node scripts/test-each-model.mjs
 */

const TEST_PROMPT = "Write a simple function to validate an email address. Just show the function, no explanation.";

// Test results storage
const results = [];

// Test Gemini Models
async function testGeminiFlashLite() {
  const start = Date.now();
  try {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY not set');

    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=' + key, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: TEST_PROMPT }] }]
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || res.statusText);

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    return {
      model: 'gemini-2.5-flash-lite',
      success: true,
      timeMs: Date.now() - start,
      hasCode: text.includes('function') || text.includes('def') || text.includes('=>'),
      responseLength: text.length
    };
  } catch (err) {
    return { model: 'gemini-2.5-flash-lite', success: false, error: err.message, timeMs: Date.now() - start };
  }
}

async function testGeminiFlash() {
  const start = Date.now();
  try {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY not set');

    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + key, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: TEST_PROMPT }] }]
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || res.statusText);

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    return {
      model: 'gemini-2.5-flash',
      success: true,
      timeMs: Date.now() - start,
      hasCode: text.includes('function') || text.includes('def') || text.includes('=>'),
      responseLength: text.length
    };
  } catch (err) {
    return { model: 'gemini-2.5-flash', success: false, error: err.message, timeMs: Date.now() - start };
  }
}

async function testGemini31ProPreview() {
  const start = Date.now();
  try {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY not set');

    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=' + key, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: TEST_PROMPT }] }]
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || res.statusText);

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    return {
      model: 'gemini-3.1-pro-preview',
      success: true,
      timeMs: Date.now() - start,
      hasCode: text.includes('function') || text.includes('def') || text.includes('=>'),
      responseLength: text.length
    };
  } catch (err) {
    return { model: 'gemini-3.1-pro-preview', success: false, error: err.message, timeMs: Date.now() - start };
  }
}

// Test Grok Models
async function testGrok41FastReasoning() {
  const start = Date.now();
  try {
    const key = process.env.XAI_API_KEY;
    if (!key) throw new Error('XAI_API_KEY not set');

    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: 'grok-4-1-fast-reasoning',
        messages: [{ role: 'user', content: TEST_PROMPT }]
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || res.statusText);
    
    return {
      model: 'grok-4-1-fast-reasoning',
      success: true,
      timeMs: Date.now() - start,
      hasCode: data.choices[0].message.content.includes('function') || data.choices[0].message.content.includes('def'),
      responseLength: data.choices[0].message.content.length,
      tokens: `${data.usage?.prompt_tokens}→${data.usage?.completion_tokens}`
    };
  } catch (err) {
    return { model: 'grok-4-1-fast-reasoning', success: false, error: err.message, timeMs: Date.now() - start };
  }
}

async function testGrokCodeFast() {
  const start = Date.now();
  try {
    const key = process.env.XAI_API_KEY;
    if (!key) throw new Error('XAI_API_KEY not set');

    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: 'grok-code-fast-1',
        messages: [{ role: 'user', content: TEST_PROMPT }]
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || res.statusText);
    
    return {
      model: 'grok-code-fast-1',
      success: true,
      timeMs: Date.now() - start,
      hasCode: data.choices[0].message.content.includes('function') || data.choices[0].message.content.includes('def'),
      responseLength: data.choices[0].message.content.length,
      tokens: `${data.usage?.prompt_tokens}→${data.usage?.completion_tokens}`
    };
  } catch (err) {
    return { model: 'grok-code-fast-1', success: false, error: err.message, timeMs: Date.now() - start };
  }
}

// Test DeepSeek Models
async function testDeepSeekChat() {
  const start = Date.now();
  try {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) throw new Error('DEEPSEEK_API_KEY not set');

    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: TEST_PROMPT }]
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || res.statusText);

    return {
      model: 'deepseek-chat',
      success: true,
      timeMs: Date.now() - start,
      hasCode: data.choices[0].message.content.includes('function') || data.choices[0].message.content.includes('def'),
      responseLength: data.choices[0].message.content.length,
      tokens: `${data.usage?.prompt_tokens}→${data.usage?.completion_tokens}`
    };
  } catch (err) {
    return { model: 'deepseek-chat', success: false, error: err.message, timeMs: Date.now() - start };
  }
}

async function testDeepSeekReasoner() {
  const start = Date.now();
  try {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) throw new Error('DEEPSEEK_API_KEY not set');

    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: 'deepseek-reasoner',
        messages: [{ role: 'user', content: TEST_PROMPT }]
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || res.statusText);

    return {
      model: 'deepseek-reasoner',
      success: true,
      timeMs: Date.now() - start,
      hasCode: data.choices[0].message.content.includes('function') || data.choices[0].message.content.includes('def'),
      responseLength: data.choices[0].message.content.length,
      tokens: `${data.usage?.prompt_tokens}→${data.usage?.completion_tokens}`,
      hasReasoning: data.choices[0].message.reasoning_content ? 'YES' : 'NO'
    };
  } catch (err) {
    return { model: 'deepseek-reasoner', success: false, error: err.message, timeMs: Date.now() - start };
  }
}

async function runTests() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║        INDIVIDUAL MODEL TEST - ONE BY ONE                    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log('Test prompt:', TEST_PROMPT.substring(0, 60) + '...\n');

  // Test Gemini models
  console.log('\n🔷 GEMINI MODELS\n');
  
  console.log('Testing gemini-2.5-flash-lite...');
  const geminiLite = await testGeminiFlashLite();
  results.push(geminiLite);
  printResult(geminiLite);
  await sleep(2000);

  console.log('\nTesting gemini-2.5-flash...');
  const geminiFlash = await testGeminiFlash();
  results.push(geminiFlash);
  printResult(geminiFlash);
  await sleep(2000);

  console.log('\nTesting gemini-3.1-pro-preview...');
  const geminiPro = await testGemini31ProPreview();
  results.push(geminiPro);
  printResult(geminiPro);
  await sleep(2000);

  // Test Grok models
  console.log('\n\n🟣 GROK MODELS\n');
  
  console.log('Testing grok-4-1-fast-reasoning...');
  const grok41 = await testGrok41FastReasoning();
  results.push(grok41);
  printResult(grok41);
  await sleep(2000);

  console.log('\nTesting grok-code-fast-1...');
  const grokCode = await testGrokCodeFast();
  results.push(grokCode);
  printResult(grokCode);
  await sleep(2000);

  // Test DeepSeek models
  console.log('\n\n🔵 DEEPSEEK MODELS\n');
  
  console.log('Testing deepseek-chat...');
  const dsChat = await testDeepSeekChat();
  results.push(dsChat);
  printResult(dsChat);
  await sleep(2000);

  console.log('\nTesting deepseek-reasoner...');
  const dsReasoner = await testDeepSeekReasoner();
  results.push(dsReasoner);
  printResult(dsReasoner);

  // Print summary
  printSummary();
}

function printResult(result) {
  if (result.success) {
    console.log(`  ✅ SUCCESS`);
    console.log(`     Time: ${result.timeMs}ms`);
    console.log(`     Has code: ${result.hasCode ? 'YES' : 'NO'}`);
    console.log(`     Response length: ${result.responseLength} chars`);
    if (result.tokens) console.log(`     Tokens: ${result.tokens}`);
    if (result.hasReasoning) console.log(`     Reasoning: ${result.hasReasoning}`);
  } else {
    console.log(`  ❌ FAILED: ${result.error}`);
    console.log(`     Time: ${result.timeMs}ms`);
  }
}

function printSummary() {
  console.log('\n\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                       SUMMARY                                ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  console.log(`✅ WORKING: ${successful.length}/${results.length} models\n`);
  successful.forEach(r => {
    console.log(`   ${r.model.padEnd(30)} ${r.timeMs}ms`);
  });

  if (failed.length > 0) {
    console.log(`\n❌ FAILED: ${failed.length}/${results.length} models\n`);
    failed.forEach(r => {
      console.log(`   ${r.model.padEnd(30)} ${r.error}`);
    });
  }

  console.log('\n\n📊 PERFORMANCE COMPARISON (successful models only):\n');
  const sorted = [...successful].sort((a, b) => a.timeMs - b.timeMs);
  console.log('  Fastest:');
  sorted.slice(0, 3).forEach((r, i) => {
    console.log(`    ${i+1}. ${r.model.padEnd(30)} ${r.timeMs}ms`);
  });

  console.log('\n💡 RECOMMENDED STACK:\n');
  const cheapest = successful.find(r => r.model === 'gemini-2.5-flash-lite');
  const bestReasoner = successful.find(r => r.model === 'deepseek-reasoner');
  const grokTools = successful.find(r => r.model === 'grok-4-1-fast-reasoning');

  if (cheapest) console.log(`  L1 (Chat): ${cheapest.model} - ${cheapest.timeMs}ms`);
  if (bestReasoner) console.log(`  L2 (Reasoning): ${bestReasoner.model} - ${bestReasoner.timeMs}ms`);
  if (cheapest) console.log(`  L3 (Execution): ${cheapest.model} - ${cheapest.timeMs}ms`);
  if (grokTools) console.log(`\n  Alternative L2 (with X-search): ${grokTools.model} - ${grokTools.timeMs}ms`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

runTests().catch(console.error);
