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
import { ContextPackManager } from './context-pack.js';
import { getPipelineMemory } from './agent-memory.js';
import { appendFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseJsonObject, parseJsonObjectWithRepair } from '../utils/structured-json.js';
import { validatePolicyValidation, validateRouterDecision, validateWorkGraph } from '../utils/json-schemas.js';
import { recordJsonParseMetric } from '../metrics/json-parse.js';
import { PipelineRunState } from './run-state.js';
import { missingForRequiredCapabilities, resolveCapabilityMap } from '../capabilities/index.js';
// Structure analyzer temporarily disabled - file missing
// import { analyzeProjectStructure, formatStructureContext } from '../utils/structure-analyzer.js';

export interface L1Request {
  userInput: string;
  context?: string;
  sessionId: string;
  resume?: {
    fromPhase?: 'plan' | 'execute' | 'validate';
    priorPlan?: L2Plan;
    priorResponse?: string;
    priorExecutionResults?: L3Result;
  };
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
  metrics?: {
    contextChunksUsed: number;
    contextCharsSaved: number;
  };
}

export interface PipelineResult {
  response: string;
  executionPath: string[];
  plan?: L2Plan;
  executionResults?: L3Result;
  totalCost: number;
  traceId: string;
  phase: 'complete' | 'failed';
  timeline: Array<{ phase: string; ts: string; note?: string }>;
}

/**
 * Unified Pipeline - Single path for all operations
 */
export class UnifiedPipeline {
  private logger = new Logger();
  private composer = new PromptComposer();
  private executor = new LocalExecutor();
  private planner = new DualL2Planner();
  private contextPacks = new ContextPackManager();
  private sandbox: any;  // Injected Sandbox instance
  private session?: any;  // Optional SessionManager for cache tracking

  constructor(sandbox?: any, session?: any) {
    this.sandbox = sandbox;
    this.session = session;
  }

  private async trackCacheHit(cachedTokens: number, totalTokens: number, model: string) {
    if (!this.session || !cachedTokens || cachedTokens === 0) return;
    
    // Calculate savings based on provider
    let savingsRate = 0;
    if (model.startsWith('claude')) {
      savingsRate = 0.90;  // Anthropic: 90% savings on cached tokens
    } else if (model.startsWith('grok')) {
      savingsRate = 0.50;  // Grok: 50% savings on cached tokens
    } else if (model.startsWith('deepseek')) {
      savingsRate = 0.50;  // DeepSeek: estimated 50% savings
    } else if (model.startsWith('gemini')) {
      savingsRate = 0.50;  // Gemini: estimated 50% savings
    }
    
    if (savingsRate === 0) return;
    
    // Calculate USD saved (rough estimate based on model pricing)
    const baseRate = model.startsWith('claude') ? 3.00 : 
                     model.startsWith('grok') ? 5.00 :
                     model.startsWith('gemini') ? 0.075 : 0.27;
    const usdSaved = (cachedTokens * baseRate * savingsRate) / 1_000_000;
    
    await this.session.trackCacheSavings({
      hit: true,
      tokensSaved: cachedTokens,
      usdSaved
    });
  }

  private normalizeDecision(raw: string): 'direct-answer' | 'execute-local' | 'execute-parallel' {
    const value = String(raw || '').trim().toLowerCase();
    if (value === 'direct-answer' || value === 'chat') return 'direct-answer';
    if (value === 'execute-local' || value === 'code') return 'execute-local';
    if (value === 'execute-parallel' || value === 'dispatch') return 'execute-parallel';
    return 'execute-local';
  }

  private getReasoningModel(): string | undefined {
    const model = String(process.env.CREW_REASONING_MODEL || process.env.CREW_CHAT_MODEL || '').trim();
    return model || undefined;
  }
  
  private getRouterModel(): string | undefined {
    // Router needs structured JSON, so avoid pure reasoning models
    const routerModel = String(process.env.CREW_ROUTER_MODEL || '').trim();
    if (routerModel) return routerModel;
    
    // If CREW_REASONING_MODEL is a reasoning-only model (deepseek-reasoner, gemini-*-preview),
    // fall back to chat model for structured output
    const reasoningModel = String(process.env.CREW_REASONING_MODEL || '').trim();
    if (reasoningModel && 
        !reasoningModel.includes('deepseek-reasoner') && 
        !reasoningModel.includes('-preview')) {
      return reasoningModel;
    }
    
    // Default to chat model for structured decisions
    return String(process.env.CREW_CHAT_MODEL || '').trim() || undefined;
  }

  private getQaModel(): string | undefined {
    const model = String(process.env.CREW_QA_MODEL || process.env.CREW_REASONING_MODEL || '').trim();
    return model || undefined;
  }

  private getJsonRepairModel(): string | undefined {
    const explicit = String(process.env.CREW_JSON_REPAIR_MODEL || '').trim();
    if (explicit) return explicit;
    if (process.env.GROQ_API_KEY) return 'llama-3.3-70b-versatile';
    return this.getRouterModel() || this.getReasoningModel();
  }

  private getJsonParseAttempts(): number {
    const n = Number(process.env.CREW_JSON_PARSE_MAX_ATTEMPTS || 2);
    if (!Number.isFinite(n) || n < 1) return 2;
    return Math.min(4, Math.floor(n));
  }

  private qaLoopEnabled(): boolean {
    return process.env.CREW_QA_LOOP_ENABLED === 'true';
  }

