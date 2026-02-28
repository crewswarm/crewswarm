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
      const dispatchPayload = {
        agent: agentName,
        task: taskWithContext,
        sessionId: options.sessionId || 'crew-cli',
        projectDir,
        // Forward optional execution controls for gateway direct/bypass paths.
        model: options.model,
        engine: options.engine,
        direct: Boolean(options.direct),
        bypass: Boolean(options.bypass),
        gatewayMode: options.gatewayMode,
        session: {
          id: options.sessionId || 'crew-cli',
          source: 'crew-cli',
          timestamp: new Date().toISOString()
        }
      };

      // Get auth token from config
      const token = this.getAuthToken();
      const headers = { 'Content-Type': 'application/json' };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const dispatchResponse = await fetch(`${crewLeadUrl}/api/dispatch`, {
        method: 'POST',
        headers,
        body: JSON.stringify(dispatchPayload)
      });

      if (!dispatchResponse.ok) {
        const raw = await dispatchResponse.text();
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }
        const baseMessage = parsed?.error || raw || `Gateway returned ${dispatchResponse.status}`;
        throw new Error(
          `${baseMessage}${this.getDispatchErrorHint(baseMessage, options)}`
        );
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
      const result = await this.pollTaskStatus(crewLeadUrl, taskId, timeout, options);

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

  getDispatchErrorHint(message, options = {}) {
    const text = String(message || '').toLowerCase();
    const hints = [];
    if (text.includes('429') || text.includes('rate limit') || text.includes('too many requests')) {
      hints.push('rate-limited upstream; retry with backoff or switch model');
    }
    if (text.includes('missing model') || text.includes('model required') || text.includes('--model')) {
      hints.push('set an explicit model (e.g. --model anthropic/claude-3-5-sonnet)');
    }
    if (
      (text.includes('exit code 1') || text.includes('code 1')) &&
      (text.includes('cursor') || options.engine === 'cursor' || options.direct || options.bypass)
    ) {
      hints.push('Cursor CLI likely failed; verify cursor auth/env and pass --model explicitly');
    }
    return hints.length ? ` (hint: ${hints.join('; ')})` : '';
  }

  async pollTaskStatus(gatewayUrl, taskId, timeoutMs, options = {}) {
    const startTime = Date.now();
    const pollInterval = 2000; // 2 seconds

    const token = this.getAuthToken();
    const headers = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    while (Date.now() - startTime < timeoutMs) {
      try {
        const statusResponse = await fetch(`${gatewayUrl}/api/status/${taskId}`, {
          headers
        });

        if (!statusResponse.ok) {
          throw new Error(`Status check failed: ${statusResponse.status}`);
        }

        const status = await statusResponse.json();

        if (status.status === 'done') {
          return status.result || 'Task completed';
        }

        if (status.status === 'error') {
          const baseError = status.error || status.result || 'Task failed';
          const fatal = new Error(`${baseError}${this.getDispatchErrorHint(baseError, options)}`);
          fatal.fatal = true;
          throw fatal;
        }

        // Still pending, wait before polling again
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      } catch (error) {
        if (error && error.fatal) {
          throw error;
        }
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

  getAuthToken() {
    // Try to read from config (rt.authToken path)
    const config = this.config.getAll();
    return config?.rt?.authToken || null;
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
    const url = `${crewLeadUrl}/api/skills/${name}/run`;

    try {
      const token = this.getAuthToken();
      const headers = { 'Content-Type': 'application/json' };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(params)
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
      throw new Error(`Unable to call skill "${name}": ${error.message}`);
    }
  }
}
