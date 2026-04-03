/**
 * Strip Gemini CLI banner / status lines from engine passthrough (stdout before JSON lines).
 * Used by crew-lead, dashboard, and Vibe.
 */

function stripAnsiPassthrough(text) {
  return String(text || "")
    .replace(/\u001b\[[\d;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
}

/**
 * @param {string} line
 * @returns {boolean} true = do not forward this line as chat content
 */
export function shouldSkipGeminiPassthroughLine(line) {
  const t = stripAnsiPassthrough(String(line || "").replace(/\r/g, "")).trim();
  if (!t) return true;
  if (/^YOLO mode is enabled/i.test(t)) return true;
  if (/All tool calls will be automatically approved/i.test(t)) return true;
  if (/Loaded cached credentials/i.test(t)) return true;
  if (/^Using bundled/i.test(t)) return true;
  if (/^Authenticated via/i.test(t)) return true;
  if (/^OpenTelemetry/i.test(t)) return true;
  return false;
}

/**
 * @param {string} engine
 * @param {string} text
 */
export function filterGeminiPassthroughTextChunk(engine, text) {
  if (engine !== "gemini" && engine !== "gemini-cli") return String(text ?? "");
  const s = String(text ?? "");
  if (!s) return s;
  return s.split("\n").filter((ln) => !shouldSkipGeminiPassthroughLine(ln)).map((ln) => ln.replace(/\r$/, "")).join("\n");
}
