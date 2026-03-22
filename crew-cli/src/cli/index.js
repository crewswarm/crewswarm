#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { AgentRouter } from '../agent/router.js';
import { ToolManager } from '../tools/manager.js';
import { ConfigManager } from '../config/manager.js';
import { Logger } from '../utils/logger.js';

const program = new Command();

export async function main(args = []) {
  const logger = new Logger();
  const config = new ConfigManager();
  const toolManager = new ToolManager(config);
  const agentRouter = new AgentRouter(config, toolManager);

  program
    .name('crew')
    .description('CrewSwarm CLI - Agent orchestration made simple')
    .version('0.1.0');

  program
    .command('dispatch')
    .description('Dispatch a task to an agent')
    .argument('<agent>', 'Agent name')
    .argument('<task>', 'Task description')
    .option('-p, --project <path>', 'Project directory')
    .option('-t, --timeout <ms>', 'Timeout in milliseconds', '30000')
    .action(async (agent, task, options) => {
      try {
        logger.info(`Dispatching task to ${agent}: ${task}`);
        const result = await agentRouter.dispatch(agent, task, options);
        logger.success('Task completed:', result);
      } catch (error) {
        logger.error('Dispatch failed:', error.message);
        process.exit(1);
      }
    });

  program
    .command('list')
    .description('List available agents')
    .action(async () => {
      try {
        const agents = await agentRouter.listAgents();
        agents.forEach(agent => {
          console.log(chalk.green(`✓ ${agent.name}`), chalk.gray(`- ${agent.role}`));
        });
      } catch (error) {
        logger.error('Failed to list agents:', error.message);
        process.exit(1);
      }
    });

  program
    .command('status')
    .description('Check system status')
    .action(async () => {
      try {
        const status = await agentRouter.getStatus();
        console.log(chalk.blue('System Status:'));
        console.log(`Agents Online: ${status.agentsOnline}`);
        console.log(`Tasks Active: ${status.tasksActive}`);
        console.log(`RT Bus: ${status.rtBusStatus}`);
      } catch (error) {
        logger.error('Status check failed:', error.message);
        process.exit(1);
      }
    });

  if (args.length === 0) {
    program.help();
  }

  await program.parseAsync(args);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
