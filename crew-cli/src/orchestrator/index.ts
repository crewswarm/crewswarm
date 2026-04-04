// @ts-nocheck
import { Sandbox } from '../sandbox/index.js';
import { AgentRouter } from '../agent/router.js';
import { Logger } from '../utils/logger.js';
import { getStrategy } from '../strategies/index.js';
import { SessionManager } from '../session/manager.js';
import { readFile } from 'node:fs/promises';
import { LocalExecutor } from '../executor/local.js';
import { getProfileConfig, type RuntimeProfile } from '../executor/profiles.js';
import { UnifiedPipeline } from '../pipeline/unified.js';
import { parseJsonObjectWithRepair } from '../utils/structured-json.js';

export { WorkerPool } from './worker-pool.js';
export type { WorkerTask, TaskResult, WorkerPoolOptions } from './worker-pool.js';

const ROUTING_SYSTEM_PROMPT = `You are the intelligent routing system for crewswarm CLI (always lowercase "crewswarm"), a standalone agentic coding engine.

Route this request to one of: direct-answer, execute-direct, execute-parallel.

- direct-answer: Simple conversation, greetings, status checks, or questions about YOUR identity/capabilities. Provide response in "directResponse".
- execute-direct: Code editing, building, implementing, single-file tasks, questions about files/project state, or any development task.
- execute-parallel: Complex multi-file features, large refactors, or multi-step implementation tasks.

You are running as a standalone CLI assistant. You do NOT dispatch to external agents or a swarm.

Return ONLY a JSON object in this exact format:
{"decision":"direct-answer|execute-direct|execute-parallel","reasoning":"why this path","directResponse":"if direct-answer, your response here","complexity":"low|medium|high","estimatedCost":0.001}`;

export enum RouteDecision {
  CHAT = 'CHAT',
  CODE = 'CODE',
  DISPATCH = 'DISPATCH',
  SKILL = 'SKILL'
}

export interface RouteResult {
  decision: RouteDecision;
  agent?: string;
  task?: string;
  explanation?: string;
  response?: string; // For CHAT decisions, the LLM's conversational response
}

export class Orchestrator {
  private logger = new Logger();
  private localExecutor = new LocalExecutor();
  private pipeline: UnifiedPipeline;

  constructor(
    private router: AgentRouter,
    private sandbox: Sandbox,
    private session: SessionManager,
    private profile: RuntimeProfile = 'builder'
  ) {
    this.pipeline = new UnifiedPipeline(sandbox, session);
  }

