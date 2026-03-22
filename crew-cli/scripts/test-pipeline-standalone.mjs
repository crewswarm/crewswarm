#!/usr/bin/env node --import=tsx
/**
 * Standalone 3-Tier Pipeline Benchmark
 * Tests UnifiedPipeline programmatically and compares with direct LLM baseline
 * 
 * Usage: node --import=tsx scripts/test-pipeline-standalone.mjs
 */

import { UnifiedPipeline } from '../src/pipeline/unified.js';
import { randomUUID } from 'crypto';

const TASKS = [
  {
    level: 'simple',
    task: 'What is the best way to handle authentication in a REST API?',
    expectedPath: 'l1-interface → l2-orchestrator → l2-direct-response'
  },
  {
    level: 'medium',
    task: 'Write a Node.js function that validates JWT tokens with proper error handling',
    expectedPath: 'l1-interface → l2-orchestrator → l3-executor-single'
  },
  {
    level: 'complex',
    task: 'Create a roadmap for building an authentication system with user registration, login, JWT tokens, password reset, and email verification',
    expectedPath: 'l1-interface → l2-orchestrator → l3-executor-parallel'
  }
];

async function runPipelineBenchmark() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║      3-TIER PIPELINE STANDALONE BENCHMARK                    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // Check configuration
  const config = {
    unifiedRouter: process.env.CREW_USE_UNIFIED_ROUTER === 'true',
    dualL2: process.env.CREW_DUAL_L2_ENABLED === 'true',
    chatModel: process.env.CREW_CHAT_MODEL || 'auto',
    reasoningModel: process.env.CREW_REASONING_MODEL || 'auto',
    executionModel: process.env.CREW_EXECUTION_MODEL || 'auto'
  };

  console.log('Configuration:');
  console.log(`  Unified Router: ${config.unifiedRouter}`);
  console.log(`  Dual-L2 Planning: ${config.dualL2}`);
  console.log(`  Chat Model: ${config.chatModel}`);
  console.log(`  Reasoning Model: ${config.reasoningModel}`);
  console.log(`  Execution Model: ${config.executionModel}\n`);

  if (!config.unifiedRouter) {
    console.log('⚠️  CREW_USE_UNIFIED_ROUTER not enabled');
    console.log('   Set: export CREW_USE_UNIFIED_ROUTER="true"\n');
  }

  const pipeline = new UnifiedPipeline();
  const results = [];

  for (const task of TASKS) {
    console.log(`\n${'═'.repeat(66)}`);
    console.log(`📊 ${task.level.toUpperCase()}: "${task.task.substring(0, 45)}..."`);
    console.log('─'.repeat(66));

    const startTime = Date.now();

    try {
      const result = await pipeline.execute({
        userInput: task.task,
        context: `Benchmark test: ${task.level}`,
        sessionId: `bench-${randomUUID()}`
      });

      const executionTime = Date.now() - startTime;

      results.push({
        level: task.level,
        success: true,
        path: result.executionPath.join(' → '),
        expectedPath: task.expectedPath,
        cost: result.totalCost,
        timeMs: executionTime,
        traceId: result.traceId
      });

      console.log(`  ✓ Success`);
      console.log(`  Path: ${result.executionPath.join(' → ')}`);
      console.log(`  Expected: ${task.expectedPath}`);
      console.log(`  Match: ${result.executionPath.join(' → ').includes('l2-orchestrator') ? '✓' : '✗'}`);
      console.log(`  Cost: $${result.totalCost.toFixed(4)}`);
      console.log(`  Time: ${executionTime}ms`);
      console.log(`  Trace ID: ${result.traceId}`);

    } catch (err) {
      const executionTime = Date.now() - startTime;

      results.push({
        level: task.level,
        success: false,
        error: err.message,
        timeMs: executionTime
      });

      console.log(`  ✗ Failed: ${err.message}`);
      console.log(`  Time: ${executionTime}ms`);
    }

    // Rate limit pause
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // Print summary
  console.log('\n\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                    PIPELINE SUMMARY                          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  if (successful.length > 0) {
    console.log(`✅ Successful: ${successful.length}/${results.length}\n`);

    const totalCost = successful.reduce((sum, r) => sum + r.cost, 0);
    const avgTime = Math.round(successful.reduce((sum, r) => sum + r.timeMs, 0) / successful.length);

    console.log(`  Total Cost: $${totalCost.toFixed(4)}`);
    console.log(`  Avg Time: ${avgTime}ms\n`);

    console.log('  By Level:');
    for (const level of ['simple', 'medium', 'complex']) {
      const levelResult = successful.find(r => r.level === level);
      if (levelResult) {
        console.log(`    ${level.padEnd(8)}: $${levelResult.cost.toFixed(4)} | ${levelResult.timeMs}ms`);
      }
    }
  }

  if (failed.length > 0) {
    console.log(`\n❌ Failed: ${failed.length}/${results.length}\n`);
    failed.forEach(f => {
      console.log(`  ${f.level}: ${f.error}`);
    });
  }

  console.log('\n\n💡 COMPARISON WITH DIRECT LLM BASELINE:\n');
  console.log('  Run direct baseline: node scripts/test-direct-llm.mjs');
  console.log('  Then compare:');
  console.log('    • Cost: Pipeline overhead = L2 routing + L3 execution');
  console.log('    • Time: Pipeline may be faster for complex tasks (parallel)');
  console.log('    • Control: Pipeline has cost/risk gates, trace, approval flows\n');
}

runPipelineBenchmark().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
