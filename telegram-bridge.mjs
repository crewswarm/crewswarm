#!/usr/bin/env node
/**
 * telegram-bridge.mjs — Connects Telegram to the CrewSwarm RT bus.
 *
 * What it does:
 *   1. Long-polls the Telegram Bot API for incoming messages
 *   2. Connects to the RT bus (18889) as "crew-telegram"
 *   3. Forwards user messages → crew-main via the RT bus
 *   4. Listens for crew-main responses → sends them back to Telegram
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=123:abc node telegram-bridge.mjs
 *
 * Or set in ~/.crewswarm/crewswarm.json env block:
 *   "TELEGRAM_BOT_TOKEN": "123:abc..."
 */

import WebSocket from "ws";
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

mkdirSync(join(homedir(), ".crewswarm", "logs"), { recursive: true });
import { randomUUID } from "node:crypto";

// ── Config ────────────────────────────────────────────────────────────────────

const CREW_CFG_PATH      = join(homedir(), ".crewswarm", "crewswarm.json");
const OPENCLAW_CFG       = join(homedir(), ".openclaw", "openclaw.json");   // legacy fallback
const TG_BRIDGE_CFG_PATH = join(homedir(), ".crewswarm", "telegram-bridge.json");
const LOG_PATH        = join(homedir(), ".crewswarm", "logs", "telegram-bridge.jsonl");
const PID_PATH        = join(homedir(), ".crewswarm", "logs", "telegram-bridge.pid");

function loadCfg() {
  // Prefer ~/.crewswarm/crewswarm.json, fall back to ~/.openclaw/openclaw.json
  try { return JSON.parse(readFileSync(CREW_CFG_PATH, "utf8")); } catch {}
  try { return JSON.parse(readFileSync(OPENCLAW_CFG, "utf8")); } catch {}
  return {};
}
const cfg = loadCfg();
const env = cfg.env || {};

const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN || "";
const RT_URL      = process.env.OPENCREW_RT_URL    || env.OPENCREW_RT_URL    || "ws://127.0.0.1:18889";
const RT_TOKEN    = process.env.OPENCREW_RT_AUTH_TOKEN || env.OPENCREW_RT_AUTH_TOKEN || "";
const AGENT_NAME  = "crew-telegram";
const TELEGRAM_CONTEXT_PATH = process.env.TELEGRAM_CONTEXT_PATH || join(homedir(), "Desktop", "CrewSwarm", "memory", "telegram-context.md");
const TARGET      = process.env.TELEGRAM_TARGET_AGENT || env.TELEGRAM_TARGET_AGENT || "crew-lead";
const CREW_LEAD_URL = process.env.CREW_LEAD_URL || "http://127.0.0.1:5010";
const POLL_TIMEOUT = 30; // seconds

// Allowlist — comma-separated chat IDs. Empty = allow all (open bot).
const ALLOWED_RAW = process.env.TELEGRAM_ALLOWED_IDS || env.TELEGRAM_ALLOWED_IDS || "";
const ALLOWED_IDS = new Set(
  ALLOWED_RAW.split(",").map(s => s.trim()).filter(Boolean).map(Number)
);
const ALLOWLIST_ENABLED = ALLOWED_IDS.size > 0;

// Allowlist — load from config, or allow all if empty
function getAllowedIds() {
  try {
    const c = JSON.parse(readFileSync(TG_BRIDGE_CFG_PATH, "utf8"));
    return Array.isArray(c.allowedChatIds) ? new Set(c.allowedChatIds) : null;
  } catch { return null; }
}

if (!BOT_TOKEN) {
  console.error("[telegram-bridge] ❌ TELEGRAM_BOT_TOKEN not set.");
  console.error("  Set TELEGRAM_BOT_TOKEN=... in your environment or in ~/.crewswarm/crewswarm.json env block.");
  process.exit(1);
}

