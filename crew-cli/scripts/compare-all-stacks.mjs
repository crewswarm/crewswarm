#!/usr/bin/env node
/**
 * Comprehensive Stack Comparison
 * Tests multiple model stacks end-to-end and compares code quality
 * 
 * Usage: node --import=tsx scripts/compare-all-stacks.mjs
 */

import { UnifiedPipeline } from '../src/pipeline/unified.js';

const TEST_TASK = "Write a Node.js function that validates JWT tokens with proper error handling";

const STACKS = [
  {
    name: 'Groq/Grok Stack (WINNER)',
    config: {
      CREW_CHAT_MODEL: 'groq/llama-3.1-8b-instant',
      CREW_REASONING_MODEL: 'grok-4-1-fast-reasoning',
      CREW_EXECUTION_MODEL: 'groq/llama-3.1-8b-instant'
    }
  },
  {
    name: 'Groq/Groq Stack (ALL GROQ)',
    config: {
      CREW_CHAT_MODEL: 'groq/llama-3.1-8b-instant',
      CREW_REASONING_MODEL: 'groq/llama-3.3-70b-versatile',
      CREW_EXECUTION_MODEL: 'groq/llama-3.1-8b-instant'
    }
  },
  {
    name: 'Gemini-Only Stack',
    config: {
      CREW_CHAT_MODEL: 'gemini-2.5-flash-lite',
      CREW_REASONING_MODEL: 'gemini-2.5-flash',
      CREW_EXECUTION_MODEL: 'gemini-2.5-flash-lite'
    }
  },
  {
    name: 'DeepSeek Stack',
    config: {
      CREW_CHAT_MODEL: 'deepseek-chat',
      CREW_REASONING_MODEL: 'deepseek-reasoner',
      CREW_EXECUTION_MODEL: 'deepseek-chat'
    }
  },
  {
    name: 'Mixed Best-of-Breed',
    config: {
      CREW_CHAT_MODEL: 'groq/llama-3.1-8b-instant',  // Fastest
      CREW_REASONING_MODEL: 'deepseek-reasoner',      // Best reasoning
      CREW_EXECUTION_MODEL: 'groq/llama-3.1-8b-instant'  // Fastest
    }
  }
];

