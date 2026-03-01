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

  // Check if gateway is online with auth
  try {
    const headers: Record<string, string> = {};
    const authToken = process.env.CREW_AUTH_TOKEN;
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1000); // 1 second timeout

    const healthCheck = await fetch(`${status.gatewayUrl}/api/health`, {
      headers,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    status.online = healthCheck.ok;
    
    // Try to get real stats from gateway
    if (healthCheck.ok) {
      try {
        const statsResponse = await fetch(`${status.gatewayUrl}/api/stats`, {
          headers,
          signal: AbortSignal.timeout(2000)
        });
        if (statsResponse.ok) {
          const stats = await statsResponse.json();
          status.activeAgents = stats.activeAgents || status.activeAgents;
          status.queuedTasks = stats.queuedTasks || status.queuedTasks;
          status.runningTasks = stats.runningTasks || status.runningTasks;
          if (stats.models && Array.isArray(stats.models)) {
            status.models = stats.models;
          }
        }
      } catch {
        // Fall back to local detection
      }
    }
  } catch {
    status.online = false;
  }

  // Get active agents (check running processes)
  try {
    const ps = execSync('ps aux | grep -E "crew-|gateway-bridge" | grep -v grep | wc -l', { encoding: 'utf8' });
    status.activeAgents = parseInt(ps.trim(), 10) || 0;
  } catch {
    status.activeAgents = 0;
  }

  // Check for queued tasks (autofix queue)
  try {
    const queuePath = join(process.cwd(), '.crew', 'autofix', 'queue.json');
    if (existsSync(queuePath)) {
      const queue = JSON.parse(require('fs').readFileSync(queuePath, 'utf8'));
      status.queuedTasks = queue.jobs?.filter((j: any) => j.status === 'pending').length || 0;
      status.runningTasks = queue.jobs?.filter((j: any) => j.status === 'running').length || 0;
    }
  } catch {
    status.queuedTasks = 0;
  }

  // Get configured models
  try {
    const configPath = join(homedir(), '.crewswarm', 'crewswarm.json');
    if (existsSync(configPath)) {
      const config = JSON.parse(require('fs').readFileSync(configPath, 'utf8'));
      const providers = config.providers || config.models?.providers || {};
      status.models = Object.keys(providers).filter(k => providers[k]?.apiKey);
    }
  } catch {
    status.models = ['local'];
  }

  return status;
}

export function renderStatusDashboard(status: StatusInfo): string {
  const { online, activeAgents, queuedTasks, runningTasks, models } = status;
  
  // Colors
  const border = chalk.cyan;
  const label = chalk.gray;
  const value = chalk.white.bold;
  const online_color = online ? chalk.green : chalk.red;
  const accent = chalk.blue;

  // Progress bar for agents (assuming max 30 for visual purposes)
  const maxAgents = 30;
  const agentPercent = Math.min(100, Math.floor((activeAgents / maxAgents) * 100));
  const filled = Math.floor(agentPercent / 10);
  const empty = 10 - filled;
  const progressBar = chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));

  const lines = [
    border('┌─[ CREWSWARM :: ORCHESTRATION LAYER ]────────────────────────┐'),
    '',
    `   ${label('CORE')}      : ${value('ROUTER')} 🧠`,
    `   ${label('REASONING')}: ${value('PLANNER')} 🧭`,
    `   ${label('EXECUTION')}: ${value('WORKERS')} ⚡`,
    '',
    `   ${label('SYSTEM STATUS ')} : ${online_color(online ? 'ONLINE' : 'OFFLINE')}`,
    `   ${label('MODEL STACK   ')}: ${value(models.length > 0 ? models.join(' / ') : 'Not configured')}`,
    `   ${label('TASK PIPELINE ')}: ${value('REALTIME')}`,
    '',
    `   ${accent('Swarm Status')}   : ${progressBar} ${agentPercent}%`,
    `   ${accent('Active Agents')}  : ${value(activeAgents.toString())}`,
    `   ${accent('Task Queue')}     : ${value(queuedTasks + ' pending')}${runningTasks > 0 ? `, ${runningTasks} running` : ''}`,
    '',
    `   ${chalk.italic.gray('"One idea. One Build. One Crew."')}`,
    '',
    border('└──────────────────────────────────────────────────────────────┘')
  ];

  return lines.join('\n');
}

export async function displayStatus(): Promise<void> {
  const status = await getSystemStatus();
  console.log('\n' + renderStatusDashboard(status) + '\n');
}
