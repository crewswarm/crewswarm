#!/usr/bin/env node
/**
 * 3-Tier Pipeline vs Direct LLM Comparison
 * Tests the same tasks through both paths to compare cost, time, and quality
 * 
 * Usage: node scripts/compare-pipeline.mjs
 */

// Note: This script uses the CrewSwarm CLI's UnifiedPipeline
// It can't import from src/ directly in .mjs, so it provides instructions

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║     3-TIER PIPELINE BENCHMARK (vs Direct LLM Baseline)      ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

console.log('⚠️  This benchmark requires testing through the REPL\n');
console.log('STEP 1: Run direct LLM baseline');
console.log('  $ node scripts/test-direct-llm.mjs\n');

console.log('STEP 2: Configure your 3-tier stack');
console.log('  $ export CREW_USE_UNIFIED_ROUTER="true"');
console.log('  $ export CREW_DUAL_L2_ENABLED="true"');
console.log('  $ export CREW_CHAT_MODEL="groq-llama"         # Or your L1 choice');
console.log('  $ export CREW_REASONING_MODEL="groq-llama"    # Or your L2 choice');
console.log('  $ export CREW_EXECUTION_MODEL="groq-llama"    # Or your L3 choice\n');

console.log('STEP 3: Test in REPL with timing');
console.log('  $ crew repl --mode builder\n');

console.log('Run these tasks and compare with baseline:\n');

const TASKS = [
  {
    level: 'simple',
    task: 'What is the best way to handle authentication in a REST API?',
    expected: 'Should route to L2 direct-answer'
  },
  {
    level: 'medium',
    task: 'Write a Node.js function that validates JWT tokens with proper error handling',
    expected: 'Should route to L2 → L3 single executor'
  },
  {
    level: 'complex',
    task: 'Create a roadmap for building an authentication system with user registration, login, JWT tokens, password reset, and email verification',
    expected: 'Should route to L2 → L2A → L2B → L3 parallel'
  }
];

TASKS.forEach((t, i) => {
  console.log(`${i + 1}. ${t.level.toUpperCase()}`);
  console.log(`   Task: "${t.task}"`);
  console.log(`   crew(builder)> ${t.task}`);
  console.log(`   crew(builder)> /trace     # Check execution path`);
  console.log(`   Expected: ${t.expected}\n`);
});

console.log('STEP 4: Compare Results\n');
console.log('Metrics to compare:');
console.log('  • Time: Direct LLM vs Pipeline execution time');
console.log('  • Cost: Direct LLM cost vs Pipeline cost (L2 + L3)');
console.log('  • Path: Direct call vs L1→L2→L3 path');
console.log('  • Quality: Response completeness and accuracy\n');

console.log('Expected Results:');
console.log('  Simple:  Pipeline overhead ~$0.0001, time +500ms (routing cost)');
console.log('  Medium:  Pipeline overhead ~$0.003, time similar (single executor)');
console.log('  Complex: Pipeline SAVES money/time (parallel execution)\n');

console.log('💡 TIP: Use /trace to see full breakdown of LLM calls\n');

// If we could import the UnifiedPipeline, we'd do:
/*
import { UnifiedPipeline } from '../dist/pipeline/unified.js';

const pipeline = new UnifiedPipeline();

for (const task of TASKS) {
  console.log(`\n📊 Testing: ${task.level}`);
  const start = Date.now();
  
  const result = await pipeline.execute({
    userInput: task.task,
    context: 'Benchmark test',
    sessionId: 'benchmark-' + Date.now()
  });
  
  console.log(`  Path: ${result.executionPath.join(' → ')}`);
  console.log(`  Cost: $${result.totalCost.toFixed(4)}`);
  console.log(`  Time: ${Date.now() - start}ms`);
}
*/

console.log('═══════════════════════════════════════════════════════════════');
console.log('For automated testing, use the REPL programmatically or');
console.log('see TESTING-GUIDE.md for full benchmark procedures.');
console.log('═══════════════════════════════════════════════════════════════\n');
