#!/usr/bin/env node
/**
 * Test zeroeval.benchmark skill — proves it's a simple HTTP fetch, no eval queue.
 * Run with: node scripts/test-zeroeval-skill.mjs
 * Requires: crew-lead running on 5010, or we'll test the ZeroEval API directly.
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const SKILL_URL = "https://api.zeroeval.com/leaderboard/benchmarks";
const CREW_LEAD = "http://127.0.0.1:5010";

async function testDirect() {
  console.log("→ Direct ZeroEval API (no crew-lead):");
  const r = await fetch(`${SKILL_URL}/swe-bench-verified`);
  const data = await r.json();
  console.log(`  Status: ${r.status}`);
  console.log(`  benchmark_id: ${data.benchmark_id}`);
  console.log(`  name: ${data.name}`);
  console.log(`  total_models: ${data.statistics?.total_models ?? "N/A"}`);
  console.log("  ✓ Read-only leaderboard fetch works. No eval queue, no run_id.");
}

async function testViaCrewLead() {
  let token = "";
  const cfgPath = join(process.env.HOME || "", ".crewswarm", "config.json");
  if (existsSync(cfgPath)) {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    token = cfg?.rt?.authToken || "";
  }
  if (!token) {
    console.log("\n→ Crew-lead skill test: skipped (no ~/.crewswarm/config.json rt.authToken)");
    return;
  }
  console.log("\n→ Crew-lead POST /api/skills/zeroeval.benchmark/run:");
  try {
    const r = await fetch(`${CREW_LEAD}/api/skills/zeroeval.benchmark/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ params: { benchmark_id: "swe-bench-verified" } }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await r.json();
    if (data.ok && data.result) {
      console.log(`  Status: ${r.status}`);
      console.log(`  benchmark_id: ${data.result.benchmark_id}`);
      console.log(`  name: ${data.result.name}`);
      console.log("  ✓ Crew-lead skill execution works. Gateway not involved for crew-lead.");
    } else {
      console.log(`  Response: ${JSON.stringify(data)}`);
    }
  } catch (e) {
    console.log(`  Error: ${e.message}`);
    console.log("  (Is crew-lead running? node crew-lead.mjs)");
  }
}

testDirect().then(testViaCrewLead);
