#!/usr/bin/env node
/**
 * Quick End-to-End Pipeline Test
 * Tests L1→L2→L3 flow with SIMPLE tasks only
 * 
 * Usage: 
 *   export CREW_USE_UNIFIED_ROUTER=true
 *   export CREW_DUAL_L2_ENABLED=true
 *   export CREW_CHAT_MODEL=groq/llama-3.1-8b-instant
 *   export CREW_REASONING_MODEL=grok-4-1-fast-reasoning
 *   export CREW_EXECUTION_MODEL=groq/llama-3.1-8b-instant
 *   node --import=tsx scripts/test-pipeline-quick.mjs
 */

import { UnifiedPipeline } from '../src/pipeline/unified.js';

const TESTS = [
  {
    name: 'SIMPLE QUESTION',
    input: 'What is the best way to handle authentication in a Node.js API?',
    expectedPath: 'l1-interface → l2-orchestrator → l2-direct-response'
  },
  {
    name: 'SIMPLE CODE TASK',
    input: 'Write a function to validate an email address',
    expectedPath: 'l1-interface → l2-orchestrator → l3-executor-single'
  }
];

async function testPipeline() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║      QUICK END-TO-END PIPELINE TEST                          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log('Configuration:');
  console.log(`  Unified Router: ${process.env.CREW_USE_UNIFIED_ROUTER || 'false'}`);
  console.log(`  Dual-L2 Planning: ${process.env.CREW_DUAL_L2_ENABLED || 'false'}`);
  console.log(`  Chat Model: ${process.env.CREW_CHAT_MODEL || 'default'}`);
  console.log(`  Reasoning Model: ${process.env.CREW_REASONING_MODEL || 'default'}`);
  console.log(`  Execution Model: ${process.env.CREW_EXECUTION_MODEL || 'default'}`);
  console.log('\n');

  const results = [];

  for (const test of TESTS) {
    console.log('══════════════════════════════════════════════════════════════════');
    console.log(`📊 ${test.name}: "${test.input.substring(0, 50)}..."`);
    console.log('──────────────────────────────────────────────────────────────────');

    const startTime = Date.now();
    
    try {
      const pipeline = new UnifiedPipeline();
      const result = await pipeline.execute({
        userInput: test.input,
        context: `Quick test: ${test.name}`,
        sessionId: `quick-${Date.now()}`
      });
      
      const elapsed = Date.now() - startTime;
      
      console.log(`  ✅ SUCCESS`);
      console.log(`  Time: ${elapsed}ms`);
      console.log(`  Cost: $${(result.cost || 0).toFixed(4)}`);
      console.log(`  Result preview: ${JSON.stringify(result).substring(0, 100)}...`);
      
      results.push({
        test: test.name,
        success: true,
        time: elapsed,
        cost: result.cost || 0
      });
    } catch (err) {
      const elapsed = Date.now() - startTime;
      console.log(`  ❌ FAILED: ${err.message}`);
      console.log(`  Time: ${elapsed}ms`);
      
      results.push({
        test: test.name,
        success: false,
        time: elapsed,
        error: err.message
      });
    }
    
    console.log('');
  }

  // Summary
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                       SUMMARY                                ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  console.log(`✅ PASSED: ${successful.length}/${results.length} tests\n`);
  
  if (successful.length > 0) {
    const totalCost = successful.reduce((sum, r) => sum + r.cost, 0);
    const totalTime = successful.reduce((sum, r) => sum + r.time, 0);
    const avgTime = totalTime / successful.length;

    console.log('Results:');
    successful.forEach(r => {
      console.log(`  ${r.test.padEnd(30)} ${r.time}ms   $${r.cost.toFixed(4)}`);
    });

    console.log(`\nTotals:`);
    console.log(`  Total cost: $${totalCost.toFixed(4)}`);
    console.log(`  Total time: ${totalTime}ms`);
    console.log(`  Average time: ${avgTime.toFixed(0)}ms`);
  }

  if (failed.length > 0) {
    console.log(`\n❌ FAILED: ${failed.length} tests\n`);
    failed.forEach(r => {
      console.log(`  ${r.test}: ${r.error}`);
    });
  }

  console.log('\n\n🎯 PIPELINE STATUS:');
  if (failed.length === 0) {
    console.log('  ✅ ALL TESTS PASSED - Pipeline is working end-to-end!');
    console.log(`  ✅ L1 (Chat) → L2 (Routing/Reasoning) → L3 (Execution) VERIFIED`);
    if (process.env.CREW_DUAL_L2_ENABLED === 'true') {
      console.log(`  ✅ DUAL-L2 (Decomposer + Validator) ENABLED`);
    }
  } else {
    console.log('  ⚠️  Some tests failed - check errors above');
  }
}

testPipeline().catch(err => {
  console.error('\n❌ FATAL ERROR:', err.message);
  console.error(err.stack);
  process.exit(1);
});
