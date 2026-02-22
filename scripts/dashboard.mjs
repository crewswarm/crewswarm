#!/usr/bin/env node
/**
 * CrewSwarm Dashboard with Build UI (RT Messages, Send, DLQ, Build).
 * Run from OpenClaw so the Build button is included.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPENCLAW_DIR = process.env.OPENCLAW_DIR || path.resolve(__dirname, "..");
// Config dir: override with OPENCREWHQ_CONFIG_DIR env var to fully decouple from ~/.openclaw
const CFG_DIR = process.env.OPENCREWHQ_CONFIG_DIR || path.join(os.homedir(), ".openclaw");
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
const ctlPath = process.env.HOME + "/bin/openswitchctl";
const rtEventsLog = path.join(CFG_DIR, "workspace/shared-memory/claw-swarm/opencrew-rt/events.jsonl");
const dlqDir = path.join(CFG_DIR, "workspace/shared-memory/claw-swarm/opencrew-rt/dlq");
const phasedDispatchLog = path.join(OPENCLAW_DIR, "orchestrator-logs", "phased-dispatch.jsonl");

const authHeader = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

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

  // 2. All agents defined in openclaw.json (online or not) — shown with [offline] indicator handled client-side
  try {
    const cfgPath = path.join(CFG_DIR, "openclaw.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const raw = Array.isArray(cfg.agents) ? cfg.agents
              : Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
    raw.forEach(a => {
      const rtName = a.id.startsWith("crew-") ? a.id : "crew-" + a.id;
      merged.add(rtName);
    });
  } catch {}

  // 3. Hard fallback if both fail
  if (!merged.size) {
    ["crew-main","crew-pm","crew-qa","crew-fixer","crew-coder","crew-coder-2","crew-coder-front","crew-coder-back","crew-github","security"]
      .forEach(a => merged.add(a));
  }

  return [...merged];
}

async function getRecentRTMessages(limit = 50) {
  const { readFile } = await import("node:fs/promises");
  try {
    const content = await readFile(rtEventsLog, "utf8");
    const lines = content.trim().split("\n").filter(Boolean).slice(-limit);
    return lines.map((line) => {
      try {
        const obj = JSON.parse(line);
        return obj.envelope || obj;
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
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
    .msg.u { border-left: 3px solid var(--accent); }
    .msg.a { border-left: 3px solid var(--green); }
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
    .btn-red    { background: var(--red); color: #fff; }
    .btn-yellow { background: var(--yellow); color: #000; }
    .btn-purple { background: var(--accent2); color: #fff; }
    .btn-muted  { background: var(--bg-card2); color: var(--text-2); border: 1px solid var(--border); }
    .reply-btn  { font-size: 11px; padding: 3px 8px; background: var(--accent2); color: #fff; margin-left: 8px; }
    .replay-btn { font-size: 11px; padding: 3px 8px; background: var(--yellow); color: #000; margin-left: 8px; }
    .send-btn   { background: var(--green); color: #000; }
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
    select, input[type="text"], input[type="password"], textarea {
      background: var(--bg-card2); color: var(--text); border: 1px solid var(--border);
      border-radius: 7px; padding: 8px 12px; font-size: 13px; font-family: inherit;
      outline: none; transition: border-color 0.12s;
    }
    select:focus, input:focus, textarea:focus { border-color: var(--accent); }
    input[type="text"] { flex: 1; }
    textarea { resize: vertical; width: 100%; }
    input, textarea, select { user-select: text; -webkit-user-select: text; cursor: text; }

    /* ── Notification ── */
    .notification { position: fixed; top: 20px; right: 20px; background: var(--green); color: #000; padding: 12px 20px; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.4); z-index: 1000; animation: slideIn 0.25s ease; font-weight: 600; font-size: 13px; }
    .notification.error { background: var(--red); color: #fff; }
    @keyframes slideIn { from { transform: translateX(120%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

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
      <button class="nav-item active" id="navSwarm" onclick="showSwarm()">
        <span class="nav-icon">💬</span> Sessions
      </button>
      <button class="nav-item" id="navRT" onclick="showRT()">
        <span class="nav-icon">📡</span> RT Messages
      </button>
      <button class="nav-item" id="navBuild" onclick="showBuild()">
        <span class="nav-icon">🔨</span> Build
      </button>
      <button class="nav-item" id="navDLQ" onclick="showDLQ()">
        <span class="nav-icon">⚠️</span> DLQ
        <span class="nav-badge hidden" id="dlqBadge">0</span>
      </button>
      <button class="nav-item" id="navFiles" onclick="showFiles()">
        <span class="nav-icon">📂</span> Files
      </button>
      <button class="nav-item" id="navMessaging" onclick="showMessaging()">
        <span class="nav-icon">💬</span> Messaging
        <span class="nav-badge hidden" id="msgBadge">0</span>
      </button>
      <button class="nav-item" id="navServices" onclick="showServices()">
        <span class="nav-icon">🔧</span> Services
        <span class="nav-badge hidden" id="servicesBadge">!</span>
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
      <button class="nav-item" id="navProviders" onclick="showProviders()">
        <span class="nav-icon">⚙️</span> Providers
      </button>
    </div>

    <div class="sidebar-bottom">
      <div class="meta" style="padding:4px 2px;">v1.0 · <a href="http://localhost:4319" style="color:var(--accent); text-decoration:none;">localhost:4319</a></div>
    </div>
  </nav>

  <!-- ── Main content ── -->
  <div class="main-wrap">

    <!-- Sessions view -->
    <div class="view-sessions active" id="sessionsView">
      <section id="sessions"></section>
      <section id="messages"></section>
    </div>

    <!-- RT Messages -->
    <div class="view" id="rtView">
      <div class="page-header">
        <div><div class="page-title">RT Messages</div><div class="page-sub">Live feed from CrewSwarm RT message bus</div></div>
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
          <input id="filesDir" placeholder="/path/to/project" style="width:280px;" value="${process.env.HOME}/Desktop/OpenClaw" />
          <button onclick="loadFiles()" class="btn-green">Scan</button>
          <button onclick="loadFiles(true)" class="btn-ghost" style="font-size:12px;">↻</button>
        </div>
      </div>
      <div id="filesContent"></div>
    </div>

    <!-- Messaging -->
    <div class="view" id="messagingView">
      <div class="page-header">
        <div><div class="page-title">Messaging</div><div class="page-sub">Telegram → crew-main → reply. Native bridge, no OpenClaw needed.</div></div>
        <div style="display:flex;gap:8px;align-items:center;">
          <span id="tgStatusBadge" class="status-badge status-stopped">● stopped</span>
          <button onclick="startTgBridge()" class="btn-green" id="tgStartBtn">▶ Start</button>
          <button onclick="stopTgBridge()" class="btn-red" id="tgStopBtn">⏹ Stop</button>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:340px 1fr;gap:16px;padding:16px;">
        <!-- Config card -->
        <div class="card" style="align-self:start;">
          <div class="card-title" style="margin-bottom:12px;">⚙️ Configuration</div>
          <label style="display:block;margin-bottom:6px;font-size:12px;color:var(--text-2);">Telegram Bot Token</label>
          <input id="tgTokenInput" type="password" placeholder="123456:ABCdef..." style="width:100%;margin-bottom:12px;" />
          <label style="display:block;margin-bottom:6px;font-size:12px;color:var(--text-2);">Route to agent</label>
          <select id="tgTargetAgent" style="width:100%;margin-bottom:12px;">
            <option value="crew-main">crew-main (Quill — recommended)</option>
            <option value="crew-pm">crew-pm (Planning only)</option>
            <option value="crew-coder">crew-coder (Code only)</option>
          </select>
          <label style="display:block;margin-bottom:6px;font-size:12px;color:var(--text-2);">Allowed chat IDs <span style="color:var(--text-3);font-weight:400;">(comma-separated — leave empty to allow all)</span></label>
          <input id="tgAllowedIds" placeholder="1693963111, 987654321" style="width:100%;margin-bottom:12px;" />
          <button onclick="saveTgConfig()" class="btn-green" style="width:100%;margin-bottom:8px;">Save config</button>
          <div style="font-size:11px;color:var(--text-3);line-height:1.5;">
            Get a token from <a href="https://t.me/BotFather" target="_blank" style="color:var(--accent);">@BotFather</a> on Telegram.<br/>
            The bridge connects as <code>crew-telegram</code> on the RT bus.<br/>
            Find your chat ID by messaging <a href="https://t.me/userinfobot" target="_blank" style="color:var(--accent);">@userinfobot</a>.
          </div>
        </div>
        <!-- Message feed -->
        <div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <div style="font-size:13px;font-weight:600;">Message feed</div>
            <button onclick="loadTgMessages()" class="btn-ghost" style="font-size:12px;">↻ Refresh</button>
          </div>
          <div id="tgMessageFeed" style="display:flex;flex-direction:column;gap:8px;max-height:calc(100vh - 220px);overflow-y:auto;"></div>
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
          <input id="npOutputDir"   placeholder="Output directory (e.g. /path/to/project)" />
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
    <div class="view" id="providersView">
      <div class="page-header">
        <div><div class="page-title">Providers &amp; API Keys</div><div class="page-sub">Keys saved to <code style="font-size:11px; color:var(--text-2);">~/.crewswarm/config.json</code></div></div>
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
            <div style="font-size:12px; color:var(--text-2);">Required — matches the token used to start <code>opencrew-rt-daemon.mjs</code> (env: <code>OPENCREW_RT_AUTH_TOKEN</code>)</div>
          </div>
          <span id="rtTokenBadge" style="margin-left:auto; font-size:11px; padding:2px 8px; border-radius:999px; font-weight:600; background:rgba(251,191,36,0.15); color:#fbbf24; border:1px solid rgba(251,191,36,0.3);">not set</span>
        </div>
        <div style="display:flex; gap:8px;">
          <input id="rtTokenInput" type="password" placeholder="Paste your OPENCREW_RT_AUTH_TOKEN here" style="flex:1;" />
          <button onclick="saveRTToken()" class="btn-purple">Save</button>
          <button onclick="document.getElementById('rtTokenInput').type = document.getElementById('rtTokenInput').type === 'password' ? 'text' : 'password'" class="btn-ghost" title="Show/hide">👁</button>
        </div>
      </div>

      <div id="addProviderForm" style="display:none;" class="card">
        <h3>Add Custom Provider</h3>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:12px;">
          <input id="apId"      placeholder="Provider ID (e.g. together)" />
          <input id="apBaseUrl" placeholder="Base URL (e.g. https://api.together.xyz/v1)" />
          <input id="apKey"     placeholder="API Key" type="password" />
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
      <div id="providersList"></div>
    </div>

    <!-- Agents -->
    <div class="view" id="agentsView">
      <div class="page-header">
        <div><div class="page-title">Agents</div><div class="page-sub">Assign models, edit system prompts, spin up new crew members</div></div>
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
            <div style="flex:0 0 80px;">
              <div class="field-label">Emoji</div>
              <input id="naEmoji" placeholder="🔥" />
            </div>
          </div>
        </div>
        <div style="margin-bottom:10px;">
          <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px;">
            <div class="field-label" style="margin:0;">System Prompt</div>
            <select id="naPromptPreset" style="font-size:12px; padding:3px 8px;" onchange="applyPromptPreset()">
              <option value="">— quick presets —</option>
              <option value="frontend">🎨 Frontend specialist (HTML/CSS/JS)</option>
              <option value="backend">⚙️ Backend specialist (Node/API/scripts)</option>
              <option value="fullstack">🧱 Full-stack coder</option>
              <option value="qa">🧪 QA / tester</option>
              <option value="github">🐙 Git & GitHub ops</option>
              <option value="writer">✍️ Content / copywriter</option>
            </select>
          </div>
          <textarea id="naPrompt" rows="5" placeholder="Describe what this agent specialises in. It will be shown at the top of every task."></textarea>
        </div>
        <div style="margin-bottom:14px;">
          <div class="field-label" style="margin-bottom:6px;">Tool Profile <span class="meta" style="text-transform:none; font-weight:400;">— controls what the agent can touch</span></div>
          <div style="display:grid; grid-template-columns:repeat(4,1fr); gap:8px;" id="naToolsGrid">
            <label class="tool-profile-opt" data-val="coding">
              <input type="radio" name="naToolProfile" value="coding" checked />
              <div class="tp-card">
                <div class="tp-name">coding</div>
                <div class="tp-desc">Read, write, edit files + exec shell. Default for all coders.</div>
              </div>
            </label>
            <label class="tool-profile-opt" data-val="full">
              <input type="radio" name="naToolProfile" value="full" />
              <div class="tp-card">
                <div class="tp-name">full</div>
                <div class="tp-desc">All tools enabled — browser, memory, spawn sessions, image gen.</div>
              </div>
            </label>
            <label class="tool-profile-opt" data-val="messaging">
              <input type="radio" name="naToolProfile" value="messaging" />
              <div class="tp-card">
                <div class="tp-name">messaging</div>
                <div class="tp-desc">Send messages between agents only — no file access. Good for PM/orchestrator agents.</div>
              </div>
            </label>
            <label class="tool-profile-opt" data-val="minimal">
              <input type="radio" name="naToolProfile" value="minimal" />
              <div class="tp-card">
                <div class="tp-name">minimal</div>
                <div class="tp-desc">Read + web search only. Lightweight, lowest cost.</div>
              </div>
            </label>
          </div>
        </div>
        <div style="display:flex; gap:8px;">
          <button id="naCreateBtn" class="btn-green">Create Agent</button>
          <button id="naCancelBtn" class="btn-ghost">Cancel</button>
        </div>
      </div>

      <div id="agentsList" style="display:grid; gap:12px;"></div>
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
          <h3>Phased Progress</h3>
          <p class="meta" style="margin-bottom:10px;">Live task dispatch log</p>
          <div id="phasedProgress" class="log-block mono" style="max-height:180px;"></div>
        </div>

        <hr class="divider" />

        <div class="card">
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px; flex-wrap:wrap;">
            <h3 style="margin:0;">PM Loop</h3>
            <span class="pm-badge" id="pmLoopBadge">idle</span>
          </div>
          <div id="pmLoopProjectLabel" style="font-size:12px; color:var(--text-2); margin-bottom:8px; padding:6px 10px; background:var(--bg-2); border-radius:6px; border-left:3px solid var(--accent);">
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

    <!-- ── Message bar ── -->
    <div class="msg-bar">
      <select id="agentSelect">
        <option value="broadcast">📢 Broadcast</option>
      </select>
      <input id="messageInput" type="text" placeholder="Send a message to an agent…" />
      <button id="sendBtn" class="send-btn">Send</button>
    </div>
  </div>
<script>
let selected = null;
let agents = [];
async function loadAgents() {
  try {
    agents = await getJSON('/api/agents');
    const select = document.getElementById('agentSelect');
    const currentValue = select.value;
    select.innerHTML = '<option value="broadcast">📢 Broadcast (all agents)</option>';
    agents.forEach(a => { const o = document.createElement('option'); o.value = a; o.textContent = a; select.appendChild(o); });
    if (currentValue && agents.includes(currentValue)) select.value = currentValue;
  } catch (e) { console.error('Failed to load agents:', e); }
}
async function getJSON(p){ const r = await fetch(p); if(!r.ok) throw new Error(await r.text()); return r.json(); }
async function postJSON(p, body){ const r = await fetch(p, { method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body) }); if(!r.ok) throw new Error(await r.text()); return r.json(); }
function showNotification(msg, isError){ const d = document.createElement('div'); d.className = 'notification' + (isError ? ' error' : ''); d.textContent = msg; document.body.appendChild(d); setTimeout(() => d.remove(), 3000); }
function fmt(ts){ try { return new Date(ts).toLocaleTimeString(); } catch { return String(ts); } }
function createdAt(info){ return (info && info.time && info.time.created) || ''; }
async function loadSessions(){
  try {
    const data = await getJSON('/api/sessions');
    const box = document.getElementById('sessions');
    box.innerHTML = '';
    if (!data.length) { box.innerHTML = '<div class="meta" style="padding:20px;">Sessions from OpenCode server (4096).</div>'; return; }
    if (!selected && data[0]) selected = data[0].id;
    data.forEach(s => {
      const div = document.createElement('div');
      div.className = 'row' + (s.id === selected ? ' active' : '');
      div.onclick = () => { selected = s.id; refreshAll(); };
      div.innerHTML = '<div><strong>' + (s.title || s.slug || s.id) + '</strong></div><div class="meta">' + (s.directory || '-') + '</div>';
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
  const data = await getJSON('/api/rt-messages');
  box.innerHTML = '';
  data.forEach(m => {
    if (m.type === 'agent.heartbeat') return;
    const payload = m.payload || {};
    let messageText = payload.reply || payload.prompt || payload.message || (payload.action === 'run_task' && payload.prompt ? payload.prompt : '');
    if (!messageText || messageText === 'run_task') return;
    const div = document.createElement('div');
    div.className = 'msg ' + (m.from && (m.from.includes('main') || m.from === 'orchestrator') ? 'u' : 'a');
    div.innerHTML = '<div class="meta"><strong>' + (m.from || '?') + '</strong> → <strong>' + (m.to || '?') + '</strong> | ' + (m.ts ? new Date(m.ts).toLocaleTimeString() : '') + '</div><div class="t">' + messageText + '</div>';
    box.appendChild(div);
  });
  if (!box.children.length) box.innerHTML = '<div class="meta" style="padding:20px; text-align:center;">No messages yet. Send one below!</div>';
  box.scrollTop = box.scrollHeight;
}
async function loadDLQ(){
  const data = await getJSON('/api/dlq');
  const dlqBadgeEl = document.getElementById('dlqBadge');
  if (dlqBadgeEl) { dlqBadgeEl.textContent = data.length; dlqBadgeEl.classList.toggle('hidden', !data.length); }
  const box = document.getElementById('dlqMessages');
  box.innerHTML = data.length ? data.map(entry => {
    const key = entry.key || (entry.filename || '').replace('.json', '') || '?';
    return '<div class="msg dlq-item"><div class="meta"><strong>⚠️ Failed</strong> | ' + (entry.agent || '?') + ' | ' + (entry.failedAt ? new Date(entry.failedAt).toLocaleString() : '') + ' <button class="replay-btn" onclick="replayDLQ(\\'' + key + '\\')">Replay</button></div><div class="t">' + (entry.error || '') + '</div></div>';
  }).join('') : '<div class="meta" style="padding:20px; text-align:center;">✓ DLQ empty</div>';
}
window.replayDLQ = async function(key){ if(!confirm('Replay?')) return; await postJSON('/api/dlq/replay', { key }); showNotification('Replayed'); loadDLQ(); };
async function sendMessage(){
  const input = document.getElementById('messageInput');
  const msg = input.value.trim();
  const to = document.getElementById('agentSelect').value;
  if (!msg) return;
  try { input.disabled = true; await postJSON('/api/send', { to, message: msg }); showNotification('Sent to ' + to); input.value = ''; } catch (e) { showNotification('Failed: ' + e.message, true); } finally { input.disabled = false; input.focus(); }
}
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

function showMessaging(){
  hideAllViews();
  document.getElementById('messagingView').classList.add('active');
  setNavActive('navMessaging');
  loadTgStatus();
  loadTgMessages();
  loadTgConfig();
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
    if (d.targetAgent) document.getElementById('tgTargetAgent').value = d.targetAgent;
    if (d.allowedChatIds && d.allowedChatIds.length) {
      document.getElementById('tgAllowedIds').value = d.allowedChatIds.join(', ');
    }
  } catch {}
}

async function saveTgConfig(){
  const token = document.getElementById('tgTokenInput').value.trim();
  const targetAgent = document.getElementById('tgTargetAgent').value;
  const idsRaw = document.getElementById('tgAllowedIds').value.trim();
  const allowedChatIds = idsRaw
    ? idsRaw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
    : [];
  if (!token) { showNotification('Enter a bot token first', true); return; }
  await postJSON('/api/telegram/config', { token, targetAgent, allowedChatIds });
  showNotification('Config saved');
}

async function startTgBridge(){
  const token = document.getElementById('tgTokenInput').value.trim();
  const targetAgent = document.getElementById('tgTargetAgent').value;
  // Pass token only if entered — API will fall back to saved config if omitted
  const body = targetAgent ? { targetAgent } : {};
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
          (canRestart && up   ? '<button class="btn-ghost" style="font-size:12px;" onclick="restartService(\\'' + svc.id + '\\')">↻ Restart</button>' : '') +
          (canRestart && !up  ? '<button class="btn-green" style="font-size:12px;" onclick="restartService(\\'' + svc.id + '\\')">▶ Start</button>' : '') +
          (canRestart && up   ? '<button class="btn-red" style="font-size:12px;" onclick="stopService(\\'' + svc.id + '\\')">⏹ Stop</button>' : '') +
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
  await postJSON('/api/services/restart', { id });
  showNotification('Restarting ' + id + '...');
  setTimeout(loadServices, 3000);
}

async function stopService(id){
  await postJSON('/api/services/stop', { id });
  showNotification('Stopping ' + id + '...');
  setTimeout(loadServices, 1500);
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
  const dir = document.getElementById('filesDir').value.trim() || '${process.env.HOME}/Desktop/OpenClaw';
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
function showProviders(){
  hideAllViews();
  document.getElementById('providersView').classList.add('active');
  setNavActive('navProviders');
  loadProviders();
  loadRTToken();
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
function showAgents(){
  hideAllViews();
  document.getElementById('agentsView').classList.add('active');
  setNavActive('navAgents');
  loadAgents_cfg();
}

// ── Agents UI ──────────────────────────────────────────────────────────────
let _allModels = [];
let _modelsByProvider = {};  // { "cerebras": ["llama3.1-8b", ...], ... }

async function loadAgents_cfg(){
  const list = document.getElementById('agentsList');
  list.innerHTML = '<div class="meta" style="padding:20px;">Loading agents…</div>';
  try {
    const data = await getJSON('/api/agents-config');
    _allModels = data.allModels || [];
    _modelsByProvider = data.modelsByProvider || {};
    const agents = data.agents || [];
    if (!agents.length){ list.innerHTML = '<div class="meta" style="padding:20px;">No agents found in config. Check ' + '${CFG_DIR}/openclaw.json' + '</div>'; return; }
    list.innerHTML = '';
    agents.forEach(a => {
      const card = document.createElement('div');
      card.className = 'agent-card';
      card.id = 'agent-card-' + a.id;
      const modelOpts = _allModels.map(m => \`<option value="\${m}" \${m === a.model ? 'selected' : ''}>\${m}</option>\`).join('');
      const customOpt = (!a.model || _allModels.includes(a.model)) ? '' : \`<option value="\${a.model}" selected>\${a.model} (custom)</option>\`;
      card.innerHTML = \`
        <div class="agent-card-header">
          <div class="agent-avatar">\${a.emoji}</div>
          <div class="agent-meta">
            <div class="agent-id">\${a.id} <span class="meta" style="font-weight:400;">· \${a.name}</span></div>
            <div class="agent-model" id="cur-model-\${a.id}">\${a.model}</div>
          </div>
          <button class="btn-ghost" style="font-size:11px; padding:4px 10px;" onclick="toggleAgentBody('\${a.id}')">Edit ▾</button>
          <button class="btn-ghost" style="font-size:11px; padding:4px 10px; color:var(--red); border-color:rgba(248,113,113,0.3);" onclick="deleteAgent('\${a.id}')">✕</button>
        </div>
        <div class="agent-body" id="body-\${a.id}" style="display:none;">
          <div>
            <div class="field-label">Model</div>
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
              <select id="model-\${a.id}" style="flex:1; min-width:200px;" onchange="syncModelText('\${a.id}')">\${customOpt}\${modelOpts}</select>
              <input id="modeltext-\${a.id}" type="text" placeholder="or type any model…" value="\${a.model || ''}" style="flex:1; min-width:160px; font-size:12px;" oninput="syncModelSelect('\${a.id}')" />
              <button onclick="saveAgentModel('\${a.id}')" class="btn-green" style="white-space:nowrap;">Save model</button>
            </div>
          </div>
          <div>
            <div class="field-label">Display name &amp; emoji</div>
            <div style="display:flex; gap:8px;">
              <input id="aname-\${a.id}" type="text" value="\${a.name}" placeholder="Display name" style="flex:1;" />
              <input id="aemoji-\${a.id}" type="text" value="\${a.emoji}" placeholder="🤖" style="width:70px;" />
              <button onclick="saveAgentIdentity('\${a.id}')" class="btn-ghost">Save</button>
            </div>
          </div>
          <div>
            <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px;">
              <div class="field-label" style="margin:0;">System Prompt</div>
              \${!a.systemPrompt ? '<span style="font-size:11px; color:var(--yellow);">⚠ No prompt set — agent has no role context</span>' : ''}
              <select style="font-size:11px; padding:3px 8px; margin-left:auto;" onchange="applyAgentPromptPreset('\${a.id}', this.value); this.value=''">
                <option value="">Presets…</option>
                <option value="frontend">🎨 Frontend</option>
                <option value="backend">⚙️ Backend</option>
                <option value="fullstack">🧱 Full-stack</option>
                <option value="qa">🧪 QA</option>
                <option value="github">🐙 GitHub ops</option>
                <option value="writer">✍️ Writer</option>
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
            <div class="field-label">Tool Profile</div>
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:12px;">
              <select id="profile-\${a.id}" style="flex:1; min-width:180px;">
                <option value="coding" \${a.toolProfile==='coding'?'selected':''}>coding — file r/w, exec, web, browser</option>
                <option value="full" \${a.toolProfile==='full'?'selected':''}>full — everything including messaging</option>
                <option value="minimal" \${a.toolProfile==='minimal'?'selected':''}>minimal — read/write only</option>
                <option value="messaging" \${a.toolProfile==='messaging'?'selected':''}>messaging — comms channels only</option>
                <option value="default" \${a.toolProfile==='default'?'selected':''}>default — OpenClaw defaults</option>
              </select>
              <button onclick="saveAgentProfile('\${a.id}')" class="btn-ghost">Save profile</button>
            </div>
            <div class="field-label">Also Allow (extra tools)</div>
            <div id="tools-\${a.id}" style="display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:6px; margin-bottom:10px;">
              \${['web_search','web_fetch','browser','exec','process','read','write','edit','apply_patch','canvas','message','cron','gateway','nodes','agents_list','computer'].map(t => \`
                <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:var(--text-2); cursor:pointer;">
                  <input type="checkbox" data-tool="\${t}" \${(a.alsoAllow||[]).includes(t)?'checked':''} style="accent-color:var(--accent);" />
                  <code style="font-size:11px;">\${t}</code>
                </label>
              \`).join('')}
            </div>
            <button onclick="saveAgentTools('\${a.id}')" class="btn-ghost" style="font-size:12px;">Save tools</button>
            <div class="meta" style="margin-top:10px;">Workspace: <code style="font-size:11px;">\${a.workspace}</code></div>
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
async function resetAgentSession(agentId){
  if (!confirm('Reset context window for ' + agentId + '?\n\nThis clears the accumulated conversation history in OpenClaw. Shared memory files will be re-injected on the next task.')) return;
  showNotification('Resetting ' + agentId + ' session...');
  try {
    await postJSON('/api/agents-config/reset-session', { agentId });
    showNotification(agentId + ' session reset');
  } catch(e) {
    showNotification('Reset failed: ' + e.message, true);
  }
}

async function saveAgentModel(agentId){
  const txt = document.getElementById('modeltext-' + agentId);
  const sel = document.getElementById('model-' + agentId);
  const model = (txt && txt.value.trim()) || (sel && sel.value) || '';
  if (!model){ showNotification('Select or type a model', true); return; }
  try {
    await postJSON('/api/agents-config/update', { agentId, model });
    document.getElementById('cur-model-' + agentId).textContent = model;
    showNotification(\`\${agentId} → \${model}\`);
  } catch(e){ showNotification('Failed: ' + e.message, true); }
}

async function saveAgentIdentity(agentId){
  const name  = document.getElementById('aname-' + agentId).value.trim();
  const emoji = document.getElementById('aemoji-' + agentId).value.trim();
  try {
    await postJSON('/api/agents-config/update', { agentId, name, emoji });
    showNotification('Identity saved for ' + agentId);
  } catch(e){ showNotification('Failed: ' + e.message, true); }
}

window.applyAgentPromptPreset = function(agentId, preset) {
  if (!preset || !PROMPT_PRESETS[preset]) return;
  const ta = document.getElementById('prompt-' + agentId);
  if (ta) ta.value = PROMPT_PRESETS[preset];
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

async function saveAgentProfile(agentId){
  const profile = document.getElementById('profile-' + agentId).value;
  try {
    await postJSON('/api/agents-config/update', { agentId, toolProfile: profile });
    showNotification('Tool profile updated for ' + agentId);
  } catch(e){ showNotification('Failed: ' + e.message, true); }
}

async function saveAgentTools(agentId){
  const container = document.getElementById('tools-' + agentId);
  const checked = [...container.querySelectorAll('input[type=checkbox]:checked')].map(el => el.dataset.tool);
  try {
    await postJSON('/api/agents-config/update', { agentId, alsoAllow: checked });
    showNotification('Tools saved for ' + agentId);
  } catch(e){ showNotification('Failed: ' + e.message, true); }
}

const PROMPT_PRESETS = {
  frontend: \`You are a frontend specialist. You write HTML, CSS, and vanilla JavaScript.
- ALWAYS read the existing file before editing
- NEVER replace or recreate files — only append, insert, or patch
- Produce clean, modern, accessible markup and styles
- Match the existing design system and CSS class names\`,
  backend: \`You are a backend specialist. You write Node.js, APIs, and server-side scripts.
- ALWAYS read existing files before editing
- NEVER replace existing files — only append or patch
- Follow existing patterns, naming conventions, and code style
- Prefer ES modules (import/export) and async/await\`,
  fullstack: \`You are a full-stack coder. You work across HTML, CSS, JavaScript, and Node.js.
- ALWAYS read the existing file first
- NEVER replace or recreate files — patch only
- Keep changes minimal and targeted to the requested task
- Match the existing code style and structure\`,
  qa: \`You are a QA and testing specialist. You write tests, find bugs, and verify implementations.
- Check that features match their requirements
- Write clear, runnable test cases
- Report failures with file path, line number, and expected vs actual output
- Do NOT fix bugs yourself — report them clearly so crew-fixer can address them\`,
  github: \`You are a Git and GitHub specialist. You handle all version control operations.
- Always run git status before acting
- Write clear, conventional commit messages (feat:, fix:, chore:, docs:)
- Never force-push to main or master
- Use the exec tool to run git and gh CLI commands\`,
  writer: \`You are a content and copywriting specialist. You write marketing copy, docs, and UI text.
- Write in a clear, confident, and friendly tone
- Match the voice and style of existing content
- Keep copy concise — fewer words, more impact
- Always read existing content before writing new sections\`,
};

window.applyPromptPreset = function() {
  const val = document.getElementById('naPromptPreset').value;
  if (val && PROMPT_PRESETS[val]) {
    document.getElementById('naPrompt').value = PROMPT_PRESETS[val];
  }
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
        const opt = document.createElement('option');
        opt.value = full;
        opt.textContent = name ? (name + '  (' + id + ')') : full;
        if (full === currentVal) opt.selected = true;
        grp.appendChild(opt);
      });
      sel.appendChild(grp);
    }
  } else {
    _allModels.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m; opt.textContent = m;
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
};
document.getElementById('naCancelBtn').onclick = () => {
  document.getElementById('newAgentForm').style.display = 'none';
};
document.getElementById('naCreateBtn').onclick = async () => {
  const id          = document.getElementById('naId').value.trim();
  const model       = document.getElementById('naModel').value.trim();
  const name        = document.getElementById('naName').value.trim();
  const emoji       = document.getElementById('naEmoji').value.trim();
  const systemPrompt = document.getElementById('naPrompt').value.trim();
  const toolProfile  = document.querySelector('input[name="naToolProfile"]:checked')?.value || 'coding';
  if (!id || !model){ showNotification('Agent ID and model are required', true); return; }
  try {
    await postJSON('/api/agents-config/create', { id, model, name, emoji, systemPrompt, toolProfile });
    showNotification(\`Agent "\${id}" created — restart gateway-bridge to activate it on the RT bus.\`);
    document.getElementById('newAgentForm').style.display = 'none';
    ['naId','naName','naEmoji','naPrompt'].forEach(x => { document.getElementById(x).value = ''; });
    document.getElementById('naModel').innerHTML = '<option value="">— select a model —</option>';
    document.getElementById('naPromptPreset').value = '';
    loadAgents_cfg();
  } catch(e){ showNotification('Failed: ' + e.message, true); }
};
document.getElementById('refreshAgentsBtn').onclick = loadAgents_cfg;
// ── End agents UI ──────────────────────────────────────────────────────────
const PROVIDER_ICONS = { opencode:'🚀', groq:'⚡', nvidia:'🎮', ollama:'🏠', xai:'𝕏', google:'🔵', deepseek:'🌊', openai:'🟢', perplexity:'🔍', cerebras:'🧠', mistral:'🌀', together:'🤝', cohere:'🔶', anthropic:'🟣' };
async function loadProviders(){
  const list = document.getElementById('providersList');
  list.innerHTML = '<div class="meta" style="padding:20px;">Loading providers...</div>';
  try {
    const data = await getJSON('/api/providers');
    const providers = data.providers || [];
    if (!providers.length){ list.innerHTML = '<div class="meta" style="padding:20px;">No providers found. Check ' + '${CFG_DIR}/openclaw.json' + '</div>'; return; }
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
            <input class="key-input" type="password" id="key_\${p.id}" value="\${p.maskedKey || ''}" placeholder="Paste API key…" />
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
  statusEl.textContent = '';
  try {
    const r = await postJSON('/api/providers/fetch-models', { providerId });
    if (r.ok) {
      const tags = document.getElementById('mtags_' + providerId);
      const count = document.getElementById('mcount_' + providerId);
      const none = document.getElementById('mnone_' + providerId);
      if (tags) tags.innerHTML = r.models.map(m => '<span class="model-tag">' + m + '</span>').join('');
      if (count) count.textContent = r.models.length;
      if (none) none.style.display = 'none';
      statusEl.textContent = '✓ ' + r.models.length + ' models';
      statusEl.className = 'test-ok';
      // Refresh agent model dropdowns
      loadAgents();
    } else {
      statusEl.textContent = '✗ ' + r.error;
      statusEl.className = 'test-err';
    }
  } catch(e){ statusEl.textContent = '✗ ' + e.message; statusEl.className = 'test-err'; }
  finally { btn.textContent = origText; btn.disabled = false; }
}
document.getElementById('addProviderBtn').onclick = () => {
  document.getElementById('addProviderForm').style.display = 'block';
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
    loadProviders();
  } catch(e){ showNotification('Failed: ' + e.message, true); }
};
document.getElementById('refreshProvidersBtn').onclick = loadProviders;
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
        +   retryBtn
        +   '<button data-action="delete" data-id="' + id + '" style="margin-left:auto;background:transparent;color:var(--text-3);border:1px solid var(--border);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;" title="Remove from dashboard (files stay on disk)">🗑 Delete</button>'
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
    case 'add-item':     addRoadmapItem(id); break;
    case 'skip-next':    skipNextItem(id); break;
    case 'reset-failed': resetAllFailed(id); break;
    case 'save-roadmap': saveRoadmap(id); break;
    case 'close-editor': closeRoadmapEditor(id); break;
  }
});

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
  try {
    const data = await getJSON('/api/phased-progress');
    if (!data.length) { box.textContent = 'No phased runs yet.'; return; }
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
document.getElementById('sendBtn').onclick = sendMessage;
document.getElementById('messageInput').onkeypress = e => { if (e.key === 'Enter') sendMessage(); };

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
if (params.get('to')) document.getElementById('agentSelect').value = params.get('to');
if (params.get('focus') === '1') setTimeout(() => document.getElementById('messageInput').focus(), 500);
loadAgents();
refreshAll();
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${listenPort}`);
  try {
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
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
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(await getPhasedProgress(limit)));
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
      const spawnArgs = [pmLoop, ...(dryRun ? ["--dry-run"] : []), ...(projectDir ? ["--project-dir", projectDir] : [])];
      const spawnEnv = {
        ...process.env,
        OPENCLAW_DIR,
        PHASED_TASK_TIMEOUT_MS: process.env.PHASED_TASK_TIMEOUT_MS || "300000",
        OPENCREW_RT_SEND_TIMEOUT_MS: process.env.OPENCREW_RT_SEND_TIMEOUT_MS || "300000",
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
    // ── Providers API ─────────────────────────────────────────────────────
    if (url.pathname === "/api/providers" && req.method === "GET") {
      const { readFile } = await import("node:fs/promises");
      const cfgPath = path.join(CFG_DIR, "openclaw.json");
      const cfg = JSON.parse(await readFile(cfgPath, "utf8").catch(() => "{}"));
      const providerMap = cfg?.models?.providers || {};
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
      const cfgPath = path.join(CFG_DIR, "openclaw.json");
      const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
      if (!cfg.models?.providers?.[providerId]) throw new Error("Provider not found: " + providerId);
      cfg.models.providers[providerId].apiKey = apiKey;
      await writeFile(cfgPath, JSON.stringify(cfg, null, 4), "utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/api/providers/add" && req.method === "POST") {
      const { readFile, writeFile } = await import("node:fs/promises");
      let body = ""; for await (const chunk of req) body += chunk;
      const { id, baseUrl, apiKey, api } = JSON.parse(body);
      if (!id || !baseUrl) throw new Error("id and baseUrl required");
      const cfgPath = path.join(CFG_DIR, "openclaw.json");
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
      const cfgPath = path.join(CFG_DIR, "openclaw.json");
      const cfg = JSON.parse(await readFile(cfgPath, "utf8").catch(() => "{}"));
      const provider = cfg?.models?.providers?.[providerId];
      if (!provider) throw new Error("Provider not found: " + providerId);
      const key = provider.apiKey;
      if (!key) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "No API key set" })); return; }
      const baseUrl = (provider.baseUrl || "").replace(/\/$/, "");
      try {
        const modelsRes = await fetch(`${baseUrl}/models`, {
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          signal: AbortSignal.timeout(12000),
        });
        if (!modelsRes.ok) {
          const txt = await modelsRes.text().catch(() => modelsRes.statusText);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: `${modelsRes.status}: ${txt.slice(0, 120)}` }));
          return;
        }
        const json = await modelsRes.json();
        const rawModels = json.data || json.models || [];
        const models = rawModels
          .filter(m => m.id || m.name)
          .map(m => ({ id: m.id || m.name, name: m.name || m.id }))
          .sort((a, b) => a.id.localeCompare(b.id));
        cfg.models.providers[providerId].models = models;
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
      const cfgPath = path.join(CFG_DIR, "openclaw.json");
      const cfg = JSON.parse(await readFile(cfgPath, "utf8").catch(() => "{}"));
      const provider = cfg?.models?.providers?.[providerId];
      if (!provider) throw new Error("Provider not found");
      const key = provider.apiKey;
      if (!key) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "No API key set" })); return; }
      const baseUrl = provider.baseUrl.replace(/\/$/, "");
      const firstModel = provider.models?.[0]?.id || "gpt-4o-mini";
      try {
        const testRes = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: firstModel, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
          signal: AbortSignal.timeout(10000),
        });
        if (testRes.ok || testRes.status === 400) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, model: firstModel, status: testRes.status }));
        } else {
          const errText = await testRes.text().catch(() => testRes.statusText);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: `${testRes.status}: ${errText.slice(0, 120)}` }));
        }
      } catch(e) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    // ── Agents API ──────────────────────────────────────────────────────────
    if (url.pathname === "/api/agents-config" && req.method === "GET") {
      const { readFile } = await import("node:fs/promises");
      const cfgPath = path.join(CFG_DIR, "openclaw.json");
      const promptsPath = path.join(CFG_DIR, "agent-prompts.json");
      const cfg = JSON.parse(await readFile(cfgPath, "utf8").catch(() => "{}"));
      const agentPrompts = JSON.parse(await readFile(promptsPath, "utf8").catch(() => "{}"));
      const rawList = Array.isArray(cfg.agents) ? cfg.agents
                    : Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
      const agentList = rawList.map(a => ({
        id: a.id,
        model: a.model || "",
        name: a.identity?.name || a.id,
        emoji: a.identity?.emoji || "🤖",
        theme: a.identity?.theme || "",
        systemPrompt: agentPrompts[a.id] || "",
        toolProfile: a.tools?.profile || "default",
        alsoAllow: a.tools?.alsoAllow || [],
        workspace: a.workspace || "",
      }));
      const providerMap = cfg?.models?.providers || {};
      const allModels = [];
      const modelsByProvider = {};
      for (const [pid, p] of Object.entries(providerMap)) {
        if (!(p.models || []).length) continue;
        modelsByProvider[pid] = p.models.map(m => ({ id: m.id, name: m.name || m.id }));
        for (const m of p.models) allModels.push(pid + "/" + m.id);
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
      const { agentId, model, systemPrompt, name, emoji, toolProfile, alsoAllow } = JSON.parse(body);
      if (!agentId) throw new Error("agentId required");
      const cfgPath = path.join(CFG_DIR, "openclaw.json");
      const promptsPath = path.join(CFG_DIR, "agent-prompts.json");
      const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
      const list = Array.isArray(cfg.agents) ? cfg.agents
                 : Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
      const agent = list.find(a => a.id === agentId);
      if (!agent) throw new Error("Agent not found: " + agentId);
      if (model) agent.model = model;
      if (name) { if (!agent.identity) agent.identity = {}; agent.identity.name = name; }
      if (emoji) { if (!agent.identity) agent.identity = {}; agent.identity.emoji = emoji; }
      if (toolProfile) { if (!agent.tools) agent.tools = {}; agent.tools.profile = toolProfile; }
      if (alsoAllow !== undefined) { if (!agent.tools) agent.tools = {}; agent.tools.alsoAllow = alsoAllow; }
      await writeFile(cfgPath, JSON.stringify(cfg, null, 4), "utf8");
      // System prompts live in agent-prompts.json, not openclaw.json
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
      const { id, model, name, emoji, systemPrompt, toolProfile } = JSON.parse(body);
      if (!id || !model) throw new Error("id and model required");
      const cfgPath = path.join(CFG_DIR, "openclaw.json");
      const promptsPath = path.join(CFG_DIR, "agent-prompts.json");
      const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
      const list = Array.isArray(cfg.agents) ? cfg.agents
                 : Array.isArray(cfg.agents?.list) ? cfg.agents.list : null;
      if (!list) throw new Error("Cannot determine agents list structure in openclaw.json");
      if (list.find(a => a.id === id)) throw new Error("Agent ID already exists: " + id);
      const defaultWorkspace = list[0]?.workspace || process.cwd();
      list.push({
        id, model,
        identity: { name: name || id, emoji: emoji || "🤖", theme: "Default" },
        tools: { profile: toolProfile || "coding", alsoAllow: ["web_search","web_fetch","message","gateway","nodes","agents_list","read","write","edit","apply_patch","exec"] },
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
      const cfgPath = path.join(CFG_DIR, "openclaw.json");
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
      // 1. Reset the OpenClaw session for this agent via gateway-bridge --reset-session
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
      const { spawn: spawnProc, execSync: execS } = await import("node:child_process");
      const { existsSync: eS } = await import("node:fs");
      const crewScript = path.join(OPENCLAW_DIR, "scripts", "start-crew.mjs");
      if (!eS(crewScript)) throw new Error("start-crew.mjs not found");
      const result = await new Promise((resolve, reject) => {
        const proc = spawnProc("node", [crewScript], { cwd: OPENCLAW_DIR, stdio: ["ignore","pipe","pipe"] });
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
    const TG_CONFIG_PATH = path.join(os.homedir(), ".openclaw", "telegram-bridge.json");
    const TG_PID_PATH    = path.join(os.homedir(), ".openclaw", "logs", "telegram-bridge.pid");
    const TG_MSG_PATH    = path.join(os.homedir(), ".openclaw", "logs", "telegram-messages.jsonl");

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
      res.end(JSON.stringify({ token: cfg.token || "", targetAgent: cfg.targetAgent || "crew-main", allowedChatIds: cfg.allowedChatIds || [] }));
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
      const { execSync } = await import("node:child_process");
      const net = await import("node:net");

      function portListening(port) {
        return new Promise(resolve => {
          const sock = new net.default.Socket();
          sock.setTimeout(300);
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
          const out = execSync(`pgrep -f "${pattern}" | wc -l`, { encoding: "utf8" }).trim();
          return parseInt(out, 10) || 0;
        } catch { return 0; }
      }

      function procStartTime(pid) {
        try {
          const out = execSync(`ps -p ${pid} -o lstart=`, { encoding: "utf8" }).trim();
          return out ? new Date(out).getTime() : null;
        } catch { return null; }
      }

      const RT_TOKEN = process.env.OPENCREW_RT_AUTH_TOKEN || (() => {
        try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".openclaw", "openclaw.json"), "utf8"))?.env?.OPENCREW_RT_AUTH_TOKEN || ""; } catch { return ""; }
      })();

      const tgPid     = pidRunning(path.join(os.homedir(), ".openclaw", "logs", "telegram-bridge.pid"));
      const agentCount = countProcs("gateway-bridge.mjs --rt-daemon");
      const rtUp      = await portListening(18889);
      const gwUp      = await portListening(18789);
      const ocUp      = await portListening(4096);
      const dashUp    = await portListening(listenPort);

      const services = [
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
          description: `${agentCount} gateway-bridge daemons running`,
          port: null,
          running: agentCount > 0,
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
          id: "openclaw-gateway",
          label: "OpenClaw Gateway",
          description: "OpenClaw message gateway — kills process, OpenClaw app auto-respawns",
          port: 18789,
          running: gwUp,
          canRestart: true,
          pid: null,
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
      ];

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(services));
      return;
    }

    if (url.pathname === "/api/services/restart" && req.method === "POST") {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const { id } = JSON.parse(raw || "{}");
      const { execSync, spawn: spawnProc } = await import("node:child_process");

      const RT_TOKEN = (() => {
        try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".openclaw", "openclaw.json"), "utf8"))?.env?.OPENCREW_RT_AUTH_TOKEN || ""; } catch { return ""; }
      })();
      const CREW_AGENTS = "main,admin,build,coder,researcher,architect,reviewer,qa,fixer,pm,orchestrator,openclaw,openclaw-main,opencode-pm,opencode-qa,opencode-fixer,opencode-coder,opencode-coder-2,security,crew-main,crew-pm,crew-qa,crew-fixer,crew-coder,crew-coder-2,crew-coder-front,crew-coder-back,crew-github,crew-security,crew-frontend,crew-copywriter,crew-telegram";

      if (id === "rt-bus") {
        try { execSync(`pkill -f "opencrew-rt-daemon"`, { stdio: "ignore" }); } catch {}
        await new Promise(r => setTimeout(r, 800));
        const rtDaemon = path.join(os.homedir(), "swarm", ".opencode", "plugin", "opencrew-rt-daemon.mjs");
        spawnProc("node", [rtDaemon], {
          env: { ...process.env, OPENCREW_RT_AUTH_TOKEN: RT_TOKEN, OPENCLAW_ALLOWED_AGENTS: CREW_AGENTS },
          detached: true, stdio: "ignore",
        }).unref();
      } else if (id === "agents") {
        try { execSync(`pkill -f "gateway-bridge.mjs --rt-daemon"`, { stdio: "ignore" }); } catch {}
        await new Promise(r => setTimeout(r, 800));
        spawnProc("node", [path.join(OPENCLAW_DIR, "scripts", "start-crew.mjs")], {
          cwd: OPENCLAW_DIR, detached: true, stdio: "ignore",
        }).unref();
      } else if (id === "telegram") {
        try {
          const pid = parseInt(fs.readFileSync(path.join(os.homedir(), ".openclaw", "logs", "telegram-bridge.pid"), "utf8").trim(), 10);
          if (pid) process.kill(pid, "SIGTERM");
        } catch {}
        await new Promise(r => setTimeout(r, 800));
        const tgCfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".openclaw", "telegram-bridge.json"), "utf8")); } catch { return {}; } })();
        if (tgCfg.token) {
          spawnProc("node", [path.join(OPENCLAW_DIR, "telegram-bridge.mjs")], {
            cwd: OPENCLAW_DIR,
            env: { ...process.env, TELEGRAM_BOT_TOKEN: tgCfg.token, TELEGRAM_TARGET_AGENT: tgCfg.targetAgent || "crew-main" },
            detached: true, stdio: "ignore",
          }).unref();
        }
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
          const pid = parseInt(fs.readFileSync(path.join(os.homedir(), ".openclaw", "logs", "telegram-bridge.pid"), "utf8").trim(), 10);
          if (pid) process.kill(pid, "SIGTERM");
        } catch {}
      } else if (id === "rt-bus") {
        try { execSync(`pkill -f "opencrew-rt-daemon"`, { stdio: "ignore" }); } catch {}
      } else if (id === "openclaw-gateway") {
        try { execSync(`pkill -f "openclaw-gateway"`, { stdio: "ignore" }); } catch {}
        await new Promise(r => setTimeout(r, 1000));
        try { execSync(`open -a OpenClaw`, { stdio: "ignore" }); } catch {}
      } else if (id === "opencode") {
        try { execSync(`pkill -f "opencode serve"`, { stdio: "ignore" }); } catch {}
        await new Promise(r => setTimeout(r, 1200));
        const opencodeBin = execSync("which opencode", { encoding: "utf8" }).trim() || "/usr/local/bin/opencode";
        spawnProc(opencodeBin, ["serve", "--port", "4096", "--hostname", "127.0.0.1"], {
          detached: true, stdio: "ignore",
        }).unref();
      } else if (id === "dashboard") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, message: "Restarting dashboard..." }));
        setTimeout(() => {
          const { spawn: sp } = require("child_process");
          sp("node", [path.join(OPENCLAW_DIR, "scripts", "dashboard.mjs")], {
            cwd: OPENCLAW_DIR, detached: true, stdio: "ignore",
          }).unref();
          process.exit(0);
        }, 500);
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(err?.message || err));
  }
});

server.listen(listenPort, "127.0.0.1", () => {
  console.log(`CrewSwarm Dashboard (with Build) at http://127.0.0.1:${listenPort}`);
});
