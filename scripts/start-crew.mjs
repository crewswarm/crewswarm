#!/usr/bin/env node
/**
 * start-crew.mjs — Spawns one gateway-bridge daemon per agent in crewswarm.json
 *
 * Usage:
 *   node scripts/start-crew.mjs          # start all agents
 *   node scripts/start-crew.mjs --stop   # kill all bridge daemons
 *   node scripts/start-crew.mjs --status # show running bridges
 */

import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { BUILT_IN_RT_AGENTS, normalizeRtAgentId } from "../lib/agent-registry.mjs";

const CREWSWARM_DIR = path.resolve(process.env.CREWSWARM_DIR || process.env.OPENCLAW_DIR || process.cwd());
// Config search order (same as gateway-bridge + RT daemon):
// 1. ~/.crewswarm/config.json  (dashboard saves rt.authToken here)
// 2. ~/.crewswarm/crewswarm.json
// 3. ~/.openclaw/openclaw.json
const CREW_CONFIG  = path.join(os.homedir(), ".crewswarm", "config.json");
const CREW_SWARM   = path.join(os.homedir(), ".crewswarm", "crewswarm.json");
const OPENCLAW_CFG = path.join(os.homedir(), ".openclaw", "openclaw.json");
const BRIDGE = path.join(CREWSWARM_DIR, "gateway-bridge.mjs");

function loadConfig() {
  // Load agent list from first available config
  const agentCfgPath = fs.existsSync(CREW_SWARM) ? CREW_SWARM
    : fs.existsSync(OPENCLAW_CFG) ? OPENCLAW_CFG : null;
  const raw = agentCfgPath ? JSON.parse(fs.readFileSync(agentCfgPath, "utf8")) : {};
  const agents = Array.isArray(raw.agents)
    ? raw.agents
    : Array.isArray(raw.agents?.list)
    ? raw.agents.list
    : [];

  // RT token: check all config files in priority order
  let rtToken = "";
  for (const p of [CREW_CONFIG, CREW_SWARM, OPENCLAW_CFG]) {
    if (!fs.existsSync(p)) continue;
    try {
      const c = JSON.parse(fs.readFileSync(p, "utf8"));
      rtToken = c?.rt?.authToken || c?.env?.OPENCREW_RT_AUTH_TOKEN || "";
      if (rtToken) break;
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
  if (agents.size === 0) {
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

if (args.includes("--stop")) {
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
  // Also stop the CrewSwarm-owned opencode serve (port 4097) if running.
  try { execSync("pkill -9 -f 'opencode serve --port 4097'", { stdio: "ignore" }); } catch {}
  // Stop MCP server
  try { execSync("pkill -9 -f 'mcp-server.mjs'", { stdio: "ignore" }); } catch {}
  console.log("✓ Done");
  process.exit(0);
}

if (args.includes("--status")) {
  const running = runningBridges();
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

// Build full agent RT-id list: all from config (canonical), fallback to built-ins if config empty
const allRtIds = new Set();
for (const a of agents) allRtIds.add(getAgentRtId(a.id));
if (allRtIds.size === 0) BUILT_IN_RT_AGENTS.forEach(id => allRtIds.add(id));

const already = runningBridges();

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

if (toStart.includes("crew-lead") && !crewLeadRunning && fs.existsSync(CREW_LEAD_SCRIPT)) {
  const logFile = path.join(os.tmpdir(), "bridge-crew-lead.log");
  const logFd = fs.openSync(logFile, "a");
  const proc = spawn("node", [CREW_LEAD_SCRIPT], {
    cwd: CREWSWARM_DIR,
    stdio: ["ignore", logFd, logFd],
    detached: true,
    env: { ...process.env, OPENCREW_RT_AUTH_TOKEN: rtToken },
  });
  proc.unref();
  console.log(`  ✓ Spawned crew-lead (pid ${proc.pid})`);
}

for (const rtId of toStart.filter(id => id !== "crew-lead")) {
  const env = {
    ...process.env,
    OPENCREW_RT_AGENT: rtId,
    OPENCREW_RT_AUTH_TOKEN: rtToken,
    OPENCREW_RT_CHANNELS: process.env.OPENCREW_RT_CHANNELS || "command,assign,handoff,reassign,events",
    OPENCREW_OPENCODE_ENABLED: process.env.OPENCREW_OPENCODE_ENABLED ?? "1",
    OPENCREW_OPENCODE_MODEL: process.env.OPENCREW_OPENCODE_MODEL || "groq/moonshotai/kimi-k2-instruct-0905",
    OPENCREW_OPENCODE_PROJECT: process.env.OPENCREW_OPENCODE_PROJECT || CREWSWARM_DIR,
    CREWSWARM_DIR,
  };

  const logFile = path.join(os.tmpdir(), `bridge-${rtId}.log`);
  const logFd = fs.openSync(logFile, "a");
  const proc = spawn("node", [BRIDGE, "--rt-daemon"], {
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
  const proc = spawn("node", [SCRIBE_SCRIPT], {
    cwd: CREWSWARM_DIR, stdio: ["ignore", logFd, logFd], detached: true,
    env: { ...process.env, OPENCREW_RT_AUTH_TOKEN: rtToken },
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
  const proc = spawn("node", [MCP_SCRIPT], {
    cwd: CREWSWARM_DIR, stdio: ["ignore", logFd, logFd], detached: true,
    env: { ...process.env, OPENCREW_RT_AUTH_TOKEN: rtToken },
  });
  proc.unref();
  console.log(`  ✓ Spawned mcp-server on :5020 (pid ${proc.pid})`);
}

console.log(`\n✓ Crew started — ${allRtIds.size} agents online`);
console.log(`  Run 'node scripts/start-crew.mjs --status' to verify`);
console.log(`  MCP endpoint: http://127.0.0.1:5020/mcp`);
