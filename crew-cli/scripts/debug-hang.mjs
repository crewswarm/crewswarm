#!/usr/bin/env node
/**
 * Debug Complex Task Hang
 * Add verbose logging to find where it hangs
 */

import { UnifiedPipeline } from '../src/pipeline/unified.js';

const COMPLEX_TASK = "Create a roadmap for building an authentication system with user registration, login, JWT tokens, password reset, and email verification";

async function debugHang() {
  console.log('🔍 DEBUGGING COMPLEX TASK HANG\n');
  
  process.env.CREW_USE_UNIFIED_ROUTER = 'true';
  process.env.CREW_DUAL_L2_ENABLED = 'true';
  process.env.CREW_CHAT_MODEL = 'groq/llama-3.1-8b-instant';
  process.env.CREW_REASONING_MODEL = 'groq/llama-3.3-70b-versatile';
  process.env.CREW_EXECUTION_MODEL = 'groq/llama-3.1-8b-instant';

  console.log(`Task: "${COMPLEX_TASK}"\n`);
  console.log('Configuration:');
  console.log(`  Dual-L2: ${process.env.CREW_DUAL_L2_ENABLED}`);
  console.log(`  L1: ${process.env.CREW_CHAT_MODEL}`);
  console.log(`  L2: ${process.env.CREW_REASONING_MODEL}`);
  console.log(`  L3: ${process.env.CREW_EXECUTION_MODEL}\n`);

  const checkpoints = [];
  const logCheckpoint = (name) => {
    const elapsed = Date.now() - startTime;
    console.log(`[${elapsed}ms] ✓ ${name}`);
    checkpoints.push({ name, time: elapsed });
  };

  const startTime = Date.now();
  
  try {
    logCheckpoint('START');
    
    const pipeline = new UnifiedPipeline();
    logCheckpoint('Pipeline created');
    
    // Set timeout to 60s
    const timeout = 60000;
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        console.log('\n⏰ TIMEOUT REACHED - Last checkpoint:');
        console.log(checkpoints[checkpoints.length - 1]);
        reject(new Error(`Timeout after ${timeout}ms`));
      }, timeout);
    });
    
    console.log('\n🚀 Starting execution with 60s timeout...\n');
    
    const executionPromise = pipeline.execute({
      userInput: COMPLEX_TASK,
      context: 'Debug hang test',
      sessionId: `debug-hang-${Date.now()}`
    }).then(result => {
      logCheckpoint('pipeline.execute() returned');
      return result;
    });
    
    const result = await Promise.race([executionPromise, timeoutPromise]);
    
    logCheckpoint('COMPLETE');
    
    console.log('\n✅ SUCCESS - No hang detected!');
    console.log(`\nTotal time: ${Date.now() - startTime}ms`);
    console.log(`Decision: ${result.plan?.decision}`);
    console.log(`Execution path: ${result.executionPath.join(' → ')}`);
    
    console.log('\n📊 Checkpoints:');
    checkpoints.forEach(cp => {
      console.log(`  ${cp.time}ms: ${cp.name}`);
    });
    
  } catch (err) {
    const elapsed = Date.now() - startTime;
    
    console.log(`\n❌ FAILED after ${elapsed}ms`);
    console.log(`Error: ${err.message}`);
    
    console.log('\n📊 Checkpoints before failure:');
    checkpoints.forEach(cp => {
      console.log(`  ${cp.time}ms: ${cp.name}`);
    });
    
    console.log('\n🔍 Analysis:');
    if (checkpoints.length === 2) {
      console.log('  → Hung inside pipeline.execute()');
      console.log('  → Likely: L2 orchestration (routing decision)');
      console.log('  → Check: L2 LLM API call or JSON parsing');
    } else if (checkpoints.length === 3) {
      console.log('  → Hung after getting plan decision');
      console.log('  → Likely: L3 execution or result synthesis');
    }
  }
}

debugHang().catch(err => {
  console.error('\n💥 FATAL ERROR:', err.message);
  console.error(err.stack);
  process.exit(1);
});
