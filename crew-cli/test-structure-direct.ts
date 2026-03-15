/**
 * Direct test of structure analyzer from TypeScript source
 */
import { analyzeProjectStructure, formatStructureContext } from './src/utils/structure-analyzer.js';

async function test() {
  console.log('=== Structure Analyzer Test ===\n');
  
  const testDir = '/tmp/crew-test-react-1772445998';
  console.log('Project:', testDir);
  console.log('Starting analysis...\n');
  
  const startTime = Date.now();
  const structure = await analyzeProjectStructure(testDir);
  const elapsed = Date.now() - startTime;
  
  console.log('✓ Analysis complete in', elapsed, 'ms');
  console.log('✓ Cost: $0 (no LLM calls)\n');
  
  console.log('--- Detection Results ---');
  console.log('Framework:', structure.framework);
  console.log('Language:', structure.language);
  console.log('Has src/:', structure.hasSrc);
  console.log('Has components/:', structure.hasComponents);
  console.log('Component naming:', structure.conventions.componentNaming);
  console.log('Components path:', structure.conventions.components);
  console.log('Utils path:', structure.conventions.utils);
  
  console.log('\n--- Suggested Paths ---');
  console.log('LoginForm component →', structure.conventions.components + '/LoginForm.tsx');
  console.log('auth utils →', structure.conventions.utils + '/auth.ts');
  console.log('LoginForm test →', structure.conventions.tests + '/LoginForm.test.tsx');
  
  console.log('\n--- Formatted Context for LLM ---');
  const context = formatStructureContext(structure);
  console.log(context);
  
  console.log('\n✓ Structure analyzer integration test PASSED');
}

test().catch(err => {
  console.error('✗ Test failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
