import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
// Lazy load project messages bridge only when needed (not in standalone mode)
// import { saveCliToProjectMessages } from './project-messages-bridge.mjs';

function nowIso() {
  return new Date().toISOString();
}

interface Session {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  history: Array<{
    timestamp: string;
    input: string;
    output?: string;
    route?: string;
    agent?: string;
  }>;
}

export class SessionManager {
  private baseDir: string;
  private stateDir: string;
  private paths: {
    session: string;
    routing: string;
    jitContext: string;
    cost: string;
    sandbox: string;
  };

  constructor(baseDir = process.cwd()) {
    this.baseDir = baseDir;
    this.stateDir = join(baseDir, '.crew');
    this.paths = {
      session: join(this.stateDir, 'session.json'),
      routing: join(this.stateDir, 'routing.log'),
      cost: join(this.stateDir, 'cost.json'),
      sandbox: join(this.stateDir, 'sandbox.json'),
      jitContext: join(this.stateDir, 'jit-context.json')
    };
  }

  async ensureInitialized() {
    await mkdir(this.stateDir, { recursive: true });

    if (!existsSync(this.paths.session)) {
      const initialSession = {
        sessionId: randomUUID(),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        history: []
      };
      await writeFile(this.paths.session, JSON.stringify(initialSession, null, 2), 'utf8');
    }

    if (!existsSync(this.paths.routing)) {
      await writeFile(this.paths.routing, '', 'utf8');
    }

    if (!existsSync(this.paths.cost)) {
      const initialCost = {
        totalUsd: 0,
        byModel: {},
        entries: [],
        cacheSavings: {
          hits: 0,
          misses: 0,
          tokensSaved: 0,
          usdSaved: 0
        },
        memoryMetrics: {
          recallUsed: 0,
          recallMisses: 0,
          totalMatches: 0,
          averageQualityScore: 0
        }
      };
      await writeFile(this.paths.cost, JSON.stringify(initialCost, null, 2), 'utf8');
    }

    if (!existsSync(this.paths.sandbox)) {
      const initialSandbox = {
        branches: { main: {} },
        activeBranch: 'main',
        updatedAt: nowIso()
      };
      await writeFile(this.paths.sandbox, JSON.stringify(initialSandbox, null, 2), 'utf8');
    }
  }

  async loadSession(): Promise<Session> {
    await this.ensureInitialized();
    const raw = await readFile(this.paths.session, 'utf8');
    return JSON.parse(raw);
  }

  async saveSession(session: Session) {
    await this.ensureInitialized();
    session.updatedAt = nowIso();
    await writeFile(this.paths.session, JSON.stringify(session, null, 2), 'utf8');
  }

  async loadCost() {
    await this.ensureInitialized();
    const raw = await readFile(this.paths.cost, 'utf8');
    const parsed = JSON.parse(raw);
    parsed.cacheSavings = parsed.cacheSavings || {
      hits: 0,
      misses: 0,
      tokensSaved: 0,
      usdSaved: 0
    };
    parsed.memoryMetrics = parsed.memoryMetrics || {
      recallUsed: 0,
      recallMisses: 0,
      totalMatches: 0,
      averageQualityScore: 0
    };
    return parsed;
  }

  async saveCost(cost: any) {
    await this.ensureInitialized();
    await writeFile(this.paths.cost, JSON.stringify(cost, null, 2), 'utf8');
  }

  async getSessionId() {
    const session = await this.loadSession();
    return session.sessionId;
  }

  /** Switch to a different session ID (for /resume) */
  async setSessionId(newId: string) {
    const session = await this.loadSession();
    session.sessionId = newId;
    session.updatedAt = nowIso();
    await this.saveSession(session);
  }

  /** Save JIT discovered files so subsequent CLI invocations inherit context */
  async saveJITContext(discoveredFiles: string[]) {
    await this.ensureInitialized();
    const MAX_FILES = 200;
    const trimmed = discoveredFiles.slice(-MAX_FILES);
    await writeFile(this.paths.jitContext, JSON.stringify({
      updatedAt: nowIso(),
      files: trimmed
    }, null, 2), 'utf8');
  }

  /** Load JIT context from prior session (returns empty array if none) */
  async loadJITContext(): Promise<string[]> {
    try {
      const raw = await readFile(this.paths.jitContext, 'utf8');
      const data = JSON.parse(raw);
      return Array.isArray(data.files) ? data.files : [];
    } catch {
      return [];
    }
  }