// ── Logging ───────────────────────────────────────────────────────────────────

function log(level, msg, data = {}) {
  const entry = { ts: new Date().toISOString(), level, msg, ...data };
  console.log(`[telegram-bridge] [${level}] ${msg}`, Object.keys(data).length ? data : "");
  try { appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n"); } catch {}
}

// Write PID
try { writeFileSync(PID_PATH, String(process.pid)); } catch {}
process.on("exit", () => { try { writeFileSync(PID_PATH, ""); } catch {} });

// ── Telegram API ──────────────────────────────────────────────────────────────

const TG_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function tgRequest(method, body = {}) {
  // getUpdates uses a server-side long-poll timeout (POLL_TIMEOUT seconds) so give it
  // a generous client-side timeout; all other calls (sendMessage etc.) cap at 15s.
  const clientTimeoutMs = method === "getUpdates"
    ? (POLL_TIMEOUT + 15) * 1000  // server timeout + 15s buffer
    : 15000;
  const res = await fetch(`${TG_BASE}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(clientTimeoutMs),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description}`);
  return json.result;
}

// Dedupe: avoid sending the same long message twice (e.g. roadmap sent via reply and again via another path)
const lastSentByChat = new Map(); // chatId -> { content, ts }
const DEDUPE_WINDOW_MS = 30000;  // wider window to catch SSE + RT race
const DEDUPE_MIN_LEN = 200;      // catch shorter duplicates too

// Normalise to raw content so SSE-wrapped and RT-raw versions both match
function dedupeKey(text) {
  return text.replace(/^✅ \*.+?\* finished:\n/, "").trim();
}

function shouldSkipDuplicate(chatId, text) {
  if (!text) return false;
  const key = dedupeKey(text);
  if (key.length < DEDUPE_MIN_LEN) return false;
  const last = lastSentByChat.get(chatId);
  if (!last) return false;
  if (Date.now() - last.ts > DEDUPE_WINDOW_MS) return false;
  const lastKey = dedupeKey(last.content);
  const same = lastKey === key;
  const prefixMatch = lastKey.length > 200 && key.length > 200
    && lastKey.slice(0, 200) === key.slice(0, 200)
    && Math.abs(lastKey.length - key.length) < 200;
  return same || prefixMatch;
}

async function tgSend(chatId, text) {
  if (shouldSkipDuplicate(chatId, text)) {
    log("info", "Skipping duplicate message to Telegram", { chatId, len: text.length });
    return;
  }
  lastSentByChat.set(chatId, { content: text, ts: Date.now() });
  const chunks = splitMessage(text, 4000);
  for (const chunk of chunks) {
    await tgRequest("sendMessage", {
      chat_id: chatId,
      text: chunk,
      parse_mode: "Markdown",
    }).catch(() =>
      tgRequest("sendMessage", { chat_id: chatId, text: chunk })
    );
  }
}

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let i = 0;
  while (i < text.length) { chunks.push(text.slice(i, i + maxLen)); i += maxLen; }
  return chunks;
}

async function tgGetMe() {
  return tgRequest("getMe");
}

// ── RT Bus client ─────────────────────────────────────────────────────────────

let rtClient = null;

// ── Conversation history (per chatId) ─────────────────────────────────────────
// Keeps last N turns so crew-main has thread context
const MAX_HISTORY = 20;
const conversations = new Map(); // chatId → [{role, content, ts}]

function getHistory(chatId) {
  return conversations.get(chatId) || [];
}

function addToHistory(chatId, role, content) {
  const hist = conversations.get(chatId) || [];
  hist.push({ role, content, ts: new Date().toISOString() });
  if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - MAX_HISTORY);
  conversations.set(chatId, hist);
}

function formatHistory(chatId) {
  const hist = getHistory(chatId);
  if (!hist.length) return "";
  return "\n\n--- Conversation history ---\n" +
    hist.map(h => `${h.role === "user" ? "User" : "You"}: ${h.content}`).join("\n") +
    "\n--- End history ---";
}

