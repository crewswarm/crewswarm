// @ts-nocheck
import { IncomingMessage, ServerResponse } from 'http';
import { UnifiedServerOptions } from './server.js';

interface McpRequest {
  jsonrpc: string;
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface McpResponse {
  jsonrpc: string;
  id: string | number;
  result?: Record<string, unknown>;
  error?: {
    code: number;
    message: string;
  };
}

export async function handleMcpRequest(
  options: UnifiedServerOptions,
  body: McpRequest
): Promise<McpResponse> {
  const { method, params, id } = body;

  try {
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: {
              name: 'crew-cli',
              version: '1.0.0',
              description: 'crew-cli unified orchestration and sandbox tools'
            }
          }
        };

      case 'notifications/initialized':
      case 'initialized':
        // Notification - no response needed
        return { _skip: true } as any;

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: [
              {
                name: 'crew_route_task',
                description: 'Route a task through the unified orchestrator (L1→L2→L3)',
                inputSchema: {
                  type: 'object',
                  properties: {
                    task: { type: 'string', description: 'Task to execute' },
                    context: { type: 'string', description: 'Optional context' }
                  },
                  required: ['task']
                }
              },
              {
                name: 'crew_execute_code',
                description: 'Execute code generation task with sandbox isolation',
                inputSchema: {
                  type: 'object',
                  properties: {
                    task: { type: 'string', description: 'Code generation task' },
                    model: { type: 'string', description: 'Optional model override' }
                  },
                  required: ['task']
                }
              },
              {
                name: 'crew_sandbox_status',
                description: 'Get current sandbox state (pending changes, branch info)',
                inputSchema: {
                  type: 'object',
                  properties: {},
                  required: []
                }
              },
              {
                name: 'crew_sandbox_preview',
                description: 'Preview pending changes in sandbox',
                inputSchema: {
                  type: 'object',
                  properties: {},
                  required: []
                }
              },
              {
                name: 'crew_sandbox_apply',
                description: 'Apply pending sandbox changes to working directory',
                inputSchema: {
                  type: 'object',
                  properties: {
                    check: { type: 'string', description: 'Optional validation command (e.g. npm test)' }
                  },
                  required: []
                }
              },
              {
                name: 'crew_sandbox_rollback',
                description: 'Rollback sandbox to previous state',
                inputSchema: {
                  type: 'object',
                  properties: {},
                  required: []
                }
              },
              {
                name: 'crew_search_code',
                description: 'Search codebase with semantic/text search',
                inputSchema: {
                  type: 'object',
                  properties: {
                    query: { type: 'string', description: 'Search query' },
                    limit: { type: 'number', description: 'Max results' }
                  },
                  required: ['query']
                }
              },
              {
                name: 'crew_list_models',
                description: 'List available models and agents',
                inputSchema: {
                  type: 'object',
                  properties: {},
                  required: []
                }
              }
            ]
          }
        };

      case 'tools/call':
        return await handleToolCall(options, params, id);

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`
          }
        };
    }
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: String((err as Error)?.message || err)
      }
    };
  }
}

async function handleToolCall(
  options: UnifiedServerOptions,
  params: Record<string, unknown>,
  id: string | number
): Promise<McpResponse> {
  const { name, arguments: args } = params as { name: string; arguments?: Record<string, unknown> };

  try {
    let result: Record<string, unknown>;

    switch (name) {
      case 'crew_route_task': {
        const message = String(args?.task || '').trim();
        const context = String(args?.context || '').trim();
        const mergedInput = context ? `${message}\n\n${context}` : message;
        
        const route = await options.orchestrator.route(mergedInput);
        const decision = String(route?.decision || '');
        
        if (decision === 'CHAT' && route.response) {
          result = {
            decision: 'CHAT',
            response: route.response,
            executionPath: ['l1-interface', 'l2-orchestrator', 'l2-direct-response']
          };
        } else {
          const local = await options.orchestrator.executeLocally(route.task || mergedInput, {
            model: args?.model
          });
          await options.orchestrator.parseAndApplyToSandbox(String(local?.result || ''));
          
          result = {
            decision: decision || 'CODE',
            response: local?.result,
            executionPath: ['l1-interface', 'l2-orchestrator', 'l3-executor'],
            pendingChanges: options.sandbox.getPendingPaths(options.sandbox.getActiveBranch()).length
          };
        }
        break;
      }

      case 'crew_execute_code': {
        const task = String(args?.task || '').trim();
        const local = await options.orchestrator.executeLocally(task, {
          model: args?.model
        });
        const edits = await options.orchestrator.parseAndApplyToSandbox(String(local?.result || ''));
        
        result = {
          response: local?.result,
          edits: edits.length,
          pendingChanges: options.sandbox.getPendingPaths(options.sandbox.getActiveBranch()).length
        };
        break;
      }

      case 'crew_sandbox_status': {
        const branch = options.sandbox.getActiveBranch();
        const pending = options.sandbox.getPendingPaths(branch);
        
        result = {
          branch,
          pendingFiles: pending.length,
          files: pending
        };
        break;
      }

      case 'crew_sandbox_preview': {
        const branch = options.sandbox.getActiveBranch();
        const pending = options.sandbox.getPendingPaths(branch);
        const diffs = pending.map(p => {
          const content = options.sandbox.readPendingFile(branch, p);
          return { path: p, content };
        });
        
        result = {
          branch,
          changes: diffs
        };
        break;
      }

      case 'crew_sandbox_apply': {
        const branch = options.sandbox.getActiveBranch();
        await options.sandbox.applyToWorkingDirectory(branch);
        
        result = {
          success: true,
          message: 'Changes applied to working directory'
        };
        break;
      }

      case 'crew_sandbox_rollback': {
        const branch = options.sandbox.getActiveBranch();
        options.sandbox.discardBranch(branch);
        const newBranch = options.sandbox.createBranch();
        
        result = {
          success: true,
          message: `Rolled back ${branch}, created ${newBranch}`
        };
        break;
      }

      case 'crew_search_code': {
        const query = String(args?.query || '').trim();
        const limit = parseInt(String(args?.limit || '10'), 10);

        if (!query) {
          result = { query, results: [], message: 'Empty query' };
          break;
        }

        try {
          const { buildCollectionIndex, searchCollection } = await import('../collections/index.js');
          const idx = await buildCollectionIndex(options.projectDir, { includeCode: true });
          const hits = searchCollection(idx, query, limit);
          result = {
            query,
            results: hits.results.map(r => ({
              file: r.source,
              line: r.startLine,
              text: r.text.slice(0, 500),
              score: r.score
            })),
            total: hits.total
          };
        } catch (err) {
          result = { query, results: [], message: `Search error: ${(err as Error).message}` };
        }
        break;
      }

      case 'crew_list_models': {
        const agents = options.router.getDefaultAgents().map((a: Record<string, unknown>) => ({
          id: a.id,
          name: a.name,
          role: a.role
        }));
        
        result = {
          mode: options.mode,
          agents
        };
        break;
      }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Tool not found: ${name}`
          }
        };
    }

    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      }
    };
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: String((err as Error)?.message || err)
      }
    };
  }
}
