/**
 * Normalize user-supplied project / output directory paths.
 * Fixes common dashboard typos (e.g. ~Desktop/foo instead of ~/Desktop/foo).
 */

import path from "node:path";
import os from "node:os";

/**
 * @param {string|null|undefined} raw
 * @returns {string|null} Absolute normalized path, or null if empty/invalid
 */
export function normalizeProjectDir(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;

  const home = os.homedir();

  // Typo: "~/Desktop/foo" pasted without slash → "~Desktop/foo"
  if (/^~Desktop\//i.test(s)) {
    s = path.join(home, "Desktop", s.replace(/^~Desktop\//i, ""));
  } else if (/^~desktop$/i.test(s)) {
    s = path.join(home, "Desktop");
  }

  // Standard tilde expansion
  if (s === "~") {
    s = home;
  } else if (s.startsWith("~/") || s.startsWith("~\\")) {
    s = path.join(home, s.slice(2));
  }

  try {
    if (path.isAbsolute(s)) {
      return path.normalize(s);
    }
    // Relative paths: resolve from cwd (last resort)
    return path.normalize(path.resolve(process.cwd(), s));
  } catch {
    return null;
  }
}

/**
 * LLMs / sandboxes often embed the mistaken path `…/<repo>/~Desktop/<project>/` (missing `/` after `~`).
 * Planning files land there while builds use the real `~/Desktop/<project>/`. Rewrite task text to the
 * canonical project directory so @@READ_FILE paths resolve.
 *
 * @param {string} text
 * @param {string} canonicalDir absolute project root (e.g. /Users/you/Desktop/stinky-1)
 * @returns {string}
 */
export function rewriteWrongDesktopMirrorPaths(text, canonicalDir) {
  if (!text || typeof text !== "string" || !canonicalDir) return text;
  const canon = path.resolve(String(canonicalDir).trim()).replace(/\\/g, "/");
  const base = path.basename(canon);
  if (!base || base === "." || base === "..") return text;

  const wrongUnderCwd = path
    .join(process.cwd(), "~Desktop", base)
    .replace(/\\/g, "/");
  const wrongUnderCwdNorm = path
    .normalize(path.join(process.cwd(), "~Desktop", base))
    .replace(/\\/g, "/");

  let out = text;
  const pairs = [
    [wrongUnderCwd, canon],
    [wrongUnderCwdNorm, canon],
  ];
  for (const [w, c] of pairs) {
    if (w && w !== c && out.includes(w)) out = out.split(w).join(c);
  }

  // Any absolute path segment `.../~Desktop/<basename>` (typo) → canon (keep suffix after basename)
  const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    String.raw`([A-Za-z]:)?(?:/[^/\s"']*)*/\~Desktop/` + escapedBase + String.raw`(?=/|\s|"|'|$)`,
    "gi",
  );
  out = out.replace(re, () => canon);

  return out;
}

/**
 * OpenCode (and similar sandboxes) treat absolute paths outside the active session root as
 * `external_directory` and auto-reject in non-interactive mode. When cwd/projectDir is already
 * the project root, rewrite obvious absolute/~/ paths to ./ so tools stay in-workspace.
 *
 * @param {string} taskText
 * @param {string} projectDir
 * @returns {string}
 */
export function rewriteTaskPathsRelativeToProjectRoot(taskText, projectDir) {
  if (!taskText || typeof taskText !== "string" || !projectDir) return taskText;
  let canon;
  try {
    canon = path.resolve(String(projectDir).trim()).replace(/\\/g, "/");
  } catch {
    return taskText;
  }
  const noTrail = canon.replace(/\/+$/, "");
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let out = taskText;
  out = out.replace(new RegExp(esc(noTrail) + "/", "g"), "./");
  const base = path.basename(noTrail);
  if (base && base !== "." && base !== "..") {
    const homeDesk = path.join(os.homedir(), "Desktop", base).replace(/\\/g, "/");
    if (homeDesk === noTrail) {
      out = out.replace(
        new RegExp(`~\\/Desktop\\/${esc(base)}\\/`, "g"),
        "./",
      );
      out = out.replace(
        new RegExp(`~/Desktop/${esc(base)}/`, "g"),
        "./",
      );
      out = out.replace(
        new RegExp(`~/Desktop/${esc(base)}(?=[/\\s"'\\)\\]>|$])`, "g"),
        ".",
      );
    }
  }
  return out;
}
