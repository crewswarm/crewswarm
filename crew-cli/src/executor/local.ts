/**
 * Local LLM executor - runs tasks without gateway dependency
 * This is the standalone Tier 2 executor that handles tasks directly
 */

import { Logger } from '../utils/logger.js';

export interface ExecutorOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;  // Override default executor prompt with specialized persona
}

export interface ExecutorResult {
  success: boolean;
  result: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
}

const EXECUTOR_SYSTEM_PROMPT = `You are a skilled AI engineer and coding assistant.

You execute tasks directly and provide actionable results. You can:
- Answer technical questions clearly
- Write, edit, and explain code
- Provide step-by-step guidance
- Make architectural recommendations

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
    } else if (model.includes('llama') || model.includes('mixtral')) {
      providers = ['groq', 'grok', 'deepseek'];  // Try multiple for generic models
    } else {
      // Generic/unknown model - try all providers
      providers = ['grok', 'gemini', 'deepseek'];
    }
    
    const failures: string[] = [];
    
    for (const provider of providers) {
      try {
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
      XAI: !!process.env.XAI_API_KEY,
      GEMINI: !!process.env.GEMINI_API_KEY,
      DEEPSEEK: !!process.env.DEEPSEEK_API_KEY
    }));
    
    throw new Error('No LLM providers available. Set XAI_API_KEY, GEMINI_API_KEY, or DEEPSEEK_API_KEY');
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
      case 'groq':
        return this.executeWithGroq(task, options, systemPrompt);
      case 'grok':
        return this.executeWithGrok(task, options, systemPrompt);
      case 'gemini':
        return this.executeWithGemini(task, options, systemPrompt);
      case 'deepseek':
        return this.executeWithDeepSeek(task, options, systemPrompt);
      default:
        return null;
    }
  }

  private async executeWithGroq(task: string, options: ExecutorOptions, systemPrompt: string): Promise<ExecutorResult | null> {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return null;

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
          max_tokens: options.maxTokens || 2000
        })
      });

      if (!response.ok) {
        throw new Error(`Groq API error: ${response.statusText}`);
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

  private async executeWithGrok(task: string, options: ExecutorOptions, systemPrompt: string): Promise<ExecutorResult | null> {
    const key = process.env.XAI_API_KEY;
    if (!key) return null;

    // Use model from env or options, fallback to grok-4-1-fast-reasoning
    const model = options.model || process.env.CREW_EXECUTION_MODEL || 'grok-4-1-fast-reasoning';

    try {
      console.log(`[Grok] Starting API call (model: ${model})...`);
      const callStart = Date.now();
      
      const response = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`
        },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: task }
          ],
          temperature: options.temperature || 0.7,
          max_tokens: options.maxTokens || 4000
        })
      });

      console.log(`[Grok] Response received in ${Date.now() - callStart}ms (status: ${response.status})`);

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        console.log(`[Grok] API error: ${response.status} - ${errorText}`);
        return null;
      }

      const data = await response.json() as any;
      const content = data?.choices?.[0]?.message?.content;
      if (!content) return null;

      return {
        success: true,
        result: content,
        model,
        promptTokens: data?.usage?.prompt_tokens,
        completionTokens: data?.usage?.completion_tokens,
        costUsd: this.calculateCost(model, data?.usage?.prompt_tokens || 0, data?.usage?.completion_tokens || 0)
      };
    } catch (err) {
      console.log(`[Grok] Exception: ${(err as Error).message}`);
      this.logger.debug(`Grok execution failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async executeWithGemini(task: string, options: ExecutorOptions, systemPrompt: string): Promise<ExecutorResult | null> {
    const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!key) {
      console.log('[Gemini] No API key found');
      return null;
    }

    const model = options.model || this.getDefaultModel();
    console.log(`[Gemini] Starting API call (model: ${model})...`);

    // Detect if task expects JSON output
    const expectsJson = task.toLowerCase().includes('return') && 
                       (task.includes('JSON') || task.includes('json') || task.includes('{'));
    
    if (expectsJson) {
      console.log('[Gemini] Detected JSON request, enabling JSON mode');
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

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(this.timeoutMs),
          body: JSON.stringify(requestBody)
        }
      );

      console.log(`[Gemini] Response received (status: ${response.status})`);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.log(`[Gemini] API error: ${response.status} - ${errorText}`);
        return null;
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
      console.log('[DeepSeek] No API key found');
      return null;
    }

    const model = options.model || 'deepseek-chat';
    
    // For deepseek-reasoner on large tasks, allow much longer timeout
    const timeoutMs = model.includes('reasoner') && (options.maxTokens || 0) > 6000
      ? 10 * 60 * 1000  // 10 minutes for large reasoning tasks
      : this.timeoutMs;
    
    console.log(`[DeepSeek] Starting API call (model: ${model}, timeout: ${timeoutMs/1000}s)...`);

    try {
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
          max_tokens: options.maxTokens || 4000
        })
      });

      console.log(`[DeepSeek] Response received (status: ${response.status})`);

      if (!response.ok) {
        const errorText = await response.text();
        console.log(`[DeepSeek] API error: ${response.status} - ${errorText}`);
        return null;
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
      console.log(`[DeepSeek] ✓ Success (${data?.usage?.prompt_tokens || 0} in, ${data?.usage?.completion_tokens || 0} out)`);

      return {
        success: true,
        result: content,
        model: model,
        promptTokens: data?.usage?.prompt_tokens,
        completionTokens: data?.usage?.completion_tokens,
        costUsd: this.calculateCost(model, data?.usage?.prompt_tokens || 0, data?.usage?.completion_tokens || 0)
      };
    } catch (err) {
      console.log(`[DeepSeek] Exception: ${(err as Error).message}`);
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
      'deepseek-reasoner': { prompt: 0.55, completion: 2.19 }
    };

    const rates = pricing[model] || { prompt: 1, completion: 3 };
    return (promptTokens * rates.prompt + completionTokens * rates.completion) / 1_000_000;
  }
}
