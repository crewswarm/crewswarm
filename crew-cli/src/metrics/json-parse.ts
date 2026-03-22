import { appendFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export async function recordJsonParseMetric(entry: {
  label: string;
  attempt: number;
  success: boolean;
  repaired: boolean;
  error?: string;
  traceId?: string;
}) {
  try {
    const dir = resolve(process.cwd(), '.crew');
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'json-parse-metrics.jsonl');
    await appendFile(path, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8');
  } catch {
    // Best-effort observability.
  }
}

