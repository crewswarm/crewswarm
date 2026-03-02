/**
 * Conversation history persistence — extracted from crew-lead.mjs
 * JSONL per-session history stored in ~/.crewswarm/chat-history/
 * Supports hermetic testing via CREWSWARM_TEST_MODE env var.
 * NOW WITH USER ISOLATION: each user gets their own directory
 */

import fs   from "fs";
import path from "path";
import { getStatePath } from "../runtime/paths.mjs";

const MAX_HISTORY = 2000;

function getHistoryDir() {
  const dir = getStatePath("chat-history");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeId(id) {
  return String(id).replace(/[^a-z0-9_.-]/gi, "_").slice(0, 80) || "default";
}

/**
 * Get session file path with user isolation
 * Format: chat-history/{userId}/{sessionId}.jsonl
 */
export function sessionFile(userId = "default", sessionId = "default") {
  const userDir = path.join(getHistoryDir(), sanitizeId(userId));
  fs.mkdirSync(userDir, { recursive: true });
  return path.join(userDir, `${sanitizeId(sessionId)}.jsonl`);
}

/**
 * Load history for a user's session
 */
export function loadHistory(userId = "default", sessionId = "default") {
  const file = sessionFile(userId, sessionId);
  const history = [];
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { history.push(JSON.parse(line)); } catch {}
    }
  }
  return history.slice(-MAX_HISTORY);
}

/**
 * Append message to a user's session history
 */
export function appendHistory(userId = "default", sessionId = "default", role, content) {
  fs.appendFileSync(sessionFile(userId, sessionId), JSON.stringify({ role, content, ts: Date.now() }) + "\n");
}

/**
 * Clear a user's session history
 */
export function clearHistory(userId = "default", sessionId = "default") {
  const file = sessionFile(userId, sessionId);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

/**
 * List all sessions for a user
 */
export function listUserSessions(userId = "default") {
  const userDir = path.join(getHistoryDir(), sanitizeId(userId));
  if (!fs.existsSync(userDir)) return [];
  try {
    return fs.readdirSync(userDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace('.jsonl', ''));
  } catch {
    return [];
  }
}
