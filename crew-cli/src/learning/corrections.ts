import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

export interface CorrectionEntry {
  timestamp: string;
  prompt: string;
  original: string;
  corrected: string;
  agent?: string;
  tags?: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export class CorrectionStore {
  baseDir: string;
  stateDir: string;
  dataPath: string;

  constructor(baseDir = process.cwd()) {
    this.baseDir = baseDir;
    this.stateDir = join(baseDir, '.crew');
    this.dataPath = join(this.stateDir, 'training-data.jsonl');
  }

  async ensureReady(): Promise<void> {
    if (!(await pathExists(this.stateDir))) {
      await mkdir(this.stateDir, { recursive: true });
    }

    if (!(await pathExists(this.dataPath))) {
      await writeFile(this.dataPath, '', 'utf8');
    }
  }

  async record(entry: Omit<CorrectionEntry, 'timestamp'>): Promise<CorrectionEntry> {
    await this.ensureReady();

    const payload: CorrectionEntry = {
      timestamp: nowIso(),
      ...entry
    };

    await writeFile(this.dataPath, `${JSON.stringify(payload)}\n`, {
      encoding: 'utf8',
      flag: 'a'
    });

    return payload;
  }

  async loadAll(): Promise<CorrectionEntry[]> {
    await this.ensureReady();
    const raw = await readFile(this.dataPath, 'utf8');
    const lines = raw.split('\n').map(line => line.trim()).filter(Boolean);
    return lines.map(line => JSON.parse(line) as CorrectionEntry);
  }

  async summary(): Promise<{ count: number; latest?: CorrectionEntry }> {
    const all = await this.loadAll();
    return {
      count: all.length,
      latest: all.length > 0 ? all[all.length - 1] : undefined
    };
  }

  async exportTo(path: string): Promise<void> {
    await this.ensureReady();
    await copyFile(this.dataPath, path);
  }
}
