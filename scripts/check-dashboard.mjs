#!/usr/bin/env node
/**
 * scripts/check-dashboard.mjs
 *
 * Validates that the dashboard HTML and inline script do not have syntax errors
 * or common pitfalls that break the browser (e.g. "Uncaught SyntaxError: Unexpected string").
 * Also optionally validates telemetry event payloads against the canonical schema.
 *
 * Run after editing scripts/dashboard.mjs:
 *   node scripts/check-dashboard.mjs
 *
 * Options:
 *   --source-only       Only run source heuristics (no spawn, no --print-html).
 *   --validate-schema   Also validate telemetry event log against JSON Schema.
 *   --schema-only       Only run telemetry schema validation (skip HTML checks).
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

// ── Telemetry schema validation ───────────────────────────────────────────────

async function runSchemaValidation() {
  const schemaModPath = path.join(ROOT, "lib", "runtime", "telemetry-schema.mjs");
  if (!fs.existsSync(schemaModPath)) {
    console.error("  lib/runtime/telemetry-schema.mjs not found — skipping schema validation.");
    return { ok: true, skipped: true };
  }

  let validateTelemetryEvent, TELEMETRY_SCHEMAS;
  try {
    ({ validateTelemetryEvent, TELEMETRY_SCHEMAS } = await import(schemaModPath));
  } catch (e) {
    console.error("  Failed to import telemetry schema:", e.message);
    return { ok: false };
  }

  // Validate the schema itself can be imported and has expected event types
  const expectedTypes = ["agent.presence", "task.lifecycle", "error"];
  const missingTypes = expectedTypes.filter(t => !TELEMETRY_SCHEMAS[t]);
  if (missingTypes.length > 0) {
    console.error(`  Schema missing event types: ${missingTypes.join(", ")}`);
    return { ok: false };
  }
  console.log(`  Schema loaded — ${Object.keys(TELEMETRY_SCHEMAS).length} event types defined.`);

  // Validate canonical test vectors
  const testVectors = [
    {
      label: "agent.presence (valid)",
      ok: true,
      event: {
        schemaVersion: "1.0", eventType: "agent.presence", eventId: "ev-001",
        occurredAt: "2026-02-27T00:00:00.000Z", correlationId: "corr-001",
        source: { component: "crew-coder", agentId: "crew-coder" },
        data: { status: "online", latencyMs: 12, uptimeSeconds: 300, heartbeatSeq: 1, version: "1.0.0" },
      },
    },
    {
      label: "task.lifecycle (valid)",
      ok: true,
      event: {
        schemaVersion: "1.0", eventType: "task.lifecycle", eventId: "ev-002",
        occurredAt: "2026-02-27T00:00:00.000Z", correlationId: "corr-002",
        source: { component: "crew-lead" },
        data: { taskId: "t-001", agentId: "crew-coder", taskType: "code", phase: "completed", phaseOrdinal: 4 },
      },
    },
    {
      label: "error (valid)",
      ok: true,
      event: {
        schemaVersion: "1.0", eventType: "error", eventId: "ev-003",
        occurredAt: "2026-02-27T00:00:00.000Z", correlationId: "corr-003",
        source: { component: "gateway-bridge" },
        data: { component: "gateway-bridge", severity: "error", errorCode: "ERR_TIMEOUT", message: "Agent timed out" },
      },
    },
    {
      label: "missing required envelope field",
      ok: false,
      event: {
        schemaVersion: "1.0", eventType: "agent.presence", eventId: "ev-004",
        source: { component: "crew-coder" },
        data: { status: "online", latencyMs: 5, uptimeSeconds: 1, heartbeatSeq: 1, version: "1.0.0" },
      },
    },
    {
      label: "invalid status enum",
      ok: false,
      event: {
        schemaVersion: "1.0", eventType: "agent.presence", eventId: "ev-005",
        occurredAt: "2026-02-27T00:00:00.000Z", correlationId: "corr-005",
        source: { component: "crew-coder" },
        data: { status: "sleeping", latencyMs: 5, uptimeSeconds: 1, heartbeatSeq: 1, version: "1.0.0" },
      },
    },
  ];

  let vectorFailed = 0;
  for (const v of testVectors) {
    const result = validateTelemetryEvent(v.event);
    const pass = result.ok === v.ok;
    if (!pass) {
      console.error(`  FAIL test vector "${v.label}": expected ok=${v.ok}, got ok=${result.ok}`);
      if (result.errors.length) console.error("    errors:", result.errors.slice(0, 3).join("; "));
      vectorFailed++;
    }
  }

  if (vectorFailed > 0) {
    console.error(`  ${vectorFailed}/${testVectors.length} schema test vectors failed.`);
    return { ok: false };
  }
  console.log(`  ${testVectors.length}/${testVectors.length} schema test vectors passed.`);

  // Optionally validate live log file
  const logCandidates = [
    path.join(os.homedir(), ".crewswarm", "events.jsonl"),
    path.join(os.homedir(), ".crewswarm", "telemetry.jsonl"),
  ];
  for (const logPath of logCandidates) {
    if (!fs.existsSync(logPath)) continue;
    const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(l => l.trim());
    if (lines.length === 0) continue;
    const sample = lines.slice(-20);
    let logFailed = 0;
    for (const line of sample) {
      let parsed;
      try { parsed = JSON.parse(line); } catch { logFailed++; continue; }
      const result = validateTelemetryEvent(parsed);
      if (!result.ok && !result.errors.some(e => e.includes("unknown type"))) logFailed++;
    }
    const label = path.basename(logPath);
    if (logFailed > 0) {
      console.warn(`  ${label}: ${logFailed}/${sample.length} recent events failed validation (non-blocking).`);
    } else {
      console.log(`  ${label}: ${sample.length} recent events validated OK.`);
    }
  }

  return { ok: true };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const sourceOnly = process.argv.includes("--source-only");
  const schemaOnly = process.argv.includes("--schema-only");
  const validateSchema = process.argv.includes("--validate-schema") || schemaOnly;

  if (schemaOnly) {
    console.log("Validating telemetry schema...");
    const result = await runSchemaValidation();
    if (!result.ok) {
      console.error("\n✗ Telemetry schema validation failed.");
      process.exit(1);
    }
    console.log("\n✓ Telemetry schema validation passed.");
    process.exit(0);
    return;
  }

  console.log("Checking dashboard...");

  if (sourceOnly) {
    const issues = runSourceHeuristics();
    if (issues.length > 0) {
      issues.forEach((m) => console.error("  " + m));
      console.error("\n✗ Source heuristics found issues. Fix scripts/dashboard.mjs.");
      process.exit(1);
    }

    if (validateSchema) {
      console.log("Validating telemetry schema...");
      const result = await runSchemaValidation();
      if (!result.ok) {
        console.error("\n✗ Telemetry schema validation failed.");
        process.exit(1);
      }
      console.log("✓ Telemetry schema validation passed.");
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

  if (validateSchema) {
    console.log("Validating telemetry schema...");
    const schemaResult = await runSchemaValidation();
    if (!schemaResult.ok) {
      console.error("\n✗ Telemetry schema validation failed.");
      process.exit(1);
    }
    console.log("✓ Telemetry schema validation passed.");
  }

  console.log(`✓ ${blocks.length} script block(s) parse OK.`);
  process.exit(0);
}

main();
