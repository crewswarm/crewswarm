#!/usr/bin/env node --import=tsx
/**
 * Dual-L2 Comparison Benchmark
 * Compares performance with and without dual-L2 planning
 * 
 * Tests:
 * 1. Single L2 (router only) - fast, cheap, less planning
 * 2. Dual L2 (router + decomposer + validator) - slower, more cost, better planning
 * 
 * Usage: node --import=tsx scripts/compare-dual-l2.mjs
 */

// Note: UnifiedPipeline uses TypeScript, so we need tsx to import it
// This script should be run with: node --import=tsx scripts/compare-dual-l2.mjs
import { randomUUID } from 'crypto';

const TASKS = [
  {
    level: 'simple',
    task: 'What is JWT authentication?',
    expectedBenefit: 'None - dual-L2 is overkill for simple questions'
  },
  {
    level: 'medium',
    task: 'Write a Node.js function that validates JWT tokens',
    expectedBenefit: 'Minor - single task doesn\'t need decomposition'
  },
  {
    level: 'complex',
    task: 'Build a complete authentication system with user registration, login, JWT tokens, password reset, email verification, rate limiting, and security auditing',
    expectedBenefit: 'HIGH - complex task benefits from decomposition and validation'
  }
];

async function runComparison() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║          DUAL-L2 PLANNING COMPARISON BENCHMARK               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const results = [];

  for (const task of TASKS) {
    console.log(`\n${'═'.repeat(66)}`);
    console.log(`📊 ${task.level.toUpperCase()}: "${task.task.substring(0, 40)}..."`);
    console.log('─'.repeat(66));

    // Test 1: Single L2 (router only)
    console.log('\n  🔹 MODE 1: Single L2 (Router Only)');
    process.env.CREW_DUAL_L2_ENABLED = 'false';
    const singleL2Start = Date.now();
    
    try {
      const pipeline1 = new UnifiedPipeline();
      const result1 = await pipeline1.execute({
        userInput: task.task,
        context: `Benchmark: ${task.level}`,
        sessionId: `single-${randomUUID()}`
      });

      const singleL2Time = Date.now() - singleL2Start;

      results.push({
        task: task.level,
        mode: 'single-l2',
        success: true,
        path: result1.executionPath.join(' → '),
        cost: result1.totalCost,
        timeMs: singleL2Time,
        llmCalls: result1.executionPath.filter(p => p.includes('l2') || p.includes('l3')).length
      });

      console.log(`     Path: ${result1.executionPath.join(' → ')}`);
      console.log(`     LLM calls: ${results[results.length - 1].llmCalls}`);
      console.log(`     Cost: $${result1.totalCost.toFixed(4)}`);
      console.log(`     Time: ${singleL2Time}ms`);

    } catch (err) {
      results.push({
        task: task.level,
        mode: 'single-l2',
        success: false,
        error: err.message,
        timeMs: Date.now() - singleL2Start
      });
      console.log(`     ✗ Failed: ${err.message}`);
    }

    // Rate limit pause
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Test 2: Dual L2 (decomposer + validator)
    console.log('\n  🔹 MODE 2: Dual L2 (Router + Decomposer + Validator)');
    process.env.CREW_DUAL_L2_ENABLED = 'true';
    const dualL2Start = Date.now();
    
    try {
      const pipeline2 = new UnifiedPipeline();
      const result2 = await pipeline2.execute({
        userInput: task.task,
        context: `Benchmark: ${task.level}`,
        sessionId: `dual-${randomUUID()}`
      });

      const dualL2Time = Date.now() - dualL2Start;

      results.push({
        task: task.level,
        mode: 'dual-l2',
        success: true,
        path: result2.executionPath.join(' → '),
        cost: result2.totalCost,
        timeMs: dualL2Time,
        llmCalls: result2.executionPath.filter(p => p.includes('l2') || p.includes('l3')).length
      });

      console.log(`     Path: ${result2.executionPath.join(' → ')}`);
      console.log(`     LLM calls: ${results[results.length - 1].llmCalls}`);
      console.log(`     Cost: $${result2.totalCost.toFixed(4)}`);
      console.log(`     Time: ${dualL2Time}ms`);

    } catch (err) {
      results.push({
        task: task.level,
        mode: 'dual-l2',
        success: false,
        error: err.message,
        timeMs: Date.now() - dualL2Start
      });
      console.log(`     ✗ Failed: ${err.message}`);
    }

    // Compare
    const single = results.find(r => r.task === task.level && r.mode === 'single-l2' && r.success);
    const dual = results.find(r => r.task === task.level && r.mode === 'dual-l2' && r.success);

    if (single && dual) {
      console.log('\n  📊 COMPARISON:');
      console.log(`     Overhead: +$${(dual.cost - single.cost).toFixed(4)} | +${dual.timeMs - single.timeMs}ms`);
      console.log(`     Extra LLM calls: ${dual.llmCalls - single.llmCalls} (L2A + L2B)`);
      console.log(`     Worth it? ${task.expectedBenefit}`);
    }

    // Rate limit pause between tasks
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  // Print summary
  printSummary(results);
}

function printSummary(results) {
  console.log('\n\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                    DUAL-L2 SUMMARY                           ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const successful = results.filter(r => r.success);

  if (successful.length === 0) {
    console.log('❌ All tests failed\n');
    return;
  }

  console.log('By Task Level:\n');

  for (const level of ['simple', 'medium', 'complex']) {
    const single = successful.find(r => r.task === level && r.mode === 'single-l2');
    const dual = successful.find(r => r.task === level && r.mode === 'dual-l2');

    if (!single || !dual) continue;

    console.log(`  ${level.toUpperCase()}:`);
    console.log(`    Single L2: $${single.cost.toFixed(4)} | ${single.timeMs}ms | ${single.llmCalls} LLM calls`);
    console.log(`    Dual L2:   $${dual.cost.toFixed(4)} | ${dual.timeMs}ms | ${dual.llmCalls} LLM calls`);
    console.log(`    Overhead:  +$${(dual.cost - single.cost).toFixed(4)} | +${dual.timeMs - single.timeMs}ms | +${dual.llmCalls - single.llmCalls} calls\n`);
  }

  console.log('\n🎯 RECOMMENDATIONS:\n');
  console.log('  Simple tasks:  Use single-L2 (no benefit from planning)');
  console.log('  Medium tasks:  Use single-L2 (minor benefit, not worth overhead)');
  console.log('  Complex tasks: Use dual-L2 (decomposition + validation pays off)\n');

  console.log('  Smart mode: Enable dual-L2 only for complex/high-cost tasks');
  console.log('    export CREW_DUAL_L2_MODE="smart"  # Auto-enable based on complexity\n');

  const singleTotal = successful.filter(r => r.mode === 'single-l2').reduce((sum, r) => sum + r.cost, 0);
  const dualTotal = successful.filter(r => r.mode === 'dual-l2').reduce((sum, r) => sum + r.cost, 0);

  console.log(`  Total cost (all tasks):`);
  console.log(`    Single L2: $${singleTotal.toFixed(4)}`);
  console.log(`    Dual L2:   $${dualTotal.toFixed(4)}`);
  console.log(`    Overhead:  +$${(dualTotal - singleTotal).toFixed(4)} (+${((dualTotal / singleTotal - 1) * 100).toFixed(0)}%)\n`);
}

runComparison().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
