// @ts-nocheck
import { createInterface, emitKeypressEvents } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import chalk from 'chalk';
// Lazy-load inquirer to avoid ESM/CJS interop deadlock on Node 24
// (inquirer@9 is ESM but its nested ora@5 dep is CJS)
let _inquirer: typeof import('inquirer').default | null = null;
async function getInquirer() {
  if (!_inquirer) {
    const mod = await import('inquirer');
    _inquirer = mod.default;
  }
  return _inquirer;
}
import type { RepoConfig } from '../config/repo-config.js';
import { AgentRouter } from '../agent/router.js';
import { SessionManager } from '../session/manager.js';
import { Orchestrator } from '../orchestrator/index.js';
import { Sandbox } from '../sandbox/index.js';
import { Logger } from '../utils/logger.js';
import { getProjectContext } from '../context/git.js';
import { collectMultiRepoContext } from '../multirepo/index.js';
import { AgentKeeper } from '../memory/agentkeeper.js';
import { MemoryBroker } from '../memory/broker.js';
import { CheckpointStore } from '../checkpoint/store.js';
import { loadPipelineMetricsSummary } from '../metrics/pipeline.js';
import { estimateCost } from '../cost/predictor.js';
import { getExecutionPolicy, isRiskBlocked, withRetries } from '../runtime/execution-policy.js';
import { analyzeBlastRadius } from '../blast-radius/index.js';
import { scorePatchRisk } from '../risk/score.js';

