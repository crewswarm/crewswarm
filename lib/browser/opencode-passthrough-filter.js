/**
 * Strip OpenCode / Ink status lines from dashboard passthrough chunks (belt-and-suspenders
 * with crew-lead filtering). See lib/crew-lead/http-server.mjs shouldSkipOpenCodePassthroughLine.
 */

function stripAnsiPassthrough(text) {
  return String(text || "")
    .replace(/\u001b\[[\d;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
}

/**
 * @param {string} line
 * @returns {boolean} true = drop this line from chat
 */
export function shouldFilterOpenCodePassthroughLine(line) {
  const t = stripAnsiPassthrough(String(line || "").replace(/\r/g, "")).trim();
  if (!t) return true;
  // "> build", "> run", etc. (allow no space after >)
  if (/^>\s*(build|run|eval|install|pack|starting|sync|watch|plan)\b/i.test(t))
    return true;
  // Same + model id path segment (e.g. moonshotai/kimi-…)
  if (
    /^>\s*(build|run|eval|install|pack|starting|sync|watch|plan)\b.*\/[\w.-]+/i.test(
      t,
    )
  )
    return true;
  // "> label · rest" with common bullet glyphs (U+00B7 middle dot, U+2022 bullet, etc.)
  if (/^>\s*[^\n]+[\u00B7\u2022\u22C5\u2027\u30FB‧⋅]\s*\S/u.test(t)) return true;
  if (/^[─═━\-]{3,}$/.test(t)) return true;
  return false;
}

/**
 * @param {string} engine
 * @param {string} text
 */
export function filterOpenCodePassthroughTextChunk(engine, text) {
  if (engine !== "opencode" && engine !== "antigravity") return String(text ?? "");
  const s = String(text ?? "");
  if (!s) return s;
  return s.split("\n").filter((ln) => !shouldFilterOpenCodePassthroughLine(ln)).join("\n");
}
