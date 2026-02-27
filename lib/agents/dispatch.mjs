/**
 * Dispatch guard, task lease, and task helpers — extracted from gateway-bridge.mjs.
 * File-based lease and done records for dispatch deduplication.
 * Dependencies: fs, path, crypto
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  SWARM_DISPATCH_DIR,
  CREWSWARM_RT_AGENT,
  CREWSWARM_RT_TASK_STATE_TTL_MS,
  CREWSWARM_RT_DISPATCH_ENABLED,
} from "../runtime/config.mjs";

function transientError(err) {
  const msg = String(err?.message ?? err ?? "").toLowerCase();
  return ["timeout", "timed out", "econnrefused", "ehostunreach", "econnreset", "socket hang up", "websocket is not open", "connection closed", "broken pipe"].some((s) => msg.includes(s));
}

function ensureDispatchDir() {
  fs.mkdirSync(SWARM_DISPATCH_DIR, { recursive: true });
  return SWARM_DISPATCH_DIR;
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isoNow() {
  return new Date().toISOString();
}

export function dispatchKeyForTask({ taskId, incomingType, prompt, idempotencyKey }) {
  const stableTaskId = String(taskId || "").trim();
  if (stableTaskId) return `task-${stableTaskId}`;
  const stableIdempotency = String(idempotencyKey || "").trim();
  if (stableIdempotency) return `idem-${stableIdempotency}`;
  const hash = crypto.createHash("sha256")
    .update(`${incomingType || "event"}\n${prompt || ""}`, "utf8")
    .digest("hex")
    .slice(0, 24);
  return `hash-${hash}`;
}

export function leasePathForKey(key) {
  return path.join(ensureDispatchDir(), `${key}.lease`);
}

export function donePathForKey(key) {
  return path.join(ensureDispatchDir(), `${key}.done.json`);
}

export function readTaskDoneRecord(key) {
  return safeReadJson(donePathForKey(key));
}

export function isDoneRecordFresh(record) {
  if (!record?.doneAt) return false;
  const doneAtMs = Date.parse(record.doneAt);
  if (!Number.isFinite(doneAtMs)) return false;
  return (Date.now() - doneAtMs) <= CREWSWARM_RT_TASK_STATE_TTL_MS;
}

export function readLeaseRecord(leaseDir) {
  return safeReadJson(path.join(leaseDir, "lease.json"));
}

export function writeLeaseRecord(leaseDir, leaseRecord) {
  fs.writeFileSync(path.join(leaseDir, "lease.json"), JSON.stringify(leaseRecord, null, 2));
}

export function acquireTaskLease({ key, source, incomingType, from, leaseMs }) {
  const leaseDir = leasePathForKey(key);
  const donePath = donePathForKey(key);
  const doneRecord = readTaskDoneRecord(key);
  if (doneRecord) {
    if (isDoneRecordFresh(doneRecord)) {
      return { acquired: false, reason: "already_done", doneRecord };
    }
    try {
      fs.rmSync(donePath, { force: true });
    } catch {}
  }

  const now = Date.now();
  const claimId = `${CREWSWARM_RT_AGENT}-${process.pid}-${crypto.randomUUID()}`;
  const leaseRecord = {
    key,
    claimId,
    agent: CREWSWARM_RT_AGENT,
    source,
    from,
    incomingType,
    leaseMs,
    leasedAt: isoNow(),
    leaseExpiresAt: new Date(now + leaseMs).toISOString(),
    updatedAt: isoNow(),
  };

  const writeNewLease = () => {
    fs.mkdirSync(leaseDir);
    writeLeaseRecord(leaseDir, leaseRecord);
    return { acquired: true, claimId, leaseDir };
  };

  try {
    return writeNewLease();
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
  }

  const existing = readLeaseRecord(leaseDir);
  const existingExpiry = Date.parse(existing?.leaseExpiresAt || "");
  if (Number.isFinite(existingExpiry) && existingExpiry > now) {
    return {
      acquired: false,
      reason: "claimed",
      claimedBy: existing?.agent || "unknown",
      leaseExpiresAt: existing?.leaseExpiresAt || null,
    };
  }

  try {
    fs.rmSync(leaseDir, { recursive: true, force: true });
    return writeNewLease();
  } catch {
    return {
      acquired: false,
      reason: "claimed",
      claimedBy: existing?.agent || "unknown",
      leaseExpiresAt: existing?.leaseExpiresAt || null,
    };
  }
}

export function renewTaskLease({ key, claimId, leaseMs }) {
  const leaseDir = leasePathForKey(key);
  const current = readLeaseRecord(leaseDir);
  if (!current || current.claimId !== claimId || current.agent !== CREWSWARM_RT_AGENT) return false;
  const now = Date.now();
  current.updatedAt = isoNow();
  current.leaseMs = leaseMs;
  current.leaseExpiresAt = new Date(now + leaseMs).toISOString();
  writeLeaseRecord(leaseDir, current);
  return true;
}

export function releaseTaskLease({ key, claimId }) {
  const leaseDir = leasePathForKey(key);
  try {
    const current = readLeaseRecord(leaseDir);
    if (!current || current.claimId !== claimId || current.agent !== CREWSWARM_RT_AGENT) return false;
    fs.rmSync(leaseDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function markTaskDone({ key, claimId, taskId, incomingType, from, attempt, idempotencyKey, reply }) {
  const donePath = donePathForKey(key);
  const replyText = String(reply || "");
  const doneRecord = {
    key,
    taskId,
    incomingType,
    from,
    claimId,
    idempotencyKey,
    agent: CREWSWARM_RT_AGENT,
    attempt,
    reply: replyText.slice(0, 24000),
    replyHash: crypto.createHash("sha256").update(replyText, "utf8").digest("hex"),
    doneAt: isoNow(),
  };
  fs.writeFileSync(donePath, JSON.stringify(doneRecord, null, 2));
}

export function shouldUseDispatchGuard(incomingType) {
  if (!CREWSWARM_RT_DISPATCH_ENABLED) return false;
  return incomingType === "command.run_task" || incomingType === "task.assigned" || incomingType === "task.reassigned";
}

export function shouldRetryTaskFailure(err) {
  const msg = String(err?.message ?? err ?? "");
  if (!msg) return false;
  if (msg.includes("MEMORY_PROTOCOL_MISSING") || msg.includes("MEMORY_LOAD_FAILED")) return false;
  if (msg.includes("CODING_ARTIFACT_MISSING")) return true;
  return transientError(err) || msg.toLowerCase().includes("timeout");
}

export function isCodingTask(incomingType, prompt, payload) {
  if (!incomingType) return false;
  const codingTypes = ["command.run_task", "task.assigned", "task.reassigned"];
  if (!codingTypes.includes(incomingType)) return false;

  const action = String(payload?.action || "").toLowerCase();
  if (action === "collect_status" || action === "status" || action === "heartbeat") return false;

  const text = String(prompt || "").toLowerCase();
  if (text.includes("report status") || text.includes("reply with agent id")) return false;
  if (text.includes("busy/idle") || text.includes("active task")) return false;

  const codingKeywords = [
    "implement", "build", "create", "fix", "refactor", "add", "update", "modify",
    "code", "function", "class", "component", "api", "endpoint", "route", "test",
    "bug", "error", "issue", "file", "script", "module", "package"
  ];
  return codingKeywords.some(kw => text.includes(kw));
}

export function looksLikeCodingTask(prompt = "") {
  const p = String(prompt).toLowerCase();
  return [
    "implement", "write code", "refactor", "fix bug", "unit test", "integration test",
    "build", "compile", "typescript", "javascript", "python", "go ", "rust",
    "repo", "pull request", "pr ", "commit", "lint", "migrate",
  ].some((kw) => p.includes(kw));
}
