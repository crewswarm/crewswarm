// @ts-nocheck
/**
 * Local LLM executor - runs tasks without gateway dependency
 * This is the standalone Tier 2 executor that handles tasks directly
 */

import { randomUUID } from 'node:crypto';
import { Logger } from '../utils/logger.js';
import { streamOpenAIResponse, streamAnthropicResponse, streamGeminiResponse, writeToStdout, isStreamingDisabled } from './stream-helpers.js';
import { getOAuthToken, forceRefreshOAuthToken } from '../auth/oauth-keychain.js';
import { getOpenAIOAuthToken, forceRefreshOpenAIOAuth, OPENAI_CODEX_API_URL } from '../auth/openai-oauth.js';
import { getGeminiOAuthToken, forceRefreshGeminiOAuth } from '../auth/gemini-oauth.js';
import { computeVersionSuffix, buildBillingBlock, signBody } from '../auth/cch.js';

export interface ExecutorOptions {
  model?: string;
  explicitModel?: boolean;
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
  providerId?: string;
  attemptedProviders?: string[];
  providerFailures?: string[];
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;  // Cache hit tokens (Grok, OpenAI, Anthropic)
  costUsd?: number;
}

interface ProviderAuth {
  token: string;
  isOAuth: boolean;
  apiUrl?: string;
  projectId?: string;
  oauthSource?: string;
}

