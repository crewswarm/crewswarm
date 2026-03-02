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

const ROUTING_SYSTEM_PROMPT = `You are the intelligent routing system for crew-cli, a multi-agent orchestration platform.

Route this request to one of: CHAT, CODE, DISPATCH, SKILL.

- CHAT: Simple conversation, greetings, status checks, or informational questions about the system
- CODE: Code editing, building, implementing, creating, refactoring, or any development task
- DISPATCH: Specific agent request (QA, PM, security, fixer, etc) or complex multi-step tasks
- SKILL: Explicit skill invocation

For CHAT decisions, provide a helpful conversational response in the "response" field.

Return ONLY a JSON object in this exact format:
{"decision":"CHAT|CODE|DISPATCH|SKILL","agent":"crew-xxx if needed","task":"reformulated task","response":"your chat response if CHAT"}`;

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
    this.pipeline = new UnifiedPipeline();
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
      } catch {
        // Fall through to deterministic routing if unified planner fails.
      }
    }

    const llmDecision = await this.routeWithLLM(input);
    if (llmDecision) {
      llmDecision.agent = this.normalizeAgentName(llmDecision.agent);
      // Ensure CODE decisions always have an agent
      if (llmDecision.decision === RouteDecision.CODE && !llmDecision.agent) {
        llmDecision.agent = 'crew-coder';
      }
      await this.logRoutingDecision(input, llmDecision);
      return llmDecision;
    }

    const lower = input.toLowerCase();
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
      result = { decision: RouteDecision.DISPATCH, agent: 'crew-pm', task: input };
    }
    // Specialist dispatch detection
    else if (lower.includes('ask') || lower.includes('tell')) {
      if (lower.includes('fixer') || lower.includes('fix')) {
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
      result = { decision: RouteDecision.DISPATCH, agent: 'crew-main', task: input };
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
        schemaHint: '{"decision":"CHAT|CODE|DISPATCH|SKILL","agent":"crew-coder","task":"...","response":"..."}',
        repair: async (repairPrompt: string) => {
          const res = await this.localExecutor.execute(repairPrompt, {
            model: this.getJsonRepairModel(),
            temperature: 0,
            maxTokens: 500
          });
          return String(res.result || '');
        }
      });
      const decision = String(parsed.decision || '').toUpperCase();
      if (!Object.values(RouteDecision).includes(decision as RouteDecision)) return null;
      return {
        decision: decision as RouteDecision,
        agent: parsed.agent || undefined,
        task: parsed.task || fallbackTask,
        explanation: parsed.explanation || 'LLM-based routing',
        response: parsed.response || undefined
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
          temperature: 0.7
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
  async executeLocally(task: string, options: { model?: string } = {}): Promise<any> {
    try {
      const result = await this.localExecutor.execute(task, {
        model: options.model,
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
    }
  ): Promise<any> {
    const out = await this.pipeline.execute({
      userInput: task,
      context,
      sessionId,
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

  async parseAndApplyToSandbox(agentOutput: string): Promise<string[]> {
    const lines = agentOutput.split('\n');
    const changedFiles: string[] = [];
    
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      
      // Support "FILE: path/to/file" or "File: path/to/file"
      if (line.toLowerCase().startsWith('file:')) {
        const filePath = line.split(':')[1].trim();
        let blockContent = '';
        let j = i + 1;
        
        while (j < lines.length && !lines[j].trim().toLowerCase().startsWith('file:')) {
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

    return changedFiles;
  }

  private extractBlocksAndApply(blockContent: string, originalContent: string): string {
    // This uses the SearchReplaceStrategy logic
    const strategy = getStrategy('search-replace');
    return strategy.apply(originalContent, blockContent);
  }
}
