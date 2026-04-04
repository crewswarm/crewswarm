import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type AutoFixJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
export type AutoFixApplyPolicy = 'never' | 'safe' | 'force';

export interface AutoFixJobConfig {
  maxIterations: number;
  model?: string;
  fallbackModels: string[];
  gateway?: string;
  validateCommands: string[];
  autoApplyPolicy: AutoFixApplyPolicy;
  blastRadiusThreshold: 'low' | 'medium' | 'high';
  lspAutoFix: boolean;
  lspAutoFixMaxAttempts: number;
}

export interface AutoFixJob {
  id: string;
  task: string;
  projectDir: string;
  status: AutoFixJobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  workerId?: string;
  error?: string;
  config: AutoFixJobConfig;
  result?: Record<string, unknown>;
}

interface AutoFixState {
  version: 1;
  jobs: AutoFixJob[];
}

const DEFAULT_STATE: AutoFixState = {
  version: 1,
  jobs: []
};

function createDefaultState(): AutoFixState {
  return {
    version: 1,
    jobs: []
  };
}

export class AutoFixStore {
  private readonly dir: string;
  private readonly file: string;

  constructor(baseDir = process.cwd()) {
    this.dir = join(baseDir, '.crew', 'autofix');
    this.file = join(this.dir, 'queue.json');
  }

  private async readState(): Promise<AutoFixState> {
    if (!existsSync(this.file)) return createDefaultState();
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as AutoFixState;
      if (!Array.isArray(parsed.jobs)) return createDefaultState();
      return {
        version: 1,
        jobs: parsed.jobs.map(job => this.sanitizeJob(job)).filter(Boolean) as AutoFixJob[]
      };
    } catch {
      return createDefaultState();
    }
  }

  private sanitizeJob(job: Partial<AutoFixJob>): AutoFixJob | null {
    if (!job || typeof job.id !== 'string' || typeof job.task !== 'string') return null;
    const now = new Date().toISOString();
    return {
      id: job.id,
      task: String(job.task || '').trim(),
      projectDir: String(job.projectDir || process.cwd()),
      status: this.sanitizeStatus(job.status),
      createdAt: String(job.createdAt || now),
      updatedAt: String(job.updatedAt || now),
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      workerId: job.workerId,
      error: job.error,
      config: {
        maxIterations: Math.max(1, Number(job.config?.maxIterations || 6)),
        model: typeof job.config?.model === 'string' && job.config.model.trim().length > 0 ? job.config.model.trim() : undefined,
        fallbackModels: Array.isArray(job.config?.fallbackModels) ? job.config!.fallbackModels.map(v => String(v || '').trim()).filter(Boolean) : [],
        gateway: typeof job.config?.gateway === 'string' && job.config.gateway.trim().length > 0 ? job.config.gateway.trim() : undefined,
        validateCommands: Array.isArray(job.config?.validateCommands) ? job.config!.validateCommands.map(v => String(v || '').trim()).filter(Boolean) : [],
        autoApplyPolicy: this.sanitizePolicy(job.config?.autoApplyPolicy),
        blastRadiusThreshold: this.sanitizeThreshold(job.config?.blastRadiusThreshold),
        lspAutoFix: Boolean(job.config?.lspAutoFix),
        lspAutoFixMaxAttempts: Math.max(1, Number(job.config?.lspAutoFixMaxAttempts || 3))
      },
      result: job.result && typeof job.result === 'object' ? job.result : undefined
    };
  }

  private sanitizeStatus(status: unknown): AutoFixJobStatus {
    const value = String(status || 'queued').toLowerCase();
    if (value === 'running' || value === 'completed' || value === 'failed' || value === 'canceled') return value;
    return 'queued';
  }

  private sanitizePolicy(policy: unknown): AutoFixApplyPolicy {
    const value = String(policy || 'safe').toLowerCase();
    if (value === 'never' || value === 'force') return value;
    return 'safe';
  }

  private sanitizeThreshold(level: unknown): 'low' | 'medium' | 'high' {
    const value = String(level || 'high').toLowerCase();
    if (value === 'low' || value === 'medium') return value;
    return 'high';
  }

  private async writeState(state: AutoFixState): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file, JSON.stringify(state, null, 2), 'utf8');
  }

  async enqueue(input: {
    task: string;
    projectDir?: string;
    config?: Partial<AutoFixJobConfig>;
  }): Promise<AutoFixJob> {
    const now = new Date().toISOString();
    const state = await this.readState();
    const job = this.sanitizeJob({
      id: `af-${randomUUID()}`,
      task: String(input.task || '').trim(),
      projectDir: input.projectDir || process.cwd(),
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      config: {
        maxIterations: Math.max(1, Number(input.config?.maxIterations || 6)),
        model: input.config?.model,
        fallbackModels: input.config?.fallbackModels || [],
        gateway: input.config?.gateway,
        validateCommands: input.config?.validateCommands || [],
        autoApplyPolicy: this.sanitizePolicy(input.config?.autoApplyPolicy),
        blastRadiusThreshold: this.sanitizeThreshold(input.config?.blastRadiusThreshold),
        lspAutoFix: Boolean(input.config?.lspAutoFix),
        lspAutoFixMaxAttempts: Math.max(1, Number(input.config?.lspAutoFixMaxAttempts || 3))
      }
    });
    if (!job) throw new Error('Invalid autofix job payload');
    if (!job.task) throw new Error('Task is required');
    state.jobs.push(job);
    await this.writeState(state);
    return job;
  }

  async list(filter?: { status?: AutoFixJobStatus }): Promise<AutoFixJob[]> {
    const state = await this.readState();
    const jobs = [...state.jobs].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    if (!filter?.status) return jobs;
    return jobs.filter(job => job.status === filter.status);
  }

  async get(id: string): Promise<AutoFixJob | null> {
    const state = await this.readState();
    return state.jobs.find(job => job.id === id) || null;
  }

  async cancel(id: string): Promise<boolean> {
    const state = await this.readState();
    const index = state.jobs.findIndex(job => job.id === id);
    if (index < 0) return false;
    const current = state.jobs[index];
    if (current.status === 'completed' || current.status === 'failed') return false;
    state.jobs[index] = {
      ...current,
      status: 'canceled',
      updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString()
    };
    await this.writeState(state);
    return true;
  }

  async claimNext(workerId: string): Promise<AutoFixJob | null> {
    const state = await this.readState();
    const index = state.jobs.findIndex(job => job.status === 'queued');
    if (index < 0) return null;
    const now = new Date().toISOString();
    const claimed = {
      ...state.jobs[index],
      status: 'running' as AutoFixJobStatus,
      workerId,
      startedAt: now,
      updatedAt: now,
      error: undefined
    };
    state.jobs[index] = claimed;
    await this.writeState(state);
    return claimed;
  }

  async markCompleted(id: string, result: Record<string, unknown>) {
    return this.updateFinal(id, 'completed', result);
  }

  async markFailed(id: string, error: string, result: Record<string, unknown> = {}) {
    return this.updateFinal(id, 'failed', {
      ...result,
      error
    });
  }

  private async updateFinal(id: string, status: Extract<AutoFixJobStatus, 'completed' | 'failed'>, result: Record<string, unknown>) {
    const state = await this.readState();
    const index = state.jobs.findIndex(job => job.id === id);
    if (index < 0) return false;
    const now = new Date().toISOString();
    const current = state.jobs[index];
    state.jobs[index] = {
      ...current,
      status,
      updatedAt: now,
      finishedAt: now,
      error: status === 'failed' ? String(result.error || 'Job failed') : undefined,
      result
    };
    await this.writeState(state);
    return true;
  }
}