  /**
   * Decides which path to take based on user input.
   */
  async route(input: string): Promise<RouteResult> {
    const useUnifiedRouter = this.shouldUseUnifiedRouter();
    if (useUnifiedRouter) {
      try {
        const routed = await this.pipeline.routeOnly({
          userInput: input,
          sessionId: 'crew-cli'
        });
        const result: RouteResult = {
          decision: routed.decision as RouteDecision,
          agent: routed.agent,
          task: routed.task,
          response: routed.response,
          explanation: routed.explanation
        };
        await this.logRoutingDecision(input, result);
        return result;
      } catch (err) {
        // Fall through to deterministic routing if unified planner fails.
        console.warn(`[Orchestrator] routeOnly failed, falling back to legacy router: ${(err as Error).message}`);
      }
    }

    const llmDecision = await this.routeWithLLM(input);
    if (llmDecision) {
      if (llmDecision.decision === RouteDecision.CHAT && this.isExecutionIntent(input)) {
        llmDecision.decision = RouteDecision.CODE;
        llmDecision.agent = llmDecision.agent || 'crew-coder';
        llmDecision.task = llmDecision.task || input;
        llmDecision.explanation = 'Execution intent detected; bypassing chat-only route';
      }
      llmDecision.agent = this.normalizeAgentName(llmDecision.agent);
      // Ensure CODE decisions always have an agent
      if (llmDecision.decision === RouteDecision.CODE && !llmDecision.agent) {
        llmDecision.agent = 'crew-coder';
      }
      await this.logRoutingDecision(input, llmDecision);
      return llmDecision;
    }

    const lower = input.toLowerCase();
    const isStandalone = String(process.env.CREW_INTERFACE_MODE || 'standalone').toLowerCase() !== 'connected';
    let result: RouteResult;

    // Skill calling detection
    if (lower.startsWith('skill:') || lower.includes('run skill')) {
      result = { decision: RouteDecision.SKILL, explanation: 'Detected skill request' };
    }
    // Planning/PM tasks - roadmap, planning, architecture, research
    else if (
      lower.includes('roadmap') ||
      lower.includes('plan for') ||
      lower.includes('planning') ||
      lower.includes('architecture') ||
      lower.includes('design doc') ||
      (lower.includes('build') && (lower.includes('website') || lower.includes('app') || lower.includes('system'))) ||
      (lower.includes('research') && (lower.includes('indepth') || lower.includes('in-depth')))
    ) {
      result = { decision: isStandalone ? RouteDecision.CODE : RouteDecision.DISPATCH, agent: isStandalone ? 'crew-coder' : 'crew-pm', task: input };
    }
    // Specialist dispatch detection
    else if (lower.includes('ask') || lower.includes('tell')) {
      if (isStandalone) {
        result = { decision: RouteDecision.CODE, agent: 'crew-coder', task: input };
      } else if (lower.includes('fixer') || lower.includes('fix')) {
        result = { decision: RouteDecision.DISPATCH, agent: 'crew-fixer', task: input };
      } else if (lower.includes('qa') || lower.includes('test')) {
        result = { decision: RouteDecision.DISPATCH, agent: 'crew-qa', task: input };
      } else if (lower.includes('frontend') || lower.includes('ui')) {
        result = { decision: RouteDecision.DISPATCH, agent: 'crew-frontend', task: input };
      } else if (lower.includes('security') || lower.includes('audit')) {
        result = { decision: RouteDecision.DISPATCH, agent: 'crew-security', task: input };
      } else {
        result = { decision: RouteDecision.DISPATCH, agent: 'crew-main', task: input };
      }
    }
    // Code generation/building detection
    else if (
      lower.includes('create') || 
      lower.includes('implement') || 
      lower.includes('modify') || 
      lower.includes('add') || 
      lower.includes('write') ||
      lower.includes('change') ||
      lower.includes('update') ||
      lower.includes('build') ||
      lower.includes('make')
    ) {
      result = { decision: RouteDecision.CODE, agent: 'crew-coder', task: input };
    }
    // Simple questions about system capabilities
    else if (
      (lower.includes('what') || lower.includes('how') || lower.includes('which')) &&
      (lower.includes('model') || lower.includes('version') || lower.includes('agent'))
    ) {
      result = { 
        decision: RouteDecision.CHAT, 
        response: "I'm crew-cli, a multi-agent orchestration system. I can build code, plan projects, fix bugs, review security, and coordinate specialists. Try asking me to build something or create a roadmap!",
        explanation: 'System info query'
      };
    }
    else if (
      lower === 'hello' ||
      lower === 'hi' ||
      lower === 'hey' ||
      lower.startsWith('hello ') ||
      lower.startsWith('hi ') ||
      lower.startsWith('hey ')
    ) {
      result = {
        decision: RouteDecision.CHAT,
        response: 'Hey. What do you want to build or fix?',
        explanation: 'Greeting'
      };
    }
    else {
      result = { decision: isStandalone ? RouteDecision.CODE : RouteDecision.DISPATCH, agent: isStandalone ? 'crew-coder' : 'crew-main', task: input };
    }

    await this.logRoutingDecision(input, result);
    return result;
  }

  private shouldUseUnifiedRouter(): boolean {
    const explicitLegacy = String(process.env.CREW_LEGACY_ROUTER || '').trim().toLowerCase();
    if (explicitLegacy === '1' || explicitLegacy === 'true' || explicitLegacy === 'yes') {
      return false;
    }
    const explicit = String(process.env.CREW_USE_UNIFIED_ROUTER || '').trim().toLowerCase();
    if (!explicit) return true;
    return !(explicit === '0' || explicit === 'false' || explicit === 'no' || explicit === 'off');
  }

