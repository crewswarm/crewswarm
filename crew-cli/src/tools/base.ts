/**
 * Tool Base Classes (cloned from Gemini CLI)
 * 
 * @license
 * Portions derived from Gemini CLI
 * Copyright 2025 Google LLC
 * Licensed under Apache License 2.0
 */

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolResult {
  text: string;
  error?: string;
  diff?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolLocation {
  path: string;
  line?: number;
}

export interface ToolInvocation<TParams extends object, TResult extends ToolResult> {
  params: TParams;
  getDescription(): string;
  toolLocations(): ToolLocation[];
  shouldConfirmExecute(signal: AbortSignal): Promise<boolean>;
  execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void
  ): Promise<TResult>;
}

export abstract class BaseToolInvocation<
  TParams extends object,
  TResult extends ToolResult
> implements ToolInvocation<TParams, TResult> {
  constructor(
    readonly params: TParams,
    readonly toolName?: string,
    readonly toolDisplayName?: string
  ) {}

  abstract getDescription(): string;

  toolLocations(): ToolLocation[] {
    return [];
  }

  async shouldConfirmExecute(_signal: AbortSignal): Promise<boolean> {
    // Override in subclasses for dangerous operations
    return false;
  }

  abstract execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void
  ): Promise<TResult>;
}

export interface Tool<TParams extends object = any, TResult extends ToolResult = any> {
  name: string;
  declaration: ToolDeclaration;
  createInvocation(params: TParams): ToolInvocation<TParams, TResult>;
}

export abstract class BaseTool<
  TParams extends object,
  TResult extends ToolResult
> implements Tool<TParams, TResult> {
  constructor(
    readonly name: string,
    readonly declaration: ToolDeclaration
  ) {}

  abstract createInvocation(params: TParams): ToolInvocation<TParams, TResult>;
}
