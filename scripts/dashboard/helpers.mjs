/**
 * Dashboard helper utilities — JSON parsing, heartbeat tracking, data fetchers.
 * Extracted from dashboard.mjs to reduce file size.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Agent heartbeat liveness tracker ─────────────────────────────────────────
// Updated every 30s from events.jsonl — reflects actual bridge pulse, not just config.

/**
 * Refresh agent heartbeat map from the tail of the RT events log.
 * @param {Map<string,number>} agentHeartbeats - map of agentId → lastSeenMs
 * @param {string} rtEventsLog - path to the events.jsonl file
 */
export function refreshHeartbeats(agentHeartbeats, rtEventsLog) {
  try {
    if (!fs.existsSync(rtEventsLog)) return;
    const stat = fs.statSync(rtEventsLog);
    const readBytes = Math.max(0, stat.size - 65536); // read last ~64 KB
    const fd = fs.openSync(rtEventsLog, "r");
    const buf = Buffer.alloc(stat.size - readBytes);
    fs.readSync(fd, buf, 0, buf.length, readBytes);
    fs.closeSync(fd);
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.includes("agent.heartbeat")) continue;
      try {
        const obj = JSON.parse(line);
        const agentId = obj?.payload?.agent || obj?.from || obj?.sender_agent_id;
        const ts = obj?.ts ? new Date(obj.ts).getTime() : null;
        if (agentId && ts && (!agentHeartbeats.has(agentId) || agentHeartbeats.get(agentId) < ts)) {
          agentHeartbeats.set(agentId, ts);
        }
      } catch {}
    }
  } catch {}
}

/**
 * Proxy a GET request to the opencode server and parse JSON.
 * Returns [] on timeout, connection refused, or HTML responses.
 */
export async function proxyJSON(pathname, { opencodeBase, authHeader }) {
  try {
    const res = await fetch(`${opencodeBase}${pathname}`, {
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const text = await res.text();
    if (text.trim().startsWith("<!doctype") || text.trim().startsWith("<html")) return [];
    return JSON.parse(text);
  } catch (err) {
    if (err.name === "TimeoutError" || err.code === "ECONNREFUSED" || err instanceof SyntaxError) return [];
    throw err;
  }
}

/**
 * Send a message to an agent via openswitchctl.
 */
export async function sendCrewMessage(to, message, ctlPath) {
  const { execSync } = await import("node:child_process");
  return execSync(`"${ctlPath}" send "${to}" "${message.replace(/"/g, '\\"')}"`, {
    encoding: "utf8",
    timeout: 10000,
  });
}

/**
 * Get the list of agents with liveness annotations.
 * @param {object} ctx - { ctlPath, CFG_FILE, agentHeartbeats, normalizeRtAgentId, BUILT_IN_RT_AGENTS }
 */
export async function getAgentList(ctx) {
  const { ctlPath, CFG_FILE, agentHeartbeats, normalizeRtAgentId, BUILT_IN_RT_AGENTS } = ctx;
  const merged = new Set();

  // 1. Live RT bus agents (currently connected)
  try {
    const { execSync } = await import("node:child_process");
    const result = execSync(`"${ctlPath}" agents`, { encoding: "utf8", timeout: 5000 });
    result.trim().split("\n").filter(Boolean).forEach(a => merged.add(a));
  } catch {}

  // 2. All agents defined in crewswarm.json / openclaw.json (online or not)
  try {
    const cfg = JSON.parse(fs.readFileSync(CFG_FILE, "utf8"));
    const raw = Array.isArray(cfg.agents) ? cfg.agents
              : Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
    raw.forEach(a => {
      const rtName = normalizeRtAgentId(a.id);
      if (rtName) merged.add(rtName);
    });
  } catch {}

  // 3. Hard fallback if both fail
  if (!merged.size) {
    BUILT_IN_RT_AGENTS.forEach((a) => merged.add(a));
  }

  // Annotate each agent with last heartbeat time for liveness display
  const now = Date.now();
  return [...merged].map(id => {
    const lastSeen = agentHeartbeats.get(id) || null;
    const ageSec = lastSeen ? Math.floor((now - lastSeen) / 1000) : null;
    const liveness = ageSec === null ? "unknown" : ageSec < 90 ? "online" : ageSec < 300 ? "stale" : "offline";
    return { id, lastSeen, ageSec, liveness };
  });
}

/**
 * Read recent RT messages from events.jsonl and done.jsonl, merged and deduped.
 */
export async function getRecentRTMessages(limit = 100, { rtDoneLog, rtEventsLog }) {
  const { readFile } = await import("node:fs/promises");
  const SKIP_TYPES = new Set(["agent.heartbeat", "agent.online", "agent.offline"]);
  const MAX_REPLY_CHARS = 3000;

  async function readJsonlTail(filePath, n) {
    try {
      const content = await readFile(filePath, "utf8");
      const lines = content.trim().split("\n").filter(Boolean);
      const out = [];
      for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
        try { out.push(JSON.parse(lines[i])); } catch {}
      }
      return out.reverse();
    } catch { return []; }
  }

  const [doneRaw, eventsRaw] = await Promise.all([
    readJsonlTail(rtDoneLog, limit),
    readJsonlTail(rtEventsLog, limit),
  ]);

  const msgs = [];
  for (const obj of [...eventsRaw, ...doneRaw]) {
    const env = obj.envelope || obj;
    if (SKIP_TYPES.has(env.type)) continue;
    if (env.payload?.reply?.length > MAX_REPLY_CHARS) {
      env.payload = { ...env.payload, reply: env.payload.reply.slice(0, MAX_REPLY_CHARS) + "\n…[truncated]" };
    }
    msgs.push(env);
  }

  msgs.sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));
  const seen = new Set();
  const deduped = msgs.filter(m => {
    const idKey = m.id || (m.ts + m.from);
    if (seen.has(idKey)) return false;
    seen.add(idKey);
    const payload = m.payload || {};
    const text = (payload.reply || payload.prompt || payload.message || payload.content || "").slice(0, 120);
    if (text.length > 30) {
      const contentKey = (m.from || "") + "|" + text;
      if (seen.has(contentKey)) return false;
      seen.add(contentKey);
    }
    return true;
  });
  return deduped.slice(-limit);
}

