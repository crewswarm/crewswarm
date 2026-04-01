/**
 * Shared UI helpers for engine CLI passthrough stderr (dashboard + Studio).
 * Mirrors lib/crew-lead/http-server.mjs filtering; adds line buffering for split TCP chunks.
 */

function normalizeStderrLine(line) {
  return String(line || "").replace(/\r$/, "");
}

/** @param {string} engine */
export function shouldDropPassthroughStderrLine(engine, line) {
  const l = normalizeStderrLine(line);
  if (!l.trim()) return true;
  if (/rmcp::/i.test(l)) return true;
  if (/error decoding response body.*initialized notification/i.test(l))
    return true;
  if (/\[Executor\]\s+\w+\s+\((OAuth|API)\)/i.test(l)) return true;
  if (
    engine === "codex" &&
    /worker quit with fatal/i.test(l) &&
    /rmcp|mcp/i.test(l)
  )
    return true;
  if (
    engine === "codex" &&
    /\/mcp/i.test(l) &&
    /127\.0\.0\.1:\d+|localhost:\d+/i.test(l) &&
    /Connection refused|ConnectError|Transport channel closed|tcp connect error/i.test(l)
  )
    return true;
  return false;
}

function stripAnsi(text) {
  return String(text || "")
    .replace(/\u001b\[[\d;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
}

/**
 * @param {string} engine
 * @returns {{ push: (chunk: string) => string, flush: () => string }}
 */
export function createPassthroughStderrLineFilter(engine) {
  let partial = "";
  return {
    push(chunk) {
      partial += String(chunk || "");
      const parts = partial.split("\n");
      partial = parts.pop() ?? "";
      const out = [];
      for (const line of parts) {
        if (shouldDropPassthroughStderrLine(engine, line)) continue;
        const cleaned = stripAnsi(normalizeStderrLine(line)).trimEnd();
        if (cleaned) out.push(cleaned);
      }
      return out.length ? `${out.join("\n")}\n` : "";
    },
    flush() {
      const tail = partial;
      partial = "";
      if (!tail) return "";
      if (shouldDropPassthroughStderrLine(engine, tail)) return "";
      const cleaned = stripAnsi(normalizeStderrLine(tail)).trimEnd();
      return cleaned ? `${cleaned}\n` : "";
    },
  };
}

function scoreErrorLine(line) {
  const l = String(line || "");
  let s = 0;
  if (/SecItemCopyMatching|keychain|Keychain/i.test(l)) s += 100;
  if (/ERROR:\s|^ERROR\s|error:\s|FATAL|fatal|panic/i.test(l)) s += 45;
  if (/authentication|unauthorized|\b401\b|\b403\b|not logged in/i.test(l))
    s += 30;
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|certificate|TLS|SSL/i.test(l))
    s += 25;
  if (/command not found|No such file|ENOENT/i.test(l)) s += 20;
  return s;
}

/**
 * Best single line to show when exit !== 0 (after noise filter).
 * @param {string} engine
 */
export function summarizePassthroughTopErrorLine(accumulated, engine) {
  const raw = String(accumulated || "");
  const parts = raw.split("\n");
  const kept = [];
  for (const line of parts) {
    if (shouldDropPassthroughStderrLine(engine, line)) continue;
    const c = stripAnsi(normalizeStderrLine(line)).trim();
    if (c) kept.push(c);
  }
  if (!kept.length) return "";
  let best = kept[0];
  let bestScore = scoreErrorLine(best);
  for (const line of kept) {
    const sc = scoreErrorLine(line);
    if (sc > bestScore) {
      bestScore = sc;
      best = line;
    }
  }
  if (bestScore === 0 && kept.length > 4) {
    return `${kept[0]} (${kept.length} lines)`;
  }
  return best;
}
