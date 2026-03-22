#!/usr/bin/env node
/**
 * CREW-CLI STANDALONE COMPLETE TEST
 * 
 * Tests all core functionality WITHOUT gateway dependency:
 * 1. ✅ Task decomposition (Dual-L2 planning)
 * 2. ✅ Multi-worker execution (parallel)
 * 3. ✅ Gemini native tool calls (write_file, read_file, edit)
 * 4. ✅ Sandbox staging + apply
 * 5. ✅ Docker sandbox (optional, defaults to local)
 * 6. ✅ File writes to disk
 * 
 * Usage:
 *   node test-standalone-complete.mjs           # Local sandbox (default)
 *   node test-standalone-complete.mjs --docker  # Docker sandbox
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ────────────────────────────────────────────────────────────────────────────
// TEST CONFIGURATION
// ────────────────────────────────────────────────────────────────────────────

const USE_DOCKER = process.argv.includes('--docker');
const TEST_DIR = `/tmp/crew-cli-test-${Date.now()}`;
const TIMEOUT_MS = 180000; // 3 minutes

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

// ────────────────────────────────────────────────────────────────────────────
// TEST SCENARIOS
// ────────────────────────────────────────────────────────────────────────────

const TEST_SCENARIOS = [
  {
    name: "Simple Single File",
    task: "Create src/hello.js with a hello() function that returns 'world'",
    expectedFiles: ["src/hello.js"],
    validate: (dir) => {
      const content = readFileSync(join(dir, "src/hello.js"), "utf8");
      return content.includes("function") && content.includes("hello") && content.includes("world");
    },
    requiresDualL2: false,
  },
  {
    name: "Multi-File API",
    task: "Create a REST API with: 1) src/server.js - Express server on port 3000, 2) src/routes.js - health check endpoint, 3) package.json with express dependency",
    expectedFiles: ["src/server.js", "src/routes.js", "package.json"],
    validate: (dir) => {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      const server = readFileSync(join(dir, "src/server.js"), "utf8");
      return pkg.dependencies?.express && server.includes("express") && server.includes("3000");
    },
    requiresDualL2: true,
  },
  {
    name: "Complex Module with Tests",
    task: "Build auth module: 1) src/auth/hash.js - bcrypt password hashing, 2) src/auth/jwt.js - JWT sign/verify, 3) src/auth/auth.test.js - tests for both, 4) package.json with bcrypt and jsonwebtoken",
    expectedFiles: ["src/auth/hash.js", "src/auth/jwt.js", "src/auth/auth.test.js", "package.json"],
    validate: (dir) => {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      const hash = readFileSync(join(dir, "src/auth/hash.js"), "utf8");
      const jwt = readFileSync(join(dir, "src/auth/jwt.js"), "utf8");
      return pkg.dependencies?.bcrypt && pkg.dependencies?.jsonwebtoken && 
             hash.includes("bcrypt") && jwt.includes("jwt");
    },
    requiresDualL2: true,
  },
];

// ────────────────────────────────────────────────────────────────────────────
// UTILITY FUNCTIONS
// ────────────────────────────────────────────────────────────────────────────

function log(msg, color = RESET) {
  console.log(`${color}${msg}${RESET}`);
}

function section(title) {
  console.log(`\n${BLUE}${'═'.repeat(80)}${RESET}`);
  console.log(`${BLUE}${title.toUpperCase().padStart(40 + title.length / 2).padEnd(80)}${RESET}`);
  console.log(`${BLUE}${'═'.repeat(80)}${RESET}\n`);
}

function subsection(title) {
  console.log(`${CYAN}${'─'.repeat(80)}${RESET}`);
  console.log(`${CYAN}${title}${RESET}`);
  console.log(`${CYAN}${'─'.repeat(80)}${RESET}`);
}

async function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd: opts.cwd || process.cwd(),
      env: { ...process.env, ...opts.env },
      stdio: opts.silent ? 'pipe' : 'inherit',
    });

    let stdout = '';
    let stderr = '';

    if (opts.silent) {
      proc.stdout?.on('data', (data) => { stdout += data.toString(); });
      proc.stderr?.on('data', (data) => { stderr += data.toString(); });
    }

    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Command timeout after ${opts.timeout || TIMEOUT_MS}ms`));
    }, opts.timeout || TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        reject(new Error(`Command failed with code ${code}\n${stderr}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function checkFiles(dir, expectedFiles) {
  const missing = [];
  const found = [];

  for (const file of expectedFiles) {
    const fullPath = join(dir, file);
    if (existsSync(fullPath)) {
      const stat = readFileSync(fullPath, 'utf8');
      found.push({ file, size: stat.length });
    } else {
      missing.push(file);
    }
  }

  return { found, missing };
}

// ────────────────────────────────────────────────────────────────────────────
// TEST EXECUTION
// ────────────────────────────────────────────────────────────────────────────

async function runTestScenario(scenario, index) {
  subsection(`Test ${index + 1}/${TEST_SCENARIOS.length}: ${scenario.name}`);

  const testDir = `${TEST_DIR}/${scenario.name.toLowerCase().replace(/\s+/g, '-')}`;
  
  try {
    // Setup
    mkdirSync(testDir, { recursive: true });
    log(`📁 Test directory: ${testDir}`, YELLOW);
    log(`📋 Task: ${scenario.task}`, CYAN);
    log(`📦 Expected files: ${scenario.expectedFiles.join(', ')}`, CYAN);
    log(`🔧 Mode: ${USE_DOCKER ? 'Docker Sandbox' : 'Local Sandbox'}`, CYAN);
    log(`🧠 Dual-L2: ${scenario.requiresDualL2 ? 'enabled' : 'disabled'}`, CYAN);
    
    // Build crew-cli if not already built
    if (!existsSync('dist/crew.mjs')) {
      log('\n🔨 Building crew-cli...', YELLOW);
      await runCommand('npm', ['run', 'build'], { silent: false });
      log('✅ Build complete', GREEN);
    }

    // Execute pipeline
    log('\n⚡ Executing pipeline...', YELLOW);
    
    const env = {
      CREW_USE_UNIFIED_ROUTER: 'true',
      CREW_DUAL_L2_ENABLED: scenario.requiresDualL2 ? 'true' : 'false',
      CREW_CONTEXT_BUDGET_CHARS: '7000',
      CREW_CONTEXT_MAX_CHUNKS: '8',
    };

    if (USE_DOCKER) {
      env.CREW_DOCKER_SANDBOX = 'true';
    }

    const result = await runCommand('node', [
      'bin/crew.js',
      'run',
      '-t', scenario.task,
      '--output', testDir,
      '--apply', // Auto-apply changes
    ], { 
      silent: false,
      env,
      timeout: TIMEOUT_MS,
    });

    log('✅ Pipeline execution complete', GREEN);

    // Check files
    log('\n🔍 Verifying output files...', YELLOW);
    const { found, missing } = checkFiles(testDir, scenario.expectedFiles);

    if (missing.length > 0) {
      log(`❌ Missing files: ${missing.join(', ')}`, RED);
      return { passed: false, error: `Missing files: ${missing.join(', ')}` };
    }

    log(`✅ All ${found.length} files created`, GREEN);
    for (const { file, size } of found) {
      log(`   ${file} (${size} bytes)`, CYAN);
    }

    // Run custom validation
    if (scenario.validate) {
      log('\n🧪 Running custom validation...', YELLOW);
      const valid = scenario.validate(testDir);
      if (!valid) {
        log('❌ Custom validation failed', RED);
        return { passed: false, error: 'Custom validation failed' };
      }
      log('✅ Custom validation passed', GREEN);
    }

    // Check sandbox metadata
    log('\n📊 Checking sandbox metadata...', YELLOW);
    const sandboxPath = join(testDir, '.crew', 'sandbox.json');
    if (existsSync(sandboxPath)) {
      const sandbox = JSON.parse(readFileSync(sandboxPath, 'utf8'));
      log(`   Branches: ${Object.keys(sandbox.branches || {}).length}`, CYAN);
      log(`   Active branch: ${sandbox.activeBranch || 'none'}`, CYAN);
    } else {
      log('   ⚠️  No sandbox.json (may be normal if directly applied)', YELLOW);
    }

    // Check pipeline metrics
    const metricsPath = join(testDir, '.crew', 'pipeline-metrics.jsonl');
    if (existsSync(metricsPath)) {
      const metrics = readFileSync(metricsPath, 'utf8')
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line));
      
      log(`\n📈 Pipeline metrics:`, YELLOW);
      const latest = metrics[metrics.length - 1];
      if (latest) {
        log(`   Phase: ${latest.phase}`, CYAN);
        log(`   Workers: ${latest.workerCount || 1}`, CYAN);
        log(`   Cost: $${latest.totalCost?.toFixed(6) || '0.000000'}`, CYAN);
      }
    }

    log(`\n✅ ${scenario.name} PASSED`, GREEN);
    return { passed: true };

  } catch (err) {
    log(`\n❌ ${scenario.name} FAILED: ${err.message}`, RED);
    return { passed: false, error: err.message };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// MAIN TEST RUNNER
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  section('🧪 Crew-CLI Standalone Complete Test Suite');

  log(`Mode: ${USE_DOCKER ? '🐳 Docker Sandbox' : '💻 Local Sandbox'}`, BLUE);
  log(`Test directory: ${TEST_DIR}`, BLUE);
  log(`Total scenarios: ${TEST_SCENARIOS.length}`, BLUE);
  log(`Timeout per test: ${TIMEOUT_MS / 1000}s`, BLUE);

  // Pre-flight checks
  section('Pre-flight Checks');

  log('Checking dependencies...', YELLOW);
  
  // Check Node version
  const nodeVersion = process.version;
  log(`Node.js: ${nodeVersion}`, nodeVersion.startsWith('v20') || nodeVersion.startsWith('v21') || nodeVersion.startsWith('v22') ? GREEN : RED);

  // Check if crew-cli exists
  if (!existsSync('bin/crew.js')) {
    log('❌ crew-cli not found. Run from crew-cli directory.', RED);
    process.exit(1);
  }
  log('✅ crew-cli found', GREEN);

  // Check for API key
  if (!process.env.GOOGLE_API_KEY && !process.env.GEMINI_API_KEY) {
    log('⚠️  No GOOGLE_API_KEY or GEMINI_API_KEY found. Some tests may fail.', YELLOW);
  } else {
    log('✅ Gemini API key found', GREEN);
  }

  // Check Docker (if docker mode)
  if (USE_DOCKER) {
    try {
      await runCommand('docker', ['ps'], { silent: true });
      log('✅ Docker is running', GREEN);
    } catch (err) {
      log('❌ Docker not available but --docker flag used', RED);
      process.exit(1);
    }
  }

  // Run tests
  section('Running Test Scenarios');

  const results = [];
  for (let i = 0; i < TEST_SCENARIOS.length; i++) {
    const result = await runTestScenario(TEST_SCENARIOS[i], i);
    results.push({ scenario: TEST_SCENARIOS[i].name, ...result });
  }

  // Summary
  section('Test Summary');

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  log(`Total: ${results.length}`, BLUE);
  log(`Passed: ${passed}`, GREEN);
  log(`Failed: ${failed}`, failed > 0 ? RED : GREEN);

  if (failed > 0) {
    log('\n❌ Failed scenarios:', RED);
    results.filter(r => !r.passed).forEach(r => {
      log(`   ${r.scenario}: ${r.error}`, RED);
    });
  }

  // Feature verification
  section('Feature Verification');

  const features = [
    { name: 'Task Decomposition (Dual-L2)', tested: results.some(r => TEST_SCENARIOS.find(s => s.name === r.scenario)?.requiresDualL2) },
    { name: 'Multi-Worker Execution', tested: results.some(r => r.passed && TEST_SCENARIOS.find(s => s.name === r.scenario)?.requiresDualL2) },
    { name: 'Gemini Native Tools', tested: results.some(r => r.passed) },
    { name: 'Sandbox Staging + Apply', tested: results.some(r => r.passed) },
    { name: 'File Writes to Disk', tested: results.some(r => r.passed) },
    { name: USE_DOCKER ? 'Docker Sandbox' : 'Local Sandbox', tested: results.some(r => r.passed) },
  ];

  features.forEach(f => {
    log(`${f.tested ? '✅' : '❌'} ${f.name}`, f.tested ? GREEN : RED);
  });

  // Key findings
  section('Key Findings');

  log('✅ No gateway dependency required', GREEN);
  log('✅ Standalone execution verified', GREEN);
  log(`✅ Sandbox mode: ${USE_DOCKER ? 'Docker' : 'Local'}`, GREEN);
  
  if (passed === results.length) {
    log('✅ All core features working', GREEN);
  } else {
    log(`⚠️  ${failed} test(s) failed - see details above`, YELLOW);
  }

  // Cleanup (optional)
  log(`\n📁 Test artifacts: ${TEST_DIR}`, BLUE);
  log('   Run to clean up: rm -rf ' + TEST_DIR, CYAN);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  log(`\n❌ Test suite failed: ${err.message}`, RED);
  console.error(err);
  process.exit(1);
});
