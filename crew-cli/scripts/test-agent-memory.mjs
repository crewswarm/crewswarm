#!/usr/bin/env node

/**
 * Test script for AgentMemory integration
 * Verifies integration in source files (no runtime test)
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

console.log('=== AgentMemory Integration Test ===\n');

// Verify integration by checking memory state files
console.log('Test 1: Verify AgentMemory module exists');
const modulePath = resolve(process.cwd(), 'src/pipeline/agent-memory.ts');
if (existsSync(modulePath)) {
  console.log(`✅ AgentMemory module found: ${modulePath}`);
} else {
  console.error('❌ AgentMemory module not found');
  process.exit(1);
}

// Check integration in unified.ts
console.log('\nTest 2: Verify integration in unified.ts');
const unifiedPath = resolve(process.cwd(), 'src/pipeline/unified.ts');
const unified = readFileSync(unifiedPath, 'utf8');

const integrationPoints = [
  { name: 'Import', pattern: "import { getPipelineMemory } from './agent-memory.js'" },
  { name: 'L2 Memory Storage', pattern: 'memory.remember(`L2 Decision' },
  { name: 'L3 Memory Injection', pattern: 'const memoryContext = memory.recall' },
  { name: 'Worker Output Storage', pattern: 'getPipelineMemory().remember' }
];

let allFound = true;
for (const point of integrationPoints) {
  if (unified.includes(point.pattern)) {
    console.log(`✅ ${point.name}: Found`);
  } else {
    console.log(`❌ ${point.name}: NOT FOUND`);
    allFound = false;
  }
}

// Count lines of integration
const memoryLines = unified.split('\n').filter(line => 
  line.includes('getPipelineMemory') || 
  line.includes('memory.remember') || 
  line.includes('memory.recall')
).length;

console.log(`\nIntegration: ${memoryLines} lines added (target: 15)`);

if (allFound) {
  console.log('\n=== All Integration Points Verified ✅ ===');
} else {
  console.error('\n=== Integration Incomplete ❌ ===');
  process.exit(1);
}

// Check vendor directory
console.log('\nTest 3: Verify AgentKeeper source');
const vendorPath = resolve(process.cwd(), '../vendor/agentkeeper/agentkeeper.py');
if (existsSync(vendorPath)) {
  console.log(`✅ AgentKeeper Python source: ${vendorPath}`);
} else {
  console.log('⚠️  AgentKeeper source not in expected location');
}

console.log('\n=== Integration Complete ===');
console.log('To test runtime behavior:');
console.log('  cd /home/user/CrewSwarm');
console.log('  cd crew-cli');
console.log('  npm run crew -- --help');
