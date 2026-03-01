import { createInterface, emitKeypressEvents } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import chalk from 'chalk';
import inquirer from 'inquirer';
import type { RepoConfig } from '../config/repo-config.js';
import { AgentRouter } from '../agent/router.js';
import { SessionManager } from '../session/manager.js';
import { Orchestrator } from '../orchestrator/index.js';
import { Sandbox } from '../sandbox/index.js';
import { Logger } from '../utils/logger.js';
import { getProjectContext } from '../context/git.js';
import { collectMultiRepoContext } from '../multirepo/index.js';
import { AgentKeeper } from '../memory/agentkeeper.js';
import { CheckpointStore } from '../checkpoint/store.js';

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
  'deepseek-chat', 'gemini-2.0-flash-exp', 'gemini-2.5-flash',
  'claude-sonnet-4.5', 'grok-4-fast', 'gpt-4o'
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

  console.log(chalk.yellow.bold('  📁 Sandbox Commands:'));
  console.log('    /preview           Show pending file changes');
  console.log('    /apply             Write sandbox to disk');
  console.log('    /rollback          Discard all pending changes');
  console.log('    /branch            Interactive branch selector (use arrow keys)');
  console.log('    /branches          Same as /branch');
  console.log('    /undo              Undo last change\n');

  console.log(chalk.magenta.bold('  🎛️  Model & Engine:'));
  console.log('    /models            Interactive model selector (use arrow keys)');
  console.log('    /models-config     Show configured models/providers from local config');
  console.log('    /model <name>      Switch execution model directly');
  console.log('    /engines           Interactive engine selector (use arrow keys)');
  console.log('    /engine <name>     Switch engine directly (cursor|claude|gemini|auto)');
  console.log('    /mode [name]       Interactive mode selector or set directly');
  console.log('    Shift+Tab          Cycle REPL mode');
  console.log('    /auto-apply        Toggle auto-apply sandbox changes');
  console.log('    /verbose           Toggle verbose routing output');
  console.log('    /stack             Configure 3-tier LLM stack (router, executor, gateway)\n');

  console.log(chalk.green.bold('  🧠 Memory & LSP:'));
  console.log('    /memory [query]    Show memory stats or recall');
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
  const checkpoints = new CheckpointStore(projectDir);
  const sessionId = await session.getSessionId();
  const replRunId = `repl-${randomUUID()}`;

  // Interactive mode selection if not provided via CLI or config
  let selectedMode: ReplMode = (options.initialMode || repoConfig?.repl?.mode || 'manual') as ReplMode;
  
  if (!options.initialMode && !repoConfig?.repl?.mode && process.stdin.isTTY) {
    try {
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
    } catch {
      // User cancelled, use manual as fallback
      selectedMode = 'manual';
    }
  }

  const replState: ReplState = {
    model: String(repoConfig?.repl?.model || 'deepseek-chat'),
    engine: String(repoConfig?.repl?.engine || 'auto'),
    autoApply: Boolean(repoConfig?.repl?.autoApply),
    memoryMax: Number(repoConfig?.repl?.memoryMax ?? 5),
    mode: selectedMode,
    verbose: Boolean(repoConfig?.repl?.verbose || false),
    routerProvider: String(repoConfig?.repl?.routerProvider || 'grok'),
    executorProvider: String(repoConfig?.repl?.executorProvider || 'grok'),
    useGateway: Boolean(repoConfig?.repl?.useGateway || false)
  };
  const slashAliases = repoConfig?.slashAliases || {};
  const bannerEnabled = repoConfig?.repl?.bannerEnabled !== false;
  const bannerAnimated = repoConfig?.repl?.animatedBanner !== false;
  const bannerFirstLaunchOnly = repoConfig?.repl?.bannerFirstLaunchOnly === true; // Changed default to false
  const bannerSeenFile = join(projectDir, '.crew', 'repl-banner-seen');
  const replAuditPath = join(projectDir, '.crew', 'repl-events.jsonl');
  const shouldRenderBanner = bannerEnabled && (!bannerFirstLaunchOnly || !existsSync(bannerSeenFile));
  let auditSeq = 0;
  let checkpointEnabled = true;
  const repoBootstrap = await buildRepoBootstrap(projectDir);

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

  // Show dynamic status dashboard on REPL startup
  try {
    const { displayStatus } = await import('../status/dashboard.ts');
    await displayStatus();
  } catch (err) {
    // Silently fail if status dashboard can't be shown
  }

  let isProcessing = false;
  let isClosing = false;

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

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(replState, isProcessing, uiMode),
    terminal: true
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
      console.log(chalk.blue('\n╔══════════════════════════════════════════════════════════════╗'));
      console.log(chalk.blue('║                    CURRENT SETTINGS                          ║'));
      console.log(chalk.blue('╚══════════════════════════════════════════════════════════════╝\n'));
      console.log(chalk.cyan('  3-Tier Stack:'));
      console.log(`    Tier 1 (Router)  : ${chalk.green(replState.routerProvider)}`);
      console.log(`    Tier 2 (Executor): ${chalk.green(replState.executorProvider)}`);
      console.log(`    Tier 3 (Gateway) : ${replState.useGateway ? chalk.green('ENABLED') : chalk.gray('disabled')}\n`);
      console.log(chalk.cyan('  Session:'));
      console.log(`    Model: ${chalk.green(replState.model)}`);
      console.log(`    Engine: ${chalk.blue(replState.engine)}`);
      console.log(`    Mode: ${chalk.magenta(replState.mode)}`);
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

    if (command === '/models-config') {
      const summary = buildModelSummary(projectDir, replState);
      printModelSummary(summary);
      return true;
    }

    if (command === '/models') {
      try {
        const answer = await inquirer.prompt([
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
        console.log(chalk.red('\n  ✗ Provide a model name. Type /models to see options.\n'));
      } else {
        replState.model = modelName;
        console.log(chalk.green(`\n  ✓ Model set to: ${modelName}\n`));
      }
      return true;
    }

    if (command === '/engines') {
      try {
        const answer = await inquirer.prompt([
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
      try {
        console.log(chalk.blue('\n╔══════════════════════════════════════════════════════════════╗'));
        console.log(chalk.blue('║           3-TIER LLM STACK CONFIGURATION                     ║'));
        console.log(chalk.blue('╚══════════════════════════════════════════════════════════════╝\n'));

        const answers = await inquirer.prompt([
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
        try {
          const answer = await inquirer.prompt([
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
      rl.setPrompt(buildPrompt(replState, isProcessing, uiMode));
      await recordReplEvent('mode_change', { from, to: replState.mode, source: 'slash' });
      console.log(chalk.green(`\n  ✓ Mode set to: ${replState.mode}\n`));
      return true;
    }

    if (command === '/status') {
      const sess = await session.loadSession();
      const cost = await session.loadCost();
      const activeBranch = sandbox.getActiveBranch();
      const hasChanges = sandbox.hasChanges(activeBranch);

      console.log(chalk.blue('\n┌─ Session Status'));
      console.log(`│  History: ${sess.history.length} entries`);
      console.log(`│  Cost: ${chalk.green(`$${cost.totalUsd.toFixed(4)}`)}`);
      console.log(`│  Sandbox: ${chalk.yellow(activeBranch)} ${hasChanges ? chalk.yellow('(has changes)') : chalk.gray('(clean)')}`);
      console.log(`│  Model: ${chalk.green(replState.model)}`);
      console.log(`│  Engine: ${chalk.blue(replState.engine)}`);
      console.log(`│  Mode: ${chalk.magenta(replState.mode)}`);
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
        console.log(chalk.blue(`\n┌─ Sandbox Preview [${activeBranch}]`));
        console.log(logger.highlightDiff(sandbox.preview(activeBranch)));
        console.log('└─\n');
      }
      return true;
    }

    if (command === '/apply') {
      const activeBranch = sandbox.getActiveBranch();
      if (!sandbox.hasChanges(activeBranch)) {
        console.log(chalk.yellow('\n  No changes to apply.\n'));
      } else {
        try {
          const paths = sandbox.getPendingPaths(activeBranch);
          await sandbox.apply(activeBranch);
          console.log(chalk.green(`\n  ✓ Applied to: ${paths.join(', ')}\n`));
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
        const answer = await inquirer.prompt([
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
      const matches = await keeper.recall(query, replState.memoryMax, { preferSuccessful: true });
      if (matches.length === 0) {
        console.log(chalk.yellow(`\n  No memory matches for "${query}".\n`));
        return true;
      }
      console.log(chalk.blue(`\n--- Memory Recall: "${query}" (${matches.length} matches) ---\n`));
      for (const m of matches) {
        console.log(chalk.yellow(`[${m.score}] ${m.entry.tier} — ${m.entry.task.slice(0, 80)}`));
        const preview = m.entry.result.length > 120 ? `${m.entry.result.slice(0, 120)}...` : m.entry.result;
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

    let handled = false;
    try {
      handled = await handleSlashCommand(trimmed);
    } catch (err) {
      console.log(chalk.red(`\n  ✗ Command failed: ${(err as Error).message}\n`));
      if (!isClosing) rl.prompt();
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

    try {
      if (replState.verbose) {
        console.log(chalk.gray('  ⏳ Routing...'));
      }

      let taskInput = trimmed;
      const lower = trimmed.toLowerCase();
      if (/\b(switch|set|use).*(solo|standalone)\b/.test(lower)) {
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
      const bootstrapAnswer = answerFromBootstrap(trimmed, modelSummary, repoBootstrap);
      if (bootstrapAnswer) {
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

      if (replState.mode !== 'manual') {
        const recalls = await keeper.recall(trimmed, replState.memoryMax, { preferSuccessful: true });
        if (recalls.length > 0) {
          const memoryContext = await keeper.recallAsContext(trimmed, replState.memoryMax, { preferSuccessful: true });
          taskInput = `${trimmed}\n\n${memoryContext}`;
        }
      }

      const route = await orchestrator.route(taskInput);
      const agent = route.agent || 'crew-main';

      if (replState.verbose) {
        console.log(chalk.gray(`  → ${agent} (${route.decision})`));
      }

      if (route.decision === 'CHAT') {
        const responseText = route.response || 
          "I'm crew-cli, a multi-agent coding orchestrator. Ask me to build something, review code, or dispatch to specialists!";
        console.log(chalk.cyan('\n  ┌─ Response'));
        console.log(chalk.white(`  ${responseText}`));
        console.log('  └─\n');

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

        isProcessing = false;
        rl.prompt();
        return;
      }

      const dispatchOpts: any = {
        project: projectDir,
        sessionId: await session.getSessionId()
      };
      if (replState.model && replState.model !== 'auto') dispatchOpts.model = replState.model;
      if (replState.engine && replState.engine !== 'auto') dispatchOpts.engine = replState.engine;

      const standaloneMode = modelSummary.mode === 'standalone';
      const result = standaloneMode
        ? await orchestrator.executeLocally(route.task || taskInput, {
            model: dispatchOpts.model
          })
        : await router.dispatch(agent, taskInput, dispatchOpts);

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

      const responseText = String(result.result || '');
      console.log(chalk.cyan('\n  ┌─ Response'));
      logger.printWithHighlight(responseText);
      console.log('  └─');

      const edits = await orchestrator.parseAndApplyToSandbox(responseText);
      if (edits.length > 0) {
        console.log(chalk.yellow(`\n  ✓ ${edits.length} file(s) changed in sandbox`));

        const shouldAutoApply = replState.autoApply || replState.mode === 'autopilot';
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
    process.exit(0);
  });
}
