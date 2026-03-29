/**
 * Session Manager — persistent tmux sessions as first-class execution resources
 *
 * Manages session lifecycle: create, attach, exec, lock, handoff, terminate.
 * One writer per session (lock enforcement). Transcripts logged for auditability.
 *
 * Sessions are stored as metadata files under ~/.crewswarm/state/sessions/.
 * The actual tmux sessions are managed via tmux CLI.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getStatePath } from "../runtime/paths.mjs";
import * as tmuxBridge from "../bridges/tmux-bridge.mjs";

const SESSION_DIR = getStatePath("sessions");
const TRANSCRIPT_DIR = getStatePath("sessions", "transcripts");

try { fs.mkdirSync(SESSION_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true }); } catch {}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sessionMetaPath(sessionId) {
  return path.join(SESSION_DIR, `${sessionId}.json`);
}

function transcriptPath(sessionId) {
  return path.join(TRANSCRIPT_DIR, `${sessionId}.jsonl`);
}

function loadMeta(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(sessionMetaPath(sessionId), "utf8"));
  } catch {
    return null;
  }
}

function saveMeta(sessionId, meta) {
  try {
    fs.writeFileSync(sessionMetaPath(sessionId), JSON.stringify(meta, null, 2));
  } catch (e) {
    console.error(`[session-manager] Failed to save meta for ${sessionId}: ${e.message}`);
  }
}

function appendTranscript(sessionId, entry) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    fs.appendFileSync(transcriptPath(sessionId), line + "\n");
  } catch {}
}

function tmuxExec(cmd, timeout = 5000) {
  try {
    return execSync(cmd, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a new persistent tmux session for agent work.
 * @param {object} opts
 * @param {string} opts.workspaceId - Logical workspace name
 * @param {string} opts.agentId - Owning agent
 * @param {string} [opts.cwd] - Working directory
 * @param {Record<string, string>} [opts.env] - Extra env vars
 * @returns {string|null} sessionId or null on failure
 */
export function create({ workspaceId, agentId, cwd, env } = {}) {
  if (!tmuxBridge.detect()) return null;

  const sessionId = `cs-${workspaceId}-${randomUUID().slice(0, 8)}`;
  const sessionName = sessionId;

  // Create a new tmux session (detached)
  const envStr = env
    ? Object.entries(env).map(([k, v]) => `-e ${k}=${v}`).join(" ")
    : "";
  const cwdFlag = cwd ? `-c "${cwd}"` : "";
  const result = tmuxExec(`tmux new-session -d -s "${sessionName}" ${cwdFlag} ${envStr}`);
  if (result === null) {
    console.error(`[session-manager] Failed to create tmux session: ${sessionName}`);
    return null;
  }

  // Label the session's first pane with the agent ID
  const paneId = tmuxExec(`tmux list-panes -t "${sessionName}" -F "#{pane_id}" | head -1`);
  if (paneId) {
    tmuxBridge.label(agentId, paneId);
  }

  const meta = {
    sessionId,
    sessionName,
    workspaceId,
    owner: agentId,
    lockedBy: agentId,
    paneId: paneId || null,
    cwd: cwd || null,
    env: env || null,
    createdAt: new Date().toISOString(),
    status: "active",
  };
  saveMeta(sessionId, meta);
  appendTranscript(sessionId, { action: "created", agent: agentId, cwd });

  console.log(`[session-manager] Created session ${sessionId} for ${agentId} (pane=${paneId})`);
  return sessionId;
}

/**
 * Attach an agent to an existing session (for handoff or observation).
 * @param {string} sessionId
 * @param {string} agentId
 * @returns {{ paneId: string, sessionName: string }|null}
 */
export function attach(sessionId, agentId) {
  const meta = loadMeta(sessionId);
  if (!meta || meta.status !== "active") return null;

  appendTranscript(sessionId, { action: "attached", agent: agentId });
  console.log(`[session-manager] ${agentId} attached to session ${sessionId}`);

  return { paneId: meta.paneId, sessionName: meta.sessionName };
}

/**
 * Execute a command in a session's tmux pane.
 * Only the lock owner can execute.
 * @param {string} sessionId
 * @param {string} command
 * @param {object} [opts]
 * @param {string} opts.actorId - Agent executing the command
 * @param {number} [opts.timeout=30000] - Timeout in ms
 * @returns {{ output: string }|null}
 */
