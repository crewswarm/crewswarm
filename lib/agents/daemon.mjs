/**
 * Agent daemon utilities — spawn, PID, heartbeat, resolve spawn targets.
 * Extracted from gateway-bridge.mjs.
 * Dependencies: fs, path, os, spawn from child_process
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { SWARM_RUNTIME_DIR, SWARM_STATUS_LOG, CREWSWARM_RT_CHANNELS } from "../runtime/config.mjs";
import { CREWSWARM_RT_SWARM_AGENTS } from "./registry.mjs";

function agentRuntimeDir() {
  const dir = path.join(SWARM_RUNTIME_DIR, "rt-agents");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function agentPidPath(agent) {
  return path.join(agentRuntimeDir(), `${agent}.pid`);
}

export function agentLogPath(agent) {
  return path.join(agentRuntimeDir(), `${agent}.log`);
}

export function readPid(agent) {
  try {
    return Number(fs.readFileSync(agentPidPath(agent), "utf8").trim());
  } catch {
    return 0;
  }
}

export function isPidAlive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function latestHeartbeatAgeSec(agent) {
  try {
    if (!fs.existsSync(SWARM_STATUS_LOG)) return null;
    const lines = fs.readFileSync(SWARM_STATUS_LOG, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row?.type !== "agent.heartbeat") continue;
      const hbAgent = row?.payload?.agent || row?.from;
      if (hbAgent !== agent) continue;
      const ts = Date.parse(row?.ts || "");
      if (!Number.isFinite(ts)) return null;
      return (Date.now() - ts) / 1000;
    }
    return null;
  } catch {
    return null;
  }
}

export function isAgentDaemonRunning(agent) {
  const SWARM_HEARTBEAT_WINDOW_SEC = Number(process.env.CREWSWARM_RT_HEARTBEAT_WINDOW_SEC || "90");
  const heartbeatAge = latestHeartbeatAgeSec(agent);
  if (heartbeatAge !== null && heartbeatAge <= SWARM_HEARTBEAT_WINDOW_SEC) return true;
  const pid = readPid(agent);
  if (isPidAlive(pid)) return true;
  return false;
}

export function spawnAgentDaemon(agent) {
  if (isAgentDaemonRunning(agent)) {
    return { agent, status: "already_running" };
  }
  const logFile = agentLogPath(agent);
  const out = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [path.join(process.cwd(), "gateway-bridge.mjs"), "--rt-daemon"], {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      CREWSWARM_RT_AGENT: agent,
      CREWSWARM_RT_CHANNELS,
    },
  });
  child.unref();
  fs.writeFileSync(agentPidPath(agent), `${child.pid}`);
  return { agent, status: "started", pid: child.pid, logFile };
}

export function resolveSpawnTargets(payload) {
  const all = [...new Set(CREWSWARM_RT_SWARM_AGENTS)];
  if (Array.isArray(payload?.agents)) {
    const agents = payload.agents.map((a) => String(a).trim()).filter(Boolean);
    return agents.length ? agents : all;
  }
  if (typeof payload?.agent === "string" && payload.agent.trim()) {
    if (payload.agent.trim().toLowerCase() === "all") return all;
    return [payload.agent.trim()];
  }
  if (typeof payload?.target === "string" && payload.target.trim()) {
    if (payload.target.trim().toLowerCase() === "all") return all;
    return [payload.target.trim()];
  }
  return all;
}
