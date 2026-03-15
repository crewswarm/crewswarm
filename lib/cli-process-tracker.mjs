/**
 * CLI Process Tracker — Monitor active CLI processes to prevent premature kills
 * 
 * Tracks:
 * - Active CLI processes (PID, agent, start time, last activity)
 * - stdout/stderr activity (to detect hung processes)
 * - Process status (running, idle, done, failed)
 * 
 * Used by:
 * - Telegram/WhatsApp bridges (to show "⚡ Working..." status)
 * - Dashboard (to show active CLI processes per agent)
 * - Gateway (to prevent killing active work)
 */

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CLI_PROCESS_LOG = join(homedir(), ".crewswarm", "logs", "cli-processes.jsonl");
const CLI_PROCESS_STATE = join(homedir(), ".crewswarm", "cli-process-state.json");

mkdirSync(join(homedir(), ".crewswarm", "logs"), { recursive: true });

// Active processes: { processId: { pid, agent, cli, task, startTime, lastActivity, status, chatId, sessionId } }
let activeProcesses = new Map();

// Load persisted state on startup
export function initCLIProcessTracker() {
  try {
    if (existsSync(CLI_PROCESS_STATE)) {
      const state = JSON.parse(readFileSync(CLI_PROCESS_STATE, "utf8"));
      activeProcesses = new Map(Object.entries(state.processes || {}));
      
      // Clean up stale processes (started > 1hr ago, not running)
      const now = Date.now();
      for (const [id, proc] of activeProcesses) {
        if (now - proc.startTime > 3600000 && proc.status !== "running") {
          activeProcesses.delete(id);
        }
      }
      saveState();
    }
  } catch (e) {
    console.error("[cli-tracker] Failed to load state:", e.message);
  }
}

function saveState() {
  try {
    const state = {
      processes: Object.fromEntries(activeProcesses),
      lastUpdate: new Date().toISOString()
    };
    writeFileSync(CLI_PROCESS_STATE, JSON.stringify(state, null, 2));
  } catch {}
}

function log(level, msg, data = {}) {
  const entry = { ts: new Date().toISOString(), level, msg, ...data };
  try { appendFileSync(CLI_PROCESS_LOG, JSON.stringify(entry) + "\n"); } catch {}
}

/**
 * Register a new CLI process
 * @param {string} processId - Unique ID (e.g. "telegram-123456-opencode")
 * @param {object} info - { pid, agent, cli, task, chatId, sessionId }
 * @returns {string} processId
 */
export function registerCLIProcess(processId, info) {
  const now = Date.now();
  activeProcesses.set(processId, {
    ...info,
    startTime: now,
    lastActivity: now,
    status: "running",
    outputLines: 0
  });
  saveState();
  log("info", "CLI process registered", { processId, ...info });
  return processId;
}

/**
 * Update process activity (called when stdout/stderr receives data)
 * @param {string} processId
 * @param {string} output - Recent output chunk
 */
export function updateCLIActivity(processId, output) {
  const proc = activeProcesses.get(processId);
  if (!proc) return;
  
  proc.lastActivity = Date.now();
  proc.outputLines = (proc.outputLines || 0) + (output.match(/\n/g) || []).length;
  
  // Detect status from output patterns
  if (output.includes("Executing") || output.includes("Running")) {
    proc.status = "running";
  } else if (output.includes("Waiting") || output.includes("Idle")) {
    proc.status = "idle";
  }
  
  saveState();
}

/**
 * Mark process as completed
 * @param {string} processId
 * @param {object} result - { exitCode, duration, error }
 */
export function completeCLIProcess(processId, result) {
  const proc = activeProcesses.get(processId);
  if (!proc) return;
  
  proc.status = result.exitCode === 0 ? "done" : "failed";
  proc.endTime = Date.now();
  proc.duration = proc.endTime - proc.startTime;
  proc.exitCode = result.exitCode;
  if (result.error) proc.error = result.error;
  
  saveState();
  log("info", "CLI process completed", { processId, ...result });
  
  // Remove from active list after 30s (keep recent history visible)
  setTimeout(() => {
    activeProcesses.delete(processId);
    saveState();
  }, 30000);
}

/**
 * Check if a process is currently active (has recent activity)
 * @param {string} processId
 * @param {number} idleThresholdMs - Consider idle if no activity for this long (default 5min)
 * @returns {boolean}
 */
export function isProcessActive(processId, idleThresholdMs = 300000) {
  const proc = activeProcesses.get(processId);
  if (!proc) return false;
  if (proc.status === "done" || proc.status === "failed") return false;
  
  const idleFor = Date.now() - proc.lastActivity;
  return idleFor < idleThresholdMs;
}

/**
 * Get all active processes
 * @returns {Array} [{ processId, pid, agent, cli, status, duration, idleFor }]
 */
export function getActiveProcesses() {
  const now = Date.now();
  return Array.from(activeProcesses.entries()).map(([id, proc]) => ({
    processId: id,
    pid: proc.pid,
    agent: proc.agent,
    cli: proc.cli,
    task: proc.task?.slice(0, 100),
    status: proc.status,
    startTime: proc.startTime,
    duration: now - proc.startTime,
    idleFor: now - proc.lastActivity,
    outputLines: proc.outputLines,
    chatId: proc.chatId,
    sessionId: proc.sessionId
  }));
}

/**
 * Get processes for a specific agent
 * @param {string} agentId
 * @returns {Array}
 */
export function getAgentProcesses(agentId) {
  return getActiveProcesses().filter(p => p.agent === agentId);
}

/**
 * Kill a process if it's truly stuck (no activity for > threshold)
 * @param {string} processId
 * @param {number} forceThresholdMs - Kill if idle for this long (default 10min)
 * @returns {boolean} true if killed
 */
export function killStuckProcess(processId, forceThresholdMs = 600000) {
  const proc = activeProcesses.get(processId);
  if (!proc) return false;
  
  const idleFor = Date.now() - proc.lastActivity;
  if (idleFor < forceThresholdMs) {
    log("warn", "Refused to kill active process", { processId, idleFor });
    return false;
  }
  
  try {
    process.kill(proc.pid, "SIGTERM");
    log("info", "Killed stuck process", { processId, pid: proc.pid, idleFor });
    completeCLIProcess(processId, { exitCode: -1, error: "Killed (stuck)" });
    return true;
  } catch (e) {
    log("error", "Failed to kill process", { processId, error: e.message });
    return false;
  }
}

/**
 * Get status for a specific session (for bridges to show "⚡ Working..." messages)
 * @param {string} sessionId - e.g. "telegram-123456" or "whatsapp-13109050857@s.whatsapp.net"
 * @returns {object|null} { cli, agent, duration, idleFor, status } or null
 */
export function getSessionCLIStatus(sessionId) {
  for (const [id, proc] of activeProcesses) {
    if (proc.sessionId === sessionId && (proc.status === "running" || proc.status === "idle")) {
      const now = Date.now();
      return {
        processId: id,
        cli: proc.cli,
        agent: proc.agent,
        task: proc.task?.slice(0, 80),
        duration: now - proc.startTime,
        idleFor: now - proc.lastActivity,
        status: proc.status,
        outputLines: proc.outputLines
      };
    }
  }
  return null;
}

// Initialize on module load
initCLIProcessTracker();
