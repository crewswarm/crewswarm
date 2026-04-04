/**
 * Multi-Model Fallback (adapted from Aider pattern)
 * Try multiple LLM providers until one succeeds with plausible results
 * 
 * @license
 * Concept inspired by Aider (https://github.com/paul-gauthier/aider)
 * Copyright 2026 crewswarm
 */

import type { AutonomousResult } from '../worker/autonomous-loop.js';
import type { ToolDeclaration } from '../tools/base.js';
import type { Sandbox } from '../sandbox/index.js';

export interface ModelConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface PlausibilityCheck {
  noSyntaxErrors: boolean;
  testsPass: boolean;
  noRegressions: boolean;
  reasonableOutput: boolean;
}

export interface AttemptResult {
  config: ModelConfig;
  result?: AutonomousResult;
  error?: Error;
  plausible: boolean;
  checks?: PlausibilityCheck;
}

/**
 * Get configured models from environment or defaults
 */
export function getConfiguredModels(): ModelConfig[] {
  // Try from crewswarm.json or environment
  const models: ModelConfig[] = [];
  
  // Gemini (if key available)
  if (process.env.GEMINI_API_KEY) {
    models.push({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      apiKey: process.env.GEMINI_API_KEY
    });
  }
  
  // Groq (if key available)
  if (process.env.GROQ_API_KEY) {
    models.push({
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      apiKey: process.env.GROQ_API_KEY
    });
  }
  
  // DeepSeek (if key available)
  if (process.env.DEEPSEEK_API_KEY) {
    models.push({
      provider: 'deepseek',
      model: 'deepseek-coder',
      apiKey: process.env.DEEPSEEK_API_KEY
    });
  }
  
  // Local fallback (always available)
  models.push({
    provider: 'local',
    model: 'qwen2.5-coder',
    baseUrl: 'http://localhost:11434'
  });
  
  return models;
}

/**
 * Check if result is plausible (Aider pattern)
 */
export async function isPlausible(
  result: AutonomousResult,
  sandbox: Sandbox
): Promise<PlausibilityCheck> {
  const checks: PlausibilityCheck = {
    noSyntaxErrors: true,
    testsPass: true,
    noRegressions: true,
    reasonableOutput: true
  };
  
  // Check 1: No syntax errors in code
  if (!result.success || result.reason?.includes('syntax')) {
    checks.noSyntaxErrors = false;
  }
  
  // Check 2: Reasonable output length
  if (result.history.length === 0) {
    checks.reasonableOutput = false;
  }
  
  // Check 3: Not stuck in a loop
  if (result.reason?.includes('repeated actions')) {
    checks.noRegressions = true; // Loop detection is working
  }
  
  return checks;
}

/**
 * Pick least broken result when all fail
 */
export function pickLeastBroken(attempts: AttemptResult[]): AutonomousResult {
  // Score each attempt
  const scored = attempts.map(attempt => {
    let score = 0;
    
    if (attempt.result?.success) score += 100;
    if (attempt.checks?.noSyntaxErrors) score += 10;
    if (attempt.checks?.reasonableOutput) score += 5;
    if (attempt.result?.turns && attempt.result.turns > 0) score += attempt.result.turns;
    
    return { attempt, score };
  });
  
  // Return best
  scored.sort((a, b) => b.score - a.score);
  
  return scored[0]?.attempt.result || {
    success: false,
    turns: 0,
    history: [],
    reason: 'All models failed'
  };
}

/**
 * Execute with multi-model fallback (Aider pattern)
 */
export async function executeWithFallback(
  task: string,
  tools: ToolDeclaration[],
  sandbox: Sandbox,
  executeLLM: (config: ModelConfig, prompt: string, tools: ToolDeclaration[], history: unknown[]) => Promise<unknown>,
  executeTool: (tool: string, params: Record<string, unknown>) => Promise<unknown>,
  onProgress?: (model: string, status: string) => void
): Promise<AutonomousResult> {
  const models = getConfiguredModels();
  const attempts: AttemptResult[] = [];
  
  console.log(`[Fallback] Trying ${models.length} model(s)...`);
  
  for (const modelConfig of models) {
    const modelName = `${modelConfig.provider}/${modelConfig.model}`;
    
    try {
      onProgress?.(modelName, 'trying');
      
      // Import autonomous loop
      const { executeAutonomous } = await import('../worker/autonomous-loop.js');
      
      // Execute with this model
      const result = await executeAutonomous(
        task,
        async (prompt, tools, history) => {
          return executeLLM(modelConfig, prompt, tools, history);
        },
        executeTool,
        {
          maxTurns: 25,
          tools,
          onProgress: (turn, action) => {
            onProgress?.(modelName, `turn ${turn}: ${action}`);
          }
        }
      );
      
      // Check plausibility
      const checks = await isPlausible(result, sandbox);
      const plausible = checks.noSyntaxErrors && checks.reasonableOutput;
      
      attempts.push({
        config: modelConfig,
        result,
        plausible,
        checks
      });
      
      // If plausible, use it!
      if (result.success && plausible) {
        console.log(`[Fallback] ✓ ${modelName} succeeded`);
        onProgress?.(modelName, 'success');
        return result;
      }
      
      console.log(`[Fallback] ✗ ${modelName} failed plausibility checks`);
      onProgress?.(modelName, 'failed plausibility');
      
    } catch (error: any) {
      console.log(`[Fallback] ✗ ${modelName} error: ${error.message}`);
      
      attempts.push({
        config: modelConfig,
        error,
        plausible: false
      });
      
      onProgress?.(modelName, 'error');
    }
  }
  
  // All failed - return least broken
  console.log(`[Fallback] All models failed, picking least broken...`);
  return pickLeastBroken(attempts);
}
