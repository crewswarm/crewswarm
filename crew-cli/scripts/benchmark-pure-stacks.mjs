#!/usr/bin/env node
/**
 * PURE STACK BENCHMARK - VS Code Extension Build
 * 
 * Tests 3 pure provider stacks (no mixing):
 * 1. GROK-ONLY (all tiers use Grok)
 * 2. DEEPSEEK-ONLY (all tiers use DeepSeek)
 * 3. GEMINI-ONLY (all tiers use Gemini)
 * 
 * Each outputs to separate folder for side-by-side comparison
 */

import { UnifiedPipeline } from '../src/pipeline/unified.js';
import fs from 'fs';
import path from 'path';

const TASK = `Build the MVP (Phase 1) of a VS Code extension for CrewSwarm per the specs in:
- /Users/jeffhobbs/Desktop/CrewSwarm/crew-cli/ide-extension/ROADMAP.md
- /Users/jeffhobbs/Desktop/CrewSwarm/crew-cli/ide-extension/PDD.md

Output to: {{OUTPUT_DIR}}

Requirements from ROADMAP Phase 1:
1. Extension scaffold with package.json and command contributions
2. Webview chat UI with message bridge (extension <-> webview)
3. API client for POST /v1/chat with streaming support
4. Action parser for patches/files/commands from response
5. Diff preview and apply flow via WorkspaceEdit
6. Status bar item showing connection status
7. Basic branding (icon, colors, name)

Deliverables (create these files):
- package.json with VS Code extension manifest
- src/extension.ts (main extension entry point)
- src/api-client.ts (CrewSwarm API integration)
- src/webview/chat.html (chat UI)
- src/webview/chat.js (webview logic)
- src/webview/styles.css (UI styling)
- src/diff-handler.ts (patch preview/apply)
- README.md (setup and usage instructions)
- tests/extension.test.ts (basic tests)

All code must be production-ready with error handling, TypeScript types, and comments.`;

const STACKS = [
  {
    name: 'GROK',
    outputDir: '/Users/jeffhobbs/Desktop/benchmark-vscode-grok',
    config: {
      CREW_CHAT_MODEL: 'grok-4-1-fast-reasoning',
      CREW_REASONING_MODEL: 'grok-4-1-fast-reasoning',
      CREW_EXECUTION_MODEL: 'grok-4-1-fast-reasoning'
    }
  },
  {
    name: 'DEEPSEEK',
    outputDir: '/Users/jeffhobbs/Desktop/benchmark-vscode-deepseek',
    config: {
      CREW_CHAT_MODEL: 'deepseek-chat',
      CREW_REASONING_MODEL: 'deepseek-reasoner',
      CREW_EXECUTION_MODEL: 'deepseek-chat'
    }
  },
  {
    name: 'GEMINI',
    outputDir: '/Users/jeffhobbs/Desktop/benchmark-vscode-gemini',
    config: {
      CREW_CHAT_MODEL: 'gemini-2.5-flash',
      CREW_REASONING_MODEL: 'gemini-2.5-flash',
      CREW_EXECUTION_MODEL: 'gemini-2.5-flash-lite'
    }
  }
];

