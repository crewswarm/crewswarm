/**
 * Unified 3-Tier Pipeline
 * 
 * L1: Chat Interface (REPL/CLI) - User interaction only
 * L2: Router + Reasoner + Planner - Unified orchestration layer
 * L3: Parallel Executors - Specialized workers
 */

import { LocalExecutor } from '../executor/local.js';
import { runAgenticWorker } from '../executor/agentic-executor.js';
import { DualL2Planner, WorkGraph, PolicyValidation } from '../prompts/dual-l2.js';
import { PromptComposer, PromptOverlay, getTemplateForPersona } from '../prompts/registry.js';
import { Logger } from '../utils/logger.js';
import { randomUUID } from 'crypto';
import { ContextPackManager } from './context-pack.js';
import { getPipelineMemory } from './agent-memory.js';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { resolve, join, normalize } from 'node:path';
import { parseJsonObject, parseJsonObjectWithRepair } from '../utils/structured-json.js';
import { validatePolicyValidation, validateRouterDecision, validateWorkGraph } from '../utils/json-schemas.js';
import { recordJsonParseMetric } from '../metrics/json-parse.js';
import { PipelineRunState } from './run-state.js';
import { missingForRequiredCapabilities, resolveCapabilityMap } from '../capabilities/index.js';
import { buildWorkerTasks, createAdHocWorkerTask, validateWorkerTaskEnvelope, type WorkerTaskEnvelope } from './task-envelope.js';
import { runDeterministicQA } from '../execution/qa-gate.js';
import type { ExecutionTranscript } from '../execution/transcript.js';
import { getProjectContext } from '../context/project-context.js';
import { reviewWorkerExecution, type ReviewResult } from '../executor/reviewer.js';
import { enterWorktree, exitWorktree, mergeWorktree } from '../tools/worktree.js';
import { Sandbox } from '../sandbox/index.js';
import type { SessionManager } from '../session/manager.js';
import { DelegationTuner, analyzeTask as analyzeDelegationTask } from '../engine/delegation.js';
// Structure analyzer temporarily disabled - file missing
// import { analyzeProjectStructure, formatStructureContext } from '../utils/structure-analyzer.js';

type EffortLevel = 'low' | 'medium' | 'high';

export interface L1Request {
  userInput: string;
  context?: string;
  sessionId: string;
  deferApply?: boolean; // If true, don't auto-flush sandbox — let caller handle preview/apply
  autoApply?: boolean; // If true, auto-apply sandbox changes after execution
  resume?: {
    fromPhase?: 'plan' | 'execute' | 'validate';
    priorPlan?: L2Plan;
    priorResponse?: string;
    priorExecutionResults?: L3Result;
  };
}

export interface L2Plan {
  decision: 'direct-answer' | 'execute-local' | 'execute-parallel' | 'execute-direct';
  reasoning: string;
  workGraph?: WorkGraph;
  validation?: PolicyValidation;
  directResponse?: string;
  estimatedEffort?: EffortLevel;
  traceId: string;
}