function analyzeCodeQuality(response) {
  const code = response?.response || response?.result || JSON.stringify(response);
  
  return {
    hasFunction: /function\s+\w+|const\s+\w+\s*=.*=>|exports\.\w+/.test(code),
    hasErrorHandling: /try|catch|throw|Error/.test(code),
    hasValidation: /if\s*\(|validate|check/.test(code),
    hasComments: /\/\/|\/\*|\*\//.test(code),
    hasJWT: /jwt|jsonwebtoken|verify|decode/.test(code),
    codeBlockCount: (code.match(/```/g) || []).length / 2,
    length: code.length,
    linesOfCode: code.split('\n').length
  };
}

function scoreCodeQuality(analysis) {
  let score = 0;
  if (analysis.hasFunction) score += 20;
  if (analysis.hasErrorHandling) score += 25;
  if (analysis.hasValidation) score += 20;
  if (analysis.hasJWT) score += 20;
  if (analysis.hasComments) score += 10;
  if (analysis.codeBlockCount > 0) score += 5;
  return score;
}

async function testStack(stack, timeout = 90000) {
  console.log(`\n${'═'.repeat(66)}`);
  console.log(`🧪 TESTING: ${stack.name}`);
  console.log('─'.repeat(66));
  
  // Set environment
  for (const [key, value] of Object.entries(stack.config)) {
    process.env[key] = value;
  }
  
  console.log(`Config:`);
  console.log(`  L1: ${stack.config.CREW_CHAT_MODEL}`);
  console.log(`  L2: ${stack.config.CREW_REASONING_MODEL}`);
  console.log(`  L3: ${stack.config.CREW_EXECUTION_MODEL}\n`);

  const startTime = Date.now();
  
  try {
    const pipeline = new UnifiedPipeline();
    
    // Race against timeout
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Timeout')), timeout)
    );
    
    const result = await Promise.race([
      pipeline.execute({
        userInput: TEST_TASK,
        context: `Stack test: ${stack.name}`,
        sessionId: `test-${Date.now()}`
      }),
      timeoutPromise
    ]);
    
    const elapsed = Date.now() - startTime;
    const quality = analyzeCodeQuality(result);
    const score = scoreCodeQuality(quality);
    
    console.log(`✅ SUCCESS`);
    console.log(`   Time: ${elapsed}ms (${(elapsed/1000).toFixed(1)}s)`);
    console.log(`   Cost: $${(result.cost || 0).toFixed(6)}`);
    console.log(`   Quality Score: ${score}/100`);
    console.log(`   - Has function: ${quality.hasFunction ? '✓' : '✗'}`);
    console.log(`   - Has error handling: ${quality.hasErrorHandling ? '✓' : '✗'}`);
    console.log(`   - Has validation: ${quality.hasValidation ? '✓' : '✗'}`);
    console.log(`   - JWT-specific: ${quality.hasJWT ? '✓' : '✗'}`);
    console.log(`   - Code blocks: ${quality.codeBlockCount}`);
    console.log(`   - Lines of code: ${quality.linesOfCode}`);
    
    return {
      stack: stack.name,
      success: true,
      time: elapsed,
      cost: result.cost || 0,
      quality: quality,
      score: score,
      response: result
    };
    
  } catch (err) {
    const elapsed = Date.now() - startTime;
    
    console.log(`❌ FAILED: ${err.message}`);
    console.log(`   Time before failure: ${elapsed}ms`);
    
    return {
      stack: stack.name,
      success: false,
      time: elapsed,
      error: err.message
    };
  }
}

async function runComparison() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║        COMPREHENSIVE STACK COMPARISON                       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
  
  console.log(`Test Task: "${TEST_TASK}"\n`);
  console.log('Testing 5 different model stacks...\n');

  const results = [];
  
  for (const stack of STACKS) {
    const result = await testStack(stack);
    results.push(result);
    
    // Wait between tests to avoid rate limits
    if (STACKS.indexOf(stack) < STACKS.length - 1) {
      console.log('\n⏳ Waiting 3s before next test...\n');
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }

  // Summary
  console.log('\n\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                   COMPARISON SUMMARY                         ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  console.log(`✅ WORKING: ${successful.length}/${results.length} stacks\n`);

  if (successful.length > 0) {
    console.log('| Stack | Time | Cost | Quality | Value |');
    console.log('|-------|------|------|---------|-------|');
    
    successful.forEach(r => {
      const value = r.score / (r.cost * 1000); // Quality per $0.001
      console.log(`| ${r.stack.padEnd(30)} | ${(r.time/1000).toFixed(1)}s | $${r.cost.toFixed(5)} | ${r.score}/100 | ${value.toFixed(0)} |`);
    });

    console.log('\n\n🏆 WINNERS:\n');

    const fastest = successful.sort((a, b) => a.time - b.time)[0];
    console.log(`⚡ FASTEST: ${fastest.stack} (${(fastest.time/1000).toFixed(1)}s)`);

    const cheapest = successful.sort((a, b) => a.cost - b.cost)[0];
    console.log(`💰 CHEAPEST: ${cheapest.stack} ($${cheapest.cost.toFixed(6)})`);

    const highestQuality = successful.sort((a, b) => b.score - a.score)[0];
    console.log(`💎 BEST QUALITY: ${highestQuality.stack} (${highestQuality.score}/100)`);

    const bestValue = successful.sort((a, b) => (b.score/b.cost) - (a.score/a.cost))[0];
    console.log(`🎯 BEST VALUE: ${bestValue.stack} (${(bestValue.score/bestValue.cost).toFixed(0)} quality/$)`);

    console.log('\n\n📊 DETAILED ANALYSIS:\n');

    successful.forEach(r => {
      console.log(`${r.stack}:`);
      console.log(`  Speed: ${(r.time/1000).toFixed(1)}s`);
      console.log(`  Cost: $${r.cost.toFixed(6)}`);
      console.log(`  Quality: ${r.score}/100`);
      console.log(`  Value: ${(r.score / r.cost).toFixed(0)} quality/$`);
      console.log(`  Has error handling: ${r.quality.hasErrorHandling ? 'YES' : 'NO'}`);
      console.log(`  JWT-specific: ${r.quality.hasJWT ? 'YES' : 'NO'}`);
      console.log('');
    });
  }

  if (failed.length > 0) {
    console.log(`\n❌ FAILED STACKS: ${failed.length}\n`);
    failed.forEach(r => {
      console.log(`  ${r.stack}: ${r.error} (${(r.time/1000).toFixed(1)}s before failure)`);
    });
  }

  console.log('\n\n💡 RECOMMENDATION:\n');
  
  if (successful.length > 0) {
    const recommended = successful.sort((a, b) => {
      const aValue = (a.score / a.cost) * (1000 / a.time); // Quality/$ * Speed factor
      const bValue = (b.score / b.cost) * (1000 / b.time);
      return bValue - aValue;
    })[0];

    console.log(`  ✅ USE: ${recommended.stack}`);
    console.log(`     - Speed: ${(recommended.time/1000).toFixed(1)}s`);
    console.log(`     - Cost: $${recommended.cost.toFixed(6)}`);
    console.log(`     - Quality: ${recommended.score}/100`);
    console.log(`     - Overall best balance of speed, cost, and quality`);
  } else {
    console.log('  ⚠️  All stacks failed - check configuration and API keys');
  }
}

runComparison().catch(err => {
  console.error('\n❌ FATAL ERROR:', err.message);
  console.error(err.stack);
  process.exit(1);
});