async function testStack(stack) {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║   ${stack.name.padEnd(58)} ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // Create output directory
  if (fs.existsSync(stack.outputDir)) {
    fs.rmSync(stack.outputDir, { recursive: true });
  }
  fs.mkdirSync(stack.outputDir, { recursive: true });

  // Set environment
  process.env.CREW_USE_UNIFIED_ROUTER = 'true';
  process.env.CREW_DUAL_L2_ENABLED = 'true';
  for (const [key, value] of Object.entries(stack.config)) {
    process.env[key] = value;
  }

  console.log('Configuration:');
  console.log(`  L1 (Chat):      ${stack.config.CREW_CHAT_MODEL}`);
  console.log(`  L2 (Reasoning): ${stack.config.CREW_REASONING_MODEL}`);
  console.log(`  L3 (Execution): ${stack.config.CREW_EXECUTION_MODEL}`);
  console.log(`  Output:         ${stack.outputDir}\n`);

  const taskWithOutput = TASK.replace('{{OUTPUT_DIR}}', stack.outputDir);
  const startTime = Date.now();

  try {
    // Enable verbose logging
    process.env.LOG_LEVEL = 'info';
    process.env.CREW_VERBOSE = 'true';
    
    const pipeline = new UnifiedPipeline();
    
    console.log('🚀 Starting execution...\n');
    console.log('⏱️  Timestamp: Pipeline.execute() called\n');
    
    const execStart = Date.now();
    const result = await pipeline.execute({
      userInput: taskWithOutput,
      context: `Benchmark test - ${stack.name} pure stack. VS Code extension MVP build.`,
      sessionId: `benchmark-${stack.name.toLowerCase()}-${Date.now()}`
    });
    
    console.log(`⏱️  Timestamp: Pipeline.execute() returned after ${(Date.now() - execStart)/1000}s\n`);

    const totalTime = Date.now() - startTime;

    console.log('\n✅ EXECUTION COMPLETE\n');
    console.log(`  Time: ${(totalTime/1000).toFixed(1)}s`);
    console.log(`  Cost: $${result.totalCost.toFixed(6)}`);
    console.log(`  Path: ${result.executionPath.join(' → ')}`);
    console.log(`  Decision: ${result.plan?.decision || 'N/A'}\n`);

    // Analyze output
    const files = scanDirectory(stack.outputDir);
    
    console.log(`📁 Generated ${files.length} files:\n`);
    files.forEach(file => {
      const rel = path.relative(stack.outputDir, file);
      const stats = fs.statSync(file);
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n').length;
      console.log(`  ${rel.padEnd(40)} ${lines} lines`);
    });

    // Quick quality check
    const quality = quickAudit(files);
    console.log(`\n📊 Quality Score: ${quality.score}/100\n`);
    
    return {
      stack: stack.name,
      success: true,
      time: totalTime,
      cost: result.totalCost,
      files: files.length,
      quality: quality.score,
      details: quality.details,
      outputDir: stack.outputDir
    };

  } catch (err) {
    const totalTime = Date.now() - startTime;
    console.log(`\n❌ FAILED: ${err.message}\n`);
    console.log(`  Time: ${(totalTime/1000).toFixed(1)}s\n`);
    
    return {
      stack: stack.name,
      success: false,
      time: totalTime,
      error: err.message,
      outputDir: stack.outputDir
    };
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

function quickAudit(files) {
  let score = 0;
  const details = [];

  // Check 1: Has package.json
  if (files.some(f => f.endsWith('package.json'))) {
    score += 15;
    details.push('✅ Has package.json');
  } else {
    details.push('❌ Missing package.json');
  }

  // Check 2: Has TypeScript files
  const tsFiles = files.filter(f => f.endsWith('.ts'));
  if (tsFiles.length >= 3) {
    score += 15;
    details.push(`✅ Has ${tsFiles.length} TypeScript files`);
  } else {
    details.push(`❌ Only ${tsFiles.length} TypeScript files (need 3+)`);
  }

  // Check 3: Has webview files
  const hasHTML = files.some(f => f.endsWith('.html'));
  const hasCSS = files.some(f => f.endsWith('.css'));
  if (hasHTML && hasCSS) {
    score += 15;
    details.push('✅ Has HTML + CSS webview files');
  } else {
    details.push('❌ Missing webview files (HTML/CSS)');
  }

  // Check 4: Has README
  if (files.some(f => f.endsWith('README.md'))) {
    score += 10;
    details.push('✅ Has README.md');
  } else {
    details.push('❌ Missing README.md');
  }

  // Check 5: Has tests
  const testFiles = files.filter(f => f.includes('test') || f.includes('spec'));
  if (testFiles.length > 0) {
    score += 15;
    details.push(`✅ Has ${testFiles.length} test file(s)`);
  } else {
    details.push('❌ No test files');
  }

  // Check 6: Code quality checks
  let hasErrorHandling = false;
  let hasTypes = false;
  let hasComments = false;
  
  tsFiles.forEach(file => {
    const content = fs.readFileSync(file, 'utf8');
    if (/try|catch|throw|Error/.test(content)) hasErrorHandling = true;
    if (/interface|type|:\s*\w+/.test(content)) hasTypes = true;
    if (/\/\/|\/\*/.test(content)) hasComments = true;
  });

  if (hasErrorHandling) {
    score += 10;
    details.push('✅ Has error handling');
  }
  if (hasTypes) {
    score += 10;
    details.push('✅ Has TypeScript types');
  }
  if (hasComments) {
    score += 10;
    details.push('✅ Has code comments');
  }

  return { score, details };
}

async function runBenchmark() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║     PURE STACK BENCHMARK - VS Code Extension Build          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('\nTesting 3 pure provider stacks (no mixing):');
  console.log('  1. GROK-ONLY');
  console.log('  2. DEEPSEEK-ONLY');
  console.log('  3. GEMINI-ONLY\n');
  console.log('Each outputs to separate folder for comparison.\n');

  const results = [];

  for (const stack of STACKS) {
    const result = await testStack(stack);
    results.push(result);
    
    console.log('\n⏳ Waiting 5s before next test...\n');
    await new Promise(r => setTimeout(r, 5000));
  }

  // Final comparison
  console.log('\n\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                   FINAL COMPARISON                           ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  if (successful.length > 0) {
    console.log('| Stack | Time | Cost | Files | Quality | Output |');
    console.log('|-------|------|------|-------|---------|--------|');
    successful.forEach(r => {
      console.log(`| ${r.stack.padEnd(8)} | ${(r.time/1000).toFixed(1)}s | $${r.cost.toFixed(4)} | ${r.files} | ${r.quality}/100 | ${path.basename(r.outputDir)} |`);
    });

    console.log('\n\n🏆 WINNERS:\n');
    const fastest = [...successful].sort((a, b) => a.time - b.time)[0];
    const cheapest = [...successful].sort((a, b) => a.cost - b.cost)[0];
    const bestQuality = [...successful].sort((a, b) => b.quality - a.quality)[0];

    console.log(`  ⚡ FASTEST:      ${fastest.stack} (${(fastest.time/1000).toFixed(1)}s)`);
    console.log(`  💰 CHEAPEST:     ${cheapest.stack} ($${cheapest.cost.toFixed(4)})`);
    console.log(`  💎 BEST QUALITY: ${bestQuality.stack} (${bestQuality.quality}/100)`);

    console.log('\n\n📊 DETAILED QUALITY BREAKDOWN:\n');
    successful.forEach(r => {
      console.log(`${r.stack}:`);
      r.details.forEach(d => console.log(`  ${d}`));
      console.log('');
    });

    console.log('\n📂 OUTPUT DIRECTORIES:\n');
    successful.forEach(r => {
      console.log(`  ${r.stack}: ${r.outputDir}`);
    });
    console.log('\n  Compare outputs side-by-side to see code quality differences!\n');
  }

  if (failed.length > 0) {
    console.log(`\n❌ FAILED STACKS: ${failed.length}\n`);
    failed.forEach(r => {
      console.log(`  ${r.stack}: ${r.error}`);
    });
  }

  console.log('\n✅ BENCHMARK COMPLETE\n');
}

runBenchmark().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
