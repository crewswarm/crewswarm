#!/usr/bin/env node

import { Command } from 'commander';
import { createMonitorCommand } from './commands/monitor';
import { logger } from './lib/logger';

const program = new Command();

program
  .name('crew-cli')
  .description('crewswarm command-line interface')
  .version('1.0.0');

// Add monitor command
program.addCommand(createMonitorCommand());

// Parse command-line arguments
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
