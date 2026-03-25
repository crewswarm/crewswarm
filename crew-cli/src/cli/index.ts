#!/usr/bin/env node
// @ts-nocheck

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
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  compareVersions,
  getInstalledCliVersion,
  getLatestCliVersion,
  isGlobalInstallLinked,
  runDoctorChecks,
  summarizeDoctorResults
} from '../diagnostics/doctor.js';
import { compareModelCosts, estimateCost, getCheapestAlternative } from '../cost/predictor.js';
import { CorrectionStore } from '../learning/corrections.js';
import { runEngine } from '../engines/index.js';
import { startWatchMode } from '../watch/index.js';
import { getBanner } from '../hello/index.js';
import { collectMultiRepoContext, detectBreakingApiSignals, findSiblingRepos, getRepoSummary, syncRepoSnapshots } from '../multirepo/index.js';
import { runCiFixLoop } from '../ci/index.js';
import { compareScreenshots, runBrowserDebug } from '../browser/index.js';
import { downloadTeamContext, getTeamSyncStatus, loadPrivacyControls, savePrivacyControls, uploadTeamContext } from '../team/index.js';
import { appendVoiceTranscript, recordAudio, speakWithSkill, transcribeAudio } from '../voice/listener.js';
import { buildFileContextBlock, buildImageContextBlock, buildRepoContextBlock, collectOption, enforceContextBudget, mergeTaskWithContext, readStdinText } from '../context/augment.js';
import { detectHighSeverityFindings, getReviewPayload } from '../review/index.js';
import { addMcpServer, doctorMcpServers, listMcpServers, removeMcpServer } from '../mcp/index.js';
import { getHeadlessState, runHeadlessTask, setHeadlessPaused } from '../headless/index.js';
import { startUnifiedServer } from '../interface/server.js';
import { createSrcBatchPlan, runSrcCli } from '../sourcegraph/index.js';
import { getProjectContext } from '../context/git.js';
import { startRepl } from '../repl/index.js';
import { startTui } from '../tui/index.js';
import { TokenCache } from '../cache/token-cache.js';
import { analyzeBlastRadius, isSeverityAtLeast } from '../blast-radius/index.js';
import { AgentKeeper } from '../memory/agentkeeper.js';
import { CheckpointStore } from '../checkpoint/store.js';
import { scorePatchRisk } from '../risk/score.js';
import { runXSearch } from '../xai/search.js';
import { MemoryBroker } from '../memory/broker.js';
import { getNestedValue, loadResolvedRepoConfig, readRepoConfig, redactRepoConfigForDisplay, setRepoConfigValue } from '../config/repo-config.js';
import { commandToShell, describeIntent, executeGitHubIntent, parseGitHubIntent, requiresConfirmation, runGitHubDoctor, buildGitHubCommand } from '../github/nl.js';
import { loadModelPolicy } from '../config/model-policy.js';
import { AutoFixStore, type AutoFixApplyPolicy, type AutoFixJobStatus } from '../autofix/store.js';
import { runAutoFixJob } from '../autofix/runner.js';
import { loadPipelineMetricsSummary } from '../metrics/pipeline.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';
import { enforceStrictPreflight, getCapabilityHandshake, getExecutionPolicy, isRetryableError, isRiskBlocked, withRetries } from '../runtime/execution-policy.js';


const program = new Command();

export function parseHeadlessShortcutArgs(args: string[]) {
  const enabled = args.includes('--headless');
  if (!enabled) return { enabled: false };

  const readValue = (...names: string[]) => {
    for (let i = 0; i < args.length; i += 1) {
      if (names.includes(args[i])) return args[i + 1];
    }
    return undefined;
  };

  return {
    enabled: true,
    json: args.includes('--json'),
    alwaysApprove: args.includes('--always-approve'),
    out: readValue('--out'),
    task: readValue('-t', '--task'),
    agent: readValue('--agent'),
    gateway: readValue('-g', '--gateway')
  };
}

function extractValidationSignals(result: any, requireValidation: boolean) {
  if (!requireValidation) {
    return {
      required: false,
      passed: true,
      lintPassed: undefined as boolean | undefined,
      testsPassed: undefined as boolean | undefined,
      notes: ''
    };
  }

  const candidates = [
    result?.validation,
    result?.metadata?.validation,
    result?.meta?.validation
  ].filter(Boolean);
  const merged = Object.assign({}, ...candidates);

  let lintPassed: boolean | undefined;
  let testsPassed: boolean | undefined;
  const hasLint = typeof merged?.lintPassed === 'boolean' || typeof result?.lintPassed === 'boolean';
  const hasTests = typeof merged?.testsPassed === 'boolean' || typeof result?.testsPassed === 'boolean';
  if (hasLint) lintPassed = Boolean(merged?.lintPassed ?? result?.lintPassed);
  if (hasTests) testsPassed = Boolean(merged?.testsPassed ?? result?.testsPassed);

  let explicitPass: boolean | undefined;
  if (typeof merged?.passed === 'boolean') explicitPass = merged.passed;
  else if (typeof merged?.ok === 'boolean') explicitPass = merged.ok;
  else if (typeof merged?.success === 'boolean') explicitPass = merged.success;

  if (explicitPass === undefined && !hasLint && !hasTests) {
    const text = String(result?.result || '').toLowerCase();
    if (/\btests?\s+(all\s+)?passed\b/.test(text)) testsPassed = true;
    if (/\b(?:lint|eslint|typecheck|type-check)\s+passed\b/.test(text)) lintPassed = true;
    if (/\btests?\s+failed\b/.test(text)) testsPassed = false;
    if (/\b(?:lint|eslint|typecheck|type-check)\s+failed\b/.test(text)) lintPassed = false;
  }

  const anySignal = explicitPass !== undefined || lintPassed !== undefined || testsPassed !== undefined;
  const checks: boolean[] = [];
  if (explicitPass !== undefined) checks.push(explicitPass);
  if (lintPassed !== undefined) checks.push(lintPassed);
  if (testsPassed !== undefined) checks.push(testsPassed);
  const passed = anySignal && checks.every(Boolean);
  const notes = passed
    ? 'validation-signals-present'
    : anySignal
      ? 'validation-failed'
      : 'validation-signals-missing';

  return {
    required: true,
    passed,
    lintPassed,
    testsPassed,
    notes
  };
}

type SubscriptionEngineId = 'cursor' | 'claude-cli' | 'codex-cli';

interface SubscriptionEngineProbe {
  id: SubscriptionEngineId;
  binary: string;
  installed: boolean;
  authenticated: boolean;
  ready: boolean;
  notes: string[];
  version: string;
}

