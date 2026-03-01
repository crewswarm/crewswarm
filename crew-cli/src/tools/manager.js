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

    this.registerTool('pty', {
      name: 'pty',
      description: 'Interactive PTY command execution',
      handler: this.handlePtyTool.bind(this)
    });

    this.registerTool('lsp', {
      name: 'lsp',
      description: 'Language server style type-check and completion',
      handler: this.handleLspTool.bind(this)
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

  async handlePtyTool(params) {
    const { command, cwd, timeoutMs } = params || {};
    if (!command) {
      throw new Error('PTY tool requires command parameter');
    }
    const { runPtyCommand } = await import('../pty/index.js');
    const result = await runPtyCommand(command, { cwd, timeoutMs });
    return {
      success: result.success,
      operation: 'pty',
      command,
      exitCode: result.exitCode,
      signal: result.signal,
      output: result.output
    };
  }

  async handleLspTool(params) {
    const { action, projectDir, file, files, line, column, limit, prefix } = params || {};
    if (!action) {
      throw new Error('LSP tool requires action parameter');
    }
    const { getCompletions, typeCheckProject } = await import('../lsp/index.js');
    if (action === 'check') {
      const diagnostics = typeCheckProject(projectDir || process.cwd(), files || []);
      return {
        success: true,
        operation: 'lsp',
        action,
        diagnostics
      };
    }
    if (action === 'complete') {
      if (!file || !line || !column) {
        throw new Error('LSP complete requires file, line, and column');
      }
      const completions = getCompletions(
        projectDir || process.cwd(),
        file,
        Number(line),
        Number(column),
        Number(limit || 50),
        String(prefix || '')
      );
      return {
        success: true,
        operation: 'lsp',
        action,
        completions
      };
    }
    throw new Error(`Unsupported lsp action: ${action}`);
  }

  getAvailableTools() {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.name,
      description: tool.description
    }));
  }
}
