export interface JsonParseOptions {
  label?: string;
  schemaHint?: string;
  maxAttempts?: number;
  validate?: (parsed: unknown) => { ok: boolean; errors?: string[] };
  onAttempt?: (meta: {
    label: string;
    attempt: number;
    success: boolean;
    repaired: boolean;
    error?: string;
  }) => void | Promise<void>;
  repair?: (prompt: string) => Promise<string>;
}

export function extractJsonCandidate(raw: string): string {
  const text = String(raw || '');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] || text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('Expected JSON object in model response');
  }
  return candidate.slice(start, end + 1);
}

export function sanitizeBrokenJson(jsonText: string): string {
  const src = String(jsonText || '');
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      out += ch;
      inString = !inString;
      continue;
    }
    if (inString) {
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      const code = ch.charCodeAt(0);
      if (code >= 0 && code < 0x20) {
        out += `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
    }
    out += ch;
  }

  // Repair common commas/termination issues.
  let fixed = out.replace(/,\s*([}\]])/g, '$1').replace(/,+/g, ',');
  const openBraces = (fixed.match(/\{/g) || []).length;
  const closeBraces = (fixed.match(/\}/g) || []).length;
  if (openBraces > closeBraces) fixed += '}'.repeat(openBraces - closeBraces);
  const openBrackets = (fixed.match(/\[/g) || []).length;
  const closeBrackets = (fixed.match(/\]/g) || []).length;
  if (openBrackets > closeBrackets) fixed += ']'.repeat(openBrackets - closeBrackets);
  return fixed;
}

export function parseJsonObject(raw: string): Record<string, unknown> {
  const candidate = extractJsonCandidate(raw);
  try {
    return JSON.parse(candidate);
  } catch {
    return JSON.parse(sanitizeBrokenJson(candidate));
  }
}

function buildRepairPrompt(raw: string, schemaHint?: string): string {
  return [
    'Convert the following content to STRICT valid JSON.',
    'Return exactly one JSON object. No markdown. No commentary.',
    schemaHint ? `Schema hint:\n${schemaHint}` : '',
    '',
    '[RAW OUTPUT]',
    String(raw || '').slice(0, 16000)
  ].join('\n');
}

export async function parseJsonObjectWithRepair(raw: string, options: JsonParseOptions = {}): Promise<any> {
  const label = options.label || 'JSON';
  const maxAttempts = Math.max(1, Number(options.maxAttempts || 2));
  let lastError = '';
  let candidateRaw = String(raw || '');

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const repaired = attempt > 1;
    try {
      const parsed = parseJsonObject(candidateRaw);
      if (options.validate) {
        const verdict = options.validate(parsed);
        if (!verdict.ok) {
          throw new Error((verdict.errors || []).join('; ') || 'schema validation failed');
        }
      }
      await options.onAttempt?.({ label, attempt, success: true, repaired });
      return parsed;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (process.env.CREW_VERBOSE === 'true' || process.env.CREW_DEBUG === 'true') {
        console.log(`[JSON Parse Error] ${label} attempt ${attempt}: ${lastError}`);
        console.log(`[JSON Parse Error] Raw response (first 500 chars): ${candidateRaw.substring(0, 500)}`);
      }
      await options.onAttempt?.({ label, attempt, success: false, repaired, error: lastError });
      if (attempt >= maxAttempts || !options.repair) break;
      const repairPrompt = buildRepairPrompt(candidateRaw, options.schemaHint);
      candidateRaw = await options.repair(repairPrompt);
    }
  }

  throw new Error(`${label} parse failed after ${maxAttempts} attempt(s): ${lastError}`);
}
