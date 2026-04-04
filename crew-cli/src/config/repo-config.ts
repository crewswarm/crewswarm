// @ts-nocheck
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface RepoConfig {
  cli?: {
    model?: string;
    engine?: string;
    preferredEngines?: string[];
    fallbackModels?: string[];
    docsCode?: boolean;
    memoryMax?: number;
  };
  repl?: {
    model?: string;
    engine?: string;
    autoApply?: boolean;
    memoryMax?: number;
    mode?: 'manual' | 'assist' | 'autopilot';
    bannerEnabled?: boolean;
    animatedBanner?: boolean;
    bannerFirstLaunchOnly?: boolean;
  };
  slashAliases?: Record<string, string>;
}

const DEFAULT_CONFIG: Required<RepoConfig> = {
  cli: {
    model: '',
    engine: '',
    preferredEngines: [],
    fallbackModels: [],
    docsCode: false,
    memoryMax: 3
  },
  repl: {
    model: '',
    engine: 'auto',
    autoApply: false,
    memoryMax: 5,
    mode: 'manual',
    bannerEnabled: true,
    animatedBanner: true,
    bannerFirstLaunchOnly: true
  },
  slashAliases: {}
};

const SECRET_KEY_RE = /(api[_-]?key|token|secret|password|bearer|auth)/i;

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge<T extends Record<string, any>>(base: T, overlay: Record<string, any>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(overlay || {})) {
    const existing = out[k];
    if (isObject(existing) && isObject(v)) {
      out[k] = deepMerge(existing, v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

function parseJsonOrEmpty(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function configPath(baseDir: string, scope: 'team' | 'user') {
  return join(baseDir, '.crew', scope === 'team' ? 'crewswarm.json' : 'config.local.json');
}

function assertNoSecrets(input: unknown, prefix = '') {
  if (Array.isArray(input)) {
    for (let i = 0; i < input.length; i++) {
      assertNoSecrets(input[i], `${prefix}[${i}]`);
    }
    return;
  }
  if (!isObject(input)) return;
  for (const [k, v] of Object.entries(input)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (SECRET_KEY_RE.test(k)) {
      throw new Error(`Secret-like key not allowed in repo team config: ${path}`);
    }
    assertNoSecrets(v, path);
  }
}

function redactSecrets(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(redactSecrets);
  if (!isObject(input)) return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redactSecrets(v);
    }
  }
  return out;
}

export async function readRepoConfig(baseDir: string, scope: 'team' | 'user'): Promise<Record<string, unknown>> {
  const path = configPath(baseDir, scope);
  if (!existsSync(path)) return {};
  const raw = await readFile(path, 'utf8');
  return parseJsonOrEmpty(raw);
}

export async function loadResolvedRepoConfig(baseDir = process.cwd()): Promise<Required<RepoConfig>> {
  const team = await readRepoConfig(baseDir, 'team');
  const user = await readRepoConfig(baseDir, 'user');
  return deepMerge(deepMerge(DEFAULT_CONFIG, team), user);
}

export async function writeRepoConfig(baseDir: string, scope: 'team' | 'user', config: Record<string, unknown>) {
  const path = configPath(baseDir, scope);
  await mkdir(join(baseDir, '.crew'), { recursive: true });
  if (scope === 'team') {
    assertNoSecrets(config);
  }
  await writeFile(path, JSON.stringify(config, null, 2), 'utf8');
}

export async function setRepoConfigValue(
  baseDir: string,
  scope: 'team' | 'user',
  keyPath: string,
  value: unknown
) {
  if (scope === 'team' && SECRET_KEY_RE.test(keyPath)) {
    throw new Error(`Secret-like key not allowed in repo team config: ${keyPath}`);
  }
  const current = await readRepoConfig(baseDir, scope);
  const parts = keyPath.split('.').filter(Boolean);
  if (parts.length === 0) throw new Error('Invalid key path');
  let cursor: Record<string, unknown> = current;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    const next = cursor[k];
    if (!isObject(next)) {
      cursor[k] = {};
    }
    cursor = cursor[k] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
  await writeRepoConfig(baseDir, scope, current);
}

export function getNestedValue(source: Record<string, unknown>, keyPath: string): unknown {
  const parts = keyPath.split('.').filter(Boolean);
  let cursor: unknown = source;
  for (const p of parts) {
    if (!isObject(cursor) && !Array.isArray(cursor)) return undefined;
    cursor = cursor[p];
    if (cursor === undefined) return undefined;
  }
  return cursor;
}

export function redactRepoConfigForDisplay<T>(value: T): T {
  return redactSecrets(value) as T;
}
