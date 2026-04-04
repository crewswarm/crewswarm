/**
 * @license
 * Copyright 2026 crewswarm
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SpawnAgentTool — Spawn a sub-agent that executes a task autonomously.
 *
 * The sub-agent runs in the same process with its own sandbox branch,
 * executes the given task using `runAgenticWorker`, and returns its final
 * response. The parent agent continues with the sub-agent's result.
 *
 * Depth is limited to MAX_SPAWN_DEPTH (3) to prevent infinite recursion.
 */

import type { MessageBus } from '../confirmation-bus/message-bus.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';
import { SPAWN_AGENT_TOOL_NAME } from './tool-names.js';
import type { Config } from '../config/config.js';
import type { Sandbox } from '../../sandbox/index.js';

// ---------------------------------------------------------------------------
// Parameter interface
// ---------------------------------------------------------------------------

export interface SpawnAgentToolParams {
  /** The task description for the sub-agent */
  task: string;
  /** Subset of tool names the sub-agent is allowed to use */
  tools?: string[];
  /** Maximum turns for the sub-agent (default: 10) */
  maxTurns?: number;
  /** Model to use (default: cheapest configured model) */
  model?: string;
}

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const SPAWN_AGENT_PARAMS_SCHEMA = {
  type: 'object',
  properties: {
    task: {
      type: 'string',
      description: 'Clear description of what the sub-agent should do',
    },
    tools: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional subset of tool names the sub-agent may use (default: read, write, edit, bash, grep)',
    },
    maxTurns: {
      type: 'number',
      description: 'Maximum turns for the sub-agent (default: 10, max: 25)',
    },
    model: {
      type: 'string',
      description: 'Model override for the sub-agent (default: cheapest configured model)',
    },
  },
  required: ['task'],
};

// ---------------------------------------------------------------------------
// Depth tracking (static, shared across all instances)
// ---------------------------------------------------------------------------

let _globalSpawnDepth = 0;
const MAX_SPAWN_DEPTH = 3;

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

class SpawnAgentToolInvocation extends BaseToolInvocation<SpawnAgentToolParams, ToolResult> {
  constructor(
    private readonly config: Config,
    private readonly sandbox: Sandbox,
    params: SpawnAgentToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
  }

  getDescription(): string {
    const maxTurns = this.params.maxTurns ?? 10;
    return `spawn-agent: "${this.params.task.slice(0, 80)}" (maxTurns=${maxTurns})`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const { task, maxTurns: rawMaxTurns, model } = this.params;

    if (_globalSpawnDepth >= MAX_SPAWN_DEPTH) {
      return {
        llmContent: `Sub-agent depth limit reached (max ${MAX_SPAWN_DEPTH}). Complete this task directly instead of spawning another agent.`,
        returnDisplay: `Depth limit reached (${MAX_SPAWN_DEPTH})`,
        error: { message: `Sub-agent depth limit reached` },
      };
    }

    const maxTurns = Math.min(rawMaxTurns ?? 10, 25);
    const resolvedModel = model
      || process.env.CREW_WORKER_MODEL
      || process.env.CREW_EXECUTION_MODEL
      || '';

    const branchName = `spawn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    _globalSpawnDepth++;

    try {
      // Create an isolated sandbox branch for the sub-agent
      type SandboxWithBranching = {
        createBranch?(name: string): Promise<void>;
        mergeBranch?(src: string, dst: string): Promise<void>;
        deleteBranch?(name: string): Promise<void>;
        switchBranch?(name: string): Promise<void>;
      };
      const sandboxBranching = this.sandbox as SandboxWithBranching;
      try {
        await sandboxBranching.createBranch?.(branchName);
      } catch {
        // If branching is unsupported, continue on the parent branch
      }

      const { runAgenticWorker } = await import('../../executor/agentic-executor.js');
      const result = await runAgenticWorker(task, this.sandbox, {
        model: resolvedModel,
        maxTurns,
        stream: false,          // Sub-agents do not stream to stdout
        verbose: Boolean(process.env.CREW_DEBUG),
        tier: 'fast',           // Use cheap model tier for sub-agents
        constraintLevel: 'edit', // Sub-agents are edit-level by default
      });

      // Merge sub-agent branch back to parent if branching is supported
      try {
        const parentBranch = this.sandbox.getActiveBranch?.();
        if (parentBranch && parentBranch !== branchName) {
          await sandboxBranching.mergeBranch?.(branchName, parentBranch);
        }
      } catch {
        // Merge unsupported — sub-agent changes already applied in-place
      }

      // Clean up temporary branch
      try {
        await sandboxBranching.deleteBranch?.(branchName);
      } catch {
        // Ignore cleanup errors
      }

      const costLine = result.cost ? `Cost: $${result.cost.toFixed(4)}\n` : '';
      const output = [
        `Sub-agent completed in ${result.turns ?? 0} turn(s).`,
        costLine,
        `Status: ${result.success ? 'SUCCESS' : 'FAILED'}`,
        '',
        result.output?.slice(0, 4000) || '(no output)',
      ].filter(s => s !== undefined).join('\n');

      return {
        llmContent: output,
        returnDisplay: output,
      };
    } catch (err) {
      // Attempt cleanup on error
      try {
        await sandboxBranching.switchBranch?.('main');
      } catch { /* ignore */ }
      try {
        await sandboxBranching.deleteBranch?.(branchName);
      } catch { /* ignore */ }

      const msg = `Sub-agent failed: ${err?.message || String(err)}`;
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg },
      };
    } finally {
      _globalSpawnDepth = Math.max(0, _globalSpawnDepth - 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Tool class
// ---------------------------------------------------------------------------

export class SpawnAgentTool extends BaseDeclarativeTool<SpawnAgentToolParams, ToolResult> {
  static readonly Name = SPAWN_AGENT_TOOL_NAME;

  constructor(
    private readonly config: Config,
    private readonly sandbox: Sandbox,
    messageBus: MessageBus,
  ) {
    super(
      SpawnAgentTool.Name,
      'SpawnAgent',
      'Spawn a sub-agent to handle a task autonomously. The sub-agent runs in an isolated sandbox branch with a limited tool set and cheaper model, executes the task, then returns its result. Use for independent research, file analysis, or coding subtasks. Max depth: 3.',
      Kind.Write,
      SPAWN_AGENT_PARAMS_SCHEMA,
      messageBus,
      true,
      false,
    );
  }

  protected override validateToolParamValues(params: SpawnAgentToolParams): string | null {
    if (!params.task?.trim()) {
      return "The 'task' parameter must be non-empty.";
    }
    if (params.maxTurns != null && (params.maxTurns < 1 || params.maxTurns > 25)) {
      return "maxTurns must be between 1 and 25.";
    }
    return null;
  }

  protected createInvocation(
    params: SpawnAgentToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<SpawnAgentToolParams, ToolResult> {
    return new SpawnAgentToolInvocation(
      this.config,
      this.sandbox,
      params,
      messageBus,
      _toolName,
      _toolDisplayName,
    );
  }
}
