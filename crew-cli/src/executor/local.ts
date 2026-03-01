/**
 * Local LLM executor - runs tasks without gateway dependency
 * This is the standalone Tier 2 executor that handles tasks directly
 */

import { Logger } from '../utils/logger.js';

export interface ExecutorOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
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

  /**
   * Execute a task using local LLM (no gateway required)
   */
  async execute(task: string, options: ExecutorOptions = {}): Promise<ExecutorResult> {
    const model = options.model || this.getDefaultModel();
    
    // Try models in priority order
    const providers = ['grok', 'gemini', 'deepseek'];
    
    for (const provider of providers) {
      try {
        const result = await this.executeWithProvider(provider, task, model, options);
        if (result) return result;
      } catch (err) {
        this.logger.debug(`Provider ${provider} failed: ${(err as Error).message}`);
      }
    }
    
    throw new Error('No LLM providers available. Set XAI_API_KEY, GEMINI_API_KEY, or DEEPSEEK_API_KEY');
  }

  private getDefaultModel(): string {
    if (process.env.XAI_API_KEY) return 'grok-beta';
    if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return 'gemini-2.0-flash-exp';
    if (process.env.DEEPSEEK_API_KEY) return 'deepseek-chat';
    return 'grok-beta';
  }

  private async executeWithProvider(
    provider: string,
    task: string,
    model: string,
    options: ExecutorOptions
  ): Promise<ExecutorResult | null> {
    switch (provider) {
      case 'groq':
        return this.executeWithGroq(task, options);
      case 'grok':
        return this.executeWithGrok(task, options);
      case 'gemini':
        return this.executeWithGemini(task, options);
      case 'deepseek':
        return this.executeWithDeepSeek(task, options);
      default:
        return null;
    }
  }

  private async executeWithGroq(task: string, options: ExecutorOptions): Promise<ExecutorResult | null> {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return null;

    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: task }],
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
        cost,
        model: 'llama-3.3-70b-versatile',
        provider: 'groq'
      };
    } catch (err) {
      this.logger.error(`Groq execution failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async executeWithGrok(task: string, options: ExecutorOptions): Promise<ExecutorResult | null> {
    const key = process.env.XAI_API_KEY;
    if (!key) return null;

    try {
      const response = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`
        },
        body: JSON.stringify({
          model: 'grok-beta',
          messages: [
            { role: 'system', content: EXECUTOR_SYSTEM_PROMPT },
            { role: 'user', content: task }
          ],
          temperature: options.temperature || 0.7,
          max_tokens: options.maxTokens || 4000
        })
      });

      if (!response.ok) return null;

      const data = await response.json() as any;
      const content = data?.choices?.[0]?.message?.content;
      if (!content) return null;

      return {
        success: true,
        result: content,
        model: 'grok-beta',
        promptTokens: data?.usage?.prompt_tokens,
        completionTokens: data?.usage?.completion_tokens,
        costUsd: this.calculateCost('grok-beta', data?.usage?.prompt_tokens || 0, data?.usage?.completion_tokens || 0)
      };
    } catch (err) {
      this.logger.debug(`Grok execution failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async executeWithGemini(task: string, options: ExecutorOptions): Promise<ExecutorResult | null> {
    const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!key) return null;

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [{
                text: `${EXECUTOR_SYSTEM_PROMPT}\n\nUser task: ${task}`
              }]
            }],
            generationConfig: {
              temperature: options.temperature || 0.7,
              maxOutputTokens: options.maxTokens || 4000
            }
          })
        }
      );

      if (!response.ok) return null;

      const data = await response.json() as any;
      const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!content) return null;

      return {
        success: true,
        result: content,
        model: 'gemini-2.0-flash-exp',
        promptTokens: data?.usageMetadata?.promptTokenCount,
        completionTokens: data?.usageMetadata?.candidatesTokenCount,
        costUsd: this.calculateCost('gemini-2.0-flash-exp', 
          data?.usageMetadata?.promptTokenCount || 0,
          data?.usageMetadata?.candidatesTokenCount || 0)
      };
    } catch (err) {
      this.logger.debug(`Gemini execution failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async executeWithDeepSeek(task: string, options: ExecutorOptions): Promise<ExecutorResult | null> {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) return null;

    try {
      const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: EXECUTOR_SYSTEM_PROMPT },
            { role: 'user', content: task }
          ],
          temperature: options.temperature || 0.7,
          max_tokens: options.maxTokens || 4000
        })
      });

      if (!response.ok) return null;

      const data = await response.json() as any;
      const content = data?.choices?.[0]?.message?.content;
      if (!content) return null;

      return {
        success: true,
        result: content,
        model: 'deepseek-chat',
        promptTokens: data?.usage?.prompt_tokens,
        completionTokens: data?.usage?.completion_tokens,
        costUsd: this.calculateCost('deepseek-chat', data?.usage?.prompt_tokens || 0, data?.usage?.completion_tokens || 0)
      };
    } catch (err) {
      this.logger.debug(`DeepSeek execution failed: ${(err as Error).message}`);
      return null;
    }
  }

  private calculateCost(model: string, promptTokens: number, completionTokens: number): number {
    // Rough pricing (per 1M tokens)
    const pricing: Record<string, { prompt: number; completion: number }> = {
      'grok-beta': { prompt: 5, completion: 15 },
      'gemini-2.0-flash-exp': { prompt: 0.075, completion: 0.30 },
      'deepseek-chat': { prompt: 0.27, completion: 1.10 }
    };

    const rates = pricing[model] || { prompt: 1, completion: 3 };
    return (promptTokens * rates.prompt + completionTokens * rates.completion) / 1_000_000;
  }
}
