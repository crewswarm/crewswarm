/**
 * Basic SDK Usage Example
 * 
 * Demonstrates:
 * - Creating a CrewClient
 * - Running a task with progress events
 * - Reviewing staged changes
 * - Applying files to disk
 */

import { CrewClient } from '../src/sdk/index.js';
import chalk from 'chalk';

async function main() {
  console.log(chalk.blue('\n🚀 Crew CLI SDK Example\n'));

  // Create client with progress handler
  const client = new CrewClient({
    onProgress: (event) => {
      switch (event.type) {
        case 'start':
          console.log(chalk.cyan(`\n▶️  Starting: ${event.task}`));
          break;
        
        case 'shared_deps_start':
          console.log(chalk.gray('  📋 Generating shared dependencies...'));
          break;
        
        case 'shared_deps_complete':
          console.log(chalk.green(`  ✓ Shared dependencies (${event.sharedDeps.length} chars)`));
          break;
        
        case 'file_paths_complete':
          console.log(chalk.green(`  ✓ File paths: ${event.filePaths.join(', ')}`));
          break;
        
        case 'file_generation_complete':
          console.log(chalk.gray(`  📄 Generated: ${event.filePath}`));
          break;
        
        case 'complete':
          console.log(chalk.green(`\n✅ Complete!`));
          console.log(`   Files generated: ${event.output.filesGenerated}`);
          break;
        
        case 'error':
          console.log(chalk.red(`\n❌ Error: ${event.message}`));
          break;
      }
    },
  });

  try {
    // First run: Create a calculator
    const runState1 = await client.run({
      task: 'Create a calculator class in TypeScript with add, subtract, multiply, and divide methods. Include proper types and error handling.',
    });

    console.log(chalk.blue('\n📁 Files created:'));
    runState1.filePaths?.forEach(path => {
      console.log(`   - ${path}`);
    });

    // Show staged changes
    console.log(chalk.blue('\n📊 Staged changes:'));
    console.log(runState1.sandbox.showDiffs());

    // Apply all changes
    console.log(chalk.blue('\n💾 Applying changes to disk...'));
    await runState1.sandbox.applyAll();
    console.log(chalk.green('✓ All files written to disk'));

  } catch (err: any) {
    console.error(chalk.red(`\n❌ Failed: ${err.message}`));
    process.exit(1);
  }
}

main();