export function exec(sessionId, command, { actorId, timeout = 30000 } = {}) {
  const meta = loadMeta(sessionId);
  if (!meta || meta.status !== "active") return null;

  // Enforce lock
  if (meta.lockedBy && meta.lockedBy !== actorId) {
    console.warn(`[session-manager] ${actorId} cannot exec in ${sessionId} — locked by ${meta.lockedBy}`);
    return null;
  }

  const paneId = meta.paneId;
  if (!paneId) return null;

  // Send keys to the pane
  tmuxExec(`tmux send-keys -t "${paneId}" "${command.replace(/"/g, '\\"')}" Enter`, timeout);
  appendTranscript(sessionId, { action: "exec", agent: actorId, command: command.slice(0, 500) });

  // Read back output after a short delay
  const output = tmuxBridge.read(meta.owner, 50);
  return { output: output || "" };
}

/**
 * Lock a session for exclusive write access.
 * @param {string} sessionId
 * @param {string} ownerId - Agent requesting the lock
 * @returns {boolean} true if lock acquired
 */
export function lock(sessionId, ownerId) {
  const meta = loadMeta(sessionId);
  if (!meta || meta.status !== "active") return false;

  if (meta.lockedBy && meta.lockedBy !== ownerId) {
    console.warn(`[session-manager] Lock denied for ${ownerId} on ${sessionId} — held by ${meta.lockedBy}`);
    return false;
  }

  meta.lockedBy = ownerId;
  meta.lockedAt = new Date().toISOString();
  saveMeta(sessionId, meta);
  appendTranscript(sessionId, { action: "locked", agent: ownerId });
  return true;
}

/**
 * Unlock a session.
 * @param {string} sessionId
 * @param {string} ownerId - Must match current lock holder
 * @returns {boolean}
 */
export function unlock(sessionId, ownerId) {
  const meta = loadMeta(sessionId);
  if (!meta) return false;

  if (meta.lockedBy && meta.lockedBy !== ownerId) {
    console.warn(`[session-manager] Unlock denied for ${ownerId} on ${sessionId} — held by ${meta.lockedBy}`);
    return false;
  }

  meta.lockedBy = null;
  meta.lockedAt = null;
  saveMeta(sessionId, meta);
  appendTranscript(sessionId, { action: "unlocked", agent: ownerId });
  return true;
}

/**
 * Hand off a session from one agent to another.
 * Transfers lock ownership and re-labels the pane.
 * @param {string} sessionId
 * @param {string} fromAgent
 * @param {string} toAgent
 * @returns {boolean}
 */
export function handoff(sessionId, fromAgent, toAgent) {
  const meta = loadMeta(sessionId);
  if (!meta || meta.status !== "active") return false;

  // Only the current lock holder (or unlocked session) can hand off
  if (meta.lockedBy && meta.lockedBy !== fromAgent) {
    console.warn(`[session-manager] Handoff denied: ${sessionId} locked by ${meta.lockedBy}, not ${fromAgent}`);
    return false;
  }

  meta.owner = toAgent;
  meta.lockedBy = toAgent;
  meta.lockedAt = new Date().toISOString();
  saveMeta(sessionId, meta);

  // Re-label pane for the new agent
  if (meta.paneId) {
    tmuxBridge.label(toAgent, meta.paneId);
  }

  appendTranscript(sessionId, { action: "handoff", from: fromAgent, to: toAgent });
  console.log(`[session-manager] Session ${sessionId} handed off: ${fromAgent} → ${toAgent}`);
  return true;
}

/**
 * Terminate a session and clean up its tmux pane.
 * @param {string} sessionId
 * @returns {boolean}
 */
export function terminate(sessionId) {
  const meta = loadMeta(sessionId);
  if (!meta) return false;

  // Kill the tmux session
  if (meta.sessionName) {
    tmuxExec(`tmux kill-session -t "${meta.sessionName}"`);
  }

  meta.status = "terminated";
  meta.terminatedAt = new Date().toISOString();
  saveMeta(sessionId, meta);
  appendTranscript(sessionId, { action: "terminated" });
  console.log(`[session-manager] Session ${sessionId} terminated`);
  return true;
}

/**
 * Get metadata for a session.
 * @param {string} sessionId
 * @returns {object|null}
 */
export function getSession(sessionId) {
  return loadMeta(sessionId);
}

/**
 * List all active sessions.
 * @returns {Array<object>}
 */
export function listSessions() {
  try {
    const files = fs.readdirSync(SESSION_DIR).filter(f => f.endsWith(".json"));
    return files
      .map(f => loadMeta(f.replace(".json", "")))
      .filter(m => m && m.status === "active");
  } catch {
    return [];
  }
}