  private isExecutionIntent(input: string): boolean {
    const lower = String(input || '').toLowerCase();
    return /\b(implement|create|build|write|fix|refactor|modify|update|add|patch|test|run tests|make tests pass)\b/.test(lower)
      || /\/src\/|\.ts\b|\.js\b|\.tsx\b|\.py\b/.test(lower);
  }

  private async getGeminiADCToken(): Promise<string | null> {
    try {
      const adcPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || 
                      `${process.env.HOME}/.config/gcloud/application_default_credentials.json`;
      
      const { readFile } = await import('node:fs/promises');
      const credentialsJson = await readFile(adcPath, 'utf8');
      const credentials = JSON.parse(credentialsJson);
      
      if (credentials.type !== 'authorized_user' || !credentials.refresh_token) {
        return null;
      }
      
      // Exchange refresh token for access token
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: credentials.client_id,
          client_secret: credentials.client_secret,
          refresh_token: credentials.refresh_token,
          grant_type: 'refresh_token'
        })
      });
      
      if (!tokenResponse.ok) return null;
      
      const tokenData = await tokenResponse.json() as any;
      return tokenData.access_token || null;
    } catch {
      return null;
    }
  }

  private normalizeAgentName(raw?: string): string | undefined {
    if (!raw) return raw;
    const lower = raw.toLowerCase().replace(/[^a-z]/g, '');
    const aliases: Record<string, string> = {
      fixer: 'crew-fixer', thefixer: 'crew-fixer', crewfixer: 'crew-fixer',
      coder: 'crew-coder', thecoder: 'crew-coder', crewcoder: 'crew-coder',
      qa: 'crew-qa', theqa: 'crew-qa', crewqa: 'crew-qa',
      frontend: 'crew-frontend', thefrontend: 'crew-frontend', crewfrontend: 'crew-frontend',
      main: 'crew-main', crewmain: 'crew-main',
      security: 'crew-security', crewsecurity: 'crew-security',
      pm: 'crew-pm', crewpm: 'crew-pm',
      copywriter: 'crew-copywriter', crewcopywriter: 'crew-copywriter',
    };
    return aliases[lower] || (raw.startsWith('crew-') ? raw : undefined);
  }

  private getJsonRepairModel(): string | undefined {
    const explicit = String(process.env.CREW_JSON_REPAIR_MODEL || '').trim();
    if (explicit) return explicit;
    if (process.env.GROQ_API_KEY) return 'llama-3.3-70b-versatile';
    if (process.env.XAI_API_KEY) return 'grok-4-1-fast-reasoning';
    if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return 'gemini-2.5-flash';
    if (process.env.DEEPSEEK_API_KEY) return 'deepseek-chat';
    return undefined;
  }

  private async parseRouteJson(raw: string, fallbackTask: string): Promise<RouteResult | null> {
    try {
      const parsed = await parseJsonObjectWithRepair(raw, {
        label: 'Route decision',
        schemaHint: '{"decision":"direct-answer|execute-direct|execute-parallel","reasoning":"...","directResponse":"...","complexity":"low|medium|high","estimatedCost":0.001}',
        repair: async (repairPrompt: string) => {
          const res = await this.localExecutor.execute(repairPrompt, {
            model: this.getJsonRepairModel(),
            temperature: 0,
            maxTokens: 500
          });
          return String(res.result || '');
        }
      });
      // Map L2-style decisions to RouteDecision enum
      const rawDecision = String(parsed.decision || '').trim().toLowerCase().replace(/_/g, '-');
      let decision: RouteDecision;
      if (rawDecision === 'direct-answer' || rawDecision === 'chat' || rawDecision === 'answer') {
        decision = RouteDecision.CHAT;
      } else if (rawDecision === 'execute-direct' || rawDecision === 'code' || rawDecision === 'simple' || rawDecision === 'execute') {
        decision = RouteDecision.CODE;
      } else if (rawDecision === 'execute-parallel' || rawDecision === 'dispatch' || rawDecision === 'plan' || rawDecision === 'build') {
        // In standalone mode, parallel execution is handled locally — map to CODE
        decision = RouteDecision.CODE;
      } else if (rawDecision === 'skill') {
        decision = RouteDecision.SKILL;
      } else {
        // Try uppercase match for backward compat
        const upper = rawDecision.toUpperCase();
        if (Object.values(RouteDecision).includes(upper as RouteDecision)) {
          decision = upper as RouteDecision;
        } else {
          return null;
        }
      }
      // Never produce DISPATCH in standalone — remap to CODE
      if (decision === RouteDecision.DISPATCH) {
        decision = RouteDecision.CODE;
      }
      return {
        decision,
        agent: parsed.agent || (decision === RouteDecision.CODE ? 'crew-coder' : undefined),
        task: parsed.task || fallbackTask,
        response: parsed.directResponse || parsed.response || undefined,
        explanation: parsed.reasoning || parsed.explanation || 'LLM-based routing'
      };
    } catch {
      return null;
    }
  }

  private async routeWithLLM(input: string): Promise<RouteResult | null> {
    // Read routing priority from env (default: grok,gemini,deepseek)
    const routingOrder = (process.env.CREW_ROUTING_ORDER || 'grok,gemini,deepseek')
      .toLowerCase()
      .split(',')
      .map(s => s.trim());
    
    for (const provider of routingOrder) {
      let result: RouteResult | null = null;
      
      switch (provider) {
        case 'grok':
        case 'xai':
          result = await this.routeWithGrok(input);
          break;
        case 'gemini':
          const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
          if (geminiKey) {
            result = await this.routeWithGemini(input, geminiKey);
          } else {
            const adcToken = await this.getGeminiADCToken();
            if (adcToken) {
              result = await this.routeWithGemini(input, adcToken);
            }
          }
          break;
        case 'deepseek':
          result = await this.routeWithDeepSeek(input);
          break;
        case 'groq':
          if (process.env.GROQ_ROUTING_ENABLED === 'true') {
            result = await this.routeWithGroq(input);
          }
          break;
      }
      
      if (result) return result;
    }
    
    return null; // Use fallback heuristic routing
  }

  private async routeWithGrok(input: string): Promise<RouteResult | null> {
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
            {
              role: 'system',
              content: ROUTING_SYSTEM_PROMPT
            },
            {
              role: 'user',
              content: input
            }
          ],
          temperature: 0.3
        })
      });

      if (!response.ok) return null;

      const data = await response.json() as any;
      const content = data?.choices?.[0]?.message?.content;
      if (!content) return null;

      const routed = await this.parseRouteJson(content, input);
      if (!routed) return null;
      routed.explanation = routed.explanation || 'Grok routing';
      return routed;
    } catch {
      return null;
    }
  }

  private async routeWithDeepSeek(input: string): Promise<RouteResult | null> {
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
            {
              role: 'system',
              content: ROUTING_SYSTEM_PROMPT
            },
            {
              role: 'user',
              content: input
            }
          ],
          temperature: 0.3
        })
      });

      if (!response.ok) return null;

      const data = await response.json() as any;
      const content = data?.choices?.[0]?.message?.content;
      if (!content) return null;

      const routed = await this.parseRouteJson(content, input);
      if (!routed) return null;
      routed.explanation = routed.explanation || 'DeepSeek routing';
      return routed;
    } catch {
      return null;
    }
  }

  private async routeWithGroq(input: string): Promise<RouteResult | null> {
    const key = process.env.GROQ_API_KEY;
    if (!key) return null;

    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            {
              role: 'system',
              content: ROUTING_SYSTEM_PROMPT
            },
            {
              role: 'user',
              content: input
            }
          ],
          temperature: 0.3
        })
      });

      if (!response.ok) return null;

      const data = await response.json() as any;
      const content = data?.choices?.[0]?.message?.content;
      if (!content) return null;

      const routed = await this.parseRouteJson(content, input);
      if (!routed) return null;
      routed.explanation = routed.explanation || 'LLM-based routing';
      return routed;
    } catch {
      return null;
    }
  }

  private async routeWithGemini(input: string, apiKey: string): Promise<RouteResult | null> {
    try {
      const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(apiKey), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `${ROUTING_SYSTEM_PROMPT}\n\nUser request: ${input}`
            }]
          }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 500
          }
        })
      });

      if (!response.ok) return null;
      const data = await response.json() as any;
      const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!content) return null;

      const routed = await this.parseRouteJson(content, input);
      if (!routed) return null;
      routed.explanation = routed.explanation || 'Routed via Gemini 2.0 Flash (2M context)';
      return routed;
    } catch {
      return null;
    }
  }

  private async logRoutingDecision(input: string, result: RouteResult) {
    await this.session.appendRouting({
      input,
      decision: result.decision,
      agent: result.agent,
      explanation: result.explanation
    });
  }

  /**
   * Tracks cost for a given model and token counts.
   */
  async trackCost(model: string, promptTokens: number, completionTokens: number) {
    // Simple cost estimation (can be expanded with model-specific pricing)
    const costPerMillion = 1.0; // placeholder: $1.00 per 1M tokens
    const usd = ((promptTokens + completionTokens) / 1_000_000) * costPerMillion;
    
    await this.session.trackCost({
      model,
      promptTokens,
      completionTokens,
      usd
    });
  }

  /**
   * Parses output for Aider-style SEARCH/REPLACE blocks.
   */
  /**
   * Execute a task locally without gateway (Tier 2 direct execution)
   */
  async executeLocally(task: string, options: { model?: string; explicitModel?: boolean } = {}): Promise<any> {
    try {
      const result = await this.localExecutor.execute(task, {
        model: options.model,
        explicitModel: Boolean(options.explicitModel),
        temperature: 0.7,
        maxTokens: 4000
      });

      return {
        success: result.success,
        result: result.result,
        model: result.model,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        costUsd: result.costUsd
      };
    } catch (err) {
      return {
        success: false,
        result: `Local execution failed: ${(err as Error).message}`,
        model: 'none',
        error: (err as Error).message
      };
    }
  }

  /**
   * Execute full unified L1->L2->L3 pipeline locally.
   */
  async executePipeline(
    task: string,
    context = '',
    sessionId = 'crew-cli',
    resume?: {
      fromPhase?: 'plan' | 'execute' | 'validate';
      priorPlan?: any;
      priorResponse?: string;
      priorExecutionResults?: any;
    },
    preClassifiedDecision?: 'direct-answer' | 'execute-parallel',
    directResponse?: string
  ): Promise<any> {
    const out = await this.pipeline.execute({
      userInput: task,
      context,
      sessionId,
      preClassifiedDecision,
      directResponse,
      resume
    });
    return {
      ...out,
      success: true,
      result: out.response,
      costUsd: out.totalCost,
      model: 'unified-pipeline'
    };
  }

  /**
   * Get current runtime profile configuration
   */
  getProfile() {
    return getProfileConfig(this.profile);
  }

  /**
   * Set runtime profile
   */
  setProfile(profile: RuntimeProfile) {
    this.profile = profile;
  }

  /**
   * Get execution trace for debugging
   */
  getTrace(traceId: string) {
    return this.pipeline.getTrace(traceId);
  }

  /**
   * Execute a task using the agentic executor with full file tools.
   * This is the primary execution path — single worker with THINK→ACT→OBSERVE loop
   * and 45+ tools (read_file, write_file, replace, bash, grep, etc.).
   * Equivalent to how Claude Code, Codex CLI, and Gemini CLI execute tasks.
   */
  async executeAgentic(
    task: string,
    options: {
      model?: string;
      onToolCall?: (name: string, params: Record<string, any>) => void;
      conversationContext?: string;
      sessionId?: string;
      verbose?: boolean;
      deferApply?: boolean;
    } = {}
  ): Promise<any> {
    try {
      const fullTask = options.conversationContext
        ? `## Recent conversation context\n${options.conversationContext}\n\n## Current task\n${task}`
        : task;

      const result = await this.pipeline.execute({
        userInput: fullTask,
        sessionId: options.sessionId || 'crew-cli',
        context: options.conversationContext,
        deferApply: options.deferApply
      });

      return {
        success: result.phase === 'complete',
        result: result.response,
        response: result.response,
        model: options.model || process.env.CREW_EXECUTION_MODEL || 'gemini-2.5-flash',
        turns: result.executionResults?.results?.length || 0,
        toolsUsed: Array.from(new Set((result.executionResults?.results || []).flatMap(r => r.toolsUsed || []))),
        costUsd: result.totalCost || 0,
        totalCost: result.totalCost || 0,
        plan: result.plan,
        traceId: result.traceId,
        timeline: result.timeline,
        executionPath: result.executionPath
      };
    } catch (err) {
      return {
        success: false,
        result: `Agentic execution failed: ${(err as Error).message}`,
        response: `Agentic execution failed: ${(err as Error).message}`,
        model: options.model || process.env.CREW_EXECUTION_MODEL || 'gemini-2.5-flash',
        error: (err as Error).message
      };
    }
  }

  async parseAndApplyToSandbox(agentOutput: string): Promise<string[]> {
    const lines = agentOutput.split('\n');
    const changedFiles: string[] = [];

    // First parse @@WRITE_FILE/@@MKDIR/write: syntax commands.
    try {
      const { parseDirectFileCommands, parseWriteSyntax, executeDirectCommands } = await import('../cli/file-commands.js');
      const directCommands = [
        ...parseDirectFileCommands(agentOutput),
        ...parseWriteSyntax(agentOutput)
      ];
      if (directCommands.length > 0) {
        const directChanged = await executeDirectCommands(directCommands, this.sandbox, this.logger);
        changedFiles.push(...directChanged);
      }
    } catch (err) {
      this.logger.error(`Direct command parsing failed: ${(err as Error).message}`);
    }
    
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      
      // Support @@WRITE_FILE format (crewswarm tool syntax)
      if (line.startsWith('@@WRITE_FILE')) {
        const filePath = line.replace('@@WRITE_FILE', '').trim();
        let blockContent = '';
        let j = i + 1;
        
        while (j < lines.length && !lines[j].trim().startsWith('@@END_FILE')) {
          blockContent += lines[j] + '\n';
          j++;
        }
        
        if (blockContent.trim().length > 0) {
          await this.sandbox.addChange(filePath, blockContent.trimEnd() + '\n');
          changedFiles.push(filePath);
        }
        
        i = j + 1; // Skip past @@END_FILE
      }
      // Support "FILE: path/to/file" or "File: path/to/file"
      else if (line.toLowerCase().startsWith('file:')) {
        const filePath = line.split(':')[1].trim();
        let blockContent = '';
        let j = i + 1;
        
        while (j < lines.length && !lines[j].trim().toLowerCase().startsWith('file:') && !lines[j].trim().startsWith('@@WRITE_FILE')) {
          blockContent += lines[j] + '\n';
          j++;
        }

        if (blockContent.includes('<<<<<< SEARCH')) {
          try {
            this.logger.info(`Detected edit block for ${filePath}`);
            
            let originalContent = '';
            try {
              originalContent = await readFile(filePath, 'utf8');
            } catch {
              originalContent = '';
            }
            const modifiedContent = this.extractBlocksAndApply(blockContent, originalContent);
            await this.sandbox.addChange(filePath, modifiedContent);
            changedFiles.push(filePath);
          } catch (err) {
            this.logger.error(`Error parsing blocks for ${filePath}: ${(err as Error).message}`);
          }
        } else if (blockContent.trim().length > 0) {
          // Whole-file fallback: if a FILE block does not include edit markers, store as full rewrite.
          await this.sandbox.addChange(filePath, blockContent.trimEnd() + '\n');
          changedFiles.push(filePath);
        }
        
        i = j;
      } else {
        i++;
      }
    }

    return Array.from(new Set(changedFiles));
  }

  private extractBlocksAndApply(blockContent: string, originalContent: string): string {
    // This uses the SearchReplaceStrategy logic
    const strategy = getStrategy('search-replace');
    return strategy.apply(originalContent, blockContent);
  }
}
