#!/usr/bin/env node
/**
 * scripts/check-telemetry.mjs
 *
 * Validates sample telemetry payloads against docs/OPS-TELEMETRY-SCHEMA.md.
 * Ensures crew-lead (and future producers) emit events that the dashboard can consume.
 *
 *   node scripts/check-telemetry.mjs
 *
 * Exit 0 = all samples pass, 1 = validation failed.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const SCHEMA_VERSION = "1.1";
const REQUIRED_ENVELOPE = ["schemaVersion", "eventType", "eventId", "occurredAt", "source", "correlationId", "data"];
const REQUIRED_SOURCE = ["component"];
const TASK_LIFECYCLE_DATA = ["taskId", "agentId", "taskType", "phase", "phaseOrdinal"];
const VALID_PHASES = ["dispatched", "accepted", "started", "needs_approval", "approved", "rejected", "awaiting_input", "completed", "failed", "escalated", "cancelled"];

function checkEnvelope(ev) {
  const errs = [];
  for (const key of REQUIRED_ENVELOPE) {
    if (ev[key] === undefined || ev[key] === null) errs.push("missing envelope." + key);
  }
  if (ev.source && typeof ev.source === "object") {
    for (const key of REQUIRED_SOURCE) {
      if (ev.source[key] === undefined) errs.push("missing source." + key);
    }
  } else if (ev.source === undefined) {
    errs.push("missing source");
  }
  if (ev.schemaVersion && ev.schemaVersion !== SCHEMA_VERSION) {
    const [major] = String(ev.schemaVersion).split(".");
    const [expectedMajor] = SCHEMA_VERSION.split(".");
    if (parseInt(major, 10) > parseInt(expectedMajor, 10)) errs.push("schemaVersion major " + major + " > supported " + expectedMajor);
  }
  return errs;
}

function checkTaskLifecycleData(data) {
  const errs = [];
  for (const key of TASK_LIFECYCLE_DATA) {
    if (data[key] === undefined) errs.push("task.lifecycle data missing: " + key);
  }
  if (data.phase && !VALID_PHASES.includes(data.phase)) {
    errs.push("task.lifecycle invalid phase: " + data.phase);
  }
  return errs;
}

// Sample payloads that crew-lead should emit (mirror of actual emission)
const samples = [
  {
    schemaVersion: "1.1",
    eventType: "task.lifecycle",
    eventId: "evt_1700000000000_abc123",
    occurredAt: new Date().toISOString(),
    source: { component: "crew-lead" },
    correlationId: "task:task_xyz",
    data: {
      taskId: "task_xyz",
      agentId: "crew-coder",
      taskType: "task",
      phase: "dispatched",
      phaseOrdinal: 1,
    },
  },
  {
    schemaVersion: "1.1",
    eventType: "task.lifecycle",
    eventId: "evt_1700000001000_def456",
    occurredAt: new Date().toISOString(),
    source: { component: "crew-lead" },
    correlationId: "task:task_xyz",
    data: {
      taskId: "task_xyz",
      agentId: "crew-coder",
      taskType: "task",
      phase: "completed",
      phaseOrdinal: 2,
      durationMs: 5000,
      result: { summary: "Wrote src/auth.ts" },
    },
  },
  {
    schemaVersion: "1.1",
    eventType: "task.lifecycle",
    eventId: "evt_1700000002000_ghi789",
    occurredAt: new Date().toISOString(),
    source: { component: "crew-lead" },
    correlationId: "task:task_abc",
    data: {
      taskId: "task_abc",
      agentId: "crew-pm",
      taskType: "task",
      phase: "cancelled",
      phaseOrdinal: 1,
      error: { code: "DISPATCH_TIMEOUT", message: "No reply within 90s" },
    },
  },
];

let failed = 0;
for (let i = 0; i < samples.length; i++) {
  const ev = samples[i];
  const envelopeErrs = checkEnvelope(ev);
  const dataErrs = ev.eventType === "task.lifecycle" && ev.data ? checkTaskLifecycleData(ev.data) : [];
  const all = [...envelopeErrs, ...dataErrs];
  if (all.length) {
    console.error("Sample " + (i + 1) + " failed: " + all.join("; "));
    failed++;
  } else {
    console.log("  ✓ Sample " + (i + 1) + " (" + (ev.data?.phase || "") + ")");
  }
}

if (failed) {
  console.error("\ncheck-telemetry: " + failed + " sample(s) failed.");
  process.exit(1);
}
console.log("\ncheck-telemetry: all sample payloads conform to schema " + SCHEMA_VERSION + ".");
process.exit(0);
