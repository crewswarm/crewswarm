import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface XSearchOptions {
  model?: string;
  fromDate?: string;
  toDate?: string;
  allowedHandles?: string[];
  excludedHandles?: string[];
  enableImages?: boolean;
  enableVideos?: boolean;
}

export interface XSearchResult {
  text: string;
  citations: string[];
  raw: any;
}

function getXaiApiKey(): string | null {
  if (process.env.XAI_API_KEY) return process.env.XAI_API_KEY;
  if (process.env.GROK_API_KEY) return process.env.GROK_API_KEY;
  const cfgPath = join(homedir(), '.crewswarm', 'crewswarm.json');
  if (!existsSync(cfgPath)) return null;
  try {
    const raw = readFileSync(cfgPath, 'utf8');
    const cfg = JSON.parse(raw);
    return cfg?.providers?.xai?.apiKey || null;
  } catch {
    return null;
  }
}

function coerceDate(value?: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10);
}

export async function runXSearch(query: string, options: XSearchOptions = {}): Promise<XSearchResult> {
  const apiKey = getXaiApiKey();
  if (!apiKey) {
    throw new Error('Missing xAI API key. Set XAI_API_KEY or ~/.crewswarm/crewswarm.json providers.xai.apiKey');
  }
  const model = options.model || 'grok-4-1-fast-reasoning';
  const tool: Record<string, unknown> = { type: 'x_search' };
  const fromDate = coerceDate(options.fromDate);
  const toDate = coerceDate(options.toDate);
  if (fromDate) tool.from_date = fromDate;
  if (toDate) tool.to_date = toDate;
  if (options.allowedHandles && options.allowedHandles.length > 0) tool.allowed_x_handles = options.allowedHandles;
  if (options.excludedHandles && options.excludedHandles.length > 0) tool.excluded_x_handles = options.excludedHandles;
  if (typeof options.enableImages === 'boolean') tool.enable_image_understanding = options.enableImages;
  if (typeof options.enableVideos === 'boolean') tool.enable_video_understanding = options.enableVideos;

  const response = await fetch('https://api.x.ai/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      input: [{ role: 'user', content: query }],
      tools: [tool]
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`xAI request failed (${response.status}): ${text.slice(0, 300)}`);
  }

  const raw = await response.json() as any;
  const outputs = Array.isArray(raw?.output) ? raw.output : [];
  let text = '';
  for (const o of outputs) {
    const content = Array.isArray(o?.content) ? o.content : [];
    for (const c of content) {
      if (typeof c?.text === 'string' && c.text.trim()) {
        text += (text ? '\n\n' : '') + c.text.trim();
      }
    }
  }
  const citations = Array.isArray(raw?.citations)
    ? raw.citations.map((c: any) => String(c?.url || c || '')).filter(Boolean)
    : [];
  return {
    text: text || 'No textual response.',
    citations,
    raw
  };
}