// Track active chat sessions (chatId → {username, firstName, lastSeen})
const activeSessions = new Map();

// Track last crew-main reply time to debounce rapid messages
const lastReplyTime = new Map();

// ── Per-chat active project ───────────────────────────────────────────────────
// Set once via /project <name>, cleared via /project off or /home
// Persists for the lifetime of the bridge process (survives messages, not restarts)
const activeProjectByChatId = new Map(); // chatId → { id, name, outputDir }

const DASHBOARD_URL = process.env.DASHBOARD_URL || "http://127.0.0.1:4319";

async function fetchProjects() {
  const r = await fetch(`${DASHBOARD_URL}/api/projects`, { signal: AbortSignal.timeout(5000) });
  const d = await r.json();
  return d.projects || [];
}

async function handleCommand(chatId, text) {
  const lower = text.toLowerCase().trim();

  // /projects — list all registered projects
  if (lower === "/projects" || lower === "/project") {
    try {
      const projects = await fetchProjects();
      if (!projects.length) {
        await tgSend(chatId, "No projects registered yet. Create one via the dashboard or by chatting with crew-lead.");
        return true;
      }
      const current = activeProjectByChatId.get(chatId);
      const lines = projects.map(p => {
        const active = current && current.id === p.id ? " ✅" : "";
        const pct = p.roadmap?.total ? Math.round((p.roadmap.done / p.roadmap.total) * 100) : 0;
        return `• *${p.name}*${active} — ${pct}% done\n  \`/project ${p.name}\`\n  📁 ${p.outputDir || "?"}`;
      });
      const msg = `*Registered projects (${projects.length}):*\n\n${lines.join("\n\n")}\n\n_Use /project <name> to set active context. /home to return to general mode._`;
      await tgSend(chatId, msg);
    } catch (e) {
      await tgSend(chatId, `⚠️ Could not fetch projects: ${e.message}`);
    }
    return true;
  }

  // /home or /project off — clear active project, back to general crew-lead mode
  if (lower === "/home" || lower === "/project off" || lower === "/project none" || lower === "/project clear") {
    activeProjectByChatId.delete(chatId);
    await tgSend(chatId, "✅ Back to general mode — no active project. crew-lead will act as director.");
    return true;
  }

  // /project <name> — set active project by name or partial match
  if (lower.startsWith("/project ")) {
    const query = text.slice(9).trim().toLowerCase();
    try {
      const projects = await fetchProjects();
      const match = projects.find(p =>
        p.name.toLowerCase() === query ||
        p.name.toLowerCase().includes(query) ||
        (p.id && p.id.toLowerCase().includes(query)) ||
        (p.outputDir && p.outputDir.toLowerCase().includes(query))
      );
      if (!match) {
        const names = projects.map(p => `  • ${p.name}`).join("\n");
        await tgSend(chatId, `❌ No project matching "${query}".\n\nAvailable:\n${names || "(none)"}`);
        return true;
      }
      activeProjectByChatId.set(chatId, { id: match.id, name: match.name, outputDir: match.outputDir });
      const roadmap = match.roadmapFile ? `\nROADMAP: ${match.roadmapFile}` : "";
      await tgSend(chatId, `✅ *${match.name}* is now the active project.\n📁 ${match.outputDir || "?"}${roadmap}\n\nEvery message you send will include this project's context. Use /home to return to general mode.`);
    } catch (e) {
      await tgSend(chatId, `⚠️ Could not look up projects: ${e.message}`);
    }
    return true;
  }

  return false; // not a command we handle
}

