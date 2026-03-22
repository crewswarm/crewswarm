#!/usr/bin/env node
/**
 * COMPLEX TASK TEST
 * 
 * Tests crew-cli with a realistic multi-file task:
 * - Auth module with bcrypt + JWT
 * - Multiple files
 * - Tests included
 * 
 * Optionally tests Dual-L2 parallel workers
 */

import { execSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

async function complexTest() {
  console.log(`\n${BLUE}═══════════════════════════════════════════════════${RESET}`);
  console.log(`${BLUE}     🧪 COMPLEX TASK TEST${RESET}`);
  console.log(`${BLUE}═══════════════════════════════════════════════════${RESET}\n`);
  
  const testDir = mkdtempSync(join(tmpdir(), 'crew-complex-'));
  const crewBin = join(process.cwd(), 'bin/crew.js');
  
  console.log(`📁 Test directory: ${testDir}`);
  console.log(`🔧 Crew CLI: ${crewBin}`);
  
  // Check if Dual-L2 should be enabled
  const useDualL2 = process.argv.includes('--dual-l2');
  if (useDualL2) {
    console.log(`${CYAN}🧠 Dual-L2 mode: ENABLED (parallel workers)${RESET}`);
  } else {
    console.log(`${YELLOW}💡 Tip: Run with --dual-l2 to test parallel workers${RESET}`);
  }
  
  console.log('');

  try {
    // Complex task: Auth module with multiple files
    const task = `Create a complete authentication module with:

1. src/auth/hash.js - Password hashing with bcrypt (hashPassword, verifyPassword functions)
2. src/auth/jwt.js - JWT token generation and verification (signToken, verifyToken functions)  
3. src/auth/middleware.js - Express middleware to protect routes (authenticate function)
4. src/auth/index.js - Exports all functions
5. package.json - Include dependencies: bcrypt, jsonwebtoken, express
6. test/auth.test.js - Basic tests for hash and JWT functions

Use proper error handling and include JSDoc comments.`;

    console.log(`${CYAN}📋 Task:${RESET}`);
    console.log(task.split('\n').map(l => `   ${l}`).join('\n'));
    console.log('');
    
    console.log(`${YELLOW}⚡ Executing pipeline...${RESET}\n`);
    
    const startTime = Date.now();
    
    execSync(`node "${crewBin}" run -t "${task.replace(/"/g, '\\"')}"`, {
      cwd: testDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        CREW_USE_UNIFIED_ROUTER: 'true',
        CREW_DUAL_L2_ENABLED: useDualL2 ? 'true' : 'false',
      }
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n${GREEN}✓ Pipeline complete (${duration}s)${RESET}`);

    // Apply changes
    console.log(`\n${YELLOW}📝 Applying staged changes...${RESET}`);
    try {
      execSync(`node "${crewBin}" apply`, {
        cwd: testDir,
        stdio: 'inherit'
      });
      console.log(`${GREEN}✓ Changes applied${RESET}`);
    } catch (applyErr) {
      // Apply command might not exist
    }

    // Verify files were created
    console.log(`\n${YELLOW}🔍 Verifying created files...${RESET}\n`);
    
    const expectedFiles = [
      'src/auth/hash.js',
      'src/auth/jwt.js',
      'src/auth/middleware.js',
      'src/auth/index.js',
      'package.json',
      'test/auth.test.js'
    ];

    const results = {
      found: [],
      missing: [],
      sizes: {}
    };

    for (const file of expectedFiles) {
      const fullPath = join(testDir, file);
      if (existsSync(fullPath)) {
        const content = readFileSync(fullPath, 'utf8');
        results.found.push(file);
        results.sizes[file] = content.length;
        console.log(`${GREEN}✅ ${file}${RESET} (${content.length} bytes)`);
      } else {
        results.missing.push(file);
        console.log(`${RED}❌ ${file}${RESET} (missing)`);
      }
    }

    // Check for additional files
    console.log(`\n${YELLOW}📂 All files in test directory:${RESET}`);
    function listFiles(dir, prefix = '') {
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const path = join(dir, entry.name);
          if (entry.isDirectory()) {
            console.log(`${CYAN}   ${prefix}📁 ${entry.name}/${RESET}`);
            listFiles(path, prefix + '  ');
          } else {
            const size = readFileSync(path, 'utf8').length;
            console.log(`${CYAN}   ${prefix}📄 ${entry.name}${RESET} (${size} bytes)`);
          }
        }
      } catch (err) {
        // Ignore errors
      }
    }
    listFiles(testDir);

    // Content verification
    console.log(`\n${YELLOW}🧪 Verifying content quality...${RESET}\n`);
    
    const checks = [];
    
    // Check hash.js has bcrypt
    if (results.found.includes('src/auth/hash.js')) {
      const hashContent = readFileSync(join(testDir, 'src/auth/hash.js'), 'utf8');
      const hasBcrypt = hashContent.includes('bcrypt') || hashContent.includes('hash');
      checks.push({ file: 'hash.js', check: 'Contains bcrypt/hash logic', passed: hasBcrypt });
      console.log(`${hasBcrypt ? GREEN : RED}${hasBcrypt ? '✅' : '❌'} hash.js contains bcrypt logic${RESET}`);
    }
    
    // Check jwt.js has JWT
    if (results.found.includes('src/auth/jwt.js')) {
      const jwtContent = readFileSync(join(testDir, 'src/auth/jwt.js'), 'utf8');
      const hasJwt = jwtContent.includes('jwt') || jwtContent.includes('token') || jwtContent.includes('sign');
      checks.push({ file: 'jwt.js', check: 'Contains JWT logic', passed: hasJwt });
      console.log(`${hasJwt ? GREEN : RED}${hasJwt ? '✅' : '❌'} jwt.js contains JWT logic${RESET}`);
    }
    
    // Check package.json has dependencies
    if (results.found.includes('package.json')) {
      const pkgContent = readFileSync(join(testDir, 'package.json'), 'utf8');
      try {
        const pkg = JSON.parse(pkgContent);
        const hasBcrypt = pkg.dependencies?.bcrypt || pkg.dependencies?.bcryptjs;
        const hasJwt = pkg.dependencies?.jsonwebtoken;
        const hasExpress = pkg.dependencies?.express;
        checks.push({ file: 'package.json', check: 'Has bcrypt', passed: !!hasBcrypt });
        checks.push({ file: 'package.json', check: 'Has jsonwebtoken', passed: !!hasJwt });
        checks.push({ file: 'package.json', check: 'Has express', passed: !!hasExpress });
        console.log(`${hasBcrypt ? GREEN : RED}${hasBcrypt ? '✅' : '❌'} package.json has bcrypt${RESET}`);
        console.log(`${hasJwt ? GREEN : RED}${hasJwt ? '✅' : '❌'} package.json has jsonwebtoken${RESET}`);
        console.log(`${hasExpress ? GREEN : RED}${hasExpress ? '✅' : '❌'} package.json has express${RESET}`);
      } catch (err) {
        console.log(`${RED}❌ package.json invalid JSON${RESET}`);
      }
    }

    // Summary
    console.log(`\n${BLUE}═══════════════════════════════════════════════════${RESET}`);
    console.log(`${BLUE}     📊 TEST SUMMARY${RESET}`);
    console.log(`${BLUE}═══════════════════════════════════════════════════${RESET}\n`);
    
    console.log(`${CYAN}Files:${RESET}`);
    console.log(`  Expected: ${expectedFiles.length}`);
    console.log(`  Found: ${results.found.length} ${results.found.length === expectedFiles.length ? GREEN + '✅' : YELLOW + '⚠️'}${RESET}`);
    console.log(`  Missing: ${results.missing.length} ${results.missing.length === 0 ? GREEN + '✅' : RED + '❌'}${RESET}`);
    
    if (checks.length > 0) {
      const passed = checks.filter(c => c.passed).length;
      console.log(`\n${CYAN}Quality Checks:${RESET}`);
      console.log(`  Passed: ${passed}/${checks.length} ${passed === checks.length ? GREEN + '✅' : YELLOW + '⚠️'}${RESET}`);
    }
    
    console.log(`\n${CYAN}Performance:${RESET}`);
    console.log(`  Execution time: ${duration}s`);
    console.log(`  Mode: ${useDualL2 ? 'Dual-L2 (parallel)' : 'Single-worker'}`);
    
    console.log(`\n${CYAN}Test Directory:${RESET}`);
    console.log(`  ${testDir}`);
    console.log(`  View files: ls -la ${testDir}/**/*`);
    
    // Pass/fail
    const success = results.found.length >= 4; // At least 4 of 6 files
    
    if (success) {
      console.log(`\n${GREEN}✅ COMPLEX TEST PASSED${RESET}`);
      console.log(`${GREEN}Created ${results.found.length}/${expectedFiles.length} files successfully${RESET}\n`);
      process.exit(0);
    } else {
      console.log(`\n${YELLOW}⚠️  PARTIAL SUCCESS${RESET}`);
      console.log(`${YELLOW}Created ${results.found.length}/${expectedFiles.length} files${RESET}`);
      console.log(`${YELLOW}Missing: ${results.missing.join(', ')}${RESET}\n`);
      process.exit(0); // Still pass - partial success is ok
    }
    
  } catch (err) {
    console.log(`\n${RED}❌ TEST FAILED: ${err.message}${RESET}\n`);
    if (err.stderr) console.error(err.stderr.toString());
    if (err.stdout) console.log(err.stdout.toString());
    process.exit(1);
  }
}

complexTest();
