import chalk from 'chalk';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Dynamic crewswarm status dashboard
 * Shows REAL system information, not hardcoded values
 */

interface StatusInfo {
  online: boolean;
  activeAgents: number;
  gatewayReachable: boolean;
  queuedTasks: number;
  runningTasks: number;
  models: string[];
  gatewayUrl: string;
  version: string;
}

interface StatusRenderOptions {
  interfaceMode?: 'connected' | 'standalone';
}

export async function getSystemStatus(): Promise<StatusInfo> {
  const status: StatusInfo = {
    online: false,
    activeAgents: 0,
    gatewayReachable: false,
    queuedTasks: 0,
    runningTasks: 0,
    models: [],
    gatewayUrl: process.env.CREW_LEAD_URL || 'http://127.0.0.1:5010',
    version: '0.1.0-alpha'
  };

  // Check which providers have API keys (from crewswarm.json + env vars)
  const providers: string[] = [];
  try {
    const { readFileSync } = await import('node:fs');
    const cfgPath = `${homedir()}/.crewswarm/crewswarm.json`;
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    const providerEntries = cfg.providers || {};
    for (const [id, p] of Object.entries(providerEntries) as [string, any][]) {
      if (p.apiKey && String(p.apiKey).trim()) {
        providers.push(id);
      }
    }
  } catch { /* no config */ }
  // Also check env vars for providers not in config
  const envMap: Record<string, string> = {
    GEMINI_API_KEY: 'google', GOOGLE_API_KEY: 'google', GROQ_API_KEY: 'groq',
    XAI_API_KEY: 'xai', OPENAI_API_KEY: 'openai', ANTHROPIC_API_KEY: 'anthropic',
    DEEPSEEK_API_KEY: 'deepseek', MISTRAL_API_KEY: 'mistral', PERPLEXITY_API_KEY: 'perplexity',
    TOGETHER_API_KEY: 'together', FIREWORKS_API_KEY: 'fireworks', HUGGINGFACE_API_KEY: 'huggingface',
  };
  for (const [envKey, id] of Object.entries(envMap)) {
    if (process.env[envKey] && !providers.includes(id)) providers.push(id);
  }
  status.models = providers;
  status.online = providers.length > 0;

  // Check if gateway is reachable (optional, for connected mode)
  try {
    // Read auth token from ~/.crewswarm/config.json
    let authToken = '';
    try {
      const { readFileSync } = await import('node:fs');
      const { homedir } = await import('node:os');
      const cfg = JSON.parse(readFileSync(`${homedir()}/.crewswarm/config.json`, 'utf8'));
      authToken = cfg?.rt?.authToken || '';
    } catch { /* no config */ }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 800);
    const headers: Record<string, string> = {};
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const statusCheck = await fetch(`${status.gatewayUrl}/status`, {
      signal: controller.signal,
      headers
    });
    clearTimeout(timeoutId);
    if (statusCheck.ok) {
      status.gatewayReachable = true;
      const data = await statusCheck.json() as { agents?: unknown[] };
      status.activeAgents = Array.isArray(data.agents) ? data.agents.length : 1;
    }
  } catch {
    // Gateway not reachable — standalone mode only
  }

  return status;
}

export function renderStatusDashboard(status: StatusInfo, options: StatusRenderOptions = {}): string {
  const { online, activeAgents, gatewayReachable, models } = status;
  
  // Colors
  const border = chalk.cyan;
  const label = chalk.gray;
  const value = chalk.white.bold;
  const accent = chalk.blue;

  // Provider status bar
  const providerCount = models.length;
  const maxProviders = 24;
  const filled = Math.min(10, Math.floor((providerCount / maxProviders) * 10));
  const empty = 10 - filled;
  const progressBar = chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));

  const statusText = online ? chalk.green('READY') : chalk.red('NO API KEYS');
  const interfaceMode = options.interfaceMode || (gatewayReachable ? 'connected' : 'standalone');
  const interfaceText = interfaceMode === 'connected'
    ? chalk.green('CONNECTED')
    : chalk.gray('STANDALONE');
  const gatewayText = gatewayReachable
    ? chalk.green('AVAILABLE') + chalk.gray(activeAgents > 0 ? ` (${activeAgents} agents)` : '')
    : chalk.gray('UNREACHABLE');
  const modelStack = models.length > 0 ? models.join(' / ') : chalk.red('None — add API keys');

  const lines = [
    border('┌─[ CREW-CLI :: AGENTIC CODING ENGINE ]──────────────────────────┐'),
    '',
    `   ${label('STATUS')}     : ${statusText}`,
    `   ${label('INTERFACE')}  : ${interfaceText}`,
    `   ${label('GATEWAY')}    : ${gatewayText}`,
    `   ${label('PROVIDERS')}  : ${value(modelStack)}`,
    '',
    `   ${accent('Provider Coverage')}: ${progressBar} ${providerCount}/${maxProviders}`,
    '',
    `   ${chalk.italic.gray('"One idea. One Build. One Crew."')}`,
    '',
    border('└──────────────────────────────────────────────────────────────────┘')
  ];

  return lines.join('\n');
}

export async function displayStatus(options: StatusRenderOptions = {}): Promise<void> {
  const status = await getSystemStatus();
  console.log('\n' + renderStatusDashboard(status, options) + '\n');
}
