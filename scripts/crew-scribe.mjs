#!/usr/bin/env node
/**
 * crew-scribe — Memory maintenance daemon
 *
 * Watches done.jsonl for completed tasks, then:
 *   1. Appends a one-line summary to memory/session-log.md
 *   2. If the reply contains a notable discovery (@@BRAIN tag), appends to memory/brain.md
 *
 * Agents can write durable learnings by including in their reply:
 *   @@BRAIN: <one-line fact to remember>
 *
 * Usage:
 *   node scripts/crew-scribe.mjs
 *   node scripts/crew-scribe.mjs --once   (process backlog and exit)
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const MEMORY_DIR    = path.resolve(process.cwd(), "memory");
const BRAIN_MD      = path.join(MEMORY_DIR, "brain.md");
const SESSION_LOG   = path.join(MEMORY_DIR, "session-log.md");
const RT_BASE       = path.join(os.homedir(), ".openclaw", "workspace", "shared-memory", "claw-swarm", "opencrew-rt");
const DONE_LOG      = path.join(RT_BASE, "channels", "done.jsonl");
const STATE_FILE    = path.join(os.homedir(), ".crewswarm", "scribe-state.json");
const POLL_MS       = 4000;
const ONCE_MODE     = process.argv.includes("--once");

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return { bytesRead: 0 }; }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function appendToFile(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, text, "utf8");
}

function now() {
  return new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

// Extract a short summary from a reply — first non-empty meaningful line
function extractSummary(reply, maxChars = 120) {
  if (!reply) return "(no reply)";
  const lines = reply
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("---") && !l.startsWith("##") && !l.startsWith("*") && l.length > 10);
  const first = lines[0] || reply.trim();
  return first.length > maxChars ? first.slice(0, maxChars) + "…" : first;
}

// Extract @@BRAIN entries from a reply
function extractBrainEntries(agentId, reply) {
  if (!reply) return [];
  const matches = [...reply.matchAll(/@@BRAIN:\s*(.+)/gi)];
  return matches.map(m => `\n## [${now().slice(0, 10)}] ${agentId}: ${m[1].trim()}`);
}

// ── Main processing loop ──────────────────────────────────────────────────────

const SKIP_AGENTS = new Set(["crew-lead", "orchestrator"]);

async function processNewEntries(state) {
  if (!fs.existsSync(DONE_LOG)) return state;

  const stat = fs.statSync(DONE_LOG);
  if (stat.size <= state.bytesRead) return state;

  const fd = fs.openSync(DONE_LOG, "r");
  const buf = Buffer.alloc(stat.size - state.bytesRead);
  fs.readSync(fd, buf, 0, buf.length, state.bytesRead);
  fs.closeSync(fd);

  const newState = { ...state, bytesRead: stat.size };
  const lines = buf.toString("utf8").split("\n").filter(Boolean);

  let sessionEntries = [];
  let brainEntries = [];

  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    const from = obj.from || obj.sender_agent_id || "";
    const reply = (obj.payload?.reply || "").trim();
    const ts = obj.ts ? obj.ts.slice(0, 16).replace("T", " ") : now().slice(0, 16);
    const taskId = obj.taskId || obj.id || "?";

    if (!from || SKIP_AGENTS.has(from) || !reply) continue;

    // Session log: one-line entry
    const summary = extractSummary(reply);
    sessionEntries.push(`\n## ${ts} UTC | ${from} | ${taskId}\n- Result: ${summary}`);

    // Brain: @@BRAIN entries
    brainEntries.push(...extractBrainEntries(from, reply));
  }

  if (sessionEntries.length > 0) {
    appendToFile(SESSION_LOG, sessionEntries.join("\n"));
    console.log(`[crew-scribe] Wrote ${sessionEntries.length} session-log entries`);
  }

  if (brainEntries.length > 0) {
    appendToFile(BRAIN_MD, brainEntries.join("\n") + "\n");
    console.log(`[crew-scribe] Wrote ${brainEntries.length} brain.md entries`);
  }

  return newState;
}

// ── Startup ───────────────────────────────────────────────────────────────────

console.log("[crew-scribe] Starting — watching", DONE_LOG);
console.log("[crew-scribe] Memory dir:", MEMORY_DIR);

let state = loadState();

if (ONCE_MODE) {
  state = await processNewEntries(state);
  saveState(state);
  console.log("[crew-scribe] --once done");
  process.exit(0);
}

// Poll loop
async function tick() {
  try {
    state = await processNewEntries(state);
    saveState(state);
  } catch (err) {
    console.error("[crew-scribe] Error:", err.message);
  }
  setTimeout(tick, POLL_MS);
}

tick();
process.on("SIGINT", () => { saveState(state); process.exit(0); });
process.on("SIGTERM", () => { saveState(state); process.exit(0); });
