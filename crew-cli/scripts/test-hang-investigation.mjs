#!/usr/bin/env node
/**
 * Test What Causes the Hang
 * Compare different configurations to isolate the issue
 */

import { UnifiedPipeline } from '../src/pipeline/unified.js';

const COMPLEX_TASK = "Create a roadmap for building an authentication system with user registration, login, JWT tokens, password reset, and email verification";

const CONFIGS = [
  {
    name: 'Groq/Groq (Dual-L2 OFF)',
    env: {
      CREW_USE_UNIFIED_ROUTER: 'true',
      CREW_DUAL_L2_ENABLED: 'false',
      CREW_CHAT_MODEL: 'groq/llama-3.1-8b-instant',
      CREW_REASONING_MODEL: 'groq/llama-3.3-70b-versatile',
      CREW_EXECUTION_MODEL: 'groq/llama-3.1-8b-instant'
    }
  },
  {
    name: 'Groq/Groq (Dual-L2 ON)',
    env: {
      CREW_USE_UNIFIED_ROUTER: 'true',
      CREW_DUAL_L2_ENABLED: 'true',
      CREW_CHAT_MODEL: 'groq/llama-3.1-8b-instant',
      CREW_REASONING_MODEL: 'groq/llama-3.3-70b-versatile',
      CREW_EXECUTION_MODEL: 'groq/llama-3.1-8b-instant'
    }
  },
  {
    name: 'Groq/Grok (Dual-L2 OFF)',
    env: {
      CREW_USE_UNIFIED_ROUTER: 'true',
      CREW_DUAL_L2_ENABLED: 'false',
      CREW_CHAT_MODEL: 'groq/llama-3.1-8b-instant',
      CREW_REASONING_MODEL: 'grok-4-1-fast-reasoning',
      CREW_EXECUTION_MODEL: 'groq/llama-3.1-8b-instant'
    }
  },
  {
    name: 'Groq/Grok (Dual-L2 ON)',
    env: {
      CREW_USE_UNIFIED_ROUTER: 'true',
      CREW_DUAL_L2_ENABLED: 'true',
      CREW_CHAT_MODEL: 'groq/llama-3.1-8b-instant',
      CREW_REASONING_MODEL: 'grok-4-1-fast-reasoning',
      CREW_EXECUTION_MODEL: 'groq/llama-3.1-8b-instant'
    }
  }
];

async function testConfig(config, timeout = 60000) {
  console.log(`\n${'═'.repeat(66)}`);
  console.log(`🧪 ${config.name}`);
  console.log('─'.repeat(66));
  
  // Set environment
  for (const [key, value] of Object.entries(config.env)) {
    process.env[key] = value;
  }
  
  const startTime = Date.now();
  
  try {
    const pipeline = new UnifiedPipeline();
    
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Timeout')), timeout)
    );
    
    const result = await Promise.race([
      pipeline.execute({
        userInput: COMPLEX_TASK,
        context: 'Hang test',
        sessionId: `hang-test-${Date.now()}`
      }),
      timeoutPromise
    ]);
    
    const elapsed = Date.now() - startTime;
    
    console.log(`✅ SUCCESS (${elapsed}ms)`);
    console.log(`   Decision: ${result.plan?.decision}`);
    console.log(`   Path: ${result.executionPath.join(' → ')}`);
    console.log(`   Cost: $${result.totalCost.toFixed(6)}`);
    
    return {
      config: config.name,
      success: true,
      time: elapsed,
      decision: result.plan?.decision,
      path: result.executionPath.join(' → ')
    };
    
  } catch (err) {
    const elapsed = Date.now() - startTime;
    
    console.log(`❌ FAILED (${elapsed}ms): ${err.message}`);
    
    return {
      config: config.name,
      success: false,
      time: elapsed,
      error: err.message
    };
  }
}

async function runTests() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║            HANG INVESTIGATION - COMPLEX TASK                 ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
  
  console.log(`Task: "${COMPLEX_TASK}"\n`);
  console.log('Testing 4 configurations with 60s timeout each...\n');

  const results = [];
  
  for (const config of CONFIGS) {
    const result = await testConfig(config);
    results.push(result);
    
    console.log('\n⏳ Waiting 3s...\n');
    await new Promise(r => setTimeout(r, 3000));
  }

  // Summary
  console.log('\n\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                       SUMMARY                                ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  console.log(`✅ PASSED: ${successful.length}/${results.length}`);
  console.log(`❌ FAILED/TIMEOUT: ${failed.length}/${results.length}\n`);

  if (successful.length > 0) {
    console.log('Successful configs:');
    successful.forEach(r => {
      console.log(`  ${r.config.padEnd(35)} ${(r.time/1000).toFixed(1)}s → ${r.decision}`);
    });
  }

  if (failed.length > 0) {
    console.log('\nFailed configs:');
    failed.forEach(r => {
      console.log(`  ${r.config.padEnd(35)} ${(r.time/1000).toFixed(1)}s → ${r.error}`);
    });
  }

  console.log('\n\n🔍 ANALYSIS:\n');
  
  const dualL2On = results.filter(r => r.config.includes('Dual-L2 ON'));
  const dualL2Off = results.filter(r => r.config.includes('Dual-L2 OFF'));
  const withGrok = results.filter(r => r.config.includes('Grok'));
  const withoutGrok = results.filter(r => r.config.includes('Groq/Groq'));
  
  console.log(`Dual-L2 ON:  ${dualL2On.filter(r => r.success).length}/${dualL2On.length} passed`);
  console.log(`Dual-L2 OFF: ${dualL2Off.filter(r => r.success).length}/${dualL2Off.length} passed`);
  console.log(`With Grok:   ${withGrok.filter(r => r.success).length}/${withGrok.length} passed`);
  console.log(`With Groq:   ${withoutGrok.filter(r => r.success).length}/${withoutGrok.length} passed`);
  
  if (failed.length > 0) {
    console.log('\n⚠️  HYPOTHESIS:');
    if (dualL2On.every(r => !r.success)) {
      console.log('   → Dual-L2 planner causes the hang');
    } else if (withGrok.every(r => !r.success)) {
      console.log('   → Grok API causes the hang');
    } else {
      console.log('   → Intermittent issue or rate limiting');
    }
  } else {
    console.log('  ✅ NO HANG DETECTED - All configs passed!');
    console.log('  → Previous hang may have been:');
    console.log('    - API rate limit');
    console.log('    - Network timeout');
    console.log('    - Race condition');
  }
}

runTests().catch(err => {
  console.error('\n💥 FATAL:', err.message);
  process.exit(1);
});
