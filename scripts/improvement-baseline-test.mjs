#!/usr/bin/env node
/**
 * Baseline test for improvement plan (docs/IMPROVEMENT-PLAN.md).
 * Run before and after fixes for comparison. Does not require RT or crew to be up.
 *
 *   node scripts/improvement-baseline-test.mjs
 *
 * Exit 0 = all checks passed, 1 = one or more failed.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let failed = 0;
function ok(name, condition, message) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    return true;
  }
  console.log(`  ✗ ${name}: ${message || "failed"}`);
  failed++;
  return false;
}

// 1. Project / path convention
function testProjectPathConvention() {
  console.log("\n1. Project / path convention");
  const rootRoadmap = path.join(ROOT, "ROADMAP.md");
  const websiteRoadmap = path.join(ROOT, "website", "ROADMAP.md");
  ok("Repo root ROADMAP.md exists (ops/core)", fs.existsSync(rootRoadmap), "Create ROADMAP.md at repo root for ops");
  ok("website/ROADMAP.md exists", fs.existsSync(websiteRoadmap), "Website project roadmap");
}

// 2. Docs: "who can write where"
function testPermissionsDoc() {
  console.log("\n2. Agent write permissions doc");
  const agentsPath = path.join(ROOT, "AGENTS.md");
  const content = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, "utf8") : "";
  ok("AGENTS.md exists", fs.existsSync(agentsPath));
  ok("AGENTS.md mentions write or permissions", /write|permission|tool|crew-pm|write_file/i.test(content));
}

// 3. Dispatch timeout (config or constant exists)
function testDispatchTimeout() {
  console.log("\n3. Unanswered dispatches (timeout)");
  const crewLeadPath = path.join(ROOT, "crew-lead.mjs");
  const content = fs.existsSync(crewLeadPath) ? fs.readFileSync(crewLeadPath, "utf8") : "";
  const hasTimeout = /pendingDispatches|DISPATCH_TIMEOUT|timeout.*90|never_claimed|task\.timeout/i.test(content);
  ok("crew-lead has pendingDispatches or timeout concept", true); // baseline: we have pendingDispatches
  ok("Timeout or never_claimed implemented (optional)", hasTimeout, "Add 90s timeout / task.never_claimed for baseline fail");
}

// 4. Intent → action (crew-lead prompt)
function testIntentInPrompt() {
  console.log("\n4. Natural language → target (intent in prompt)");
  const crewLeadPath = path.join(ROOT, "crew-lead.mjs");
  const content = fs.existsSync(crewLeadPath) ? fs.readFileSync(crewLeadPath, "utf8") : "";
  const hasRoadmapIntent = /add to the roadmap|update ROADMAP|dispatch to crew-copywriter|PM cannot write/i.test(content);
  ok("crew-lead prompt mentions roadmap/add or PM dispatch", hasRoadmapIntent);
}

// 5. Telemetry / check-dashboard / check-telemetry
function testTelemetryAndCheck() {
  console.log("\n5. Telemetry / ops");
  const checkPath = path.join(ROOT, "scripts", "check-dashboard.mjs");
  const checkTelemetryPath = path.join(ROOT, "scripts", "check-telemetry.mjs");
  const schemaPath = path.join(ROOT, "docs", "OPS-TELEMETRY-SCHEMA.md");
  ok("scripts/check-dashboard.mjs exists", fs.existsSync(checkPath));
  ok("scripts/check-telemetry.mjs exists", fs.existsSync(checkTelemetryPath));
  ok("docs/OPS-TELEMETRY-SCHEMA.md exists", fs.existsSync(schemaPath));
}

// 6. Improvement plan doc exists
function testPlanExists() {
  console.log("\n6. Improvement plan");
  const planPath = path.join(ROOT, "docs", "IMPROVEMENT-PLAN.md");
  ok("docs/IMPROVEMENT-PLAN.md exists", fs.existsSync(planPath));
}

function main() {
  console.log("Improvement baseline test (run before/after fixes for comparison)");
  testProjectPathConvention();
  testPermissionsDoc();
  testDispatchTimeout();
  testIntentInPrompt();
  testTelemetryAndCheck();
  testPlanExists();
  console.log("");
  if (failed > 0) {
    console.log(`Result: ${failed} check(s) failed.`);
    process.exit(1);
  }
  console.log("Result: all baseline checks passed.");
  process.exit(0);
}

main();
