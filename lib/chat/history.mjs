/**
 * Conversation history persistence — extracted from crew-lead.mjs
 * JSONL per-session history stored in ~/.crewswarm/chat-history/
 */

import fs   from "fs";
import path from "path";
import os   from "os";

const HISTORY_DIR = path.join(os.homedir(), ".crewswarm", "chat-history");
const MAX_HISTORY = 2000;

fs.mkdirSync(HISTORY_DIR, { recursive: true });

export function sessionFile(sessionId) {
  return path.join(HISTORY_DIR, `${sessionId.replace(/[^a-z0-9_-]/gi, "_")}.jsonl`);
}

export function loadHistory(sessionId) {
  const file = sessionFile(sessionId);
  const history = [];
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { history.push(JSON.parse(line)); } catch {}
    }
  }
  return history.slice(-MAX_HISTORY);
}

export function appendHistory(sessionId, role, content) {
  fs.appendFileSync(sessionFile(sessionId), JSON.stringify({ role, content, ts: Date.now() }) + "\n");
}

export function clearHistory(sessionId) {
  const file = sessionFile(sessionId);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
