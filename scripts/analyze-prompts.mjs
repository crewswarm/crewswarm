#!/usr/bin/env node
/**
 * Prompt Performance Analyzer
 * 
 * Analyzes telemetry to find:
 * - Which agents timeout most (need clearer prompts)
 * - Which tasks take longest (need better task decomposition)
 * - Which agents fail most (need better error handling in prompts)
 * - Success rate by agent (prompt effectiveness)
 */

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

const LOGS_DIR = path.join(homedir(), ".crewswarm", "logs");

// Aggregate stats per agent
const stats = {};

function processLine(line) {
  try {
    const entry = JSON.parse(line);
    
    // Extract relevant fields
    const agent = entry.agentId || entry.agent || "unknown";
    const duration = entry.durationMs || entry.duration || 0;
    const success = !entry.error && entry.level !== "error";
    const msg = entry.msg || entry.message || "";
    
    // Initialize agent stats
    if (!stats[agent]) {
      stats[agent] = {
        total: 0,
        success: 0,
        failed: 0,
        timeout: 0,
        totalDuration: 0,
        maxDuration: 0,
        errors: []
      };
    }
    
    stats[agent].total++;
    
    if (success) {
      stats[agent].success++;
    } else {
      stats[agent].failed++;
      if (msg.includes("timeout") || msg.includes("SIGTERM")) {
        stats[agent].timeout++;
      }
      stats[agent].errors.push(msg.slice(0, 100));
    }
    
    if (duration > 0) {
      stats[agent].totalDuration += duration;
      stats[agent].maxDuration = Math.max(stats[agent].maxDuration, duration);
    }
  } catch {}
}

// Read all log files
console.log("📊 Analyzing agent performance from logs...\n");

try {
  const files = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith(".jsonl") || f.endsWith(".log"));
  
  for (const file of files) {
    const filePath = path.join(LOGS_DIR, file);
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter(Boolean);
    
    for (const line of lines) {
      processLine(line);
    }
  }
} catch (e) {
  console.error("Error reading logs:", e.message);
  process.exit(1);
}

// Calculate metrics
const results = Object.entries(stats)
  .map(([agent, s]) => ({
    agent,
    total: s.total,
    successRate: (s.success / s.total * 100).toFixed(1),
    failureRate: (s.failed / s.total * 100).toFixed(1),
    timeoutRate: (s.timeout / s.total * 100).toFixed(1),
    avgDuration: s.totalDuration > 0 ? Math.round(s.totalDuration / s.total) : 0,
    maxDuration: s.maxDuration,
    topErrors: [...new Set(s.errors)].slice(0, 3)
  }))
  .filter(r => r.total > 2) // Only show agents with >2 tasks
  .sort((a, b) => b.total - a.total);

// Display results
console.log("🎯 PROMPT OPTIMIZATION TARGETS\n");
console.log("=" . repeat(80));

for (const r of results) {
  console.log(`\n${r.agent.toUpperCase()}`);
  console.log(`  Tasks: ${r.total} | Success: ${r.successRate}% | Failures: ${r.failureRate}% | Timeouts: ${r.timeoutRate}%`);
  console.log(`  Avg duration: ${r.avgDuration}ms | Max: ${r.maxDuration}ms`);
  
  // Flag problem areas
  if (parseFloat(r.timeoutRate) > 10) {
    console.log(`  ⚠️  HIGH TIMEOUT RATE - Prompt too vague or tasks too large`);
  }
  if (parseFloat(r.failureRate) > 20) {
    console.log(`  ⚠️  HIGH FAILURE RATE - Check error handling in prompt`);
  }
  if (r.avgDuration > 120000) {
    console.log(`  ⚠️  SLOW - Break tasks smaller or add @@READ_FILE reminders`);
  }
  
  if (r.topErrors.length) {
    console.log(`  Top errors:`);
    r.topErrors.forEach(e => console.log(`    - ${e}`));
  }
}

console.log("\n" + "=".repeat(80));
console.log("\n💡 RECOMMENDATIONS:\n");

// Generate prompt improvement suggestions
const worstTimeouts = results.filter(r => parseFloat(r.timeoutRate) > 10).sort((a,b) => b.timeoutRate - a.timeoutRate);
if (worstTimeouts.length) {
  console.log("🔴 High timeout agents (prompts need clarity):");
  worstTimeouts.forEach(r => {
    console.log(`   ${r.agent}: ${r.timeoutRate}% timeout - Add task size limits & acceptance criteria to prompt`);
  });
  console.log();
}

const worstFailures = results.filter(r => parseFloat(r.failureRate) > 20).sort((a,b) => b.failureRate - a.failureRate);
if (worstFailures.length) {
  console.log("🔴 High failure agents (prompts need robustness):");
  worstFailures.forEach(r => {
    console.log(`   ${r.agent}: ${r.failureRate}% fail - Add error handling examples to prompt`);
  });
  console.log();
}

const slowest = results.filter(r => r.avgDuration > 60000).sort((a,b) => b.avgDuration - a.avgDuration);
if (slowest.length) {
  console.log("🐌 Slow agents (tasks need decomposition):");
  slowest.forEach(r => {
    console.log(`   ${r.agent}: avg ${Math.round(r.avgDuration/1000)}s - Break tasks into <2min chunks`);
  });
}

console.log("\n✅ Best performers:");
results.filter(r => parseFloat(r.successRate) > 90 && r.total > 5)
  .slice(0, 3)
  .forEach(r => console.log(`   ${r.agent}: ${r.successRate}% success, ${Math.round(r.avgDuration/1000)}s avg`));