  private scaffoldGateEnabled(): boolean {
    const raw = String(process.env.CREW_SCAFFOLD_GATE_ENABLED || 'true').trim().toLowerCase();
    return raw !== 'false' && raw !== '0' && raw !== 'off';
  }

  private definitionOfDoneEnabled(): boolean {
    const raw = String(process.env.CREW_DOD_GATE_ENABLED || 'true').trim().toLowerCase();
    return raw !== 'false' && raw !== '0' && raw !== 'off';
  }

  private goldenBenchmarkGateEnabled(): boolean {
    const raw = String(process.env.CREW_GOLDEN_BENCH_GATE_ENABLED || 'true').trim().toLowerCase();
    return raw !== 'false' && raw !== '0' && raw !== 'off';
  }

  private qaMaxRounds(): number {
    const value = Number(process.env.CREW_QA_MAX_ROUNDS || 2);
    if (!Number.isFinite(value) || value < 1) return 2;
    return Math.min(5, Math.floor(value));
  }

  private getExtraL2ValidatorModels(): string[] {
    const raw = String(process.env.CREW_L2_EXTRA_VALIDATORS || '').trim();
    if (!raw) return [];
    return raw
      .split(',')
      .map(v => v.trim())
      .filter(Boolean);
  }

  private getMaxParallelWorkers(): number {
    const raw = Number(process.env.CREW_MAX_PARALLEL_WORKERS || 6);
    if (!Number.isFinite(raw) || raw < 1) return 6;
    return Math.min(32, Math.floor(raw));
  }

