/**
 * Session Continuity Example
 * 
 * Demonstrates:
 * - Multiple runs with previousRun state
 * - Building on previous work
 * - Maintaining context across tasks
 */

import { CrewClient } from '../src/sdk/index.js';
import chalk from 'chalk';

async function main() {
  console.log(chalk.blue('\n🔄 Crew CLI SDK - Session Continuity Example\n'));

  const client = new CrewClient({
    onProgress: (event) => {
      if (event.type === 'start') {
        console.log(chalk.cyan(`\n▶️  ${event.task}`));
      } else if (event.type === 'complete') {
        console.log(chalk.green('  ✓ Complete'));
      }
    },
  });

  try {
    // Run 1: Create a todo app
    console.log(chalk.yellow('\n=== RUN 1: Create Todo App ==='));
    const state1 = await client.run({
      task: 'Create a simple todo app with React and TypeScript. Include components for TodoList, TodoItem, and AddTodo. Use useState for state management.',
    });

    console.log(chalk.blue(`\nFiles from Run 1: ${state1.filePaths?.join(', ')}`));

    // Run 2: Add persistence (with context from Run 1)
    console.log(chalk.yellow('\n=== RUN 2: Add Persistence ==='));
    const state2 = await client.run({
      task: 'Add localStorage persistence to the todo app. Todos should be saved and loaded automatically.',
      previousRun: state1,  // ← SESSION CONTINUITY
    });

    console.log(chalk.blue(`\nFiles from Run 2: ${state2.filePaths?.join(', ')}`));

    // Run 3: Add styling (with context from Run 1 + Run 2)
    console.log(chalk.yellow('\n=== RUN 3: Add Styling ==='));
    const state3 = await client.run({
      task: 'Add beautiful CSS styling with a modern color scheme, smooth animations, and responsive design.',
      previousRun: state2,  // ← SESSION CONTINUITY
    });

    console.log(chalk.blue(`\nFiles from Run 3: ${state3.filePaths?.join(', ')}`));

    // Review all changes
    console.log(chalk.blue('\n📊 All Staged Changes:'));
    const diff = state3.sandbox.showDiffs();
    console.log(diff);

    // Apply all
    console.log(chalk.blue('\n💾 Apply all changes? (yes/no)'));
    const readline = await import('node:readline/promises');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const answer = await rl.question('> ');
    rl.close();

    if (answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y') {
      await state3.sandbox.applyAll();
      console.log(chalk.green('\n✅ All files written to disk!'));
    } else {
      console.log(chalk.yellow('\n⏭️  Skipped apply'));
    }

  } catch (err: unknown) {
    console.error(chalk.red(`\n❌ Failed: ${(err as Error).message}`));
    process.exit(1);
  }
}

main();
