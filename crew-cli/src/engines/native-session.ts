import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface NativeSessionSummary {
  key: string;
  engine: string;
  sessionId: string;
  cwd: string;
  shell: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  alive: boolean;
}

type RuntimeSession = {
  key: string;
  engine: string;
  sessionId: string;
  cwd: string;
  shell: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  busy: boolean;
  pty: any;
};

type SessionStore = Record<string, Omit<NativeSessionSummary, 'alive'>>;

function nowIso(): string {
  return new Date().toISOString();
}

function shellQuote(value: string): string {
  const text = String(value || '');
  if (text.length === 0) return "''";
  return `'${text.replace(/'/g, `'\"'\"'`)}'`;
}

export class NativeEngineSessionManager {
  private readonly baseDir: string;
  private readonly stateDir: string;
  private readonly statePath: string;
  private readonly runtime = new Map<string, RuntimeSession>();
  private ptySpawn: any | null = null;
  private ptyLoadFailed = false;

  constructor(baseDir: string = process.cwd()) {
    this.baseDir = resolve(baseDir);
    this.stateDir = join(this.baseDir, '.crew');
    this.statePath = join(this.stateDir, 'engine-native-sessions.json');
  }

  private makeKey(engine: string, sessionId: string): string {
    return `${String(engine || '').trim().toLowerCase()}::${String(sessionId || '').trim()}`;
  }

  private async ensureStore(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    if (!existsSync(this.statePath)) {
      await writeFile(this.statePath, JSON.stringify({}, null, 2), 'utf8');
    }
  }

  private async loadStore(): Promise<SessionStore> {
    await this.ensureStore();
    try {
      const raw = await readFile(this.statePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed as SessionStore;
    } catch {
      return {};
    }
  }

  private async saveStore(store: SessionStore): Promise<void> {
    await this.ensureStore();
    await writeFile(this.statePath, JSON.stringify(store, null, 2), 'utf8');
  }

  private async getPtySpawn(): Promise<any | null> {
    if (this.ptySpawn) return this.ptySpawn;
    if (this.ptyLoadFailed) return null;
    try {
      const mod = await import('node-pty');
      this.ptySpawn = mod?.spawn || mod?.default?.spawn || null;
      return this.ptySpawn;
    } catch {
      this.ptyLoadFailed = true;
      return null;
    }
  }

  private async ensureSession(engine: string, sessionId: string, cwd: string, shell?: string): Promise<RuntimeSession | null> {
    const key = this.makeKey(engine, sessionId);
    const existing = this.runtime.get(key);
    if (existing) return existing;

    const spawn = await this.getPtySpawn();
    if (!spawn) return null;

    const chosenShell = shell || process.env.SHELL || '/bin/bash';
    const pty = spawn(chosenShell, ['-l'], {
      name: 'xterm-color',
      cwd,
      cols: process.stdout.columns || 120,
      rows: process.stdout.rows || 30,
      env: process.env
    });

    const session: RuntimeSession = {
      key,
      engine,
      sessionId,
      cwd,
      shell: chosenShell,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      turns: 0,
      busy: false,
      pty
    };
    this.runtime.set(key, session);
    await this.persistSessionMeta(session);
    return session;
  }

  private async persistSessionMeta(session: RuntimeSession): Promise<void> {
    const store = await this.loadStore();
    store[session.key] = {
      key: session.key,
      engine: session.engine,
      sessionId: session.sessionId,
      cwd: session.cwd,
      shell: session.shell,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      turns: session.turns
    };
    await this.saveStore(store);
  }

  async list(): Promise<Record<string, NativeSessionSummary>> {
    const store = await this.loadStore();
    const out: Record<string, NativeSessionSummary> = {};
    for (const [key, value] of Object.entries(store)) {
      out[key] = {
        ...value,
        alive: this.runtime.has(key)
      };
    }
    for (const [key, session] of this.runtime.entries()) {
      if (!out[key]) {
        out[key] = {
          key,
          engine: session.engine,
          sessionId: session.sessionId,
          cwd: session.cwd,
          shell: session.shell,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          turns: session.turns,
          alive: true
        };
      }
    }
    return out;
  }

  async closeAll(): Promise<void> {
    for (const [key, session] of this.runtime.entries()) {
      try {
        session.pty?.kill?.();
      } catch {
        // ignore
      }
      this.runtime.delete(key);
    }
  }

  async runInSession(params: {
    engine: string;
    sessionId: string;
    cwd: string;
    shell?: string;
    command: string;
    timeoutMs?: number;
    onChunk?: (chunk: string) => void;
  }): Promise<{ success: boolean; exitCode: number; stdout: string; stderr: string; mode: 'native-shell' | 'fallback' }> {
    const session = await this.ensureSession(params.engine, params.sessionId, params.cwd, params.shell);
    if (!session) {
      return {
        success: false,
        exitCode: -1,
        stdout: '',
        stderr: 'native-session unavailable (node-pty missing)',
        mode: 'fallback'
      };
    }
    if (session.busy) {
      return {
        success: false,
        exitCode: -1,
        stdout: '',
        stderr: `session ${session.key} is busy`,
        mode: 'native-shell'
      };
    }
    session.busy = true;
    session.updatedAt = nowIso();
    session.turns += 1;
    await this.persistSessionMeta(session);

    const sentinel = `__CREW_DONE_${randomUUID().replace(/-/g, '')}__`;
    const markerCmd = `${params.command}\necho ${shellQuote(`${sentinel}$?`) }\n`;
    const timeoutMs = Number(params.timeoutMs || 600000);

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        session.busy = false;
        resolve({
          success: false,
          exitCode: -1,
          stdout,
          stderr: `${stderr}\nTimed out after ${timeoutMs}ms`,
          mode: 'native-shell'
        });
      }, timeoutMs);

