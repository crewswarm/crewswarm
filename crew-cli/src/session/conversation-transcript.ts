import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface ConversationTurn {
  ts: string;
  role: 'user' | 'assistant';
  text: string;
  engine?: string;
}

interface ConversationRecord {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  turns: ConversationTurn[];
}

type ConversationStore = Record<string, ConversationRecord>;

function nowIso(): string {
  return new Date().toISOString();
}

function clip(text: string, maxChars: number): string {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

export class ConversationTranscriptStore {
  private readonly stateDir: string;
  private readonly filePath: string;

  constructor(baseDir: string = process.cwd()) {
    const root = resolve(baseDir);
    this.stateDir = join(root, '.crew');
    this.filePath = join(this.stateDir, 'conversation-transcript.json');
  }

  async ensureInitialized(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    if (!existsSync(this.filePath)) {
      await writeFile(this.filePath, JSON.stringify({}, null, 2), 'utf8');
    }
  }

  private async loadStore(): Promise<ConversationStore> {
    await this.ensureInitialized();
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed as ConversationStore;
    } catch {
      return {};
    }
  }

  private async saveStore(store: ConversationStore): Promise<void> {
    await this.ensureInitialized();
    await writeFile(this.filePath, JSON.stringify(store, null, 2), 'utf8');
  }

  async appendTurn(params: {
    sessionId: string;
    role: 'user' | 'assistant';
    text: string;
    engine?: string;
    keepTurns?: number;
  }): Promise<void> {
    const sessionId = String(params.sessionId || '').trim();
    if (!sessionId) return;

    const keepTurns = Math.max(2, Number(params.keepTurns || 40));
    const store = await this.loadStore();
    const rec = store[sessionId] || {
      sessionId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      turns: []
    };

    rec.turns.push({
      ts: nowIso(),
      role: params.role,
      text: clip(params.text, 8000),
      engine: params.engine
    });
    rec.turns = rec.turns.slice(-keepTurns);
    rec.updatedAt = nowIso();
    store[sessionId] = rec;
    await this.saveStore(store);
  }

  async getRecentTurns(sessionId: string, maxTurns = 8): Promise<ConversationTurn[]> {
    const key = String(sessionId || '').trim();
    if (!key) return [];
    const store = await this.loadStore();
    const rec = store[key];
    if (!rec) return [];
    return rec.turns.slice(-Math.max(1, Number(maxTurns || 8)));
  }
}

export function buildConversationHydrationPrompt(params: {
  turns: ConversationTurn[];
  currentPrompt: string;
}): string {
  const turns = Array.isArray(params.turns) ? params.turns : [];
  if (turns.length === 0) return String(params.currentPrompt || '');

  const lines: string[] = [];
  lines.push('SHARED SESSION CONTEXT (engine-agnostic):');
  for (const t of turns) {
    const role = t.role === 'assistant' ? 'ASSISTANT' : 'USER';
    lines.push(`[${role} @ ${t.ts}${t.engine ? ` via ${t.engine}` : ''}]`);
    lines.push(clip(String(t.text || ''), 1600));
  }
  lines.push('Continue from this shared conversation state.');
  lines.push('CURRENT USER MESSAGE:');
  lines.push(String(params.currentPrompt || ''));
  return lines.join('\n\n');
}
