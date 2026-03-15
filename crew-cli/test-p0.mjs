#!/usr/bin/env node

/**
 * Quick Smoke Test for P0 Features
 * 
 * Tests:
 * 1. SharedDepsExecutor generates coherent files
 * 2. CumulativeDiffSandbox shows diffs and applies selectively
 * 3. CLI commands work (diff, apply-file, reject)
 * 4. SDK Client API works with events
 */

import { SharedDepsExecutor } from './src/executor/shared-deps.js';
import { CumulativeDiffSandbox } from './src/sandbox/cumulative-diff.js';
import { CrewClient } from './src/sdk/index.js';
import chalk from 'chalk';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = join(process.cwd(), '.test-smoke');

function log(emoji, message) {
  console.log(`${emoji} ${message}`);
}

function success(message) {
  log('✅', chalk.green(message));
}

function error(message) {
  log('❌', chalk.red(message));
}

function info(message) {
  log('ℹ️ ', chalk.blue(message));
}

async function cleanup() {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}
}

async function test1_SharedDeps() {
  console.log(chalk.yellow('\n' + '='.repeat(70)));
  console.log(chalk.yellow('TEST 1: SharedDepsExecutor - Coherent Multi-File Generation'));
  console.log(chalk.yellow('='.repeat(70)));

  try {
    const executor = new SharedDepsExecutor();
    const sandbox = new CumulativeDiffSandbox(TEST_DIR);
    await sandbox.load();

    info('Generating Chrome extension...');
    
    const result = await executor.execute(
      'Create a Chrome extension with manifest.json and background.js. Use extension ID "my-chrome-ext-v1".',
      sandbox
    );

    // Check shared deps
    if (!result.sharedDeps || result.sharedDeps.length < 50) {
      error('SharedDeps too short or missing');
      return false;
    }
    success(`Generated shared deps (${result.sharedDeps.length} chars)`);

    // Check file paths
    if (!result.filePaths || result.filePaths.length < 2) {
      error(`Expected at least 2 files, got ${result.filePaths?.length || 0}`);
      return false;
    }
    success(`Generated ${result.filePaths.length} file paths: ${result.filePaths.join(', ')}`);

    // Check file contents
    if (result.files.size < 2) {
      error(`Expected at least 2 files, got ${result.files.size}`);
      return false;
    }
    success(`Generated ${result.files.size} files`);

    // Check for consistency: extension ID should appear in shared deps
    if (!result.sharedDeps.includes('my-chrome-ext')) {
      error('Extension ID not found in shared deps');
      return false;
    }
    success('Extension ID found in shared deps');

    // Check that files were staged
    const staged = sandbox.getStagedFiles();
    if (staged.length < 3) {  // shared-deps.md + at least 2 files
      error(`Expected at least 3 staged files, got ${staged.length}`);
      return false;
    }
    success(`Staged ${staged.length} files: ${staged.join(', ')}`);

    success('TEST 1 PASSED ✨');
    return true;

  } catch (err) {
    error(`TEST 1 FAILED: ${err.message}`);
    console.error(err);
    return false;
  }
}

async function test2_CumulativeDiff() {
  console.log(chalk.yellow('\n' + '='.repeat(70)));
  console.log(chalk.yellow('TEST 2: CumulativeDiffSandbox - Diff Viewing & Selective Apply'));
  console.log(chalk.yellow('='.repeat(70)));

  await cleanup();

  try {
    const sandbox = new CumulativeDiffSandbox(TEST_DIR);
    await sandbox.load();

    info('Adding changes to sandbox...');
    await sandbox.addChange('file1.txt', 'Hello World\nLine 2\nLine 3');
    await sandbox.addChange('file2.txt', 'Goodbye World\nLine 2');
    await sandbox.addChange('file3.txt', 'Test File\nAnother Line');

    // Test showDiffs
    info('Showing diffs...');
    const diff = sandbox.showDiffs();
    
    if (!diff.includes('file1.txt')) {
      error('Diff missing file1.txt');
      return false;
    }
    if (!diff.includes('+ Hello World')) {
      error('Diff missing added content');
      return false;
    }
    if (!diff.includes('crew apply')) {
      error('Diff missing instructions');
      return false;
    }
    success('Diff output looks correct');

    // Test applyFile
    info('Applying file1.txt...');
    await sandbox.applyFile('file1.txt');
    
    const staged = sandbox.getStagedFiles();
    if (staged.includes('file1.txt')) {
      error('file1.txt still staged after apply');
      return false;
    }
    if (!existsSync(join(TEST_DIR, 'file1.txt'))) {
      error('file1.txt not written to disk');
      return false;
    }
    success('file1.txt applied successfully');

    // Test rejectFile
    info('Rejecting file2.txt...');
    await sandbox.rejectFile('file2.txt');
    
    const staged2 = sandbox.getStagedFiles();
    if (staged2.includes('file2.txt')) {
      error('file2.txt still staged after reject');
      return false;
    }
    if (existsSync(join(TEST_DIR, 'file2.txt'))) {
      error('file2.txt exists on disk (should be rejected)');
      return false;
    }
    success('file2.txt rejected successfully');

    // Verify file3 still staged
    if (!staged2.includes('file3.txt')) {
      error('file3.txt missing from staging');
      return false;
    }
    success('file3.txt still staged (correct)');

    success('TEST 2 PASSED ✨');
    return true;

  } catch (err) {
    error(`TEST 2 FAILED: ${err.message}`);
    console.error(err);
    return false;
  }
}

