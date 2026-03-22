import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

interface CacheEntry<T = any> {
  value: T;
  createdAt: string;
  expiresAt: string;
  meta?: {
    tokensSaved?: number;
    usdSaved?: number;
    source?: string;
  };
}

interface CacheStore {
  version: number;
  namespaces: Record<string, Record<string, CacheEntry>>;
}

function nowIso() {
  return new Date().toISOString();
}

function toTimestamp(iso: string): number {
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? ts : 0;
}

export class TokenCache {
  private baseDir: string;
  private cachePath: string;

  constructor(baseDir = process.cwd()) {
    this.baseDir = baseDir;
    this.cachePath = join(baseDir, '.crew', 'token-cache.json');
  }

  static hashKey(input: string): string {
    return createHash('sha256').update(String(input || '')).digest('hex');
  }

  private async ensureStore(): Promise<CacheStore> {
    const dir = join(this.baseDir, '.crew');
    await mkdir(dir, { recursive: true });
    if (!existsSync(this.cachePath)) {
      const initial: CacheStore = { version: 1, namespaces: {} };
      await writeFile(this.cachePath, JSON.stringify(initial, null, 2), 'utf8');
      return initial;
    }
    try {
      const raw = await readFile(this.cachePath, 'utf8');
      const parsed = JSON.parse(raw) as CacheStore;
      return {
        version: parsed.version || 1,
        namespaces: parsed.namespaces || {}
      };
    } catch {
      return { version: 1, namespaces: {} };
    }
  }

  private async saveStore(store: CacheStore): Promise<void> {
    await writeFile(this.cachePath, JSON.stringify(store, null, 2), 'utf8');
  }

  async get<T = any>(namespace: string, key: string): Promise<{ hit: boolean; value?: T; meta?: CacheEntry['meta'] }> {
    const store = await this.ensureStore();
    const ns = store.namespaces[namespace] || {};
    const entry = ns[key];
    if (!entry) {
      return { hit: false };
    }
    if (toTimestamp(entry.expiresAt) <= Date.now()) {
      delete ns[key];
      store.namespaces[namespace] = ns;
      await this.saveStore(store);
      return { hit: false };
    }
    return { hit: true, value: entry.value as T, meta: entry.meta };
  }

  async set<T = any>(
    namespace: string,
    key: string,
    value: T,
    ttlSeconds = 1800,
    meta: CacheEntry['meta'] = {}
  ): Promise<void> {
    const ttl = Math.max(1, Number(ttlSeconds || 1800));
    const store = await this.ensureStore();
    if (!store.namespaces[namespace]) {
      store.namespaces[namespace] = {};
    }
    store.namespaces[namespace][key] = {
      value,
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      meta
    };
    await this.saveStore(store);
  }
}
