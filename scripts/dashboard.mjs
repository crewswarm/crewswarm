#!/usr/bin/env node
/**
 * CrewSwarm Dashboard with Build UI (RT Messages, Send, DLQ, Build).
 * Run from CrewSwarm repo so the Build button is included.
 *
 *   node scripts/dashboard.mjs
 *   → http://127.0.0.1:4318
 *
 * If port 4318 is in use, set SWARM_DASH_PORT=4319
 */
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { BUILT_IN_RT_AGENTS, normalizeRtAgentId } from "../lib/agent-registry.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPENCLAW_DIR = process.env.CREWSWARM_DIR || process.env.OPENCLAW_DIR || path.resolve(__dirname, "..");
// Config dir: ~/.crewswarm is canonical; falls back to ~/.openclaw for legacy installs (not repo root)
const CFG_DIR = process.env.CREWSWARM_CONFIG_DIR
  || process.env.OPENCREWHQ_CONFIG_DIR
  || (fs.existsSync(path.join(os.homedir(), ".crewswarm", "crewswarm.json"))
      ? path.join(os.homedir(), ".crewswarm")
      : path.join(os.homedir(), ".openclaw"));
// Config filename within CFG_DIR — crewswarm.json for new installs, openclaw.json for legacy
const CFG_FILE = path.join(CFG_DIR,
  fs.existsSync(path.join(CFG_DIR, "crewswarm.json")) ? "crewswarm.json" : "openclaw.json");
// Default 4319 so we don't conflict with CrewSwarm RT Messages dashboard on 4318
const listenPort = Number(process.env.SWARM_DASH_PORT || 4319);
const opencodeBase = process.env.OPENCODE_URL || "http://127.0.0.1:4096";
const phasedOrchestrator = path.join(OPENCLAW_DIR, "phased-orchestrator.mjs");
const continuousBuild = path.join(OPENCLAW_DIR, "continuous-build.mjs");
const pmLoop = path.join(OPENCLAW_DIR, "pm-loop.mjs");
const pmStopFile = path.join(OPENCLAW_DIR, "orchestrator-logs", "pm-loop.stop");
const pmLogFile = path.join(OPENCLAW_DIR, "orchestrator-logs", "pm-loop.jsonl");
const roadmapFile = path.join(OPENCLAW_DIR, "website", "ROADMAP.md");
const user = process.env.OPENCODE_SERVER_USERNAME || "opencode";
const pass = process.env.OPENCODE_SERVER_PASSWORD || process.env.SWARM_PASSWORD || "opencode";
// ── CrewSwarm tool definitions (server-side, also injected into client) ────
const CREWSWARM_TOOLS = [
  { id: "write_file", desc: "Write files to disk (@@WRITE_FILE)" },
  { id: "read_file",  desc: "Read files from disk (@@READ_FILE)" },
  { id: "mkdir",      desc: "Create directories (@@MKDIR)" },
  { id: "run_cmd",    desc: "Run whitelisted shell commands (@@RUN_CMD)" },
  { id: "git",        desc: "Git & GitHub CLI operations" },
  { id: "web_search", desc: "Web search (Brave Search — @@WEB_SEARCH)" },
  { id: "web_fetch",  desc: "Fetch URLs (@@WEB_FETCH)" },
  { id: "dispatch",   desc: "Dispatch tasks to other agents" },
  { id: "telegram",   desc: "Send Telegram messages (@@TELEGRAM)" },
];

const ctlPath = (() => {
  const homeBin = path.join(os.homedir(), "bin", "openswitchctl");
  if (fs.existsSync(homeBin)) return homeBin;
  return path.join(OPENCLAW_DIR, "scripts", "openswitchctl");
})();
// Match RT daemon paths so RT Messages tab shows same events (daemon uses SHARED_MEMORY_DIR or ~/.openclaw/workspace/...)
const memoryBase = process.env.SHARED_MEMORY_DIR || path.join(CFG_DIR, "workspace", "shared-memory");
const rtEventsLog  = path.join(memoryBase, "claw-swarm", "opencrew-rt", "events.jsonl");
const rtDoneLog    = path.join(memoryBase, "claw-swarm", "opencrew-rt", "channels", "done.jsonl");
const rtCommandLog = path.join(memoryBase, "claw-swarm", "opencrew-rt", "channels", "command.jsonl");
const dlqDir = path.join(memoryBase, "claw-swarm", "opencrew-rt", "dlq");
const phasedDispatchLog = path.join(OPENCLAW_DIR, "orchestrator-logs", "phased-dispatch.jsonl");

const authHeader = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

// ── Agent heartbeat liveness tracker ─────────────────────────────────────────
// Updated every 30s from events.jsonl — reflects actual bridge pulse, not just config.
const agentHeartbeats = new Map(); // agentId → lastSeenMs

function refreshHeartbeats() {
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

// Prime the map immediately, then refresh every 30s
refreshHeartbeats();
setInterval(refreshHeartbeats, 30000);

async function proxyJSON(pathname) {
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

async function sendCrewMessage(to, message) {
  const { execSync } = await import("node:child_process");
  return execSync(`"${ctlPath}" send "${to}" "${message.replace(/"/g, '\\"')}"`, {
    encoding: "utf8",
    timeout: 10000,
  });
}

async function getAgentList() {
  const merged = new Set();

  // 1. Live RT bus agents (currently connected)
  try {
    const { execSync } = await import("node:child_process");
    const result = execSync(`"${ctlPath}" agents`, { encoding: "utf8", timeout: 5000 });
    result.trim().split("\n").filter(Boolean).forEach(a => merged.add(a));
  } catch {}

  // 2. All agents defined in crewswarm.json / openclaw.json (online or not) — shown with [offline] indicator handled client-side
  try {
    const cfgPath = CFG_FILE;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
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
    // online < 90s | stale 90-300s | offline > 300s | unknown = never seen
    const liveness = ageSec === null ? "unknown" : ageSec < 90 ? "online" : ageSec < 300 ? "stale" : "offline";
    return { id, lastSeen, ageSec, liveness };
  });
}

async function getRecentRTMessages(limit = 100) {
  const { readFile, stat } = await import("node:fs/promises");
  const SKIP_TYPES = new Set(["agent.heartbeat", "agent.online", "agent.offline"]);
  const MAX_REPLY_CHARS = 3000; // truncate large replies so JSON stays small

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

  // Merge: done.jsonl (task completions) + events.jsonl (commands/lifecycle)
  const [doneRaw, eventsRaw] = await Promise.all([
    readJsonlTail(rtDoneLog, limit),
    readJsonlTail(rtEventsLog, limit),
  ]);

  const msgs = [];
  for (const obj of [...eventsRaw, ...doneRaw]) {
    const env = obj.envelope || obj;
    if (SKIP_TYPES.has(env.type)) continue;
    // Truncate large reply payloads so the browser doesn't choke
    if (env.payload?.reply?.length > MAX_REPLY_CHARS) {
      env.payload = { ...env.payload, reply: env.payload.reply.slice(0, MAX_REPLY_CHARS) + "\n…[truncated]" };
    }
    msgs.push(env);
  }

  // Sort by ts, deduplicate by id and by content fingerprint (catches same message in both logs)
  msgs.sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));
  const seen = new Set();
  const deduped = msgs.filter(m => {
    // Primary key: explicit id or ts+from
    const idKey = m.id || (m.ts + m.from);
    if (seen.has(idKey)) return false;
    seen.add(idKey);
    // Secondary key: content fingerprint — same reply/prompt from same sender within 5s
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

async function getDLQEntries() {
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

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";

async function enhancePromptWithGroq(userText) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY not set");
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
      Authorization: `Bearer ${GROQ_API_KEY}`,
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

async function getPhasedProgress(limit = 80) {
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

const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CrewSwarm Dashboard</title>
  <link rel="icon" type="image/png" href="/favicon.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg:       #060a10;
      --bg-card:  #0d1420;
      --bg-card2: #111827;
      --bg-hover: #141e2e;
      --border:   rgba(255,255,255,0.07);
      --border-hi:rgba(56,189,248,0.35);
      --text:     #f0f6ff;
      --text-2:   #8b9db3;
      --text-3:   #4a5568;
      --accent:   #38bdf8;
      --accent2:  #818cf8;
      --green:    #34d399;
      --red:      #f87171;
      --yellow:   #fbbf24;
      --radius:   10px;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; background: var(--bg); color: var(--text); display: flex; height: 100vh; overflow: hidden; font-size: 14px; }

    /* ── Sidebar ── */
    .sidebar { width: 216px; min-width: 216px; background: var(--bg-card); border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow-y: auto; }
    .sidebar-brand { display: flex; align-items: center; gap: 10px; padding: 18px 16px 14px; border-bottom: 1px solid var(--border); text-decoration: none; }
    .brand-icon { width: 24px; height: 24px; object-fit: contain; display: block; }
    .brand-name { font-size: 15px; font-weight: 800; color: var(--text); letter-spacing: 0.06em; text-transform: uppercase; }
    .brand-name span { color: #38bdf8; }
    .sidebar-status { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--border); }
    .status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-3); flex-shrink: 0; }
    .status-dot.online { background: var(--green); box-shadow: 0 0 6px var(--green); }
    .status-dot.error  { background: var(--red); }
    #status { font-size: 12px; color: var(--text-2); }
    .nav-section { padding: 12px 8px 4px; }
    .nav-label { font-size: 10px; font-weight: 600; color: var(--text-3); letter-spacing: 0.08em; text-transform: uppercase; padding: 0 8px 6px; }
    .nav-item { display: flex; align-items: center; gap: 9px; width: 100%; padding: 8px 10px; border-radius: 7px; border: none; background: transparent; color: var(--text-2); font-size: 13px; font-weight: 500; cursor: pointer; text-align: left; transition: background 0.12s, color 0.12s; font-family: inherit; }
    .stab { padding: 7px 16px; border: none; background: transparent; color: var(--text-2); font-size: 13px; font-weight: 500; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; font-family: inherit; transition: color 0.12s, border-color 0.12s; white-space: nowrap; }
    .stab:hover { color: var(--text-1); }
    .stab.active { color: var(--accent); border-bottom-color: var(--accent); }
    .nav-item:hover { background: var(--bg-hover); color: var(--text); }
    .nav-item.active { background: rgba(56,189,248,0.1); color: var(--accent); }
    .nav-item .nav-icon { font-size: 15px; width: 18px; text-align: center; }
    .nav-badge { margin-left: auto; background: var(--red); color: #fff; font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 999px; min-width: 18px; text-align: center; }
    .nav-badge.hidden { display: none; }
    .sidebar-bottom { margin-top: auto; padding: 12px 8px; border-top: 1px solid var(--border); }

    /* ── Main wrap ── */
    .main-wrap { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
    .view { display: none; flex: 1; overflow-y: auto; padding: 24px; }
    .view.active { display: block; }
    .view-sessions { display: none; flex: 1; overflow: hidden; }
    .view-sessions.active { display: grid; grid-template-columns: 34% 66%; }
    .view-sessions > section { padding: 16px; overflow-y: auto; }
    .view-sessions > section + section { border-left: 1px solid var(--border); }

    /* ── Msg bar ── */
    .msg-bar { padding: 10px 16px; border-top: 1px solid var(--border); background: var(--bg-card); display: flex; gap: 8px; align-items: center; flex-shrink: 0; }

    /* ── Cards / content ── */
    .card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; margin-bottom: 12px; }
    .card-title { font-size: 15px; font-weight: 600; margin-bottom: 4px; }
    .status-badge { display:inline-flex; align-items:center; gap:5px; font-size:12px; font-weight:600; padding:4px 10px; border-radius:20px; letter-spacing:0.02em; }
    .status-active  { background:rgba(34,197,94,0.15); color:#22c55e; border:1px solid rgba(34,197,94,0.3); }
    .status-stopped { background:rgba(239,68,68,0.12); color:#ef4444; border:1px solid rgba(239,68,68,0.25); }
    .meta { font-size: 12px; color: var(--text-2); }
    .page-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; }
    .page-title { font-size: 18px; font-weight: 700; letter-spacing: -0.3px; }
    .page-sub { font-size: 13px; color: var(--text-2); margin-top: 3px; }
    h3 { font-size: 14px; font-weight: 600; margin-bottom: 8px; }

    /* ── Messages ── */
    .msg { border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px; margin-bottom: 8px; background: var(--bg-card); }
    .msg.u { border-left: 3px solid var(--accent); background: rgba(56,189,248,0.07); margin-left: 40px; }
    .msg.a { border-left: 3px solid var(--green);  background: rgba(52,211,153,0.04); }
    .dlq-item { border-left: 3px solid var(--red) !important; }
    .t { white-space: pre-wrap; font-size: 13px; line-height: 1.5; font-family: "SF Mono", "Fira Code", monospace; }
    .row { padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 8px; cursor: pointer; background: var(--bg-card); transition: border-color 0.12s, background 0.12s; }
    .row:hover { background: var(--bg-hover); }
    .row.active { border-color: var(--accent); background: rgba(56,189,248,0.06); }

    /* ── Buttons ── */
    button { background: var(--accent); color: #000; border: none; border-radius: 7px; padding: 7px 14px; cursor: pointer; font-weight: 600; font-size: 13px; font-family: inherit; transition: opacity 0.12s; }
    button:hover { opacity: 0.85; }
    .btn-ghost  { background: transparent; color: var(--text-2); border: 1px solid var(--border); }
    .btn-ghost:hover { background: var(--bg-hover); color: var(--text); }
    .btn-green  { background: var(--green); color: #000; }
    .btn-sky    { background: #0ea5e9; color: #000; border: 1px solid #0ea5e9; }
    .btn-sky:hover { background: #38bdf8; }
    .btn-red    { background: var(--red); color: #fff; }
    .btn-yellow { background: var(--yellow); color: #000; }
    .btn-purple { background: var(--accent2); color: #fff; }
    .btn-muted  { background: var(--bg-card2); color: var(--text-2); border: 1px solid var(--border); }
    .reply-btn  { font-size: 11px; padding: 3px 8px; background: var(--accent2); color: #fff; margin-left: 8px; }
    .replay-btn { font-size: 11px; padding: 3px 8px; background: var(--yellow); color: #000; margin-left: 8px; }
    .send-btn   { background: var(--green); color: #000; }
    /* ── Emoji picker ── */
    .emoji-btn { width:46px; height:46px; font-size:22px; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.10); border-radius:var(--radius); cursor:pointer; display:flex; align-items:center; justify-content:center; flex-shrink:0; transition:border-color 0.15s, background 0.15s; color:inherit; }
    .emoji-btn:hover { border-color:var(--accent); background:rgba(56,189,248,0.08); }
    .emoji-picker-wrap { position:relative; flex-shrink:0; }
    .emoji-picker-panel { display:none; position:absolute; top:50px; right:0; z-index:200; background:var(--bg-card); border:1px solid var(--border-hi); border-radius:var(--radius); padding:10px; box-shadow:0 8px 32px rgba(0,0,0,0.5); width:260px; }
    .emoji-picker-panel.open { display:block; }
    .emoji-grid { display:grid; grid-template-columns:repeat(6,1fr); gap:6px; }
    .emoji-opt { font-size:22px; width:36px; height:36px; display:flex; align-items:center; justify-content:center; cursor:pointer; border-radius:6px; transition:background 0.1s; }
    .emoji-opt:hover { background:rgba(56,189,248,0.15); }

    /* Files view */
    .file-row { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 6px; transition: border-color 0.15s; }
    .file-row:hover { border-color: var(--accent); }
    .file-info { flex: 1; min-width: 0; }
    .file-name { display: block; font-size: 13px; color: var(--text); font-family: "SF Mono","Fira Code",monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .file-meta { font-size: 11px; color: var(--text-2); }
    .file-actions { display: flex; gap: 5px; flex-shrink: 0; }
    .file-btn { font-size: 11px; padding: 3px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-card2); color: var(--text-2); cursor: pointer; text-decoration: none; transition: all 0.15s; white-space: nowrap; }
    .file-btn:hover { color: var(--text); border-color: var(--accent); }
    .file-btn-cursor { border-color: rgba(99,102,241,0.4); color: #818cf8; }
    .file-btn-cursor:hover { background: rgba(99,102,241,0.15); }
    .file-btn-opencode { border-color: rgba(52,211,153,0.4); color: #34d399; }
    .file-btn-opencode:hover { background: rgba(52,211,153,0.1); }

    /* ── Form inputs ── */
    select, input[type="text"], input[type="password"], input[type="number"], input[type="email"], input:not([type]), textarea {
      background: rgba(255,255,255,0.04);
      color: var(--text);
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: var(--radius);
      padding: 10px 14px;
      font-size: 13px;
      font-family: inherit;
      outline: none;
      transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
      width: 100%;
    }
    select:focus, input:not([type]):focus, input[type="text"]:focus, input[type="password"]:focus, input[type="number"]:focus, input[type="email"]:focus, textarea:focus {
      border-color: var(--accent);
      background: rgba(56,189,248,0.04);
      box-shadow: 0 0 0 3px rgba(56,189,248,0.08);
    }
    select { cursor: pointer; }
    ::placeholder { color: var(--text-3); opacity: 1; }
    input[type="text"] { flex: 1; }
    textarea { resize: vertical; width: 100%; }
    input, textarea, select { user-select: text; -webkit-user-select: text; cursor: text; }

    /* ── Notification ── */
    .notification { position: fixed; top: 20px; right: 20px; background: var(--green); color: #000; padding: 12px 20px; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.4); z-index: 1000; animation: slideIn 0.25s ease; font-weight: 600; font-size: 13px; }
    .notification.error { background: var(--red); color: #fff; }
    .notification.warning { background: #f59e0b; color: #000; }
    @keyframes slideIn { from { transform: translateX(120%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
    @keyframes pulse { 0%,100% { opacity:.3; transform:scale(.85); } 50% { opacity:1; transform:scale(1.15); } }

    /* ── Terminal / log blocks ── */
    .log-block { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; font-family: "SF Mono","Fira Code",monospace; font-size: 12px; color: var(--accent); max-height: 220px; overflow-y: auto; white-space: pre-wrap; line-height: 1.5; }
    .rm-textarea { width: 100%; font-family: "SF Mono","Fira Code",monospace; font-size: 12px; background: var(--bg); color: var(--text-2); border: 1px solid var(--border); border-radius: 8px; padding: 12px; line-height: 1.6; resize: vertical; box-sizing: border-box; }
    .log-block.green { color: var(--green); border-color: rgba(52,211,153,0.2); }
    .log-block.mono  { color: var(--text-2); }

    /* ── Provider cards ── */
    .provider-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; margin-bottom: 10px; }
    .provider-header { display: flex; align-items: center; gap: 12px; padding: 13px 16px; cursor: pointer; user-select: none; transition: background 0.12s; }
    .provider-header:hover { background: var(--bg-hover); }
    .provider-badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
    .provider-body { display: none; padding: 16px; border-top: 1px solid var(--border); background: var(--bg); }
    .provider-body.open { display: block; }
    .key-row { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
    .key-input { flex: 1; background: var(--bg-card2); color: var(--text); border: 1px solid var(--border); border-radius: 7px; padding: 8px 12px; font-size: 13px; font-family: "SF Mono","Fira Code",monospace; }
    .model-tag { display: inline-block; background: var(--bg-card2); border: 1px solid var(--border); border-radius: 5px; padding: 2px 8px; font-size: 11px; margin: 2px; font-family: "SF Mono",monospace; color: var(--text-2); }
    .test-ok  { color: var(--green); font-size: 12px; margin-left: 8px; font-weight: 600; }
    .test-err { color: var(--red);   font-size: 12px; margin-left: 8px; }

    /* ── PM badge ── */
    .pm-badge { font-size: 11px; padding: 2px 10px; border-radius: 999px; font-weight: 600; margin-left: 10px; background: var(--bg-card2); color: var(--text-2); border: 1px solid var(--border); }
    .pm-badge.running { background: rgba(52,211,153,0.1); color: var(--green); border-color: rgba(52,211,153,0.3); }

    /* ── Progress bar ── */
    .prog-bar { height: 4px; background: var(--bg-card2); border-radius: 2px; overflow: hidden; margin: 8px 0; }
    .prog-fill { height: 100%; border-radius: 2px; transition: width 0.3s; }

    /* ── Divider ── */
    .divider { border: none; border-top: 1px solid var(--border); margin: 20px 0; }

    /* ── Agent cards ── */
    .agent-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
    .agent-card-header { display: flex; align-items: center; gap: 12px; padding: 14px 16px; }
    .agent-avatar { width: 38px; height: 38px; border-radius: 10px; background: var(--bg-card2); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; font-size: 18px; flex-shrink: 0; }
    .agent-meta { flex: 1; min-width: 0; }
    .agent-id { font-weight: 700; font-size: 14px; }
    .agent-model { font-size: 12px; color: var(--text-2); font-family: "SF Mono",monospace; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .agent-body { border-top: 1px solid var(--border); padding: 14px 16px; background: var(--bg); display: grid; gap: 12px; }
    .agent-row { display: grid; grid-template-columns: 110px 1fr auto auto; gap: 8px; align-items: center; }
    .agent-row label { font-size: 12px; color: var(--text-2); font-weight: 500; }
    .agent-badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: rgba(56,189,248,0.1); color: var(--accent); border: 1px solid rgba(56,189,248,0.2); font-weight: 600; }
    .agent-badge.online { background: rgba(52,211,153,0.1); color: var(--green); border-color: rgba(52,211,153,0.3); }
    .field-label { font-size: 11px; font-weight: 600; color: var(--text-2); margin-bottom: 5px; text-transform: uppercase; letter-spacing: 0.05em; }
    .tool-profile-opt { cursor: pointer; }
    .tool-profile-opt input[type=radio] { display: none; }
    .tp-card { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; transition: border-color 0.12s, background 0.12s; }
    .tool-profile-opt:hover .tp-card { border-color: var(--accent); background: var(--bg-hover); }
    .tool-profile-opt input:checked + .tp-card { border-color: var(--accent); background: rgba(56,189,248,0.07); }
    .tp-name { font-size: 13px; font-weight: 700; margin-bottom: 4px; color: var(--text); font-family: "SF Mono",monospace; }
    .tp-desc { font-size: 11px; color: var(--text-2); line-height: 1.4; }

    /* ── Scrollbar ── */
    ::-webkit-scrollbar { width: 5px; height: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
    #rtView::-webkit-scrollbar { width: 8px; }
    #rtView::-webkit-scrollbar-track { background: var(--bg-card); border-radius: 4px; }
    #rtView::-webkit-scrollbar-thumb { background: var(--accent); border-radius: 4px; opacity: 0.7; }
    #rtView::-webkit-scrollbar-thumb:hover { background: var(--accent); opacity: 1; }
    #rtView { scrollbar-width: thin; scrollbar-color: var(--accent) var(--bg-card); }
  </style>
</head>
<body>
  <!-- ── Sidebar ── -->
  <nav class="sidebar">
    <div class="sidebar-brand">
      <img class="brand-icon" src="/favicon.png" alt="CrewSwarm" />
      <span class="brand-name">Crew<span>Swarm</span></span>
    </div>
    <div class="sidebar-status">
      <span class="status-dot" id="statusDot"></span>
      <span id="status">loading...</span>
      <button id="refreshBtn" class="btn-ghost" style="margin-left:auto; padding:3px 8px; font-size:11px;">↻</button>
    </div>

    <div class="nav-section">
      <div class="nav-label">Control</div>
      <button class="nav-item active" id="navChat" onclick="showChat()">
        <span class="nav-icon">🧠</span> Chat
        <span class="nav-badge hidden" id="chatBadge">●</span>
      </button>
      <button class="nav-item" id="navSwarm" onclick="showSwarm()">
        <span class="nav-icon">💬</span> Sessions
      </button>
      <button class="nav-item" id="navRT" onclick="showRT()">
        <span class="nav-icon">📡</span> RT Messages
      </button>
      <button class="nav-item" id="navBuild" onclick="showBuild()">
        <span class="nav-icon">🔨</span> Build
      </button>
      <button class="nav-item" id="navFiles" onclick="showFiles()">
        <span class="nav-icon">📂</span> Files
      </button>
      <button class="nav-item" id="navDLQ" onclick="showDLQ()">
        <span class="nav-icon">⚠️</span> DLQ
        <span class="nav-badge hidden" id="dlqBadge">0</span>
      </button>
    </div>

    <div class="nav-section">
      <div class="nav-label">Workspace</div>
      <button class="nav-item" id="navProjects" onclick="showProjects()">
        <span class="nav-icon">📁</span> Projects
      </button>
      <button class="nav-item" id="navAgents" onclick="showAgents()">
        <span class="nav-icon">🤖</span> Agents
      </button>
      <button class="nav-item" id="navModels" onclick="showModels()">
        <span class="nav-icon">⚙️</span> Models
      </button>
      <button class="nav-item" id="navSkills" onclick="showSkills()">
        <span class="nav-icon">🔌</span> Skills
      </button>
      <button class="nav-item" id="navRunSkills" onclick="showRunSkills()">
        <span class="nav-icon">⚡</span> Run skills
      </button>
      <button class="nav-item" id="navBenchmarks" onclick="showBenchmarks()">
        <span class="nav-icon">📊</span> Benchmarks
      </button>
      <button class="nav-item" id="navToolMatrix" onclick="showToolMatrix()">
        <span class="nav-icon">📋</span> Tool Matrix
      </button>
      <button class="nav-item" id="navServices" onclick="showServices()">
        <span class="nav-icon">🔧</span> Services
        <span class="nav-badge hidden" id="servicesBadge">!</span>
      </button>
      <button class="nav-item" id="navSettings" onclick="showSettings()">
        <span class="nav-icon">🛠</span> Settings
      </button>
    </div>

    <div class="sidebar-bottom">
      <div class="meta" style="padding:4px 2px;">v1.0 · <a href="http://localhost:4319" style="color:var(--accent); text-decoration:none;">localhost:4319</a></div>
    </div>
  </nav>

  <!-- ── Main content ── -->
  <div class="main-wrap">

    <!-- Sessions view -->
    <div class="view-sessions" id="sessionsView">
      <section id="sessions"></section>
      <section id="messages"></section>
    </div>

    <!-- RT Messages -->
    <div class="view" id="rtView">
      <div class="page-header">
        <div><div class="page-title">RT Messages</div><div class="page-sub">Live feed from CrewSwarm RT message bus</div></div>
        <button id="rtScrollBtn" onclick="document.getElementById('rtView').scrollTop=document.getElementById('rtView').scrollHeight" style="display:none;position:fixed;bottom:32px;right:32px;z-index:999;background:var(--accent);color:#fff;border:none;border-radius:50px;padding:10px 20px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,0.3);transition:opacity .2s;">⬇ Latest</button>
      </div>
      <!-- OpenCode live feed -->
      <div id="ocFeedWrap" style="margin:0 0 18px 0;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
          <span style="font-size:13px;font-weight:600;color:var(--text-2);letter-spacing:.04em;text-transform:uppercase;">OpenCode Activity</span>
          <span id="ocFeedDot" style="display:none;width:8px;height:8px;border-radius:50%;background:#22c55e;animation:pulse 1.2s ease-in-out infinite;flex-shrink:0;" title="Live"></span>
        </div>
        <div id="ocFeed" style="display:flex;flex-direction:column;gap:4px;min-height:32px;"></div>
      </div>
      <div id="rtMessages"></div>
    </div>

    <!-- DLQ -->
    <div class="view" id="dlqView">
      <div class="page-header">
        <div><div class="page-title">Dead Letter Queue</div><div class="page-sub">Failed tasks after max retries — replay to retry</div></div>
      </div>
      <div id="dlqMessages"></div>
    </div>

    <!-- Files -->
    <div class="view" id="filesView">
      <div class="page-header">
        <div><div class="page-title">Files</div><div class="page-sub">Files written by the crew — click to open in Cursor or OpenCode</div></div>
        <div style="display:flex;gap:8px;align-items:center;">
          <input id="filesDir" placeholder="/path/to/project" style="width:240px;" value="${process.env.HOME}/Desktop/CrewSwarm" />
          <button type="button" class="btn-ghost" style="font-size:13px;padding:6px 10px;" onclick="pickFolder('filesDir')">📂</button>
          <button onclick="loadFiles()" class="btn-green">Scan</button>
          <button onclick="loadFiles(true)" class="btn-ghost" style="font-size:12px;">↻</button>
        </div>
      </div>
      <div id="filesContent"></div>
    </div>

    <!-- Chat with crew-lead -->
    <div class="view active" id="chatView">
      <div class="page-header">
        <div>
          <div class="page-title" id="chatAgentTitle">🧠 Crew Lead</div>
          <div class="page-sub" id="chatAgentSub">Conversational commander — chat naturally, dispatch tasks to the crew</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <span id="crewLeadBadge" class="status-badge status-stopped">● offline</span>
          <button onclick="clearChatHistory()" class="btn-ghost" style="font-size:12px;">🗑 Clear</button>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;height:calc(100vh - 160px);gap:10px;">
        <div id="chatMessages" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding:4px 2px;"></div>
        <div style="display:flex;gap:8px;align-items:flex-end;flex-shrink:0;position:relative;overflow:visible;">
          <span style="font-size:11px;color:var(--text-3);white-space:nowrap;align-self:center;">Project:</span>
          <select id="chatProjectSelect" style="width:200px;max-width:200px;font-size:12px;padding:6px 8px;background:var(--bg-card2);color:var(--text-1);border:1px solid var(--border);border-radius:6px;align-self:center;" onchange="onChatProjectChange()" title="Active project for dispatch context">
            <option value="">— none —</option>
          </select>
          <div style="flex:1;position:relative;min-width:0;overflow:visible;">
            <textarea id="chatInput" placeholder="Talk to crew-lead... (Shift+Enter for newline, Enter to send). Type @@ for commands."
              style="width:100%;resize:none;height:56px;padding:12px;font-size:14px;line-height:1.4;min-width:0;box-sizing:border-box;"
              onkeydown="chatKeydown(event)" oninput="chatAtAtInput(event)"></textarea>
            <div id="chatAtAtMenu" style="display:none;position:absolute;bottom:100%;left:0;right:0;margin-bottom:4px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;max-height:220px;overflow-y:auto;box-shadow:0 4px 12px rgba(0,0,0,0.3);z-index:100;"></div>
            <div id="chatAtAtTemplate" style="display:none;margin-top:4px;padding:8px 10px;font-size:11px;font-family:monospace;background:var(--bg-card2);border:1px solid var(--border);border-radius:6px;color:var(--text-2);white-space:pre-wrap;word-break:break-all;"></div>
          </div>
          <button onclick="sendChat()" class="btn-green" style="height:56px;padding:0 20px;font-size:15px;">Send</button>
        </div>
      </div>
    </div>


    <!-- Services -->
    <div class="view" id="servicesView">
      <div class="page-header">
        <div><div class="page-title">Services</div><div class="page-sub">Live status of all CrewSwarm processes — restart any service without leaving the dashboard</div></div>
        <button onclick="loadServices()" class="btn-ghost" style="font-size:12px;">↻ Refresh</button>
      </div>
      <div id="servicesGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;padding:16px;"></div>
    </div>

    <!-- Projects -->
    <div class="view" id="projectsView">
      <div class="page-header">
        <div><div class="page-title">Projects</div><div class="page-sub">Each project has its own roadmap, output dir, and PM Loop.</div></div>
        <button id="newProjectBtn" class="btn-yellow">+ New Project</button>
      </div>
      <div id="newProjectForm" style="display:none;" class="card" style="border-color:var(--yellow);">
        <h3>New Project</h3>
        <div style="display:grid; gap:10px; margin-top:12px;">
          <input id="npName"        placeholder="Project name (e.g. CrewSwarm Docs)" />
          <input id="npDesc"        placeholder="Description (optional)" />
          <div style="display:flex;gap:6px;align-items:center;">
            <input id="npOutputDir" placeholder="Project folder — anywhere on disk (e.g. ~/Desktop/MyApp). Agents write files here." style="flex:1;" />
            <button type="button" class="btn-ghost" style="white-space:nowrap;font-size:13px;padding:6px 10px;" onclick="pickFolder('npOutputDir')">📂 Browse</button>
          </div>
          <input id="npFeaturesDoc" placeholder="Features doc path (optional)" />
          <div style="display:flex; gap:8px;">
            <button id="npCreateBtn" class="send-btn">Create Project</button>
            <button id="npCancelBtn" class="btn-ghost">Cancel</button>
          </div>
        </div>
      </div>
      <div id="projectsList" style="display:grid; gap:14px;"></div>
    </div>

    <!-- Providers -->
    <div class="view" id="modelsView">
      <div class="page-header">
        <div><div class="page-title">Models &amp; API Keys</div><div class="page-sub">Keys saved to <code style="font-size:11px; color:var(--text-2);">~/.crewswarm/config.json</code></div></div>
        <div style="display:flex; gap:8px;">
          <button id="addProviderBtn" class="btn-purple">+ Add Provider</button>
          <button id="refreshProvidersBtn" class="btn-ghost">↻ Refresh</button>
        </div>
      </div>

      <!-- RT Bus auth token -->
      <div class="card" style="margin-bottom:16px;">
        <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
          <span style="font-size:18px;">⚡</span>
          <div>
            <div style="font-weight:600; font-size:14px;">RT Bus Auth Token</div>
            <div style="font-size:12px; color:var(--text-2);">Auto-generated during install and saved to <code style="font-size:11px;">~/.crewswarm/config.json</code>. All services read it from there — you never need to copy it manually. Only change this if you want to rotate the secret or run the RT bus on a shared machine.</div>
          </div>
          <span id="rtTokenBadge" style="margin-left:auto; font-size:11px; padding:2px 8px; border-radius:999px; font-weight:600; background:rgba(251,191,36,0.15); color:#fbbf24; border:1px solid rgba(251,191,36,0.3);">not set</span>
        </div>
        <div style="display:flex; gap:8px;">
          <input id="rtTokenInput" type="password" autocomplete="new-password" placeholder="Leave blank to auto-use the token from config.json" style="flex:1;" />
          <button onclick="saveRTToken()" class="btn-purple">Save</button>
          <button onclick="document.getElementById('rtTokenInput').type = document.getElementById('rtTokenInput').type === 'password' ? 'text' : 'password'" class="btn-ghost" title="Show/hide">👁</button>
        </div>
      </div>

      <!-- LLM Providers (built-ins + any custom providers appended below) -->
      <div style="font-size:11px; font-weight:600; color:var(--text-2); text-transform:uppercase; letter-spacing:0.08em; margin-bottom:10px; padding:0 2px;">LLM Providers</div>
      <div id="builtinProvidersList"></div>

      <!-- Add custom provider form (shown by "+ Add Provider" button in page header) -->
      <div id="addProviderForm" style="display:none; margin-bottom:10px;" class="card">
        <h3 style="margin-bottom:12px;">Add Custom Provider</h3>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
          <input id="apId"      placeholder="Provider ID (e.g. together)" />
          <input id="apBaseUrl" placeholder="Base URL (e.g. https://api.together.xyz/v1)" />
          <input id="apKey"     placeholder="API Key" type="password" autocomplete="new-password" />
          <select id="apApi">
            <option value="openai-completions">openai-completions</option>
            <option value="openai-responses">openai-responses</option>
          </select>
        </div>
        <div style="display:flex; gap:8px; margin-top:12px;">
          <button id="apSaveBtn" class="btn-purple">Save Provider</button>
          <button id="apCancelBtn" class="btn-ghost">Cancel</button>
        </div>
      </div>

      <!-- Search & Research Tools -->
      <div style="font-size:11px; font-weight:600; color:var(--text-2); text-transform:uppercase; letter-spacing:0.08em; margin:18px 0 10px; padding:0 2px;">Search &amp; Research Tools</div>
      <div id="searchToolsList"></div>
    </div>

    <!-- Agents -->
    <div class="view" id="agentsView">
      <div class="page-header">
        <div><div class="page-title">Agents</div><div class="page-sub">Assign models, edit system prompts, configure per-agent tool permissions. Tool permissions are enforced by gateway-bridge on every task.</div></div>
        <div style="display:flex; gap:8px;">
          <button id="newAgentBtn" class="btn-green">+ New Agent</button>
          <button id="refreshAgentsBtn" class="btn-ghost">↻ Refresh</button>
          <button onclick="startCrew()" class="btn-ghost" style="color:var(--green); border-color:rgba(52,211,153,0.3);">⚡ Start Bridges</button>
        </div>
      </div>

      <!-- New agent form -->
      <div id="newAgentForm" style="display:none; margin-bottom:16px;" class="card">
        <h3 style="margin-bottom:14px;">New Agent</h3>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:10px;">
          <div>
            <div class="field-label">Agent ID <span class="meta" style="text-transform:none;">(used as RT bus name)</span></div>
            <input id="naId" placeholder="e.g. crew-coder-3" />
          </div>
          <div>
            <div class="field-label">Model</div>
            <select id="naModel" style="width:100%;"><option value="">— select a model —</option></select>
          </div>
          <div>
            <div class="field-label">Display Name</div>
            <input id="naName" placeholder="e.g. Blaze" />
          </div>
          <div style="display:flex; gap:8px; align-items:flex-end;">
            <div style="flex:0 0 auto;">
              <div class="field-label">Emoji</div>
              <div class="emoji-picker-wrap">
                <button type="button" class="emoji-btn" id="naEmoji-btn" onclick="toggleEmojiPicker('__new__')" title="Pick emoji">🔥</button>
                <input type="hidden" id="naEmoji" value="🔥" />
                <div class="emoji-picker-panel" id="aemoji-panel-__new__">
                  <div class="emoji-grid" id="aemoji-grid-__new__"></div>
                </div>
              </div>
            </div>
          </div>
          <div style="grid-column:1/-1;">
            <div class="field-label">Role / Theme <span class="meta" style="text-transform:none; font-weight:400;">— used by PM router to assign tasks (auto-filled by preset)</span></div>
            <input id="naTheme" placeholder="e.g. iOS / Swift developer (SwiftUI, UIKit)" style="width:100%;" />
          </div>
        </div>
        <div style="margin-bottom:10px;">
          <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px;">
            <div class="field-label" style="margin:0;">System Prompt</div>
            <select id="naPromptPreset" style="font-size:12px; padding:3px 8px;" onchange="applyPromptPreset()">
              \${buildPresetOptions('— quick presets —')}
            </select>
          </div>
          <textarea id="naPrompt" rows="5" placeholder="Describe what this agent specialises in. It will be shown at the top of every task."></textarea>
        </div>
        <div style="margin-bottom:14px;">
          <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px;">
            <div class="field-label" style="margin:0;">Agent Tools <span class="meta" style="text-transform:none; font-weight:400;">— what gateway-bridge lets this agent do</span></div>
            <select id="naToolPreset" style="font-size:12px; padding:3px 8px;" onchange="applyNewAgentToolPreset()">
              <option value="">— tool presets —</option>
              <option value="coder">🔨 Coder (write + run) — frontend, backend, iOS, data, AI/ML…</option>
              <option value="writer">✍️ Writer (write + read) — copywriter, docs, designer</option>
              <option value="reviewer">🔍 Reviewer (read only) — QA, audit</option>
              <option value="security">🛡️ Security (read + run, no write) — scanner, auditor</option>
              <option value="orchestrator">📋 PM / Planner (read + dispatch) — product manager, planner</option>
              <option value="coordinator">🦊 Coordinator (full access) — main agent, team lead</option>
              <option value="devops">⚙️ DevOps (run + git) — infrastructure, GitHub ops</option>
              <option value="comms">💬 Comms (telegram) — notification agent</option>
            </select>
          </div>
          <div id="naToolsGrid" style="display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:6px;">
            ${(typeof CREWSWARM_TOOLS !== "undefined" ? CREWSWARM_TOOLS : []).map(t => `
              <label style="display:flex; align-items:flex-start; gap:7px; font-size:12px; color:var(--text-2); cursor:pointer; padding:6px 8px; border-radius:5px; border:1px solid var(--border); background:var(--bg-card2);">
                <input type="checkbox" class="naToolCheck" data-tool="${t.id}" style="accent-color:var(--accent); margin-top:2px; flex-shrink:0;" />
                <div>
                  <code style="font-size:11px; color:var(--text-1);">${t.id}</code>
                  <div style="font-size:10px; color:var(--text-3); margin-top:2px; line-height:1.3;">${t.desc}</div>
                </div>
              </label>
            `).join('')}
          </div>
        </div>
        <div style="display:flex; gap:8px;">
          <button id="naCreateBtn" class="btn-green">Create Agent</button>
          <button id="naCancelBtn" class="btn-ghost">Cancel</button>
        </div>
      </div>

      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:10px 0 4px; border-bottom:1px solid var(--border); margin-bottom:12px;">
        <span style="font-size:11px; font-weight:600; color:var(--text-3); margin-right:4px;">BULK SET CODING AGENTS →</span>
        <button onclick="bulkSetRoute('direct')" class="btn-ghost" style="font-size:11px; padding:4px 10px;">💬 Direct API</button>
        <button onclick="bulkSetRoute('opencode')" class="btn-ghost" style="font-size:11px; padding:4px 10px; color:#22c55e; border-color:rgba(34,197,94,0.3);">⚡ OpenCode</button>
        <button onclick="bulkSetRoute('cursor','sonnet-4.6')" class="btn-ghost" style="font-size:11px; padding:4px 10px; color:#38bdf8; border-color:rgba(56,189,248,0.3);">🖱 Cursor CLI · sonnet-4.6</button>
        <button onclick="bulkSetRoute('cursor','opus-4.6-thinking')" class="btn-ghost" style="font-size:11px; padding:4px 10px; color:#a78bfa; border-color:rgba(167,139,250,0.3);">🖱 Cursor CLI · opus thinking</button>
      </div>
      <div id="agentsList" style="display:grid; gap:12px;"></div>
    </div>

    <!-- Settings -->
    <div class="view" id="settingsView">
      <div class="page-header">
        <div><div class="page-title">Settings</div><div class="page-sub">Usage, spending, security, and system configuration</div></div>
      </div>

      <!-- Settings sub-tabs -->
      <div style="display:flex;gap:4px;padding:0 16px 0;border-bottom:1px solid var(--border);margin-bottom:0;">
        <button class="stab active" id="stab-usage"    onclick="showSettingsTab('usage')">💰 Usage</button>
        <button class="stab"        id="stab-security" onclick="showSettingsTab('security')">🔐 Security</button>
        <button class="stab"        id="stab-webhooks" onclick="showSettingsTab('webhooks')">🌐 Webhooks</button>
        <button class="stab"        id="stab-telegram" onclick="showSettingsTab('telegram')">📡 Telegram</button>
        <button class="stab"        id="stab-system"   onclick="showSettingsTab('system')">🛠 System</button>
      </div>

      <!-- Usage: Token stats + Spending caps -->
      <div id="stab-panel-usage" style="display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px;max-width:1100px;">

        <!-- Grand Total Banner -->
        <div class="card" style="grid-column:1/-1;background:linear-gradient(135deg,var(--bg-1) 0%,var(--bg-0) 100%);border:1px solid var(--border);">
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="font-size:14px;font-weight:700;color:var(--text-1);">&#x1F4CA; Total Spend</span>
              <select id="grandTotalDays" style="font-size:11px;padding:3px 6px;" onchange="loadAllUsage()">
                <option value="1">Today</option>
                <option value="7">Last 7 days</option>
                <option value="14" selected>Last 14 days</option>
                <option value="30">Last 30 days</option>
              </select>
            </div>
            <div style="display:flex;gap:24px;flex-wrap:wrap;" id="grandTotalWidget">
              <div style="text-align:center;"><div style="font-size:11px;color:var(--text-3);">Agents (direct)</div><div style="font-size:20px;font-weight:700;color:var(--accent);" id="gtAgentCost">—</div></div>
              <div style="text-align:center;font-size:20px;color:var(--text-3);line-height:2;">+</div>
              <div style="text-align:center;"><div style="font-size:11px;color:var(--text-3);">OpenCode</div><div style="font-size:20px;font-weight:700;color:var(--green);" id="gtOcCost">—</div></div>
              <div style="text-align:center;font-size:20px;color:var(--text-3);line-height:2;">=</div>
              <div style="text-align:center;"><div style="font-size:11px;color:var(--text-3);">Grand Total</div><div style="font-size:22px;font-weight:800;color:var(--yellow,#fbbf24);" id="gtTotal">—</div></div>
            </div>
          </div>
        </div>

        <!-- Token Usage (all-time breakdown) -->
        <div class="card">
          <div class="card-title" style="margin-bottom:16px;">&#x1F4B0; Token Usage <span style="font-size:11px;font-weight:400;color:var(--text-3);">(direct LLM calls)</span></div>
          <div id="tokenUsageWidget"><div style="color:var(--text-3);font-size:12px;">Loading&#x2026;</div></div>
        </div>

        <!-- Agent Spending with time range -->
        <div class="card">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
            <div class="card-title" style="margin:0;">&#x1F4B8; Agent Spending</div>
            <select id="spendingDays" style="font-size:11px;padding:3px 6px;" onchange="loadSpending()">
              <option value="1" selected>Today</option>
              <option value="7">Last 7 days</option>
              <option value="14">Last 14 days</option>
              <option value="30">Last 30 days</option>
            </select>
          </div>
          <div id="spendingWidget" style="font-size:12px;">Loading&#x2026;</div>
          <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">
            <button onclick="loadSpending()" class="btn-ghost" style="font-size:11px;">&#x21BB; Refresh</button>
            <button onclick="resetSpending()" class="btn-ghost" style="font-size:11px;color:var(--red);">Reset Today</button>
          </div>
          <div style="margin-top:16px;border-top:1px solid var(--border);padding-top:12px;">
            <div style="font-size:11px;font-weight:600;color:var(--text-2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.06em;">Global Daily Caps</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
              <div>
                <label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:3px;">Token limit</label>
                <input id="gcapTokens" type="number" placeholder="e.g. 500000" />
              </div>
              <div>
                <label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:3px;">Cost limit (USD)</label>
                <input id="gcapCost" type="number" step="0.01" placeholder="e.g. 5.00" />
              </div>
            </div>
            <button onclick="saveGlobalCaps()" class="btn-green" style="font-size:12px;">Save Caps</button>
          </div>
        </div>

        <!-- OpenCode Usage full width -->
        <div class="card" style="grid-column:1/-1;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
            <div class="card-title" style="margin:0;">&#x1F680; OpenCode Usage <span style="font-size:11px;font-weight:400;color:var(--text-3);">(OpenCode DB &#x2014; all agents + Cursor sessions)</span></div>
            <div style="display:flex;gap:6px;align-items:center;">
              <select id="ocStatsDays" style="font-size:11px;padding:3px 6px;" onchange="loadOcStats()">
                <option value="7">Last 7 days</option>
                <option value="14" selected>Last 14 days</option>
                <option value="30">Last 30 days</option>
              </select>
              <button onclick="loadOcStats()" class="btn-ghost" style="font-size:11px;">&#x21BB; Refresh</button>
            </div>
          </div>
          <div id="ocStatsWidget"><div style="color:var(--text-3);font-size:12px;">Loading&#x2026;</div></div>
        </div>
      </div>

      <!-- Security: Command allowlist -->
      <div id="stab-panel-security" style="display:none;padding:16px;max-width:800px;">
        <div class="card">
          <div class="card-title" style="margin-bottom:6px;">🔐 Command Allowlist</div>
          <div style="font-size:11px;color:var(--text-3);margin-bottom:12px;line-height:1.5;">
            Patterns here auto-approve agent <code style="background:var(--bg-1);padding:1px 5px;border-radius:3px;">@@RUN_CMD</code> calls — no toast, no wait.
            Dangerous commands (<code style="background:var(--bg-1);padding:1px 5px;border-radius:3px;">rm -rf</code>, <code style="background:var(--bg-1);padding:1px 5px;border-radius:3px;">sudo</code>, <code style="background:var(--bg-1);padding:1px 5px;border-radius:3px;">curl|bash</code>) are always blocked.
          </div>
          <div style="font-size:11px;font-weight:600;color:var(--text-2);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.06em;">Quick presets</div>
          <div id="cmdPresets" style="display:flex;flex-direction:column;gap:5px;margin-bottom:14px;"></div>
          <div style="font-size:11px;font-weight:600;color:var(--text-2);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.06em;">Active patterns</div>
          <div id="cmdAllowlistItems" style="min-height:24px;margin-bottom:12px;"></div>
          <div style="display:flex;gap:6px;">
            <input id="cmdAllowlistInput" placeholder="Custom pattern, e.g. make *" style="flex:1;font-size:12px;" onkeydown="if(event.key==='Enter')addAllowlistPattern();" />
            <button onclick="addAllowlistPattern()" class="btn-green" style="font-size:12px;padding:7px 12px;">Add</button>
          </div>
        </div>
      </div>

      <!-- Webhooks: Inbound webhooks -->
      <div id="stab-panel-webhooks" style="display:none;padding:16px;max-width:800px;">
        <div class="card">
          <div class="card-title" style="margin-bottom:10px;">🌐 Inbound Webhooks</div>
          <div style="font-size:12px;color:var(--text-3);margin-bottom:12px;line-height:1.5;">
            External services can push events to the RT bus via:<br>
            <code style="background:var(--bg-1);padding:1px 5px;border-radius:3px;">POST http://127.0.0.1:5010/webhook/{channel}</code><br>
            Any JSON payload is accepted and published to <code style="background:var(--bg-1);padding:1px 5px;border-radius:3px;">webhook.{channel}</code> on the RT bus and broadcasts to the dashboard.
          </div>
          <div style="margin-bottom:12px;">
            <div style="font-size:11px;font-weight:600;color:var(--text-2);margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em;">Test webhook</div>
            <div style="display:flex;gap:8px;margin-bottom:8px;">
              <input id="webhookChannel" placeholder="channel name (e.g. n8n)" style="flex:1;" />
              <input id="webhookPayload" placeholder='{"event":"test"}' style="flex:2;" />
            </div>
            <button onclick="sendTestWebhook()" class="btn-ghost" style="font-size:12px;">Send</button>
            <div id="webhookTestResult" style="margin-top:8px;font-size:12px;color:var(--text-3);"></div>
          </div>
          <div style="border-top:1px solid var(--border);padding-top:12px;">
            <div style="font-size:11px;font-weight:600;color:var(--text-2);margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em;">Recent events</div>
            <div id="webhookEvents" style="font-size:12px;color:var(--text-3);max-height:200px;overflow:auto;">—</div>
          </div>
        </div>
      </div>

      <!-- Telegram -->
      <div id="stab-panel-telegram" style="display:none;padding:16px;max-width:900px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <div>
            <div style="font-size:16px;font-weight:700;">📡 Telegram</div>
            <div style="font-size:12px;color:var(--text-3);">Telegram sessions, bot config, and live RT feed</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            <span id="tgStatusBadge" class="status-badge status-stopped">● stopped</span>
            <button onclick="startTgBridge()" class="btn-green" id="tgStartBtn">▶ Start</button>
            <button onclick="stopTgBridge()" class="btn-red" id="tgStopBtn">⏹ Stop</button>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:320px 1fr;gap:16px;">
          <div style="display:flex;flex-direction:column;gap:14px;">
            <div class="card" style="align-self:start;">
              <div class="card-title" style="margin-bottom:12px;">⚙️ Bot Configuration</div>
              <label style="display:block;margin-bottom:6px;font-size:12px;color:var(--text-2);">Telegram Bot Token</label>
              <input id="tgTokenInput" type="password" autocomplete="new-password" placeholder="123456:ABCdef..." style="width:100%;margin-bottom:12px;" />
              <label style="display:block;margin-bottom:6px;font-size:12px;color:var(--text-2);">Allowed chat IDs <span style="color:var(--text-3);font-weight:400;">(comma-separated)</span></label>
              <input id="tgAllowedIds" placeholder="1693963111, 987654321" style="width:100%;margin-bottom:12px;" />
              <div id="tgContactNamesList" style="margin-bottom:12px;"></div>
              <button onclick="saveTgConfig()" class="btn-green" style="width:100%;margin-bottom:8px;">Save config</button>
              <div style="font-size:11px;color:var(--text-3);line-height:1.5;margin-top:4px;">
                Each Telegram chat gets its own isolated session in crew-lead.<br/>
                Add contact names below so the crew can message by name (e.g. TELEGRAM at-Jeff hello).<br/>
                Get a token from <a href="https://t.me/BotFather" target="_blank" style="color:var(--accent);">@BotFather</a>.
              </div>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:14px;">
            <div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                <div>
                  <div style="font-size:13px;font-weight:600;">Telegram Conversations</div>
                  <div style="font-size:11px;color:var(--text-3);">Each chat ID gets an isolated session with crew-lead</div>
                </div>
                <button onclick="loadTelegramSessions()" class="btn-ghost" style="font-size:12px;">↻ Refresh</button>
              </div>
              <div id="tgSessionsList" style="max-height:300px;overflow-y:auto;"></div>
            </div>
            <div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                <div>
                  <div style="font-size:13px;font-weight:600;">RT Bus Activity</div>
                  <div style="font-size:11px;color:var(--text-3);">Read-only — watch agents work in real time</div>
                </div>
                <button onclick="loadTgMessages()" class="btn-ghost" style="font-size:12px;">↻ Refresh</button>
              </div>
              <div id="tgMessageFeed" style="display:flex;flex-direction:column;gap:8px;max-height:calc(100vh - 400px);overflow-y:auto;"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- System: OpenCode dir + fallback -->
      <div id="stab-panel-system" style="display:none;padding:16px;max-width:800px;">
        <div class="card">
          <div class="card-title" style="margin-bottom:6px;">📂 OpenCode Project Directory</div>
          <div style="font-size:11px;color:var(--text-3);margin-bottom:12px;line-height:1.5;">
            Agents that use OpenCode will write files here. Set this to your project folder so agents don't hit external-directory permission errors.
            Leave blank to use the CrewSwarm repo directory (default).
          </div>
          <div style="display:flex;gap:6px;align-items:center;">
            <input id="opencodeProjInput" placeholder="e.g. /Users/you/Desktop/myproject" style="flex:1;font-size:13px;font-family:monospace;" />
            <button onclick="saveOpencodeSettings()" class="btn-green" style="font-size:12px;padding:7px 14px;">Save</button>
          </div>
          <div id="opencodeProjStatus" style="margin-top:8px;font-size:12px;color:var(--text-3);"></div>
        </div>
        <div class="card" style="margin-top:16px;">
          <div class="card-title" style="margin-bottom:6px;">⚡ OpenCode Fallback Model</div>
          <div style="font-size:11px;color:var(--text-3);margin-bottom:12px;line-height:1.5;">
            When the primary model hits rate limits, OpenCode retries with this model. Use a different provider (e.g. groq) to avoid the same limit.
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
            <select id="opencodeFallbackSelect" style="flex:1;min-width:280px;font-size:13px;font-family:monospace;"></select>
            <button onclick="saveOpencodeSettings()" class="btn-green" style="font-size:12px;padding:7px 14px;">Save</button>
          </div>
          <div id="opencodeFallbackStatus" style="margin-top:8px;font-size:12px;color:var(--text-3);"></div>
        </div>

        <div class="card" style="margin-top:16px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
            <div>
              <div class="card-title" style="margin-bottom:2px;">🌐 Global Fallback Model</div>
              <div style="font-size:11px;color:var(--text-3);line-height:1.5;">Applied to any agent that has no per-agent fallback set. Prevents jobs dying on rate limits or hangs.</div>
            </div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
            <input id="globalFallbackInput" placeholder="e.g. groq/llama-3.3-70b-versatile" style="flex:1;font-size:13px;font-family:monospace;" />
            <button onclick="saveGlobalFallback()" class="btn-green" style="font-size:12px;padding:7px 14px;">Save</button>
          </div>
          <div id="globalFallbackStatus" style="margin-top:8px;font-size:12px;color:var(--text-3);"></div>
        </div>

        <div class="card" style="margin-top:16px;">
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
            <div>
              <div class="card-title" style="margin-bottom:2px;">🧠 Background Consciousness</div>
              <div style="font-size:11px;color:var(--text-3);line-height:1.5;">
                When idle, crew-lead reflects on system state, surfaces blockers, and dispatches follow-ups automatically.
                Uses a cheap Groq model (llama-3.1-8b) — runs every 15 min when no pipelines are active.
              </div>
            </div>
            <button id="bgConsciousnessBtn" onclick="toggleBgConsciousness()" style="font-size:12px;font-weight:700;padding:8px 18px;border-radius:8px;cursor:pointer;border:1px solid var(--border);background:var(--surface-2);color:var(--text-2);white-space:nowrap;min-width:80px;">
              Loading…
            </button>
          </div>
          <div id="bgConsciousnessStatus" style="margin-top:8px;font-size:12px;color:var(--text-3);"></div>
        </div>
      </div>

    </div>

    <!-- Integrations -->
    <div class="view" id="skillsView">
      <div class="page-header">
        <div>
          <div class="page-title">Skills</div>
          <div class="page-sub">API skill definitions agents can call with @@SKILL</div>
        </div>
        <button onclick="showSkills()" class="btn-ghost" style="font-size:12px;">↻ Refresh</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px;max-width:1100px;">

        <!-- Skills -->
        <div class="card" style="grid-column:1/-1;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
            <div class="card-title">🔌 Skills</div>
            <button onclick="toggleAddSkill()" class="btn-purple" style="font-size:12px;">+ Add Skill</button>
          </div>
          <div style="font-size:12px;color:var(--text-3);margin-bottom:14px;line-height:1.5;">
            Skills let agents call external APIs with <code style="background:var(--bg-1);padding:1px 5px;border-radius:3px;">@@SKILL skillname {params}</code>.
            Store skill definitions in <code style="background:var(--bg-1);padding:1px 5px;border-radius:3px;">~/.crewswarm/skills/</code>.
          </div>

          <!-- Search -->
          <input id="skillSearch" placeholder="Search skills…" oninput="filterSkills(this.value)" style="width:100%;margin-bottom:14px;font-size:13px;" />

          <!-- Add / Edit skill form -->
          <div id="addSkillForm" style="display:none;border:1px solid var(--border);border-radius:var(--radius);padding:14px;margin-bottom:14px;background:var(--bg-2);">
            <input type="hidden" id="skEditName" value="" />
            <div class="card-title" style="font-size:13px;margin-bottom:10px;" id="addSkillFormTitle">New Skill</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
              <div>
                <label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:4px;">Skill Name</label>
                <input id="skName" placeholder="e.g. twitter.post" />
              </div>
              <div>
                <label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:4px;">Description</label>
                <input id="skDesc" placeholder="What this skill does" />
              </div>
            </div>
            <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px;margin-bottom:10px;">
              <div>
                <label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:4px;">URL</label>
                <input id="skUrl" placeholder="https://api.example.com/endpoint/{param}" />
              </div>
              <div>
                <label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:4px;">Method</label>
                <select id="skMethod"><option>POST</option><option>GET</option><option>PUT</option><option>PATCH</option><option>DELETE</option></select>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px;">
              <div>
                <label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:4px;">Auth Type</label>
                <select id="skAuthType" onchange="updateSkillAuthFields()"><option value="">None</option><option value="bearer">Bearer token</option><option value="header">Custom header</option></select>
              </div>
              <div>
                <label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:4px;">API Key (or config path)</label>
                <input id="skAuthKey" placeholder="sk-... or providers.groq.apiKey" />
              </div>
              <div id="skAuthHeaderWrap" style="display:none;">
                <label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:4px;">Header Name</label>
                <input id="skAuthHeader" placeholder="X-API-Key" />
              </div>
            </div>
            <div style="margin-bottom:10px;">
              <label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:4px;">Default Params (JSON)</label>
              <textarea id="skDefaults" rows="2" placeholder='{"model":"gpt-4o"}'></textarea>
            </div>
            <div style="display:flex;align-items:center;gap:16px;margin-bottom:12px;">
              <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;">
                <input type="checkbox" id="skRequiresApproval" /> Requires human approval before executing
              </label>
            </div>
            <div style="display:flex;gap:8px;">
              <button onclick="saveSkill()" class="btn-green" id="saveSkillBtn">Save Skill</button>
              <button onclick="cancelSkillForm()" class="btn-ghost">Cancel</button>
            </div>
          </div>

          <div id="skillsList" style="display:grid;gap:8px;"></div>
        </div>

        <!-- Pending approvals -->
        <div class="card" style="grid-column:1/-1;" id="pendingApprovalsCard">
          <div class="card-title" style="margin-bottom:10px;">🔔 Pending Skill Approvals</div>
          <div id="pendingApprovals" style="font-size:12px;color:var(--text-3);">No pending approvals.</div>
        </div>

      </div>
    </div>

    <!-- Run skills — from health snapshot; fire via /api/skills/:name/run -->
    <div class="view" id="runSkillsView">
      <div class="page-header">
        <div>
          <div class="page-title">Run skills</div>
          <div class="page-sub">Installed skills from the health snapshot. Enter params and run on demand (same API agents use with @@SKILL).</div>
        </div>
        <button onclick="loadRunSkills()" class="btn-ghost" style="font-size:12px;">↻ Refresh</button>
      </div>
      <div id="runSkillsGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px;padding:16px;"></div>
    </div>

    <!-- Benchmarks — ZeroEval / llm-stats leaderboards -->
    <div class="view" id="benchmarksView">
      <div class="page-header">
        <div>
          <div class="page-title">Benchmarks</div>
          <div class="page-sub">LLM leaderboard data from <a href="https://llm-stats.com" target="_blank" rel="noopener" style="color:var(--accent);">llm-stats.com</a> — compare models on SWE-Bench Verified, LiveCodeBench, and more</div>
        </div>
        <button onclick="loadBenchmarks()" class="btn-ghost" style="font-size:12px;">↻ Refresh</button>
      </div>
      <div style="padding:16px;display:flex;flex-direction:column;gap:16px;">
        <div class="card" style="max-width:400px;">
          <label style="font-weight:600;font-size:13px;">Benchmark</label>
          <select id="benchmarkSelect" onchange="loadBenchmarkLeaderboard(this.value)" style="width:100%;margin-top:6px;padding:8px 12px;">
            <option value="">— Pick benchmark —</option>
          </select>
        </div>
        <div id="benchmarkMeta" style="font-size:12px;color:var(--text-2);display:none;"></div>
        <div id="benchmarkTable" class="card" style="overflow:auto;"></div>
      </div>
    </div>

    <!-- Tool Matrix — agents × tools from health + quick restart -->
    <div class="view" id="toolMatrixView">
      <div class="page-header">
        <div>
          <div class="page-title">Tool Matrix</div>
          <div class="page-sub">Who can read/write/run at a glance. Restart a bridge from here when it misbehaves.</div>
        </div>
        <button onclick="loadToolMatrix()" class="btn-ghost" style="font-size:12px;">↻ Refresh</button>
      </div>
      <div id="taskLifecycleContainer" style="padding:0 16px 12px;"></div>
      <div id="toolMatrixContainer" style="padding:16px;"></div>
    </div>

    <!-- Build -->
    <div class="view" id="buildView">
      <div style="max-width:800px; margin:0 auto;">
        <div class="page-header">
          <div><div class="page-title">Build</div><div class="page-sub">Select a project, describe what to build, and kick off the crew</div></div>
        </div>

        <!-- Project picker -->
        <div class="card" style="margin-bottom:12px;">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <label style="font-weight:600;font-size:13px;white-space:nowrap;">Project</label>
            <select id="buildProjectPicker" style="flex:1;min-width:180px;" onchange="onBuildProjectChange()">
              <option value="">— No project (use defaults) —</option>
            </select>
            <a href="#" onclick="showProjects(); return false;" style="font-size:12px;color:var(--accent);text-decoration:none;white-space:nowrap;">+ New project</a>
            <button onclick="loadBuildProjectPicker()" class="btn-ghost" style="font-size:12px;padding:4px 8px;">↻</button>
          </div>
          <div id="buildProjectInfo" style="display:none;margin-top:10px;font-size:12px;color:var(--text-2);background:var(--bg-card2);border-radius:6px;padding:8px 12px;font-family:monospace;line-height:1.6;"></div>
        </div>

        <!-- Requirement + run buttons -->
        <div class="card">
          <h3 style="margin-bottom:10px;">Requirement</h3>
          <textarea id="buildRequirement" rows="4" placeholder="One sentence or full spec. e.g. Build a REST API with auth, CRUD endpoints, and tests. The PM will plan it and dispatch to the crew."></textarea>
          <div style="margin-top:12px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            <button id="runBuildBtn" class="send-btn" title="Run one full phased build (MVP → Phase 1 → Phase 2)">▶ Run Build</button>
            <button id="stopBuildBtn" class="btn-red" style="display:none;" title="Stop the running build">⏹ Stop Build</button>
            <button id="continuousBuildBtn" style="background:var(--accent); color:#000;" title="Keep building until the roadmap is empty">🔁 Build Until Done</button>
            <button id="stopContinuousBtn" class="btn-red" style="display:none;" title="Stop continuous build">⏹ Stop</button>
            <button id="enhancePromptBtn" class="btn-purple" title="AI-enhance your requirement">✨ Enhance</button>
            <span class="meta" id="buildStatus"></span>
          </div>
          <div id="buildLiveLog" style="display:none; margin-top:14px;" class="log-block"></div>
          <div style="margin-top:10px;font-size:11px;color:var(--text-3);">
            <b>▶ Run Build</b> — one phased build (MVP→Ph1→Ph2), runs in background.
            <b>🔁 Build Until Done</b> — loops continuously until roadmap exhausted.
            <b>PM Loop ▶</b> — reads ROADMAP.md and dispatches each item one at a time.
          </div>
        </div>

        <div class="card">
          <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:4px;">
            <h3 style="margin:0;">Phased Progress</h3>
            <span id="phasedProgressLabel" style="font-size:11px;color:var(--text-3);"></span>
          </div>
          <p class="meta" style="margin-bottom:10px;">Task dispatch log — filtered to the selected project when one is chosen</p>
          <div id="phasedProgress" class="log-block mono" style="max-height:180px;"></div>
        </div>

        <hr class="divider" />

        <div class="card">
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px; flex-wrap:wrap;">
            <h3 style="margin:0;">PM Loop</h3>
            <span class="pm-badge" id="pmLoopBadge">idle</span>
          </div>
          <div id="pmLoopProjectLabel" style="font-size:12px; color:var(--text-2); margin-bottom:8px; padding:6px 10px; background:var(--bg-card2); border-radius:6px; border-left:3px solid var(--accent);">
            ← Select a project above
          </div>
          <p class="meta" style="margin-bottom:14px;">Reads the selected project's ROADMAP.md, dispatches one task at a time, self-extends when the roadmap empties.</p>
          <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px;">
            <button id="pmStartBtn" class="btn-green">▶ Start</button>
            <button id="pmStopBtn" class="btn-red">⏹ Stop</button>
            <button id="pmDryRunBtn" class="btn-muted">🔍 Dry run</button>
            <button id="pmRoadmapBtn" class="btn-ghost">📋 Roadmap</button>
            <span class="meta" id="pmStatus" style="align-self:center;"></span>
          </div>
          <div id="pmRoadmapPanel" style="display:none; margin-bottom:12px;" class="log-block mono" style="max-height:220px;"></div>
          <div id="pmLiveLog" style="display:none;" class="log-block green"></div>
        </div>
      </div>
    </div>

    <!-- ── Message bar — redirects to crew-lead chat ── -->
    <div class="msg-bar" style="justify-content:center;gap:12px;">
      <span style="font-size:13px;color:var(--text-2);">Talk to the crew via</span>
      <button onclick="showChat()" class="btn-green" style="font-size:13px;padding:8px 18px;">🧠 Chat with crew-lead</button>
    </div>
  </div>
<script>
let selected = null;
let agents = [];
const AGENT_RANK = {
  'crew-lead': 0,
  'orchestrator': 1, 'crew-main': 2,
  'crew-pm': 3, 'crew-architect': 4,
  'crew-coder': 5, 'crew-coder-back': 6, 'crew-coder-front': 7, 'crew-frontend': 8,
  'crew-ml': 9, 'crew-fixer': 10,
  'crew-qa': 11, 'crew-security': 12,
  'crew-researcher': 13, 'crew-copywriter': 14, 'crew-seo': 15,
  'crew-github': 16, 'crew-db-migrator': 17,
  'crew-telegram': 18, 'crew-mega': 19,
};
function sortAgents(arr) {
  return (arr || []).sort((a, b) => (AGENT_RANK[a.id] ?? 50) - (AGENT_RANK[b.id] ?? 50));
}
async function loadAgents() {
  try {
    agents = sortAgents(await getJSON('/api/agents'));
  } catch (e) { console.error('Failed to load agents:', e); }
}
async function getJSON(p){ const r = await fetch(p); if(!r.ok) throw new Error(await r.text()); return r.json(); }
async function postJSON(p, body){ const r = await fetch(p, { method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body) }); const txt = await r.text(); if(!r.ok) throw new Error(txt.slice(0,120)); try { return JSON.parse(txt); } catch { throw new Error('Bad response: ' + txt.slice(0,80)); } }
function showNotification(msg, type){ const d = document.createElement('div'); d.className = 'notification' + (type === 'error' || type === true ? ' error' : type === 'warning' ? ' warning' : ''); d.textContent = msg; document.body.appendChild(d); setTimeout(() => d.remove(), 4500); }
function fmt(ts){ try { return new Date(ts).toLocaleTimeString(); } catch { return String(ts); } }
function createdAt(info){ return (info && info.time && info.time.created) || ''; }
async function loadSessions(){
  try {
    const data = await getJSON('/api/sessions');
    const box = document.getElementById('sessions');
    box.innerHTML = '';
    if (!data.length) { box.innerHTML = '<div class="meta" style="padding:20px;">Sessions from OpenCode server (4096).</div>'; return; }
    if (!selected && data[0]) selected = data[0].id;
    // Crew agent from title: "[crew-fixer] ..." or "crew-fixer" (we prefix prompts with [agentId])
    function crewAgentFromTitle(title) {
      if (!title || typeof title !== 'string') return null;
      const m = title.match(/\[?(crew-\w+)\]?/);
      return m ? m[1] : null;
    }
    // Infer role from task keywords when slug is OpenCode codename (sunny-comet, calm-tiger)
    function inferAgentFromTitle(title) {
      if (!title || typeof title !== 'string') return null;
      const t = title;
      if (/\bFixer\b|fixer\s+task|fix\s+.*\.py|syntax\s+error/i.test(t)) return 'fixer';
      if (/\bQA\b|qa\s+audit|audit:/i.test(t)) return 'qa';
      if (/\bPM\b|crew-pm|roadmap\b/i.test(t)) return 'pm';
      if (/\bCoder\b|coder\s+task|frontend\b|backend\b/i.test(t)) return 'coder';
      if (/\bSecurity\b|security\s+review/i.test(t)) return 'security';
      if (/\bCopywriter\b|copy\s+task/i.test(t)) return 'copywriter';
      return null;
    }
    // OpenCode uses random adjective-noun slugs (sunny-comet, calm-tiger); they don't map to crew agents
    function isOpencodeCodename(slug) {
      return slug && /^[a-z]+-[a-z]+$/.test(slug) && !slug.startsWith('crew-');
    }
    data.forEach(s => {
      const div = document.createElement('div');
      div.className = 'row' + (s.id === selected ? ' active' : '');
      div.onclick = () => { selected = s.id; refreshAll(); };
      const crewAgent = crewAgentFromTitle(s.title || '');
      const inferred = inferAgentFromTitle(s.title || '');
      const slug = s.slug || '';
      const agent = crewAgent || (slug && !isOpencodeCodename(slug) ? slug : null) || inferred;
      const slugLabel = isOpencodeCodename(slug) ? ' (' + slug + ')' : '';
      const assigned = agent ? ('Assigned to: ' + agent + slugLabel) : (slug ? ('Assigned to: ' + slug + ' (OpenCode session)') : '');
      div.innerHTML = '<div><strong>' + (s.title || s.slug || s.id) + '</strong></div><div class="meta">' + (s.directory || '-') + '</div>' + (assigned ? '<div class="meta" style="font-size:11px;color:var(--accent);">' + assigned + '</div>' : '');
      box.appendChild(div);
    });
  } catch (e) { document.getElementById('sessions').innerHTML = '<div class="meta" style="padding:20px; color:#ef4444;">Error loading sessions.</div>'; }
}
async function loadMessages(){
  const box = document.getElementById('messages');
  if (!selected) { box.innerHTML = '<div class="meta">No session selected.</div>'; return; }
  try {
    const data = await getJSON('/api/messages?session=' + encodeURIComponent(selected));
    box.innerHTML = '';
    data.slice(-40).forEach(m => {
      const text = (m.parts || []).filter(p => p.type === 'text').map(p => p.text).join('').trim();
      if (!text) return;
      const div = document.createElement('div');
      div.className = 'msg ' + ((m.info && m.info.role) === 'assistant' ? 'a' : 'u');
      div.innerHTML = '<div class="meta">' + (m.info && m.info.role) + ' • ' + fmt(createdAt(m.info)) + '</div><div class="t"></div>';
      div.querySelector('.t').textContent = text;
      box.appendChild(div);
    });
    box.scrollTop = box.scrollHeight;
  } catch (e) { box.innerHTML = '<div class="meta">Error</div>'; }
}
async function loadRTMessages(){
  const box = document.getElementById('rtMessages');
  const rtView = document.getElementById('rtView');
  // Preserve scroll intent: if user scrolled up, remember their offset from the bottom
  const prevScrollFromBottom = rtView._userScrolledUp
    ? (rtView.scrollHeight - rtView.scrollTop)
    : null;
  const data = await getJSON('/api/rt-messages');
  box.innerHTML = '';
  const SKIP = new Set(['agent.heartbeat','agent.online','agent.offline']);
  data.forEach(m => {
    if (SKIP.has(m.type)) return;
    const payload = m.payload || {};
    let messageText = payload.reply || payload.prompt || payload.message || payload.content || '';
    if (!messageText || messageText === 'run_task') return;

    const isUser = m.from && (m.from === 'orchestrator' || m.from === 'PM Loop' || m.from === 'crew-lead' || m.from?.includes('main'));
    const div = document.createElement('div');
    div.className = 'msg ' + (isUser ? 'u' : 'a');

    // Safe meta header using DOM (avoids XSS from injected HTML in from/to)
    const meta = document.createElement('div');
    meta.className = 'meta';
    const fromEl = document.createElement('strong');
    fromEl.textContent = m.from || '?';
    const toEl = document.createElement('strong');
    toEl.textContent = m.to || '?';
    meta.appendChild(fromEl);
    meta.appendChild(document.createTextNode(' → '));
    meta.appendChild(toEl);
    const badge = document.createElement('span');
    badge.style.cssText = 'margin-left:8px;font-size:10px;opacity:.6;';
    badge.textContent = (m.type || '') + (m.ts ? ' · ' + new Date(m.ts).toLocaleTimeString() : '');
    meta.appendChild(badge);

    // Safe text body — collapsible if > 30 lines
    const COLLAPSE_LINES = 30;
    const lines = messageText.split("\\n");
    const isLong = lines.length > COLLAPSE_LINES;
    const body = document.createElement('div');
    body.className = 't';
    body.style.whiteSpace = 'pre-wrap';
    if (!isLong) {
      body.textContent = messageText;
    } else {
      const preview = lines.slice(0, COLLAPSE_LINES).join("\\n");
      const full = messageText;
      let expanded = false;
      const textNode = document.createTextNode(preview);
      body.appendChild(textNode);
      const toggle = document.createElement('button');
      toggle.style.cssText = 'display:block;margin-top:6px;background:none;border:1px solid var(--border);border-radius:6px;padding:3px 10px;font-size:11px;color:var(--accent);cursor:pointer;opacity:.8;';
      toggle.textContent = '▼ Show ' + (lines.length - COLLAPSE_LINES) + ' more lines';
      toggle.onclick = () => {
        expanded = !expanded;
        textNode.textContent = expanded ? full : preview;
        toggle.textContent = expanded ? '▲ Collapse' : '▼ Show ' + (lines.length - COLLAPSE_LINES) + ' more lines';
      };
      body.appendChild(toggle);
    }

    div.appendChild(meta);
    div.appendChild(body);
    box.appendChild(div);
  });
  if (!box.children.length) box.innerHTML = '<div class="meta" style="padding:20px;text-align:center;">No messages yet.</div>';
  const scrollBtn = document.getElementById('rtScrollBtn');
  const _rtAtBottom = () => rtView.scrollHeight - rtView.scrollTop - rtView.clientHeight < 120;
  // Restore position: if user had scrolled up, keep them at the same relative spot
  if (prevScrollFromBottom !== null) {
    rtView.scrollTop = rtView.scrollHeight - prevScrollFromBottom;
  } else {
    // User was at bottom (or first load) — scroll to bottom
    rtView.scrollTop = rtView.scrollHeight;
  }
  scrollBtn.style.display = _rtAtBottom() ? 'none' : 'block';
  // Bind scroll listener once to track user intent
  if (!rtView._scrollListenerBound) {
    rtView._scrollListenerBound = true;
    rtView.addEventListener('scroll', () => {
      const atBottom = _rtAtBottom();
      scrollBtn.style.display = atBottom ? 'none' : 'block';
      rtView._userScrolledUp = !atBottom;
    });
  }
}
async function loadDLQ(){
  const data = await getJSON('/api/dlq');
  const dlqBadgeEl = document.getElementById('dlqBadge');
  if (dlqBadgeEl) { dlqBadgeEl.textContent = data.length; dlqBadgeEl.classList.toggle('hidden', !data.length); }
  const box = document.getElementById('dlqMessages');
  box.innerHTML = data.length ? data.map(entry => {
    const key = entry.key || (entry.filename || '').replace('.json', '') || '?';
    return '<div class="msg dlq-item"><div class="meta"><strong>⚠️ Failed</strong> | ' + (entry.agent || '?') + ' | ' + (entry.failedAt ? new Date(entry.failedAt).toLocaleString() : '') + ' <button class="replay-btn" onclick="replayDLQ(&quot;' + key + '&quot;)">Replay</button></div><div class="t">' + (entry.error || '') + '</div></div>';
  }).join('') : '<div class="meta" style="padding:20px; text-align:center;">✓ DLQ empty</div>';
}
window.replayDLQ = async function(key){ if(!confirm('Replay?')) return; await postJSON('/api/dlq/replay', { key }); showNotification('Replayed'); loadDLQ(); };
async function refreshAll(){
  try {
    const dot = document.getElementById('statusDot');
    document.getElementById('status').textContent = 'online';
    dot.className = 'status-dot online';
    const dlqData = await getJSON('/api/dlq');
    const badge = document.getElementById('dlqBadge');
    if (dlqData.length) { badge.textContent = dlqData.length; badge.classList.remove('hidden'); }
    else { badge.classList.add('hidden'); }
    const active = document.querySelector('.view.active, .view-sessions.active');
    if (!active) return;
    if (active.id === 'dlqView') await loadDLQ();
    else if (active.id === 'rtView') await loadRTMessages();
    else if (active.id === 'sessionsView') { await loadSessions(); await loadMessages(); }
  } catch (e) {
    document.getElementById('status').textContent = 'error';
    document.getElementById('statusDot').className = 'status-dot error';
  }
}
function setNavActive(navId){
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  const el = document.getElementById(navId); if (el) el.classList.add('active');
}
function hideAllViews(){
  document.querySelectorAll('.view, .view-sessions').forEach(el => el.classList.remove('active'));
}
async function pickFolder(inputId) {
  const input = document.getElementById(inputId);
  const def = encodeURIComponent(input?.value || '${process.env.HOME}');
  const d = await getJSON('/api/pick-folder?default=' + def).catch(() => null);
  if (d?.path) { if (input) input.value = d.path; }
}
async function loadCrewLeadInfo() {
  try {
    const d = await getJSON('/api/agents-config');
    const cl = (d.agents || []).find(a => a.id === 'crew-lead');
    if (!cl) return;
    window._crewLeadInfo = { emoji: cl.emoji || '🧠', name: cl.name || 'crew-lead', theme: cl.theme || '' };
    const titleEl = document.getElementById('chatAgentTitle');
    const subEl   = document.getElementById('chatAgentSub');
    if (titleEl) titleEl.textContent = (cl.emoji || '🧠') + ' ' + (cl.name || 'Crew Lead');
    if (subEl && cl.theme) subEl.textContent = cl.theme + ' — chat naturally, dispatch tasks to the crew';
  } catch(e) { /* keep defaults */ }
}

async function showChat(){
  hideAllViews();
  document.getElementById('chatView').classList.add('active');
  setNavActive('navChat');
  _chatActiveProjectId = getStoredChatProjectId();
  const sel = document.getElementById('chatProjectSelect');
  if (sel && _chatActiveProjectId && sel.querySelector('option[value="' + _chatActiveProjectId + '"]')) sel.value = _chatActiveProjectId;
  checkCrewLeadStatus();
  startAgentReplyListener();
  loadCrewLeadInfo();
  await loadChatHistory();
}
async function loadChatHistory() {
  try {
    const d = await getJSON('/api/crew-lead/history?sessionId=' + encodeURIComponent(chatSessionId));
    const box = document.getElementById('chatMessages');
    if (!d.history || !d.history.length) return;
    box.innerHTML = '';
    lastAppendedAssistantContent = '';
    lastAppendedUserContent = '';
    d.history.forEach(h => {
      appendChatBubble(h.role === 'user' ? 'user' : 'assistant', h.content);
      if (h.role === 'assistant') lastAppendedAssistantContent = h.content;
      if (h.role === 'user') lastAppendedUserContent = h.content;
    });
    box.scrollTop = box.scrollHeight;
  } catch {}
}
function showSwarm(){
  hideAllViews();
  document.getElementById('sessionsView').classList.add('active');
  setNavActive('navSwarm');
  loadSessions(); loadMessages();
}
function showRT(){
  hideAllViews();
  document.getElementById('rtView').classList.add('active');
  setNavActive('navRT');
  loadRTMessages();
  // Hide scroll btn until user has had a chance to scroll up
  const scrollBtn = document.getElementById('rtScrollBtn');
  if (scrollBtn) scrollBtn.style.display = 'none';
}
function showDLQ(){
  hideAllViews();
  document.getElementById('dlqView').classList.add('active');
  setNavActive('navDLQ');
  loadDLQ();
}
function showFiles(){
  hideAllViews();
  document.getElementById('filesView').classList.add('active');
  setNavActive('navFiles');
  loadFiles();
}

// ── Chat / crew-lead ──────────────────────────────────────────────────────────
const chatSessionId = 'owner'; // shared with Telegram — one conversation, one memory
let chatPollInterval = null;
let agentReplySSE = null;

function startAgentReplyListener() {
  if (agentReplySSE) return; // already listening
  agentReplySSE = new EventSource('/api/crew-lead/events');
  agentReplySSE.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      const box = document.getElementById('chatMessages');
      if (d.type === 'draft_discarded' && d.draftId) {
        const el = document.querySelector('[data-draft-id="' + d.draftId + '"]');
        if (el) el.remove();
        return;
      }
      if (d.type === 'chat_message' && d.sessionId === chatSessionId) {
        if (d.role === 'user') {
          if (d.content !== lastAppendedUserContent) {
            appendChatBubble('user', d.content);
            lastAppendedUserContent = d.content;
          }
          if (d.content === lastSentContent) lastSentContent = null;
        } else if (d.role === 'assistant') {
          document.querySelectorAll('[id^="typing-"]').forEach(el => el.remove());
          if (d.content !== lastAppendedAssistantContent) {
            appendChatBubble('assistant', d.content);
            lastAppendedAssistantContent = d.content;
          }
        }
        if (box) box.scrollTop = box.scrollHeight;
        return;
      }
      if (d.type === 'pending_project' && d.sessionId === chatSessionId && d.pendingProject && box) {
        appendRoadmapCard(box, d.pendingProject);
        box.scrollTop = box.scrollHeight;
        return;
      }
      // agent_working from OpenCode bridge — show pulsing coding dot on agent card
      if (d.type === 'agent_working' && d.agent) {
        const dot = document.getElementById('coding-dot-' + d.agent);
        if (dot) dot.style.display = 'inline-flex';
      }
      // agent_idle from OpenCode bridge — hide coding dot
      if (d.type === 'agent_idle' && d.agent) {
        const dot = document.getElementById('coding-dot-' + d.agent);
        if (dot) dot.style.display = 'none';
      }
      // OpenCode serve live events — tool calls, file edits, session boundaries
      if (d.type === 'opencode_event') {
        const feed = document.getElementById('ocFeed');
        const liveDot = document.getElementById('ocFeedDot');
        if (!feed) return;
        if (liveDot) liveDot.style.display = 'inline-block';
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 10px;border-radius:8px;background:var(--bg-2);font-size:12px;font-family:var(--font-mono,monospace);animation:fadeIn .25s ease;';
        const time = new Date(d.ts || Date.now()).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
        let icon = '⚙️', label = '';
        if (d.kind === 'session_start') { icon = '▶'; row.style.borderLeft = '3px solid #22c55e'; var _sd = d.dir || ''; label = 'session started' + (_sd ? ' — ' + _sd.split('/').pop() : ''); }
        else if (d.kind === 'session_end') { icon = '■'; row.style.borderLeft = '3px solid var(--text-3)'; label = 'session ended'; if (liveDot) liveDot.style.display = 'none'; }
        else if (d.kind === 'file_edit') { icon = '✏️'; row.style.borderLeft = '3px solid #f59e0b'; label = (d.file || d.path || '') + (d.extra ? ' <span style="opacity:.5;">'+d.extra+'</span>' : ''); }
        else if (d.kind === 'error') { icon = '✗'; row.style.borderLeft = '3px solid #ef4444'; row.style.color = '#ef4444'; label = d.message || 'error'; }
        else if (d.kind === 'tool') {
          const toolColors = { read_file:'#60a5fa', write_file:'#f59e0b', bash:'#a78bfa', list_directory:'#6ee7b7', grep:'#6ee7b7' };
          const tc = toolColors[d.tool] || 'var(--text-2)';
          icon = d.phase === 'done' ? '✓' : '→';
          row.style.borderLeft = '3px solid ' + tc;
          row.style.color = d.phase === 'done' ? 'var(--text-2)' : 'var(--text-1)';
          label = '<span style="color:' + tc + ';font-weight:600;">' + (d.tool || '') + '</span>' + (d.label ? ' <span style="opacity:.6;">' + d.label + '</span>' : '');
        }
        row.innerHTML = '<span style="opacity:.4;flex-shrink:0;">' + time + '</span>' +
          '<span style="flex-shrink:0;">' + icon + '</span>' +
          '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + label + '</span>';
        feed.appendChild(row);
        // Cap at 80 rows
        while (feed.children.length > 80) feed.removeChild(feed.firstChild);
        feed.scrollTop = feed.scrollHeight;
        return;
      }
      // agent_working: crew-lead dispatched a task — show a "waiting" indicator
      if (d.type === 'agent_working' && d.agent) {
        const spinnerId = 'agent-spinner-' + (d.taskId || d.agent);
        if (box && !document.getElementById(spinnerId)) {
          const el = document.createElement('div');
          el.id = spinnerId;
          el.className = 'msg a';
          el.style.cssText = 'opacity:.7; font-style:italic;';
          el.innerHTML = '<div class="meta"><strong>' + d.agent + '</strong> · working…</div>' +
            '<div class="t" style="display:flex;align-items:center;gap:8px;">' +
            '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--accent);animation:pulse 1s ease-in-out infinite;"></span>' +
            'Processing task…</div>';
          box.appendChild(el);
          box.scrollTop = box.scrollHeight;
        }
        return;
      }
      // agent_reply: task completion from any crew member — replace spinner, show reply, notify
      if (d.type === 'agent_reply' || (d.from && d.content)) {
        if (!d.from || !d.content) return;
        const spinnerId = 'agent-spinner-' + (d.taskId || d.from);
        const spinnerEl = document.getElementById(spinnerId);
        if (spinnerEl) spinnerEl.remove();
        const agentSpinner = document.getElementById('agent-spinner-' + d.from);
        if (agentSpinner) agentSpinner.remove();
        appendChatBubble('🤖 ' + d.from, d.content, false);
        if (box) box.scrollTop = box.scrollHeight;
        showNotification(d.from + ' finished a task');
        return;
      }
      // task.timeout: dispatch never claimed or timed out — replace spinner with "No reply" message
      if (d.type === 'task.timeout' && d.agent) {
        const spinnerId = 'agent-spinner-' + (d.taskId || d.agent);
        const spinnerEl = document.getElementById(spinnerId);
        if (spinnerEl) spinnerEl.remove();
        const agentSpinner = document.getElementById('agent-spinner-' + d.agent);
        if (agentSpinner) agentSpinner.remove();
        const msg = '[crew-lead] Task to ' + d.agent + ' timed out (no reply in 90s). Consider @@SERVICE restart ' + d.agent + ' or re-dispatch to another agent.';
        if (box) {
          const el = document.createElement('div');
          el.className = 'msg a';
          el.style.cssText = 'opacity:.85; font-style:italic; color:var(--text-3);';
          el.innerHTML = '<div class="meta"><strong>' + d.agent + '</strong> · no reply</div><div class="t">' + escHtml(msg) + '</div>';
          box.appendChild(el);
          box.scrollTop = box.scrollHeight;
        }
        showNotification('Task to ' + d.agent + ' timed out');
        return;
      }
      // pipeline_progress: a wave or step dispatched
      if (d.type === 'pipeline_progress') {
        let label;
        if (d.agents) {
          label = 'Wave ' + (d.waveIndex + 1) + '/' + d.totalWaves + ' → ' + d.agents.join(' + ');
        } else {
          label = 'Step ' + (d.stepIndex + 1) + '/' + d.total + ' → ' + d.agent;
        }
        const el = document.createElement('div');
        el.style.cssText = 'font-size:11px;color:var(--text-3);padding:2px 8px;margin:2px 0;';
        el.textContent = '↳ ' + label;
        if (box) { box.appendChild(el); box.scrollTop = box.scrollHeight; }
        return;
      }
      // pipeline_quality_gate: wave had issues
      if (d.type === 'pipeline_quality_gate') {
        const el = document.createElement('div');
        const retryNote = d.willRetry ? ' — retrying wave' : ' — advancing anyway';
        el.style.cssText = 'font-size:11px;color:var(--warning, #e8a030);padding:2px 8px;margin:2px 0;';
        el.textContent = '⚠️ Wave ' + (d.waveIndex + 1) + ' quality gate: ' + (d.issues || []).join('; ') + retryNote;
        if (box) { box.appendChild(el); box.scrollTop = box.scrollHeight; }
        return;
      }
      // project_launched: new project registered — reload dropdown and auto-select
      if (d.type === 'project_launched' && d.project) {
        const newId = d.project.projectId || d.project.id;
        setTimeout(async () => {
          await loadProjects();
          if (newId) autoSelectChatProject(newId);
          const box = document.getElementById('chatMessages');
          if (box) {
            const el = document.createElement('div');
            el.style.cssText = 'font-size:11px;color:var(--green);padding:2px 8px;margin:2px 0;';
            el.textContent = '📁 Project "' + (d.project.name || newId) + '" registered — selected in chat';
            box.appendChild(el);
            box.scrollTop = box.scrollHeight;
          }
        }, 800);
        return;
      }
      // pipeline_done: all steps complete
      if (d.type === 'pipeline_done') {
        const el = document.createElement('div');
        el.style.cssText = 'font-size:11px;color:var(--green);padding:2px 8px;margin:2px 0;';
        el.textContent = '✅ Pipeline complete';
        if (box) { box.appendChild(el); box.scrollTop = box.scrollHeight; }
        return;
      }
      // confirm_run_cmd: an agent wants to run a shell command — show approval toast
      if (d.type === 'confirm_run_cmd' && d.approvalId) {
        showCmdApprovalToast(d.approvalId, d.agent, d.cmd);
        return;
      }
      // telemetry: task.lifecycle (schema 1.1) — keep list and refresh Task lifecycle panel if visible
      if (d.type === 'telemetry' && d.payload) {
        window._telemetryEvents = window._telemetryEvents || [];
        window._telemetryEvents.push(d.payload);
        if (window._telemetryEvents.length > 100) window._telemetryEvents.shift();
        const tlView = document.getElementById('toolMatrixView');
        if (tlView && tlView.classList.contains('active')) renderTaskLifecycle(window._telemetryEvents);
      }
    } catch {}
  };
  agentReplySSE.onopen = () => { window._sseReconnectDelay = 2000; };
  agentReplySSE.onerror = () => {
    agentReplySSE.close();
    agentReplySSE = null;
    // Reconnect with exponential backoff (2s → 4s → 8s → 30s max)
    if (window._sseReconnectTimer) clearTimeout(window._sseReconnectTimer);
    window._sseReconnectTimer = setTimeout(() => {
      window._sseReconnectTimer = null;
      window._sseReconnectDelay = Math.min((window._sseReconnectDelay || 2000) * 2, 30000);
      startAgentReplyListener();
    }, window._sseReconnectDelay || 2000);
  };
}

// ── Command approval toast ────────────────────────────────────────────────────

function showCmdApprovalToast(approvalId, agent, cmd) {
  const existing = document.getElementById('cmd-approval-' + approvalId);
  if (existing) return;

  const toast = document.createElement('div');
  toast.id = 'cmd-approval-' + approvalId;
  toast.style.cssText = [
    'position:fixed;bottom:80px;right:24px;z-index:9999;',
    'background:var(--bg-card);border:1px solid var(--border);border-radius:12px;',
    'padding:16px 20px;max-width:440px;box-shadow:0 8px 32px rgba(0,0,0,.4);',
    'display:flex;flex-direction:column;gap:10px;',
  ].join('');

  const header = document.createElement('div');
  header.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-1);';
  header.textContent = '🔐 ' + agent + ' wants to run a command';

  const cmdEl = document.createElement('code');
  cmdEl.style.cssText = 'display:block;font-size:12px;color:var(--accent);background:var(--bg-1);padding:6px 10px;border-radius:6px;word-break:break-all;';
  cmdEl.textContent = cmd;

  // "Always allow" toggle — infers pattern from first word of command
  const alwaysRow = document.createElement('label');
  alwaysRow.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-2);cursor:pointer;';
  const alwaysChk = document.createElement('input');
  alwaysChk.type = 'checkbox';
  alwaysChk.style.cssText = 'width:14px;height:14px;cursor:pointer;accent-color:var(--green);';
  const cmdBase = cmd.trim().split(/\s+/)[0];
  const suggestedPattern = cmdBase + ' *';
  alwaysRow.appendChild(alwaysChk);
  alwaysRow.appendChild(document.createTextNode('Always allow  '));
  const patternSpan = document.createElement('code');
  patternSpan.style.cssText = 'font-size:11px;background:var(--bg-1);padding:2px 6px;border-radius:4px;color:var(--accent);';
  patternSpan.textContent = suggestedPattern;
  alwaysRow.appendChild(patternSpan);

  const timer = document.createElement('div');
  timer.style.cssText = 'font-size:11px;color:var(--text-3);';
  let secs = 60;
  timer.textContent = 'Auto-reject in ' + secs + 's';
  const countdown = setInterval(() => {
    secs--;
    timer.textContent = 'Auto-reject in ' + secs + 's';
    if (secs <= 0) { clearInterval(countdown); toast.remove(); }
  }, 1000);

  const btns = document.createElement('div');
  btns.style.cssText = 'display:flex;gap:8px;';

  const approve = document.createElement('button');
  approve.textContent = '✅ Allow';
  approve.style.cssText = 'flex:1;padding:8px;border-radius:8px;border:none;background:var(--green);color:#fff;cursor:pointer;font-weight:600;font-size:13px;';
  approve.onclick = async () => {
    clearInterval(countdown);
    toast.remove();
    if (alwaysChk.checked) {
      await fetch('/api/cmd-allowlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pattern: suggestedPattern }) });
      showNotification('Allowlisted: ' + suggestedPattern);
    }
    await fetch('http://127.0.0.1:5010/approve-cmd', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvalId }) });
    if (!alwaysChk.checked) showNotification(agent + ': command approved');
  };

  const reject = document.createElement('button');
  reject.textContent = '⛔ Deny';
  reject.style.cssText = 'flex:1;padding:8px;border-radius:8px;border:none;background:var(--red,#ef4444);color:#fff;cursor:pointer;font-weight:600;font-size:13px;';
  reject.onclick = async () => {
    clearInterval(countdown);
    toast.remove();
    await fetch('http://127.0.0.1:5010/reject-cmd', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvalId }) });
    showNotification(agent + ': command denied');
  };

  btns.appendChild(approve);
  btns.appendChild(reject);
  toast.appendChild(header);
  toast.appendChild(cmdEl);
  toast.appendChild(alwaysRow);
  toast.appendChild(timer);
  toast.appendChild(btns);
  document.body.appendChild(toast);
}

// ── Cmd allowlist manager ──────────────────────────────────────────────────────

const CMD_PRESETS = [
  { label: 'npm',    pattern: 'npm *',        desc: 'install, run, build, test…' },
  { label: 'node',   pattern: 'node *',        desc: 'run any node script' },
  { label: 'python', pattern: 'python *',      desc: 'python / python3 scripts' },
  { label: 'pip',    pattern: 'pip *',         desc: 'pip install packages' },
  { label: 'git',    pattern: 'git *',         desc: 'all git operations' },
  { label: 'cursor', pattern: 'cursor *',      desc: 'open files in Cursor' },
  { label: 'make',   pattern: 'make *',        desc: 'Makefile targets' },
  { label: 'yarn',   pattern: 'yarn *',        desc: 'yarn install / build / run' },
  { label: 'pnpm',   pattern: 'pnpm *',        desc: 'pnpm package manager' },
  { label: 'ls / cat / echo', pattern: 'ls *', desc: 'read-only shell utilities' },
];

async function loadCmdAllowlist() {
  const box = document.getElementById('cmdAllowlistItems');
  const presetsBox = document.getElementById('cmdPresets');
  if (!box) return;

  const d = await getJSON('/api/cmd-allowlist').catch(() => ({ list: [] }));
  const list = d.list || [];

  // Render presets checklist (only when the presets container exists — Settings view)
  if (presetsBox) {
    presetsBox.innerHTML = '';
    CMD_PRESETS.forEach(function(preset) {
      const checked = list.includes(preset.pattern);
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;padding:4px 6px;border-radius:6px;transition:background 0.1s;';
      row.onmouseover = function(){ row.style.background = 'var(--bg-hover)'; };
      row.onmouseout  = function(){ row.style.background = ''; };

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = checked;
      chk.style.cssText = 'width:14px;height:14px;cursor:pointer;accent-color:var(--green);flex-shrink:0;';
      chk.onchange = async function() {
        if (chk.checked) {
          await fetch('/api/cmd-allowlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pattern: preset.pattern }) });
        } else {
          await fetch('/api/cmd-allowlist', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pattern: preset.pattern }) });
        }
        loadCmdAllowlist();
      };

      const nameEl = document.createElement('code');
      nameEl.style.cssText = 'font-size:12px;color:var(--accent);min-width:90px;';
      nameEl.textContent = preset.pattern;

      const descEl = document.createElement('span');
      descEl.style.cssText = 'font-size:11px;color:var(--text-3);';
      descEl.textContent = preset.desc;

      row.appendChild(chk);
      row.appendChild(nameEl);
      row.appendChild(descEl);
      presetsBox.appendChild(row);
    });
  }

  // Render active list (non-preset patterns only, or all if no presets box)
  const presetPatterns = new Set(CMD_PRESETS.map(function(p){ return p.pattern; }));
  const customPatterns = presetsBox ? list.filter(function(p){ return !presetPatterns.has(p); }) : list;

  box.innerHTML = '';
  if (!customPatterns.length) {
    box.innerHTML = '<div style="color:var(--text-3);font-size:12px;padding:4px 0;">' + (presetsBox ? 'No custom patterns yet.' : 'No patterns yet.') + '</div>';
    return;
  }
  for (const pattern of customPatterns) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);';
    const code = document.createElement('code');
    code.style.cssText = 'flex:1;font-size:12px;color:var(--accent);';
    code.textContent = pattern;
    const del = document.createElement('button');
    del.textContent = '✕';
    del.style.cssText = 'border:none;background:transparent;color:var(--text-3);cursor:pointer;font-size:14px;padding:0 4px;';
    del.title = 'Remove';
    del.onclick = async function() {
      await fetch('/api/cmd-allowlist', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pattern }) });
      loadCmdAllowlist();
    };
    row.appendChild(code);
    row.appendChild(del);
    box.appendChild(row);
  }
}

async function addAllowlistPattern() {
  const inp = document.getElementById('cmdAllowlistInput');
  const pattern = inp ? inp.value.trim() : '';
  if (!pattern) return;
  await fetch('/api/cmd-allowlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pattern }) });
  inp.value = '';
  loadCmdAllowlist();
}

// ── Telegram sessions viewer ──────────────────────────────────────────────────

async function loadTelegramSessions() {
  const box = document.getElementById('tgSessionsList');
  if (!box) return;
  const sessions = await getJSON('/api/telegram-sessions').catch(() => []);
  box.innerHTML = '';
  if (!sessions.length) {
    box.innerHTML = '<div style="color:var(--text-3);font-size:12px;padding:8px;">No Telegram sessions yet — send a message to your bot to start one.</div>';
    return;
  }
  for (const s of sessions) {
    const card = document.createElement('div');
    card.style.cssText = 'background:var(--bg-1);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:10px;';
    const ago = s.lastTs ? Math.round((Date.now() - s.lastTs) / 60000) + 'm ago' : 'unknown';
    const msgLines = s.messages.slice(-6).map(m => {
      const color = m.role === 'user' ? 'var(--accent)' : 'var(--green)';
      const icon  = m.role === 'user' ? '👤' : '🤖';
      const txt   = String(m.content || '').slice(0, 100).replace(/</g, '&lt;');
      return '<div style="margin-bottom:4px;"><span style="color:' + color + ';">' + icon + '</span> <span>' + txt + '</span></div>';
    }).join('');
    card.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
        '<span style="font-size:13px;font-weight:600;">chat ' + s.chatId + '</span>' +
        '<span style="font-size:11px;color:var(--text-3);">' + s.messageCount + ' msgs · ' + ago + '</span>' +
      '</div>' +
      '<div style="font-size:12px;color:var(--text-2);border-top:1px solid var(--border);padding-top:8px;max-height:120px;overflow-y:auto;">' +
        msgLines +
      '</div>';
    box.appendChild(card);
  }
}

// ── Token usage widget ────────────────────────────────────────────────────────

// Approximate cost per 1M tokens by model prefix (input / output)
// Keys matched via .includes() — more specific keys must come before general ones
const MODEL_COST_PER_M = {
  // ── xAI Grok (2026 pricing) ───────────────────────────────────────────────
  'grok-4-1-fast':         [0.20,  0.50],  // grok-4.1-fast + non-reasoning variant
  'grok-4-fast':           [0.20,  0.50],
  'grok-4':                [3.00, 15.00],
  'grok-3-mini':           [0.30,  0.50],
  'grok-3':                [3.00, 15.00],
  'grok-code-fast':        [0.20,  1.50],
  'grok-beta':             [5.00, 15.00],  // legacy
  // ── OpenAI gpt-5.x (via openai or openai-local proxy) ───────────────────
  'gpt-5.3-codex':         [2.50, 20.00],  // estimate — newer than 5.2
  'gpt-5.2-codex':         [1.75, 14.00],
  'gpt-5.2':               [1.75, 14.00],
  'gpt-5.1-codex-max':     [2.50, 20.00],  // estimate — max tier
  'gpt-5.1-codex-mini':    [0.25,  2.00],
  'gpt-5.1-codex':         [1.25, 10.00],
  'gpt-5.1':               [1.25, 10.00],
  'gpt-5-codex':           [1.25, 10.00],
  'gpt-5-nano':            [0.15,  0.60],  // estimate
  'gpt-5':                 [1.25, 10.00],
  'codex-mini':            [0.25,  2.00],
  // ── OpenAI legacy ────────────────────────────────────────────────────────
  'gpt-oss-120b':          [0.90,  0.90],  // Groq-hosted OSS model, estimate
  'gpt-oss-20b':           [0.20,  0.20],  // estimate
  'gpt-4o-mini':           [0.15,  0.60],
  'gpt-4o':                [2.50, 10.00],
  'gpt-4':                 [30.0, 60.00],
  // ── DeepSeek ─────────────────────────────────────────────────────────────
  'deepseek-reasoner':     [0.70,  2.50],  // R1
  'deepseek-chat':         [0.27,  1.10],
  // ── Mistral ──────────────────────────────────────────────────────────────
  'mistral-large':         [0.50,  1.50],  // mistral-large-latest = Large 3 2512 (Dec 2025)
  'mistral-small':         [0.10,  0.30],
  // ── Google Gemini ─────────────────────────────────────────────────────────
  'gemini-2.5-pro':        [1.25, 10.00],
  'gemini-2.5-flash':      [0.075, 0.30],
  'gemini-2.0-flash':      [0.10,  0.40],
  // ── Anthropic Claude ─────────────────────────────────────────────────────
  'claude-opus-4':         [15.0, 75.00],
  'claude-sonnet-4':       [3.00, 15.00],
  'claude-haiku-4':        [0.80,  4.00],
  'claude-3-5-haiku':      [0.80,  4.00],
  'claude-3-haiku':        [0.25,  1.25],
  'claude-3-5-sonnet':     [3.00, 15.00],
  'claude-3-7-sonnet':     [3.00, 15.00],
  // ── Groq-hosted (inference pricing) ──────────────────────────────────────
  'kimi-k2-instruct':      [1.00,  3.00],
  'kimi-k2':               [0.60,  2.50],
  'llama-4-maverick':      [0.50,  0.77],
  'llama-4-scout':         [0.11,  0.34],
  'llama-3.3-70b':         [0.59,  0.79],
  'llama-3.1-70b':         [0.59,  0.79],
  'llama3.1-70b':          [0.59,  0.79],
  'llama-3.1-8b':          [0.05,  0.08],
  'llama3.1-8b':           [0.10,  0.10],  // Cerebras pricing
  'qwen3-32b':             [0.29,  0.39],
  'llama-guard':           [0.20,  0.20],
  // ── Perplexity ───────────────────────────────────────────────────────────
  'sonar-pro':             [3.00, 15.00],
  'sonar':                 [1.00,  1.00],
  // ── OpenCode free models ──────────────────────────────────────────────────
  'big-pickle':            [0.00,  0.00],  // free
  'trinity-large-preview': [0.00,  0.00],  // free
  'minimax-m2.5-free':     [0.00,  0.00],  // free
  'glm-':                  [0.10,  0.10],  // estimate
  'minimax':               [0.30,  1.00],  // estimate
  // ── Default fallback ─────────────────────────────────────────────────────
  'default':               [1.00,  3.00],
};

function estimateCost(byModel) {
  let total = 0;
  for (const [model, stats] of Object.entries(byModel || {})) {
    const rateKey = Object.keys(MODEL_COST_PER_M).find(k => model.toLowerCase().includes(k)) || 'default';
    const [inputRate, outputRate] = MODEL_COST_PER_M[rateKey];
    total += (stats.prompt / 1e6) * inputRate + (stats.completion / 1e6) * outputRate;
  }
  return total;
}

async function loadTokenUsage() {
  const box = document.getElementById('tokenUsageWidget');
  if (!box) return;
  const u = await getJSON('/api/token-usage').catch(() => ({}));
  const totalTokens = (u.prompt || 0) + (u.completion || 0);
  const cost = estimateCost(u.byModel);

  // ── Totals row ────────────────────────────────────────────────────────────
  let html =
    '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px;">' +
      '<div style="text-align:center;">' +
        '<div style="font-size:20px;font-weight:700;color:var(--accent);">' + (u.calls||0).toLocaleString() + '</div>' +
        '<div style="font-size:11px;color:var(--text-3);margin-top:2px;">LLM calls</div>' +
      '</div>' +
      '<div style="text-align:center;">' +
        '<div style="font-size:20px;font-weight:700;color:var(--green);">' + (totalTokens/1000).toFixed(1) + 'k</div>' +
        '<div style="font-size:11px;color:var(--text-3);margin-top:2px;">total tokens</div>' +
      '</div>' +
      '<div style="text-align:center;">' +
        '<div style="font-size:20px;font-weight:700;color:var(--yellow,#fbbf24);">$' + cost.toFixed(4) + '</div>' +
        '<div style="font-size:11px;color:var(--text-3);margin-top:2px;">est. cost (all-time)</div>' +
      '</div>' +
    '</div>';

  // ── Daily history ─────────────────────────────────────────────────────────
  const byDay = u.byDay || {};
  const days = Object.keys(byDay).sort().reverse().slice(0, 14);
  if (days.length) {
    const maxCost = Math.max(...days.map(function(d){ return estimateCost(byDay[d].byModel || {}); }), 0.0001);
    html += '<div style="font-size:11px;font-weight:600;color:var(--text-2);margin:12px 0 6px;">Daily cost (last ' + days.length + ' days)</div>';
    html += '<div style="display:flex;flex-direction:column;gap:3px;">';
    days.forEach(function(day) {
      const ds = byDay[day];
      const dc = estimateCost(ds.byModel || {});
      const pct = Math.max((dc / maxCost) * 100, 2);
      const tok = ((ds.prompt||0) + (ds.completion||0)) / 1000;
      const isToday = day === new Date().toISOString().slice(0, 10);
      html += '<div style="display:flex;align-items:center;gap:8px;font-size:11px;">' +
        '<span style="width:70px;color:var(--text-3);flex-shrink:0;">' + (isToday ? 'today' : day.slice(5)) + '</span>' +
        '<div style="flex:1;background:var(--bg-1);border-radius:3px;height:14px;overflow:hidden;">' +
          '<div style="width:' + pct.toFixed(1) + '%;height:100%;background:' + (isToday ? 'var(--accent)' : 'var(--green)') + ';border-radius:3px;"></div>' +
        '</div>' +
        '<span style="width:52px;text-align:right;color:var(--yellow,#fbbf24);font-weight:600;">$' + dc.toFixed(4) + '</span>' +
        '<span style="width:44px;text-align:right;color:var(--text-3);">' + tok.toFixed(1) + 'k</span>' +
      '</div>';
    });
    html += '</div>';
  } else {
    html += '<div style="font-size:11px;color:var(--text-3);margin-top:8px;">No daily history yet — data accumulates with next LLM call after restart.</div>';
  }

  // ── By model (all-time) ───────────────────────────────────────────────────
  if (Object.keys(u.byModel||{}).length) {
    html += '<div style="font-size:11px;color:var(--text-3);margin:12px 0 6px;">By model (all-time)</div>';
    Object.entries(u.byModel||{})
      .sort((a,b) => (b[1].prompt+b[1].completion) - (a[1].prompt+a[1].completion))
      .forEach(function(entry) {
        const model = entry[0], s = entry[1];
        const rateKey = Object.keys(MODEL_COST_PER_M).find(function(k){ return model.toLowerCase().includes(k); }) || 'default';
        const rates = MODEL_COST_PER_M[rateKey];
        const mc = (s.prompt/1e6)*rates[0] + (s.completion/1e6)*rates[1];
        html += '<div style="display:flex;justify-content:space-between;font-size:11px;padding:3px 0;border-bottom:1px solid var(--border);">' +
          '<code style="color:var(--accent);">' + model + '</code>' +
          '<span style="color:var(--text-2);">' + ((s.prompt+s.completion)/1000).toFixed(1) + 'k tok · $' + mc.toFixed(4) + '</span>' +
          '</div>';
      });
  }
  box.innerHTML = html;
}

async function loadOcStats() {
  const box = document.getElementById('ocStatsWidget');
  if (!box) return;
  const days = document.getElementById('ocStatsDays')?.value || '14';
  _ocTotalCost = null;
  box.innerHTML = '<div style="color:var(--text-3);font-size:12px;">Loading&#x2026;</div>';
  try {
    const d = await getJSON('/api/opencode-stats?days=' + days);
    if (!d.ok || !Object.keys(d.byDay||{}).length) {
      box.innerHTML = '<div style="color:var(--text-3);font-size:12px;">' + (d.error || 'No OpenCode data found') + '</div>';
      return;
    }
    const byDay = d.byDay;
    const sortedDays = Object.keys(byDay).sort().reverse();
    const totalCost = sortedDays.reduce(function(s,day){ return s + byDay[day].cost; }, 0);
    const totalIn   = sortedDays.reduce(function(s,day){ return s + byDay[day].input_tok; }, 0);
    const totalOut  = sortedDays.reduce(function(s,day){ return s + byDay[day].output_tok; }, 0);
    const totalCalls= sortedDays.reduce(function(s,day){ return s + byDay[day].calls; }, 0);
    const maxCost   = Math.max(...sortedDays.map(function(d){ return byDay[d].cost; }), 0.0001);

    let html = '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px;">' +
      '<div style="text-align:center;"><div style="font-size:18px;font-weight:700;color:var(--yellow,#fbbf24);">$' + totalCost.toFixed(4) + '</div><div style="font-size:11px;color:var(--text-3);">total cost</div></div>' +
      '<div style="text-align:center;"><div style="font-size:18px;font-weight:700;color:var(--accent);">' + totalCalls.toLocaleString() + '</div><div style="font-size:11px;color:var(--text-3);">messages</div></div>' +
      '<div style="text-align:center;"><div style="font-size:18px;font-weight:700;color:var(--green);">' + (totalIn/1e6).toFixed(1) + 'M</div><div style="font-size:11px;color:var(--text-3);">input tokens</div></div>' +
      '<div style="text-align:center;"><div style="font-size:18px;font-weight:700;color:var(--green);">' + (totalOut/1e6).toFixed(2) + 'M</div><div style="font-size:11px;color:var(--text-3);">output tokens</div></div>' +
    '</div>';

    // Daily bars
    html += '<div style="display:flex;flex-direction:column;gap:4px;margin-bottom:16px;">';
    const today = new Date().toISOString().slice(0,10);
    sortedDays.forEach(function(day) {
      const ds = byDay[day];
      const pct = Math.max((ds.cost / maxCost) * 100, ds.cost > 0 ? 2 : 0);
      const isToday = day === today;
      const tok = (ds.input_tok + ds.output_tok) / 1e6;
      html += '<div style="display:flex;align-items:center;gap:8px;font-size:11px;">' +
        '<span style="width:70px;color:var(--text-3);flex-shrink:0;">' + (isToday ? 'today' : day.slice(5)) + '</span>' +
        '<div style="flex:1;background:var(--bg-1);border-radius:3px;height:16px;overflow:hidden;">' +
          '<div style="width:' + pct.toFixed(1) + '%;height:100%;background:' + (isToday ? 'var(--accent)' : 'var(--green)') + ';border-radius:3px;opacity:0.85;"></div>' +
        '</div>' +
        '<span style="width:60px;text-align:right;color:var(--yellow,#fbbf24);font-weight:600;">$' + ds.cost.toFixed(4) + '</span>' +
        '<span style="width:50px;text-align:right;color:var(--text-3);">' + tok.toFixed(2) + 'M</span>' +
        '<span style="width:36px;text-align:right;color:var(--text-3);">' + ds.calls + '</span>' +
      '</div>';
    });
    html += '</div>';

    // All models across period
    const allModels = {};
    sortedDays.forEach(function(day) {
      Object.entries(byDay[day].byModel||{}).forEach(function(e) {
        const m = e[0], s = e[1];
        if (!allModels[m]) allModels[m] = { cost:0, input_tok:0, output_tok:0, calls:0 };
        allModels[m].cost += s.cost;
        allModels[m].input_tok += s.input_tok;
        allModels[m].output_tok += s.output_tok;
        allModels[m].calls += s.calls;
      });
    });
    const sortedModels = Object.entries(allModels).sort(function(a,b){ return b[1].cost - a[1].cost; });
    if (sortedModels.length) {
      html += '<div style="font-size:11px;color:var(--text-3);margin-bottom:6px;">By model</div>';
      sortedModels.forEach(function(e) {
        const m = e[0], s = e[1];
        const tok = (s.input_tok + s.output_tok) / 1e6;
        html += '<div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;padding:3px 0;border-bottom:1px solid var(--border);">' +
          '<code style="color:var(--accent);">' + m + '</code>' +
          '<span style="color:var(--text-2);">' + tok.toFixed(2) + 'M tok · ' + s.calls + ' calls · ' +
            '<span style="color:var(--yellow,#fbbf24);font-weight:600;">$' + s.cost.toFixed(4) + '</span>' +
          '</span>' +
        '</div>';
      });
    }
    _ocTotalCost = totalCost;
    updateGrandTotal();
    box.innerHTML = html;
  } catch(e) {
    box.innerHTML = '<div style="color:var(--red);font-size:12px;">Error: ' + e.message + '</div>';
  }
}

async function checkCrewLeadStatus() {
  try {
    const d = await getJSON('/api/crew-lead/status');
    const badge = document.getElementById('crewLeadBadge');
    if (d.online) {
      badge.textContent = '● online'; badge.className = 'status-badge status-running';
    } else {
      badge.textContent = '● offline'; badge.className = 'status-badge status-stopped';
    }
  } catch {}
}

// @@ autocomplete: type @@ for list, @@PROMPT (or pick) shows exact JSON
const ATAT_COMMANDS = [
  { id: 'DISPATCH', label: 'Dispatch task to an agent', template: \'{"agent":"crew-coder","task":"Your task here"}\' },
  { id: 'PROMPT', label: 'Append or set agent system prompt', template: \'{"agent":"crew-lead","append":"Your new rule here"}\' },
  { id: 'PIPELINE', label: 'Multi-step pipeline (waves of agents)', template: \'[{"wave":1,"agent":"crew-coder","task":"..."},{"wave":2,"agent":"crew-qa","task":"..."}]\' },
  { id: 'SKILL', label: 'Run a skill by name', template: \'skillName {"param":"value"}\' },
  { id: 'SERVICE', label: 'Restart/stop a service or agent', template: \'restart crew-coder\' },
  { id: 'PROJECT', label: 'Draft a new project roadmap', template: \'{"name":"MyApp","description":"...","outputDir":"/path/to/dir"}\' },
  { id: 'BRAIN', label: 'Append a fact to brain.md', template: \'crew-lead: fact to remember\' },
  { id: 'TOOLS', label: 'Grant/revoke tools for an agent', template: \'{"agent":"crew-qa","allow":["read_file","write_file"]}\' },
  { id: 'CREATE_AGENT', label: 'Create a dynamic agent', template: \'{"id":"crew-ml","role":"coder","description":"ML specialist"}\' },
  { id: 'REMOVE_AGENT', label: 'Remove a dynamic agent', template: \'crew-ml\' },
  { id: 'DEFINE_SKILL', label: 'Define a new skill (then @@END_SKILL)', template: \'skillName\\n{"description":"...","url":"..."}\' },
  { id: 'DEFINE_WORKFLOW', label: 'Save a workflow for cron', template: \'name\\n[{"agent":"crew-copywriter","task":"..."}]\' },
];
function chatAtAtInput() {
  const ta = document.getElementById('chatInput');
  const menu = document.getElementById('chatAtAtMenu');
  const hint = document.getElementById('chatAtAtTemplate');
  if (!ta || !menu || !hint) return;
  try {
  const val = ta.value;
  const caret = ta.selectionStart;
  const before = val.slice(0, caret);
  const lastAt = before.lastIndexOf('@@');
  if (lastAt === -1) { menu.style.display = 'none'; hint.style.display = 'none'; return; }
  const afterAt = before.slice(lastAt + 2);
  if (/\\s/.test(afterAt)) { menu.style.display = 'none'; hint.style.display = 'none'; return; }
  const prefix = afterAt.toUpperCase();
  const filtered = ATAT_COMMANDS.filter(function(c) { return c.id.indexOf(prefix) === 0; });
  if (filtered.length === 0) { menu.style.display = 'none'; hint.style.display = 'none'; return; }
  menu.style.display = 'block';
  menu.style.visibility = 'visible';
  menu.innerHTML = '';
  filtered.forEach(function(c) {
    const row = document.createElement('div');
    row.style.cssText = 'padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border);';
    row.onmouseenter = function() { row.style.background = 'var(--bg-hover)'; };
    row.onmouseleave = function() { row.style.background = ''; };
    row.innerHTML = '<span style="color:var(--accent);font-weight:600;">@@' + c.id + '</span> <span style="color:var(--text-3);">' + c.label + '</span>';
    row.onclick = function() {
      const insert = '@@' + c.id + (c.template ? ' ' + c.template : '');
      ta.value = val.slice(0, lastAt) + insert + val.slice(caret);
      ta.selectionStart = ta.selectionEnd = lastAt + insert.length;
      ta.focus();
      menu.style.display = 'none';
      hint.style.display = 'block';
      hint.textContent = (c.id === 'PROMPT' ? 'Full line to send: @@PROMPT ' : 'Template: ') + (c.template ? c.template : '');
    };
    menu.appendChild(row);
  });
  const exact = filtered.find(function(c) { return c.id === prefix; });
  if (exact) {
    hint.style.display = 'block';
    hint.textContent = (exact.id === 'PROMPT' ? 'Full line: @@PROMPT ' : 'Template: ') + (exact.template || '');
  } else {
    hint.style.display = 'none';
  }
  } catch (err) { if (typeof console !== 'undefined') console.warn('chatAtAtInput', err); }
}
function chatKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  var menu = document.getElementById('chatAtAtMenu');
  if (menu && menu.style.display === 'block' && (e.key === 'Escape' || e.key === 'Tab')) { menu.style.display = 'none'; }
}

function appendChatBubble(role, text) {
  const box = document.getElementById('chatMessages');
  if (!box) return;
  const isUser = role === 'user';
  if (!isUser) {
    const last = box.lastElementChild;
    if (last && last.children.length >= 2) {
      const lastBubbleText = last.children[1].textContent;
      if (lastBubbleText.trim() === String(text).trim()) return;
    }
  }
  const div = document.createElement('div');
  div.style.cssText = 'display:flex;flex-direction:column;align-items:' + (isUser ? 'flex-end' : 'flex-start') + ';gap:4px;';
  const labelEl = document.createElement('div');
  labelEl.style.cssText = 'font-size:11px;color:var(--text-3);padding:0 6px;';
  const cl = window._crewLeadInfo || { emoji: '🧠', name: 'crew-lead' };
  const displayName = isUser ? 'You' : (role === 'assistant' ? (cl.emoji + ' ' + cl.name) : role);
  labelEl.textContent = displayName;
  const bubble = document.createElement('div');
  bubble.style.cssText = 'max-width:80%;padding:10px 14px;border-radius:' + (isUser ? '14px 14px 4px 14px' : '14px 14px 14px 4px') + ';background:' + (isUser ? 'var(--purple)' : 'var(--bg-2)') + ';color:' + (isUser ? '#fff' : 'var(--text-1)') + ';font-size:14px;line-height:1.5;white-space:pre-wrap;word-break:break-word;border:1px solid var(--border);';
  bubble.textContent = text;
  div.appendChild(labelEl); div.appendChild(bubble);
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function appendRoadmapCard(box, { draftId, name, outputDir, roadmapMd }) {
  function countTasks(md) { return (md.match(/^- \[ \]/gm) || []).length; }

  const wrap = document.createElement('div');
  wrap.setAttribute('data-draft-id', draftId);
  wrap.style.cssText = 'width:100%;display:flex;flex-direction:column;gap:4px;';

  const lbl = document.createElement('div');
  lbl.style.cssText = 'font-size:11px;color:var(--text-3);padding:0 6px;';
  lbl.textContent = '🗺️ Roadmap draft — review before building';

  const card = document.createElement('div');
  card.style.cssText = 'width:100%;border:1px solid #1e3a6e;border-radius:12px;overflow:hidden;background:#0a0a12;';

  const header = document.createElement('div');
  header.style.cssText = 'background:#0d1f3c;padding:10px 14px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #1e3a6e;';
  header.innerHTML = '<div><div style="font-size:13px;font-weight:600;color:#60a5fa;">🚀 ' + name + '</div><div style="font-size:11px;color:#4a7ab5;margin-top:2px;">' + outputDir + '</div></div>' +
    '<span style="font-size:10px;color:#4a5568;padding:2px 7px;background:#111827;border-radius:10px;" class="task-count">' + countTasks(roadmapMd) + ' tasks</span>';

  const ta = document.createElement('textarea');
  ta.value = roadmapMd;
  ta.spellcheck = false;
  ta.style.cssText = 'width:100%;background:#0a0a12;border:none;outline:none;color:#c7d4e8;font-size:11.5px;font-family:SF Mono,Monaco,Menlo,monospace;line-height:1.6;padding:12px 14px;resize:none;min-height:160px;max-height:320px;display:block;';
  setTimeout(() => { ta.style.height = ''; ta.style.height = Math.min(ta.scrollHeight, 320) + 'px'; }, 50);
  ta.addEventListener('input', () => {
    ta.style.height = ''; ta.style.height = Math.min(ta.scrollHeight, 320) + 'px';
    header.querySelector('.task-count').textContent = countTasks(ta.value) + ' tasks';
  });

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;align-items:center;padding:10px 14px 12px;border-top:1px solid #1a1a2e;background:#0d0d1a;';

  const startBtn = document.createElement('button');
  startBtn.textContent = '▶ Start Building';
  startBtn.style.cssText = 'background:#22c55e;color:#000;border:none;border-radius:8px;padding:8px 16px;font-size:12px;font-weight:700;cursor:pointer;';
  startBtn.onclick = async () => {
    startBtn.disabled = true; startBtn.textContent = '⏳ Launching…';
    try {
      const r = await postJSON('/api/crew-lead/confirm-project', { draftId, roadmapMd: ta.value });
      if (r.ok) {
        card.innerHTML = '<div style="padding:14px;color:#22c55e;font-size:13px;font-weight:600;">✅ ' + name + ' — project created, PM loop running!<br><span style="color:#4a7ab5;font-size:11px;font-weight:400">' + (r.outputDir || outputDir) + '</span></div>';
        appendChatBubble('assistant', '🚀 ' + name + ' is building. Check the Projects tab to watch progress.');
      } else {
        startBtn.disabled = false; startBtn.textContent = '▶ Start Building';
        status.textContent = '⚠️ ' + (r.error || 'Launch failed');
      }
    } catch(e) { startBtn.disabled = false; startBtn.textContent = '▶ Start Building'; status.textContent = '⚠️ ' + e.message; }
  };

  const discardBtn = document.createElement('button');
  discardBtn.textContent = 'Discard';
  discardBtn.style.cssText = 'background:none;border:1px solid #2d2d40;color:#666;border-radius:8px;padding:8px 14px;font-size:12px;cursor:pointer;';
  discardBtn.onclick = async () => {
    await postJSON('/api/crew-lead/discard-project', { draftId }).catch(() => {});
    wrap.remove();
  };

  const status = document.createElement('span');
  status.style.cssText = 'font-size:11px;color:#4a7ab5;margin-left:auto;';
  status.textContent = 'Edit above, then confirm';

  actions.appendChild(startBtn); actions.appendChild(discardBtn); actions.appendChild(status);
  card.appendChild(header); card.appendChild(ta); card.appendChild(actions);
  wrap.appendChild(lbl); wrap.appendChild(card);
  box.appendChild(wrap);
  box.scrollTop = box.scrollHeight;
}

let lastAppendedAssistantContent = '';
let lastAppendedUserContent = '';
let lastSentContent = null;
async function sendChat() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  appendChatBubble('user', text);
  lastAppendedUserContent = text;
  lastSentContent = text;
  const typingId = 'typing-' + Date.now();
  const typingDiv = document.createElement('div');
  typingDiv.id = typingId;
  typingDiv.style.cssText = 'font-size:12px;color:var(--text-3);padding:4px 6px;';
  const _cl = window._crewLeadInfo || { emoji: '🧠', name: 'crew-lead' };
  typingDiv.textContent = _cl.emoji + ' ' + _cl.name + ' is thinking...';
  const box = document.getElementById('chatMessages');
  box.appendChild(typingDiv);
  box.scrollTop = box.scrollHeight;
  try {
    const d = await postJSON('/api/crew-lead/chat', { message: text, sessionId: chatSessionId, projectId: _chatActiveProjectId || undefined });
    document.querySelectorAll('[id^="typing-"]').forEach(el => el.remove());
    if (d.ok === false && d.error) {
      appendChatBubble('assistant', '⚠️ ' + d.error);
      lastAppendedAssistantContent = '';
    } else if (d.reply) {
      const reply = d.reply;
      setTimeout(() => {
        if (reply !== lastAppendedAssistantContent) {
          appendChatBubble('assistant', reply);
          lastAppendedAssistantContent = reply;
          if (box) box.scrollTop = box.scrollHeight;
        }
      }, 400);
    }
    if (d.dispatched) {
      const note = document.createElement('div');
      note.style.cssText = 'font-size:11px;color:var(--text-3);text-align:center;padding:4px;';
      note.textContent = '⚡ Dispatched to ' + d.dispatched.agent;
      box.appendChild(note);
    }
    if (d.pendingProject) appendRoadmapCard(box, d.pendingProject);
    box.scrollTop = box.scrollHeight;
  } catch(e) {
    document.querySelectorAll('[id^="typing-"]').forEach(el => el.remove());
    let errMsg = e.message || String(e);
    try {
      const parsed = JSON.parse(errMsg);
      if (parsed && typeof parsed.error === 'string') errMsg = parsed.error;
    } catch {}
    appendChatBubble('assistant', '⚠️ Error: ' + errMsg);
    lastAppendedAssistantContent = '';
    box.scrollTop = box.scrollHeight;
  }
}

async function clearChatHistory() {
  if (!confirm('Clear chat history for this session?')) return;
  document.getElementById('chatMessages').innerHTML = '';
  await postJSON('/api/crew-lead/clear', { sessionId: chatSessionId }).catch(()=>{});
}

function showMessaging(){
  showSettings();
  showSettingsTab('telegram');
  loadTgStatus();
}

async function loadTgStatus(){
  try {
    const d = await getJSON('/api/telegram/status');
    const badge = document.getElementById('tgStatusBadge');
    if (d.running) {
      badge.textContent = d.botName ? '● @' + d.botName : '● running';
      badge.className = 'status-badge status-active';
    } else {
      badge.textContent = '● stopped';
      badge.className = 'status-badge status-stopped';
    }
  } catch {}
}

async function loadTgConfig(){
  try {
    const d = await getJSON('/api/telegram/config');
    if (d.token) document.getElementById('tgTokenInput').value = d.token;
    const ids = d.allowedChatIds && d.allowedChatIds.length ? d.allowedChatIds : [];
    document.getElementById('tgAllowedIds').value = ids.join(', ');
    const contactNames = d.contactNames || {};
    const listEl = document.getElementById('tgContactNamesList');
    listEl.innerHTML = '';
    if (ids.length) {
      const title = document.createElement('label');
      title.style.cssText = 'display:block;margin-bottom:6px;font-size:12px;color:var(--text-2);';
      title.textContent = 'Contact names (optional)';
      listEl.appendChild(title);
      ids.forEach(id => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;';
        const span = document.createElement('span');
        span.style.cssText = 'font-size:12px;color:var(--text-3);min-width:100px;';
        span.textContent = id;
        const input = document.createElement('input');
        input.id = 'tgContact-' + id;
        input.placeholder = 'e.g. Jeff';
        input.value = contactNames[String(id)] || '';
        input.style.flex = '1';
        row.appendChild(span);
        row.appendChild(input);
        listEl.appendChild(row);
      });
    }
  } catch {}
}

async function saveTgConfig(){
  const token = document.getElementById('tgTokenInput').value.trim();
  const idsRaw = document.getElementById('tgAllowedIds').value.trim();
  const allowedChatIds = idsRaw
    ? idsRaw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
    : [];
  if (!token) { showNotification('Enter a bot token first', true); return; }
  const contactNames = {};
  allowedChatIds.forEach(id => {
    const el = document.getElementById('tgContact-' + id);
    if (el && el.value.trim()) contactNames[String(id)] = el.value.trim();
  });
  await postJSON('/api/telegram/config', { token, targetAgent: 'crew-lead', allowedChatIds, contactNames });
  showNotification('Config saved');
  loadTgConfig(); // refresh contact names list
}

async function startTgBridge(){
  const token = document.getElementById('tgTokenInput').value.trim();
  const body = { targetAgent: 'crew-lead' };
  if (token) body.token = token;
  const r = await postJSON('/api/telegram/start', body);
  if (r && r.error) { showNotification(r.error, true); return; }
  showNotification(r && r.message === 'Already running' ? 'Already running' : 'Telegram bridge starting...');
  setTimeout(loadTgStatus, 2000);
}

async function stopTgBridge(){
  await postJSON('/api/telegram/stop', {});
  showNotification('Telegram bridge stopped');
  setTimeout(loadTgStatus, 1000);
}

let _servicesPollTimer = null;
function showServices(){
  hideAllViews();
  document.getElementById('servicesView').classList.add('active');
  setNavActive('navServices');
  loadServices();
  if (_servicesPollTimer) clearInterval(_servicesPollTimer);
  _servicesPollTimer = setInterval(() => {
    if (document.getElementById('servicesView').classList.contains('active')) loadServices();
    else { clearInterval(_servicesPollTimer); _servicesPollTimer = null; }
  }, 10000);
}

async function loadServices(){
  const grid = document.getElementById('servicesGrid');
  if (!grid) return;
  grid.innerHTML = '<div class="meta" style="padding:20px;">Checking services...</div>';
  try {
    const services = await getJSON('/api/services/status');
    const downCount = services.filter(s => !s.running).length;
    const badge = document.getElementById('servicesBadge');
    if (downCount > 0) {
      badge.textContent = downCount;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
    grid.innerHTML = services.map(svc => {
      const up = svc.running;
      const canRestart = svc.canRestart;
      const statusColor = up ? '#22c55e' : '#ef4444';
      const statusText  = up ? (svc.pid ? '● running  pid ' + svc.pid : '● running') : '● stopped';
      const uptime = svc.uptimeSec ? formatUptime(svc.uptimeSec) : '';
      return '<div class="card" style="display:flex;flex-direction:column;gap:10px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;">' +
          '<div>' +
            '<div style="font-weight:700;font-size:14px;margin-bottom:3px;">' + escHtml(svc.label) + '</div>' +
            '<div style="font-size:11px;color:var(--text-3);">' + escHtml(svc.description) + '</div>' +
          '</div>' +
          '<span style="font-size:11px;font-weight:600;color:' + statusColor + ';white-space:nowrap;margin-left:8px;">' + statusText + '</span>' +
        '</div>' +
        (uptime ? '<div style="font-size:11px;color:var(--text-3);">Up ' + uptime + '</div>' : '') +
        (svc.port ? '<div style="font-size:11px;color:var(--text-3);">Port ' + svc.port + '</div>' : '') +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
          (canRestart && up   ? '<button class="btn-ghost" style="font-size:12px;" onclick="restartService(&quot;' + svc.id + '&quot;)">↻ Restart</button>' : '') +
          (canRestart && !up  ? '<button class="btn-green" style="font-size:12px;" onclick="restartService(&quot;' + svc.id + '&quot;)">▶ Start</button>' : '') +
          (canRestart && up   ? '<button class="btn-red" style="font-size:12px;" onclick="stopService(&quot;' + svc.id + '&quot;)">⏹ Stop</button>' : '') +
          (!canRestart        ? '<span style="font-size:11px;color:var(--text-3);align-self:center;">managed externally</span>' : '') +
        '</div>' +
      '</div>';
    }).join('');
  } catch(e) {
    grid.innerHTML = '<div class="meta" style="padding:20px;color:#ef4444;">Error loading services: ' + e.message + '</div>';
  }
}

function formatUptime(sec){
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.floor(sec/60) + 'm ' + (sec%60) + 's';
  return Math.floor(sec/3600) + 'h ' + Math.floor((sec%3600)/60) + 'm';
}

async function restartService(id){
  const r = await postJSON('/api/services/restart', { id });
  if (r && r.ok === false && r.message) {
    showNotification('⚠️ ' + r.message, 'warning');
  } else {
    showNotification('Restarting ' + id + '...');
    setTimeout(loadServices, 3000);
  }
}

async function stopService(id){
  const r = await postJSON('/api/services/stop', { id });
  if (r && r.ok === false && r.message) {
    showNotification('⚠️ ' + r.message, 'warning');
  } else {
    showNotification('Stopping ' + id + '...');
    setTimeout(loadServices, 1500);
  }
}

async function loadTgMessages(){
  const feed = document.getElementById('tgMessageFeed');
  if (!feed) return;
  try {
    const msgs = await getJSON('/api/telegram/messages');
    if (!msgs.length) {
      feed.innerHTML = '<div class="meta" style="padding:20px;text-align:center;">No messages yet. Send something to your bot on Telegram.</div>';
      return;
    }
    feed.innerHTML = msgs.slice(-50).reverse().map(m => {
      const isIn = m.direction === 'inbound';
      const time = m.ts ? new Date(m.ts).toLocaleTimeString() : '';
      const who  = isIn ? (m.firstName || m.username || 'User') : 'CrewSwarm';
      const icon = isIn ? '👤' : '⚡';
      return '<div class="card" style="padding:12px;gap:4px;display:flex;flex-direction:column;">' +
        '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-3);">' +
        '<span>' + icon + ' ' + escHtml(who) + (m.username ? ' @' + escHtml(m.username) : '') + '</span>' +
        '<span>' + time + '</span></div>' +
        '<div style="font-size:13px;white-space:pre-wrap;">' + escHtml(m.text || '') + '</div>' +
        '</div>';
    }).join('');
  } catch(e) {
    feed.innerHTML = '<div class="meta" style="padding:20px;color:#ef4444;">Error loading messages</div>';
  }
}
async function loadFiles(forceRefresh) {
  const el = document.getElementById('filesContent');
  const dir = document.getElementById('filesDir').value.trim() || '${process.env.HOME}/Desktop/CrewSwarm';
  el.innerHTML = '<div class="meta" style="padding:20px;">Scanning ' + dir + '...</div>';
  try {
    const data = await getJSON('/api/files?dir=' + encodeURIComponent(dir));
    if (!data.files || !data.files.length) {
      el.innerHTML = '<div class="meta" style="padding:20px;">No files found in ' + dir + '</div>';
      return;
    }
    const grouped = {};
    data.files.forEach(f => {
      const ext = f.path.split('.').pop().toLowerCase() || 'other';
      if (!grouped[ext]) grouped[ext] = [];
      grouped[ext].push(f);
    });
    const extOrder = ['html','css','js','mjs','ts','json','md','sh','txt','other'];
    const extEmoji = { html:'🌐', css:'🎨', js:'⚡', mjs:'⚡', ts:'🔷', json:'📋', md:'📝', sh:'🖥️', txt:'📄', other:'📁' };
    let html = '<div style="display:grid;gap:1rem;padding:4px 0;">';
    for (const ext of extOrder) {
      if (!grouped[ext]) continue;
      html += '<div>';
      html += '<div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;padding-left:2px;">' + (extEmoji[ext]||'📁') + ' .' + ext + ' — ' + grouped[ext].length + ' file' + (grouped[ext].length>1?'s':'') + '</div>';
      html += '<div style="display:grid;gap:6px;">';
      grouped[ext].sort((a,b) => b.mtime - a.mtime).forEach(f => {
        const rel = f.path.replace(dir + '/', '');
        const age = formatAge(f.mtime);
        const sz = formatSize(f.size);
        html += '<div class="file-row">';
        html += '<div class="file-info"><span class="file-name">' + rel + '</span><span class="file-meta">' + sz + ' · ' + age + '</span></div>';
        html += '<div class="file-actions">';
        html += '<a href="cursor://file/' + f.path + '" class="file-btn file-btn-cursor" title="Open in Cursor">Cursor</a>';
        html += '<a href="opencode://open?path=' + encodeURIComponent(f.path) + '" class="file-btn file-btn-opencode" title="Open in OpenCode">OpenCode</a>';
        html += '<button onclick="previewFile(' + JSON.stringify(f.path) + ', this)" class="file-btn" title="Preview">👁</button>';
        html += '</div></div>';
      });
      html += '</div></div>';
    }
    html += '</div>';
    html += '<div id="file-preview-pane" style="display:none;margin-top:1rem;background:#0d1117;border:1px solid var(--border);border-radius:8px;overflow:hidden;"><div id="file-preview-bar" style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#0d1420;border-bottom:1px solid var(--border);font-size:12px;color:var(--text-2);"><span id="file-preview-name"></span><button onclick="closePreviewPane()" style="margin-left:auto;background:none;border:none;color:var(--text-2);cursor:pointer;">✕</button></div><pre id="file-preview-content" style="margin:0;padding:1rem;font-size:0.75rem;overflow:auto;max-height:400px;"></pre></div>';
    el.innerHTML = html;
  } catch(e) {
    el.innerHTML = '<div class="meta" style="padding:20px;color:var(--red);">Error: ' + e.message + '</div>';
  }
}
async function previewFile(filePath, btn) {
  const pane = document.getElementById('file-preview-pane');
  const content = document.getElementById('file-preview-content');
  const name = document.getElementById('file-preview-name');
  if (!pane) return;
  name.textContent = filePath.split('/').pop();
  content.textContent = 'Loading...';
  pane.style.display = 'block';
  pane.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    const data = await getJSON('/api/file-content?path=' + encodeURIComponent(filePath));
    content.textContent = data.content || '(empty)';
  } catch(e) {
    content.textContent = 'Error: ' + e.message;
  }
}
function closePreviewPane() {
  const pane = document.getElementById('file-preview-pane');
  if (pane) pane.style.display = 'none';
}
function formatAge(mtime) {
  const diff = Date.now() - mtime;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h/24) + 'd ago';
}
function formatSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + 'KB';
  return (bytes/1024/1024).toFixed(1) + 'MB';
}
function showModels(){
  hideAllViews();
  document.getElementById('modelsView').classList.add('active');
  setNavActive('navModels');
  loadRTToken();
  loadBuiltinProviders(); // renders built-ins + custom providers in one unified list
  loadSearchTools();
}
// keep old name working for any legacy calls
function showProviders(){ showModels(); }

const BUILTIN_PROVIDERS = [
  { id:'groq',       label:'Groq',       icon:'⚡', url:'https://console.groq.com/keys',         hint:'Fast inference — great for crew-coder, crew-fixer' },
  { id:'anthropic',  label:'Anthropic',  icon:'🟣', url:'https://console.anthropic.com/',         hint:'Claude models — best for complex reasoning tasks' },
  { id:'openai',     label:'OpenAI (API)',     icon:'🟢', url:'https://platform.openai.com/api-keys',   hint:'GPT-4o and o-series — pay per use with API key' },
  { id:'perplexity', label:'Perplexity', icon:'🔍', url:'https://www.perplexity.ai/settings/api', hint:'Sonar Pro — ideal for crew-pm research tasks' },
  { id:'mistral',    label:'Mistral',    icon:'🌀', url:'https://console.mistral.ai/',            hint:'Open-weight models, efficient mid-tier tasks' },
  { id:'deepseek',   label:'DeepSeek',   icon:'🌊', url:'https://platform.deepseek.com/',         hint:'Low cost, strong coding performance' },
  { id:'xai',        label:'xAI (Grok)', icon:'𝕏',  url:'https://console.x.ai/',                 hint:'Grok models from xAI' },
  { id:'ollama',     label:'Ollama',     icon:'🏠', url:'https://ollama.com/download',            hint:'Local models — no API key needed, runs offline' },
  { id:'openai-local', label:'OpenAI (local)', icon:'🟢', url:'https://github.com/RayBytes/ChatMock', hint:'ChatMock — use ChatGPT Plus/Pro subscription. Run ChatMock server first (e.g. port 8000). Key ignored.' },
];

const SEARCH_TOOLS = [
  { id:'parallel', label:'Parallel',    icon:'🔬', url:'https://platform.parallel.ai/signup', hint:'Deep research & web synthesis — used by crew-pm for project planning', envKey:'PARALLEL_API_KEY' },
  { id:'brave',    label:'Brave Search', icon:'🦁', url:'https://api.search.brave.com/',       hint:'Fast web search (~700ms) — best for quick agent lookups',            envKey:'BRAVE_API_KEY'    },
];

async function loadSearchTools(){
  const list = document.getElementById('searchToolsList');
  let saved = {};
  try { saved = (await getJSON('/api/search-tools')).keys || {}; } catch {}
  list.innerHTML = SEARCH_TOOLS.map(p => {
    const hasKey = !!saved[p.id];
    const badge = hasKey
      ? \`<span style="font-size:11px;padding:2px 8px;border-radius:999px;font-weight:600;background:rgba(52,211,153,0.15);color:#34d399;border:1px solid rgba(52,211,153,0.3);">set ✓</span>\`
      : \`<span style="font-size:11px;padding:2px 8px;border-radius:999px;font-weight:600;background:rgba(107,114,128,0.12);color:var(--text-2);border:1px solid var(--border);">no key</span>\`;
    return \`<div class="card" style="margin-bottom:8px;">
      <div style="display:flex;align-items:center;gap:10px;cursor:pointer;" onclick="this.parentElement.querySelector('.st-body').style.display=this.parentElement.querySelector('.st-body').style.display==='none'?'block':'none'">
        <span style="font-size:18px;width:24px;text-align:center;">\${p.icon}</span>
        <div style="flex:1;">
          <div style="font-weight:600;font-size:13px;">\${p.label}</div>
          <div style="font-size:11px;color:var(--text-2);">\${p.hint}</div>
        </div>
        \${badge}
        <span style="color:var(--text-2);font-size:12px;">▾</span>
      </div>
      <div class="st-body" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">
        <div style="display:flex;gap:8px;">
          <input id="st_\${p.id}" type="password" autocomplete="new-password" placeholder="\${hasKey ? '••••••••••••••• (saved — paste to update)' : 'Paste API key'}" style="flex:1;" />
          <button onclick="saveSearchTool('\${p.id}')" class="btn-purple">Save</button>
          <button onclick="testSearchTool('\${p.id}')" class="btn-ghost">Test</button>
          <a href="\${p.url}" target="_blank" class="btn-ghost" style="text-decoration:none;font-size:12px;">Keys ↗</a>
        </div>
        <div style="font-size:11px;color:var(--text-2);margin-top:6px;">Saved as <code style="background:rgba(255,255,255,0.06);padding:1px 5px;border-radius:4px;">\${p.envKey}</code> in environment</div>
        <div id="st_status_\${p.id}" style="font-size:12px;margin-top:8px;color:var(--text-2);"></div>
      </div>
    </div>\`;
  }).join('');
}

async function saveSearchTool(toolId){
  const inp = document.getElementById('st_' + toolId);
  const key = inp?.value?.trim();
  if (!key) { showNotification('Paste an API key first', 'error'); return; }
  try {
    await postJSON('/api/search-tools/save', { toolId, key });
    showNotification('Key saved', 'success');
    loadSearchTools();
  } catch(e) { showNotification('Save failed: ' + e.message, 'error'); }
}

async function testSearchTool(toolId){
  const statusEl = document.getElementById('st_status_' + toolId);
  statusEl.textContent = 'Testing…';
  try {
    const r = await postJSON('/api/search-tools/test', { toolId });
    statusEl.style.color = r.ok ? '#34d399' : '#f87171';
    statusEl.textContent = r.ok ? '✓ ' + (r.message || 'Connected') : '✗ ' + (r.error || 'Failed');
  } catch(e) { statusEl.style.color='#f87171'; statusEl.textContent = '✗ ' + e.message; }
}

async function loadBuiltinProviders(){
  const list = document.getElementById('builtinProvidersList');
  let saved = {};
  try { saved = (await getJSON('/api/providers/builtin')).keys || {}; } catch {}
  const builtinIds = new Set(BUILTIN_PROVIDERS.map(p => p.id));

  // ── Render built-in provider cards ─────────────────────────────────────────
  let html = BUILTIN_PROVIDERS.map(p => {
    const hasKey = !!saved[p.id];
    const isOllama = p.id === 'ollama';
    const isOpenAiLocal = p.id === 'openai-local';
    const badge = hasKey || isOllama || isOpenAiLocal
      ? \`<span style="font-size:11px;padding:2px 8px;border-radius:999px;font-weight:600;background:rgba(52,211,153,0.15);color:#34d399;border:1px solid rgba(52,211,153,0.3);">\${(isOllama || isOpenAiLocal) && !hasKey ? 'local' : 'set ✓'}</span>\`
      : \`<span style="font-size:11px;padding:2px 8px;border-radius:999px;font-weight:600;background:rgba(107,114,128,0.12);color:var(--text-2);border:1px solid var(--border);">no key</span>\`;
    return \`<div class="card" style="margin-bottom:8px;">
      <div style="display:flex;align-items:center;gap:10px;cursor:pointer;" onclick="this.parentElement.querySelector('.bp-body').style.display=this.parentElement.querySelector('.bp-body').style.display==='none'?'block':'none'">
        <span style="font-size:18px;width:24px;text-align:center;">\${p.icon}</span>
        <div style="flex:1;">
          <div style="font-weight:600;font-size:13px;">\${p.label}</div>
          <div style="font-size:11px;color:var(--text-2);">\${p.hint}</div>
        </div>
        \${badge}
        <span style="color:var(--text-2);font-size:12px;">▾</span>
      </div>
      <div class="bp-body" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">
        \${isOllama ? \`<div style="font-size:12px;color:var(--text-2);margin-bottom:8px;">Ollama runs locally — no API key required. Make sure Ollama is running on port 11434.</div>\` : ''}
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          \${isOllama ? '' : \`<input id="bp_\${p.id}" type="password" autocomplete="new-password" placeholder="\${hasKey ? '••••••••••••••• (saved — paste to update)' : 'Paste API key'}" style="flex:1;min-width:180px;" />\`}
          \${isOllama
            ? \`<button onclick="testBuiltinProvider('\${p.id}')" class="btn-ghost" style="flex:1;">Test Connection</button>\`
            : \`<button onclick="saveBuiltinKey('\${p.id}')" class="btn-purple">Save</button>
               <button onclick="testBuiltinProvider('\${p.id}')" class="btn-ghost">Test</button>
               <button onclick="fetchBuiltinModels('\${p.id}', this)" class="btn-ghost" style="background:#0f766e20;color:#34d399;border-color:#0f766e40;">↻ Models</button>
               <a href="\${p.url}" target="_blank" class="btn-ghost" style="text-decoration:none;font-size:12px;">Keys ↗</a>\`}
        </div>
        <div id="bp_status_\${p.id}" style="font-size:12px;margin-top:8px;color:var(--text-2);"></div>
        <div id="bp_models_\${p.id}" style="margin-top:8px;display:none;">
          <span style="font-size:11px;color:var(--text-2);display:block;margin-bottom:4px;">Models (<span id="bp_mcount_\${p.id}">0</span>):</span>
          <span id="bp_mtags_\${p.id}"></span>
        </div>
      </div>
    </div>\`;
  }).join('');

  // ── Append any custom (non-built-in) providers from crewswarm.json ─────────
  try {
    const data = await getJSON('/api/providers');
    const customs = (data.providers || []).filter(p => !builtinIds.has(p.id));
    if (customs.length) {
      html += \`<div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:0.08em;margin:14px 0 8px;padding:0 2px;">Custom Providers</div>\`;
      html += customs.map(p => {
        const icon = PROVIDER_ICONS[p.id] || '🔌';
        const hasKey = p.hasKey;
        const badge = hasKey
          ? \`<span style="font-size:11px;padding:2px 8px;border-radius:999px;font-weight:600;background:rgba(52,211,153,0.15);color:#34d399;border:1px solid rgba(52,211,153,0.3);">key set ✓</span>\`
          : \`<span style="font-size:11px;padding:2px 8px;border-radius:999px;font-weight:600;background:rgba(107,114,128,0.12);color:var(--text-2);border:1px solid var(--border);">no key</span>\`;
        const modelCount = p.models?.length || 0;
        return \`<div class="card" style="margin-bottom:8px;">
          <div style="display:flex;align-items:center;gap:10px;cursor:pointer;" onclick="this.parentElement.querySelector('.cp-body').style.display=this.parentElement.querySelector('.cp-body').style.display==='none'?'block':'none'">
            <span style="font-size:18px;width:24px;text-align:center;">\${icon}</span>
            <div style="flex:1;">
              <div style="font-weight:600;font-size:13px;">\${p.id}</div>
              <div style="font-size:11px;color:var(--text-2);">\${p.baseUrl}\${modelCount ? ' · ' + modelCount + ' models' : ''}</div>
            </div>
            \${badge}
            <span style="color:var(--text-2);font-size:12px;">▾</span>
          </div>
          <div class="cp-body" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <input id="key_\${p.id}" type="password" autocomplete="new-password" placeholder="\${hasKey ? '••••••••••••••• (saved — paste to update)' : 'Paste API key'}" style="flex:1;min-width:180px;" />
              <button onclick="saveKey('\${p.id}')" class="btn-purple">Save</button>
              <button onclick="testKey('\${p.id}')" class="btn-ghost">Test</button>
              <button onclick="fetchModels('\${p.id}', this)" class="btn-ghost" style="background:#0f766e20;color:#34d399;border-color:#0f766e40;">↻ Models</button>
            </div>
            <div style="font-size:11px;color:var(--text-2);margin-top:6px;">Base URL: <code style="font-size:10px;">\${p.baseUrl}</code></div>
            <div id="test_\${p.id}" style="font-size:12px;margin-top:8px;color:var(--text-2);"></div>
            <div id="mwrap_\${p.id}" style="margin-top:8px;\${modelCount ? '' : 'display:none;'}">
              <span style="font-size:11px;color:var(--text-2);">Models (<span id="mcount_\${p.id}">\${modelCount}</span>):</span>
              <span id="mtags_\${p.id}">\${(p.models||[]).map(m => '<span class="model-tag">' + (m.id||m) + '</span>').join('')}</span>
            </div>
          </div>
        </div>\`;
      }).join('');
    }
  } catch {}

  list.innerHTML = html;
}

async function saveBuiltinKey(providerId){
  const inp = document.getElementById('bp_' + providerId);
  const key = inp?.value?.trim();
  if (!key && providerId !== 'openai-local') { showNotification('Paste an API key first', 'error'); return; }
  await postJSON('/api/providers/builtin/save', { providerId, apiKey: key || '' });
  inp.value = '';
  showNotification('Key saved — fetching models…');
  // Await so the re-rendered card DOM exists before we write into it
  await loadBuiltinProviders();
  // Auto-fetch models so the agent model dropdown populates immediately
  try {
    const r = await postJSON('/api/providers/fetch-models', { providerId });
    if (r.ok) {
      const tags   = document.getElementById('bp_mtags_'  + providerId);
      const count  = document.getElementById('bp_mcount_' + providerId);
      const wrap   = document.getElementById('bp_models_' + providerId);
      const status = document.getElementById('bp_status_' + providerId);
      if (tags)   tags.innerHTML = r.models.map(m => '<span class="model-tag">' + m + '</span>').join('');
      if (count)  count.textContent = r.models.length;
      if (wrap)   wrap.style.display = 'block';
      if (status) { status.style.color = '#34d399'; status.textContent = '✓ ' + r.models.length + ' models'; }
      showNotification('Key saved for ' + providerId + ' — ' + r.models.length + ' models ready');
      loadAgents(); // refresh model dropdowns on the Agents tab
    } else {
      showNotification('Key saved — could not fetch models: ' + (r.error || 'unknown'), 'warning');
    }
  } catch(e) {
    showNotification('Key saved — model fetch failed: ' + e.message, 'warning');
  }
}

async function testBuiltinProvider(providerId){
  const statusEl = document.getElementById('bp_status_' + providerId);
  statusEl.textContent = 'Testing…';
  try {
    const r = await postJSON('/api/providers/builtin/test', { providerId });
    statusEl.style.color = r.ok ? '#34d399' : '#f87171';
    statusEl.textContent = r.ok ? '✓ Connected — ' + (r.model || 'OK') : '✗ ' + (r.error || 'Failed');
  } catch(e) { statusEl.style.color='#f87171'; statusEl.textContent = '✗ ' + e.message; }
}

async function fetchBuiltinModels(providerId, btn){
  const statusEl = document.getElementById('bp_status_' + providerId);
  const orig = btn.textContent;
  btn.textContent = 'Fetching…';
  btn.disabled = true;
  statusEl.textContent = '';
  try {
    const r = await postJSON('/api/providers/fetch-models', { providerId });
    if (r.ok) {
      const tags  = document.getElementById('bp_mtags_' + providerId);
      const count = document.getElementById('bp_mcount_' + providerId);
      const wrap  = document.getElementById('bp_models_' + providerId);
      if (tags)  tags.innerHTML  = r.models.map(m => '<span class="model-tag">' + m + '</span>').join('');
      if (count) count.textContent = r.models.length;
      if (wrap)  wrap.style.display = 'block';
      statusEl.style.color = '#34d399';
      statusEl.textContent = '✓ ' + r.models.length + ' models fetched' + (r.note ? ' — ' + r.note : '');
      loadAgents();
    } else {
      statusEl.style.color = '#f87171';
      statusEl.textContent = '✗ ' + (r.error || 'Failed');
    }
  } catch(e) { statusEl.style.color='#f87171'; statusEl.textContent = '✗ ' + e.message; }
  finally { btn.textContent = orig; btn.disabled = false; }
}

async function loadOpenClawStatus(){
  const badge = document.getElementById('oclawBadge');
  try {
    const d = await getJSON('/api/settings/openclaw-status');
    if (d.installed) {
      badge.textContent = '● installed';
      badge.style.background = 'rgba(52,211,153,0.15)';
      badge.style.color = '#34d399';
      badge.style.borderColor = 'rgba(52,211,153,0.3)';
    } else {
      badge.textContent = '○ not detected';
      badge.style.background = 'rgba(107,114,128,0.12)';
      badge.style.color = 'var(--text-2)';
      badge.style.borderColor = 'var(--border)';
    }
  } catch { badge.textContent = '? unknown'; }
}
async function loadRTToken(){
  try {
    const d = await getJSON('/api/settings/rt-token');
    const badge = document.getElementById('rtTokenBadge');
    const inp   = document.getElementById('rtTokenInput');
    if (d.token) {
      badge.textContent = 'set ✓';
      badge.style.background = 'rgba(52,211,153,0.15)';
      badge.style.color = '#34d399';
      badge.style.borderColor = 'rgba(52,211,153,0.3)';
      inp.placeholder = '••••••••••••••••••••••• (saved)';
    } else {
      badge.textContent = 'not set';
      badge.style.background = 'rgba(251,191,36,0.15)';
      badge.style.color = '#fbbf24';
      badge.style.borderColor = 'rgba(251,191,36,0.3)';
    }
  } catch {}
}
async function saveRTToken(){
  const token = document.getElementById('rtTokenInput').value.trim();
  if (!token) { showNotification('Paste a token first', 'error'); return; }
  try {
    await postJSON('/api/settings/rt-token', { token });
    showNotification('RT Bus token saved');
    document.getElementById('rtTokenInput').value = '';
    loadRTToken();
  } catch(e) { showNotification('Save failed: ' + e.message, 'error'); }
}
async function loadOpencodeProject(){
  try {
    const d = await getJSON('/api/settings/opencode-project');
    const inp = document.getElementById('opencodeProjInput');
    const st  = document.getElementById('opencodeProjStatus');
    if (inp) { inp.placeholder = d.dir || 'e.g. /Users/you/Desktop/myproject'; inp.value = d.dir || ''; }
    if (st) st.textContent = d.dir ? ('✅ Current: ' + d.dir) : '⚠️ Not set — OpenCode will write files to the CrewSwarm repo root. Set this to your project folder.';
    const fbSel = document.getElementById('opencodeFallbackSelect');
    const fbSt  = document.getElementById('opencodeFallbackStatus');
    if (fbSel) {
      if (_allModels.length === 0) {
        const ac = await getJSON('/api/agents-config');
        _allModels = ac.allModels || [];
        _modelsByProvider = ac.modelsByProvider || {};
      }
      populateModelDropdown('opencodeFallbackSelect', d.fallbackModel || '');
    }
    if (fbSt) fbSt.textContent = d.fallbackModel ? ('✅ Fallback: ' + d.fallbackModel) : '⚠️ Using default groq/kimi-k2-instruct-0905';
  } catch {}
}
async function saveOpencodeSettings(){
  const dir = (document.getElementById('opencodeProjInput')?.value || '').trim();
  const fallbackModel = (document.getElementById('opencodeFallbackSelect')?.value || '').trim();
  try {
    await postJSON('/api/settings/opencode-project', { dir: dir || undefined, fallbackModel: fallbackModel || undefined });
    showNotification('OpenCode settings saved — fallback takes effect on next task (no restart needed)');
    loadOpencodeProject();
  } catch(e) { showNotification('Save failed: ' + e.message, 'error'); }
}
async function loadBgConsciousness() {
  const btn = document.getElementById('bgConsciousnessBtn');
  const status = document.getElementById('bgConsciousnessStatus');
  try {
    const d = await getJSON('/api/settings/bg-consciousness');
    const on = d.enabled;
    if (btn) {
      btn.textContent = on ? '🟢 ON' : '⚫ OFF';
      btn.style.background = on ? 'rgba(34,197,94,0.15)' : 'var(--surface-2)';
      btn.style.borderColor = on ? '#22c55e' : 'var(--border)';
      btn.style.color = on ? '#22c55e' : 'var(--text-2)';
    }
    if (status) status.textContent = on
      ? 'Active — crew-lead reflects every ' + Math.round(d.intervalMs / 60000) + 'min when idle. Model: ' + d.model
      : 'Off — crew-lead will not self-reflect between tasks.';
  } catch(e) {
    if (btn) btn.textContent = 'Error';
    if (status) status.textContent = 'Could not load: ' + e.message;
  }
}
async function toggleBgConsciousness() {
  const btn = document.getElementById('bgConsciousnessBtn');
  try {
    const current = await getJSON('/api/settings/bg-consciousness');
    const d = await postJSON('/api/settings/bg-consciousness', { enabled: !current.enabled });
    showNotification('Background consciousness ' + (d.enabled ? 'ENABLED' : 'DISABLED'));
    loadBgConsciousness();
  } catch(e) { showNotification('Failed: ' + e.message, 'error'); }
}
async function loadGlobalFallback() {
  try {
    const d = await getJSON('/api/settings/global-fallback');
    const el = document.getElementById('globalFallbackInput');
    if (el) el.value = d.globalFallbackModel || '';
    const status = document.getElementById('globalFallbackStatus');
    if (status) status.textContent = d.globalFallbackModel
      ? 'Active: any agent without a per-agent fallback will use ' + d.globalFallbackModel
      : 'Not set — agents without fallback will use the built-in default (groq/llama-3.3-70b-versatile).';
  } catch(e) { console.warn('loadGlobalFallback:', e.message); }
}
async function saveGlobalFallback() {
  const model = (document.getElementById('globalFallbackInput')?.value || '').trim();
  try {
    await postJSON('/api/settings/global-fallback', { globalFallbackModel: model });
    showNotification(model ? 'Global fallback → ' + model : 'Global fallback cleared');
    loadGlobalFallback();
  } catch(e) { showNotification('Failed: ' + e.message, 'error'); }
}
function showSettings(){
  hideAllViews();
  document.getElementById('settingsView').classList.add('active');
  setNavActive('navSettings');
  showSettingsTab('usage');
}
function showSettingsTab(tab){
  ['usage','security','webhooks','telegram','system'].forEach(t => {
    const panel = document.getElementById('stab-panel-' + t);
    const btn   = document.getElementById('stab-' + t);
    if (!panel || !btn) return;
    panel.style.display = t === tab ? (t === 'usage' ? 'grid' : 'block') : 'none';
    btn.classList.toggle('active', t === tab);
  });
  if (tab === 'usage')    { loadTokenUsage(); loadAllUsage(); }
  if (tab === 'security') { loadCmdAllowlist(); }
  if (tab === 'system')   { loadOpencodeProject(); loadBgConsciousness(); loadGlobalFallback(); }
  if (tab === 'telegram') { loadTelegramSessions(); loadTgMessages(); loadTgConfig(); }
}

function showSkills(){
  hideAllViews();
  document.getElementById('skillsView').classList.add('active');
  setNavActive('navSkills');
  loadSkills();
  loadPendingApprovals();
}

function showRunSkills(){
  hideAllViews();
  document.getElementById('runSkillsView').classList.add('active');
  setNavActive('navRunSkills');
  loadRunSkills();
}

function showBenchmarks(){
  hideAllViews();
  document.getElementById('benchmarksView').classList.add('active');
  setNavActive('navBenchmarks');
  loadBenchmarkOptions().then(() => {
    const sel = document.getElementById('benchmarkSelect');
    if (sel && sel.value) loadBenchmarkLeaderboard(sel.value);
  });
}

function showToolMatrix(){
  hideAllViews();
  document.getElementById('toolMatrixView').classList.add('active');
  setNavActive('navToolMatrix');
  loadToolMatrix();
}

// keep old name working for any legacy calls
function showIntegrations(){ showSkills(); }

// ── Benchmarks (ZeroEval / llm-stats) ───────────────────────────────────────────
async function loadBenchmarkOptions() {
  const sel = document.getElementById('benchmarkSelect');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">— Loading… —</option>';
  try {
    const r = await fetch('/api/zeroeval/benchmarks');
    const arr = await r.json();
    if (!Array.isArray(arr)) throw new Error('Expected array');
    sel.innerHTML = '<option value="">— Pick benchmark —</option>';
    arr.forEach(b => {
      const id = typeof b === 'object' ? (b.benchmark_id || b.id) : b;
      const name = typeof b === 'object' ? (b.name || id) : id;
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = name;
      sel.appendChild(opt);
    });
    if (cur && arr.some(b => (typeof b === 'object' ? b.benchmark_id : b) === cur)) sel.value = cur;
  } catch (e) {
    sel.innerHTML = '<option value="">— Failed to load —</option>';
  }
}

async function loadBenchmarks() {
  await loadBenchmarkOptions();
  const sel = document.getElementById('benchmarkSelect');
  if (sel && sel.value) loadBenchmarkLeaderboard(sel.value);
}

async function loadBenchmarkLeaderboard(benchmarkId) {
  const tableEl = document.getElementById('benchmarkTable');
  const metaEl = document.getElementById('benchmarkMeta');
  if (!tableEl || !metaEl) return;
  if (!benchmarkId) {
    tableEl.innerHTML = '';
    metaEl.style.display = 'none';
    return;
  }
  tableEl.innerHTML = '<div class="meta" style="padding:20px;">Loading…</div>';
  metaEl.style.display = 'none';
  try {
    const r = await fetch('/api/zeroeval/benchmarks/' + encodeURIComponent(benchmarkId));
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || data.detail || 'Failed to load');
    const models = data.models || [];
    const stats = data.statistics || {};
    metaEl.innerHTML = '<b>' + escHtml(data.name || benchmarkId) + '</b>: ' + (data.description || '').slice(0, 200) + '… | ' + stats.total_models + ' models, avg ' + ((stats.average_score || 0) * 100).toFixed(1) + '%';
    metaEl.style.display = 'block';
    if (!models.length) {
      tableEl.innerHTML = '<div class="meta" style="padding:20px;">No model scores for this benchmark.</div>';
      return;
    }
    const rows = models.slice(0, 100).map(m => {
      const score = (m.normalized_score != null ? m.normalized_score : m.score) ?? 0;
      const pct = (score * 100).toFixed(1);
      const inp = m.input_cost_per_million != null ? Math.round(m.input_cost_per_million * 100) + '¢' : '—';
      const out = m.output_cost_per_million != null ? Math.round(m.output_cost_per_million * 100) + '¢' : '—';
      const inC = m.input_cost_per_million ?? 0;
      const outC = m.output_cost_per_million ?? 0;
      const centsPerPt = (inC + outC) > 0 && score > 0 ? ((inC + outC) * 100 / (score * 100)).toFixed(1) + '¢/pt' : '—';
      return '<tr><td style="padding:6px 10px;">' + (m.rank || '-') + '</td><td style="padding:6px 10px;">' + escHtml(m.model_name || m.model_id) + '</td><td style="padding:6px 10px;">' + escHtml(m.organization_name || '') + '</td><td style="padding:6px 10px;font-weight:600;">' + pct + '%</td><td style="padding:6px 10px;font-size:11px;" title="¢ per 1M input tokens">' + inp + '</td><td style="padding:6px 10px;font-size:11px;" title="¢ per 1M output tokens">' + out + '</td><td style="padding:6px 10px;font-size:11px;" title="¢ per score point (1M in+out / score%)">' + centsPerPt + '</td><td style="padding:6px 10px;font-size:11px;">' + (m.analysis_method || '-').slice(0, 40) + '</td></tr>';
    }).join('');
    tableEl.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="border-bottom:1px solid var(--border);"><th style="text-align:left;padding:6px 10px;">Rank</th><th style="text-align:left;padding:6px 10px;">Model</th><th style="text-align:left;padding:6px 10px;">Org</th><th style="text-align:left;padding:6px 10px;">Score</th><th style="text-align:left;padding:6px 10px;" title="¢ per 1M input">in ¢</th><th style="text-align:left;padding:6px 10px;" title="¢ per 1M output">out ¢</th><th style="text-align:left;padding:6px 10px;" title="¢ per score point">¢/pt</th><th style="text-align:left;padding:6px 10px;">Method</th></tr></thead><tbody>' + rows + '</tbody></table>';
  } catch (e) {
    tableEl.innerHTML = '<div style="color:var(--red);padding:20px;">Error: ' + escHtml(e.message) + '</div>';
  }
}

// ── Run skills (from health snapshot) ───────────────────────────────────────────
async function loadRunSkills(){
  const el = document.getElementById('runSkillsGrid');
  if (!el) return;
  try {
    const d = await (await fetch('/api/health')).json();
    const skills = (d.skills || []).filter(s => !s.error);
    if (!skills.length) {
      el.innerHTML = '<div style="color:var(--text-3);font-size:13px;">No skills in health snapshot. Add skills in the Skills tab or add JSON files to ~/.crewswarm/skills/</div>';
      return;
    }
    el.innerHTML = skills.map(s => {
      const defaults = s.defaultParams && Object.keys(s.defaultParams).length
        ? JSON.stringify(s.defaultParams, null, 2)
        : '{}';
      const paramHint = (s.paramNotes || s.description || '').slice(0, 120);
      const safeName = (s.name || '').replace(/"/g, '&quot;');
      return '<div class="card" style="display:flex;flex-direction:column;">'
        + '<div class="card-title" style="margin-bottom:6px;">' + (s.name || 'unnamed') + '</div>'
        + '<div style="font-size:12px;color:var(--text-3);margin-bottom:10px;line-height:1.4;">' + (s.description || '') + '</div>'
        + (paramHint ? '<div style="font-size:11px;color:var(--text-2);margin-bottom:8px;">' + paramHint + '</div>' : '')
        + '<label style="font-size:11px;color:var(--text-2);margin-bottom:4px;">Params (JSON)</label>'
        + '<textarea data-skill="' + safeName + '" rows="4" style="font-family:monospace;font-size:12px;width:100%;margin-bottom:10px;resize:vertical;" class="runskills-params">' + defaults.replace(/</g, '&lt;') + '</textarea>'
        + '<div style="display:flex;align-items:center;gap:8px;margin-top:auto;">'
        + '<button class="btn-green" style="font-size:12px;" data-skill="' + safeName + '" onclick="runSkillFromUI(this.dataset.skill)">Run</button>'
        + '<span class="runskills-result" data-skill="' + safeName + '" style="font-size:11px;color:var(--text-3);"></span>'
        + '</div></div>';
    }).join('');
  } catch (e) {
    el.innerHTML = '<div style="color:var(--red);font-size:12px;">Error loading health/skills: ' + (e.message || '') + '</div>';
  }
}

async function runSkillFromUI(skillName){
  const textarea = document.querySelector('.runskills-params[data-skill="' + (skillName || '').replace(/"/g, '\\"') + '"]');
  const resultEl = document.querySelector('.runskills-result[data-skill="' + (skillName || '').replace(/"/g, '\\"') + '"]');
  if (!textarea) return;
  let params = {};
  try { params = JSON.parse(textarea.value.trim() || '{}'); } catch (e) {
    if (resultEl) resultEl.textContent = 'Invalid JSON';
    return;
  }
  if (resultEl) resultEl.textContent = 'Running…';
  try {
    const r = await fetch('/api/skills/' + encodeURIComponent(skillName) + '/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params })
    });
    const data = await r.json();
    if (resultEl) {
      if (data.ok) resultEl.textContent = 'Done';
      else resultEl.textContent = data.error || 'Error';
      resultEl.style.color = data.ok ? 'var(--green)' : 'var(--red)';
    }
    if (!data.ok) return;
    if (data.result !== undefined && resultEl) {
      const preview = typeof data.result === 'string' ? data.result : JSON.stringify(data.result).slice(0, 120);
      resultEl.textContent = preview + (preview.length >= 120 ? '…' : '');
    }
  } catch (e) {
    if (resultEl) { resultEl.textContent = e.message || 'Request failed'; resultEl.style.color = 'var(--red)'; }
  }
}

// ── Task lifecycle (telemetry schema 1.1) ────────────────────────────────────────
window._telemetryEvents = window._telemetryEvents || [];
function renderTaskLifecycle(events) {
  const el = document.getElementById('taskLifecycleContainer');
  if (!el) return;
  events = events || [];
  if (!events.length) {
    el.innerHTML = '<div class="card" style="padding:12px;"><div class="meta" style="font-size:12px;">Recent task lifecycle (dispatched → completed/failed/cancelled). Dispatch a task to see events.</div></div>';
    return;
  }
  const rows = events.slice().reverse().slice(0, 15).map(ev => {
    const d = ev.data || {};
    const phase = d.phase || '';
    const color = phase === 'completed' ? 'var(--green)' : phase === 'failed' || phase === 'cancelled' ? 'var(--red)' : 'var(--accent)';
    const time = (ev.occurredAt || '').replace('T', ' ').slice(0, 19);
    return '<tr style="border-bottom:1px solid var(--border);"><td style="padding:6px 10px;font-size:11px;color:var(--text-3);">' + time + '</td><td style="padding:6px 10px;font-size:12px;"><span style="color:' + color + ';">' + phase + '</span></td><td style="padding:6px 10px;font-size:12px;">' + (d.agentId || '') + '</td><td style="padding:6px 10px;font-size:11px;color:var(--text-3);">' + (d.taskId || '').slice(0, 20) + '</td></tr>';
  }).join('');
  el.innerHTML = '<div class="card" style="overflow:auto;"><div style="font-size:12px;font-weight:600;padding:8px 12px;border-bottom:1px solid var(--border);">Task lifecycle (schema 1.1)</div><table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="border-bottom:1px solid var(--border);"><th style="text-align:left;padding:6px 10px;">Time</th><th style="text-align:left;padding:6px 10px;">Phase</th><th style="text-align:left;padding:6px 10px;">Agent</th><th style="text-align:left;padding:6px 10px;">Task ID</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

// ── Tool Matrix (agents × tools from health + restart) ───────────────────────────
const TOOL_LABELS = { read_file: 'read', write_file: 'write', mkdir: 'mkdir', run_cmd: 'run', dispatch: 'dispatch', skill: 'skill', define_skill: 'define_skill', git: 'git' };

async function loadToolMatrix(){
  const el = document.getElementById('toolMatrixContainer');
  if (!el) return;
  try {
    const res = await fetch('/api/health');
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.ok) {
      const msg = d.error || (res.status === 401 ? 'Unauthorized' : res.statusText || 'Request failed');
      el.innerHTML = '<div class="card" style="padding:16px;"><div style="color:var(--yellow,#fbbf24);font-size:13px;font-weight:600;">Health check failed</div>' +
        '<div style="color:var(--text-2);font-size:12px;margin-top:8px;">' + (res.status === 401 ? 'RT token missing or invalid. Set it in Settings → System (RT token) or in ~/.crewswarm/config.json (rt.authToken).' : msg) + '</div>' +
        '<div style="color:var(--text-3);font-size:11px;margin-top:8px;">Ensure crew-lead is running on :5010 (Services tab).</div></div>';
      return;
    }
    renderTaskLifecycle(d.telemetry || []);
    window._telemetryEvents = d.telemetry || [];
    const bridgeAgents = (d.agents || []).filter(a => (a.id || '').toLowerCase() !== 'crew-lead');
    const crewLeadInfo = window._crewLeadInfo || { name: 'Crew Lead', emoji: '🧠' };
    const crewLeadRow = { id: 'crew-lead', name: crewLeadInfo.name, emoji: crewLeadInfo.emoji, tools: ['dispatch', 'skill', 'define_skill'] };
    const agents = [crewLeadRow, ...bridgeAgents];
    const toolKeys = [...new Set(['define_skill', 'skill', ...agents.flatMap(a => Array.isArray(a.tools) ? a.tools : Object.keys(a.tools || {}))])].sort();
    const labels = toolKeys.map(t => TOOL_LABELS[t] || t);
    if (!agents.length) {
      el.innerHTML = '<div class="card" style="padding:16px;"><div style="color:var(--text-2);font-size:13px;">No agents in roster.</div>' +
        '<div style="color:var(--text-3);font-size:12px;margin-top:6px;">Add agents in Settings → Agents (or ~/.crewswarm/crewswarm.json), then start bridges from Services.</div></div>';
      return;
    }
    let html = '<div class="card" style="overflow:auto;"><table style="width:100%;border-collapse:collapse;font-size:12px;">'
      + '<thead><tr style="border-bottom:1px solid var(--border);">'
      + '<th style="text-align:left;padding:8px 12px;">Agent</th>';
    toolKeys.forEach((t, i) => { html += '<th style="text-align:center;padding:8px 8px;" title="' + (t || '') + '">' + (labels[i] || t) + '</th>'; });
    html += '<th style="text-align:right;padding:8px 12px;">Quick action</th></tr></thead><tbody>';
    agents.forEach(a => {
      const tools = Array.isArray(a.tools) ? a.tools : (a.tools ? Object.keys(a.tools).filter(k => a.tools[k]) : []);
      const name = (a.emoji || '') + ' ' + (a.name || a.id || '');
      html += '<tr style="border-bottom:1px solid var(--border);">';
      html += '<td style="padding:8px 12px;"><strong>' + (name || a.id).replace(/</g, '&lt;') + '</strong></td>';
      toolKeys.forEach(t => {
        const has = tools.includes(t);
        html += '<td style="text-align:center;padding:6px 8px;">' + (has ? '<span style="color:var(--green);" title="' + t + '">✓</span>' : '<span style="color:var(--text-3);">—</span>') + '</td>';
      });
      html += '<td style="text-align:right;padding:8px 12px;"><button class="btn-ghost" style="font-size:11px;" data-agent-id="' + (a.id || '').replace(/"/g, "&quot;") + '" onclick="restartAgentFromUI(this.getAttribute(&quot;data-agent-id&quot;))">Restart</button></td></tr>';
    });
    html += '</tbody></table></div>';
    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = '<div style="color:var(--red);font-size:12px;">Error loading health: ' + (e.message || '') + '</div>';
  }
}

async function restartAgentFromUI(agentId){
  if (!agentId) return;
  try {
    const r = await fetch('/api/agents/' + encodeURIComponent(agentId) + '/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const data = await r.json();
    if (data.ok) showNotification('Restarting ' + agentId + '…');
    else showNotification(data.error || 'Restart failed', 'error');
  } catch (e) { showNotification(e.message || 'Request failed', 'error'); }
}

// ── Skills ────────────────────────────────────────────────────────────────────
let _skillsCache = [];

async function loadSkills(){
  const el = document.getElementById('skillsList');
  try {
    const d = await (await fetch('/api/skills')).json();
    _skillsCache = d.skills || [];
    renderSkillsList(_skillsCache);
  } catch(e) { el.innerHTML = '<div style="color:var(--text-3);font-size:12px;">Error loading skills</div>'; }
}

function renderSkillsList(skills){
  const el = document.getElementById('skillsList');
  if (!skills.length) { el.innerHTML = '<div style="color:var(--text-3);font-size:12px;padding:8px 0;">No skills match. Add one above or copy JSONs to ~/.crewswarm/skills/</div>'; return; }
  el.innerHTML = skills.map(s => {
    const approvalBadge = s.requiresApproval ? '<span style="margin-left:8px;font-size:10px;background:rgba(251,191,36,0.15);color:#fbbf24;padding:2px 6px;border-radius:4px;">⚠️ approval</span>' : '';
    const urlNote = s.url ? ' · <code style="background:var(--bg-1);padding:1px 4px;border-radius:3px;">' + (s.method||'POST') + ' ' + (s.url||'').slice(0,60) + '</code>' : '';
    return '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--bg-2);border-radius:var(--radius);border:1px solid var(--border);">'
         + '<div><span style="font-weight:600;font-size:13px;">' + s.name + '</span>' + approvalBadge
         + '<div style="font-size:11px;color:var(--text-3);margin-top:3px;">' + (s.description||'') + urlNote + '</div></div>'
         + '<div style="display:flex;gap:6px;flex-shrink:0;">'
         + '<button class="btn-ghost" style="font-size:11px;" data-skill="' + s.name + '" onclick="editSkill(this.dataset.skill)">Edit</button>'
         + '<button class="btn-ghost" style="font-size:11px;color:var(--red);" data-skill="' + s.name + '" onclick="deleteSkill(this.dataset.skill)">Delete</button>'
         + '</div></div>';
  }).join('');
}

function filterSkills(q){
  const lower = q.toLowerCase();
  renderSkillsList(lower ? _skillsCache.filter(s =>
    (s.name||'').toLowerCase().includes(lower) ||
    (s.description||'').toLowerCase().includes(lower) ||
    (s.url||'').toLowerCase().includes(lower)
  ) : _skillsCache);
}

function editSkill(name){
  const s = _skillsCache.find(x => x.name === name);
  if (!s) return;
  document.getElementById('skEditName').value = name;
  document.getElementById('addSkillFormTitle').textContent = 'Edit Skill';
  document.getElementById('saveSkillBtn').textContent = 'Update Skill';
  document.getElementById('skName').value = s.name || '';
  document.getElementById('skDesc').value = s.description || '';
  document.getElementById('skUrl').value = s.url || '';
  const meth = document.getElementById('skMethod');
  for (let i = 0; i < meth.options.length; i++) if (meth.options[i].value === s.method) { meth.selectedIndex = i; break; }
  const authType = s.auth?.type || '';
  document.getElementById('skAuthType').value = authType;
  document.getElementById('skAuthKey').value = s.auth?.keyFrom || s.auth?.token || '';
  document.getElementById('skAuthHeader').value = s.auth?.header || '';
  document.getElementById('skRequiresApproval').checked = !!s.requiresApproval;
  document.getElementById('skDefaults').value = s.defaultParams && Object.keys(s.defaultParams).length ? JSON.stringify(s.defaultParams, null, 2) : '';
  updateSkillAuthFields();
  const f = document.getElementById('addSkillForm');
  f.style.display = 'block';
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function toggleAddSkill(){
  cancelSkillForm();
  const f = document.getElementById('addSkillForm');
  f.style.display = f.style.display === 'none' ? 'block' : 'none';
}

function cancelSkillForm(){
  document.getElementById('skEditName').value = '';
  document.getElementById('addSkillFormTitle').textContent = 'New Skill';
  document.getElementById('saveSkillBtn').textContent = 'Save Skill';
  document.getElementById('addSkillForm').style.display = 'none';
  ['skName','skDesc','skUrl','skAuthKey','skAuthHeader','skDefaults'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  document.getElementById('skAuthType').value = '';
  document.getElementById('skRequiresApproval').checked = false;
  updateSkillAuthFields();
}
function updateSkillAuthFields(){
  const t = document.getElementById('skAuthType').value;
  document.getElementById('skAuthHeaderWrap').style.display = t === 'header' ? 'block' : 'none';
}
async function saveSkill(){
  const name = document.getElementById('skName').value.trim();
  const url  = document.getElementById('skUrl').value.trim();
  if (!name || !url) { alert('Skill name and URL are required'); return; }
  let defaultParams = {};
  try { const v = document.getElementById('skDefaults').value.trim(); if(v) defaultParams = JSON.parse(v); } catch { alert('Default Params must be valid JSON'); return; }
  const authType = document.getElementById('skAuthType').value;
  const authKeyRaw = document.getElementById('skAuthKey').value.trim();
  let auth = {};
  if (authType && authKeyRaw) {
    auth = { type: authType };
    if (authKeyRaw.startsWith('providers.') || authKeyRaw.startsWith('env.')) auth.keyFrom = authKeyRaw;
    else auth.token = authKeyRaw;
    if (authType === 'header') auth.header = document.getElementById('skAuthHeader').value.trim() || 'X-API-Key';
  }
  const editingName = document.getElementById('skEditName').value.trim();
  const body = { name, url, method: document.getElementById('skMethod').value, description: document.getElementById('skDesc').value.trim(), auth: Object.keys(auth).length ? auth : undefined, defaultParams, requiresApproval: document.getElementById('skRequiresApproval').checked };
  try {
    // If renaming, delete old file first
    if (editingName && editingName !== name) {
      await fetch('/api/skills/' + editingName, { method: 'DELETE' });
    }
    const r = await fetch('/api/skills', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(await r.text());
    cancelSkillForm();
    loadSkills();
    showNotification(editingName ? 'Skill updated' : 'Skill saved');
  } catch(e) { showNotification('Failed: ' + e.message, 'error'); }
}
async function deleteSkill(name){
  if (!confirm('Delete skill "' + name + '"?')) return;
  try { const r = await fetch('/api/skills/' + name, { method: 'DELETE' }); if(!r.ok) throw new Error(await r.text()); loadSkills(); showNotification('Deleted'); }
  catch(e) { showNotification('Delete failed: ' + e.message, 'error'); }
}

// ── Spending ──────────────────────────────────────────────────────────────────
var _agentTotalCost = null;
var _ocTotalCost = null;
function updateGrandTotal() {
  var a = _agentTotalCost, o = _ocTotalCost;
  var aEl = document.getElementById('gtAgentCost');
  var oEl = document.getElementById('gtOcCost');
  var tEl = document.getElementById('gtTotal');
  if (!aEl) return;
  if (a !== null) aEl.textContent = '$' + a.toFixed(4);
  if (o !== null) oEl.textContent = '$' + o.toFixed(4);
  if (a !== null && o !== null) tEl.textContent = '$' + (a + o).toFixed(4);
}
async function loadAllUsage() {
  var days = parseInt(document.getElementById('grandTotalDays')?.value || '14');
  var ocSel = document.getElementById('ocStatsDays');
  var spSel = document.getElementById('spendingDays');
  if (ocSel) ocSel.value = String(days);
  if (spSel) spSel.value = String(days === 1 ? 1 : days);
  _agentTotalCost = null;
  _ocTotalCost = null;
  document.getElementById('gtAgentCost').textContent = '—';
  document.getElementById('gtOcCost').textContent = '—';
  document.getElementById('gtTotal').textContent = '—';
  loadSpending();
  loadOcStats();
}
async function loadSpending(){
  const el = document.getElementById('spendingWidget');
  const days = parseInt(document.getElementById('spendingDays')?.value || '1');
  try {
    if (days <= 1) {
      // Today: real-time from crew-lead
      const d = await (await fetch('/api/spending')).json();
      const { spending, caps } = d;
      const gTokens = spending.global?.tokens || 0;
      const gCost   = spending.global?.costUSD || 0;
      const gCapTok = caps.global?.dailyTokenLimit;
      const gCapCost = caps.global?.dailyCostLimitUSD;
      let out = '<div style="margin-bottom:10px;">'
              + '<div style="font-size:11px;font-weight:600;color:var(--text-2);margin-bottom:4px;text-transform:uppercase;letter-spacing:.06em;">Global &middot; ' + (spending.date||'today') + '</div>'
              + '<div style="display:flex;gap:20px;"><span>' + gTokens.toLocaleString() + ' tokens' + (gCapTok ? ' / ' + Number(gCapTok).toLocaleString() : '') + '</span>'
              + '<span style="color:var(--yellow,#fbbf24);font-weight:600;">$' + gCost.toFixed(4) + '</span>' + (gCapCost ? '<span> / $' + gCapCost + '</span>' : '') + '</div>';
      if (gCapTok) {
        const pct = Math.min(100, (gTokens/gCapTok)*100);
        const barColor = pct > 80 ? 'var(--red)' : pct > 50 ? '#fbbf24' : 'var(--green)';
        out += '<div style="margin-top:4px;height:4px;background:var(--border);border-radius:2px;"><div style="width:' + pct + '%;height:100%;background:' + barColor + ';border-radius:2px;transition:width .3s;"></div></div>';
      }
      out += '</div>';
      const agents = Object.entries(spending.agents || {});
      if (agents.length) {
        out += '<div style="font-size:11px;font-weight:600;color:var(--text-2);margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em;">Per Agent</div>';
        out += agents.map(function(entry) {
          var id = entry[0], v = entry[1];
          const agentCap = caps.agents && caps.agents[id];
          const toks  = v.tokens || 0;
          const cost  = (v.costUSD||0).toFixed(4);
          const capTok = agentCap && agentCap.dailyTokenLimit;
          const pct    = capTok ? Math.min(100, (toks/capTok)*100) : null;
          let row = '<div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;">'
                  + '<span style="min-width:140px;font-size:12px;">' + id + '</span>'
                  + '<span style="font-size:12px;">' + toks.toLocaleString() + ' tok' + (capTok ? ' / ' + Number(capTok).toLocaleString() : '') + ' &middot; <span style="color:var(--yellow,#fbbf24);">$' + cost + '</span></span>';
          if (pct !== null) {
            const barColor = pct > 80 ? 'var(--red)' : 'var(--accent)';
            row += '<div style="flex:1;height:3px;background:var(--border);border-radius:2px;"><div style="width:' + pct + '%;height:100%;background:' + barColor + ';border-radius:2px;"></div></div>';
          }
          return row + '</div>';
        }).join('');
      } else { out += '<div style="color:var(--text-3);">No per-agent data yet for today.</div>'; }
      if (gCapTok) document.getElementById('gcapTokens').value = gCapTok;
      if (gCapCost) document.getElementById('gcapCost').value = gCapCost;
      _agentTotalCost = gCost;
      updateGrandTotal();
      el.innerHTML = out;
    } else {
      // Multi-day: compute from token-usage.json byDay
      const u = await getJSON('/api/token-usage').catch(function(){ return {}; });
      const byDay = u.byDay || {};
      const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      const filteredDays = Object.keys(byDay).filter(function(d){ return d >= cutoff; }).sort().reverse();
      if (!filteredDays.length) {
        el.innerHTML = '<div style="color:var(--text-3);">No data for this period.</div>';
        _agentTotalCost = 0;
        updateGrandTotal();
        return;
      }
      // Aggregate byModel across days
      const aggByModel = {};
      var totalTok = 0, totalCost = 0;
      filteredDays.forEach(function(day) {
        const dm = byDay[day].byModel || {};
        Object.entries(dm).forEach(function(e) {
          var m = e[0], s = e[1];
          if (!aggByModel[m]) aggByModel[m] = { prompt: 0, completion: 0 };
          aggByModel[m].prompt += s.prompt || 0;
          aggByModel[m].completion += s.completion || 0;
          totalTok += (s.prompt||0) + (s.completion||0);
        });
      });
      totalCost = estimateCost(aggByModel);
      let out = '<div style="margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;">'
              + '<span style="font-size:12px;color:var(--text-3);">Last ' + days + ' days &middot; ' + filteredDays.length + ' days of data</span>'
              + '<span style="font-size:16px;font-weight:700;color:var(--yellow,#fbbf24);">$' + totalCost.toFixed(4) + '</span>'
              + '</div>';
      // Daily breakdown bar chart
      const maxDayCost = Math.max(...filteredDays.map(function(d){ return estimateCost(byDay[d].byModel||{}); }), 0.0001);
      const today = new Date().toISOString().slice(0,10);
      out += '<div style="display:flex;flex-direction:column;gap:3px;margin-bottom:12px;">';
      filteredDays.forEach(function(day) {
        const dc = estimateCost(byDay[day].byModel||{});
        const pct = Math.max((dc/maxDayCost)*100, dc > 0 ? 2 : 0);
        const isToday = day === today;
        const tok = ((byDay[day].prompt||0)+(byDay[day].completion||0))/1000;
        out += '<div style="display:flex;align-items:center;gap:8px;font-size:11px;">'
             + '<span style="width:64px;color:var(--text-3);flex-shrink:0;">' + (isToday ? 'today' : day.slice(5)) + '</span>'
             + '<div style="flex:1;background:var(--bg-1);border-radius:3px;height:12px;overflow:hidden;">'
             +   '<div style="width:' + pct.toFixed(1) + '%;height:100%;background:' + (isToday ? 'var(--accent)' : 'var(--green)') + ';border-radius:3px;opacity:.8;"></div>'
             + '</div>'
             + '<span style="width:58px;text-align:right;color:var(--yellow,#fbbf24);font-weight:600;">$' + dc.toFixed(4) + '</span>'
             + '<span style="width:40px;text-align:right;color:var(--text-3);">' + tok.toFixed(0) + 'k</span>'
             + '</div>';
      });
      out += '</div>';
      // Top models
      const sortedModels = Object.entries(aggByModel).sort(function(a,b){
        return estimateCost({b:b[1]}) - estimateCost({a:a[1]});
      });
      if (sortedModels.length) {
        out += '<div style="font-size:11px;color:var(--text-3);margin-bottom:4px;">By model</div>';
        sortedModels.slice(0,8).forEach(function(e) {
          var m = e[0], s = e[1];
          const mc = estimateCost({x:s});
          const tok = ((s.prompt||0)+(s.completion||0))/1000;
          out += '<div style="display:flex;justify-content:space-between;font-size:11px;padding:2px 0;border-bottom:1px solid var(--border);">'
               + '<code style="color:var(--accent);">' + m + '</code>'
               + '<span style="color:var(--text-2);">' + tok.toFixed(1) + 'k tok &middot; <span style="color:var(--yellow,#fbbf24);">$' + mc.toFixed(4) + '</span></span>'
               + '</div>';
        });
      }
      _agentTotalCost = totalCost;
      updateGrandTotal();
      el.innerHTML = out;
    }
  } catch(e) { el.innerHTML = '<div style="color:var(--text-3);">Error: ' + e.message + '</div>'; }
}
async function resetSpending(){
  if (!confirm("Reset today's spending counters?")) return;
  try { await fetch('/api/spending/reset', { method: 'POST', headers:{'content-type':'application/json'}, body: '{}' }); loadSpending(); showNotification('Spending reset'); }
  catch(e) { showNotification('Reset failed', 'error'); }
}
async function saveGlobalCaps(){
  const tokens = parseInt(document.getElementById('gcapTokens').value) || null;
  const cost   = parseFloat(document.getElementById('gcapCost').value) || null;
  showNotification('Add to ~/.crewswarm/crewswarm.json: "globalSpendingCaps": {"dailyTokenLimit":' + (tokens||'null') + ',"dailyCostLimitUSD":' + (cost||'null') + '}', 'warning');
}

// ── Webhooks ──────────────────────────────────────────────────────────────────
async function sendTestWebhook(){
  const channel = document.getElementById('webhookChannel').value.trim() || 'test';
  let payload = {};
  try { const v = document.getElementById('webhookPayload').value.trim(); if(v) payload = JSON.parse(v); } catch { payload = { raw: document.getElementById('webhookPayload').value }; }
  const el = document.getElementById('webhookTestResult');
  try {
    const res = await fetch('/proxy-webhook/' + channel, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    const d = await res.json();
    el.textContent = d.ok ? '✅ Sent to RT bus' : '❌ ' + (d.error||'failed');
    el.style.color = d.ok ? 'var(--green)' : 'var(--red)';
  } catch(e) { el.textContent = '❌ ' + e.message; el.style.color='var(--red)'; }
}

// ── Pending Approvals ─────────────────────────────────────────────────────────
async function loadPendingApprovals(){
  const el = document.getElementById('pendingApprovals');
  // pending-skills.json is at ~/.crewswarm/pending-skills.json — no direct API yet; 
  // crew-lead should expose this but for now show instructions.
  el.innerHTML = '<div style="color:var(--text-3);font-size:12px;">Pending skill approvals appear here when an agent triggers a skill marked requiresApproval. You will also receive a Telegram notification with inline Approve/Reject buttons if Telegram is configured.</div>';
}
async function approveSkill(approvalId){
  try { await fetch('/api/skills/approve', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({approvalId}) }); showNotification('Approved'); loadPendingApprovals(); }
  catch(e) { showNotification('Failed: '+e.message,'error'); }
}
async function rejectSkill(approvalId){
  try { await fetch('/api/skills/reject', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({approvalId}) }); showNotification('Rejected'); loadPendingApprovals(); }
  catch(e) { showNotification('Failed: '+e.message,'error'); }
}

function showAgents(){
  hideAllViews();
  document.getElementById('agentsView').classList.add('active');
  setNavActive('navAgents');
  loadAgents_cfg();
}

// ── Agents UI ──────────────────────────────────────────────────────────────
let _allModels = [];
let _modelsByProvider = {};  // { "cerebras": ["llama3.1-8b", ...], ... }

// CrewSwarm gateway-bridge tool definitions
const CREWSWARM_TOOLS = [
  { id: 'write_file', desc: 'Write files to disk (@@WRITE_FILE)' },
  { id: 'read_file',  desc: 'Read files from disk (@@READ_FILE)' },
  { id: 'mkdir',      desc: 'Create directories (@@MKDIR)' },
  { id: 'run_cmd',    desc: 'Run whitelisted shell commands (@@RUN_CMD)' },
  { id: 'git',        desc: 'Git & GitHub CLI operations' },
  { id: 'web_search', desc: 'Web search (Brave Search — @@WEB_SEARCH)' },
  { id: 'web_fetch',  desc: 'Fetch URLs (@@WEB_FETCH)' },
  { id: 'dispatch',   desc: 'Dispatch tasks to other agents' },
  { id: 'telegram',   desc: 'Send Telegram messages (@@TELEGRAM)' },
];

// Role-based tool defaults — applied when "Apply role defaults" is clicked
const AGENT_TOOL_DEFAULTS = {
  'crew-qa':          ['read_file'],
  'crew-coder':       ['write_file','read_file','mkdir','run_cmd'],
  'crew-coder-front': ['write_file','read_file','mkdir','run_cmd'],
  'crew-coder-back':  ['write_file','read_file','mkdir','run_cmd'],
  'crew-frontend':    ['write_file','read_file','mkdir','run_cmd'],
  'crew-fixer':       ['write_file','read_file','mkdir','run_cmd'],
  'crew-github':      ['read_file','run_cmd','git'],
  'crew-pm':          ['read_file','dispatch'],
  'crew-main':        ['read_file','write_file','run_cmd','dispatch'],
  'crew-security':    ['read_file','run_cmd'],
  'crew-copywriter':  ['write_file','read_file'],
  'crew-telegram':    ['telegram','read_file'],
  'crew-lead':        ['dispatch'],
};

function getToolDefaults(agentId) {
  if (AGENT_TOOL_DEFAULTS[agentId]) return AGENT_TOOL_DEFAULTS[agentId];
  // Fuzzy match — e.g. crew-coder-3 → coder defaults
  for (const [key, val] of Object.entries(AGENT_TOOL_DEFAULTS)) {
    if (agentId.startsWith(key) || agentId.includes(key.replace('crew-',''))) return val;
  }
  return ['read_file','write_file','mkdir','run_cmd']; // sensible default for unknown roles
}

async function applyToolPreset(agentId) {
  const defaults = getToolDefaults(agentId);
  const container = document.getElementById('tools-' + agentId);
  if (!container) return;
  container.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.checked = defaults.includes(cb.dataset.tool);
  });
  await saveAgentTools(agentId);
  showNotification('Role defaults applied for ' + agentId);
}

async function loadAgents_cfg(){
  const list = document.getElementById('agentsList');
  list.innerHTML = '<div class="meta" style="padding:20px;">Loading agents…</div>';
  try {
    const data = await getJSON('/api/agents-config');
    _allModels = data.allModels || [];
    _modelsByProvider = data.modelsByProvider || {};
    const agents = sortAgents(data.agents || []);
    if (!agents.length){ list.innerHTML = '<div class="meta" style="padding:20px;">No agents found in config. Check ~/.crewswarm/crewswarm.json</div>'; return; }
    list.innerHTML = '';
    agents.forEach(a => {
      const card = document.createElement('div');
      card.className = 'agent-card';
      card.id = 'agent-card-' + a.id;
      const modelOpts = _allModels.map(m => \`<option value="\${m}" \${m === a.model ? 'selected' : ''}>\${m}</option>\`).join('');
      const customOpt = (!a.model || _allModels.includes(a.model)) ? '' : \`<option value="\${a.model}" selected>\${a.model} (custom)</option>\`;
      const liveDot = a.liveness === 'online'
        ? '<span title="● online — heartbeat <90s" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 5px var(--green);margin-right:4px;flex-shrink:0;"></span>'
        : a.liveness === 'stale'
        ? '<span title="● stale — last seen >' + (a.ageSec||'?') + 's ago" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#f59e0b;margin-right:4px;flex-shrink:0;"></span>'
        : a.liveness === 'offline'
        ? '<span title="● offline — no heartbeat in 5min" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--red,#ef4444);margin-right:4px;flex-shrink:0;"></span>'
        : '<span title="● unknown — never seen" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--text-3);margin-right:4px;flex-shrink:0;"></span>';
      card.innerHTML = \`
        <div class="agent-card-header">
          <div class="agent-avatar" id="avatar-\${a.id}" style="position:relative;">\${a.emoji}</div>
          <div class="agent-meta">
            <div class="agent-id" style="display:flex;align-items:center;">\${liveDot}\${a.id} <span class="meta" style="font-weight:400;margin-left:4px;">· \${a.name}</span>
              \${MODEL_ROLE[a.id] ? '<span style="font-size:9px;font-weight:700;letter-spacing:0.04em;padding:1px 6px;border-radius:4px;margin-left:8px;' + (ROLE_STYLE[MODEL_ROLE[a.id]]||'') + '">' + MODEL_ROLE[a.id] + '</span>' : ''}
              <span id="coding-dot-\${a.id}" style="display:none;margin-left:8px;align-items:center;gap:4px;font-size:11px;color:var(--accent);">
                <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--accent);animation:pulse 1s ease-in-out infinite;"></span>coding
              </span>
            </div>
            <div id="cur-model-\${a.id}" style="margin-top:3px;display:flex;flex-wrap:wrap;align-items:center;gap:6px;">
              <span style="font-size:11px;font-family:'SF Mono',monospace;color:\${BROKEN_MODELS.has(a.model)?'#ef4444':'var(--text-2)'};" title="Conversation model — used for direct replies and chat">
                \${BROKEN_MODELS.has(a.model) ? '⚠ ' : '💬 '}\${a.model || '(none)'}
              </span>
              \${a.opencodeModel ? '<span style="font-size:11px;font-family:monospace;color:' + (BROKEN_MODELS.has(a.opencodeModel)?'#ef4444':'#4ade80') + ';" title="OpenCode model — used when routing tasks through OpenCode CLI">⚡ ' + a.opencodeModel + '</span>' : ''}
              \${BROKEN_MODELS.has(a.model) ? '<span style="font-size:10px;font-weight:600;color:#ef4444;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);padding:1px 6px;border-radius:4px;">BROKEN — REASSIGN</span>' : ''}
            </div>
          </div>
          <button class="btn-ghost" style="font-size:11px; padding:4px 10px;" onclick="toggleAgentBody('\${a.id}')">Edit ▾</button>
          <button class="btn-ghost" style="font-size:11px; padding:4px 10px; color:var(--red); border-color:rgba(248,113,113,0.3);" onclick="deleteAgent('\${a.id}')">✕</button>
        </div>
        <div class="agent-body" id="body-\${a.id}" style="display:none;">
          <div>
            <div class="field-label" style="display:flex;align-items:center;gap:8px;">
              <span>💬 Conversation Model</span>
              <span style="font-size:10px;font-weight:400;color:var(--text-3);">Used for direct replies, planning, and chat. <strong style="color:var(--text-2);">Not used when OpenCode is enabled.</strong></span>
            </div>
            \${BROKEN_MODELS.has(a.model) ? '<div style="font-size:11px;color:#ef4444;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.25);border-radius:5px;padding:6px 10px;margin-bottom:8px;">⚠ Current model <code>' + a.model + '</code> is broken (returns empty responses). Please reassign.</div>' : ''}
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
              <select id="model-\${a.id}" style="flex:1; min-width:200px;" onchange="syncModelText('\${a.id}')">\${customOpt}\${modelOpts}</select>
              <input id="modeltext-\${a.id}" type="text" placeholder="or type provider/model…" value="\${a.model || ''}" style="flex:1; min-width:160px; font-size:12px;" oninput="syncModelSelect('\${a.id}')" />
              <button onclick="saveAgentModel('\${a.id}')" class="btn-green" style="white-space:nowrap;">Save</button>
            </div>
            <div style="margin-top:8px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
              <span style="font-size:11px;color:var(--text-3);white-space:nowrap;">↩ Fallback:</span>
              \${(() => {
                const fbCustomOpt = (a.fallbackModel && !_allModels.includes(a.fallbackModel)) ? \`<option value="\${a.fallbackModel}" selected>\${a.fallbackModel} (custom)</option>\` : '';
                const fbOpts = _allModels.map(m => \`<option value="\${m}" \${m === a.fallbackModel ? 'selected' : ''}>\${m}</option>\`).join('');
                return \`<select id="fmodel-\${a.id}" style="flex:1;min-width:180px;font-size:11px;" onchange="syncFallbackText('\${a.id}')"><option value="">— none —</option>\${fbCustomOpt}\${fbOpts}</select>\`;
              })()}
              <input id="fallback-\${a.id}" type="text" placeholder="or type any model…"
                value="\${a.fallbackModel || ''}"
                style="flex:1; min-width:140px; font-size:11px; color:var(--text-2);"
                oninput="syncFallbackSelect('\${a.id}')" />
              <button onclick="saveAgentFallback('\${a.id}')" class="btn-ghost" style="white-space:nowrap; font-size:11px;">Save</button>
            </div>
          </div>
          <div>
            <div class="field-label">Display name &amp; emoji</div>
            <div style="display:flex; gap:8px;">
              <input id="aname-\${a.id}" type="text" value="\${a.name}" placeholder="Display name" style="flex:1;" />
              <div class="emoji-picker-wrap">
                <button type="button" class="emoji-btn" id="aemoji-btn-\${a.id}" onclick="toggleEmojiPicker('\${a.id}')" title="Pick emoji">\${a.emoji||'🤖'}</button>
                <input type="hidden" id="aemoji-\${a.id}" value="\${a.emoji||'🤖'}" />
                <div class="emoji-picker-panel" id="aemoji-panel-\${a.id}">
                  <div class="emoji-grid" id="aemoji-grid-\${a.id}"></div>
                </div>
              </div>
              <button onclick="saveAgentIdentity('\${a.id}')" class="btn-ghost">Save</button>
            </div>
            <div style="margin-top:8px;">
              <div class="field-label" style="margin-bottom:4px;">Role / Theme <span style="font-weight:400; color:var(--text-3); font-size:11px;">— used by PM router to assign tasks (e.g. "iOS/Swift developer (SwiftUI, UIKit)")</span></div>
              <input id="atheme-\${a.id}" type="text" value="\${a.theme||''}" placeholder="Describe what this agent specialises in..." style="width:100%;" />
            </div>
          </div>
          <div>
            <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px;">
              <div class="field-label" style="margin:0;">System Prompt</div>
              \${!a.systemPrompt ? '<span style="font-size:11px; color:var(--yellow);">⚠ No prompt set — agent has no role context</span>' : ''}
              <select style="font-size:11px; padding:3px 8px; margin-left:auto;" onchange="applyAgentPromptPreset('\${a.id}', this.value); this.value=''">
                \${buildPresetOptions()}
              </select>
            </div>
            <textarea id="prompt-\${a.id}" rows="5" placeholder="Describe this agent's role. It's injected at the top of every task.">\${a.systemPrompt || ''}</textarea>
            <div style="margin-top:8px; display:flex; gap:8px;">
              <button onclick="saveAgentPrompt('\${a.id}')" class="btn-ghost">Save prompt</button>
            </div>
          </div>
          <div style="border-top:1px solid var(--border); padding-top:10px;">
            <div class="field-label" style="margin-bottom:8px;">Session</div>
            <div style="display:flex; gap:8px; align-items:center; margin-bottom:12px;">
              <button onclick="resetAgentSession('\${a.id}')" class="btn-ghost" style="font-size:12px;">↺ Reset context window</button>
              <span style="font-size:11px; color:var(--text-3);">Clears accumulated token context. Shared memory is re-injected on next task.</span>
            </div>
          </div>
          <div style="border-top:1px solid var(--border); padding-top:10px;">
            <div class="field-label" style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
              <span>CrewSwarm — Agent Tools</span>
              <span style="font-size:10px; font-weight:600; color:var(--accent); padding:2px 6px; border-radius:4px; background:rgba(56,189,248,0.08); border:1px solid rgba(56,189,248,0.25);">gateway-bridge</span>
            </div>
            <div class="meta" style="margin-bottom:10px; font-size:11px;">Controls which tools this agent can execute on disk and network. Enforced by gateway-bridge on every task — only checked tools are active.</div>
            <div id="tools-\${a.id}" style="display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:6px; margin-bottom:12px;">
              \${CREWSWARM_TOOLS.map(t => \`
                <label style="display:flex; align-items:flex-start; gap:7px; font-size:12px; color:var(--text-2); cursor:pointer; padding:6px 8px; border-radius:5px; border:1px solid var(--border); background:var(--bg-card2);">
                  <input type="checkbox" data-tool="\${t.id}" \${(a.alsoAllow||[]).includes(t.id)?'checked':''} style="accent-color:var(--accent); margin-top:2px; flex-shrink:0;" />
                  <div>
                    <code style="font-size:11px; color:var(--text-1);">\${t.id}</code>
                    <div style="font-size:10px; color:var(--text-3); margin-top:2px; line-height:1.3;">\${t.desc}</div>
                  </div>
                </label>
              \`).join('')}
            </div>
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:10px;">
              <button onclick="saveAgentTools('\${a.id}')" class="btn-ghost" style="font-size:12px;">Save tools</button>
              <button onclick="applyToolPreset('\${a.id}')" class="btn-ghost" style="font-size:12px; color:var(--text-3);">↩ Role defaults</button>
            </div>
            <div class="meta">Workspace: <code style="font-size:11px;">\${a.workspace}</code></div>
          </div>
          <div style="border-top:1px solid var(--border); padding-top:10px;">
            <div class="field-label" style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
              <span>⚡ Execution Route</span>
              <span style="font-size:10px; font-weight:600; color:var(--text-3); padding:2px 6px; border-radius:4px; background:var(--surface-2);">pick one — mutually exclusive</span>
            </div>
            <div style="display:flex; gap:6px; margin-bottom:10px; flex-wrap:wrap;">
              <button id="route-direct-\${a.id}" onclick="setRoute('\${a.id}','direct')"
                style="font-size:11px; font-weight:600; padding:5px 12px; border-radius:6px; cursor:pointer; border:1px solid \${!a.useOpenCode && !a.useCursorCli ? 'var(--accent)' : 'var(--border)'}; background:\${!a.useOpenCode && !a.useCursorCli ? 'rgba(99,102,241,0.15)' : 'var(--surface-2)'}; color:\${!a.useOpenCode && !a.useCursorCli ? 'var(--accent)' : 'var(--text-2)'};">
                💬 Direct API
              </button>
              <button id="route-opencode-\${a.id}" onclick="setRoute('\${a.id}','opencode')"
                style="font-size:11px; font-weight:600; padding:5px 12px; border-radius:6px; cursor:pointer; border:1px solid \${a.useOpenCode && !a.useCursorCli ? '#22c55e' : 'var(--border)'}; background:\${a.useOpenCode && !a.useCursorCli ? 'rgba(34,197,94,0.12)' : 'var(--surface-2)'}; color:\${a.useOpenCode && !a.useCursorCli ? '#22c55e' : 'var(--text-2)'};">
                ⚡ OpenCode
              </button>
              <button id="route-cursor-\${a.id}" onclick="setRoute('\${a.id}','cursor')"
                style="font-size:11px; font-weight:600; padding:5px 12px; border-radius:6px; cursor:pointer; border:1px solid \${a.useCursorCli ? '#38bdf8' : 'var(--border)'}; background:\${a.useCursorCli ? 'rgba(56,189,248,0.12)' : 'var(--surface-2)'}; color:\${a.useCursorCli ? '#38bdf8' : 'var(--text-2)'};">
                🖱 Cursor CLI <span style="font-size:10px; font-weight:400; opacity:0.7;">(free · sub)</span>
              </button>
            </div>
            <div id="oc-model-row-\${a.id}" style="display:\${a.useOpenCode && !a.useCursorCli ? 'flex' : 'none'}; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:6px;">
              <select id="oc-model-\${a.id}" style="flex:1; min-width:200px; font-size:12px;" onchange="syncOcModelText('\${a.id}')"></select>
              <input id="oc-modeltext-\${a.id}" type="text" placeholder="opencode/model…" value="\${a.opencodeModel || ''}" style="flex:1; min-width:160px; font-size:12px;" />
              <button onclick="saveOpenCodeConfig('\${a.id}')" class="btn-green" style="white-space:nowrap; font-size:12px;">Save</button>
            </div>
            <div id="oc-fallback-row-\${a.id}" style="display:\${a.useOpenCode && !a.useCursorCli ? 'flex' : 'none'}; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:10px;">
              <span style="font-size:11px; color:var(--text-3); white-space:nowrap;">↩ Fallback:</span>
              <select id="oc-fallback-sel-\${a.id}" style="flex:1; min-width:200px; font-size:12px;" onchange="syncOcFallbackText('\${a.id}')"></select>
              <input id="oc-fallback-\${a.id}" type="text" placeholder="opencode/model or leave blank" value="\${a.opencodeFallbackModel || ''}" style="flex:1; min-width:160px; font-size:12px;" />
              <button onclick="saveOpenCodeFallback('\${a.id}')" class="btn-ghost" style="white-space:nowrap; font-size:12px;">Save</button>
            </div>
            <div id="cursor-model-row-\${a.id}" style="display:\${a.useCursorCli ? 'flex' : 'none'}; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:10px;">
              <select id="cursor-model-sel-\${a.id}" style="flex:1; min-width:200px; font-size:12px;" onchange="syncCursorModelText('\${a.id}')"></select>
              <input id="cursor-model-txt-\${a.id}" type="text" placeholder="sonnet-4.6 or leave blank for auto" value="\${a.cursorCliModel || ''}" style="flex:1; min-width:160px; font-size:12px;" />
              <button onclick="saveCursorCliConfig('\${a.id}')" class="btn-sky" style="white-space:nowrap; font-size:12px;">Save</button>
            </div>
          </div>
          <div style="border-top:1px solid var(--border); padding:10px 16px; display:flex; align-items:center; justify-content:space-between; gap:8px;">
            <div style="font-size:11px; color:var(--text-3);">
              Session context accumulates over time. Reset clears the conversation history and re-injects shared memory.
            </div>
            <button onclick="resetAgentSession('\${a.id}')" class="btn-ghost" style="font-size:12px; white-space:nowrap; color:#f59e0b; border-color:rgba(245,158,11,0.3);">↺ Reset session</button>
          </div>
        </div>
      \`;
      list.appendChild(card);
    });
    // Re-populate model selects with grouped optgroups
    agents.forEach(a => {
      const sel = document.getElementById('model-' + a.id);
      if (sel) populateModelDropdown('model-' + a.id, a.model);
    });
    // Load OpenCode models and populate dropdowns
    loadOcModels().then(() => {
      agents.forEach(a => {
        populateOcModelDropdown('oc-model-' + a.id, a.opencodeModel || '');
        populateOcModelDropdown('oc-fallback-sel-' + a.id, a.opencodeFallbackModel || '');
        populateCursorModelDropdown('cursor-model-sel-' + a.id, a.cursorCliModel || '');
      });
    });
  } catch(e){ list.innerHTML = '<div class="meta" style="padding:20px; color:var(--red);">Error: ' + e.message + '</div>'; }
}

function toggleAgentBody(id){
  const body = document.getElementById('body-' + id);
  body.style.display = body.style.display === 'none' ? 'grid' : 'none';
}

async function resetAgentSession(agentId){
  if (!confirm('Reset session for ' + agentId + '?\\n\\nThis clears accumulated conversation context. Shared memory (memory/*.md) is preserved and re-injected on next task.')) return;
  try {
    const r = await postJSON('/api/agents/reset-session', { agentId });
    if (r.ok) {
      showNotification('Session reset for ' + agentId);
    } else {
      showNotification('Reset failed: ' + (r.error || 'unknown'), true);
    }
  } catch(e) {
    showNotification('Reset error: ' + e.message, true);
  }
}

async function deleteAgent(agentId){
  if (!confirm('Delete agent "' + agentId + '"? This cannot be undone.')) return;
  // Remove card from DOM instantly so it feels immediate
  const card = document.getElementById('agent-card-' + agentId);
  if (card) card.style.opacity = '0.3';
  try {
    await postJSON('/api/agents-config/delete', { agentId });
    if (card) card.remove();
    showNotification('Agent ' + agentId + ' deleted');
    await loadAgents_cfg();
  } catch(e){
    if (card) card.style.opacity = '1';
    showNotification('Delete failed: ' + e.message, true);
  }
}

function syncModelText(agentId){
  const sel = document.getElementById('model-' + agentId);
  const txt = document.getElementById('modeltext-' + agentId);
  if (txt) txt.value = sel.value;
}
function syncModelSelect(agentId){
  const txt = document.getElementById('modeltext-' + agentId);
  const sel = document.getElementById('model-' + agentId);
  if (!sel) return;
  const typed = txt.value.trim();
  // Try to match an existing option
  const match = [...sel.options].find(o => o.value === typed);
  sel.value = match ? typed : '';
}
function syncFallbackText(agentId){
  const sel = document.getElementById('fmodel-' + agentId);
  const txt = document.getElementById('fallback-' + agentId);
  if (txt) txt.value = sel.value;
}
function syncFallbackSelect(agentId){
  const txt = document.getElementById('fallback-' + agentId);
  const sel = document.getElementById('fmodel-' + agentId);
  if (!sel) return;
  const typed = txt.value.trim();
  const match = [...sel.options].find(o => o.value === typed);
  sel.value = match ? typed : '';
}
async function resetAgentSession(agentId){
  if (!confirm('Reset context window for ' + agentId + '?\\n\\nThis clears the agent\\'s accumulated conversation history. Shared memory files will be re-injected on the next task.')) return;
  showNotification('Resetting ' + agentId + ' session...');
  try {
    await postJSON('/api/agents-config/reset-session', { agentId });
    showNotification(agentId + ' session reset');
  } catch(e) {
    showNotification('Reset failed: ' + e.message, true);
  }
}

function refreshModelHeader(agentId, model, opencodeModel) {
  const el = document.getElementById('cur-model-' + agentId);
  if (!el) return;
  const chatBroken = BROKEN_MODELS.has(model);
  const ocBroken   = opencodeModel && BROKEN_MODELS.has(opencodeModel);
  el.innerHTML =
    \`<span style="font-size:11px;font-family:'SF Mono',monospace;color:\${chatBroken?'#ef4444':'var(--text-2)'};" title="Conversation model">\${chatBroken?'⚠ ':'💬 '}\${model||'(none)'}</span>\` +
    (opencodeModel ? \`<span style="font-size:11px;font-family:'SF Mono',monospace;color:\${ocBroken?'#ef4444':'#4ade80'};" title="OpenCode model">⚡ \${opencodeModel}</span>\` : '') +
    (chatBroken ? \`<span style="font-size:10px;font-weight:600;color:#ef4444;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);padding:1px 6px;border-radius:4px;">BROKEN — REASSIGN</span>\` : '');
}

async function saveAgentModel(agentId){
  const txt = document.getElementById('modeltext-' + agentId);
  const sel = document.getElementById('model-' + agentId);
  const model = (txt && txt.value.trim()) || (sel && sel.value) || '';
  if (!model){ showNotification('Select or type a model', true); return; }
  if (BROKEN_MODELS.has(model)) {
    showNotification('⚠ That model returns empty responses — choose another', true);
    return;
  }
  try {
    await postJSON('/api/agents-config/update', { agentId, model });
    const ocModel = document.getElementById('oc-modeltext-' + agentId)?.value.trim() || '';
    refreshModelHeader(agentId, model, ocModel);
    showNotification(\`\${agentId} → \${model}\`);
  } catch(e){ showNotification('Failed: ' + e.message, true); }
}

async function saveAgentFallback(agentId){
  const inp = document.getElementById('fallback-' + agentId);
  const fallbackModel = inp?.value.trim() || '';
  try {
    await postJSON('/api/agents-config/update', { agentId, fallbackModel });
    showNotification(fallbackModel ? \`Fallback set: \${fallbackModel}\` : \`Fallback cleared for \${agentId}\`);
  } catch(e){ showNotification('Failed: ' + e.message, true); }
}

// ── OpenCode per-agent config ───────────────────────────────────────────────
let _ocModelsCache = null;

async function loadOcModels() {
  if (_ocModelsCache) return _ocModelsCache;
  try {
    const r = await fetch('/api/opencode-models');
    const d = await r.json();
    _ocModelsCache = Array.isArray(d.models) ? d.models : [];
  } catch { _ocModelsCache = []; }
  return _ocModelsCache;
}

const OC_MODEL_LABELS = {
  'opencode/big-pickle':              'Big Pickle (Stealth)',
  'opencode/trinity-large-preview-free': 'Trinity Large Preview (Stealth)',
  'opencode/gpt-5':                   'GPT 5',
  'opencode/gpt-5-codex':             'GPT 5 Codex',
  'opencode/gpt-5-nano':              'GPT 5 Nano',
  'opencode/gpt-5.1':                 'GPT 5.1',
  'opencode/gpt-5.1-codex':          'GPT 5.1 Codex',
  'opencode/gpt-5.1-codex-max':      'GPT 5.1 Codex Max',
  'opencode/gpt-5.1-codex-mini':     'GPT 5.1 Codex Mini',
  'opencode/gpt-5.2':                 'GPT 5.2',
  'opencode/gpt-5.2-codex':          'GPT 5.2 Codex',
  'opencode/alpha-gpt-5.3-codex':    'GPT 5.3 Codex (alpha)',
  'opencode/alpha-gpt-5.4':          'GPT 5.4 (alpha)',
  'opencode/claude-sonnet-4':         'Claude Sonnet 4',
  'opencode/claude-sonnet-4-5':       'Claude Sonnet 4.5',
  'opencode/claude-sonnet-4-6':       'Claude Sonnet 4.6',
  'opencode/claude-opus-4-1':         'Claude Opus 4.1',
  'opencode/claude-opus-4-5':         'Claude Opus 4.5',
  'opencode/claude-opus-4-6':         'Claude Opus 4.6',
  'opencode/claude-haiku-4-5':        'Claude Haiku 4.5',
  'opencode/claude-3-5-haiku':        'Claude 3.5 Haiku',
  'opencode/gemini-3-flash':          'Gemini 3 Flash',
  'opencode/gemini-3-pro':            'Gemini 3 Pro',
  'opencode/gemini-3.1-pro':          'Gemini 3.1 Pro',
  'opencode/kimi-k2':                 'Kimi K2',
  'opencode/kimi-k2-thinking':        'Kimi K2 Thinking',
  'opencode/kimi-k2.5':               'Kimi K2.5',
  'opencode/kimi-k2.5-free':          'Kimi K2.5 Free',
  'opencode/glm-4.6':                 'GLM 4.6 (Z.ai)',
  'opencode/glm-4.7':                 'GLM 4.7 (Z.ai)',
  'opencode/glm-5':                   'GLM 5 (Z.ai)',
  'opencode/glm-5-free':              'GLM 5 Free (Z.ai)',
  'opencode/minimax-m2.1':            'MiniMax M2.1',
  'opencode/minimax-m2.1-free':       'MiniMax M2.1 Free',
  'opencode/minimax-m2.5':            'MiniMax M2.5',
  'opencode/minimax-m2.5-free':       'MiniMax M2.5 Free',
};

function populateOcModelDropdown(selectId, currentVal) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  sel.innerHTML = '<option value="">— select model —</option>';

  // Merge OpenCode server models + all provider models so Groq/xAI/etc all appear
  const ocModels = (_ocModelsCache || []).map(m =>
    typeof m === 'string' ? m : (m.provider ? m.provider + '/' + m.id : m.id || m.name || String(m))
  );
  const allCombined = [...new Set([...ocModels, ...(_allModels || [])])].filter(Boolean);

  const grouped = {};
  allCombined.forEach(full => {
    const provider = full.includes('/') ? full.split('/')[0] : 'other';
    if (!grouped[provider]) grouped[provider] = [];
    grouped[provider].push(full);
  });

  for (const [provider, ids] of Object.entries(grouped)) {
    const grp = document.createElement('optgroup');
    grp.label = provider.toUpperCase();
    ids.forEach(full => {
      const opt = document.createElement('option');
      opt.value = full;
      opt.textContent = OC_MODEL_LABELS[full] || full;
      if (full === currentVal) opt.selected = true;
      grp.appendChild(opt);
    });
    sel.appendChild(grp);
  }

  if (currentVal && !sel.value) {
    const opt = document.createElement('option');
    opt.value = currentVal;
    opt.textContent = (OC_MODEL_LABELS[currentVal] || currentVal) + ' (custom)';
    opt.selected = true;
    sel.prepend(opt);
  }
}

// Cursor CLI subscription models (populated from agent models command)
const CURSOR_CLI_MODELS = [
  { id: '', label: '— auto (subscription default) —' },
  { id: 'opus-4.6-thinking', label: 'Claude 4.6 Opus (Thinking) — best reasoning' },
  { id: 'opus-4.6', label: 'Claude 4.6 Opus' },
  { id: 'sonnet-4.6-thinking', label: 'Claude 4.6 Sonnet (Thinking)' },
  { id: 'sonnet-4.6', label: 'Claude 4.6 Sonnet — best coding' },
  { id: 'sonnet-4.5', label: 'Claude 4.5 Sonnet' },
  { id: 'gpt-5.3-codex-xhigh', label: 'GPT-5.3 Codex XHigh' },
  { id: 'gpt-5.3-codex-high', label: 'GPT-5.3 Codex High' },
  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  { id: 'gpt-5.3-codex-fast', label: 'GPT-5.3 Codex Fast' },
  { id: 'gpt-5.2', label: 'GPT-5.2' },
  { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
  { id: 'gemini-3-flash', label: 'Gemini 3 Flash' },
  { id: 'grok', label: 'Grok' },
  { id: 'kimi-k2.5', label: 'Kimi K2.5' },
];

function populateCursorModelDropdown(selId, currentVal) {
  const sel = document.getElementById(selId);
  if (!sel) return;
  sel.innerHTML = CURSOR_CLI_MODELS.map(m =>
    '<option value="' + m.id + '"' + (m.id === (currentVal||'') ? ' selected' : '') + '>' + m.label + '</option>'
  ).join('');
}

function syncCursorModelText(agentId) {
  const sel = document.getElementById('cursor-model-sel-' + agentId);
  const txt = document.getElementById('cursor-model-txt-' + agentId);
  if (sel && txt) txt.value = sel.value;
}

// 3-way route toggle — mutually exclusive
async function setRoute(agentId, route) {
  const useOpenCode = route === 'opencode';
  const useCursorCli = route === 'cursor';
  // Update button styles
  const styles = {
    direct:   { border: 'var(--accent)', bg: 'rgba(99,102,241,0.15)', color: 'var(--accent)' },
    opencode: { border: '#22c55e',       bg: 'rgba(34,197,94,0.12)',  color: '#22c55e' },
    cursor:   { border: '#38bdf8',       bg: 'rgba(56,189,248,0.12)', color: '#38bdf8' },
    inactive: { border: 'var(--border)', bg: 'var(--surface-2)',      color: 'var(--text-2)' },
  };
  ['direct','opencode','cursor'].forEach(r => {
    const btn = document.getElementById('route-' + r + '-' + agentId);
    if (!btn) return;
    const s = r === route ? styles[r] : styles.inactive;
    btn.style.borderColor = s.border; btn.style.background = s.bg; btn.style.color = s.color;
  });
  // Show/hide model rows
  const ocRow = document.getElementById('oc-model-row-' + agentId);
  const ocFbRow = document.getElementById('oc-fallback-row-' + agentId);
  const cursorRow = document.getElementById('cursor-model-row-' + agentId);
  if (ocRow) ocRow.style.display = useOpenCode ? 'flex' : 'none';
  if (ocFbRow) ocFbRow.style.display = useOpenCode ? 'flex' : 'none';
  if (cursorRow) cursorRow.style.display = useCursorCli ? 'flex' : 'none';
  // Save
  try {
    await postJSON('/api/agents-config/update', { agentId, useOpenCode, useCursorCli });
    const label = route === 'direct' ? 'Direct API' : route === 'opencode' ? 'OpenCode' : 'Cursor CLI';
    showNotification(agentId + ' → ' + label);
  } catch(e) { showNotification('Failed: ' + e.message, true); }
}

async function saveCursorCliConfig(agentId) {
  const cursorCliModel = (document.getElementById('cursor-model-txt-' + agentId)?.value || '').trim();
  try {
    await postJSON('/api/agents-config/update', { agentId, cursorCliModel });
    showNotification(agentId + ' Cursor model → ' + (cursorCliModel || 'auto'));
  } catch(e) { showNotification('Failed: ' + e.message, true); }
}

function toggleOpenCodeUI(agentId) {
  // Legacy — kept for any stale references; use setRoute instead
  const checked = document.getElementById('oc-toggle-' + agentId)?.checked;
  if (checked !== undefined) setRoute(agentId, checked ? 'opencode' : 'direct');
}

function syncOcModelText(agentId) {
  const sel = document.getElementById('oc-model-' + agentId);
  const txt = document.getElementById('oc-modeltext-' + agentId);
  if (sel && txt && sel.value) txt.value = sel.value;
}

function syncOcFallbackText(agentId) {
  const sel = document.getElementById('oc-fallback-sel-' + agentId);
  const txt = document.getElementById('oc-fallback-' + agentId);
  if (sel && txt && sel.value) txt.value = sel.value;
}

async function saveOpenCodeFallback(agentId) {
  const opencodeFallbackModel = (document.getElementById('oc-fallback-' + agentId)?.value || '').trim();
  try {
    await postJSON('/api/agents-config/update', { agentId, opencodeFallbackModel });
    showNotification(opencodeFallbackModel ? agentId + ' OC fallback → ' + opencodeFallbackModel : 'OC fallback cleared for ' + agentId);
  } catch(e) { showNotification('Failed: ' + e.message, true); }
}

async function saveOpenCodeConfig(agentId) {
  // Only saves the opencodeModel — route (useOpenCode flag) is set by the route buttons via setRoute().
  // Reading the old oc-toggle checkbox here was a bug: the checkbox no longer exists, causing it
  // to always send useOpenCode:false and toast "→ direct LLM" even when OpenCode route was active.
  const opencodeModel = (document.getElementById('oc-modeltext-' + agentId)?.value || '').trim();
  try {
    await postJSON('/api/agents-config/update', { agentId, opencodeModel });
    const chatModel = document.getElementById('modeltext-' + agentId)?.value.trim() || '';
    refreshModelHeader(agentId, chatModel, opencodeModel);
    showNotification(agentId + ' OC model → ' + (opencodeModel || 'default'));
  } catch(e) { showNotification('Failed: ' + e.message, true); }
}

async function saveCursorCliToggle(agentId) {
  // Legacy shim — delegates to setRoute
  const useCursorCli = document.getElementById('cursor-cli-toggle-' + agentId)?.checked || false;
  await setRoute(agentId, useCursorCli ? 'cursor' : 'direct');
}

// Bulk route setter — apply a route to all coding agents at once
async function bulkSetRoute(route, model) {
  const CODING_AGENTS = ['crew-coder','crew-coder-front','crew-coder-back','crew-frontend','crew-fixer','crew-architect','crew-ml'];
  const label = route === 'cursor' ? 'Cursor CLI' : route === 'opencode' ? 'OpenCode' : 'Direct API';
  showNotification('Applying ' + label + ' to all coding agents…');
  for (const agentId of CODING_AGENTS) {
    const useOpenCode = route === 'opencode';
    const useCursorCli = route === 'cursor';
    try {
      const payload = { agentId, useOpenCode, useCursorCli };
      if (model && route === 'cursor') payload.cursorCliModel = model;
      if (model && route === 'opencode') payload.opencodeModel = model;
      await postJSON('/api/agents-config/update', payload);
    } catch(e) { console.error('bulkSetRoute failed for', agentId, e.message); }
  }
  showNotification('Done — ' + CODING_AGENTS.length + ' agents set to ' + label + (model ? ' (' + model + ')' : ''));
  loadAgents();
}

const AGENT_EMOJIS = ['🤖','🧠','⚡','🔥','🎯','🛡️','🔧','🐛','🔬','📋','✍️','🐙','🎨','🖥️','📱','🔒','📊','🚀','💡','🌐','⚙️','🦊','🦾','💻','🏗️','🔍','📝','💬','🧪','🎭'];

function toggleEmojiPicker(agentId) {
  const panel = document.getElementById('aemoji-panel-' + agentId);
  const grid  = document.getElementById('aemoji-grid-'  + agentId);
  const isOpen = panel.classList.contains('open');
  document.querySelectorAll('.emoji-picker-panel.open').forEach(p => p.classList.remove('open'));
  if (isOpen) return;
  if (!grid.hasChildNodes()) {
    grid.innerHTML = AGENT_EMOJIS.map(e =>
      '<div class="emoji-opt" data-agent="' + agentId + '" data-emoji="' + e + '" title="' + e + '">' + e + '</div>'
    ).join('');
    grid.addEventListener('click', function(ev) {
      const opt = ev.target.closest('.emoji-opt');
      if (opt) selectEmoji(opt.dataset.agent, opt.dataset.emoji);
    });
  }
  panel.classList.add('open');
}

function selectEmoji(agentId, emoji) {
  const isNew = agentId === '__new__';
  const inputEl = isNew ? document.getElementById('naEmoji') : document.getElementById('aemoji-' + agentId);
  const btnEl   = isNew ? document.getElementById('naEmoji-btn') : document.getElementById('aemoji-btn-' + agentId);
  if (inputEl) inputEl.value = emoji;
  if (btnEl)   btnEl.textContent = emoji;
  document.getElementById('aemoji-panel-' + agentId).classList.remove('open');
}

// close picker when clicking outside
document.addEventListener('click', e => {
  if (!e.target.closest('.emoji-picker-wrap')) {
    document.querySelectorAll('.emoji-picker-panel.open').forEach(p => p.classList.remove('open'));
  }
});

async function saveAgentIdentity(agentId){
  const name  = document.getElementById('aname-'  + agentId).value.trim();
  const emoji = document.getElementById('aemoji-' + agentId).value.trim();
  const theme = document.getElementById('atheme-' + agentId)?.value.trim();
  try {
    await postJSON('/api/agents-config/update', { agentId, name, emoji, theme });
    showNotification('Identity saved for ' + agentId);
  } catch(e){ showNotification('Failed: ' + e.message, true); }
}

window.applyAgentPromptPreset = function(agentId, preset) {
  if (!preset || !PROMPT_PRESETS[preset]) return;
  const ta = document.getElementById('prompt-' + agentId);
  if (ta) ta.value = PROMPT_PRESETS[preset];
  // Auto-fill the theme/role field with the preset's display name (strip leading emoji + whitespace)
  const themeEl = document.getElementById('atheme-' + agentId);
  if (themeEl) {
    const opt = PRESET_OPTIONS.find(p => p.value === preset);
    if (opt) themeEl.value = opt.label.replace(/^[\u{1F000}-\u{1FFFF}\u2600-\u27BF\uFE0F\u20D0-\u20FF\s]+/u, '').trim();
  }
};

async function saveAgentPrompt(agentId){
  const systemPrompt = document.getElementById('prompt-' + agentId).value;
  try {
    await postJSON('/api/agents-config/update', { agentId, systemPrompt });
    showNotification('Prompt saved for ' + agentId);
  } catch(e){ showNotification('Failed: ' + e.message, true); }
}

async function startCrew(){
  try {
    showNotification('Starting crew bridge daemons…');
    const r = await postJSON('/api/crew/start', {});
    showNotification(r.message || 'Crew started');
  } catch(e){ showNotification('Crew start failed: ' + e.message, true); }
}

const NEW_AGENT_TOOL_PRESETS = {
  coder:        ['write_file','read_file','mkdir','run_cmd'],   // frontend, backend, fullstack, ios, android, data, aiml, api, db, rn, web3, automation, fixer
  writer:       ['write_file','read_file'],                     // copywriter, docs, design (no shell exec)
  reviewer:     ['read_file'],                                  // qa, strict read-only audit
  security:     ['read_file','run_cmd'],                        // security auditor — run scanners but never write
  orchestrator: ['read_file','dispatch'],                       // pm, planner — routes tasks but doesn't write files
  coordinator:  ['write_file','read_file','run_cmd','dispatch'],// main/lead — full access + dispatch, no git
  devops:       ['read_file','run_cmd','git'],                  // devops, github ops
  comms:        ['telegram','read_file'],                       // telegram notification agent
};

function applyNewAgentToolPreset() {
  const preset = document.getElementById('naToolPreset').value;
  if (!preset || !NEW_AGENT_TOOL_PRESETS[preset]) return;
  const allowed = NEW_AGENT_TOOL_PRESETS[preset];
  document.querySelectorAll('.naToolCheck').forEach(cb => {
    cb.checked = allowed.includes(cb.dataset.tool);
  });
}

async function saveAgentTools(agentId){
  const container = document.getElementById('tools-' + agentId);
  const checked = [...container.querySelectorAll('input[type=checkbox]:checked')].map(el => el.dataset.tool);
  try {
    await postJSON('/api/agents-config/update', { agentId, alsoAllow: checked });
    showNotification('Tools saved for ' + agentId);
  } catch(e){ showNotification('Failed: ' + e.message, true); }
}

// Single source of truth for all preset options — used by both new-agent form and edit cards
const PRESET_OPTIONS = [
  { value: 'frontend',    label: '🎨 Frontend (HTML/CSS/JS)' },
  { value: 'backend',     label: '⚙️ Backend (Node/API/scripts)' },
  { value: 'fullstack',   label: '🧱 Full-stack coder' },
  { value: 'ios',         label: '📱 iOS / Swift developer' },
  { value: 'android',     label: '🤖 Android / Kotlin developer' },
  { value: 'devops',      label: '🔧 DevOps / Infrastructure' },
  { value: 'data',        label: '📊 Data / Analytics / Python' },
  { value: 'security',    label: '🛡️ Security auditor' },
  { value: 'qa',          label: '🧪 QA / tester' },
  { value: 'github',      label: '🐙 Git & GitHub ops' },
  { value: 'writer',      label: '✍️ Content / copywriter' },
  { value: 'design',      label: '🖌️ UI/UX designer' },
  { value: 'pm',          label: '📋 Product manager / planner' },
  { value: 'aiml',        label: '🤖 AI / ML engineer' },
  { value: 'api',         label: '🔌 API designer (REST/GraphQL)' },
  { value: 'database',    label: '🗄️ Database specialist' },
  { value: 'reactnative', label: '📱 React Native (cross-platform)' },
  { value: 'web3',        label: '🌐 Web3 / Blockchain (Solidity)' },
  { value: 'automation',  label: '🕷️ Automation / scraping' },
  { value: 'docs',        label: '📖 Technical docs writer' },
  { value: 'orchestrator', label: '🧠 Orchestrator / PM loop' },
  { value: 'lead',        label: '🦊 Team lead / coordinator' },
  { value: 'main',        label: '⚡ Main agent (general)' },
];
function buildPresetOptions(placeholder) {
  var ph = placeholder || 'Presets\u2026';
  var opts = PRESET_OPTIONS.map(function(p){ return '<option value="' + p.value + '">' + p.label + '</option>'; }).join('');
  return '<option value="">' + ph + '</option>' + opts;
}

const PROMPT_PRESETS = {
  frontend: \`Frontend implementation specialist. Apple/Linear/Vercel-level polish is the baseline.

## Design standard
- Typography: system font stack or Inter. 16-18px body, 1.5 line-height. Weight hierarchy (400/500/600/700).
- Spacing: 8px grid. Section padding 48-96px. Let content breathe.
- Color: muted neutrals + one accent. Dark mode via CSS custom properties. No pure black (#000).
- Motion: 200-300ms ease-out. Fade + translateY for reveals. Respect prefers-reduced-motion.
- Layout: mobile-first, CSS Grid + Flexbox, max-width 1200px. Full-bleed hero sections.
- Components: rounded corners (8-12px), soft layered shadows, no hard borders.
- Accessibility: semantic HTML, focus-visible, 4.5:1 contrast, aria-labels.

## Research — use these sources
- @@WEB_FETCH https://developer.apple.com/design/human-interface-guidelines for Apple HIG
- @@WEB_SEARCH site:uiverse.io [component] for copy-pasteable HTML/CSS examples (7000+ free)
- @@WEB_SEARCH site:css-tricks.com [technique] for CSS guides
- @@WEB_SEARCH awwwards [page type] OR onepagelove [page type] for design inspiration
- @@WEB_FETCH https://developer.mozilla.org/en-US/docs/Web/CSS/[property] for CSS reference
- @@WEB_SEARCH site:codepen.io [component] vanilla CSS for interactive examples

## Rules
- ALWAYS read existing files before editing. Match the design system in place.
- If no design system exists, establish CSS custom properties (--color-*, --space-*, --radius-*).
- Test mental model: 375px, 768px, 1440px — all three must look intentional.\`,

  backend: \`Backend specialist. Node.js, APIs, databases, server logic.

## Standards
- ES modules, async/await, no callbacks. Prefer native Node APIs over dependencies.
- Every endpoint: input validation, error handling, proper HTTP status codes, structured JSON responses.
- Database: parameterized queries only (never string interpolation), connection pooling, transactions for multi-step writes.
- Auth: bcrypt/argon2 for passwords, JWT with short expiry + refresh tokens. Never plaintext.
- Logging: structured (JSON), include request ID, timestamp, level.
- Config via env vars, never hardcoded secrets. Validate required env vars at startup.
- @@WEB_SEARCH for library APIs and docs when using packages you haven't used recently.

## Rules
- ALWAYS read existing files before editing. Match patterns and naming.
- Think about failures: what happens when the request fails, DB is down, or input is malformed?\`,

  fullstack: \`Full-stack coding specialist. Clean, readable code across the entire stack.

## Standards
- Small functions, clear names, no dead code. Error handling everywhere.
- ES modules (import/export), async/await. Match existing code patterns.
- Frontend: semantic HTML, accessible, responsive. Backend: validate inputs, handle errors, proper status codes.
- @@WEB_SEARCH for API docs and library usage when using unfamiliar packages.

## Rules
- ALWAYS read existing files before editing — understand what exists.
- Surgical edits only — change what's asked, nothing else.
- Trace the happy path and one error path mentally before reporting done.\`,

  qa: \`QA specialist. Systematic audits backed by evidence from the actual code.

## Process
1. @@READ_FILE every file you audit — no exceptions
2. Check against: error handling, input validation, edge cases, security, performance, correctness
3. Report ONLY issues you can point to in the actual code with real line numbers

## Output format
### CRITICAL — Line N: [issue] → Fix: [exact code]
### HIGH — Line N: [issue] → Fix: [exact code]
### MEDIUM / LOW
### Summary: X issues. Verdict: PASS / PASS WITH WARNINGS / FAIL

## Rules
- Do NOT invent line numbers. Only cite what you read.
- CRITICAL issues = FAIL verdict. No exceptions.
- You are NOT a coordinator — do NOT use @@DISPATCH.
- @@WEB_SEARCH best practices or known vulnerability patterns when unsure.\`,

  github: \`Git and GitHub specialist.

## Before any operation
- git status, git config user.name, git config user.email
- For PRs: gh auth status

## Commit standard
- Conventional commits: feat(scope):, fix(scope):, chore:, docs:, refactor:, test:
- Subject ≤72 chars. Body explains WHY, not what.
- Stage specific files — never git add -A unless asked.
- Never commit: .env, *.pem, *credentials*, API keys.

## Rules
- Never force-push to main or master.
- Always git diff --stat before committing.
- One logical change per commit.\`,

  writer: \`Content and copywriting specialist.

## Voice
- Clear, confident, human. Short sentences. Active voice. Cut every word that doesn't earn its place.
- Headlines: benefit-first, specific, no jargon. "Ship 10x faster" beats "Leverage AI-powered solutions."
- No buzzwords: leverage, synergy, cutting-edge, revolutionary, seamless, robust.
- No filler: "In today's fast-paced world..." — delete it.
- Numbers > adjectives. "3 agents, 12 seconds" beats "multiple agents, incredibly fast."

## Research — mandatory
- @@WEB_SEARCH competitors, market positioning, and facts BEFORE writing. Never invent claims.
- @@WEB_FETCH reference sites for tone/style inspiration.

## Rules
- ALWAYS @@WRITE_FILE your output — never just show text in chat.
- Read existing content first to match voice. After draft, cut 30%.\`,

  ios: \`iOS/Swift specialist. SwiftUI, UIKit, and native Apple platform code.

## Standards
- SwiftUI for new views unless the project uses UIKit exclusively.
- Swift naming: camelCase vars, PascalCase types. async/await over completion handlers.
- Use @MainActor for UI updates. Structured concurrency with TaskGroup when appropriate.
- Follow MVVM with ObservableObject/Observable. Keep views thin.
- @@WEB_SEARCH Apple developer docs and WWDC sessions for current APIs.

## Rules
- ALWAYS read existing Swift files before editing.
- Handle optionals safely — guard let / if let, never force-unwrap in production.
- Support Dynamic Type and VoiceOver accessibility.\`,

  android: \`Android/Kotlin specialist. Jetpack Compose, Android SDK, and modern Android architecture.

## Standards
- Jetpack Compose for new UI unless the project uses XML layouts.
- Architecture: MVVM with ViewModel, StateFlow/SharedFlow, Hilt for DI.
- Coroutines and Flow for async. Structured concurrency with viewModelScope.
- Follow Material 3 design guidelines.
- @@WEB_SEARCH Android developer docs for current API patterns and Compose components.

## Rules
- ALWAYS read existing files before editing. Match architecture patterns.
- Handle configuration changes properly. Test on multiple screen sizes.\`,

  devops: \`DevOps and infrastructure specialist. CI/CD, Docker, shell scripts, IaC.

## Standards
- Idempotent scripts — safe to run multiple times.
- Dockerfiles: multi-stage builds, non-root user, minimal base images, .dockerignore.
- CI/CD: fail fast, cache dependencies, pin action versions.
- IaC: Terraform state management, modular configs, no hardcoded values.
- @@WEB_SEARCH current best practices for tools and cloud services.

## Rules
- ALWAYS read existing configs before editing. Never blindly overwrite deployment configs.
- Secrets in env vars or secret managers, never in source.
- Write clear inline comments in all scripts and configs.\`,

  data: \`Data and analytics specialist. Python, SQL, pandas, data pipelines.

## Standards
- Clean Python with type hints and docstrings. Validate inputs, handle nulls explicitly.
- pandas/polars for transformation, matplotlib/plotly for visualization.
- SQL: parameterized queries, CTEs for readability, explain plans for optimization.
- @@WEB_SEARCH for library APIs, dataset documentation, and statistical methods.

## Rules
- ALWAYS read existing data files and schemas before writing code.
- NEVER overwrite raw data. Transform into new files/tables.
- Reproducibility: set random seeds, log parameters, version datasets.\`,

  security: \`Security auditor. OWASP-aware, evidence-based.

## Audit checklist
- Secrets: hardcoded API keys/tokens/passwords, .env in source, secrets in logs or client code
- Injection: SQL string concat, unescaped user input (XSS), user input in exec/spawn, path traversal
- Auth: missing auth on protected routes, broken sessions, privilege escalation, CORS misconfiguration
- Data: plaintext passwords, sensitive data in URLs, missing rate limiting, no input validation
- @@WEB_SEARCH to verify if a pattern is actually exploitable when unsure

## Rules
- @@READ_FILE every file before reporting. Never guess.
- Report only — NEVER modify files.
- Output: severity + file:line + vulnerability + exact remediation.
- Overall risk: CRITICAL / HIGH / MODERATE / LOW.\`,

  design: \`UI/UX design and implementation specialist. You ship premium, production-ready interfaces.

## Design DNA — Apple.com, Linear.app, Vercel.com, Stripe.com level quality.
- Reduction: remove every element that doesn't serve the user's goal. White space is a feature.
- Typography: Inter or system stack. Scale 14/16/20/28/40/56px. Weight 400/500/600/700. Line-height 1.5 body, 1.2 display.
- Color: neutrals (gray-50→950) + one accent. Dark mode first via custom properties. No pure #000.
- Spacing: 8px grid. Sections 64-96px vertical pad. Cards 24-32px. CSS gap everywhere.
- Shadows: layered — sm (0 1px 2px), md (0 4px 16px), lg (0 12px 48px). rgba(0,0,0,0.06-0.12).
- Motion: 200ms ease-out on interactive elements. Fade + translateY(8px) for reveals. Skeleton screens over spinners.
- Layout: mobile-first (640/768/1024/1280). Max-width 1200px. CSS Grid pages, Flexbox components.

## Research — use these sources
- @@WEB_FETCH https://developer.apple.com/design/human-interface-guidelines for Apple HIG
- @@WEB_SEARCH site:uiverse.io [component] for copy-pasteable HTML/CSS examples (7000+ free)
- @@WEB_SEARCH site:css-tricks.com [technique] for CSS technique guides
- @@WEB_SEARCH awwwards [page type] OR onepagelove [page type] for design inspiration
- @@WEB_SEARCH site:codepen.io [component] vanilla CSS for interactive examples

## Rules
- Accessible: focus-visible, aria-labels, 4.5:1 contrast, semantic HTML.\`,

  pm: \`Product manager and project planner. Task decomposition and roadmap management.

## Planning principles
- Every task: independently deliverable. If it can't be tested alone, split it.
- Imperative form: "Create X", "Add Y to Z", "Fix W in file F". Never "Improve" or "Look into."
- Each task → one agent, one file path, one deliverable.
- Include acceptance criteria: what does done look like? What should the agent verify?
- Task size: completable in 1-2 minutes of LLM work. Bigger = split.

## Anti-patterns
- "Improve the landing page" → too vague. Which section? What's wrong?
- "Set up the backend" → too broad. Which endpoint? What data? What auth?
- Tasks without file paths → agent won't know where to work.

## Rules
- Flag missing requirements before handoff.
- @@WEB_SEARCH to research approaches for unfamiliar features.
- Update ROADMAP.md with [ ] checkboxes.\`,

  aiml: \`AI/ML engineering specialist. Model training, fine-tuning, eval, and MLOps.

## Standards
- Reproducibility: set random seeds, log all hyperparameters, version datasets.
- Data: validate schema before training. Check for nulls, duplicates, class imbalance.
- Training: early stopping, gradient clipping, learning rate scheduling.
- Evaluation: never eval on training data. Hold out test set. Report confidence intervals.
- Code: type hints, docstrings on public APIs, structured logging.

## Research — critical for ML
- @@WEB_SEARCH for model cards, API docs, library versions before implementation.
- @@WEB_FETCH HuggingFace docs, paper abstracts, or API references.
- @@WEB_SEARCH "[library] breaking changes" when using specific versions.

## Rules
- ALWAYS read existing code before modifying. Pin dependency versions.
- Never hardcode paths to datasets or models — use env vars or config.\`,

  api: \`API design specialist. REST and GraphQL APIs.

## Standards
- OpenAPI/Swagger specs for all new endpoints. Schema-first design.
- REST: correct HTTP verbs (GET=read, POST=create, PUT=replace, PATCH=update, DELETE=remove).
- Status codes: 200 OK, 201 Created, 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, 422 Unprocessable, 429 Rate Limited, 500 Server Error.
- Consistent naming: plural nouns for resources (/users, /orders), kebab-case.
- Pagination: cursor-based for large datasets. Include total count and next/prev links.
- Versioning: URL prefix (/v1/) or Accept header.
- @@WEB_SEARCH site:swagger.io/docs [topic] for OpenAPI spec reference.
- @@WEB_FETCH https://developer.mozilla.org/en-US/docs/Web/HTTP/Status for status codes.

## Rules
- ALWAYS read existing routes and schemas before adding new ones. Match patterns.
- Output both the spec and a working implementation stub.\`,

  database: \`Database specialist. SQL, migrations, indexes, and query optimization.

## Standards
- Idempotent migrations (safe to re-run). Use IF NOT EXISTS / IF EXISTS guards.
- Indexes: all foreign keys, frequently queried columns, composite indexes for common WHERE+ORDER BY.
- Naming: snake_case tables, singular (user not users). FK: target_table_id. Index: idx_table_column.
- Always explain query plans for optimization changes.
- @@WEB_SEARCH site:use-the-index-luke.com [topic] for SQL indexing best practices.
- @@WEB_SEARCH [database engine] documentation [topic] for engine-specific syntax.

## Rules
- ALWAYS read existing schema before writing migrations.
- NEVER drop columns or tables without explicit instruction.
- Transactions for multi-table changes. Rollback strategy for every migration.\`,

  reactnative: \`React Native specialist. Cross-platform mobile with Expo or bare RN.

## Standards
- Functional components with hooks. StyleSheet.create for all styles.
- Navigation: React Navigation with typed routes. Deep linking support.
- State: Zustand or React Query for server state. Context sparingly.
- Platform differences: Platform.select, Platform.OS checks, platform-specific files (.ios.tsx/.android.tsx).
- @@WEB_SEARCH React Native docs and Expo SDK for current APIs.

## Rules
- ALWAYS read existing components and navigation before editing.
- Test mental model on both iOS and Android.
- Handle safe areas, keyboard avoidance, and different screen sizes.\`,

  web3: \`Web3 and blockchain specialist. Solidity smart contracts and dApp frontends.

## Standards
- Storage layout: NEVER change variable order in upgradeable contracts.
- NatSpec comments on all public and external functions.
- OpenZeppelin for standard patterns (ERC20, ERC721, AccessControl, Ownable).
- Gas optimization: pack storage vars, use calldata over memory for read-only, avoid loops over unbounded arrays.
- @@WEB_SEARCH site:docs.openzeppelin.com [pattern] for audited contract implementations.
- @@WEB_SEARCH EIP-[number] for Ethereum standard specifications.

## Rules
- ALWAYS read existing contracts before editing.
- Test all contracts with Hardhat or Foundry before reporting done.
- Check: reentrancy guards, integer overflow (Solidity 0.8+ safe), access control on state-changing functions.\`,

  automation: \`Automation and web scraping specialist. Playwright, Puppeteer, Python scrapers.

## Standards
- Playwright for JS-heavy sites, requests+BeautifulSoup for static HTML.
- Always check for APIs first (@@WEB_SEARCH) — scraping is the fallback, not the default.
- Handle: pagination, login flows, dynamic content, CAPTCHAs (flag, don't bypass).
- Retry logic with exponential backoff for flaky requests.
- @@WEB_FETCH to read a page before deciding the scraping approach.

## Rules
- Store raw data before transforming — never lose the source.
- Respect robots.txt and rate-limit requests (1-2 req/sec default).
- Output structured data (JSON/CSV) with clear field names.\`,

  docs: \`Technical documentation writer. API docs, READMEs, developer guides.

## Standards
- Write for the reader — assume minimal context, include working examples.
- Structure: Overview → Installation → Quick Start → Usage → API Reference → Examples → Troubleshooting.
- Code examples must be copy-pasteable and actually work.
- @@WEB_SEARCH for prior art, best practices, or similar docs for reference.
- @@WEB_FETCH specific doc pages before paraphrasing or referencing.

## Rules
- ALWAYS read the code you're documenting before writing.
- Keep docs in sync with implementation — flag discrepancies.
- Markdown output unless another format is requested.
- No fluff paragraphs. Scannable: headers, bullets, code blocks.\`,

  orchestrator: \`PM loop orchestrator. Roadmap reading, task expansion, specialist routing.

## Standards
- Break each roadmap item into a single, scoped, actionable task.
- Include exact file paths and acceptance criteria in every task.
- Route to the right specialist based on work type.
- @@WEB_SEARCH to research approaches for unfamiliar features.

## Rules
- NEVER implement tasks yourself — planning and delegation only.
- Keep task descriptions under 200 words.
- Mark items done only after confirmation from the executing agent.\`,

  lead: \`Team lead and coordinator. Delegation, progress tracking, blocker escalation.

## Rules
- Assign tasks to the right agent based on their specialty.
- Track what's in progress and what's blocked.
- Escalate failures to crew-fixer and report status.
- Do NOT implement tasks yourself — delegate everything.
- Communicate clearly: who is doing what, and what's blocked.\`,

  main: \`Main agent and general-purpose coordinator. Fallback for tasks that don't fit a specialist.

## Rules
- Triage requests — handle directly or delegate to the right specialist.
- @@WEB_SEARCH and @@WEB_FETCH for research tasks.
- Write and edit files directly for general tasks.
- Keep responses concise and action-oriented.
- You're the catch-all — if something falls through the cracks, you handle it.\`,
};

const PRESET_META = {
  frontend:    { id: 'crew-coder-front', name: 'Frontend Coder',    emoji: '🎨' },
  backend:     { id: 'crew-coder-back',  name: 'Backend Coder',     emoji: '⚙️' },
  fullstack:   { id: 'crew-coder',       name: 'Full-stack Coder',  emoji: '🧱' },
  ios:         { id: 'crew-coder-ios',   name: 'iOS Coder',         emoji: '📱' },
  android:     { id: 'crew-coder-android', name: 'Android Coder',   emoji: '🤖' },
  devops:      { id: 'crew-devops',      name: 'DevOps Engineer',   emoji: '🔧' },
  data:        { id: 'crew-data',        name: 'Data Engineer',     emoji: '📊' },
  security:    { id: 'crew-security',    name: 'Security Auditor',  emoji: '🛡️' },
  qa:          { id: 'crew-qa',          name: 'QA Tester',         emoji: '🧪' },
  github:      { id: 'crew-github',      name: 'Git Ops',           emoji: '🐙' },
  writer:      { id: 'crew-copywriter',  name: 'Copywriter',        emoji: '✍️' },
  design:      { id: 'crew-design',      name: 'UI/UX Designer',    emoji: '🖌️' },
  pm:          { id: 'crew-pm-agent',    name: 'Product Manager',   emoji: '📋' },
  aiml:        { id: 'crew-aiml',        name: 'AI/ML Engineer',    emoji: '🤖' },
  api:         { id: 'crew-api',         name: 'API Designer',      emoji: '🔌' },
  database:    { id: 'crew-database',    name: 'Database Specialist', emoji: '🗄️' },
  reactnative: { id: 'crew-rn',          name: 'React Native Dev',  emoji: '📱' },
  web3:        { id: 'crew-web3',        name: 'Web3 Engineer',     emoji: '🌐' },
  automation:  { id: 'crew-automation',  name: 'Automation Bot',    emoji: '🕷️' },
  docs:        { id: 'crew-docs',        name: 'Docs Writer',       emoji: '📖' },
  orchestrator: { id: 'orchestrator',   name: 'Orchestrator',      emoji: '🧠' },
  lead:        { id: 'crew-lead',       name: 'Crew Lead',         emoji: '🦊' },
  main:        { id: 'crew-main',       name: 'Main Agent',        emoji: '⚡' },
};

window.applyPromptPreset = function() {
  const val = document.getElementById('naPromptPreset').value;
  if (!val || !PROMPT_PRESETS[val]) return;
  document.getElementById('naPrompt').value = PROMPT_PRESETS[val];
  const meta = PRESET_META[val];
  if (meta) {
    const idEl    = document.getElementById('naId');
    const nameEl  = document.getElementById('naName');
    const emojiEl = document.getElementById('naEmoji');
    if (idEl    && !idEl.value)    idEl.value    = meta.id;
    if (nameEl  && !nameEl.value)  nameEl.value  = meta.name;
    if (emojiEl && !emojiEl.value) emojiEl.value = meta.emoji;
  }
  // Auto-fill role/theme from the preset's display label (strip leading emoji)
  const themeEl = document.getElementById('naTheme');
  if (themeEl) {
    const opt = PRESET_OPTIONS.find(p => p.value === val);
    if (opt) themeEl.value = opt.label.replace(/^[\u{1F000}-\u{1FFFF}\u2600-\u27BF\uFE0F\u20D0-\u20FF\s]+/u, '').trim();
  }
};

// Models confirmed broken via API testing — return empty strings
const BROKEN_MODELS = new Set([
  'groq/openai/gpt-oss-120b',
  'groq/openai/gpt-oss-20b',
]);

// Role classification for badge display
const MODEL_ROLE = {
  'crew-pm': 'THINKER', 'crew-architect': 'THINKER', 'crew-ml': 'THINKER',
  'crew-coder': 'EXECUTOR', 'crew-coder-back': 'EXECUTOR', 'crew-coder-front': 'EXECUTOR',
  'crew-frontend': 'EXECUTOR', 'crew-fixer': 'EXECUTOR',
  'crew-lead': 'COORDINATOR', 'crew-main': 'COORDINATOR', 'orchestrator': 'COORDINATOR',
  'crew-qa': 'ANALYST', 'crew-security': 'ANALYST', 'crew-mega': 'ANALYST',
  'crew-researcher': 'RESEARCHER',
};
const ROLE_STYLE = {
  THINKER:    'background:rgba(139,92,246,0.12);border:1px solid rgba(139,92,246,0.35);color:#a78bfa;',
  EXECUTOR:   'background:rgba(34,197,94,0.10);border:1px solid rgba(34,197,94,0.30);color:#4ade80;',
  COORDINATOR:'background:rgba(56,189,248,0.10);border:1px solid rgba(56,189,248,0.30);color:#38bdf8;',
  ANALYST:    'background:rgba(251,191,36,0.10);border:1px solid rgba(251,191,36,0.30);color:#fbbf24;',
  RESEARCHER: 'background:rgba(249,115,22,0.10);border:1px solid rgba(249,115,22,0.30);color:#fb923c;',
};

function populateModelDropdown(selectId, currentVal) {
  const sel = document.getElementById(selectId);
  sel.innerHTML = '<option value="">— select a model —</option>';
  if (Object.keys(_modelsByProvider).length) {
    // Grouped by provider
    for (const [provider, models] of Object.entries(_modelsByProvider)) {
      const grp = document.createElement('optgroup');
      grp.label = provider.toUpperCase();
      models.forEach(({ id, name }) => {
        const full = provider + '/' + id;
        const broken = BROKEN_MODELS.has(full);
        const opt = document.createElement('option');
        opt.value = full;
        opt.textContent = (broken ? '⚠ BROKEN — ' : '') + (name ? (name + '  (' + id + ')') : full);
        if (broken) opt.style.color = '#ef4444';
        if (full === currentVal) opt.selected = true;
        grp.appendChild(opt);
      });
      sel.appendChild(grp);
    }
  } else {
    _allModels.forEach(m => {
      const broken = BROKEN_MODELS.has(m);
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = (broken ? '⚠ BROKEN — ' : '') + m;
      if (broken) opt.style.color = '#ef4444';
      if (m === currentVal) opt.selected = true;
      sel.appendChild(opt);
    });
  }
  // If current value not in list, add it as custom
  if (currentVal && !_allModels.includes(currentVal)) {
    const opt = document.createElement('option');
    opt.value = currentVal; opt.textContent = currentVal + ' (custom)';
    opt.selected = true;
    sel.prepend(opt);
  }
}

document.getElementById('newAgentBtn').onclick = () => {
  document.getElementById('newAgentForm').style.display = 'block';
  populateModelDropdown('naModel', '');
  // Populate preset dropdown dynamically (can't be server-rendered since PRESET_OPTIONS is client-side)
  const sel = document.getElementById('naPromptPreset');
  if (sel && sel.options.length <= 1) {
    PRESET_OPTIONS.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.value; opt.textContent = p.label;
      sel.appendChild(opt);
    });
  }
};
document.getElementById('naCancelBtn').onclick = () => {
  document.getElementById('newAgentForm').style.display = 'none';
};
document.getElementById('naCreateBtn').onclick = async () => {
  const id          = document.getElementById('naId').value.trim();
  const model       = document.getElementById('naModel').value.trim();
  const name        = document.getElementById('naName').value.trim();
  const emoji       = document.getElementById('naEmoji').value.trim();
  const theme       = document.getElementById('naTheme').value.trim();
  const systemPrompt = document.getElementById('naPrompt').value.trim();
  const naTools = [...document.querySelectorAll('.naToolCheck:checked')].map(cb => cb.dataset.tool);
  const alsoAllow = naTools.length ? naTools : getToolDefaults(id);
  if (!id || !model){ showNotification('Agent ID and model are required', true); return; }
  try {
    await postJSON('/api/agents-config/create', { id, model, name, emoji, theme, systemPrompt, alsoAllow });
    showNotification(\`Agent "\${id}" created — restart gateway-bridge to activate it on the RT bus.\`);
    document.getElementById('newAgentForm').style.display = 'none';
    ['naId','naName','naTheme','naPrompt'].forEach(x => { document.getElementById(x).value = ''; });
    document.getElementById('naEmoji').value = '🔥';
    document.getElementById('naEmoji-btn').textContent = '🔥';
    document.getElementById('naModel').innerHTML = '<option value="">— select a model —</option>';
    document.getElementById('naPromptPreset').value = '';
    loadAgents_cfg();
  } catch(e){ showNotification('Failed: ' + e.message, true); }
};
document.getElementById('refreshAgentsBtn').onclick = loadAgents_cfg;
// ── End agents UI ──────────────────────────────────────────────────────────
const PROVIDER_ICONS = { opencode:'🚀', groq:'⚡', nvidia:'🎮', ollama:'🏠', 'openai-local':'🟢', xai:'𝕏', google:'🔵', deepseek:'🌊', openai:'🟢', perplexity:'🔍', cerebras:'🧠', mistral:'🌀', together:'🤝', cohere:'🔶', anthropic:'🟣' };
async function loadProviders(){
  const list = document.getElementById('providersList');
  list.innerHTML = '<div class="meta" style="padding:20px;">Loading providers...</div>';
  try {
    const data = await getJSON('/api/providers');
    const providers = data.providers || [];
    if (!providers.length){ list.innerHTML = '<div class="meta" style="padding:20px;">No providers found. Check ~/.crewswarm/crewswarm.json</div>'; return; }
    list.innerHTML = '';
    providers.forEach(p => {
      const icon = PROVIDER_ICONS[p.id] || '🔌';
      const hasKey = p.hasKey;
      const badgeColor = hasKey ? '#10b981' : '#ef4444';
      const badgeText = hasKey ? '✓ key set' : '✗ no key';
      const card = document.createElement('div');
      card.className = 'provider-card';
      card.innerHTML = \`
        <div class="provider-header" onclick="this.nextElementSibling.classList.toggle('open')">
          <span style="font-size:20px;">\${icon}</span>
          <div style="flex:1;">
            <strong style="font-size:15px;">\${p.id}</strong>
            <span class="meta" style="margin-left:10px;">\${p.baseUrl}</span>
          </div>
          <span class="provider-badge" style="background:\${badgeColor}20; color:\${badgeColor}; border:1px solid \${badgeColor}40;">\${badgeText}</span>
          <span class="meta" style="margin-left:12px;">\${p.models.length} model\${p.models.length !== 1 ? 's' : ''}</span>
          <span style="color:#64748b; margin-left:8px;">▼</span>
        </div>
        <div class="provider-body">
          <div class="key-row">
            <input class="key-input" type="password" autocomplete="new-password" id="key_\${p.id}" value="\${p.maskedKey || ''}" placeholder="Paste API key…" />
            <button onclick="toggleKeyVis('key_\${p.id}', this)" style="background:#334155; padding:6px 10px; font-size:12px;">👁</button>
            <button onclick="saveKey('\${p.id}')" style="background:#6366f1; padding:6px 14px; font-size:12px;">Save</button>
            <button onclick="testKey('\${p.id}')" style="background:#334155; padding:6px 10px; font-size:12px;">Test</button>
            <button onclick="fetchModels('\${p.id}', this)" style="background:#0f766e; padding:6px 10px; font-size:12px;">↻ Fetch models</button>
            <span id="test_\${p.id}"></span>
          </div>
          <div style="margin-bottom:8px;"><span class="meta">Base URL: </span><code style="font-size:11px; color:#94a3b8;">\${p.baseUrl}</code></div>
          <div><span class="meta" style="display:block; margin-bottom:6px;">Models (<span id="mcount_\${p.id}">\${p.models.length}</span>):</span><span id="mtags_\${p.id}">\${p.models.map(m => '<span class="model-tag">' + m.id + '</span>').join('')}</span></div>
          \${p.models.length === 0 ? '<div class="meta" style="margin-top:8px; color:#f59e0b;" id="mnone_\${p.id}">No models yet — click ↻ Fetch models</div>' : ''}
        </div>
      \`;
      list.appendChild(card);
    });
  } catch(e){ list.innerHTML = '<div class="meta" style="padding:20px; color:#ef4444;">Error: ' + e.message + '</div>'; }
}
function toggleKeyVis(inputId, btn){
  const inp = document.getElementById(inputId);
  inp.type = inp.type === 'password' ? 'text' : 'password';
  btn.textContent = inp.type === 'password' ? '👁' : '🙈';
}
async function saveKey(providerId){
  const inp = document.getElementById('key_' + providerId);
  const key = inp.value.trim();
  if (!key){ showNotification('Key is empty', true); return; }
  try {
    await postJSON('/api/providers/save', { providerId, apiKey: key });
    showNotification('Saved key for ' + providerId);
    loadProviders();
  } catch(e){ showNotification('Failed: ' + e.message, true); }
}
async function testKey(providerId){
  const statusEl = document.getElementById('test_' + providerId);
  statusEl.textContent = 'testing…';
  statusEl.className = 'meta';
  try {
    const r = await postJSON('/api/providers/test', { providerId });
    statusEl.textContent = r.ok ? '✓ ' + (r.model || 'ok') : '✗ ' + r.error;
    statusEl.className = r.ok ? 'test-ok' : 'test-err';
  } catch(e){ statusEl.textContent = '✗ ' + e.message; statusEl.className = 'test-err'; }
}
async function fetchModels(providerId, btn){
  const statusEl = document.getElementById('test_' + providerId);
  const origText = btn.textContent;
  btn.textContent = 'Fetching…';
  btn.disabled = true;
  if (statusEl) statusEl.textContent = '';
  try {
    const r = await postJSON('/api/providers/fetch-models', { providerId });
    if (r.ok) {
      const tags = document.getElementById('mtags_' + providerId);
      const count = document.getElementById('mcount_' + providerId);
      const none = document.getElementById('mnone_' + providerId);   // old provider-card style
      const wrap = document.getElementById('mwrap_' + providerId);   // new unified-list style
      if (tags)  tags.innerHTML = r.models.map(m => '<span class="model-tag">' + m + '</span>').join('');
      if (count) count.textContent = r.models.length;
      if (none)  none.style.display = 'none';
      if (wrap)  wrap.style.display = 'block';
      if (statusEl) { statusEl.textContent = '✓ ' + r.models.length + ' models'; statusEl.className = 'test-ok'; }
      loadAgents(); // refresh agent model dropdowns
    } else {
      if (statusEl) { statusEl.textContent = '✗ ' + r.error; statusEl.className = 'test-err'; }
    }
  } catch(e){
    if (statusEl) { statusEl.textContent = '✗ ' + e.message; statusEl.className = 'test-err'; }
  }
  finally { btn.textContent = origText; btn.disabled = false; }
}
document.getElementById('addProviderBtn').onclick = () => {
  const form = document.getElementById('addProviderForm');
  form.style.display = 'block';
  setTimeout(() => form.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  const firstInput = form.querySelector('input');
  if (firstInput) setTimeout(() => firstInput.focus(), 150);
};
document.getElementById('apCancelBtn').onclick = () => {
  document.getElementById('addProviderForm').style.display = 'none';
};
document.getElementById('apSaveBtn').onclick = async () => {
  const id = document.getElementById('apId').value.trim();
  const baseUrl = document.getElementById('apBaseUrl').value.trim();
  const apiKey = document.getElementById('apKey').value.trim();
  const api = document.getElementById('apApi').value;
  if (!id || !baseUrl){ showNotification('ID and Base URL are required', true); return; }
  try {
    await postJSON('/api/providers/add', { id, baseUrl, apiKey, api });
    showNotification('Provider added: ' + id);
    document.getElementById('addProviderForm').style.display = 'none';
    loadBuiltinProviders(); // unified list re-renders with new custom provider appended
  } catch(e){ showNotification('Failed: ' + e.message, true); }
};
document.getElementById('refreshProvidersBtn').onclick = loadBuiltinProviders;
function showBuild(){
  hideAllViews();
  document.getElementById('buildView').classList.add('active');
  setNavActive('navBuild');
  loadPhasedProgress();
}
function showProjects(){
  hideAllViews();
  document.getElementById('projectsView').classList.add('active');
  setNavActive('navProjects');
  loadProjects();
}
// Safe HTML escaper — never put raw user data into innerHTML without this
function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Project registry cache — populated by loadProjects, used by delegated handler
let _projectsData = {};

async function loadProjects(){
  const list = document.getElementById('projectsList');
  list.innerHTML = '<div class="meta" style="padding:20px;">Loading projects...</div>';
  try {
    const data = await getJSON('/api/projects');
    const projects = data.projects || [];
    _projectsData = {};
    projects.forEach(p => { _projectsData[p.id] = p; });
    populateChatProjectDropdown(projects);
    if (!projects.length) {
      list.innerHTML = '<div class="meta" style="padding:20px;">No projects yet. Click &quot;+ New Project&quot; to create one.</div>';
      return;
    }
    // Build HTML using ONLY data-action + data-id on buttons — zero dynamic data in onclick strings
    list.innerHTML = projects.map(p => {
      const id  = escHtml(p.id);
      const pct = p.roadmap.total ? Math.round((p.roadmap.done / p.roadmap.total) * 100) : 0;
      const barColor   = pct === 100 ? 'var(--green)' : pct > 50 ? 'var(--accent)' : 'var(--yellow)';
      const statusBg   = p.status === 'active' ? 'rgba(52,211,153,0.1)' : 'var(--bg-card2)';
      const statusColor= p.status === 'active' ? 'var(--green)' : 'var(--text-3)';
      const retryBtn   = p.roadmap.failed
        ? '<button data-action="retry-failed" data-id="' + id + '" style="background:rgba(248,113,113,0.15);color:var(--red);border:1px solid rgba(248,113,113,0.3);border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px;font-weight:600;">↩ Retry ' + p.roadmap.failed + ' failed</button>'
        : '';
      return '<div class="card" id="proj-card-' + id + '" data-proj-id="' + id + '">'
        + '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;">'
        +   '<div>'
        +     '<strong style="font-size:15px;">' + escHtml(p.name) + '</strong>'
        +     '<span style="margin-left:10px;font-size:11px;padding:2px 8px;border-radius:999px;background:' + statusBg + ';color:' + statusColor + ';border:1px solid ' + statusColor + '40;">' + escHtml(p.status) + '</span>'
        +     (p.running ? '<span style="margin-left:8px;font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(99,102,241,0.15);color:#818cf8;border:1px solid rgba(99,102,241,0.3);">▶ running</span>' : '')
        +     (p.description ? '<div class="meta" style="margin-top:4px;">' + escHtml(p.description) + '</div>' : '')
        +   '</div>'
        +   '<div class="meta">' + new Date(p.created).toLocaleDateString() + '</div>'
        + '</div>'
        + '<div style="margin-bottom:12px;">'
        +   '<div style="display:flex;justify-content:space-between;margin-bottom:6px;">'
        +     '<span class="meta">Roadmap</span>'
        +     '<span class="meta">' + p.roadmap.done + '/' + p.roadmap.total + ' done' + (p.roadmap.failed ? ' · ' + p.roadmap.failed + ' failed' : '') + ' · ' + p.roadmap.pending + ' pending</span>'
        +   '</div>'
        +   '<div class="prog-bar"><div class="prog-fill" style="width:' + pct + '%;background:' + barColor + ';"></div></div>'
        + '</div>'
        + '<div style="font-size:11px;color:var(--text-3);margin-bottom:12px;font-family:monospace;">' + escHtml(p.outputDir) + '</div>'
        + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">'
        +   '<button data-action="pm-toggle" data-id="' + id + '" class="' + (p.running ? 'btn-red' : 'btn-green') + '" style="font-size:13px;">' + (p.running ? '⏹ Stop PM Loop' : '▶ Start PM Loop') + '</button>'
        +   '<button data-action="open-build" data-id="' + id + '" class="btn-ghost" style="font-size:13px;">🔧 Build tab</button>'
        +   '<button data-action="edit-roadmap" data-id="' + id + '" class="btn-ghost" style="font-size:13px;" id="roadmap-btn-' + id + '">📋 Roadmap</button>'
        +   '<button data-action="chat-project" data-id="' + id + '" data-name="' + escHtml(p.name) + '" class="btn-ghost" style="font-size:13px;">🧠 Chat</button>'
        +   retryBtn
        +   '<label style="margin-left:auto;display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:var(--text-3);user-select:none;" title="When enabled, crew-lead automatically starts the next ROADMAP phase when the current pipeline completes">'
        +     '<input type="checkbox" data-action="toggle-auto-advance" data-id="' + id + '" ' + (p.autoAdvance ? 'checked' : '') + ' style="accent-color:var(--green);width:14px;height:14px;cursor:pointer;">'
        +     '⚡ Auto-advance'
        +   '</label>'
        +   '<button data-action="delete" data-id="' + id + '" style="background:transparent;color:var(--text-3);border:1px solid var(--border);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;" title="Remove from dashboard (files stay on disk)">🗑 Delete</button>'
        + '</div>'
        + '<div id="proj-pm-status-' + id + '" style="display:none;margin-top:10px;font-size:12px;padding:8px 12px;background:rgba(99,102,241,0.08);border-radius:6px;border:1px solid rgba(99,102,241,0.2);color:#a5b4fc;"></div>'
        + '<div id="rm-editor-' + id + '" style="display:none;margin-top:14px;">'
        +   '<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">'
        +     '<span class="field-label" style="margin:0;">ROADMAP</span>'
        +     '<span class="meta" style="font-family:monospace;">' + escHtml(p.roadmapFile) + '</span>'
        +     '<div style="margin-left:auto;display:flex;gap:6px;">'
        +       '<button data-action="add-item" data-id="' + id + '" style="font-size:11px;padding:3px 10px;background:var(--green);color:#000;">+ Add item</button>'
        +       '<button data-action="skip-next" data-id="' + id + '" style="font-size:11px;padding:3px 10px;background:var(--yellow);color:#000;">⏭ Skip next</button>'
        +       '<button data-action="reset-failed" data-id="' + id + '" style="font-size:11px;padding:3px 10px;" class="btn-ghost">↩ Reset failed</button>'
        +       '<button data-action="save-roadmap" data-id="' + id + '" style="font-size:11px;padding:3px 10px;background:var(--accent);color:#000;">💾 Save</button>'
        +       '<button data-action="close-editor" data-id="' + id + '" style="font-size:11px;padding:3px 10px;" class="btn-ghost">✕</button>'
        +     '</div>'
        +   '</div>'
        +   '<div style="display:flex;gap:8px;margin-bottom:8px;">'
        +     '<input id="rm-add-' + id + '" type="text" placeholder="New item text… (Enter to add)" style="flex:1;font-size:13px;" data-rm-add-id="' + id + '" />'
        +   '</div>'
        +   '<textarea id="rm-ta-' + id + '" rows="16" class="rm-textarea" spellcheck="false"></textarea>'
        +   '<div id="rm-status-' + id + '" class="meta" style="margin-top:6px;min-height:16px;"></div>'
        + '</div>'
        + '</div>';
    }).join('');

    // Wire Enter key on quick-add inputs
    list.querySelectorAll('[data-rm-add-id]').forEach(inp => {
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') addRoadmapItem(inp.dataset.rmAddId); });
    });

  } catch(e) { list.innerHTML = '<div class="meta" style="padding:20px;color:#ef4444;">Failed to load projects: ' + escHtml(e.message) + '</div>'; }
}

// Single delegated click handler — replaces ALL onclick strings in project cards
document.getElementById('projectsList').addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id   = btn.dataset.id;
  const proj = _projectsData[id];
  switch (btn.dataset.action) {
    case 'pm-toggle':    proj && proj.running ? stopProjectPMLoop(id) : startProjectPMLoop(id); break;
    case 'open-build':   openProjectInBuild(id); break;
    case 'edit-roadmap': proj && openRoadmapEditor(id, proj.roadmapFile); break;
    case 'retry-failed': proj && retryFailed(proj.roadmapFile); break;
    case 'delete':       deleteProject(id); break;
    case 'chat-project': {
      const name = btn.dataset.name || id;
      showChat();
      // Auto-select this project in the chat dropdown
      autoSelectChatProject(id);
      const inp = document.getElementById('chatInput');
      inp?.focus();
      break;
    }
    case 'toggle-auto-advance': {
      const checked = btn.checked;
      postJSON('/api/projects/update', { projectId: id, autoAdvance: checked })
        .then(() => {
          if (_projectsData[id]) _projectsData[id].autoAdvance = checked;
          showNotification('Auto-advance ' + (checked ? 'enabled' : 'disabled') + ' for ' + (proj?.name || id));
        })
        .catch(e => { showNotification('Failed: ' + e.message, true); btn.checked = !checked; });
      return; // don't prevent default on checkbox
    }
    case 'add-item':     addRoadmapItem(id); break;
    case 'skip-next':    skipNextItem(id); break;
    case 'reset-failed': resetAllFailed(id); break;
    case 'save-roadmap': saveRoadmap(id); break;
    case 'close-editor': closeRoadmapEditor(id); break;
  }
});

// ── Chat project dropdown (next to input; persisted so it survives tab switch and reload) ───

const CHAT_ACTIVE_PROJECT_KEY = 'crewswarm_chat_active_project_id';
let _chatActiveProjectId = '';

function getStoredChatProjectId() {
  try { return localStorage.getItem(CHAT_ACTIVE_PROJECT_KEY) || ''; } catch { return ''; }
}
function setStoredChatProjectId(id) {
  try { if (id) localStorage.setItem(CHAT_ACTIVE_PROJECT_KEY, id); else localStorage.removeItem(CHAT_ACTIVE_PROJECT_KEY); } catch {}
}

function populateChatProjectDropdown(projects) {
  const sel = document.getElementById('chatProjectSelect');
  if (!sel) return;
  const prev = getStoredChatProjectId() || sel.value || _chatActiveProjectId;
  sel.innerHTML = '<option value="">— none —</option>';
  (projects || []).forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name + (p.outputDir ? ' (' + p.outputDir.split('/').pop() + ')' : '');
    sel.appendChild(opt);
  });
  if (prev && sel.querySelector('option[value="' + prev + '"]')) {
    sel.value = prev;
    _chatActiveProjectId = prev;
    setStoredChatProjectId(prev);
    // Sync config.json so gateway-bridge gets the right --dir even after a restart
    const restoredProj = _projectsData[prev];
    if (restoredProj && restoredProj.outputDir) {
      postJSON('/api/settings/opencode-project', { dir: restoredProj.outputDir }).catch(() => {});
    }
  } else {
    _chatActiveProjectId = '';
    setStoredChatProjectId('');
  }
  updateChatProjectHint();
}

function onChatProjectChange() {
  const sel = document.getElementById('chatProjectSelect');
  _chatActiveProjectId = sel ? sel.value : '';
  setStoredChatProjectId(_chatActiveProjectId);
  updateChatProjectHint();
  const proj = _projectsData[_chatActiveProjectId];
  if (proj && proj.outputDir) {
    postJSON('/api/settings/opencode-project', { dir: proj.outputDir }).catch(() => {});
  }
}

function updateChatProjectHint() {
  const hint = document.getElementById('chatProjectHint');
  if (!hint) return;
  if (_chatActiveProjectId && _projectsData[_chatActiveProjectId]) {
    const p = _projectsData[_chatActiveProjectId];
    hint.textContent = p.outputDir || '';
    hint.style.display = p.outputDir ? 'block' : 'none';
  } else {
    hint.style.display = 'none';
  }
}

function autoSelectChatProject(projectId) {
  _chatActiveProjectId = projectId;
  setStoredChatProjectId(projectId);
  const sel = document.getElementById('chatProjectSelect');
  if (sel && sel.querySelector('option[value="' + projectId + '"]')) {
    sel.value = projectId;
    updateChatProjectHint();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function resumeProject(projectId) {
  try {
    const resp = await fetch('/api/pm-loop/start', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ projectId }) });
    const r = await resp.json();
    if (r.alreadyRunning) { showNotification('PM Loop already running (pid ' + r.pid + ')', true); return; }
    showNotification('PM Loop started for project ' + projectId + ' (pid ' + r.pid + ')');
    setTimeout(loadProjects, 3000);
  } catch(e) { showNotification('Failed: ' + e.message, true); }
}
async function stopProjectPMLoop(projectId) {
  try {
    await postJSON('/api/pm-loop/stop', { projectId });
    showNotification('Stop signal sent — PM will finish current task then halt.');
    const statusEl = document.getElementById('proj-pm-status-' + projectId);
    if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = '⛔ Stopping after current task…'; }
    setTimeout(loadProjects, 3000);
  } catch(e) { showNotification('Stop failed: ' + e.message, true); }
}
async function startProjectPMLoop(projectId) {
  const statusEl = document.getElementById('proj-pm-status-' + projectId);
  try {
    if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = '⚙ Starting PM Loop…'; }
    const r = await postJSON('/api/pm-loop/start', { projectId });
    if (r.alreadyRunning) {
      showNotification('PM Loop already running (pid ' + r.pid + ')', true);
      if (statusEl) statusEl.textContent = '▶ Already running (pid ' + r.pid + ')';
      return;
    }
    showNotification('PM Loop started (pid ' + r.pid + ')');
    if (statusEl) statusEl.textContent = '▶ Running (pid ' + r.pid + ') — check Build tab for live log';
    setTimeout(loadProjects, 3000);
  } catch(e) {
    showNotification('Start failed: ' + e.message, true);
    if (statusEl) { statusEl.style.display = 'none'; }
  }
}
async function deleteProject(projectId) {
  const proj = _projectsData[projectId];
  const name = proj ? proj.name : projectId;
  if (!confirm('Remove "' + name + '" from the dashboard registry?\\n\\nFiles on disk are NOT deleted.')) return;
  try {
    await postJSON('/api/projects/delete', { projectId });
    showNotification('Project "' + name + '" removed from dashboard.');
    loadProjects();
  } catch(e) { showNotification('Delete failed: ' + e.message, true); }
}
// Open a project in the Build tab with it pre-selected
function openProjectInBuild(projectId) {
  showBuild();
  loadBuildProjectPicker().then(() => {
    const sel = document.getElementById('buildProjectPicker');
    if (sel) { sel.value = projectId; onBuildProjectChange(); }
  });
}

// ── Build tab project picker ──────────────────────────────────────────────
let _buildProjects = {};
async function loadBuildProjectPicker() {
  try {
    const data = await getJSON('/api/projects');
    _buildProjects = {};
    const sel = document.getElementById('buildProjectPicker');
    const cur = sel ? sel.value : '';
    if (!sel) return;
    sel.innerHTML = '<option value="">— No project (use defaults) —</option>';
    (data.projects || []).forEach(p => {
      _buildProjects[p.id] = p;
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name + (p.running ? ' ▶' : '') + ' (' + p.roadmap.pending + ' pending)';
      if (p.id === cur) opt.selected = true;
      sel.appendChild(opt);
    });
    onBuildProjectChange();
  } catch(e) { /* ignore */ }
}
function onBuildProjectChange() {
  const sel = document.getElementById('buildProjectPicker');
  const info = document.getElementById('buildProjectInfo');
  const label = document.getElementById('pmLoopProjectLabel');
  const proj = _buildProjects[sel ? sel.value : ''];
  if (proj) {
    info.style.display = 'block';
    info.innerHTML =
      '<b>' + proj.name + '</b><br>' +
      'Output: ' + proj.outputDir + '<br>' +
      'Roadmap: ' + proj.roadmapFile + '<br>' +
      'Tasks: ' + proj.roadmap.done + ' done · ' + proj.roadmap.pending + ' pending · ' + proj.roadmap.failed + ' failed' +
      (proj.running ? '<br><span style="color:#818cf8;">▶ PM Loop is running</span>' : '');
    if (label) label.innerHTML =
      '<b style="color:var(--accent);">▶ ' + proj.name + '</b>' +
      ' &nbsp;·&nbsp; ' + proj.roadmap.done + ' done · ' + proj.roadmap.pending + ' pending' +
      (proj.running ? ' &nbsp;<span style="color:#4ade80; font-weight:600;">● running</span>' : '');
  } else {
    info.style.display = 'none';
    if (label) label.innerHTML = '← Select a project above';
  }
  // Reload dispatch log filtered to the newly selected project
  loadPhasedProgress();
}

// ── Stop build/continuous-build ───────────────────────────────────────────
async function stopBuild() {
  try {
    await postJSON('/api/build/stop', {});
    showNotification('Build stop signal sent');
    document.getElementById('stopBuildBtn').style.display = 'none';
    document.getElementById('runBuildBtn').style.display = '';
    document.getElementById('buildStatus').textContent = '';
  } catch(e) { showNotification('Stop failed: ' + e.message, true); }
}
async function stopContinuousBuild() {
  try {
    await postJSON('/api/continuous-build/stop', {});
    showNotification('Continuous build stop signal sent');
    document.getElementById('stopContinuousBtn').style.display = 'none';
    document.getElementById('continuousBuildBtn').style.display = '';
  } catch(e) { showNotification('Stop failed: ' + e.message, true); }
}
async function retryFailed(roadmapFile) {
  if (!confirm('Reset all [!] failed items back to [ ] pending so the PM Loop retries them?')) return;
  try {
    const r = await postJSON('/api/roadmap/retry-failed', { roadmapFile });
    if (r.count === 0) { showNotification('No failed items found in roadmap', true); return; }
    showNotification('↩ ' + r.count + ' failed item' + (r.count !== 1 ? 's' : '') + ' reset — click Resume to retry');
    await loadProjects();
  } catch(e) { showNotification('Retry failed: ' + e.message, true); }
}
// ── Roadmap editor ──────────────────────────────────────────────────────────
const _roadmapFiles = {};   // projectId → roadmapFile path

async function openRoadmapEditor(projectId, roadmapFile) {
  _roadmapFiles[projectId] = roadmapFile;
  const panel = document.getElementById('rm-editor-' + projectId);
  const ta    = document.getElementById('rm-ta-' + projectId);
  const btn   = document.getElementById('roadmap-btn-' + projectId);
  if (!panel || !ta) return;
  if (panel.style.display !== 'none') { closeRoadmapEditor(projectId); return; }
  panel.style.display = 'block';
  if (btn) btn.textContent = '📋 Editing…';
  ta.value = 'Loading…';
  try {
    const r = await postJSON('/api/roadmap/read', { roadmapFile });
    ta.value = r.content || '';
    setRmStatus(projectId, 'Loaded · ' + (r.content || '').split('\\n').length + ' lines');
  } catch(e) { ta.value = ''; setRmStatus(projectId, 'Error: ' + e.message, true); }
}

function closeRoadmapEditor(projectId) {
  const panel = document.getElementById('rm-editor-' + projectId);
  const btn   = document.getElementById('roadmap-btn-' + projectId);
  if (panel) panel.style.display = 'none';
  if (btn) btn.textContent = '📋 Edit Roadmap';
}

function setRmStatus(projectId, msg, isErr) {
  const el = document.getElementById('rm-status-' + projectId);
  if (!el) return;
  el.textContent = msg;
  el.style.color = isErr ? 'var(--red)' : 'var(--text-2)';
}

async function saveRoadmap(projectId) {
  const ta = document.getElementById('rm-ta-' + projectId);
  const roadmapFile = _roadmapFiles[projectId];
  if (!ta || !roadmapFile) return;
  try {
    await postJSON('/api/roadmap/write', { roadmapFile, content: ta.value });
    setRmStatus(projectId, '✓ Saved — ' + new Date().toLocaleTimeString());
    showNotification('Roadmap saved');
    setTimeout(loadProjects, 800);
  } catch(e) { setRmStatus(projectId, 'Save failed: ' + e.message, true); }
}

function addRoadmapItem(projectId) {
  const ta    = document.getElementById('rm-ta-' + projectId);
  const input = document.getElementById('rm-add-' + projectId);
  if (!ta) return;
  const text = (input ? input.value.trim() : '') || 'New task';
  if (!text) return;
  const line = '- [ ] ' + text;
  ta.value = ta.value.trimEnd() + '\\n' + line + '\\n';
  ta.scrollTop = ta.scrollHeight;
  if (input) input.value = '';
  setRmStatus(projectId, 'Item added — click 💾 Save to persist');
}

function skipNextItem(projectId) {
  const ta = document.getElementById('rm-ta-' + projectId);
  if (!ta) return;
  const lines = ta.value.split('\\n');
  let skipped = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^- \[ \]/.test(lines[i])) {
      lines[i] = lines[i].replace('- [ ]', '- [x]') + '  ✓ skipped';
      skipped = true;
      break;
    }
  }
  if (skipped) {
    ta.value = lines.join('\\n');
    setRmStatus(projectId, 'Next pending item skipped — click 💾 Save to persist');
  } else {
    setRmStatus(projectId, 'No pending items to skip');
  }
}

async function resetAllFailed(projectId) {
  const ta = document.getElementById('rm-ta-' + projectId);
  if (!ta) return;
  const before = (ta.value.match(/\[!\]/g) || []).length;
  if (!before) { setRmStatus(projectId, 'No failed items to reset'); return; }
  ta.value = ta.value
    .split('\\n')
    .map(l => l.replace(/\[!\]/, '[ ]').replace(/\s+✗\s+\d+:\d+:\d+/g, ''))
    .join('\\n');
  setRmStatus(projectId, before + ' failed item(s) reset — click 💾 Save to persist');
}
async function loadPhasedProgress(){
  const box = document.getElementById('phasedProgress');
  if (!box) return;
  const projectId = document.getElementById('buildProjectPicker')?.value || '';
  const label = document.getElementById('phasedProgressLabel');
  try {
    const url = '/api/phased-progress' + (projectId ? '?projectId=' + encodeURIComponent(projectId) : '');
    const data = await getJSON(url);
    const scopeText = projectId ? 'This project' : 'All projects (no project selected)';
    if (label) label.textContent = scopeText;
    if (!data.length) {
      box.textContent = projectId ? 'No runs yet for this project.' : 'No phased runs yet.';
      return;
    }
    box.innerHTML = data.map(e => {
      const phase = e.phase || '?';
      const agent = e.agent || '?';
      const task = (e.task || '').slice(0, 50) + ((e.task || '').length > 50 ? '...' : '');
      const status = e.status === 'completed' ? '✅' : '❌';
      const dur = e.duration_s != null ? e.duration_s + 's' : '';
      return \`<div style="margin-bottom:4px;">\${status} [\${phase}] \${agent}: \${task} \${dur}</div>\`;
    }).join('');
    box.scrollTop = box.scrollHeight;
  } catch (e) { box.textContent = 'Could not load progress.'; }
}
async function runBuild(){
  const req = document.getElementById('buildRequirement').value.trim();
  if (!req) { showNotification('Enter a requirement', true); return; }
  const status = document.getElementById('buildStatus');
  const btn = document.getElementById('runBuildBtn');
  const stopBtn = document.getElementById('stopBuildBtn');
  const projectId = document.getElementById('buildProjectPicker')?.value || '';
  try {
    status.textContent = 'Starting...';
    btn.disabled = true;
    const r = await postJSON('/api/build', { requirement: req, projectId });
    showNotification('Build started (pid ' + r.pid + '). Watch RT Messages or Phased Progress.');
    status.textContent = 'Running (pid ' + r.pid + ')';
    btn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = '';
    // Auto-clear after 2 minutes (phased build is typically done by then)
    setTimeout(() => {
      status.textContent = '';
      btn.disabled = false;
      btn.style.display = '';
      if (stopBtn) stopBtn.style.display = 'none';
    }, 120000);
  } catch (e) { showNotification('Build failed: ' + e.message, true); status.textContent = ''; btn.disabled = false; }
}
async function enhancePrompt(){
  const ta = document.getElementById('buildRequirement');
  const raw = ta.value.trim();
  const btn = document.getElementById('enhancePromptBtn');
  if (!raw) { showNotification('Type an idea first', true); return; }
  try {
    btn.disabled = true;
    document.getElementById('buildStatus').textContent = 'Enhancing...';
    const r = await postJSON('/api/enhance-prompt', { text: raw });
    if (r.enhanced) { ta.value = r.enhanced; showNotification('Prompt updated'); }
    else { showNotification(r.error || 'No result', true); }
  } catch (e) { showNotification('Enhance failed: ' + e.message, true); }
  finally { btn.disabled = false; document.getElementById('buildStatus').textContent = ''; }
}
async function continuousBuildRun(){
  const req = document.getElementById('buildRequirement').value.trim();
  if (!req) { showNotification('Enter a requirement first', true); return; }
  const status = document.getElementById('buildStatus');
  const btn = document.getElementById('continuousBuildBtn');
  const stopBtn = document.getElementById('stopContinuousBtn');
  const logBox = document.getElementById('buildLiveLog');
  const projectId = document.getElementById('buildProjectPicker')?.value || '';
  try {
    status.textContent = 'Running continuously...';
    btn.disabled = true;
    btn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = '';
    logBox.style.display = 'block';
    logBox.textContent = '⚙ Starting continuous build...\\n';
    const r = await postJSON('/api/continuous-build', { requirement: req, projectId });
    logBox.textContent += '✅ Spawned (pid ' + r.pid + '). Checking progress below and in RT Messages tab.\\n';
    showNotification('Continuous build started — will keep going until all sections are done.');
    status.textContent = 'Running (continuous)';
    // Poll build log every 4s
    const poller = setInterval(async () => {
      try {
        const lg = await fetch('/api/continuous-build/log').then(r2 => r2.json());
        if (lg.lines && lg.lines.length) {
          logBox.textContent = lg.lines.map(l => {
            const icon = l.status === 'completed' ? '✅' : l.status === 'failed' ? '❌' : l.status === 'done' ? '🏁' : '·';
            return \`\${icon} [rd\${l.round||'?'}] \${l.agent ? l.agent+': ' : ''}\${l.task || l.status || JSON.stringify(l)}\`;
          }).join('\\n');
          logBox.scrollTop = logBox.scrollHeight;
          const last = lg.lines[lg.lines.length - 1];
          if (last && last.status === 'done') {
            clearInterval(poller);
            btn.disabled = false;
            btn.style.display = '';
            if (stopBtn) stopBtn.style.display = 'none';
            status.textContent = '🏁 Done!';
            showNotification('🏁 Continuous build complete!');
          }
        }
      } catch(_){}
    }, 4000);
    // Safety: re-enable button after 30 minutes max
    setTimeout(() => {
      clearInterval(poller);
      btn.disabled = false;
      btn.style.display = '';
      if (stopBtn) stopBtn.style.display = 'none';
      if (status.textContent.includes('continuous')) status.textContent = '';
    }, 30 * 60 * 1000);
  } catch (e) { showNotification('Continuous build failed: ' + e.message, true); status.textContent = ''; btn.disabled = false; btn.style.display = ''; if (stopBtn) stopBtn.style.display = 'none'; }
}
refreshAll();
setInterval(refreshAll, 3000);
// Populate chat project dropdown on load; respect #projects deep link (e.g. from native app)
(async () => {
  try {
    const data = await getJSON('/api/projects');
    const projects = data.projects || [];
    _projectsData = {};
    projects.forEach(p => { _projectsData[p.id] = p; });
    populateChatProjectDropdown(projects);
    if (location.hash === '#projects') showProjects();
  } catch {}
})();
window.addEventListener('hashchange', () => { if (location.hash === '#projects') showProjects(); });
document.getElementById('refreshBtn').onclick = refreshAll;
document.getElementById('runBuildBtn').onclick = runBuild;
document.getElementById('continuousBuildBtn').onclick = continuousBuildRun;
document.getElementById('stopBuildBtn').onclick = stopBuild;
document.getElementById('stopContinuousBtn').onclick = stopContinuousBuild;
document.getElementById('enhancePromptBtn').onclick = enhancePrompt;
loadBuildProjectPicker();
document.getElementById('newProjectBtn').onclick = () => {
  const form = document.getElementById('newProjectForm');
  form.style.display = form.style.display === 'none' ? 'block' : 'none';
};
document.getElementById('npCancelBtn').onclick = () => { document.getElementById('newProjectForm').style.display = 'none'; };
document.getElementById('npCreateBtn').onclick = async () => {
  const name = document.getElementById('npName').value.trim();
  const desc = document.getElementById('npDesc').value.trim();
  const outputDir = document.getElementById('npOutputDir').value.trim();
  const featuresDoc = document.getElementById('npFeaturesDoc').value.trim();
  if (!name || !outputDir) { showNotification('Name and output directory required', true); return; }
  try {
    const r = await postJSON('/api/projects', { name, description: desc, outputDir, featuresDoc });
    showNotification(\`Project "\${r.project.name}" created!\`);
    document.getElementById('newProjectForm').style.display = 'none';
    document.getElementById('npName').value = '';
    document.getElementById('npDesc').value = '';
    document.getElementById('npOutputDir').value = '';
    document.getElementById('npFeaturesDoc').value = '';
    loadProjects();
  } catch(e) { showNotification('Failed: ' + e.message, true); }
};
// sendBtn / messageInput removed (replaced by crew-lead chat)

// ── PM Loop controls ──────────────────────────────────────────────────────
let pmPoller = null;

function getSelectedProjectId() {
  const sel = document.getElementById('buildProjectPicker');
  return sel ? sel.value : '';
}
async function checkPmStatus() {
  try {
    const projectId = getSelectedProjectId();
    const qs = projectId ? '?projectId=' + encodeURIComponent(projectId) : '';
    const s = await fetch('/api/pm-loop/status' + qs).then(r => r.json());
    const badge    = document.getElementById('pmLoopBadge');
    const startBtn = document.getElementById('pmStartBtn');
    const dryBtn   = document.getElementById('pmDryRunBtn');
    const logBox   = document.getElementById('pmLiveLog');
    if (s.running) {
      badge.textContent = 'running (pid ' + s.pid + ')';
      badge.classList.add('running');
      startBtn.disabled = true;
      dryBtn.disabled = true;
      logBox.style.display = 'block';
      if (!pmPoller) startPmLogPoller();
    } else {
      if (badge.textContent.startsWith('running')) {
        badge.textContent = 'idle';
        badge.classList.remove('running');
        startBtn.disabled = false;
        dryBtn.disabled = false;
      }
    }
  } catch(_) {}
}

function startPmLogPoller() {
  if (pmPoller) return;
  pmPoller = setInterval(async () => {
    try {
      const lg = await fetch('/api/pm-loop/log').then(r2 => r2.json());
      const logBox = document.getElementById('pmLiveLog');
      const badge  = document.getElementById('pmLoopBadge');
      const startBtn = document.getElementById('pmStartBtn');
      const dryBtn   = document.getElementById('pmDryRunBtn');
      if (lg.lines && lg.lines.length) {
        logBox.textContent = lg.lines.map(l => {
          if (l.event === 'finish') return \`🏁 Done  ✓\${l.done}  ✗\${l.failed}  ⏳\${l.pending}\`;
          if (l.event === 'stopped_by_file') return '⛔ Stopped by user';
          if (l.event === 'all_done') return \`🏁 All \${l.total} items complete!\`;
          const icon = l.status === 'done' ? '✅' : l.status === 'failed' ? '❌' : l.event ? '·' : '·';
          const txt  = l.item ? \`\${l.item.substring(0, 60)}\` : (l.event || '');
          return \`\${icon} \${txt}\`;
        }).join('\\n');
        logBox.scrollTop = logBox.scrollHeight;
        const last = lg.lines[lg.lines.length - 1];
        if (last && (last.event === 'finish' || last.event === 'all_done' || last.event === 'stopped_by_file')) {
          clearInterval(pmPoller); pmPoller = null;
          badge.textContent = last.event === 'all_done' ? '✓ complete' : 'idle';
          badge.classList.remove('running');
          startBtn.disabled = false; dryBtn.disabled = false;
        }
      }
    } catch(_){}
  }, 5000);
}

async function startPmLoop(dryRun = false) {
  const projectId = getSelectedProjectId();
  const badge  = document.getElementById('pmLoopBadge');
  const status = document.getElementById('pmStatus');
  const logBox = document.getElementById('pmLiveLog');
  const startBtn = document.getElementById('pmStartBtn');
  const dryBtn   = document.getElementById('pmDryRunBtn');
  const proj = _buildProjects[projectId];
  if (!projectId) {
    showNotification('Select a project first from the Project picker above', true);
    return;
  }
  try {
    badge.textContent = dryRun ? 'dry run...' : 'starting...';
    badge.classList.add('running');
    startBtn.disabled = true;
    dryBtn.disabled = true;
    logBox.style.display = 'block';
    logBox.textContent = '⚙ Starting PM Loop for ' + (proj ? proj.name : projectId) + (dryRun ? ' (dry run)' : '') + '...\\n';
    const resp = await fetch('/api/pm-loop/start', {
      method: 'POST',
      headers: {'content-type':'application/json'},
      body: JSON.stringify({ dryRun, projectId })
    });
    const r = await resp.json();
    if (resp.status === 409 || r.alreadyRunning) {
      logBox.textContent = '⚠ Already running (pid ' + r.pid + '). Watch the log below.\\n';
      badge.textContent = 'running (pid ' + r.pid + ')';
      showNotification('PM Loop already running for this project (pid ' + r.pid + ')', true);
      startPmLogPoller();
      return;
    }
    logBox.textContent += '✅ Spawned (pid ' + r.pid + '). PM is reading roadmap...\\n';
    badge.textContent = 'running (pid ' + r.pid + ')';
    showNotification('PM Loop started' + (dryRun ? ' (dry run)' : '') + ' for ' + (proj ? proj.name : projectId));
    startPmLogPoller();
  } catch (e) {
    showNotification('PM Loop failed: ' + e.message, true);
    badge.textContent = 'idle';
    badge.classList.remove('running');
    startBtn.disabled = false;
    dryBtn.disabled = false;
  }
}

async function stopPmLoop() {
  const projectId = getSelectedProjectId();
  try {
    await fetch('/api/pm-loop/stop', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ projectId }) });
    showNotification('Stop signal sent — PM will finish current task then halt.');
    document.getElementById('pmLoopBadge').textContent = 'stopping...';
  } catch (e) { showNotification('Stop failed: ' + e.message, true); }
}

async function toggleRoadmap() {
  const panel = document.getElementById('pmRoadmapPanel');
  if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }
  try {
    const projectId = getSelectedProjectId();
    const proj = _buildProjects[projectId];
    // If we have a project selected, fetch its roadmap file directly via file API
    let content = '';
    if (proj && proj.roadmapFile) {
      const r = await fetch('/api/file-content?path=' + encodeURIComponent(proj.roadmapFile)).then(r2 => r2.json());
      content = r.content || '(empty)';
    } else {
      const r = await fetch('/api/pm-loop/roadmap').then(r2 => r2.json());
      content = r.content || '(empty)';
    }
    panel.textContent = content;
    panel.style.display = 'block';
  } catch (e) { panel.textContent = 'Could not load roadmap: ' + e.message; panel.style.display = 'block'; }
}

document.getElementById('pmStartBtn').onclick  = () => startPmLoop(false);
document.getElementById('pmDryRunBtn').onclick  = () => startPmLoop(true);
document.getElementById('pmStopBtn').onclick    = stopPmLoop;
document.getElementById('pmRoadmapBtn').onclick = toggleRoadmap;
// Check PM status after picker loads so we use the right projectId
loadBuildProjectPicker().then(() => checkPmStatus());
// Re-check status whenever the project picker changes
document.getElementById('buildProjectPicker').addEventListener('change', () => {
  if (pmPoller) { clearInterval(pmPoller); pmPoller = null; }
  checkPmStatus();
});
const params = new URLSearchParams(window.location.search);
if (params.get('focus') === '1') {
  setTimeout(() => { const ci = document.getElementById('chatInput'); if (ci) { showChat(); ci.focus(); } }, 500);
} else {
  showChat();
}
loadAgents();
refreshAll();
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${listenPort}`);
  try {
    if (url.pathname === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store, no-cache, must-revalidate",
        pragma: "no-cache",
      });
      res.end(html);
      return;
    }
    if (url.pathname === "/crew-chat.html") {
      const chatFile = path.join(OPENCLAW_DIR, "crew-chat.html");
      try {
        const chatHtml = fs.readFileSync(chatFile, "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(chatHtml);
      } catch { res.writeHead(404); res.end("Not found"); }
      return;
    }
    if (url.pathname === "/api/sessions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(await proxyJSON("/session")));
      return;
    }
    if (url.pathname === "/api/messages") {
      const sid = url.searchParams.get("session");
      if (!sid) throw new Error("missing session");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(await proxyJSON(`/session/${encodeURIComponent(sid)}/message`)));
      return;
    }
    if (url.pathname === "/api/send" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { to, message } = JSON.parse(body);
      if (!to || !message) throw new Error("missing to or message");
      await sendCrewMessage(to, message);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/api/rt-messages") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(await getRecentRTMessages(100)));
      return;
    }

    // ── Token usage ──────────────────────────────────────────────────────────
    if (url.pathname === "/api/token-usage") {
      const usageFile = path.join(os.homedir(), ".crewswarm", "token-usage.json");
      let usage = { calls: 0, prompt: 0, completion: 0, byModel: {} };
      try { usage = JSON.parse(fs.readFileSync(usageFile, "utf8")); } catch {}
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(usage));
      return;
    }

    // ── Cmd allowlist (proxied to crew-lead) ─────────────────────────────────
    if (url.pathname === "/api/cmd-allowlist") {
      const CREW_LEAD = "http://127.0.0.1:5010";
      try {
        if (req.method === "GET") {
          const r = await fetch(`${CREW_LEAD}/allowlist-cmd`);
          const d = await r.json();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(d));
        } else if (req.method === "POST") {
          let body = ""; for await (const c of req) body += c;
          const r = await fetch(`${CREW_LEAD}/allowlist-cmd`, { method: "POST", headers: { "content-type": "application/json" }, body });
          const d = await r.json();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(d));
        } else if (req.method === "DELETE") {
          let body = ""; for await (const c of req) body += c;
          const r = await fetch(`${CREW_LEAD}/allowlist-cmd`, { method: "DELETE", headers: { "content-type": "application/json" }, body });
          const d = await r.json();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(d));
        } else {
          res.writeHead(405); res.end();
        }
      } catch (e) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // ── Telegram sessions (reads crew-lead chat-history for telegram-* sessions) ──
    if (url.pathname === "/api/telegram-sessions") {
      const histDir = path.join(os.homedir(), ".crewswarm", "chat-history");
      const sessions = [];
      try {
        const files = fs.readdirSync(histDir).filter(f => f.startsWith("telegram-") && f.endsWith(".jsonl"));
        for (const file of files) {
          const chatId = file.replace(/^telegram-/, "").replace(/\.jsonl$/, "");
          const lines = fs.readFileSync(path.join(histDir, file), "utf8").split("\n").filter(Boolean);
          const msgs = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          const last = msgs[msgs.length - 1];
          sessions.push({ chatId, messageCount: msgs.length, lastTs: last?.ts || null, messages: msgs.slice(-20) });
        }
      } catch {}
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(sessions));
      return;
    }

    if (url.pathname === "/api/agents") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(await getAgentList()));
      return;
    }
    if (url.pathname === "/api/dlq") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(await getDLQEntries()));
      return;
    }
    if (url.pathname === "/api/phased-progress") {
      const limit = Math.min(Number(url.searchParams.get("limit")) || 80, 200);
      const filterProject = url.searchParams.get("projectId") || null;
      let entries = await getPhasedProgress(200); // fetch more so filter has enough to work with
      if (filterProject) {
        entries = entries.filter(e => e.projectId === filterProject);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(entries.slice(-limit)));
      return;
    }
    if (url.pathname === "/api/enhance-prompt" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { text } = JSON.parse(body || "{}");
      if (!text || typeof text !== "string") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing text" }));
        return;
      }
      try {
        const enhanced = await enhancePromptWithGroq(text);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ enhanced }));
      } catch (err) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err?.message || String(err), enhanced: null }));
      }
      return;
    }
    if (url.pathname === "/api/build" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { requirement, projectId } = JSON.parse(body || "{}");
      if (!requirement || typeof requirement !== "string") throw new Error("missing requirement");
      // Resolve project output dir if projectId provided
      let projectEnv = {};
      if (projectId) {
        const { existsSync: ex } = await import("node:fs");
        const { readFile: rf } = await import("node:fs/promises");
        const regPath = path.join(OPENCLAW_DIR, "orchestrator-logs", "projects.json");
        if (ex(regPath)) {
          const reg = JSON.parse(await rf(regPath, "utf8").catch(() => "{}"));
          const proj = reg[projectId];
          if (proj) {
            projectEnv = {
              OPENCREW_OUTPUT_DIR: proj.outputDir,
              PM_ROADMAP_FILE: proj.roadmapFile,
              PM_PROJECT_ID: projectId,
              ...(proj.featuresDoc ? { PM_FEATURES_DOC: proj.featuresDoc } : {}),
            };
          }
        }
      }
      const { spawn } = await import("node:child_process");
      const { existsSync } = await import("node:fs");
      if (!existsSync(phasedOrchestrator)) throw new Error("phased-orchestrator.mjs not found at " + phasedOrchestrator);
      const proc = spawn("node", [phasedOrchestrator, "--all", requirement], {
        cwd: OPENCLAW_DIR,
        stdio: "ignore",
        detached: true,
        env: { ...process.env, OPENCLAW_DIR, ...projectEnv,
          PHASED_TASK_TIMEOUT_MS: process.env.PHASED_TASK_TIMEOUT_MS || "300000",
          OPENCREW_RT_SEND_TIMEOUT_MS: process.env.OPENCREW_RT_SEND_TIMEOUT_MS || "300000",
        },
      });
      proc.unref();
      // Track PID for stop functionality
      const pidFile = path.join(OPENCLAW_DIR, "orchestrator-logs", projectId ? "phased-" + projectId + ".pid" : "phased-orchestrator.pid");
      await import("node:fs/promises").then(m => m.writeFile(pidFile, String(proc.pid), "utf8")).catch(() => {});
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, pid: proc.pid, message: "Build started" }));
      return;
    }
    if (url.pathname === "/api/build/stop" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { projectId } = JSON.parse(body || "{}");
      const pidFile = path.join(OPENCLAW_DIR, "orchestrator-logs", projectId ? "phased-" + projectId + ".pid" : "phased-orchestrator.pid");
      try {
        const pidStr = fs.readFileSync(pidFile, "utf8").trim();
        const pid = parseInt(pidStr, 10);
        if (pid) process.kill(pid, "SIGTERM");
        fs.unlinkSync(pidFile);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, pid }));
      } catch (e) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    if (url.pathname === "/api/continuous-build" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { requirement, projectId } = JSON.parse(body || "{}");
      if (!requirement || typeof requirement !== "string") throw new Error("missing requirement");
      let projectEnv = {};
      if (projectId) {
        const { existsSync: ex } = await import("node:fs");
        const { readFile: rf } = await import("node:fs/promises");
        const regPath = path.join(OPENCLAW_DIR, "orchestrator-logs", "projects.json");
        if (ex(regPath)) {
          const reg = JSON.parse(await rf(regPath, "utf8").catch(() => "{}"));
          const proj = reg[projectId];
          if (proj) {
            projectEnv = {
              OPENCREW_OUTPUT_DIR: proj.outputDir,
              PM_ROADMAP_FILE: proj.roadmapFile,
              PM_PROJECT_ID: projectId,
              ...(proj.featuresDoc ? { PM_FEATURES_DOC: proj.featuresDoc } : {}),
            };
          }
        }
      }
      const { spawn } = await import("node:child_process");
      const { existsSync } = await import("node:fs");
      if (!existsSync(continuousBuild)) throw new Error("continuous-build.mjs not found at " + continuousBuild);
      const proc = spawn("node", [continuousBuild, requirement], {
        cwd: OPENCLAW_DIR,
        stdio: "ignore",
        detached: true,
        env: { ...process.env, OPENCLAW_DIR, ...projectEnv,
          PHASED_TASK_TIMEOUT_MS: process.env.PHASED_TASK_TIMEOUT_MS || "300000",
          OPENCREW_RT_SEND_TIMEOUT_MS: process.env.OPENCREW_RT_SEND_TIMEOUT_MS || "300000",
        },
      });
      proc.unref();
      const pidFile = path.join(OPENCLAW_DIR, "orchestrator-logs", projectId ? "continuous-" + projectId + ".pid" : "continuous-build.pid");
      await import("node:fs/promises").then(m => m.writeFile(pidFile, String(proc.pid), "utf8")).catch(() => {});
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, pid: proc.pid, message: "Continuous build started" }));
      return;
    }
    if (url.pathname === "/api/continuous-build/stop" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { projectId } = JSON.parse(body || "{}");
      const pidFile = path.join(OPENCLAW_DIR, "orchestrator-logs", projectId ? "continuous-" + projectId + ".pid" : "continuous-build.pid");
      try {
        const pidStr = fs.readFileSync(pidFile, "utf8").trim();
        const pid = parseInt(pidStr, 10);
        if (pid) process.kill(pid, "SIGTERM");
        fs.unlinkSync(pidFile);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, pid }));
      } catch (e) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    if (url.pathname === "/api/continuous-build/log" && req.method === "GET") {
      const { existsSync } = await import("node:fs");
      const { readFile } = await import("node:fs/promises");
      const logPath = path.join(OPENCLAW_DIR, "orchestrator-logs", "continuous-build.jsonl");
      let lines = [];
      if (existsSync(logPath)) {
        const raw = await readFile(logPath, "utf8").catch(() => "");
        lines = raw.trim().split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        lines = lines.slice(-50); // last 50 entries
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, lines }));
      return;
    }
    // ── Project management APIs ───────────────────────────────────────────
    if (url.pathname === "/api/projects" && req.method === "GET") {
      const { existsSync } = await import("node:fs");
      const { readFile: rf } = await import("node:fs/promises");
      const registryFile = path.join(OPENCLAW_DIR, "orchestrator-logs", "projects.json");
      let projects = {};
      if (existsSync(registryFile)) {
        projects = JSON.parse(await rf(registryFile, "utf8").catch(() => "{}"));
      }
      // Enrich each project with live roadmap stats and running status
      const logsDir2 = path.join(OPENCLAW_DIR, "orchestrator-logs");
      const enriched = await Promise.all(Object.values(projects).map(async p => {
        let done = 0, failed = 0, pending = 0, total = 0;
        if (existsSync(p.roadmapFile)) {
          const rm = await rf(p.roadmapFile, "utf8").catch(() => "");
          const lines = rm.split("\n").filter(l => /^- \[/.test(l));
          total   = lines.length;
          done    = lines.filter(l => /^- \[x\]/.test(l)).length;
          failed  = lines.filter(l => /^- \[!\]/.test(l)).length;
          pending = lines.filter(l => /^- \[ \]/.test(l)).length;
        }
        // Check if PM Loop is running for this project
        let running = false;
        const pidPath = path.join(logsDir2, `pm-loop-${p.id}.pid`);
        if (existsSync(pidPath)) {
          try {
            const pidStr = await rf(pidPath, "utf8").catch(() => "");
            const pid = parseInt(pidStr.trim(), 10);
            if (pid) { process.kill(pid, 0); running = true; }
          } catch { /* not running */ }
        }
        return { ...p, roadmap: { done, failed, pending, total }, running };
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, projects: enriched }));
      return;
    }
    if (url.pathname === "/api/projects" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { name, description, outputDir, featuresDoc } = JSON.parse(body || "{}");
      if (!name || !outputDir) throw new Error("name and outputDir required");
      const { existsSync, mkdirSync } = await import("node:fs");
      const { readFile: rf, writeFile: wf } = await import("node:fs/promises");
      // Create output dir and ROADMAP.md if they don't exist
      if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
      const roadmapFile = path.join(outputDir, "ROADMAP.md");
      if (!existsSync(roadmapFile)) {
        await wf(roadmapFile, `# ${name} — Living Roadmap\n\n> Managed by pm-loop.mjs. Add \`- [ ] items\` here at any time.\n\n---\n\n## Phase 0 — Getting Started\n\n- [ ] Create the initial project structure and entry point\n`);
      }
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const registryFile = path.join(OPENCLAW_DIR, "orchestrator-logs", "projects.json");
      let projects = {};
      if (existsSync(registryFile)) projects = JSON.parse(await rf(registryFile, "utf8").catch(() => "{}"));
      projects[id] = { id, name, description: description || "", outputDir, roadmapFile, featuresDoc: featuresDoc || "", tags: [], created: new Date().toISOString(), status: "active" };
      await wf(registryFile, JSON.stringify(projects, null, 2));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, project: projects[id] }));
      return;
    }
    if (url.pathname === "/api/projects/delete" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { projectId } = JSON.parse(body || "{}");
      if (!projectId) throw new Error("projectId required");
      const registryFile = path.join(OPENCLAW_DIR, "orchestrator-logs", "projects.json");
      const { existsSync } = await import("node:fs");
      const { readFile: rf, writeFile: wf } = await import("node:fs/promises");
      let projects = {};
      if (existsSync(registryFile)) projects = JSON.parse(await rf(registryFile, "utf8").catch(() => "{}"));
      if (!projects[projectId]) throw new Error("Project not found: " + projectId);
      delete projects[projectId];
      await wf(registryFile, JSON.stringify(projects, null, 2));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/api/projects/update" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { projectId, autoAdvance } = JSON.parse(body || "{}");
      if (!projectId) throw new Error("projectId required");
      const registryFile = path.join(OPENCLAW_DIR, "orchestrator-logs", "projects.json");
      const { existsSync } = await import("node:fs");
      const { readFile: rf, writeFile: wf } = await import("node:fs/promises");
      let projects = {};
      if (existsSync(registryFile)) projects = JSON.parse(await rf(registryFile, "utf8").catch(() => "{}"));
      if (!projects[projectId]) throw new Error("Project not found: " + projectId);
      if (autoAdvance !== undefined) projects[projectId].autoAdvance = Boolean(autoAdvance);
      await wf(registryFile, JSON.stringify(projects, null, 2));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, project: projects[projectId] }));
      return;
    }
    if (url.pathname === "/api/pm-loop/status" && req.method === "GET") {
      const { existsSync } = await import("node:fs");
      const { readFile: rf } = await import("node:fs/promises");
      const statusProjectId = url.searchParams.get("projectId") || "";
      const suffix = statusProjectId ? `-${statusProjectId}` : "";
      const pidPath = path.join(OPENCLAW_DIR, "orchestrator-logs", `pm-loop${suffix}.pid`);
      let running = false, pid = null;
      if (existsSync(pidPath)) {
        const pidStr = await rf(pidPath, "utf8").catch(() => "");
        pid = parseInt(pidStr.trim(), 10);
        if (pid) {
          try { process.kill(pid, 0); running = true; } catch { running = false; pid = null; }
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, running, pid }));
      return;
    }
    if (url.pathname === "/api/pm-loop/start" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { dryRun, projectId } = JSON.parse(body || "{}");
      const { spawn } = await import("node:child_process");
      const { existsSync, mkdirSync, unlinkSync } = await import("node:fs");
      const { readFile: rf } = await import("node:fs/promises");
      if (!existsSync(pmLoop)) throw new Error("pm-loop.mjs not found at " + pmLoop);
      // Resolve project config if projectId provided
      let projectDir = null, projectRoadmap = null, projectFeaturesDoc = null;
      if (projectId) {
        const registryFile = path.join(OPENCLAW_DIR, "orchestrator-logs", "projects.json");
        if (existsSync(registryFile)) {
          const reg = JSON.parse(await rf(registryFile, "utf8").catch(() => "{}"));
          const proj = reg[projectId];
          if (proj) { projectDir = proj.outputDir; projectRoadmap = proj.roadmapFile; projectFeaturesDoc = proj.featuresDoc || null; }
        }
      }
      // Per-project PID file (supports multiple simultaneous projects)
      const pidSuffix = projectId ? `-${projectId}` : "";
      const pidFile = path.join(OPENCLAW_DIR, "orchestrator-logs", `pm-loop${pidSuffix}.pid`);
      const stopFilePath = path.join(OPENCLAW_DIR, "orchestrator-logs", `pm-loop${pidSuffix}.stop`);
      if (existsSync(pidFile)) {
        const pidStr = await rf(pidFile, "utf8").catch(() => "");
        const existingPid = parseInt(pidStr.trim(), 10);
        if (existingPid) {
          try {
            process.kill(existingPid, 0); // throws if not running
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, alreadyRunning: true, pid: existingPid, message: "PM Loop already running (pid " + existingPid + ")" }));
            return;
          } catch { /* process dead — stale PID file, continue */ }
        }
      }
      // Clear any stale stop file
      if (existsSync(stopFilePath)) { try { unlinkSync(stopFilePath); } catch {} }
      const logsDir = path.join(OPENCLAW_DIR, "orchestrator-logs");
      if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
      // Load RT token so pm-loop and its child gateway-bridge --send can authenticate with the RT daemon
      let rtToken = process.env.OPENCREW_RT_AUTH_TOKEN || "";
      if (!rtToken) {
        const home = os.homedir();
        for (const p of [
          path.join(CFG_DIR, "config.json"),
          path.join(home, ".crewswarm", "config.json"),
          path.join(CFG_DIR, "crewswarm.json"),
          path.join(home, ".crewswarm", "crewswarm.json"),
          path.join(home, ".openclaw", "openclaw.json"),
        ]) {
          try {
            const c = JSON.parse(await rf(p, "utf8"));
            rtToken = c?.rt?.authToken || c?.env?.OPENCREW_RT_AUTH_TOKEN || "";
            if (rtToken) break;
          } catch {}
        }
      }
      if (!rtToken) {
        console.warn("[pm-loop/start] No OPENCREW_RT_AUTH_TOKEN found in env or ~/.crewswarm/config.json (rt.authToken) — dispatches will fail with 'invalid realtime token'.");
      }
      const spawnArgs = [pmLoop, ...(dryRun ? ["--dry-run"] : []), ...(projectDir ? ["--project-dir", projectDir] : [])];
      const spawnEnv = {
        ...process.env,
        OPENCLAW_DIR,
        ...(rtToken ? { OPENCREW_RT_AUTH_TOKEN: rtToken } : {}),
        PHASED_TASK_TIMEOUT_MS: process.env.PHASED_TASK_TIMEOUT_MS || "300000",
        OPENCREW_RT_SEND_TIMEOUT_MS: process.env.OPENCREW_RT_SEND_TIMEOUT_MS || "300000",
        OPENCREW_RT_SEND_SENDER: "PM Loop",
        OPENCREW_RT_BROADCAST_SENDER: "PM Loop",
        ...(projectId     ? { PM_PROJECT_ID: projectId }              : {}),
        ...(projectDir    ? { OPENCREW_OUTPUT_DIR: projectDir }        : {}),
        ...(projectRoadmap    ? { PM_ROADMAP_FILE: projectRoadmap }    : {}),
        ...(projectFeaturesDoc ? { PM_FEATURES_DOC: projectFeaturesDoc } : {}),
      };
      const proc = spawn("node", spawnArgs, {
        cwd: OPENCLAW_DIR,
        stdio: "ignore",
        detached: true,
        env: spawnEnv,
      });
      proc.unref();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, pid: proc.pid, dryRun: !!dryRun }));
      return;
    }
    if (url.pathname === "/api/pm-loop/stop" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { projectId } = JSON.parse(body || "{}");
      const { writeFileSync, mkdirSync, existsSync } = await import("node:fs");
      const logsDir = path.join(OPENCLAW_DIR, "orchestrator-logs");
      if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
      // Write project-specific stop file if projectId provided
      const suffix = projectId ? `-${projectId}` : "";
      const stopFilePath = path.join(logsDir, `pm-loop${suffix}.stop`);
      writeFileSync(stopFilePath, new Date().toISOString());
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: "Stop signal sent — PM will halt after current task" }));
      return;
    }
    if (url.pathname === "/api/pm-loop/log" && req.method === "GET") {
      const { existsSync } = await import("node:fs");
      const { readFile } = await import("node:fs/promises");
      let lines = [];
      if (existsSync(pmLogFile)) {
        const raw = await readFile(pmLogFile, "utf8").catch(() => "");
        lines = raw.trim().split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        lines = lines.slice(-60);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, lines }));
      return;
    }
    if (url.pathname === "/api/pm-loop/roadmap" && req.method === "GET") {
      const { existsSync } = await import("node:fs");
      const { readFile } = await import("node:fs/promises");
      let content = "(ROADMAP.md not found — create website/ROADMAP.md)";
      if (existsSync(roadmapFile)) {
        content = await readFile(roadmapFile, "utf8").catch(() => "(unreadable)");
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, content }));
      return;
    }
    if (url.pathname === "/api/dlq/replay" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { key } = JSON.parse(body);
      if (!key) throw new Error("missing key");
      const { execSync } = await import("node:child_process");
      execSync(`"${ctlPath}" dlq-replay "${key}"`, { encoding: "utf8", timeout: 10000 });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // ── Settings: RT Bus token ─────────────────────────────────────────────
    if (url.pathname === "/api/settings/rt-token" && req.method === "GET") {
      const csConfigPath = path.join(os.homedir(), ".crewswarm", "config.json");
      let token = "";
      try { token = JSON.parse(fs.readFileSync(csConfigPath, "utf8"))?.rt?.authToken || ""; } catch {}
      if (!token) token = process.env.OPENCREW_RT_AUTH_TOKEN || "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: token ? "SET" : "" }));
      return;
    }
    if (url.pathname === "/api/settings/rt-token" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { token } = JSON.parse(body);
      const csDir = path.join(os.homedir(), ".crewswarm");
      const csConfigPath = path.join(csDir, "config.json");
      fs.mkdirSync(csDir, { recursive: true });
      let cfg = {};
      try { cfg = JSON.parse(fs.readFileSync(csConfigPath, "utf8")); } catch {}
      cfg.rt = { ...(cfg.rt || {}), authToken: token };
      fs.writeFileSync(csConfigPath, JSON.stringify(cfg, null, 2));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // ── Settings: OpenCode project dir + fallback model ─────────────────────
    if (url.pathname === "/api/settings/opencode-project" && req.method === "GET") {
      const cfgPath = path.join(os.homedir(), ".crewswarm", "config.json");
      let dir = process.env.OPENCREW_OPENCODE_PROJECT || "";
      let fallbackModel = process.env.OPENCREW_OPENCODE_FALLBACK_MODEL || "groq/moonshotai/kimi-k2-instruct-0905";
      try {
        const c = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        if (c.opencodeProject) dir = c.opencodeProject;
        if (c.opencodeFallbackModel) fallbackModel = c.opencodeFallbackModel;
      } catch {}
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ dir, fallbackModel }));
      return;
    }
    if (url.pathname === "/api/settings/opencode-project" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let { dir, fallbackModel } = JSON.parse(body);
      // Normalize: expand ~, ensure absolute path
      if (dir !== undefined) {
        if (dir) {
          dir = dir.trim();
          if (dir.startsWith("~")) dir = os.homedir() + dir.slice(1);
          if (!path.isAbsolute(dir)) dir = "/" + dir;
          dir = path.normalize(dir);
        }
      }
      const cfgDir  = path.join(os.homedir(), ".crewswarm");
      const cfgPath = path.join(cfgDir, "config.json");
      fs.mkdirSync(cfgDir, { recursive: true });
      let cfg = {};
      try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch {}
      if (dir !== undefined) { if (dir) cfg.opencodeProject = dir; else delete cfg.opencodeProject; process.env.OPENCREW_OPENCODE_PROJECT = dir || ""; }
      if (fallbackModel !== undefined) { if (fallbackModel && String(fallbackModel).trim()) cfg.opencodeFallbackModel = String(fallbackModel).trim(); else delete cfg.opencodeFallbackModel; }
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, dir: cfg.opencodeProject, fallbackModel: cfg.opencodeFallbackModel }));
      return;
    }
    // ── Built-in providers (crewswarm standalone config) ─────────────────
    const BUILTIN_URLS = {
      groq:       "https://api.groq.com/openai/v1",
      anthropic:  "https://api.anthropic.com/v1",
      openai:     "https://api.openai.com/v1",
      perplexity: "https://api.perplexity.ai",
      mistral:    "https://api.mistral.ai/v1",
      deepseek:   "https://api.deepseek.com/v1",
      xai:        "https://api.x.ai/v1",
      ollama:     "http://localhost:11434/v1",
      "openai-local": "http://127.0.0.1:8000/v1",
    };
    const csDir = path.join(os.homedir(), ".crewswarm");
    const csConfig     = path.join(csDir, "config.json");
    const csSwarmConfig = path.join(csDir, "crewswarm.json");
    const ocConfig     = path.join(os.homedir(), ".openclaw", "openclaw.json");
    function readCSConfig(){ try { return JSON.parse(fs.readFileSync(csConfig,"utf8")); } catch { return {}; } }
    function readCSSwarmConfig(){ try { return JSON.parse(fs.readFileSync(csSwarmConfig,"utf8")); } catch { return {}; } }
    function writeCSSwarmConfig(c){ fs.mkdirSync(csDir,{recursive:true}); fs.writeFileSync(csSwarmConfig,JSON.stringify(c,null,2)); }
    function readOCConfig(){ try { return JSON.parse(fs.readFileSync(ocConfig,"utf8")); } catch { return null; } }
    function writeOCConfig(c){ fs.writeFileSync(ocConfig,JSON.stringify(c,null,4)); }
    function getBuiltinKey(id) {
      const sw = readCSSwarmConfig();
      const cs = readCSConfig();
      const oc = readOCConfig();
      return sw?.providers?.[id]?.apiKey
          || sw?.env?.[id.toUpperCase()+"_API_KEY"]
          || cs?.providers?.[id]?.apiKey
          || cs?.env?.[id.toUpperCase()+"_API_KEY"]
          || oc?.models?.providers?.[id]?.apiKey
          || "";
    }

    if (url.pathname === "/api/providers/builtin" && req.method === "GET") {
      const keys = {};
      for (const id of Object.keys(BUILTIN_URLS)) {
        keys[id] = getBuiltinKey(id) ? "SET" : "";
      }
      res.writeHead(200,{"content-type":"application/json"});
      res.end(JSON.stringify({ ok:true, keys }));
      return;
    }
    if (url.pathname === "/api/providers/builtin/save" && req.method === "POST") {
      let body=""; for await (const chunk of req) body+=chunk;
      let { providerId, apiKey } = JSON.parse(body);
      // OpenAI (local)/ChatMock ignores key; use placeholder so crew-lead has a truthy apiKey
      if (providerId === "openai-local" && !(apiKey && apiKey.trim())) apiKey = "key";
      // Write to ~/.crewswarm/crewswarm.json
      const cfg = readCSSwarmConfig();
      if (!cfg.providers) cfg.providers = {};
      cfg.providers[providerId] = { ...(cfg.providers[providerId]||{}), apiKey, baseUrl: BUILTIN_URLS[providerId] };
      writeCSSwarmConfig(cfg);
      // Sync to ~/.openclaw/openclaw.json if it exists (legacy compat)
      const oc = readOCConfig();
      if (oc) {
        if (!oc.models) oc.models = {};
        if (!oc.models.providers) oc.models.providers = {};
        if (!oc.models.providers[providerId]) {
          oc.models.providers[providerId] = { baseUrl: BUILTIN_URLS[providerId], api: "openai-completions", models: [] };
        }
        oc.models.providers[providerId].apiKey = apiKey;
        writeOCConfig(oc);
      }
      res.writeHead(200,{"content-type":"application/json"});
      res.end(JSON.stringify({ ok:true }));
      return;
    }
    if (url.pathname === "/api/providers/builtin/test" && req.method === "POST") {
      let body=""; for await (const chunk of req) body+=chunk;
      const { providerId } = JSON.parse(body);
      const apiKey = getBuiltinKey(providerId);
      const baseUrl = BUILTIN_URLS[providerId] || "";
      if (providerId === "ollama") {
        try {
          const r = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(4000) });
          const d = await r.json();
          res.writeHead(200,{"content-type":"application/json"});
          res.end(JSON.stringify({ ok:true, model: (d.models?.[0]?.name || "connected") }));
        } catch(e) { res.writeHead(200,{"content-type":"application/json"}); res.end(JSON.stringify({ ok:false, error: e.message })); }
        return;
      }
      if (providerId === "openai-local") {
        const key = apiKey || "key";
        try {
          const r = await fetch(baseUrl + "/models", { headers: { authorization: "Bearer " + key }, signal: AbortSignal.timeout(6000) });
          const d = await r.json().catch(() => ({}));
          const model = d?.data?.[0]?.id || (r.ok ? "ChatMock connected" : null);
          res.writeHead(200, {"content-type": "application/json"});
          res.end(JSON.stringify({ ok: r.ok, model, error: r.ok ? undefined : (d?.error?.message || r.statusText)?.slice(0, 80) }));
        } catch(e) { res.writeHead(200, {"content-type": "application/json"}); res.end(JSON.stringify({ ok: false, error: e.message })); }
        return;
      }
      if (!apiKey) { res.writeHead(200,{"content-type":"application/json"}); res.end(JSON.stringify({ ok:false, error:"No API key saved" })); return; }
      try {
        let r, d, model;
        if (providerId === "anthropic") {
          // Anthropic uses x-api-key + anthropic-version, and /v1/models
          r = await fetch("https://api.anthropic.com/v1/models", {
            headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
            signal: AbortSignal.timeout(8000)
          });
          d = await r.json();
          model = d?.data?.[0]?.id || (r.ok ? "connected" : null);
        } else {
          r = await fetch(baseUrl + "/models", { headers:{ authorization:"Bearer "+apiKey }, signal: AbortSignal.timeout(8000) });
          d = await r.json();
          model = d?.data?.[0]?.id || (r.ok ? "connected" : null);
        }
        res.writeHead(200,{"content-type":"application/json"});
        res.end(JSON.stringify({ ok: r.ok, model, error: r.ok ? undefined : (d?.error?.message||r.statusText) }));
      } catch(e) { res.writeHead(200,{"content-type":"application/json"}); res.end(JSON.stringify({ ok:false, error:e.message })); }
      return;
    }
    // ── Proxy /api/settings/bg-consciousness → crew-lead:5010 ────────────────
    if (url.pathname === "/api/settings/bg-consciousness") {
      try {
        const rawBody = req.method === "POST" ? (await (async () => { let b = ""; for await (const c of req) b += c; return b; })()) : null;
        const token = (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "config.json"), "utf8"))?.rt?.authToken || ""; } catch { return ""; } })();
        const r = await fetch("http://127.0.0.1:5010/api/settings/bg-consciousness", {
          method: req.method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          ...(rawBody ? { body: rawBody } : {}), signal: AbortSignal.timeout(8000),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(await r.text());
      } catch (e) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "crew-lead unreachable: " + e.message }));
      }
      return;
    }
    // ── Proxy /api/settings/global-fallback → crew-lead:5010 ─────────────────
    if (url.pathname === "/api/settings/global-fallback") {
      try {
        const rawBody = req.method === "POST" ? (await (async () => { let b = ""; for await (const c of req) b += c; return b; })()) : null;
        const token = (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "config.json"), "utf8"))?.rt?.authToken || ""; } catch { return ""; } })();
        const r = await fetch("http://127.0.0.1:5010/api/settings/global-fallback", {
          method: req.method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          ...(rawBody ? { body: rawBody } : {}), signal: AbortSignal.timeout(8000),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(await r.text());
      } catch (e) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "crew-lead unreachable: " + e.message }));
      }
      return;
    }
    if (url.pathname === "/api/settings/openclaw-status" && req.method === "GET") {
      const deviceJson = path.join(os.homedir(), ".openclaw", "devices", "paired.json");
      const deviceJsonAlt = path.join(os.homedir(), ".openclaw", "device.json");
      const installed = fs.existsSync(deviceJson) || fs.existsSync(deviceJsonAlt);
      res.writeHead(200,{"content-type":"application/json"});
      res.end(JSON.stringify({ ok:true, installed }));
      return;
    }
    // ── crew-lead chat API ────────────────────────────────────────────────────
    if (url.pathname === "/api/crew-lead/status" && req.method === "GET") {
      try {
        const { execSync: es } = await import("node:child_process");
        const out = es("ps aux", { encoding: "utf8" });
        const online = out.includes("crew-lead.mjs");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, online }));
      } catch {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, online: false }));
      }
      return;
    }
    if (url.pathname === "/api/crew-lead/chat" && req.method === "POST") {
      let body = ""; for await (const chunk of req) body += chunk;
      const crewLeadPort = process.env.CREW_LEAD_PORT || "5010";
      try {
        const clRes = await fetch(`http://127.0.0.1:${crewLeadPort}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(200000), // 3m20s — allow crew-lead + reasoning LLM to finish
        });
        const text = await clRes.text();
        let clData;
        try { clData = JSON.parse(text); } catch { clData = { ok: false, error: text.slice(0, 200) || clRes.statusText }; }
        if (!clRes.ok && clData && typeof clData.error !== "string") clData.error = clData.error || text?.slice(0, 200) || "crew-lead error";
        res.writeHead(clRes.ok ? 200 : clRes.status, { "content-type": "application/json" });
        res.end(JSON.stringify(clData));
      } catch (e) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "crew-lead unreachable: " + (e?.message || String(e)), reply: null }));
      }
      return;
    }
    if (url.pathname === "/api/crew-lead/clear" && req.method === "POST") {
      let body = ""; for await (const chunk of req) body += chunk;
      const crewLeadPort = process.env.CREW_LEAD_PORT || "5010";
      const clRes = await fetch(`http://127.0.0.1:${crewLeadPort}/clear`, {
        method: "POST", headers: { "content-type": "application/json" }, body,
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/api/crew-lead/events" && req.method === "GET") {
      const crewLeadPort = process.env.CREW_LEAD_PORT || "5010";
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive", "access-control-allow-origin": "*" });
      res.write("retry: 3000\n\n");
      // Proxy SSE from crew-lead
      const upstream = await fetch(`http://127.0.0.1:${crewLeadPort}/events`, { signal: req.socket.destroyed ? AbortSignal.abort() : undefined }).catch(() => null);
      if (!upstream?.body) { res.end(); return; }
      const reader = upstream.body.getReader();
      req.on("close", () => reader.cancel());
      (async () => { try { while (true) { const { done, value } = await reader.read(); if (done) break; res.write(value); } } catch {} finally { res.end(); } })();
      return;
    }
    if (url.pathname === "/api/crew-lead/history" && req.method === "GET") {
      const crewLeadPort = process.env.CREW_LEAD_PORT || "5010";
      const sessionId = url.searchParams.get("sessionId") || "owner";
      const clRes = await fetch(`http://127.0.0.1:${crewLeadPort}/history?sessionId=${encodeURIComponent(sessionId)}`, {
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);
      if (!clRes || !clRes.ok) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, history: [] })); return; }
      const clData = await clRes.json();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(clData));
      return;
    }
    if (url.pathname === "/api/crew-lead/confirm-project" && req.method === "POST") {
      let body = ""; for await (const chunk of req) body += chunk;
      const crewLeadPort = process.env.CREW_LEAD_PORT || "5010";
      const clRes = await fetch(`http://127.0.0.1:${crewLeadPort}/confirm-project`, {
        method: "POST", headers: { "content-type": "application/json" }, body,
        signal: AbortSignal.timeout(15000),
      });
      const clData = await clRes.json();
      res.writeHead(clRes.status, { "content-type": "application/json" });
      res.end(JSON.stringify(clData));
      return;
    }
    if (url.pathname === "/api/crew-lead/discard-project" && req.method === "POST") {
      let body = ""; for await (const chunk of req) body += chunk;
      const crewLeadPort = process.env.CREW_LEAD_PORT || "5010";
      await fetch(`http://127.0.0.1:${crewLeadPort}/discard-project`, {
        method: "POST", headers: { "content-type": "application/json" }, body,
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // ── Folder picker (native macOS) ──────────────────────────────────────
    if (url.pathname === "/api/pick-folder" && req.method === "GET") {
      const { execSync: es } = await import("node:child_process");
      const defaultPath = url.searchParams.get("default") || os.homedir();
      try {
        const script = `tell application "Finder" to set f to (choose folder with prompt "Select project folder:" default location POSIX file "${defaultPath}") \nreturn POSIX path of f`;
        const chosen = es(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { encoding: "utf8", timeout: 30000 }).trim();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, path: chosen }));
      } catch {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, path: "" }));
      }
      return;
    }
    // ── Providers API ─────────────────────────────────────────────────────
    if (url.pathname === "/api/providers" && req.method === "GET") {
      const { readFile } = await import("node:fs/promises");
      const cfgPath = CFG_FILE;
      const cfg = JSON.parse(await readFile(cfgPath, "utf8").catch(() => "{}"));
      // Support both locations: legacy/openclaw used top-level "providers", dashboard also uses "models.providers"
      const providerMap = cfg?.models?.providers || cfg?.providers || {};
      const providers = Object.entries(providerMap).map(([id, p]) => {
        const key = p.apiKey || "";
        const masked = key.length > 8
          ? key.slice(0, 4) + "•".repeat(Math.min(key.length - 8, 20)) + key.slice(-4)
          : key.length > 0 ? "•".repeat(key.length) : "";
        return { id, baseUrl: p.baseUrl || "", hasKey: key.length > 0, maskedKey: masked, models: p.models || [], api: p.api || "openai-completions" };
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, providers }));
      return;
    }
    if (url.pathname === "/api/providers/save" && req.method === "POST") {
      const { readFile, writeFile } = await import("node:fs/promises");
      let body = ""; for await (const chunk of req) body += chunk;
      const { providerId, apiKey } = JSON.parse(body);
      if (!providerId || !apiKey) throw new Error("providerId and apiKey required");
      const cfgPath = CFG_FILE;
      const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
      const fromModels = cfg?.models?.providers?.[providerId];
      const fromTop = cfg?.providers?.[providerId];
      if (!fromModels && !fromTop) throw new Error("Provider not found: " + providerId);
      if (fromTop) { cfg.providers[providerId].apiKey = apiKey; }
      if (fromModels) { cfg.models.providers[providerId].apiKey = apiKey; }
      if (!fromModels && fromTop) {
        if (!cfg.models) cfg.models = {};
        if (!cfg.models.providers) cfg.models.providers = {};
        cfg.models.providers[providerId] = { ...cfg.providers[providerId], apiKey };
      }
      await writeFile(cfgPath, JSON.stringify(cfg, null, 4), "utf8");
      // Sync to ~/.crewswarm/config.json
      try {
        const cs = readCSConfig();
        if (!cs.providers) cs.providers = {};
        const baseUrl = (fromModels || fromTop)?.baseUrl || BUILTIN_URLS[providerId] || "";
        cs.providers[providerId] = { ...(cs.providers[providerId]||{}), apiKey, baseUrl };
        writeCSConfig(cs);
      } catch {}
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/api/providers/add" && req.method === "POST") {
      const { readFile, writeFile } = await import("node:fs/promises");
      let body = ""; for await (const chunk of req) body += chunk;
      const { id, baseUrl, apiKey, api } = JSON.parse(body);
      if (!id || !baseUrl) throw new Error("id and baseUrl required");
      const cfgPath = CFG_FILE;
      const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
      if (!cfg.models) cfg.models = {};
      if (!cfg.models.providers) cfg.models.providers = {};
      cfg.models.providers[id] = { baseUrl, apiKey: apiKey || "", api: api || "openai-completions", models: [] };
      await writeFile(cfgPath, JSON.stringify(cfg, null, 4), "utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/api/providers/fetch-models" && req.method === "POST") {
      let body = ""; for await (const chunk of req) body += chunk;
      const { providerId } = JSON.parse(body);
      const { readFile, writeFile } = await import("node:fs/promises");
      const cfgPath = CFG_FILE;
      const cfg = JSON.parse(await readFile(cfgPath, "utf8").catch(() => "{}"));
      const provider = cfg?.models?.providers?.[providerId] || cfg?.providers?.[providerId];
      if (!provider) throw new Error("Provider not found: " + providerId);
      const key = provider.apiKey;
      if (!key) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "No API key set" })); return; }
      const baseUrl = (provider.baseUrl || "").replace(/\/$/, "");
      const isSlowProvider = providerId === "nvidia" || (provider.baseUrl || "").includes("nvidia.com");
      const isFetchAnthropic = providerId === "anthropic" || baseUrl.includes("anthropic.com");
      const isPerplexity = (providerId && providerId.toLowerCase() === "perplexity") || (baseUrl && baseUrl.toLowerCase().includes("perplexity"));
      const isXai = (providerId && providerId.toLowerCase() === "xai") || (baseUrl && baseUrl.toLowerCase().includes("x.ai"));
      // Perplexity has no GET /models endpoint — use known model list
      if (isPerplexity) {
        const knownModels = [
          { id: "sonar", name: "Sonar" },
          { id: "sonar-pro", name: "Sonar Pro" },
          { id: "sonar-reasoning", name: "Sonar Reasoning" },
          { id: "sonar-reasoning-pro", name: "Sonar Reasoning Pro" },
        ];
        provider.models = knownModels;
        if (cfg.models?.providers?.[providerId]) cfg.models.providers[providerId].models = knownModels;
        if (cfg.providers?.[providerId]) cfg.providers[providerId].models = knownModels;
        await writeFile(cfgPath, JSON.stringify(cfg, null, 4), "utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, models: knownModels.map(m => m.id), count: knownModels.length, note: "Perplexity has no /models API; built-in list used." }));
        return;
      }
      // xAI /models may return empty or different shape — use known Grok list when empty
      if (isXai) {
        const knownModels = [
          { id: "grok-3-mini", name: "Grok 3 Mini" },
          { id: "grok-3", name: "Grok 3" },
          { id: "grok-4-fast-non-reasoning", name: "Grok 4 Fast (non-reasoning)" },
          { id: "grok-4-fast-reasoning", name: "Grok 4 Fast (reasoning)" },
          { id: "grok-4-1-fast-non-reasoning", name: "Grok 4.1 Fast (non-reasoning)" },
          { id: "grok-4-1-fast-reasoning", name: "Grok 4.1 Fast (reasoning)" },
          { id: "grok-4-0709", name: "Grok 4 0709" },
          { id: "grok-code-fast-1", name: "Grok Code Fast" },
          { id: "grok-2-vision-1212", name: "Grok 2 Vision" },
        ];
        provider.models = knownModels;
        if (cfg.models?.providers?.[providerId]) cfg.models.providers[providerId].models = knownModels;
        if (cfg.providers?.[providerId]) cfg.providers[providerId].models = knownModels;
        await writeFile(cfgPath, JSON.stringify(cfg, null, 4), "utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, models: knownModels.map(m => m.id), count: knownModels.length, note: "xAI built-in Grok model list used." }));
        return;
      }
      const fetchHeaders = isFetchAnthropic
        ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
        : { authorization: `Bearer ${key}`, "content-type": "application/json" };
      try {
        const modelsRes = await fetch(`${baseUrl}/models`, {
          headers: fetchHeaders,
          signal: AbortSignal.timeout(isSlowProvider ? 30000 : 12000),
        });
        if (modelsRes.status === 404) {
          // Provider has no /models endpoint — keep existing model list
          const existing = provider.models || [];
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, models: existing.map(m => m.id || m), count: existing.length, note: "Provider has no /models endpoint; existing list kept." }));
          return;
        }
        if (modelsRes.status === 429) {
          // Rate limited — keep existing model list, don't overwrite
          const existing = provider.models || [];
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, models: existing.map(m => m.id || m), count: existing.length, note: "Rate limited (429); existing model list kept." }));
          return;
        }
        if (!modelsRes.ok) {
          const txt = await modelsRes.text().catch(() => modelsRes.statusText);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: `${modelsRes.status}: ${txt.slice(0, 120)}` }));
          return;
        }
        const json = await modelsRes.json();
        let rawModels = json.data || json.models || [];
        // Perplexity / xAI may return 200 with empty or unexpected list — use built-in
        if (rawModels.length === 0 && baseUrl) {
          const u = baseUrl.toLowerCase();
          if (u.includes("perplexity")) {
            const knownModels = [
              { id: "sonar", name: "Sonar" },
              { id: "sonar-pro", name: "Sonar Pro" },
              { id: "sonar-reasoning", name: "Sonar Reasoning" },
              { id: "sonar-reasoning-pro", name: "Sonar Reasoning Pro" },
            ];
            provider.models = knownModels;
            if (cfg.models?.providers?.[providerId]) cfg.models.providers[providerId].models = knownModels;
            if (cfg.providers?.[providerId]) cfg.providers[providerId].models = knownModels;
            await writeFile(cfgPath, JSON.stringify(cfg, null, 4), "utf8");
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, models: knownModels.map(m => m.id), count: knownModels.length, note: "Perplexity returned no /models; built-in list used." }));
            return;
          }
          if (u.includes("x.ai")) {
            const knownModels = [
              { id: "grok-3-mini", name: "Grok 3 Mini" },
              { id: "grok-3", name: "Grok 3" },
              { id: "grok-4-fast-non-reasoning", name: "Grok 4 Fast (non-reasoning)" },
              { id: "grok-4-fast-reasoning", name: "Grok 4 Fast (reasoning)" },
              { id: "grok-4-1-fast-non-reasoning", name: "Grok 4.1 Fast (non-reasoning)" },
              { id: "grok-4-1-fast-reasoning", name: "Grok 4.1 Fast (reasoning)" },
              { id: "grok-4-0709", name: "Grok 4 0709" },
              { id: "grok-code-fast-1", name: "Grok Code Fast" },
              { id: "grok-2-vision-1212", name: "Grok 2 Vision" },
            ];
            provider.models = knownModels;
            if (cfg.models?.providers?.[providerId]) cfg.models.providers[providerId].models = knownModels;
            if (cfg.providers?.[providerId]) cfg.providers[providerId].models = knownModels;
            await writeFile(cfgPath, JSON.stringify(cfg, null, 4), "utf8");
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, models: knownModels.map(m => m.id), count: knownModels.length, note: "xAI returned no /models; built-in list used." }));
            return;
          }
        }
        const models = rawModels
          .filter(m => m.id || m.name)
          .map(m => ({ id: m.id || m.name, name: m.name || m.id }))
          .sort((a, b) => a.id.localeCompare(b.id));
        provider.models = models;
        if (cfg.models?.providers?.[providerId]) cfg.models.providers[providerId].models = models;
        if (cfg.providers?.[providerId]) cfg.providers[providerId].models = models;
        await writeFile(cfgPath, JSON.stringify(cfg, null, 4), "utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, models: models.map(m => m.id), count: models.length }));
      } catch(e) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    if (url.pathname === "/api/providers/test" && req.method === "POST") {
      let body = ""; for await (const chunk of req) body += chunk;
      const { providerId } = JSON.parse(body);
      const { readFile } = await import("node:fs/promises");
      const cfgPath = CFG_FILE;
      const cfg = JSON.parse(await readFile(cfgPath, "utf8").catch(() => "{}"));
      const provider = cfg?.models?.providers?.[providerId] || cfg?.providers?.[providerId];
      if (!provider) throw new Error("Provider not found");
      const key = provider.apiKey;
      if (!key) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "No API key set" })); return; }
      const baseUrl = (provider.baseUrl || "").replace(/\/$/, "");
      const isAnthropic = providerId === "anthropic" || baseUrl.includes("anthropic.com");
      const isNvidia   = providerId === "nvidia"    || baseUrl.includes("nvidia.com");
      const isGoogle   = providerId === "google"    || baseUrl.includes("googleapis.com");
      const isPerplexityTest = (providerId && providerId.toLowerCase() === "perplexity") || (baseUrl && baseUrl.toLowerCase().includes("perplexity"));
      const isXaiTest = (providerId && providerId.toLowerCase() === "xai") || (baseUrl && baseUrl.toLowerCase().includes("x.ai"));
      const defaultModel = isAnthropic ? "claude-3-haiku-20240307"
                         : isGoogle    ? "gemini-1.5-flash"
                         : isPerplexityTest ? "sonar-pro"
                         : isXaiTest ? "grok-3-mini"
                         : "gpt-4o-mini";
      const firstModel = provider.models?.[0]?.id || defaultModel;
      try {
        let testRes, ok, model, errText;
        if (isAnthropic) {
          testRes = await fetch(`${baseUrl}/models`, {
            headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
            signal: AbortSignal.timeout(10000),
          });
          const d = await testRes.json().catch(() => ({}));
          ok = testRes.ok;
          model = d?.data?.[0]?.id || (ok ? "connected" : null);
          errText = d?.error?.message || testRes.statusText;
        } else if (isGoogle) {
          const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
          testRes = await fetch(listUrl, { signal: AbortSignal.timeout(10000) });
          const gd = await testRes.json().catch(() => ({}));
          ok = testRes.ok && !!gd.models;
          const chatModels = (gd.models || []).filter(m => m.name && m.supportedGenerationMethods?.includes("generateContent"));
          model = chatModels[0]?.name?.replace("models/","") || (ok ? "connected" : null);
          errText = gd.error?.message || testRes.statusText;
        } else if (isPerplexityTest) {
          testRes = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
            body: JSON.stringify({ model: firstModel, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
            signal: AbortSignal.timeout(15000),
          });
          ok = testRes.ok || testRes.status === 400;
          model = firstModel;
          errText = ok ? undefined : await testRes.text().catch(() => testRes.statusText);
        } else {
          // Default: validate via /models endpoint (no inference, no rate limits, works with all OpenAI-compatible APIs)
          testRes = await fetch(`${baseUrl}/models`, {
            headers: { authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(15000),
          });
          const d = await testRes.json().catch(() => ({}));
          ok = testRes.ok;
          const chatModel = (d?.data || []).find(m => /chat|instruct|turbo|gpt|llama|qwen|mistral|gemma|codex|deepseek/i.test(m?.id || ""));
          model = chatModel?.id || d?.data?.[0]?.id || (ok ? "connected" : null);
          errText = d?.error?.message || testRes.statusText;
          if (!ok && testRes.status === 404) {
            // Fallback: /models not supported, try chat/completions
            testRes = await fetch(`${baseUrl}/chat/completions`, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
              body: JSON.stringify({ model: firstModel, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
              signal: AbortSignal.timeout(15000),
            });
            ok = testRes.ok || testRes.status === 400;
            model = firstModel;
            errText = ok ? undefined : await testRes.text().catch(() => testRes.statusText);
          }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok, model, error: ok ? undefined : errText?.slice(0, 120) }));
      } catch(e) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    // ── Search Tools API ────────────────────────────────────────────────────
    if (url.pathname === "/api/search-tools" && req.method === "GET") {
      const csTools = path.join(os.homedir(), ".crewswarm", "search-tools.json");
      const ocTools = path.join(os.homedir(), ".openclaw", "search-tools.json");
      const savedCs = await fs.promises.readFile(csTools, "utf8").catch(() => "{}").then(d => { try { return JSON.parse(d); } catch { return {}; } });
      const savedOc = await fs.promises.readFile(ocTools, "utf8").catch(() => "{}").then(d => { try { return JSON.parse(d); } catch { return {}; } });
      const keys = {};
      keys.parallel = !!(savedCs.parallel?.apiKey || savedOc.parallel?.apiKey || process.env.PARALLEL_API_KEY);
      keys.brave    = !!(savedCs.brave?.apiKey    || savedOc.brave?.apiKey    || process.env.BRAVE_API_KEY);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys }));
      return;
    }
    if (url.pathname === "/api/search-tools/save" && req.method === "POST") {
      let body = ""; for await (const chunk of req) body += chunk;
      const { toolId, key } = JSON.parse(body);
      const csTools = path.join(os.homedir(), ".crewswarm", "search-tools.json");
      const ocTools = path.join(os.homedir(), ".openclaw", "search-tools.json");
      const savedCs = await fs.promises.readFile(csTools, "utf8").catch(() => "{}").then(d => { try { return JSON.parse(d); } catch { return {}; } });
      savedCs[toolId] = { apiKey: key };
      await fs.promises.mkdir(path.dirname(csTools), { recursive: true }).catch(() => {});
      await fs.promises.writeFile(csTools, JSON.stringify(savedCs, null, 2));
      const savedOc = await fs.promises.readFile(ocTools, "utf8").catch(() => "{}").then(d => { try { return JSON.parse(d); } catch { return {}; } });
      savedOc[toolId] = { apiKey: key };
      await fs.promises.mkdir(path.dirname(ocTools), { recursive: true }).catch(() => {});
      await fs.promises.writeFile(ocTools, JSON.stringify(savedOc, null, 2));
      // Also persist to ~/.zshrc so agents and shells pick it up
      const envKey = toolId === "parallel" ? "PARALLEL_API_KEY" : toolId === "brave" ? "BRAVE_API_KEY" : null;
      if (envKey) {
        const zshrc = path.join(os.homedir(), ".zshrc");
        let content = await fs.promises.readFile(zshrc, "utf8").catch(() => "");
        const line = `export ${envKey}="${key}"`;
        const regex = new RegExp(`^export ${envKey}=.*$`, "m");
        content = regex.test(content) ? content.replace(regex, line) : content + `\n${line}\n`;
        await fs.promises.writeFile(zshrc, content);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/api/search-tools/test" && req.method === "POST") {
      let body = ""; for await (const chunk of req) body += chunk;
      const { toolId } = JSON.parse(body);
      const csTools = path.join(os.homedir(), ".crewswarm", "search-tools.json");
      const ocTools = path.join(os.homedir(), ".openclaw", "search-tools.json");
      const savedCs = await fs.promises.readFile(csTools, "utf8").catch(() => "{}").then(d => { try { return JSON.parse(d); } catch { return {}; } });
      const savedOc = await fs.promises.readFile(ocTools, "utf8").catch(() => "{}").then(d => { try { return JSON.parse(d); } catch { return {}; } });
      const key = savedCs[toolId]?.apiKey || savedOc[toolId]?.apiKey || process.env[toolId === "parallel" ? "PARALLEL_API_KEY" : "BRAVE_API_KEY"];
      if (!key) { res.writeHead(200,{"content-type":"application/json"}); res.end(JSON.stringify({ok:false,error:"No key saved"})); return; }
      try {
        let ok, message, error;
        if (toolId === "parallel") {
          // Validate via chat completions — lightest endpoint
          const r = await fetch("https://api.parallel.ai/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json", "authorization": `Bearer ${key}` },
            body: JSON.stringify({ model: "speed", messages: [{ role: "user", content: "hi" }], stream: false }),
            signal: AbortSignal.timeout(15000),
          });
          ok = r.ok || r.status === 400;
          message = ok ? "Connected — parallel.ai ready" : null;
          error = ok ? undefined : `${r.status} ${r.statusText}`;
        } else if (toolId === "brave") {
          const r = await fetch("https://api.search.brave.com/res/v1/web/search?q=test&count=1", {
            headers: { "Accept": "application/json", "X-Subscription-Token": key },
            signal: AbortSignal.timeout(10000),
          });
          ok = r.ok;
          message = ok ? "Connected — Brave Search ready" : null;
          error = ok ? undefined : `${r.status} ${r.statusText}`;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok, message, error }));
      } catch(e) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    // ── OpenCode stats API (queries DB directly) ─────────────────────────────
    if (url.pathname === "/api/opencode-stats" && req.method === "GET") {
      const days = Number(url.searchParams.get("days") || "14");
      const dbPath = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
      try {
        const { execFile } = await import("node:child_process");
        const query = `
SELECT
  date(p.time_created/1000,'unixepoch') as day,
  json_extract(m.data,'$.providerID') || '/' || json_extract(m.data,'$.modelID') as model,
  ROUND(SUM(json_extract(p.data,'$.cost')),6) as cost,
  SUM(json_extract(p.data,'$.tokens.input')) as input_tok,
  SUM(json_extract(p.data,'$.tokens.output')) as output_tok,
  SUM(json_extract(p.data,'$.tokens.cache.read')) as cache_read,
  COUNT(*) as calls
FROM part p
JOIN message m ON m.id = p.message_id
WHERE json_extract(p.data,'$.type') = 'step-finish'
  AND p.time_created > (strftime('%s','now') - ${days}*86400)*1000
GROUP BY day, model
ORDER BY day DESC, cost DESC;`;
        const rows = await new Promise((resolve, reject) => {
          // -readonly avoids competing with the opencode server write lock; 30s timeout for large DBs
          execFile("sqlite3", [dbPath, "-readonly", "-separator", "\t", query], { timeout: 30000 }, (err, stdout) => {
            if (err) return reject(err);
            const result = [];
            for (const line of stdout.trim().split("\n").filter(Boolean)) {
              const [day, model, cost, input_tok, output_tok, cache_read, calls] = line.split("\t");
              result.push({ day, model, cost: Number(cost)||0, input_tok: Number(input_tok)||0, output_tok: Number(output_tok)||0, cache_read: Number(cache_read)||0, calls: Number(calls)||0 });
            }
            resolve(result);
          });
        });
        // Roll up by day for summary
        const byDay = {};
        for (const r of rows) {
          if (!byDay[r.day]) byDay[r.day] = { cost: 0, input_tok: 0, output_tok: 0, calls: 0, byModel: {} };
          byDay[r.day].cost += r.cost;
          byDay[r.day].input_tok += r.input_tok;
          byDay[r.day].output_tok += r.output_tok;
          byDay[r.day].calls += r.calls;
          byDay[r.day].byModel[r.model] = { cost: r.cost, input_tok: r.input_tok, output_tok: r.output_tok, calls: r.calls };
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, rows, byDay }));
      } catch (e) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message, rows: [], byDay: {} }));
      }
      return;
    }
    // ── OpenCode models API ──────────────────────────────────────────────────
    if (url.pathname === "/api/opencode-models" && req.method === "GET") {
      let models = [];
      // Try CLI first (may hang if OpenCode desktop holds DB lock, so short timeout)
      try {
        const { execFile } = await import("node:child_process");
        const ocBin = path.join(os.homedir(), ".opencode", "bin", "opencode");
        const bin = fs.existsSync(ocBin) ? ocBin : "opencode";
        models = await new Promise((resolve, reject) => {
          const child = execFile(bin, ["models", "list", "--format", "json"], { timeout: 8000, env: { ...process.env } }, (err, stdout) => {
            if (err) return reject(err);
            try { resolve(JSON.parse(stdout)); } catch { resolve([]); }
          });
        });
      } catch {
        // Fallback: read auth.json to discover configured providers, then return known models
        try {
          const authPath = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
          const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
          const providers = Object.keys(auth || {}).map(k => k.toLowerCase());
          const knownModels = {
            openai:  [
              "openai/gpt-5.3-codex", "openai/gpt-5.3-codex-spark",
              "openai/gpt-5.2-codex", "openai/gpt-5.2",
              "openai/gpt-5.1-codex-max", "openai/gpt-5.1-codex", "openai/gpt-5.1-codex-mini",
              "openai/gpt-5-codex", "openai/codex-mini-latest",
            ],
            opencode:[
              // Stealth
              "opencode/big-pickle",
              "opencode/trinity-large-preview-free",
              // OpenAI
              "opencode/gpt-5.1-codex-max", "opencode/gpt-5.1-codex", "opencode/gpt-5.1-codex-mini", "opencode/gpt-5.1",
              "opencode/gpt-5.2-codex", "opencode/gpt-5.2",
              "opencode/alpha-gpt-5.3-codex", "opencode/alpha-gpt-5.4",
              "opencode/gpt-5-codex", "opencode/gpt-5", "opencode/gpt-5-nano",
              // Anthropic
              "opencode/claude-sonnet-4-6", "opencode/claude-sonnet-4-5", "opencode/claude-sonnet-4",
              "opencode/claude-opus-4-6", "opencode/claude-opus-4-5", "opencode/claude-opus-4-1",
              "opencode/claude-haiku-4-5", "opencode/claude-3-5-haiku",
              // Google
              "opencode/gemini-3.1-pro", "opencode/gemini-3-pro", "opencode/gemini-3-flash",
              // Moonshot AI
              "opencode/kimi-k2.5", "opencode/kimi-k2.5-free", "opencode/kimi-k2-thinking", "opencode/kimi-k2",
              // Z.ai
              "opencode/glm-5", "opencode/glm-5-free", "opencode/glm-4.7", "opencode/glm-4.6",
              // MiniMax
              "opencode/minimax-m2.5", "opencode/minimax-m2.5-free", "opencode/minimax-m2.1", "opencode/minimax-m2.1-free",
            ],
            groq:    [
              "groq/moonshotai/kimi-k2-instruct-0905",
              "groq/openai/gpt-oss-120b", "groq/openai/gpt-oss-20b",
              "groq/meta-llama/llama-4-maverick-17b-128e-instruct",
              "groq/meta-llama/llama-4-scout-17b-16e-instruct",
              "groq/qwen/qwen3-32b",
              "groq/llama-3.3-70b-versatile", "groq/llama-3.1-8b-instant",
            ],
            xai:     [
              "xai/grok-4-1-fast", "xai/grok-4-1-fast-non-reasoning",
              "xai/grok-4", "xai/grok-4-fast", "xai/grok-4-fast-non-reasoning",
              "xai/grok-code-fast-1",
              "xai/grok-3", "xai/grok-3-latest", "xai/grok-3-fast", "xai/grok-3-fast-latest",
              "xai/grok-3-mini", "xai/grok-3-mini-latest", "xai/grok-3-mini-fast", "xai/grok-3-mini-fast-latest",
              "xai/grok-2-latest", "xai/grok-2", "xai/grok-2-1212",
              "xai/grok-2-vision-latest", "xai/grok-2-vision", "xai/grok-2-vision-1212",
              "xai/grok-beta", "xai/grok-vision-beta",
            ],
          };
          for (const p of providers) {
            if (knownModels[p]) models.push(...knownModels[p]);
          }
          // Also check env vars for additional providers
          if (process.env.GROQ_API_KEY && !providers.includes("groq")) models.push(...(knownModels.groq || []));
          if (process.env.XAI_API_KEY && !providers.includes("xai")) models.push(...(knownModels.xai || []));
        } catch { /* no auth info available */ }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, models }));
      return;
    }
    // ── Agents API ──────────────────────────────────────────────────────────
    if (url.pathname === "/api/agents-config" && req.method === "GET") {
      const { readFile } = await import("node:fs/promises");
      const cfgPath = CFG_FILE;
      const promptsPath = path.join(CFG_DIR, "agent-prompts.json");
      const cfg = JSON.parse(await readFile(cfgPath, "utf8").catch(() => "{}"));
      const agentPrompts = JSON.parse(await readFile(promptsPath, "utf8").catch(() => "{}"));
      const rawList = Array.isArray(cfg.agents) ? cfg.agents
                    : Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
      const nowMs = Date.now();
      const agentList = rawList.map(a => {
        const lastSeen = agentHeartbeats.get(a.id) || null;
        const ageSec = lastSeen ? Math.floor((nowMs - lastSeen) / 1000) : null;
        const liveness = ageSec === null ? "unknown" : ageSec < 90 ? "online" : ageSec < 300 ? "stale" : "offline";
        return {
          id: a.id,
          model: a.model || "",
          fallbackModel: a.fallbackModel || "",
          name: a.identity?.name || a.id,
          emoji: a.identity?.emoji || "🤖",
          theme: a.identity?.theme || "",
          systemPrompt: agentPrompts[a.id] || agentPrompts[a.id.replace(/^crew-/, "")] || "",
          toolProfile: a.tools?.profile || "default",
          alsoAllow: a.tools?.crewswarmAllow || a.tools?.alsoAllow || [],
          workspace: a.workspace || "",
          useOpenCode: a.useOpenCode,
          opencodeModel: a.opencodeModel || "",
          liveness, lastSeen, ageSec,
        };
      });
      // Always show crew-lead in Agents so user can set his model (crew-lead.mjs reads from this config)
      if (!agentList.some(a => a.id === "crew-lead")) {
        agentList.push({
          id: "crew-lead",
          model: "groq/llama-3.3-70b-versatile",
          name: "Crew Lead",
          emoji: "🦊",
          theme: "",
          systemPrompt: agentPrompts["crew-lead"] || "",
          toolProfile: "default",
          alsoAllow: ["dispatch"],
          workspace: "",
          liveness: "unknown",
          lastSeen: null,
          ageSec: null,
        });
      }
      // Always show orchestrator in Agents — PM loop uses this model for routing/expanding (or falls back to crew-pm)
      if (!agentList.some(a => a.id === "orchestrator")) {
        agentList.push({
          id: "orchestrator",
          model: "",
          name: "Orchestrator (PM Loop)",
          emoji: "🧠",
          theme: "",
          systemPrompt: agentPrompts["orchestrator"] || "",
          toolProfile: "default",
          alsoAllow: ["read_file", "dispatch"],
          workspace: "",
          liveness: "unknown",
          lastSeen: null,
          ageSec: null,
        });
      }
      // Merge providers from both locations so MODEL dropdown gets custom models from either
      const topProviders = cfg?.providers || {};
      const nestedProviders = cfg?.models?.providers || {};
      const providerMap = {};
      for (const id of new Set([...Object.keys(topProviders), ...Object.keys(nestedProviders)])) {
        const t = topProviders[id];
        const n = nestedProviders[id];
        const merged = { ...(t || {}), ...(n || {}) };
        merged.models = (n?.models?.length ? n.models : t?.models) || [];
        providerMap[id] = merged;
      }
      const allModels = [];
      const modelsByProvider = {};
      const OPENAI_LOCAL_DEFAULT_MODELS = [
        { id: "gpt-5", name: "GPT-5" },
        { id: "gpt-5.1", name: "GPT-5.1" },
        { id: "gpt-5.2", name: "GPT-5.2" },
        { id: "gpt-5-codex", name: "GPT-5 Codex" },
        { id: "gpt-5.1-codex", name: "GPT-5.1 Codex" },
        { id: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini" },
        { id: "codex-mini", name: "Codex Mini" },
      ];
      for (const [pid, p] of Object.entries(providerMap)) {
        let models = p.models || [];
        if (pid === "openai-local" && !models.length) models = OPENAI_LOCAL_DEFAULT_MODELS;
        if (!models.length) continue;
        modelsByProvider[pid] = models.map(m => ({ id: typeof m === "string" ? m : m.id, name: typeof m === "string" ? m : (m.name || m.id) }));
        for (const m of models) {
          const mid = typeof m === "string" ? m : m.id;
          allModels.push(pid + "/" + mid);
        }
      }
      const defaultModels = Object.keys(cfg.agents?.defaults?.models || {});
      for (const m of defaultModels) { if (!allModels.includes(m)) allModels.push(m); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, agents: agentList, allModels, modelsByProvider }));
      return;
    }
    if (url.pathname === "/api/agents-config/update" && req.method === "POST") {
      const { readFile, writeFile } = await import("node:fs/promises");
      let body = ""; for await (const chunk of req) body += chunk;
      const { agentId, model, fallbackModel, systemPrompt, name, emoji, theme, toolProfile, alsoAllow, useOpenCode, opencodeModel, opencodeFallbackModel, useCursorCli, cursorCliModel } = JSON.parse(body);
      if (!agentId) throw new Error("agentId required");
      const cfgPath = CFG_FILE;
      const promptsPath = path.join(CFG_DIR, "agent-prompts.json");
      const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
      let list = Array.isArray(cfg.agents) ? cfg.agents
                 : Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
      let agent = list.find(a => a.id === agentId);
      if (!agent && agentId === "crew-lead") {
        if (!Array.isArray(cfg.agents)) cfg.agents = cfg.agents?.list != null ? { list: cfg.agents.list } : [];
        const arr = Array.isArray(cfg.agents) ? cfg.agents : cfg.agents.list;
        if (!arr) throw new Error("Cannot determine agents list structure in crewswarm.json");
        agent = { id: "crew-lead", model: "groq/llama-3.3-70b-versatile", identity: { name: "Crew Lead", emoji: "🦊" }, tools: { profile: "default", alsoAllow: ["dispatch"] } };
        arr.push(agent);
        list = arr;
      }
      if (!agent && agentId === "orchestrator") {
        if (!Array.isArray(cfg.agents)) cfg.agents = cfg.agents?.list != null ? { list: cfg.agents.list } : [];
        const arr = Array.isArray(cfg.agents) ? cfg.agents : cfg.agents.list;
        if (!arr) throw new Error("Cannot determine agents list structure in crewswarm.json");
        agent = { id: "orchestrator", model: "", identity: { name: "Orchestrator (PM Loop)", emoji: "🧠" }, tools: { profile: "default", alsoAllow: ["read_file", "dispatch"] } };
        arr.push(agent);
        list = arr;
      }
      if (!agent) throw new Error("Agent not found: " + agentId);
      if (model) agent.model = model;
      if (fallbackModel !== undefined) agent.fallbackModel = fallbackModel || undefined;
      if (name)  { if (!agent.identity) agent.identity = {}; agent.identity.name  = name; }
      if (emoji) { if (!agent.identity) agent.identity = {}; agent.identity.emoji = emoji; }
      if (theme !== undefined && theme !== null) { if (!agent.identity) agent.identity = {}; agent.identity.theme = theme; }
      if (toolProfile) { if (!agent.tools) agent.tools = {}; agent.tools.profile = toolProfile; }
      if (alsoAllow !== undefined) {
        if (!agent.tools) agent.tools = {};
        agent.tools.crewswarmAllow = alsoAllow;
        agent.tools.alsoAllow = alsoAllow;
        agent.tools.profile = "crewswarm";
      }
      if (useOpenCode !== undefined) agent.useOpenCode = useOpenCode;
      if (opencodeModel !== undefined) agent.opencodeModel = opencodeModel || undefined;
      if (opencodeFallbackModel !== undefined) agent.opencodeFallbackModel = opencodeFallbackModel || undefined;
      if (useCursorCli !== undefined) agent.useCursorCli = useCursorCli;
      if (cursorCliModel !== undefined) agent.cursorCliModel = cursorCliModel || undefined;
      await writeFile(cfgPath, JSON.stringify(cfg, null, 4), "utf8");
      // System prompts live in agent-prompts.json, not crewswarm.json
      if (systemPrompt !== undefined) {
        const prompts = JSON.parse(await readFile(promptsPath, "utf8").catch(() => "{}"));
        prompts[agentId] = systemPrompt;
        await writeFile(promptsPath, JSON.stringify(prompts, null, 2), "utf8");
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/api/agents-config/create" && req.method === "POST") {
      const { readFile, writeFile } = await import("node:fs/promises");
      let body = ""; for await (const chunk of req) body += chunk;
      const { id, model, name, emoji, theme, systemPrompt, alsoAllow: reqAlsoAllow } = JSON.parse(body);
      if (!id || !model) throw new Error("id and model required");
      const cfgPath = CFG_FILE;
      const promptsPath = path.join(CFG_DIR, "agent-prompts.json");
      const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
      const list = Array.isArray(cfg.agents) ? cfg.agents
                 : Array.isArray(cfg.agents?.list) ? cfg.agents.list : null;
      if (!list) throw new Error("Cannot determine agents list structure in crewswarm.json");
      if (list.find(a => a.id === id)) throw new Error("Agent ID already exists: " + id);
      const defaultWorkspace = list[0]?.workspace || process.cwd();
      // Role-based tool defaults used when no explicit alsoAllow provided
      const ROLE_DEFAULTS = {
        'crew-qa': ['read_file'], 'crew-github': ['read_file','run_cmd','git'],
        'crew-pm': ['read_file','dispatch'], 'crew-lead': ['dispatch'],
        'crew-telegram': ['telegram','read_file'], 'crew-security': ['read_file','run_cmd'],
        'crew-copywriter': ['write_file','read_file'], 'crew-main': ['read_file','write_file','run_cmd','dispatch'],
      };
      const defaultTools = reqAlsoAllow?.length ? reqAlsoAllow
        : (ROLE_DEFAULTS[id] || ['write_file','read_file','mkdir','run_cmd']);
      list.push({
        id, model,
        identity: { name: name || id, emoji: emoji || "🤖", theme: theme || "" },
        tools: { profile: "crewswarm", alsoAllow: defaultTools },
        workspace: defaultWorkspace,
      });
      await writeFile(cfgPath, JSON.stringify(cfg, null, 4), "utf8");
      // Save system prompt to agent-prompts.json
      const defaultPrompt = systemPrompt || "You are " + (name || id) + ". You are a coding specialist in the CrewSwarm crew. Always read files before editing. Never replace entire files — only patch.";
      const prompts = JSON.parse(await readFile(promptsPath, "utf8").catch(() => "{}"));
      prompts[id] = defaultPrompt;
      await writeFile(promptsPath, JSON.stringify(prompts, null, 2), "utf8");
      // Auto-sync agent registry in shared memory
      import("node:child_process").then(({ execFile }) =>
        execFile("node", [new URL("./sync-agents.mjs", import.meta.url).pathname], { cwd: path.dirname(new URL(".", import.meta.url).pathname) }, () => {})
      ).catch(() => {});
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/api/agents-config/delete" && req.method === "POST") {
      const { readFile, writeFile } = await import("node:fs/promises");
      let body = ""; for await (const chunk of req) body += chunk;
      const { agentId } = JSON.parse(body);
      if (!agentId) throw new Error("agentId required");
      const cfgPath = CFG_FILE;
      const promptsPath = path.join(CFG_DIR, "agent-prompts.json");
      const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
      const list = Array.isArray(cfg.agents) ? cfg.agents
                 : Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
      const idx = list.findIndex(a => a.id === agentId);
      if (idx === -1) throw new Error("Agent not found: " + agentId);
      list.splice(idx, 1);
      await writeFile(cfgPath, JSON.stringify(cfg, null, 4), "utf8");
      // Also remove from agent-prompts.json
      try {
        const prompts = JSON.parse(await readFile(promptsPath, "utf8").catch(() => "{}"));
        delete prompts[agentId];
        await writeFile(promptsPath, JSON.stringify(prompts, null, 2), "utf8");
      } catch {}
      // Auto-sync agent registry in shared memory
      import("node:child_process").then(({ execFile }) =>
        execFile("node", [new URL("./sync-agents.mjs", import.meta.url).pathname], { cwd: path.dirname(new URL(".", import.meta.url).pathname) }, () => {})
      ).catch(() => {});
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if ((url.pathname === "/api/agents-config/reset-session" || url.pathname === "/api/agents/reset-session") && req.method === "POST") {
      let body = ""; for await (const chunk of req) body += chunk;
      const { agentId } = JSON.parse(body || "{}");
      if (!agentId) { res.writeHead(400); res.end(JSON.stringify({ error: "agentId required" })); return; }
      const { execFile } = await import("node:child_process");
      const bridgePath = path.join(OPENCLAW_DIR, "gateway-bridge.mjs");
      // 1. Reset the agent session via gateway-bridge --reset-session
      execFile("node", [bridgePath, "--reset-session", agentId],
        { cwd: OPENCLAW_DIR, timeout: 15000 }, () => {});
      // 2. After reset, re-inject shared memory as first message so agent has context
      setTimeout(() => {
        execFile("node", [bridgePath, "--send", agentId,
          "[SYSTEM] Session reset by operator. You are " + agentId + ". Read memory/current-state.md and memory/agent-handoff.md to restore context. Confirm with a one-line status."
        ], { cwd: OPENCLAW_DIR, timeout: 15000 }, () => {});
      }, 2000);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, agentId }));
      return;
    }

    if (url.pathname === "/api/crew/start" && req.method === "POST") {
      const { spawn: spawnProc } = await import("node:child_process");
      const { existsSync: eS } = await import("node:fs");
      const crewScript = path.join(OPENCLAW_DIR, "scripts", "start-crew.mjs");
      if (!eS(crewScript)) throw new Error("start-crew.mjs not found — is the dashboard running from the CrewSwarm repo?");
      const result = await new Promise((resolve, reject) => {
        const proc = spawnProc("node", [crewScript], {
          cwd: OPENCLAW_DIR,
          env: { ...process.env, OPENCLAW_DIR },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = ""; proc.stdout.on("data", d => out += d); proc.stderr.on("data", d => out += d);
        proc.on("close", code => code === 0 ? resolve(out.trim()) : reject(new Error(out.trim())));
      });
      const launched = (result.match(/Spawned .+ \(pid/g) || []).length;
      const msg = launched ? `⚡ ${launched} new bridge(s) started` : "✓ All bridges already running";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: msg, detail: result }));
      return;
    }
    // ── End agents API ───────────────────────────────────────────────────────

    // ── Roadmap read/write ───────────────────────────────────────────────────
    if (url.pathname === "/api/roadmap/read" && req.method === "POST") {
      const { readFile } = await import("node:fs/promises");
      let body = ""; for await (const chunk of req) body += chunk;
      const { roadmapFile } = JSON.parse(body);
      if (!roadmapFile) throw new Error("roadmapFile required");
      const content = await readFile(roadmapFile, "utf8").catch(() => "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, content }));
      return;
    }
    if (url.pathname === "/api/roadmap/write" && req.method === "POST") {
      const { writeFile } = await import("node:fs/promises");
      let body = ""; for await (const chunk of req) body += chunk;
      const { roadmapFile, content } = JSON.parse(body);
      if (!roadmapFile || content === undefined) throw new Error("roadmapFile and content required");
      await writeFile(roadmapFile, content, "utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Reset [!] failed items back to [ ] so PM Loop will retry them
    if (url.pathname === "/api/roadmap/retry-failed" && req.method === "POST") {
      const { readFile, writeFile } = await import("node:fs/promises");
      let body = ""; for await (const chunk of req) body += chunk;
      const { roadmapFile } = JSON.parse(body);
      if (!roadmapFile) throw new Error("roadmapFile required");
      const content = await readFile(roadmapFile, "utf8");
      // Strip [!] markers back to [ ] and remove failure timestamps
      const reset = content
        .split("\n")
        .map(line => line.replace(/\[!\]/, "[ ]").replace(/\s+✗\s+\d+:\d+:\d+/g, ""))
        .join("\n");
      const count = (content.match(/\[!\]/g) || []).length;
      await writeFile(roadmapFile, reset, "utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, count }));
      return;
    }

    if (url.pathname === "/favicon.ico" || url.pathname === "/favicon.png") {
      const faviconPath = new URL("../website/favicon.png", import.meta.url).pathname;
      try {
        const { readFile } = await import("node:fs/promises");
        const data = await readFile(faviconPath);
        res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
        res.end(data);
      } catch {
        res.writeHead(204);
        res.end();
      }
      return;
    }
    // Files API — scan a directory and return file metadata
    if (url.pathname === "/api/files" && req.method === "GET") {
      const scanDir = url.searchParams.get("dir") || os.homedir();
      const ALLOWED_EXT = new Set([".html",".css",".js",".mjs",".ts",".json",".md",".sh",".txt",".yaml",".yml"]);
      const MAX_FILES = 500;
      const results = [];
      function walk(dir, depth) {
        if (depth > 5) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (e.name.startsWith(".") || e.name === "node_modules") continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) { walk(full, depth + 1); }
          else if (e.isFile()) {
            const ext = path.extname(e.name).toLowerCase();
            if (!ALLOWED_EXT.has(ext)) continue;
            try {
              const st = fs.statSync(full);
              results.push({ path: full, size: st.size, mtime: st.mtimeMs });
            } catch { /* skip */ }
            if (results.length >= MAX_FILES) return;
          }
        }
      }
      walk(scanDir, 0);
      results.sort((a, b) => b.mtime - a.mtime);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ files: results }));
      return;
    }

    // File content preview — returns first 300 lines of a file
    if (url.pathname === "/api/file-content" && req.method === "GET") {
      const filePath = url.searchParams.get("path") || "";
      if (!filePath || filePath.includes("..")) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid path" }));
        return;
      }
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        const lines = raw.split("\n");
        const content = lines.length > 300 ? lines.slice(0, 300).join("\n") + `\n\n... (${lines.length - 300} more lines)` : raw;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ content, lines: lines.length }));
      } catch (e) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ── Telegram Bridge API ────────────────────────────────────────────────────
    const TG_CONFIG_PATH = path.join(os.homedir(), ".crewswarm", "telegram-bridge.json");
    const TG_PID_PATH    = path.join(os.homedir(), ".crewswarm", "logs", "telegram-bridge.pid");
    const TG_MSG_PATH    = path.join(os.homedir(), ".crewswarm", "logs", "telegram-messages.jsonl");

    function loadTgConfig() {
      try { return JSON.parse(fs.readFileSync(TG_CONFIG_PATH, "utf8")); } catch { return {}; }
    }

    function isTgRunning() {
      try {
        const pid = parseInt(fs.readFileSync(TG_PID_PATH, "utf8").trim(), 10);
        if (!pid) return false;
        process.kill(pid, 0);
        return true;
      } catch { return false; }
    }

    if (url.pathname === "/api/telegram/status") {
      const running = isTgRunning();
      const cfg = loadTgConfig();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ running, botName: cfg.botName || "" }));
      return;
    }

    if (url.pathname === "/api/telegram/config" && req.method === "GET") {
      const cfg = loadTgConfig();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        token: cfg.token || "",
        targetAgent: cfg.targetAgent || "crew-main",
        allowedChatIds: cfg.allowedChatIds || [],
        contactNames: cfg.contactNames || {},
      }));
      return;
    }

    if (url.pathname === "/api/telegram/config" && req.method === "POST") {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || "{}");
      const existing = loadTgConfig();
      const updated = { ...existing, ...body };
      fs.writeFileSync(TG_CONFIG_PATH, JSON.stringify(updated, null, 2));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/api/telegram/start" && req.method === "POST") {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || "{}");
      if (body.token) {
        const existing = loadTgConfig();
        fs.writeFileSync(TG_CONFIG_PATH, JSON.stringify({ ...existing, ...body }, null, 2));
      }
      const cfg = loadTgConfig();
      if (!cfg.token) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "No token configured" }));
        return;
      }
      if (isTgRunning()) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, message: "Already running" }));
        return;
      }
      const { spawn: spawnBridge } = await import("node:child_process");
      const bridgePath = path.join(OPENCLAW_DIR, "telegram-bridge.mjs");
      const env = { ...process.env, TELEGRAM_BOT_TOKEN: cfg.token, TELEGRAM_TARGET_AGENT: cfg.targetAgent || "crew-main" };
      const proc = spawnBridge("node", [bridgePath], { env, detached: true, stdio: "ignore" });
      proc.unref();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, pid: proc.pid }));
      return;
    }

    if (url.pathname === "/api/telegram/stop" && req.method === "POST") {
      try {
        const pid = parseInt(fs.readFileSync(TG_PID_PATH, "utf8").trim(), 10);
        if (pid) process.kill(pid, "SIGTERM");
      } catch {}
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/api/telegram/messages") {
      try {
        const raw = fs.readFileSync(TG_MSG_PATH, "utf8");
        const msgs = raw.trim().split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(msgs.slice(-100)));
      } catch {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("[]");
      }
      return;
    }

    // ── Services API ──────────────────────────────────────────────────────────
    if (url.pathname === "/api/services/status") {
      let services;
      try {
        const { execSync } = await import("node:child_process");
        const net = await import("node:net");

        function portListening(port) {
          return new Promise(resolve => {
            const sock = new net.default.Socket();
            sock.setTimeout(500);
            sock.once("connect", () => { sock.destroy(); resolve(true); });
            sock.once("error", () => resolve(false));
            sock.once("timeout", () => resolve(false));
            sock.connect(port, "127.0.0.1");
          });
        }

        function pidRunning(pidFile) {
          try {
            const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
            if (!pid) return null;
            process.kill(pid, 0);
            return pid;
          } catch { return null; }
        }

        function countProcs(pattern) {
          try {
            const out = execSync(`pgrep -f "${pattern}" | wc -l`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
            return parseInt(out, 10) || 0;
          } catch { return 0; }
        }

        function procStartTime(pid) {
          try {
            const out = execSync(`ps -p ${pid} -o lstart=`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
            return out ? new Date(out).getTime() : null;
          } catch { return null; }
        }

        const crewLeadPort = Number(process.env.CREW_LEAD_PORT || 5010);
        const tgPid     = pidRunning(path.join(os.homedir(), ".crewswarm", "logs", "telegram-bridge.pid"));
        const rtUp      = await portListening(18889);
        const crewLeadUp = await portListening(crewLeadPort);
        const gwUp      = await portListening(18789);
        const oclawPaired = fs.existsSync(path.join(os.homedir(), ".openclaw", "devices", "paired.json"))
                         || fs.existsSync(path.join(os.homedir(), ".openclaw", "device.json"));
        const ocUp      = await portListening(4096);
        const dashUp    = await portListening(listenPort);

        // Agent count: ask RT bus which agents are actually connected (most reliable source)
        let agentsOnline = 0;
        let rtAgentList = [];
        try {
          const rtStatusRes = await fetch("http://127.0.0.1:18889/status", { signal: AbortSignal.timeout(1500) });
          const rtStatus = await rtStatusRes.json();
          const raw = (rtStatus.agents || []).filter(Boolean);
          rtAgentList = raw.filter(a => String(a).toLowerCase() !== "crew-lead");
          agentsOnline = rtAgentList.length;
        } catch {
          // RT not reachable — fall back to pgrep
          agentsOnline = countProcs("gateway-bridge.mjs --rt-daemon");
        }
        // Total: count configured agents (minus crew-lead); never show X/Y with X > Y
        let agentsTotal = 0;
        try {
          const swarmCfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "crewswarm.json"), "utf8"));
          agentsTotal = (swarmCfg.agents || []).filter(a => a.id && String(a.id).toLowerCase() !== "crew-lead").length;
        } catch {}
        if (agentsTotal === 0) agentsTotal = 14;
        agentsTotal = Math.max(agentsTotal, agentsOnline);

        services = [
        {
          id: "rt-bus",
          label: "RT Message Bus",
          description: "opencrew-rt-daemon — agent communication backbone",
          port: 18889,
          running: rtUp,
          canRestart: true,
          pid: null,
        },
        {
          id: "agents",
          label: "Agent Crew",
          description: agentsOnline > 0
            ? `${agentsOnline}/${agentsTotal} agents online — ${rtAgentList.slice(0,5).join(", ")}${rtAgentList.length > 5 ? "…" : ""}`
            : `0/${agentsTotal} agents online — bridges not connected to RT bus`,
          port: null,
          running: agentsOnline > 0,
          canRestart: true,
          pid: null,
        },
        {
          id: "crew-lead",
          label: "crew-lead",
          description: "Chat commander — dashboard chat, CrewChat, Telegram",
          port: crewLeadPort,
          running: crewLeadUp,
          canRestart: true,
          pid: null,
        },
        {
          id: "telegram",
          label: "Telegram Bridge",
          description: "@CrewSwarm_bot → crew-main",
          port: null,
          running: tgPid !== null,
          canRestart: true,
          pid: tgPid,
        },
        {
          id: "opencode",
          label: "OpenCode Server",
          description: "opencode serve — sessions and MCP on port 4096",
          port: 4096,
          running: ocUp,
          canRestart: true,
          pid: null,
        },
        {
          id: "dashboard",
          label: "Dashboard",
          description: "This dashboard — will briefly disconnect then reload",
          port: listenPort,
          running: dashUp,
          canRestart: true,
          pid: process.pid,
        },
        {
          id: "openclaw-gateway",
          label: "OpenClaw Gateway",
          description: gwUp
            ? (oclawPaired ? "App paired ✓ — plugin can communicate via port 18789" : "Listening on port 18789")
            : "Port 18789. Start opens the OpenClaw app; if the gateway stays stopped, start it from within the app (status bar or Settings).",
          port: 18789,
          running: gwUp,
          canRestart: true,
          pid: null,
        },
      ];
      } catch (statusErr) {
        console.error("[dashboard] /api/services/status error:", statusErr?.message || statusErr);
        services = [
          { id: "rt-bus", label: "RT Message Bus", description: "opencrew-rt-daemon", port: 18889, running: false, canRestart: true, pid: null },
          { id: "agents", label: "Agent Crew", description: "0 agents connected", port: null, running: false, canRestart: true, pid: null },
          { id: "crew-lead", label: "crew-lead", description: "Chat commander", port: 5010, running: false, canRestart: true, pid: null },
          { id: "telegram", label: "Telegram Bridge", description: "@CrewSwarm_bot", port: null, running: false, canRestart: true, pid: null },
          { id: "opencode", label: "OpenCode Server", description: "opencode serve — port 4096", port: 4096, running: false, canRestart: true, pid: null },
          { id: "dashboard", label: "Dashboard", description: "This dashboard", port: listenPort, running: true, canRestart: true, pid: process.pid },
          { id: "openclaw-gateway", label: "OpenClaw Gateway", description: "Legacy gateway (port 18789) — only needed if pairing the OpenClaw desktop app", port: 18789, running: false, canRestart: true, pid: null },
        ];
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(services));
      return;
    }

    if (url.pathname === "/api/services/restart" && req.method === "POST") {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const { id } = JSON.parse(raw || "{}");
      const { execSync, spawn: spawnProc } = await import("node:child_process");

      const RT_TOKEN = (() => {
        const home = os.homedir();
        for (const [p, key] of [
          [path.join(home, ".crewswarm", "config.json"), "rt.authToken"],
          [path.join(home, ".crewswarm", "crewswarm.json"), "env.OPENCREW_RT_AUTH_TOKEN"],
          [path.join(home, ".openclaw", "openclaw.json"), "env.OPENCREW_RT_AUTH_TOKEN"],
        ]) {
          try {
            const c = JSON.parse(fs.readFileSync(p, "utf8"));
            const val = key.split(".").reduce((o, k) => o?.[k], c);
            if (val) return val;
          } catch {}
        }
        return "";
      })();
      // Build agent allowlist dynamically from crewswarm.json + permanent baseline
      const CREW_AGENTS_BASE = "main,admin,build,coder,researcher,architect,reviewer,qa,fixer,pm,orchestrator,openclaw,openclaw-main,opencode-pm,opencode-qa,opencode-fixer,opencode-coder,opencode-coder-2,security,crew-main,crew-pm,crew-qa,crew-fixer,crew-coder,crew-coder-2,crew-coder-front,crew-coder-back,crew-github,crew-security,crew-frontend,crew-copywriter,crew-telegram,crew-lead";
      const CREW_AGENTS = (() => {
        try {
          for (const p of [
            path.join(os.homedir(), ".crewswarm", "crewswarm.json"),
            path.join(os.homedir(), ".openclaw", "openclaw.json"),
          ]) {
            if (fs.existsSync(p)) {
              const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
              const agentArr = Array.isArray(cfg.agents) ? cfg.agents : (cfg.agents?.list || []);
              const ids = agentArr.map(a => a.id).filter(Boolean);
              if (ids.length) {
                const merged = new Set([...CREW_AGENTS_BASE.split(","), ...ids]);
                return [...merged].join(",");
              }
            }
          }
        } catch {}
        return CREW_AGENTS_BASE;
      })();

      if (id === "rt-bus") {
        try { execSync(`pkill -f "opencrew-rt-daemon"`, { stdio: "ignore" }); } catch {}
        await new Promise(r => setTimeout(r, 800));
        const rtDaemon = fs.existsSync(path.join(OPENCLAW_DIR, "scripts", "opencrew-rt-daemon.mjs"))
          ? path.join(OPENCLAW_DIR, "scripts", "opencrew-rt-daemon.mjs")
          : path.join(os.homedir(), "swarm", ".opencode", "plugin", "opencrew-rt-daemon.mjs");
        spawnProc("node", [rtDaemon], {
          env: { ...process.env, OPENCREW_RT_AUTH_TOKEN: RT_TOKEN, OPENCLAW_ALLOWED_AGENTS: CREW_AGENTS },
          detached: true, stdio: "ignore",
        }).unref();
      } else if (id === "agents") {
        try { execSync(`pkill -f "gateway-bridge.mjs --rt-daemon"`, { stdio: "ignore" }); } catch {}
        await new Promise(r => setTimeout(r, 800));
        spawnProc("node", [path.join(OPENCLAW_DIR, "scripts", "start-crew.mjs")], {
          cwd: OPENCLAW_DIR,
          detached: true,
          stdio: "ignore",
          env: { ...process.env, OPENCLAW_DIR },
        }).unref();
      } else if (id === "telegram") {
        try {
          const pid = parseInt(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "logs", "telegram-bridge.pid"), "utf8").trim(), 10);
          if (pid) process.kill(pid, "SIGTERM");
        } catch {}
        await new Promise(r => setTimeout(r, 800));
        const tgToken = process.env.TELEGRAM_BOT_TOKEN || (() => {
          try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "telegram-bridge.json"), "utf8")).token; } catch { return ""; }
        })();
        if (tgToken) {
          const tgCfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "telegram-bridge.json"), "utf8")); } catch { return {}; } })();
          spawnProc("node", [path.join(OPENCLAW_DIR, "telegram-bridge.mjs")], {
            cwd: OPENCLAW_DIR,
            env: { ...process.env, TELEGRAM_BOT_TOKEN: tgToken, TELEGRAM_TARGET_AGENT: tgCfg.targetAgent || "crew-main" },
            detached: true, stdio: "ignore",
          }).unref();
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, message: "Telegram not restarted — set TELEGRAM_BOT_TOKEN or configure via Settings → Telegram." }));
          return;
        }
      } else if (id === "crew-lead") {
        try { execSync(`pkill -f "crew-lead.mjs"`, { stdio: "ignore" }); } catch {}
        await new Promise(r => setTimeout(r, 800));
        spawnProc("node", [path.join(OPENCLAW_DIR, "crew-lead.mjs")], {
          cwd: OPENCLAW_DIR, detached: true, stdio: "ignore",
        }).unref();
      } else if (id === "opencode") {
        try { execSync(`pkill -f "opencode serve"`, { stdio: "ignore" }); } catch {}
        await new Promise(r => setTimeout(r, 1200));
        try {
          // Prefer explicit binary so we don't rely on PATH in Node's env
          const pathEnv = (process.env.PATH || "") + path.delimiter + path.join(os.homedir(), "bin");
          let opencodeBin = "";
          try { opencodeBin = execSync("which opencode", { encoding: "utf8", env: { ...process.env, PATH: pathEnv } }).trim(); } catch {}
          if (!opencodeBin) opencodeBin = "/usr/local/bin/opencode";
          if (opencodeBin && fs.existsSync(opencodeBin)) {
            spawnProc(opencodeBin, ["serve", "--port", "4096", "--hostname", "127.0.0.1"], {
              detached: true, stdio: "ignore", env: process.env,
            }).unref();
          } else {
            spawnProc("opencode", ["serve", "--port", "4096", "--hostname", "127.0.0.1"], {
              detached: true, stdio: "ignore", env: process.env, shell: true,
            }).unref();
          }
        } catch (openCodeErr) {
          console.error("[dashboard] OpenCode start failed:", openCodeErr?.message || openCodeErr);
        }
      } else if (id === "openclaw-gateway") {
        // Kill legacy gateway then reopen the OpenClaw app (it auto-respawns the gateway)
        try { execSync(`pkill -f "openclaw-gateway"`, { stdio: "ignore" }); } catch {}
        await new Promise(r => setTimeout(r, 1000));
        if (process.platform === "darwin") {
          try { execSync(`open -a OpenClaw`, { stdio: "ignore" }); } catch {}
        }
      } else if (id === "dashboard") {
        // Restart dashboard: spawn a new process then exit this one
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, message: "Restarting dashboard..." }));
        await new Promise(r => setTimeout(r, 300));
        spawnProc("node", [path.join(OPENCLAW_DIR, "scripts", "dashboard.mjs")], {
          cwd: OPENCLAW_DIR, detached: true, stdio: "ignore",
        }).unref();
        process.exit(0);
        return;
      } else if (id === "telegram") {
        // Restart already handled above — if we reach here it means no token was found
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: "Telegram not restarted — no token in ~/.crewswarm/telegram-bridge.json. Configure via Settings → Telegram." }));
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/api/services/stop" && req.method === "POST") {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const { id } = JSON.parse(raw || "{}");
      const { execSync } = await import("node:child_process");

      if (id === "agents") {
        try { execSync(`pkill -f "gateway-bridge.mjs --rt-daemon"`, { stdio: "ignore" }); } catch {}
      } else if (id === "telegram") {
        try {
          const pid = parseInt(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "logs", "telegram-bridge.pid"), "utf8").trim(), 10);
          if (pid) process.kill(pid, "SIGTERM");
        } catch {}
      } else if (id === "crew-lead") {
        try { execSync(`pkill -f "crew-lead.mjs"`, { stdio: "ignore" }); } catch {}
      } else if (id === "rt-bus") {
        try { execSync(`pkill -f "opencrew-rt-daemon"`, { stdio: "ignore" }); } catch {}
      } else if (id === "openclaw-gateway") {
        try { execSync(`pkill -f "openclaw-gateway"`, { stdio: "ignore" }); } catch {}
        await new Promise(r => setTimeout(r, 1000));
        try { execSync(`open -a OpenClaw`, { stdio: "ignore" }); } catch {}
      } else if (id === "opencode") {
        try { execSync(`pkill -f "opencode serve"`, { stdio: "ignore" }); } catch {}
      } else if (id === "dashboard") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, message: "Restarting dashboard..." }));
        await new Promise(r => setTimeout(r, 300));
        const { spawn: sp } = await import("node:child_process");
        sp("node", [path.join(OPENCLAW_DIR, "scripts", "dashboard.mjs")], {
          cwd: OPENCLAW_DIR, detached: true, stdio: "ignore",
        }).unref();
        process.exit(0);
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── Skills + Spending proxy → crew-lead:5010 ──────────────────────────────
    // These routes read the auth token and proxy to the crew-lead HTTP API so
    // the browser doesn't need to know the token.
    const CREW_LEAD_URL = "http://127.0.0.1:5010";
    function getCLToken() {
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "config.json"), "utf8"));
        return cfg?.rt?.authToken || "";
      } catch { return ""; }
    }
    async function proxyToCL(method, path_, body) {
      const token = getCLToken();
      const opts = { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(15000) };
      if (body) opts.body = body;
      const r = await fetch(CREW_LEAD_URL + path_, opts);
      const text = await r.text();
      return { status: r.status, body: text };
    }

    // ── ZeroEval / llm-stats benchmark API proxy ────────────────────────────────
    // Data from https://llm-stats.com (api.zeroeval.com) — SWE-Bench, LiveCodeBench, etc.
    const zeroevalBenchMatch = url.pathname.match(/^\/api\/zeroeval\/benchmarks(?:\/([a-zA-Z0-9_\-]+))?$/);
    if (zeroevalBenchMatch && req.method === "GET") {
      const benchmarkId = zeroevalBenchMatch[1];
      const zurl = benchmarkId
        ? `https://api.zeroeval.com/leaderboard/benchmarks/${benchmarkId}`
        : "https://api.zeroeval.com/leaderboard/benchmarks";
      try {
        const r = await fetch(zurl, { signal: AbortSignal.timeout(15000) });
        const text = await r.text();
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(text);
      } catch (err) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "ZeroEval API unreachable", detail: String(err?.message || err) }));
      }
      return;
    }

    // Proxy test webhook through dashboard (avoids browser needing token)
    const webhookProxyMatch = url.pathname.match(/^\/proxy-webhook\/([a-zA-Z0-9_\-]+)$/);
    if (webhookProxyMatch && req.method === "POST") {
      let body = ""; for await (const chunk of req) body += chunk;
      const { status, body: rb } = await proxyToCL("POST", `/webhook/${webhookProxyMatch[1]}`, body || "{}");
      res.writeHead(status, { "content-type": "application/json" });
      res.end(rb);
      return;
    }

    // Proxy health (single source for skills + agent tools) and agent restart
    if (url.pathname === "/api/health" && req.method === "GET") {
      const { status, body: rb } = await proxyToCL("GET", "/api/health", undefined);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(rb);
      return;
    }
    const agentRestartMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/restart$/);
    if (agentRestartMatch && req.method === "POST") {
      let body = ""; for await (const chunk of req) body += chunk;
      const { status, body: rb } = await proxyToCL("POST", url.pathname, body || undefined);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(rb);
      return;
    }

    const skillsMatch = url.pathname.match(/^\/api\/skills(\/.*)?$/);
    if (skillsMatch) {
      let body = ""; for await (const chunk of req) body += chunk;
      const { status, body: rb } = await proxyToCL(req.method, url.pathname + (url.search || ""), body || undefined);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(rb);
      return;
    }

    if (url.pathname.startsWith("/api/spending")) {
      let body = ""; for await (const chunk of req) body += chunk;
      const { status, body: rb } = await proxyToCL(req.method, url.pathname + (url.search || ""), body || undefined);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(rb);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(err?.message || err));
    }
  }
});

if (process.argv.includes("--print-html")) {
  process.stdout.write(html, (err) => process.exit(err ? 1 : 0));
} else {
let _dashPortRetries = 0;
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    if (_dashPortRetries < 5) {
      _dashPortRetries++;
      const wait = _dashPortRetries * 2000;
      console.error(`[dashboard] Port ${listenPort} in use — retry ${_dashPortRetries}/5 in ${wait/1000}s`);
      setTimeout(() => server.listen(listenPort, "127.0.0.1"), wait);
    } else {
      console.error(`[dashboard] Port ${listenPort} still in use after 5 retries — exiting`);
      process.exit(1);
    }
  } else {
    console.error("[dashboard] server error:", err.message);
    process.exit(1);
  }
});
server.listen(listenPort, "127.0.0.1", () => {
  console.log(`CrewSwarm Dashboard (with Build) at http://127.0.0.1:${listenPort}`);
});
}

process.on("uncaughtException", (err) => {
  if (err?.code === "EADDRINUSE") {
    // Already handled by server.on("error") — don't loop forever
    console.error(`[dashboard] EADDRINUSE on port ${listenPort} — exiting`);
    process.exit(1);
  }
  console.error("[dashboard] uncaughtException (kept alive):", err?.stack || err?.message || err);
});
process.on("unhandledRejection", (reason) => {
  const msg = reason?.message || String(reason);
  if (msg === "terminated" || msg === "aborted") return; // SSE/fetch aborted when client disconnects
  console.error("[dashboard] unhandledRejection (kept alive):", msg);
});
