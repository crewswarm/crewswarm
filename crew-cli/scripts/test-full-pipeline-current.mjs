#!/usr/bin/env node
/**
 * FULL PIPELINE TEST (Current State - No QA Loop)
 * 
 * Tests: L1 → L2A → L2B → L3 (all 12 units)
 * Shows: What we get WITHOUT the QA feedback loop
 */

import { UnifiedPipeline } from '../src/pipeline/unified.js';
import fs from 'fs';
import { config } from 'dotenv';
import path from 'path';

// Load .env from parent directory
const envPath = path.resolve(process.cwd(), '..', '.env');
config({ path: envPath });

const TASK = `Build MVP Phase 1 VS Code extension for CrewSwarm.

Output to: /Users/jeffhobbs/Desktop/benchmark-vscode-grok-FULL

Requirements:
1. Extension scaffold (package.json)
2. Webview chat UI with message bridge
3. API client for /v1/chat
4. Action parser, diff handler
5. Status bar, branding

Files: package.json, src/extension.ts, src/api-client.ts, src/webview/chat.html, src/webview/chat.js, src/webview/styles.css, src/diff-handler.ts, README.md, tests/extension.test.ts`;

async function runFullPipeline() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   FULL PIPELINE TEST (WITHOUT QA LOOP)                       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const outputDir = '/Users/jeffhobbs/Desktop/benchmark-vscode-grok-FULL';
  
  // Clean output directory
  if (fs.existsSync(outputDir)) {
    fs.rmSync(outputDir, { recursive: true });
  }
  fs.mkdirSync(outputDir, { recursive: true });

  // Configure Grok stack
  process.env.CREW_USE_UNIFIED_ROUTER = 'true';
  process.env.CREW_DUAL_L2_ENABLED = 'true';
  process.env.CREW_ALLOW_CRITICAL = 'true'; // Bypass policy validator for benchmark
  process.env.CREW_CHAT_MODEL = 'grok-4-1-fast-reasoning';
  process.env.CREW_REASONING_MODEL = 'grok-4-1-fast-reasoning';
  process.env.CREW_EXECUTION_MODEL = 'grok-4-1-fast-reasoning';

  console.log('Stack: Pure GROK');
  console.log('Output:', outputDir);
  console.log('\nExecuting L1 → L2A → L2B → L3...\n');

  const startTime = Date.now();

  try {
    const pipeline = new UnifiedPipeline();
    
    const result = await pipeline.execute({
      userInput: TASK,
      context: 'Full pipeline test - NO QA loop',
      sessionId: `full-test-${Date.now()}`
    });

    const totalTime = Date.now() - startTime;

    console.log('\n✅ PIPELINE COMPLETE\n');
    console.log('═'.repeat(70));
    console.log('EXECUTION SUMMARY');
    console.log('═'.repeat(70));
    console.log('');

    console.log(`Total Time: ${(totalTime/1000).toFixed(1)}s (${(totalTime/60000).toFixed(1)} min)`);
    console.log(`Total Cost: $${result.totalCost.toFixed(6)}`);
    console.log(`Decision: ${result.plan?.decision}`);
    console.log(`Path: ${result.executionPath.join(' → ')}`);
    console.log('');

    if (result.executionResults) {
      console.log(`Work Units Executed: ${result.executionResults.results.length}`);
      console.log(`Execution Time: ${(result.executionResults.executionTimeMs/1000).toFixed(1)}s`);
      console.log('');

      console.log('BY PERSONA:');
      const byPersona = {};
      result.executionResults.results.forEach(r => {
        if (!byPersona[r.persona]) byPersona[r.persona] = { count: 0, cost: 0 };
        byPersona[r.persona].count++;
        byPersona[r.persona].cost += r.cost;
      });

      Object.entries(byPersona).forEach(([persona, data]) => {
        console.log(`  ${persona.padEnd(25)} ${data.count} units   $${data.cost.toFixed(6)}`);
      });
    }

    console.log('\n');
    console.log('═'.repeat(70));
    console.log('OUTPUT ANALYSIS (What we got WITHOUT QA loop)');
    console.log('═'.repeat(70));
    console.log('');

    // Show what we actually got
    console.log('Response length:', result.response.length, 'chars');
    console.log('');
    console.log('Response preview (first 1000 chars):');
    console.log(result.response.substring(0, 1000));
    console.log('...\n');

    // Check for file content in response
    const hasPackageJson = /package\.json|"name":\s*"crew-vscode"/i.test(result.response);
    const hasTypeScript = /\.ts|typescript|interface|export/i.test(result.response);
    const hasHTML = /<html|<div|<button/i.test(result.response);
    const hasCSS = /\.css|{.*color:|background:/i.test(result.response);

    console.log('CONTENT CHECK:');
    console.log(`  ${hasPackageJson ? '✅' : '❌'} Contains package.json content`);
    console.log(`  ${hasTypeScript ? '✅' : '❌'} Contains TypeScript code`);
    console.log(`  ${hasHTML ? '✅' : '❌'} Contains HTML markup`);
    console.log(`  ${hasCSS ? '✅' : '❌'} Contains CSS styling`);

    console.log('\n');
    console.log('═'.repeat(70));
    console.log('WHAT\'S MISSING (No QA Loop)');
    console.log('═'.repeat(70));
    console.log('');

    console.log('❌ No crew-qa check of all work');
    console.log('❌ No verification that files integrate');
    console.log('❌ No crew-fixer for issues');
    console.log('❌ No final sign-off');
    console.log('❌ Files not written to disk - just concatenated text');
    console.log('');

    console.log('💡 WHAT SHOULD HAPPEN NEXT:\n');
    console.log('1. Send result.response back to L2 Router');
    console.log('2. L2 assigns to crew-qa persona');
    console.log('3. crew-qa audits all work units for:');
    console.log('   - Integration issues');
    console.log('   - Missing dependencies');
    console.log('   - Code quality problems');
    console.log('   - Security issues');
    console.log('4. If issues found:');
    console.log('   → L2 assigns to crew-fixer');
    console.log('   → crew-fixer makes corrections');
    console.log('   → Back to crew-qa for re-check');
    console.log('5. crew-qa signs off ✅');
    console.log('6. Write files to disk');
    console.log('');

    console.log('✅ TEST COMPLETE\n');

  } catch (err) {
    console.error('\n❌ FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

runFullPipeline().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
