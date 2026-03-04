#!/usr/bin/env node
/**
 * Prompt Performance Analyzer (Dashboard API version)
 * 
 * Fetches live telemetry from crew-lead's in-memory store
 * Analyzes which prompts work well and which need improvement
 */

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

const CREW_LEAD_URL = process.env.CREW_LEAD_URL || "http://127.0.0.1:5010";

// Get auth token
let authToken = "";
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(homedir(), ".crewswarm", "config.json"), "utf8"));
  authToken = cfg.rt?.authToken || "";
} catch {}

async function main() {
  console.log("📊 Fetching telemetry from crew-lead...\n");
  
  try {
    const headers = authToken ? { authorization: `Bearer ${authToken}` } : {};
    const res = await fetch(`${CREW_LEAD_URL}/api/telemetry`, {
      headers,
      signal: AbortSignal.timeout(5000)
    });
    
    if (!res.ok) {
      console.error(`❌ API error: ${res.status}`);
      process.exit(1);
    }
    
    const { events } = await res.json();
    
    if (!events || !events.length) {
      console.log("No telemetry data yet. Run some tasks first!");
      process.exit(0);
    }
    
    console.log(`📈 Analyzing ${events.length} events...\n`);
    
    // Aggregate by agent
    const stats = {};
    
    for (const evt of events) {
      const agent = evt.data?.agentId || "unknown";
      const phase = evt.data?.phase;
      const duration = evt.data?.durationMs || 0;
      const error = evt.data?.error;
      
      if (!stats[agent]) {
        stats[agent] = { total: 0, success: 0, failed: 0, durations: [] };
      }
      
      if (phase === "completed") {
        stats[agent].total++;
        if (error) {
          stats[agent].failed++;
        } else {
          stats[agent].success++;
        }
        if (duration > 0) stats[agent].durations.push(duration);
      }
    }
    
    // Calculate metrics
    const results = Object.entries(stats)
      .map(([agent, s]) => {
        const avg = s.durations.length ? s.durations.reduce((a,b) => a+b, 0) / s.durations.length : 0;
        const max = s.durations.length ? Math.max(...s.durations) : 0;
        return {
          agent,
          total: s.total,
          successRate: s.total ? (s.success / s.total * 100).toFixed(1) : 0,
          failureRate: s.total ? (s.failed / s.total * 100).toFixed(1) : 0,
          avgDuration: Math.round(avg),
          maxDuration: Math.round(max)
        };
      })
      .filter(r => r.total > 0)
      .sort((a, b) => b.total - a.total);
    
    // Display
    console.log("🎯 AGENT PERFORMANCE\n");
    console.log("=".repeat(80) + "\n");
    
    for (const r of results) {
      console.log(`${r.agent}:`);
      console.log(`  ${r.total} tasks | ${r.successRate}% success | ${r.failureRate}% fail`);
      console.log(`  Avg: ${r.avgDuration}ms | Max: ${r.maxDuration}ms`);
      
      // Recommendations
      if (parseFloat(r.failureRate) > 30) {
        console.log(`  ⚠️  HIGH FAILURES - Add error examples to prompt`);
      }
      if (r.avgDuration > 120000) {
        console.log(`  🐌 SLOW - Break tasks smaller or add @@READ_FILE first reminder`);
      }
      if (parseFloat(r.successRate) > 90 && r.total > 3) {
        console.log(`  ✅ Prompt working well!`);
      }
      console.log();
    }
    
    console.log("=".repeat(80));
    console.log("\n💡 To improve prompts, edit: ~/.crewswarm/agent-prompts.json\n");
    
  } catch (e) {
    console.error("Error:", e.message);
    process.exit(1);
  }
}

main();