function connectRT() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RT_URL);
    let ready = false;

    const client = {
      publish({ channel, type, to, taskId, correlationId, payload }) {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: "publish", channel, messageType: type, to, taskId, correlationId, priority: "high", payload }));
      },
      ack({ messageId }) {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: "ack", messageId, status: "received" }));
      },
      isReady: () => ready,
      ws,
    };

    ws.on("open", () => log("info", "RT socket open"));

    ws.on("message", async (raw) => {
      let p;
      try { p = JSON.parse(raw.toString()); } catch { return; }

      if (p.type === "server.hello") {
        log("info", `RT server.hello received — sending hello as ${AGENT_NAME}`);
        ws.send(JSON.stringify({ type: "hello", agent: AGENT_NAME, token: RT_TOKEN }));
        return;
      }

      if (p.type === "hello.ack") {
        ws.send(JSON.stringify({ type: "subscribe", channels: ["command", "assign", "done", "status", "events"] }));
        ready = true;
        resolve(client);
        log("info", `RT connected as ${AGENT_NAME} — ready to receive messages`);
        return;
      }

      // Log any unexpected message types for debugging
      if (!["message", "ack"].includes(p.type)) {
        log("info", `RT message: ${p.type}`, { raw: JSON.stringify(p).slice(0, 200) });
      }

      if (p.type === "message" && p.envelope) {
        const env = p.envelope;
        if (env.messageId) client.ack({ messageId: env.messageId });

        const from    = env.from || env.sender_agent_id || "";
        const content = env.payload?.content ? String(env.payload.content).trim() : "";

        // Forward any substantive reply from crew-lead (or TARGET) to active Telegram sessions
        const isChatReply = env.messageType === "chat.reply" || env.type === "chat.reply";
        const sessionId = env.payload?.sessionId;
        if ((from === TARGET || isChatReply) && content && content.length > 2) {
          // Skip pure status/heartbeat messages
          const isHeartbeat = env.type === "agent.heartbeat" || env.channel === "status";
          const isTaskNoise = content.startsWith("@@DISPATCH") || content.startsWith("[bridge]");
          if (!isHeartbeat && !isTaskNoise) {
            // If reply has a specific sessionId, route only to that chat
            const targetSessions = sessionId && activeSessions.has(Number(sessionId))
              ? [[Number(sessionId), activeSessions.get(Number(sessionId))]]
              : [...activeSessions];
            for (const [chatId, session] of targetSessions) {
              const lastReply = lastReplyTime.get(chatId) || 0;
              if (Date.now() - lastReply < 2000) continue;
              lastReplyTime.set(chatId, Date.now());
              log("info", "Forwarding crew-lead reply to Telegram", { chatId, preview: content.slice(0, 80) });
              addToHistory(chatId, "assistant", content);
              persistTurn("assistant", content, "CrewSwarm");
              logMessage({ direction: "outbound", chatId, text: content });
              await tgSend(chatId, content);
            }
          }
        }
      }
    });

    ws.on("error", (e) => {
      log("error", "RT socket error", { error: e.message });
      if (!ready) reject(e);
    });

    ws.on("close", () => {
      log("warn", "RT socket closed — reconnecting in 3s");
      if (!ready) reject(new Error("RT closed before ready"));
      ready = false;
      rtClient = null;
      setTimeout(() => connectRT().then(c => { rtClient = c; }).catch(() => {}), 3000);
    });
  });
}

// ── Message log (for dashboard) ───────────────────────────────────────────────

const MSG_LOG = join(homedir(), ".crewswarm", "logs", "telegram-messages.jsonl");

function logMessage({ direction, chatId, username, text, firstName }) {
  const entry = { ts: new Date().toISOString(), direction, chatId, username, firstName, text };
  try { appendFileSync(MSG_LOG, JSON.stringify(entry) + "\n"); } catch {}
}

// ── Persistent memory writer ───────────────────────────────────────────────────
// Writes a rolling summary to memory/telegram-context.md so agents remember
// who they talked to and what was said across bridge restarts.