/**
 * Read DLQ (dead-letter queue) entries from the dlq directory.
 */
export async function getDLQEntries(dlqDir) {
  const { readdir, readFile } = await import("node:fs/promises");
  try {
    const files = await readdir(dlqDir);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    const entries = [];
    for (const file of jsonFiles) {
      try {
        const content = await readFile(path.join(dlqDir, file), "utf8");
        entries.push({ ...JSON.parse(content), filename: file });
      } catch {}
    }
    return entries.sort((a, b) => (b.failedAt || "").localeCompare(a.failedAt || ""));
  } catch {
    return [];
  }
}

/**
 * Use Groq API to enhance a rough prompt into a clear build requirement.
 */
export async function enhancePromptWithGroq(userText, groqApiKey) {
  if (!groqApiKey) throw new Error("GROQ_API_KEY not set");
  const systemPrompt = `You help turn rough ideas into a single clear build requirement for a phased orchestrator (MVP → Phase 1 → Phase 2).
Output ONLY the improved requirement: one or two sentences, concrete and actionable. No preamble or explanation.
Examples:
- "website for our product" → "Build a marketing website for the product in website/ with hero, feature list, and contact CTA."
- "fix the bug" → "Fix the login validation bug in the auth flow and add a unit test for it."
Keep the same intent; make it specific enough for a PM to break into small tasks.`;

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${groqApiKey}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText },
      ],
      temperature: 0.3,
      max_tokens: 256,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("Empty response from Groq");
  return content;
}

/**
 * Read phased orchestrator progress from dispatch log.
 */
export async function getPhasedProgress(limit = 80, phasedDispatchLog) {
  const { readFile } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  if (!existsSync(phasedDispatchLog)) return [];
  try {
    const content = await readFile(phasedDispatchLog, "utf8");
    const lines = content.trim().split("\n").filter(Boolean).slice(-limit);
    return lines.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

// ── Crew-lead proxy helper ───────────────────────────────────────────────────

/**
 * Get the RT auth token from ~/.crewswarm/config.json.
 */
export function getCLToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "config.json"), "utf8"));
    return cfg?.rt?.authToken || "";
  } catch { return ""; }
}

/**
 * Proxy a request to crew-lead (http://127.0.0.1:5010).
 * Returns { status, body } so the caller can forward to the HTTP response.
 */
export async function proxyToCL(method, path_, body) {
  const CREW_LEAD_URL = "http://127.0.0.1:5010";
  const token = getCLToken();
  const opts = {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(15000),
  };
  if (body) opts.body = body;
  try {
    const r = await fetch(CREW_LEAD_URL + path_, opts);
    const text = await r.text();
    return { status: r.status, body: text };
  } catch (err) {
    return {
      status: 503,
      body: JSON.stringify({
        error: "crew-lead unreachable",
        detail: String(err?.message || err),
        hint: "Start crew-lead: npm run restart-all",
      }),
    };
  }
}
