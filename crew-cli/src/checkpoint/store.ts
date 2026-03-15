import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface CheckpointEvent {
  ts: string;
  type: string;
  data?: Record<string, unknown>;
}

export interface CheckpointRun {
  runId: string;
  mode: 'plan' | 'dispatch' | 'auto' | 'repl';
  task: string;
  createdAt: string;
  updatedAt: string;
  status: 'running' | 'completed' | 'failed';
  events: CheckpointEvent[];
}

export class CheckpointStore {
  private dir: string;

  constructor(baseDir = process.cwd()) {
    this.dir = join(baseDir, '.crew', 'checkpoints');
  }

  private filePath(runId: string) {
    return join(this.dir, `${runId}.json`);
  }

  async beginRun(run: Omit<CheckpointRun, 'createdAt' | 'updatedAt' | 'events' | 'status'>) {
    await mkdir(this.dir, { recursive: true });
    const now = new Date().toISOString();
    const payload: CheckpointRun = {
      ...run,
      createdAt: now,
      updatedAt: now,
      status: 'running',
      events: []
    };
    await writeFile(this.filePath(run.runId), JSON.stringify(payload, null, 2), 'utf8');
    return payload;
  }

  async append(runId: string, type: string, data: Record<string, unknown> = {}) {
    const run = await this.load(runId);
    if (!run) return false;
    run.events.push({
      ts: new Date().toISOString(),
      type,
      data
    });
    run.updatedAt = new Date().toISOString();
    await writeFile(this.filePath(runId), JSON.stringify(run, null, 2), 'utf8');
    return true;
  }

  async finish(runId: string, status: 'completed' | 'failed') {
    const run = await this.load(runId);
    if (!run) return false;
    run.status = status;
    run.updatedAt = new Date().toISOString();
    await writeFile(this.filePath(runId), JSON.stringify(run, null, 2), 'utf8');
    return true;
  }

  async load(runId: string): Promise<CheckpointRun | null> {
    try {
      const raw = await readFile(this.filePath(runId), 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async list(limit = 20): Promise<CheckpointRun[]> {
    if (!existsSync(this.dir)) return [];
    const files = (await readdir(this.dir))
      .filter(f => f.endsWith('.json'))
      .slice(-Math.max(1, limit));
    const runs: CheckpointRun[] = [];
    for (const file of files) {
      try {
        const raw = await readFile(join(this.dir, file), 'utf8');
        runs.push(JSON.parse(raw));
      } catch {
        // skip broken files
      }
    }
    runs.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return runs;
  }

  static completedPlanSteps(run: CheckpointRun): number[] {
    const ids = new Set<number>();
    for (const ev of run.events) {
      if (ev.type === 'plan.step.completed') {
        const stepId = Number((ev.data || {}).stepId || 0);
        if (Number.isFinite(stepId) && stepId > 0) ids.add(stepId);
      }
    }
    return Array.from(ids).sort((a, b) => a - b);
  }
}
