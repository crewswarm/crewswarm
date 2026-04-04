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
import { SLEEP_TOOL_NAME } from './tool-names.js';
import { SLEEP_DEFINITION } from './definitions/coreTools.js';
import { resolveToolDeclaration } from './definitions/resolver.js';

const MAX_SLEEP_MS = 60_000; // 60 seconds hard cap

export interface SleepToolParams {
  duration_ms: number;
  reason?: string;
}

class SleepToolInvocation extends BaseToolInvocation<SleepToolParams, ToolResult> {
  constructor(
    params: SleepToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
  }

  getDescription(): string {
    const ms = Math.min(this.params.duration_ms, MAX_SLEEP_MS);
    const reason = this.params.reason ? ` (${this.params.reason})` : '';
    return `sleep ${ms}ms${reason}`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const requested = this.params.duration_ms;
    const actual = Math.min(Math.max(0, requested), MAX_SLEEP_MS);
    const reason = this.params.reason || 'no reason given';

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, actual);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });

    if (signal.aborted) {
      return {
        llmContent: `Sleep cancelled after ${actual}ms (aborted). Reason: ${reason}`,
        returnDisplay: `Sleep aborted`,
      };
    }

    const cappedNote = requested > MAX_SLEEP_MS
      ? ` (requested ${requested}ms, capped at ${MAX_SLEEP_MS}ms)`
      : '';

    const output = JSON.stringify({ sleptMs: actual, reason, cappedNote: cappedNote || undefined }, null, 2);
    return {
      llmContent: output,
      returnDisplay: `Slept ${actual}ms — ${reason}`,
    };
  }
}

export class SleepTool extends BaseDeclarativeTool<SleepToolParams, ToolResult> {
  static readonly Name = SLEEP_TOOL_NAME;

  constructor(
    _config: Config,
    messageBus: MessageBus,
  ) {
    super(
      SleepTool.Name,
      'Sleep',
      SLEEP_DEFINITION.base.description!,
      Kind.Other,
      SLEEP_DEFINITION.base.parametersJsonSchema,
      messageBus,
      false,
      false,
    );
  }

  protected override validateToolParamValues(params: SleepToolParams): string | null {
    if (typeof params.duration_ms !== 'number' || params.duration_ms < 0) {
      return 'duration_ms must be a non-negative number';
    }
    return null;
  }

  protected createInvocation(
    params: SleepToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<SleepToolParams, ToolResult> {
    return new SleepToolInvocation(params, messageBus, _toolName, _toolDisplayName);
  }

  override getSchema(modelId?: string) {
    return resolveToolDeclaration(SLEEP_DEFINITION, modelId);
  }
}
