#!/usr/bin/env node

/**
 * Example: Cross-System Memory Sharing
 * 
 * Scenario: Cursor stores user preferences → CLI recalls them
 * 
 * NOTE: This demo uses the compiled dist/ bundle since src/ is TypeScript
 */

import { AgentMemory } from '../dist/crew.mjs';
import { existsSync } from 'node:fs';

console.log('=== Cross-System Memory Demo ===\n');

// Check if CREW_MEMORY_DIR is set
const memoryDir = process.env.CREW_MEMORY_DIR;
if (memoryDir) {
  console.log(`✅ Shared memory enabled: ${memoryDir}`);
} else {
  console.log('⚠️  Using local memory (CLI-only mode)');
  console.log('   Set CREW_MEMORY_DIR=/path/to/shared for cross-system sharing\n');
}

// Simulate Cursor storing user preferences
console.log('--- Cursor Agent ---');
const cursorMemory = new AgentMemory('crew-lead');
console.log('Storing user preferences...');

cursorMemory.remember('Project: VS Code Extension, Budget: $10k, Deadline: March 15', {
  critical: true,
  tags: ['project-context', 'user-input'],
  provider: 'cursor'
});

cursorMemory.remember('Tech Stack: TypeScript + React, avoid Vue', {
  critical: true,
  tags: ['tech-stack', 'user-preferences'],
  provider: 'cursor'
});

cursorMemory.remember('Code Style: ESLint strict, Prettier 120 chars', {
  critical: false,
  tags: ['code-style'],
  provider: 'cursor'
});

console.log('✅ Stored 3 facts from Cursor\n');

// Simulate CLI pipeline recalling memory
console.log('--- CLI Pipeline ---');
const cliMemory = new AgentMemory('crew-lead');

console.log('Recalling critical facts only...');
const criticalContext = cliMemory.recall({
  tokenBudget: 1000,
  criticalOnly: true
});

console.log(criticalContext);

console.log('\nRecalling all project context...');
const fullContext = cliMemory.recall({
  tokenBudget: 2000,
  tags: ['project-context', 'tech-stack']
});

console.log(fullContext);

// Show stats
console.log('\n--- Memory Stats ---');
const stats = cliMemory.stats();
console.log(`Total facts: ${stats.totalFacts}`);
console.log(`Critical facts: ${stats.criticalFacts}`);
console.log(`Providers: ${stats.providers.join(', ')}`);
console.log(`Oldest: ${stats.oldestFact}`);
console.log(`Newest: ${stats.newestFact}`);

// Simulate Gateway/RT agent adding task status
console.log('\n--- Gateway Agent ---');
const gatewayMemory = new AgentMemory('crew-lead');
gatewayMemory.remember('Task: Building extension, Workers: 5, Status: Planning complete', {
  critical: false,
  tags: ['task-status', 'gateway'],
  provider: 'gateway'
});
console.log('✅ Gateway stored task status');

// CLI reads gateway status
console.log('\n--- CLI reads Gateway status ---');
const taskStatus = cliMemory.recall({
  tokenBudget: 500,
  tags: ['task-status']
});
console.log(taskStatus);

// Check storage location
console.log('\n--- Storage Location ---');
const storageDir = memoryDir || process.cwd();
const memoryFile = `${storageDir}/.crew/agent-memory/crew-lead.json`;
if (existsSync(memoryFile)) {
  console.log(`✅ Memory file: ${memoryFile}`);
  console.log('   This file is shared across Cursor, CLI, Gateway, and RT agents');
} else {
  console.log(`⚠️  Memory file not found: ${memoryFile}`);
}

console.log('\n=== Demo Complete ===');
console.log('\nTo enable cross-system sharing:');
console.log('  1. Add to .env: CREW_MEMORY_DIR=/Users/jeffhobbs/CrewSwarm/shared-memory');
console.log('  2. All agents (Cursor, CLI, Gateway) will use same storage');
console.log('  3. Facts stored by Cursor are immediately visible to CLI and Gateway');