const CLAUDE_OAUTH_BETA_HEADER = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'adaptive-thinking-2026-01-28',
  'research-preview-2026-02-01',
  'interleaved-thinking-2025-05-14',
  'redact-thinking-2026-02-12',
  'context-management-2025-06-27',
].join(',');

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

  private hasExplicitModelOverride(options: ExecutorOptions): boolean {
    return options.explicitModel === true;
  }

  private async getConfiguredProviderOrder(): Promise<string[]> {
    const envOrder = String(process.env.CREW_EXECUTION_PROVIDER_ORDER || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const baseOrder = envOrder.length > 0
      ? envOrder
      : ["openai", "anthropic", "gemini", "deepseek", "groq", "grok"];

    const resolved: string[] = [];
    for (const provider of baseOrder) {
      if (await this.resolveProviderAuth(provider)) {
        resolved.push(provider);
      }
    }
    return resolved;
  }

  private async resolveProviderAuth(provider: string): Promise<ProviderAuth | null> {
    switch (provider) {
      case 'openai': {
        // OAuth first (free via ChatGPT subscription), API key fallback
        if (process.env.CREW_NO_OAUTH !== 'true') {
          const oauth = await getOpenAIOAuthToken();
          if (oauth?.accessToken) {
            return { token: oauth.accessToken, isOAuth: true, apiUrl: OPENAI_CODEX_API_URL };
          }
        }
        if (process.env.OPENAI_API_KEY) {
          return { token: process.env.OPENAI_API_KEY, isOAuth: false, apiUrl: 'https://api.openai.com/v1/chat/completions' };
        }
        return null;
      }
      case 'anthropic': {
        // OAuth first (free via Claude Max subscription), API key fallback
        if (process.env.CREW_NO_OAUTH !== 'true') {
          const oauth = await getOAuthToken();
          if (oauth?.accessToken) {
            return { token: oauth.accessToken, isOAuth: true };
          }
        }
        if (process.env.ANTHROPIC_API_KEY) {
          return { token: process.env.ANTHROPIC_API_KEY, isOAuth: false };
        }
        return null;
      }
      case 'gemini': {
        const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
        if (apiKey) {
          return { token: apiKey, isOAuth: false };
        }
        if (process.env.CREW_NO_OAUTH === 'true') return null;
        const oauth = await getGeminiOAuthToken();
        if (oauth?.accessToken) {
          return {
            token: oauth.accessToken,
            isOAuth: true,
            projectId: oauth.projectId || undefined,
            oauthSource: oauth.source
          };
        }
        return null;
      }
      case 'deepseek':
        return process.env.DEEPSEEK_API_KEY ? { token: process.env.DEEPSEEK_API_KEY, isOAuth: false } : null;
      case 'groq':
        return process.env.GROQ_API_KEY ? { token: process.env.GROQ_API_KEY, isOAuth: false } : null;
      case 'grok':
        return process.env.XAI_API_KEY ? { token: process.env.XAI_API_KEY, isOAuth: false } : null;
      default:
        return null;
    }
  }

  /**
   * Execute a task using local LLM (no gateway required)
   */
  async execute(task: string, options: ExecutorOptions = {}): Promise<ExecutorResult> {
    const model = options.model || await this.getDefaultModel();
    const systemPrompt = options.systemPrompt || EXECUTOR_SYSTEM_PROMPT;
    const explicitModel = this.hasExplicitModelOverride(options);
    
    // Determine provider from model name
    // Explicit model choice stays locked to its provider.
    // Auto-selected defaults should fall through across configured providers.
    let providers: string[] = [];
    
    if (!explicitModel) {
      providers = await this.getConfiguredProviderOrder();
    } else if (model.startsWith('gemini')) {
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

    if (!options.model && providers.length === 1) {
      const fallbackProviders = (await this.getConfiguredProviderOrder()).filter(
        (provider) => provider !== providers[0]
      );
      providers = [...providers, ...fallbackProviders];
    }

    if (providers.length === 0) {
      providers = ['openai', 'anthropic', 'grok', 'gemini', 'deepseek'];
    }
    
    const failures: string[] = [];
    
    if (process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true') console.log(`[Executor] Model: ${model}, Providers: [${providers.join(', ')}]`);
    
    for (const provider of providers) {
      try {
        const auth = await this.resolveProviderAuth(provider);
        const authBadge = auth?.isOAuth ? 'OAuth' : 'API';
        if (process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true') {
          console.error(`\x1b[2m[Executor] ${provider} (${authBadge})\x1b[0m`);
        }
        const result = await this.executeWithProvider(provider, task, model, options, systemPrompt);
        if (result) {
          return {
            ...result,
            providerId: result.providerId || provider,
            attemptedProviders: [...providers.slice(0, providers.indexOf(provider) + 1)],
            providerFailures: [...failures]
          };
        }
        failures.push(`${provider}: no usable response (missing key, timeout, or empty body)`);
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
    
    const configured = await this.getConfiguredProviderOrder();
    const configuredText = configured.length > 0 ? configured.join(', ') : 'none';
    const triedText = providers.join(', ');
    const failureText = failures.length > 0 ? ` Failures: ${failures.join(' | ')}` : '';
    throw new Error(
      `No LLM providers succeeded. Configured providers: ${configuredText}. Tried: ${triedText}.${failureText} Set at least one working provider key such as OPENAI_API_KEY, ANTHROPIC_API_KEY, XAI_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY, or GROQ_API_KEY.`
    );
  }

  private getTimeoutMs(): number {
    const raw = Number(process.env.CREW_EXECUTOR_TIMEOUT_MS || 90000);
    if (!Number.isFinite(raw) || raw < 1000) return 90000;
    return Math.floor(raw);
  }

  private async getDefaultModel(): Promise<string> {
    // Check environment variable first
    const envModel = process.env.CREW_EXECUTION_MODEL || process.env.CREW_CHAT_MODEL || process.env.CREW_REASONING_MODEL;
    if (envModel) return envModel;
    
    // Prefer OAuth-capable providers before raw API keys where possible.
    if (await this.resolveProviderAuth('openai')) return 'gpt-5.4';
    if (await this.resolveProviderAuth('anthropic')) return 'claude-sonnet-4-20250514';
    if (process.env.XAI_API_KEY) return 'grok-beta';
    if (await this.resolveProviderAuth('gemini')) return 'gemini-2.5-flash';
    if (await this.resolveProviderAuth('deepseek')) return 'deepseek-chat';
    return 'grok-beta';
  }

  private async executeWithProvider(
    provider: string,
    task: string,
    model: string,
    options: ExecutorOptions,
    systemPrompt: string
  ): Promise<ExecutorResult | null> {
    const providerOptions = this.getProviderOptions(provider, model, options);
    switch (provider) {
      case 'openai':
        return this.executeWithOpenAI(task, providerOptions, systemPrompt, providerOptions.sessionId);
      case 'groq':
        return this.executeWithGroq(task, providerOptions, systemPrompt);
      case 'grok':
        return this.executeWithGrok(task, providerOptions, systemPrompt, providerOptions.sessionId);
      case 'gemini':
        return this.executeWithGemini(task, providerOptions, systemPrompt);
      case 'deepseek':
        return this.executeWithDeepSeek(task, providerOptions, systemPrompt);
      case 'anthropic':
        return this.executeWithAnthropic(task, providerOptions, systemPrompt, providerOptions.sessionId);
      default:
        return null;
    }
  }

  private getProviderOptions(provider: string, requestedModel: string, options: ExecutorOptions): ExecutorOptions {
    if (options.explicitModel === true) {
      return options;
    }

    const normalized = String(requestedModel || '').trim().toLowerCase();
    const matchesProvider =
      (provider === 'openai' && normalized.startsWith('gpt-')) ||
      (provider === 'anthropic' && normalized.startsWith('claude')) ||
      (provider === 'grok' && normalized.startsWith('grok')) ||
      (provider === 'gemini' && normalized.startsWith('gemini')) ||
      (provider === 'deepseek' && normalized.startsWith('deepseek')) ||
      (provider === 'groq' && (normalized.includes('llama') || normalized.includes('mixtral')));

    if (matchesProvider) {
      return options;
    }

    return {
      ...options,
      model: undefined
    };
  }

  private async executeWithGroq(task: string, options: ExecutorOptions, systemPrompt: string): Promise<ExecutorResult | null> {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return null;
    const stream = !isStreamingDisabled() && options.jsonMode !== true;

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
        return { success: true, result: result.text, costUsd: cost, model: 'llama-3.3-70b-versatile', providerId: 'groq' };
      }

      const data = await response.json();
      const cost = this.calculateCost('groq-llama', data.usage?.prompt_tokens || 0, data.usage?.completion_tokens || 0);

      return {
        success: true,
        result: data.choices[0].message.content,
        costUsd: cost,
        model: 'llama-3.3-70b-versatile',
        providerId: 'groq'
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
      
      const stream = !isStreamingDisabled() && options.jsonMode !== true && process.env.CREW_GROK_STREAMING !== '0';
      const requestBody = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: task }
        ],
        temperature: options.temperature || 0.7,
        max_tokens: options.maxTokens || 4000,
        ...(stream ? { stream: true, stream_options: { include_usage: true } } : {})
      };
      const response = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify(requestBody)
      });

      if (process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true') console.log(`[Grok] Response received in ${Date.now() - callStart}ms (status: ${response.status})`);

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        console.log(`[Grok] API error: ${response.status} - ${errorText}`);
        return null;
      }

      if (stream && response.body) {
        try {
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
            providerId: 'grok',
            promptTokens: result.usage?.prompt_tokens,
            completionTokens: result.usage?.completion_tokens,
            cachedTokens,
            costUsd: this.calculateGrokCostWithCache(result.usage)
          };
        } catch (streamErr) {
          this.logger.warn(`Grok streaming failed, retrying without stream: ${(streamErr as Error).message}`);
          const retryResponse = await fetch('https://api.x.ai/v1/chat/completions', {
            method: 'POST',
            headers,
            signal: AbortSignal.timeout(this.timeoutMs),
            body: JSON.stringify({
              ...requestBody,
              stream: false,
              stream_options: undefined
            })
          });
          if (!retryResponse.ok) {
            const retryText = await retryResponse.text().catch(() => retryResponse.statusText);
            console.log(`[Grok] Retry API error: ${retryResponse.status} - ${retryText}`);
            return null;
          }
          const retryData = await retryResponse.json() as any;
          const retryContent = retryData?.choices?.[0]?.message?.content;
          if (!retryContent) return null;
          const cachedTokens = retryData?.usage?.prompt_tokens_details?.cached_tokens || 0;
          return {
            success: true,
            result: retryContent,
            model,
            providerId: 'grok',
            promptTokens: retryData?.usage?.prompt_tokens,
            completionTokens: retryData?.usage?.completion_tokens,
            cachedTokens,
            costUsd: this.calculateGrokCostWithCache(retryData?.usage)
          };
        }
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
        providerId: 'grok',
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
    const auth = await this.resolveProviderAuth('gemini');
    const verbose = process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true';
    if (!auth) {
      if (verbose) console.log('[Gemini] No API key found');
      return null;
    }

    const model = options.model || await this.getDefaultModel();
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
      if (auth.isOAuth) {
        return this.executeWithGeminiCodeAssist(task, options, systemPrompt, auth);
      }

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

      const usingVertexOAuth = auth.isOAuth && !!auth.projectId;
      const stream = !isStreamingDisabled() && !expectsJson && !usingVertexOAuth;
      const vertexRegion = process.env.GEMINI_VERTEX_REGION || process.env.CLOUD_ML_REGION || 'us-central1';
      const endpoint = usingVertexOAuth
        ? `https://${vertexRegion}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(auth.projectId!)}/locations/${encodeURIComponent(vertexRegion)}/publishers/google/models/${model}:generateContent`
        : (auth.isOAuth
          ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`
          : (stream
          ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(auth.token)}`
          : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(auth.token)}`));

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (auth.isOAuth) {
        headers.Authorization = `Bearer ${auth.token}`;
        if (usingVertexOAuth) {
          headers['x-goog-user-project'] = auth.projectId!;
        }
      }

      const response = await fetch(endpoint, {
          method: 'POST',
          headers,
          signal: AbortSignal.timeout(this.timeoutMs),
          body: JSON.stringify(requestBody)
        }
      );

      if (verbose) {
        console.log(`[Gemini] Response received (status: ${response.status})`);
      }

      if (!response.ok) {
        if (response.status === 401 && auth.isOAuth) {
          const refreshed = await forceRefreshGeminiOAuth();
          if (refreshed?.accessToken && refreshed.accessToken !== auth.token) {
            return this.executeWithGemini(task, options, systemPrompt);
          }
        }
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
          providerId: 'gemini',
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
        providerId: 'gemini',
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

  private async executeWithGeminiCodeAssist(
    task: string,
    options: ExecutorOptions,
    systemPrompt: string,
    auth: ProviderAuth
  ): Promise<ExecutorResult | null> {
    const model = options.model || await this.getDefaultModel();
    const projectId = auth.projectId || process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || '';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${auth.token}`,
      'User-Agent': 'GeminiCLI/crew-cli'
    };
    if (auth.oauthSource === 'adc' && projectId) {
      headers['x-goog-user-project'] = projectId;
    }

    const metadata = {
      ideType: 'IDE_UNSPECIFIED',
      platform: 'PLATFORM_UNSPECIFIED',
      pluginType: 'GEMINI',
      duetProject: projectId || undefined
    };

    const loadResponse = await fetch('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        cloudaicompanionProject: projectId || undefined,
        metadata
      })
    });

    if (!loadResponse.ok) {
      const errorText = await loadResponse.text().catch(() => '');
      throw new Error(`Gemini Code Assist loadCodeAssist ${loadResponse.status}: ${errorText.slice(0, 300)}`);
    }

    const loadData = await loadResponse.json() as any;
    const resolvedProjectId = loadData?.cloudaicompanionProject || projectId;
    const requestBody = {
      model,
      project: resolvedProjectId || undefined,
      user_prompt_id: options.sessionId || `crew-${Date.now()}`,
      request: {
        contents: [{
          role: 'user',
          parts: [{ text: `${systemPrompt}\n\nUser task: ${task}` }]
        }],
        systemInstruction: {
          role: 'user',
          parts: [{ text: systemPrompt }]
        },
        generationConfig: {
          temperature: options.temperature ?? 0.7,
          maxOutputTokens: options.maxTokens || 4000
        },
        session_id: options.sessionId || ''
      }
    };

    const response = await fetch('https://cloudcode-pa.googleapis.com/v1internal:generateContent', {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      if (response.status === 401) {
        const refreshed = await forceRefreshGeminiOAuth();
        if (refreshed?.accessToken && refreshed.accessToken !== auth.token) {
          return this.executeWithGemini(task, options, systemPrompt);
        }
      }
      const errorText = await response.text().catch(() => '');
      throw new Error(`Gemini Code Assist generateContent ${response.status}: ${errorText.slice(0, 300)}`);
    }

    const data = await response.json() as any;
    const parts = data?.response?.candidates?.[0]?.content?.parts || [];
    const content = parts.filter((part: any) => typeof part?.text === 'string').map((part: any) => part.text).join('\n').trim();
    if (!content) return null;

    return {
      success: true,
      result: content,
      model,
      providerId: `gemini-oauth-${auth.oauthSource || 'unknown'}`,
      promptTokens: data?.response?.usageMetadata?.promptTokenCount,
      completionTokens: data?.response?.usageMetadata?.candidatesTokenCount,
      costUsd: this.calculateCost(
        model,
        data?.response?.usageMetadata?.promptTokenCount || 0,
        data?.response?.usageMetadata?.candidatesTokenCount || 0
      )
    };
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
    const auth = await this.resolveProviderAuth('anthropic');
    if (!auth) return null;

    const model = options.model || 'claude-3-5-sonnet-20241022';
    
    try {
      if (auth.isOAuth) {
        const oauthModel = options.model || String(process.env.CREW_OAUTH_CLAUDE_MODEL || 'claude-sonnet-4-6');
        const firstMsg = typeof task === 'string' ? task : '';
        const suffix = computeVersionSuffix(firstMsg);
        const billingBlock = buildBillingBlock(suffix);
        const systemBlocks = [
          billingBlock,
          ...(systemPrompt ? [{ type: 'text' as const, text: systemPrompt, cache_control: { type: 'ephemeral' as const } }] : []),
        ];
        const supportsThinking = !oauthModel.includes('haiku');
        const bodyObj = {
          model: oauthModel,
          max_tokens: options.maxTokens || 4000,
          ...(supportsThinking ? { thinking: { type: 'adaptive' } } : {}),
          metadata: { user_id: `user_crewswarm_session_${sessionId || randomUUID()}` },
          system: systemBlocks,
          messages: [{ role: 'user', content: task }],
        };
        const signedBody = await signBody(bodyObj);
        const response = await fetch('https://api.anthropic.com/v1/messages?beta=true', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${auth.token}`,
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01',
            'anthropic-beta': CLAUDE_OAUTH_BETA_HEADER,
            'anthropic-dangerous-direct-browser-access': 'true',
            'x-app': 'cli',
            'user-agent': 'claude-cli/2.1.87 (external, cli)',
            'x-claude-code-session-id': sessionId || randomUUID(),
          },
          signal: AbortSignal.timeout(this.timeoutMs),
          body: signedBody
        });

        if (!response.ok) {
          if (response.status === 401) {
            const refreshed = await forceRefreshOAuthToken();
            if (refreshed?.accessToken && refreshed.accessToken !== auth.token) {
              return this.executeWithAnthropic(task, options, systemPrompt, sessionId);
            }
          }
          const errorText = await response.text().catch(() => response.statusText);
          if (process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true') {
            console.log(`[Anthropic OAuth] API error: ${response.status} - ${errorText}`);
          }
          return null;
        }

        const data = await response.json() as any;
        const content = (data?.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
        const usage = data?.usage || {};
        if (!content) return null;
        return {
          success: true,
          result: content,
          model: oauthModel,
          providerId: 'anthropic-oauth',
          promptTokens: usage.input_tokens,
          completionTokens: usage.output_tokens,
          costUsd: this.calculateAnthropicCostWithCache(usage)
        };
      }

      if (process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true') console.log(`[Anthropic] Starting API call (model: ${model})...`);
      const callStart = Date.now();

      // Use explicit cache control for 90% savings on system prompt
      const stream = !isStreamingDisabled();
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': auth.token,
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
    const auth = await this.resolveProviderAuth('openai');
    if (!auth) {
      if (process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true') console.log('[OpenAI] No API key found');
      return null;
    }

    const model = options.model || (auth.isOAuth ? String(process.env.CREW_OAUTH_OPENAI_MODEL || 'gpt-5.4') : 'gpt-4o');
    
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
      const apiUrl = auth.apiUrl || 'https://api.openai.com/v1/chat/completions';
      const isCodexOAuth = auth.isOAuth && apiUrl === OPENAI_CODEX_API_URL;
      const stream = !isStreamingDisabled() && !options.jsonMode && !isCodexOAuth;

      const requestBody: any = isCodexOAuth
        ? {
            model,
            instructions: systemPrompt,
            input: [
              {
                role: 'user',
                content: [
                  { type: 'input_text', text: task }
                ]
              }
            ],
            store: false,
            stream: true
          }
        : {
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: task }
            ],
            temperature: temp,
            [maxTokensParam]: options.maxTokens || 4000,
            ...(stream ? { stream: true, stream_options: { include_usage: true } } : {})
          };

      if (options.jsonMode && !isCodexOAuth) {
        requestBody.response_format = { type: 'json_object' };
      }

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${auth.token}`,
          'Content-Type': 'application/json'
        },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify(requestBody)
      });

      if (process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true') console.log(`[OpenAI] Response received (status: ${response.status})`);

      if (!response.ok) {
        if (response.status === 401 && auth.isOAuth) {
          const refreshed = await forceRefreshOpenAIOAuth();
          if (refreshed?.accessToken && refreshed.accessToken !== auth.token) {
            return this.executeWithOpenAI(task, options, systemPrompt, sessionId);
          }
        }
        const errorText = await response.text();
        console.log(`[OpenAI] API error: ${response.status} - ${errorText}`);
        return null;
      }

      if (isCodexOAuth && response.body) {
        const result = await this.streamOpenAIResponsesOAuth(response);
        if (result.text) process.stdout.write('\n');
        const usage = result.usage || {};
        return {
          success: true,
          result: result.text,
          model,
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          cachedTokens: 0,
          costUsd: this.calculateOpenAICost(model, usage.prompt_tokens || 0, usage.completion_tokens || 0)
        };
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
      const content = isCodexOAuth
        ? this.extractOpenAIResponsesText(data)
        : data?.choices?.[0]?.message?.content;

      if (!content) {
        console.log('[OpenAI] No content in response');
        return null;
      }

      const usage = isCodexOAuth
        ? {
            prompt_tokens: data?.usage?.input_tokens,
            completion_tokens: data?.usage?.output_tokens
          }
        : data?.usage;

      if (process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true') console.log(`[OpenAI] ✓ Success (${usage?.prompt_tokens || 0} in, ${usage?.completion_tokens || 0} out)`);

      return {
        success: true,
        result: content,
        model,
        promptTokens: usage?.prompt_tokens,
        completionTokens: usage?.completion_tokens,
        cachedTokens: 0,
        costUsd: this.calculateOpenAICost(model, usage?.prompt_tokens || 0, usage?.completion_tokens || 0)
      };
    } catch (err) {
      if (process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true') console.log(`[OpenAI] Exception: ${(err as Error).message}`);
      this.logger.debug(`OpenAI execution failed: ${(err as Error).message}`);
      return null;
    }
  }

  private extractOpenAIResponsesText(data: any): string {
    if (typeof data?.output_text === 'string' && data.output_text.trim()) {
      return data.output_text;
    }

    const outputs = Array.isArray(data?.output) ? data.output : [];
    const textParts: string[] = [];
    for (const item of outputs) {
      const contents = Array.isArray(item?.content) ? item.content : [];
      for (const content of contents) {
        if (typeof content?.text === 'string' && content.text) {
          textParts.push(content.text);
        }
      }
    }
    return textParts.join('\n').trim();
  }

  private async streamOpenAIResponsesOAuth(response: Response): Promise<{ text: string; usage?: { prompt_tokens?: number; completion_tokens?: number } }> {
    if (!response.body) {
      return { text: '' };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const functionCalls = new Map<string, { name: string; args: string }>();
    let buffer = '';
    let currentEvent = '';
    let text = '';
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;

    const flushEvent = (rawData: string) => {
      if (!rawData.trim()) return;
      let payload: any;
      try {
        payload = JSON.parse(rawData);
      } catch {
        return;
      }

      const eventType = currentEvent || payload?.type || '';
      const item = payload?.item || payload?.output_item;
      const itemId = item?.id || payload?.item_id || payload?.call_id || '';

      if (eventType === 'response.output_text.delta' && typeof payload?.delta === 'string') {
        process.stdout.write(payload.delta);
        text += payload.delta;
        return;
      }

      if (eventType === 'response.function_call_arguments.delta' && itemId) {
        if (!functionCalls.has(itemId)) {
          functionCalls.set(itemId, { name: '', args: '' });
        }
        const acc = functionCalls.get(itemId)!;
        acc.args += String(payload?.delta || '');
        return;
      }

      if ((eventType === 'response.output_item.added' || eventType === 'response.output_item.done') && item?.type === 'function_call') {
        if (!functionCalls.has(itemId)) {
          functionCalls.set(itemId, { name: '', args: '' });
        }
        const acc = functionCalls.get(itemId)!;
        if (item?.name) acc.name = item.name;
        if (typeof item?.arguments === 'string') acc.args = item.arguments;
        return;
      }

      if (eventType === 'response.completed') {
        usage = {
          prompt_tokens: payload?.response?.usage?.input_tokens,
          completion_tokens: payload?.response?.usage?.output_tokens
        };
        if (!text) {
          text = this.extractOpenAIResponsesText(payload?.response);
        }
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const chunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          const lines = chunk.split('\n');
          currentEvent = '';
          const dataLines: string[] = [];
          for (const line of lines) {
            if (line.startsWith('event:')) currentEvent = line.slice(6).trim();
            if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          flushEvent(dataLines.join('\n'));
          boundary = buffer.indexOf('\n\n');
        }
      }
    } finally {
      reader.releaseLock();
    }

    return { text: text.trim(), usage };
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
