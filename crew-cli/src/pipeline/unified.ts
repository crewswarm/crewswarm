/**
 * Unified 3-Tier Pipeline
 * 
 * L1: Chat Interface (REPL/CLI) - User interaction only
 * L2: Router + Reasoner + Planner - Unified orchestration layer
 * L3: Parallel Executors - Specialized workers
 */

import { LocalExecutor } from '../executor/local.js';
import { DualL2Planner, WorkGraph, PolicyValidation } from '../prompts/dual-l2.js';
import { PromptComposer, PromptOverlay, getTemplateForPersona } from '../prompts/registry.js';
import { Logger } from '../utils/logger.js';
import { randomUUID } from 'crypto';

export interface L1Request {
  userInput: string;
  context?: string;
  sessionId: string;
}

export interface L2Plan {
  decision: 'direct-answer' | 'execute-local' | 'execute-parallel';
  reasoning: string;
  workGraph?: WorkGraph;
  validation?: PolicyValidation;
  directResponse?: string;
  traceId: string;
}

export interface L3Result {
  success: boolean;
  results: Array<{
    workUnitId: string;
    persona: string;
    output: string;
    cost: number;
  }>;
  totalCost: number;
  executionTimeMs: number;
}

export interface PipelineResult {
  response: string;
  executionPath: string[];
  plan?: L2Plan;
  executionResults?: L3Result;
  totalCost: number;
  traceId: string;
}

/**
 * Unified Pipeline - Single path for all operations
 */
export class UnifiedPipeline {
  private logger = new Logger();
  private composer = new PromptComposer();
  private executor = new LocalExecutor();
  private planner = new DualL2Planner();

