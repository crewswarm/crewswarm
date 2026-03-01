import { Logger } from '../utils/logger.js';
import { AgentRouter } from '../agent/router.js';
import { SessionManager } from '../session/manager.js';
import { TokenCache } from '../cache/token-cache.js';
import { AgentKeeper } from '../memory/agentkeeper.js';

export interface PlanStep {
  id: number;
  task: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

export interface Plan {
  title: string;
  steps: PlanStep[];
}

export class Planner {
  private logger = new Logger();
  private cache: TokenCache;
  private keeper: AgentKeeper;

  constructor(
    private router: AgentRouter,
    private session?: SessionManager,
    baseDir = process.cwd()
  ) {
    this.cache = new TokenCache(baseDir);
    this.keeper = new AgentKeeper(baseDir);
  }

  /**
   * Asks an agent to generate a plan for a given task.
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
    const useMemory = options.useMemory !== false;
    let memoryContext = '';
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
    const prompt = [
      `Develop a 5-10 step technical plan for the following task: "${task}".`,
      'Return the plan as a numbered list of discrete, actionable steps.',
      memoryContext
    ].filter(Boolean).join('\n\n');
    const useCache = options.useCache !== false;
    const cacheKey = TokenCache.hashKey(JSON.stringify({
      agent: 'crew-pm',
      task,
      prompt
    }));

    if (useCache) {
      const cached = await this.cache.get<{ output: string }>('planner', cacheKey);
      if (cached.hit && cached.value?.output) {
        await this.session?.trackCacheSavings({
          hit: true,
          tokensSaved: Number(cached.meta?.tokensSaved || 0),
          usdSaved: Number(cached.meta?.usdSaved || 0)
        });
        this.logger.info('Planner cache hit.');
        const steps = this.parsePlanOutput(cached.value.output);
        return {
          title: `Plan for: ${task.slice(0, 50)}...`,
          steps
        };
      }
      await this.session?.trackCacheSavings({ miss: true });
    }

    const result = await this.router.dispatch('crew-pm', prompt);
    const steps = this.parsePlanOutput(result.result);
    if (useMemory && steps.length > 0 && String(result.result || '').trim().length > 0) {
      const saved = await this.keeper.recordSafe({
        runId: options.runId || 'plan-run',
        tier: 'planner',
        task,
        result: String(result.result || ''),
        agent: 'crew-pm',
        metadata: {
          steps: steps.length
        }
      });
      if (!saved.ok) {
        this.logger.warn(`Planner memory write skipped: ${saved.error}`);
      }
    }
    if (useCache) {
      const tokensSaved = Math.ceil((String(prompt).length + String(result.result || '').length) / 4);
      const usdSaved = tokensSaved / 1_000_000;
      await this.cache.set(
        'planner',
        cacheKey,
        { output: String(result.result || '') },
        Number(options.cacheTtlSeconds || 3600),
        { tokensSaved, usdSaved, source: 'planner' }
      );
    }

    return {
      title: `Plan for: ${task.slice(0, 50)}...`,
      steps
    };
  }

  async planFeature(description: string): Promise<Plan> {
    return this.generatePlan(description);
  }

  private parsePlanOutput(output: string): PlanStep[] {
    const steps: PlanStep[] = [];
    const lines = output.split('\n');
    let id = 1;

    for (const line of lines) {
      const match = line.match(/^\d+[\.\)]\s+(.*)/);
      if (match) {
        steps.push({
          id: id++,
          task: match[1].trim(),
          status: 'pending'
        });
      }
    }

    // Fallback if no numbered list found
    if (steps.length === 0) {
      const parts = output.split('\n').filter(l => l.trim().length > 10);
      parts.slice(0, 8).forEach((part, i) => {
        steps.push({
          id: i + 1,
          task: part.trim(),
          status: 'pending'
        });
      });
    }

    return steps;
  }
}
