// @ts-nocheck
/**
 * Local LLM executor - runs tasks without gateway dependency
 * This is the standalone Tier 2 executor that handles tasks directly
 */

import { Logger } from '../utils/logger.js';
import { streamOpenAIResponse, streamAnthropicResponse, streamGeminiResponse, writeToStdout, isStreamingDisabled } from './stream-helpers.js';

export interface ExecutorOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;  // Override default executor prompt with specialized persona
  jsonMode?: boolean;  // Force JSON response mode (for routing/planning only)
  sessionId?: string;  // Session ID for cache coherence (Grok, Anthropic)
}

export interface ExecutorResult {
  success: boolean;
  result: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;  // Cache hit tokens (Grok, OpenAI, Anthropic)
  costUsd?: number;
}

const EXECUTOR_SYSTEM_PROMPT = `You are the conversational interface for CrewSwarm CLI.

## Your Role
- Handle user interaction, clarifications, and responses
- Lead with the answer, not the reasoning. Skip preamble and filler.
- Keep it concise and actionable - under 2000 chars
- Match crew-lead's personality: sharp, direct, no filler

## Personality
- Be concise and sharp - no fluff
- When the user is direct, match their energy
- Research well, build anything, never make excuses

## Technical Capabilities
You can:
- Answer technical questions clearly
- Write, edit, and explain code
- Provide step-by-step guidance
- Make architectural recommendations

## Principles
- Read before acting: never claim what a file contains without reading it first.
- Match the request: do what was asked, don't over-scope or over-engineer.
- Own mistakes: if wrong, say so briefly and fix it. Don't repeat failing approaches.
- Never fabricate file contents, command output, or tool results.

Be concise, accurate, and helpful. Format code in markdown blocks.`;


export class LocalExecutor {
  private logger = new Logger();
  private readonly timeoutMs = this.getTimeoutMs();

