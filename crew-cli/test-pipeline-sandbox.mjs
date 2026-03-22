#!/usr/bin/env node
/**
 * Direct test: Verify UnifiedPipeline + GeminiToolAdapter writes files to project sandbox
 */

import { UnifiedPipeline } from './dist/pipeline/unified.js';
import { Sandbox } from './dist/sandbox/index.js';
import { SessionManager } from './dist/session/manager.js';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const OUTPUT_DIR = '/tmp/crew-pipeline-test-' + Date.now();

console.log('\n🧪 Direct UnifiedPipeline + Sandbox Test\n');

try {
  // Create output directory
  mkdirSync(OUTPUT_DIR, { recursive: true });
  console.log(`✓ Created output directory: ${OUTPUT_DIR}\n`);
  
  // Create sandbox and session for the output directory
  const sandbox = new Sandbox(OUTPUT_DIR);
  await sandbox.load();
  console.log('✓ Sandbox loaded\n');
  
  const sessionManager = new SessionManager(OUTPUT_DIR);
  console.log('✓ Session manager created\n');
  
  // Create pipeline with the sandbox
  const pipeline = new UnifiedPipeline(sandbox, sessionManager);
  console.log('✓ Pipeline created with project sandbox\n');
  
  // Execute a simple task
  console.log('1️⃣  Executing pipeline task...\n');
  const result = await pipeline.execute({
    userInput: 'Create a package.json for a simple Express TODO API server with dependencies: express, cors, body-parser. Add a hello.js file that logs "Hello from pipeline test!"',
    sessionId: 'test-session',
    context: ''
  });
  
  console.log(`✓ Pipeline execution ${result.phase}\n`);
  console.log(`   Execution path: ${result.executionPath.join(' → ')}\n`);
  console.log(`   Total cost: $${result.totalCost.toFixed(6)}\n`);
  
  // Check if sandbox has changes
  if (sandbox.hasChanges(sandbox.getActiveBranch())) {
    console.log('2️⃣  Applying sandbox changes...\n');
    await sandbox.apply(sandbox.getActiveBranch());
    console.log('✓ Sandbox changes applied\n');
  } else {
    console.log('⚠️  No sandbox changes detected\n');
  }
  
  // Verify files exist in output directory
  console.log('3️⃣  Verifying output files...\n');
  
  const expectedFiles = ['package.json', 'hello.js'];
  let foundCount = 0;
  
  for (const file of expectedFiles) {
    const filePath = resolve(OUTPUT_DIR, file);
    const exists = existsSync(filePath);
    console.log(`   ${exists ? '✅' : '❌'} ${file} ${exists ? 'found' : 'MISSING'}`);
    if (exists) {
      foundCount++;
      const content = readFileSync(filePath, 'utf8');
      console.log(`      Size: ${content.length} bytes`);
      if (content.length < 200) {
        console.log(`      Content: ${content}`);
      }
    }
  }
  
  console.log('');
  
  if (foundCount === expectedFiles.length) {
    console.log(`✅ SUCCESS: All ${foundCount} files created in ${OUTPUT_DIR}!\n`);
    process.exit(0);
  } else {
    console.log(`❌ PARTIAL: ${foundCount}/${expectedFiles.length} files found\n`);
    process.exit(1);
  }
  
} catch (error) {
  console.error('\n❌ Test failed:', error.message);
  console.error('\nStack:', error.stack);
  process.exit(1);
}
