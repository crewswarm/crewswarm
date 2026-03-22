import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface TierPolicy {
  primary?: string;
  fallback?: string[];
  maxCostUsd?: number;
}

export interface ModelPolicy {
  tiers?: {
    planner?: TierPolicy;
    executor?: TierPolicy;
    worker?: TierPolicy;
  };
}

function sanitizeTier(input: unknown): TierPolicy {
  const out: TierPolicy = {};
  if (!input || typeof input !== 'object') return out;
  const item = input as Record<string, unknown>;
  if (typeof item.primary === 'string') out.primary = item.primary.trim();
  if (Array.isArray(item.fallback)) {
    out.fallback = item.fallback
      .map(v => String(v || '').trim())
      .filter(Boolean);
  }
  if (typeof item.maxCostUsd === 'number' && Number.isFinite(item.maxCostUsd) && item.maxCostUsd >= 0) {
    out.maxCostUsd = item.maxCostUsd;
  }
  return out;
}

export async function loadModelPolicy(baseDir = process.cwd()): Promise<ModelPolicy> {
  const path = join(baseDir, '.crew', 'model-policy.json');
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const obj = parsed as Record<string, unknown>;
  const tiers = (obj.tiers && typeof obj.tiers === 'object') ? (obj.tiers as Record<string, unknown>) : {};
  return {
    tiers: {
      planner: sanitizeTier(tiers.planner),
      executor: sanitizeTier(tiers.executor),
      worker: sanitizeTier(tiers.worker)
    }
  };
}
