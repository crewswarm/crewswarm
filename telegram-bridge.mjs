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
const RT_URL      = process.env.CREWSWARM_RT_URL    || env.CREWSWARM_RT_URL    || "ws://127.0.0.1:18889";
const RT_TOKEN    = process.env.CREWSWARM_RT_AUTH_TOKEN || env.CREWSWARM_RT_AUTH_TOKEN || "";
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

// ── Singleton guard — kill stale duplicate before writing our PID ──────────
try {
  if (existsSync(PID_PATH)) {
    const existingPid = parseInt(readFileSync(PID_PATH, "utf8").trim(), 10);
    if (existingPid && existingPid !== process.pid) {
      try {
        process.kill(existingPid, 0); // throws ESRCH if not running
        // Process IS running — kill it so we don't get duplicate replies
        process.kill(existingPid, "SIGTERM");
        log("warn", `Killed stale telegram-bridge (pid ${existingPid}) — only one instance allowed`);
        await new Promise(r => setTimeout(r, 500)); // let it die
      } catch (e) {
        if (e.code !== "ESRCH") log("warn", `Could not kill old bridge pid ${existingPid}: ${e.message}`);
        // ESRCH = already dead — just overwrite PID file
      }
    }
  }
} catch {}
writeFileSync(PID_PATH, String(process.pid));
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

async function tgAnswerCallbackQuery(callbackQueryId, text = "") {
  try {
    await tgRequest("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: text.slice(0, 180) || undefined,
      show_alert: false
    });
  } catch {}
}

