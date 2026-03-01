/**
 * Dual-Tier Level 2 Planning System
 * L2A: Decomposer - breaks complex tasks into work graphs
 * L2B: Policy Validator - validates plans for risk/cost/compliance
 */

import { PromptComposer, PromptOverlay } from './registry.js';
import { LocalExecutor } from '../executor/local.js';
import { Logger } from '../utils/logger.js';

export interface WorkUnit {
  id: string;
  description: string;
  requiredPersona: string;
  dependencies: string[];
  estimatedComplexity: 'low' | 'medium' | 'high';
  requiredCapabilities: string[];
}

export interface WorkGraph {
  units: WorkUnit[];
  totalComplexity: number;
  requiredPersonas: string[];
  estimatedCost: number;
}

export interface PolicyValidation {
  approved: boolean;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  concerns: string[];
  recommendations: string[];
  fallbackStrategy?: string;
  estimatedCost: number;
}

export interface DualL2Result {
  workGraph: WorkGraph;
  validation: PolicyValidation;
  traceId: string;
  executionPath: string[];
}

export class DualL2Planner {
  private logger = new Logger();
  private composer = new PromptComposer();
  private executor = new LocalExecutor();

  /**
   * Run dual-tier Level 2 planning
   * L2A: Decompose task into work graph
   * L2B: Validate work graph against policy
   */
  async plan(
    task: string,
    context: string = '',
    traceId: string
  ): Promise<DualL2Result> {
    const executionPath: string[] = ['dual-l2-planner'];

    try {
      // L2A: Decomposer - break down the task
      executionPath.push('l2a-decomposer');
      const workGraph = await this.decompose(task, context, traceId);

      // L2B: Policy Validator - validate the plan
      executionPath.push('l2b-policy-validator');
      const validation = await this.validate(workGraph, task, traceId);

      return {
        workGraph,
        validation,
        traceId,
        executionPath
      };
    } catch (err) {
      this.logger.error(`Dual-L2 planning failed: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * L2A: Decompose task into work graph
   */
  private async decompose(
    task: string,
    context: string,
    traceId: string
  ): Promise<WorkGraph> {
    const overlays: PromptOverlay[] = [
      {
        type: 'task',
        content: `User task: ${task}`,
        priority: 1
      }
    ];

    if (context) {
      overlays.push({
        type: 'context',
        content: `Context:\n${context}`,
        priority: 2
      });
    }

    overlays.push({
      type: 'constraints',
      content: `Return ONLY valid JSON with this structure:
{
  "units": [
    {
      "id": "unique-id",
      "description": "what to do",
      "requiredPersona": "executor-code|executor-chat|specialist-qa|specialist-pm|specialist-security|specialist-frontend|specialist-backend|specialist-research|specialist-ml|specialist-github|specialist-docs|crew-coder|crew-coder-front|crew-coder-back|crew-frontend|crew-qa|crew-fixer|crew-security|crew-pm|crew-main|crew-orchestrator|orchestrator|crew-architect|crew-researcher|crew-copywriter|crew-seo|crew-ml|crew-github|crew-mega|crew-telegram|crew-whatsapp",
      "dependencies": ["id1", "id2"],
      "estimatedComplexity": "low|medium|high",
      "requiredCapabilities": ["code-generation", "testing", etc]
    }
  ],
  "totalComplexity": 1-10,
  "requiredPersonas": ["list", "of", "personas"],
  "estimatedCost": 0.001
}`,
      priority: 3
    });

    const composedPrompt = this.composer.compose('decomposer-v1', overlays, traceId);

    const result = await this.executor.execute(composedPrompt.finalPrompt, {
      temperature: 0.3,
      maxTokens: 2000
    });

    if (!result.success) {
      throw new Error(`Decomposer failed: ${result.result}`);
    }

    // Parse JSON response
    const jsonStart = result.result.indexOf('{');
    const jsonEnd = result.result.lastIndexOf('}');
    if (jsonStart < 0 || jsonEnd < 0) {
      throw new Error('Decomposer did not return valid JSON');
    }

    const workGraph: WorkGraph = JSON.parse(result.result.slice(jsonStart, jsonEnd + 1));
    return workGraph;
  }

  /**
   * L2B: Validate work graph against policy
   */
  private async validate(
    workGraph: WorkGraph,
    originalTask: string,
    traceId: string
  ): Promise<PolicyValidation> {
    const overlays: PromptOverlay[] = [
      {
        type: 'safety',
        content: `Original task: ${originalTask}

Work graph to validate:
${JSON.stringify(workGraph, null, 2)}

Validate for:
1. Security risks (file access, network calls, code execution)
2. Resource costs (estimated tokens, time, API calls)
3. Capability requirements (are required capabilities available?)
4. Fallback strategy (what if a unit fails?)

Return ONLY valid JSON:
{
  "approved": true|false,
  "riskLevel": "low|medium|high|critical",
  "concerns": ["list", "of", "concerns"],
  "recommendations": ["list", "of", "recommendations"],
  "fallbackStrategy": "what to do if this fails",
  "estimatedCost": 0.001
}`,
        priority: 1
      },
      {
        type: 'constraints',
        content: `Cost limit: $0.50 per task
Risk tolerance: medium
Required capabilities must exist in capability matrix
No unapproved file system access`,
        priority: 2
      }
    ];

    const composedPrompt = this.composer.compose('policy-validator-v1', overlays, traceId);

    const result = await this.executor.execute(composedPrompt.finalPrompt, {
      temperature: 0.1,
      maxTokens: 1000
    });

    if (!result.success) {
      throw new Error(`Policy validator failed: ${result.result}`);
    }

    // Parse JSON response
    const jsonStart = result.result.indexOf('{');
    const jsonEnd = result.result.lastIndexOf('}');
    if (jsonStart < 0 || jsonEnd < 0) {
      throw new Error('Policy validator did not return valid JSON');
    }

    const validation: PolicyValidation = JSON.parse(result.result.slice(jsonStart, jsonEnd + 1));
    return validation;
  }

  /**
   * Get composed prompts for trace debugging
   */
  getTrace(traceId: string) {
    return this.composer.getTrace(traceId);
  }
}
