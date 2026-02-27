#!/usr/bin/env node
/**
 * scripts/check-dashboard.mjs
 *
 * Validates that the dashboard HTML and inline script do not have syntax errors
 * or common pitfalls that break the browser (e.g. "Uncaught SyntaxError: Unexpected string").
 *
 * Run after editing scripts/dashboard.mjs:
 *   node scripts/check-dashboard.mjs
 *
 * Options:
 *   --source-only   Only run source heuristics (no spawn, no --print-html).
 *
 * Exit 0 = pass, 1 = fail.
 */

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DASHBOARD = path.join(ROOT, "scripts", "dashboard.mjs");
const TIMEOUT_MS = 25000;

function extractScriptBlocks(html) {
  const blocks = [];
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = (m[1] || "").toLowerCase();
    if (attrs.includes("src=")) continue;
    blocks.push({ index: blocks.length, content: m[2].trim() });
  }
  return blocks;
}

function parseScript(script) {
  try {
    new Function(script);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e };
  }
}

/** Find exact error location by writing script to temp file and running node --check. */
function locateSyntaxError(script, blockIndex) {
  const tmpScript = path.join(os.tmpdir(), `crewswarm-dashboard-script-${process.pid}-${blockIndex}.js`);
  try {
    fs.writeFileSync(tmpScript, script, "utf8");
    const result = spawnSync("node", ["--check", tmpScript], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    const stderr = (result.stderr || "").trim();
    const stdout = (result.stdout || "").trim();
    const out = stderr || stdout;
    if (out) {
      const lineMatch = out.match(/:(\d+)(?::(\d+))?/);
      const lineNum = lineMatch ? parseInt(lineMatch[1], 10) : null;
      const colNum = lineMatch && lineMatch[2] ? parseInt(lineMatch[2], 10) : null;
      const lines = script.split("\n");
      const snippetStart = lineNum != null ? Math.max(0, lineNum - 3) : 0;
      const snippetEnd = lineNum != null ? Math.min(lines.length, lineNum + 2) : 5;
      const snippet = lines
        .slice(snippetStart, snippetEnd)
        .map((l, j) => {
          const num = snippetStart + j + 1;
          const mark = num === lineNum ? " >>> " : "     ";
          return `${String(num).padStart(4)}|${mark} ${l}`;
        })
        .join("\n");
      return {
        message: result.status === 0 ? "" : (out.split("\n")[0] || "SyntaxError").trim(),
        line: lineNum,
        column: colNum,
        snippet,
        fullOutput: out,
        context: lineNum != null
          ? `Error at line ${lineNum}${colNum != null ? `, column ${colNum}` : ""} of the inline script (script block line numbers).`
          : "See output below for location.",
      };
    }
  } finally {
    try { fs.unlinkSync(tmpScript); } catch {}
  }
  return null;
}

function runSourceHeuristics() {
  const issues = [];
  const raw = fs.readFileSync(DASHBOARD, "utf8");

  // The dashboard UI now lives in frontend/src/app.js + frontend/index.html (Vite).
  // dashboard.mjs only holds a tiny stub fallback — no inline <script> block needed.
  // Detect stub by looking for the "Frontend not built" marker or very short html const.
  const htmlConstMatch = raw.match(/^const html\s*=\s*`([\s\S]*?)`;/m);
  const htmlConstLen = htmlConstMatch ? htmlConstMatch[1].length : 0;
  if (htmlConstLen < 2000) {
    // Stub mode — validate frontend Vite source instead
    const frontendApp = path.join(ROOT, "frontend", "src", "app.js");
    const frontendDist = path.join(ROOT, "frontend", "dist", "index.html");
    if (!fs.existsSync(frontendDist)) {
      issues.push("frontend/dist/index.html not found — run: cd frontend && npm run build");
    }
    if (!fs.existsSync(frontendApp)) {
      issues.push("frontend/src/app.js not found — Vite source is missing.");
    }
    return issues;
  }

  const scriptStart = raw.indexOf("<script>");
  const scriptEnd = raw.indexOf("</script>");
  if (scriptStart === -1 || scriptEnd === -1 || scriptEnd <= scriptStart) {
    issues.push("Could not find <script>...</script> block in source.");
    return issues;
  }
  const scriptSection = raw.slice(scriptStart, scriptEnd + 9);
  const lines = scriptSection.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i + 1 < lines.length && /'\s*$/.test(line) && /^\s*'/.test(lines[i + 1])) {
      issues.push(`Adjacent single-quoted strings (likely bug) around script line ~${i + 1}`);
    }
    if (/[\u2018\u2019\u201c\u201d]/.test(line)) {
      issues.push(`Smart/curly quotes in script section (use ASCII quotes) around line ~${i + 1}`);
    }
  }
  return issues;
}

