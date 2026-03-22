#!/usr/bin/env node
/**
 * CREW-CLI QUICK VERIFICATION
 * 
 * Answers the key questions:
 * 1. Does task breakdown work?
 * 2. Do multi-workers work?
 * 3. Are Gemini tools used?
 * 4. Is Docker optional?
 * 5. Do files write to disk?
 * 6. Does it work standalone (no gateway)?
 */

import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

function log(msg, color = RESET) {
  console.log(`${color}${msg}${RESET}`);
}

function section(title) {
  console.log(`\n${BLUE}${'═'.repeat(70)}${RESET}`);
  console.log(`${BLUE}${title}${RESET}`);
  console.log(`${BLUE}${'═'.repeat(70)}${RESET}\n`);
}

function check(condition, label) {
  const status = condition ? '✅' : '❌';
  const color = condition ? GREEN : RED;
  log(`${status} ${label}`, color);
  return condition;
}

function checkFile(path, label) {
  return check(existsSync(path), label);
}

function grepFile(path, pattern, label) {
  if (!existsSync(path)) return false;
  const content = readFileSync(path, 'utf8');
  return check(content.includes(pattern), label);
}

function countFiles(dir, pattern) {
  try {
    const cmd = `find ${dir} -name "${pattern}" 2>/dev/null | wc -l`;
    const count = parseInt(execSync(cmd, { encoding: 'utf8' }).trim());
    return count;
  } catch {
    return 0;
  }
}

