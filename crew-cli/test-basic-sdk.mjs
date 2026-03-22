// Quick test of SharedDepsExecutor
import { CumulativeDiffSandbox } from './src/sandbox/cumulative-diff.js';
import { rmSync } from 'fs';

const testDir = '.test-basic';

try {
  rmSync(testDir, { recursive: true, force: true });
} catch {}

console.log('Testing CumulativeDiffSandbox...');

const sandbox = new CumulativeDiffSandbox(testDir);
await sandbox.load();

// Add some test files
await sandbox.addChange('test1.txt', 'Hello World\nLine 2');
await sandbox.addChange('test2.txt', 'Goodbye World');

console.log('✅ Files staged');

// Show diffs
const diff = sandbox.showDiffs();
console.log('\n--- DIFF OUTPUT ---');
console.log(diff);

// Check staged files
const staged = sandbox.getStagedFiles();
console.log('\n✅ Staged files:', staged);

// Test apply file
await sandbox.applyFile('test1.txt');
console.log('✅ Applied test1.txt');

// Test reject file
await sandbox.rejectFile('test2.txt');
console.log('✅ Rejected test2.txt');

console.log('\n✅ ALL BASIC TESTS PASSED');

rmSync(testDir, { recursive: true, force: true });
