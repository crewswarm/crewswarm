#!/usr/bin/env node
/**
 * Quick demo of Auto-RAG working
 */

import { autoLoadRelevantFiles, shouldUseRag } from './src/context/codebase-rag.ts';

console.log('🧪 Auto-RAG Quick Demo\n');

// Test 1: shouldUseRag detection
console.log('📍 Test 1: Trigger Detection\n');

const queries = [
  { query: "add rate limiting to auth", shouldTrigger: true },
  { query: "what is JWT?", shouldTrigger: false },
  { query: "fix bug in src/auth.ts", shouldTrigger: true },
  { query: "explain how databases work", shouldTrigger: false },
  { query: "refactor the user service", shouldTrigger: true },
];

for (const { query, shouldTrigger } of queries) {
  const result = shouldUseRag(query);
  const icon = result === shouldTrigger ? '✅' : '❌';
  console.log(`${icon} "${query}" → ${result ? 'TRIGGER' : 'SKIP'}`);
}

console.log('\n📍 Test 2: Keyword Extraction\n');

const testQuery = "add rate limiting middleware to auth endpoint";
console.log(`Query: "${testQuery}"`);
console.log(`Keywords:`, testQuery.toLowerCase().match(/\b[a-z]{3,}\b/g));

console.log('\n📍 Test 3: Codebase\n');

// Test on crew-cli itself
try {
  const result = await autoLoadRelevantFiles(
    "how does the unified pipeline work?",
    process.cwd(),
    {
      mode: 'keyword',
      tokenBudget: 4000,
      maxFiles: 3
    }
  );
  
  console.log(`Mode: ${result.mode}`);
  console.log(`Files loaded: ${result.filesLoaded.length}`);
  console.log(`Token estimate: ${result.tokenEstimate}`);
  console.log(`Files:`, result.filesLoaded);
  
  if (result.filesLoaded.length > 0) {
    console.log('\n✅ Auto-RAG is working!\n');
  }
} catch (err) {
  console.log('❌ Error:', err.message);
}

console.log('\n📋 Configuration:\n');
console.log('Environment variables:');
console.log('  CREW_RAG_MODE=keyword|import-graph|semantic|off');
console.log('  CREW_RAG_TOKEN_BUDGET=8000');
console.log('  CREW_RAG_MAX_FILES=10');
console.log('\nExample usage:');
console.log('  crew exec "add rate limiting to auth"');
console.log('  → Auto-loads relevant files before sending to LLM');
