import { EventEmitter } from 'events';
import { Logger } from '../utils/logger.js';
import { getProjectContext } from '../context/git.js';

export class AgentRouter extends EventEmitter {
  constructor(config, toolManager) {
    super();
    this.config = config;
    this.toolManager = toolManager;
    this.logger = new Logger();
    this.agents = new Map();
  }

  async dispatch(agentName, task, options = {}) {
    if (!agentName || !task) {
      throw new Error('Agent name and task are required');
    }

    this.logger.info(`Routing task to agent: ${agentName}`);

    const timeout = parseInt(options.timeout || '300000', 10);
    const crewLeadUrl = options.gateway || this.config.get('crewLeadUrl') || 'http://localhost:5010';
    const projectDir = options.project || process.cwd();

    try {
      const context = options.injectGitContext === false
        ? ''
        : await getProjectContext(projectDir);
      const taskWithContext = context ? `${task}\n\n${context}` : task;

      // Dispatch to CrewSwarm gateway
      const dispatchResponse = await fetch(`${crewLeadUrl}/api/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: agentName,
          task: taskWithContext,
          sessionId: options.sessionId || 'crew-cli',
          projectDir
        })
      });

      if (!dispatchResponse.ok) {
        const error = await dispatchResponse.json();
        throw new Error(error.error || `Gateway returned ${dispatchResponse.status}`);
      }

      const { taskId } = await dispatchResponse.json();

      if (!taskId) {
        this.logger.warn('No taskId returned - agent may be using fallback mode');
        return {
          success: true,
          agent: agentName,
          task,
          result: 'Task dispatched (no taskId - check RT Messages tab)',
          timestamp: new Date().toISOString()
        };
      }

      // Poll for completion
      this.logger.info(`Polling for task completion (taskId: ${taskId})`);
      const result = await this.pollTaskStatus(crewLeadUrl, taskId, timeout);

      return {
        success: true,
        agent: agentName,
        task,
        taskId,
        result,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      this.logger.error(`Dispatch failed: ${error.message}`);
      throw error;
    }
  }

  async pollTaskStatus(gatewayUrl, taskId, timeoutMs) {
    const startTime = Date.now();
    const pollInterval = 2000; // 2 seconds

    while (Date.now() - startTime < timeoutMs) {
      try {
        const statusResponse = await fetch(`${gatewayUrl}/api/status/${taskId}`);

        if (!statusResponse.ok) {
          throw new Error(`Status check failed: ${statusResponse.status}`);
        }

        const status = await statusResponse.json();

        if (status.status === 'done') {
          return status.result || 'Task completed';
        }

        if (status.status === 'error') {
          throw new Error(status.error || 'Task failed');
        }

        // Still pending, wait before polling again
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      } catch (error) {
        // Log but continue polling unless timeout
        if (Date.now() - startTime >= timeoutMs) {
          throw new Error(`Timeout waiting for ${taskId} (${timeoutMs}ms)`);
        }
      }
    }

    throw new Error(`Timeout waiting for ${taskId} (${timeoutMs}ms)`);
  }

  async listAgents() {
    const crewLeadUrl = this.config.get('crewLeadUrl') || 'http://localhost:5010';

    try {
      const response = await fetch(`${crewLeadUrl}/status`);

      if (!response.ok) {
        this.logger.warn('Failed to fetch agents from gateway, returning defaults');
        return this.getDefaultAgents();
      }

      const status = await response.json();
      const agents = (status.agents || []).map(name => ({
        name,
        role: this.getAgentRole(name),
        status: 'online'
      }));

      return agents.length > 0 ? agents : this.getDefaultAgents();
    } catch (error) {
      this.logger.warn(`Gateway not reachable: ${error.message}`);
      return this.getDefaultAgents();
    }
  }

  getDefaultAgents() {
    return [
      { name: 'crew-coder', role: 'Full Stack Coder', status: 'unknown' },
      { name: 'crew-qa', role: 'Quality Assurance', status: 'unknown' },
      { name: 'crew-main', role: 'Coordinator', status: 'unknown' },
      { name: 'crew-fixer', role: 'Bug Fixer', status: 'unknown' },
      { name: 'crew-frontend', role: 'Frontend Specialist', status: 'unknown' },
      { name: 'crew-coder-back', role: 'Backend Specialist', status: 'unknown' }
    ];
  }

  getAgentRole(agentName) {
    const roles = {
      'crew-coder': 'Full Stack Coder',
      'crew-coder-front': 'Frontend Specialist',
      'crew-coder-back': 'Backend Specialist',
      'crew-qa': 'Quality Assurance',
      'crew-fixer': 'Bug Fixer',
      'crew-frontend': 'UI/UX Specialist',
      'crew-main': 'Coordinator',
      'crew-pm': 'Product Manager',
      'crew-security': 'Security Auditor',
      'crew-copywriter': 'Content Writer'
    };
    return roles[agentName] || 'Agent';
  }

  async getStatus() {
    const crewLeadUrl = this.config.get('crewLeadUrl') || 'http://localhost:5010';

    try {
      const response = await fetch(`${crewLeadUrl}/status`);

      if (!response.ok) {
        return {
          agentsOnline: 0,
          tasksActive: 0,
          rtBusStatus: 'disconnected',
          gateway: 'unreachable'
        };
      }

      const status = await response.json();

      return {
        agentsOnline: (status.agents || []).length,
        tasksActive: 0,
        rtBusStatus: status.rtConnected ? 'connected' : 'disconnected',
        gateway: 'connected',
        model: status.model
      };
    } catch (error) {
      return {
        agentsOnline: 0,
        tasksActive: 0,
        rtBusStatus: 'error',
        gateway: `error: ${error.message}`
      };
    }
  }

  async callSkill(name, params = {}, options = {}) {
    if (!name) {
      throw new Error('Skill name is required');
    }

    const crewLeadUrl = options.gateway || this.config.get('crewLeadUrl') || 'http://localhost:5010';
    const endpoints = [
      `${crewLeadUrl}/api/skill`,
      `${crewLeadUrl}/api/skills/call`
    ];

    let lastError = null;

    for (const url of endpoints) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            skill: name,
            params
          })
        });

        if (!response.ok) {
          let errorBody = null;
          try {
            errorBody = await response.json();
          } catch {
            errorBody = null;
          }
          const message = errorBody?.error || `Skill call failed (${response.status})`;
          throw new Error(message);
        }

        const result = await response.json();
        return {
          success: true,
          skill: name,
          result,
          timestamp: new Date().toISOString()
        };
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error(`Unable to call skill "${name}": ${lastError?.message || 'unknown error'}`);
  }
}
