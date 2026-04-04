/**
 * Multi-turn conversation drivers for agentic tool-calling loops.
 * Each driver handles the provider-specific API format for tool calls.
 *
 * Used by executeWorkerAgentic() via autonomous-loop.ts to enable
 * multi-turn agentic execution for all providers, not just Gemini.
 */

import type { ToolCall, TurnResult } from '../worker/autonomous-loop.js';
import { streamOpenAIResponse, streamAnthropicResponse, writeToStdout, isStreamingDisabled } from './stream-helpers.js';

/** Tool declaration in a provider-agnostic format */
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Result from a single LLM turn */
export interface LLMTurnResult {
  toolCalls?: ToolCall[];
  response: string;
  status?: string;
  cost: number;
  /** Finish reason from the provider: 'stop', 'length', 'max_tokens', 'tool_calls', etc. */
  finishReason?: string;
}

// ─── Provider detection ───────────────────────────────────────────────

export type ProviderType = 'gemini' | 'openai' | 'anthropic' | 'grok' | 'deepseek' | 'groq' | 'mistral' | 'cerebras' | 'markers-only';

export function detectProvider(model: string): ProviderType {
  const m = String(model || '').trim().toLowerCase();
  const bare = m.includes('/') ? m.split('/').pop() || '' : m;
  if (bare.startsWith('gemini')) return 'gemini';
  if (bare.startsWith('claude')) return 'anthropic';
  if (bare.startsWith('gpt-') || bare.startsWith('o1-') || bare.startsWith('o3-')) return 'openai';
  if (bare.startsWith('grok')) return 'grok';
  if (bare.startsWith('deepseek')) return 'deepseek';
  if (bare.startsWith('llama') || bare.startsWith('mixtral')) return 'groq';
  if (bare.startsWith('mistral')) return 'mistral';
  if (bare.startsWith('cerebras')) return 'cerebras';
  return 'markers-only';
}

export function providerSupportsToolCalling(provider: ProviderType): boolean {
  return ['openai', 'anthropic', 'grok', 'deepseek', 'groq', 'mistral'].includes(provider);
}

// ─── Tool declaration formatters ──────────────────────────────────────

function toOpenAITools(tools: ToolDeclaration[]): unknown[] {
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }));
}

function toAnthropicTools(tools: ToolDeclaration[]): unknown[] {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters
  }));
}

// ─── History formatters ───────────────────────────────────────────────

function historyToOpenAIContext(history: TurnResult[]): string {
  if (history.length === 0) return '';
  const lines = history.map(h => {
    const res = h.error ? `ERROR: ${h.error}` : String(h.result || '').slice(0, 2000);
    return `[Turn ${h.turn}] ${h.tool}(${JSON.stringify(h.params).slice(0, 200)}) → ${res.slice(0, 500)}`;
  });
  return '\n\nPrevious tool results:\n' + lines.join('\n');
}

// ─── OpenAI-compatible driver (works for OpenAI, Grok, DeepSeek, Groq, Mistral) ──

