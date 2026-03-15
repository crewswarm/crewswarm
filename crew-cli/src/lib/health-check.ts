import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from './logger';

const execAsync = promisify(exec);

export interface HealthStatus {
  agents: Record<string, AgentStatus>;
  services: Record<string, ServiceStatus>;
  timestamp: number;
}

export interface AgentStatus {
  id: string;
  name: string;
  status: 'online' | 'offline' | 'error';
  lastSeen?: number;
  error?: string;
}

export interface ServiceStatus {
  name: string;
  status: 'healthy' | 'unhealthy' | 'unknown';
  port?: number;
  error?: string;
}

export async function healthCheck(): Promise<HealthStatus> {
  const timestamp = Date.now();
  const agents: Record<string, AgentStatus> = {};
  const services: Record<string, ServiceStatus> = {};
  
  // Check RT bus
  try {
    await fetch('http://localhost:18889/status');
    services.rtBus = { name: 'RT Bus', status: 'healthy', port: 18889 };
  } catch (error) {
    services.rtBus = { name: 'RT Bus', status: 'unhealthy', port: 18889, error: String(error) };
  }
  
  // Check crew-lead
  try {
    await fetch('http://localhost:5010/health');
    services.crewLead = { name: 'Crew Lead', status: 'healthy', port: 5010 };
  } catch (error) {
    services.crewLead = { name: 'Crew Lead', status: 'unhealthy', port: 5010, error: String(error) };
  }
  
  // Check dashboard
  try {
    await fetch('http://localhost:4319/health');
    services.dashboard = { name: 'Dashboard', status: 'healthy', port: 4319 };
  } catch (error) {
    services.dashboard = { name: 'Dashboard', status: 'unhealthy', port: 4319, error: String(error) };
  }
  
  // Check MCP server
  try {
    await fetch('http://localhost:5020/health');
    services.mcpServer = { name: 'MCP Server', status: 'healthy', port: 5020 };
  } catch (error) {
    services.mcpServer = { name: 'MCP Server', status: 'unhealthy', port: 5020, error: String(error) };
  }
  
  // Check agent processes
  const agentProcesses = [
    { id: 'crew-main', name: 'crew-main', pattern: 'gateway-bridge.*crew-main' },
    { id: 'crew-coder', name: 'crew-coder', pattern: 'gateway-bridge.*crew-coder' },
    { id: 'crew-pm', name: 'crew-pm', pattern: 'gateway-bridge.*crew-pm' },
    { id: 'crew-qa', name: 'crew-qa', pattern: 'gateway-bridge.*crew-qa' },
    { id: 'crew-fixer', name: 'crew-fixer', pattern: 'gateway-bridge.*crew-fixer' },
    { id: 'crew-security', name: 'crew-security', pattern: 'gateway-bridge.*crew-security' },
    { id: 'crew-coder-front', name: 'crew-coder-front', pattern: 'gateway-bridge.*crew-coder-front' },
    { id: 'crew-coder-back', name: 'crew-coder-back', pattern: 'gateway-bridge.*crew-coder-back' },
    { id: 'crew-github', name: 'crew-github', pattern: 'gateway-bridge.*crew-github' },
    { id: 'crew-frontend', name: 'crew-frontend', pattern: 'gateway-bridge.*crew-frontend' },
    { id: 'crew-copywriter', name: 'crew-copywriter', pattern: 'gateway-bridge.*crew-copywriter' },
    { id: 'crew-telegram', name: 'crew-telegram', pattern: 'gateway-bridge.*crew-telegram' },
    { id: 'crew-orchestrator', name: 'crew-orchestrator', pattern: 'gateway-bridge.*crew-orchestrator' },
    { id: 'crew-seo', name: 'crew-seo', pattern: 'gateway-bridge.*crew-seo' },
    { id: 'crew-researcher', name: 'crew-researcher', pattern: 'gateway-bridge.*crew-researcher' },
    { id: 'crew-architect', name: 'crew-architect', pattern: 'gateway-bridge.*crew-architect' },
    { id: 'crew-whatsapp', name: 'crew-whatsapp', pattern: 'gateway-bridge.*crew-whatsapp' },
    { id: 'crew-ml', name: 'crew-ml', pattern: 'gateway-bridge.*crew-ml' }
  ];
  
  for (const agent of agentProcesses) {
    try {
      const { stdout } = await execAsync(`ps aux | grep "${agent.pattern}" | grep -v grep`);
      if (stdout.trim()) {
        agents[agent.id] = { 
          id: agent.id, 
          name: agent.name, 
          status: 'online',
          lastSeen: timestamp
        };
      } else {
        agents[agent.id] = { 
          id: agent.id, 
          name: agent.name, 
          status: 'offline'
        };
      }
    } catch (error) {
      agents[agent.id] = { 
        id: agent.id, 
        name: agent.name, 
        status: 'error',
        error: String(error)
      };
    }
  }
  
  return { agents, services, timestamp };
}
