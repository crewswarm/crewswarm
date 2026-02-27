/**
 * Task lease + deduplication system — extracted from gateway-bridge.mjs
 * File-based leases prevent duplicate task execution across multiple agent instances.
 *
 * Inject: initTaskLease({ telemetry, sleep, parseJsonSafe })
 */

import fs     from "fs";
import path   from "path";
import os     from "os";
import crypto from "crypto";

const SHARED_MEMORY_BASE      = process.env.SHARED_MEMORY_DIR      || path.join(os.homedir(), ".crewswarm", "workspace", "shared-memory");
const SHARED_MEMORY_NAMESPACE = process.env.SHARED_MEMORY_NAMESPACE || "claw-swarm";
const SWARM_RUNTIME_DIR       = path.join(SHARED_MEMORY_BASE, SHARED_MEMORY_NAMESPACE, "opencrew-rt", "runtime");
const SWARM_TASK_LEASE_DIR    = path.join(SWARM_RUNTIME_DIR, "task-leases");
const SWARM_TASK_STATE_DIR    = path.join(SWARM_RUNTIME_DIR, "task-state");
const SWARM_DLQ_DIR           = path.join(SHARED_MEMORY_BASE, SHARED_MEMORY_NAMESPACE, "opencrew-rt", "dlq");

const CREWSWARM_RT_DISPATCH_LEASE_MS      = Number(process.env.CREWSWARM_RT_DISPATCH_LEASE_MS      || "45000");
const CREWSWARM_RT_DISPATCH_HEARTBEAT_MS  = Number(process.env.CREWSWARM_RT_DISPATCH_HEARTBEAT_MS  || "10000");
const CREWSWARM_RT_TASK_STATE_TTL_MS      = Number(process.env.CREWSWARM_RT_TASK_STATE_TTL_MS      || "21600000");
const CREWSWARM_RT_AGENT                  = process.env.CREWSWARM_RT_AGENT                         || process.env.OPENCREW_RT_AGENT || "crew-coder";

let _telemetry     = () => {};
let _sleep         = (ms) => new Promise(r => setTimeout(r, ms));
let _parseJsonSafe = (s, def) => { try { return JSON.parse(s); } catch { return def; } };

export function initTaskLease({ telemetry, sleep, parseJsonSafe } = {}) {
  if (telemetry)     _telemetry     = telemetry;
  if (sleep)         _sleep         = sleep;
  if (parseJsonSafe) _parseJsonSafe = parseJsonSafe;
}

export function ensureSwarmRuntimeDirs() {
  fs.mkdirSync(SWARM_RUNTIME_DIR, { recursive: true });
  fs.mkdirSync(SWARM_TASK_LEASE_DIR, { recursive: true });
  fs.mkdirSync(SWARM_TASK_STATE_DIR, { recursive: true });
  fs.mkdirSync(SWARM_DLQ_DIR, { recursive: true });
}

export function parseTaskState(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return _parseJsonSafe(raw, null);
  } catch {
    return null;
  }
}

export function taskIdentity({ envelope, payload, incomingType, prompt }) {
  const explicit = String(payload?.idempotencyKey || payload?.idempotency_key || payload?.dedupeKey || "").trim();
  if (explicit) return explicit;
  const taskId = String(envelope?.taskId || "").trim();
  if (taskId) return `${incomingType}:${taskId}`;
  const envelopeId = String(envelope?.id || "").trim();
  if (envelopeId) return `${incomingType}:${envelopeId}`;
  const base = JSON.stringify({
    incomingType,
    from: envelope?.from || "unknown",
    prompt: String(prompt || "").slice(0, 2000),
  });
  return `hash:${crypto.createHash("sha256").update(base).digest("hex")}`;
}

export function taskKeyFor(identity) {
  return crypto.createHash("sha256").update(String(identity)).digest("hex");
}

export function leasePath(taskKey) {
  return path.join(SWARM_TASK_LEASE_DIR, `${taskKey}.json`);
}

export function taskStatePath(taskKey) {
  return path.join(SWARM_TASK_STATE_DIR, `${taskKey}.json`);
}

export function lockPath(taskKey) {
  return path.join(SWARM_TASK_LEASE_DIR, `${taskKey}.lock`);
}

export async function withTaskLock(taskKey, fn) {
  ensureSwarmRuntimeDirs();
  const file = lockPath(taskKey);
  const deadline = Date.now() + Math.max(200, CREWSWARM_RT_DISPATCH_HEARTBEAT_MS);
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(file, "wx");
      try {
        return await fn();
      } finally {
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(file); } catch {}
      }
    } catch (err) {
      lastErr = err;
      if (err?.code !== "EEXIST") throw err;
      await _sleep(40);
    }
  }
  throw new Error(`task lock timeout for ${taskKey}: ${lastErr?.message || "unknown"}`);
}

