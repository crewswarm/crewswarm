import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

function nowIso() {
  return new Date().toISOString();
}

export class SessionManager {
  constructor(baseDir = process.cwd()) {
    this.baseDir = baseDir;
    this.stateDir = join(baseDir, '.crew');
    this.paths = {
      session: join(this.stateDir, 'session.json'),
      routing: join(this.stateDir, 'routing.log'),
      cost: join(this.stateDir, 'cost.json'),
      sandbox: join(this.stateDir, 'sandbox.json')
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
        entries: []
      };
      await writeFile(this.paths.cost, JSON.stringify(initialCost, null, 2), 'utf8');
    }

    if (!existsSync(this.paths.sandbox)) {
      const initialSandbox = {
        branches: { main: [] },
        activeBranch: 'main',
        updatedAt: nowIso()
      };
      await writeFile(this.paths.sandbox, JSON.stringify(initialSandbox, null, 2), 'utf8');
    }
  }

  async loadSession() {
    await this.ensureInitialized();
    const raw = await readFile(this.paths.session, 'utf8');
    return JSON.parse(raw);
  }

  async saveSession(session) {
    await this.ensureInitialized();
    session.updatedAt = nowIso();
    await writeFile(this.paths.session, JSON.stringify(session, null, 2), 'utf8');
  }

  async loadCost() {
    await this.ensureInitialized();
    const raw = await readFile(this.paths.cost, 'utf8');
    return JSON.parse(raw);
  }

  async saveCost(cost) {
    await this.ensureInitialized();
    await writeFile(this.paths.cost, JSON.stringify(cost, null, 2), 'utf8');
  }

  async getSessionId() {
    const session = await this.loadSession();
    return session.sessionId;
  }

  async appendHistory(entry) {
    const session = await this.loadSession();
    session.history.push({
      ...entry,
      timestamp: nowIso()
    });
    session.updatedAt = nowIso();
    await writeFile(this.paths.session, JSON.stringify(session, null, 2), 'utf8');
  }

  async appendRouting(entry) {
    const payload = {
      ...entry,
      timestamp: entry.timestamp || nowIso()
    };
    await writeFile(this.paths.routing, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', flag: 'a' });
  }

  async trackCost(entry = {}) {
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