function hasBinary(bin: string): boolean {
  try {
    execSync(`command -v ${bin}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function readBinaryVersion(bin: string): string {
  try {
    return String(execSync(`${bin} --version`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim();
  } catch {
    return '';
  }
}

function commandOutput(command: string): { ok: boolean; output: string } {
  try {
    const output = String(execSync(`${command} 2>&1`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
    return { ok: true, output };
  } catch (error: any) {
    const output = String(error?.stdout || error?.stderr || '').trim();
    return { ok: false, output };
  }
}

function detectCliAuthStatus(): { claude: boolean; codex: boolean; cursor: boolean } {
  const claude = hasBinary('claude')
    ? (() => {
      const result = commandOutput('claude auth status');
      const text = (result.output || '').toLowerCase();
      if (!text) return false;
      if (/"loggedin"\s*:\s*true/.test(text)) return true;
      if (text.includes('logged in')) return true;
      return false;
    })()
    : false;

  const codex = hasBinary('codex')
    ? (() => {
      const result = commandOutput('codex login status');
      const text = (result.output || '').toLowerCase();
      return text.includes('logged in');
    })()
    : false;

  const cursor = hasBinary('cursor') && existsSync(join(homedir(), '.cursor', 'User', 'globalStorage', 'state.vscdb'));

  return { claude, codex, cursor };
}

function detectSubscriptionEngines(tokens: Record<string, string | undefined>): SubscriptionEngineProbe[] {
  const cursorInstalled = hasBinary('cursor');
  const claudeInstalled = hasBinary('claude');
  const codexInstalled = hasBinary('codex');
  const cliAuth = detectCliAuthStatus();

  const cursorAuth = Boolean(tokens.cursor || cliAuth.cursor);
  const claudeAuth = Boolean(tokens.claude || process.env.ANTHROPIC_API_KEY || cliAuth.claude);
  const codexAuth = Boolean(tokens.openai || process.env.OPENAI_API_KEY || cliAuth.codex);

  return [
    {
      id: 'cursor',
      binary: 'cursor',
      installed: cursorInstalled,
      authenticated: cursorAuth,
      ready: cursorInstalled && cursorAuth,
      notes: [
        cursorInstalled ? 'binary-ok' : 'missing-binary',
        cursorAuth ? 'auth-ok' : 'auth-not-detected'
      ],
      version: cursorInstalled ? readBinaryVersion('cursor') : ''
    },
    {
      id: 'claude-cli',
      binary: 'claude',
      installed: claudeInstalled,
      authenticated: claudeAuth,
      ready: claudeInstalled && claudeAuth,
      notes: [
        claudeInstalled ? 'binary-ok' : 'missing-binary',
        claudeAuth ? 'auth-ok' : 'auth-not-detected'
      ],
      version: claudeInstalled ? readBinaryVersion('claude') : ''
    },
    {
      id: 'codex-cli',
      binary: 'codex',
      installed: codexInstalled,
      authenticated: codexAuth,
      ready: codexInstalled && codexAuth,
      notes: [
        codexInstalled ? 'binary-ok' : 'missing-binary',
        codexAuth ? 'auth-ok' : 'auth-not-detected'
      ],
      version: codexInstalled ? readBinaryVersion('codex') : ''
    }
  ];
}

function shouldRetryWithFallback(error: unknown): boolean {
  const text = String((error as Error)?.message || '').toLowerCase();
  return isRetryableError(error) || text.includes('empty');
}

function printJsonEnvelope(kind: string, payload: Record<string, unknown>) {
  console.log(JSON.stringify({
    version: 'v1',
    kind,
    ts: new Date().toISOString(),
    ...payload
  }, null, 2));
}

async function loadPipelineRunEvents(traceId: string, baseDir = process.cwd()): Promise<any[]> {
  const path = join(baseDir, '.crew', 'pipeline-runs', `${traceId}.jsonl`);
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function inferResumeTask(events: any[]): { task: string; phase: string } | null {
  if (!Array.isArray(events) || events.length === 0) return null;
  const firstPlan = events.find(e => String(e?.phase || '') === 'plan' && typeof e?.userInput === 'string');
  const last = events[events.length - 1];
  if (!firstPlan?.userInput) return null;
  return {
    task: String(firstPlan.userInput),
    phase: String(last?.phase || 'unknown')
  };
}

function extractResumeArtifacts(events: any[]): {
  priorPlan?: any;
  priorResponse?: string;
  priorExecutionResults?: any;
} {
  const planEvent = [...events].reverse().find(e => String(e?.phase || '') === 'plan.completed' && e?.plan);
  const validateInput = [...events].reverse().find(e => String(e?.phase || '') === 'validate.input');
  return {
    priorPlan: planEvent?.plan,
    priorResponse: typeof validateInput?.response === 'string' ? validateInput.response : undefined,
    priorExecutionResults: validateInput?.executionResults
  };
}

async function runValidationCommands(commands: string[] = [], cwd = process.cwd()) {
  if (!Array.isArray(commands) || commands.length === 0) {
    return { passed: true, failedCommand: '', output: '' };
  }
  for (const cmd of commands) {
    try {
      const out = execSync(cmd, {
        cwd,
        stdio: 'pipe',
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024
      });
      if (String(out || '').trim().length > 0) {
        // keep deterministic side-effect free behavior, no streaming here.
      }
    } catch (error) {
      return {
        passed: false,
        failedCommand: cmd,
        output: String((error as any)?.stderr || (error as Error)?.message || '')
      };
    }
  }
  return { passed: true, failedCommand: '', output: '' };
}

async function runLspAutoFixCycle(
  projectDir: string,
  maxAttempts: number,
  options: {
    router: AgentRouter;
    orchestrator: Orchestrator;
    sessionId: string;
    gateway?: string;
    model?: string;
    fallbackModels?: string[];
    checkpoints?: CheckpointStore;
    runId?: string;
    logger: Logger;
  }
): Promise<{ fixed: boolean; attempts: number; remainingDiagnostics: number }> {
  const { typeCheckProject } = await import('../lsp/index.js');
  const cappedAttempts = Math.max(1, maxAttempts);
  let diagnostics = await typeCheckProject(projectDir, []);
  if (diagnostics.length === 0) return { fixed: true, attempts: 0, remainingDiagnostics: 0 };

  let attempts = 0;
  while (attempts < cappedAttempts && diagnostics.length > 0) {
    attempts += 1;
    const top = diagnostics.slice(0, 30);
    const summary = top
      .map(d => `${d.file}:${d.line}:${d.column} [${d.category}] TS${d.code} ${d.message}`)
      .join('\n');
    const task = [
      'Run a targeted TypeScript auto-fix pass for the following diagnostics.',
      'Apply minimal safe changes only.',
      'Diagnostics:',
      summary
    ].join('\n');

    const dispatched = await dispatchWithFallback(
      options.router,
      'crew-fixer',
      task,
      {
        project: projectDir,
        sessionId: options.sessionId,
        gateway: options.gateway,
        model: options.model
      },
      options.fallbackModels || [],
      options.checkpoints,
      options.runId
    );
    const response = String(dispatched.result?.result || '');
    const edits = await options.orchestrator.parseAndApplyToSandbox(response);
    options.logger.info(`LSP auto-fix attempt ${attempts}: ${diagnostics.length} diagnostics, ${edits.length} sandbox edit(s).`);
    await options.checkpoints?.append(String(options.runId || ''), 'lsp.autofix.attempt', {
      attempt: attempts,
      diagnostics: diagnostics.length,
      edits: edits.length
    });
    diagnostics = await typeCheckProject(projectDir, []);
  }

  return {
    fixed: diagnostics.length === 0,
    attempts,
    remainingDiagnostics: diagnostics.length
  };
}

async function dispatchWithFallback(
  router: AgentRouter,
  agent: string,
  task: string,
  options: any,
  fallbackModels: string[] = [],
  checkpoint?: CheckpointStore,
  runId?: string
) {
  const tried: string[] = [];
  const primary = String(options.model || '').trim();
  if (primary) tried.push(primary);
  const chain = [primary, ...fallbackModels].map(x => String(x || '').trim()).filter(Boolean);
  if (chain.length === 0) {
    const result = await router.dispatch(agent, task, options);
    return { result, usedModel: primary || 'default', attempts: tried };
  }

  let lastError: Error | null = null;
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    tried.push(model);
    try {
      if (checkpoint && runId) {
        await checkpoint.append(runId, 'dispatch.model.attempt', { model, index: i + 1 });
      }
      const result = await router.dispatch(agent, task, { ...options, model });
      if (checkpoint && runId) {
        await checkpoint.append(runId, 'dispatch.model.success', { model, index: i + 1 });
      }
      return { result, usedModel: model, attempts: tried };
    } catch (error) {
      lastError = error as Error;
      if (checkpoint && runId) {
        await checkpoint.append(runId, 'dispatch.model.failed', { model, error: String((error as Error).message || error) });
      }
      const retryable = shouldRetryWithFallback(error);
      const hasNext = i < chain.length - 1;
      if (!retryable || !hasNext) break;
    }
  }

  throw lastError || new Error('Dispatch failed across fallback chain');
}

export function parseConfigValue(raw: string, asJson = false): unknown {
  const text = String(raw ?? '').trim();
  if (asJson) {
    return JSON.parse(text);
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

export async function main(args = []) {
  // ── Fast-path for lightweight commands that don't need full startup ──
  const firstArg = (args.find(a => !a.startsWith('-')) || '').toLowerCase();
  if (['doctor', 'update', 'version'].includes(firstArg)) {
    const lightweight = new Command();
    lightweight.name('crew');

    lightweight
      .command('doctor')
      .description('Run local diagnostics (Node, Git, config, API keys, gateway)')
      .option('-g, --gateway <url>', 'Gateway URL to check', 'http://localhost:5010')
      .option('--update-tag <tag>', 'Version channel for update check', 'latest')
      .action(async options => {
        const checks = await runDoctorChecks({ gateway: options.gateway, updateTag: options.updateTag });
        const summary = summarizeDoctorResults(checks);

        console.log(chalk.blue('\ncrew doctor\n'));
        checks.forEach(check => {
          let marker = check.ok ? chalk.green('✓') : chalk.red('✗');
          if (check.name === 'CLI update status' && String(check.details || '').toLowerCase().includes('update available')) {
            marker = chalk.yellow('!');
          }
          console.log(`  ${marker} ${check.name} ${chalk.gray(`— ${check.details}`)}`);
          if (!check.ok && check.hint) {
            check.hint.split('\n').forEach(line => console.log(chalk.yellow(`    ${line}`)));
          }
        });

        console.log();
        const summaryColor = summary.failed === 0 ? chalk.green : chalk.red;
        console.log(summaryColor(`  ${summary.passed} passed, ${summary.failed} failed\n`));

        if (summary.failed > 0) process.exit(1);
      });

    lightweight
      .command('update')
      .description('Check for updates and install latest crew-cli globally')
      .option('--check', 'Only check availability, do not install', false)
      .option('--tag <tag>', 'Update channel/tag (default: latest)', 'latest')
      .option('-y, --yes', 'Skip confirmation prompt', false)
      .action(async options => {
        const installed = await getInstalledCliVersion();
        const latest = await getLatestCliVersion(options.tag || 'latest');
        if (!latest) {
          console.log(chalk.yellow('Unable to check latest version from npm right now.'));
          return;
        }
        if (!installed) {
          console.log(chalk.yellow(`Current version unknown. Latest available: ${latest}`));
          return;
        }
        const cmp = compareVersions(installed, latest);
        if (cmp >= 0) {
          console.log(chalk.green(`✓ Up to date (${installed})`));
        } else {
          console.log(chalk.yellow(`Update available: ${installed} → ${latest}`));
          console.log(chalk.gray('Run: npm i -g crewswarm-cli@latest'));
        }
      });

    lightweight
      .command('version')
      .description('Show crew-cli version')
      .action(async () => {
        const v = await getInstalledCliVersion();
        console.log(v || 'unknown');
      });

    await lightweight.parseAsync(args, { from: 'user' });
    process.exit(0);
  }

  const normalizedArgs = [...args];
  if (normalizedArgs.includes('--legacy-router')) {
    process.env.CREW_LEGACY_ROUTER = 'true';
    process.env.CREW_USE_UNIFIED_ROUTER = 'false';
    const idx = normalizedArgs.indexOf('--legacy-router');
    normalizedArgs.splice(idx, 1);
    args = normalizedArgs;
  }

  // Show banner on first launch (or always if CREW_SHOW_BANNER=1)
  const bannerFile = join(process.env.HOME || homedir(), '.crew', 'cli-banner-seen');
  const showAlways = process.env.CREW_SHOW_BANNER === '1';
  
  if (showAlways || !existsSync(bannerFile)) {
    const banner = `
╔═══════════════════════════════════════════════════════════════════════════╗
║                                                                           ║
║     ██████╗ ██████╗ ███████╗██╗    ██╗      ██████╗██╗     ██╗           ║
║    ██╔════╝ ██╔══██╗██╔════╝██║    ██║     ██╔════╝██║     ██║           ║
║    ██║      ██████╔╝█████╗  ██║ █╗ ██║     ██║     ██║     ██║           ║
║    ██║      ██╔══██╗██╔══╝  ██║███╗██║     ██║     ██║     ██║           ║
║    ╚██████╗ ██║  ██║███████╗╚███╔███╔╝     ╚██████╗███████╗██║           ║
║     ╚═════╝ ╚═╝  ╚═╝╚══════╝ ╚══╝╚══╝       ╚═════╝╚══════╝╚═╝           ║
║                                                                           ║
║                   🎪 One idea. One Build. One Crew.                       ║
║                                                                           ║
╚═══════════════════════════════════════════════════════════════════════════╝
`;
    console.log(chalk.cyan(banner));
    
    // Mark as seen (best effort)
    try {
      await mkdir(dirname(bannerFile), { recursive: true });
      await writeFile(bannerFile, new Date().toISOString());
    } catch (e) {
      logger.error(`Failed to mark banner as seen: ${e.message}`);
    }
  }

  // (fast-path for doctor/update/version is at the top of main())

  const logger = new Logger();
  const config = new ConfigManager();
  const toolManager = new ToolManager(config);
  const agentRouter = new AgentRouter(config, toolManager);
  const sessionManager = new SessionManager(process.cwd());
  const sandbox = new Sandbox(process.cwd());
  const orchestrator = new Orchestrator(agentRouter, sandbox, sessionManager);
  const corrections = new CorrectionStore(process.cwd());
  const tokenCache = new TokenCache(process.cwd());
  const agentKeeper = new AgentKeeper(process.cwd());
  const checkpoints = new CheckpointStore(process.cwd());
  const autoFixStore = new AutoFixStore(process.cwd());
  const repoConfig = await loadResolvedRepoConfig(process.cwd());
  const modelPolicy = await loadModelPolicy(process.cwd());
  const cliDefaults = repoConfig.cli || {};
  const plannerPolicy = modelPolicy.tiers?.planner || {};
  const executorPolicy = modelPolicy.tiers?.executor || {};
  const workerPolicy = modelPolicy.tiers?.worker || {};
  const plannerPrimary = plannerPolicy.primary || cliDefaults.model || '';
  const executorPrimary = executorPolicy.primary || cliDefaults.model || '';
  const workerPrimary = workerPolicy.primary || cliDefaults.model || '';

  await sessionManager.ensureInitialized();
  await toolManager.initialize();
  await sandbox.load();

  const getStandaloneRuntime = async (projectDir?: string) => {
    const targetDir = projectDir || process.cwd();
    if (targetDir === process.cwd()) {
      return { sandbox, orchestrator, sessionManager };
    }
    const scopedSession = new SessionManager(targetDir);
    const scopedSandbox = new Sandbox(targetDir);
    const scopedOrchestrator = new Orchestrator(agentRouter, scopedSandbox, scopedSession);
    await scopedSession.ensureInitialized();
    await scopedSandbox.load();
    return {
      sandbox: scopedSandbox,
      orchestrator: scopedOrchestrator,
      sessionManager: scopedSession
    };
  };

  // Show banner on new sessions
  const sessionData = await sessionManager.loadSession();
  if (sessionData.history.length === 0 && !args.includes('--headless') && !args.includes('--json')) {
    console.log(getBanner());
  }

  try {
    await agentKeeper.compact();
  } catch {
    // Never fail startup due to maintenance compaction.
  }

  const headlessShortcut = parseHeadlessShortcutArgs(args);
  if (headlessShortcut.enabled) {
    if (!headlessShortcut.task) {
      console.error('Missing task for headless mode. Use -t "your task".');
      process.exit(1);
    }
    const result = await runHeadlessTask({
      task: headlessShortcut.task,
      json: headlessShortcut.json,
      alwaysApprove: headlessShortcut.alwaysApprove,
      out: headlessShortcut.out,
      agent: headlessShortcut.agent,
      gateway: headlessShortcut.gateway,
      projectDir: process.cwd(),
      router: agentRouter,
      orchestrator,
      sandbox,
      session: sessionManager
    });
    if (!result.success) process.exit(1);
    return;
  }

  const cliVersion = (await getInstalledCliVersion()) || '0.1.0-alpha';

  program
    .name('crew')
    .description('CrewSwarm CLI - Agent orchestration made simple')
    .version(cliVersion);

  program.option('--legacy-router', 'Use legacy routing path (disables UnifiedPipeline default)', false);

  program
    .command('chat')
    .description('Chat with CrewSwarm (automatically routed to best agent)')
    .argument('<input...>', 'Message or question')
    .option('-p, --project <path>', 'Project directory')
    .option('-g, --gateway <url>', 'Override gateway URL')
    .option('-m, --model <id>', 'Model override for direct/bypass gateway paths', executorPrimary || undefined)
    .option('--engine <id>', 'Engine override for direct/bypass gateway paths (e.g. cursor)', cliDefaults.engine || undefined)
    .option('--direct', 'Request direct execution path on gateway', false)
    .option('--bypass', 'Request bypass/orchestrator-skip path on gateway', false)
    .option('--crew', 'Use full multi-agent crew via gateway (like OpenCode PM loop)', false)
    .option('--apply', 'Auto-apply sandbox changes to disk after completion', false)
    .option('--image <path>', 'Attach an image file to the prompt (repeatable)', collectOption, [])
    .option('--context-image <path>', 'Attach an image file as context (repeatable)', collectOption, [])
    .option('--image-max-bytes <n>', 'Max bytes per image context payload', '250000')
    .option('--cross-repo', 'Inject sibling repository context', false)
    .option('--context-file <path>', 'Attach a file as additional context (repeatable)', collectOption, [])
    .option('--context-repo <path>', 'Attach git context from another repo (repeatable)', collectOption, [])
    .option('--stdin', 'Read additional context from stdin', false)
    .option('--max-context-tokens <n>', 'Max context token budget (approx, chars/4)')
    .option('--context-budget-mode <mode>', 'trim | stop when budget exceeded', 'trim')
    .option('--docs', 'Inject matching docs context via collections search', false)
    .option('--docs-path <paths...>', 'Custom paths for docs search (default: docs/ + project root)')
    .option('--docs-code', 'Include source code files in docs retrieval index', Boolean(cliDefaults.docsCode))
    .option('--fallback-model <id>', 'Fallback model chain entry (repeatable)', collectOption, [])
    .option('--retry-attempts <n>', 'Retry attempts for transient failures', '2')
    .option('--strict-preflight', 'Block execution if doctor checks fail', false)
    .option('--json', 'Output machine-readable JSON envelope', false)
    .action(async (inputArray, options) => {
      let input = inputArray.join(' ');
      try {
        const policy = getExecutionPolicy({
          strictPreflight: Boolean(options.strictPreflight),
          retryAttempts: Number.parseInt(options.retryAttempts || '2', 10)
        });
        await enforceStrictPreflight(policy, options.gateway);
        const fileBlock = await buildFileContextBlock(options.contextFile || []);
        const repoBlock = await buildRepoContextBlock(options.contextRepo || []);
        const imagePaths = [...(options.image || []), ...(options.contextImage || [])];
        const imageBlock = await buildImageContextBlock(
          imagePaths,
          Number.parseInt(options.imageMaxBytes || '250000', 10)
        );
        const stdinText = options.stdin ? await readStdinText() : '';
        const stdinBlock = stdinText ? `## Stdin Context\n\`\`\`text\n${stdinText}\n\`\`\`` : '';

        let docsBlock = '';
        if (options.docs) {
          const { buildCollectionIndex, searchCollection } = await import('../collections/index.js');
          const docsPaths = options.docsPath && options.docsPath.length > 0
            ? options.docsPath
            : [join(process.cwd(), 'docs'), process.cwd()];
          const index = await buildCollectionIndex(docsPaths, {
            includeCode: Boolean(options.docsCode)
          });
          const result = searchCollection(index, input, 5);
          if (result.hits.length > 0) {
            const chunks = result.hits.map(h => `### ${h.source}:${h.startLine} (score: ${h.score})\n${h.text}`);
            docsBlock = `## Docs Context (auto-retrieved)\n${chunks.join('\n\n')}`;
          }
        }

        const budget = enforceContextBudget(
          input,
          [fileBlock, repoBlock, imageBlock, stdinBlock, docsBlock],
          options.maxContextTokens ? Number.parseInt(options.maxContextTokens, 10) : undefined,
          options.contextBudgetMode === 'stop' ? 'stop' : 'trim'
        );
        if (budget.exceeded) {
          throw new Error(`Context budget exceeded (~${budget.estimatedTokens} tokens > ${options.maxContextTokens}). Use --context-budget-mode trim or raise budget.`);
        }
        if (budget.trimmed) {
          logger.warn(`Context trimmed to stay under budget (~${budget.estimatedTokens} tokens).`);
        }
        input = budget.task;

        if (options.crossRepo) {
          const multiContext = await collectMultiRepoContext(options.project || process.cwd());
          input = `${input}\n\n${multiContext}`;
        }

        const projectDir = options.project || process.cwd();

        // crew-CLI: use connected mode (gateway dispatch) when --gateway or --crew is specified
        // Otherwise use standalone agentic executor with built-in tools
        const useConnected = Boolean(options.gateway || options.crew);
        const useLegacyStandalone = String(process.env.CREW_LEGACY_ROUTER || '').toLowerCase() === 'true';
        const fallbackModels = (options.fallbackModel && options.fallbackModel.length > 0)
          ? options.fallbackModel
          : (executorPolicy.fallback || []);
        const capabilityHandshake = getCapabilityHandshake(useConnected ? 'connected' : 'standalone');

        // crew-CLI uses agentic executor (standalone) unless explicitly connected
        if (!useConnected && !useLegacyStandalone) {
          logger.info('Executing in standalone mode (agentic executor with file tools)');
          const standaloneRuntime = await getStandaloneRuntime(projectDir);
          const result = await withRetries(
            async () => standaloneRuntime.orchestrator.executeAgentic(input, {
              sessionId: await standaloneRuntime.sessionManager.getSessionId(),
              model: options.model
            }),
            policy
          );
          const responseText = String(result.response || result.result || '');
          const edits = await standaloneRuntime.orchestrator.parseAndApplyToSandbox(responseText);
          const hasPendingChanges = standaloneRuntime.sandbox.hasChanges();
          let appliedPaths: string[] = [];
          if (hasPendingChanges && options.apply) {
            appliedPaths = standaloneRuntime.sandbox.getPendingPaths();
            await standaloneRuntime.sandbox.apply();
          }
          await standaloneRuntime.sessionManager.appendHistory({
            input,
            response: responseText,
            decision: result.plan?.decision || 'execute',
            agent: 'unified-pipeline',
            model: String(result.plan?.validation?.modelUsed || 'unknown'),
            costUsd: result.totalCost
          });

          console.log(
            JSON.stringify(
              {
                version: 'v1',
                kind: 'chat.result',
                ts: new Date().toISOString(),
                route: result.plan
                  ? {
                      decision: result.plan.decision.toUpperCase(),
                      explanation: result.plan.reasoning
                    }
                  : { decision: 'EXECUTE', explanation: 'Direct L3 execution' },
                agent: 'unified-pipeline',
                response: responseText,
                edits: edits.length > 0 ? edits : undefined,
                applied: appliedPaths.length > 0 ? appliedPaths : undefined,
                needsApproval: hasPendingChanges && appliedPaths.length === 0,
                traceId: result.traceId,
                timeline: result.timeline,
                capabilityHandshake
              },
              null,
              2
            )
          );
          return;
        }

        // Connected mode or legacy: route first, then dispatch
        const route = await orchestrator.route(input);

        if (route.decision === 'CHAT' || route.decision === 'CODE' || route.decision === 'DISPATCH') {
          const agent = route.agent || 'crew-main';
          logger.info(`Routing to ${agent} (Decision: ${route.decision})`);

          const result = await dispatchWithFallback(
                agentRouter,
                agent,
                input,
                {
                  project: projectDir,
                  sessionId: await sessionManager.getSessionId(),
                  gateway: options.gateway,
                  model: options.model,
                  engine: options.engine,
                  direct: options.direct,
                  bypass: options.bypass,
                  images: options.image || []
                },
                fallbackModels,
                checkpoints,
                `chat-${randomUUID()}`
              );

          const rawResponse = result.response || result.result || '';
          const responseText = typeof rawResponse === 'object' 
            ? (rawResponse.result || rawResponse.output || rawResponse.message || JSON.stringify(rawResponse, null, 2))
            : String(rawResponse);
          // Try to parse any edits
          const edits = await orchestrator.parseAndApplyToSandbox(responseText);
          let appliedPaths: string[] = [];
          if (edits.length > 0 && (options.apply || options.crew)) {
            appliedPaths = sandbox.getPendingPaths();
            await sandbox.apply();
          }
          if (options.json) {
            printJsonEnvelope('chat.result', {
              route,
              agent,
              response: responseText,
              edits,
              applied: appliedPaths.length > 0 ? appliedPaths : undefined,
              needsApproval: edits.length > 0 && appliedPaths.length === 0,
              traceId: result.traceId || null,
              timeline: Array.isArray(result.timeline) ? result.timeline : [],
              capabilityHandshake
            });
            return;
          }
          console.log(chalk.blue('\n--- Agent Response ---'));
          console.log(responseText);
          if (Array.isArray(result.timeline) && result.timeline.length > 0) {
            console.log(chalk.gray('\nPipeline timeline:'));
            for (const step of result.timeline) {
              console.log(chalk.gray(`  - ${step.phase} @ ${step.ts}`));
            }
          }
          if (edits.length > 0) {
            if (appliedPaths.length > 0) {
              logger.success(`✓ Applied ${appliedPaths.length} files to disk`);
              appliedPaths.forEach(f => logger.info(`  - ${f}`));
            } else {
              logger.success(`Added changes to ${edits.length} files in sandbox. Run "crew preview" to review.`);
            }
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
    .command('auto')
    .description('Autonomous mode - LLM iterates on task until completion without approval prompts')
    .argument('<task...>', 'Task description')
    .option('-p, --project <path>', 'Project directory', process.cwd())
    .option('-g, --gateway <url>', 'Override gateway URL')
    .option('-m, --model <id>', 'Model override', workerPrimary || undefined)
    .option('--fallback-model <id>', 'Fallback model chain entry (repeatable)', collectOption, [])
    .option('--max-iterations <n>', 'Maximum autonomous iterations', '10')
    .option('--auto-apply', 'Automatically apply sandbox changes when task completes', false)
    .option('--cross-repo', 'Inject sibling repository context', false)
    .option('--cache', 'Enable output cache for autonomous iterations', false)
    .option('--cache-ttl <sec>', 'Output cache TTL in seconds', '1800')
    .option('--no-memory', 'Disable shared AgentKeeper memory')
    .option('--memory-max <n>', 'Max recalled memory entries', String(cliDefaults.memoryMax ?? 3))
    .option('--memory-require-validation', 'Store memory only when validation is marked passed', false)
    .option('--lsp-auto-fix', 'Run LSP diagnostics and auto-dispatch fixes after edits', false)
    .option('--lsp-auto-fix-max-attempts <n>', 'Max LSP auto-fix attempts per iteration', '3')
    .option('--no-blast-radius-gate', 'Disable blast-radius safety gate before auto-apply')
    .option('--blast-radius-threshold <level>', 'Blast-radius gate threshold: low|medium|high', 'high')
    .option('--force-auto-apply', 'Bypass blast-radius gate and auto-apply anyway', false)
    .option('--escalate-risk', 'Escalate high-risk patches to QA and Security before completion', false)
    .option('--risk-threshold <level>', 'Escalation threshold: low|medium|high', 'high')
    .action(async (taskArray, options) => {
      const task = taskArray.join(' ');
      const projectDir = options.project || process.cwd();
      const maxIterations = Number.parseInt(options.maxIterations || '10', 10);
      const fallbackModels = (options.fallbackModel && options.fallbackModel.length > 0)
        ? options.fallbackModel
        : (workerPolicy.fallback || []);

      logger.info(chalk.cyan(`🤖 Autonomous Mode: ${task}`));
      logger.info(chalk.gray(`   Max iterations: ${maxIterations}`));
      logger.info(chalk.gray(`   Project: ${projectDir}\n`));

      let currentTask = task;
      let iteration = 0;
      let failedRun = false;
      const runId = `auto-${randomUUID()}`;
      const useMemory = options.memory !== false;
      await checkpoints.beginRun({ runId, mode: 'auto', task });

      if (useMemory) {
        const matches = await agentKeeper.recall(task, Number.parseInt(options.memoryMax || '3', 10), {
          preferSuccessful: true
        });
        const avgScore = matches.length
          ? matches.reduce((sum, m) => sum + Number(m.score || 0), 0) / matches.length
          : 0;
        await sessionManager.trackMemoryRecall({
          used: true,
          miss: matches.length === 0,
          matchCount: matches.length,
          qualityScore: avgScore
        });
        if (matches.length > 0) {
          const memoryContext = await agentKeeper.recallAsContext(task, Number.parseInt(options.memoryMax || '3', 10), {
            preferSuccessful: true
          });
          currentTask = `${currentTask}\n\n${memoryContext}`;
        }
      }

      if (options.crossRepo) {
        const multiContext = await collectMultiRepoContext(projectDir);
        currentTask = `${currentTask}\n\n${multiContext}`;
      }

      while (iteration < maxIterations) {
        iteration += 1;
        logger.info(chalk.blue(`\n[Iteration ${iteration}/${maxIterations}]`));

        try {
          const route = await orchestrator.route(currentTask);
          const agent = route.agent || 'crew-main';
          
          logger.info(chalk.gray(`  Routing to: ${agent}`));

          const useCache = Boolean(options.cache);
          const cacheKey = TokenCache.hashKey(JSON.stringify({
            kind: 'auto-output',
            agent,
            task: currentTask,
            projectDir,
            gateway: options.gateway || '',
            model: options.model || ''
          }));

          let result: any;
          if (useCache) {
            const cached = await tokenCache.get<any>('output', cacheKey);
            if (cached.hit && cached.value) {
              logger.info(chalk.gray('  Using cached output.'));
              result = cached.value;
              await sessionManager.trackCacheSavings({
                hit: true,
                tokensSaved: Number(cached.meta?.tokensSaved || 0),
                usdSaved: Number(cached.meta?.usdSaved || 0)
              });
            } else {
              await sessionManager.trackCacheSavings({ miss: true });
              const dispatched = await dispatchWithFallback(
                agentRouter,
                agent,
                currentTask,
                {
                  project: projectDir,
                  sessionId: await sessionManager.getSessionId(),
                  gateway: options.gateway,
                  model: options.model
                },
                fallbackModels,
                checkpoints,
                runId
              );
              result = dispatched.result;
              const estTokens = Math.ceil((String(currentTask).length + String(result.result || '').length) / 4);
              await tokenCache.set(
                'output',
                cacheKey,
                result,
                Number.parseInt(options.cacheTtl || '1800', 10),
                { tokensSaved: estTokens, usdSaved: estTokens / 1_000_000, source: 'auto-output' }
              );
            }
          } else {
            const dispatched = await dispatchWithFallback(
              agentRouter,
              agent,
              currentTask,
              {
                project: projectDir,
                sessionId: await sessionManager.getSessionId(),
                gateway: options.gateway,
                model: options.model
              },
              fallbackModels,
              checkpoints,
              runId
            );
            result = dispatched.result;
          }

          await sessionManager.appendHistory({
            type: 'auto_iteration',
            agent,
            iteration,
            task: currentTask,
            success: Boolean(result.success),
            result: result.result
          });
          if (useMemory) {
            const response = String(result.result || '').trim();
            const isControlPrompt =
              currentTask.startsWith('The previous changes have been staged in sandbox') ||
              currentTask.startsWith('Continue working on:');
            const hasSignal = response.length > 0;
            const isSuccessful = Boolean(result.success);
            const validation = extractValidationSignals(result, Boolean(options.memoryRequireValidation));
            if (hasSignal && isSuccessful && !isControlPrompt && validation.passed) {
              const saved = await agentKeeper.recordSafe({
                runId,
                tier: 'worker',
                task,
                result: response,
                agent,
                structured: {
                  problem: task,
                  validation: {
                    lintPassed: validation.lintPassed,
                    testsPassed: validation.testsPassed,
                    notes: validation.notes
                  },
                  outcome: 'success'
                },
                metadata: {
                  iteration,
                  promptKind: 'user-task',
                  success: true,
                  validationRequired: validation.required,
                  validationPassed: validation.passed
                }
              });
              if (!saved.ok) {
                logger.warn(`Memory write skipped: ${saved.error}`);
              }
            }
          }

          if (result.costUsd && result.model) {
            await sessionManager.trackCost({
              model: result.model,
              usd: result.costUsd,
              promptTokens: result.promptTokens || 0,
              completionTokens: result.completionTokens || 0
            });
          }

          const responseText = String(result.result || '');
          console.log(chalk.cyan('\n  Response:'));
          logger.printWithHighlight(responseText);

          // Parse and add to sandbox
          const edits = await orchestrator.parseAndApplyToSandbox(responseText);
          await checkpoints.append(runId, 'auto.iteration', {
            iteration,
            agent,
            success: Boolean(result.success),
            edits: edits.length
          });
          if (edits.length > 0) {
            logger.success(`  ✓ Added ${edits.length} file changes to sandbox`);
            if (options.lspAutoFix) {
              const lspFix = await runLspAutoFixCycle(
                projectDir,
                Number.parseInt(options.lspAutoFixMaxAttempts || '3', 10),
                {
                  router: agentRouter,
                  orchestrator,
                  sessionId: await sessionManager.getSessionId(),
                  gateway: options.gateway,
                  model: options.model,
                  fallbackModels,
                  checkpoints,
                  runId,
                  logger
                }
              );
              if (lspFix.fixed) {
                logger.success(`  ✓ LSP auto-fix complete (${lspFix.attempts} attempt(s)).`);
              } else {
                logger.warn(`  ⚠ LSP auto-fix incomplete (${lspFix.remainingDiagnostics} diagnostics remain after ${lspFix.attempts} attempt(s)).`);
              }
            }
          }

          // Check if task appears complete
          const lowerResponse = responseText.toLowerCase();
          const completionSignals = [
            'task complete', 'task is complete', 'implementation complete',
            'all done', 'finished', 'successfully implemented',
            'no further changes needed', 'ready for review'
          ];
          
          const hasCompletionSignal = completionSignals.some(signal => lowerResponse.includes(signal));
          
          if (hasCompletionSignal) {
            logger.success(chalk.green(`\n✓ Task appears complete after ${iteration} iteration(s)`));
            break;
          }

          // If we have sandbox changes, ask the LLM to verify and continue or finish
          if (edits.length > 0 && iteration < maxIterations) {
            currentTask = `The previous changes have been staged in sandbox. Please verify the implementation is complete and correct. If there are any remaining issues, fix them. If everything looks good, respond with "Task complete."`;
          } else if (iteration >= maxIterations) {
            logger.warn(chalk.yellow(`\n⚠️  Reached max iterations (${maxIterations})`));
            break;
          } else {
            // No edits detected, ask for next step
            currentTask = `Continue working on: ${task}`;
          }
        } catch (err) {
          logger.error(`Iteration ${iteration} failed: ${(err as Error).message}`);
          failedRun = true;
          await checkpoints.append(runId, 'auto.error', {
            iteration,
            error: (err as Error).message
          });
          
          await sessionManager.appendHistory({
            type: 'auto_error',
            iteration,
            task: currentTask,
            error: (err as Error).message
          });
          
          break;
        }
      }

      // Show final sandbox state
      const activeBranch = sandbox.getActiveBranch();
      if (sandbox.hasChanges(activeBranch)) {
        console.log(chalk.blue('\n--- Pending Changes ---'));
        console.log(logger.highlightDiff(sandbox.preview(activeBranch)));
        
        if (options.autoApply) {
          try {
            const paths = sandbox.getPendingPaths(activeBranch);
            const report = await analyzeBlastRadius(projectDir, { changedFiles: paths });
            const patchRisk = scorePatchRisk({
              blastRadius: report,
              changedFiles: paths.length
            });
            logger.info(`Patch confidence: ${(patchRisk.confidence * 100).toFixed(0)}% (risk score ${patchRisk.riskScore}/100, ${patchRisk.riskLevel})`);
            await checkpoints.append(runId, 'patch.risk', {
              riskLevel: patchRisk.riskLevel,
              riskScore: patchRisk.riskScore,
              confidence: patchRisk.confidence
            });
            if (options.escalateRisk && isSeverityAtLeast(patchRisk.riskLevel, String(options.riskThreshold || 'high').toLowerCase() as any)) {
              const escalationTask = `High-risk patch review requested.\nRisk score: ${patchRisk.riskScore}/100 (${patchRisk.riskLevel}).\nFiles: ${paths.join(', ')}.\nPlease review for correctness, regressions, and security concerns.`;
              const qa = await dispatchWithFallback(agentRouter, 'crew-qa', escalationTask, {
                project: projectDir,
                sessionId: await sessionManager.getSessionId(),
                gateway: options.gateway
              }, fallbackModels, checkpoints, runId);
              const sec = await dispatchWithFallback(agentRouter, 'crew-security', escalationTask, {
                project: projectDir,
                sessionId: await sessionManager.getSessionId(),
                gateway: options.gateway
              }, fallbackModels, checkpoints, runId);
              logger.info(chalk.yellow('\n--- QA Escalation ---'));
              logger.printWithHighlight(String(qa.result.result || ''));
              logger.info(chalk.yellow('\n--- Security Escalation ---'));
              logger.printWithHighlight(String(sec.result.result || ''));
            }
            if (options.blastRadiusGate && !options.forceAutoApply) {
              const threshold = (String(options.blastRadiusThreshold || 'high').toLowerCase() as 'low' | 'medium' | 'high');
              logger.info(`Blast radius: ${report.summary}`);
              if (isSeverityAtLeast(report.risk, threshold)) {
                logger.warn('Auto-apply blocked by blast-radius safety gate.');
                logger.warn(`Changed files: ${report.changedFiles.length}, direct impacts: ${report.affectedFiles.filter(f => f.relation === 'direct-importer').length}, transitive impacts: ${report.affectedFiles.filter(f => f.relation === 'transitive-importer').length}`);
                logger.warn('Re-run with --force-auto-apply or lower --blast-radius-threshold to override.');
                return;
              }
            }
            await sandbox.apply(activeBranch);
            logger.success(`\n✓ Auto-applied changes to: ${paths.join(', ')}`);
          } catch (applyErr) {
            logger.error(`Auto-apply failed: ${(applyErr as Error).message}`);
            logger.info('Run "crew apply" manually to apply changes.');
          }
        } else {
          logger.info('\nRun "crew apply" to write changes to disk, or "crew preview" to review.');
        }
      }

      const cost = await sessionManager.loadCost();
      logger.info(chalk.gray(`\nTotal session cost: $${cost.totalUsd.toFixed(4)}`));
      if (useMemory) {
        const saved = await agentKeeper.recordSafe({
          runId,
          tier: 'orchestrator',
          task,
          result: sandbox.hasChanges(sandbox.getActiveBranch())
            ? `Autonomous run finished with pending changes on branch ${sandbox.getActiveBranch()}`
            : 'Autonomous run finished with no pending changes',
          agent: 'crew-main',
          structured: {
            problem: task,
            outcome: 'run-complete'
          },
          metadata: {
            iterations: iteration,
            autoApply: Boolean(options.autoApply)
          }
        });
        if (!saved.ok) {
          logger.warn(`Memory write skipped: ${saved.error}`);
        }
        if (iteration >= 5) {
          try {
            await agentKeeper.compact();
          } catch {
            // Best-effort maintenance.
          }
        }
      }
      await checkpoints.finish(runId, failedRun ? 'failed' : 'completed');
    });

  const autofix = program
    .command('autofix')
    .description('Background AutoFix queue and worker (safe unattended fix cycles)');

  autofix
    .command('enqueue')
    .description('Queue a background AutoFix job')
    .argument('<task...>', 'Task description')
    .option('-p, --project <path>', 'Project directory', process.cwd())
    .option('-g, --gateway <url>', 'Override gateway URL')
    .option('-m, --model <id>', 'Model override', workerPrimary || undefined)
    .option('--fallback-model <id>', 'Fallback model chain entry (repeatable)', collectOption, [])
    .option('--max-iterations <n>', 'Maximum AutoFix iterations per job', '6')
    .option('--validate-cmd <cmd>', 'Validation command gate (repeatable)', collectOption, [])
    .option('--auto-apply-policy <mode>', 'never|safe|force', 'safe')
    .option('--blast-radius-threshold <level>', 'Blast-radius threshold: low|medium|high', 'high')
    .option('--lsp-auto-fix', 'Run TypeScript diagnostics auto-fix loop after edits', false)
    .option('--lsp-auto-fix-max-attempts <n>', 'Max LSP auto-fix attempts', '3')
    .action(async (taskArray, options) => {
      const task = taskArray.join(' ').trim();
      if (!task) {
        logger.error('Task is required.');
        process.exit(1);
      }
      const fallbackModels = (options.fallbackModel && options.fallbackModel.length > 0)
        ? options.fallbackModel
        : (workerPolicy.fallback || []);
      const policyRaw = String(options.autoApplyPolicy || 'safe').toLowerCase();
      const autoApplyPolicy: AutoFixApplyPolicy = policyRaw === 'force'
        ? 'force'
        : policyRaw === 'never'
          ? 'never'
          : 'safe';
      const threshold = String(options.blastRadiusThreshold || 'high').toLowerCase();
      const blastRadiusThreshold = threshold === 'low' || threshold === 'medium' || threshold === 'high'
        ? threshold
        : 'high';
      const job = await autoFixStore.enqueue({
        task,
        projectDir: options.project || process.cwd(),
        config: {
          maxIterations: Number.parseInt(options.maxIterations || '6', 10),
          model: options.model,
          fallbackModels,
          gateway: options.gateway,
          validateCommands: options.validateCmd || [],
          autoApplyPolicy,
          blastRadiusThreshold,
          lspAutoFix: Boolean(options.lspAutoFix),
          lspAutoFixMaxAttempts: Number.parseInt(options.lspAutoFixMaxAttempts || '3', 10)
        }
      });
      logger.success(`Queued AutoFix job ${job.id}`);
      logger.info(`Policy: ${job.config.autoApplyPolicy} | Max iterations: ${job.config.maxIterations} | Project: ${job.projectDir}`);
    });

  autofix
    .command('list')
    .description('List background AutoFix jobs')
    .option('--status <status>', 'Filter by status: queued|running|completed|failed|canceled')
    .option('--max <n>', 'Maximum jobs to show', '30')
    .action(async (options) => {
      const statusRaw = String(options.status || '').toLowerCase();
      const allowed: AutoFixJobStatus[] = ['queued', 'running', 'completed', 'failed', 'canceled'];
      const filterStatus = allowed.includes(statusRaw as AutoFixJobStatus)
        ? statusRaw as AutoFixJobStatus
        : undefined;
      const jobs = await autoFixStore.list({ status: filterStatus });
      const max = Math.max(1, Number.parseInt(options.max || '30', 10));
      const sliced = jobs.slice(0, max);
      if (sliced.length === 0) {
        logger.info('No AutoFix jobs found.');
        return;
      }
      for (const job of sliced) {
        const summary = job.result?.applied
          ? 'applied'
          : job.result?.proposalPath
            ? `proposal: ${job.result.proposalPath}`
            : '';
        logger.info(`${job.id} | ${job.status} | ${job.updatedAt} | ${job.task}${summary ? ` | ${summary}` : ''}`);
      }
    });

  autofix
    .command('show')
    .description('Show one AutoFix job in detail')
    .argument('<jobId>', 'AutoFix job id')
    .action(async (jobId) => {
      const job = await autoFixStore.get(jobId);
      if (!job) {
        logger.error(`Job not found: ${jobId}`);
        process.exit(1);
      }
      console.log(JSON.stringify(job, null, 2));
    });

  autofix
    .command('cancel')
    .description('Cancel a queued/running AutoFix job')
    .argument('<jobId>', 'AutoFix job id')
    .action(async (jobId) => {
      const ok = await autoFixStore.cancel(jobId);
      if (!ok) {
        logger.error(`Unable to cancel job ${jobId}. It may be missing or already final.`);
        process.exit(1);
      }
      logger.success(`Canceled ${jobId}`);
    });

  autofix
    .command('worker')
    .description('Run background AutoFix worker loop')
    .option('--once', 'Process at most one queued job and exit', false)
    .option('--max-jobs <n>', 'Stop after processing N jobs (0 = unlimited)', '0')
    .option('--poll-ms <ms>', 'Poll interval when queue is empty', '5000')
    .option('--worker-id <id>', 'Worker identity for lock/debug info', `worker-${process.pid}`)
    .action(async (options) => {
      const once = Boolean(options.once);
      const maxJobs = Math.max(0, Number.parseInt(options.maxJobs || '0', 10));
      const pollMs = Math.max(1000, Number.parseInt(options.pollMs || '5000', 10));
      const workerId = String(options.workerId || `worker-${process.pid}`);
      let processed = 0;

      logger.info(`AutoFix worker started (${workerId})`);
      while (true) {
        const job = await autoFixStore.claimNext(workerId);
        if (!job) {
          if (once || (maxJobs > 0 && processed >= maxJobs)) break;
          await new Promise(resolve => setTimeout(resolve, pollMs));
          continue;
        }

        logger.info(`Running ${job.id}: ${job.task}`);
        try {
          const result = await runAutoFixJob(job, {
            router: agentRouter,
            orchestrator,
            sandbox,
            session: sessionManager,
            logger,
            checkpoints
          });
          await autoFixStore.markCompleted(job.id, {
            ...result,
            completedAt: new Date().toISOString()
          });
          logger.success(`Completed ${job.id} | applied=${result.applied} | files=${result.editedFiles.length}`);
        } catch (error) {
          const message = String((error as Error).message || error);
          await autoFixStore.markFailed(job.id, message, {
            failedAt: new Date().toISOString()
          });
          logger.error(`Failed ${job.id}: ${message}`);
        }

        processed += 1;
        if (once || (maxJobs > 0 && processed >= maxJobs)) break;
      }
      logger.info(`AutoFix worker exiting (${workerId}). Jobs processed: ${processed}`);
    });

  program
    .command('repl')
    .description('Start interactive REPL mode for continuous conversations')
    .option('-p, --project <path>', 'Project directory', process.cwd())
    .option('-m, --mode <mode>', 'Initial REPL mode (manual|assist|autopilot)', 'manual')
    .option('--interface-mode <mode>', 'Initial interface mode (standalone|connected)')
    .option('--pick-interface', 'Show connected/standalone picker on REPL launch', false)
    .option('--strict-preflight', 'Block launch if doctor checks fail', false)
    .option('-g, --gateway <url>', 'Gateway URL for strict preflight checks')
    .action(async (options) => {
      const projectDir = options.project || process.cwd();
      const initialMode = options.mode?.toLowerCase();
      if (initialMode && !['manual', 'assist', 'autopilot'].includes(initialMode)) {
        console.error(chalk.red(`Invalid mode "${initialMode}". Must be one of: manual, assist, autopilot`));
        process.exit(1);
      }
      const interfaceMode = String(options.interfaceMode || '').toLowerCase();
      if (interfaceMode && !['standalone', 'connected'].includes(interfaceMode)) {
        console.error(chalk.red(`Invalid interface mode "${interfaceMode}". Must be one of: standalone, connected`));
        process.exit(1);
      }
      try {
        const policy = getExecutionPolicy({ strictPreflight: Boolean(options.strictPreflight) });
        await enforceStrictPreflight(policy, options.gateway);
        await startRepl({
          router: agentRouter,
          orchestrator,
          sandbox,
          session: sessionManager,
          logger,
          projectDir,
          repoConfig,
          initialMode: initialMode as 'manual' | 'assist' | 'autopilot' | undefined,
          initialInterfaceMode: (interfaceMode || undefined) as 'standalone' | 'connected' | undefined,
          promptInterfaceMode: Boolean(options.pickInterface) || (!interfaceMode && process.stdin.isTTY)
        });
      } catch (error) {
        console.error('Error starting REPL:', error);
        process.exit(1);
      }
    });

  program
    .command('tui')
    .description('Start terminal UI mode (same runtime/controller as REPL, improved layout)')
    .option('-p, --project <path>', 'Project directory', process.cwd())
    .option('-m, --mode <mode>', 'Initial TUI mode (manual|assist|autopilot)', 'manual')
    .option('--strict-preflight', 'Block launch if doctor checks fail', false)
    .option('-g, --gateway <url>', 'Gateway URL for strict preflight checks')
    .action(async (options) => {
      const projectDir = options.project || process.cwd();
      const initialMode = options.mode?.toLowerCase();
      if (initialMode && !['manual', 'assist', 'autopilot'].includes(initialMode)) {
        console.error(chalk.red(`Invalid mode "${initialMode}". Must be one of: manual, assist, autopilot`));
        process.exit(1);
      }
      try {
        const policy = getExecutionPolicy({ strictPreflight: Boolean(options.strictPreflight) });
        await enforceStrictPreflight(policy, options.gateway);
        await startTui({
          router: agentRouter,
          orchestrator,
          sandbox,
          session: sessionManager,
          logger,
          projectDir,
          repoConfig,
          initialMode: initialMode as 'manual' | 'assist' | 'autopilot' | undefined
        });
      } catch (error) {
        console.error('Error starting TUI:', error);
        process.exit(1);
      }
    });

  program
    .command('dispatch')
    .description('Dispatch a task to an agent')
    .argument('<agent>', 'Agent name')
    .argument('<task>', 'Task description')
    .option('-p, --project <path>', 'Project directory')
    .option('-g, --gateway <url>', 'Override gateway URL')
    .option('-t, --timeout <ms>', 'Timeout in milliseconds', '30000')
    .option('-m, --model <id>', 'Model ID for cost estimate', executorPrimary || 'openai/gpt-4o-mini')
    .option('--fallback-model <id>', 'Fallback model chain entry (repeatable)', collectOption, [])
    .option('--engine <id>', 'Engine override for direct/bypass gateway paths (e.g. cursor)')
    .option('--direct', 'Request direct execution path on gateway', false)
    .option('--bypass', 'Request bypass/orchestrator-skip path on gateway', false)
    .option('--output-tokens <count>', 'Expected completion tokens for estimate', '1200')
    .option('--max-cost <usd>', 'Require confirmation if estimate exceeds this USD amount', String(executorPolicy.maxCostUsd ?? 1))
    .option('--skip-cost-check', 'Skip cost estimate confirmation gate', false)
    .option('--cross-repo', 'Inject sibling repository context', false)
    .option('--cache', 'Enable output cache for dispatch result', false)
    .option('--cache-ttl <sec>', 'Output cache TTL in seconds', '1800')
    .option('--no-memory', 'Disable shared AgentKeeper memory')
    .option('--memory-max <n>', 'Max recalled memory entries', String(cliDefaults.memoryMax ?? 3))
    .option('--memory-require-validation', 'Store memory only when validation is marked passed', false)
    .option('--image <path>', 'Attach an image file to the task (repeatable)', collectOption, [])
    .option('--context-image <path>', 'Attach an image file as context (repeatable)', collectOption, [])
    .option('--image-max-bytes <n>', 'Max bytes per image context payload', '250000')
    .option('--context-file <path>', 'Attach a file as additional context (repeatable)', collectOption, [])
    .option('--context-repo <path>', 'Attach git context from another repo (repeatable)', collectOption, [])
    .option('--stdin', 'Read additional context from stdin', false)
    .option('--max-context-tokens <n>', 'Max context token budget (approx, chars/4)')
    .option('--context-budget-mode <mode>', 'trim | stop when budget exceeded', 'trim')
    .option('--docs', 'Inject matching docs context via collections search', false)
    .option('--docs-path <paths...>', 'Custom paths for docs search (default: docs/ + project root)')
    .option('--docs-code', 'Include source code files in docs retrieval index', Boolean(cliDefaults.docsCode))
    .option('--escalate-risk', 'Escalate high-risk patches to QA and Security', false)
    .option('--risk-threshold <level>', 'Escalation threshold: low|medium|high', 'high')
    .option('--retry-attempts <n>', 'Retry attempts for transient failures', '2')
    .option('--strict-preflight', 'Block execution if doctor checks fail', false)
    .option('--json', 'Output machine-readable JSON envelope', false)
    .action(async (agent, task, options) => {
      let finalTask = task;
      const runId = `dispatch-${randomUUID()}`;
      const fallbackModels = (options.fallbackModel && options.fallbackModel.length > 0)
        ? options.fallbackModel
        : (executorPolicy.fallback || []);
      try {
        const policy = getExecutionPolicy({
          strictPreflight: Boolean(options.strictPreflight),
          retryAttempts: Number.parseInt(options.retryAttempts || '2', 10),
          riskThreshold: String(options.riskThreshold || 'high').toLowerCase() as any
        });
        await enforceStrictPreflight(policy, options.gateway);
        await checkpoints.beginRun({ runId, mode: 'dispatch', task });
        const useMemory = options.memory !== false;
        if (useMemory) {
          const pathHints = (options.contextFile || []).map((p: string) => String(p).trim()).filter(Boolean);
          const matches = await agentKeeper.recall(finalTask, Number.parseInt(options.memoryMax || '3', 10), {
            preferSuccessful: true,
            pathHints
          });
          const avgScore = matches.length
            ? matches.reduce((sum, m) => sum + Number(m.score || 0), 0) / matches.length
            : 0;
          await sessionManager.trackMemoryRecall({
            used: true,
            miss: matches.length === 0,
            matchCount: matches.length,
            qualityScore: avgScore
          });
          if (matches.length > 0) {
            const memoryContext = await agentKeeper.recallAsContext(finalTask, Number.parseInt(options.memoryMax || '3', 10), {
              preferSuccessful: true,
              pathHints
            });
            finalTask = `${finalTask}\n\n${memoryContext}`;
          }
        }
        const fileBlock = await buildFileContextBlock(options.contextFile || []);
        const repoBlock = await buildRepoContextBlock(options.contextRepo || []);
        const imagePaths = [...(options.image || []), ...(options.contextImage || [])];
        const imageBlock = await buildImageContextBlock(
          imagePaths,
          Number.parseInt(options.imageMaxBytes || '250000', 10)
        );
        const stdinText = options.stdin ? await readStdinText() : '';
        const stdinBlock = stdinText ? `## Stdin Context\n\`\`\`text\n${stdinText}\n\`\`\`` : '';

        let docsBlock = '';
        if (options.docs) {
          const { buildCollectionIndex, searchCollection } = await import('../collections/index.js');
          const docsPaths = options.docsPath && options.docsPath.length > 0
            ? options.docsPath
            : [join(process.cwd(), 'docs'), process.cwd()];
          const index = await buildCollectionIndex(docsPaths, {
            includeCode: Boolean(options.docsCode)
          });
          const result = searchCollection(index, task, 5);
          if (result.hits.length > 0) {
            const chunks = result.hits.map(h => `### ${h.source}:${h.startLine} (score: ${h.score})\n${h.text}`);
            docsBlock = `## Docs Context (auto-retrieved)\n${chunks.join('\n\n')}`;
          }
        }

        const budget = enforceContextBudget(
          finalTask,
          [fileBlock, repoBlock, imageBlock, stdinBlock, docsBlock],
          options.maxContextTokens ? Number.parseInt(options.maxContextTokens, 10) : undefined,
          options.contextBudgetMode === 'stop' ? 'stop' : 'trim'
        );
        if (budget.exceeded) {
          throw new Error(`Context budget exceeded (~${budget.estimatedTokens} tokens > ${options.maxContextTokens}). Use --context-budget-mode trim or raise budget.`);
        }
        if (budget.trimmed) {
          logger.warn(`Context trimmed to stay under budget (~${budget.estimatedTokens} tokens).`);
        }
        finalTask = budget.task;

        if (options.crossRepo) {
          const multiContext = await collectMultiRepoContext(options.project || process.cwd());
          finalTask = `${finalTask}\n\n${multiContext}`;
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
          sessionId,
          images: options.image || []
        };

        await sessionManager.appendHistory({
          type: 'dispatch_request',
          agent,
          task: finalTask,
          projectDir
        });

        logger.info(`Dispatching task to ${agent}: ${finalTask}`);
        let result: any;
        if (options.cache) {
          const cacheKey = TokenCache.hashKey(JSON.stringify({
            kind: 'dispatch-output',
            agent,
            task: finalTask,
            projectDir,
            gateway: options.gateway || '',
            model: options.model || '',
            engine: options.engine || '',
            direct: Boolean(options.direct),
            bypass: Boolean(options.bypass)
          }));
          const cached = await tokenCache.get<any>('output', cacheKey);
          if (cached.hit && cached.value) {
            logger.info('Using cached dispatch output.');
            result = cached.value;
            await sessionManager.trackCacheSavings({
              hit: true,
              tokensSaved: Number(cached.meta?.tokensSaved || 0),
              usdSaved: Number(cached.meta?.usdSaved || 0)
            });
          } else {
            await sessionManager.trackCacheSavings({ miss: true });
            const dispatched = await dispatchWithFallback(
              agentRouter,
              agent,
              finalTask,
              dispatchOptions,
              fallbackModels,
              checkpoints,
              runId
            );
            result = dispatched.result;
            await tokenCache.set(
              'output',
              cacheKey,
              result,
              Number.parseInt(options.cacheTtl || '1800', 10),
              {
                tokensSaved: estimate.inputTokens + estimate.outputTokens,
                usdSaved: estimate.totalUsd,
                source: 'dispatch-output'
              }
            );
          }
        } else {
          const dispatched = await withRetries(
            async () => dispatchWithFallback(
              agentRouter,
              agent,
              finalTask,
              dispatchOptions,
              fallbackModels,
              checkpoints,
              runId
            ),
            policy,
            { shouldRetry: shouldRetryWithFallback }
          );
          result = dispatched.result;
        }

        await sessionManager.appendHistory({
          type: 'dispatch_result',
          agent,
          taskId: result.taskId || null,
          success: Boolean(result.success),
          result: result.result
        });
        if (useMemory) {
          const response = String(result.result || '').trim();
          const validation = extractValidationSignals(result, Boolean(options.memoryRequireValidation));
          if (Boolean(result.success) && response.length > 0 && validation.passed) {
            const saved = await agentKeeper.recordSafe({
              runId,
              tier: 'orchestrator',
              task,
              result: response,
              agent,
              structured: {
                problem: task,
                validation: {
                  lintPassed: validation.lintPassed,
                  testsPassed: validation.testsPassed,
                  notes: validation.notes
                },
                outcome: 'success'
              },
              metadata: {
                taskId: result.taskId || null,
                success: true,
                validationRequired: validation.required,
                validationPassed: validation.passed
              }
            });
            if (!saved.ok) {
              logger.warn(`Memory write skipped: ${saved.error}`);
            }
          }
        }
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

        const responseText = String(result.result || '');
        const edits = await orchestrator.parseAndApplyToSandbox(responseText);
        const capabilityHandshake = getCapabilityHandshake('standalone');
        await checkpoints.append(runId, 'dispatch.completed', {
          agent,
          success: Boolean(result.success),
          edits: edits.length
        });
        let riskReport: any = null;
        let patchRisk: any = null;
        if (edits.length > 0) {
          riskReport = await analyzeBlastRadius(process.cwd(), { changedFiles: edits });
          patchRisk = scorePatchRisk({
            blastRadius: riskReport,
            changedFiles: edits.length
          });
          logger.info(`Patch confidence: ${(patchRisk.confidence * 100).toFixed(0)}% (risk score ${patchRisk.riskScore}/100, ${patchRisk.riskLevel})`);
          if (options.escalateRisk && isSeverityAtLeast(patchRisk.riskLevel, String(options.riskThreshold || 'high').toLowerCase() as any)) {
            const escalationTask = `High-risk patch review requested.\nRisk score: ${patchRisk.riskScore}/100 (${patchRisk.riskLevel}).\nFiles: ${edits.join(', ')}.\nPlease review for correctness, regressions, and security concerns.`;
            const qa = await dispatchWithFallback(agentRouter, 'crew-qa', escalationTask, {
              project: projectDir,
              sessionId,
              gateway: options.gateway
            }, fallbackModels, checkpoints, runId);
            const sec = await dispatchWithFallback(agentRouter, 'crew-security', escalationTask, {
              project: projectDir,
              sessionId,
              gateway: options.gateway
            }, fallbackModels, checkpoints, runId);
            logger.info(chalk.yellow('\n--- QA Escalation ---'));
            logger.printWithHighlight(String(qa.result.result || ''));
            logger.info(chalk.yellow('\n--- Security Escalation ---'));
            logger.printWithHighlight(String(sec.result.result || ''));
          }
        }

        if (options.json) {
          printJsonEnvelope('dispatch.result', {
            runId,
            agent,
            taskId: result.taskId || null,
            success: Boolean(result.success),
            response: responseText,
            edits,
            needsApproval: edits.length > 0,
            risk: patchRisk || null,
            blastRadius: riskReport || null,
            capabilityHandshake
          });
          await checkpoints.finish(runId, 'completed');
          return;
        }

        logger.success('Task completed:', result);
        await checkpoints.finish(runId, 'completed');
      } catch (error) {
        await sessionManager.appendHistory({
          type: 'dispatch_error',
          agent,
          task: finalTask,
          error: error.message
        });
        await checkpoints.append(runId, 'dispatch.error', { error: error.message });
        await checkpoints.finish(runId, 'failed');
        logger.error('Dispatch failed:', error.message);
        process.exit(1);
      }
    });

  program
    .command('status')
    .description('Show CrewSwarm orchestration status dashboard')
    .action(async () => {
      const { displayStatus } = await import('../status/dashboard.ts');
      await displayStatus();
    });

  program
    .command('capabilities')
    .description('Show runtime capability handshake for current interface mode')
    .option('--json', 'Output as JSON', false)
    .action(options => {
      // crew-CLI is always standalone - no connected mode
      const mode = 'standalone';
      const handshake = getCapabilityHandshake(mode);
      if (options.json) {
        printJsonEnvelope('capabilities', { handshake });
        return;
      }
      console.log(chalk.blue('\n--- Capability Handshake ---\n'));
      console.log(`  mode        : ${handshake.mode}`);
      console.log(`  can_read    : ${handshake.can_read}`);
      console.log(`  can_write   : ${handshake.can_write}`);
      console.log(`  can_pty     : ${handshake.can_pty}`);
      console.log(`  can_lsp     : ${handshake.can_lsp}`);
      console.log(`  can_dispatch: ${handshake.can_dispatch}`);
      console.log(`  can_git     : ${handshake.can_git}`);
    });

  program
    .command('run')
    .description('Execute unified pipeline task (supports phase-aware resume from trace checkpoint)')
    .option('-t, --task <text>', 'Task text for a new run')
    .option('--resume <traceId>', 'Resume/replay a prior pipeline trace id')
    .option('--from-phase <phase>', 'Resume from phase: plan|execute|validate')
    .option('--retry-attempts <n>', 'Retry attempts for transient failures', '2')
    .option('--strict-preflight', 'Block execution if doctor checks fail', false)
    .option('-g, --gateway <url>', 'Gateway URL for strict preflight checks')
    .option('--json', 'Output machine-readable JSON envelope', false)
    .action(async options => {
      try {
        const policy = getExecutionPolicy({
          strictPreflight: Boolean(options.strictPreflight),
          retryAttempts: Number.parseInt(options.retryAttempts || '2', 10)
        });
        await enforceStrictPreflight(policy, options.gateway);

        let task = String(options.task || '').trim();
        let resumedFrom: string | null = null;
        let previousPhase: string | null = null;
        let resumeContext: any = undefined;

        if (options.resume) {
          const traceId = String(options.resume).trim();
          const events = await loadPipelineRunEvents(traceId, process.cwd());
          const resumeInfo = inferResumeTask(events);
          if (!resumeInfo) {
            throw new Error(`Unable to infer task from trace ${traceId}.`);
          }
          task = task || resumeInfo.task;
          resumedFrom = traceId;
          previousPhase = resumeInfo.phase;
          const requestedPhase = String(options.fromPhase || '').toLowerCase();
          const fromPhase = requestedPhase || (previousPhase === 'failed' ? 'execute' : 'plan');
          if (!['plan', 'execute', 'validate'].includes(fromPhase)) {
            throw new Error(`Invalid --from-phase "${fromPhase}". Use plan|execute|validate.`);
          }
          const artifacts = extractResumeArtifacts(events);
          if (fromPhase === 'execute' || fromPhase === 'validate') {
            if (!artifacts.priorPlan) {
              throw new Error(`Trace ${traceId} missing prior plan artifact; cannot resume from ${fromPhase}.`);
            }
          }
          if (fromPhase === 'validate' && !artifacts.priorResponse) {
            throw new Error(`Trace ${traceId} missing prior validation input; cannot resume from validate.`);
          }
          resumeContext = {
            fromPhase,
            priorPlan: artifacts.priorPlan,
            priorResponse: artifacts.priorResponse,
            priorExecutionResults: artifacts.priorExecutionResults
          };

          if (previousPhase === 'complete' && fromPhase === 'plan') {
            if (options.json) {
              printJsonEnvelope('run.resume', {
                resumedFrom,
                previousPhase,
                task,
                skipped: true,
                reason: 'already-complete'
              });
              return;
            }
            logger.info(`Trace ${traceId} already completed. Re-running task for deterministic replay.`);
          }
        }

        if (!task) {
          throw new Error('Provide --task for a new run or --resume <traceId> for replay.');
        }

        const sessionId = await sessionManager.getSessionId();
        const result = await withRetries(
          async () => orchestrator.executePipeline(task, '', sessionId, resumeContext),
          policy
        );
        const responseText = String(result.response || result.result || '');
        const edits = await orchestrator.parseAndApplyToSandbox(responseText);
        const capabilityHandshake = getCapabilityHandshake(
          String(process.env.CREW_INTERFACE_MODE || 'standalone').toLowerCase() === 'connected'
            ? 'connected'
            : 'standalone'
        );

        if (options.json) {
          printJsonEnvelope('run.result', {
            task,
            resumedFrom,
            previousPhase,
            resumedPhase: resumeContext?.fromPhase || null,
            traceId: result.traceId || null,
            phase: result.phase || null,
            decision: result.plan?.decision || null,
            executionPath: Array.isArray(result.executionPath) ? result.executionPath : [],
            timeline: Array.isArray(result.timeline) ? result.timeline : [],
            response: responseText,
            edits,
            needsApproval: edits.length > 0,
            capabilityHandshake
          });
          return;
        }

        logger.printWithHighlight(responseText);
        if (Array.isArray(result.timeline) && result.timeline.length > 0) {
          console.log(chalk.gray('\nPipeline timeline:'));
          for (const step of result.timeline) {
            console.log(chalk.gray(`  - ${step.phase} @ ${step.ts}`));
          }
        }
        if (edits.length > 0) {
          logger.success(`Staged ${edits.length} file change(s). Run "crew preview" then "crew apply".`);
        }
      } catch (error) {
        logger.error(`Run failed: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  program
    .command('map')
    .description('Generate a repository structure graph respecting .gitignore')
    .option('--graph', 'Emit dependency graph instead of tree output', false)
    .option('--visualize', 'Generate interactive HTML graph (implies --graph)', false)
    .option('--out <path>', 'Output path for --visualize HTML', join(process.cwd(), '.crew', 'repo-graph.html'))
    .option('--json', 'Emit graph as JSON', false)
    .option('--max-nodes <n>', 'Limit graph nodes in text mode', '200')
    .action(async (options) => {
      const {
        buildRepositoryGraph,
        buildRepositoryMap,
        buildRepositoryGraphDot,
        buildRepositoryGraphHtml
      } = await import('../mapping/index.js');
      try {
        if (options.graph || options.visualize) {
          const graph = await buildRepositoryGraph(process.cwd());
          if (options.visualize) {
            const htmlPath = String(options.out || join(process.cwd(), '.crew', 'repo-graph.html'));
            await mkdir(dirname(htmlPath), { recursive: true });
            const html = buildRepositoryGraphHtml(graph);
            await writeFile(htmlPath, html, 'utf8');
            const dotPath = `${htmlPath}.dot`;
            await writeFile(dotPath, buildRepositoryGraphDot(graph), 'utf8');
            logger.success(`Wrote graph visualization: ${htmlPath}`);
            logger.info(`Wrote Graphviz DOT: ${dotPath}`);
            return;
          }
          if (options.json) {
            console.log(JSON.stringify(graph, null, 2));
            return;
          }
          const maxNodes = Number.parseInt(options.maxNodes || '200', 10);
          console.log(chalk.blue('--- Repository Dependency Graph ---'));
          console.log(`Root: ${graph.root}`);
          console.log(`Nodes: ${graph.nodeCount}`);
          console.log(`Edges: ${graph.edgeCount}`);
          const shown = graph.nodes.slice(0, Math.max(1, maxNodes));
          for (const node of shown) {
            const imports = node.imports.length ? node.imports.join(', ') : '(none)';
            const importedBy = node.importedBy.length ? node.importedBy.join(', ') : '(none)';
            console.log(`\n- ${node.path}`);
            console.log(`  imports: ${imports}`);
            console.log(`  importedBy: ${importedBy}`);
          }
          if (graph.nodes.length > shown.length) {
            console.log(`\n... ${graph.nodes.length - shown.length} more nodes omitted`);
          }
          return;
        }

        const map = await buildRepositoryMap(process.cwd());
        console.log(chalk.blue('--- Repository Tree Map ---'));
        console.log(map);
      } catch (err) {
        logger.error(`Failed to generate map: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  const lsp = program
    .command('lsp')
    .description('Language-server style utilities (typecheck, completions)');

  lsp
    .command('check')
    .description('Run TypeScript diagnostics for the current project')
    .argument('[files...]', 'Optional relative files to filter diagnostics')
    .option('--json', 'Emit JSON', false)
    .action(async (files, options) => {
      try {
        const { typeCheckProject } = await import('../lsp/index.js');
        const diagnostics = typeCheckProject(process.cwd(), files || []);
        if (options.json) {
          console.log(JSON.stringify({ count: diagnostics.length, diagnostics }, null, 2));
          return;
        }
        if (diagnostics.length === 0) {
          logger.success('No LSP diagnostics found.');
          return;
        }
        console.log(chalk.yellow(`Found ${diagnostics.length} diagnostic(s):`));
        for (const diag of diagnostics) {
          console.log(`${diag.category.toUpperCase()} ${diag.code} ${diag.file}:${diag.line}:${diag.column}`);
          console.log(`  ${diag.message}`);
        }
        process.exit(1);
      } catch (error) {
        logger.error(`LSP check failed: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  lsp
    .command('complete')
    .description('Get code completions at a cursor position')
    .argument('<file>', 'Relative or absolute path to source file')
    .argument('<line>', '1-based line number')
    .argument('<column>', '1-based column number')
    .option('--prefix <text>', 'Filter completions by prefix', '')
    .option('--limit <n>', 'Max completion count', '50')
    .option('--json', 'Emit JSON', false)
    .action(async (file, line, column, options) => {
      try {
        const { getCompletions } = await import('../lsp/index.js');
        const completions = getCompletions(
          process.cwd(),
          file,
          Number.parseInt(line, 10),
          Number.parseInt(column, 10),
          Number.parseInt(options.limit || '50', 10),
          String(options.prefix || '')
        );
        if (options.json) {
          console.log(JSON.stringify({ count: completions.length, completions }, null, 2));
          return;
        }
        if (completions.length === 0) {
          logger.warn('No completions found.');
          return;
        }
        console.log(chalk.blue(`Completions (${completions.length}):`));
        completions.forEach(item => {
          console.log(`- ${item.name} (${item.kind})`);
        });
      } catch (error) {
        logger.error(`LSP completion failed: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  program
    .command('pty')
    .description('Run an interactive command in a pseudo-terminal')
    .argument('<command...>', 'Command to execute in PTY')
    .option('-p, --project <path>', 'Working directory', process.cwd())
    .option('--timeout <ms>', 'Timeout in milliseconds (0 disables)', '0')
    .action(async (commandArray, options) => {
      const command = commandArray.join(' ');
      try {
        const { runPtyCommand } = await import('../pty/index.js');
        const result = await runPtyCommand(command, {
          cwd: options.project || process.cwd(),
          timeoutMs: Number.parseInt(options.timeout || '0', 10)
        });
        if (!result.success) {
          process.exit(result.exitCode === 0 ? 1 : result.exitCode);
        }
      } catch (error) {
        logger.error(`PTY command failed: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  program
    .command('shell')
    .description('Translate natural language into a shell command and execute it (GitHub Copilot CLI style)')
    .argument('<request...>', 'Natural language request (e.g. "list files sorted by size")')
    .option('-m, --model <id>', 'Model override for shell command generation')
    .action(async (requestArray, options) => {
      const { runShellCopilot } = await import('../shell/index.js');
      await runShellCopilot(requestArray.join(' '), agentRouter, {
        projectDir: process.cwd(),
        model: options.model
      });
    });

  program
    .command('exec')
    .description('Run a one-shot task or interactive terminal command with PTY support')
    .argument('<command>', 'Command to run')
    .argument('[args...]', 'Arguments for the command')
    .option('-m, --model <id>', 'Model override for one-shot task fallback')
    .option('--json', 'Output machine-readable JSON envelope for one-shot task fallback', false)
    .action(async (command, args, options) => {
      const looksLikeNaturalLanguage =
        args.length === 0 &&
        typeof command === 'string' &&
        /\s/.test(command.trim());

      if (looksLikeNaturalLanguage) {
        logger.info('Interpreting `crew exec` input as a one-shot task. Use `crew exec <cmd> [args...]` for PTY commands.');
        try {
          const standaloneRuntime = await getStandaloneRuntime(process.cwd());
          const result = await standaloneRuntime.orchestrator.executeAgentic(command, {
            sessionId: await standaloneRuntime.sessionManager.getSessionId(),
            model: options.model
          });
          const responseText = String(result.response || result.result || '');
          const edits = await standaloneRuntime.orchestrator.parseAndApplyToSandbox(responseText);
          await standaloneRuntime.sessionManager.appendHistory({
            input: command,
            response: responseText,
            decision: result.plan?.decision || 'execute',
            agent: 'unified-pipeline',
            model: String(result.plan?.validation?.modelUsed || options.model || 'unknown'),
            costUsd: result.totalCost
          });
          if (options.json) {
            printJsonEnvelope('exec.result', {
              route: result.plan
                ? {
                    decision: result.plan.decision.toUpperCase(),
                    explanation: result.plan.reasoning
                  }
                : { decision: 'EXECUTE', explanation: 'Direct L3 execution' },
              agent: 'unified-pipeline',
              response: responseText,
              edits,
              needsApproval: edits.length > 0,
              traceId: result.traceId,
              timeline: result.timeline
            });
            return;
          }
          console.log(responseText);
          if (edits.length > 0) {
            logger.success(`Added changes to ${edits.length} files in sandbox. Run "crew preview" to review.`);
          }
          return;
        } catch (err) {
          logger.error(`One-shot task failed: ${(err as Error).message}`);
          process.exit(1);
        }
      }

      // Unified: use src/pty implementation (has fallback logic)
      const { runPtyCommand } = await import('../pty/index.js');
      try {
        const fullCommand = [command, ...args].join(' ');
        const result = await runPtyCommand(fullCommand);
        process.exit(result.exitCode);
      } catch (err) {
        logger.error(`Interactive command failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  program
    .command('lsp-check')
    .description('Run LSP type checking on a file')
    .argument('<file>', 'File to check')
    .action(async (file) => {
      const { LspService } = await import('../lsp/index.js');
      const service = new LspService(process.cwd());
      const diagnostics = service.getDiagnostics(file);
      
      if (diagnostics.length === 0) {
        logger.success('No type errors found.');
      } else {
        console.log(chalk.red(`Found ${diagnostics.length} errors:`));
        diagnostics.forEach(d => console.log(`- ${d}`));
      }
    });

  program
    .command('lsp-complete')
    .description('Get LSP autocomplete suggestions at a specific position')
    .argument('<file>', 'File path')
    .argument('<line>', 'Line number (1-based)')
    .argument('<char>', 'Character number (1-based)')
    .action(async (file, lineStr, charStr) => {
      const { LspService } = await import('../lsp/index.js');
      const service = new LspService(process.cwd());
      const line = parseInt(lineStr, 10);
      const char = parseInt(charStr, 10);
      const completions = service.getCompletions(file, line, char);
      
      if (completions.length === 0) {
        logger.info('No completions found.');
      } else {
        console.log(chalk.blue(`--- Autocomplete (${completions.length}) ---`));
        console.log(completions.slice(0, 50).join(', ') + (completions.length > 50 ? '...' : ''));
      }
    });

  program
    .command('explore')
    .description('Speculative execution: run a task on 3 parallel branches with different strategies')
    .argument('<task...>', 'Task to explore')
    .option('-p, --project <path>', 'Project directory')
    .option('-g, --gateway <url>', 'Override gateway URL')
    .action(async (taskArray, options) => {
      const task = taskArray.join(' ');
      const projectDir = options.project || process.cwd();
      const sessionId = await sessionManager.getSessionId();

      logger.info(chalk.blue(`\n🔀 Exploring 3 approaches for: ${task}`));

      const branches = [
        { name: 'explore-minimal', prompt: `Implement this task with the MINIMAL possible changes. Be extremely concise and surgical: "${task}"` },
        { name: 'explore-clean', prompt: `Implement this task following CLEAN ARCHITECTURE principles. Prioritize maintainability and best practices: "${task}"` },
        { name: 'explore-pragmatic', prompt: `Implement this task with a PRAGMATIC approach. Balance speed and quality: "${task}"` }
      ];

      const originalBranch = sandbox.getActiveBranch();
      const results: any[] = [];

      // Run in parallel
      await Promise.all(branches.map(async (b) => {
        try {
          logger.info(chalk.gray(`  Starting ${b.name}...`));
          
          // Create and switch to branch
          try {
            await sandbox.createBranch(b.name, originalBranch);
          } catch {
            await sandbox.switchBranch(b.name);
            await sandbox.rollback(b.name);
          }

          const result = await agentRouter.dispatch('crew-coder', b.prompt, {
            project: projectDir,
            sessionId: `${sessionId}-${b.name}`,
            gateway: options.gateway
          });

          const edits = await orchestrator.parseAndApplyToSandbox(String(result.result || ''));
          
          results.push({
            name: b.name,
            success: true,
            edits: edits.length,
            result: result.result
          });

          logger.success(`  ✓ Completed ${b.name} (${edits.length} files)`);
        } catch (err) {
          logger.error(`  ✗ ${b.name} failed: ${(err as Error).message}`);
          results.push({ name: b.name, success: false, error: (err as Error).message });
        }
      }));

      // Switch back to original branch
      await sandbox.switchBranch(originalBranch);

      console.log(chalk.blue('\n--- Exploration Results ---'));
      results.forEach(r => {
        if (r.success) {
          console.log(chalk.green(`  ${r.name}: ${r.edits} files modified`));
        } else {
          console.log(chalk.red(`  ${r.name}: Failed (${r.error})`));
        }
      });

      const { choice } = await (import('inquirer')).then(m => m.default.prompt([{
        type: 'list',
        name: 'choice',
        message: 'Which approach would you like to inspect or merge?',
        choices: [
          ...results.filter(r => r.success).map(r => r.name),
          'none'
        ]
      }]));

      if (choice !== 'none') {
        await sandbox.switchBranch(choice);
        logger.info(`Switched to branch: ${choice}. Use "crew preview" to review or "crew merge ${choice} main" to merge.`);
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

  const configCmd = program
    .command('config')
    .description('Manage repo-level configuration in .crew/config.json and .crew/config.local.json');

  configCmd
    .command('show')
    .description('Show resolved/team/user repo configuration')
    .option('--scope <scope>', 'resolved | team | user', 'resolved')
    .option('--json', 'Output JSON', false)
    .action(async (options) => {
      const scope = String(options.scope || 'resolved').toLowerCase();
      if (!['resolved', 'team', 'user'].includes(scope)) {
        logger.error('Invalid scope. Use: resolved | team | user');
        process.exit(1);
      }
      const value = scope === 'resolved'
        ? await loadResolvedRepoConfig(process.cwd())
        : await readRepoConfig(process.cwd(), scope as 'team' | 'user');
      const redacted = redactRepoConfigForDisplay(value);
      if (options.json) {
        console.log(JSON.stringify(redacted, null, 2));
        return;
      }
      console.log(chalk.blue(`--- Repo Config (${scope}) ---`));
      console.log(JSON.stringify(redacted, null, 2));
    });

  configCmd
    .command('get')
    .description('Get a repo config value by dotted key path')
    .argument('<key>', 'Dotted key path (e.g. cli.model)')
    .option('--scope <scope>', 'resolved | team | user', 'resolved')
    .option('--json', 'Output JSON', false)
    .action(async (key, options) => {
      const scope = String(options.scope || 'resolved').toLowerCase();
      if (!['resolved', 'team', 'user'].includes(scope)) {
        logger.error('Invalid scope. Use: resolved | team | user');
        process.exit(1);
      }
      const source = scope === 'resolved'
        ? await loadResolvedRepoConfig(process.cwd())
        : await readRepoConfig(process.cwd(), scope as 'team' | 'user');
      const value = getNestedValue(source as Record<string, unknown>, String(key));
      if (value === undefined) {
        logger.warn(`No value found for key "${key}" in ${scope} config.`);
        process.exit(1);
      }
      const redacted = redactRepoConfigForDisplay(value);
      if (options.json) {
        console.log(JSON.stringify(redacted, null, 2));
        return;
      }
      if (typeof redacted === 'object') {
        console.log(JSON.stringify(redacted, null, 2));
      } else {
        console.log(String(redacted));
      }
    });

  configCmd
    .command('set')
    .description('Set a repo config value by dotted key path')
    .argument('<key>', 'Dotted key path (e.g. repl.autoApply)')
    .argument('<value>', 'Value (string by default, or JSON with --json)')
    .option('--scope <scope>', 'team | user', 'user')
    .option('--json', 'Parse value as JSON', false)
    .action(async (key, value, options) => {
      const scope = String(options.scope || 'user').toLowerCase();
      if (!['team', 'user'].includes(scope)) {
        logger.error('Invalid scope for set. Use: team | user');
        process.exit(1);
      }
      let parsedValue: unknown;
      try {
        parsedValue = parseConfigValue(String(value), Boolean(options.json));
      } catch (error) {
        logger.error(`Invalid value: ${(error as Error).message}`);
        process.exit(1);
      }
      await setRepoConfigValue(process.cwd(), scope as 'team' | 'user', String(key), parsedValue);
      logger.success(`Set ${scope}.${String(key)} = ${JSON.stringify(redactRepoConfigForDisplay(parsedValue))}`);
    });

  program
    .command('github')
    .description('Natural language GitHub issue/PR flows via gh CLI')
    .argument('<request...>', 'Natural language request or "doctor"')
    .option('--repo <owner/name>', 'Override GitHub repository (default: current git remote)')
    .option('--limit <n>', 'Default list limit for list requests', '10')
    .option('-y, --yes', 'Skip confirmation gate for mutating actions', false)
    .option('--dry-run', 'Parse and print the exact gh command without executing', false)
    .option('--json', 'Output raw gh JSON for list flows when available', false)
    .action(async (requestArray, options) => {
      const request = String((requestArray || []).join(' ') || '').trim();
      if (request.toLowerCase() === 'doctor') {
        const checks = await runGitHubDoctor(process.cwd(), options.repo);
        let failed = false;
        for (const check of checks) {
          const marker = check.ok ? chalk.green('✓') : chalk.red('✗');
          console.log(`${marker} ${check.name}: ${check.details}`);
          if (!check.ok) failed = true;
        }
        if (failed) process.exit(1);
        return;
      }
      const intent = parseGitHubIntent(request, {
        defaultLimit: Number.parseInt(options.limit || '10', 10)
      });
      if (intent.kind === 'unknown') {
        logger.error(intent.reason);
        logger.info('Try examples:');
        logger.info('  crew github "list open issues limit 20"');
        logger.info('  crew github "create issue \\"Fix login bug\\" body: repro steps..."');
        logger.info('  crew github "update issue #42 close"');
        logger.info('  crew github "create draft pr \\"Refactor auth\\" body: summary..."');
        process.exit(1);
      }

      logger.info(`Intent: ${describeIntent(intent)}`);
      const ghArgs = buildGitHubCommand(intent, options.repo);
      if (options.dryRun) {
        console.log(chalk.blue('\n--- GitHub Dry Run ---'));
        console.log(`Intent: ${describeIntent(intent)}`);
        console.log(`Command: ${commandToShell(ghArgs)}`);
        return;
      }
      if (requiresConfirmation(intent) && !options.yes) {
        const answer = await (await import('inquirer')).default.prompt([{
          type: 'confirm',
          name: 'confirm',
          message: `Proceed with: ${describeIntent(intent)}?`,
          default: false
        }]);
        if (!answer.confirm) {
          logger.warn('Cancelled.');
          return;
        }
      }

      try {
        const output = await executeGitHubIntent(intent, {
          cwd: process.cwd(),
          repo: options.repo
        });
        if (options.json || intent.kind === 'issue_create' || intent.kind === 'issue_update' || intent.kind === 'pr_draft') {
          console.log(output);
          return;
        }
        try {
          const parsed = JSON.parse(output);
          console.log(JSON.stringify(parsed, null, 2));
        } catch {
          console.log(output);
        }
      } catch (error) {
        logger.error(`GitHub command failed: ${(error as Error).message}`);
        process.exit(1);
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
    .option('--provider <id>', 'STT provider: auto | groq | openai | whisper-cli', 'auto')
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
    .command('review')
    .description('Analyze current git diff before commit and request a QA-style review')
    .option('--agent <id>', 'Agent to run review with', 'crew-qa')
    .option('--strict', 'Exit non-zero if review includes high-severity findings', false)
    .action(async options => {
      const review = await getReviewPayload(process.cwd());
      if (!review.hasChanges) {
        logger.warn('No staged/unstaged git diff detected.');
        return;
      }
      logger.info(`Dispatching diff review to ${options.agent}`);
      const result = await agentRouter.dispatch(options.agent, review.payload, {
        sessionId: await sessionManager.getSessionId(),
        project: process.cwd(),
        injectGitContext: false
      });
      const text = String(result.result || '');
      logger.printWithHighlight(text);
      if (options.strict) {
        const strict = detectHighSeverityFindings(text);
        if (strict.hasHighSeverity) {
          logger.error(`Strict review failed due to high-severity markers: ${strict.matches.join(', ')}`);
          process.exit(1);
        }
      }
    });

  program
    .command('context')
    .description('Inspect current prompt/context footprint')
    .option('-p, --project <path>', 'Project directory', process.cwd())
    .action(async options => {
      const project = options.project || process.cwd();
      const gitContext = await getProjectContext(project);
      const session = await sessionManager.loadSession();
      const tokenEstimate = Math.ceil((gitContext.length + JSON.stringify(session.history).length) / 4);

      console.log(chalk.blue('--- Context Report ---'));
      console.log(`Project: ${project}`);
      console.log(`Session entries: ${session.history.length}`);
      console.log(`Git context chars: ${gitContext.length}`);
      console.log(`Estimated tokens in active context: ~${tokenEstimate}`);
    });

  program
    .command('compact')
    .description('Compact local session/cost context windows to keep prompts lean')
    .option('--history <n>', 'Keep last N history entries', '200')
    .option('--cost <n>', 'Keep last N cost entries', '500')
    .option('--write-summary', 'Write compact context summary file', true)
    .action(async options => {
      const result = await sessionManager.compact({
        keepHistory: Number.parseInt(options.history || '200', 10),
        keepCostEntries: Number.parseInt(options.cost || '500', 10)
      });

      if (options.writeSummary) {
        const session = await sessionManager.loadSession();
        const last = session.history.slice(-10);
        const summary = [
          '# Compact Context Summary',
          '',
          `Updated: ${new Date().toISOString()}`,
          `History entries kept: ${session.history.length}`,
          '',
          '## Recent activity',
          ...last.map((entry: any) => `- ${entry.timestamp} ${entry.type}${entry.agent ? ` (${entry.agent})` : ''}`)
        ].join('\n');
        await writeFile(join(process.cwd(), '.crew', 'context-summary.md'), `${summary}\n`, 'utf8');
      }

      logger.success(
        `Compacted session history ${result.historyBefore} -> ${result.historyAfter}, ` +
        `cost entries ${result.costBefore} -> ${result.costAfter}`
      );
    });

  const mcp = program
    .command('mcp')
    .description('Manage MCP server entries (add/list/remove)');

  mcp
    .command('list')
    .description('List local MCP servers from .crew/mcp-servers.json')
    .action(async () => {
      const servers = await listMcpServers(process.cwd());
      const names = Object.keys(servers);
      if (!names.length) {
        logger.warn('No MCP servers configured.');
        return;
      }
      names.forEach(name => {
        const item = servers[name];
        console.log(`- ${name}: ${item.url}${item.bearerTokenEnvVar ? ` (token env: ${item.bearerTokenEnvVar})` : ''}`);
      });
    });

  mcp
    .command('doctor')
    .description('Validate MCP server config, env tokens, and reachability')
    .action(async () => {
      const checks = await doctorMcpServers(process.cwd());
      checks.forEach(check => {
        const marker = check.ok ? chalk.green('✓') : chalk.red('✗');
        console.log(`${marker} ${check.server}: ${check.details}`);
      });
      if (checks.some(x => !x.ok)) process.exit(1);
    });

  mcp
    .command('add')
    .description('Add an MCP server entry')
    .argument('<name>', 'Server name')
    .requiredOption('--url <url>', 'MCP server URL')
    .option('--bearer-token-env-var <var>', 'Bearer token env variable name')
    .option('--header <kv>', 'Custom header key:value (repeatable)', collectOption, [])
    .option('--client <id>', 'Optional client sync: cursor | claude | opencode | codex')
    .action(async (name, options) => {
      const headers: Record<string, string> = {};
      for (const raw of options.header || []) {
        const [key, ...rest] = String(raw).split(':');
        if (key && rest.length) headers[key.trim()] = rest.join(':').trim();
      }
      await addMcpServer(name, {
        url: options.url,
        bearerTokenEnvVar: options.bearerTokenEnvVar,
        headers
      }, process.cwd(), options.client);
      logger.success(`Added MCP server "${name}"`);
    });

  mcp
    .command('remove')
    .description('Remove an MCP server entry')
    .argument('<name>', 'Server name')
    .option('--client <id>', 'Optional client sync removal: cursor | claude | opencode | codex')
    .action(async (name, options) => {
      await removeMcpServer(name, process.cwd(), options.client);
      logger.success(`Removed MCP server "${name}"`);
    });

  const headless = program
    .command('headless')
    .description('Headless execution controls for CI automation');

  headless
    .command('run')
    .requiredOption('-t, --task <text>', 'Task text')
    .option('--agent <id>', 'Override routed agent')
    .option('-g, --gateway <url>', 'Override gateway URL')
    .option('--json', 'Emit JSONL events', false)
    .option('--always-approve', 'Auto-apply sandbox changes', false)
    .option('--force-auto-apply', 'Bypass risk gate for auto-apply', false)
    .option('--risk-threshold <level>', 'Auto-apply risk threshold (low|medium|high)', 'high')
    .option('--retry-attempts <n>', 'Retry attempts for transient failures', '2')
    .option('--fallback-model <id>', 'Fallback model chain entry (repeatable)', collectOption, [])
    .option('--strict-preflight', 'Block execution if doctor checks fail', false)
    .option('--out <path>', 'Write JSONL events to file (for CI artifacts)')
    .action(async options => {
      const policy = getExecutionPolicy({
        strictPreflight: Boolean(options.strictPreflight),
        retryAttempts: Number.parseInt(options.retryAttempts || '2', 10),
        riskThreshold: String(options.riskThreshold || 'high').toLowerCase() as any,
        forceAutoApply: Boolean(options.forceAutoApply)
      });
      await enforceStrictPreflight(policy, options.gateway);
      const result = await runHeadlessTask({
        task: options.task,
        agent: options.agent,
        json: options.json,
        alwaysApprove: options.alwaysApprove,
        forceAutoApply: options.forceAutoApply,
        riskThreshold: policy.riskThreshold,
        retryAttempts: policy.retryAttempts,
        fallbackModels: options.fallbackModel || [],
        out: options.out,
        gateway: options.gateway,
        projectDir: process.cwd(),
        router: agentRouter,
        orchestrator,
        sandbox,
        session: sessionManager
      });
      if (!result.success) process.exit(1);
    });

  headless
    .command('pause')
    .description('Pause headless execution')
    .action(async () => {
      await setHeadlessPaused(true, process.cwd());
      logger.success('Headless mode paused.');
    });

  headless
    .command('resume')
    .description('Resume headless execution')
    .action(async () => {
      await setHeadlessPaused(false, process.cwd());
      logger.success('Headless mode resumed.');
    });

  headless
    .command('status')
    .description('Show headless pause/resume state')
    .action(async () => {
      const state = await getHeadlessState(process.cwd());
      console.log(`paused=${state.paused} updatedAt=${state.updatedAt || 'n/a'}`);
    });

  program
    .command('src')
    .description('Run Sourcegraph src CLI commands (for batch codemods/search)')
    .allowUnknownOption(true)
    .argument('<args...>', 'Arguments passed to src CLI')
    .action(async (srcArgs: string[]) => {
      if (srcArgs[0] === 'batch-plan') {
        const args = srcArgs.slice(1);
        const readValue = (...names: string[]) => {
          for (let i = 0; i < args.length; i += 1) {
            if (names.includes(args[i])) return args[i + 1];
          }
          return undefined;
        };
        const repos: string[] = [];
        for (let i = 0; i < args.length; i += 1) {
          if (args[i] === '--repo' && args[i + 1]) repos.push(args[i + 1]);
        }
        const plan = await createSrcBatchPlan({
          query: readValue('--query', '-q') || '',
          repos,
          execute: args.includes('--execute'),
          specPath: readValue('--spec')
        }, process.cwd());

        if (plan.success) {
          logger.success(plan.message);
          return;
        }
        logger.error(plan.message);
        process.exit(1);
      }

      const result = await runSrcCli(srcArgs, process.cwd());
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      if (!result.success) process.exit(result.code || 1);
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
      const pipeline = await loadPipelineMetricsSummary(process.cwd());
      console.log(chalk.blue('--- Cost Summary ---'));
      console.log(`Total Spent: ${chalk.green(`$${cost.totalUsd.toFixed(4)}`)}`);
      
      if (Object.keys(cost.byModel).length > 0) {
        console.log(chalk.gray('\nBreakdown by model:'));
        Object.entries(cost.byModel).forEach(([model, usd]: [string, any]) => {
          console.log(`- ${model}: $${usd.toFixed(4)}`);
        });
      }
      const cache = cost.cacheSavings || {};
      console.log(chalk.gray('\nCache savings:'));
      console.log(`- hits: ${Number(cache.hits || 0)}`);
      console.log(`- misses: ${Number(cache.misses || 0)}`);
      console.log(`- tokens saved (est): ${Number(cache.tokensSaved || 0)}`);
      console.log(`- usd saved (est): $${Number(cache.usdSaved || 0).toFixed(4)}`);
      const memory = cost.memoryMetrics || {};
      const recallUsed = Number(memory.recallUsed || 0);
      const recallMisses = Number(memory.recallMisses || 0);
      const matchCount = Number(memory.totalMatches ?? memory.matchCount ?? 0);
      const avgQuality = Number(
        memory.averageQualityScore
        ?? (recallUsed > 0 ? (Number(memory.qualityScoreSum || 0) / recallUsed) : 0)
      );
      console.log(chalk.gray('\nMemory recall metrics:'));
      console.log(`- recall_used: ${recallUsed}`);
      console.log(`- recall_misses: ${recallMisses}`);
      console.log(`- match_count: ${matchCount}`);
      console.log(`- quality_score_avg: ${avgQuality.toFixed(3)}`);
      console.log(chalk.gray('\nPipeline metrics:'));
      console.log(`- runs: ${pipeline.runs}`);
      console.log(`- qa_approved: ${pipeline.qaApproved}`);
      console.log(`- qa_rejected: ${pipeline.qaRejected}`);
      const avgRounds = pipeline.runs > 0 ? (pipeline.qaRoundsTotal / pipeline.runs) : 0;
      console.log(`- qa_rounds_avg: ${avgRounds.toFixed(2)}`);
      console.log(`- context_chunks_used: ${pipeline.contextChunksUsed}`);
      console.log(`- context_chars_saved_est: ${pipeline.contextCharsSaved}`);
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
    .command('x-search')
    .description('Run native Grok X/Twitter search via xAI Responses API')
    .argument('<query...>', 'Search query')
    .option('--model <id>', 'xAI model', 'grok-4-1-fast-reasoning')
    .option('--from-date <date>', 'Start date (YYYY-MM-DD)')
    .option('--to-date <date>', 'End date (YYYY-MM-DD)')
    .option('--allow-handle <handle>', 'Allowed X handle (repeatable)', collectOption, [])
    .option('--exclude-handle <handle>', 'Excluded X handle (repeatable)', collectOption, [])
    .option('--images', 'Enable image understanding in x_search tool', false)
    .option('--videos', 'Enable video understanding in x_search tool', false)
    .option('--json', 'Output full JSON payload', false)
    .action(async (queryArray, options) => {
      try {
        const query = queryArray.join(' ').trim();
        const result = await runXSearch(query, {
          model: options.model,
          fromDate: options.fromDate,
          toDate: options.toDate,
          allowedHandles: options.allowHandle || [],
          excludedHandles: options.excludeHandle || [],
          enableImages: Boolean(options.images),
          enableVideos: Boolean(options.videos)
        });
        if (options.json) {
          console.log(JSON.stringify(result.raw, null, 2));
          return;
        }
        console.log(chalk.blue('\n--- X Search Result ---\n'));
        logger.printWithHighlight(result.text);
        if (result.citations.length > 0) {
          console.log(chalk.gray('\nCitations:'));
          for (const c of result.citations) console.log(`- ${c}`);
        }
      } catch (error) {
        logger.error('x-search failed:', (error as Error).message);
        process.exit(1);
      }
    });

  program
    .command('plan')
    .description('Generate a detailed plan for a task and execute it step-by-step or in parallel')
    .argument('<task...>', 'Task to plan and execute')
    .option('--parallel', 'Execute plan steps in parallel using worker pool', false)
    .option('--concurrency <n>', 'Maximum parallel workers', '3')
    .option('-m, --model <id>', 'Model override for plan execution', plannerPrimary || undefined)
    .option('--fallback-model <id>', 'Fallback model chain entry (repeatable)', collectOption, [])
    .option('--resume <runId>', 'Resume a prior plan run from checkpoint')
    .option('--validate-cmd <cmd>', 'Validation command (repeatable, hard gate)', collectOption, [])
    .option('--reflect-agent <id>', 'Agent used for reflect step', 'crew-main')
    .option('--no-cache', 'Disable planner cache')
    .option('--cache-ttl <sec>', 'Planner cache TTL in seconds', '3600')
    .option('--no-memory', 'Disable shared AgentKeeper memory')
    .option('--memory-max <n>', 'Max recalled memory entries', '3')
    .option('--memory-require-validation', 'Store memory only when validation is marked passed', false)
    .option('--json', 'Output machine-readable JSON envelope and skip interactive prompts', false)
    .option('--yes', 'Auto-approve plan execution without confirmation', false)
    .action(async (taskArray, options) => {
      const task = taskArray.join(' ');
      const planner = new Planner(agentRouter, sessionManager, process.cwd());
      const runId = options.resume ? String(options.resume) : `plan-${randomUUID()}`;
      const validationCommands = options.validateCmd || [];
      const fallbackModels = (options.fallbackModel && options.fallbackModel.length > 0)
        ? options.fallbackModel
        : (plannerPolicy.fallback || []);
      const existingRun = options.resume ? await checkpoints.load(runId) : null;
      if (!existingRun) {
        await checkpoints.beginRun({ runId, mode: 'plan', task });
      }
      
      logger.info(`Generating plan for: ${task}`);
      const plan = await planner.generatePlan(task, {
        useCache: options.cache,
        cacheTtlSeconds: Number.parseInt(options.cacheTtl || '3600', 10),
        useMemory: options.memory,
        memoryMaxResults: Number.parseInt(options.memoryMax || '3', 10),
        runId
      });
      await checkpoints.append(runId, 'plan.generated', { steps: plan.steps.length });
      
      console.log(chalk.blue('\n--- Proposed Plan ---'));
      plan.steps.forEach(s => console.log(`${s.id}. ${s.task}`));

      let completedSteps = new Set<number>();
      if (options.resume) {
        const prior = existingRun || await checkpoints.load(runId);
        if (prior) {
          completedSteps = new Set(CheckpointStore.completedPlanSteps(prior));
          if (completedSteps.size > 0) {
            logger.info(`Resuming from checkpoint ${runId}; skipping completed steps: ${Array.from(completedSteps).join(', ')}`);
          }
        }
      }
      
      // Skip confirmation prompt in programmatic/JSON mode or when --yes flag is set
      let confirm = true;
      
      if (!options.json && !options.yes) {
        const result = await (import('inquirer')).then(m => m.default.prompt([{
          type: 'confirm',
          name: 'confirm',
          message: `Execute this plan ${options.parallel ? 'in parallel' : 'step-by-step'}?`,
          default: true
        }]));
        confirm = result.confirm;
      }
      
      if (!confirm) {
        if (options.json) {
          printJsonEnvelope('plan.cancelled', { reason: 'user_declined' });
        } else {
          logger.warn('Plan cancelled.');
        }
        return;
      }
      
      if (options.parallel) {
        const { WorkerPool } = await import('../orchestrator/index.js');
        const pool = new WorkerPool({
          router: agentRouter,
          orchestrator,
          sandbox,
          keeper: options.memory !== false ? agentKeeper : undefined,
          concurrency: Number.parseInt(options.concurrency || '3', 10)
        });

        logger.info(`Starting parallel execution with concurrency ${options.concurrency}`);
        
        pool.enqueueAll(plan.steps.map(s => ({
          id: `step-${s.id}`,
          agent: 'crew-coder',
          prompt: s.task
        })));

        const results = await pool.runAll({
          sessionId: await sessionManager.getSessionId(),
          projectDir: process.cwd(),
          runId
        });

        const successCount = results.filter(r => r.success).length;
        const failedCount = results.length - successCount;
        
        logger.info(`Parallel execution complete: ${successCount} succeeded, ${failedCount} failed.`);
        results.forEach(r => {
          if (!r.success) {
            logger.error(`Task ${r.taskId} failed: ${r.error}`);
          }
        });
      } else {
        for (const step of plan.steps) {
          if (completedSteps.has(step.id)) {
            continue;
          }
          logger.progress(step.id - 1, plan.steps.length, 'Plan');
          logger.info(`Step ${step.id}: ${step.task}`);
          try {
            await checkpoints.append(runId, 'plan.step.started', { stepId: step.id, task: step.task });
            const dispatched = await dispatchWithFallback(
              agentRouter,
              'crew-coder',
              step.task,
              {
                sessionId: await sessionManager.getSessionId(),
                project: process.cwd(),
                model: options.model
              },
              fallbackModels,
              checkpoints,
              runId
            );
            const result = dispatched.result;
            logger.printWithHighlight(chalk.gray(String(result.result || '')));
            
            const edits = await orchestrator.parseAndApplyToSandbox(result.result);
            const validationGate = await runValidationCommands(validationCommands, process.cwd());
            await checkpoints.append(runId, 'plan.step.validation', {
              stepId: step.id,
              passed: validationGate.passed,
              failedCommand: validationGate.failedCommand || null
            });
            if (!validationGate.passed) {
              logger.error(`Validation failed at step ${step.id}: ${validationGate.failedCommand}`);
              logger.printWithHighlight(String(validationGate.output || ''));
              await checkpoints.append(runId, 'plan.step.failed', {
                stepId: step.id,
                reason: 'validation-failed',
                command: validationGate.failedCommand
              });
              await checkpoints.finish(runId, 'failed');
              process.exit(1);
            }
            if (options.memory !== false) {
              const response = String(result.result || '').trim();
              const validation = extractValidationSignals(result, Boolean(options.memoryRequireValidation));
              if (response.length > 0 && validation.passed) {
                const saved = await agentKeeper.recordSafe({
                  runId,
                  tier: 'worker',
                  task: step.task,
                  result: response,
                  agent: 'crew-coder',
                  structured: {
                    problem: step.task,
                    edits: edits.map((path: string) => ({ path })),
                    validation: {
                      lintPassed: validation.lintPassed,
                      testsPassed: validation.testsPassed,
                      notes: validation.notes
                    },
                    outcome: 'success'
                  },
                  metadata: {
                    stepId: step.id,
                    edits: edits.length,
                    success: true,
                    paths: edits,
                    validationRequired: validation.required,
                    validationPassed: validation.passed
                  }
                });
                if (!saved.ok) {
                  logger.warn(`Memory write skipped: ${saved.error}`);
                }
              }
            }
            if (edits.length > 0) {
              logger.success(`Added changes to ${edits.length} files in sandbox for step ${step.id}.`);
              const report = await analyzeBlastRadius(process.cwd(), { changedFiles: edits });
              const patchRisk = scorePatchRisk({
                blastRadius: report,
                validationPassed: validationGate.passed,
                changedFiles: edits.length
              });
              logger.info(`Step ${step.id} patch confidence: ${(patchRisk.confidence * 100).toFixed(0)}% (${patchRisk.riskLevel}, ${patchRisk.riskScore}/100)`);
            }
            const reflectPrompt = [
              `Reflect on this completed step and decide next action.`,
              `Step: ${step.task}`,
              `Output summary: ${String(result.result || '').slice(0, 1200)}`,
              `Validation: ${validationGate.passed ? 'passed' : 'failed'}`,
              `Return concise guidance for next step execution.`
            ].join('\n');
            const reflect = await dispatchWithFallback(
              agentRouter,
              options.reflectAgent || 'crew-main',
              reflectPrompt,
              {
                sessionId: await sessionManager.getSessionId(),
                project: process.cwd()
              },
              fallbackModels,
              checkpoints,
              runId
            );
            logger.info(chalk.gray(`Reflect (${options.reflectAgent || 'crew-main'}): ${String(reflect.result.result || '').slice(0, 180)}`));
            await checkpoints.append(runId, 'plan.step.completed', {
              stepId: step.id,
              edits: edits.length
            });
          } catch (err) {
            logger.error(`Failed at step ${step.id}: ${err.message}`);
            await checkpoints.append(runId, 'plan.step.failed', {
              stepId: step.id,
              reason: String(err.message || err)
            });
            await checkpoints.finish(runId, 'failed');
            break;
          }
        }
        logger.progress(plan.steps.length, plan.steps.length, 'Plan');
      }
      
      logger.success('Plan execution complete. Use "crew preview" to review changes.');
      await checkpoints.finish(runId, 'completed');
      if (options.memory !== false) {
        try {
          await agentKeeper.compact();
        } catch {
          // Best-effort maintenance.
        }
      }
    });

  program
    .command('auth')
    .description('Search for local OAuth tokens from other coding CLIs')
    .option('--link', 'Probe local subscription engines and show routing readiness')
    .option('--no-link', 'Disable engine probe/autolink behavior')
    .option('--apply', 'Persist auto-plumbed engine defaults to repo config.local.json')
    .option('--scope <scope>', 'Config scope for --apply: user|team', 'user')
    .action(async (options) => {
      const argv = process.argv.slice(2);
      const explicitLinkFlag = argv.includes('--link') || argv.includes('--no-link');
      const explicitApplyFlag = argv.includes('--apply');
      const implicitConnectMode = !explicitLinkFlag && !explicitApplyFlag;

      const finder = new TokenFinder();
      const tokens = await finder.findTokens();
      
      console.log(chalk.blue('--- Local Tokens Found ---'));
      if (tokens.claude) console.log(chalk.green('✓ Claude Code session found'));
      if (tokens.openai) console.log(chalk.green('✓ OpenAI config key found'));
      if (tokens.gemini) console.log(chalk.green('✓ Gemini ADC credentials found'));
      if (Object.keys(tokens).length === 0) {
        console.log(chalk.yellow('No local tokens detected.'));
      }

      const linkEnabled = options.link !== false;
      if (!linkEnabled) return;

      const probes = detectSubscriptionEngines(tokens);
      const ready = probes.filter(p => p.ready).map(p => p.id);
      const installed = probes.filter(p => p.installed).map(p => p.id);

      console.log(chalk.blue('\n--- Engine Auto-Plumb Probe ---'));
      for (const probe of probes) {
        const status = probe.ready
          ? chalk.green('ready')
          : probe.installed
            ? chalk.yellow('partial')
            : chalk.red('missing');
        const version = probe.version ? ` (${probe.version})` : '';
        console.log(`- ${probe.id.padEnd(10)} ${status}${version}`);
        console.log(chalk.gray(`  notes: ${probe.notes.join(', ')}`));
      }

      if (installed.length === 0) {
        console.log(chalk.yellow('\nNo subscription CLIs detected (cursor/claude/codex).'));
        return;
      }

      if (ready.length === 0) {
        console.log(chalk.yellow('\nNo engine is fully ready yet. Install/login first, then rerun `crew auth --link --apply`.'));
        return;
      }

      const preferredOrder: SubscriptionEngineId[] = ['cursor', 'claude-cli', 'codex-cli'];
      const preferredReady = preferredOrder.filter(id => ready.includes(id));
      const recommended = preferredReady[0];
      console.log(chalk.green(`\nRecommended default engine: ${recommended}`));
      console.log(chalk.gray(`Preferred ready order: ${preferredReady.join(' -> ')}`));

      const shouldApply = Boolean(options.apply || implicitConnectMode);
      if (!shouldApply) {
        console.log(chalk.gray('Use --apply to persist this into .crew/config.local.json'));
        return;
      }

      const scope = String(options.scope || 'user').toLowerCase();
      if (scope !== 'user' && scope !== 'team') {
        throw new Error(`Invalid scope "${scope}". Use user or team.`);
      }

      await setRepoConfigValue(process.cwd(), scope as 'user' | 'team', 'cli.engine', recommended);
      await setRepoConfigValue(process.cwd(), scope as 'user' | 'team', 'repl.engine', recommended);
      await setRepoConfigValue(process.cwd(), scope as 'user' | 'team', 'cli.preferredEngines', preferredReady);

      console.log(chalk.green('\n✓ Auto-plumb applied'));
      if (implicitConnectMode) {
        console.log(chalk.gray('  mode: implicit (crew auth)'));
      }
      console.log(chalk.gray(`  scope: ${scope}`));
      console.log(chalk.gray(`  cli.engine: ${recommended}`));
      console.log(chalk.gray(`  repl.engine: ${recommended}`));
      console.log(chalk.gray(`  cli.preferredEngines: ${preferredReady.join(', ')}`));
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
    .requiredOption(
      '-e, --engine <id>',
      'gemini-api | claude-api | gemini-cli | codex-cli | claude-cli | cursor | cursor-cli (Cursor agent CLI, not IDE opener)'
    )
    .requiredOption('-p, --prompt <text>', 'Prompt text')
    .option('-m, --model <id>', 'Model override')
    .option('-t, --timeout <ms>', 'Timeout in milliseconds', '600000')
    .action(async options => {
      const result = await runEngine(options.engine, options.prompt, {
        model: options.model,
        timeoutMs: Number.parseInt(options.timeout || '600000', 10)
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
    .option('--update-tag <tag>', 'Version channel for update check', 'latest')
    .action(async options => {
      const checks = await runDoctorChecks({ gateway: options.gateway, updateTag: options.updateTag });
      const summary = summarizeDoctorResults(checks);

      console.log(chalk.blue('crew doctor'));
      checks.forEach(check => {
        let marker = check.ok ? chalk.green('✓') : chalk.red('✗');
        if (check.name === 'CLI update status' && String(check.details || '').toLowerCase().includes('update available')) {
          marker = chalk.yellow('!');
        }
        console.log(`${marker} ${check.name} ${chalk.gray(`(${check.details})`)}`);
        if (!check.ok && check.hint) {
          console.log(chalk.yellow(`  ${check.hint}`));
        }
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
    .option('--risk-threshold <level>', 'Block apply when risk is >= threshold (low|medium|high)', 'high')
    .option('--force', 'Bypass risk gate', false)
    .action(async (branch, options) => {
      const active = branch || sandbox.getActiveBranch();
      if (!sandbox.hasChanges(active)) {
        console.log(chalk.yellow(`No changes to apply on branch "${active}".`));
        return;
      }
      try {
        const paths = sandbox.getPendingPaths(active);
        const policy = getExecutionPolicy({
          riskThreshold: String(options.riskThreshold || 'high').toLowerCase() as any,
          forceAutoApply: Boolean(options.force)
        });
        const report = await analyzeBlastRadius(process.cwd(), { changedFiles: paths });
        if (isRiskBlocked(report.risk, policy.riskThreshold, policy.forceAutoApply)) {
          logger.error(`Apply blocked by risk gate (${report.risk} >= ${policy.riskThreshold}).`);
          logger.warn('Run "crew preview" to inspect changes, then re-run with --force if intentional.');
          process.exit(1);
        }
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

  // ── Collections Search (RAG over docs) ─────────────────────────
  program
    .command('docs')
    .description('Search project docs and optionally code with source-attributed local RAG')
    .argument('<query...>', 'Search query')
    .option('--path <paths...>', 'Paths to index (default: docs/ and project root)')
    .option('--code', 'Include source code files in the index', false)
    .option('--max <n>', 'Max results to return', '8')
    .option('--json', 'Output as JSON', false)
    .action(async (queryArray, options) => {
      const { buildCollectionIndex, searchCollection } = await import('../collections/index.js');
      const query = queryArray.join(' ');
      const paths = options.path && options.path.length > 0
        ? options.path
        : [join(process.cwd(), 'docs'), process.cwd()];
      try {
        const index = await buildCollectionIndex(paths, {
          includeCode: Boolean(options.code)
        });
        const result = searchCollection(index, query, Number.parseInt(options.max || '8', 10));

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (result.hits.length === 0) {
          logger.warn(`No results for "${query}" (${index.fileCount} files, ${index.chunkCount} chunks indexed).`);
          return;
        }

        console.log(chalk.blue(`\n--- Docs Search: "${query}" (${result.hits.length} hits from ${index.chunkCount} chunks) ---\n`));
        for (const hit of result.hits) {
          console.log(chalk.yellow(`[${hit.score}] ${hit.source}:${hit.startLine}`));
          const preview = hit.text.length > 200 ? hit.text.slice(0, 200) + '...' : hit.text;
          console.log(chalk.gray(preview));
          console.log('');
        }
      } catch (error) {
        logger.error('Docs search failed:', error.message);
        process.exit(1);
      }
    });

  // ── Blast Radius Analysis ─────────────────────────────────────
  program
    .command('blast-radius')
    .description('Analyze impact of current changes across the codebase')
    .option('--ref <ref>', 'Git diff reference (default: HEAD)')
    .option('--max-depth <n>', 'Max transitive import depth', '5')
    .option('--json', 'Output as JSON', false)
    .option('--gate', 'Exit non-zero if risk is high (for CI)', false)
    .action(async (options) => {
      const { analyzeBlastRadius } = await import('../blast-radius/index.js');
      try {
        const report = await analyzeBlastRadius(process.cwd(), {
          diffRef: options.ref,
          maxDepth: Number.parseInt(options.maxDepth || '5', 10)
        });

        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          const riskColor = { low: chalk.green, medium: chalk.yellow, high: chalk.red }[report.risk];
          console.log(chalk.blue('\n--- Blast Radius Analysis ---\n'));
          console.log(riskColor(report.summary));

          if (report.affectedFiles.length > 0) {
            console.log(chalk.blue('\nAffected files:'));
            for (const af of report.affectedFiles) {
              const tag = { changed: chalk.red('CHANGED'), 'direct-importer': chalk.yellow('DIRECT'), 'transitive-importer': chalk.gray('TRANSITIVE') }[af.relation];
              console.log(`  ${tag}  ${af.path}`);
            }
          }
        }

        if (options.gate && report.risk === 'high') {
          logger.error('Blast radius is HIGH — aborting (use without --gate to see report only).');
          process.exit(1);
        }
      } catch (error) {
        logger.error('Blast radius analysis failed:', error.message);
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

  // ── AgentKeeper Memory ─────────────────────────────────────────
  program
    .command('memory')
    .description('Query AgentKeeper task memory')
    .argument('[query...]', 'Search query (omit to show stats)')
    .option('--max <n>', 'Max results', '5')
    .option('--rag', 'Blend AgentKeeper + shared fact memory + collections RAG', true)
    .option('--no-rag', 'Use AgentKeeper-only recall')
    .option('--include-code', 'Include source files in collections retrieval', false)
    .option('--path <paths...>', 'Custom docs/code search paths for RAG')
    .option('--json', 'Output as JSON', false)
    .action(async (queryArray, options) => {
      const { AgentKeeper } = await import('../memory/agentkeeper.js');
      const keeper = new AgentKeeper(process.cwd());
      const broker = new MemoryBroker(process.cwd());
      const query = (queryArray || []).join(' ').trim();

      if (!query) {
        const stats = await keeper.stats();
        if (options.json) {
          console.log(JSON.stringify(stats, null, 2));
        } else {
          console.log(chalk.blue('\n--- AgentKeeper Memory Stats ---\n'));
          console.log(`  Total entries: ${stats.entries}`);
          console.log(`  Approx bytes: ${stats.bytes}`);
          if (Object.keys(stats.byTier).length > 0) {
            console.log('  By tier:');
            for (const [tier, count] of Object.entries(stats.byTier)) {
              console.log(`    ${tier}: ${count}`);
            }
          }
          if (Object.keys(stats.byAgent).length > 0) {
            console.log('  By agent:');
            for (const [agent, count] of Object.entries(stats.byAgent)) {
              console.log(`    ${agent}: ${count}`);
            }
          }
          try {
            const cost = await sessionManager.loadCost();
            const memory = cost.memoryMetrics || {};
            const recallUsed = Number(memory.recallUsed || 0);
            const recallMisses = Number(memory.recallMisses || 0);
            const matchCount = Number(memory.totalMatches ?? memory.matchCount ?? 0);
            const avgQuality = Number(
              memory.averageQualityScore
              ?? (recallUsed > 0 ? (Number(memory.qualityScoreSum || 0) / recallUsed) : 0)
            );
            console.log('  Recall metrics:');
            console.log(`    recall_used: ${recallUsed}`);
            console.log(`    recall_misses: ${recallMisses}`);
            console.log(`    match_count: ${matchCount}`);
            console.log(`    quality_score_avg: ${avgQuality.toFixed(3)}`);
          } catch {
            // Best-effort observability section.
          }
        }
        return;
      }

      const max = Number.parseInt(options.max || '5', 10);
      if (options.rag) {
        const hits = await broker.recall(query, {
          maxResults: max,
          includeDocs: true,
          includeCode: Boolean(options.includeCode),
          docsPaths: options.path && options.path.length > 0 ? options.path : undefined
        });
        if (options.json) {
          console.log(JSON.stringify(hits, null, 2));
          return;
        }
        if (hits.length === 0) {
          logger.warn(`No shared memory/RAG matches for "${query}".`);
          return;
        }
        console.log(chalk.blue(`\n--- Shared Memory + RAG Recall: "${query}" (${hits.length} hits) ---\n`));
        for (const h of hits) {
          console.log(chalk.yellow(`[${h.score.toFixed(3)}] ${h.source} — ${h.title.slice(0, 100)}`));
          const preview = h.text.length > 160 ? h.text.slice(0, 160) + '...' : h.text;
          console.log(chalk.gray(`  ${preview}`));
          console.log('');
        }
        return;
      }

      const matches = await keeper.recall(query, max);
      if (options.json) {
        console.log(JSON.stringify(matches, null, 2));
        return;
      }
      if (matches.length === 0) {
        logger.warn(`No memory matches for "${query}".`);
        return;
      }
      console.log(chalk.blue(`\n--- Memory Recall: "${query}" (${matches.length} matches) ---\n`));
      for (const m of matches) {
        console.log(chalk.yellow(`[${m.score}] ${m.entry.tier} — ${m.entry.task.slice(0, 80)}`));
        if (m.entry.agent) console.log(chalk.gray(`  Agent: ${m.entry.agent}`));
        const preview = m.entry.result.length > 150 ? m.entry.result.slice(0, 150) + '...' : m.entry.result;
        console.log(chalk.gray(`  Result: ${preview}`));
        console.log('');
      }
    });

  program
    .command('memory-compact')
    .description('Compact AgentKeeper memory store')
    .option('--max-entries <n>', 'Max entries to keep', '500')
    .action(async (options) => {
      const { AgentKeeper } = await import('../memory/agentkeeper.js');
      const keeper = new AgentKeeper(process.cwd(), {
        maxEntries: Number.parseInt(options.maxEntries || '500', 10)
      });
      const result = await keeper.compact();
      logger.success(`Compacted: ${result.entriesBefore} → ${result.entriesAfter} entries (freed ${result.bytesFreed} bytes).`);
    });

  const checkpointCmd = program
    .command('checkpoint')
    .description('Inspect or replay resumable run checkpoints');

  checkpointCmd
    .command('list')
    .description('List recent checkpoints')
    .option('--max <n>', 'Max checkpoints', '20')
    .action(async options => {
      const runs = await checkpoints.list(Number.parseInt(options.max || '20', 10));
      if (runs.length === 0) {
        logger.warn('No checkpoints found.');
        return;
      }
      console.log(chalk.blue('\n--- Checkpoints ---\n'));
      for (const run of runs) {
        console.log(`${run.runId}  ${run.mode}  ${run.status}  ${run.updatedAt}`);
        console.log(chalk.gray(`  ${run.task.slice(0, 120)}`));
      }
    });

  checkpointCmd
    .command('show')
    .description('Show checkpoint details and deterministic event log')
    .argument('<runId>', 'Checkpoint run id')
    .option('--json', 'Output raw JSON', false)
    .action(async (runId, options) => {
      const run = await checkpoints.load(runId);
      if (!run) {
        logger.error(`Checkpoint not found: ${runId}`);
        process.exit(1);
      }
      if (options.json) {
        console.log(JSON.stringify(run, null, 2));
        return;
      }
      console.log(chalk.blue(`\n--- Checkpoint ${run.runId} ---\n`));
      console.log(`Mode: ${run.mode}`);
      console.log(`Status: ${run.status}`);
      console.log(`Task: ${run.task}`);
      console.log(`Events: ${run.events.length}\n`);
      for (const ev of run.events) {
        console.log(`${ev.ts}  ${ev.type}`);
        if (ev.data && Object.keys(ev.data).length > 0) {
          console.log(chalk.gray(`  ${JSON.stringify(ev.data)}`));
        }
      }
    });

  checkpointCmd
    .command('replay')
    .description('Replay checkpoint decisions/tools (dry-run by default)')
    .argument('<runId>', 'Checkpoint run id')
    .option('--execute', 'Execute replay for supported modes', false)
    .action(async (runId, options) => {
      const run = await checkpoints.load(runId);
      if (!run) {
        logger.error(`Checkpoint not found: ${runId}`);
        process.exit(1);
      }
      console.log(chalk.blue(`\n--- Replay ${run.runId} (${run.mode}) ---\n`));
      for (const ev of run.events) {
        console.log(`${ev.ts}  ${ev.type}`);
      }
      if (!options.execute) {
        logger.info('Dry-run replay complete. Re-run with --execute to execute replay where supported.');
        return;
      }
      if (run.mode === 'plan') {
        logger.info(`Use: crew plan "${run.task}" --resume ${run.runId}`);
        return;
      }
      if (run.mode !== 'dispatch') {
        logger.warn('Execute replay currently supports dispatch checkpoints only.');
        return;
      }
      const agent =
        String(run.events.find(e => e.type === 'dispatch.completed')?.data?.agent || 'crew-main');
      const chain = run.events
        .filter(e => e.type === 'dispatch.model.attempt')
        .map(e => String(e.data?.model || '').trim())
        .filter(Boolean);
      const primary = chain[0];
      const fallbacks = chain.slice(1);
      const replay = await dispatchWithFallback(
        agentRouter,
        agent,
        run.task,
        {
          sessionId: await sessionManager.getSessionId(),
          project: process.cwd(),
          model: primary || undefined
        },
        fallbacks,
        checkpoints,
        `${run.runId}-replay-${Date.now()}`
      );
      logger.success('Replay dispatch complete.');
      logger.printWithHighlight(String(replay.result.result || ''));
    });

  program
    .command('serve')
    .description('Start unified interface API server (standalone only)')
    .option('--mode <mode>', 'Compatibility alias; only "standalone" is supported', 'standalone')
    .option('--host <host>', 'Bind host', process.env.CREW_API_HOST || '127.0.0.1')
    .option('--port <port>', 'Bind port', process.env.CREW_API_PORT || '4317')
    .action(async (options) => {
      const requestedMode = String(options.mode || 'standalone').trim().toLowerCase();
      if (requestedMode !== 'standalone') {
        logger.error(`Unsupported --mode "${requestedMode}". crew serve only supports standalone mode now.`);
        logger.info('Use: crew serve --port 4097');
        process.exit(1);
      }
      const mode = 'standalone';
      const host = String(options.host || '127.0.0.1');
      const port = Number.parseInt(String(options.port || '4317'), 10);
      if (Number.isNaN(port) || port <= 0) {
        logger.error('Invalid --port value.');
        process.exit(1);
      }

      const svc = await startUnifiedServer({
        mode,
        host,
        port,
        gateway: options.gateway,
        router: agentRouter,
        orchestrator,
        sandbox,
        session: sessionManager,
        projectDir: process.cwd(),
        logger
      });

      logger.success(`Unified API server running at ${svc.address} (${mode})`);
      logger.info('Press Ctrl+C to stop.');
      const shutdown = async () => {
        try {
          await svc.close();
        } finally {
          process.exit(0);
        }
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      await new Promise(() => {});
    });

  // ── crew validate — blind AI code review ──
  program
    .command('validate')
    .description('Blind AI code review of recent changes')
    .option('-m, --model <id>', 'Model override', executorPrimary || undefined)
    .option('-n, --commits <n>', 'How many commits to review (default: 1)', '1')
    .option('--json', 'Output machine-readable JSON', false)
    .action(async (options) => {
      try {
        const n = Math.max(1, parseInt(options.commits || '1', 10));
        let diffStat = '';
        try { diffStat = execSync(`git diff HEAD~${n} --stat`, { encoding: 'utf8', cwd: process.cwd() }).slice(0, 2000); } catch {}
        let codeSnippets = '';
        try {
          const changedFiles = execSync(`git diff HEAD~${n} --name-only`, { encoding: 'utf8', cwd: process.cwd() })
            .split('\n').filter(Boolean).slice(0, 5);
          for (const f of changedFiles) {
            try {
              const { readFileSync } = await import('node:fs');
              const content = readFileSync(join(process.cwd(), f), 'utf8');
              codeSnippets += `\n### ${f}\n\`\`\`\n${content.slice(0, 1500)}\n\`\`\`\n`;
            } catch {}
          }
        } catch {}

        const validateTask = `You are crew-judge, a blind code validator. Review these recent changes and provide a structured assessment.

Score each category 1-5:
- **Correctness**: Does the code work? Edge cases?
- **Security**: Vulnerabilities? Input validation?
- **Performance**: Bottlenecks? Memory leaks?
- **Readability**: Clean, documented, follows conventions?
- **Test Coverage**: Tests present? What's missing?

End with VERDICT: SHIP, FIX, or REJECT with actionable items.

## Changed files\n${diffStat || 'No recent changes'}\n\n## Code\n${codeSnippets || 'No code to review'}`;

        logger.info('Running blind validation...');
        const result = await orchestrator.executeLocally(validateTask, { model: options.model });
        const responseText = String(result.result || 'Validation could not complete.');

        if (options.json) {
          printJsonEnvelope('validate.result', { response: responseText, costUsd: result.costUsd || 0 });
        } else {
          console.log(chalk.blue('\n--- Validation Report ---'));
          logger.printWithHighlight(responseText);
          console.log();
          if (result.costUsd) {
            console.log(chalk.gray(`Cost: $${result.costUsd.toFixed(4)}`));
          }
        }
      } catch (error) {
        logger.error('Validation failed:', (error as Error).message);
        process.exit(1);
      }
    });

  // ── crew diff — colored git diff ──
  program
    .command('diff')
    .description('Show colored git diff of working directory')
    .option('--staged', 'Show only staged changes', false)
    .option('--stat', 'Show diffstat only', false)
    .action(async (options) => {
      try {
        const statFlag = options.stat ? ' --stat' : '';
        const staged = execSync(`git diff --cached${statFlag}`, { encoding: 'utf8', cwd: process.cwd() }).trim();
        const unstaged = options.staged ? '' : execSync(`git diff${statFlag}`, { encoding: 'utf8', cwd: process.cwd() }).trim();
        const fullDiff = (staged + '\n' + unstaged).trim();
        if (!fullDiff) {
          console.log(chalk.yellow('No git changes.'));
          return;
        }
        const lines = fullDiff.split('\n').map(line => {
          if (line.startsWith('+++') || line.startsWith('---')) return chalk.bold(line);
          if (line.startsWith('+')) return chalk.green(line);
          if (line.startsWith('-')) return chalk.red(line);
          if (line.startsWith('@@')) return chalk.cyan(line);
          if (line.startsWith('diff ')) return chalk.bold.blue(line);
          return line;
        });
        console.log(lines.join('\n'));
      } catch (error) {
        logger.error('Git diff failed:', (error as Error).message);
        process.exit(1);
      }
    });

  // ── crew test-first — TDD workflow ──
  program
    .command('test-first')
    .description('TDD workflow: generate tests -> implement -> validate')
    .argument('<task...>', 'Task description')
    .option('-m, --model <id>', 'Model override', executorPrimary || undefined)
    .option('--json', 'Output machine-readable JSON', false)
    .action(async (taskArray, options) => {
      const task = taskArray.join(' ');
      const projectDir = process.cwd();
      try {
        logger.info('Step 1: Generating tests...');
        const testResult = await orchestrator.executeLocally(
          `You are a TDD expert. Write comprehensive tests FIRST. Cover happy path, edge cases, error handling. Output ONLY the test code in a fenced code block with filename.\n\nTask: ${task}\nProject dir: ${projectDir}`,
          { model: options.model }
        );
        const testCode = String(testResult.result || '');
        if (!options.json) {
          console.log(chalk.blue('\n--- Tests ---'));
          logger.printWithHighlight(testCode);
        }

        logger.info('Step 2: Implementing to pass tests...');
        const implResult = await orchestrator.executeLocally(
          `Given these tests, write the MINIMAL implementation to make ALL tests pass.\n\nTests:\n${testCode}\n\nTask: "${task}"`,
          { model: options.model }
        );
        const implCode = String(implResult.result || '');
        if (!options.json) {
          console.log(chalk.blue('\n--- Implementation ---'));
          logger.printWithHighlight(implCode);
        }

        logger.info('Step 3: Validating...');
        const valResult = await orchestrator.executeLocally(
          `Verify: 1) Would all tests pass? 2) Missing edge cases? 3) Bugs?\nVerdict: PASS or FAIL with specific issues.\n\nTests:\n${testCode}\n\nImplementation:\n${implCode}`,
          { model: options.model }
        );
        if (!options.json) {
          console.log(chalk.blue('\n--- Validation ---'));
          logger.printWithHighlight(String(valResult.result || ''));
        }

        const totalCost = (testResult.costUsd || 0) + (implResult.costUsd || 0) + (valResult.costUsd || 0);
        if (options.json) {
          printJsonEnvelope('test-first.result', {
            tests: testCode, implementation: implCode,
            validation: String(valResult.result || ''), costUsd: totalCost
          });
        } else {
          console.log(chalk.gray(`\nTotal cost: $${totalCost.toFixed(4)}`));
        }
      } catch (error) {
        logger.error('Test-first failed:', (error as Error).message);
        process.exit(1);
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
