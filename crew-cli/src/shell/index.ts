import { AgentRouter } from '../agent/router.js';
import { Logger } from '../utils/logger.js';
import chalk from 'chalk';
// Lazy-loaded to avoid blocking bundle import (inquirer v9 uses top-level await)
const getInquirer = () => import('inquirer').then(m => m.default);
import { runPtyCommand } from '../pty/index.js';
import { platform, release } from 'node:os';

export interface ShellCopilotOptions {
  projectDir?: string;
  gateway?: string;
  model?: string;
}

export async function runShellCopilot(
  request: string,
  router: AgentRouter,
  options: ShellCopilotOptions = {}
): Promise<void> {
  const logger = new Logger();
  const projectDir = options.projectDir || process.cwd();
  
  const systemContext = `You are a shell command assistant (like GitHub Copilot CLI).
The user is on ${platform()} ${release()}.
Provide a single valid shell command that answers the user's request.
Then provide a brief explanation of the command.
DO NOT EXECUTE ANY TOOLS. DO NOT RUN COMMANDS. Just output the text.

Format your output EXACTLY like this:
COMMAND:
\`\`\`bash
<the exact shell command>
\`\`\`

EXPLANATION:
<brief explanation of what the command does, arguments, etc.>
`;

  let currentRequest = request;
  
  while (true) {
    logger.info(`Translating request into shell command...`);
    
    let result;
    try {
      const fullTask = `${systemContext}\n\nUser Request: ${currentRequest}`;
      result = await router.dispatch('crew-main', fullTask, {
        project: projectDir,
        gateway: options.gateway,
        model: options.model,
        skipPreamble: true,
        injectGitContext: false,
        direct: true,
        bypass: true
      });
    } catch (err) {
      logger.error(`Failed to generate command: ${(err as Error).message}`);
      return;
    }

    const text = String(result.result || '');
    
    const commandMatch = text.match(/COMMAND:\s*```(?:bash|sh)?\s*([\s\S]*?)\s*```/i) || text.match(/```(?:bash|sh)?\s*([\s\S]*?)\s*```/i);
    const explanationMatch = text.match(/EXPLANATION:\s*([\s\S]*)/i);
    
    let command = commandMatch ? commandMatch[1].trim() : '';
    let explanation = explanationMatch ? explanationMatch[1].trim() : text.trim();
    
    if (!command) {
      // Fallback if formatting failed but it looks like a command
      const lines = text.split('\n').filter(l => l.trim().length > 0);
      if (lines.length > 0 && !lines[0].includes(' ')) {
         command = lines[0];
         explanation = text;
      } else {
         logger.error('Could not parse a valid command from the response.');
         console.log(chalk.gray(text));
         return;
      }
    }

    console.log(chalk.blue('\n--- Proposed Command ---'));
    console.log(chalk.green.bold(`> ${command}`));
    console.log(chalk.gray(`\n${explanation}\n`));

    const inquirer = await getInquirer();
    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: 'What would you like to do?',
      choices: [
        { name: 'Run this command', value: 'run' },
        { name: 'Revise query', value: 'revise' },
        { name: 'Cancel', value: 'cancel' }
      ]
    }]);

    if (action === 'cancel') {
      logger.info('Cancelled.');
      return;
    }

    if (action === 'revise') {
      const { newQuery } = await (await getInquirer()).prompt([{
        type: 'input',
        name: 'newQuery',
        message: 'Revise your query:',
        default: currentRequest
      }]);
      currentRequest = newQuery;
      continue; // loop back
    }

    if (action === 'run') {
      logger.info(`Executing: ${command}`);
      try {
         const ptyResult = await runPtyCommand(command, { cwd: projectDir });
         if (!ptyResult.success) {
           process.exit(ptyResult.exitCode || 1);
         }
      } catch (err) {
         logger.error(`Execution failed: ${(err as Error).message}`);
      }
      return;
    }
  }
}
