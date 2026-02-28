#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { AgentRouter } from '../agent/router.js';
import { ToolManager } from '../tools/manager.js';
import { ConfigManager } from '../config/manager.js';
import { Logger } from '../utils/logger.js';
import { SessionManager } from '../session/manager.js';
import { Sandbox } from '../sandbox/index.js';
import { Orchestrator } from '../orchestrator/index.js';
import { TokenFinder } from '../auth/token-finder.js';
import { Planner } from '../planner/index.js';
import { runDoctorChecks, summarizeDoctorResults } from '../diagnostics/doctor.js';
import { compareModelCosts, estimateCost, getCheapestAlternative } from '../cost/predictor.js';
import { CorrectionStore } from '../learning/corrections.js';
import { runEngine } from '../engines/index.js';
import { startWatchMode } from '../watch/index.js';
import { collectMultiRepoContext, detectBreakingApiSignals, findSiblingRepos, getRepoSummary, syncRepoSnapshots } from '../multirepo/index.js';
import { runCiFixLoop } from '../ci/index.js';
import { compareScreenshots, runBrowserDebug } from '../browser/index.js';
import { downloadTeamContext, getTeamSyncStatus, loadPrivacyControls, savePrivacyControls, uploadTeamContext } from '../team/index.js';
import { appendVoiceTranscript, recordAudio, speakWithSkill, transcribeAudio } from '../voice/listener.js';

const program = new Command();