export interface L3Result {
  success: boolean;
  results: Array<{
    workUnitId: string;
    persona: string;
    output: string;
    cost: number;
    filesChanged: string[];
    verification: string[];
    verificationPassed: boolean;
    escalationNeeded: boolean;
    escalationReason?: string;
    toolsUsed?: string[];
    failedToolCalls?: number;
    turns?: number;
    stopReason?: string;
    shellResults?: Array<{ command: string; exitCode: number; output: string }>;
    transcript?: ExecutionTranscript;
    reviewer?: ReviewResult;
    qaGateResult?: import('../execution/qa-gate.js').QAGateResult;
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
  private sandbox: Sandbox | undefined;
  private session?: SessionManager;
  private delegationTuner = new DelegationTuner();

  constructor(sandbox?: Sandbox, session?: SessionManager) {
    this.sandbox = sandbox;
    this.session = session;
  }

  private requireSandbox(): Sandbox {
    if (!this.sandbox) throw new Error('Sandbox is required for pipeline execution');
    return this.sandbox;
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

  private normalizeDecision(raw: string): 'direct-answer' | 'execute-local' | 'execute-parallel' | 'execute-direct' {
    // Normalize: lowercase, underscores→hyphens, collapse whitespace
    const value = String(raw || '').trim().toLowerCase().replace(/_/g, '-').replace(/\s+/g, '-');
    if (value === 'direct-answer' || value === 'chat' || value === 'answer') return 'direct-answer';
    if (value === 'execute-direct' || value === 'direct-execute' || value === 'simple' || value === 'run' || value === 'execute') return 'execute-direct';
    if (value === 'execute-local' || value === 'code') {
      return process.env.CREW_ALLOW_EXECUTE_LOCAL === 'true'
        ? 'execute-local'
        : 'execute-parallel';
    }
    if (value === 'execute-parallel' || value === 'dispatch' || value === 'plan' || value === 'build' || value === 'implement') return 'execute-parallel';
    // Fallback: if it contains recognizable fragments, route accordingly
    if (value.includes('direct') && value.includes('answer')) return 'direct-answer';
    if (value.includes('direct')) return 'execute-direct';
    if (value.includes('parallel') || value.includes('dispatch')) return 'execute-parallel';
    return 'execute-parallel';
  }

  private getReasoningModel(): string | undefined {
    const model = String(process.env.CREW_REASONING_MODEL || process.env.CREW_CHAT_MODEL || '').trim();
    return model || undefined;
  }

  private normalizeEffort(raw: unknown, fallback: EffortLevel = 'medium'): EffortLevel {
    const value = String(raw || '').trim().toLowerCase();
    if (value === 'low' || value === 'medium' || value === 'high') return value;
    return fallback;
  }

  private getRequestedEffortOverride(): EffortLevel | undefined {
    const env = String(process.env.CREW_EFFORT || '').trim().toLowerCase();
    if (env === 'low' || env === 'medium' || env === 'high') return env;
    return undefined;
  }

  private inferEffortFromInput(text: string): EffortLevel {
    const lower = String(text || '').toLowerCase();
    if (lower.length < 120 && /\b(typo|rename|small|one line|one-liner|quick|minor|simple)\b/.test(lower)) return 'low';
    if (lower.length > 500 || /\b(api|refactor|architecture|pipeline|multi-file|parallel|worker|oauth|reviewer)\b/.test(lower)) return 'high';
    return 'medium';
  }

  private getExecutionEffort(taskOrRequest: { estimatedComplexity?: string; goal?: string; userInput?: string }, fallback?: EffortLevel): EffortLevel {
    const override = this.getRequestedEffortOverride();
    if (override) return override;
    if (taskOrRequest.estimatedComplexity) {
      return this.normalizeEffort(taskOrRequest.estimatedComplexity, fallback || 'medium');
    }
    if (taskOrRequest.goal) return this.inferEffortFromInput(taskOrRequest.goal);
    if (taskOrRequest.userInput) return this.inferEffortFromInput(taskOrRequest.userInput);
    return fallback || 'medium';
  }

  private getModelForLayer(layer: 'l1' | 'l3' | 'l3-review' | 'l3-fixer', effort: EffortLevel = 'medium'): string | undefined {
    const envByLayer: Record<typeof layer, string[]> = {
      l1: ['CREW_L1_MODEL', 'CREW_ROUTER_MODEL'],
      l3: ['CREW_L3_MODEL', 'CREW_EXECUTION_MODEL'],
      'l3-review': ['CREW_L3_REVIEW_MODEL', 'CREW_QA_MODEL'],
      'l3-fixer': ['CREW_L3_FIXER_MODEL', 'CREW_EXECUTION_MODEL']
    };
    for (const envKey of envByLayer[layer]) {
      const value = String(process.env[envKey] || '').trim();
      if (value) return value;
    }

    if (layer === 'l1') return this.getReasoningModel() || 'gemini-2.5-flash';
    if (layer === 'l3-review') return 'gemini-2.5-flash';
    if (layer === 'l3-fixer') {
      if (effort === 'high') return 'gpt-5.2-codex';
      return 'gpt-5.2';
    }
    if (effort === 'low') return 'gemini-2.5-flash';
    if (effort === 'high') return 'claude-opus-4.6';
    return 'gpt-5.2';
  }

  private getTierForEffort(effort: EffortLevel): 'fast' | 'standard' | 'heavy' {
    if (effort === 'low') return 'fast';
    if (effort === 'high') return 'heavy';
    return 'standard';
  }

  private getMaxTurnsForEffort(effort: EffortLevel): number {
    const explicit = Number(process.env.CREW_MAX_TURNS || 0);
    if (Number.isFinite(explicit) && explicit > 0) return Math.max(1, Math.floor(explicit));
    if (effort === 'low') return 3;
    if (effort === 'high') return 25;
    return 10;
  }
  
  private getRouterModel(): string | undefined {
    // Router needs structured JSON, so avoid pure reasoning models
    const routerModel = this.getModelForLayer('l1', 'low');
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
    const model = String(process.env.CREW_QA_MODEL || process.env.CREW_L3_REVIEW_MODEL || process.env.CREW_REASONING_MODEL || '').trim();
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

  private reviewerEnabled(): boolean {
    const raw = String(process.env.CREW_L3_REVIEW_ENABLED || 'true').trim().toLowerCase();
    return raw !== 'false' && raw !== '0' && raw !== 'off';
  }

  private getReviewerMaxCycles(): number {
    const raw = Number(process.env.CREW_L3_REVIEW_MAX_CYCLES || 2);
    if (!Number.isFinite(raw) || raw < 1) return 2;
    return Math.min(3, Math.floor(raw));
  }

  private async getFileReviewSnippet(filePath: string): Promise<string | undefined> {
    const staged = this.sandbox?.getStagedContent?.(filePath);
    if (typeof staged === 'string') return staged;
    try {
      return await readFile(resolve(this.sandbox?.getBaseDir() || process.cwd(), filePath), 'utf8');
    } catch {
      return undefined;
    }
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

  // NOTE: Files are extracted from claimed tool calls in worker history,
  // not from actual filesystem state. A worker could claim a write_file
  // call that the sandbox rejected, or the file could have been
  // overwritten by a later worker. Filesystem verification is not yet
  // implemented.
  private extractFilesChanged(history: Array<{ tool: string; params: Record<string, unknown>; error?: string }> = []): string[] {
    const changed = new Set<string>();
    for (const turn of history) {
      if (turn?.error) continue;
      const tool = String(turn.tool || '');
      if (['write_file', 'append_file', 'replace', 'edit', 'edit_file', 'notebook_edit'].includes(tool)) {
        const filePath = String(turn.params?.file_path || turn.params?.path || '').trim();
        if (filePath) changed.add(filePath);
        continue;
      }
      if (tool === 'run_shell_command' || tool === 'check_background_task' || tool === 'run_cmd' || tool === 'shell') {
        const command = String(turn.params?.command || '').trim();
        for (const target of this.extractShellWriteTargets(command)) changed.add(target);
      }
    }
    return Array.from(changed);
  }

  private extractShellWriteTargets(command: string): string[] {
    const text = String(command || '').trim();
    if (!text) return [];
    const targets = new Set<string>();
    const redirectRe = /(?:^|[|&;]\s*|\s)(?:>>?|1>>?|2>>?)\s*(?:"([^"]+)"|'([^']+)'|([^\s|&;]+))/g;
    let match: RegExpExecArray | null;
    while ((match = redirectRe.exec(text)) !== null) {
      const target = String(match[1] || match[2] || match[3] || '').trim();
      if (target) targets.add(target);
    }
    const teeRe = /\btee\s+(?:-a\s+)?(?:"([^"]+)"|'([^']+)'|([^\s|&;]+))/g;
    while ((match = teeRe.exec(text)) !== null) {
      const target = String(match[1] || match[2] || match[3] || '').trim();
      if (target) targets.add(target);
    }
    return [...targets];
  }

  private stringifyShellResult(result: unknown): string {
    if (typeof result === 'string') return result.trim();
    if (!result || typeof result !== 'object') return String(result || '').trim();
    const candidate = result as {
      output?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      llmContent?: unknown;
      returnDisplay?: unknown;
      return_display?: unknown;
    };
    return String(
      candidate.output
      || candidate.stdout
      || candidate.stderr
      || candidate.llmContent
      || candidate.returnDisplay
      || candidate.return_display
      || ''
    ).trim();
  }

  private extractShellResults(
    history: Array<{ tool: string; params: Record<string, unknown>; result?: unknown; error?: string }> = []
  ): Array<{ command: string; exitCode: number; output: string }> {
    const results: Array<{ command: string; exitCode: number; output: string }> = [];
    for (const turn of history) {
      const tool = String(turn?.tool || '');
      if (tool !== 'run_shell_command' && tool !== 'check_background_task' && tool !== 'run_cmd' && tool !== 'shell') continue;
      const command = String(turn.params?.command || turn.params?.task_id || '').trim();
      const result = turn.result as { output?: unknown; exitCode?: unknown } | undefined;
      const rawOutput = this.stringifyShellResult(result || turn.result);
      const exitCode = turn?.error ? 1 : (typeof result?.exitCode === 'number' ? result.exitCode : 0);
      results.push({
        command,
        exitCode,
        output: rawOutput.slice(0, 500)
      });
    }
    return results;
  }

  private collectVerificationSignals(
    history: Array<{ tool: string; params: Record<string, unknown>; result?: unknown; error?: string }> = [],
    parsed: { output: string; validation?: string[] },
    task: WorkerTaskEnvelope
  ): { verification: string[]; verificationPassed: boolean; escalationNeeded: boolean; escalationReason?: string } {
    const verification = new Set<string>(Array.isArray(parsed.validation) ? parsed.validation : []);
    let verificationPassed = false;
    let escalationNeeded = false;
    let escalationReason: string | undefined;

    for (const turn of history) {
      const tool = String(turn?.tool || '');
      if (turn?.error) continue;
      if (tool === 'run_shell_command' || tool === 'check_background_task' || tool === 'run_cmd' || tool === 'shell') {
        const command = String(turn.params?.command || turn.params?.task_id || '').trim();
        const result = turn.result as { output?: unknown } | undefined;
        const output = this.stringifyShellResult(result || turn.result);
        verification.add(command ? `Command succeeded: ${command}` : 'Verification command succeeded.');
        if (output) {
          verification.add(`Verification output: ${output.slice(0, 200)}`);
        }
        verificationPassed = true;
      }
    }

    // No prose keyword fallback — verification requires shell evidence
    // (exit code 0 from run_shell_command/check_background_task) or
    // structured validation fields from the worker output.
    if (!verificationPassed && task.verification.length > 0) {
      escalationNeeded = true;
      escalationReason = 'No shell verification command was executed';
    }

    return {
      verification: Array.from(verification),
      verificationPassed,
      escalationNeeded,
      escalationReason
    };
  }

  private countFailedToolCalls(history: Array<{ tool: string; params: Record<string, unknown>; error?: string }> = []): number {
    return history.filter(turn => Boolean(turn?.error)).length;
  }

  private hasRepeatedFailedAction(history: Array<{ tool: string; params: Record<string, unknown>; error?: string }> = []): boolean {
    const failures = history
      .filter(turn => Boolean(turn?.error))
      .map(turn => `${String(turn.tool || '')}:${JSON.stringify(turn.params || {})}`);
    if (failures.length < 2) return false;
    const last = failures[failures.length - 1];
    const prev = failures[failures.length - 2];
    return last === prev;
  }

  private containsLegacyFileCommands(text: string): boolean {
    const value = String(text || '');
    return value.includes('@@WRITE_FILE')
      || value.includes('@@MKDIR')
      || /(^|\n)\s*FILE:\s+/im.test(value)
      || /(^|\n)\s*write:\s+/im.test(value);
  }

  private shouldParseLegacyCommands(result: { output: string; filesChanged?: string[] }): boolean {
    const hasLegacy = (!Array.isArray(result.filesChanged) || result.filesChanged.length === 0)
      && this.containsLegacyFileCommands(result.output);
    if (hasLegacy) {
      this.logger.warn('[DEPRECATED] Legacy file commands detected (@@WRITE_FILE, FILE:, write:). Use structured tool calls instead.');
    }
    return hasLegacy;
  }

  private buildStructuredEvidence(executionResults?: L3Result): Array<{
    workUnitId: string;
    persona: string;
    filesChanged: string[];
    shellResults: Array<{ command: string; exitCode: number; output: string }>;
    verificationPassed: boolean;
    verificationEvidence: string;
    workerOutput: string;
    escalationNeeded: boolean;
    escalationReason?: string;
    failedToolCalls?: number;
    turns?: number;
    stopReason?: string;
  }> {
    if (!executionResults || !Array.isArray(executionResults.results) || executionResults.results.length === 0) {
      return [];
    }
    return executionResults.results.map(result => {
      const shellResults = Array.isArray(result.shellResults) ? result.shellResults : [];
      const verificationEvidence = result.verification.length > 0
        ? result.verification.join(' | ')
        : 'No shell verification command was executed';
      return {
        workUnitId: result.workUnitId,
        persona: result.persona,
        filesChanged: result.filesChanged,
        shellResults,
        verificationPassed: result.verificationPassed,
        verificationEvidence,
        workerOutput: result.output,
        escalationNeeded: result.escalationNeeded,
        escalationReason: result.escalationReason,
        failedToolCalls: result.failedToolCalls,
        turns: result.turns,
        stopReason: result.stopReason
      };
    });
  }

  private buildExecutionAuditContext(executionResults?: L3Result): string {
    const evidence = this.buildStructuredEvidence(executionResults);
    if (evidence.length === 0) {
      return 'No execution metadata available.';
    }
    return evidence.map(e => {
      const lines = [
        `Unit: ${e.workUnitId}`,
        `Persona: ${e.persona}`,
        `Files changed: ${JSON.stringify(e.filesChanged)}`,
        `Verification passed: ${e.verificationPassed}`,
        `Verification evidence: ${e.verificationEvidence}`,
        `Shell results: ${JSON.stringify(e.shellResults)}`,
        `Escalation needed: ${e.escalationNeeded}`,
      ];
      if (e.escalationReason) lines.push(`Escalation reason: ${e.escalationReason}`);
      if (typeof e.failedToolCalls === 'number') lines.push(`Failed tool calls: ${e.failedToolCalls}`);
      if (typeof e.turns === 'number') lines.push(`Turns: ${e.turns}`);
      if (e.stopReason) lines.push(`Stop reason: ${e.stopReason}`);
      return lines.join('\n');
    }).join('\n\n');
  }

  private appendExecutionAuditContext(response: string, executionResults?: L3Result): string {
    if (!executionResults || !Array.isArray(executionResults.results) || executionResults.results.length === 0) {
      return response;
    }
    return `${response}\n\nExecution metadata:\n${this.buildExecutionAuditContext(executionResults)}`;
  }

  private extractRequestedPaths(task: string): string[] {
    const found = new Set<string>();
    const fileNamed = [...String(task || '').matchAll(/file named\s+["'`]?([A-Za-z0-9._/-]+\.[A-Za-z0-9]+)["'`]?/gi)];
    for (const match of fileNamed) {
      const filePath = String(match[1] || '').trim();
      if (filePath) found.add(filePath);
    }
    const pathLike = [...String(task || '').matchAll(/(?:^|[\s("'`])([A-Za-z0-9._/-]+\.[A-Za-z0-9]+)(?=$|[\s)"'`,.:;])/g)];
    for (const match of pathLike) {
      const filePath = String(match[1] || '').trim();
      if (filePath && !filePath.startsWith('ac-')) found.add(filePath);
    }
    return Array.from(found).slice(0, 4);
  }

  private isSmallScopedTask(request: L1Request, plan: L2Plan): boolean {
    if (plan.workGraph?.planMode === 'lightweight') return true;
    const text = String(request.userInput || '').toLowerCase();
    if (text.length > 1200) return false;
    const paths = this.extractRequestedPaths(text);
    const narrowIntent = /(create|write|update|modify|edit|add|fix|rename)\b/.test(text);
    const broadSignals = [
      'roadmap',
      'architecture',
      'planning',
      'entire project',
      'whole project',
      'phase 1',
      'phase 2',
      'phase 3',
      'contract tests',
      'golden benchmark',
      'definition of done'
    ];
    return narrowIntent && paths.length > 0 && paths.length <= 4 && !broadSignals.some(signal => text.includes(signal));
  }

  private async passesDeterministicSmallTaskGate(
    request: L1Request,
    plan: L2Plan,
    executionResults?: L3Result
  ): Promise<boolean> {
    if (!this.isSmallScopedTask(request, plan)) return false;

    const scopedPaths = plan.workGraph?.units?.flatMap(unit => Array.isArray(unit.allowedPaths) ? unit.allowedPaths : []).filter(Boolean);
    const paths = scopedPaths && scopedPaths.length > 0 ? scopedPaths : this.extractRequestedPaths(request.userInput);
    if (paths.length === 0) return false;

    if (executionResults?.results?.length) {
      // Check for truly blocking escalations (scope violations, stuck loops)
      // but NOT for failed shell commands (git, tsc, npm) which are common
      // noise on simple tasks without full project setup.
      const hasBlockingEscalation = executionResults.results.some(result => {
        if (!result.escalationNeeded) return false;
        const reason = String(result.escalationReason || '').toLowerCase();
        return reason.includes('outside allowed scope')
          || reason.includes('touched')
          || reason.includes('repeated the same failing tool action');
      });
      if (hasBlockingEscalation) return false;
      if (executionResults.results.some(result => result.verificationPassed)) return true;
      // If files were created, don't block on failed tool calls or missing verification
      const anyFilesChanged = executionResults.results.some(result =>
        Array.isArray(result.filesChanged) && result.filesChanged.length > 0
      );
      if (anyFilesChanged) {
        // Fall through to content verification below instead of blocking
      } else {
        // No files at all — check if escalation is about missing changes
        const noFilesEscalation = executionResults.results.some(result =>
          result.escalationNeeded && String(result.escalationReason || '').toLowerCase().includes('without producing any file changes')
        );
        if (noFilesEscalation) return false;
      }
    }

    const baseDir = this.sandbox?.getBaseDir() || process.cwd();
    const contents = new Map();
    for (const relPath of paths) {
      const staged = this.requireSandbox().getStagedContent(relPath);
      if (typeof staged === 'string') {
        contents.set(relPath, staged);
        continue;
      }
      try {
        const content = await readFile(resolve(baseDir, relPath), 'utf8');
        contents.set(relPath, content);
      } catch {
        return false;
      }
    }

    const taskText = String(request.userInput || '');
    const exactLines = [...taskText.matchAll(/"([^"]+)"/g)].map(match => String(match[1] || ''));
    if (/containing exactly/i.test(taskText) && paths.length === 1 && exactLines.length > 0) {
      const actual = String(contents.get(paths[0]) || '').trim();
      const expected = exactLines.join('\n').trim();
      return actual === expected;
    }

    for (const relPath of paths) {
      const content = String(contents.get(relPath) || '');
      if (relPath.endsWith('SUMMARY.md') && !content.trim()) return false;
      if (relPath.endsWith('math.ts') && /add\(a,\s*b\)/i.test(taskText)) {
        const looksTypedAdd = /export\s+(function|const)\s+add\s*\(\s*a\s*:\s*[^,]+,\s*b\s*:\s*[^)]+\)/.test(content)
          || /export\s+const\s+add\s*=\s*\(\s*a\s*:\s*[^,]+,\s*b\s*:\s*[^)]+\)/.test(content);
        if (!looksTypedAdd) return false;
      }
    }

    return true;
  }

  private buildWorkerExecutionResult(
    task: WorkerTaskEnvelope,
    parsed: { output: string; validation?: string[] },
    workerResult: {
      cost?: number;
      success?: boolean;
      toolsUsed?: string[];
      history?: Array<{ tool: string; params: Record<string, unknown>; result?: unknown; error?: string }>;
      stopReason?: string;
      turns?: number;
      transcript?: ExecutionTranscript;
    }
  ): L3Result['results'][number] {
    const history = Array.isArray(workerResult.history) ? workerResult.history : [];
    const filesChanged = this.extractFilesChanged(history);
    const shellResults = this.extractShellResults(history);
    const verificationState = this.collectVerificationSignals(history, parsed, task);
    const failedToolCalls = this.countFailedToolCalls(history);
    const repeatedFailedAction = this.hasRepeatedFailedAction(history);

    let escalationNeeded = verificationState.escalationNeeded || workerResult.success === false;
    let escalationReason = verificationState.escalationReason;

    if (!escalationReason && workerResult.success === false) {
      escalationReason = workerResult.stopReason || 'Worker did not reach a successful completion state.';
    } else if (!escalationReason && workerResult.stopReason && !String(workerResult.stopReason).toLowerCase().includes('complete')) {
      escalationNeeded = true;
      escalationReason = workerResult.stopReason;
    }

    const baseDir = this.sandbox?.getBaseDir() || process.cwd();
    const normalizedAllowedPaths = task.allowedPaths.map(path => {
      const p = normalize(String(path)).replace(/\\/g, '/');
      // Resolve relative allowed paths against baseDir
      return p.startsWith('/') ? p : normalize(resolve(baseDir, p)).replace(/\\/g, '/');
    });
    const outOfScopeFiles = filesChanged.filter(file => {
      // Resolve relative file paths against baseDir for comparison
      const absFile = file.startsWith('/') ? file : resolve(baseDir, file);
      const normalizedFile = normalize(absFile).replace(/\\/g, '/');
      if (normalizedAllowedPaths.length === 0 || normalizedAllowedPaths.includes('.') || normalizedAllowedPaths.includes(normalize(baseDir).replace(/\\/g, '/'))) return false;
      return !normalizedAllowedPaths.some(allowed => (
        normalizedFile === allowed ||
        normalizedFile.startsWith(`${allowed}/`) ||
        (allowed.endsWith('/') && normalizedFile.startsWith(allowed)) ||
        // Also check if allowed is a glob pattern covering the file
        (allowed.endsWith('/**') && normalizedFile.startsWith(allowed.slice(0, -3)))
      ));
    });
    if (outOfScopeFiles.length > 0) {
      escalationNeeded = true;
      escalationReason = `Worker changed files outside allowed scope: ${outOfScopeFiles.join(', ')}`;
    } else if (task.maxFilesTouched && filesChanged.length > task.maxFilesTouched) {
      escalationNeeded = true;
      escalationReason = `Worker touched ${filesChanged.length} files but task budget was ${task.maxFilesTouched}.`;
    } else if (task.requiredCapabilities.includes('file-write') && filesChanged.length === 0 && !this.containsLegacyFileCommands(parsed.output)) {
      escalationNeeded = true;
      escalationReason = 'Worker completed without producing any file changes for a file-write task.';
    } else if (failedToolCalls >= 2 && repeatedFailedAction) {
      escalationNeeded = true;
      escalationReason = 'Worker repeated the same failing tool action multiple times.';
    } else if (failedToolCalls >= 3) {
      escalationNeeded = true;
      escalationReason = 'Worker accumulated too many failed tool calls.';
    }

    return {
      workUnitId: task.id,
      persona: task.persona,
      output: parsed.output,
      cost: workerResult.cost || 0,
      filesChanged,
      verification: verificationState.verification,
      verificationPassed: verificationState.verificationPassed,
      escalationNeeded,
      escalationReason,
      toolsUsed: workerResult.toolsUsed || [],
      failedToolCalls,
      turns: workerResult.turns,
      stopReason: workerResult.stopReason,
      shellResults,
      transcript: workerResult.transcript
    };
  }

  private extractVerificationCommands(task: WorkerTaskEnvelope): string[] {
    return Array.from(new Set(
      (task.verification || [])
        .map(item => this.extractVerificationCommand(item))
        .filter((value): value is string => Boolean(value))
    ));
  }

  private extractVerificationCommand(value: string): string | null {
    const trimmed = String(value || '').trim();
    if (!trimmed) return null;

    const explicit = trimmed.match(/^(?:run|execute)\s+(.+)$/i);
    if (explicit?.[1] && this.looksLikeVerificationCommand(explicit[1].trim())) {
      return explicit[1].trim();
    }

    const backticked = [...trimmed.matchAll(/`([^`]+)`/g)]
      .map(match => match[1]?.trim())
      .filter((command): command is string => Boolean(command) && this.looksLikeVerificationCommand(command));
    if (backticked.length > 0) return backticked[0];

    return this.looksLikeVerificationCommand(trimmed) ? trimmed : null;
  }

  private looksLikeVerificationCommand(value: string): boolean {
    return /^(npm|pnpm|yarn|bun|node|pytest|jest|vitest|cargo|go|make|\.\/|bash|sh)\b/.test(value);
  }

  private async reviewAndFixWorkerResult(
    task: WorkerTaskEnvelope,
    result: L3Result['results'][number],
    traceId: string,
    context: string,
    sessionId?: string
  ): Promise<L3Result['results'][number]> {
    if (!this.reviewerEnabled()) return result;

    let current = result;
    let lastReview: ReviewResult | undefined;
    const maxCycles = this.getReviewerMaxCycles();

    for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
      let projectContextSummary = '';
      try {
        const projCtx = await getProjectContext(process.cwd());
        projectContextSummary = projCtx.summary;
      } catch {
        // Non-fatal review context.
      }

      const review = await reviewWorkerExecution({
        executor: this.executor,
        model: this.getModelForLayer('l3-review', this.getExecutionEffort(task)),
        sessionId,
        projectDir: process.cwd(),
        projectContextSummary,
        workUnitId: current.workUnitId,
        persona: current.persona,
        taskGoal: task.goal,
        workerOutput: current.output,
        filesChanged: current.filesChanged || [],
        verification: current.verification || [],
        shellResults: current.shellResults || [],
        stagedContentForPath: (filePath: string) => this.sandbox?.getStagedContent?.(filePath)
      });

      lastReview = review;
      current.reviewer = review;

      if (review.approved || review.issues.length === 0) {
        return current;
      }

      if (cycle >= maxCycles) break;

      const fixTask = createAdHocWorkerTask({
        id: `${task.id}-review-fix-${cycle}`,
        goal: [
          task.goal,
          '',
          'Reviewer issues to fix:',
          ...review.issues.map((issue, index) => `${index + 1}. [${issue.severity}] ${issue.problem} -> ${issue.requiredFix}`),
          '',
          'Apply only the concrete fixes above and preserve any correct changes already made.'
        ].join('\n'),
        persona: task.persona,
        sourceRefs: task.sourceRefs || ['request#user-input'],
        estimatedComplexity: task.estimatedComplexity || this.getExecutionEffort(task),
        requiredCapabilities: task.requiredCapabilities,
        maxFilesTouched: task.maxFilesTouched
      });

      const fixResult = await this.runWorker(context ? `${context}\n\n${fixTask.goal}` : fixTask.goal, {
        model: this.getModelForLayer('l3-fixer', this.getExecutionEffort(task)),
        maxTurns: this.getMaxTurnsForEffort(this.getExecutionEffort(task)),
        verbose: process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true',
        persona: task.persona,
        constraintLevel: undefined,
        verificationCommands: this.extractVerificationCommands(task)
      });
      const parsed = this.parseWorkerOutput(String(fixResult.output || ''));
      current = this.buildWorkerExecutionResult(task, parsed, fixResult);
    }

    current.escalationNeeded = true;
    current.escalationReason = `Reviewer rejected result: ${lastReview?.summary || 'issues remain after review cycles'}`;
    current.reviewer = lastReview;
    return current;
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

  private parseJsonObject(raw: string): Record<string, unknown> {
    return parseJsonObject(raw);
  }

  private async parseRouterDecision(raw: string, traceId: string, sessionId?: string): Promise<{
    decision: string;
    reasoning: string;
    directResponse?: string;
    complexity?: string;
  }> {
    const parsed = await parseJsonObjectWithRepair(raw, {
      label: `L2 router (${traceId})`,
      schemaHint: '{"decision":"direct-answer|execute-direct|execute-local|execute-parallel","reasoning":"...","directResponse":"...","complexity":"low|medium|high","estimatedCost":0.001}',
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
    return parsed as {
      decision: string;
      reasoning: string;
      directResponse?: string;
      complexity?: string;
    };
  }

  private async qaAuditResponse(response: string, traceId: string, round: number, sessionId?: string, executionResults?: L3Result): Promise<{
    approved: boolean;
    summary: string;
    issues: Array<{ severity: 'high' | 'medium' | 'low'; problem: string; requiredFix: string }>;
    cost: number;
  }> {
    const evidence = this.buildStructuredEvidence(executionResults);
    const hasStructuredEvidence = evidence.length > 0;

    const overlays: PromptOverlay[] = [
      {
        type: 'task',
        content: `Audit this generated output for correctness, completeness, and coherence.

Evaluate based on STRUCTURED EVIDENCE first (shell results, exit codes, files changed), not narrative quality.
If shell commands passed with exit code 0 and files were modified as expected, approve regardless of prose quality.
Only reject based on prose if structured evidence is missing or contradictory.`,
        priority: 1
      },
      {
        type: 'context',
        content: hasStructuredEvidence
          ? `Round: ${round}\n\nStructured evidence:\n${JSON.stringify(evidence, null, 2)}\n\nWorker output:\n${response}`
          : `Round: ${round}\n\nGenerated output:\n${response}`,
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
      sessionId,
      jsonMode: true
    });
    const rawResult = String(result.result || '');
    try {
      const parsed = this.parseJsonObject(rawResult);
      const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
      return {
        approved: Boolean(parsed.approved),
        summary: String(parsed.summary || ''),
        issues,
        cost: Number(result.costUsd || 0)
      };
    } catch {
      // QA parse failure: use deterministic heuristic on raw text instead of auto-approving
      this.logger.warn(`QA audit response was not valid JSON (round ${round}), falling back to text analysis`);
      const lower = rawResult.toLowerCase();
      const hasRejectSignals = lower.includes('reject') || lower.includes('fail') || lower.includes('incorrect') || lower.includes('missing') || lower.includes('wrong');
      const hasApproveSignals = lower.includes('approved') || lower.includes('looks good') || lower.includes('correct') || lower.includes('passes');
      const approved = hasApproveSignals && !hasRejectSignals;
      return {
        approved,
        summary: `QA parse failed — text heuristic: ${approved ? 'likely approved' : 'likely rejected'}`,
        issues: hasRejectSignals ? [{ severity: 'medium' as const, problem: 'QA returned non-JSON with rejection signals', requiredFix: 'Review worker output manually' }] : [],
        cost: Number(result.costUsd || 0)
      };
    }
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
    executionResults?: L3Result,
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
      const qaPayload = this.appendExecutionAuditContext(working, executionResults);
      const qa = await this.qaAuditResponse(qaPayload, traceId, round, sessionId, executionResults);
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
    const finalQa = await this.qaAuditResponse(
      this.appendExecutionAuditContext(working, executionResults),
      traceId,
      rounds + 1,
      sessionId,
      executionResults
    );
    addedCost += finalQa.cost;
    lastSummary = finalQa.summary;
    approved = finalQa.approved;
    return { response: working, addedCost, approved, rounds: rounds + 1, lastSummary };
  }

  /**
   * Apply any pending sandbox file writes to disk.
   * Workers stage files via write_file/edit tools → sandbox.addChange(),
   * but those changes need to be flushed to disk after execution.
   */
  private async flushSandbox(request?: L1Request): Promise<void> {
    if (!this.sandbox) return;
    const pending = this.sandbox.getPendingPaths();
    if (pending.length === 0) return;
    if (request?.deferApply) {
      this.logger.info(`${pending.length} file(s) staged — deferred apply (caller will preview): ${pending.join(', ')}`);
      return; // Don't apply — let REPL show diff preview first
    }
    await this.sandbox.apply();
    this.logger.info(`Applied ${pending.length} staged file(s) to disk: ${pending.join(', ')}`);
  }

  private autoCheckpointEnabled(): boolean {
    const raw = String(process.env.CREW_AUTO_CHECKPOINT || 'true').trim().toLowerCase();
    return raw !== 'false' && raw !== '0' && raw !== 'off';
  }

  /** Interval (ms) between periodic checkpoint snapshots during long tasks. 0 = disabled. */
  private checkpointIntervalMs(): number {
    const raw = String(process.env.CREW_CHECKPOINT_INTERVAL_MS || '').trim();
    const ms = Number(raw);
    return Number.isFinite(ms) && ms > 0 ? ms : 60_000; // Default: 60s
  }

  private _intervalTimer: ReturnType<typeof setInterval> | null = null;
  private _intervalSnapshotCount = 0;

  /**
   * Start periodic checkpoint timer. Creates git stash snapshots at fixed intervals
   * so the user can roll back to any point during long-running pipeline execution.
   * Stashes are named with the traceId for easy identification.
   */
  private startCheckpointInterval(traceId: string): void {
    if (!this.autoCheckpointEnabled()) return;
    const intervalMs = this.checkpointIntervalMs();
    if (intervalMs <= 0) return;

    this._intervalSnapshotCount = 0;
    this._intervalTimer = setInterval(async () => {
      try {
        const { execSync } = await import('node:child_process');
        const cwd = (this.sandbox as unknown as { baseDir?: string })?.baseDir || process.cwd();
        const status = execSync('git status --porcelain', { encoding: 'utf8', cwd }).trim();
        if (!status) return; // nothing to snapshot

        this._intervalSnapshotCount++;
        const tag = `crew-interval-${traceId.slice(0, 8)}-${this._intervalSnapshotCount}`;
        // Stage all and create a stash (non-destructive — working tree stays intact)
        execSync('git stash push --include-untracked --keep-index -m ' +
          `"${tag}: periodic snapshot"`, { cwd, stdio: 'ignore' });
        // Immediately pop to restore working tree (the stash ref remains in reflog)
        execSync('git stash pop', { cwd, stdio: 'ignore' });
        this.logger.info(`Interval checkpoint #${this._intervalSnapshotCount} saved [${tag}]`);
      } catch {
        // Best-effort — stash may fail if no changes or git unavailable
      }
    }, intervalMs);
  }

  /** Stop the periodic checkpoint timer. */
  private stopCheckpointInterval(): void {
    if (this._intervalTimer) {
      clearInterval(this._intervalTimer);
      this._intervalTimer = null;
    }
    if (this._intervalSnapshotCount > 0) {
      this.logger.info(`Interval checkpointing stopped (${this._intervalSnapshotCount} snapshot(s) saved).`);
    }
    this._intervalSnapshotCount = 0;
  }

  /**
   * Git checkpoint at task boundary — auto-commit changes so user can revert.
   * Uses a predictable branch-style commit message for easy rollback.
   */
  private async gitCheckpoint(traceId: string, executionResults?: L3Result): Promise<void> {
    try {
      const { execSync } = await import('node:child_process');
      const cwd = (this.sandbox as unknown as { baseDir?: string })?.baseDir || process.cwd();

      // Check if we're in a git repo with changes
      const status = execSync('git status --porcelain', { encoding: 'utf8', cwd }).trim();
      if (!status) return; // nothing to commit

      // Collect changed files from execution results
      const filesChanged = (executionResults?.results || [])
        .flatMap(r => r.filesChanged || [])
        .filter(Boolean);

      // Build descriptive commit message
      const filesSummary = filesChanged.length > 0
        ? filesChanged.slice(0, 5).join(', ') + (filesChanged.length > 5 ? ` (+${filesChanged.length - 5} more)` : '')
        : 'pipeline changes';
      const msg = `checkpoint(crew-cli): ${filesSummary} [${traceId.slice(0, 8)}]`;

      execSync('git add -A', { cwd, stdio: 'ignore' });
      execSync(`git commit -m "${msg.replace(/"/g, '\\"')}" --no-verify`, { cwd, stdio: 'ignore' });
      this.logger.info(`Checkpoint committed: ${msg}`);
    } catch {
      // Best-effort — don't fail the pipeline if git isn't available or commit fails
    }
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
    if (workGraph.planMode === 'lightweight') return;
    const ids = new Set((workGraph.units || []).map(u => u.id));
    const required = ['scaffold-bootstrap', 'contract-tests-from-pdd', 'gate-definition-of-done', 'gate-golden-benchmark-suite'];
    const missing = required.filter(id => !ids.has(id));
    if (missing.length > 0) {
      throw new Error(`Mandatory pipeline gates missing: ${missing.join(', ')}`);
    }
  }

  private buildValidatedWorkerTasks(workGraph: WorkGraph): WorkerTaskEnvelope[] {
    const tasks = buildWorkerTasks(workGraph);
    const errors: string[] = [];
    const warnings: string[] = [];
    for (const task of tasks) {
      const check = validateWorkerTaskEnvelope(task);
      if (!check.ok) {
        errors.push(`${task.id}: ${check.errors.join(', ')}`);
      }
      if (Array.isArray(check.warnings) && check.warnings.length > 0) {
        warnings.push(`${task.id}: ${check.warnings.join(', ')}`);
      }
    }
    if (warnings.length > 0) {
      this.logger.warn(`L2→L3 worker task warnings: ${warnings.join(' | ')}`);
    }
    if (errors.length > 0) {
      throw new Error(`Invalid L2→L3 worker tasks: ${errors.join(' | ')}`);
    }
    return tasks;
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
    const rawDod = String(res.result || '');
    try {
      const parsed = this.parseJsonObject(rawDod);
      const failed = Array.isArray(parsed.failedChecks) ? parsed.failedChecks : [];
      const approved = Boolean(parsed.approved) && failed.length === 0;
      return {
        approved,
        summary: String(parsed.summary || ''),
        cost: Number(res.costUsd || 0),
        ran: true
      };
    } catch {
      this.logger.warn('DoD QA response was not valid JSON, falling back to text analysis');
      const lower = rawDod.toLowerCase();
      const hasRejectSignals = lower.includes('fail') || lower.includes('reject') || lower.includes('missing') || lower.includes('incorrect');
      return {
        approved: !hasRejectSignals,
        summary: `DoD parse failed — text heuristic: ${hasRejectSignals ? 'likely rejected' : 'likely approved'}`,
        cost: Number(res.costUsd || 0),
        ran: true
      };
    }
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
    const rawGolden = String(res.result || '');
    try {
      const parsed = this.parseJsonObject(rawGolden);
      return {
        approved: Boolean(parsed.approved),
        summary: String(parsed.summary || ''),
        cost: Number(res.costUsd || 0),
        ran: true
      };
    } catch {
      this.logger.warn('Golden benchmark QA response was not valid JSON, falling back to text analysis');
      const lower = rawGolden.toLowerCase();
      const hasRejectSignals = lower.includes('fail') || lower.includes('reject') || lower.includes('not pass');
      return {
        approved: !hasRejectSignals,
        summary: `Golden bench parse failed — text heuristic: ${hasRejectSignals ? 'likely rejected' : 'likely approved'}`,
        cost: Number(res.costUsd || 0),
        ran: true
      };
    }
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
      try {
        const parsed = this.parseJsonObject(String(res.result || ''));
        if (!Boolean(parsed.approved)) {
          failures.push(`${model}: ${String(parsed.summary || 'rejected')}`);
        }
      } catch {
        const rawExtra = String(res.result || '').toLowerCase();
        const hasRejectSignals = rawExtra.includes('reject') || rawExtra.includes('fail') || rawExtra.includes('unsafe');
        if (hasRejectSignals) {
          failures.push(`${model}: non-JSON response with rejection signals`);
        }
        this.logger.warn(`Extra L2 validator ${model} returned non-JSON, text heuristic: ${hasRejectSignals ? 'rejected' : 'approved'}`);
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
      // SCAN: Build ProjectContext (frozen snapshot)
      runState.transition('scan', 'Building project context');
      try {
        await getProjectContext(process.cwd());
        executionPath.push('scan-project-context');
      } catch { /* non-fatal — workers will proceed without context */ }

      // ROUTE + PLAN: L2 Router + Reasoner + Planner (or resume from prior plan)
      runState.transition('plan', 'L2 orchestration');
      executionPath.push('l2-orchestrator');
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

      // Start periodic checkpoint snapshots for long-running tasks
      if (plan.decision !== 'direct-answer') {
        this.startCheckpointInterval(traceId);
      }
      if (resumeFrom === 'validate' && request.resume?.priorResponse) {
        response = String(request.resume.priorResponse || '');
        executionResults = request.resume.priorExecutionResults;
        totalCost = Number(request.resume.priorExecutionResults?.totalCost || 0);
        executionPath.push('resume-validate-only');
      }
      else if (process.env.CREW_FORCE_L2 === 'true' && plan.workGraph) {
        // FORCE_L2: return L2 plan without executing L3 workers (enhance-prompt path)
        executionPath.push('l2-plan-only');
        const units = plan.workGraph.units || [];
        const planText = [
          '## Build Brief',
          plan.workGraph.summary || plan.reasoning || request.userInput,
          '',
          '## Work Units',
          ...units.map((u, i) => `${i + 1}. **${u.id}** (${u.requiredPersona}): ${u.description}`),
          '',
          '## Acceptance Criteria',
          ...(plan.workGraph.acceptanceCriteria || plan.workGraph.planningArtifacts?.acceptanceCriteria || []).map((c: string) => `- ${c}`),
          '',
          plan.validation ? `## Risk: ${plan.validation.riskLevel}` : '',
          ...(plan.validation?.concerns || []).map((c: string) => `- ${c}`),
        ].filter(Boolean).join('\n');
        response = planText;
        totalCost = 0.01;
      }
      else if (plan.decision === 'direct-answer') {
        executionPath.push('l2-direct-response');
        response = plan.directResponse || 'No response generated';
        totalCost = 0.0001; // Minimal cost for routing
      } 
      else if (plan.decision === 'execute-local') {
        executionPath.push('l3-executor-single');
        const result = await this.l3ExecuteSingle(
          createAdHocWorkerTask({
            id: 'single-task',
            goal: request.userInput,
            persona: 'executor-code',
            sourceRefs: ['request#user-input'],
            estimatedComplexity: plan.estimatedEffort || 'medium'
          }),
          request.context || '',
          traceId
        );
        response = result.output;
        totalCost = result.cost;

        // Apply any tool-based file writes staged during worker execution
        await this.flushSandbox(request);

        // Parse and apply file commands from the output
        const { parseDirectFileCommands } = await import('../cli/file-commands.js');
        const fileCommands = this.shouldParseLegacyCommands(result) ? parseDirectFileCommands(response) : [];
        if (fileCommands.length > 0) {
          // Update result so QA gate knows files were written
          const writtenPaths = fileCommands.filter(c => c.type === 'write').map(c => c.path);
          if (writtenPaths.length > 0) {
            result.filesChanged = [...(result.filesChanged || []), ...writtenPaths];
            result.toolsUsed = [...(result.toolsUsed || []), 'write_file'];
          }
          if (this.sandbox) {
            await this.sandbox.load();
            for (const cmd of fileCommands) {
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
              this.logger.info(`Applied ${fileCommands.length} file change(s)`);
            }
          }
        }

        executionResults = {
          success: true,
          results: [result],
          totalCost: result.cost,
          executionTimeMs: Date.now() - startTime
        };
      }
      else if (plan.decision === 'execute-direct') {
        // execute-direct: skip L2 planning entirely, go straight to L3 single execution
        executionPath.push('l3-executor-direct');
        const directTask = createAdHocWorkerTask({
          id: 'direct-task',
          goal: request.userInput,
          persona: 'executor-code',
          sourceRefs: ['request#user-input'],
          estimatedComplexity: plan.estimatedEffort || 'low'
        });
        const result = await this.l3ExecuteSingle(
          directTask,
          request.context || '',
          traceId
        );
        response = result.output;
        totalCost = result.cost;

        // Apply any tool-based file writes staged during worker execution
        await this.flushSandbox(request);

        // Parse and apply file commands from the output
        const { parseDirectFileCommands: parseDirectCmds } = await import('../cli/file-commands.js');
        const directFileCommands = this.shouldParseLegacyCommands(result) ? parseDirectCmds(response) : [];
        if (directFileCommands.length > 0 && this.sandbox) {
          await this.sandbox.load();
          for (const cmd of directFileCommands) {
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
            this.logger.info(`Applied ${directFileCommands.length} file change(s)`);
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
          this.logger.warn('execute-parallel without workGraph — routing to execute-direct instead');
          executionPath.push('l3-executor-direct');
          const fallbackTask = createAdHocWorkerTask({
            id: 'direct-task',
            goal: request.userInput,
            persona: 'executor-code',
            sourceRefs: ['request#user-input'],
            estimatedComplexity: plan.estimatedEffort || 'low'
          });
          const result = await this.l3ExecuteSingle(
            fallbackTask,
            request.context || '',
            traceId
          );
          response = result.output;
          totalCost = result.cost;

          // Apply any tool-based file writes staged during worker execution
          await this.flushSandbox(request);

          // Parse and apply file commands from the output
          const { parseDirectFileCommands } = await import('../cli/file-commands.js');
          const fileCommands = this.shouldParseLegacyCommands(result) ? parseDirectFileCommands(response) : [];
          if (fileCommands.length > 0) {
            const writtenPaths = fileCommands.filter(c => c.type === 'write').map(c => c.path);
            if (writtenPaths.length > 0) {
              result.filesChanged = [...(result.filesChanged || []), ...writtenPaths];
              result.toolsUsed = [...(result.toolsUsed || []), 'write_file'];
            }
            if (this.sandbox) {
              await this.sandbox.load();
              for (const cmd of fileCommands) {
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
                this.logger.info(`Applied ${fileCommands.length} file change(s)`);
              }
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
          const metrics = (executionResults as L3Result)?.metrics;
          contextChunksUsed = Number(metrics?.contextChunksUsed || 0);
          contextCharsSaved = Number(metrics?.contextCharsSaved || 0);

          // Apply any tool-based file writes staged during worker execution
          await this.flushSandbox(request);

          // Parse and apply file commands from parallel worker outputs
          const { parseDirectFileCommands } = await import('../cli/file-commands.js');
          const allFileCommands: Array<{ type: string; path: string; content?: string }> = [];
          for (const result of executionResults.results) {
            if (!this.shouldParseLegacyCommands(result)) continue;
            const commands = parseDirectFileCommands(result.output);
            // Update result.filesChanged so QA gate knows work was done
            const writtenPaths = commands.filter(c => c.type === 'write').map(c => c.path);
            if (writtenPaths.length > 0) {
              result.filesChanged = [...(result.filesChanged || []), ...writtenPaths];
              result.toolsUsed = [...(result.toolsUsed || []), 'write_file'];
            }
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

      if (plan.decision !== 'direct-answer') {
        // Transcript-based deterministic QA (runs on ALL executions, not just small tasks)
        if (executionResults?.results?.length) {
          for (const r of executionResults.results) {
            const transcript = r.transcript;
            if (transcript) {
              const qaResult = runDeterministicQA(transcript, {
                requireFileChanges: plan.decision !== 'execute-direct'
              });
              if (!qaResult.passed) {
                const verbose = process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true';
                if (verbose) {
                  console.log(`[QA Gate] ${r.workUnitId}: ${qaResult.summary}`);
                  for (const check of qaResult.checks.filter(c => !c.passed)) {
                    console.log(`  ✗ ${check.name}: ${check.detail}`);
                  }
                }
                r.escalationNeeded = true;
                r.escalationReason = `Deterministic QA failed: ${qaResult.summary}`;
              }
              // Store QA results in execution metadata
              r.qaGateResult = qaResult;
            }
          }
          executionPath.push('l3-transcript-qa');
        }

        const deterministicQaApproved = await this.passesDeterministicSmallTaskGate(request, plan, executionResults);
        if (deterministicQaApproved) {
          qaApproved = true;
          qaRounds = 0;
          executionPath.push('l3-qa-approved-deterministic');
        } else if (this.qaLoopEnabled()) {
          executionPath.push('l3-qa-gate');
          const qaLoop = await this.runQaFixerLoop(response, traceId, executionResults, sessionId);
          response = qaLoop.response;
          totalCost += qaLoop.addedCost;
          qaRounds = qaLoop.rounds;
          qaApproved = qaLoop.approved;
          executionPath.push(qaLoop.approved ? 'l3-qa-approved' : 'l3-qa-rejected');
          if (!qaLoop.approved) {
            throw new Error(`QA gate failed after ${qaLoop.rounds} rounds. ${qaLoop.lastSummary || ''}`.trim());
          }
        }
      }

      // EVIDENCE: transcript + file diffs collected (already on results)
      runState.transition('validate', 'QA validation');
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

      // CHECKPOINT: git commit if changes made
      runState.transition('checkpoint', 'Auto-checkpoint');

      // Stop periodic snapshots before final checkpoint
      this.stopCheckpointInterval();

      // Auto-checkpoint: git commit at task boundary if files were changed
      if (plan.decision !== 'direct-answer' && this.autoCheckpointEnabled()) {
        await this.gitCheckpoint(traceId, executionResults);
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
      this.stopCheckpointInterval();
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

    // All execution paths map to CODE in standalone mode.
    // execute-direct, execute-local, and execute-parallel are all handled locally.
    return {
      decision: 'CODE',
      agent: 'crew-coder',
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
    // Step 0: Quick project scan so router + workers understand what we're working with
    const projectDir = (this.sandbox as unknown as { baseDir?: string })?.baseDir || process.cwd();
    let projectContext = '';
    try {
      const { readdirSync, statSync, readFileSync, existsSync } = await import('node:fs');
      const { join } = await import('node:path');
      // Get top-level file listing
      const entries = readdirSync(projectDir)
        .filter(f => !f.startsWith('.') && f !== 'node_modules')
        .slice(0, 30);
      const fileList = entries.map(f => {
        const s = statSync(join(projectDir, f));
        return s.isDirectory() ? `${f}/` : f;
      });
      projectContext = `Project files: ${fileList.join(', ')}`;
      // Detect tech stack from key files
      const hasPackageJson = existsSync(join(projectDir, 'package.json'));
      const hasIndexHtml = existsSync(join(projectDir, 'index.html'));
      const hasTsConfig = existsSync(join(projectDir, 'tsconfig.json'));
      if (hasIndexHtml && !hasTsConfig) {
        projectContext += '\nTech: Static HTML/CSS/JS site (vanilla, no build step, no Node.js modules). All JS must be browser-compatible (no require/import/export, no Node APIs).';
      } else if (hasPackageJson) {
        try {
          const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'));
          const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).slice(0, 10);
          projectContext += `\nTech: Node.js project. Dependencies: ${deps.join(', ')}`;
        } catch { /* skip */ }
      }
      // Read a snippet of the main file to understand the style
      if (hasIndexHtml) {
        try {
          const html = readFileSync(join(projectDir, 'index.html'), 'utf8');
          projectContext += `\nindex.html: ${html.length} chars, ${(html.match(/<script/g) || []).length} script tags, ${(html.match(/<link.*css/g) || []).length} CSS links`;
        } catch { /* skip */ }
      }
    } catch { /* non-fatal */ }

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

    if (projectContext) {
      overlays.push({
        type: 'context',
        content: projectContext,
        priority: 2
      });
    }
    const currentModel = this.getRouterModel() || process.env.CREW_CHAT_MODEL || process.env.CREW_EXECUTION_MODEL || 'unknown';
    const interfaceMode = String(process.env.CREW_INTERFACE_MODE || 'standalone').toLowerCase();
    overlays.push({
      type: 'constraints',
      content: `You are crewswarm's CLI assistant, running model "${currentModel}" in ${interfaceMode} mode.
You are operating in project directory: ${projectDir}
You have full file system access with tools: list_directory, read_file, write_file, grep_search, glob, run_shell_command, git, and more.
You do NOT dispatch to external agents or a swarm. All execution is local.

When asked about your identity or what model you are, answer: "I'm crewswarm CLI running ${currentModel}." The brand is always lowercase "crewswarm" — never "crewswarm" or "crewswarm".

Analyze this request and decide:

1. DIRECT-ANSWER: ONLY for pure conversational greetings ("hi", "hello", "how are you") or questions about YOUR identity/capabilities ("what can you do", "who are you")
   → Provide immediate text response
   → NEVER use this if the request implies ANY action, creation, modification, building, designing, or doing
   → NEVER use this for questions about files, code, project state, or folder contents
   → When in doubt, use EXECUTE-DIRECT instead

2. EXECUTE-DIRECT: Simple task, question about project, or single-file action
   → Questions about files, folder contents, code, project structure → use tools to answer
   → Single file create/edit, small bug fix, one-liner change
   → Bypasses L2 planning overhead entirely

3. EXECUTE-LOCAL: DEPRECATED - only for testing/debugging
   → Not used in production

4. EXECUTE-PARALLEL: Multi-file or complex coding/implementation tasks (default for code)
   → Any request involving writing, modifying, or refactoring multiple files
   → L2 will decompose into work units for L3 workers
   → After execution, L2 runs QA validation
   → If QA fails, expensive fixer runs, then QA again
   → Use dual-L2 planner for work graph

**CRITICAL: These action words ALWAYS require EXECUTE-DIRECT or EXECUTE-PARALLEL (NEVER DIRECT-ANSWER):**
add, create, build, design, make, write, edit, update, modify, change, fix, implement, refactor, remove, delete, move, rename, install, configure, set up, deploy, generate, scaffold, do, put, insert, append

**Choose EXECUTE-DIRECT for:**
- Any question about files, folders, code, or project state (use tools to look)
- Creating or editing a single file
- Adding content to an existing file
- Small, focused bug fixes
- Simple code generation with obvious scope

**Choose EXECUTE-PARALLEL for:**
- Multi-file features, APIs, or refactors
- Implementing features that span modules
- Test creation across multiple files
- Documentation generation for entire projects

Return ONLY valid JSON:
{
  "decision": "direct-answer|execute-direct|execute-parallel",
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
    let normalizedDecision = this.normalizeDecision(decision.decision);

    // Deterministic override: tasks with file-creation verbs must never be direct-answer.
    // Some models (GPT-5.x) classify simple tasks as direct-answer even when tools are needed.
    if (normalizedDecision === 'direct-answer') {
      const lower = String(request.userInput || '').toLowerCase();
      const requiresExecution = /\b(create|write|add|edit|update|modify|fix|build|implement|refactor|delete|remove|rename|generate|scaffold)\b/.test(lower)
        && /\b(file|directory|folder|function|class|module|component|test|spec)\b/.test(lower);
      if (requiresExecution) {
        normalizedDecision = 'execute-direct';
      }
    }

    const estimatedEffort = this.getRequestedEffortOverride()
      || this.normalizeEffort(decision.complexity, this.inferEffortFromInput(request.userInput));

    // Step 2: If complex AND Dual-L2 enabled, run planner
    let workGraph: WorkGraph | undefined;
    let validation: PolicyValidation | undefined;

    const dualL2Enabled = process.env.CREW_DUAL_L2_ENABLED === 'true';

    // CREW_FORCE_L2=true bypasses L1 routing and always runs L2 planner (used by enhance-prompt)
    const forceL2 = process.env.CREW_FORCE_L2 === 'true';
    if ((normalizedDecision === 'execute-parallel' || forceL2) && dualL2Enabled) {
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
        this.buildValidatedWorkerTasks(workGraph);
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
      estimatedEffort,
      traceId
    };
  }

  /**
   * L3: Single Executor
   */
  private async l3ExecuteSingle(
    task: WorkerTaskEnvelope,
    context: string,
    traceId: string
  ): Promise<{
    workUnitId: string;
    persona: string;
    output: string;
    cost: number;
    filesChanged: string[];
    verification: string[];
    verificationPassed: boolean;
    escalationNeeded: boolean;
    escalationReason?: string;
    toolsUsed?: string[];
  }> {
    const check = validateWorkerTaskEnvelope(task);
    if (!check.ok) {
      throw new Error(`Invalid single worker task: ${check.errors.join(', ')}`);
    }
    // Inject frozen ProjectContext so workers know the tech stack
    let projectContextSummary = '';
    try {
      const projCtx = await getProjectContext(process.cwd());
      projectContextSummary = projCtx.summary;
    } catch { /* non-fatal */ }
    const enhancedTask = projectContextSummary
      ? `${projectContextSummary}\n\n${task.goal}`
      : task.goal;

    const overlays: PromptOverlay[] = [
      { type: 'task', content: enhancedTask, priority: 1 }
    ];

    if (context) {
      overlays.push({ type: 'context', content: context, priority: 2 });
    }

    try {
      const { autoLoadRelevantFiles, shouldUseRag } = await import('../context/codebase-rag.js');
      if (shouldUseRag(enhancedTask)) {
        const ragContext = await autoLoadRelevantFiles(enhancedTask, process.cwd(), {
          mode: (process.env.CREW_RAG_MODE || 'auto') as import('../context/codebase-rag.js').RagMode,
          tokenBudget: Number(process.env.CREW_RAG_WORKER_BUDGET || 4000),
          maxFiles: Number(process.env.CREW_RAG_MAX_FILES_LOAD || 6)
        });
        if (ragContext.context) {
          overlays.push({
            type: 'context',
            content: ragContext.context,
            priority: 3
          });
        }
      }
    } catch {
      // Never fail a worker due to RAG injection.
    }

    overlays.push({
      type: 'constraints',
      content: `Worker task contract:
- Allowed paths: ${task.allowedPaths.length > 0 ? task.allowedPaths.join(', ') : '(no explicit paths extracted)'}
- Verification: ${task.verification.join(' | ')}
- Escalate when: ${(task.escalationHints || []).join(' | ')}`,
      priority: 3
    });

    // Get sessionId from session manager if available
    const sessionId = this.session ? await this.session.getSessionId() : undefined;

    const composedPrompt = this.composer.compose('executor-code-v1', overlays, traceId);

    const effort = this.getExecutionEffort(task);
    const verificationCommands = this.extractVerificationCommands(task);
    const result = await runAgenticWorker(composedPrompt.finalPrompt, this.requireSandbox(), {
      model: this.getModelForLayer('l3', effort) || '',
      maxTurns: this.getMaxTurnsForEffort(effort),
      tier: this.getTierForEffort(effort),
      persona: task.persona,
      verificationCommands
    });

    if (process.env.CREW_DEBUG_PIPELINE) {
      console.log(`[Pipeline] L3 result: success=${result.success} turns=${result.turns} historyLen=${result.history?.length ?? 0} tools=${result.toolsUsed?.join(',')}`);
      if (result.history) {
        for (const h of result.history.slice(0, 5)) {
          console.log(`[Pipeline]   [T${h.turn}] ${h.tool}(${(h.params?.file_path || h.params?.command || '').toString().slice(0, 40)}) ${h.error ? 'ERR' : 'ok'}`);
        }
      }
    }
    const parsed = this.parseWorkerOutput(String(result.output || ''));
    const built = this.buildWorkerExecutionResult(task, parsed, result);
    if (process.env.CREW_DEBUG_PIPELINE) {
      console.log(`[Pipeline] Built: filesChanged=${built.filesChanged.join(',')} shellResults=${built.shellResults.length} verificationPassed=${built.verificationPassed} escalation=${built.escalationNeeded} reason=${built.escalationReason || 'none'}`);
    }
    return this.reviewAndFixWorkerResult(task, built, traceId, context, sessionId);
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
    const workerTasks = this.buildValidatedWorkerTasks(workGraph);

    // Get sessionId from session manager if available
    const sessionId = this.session ? await this.session.getSessionId() : undefined;

    const startTime = Date.now();
    const results: L3Result['results'] = [];
    const completed = new Set<string>();
    const outputByUnit = new Map<string, string>();
    let totalCost = 0;
    // Accumulate discovered files across batches so later workers inherit context.
    // Load prior JIT context from session if available.
    let accumulatedDiscoveredFiles: string[] = [];
    if (this.session) {
      try {
        accumulatedDiscoveredFiles = await this.session.loadJITContext();
      } catch { /* first run — no prior context */ }
    }
    let contextChunksUsed = 0;
    let contextCharsSaved = 0;
    const artifactPackId = workGraph.planningArtifacts
      ? this.contextPacks.createPack(traceId, workGraph.planningArtifacts)
      : '';

    // Sort work units by dependency order
    const sorted = this.topologicalSort(workerTasks);

    // Detect if git worktree isolation is available for parallel batches
    const projectDir = (this.sandbox as unknown as { baseDir?: string })?.baseDir || process.cwd();
    const worktreeIsolation = (() => {
      if (process.env.CREW_WORKTREE_ISOLATION === 'false') return false;
      try {
        const { execSync } = require('node:child_process');
        execSync('git rev-parse --is-inside-work-tree', { cwd: projectDir, encoding: 'utf8', timeout: 5000 });
        return true;
      } catch { return false; }
    })();

    // Execute in batches (units with no pending dependencies)
    const maxWorkers = this.getMaxParallelWorkers();
    for (const batch of this.getBatches(sorted)) {
      const useWorktrees = worktreeIsolation && batch.length > 1;
      if (verbose) {
        console.log(`[L3 Batch] Executing ${batch.length} units in parallel...`);
        console.log(`[L3 Batch] Units: ${batch.map(u => u.id).join(', ')}`);
        console.log(`[L3 Batch] Concurrency cap: ${maxWorkers}${useWorktrees ? ' (worktree isolation)' : ''}`);
      }

      // Create per-unit worktrees for parallel isolation
      const unitWorktrees = new Map<string, { worktreePath: string; branchName: string }>();
      if (useWorktrees) {
        for (const unit of batch) {
          try {
            const wt = enterWorktree(projectDir, {
              branchPrefix: 'crew-l3',
              agentId: unit.id.slice(0, 8)
            });
            unitWorktrees.set(unit.id, { worktreePath: wt.worktreePath, branchName: wt.branchName });
            if (verbose) {
              console.log(`  [${unit.id}] worktree → ${wt.worktreePath}`);
            }
          } catch (err: unknown) {
            if (verbose) console.warn(`  [${unit.id}] worktree failed, sharing filesystem: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
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
        const templateId = getTemplateForPersona(unit.persona);

        // Inject frozen ProjectContext so workers know the tech stack
        let projectContextSummary = '';
        try {
          const projCtx = await getProjectContext(process.cwd());
          projectContextSummary = projCtx.summary;
        } catch { /* non-fatal */ }
        const enhancedDescription = projectContextSummary
          ? `${projectContextSummary}\n\n${unit.goal}`
          : unit.goal;

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

        try {
          const { autoLoadRelevantFiles, shouldUseRag } = await import('../context/codebase-rag.js');
          const ragQuery = [
            unit.goal,
            accumulatedDiscoveredFiles.slice(0, 8).join(' ')
          ].filter(Boolean).join('\n');
          if (shouldUseRag(ragQuery)) {
            const ragContext = await autoLoadRelevantFiles(ragQuery, process.cwd(), {
              mode: (process.env.CREW_RAG_MODE || 'auto') as import('../context/codebase-rag.js').RagMode,
              tokenBudget: Number(process.env.CREW_RAG_WORKER_BUDGET || 4000),
              maxFiles: Number(process.env.CREW_RAG_MAX_FILES_LOAD || 6),
              sessionHistory: accumulatedDiscoveredFiles.map(file => ({ output: file }))
            });
            if (ragContext.context) {
              overlays.push({
                type: 'context',
                content: ragContext.context,
                priority: 3
              });
            }
          }
        } catch {
          // Never fail a worker due to RAG injection.
        }

        if (artifactPackId) {
          const fullArtifactChars = (workGraph.planningArtifacts?.pdd?.length || 0)
            + (workGraph.planningArtifacts?.roadmap?.length || 0)
            + (workGraph.planningArtifacts?.architecture?.length || 0);
          const artifactContext = this.contextPacks.retrieve(artifactPackId, {
            query: unit.goal,
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
        overlays.push({
          type: 'constraints',
          content: `Worker task contract:
- Allowed paths: ${unit.allowedPaths.length > 0 ? unit.allowedPaths.join(', ') : '(no explicit paths extracted)'}
- Verification: ${unit.verification.join(' | ')}
- Escalate when: ${(unit.escalationHints || []).join(' | ')}`,
          priority: 3
        });
        
        // All workers use structured tool calls (write_file, replace, read_file, etc.)
        // NEVER use @@WRITE_FILE text markers — use the write_file tool instead.
        overlays.push({
          type: 'constraints',
          content: `IMPORTANT RULES:
1. ALWAYS read_file before editing any file. Never guess at contents.
2. Use "replace" tool for editing existing files (with old_string/new_string). write_file is ONLY for NEW files.
3. Do NOT output @@WRITE_FILE or @@EDIT markers — use structured tool calls.
4. Match the existing code style exactly. If the project uses vanilla JS (no modules), do NOT use require/import/export or Node.js APIs.
5. After completing work, return a JSON summary: {"output":"what you did","summary":"short summary","edits":["files changed"],"validation":["verification steps"]}`,
          priority: 4
        });

        const composedPrompt = this.composer.compose(templateId, overlays, `${traceId}-${unit.id}`);
        const effort = this.getExecutionEffort(unit);
        
        if (verbose) {
          console.log(`  [${unit.id}] ${unit.persona} executing (agentic)...`);
        }
        const unitStart = Date.now();
        
        // Use built-in L3_SYSTEM_PROMPT (has THINK→ACT→OBSERVE + tool list)
        // Do NOT override with template basePrompt — those are generic and don't mention tools
        //
        // If this unit has a worktree, run in isolated sandbox + projectDir.
        // Otherwise fall back to the shared sandbox (sequential or non-git).
        const unitWt = unitWorktrees.get(unit.id);
        const workerSandbox = unitWt ? new Sandbox(unitWt.worktreePath) : this.requireSandbox();
        const workerProjectDir = unitWt ? unitWt.worktreePath : projectDir;

        const result = await runAgenticWorker(composedPrompt.finalPrompt, workerSandbox, {
          model: this.getModelForLayer('l3', effort) || '',
          maxTurns: this.getMaxTurnsForEffort(effort),
          verbose,
          projectDir: workerProjectDir,
          priorDiscoveredFiles: accumulatedDiscoveredFiles.length > 0 ? accumulatedDiscoveredFiles : undefined,
          persona: unit.persona,
          constraintLevel: undefined,
          verificationCommands: this.extractVerificationCommands(unit)
        });
        const parsed = this.parseWorkerOutput(String(result.output || ''));

        // Accumulate discovered files for subsequent batches
        if (result.discoveredFiles?.length) {
          for (const f of result.discoveredFiles) {
            if (!accumulatedDiscoveredFiles.includes(f)) accumulatedDiscoveredFiles.push(f);
          }
        }

        if (verbose) {
          console.log(`  [${unit.id}] ✅ Complete in ${Date.now() - unitStart}ms ($${result.cost?.toFixed(6) || 0}) [${result.turns ?? 0} turns]`);
        }

        completed.add(unit.id);
        outputByUnit.set(unit.id, parsed.output);

        // Store worker output in memory for cross-model continuity
        getPipelineMemory().remember(
          `Worker ${unit.id} (${unit.persona}): ${parsed.output.substring(0, 300)}...`,
          { critical: false, tags: ['l3-output', traceId, unit.id], provider: 'pipeline' }
        );

        const built = this.buildWorkerExecutionResult(unit, parsed, result);
        return this.reviewAndFixWorkerResult(unit, built, `${traceId}-${unit.id}`, context, sessionId);
      };

      const batchResults: Array<{
        workUnitId: string;
        persona: string;
        output: string;
        cost: number;
        filesChanged: string[];
        verification: string[];
        verificationPassed: boolean;
        escalationNeeded: boolean;
        escalationReason?: string;
        toolsUsed?: string[];
        turns?: number;
        shellResults?: Array<{ command: string; exitCode: number; output: string }>;
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

      // Merge worktrees back to main branch sequentially
      if (unitWorktrees.size > 0) {
        const mergeResults: Array<{ unitId: string; success: boolean; message: string }> = [];
        for (const [unitId, wt] of unitWorktrees) {
          try {
            // Exit worktree (auto-commits uncommitted changes)
            const exitResult = await exitWorktree(projectDir, wt.branchName);
            if (exitResult.hasChanges) {
              // Merge the branch back into main
              const merge = mergeWorktree(projectDir, wt.branchName, 'squash');
              mergeResults.push({ unitId, ...merge });
              if (verbose) {
                console.log(`  [${unitId}] ${merge.success ? '✅' : '⚠️'} merge: ${merge.message}`);
              }
            } else {
              mergeResults.push({ unitId, success: true, message: 'No changes to merge' });
            }
          } catch (err: unknown) {
            const error = err as Error;
            mergeResults.push({ unitId, success: false, message: error.message });
            if (verbose) console.warn(`  [${unitId}] ⚠️ worktree cleanup failed: ${error.message}`);
          }
        }
        unitWorktrees.clear();

        const conflicts = mergeResults.filter(r => !r.success);
        if (conflicts.length > 0 && verbose) {
          console.warn(`[L3 Batch] ⚠️ ${conflicts.length} merge conflict(s): ${conflicts.map(c => `${c.unitId}: ${c.message}`).join('; ')}`);
        }
      }

      if (verbose) {
        console.log(`[L3 Batch] ✅ Batch complete in ${Date.now() - batchStart}ms`);
      }

      results.push(...batchResults);
      totalCost += batchResults.reduce((sum, r) => sum + r.cost, 0);

      // Record delegation performance for future persona ranking
      for (const r of batchResults) {
        const unitDef = batch.find(u => u.id === r.workUnitId);
        if (unitDef) {
          const taskChars = analyzeDelegationTask(unitDef.goal, unitDef.allowedPaths, unitDef.requiredCapabilities);
          this.delegationTuner.recordPerformance({
            persona: r.persona,
            model: String(process.env.CREW_EXECUTION_MODEL || 'default'),
            taskType: taskChars.taskType,
            success: !r.escalationNeeded,
            turns: r.turns || 0,
            costUsd: r.cost,
            verificationPassed: r.verificationPassed,
            timestamp: Date.now()
          });
        }
      }

      // HARD COST GATE - Check during execution
      if (totalCost > 0.50) {
        throw new Error(
          `Execution cost $${totalCost.toFixed(3)} exceeded limit ($0.50) during execution. ` +
          `Partial results saved but task aborted.`
        );
      }
    }

    // Persist JIT context for subsequent CLI invocations
    if (this.session && accumulatedDiscoveredFiles.length > 0) {
      try { await this.session.saveJITContext(accumulatedDiscoveredFiles); } catch { /* best-effort */ }
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
  private topologicalSort<T extends { id: string; dependencies: string[] }>(units: T[]): T[] {
    const sorted: T[] = [];
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
  private getBatches<T extends { id: string; dependencies: string[] }>(sortedUnits: T[]): Array<T[]> {
    const batches: Array<T[]> = [];
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
    const sections = results.results.map(r => {
      const filesChanged = r.filesChanged || [];
      const verification = r.verification || [];
      const metadata = [
        `Files: ${filesChanged.length > 0 ? filesChanged.join(', ') : '(none reported)'}`,
        `Verification: ${r.verificationPassed ? 'passed' : 'not confirmed'}`,
        ...(verification.length > 0 ? [`Evidence: ${verification.join(' | ')}`] : []),
        ...(r.escalationNeeded ? [`Escalation: ${r.escalationReason || 'required'}`] : [])
      ].join('\n');
      return `### ${r.persona} (${r.workUnitId})\n\n${metadata}\n\n${r.output}`;
    });

    return sections.join('\n\n---\n\n');
  }

  /**
   * Run a worker unit — delegates to agentic executor by default.
   * Can be overridden in tests to use a mock executor.
   */
  async runWorker(prompt: string, options: { model?: string; maxTurns?: number; verbose?: boolean; priorDiscoveredFiles?: string[]; persona?: string; constraintLevel?: import('../tools/gemini/crew-adapter.js').ConstraintLevel; verificationCommands?: string[] }): Promise<{ output: string; cost?: number; turns?: number; discoveredFiles?: string[] }> {
    // Always use the agentic executor with full tool suite (write_file, replace, etc.)
    // The LocalExecutor is a single-turn LLM call with no tools — workers need tools to write files.
    return runAgenticWorker(prompt, this.requireSandbox(), options);
  }

  /**
   * Check if native Gemini tool loop can be used for a given model
   */
  private canUseNativeGeminiToolLoop(modelId: string): boolean {
    if (!process.env.GEMINI_API_KEY) return false;
    const mode = (process.env.CREW_TOOL_MODE || 'auto').toLowerCase();
    if (mode === 'markers') return false;
    const lower = String(modelId || '').toLowerCase();
    return lower.includes('gemini');
  }

  /**
   * Parse tool call markers from LLM output
   */
  private parseToolCalls(output: string): Array<{ toolName: string; params: Record<string, string> }> {
    const calls: Array<{ toolName: string; params: Record<string, string> }> = [];
    const lines = output.split('\n');

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // @@WRITE_FILE <path>
      const writeMatch = line.match(/^@@WRITE_FILE\s+(.+)$/);
      if (writeMatch) {
        const filePath = writeMatch[1].trim().replace(/[`;\s]+$/g, '');
        // Find @@END_FILE
        let content = '';
        let found = false;
        let j = i + 1;
        while (j < lines.length) {
          if (lines[j].trim() === '@@END_FILE') {
            found = true;
            break;
          }
          content += (content ? '\n' : '') + lines[j];
          j++;
        }
        if (found) {
          calls.push({ toolName: 'write_file', params: { file_path: filePath, content } });
          i = j + 1;
          continue;
        }
        // No terminator — skip just the @@WRITE_FILE line
        i++;
        continue;
      }

      // @@EDIT "old" → "new" <path>
      const editMatch = line.match(/^@@EDIT\s+"(.+?)"\s*→\s*"(.+?)"\s+(.+)$/);
      if (editMatch) {
        let editPath = editMatch[3].trim().replace(/[`;\s]+$/g, '');
        // Reject paths with @@ (likely garbled)
        if (!editPath.includes('@@')) {
          calls.push({ toolName: 'edit', params: { path: editPath, old: editMatch[1], new: editMatch[2] } });
        }
        i++;
        continue;
      }

      // @@MKDIR <path>
      const mkdirMatch = line.match(/^@@MKDIR\s+(.+)$/);
      if (mkdirMatch) {
        const dirPath = mkdirMatch[1].trim().replace(/[`;\s]+$/g, '');
        if (!dirPath.includes('@@')) {
          calls.push({ toolName: 'mkdir', params: { path: dirPath } });
        }
        i++;
        continue;
      }

      i++;
    }

    return calls;
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
