#!/usr/bin/env node
/**
 * CrewSwarm Unified API
 * Single REST API consolidating crew-lead, dashboard, and MCP endpoints
 * OpenAPI-compliant with automatic documentation
 */

import http from 'node:http';
import url from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = parseInt(process.env.CREWSWARM_API_PORT || '5000');
const HOST = process.env.CREWSWARM_BIND_HOST || '127.0.0.1';

// API version
const API_VERSION = 'v1';

/**
 * OpenAPI specification
 */
const openApiSpec = {
  openapi: '3.0.0',
  info: {
    title: 'CrewSwarm API',
    version: '1.0.0',
    description: 'Unified REST API for multi-agent orchestration',
    contact: {
      name: 'CrewSwarm',
      url: 'https://github.com/your-org/CrewSwarm'
    }
  },
  servers: [
    { url: `http://localhost:${PORT}/${API_VERSION}`, description: 'Local development' }
  ],
  paths: {
    '/chat': {
      post: {
        summary: 'Send chat message',
        description: 'Send a message and get streaming response from crew-lead',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['message'],
                properties: {
                  message: { type: 'string', description: 'Chat message' },
                  userId: { type: 'string', default: 'default', description: 'User ID' },
                  sessionId: { type: 'string', default: 'default', description: 'Session ID' },
                  projectId: { type: 'string', description: 'Active project ID' }
                }
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Chat response',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    reply: { type: 'string' },
                    dispatched: { type: 'object' },
                    pipeline: { type: 'object' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/sessions': {
      get: {
        summary: 'List sessions',
        description: 'Get all sessions for a user',
        parameters: [
          {
            in: 'query',
            name: 'userId',
            schema: { type: 'string' },
            description: 'User ID (defaults to current user)'
          }
        ],
        responses: {
          200: {
            description: 'List of sessions',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    sessions: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          sessionId: { type: 'string' },
                          lastActivity: { type: 'string', format: 'date-time' },
                          messageCount: { type: 'integer' }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/sessions/{sessionId}/messages': {
      get: {
        summary: 'Get session messages',
        description: 'Retrieve message history for a session',
        parameters: [
          {
            in: 'path',
            name: 'sessionId',
            required: true,
            schema: { type: 'string' }
          },
          {
            in: 'query',
            name: 'userId',
            schema: { type: 'string' },
            description: 'User ID'
          },
          {
            in: 'query',
            name: 'limit',
            schema: { type: 'integer', default: 100 }
          }
        ],
        responses: {
          200: {
            description: 'Session messages',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    messages: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          role: { type: 'string', enum: ['user', 'assistant', 'system'] },
                          content: { type: 'string' },
                          timestamp: { type: 'string', format: 'date-time' }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/dispatch': {
      post: {
        summary: 'Dispatch task to agent',
        description: 'Send a task to a specific agent and get task ID',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['agent', 'task'],
                properties: {
                  agent: { type: 'string', description: 'Agent ID (e.g., crew-coder)' },
                  task: { type: 'string', description: 'Task description' },
                  userId: { type: 'string' },
                  sessionId: { type: 'string' },
                  context: { type: 'object', description: 'Additional context' }
                }
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Task dispatched',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    taskId: { type: 'string' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/tasks/{taskId}': {
      get: {
        summary: 'Get task status',
        description: 'Poll task status and result',
        parameters: [
          {
            in: 'path',
            name: 'taskId',
            required: true,
            schema: { type: 'string' }
          }
        ],
        responses: {
          200: {
            description: 'Task status',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    taskId: { type: 'string' },
                    status: { type: 'string', enum: ['pending', 'claimed', 'running', 'done', 'failed'] },
                    agent: { type: 'string' },
                    result: { type: 'string' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/agents': {
      get: {
        summary: 'List agents',
        description: 'Get all available agents with status',
        responses: {
          200: {
            description: 'List of agents',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    agents: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          name: { type: 'string' },
                          model: { type: 'string' },
                          status: { type: 'string', enum: ['running', 'idle', 'offline'] },
                          engine: { type: 'string' }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/agents/{agentId}/config': {
      get: {
        summary: 'Get agent config',
        parameters: [
          {
            in: 'path',
            name: 'agentId',
            required: true,
            schema: { type: 'string' }
          }
        ],
        responses: {
          200: {
            description: 'Agent configuration',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    config: { type: 'object' }
                  }
                }
              }
            }
          }
        }
      },
      put: {
        summary: 'Update agent config',
        parameters: [
          {
            in: 'path',
            name: 'agentId',
            required: true,
            schema: { type: 'string' }
          }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  model: { type: 'string' },
                  engine: { type: 'string' },
                  tools: { type: 'array', items: { type: 'string' } }
                }
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Config updated',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/pipelines': {
      post: {
        summary: 'Run multi-agent pipeline',
        description: 'Execute a multi-stage workflow with multiple agents',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['steps'],
                properties: {
                  userId: { type: 'string' },
                  sessionId: { type: 'string' },
                  steps: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['wave', 'agent', 'task'],
                      properties: {
                        wave: { type: 'integer', description: 'Execution order (parallel within same wave)' },
                        agent: { type: 'string' },
                        task: { type: 'string' }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Pipeline started',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    pipelineId: { type: 'string' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/pipelines/{pipelineId}': {
      get: {
        summary: 'Get pipeline status',
        parameters: [
          {
            in: 'path',
            name: 'pipelineId',
            required: true,
            schema: { type: 'string' }
          }
        ],
        responses: {
          200: {
            description: 'Pipeline status',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    pipelineId: { type: 'string' },
                    status: { type: 'string' },
                    currentWave: { type: 'integer' },
                    totalWaves: { type: 'integer' },
                    steps: { type: 'array' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/skills': {
      get: {
        summary: 'List skills',
        responses: {
          200: {
            description: 'List of available skills',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    skills: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          name: { type: 'string' },
                          description: { type: 'string' },
                          type: { type: 'string', enum: ['api', 'knowledge'] }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/skills/{skillName}': {
      post: {
        summary: 'Run skill',
        parameters: [
          {
            in: 'path',
            name: 'skillName',
            required: true,
            schema: { type: 'string' }
          }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  params: { type: 'object', description: 'Skill parameters' }
                }
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Skill executed',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    result: { type: 'object' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/memory': {
      get: {
        summary: 'Query memory',
        description: 'Search agent memory and task history',
        parameters: [
          {
            in: 'query',
            name: 'query',
            schema: { type: 'string' },
            description: 'Search query'
          },
          {
            in: 'query',
            name: 'userId',
            schema: { type: 'string' },
            description: 'User ID'
          },
          {
            in: 'query',
            name: 'limit',
            schema: { type: 'integer', default: 10 }
          }
        ],
        responses: {
          200: {
            description: 'Memory results',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    results: { type: 'array' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/memory/facts': {
      post: {
        summary: 'Add memory fact',
        description: 'Store a fact in agent memory',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['content'],
                properties: {
                  userId: { type: 'string' },
                  agentId: { type: 'string', default: 'crew-lead' },
                  content: { type: 'string', description: 'Fact to remember' }
                }
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Fact stored',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/approval/{approvalId}/approve': {
      post: {
        summary: 'Approve pending action',
        parameters: [
          {
            in: 'path',
            name: 'approvalId',
            required: true,
            schema: { type: 'string' }
          }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['userId'],
                properties: {
                  userId: { type: 'string', description: 'User or admin ID' }
                }
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Action approved',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/approval': {
      get: {
        summary: 'List pending approvals',
        parameters: [
          {
            in: 'query',
            name: 'userId',
            schema: { type: 'string' },
            description: 'Filter by user ID'
          }
        ],
        responses: {
          200: {
            description: 'Pending approvals',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    approvals: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          approvalId: { type: 'string' },
                          agent: { type: 'string' },
                          action: { type: 'string' },
                          approvalLevel: { type: 'string', enum: ['user', 'admin'] },
                          createdAt: { type: 'string', format: 'date-time' }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/health': {
      get: {
        summary: 'Health check',
        description: 'Check if API is running',
        responses: {
          200: {
            description: 'API is healthy',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    version: { type: 'string' },
                    uptime: { type: 'integer' }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
};

/**
 * Simple HTTP router
 */
function route(req, res) {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const query = parsedUrl.query;
  const method = req.method;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Serve OpenAPI spec
  if (pathname === `/${API_VERSION}/openapi.json` && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(openApiSpec, null, 2));
    return;
  }

  // Swagger UI (redirect to external viewer for now)
  if (pathname === '/docs' || pathname === `/${API_VERSION}/docs`) {
    const swaggerUrl = `https://petstore.swagger.io/?url=http://localhost:${PORT}/${API_VERSION}/openapi.json`;
    res.writeHead(302, { 'Location': swaggerUrl });
    res.end();
    return;
  }

  // Health check
  if (pathname === `/${API_VERSION}/health` && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      version: API_VERSION,
      uptime: process.uptime()
    }));
    return;
  }

  // All other endpoints return 501 Not Implemented for now
  // TODO: Proxy to crew-lead or dashboard based on endpoint
  res.writeHead(501, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: false,
    error: 'Not implemented',
    message: `Endpoint ${pathname} is not yet implemented. This is a specification-only API server.`
  }));
}

/**
 * Start server
 */
const server = http.createServer(route);

server.listen(PORT, HOST, () => {
  console.log(`[unified-api] ✓ Server running at http://${HOST}:${PORT}`);
  console.log(`[unified-api] OpenAPI spec: http://localhost:${PORT}/${API_VERSION}/openapi.json`);
  console.log(`[unified-api] Swagger docs: http://localhost:${PORT}/docs`);
});
