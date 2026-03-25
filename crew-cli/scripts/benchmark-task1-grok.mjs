#!/usr/bin/env node
/**
 * REAL BENCHMARK - Task 1: Simple Feature
 * 
 * Project: Todo App
 * Task: Add search & filter functionality
 * Expected: 3-5 files, 200-300 LOC, multiple agents
 * 
 * This tests:
 * - Multi-agent orchestration (Backend + Frontend + QA)
 * - Actual file generation
 * - Real cost tracking per agent
 * - Code quality audit
 */

import { UnifiedPipeline } from '../src/pipeline/unified.js';
import fs from 'fs';
import path from 'path';

const OUTPUT_DIR = '/home/user/benchmark-task1-grok';
const TASK = `Build search and filter functionality for a todo app in ${OUTPUT_DIR}/:

Requirements:
1. Backend API endpoint GET /api/todos/search?q=text&filter=status
2. Frontend search bar UI with filter dropdown (pending/completed/all)
3. Test file that validates search works correctly

Breakdown into work units:
- Unit 1: Backend API (crew-coder-back persona) - Create src/api/search.js with search endpoint
- Unit 2: Frontend UI (crew-coder-front persona) - Create public/search.html with search bar and filters
- Unit 3: Tests (crew-qa persona) - Create tests/search.test.js with unit tests

All files should be production-ready with error handling, validation, and comments.`;