  async appendHistory(entry: { input: string; output?: string; route?: string; agent?: string }) {
    const session = await this.loadSession();
    session.history.push({
      ...entry,
      timestamp: nowIso()
    });
    session.updatedAt = nowIso();
    await writeFile(this.paths.session, JSON.stringify(session, null, 2), 'utf8');
    
    // Also save to unified project messages (disabled in standalone mode)
    // try {
    //   await saveCliToProjectMessages(this.baseDir, entry);
    // } catch (e) {
    //   // Silent fail — project messages are bonus, not critical
    // }
  }

  async appendRouting(entry: { timestamp?: string; [key: string]: any }) {
    const payload = {
      ...entry,
      timestamp: entry.timestamp || nowIso()
    };
    await writeFile(this.paths.routing, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', flag: 'a' });
  }

  async trackCost(entry: { usd?: number; model?: string; promptTokens?: number; completionTokens?: number } = {}) {
    const raw = await readFile(this.paths.cost, 'utf8');
    const cost = JSON.parse(raw);
    const amount = Number(entry.usd || 0);
    const model = entry.model || 'unknown';

    cost.totalUsd += amount;
    cost.byModel[model] = (cost.byModel[model] || 0) + amount;
    cost.entries.push({
      model,
      usd: amount,
      promptTokens: entry.promptTokens || 0,
      completionTokens: entry.completionTokens || 0,
      timestamp: nowIso()
    });

    await writeFile(this.paths.cost, JSON.stringify(cost, null, 2), 'utf8');
  }

  async trackCacheSavings(entry: { hit?: boolean; miss?: boolean; tokensSaved?: number; usdSaved?: number } = {}) {
    const raw = await readFile(this.paths.cost, 'utf8');
    const cost = JSON.parse(raw);
    cost.cacheSavings = cost.cacheSavings || {
      hits: 0,
      misses: 0,
      tokensSaved: 0,
      usdSaved: 0
    };

    if (entry.hit) cost.cacheSavings.hits += 1;
    if (entry.miss) cost.cacheSavings.misses += 1;
    cost.cacheSavings.tokensSaved += Number(entry.tokensSaved || 0);
    cost.cacheSavings.usdSaved += Number(entry.usdSaved || 0);

    await writeFile(this.paths.cost, JSON.stringify(cost, null, 2), 'utf8');
  }

  async trackMemoryRecall(entry: { used?: boolean; miss?: boolean; matchCount?: number; qualityScore?: number } = {}) {
    const raw = await readFile(this.paths.cost, 'utf8');
    const cost = JSON.parse(raw);
    cost.memoryMetrics = cost.memoryMetrics || {
      recallUsed: 0,
      recallMisses: 0,
      totalMatches: 0,
      averageQualityScore: 0
    };
    const mm = cost.memoryMetrics;
    if (entry.used) mm.recallUsed += 1;
    if (entry.miss) mm.recallMisses += 1;
    const matchCount = Number(entry.matchCount || 0);
    mm.totalMatches += matchCount;
    const qualityScore = Number(entry.qualityScore || 0);
    if (entry.used) {
      const n = Math.max(1, mm.recallUsed);
      mm.averageQualityScore = ((Number(mm.averageQualityScore || 0) * (n - 1)) + qualityScore) / n;
    }
    await writeFile(this.paths.cost, JSON.stringify(cost, null, 2), 'utf8');
  }

  async clear() {
    await rm(this.stateDir, { recursive: true, force: true });
    await this.ensureInitialized();
  }

  async compact(options: { keepHistory?: number; keepCostEntries?: number } = {}) {
    const keepHistory = Math.max(1, Number(options.keepHistory || 200));
    const keepCostEntries = Math.max(1, Number(options.keepCostEntries || 500));

    const session = await this.loadSession();
    const cost = await this.loadCost();

    const historyBefore = session.history.length;
    const costBefore = (cost.entries || []).length;

    session.history = session.history.slice(-keepHistory);
    cost.entries = (cost.entries || []).slice(-keepCostEntries);
    cost.totalUsd = Number((cost.entries || []).reduce((sum: number, entry: any) => sum + Number(entry.usd || 0), 0));
    cost.byModel = {};
    for (const entry of cost.entries) {
      const model = entry.model || 'unknown';
      cost.byModel[model] = (cost.byModel[model] || 0) + Number(entry.usd || 0);
    }

    await this.saveSession(session);
    await this.saveCost(cost);

    return {
      historyBefore,
      historyAfter: session.history.length,
      costBefore,
      costAfter: cost.entries.length
    };
  }
}