const MEMORY_DIR = join(process.cwd(), "memory");
const TG_CONTEXT_FILE = join(MEMORY_DIR, "telegram-context.md");
const TG_CONTEXT_MAX_TURNS = 30;
let persistedTurns = [];

function loadPersistedTurns() {
  try {
    const raw = readFileSync(TG_CONTEXT_FILE, "utf8");
    const match = raw.match(/<!-- turns:(.*?) -->/s);
    if (match) persistedTurns = JSON.parse(match[1]);
  } catch {}
}

function writeContextFile() {
  try {
    const lines = persistedTurns.slice(-TG_CONTEXT_MAX_TURNS).map(t =>
      `**${t.role === "user" ? (t.name || "User") : "CrewSwarm"}** (${t.ts.slice(0,16)}): ${t.text}`
    ).join("\n\n");
    const content = `# Telegram Conversation Context\n\nLast updated: ${new Date().toISOString()}\n\nThis file contains recent Telegram chat history. Use it to maintain continuity across sessions.\n\n---\n\n${lines}\n\n<!-- turns:${JSON.stringify(persistedTurns.slice(-TG_CONTEXT_MAX_TURNS))} -->`;
    writeFileSync(TG_CONTEXT_FILE, content);
  } catch {}
}

function persistTurn(role, text, name) {
  persistedTurns.push({ role, text: text.slice(0, 500), name, ts: new Date().toISOString() });
  if (persistedTurns.length > TG_CONTEXT_MAX_TURNS * 2) {
    persistedTurns = persistedTurns.slice(-TG_CONTEXT_MAX_TURNS);
  }
  writeContextFile();
}

// ── Telegram context memory (injected into every agent call via shared memory) ─

function writeTelegramContext(chatId, username, firstName) {
  const hist = getHistory(chatId);
  if (!hist.length) return;
  const recentTurns = hist.slice(-10);
  const displayName = firstName || username || "User";
  const lines = [
    `# Telegram Conversation Context`,
    ``,
    `**Active chat:** ${displayName} (chat ID: ${chatId})`,
    `**Last active:** ${new Date().toUTCString()}`,
    ``,
    `## Recent conversation`,
    ``,
    ...recentTurns.map(h => `**${h.role === "user" ? displayName : "You (crew-main)"}:** ${h.content}`),
    ``,
    `> This context is from the active Telegram conversation via @CrewSwarm_bot. Use it to maintain continuity.`,
  ];
  try { writeFileSync(TELEGRAM_CONTEXT_PATH, lines.join("\n"), "utf8"); } catch {}
}

// ── Telegram long poll loop ───────────────────────────────────────────────────

let offset = 0;

