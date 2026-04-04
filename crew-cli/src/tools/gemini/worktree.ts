/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';
import type { Config } from '../config/config.js';
import { WORKTREE_TOOL_NAME } from './tool-names.js';
import { WORKTREE_DEFINITION } from './definitions/coreTools.js';
import { resolveToolDeclaration } from './definitions/resolver.js';

export interface WorktreeToolParams {
  action: 'enter' | 'exit' | 'merge' | 'list';
  branch?: string;
  merge?: boolean;
  projectDir?: string;
}

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf8', timeout: 30000 }).trim();
}

// Track active worktrees in-memory (per process)
const activeWorktrees = new Map<string, { path: string; baseBranch: string; createdAt: string }>();

class WorktreeToolInvocation extends BaseToolInvocation<WorktreeToolParams, ToolResult> {
  constructor(
    private config: Config,
    params: WorktreeToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
  }

  getDescription(): string {
    const { action, branch } = this.params;
    if (branch) return `worktree ${action} (branch: ${branch})`;
    return `worktree ${action}`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const projectDir = this.params.projectDir || this.config.getTargetDir();
    const { action, branch } = this.params;

    try {
      switch (action) {
        case 'enter': {
          if (!branch) {
            return { llmContent: 'branch is required for enter action', returnDisplay: 'Error: branch required' };
          }

          // Derive a session-like suffix from the branch name
          const suffix = branch.replace(/[^a-z0-9-]/gi, '-').slice(0, 24);
          const worktreePath = `/tmp/crew-cli-wt-${suffix}-${Date.now()}`;

          // Check if branch already exists
          let branchExists = false;
          try {
            git(`rev-parse --verify ${branch}`, projectDir);
            branchExists = true;
          } catch {
            branchExists = false;
          }

          if (branchExists) {
            git(`worktree add "${worktreePath}" "${branch}"`, projectDir);
          } else {
            git(`worktree add -b "${branch}" "${worktreePath}" HEAD`, projectDir);
          }

          const baseBranch = git('rev-parse --abbrev-ref HEAD', projectDir);
          activeWorktrees.set(branch, {
            path: worktreePath,
            baseBranch,
            createdAt: new Date().toISOString(),
          });

          const output = JSON.stringify({ branch, worktreePath, baseBranch, message: `Worktree created at ${worktreePath}` }, null, 2);
          return { llmContent: output, returnDisplay: `Worktree created at ${worktreePath}` };
        }

        case 'exit': {
          if (!branch) {
            return { llmContent: 'branch is required for exit action', returnDisplay: 'Error: branch required' };
          }

          const info = activeWorktrees.get(branch);
          const worktreePath = info?.path;

          // Optionally merge before removing
          const shouldMerge = this.params.merge !== false; // default true
          if (shouldMerge && info) {
            try {
              git(`merge --no-ff ${branch}`, projectDir);
            } catch (mergeErr: unknown) {
              const msg = (mergeErr as Error).message;
              return {
                llmContent: `Merge failed before exit: ${msg}. Worktree NOT removed.`,
                returnDisplay: `Merge failed: ${msg}`,
              };
            }
          }

          if (worktreePath) {
            try {
              git(`worktree remove "${worktreePath}" --force`, projectDir);
            } catch {
              // best-effort
            }
          }

          activeWorktrees.delete(branch);
          const output = JSON.stringify({ branch, removed: true, merged: shouldMerge && !!info }, null, 2);
          return { llmContent: output, returnDisplay: `Worktree for ${branch} removed` };
        }

        case 'merge': {
          if (!branch) {
            return { llmContent: 'branch is required for merge action', returnDisplay: 'Error: branch required' };
          }

          let mergeOutput = '';
          try {
            mergeOutput = git(`merge --no-ff ${branch}`, projectDir);
          } catch (mergeErr: unknown) {
            const conflictMsg = `Merge conflict: ${(mergeErr as Error).message}`;
            return { llmContent: conflictMsg, returnDisplay: conflictMsg };
          }

          const output = JSON.stringify({ branch, merged: true, output: mergeOutput || '(no output)' }, null, 2);
          return { llmContent: output, returnDisplay: `Merged ${branch}` };
        }

        case 'list': {
          let gitList = '';
          try {
            gitList = git('worktree list --porcelain', projectDir);
          } catch {
            gitList = '';
          }

          const inMemory = Array.from(activeWorktrees.entries()).map(([br, info]) => ({
            branch: br,
            path: info.path,
            baseBranch: info.baseBranch,
            createdAt: info.createdAt,
          }));

          const output = JSON.stringify({ activeWorktrees: inMemory, gitWorktreeList: gitList }, null, 2);
          return { llmContent: output, returnDisplay: `${inMemory.length} active worktree(s)` };
        }

        default:
          return {
            llmContent: `Unknown action: ${action}. Valid actions: enter, exit, merge, list`,
            returnDisplay: `Unknown action: ${action}`,
          };
      }
    } catch (err) {
      const msg = `WorktreeTool error (${action}): ${err.message}`;
      return { llmContent: msg, returnDisplay: msg };
    }
  }
}

export class WorktreeTool extends BaseDeclarativeTool<WorktreeToolParams, ToolResult> {
  static readonly Name = WORKTREE_TOOL_NAME;

  constructor(
    private config: Config,
    messageBus: MessageBus,
  ) {
    super(
      WorktreeTool.Name,
      'Worktree',
      WORKTREE_DEFINITION.base.description!,
      Kind.Execute,
      WORKTREE_DEFINITION.base.parametersJsonSchema,
      messageBus,
      false,
      false,
    );
  }

  protected override validateToolParamValues(params: WorktreeToolParams): string | null {
    if (!['enter', 'exit', 'merge', 'list'].includes(params.action)) {
      return `Invalid action "${params.action}". Must be one of: enter, exit, merge, list`;
    }
    if ((params.action === 'enter' || params.action === 'exit' || params.action === 'merge') && !params.branch) {
      return `branch is required for action "${params.action}"`;
    }
    return null;
  }

  protected createInvocation(
    params: WorktreeToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<WorktreeToolParams, ToolResult> {
    return new WorktreeToolInvocation(this.config, params, messageBus, _toolName, _toolDisplayName);
  }

  override getSchema(modelId?: string) {
    return resolveToolDeclaration(WORKTREE_DEFINITION, modelId);
  }
}
