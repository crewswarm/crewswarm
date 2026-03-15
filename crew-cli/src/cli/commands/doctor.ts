/**
 * `crew doctor` and `crew update` command definitions.
 *
 * Extracted from src/cli/index.ts to reduce file size.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import {
  compareVersions,
  getInstalledCliVersion,
  getLatestCliVersion,
  isGlobalInstallLinked,
  runDoctorChecks,
  summarizeDoctorResults
} from '../../diagnostics/doctor.js';
import type { Logger } from '../../utils/logger.js';

/**
 * Register the `doctor` and `update` subcommands on the given Commander program.
 */
export function registerDoctorCommands(program: Command, logger: Logger) {
  program
    .command('doctor')
    .description('Run local diagnostics (Node, Git, config, gateway)')
    .option('-g, --gateway <url>', 'Gateway URL to check', 'http://localhost:5010')
    .option('--update-tag <tag>', 'Version channel for update check', 'latest')
    .action(async options => {
      const checks = await runDoctorChecks({ gateway: options.gateway, updateTag: options.updateTag });
      const summary = summarizeDoctorResults(checks);

      console.log(chalk.blue('crew doctor'));
      checks.forEach(check => {
        let marker = check.ok ? chalk.green('\u2713') : chalk.red('\u2717');
        if (check.name === 'CLI update status' && String(check.details || '').toLowerCase().includes('update available')) {
          marker = chalk.yellow('!');
        }
        console.log(`${marker} ${check.name} ${chalk.gray(`(${check.details})`)}`);
      });

      const summaryColor = summary.failed === 0 ? chalk.green : chalk.red;
      console.log(summaryColor(`Passed: ${summary.passed}  Failed: ${summary.failed}`));

      if (summary.failed > 0) {
        process.exit(1);
      }
    });

  program
    .command('update')
    .description('Check for updates and install latest crew-cli globally')
    .option('--check', 'Only check availability, do not install', false)
    .option('--tag <tag>', 'Update channel/tag (default: latest)', 'latest')
    .option('-y, --yes', 'Skip confirmation prompt', false)
    .action(async options => {
      try {
        const installed = await getInstalledCliVersion();
        const latest = await getLatestCliVersion(options.tag || 'latest');

        if (!latest) {
          if (options.check) {
            logger.warn('Unable to check latest version from npm right now.');
            return;
          }
          logger.error('Unable to check latest version from npm.');
          process.exit(1);
        }

        if (!installed) {
          logger.warn(`Current version unknown. Latest available: ${latest}`);
        } else {
          const cmp = compareVersions(installed, latest);
          if (cmp >= 0) {
            logger.success(`Already up to date (${installed}).`);
            return;
          }
          logger.info(`Update available: ${installed} -> ${latest}`);
        }

        if (options.check) {
          return;
        }

        const linked = await isGlobalInstallLinked();
        if (linked) {
          logger.warn('Global npm link detected. Update may replace the linked install.');
        }

        if (!options.yes) {
          const { confirm } = await (await import('inquirer')).default.prompt([{
            type: 'confirm',
            name: 'confirm',
            message: `Install crewswarm-cli@${options.tag || 'latest'} globally now?`,
            default: true
          }]);
          if (!confirm) {
            logger.warn('Update cancelled.');
            return;
          }
        }

        const { spawn } = await import('node:child_process');
        await new Promise((resolve, reject) => {
          const child = spawn('npm', ['install', '-g', `crewswarm-cli@${options.tag || 'latest'}`], {
            stdio: 'inherit',
            shell: false
          });
          child.on('error', reject);
          child.on('close', code => {
            if (code === 0) resolve(null);
            else reject(new Error(`npm install exited with code ${code}`));
          });
        });

        const refreshed = await getLatestCliVersion(options.tag || 'latest');
        logger.success(`Updated crew-cli to ${refreshed || options.tag || 'latest'}.`);
      } catch (error) {
        logger.error('Update failed:', (error as Error).message);
        process.exit(1);
      }
    });
}
