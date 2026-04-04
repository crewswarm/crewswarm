/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MessageBus } from '../confirmation-bus/message-bus.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';
import type { Config } from '../config/config.js';
import { TOOL_SEARCH_TOOL_NAME } from './tool-names.js';
import { TOOL_SEARCH_DEFINITION } from './definitions/coreTools.js';
import { resolveToolDeclaration } from './definitions/resolver.js';

const DEFAULT_MAX_RESULTS = 10;

export interface ToolSearchToolParams {
  query: string;
  max_results?: number;
}

class ToolSearchToolInvocation extends BaseToolInvocation<ToolSearchToolParams, ToolResult> {
  constructor(
    private config: Config,
    params: ToolSearchToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
  }

  getDescription(): string {
    return `search tools for "${this.params.query}"`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const query = this.params.query.trim().toLowerCase();
    const maxResults = Math.max(1, this.params.max_results ?? DEFAULT_MAX_RESULTS);

    // Retrieve all registered tools from the tool registry
    const registry = this.config.getToolRegistry();
    const allTools = registry.getAllTools();

    // Score and filter by query match against name or description
    const scored = allTools
      .map((tool) => {
        const name = tool.name.toLowerCase();
        const description = (tool.description || '').toLowerCase();
        const displayName = (tool.displayName || '').toLowerCase();

        let score = 0;
        if (name === query) score += 100;
        else if (name.startsWith(query)) score += 60;
        else if (name.includes(query)) score += 40;

        if (description.includes(query)) score += 20;
        if (displayName.includes(query)) score += 10;

        return { tool, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);

    if (scored.length === 0) {
      return {
        llmContent: `No tools found matching "${this.params.query}".`,
        returnDisplay: `No tools found for query: "${this.params.query}"`,
      };
    }

    const results = scored.map(({ tool }) => {
      let schema: Record<string, unknown> = {};
      try {
        const decl = tool.getSchema();
        schema = (decl.parametersJsonSchema as Record<string, unknown>) || {};
      } catch {
        schema = {};
      }
      return {
        name: tool.name,
        displayName: tool.displayName,
        description: tool.description,
        parameterSchema: schema,
      };
    });

    const output = JSON.stringify({ query: this.params.query, count: results.length, results }, null, 2);
    return {
      llmContent: output,
      returnDisplay: `Found ${results.length} tool(s) matching "${this.params.query}"`,
    };
  }
}

export class ToolSearchTool extends BaseDeclarativeTool<ToolSearchToolParams, ToolResult> {
  static readonly Name = TOOL_SEARCH_TOOL_NAME;

  constructor(
    private config: Config,
    messageBus: MessageBus,
  ) {
    super(
      ToolSearchTool.Name,
      'Tool Search',
      TOOL_SEARCH_DEFINITION.base.description!,
      Kind.Search,
      TOOL_SEARCH_DEFINITION.base.parametersJsonSchema,
      messageBus,
      true,
      false,
    );
  }

  protected override validateToolParamValues(params: ToolSearchToolParams): string | null {
    if (!params.query || params.query.trim() === '') {
      return 'query cannot be empty';
    }
    return null;
  }

  protected createInvocation(
    params: ToolSearchToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<ToolSearchToolParams, ToolResult> {
    return new ToolSearchToolInvocation(this.config, params, messageBus, _toolName, _toolDisplayName);
  }

  override getSchema(modelId?: string) {
    return resolveToolDeclaration(TOOL_SEARCH_DEFINITION, modelId);
  }
}
