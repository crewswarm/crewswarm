import chalk from 'chalk';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Dynamic CrewSwarm status dashboard
 * Shows REAL system information, not hardcoded values
 */

interface StatusInfo {
  online: boolean;
  activeAgents: number;
  queuedTasks: number;
  runningTasks: number;
  models: string[];
  gatewayUrl: string;
  version: string;
}

export async function getSystemStatus(): Promise<StatusInfo> {
  const status: StatusInfo = {
    online: false,
    activeAgents: 0,
    queuedTasks: 0,
    runningTasks: 0,
    models: [],
    gatewayUrl: process.env.CREW_LEAD_URL || 'http://127.0.0.1:5010',
    version: '0.1.0-alpha'
  };

  // Check which API keys are available (relevant for standalone mode)
  const providers: string[] = [];
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) providers.push('Gemini');
  if (process.env.GROQ_API_KEY) providers.push('Groq');
  if (process.env.XAI_API_KEY) providers.push('Grok');
  if (process.env.OPENAI_API_KEY) providers.push('OpenAI');
  if (process.env.ANTHROPIC_API_KEY) providers.push('Anthropic');
  if (process.env.DEEPSEEK_API_KEY) providers.push('DeepSeek');
  status.models = providers;
  status.online = providers.length > 0; // "online" if at least one provider is available

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
      const data = await statusCheck.json() as any;
      status.activeAgents = Array.isArray(data.agents) ? data.agents.length : 1;
    }
  } catch {
    // Gateway not reachable — standalone mode only
  }

  return status;
}

export function renderStatusDashboard(status: StatusInfo): string {
  const { online, activeAgents, models } = status;
  
  // Colors
  const border = chalk.cyan;
  const label = chalk.gray;
  const value = chalk.white.bold;
  const accent = chalk.blue;

  // Provider status bar
  const providerCount = models.length;
  const maxProviders = 6;
  const filled = Math.min(10, Math.floor((providerCount / maxProviders) * 10));
  const empty = 10 - filled;
  const progressBar = chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));

  const statusText = online ? chalk.green('READY') : chalk.red('NO API KEYS');
  const gatewayText = activeAgents > 0 
    ? chalk.green(`CONNECTED`) + chalk.gray(` (${activeAgents} agents)`)
    : chalk.gray('STANDALONE');
  const modelStack = models.length > 0 ? models.join(' / ') : chalk.red('None — add API keys');

  const lines = [
    border('┌─[ CREW-CLI :: AGENTIC CODING ENGINE ]──────────────────────────┐'),
    '',
    `   ${label('STATUS')}     : ${statusText}`,
    `   ${label('MODE')}       : ${gatewayText}`,
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

export async function displayStatus(): Promise<void> {
  const status = await getSystemStatus();
  console.log('\n' + renderStatusDashboard(status) + '\n');
}
