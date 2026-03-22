#!/usr/bin/env node
/**
 * Test L2A Decomposer + L2B Validator
 * 
 * This tests the ACTUAL dual-L2 pipeline that:
 * 1. L2A breaks task into work units with persona assignments
 * 2. L2B validates the work graph for risk/cost
 */

import { DualL2Planner } from '../src/prompts/dual-l2.js';

const TASK = `Build the MVP (Phase 1) of a VS Code extension for CrewSwarm.

Output to: /Users/jeffhobbs/Desktop/benchmark-vscode-test

Requirements:
1. Extension scaffold with package.json
2. Webview chat UI with message bridge
3. API client for POST /v1/chat
4. Action parser for patches/files
5. Diff preview and apply
6. Status bar with connection status
7. Basic branding

Files needed:
- package.json
- src/extension.ts
- src/api-client.ts
- src/webview/chat.html
- src/webview/chat.js
- src/webview/styles.css
- src/diff-handler.ts
- README.md
- tests/extension.test.ts`;

async function testDualL2() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║       TEST L2A DECOMPOSER + L2B VALIDATOR                    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // Set Grok as the model
  process.env.CREW_REASONING_MODEL = 'grok-4-1-fast-reasoning';

  console.log('Task:');
  console.log(TASK);
  console.log('\n');
  console.log('Expected: L2A should break this into work units with personas like:');
  console.log('  - crew-pm: Create architecture plan');
  console.log('  - crew-coder-back: Build extension.ts and API client');
  console.log('  - crew-coder-front: Build webview UI');
  console.log('  - crew-qa: Create tests');
  console.log('  - etc.\n');

  const planner = new DualL2Planner();
  const traceId = `test-${Date.now()}`;

  try {
    console.log('🔄 Starting L2A Decomposer...\n');
    const startL2A = Date.now();
    
    const result = await planner.plan(
      TASK,
      'Benchmark test for VS Code extension MVP',
      traceId
    );
    
    const timeL2A = Date.now() - startL2A;

    console.log(`✅ Dual-L2 Complete (${(timeL2A/1000).toFixed(1)}s)\n`);
    console.log('═'.repeat(70));
    console.log('WORK GRAPH (L2A Decomposer Output)');
    console.log('═'.repeat(70));
    console.log('');

    console.log(`Total Complexity: ${result.workGraph.totalComplexity}/10`);
    console.log(`Estimated Cost: $${result.workGraph.estimatedCost.toFixed(4)}`);
    console.log(`Required Personas: ${result.workGraph.requiredPersonas.join(', ')}`);
    console.log(`Total Work Units: ${result.workGraph.units.length}\n`);

    console.log('WORK UNITS:\n');
    result.workGraph.units.forEach((unit, i) => {
      console.log(`${i+1}. [${unit.requiredPersona}] ${unit.description}`);
      console.log(`   Complexity: ${unit.estimatedComplexity}`);
      console.log(`   Capabilities: ${unit.requiredCapabilities.join(', ')}`);
      if (unit.dependencies.length > 0) {
        console.log(`   Dependencies: ${unit.dependencies.join(', ')}`);
      }
      console.log('');
    });

    console.log('═'.repeat(70));
    console.log('VALIDATION (L2B Policy Validator Output)');
    console.log('═'.repeat(70));
    console.log('');

    console.log(`Approved: ${result.validation.approved ? '✅ YES' : '❌ NO'}`);
    console.log(`Risk Level: ${result.validation.riskLevel.toUpperCase()}`);
    console.log(`Estimated Cost: $${result.validation.estimatedCost.toFixed(4)}`);

    if (result.validation.concerns.length > 0) {
      console.log(`\nConcerns:`);
      result.validation.concerns.forEach(c => console.log(`  ⚠️  ${c}`));
    }

    if (result.validation.recommendations.length > 0) {
      console.log(`\nRecommendations:`);
      result.validation.recommendations.forEach(r => console.log(`  💡 ${r}`));
    }

    console.log('\n');
    console.log('═'.repeat(70));
    console.log('ANALYSIS');
    console.log('═'.repeat(70));
    console.log('');

    // Check if proper roles were assigned
    const hasBackend = result.workGraph.requiredPersonas.some(p => 
      p.includes('back') || p === 'crew-coder'
    );
    const hasFrontend = result.workGraph.requiredPersonas.some(p => 
      p.includes('front') || p.includes('ui')
    );
    const hasQA = result.workGraph.requiredPersonas.some(p => 
      p.includes('qa') || p.includes('test')
    );
    const hasPM = result.workGraph.requiredPersonas.some(p => 
      p.includes('pm') || p.includes('architect')
    );

    console.log('Role Assignment Check:');
    console.log(`  ${hasBackend ? '✅' : '❌'} Backend role assigned`);
    console.log(`  ${hasFrontend ? '✅' : '❌'} Frontend role assigned`);
    console.log(`  ${hasQA ? '✅' : '❌'} QA/Test role assigned`);
    console.log(`  ${hasPM ? '✅' : '❌'} PM/Planning role assigned`);

    console.log('');
    console.log(`Timing: ${(timeL2A/1000).toFixed(1)}s total`);
    console.log(`Work Units: ${result.workGraph.units.length}`);
    console.log(`Personas: ${result.workGraph.requiredPersonas.length}`);

    console.log('\n✅ TEST COMPLETE\n');

  } catch (err) {
    console.error('\n❌ TEST FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

testDualL2().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
