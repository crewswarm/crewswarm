/**
 * Shared type definitions for crew-cli.
 * Centralises common interfaces to reduce `any` usage across source files.
 */

// ---------------------------------------------------------------------------
// JSON-safe primitives
// ---------------------------------------------------------------------------

/** A JSON-serialisable scalar value */
export type JsonPrimitive = string | number | boolean | null;

/** A JSON-serialisable value (recursive) */
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonArray = JsonValue[];

/** Safer alternative to `Record<string, any>` for unknown config/params objects */
export type UnknownRecord = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Tool-calling types (provider-agnostic)
// ---------------------------------------------------------------------------

/** Parameters passed to a tool call */
export type ToolParams = Record<string, unknown>;

/** A single tool call emitted by the LLM */
export interface ToolCall {
  tool: string;
  params: ToolParams;
}

/** Result of executing a tool */
export interface ToolExecutionResult {
  success: boolean;
  output?: string;
  error?: string;
  handled?: boolean;
  recovery?: string;
}

// ---------------------------------------------------------------------------
// LLM response types
// ---------------------------------------------------------------------------

/** Usage / token counts from the provider */
export interface LLMUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  [key: string]: number | undefined;
}

/** A response block from an Anthropic-style content array */
export interface AnthropicContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: ToolParams;
  id?: string;
  content?: string;
  tool_use_id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
  [key: string]: unknown;
}

/** A single tool-call entry from an OpenAI-style response */
export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** Raw OpenAI-style message choice */
export interface OpenAIChoice {
  finish_reason?: string;
  message?: {
    role: string;
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  delta?: {
    content?: string;
    tool_calls?: OpenAIToolCall[];
  };
}

/** Minimal shape returned by provider JSON responses */
export interface LLMResponseData {
  choices?: OpenAIChoice[];
  usage?: LLMUsage;
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  candidates?: Array<{
    content?: {
      parts?: Array<Record<string, unknown>>;
    };
  }>;
  usageMetadata?: Record<string, number>;
  cloudaicompanionProject?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Tool-declaration types (shared with multi-turn drivers)
// ---------------------------------------------------------------------------

/** JSON-Schema property definition */
export interface SchemaProperty {
  type?: string;
  description?: string;
  enum?: string[];
  items?: SchemaProperty;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
  [key: string]: unknown;
}

/** Provider-agnostic tool declaration */
export interface ToolDeclarationSchema {
  name: string;
  description: string;
  parameters: {
    type: 'object' | string;
    properties: Record<string, SchemaProperty | undefined>;
    required?: string[];
    [key: string]: unknown;
  };
}

// ---------------------------------------------------------------------------
// Conversation message types
// ---------------------------------------------------------------------------

/** OpenAI-compatible conversation message */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | AnthropicContentBlock[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  [key: string]: unknown;
}

/** Gemini-compatible conversation part */
export interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: ToolParams };
  functionResponse?: { name: string; response: UnknownRecord };
}

/** Gemini-compatible conversation turn */
export interface GeminiContent {
  role: 'model' | 'user';
  parts: GeminiPart[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Tracker types
// ---------------------------------------------------------------------------

export type TaskStatus = 'pending' | 'in-progress' | 'done' | 'blocked';
export type TaskType = 'feature' | 'bug' | 'chore' | 'docs' | string;

export interface TrackerTask {
  id: string;
  title: string;
  description: string;
  type: TaskType;
  status: TaskStatus;
  parentId?: string;
  dependencies?: string[];
  createdAt?: string;
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// LSP result types
// ---------------------------------------------------------------------------

export interface LspLocation {
  file?: string;
  line: number;
  column: number;
}

export interface LspDiagnostic extends LspLocation {
  category: string;
  message: string;
  code?: number;
}

export interface LspSymbol extends LspLocation {
  name: string;
  kind: string;
}

export interface LspCompletionItem {
  name: string;
  kind: string;
}

// ---------------------------------------------------------------------------
// Notebook types
// ---------------------------------------------------------------------------

export interface NotebookCell {
  cell_type: 'code' | 'markdown';
  source: string | string[];
  metadata?: UnknownRecord;
  outputs?: unknown[];
  execution_count?: number | null;
}

export interface Notebook {
  cells: NotebookCell[];
  metadata?: UnknownRecord;
  nbformat?: number;
  nbformat_minor?: number;
}

// ---------------------------------------------------------------------------
// Provider usage types (streaming / cost helpers)
// ---------------------------------------------------------------------------

/** Usage data from OpenAI-compatible providers (Grok, DeepSeek, Groq, etc.) */
export interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

/** Usage data from Anthropic Messages API */
export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** Usage data from Gemini API */
export interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

// ---------------------------------------------------------------------------
// Cost tracking types (SessionManager)
// ---------------------------------------------------------------------------

export interface CostEntry {
  model: string;
  usd: number;
  promptTokens: number;
  completionTokens: number;
  timestamp: string;
}

export interface CostData {
  totalUsd: number;
  byModel: Record<string, number>;
  entries: CostEntry[];
  cacheSavings: {
    hits: number;
    misses: number;
    tokensSaved: number;
    usdSaved: number;
  };
  memoryMetrics: {
    recallUsed: number;
    recallMisses: number;
    totalMatches: number;
    averageQualityScore: number;
  };
}

// ---------------------------------------------------------------------------
// Pipeline event types (resume / checkpoint)
// ---------------------------------------------------------------------------

export interface PipelineRunEvent {
  ts?: string;
  phase?: string;
  userInput?: string;
  plan?: unknown;
  response?: string;
  executionResults?: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Dispatch options (CLI helpers)
// ---------------------------------------------------------------------------

export interface DispatchOptions {
  project?: string;
  sessionId?: string;
  gateway?: string;
  model?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Web search / fetch types
// ---------------------------------------------------------------------------

export interface SearchHit {
  title?: string;
  url?: string;
  description?: string;
  snippet?: string;
  [key: string]: unknown;
}

export interface SearchResponse {
  hits?: SearchHit[];
  results?: SearchHit[];
  organic?: SearchHit[];
  [key: string]: unknown;
}