  private parseWorkerOutput(raw: string): { output: string; summary?: string; edits?: string[]; validation?: string[] } {
    const text = String(raw || '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(text.slice(start, end + 1));
        const output = String(parsed.output || parsed.result || '').trim();
        if (output) {
          return {
            output,
            summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
            edits: Array.isArray(parsed.edits) ? parsed.edits.map(String) : undefined,
            validation: Array.isArray(parsed.validation) ? parsed.validation.map(String) : undefined
          };
        }
      } catch {
        // Fall back to raw output.
      }
    }
    return { output: text };
  }

  private async recordPipelineMetrics(entry: {
    traceId: string;
    decision: string;
    qaEnabled: boolean;
    qaApproved: boolean;
    qaRounds: number;
    contextChunksUsed: number;
    contextCharsSaved: number;
    totalCost: number;
    executionPath: string[];
  }): Promise<void> {
    try {
      const dir = resolve(process.cwd(), '.crew');
      await mkdir(dir, { recursive: true });
      const path = join(dir, 'pipeline-metrics.jsonl');
      await appendFile(path, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8');
    } catch {
      // Best-effort observability only.
    }
  }

  private async writeRunCheckpoint(traceId: string, payload: Record<string, unknown>): Promise<void> {
    try {
      const dir = resolve(process.cwd(), '.crew', 'pipeline-runs');
      await mkdir(dir, { recursive: true });
      const path = join(dir, `${traceId}.jsonl`);
      await appendFile(path, `${JSON.stringify({ ts: new Date().toISOString(), ...payload })}\n`, 'utf8');
    } catch {
      // Best-effort checkpointing only.
    }
  }

  private parseJsonObject(raw: string): any {
    return parseJsonObject(raw);
  }

  private async parseRouterDecision(raw: string, traceId: string, sessionId?: string): Promise<any> {
    return parseJsonObjectWithRepair(raw, {
      label: `L2 router (${traceId})`,
      schemaHint: '{"decision":"direct-answer|execute-local|execute-parallel","reasoning":"...","directResponse":"...","complexity":"low|medium|high","estimatedCost":0.001}',
      maxAttempts: this.getJsonParseAttempts(),
      validate: validateRouterDecision,
      onAttempt: async meta => {
        await recordJsonParseMetric({ ...meta, traceId });
      },
      repair: async (repairPrompt: string) => {
        const repaired = await this.executor.execute(repairPrompt, {
          model: this.getJsonRepairModel(),
          temperature: 0,
          maxTokens: 1000,
          sessionId
        });
        return String(repaired.result || '');
      }
    });
  }

  private async qaAuditResponse(response: string, traceId: string, round: number, sessionId?: string): Promise<{
    approved: boolean;
    summary: string;
    issues: Array<{ severity: 'high' | 'medium' | 'low'; problem: string; requiredFix: string }>;
    cost: number;
  }> {
    const overlays: PromptOverlay[] = [
      {
        type: 'task',
        content: `Audit this generated output for correctness, completeness, and coherence.`,
        priority: 1
      },
      {
        type: 'context',
        content: `Round: ${round}\n\nGenerated output:\n${response}`,
        priority: 2
      },
      {
        type: 'constraints',
        content: `Return ONLY valid JSON:
{
  "approved": true|false,
  "summary": "short summary",
  "issues": [
    {
      "severity": "high|medium|low",
      "problem": "what is wrong",
      "requiredFix": "what to change"
    }
  ]
}

If output has blockers, set approved=false.`,
        priority: 3
      }
    ];
    const prompt = this.composer.compose('specialist-qa-v1', overlays, `${traceId}-qa-${round}`);
    const result = await this.executor.execute(prompt.finalPrompt, {
      model: this.getQaModel(),
      temperature: 0.1,
      maxTokens: 2000,
      sessionId
    });
    const parsed = this.parseJsonObject(String(result.result || ''));
    const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
    return {
      approved: Boolean(parsed.approved),
      summary: String(parsed.summary || ''),
      issues,
      cost: Number(result.costUsd || 0)
    };
  }

  private async fixerPatchResponse(
    response: string,
    issues: Array<{ severity: 'high' | 'medium' | 'low'; problem: string; requiredFix: string }>,
    traceId: string,
    round: number,
    sessionId?: string
  ): Promise<{ output: string; cost: number }> {
    const overlays: PromptOverlay[] = [
      {
        type: 'task',
        content: `Fix the generated output according to QA issues and return a corrected output body.`,
        priority: 1
      },
      {
        type: 'context',
        content: `Round: ${round}\n\nIssues:\n${JSON.stringify(issues, null, 2)}\n\nCurrent output:\n${response}`,
        priority: 2
      },
      {
        type: 'constraints',
        content: `Return only corrected output content, no extra commentary.`,
        priority: 3
      }
    ];
    const templateId = getTemplateForPersona('crew-fixer');
    const prompt = this.composer.compose(templateId, overlays, `${traceId}-fix-${round}`);
    const result = await this.executor.execute(prompt.finalPrompt, {
      temperature: 0.2,
      maxTokens: 5000,
      sessionId
    });
    return {
      output: String(result.result || ''),
      cost: Number(result.costUsd || 0)
    };
  }

  private async runQaFixerLoop(
    response: string,
    traceId: string,
    sessionId?: string
  ): Promise<{
    response: string;
    addedCost: number;
    approved: boolean;
    rounds: number;
    lastSummary: string;
  }> {
    let working = response;
    let addedCost = 0;
    let approved = false;
    let lastSummary = '';
    const rounds = this.qaMaxRounds();

    for (let round = 1; round <= rounds; round++) {
      const qa = await this.qaAuditResponse(working, traceId, round, sessionId);
      addedCost += qa.cost;
      lastSummary = qa.summary;
      if (qa.approved) {
        approved = true;
        return { response: working, addedCost, approved, rounds: round, lastSummary };
      }
      const fix = await this.fixerPatchResponse(working, qa.issues, traceId, round, sessionId);
      addedCost += fix.cost;
      if (fix.output.trim()) {
        working = fix.output;
      }
    }

    // Final gate check after last fixer round.
    const finalQa = await this.qaAuditResponse(working, traceId, rounds + 1, sessionId);
    addedCost += finalQa.cost;
    lastSummary = finalQa.summary;
    approved = finalQa.approved;
    return { response: working, addedCost, approved, rounds: rounds + 1, lastSummary };
  }

  private isMajorChange(workGraph?: WorkGraph): boolean {
    if (!workGraph) return false;
    const complexity = Number(workGraph.totalComplexity || 0);
    const unitCount = Array.isArray(workGraph.units) ? workGraph.units.length : 0;
    return complexity >= 7 || unitCount >= 8;
  }

  private assertMandatoryWorkGraphGates(workGraph: WorkGraph) {
    if (!this.scaffoldGateEnabled()) return;
    if (process.env.CREW_DUAL_L2_ENABLED !== 'true') return;
    const ids = new Set((workGraph.units || []).map(u => u.id));
    const required = ['scaffold-bootstrap', 'contract-tests-from-pdd', 'gate-definition-of-done', 'gate-golden-benchmark-suite'];
    const missing = required.filter(id => !ids.has(id));
    if (missing.length > 0) {
      throw new Error(`Mandatory pipeline gates missing: ${missing.join(', ')}`);
    }
  }

  private async runDefinitionOfDoneGate(
    response: string,
    request: L1Request,
    plan: L2Plan,
    traceId: string,
    sessionId?: string
  ): Promise<{ approved: boolean; summary: string; cost: number; ran: boolean }> {
    if (!this.definitionOfDoneEnabled()) return { approved: true, summary: 'DoD gate disabled', cost: 0, ran: false };

    const artifacts = plan.workGraph?.planningArtifacts;
    if (!artifacts?.definitionOfDone?.trim()) {
      return { approved: true, summary: 'No DOD artifact present', cost: 0, ran: false };
    }
    const overlays: PromptOverlay[] = [
      {
        type: 'task',
        content: 'Run a strict Definition of Done gate. Approve only if all required completion criteria are satisfied.',
        priority: 1
      },
      {
        type: 'context',
        content: `User request:\n${request.userInput}\n\nGenerated response:\n${response}`,
        priority: 2
      },
      {
        type: 'context',
        content: artifacts
          ? `DOD.md:\n${artifacts.definitionOfDone}\n\nPDD acceptance criteria:\n${(artifacts.acceptanceCriteria || []).join('\n')}`
          : 'No DOD artifacts available.',
        priority: 3
      },
      {
        type: 'constraints',
        content: `Return ONLY valid JSON:
{
  "approved": true|false,
  "summary": "short summary",
  "failedChecks": ["list of failed checklist items"]
}`,
        priority: 4
      }
    ];
    const prompt = this.composer.compose('specialist-qa-v1', overlays, `${traceId}-dod`);
    const res = await this.executor.execute(prompt.finalPrompt, {
      model: this.getQaModel(),
      temperature: 0.1,
      maxTokens: 1200,
      sessionId
    });
    const parsed = this.parseJsonObject(String(res.result || ''));
    const failed = Array.isArray(parsed.failedChecks) ? parsed.failedChecks : [];
    const approved = Boolean(parsed.approved) && failed.length === 0;
    return {
      approved,
      summary: String(parsed.summary || ''),
      cost: Number(res.costUsd || 0),
      ran: true
    };
  }

  private async runGoldenBenchmarkGate(
    executionResults: L3Result | undefined,
    plan: L2Plan,
    traceId: string,
    sessionId?: string
  ): Promise<{ approved: boolean; summary: string; cost: number; ran: boolean }> {
    if (!this.goldenBenchmarkGateEnabled()) return { approved: true, summary: 'Golden benchmark gate disabled', cost: 0, ran: false };
    if (!this.isMajorChange(plan.workGraph)) return { approved: true, summary: 'Not a major change', cost: 0, ran: false };

    const benchmarkOutput = (executionResults?.results || [])
      .find(r => r.workUnitId === 'gate-golden-benchmark-suite')?.output || '';
    if (!benchmarkOutput.trim()) {
      return { approved: false, summary: 'Missing golden benchmark gate output', cost: 0, ran: true };
    }

    const overlays: PromptOverlay[] = [
      {
        type: 'task',
        content: 'Validate that golden benchmark suite was executed and results indicate pass for major change.',
        priority: 1
      },
      {
        type: 'context',
        content: `Benchmark gate output:\n${benchmarkOutput}`,
        priority: 2
      },
      {
        type: 'constraints',
        content: `Return ONLY valid JSON:
{
  "approved": true|false,
  "summary": "short summary",
  "evidence": ["signals proving benchmark run happened"]
}`,
        priority: 3
      }
    ];
    const prompt = this.composer.compose('specialist-qa-v1', overlays, `${traceId}-golden-bench`);
    const res = await this.executor.execute(prompt.finalPrompt, {
      model: this.getQaModel(),
      temperature: 0.1,
      maxTokens: 1000,
      sessionId
    });
    const parsed = this.parseJsonObject(String(res.result || ''));
    return {
      approved: Boolean(parsed.approved),
      summary: String(parsed.summary || ''),
      cost: Number(res.costUsd || 0),
      ran: true
    };
  }

  private async runExtraL2Validators(
    request: L1Request,
    plan: L2Plan,
    traceId: string
  ): Promise<{ approved: boolean; summary: string; cost: number; ran: boolean }> {
    const models = this.getExtraL2ValidatorModels();
    if (models.length === 0) return { approved: true, summary: 'No extra L2 validators configured', cost: 0, ran: false };
    if (!plan.workGraph) return { approved: true, summary: 'No work graph to validate', cost: 0, ran: false };

    let totalCost = 0;
    const failures: string[] = [];

    for (const model of models) {
      const overlays: PromptOverlay[] = [
        {
          type: 'safety',
          content: `Validate this plan from an independent L2 pass.\n\nTask:\n${request.userInput}\n\nPlan:\n${JSON.stringify(plan.workGraph, null, 2)}`,
          priority: 1
        },
        {
          type: 'constraints',
          content: `Return ONLY valid JSON:
{
  "approved": true|false,
  "summary": "short summary",
  "issues": ["optional issue list"]
}`,
          priority: 2
        }
      ];
      const prompt = this.composer.compose('policy-validator-v1', overlays, `${traceId}-l2-extra-${model}`);
      const res = await this.executor.execute(prompt.finalPrompt, {
        model,
        temperature: 0.1,
        maxTokens: 1000
      });
      totalCost += Number(res.costUsd || 0);
      const parsed = this.parseJsonObject(String(res.result || ''));
      if (!Boolean(parsed.approved)) {
        failures.push(`${model}: ${String(parsed.summary || 'rejected')}`);
      }
    }

    if (failures.length > 0) {
      return {
        approved: false,
        summary: failures.join(' | '),
        cost: totalCost,
        ran: true
      };
    }
    return {
      approved: true,
      summary: `Extra L2 validators approved (${models.join(', ')})`,
      cost: totalCost,
      ran: true
    };
  }

  /**
   * Execute request through unified pipeline
   */
  async execute(request: L1Request): Promise<PipelineResult> {
    const traceId = `pipeline-${randomUUID()}`;
    const executionPath: string[] = ['l1-interface'];
    const startTime = Date.now();
    const runState = new PipelineRunState();
    const sessionId = request.sessionId || (this.session ? await this.session.getSessionId() : undefined);

    try {
      // L2: Router + Reasoner + Planner (or resume from prior plan)
      executionPath.push('l2-orchestrator');
      runState.transition('plan');
      await this.writeRunCheckpoint(traceId, { phase: 'plan', userInput: request.userInput, sessionId: request.sessionId });
      const resumeFrom = request.resume?.fromPhase;
      const canReusePlan = (resumeFrom === 'execute' || resumeFrom === 'validate') && Boolean(request.resume?.priorPlan);
      const plan = canReusePlan
        ? (request.resume?.priorPlan as L2Plan)
        : await this.l2Orchestrate(request, traceId, request.sessionId);
      if (canReusePlan) {
        executionPath.push('resume-plan-loaded');
      }
      await this.writeRunCheckpoint(traceId, {
        phase: 'plan.completed',
        decision: plan.decision,
        plan
      });

      // Store L2 decisions in agent memory for cross-model continuity
      const memory = getPipelineMemory();
      memory.remember(`L2 Decision: ${plan.decision} - ${plan.reasoning || 'direct execution'}`, {
        critical: true,
        tags: ['l2-decision', traceId],
        provider: 'pipeline'
      });

      let response: string;
      let executionResults: L3Result | undefined;
      let totalCost = 0;
      let qaApproved = true;
      let qaRounds = 0;
      let contextChunksUsed = 0;
      let contextCharsSaved = 0;
      let parallelExecuted = false;

      // Execute based on L2 decision
      runState.transition('execute');
      await this.writeRunCheckpoint(traceId, { phase: 'execute', decision: plan.decision });
      if (resumeFrom === 'validate' && request.resume?.priorResponse) {
        response = String(request.resume.priorResponse || '');
        executionResults = request.resume.priorExecutionResults;
        totalCost = Number(request.resume.priorExecutionResults?.totalCost || 0);
        executionPath.push('resume-validate-only');
      }
      else if (plan.decision === 'direct-answer') {
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
        
        // Parse and apply file commands from the output
        const { parseDirectFileCommands } = await import('../cli/file-commands.js');
        const fileCommands = parseDirectFileCommands(response);
        if (fileCommands.length > 0 && this.sandbox) {
          await this.sandbox.load(); // Ensure sandbox is loaded
          
          for (const cmd of fileCommands) {
            if (cmd.type === 'write') {
              await this.sandbox.addChange(cmd.path, cmd.content || '');
              this.logger.info(`Staged file: ${cmd.path}`);
            } else if (cmd.type === 'mkdir') {
              await this.sandbox.addChange(cmd.path + '/.gitkeep', '');
              this.logger.info(`Staged directory: ${cmd.path}`);
            }
          }
          
          // Auto-apply if --apply flag was used
          if (request.autoApply) {
            await this.sandbox.apply();
            this.logger.info(`Applied ${fileCommands.length} file change(s)`);
          }
        }
        
        executionResults = {
          success: true,
          results: [result],
          totalCost: result.cost,
          executionTimeMs: Date.now() - startTime
        };
      }
      else if (plan.decision === 'execute-parallel') {
        if (!plan.workGraph) {
          this.logger.warn('L2 selected execute-parallel without workGraph; falling back to single executor');
          executionPath.push('l3-executor-single');
          const result = await this.l3ExecuteSingle(
            request.userInput,
            request.context || '',
            traceId
          );
          response = result.output;
          totalCost = result.cost;
          
          // Parse and apply file commands from the output
          const { parseDirectFileCommands } = await import('../cli/file-commands.js');
          const fileCommands = parseDirectFileCommands(response);
          if (fileCommands.length > 0 && this.sandbox) {
            await this.sandbox.load(); // Ensure sandbox is loaded
            
            for (const cmd of fileCommands) {
              if (cmd.type === 'write') {
                await this.sandbox.addChange(cmd.path, cmd.content || '');
                this.logger.info(`Staged file: ${cmd.path}`);
              } else if (cmd.type === 'mkdir') {
                await this.sandbox.addChange(cmd.path + '/.gitkeep', '');
                this.logger.info(`Staged directory: ${cmd.path}`);
              }
            }
            
            // Auto-apply if --apply flag was used
            if (request.autoApply) {
              await this.sandbox.apply();
              this.logger.info(`Applied ${fileCommands.length} file change(s)`);
            }
          }
          
          executionResults = {
            success: true,
            results: [result],
            totalCost: result.cost,
            executionTimeMs: Date.now() - startTime
          };
        } else {
          executionPath.push('l3-executor-parallel');
          executionResults = await this.l3ExecuteParallel(
            plan.workGraph,
            request.context || '',
            traceId
          );
          parallelExecuted = true;
          response = this.synthesizeResults(executionResults);
          totalCost = executionResults.totalCost;
          const metrics = (executionResults as any)?.metrics;
          contextChunksUsed = Number(metrics?.contextChunksUsed || 0);
          contextCharsSaved = Number(metrics?.contextCharsSaved || 0);
          
          // Parse and apply file commands from parallel worker outputs
          const { parseDirectFileCommands } = await import('../cli/file-commands.js');
          const allFileCommands: any[] = [];
          for (const result of executionResults.results) {
            const commands = parseDirectFileCommands(result.output);
            allFileCommands.push(...commands);
          }
          
          if (allFileCommands.length > 0 && this.sandbox) {
            await this.sandbox.load();
            for (const cmd of allFileCommands) {
              if (cmd.type === 'write') {
                await this.sandbox.addChange(cmd.path, cmd.content || '');
                this.logger.info(`Staged file: ${cmd.path}`);
              } else if (cmd.type === 'mkdir') {
                await this.sandbox.addChange(cmd.path + '/.gitkeep', '');
                this.logger.info(`Staged directory: ${cmd.path}`);
              }
            }
            
            if (request.autoApply) {
              await this.sandbox.apply();
              this.logger.info(`Applied ${allFileCommands.length} file change(s)`);
            }
          }
        }
      }
      else {
        throw new Error(`Unknown decision: ${plan.decision}`);
      }

      if (plan.decision !== 'direct-answer' && this.qaLoopEnabled()) {
        executionPath.push('l3-qa-gate');
        const qaLoop = await this.runQaFixerLoop(response, traceId, sessionId);
        response = qaLoop.response;
        totalCost += qaLoop.addedCost;
        qaRounds = qaLoop.rounds;
        qaApproved = qaLoop.approved;
        executionPath.push(qaLoop.approved ? 'l3-qa-approved' : 'l3-qa-rejected');
        if (!qaLoop.approved) {
          throw new Error(`QA gate failed after ${qaLoop.rounds} rounds. ${qaLoop.lastSummary || ''}`.trim());
        }
      }

      runState.transition('validate');
      await this.writeRunCheckpoint(traceId, {
        phase: 'validate.input',
        response,
        executionResults
      });
      if (plan.decision === 'execute-parallel' && parallelExecuted) {
        const l2extra = await this.runExtraL2Validators(request, plan, traceId);
        if (l2extra.ran) executionPath.push('l2-extra-validators');
        totalCost += l2extra.cost;
        if (!l2extra.approved) {
          throw new Error(`Extra L2 validation failed. ${l2extra.summary}`.trim());
        }
      }

      if (plan.decision === 'execute-parallel' && parallelExecuted) {
        const dod = await this.runDefinitionOfDoneGate(response, request, plan, traceId, sessionId);
        if (dod.ran) executionPath.push('l3-definition-of-done-gate');
        totalCost += dod.cost;
        if (!dod.approved) {
          throw new Error(`Definition of done gate failed. ${dod.summary}`.trim());
        }
      }

      if (plan.decision === 'execute-parallel' && parallelExecuted) {
        const bench = await this.runGoldenBenchmarkGate(executionResults, plan, traceId, sessionId);
        if (bench.ran) executionPath.push('l3-golden-benchmark-gate');
        totalCost += bench.cost;
        if (!bench.approved) {
          throw new Error(`Golden benchmark gate failed. ${bench.summary}`.trim());
        }
      }

      runState.transition('complete');
      await this.writeRunCheckpoint(traceId, {
        phase: 'complete',
        decision: plan.decision,
        totalCost,
        durationMs: Date.now() - startTime,
        qaApproved
      });

      await this.recordPipelineMetrics({
        traceId,
        decision: plan.decision,
        qaEnabled: this.qaLoopEnabled(),
        qaApproved,
        qaRounds,
        contextChunksUsed,
        contextCharsSaved,
        totalCost,
        executionPath
      });

      return {
        response,
        executionPath,
        plan,
        executionResults,
        totalCost,
        traceId,
        phase: 'complete',
        timeline: runState.getTimeline()
      };
    } catch (err) {
      runState.transition('failed', (err as Error).message);
      await this.writeRunCheckpoint(traceId, {
        phase: 'failed',
        error: (err as Error).message,
        executionPath
      });
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
    const plan = await this.l2Orchestrate(request, traceId, request.sessionId);

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
    traceId: string,
    sessionId?: string
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

1. DIRECT-ANSWER: Simple question, greeting, status check, or clarification
   → Provide immediate text response
   
2. EXECUTE-LOCAL: DEPRECATED - only for testing/debugging
   → Not used in production
   
3. EXECUTE-PARALLEL: ALL coding/implementation tasks (default for code)
   → Any request involving writing, modifying, or refactoring code
   → L2 will decompose into work units for L3 workers
   → After execution, L2 runs QA validation
   → If QA fails, expensive fixer runs, then QA again
   → Use dual-L2 planner for work graph

**Always choose EXECUTE-PARALLEL for:**
- Writing code, functions, classes, modules
- Implementing features, APIs, algorithms
- Refactoring, bug fixes, optimizations
- Test creation, documentation generation

Return ONLY valid JSON:
{
  "decision": "direct-answer|execute-parallel",
  "reasoning": "why this path was chosen",
  "directResponse": "if direct-answer, provide response here",
  "complexity": "low|medium|high",
  "estimatedCost": 0.001
}`,
        priority: 3
      }
    );

    const composedPrompt = this.composer.compose('router-v1', overlays, traceId);
    
    const verbose = process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true';
    if (verbose) {
      console.log(`[L2 Router] Calling ${this.executor.constructor.name}...`);
      console.log(`[L2 Router] Prompt length: ${composedPrompt.finalPrompt.length} chars`);
      console.log(`[L2 Router] Request: ${request.userInput.substring(0, 100)}...`);
    }

    const routerStart = Date.now();
    const requestedRouterModel = this.getRouterModel();
    const result = await this.executor.execute(composedPrompt.finalPrompt, {
      model: requestedRouterModel,
      temperature: 0.3,
      maxTokens: 8000,  // L2 gets expensive model budget - only place we use it
      jsonMode: true,  // Router needs JSON
      sessionId: request.sessionId  // Pass session ID for cache coherence
    });
    if (verbose) {
      console.log(`[L2 Router] ✅ Response in ${Date.now() - routerStart}ms`);
      console.log(`[L2 Router] Model requested: ${requestedRouterModel || '(default)'} | used: ${result.model || '(unknown)'}`);
    }

    // Track cache savings from router call
    if (result.cachedTokens) {
      const totalTokens = (result.promptTokens || 0) + (result.cachedTokens || 0);
      await this.trackCacheHit(result.cachedTokens, totalTokens, result.model);
    }

    if (!result.success) {
      throw new Error(`L2 orchestration failed: ${result.result}`);
    }

    const decision = await this.parseRouterDecision(String(result.result || ''), traceId, sessionId);
    const normalizedDecision = this.normalizeDecision(decision.decision);

    // Step 2: If complex AND Dual-L2 enabled, run planner
    let workGraph: WorkGraph | undefined;
    let validation: PolicyValidation | undefined;

    const dualL2Enabled = process.env.CREW_DUAL_L2_ENABLED === 'true';

    if (normalizedDecision === 'execute-parallel' && dualL2Enabled) {
      console.log('[L2 Planner] Dual-L2 enabled, calling DualL2Planner...');
      
      const planStart = Date.now();
      const dualL2Result = await this.planner.plan(
        request.userInput,
        request.context || '',
        traceId
      );
      console.log(`[L2 Planner] ✅ Plan complete in ${Date.now() - planStart}ms`);
      console.log(`[L2 Planner] Work units: ${dualL2Result.workGraph?.units?.length || 0}`);
      
      workGraph = dualL2Result.workGraph;
      validation = dualL2Result.validation;

      if (workGraph) {
        const graphCheck = validateWorkGraph(workGraph);
        if (!graphCheck.ok) {
          throw new Error(`Planner returned invalid work graph: ${graphCheck.errors.join('; ')}`);
        }
      }
      if (validation) {
        const policyCheck = validatePolicyValidation(validation);
        if (!policyCheck.ok) {
          throw new Error(`Planner returned invalid validation payload: ${policyCheck.errors.join('; ')}`);
        }
      }

      if (workGraph) {
        const mode = String(process.env.CREW_INTERFACE_MODE || 'standalone').toLowerCase() === 'connected'
          ? 'connected'
          : 'standalone';
        const caps = resolveCapabilityMap(mode);
        for (const unit of workGraph.units || []) {
          const missing = missingForRequiredCapabilities(unit.requiredCapabilities || [], caps);
          if (missing.length > 0) {
            throw new Error(
              `Capability gate failed for unit "${unit.id}" (${unit.requiredPersona}): missing ${missing.join(', ')} in ${caps.mode} mode`
            );
          }
        }
      }

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
      decision: normalizedDecision,
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
    // Structure analyzer temporarily disabled
    // const structure = await analyzeProjectStructure(process.cwd());
    // const structureContext = formatStructureContext(structure);
    // const enhancedTask = `${structureContext}\n\n${task}`;
    const enhancedTask = task;
    
    const overlays: PromptOverlay[] = [
      { type: 'task', content: enhancedTask, priority: 1 }
    ];

    if (context) {
      overlays.push({ type: 'context', content: context, priority: 2 });
    }

    // Get sessionId from session manager if available
    const sessionId = this.session ? await this.session.getSessionId() : undefined;

    const composedPrompt = this.composer.compose('executor-code-v1', overlays, traceId);
    const result = await this.executor.execute(composedPrompt.finalPrompt, {
      model: 'gemini-2.5-flash',  // Cheap, fast, complete implementations
      temperature: 0.7,
      maxTokens: 8000,
      jsonMode: false,  // L3 code executor should use @@WRITE_FILE format, not JSON
      sessionId: sessionId  // Pass session ID for cache coherence
    });

    // Track cache savings if any
    if (result.cachedTokens) {
      const totalTokens = (result.promptTokens || 0) + (result.cachedTokens || 0);
      await this.trackCacheHit(result.cachedTokens, totalTokens, result.model);
    }

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
    const verbose = process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true';
    if (verbose) {
      console.log('[L3 Execute] Starting parallel execution...');
      console.log(`[L3 Execute] Total work units: ${workGraph.units.length}`);
    }
    
    // HARD COST GATE - Block before execution
    if (workGraph.estimatedCost > 0.50) {
      throw new Error(
        `Task cost $${workGraph.estimatedCost.toFixed(3)} exceeds limit ($0.50). ` +
        `Use /approve-cost to override or simplify the task.`
      );
    }

    this.assertMandatoryWorkGraphGates(workGraph);

    // Get sessionId from session manager if available
    const sessionId = this.session ? await this.session.getSessionId() : undefined;

    const startTime = Date.now();
    const results: L3Result['results'] = [];
    const completed = new Set<string>();
    const outputByUnit = new Map<string, string>();
    let totalCost = 0;
    let contextChunksUsed = 0;
    let contextCharsSaved = 0;
    const artifactPackId = workGraph.planningArtifacts
      ? this.contextPacks.createPack(traceId, workGraph.planningArtifacts)
      : '';

    // Sort work units by dependency order
    const sorted = this.topologicalSort(workGraph.units);

    // Execute in batches (units with no pending dependencies)
    const maxWorkers = this.getMaxParallelWorkers();
    for (const batch of this.getBatches(sorted)) {
      if (verbose) {
        console.log(`[L3 Batch] Executing ${batch.length} units in parallel...`);
        console.log(`[L3 Batch] Units: ${batch.map(u => u.id).join(', ')}`);
        console.log(`[L3 Batch] Concurrency cap: ${maxWorkers}`);
      }
      
      const batchStart = Date.now();
      const runUnit = async (unit: typeof batch[number]) => {
        // Check dependencies
        for (const depId of unit.dependencies) {
          if (!completed.has(depId)) {
            throw new Error(`Dependency ${depId} not completed for ${unit.id}`);
          }
        }

        // Resolve prompt template from persona registry (covers full standalone role set).
        const templateId = getTemplateForPersona(unit.requiredPersona);

        // Structure analyzer temporarily disabled
        // const structure = await analyzeProjectStructure(process.cwd());
        // const structureContext = formatStructureContext(structure);
        // const enhancedDescription = `${structureContext}\n\n${unit.description}`;
        const enhancedDescription = unit.description;

        const overlays: PromptOverlay[] = [
          { type: 'task', content: enhancedDescription, priority: 1 },
          { type: 'context', content: context, priority: 2 }
        ];

        // Inject agent memory for cross-model continuity
        const memory = getPipelineMemory();
        const memoryContext = memory.recall({
          tokenBudget: 500,
          tags: ['l2-decision', traceId],
          provider: 'pipeline'
        });
        if (memoryContext) {
          overlays.push({
            type: 'context',
            content: memoryContext,
            priority: 0
          });
        }

        if (artifactPackId) {
          const fullArtifactChars = (workGraph.planningArtifacts?.pdd?.length || 0)
            + (workGraph.planningArtifacts?.roadmap?.length || 0)
            + (workGraph.planningArtifacts?.architecture?.length || 0);
          const artifactContext = this.contextPacks.retrieve(artifactPackId, {
            query: unit.description,
            sourceRefs: unit.sourceRefs || [],
            budgetChars: Number(process.env.CREW_CONTEXT_BUDGET_CHARS || 7000),
            maxChunks: Number(process.env.CREW_CONTEXT_MAX_CHUNKS || 8)
          });
          const usedChunks = (artifactContext.match(/\[(PDD|ROADMAP|ARCH|SCAFFOLD|CONTRACT-TESTS|DOD|GOLDEN-BENCHMARKS)\.md#/g) || []).length;
          contextChunksUsed += usedChunks;
          contextCharsSaved += Math.max(0, fullArtifactChars - artifactContext.length);
          overlays.push({
            type: 'context',
            content: `Context pack id: ${artifactPackId}\n${artifactContext}`,
            priority: 2
          });
        }

        // Add outputs from completed dependencies (bounded) so downstream workers remain coherent.
        const dependencyOutputs: string[] = [];
        for (const depId of unit.dependencies) {
          const depOutput = outputByUnit.get(depId);
          if (depOutput) {
            dependencyOutputs.push(`[Output from ${depId}]:\n${depOutput.substring(0, 1500)}`);
          }
        }
        if (dependencyOutputs.length > 0) {
          overlays.push({
            type: 'context',
            content: `Dependency outputs:\n${dependencyOutputs.join('\n\n')}`,
            priority: 3
          });
        }

        if (Array.isArray(unit.sourceRefs) && unit.sourceRefs.length > 0) {
          overlays.push({
            type: 'context',
            content: `Required source refs for this unit: ${unit.sourceRefs.join(', ')}`,
            priority: 3
          });
        }
        
        // Only add JSON constraint for non-coding workers
        // Coding workers (crew-coder, crew-coder-front, crew-coder-back, crew-frontend, crew-fixer) 
        // should use @@WRITE_FILE format instead
        const codingPersonas = ['crew-coder', 'crew-coder-front', 'crew-coder-back', 'crew-frontend', 'crew-fixer', 'crew-mega'];
        if (!codingPersonas.includes(unit.requiredPersona)) {
          overlays.push({
            type: 'constraints',
            content: `Return ONLY valid JSON:
{
  "output": "primary result text for this unit",
  "summary": "short summary",
  "edits": ["optional changed files or actions"],
  "validation": ["optional checks or caveats"]
}`,
            priority: 4
          });
        }

        const composedPrompt = this.composer.compose(templateId, overlays, `${traceId}-${unit.id}`);
        
        // Extract the specialized system prompt from the composed template
        const template = (this.composer as any).getTemplate(templateId);
        const systemPrompt = template?.basePrompt || 'You are a skilled AI engineer.';
        
        if (verbose) {
          console.log(`  [${unit.id}] ${unit.requiredPersona} executing...`);
        }
        const unitStart = Date.now();
        
        const result = await this.executor.execute(composedPrompt.finalPrompt, {
          temperature: 0.7,
          maxTokens: 4000,
          systemPrompt,  // Pass specialized persona prompt to executor
          jsonMode: false,  // L3 workers should use @@WRITE_FILE format, not JSON
          sessionId: sessionId  // Pass session ID for cache coherence
        });
        const parsed = this.parseWorkerOutput(String(result.result || ''));

        // Track cache savings if any
        if (result.cachedTokens) {
          const totalTokens = (result.promptTokens || 0) + (result.cachedTokens || 0);
          await this.trackCacheHit(result.cachedTokens, totalTokens, result.model);
        }

        if (verbose) {
          console.log(`  [${unit.id}] ✅ Complete in ${Date.now() - unitStart}ms ($${result.costUsd?.toFixed(6) || 0})`);
        }

        completed.add(unit.id);
        outputByUnit.set(unit.id, parsed.output);

        // Store worker output in memory for cross-model continuity
        getPipelineMemory().remember(
          `Worker ${unit.id} (${unit.requiredPersona}): ${parsed.output.substring(0, 300)}...`,
          { critical: false, tags: ['l3-output', traceId, unit.id], provider: 'pipeline' }
        );

        return {
          workUnitId: unit.id,
          persona: unit.requiredPersona,
          output: parsed.output,
          cost: result.costUsd || 0
        };
      };

      const batchResults: Array<{
        workUnitId: string;
        persona: string;
        output: string;
        cost: number;
      }> = [];
      const queue = batch.slice();
      const workers = Array.from({ length: Math.min(maxWorkers, queue.length) }, async () => {
        while (queue.length > 0) {
          const next = queue.shift();
          if (!next) break;
          const res = await runUnit(next);
          batchResults.push(res);
        }
      });
      await Promise.all(workers);
      if (verbose) {
        console.log(`[L3 Batch] ✅ Batch complete in ${Date.now() - batchStart}ms`);
      }
      
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
      executionTimeMs: Date.now() - startTime,
      metrics: {
        contextChunksUsed,
        contextCharsSaved
      }
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
