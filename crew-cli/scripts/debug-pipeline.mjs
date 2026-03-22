#!/usr/bin/env node
/**
 * Debug Pipeline Output
 * See what the pipeline is actually returning
 */

import { UnifiedPipeline } from '../src/pipeline/unified.js';

async function debugPipeline() {
  console.log('🔍 DEBUGGING PIPELINE OUTPUT\n');
  
  process.env.CREW_USE_UNIFIED_ROUTER = 'true';
  process.env.CREW_DUAL_L2_ENABLED = 'false';
  process.env.CREW_CHAT_MODEL = 'groq/llama-3.1-8b-instant';
  process.env.CREW_REASONING_MODEL = 'groq/llama-3.3-70b-versatile';
  process.env.CREW_EXECUTION_MODEL = 'groq/llama-3.1-8b-instant';

  const task = "Write a function to validate an email";
  
  console.log(`Task: "${task}"\n`);
  
  try {
    const pipeline = new UnifiedPipeline();
    const result = await pipeline.execute({
      userInput: task,
      context: 'Debug test',
      sessionId: `debug-${Date.now()}`
    });
    
    console.log('\n📦 RAW RESULT:');
    console.log(JSON.stringify(result, null, 2));
    
    console.log('\n📝 RESULT KEYS:', Object.keys(result));
    console.log('\n📝 RESULT TYPE:', typeof result);
    
    if (result.response) {
      console.log('\n✅ result.response:', result.response.substring(0, 500));
    }
    if (result.result) {
      console.log('\n✅ result.result:', result.result.substring(0, 500));
    }
    if (result.output) {
      console.log('\n✅ result.output:', result.output.substring(0, 500));
    }
    if (result.answer) {
      console.log('\n✅ result.answer:', result.answer.substring(0, 500));
    }
    
  } catch (err) {
    console.error('❌ ERROR:', err.message);
    console.error(err.stack);
  }
}

debugPipeline().catch(console.error);