async function tgEdit(chatId, messageId, text, replyMarkup) {
  await tgRequest("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: text.slice(0, 4000),
    parse_mode: "Markdown",
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  }).catch(() => tgRequest("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: text.slice(0, 4000),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  }));
}

// Dedupe: avoid sending the same long message twice (e.g. roadmap sent via reply and again via another path)
const lastSentByChat = new Map(); // chatId -> { content, ts }
const DEDUPE_WINDOW_MS = 30000;  // wider window to catch SSE + RT race
const DEDUPE_MIN_LEN = 80;       // catch shorter duplicates (RT + SSE race)

// Normalise to raw content so SSE-wrapped and RT-raw versions both match
function dedupeKey(text) {
  return text.replace(/^✅ \*.+?\* finished:\n/, "").replace(/\n\nReply to follow up.*$/s, "").trim();
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

// Check if raw content was already sent (e.g. RT sent it, now SSE would duplicate)
function wasRawContentAlreadySent(chatId, rawContent) {
  if (!rawContent || rawContent.length < 50) return false;
  const last = lastSentByChat.get(chatId);
  if (!last) return false;
  if (Date.now() - last.ts > DEDUPE_WINDOW_MS) return false;
  const lastKey = dedupeKey(last.content);
  return last.content === rawContent || lastKey === rawContent
    || (rawContent.length > 100 && lastKey.includes(rawContent.slice(0, 100)));
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

// ── Menu keyboards ───────────────────────────────────────────────────────────

function mainReplyKeyboard() {
  return {
    keyboard: [
      [{ text: "Chat crew-main" }, { text: "Direct engine" }, { text: "Bypass mode" }],
      [{ text: "Set engine" }, { text: "Set agent" }, { text: "Projects" }],
      [{ text: "Status" }, { text: "Help" }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

function engineInline() {
  return {
    inline_keyboard: [
      [{ text: "Cursor", callback_data: "eng:cursor" }, { text: "Claude", callback_data: "eng:claude" }],
      [{ text: "Codex", callback_data: "eng:codex" }, { text: "Gemini", callback_data: "eng:gemini" }],
      [{ text: "OpenCode", callback_data: "eng:opencode" }, { text: "Gemini", callback_data: "eng:gemini" }]
    ]
  };
}

function modeInline() {
  return {
    inline_keyboard: [
      [{ text: "Chat", callback_data: "mode:chat" }, { text: "Direct", callback_data: "mode:direct" }, { text: "Bypass", callback_data: "mode:bypass" }]
    ]
  };
}

function errorInline() {
  return {
    inline_keyboard: [
      [{ text: "Retry", callback_data: "retry:last" }, { text: "Fallback crew-main", callback_data: "fallback:main" }],
      [{ text: "Set engine", callback_data: "open:engine" }, { text: "Set mode", callback_data: "open:mode" }]
    ]
  };
}

async function tgGetMe() {
  return tgRequest("getMe");
}

// ── RT Bus client ─────────────────────────────────────────────────────────────

let rtClient = null;

// ── Callback query handler ───────────────────────────────────────────────────

async function handleCallback(q) {
  const chatId = q.message?.chat?.id;
  const messageId = q.message?.message_id;
  const data = String(q.data || "");
  if (!chatId) return;

  if (q.id) await tgAnswerCallbackQuery(q.id, "Updated");

  if (data.startsWith("mode:")) {
    const mode = data.slice(5);
    const next = setState(chatId, { mode });
    if (messageId) await tgEdit(chatId, messageId, `Mode set to *${next.mode}*`, modeInline());
    return;
  }

  if (data.startsWith("eng:")) {
    const engine = data.slice(4);
    const next = setState(chatId, { engine, mode: "direct" });
    if (messageId) await tgEdit(chatId, messageId, `Engine set to *${next.engine}* (mode: direct)`, engineInline());
    return;
  }
  
  if (data.startsWith("model:")) {
    const model = data.slice(6);
    if (model === "default") {
      const st = setState(chatId, { model: null });
      if (messageId) await tgEdit(chatId, messageId, `Model reset to default for *${st.engine}*`);
      return;
    }
    const st = setState(chatId, { model });
    if (messageId) await tgEdit(chatId, messageId, `Model set to *${model}* for *${st.engine}*`);
    return;
  }
  
  if (data.startsWith("proj:")) {
    const projectId = data.slice(5);
    
    // Handle special cases
    if (projectId === "none") {
      activeProjectByChatId.delete(chatId);
      if (messageId) await tgEdit(chatId, messageId, "✅ Back to general mode — no active project.");
      return;
    }
    if (projectId === "new") {
      if (messageId) await tgEdit(chatId, messageId, "📝 To create a new project, tell crew-lead:\n\n_\"Create a new project called X in directory Y\"_");
      return;
    }
    
    // Set active project
    try {
      const projects = await fetchProjects();
      const match = projects.find(p => p.id === projectId);
      if (!match) {
        if (messageId) await tgEdit(chatId, messageId, `❌ Project not found (id: ${projectId})`);
        return;
      }
      activeProjectByChatId.set(chatId, { id: match.id, name: match.name, outputDir: match.outputDir });
      const roadmap = match.roadmapFile ? `\nROADMAP: ${match.roadmapFile}` : "";
      if (messageId) await tgEdit(chatId, messageId, `✅ *${match.name}* is now the active project.\n📁 ${match.outputDir || "?"}${roadmap}`);
    } catch (e) {
      if (messageId) await tgEdit(chatId, messageId, `⚠️ Error: ${e.message}`);
    }
    return;
  }

  if (data.startsWith("retry:last")) {
    const st = getState(chatId);
    if (!st.lastPrompt) {
      await tgSend(chatId, "No last prompt found.");
      return;
    }
    await routeByState(chatId, st.lastPrompt);
    return;
  }

  if (data.startsWith("fallback:main")) {
    setState(chatId, { mode: "chat", agent: "crew-main" });
    const st = getState(chatId);
    await tgSend(chatId, "Switched to chat → crew-main fallback.");
    if (st.lastPrompt) await routeByState(chatId, st.lastPrompt);
    return;
  }

  if (data.startsWith("open:engine")) {
    const st = getState(chatId);
    await tgRequest("sendMessage", {
      chat_id: chatId,
      text: `Current engine: *${st.engine}*\n\nSelect engine:`,
      parse_mode: "Markdown",
      reply_markup: engineInline()
    });
    return;
  }

  if (data.startsWith("open:mode")) {
    const st = getState(chatId);
    await tgRequest("sendMessage", {
      chat_id: chatId,
      text: `Current mode: *${st.mode}*\n\nSelect mode:`,
      parse_mode: "Markdown",
      reply_markup: modeInline()
    });
    return;
  }
}

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

// ── Per-chat state for mode, engine, agent selection ─────────────────────────
const chatState = new Map(); // chatId -> { mode, engine, agent, projectId, lastPrompt, lastEngine, lastErrorType }
const pendingInput = new Map(); // chatId -> { kind: "engine_prompt"|"agent_task", value: string }

const DEFAULT_STATE = {
  mode: "chat",          // chat | direct | bypass
  engine: "cursor",      // cursor | claude | codex | opencode | gemini
  model: null,           // optional model override for engine
  agent: "crew-main",
  projectId: null,
  lastPrompt: "",
  lastEngine: "",
  lastErrorType: ""
};

function getState(chatId) {
  return { ...DEFAULT_STATE, ...(chatState.get(chatId) || {}) };
}
function setState(chatId, patch) {
  const next = { ...getState(chatId), ...patch };
  chatState.set(chatId, next);
  return next;
}

// ── Per-chat active project ───────────────────────────────────────────────────
// Set once via /project <name>, cleared via /project off or /home
// Persists for the lifetime of the bridge process (survives messages, not restarts)
const activeProjectByChatId = new Map(); // chatId → { id, name, outputDir }

const DASHBOARD_URL = process.env.DASHBOARD_URL || "http://127.0.0.1:4319";

// Auth token for crew-lead API calls (engine passthrough requires Bearer auth)
function getAuthToken() {
  try {
    const configPath = join(homedir(), ".crewswarm", "config.json");
    const c = JSON.parse(readFileSync(configPath, "utf8"));
    return c.rt?.authToken || "";
  } catch { return ""; }
}

async function fetchProjects() {
  const r = await fetch(`${DASHBOARD_URL}/api/projects`, { signal: AbortSignal.timeout(5000) });
  const d = await r.json();
  return d.projects || [];
}

// ── Engine passthrough from Telegram ─────────────────────────────────────────
// /claude <msg>, /cursor <msg>, /opencode <msg>, /codex <msg>
// Streams the response back to TG in chunks as it arrives.
const ENGINE_COMMANDS = { "/claude": "claude", "/cursor": "cursor", "/opencode": "opencode", "/codex": "codex", "/gemini": "gemini" };
const ENGINE_LABELS   = { claude: "🤖 Claude Code", cursor: "🖱 Cursor CLI", opencode: "⚡ OpenCode", codex: "🟣 Codex CLI", gemini: "✨ Gemini CLI" };

function classifyEngineFailure(text) {
  const s = String(text || "").toLowerCase();
  if (s.includes("rate limit") || s.includes("429") || s.includes("too many requests")) return "rate_limit";
  if (s.includes("hit your limit") || s.includes("quota") || s.includes("billing")) return "quota_limit";
  if (s.includes("auth") || s.includes("token") || s.includes("unauthorized")) return "auth";
  if (s.includes("no text output") || s.includes("completed with no text output")) return "empty_output";
  return "generic";
}

async function handleEnginePassthrough(chatId, engine, message) {
  const token = getAuthToken();
  const label = ENGINE_LABELS[engine] || engine;
  await tgSend(chatId, `${label} ⏳ _running..._`);
  setState(chatId, { lastPrompt: message, lastEngine: engine });
  try {
    const st = getState(chatId);
    const activeProj = activeProjectByChatId.get(chatId);
    const projectDir = activeProj?.outputDir || activeProj?.path || undefined;
    const sessionId = `telegram-${chatId}`;
    const payload = { engine, message, projectDir, sessionId };
    if (st.model) payload.model = st.model;
    const res = await fetch(`${CREW_LEAD_URL}/api/engine-passthrough`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300000), // 5 min
    });
    if (!res.ok) { await tgSend(chatId, `❌ ${label}: HTTP ${res.status}`); return; }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let fullText = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const d = JSON.parse(line.slice(6));
          if (d.type === "chunk" && d.text) fullText += d.text;
          if (d.type === "done") {
            const exitCode = d.exitCode ?? 0;
            const body = fullText.trim();
            if (exitCode !== 0) {
              const failText = body || "(no output returned)";
              const kind = classifyEngineFailure(failText);
              setState(chatId, { lastErrorType: kind });
              await tgRequest("sendMessage", {
                chat_id: chatId,
                text: `❌ ${label} failed (exit ${exitCode})\n\n${failText.slice(0, 2000)}`,
                reply_markup: errorInline()
              });
              return;
            }
            if (!body) {
              setState(chatId, { lastErrorType: "empty_output" });
              await tgRequest("sendMessage", {
                chat_id: chatId,
                text: `⚠️ ${label} completed with no text output.`,
                reply_markup: errorInline()
              });
              return;
            }
            await tgSend(chatId, `✅ ${label} (exit 0)\n\n${body}`);
            return;
          }
        } catch {}
      }
    }
    // Stream ended without done event
    if (fullText.trim()) await tgSend(chatId, `${label}\n\n${fullText.trim()}`);
  } catch (e) {
    const kind = classifyEngineFailure(e.message);
    setState(chatId, { lastErrorType: kind });
    await tgRequest("sendMessage", {
      chat_id: chatId,
      text: `❌ ${label} error: ${e.message}`,
      reply_markup: errorInline()
    });
  }
}

async function handleCommand(chatId, text) {
  const lower = text.toLowerCase().trim();

  // /menu — show main keyboard
  if (lower === "/menu") {
    await tgRequest("sendMessage", {
      chat_id: chatId,
      text: "Main menu — tap buttons to navigate:",
      reply_markup: mainReplyKeyboard()
    });
    return true;
  }

  // /miniapp — open Mini App control deck
  if (lower === "/miniapp" || lower === "/app" || lower === "/ui") {
    // Get current state to pre-populate Mini App
    const st = getState(chatId);
    const activeProj = activeProjectByChatId.get(chatId);
    
    // Fetch projects for Mini App
    let projects = [];
    try {
      projects = await fetchProjects();
    } catch (e) {
      log("warn", "Could not fetch projects for Mini App", { error: e.message });
    }

    // For now, show instructions - actual Mini App button requires hosting the HTML
    const projectsJson = JSON.stringify(projects.map(p => ({ id: p.id, name: p.name })));
    await tgSend(chatId, `🎛 *CrewSwarm Mini App Control Deck*

Current state:
• Mode: ${st.mode}
• Engine: ${st.engine}
• Agent: ${st.agent}
${activeProj ? `• Project: ${activeProj.name}` : '• Project: none'}

To enable Mini App button:
1. Host \`crew-cli/docs/telegram-miniapp/\` on a public HTTPS URL
2. Set bot menu button via \`setChatMenuButton\`
3. Projects will auto-populate from /api/projects

For now, use /menu for button controls or direct commands.`);
    return true;
  }

  // /mode — inline mode selector
  if (lower === "/mode") {
    const st = getState(chatId);
    await tgRequest("sendMessage", {
      chat_id: chatId,
      text: `Current mode: *${st.mode}*\n\nSelect mode:`,
      parse_mode: "Markdown",
      reply_markup: modeInline()
    });
    return true;
  }

  // /engine — inline engine selector
  if (lower === "/engine") {
    const st = getState(chatId);
    await tgRequest("sendMessage", {
      chat_id: chatId,
      text: `Current engine: *${st.engine}*\n\nSelect engine:`,
      parse_mode: "Markdown",
      reply_markup: engineInline()
    });
    return true;
  }

  // /models — show model options and set defaults
  if (lower === "/models" || lower === "/model") {
    const st = getState(chatId);
    const engineModels = {
      cursor: ["gemini-3-flash", "gemini-3-pro", "opus-4.6-thinking", "sonnet-4.6"],
      claude: ["claude-sonnet-4.5", "claude-opus-4", "claude-haiku-3.5"],
      codex: ["gpt-5", "gpt-4o", "gpt-4o-mini"],
      gemini: ["gemini-2.5-flash", "gemini-2.0-flash-exp", "gemini-3-flash", "gemini-3-pro"],
      opencode: ["kimi-k2", "grok-4-fast", "deepseek-chat", "gemini-2.5-flash"]
    };
    
    const models = engineModels[st.engine] || ["deepseek-chat", "gemini-2.0-flash-exp"];
    const keyboard = models.map(m => [{ text: m, callback_data: `model:${m}` }]);
    keyboard.push([{ text: "🔙 Back", callback_data: "model:default" }]);
    
    await tgRequest("sendMessage", {
      chat_id: chatId,
      text: `*Model for ${st.engine}:*\n\nSelect model:`,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard }
    });
    return true;
  }

  // /status — show current state
  if (lower === "/status") {
    const st = getState(chatId);
    const activeProj = activeProjectByChatId.get(chatId);
    const projPath = activeProj?.outputDir || activeProj?.path;
    const projLine = activeProj ? `📁 *Project:* ${activeProj.name} (${projPath || "?"})` : "📁 *Project:* none (general mode)";
    await tgSend(chatId, `*Current state:*\n\n🔧 *Mode:* ${st.mode}\n⚙️ *Engine:* ${st.engine}\n🤖 *Agent:* ${st.agent}\n${projLine}`);
    return true;
  }

  // /claude <msg>, /cursor <msg>, /opencode <msg>, /codex <msg> — direct engine passthrough
  for (const [cmd, engine] of Object.entries(ENGINE_COMMANDS)) {
    if (lower.startsWith(cmd + " ") || lower === cmd) {
      const message = text.slice(cmd.length).trim();
      if (!message) {
        await tgSend(chatId, `Usage: \`${cmd} <your message>\`\n\nSends your message directly to ${ENGINE_LABELS[engine]} and streams the reply back here.`);
        return true;
      }
      handleEnginePassthrough(chatId, engine, message).catch(() => {});
      return true;
    }
  }

  // /engines — list available engines + usage
  if (lower === "/engines" || lower === "/cli" || lower === "/direct") {
    const lines = Object.entries(ENGINE_LABELS).map(([k, v]) => `${v} → \`/${k} <message>\``);
    await tgSend(chatId, `*Direct engine passthrough:*\n\n${lines.join("\n")}\n\n_Bypasses crew-lead — sends directly to the CLI tool and streams the reply._`);
    return true;
  }

  // /projects — list all registered projects with inline buttons
  if (lower === "/projects" || lower === "/project") {
    try {
      const projects = await fetchProjects();
      if (!projects.length) {
        await tgSend(chatId, "No projects registered yet. Create one via the dashboard or by chatting with crew-lead.");
        return true;
      }
      const current = activeProjectByChatId.get(chatId);
      
      // Create inline keyboard with project buttons (max 3 columns)
      const buttons = projects.map(p => {
        const active = current && current.id === p.id ? "✅ " : "";
        return { text: active + p.name, callback_data: `proj:${p.id}` };
      });
      
      // Split into rows of 2 buttons each
      const keyboard = [];
      for (let i = 0; i < buttons.length; i += 2) {
        keyboard.push(buttons.slice(i, i + 2));
      }
      // Add "None" and "New" buttons in last row
      keyboard.push([
        { text: "🏠 None (general mode)", callback_data: "proj:none" },
        { text: "➕ New Project", callback_data: "proj:new" }
      ]);
      
      const msg = `*Select project (${projects.length}):*\n\n${current ? `Current: *${current.name}*` : 'None selected'}`;
      await tgRequest("sendMessage", {
        chat_id: chatId,
        text: msg,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard }
      });
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
            // If reply has sessionId "telegram-<chatId>", route only to that chat
            const telegramChatId = sessionId?.startsWith("telegram-")
              ? parseInt(sessionId.slice(9), 10) : null;
            const targetSessions = telegramChatId && !isNaN(telegramChatId) && activeSessions.has(telegramChatId)
              ? [[telegramChatId, activeSessions.get(telegramChatId)]]
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

// ── Unified routing by chat state ─────────────────────────────────────────────

async function routeByState(chatId, text) {
  const st = setState(chatId, { lastPrompt: text, lastEngine: getState(chatId).engine });
  if (st.mode === "direct") {
    await handleEnginePassthrough(chatId, st.engine, text);
    return;
  }
  if (st.mode === "bypass") {
    // TODO: implement bypass dispatch via crew-lead /api/dispatch with direct=true, bypass=true
    await tgSend(chatId, `⚠️ Bypass mode not yet implemented. Falling back to chat mode.`);
    await dispatchChat(chatId, text, st.agent || "crew-main");
    return;
  }
  await dispatchChat(chatId, text, st.agent || "crew-main");
}

async function dispatchChat(chatId, text, agent = "crew-main") {
  const taskId = randomUUID();
  const history = formatHistory(chatId);
  const activeProj = activeProjectByChatId.get(chatId);

  // Add to conversation history
  addToHistory(chatId, "user", text);
  persistTurn("user", text, activeSessions.get(chatId)?.firstName || "User");

  // Send to crew-lead HTTP server
  fetch(`${CREW_LEAD_URL}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(RT_TOKEN ? { authorization: `Bearer ${RT_TOKEN}` } : {}) },
    body: JSON.stringify({ message: text, sessionId: `telegram-${chatId}`, firstName: activeSessions.get(chatId)?.firstName || "User", projectId: activeProj?.id || undefined }),
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

// ── Mini App data handler ─────────────────────────────────────────────────────

async function handleMiniAppData(msg) {
  const chatId = msg.chat.id;
  const username = msg.from?.username || "";
  const firstName = msg.from?.first_name || "";
  
  let payload;
  try {
    payload = JSON.parse(msg.web_app_data.data);
  } catch (e) {
    await tgSend(chatId, `❌ Invalid Mini App payload: ${e.message}`);
    return;
  }

  // Allowlist check
  const allowed = getAllowedIds();
  if (allowed && !allowed.has(chatId)) {
    log("warn", "Blocked unauthorized Mini App request", { chatId, username });
    await tgSend(chatId, "⛔ Unauthorized.");
    return;
  }

  log("info", "Mini App payload received", { chatId, username, payload });

  // Track session
  activeSessions.set(chatId, { username, firstName, lastSeen: Date.now() });

  // Validate payload structure
  if (payload.type !== "crew_miniapp") {
    await tgSend(chatId, `❌ Unknown payload type: ${payload.type}`);
    return;
  }

  // Update chat state from Mini App controls
  setState(chatId, {
    mode: payload.mode || "chat",
    engine: payload.engine || "cursor",
    agent: payload.agent || "crew-main",
    projectId: payload.projectId || null
  });

  // Handle action
  if (payload.action === "message" && payload.prompt) {
    // Update project context if specified
    if (payload.projectId) {
      try {
        const projects = await fetchProjects();
        const match = projects.find(p => p.id === payload.projectId || p.name === payload.projectId);
        if (match) {
          activeProjectByChatId.set(chatId, { id: match.id, name: match.name, outputDir: match.outputDir });
        }
      } catch (e) {
        log("warn", "Could not fetch projects for Mini App context", { error: e.message });
      }
    }
    
    // Route the prompt using state
    await routeByState(chatId, payload.prompt);
    return;
  }

  if (payload.action === "get_status") {
    const st = getState(chatId);
    const activeProj = activeProjectByChatId.get(chatId);
    const projLine = activeProj ? `📁 *Project:* ${activeProj.name}` : "📁 *Project:* none";
    await tgSend(chatId, `*Mini App State:*\n\n🔧 *Mode:* ${st.mode}\n⚙️ *Engine:* ${st.engine}\n🤖 *Agent:* ${st.agent}\n${projLine}`);
    return;
  }

  await tgSend(chatId, `❌ Unknown Mini App action: ${payload.action}`);
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
            // Route to specific chat if sessionId is "telegram-<chatId>"
            const telegramChatId = d.sessionId?.startsWith("telegram-")
              ? parseInt(d.sessionId.slice(9), 10) : null;
            const targetChatIds = telegramChatId && !isNaN(telegramChatId) && activeSessions.has(telegramChatId)
              ? [telegramChatId] : [...activeSessions.keys()];
            for (const chatId of targetChatIds) {
              if (wasRawContentAlreadySent(chatId, d.content)) {
                log("info", "SSE reply already sent via RT path — skipping", { chatId, from: d.from });
                continue;
              }
              const preview = d.content.length > 300 ? d.content.slice(0, 300) + "…" : d.content;
              const msg = `✅ *${d.from}* finished:\n${preview}\n\nReply to follow up or dispatch more work.`;
              log("info", "Agent reply forwarded to Telegram (SSE)", { chatId, from: d.from });
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
        allowed_updates: ["message", "callback_query"],
      });

      for (const update of updates) {
        offset = update.update_id + 1;

        // Handle callback queries (button clicks)
        if (update.callback_query) {
          await handleCallback(update.callback_query);
          continue;
        }

        const msg = update.message;
        
        // Handle Mini App data (web_app_data)
        if (msg?.web_app_data?.data) {
          await handleMiniAppData(msg);
          continue;
        }
        
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

        // Route by current chat state (mode, engine, agent)
        await routeByState(chatId, text);
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
    
    // Set bot commands menu
    await tgRequest("setMyCommands", {
      commands: [
        { command: "menu", description: "Show quick menu" },
        { command: "mode", description: "Select chat/direct/bypass mode" },
        { command: "engine", description: "Select direct engine" },
        { command: "status", description: "Show current state" },
        { command: "projects", description: "List projects" },
        { command: "miniapp", description: "Open Mini App control deck" },
        { command: "home", description: "Clear project context" }
      ]
    });
    
    // Mini App removed - use /menu for button controls instead
    
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
