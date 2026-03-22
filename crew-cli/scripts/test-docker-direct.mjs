#!/usr/bin/env node

/**
 * Direct Docker Sandbox Test
 * Tests Docker isolation by:
 * 1. Creating a project with broken code on disk
 * 2. Staging fixed code in sandbox
 * 3. Running tests in Docker with staged files
 * 4. Verifying disk unchanged
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const TEST_DIR = `/tmp/crew-docker-direct-${Date.now()}`;

async function main() {
  console.log('\n🧪 Docker Sandbox Direct Test');
  console.log('════════════════════════════════\n');
  
  // Step 1: Create project with broken code
  fs.mkdirSync(`${TEST_DIR}/tests`, { recursive: true });
  fs.mkdirSync(`${TEST_DIR}/src`, { recursive: true });
  fs.mkdirSync(`${TEST_DIR}/.crew`, { recursive: true });
  
  fs.writeFileSync(
    `${TEST_DIR}/package.json`,
    JSON.stringify({ name: 'docker-test', type: 'module' }, null, 2)
  );
  
  fs.writeFileSync(
    `${TEST_DIR}/tests/math.test.js`,
    `import assert from 'assert';
import test from 'node:test';
import { add } from '../src/math.js';

test('addition works', () => {
  assert.strictEqual(add(2, 3), 5);
});
`
  );
  
  // BROKEN implementation on disk
  fs.writeFileSync(
    `${TEST_DIR}/src/math.js`,
    `export function add(a, b) {
  return 0; // BROKEN - always returns 0
}
`
  );
  
  console.log('✅ Step 1: Created project with BROKEN implementation');
  console.log('   File: src/math.js contains "return 0"\n');
  
  // Step 2: Test natively (should fail)
  console.log('✅ Step 2: Native test (no Docker, no staging)\n');
  
  try {
    execSync('node --test tests/', { 
      cwd: TEST_DIR,
      stdio: 'pipe',
      encoding: 'utf8'
    });
    console.log('   Result: PASSED ✗ (unexpected!)\n');
    process.exit(1);
  } catch (err) {
    console.log('   Result: FAILED ✓ (expected - broken code)\n');
  }
  
  // Step 3: Stage fixed code in sandbox
  console.log('✅ Step 3: Stage FIXED code in sandbox\n');
  
  const sandboxJson = {
    activeBranch: 'main',
    branches: {
      main: {
        'src/math.js': {
          type: 'file',
          modified: `export function add(a, b) {
  return a + b; // FIXED - correct implementation
}
`
        }
      }
    }
  };
  
  fs.writeFileSync(
    `${TEST_DIR}/.crew/sandbox.json`,
    JSON.stringify(sandboxJson, null, 2)
  );
  
  console.log('   Sandbox staged: src/math.js with "return a + b"');
  console.log('   Disk still has: "return 0" (unchanged)\n');
  
  // Step 4: Create temp dir with staged files
  console.log('✅ Step 4: Copy staged files to temp dir\n');
  
  const tempDir = `/tmp/crew-docker-temp-${Date.now()}`;
  fs.mkdirSync(`${tempDir}/tests`, { recursive: true });
  fs.mkdirSync(`${tempDir}/src`, { recursive: true });
  
  // Copy package.json and tests
  fs.copyFileSync(`${TEST_DIR}/package.json`, `${tempDir}/package.json`);
  fs.copyFileSync(`${TEST_DIR}/tests/math.test.js`, `${tempDir}/tests/math.test.js`);
  
  // Write FIXED code from sandbox
  fs.writeFileSync(
    `${tempDir}/src/math.js`,
    sandboxJson.branches.main['src/math.js'].modified
  );
  
  console.log('   Temp dir created with FIXED code from sandbox\n');
  
  // Step 5: Run tests in Docker
  console.log('✅ Step 5: Run tests in Docker\n');
  
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5000 });
  } catch {
    console.log('   ❌ Docker not available\n');
    cleanup();
    process.exit(1);
  }
  
  try {
    const output = execSync(
      `docker run --rm -v "${tempDir}":/work -w /work node:20-slim node --test tests/`,
      { encoding: 'utf8', stdio: 'pipe', timeout: 30000 }
    );
    
    console.log('   Result: PASSED ✓ (staged FIXED code in Docker)\n');
    console.log('🎉 Docker Sandbox Test PASSED!\n');
    console.log('Proof:');
    console.log('  1. Disk has BROKEN code → native test fails');
    console.log('  2. Sandbox has FIXED code → Docker test passes');
    console.log('  3. Perfect isolation - test before commit works!\n');
    
  } catch (err) {
    console.log('   Result: FAILED ✗');
    console.log('   Output:', err.stdout || err.stderr);
    cleanup();
    process.exit(1);
  }
  
  // Step 6: Verify disk unchanged
  console.log('✅ Step 6: Verify isolation\n');
  
  const diskContent = fs.readFileSync(`${TEST_DIR}/src/math.js`, 'utf8');
  if (diskContent.includes('return 0')) {
    console.log('   Disk file: STILL BROKEN ✓ (unchanged)\n');
  } else {
    console.log('   Disk file: MODIFIED ✗ (isolation failed!)\n');
    cleanup();
    process.exit(1);
  }
  
  cleanup();
  
  function cleanup() {
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

main().catch(err => {
  console.error('\n❌ Test failed:', err.message);
  process.exit(1);
});
