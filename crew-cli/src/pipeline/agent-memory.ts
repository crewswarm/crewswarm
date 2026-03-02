/**
 * AgentMemory - Cognitive persistence layer for cross-model memory continuity
 * Inspired by AgentKeeper (https://github.com/Thinklanceai/agentkeeper)
 * 
 * Extends ContextPackManager with:
 * - Critical fact prioritization
 * - Cross-provider memory persistence
 * - Token budget management
 * - Provider-agnostic context injection
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface MemoryFact {
  id: string;
  content: string;
  critical: boolean;
  timestamp: string;
  tags: string[];
  provider?: string;
}

export interface AgentMemoryState {
  agentId: string;
  facts: MemoryFact[];
  createdAt: string;
  updatedAt: string;
}

export class AgentMemory {
  private state: AgentMemoryState;
  private storageDir: string;

  constructor(agentId: string, options?: { storageDir?: string }) {
    // Use CREW_MEMORY_DIR for shared cross-system memory, or local dir for CLI-only
    const baseDir = options?.storageDir || 
      process.env.CREW_MEMORY_DIR || 
      process.cwd();
    this.storageDir = resolve(baseDir, '.crew', 'agent-memory');
    this.ensureStorageDir();
    this.state = this.loadOrCreate(agentId);
  }

  /**
   * Store a fact in agent memory
   */
  remember(content: string, options: {
    critical?: boolean;
    tags?: string[];
    provider?: string;
  } = {}): string {
    const fact: MemoryFact = {
      id: randomUUID(),
      content,
      critical: options.critical || false,
      timestamp: new Date().toISOString(),
      tags: options.tags || [],
      provider: options.provider
    };

    this.state.facts.push(fact);
    this.state.updatedAt = new Date().toISOString();
    this.persist();
    return fact.id;
  }

  /**
   * Remove a fact by ID
   */
  forget(factId: string): boolean {
    const before = this.state.facts.length;
    this.state.facts = this.state.facts.filter(f => f.id !== factId);
    if (this.state.facts.length < before) {
      this.state.updatedAt = new Date().toISOString();
      this.persist();
      return true;
    }
    return false;
  }

  /**
   * Recall facts optimized for current context
   * Priority: critical facts first, then most recent
   */
  recall(options: {
    tokenBudget?: number;
    criticalOnly?: boolean;
    tags?: string[];
    provider?: string;
  } = {}): string {
    const budget = options.tokenBudget || 2000;
    const estimatedCharsPerToken = 4; // Conservative estimate
    const charBudget = budget * estimatedCharsPerToken;

    // Filter facts
    let facts = this.state.facts;
    
    if (options.criticalOnly) {
      facts = facts.filter(f => f.critical);
    }
    
    if (options.tags && options.tags.length > 0) {
      facts = facts.filter(f => 
        options.tags!.some(tag => f.tags.includes(tag))
      );
    }

    if (options.provider) {
      facts = facts.filter(f => !f.provider || f.provider === options.provider);
    }

    // Sort: critical first, then newest
    facts.sort((a, b) => {
      if (a.critical && !b.critical) return -1;
      if (!a.critical && b.critical) return 1;
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });

    // Pack into budget
    const selected: MemoryFact[] = [];
    let used = 0;

    for (const fact of facts) {
      const block = `[${fact.critical ? 'CRITICAL' : 'INFO'}] ${fact.content}\n`;
      if (used + block.length > charBudget) break;
      selected.push(fact);
      used += block.length;
    }

    if (selected.length === 0) return '';

    // Format for injection
    const header = '=== AGENT MEMORY (Context from previous decisions) ===\n';
    const body = selected.map(f => 
      `[${f.critical ? 'CRITICAL' : 'INFO'}] ${f.content}`
    ).join('\n');
    const footer = '\n=== END AGENT MEMORY ===\n';

    return header + body + footer;
  }

  /**
   * Search facts by lexical similarity for brokered retrieval.
   */
  search(query: string, options: {
    maxResults?: number;
    tags?: string[];
    provider?: string;
  } = {}): MemoryFact[] {
    const maxResults = Math.max(1, Number(options.maxResults || 5));
    const qTokens = new Set(
      String(query || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s_-]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 2)
    );

    let facts = this.state.facts.slice();
    if (options.tags && options.tags.length > 0) {
      facts = facts.filter(f => options.tags!.some(tag => f.tags.includes(tag)));
    }
    if (options.provider) {
      facts = facts.filter(f => !f.provider || f.provider === options.provider);
    }

    const score = (fact: MemoryFact): number => {
      const toks = new Set(
        String(fact.content || '')
          .toLowerCase()
          .replace(/[^a-z0-9\s_-]/g, ' ')
          .split(/\s+/)
          .filter(t => t.length > 2)
      );
      if (qTokens.size === 0 || toks.size === 0) return 0;
      let inter = 0;
      for (const t of qTokens) {
        if (toks.has(t)) inter += 1;
      }
      const sim = inter / Math.max(qTokens.size, toks.size);
      return sim + (fact.critical ? 0.1 : 0);
    };

    const ranked = facts
      .map(f => ({ fact: f, score: score(f) }))
      .filter(x => x.score > 0.12)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map(x => x.fact);

    return ranked;
  }

  /**
   * Get memory statistics
   */
  stats(): {
    totalFacts: number;
    criticalFacts: number;
    providers: string[];
    oldestFact: string | null;
    newestFact: string | null;
  } {
    const facts = this.state.facts;
    const timestamps = facts.map(f => f.timestamp).sort();
    const providers = Array.from(new Set(
      facts.map(f => f.provider).filter(Boolean) as string[]
    ));

    return {
      totalFacts: facts.length,
      criticalFacts: facts.filter(f => f.critical).length,
      providers,
      oldestFact: timestamps[0] || null,
      newestFact: timestamps[timestamps.length - 1] || null
    };
  }

  /**
   * Clear all facts (useful for testing)
   */
  clear(): void {
    this.state.facts = [];
    this.state.updatedAt = new Date().toISOString();
    this.persist();
  }

  private loadOrCreate(agentId: string): AgentMemoryState {
    const path = this.getStatePath(agentId);
    
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, 'utf8');
        return JSON.parse(raw);
      } catch (err) {
        console.warn(`[AgentMemory] Failed to load state for ${agentId}, creating new`);
      }
    }

    const now = new Date().toISOString();
    return {
      agentId,
      facts: [],
      createdAt: now,
      updatedAt: now
    };
  }

  private persist(): void {
    const path = this.getStatePath(this.state.agentId);
    writeFileSync(path, JSON.stringify(this.state, null, 2), 'utf8');
  }

  private getStatePath(agentId: string): string {
    return join(this.storageDir, `${agentId}.json`);
  }

  private ensureStorageDir(): void {
    if (!existsSync(this.storageDir)) {
      mkdirSync(this.storageDir, { recursive: true });
    }
  }
}

/**
 * Global memory instance for pipeline-wide memory
 */
let _pipelineMemory: AgentMemory | null = null;

export function getPipelineMemory(agentId: string = 'pipeline'): AgentMemory {
  if (!_pipelineMemory) {
    _pipelineMemory = new AgentMemory(agentId);
  }
  return _pipelineMemory;
}

/**
 * Get or create a crew-wide memory instance (shared across CLI and gateway)
 */
export function getCrewMemory(crewId: string = 'crew-lead'): AgentMemory {
  // Always create fresh instance to ensure latest state from shared storage
  return new AgentMemory(crewId);
}
