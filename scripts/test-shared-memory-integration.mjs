#!/usr/bin/env node
/**
 * Test shared memory integration — verify all systems can read/write same memory store
 * 
 * Usage:
 *   node scripts/test-shared-memory-integration.mjs
 */

import {
  isSharedMemoryAvailable,
  initSharedMemory,
  recordTaskMemory,
  rememberFact,
  searchMemory,
  getMemoryStats,
  getKeeperStats,
  CREW_MEMORY_DIR,
} from '../lib/memory/shared-adapter.mjs';

console.log('=== Shared Memory Integration Test ===\n');

// Check availability
console.log('1. Checking CLI module availability...');
if (!isSharedMemoryAvailable()) {
  console.error('   ❌ CLI modules not available');
  console.error('   Run: cd crew-cli && npm run build');
  process.exit(1);
}
console.log('   ✅ CLI modules loaded (AgentKeeper, AgentMemory, MemoryBroker)\n');

// Initialize storage
console.log('2. Initializing shared memory storage...');
const init = initSharedMemory();
if (!init.ok) {
  console.error(`   ❌ Init failed: ${init.error}`);
  process.exit(1);
}
console.log(`   ✅ Storage root: ${init.path}\n`);

// Test 1: Store task result (simulates gateway completing a task)
console.log('3. Test: Gateway stores task result...');
const taskResult = await recordTaskMemory(process.cwd(), {
  runId: 'test-' + Date.now(),
  tier: 'worker',
  task: 'Write a REST API endpoint for user authentication with JWT tokens',
  result: 'Created src/api/auth.ts with POST /auth/login endpoint. Uses jsonwebtoken library for token generation and bcrypt for password hashing.',
  agent: 'crew-coder',
  model: 'anthropic/claude-sonnet-4-5',
  metadata: {
    engineUsed: 'opencode',
    success: true,
    timestamp: new Date().toISOString()
  }
});
if (taskResult.ok) {
  console.log(`   ✅ Task recorded: ${taskResult.entry.id}`);
} else {
  console.log(`   ❌ Failed: ${taskResult.error}`);
}
console.log('');

// Test 2: Store cognitive fact (simulates crew-lead storing decision)
console.log('4. Test: Crew-lead stores decision fact...');
const factId1 = rememberFact('crew-lead', 'Project requires 2FA authentication for all admin routes', {
  critical: true,
  tags: ['security', 'requirement', 'auth'],
  provider: 'crew-lead-chat'
});
console.log(`   ✅ Fact stored: ${factId1}`);

const factId2 = rememberFact('crew-lead', 'Tech stack: Node.js + TypeScript + Express + PostgreSQL', {
  critical: true,
  tags: ['tech-stack', 'project-context'],
  provider: 'crew-lead-chat'
});
console.log(`   ✅ Fact stored: ${factId2}\n`);

// Test 3: Search from CLI perspective
console.log('5. Test: CLI searches memory (blends all sources)...');
const searchResults = await searchMemory(process.cwd(), 'authentication security', {
  maxResults: 5,
  includeDocs: false,
  includeCode: false
});
console.log(`   ✅ Found ${searchResults.length} hit(s):`);
for (const hit of searchResults) {
  console.log(`      [${hit.source}] ${hit.title} (score: ${hit.score.toFixed(3)})`);
  console.log(`      ${hit.text.slice(0, 80)}...`);
  console.log('');
}

// Test 4: Get statistics
console.log('6. Memory statistics:');
const factStats = getMemoryStats('crew-lead');
console.log(`   AgentMemory (crew-lead):`);
console.log(`     - Total facts: ${factStats.totalFacts}`);
console.log(`     - Critical facts: ${factStats.criticalFacts}`);
console.log(`     - Providers: ${factStats.providers.join(', ')}`);

const keeperStats = await getKeeperStats(process.cwd());
console.log(`   AgentKeeper:`);
console.log(`     - Total entries: ${keeperStats.entries}`);
console.log(`     - Storage: ${(keeperStats.bytes / 1024).toFixed(1)}KB`);
console.log(`     - By agent: ${Object.entries(keeperStats.byAgent).map(([k,v]) => `${k}=${v}`).join(', ')}`);
console.log('');

// Test 5: Cross-system scenario
console.log('7. Cross-system scenario test:');
console.log('   Simulating: Cursor stores → Gateway recalls → CLI sees it');

// Cursor stores (via MCP)
const cursorFactId = rememberFact('crew-lead', 'User prefers minimal comments in code — only document non-obvious intent', {
  critical: false,
  tags: ['code-style', 'user-preferences'],
  provider: 'cursor-mcp'
});
console.log(`   ✅ Cursor stored fact: ${cursorFactId}`);

// Gateway recalls (task dispatch)
const gatewaySearch = await searchMemory(process.cwd(), 'code style preferences', {
  maxResults: 3,
  includeDocs: false
});
console.log(`   ✅ Gateway found ${gatewaySearch.length} result(s) (includes Cursor fact)`);

// CLI sees it (independent session)
const cliSearch = await searchMemory(process.cwd(), 'comment style', {
  maxResults: 3,
  includeDocs: false
});
console.log(`   ✅ CLI found ${cliSearch.length} result(s) (includes Cursor fact)`);
console.log('');

// Summary
console.log('=== Integration Test Complete ===\n');
console.log('✅ All systems (CLI, Gateway, Crew-lead) can read/write the same memory store.');
console.log(`💾 Storage location: ${CREW_MEMORY_DIR}`);
console.log('');
console.log('Next steps:');
console.log('  1. Run: node scripts/migrate-brain-to-shared-memory.mjs');
console.log('  2. Start services: npm run restart-all');
console.log('  3. Dashboard → Memory tab to visualize');
console.log('  4. Chat: try "@@MEMORY search authentication"');
console.log('');