export async function main(args = []) {
  const logger = new Logger();
  const config = new ConfigManager();
  const toolManager = new ToolManager(config);
  const agentRouter = new AgentRouter(config, toolManager);
  const sessionManager = new SessionManager(process.cwd());
  const sandbox = new Sandbox(process.cwd());
  const orchestrator = new Orchestrator(agentRouter, sandbox, sessionManager);
  const corrections = new CorrectionStore(process.cwd());

  await sessionManager.ensureInitialized();
  await toolManager.initialize();
  await sandbox.load();

  program
    .name('crew')
    .description('CrewSwarm CLI - Agent orchestration made simple')
    .version('0.1.0');

  program
    .command('chat')
    .description('Chat with CrewSwarm (automatically routed to best agent)')
    .argument('<input...>', 'Message or question')
    .option('-p, --project <path>', 'Project directory')
    .option('--cross-repo', 'Inject sibling repository context', false)
    .action(async (inputArray, options) => {
      let input = inputArray.join(' ');
      try {
        if (options.crossRepo) {
          const multiContext = await collectMultiRepoContext(options.project || process.cwd());
          input = `${input}\n\n${multiContext}`;
        }

        const route = await orchestrator.route(input);
        const projectDir = options.project || process.cwd();
        
        if (route.decision === 'CHAT' || route.decision === 'CODE' || route.decision === 'DISPATCH') {
          const agent = route.agent || 'crew-main';
          logger.info(`Routing to ${agent} (Decision: ${route.decision})`);
          
          const result = await agentRouter.dispatch(agent, input, {
            project: projectDir,
            sessionId: await sessionManager.getSessionId()
          });

          console.log(chalk.blue('\n--- Agent Response ---'));
          logger.printWithHighlight(String(result.result || ''));
          
          // Try to parse any edits
          const edits = await orchestrator.parseAndApplyToSandbox(result.result);
          if (edits.length > 0) {
            logger.success(`Added changes to ${edits.length} files in sandbox. Run "crew preview" to review.`);
          }
        } else if (route.decision === 'SKILL') {
          logger.info('Detected skill request. Please use "crew skill <name>" for now.');
        }
      } catch (error) {
        logger.error('Chat failed:', error.message);
        process.exit(1);
      }
    });

  program
    .command('dispatch')
    .description('Dispatch a task to an agent')
    .argument('<agent>', 'Agent name')
    .argument('<task>', 'Task description')
    .option('-p, --project <path>', 'Project directory')
    .option('-t, --timeout <ms>', 'Timeout in milliseconds', '30000')
    .option('-m, --model <id>', 'Model ID for cost estimate', 'openai/gpt-4o-mini')
    .option('--output-tokens <count>', 'Expected completion tokens for estimate', '1200')
    .option('--max-cost <usd>', 'Require confirmation if estimate exceeds this USD amount', '1')
    .option('--skip-cost-check', 'Skip cost estimate confirmation gate', false)
    .option('--cross-repo', 'Inject sibling repository context', false)
    .action(async (agent, task, options) => {
      let finalTask = task;
      try {
        if (options.crossRepo) {
          const multiContext = await collectMultiRepoContext(options.project || process.cwd());
          finalTask = `${task}\n\n${multiContext}`;
        }

        const sessionId = await sessionManager.getSessionId();
        const projectDir = options.project || process.cwd();
        const outputTokens = Number.parseInt(options.outputTokens || '1200', 10);
        const maxCost = Number.parseFloat(options.maxCost || '1');
        const estimate = estimateCost(finalTask, options.model, outputTokens);
        const cheapest = getCheapestAlternative(finalTask, outputTokens);

        logger.info(
          `Estimated cost (${estimate.model}): $${estimate.totalUsd.toFixed(4)} ` +
          `(in:${estimate.inputTokens} tok, out:${estimate.outputTokens} tok)`
        );

        if (cheapest.model !== estimate.model) {
          logger.info(
            `Cheaper alternative: ${cheapest.model} ($${cheapest.totalUsd.toFixed(4)})`
          );
        }

        if (!options.skipCostCheck && estimate.totalUsd > maxCost) {
          const { confirm } = await (await import('inquirer')).default.prompt([{
            type: 'confirm',
            name: 'confirm',
            message: `Estimated cost $${estimate.totalUsd.toFixed(4)} exceeds limit $${maxCost.toFixed(2)}. Continue?`,
            default: false
          }]);

          if (!confirm) {
            logger.warn('Dispatch cancelled by cost guard.');
            return;
          }
        }

        const dispatchOptions = {
          ...options,
          project: projectDir,
          sessionId
        };

        await sessionManager.appendHistory({
          type: 'dispatch_request',
          agent,
          task: finalTask,
          projectDir
        });

        logger.info(`Dispatching task to ${agent}: ${finalTask}`);
        const result = await agentRouter.dispatch(agent, finalTask, dispatchOptions);

        await sessionManager.appendHistory({
          type: 'dispatch_result',
          agent,
          taskId: result.taskId || null,
          success: Boolean(result.success),
          result: result.result
        });
        await sessionManager.appendRouting({
          route: 'DISPATCH',
          model: result.model || 'unknown',
          agent,
          taskId: result.taskId || null
        });
        await sessionManager.trackCost({
          model: result.model || estimate.model || 'unknown',
          usd: result.costUsd || estimate.totalUsd || 0,
          promptTokens: result.promptTokens || estimate.inputTokens || 0,
          completionTokens: result.completionTokens || estimate.outputTokens || 0
        });

        logger.success('Task completed:', result);
      } catch (error) {
        await sessionManager.appendHistory({
          type: 'dispatch_error',
          agent,
          task: finalTask,
          error: error.message
        });
        logger.error('Dispatch failed:', error.message);
        process.exit(1);
      }
    });

  program
    .command('repos-scan')
    .description('Detect sibling git repositories')
    .action(async () => {
      const repos = await findSiblingRepos(process.cwd());
      if (repos.length === 0) {
        console.log(chalk.yellow('No sibling repositories found.'));
        return;
      }
      console.log(chalk.blue('Sibling repos:'));
      repos.forEach(path => console.log(`- ${path}`));
    });

  program
    .command('repos-context')
    .description('Show cross-repo context for sibling repositories')
    .action(async () => {
      const context = await collectMultiRepoContext(process.cwd());
      console.log(context);
    });

  program
    .command('repos-sync')
    .description('Sync and store sibling repository snapshots to .crew/multi-repo-sync.json')
    .action(async () => {
      const outPath = await syncRepoSnapshots(process.cwd());
      logger.success(`Wrote snapshot to ${outPath}`);
    });

  program
    .command('repos-warn')
    .description('Warn about potential cross-repo API breaking changes')
    .action(async () => {
      const repos = await findSiblingRepos(process.cwd());
      if (repos.length === 0) {
        console.log(chalk.yellow('No sibling repositories found.'));
        return;
      }

      let hasWarnings = false;
      for (const repo of repos) {
        const summary = await getRepoSummary(repo);
        const warnings = await detectBreakingApiSignals(repo);
        if (warnings.length > 0) {
          hasWarnings = true;
          console.log(chalk.red(`\n[${summary.name}]`));
          warnings.forEach(w => console.log(`- ${w}`));
        }
      }

      if (!hasWarnings) {
        console.log(chalk.green('No obvious API-breaking signals detected in sibling repos.'));
      }
    });

  program
    .command('sync')
    .description('Upload/download team context and merge team corrections')
    .option('--upload', 'Upload local .crew session/corrections to team store')
    .option('--download', 'Download shared team context into local .crew')
    .option('--status', 'Show team sync status and privacy controls')
    .action(async options => {
      if (options.upload) {
        const result = await uploadTeamContext(process.cwd());
        logger.success(`Uploaded team context: ${result.sessionOut}, ${result.correctionsOut}`);
      }
      if (options.download) {
        const result = await downloadTeamContext(process.cwd());
        logger.success(`Downloaded/merged team context. Corrections entries: ${result.mergedCount}`);
      }
      if (options.status || (!options.upload && !options.download)) {
        const status = await getTeamSyncStatus(process.cwd());
        console.log(chalk.blue('--- Team Sync Status ---'));
        console.log(`Dir: ${status.teamDir}`);
        console.log(`Files: ${status.files.length}`);
        console.log(`Privacy: ${JSON.stringify(status.privacy)}`);
      }
    });

  program
    .command('privacy')
    .description('Configure privacy controls for team sync')
    .option('--preset <name>', 'full | metadata | no-content')
    .option('--share-prompt <bool>', 'true|false')
    .option('--share-original <bool>', 'true|false')
    .option('--share-corrected <bool>', 'true|false')
    .option('--share-tags <bool>', 'true|false')
    .action(async options => {
      const current = await loadPrivacyControls(process.cwd());
      const parseBool = (value: string | undefined, fallback: boolean) => {
        if (value === undefined) return fallback;
        return String(value).toLowerCase() === 'true';
      };

      let next = { ...current };
      if (options.preset) {
        const preset = String(options.preset).toLowerCase();
        if (preset === 'full') {
          next = { sharePrompt: true, shareOriginal: true, shareCorrected: true, shareTags: true };
        } else if (preset === 'metadata') {
          next = { sharePrompt: false, shareOriginal: false, shareCorrected: false, shareTags: true };
        } else if (preset === 'no-content') {
          next = { sharePrompt: false, shareOriginal: false, shareCorrected: false, shareTags: false };
        }
      }

      next = {
        sharePrompt: parseBool(options.sharePrompt, next.sharePrompt),
        shareOriginal: parseBool(options.shareOriginal, next.shareOriginal),
        shareCorrected: parseBool(options.shareCorrected, next.shareCorrected),
        shareTags: parseBool(options.shareTags, next.shareTags)
      };

      await savePrivacyControls(next, process.cwd());
      logger.success(`Saved privacy controls: ${JSON.stringify(next)}`);
    });

  program
    .command('listen')
    .description('Voice mode: record speech, transcribe via Whisper, run command, and optionally speak response')
    .option('--duration-sec <n>', 'Recording duration in seconds', '6')
    .option('--provider <id>', 'STT provider: auto | openai | whisper-cli', 'auto')
    .option('--text <value>', 'Skip recording and use raw text directly')
    .option('--continuous', 'Keep listening in a loop', false)
    .option('--max-rounds <n>', 'Maximum rounds in continuous mode', '5')
    .option('--no-tts', 'Disable TTS response playback')
    .option('--tts-skill <id>', 'CrewSwarm skill for TTS', 'elevenlabs.tts')
    .action(async options => {
      const durationSec = Number.parseInt(options.durationSec || '6', 10);
      const maxRounds = Math.max(1, Number.parseInt(options.maxRounds || '5', 10));
      let round = 0;

      while (true) {
        round += 1;
        if (options.continuous) {
          logger.progress(round - 1, maxRounds, 'Listen');
        }

        let userText = String(options.text || '').trim();
        if (!userText) {
          logger.info(`Listening for ${durationSec}s...`);
          const audioPath = await recordAudio({ durationSec });
          userText = await transcribeAudio(audioPath, {
            provider: options.provider
          });
        }

        if (!userText) {
          logger.warn('No speech detected.');
          if (!options.continuous || round >= maxRounds) break;
          continue;
        }

        await appendVoiceTranscript(process.cwd(), 'user', userText);
        logger.info(`Heard: ${userText}`);

        const route = await orchestrator.route(userText);
        const agent = route.agent || 'crew-main';
        const response = await agentRouter.dispatch(agent, userText, {
          sessionId: await sessionManager.getSessionId(),
          project: process.cwd()
        });

        const responseText = String(response.result || '');
        logger.printWithHighlight(responseText);
        await appendVoiceTranscript(process.cwd(), 'assistant', responseText);

        if (options.tts) {
          try {
            await speakWithSkill(agentRouter, responseText, options.ttsSkill || 'elevenlabs.tts');
            logger.success(`Spoken via ${options.ttsSkill || 'elevenlabs.tts'}`);
          } catch (ttsErr) {
            logger.warn(`TTS failed: ${(ttsErr as Error).message}`);
          }
        }

        if (!options.continuous || round >= maxRounds) {
          if (options.continuous) {
            logger.progress(maxRounds, maxRounds, 'Listen');
          }
          break;
        }
      }
    });

  program
    .command('estimate')
    .description('Estimate token usage and compare model costs before execution')
    .argument('<task...>', 'Task or prompt text')
    .option('--output-tokens <count>', 'Expected completion tokens', '1200')
    .action((taskArray, options) => {
      const task = taskArray.join(' ');
      const outputTokens = Number.parseInt(options.outputTokens || '1200', 10);
      const estimates = compareModelCosts(task, outputTokens);

      console.log(chalk.blue('--- Cost Estimates (lowest first) ---'));
      estimates.forEach(item => {
        console.log(
          `${chalk.green(item.model)} ` +
          `total=$${item.totalUsd.toFixed(4)} ` +
          `(in ${item.inputTokens} tok, out ${item.outputTokens} tok)`
        );
      });
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

  program
    .command('history')
    .description('Show recent session activity history')
    .option('-n, --limit <count>', 'Number of entries to show', '5')
    .action(async (options) => {
      const session = await sessionManager.loadSession();
      const limit = Number.parseInt(options.limit || '5', 10);
      const entries = session.history.slice(-limit);

      console.log(chalk.blue(`--- Recent History (${entries.length} entries) ---`));
      entries.forEach((e: any, i: number) => {
        const time = e.timestamp.split('T')[1].split('.')[0];
        console.log(`${chalk.gray(`[${time}]`)} ${chalk.bold(e.type)}: ${e.agent || e.skill || ''}`);
        if (e.task) console.log(chalk.gray(`  Task: ${e.task.slice(0, 60)}...`));
      });
    });

  program
    .command('cost')
    .description('Show total usage cost summary')
    .option('--summary', 'Show breakdown by model', true)
    .action(async () => {
      const cost = await sessionManager.loadCost();
      console.log(chalk.blue('--- Cost Summary ---'));
      console.log(`Total Spent: ${chalk.green(`$${cost.totalUsd.toFixed(4)}`)}`);
      
      if (Object.keys(cost.byModel).length > 0) {
        console.log(chalk.gray('\nBreakdown by model:'));
        Object.entries(cost.byModel).forEach(([model, usd]: [string, any]) => {
          console.log(`- ${model}: $${usd.toFixed(4)}`);
        });
      }
    });

  program
    .command('clear')
    .description('Clear local crew-cli session state (.crew)')
    .action(async () => {
      try {
        await sessionManager.clear();
        logger.success('Cleared session state in .crew/');
      } catch (error) {
        logger.error('Failed to clear session state:', error.message);
        process.exit(1);
      }
    });

  program
    .command('skill')
    .description('Call a CrewSwarm skill by name')
    .argument('<name>', 'Skill name, e.g. zeroeval.benchmark')
    .option('--params <json>', 'JSON params payload', '{}')
    .option('-g, --gateway <url>', 'Override gateway URL')
    .action(async (name, options) => {
      try {
        let params = {};
        try {
          params = JSON.parse(options.params || '{}');
        } catch {
          throw new Error('Invalid JSON passed to --params');
        }

        await sessionManager.appendHistory({
          type: 'skill_request',
          skill: name,
          params
        });

        const result = await agentRouter.callSkill(name, params, {
          gateway: options.gateway
        });

        await sessionManager.appendHistory({
          type: 'skill_result',
          skill: name,
          success: Boolean(result.success)
        });
        await sessionManager.appendRouting({
          route: 'SKILL',
          model: 'n/a',
          skill: name
        });

        logger.success('Skill completed:', result);
      } catch (error) {
        await sessionManager.appendHistory({
          type: 'skill_error',
          skill: name,
          error: error.message
        });
        logger.error('Skill call failed:', error.message);
        process.exit(1);
      }
    });

  program
    .command('plan')
    .description('Generate a detailed plan for a task and execute it step-by-step')
    .argument('<task...>', 'Task to plan and execute')
    .action(async (taskArray) => {
      const task = taskArray.join(' ');
      const planner = new Planner(agentRouter);
      
      logger.info(`Generating plan for: ${task}`);
      const plan = await planner.generatePlan(task);
      
      console.log(chalk.blue('\n--- Proposed Plan ---'));
      plan.steps.forEach(s => console.log(`${s.id}. ${s.task}`));
      
      const { confirm } = await (import('inquirer')).then(m => m.default.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: 'Execute this plan step-by-step?',
        default: true
      }]));
      
      if (!confirm) {
        logger.warn('Plan cancelled.');
        return;
      }
      
      for (const step of plan.steps) {
        logger.progress(step.id - 1, plan.steps.length, 'Plan');
        logger.info(`Step ${step.id}: ${step.task}`);
        try {
          const result = await agentRouter.dispatch('crew-coder', step.task);
          logger.printWithHighlight(chalk.gray(String(result.result || '')));
          
          const edits = await orchestrator.parseAndApplyToSandbox(result.result);
          if (edits.length > 0) {
            logger.success(`Added changes to ${edits.length} files in sandbox for step ${step.id}.`);
          }
        } catch (err) {
          logger.error(`Failed at step ${step.id}: ${err.message}`);
          break;
        }
      }
      logger.progress(plan.steps.length, plan.steps.length, 'Plan');
      
      logger.success('Plan execution complete. Use "crew preview" to review changes.');
    });

  program
    .command('auth')
    .description('Search for local OAuth tokens from other coding CLIs')
    .action(async () => {
      const finder = new TokenFinder();
      const tokens = await finder.findTokens();
      
      console.log(chalk.blue('--- Local Tokens Found ---'));
      if (tokens.claude) console.log(chalk.green('✓ Claude Code session found'));
      if (tokens.openai) console.log(chalk.green('✓ OpenAI config key found'));
      if (tokens.gemini) console.log(chalk.green('✓ Gemini ADC credentials found'));
      if (Object.keys(tokens).length === 0) {
        console.log(chalk.yellow('No local tokens detected.'));
      }
    });

  program
    .command('correction')
    .description('Record a user correction for local training data (.crew/training-data.jsonl)')
    .requiredOption('--prompt <text>', 'Original user request/prompt')
    .requiredOption('--original <text>', 'Initial model output before correction')
    .requiredOption('--corrected <text>', 'Final corrected output')
    .option('--agent <id>', 'Agent/model identifier')
    .option('--tags <csv>', 'Comma-separated tags')
    .action(async options => {
      try {
        const tags = options.tags
          ? String(options.tags).split(',').map((x: string) => x.trim()).filter(Boolean)
          : [];

        const entry = await corrections.record({
          prompt: options.prompt,
          original: options.original,
          corrected: options.corrected,
          agent: options.agent,
          tags
        });

        logger.success(`Saved correction at ${entry.timestamp}`);
      } catch (error) {
        logger.error('Failed to save correction:', (error as Error).message);
        process.exit(1);
      }
    });

  program
    .command('tune')
    .description('Summarize or export local correction dataset')
    .option('-e, --export <path>', 'Export training JSONL to a target path')
    .option('--format <kind>', 'Export format: raw | lora', 'raw')
    .action(async options => {
      try {
        const summary = await corrections.summary();
        console.log(chalk.blue('--- Local Training Data ---'));
        console.log(`Entries: ${summary.count}`);
        if (summary.latest) {
          console.log(`Latest: ${summary.latest.timestamp}`);
          console.log(`Agent: ${summary.latest.agent || 'n/a'}`);
        }

        if (options.export) {
          if (options.format === 'lora') {
            const entries = await corrections.loadAll();
            const lines = entries.map(entry => JSON.stringify({
              instruction: entry.prompt,
              input: entry.original,
              output: entry.corrected,
              metadata: {
                timestamp: entry.timestamp,
                agent: entry.agent || null,
                tags: entry.tags || []
              }
            }));
            const { writeFile } = await import('node:fs/promises');
            await writeFile(options.export, `${lines.join('\n')}\n`, 'utf8');
          } else {
            await corrections.exportTo(options.export);
          }
          logger.success(`Exported dataset to ${options.export} (${options.format})`);
        }
      } catch (error) {
        logger.error('Tune command failed:', (error as Error).message);
        process.exit(1);
      }
    });

  program
    .command('engine')
    .description('Run a prompt through a direct engine integration')
    .requiredOption('-e, --engine <id>', 'gemini-api | claude-api | gemini-cli | codex-cli | claude-cli')
    .requiredOption('-p, --prompt <text>', 'Prompt text')
    .option('-m, --model <id>', 'Model override')
    .option('-t, --timeout <ms>', 'Timeout in milliseconds', '300000')
    .action(async options => {
      const result = await runEngine(options.engine, options.prompt, {
        model: options.model,
        timeoutMs: Number.parseInt(options.timeout || '300000', 10)
      });

      if (result.stdout) logger.printWithHighlight(result.stdout);
      if (result.stderr) console.error(chalk.red(result.stderr));
      if (!result.success) process.exit(1);
    });

  program
    .command('watch')
    .description('Watch files, detect TODOs, and offer auto-implementation dispatch')
    .option('-d, --dir <path>', 'Directory to watch', process.cwd())
    .action(async options => {
      const root = options.dir || process.cwd();
      logger.info(`Watching ${root} for TODOs...`);
      const watcher = startWatchMode(root, async event => {
        if (event.type === 'todo_detected') {
          logger.warn(`TODO detected in ${event.file} (${event.todoCount})`);
          const todoText = (event.todos || []).slice(0, 3).join('\n');
          const { confirm } = await (await import('inquirer')).default.prompt([{
            type: 'confirm',
            name: 'confirm',
            message: `Dispatch TODO implementation for ${event.file}?`,
            default: false
          }]);

          if (confirm) {
            await agentRouter.dispatch('crew-coder', `Implement TODOs in ${event.file}:\n${todoText}`, {
              sessionId: await sessionManager.getSessionId(),
              project: process.cwd()
            });
            logger.success(`Dispatched TODO implementation for ${event.file}`);
          }
        }
      });

      process.on('SIGINT', () => {
        watcher.close();
        logger.info('Watch mode stopped.');
        process.exit(0);
      });
    });

  program
    .command('browser-debug')
    .description('Launch Chrome in debug mode, collect console errors, and capture a screenshot')
    .requiredOption('--url <url>', 'Target URL')
    .option('--duration-ms <ms>', 'Capture duration in milliseconds', '5000')
    .option('--port <n>', 'Remote debug port', '9222')
    .option('--screenshot <path>', 'Screenshot output path')
    .action(async options => {
      const result = await runBrowserDebug(options.url, {
        durationMs: Number.parseInt(options.durationMs || '5000', 10),
        port: Number.parseInt(options.port || '9222', 10),
        screenshotPath: options.screenshot
      });
      console.log(chalk.blue('--- Browser Debug ---'));
      console.log(`Errors: ${result.consoleErrors.length}`);
      result.consoleErrors.forEach(err => console.log(`- ${err}`));
      if (result.screenshotPath) {
        console.log(`Screenshot: ${result.screenshotPath}`);
      }
    });

  program
    .command('browser-diff')
    .description('Compare two screenshots and report byte-level diff')
    .argument('<a>', 'First screenshot path')
    .argument('<b>', 'Second screenshot path')
    .action(async (a, b) => {
      const diff = await compareScreenshots(a, b);
      console.log(chalk.blue('--- Screenshot Diff ---'));
      console.log(`Diff bytes: ${diff.diffBytes}`);
      console.log(`Diff percent: ${diff.diffPercent.toFixed(2)}%`);
    });

  program
    .command('browser-fix')
    .description('Collect browser errors / failing UI tests and dispatch to crew-fixer')
    .requiredOption('--url <url>', 'Target URL')
    .option('--duration-ms <ms>', 'Capture duration in milliseconds', '5000')
    .option('--test-command <cmd>', 'Optional UI test command to run')
    .action(async options => {
      const debug = await runBrowserDebug(options.url, {
        durationMs: Number.parseInt(options.durationMs || '5000', 10)
      });

      let task = `Analyze and fix browser issues for ${options.url}.\n`;
      if (debug.consoleErrors.length > 0) {
        task += `Console errors:\n${debug.consoleErrors.map((e: string) => `- ${e}`).join('\n')}\n`;
      } else {
        task += 'No console errors captured.\n';
      }

      if (options.testCommand) {
        const { runCheckCommand } = await import('../ci/index.js');
        const check = await runCheckCommand(options.testCommand, process.cwd());
        if (!check.success) {
          task += `\nUI test command failed: ${options.testCommand}\nSTDERR:\n${check.stderr.slice(0, 4000)}\n`;
        }
      }

      const result = await agentRouter.dispatch('crew-fixer', task, {
        sessionId: await sessionManager.getSessionId(),
        project: process.cwd()
      });
      logger.printWithHighlight(String(result.result || ''));
    });

  program
    .command('ci-fix')
    .description('Run a CI check command and auto-dispatch fixes (max attempts)')
    .option('-c, --command <cmd>', 'Check command to run', 'npm test')
    .option('-m, --max-attempts <n>', 'Maximum auto-fix attempts', '3')
    .option('--push', 'Commit and push after successful fix loop', false)
    .option('--commit-message <msg>', 'Commit message for --push', 'chore(ci): auto-fix failing checks')
    .action(async options => {
      const maxAttempts = Number.parseInt(options.maxAttempts || '3', 10);
      logger.info(`Starting ci-fix loop for: ${options.command} (max ${maxAttempts})`);

      const result = await runCiFixLoop({
        command: options.command,
        maxAttempts,
        cwd: process.cwd(),
        router: agentRouter,
        orchestrator,
        sandbox,
        session: sessionManager
      });

      result.history.forEach(entry => {
        const marker = entry.success ? chalk.green('PASS') : chalk.red('FAIL');
        console.log(`Attempt ${entry.attempt}: ${marker}`);
      });

      if (!result.success) {
        logger.error(`ci-fix failed after ${result.attemptsUsed} attempts`);
        process.exit(1);
      }

      if (options.push) {
        const { execSync } = await import('node:child_process');
        try {
          execSync('git add -A', { stdio: 'inherit', cwd: process.cwd() });
          execSync(`git commit -m "${String(options.commitMessage || '').replace(/"/g, '\\"')}"`, { stdio: 'inherit', cwd: process.cwd() });
          execSync('git push', { stdio: 'inherit', cwd: process.cwd() });
          logger.success('Committed and pushed ci-fix changes.');
        } catch (pushErr) {
          logger.warn(`ci-fix succeeded, but push failed: ${(pushErr as Error).message}`);
        }
      }

      logger.success(`ci-fix passed in ${result.attemptsUsed} attempt(s)`);
    });

  program
    .command('branch')
    .description('Create a new sandbox branch')
    .argument('<name>', 'Branch name')
    .option('-f, --from <branch>', 'Source branch')
    .action(async (name, options) => {
      try {
        await sandbox.createBranch(name, options.from);
        logger.success(`Created and switched to branch "${name}"`);
      } catch (error) {
        logger.error('Failed to create branch:', error.message);
      }
    });

  program
    .command('switch')
    .description('Switch to a different sandbox branch')
    .argument('<name>', 'Branch name')
    .action(async (name) => {
      try {
        await sandbox.switchBranch(name);
        logger.success(`Switched to branch "${name}"`);
      } catch (error) {
        logger.error('Failed to switch branch:', error.message);
      }
    });

  program
    .command('merge')
    .description('Merge changes from one branch into another')
    .argument('<source>', 'Source branch')
    .option('-t, --target <branch>', 'Target branch')
    .action(async (source, options) => {
      try {
        await sandbox.mergeBranch(source, options.target);
        logger.success(`Merged "${source}" into "${options.target || sandbox.getActiveBranch()}"`);
      } catch (error) {
        logger.error('Failed to merge branch:', error.message);
      }
    });

  program
    .command('branches')
    .description('List all sandbox branches')
    .action(() => {
      const active = sandbox.getActiveBranch();
      const branches = sandbox.getBranches();
      console.log(chalk.blue('--- Sandbox Branches ---'));
      branches.forEach(b => {
        if (b === active) {
          console.log(chalk.green(`* ${b}`));
        } else {
          console.log(`  ${b}`);
        }
      });
    });

  program
    .command('doctor')
    .description('Run local diagnostics (Node, Git, config, gateway)')
    .option('-g, --gateway <url>', 'Gateway URL to check', 'http://localhost:5010')
    .action(async options => {
      const checks = await runDoctorChecks({ gateway: options.gateway });
      const summary = summarizeDoctorResults(checks);

      console.log(chalk.blue('crew doctor'));
      checks.forEach(check => {
        const marker = check.ok ? chalk.green('✓') : chalk.red('✗');
        console.log(`${marker} ${check.name} ${chalk.gray(`(${check.details})`)}`);
      });

      const summaryColor = summary.failed === 0 ? chalk.green : chalk.red;
      console.log(summaryColor(`Passed: ${summary.passed}  Failed: ${summary.failed}`));

      if (summary.failed > 0) {
        process.exit(1);
      }
    });

  program
    .command('preview')
    .description('Show pending changes in the sandbox')
    .argument('[branch]', 'Optional branch name to preview')
    .action((branch) => {
      const active = branch || sandbox.getActiveBranch();
      if (!sandbox.hasChanges(active)) {
        console.log(chalk.yellow(`No pending changes in sandbox branch "${active}".`));
        return;
      }
      console.log(chalk.blue(`--- Sandbox Preview [${active}] ---`));
      console.log(logger.highlightDiff(sandbox.preview(active)));
    });

  program
    .command('apply')
    .description('Apply all pending changes in the sandbox to the filesystem')
    .argument('[branch]', 'Optional branch name to apply')
    .option('-c, --check <command>', 'Command to run after apply (e.g. "npm test")')
    .action(async (branch, options) => {
      const active = branch || sandbox.getActiveBranch();
      if (!sandbox.hasChanges(active)) {
        console.log(chalk.yellow(`No changes to apply on branch "${active}".`));
        return;
      }
      try {
        const paths = sandbox.getPendingPaths(active);
        await sandbox.apply(active);
        logger.success(`Applied changes from branch "${active}" to: ${paths.join(', ')}`);

        if (options.check) {
          logger.info(`Running check: ${options.check}`);
          const { execSync } = await import('node:child_process');
          try {
            execSync(options.check, { stdio: 'inherit', cwd: process.cwd() });
            logger.success('Check passed!');
          } catch (err) {
            logger.error(`Check failed: ${err.message}`);
            logger.warn('Attempting auto-fix by dispatching to crew-fixer...');
            try {
              const fixResult = await agentRouter.dispatch(
                'crew-fixer',
                `The command "${options.check}" failed after applying sandbox changes to files: ${paths.join(', ')}. Diagnose and provide a fix.`,
                {
                  sessionId: await sessionManager.getSessionId(),
                  project: process.cwd()
                }
              );
              logger.printWithHighlight(String(fixResult.result || ''));
            } catch (fixError) {
              logger.warn(`Auto-fixer failed: ${(fixError as Error).message}`);
            }
          }
        }
      } catch (error) {
        logger.error('Failed to apply changes:', error.message);
        process.exit(1);
      }
    });

  program
    .command('rollback')
    .description('Discard all pending changes in the sandbox')
    .argument('[branch]', 'Optional branch name to rollback')
    .action(async (branch) => {
      const active = branch || sandbox.getActiveBranch();
      try {
        await sandbox.rollback(active);
        logger.success(`Rolled back all pending changes in branch "${active}".`);
      } catch (error) {
        logger.error('Failed to rollback:', error.message);
        process.exit(1);
      }
    });

  program
    .command('test-sandbox')
    .description('Internal test for sandbox')
    .option('-f, --file <path>', 'File to modify', 'sandbox-test.txt')
    .option('-c, --content <text>', 'New content', 'Hello from sandbox!')
    .action(async options => {
      try {
        await sandbox.addChange(options.file, options.content);
        logger.success(`Added change to ${options.file} in sandbox.`);
        console.log('Run "crew preview" to see the diff.');
      } catch (error) {
        logger.error('Test failed:', error.message);
      }
    });

  if (args.length === 0) {
    program.help();
  }

  await program.parseAsync(args, { from: 'user' });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
