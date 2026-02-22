#!/usr/bin/env node
/**
 * crew-scribe — Memory maintenance daemon
 *
 * Watches done.jsonl for completed tasks, then:
 *   1. Appends an LLM-generated one-sentence summary to memory/session-log.md
 *   2. @@BRAIN: tags → deduplicated facts to memory/brain.md
 *   3. @@LESSON: tags → deduplicated mistake patterns to memory/lessons.md
 *
 * Agent tag syntax:
 *   @@BRAIN: <one-line durable project fact>
 *   @@LESSON: <what broke, why, and how to avoid it>
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
const LESSONS_MD    = path.join(MEMORY_DIR, "lessons.md");
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

// ── LLM config (fastest available provider) ───────────────────────────────────

function loadLLMConfig() {
  try {
    const csPath = path.join(os.homedir(), ".crewswarm", "crewswarm.json");
    const ocPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    const cfgRaw = fs.existsSync(csPath) ? fs.readFileSync(csPath, "utf8") : fs.readFileSync(ocPath, "utf8");
    const cfg = JSON.parse(cfgRaw);
    // crewswarm.json uses cfg.providers; legacy openclaw.json uses cfg.models.providers
    const providers = cfg?.providers || cfg?.models?.providers || {};
    // Priority: fastest small models first
    const FAST_MODELS = {
      cerebras: "llama-3.3-70b",
      groq:     "llama-3.1-8b-instant",
      openai:   "gpt-4o-mini",
      mistral:  "mistral-small-latest",
      anthropic: "claude-3-haiku-20240307",
    };
    for (const [key, model] of Object.entries(FAST_MODELS)) {
      const p = providers[key];
      if (p?.apiKey && (p?.baseUrl || key === "openai")) {
        const baseUrl = p.baseUrl || "https://api.openai.com/v1";
        return { apiKey: p.apiKey, baseUrl, model, provider: key };
      }
    }
  } catch {}
  return null;
}

// ── LLM-powered summary (falls back to heuristic) ────────────────────────────

async function summarizeWithLLM(agentId, reply) {
  const llm = loadLLMConfig();
  if (!llm) return extractSummaryHeuristic(reply);

  try {
    const trimmed = reply
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/@@BRAIN:.*$/gim, "")
      .replace(/@@LESSON:.*$/gim, "")
      .trim()
      .slice(0, 3000);

    const isAnthropic = llm.provider === "anthropic";
    const headers = { "content-type": "application/json" };
    if (isAnthropic) {
      headers["x-api-key"] = llm.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers["authorization"] = `Bearer ${llm.apiKey}`;
    }

    const res = await fetch(`${llm.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: llm.model,
        messages: [
          {
            role: "system",
            content: "You summarize agent task results in one short sentence. Be specific — mention filenames, commands, or key outcomes. No preamble. Max 120 chars.",
          },
          {
            role: "user",
            content: `Agent: ${agentId}\n\nResult:\n${trimmed}`,
          },
        ],
        max_tokens: 80,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return extractSummaryHeuristic(reply);
    const data = await res.json();
    const summary = data?.choices?.[0]?.message?.content?.trim();
    return summary || extractSummaryHeuristic(reply);
  } catch {
    return extractSummaryHeuristic(reply);
  }
}

// Fallback: first non-empty meaningful line
function extractSummaryHeuristic(reply, maxChars = 120) {
  if (!reply) return "(no reply)";
  const lines = reply
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("---") && !l.startsWith("##") && !l.startsWith("*") && l.length > 10);
  const first = lines[0] || reply.trim();
  return first.length > maxChars ? first.slice(0, maxChars) + "…" : first;
}

// ── Brain dedup ───────────────────────────────────────────────────────────────

function normalize(s) {
  return s.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}

function isBrainDuplicate(fact) {
  try {
    const existing = fs.readFileSync(BRAIN_MD, "utf8");
    const normFact = normalize(fact);
    // Extract meaningful words (length > 3) as the fingerprint
    const factWords = normFact.split(" ").filter(w => w.length > 3);
    if (factWords.length < 3) return false;
    const threshold = Math.ceil(factWords.length * 0.70);
    return existing.split("\n").some(line => {
      const normLine = normalize(line);
      const hits = factWords.filter(w => normLine.includes(w)).length;
      return hits >= threshold;
    });
  } catch {
    return false; // brain.md doesn't exist yet → nothing is a duplicate
  }
}

// Extract @@BRAIN entries from a reply, skip duplicates
function extractBrainEntries(agentId, reply) {
  if (!reply) return [];
  const matches = [...reply.matchAll(/@@BRAIN:\s*(.+)/gi)];
  const results = [];
  for (const m of matches) {
    const fact = m[1].trim();
    if (isBrainDuplicate(fact)) {
      console.log(`[crew-scribe] Skipping duplicate brain entry: ${fact.slice(0, 60)}`);
      continue;
    }
    results.push(`\n## [${now().slice(0, 10)}] ${agentId}: ${fact}`);
  }
  return results;
}

// ── Lessons extraction ────────────────────────────────────────────────────────

function isLessonDuplicate(lesson) {
  try {
    const existing = fs.readFileSync(LESSONS_MD, "utf8");
    const normLesson = normalize(lesson);
    const lessonWords = normLesson.split(" ").filter(w => w.length > 3);
    if (lessonWords.length < 3) return false;
    const threshold = Math.ceil(lessonWords.length * 0.75);
    return existing.split("\n").some(line => {
      const normLine = normalize(line);
      const hits = lessonWords.filter(w => normLine.includes(w)).length;
      return hits >= threshold;
    });
  } catch {
    return false;
  }
}

// Extract @@LESSON: tags from a reply, deduplicate, return formatted entries
function extractLessonEntries(agentId, reply) {
  if (!reply) return [];
  const matches = [...reply.matchAll(/@@LESSON:\s*(.+)/gi)];
  const results = [];
  for (const m of matches) {
    const lesson = m[1].trim();
    if (isLessonDuplicate(lesson)) {
      console.log(`[crew-scribe] Skipping duplicate lesson: ${lesson.slice(0, 60)}`);
      continue;
    }
    results.push(`\n- [${now().slice(0, 10)}] **${agentId}**: ${lesson}`);
  }
  return results;
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

  const sessionEntries = [];
  const brainEntries   = [];
  const lessonEntries  = [];

  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    const from   = obj.from || obj.sender_agent_id || "";
    const reply  = (obj.payload?.reply || "").trim();
    const ts     = obj.ts ? obj.ts.slice(0, 16).replace("T", " ") : now().slice(0, 16);
    const taskId = obj.taskId || obj.id || "?";

    if (!from || SKIP_AGENTS.has(from) || !reply) continue;

    // LLM-generated one-sentence summary
    const summary = await summarizeWithLLM(from, reply);
    sessionEntries.push(`\n## ${ts} UTC | ${from} | ${taskId}\n- ${summary}`);

    // Deduplicated @@BRAIN entries
    brainEntries.push(...extractBrainEntries(from, reply));

    // Deduplicated @@LESSON entries
    lessonEntries.push(...extractLessonEntries(from, reply));
  }

  if (sessionEntries.length > 0) {
    appendToFile(SESSION_LOG, sessionEntries.join("\n"));
    console.log(`[crew-scribe] Wrote ${sessionEntries.length} session-log entries`);
  }

  if (brainEntries.length > 0) {
    appendToFile(BRAIN_MD, brainEntries.join("\n") + "\n");
    console.log(`[crew-scribe] Wrote ${brainEntries.length} brain.md entries (deduped)`);
  }

  if (lessonEntries.length > 0) {
    // Bootstrap lessons.md header on first write
    if (!fs.existsSync(LESSONS_MD)) {
      appendToFile(LESSONS_MD, "# Crew Lessons\n\nMistake patterns captured automatically. crew-fixer reads this before every fix.\n");
    }
    appendToFile(LESSONS_MD, lessonEntries.join("\n") + "\n");
    console.log(`[crew-scribe] Wrote ${lessonEntries.length} lessons.md entries (deduped)`);
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