async function getDashboardHtml() {
  const tmpFile = path.join(os.tmpdir(), `crewswarm-dashboard-check-${process.pid}.html`);
  const out = fs.createWriteStream(tmpFile, { flags: "w" });

  return new Promise((resolve, reject) => {
    let settled = false;
    let exitCode = null;
    let streamDone = false;

    function finish(err, html) {
      if (settled) return;
      settled = true;
      try { fs.unlinkSync(tmpFile); } catch {}
      if (err) reject(err);
      else resolve(html);
    }

    function maybeSettle() {
      if (exitCode === null || !streamDone) return;
      if (exitCode !== 0) {
        finish(new Error(stderr || `Dashboard exited with code ${exitCode}`));
        return;
      }
      try {
        const html = fs.readFileSync(tmpFile, "utf8");
        finish(null, html);
      } catch (e) {
        finish(e);
      }
    }

    const child = spawn("node", [DASHBOARD, "--print-html"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("Dashboard --print-html timed out (run with --source-only to skip spawn)."));
    }, TIMEOUT_MS);

    child.stdout.pipe(out);
    out.on("finish", () => { streamDone = true; maybeSettle(); });
    child.on("error", (e) => {
      clearTimeout(timeout);
      finish(e);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      exitCode = code;
      maybeSettle();
    });
  });
}

async function main() {
  const sourceOnly = process.argv.includes("--source-only");
  console.log("Checking dashboard...");

  if (sourceOnly) {
    const issues = runSourceHeuristics();
    if (issues.length > 0) {
      issues.forEach((m) => console.error("  " + m));
      console.error("\n✗ Source heuristics found issues. Fix scripts/dashboard.mjs.");
      process.exit(1);
    }
    console.log("✓ Source heuristics passed (run without --source-only to validate rendered script).");
    process.exit(0);
    return;
  }

  let html;
  try {
    html = await getDashboardHtml();
  } catch (e) {
    console.error("Failed to get dashboard HTML:", e.message);
    console.error("Tip: run with --source-only to skip spawn and only run source checks.");
    process.exit(1);
  }

  const blocks = extractScriptBlocks(html);
  if (blocks.length === 0) {
    console.error("No <script> blocks found in dashboard HTML (length " + html.length + ").");
    process.exit(1);
  }

  let failed = 0;
  for (const { index, content } of blocks) {
    const result = parseScript(content);
    if (!result.ok) {
      failed++;
      const loc = locateSyntaxError(content, index);
      console.error(`\nScript block ${index + 1}: ${result.error.message}`);
      if (loc) {
        if (loc.fullOutput) console.error(`\n${loc.fullOutput}`);
        console.error(`\n${loc.context}`);
        if (loc.message) console.error(`Message: ${loc.message}`);
        console.error("\nSnippet (line numbers = inline script; find same text in dashboard.mjs <script> section):");
        console.error(loc.snippet);
        console.error("");
      } else {
        console.error(result.error.message);
      }
    }
  }

  if (failed > 0) {
    console.error(`\n✗ ${failed} script block(s) have syntax errors. Fix scripts/dashboard.mjs.`);
    process.exit(1);
  }

  console.log(`✓ ${blocks.length} script block(s) parse OK.`);
  process.exit(0);
}

main();