      const onData = (data: string) => {
        const chunk = String(data || '');
        const idx = chunk.indexOf(sentinel);
        if (idx >= 0) {
          const before = chunk.slice(0, idx);
          if (before) {
            stdout += before;
            params.onChunk?.(before);
          }
          const codeMatch = chunk.slice(idx + sentinel.length).match(/^(\d+)/);
          const exitCode = codeMatch ? Number(codeMatch[1]) : 0;
          if (!done) {
            done = true;
            clearTimeout(timer);
            session.busy = false;
            session.updatedAt = nowIso();
            void this.persistSessionMeta(session);
            session.pty.off?.('data', onData);
            resolve({
              success: exitCode === 0,
              exitCode,
              stdout: stdout.trim(),
              stderr: stderr.trim(),
              mode: 'native-shell'
            });
          }
          return;
        }
        stdout += chunk;
        params.onChunk?.(chunk);
      };

      session.pty.onData(onData);
      try {
        session.pty.write(markerCmd);
      } catch (err) {
        if (!done) {
          done = true;
          clearTimeout(timer);
          session.busy = false;
          session.pty.off?.('data', onData);
          resolve({
            success: false,
            exitCode: -1,
            stdout,
            stderr: String((err as Error)?.message || err),
            mode: 'native-shell'
          });
        }
      }
    });
  }
}

export function buildEngineShellCommand(engine: string, prompt: string, model?: string): string {
  const p = shellQuote(prompt);
  const m = model ? ` -m ${shellQuote(model)}` : '';
  const e = String(engine || '').trim().toLowerCase();
  if (e === 'codex-cli') return `printf %s ${p} | codex exec -s workspace-write --json`;
  if (e === 'claude-cli') return `printf %s ${p} | claude -p --setting-sources user${String(process.env.CREW_CLAUDE_SKIP_PERMISSIONS || '') === 'true' ? ' --dangerously-skip-permissions' : ''}`;
  if (e === 'cursor-cli' || e === 'cursor') return `printf %s ${p} | cursor --execute${m}`;
  if (e === 'gemini-cli') return `gemini -p ${p}${model ? ` -m ${shellQuote(model)}` : ''}`;
  if (e === 'opencode-cli' || e === 'opencode') return `opencode run${m} ${p}`;
  return '';
}
