#!/usr/bin/env node
/**
 * CrewSwarm Dashboard with Build UI (RT Messages, Send, DLQ, Build).
 * Run from CrewSwarm repo so the Build button is included.
 *
 *   node scripts/dashboard.mjs
 *   → http://127.0.0.1:4319
 *
 * Override port: SWARM_DASH_PORT=4320 node scripts/dashboard.mjs
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
  || process.env.CREWSWARM_CONFIG_DIR
  || (fs.existsSync(path.join(os.homedir(), ".crewswarm", "crewswarm.json"))
      ? path.join(os.homedir(), ".crewswarm")
      : path.join(os.homedir(), ".openclaw"));
// Config filename within CFG_DIR — crewswarm.json for new installs, openclaw.json for legacy
const CFG_FILE = path.join(CFG_DIR,
  fs.existsSync(path.join(CFG_DIR, "crewswarm.json")) ? "crewswarm.json" : "openclaw.json");
// Load crewswarm.json env block into process.env on startup (so dashboard reads them)
// Credentials are excluded — only operational config vars are applied this way.
const ENV_CREDENTIAL_KEYS = new Set([
  "CREWSWARM_RT_AUTH_TOKEN", "CREWSWARM_RT_URL",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_TARGET_AGENT",
  "WA_TARGET_AGENT", "CREWSWARM_TOKEN",
]);
try {
  const _startupCfg = JSON.parse(fs.readFileSync(CFG_FILE, "utf8"));
  for (const [k, v] of Object.entries(_startupCfg.env || {})) {
    if (!ENV_CREDENTIAL_KEYS.has(k) && v && !process.env[k]) {
      process.env[k] = String(v);
    }
  }
} catch {}

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

// ── DASHBOARD UI ──────────────────────────────────────────────────────────────
// The dashboard UI lives in frontend/src/app.js + frontend/index.html (Vite).
// Build: cd frontend && npm run build  →  outputs to frontend/dist/
// This server serves frontend/dist/ as the live dashboard.
//
// DO NOT ADD UI CODE HERE. Edit frontend/src/app.js and frontend/index.html.
// The `html` variable below is a last-resort fallback only shown when
// frontend/dist/ has not been built yet.
const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>CrewSwarm</title></head>
<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a12;color:#e5e7eb;">
<div style="text-align:center;max-width:480px;padding:40px;">
  <div style="font-size:48px;margin-bottom:16px;">🚧</div>
  <h2 style="margin:0 0 12px;font-size:22px;">Frontend not built</h2>
  <p style="color:#9ca3af;margin:0 0 24px;line-height:1.6;">
    The dashboard UI hasn't been compiled yet. Run the build command and restart the server.
  </p>
  <code style="display:block;background:#1a1a2e;border:1px solid #333;border-radius:8px;padding:16px;font-size:13px;text-align:left;color:#a3e635;">
    cd frontend &amp;&amp; npm run build
  </code>
</div>
</body>
</html>`;


// ── Static frontend (Vite dist) ───────────────────────────────────────────────
const FRONTEND_DIST = path.resolve(__dirname, "../frontend/dist");
const FRONTEND_SRC  = path.resolve(__dirname, "../frontend");
const STATIC_MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript",
  ".css":  "text/css",
  ".png":  "image/png",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".json": "application/json",
  ".woff2":"font/woff2",
  ".woff": "font/woff",
};

function serveStatic(res, filePath) {
  try {
    const data = fs.readFileSync(filePath);
    const ext  = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "content-type": STATIC_MIME[ext] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
    return true;
  } catch { return false; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${listenPort}`);
  try {
    // Serve frontend static assets (Vite dist in prod, src in dev fallback)
    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/events")) {
      const distFile = path.join(FRONTEND_DIST, url.pathname === "/" ? "index.html" : url.pathname);
      if (serveStatic(res, distFile)) return;
      // Dev fallback: serve from frontend/src or frontend/index.html directly
      if (url.pathname === "/") {
        const devIndex = path.join(FRONTEND_SRC, "index.html");
        if (serveStatic(res, devIndex)) return;
      }
      const srcFile = path.join(FRONTEND_SRC, url.pathname);
      if (serveStatic(res, srcFile)) return;
    }
    if (url.pathname === "/") {
      // Final fallback — serve legacy inline HTML if frontend not built yet
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
    if (url.pathname === "/api/cmd-approve" && req.method === "POST") {
      let body = ""; for await (const chunk of req) body += chunk;
      const CREW_LEAD_PORT = process.env.CREW_LEAD_PORT || "5010";
      try {
        const r = await fetch(`http://127.0.0.1:${CREW_LEAD_PORT}/approve-cmd`, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(5000) });
        const d = await r.json().catch(() => ({}));
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(d));
      } catch (e) { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
      return;
    }
    if (url.pathname === "/api/cmd-reject" && req.method === "POST") {
      let body = ""; for await (const chunk of req) body += chunk;
      const CREW_LEAD_PORT = process.env.CREW_LEAD_PORT || "5010";
      try {
        const r = await fetch(`http://127.0.0.1:${CREW_LEAD_PORT}/reject-cmd`, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(5000) });
        const d = await r.json().catch(() => ({}));
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(d));
      } catch (e) { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
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

    if (url.pathname === "/api/env" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        HOME: process.env.HOME || os.homedir(),
        cwd: process.cwd(),
        node: process.version,
        pid: process.pid,
        uptime: Math.round(process.uptime()),
        platform: process.platform,
      }));
      return;
    }
    if (url.pathname === "/api/env-advanced" && req.method === "GET") {
      const vars = [
        "CREWSWARM_OPENCODE_TIMEOUT_MS",
        "CREWSWARM_OPENCODE_LOOP_MAX_ROUNDS",
        "CREWSWARM_DISPATCH_TIMEOUT",
        "CREW_LEAD_PORT",
        "SWARM_DASH_PORT",
        "CREWSWARM_BG_CONSCIOUSNESS",
        "CREWSWARM_BG_CONSCIOUSNESS_INTERVAL_MS",
        "CREWSWARM_BG_CONSCIOUSNESS_MODEL",
        "SHARED_MEMORY_NAMESPACE",
        "SHARED_MEMORY_DIR",
        "CREWSWARM_RT_AGENT",
        "CREWSWARM_OPENCODE_MODEL",
        "CREWSWARM_OPENCODE_AGENT",
        "CREWSWARM_OPENCODE_ENABLED",
        "CREWSWARM_OPENCODE_LOOP",
        "CREWSWARM_CLAUDE_CODE_MODEL",
        "CREWSWARM_CURSOR_MODEL",
        "WA_HTTP_PORT",
        "WA_ALLOWED_NUMBERS",
        "TELEGRAM_ALLOWED_USERNAMES",
        "PM_MAX_ITEMS",
        "PM_USE_QA",
        "PM_USE_SECURITY",
      ];
      // Read from crewswarm.json env block first, fall back to process.env
      // Credential keys are never exposed here
      let cfgEnv = {};
      try { cfgEnv = JSON.parse(fs.readFileSync(CFG_FILE, "utf8")).env || {}; } catch {}
      const result = {};
      for (const v of vars) {
        if (ENV_CREDENTIAL_KEYS.has(v)) continue;
        result[v] = cfgEnv[v] ?? process.env[v] ?? null;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ env: result }));
      return;
    }

    if (url.pathname === "/api/env-advanced" && req.method === "POST") {
      const body = await (async () => { let b = ""; for await (const c of req) b += c; return b; })();
      let updates;
      try { updates = JSON.parse(body); } catch { updates = {}; }
      const cfgPath = path.join(os.homedir(), ".crewswarm", "crewswarm.json");
      try {
        const raw = (() => { try { return fs.readFileSync(cfgPath, "utf8"); } catch { return "{}"; } })();
        const cfg = JSON.parse(raw);
        if (!cfg.env) cfg.env = {};
        for (const [k, v] of Object.entries(updates)) {
          if (v === null || v === "") {
            delete cfg.env[k];
            delete process.env[k];
          } else {
            cfg.env[k] = String(v);
            process.env[k] = String(v);
          }
        }
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 4), "utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
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
              CREWSWARM_OUTPUT_DIR: proj.outputDir,
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
          CREWSWARM_RT_SEND_TIMEOUT_MS: process.env.CREWSWARM_RT_SEND_TIMEOUT_MS || "300000",
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
              CREWSWARM_OUTPUT_DIR: proj.outputDir,
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
          CREWSWARM_RT_SEND_TIMEOUT_MS: process.env.CREWSWARM_RT_SEND_TIMEOUT_MS || "300000",
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
      const { projectId, autoAdvance, name, description, outputDir } = JSON.parse(body || "{}");
      if (!projectId) throw new Error("projectId required");
      const registryFile = path.join(OPENCLAW_DIR, "orchestrator-logs", "projects.json");
      const { existsSync } = await import("node:fs");
      const { readFile: rf, writeFile: wf } = await import("node:fs/promises");
      let projects = {};
      if (existsSync(registryFile)) projects = JSON.parse(await rf(registryFile, "utf8").catch(() => "{}"));
      if (!projects[projectId]) throw new Error("Project not found: " + projectId);
      const proj = projects[projectId];
      if (autoAdvance !== undefined) proj.autoAdvance = Boolean(autoAdvance);
      if (name) proj.name = name;
      if (description !== undefined) proj.description = description;
      if (outputDir) proj.outputDir = outputDir;
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
      const { dryRun, projectId, pmOptions = {} } = JSON.parse(body || "{}");
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
      let rtToken = process.env.CREWSWARM_RT_AUTH_TOKEN || "";
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
            rtToken = c?.rt?.authToken || c?.env?.CREWSWARM_RT_AUTH_TOKEN || "";
            if (rtToken) break;
          } catch {}
        }
      }
      if (!rtToken) {
        console.warn("[pm-loop/start] No CREWSWARM_RT_AUTH_TOKEN found in env or ~/.crewswarm/config.json (rt.authToken) — dispatches will fail with 'invalid realtime token'.");
      }
      const spawnArgs = [pmLoop, ...(dryRun ? ["--dry-run"] : []), ...(projectDir ? ["--project-dir", projectDir] : [])];
      const spawnEnv = {
        ...process.env,
        OPENCLAW_DIR,
        ...(rtToken ? { CREWSWARM_RT_AUTH_TOKEN: rtToken } : {}),
        PHASED_TASK_TIMEOUT_MS: process.env.PHASED_TASK_TIMEOUT_MS || "300000",
        CREWSWARM_RT_SEND_TIMEOUT_MS: process.env.CREWSWARM_RT_SEND_TIMEOUT_MS || "300000",
        CREWSWARM_RT_SEND_SENDER: "PM Loop",
        CREWSWARM_RT_BROADCAST_SENDER: "PM Loop",
        ...(projectId     ? { PM_PROJECT_ID: projectId }              : {}),
        ...(projectDir    ? { CREWSWARM_OUTPUT_DIR: projectDir }        : {}),
        ...(projectRoadmap    ? { PM_ROADMAP_FILE: projectRoadmap }    : {}),
        ...(projectFeaturesDoc ? { PM_FEATURES_DOC: projectFeaturesDoc } : {}),
        ...(pmOptions.useQA          === false ? { PM_USE_QA: "0" }          : {}),
        ...(pmOptions.useSecurity    === false ? { PM_USE_SECURITY: "0" }    : {}),
        ...(pmOptions.useSpecialists === false ? { PM_USE_SPECIALISTS: "0" } : {}),
        ...(pmOptions.selfExtend     === false ? { PM_SELF_EXTEND: "0" }     : {}),
        ...(pmOptions.maxItems       ? { PM_MAX_ITEMS: String(pmOptions.maxItems) }                    : {}),
        ...(pmOptions.taskTimeoutMin ? { PHASED_TASK_TIMEOUT_MS: String(pmOptions.taskTimeoutMin * 60000) } : {}),
        ...(pmOptions.extendEveryN   ? { PM_EXTEND_EVERY: String(pmOptions.extendEveryN) }             : {}),
        ...(pmOptions.pauseSec       !== undefined ? { PM_PAUSE_MS: String(pmOptions.pauseSec * 1000) }: {}),
        ...(pmOptions.maxRetries     !== undefined ? { PM_MAX_RETRIES: String(pmOptions.maxRetries) }  : {}),
        ...(pmOptions.coderAgent     ? { PM_CODER_AGENT: pmOptions.coderAgent }                        : {}),
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
    if (url.pathname.startsWith("/api/dlq/") && req.method === "DELETE") {
      const raw = url.pathname.replace("/api/dlq/", "");
      const key = decodeURIComponent(raw).replace(/[^a-zA-Z0-9_.-]/g, "");
      const file = path.join(dlqDir, key + ".json");
      try { fs.unlinkSync(file); } catch {}
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // ── Settings: RT Bus token ─────────────────────────────────────────────
    if (url.pathname === "/api/settings/rt-token" && req.method === "GET") {
      const csConfigPath = path.join(os.homedir(), ".crewswarm", "config.json");
      let token = "";
      try { token = JSON.parse(fs.readFileSync(csConfigPath, "utf8"))?.rt?.authToken || ""; } catch {}
      if (!token) token = process.env.CREWSWARM_RT_AUTH_TOKEN || "";
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
      let dir = process.env.CREWSWARM_OPENCODE_PROJECT || "";
      let fallbackModel = process.env.CREWSWARM_OPENCODE_FALLBACK_MODEL || "groq/moonshotai/kimi-k2-instruct-0905";
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
      if (dir !== undefined) { if (dir) cfg.opencodeProject = dir; else delete cfg.opencodeProject; process.env.CREWSWARM_OPENCODE_PROJECT = dir || ""; }
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
    // ── Proxy /api/settings/cursor-waves → crew-lead:5010 ───────────────────
    if (url.pathname === "/api/settings/cursor-waves") {
      try {
        const rawBody = req.method === "POST" ? (await (async () => { let b = ""; for await (const c of req) b += c; return b; })()) : null;
        const token = (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "config.json"), "utf8"))?.rt?.authToken || ""; } catch { return ""; } })();
        const r = await fetch("http://127.0.0.1:5010/api/settings/cursor-waves", {
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
    // ── Proxy /api/settings/claude-code → crew-lead:5010 ────────────────────
    if (url.pathname === "/api/settings/claude-code") {
      try {
        const rawBody = req.method === "POST" ? (await (async () => { let b = ""; for await (const c of req) b += c; return b; })()) : null;
        const token = (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "config.json"), "utf8"))?.rt?.authToken || ""; } catch { return ""; } })();
        const r = await fetch("http://127.0.0.1:5010/api/settings/claude-code", {
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
    // ── Codex CLI executor toggle ──────────────────────────────────────────────
    if (url.pathname === "/api/settings/codex") {
      const { readFile, writeFile } = await import("node:fs/promises");
      const cfgPath = CFG_FILE;
      if (req.method === "GET") {
        try {
          const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
          const enabled = cfg.codex === true || process.env.CREWSWARM_CODEX === "1";
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ enabled }));
        } catch {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ enabled: false }));
        }
        return;
      }
      if (req.method === "POST") {
        let body = ""; for await (const chunk of req) body += chunk;
        const { enabled } = JSON.parse(body || "{}");
        const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
        cfg.codex = enabled === true;
        await writeFile(cfgPath, JSON.stringify(cfg, null, 4), "utf8");
        process.env.CREWSWARM_CODEX = enabled ? "1" : "0";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, enabled: cfg.codex }));
        return;
      }
    }
    // ── Global OpenCode loop (Ouroboros) ───────────────────────────────────────
    if (url.pathname === "/api/settings/global-oc-loop") {
      const { readFile, writeFile } = await import("node:fs/promises");
      const cfgPath = CFG_FILE;
      if (req.method === "GET") {
        try {
          const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            enabled: cfg.opencodeLoop ?? false,
            maxRounds: cfg.opencodeLoopMaxRounds ?? 10,
          }));
        } catch (e) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ enabled: false, maxRounds: 10 }));
        }
        return;
      }
      if (req.method === "POST") {
        let body = ""; for await (const chunk of req) body += chunk;
        const { enabled, maxRounds } = JSON.parse(body || "{}");
        const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
        if (enabled !== undefined) cfg.opencodeLoop = enabled;
        if (maxRounds !== undefined) cfg.opencodeLoopMaxRounds = maxRounds;
        await writeFile(cfgPath, JSON.stringify(cfg, null, 4), "utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
    }
    // ── Passthrough notification routing ──────────────────────────────────────
    if (url.pathname === "/api/settings/passthrough-notify") {
      const { readFile, writeFile } = await import("node:fs/promises");
      const cfgPath = CFG_FILE;
      if (req.method === "GET") {
        try {
          const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
          const value = cfg.env?.PASSTHROUGH_NOTIFY || "both";
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ value }));
        } catch {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ value: "both" }));
        }
        return;
      }
      if (req.method === "POST") {
        let body = ""; for await (const chunk of req) body += chunk;
        const { value } = JSON.parse(body || "{}");
        const allowed = ["both", "tg", "wa", "none"];
        const safe = allowed.includes(value) ? value : "both";
        const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
        if (!cfg.env) cfg.env = {};
        cfg.env.PASSTHROUGH_NOTIFY = safe;
        await writeFile(cfgPath, JSON.stringify(cfg, null, 4), "utf8");
        // Also set in process.env so it takes effect without crew-lead restart
        process.env.PASSTHROUGH_NOTIFY = safe;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, value: safe }));
        return;
      }
    }
    // ── Role defaults (dashboard-managed) ─────────────────────────────────────
    if (url.pathname === "/api/settings/role-defaults") {
      const cfgPath = CFG_FILE;
      if (req.method === "GET") {
        try {
          const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
          const roles = cfg.roleToolDefaults || {};
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ roles }));
        } catch (e) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }
      if (req.method === "POST") {
        try {
          let body = ""; for await (const chunk of req) body += chunk;
          const { roles } = JSON.parse(body || "{}");
          const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
          cfg.roleToolDefaults = roles || {};
          fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 4), "utf8");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }
    }
    // ── Spending caps (dashboard-managed) ────────────────────────────────────
    if (url.pathname === "/api/settings/spending-caps") {
      const cfgPath = CFG_FILE;
      if (req.method === "GET") {
        try {
          const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
          const caps = cfg.globalSpendingCaps || {};
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            dailyTokenLimit: caps.dailyTokenLimit ?? null,
            dailyCostLimitUSD: caps.dailyCostLimitUSD ?? null,
          }));
        } catch (e) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }
      if (req.method === "POST") {
        try {
          let body = ""; for await (const chunk of req) body += chunk;
          const { dailyTokenLimit, dailyCostLimitUSD } = JSON.parse(body || "{}");
          const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
          cfg.globalSpendingCaps = {
            dailyTokenLimit: dailyTokenLimit ?? undefined,
            dailyCostLimitUSD: dailyCostLimitUSD ?? undefined,
          };
          // Remove keys with undefined to keep JSON clean
          if (cfg.globalSpendingCaps.dailyTokenLimit === undefined) delete cfg.globalSpendingCaps.dailyTokenLimit;
          if (cfg.globalSpendingCaps.dailyCostLimitUSD === undefined) delete cfg.globalSpendingCaps.dailyCostLimitUSD;
          fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 4), "utf8");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }
    }
    // ── Global rules (dashboard-managed, not proxied) ────────────────────────
    if (url.pathname === "/api/settings/global-rules") {
      const rulesPath = path.join(CFG_DIR, "global-rules.md");
      if (req.method === "GET") {
        try {
          const content = fs.existsSync(rulesPath) ? fs.readFileSync(rulesPath, "utf8") : "";
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ content }));
        } catch (e) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }
      if (req.method === "POST") {
        try {
          let body = ""; for await (const chunk of req) body += chunk;
          const { content } = JSON.parse(body || "{}");
          fs.writeFileSync(rulesPath, content || "", "utf8");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }
    }
    // ── GET/POST /api/settings/loop-brain ────────────────────────────────────────
    if (url.pathname === "/api/settings/loop-brain") {
      const { readFile, writeFile } = await import("node:fs/promises");
      if (req.method === "GET") {
        try {
          const cfg = JSON.parse(await readFile(CFG_FILE, "utf8"));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ loopBrain: cfg.loopBrain || null }));
        } catch { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ loopBrain: null })); }
        return;
      }
      if (req.method === "POST") {
        let body = ""; for await (const chunk of req) body += chunk;
        const { loopBrain } = JSON.parse(body || "{}");
        const cfg = JSON.parse(await readFile(CFG_FILE, "utf8"));
        if (loopBrain) cfg.loopBrain = loopBrain; else delete cfg.loopBrain;
        await writeFile(CFG_FILE, JSON.stringify(cfg, null, 4), "utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
    }
    // ── GET/POST /api/settings/loop-brain — central Ouroboros brain model ────────
    if (url.pathname === "/api/settings/loop-brain") {
      const { readFile, writeFile } = await import("node:fs/promises");
      const cfgPath = CFG_FILE;
      if (req.method === "GET") {
        try {
          const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ loopBrain: cfg.loopBrain || null }));
        } catch {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ loopBrain: null }));
        }
        return;
      }
      if (req.method === "POST") {
        let body = ""; for await (const chunk of req) body += chunk;
        const { loopBrain } = JSON.parse(body || "{}");
        const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
        if (loopBrain) cfg.loopBrain = loopBrain;
        else delete cfg.loopBrain;
        await writeFile(cfgPath, JSON.stringify(cfg, null, 4), "utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
    }
    // ── Proxy /api/engine-passthrough → crew-lead:5010 (SSE streaming) ─────────
    if (url.pathname === "/api/engine-passthrough" && req.method === "POST") {
      try {
        const rawBody = await (async () => { let b = ""; for await (const c of req) b += c; return b; })();
        const token = (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "config.json"), "utf8"))?.rt?.authToken || ""; } catch { return ""; } })();
        const upstream = await fetch("http://127.0.0.1:5010/api/engine-passthrough", {
          method: "POST",
          headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: rawBody,
        });
        res.writeHead(upstream.status, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "connection": "keep-alive",
          "access-control-allow-origin": "*",
        });
        // Stream SSE chunks straight through
        const reader = upstream.body.getReader();
        const pump = async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) { try { res.end(); } catch {} break; }
              try { res.write(value); } catch { reader.cancel(); break; }
            }
          } catch {}
        };
        pump();
        req.on("close", () => { try { reader.cancel(); } catch {} });
      } catch (e) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "done", exitCode: 1, error: e.message })}\n\n`);
        res.end();
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
        es("pgrep -f 'crew-lead.mjs'", { encoding: "utf8", timeout: 2000, stdio: "pipe" });
        const online = true;
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
      // Forward RT auth token so crew-lead's /chat Bearer check passes
      let clAuthToken = process.env.CREWSWARM_RT_AUTH_TOKEN || "";
      if (!clAuthToken) {
        try { clAuthToken = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "config.json"), "utf8"))?.rt?.authToken || ""; } catch {}
      }
      try {
        const clRes = await fetch(`http://127.0.0.1:${crewLeadPort}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(clAuthToken ? { "authorization": `Bearer ${clAuthToken}` } : {}) },
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
      let clAuthToken2 = process.env.CREWSWARM_RT_AUTH_TOKEN || "";
      if (!clAuthToken2) { try { clAuthToken2 = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "config.json"), "utf8"))?.rt?.authToken || ""; } catch {} }
      const clRes = await fetch(`http://127.0.0.1:${crewLeadPort}/clear`, {
        method: "POST", headers: { "content-type": "application/json", ...(clAuthToken2 ? { "authorization": `Bearer ${clAuthToken2}` } : {}) }, body,
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
      const baseUrl = (provider.baseUrl || "").replace(/\/$/, "");
      // Ollama is keyless — fetch directly from /api/tags and return the model list
      if (providerId === "ollama" || baseUrl.includes("11434")) {
        try {
          const r = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(5000) });
          const d = await r.json();
          const models = (d.models || []).map(m => ({ id: m.name, name: m.name }));
          if (provider) {
            if (cfg.models?.providers?.[providerId]) cfg.models.providers[providerId].models = models;
            if (cfg.providers?.[providerId]) cfg.providers[providerId].models = models;
            const { writeFile } = await import("node:fs/promises");
            await writeFile(CFG_FILE, JSON.stringify(cfg, null, 4), "utf8").catch(() => {});
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, models: models.map(m => m.id), count: models.length }));
        } catch(e) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Ollama not reachable: " + e.message }));
        }
        return;
      }
      if (!key) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "No API key set" })); return; }
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
          useCursorCli: a.useCursorCli || false,
          opencodeFallbackModel: a.opencodeFallbackModel || "",
          cursorCliModel: a.cursorCliModel || "",
          useClaudeCode: a.useClaudeCode || false,
          claudeCodeModel: a.claudeCodeModel || "",
          useCodex: a.useCodex || false,
          role: a._role || "",
          opencodeLoop: a.opencodeLoop || false,
          opencodeLoopMaxRounds: a.opencodeLoopMaxRounds || 10,
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
      const roleToolDefaults = cfg.roleToolDefaults || {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, agents: agentList, allModels, modelsByProvider, roleToolDefaults }));
      return;
    }
    if (url.pathname === "/api/agents-config/update" && req.method === "POST") {
      const { readFile, writeFile } = await import("node:fs/promises");
      let body = ""; for await (const chunk of req) body += chunk;
      const { agentId, model, fallbackModel, systemPrompt, name, emoji, theme, toolProfile, alsoAllow, useOpenCode, opencodeModel, opencodeFallbackModel, useCursorCli, cursorCliModel, useClaudeCode, claudeCodeModel, useCodex, role, opencodeLoop, opencodeLoopMaxRounds, workspace } = JSON.parse(body);
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
      if (useClaudeCode !== undefined) agent.useClaudeCode = useClaudeCode;
      if (claudeCodeModel !== undefined) agent.claudeCodeModel = claudeCodeModel || undefined;
      if (useCodex !== undefined) agent.useCodex = useCodex;
      if (role !== undefined) agent._role = role || undefined;
      if (opencodeLoop !== undefined) agent.opencodeLoop = opencodeLoop || undefined;
      if (opencodeLoopMaxRounds !== undefined) agent.opencodeLoopMaxRounds = opencodeLoopMaxRounds > 0 ? opencodeLoopMaxRounds : undefined;
      if (workspace !== undefined) agent.workspace = workspace || undefined;
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

    // ── WhatsApp API ──────────────────────────────────────────────────────────
    const WA_CONFIG_PATH = path.join(os.homedir(), ".crewswarm", "whatsapp-bridge.json");
    const WA_PID_PATH    = path.join(os.homedir(), ".crewswarm", "logs", "whatsapp-bridge.pid");
    const WA_MSG_PATH    = path.join(os.homedir(), ".crewswarm", "logs", "whatsapp-messages.jsonl");
    const WA_AUTH_DIR    = path.join(os.homedir(), ".crewswarm", "whatsapp-auth");

    function loadWaCfg() {
      try { return JSON.parse(fs.readFileSync(WA_CONFIG_PATH, "utf8")); } catch { return {}; }
    }
    function isWaRunning() {
      try {
        const pid = parseInt(fs.readFileSync(WA_PID_PATH, "utf8").trim(), 10);
        if (!pid) return false;
        process.kill(pid, 0);
        return true;
      } catch { return false; }
    }

    if (url.pathname === "/api/whatsapp/status") {
      const running = isWaRunning();
      const authSaved = fs.existsSync(path.join(WA_AUTH_DIR, "creds.json"));
      const cfg = loadWaCfg();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ running, authSaved, number: cfg.number || "" }));
      return;
    }

    if (url.pathname === "/api/whatsapp/config" && req.method === "GET") {
      const cfg = loadWaCfg();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        allowedNumbers: cfg.allowedNumbers || [],
        targetAgent: cfg.targetAgent || "crew-lead",
        contactNames: cfg.contactNames || {},
      }));
      return;
    }

    if (url.pathname === "/api/whatsapp/config" && req.method === "POST") {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || "{}");
      const existing = loadWaCfg();
      fs.writeFileSync(WA_CONFIG_PATH, JSON.stringify({ ...existing, ...body }, null, 2));
      // Also write WA_ALLOWED_NUMBERS into crewswarm.json env block so the bridge picks it up
      try {
        const swarmPath = path.join(os.homedir(), ".crewswarm", "crewswarm.json");
        const swarm = JSON.parse(fs.readFileSync(swarmPath, "utf8"));
        swarm.env = swarm.env || {};
        if (body.allowedNumbers !== undefined) {
          swarm.env.WA_ALLOWED_NUMBERS = (body.allowedNumbers || []).join(",");
        }
        if (body.targetAgent) swarm.env.WA_TARGET_AGENT = body.targetAgent;
        fs.writeFileSync(swarmPath, JSON.stringify(swarm, null, 2));
      } catch {}
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/api/whatsapp/start" && req.method === "POST") {
      if (isWaRunning()) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, message: "Already running" }));
        return;
      }
      const cfg = loadWaCfg();
      const swarm = (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "crewswarm.json"), "utf8")); } catch { return {}; } })();
      const waEnv = swarm.env || {};
      const { spawn: spawnBridge } = await import("node:child_process");
      const bridgePath = path.join(OPENCLAW_DIR, "whatsapp-bridge.mjs");
      const env = {
        ...process.env,
        ...(waEnv.WA_ALLOWED_NUMBERS ? { WA_ALLOWED_NUMBERS: waEnv.WA_ALLOWED_NUMBERS } : {}),
        ...(waEnv.WA_TARGET_AGENT   ? { WA_TARGET_AGENT:    waEnv.WA_TARGET_AGENT }    : {}),
      };
      const proc = spawnBridge("node", [bridgePath], { env, detached: true, stdio: "ignore", cwd: OPENCLAW_DIR });
      proc.unref();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, pid: proc.pid }));
      return;
    }

    if (url.pathname === "/api/whatsapp/stop" && req.method === "POST") {
      try {
        const pid = parseInt(fs.readFileSync(WA_PID_PATH, "utf8").trim(), 10);
        if (pid) process.kill(pid, "SIGTERM");
      } catch {}
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/api/whatsapp/messages") {
      try {
        const raw = fs.readFileSync(WA_MSG_PATH, "utf8");
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
            const out = execSync(`pgrep -f "${pattern}" | wc -l`, { encoding: "utf8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"] }).trim();
            return parseInt(out, 10) || 0;
          } catch { return 0; }
        }

        function procStartTime(pid) {
          try {
            const out = execSync(`ps -p ${pid} -o lstart=`, { encoding: "utf8", timeout: 1500, stdio: ["pipe", "pipe", "pipe"] }).trim();
            return out ? new Date(out).getTime() : null;
          } catch { return null; }
        }

        const crewLeadPort = Number(process.env.CREW_LEAD_PORT || 5010);
        const tgPid     = pidRunning(path.join(os.homedir(), ".crewswarm", "logs", "telegram-bridge.pid"));
        const waPid     = pidRunning(path.join(os.homedir(), ".crewswarm", "logs", "whatsapp-bridge.pid"));
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
          id: "whatsapp",
          label: "WhatsApp Bridge",
          description: waPid !== null ? "Personal bot via Baileys — linked device active" : "Personal bot via Baileys — run once to scan QR",
          port: null,
          running: waPid !== null,
          canRestart: true,
          pid: waPid,
        },
        {
          id: "opencode",
          label: "Code Engine",
          description: "Coding execution server (OpenCode / Claude Code / Cursor) — port 4096",
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
          id: "mcp",
          label: "MCP + OpenAI API",
          description: "MCP tools + /v1/chat/completions for Open WebUI, LM Studio, Aider — port 5020",
          port: 5020,
          running: await (async () => { try { const r = await fetch("http://127.0.0.1:5020/health", { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; } })(),
          canRestart: true,
          pid: null,
        },
        {
          id: "openclaw-gateway",
          label: "OpenClaw Gateway (optional)",
          description: gwUp
            ? (oclawPaired ? "App paired ✓ — legacy plugin communicating via port 18789" : "Listening on port 18789 — legacy only")
            : "Optional legacy service (port 18789). Only needed if using the OpenClaw desktop app. CrewSwarm works fully without it.",
          port: 18789,
          running: gwUp,
          optional: true,
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
          { id: "opencode", label: "Code Engine", description: "opencode serve — port 4096", port: 4096, running: false, canRestart: true, pid: null },
          { id: "dashboard", label: "Dashboard", description: "This dashboard", port: listenPort, running: true, canRestart: true, pid: process.pid },
          { id: "openclaw-gateway", label: "OpenClaw Gateway (optional)", description: "Optional legacy service — only needed if using the OpenClaw desktop app", port: 18789, running: false, optional: true, canRestart: true, pid: null },
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
          [path.join(home, ".crewswarm", "crewswarm.json"), "env.CREWSWARM_RT_AUTH_TOKEN"],
          [path.join(home, ".openclaw", "openclaw.json"), "env.CREWSWARM_RT_AUTH_TOKEN"],
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
          env: { ...process.env, CREWSWARM_RT_AUTH_TOKEN: RT_TOKEN, OPENCLAW_ALLOWED_AGENTS: CREW_AGENTS },
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
      } else if (id === "whatsapp") {
        try {
          const pid = parseInt(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "logs", "whatsapp-bridge.pid"), "utf8").trim(), 10);
          if (pid) process.kill(pid, "SIGTERM");
        } catch {}
        await new Promise(r => setTimeout(r, 800));
        // WhatsApp bridge uses auth files — no token needed, just spawn it
        const waCfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "crewswarm.json"), "utf8")); } catch { return {}; } })();
        const waEnv = waCfg.env || {};
        spawnProc("node", [path.join(OPENCLAW_DIR, "whatsapp-bridge.mjs")], {
          cwd: OPENCLAW_DIR,
          env: { ...process.env, ...(waEnv.WA_ALLOWED_NUMBERS ? { WA_ALLOWED_NUMBERS: waEnv.WA_ALLOWED_NUMBERS } : {}) },
          detached: true, stdio: "ignore",
        }).unref();
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
      } else if (id === "mcp") {
        try { execSync(`pkill -f "mcp-server.mjs"`, { stdio: "ignore" }); } catch {}
        try { execSync(`lsof -ti :5020 | xargs kill -9 2>/dev/null`, { stdio: "ignore", shell: true }); } catch {}
        await new Promise(r => setTimeout(r, 800));
        spawnProc("node", [path.join(OPENCLAW_DIR, "scripts", "mcp-server.mjs")], {
          cwd: OPENCLAW_DIR, detached: true, stdio: "ignore", env: process.env,
        }).unref();
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
      } else if (id === "whatsapp") {
        try {
          const pid = parseInt(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "logs", "whatsapp-bridge.pid"), "utf8").trim(), 10);
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
      } else if (id === "mcp") {
        try { execSync(`pkill -f "mcp-server.mjs"`, { stdio: "ignore" }); } catch {}
        try { execSync(`lsof -ti :5020 | xargs kill -9 2>/dev/null`, { stdio: "ignore", shell: true }); } catch {}
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

    // ── Engines API ─────────────────────────────────────────────────────────────
    if (url.pathname === "/api/engines" && req.method === "GET") {
      try {
        const { execSync } = await import("node:child_process");
        const bundledDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "engines");
        const userDir = path.join(os.homedir(), ".crewswarm", "engines");
        const enginesMap = {};
        for (const dir of [bundledDir, userDir]) {
          if (!fs.existsSync(dir)) continue;
          for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".json"))) {
            try {
              const eng = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
              if (eng.id) enginesMap[eng.id] = { ...eng, source: dir === userDir ? "user" : "bundled" };
            } catch {}
          }
        }
        const engines = Object.values(enginesMap).map(eng => {
          let installed = false;
          try {
            const bin = eng.bin || eng.id;
            execSync(`which ${bin}`, { stdio: "ignore" });
            installed = true;
          } catch {
            if (eng.binAlternate) {
              const alt = eng.binAlternate.replace(/^~/, os.homedir());
              installed = fs.existsSync(alt);
            }
          }
          const missingEnv = (eng.requiresEnv || []).filter(k => !process.env[k]);
          return { ...eng, installed, missingEnv, ready: installed && missingEnv.length === 0 };
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ engines }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === "/api/engines/import" && req.method === "POST") {
      let body = ""; for await (const chunk of req) body += chunk;
      try {
        const { url: engineUrl } = JSON.parse(body || "{}");
        if (!engineUrl) throw new Error("url required");
        const rawUrl = engineUrl
          .replace("github.com", "raw.githubusercontent.com")
          .replace("/blob/", "/");
        const resp = await fetch(rawUrl, { signal: AbortSignal.timeout(10000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const eng = await resp.json();
        if (!eng.id || !eng.label) throw new Error("Engine descriptor must have id and label");
        const engDir = path.join(os.homedir(), ".crewswarm", "engines");
        if (!fs.existsSync(engDir)) fs.mkdirSync(engDir, { recursive: true });
        const outPath = path.join(engDir, `${eng.id}.json`);
        if (!outPath.startsWith(engDir)) throw new Error("Invalid engine id");
        fs.writeFileSync(outPath, JSON.stringify(eng, null, 2), "utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, id: eng.id, label: eng.label }));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname.startsWith("/api/engines/") && req.method === "DELETE") {
      const id = url.pathname.split("/").pop();
      const engDir = path.join(os.homedir(), ".crewswarm", "engines");
      const target = path.join(engDir, `${id}.json`);
      if (!target.startsWith(engDir)) { res.writeHead(400); res.end("{}"); return; }
      try { fs.unlinkSync(target); } catch {}
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Skill import from URL — handled directly (not proxied, needs outbound fetch)
    if (url.pathname === "/api/skills/import" && req.method === "POST") {
      let body = ""; for await (const chunk of req) body += chunk;
      try {
        const { url: skillUrl } = JSON.parse(body || "{}");
        if (!skillUrl) throw new Error("url is required");

        // ── Security: validate import source URL ─────────────────────────────
        let parsedImportUrl;
        try { parsedImportUrl = new URL(skillUrl); } catch { throw new Error("Invalid URL"); }
        const importHost = parsedImportUrl.hostname.toLowerCase();
        // Block SSRF: reject private/loopback addresses and non-HTTPS sources
        const BLOCKED_HOSTS = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1|0\.0\.0\.0)/;
        if (BLOCKED_HOSTS.test(importHost)) throw new Error("Blocked: cannot import from private/loopback addresses");
        if (parsedImportUrl.protocol !== "https:") throw new Error("Only HTTPS import URLs are allowed");

        // Convert GitHub blob URLs to raw
        const rawUrl = skillUrl
          .replace("https://github.com/", "https://raw.githubusercontent.com/")
          .replace("/blob/", "/");

        const resp = await fetch(rawUrl, { signal: AbortSignal.timeout(10000) });
        if (!resp.ok) throw new Error(`Fetch failed: ${resp.status} ${resp.statusText}`);
        const text = await resp.text();
        // Reject unreasonably large skill files (>64KB)
        if (text.length > 65536) throw new Error("Skill file too large (>64KB)");

        let skill;
        const lowerUrl = rawUrl.toLowerCase();

        if (lowerUrl.endsWith(".json")) {
          // JSON skill format
          skill = JSON.parse(text);
          if (!skill.description) throw new Error("Invalid skill JSON: missing description");
        } else {
          // SKILL.md format — parse YAML frontmatter
          const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
          const fm = {};
          if (fmMatch) {
            for (const line of fmMatch[1].split(/\r?\n/)) {
              const m = line.match(/^(\w[\w-]*):\s*(.+)/);
              if (m) fm[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
            }
          }
          const urlParts = rawUrl.split("/");
          const fileBase = urlParts[urlParts.length - 1].replace(/\.(md|json)$/i, "");
          const folderName = urlParts[urlParts.length - 2] || fileBase;
          skill = {
            description: fm.description || fm.name || `Skill from ${folderName}`,
            url: fm.url || "",
            method: fm.method || "POST",
          };
          if (fm.name) skill._importedName = fm.name;
          const body2 = text.replace(/^---[\s\S]*?---\r?\n/, "").trim();
          if (body2) skill.paramNotes = body2.slice(0, 500);
        }

        // ── Security: scan the skill payload itself ───────────────────────────
        const warnings = [];
        // Flag cmd-type skills (can execute arbitrary shell commands)
        if (skill.type === "cmd" || skill.cmd) {
          warnings.push("cmd_skill: this skill executes shell commands via @@RUN_CMD");
        }
        // Flag skill URLs targeting private/loopback ranges (SSRF in skill execution)
        if (skill.url) {
          try {
            const su = new URL(skill.url.replace(/\{[^}]*\}/g, "placeholder"));
            const sh = su.hostname.toLowerCase();
            if (BLOCKED_HOSTS.test(sh)) warnings.push("ssrf_risk: skill url targets a private/loopback address");
            if (su.protocol !== "https:" && !sh.includes("localhost")) warnings.push("insecure_url: skill url uses non-HTTPS");
          } catch { /* relative or template URL — ok */ }
        }
        // Flag requiresApproval=false on skills that write data (POST/PUT/DELETE)
        const method = (skill.method || "GET").toUpperCase();
        if (["POST","PUT","DELETE","PATCH"].includes(method) && skill.requiresApproval === false) {
          warnings.push("no_approval: write-method skill has requiresApproval:false — agents can use it without confirmation");
        }

        // Determine skill name: prefer explicit field, else infer from URL
        const urlParts = rawUrl.split("/");
        const fileBase = urlParts[urlParts.length - 1].replace(/\.(md|json)$/i, "");
        const folderName = urlParts[urlParts.length - 2];
        const rawName = skill.name || skill._importedName ||
          (folderName && folderName !== "skills" ? folderName : fileBase);
        // Sanitize: strip path traversal, lowercase, replace unsafe chars
        const skillName = rawName.toLowerCase().replace(/\.\./g, "").replace(/[^a-z0-9._-]/g, "-").replace(/^[-.]|[-.]$/g, "");
        if (!skillName) throw new Error("Could not determine a valid skill name");
        delete skill._importedName;
        delete skill.name;

        // Save to ~/.crewswarm/skills/<name>.json
        const skillsDir = path.join(process.env.HOME || "/tmp", ".crewswarm", "skills");
        if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true });
        const outPath = path.join(skillsDir, `${skillName}.json`);
        // Final path traversal guard
        if (!outPath.startsWith(skillsDir)) throw new Error("Invalid skill name");
        fs.writeFileSync(outPath, JSON.stringify(skill, null, 2), "utf8");

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, name: skillName, skill, path: outPath, warnings }));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
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