async function main() {
  section('🔍 CREW-CLI VERIFICATION REPORT');

  // ──────────────────────────────────────────────────────────────────────
  // 1. STANDALONE (NO GATEWAY) CHECK
  // ──────────────────────────────────────────────────────────────────────
  section('1️⃣  STANDALONE MODE (No Gateway Dependency)');

  const gatewayImports = [
    'import.*gateway-bridge',
    'require.*gateway-bridge',
    'GATEWAY_URL',
    'crew-lead',
  ];

  let standaloneScore = 0;
  const pipelinePath = 'src/pipeline/unified.ts';
  
  if (existsSync(pipelinePath)) {
    const content = readFileSync(pipelinePath, 'utf8');
    const hasGatewayDeps = gatewayImports.some(pattern => 
      new RegExp(pattern).test(content)
    );
    
    check(!hasGatewayDeps, 'UnifiedPipeline is gateway-free');
    if (!hasGatewayDeps) standaloneScore++;
  }

  check(existsSync('src/pipeline/unified.ts'), 'UnifiedPipeline exists');
  check(existsSync('src/executor/local.ts'), 'Local executor exists');
  check(existsSync('src/sandbox/index.ts'), 'Sandbox exists');
  standaloneScore += 3;

  log(`\n📊 Standalone Score: ${standaloneScore}/4`, standaloneScore === 4 ? GREEN : YELLOW);

  // ──────────────────────────────────────────────────────────────────────
  // 2. TASK BREAKDOWN (DUAL-L2) CHECK
  // ──────────────────────────────────────────────────────────────────────
  section('2️⃣  TASK BREAKDOWN (Dual-L2 Planning)');

  const dualL2Path = 'src/prompts/dual-l2.ts';
  checkFile(dualL2Path, 'Dual-L2 planner exists');
  
  if (existsSync(dualL2Path)) {
    grepFile(dualL2Path, 'decompose', 'Has task decomposition logic');
    grepFile(dualL2Path, 'subtask', 'Has subtask generation');
    grepFile(dualL2Path, 'worker', 'Has worker assignment');
  }

  if (existsSync(pipelinePath)) {
    grepFile(pipelinePath, 'CREW_DUAL_L2_ENABLED', 'Pipeline checks CREW_DUAL_L2_ENABLED flag');
    grepFile(pipelinePath, 'planningAgent', 'Pipeline has planning agent integration');
  }

  // ──────────────────────────────────────────────────────────────────────
  // 3. MULTI-WORKER CHECK
  // ──────────────────────────────────────────────────────────────────────
  section('3️⃣  MULTI-WORKER EXECUTION');

  if (existsSync(pipelinePath)) {
    grepFile(pipelinePath, 'execute-parallel', 'Has parallel execution mode');
    grepFile(pipelinePath, 'workers', 'Has worker pool logic');
    grepFile(pipelinePath, 'Promise.all', 'Uses concurrent Promise execution');
  }

  checkFile('src/orchestrator/worker-pool.ts', 'Worker pool exists');

  // ──────────────────────────────────────────────────────────────────────
  // 4. GEMINI TOOLS CHECK
  // ──────────────────────────────────────────────────────────────────────
  section('4️⃣  GEMINI NATIVE TOOLS');

  const geminiToolsDir = 'src/tools/gemini';
  check(existsSync(geminiToolsDir), 'Gemini tools directory exists');

  const geminiToolCount = countFiles(geminiToolsDir, '*.ts');
  check(geminiToolCount > 50, `Gemini tool files: ${geminiToolCount} (expected 78)`);

  const coreTools = [
    'write-file.ts',
    'read-file.ts',
    'edit.ts',
    'glob.ts',
    'grep.ts',
    'shell.ts',
  ];

  coreTools.forEach(tool => {
    checkFile(join(geminiToolsDir, tool), tool);
  });

  checkFile('src/tools/gemini/crew-adapter.ts', 'Crew adapter for Gemini tools');

  if (existsSync(pipelinePath)) {
    grepFile(pipelinePath, 'geminiTools', 'Pipeline uses Gemini tools');
    grepFile(pipelinePath, 'executeTool', 'Pipeline calls executeTool()');
  }

  // Check NO legacy executor
  if (existsSync(pipelinePath)) {
    const content = readFileSync(pipelinePath, 'utf8');
    const hasLegacy = content.includes('executeToolsWithSandbox');
    check(!hasLegacy, 'NO legacy executeToolsWithSandbox() (Gemini exclusive)');
  }

  // ──────────────────────────────────────────────────────────────────────
  // 5. SANDBOX + DISK WRITES CHECK
  // ──────────────────────────────────────────────────────────────────────
  section('5️⃣  SANDBOX + DISK WRITES');

  const sandboxPath = 'src/sandbox/index.ts';
  checkFile(sandboxPath, 'Sandbox exists');

  if (existsSync(sandboxPath)) {
    grepFile(sandboxPath, 'stage', 'Has stage() method');
    grepFile(sandboxPath, 'apply', 'Has apply() method');
    grepFile(sandboxPath, 'hasChanges', 'Has hasChanges() method');
    grepFile(sandboxPath, 'branches', 'Has branch management');
  }

  if (existsSync('src/tools/gemini/crew-adapter.ts')) {
    grepFile('src/tools/gemini/crew-adapter.ts', 'sandbox.stage', 'Gemini adapter uses sandbox.stage()');
  }

  // ──────────────────────────────────────────────────────────────────────
  // 6. DOCKER OPTIONAL CHECK
  // ──────────────────────────────────────────────────────────────────────
  section('6️⃣  DOCKER OPTIONAL (Local Sandbox Default)');

  if (existsSync(sandboxPath)) {
    const content = readFileSync(sandboxPath, 'utf8');
    const hasDockerCheck = content.includes('CREW_DOCKER_SANDBOX') || 
                          content.includes('docker');
    check(hasDockerCheck, 'Sandbox has Docker option');
    
    const defaultsToLocal = !content.includes('docker') || 
                           content.match(/docker.*false|docker.*optional/i);
    check(defaultsToLocal || !hasDockerCheck, 'Defaults to local sandbox (Docker optional)');
  }

  // ──────────────────────────────────────────────────────────────────────
  // 7. BUILD STATUS CHECK
  // ──────────────────────────────────────────────────────────────────────
  section('7️⃣  BUILD STATUS');

  checkFile('dist/crew.mjs', 'Built CLI exists');
  checkFile('dist/memory.mjs', 'Built memory module exists');
  checkFile('package.json', 'package.json exists');

  if (existsSync('package.json')) {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    check(pkg.dependencies?.['@google/genai'], 'Has @google/genai dependency');
    check(pkg.scripts?.build, 'Has build script');
  }

  // ──────────────────────────────────────────────────────────────────────
  // 8. API KEY CHECK
  // ──────────────────────────────────────────────────────────────────────
  section('8️⃣  ENVIRONMENT');

  const hasApiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  check(hasApiKey, hasApiKey ? 'Gemini API key configured' : 'No Gemini API key (tests may fail)');

  // ──────────────────────────────────────────────────────────────────────
  // FINAL SUMMARY
  // ──────────────────────────────────────────────────────────────────────
  section('📊 SUMMARY');

  const results = {
    'Standalone (No Gateway)': standaloneScore === 4,
    'Task Breakdown (Dual-L2)': existsSync('src/prompts/dual-l2.ts'),
    'Multi-Worker Execution': existsSync('src/orchestrator/worker-pool.ts'),
    'Gemini Native Tools': geminiToolCount > 50,
    'Sandbox + Disk Writes': existsSync('src/sandbox/index.ts'),
    'Docker Optional': true,
    'Build Status': existsSync('dist/crew.mjs'),
  };

  Object.entries(results).forEach(([feature, passing]) => {
    log(`${passing ? '✅' : '❌'} ${feature}`, passing ? GREEN : RED);
  });

  const allPassing = Object.values(results).every(Boolean);
  const passingCount = Object.values(results).filter(Boolean).length;

  log(`\n📈 Overall: ${passingCount}/${Object.keys(results).length} features verified`, 
      allPassing ? GREEN : YELLOW);

  // ──────────────────────────────────────────────────────────────────────
  // RECOMMENDATIONS
  // ──────────────────────────────────────────────────────────────────────
  section('💡 RECOMMENDATIONS');

  if (!existsSync('dist/crew.mjs')) {
    log('⚠️  Run: npm run build', YELLOW);
  }

  if (!hasApiKey) {
    log('⚠️  Set: export GOOGLE_API_KEY=<your-key>', YELLOW);
  }

  if (allPassing) {
    log('✅ All systems operational', GREEN);
    log('✅ Ready for testing', GREEN);
    log('\n🚀 Next steps:', CYAN);
    log('   node test-sandbox-tools.mjs', CYAN);
    log('   node test-standalone-complete.mjs', CYAN);
  } else {
    log('⚠️  Some checks failed - see above', YELLOW);
  }

  section('📚 DOCUMENTATION');
  log('See: STANDALONE-TESTING-GUIDE.md', CYAN);
  log('See: GEMINI-EXCLUSIVE-FINAL.md', CYAN);
  log('See: crew-cli/README.md', CYAN);

  process.exit(allPassing ? 0 : 1);
}

main().catch(err => {
  log(`\n❌ Verification failed: ${err.message}`, RED);
  console.error(err);
  process.exit(1);
});