  /**
   * Execute request through unified pipeline
   */
  async execute(request: L1Request): Promise<PipelineResult> {
    const traceId = `pipeline-${randomUUID()}`;
    const executionPath: string[] = ['l1-interface'];
    const startTime = Date.now();

    try {
      // L2: Router + Reasoner + Planner
      executionPath.push('l2-orchestrator');
      const plan = await this.l2Orchestrate(request, traceId);
      
      let response: string;
      let executionResults: L3Result | undefined;
      let totalCost = 0;

      // Execute based on L2 decision
      if (plan.decision === 'direct-answer') {
        executionPath.push('l2-direct-response');
        response = plan.directResponse || 'No response generated';
        totalCost = 0.0001; // Minimal cost for routing
      } 
      else if (plan.decision === 'execute-local') {
        executionPath.push('l3-executor-single');
        const result = await this.l3ExecuteSingle(
          request.userInput,
          request.context || '',
          traceId
        );
        response = result.output;
        totalCost = result.cost;
        executionResults = {
          success: true,
          results: [result],
          totalCost: result.cost,
          executionTimeMs: Date.now() - startTime
        };
      }
      else if (plan.decision === 'execute-parallel') {
        executionPath.push('l3-executor-parallel');
        executionResults = await this.l3ExecuteParallel(
          plan.workGraph!,
          request.context || '',
          traceId
        );
        response = this.synthesizeResults(executionResults);
        totalCost = executionResults.totalCost;
      }
      else {
        throw new Error(`Unknown decision: ${plan.decision}`);
      }

      return {
        response,
        executionPath,
        plan,
        executionResults,
        totalCost,
        traceId
      };
    } catch (err) {
      this.logger.error(`Pipeline execution failed: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * L2-only route planning for orchestrator integration.
   * This runs L2 reasoning (and optional dual-L2 planning) without executing L3 workers.
   */
  async routeOnly(request: L1Request): Promise<{
    decision: 'CHAT' | 'CODE' | 'DISPATCH';
    agent?: string;
    task?: string;
    response?: string;
    explanation?: string;
    traceId: string;
  }> {
    const traceId = `pipeline-${randomUUID()}`;
    const plan = await this.l2Orchestrate(request, traceId);

    if (plan.decision === 'direct-answer') {
      return {
        decision: 'CHAT',
        response: plan.directResponse || 'No response generated',
        explanation: plan.reasoning,
        traceId
      };
    }

    if (plan.decision === 'execute-local') {
      return {
        decision: 'CODE',
        agent: 'crew-coder',
        task: request.userInput,
        explanation: plan.reasoning,
        traceId
      };
    }

    return {
      decision: 'DISPATCH',
      agent: 'crew-main',
      task: request.userInput,
      explanation: plan.reasoning,
      traceId
    };
  }

  /**
   * L2: Unified Orchestration Layer
   * Combines routing + reasoning + planning into single decision
   */
  private async l2Orchestrate(
    request: L1Request,
    traceId: string
  ): Promise<L2Plan> {
    // Step 1: Router - classify the request
    const overlays: PromptOverlay[] = [
      {
        type: 'task',
        content: `User request: ${request.userInput}`,
        priority: 1
      }
    ];

    if (request.context) {
      overlays.push({
        type: 'context',
        content: `Context:\n${request.context}`,
        priority: 2
      });
    }

    overlays.push({
      type: 'constraints',
      content: `Analyze this request and decide:

1. DIRECT-ANSWER: Simple question, greeting, or status check
   → Provide immediate response
   
2. EXECUTE-LOCAL: Single-task execution (write code, refactor, etc)
   → Use local executor
   
3. EXECUTE-PARALLEL: Complex multi-step task requiring coordination
   → Use dual-L2 planner for work graph

Return ONLY valid JSON:
{
  "decision": "direct-answer|execute-local|execute-parallel",
  "reasoning": "why this path was chosen",
  "directResponse": "if direct-answer, provide response here",
  "complexity": "low|medium|high",
  "estimatedCost": 0.001
}`,
        priority: 3
      }
    );

    const composedPrompt = this.composer.compose('router-v1', overlays, traceId);
    const result = await this.executor.execute(composedPrompt.finalPrompt, {
      temperature: 0.3,
      maxTokens: 1000
    });

    if (!result.success) {
      throw new Error(`L2 orchestration failed: ${result.result}`);
    }

    // Parse routing decision
    const jsonStart = result.result.indexOf('{');
    const jsonEnd = result.result.lastIndexOf('}');
    if (jsonStart < 0 || jsonEnd < 0) {
      throw new Error('L2 did not return valid JSON');
    }

    const decision = JSON.parse(result.result.slice(jsonStart, jsonEnd + 1));

    // Step 2: If complex AND Dual-L2 enabled, run planner
    let workGraph: WorkGraph | undefined;
    let validation: PolicyValidation | undefined;

    const dualL2Enabled = process.env.CREW_DUAL_L2_ENABLED === 'true';

    if (decision.decision === 'execute-parallel' && dualL2Enabled) {
      const dualL2Result = await this.planner.plan(
        request.userInput,
        request.context || '',
        traceId
      );
      workGraph = dualL2Result.workGraph;
      validation = dualL2Result.validation;

      // HARD RISK GATE - Block critical risk tasks
      if (!validation.approved) {
        throw new Error(
          `Task rejected by policy validator:\n${validation.concerns.join('\n')}\n\n` +
          `Recommendations:\n${validation.recommendations.join('\n')}`
        );
      }

      const allowCritical = process.env.CREW_ALLOW_CRITICAL === 'true';
      if (validation.riskLevel === 'critical' && !allowCritical) {
        throw new Error(
          `CRITICAL RISK detected. Task blocked.\n${validation.concerns.join('\n')}\n` +
          `Use CREW_ALLOW_CRITICAL=true to override (not recommended).`
        );
      }
    }

    return {
      decision: decision.decision,
      reasoning: decision.reasoning,
      workGraph,
      validation,
      directResponse: decision.directResponse,
      traceId
    };
  }

  /**
   * L3: Single Executor
   */
  private async l3ExecuteSingle(
    task: string,
    context: string,
    traceId: string
  ): Promise<{
    workUnitId: string;
    persona: string;
    output: string;
    cost: number;
  }> {
    const overlays: PromptOverlay[] = [
      { type: 'task', content: task, priority: 1 }
    ];

    if (context) {
      overlays.push({ type: 'context', content: context, priority: 2 });
    }

    const composedPrompt = this.composer.compose('executor-code-v1', overlays, traceId);
    const result = await this.executor.execute(composedPrompt.finalPrompt, {
      temperature: 0.7,
      maxTokens: 4000
    });

    return {
      workUnitId: 'single-task',
      persona: 'executor-code',
      output: result.result,
      cost: result.costUsd || 0
    };
  }

  /**
   * L3: Parallel Executors
   * Execute work units in dependency order with parallelization
   */
  private async l3ExecuteParallel(
    workGraph: WorkGraph,
    context: string,
    traceId: string
  ): Promise<L3Result> {
    // HARD COST GATE - Block before execution
    if (workGraph.estimatedCost > 0.50) {
      throw new Error(
        `Task cost $${workGraph.estimatedCost.toFixed(3)} exceeds limit ($0.50). ` +
        `Use /approve-cost to override or simplify the task.`
      );
    }

    const startTime = Date.now();
    const results: L3Result['results'] = [];
    const completed = new Set<string>();
    let totalCost = 0;

    // Sort work units by dependency order
    const sorted = this.topologicalSort(workGraph.units);

    // Execute in batches (units with no pending dependencies)
    for (const batch of this.getBatches(sorted)) {
      const batchPromises = batch.map(async (unit) => {
        // Check dependencies
        for (const depId of unit.dependencies) {
          if (!completed.has(depId)) {
            throw new Error(`Dependency ${depId} not completed for ${unit.id}`);
          }
        }

        // Resolve prompt template from persona registry (covers full standalone role set).
        const templateId = getTemplateForPersona(unit.requiredPersona);

        const overlays: PromptOverlay[] = [
          { type: 'task', content: unit.description, priority: 1 },
          { type: 'context', content: context, priority: 2 }
        ];

        const composedPrompt = this.composer.compose(templateId, overlays, `${traceId}-${unit.id}`);
        const result = await this.executor.execute(composedPrompt.finalPrompt, {
          temperature: 0.7,
          maxTokens: 4000
        });

        completed.add(unit.id);

        return {
          workUnitId: unit.id,
          persona: unit.requiredPersona,
          output: result.result,
          cost: result.costUsd || 0
        };
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
      totalCost += batchResults.reduce((sum, r) => sum + r.cost, 0);

      // HARD COST GATE - Check during execution
      if (totalCost > 0.50) {
        throw new Error(
          `Execution cost $${totalCost.toFixed(3)} exceeded limit ($0.50) during execution. ` +
          `Partial results saved but task aborted.`
        );
      }
    }

    return {
      success: true,
      results,
      totalCost,
      executionTimeMs: Date.now() - startTime
    };
  }

  /**
   * Topological sort for dependency ordering
   */
  private topologicalSort(units: WorkGraph['units']): typeof units {
    const sorted: typeof units = [];
    const visited = new Set<string>();
    const temp = new Set<string>();

    const visit = (unitId: string) => {
      if (temp.has(unitId)) {
        throw new Error(`Circular dependency detected: ${unitId}`);
      }
      if (visited.has(unitId)) return;

      temp.add(unitId);

      const unit = units.find(u => u.id === unitId);
      if (!unit) throw new Error(`Unit not found: ${unitId}`);

      for (const depId of unit.dependencies) {
        visit(depId);
      }

      temp.delete(unitId);
      visited.add(unitId);
      sorted.push(unit);
    };

    for (const unit of units) {
      if (!visited.has(unit.id)) {
        visit(unit.id);
      }
    }

    return sorted;
  }

  /**
   * Group units into parallel execution batches
   */
  private getBatches(sortedUnits: WorkGraph['units']): Array<typeof sortedUnits> {
    const batches: Array<typeof sortedUnits> = [];
    const completed = new Set<string>();

    while (completed.size < sortedUnits.length) {
      const batch = sortedUnits.filter(unit => 
        !completed.has(unit.id) &&
        unit.dependencies.every(depId => completed.has(depId))
      );

      if (batch.length === 0) {
        throw new Error('Unable to resolve dependencies');
      }

      batches.push(batch);
      batch.forEach(unit => completed.add(unit.id));
    }

    return batches;
  }

  /**
   * Synthesize parallel results into coherent response
   */
  private synthesizeResults(results: L3Result): string {
    const sections = results.results.map(r => 
      `### ${r.persona} (${r.workUnitId})\n\n${r.output}`
    );

    return sections.join('\n\n---\n\n');
  }

  /**
   * Get execution trace
   */
  getTrace(traceId: string) {
    return {
      composedPrompts: this.composer.getTrace(traceId),
      plannerTrace: this.planner.getTrace(traceId)
    };
  }
}
