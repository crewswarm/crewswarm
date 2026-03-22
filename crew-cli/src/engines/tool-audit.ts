import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolAuditRun {
  runId: string;
  ts: string;
  engine: string;
  sessionId?: string;
  prompt: string;
  success: boolean;
  exitCode: number;
  toolCalls: ToolCallRecord[];
  rawOutputPreview: string;
}

function clip(text: string, max = 3000): string {
  const value = String(text || '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n...[truncated]`;
}

export function extractToolCalls(raw: string): ToolCallRecord[] {
  const text = String(raw || '');
  const calls: ToolCallRecord[] = [];

  const add = (name: string, args: Record<string, unknown>) => {
    calls.push({ name: String(name || '').trim(), args: args || {} });
  };

  const writeRe = /@@WRITE_FILE\s+([^\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = writeRe.exec(text)) !== null) add('write_file', { file_path: String(m[1] || '').trim() });

  const readRe = /@@READ_FILE\s+([^\n]+)/g;
  while ((m = readRe.exec(text)) !== null) add('read_file', { file_path: String(m[1] || '').trim() });

  const editRe = /@@EDIT\s+"([^"]+)"\s*→\s*"([^"]+)"\s+([^\n]+)/g;
  while ((m = editRe.exec(text)) !== null) {
    add('edit', {
      old_string: String(m[1] || ''),
      new_string: String(m[2] || ''),
      file_path: String(m[3] || '').trim()
    });
  }

  const mkdirRe = /@@MKDIR\s+([^\n]+)/g;
  while ((m = mkdirRe.exec(text)) !== null) add('mkdir', { path: String(m[1] || '').trim() });

  const cmdRe = /@@RUN_CMD\s+([^\n]+)/g;
  while ((m = cmdRe.exec(text)) !== null) add('run_cmd', { command: String(m[1] || '').trim() });

  const toolJsonRe = /@@TOOL\s+([^\n]+)/g;
  while ((m = toolJsonRe.exec(text)) !== null) {
    const rawArgs = String(m[1] || '').trim();
    if (!rawArgs) continue;
    try {
      if (rawArgs.startsWith('{')) {
        const parsed = JSON.parse(rawArgs);
        const n = String(parsed?.name || parsed?.tool || '').trim();
        const a = parsed?.args || parsed?.params || {};
        if (n) add(n, (a && typeof a === 'object') ? a : {});
      }
    } catch {
      // ignore malformed
    }
  }

  const fenced = text.match(/```json\s*([\s\S]*?)```/gi) || [];
  for (const block of fenced) {
    const payload = block.replace(/^```json/i, '').replace(/```$/i, '').trim();
    try {
      const parsed = JSON.parse(payload);
      const tc = Array.isArray(parsed?.tool_calls) ? parsed.tool_calls : [];
      for (const t of tc) {
        const name = String(t?.function?.name || t?.name || '').trim();
        if (!name) continue;
        const argsRaw = t?.function?.arguments ?? t?.arguments ?? {};
        let args: Record<string, unknown> = {};
        if (typeof argsRaw === 'string') {
          try { args = JSON.parse(argsRaw); } catch { args = {}; }
        } else if (argsRaw && typeof argsRaw === 'object') {
          args = argsRaw as Record<string, unknown>;
        }
        add(name, args);
      }
    } catch {
      // ignore
    }
  }

  return calls.filter(c => c.name.length > 0);
}

export class ToolAuditStore {
  private readonly baseDir: string;
  private readonly dir: string;
  private readonly indexPath: string;

  constructor(baseDir: string = process.cwd()) {
    this.baseDir = resolve(baseDir);
    this.dir = join(this.baseDir, '.crew', 'tool-audit');
    this.indexPath = join(this.baseDir, '.crew', 'tool-audit.jsonl');
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async record(run: ToolAuditRun): Promise<void> {
    await this.ensureDir();
    const runPath = join(this.dir, `${run.runId}.json`);
    await writeFile(runPath, JSON.stringify(run, null, 2), 'utf8');
    await appendFile(this.indexPath, `${JSON.stringify({
      runId: run.runId,
      ts: run.ts,
      engine: run.engine,
      sessionId: run.sessionId || '',
      success: run.success,
      exitCode: run.exitCode,
      toolCount: run.toolCalls.length
    })}\n`, 'utf8');
  }

  async loadRun(runId: string): Promise<ToolAuditRun | null> {
    try {
      const raw = await readFile(join(this.dir, `${runId}.json`), 'utf8');
      return JSON.parse(raw) as ToolAuditRun;
    } catch {
      return null;
    }
  }

  async list(limit = 30): Promise<Array<Record<string, unknown>>> {
    if (!existsSync(this.indexPath)) return [];
    const raw = await readFile(this.indexPath, 'utf8');
    const rows = raw.split('\n').map(l => l.trim()).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean) as Array<Record<string, unknown>>;
    return rows.slice(-Math.max(1, limit)).reverse();
  }
}

export function buildReplayPlan(run: ToolAuditRun): {
  runId: string;
  deterministicOrder: ToolCallRecord[];
  supportedMutations: ToolCallRecord[];
} {
  const supported = new Set(['write_file', 'edit', 'mkdir']);
  const ordered = Array.isArray(run.toolCalls) ? [...run.toolCalls] : [];
  return {
    runId: run.runId,
    deterministicOrder: ordered,
    supportedMutations: ordered.filter(c => supported.has(String(c.name || '').toLowerCase()))
  };
}

export function previewAuditOutput(rawOutput: string): string {
  return clip(rawOutput, 5000);
}
