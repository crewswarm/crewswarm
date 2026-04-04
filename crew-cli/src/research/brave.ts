import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface BraveSearchItem {
  title: string;
  url: string;
  description: string;
}

function getBraveApiKey(): string | null {
  if (process.env.BRAVE_API_KEY) return process.env.BRAVE_API_KEY;
  const cfgPath = join(homedir(), '.crewswarm', 'crewswarm.json');
  if (!existsSync(cfgPath)) return null;
  try {
    const raw = readFileSync(cfgPath, 'utf8');
    const cfg = JSON.parse(raw);
    const key = cfg?.providers?.brave?.apiKey || cfg?.providers?.braveSearch?.apiKey || null;
    return key ? String(key) : null;
  } catch {
    return null;
  }
}

export async function braveWebSearch(query: string, count = 5): Promise<BraveSearchItem[]> {
  const apiKey = getBraveApiKey();
  if (!apiKey) return [];

  const res = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.max(1, Math.min(10, count))}`,
    {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey
      }
    }
  );
  if (!res.ok) return [];

  const data = await res.json() as Record<string, unknown>;
  const web = data?.web as Record<string, unknown> | undefined;
  const results = Array.isArray(web?.results) ? web.results : [];
  return results.slice(0, count).map((item: Record<string, unknown>) => ({
    title: String(item?.title || '').trim(),
    url: String(item?.url || '').trim(),
    description: String(item?.description || '').trim()
  })).filter((x: BraveSearchItem) => x.url);
}