async function test3_SDKClient() {
  console.log(chalk.yellow('\n' + '='.repeat(70)));
  console.log(chalk.yellow('TEST 3: SDK Client - Programmatic API with Events'));
  console.log(chalk.yellow('='.repeat(70)));

  await cleanup();

  try {
    const events = [];
    
    const client = new CrewClient({
      cwd: TEST_DIR,
      onProgress: (event) => {
        events.push(event.type);
        info(`Event: ${event.type}`);
      },
    });

    info('Running task...');
    const state = await client.run({
      task: 'Create a simple hello.js file that exports a greet function',
    });

    // Check events
    if (!events.includes('start')) {
      error('Missing "start" event');
      return false;
    }
    if (!events.includes('shared_deps_complete')) {
      error('Missing "shared_deps_complete" event');
      return false;
    }
    if (!events.includes('complete')) {
      error('Missing "complete" event');
      return false;
    }
    success(`Emitted ${events.length} events: ${[...new Set(events)].join(', ')}`);

    // Check state
    if (!state.sharedDeps) {
      error('Missing sharedDeps in state');
      return false;
    }
    success('State includes sharedDeps');

    if (!state.filePaths || state.filePaths.length === 0) {
      error('Missing filePaths in state');
      return false;
    }
    success(`State includes ${state.filePaths.length} file paths`);

    if (state.history.length !== 1) {
      error(`Expected 1 history entry, got ${state.history.length}`);
      return false;
    }
    success('History tracking works');

    success('TEST 3 PASSED ✨');
    return true;

  } catch (err) {
    error(`TEST 3 FAILED: ${err.message}`);
    console.error(err);
    return false;
  }
}

async function main() {
  console.log(chalk.blue.bold('\n🧪 SMOKE TEST: P0 Features\n'));

  // Check API keys
  const hasGemini = !!process.env.GEMINI_API_KEY || !!process.env.GOOGLE_API_KEY;
  const hasGrok = !!process.env.XAI_API_KEY;
  const hasDeepSeek = !!process.env.DEEPSEEK_API_KEY;

  if (!hasGemini && !hasGrok && !hasDeepSeek) {
    error('No API keys found! Set GEMINI_API_KEY, XAI_API_KEY, or DEEPSEEK_API_KEY');
    process.exit(1);
  }

  info(`API Keys: Gemini=${hasGemini}, Grok=${hasGrok}, DeepSeek=${hasDeepSeek}`);

  // Run tests
  const results = {
    test1: await test1_SharedDeps(),
    test2: await test2_CumulativeDiff(),
    test3: await test3_SDKClient(),
  };

  // Cleanup
  await cleanup();

  // Summary
  console.log(chalk.yellow('\n' + '='.repeat(70)));
  console.log(chalk.yellow('SUMMARY'));
  console.log(chalk.yellow('='.repeat(70)));

  const passed = Object.values(results).filter(r => r).length;
  const total = Object.keys(results).length;

  console.log(`Test 1 (SharedDeps):       ${results.test1 ? chalk.green('PASS') : chalk.red('FAIL')}`);
  console.log(`Test 2 (CumulativeDiff):   ${results.test2 ? chalk.green('PASS') : chalk.red('FAIL')}`);
  console.log(`Test 3 (SDK Client):       ${results.test3 ? chalk.green('PASS') : chalk.red('FAIL')}`);
  console.log(chalk.yellow('='.repeat(70)));
  console.log(`${chalk.bold(`${passed}/${total} tests passed`)}`);

  if (passed === total) {
    console.log(chalk.green.bold('\n✅ ALL TESTS PASSED! 🎉\n'));
    process.exit(0);
  } else {
    console.log(chalk.red.bold('\n❌ SOME TESTS FAILED\n'));
    process.exit(1);
  }
}

main();