export function clearStaleTaskState() {
  try {
    ensureSwarmRuntimeDirs();
    const now = Date.now();
    for (const fileName of fs.readdirSync(SWARM_TASK_STATE_DIR)) {
      if (!fileName.endsWith(".json")) continue;
      const fullPath = path.join(SWARM_TASK_STATE_DIR, fileName);
      const row = parseTaskState(fullPath);
      if (!row) continue;
      const ts = Date.parse(String(row.completedAt || row.updatedAt || ""));
      if (!Number.isFinite(ts)) continue;
      if (now - ts > CREWSWARM_RT_TASK_STATE_TTL_MS) {
        try { fs.unlinkSync(fullPath); } catch {}
      }
    }
  } catch {}
}

export async function claimTaskLease({ taskKey, identity, incomingType, envelope, payload }) {
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  return withTaskLock(taskKey, async () => {
    clearStaleTaskState();
    const stateFile = taskStatePath(taskKey);
    const existingState = parseTaskState(stateFile);
    if (existingState?.status === "done") {
      return {
        status: "already_done",
        owner: existingState.owner || "unknown",
      };
    }

    const leaseFile = leasePath(taskKey);
    const existingLease = parseTaskState(leaseFile) || {};
    const leaseExpiresAtMs = Date.parse(String(existingLease.leaseExpiresAt || ""));
    const leaseActive = Number.isFinite(leaseExpiresAtMs) && leaseExpiresAtMs > nowMs;
    if (leaseActive && existingLease.owner && existingLease.owner !== CREWSWARM_RT_AGENT) {
      return {
        status: "claimed_by_other",
        owner: existingLease.owner,
        leaseExpiresAt: existingLease.leaseExpiresAt,
      };
    }

    const previousAttempts = Number(existingLease.attempt || payload?.retryCount || 0);
    const attempt = leaseActive && existingLease.owner === CREWSWARM_RT_AGENT
      ? Math.max(1, previousAttempts)
      : previousAttempts + 1;

    const leaseRecord = {
      taskKey,
      identity,
      incomingType,
      owner: CREWSWARM_RT_AGENT,
      source: envelope?.from || "unknown",
      attempt,
      taskId: envelope?.taskId || "",
      messageId: envelope?.id || "",
      claimedAt: nowIso,
      heartbeatAt: nowIso,
      leaseExpiresAt: new Date(nowMs + CREWSWARM_RT_DISPATCH_LEASE_MS).toISOString(),
    };
    fs.writeFileSync(leaseFile, `${JSON.stringify(leaseRecord, null, 2)}\n`, "utf8");
    _telemetry("realtime_task_claimed", {
      taskKey,
      identity,
      attempt,
      incomingType,
      owner: CREWSWARM_RT_AGENT,
    });
    return {
      status: "claimed",
      attempt,
      lease: leaseRecord,
    };
  });
}

export function startTaskLeaseHeartbeat(taskKey) {
  return setInterval(async () => {
    try {
      await withTaskLock(taskKey, async () => {
        const leaseFile = leasePath(taskKey);
        const existingLease = parseTaskState(leaseFile);
        if (!existingLease || existingLease.owner !== CREWSWARM_RT_AGENT) return;
        const nowMs = Date.now();
        existingLease.heartbeatAt = new Date(nowMs).toISOString();
        existingLease.leaseExpiresAt = new Date(nowMs + CREWSWARM_RT_DISPATCH_LEASE_MS).toISOString();
        fs.writeFileSync(leaseFile, `${JSON.stringify(existingLease, null, 2)}\n`, "utf8");
      });
    } catch (err) {
      _telemetry("realtime_task_heartbeat_error", { taskKey, message: err?.message ?? String(err) });
    }
  }, Math.max(1000, CREWSWARM_RT_DISPATCH_HEARTBEAT_MS));
}

export async function finalizeTaskState({ taskKey, identity, status, attempt, error = "", note = "" }) {
  const completedAt = new Date().toISOString();
  await withTaskLock(taskKey, async () => {
    const stateFile = taskStatePath(taskKey);
    const leaseFile = leasePath(taskKey);
    const state = {
      taskKey,
      identity,
      status,
      owner: CREWSWARM_RT_AGENT,
      attempt,
      error,
      note,
      completedAt,
      updatedAt: completedAt,
    };
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    try { fs.unlinkSync(leaseFile); } catch {}
  });
}

export async function releaseRuntimeTaskLease(taskKey) {
  await withTaskLock(taskKey, async () => {
    const leaseFile = leasePath(taskKey);
    const lease = parseTaskState(leaseFile);
    if (!lease || lease.owner !== CREWSWARM_RT_AGENT) return;
    lease.leaseExpiresAt = new Date(Date.now() - 1).toISOString();
    lease.releasedAt = new Date().toISOString();
    fs.writeFileSync(leaseFile, `${JSON.stringify(lease, null, 2)}\n`, "utf8");
  });
}

export { SWARM_RUNTIME_DIR, SWARM_TASK_LEASE_DIR, SWARM_TASK_STATE_DIR, SWARM_DLQ_DIR };