async function listenForAgentReplies() {
  const CREW_LEAD_EVENTS = `${CREW_LEAD_URL}/events`;
  while (true) {
    try {
      const res = await fetch(CREW_LEAD_EVENTS, { signal: AbortSignal.timeout(120000) });
      if (!res.body) { await new Promise(r => setTimeout(r, 5000)); continue; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const d = JSON.parse(line.slice(6));
            if (!d.from || !d.content) continue;
            // Skip if the raw content was already forwarded by the RT path
            let alreadySent = false;
            for (const [chatId] of activeSessions) {
              if (shouldSkipDuplicate(chatId, d.content)) { alreadySent = true; break; }
            }
            if (alreadySent) {
              log("info", "SSE reply already sent via RT path — skipping", { from: d.from });
              continue;
            }
            const preview = d.content.length > 300 ? d.content.slice(0, 300) + "…" : d.content;
            const msg = `✅ *${d.from}* finished:\n${preview}\n\nReply to follow up or dispatch more work.`;
            log("info", "Agent reply forwarded to Telegram (SSE)", { from: d.from });
            for (const [chatId] of activeSessions) {
              await tgSend(chatId, msg);
            }
          } catch {}
        }
      }
    } catch (e) {
      log("warn", "Agent reply SSE disconnected, retrying in 5s", { error: e.message });
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

async function pollLoop() {
  log("info", "Starting Telegram poll loop");
  while (true) {
    try {
      const updates = await tgRequest("getUpdates", {
        offset,
        timeout: POLL_TIMEOUT,
        allowed_updates: ["message"],
      });

      for (const update of updates) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text) continue;

        const chatId    = msg.chat.id;
        const text      = msg.text.trim();
        const username  = msg.from?.username || "";
        const firstName = msg.from?.first_name || "";

        // Allowlist check
        const allowed = getAllowedIds();
        if (allowed && !allowed.has(chatId)) {
          log("warn", "Blocked unauthorized sender", { chatId, username });
          await tgSend(chatId, "⛔ Unauthorized.");
          continue;
        }

        log("info", "Incoming Telegram message", { chatId, username, text: text.slice(0, 80) });
        logMessage({ direction: "inbound", chatId, username, firstName, text });

        // Track session so replies get routed back
        activeSessions.set(chatId, { username, firstName, lastSeen: Date.now() });

        // Handle slash commands — /projects, /project <name>, /home — don't forward to crew-lead
        if (text.startsWith("/")) {
          const handled = await handleCommand(chatId, text);
          if (handled) continue;
        }

        // Add to in-memory and persistent conversation history
        addToHistory(chatId, "user", text);
        persistTurn("user", text, firstName || username);

        const taskId        = randomUUID();
        const correlationId = randomUUID();
        const history       = formatHistory(chatId);

        // Inject active project context if set for this chat
        const activeProj = activeProjectByChatId.get(chatId);

        // Send to crew-lead HTTP server — each Telegram chatId gets its own session
        fetch(`${CREW_LEAD_URL}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(RT_TOKEN ? { authorization: `Bearer ${RT_TOKEN}` } : {}) },
          body: JSON.stringify({ message: text, sessionId: `telegram-${chatId}`, firstName: firstName || username, projectId: activeProj?.id || undefined }),
          signal: AbortSignal.timeout(65000),
        }).then(async r => {
          const d = await r.json();
          if (d.reply) {
            addToHistory(chatId, "assistant", d.reply);
            persistTurn("assistant", d.reply, "CrewSwarm");
            logMessage({ direction: "outbound", chatId, text: d.reply });
            lastReplyTime.set(chatId, Date.now());
            await tgSend(chatId, d.reply);
            if (d.dispatched) {
              await tgSend(chatId, `⚡ Dispatching to ${d.dispatched.agent}...`);
            }
          }
        }).catch(async e => {
          log("error", "crew-lead HTTP error", { error: e.message });
          await tgSend(chatId, `⚠️ crew-lead error: ${e.message.slice(0,100)}`);
        });
      }
    } catch (e) {
      log("error", "Poll error", { error: e.message });
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  // Load persisted conversation turns from disk
  loadPersistedTurns();
  log("info", `Loaded ${persistedTurns.length} persisted conversation turns`);

  // Verify bot token
  try {
    const me = await tgGetMe();
    log("info", `Telegram bot connected: @${me.username} (${me.first_name})`);
    console.log(`\n✅ Telegram bridge running`);
    console.log(`   Bot: @${me.username}`);
    console.log(`   RT:  ${RT_URL} (as ${AGENT_NAME})`);
    console.log(`   Routes to: ${TARGET}\n`);
  } catch (e) {
    log("error", "Bot token invalid", { error: e.message });
    process.exit(1);
  }

  // Connect RT bus in background — don't block polling
  connectRT().then(c => { rtClient = c; }).catch(e => {
    log("warn", "RT bus unavailable at startup — will retry", { error: e.message });
  });

  // Listen for agent replies from crew-lead SSE and forward to Telegram
  listenForAgentReplies();

  // Start polling immediately regardless of RT status
  await pollLoop();
}

main().catch(e => { console.error(e); process.exit(1); });
