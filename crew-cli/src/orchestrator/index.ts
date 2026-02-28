import { Sandbox } from '../sandbox/index.js';
import { AgentRouter } from '../agent/router.js';
import { Logger } from '../utils/logger.js';
import { getStrategy } from '../strategies/index.js';
import { SessionManager } from '../session/manager.js';
import { readFile } from 'node:fs/promises';

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
}

export class Orchestrator {
  private logger = new Logger();

  constructor(
    private router: AgentRouter,
    private sandbox: Sandbox,
    private session: SessionManager
  ) {}

  /**
   * Decides which path to take based on user input.
   */
  async route(input: string): Promise<RouteResult> {
    const groqDecision = await this.routeWithGroq(input);
    if (groqDecision) {
      await this.logRoutingDecision(input, groqDecision);
      return groqDecision;
    }

    const lower = input.toLowerCase();
    let result: RouteResult;

    // Skill calling detection
    if (lower.startsWith('skill:') || lower.includes('run skill')) {
      result = { decision: RouteDecision.SKILL, explanation: 'Detected skill request' };
    }
    // specialist dispatch detection
    else if (lower.includes('ask') || lower.includes('tell')) {
      if (lower.includes('fixer') || lower.includes('fix')) {
        result = { decision: RouteDecision.DISPATCH, agent: 'crew-fixer', task: input };
      } else if (lower.includes('qa') || lower.includes('test')) {
        result = { decision: RouteDecision.DISPATCH, agent: 'crew-qa', task: input };
      } else if (lower.includes('frontend') || lower.includes('ui')) {
        result = { decision: RouteDecision.DISPATCH, agent: 'crew-frontend', task: input };
      } else {
        result = { decision: RouteDecision.CHAT, explanation: 'Defaulting to chat (unknown specialist)' };
      }
    }
    // Code generation detection
    else if (
      lower.includes('create') || 
      lower.includes('implement') || 
      lower.includes('modify') || 
      lower.includes('add') || 
      lower.includes('write') ||
      lower.includes('change') ||
      lower.includes('update')
    ) {
      result = { decision: RouteDecision.CODE, agent: 'crew-coder', task: input };
    } else {
      result = { decision: RouteDecision.CHAT, explanation: 'Defaulting to chat' };
    }

    await this.logRoutingDecision(input, result);
    return result;
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
              content: 'Route to one of CHAT, CODE, DISPATCH, SKILL. Return compact JSON: {"decision":"...","agent":"...","task":"...","explanation":"..."}'
            },
            {
              role: 'user',
              content: input
            }
          ],
          temperature: 0
        })
      });

      if (!response.ok) return null;
      const data = await response.json() as any;
      const content = data?.choices?.[0]?.message?.content;
      if (!content) return null;

      const jsonStart = content.indexOf('{');
      const jsonEnd = content.lastIndexOf('}');
      if (jsonStart < 0 || jsonEnd < 0) return null;

      const parsed = JSON.parse(content.slice(jsonStart, jsonEnd + 1));
      const decision = String(parsed.decision || '').toUpperCase();

      if (!Object.values(RouteDecision).includes(decision as RouteDecision)) {
        return null;
      }

      return {
        decision: decision as RouteDecision,
        agent: parsed.agent || undefined,
        task: parsed.task || input,
        explanation: parsed.explanation || 'Groq-based routing'
      };
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
