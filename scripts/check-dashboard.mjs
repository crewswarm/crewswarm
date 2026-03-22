#!/usr/bin/env node
/**
 * Validates dashboard HTML/inline script and telemetry schema.
 * Run after editing scripts/dashboard.mjs to catch broken template literals.
 *
 *   node scripts/check-dashboard.mjs --source-only
 *   node scripts/check-dashboard.mjs --schema-only
 *   node scripts/check-dashboard.mjs
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const sourceOnly = args.includes("--source-only");
const schemaOnly = args.includes("--schema-only");
const runBoth = !sourceOnly && !schemaOnly;

function pass(label) {
  console.log(`passed: ${label}`);
}

function fail(label, msg) {
  console.error(`failed: ${label}`);
  if (msg) console.error(msg);
  process.exit(1);
}

// ── Source check: dashboard.mjs syntax ────────────────────────────────────────
function checkSource() {
  const dash = path.join(REPO, "scripts", "dashboard.mjs");
  const r = spawnSync("node", ["--check", dash], {
    encoding: "utf8",
    cwd: REPO,
    timeout: 15000,
  });
  if (r.status !== 0) {
    fail("source", r.stderr || r.stdout || "dashboard.mjs syntax error");
  }
  pass("source");
}

// ── Schema check: telemetry schema loads and validates ────────────────────────
async function checkSchema() {
  try {
    const { validateTelemetryEvent, TELEMETRY_SCHEMAS } = await import(
      path.join(REPO, "lib", "runtime", "telemetry-schema.mjs")
    );
    if (!TELEMETRY_SCHEMAS || typeof validateTelemetryEvent !== "function") {
      fail("schema", "telemetry-schema.mjs missing exports");
    }
    // Quick validation: a minimal task.lifecycle event
    const sample = {
      schemaVersion: "1.0",
      eventType: "task.lifecycle",
      eventId: "ev-check",
      occurredAt: new Date().toISOString(),
      correlationId: "corr-check",
      source: { component: "check-dashboard" },
      data: {
        taskId: "t-check",
        agentId: "crew-coder",
        taskType: "code",
        phase: "completed",
        phaseOrdinal: 4,
      },
    };
    const { ok, errors } = validateTelemetryEvent(sample);
    if (!ok) {
      fail("schema", errors?.join("; ") || "sample event failed validation");
    }
    pass("schema");
  } catch (e) {
    fail("schema", e.message);
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────
(async () => {
  if (sourceOnly || runBoth) checkSource();
  if (schemaOnly || runBoth) await checkSchema();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
