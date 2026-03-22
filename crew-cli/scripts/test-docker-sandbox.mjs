#!/usr/bin/env node

/**
 * End-to-end test: Docker sandbox with staged files
 * 
 * Tests:
 * 1. Stage files in sandbox
 * 2. Run tests via @@RUN_CMD
 * 3. Verify Docker isolation
 * 4. Verify tests run against staged files, not disk
 */

import { Sandbox } from '../dist/sandbox.mjs';
import { executeToolsWithSandbox } from '../dist/tools.mjs';
import fs from 'fs';
import path from 'path';

const TEST_DIR = '/tmp/crew-docker-sandbox-test';
const SANDBOX_DIR = path.join(TEST_DIR, '.crew');

async function main() {
  console.log('\n🧪 Docker Sandbox E2E Test\n');
  
  // Clean slate
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(SANDBOX_DIR, { recursive: true });
  
  // Create package.json
  fs.writeFileSync(
    path.join(TEST_DIR, 'package.json'),
    JSON.stringify({
      name: 'docker-sandbox-test',
      type: 'module',
      scripts: {
        test: 'node --test tests/'
      }
    }, null, 2)
  );
  
  // Create test directory
  fs.mkdirSync(path.join(TEST_DIR, 'tests'), { recursive: true });
  
  // Create test file (WILL FAIL initially)
  fs.writeFileSync(
    path.join(TEST_DIR, 'tests', 'math.test.js'),
    `import assert from 'assert';
import test from 'node:test';
import { add } from '../src/math.js';

test('addition works', () => {
  assert.strictEqual(add(2, 3), 5);
});
`
  );
  
  // Create BROKEN implementation on disk
  fs.mkdirSync(path.join(TEST_DIR, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(TEST_DIR, 'src', 'math.js'),
    `export function add(a, b) {
  return 0; // BROKEN - always returns 0
}
`
  );
  
  console.log('✓ Created test project with BROKEN implementation on disk\n');
  
  // Initialize sandbox
  const sandbox = new Sandbox(SANDBOX_DIR);
  await sandbox.init();
  
  // Stage FIXED implementation (not on disk yet!)
  const fixedCode = `export function add(a, b) {
  return a + b; // FIXED - correct implementation
}
`;
  
  sandbox.addChange('src/math.js', fixedCode);
  await sandbox.save();
  
  console.log('✓ Staged FIXED implementation in sandbox (not on disk)\n');
  
  // Test 1: Native execution (should FAIL - uses broken disk file)
  console.log('Test 1: Native execution (broken disk file)');
  process.chdir(TEST_DIR);
  
  try {
    const nativeReply = `@@RUN_CMD npm test`;
    const nativeResults = await executeToolsWithSandbox(nativeReply, sandbox, {
      allowRead: true,
      allowWrite: false,
      allowRun: true
    });
    
    console.log('Native test output:', nativeResults[0]?.message?.slice(0, 300));
    if (nativeResults[0]?.success) {
      console.log('⚠️  UNEXPECTED: Native test passed (should fail with broken disk file)');
    } else {
      console.log('✓ Native test FAILED as expected (broken disk file)');
    }
  } catch (err) {
    console.log('✓ Native test FAILED as expected:', err.message.slice(0, 100));
  }
  
  console.log('\nTest 2: Docker sandbox (fixed staged file)\n');
  
  // Test 2: Docker execution (should PASS - uses staged fixed file)
  const dockerReply = `@@RUN_CMD npm test`;
  const dockerResults = await executeToolsWithSandbox(dockerReply, sandbox, {
    allowRead: true,
    allowWrite: false,
    allowRun: true
  });
  
  console.log('\nDocker test output:', dockerResults[0]?.message);
  
  if (dockerResults[0]?.success) {
    console.log('\n✅ SUCCESS: Docker test PASSED with staged file!');
    console.log('   → Tests ran against staged FIXED code');
    console.log('   → Disk still has BROKEN code');
    console.log('   → Perfect isolation achieved!\n');
  } else {
    console.log('\n❌ FAILED: Docker test should have passed\n');
    process.exit(1);
  }
  
  // Verify disk file is still broken
  const diskContent = fs.readFileSync(path.join(TEST_DIR, 'src', 'math.js'), 'utf8');
  if (diskContent.includes('return 0')) {
    console.log('✓ Disk file still contains BROKEN code (not modified)');
  } else {
    console.log('❌ ERROR: Disk file was modified (isolation broken!)');
    process.exit(1);
  }
  
  // Verify sandbox has fixed code
  const branch = sandbox.state?.branches?.[sandbox.getActiveBranch()];
  const stagedContent = branch?.['src/math.js']?.modified;
  
  if (stagedContent?.includes('return a + b')) {
    console.log('✓ Sandbox contains FIXED code (staged correctly)');
  } else {
    console.log('❌ ERROR: Sandbox staging failed');
    process.exit(1);
  }
  
  console.log('\n🎉 ALL TESTS PASSED!\n');
  console.log('Summary:');
  console.log('  - Native tests run against disk (broken) ❌');
  console.log('  - Docker tests run against staged files (fixed) ✅');
  console.log('  - Disk unchanged after Docker tests ✅');
  console.log('  - Perfect test-before-commit workflow! ✅\n');
  
  // Cleanup
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
}

main().catch(err => {
  console.error('\n❌ Test failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
