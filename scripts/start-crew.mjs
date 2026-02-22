#!/usr/bin/env node
/**
 * start-crew.mjs — Spawns one gateway-bridge daemon per agent in openclaw.json
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

const OPENCLAW_DIR = path.resolve(process.env.OPENCLAW_DIR || process.cwd());
// Config search order (same as gateway-bridge + RT daemon):
// 1. ~/.crewswarm/config.json  (dashboard saves rt.authToken here)
// 2. ~/.crewswarm/crewswarm.json
// 3. ~/.openclaw/openclaw.json
const CREW_CONFIG  = path.join(os.homedir(), ".crewswarm", "config.json");
const CREW_SWARM   = path.join(os.homedir(), ".crewswarm", "crewswarm.json");
const OPENCLAW_CFG = path.join(os.homedir(), ".openclaw", "openclaw.json");
const BRIDGE = path.join(OPENCLAW_DIR, "gateway-bridge.mjs");

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

// Built-in agents that always run even if not in config
const BUILT_IN_AGENTS = ["crew-main", "crew-pm", "crew-qa", "crew-fixer", "crew-coder", "crew-coder-2"];

function getAgentRtId(agentId) {
  // If already prefixed or is a known bare name, use as-is
  if (agentId.startsWith("crew-") || agentId === "security") return agentId;
  return "crew-" + agentId;
}

function runningBridges() {
  try {
    const out = execSync("ps aux", { encoding: "utf8" });
    const lines = out.split("\n").filter(l => l.includes("gateway-bridge.mjs --rt-daemon"));
    const agents = new Set();
    for (const line of lines) {
      const m = line.match(/OPENCREW_RT_AGENT=["']?([^\s"']+)/);
      if (m) agents.add(m[1]);
    }
    return agents;
  } catch { return new Set(); }
}

const args = process.argv.slice(2);

if (args.includes("--stop")) {
  console.log("Stopping all bridge daemons…");
  try { execSync("pkill -9 -f 'gateway-bridge.mjs --rt-daemon'", { stdio: "ignore" }); } catch {}
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

// ── Start ────────────────────────────────────────────────────────────────────
const { raw, rtToken, agents } = loadConfig();

// Build full agent RT-id list: built-ins + all from config
const allRtIds = new Set(BUILT_IN_AGENTS);
for (const a of agents) allRtIds.add(getAgentRtId(a.id));

const already = runningBridges();
const toStart = [...allRtIds].filter(id => !already.has(id));

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
const CREW_LEAD_SCRIPT = path.join(OPENCLAW_DIR, "crew-lead.mjs");
const crewLeadRunning = (() => {
  try {
    const out = execSync("ps aux", { encoding: "utf8" });
    return out.includes("crew-lead.mjs");
  } catch { return false; }
})();

if (toStart.includes("crew-lead") && !crewLeadRunning && fs.existsSync(CREW_LEAD_SCRIPT)) {
  const logFile = path.join(os.tmpdir(), "bridge-crew-lead.log");
  const logFd = fs.openSync(logFile, "a");
  const proc = spawn("node", [CREW_LEAD_SCRIPT], {
    cwd: OPENCLAW_DIR,
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
    OPENCREW_RT_CHANNELS: "command,assign,handoff,reassign,events",
    OPENCREW_OPENCODE_ENABLED: "0",
    OPENCLAW_DIR,
  };

  const logFile = path.join(os.tmpdir(), `bridge-${rtId}.log`);
  const logFd = fs.openSync(logFile, "a");
  const proc = spawn("node", [BRIDGE, "--rt-daemon"], {
    cwd: OPENCLAW_DIR,
    stdio: ["ignore", logFd, logFd],
    detached: true,
    env,
  });
  proc.unref();
  console.log(`  ✓ Spawned ${rtId} (pid ${proc.pid})`);
}

// crew-scribe — memory maintenance daemon (watches done.jsonl, writes brain.md + session-log.md)
const SCRIBE_SCRIPT = path.join(OPENCLAW_DIR, "scripts", "crew-scribe.mjs");
const scribeRunning = (() => {
  try { return execSync("ps aux", { encoding: "utf8" }).includes("crew-scribe.mjs"); } catch { return false; }
})();
if (!scribeRunning && fs.existsSync(SCRIBE_SCRIPT)) {
  const logFd = fs.openSync(path.join(os.tmpdir(), "crew-scribe.log"), "a");
  const proc = spawn("node", [SCRIBE_SCRIPT], {
    cwd: OPENCLAW_DIR, stdio: ["ignore", logFd, logFd], detached: true,
    env: { ...process.env, OPENCREW_RT_AUTH_TOKEN: rtToken },
  });
  proc.unref();
  console.log(`  ✓ Spawned crew-scribe (pid ${proc.pid})`);
}

console.log(`\n✓ Crew started — ${allRtIds.size} agents online`);
console.log(`  Run 'node scripts/start-crew.mjs --status' to verify`);
