import { Logger } from '../utils/logger.js';

export class ToolManager {
  constructor(config) {
    this.config = config;
    this.logger = new Logger();
    this.tools = new Map();
  }

  async initialize() {
    this.logger.info('Initializing tool manager');
    
    // TODO: Load and register available tools
    // For now, initialize with basic tools
    this.registerTool('file', {
      name: 'file',
      description: 'File operations',
      handler: this.handleFileTool.bind(this)
    });

    this.registerTool('shell', {
      name: 'shell',
      description: 'Shell command execution',
      handler: this.handleShellTool.bind(this)
    });
  }

  registerTool(name, tool) {
    this.tools.set(name, tool);
    this.logger.debug(`Registered tool: ${name}`);
  }

  async executeTool(name, params) {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }

    try {
      this.logger.debug(`Executing tool: ${name}`);
      return await tool.handler(params);
    } catch (error) {
      this.logger.error(`Tool execution failed: ${name}`, error);
      throw error;
    }
  }

  async handleFileTool(params) {
    // Basic file tool implementation
    const { action, path, content } = params || {};

    if (!action) {
      throw new Error('File tool requires action parameter');
    }

    const fs = await import('node:fs/promises');

    switch (action) {
      case 'read':
        if (!path) throw new Error('File read requires path parameter');
        const data = await fs.readFile(path, 'utf8');
        return { success: true, operation: 'file', action: 'read', data };

      case 'write':
        if (!path || content === undefined) {
          throw new Error('File write requires path and content parameters');
        }
        await fs.writeFile(path, content, 'utf8');
        return { success: true, operation: 'file', action: 'write', path };

      case 'exists':
        if (!path) throw new Error('File exists check requires path parameter');
        try {
          await fs.access(path);
          return { success: true, operation: 'file', action: 'exists', exists: true };
        } catch {
          return { success: true, operation: 'file', action: 'exists', exists: false };
        }

      default:
        throw new Error(`Unsupported file action: ${action}`);
    }
  }

  async handleShellTool(params) {
    // Basic shell tool implementation
    const { command, cwd } = params || {};

    if (!command) {
      throw new Error('Shell tool requires command parameter');
    }

    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);

    try {
      const options = cwd ? { cwd } : {};
      const { stdout, stderr } = await execAsync(command, options);
      return {
        success: true,
        operation: 'shell',
        command,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      };
    } catch (error) {
      return {
        success: false,
        operation: 'shell',
        command,
        error: error.message,
        stdout: error.stdout || '',
        stderr: error.stderr || ''
      };
    }
  }

  getAvailableTools() {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.name,
      description: tool.description
    }));
  }
}
