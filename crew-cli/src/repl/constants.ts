/**
 * REPL constants, types, and stateless helper functions.
 *
 * Extracted from src/repl/index.ts to keep the main REPL entry point lean.
 * All items here are pure / side-effect-free (apart from console.log in
 * print* helpers) and have zero closure dependencies on REPL session state.
 */

import { existsSync, readFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import chalk from 'chalk';
import type { RepoConfig } from '../config/repo-config.js';
import type { AgentRouter } from '../agent/router.js';
import type { SessionManager } from '../session/manager.js';
import type { Orchestrator } from '../orchestrator/index.js';
import type { Sandbox } from '../sandbox/index.js';
import type { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// ASCII banner
// ---------------------------------------------------------------------------

export const BANNER = `
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

// ---------------------------------------------------------------------------
// Model / engine / mode lists
// ---------------------------------------------------------------------------

export const AVAILABLE_MODELS = [
  'deepseek-chat', 'gemini-2.0-flash-exp', 'gemini-2.5-flash',
  'claude-sonnet-4.5', 'grok-4-fast', 'gpt-4o'
];

export const AVAILABLE_ENGINES = ['auto', 'cursor', 'claude', 'gemini', 'codex', 'opencode', 'crew-cli'];

export type ReplMode = 'manual' | 'assist' | 'autopilot';
export const REPL_MODE_ORDER: ReplMode[] = ['manual', 'assist', 'autopilot'];

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

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

export interface ReplState {
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

export interface ModelSummary {
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

export interface RepoBootstrap {
  projectDir: string;
  topEntries: string[];
  docs: string[];
  keyFiles: string[];
  readmeSummary: string;
}

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

export function readJsonFile(filePath: string): any | null {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function buildModelSummary(projectDir: string, state: ReplState): ModelSummary {
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
  const agentModels: string[] = Array.from(
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

export function printModelSummary(summary: ModelSummary) {
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

export async function buildRepoBootstrap(projectDir: string): Promise<RepoBootstrap> {
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

export function printSystemSummary(summary: ModelSummary, bootstrap: RepoBootstrap) {
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

export function answerLocalMetaQuestion(input: string, summary: ModelSummary): string | null {
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

export function answerFromBootstrap(input: string, summary: ModelSummary, bootstrap: RepoBootstrap): string | null {
  const lower = input.trim().toLowerCase();
  if (!lower) return null;

  if (
    /\b(how does this system work|explain (the )?(system|architecture)|what is crew-cli|tell me about crew-cli)\b/.test(lower)
  ) {
    const docs = bootstrap.docs.slice(0, 5).join(', ') || '(no docs indexed)';
    const keys = bootstrap.keyFiles.slice(0, 6).join(', ') || '(no key files found)';
    return [
      `crewswarm CLI is a multi-layer orchestrator in ${summary.mode} mode.`,
      `L1 chat runs on ${summary.replModel}/${summary.replEngine}; L2 uses router=${summary.routerProvider} and executor=${summary.executorProvider}; L3 uses configured worker/agent models.`,
      `Key repo files: ${keys}.`,
      `Docs index snapshot: ${docs}.`,
      `Use /system for full stack summary and /models-config for exact model/provider config.`
    ].join(' ');
  }

  // Only answer questions *about* file access capabilities, not requests to write/read files
  if (/\b(how|can|does).*(read|write|file access|filesystem|permissions)\b/.test(lower) ||
      /\b(file access|filesystem|permissions|capabilities)\b/.test(lower)) {
    if (summary.mode === 'standalone') {
      return 'Standalone mode has local read/write through orchestrator + sandbox. Edits stage in sandbox first, then /apply writes to disk.';
    }
    return 'Connected mode executes through gateway/agents; file operations happen via agent tools and still stage through sandbox workflow on this CLI.';
  }

  return null;
}

export function printHelp(uiMode: 'repl' | 'tui' = 'repl') {
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
  console.log('    /model [name]      Benchmark table or set L1 chat model');
  console.log('    /stack             Show full L1/L2/L3 model stack');
  console.log('    /stack l1|l2|l3 <name>  Set model per tier');
  console.log('    /engine <name>     Switch engine (auto|cursor|claude|gemini|codex|crew-cli)');
  console.log('    /mode [name]       Cycle mode (manual/assist/autopilot)');
  console.log('    Shift+Tab          Cycle REPL mode');
  console.log('    /auto-apply        Toggle auto-apply sandbox changes');
  console.log('    /verbose           Toggle verbose routing output\n');

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

export function modeBehavior(mode: ReplMode) {
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

export function applySlashAlias(input: string, aliases: Record<string, string>): string {
  if (!input.startsWith('/')) return input;
  const [cmd, ...rest] = input.split(/\s+/);
  const replacement = aliases[cmd];
  if (!replacement) return input;
  const normalized = replacement.startsWith('/') ? replacement : `/${replacement}`;
  return [normalized, ...rest].join(' ').trim();
}

export async function renderBannerAnimated(banner: string): Promise<void> {
  const lines = banner.split('\n');
  for (const line of lines) {
    process.stdout.write(`${chalk.cyan(line)}\n`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

export function nextMode(current: ReplMode): ReplMode {
  const idx = REPL_MODE_ORDER.indexOf(current);
  if (idx < 0 || idx === REPL_MODE_ORDER.length - 1) return REPL_MODE_ORDER[0];
  return REPL_MODE_ORDER[idx + 1];
}

export function buildPrompt(state: ReplState, isProcessing: boolean, uiMode: 'repl' | 'tui' = 'repl'): string {
  const prefix = uiMode === 'tui' ? 'crew-tui' : 'crew';
  const mode = state.mode;
  if (isProcessing) return chalk.gray(`${prefix}(${mode},busy)> `);
  if (mode === 'autopilot') return chalk.magenta(`${prefix}(${mode})> `);
  if (mode === 'assist') return chalk.cyan(`${prefix}(${mode})> `);
  return chalk.green(`${prefix}(${mode})> `);
}

export function printTuiScaffold() {
  console.log(chalk.blue('\n┌─[ TUI LAYOUT ]─────────────────────────────────────────────────────────┐'));
  console.log(chalk.white('│ Chat + Commands share the same runtime as REPL (no orchestration fork). │'));
  console.log(chalk.white('│ Panels: status/banner at top, responses inline, sandbox + cost summaries.│'));
  console.log(chalk.white('│ Keys: Shift+Tab mode cycle, /help commands, /preview /apply /trace.      │'));
  console.log(chalk.blue('└───────────────────────────────────────────────────────────────────────────┘\n'));
}