const BANNER = `
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

const AVAILABLE_MODELS = [
  'gpt-5.4', 'gpt-5.3-codex', 'gemini-3.1-pro', 'gemini-2.5-flash',
  'claude-sonnet-4.6', 'grok-4.20-beta', 'grok-4.1-fast',
  'deepseek-v3.2', 'qwen3.5-397b', 'kimi-k2.5', 'llama-3.3-70b'
];

const AVAILABLE_ENGINES = ['auto', 'cursor', 'claude', 'gemini', 'codex', 'crew-cli'];

export interface ReplOptions {
  router: AgentRouter;
  orchestrator: Orchestrator;
  sandbox: Sandbox;
  session: SessionManager;
  logger: Logger;
  projectDir?: string;
  repoConfig?: Required<RepoConfig>;
  initialMode?: 'manual' | 'assist' | 'autopilot';
  initialInterfaceMode?: 'connected' | 'standalone';
  promptInterfaceMode?: boolean;
  uiMode?: 'repl' | 'tui';
}

interface ReplState {
  model: string;
  engine: string;
  autoApply: boolean;
  memoryMax: number;
  mode: ReplMode;
  verbose: boolean;
  routerProvider: string; // Tier 1: grok, gemini, deepseek
  executorProvider: string; // Tier 2: grok, gemini, deepseek
  useGateway: boolean; // Tier 3: gateway for specialists
}

type ReplMode = 'manual' | 'assist' | 'autopilot';
const REPL_MODE_ORDER: ReplMode[] = ['manual', 'assist', 'autopilot'];

interface ModelSummary {
  mode: 'connected' | 'standalone';
  replModel: string;
  replEngine: string;
  routerProvider: string;
  executorProvider: string;
  gatewayEnabled: boolean;
  policyTierModels: string[];
  agentModels: string[];
  providerKeys: string[];
}

interface RepoBootstrap {
  projectDir: string;
  topEntries: string[];
  docs: string[];
  keyFiles: string[];
  readmeSummary: string;
}

function readJsonFile(filePath: string): any | null {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function buildModelSummary(projectDir: string, state: ReplState): ModelSummary {
  const envMode = String(process.env.CREW_INTERFACE_MODE || '').toLowerCase();
  const mode: 'connected' | 'standalone' =
    envMode === 'connected' ? 'connected' : (state.useGateway ? 'connected' : 'standalone');

  const policyPath = join(projectDir, '.crew', 'model-policy.json');
  const policy = readJsonFile(policyPath) || {};
  const tiers = policy?.tiers || {};
  const policyTierModels = Array.from(
    new Set(
      ['planner', 'executor', 'worker'].flatMap((tier: string) => {
        const cfg = tiers?.[tier] || {};
        return [cfg?.primary, ...(Array.isArray(cfg?.fallback) ? cfg.fallback : [])]
          .map((x: unknown) => String(x || '').trim())
          .filter(Boolean);
      })
    )
  );

  const swarmCfg = readJsonFile(join(homedir(), '.crewswarm', 'crewswarm.json')) || {};
  const agents = Array.isArray(swarmCfg?.agents) ? swarmCfg.agents : [];
  const agentModels = Array.from(
    new Set(
      agents
        .map((a: any) => String(a?.model || '').trim())
        .filter(Boolean)
    )
  );

  const providers = swarmCfg?.providers && typeof swarmCfg.providers === 'object' ? swarmCfg.providers : {};
  const providerKeys = Object.entries(providers)
    .filter(([, v]: any) => Boolean(v && (v.apiKey || v.baseUrl)))
    .map(([k]) => String(k));

  return {
    mode,
    replModel: state.model,
    replEngine: state.engine,
    routerProvider: state.routerProvider,
    executorProvider: state.executorProvider,
    gatewayEnabled: state.useGateway,
    policyTierModels,
    agentModels,
    providerKeys
  };
}

function printModelSummary(summary: ModelSummary) {
  console.log(chalk.blue('\n--- Model Configuration ---\n'));
  console.log(`  Interface mode: ${summary.mode}`);
  console.log(`  REPL model/engine: ${summary.replModel} / ${summary.replEngine}`);
  console.log(`  L2 providers: router=${summary.routerProvider}, executor=${summary.executorProvider}`);
  console.log(`  Tier-3 gateway: ${summary.gatewayEnabled ? 'enabled' : 'disabled'}`);
  console.log(`  Policy-tier models: ${summary.policyTierModels.length ? summary.policyTierModels.join(', ') : '(none set)'}`);
  console.log(`  Agent models (~/.crewswarm/crewswarm.json): ${summary.agentModels.length ? summary.agentModels.join(', ') : '(none found)'}`);
  console.log(`  Providers configured: ${summary.providerKeys.length ? summary.providerKeys.join(', ') : '(none found)'}`);
  console.log(chalk.gray('\n  Change models with: /model, /stack, .crew/model-policy.json, ~/.crewswarm/crewswarm.json\n'));
}

async function buildRepoBootstrap(projectDir: string): Promise<RepoBootstrap> {
  const ignored = new Set(['.git', 'node_modules', '.crew', 'dist']);
  let topEntries: string[] = [];
  try {
    const entries = await readdir(projectDir, { withFileTypes: true });
    topEntries = entries
      .filter(e => !ignored.has(e.name))
      .map(e => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .slice(0, 20);
  } catch {
    topEntries = [];
  }

  let docs: string[] = [];
  try {
    const docsEntries = await readdir(join(projectDir, 'docs'), { withFileTypes: true });
    docs = docsEntries
      .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map(e => `docs/${e.name}`)
      .sort()
      .slice(0, 15);
  } catch {
    docs = [];
  }

  const keyCandidates = [
    'README.md',
    'ROADMAP.md',
    'progress.md',
    'docs/API-UNIFIED-v1.md',
    'docs/openapi.unified.v1.json',
    'src/cli/index.ts',
    'src/repl/index.ts',
    'src/interface/server.ts'
  ];
  const keyFiles = keyCandidates.filter(p => existsSync(join(projectDir, p)));

  let readmeSummary = '';
  try {
    const raw = await readFile(join(projectDir, 'README.md'), 'utf8');
    const lines = raw
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
    readmeSummary = lines.slice(0, 3).join(' ').slice(0, 260);
  } catch {
    readmeSummary = '';
  }

  return {
    projectDir,
    topEntries,
    docs,
    keyFiles,
    readmeSummary
  };
}

function printSystemSummary(summary: ModelSummary, bootstrap: RepoBootstrap) {
  console.log(chalk.blue('\n--- System Summary ---\n'));
  console.log(`  Mode: ${summary.mode} (${summary.gatewayEnabled ? 'gateway enabled' : 'local-only'})`);
  console.log(`  L1 (chat): ${summary.replModel} via ${summary.replEngine}`);
  console.log(`  L2 (reasoning): router=${summary.routerProvider}, executor=${summary.executorProvider}`);
  console.log(`  L3 (workers): ${summary.agentModels.length} configured agent model assignments`);
  console.log(`  Providers: ${summary.providerKeys.length ? summary.providerKeys.join(', ') : '(none found)'}`);
  console.log(`  Project: ${bootstrap.projectDir}`);
  console.log(`  Key files: ${bootstrap.keyFiles.length ? bootstrap.keyFiles.join(', ') : '(none detected)'}`);
  console.log(chalk.gray('\n  Commands: /models-config, /stack, /status, /preview, /apply, /trace <id>\n'));
}

function answerLocalMetaQuestion(input: string, summary: ModelSummary): string | null {
  const lower = input.trim().toLowerCase();
  if (!lower) return null;

  if (/^(hi|hello|hey)\b/.test(lower)) {
    return 'Hi. I can build/fix code, or answer stack config. Try: "what models are configured?"';
  }

  if (/\b(solo mode|standalone mode|connected mode|are you in solo mode)\b/.test(lower)) {
    if (summary.mode === 'standalone') {
      return 'You are in standalone mode. Routing/execution is local unless you explicitly use gateway-backed commands.';
    }
    return 'You are in connected mode. Requests route through crew-lead/gateway for multi-agent orchestration.';
  }

  if (
    /\b(what|which).*(models?|providers?).*(configured|active|set)\b/.test(lower) ||
    /\bmodels?\s+configured\b/.test(lower)
  ) {
    const policy = summary.policyTierModels.length ? summary.policyTierModels.join(', ') : '(none set)';
    const agents = summary.agentModels.length ? summary.agentModels.join(', ') : '(none found)';
    return [
      `Mode: ${summary.mode}.`,
      `REPL model/engine: ${summary.replModel} / ${summary.replEngine}.`,
      `L2 providers: router=${summary.routerProvider}, executor=${summary.executorProvider}.`,
      `Policy-tier models: ${policy}.`,
      `Agent models: ${agents}.`,
      'Use /models-config for full details, then change via /model, /stack, .crew/model-policy.json, or ~/.crewswarm/crewswarm.json.'
    ].join(' ');
  }

  if (/\b(change|modify|set|update).*(models?|model)\b/.test(lower)) {
    return 'Yes. Use /model (session), /stack (tier providers), or edit .crew/model-policy.json and ~/.crewswarm/crewswarm.json for persistent model changes.';
  }

  if (/\b(what can you do|help me|onboard|getting started|how do i use)\b/.test(lower)) {
    return [
      'Here is the fast path.',
      '1) /models-config to inspect real model/provider config.',
      '2) /stack to set Tier-1 router + Tier-2 executor + gateway toggle.',
      '3) Ask build/fix tasks directly; I route and stage edits in sandbox.',
      '4) /preview then /apply (or /rollback).',
      '5) /trace <id> for prompt/planner trace.',
      'If you want me to run an exact command, say it explicitly: e.g. "run /models-config".'
    ].join(' ');
  }

  if (/\b(run|execute)\s+\/[a-z-]+/.test(lower)) {
    return 'Use slash commands directly in REPL. Example: /models-config, /stack, /status, /preview, /apply, /trace <traceId>.';
  }

  return null;
}

function answerFromBootstrap(input: string, summary: ModelSummary, bootstrap: RepoBootstrap): string | null {
  const lower = input.trim().toLowerCase();
  if (!lower) return null;

  // Greetings and smalltalk — don't waste L2 tokens on these
  if (/^(hi|hey|hello|yo|sup|hola|howdy|hej|oi|what'?s? up|wh?at up|how('?s it going|'?re you|( are)? you doin|( are)? ya)|good (morning|afternoon|evening)|gm|gn)\b/.test(lower)) {
    const greetings = [
      'Hi. I can build/fix code, or answer stack config. Try: "what models are configured?"',
      'Hey! Ready to code. What do you need built or fixed?',
      'Yo. Give me a coding task, a file to review, or ask about the system.',
      'What\'s up! I\'m your coding crew. Drop a task or ask /help for commands.',
    ];
    return greetings[Math.floor(Math.random() * greetings.length)];
  }

  // Thanks / bye — quick responses
  if (/^(thanks|thank you|thx|ty|cheers|nice|cool|great|awesome|perfect|ok|okay|k|bye|goodbye|later|peace)\b/.test(lower)) {
    return lower.match(/bye|goodbye|later|peace/) 
      ? 'Later! Run /exit or just close the terminal.' 
      : '👍';
  }

  if (
    /\b(how does this system work|explain (the )?(system|architecture)|what is crew-cli|tell me about crew-cli)\b/.test(lower)
  ) {
    const docs = bootstrap.docs.slice(0, 5).join(', ') || '(no docs indexed)';
    const keys = bootstrap.keyFiles.slice(0, 6).join(', ') || '(no key files found)';
    return [
      `Crew CLI is a multi-layer orchestrator in ${summary.mode} mode.`,
      `L1 chat runs on ${summary.replModel}/${summary.replEngine}; L2 uses router=${summary.routerProvider} and executor=${summary.executorProvider}; L3 uses configured worker/agent models.`,
      `Key repo files: ${keys}.`,
      `Docs index snapshot: ${docs}.`,
      `Use /system for full stack summary and /models-config for exact model/provider config.`
    ].join(' ');
  }

  if (/\b(read|write|file access|filesystem|permissions)\b/.test(lower)) {
    if (summary.mode === 'standalone') {
      return 'Standalone mode has local read/write through orchestrator + sandbox. Edits stage in sandbox first, then /apply writes to disk.';
    }
    return 'Connected mode executes through gateway/agents; file operations happen via agent tools and still stage through sandbox workflow on this CLI.';
  }

  return null;
}

function printHelp(uiMode: 'repl' | 'tui' = 'repl') {
  console.log(chalk.blue.bold('\n╔══════════════════════════════════════════════════════════════════════╗'));
  console.log(chalk.blue.bold('║                       CREW REPL COMMANDS                             ║'));
  console.log(chalk.blue.bold('╚══════════════════════════════════════════════════════════════════════╝\n'));

  console.log(chalk.cyan.bold('  📋 Session Commands:'));
  console.log('    /help              Show this comprehensive help');
  console.log('    /info              Show current model, engine, and settings');
  console.log('    /status            Session info (cost, history, sandbox)');
  console.log('    /cost              Total spend this session');
  console.log('    /history [n]       Show last n messages (default: 5)');
  console.log('    /clear             Clear session history');
  console.log('    /trace             Show execution path and composed prompts\n');

  console.log(chalk.yellow.bold('  Sandbox & Git:'));
    console.log('    /preview           Show pending changes (colored diff)');
    console.log('    /apply [--commit]  Write sandbox to disk + auto-commit');
    console.log('    /rollback          Discard all pending changes');
    console.log('    /diff              Show colored git diff');
    console.log('    /branch            Interactive branch selector');
    console.log('    /branches          Same as /branch');
    console.log('    /undo              Undo last change');
    console.log('    /validate          Blind AI code review of recent changes');
    console.log('    /test-first <task> TDD: tests -> implement -> validate');
    console.log('    /image <path>      Attach image for next task (multimodal)\n');

  console.log(chalk.magenta.bold('  🎛️  Model & Engine:'));
  console.log('    /models            Interactive model selector (use arrow keys)');
  console.log('    /models-config     Show configured models/providers from local config');
  console.log('    /model <name>      Switch execution model directly');
  console.log('    /engines           Interactive engine selector (use arrow keys)');
  console.log('    /engine <name>     Switch engine directly (cursor|claude|gemini|auto)');
  console.log('    /mode [name]       Interactive mode selector or set directly');
  console.log('    /mode-info         Explain manual/assist/autopilot execution semantics');
  console.log('    Shift+Tab          Cycle REPL mode');
  console.log('    /auto-apply        Toggle auto-apply sandbox changes');
  console.log('    /verbose           Toggle verbose routing output');
  console.log('    /stack             Configure 3-tier LLM stack (router, executor, gateway)\n');

  console.log(chalk.green.bold('  🧠 Memory & LSP:'));
  console.log('    /memory [query]    Show memory stats or recall');
  console.log('    /tools             Show tool capability matrix by mode/path');
  console.log('    /lsp check [files] Run TypeScript diagnostics');
  console.log('    /lsp complete <file> <line> <column> [prefix]  Get completions\n');

  console.log(chalk.green.bold('  🔍 Context & Git:'));
  console.log('    /context           Show context size estimate');
  console.log('    /git               Show current git status');
  console.log('    /repos             Show sibling repos (cross-repo)\n');

  console.log(chalk.red.bold('  🚪 Exit:'));
  console.log('    /exit, /quit       Exit REPL (or press Ctrl+C)\n');

  console.log(chalk.gray('  💡 Tip: Type any coding task to get started. Simple chats respond'));
  console.log(chalk.gray('      instantly, code changes route to specialist agents automatically.\n'));
  if (uiMode === 'tui') {
    console.log(chalk.gray('  TUI mode uses the same runtime/controller as REPL with a denser terminal layout.\n'));
  }
}

function modeBehavior(mode: ReplMode) {
  if (mode === 'manual') {
    return {
      memoryInject: false,
      executionConfirm: false,
      autoApply: false,
      autopilotPipeline: false
    };
  }
  if (mode === 'assist') {
    return {
      memoryInject: true,
      executionConfirm: true,
      autoApply: false,
      autopilotPipeline: false
    };
  }
  return {
    memoryInject: true,
    executionConfirm: false,
    autoApply: true,
    autopilotPipeline: true
  };
}

function applySlashAlias(input: string, aliases: Record<string, string>): string {
  if (!input.startsWith('/')) return input;
  const [cmd, ...rest] = input.split(/\s+/);
  const replacement = aliases[cmd];
  if (!replacement) return input;
  const normalized = replacement.startsWith('/') ? replacement : `/${replacement}`;
  return [normalized, ...rest].join(' ').trim();
}

async function renderBannerAnimated(banner: string): Promise<void> {
  const lines = banner.split('\n');
  for (const line of lines) {
    process.stdout.write(`${chalk.cyan(line)}\n`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function nextMode(current: ReplMode): ReplMode {
  const idx = REPL_MODE_ORDER.indexOf(current);
  if (idx < 0 || idx === REPL_MODE_ORDER.length - 1) return REPL_MODE_ORDER[0];
  return REPL_MODE_ORDER[idx + 1];
}

function buildPrompt(state: ReplState, isProcessing: boolean, uiMode: 'repl' | 'tui' = 'repl'): string {
  const prefix = uiMode === 'tui' ? 'crew-tui' : 'crew';
  const mode = state.mode;
  if (isProcessing) return chalk.gray(`${prefix}(${mode},busy)> `);
  if (mode === 'autopilot') return chalk.magenta(`${prefix}(${mode})> `);
  if (mode === 'assist') return chalk.cyan(`${prefix}(${mode})> `);
  return chalk.green(`${prefix}(${mode})> `);
}

function printTuiScaffold() {
  console.log(chalk.blue('\n┌─[ TUI LAYOUT ]─────────────────────────────────────────────────────────┐'));
  console.log(chalk.white('│ Chat + Commands share the same runtime as REPL (no orchestration fork). │'));
  console.log(chalk.white('│ Panels: status/banner at top, responses inline, sandbox + cost summaries.│'));
  console.log(chalk.white('│ Keys: Shift+Tab mode cycle, /help commands, /preview /apply /trace.      │'));
  console.log(chalk.blue('└───────────────────────────────────────────────────────────────────────────┘\n'));
}

export async function startRepl(options: ReplOptions): Promise<void> {
  const { router, orchestrator, sandbox, session, logger } = options;
  const projectDir = options.projectDir || process.cwd();
  const repoConfig = options.repoConfig;
  const uiMode: 'repl' | 'tui' = options.uiMode || 'repl';
  const keeper = new AgentKeeper(projectDir);
  const memoryBroker = new MemoryBroker(projectDir);
  const checkpoints = new CheckpointStore(projectDir);
  const sessionId = await session.getSessionId();
  const replRunId = `repl-${randomUUID()}`;

  // Interactive mode selection if not provided via CLI or config
  let selectedMode: ReplMode = (options.initialMode || repoConfig?.repl?.mode || 'manual') as ReplMode;
  
  if (!options.initialMode && !repoConfig?.repl?.mode && process.stdin.isTTY) {
    try {
      console.log(''); // Clear line after init output
      const inquirer = await getInquirer();
      const modeAnswer = await inquirer.prompt([
        {
          type: 'list',
          name: 'mode',
          message: 'Select REPL mode:',
          choices: [
            {
              name: 'manual - Requires approval for all changes (safest)',
              value: 'manual',
              short: 'manual'
            },
            {
              name: 'assist - Memory-enhanced assistance',
              value: 'assist',
              short: 'assist'
            },
            {
              name: 'autopilot - Full autonomous mode (auto-apply changes)',
              value: 'autopilot',
              short: 'autopilot'
            }
          ],
          default: 'manual',
          loop: false
        }
      ]);
      selectedMode = modeAnswer.mode as ReplMode;
    } catch (err) {
      // User cancelled or inquirer unavailable — use manual
      console.error('[repl] Mode picker failed, using manual:', (err as Error).message);
      selectedMode = 'manual';
    }
  }

  const envInterfaceMode = String(process.env.CREW_INTERFACE_MODE || '').toLowerCase();
  const repoDefaultInterface: 'connected' | 'standalone' =
    Boolean(repoConfig?.repl?.useGateway) ? 'connected' : 'standalone';
  let selectedInterfaceMode: 'connected' | 'standalone' =
    options.initialInterfaceMode
    || (envInterfaceMode === 'connected' ? 'connected' : envInterfaceMode === 'standalone' ? 'standalone' : repoDefaultInterface);

  if (options.promptInterfaceMode && process.stdin.isTTY) {
    try {
      const inquirer2 = await getInquirer();
      const ifaceAnswer = await inquirer2.prompt([
        {
          type: 'list',
          name: 'interfaceMode',
          message: 'Select interface mode:',
          choices: [
            {
              name: 'standalone - Local unified pipeline (no gateway required)',
              value: 'standalone',
              short: 'standalone'
            },
            {
              name: 'connected - Route via crew-lead/gateway specialists',
              value: 'connected',
              short: 'connected'
            }
          ],
          default: selectedInterfaceMode,
          loop: false
        }
      ]);
      selectedInterfaceMode = ifaceAnswer.interfaceMode as 'connected' | 'standalone';
    } catch {
      // Keep selectedInterfaceMode fallback.
    }
  }
  process.env.CREW_INTERFACE_MODE = selectedInterfaceMode;

  const replState: ReplState = {
    model: String(repoConfig?.repl?.model || 'deepseek-chat'),
    engine: String(repoConfig?.repl?.engine || 'auto'),
    autoApply: Boolean(repoConfig?.repl?.autoApply),
    memoryMax: Number(repoConfig?.repl?.memoryMax ?? 5),
    mode: selectedMode,
    verbose: Boolean(repoConfig?.repl?.verbose || false),
    routerProvider: String(repoConfig?.repl?.routerProvider || 'grok'),
    executorProvider: String(repoConfig?.repl?.executorProvider || 'grok'),
    useGateway: selectedInterfaceMode === 'connected'
  };
  // Enforce deterministic mode defaults on startup.
  if (replState.mode === 'manual') replState.autoApply = false;
  if (replState.mode === 'autopilot') replState.autoApply = true;
  const slashAliases = repoConfig?.slashAliases || {};
  const bannerEnabled = repoConfig?.repl?.bannerEnabled !== false;
  const bannerAnimated = repoConfig?.repl?.animatedBanner !== false;
  const bannerFirstLaunchOnly = repoConfig?.repl?.bannerFirstLaunchOnly === true; // Changed default to false
  const bannerSeenFile = join(projectDir, '.crew', 'repl-banner-seen');
  const replAuditPath = join(projectDir, '.crew', 'repl-events.jsonl');
  const shouldRenderBanner = bannerEnabled && (!bannerFirstLaunchOnly || !existsSync(bannerSeenFile));
  let auditSeq = 0;
  let checkpointEnabled = true;

  // Warn if running from home directory (too broad, will be slow)
  if (projectDir === homedir()) {
    console.log(chalk.yellow('\n  ⚠ Running from home directory (~). For best results, cd into a project folder first.\n'));
  }

  // Lazy-load repo bootstrap (don't block cold start)
  let repoBootstrap: RepoBootstrap = { projectDir, topEntries: [], docs: [], keyFiles: [], readmeSummary: '' };
  const repoBootstrapPromise = buildRepoBootstrap(projectDir).then(b => { repoBootstrap = b; }).catch(() => {});

  // Pre-warm LLM provider connections (fire-and-forget, reduces first-request latency)
  const preWarmProviders = () => {
    const endpoints = [
      { key: 'GEMINI_API_KEY', url: 'https://generativelanguage.googleapis.com' },
      { key: 'OPENAI_API_KEY', url: 'https://api.openai.com' },
      { key: 'XAI_API_KEY', url: 'https://api.x.ai' },
      { key: 'GROQ_API_KEY', url: 'https://api.groq.com' },
    ];
    for (const ep of endpoints) {
      if (process.env[ep.key]) {
        fetch(ep.url, { method: 'HEAD', signal: AbortSignal.timeout(2000) }).catch(() => {});
        break; // Only pre-warm the first available provider
      }
    }
  };
  preWarmProviders();

  // Render banner FIRST, before anything else
  if (shouldRenderBanner) {
    if (bannerAnimated) {
      await renderBannerAnimated(BANNER);
    } else {
      console.log(chalk.cyan(BANNER));
    }
    try {
      await mkdir(join(projectDir, '.crew'), { recursive: true });
      await writeFile(bannerSeenFile, new Date().toISOString(), 'utf8');
    } catch {
      // Best-effort marker write.
    }
  }

  // Wait for repo bootstrap before showing status (but it started earlier)
  await repoBootstrapPromise;

  // Show dynamic status dashboard on REPL startup
  try {
    const { displayStatus } = await import('../status/dashboard.ts');
    await displayStatus();
  } catch (err) {
    // Silently fail if status dashboard can't be shown
  }

  let isProcessing = false;
  let isClosing = false;
  let isCommandProcessing = false;
  let pendingExit = false;

  const recordReplEvent = async (type: string, payload: Record<string, unknown>) => {
    auditSeq += 1;
    const event = {
      ts: new Date().toISOString(),
      seq: auditSeq,
      runId: replRunId,
      sessionId,
      type,
      ...payload
    };
    try {
      await session.appendHistory({
        type: `repl_${type}`,
        runId: replRunId,
        seq: auditSeq,
        ...payload
      } as any);
      if (checkpointEnabled) {
        await checkpoints.append(replRunId, `repl.${type}`, {
          sessionId,
          seq: auditSeq,
          ...payload
        });
      }
      await mkdir(join(projectDir, '.crew'), { recursive: true });
      await appendFile(replAuditPath, `${JSON.stringify(event)}\n`, 'utf8');
    } catch {
      // Best-effort audit side channel.
    }
  };
  try {
    await checkpoints.beginRun({
      runId: replRunId,
      mode: 'repl',
      task: `Interactive REPL session (${projectDir})`
    });
  } catch {
    checkpointEnabled = false;
  }
  await recordReplEvent('session_started', {
    mode: replState.mode,
    model: replState.model,
    engine: replState.engine
  });

  console.log(chalk.gray(`  Project: ${chalk.white(projectDir)}`));
  console.log(chalk.gray(`  Session: ${chalk.white(sessionId)}`));
  console.log(chalk.gray(`  Model: ${chalk.green(replState.model)}  Engine: ${chalk.blue(replState.engine)}  Mode: ${chalk.magenta(replState.mode)}`));
  console.log();
  if (uiMode === 'tui') {
    printTuiScaffold();
  }
  console.log(chalk.gray(`  Type ${chalk.cyan('/help')} for full command list or start chatting!\n`));
  if (repoBootstrap.topEntries.length > 0) {
    console.log(chalk.gray(`  Repo indexed: ${repoBootstrap.topEntries.length} top entries, ${repoBootstrap.docs.length} docs, ${repoBootstrap.keyFiles.length} key files.`));
    console.log(chalk.gray(`  Try ${chalk.cyan('/system')} for stack summary.\n`));
  }

  // Tab completion for commands and file paths
  const SLASH_COMMANDS = [
    '/help', '/exit', '/quit', '/model', '/models', '/engine', '/engines',
    '/mode', '/auto-apply', '/verbose', '/stack', '/preview', '/apply',
    '/rollback', '/branches', '/info', '/status', '/history', '/clear',
    '/system', '/image', '/search', '/cost', '/recall', '/checkpoint',
    '/trace', '/timeline', '/audit', '/validate', '/test', '/commit'
  ];

  const tabCompleter = (line: string): [string[], string] => {
    const trimmed = line.trim();

    // Complete slash commands
    if (trimmed.startsWith('/')) {
      const matches = SLASH_COMMANDS.filter(c => c.startsWith(trimmed));
      return [matches.length > 0 ? matches : SLASH_COMMANDS, trimmed];
    }

    // Complete file paths (best-effort, sync)
    if (trimmed.includes('/') || trimmed.includes('.')) {
      try {
        const { readdirSync, statSync } = require('fs');
        const { dirname, basename } = require('path');
        const partial = trimmed.split(/\s+/).pop() || '';
        const dir = partial.includes('/') ? join(projectDir, dirname(partial)) : projectDir;
        const prefix = partial.includes('/') ? basename(partial) : partial;
        const entries = readdirSync(dir, { withFileTypes: true })
          .filter((e: any) => e.name.startsWith(prefix) && !e.name.startsWith('.'))
          .slice(0, 20)
          .map((e: any) => {
            const full = partial.includes('/') ? dirname(partial) + '/' + e.name : e.name;
            return e.isDirectory() ? full + '/' : full;
          });
        if (entries.length > 0) return [entries, partial];
      } catch {
        // Fall through — no completions available
      }
    }

    return [[], trimmed];
  };

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(replState, isProcessing, uiMode),
    terminal: true,
    completer: tabCompleter
  });

  const keypressListener = (_str: string, key: { name?: string; shift?: boolean; sequence?: string }) => {
    const isShiftTab = (key.name === 'tab' && key.shift) || key.sequence === '\u001b[Z';
    if (!isShiftTab) return;
    const from = replState.mode;
    replState.mode = nextMode(replState.mode);
    rl.setPrompt(buildPrompt(replState, isProcessing, uiMode));
    void recordReplEvent('mode_change', { from, to: replState.mode, source: 'keybinding' });
    console.log(chalk.magenta(`\n  ↻ Mode: ${replState.mode}`));
    rl.prompt();
  };
  if (process.stdin.isTTY) {
    emitKeypressEvents(process.stdin, rl);
    process.stdin.on('keypress', keypressListener as any);
  }
  const refreshPrompt = () => rl.setPrompt(buildPrompt(replState, isProcessing, uiMode));

  // Show initial prompt
  rl.prompt();

  // Pending images for multimodal (attached via /image, consumed on next task)
  const pendingImages: string[] = [];

  const handleSlashCommand = async (rawInput: string): Promise<boolean> => {
    const trimmed = applySlashAlias(rawInput.trim(), slashAliases);
    if (!trimmed.startsWith('/')) return false;
    const [command, ...args] = trimmed.split(/\s+/);

    if (command === '/exit' || command === '/quit') {
      console.log(chalk.cyan('\n  👋 Goodbye! Session saved to .crew/\n'));
      isClosing = true;
      rl.close();
      return true;
    }

    if (command === '/help') {
      printHelp(uiMode);
      return true;
    }

    if (command === '/info') {
      const summary = buildModelSummary(projectDir, replState);
      const configuredCliEngine = String((repoConfig as any)?.cli?.engine || '(not set)');
      const configuredReplEngine = String((repoConfig as any)?.repl?.engine || '(not set)');
      const preferredEngines = Array.isArray((repoConfig as any)?.cli?.preferredEngines)
        ? (repoConfig as any).cli.preferredEngines.map((x: unknown) => String(x)).filter(Boolean)
        : [];
      const chatModel = String(process.env.CREW_CHAT_MODEL || '(env not set)');
      const routerModel = String(process.env.CREW_ROUTER_MODEL || '(env not set)');
      const reasoningModel = String(process.env.CREW_REASONING_MODEL || '(env not set)');
      const l2aModel = String(process.env.CREW_L2A_MODEL || '(env not set)');
      const l2bModel = String(process.env.CREW_L2B_MODEL || '(env not set)');
      const qaModel = String(process.env.CREW_QA_MODEL || '(env not set)');
      const extraValidators = String(process.env.CREW_L2_EXTRA_VALIDATORS || '(env not set)');
      const executionModel = String(process.env.CREW_EXECUTION_MODEL || '(env not set)');
      const maxParallelWorkers = String(process.env.CREW_MAX_PARALLEL_WORKERS || '(env not set)');

      console.log(chalk.blue('\n╔══════════════════════════════════════════════════════════════╗'));
      console.log(chalk.blue('║                    CURRENT SETTINGS                          ║'));
      console.log(chalk.blue('╚══════════════════════════════════════════════════════════════╝\n'));
      console.log(chalk.cyan('  Engine Routing (dispatch/runtime):'));
      console.log(`    Active REPL engine: ${chalk.blue(replState.engine)}`);
      console.log(`    Config default (repl.engine): ${chalk.blue(configuredReplEngine)}`);
      console.log(`    Config default (cli.engine) : ${chalk.blue(configuredCliEngine)}`);
      console.log(`    Preferred engines           : ${preferredEngines.length ? preferredEngines.join(' -> ') : chalk.gray('(none configured)')}\n`);

      console.log(chalk.cyan('  Tier Stack (model/providers):'));
      console.log(`    Tier 1 provider (Router)  : ${chalk.green(replState.routerProvider)}`);
      console.log(`    Tier 2 provider (Executor): ${chalk.green(replState.executorProvider)}`);
      console.log(`    Tier 3 gateway            : ${replState.useGateway ? chalk.green('ENABLED') : chalk.gray('disabled')}`);
      console.log(`    CREW_CHAT_MODEL           : ${chatModel}`);
      console.log(`    CREW_ROUTER_MODEL         : ${routerModel}`);
      console.log(`    CREW_REASONING_MODEL      : ${reasoningModel}`);
      console.log(`    CREW_L2A_MODEL            : ${l2aModel}`);
      console.log(`    CREW_L2B_MODEL            : ${l2bModel}`);
      console.log(`    CREW_QA_MODEL             : ${qaModel}`);
      console.log(`    CREW_L2_EXTRA_VALIDATORS  : ${extraValidators}`);
      console.log(`    CREW_EXECUTION_MODEL      : ${executionModel}`);
      console.log(`    CREW_MAX_PARALLEL_WORKERS : ${maxParallelWorkers}`);
      console.log(`    Policy-tier models        : ${summary.policyTierModels.length ? summary.policyTierModels.join(', ') : chalk.gray('(none set)')}\n`);

      console.log(chalk.cyan('  Session:'));
      console.log(`    Model: ${chalk.green(replState.model)}`);
      console.log(`    Engine: ${chalk.blue(replState.engine)}`);
      console.log(`    Mode: ${chalk.magenta(replState.mode)}`);
      const behavior = modeBehavior(replState.mode);
      console.log(`    Mode behavior: memoryInject=${behavior.memoryInject ? 'on' : 'off'}, executionConfirm=${behavior.executionConfirm ? 'on' : 'off'}, autoApply=${behavior.autoApply ? 'on' : 'off'}, autopilotPipeline=${behavior.autopilotPipeline ? 'on' : 'off'}`);
      console.log(`    Auto-apply: ${replState.autoApply ? chalk.green('ON') : chalk.gray('off')}`);
      console.log(`    Verbose: ${replState.verbose ? chalk.green('ON') : chalk.gray('off')}`);
      console.log(`    Memory max: ${replState.memoryMax}`);
      console.log(`    Project: ${chalk.gray(projectDir)}\n`);
      return true;
    }

    if (command === '/system') {
      const summary = buildModelSummary(projectDir, replState);
      printSystemSummary(summary, repoBootstrap);
      return true;
    }

    if (command === '/mode-info') {
      console.log(chalk.blue('\n--- REPL Mode Semantics ---\n'));
      console.log('  manual');
      console.log('    - Chat + dispatch normally');
      console.log('    - No memory context injection');
      console.log('    - No execute confirmation prompt');
      console.log('    - No auto-apply');
      console.log('  assist');
      console.log('    - Memory/RAG context injection enabled');
      console.log('    - Confirm before non-chat execution');
      console.log('    - No auto-apply');
      console.log('  autopilot');
      console.log('    - Memory/RAG context injection enabled');
      console.log('    - Runs full unified pipeline in standalone mode');
      console.log('    - Auto-apply sandbox changes by default\n');
      return true;
    }

    if (command === '/models-config') {
      const summary = buildModelSummary(projectDir, replState);
      printModelSummary(summary);
      return true;
    }

    if (command === '/models') {
      if (!process.stdin.isTTY) {
        console.log(chalk.yellow('\n  /models requires an interactive TTY.\n'));
        return true;
      }
      try {
        const answer = await (await getInquirer()).prompt([
          {
            type: 'list',
            name: 'model',
            message: 'Select a model:',
            choices: AVAILABLE_MODELS.map(m => ({
              name: m === replState.model ? `${m} ${chalk.green('(current)')}` : m,
              value: m
            })),
            default: replState.model,
            loop: false
          }
        ]);
        
        if (answer.model !== replState.model) {
          replState.model = answer.model;
          console.log(chalk.green(`\n  ✓ Model set to: ${answer.model}\n`));
        } else {
          console.log(chalk.gray('\n  No change.\n'));
        }
      } catch (err) {
        // User cancelled with Ctrl+C or ESC
        console.log(chalk.gray('\n  Cancelled.\n'));
      }
      return true;
    }

    if (command === '/model') {
      const modelName = args.join(' ').trim();
      if (!modelName) {
        // Show benchmark table (novel feature — no competitor has this)
        try {
          const { MODEL_CATALOG, formatModelTable, findModelInfo } = await import('./model-info.js');
          const current = findModelInfo(replState.model);
          console.log(chalk.blue('\n  ╔══════════════════════════════════════════════════════════════════════════════╗'));
          console.log(chalk.blue('  ║                        MODEL BENCHMARK & PRICING                            ║'));
          console.log(chalk.blue('  ╚══════════════════════════════════════════════════════════════════════════════╝\n'));
          console.log(chalk.gray('  Scores from OpenRouter coding benchmark (March 2026)\n'));
          console.log(chalk.cyan('  Heavy Tier (L2 Brain):'));
          console.log(formatModelTable(MODEL_CATALOG.filter(m => m.tier === 'heavy')));
          console.log(chalk.cyan('\n  Standard Tier (L3 Workers):'));
          console.log(formatModelTable(MODEL_CATALOG.filter(m => m.tier === 'standard')));
          console.log(chalk.cyan('\n  Fast Tier (L1 Routing):'));
          console.log(formatModelTable(MODEL_CATALOG.filter(m => m.tier === 'fast')));
          if (current) {
            console.log(chalk.green(`\n  Current: ${current.name} (${current.provider}) — score ${current.codingScore}, $${current.inputCost}/$${current.outputCost}/M`));
          } else {
            console.log(chalk.yellow(`\n  Current: ${replState.model} (not in catalog)`));
          }
          console.log(chalk.gray(`\n  Usage: /model <name>  — e.g. /model gpt-5.4\n`));
        } catch {
          console.log(chalk.red('\n  ✗ Could not load model catalog. Type /model <name> to set directly.\n'));
        }
      } else {
        replState.model = modelName;
        try {
          const { findModelInfo } = await import('./model-info.js');
          const info = findModelInfo(modelName);
          if (info) {
            console.log(chalk.green(`\n  ✓ Model: ${info.name} (${info.provider})`));
            console.log(chalk.gray(`    Score: ${info.codingScore} | Cost: $${info.inputCost}/$${info.outputCost}/M | Context: ${info.contextWindow}${info.note ? ` | ${info.note}` : ''}\n`));
          } else {
            console.log(chalk.green(`\n  ✓ Model set to: ${modelName}\n`));
          }
        } catch {
          console.log(chalk.green(`\n  ✓ Model set to: ${modelName}\n`));
        }
      }
      return true;
    }

    if (command === '/engines') {
      if (!process.stdin.isTTY) {
        console.log(chalk.yellow('\n  /engines requires an interactive TTY.\n'));
        return true;
      }
      try {
        const answer = await (await getInquirer()).prompt([
          {
            type: 'list',
            name: 'engine',
            message: 'Select an engine:',
            choices: AVAILABLE_ENGINES.map(e => ({
              name: e === replState.engine ? `${e} ${chalk.green('(current)')}` : e,
              value: e
            })),
            default: replState.engine,
            loop: false
          }
        ]);
        
        if (answer.engine !== replState.engine) {
          replState.engine = answer.engine;
          console.log(chalk.green(`\n  ✓ Engine set to: ${answer.engine}\n`));
        } else {
          console.log(chalk.gray('\n  No change.\n'));
        }
      } catch (err) {
        // User cancelled with Ctrl+C or ESC
        console.log(chalk.gray('\n  Cancelled.\n'));
      }
      return true;
    }

    if (command === '/engine') {
      const engineName = args[0] || '';
      if (!engineName) {
        console.log(chalk.red('\n  ✗ Provide an engine name. Type /engines to see options.\n'));
      } else if (!AVAILABLE_ENGINES.includes(engineName)) {
        console.log(chalk.red(`\n  ✗ Unknown engine "${engineName}". Type /engines to see options.\n`));
      } else {
        replState.engine = engineName;
        console.log(chalk.green(`\n  ✓ Engine set to: ${engineName}\n`));
      }
      return true;
    }

    if (command === '/auto-apply') {
      replState.autoApply = !replState.autoApply;
      await recordReplEvent('autopilot_toggle', {
        enabled: replState.autoApply,
        source: 'slash'
      });
      console.log(chalk.yellow(`\n  ✓ Auto-apply: ${replState.autoApply ? chalk.green('ON') : chalk.gray('off')}\n`));
      return true;
    }

    if (command === '/verbose') {
      replState.verbose = !replState.verbose;
      console.log(chalk.yellow(`\n  ✓ Verbose mode: ${replState.verbose ? chalk.green('ON') : chalk.gray('off')}\n`));
      return true;
    }

    if (command === '/stack') {
      if (args[0] === 'show') {
        console.log(chalk.blue('\n--- Stack (session) ---\n'));
        console.log(`  Tier 1 router provider : ${replState.routerProvider}`);
        console.log(`  Tier 2 executor provider: ${replState.executorProvider}`);
        console.log(`  Tier 3 gateway         : ${replState.useGateway ? 'enabled' : 'disabled'}`);
        console.log(`  CREW_ROUTER_MODEL      : ${process.env.CREW_ROUTER_MODEL || '(unset)'}`);
        console.log(`  CREW_REASONING_MODEL   : ${process.env.CREW_REASONING_MODEL || '(unset)'}`);
        console.log(`  CREW_L2A_MODEL         : ${process.env.CREW_L2A_MODEL || '(unset)'}`);
        console.log(`  CREW_L2B_MODEL         : ${process.env.CREW_L2B_MODEL || '(unset)'}`);
        console.log(`  CREW_QA_MODEL          : ${process.env.CREW_QA_MODEL || '(unset)'}`);
        console.log(`  CREW_MAX_PARALLEL_WORKERS: ${process.env.CREW_MAX_PARALLEL_WORKERS || '(unset)'}\n`);
        return true;
      }
      if (!process.stdin.isTTY) {
        console.log(chalk.yellow('\n  /stack requires an interactive TTY.\n'));
        return true;
      }
      try {
        console.log(chalk.blue('\n╔══════════════════════════════════════════════════════════════╗'));
        console.log(chalk.blue('║           3-TIER LLM STACK CONFIGURATION                     ║'));
        console.log(chalk.blue('╚══════════════════════════════════════════════════════════════╝\n'));

        const answers = await (await getInquirer()).prompt([
          {
            type: 'list',
            name: 'routerProvider',
            message: 'Tier 1: Router (decides CHAT/CODE/DISPATCH):',
            choices: [
              { name: 'Grok (x.ai) - Fast, smart', value: 'grok' },
              { name: 'Gemini - Cheap, 2M context', value: 'gemini' },
              { name: 'DeepSeek - Code specialist', value: 'deepseek' }
            ],
            default: replState.routerProvider,
            loop: false
          },
          {
            type: 'list',
            name: 'executorProvider',
            message: 'Tier 2: Executor (runs tasks locally):',
            choices: [
              { name: 'Grok (x.ai) - Fast, smart', value: 'grok' },
              { name: 'Gemini - Cheap, 2M context', value: 'gemini' },
              { name: 'DeepSeek - Code specialist', value: 'deepseek' }
            ],
            default: replState.executorProvider,
            loop: false
          },
          {
            type: 'confirm',
            name: 'useGateway',
            message: 'Tier 3: Enable gateway for specialists (crew-qa, crew-pm, etc)?',
            default: replState.useGateway
          },
          {
            type: 'input',
            name: 'routerModel',
            message: 'L2 router model (CREW_ROUTER_MODEL, optional):',
            default: String(process.env.CREW_ROUTER_MODEL || '')
          },
          {
            type: 'input',
            name: 'reasoningModel',
            message: 'L2 planner baseline model (CREW_REASONING_MODEL, optional):',
            default: String(process.env.CREW_REASONING_MODEL || '')
          },
          {
            type: 'input',
            name: 'l2aModel',
            message: 'L2A decomposer model (CREW_L2A_MODEL, optional):',
            default: String(process.env.CREW_L2A_MODEL || '')
          },
          {
            type: 'input',
            name: 'l2bModel',
            message: 'L2B validator model (CREW_L2B_MODEL, optional):',
            default: String(process.env.CREW_L2B_MODEL || '')
          },
          {
            type: 'input',
            name: 'qaModel',
            message: 'QA gate model (CREW_QA_MODEL, optional):',
            default: String(process.env.CREW_QA_MODEL || '')
          },
          {
            type: 'input',
            name: 'extraL2Validators',
            message: 'Extra L2 validator models CSV (CREW_L2_EXTRA_VALIDATORS, optional):',
            default: String(process.env.CREW_L2_EXTRA_VALIDATORS || '')
          },
          {
            type: 'input',
            name: 'maxParallelWorkers',
            message: 'Tier 3 max parallel workers (CREW_MAX_PARALLEL_WORKERS):',
            default: String(process.env.CREW_MAX_PARALLEL_WORKERS || '6'),
            validate: (value: string) => {
              const n = Number.parseInt(String(value || ''), 10);
              return (Number.isFinite(n) && n >= 1 && n <= 32)
                ? true
                : 'Enter a number between 1 and 32';
            }
          }
        ]);

        replState.routerProvider = answers.routerProvider;
        replState.executorProvider = answers.executorProvider;
        replState.useGateway = answers.useGateway;

        console.log(chalk.green('\n  ✓ Stack configured:'));
        console.log(chalk.cyan(`    Tier 1 (Router)  : ${replState.routerProvider}`));
        console.log(chalk.cyan(`    Tier 2 (Executor): ${replState.executorProvider}`));
        console.log(chalk.cyan(`    Tier 3 (Gateway) : ${replState.useGateway ? 'ENABLED' : 'DISABLED'}`));
        console.log();

        // Update environment for this session
        process.env.CREW_ROUTING_ORDER = `${replState.routerProvider},${replState.executorProvider}`;
        process.env.CREW_ROUTER_MODEL = String(answers.routerModel || '').trim();
        process.env.CREW_REASONING_MODEL = String(answers.reasoningModel || '').trim();
        process.env.CREW_L2A_MODEL = String(answers.l2aModel || '').trim();
        process.env.CREW_L2B_MODEL = String(answers.l2bModel || '').trim();
        process.env.CREW_QA_MODEL = String(answers.qaModel || '').trim();
        process.env.CREW_L2_EXTRA_VALIDATORS = String(answers.extraL2Validators || '').trim();
        process.env.CREW_MAX_PARALLEL_WORKERS = String(Math.max(1, Math.min(32, Number.parseInt(String(answers.maxParallelWorkers || '6'), 10) || 6)));
      } catch (err) {
        console.log(chalk.gray('\n  Cancelled.\n'));
      }
      return true;
    }

    if (command === '/verbose') {
      replState.verbose = !replState.verbose;
      console.log(chalk.yellow(`\n  ✓ Verbose routing: ${replState.verbose ? chalk.green('ON') : chalk.gray('off')}\n`));
      return true;
    }

    if (command === '/mode') {
      const requested = (args[0] || '').trim().toLowerCase();
      
      // If no argument provided, show interactive picker
      if (!requested) {
        if (!process.stdin.isTTY) {
          console.log(chalk.yellow('\n  /mode (interactive) requires an interactive TTY. Use /mode <manual|assist|autopilot>.\n'));
          return true;
        }
        try {
          const answer = await (await getInquirer()).prompt([
            {
              type: 'list',
              name: 'mode',
              message: 'Select REPL mode:',
              choices: [
                {
                  name: 'manual - Requires approval for all changes',
                  value: 'manual',
                  short: 'manual'
                },
                {
                  name: 'assist - Memory-enhanced assistance',
                  value: 'assist',
                  short: 'assist'
                },
                {
                  name: 'autopilot - Full autonomous mode (auto-apply)',
                  value: 'autopilot',
                  short: 'autopilot'
                }
              ].map(choice => ({
                ...choice,
                name: choice.value === replState.mode 
                  ? `${choice.name} ${chalk.green('(current)')}`
                  : choice.name
              })),
              default: replState.mode,
              loop: false
            }
          ]);
          
          if (answer.mode !== replState.mode) {
            const from = replState.mode;
            replState.mode = answer.mode as ReplMode;
            if (replState.mode === 'manual') replState.autoApply = false;
            if (replState.mode === 'autopilot') replState.autoApply = true;
            rl.setPrompt(buildPrompt(replState, isProcessing, uiMode));
            await recordReplEvent('mode_change', { from, to: replState.mode, source: 'interactive' });
            console.log(chalk.green(`\n  ✓ Mode set to: ${replState.mode}\n`));
          } else {
            console.log(chalk.gray('\n  No change.\n'));
          }
        } catch (err) {
          console.log(chalk.gray('\n  Cancelled.\n'));
        }
        return true;
      }
      
      // Argument provided, validate and set
      if (!REPL_MODE_ORDER.includes(requested as ReplMode)) {
        console.log(chalk.red('\n  ✗ Mode must be one of: manual, assist, autopilot\n'));
        return true;
      }
      const from = replState.mode;
      replState.mode = requested as ReplMode;
      if (replState.mode === 'manual') replState.autoApply = false;
      if (replState.mode === 'autopilot') replState.autoApply = true;
      rl.setPrompt(buildPrompt(replState, isProcessing, uiMode));
      await recordReplEvent('mode_change', { from, to: replState.mode, source: 'slash' });
      console.log(chalk.green(`\n  ✓ Mode set to: ${replState.mode}\n`));
      return true;
    }

    if (command === '/tools') {
      const summary = buildModelSummary(projectDir, replState);
      const mode = summary.mode;
      const behavior = modeBehavior(replState.mode);
      console.log(chalk.blue('\n--- Tool Capability Matrix ---\n'));
      console.log(`  Interface mode: ${mode}`);
      console.log(`  REPL mode: ${replState.mode}`);
      console.log(`  Local sandbox edits: ${mode === 'standalone' ? 'yes' : 'staged via response parsing'}`);
      console.log(`  Gateway agent tools: ${mode === 'connected' ? 'yes (dispatch path)' : 'no (unless explicitly connected)'}`);
      console.log(`  Memory/RAG injection: ${behavior.memoryInject ? 'enabled' : 'disabled'}`);
      console.log('  LSP checks/completion: enabled');
      console.log('  PTY tooling: available via `crew exec`');
      console.log('  Notes: actual tool usage depends on routing, permissions, and parser acceptance.\n');
      return true;
    }

    if (command === '/status') {
      const sess = await session.loadSession();
      const cost = await session.loadCost();
      const pipeline = await loadPipelineMetricsSummary(projectDir);
      const activeBranch = sandbox.getActiveBranch();
      const hasChanges = sandbox.hasChanges(activeBranch);

      console.log(chalk.blue('\n┌─ Session Status'));
      console.log(`│  History: ${sess.history.length} entries`);
      console.log(`│  Cost: ${chalk.green(`$${cost.totalUsd.toFixed(4)}`)}`);
      console.log(`│  Sandbox: ${chalk.yellow(activeBranch)} ${hasChanges ? chalk.yellow('(has changes)') : chalk.gray('(clean)')}`);
      console.log(`│  Model: ${chalk.green(replState.model)}`);
      console.log(`│  Engine: ${chalk.blue(replState.engine)}`);
      console.log(`│  Mode: ${chalk.magenta(replState.mode)}`);
      console.log(`│  Pipeline runs: ${pipeline.runs} | QA approved: ${pipeline.qaApproved} | QA rejected: ${pipeline.qaRejected}`);
      console.log(`│  Context chunks: ${pipeline.contextChunksUsed} | Chars saved(est): ${pipeline.contextCharsSaved}`);
      console.log('└─\n');
      return true;
    }

    if (command === '/history') {
      const n = Number.parseInt(args[0] || '5', 10);
      const sess = await session.loadSession();
      const entries = sess.history.slice(-n);

      console.log(chalk.blue(`\n--- Last ${entries.length} Messages ---`));
      entries.forEach((e: any) => {
        const time = e.timestamp?.split('T')[1]?.split('.')[0] || '';
        const type = e.type || 'unknown';
        console.log(`${chalk.gray(`[${time}]`)} ${chalk.bold(type)}${e.agent ? chalk.gray(` (${e.agent})`) : ''}`);
        if (e.task) console.log(chalk.gray(`  ${e.task.slice(0, 80)}${e.task.length > 80 ? '...' : ''}`));
      });
      console.log();
      return true;
    }

    if (command === '/preview') {
      const activeBranch = sandbox.getActiveBranch();
      if (!sandbox.hasChanges(activeBranch)) {
        console.log(chalk.yellow(`\n  No pending changes in "${activeBranch}".\n`));
      } else {
        const rawPreview = sandbox.preview(activeBranch);
        console.log(chalk.blue(`\n┌─ Sandbox Preview [${activeBranch}]`));
        // Colored diff: green for adds, red for removals, cyan for hunks
        const coloredLines = rawPreview.split('\n').map((line: string) => {
          if (line.startsWith('+++') || line.startsWith('---')) return chalk.bold(line);
          if (line.startsWith('+')) return chalk.green(line);
          if (line.startsWith('-')) return chalk.red(line);
          if (line.startsWith('@@')) return chalk.cyan(line);
          return line;
        });
        console.log(coloredLines.join('\n'));
        console.log('└─\n');
      }
      return true;
    }

    if (command === '/apply') {
      const wantCommit = args.includes('--commit');
      const activeBranch = sandbox.getActiveBranch();
      if (!sandbox.hasChanges(activeBranch)) {
        console.log(chalk.yellow('\n  No changes to apply.\n'));
      } else {
        try {
          const paths = sandbox.getPendingPaths(activeBranch);
          await sandbox.apply(activeBranch);
          console.log(chalk.green(`\n  ✓ Applied to: ${paths.join(', ')}\n`));

          // Auto-commit with AI-generated message
          if (wantCommit) {
            try {
              const { execSync } = await import('node:child_process');
              const diff = execSync('git diff --cached --stat', { encoding: 'utf8', cwd: projectDir }).trim()
                || execSync('git diff --stat', { encoding: 'utf8', cwd: projectDir }).trim();
              if (!diff) {
                console.log(chalk.yellow('  No git changes to commit.\n'));
              } else {
                execSync('git add -A', { cwd: projectDir });
                // Generate commit message via LLM
                const commitResult = await orchestrator.executeLocally(
                  `Generate a concise conventional commit message (type: description, max 72 chars) for this diff. Reply with ONLY the commit message:\n\n${diff.slice(0, 2000)}`,
                  { model: replState.model }
                );
                const commitMsg = String(commitResult.result || 'chore: update files').trim().replace(/^['"`]|['"`]$/g, '').split('\n')[0];
                execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { cwd: projectDir });
                console.log(chalk.green(`  ✓ Committed: ${commitMsg}\n`));
              }
            } catch (commitErr) {
              console.log(chalk.red(`  ✗ Commit failed: ${(commitErr as Error).message}\n`));
            }
          }
        } catch (err) {
          console.log(chalk.red(`\n  ✗ Apply failed: ${(err as Error).message}\n`));
        }
      }
      return true;
    }

    if (command === '/rollback') {
      const activeBranch = sandbox.getActiveBranch();
      try {
        await sandbox.rollback(activeBranch);
        console.log(chalk.yellow(`\n  ✓ Rolled back "${activeBranch}".\n`));
      } catch (err) {
        console.log(chalk.red(`\n  ✗ Rollback failed: ${(err as Error).message}\n`));
      }
      return true;
    }

    if (command === '/branches' || command === '/branch') {
      if (!process.stdin.isTTY) {
        console.log(chalk.yellow('\n  /branch requires an interactive TTY.\n'));
        return true;
      }
      const active = sandbox.getActiveBranch();
      const branches = sandbox.getBranches();
      
      // If no branches or only one branch, just show the list
      if (branches.length <= 1) {
        console.log(chalk.blue('\n┌─ Sandbox Branches'));
        branches.forEach(b => {
          if (b === active) {
            console.log(chalk.green(`│  ● ${b} (active)`));
          } else {
            console.log(`│    ${b}`);
          }
        });
        console.log('└─\n');
        return true;
      }
      
      // Multiple branches - offer interactive selector
      try {
        const answer = await (await getInquirer()).prompt([
          {
            type: 'list',
            name: 'branch',
            message: 'Select sandbox branch:',
            choices: branches.map(b => ({
              name: b === active ? `${b} ${chalk.green('(active)')}` : b,
              value: b
            })),
            default: active,
            loop: false
          }
        ]);
        
        if (answer.branch !== active) {
          sandbox.switchBranch(answer.branch);
          console.log(chalk.green(`\n  ✓ Switched to branch: ${answer.branch}\n`));
        } else {
          console.log(chalk.gray('\n  No change.\n'));
        }
      } catch (err) {
        console.log(chalk.gray('\n  Cancelled.\n'));
      }
      return true;
    }

    if (command === '/clear') {
      try {
        await session.clear();
        console.log(chalk.yellow('\n  ✓ Session history cleared.\n'));
      } catch (err) {
        console.log(chalk.red(`\n  ✗ Clear failed: ${(err as Error).message}\n`));
      }
      return true;
    }

    if (command === '/trace') {
      const traceId = args[0];
      if (!traceId) {
        console.log(chalk.blue('\n╔══════════════════════════════════════════════════════════════╗'));
        console.log(chalk.blue('║                    EXECUTION TRACE                           ║'));
        console.log(chalk.blue('╚══════════════════════════════════════════════════════════════╝\n'));
        console.log(chalk.yellow('  Usage: /trace <traceId>'));
        console.log(chalk.gray('  Trace IDs are shown in verbose mode or in execution results.\n'));
        return true;
      }

      try {
        const trace = orchestrator.getTrace(traceId);
        if (!trace || (trace.composedPrompts.length === 0 && !trace.plannerTrace)) {
          console.log(chalk.yellow(`\n  No trace found for ID: ${traceId}\n`));
          return true;
        }

        console.log(chalk.blue('\n╔══════════════════════════════════════════════════════════════╗'));
        console.log(chalk.blue(`║           TRACE: ${traceId.slice(0, 30)}           ║`));
        console.log(chalk.blue('╚══════════════════════════════════════════════════════════════╝\n'));

        if (trace.composedPrompts.length > 0) {
          console.log(chalk.cyan('  Composed Prompts:'));
          trace.composedPrompts.forEach((p, i) => {
            console.log(chalk.white(`    ${i + 1}. ${p.templateId} (v${p.templateVersion})`));
            console.log(chalk.gray(`       Overlays: ${p.overlays.map(o => o.type).join(', ')}`));
            console.log(chalk.gray(`       Composed: ${p.composedAt}`));
          });
          console.log();
        }

        if (trace.plannerTrace && trace.plannerTrace.length > 0) {
          console.log(chalk.cyan('  Planner Trace:'));
          trace.plannerTrace.forEach((p, i) => {
            console.log(chalk.white(`    ${i + 1}. ${p.templateId} (v${p.templateVersion})`));
            console.log(chalk.gray(`       Overlays: ${p.overlays.map(o => o.type).join(', ')}`));
          });
          console.log();
        }

        console.log(chalk.gray('  Full prompts saved to session history.\n'));
      } catch (err) {
        console.log(chalk.red(`\n  ✗ Trace failed: ${(err as Error).message}\n`));
      }
      return true;
    }

    if (command === '/cost') {
      const cost = await session.loadCost();
      console.log(chalk.blue('\n┌─ Cost Summary'));
      console.log(`│  Total: ${chalk.green(`$${cost.totalUsd.toFixed(4)}`)}`);
      if (Object.keys(cost.byModel).length > 0) {
        console.log('│  By model:');
        Object.entries(cost.byModel).forEach(([model, usd]: [string, any]) => {
          console.log(`│    ${model}: $${usd.toFixed(4)}`);
        });
      }
      console.log('└─\n');
      return true;
    }

    if (command === '/context') {
      try {
        const gitContext = await getProjectContext(projectDir);
        const sess = await session.loadSession();
        const tokenEstimate = Math.ceil((gitContext.length + JSON.stringify(sess.history).length) / 4);

        console.log(chalk.blue('\n┌─ Context Footprint'));
        console.log(`│  Project: ${projectDir}`);
        console.log(`│  Session entries: ${sess.history.length}`);
        console.log(`│  Git context: ${gitContext.length} chars`);
        console.log(`│  Estimated tokens: ~${tokenEstimate}`);
        console.log('└─\n');
      } catch (err) {
        console.log(chalk.red(`\n  ✗ Context check failed: ${(err as Error).message}\n`));
      }
      return true;
    }

    if (command === '/git') {
      try {
        const gitContext = await getProjectContext(projectDir);
        console.log(chalk.blue('\n┌─ Git Status'));
        console.log(gitContext);
        console.log('└─\n');
      } catch (err) {
        console.log(chalk.red(`\n  ✗ Git read failed: ${(err as Error).message}\n`));
      }
      return true;
    }

    if (command === '/repos') {
      try {
        const repoContext = await collectMultiRepoContext(projectDir);
        console.log(chalk.blue('\n┌─ Sibling Repositories'));
        console.log(repoContext);
        console.log('└─\n');
      } catch (err) {
        console.log(chalk.red(`\n  ✗ Repos scan failed: ${(err as Error).message}\n`));
      }
      return true;
    }

    if (command === '/memory') {
      const query = args.join(' ').trim();
      if (!query) {
        const stats = await keeper.stats();
        console.log(chalk.blue('\n--- AgentKeeper Memory Stats ---\n'));
        console.log(`  Total entries: ${stats.entries}`);
        console.log(`  Approx bytes: ${stats.bytes}`);
        return true;
      }
      const hits = await memoryBroker.recall(query, {
        maxResults: replState.memoryMax,
        includeDocs: true,
        includeCode: false,
        preferSuccessful: true
      });
      if (hits.length === 0) {
        console.log(chalk.yellow(`\n  No memory/RAG matches for "${query}".\n`));
        return true;
      }
      console.log(chalk.blue(`\n--- Shared Memory + RAG Recall: "${query}" (${hits.length} hits) ---\n`));
      for (const h of hits) {
        console.log(chalk.yellow(`[${h.score.toFixed(3)}] ${h.source} — ${h.title.slice(0, 80)}`));
        const preview = h.text.length > 120 ? `${h.text.slice(0, 120)}...` : h.text;
        console.log(chalk.gray(`  ${preview}`));
      }
      console.log();
      return true;
    }

    if (command === '/lsp') {
      const sub = args[0];
      if (!sub || sub === 'help') {
        console.log(chalk.blue('\n--- LSP Commands ---'));
        console.log('  /lsp check [files...]');
        console.log('  /lsp complete <file> <line> <column> [prefix]\n');
        return true;
      }
      if (sub === 'check') {
        const files = args.slice(1);
        const { typeCheckProject } = await import('../lsp/index.js');
        const diagnostics = typeCheckProject(projectDir, files);
        if (diagnostics.length === 0) {
          console.log(chalk.green('\n  ✓ No LSP diagnostics found.\n'));
          return true;
        }
        console.log(chalk.yellow(`\nFound ${diagnostics.length} diagnostic(s):`));
        for (const diag of diagnostics) {
          console.log(`  ${diag.category.toUpperCase()} ${diag.code} ${diag.file}:${diag.line}:${diag.column}`);
          console.log(`    ${diag.message}`);
        }
        console.log();
        return true;
      }
      if (sub === 'complete') {
        const file = args[1];
        const line = Number.parseInt(args[2] || '', 10);
        const column = Number.parseInt(args[3] || '', 10);
        const prefix = args[4] || '';
        if (!file || Number.isNaN(line) || Number.isNaN(column)) {
          console.log(chalk.red('\n  ✗ Usage: /lsp complete <file> <line> <column> [prefix]\n'));
          return true;
        }
        const { getCompletions } = await import('../lsp/index.js');
        const completions = getCompletions(projectDir, file, line, column, 20, prefix);
        if (completions.length === 0) {
          console.log(chalk.yellow('\n  No completions found.\n'));
          return true;
        }
        console.log(chalk.blue(`\nCompletions (${completions.length}):`));
        completions.forEach(item => console.log(`  - ${item.name} (${item.kind})`));
        console.log();
        return true;
      }
      console.log(chalk.red(`\n  ✗ Unknown /lsp subcommand: ${sub}\n`));
      return true;
    }

    // ── /image <path> — attach image for next agentic task ──
    if (command === '/image') {
      const imgPath = args.join(' ').trim();
      if (!imgPath) {
        if (pendingImages.length === 0) {
          console.log(chalk.yellow('\n  No images attached. Usage: /image <path>\n'));
        } else {
          console.log(chalk.cyan(`\n  📷 ${pendingImages.length} image(s) attached:`));
          for (const p of pendingImages) {
            console.log(chalk.gray(`     ${p}`));
          }
          console.log(chalk.gray('  These will be sent with your next message.\n'));
        }
        return true;
      }
      const { resolve: resolvePath } = await import('node:path');
      const { existsSync } = await import('node:fs');
      const absPath = resolvePath(projectDir, imgPath);
      const ext = absPath.split('.').pop()?.toLowerCase();
      if (!['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext || '')) {
        console.log(chalk.red(`\n  ✗ Unsupported image type: .${ext} (supported: png, jpg, jpeg, webp, gif)\n`));
        return true;
      }
      if (!existsSync(absPath)) {
        console.log(chalk.red(`\n  ✗ File not found: ${absPath}\n`));
        return true;
      }
      pendingImages.push(absPath);
      console.log(chalk.green(`\n  📷 Image attached: ${absPath}`));
      console.log(chalk.gray(`  ${pendingImages.length} image(s) queued. Type your task and they'll be sent with it.\n`));
      return true;
    }

    // ── /diff — colorized git diff ──
    if (command === '/diff') {
      try {
        const { execSync } = await import('node:child_process');
        const staged = execSync('git diff --cached', { encoding: 'utf8', cwd: projectDir }).trim();
        const unstaged = execSync('git diff', { encoding: 'utf8', cwd: projectDir }).trim();
        const fullDiff = (staged + '\n' + unstaged).trim();
        if (!fullDiff) {
          console.log(chalk.yellow('\n  No git changes.\n'));
        } else {
          console.log(chalk.blue('\n┌─ Git Diff'));
          const coloredLines = fullDiff.split('\n').map((line: string) => {
            if (line.startsWith('+++') || line.startsWith('---')) return chalk.bold(line);
            if (line.startsWith('+')) return chalk.green(line);
            if (line.startsWith('-')) return chalk.red(line);
            if (line.startsWith('@@')) return chalk.cyan(line);
            if (line.startsWith('diff ')) return chalk.bold.blue(line);
            return line;
          });
          console.log(coloredLines.join('\n'));
          console.log('└─\n');
        }
      } catch (err) {
        console.log(chalk.red(`\n  ✗ Git diff failed: ${(err as Error).message}\n`));
      }
      return true;
    }

    // ── /validate — blind LLM code review ──
    if (command === '/validate') {
      console.log(chalk.cyan('\n  🔍 Running blind validation...\n'));
      try {
        const { execSync } = await import('node:child_process');
        let diffStat = '';
        try { diffStat = execSync('git diff HEAD~1 --stat', { encoding: 'utf8', cwd: projectDir }).slice(0, 2000); } catch {}
        let codeSnippets = '';
        try {
          const changedFiles = execSync('git diff HEAD~1 --name-only', { encoding: 'utf8', cwd: projectDir })
            .split('\n').filter(Boolean).slice(0, 5);
          for (const f of changedFiles) {
            try {
              const { readFileSync } = await import('node:fs');
              const content = readFileSync(join(projectDir, f), 'utf8');
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

End with VERDICT: SHIP ✅, FIX 🔧, or REJECT ❌ with actionable items.

## Changed files\n${diffStat || 'No recent changes'}\n\n## Code\n${codeSnippets || 'No code to review'}`;

        const result = await orchestrator.executeLocally(validateTask, { model: replState.model });
        const responseText = String(result.result || 'Validation could not complete.');
        console.log(chalk.cyan('  ┌─ Validation Report'));
        logger.printWithHighlight(responseText);
        console.log('  └─\n');

        if (result.costUsd) {
          await session.trackCost({ model: result.model || replState.model, usd: result.costUsd });
        }
      } catch (err) {
        console.log(chalk.red(`\n  ✗ Validation failed: ${(err as Error).message}\n`));
      }
      return true;
    }

    // ── /test-first — TDD workflow ──
    if (command === '/test-first') {
      const tfTask = args.join(' ').trim();
      if (!tfTask) {
        console.log(chalk.red('\n  ✗ Usage: /test-first <task description>\n'));
        return true;
      }
      console.log(chalk.magenta('\n  🧪 Test-first mode\n'));
      console.log(chalk.gray('  Step 1: Generate tests → Step 2: Implement → Step 3: Validate\n'));

      try {
        // Step 1: Generate tests
        console.log(chalk.bold('  Step 1: Generating tests...\n'));
        const testResult = await orchestrator.executeLocally(
          `You are a TDD expert. Given a task description, write comprehensive tests FIRST. Cover happy path, edge cases, error handling, input validation. Output ONLY the test code in a fenced code block with the filename.\n\nTask: ${tfTask}\nProject dir: ${projectDir}`,
          { model: replState.model }
        );
        const testCode = String(testResult.result || '');
        console.log(chalk.cyan('  ┌─ Tests'));
        logger.printWithHighlight(testCode);
        console.log('  └─\n');

        // Step 2: Implement
        console.log(chalk.bold('  Step 2: Implementing to pass tests...\n'));
        const implResult = await orchestrator.executeLocally(
          `Given these tests, write the MINIMAL implementation to make ALL tests pass. Use diff blocks to show changes.\n\nTests:\n${testCode}\n\nTask: "${tfTask}"`,
          { model: replState.model }
        );
        const implCode = String(implResult.result || '');
        console.log(chalk.cyan('  ┌─ Implementation'));
        logger.printWithHighlight(implCode);
        console.log('  └─\n');

        // Step 3: Validate
        console.log(chalk.bold('  Step 3: Validating implementation against tests...\n'));
        const valResult = await orchestrator.executeLocally(
          `Given tests and implementation, verify:\n1. Would all tests pass? Walk through each test case.\n2. Missing edge cases?\n3. Implementation bugs?\nVerdict: PASS ✅ or FAIL ❌ with specific issues.\n\nTests:\n${testCode}\n\nImplementation:\n${implCode}`,
          { model: replState.model }
        );
        console.log(chalk.cyan('  ┌─ Validation'));
        logger.printWithHighlight(String(valResult.result || ''));
        console.log('  └─\n');

        // Track cost for all 3 steps
        const totalCost = (testResult.costUsd || 0) + (implResult.costUsd || 0) + (valResult.costUsd || 0);
        if (totalCost > 0) {
          await session.trackCost({ model: replState.model, usd: totalCost });
        }
        console.log(chalk.gray(`  Total test-first cost: $${totalCost.toFixed(4)}\n`));
      } catch (err) {
        console.log(chalk.red(`\n  ✗ Test-first failed: ${(err as Error).message}\n`));
      }
      return true;
    }

    console.log(chalk.red(`\n  ✗ Unknown command: ${command}. Type /help.\n`));
    return true;
  };

  refreshPrompt();
  rl.prompt();

  rl.on('line', async (input: string) => {
    const trimmed = input.trim();

    if (!trimmed) {
      rl.prompt();
      return;
    }

    if (isCommandProcessing) {
      const isExitCmd = /^\/(?:exit|quit)\b/i.test(trimmed);
      if (isExitCmd) {
        pendingExit = true;
        if (process.stdin.isTTY) {
          console.log(chalk.gray('\n  Exiting after current command completes...\n'));
        }
        return;
      }
      if (!process.stdin.isTTY) {
        // In piped/script mode, ignore overlapping non-exit input quietly.
        return;
      }
      console.log(chalk.yellow('\n  ⏳ A command prompt is already active. Finish/cancel it first.\n'));
      rl.prompt();
      return;
    }

    let handled = false;
    try {
      isCommandProcessing = true;
      handled = await handleSlashCommand(trimmed);
    } catch (err) {
      console.log(chalk.red(`\n  ✗ Command failed: ${(err as Error).message}\n`));
      isCommandProcessing = false;
      if (!isClosing) rl.prompt();
      return;
    }
    isCommandProcessing = false;
    if (pendingExit && !isClosing) {
      pendingExit = false;
      isClosing = true;
      console.log(chalk.cyan('\n  👋 Goodbye! Session saved to .crew/\n'));
      rl.close();
      return;
    }
    if (handled) {
      if (!isClosing) rl.prompt();
      return;
    }

    if (isProcessing) {
      console.log(chalk.yellow('\n  ⏳ Previous message still processing. Please wait or press Ctrl+C to cancel.\n'));
      rl.prompt();
      return;
    }

    isProcessing = true;

    // Spinner for thinking indicator
    // Simple thinking indicator (no intervals — those fight with readline)
    let spinnerActive = false;
    if (process.stdout.isTTY) {
      process.stdout.write(chalk.gray('  ⏳ Thinking...\n'));
      spinnerActive = true;
    }
    const stopSpinner = () => {
      if (spinnerActive) {
        spinnerActive = false;
        // Move up one line and clear it
        process.stdout.write('\x1b[1A\x1b[2K');
      }
    };

    try {
      if (replState.verbose) {
        stopSpinner();
        console.log(chalk.gray('  ⏳ Routing...'));
      }

      let taskInput = trimmed;
      const lower = trimmed.toLowerCase();
      if (/\b(switch|set|use).*(solo|standalone)\b/.test(lower)) {
        stopSpinner();
        replState.useGateway = false;
        process.env.CREW_INTERFACE_MODE = 'standalone';
        console.log(chalk.cyan('\n  ┌─ Response'));
        console.log(chalk.white('  Switched to standalone mode. Local routing/execution is now preferred.'));
        console.log('  └─\n');
        isProcessing = false;
        rl.prompt();
        return;
      }
      if (/\b(switch|set|use).*(connected|gateway)\b/.test(lower)) {
        stopSpinner();
        replState.useGateway = true;
        process.env.CREW_INTERFACE_MODE = 'connected';
        console.log(chalk.cyan('\n  ┌─ Response'));
        console.log(chalk.white('  Switched to connected mode. Gateway/crew-lead orchestration is now preferred.'));
        console.log('  └─\n');
        isProcessing = false;
        rl.prompt();
        return;
      }

      const modelSummary = buildModelSummary(projectDir, replState);
      const localAnswer = answerLocalMetaQuestion(trimmed, modelSummary);
      if (localAnswer) {
        console.log(chalk.cyan('\n  ┌─ Response'));
        console.log(chalk.white(`  ${localAnswer}`));
        console.log('  └─\n');
        await session.appendHistory({
          type: 'repl_meta',
          input: trimmed,
          response: localAnswer
        });
        isProcessing = false;
        rl.prompt();
        return;
      }
      // Only intercept genuine meta questions, not actual work requests
      const bootstrapAnswer = answerFromBootstrap(trimmed, modelSummary, repoBootstrap);
      if (bootstrapAnswer) {
        stopSpinner();
        console.log(chalk.cyan('\n  ┌─ Response'));
        console.log(chalk.white(`  ${bootstrapAnswer}`));
        console.log('  └─\n');
        await session.appendHistory({
          type: 'repl_meta',
          input: trimmed,
          response: bootstrapAnswer
        });
        isProcessing = false;
        rl.prompt();
        return;
      }

      const behavior = modeBehavior(replState.mode);
      if (behavior.memoryInject) {
        const recalls = await memoryBroker.recall(trimmed, {
          maxResults: replState.memoryMax,
          includeDocs: true,
          includeCode: false,
          preferSuccessful: true
        });
        if (recalls.length > 0) {
          const memoryContext = await memoryBroker.recallAsContext(trimmed, {
            maxResults: replState.memoryMax,
            includeDocs: true,
            includeCode: false,
            preferSuccessful: true
          });
          taskInput = `${trimmed}\n\n${memoryContext}`;
        }
      }

      const route = await orchestrator.route(taskInput);
      const agent = route.agent || 'crew-main';

      if (replState.verbose) {
        console.log(chalk.gray(`  → ${agent} (${route.decision})`));
      }

      if (route.decision === 'CHAT') {
        stopSpinner();
        const responseText = route.response || 
          "I'm crew-cli, a multi-agent coding orchestrator. Ask me to build something, review code, or dispatch to specialists!";
        console.log(chalk.cyan('\n  ┌─ Response'));
        logger.printWithHighlight(`  ${responseText}`);
        console.log('  └─\n');

        try {
          await session.appendHistory({
            type: 'repl_chat',
            input: trimmed,
            response: responseText
          });

          await session.trackCost({
            inputTokens: trimmed.length / 4,
            outputTokens: responseText.length / 4,
            model: 'groq-router',
            costUsd: 0.0001
          });
        } catch {
          // Session tracking is best-effort
        }

        isProcessing = false;
        rl.prompt();
        return;
      }

      if (behavior.executionConfirm && process.stdin.isTTY) {
        stopSpinner();
        const estimate = estimateCost(taskInput, replState.model || undefined, 1800);
        const answer = await (await getInquirer()).prompt([
          {
            type: 'confirm',
            name: 'ok',
            message: `Execute ${route.decision} via ${agent}? est ~$${estimate.totalUsd.toFixed(4)}`,
            default: true
          }
        ]);
        if (!answer.ok) {
          console.log(chalk.yellow('\n  Skipped execution.\n'));
          isProcessing = false;
          rl.prompt();
          return;
        }
      }

      const dispatchOpts: any = {
        project: projectDir,
        sessionId: await session.getSessionId()
      };
      if (replState.model && replState.model !== 'auto') dispatchOpts.model = replState.model;
      if (replState.engine && replState.engine !== 'auto') dispatchOpts.engine = replState.engine;

      // Load session history and format as context for standalone mode
      const standaloneMode = modelSummary.mode === 'standalone';
      let conversationContext = '';
      if (standaloneMode) {
        const sess = await session.loadSession();
        const recentHistory = sess.history.slice(-10); // Last 10 exchanges
        if (recentHistory.length > 0) {
          conversationContext = recentHistory
            .map((entry: any) => {
              const input = entry.input || entry.task || '';
              const output = entry.output || entry.response || entry.result || '';
              if (!input && !output) return '';
              const parts = [];
              if (input) parts.push(`User: ${input}`);
              if (output) parts.push(`Assistant: ${output}`);
              return parts.join('\n');
            })
            .filter(Boolean)
            .join('\n\n');
        }
      }

      const useLegacyStandalone = String(process.env.CREW_LEGACY_ROUTER || '').toLowerCase() === 'true';
      const policy = getExecutionPolicy();
      // Stop spinner before execution starts (streaming will take over)
      stopSpinner();

      // Tool progress display (visible without verbose mode)
      const toolProgressLog: string[] = [];
      const onToolCall = (name: string, params: Record<string, any>) => {
        const paramHint = params.file_path || params.path || params.command || params.query || '';
        const display = paramHint ? `${name}(${String(paramHint).slice(0, 60)})` : name;
        if (!replState.verbose) {
          console.log(chalk.gray(`  🔧 ${display}`));
        }
        toolProgressLog.push(display);
      };

      // Inject onToolCall into orchestrator/executor options if available
      if (dispatchOpts) (dispatchOpts as any).onToolCall = onToolCall;

      const result = standaloneMode
        ? (useLegacyStandalone
          ? await withRetries(
              async () => orchestrator.executeLocally(route.task || taskInput, {
                model: dispatchOpts.model
              }),
              policy
            )
          : await withRetries(
              async () => orchestrator.executeAgentic(route.task || taskInput, {
                model: dispatchOpts.model,
                onToolCall,
                conversationContext,
                sessionId: dispatchOpts.sessionId
              }),
              policy
            ))
        : await withRetries(
            async () => router.dispatch(agent, taskInput, dispatchOpts),
            policy
          );

      await session.appendHistory({
        type: 'repl_request',
        agent,
        task: taskInput,
        projectDir
      });

      await session.appendHistory({
        type: 'repl_result',
        agent,
        success: Boolean(result.success),
        result: result.result
      });

      await session.appendRouting({
        route: route.decision,
        model: result.model || replState.model || 'unknown',
        agent: standaloneMode ? 'local-executor' : agent,
        mode: standaloneMode ? 'standalone' : 'connected'
      });

      if (result.costUsd && result.model) {
        await session.trackCost({
          model: result.model,
          usd: result.costUsd,
          promptTokens: result.promptTokens || 0,
          completionTokens: result.completionTokens || 0
        });
      }

      const responseText = String(result.response || result.result || '');
      console.log(chalk.cyan('\n  ┌─ Response'));
      logger.printWithHighlight(responseText);
      console.log('  └─');

      // Provider + cost footer (novel feature)
      const providerInfo = (result as any).providerId || (result as any).model || replState.model;
      const modelUsed = (result as any).modelUsed || providerInfo;
      const responseCost = (result as any).costUsd || (result as any).cost || 0;
      const turnsUsed = (result as any).turns || 1;
      const toolCount = (result as any).toolsUsed?.length || toolProgressLog.length || 0;
      if (modelUsed || responseCost) {
        const costStr = responseCost > 0 ? `$${Number(responseCost).toFixed(4)}` : 'free';
        console.log(chalk.gray(`  ⚡ ${modelUsed} · ${turnsUsed} turn${turnsUsed > 1 ? 's' : ''} · ${toolCount} tool${toolCount !== 1 ? 's' : ''} · ${costStr}`));
      }
      if (Array.isArray((result as any).timeline) && (result as any).timeline.length > 0) {
        console.log(chalk.gray('\n  Timeline'));
        for (const step of (result as any).timeline) {
          console.log(chalk.gray(`  - ${step.phase} @ ${step.ts}`));
        }
      }

      const edits = await orchestrator.parseAndApplyToSandbox(responseText);
      if (edits.length > 0) {
        console.log(chalk.yellow(`\n  ✓ ${edits.length} file(s) changed in sandbox`));

        // Animated colored diff preview (premium UX)
        try {
          const activeBranch = sandbox.getActiveBranch();
          if (sandbox.hasChanges(activeBranch)) {
            const rawPreview = sandbox.preview(activeBranch);
            if (rawPreview && rawPreview.length < 5000) { // Only show inline for reasonable diffs
              console.log(chalk.blue(`\n  ┌─ Diff Preview`));
              const diffLines = rawPreview.split('\n');
              for (const line of diffLines) {
                let colored: string;
                if (line.startsWith('+++') || line.startsWith('---')) colored = chalk.bold(line);
                else if (line.startsWith('+')) colored = chalk.green(line);
                else if (line.startsWith('-')) colored = chalk.red(line);
                else if (line.startsWith('@@')) colored = chalk.cyan(line);
                else if (line.startsWith('diff') || line.startsWith('index')) colored = chalk.gray(line);
                else colored = line;
                console.log(`  ${colored}`);
                // Animated rendering — slight delay for premium feel (only in TTY)
                if (process.stdout.isTTY) {
                  await new Promise(r => setTimeout(r, 8));
                }
              }
              console.log(chalk.blue(`  └─`));
            }
          }
        } catch {
          // Diff preview is best-effort
        }

        const shouldAutoApply = replState.autoApply || behavior.autoApply;
        await recordReplEvent('autopilot_decision', {
          mode: replState.mode,
          enabled: shouldAutoApply,
          reason: replState.mode === 'autopilot' ? 'mode-autopilot' : (replState.autoApply ? 'auto-apply-toggle' : 'disabled'),
          edits: edits.length
        });
        if (shouldAutoApply) {
          try {
            const activeBranch = sandbox.getActiveBranch();
            const paths = sandbox.getPendingPaths(activeBranch);
            const policy = getExecutionPolicy();
            const report = await analyzeBlastRadius(projectDir, { changedFiles: paths });
            if (isRiskBlocked(report.risk, policy.riskThreshold, policy.forceAutoApply)) {
              const patchRisk = scorePatchRisk({
                blastRadius: report,
                changedFiles: paths.length
              });
              await recordReplEvent('autopilot_apply', {
                mode: replState.mode,
                success: false,
                blockedByRisk: true,
                risk: report.risk,
                threshold: policy.riskThreshold,
                confidence: patchRisk.confidence
              });
              console.log(chalk.red(`  ✗ Auto-apply blocked by risk gate (${report.risk} >= ${policy.riskThreshold})`));
              console.log(chalk.gray('  Use /preview and /apply, or set CREW_FORCE_AUTO_APPLY=true to override.'));
              console.log();
              isProcessing = false;
              rl.prompt();
              return;
            }
            await sandbox.apply(activeBranch);
            await recordReplEvent('autopilot_apply', {
              mode: replState.mode,
              success: true,
              paths
            });
            console.log(chalk.green(`  ✓ Auto-applied to: ${paths.join(', ')}`));
          } catch (applyErr) {
            await recordReplEvent('autopilot_apply', {
              mode: replState.mode,
              success: false,
              error: (applyErr as Error).message
            });
            console.log(chalk.red(`  ✗ Auto-apply failed: ${(applyErr as Error).message}`));
          }
        } else {
          console.log(chalk.gray('  Type /preview to review or /apply to write to disk'));
        }
        console.log();
      }

      const cost = await session.loadCost();
      console.log(chalk.gray(`  Session cost: $${cost.totalUsd.toFixed(4)}\n`));

      isProcessing = false;
      rl.prompt();
    } catch (err) {
      stopSpinner();
      console.log(chalk.red(`\n  ✗ Error: ${(err as Error).message}\n`));
      await session.appendHistory({
        type: 'repl_error',
        task: trimmed,
        error: (err as Error).message
      });
      isProcessing = false;
      rl.prompt();
    }
  });

  rl.on('close', async () => {
    await recordReplEvent('session_closed', {
      mode: replState.mode
    });
    if (checkpointEnabled) {
      try {
        await checkpoints.finish(replRunId, 'completed');
      } catch {
        // Best-effort checkpoint close.
      }
    }
    if (process.stdin.isTTY) {
      process.stdin.off('keypress', keypressListener as any);
    }
    console.log(chalk.cyan('\n  Session saved to .crew/ — run "crew repl" to continue.\n'));
    // Allow readline/inquirer handles to close naturally; avoid forced exit races.
  });
}
