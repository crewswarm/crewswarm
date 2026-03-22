import { Logger } from '../utils/logger.js';
import { SessionManager } from '../session/manager.js';
import { TokenCache } from '../cache/token-cache.js';
import { AgentKeeper } from '../memory/agentkeeper.js';
import { DualL2Planner, WorkGraph, DualL2Result } from '../prompts/dual-l2.js';
import { randomBytes } from 'crypto';

export interface PlanStep {
  id: number;
  task: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  persona?: string;
  complexity?: 'low' | 'medium' | 'high';
  dependencies?: number[];
  sourceRefs?: string[];
}

export interface Plan {
  title: string;
  steps: PlanStep[];
  artifacts?: {
    pdd: string;
    roadmap: string;
    architecture: string;
    scaffold: string;
    contractTests: string;
    definitionOfDone: string;
    goldenBenchmarks: string;
    outputDir: string;
  };
  validation?: {
    approved: boolean;
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    concerns: string[];
    recommendations: string[];
    estimatedCost: number;
  };
  traceId?: string;
}

export class Planner {
  private logger = new Logger();
  private cache: TokenCache;
  private keeper: AgentKeeper;
  private dualL2: DualL2Planner;

  constructor(
    _unusedRouter: any, // Keep signature for compatibility
    private session?: SessionManager,
    baseDir = process.cwd()
  ) {
    this.cache = new TokenCache(baseDir);
    this.keeper = new AgentKeeper(baseDir);
    this.dualL2 = new DualL2Planner();
  }

  /**
   * Generate a plan using Dual L2 system (L2 Reasoning → L2A Decomposer → L2B Validator)
   */
  async generatePlan(
    task: string,
    options: {
      useCache?: boolean;
      cacheTtlSeconds?: number;
      useMemory?: boolean;
      memoryMaxResults?: number;
      runId?: string;
    } = {}
  ): Promise<Plan> {
    const traceId = `plan-${randomBytes(8).toString('hex')}`;
    const useMemory = options.useMemory !== false;
    let memoryContext = '';

    // Recall similar successful tasks from memory
    if (useMemory) {
      const matches = await this.keeper.recall(task, Number(options.memoryMaxResults || 3), {
        preferSuccessful: true
      });
      const avgScore = matches.length
        ? matches.reduce((sum, m) => sum + Number(m.score || 0), 0) / matches.length
        : 0;
      await this.session?.trackMemoryRecall({
        used: true,
        miss: matches.length === 0,
        matchCount: matches.length,
        qualityScore: avgScore
      });
      if (matches.length > 0) {
        memoryContext = await this.keeper.recallAsContext(task, Number(options.memoryMaxResults || 3), {
          preferSuccessful: true
        });
      }
    }

    // Check cache
    const useCache = options.useCache !== false;
    const cacheKey = TokenCache.hashKey(JSON.stringify({
      system: 'dual-l2-planner',
      task,
      memoryContext: memoryContext.slice(0, 200) // Truncate for cache key
    }));

    if (useCache) {
      const cached = await this.cache.get<Plan>('planner', cacheKey);
      if (cached.hit && cached.value) {
        await this.session?.trackCacheSavings({
          hit: true,
          tokensSaved: Number(cached.meta?.tokensSaved || 0),
          usdSaved: Number(cached.meta?.usdSaved || 0)
        });
        this.logger.info('🎯 Dual L2 planner cache hit.');
        return cached.value;
      }
      await this.session?.trackCacheSavings({ miss: true });
    }

    // Run Dual L2 planning pipeline
    this.logger.info('🚀 Starting Dual L2 planning pipeline...');
    this.logger.info(`   L2 Reasoning → L2A Decomposer → L2B Validator`);

    const result: DualL2Result = await this.dualL2.plan(task, memoryContext, traceId);

    // Convert work graph to plan steps
    const steps = this.convertWorkGraphToSteps(result.workGraph);

    const plan: Plan = {
      title: `Plan for: ${task.slice(0, 50)}...`,
      steps,
      artifacts: result.artifacts ? {
        pdd: result.artifacts.pdd,
        roadmap: result.artifacts.roadmap,
        architecture: result.artifacts.architecture,
        scaffold: result.artifacts.scaffold,
        contractTests: result.artifacts.contractTests,
        definitionOfDone: result.artifacts.definitionOfDone,
        goldenBenchmarks: result.artifacts.goldenBenchmarks,
        outputDir: result.artifacts.outputDir
      } : undefined,
      validation: result.validation,
      traceId: result.traceId
    };

    // Log validation results
    if (result.validation) {
      const emoji = result.validation.approved ? '✅' : '⚠️';
      this.logger.info(`${emoji} L2B Validation: ${result.validation.riskLevel.toUpperCase()} risk`);
      if (result.validation.concerns.length > 0) {
        this.logger.warn(`   Concerns: ${result.validation.concerns.join(', ')}`);
      }
      if (result.validation.recommendations.length > 0) {
        this.logger.info(`   Recommendations: ${result.validation.recommendations.join(', ')}`);
      }
    }

    // Save to memory
    if (useMemory && steps.length > 0) {
      const saved = await this.keeper.recordSafe({
        runId: options.runId || traceId,
        tier: 'dual-l2-planner',
        task,
        result: JSON.stringify(plan, null, 2),
        agent: 'dual-l2-system',
        metadata: {
          steps: steps.length,
          riskLevel: result.validation?.riskLevel,
          approved: result.validation?.approved,
          artifactsDir: result.artifacts?.outputDir
        }
      });
      if (!saved.ok) {
        this.logger.warn(`Planner memory write skipped: ${saved.error}`);
      }
    }

    // Cache the result
    if (useCache) {
      const estimatedTokens = Math.ceil(
        (task.length + memoryContext.length + JSON.stringify(plan).length) / 4
      );
      const usdSaved = estimatedTokens / 1_000_000 * 0.01; // Rough estimate
      await this.cache.set(
        'planner',
        cacheKey,
        plan,
        Number(options.cacheTtlSeconds || 3600),
        { tokensSaved: estimatedTokens, usdSaved, source: 'dual-l2-planner' }
      );
    }

    return plan;
  }

  async planFeature(description: string): Promise<Plan> {
    return this.generatePlan(description);
  }

  /**
   * Convert work graph from Dual L2 to legacy Plan format
   */
  private convertWorkGraphToSteps(workGraph: WorkGraph): PlanStep[] {
    const steps: PlanStep[] = [];
    const units = workGraph.units || [];

    // Build dependency map (unit.id -> step.id)
    const unitIdToStepId = new Map<string, number>();
    units.forEach((unit, idx) => {
      unitIdToStepId.set(unit.id, idx + 1);
    });

    units.forEach((unit, idx) => {
      const stepDeps = (unit.dependencies || [])
        .map(depId => unitIdToStepId.get(depId))
        .filter((id): id is number => id !== undefined);

      steps.push({
        id: idx + 1,
        task: unit.description,
        status: 'pending',
        persona: unit.requiredPersona,
        complexity: unit.estimatedComplexity,
        dependencies: stepDeps.length > 0 ? stepDeps : undefined,
        sourceRefs: unit.sourceRefs
      });
    });

    return steps;
  }
}
