#!/usr/bin/env node
/**
 * Proof-of-concept test: Verify Docker sandbox + Gemini tools integration
 */

import { Sandbox } from './src/sandbox/index.js';
import { DockerSandbox } from './src/tools/docker-sandbox.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function testDockerSandbox() {
  console.log('\n🐳 Docker + Gemini Tools Integration Test\n');
  
  // 1. Create sandbox and stage files
  const tempDir = '/tmp/crew-docker-poc-' + Date.now();
  fs.mkdirSync(tempDir, { recursive: true });
  
  const sandbox = new Sandbox(tempDir);
  await sandbox.load();
  
  console.log('1️⃣  Staging files via Sandbox API...');
  await sandbox.addChange('hello.js', 'console.log("Hello from Docker sandbox!");');
  await sandbox.addChange('test.cjs', `
const fs = require('fs');
console.log('✅ Docker sandbox test passed!');
console.log('Working dir:', process.cwd());
console.log('Files:', fs.readdirSync('.'));
  `.trim());
  
  console.log(`   ✓ Staged ${sandbox.getPendingPaths().length} files`);
  
  // 2. Check Docker availability
  const docker = new DockerSandbox();
  const available = await docker.isDockerAvailable();
  
  if (!available) {
    console.log('\n❌ Docker not available - skipping execution test');
    process.exit(1);
  }
  
  console.log('   ✓ Docker daemon is running');
  
  // 3. Run command with staged files
  console.log('\n2️⃣  Running command in Docker container...');
  const result = await docker.runCommand('node test.cjs', sandbox, {
    workDir: tempDir,
    timeout: 10000
  });
  
  console.log('\n3️⃣  Result:');
  console.log('   Success:', result.success);
  console.log('   Exit code:', result.exitCode);
  console.log('   Duration:', result.duration + 'ms');
  console.log('\n   Output:');
  console.log('   ' + result.output.split('\n').join('\n   '));
  
  // 4. Verify files were accessible
  if (result.success && result.output.includes('Docker sandbox test passed')) {
    console.log('\n✅ DOCKER + GEMINI INTEGRATION VERIFIED\n');
    console.log('Summary:');
    console.log('  • Sandbox staged files correctly');
    console.log('  • Docker container accessed staged files');
    console.log('  • Command executed successfully in isolation');
    process.exit(0);
  } else {
    console.log('\n❌ Integration test failed\n');
    process.exit(1);
  }
}

testDockerSandbox().catch(err => {
  console.error('\n❌ Test error:', err.message);
  process.exit(1);
});
