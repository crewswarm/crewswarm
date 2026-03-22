#!/usr/bin/env node
/**
 * Quick test to verify sandbox output directory fix
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, rmSync } from 'fs';
import { resolve } from 'path';

const OUTPUT_DIR = '/tmp/crew-test-output';

console.log('\n🧪 Testing Sandbox Output Directory Fix\n');

// Clean up
if (existsSync(OUTPUT_DIR)) {
  console.log('♻️  Cleaning up previous test output...');
  rmSync(OUTPUT_DIR, { recursive: true, force: true });
}

console.log('1️⃣  Running crew headless run with output directory...\n');

try {
  // Run crew headless run with output directory
  const cmd = `node dist/crew.mjs headless run ${OUTPUT_DIR} --task "Create a simple Express TODO API" --always-approve --force-auto-apply`;
  console.log(`   Command: ${cmd}\n`);
  
  const output = execSync(cmd, {
    cwd: resolve('./'),
    encoding: 'utf8',
    timeout: 90000
  });
  
  console.log(output);
  
  // Check if files were created in the correct location
  console.log('\n2️⃣  Verifying output location...\n');
  
  const expectedFiles = [
    'package.json',
    'server.js',
    'README.md'
  ];
  
  let allPresent = true;
  for (const file of expectedFiles) {
    const filePath = resolve(OUTPUT_DIR, file);
    const exists = existsSync(filePath);
    console.log(`   ${exists ? '✅' : '❌'} ${file} ${exists ? 'found' : 'MISSING'}`);
    if (!exists) allPresent = false;
  }
  
  if (allPresent) {
    console.log('\n✅ SUCCESS: All files created in correct output directory!');
    console.log(`   Output: ${OUTPUT_DIR}\n`);
    
    // Show package.json content
    const pkgPath = resolve(OUTPUT_DIR, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    console.log('📦 package.json:');
    console.log(JSON.stringify(pkg, null, 2));
    
    process.exit(0);
  } else {
    console.log('\n❌ FAILED: Some files missing from output directory');
    process.exit(1);
  }
  
} catch (error) {
  console.error('\n❌ Test failed:', error.message);
  if (error.stdout) console.log('STDOUT:', error.stdout.toString());
  if (error.stderr) console.log('STDERR:', error.stderr.toString());
  process.exit(1);
}
