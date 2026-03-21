#!/usr/bin/env node
/**
 * start-crew.mjs — Spawns one gateway-bridge daemon per agent in crewswarm.json
 *
 * Usage:
 *   node scripts/start-crew.mjs          # start all agents (skips if already running)
 *   node scripts/start-crew.mjs --force  # kill all + restart (safe restart)
 *   node scripts/start-crew.mjs --stop   # kill all bridge daemons
 *   node scripts/start-crew.mjs --status # show running bridges
 */

import { spawn, execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { BUILT_IN_RT_AGENTS, normalizeRtAgentId, validateRequiredAgents, REQUIRED_AGENTS } from "../lib/agent-registry.mjs";
import { loadSystemConfig, loadSwarmConfig, loadAgentList as loadAgentListFromConfig } from "../lib/runtime/config.mjs";

const CREWSWARM_DIR = path.resolve(process.env.CREWSWARM_DIR || process.env.OPENCLAW_DIR || process.cwd());
const OPENCLAW_CFG = path.join(os.homedir(), ".openclaw", "openclaw.json");
const BRIDGE = path.join(CREWSWARM_DIR, "gateway-bridge.mjs");
const RESOLVE_NODE_BIN = path.join(CREWSWARM_DIR, "scripts", "resolve-node-bin.sh");

function resolveNodeBin() {
  if (process.env.NODE && fs.existsSync(process.env.NODE)) return process.env.NODE;
  if (fs.existsSync(RESOLVE_NODE_BIN)) {
    try {
      const resolved = execFileSync(RESOLVE_NODE_BIN, { encoding: "utf8" }).trim();
      if (resolved) return resolved;
    } catch {}
  }
  return process.execPath;
}

const NODE_BIN = resolveNodeBin();

function loadConfig() {
  const raw = loadSwarmConfig();
  const agents = loadAgentListFromConfig();

  // RT token: check system config first, then swarm config
  const sys = loadSystemConfig();
  let rtToken = sys?.rt?.authToken || sys?.env?.CREWSWARM_RT_AUTH_TOKEN
    || raw?.rt?.authToken || raw?.env?.CREWSWARM_RT_AUTH_TOKEN || "";

  // Legacy fallback
  if (!rtToken) {
    try {
      const legacy = JSON.parse(fs.readFileSync(OPENCLAW_CFG, "utf8"));
      rtToken = legacy?.rt?.authToken || legacy?.env?.CREWSWARM_RT_AUTH_TOKEN || "";
    } catch {}
  }

  return { raw, rtToken, agents };
}


function getAgentRtId(agentId) {
  return normalizeRtAgentId(agentId);
}

const PID_DIR = os.tmpdir();

function bridgePidFile(agentId) {
  return path.join(PID_DIR, `bridge-${agentId}.pid`);
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function runningBridges() {
  const agents = new Set();
  // Primary: check PID files (reliable on macOS where ps doesn't show env vars)
  try {
    const files = fs.readdirSync(PID_DIR).filter(f => f.startsWith("bridge-") && f.endsWith(".pid"));
    for (const f of files) {
      const agentId = f.replace(/^bridge-/, "").replace(/\.pid$/, "");
      try {
        const pid = parseInt(fs.readFileSync(path.join(PID_DIR, f), "utf8").trim(), 10);
        if (pid && isProcessAlive(pid)) {
          agents.add(agentId);
        } else {
          fs.unlinkSync(path.join(PID_DIR, f)); // stale PID file
        }
      } catch { /* unreadable, skip */ }
    }
  } catch { /* PID_DIR unreadable, fall through */ }
  // Fallback: pgrep-based detection (fast, no ps aux hang risk)
  const allowPgrepFallback = process.env.CREWSWARM_DISABLE_PGREP_FALLBACK !== "1";
  if (agents.size === 0 && allowPgrepFallback) {
    try {
      const pids = execSync("pgrep -f 'gateway-bridge.mjs --rt-daemon'", { encoding: "utf8", timeout: 2000 }).trim();
      if (pids) {
        // pids found but we can't recover agent names without env — mark as "unknown"
        // so we don't try to re-spawn. Caller will see size > 0 and skip.
        for (const pid of pids.split("\n").filter(Boolean)) agents.add(`pid-${pid.trim()}`);
      }
    } catch { /* no matches or pgrep unavailable */ }
  }
  return agents;
}

const args = process.argv.slice(2);
const forceRestart = args.includes("--force");

if (args.includes("--stop") || forceRestart) {
  console.log("Stopping all bridge daemons…");
  // Kill by PID files first (precise), then sweep with pkill
  try {
    const pidFiles = fs.readdirSync(PID_DIR).filter(f => f.startsWith("bridge-") && f.endsWith(".pid"));
    for (const f of pidFiles) {
      try {
        const pid = parseInt(fs.readFileSync(path.join(PID_DIR, f), "utf8").trim(), 10);
        if (pid) try { process.kill(pid, 9); } catch { /* already dead */ }
        fs.unlinkSync(path.join(PID_DIR, f));
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  try { execSync("pkill -9 -f 'gateway-bridge.mjs --rt-daemon'", { stdio: "ignore" }); } catch {}
  // Also stop the crewswarm-owned opencode serve (port 4097) if running.
  try { execSync("pkill -9 -f 'opencode serve --port 4097'", { stdio: "ignore" }); } catch {}
  // Stop MCP server
  try { execSync("pkill -9 -f 'mcp-server.mjs'", { stdio: "ignore" }); } catch {}
  console.log("✓ Done");
  if (args.includes("--stop")) process.exit(0);
  // If --force, continue to restart after cleanup
  console.log("Restarting...\n");
}

if (args.includes("--status")) {
  let rtStatus = null;
  try {
    const raw = execSync("curl -sf -m 1 http://127.0.0.1:18889/status", {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    rtStatus = raw ? JSON.parse(raw) : null;
  } catch {}
  const running = runningBridges();
  if (rtStatus?.running) {
    console.log(`RT bus: up (18889) — ${rtStatus.clients || 0} clients`);
  } else {
    console.log("RT bus: down (18889)");
  }
  if (!running.size) { console.log("No bridge daemons running."); process.exit(0); }
  console.log(`Running bridge daemons (${running.size}):`);
  for (const a of [...running].sort()) console.log(`  ✓ ${a}`);
  process.exit(0);
}

// ── --agent <id> — spawn only a specific agent ──────────────────────────────
const agentFlagIdx = args.indexOf("--agent");
const singleAgentId = agentFlagIdx !== -1 ? args[agentFlagIdx + 1] : null;

// ── Start ────────────────────────────────────────────────────────────────────
const { raw, rtToken, agents } = loadConfig();

// Validate required agents
const validation = validateRequiredAgents(agents);
if (!validation.valid) {
  console.error(`\n❌ FATAL: Required agents missing from ~/.crewswarm/crewswarm.json:`);
  for (const missing of validation.missing) {
    console.error(`  - ${missing}`);
  }
  console.error(`\nThese agents are essential for crewswarm to function.`);
  console.error(`Fix: Run the installer to populate the config:\n`);
  console.error(`  bash install.sh\n`);
  console.error(`Or add the missing agents manually to ~/.crewswarm/crewswarm.json\n`);
  process.exit(1);
}

// Build full agent RT-id list: all from config (canonical), fallback to built-ins if config empty
const allRtIds = new Set();
for (const a of agents) allRtIds.add(getAgentRtId(a.id));
if (allRtIds.size === 0) BUILT_IN_RT_AGENTS.forEach(id => allRtIds.add(id));

const already = runningBridges();

// SAFETY CHECK: Use pgrep as authoritative source to detect duplicate bridges
let actualRunning = 0;
try {
  const pids = execSync("pgrep -f 'gateway-bridge.mjs --rt-daemon'", { encoding: "utf8", timeout: 2000 }).trim();
  actualRunning = pids ? pids.split("\n").filter(Boolean).length : 0;
} catch { /* no matches */ }

// If pgrep shows more processes than our PID tracking, we have orphaned/duplicate bridges
if (actualRunning > already.size && actualRunning > allRtIds.size) {
  console.error(`\n⚠️  DUPLICATE BRIDGE PROCESSES DETECTED!`);
  console.error(`   PID tracking shows: ${already.size} agents`);
  console.error(`   pgrep found: ${actualRunning} gateway-bridge processes`);
  console.error(`   Expected: ${allRtIds.size} agents`);
  console.error(`\n   This usually means you ran start-crew.mjs multiple times without cleanup.`);
  console.error(`   Run this to fix:\n`);
  console.error(`   node scripts/start-crew.mjs --stop && node scripts/start-crew.mjs\n`);
  console.error(`   Or use: npm run restart-all (safer - kills everything first)\n`);
  process.exit(1);
}

// If --agent was given, only start that specific agent (even if others are missing)
let toStart;
if (singleAgentId) {
  const rtId = getAgentRtId(singleAgentId);
  if (!allRtIds.has(rtId)) {
    console.error(`Agent "${singleAgentId}" (rt: ${rtId}) not found in crewswarm.json`);
    process.exit(1);
  }
  if (already.has(rtId)) {
    console.log(`✓ ${rtId} is already running — use --force to kill and respawn`);
    process.exit(0);
  }
  toStart = [rtId];
} else {
  toStart = [...allRtIds].filter(id => !already.has(id));
}

if (toStart.length === 0) {
  console.log(`✓ All ${allRtIds.size} bridge daemons already running.`);
  for (const id of [...allRtIds].sort()) console.log(`  ${already.has(id) ? "✓" : "✗"} ${id}`);
  process.exit(0);
}

// ── Hard bridge cap (runaway protection) ────────────────────────────────────
const MAX_BRIDGES = parseInt(process.env.CREWSWARM_MAX_BRIDGES || "30", 10);
const totalAfterStart = already.size + toStart.length;
if (totalAfterStart > MAX_BRIDGES) {
  const cap = Math.max(0, MAX_BRIDGES - already.size);
  console.warn(`⚠️  Bridge cap: ${already.size} running + ${toStart.length} requested exceeds max ${MAX_BRIDGES}. Launching ${cap}. Set CREWSWARM_MAX_BRIDGES to raise limit.`);
  toStart = toStart.slice(0, cap);
  if (toStart.length === 0) {
    console.warn(`⚠️  No new bridges started — cap reached. Stop some agents first or raise CREWSWARM_MAX_BRIDGES.`);
    process.exit(0);
  }
}

console.log(`Starting crew bridges…`);
console.log(`  Already running : ${already.size} (${[...already].join(", ") || "none"})`);
console.log(`  Launching new   : ${toStart.length} (${toStart.join(", ")})`);
console.log();

// crew-lead runs its own script, not gateway-bridge
const CREW_LEAD_SCRIPT = path.join(CREWSWARM_DIR, "crew-lead.mjs");
const crewLeadRunning = (() => {
  try {
    execSync("pgrep -f 'crew-lead.mjs'", { encoding: "utf8", timeout: 2000, stdio: "pipe" });
    return true;
  } catch { return false; }
})();

// Skip crew-lead if SKIP_CREW_LEAD env var is set (dashboard manages crew-lead separately)
const shouldSkipCrewLead = process.env.SKIP_CREW_LEAD === "1";

if (toStart.includes("crew-lead") && !crewLeadRunning && !shouldSkipCrewLead && fs.existsSync(CREW_LEAD_SCRIPT)) {
  const logFile = path.join(os.tmpdir(), "bridge-crew-lead.log");
  const logFd = fs.openSync(logFile, "a");
  const proc = spawn(NODE_BIN, [CREW_LEAD_SCRIPT], {
    cwd: CREWSWARM_DIR,
    stdio: ["ignore", logFd, logFd],
    detached: true,
    env: { ...process.env, ...(raw.env || {}), CREWSWARM_RT_AUTH_TOKEN: rtToken },
  });
  proc.unref();
  console.log(`  ✓ Spawned crew-lead (pid ${proc.pid})`);
}

for (const rtId of toStart.filter(id => id !== "crew-lead")) {
  const env = {
    ...process.env,
    ...(raw.env || {}),  // ← ADD env vars from config
    CREWSWARM_RT_AGENT: rtId,
    CREWSWARM_RT_AUTH_TOKEN: rtToken,
    CREWSWARM_RT_CHANNELS: process.env.CREWSWARM_RT_CHANNELS || "command,assign,handoff,reassign,events",
    CREWSWARM_OPENCODE_MODEL: process.env.CREWSWARM_OPENCODE_MODEL || "groq/moonshotai/kimi-k2-instruct-0905",
    CREWSWARM_OPENCODE_PROJECT: process.env.CREWSWARM_OPENCODE_PROJECT || CREWSWARM_DIR,
    CREWSWARM_DIR,
  };

  const logFile = path.join(os.tmpdir(), `bridge-${rtId}.log`);
  const logFd = fs.openSync(logFile, "a");
  const proc = spawn(NODE_BIN, [BRIDGE, "--rt-daemon"], {
    cwd: CREWSWARM_DIR,
    stdio: ["ignore", logFd, logFd],
    detached: true,
    env,
  });
  proc.unref();
  // Write PID file so runningBridges() can reliably detect this process on macOS
  try { fs.writeFileSync(bridgePidFile(rtId), String(proc.pid)); } catch { /* best-effort */ }
  console.log(`  ✓ Spawned ${rtId} (pid ${proc.pid})`);
}

// crew-scribe — memory maintenance daemon (watches done.jsonl, writes brain.md + session-log.md)
const SCRIBE_SCRIPT = path.join(CREWSWARM_DIR, "scripts", "crew-scribe.mjs");
const scribeRunning = (() => {
  try { execSync("pgrep -f 'crew-scribe.mjs'", { encoding: "utf8", timeout: 2000, stdio: "pipe" }); return true; } catch { return false; }
})();
if (!scribeRunning && fs.existsSync(SCRIBE_SCRIPT)) {
  const logFd = fs.openSync(path.join(os.tmpdir(), "crew-scribe.log"), "a");
  const proc = spawn(NODE_BIN, [SCRIBE_SCRIPT], {
    cwd: CREWSWARM_DIR, stdio: ["ignore", logFd, logFd], detached: true,
    env: { ...process.env, CREWSWARM_RT_AUTH_TOKEN: rtToken },
  });
  proc.unref();
  console.log(`  ✓ Spawned crew-scribe (pid ${proc.pid})`);
}

// mcp-server — MCP endpoint for Cursor / Claude Code / OpenCode
const MCP_SCRIPT = path.join(CREWSWARM_DIR, "scripts", "mcp-server.mjs");
const mcpRunning = (() => {
  try { execSync("pgrep -f 'mcp-server.mjs'", { encoding: "utf8", timeout: 2000, stdio: "pipe" }); return true; } catch { return false; }
})();
if (!mcpRunning && fs.existsSync(MCP_SCRIPT)) {
  const logFd = fs.openSync(path.join(os.tmpdir(), "crewswarm-mcp.log"), "a");
  const proc = spawn(NODE_BIN, [MCP_SCRIPT], {
    cwd: CREWSWARM_DIR, stdio: ["ignore", logFd, logFd], detached: true,
    env: { ...process.env, CREWSWARM_RT_AUTH_TOKEN: rtToken },
  });
  proc.unref();
  console.log(`  ✓ Spawned mcp-server on :5020 (pid ${proc.pid})`);
}

console.log(`\n✓ Crew started — ${allRtIds.size} agents online`);
console.log(`  Run 'node scripts/start-crew.mjs --status' to verify`);
console.log(`  MCP endpoint: http://127.0.0.1:5020/mcp`);
