#!/usr/bin/env node
/**
 * Test JSON Mode for Gemini and OpenAI
 * 
 * Gemini: Uses responseMimeType = 'application/json'
 * OpenAI: Uses response_format = { type: 'json_object' }
 */

import { LocalExecutor } from './src/executor/local.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

async function testJsonMode() {
  console.log('\n🧪 Testing JSON Mode Support\n');

  const executor = new LocalExecutor();

  // Test 1: Gemini JSON Mode
  if (process.env.GEMINI_API_KEY) {
    console.log('📝 Test 1: Gemini JSON Mode');
    console.log('────────────────────────────────────────\n');
    
    try {
      const result = await executor.execute(
        'List 3 programming languages',
        {
          model: 'gemini-2.5-flash',
          systemPrompt: 'You are a helpful assistant. Output ONLY valid JSON.',
          maxTokens: 200,
          jsonMode: true
        }
      );

      if (result.success) {
        console.log(`${GREEN}✓ Gemini call succeeded${RESET}`);
        console.log(`Response (${result.result.length} chars):\n${result.result}\n`);
        
        // Try to parse as JSON
        try {
          const parsed = JSON.parse(result.result);
          console.log(`${GREEN}✓ Valid JSON${RESET}`);
          console.log(`Parsed:`, parsed);
        } catch (err) {
          console.log(`${RED}✗ NOT valid JSON${RESET}`);
          console.log(`Parse error: ${err.message}`);
        }
      } else {
        console.log(`${RED}✗ Gemini call failed${RESET}`);
      }
    } catch (err) {
      console.log(`${RED}✗ Exception: ${err.message}${RESET}`);
    }
    console.log('\n');
  } else {
    console.log(`${YELLOW}⚠ Skipping Gemini test (no GEMINI_API_KEY)${RESET}\n`);
  }

  // Test 2: OpenAI JSON Mode
  if (process.env.OPENAI_API_KEY) {
    console.log('📝 Test 2: OpenAI JSON Mode');
    console.log('────────────────────────────────────────\n');
    
    try {
      const result = await executor.execute(
        'List 3 programming languages',
        {
          model: 'gpt-4o-mini',
          systemPrompt: 'You are a helpful assistant. Output ONLY valid JSON.',
          maxTokens: 200,
          jsonMode: true
        }
      );

      if (result.success) {
        console.log(`${GREEN}✓ OpenAI call succeeded${RESET}`);
        console.log(`Response (${result.result.length} chars):\n${result.result}\n`);
        
        // Try to parse as JSON
        try {
          const parsed = JSON.parse(result.result);
          console.log(`${GREEN}✓ Valid JSON${RESET}`);
          console.log(`Parsed:`, parsed);
        } catch (err) {
          console.log(`${RED}✗ NOT valid JSON${RESET}`);
          console.log(`Parse error: ${err.message}`);
        }
      } else {
        console.log(`${RED}✗ OpenAI call failed${RESET}`);
      }
    } catch (err) {
      console.log(`${RED}✗ Exception: ${err.message}${RESET}`);
    }
    console.log('\n');
  } else {
    console.log(`${YELLOW}⚠ Skipping OpenAI test (no OPENAI_API_KEY)${RESET}\n`);
  }

  // Test 3: SharedDepsExecutor with JSON Mode
  if (process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY) {
    console.log('📝 Test 3: SharedDepsExecutor File Paths (with JSON mode)');
    console.log('────────────────────────────────────────\n');
    
    const { SharedDepsExecutor } = await import('./src/executor/shared-deps.js');
    const { Sandbox } = await import('./src/sandbox/index.js');
    
    const sharedDepsExecutor = new SharedDepsExecutor();
    const sandbox = new Sandbox('/tmp/test-json-mode');
    
    try {
      const model = process.env.GEMINI_API_KEY ? 'gemini-2.5-flash' : 'gpt-4o-mini';
      console.log(`Using model: ${model}\n`);
      
      const result = await sharedDepsExecutor.execute(
        'Create a simple calculator with add, subtract functions',
        sandbox,
        { model }
      );
      
      console.log(`${GREEN}✓ SharedDepsExecutor succeeded${RESET}`);
      console.log(`Files: ${result.filePaths.join(', ')}`);
      console.log(`\nShared Deps (first 200 chars):\n${result.sharedDeps.substring(0, 200)}...\n`);
      
    } catch (err) {
      console.log(`${RED}✗ SharedDepsExecutor failed: ${err.message}${RESET}`);
    }
  }

  console.log('\n✅ All tests complete\n');
}

testJsonMode().catch(console.error);
