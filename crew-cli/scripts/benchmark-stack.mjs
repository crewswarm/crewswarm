#!/usr/bin/env node
/**
 * 3-Tier Stack Benchmark
 * Tests Gemini, Grok, DeepSeek, Groq, and OpenCode routing through the pipeline
 * 
 * Usage: node scripts/benchmark-stack.mjs
 */

const TASK = 'Write a Node.js function to validate JWT tokens with error handling';

// Provider configurations
const STACK_CONFIGS = [
  {
    name: 'Gemini Stack (Free)',
    env: {
      CREW_CHAT_MODEL: 'gemini-flash',
      CREW_REASONING_MODEL: 'gemini-flash',
      CREW_EXECUTION_MODEL: 'gemini-flash'
    },
    estimatedCost: 0.0
  },
  {
    name: 'Grok Stack',
    env: {
      CREW_CHAT_MODEL: 'grok-beta',
      CREW_REASONING_MODEL: 'grok-beta',
      CREW_EXECUTION_MODEL: 'grok-beta'
    },
    estimatedCost: 0.01
  },
  {
    name: 'DeepSeek Stack',
    env: {
      CREW_CHAT_MODEL: 'deepseek-chat',
      CREW_REASONING_MODEL: 'deepseek-reasoner',
      CREW_EXECUTION_MODEL: 'deepseek-chat'
    },
    estimatedCost: 0.005
  },
  {
    name: 'Groq Stack (Fast)',
    env: {
      CREW_CHAT_MODEL: 'groq/llama-3.1-8b-instant',
      CREW_REASONING_MODEL: 'groq/llama-3.3-70b-versatile',
      CREW_EXECUTION_MODEL: 'groq/llama-3.1-8b-instant'
    },
    estimatedCost: 0.002
  },
  {
    name: 'Hybrid Stack (Recommended)',
    env: {
      CREW_CHAT_MODEL: 'groq/llama-3.1-8b-instant',
      CREW_REASONING_MODEL: 'deepseek-reasoner',
      CREW_EXECUTION_MODEL: 'gemini-flash'
    },
    estimatedCost: 0.001
  }
];

const results = [];

async function testStack(config) {
  const start = Date.now();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing: ${config.name}`);
  console.log('='.repeat(60));
  console.log(`Chat: ${config.env.CREW_CHAT_MODEL}`);
  console.log(`Reasoning: ${config.env.CREW_REASONING_MODEL}`);
  console.log(`Execution: ${config.env.CREW_EXECUTION_MODEL}`);
  console.log('');

  try {
    // Set environment
    Object.assign(process.env, config.env);
    process.env.CREW_USE_UNIFIED_ROUTER = 'true';

    // Import and run pipeline
    const { UnifiedPipeline } = await import('../dist/pipeline/unified.js');
    const pipeline = new UnifiedPipeline({
      chatModel: config.env.CREW_CHAT_MODEL,
      reasoningModel: config.env.CREW_REASONING_MODEL,
      executionModel: config.env.CREW_EXECUTION_MODEL
    });

    const result = await pipeline.execute(TASK);
    
    const timeMs = Date.now() - start;
    
    console.log(`\n✅ SUCCESS`);
    console.log(`   Time: ${timeMs}ms`);
    console.log(`   Estimated cost: $${config.estimatedCost.toFixed(6)}`);
    console.log(`   Output length: ${result.content?.length || 0} chars`);
    console.log(`   Has code: ${result.content?.includes('function') || result.content?.includes('const') ? 'YES' : 'NO'}`);
    
    return {
      name: config.name,
      success: true,
      timeMs,
      estimatedCost: config.estimatedCost,
      hasCode: result.content?.includes('function') || result.content?.includes('const'),
      outputLength: result.content?.length || 0
    };
  } catch (err) {
    const timeMs = Date.now() - start;
    console.log(`\n❌ FAILED: ${err.message}`);
    
    return {
      name: config.name,
      success: false,
      timeMs,
      estimatedCost: config.estimatedCost,
      error: err.message
    };
  }
}

async function run() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║          3-TIER STACK BENCHMARK (Pipeline Test)             ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log(`Task: "${TASK}"\n`);
  console.log('This will test different model combinations through the unified pipeline.\n');

  // Check if build exists
  try {
    await import('../dist/pipeline/unified.js');
  } catch (err) {
    console.log('❌ Pipeline not built. Run: npm run build');
    process.exit(1);
  }

  for (const config of STACK_CONFIGS) {
    const result = await testStack(config);
    results.push(result);
    await new Promise(r => setTimeout(r, 2000));
  }

  printSummary();
}

function printSummary() {
  console.log('\n\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                    BENCHMARK SUMMARY                         ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  if (successful.length > 0) {
    console.log(`✅ WORKING: ${successful.length}/${results.length} stacks\n`);
    console.log('| Stack | Time | Est. Cost | Has Code |');
    console.log('|-------|------|-----------|----------|');
    successful.forEach(r => {
      console.log(`| ${r.name.padEnd(30)} | ${r.timeMs}ms | $${r.estimatedCost.toFixed(6)} | ${r.hasCode ? 'YES' : 'NO'} |`);
    });

    console.log('\n\n📊 RANKINGS:\n');

    console.log('🏃 FASTEST:');
    const bySpeed = [...successful].sort((a, b) => a.timeMs - b.timeMs);
    bySpeed.slice(0, 3).forEach((r, i) => {
      console.log(`  ${i+1}. ${r.name.padEnd(35)} ${r.timeMs}ms`);
    });

    console.log('\n💰 CHEAPEST:');
    const byCost = [...successful].sort((a, b) => a.estimatedCost - b.estimatedCost);
    byCost.slice(0, 3).forEach((r, i) => {
      console.log(`  ${i+1}. ${r.name.padEnd(35)} $${r.estimatedCost.toFixed(6)}`);
    });

    console.log('\n💎 BEST VALUE (speed + cost):');
    const byValue = [...successful].map(r => ({
      ...r,
      value: (r.timeMs / 1000) * (r.estimatedCost * 10000) // normalized score
    })).sort((a, b) => a.value - b.value);
    byValue.slice(0, 3).forEach((r, i) => {
      console.log(`  ${i+1}. ${r.name.padEnd(35)} ${r.timeMs}ms @ $${r.estimatedCost.toFixed(6)}`);
    });
  }

  if (failed.length > 0) {
    console.log(`\n\n❌ FAILED: ${failed.length}/${results.length} stacks\n`);
    failed.forEach(r => {
      console.log(`   ${r.name.padEnd(35)} ${r.error}`);
    });
  }

  console.log('\n\n💡 NEXT STEPS:\n');
  console.log('1. Set your preferred stack with environment variables:');
  console.log('   export CREW_CHAT_MODEL="groq/llama-3.1-8b-instant"');
  console.log('   export CREW_REASONING_MODEL="deepseek-reasoner"');
  console.log('   export CREW_EXECUTION_MODEL="gemini-flash"');
  console.log('');
  console.log('2. Test in REPL:');
  console.log('   ./bin/crew repl --mode builder');
  console.log('   > write a JWT validator');
  console.log('   > /trace');
  console.log('');
  console.log('3. Compare with direct LLM baseline:');
  console.log('   node scripts/test-direct-llm.mjs');
}

run().catch(console.error);