interface OpenAIDriverConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  tools: ToolDeclaration[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export async function openAICompatibleTurn(
  task: string,
  tools: ToolDeclaration[],
  history: TurnResult[],
  config: OpenAIDriverConfig
): Promise<LLMTurnResult> {
  const historyContext = historyToOpenAIContext(history);
  const fullTask = historyContext ? `${task}${historyContext}` : task;

  const messages: unknown[] = [
    { role: 'system', content: config.systemPrompt },
    { role: 'user', content: fullTask }
  ];

  // GPT-5/6 only support temperature=1; other values cause 400
  const temp = (config.model?.startsWith?.('gpt-5') || config.model?.startsWith?.('gpt-6'))
    ? 1
    : (config.temperature ?? 0.3);
  const stream = !isStreamingDisabled();
  const requestBody: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: temp,
    max_tokens: config.maxTokens ?? 16000,
    tools: toOpenAITools(tools),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {})
  };

  const response = await fetch(config.apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`
    },
    signal: AbortSignal.timeout(config.timeoutMs ?? 120000),
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText);
    throw new Error(`API error ${response.status}: ${errText.slice(0, 500)}`);
  }

  if (stream && response.body) {
    const result = await streamOpenAIResponse(response, writeToStdout);
    if (result.text) process.stdout.write('\n');
    const usage = result.usage || {};
    const cost = (usage.prompt_tokens || 0) * 3 / 1_000_000 + (usage.completion_tokens || 0) * 10 / 1_000_000;
    const finishReason = result.finishReason;

    if (result.toolCalls.length > 0) {
      const toolCalls: ToolCall[] = result.toolCalls.map(tc => {
        let params = {};
        try { params = JSON.parse(tc.arguments || '{}'); } catch { /* ignore */ }
        return { tool: tc.name, params };
      });
      return { toolCalls, response: result.text, cost, finishReason };
    }
    return { response: result.text, status: 'COMPLETE', cost, finishReason };
  }

  const data = await response.json() as Record<string, unknown>;
  const choice = data?.choices?.[0];
  const message = choice?.message;
  const usage = data?.usage || {};

  // Calculate cost (rough)
  const cost = (usage.prompt_tokens || 0) * 3 / 1_000_000 + (usage.completion_tokens || 0) * 10 / 1_000_000;
  const finishReason: string | undefined = choice?.finish_reason;

  // Check for tool calls
  if (message?.tool_calls && message.tool_calls.length > 0) {
    const toolCalls: ToolCall[] = message.tool_calls.map((tc: { function?: { arguments?: string; name?: string } }) => {
      let params = {};
      try { params = JSON.parse(tc.function?.arguments || '{}'); } catch { /* ignore */ }
      return { tool: tc.function?.name || '', params };
    });
    return {
      toolCalls,
      response: message.content || '',
      cost,
      finishReason
    };
  }

  // No tool calls — model is done
  return {
    response: message?.content || '',
    status: 'COMPLETE',
    cost,
    finishReason
  };
}

// ─── Anthropic driver ─────────────────────────────────────────────────

interface AnthropicDriverConfig {
  apiKey: string;
  model: string;
  systemPrompt: string;
  tools: ToolDeclaration[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  isOAuth?: boolean;  // Use Authorization: Bearer instead of x-api-key
}

export async function anthropicTurn(
  task: string,
  tools: ToolDeclaration[],
  history: TurnResult[],
  config: AnthropicDriverConfig,
  images?: Array<{ data: string; mimeType: string }>
): Promise<LLMTurnResult> {
  const historyContext = historyToOpenAIContext(history);
  const fullTask = historyContext ? `${task}${historyContext}` : task;

  // Build user content: text + optional images using Anthropic's native format
  let userContent: string | unknown[] = fullTask;
  if (images?.length) {
    const parts: unknown[] = [{ type: 'text', text: fullTask }];
    for (const img of images) {
      parts.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mimeType, data: img.data }
      });
    }
    userContent = parts;
  }

  const stream = !isStreamingDisabled();
  const requestBody: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxTokens ?? 16000,
    system: config.systemPrompt,
    messages: [{ role: 'user', content: userContent }],
    temperature: config.temperature ?? 0.3,
    tools: toAnthropicTools(tools),
    ...(stream ? { stream: true } : {})
  };

  // OAuth tokens use Bearer auth; API keys use x-api-key
  const authHeaders: Record<string, string> = config.isOAuth
    ? { 'Authorization': `Bearer ${config.apiKey}`, 'x-app': 'cli' }
    : { 'x-api-key': config.apiKey };

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
      'anthropic-version': '2023-06-01'
    },
    signal: AbortSignal.timeout(config.timeoutMs ?? 120000),
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText);
    throw new Error(`Anthropic API error ${response.status}: ${errText.slice(0, 500)}`);
  }

  if (stream && response.body) {
    const result = await streamAnthropicResponse(response, writeToStdout);
    if (result.text) process.stdout.write('\n');
    const usage = result.usage || {};
    const cost = (usage.input_tokens || 0) * 3 / 1_000_000 + (usage.output_tokens || 0) * 15 / 1_000_000;
    const finishReason = result.stopReason;

    if (result.toolCalls.length > 0) {
      const toolCalls: ToolCall[] = result.toolCalls.map(tc => ({
        tool: tc.name,
        params: tc.input || {}
      }));
      return { toolCalls, response: result.text, cost, finishReason };
    }
    return { response: result.text, status: 'COMPLETE', cost, finishReason };
  }

  const data = await response.json() as Record<string, unknown>;
  const usage = data?.usage || {};
  const cost = (usage.input_tokens || 0) * 3 / 1_000_000 + (usage.output_tokens || 0) * 15 / 1_000_000;
  const finishReason: string | undefined = data?.stop_reason;

  const content = data?.content || [];
  const toolUseBlocks = content.filter((b: Record<string, unknown>) => b.type === 'tool_use');
  const textBlocks = content.filter((b: Record<string, unknown>) => b.type === 'text');
  const textResponse = textBlocks.map((b: Record<string, unknown>) => b.text).join('\n');

  if (toolUseBlocks.length > 0) {
    const toolCalls: ToolCall[] = toolUseBlocks.map((b: Record<string, unknown>) => ({
      tool: b.name,
      params: b.input || {}
    }));
    return { toolCalls, response: textResponse, cost, finishReason };
  }

  return { response: textResponse, status: 'COMPLETE', cost, finishReason };
}

// ─── Provider URL + key resolution ────────────────────────────────────

export function getProviderConfig(provider: ProviderType, model: string): { apiUrl: string; apiKey: string } | null {
  switch (provider) {
    case 'openai': {
      const key = process.env.OPENAI_API_KEY;
      return key ? { apiUrl: 'https://api.openai.com/v1/chat/completions', apiKey: key } : null;
    }
    case 'grok': {
      const key = process.env.XAI_API_KEY;
      return key ? { apiUrl: 'https://api.x.ai/v1/chat/completions', apiKey: key } : null;
    }
    case 'deepseek': {
      const key = process.env.DEEPSEEK_API_KEY;
      return key ? { apiUrl: 'https://api.deepseek.com/v1/chat/completions', apiKey: key } : null;
    }
    case 'groq': {
      const key = process.env.GROQ_API_KEY;
      return key ? { apiUrl: 'https://api.groq.com/openai/v1/chat/completions', apiKey: key } : null;
    }
    case 'mistral': {
      const key = process.env.MISTRAL_API_KEY;
      return key ? { apiUrl: 'https://api.mistral.ai/v1/chat/completions', apiKey: key } : null;
    }
    case 'cerebras': {
      const key = process.env.CEREBRAS_API_KEY;
      return key ? { apiUrl: 'https://api.cerebras.ai/v1/chat/completions', apiKey: key } : null;
    }
    case 'anthropic': {
      const key = process.env.ANTHROPIC_API_KEY;
      return key ? { apiUrl: 'https://api.anthropic.com/v1/messages', apiKey: key } : null;
    }
    default:
      return null;
  }
}
