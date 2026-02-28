import { createTwoFilesPatch } from 'diff';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname } from 'node:path';

export interface SandboxChange {
  path: string;
  original: string;
  modified: string;
  timestamp: string;
}

export interface SandboxState {
  updatedAt: string;
  activeBranch: string;
  branches: Record<string, Record<string, SandboxChange>>;
}

export class Sandbox {
  private state: SandboxState = {
    updatedAt: new Date().toISOString(),
    activeBranch: 'main',
    branches: { main: {} }
  };
  private baseDir: string;
  private stateFilePath: string;

  constructor(baseDir = process.cwd()) {
    this.baseDir = baseDir;
    this.stateFilePath = join(baseDir, '.crew', 'sandbox.json');
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await access(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async load(): Promise<void> {
    if (await this.exists(this.stateFilePath)) {
      try {
        const data = await readFile(this.stateFilePath, 'utf8');
        const parsed = JSON.parse(data) as SandboxState;
        this.state = {
          ...this.state,
          ...parsed,
          branches: parsed.branches || { main: {} },
          activeBranch: parsed.activeBranch || 'main'
        };
      } catch (err) {
        console.error(`Failed to load sandbox state: ${(err as Error).message}`);
      }
    }
  }

  async persist(): Promise<void> {
    this.state.updatedAt = new Date().toISOString();
    const dir = dirname(this.stateFilePath);
    if (!(await this.exists(dir))) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(this.stateFilePath, JSON.stringify(this.state, null, 2), 'utf8');
  }

  async addChange(filePath: string, modifiedContent: string): Promise<void> {
    const fullPath = join(this.baseDir, filePath);
    let original = '';
    
    const activeChanges = this.state.branches[this.state.activeBranch];
    
    if (activeChanges[filePath]) {
      original = activeChanges[filePath].original;
    } else if (await this.exists(fullPath)) {
      original = await readFile(fullPath, 'utf8');
    }

    activeChanges[filePath] = {
      path: filePath,
      original,
      modified: modifiedContent,
      timestamp: new Date().toISOString()
    };
    
    await this.persist();
  }

  preview(branchName = this.state.activeBranch): string {
    const branch = this.state.branches[branchName];
    if (!branch) return `Branch "${branchName}" not found.`;

    let diff = '';
    for (const [path, change] of Object.entries(branch)) {
      diff += createTwoFilesPatch(
        `a/${path}`,
        `b/${path}`,
        change.original,
        change.modified,
        undefined,
        undefined,
        { context: 3 }
      );
    }
    return diff || 'No pending changes.';
  }

  async apply(branchName = this.state.activeBranch): Promise<void> {
    const branch = this.state.branches[branchName];
    if (!branch) throw new Error(`Branch "${branchName}" not found.`);

    for (const [path, change] of Object.entries(branch)) {
      const fullPath = join(this.baseDir, path);
      const dir = dirname(fullPath);
      if (!(await this.exists(dir))) {
        await mkdir(dir, { recursive: true });
      }
      await writeFile(fullPath, change.modified, 'utf8');
    }
    await this.rollback(branchName);
  }

  async rollback(branchName = this.state.activeBranch): Promise<void> {
    if (this.state.branches[branchName]) {
      this.state.branches[branchName] = {};
      await this.persist();
    }
  }

  async createBranch(name: string, fromBranch = this.state.activeBranch): Promise<void> {
    if (this.state.branches[name]) {
      throw new Error(`Branch "${name}" already exists.`);
    }
    // Deep copy current changes from fromBranch
    const sourceBranch = this.state.branches[fromBranch] || {};
    this.state.branches[name] = JSON.parse(JSON.stringify(sourceBranch));
    this.state.activeBranch = name;
    await this.persist();
  }

  async switchBranch(name: string): Promise<void> {
    if (!this.state.branches[name]) {
      throw new Error(`Branch "${name}" does not exist.`);
    }
    this.state.activeBranch = name;
    await this.persist();
  }

  async deleteBranch(name: string): Promise<void> {
    if (name === 'main') throw new Error('Cannot delete main branch.');
    if (this.state.activeBranch === name) {
      this.state.activeBranch = 'main';
    }
    delete this.state.branches[name];
    await this.persist();
  }

  async mergeBranch(source: string, target = this.state.activeBranch): Promise<void> {
    if (!this.state.branches[source]) throw new Error(`Source branch "${source}" not found.`);
    if (!this.state.branches[target]) throw new Error(`Target branch "${target}" not found.`);

    const sourceChanges = this.state.branches[source];
    const targetChanges = this.state.branches[target];

    for (const [path, change] of Object.entries(sourceChanges)) {
      targetChanges[path] = JSON.parse(JSON.stringify(change));
    }

    await this.persist();
  }

  getActiveBranch(): string {
    return this.state.activeBranch;
  }

  getBranches(): string[] {
    return Object.keys(this.state.branches);
  }

  getPendingPaths(branchName = this.state.activeBranch): string[] {
    return Object.keys(this.state.branches[branchName] || {});
  }

  hasChanges(branchName = this.state.activeBranch): boolean {
    return Object.keys(this.state.branches[branchName] || {}).length > 0;
  }
}