  /**
   * Execute a task using local LLM (no gateway required)
   */
  async execute(task: string, options: ExecutorOptions = {}): Promise<ExecutorResult> {
    const model = options.model || this.getDefaultModel();
    const systemPrompt = options.systemPrompt || EXECUTOR_SYSTEM_PROMPT;
    
    // Determine provider from model name
    // If a specific model is requested, ONLY try that provider (no fallbacks)
    // Fallbacks only apply for default/generic models
    let providers: string[] = [];
    
    if (model.startsWith('gemini')) {
      providers = ['gemini'];  // Only Gemini for gemini-* models
    } else if (model.startsWith('deepseek')) {
      providers = ['deepseek'];  // Only DeepSeek for deepseek-* models
    } else if (model.startsWith('grok')) {
      providers = ['grok'];  // Only Grok for grok-* models
    } else if (model.startsWith('claude')) {
      providers = ['anthropic'];  // Only Anthropic for claude-* models
    } else if (model.startsWith('gpt-')) {
      providers = ['openai'];  // Only OpenAI for gpt-* models
    } else if (model.includes('llama') || model.includes('mixtral')) {
      providers = ['groq', 'grok', 'deepseek'];  // Try multiple for generic models
    } else {
      // Generic/unknown model - try all providers
      providers = ['openai', 'anthropic', 'grok', 'gemini', 'deepseek'];
    }
    
    const failures: string[] = [];
    
    if (process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true') console.log(`[Executor] Model: ${model}, Providers: [${providers.join(', ')}]`);
    
    for (const provider of providers) {
      try {
        console.log(`[Executor] Trying provider: ${provider}`);
        const result = await this.executeWithProvider(provider, task, model, options, systemPrompt);
        if (result) return result;
        failures.push(`${provider}: returned null (API key missing or timed out)`);
      } catch (err) {
        const errMsg = (err as Error).message;
        failures.push(`${provider}: ${errMsg}`);
        this.logger.warn(`Provider ${provider} failed: ${errMsg}`);
      }
    }
    
    this.logger.error('All providers failed:', failures.join('; '));
    this.logger.debug('API keys present:', JSON.stringify({
      OPENAI: !!process.env.OPENAI_API_KEY,
      ANTHROPIC: !!process.env.ANTHROPIC_API_KEY,
      XAI: !!process.env.XAI_API_KEY,
      GEMINI: !!process.env.GEMINI_API_KEY,
      DEEPSEEK: !!process.env.DEEPSEEK_API_KEY
    }));
    
    throw new Error('No LLM providers available. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, XAI_API_KEY, GEMINI_API_KEY, or DEEPSEEK_API_KEY');
  }

  private getTimeoutMs(): number {
    const raw = Number(process.env.CREW_EXECUTOR_TIMEOUT_MS || 90000);
    if (!Number.isFinite(raw) || raw < 1000) return 90000;
    return Math.floor(raw);
  }

  private getDefaultModel(): string {
    // Check environment variable first
    const envModel = process.env.CREW_EXECUTION_MODEL || process.env.CREW_CHAT_MODEL || process.env.CREW_REASONING_MODEL;
    if (envModel) return envModel;
    
    // Fall back to API key detection
    if (process.env.OPENAI_API_KEY) return 'gpt-4o';
    if (process.env.ANTHROPIC_API_KEY) return 'claude-3-5-sonnet-20241022';
    if (process.env.XAI_API_KEY) return 'grok-beta';
    if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return 'gemini-2.5-flash';
    if (process.env.DEEPSEEK_API_KEY) return 'deepseek-chat';
    return 'grok-beta';
  }

  private async executeWithProvider(
    provider: string,
    task: string,
    model: string,
    options: ExecutorOptions,
    systemPrompt: string
  ): Promise<ExecutorResult | null> {
    switch (provider) {
      case 'openai':
        return this.executeWithOpenAI(task, options, systemPrompt, options.sessionId);
      case 'groq':
        return this.executeWithGroq(task, options, systemPrompt);
      case 'grok':
        return this.executeWithGrok(task, options, systemPrompt, options.sessionId);
      case 'gemini':
        return this.executeWithGemini(task, options, systemPrompt);
      case 'deepseek':
        return this.executeWithDeepSeek(task, options, systemPrompt);
      case 'anthropic':
        return this.executeWithAnthropic(task, options, systemPrompt, options.sessionId);
      default:
        return null;
    }
  }

  private async executeWithGroq(task: string, options: ExecutorOptions, systemPrompt: string): Promise<ExecutorResult | null> {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return null;
    const stream = !isStreamingDisabled();

    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: task }
          ],
          temperature: options.temperature || 0.7,
          max_tokens: options.maxTokens || 2000,
          ...(stream ? { stream: true, stream_options: { include_usage: true } } : {})
        })
      });

      if (!response.ok) {
        throw new Error(`Groq API error: ${response.statusText}`);
      }

      if (stream && response.body) {
        const result = await streamOpenAIResponse(response, writeToStdout);
        if (result.text) process.stdout.write('\n');
        const cost = this.calculateCost('groq-llama', result.usage?.prompt_tokens || 0, result.usage?.completion_tokens || 0);
        return { success: true, result: result.text, costUsd: cost, model: 'llama-3.3-70b-versatile' };
      }

      const data = await response.json();
      const cost = this.calculateCost('groq-llama', data.usage?.prompt_tokens || 0, data.usage?.completion_tokens || 0);

      return {
        success: true,
        result: data.choices[0].message.content,
        costUsd: cost,
        model: 'llama-3.3-70b-versatile'
      };
    } catch (err) {
      this.logger.error(`Groq execution failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async executeWithGrok(task: string, options: ExecutorOptions, systemPrompt: string, sessionId?: string): Promise<ExecutorResult | null> {
    const key = process.env.XAI_API_KEY;
    if (!key) return null;

    // Use model from env or options, fallback to grok-4-1-fast-reasoning
    const model = options.model || process.env.CREW_EXECUTION_MODEL || 'grok-4-1-fast-reasoning';

    try {
      if (process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true') console.log(`[Grok] Starting API call (model: ${model})...`);
      const callStart = Date.now();
      
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      };
      
      // Add x-grok-conv-id for better cache coherence (increases cache hit rate)
      if (sessionId) {
        headers['x-grok-conv-id'] = sessionId;
      }
      
      const stream = !isStreamingDisabled();
      const response = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: task }
          ],
          temperature: options.temperature || 0.7,
          max_tokens: options.maxTokens || 4000,
          ...(stream ? { stream: true, stream_options: { include_usage: true } } : {})
        })
      });

      if (process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true') console.log(`[Grok] Response received in ${Date.now() - callStart}ms (status: ${response.status})`);

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        console.log(`[Grok] API error: ${response.status} - ${errorText}`);
        return null;
      }

      if (stream && response.body) {
        const result = await streamOpenAIResponse(response, writeToStdout);
        if (result.text) process.stdout.write('\n');
        const cachedTokens = result.usage?.prompt_tokens_details?.cached_tokens || 0;
        if (cachedTokens > 0) {
          const totalPrompt = result.usage?.prompt_tokens || 0;
          const pct = Math.round((cachedTokens / totalPrompt) * 100);
          console.log(`[Grok] cache hit: ${cachedTokens}/${totalPrompt} tokens cached (${pct}%) — 50% cost savings`);
        }
        return {
          success: true, result: result.text, model,
          promptTokens: result.usage?.prompt_tokens,
          completionTokens: result.usage?.completion_tokens,
          cachedTokens,
          costUsd: this.calculateGrokCostWithCache(result.usage)
        };
      }

      const data = await response.json() as any;
      const content = data?.choices?.[0]?.message?.content;
      if (!content) return null;

      // Track cache hits from Grok (50% savings on cached tokens)
      const cachedTokens = data?.usage?.prompt_tokens_details?.cached_tokens || 0;
      if (cachedTokens > 0) {
        const totalPrompt = data?.usage?.prompt_tokens || 0;
        const pct = Math.round((cachedTokens / totalPrompt) * 100);
        console.log(`[Grok] cache hit: ${cachedTokens}/${totalPrompt} tokens cached (${pct}%) — 50% cost savings`);
      }

      return {
        success: true,
        result: content,
        model,
        promptTokens: data?.usage?.prompt_tokens,
        completionTokens: data?.usage?.completion_tokens,
        cachedTokens,
        costUsd: this.calculateGrokCostWithCache(data?.usage)
      };
    } catch (err) {
      if (process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true') console.log(`[Grok] Exception: ${(err as Error).message}`);
      this.logger.debug(`Grok execution failed: ${(err as Error).message}`);
      return null;
    }
  }

  private calculateGrokCostWithCache(usage: any): number {
    if (!usage) return 0;
    
    const totalPrompt = usage.prompt_tokens || 0;
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens || 0;
    const regularTokens = totalPrompt - cachedTokens;
    const completionTokens = usage.completion_tokens || 0;
    
    // Grok-4 pricing: $5/1M input, $15/1M output
    // Cached tokens: 50% discount
    const regularCost = (regularTokens * 5.00) / 1_000_000;
    const cachedCost = (cachedTokens * 2.50) / 1_000_000;  // 50% off
    const outputCost = (completionTokens * 15.00) / 1_000_000;
    
    return regularCost + cachedCost + outputCost;
  }

  private async executeWithGemini(task: string, options: ExecutorOptions, systemPrompt: string): Promise<ExecutorResult | null> {
    const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    const verbose = process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true';
    if (!key) {
      if (verbose) console.log('[Gemini] No API key found');
      return null;
    }

    const model = options.model || this.getDefaultModel();
    if (verbose) console.log(`[Gemini] Starting API call (model: ${model})...`);

    // Use explicit jsonMode flag, or detect if task expects JSON output
    const expectsJson = options.jsonMode === true || (
      options.jsonMode !== false && (
        task.toLowerCase().includes('return only valid json') || 
        (task.includes('{"') && task.includes('"}'))
      )
    );
    
    if (expectsJson && verbose) {
      console.log('[Gemini] JSON mode enabled');
    }

    try {
      const requestBody: any = {
        contents: [{
          parts: [{
            text: `${systemPrompt}\n\nUser task: ${task}`
          }]
        }],
        generationConfig: {
          temperature: options.temperature || 0.7,
          maxOutputTokens: options.maxTokens || 4000
        }
      };

      // Enable JSON mode for structured outputs
      if (expectsJson) {
        requestBody.generationConfig.responseMimeType = 'application/json';
      }

      const stream = !isStreamingDisabled() && !expectsJson;
      const endpoint = stream
        ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`
        : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

      const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(this.timeoutMs),
          body: JSON.stringify(requestBody)
        }
      );

      if (verbose) {
        console.log(`[Gemini] Response received (status: ${response.status})`);
      }

      if (!response.ok) {
        const errorText = await response.text();
        if (verbose) {
          console.log(`[Gemini] API error: ${response.status} - ${errorText}`);
        }
        return null;
      }

      if (stream && response.body) {
        const result = await streamGeminiResponse(response, writeToStdout);
        if (result.text) process.stdout.write('\n');
        return {
          success: true, result: result.text, model,
          promptTokens: result.usage?.promptTokenCount,
          completionTokens: result.usage?.candidatesTokenCount,
          costUsd: this.calculateCost(model, result.usage?.promptTokenCount || 0, result.usage?.candidatesTokenCount || 0)
        };
      }

      const data = await response.json() as any;
      const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!content) return null;

      return {
        success: true,
        result: content,
        model: model,
        promptTokens: data?.usageMetadata?.promptTokenCount,
        completionTokens: data?.usageMetadata?.candidatesTokenCount,
        costUsd: this.calculateCost(model,
          data?.usageMetadata?.promptTokenCount || 0,
          data?.usageMetadata?.candidatesTokenCount || 0)
      };
    } catch (err) {
      this.logger.debug(`Gemini execution failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async executeWithDeepSeek(task: string, options: ExecutorOptions, systemPrompt: string): Promise<ExecutorResult | null> {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) {
      if (process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true') console.log('[DeepSeek] No API key found');
      return null;
    }

    const model = options.model || 'deepseek-chat';
    
    // For deepseek-reasoner on large tasks, allow much longer timeout
    const timeoutMs = model.includes('reasoner') && (options.maxTokens || 0) > 6000
      ? 10 * 60 * 1000  // 10 minutes for large reasoning tasks
      : this.timeoutMs;
    
    console.log(`[DeepSeek] Starting API call (model: ${model}, timeout: ${timeoutMs/1000}s)...`);

    try {
      const stream = !isStreamingDisabled() && !model.includes('reasoner');
      const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`
        },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: task }
          ],
          temperature: options.temperature || 0.7,
          max_tokens: options.maxTokens || 4000,
          ...(stream ? { stream: true, stream_options: { include_usage: true } } : {})
        })
      });

      if (process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true') console.log(`[DeepSeek] Response received (status: ${response.status})`);

      if (!response.ok) {
        const errorText = await response.text();
        console.log(`[DeepSeek] API error: ${response.status} - ${errorText}`);
        return null;
      }

      if (stream && response.body) {
        const result = await streamOpenAIResponse(response, writeToStdout);
        if (result.text) process.stdout.write('\n');
        if (process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true') console.log(`[DeepSeek] ✓ Success (${result.usage?.prompt_tokens || 0} in, ${result.usage?.completion_tokens || 0} out)`);
        return {
          success: true, result: result.text, model,
          promptTokens: result.usage?.prompt_tokens,
          completionTokens: result.usage?.completion_tokens,
          costUsd: this.calculateCost(model, result.usage?.prompt_tokens || 0, result.usage?.completion_tokens || 0)
        };
      }

      const data = await response.json() as any;

      // deepseek-reasoner returns reasoning_content + content
      // deepseek-chat returns only content
      const reasoning_content = data?.choices?.[0]?.message?.reasoning_content;
      let content = data?.choices?.[0]?.message?.content;
      
      if (!content && !reasoning_content) {
        console.log('[DeepSeek] No content or reasoning_content in response');
        return null;
      }

      // Log reasoning trace if present (for deepseek-reasoner)
      if (reasoning_content && process.env.DEBUG_REASONING) {
        console.log(`[DeepSeek] Reasoning trace (${reasoning_content.length} chars):`, 
          reasoning_content.substring(0, 200) + '...');
      }

      // Validate content is not just an empty brace or whitespace
      const trimmedContent = (content || '').trim();
      if (trimmedContent && trimmedContent !== '{' && trimmedContent !== '{}' && trimmedContent.length > 5) {
        // Valid content - use it
      } else if (reasoning_content) {
        // content is invalid/empty but we have reasoning - try to extract JSON from reasoning
        console.log('[DeepSeek] content field invalid, checking reasoning_content for JSON...');
        content = reasoning_content;
      } else {
        console.log('[DeepSeek] No valid content available');
        return null;
      }

      // Return ONLY the final answer content (content field)
      // The reasoning_content is internal CoT, not part of structured output
      if (process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true') console.log(`[DeepSeek] ✓ Success (${data?.usage?.prompt_tokens || 0} in, ${data?.usage?.completion_tokens || 0} out)`);

      return {
        success: true,
        result: content,
        model: model,
        promptTokens: data?.usage?.prompt_tokens,
        completionTokens: data?.usage?.completion_tokens,
        costUsd: this.calculateCost(model, data?.usage?.prompt_tokens || 0, data?.usage?.completion_tokens || 0)
      };
    } catch (err) {
      if (process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true') console.log(`[DeepSeek] Exception: ${(err as Error).message}`);
      this.logger.debug(`DeepSeek execution failed: ${(err as Error).message}`);
      return null;
    }
  }

  private calculateCost(model: string, promptTokens: number, completionTokens: number): number {
    // Rough pricing (per 1M tokens) - March 2026
    const pricing: Record<string, { prompt: number; completion: number }> = {
      'grok-beta': { prompt: 5, completion: 15 },
      'grok-4-1-fast-reasoning': { prompt: 5, completion: 15 },
      'gemini-2.0-flash-exp': { prompt: 0.075, completion: 0.30 },
      'gemini-2.5-flash': { prompt: 0.075, completion: 0.30 },
      'gemini-2.5-pro': { prompt: 1.25, completion: 5.00 },
      'deepseek-chat': { prompt: 0.27, completion: 1.10 },
      'deepseek-reasoner': { prompt: 0.55, completion: 2.19 },
      'claude-3-5-sonnet-20241022': { prompt: 3.00, completion: 15.00 },
      'claude-opus-4-6': { prompt: 5.00, completion: 25.00 },
      'claude-haiku-4-5': { prompt: 1.00, completion: 5.00 }
    };

    const rates = pricing[model] || { prompt: 1, completion: 3 };
    return (promptTokens * rates.prompt + completionTokens * rates.completion) / 1_000_000;
  }

  /**
   * Execute with Anthropic (Claude) - supports explicit prompt caching for 90% savings
   */
  private async executeWithAnthropic(
    task: string, 
    options: ExecutorOptions,
    systemPrompt: string,
    sessionId?: string
  ): Promise<ExecutorResult | null> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;

    const model = options.model || 'claude-3-5-sonnet-20241022';
    
    try {
      if (process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true') console.log(`[Anthropic] Starting API call (model: ${model})...`);
      const callStart = Date.now();

      // Use explicit cache control for 90% savings on system prompt
      const stream = !isStreamingDisabled();
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          model,
          max_tokens: options.maxTokens || 4000,
          ...(stream ? { stream: true } : {}),
          system: [
            {
              type: 'text',
              text: systemPrompt,
              cache_control: { type: 'ephemeral' }  // Explicit cache control (90% savings!)
            }
          ],
          messages: [
            { role: 'user', content: task }
          ]
        })
      });

      if (process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true') console.log(`[Anthropic] Response received in ${Date.now() - callStart}ms (status: ${response.status})`);

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        console.log(`[Anthropic] API error: ${response.status} - ${errorText}`);
        return null;
      }

      if (stream && response.body) {
        const result = await streamAnthropicResponse(response, writeToStdout);
        if (result.text) process.stdout.write('\n');
        const usage = result.usage || {};
        const cacheReadTokens = usage.cache_read_input_tokens || 0;
        const cacheCreateTokens = usage.cache_creation_input_tokens || 0;
        const inputTokens = usage.input_tokens || 0;
        if (cacheReadTokens > 0) {
          const totalInput = inputTokens + cacheReadTokens;
          const pct = Math.round((cacheReadTokens / totalInput) * 100);
          console.log(`[Anthropic] cache hit: ${cacheReadTokens}/${totalInput} tokens cached (${pct}%) — 90% cost savings`);
        } else if (cacheCreateTokens > 0) {
          console.log(`[Anthropic] cache write: ${cacheCreateTokens} tokens cached for future requests`);
        }
        return {
          success: true, result: result.text, model,
          promptTokens: inputTokens,
          completionTokens: usage.output_tokens,
          cachedTokens: cacheReadTokens,
          costUsd: this.calculateAnthropicCostWithCache(usage)
        };
      }

      const data = await response.json() as any;
      const content = data?.content?.[0]?.text;
      if (!content) return null;

      // Track cache metrics (Anthropic reports detailed cache usage)
      const cacheCreateTokens = data?.usage?.cache_creation_input_tokens || 0;
      const cacheReadTokens = data?.usage?.cache_read_input_tokens || 0;
      const inputTokens = data?.usage?.input_tokens || 0;

      if (cacheReadTokens > 0) {
        const totalInput = inputTokens + cacheReadTokens;
        const pct = Math.round((cacheReadTokens / totalInput) * 100);
        console.log(`[Anthropic] cache hit: ${cacheReadTokens}/${totalInput} tokens cached (${pct}%) — 90% cost savings`);
      } else if (cacheCreateTokens > 0) {
        console.log(`[Anthropic] cache write: ${cacheCreateTokens} tokens cached for future requests`);
      }

      return {
        success: true,
        result: content,
        model,
        promptTokens: inputTokens,
        completionTokens: data?.usage?.output_tokens,
        cachedTokens: cacheReadTokens,
        costUsd: this.calculateAnthropicCostWithCache(data?.usage)
      };
    } catch (err) {
      if (process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true') console.log(`[Anthropic] Exception: ${(err as Error).message}`);
      this.logger.debug(`Anthropic execution failed: ${(err as Error).message}`);
      return null;
    }
  }

  private calculateAnthropicCostWithCache(usage: any): number {
    if (!usage) return 0;
    
    const inputBase = (usage.input_tokens || 0) * 3.00 / 1_000_000;
    const cacheWrite = (usage.cache_creation_input_tokens || 0) * 3.75 / 1_000_000;  // 1.25x
    const cacheRead = (usage.cache_read_input_tokens || 0) * 0.30 / 1_000_000;  // 0.1x (90% off!)
    const output = (usage.output_tokens || 0) * 15.00 / 1_000_000;
    
    return inputBase + cacheWrite + cacheRead + output;
  }

  /**
   * Execute with OpenAI (GPT-4, GPT-5)
   */
  private async executeWithOpenAI(
    task: string,
    options: ExecutorOptions,
    systemPrompt: string,
    sessionId?: string
  ): Promise<ExecutorResult | null> {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      if (process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true') console.log('[OpenAI] No API key found');
      return null;
    }

    const model = options.model || 'gpt-4o';
    
    if (process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true') console.log(`[OpenAI] Starting API call (model: ${model})...`);

    try {
      // GPT-5+ uses max_completion_tokens, GPT-4 uses max_tokens
      const maxTokensParam = model.startsWith('gpt-5') || model.startsWith('gpt-6')
        ? 'max_completion_tokens'
        : 'max_tokens';
      // GPT-5/6 only support temperature=1 (default); other values cause 400
      const temp = (model.startsWith('gpt-5') || model.startsWith('gpt-6'))
        ? 1
        : (options.temperature ?? 0.7);
      const stream = !isStreamingDisabled() && !options.jsonMode;
      const requestBody: any = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: task }
        ],
        temperature: temp,
        [maxTokensParam]: options.maxTokens || 4000,
        ...(stream ? { stream: true, stream_options: { include_usage: true } } : {})
      };

      if (options.jsonMode) {
        requestBody.response_format = { type: 'json_object' };
      }

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify(requestBody)
      });

      if (process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true') console.log(`[OpenAI] Response received (status: ${response.status})`);

      if (!response.ok) {
        const errorText = await response.text();
        console.log(`[OpenAI] API error: ${response.status} - ${errorText}`);
        return null;
      }

      if (stream && response.body) {
        const result = await streamOpenAIResponse(response, writeToStdout);
        if (result.text) process.stdout.write('\n');
        if (process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true') console.log(`[OpenAI] ✓ Success (${result.usage?.prompt_tokens || 0} in, ${result.usage?.completion_tokens || 0} out)`);
        return {
          success: true, result: result.text, model,
          promptTokens: result.usage?.prompt_tokens,
          completionTokens: result.usage?.completion_tokens,
          cachedTokens: 0,
          costUsd: this.calculateOpenAICost(model, result.usage?.prompt_tokens || 0, result.usage?.completion_tokens || 0)
        };
      }

      const data = await response.json() as any;
      const content = data?.choices?.[0]?.message?.content;

      if (!content) {
        console.log('[OpenAI] No content in response');
        return null;
      }

      if (process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true') console.log(`[OpenAI] ✓ Success (${data?.usage?.prompt_tokens || 0} in, ${data?.usage?.completion_tokens || 0} out)`);

      return {
        success: true,
        result: content,
        model,
        promptTokens: data?.usage?.prompt_tokens,
        completionTokens: data?.usage?.completion_tokens,
        cachedTokens: 0,
        costUsd: this.calculateOpenAICost(model, data?.usage?.prompt_tokens || 0, data?.usage?.completion_tokens || 0)
      };
    } catch (err) {
      if (process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true') console.log(`[OpenAI] Exception: ${(err as Error).message}`);
      this.logger.debug(`OpenAI execution failed: ${(err as Error).message}`);
      return null;
    }
  }

  private calculateOpenAICost(model: string, promptTokens: number, completionTokens: number): number {
    // Pricing per 1M tokens
    const pricing: Record<string, { prompt: number; completion: number }> = {
      'gpt-5.2': { prompt: 5, completion: 20 },
      'gpt-5.2-2025-12-11': { prompt: 5, completion: 20 },
      'gpt-5.2-codex': { prompt: 5, completion: 20 },
      'gpt-5.1': { prompt: 4, completion: 16 },
      'gpt-5.1-chat-latest': { prompt: 4, completion: 16 },
      'gpt-5.1-codex': { prompt: 4, completion: 16 },
      'gpt-5-mini': { prompt: 0.5, completion: 2 },
      'gpt-5-nano': { prompt: 0.1, completion: 0.4 },
      'gpt-4o': { prompt: 2.5, completion: 10 },
      'gpt-4o-mini': { prompt: 0.15, completion: 0.6 },
      'gpt-4-turbo': { prompt: 10, completion: 30 }
    };
    
    const rates = pricing[model] || pricing['gpt-4o'];
    return (promptTokens * rates.prompt + completionTokens * rates.completion) / 1_000_000;
  }
}