async function runTask() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   REAL BENCHMARK - Task 1: Todo Search Feature              ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // Setup
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Configure Grok stack
  process.env.CREW_USE_UNIFIED_ROUTER = 'true';
  process.env.CREW_DUAL_L2_ENABLED = 'true';
  process.env.CREW_CHAT_MODEL = 'groq/llama-3.1-8b-instant';
  process.env.CREW_REASONING_MODEL = 'grok-4-1-fast-reasoning';
  process.env.CREW_EXECUTION_MODEL = 'groq/llama-3.1-8b-instant';

  console.log('Configuration:');
  console.log(`  Output: ${OUTPUT_DIR}`);
  console.log(`  L1 (Chat): ${process.env.CREW_CHAT_MODEL}`);
  console.log(`  L2 (Reasoning): ${process.env.CREW_REASONING_MODEL}`);
  console.log(`  L3 (Execution): ${process.env.CREW_EXECUTION_MODEL}`);
  console.log(`  Dual-L2: ${process.env.CREW_DUAL_L2_ENABLED}\n`);

  console.log('Task:');
  console.log(TASK);
  console.log('\n');

  const startTime = Date.now();
  
  try {
    const pipeline = new UnifiedPipeline();
    
    console.log('🚀 Starting execution...\n');
    
    const result = await pipeline.execute({
      userInput: TASK,
      context: `Real benchmark test - Task 1: Todo Search. Output directory: ${OUTPUT_DIR}`,
      sessionId: `benchmark-task1-${Date.now()}`
    });

    const totalTime = Date.now() - startTime;

    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║                     EXECUTION COMPLETE                       ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    console.log('📊 METRICS:\n');
    console.log(`  Total Time: ${(totalTime/1000).toFixed(1)}s`);
    console.log(`  Total Cost: $${result.totalCost.toFixed(6)}`);
    console.log(`  Execution Path: ${result.executionPath.join(' → ')}`);
    console.log(`  Decision: ${result.plan?.decision || 'N/A'}\n`);

    if (result.executionResults?.results) {
      console.log('📦 WORK UNITS EXECUTED:\n');
      result.executionResults.results.forEach((unit, i) => {
        console.log(`  ${i+1}. ${unit.persona} (${unit.workUnitId})`);
        console.log(`     Cost: $${unit.cost.toFixed(6)}`);
        console.log(`     Output: ${unit.output.substring(0, 80)}...`);
        console.log('');
      });
    }

    // Analyze output
    console.log('\n📁 GENERATED FILES:\n');
    
    const files = scanDirectory(OUTPUT_DIR);
    if (files.length === 0) {
      console.log('  ⚠️  No files generated - output may be in response text\n');
      console.log('  Response preview:');
      console.log(result.response.substring(0, 500) + '...\n');
    } else {
      files.forEach(file => {
        const stats = fs.statSync(file);
        const content = fs.readFileSync(file, 'utf8');
        const lines = content.split('\n').length;
        console.log(`  ${file}`);
        console.log(`    Size: ${stats.size} bytes | Lines: ${lines}`);
      });
      
      console.log(`\n  Total: ${files.length} files\n`);

      // Show code samples
      console.log('\n📝 CODE SAMPLES:\n');
      files.forEach(file => {
        const ext = path.extname(file);
        if (['.js', '.html', '.css'].includes(ext)) {
          const content = fs.readFileSync(file, 'utf8');
          console.log(`\n──── ${path.basename(file)} ────`);
          console.log(content.substring(0, 400));
          if (content.length > 400) console.log('...\n');
        }
      });

      // Quality audit
      console.log('\n🔍 CODE QUALITY AUDIT:\n');
      auditQuality(files);
    }

    // Cost breakdown
    console.log('\n💰 COST BREAKDOWN:\n');
    if (result.executionResults?.results) {
      const byPersona = {};
      result.executionResults.results.forEach(unit => {
        if (!byPersona[unit.persona]) byPersona[unit.persona] = { count: 0, cost: 0 };
        byPersona[unit.persona].count++;
        byPersona[unit.persona].cost += unit.cost;
      });

      Object.entries(byPersona).forEach(([persona, data]) => {
        console.log(`  ${persona.padEnd(20)} ${data.count} calls   $${data.cost.toFixed(6)}`);
      });
    }
    console.log(`  ${'Total'.padEnd(20)} ---       $${result.totalCost.toFixed(6)}`);

    console.log('\n\n✅ BENCHMARK COMPLETE\n');

  } catch (err) {
    console.error('\n❌ BENCHMARK FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

function scanDirectory(dir) {
  const files = [];
  
  function scan(d) {
    if (!fs.existsSync(d)) return;
    const entries = fs.readdirSync(d);
    entries.forEach(entry => {
      const fullPath = path.join(d, entry);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory() && !entry.startsWith('.')) {
        scan(fullPath);
      } else if (stat.isFile()) {
        files.push(fullPath);
      }
    });
  }
  
  scan(dir);
  return files;
}

function auditQuality(files) {
  let score = 0;
  let checks = 0;

  // Check 1: Has JavaScript files
  const jsFiles = files.filter(f => f.endsWith('.js'));
  if (jsFiles.length > 0) {
    console.log(`  ✅ Has JavaScript files (${jsFiles.length})`);
    score += 10;
  } else {
    console.log(`  ❌ No JavaScript files found`);
  }
  checks++;

  // Check 2: Has HTML files
  const htmlFiles = files.filter(f => f.endsWith('.html'));
  if (htmlFiles.length > 0) {
    console.log(`  ✅ Has HTML files (${htmlFiles.length})`);
    score += 10;
  } else {
    console.log(`  ⚠️  No HTML files (may be API-only)`);
    score += 5;
  }
  checks++;

  // Check 3: Has test files
  const testFiles = files.filter(f => f.includes('test') || f.includes('spec'));
  if (testFiles.length > 0) {
    console.log(`  ✅ Has test files (${testFiles.length})`);
    score += 20;
  } else {
    console.log(`  ❌ No test files found`);
  }
  checks++;

  // Check 4: Has error handling
  let hasErrorHandling = false;
  jsFiles.forEach(file => {
    const content = fs.readFileSync(file, 'utf8');
    if (/try|catch|throw|Error/.test(content)) {
      hasErrorHandling = true;
    }
  });
  if (hasErrorHandling) {
    console.log(`  ✅ Has error handling (try/catch)`);
    score += 20;
  } else {
    console.log(`  ❌ No error handling found`);
  }
  checks++;

  // Check 5: Has validation
  let hasValidation = false;
  jsFiles.forEach(file => {
    const content = fs.readFileSync(file, 'utf8');
    if (/if\s*\(.*\).*\{|validate|check/.test(content)) {
      hasValidation = true;
    }
  });
  if (hasValidation) {
    console.log(`  ✅ Has input validation`);
    score += 15;
  } else {
    console.log(`  ❌ No input validation found`);
  }
  checks++;

  // Check 6: Has comments
  let hasComments = false;
  files.forEach(file => {
    const content = fs.readFileSync(file, 'utf8');
    if (/\/\/|\/\*/.test(content)) {
      hasComments = true;
    }
  });
  if (hasComments) {
    console.log(`  ✅ Has code comments`);
    score += 10;
  } else {
    console.log(`  ⚠️  No comments found`);
  }
  checks++;

  // Check 7: Reasonable file count
  if (files.length >= 3 && files.length <= 10) {
    console.log(`  ✅ Reasonable file count (${files.length})`);
    score += 15;
  } else if (files.length > 0) {
    console.log(`  ⚠️  File count: ${files.length} (expected 3-10)`);
    score += 5;
  }
  checks++;

  const maxScore = 100;
  console.log(`\n  📊 Quality Score: ${score}/${maxScore}`);
  
  if (score >= 80) {
    console.log(`  🏆 EXCELLENT - Production ready`);
  } else if (score >= 60) {
    console.log(`  ✅ GOOD - Minor improvements needed`);
  } else if (score >= 40) {
    console.log(`  ⚠️  FAIR - Significant improvements needed`);
  } else {
    console.log(`  ❌ POOR - Major work needed`);
  }
}

runTask().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
