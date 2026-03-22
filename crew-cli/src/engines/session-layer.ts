import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface EngineSessionTurn {
  ts: string;
  prompt: string;
  response: string;
  success: boolean;
  exitCode: number;
  model?: string;
  durationMs?: number;
}

export interface EngineSessionRecord {
  key: string;
  engine: string;
  sessionId: string;
  projectDir: string;
  createdAt: string;
  updatedAt: string;
  turns: EngineSessionTurn[];
  totalTurns: number;
  lastSuccess: boolean;
  lastExitCode: number;
  lastModel?: string;
}

export interface EngineSessionSummary {
  key: string;
  engine: string;
  sessionId: string;
  projectDir: string;
  createdAt: string;
  updatedAt: string;
  totalTurns: number;
  lastSuccess: boolean;
  lastExitCode: number;
  lastModel?: string;
}

type SessionStore = Record<string, EngineSessionRecord>;

function nowIso(): string {
  return new Date().toISOString();
}

function clip(text: string, maxChars: number): string {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

export class EngineSessionLayer {
  private readonly baseDir: string;
  private readonly stateDir: string;
  private readonly sessionsPath: string;

  constructor(baseDir: string = process.cwd()) {
    this.baseDir = resolve(baseDir);
    this.stateDir = join(this.baseDir, '.crew');
    this.sessionsPath = join(this.stateDir, 'engine-sessions.json');
  }

  makeKey(engine: string, sessionId: string): string {
    return `${String(engine || '').trim().toLowerCase()}::${String(sessionId || '').trim()}`;
  }

  async ensureInitialized(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    if (!existsSync(this.sessionsPath)) {
      await writeFile(this.sessionsPath, JSON.stringify({}, null, 2), 'utf8');
    }
  }

  private async loadStore(): Promise<SessionStore> {
    await this.ensureInitialized();
    try {
      const raw = await readFile(this.sessionsPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed as SessionStore;
    } catch {
      return {};
    }
  }

  private async saveStore(store: SessionStore): Promise<void> {
    await this.ensureInitialized();
    await writeFile(this.sessionsPath, JSON.stringify(store, null, 2), 'utf8');
  }

  async appendTurn(params: {
    engine: string;
    sessionId: string;
    prompt: string;
    response: string;
    success: boolean;
    exitCode: number;
    model?: string;
    durationMs?: number;
    keepTurns?: number;
  }): Promise<EngineSessionRecord> {
    const engine = String(params.engine || '').trim().toLowerCase();
    const sessionId = String(params.sessionId || '').trim();
    if (!engine || !sessionId) {
      throw new Error('appendTurn requires engine and sessionId');
    }

    const keepTurns = Math.max(1, Number(params.keepTurns || 20));
    const store = await this.loadStore();
    const key = this.makeKey(engine, sessionId);
    const existing = store[key];
    const record: EngineSessionRecord = existing || {
      key,
      engine,
      sessionId,
      projectDir: this.baseDir,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      turns: [],
      totalTurns: 0,
      lastSuccess: true,
      lastExitCode: 0,
      lastModel: ''
    };

    record.turns.push({
      ts: nowIso(),
      prompt: clip(params.prompt, 4000),
      response: clip(params.response, 12000),
      success: Boolean(params.success),
      exitCode: Number(params.exitCode ?? 0),
      model: params.model,
      durationMs: Number(params.durationMs || 0)
    });
    record.turns = record.turns.slice(-keepTurns);
    record.totalTurns = Number(record.totalTurns || 0) + 1;
    record.lastSuccess = Boolean(params.success);
    record.lastExitCode = Number(params.exitCode ?? 0);
    record.lastModel = params.model || record.lastModel;
    record.updatedAt = nowIso();

    store[key] = record;
    await this.saveStore(store);
    return record;
  }

  async getRecord(engine: string, sessionId: string): Promise<EngineSessionRecord | null> {
    const key = this.makeKey(engine, sessionId);
    const store = await this.loadStore();
    return store[key] || null;
  }

  async getRecentTurns(engine: string, sessionId: string, maxTurns = 6): Promise<EngineSessionTurn[]> {
    const rec = await this.getRecord(engine, sessionId);
    if (!rec) return [];
    const n = Math.max(1, Number(maxTurns || 6));
    return rec.turns.slice(-n);
  }

  async listSummaries(): Promise<Record<string, EngineSessionSummary>> {
    const store = await this.loadStore();
    const out: Record<string, EngineSessionSummary> = {};
    for (const [key, rec] of Object.entries(store)) {
      out[key] = {
        key,
        engine: rec.engine,
        sessionId: rec.sessionId,
        projectDir: rec.projectDir,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        totalTurns: Number(rec.totalTurns || rec.turns?.length || 0),
        lastSuccess: Boolean(rec.lastSuccess),
        lastExitCode: Number(rec.lastExitCode || 0),
        lastModel: rec.lastModel
      };
    }
    return out;
  }

  async clear(): Promise<void> {
    await this.saveStore({});
  }
}

export function buildSessionPromptEnvelope(params: {
  systemPrompt?: string;
  history: EngineSessionTurn[];
  prompt: string;
}): string {
  const chunks: string[] = [];
  const systemPrompt = String(params.systemPrompt || '').trim();
  if (systemPrompt) {
    chunks.push('SYSTEM PERSONA (persist across session):');
    chunks.push(systemPrompt);
  }
  const history = Array.isArray(params.history) ? params.history : [];
  if (history.length > 0) {
    chunks.push('SESSION HISTORY (most recent turns):');
    for (const turn of history) {
      chunks.push(`[USER @ ${turn.ts}]`);
      chunks.push(clip(String(turn.prompt || ''), 1200));
      chunks.push(`[ASSISTANT @ ${turn.ts}]`);
      chunks.push(clip(String(turn.response || ''), 2000));
    }
    chunks.push('Continue consistently with the session history.');
  }
  chunks.push('CURRENT USER MESSAGE:');
  chunks.push(String(params.prompt || ''));
  return chunks.join('\n\n');
}
