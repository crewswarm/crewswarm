#!/usr/bin/env node
/**
 * whatsapp-bridge.mjs — Connects WhatsApp to the crewswarm RT bus.
 *
 * Personal bot approach (WhatsApp Web automation via Baileys).
 * Your phone number becomes a "linked device" — same as the WhatsApp
 * Web / Desktop experience. No Business API or Meta approval needed.
 *
 * What it does:
 *   1. On first run: prints a QR code → scan with WhatsApp on your phone
 *   2. Connects to the RT bus (18889) as "crew-whatsapp"
 *   3. Forwards incoming messages → crew-lead
 *   4. Listens for crew-lead responses → sends them back to WhatsApp
 *
 * Auth persists in ~/.crewswarm/whatsapp-auth/ — no re-scan after restart.
 *
 * Usage:
 *   node whatsapp-bridge.mjs
 *
 * Allowed senders (allowlist):
 *   Set WA_ALLOWED_NUMBERS=+15551234567,+15559876543 in env or crewswarm.json
 *   Leave empty to allow any sender (open bot — not recommended).
 *
 * Commands (same as Telegram bridge):
 *   /projects           — list registered projects
 *   /project <name>     — set active project context
 *   /home               — clear active project
 *   /status             — show bridge status
 */

import { createRequire } from "node:module";
import {
  readFileSync, writeFileSync, existsSync,
  appendFileSync, mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import http from "node:http";
import WebSocket from "ws";
import { loadHistory, appendHistory } from "./lib/chat/history.mjs";
import { shouldUseUnifiedHistory, formatUnifiedHistory } from "./lib/chat/unified-history.mjs";
import { trackContact, getContact, updatePreferences, saveMessage as saveContactMessage } from "./lib/contacts/index.mjs";
import { extractPreferences, shouldExtract, buildPreferencePrompt } from "./lib/preferences/extractor.mjs";
import { analyzeImage, transcribeAudio, hasVisionProvider, hasAudioProvider } from "./lib/integrations/multimodal.mjs";
import { textToSpeech, hasTTSProvider, chunkTextForTTS, getVoiceForAgent } from "./lib/integrations/tts.mjs";
import { execCrewLeadTools } from "./lib/crew-lead/tools.mjs";
import { buildToolInstructions, hasEngineConfigured, getToolPermissions } from "./lib/agents/tool-instructions.mjs";
import { getPlatformFormatting } from "./lib/agents/platform-formatting.mjs";
import { saveBridgeMessage } from "./lib/bridges/integration.mjs";
import { enrichTwitterLinks } from "./lib/integrations/twitter-links.mjs";
import { applySharedChatPromptOverlay } from "./lib/chat/shared-chat-prompt-overlay.mjs";

const require = createRequire(import.meta.url);

// ── Config ─────────────────────────────────────────────────────────────────────

const CREW_CFG_PATH  = join(homedir(), ".crewswarm", "crewswarm.json");
const WA_AUTH_DIR    = join(homedir(), ".crewswarm", "whatsapp-auth");
const LOG_PATH       = join(homedir(), ".crewswarm", "logs", "whatsapp-bridge.jsonl");
const PID_PATH       = join(homedir(), ".crewswarm", "logs", "whatsapp-bridge.pid");
const MSG_LOG        = join(homedir(), ".crewswarm", "logs", "whatsapp-messages.jsonl");
const CONTEXT_FILE   = join(process.cwd(), "memory", "whatsapp-context.md");

mkdirSync(join(homedir(), ".crewswarm", "logs"), { recursive: true });
mkdirSync(WA_AUTH_DIR, { recursive: true });

function loadCfg() {
  try { return JSON.parse(readFileSync(CREW_CFG_PATH, "utf8")); } catch {}
  return {};
}
const cfg = loadCfg();
const env = cfg.env || {};

const RT_URL        = process.env.CREWSWARM_RT_URL        || env.CREWSWARM_RT_URL        || "ws://127.0.0.1:18889";
const RT_TOKEN      = process.env.CREWSWARM_RT_AUTH_TOKEN || env.CREWSWARM_RT_AUTH_TOKEN || (() => {
  // Fall back to ~/.crewswarm/crewswarm.json → rt.authToken (canonical location)
  try {
    const c = JSON.parse(readFileSync(join(homedir(), ".crewswarm", "crewswarm.json"), "utf8"));
    return c?.rt?.authToken || "";
  } catch { return ""; }
})();
const CREW_LEAD_URL = process.env.CREW_LEAD_URL          || "http://127.0.0.1:5010";
const DASHBOARD_URL = process.env.DASHBOARD_URL          || "http://127.0.0.1:4319";
const AGENT_NAME    = "crew-whatsapp";
const TARGET        = process.env.WA_TARGET_AGENT        || env.WA_TARGET_AGENT        || "crew-lead";
const HTTP_PORT     = parseInt(process.env.WA_HTTP_PORT  || env.WA_HTTP_PORT           || "5015", 10);

// Allowlist — phone numbers in international format, e.g. "+15551234567"
// Numbers are normalised to JID format: "15551234567@s.whatsapp.net"

// Contact names — loaded from whatsapp-bridge.json (saved by dashboard)
const WA_BRIDGE_CFG_PATH = join(homedir(), ".crewswarm", "whatsapp-bridge.json");

function loadAllowedNumbers() {
  // 1. Check env var first (backward compatibility)
  const fromEnv = process.env.WA_ALLOWED_NUMBERS || env.WA_ALLOWED_NUMBERS || "";
  if (fromEnv) {
    return fromEnv.split(",").map(s => s.trim()).filter(Boolean);
  }
  
  // 2. Fall back to whatsapp-bridge.json (dashboard-set)
  try {
    const c = JSON.parse(readFileSync(WA_BRIDGE_CFG_PATH, "utf8"));
    return c.allowedNumbers || [];
  } catch { return []; }
}

function loadUserRouting() {
  try {
    const c = JSON.parse(readFileSync(WA_BRIDGE_CFG_PATH, "utf8"));
    return c.userRouting || {};
  } catch { return {}; }
}

// TTS configuration
function getTTSConfig() {
  try {
    const c = JSON.parse(readFileSync(WA_BRIDGE_CFG_PATH, "utf8"));
    return c.tts || { enabled: false, provider: "auto", perUserOverrides: {} };
  } catch { 
    return { enabled: false, provider: "auto", perUserOverrides: {} };
  }
}

// Check if TTS is enabled for a specific user
function isTTSEnabled(jid) {
  const config = getTTSConfig();
  
  // Check per-user override first
  if (config.perUserOverrides && config.perUserOverrides[jid] !== undefined) {
    return config.perUserOverrides[jid];
  }
  
  // Fall back to global setting
  return config.enabled === true;
}

const ALLOWED_RAW = loadAllowedNumbers();
const ALLOWED_JIDS = new Set(
  ALLOWED_RAW.map(s => s.replace(/^\+/, ""))
    .filter(Boolean)
    .map(n => `${n}@s.whatsapp.net`)
);
const ALLOWLIST_ENABLED = ALLOWED_JIDS.size > 0;

// Per-user routing: maps "+1234..." or "1234...@s.whatsapp.net" → agent name
const USER_ROUTING = loadUserRouting();

// Resolve which agent a specific JID should talk to
function getTargetAgent(jid, sock) {
  // Check JID format first: "15551234567@s.whatsapp.net" → agent
  if (USER_ROUTING[jid]) return USER_ROUTING[jid];

  // Extract digits from JID
  let digits = jid.split("@")[0];
  
  // Handle @lid (self-chat) — map to the owner's real number
  if (jid.endsWith("@lid") && sock?.user?.id) {
    digits = sock.user.id.split(":")[0];
  }

  // Check phone format: "+15551234567" → agent
  if (USER_ROUTING[`+${digits}`]) return USER_ROUTING[`+${digits}`];
  if (USER_ROUTING[digits]) return USER_ROUTING[digits];

  // Fall back to default TARGET
  return TARGET;
}

function loadContactNames() {
  try {
    const c = JSON.parse(readFileSync(WA_BRIDGE_CFG_PATH, "utf8"));
    return c.contactNames || {};
  } catch { return {}; }
}
// Resolve a JID like "15551234567@s.whatsapp.net" → "Jeff" or "+15551234567"
// Also handles @lid (self-chat) by looking up the bot's actual number
function resolveDisplayName(jid, sock) {
  let digits = jid.split("@")[0];
  
  // Handle @lid (self-chat) — map to the owner's real number
  if (jid.endsWith("@lid") && sock?.user?.id) {
    digits = sock.user.id.split(":")[0];
  }
  
  const names = loadContactNames();
  return names[digits] || names[`+${digits}`] || `+${digits}`;
}

// ── Logging ────────────────────────────────────────────────────────────────────

function log(level, msg, data = {}) {
  const entry = { ts: new Date().toISOString(), level, msg, ...data };
  console.log(`[whatsapp-bridge] [${level}] ${msg}`, Object.keys(data).length ? data : "");
  try { appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n"); } catch {}
}

// ── Singleton guard — kill stale duplicate before writing our PID ──────────
try {
  if (existsSync(PID_PATH)) {
    const existingPid = parseInt(readFileSync(PID_PATH, "utf8").trim(), 10);
    if (existingPid && existingPid !== process.pid) {
      try {
        process.kill(existingPid, 0); // throws ESRCH if not running
        process.kill(existingPid, "SIGTERM");
        log("warn", `Killed stale whatsapp-bridge (pid ${existingPid}) — only one instance allowed`);
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        if (e.code !== "ESRCH") log("warn", `Could not kill old bridge pid ${existingPid}: ${e.message}`);
      }
    }
  }
} catch {}
writeFileSync(PID_PATH, String(process.pid));
process.on("exit", () => { try { writeFileSync(PID_PATH, ""); } catch {} });

// ── Message helpers ────────────────────────────────────────────────────────────

function logMessage({ direction, jid, text }) {
  const entry = { ts: new Date().toISOString(), direction, jid, text };
  try { appendFileSync(MSG_LOG, JSON.stringify(entry) + "\n"); } catch {}
}

function splitMessage(text, maxLen = 4000) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let i = 0;
  while (i < text.length) { chunks.push(text.slice(i, i + maxLen)); i += maxLen; }
  return chunks;
}

// ── Deduplication (prevent RT + SSE double-send) ──────────────────────────────

const lastSentByJid = new Map();
const DEDUPE_WINDOW_MS = 30000;
const DEDUPE_MIN_LEN = 200;

function dedupeKey(text) {
  return text.replace(/^✅ \*.+?\* finished:\n/, "").trim();
}

function shouldSkipDuplicate(jid, text) {
  if (!text) return false;
  const key = dedupeKey(text);
  if (key.length < DEDUPE_MIN_LEN) return false;
  const last = lastSentByJid.get(jid);
  if (!last || Date.now() - last.ts > DEDUPE_WINDOW_MS) return false;
  const lk = dedupeKey(last.content);
  return lk === key || (lk.length > 200 && key.length > 200 && lk.slice(0, 200) === key.slice(0, 200));
}

// ── Conversation history — NOW PERSISTENT (uses lib/chat/history.mjs) ─────────
// History survives restarts and is shared with crew-lead's session system
// Format: ~/.crewswarm/chat-history/whatsapp/{jid}.jsonl
// Each WhatsApp user gets isolated, persistent history (last 2000 messages)

function getHistory(jid) {
  const contactId = `whatsapp:${jid}`;
  
  // Check if this user has unified identity enabled
  if (shouldUseUnifiedHistory(contactId)) {
    // Load unified history from all linked platforms
    return formatUnifiedHistory(contactId);
  }
  
  // Otherwise, use platform-specific history (existing behavior)
  return loadHistory("whatsapp", jid);
}

function addToHistory(jid, role, content, agent = null) {
  appendHistory("whatsapp", jid, role, content, agent);
}

function formatHistory(jid) {
  const hist = getHistory(jid);
  if (!hist.length) return "";
  return "\n\n--- Conversation history ---\n" +
    hist.map(h => `${h.role === "user" ? "User" : "You"}: ${h.content}`).join("\n") +
    "\n--- End history ---";
}

// ── Persistent context file (for agent memory injection) ──────────────────────

const MAX_CONTEXT_TURNS = 30;
let persistedTurns = [];

function loadPersistedTurns() {
  try {
    const raw = readFileSync(CONTEXT_FILE, "utf8");
    const match = raw.match(/<!-- turns:(.*?) -->/s);
    if (match) persistedTurns = JSON.parse(match[1]);
  } catch {}
}

function writeContextFile() {
  try {
    const lines = persistedTurns.slice(-MAX_CONTEXT_TURNS).map(t =>
      `**${t.role === "user" ? (t.name || "User") : "crewswarm"}** (${t.ts.slice(0,16)}): ${t.text}`
    ).join("\n\n");
    const content = [
      "# WhatsApp Conversation Context",
      "",
      `Last updated: ${new Date().toISOString()}`,
      "",
      "Recent WhatsApp chat history for agent memory continuity.",
      "",
      "---",
      "",
      lines,
      "",
      `<!-- turns:${JSON.stringify(persistedTurns.slice(-MAX_CONTEXT_TURNS))} -->`,
    ].join("\n");
    writeFileSync(CONTEXT_FILE, content, "utf8");
  } catch {}
}

function persistTurn(role, text, name) {
  persistedTurns.push({ role, text: text.slice(0, 500), name, ts: new Date().toISOString() });
  if (persistedTurns.length > MAX_CONTEXT_TURNS * 2) {
    persistedTurns = persistedTurns.slice(-MAX_CONTEXT_TURNS);
  }
  writeContextFile();
}

// ── Active sessions (JID → metadata) ─────────────────────────────────────────

const activeSessions = new Map();
const lastReplyTime = new Map();
const activeProjectByJid = new Map();

// ── Project helpers ───────────────────────────────────────────────────────────

async function fetchProjects() {
  const r = await fetch(`${DASHBOARD_URL}/api/projects`, { signal: AbortSignal.timeout(5000) });
  const d = await r.json();
  return d.projects || [];
}

// ── RT Bus ────────────────────────────────────────────────────────────────────

let rtClient = null;
let reconnectTimer = null; // Track reconnect timer to prevent duplicates
let connecting = false; // Prevent concurrent connection attempts
let reconnectAttempts = 0; // For exponential backoff

function connectRT(sendToJid) {
  // Prevent duplicate connections
  if (connecting) {
    log("warn", "RT connection already in progress, skipping", { stack: new Error().stack.split('\n').slice(1,4).join('\n') });
    return Promise.reject(new Error("Connection in progress"));
  }
  
  log("info", "connectRT called", { connecting, hasClient: !!rtClient, attempt: reconnectAttempts + 1 });
  
  // Clear any pending reconnect
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    log("info", "Cleared pending reconnect timer");
  }
  
  connecting = true;
  
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

    ws.on("open", () => {
      log("info", "RT socket open", { timestamp: new Date().toISOString() });
    });

    ws.on("message", async (raw) => {
      let p;
      try { p = JSON.parse(raw.toString()); } catch { return; }

      if (p.type === "server.hello") {
        ws.send(JSON.stringify({ type: "hello", agent: AGENT_NAME, token: RT_TOKEN }));
        return;
      }

      if (p.type === "hello.ack") {
        ws.send(JSON.stringify({ type: "subscribe", channels: ["command", "assign", "done", "status", "events"] }));
        ready = true;
        connecting = false; // Connection successful
        resolve(client);
        log("info", `RT connected as ${AGENT_NAME}`, { timestamp: new Date().toISOString() });
        return;
      }

      if (p.type === "message" && p.envelope) {
        const env = p.envelope;
        if (env.messageId) client.ack({ messageId: env.messageId });

        const from    = env.from || env.sender_agent_id || "";
        const content = env.payload?.content ? String(env.payload.content).trim() : "";
        const isChatReply = env.messageType === "chat.reply" || env.type === "chat.reply";
        const rawSessionId = env.payload?.sessionId;
        
        // Extract JID from sessionId format "whatsapp-<jid>" — STRICT: reject non-whatsapp sessions
        const sessionId = rawSessionId?.startsWith("whatsapp-")
          ? rawSessionId.slice(9)  // Extract JID: "whatsapp-13109...@s.whatsapp.net" → "13109...@s.whatsapp.net"
          : null;  // Not a WhatsApp session — do NOT fall through

        if ((from === TARGET || isChatReply) && content && content.length > 2) {
          const isHeartbeat = env.type === "agent.heartbeat" || env.channel === "status";
          const isTaskNoise = content.startsWith("@@DISPATCH") || content.startsWith("[bridge]");
          if (!isHeartbeat && !isTaskNoise) {
            // CRITICAL: Only send to the specific session, NEVER broadcast to all
            // The sessionId must match exactly to prevent sending to wrong contacts
            if (sessionId && activeSessions.has(sessionId)) {
              const jid = sessionId;
              // Allowlist check on outbound — never send to unauthorized JIDs
              if (ALLOWLIST_ENABLED && !ALLOWED_JIDS.has(jid)) {
                log("warn", "RT reply blocked by allowlist — not sending to unauthorized JID", { jid, from });
                return;
              }
              const lastReply = lastReplyTime.get(jid) || 0;
              if (Date.now() - lastReply < 2000) {
                // Skip - too soon after last reply (debounce)
              } else {
                lastReplyTime.set(jid, Date.now());
                log("info", "Forwarding crew-lead reply to WhatsApp", { jid, preview: content.slice(0, 80) });
                addToHistory(jid, "assistant", content);
                persistTurn("assistant", content, "crewswarm");
                logMessage({ direction: "outbound", jid, text: content });
                await sendToJid(jid, content);
              }
            } else {
              log("warn", "Reply without valid sessionId - NOT sending to prevent wrong recipient", { rawSessionId, sessionId, from, hasSession: !!activeSessions.has(sessionId) });
            }
          }
        }
      }
    });

    ws.on("error", (e) => { 
      log("error", "RT error", { error: e.message }); 
      connecting = false;
      if (!ready) reject(e); 
    });

    ws.on("close", (code, reason) => {
      const wasReady = ready;
      ready = false;
      rtClient = null;
      connecting = false;
      
      // If code 1000 and reason is "replaced", don't reconnect - we got evicted by our own new connection
      if (code === 1000 && reason && reason.toString().includes("replaced")) {
        log("info", "RT socket evicted by newer connection, not reconnecting");
        reconnectAttempts = 0; // Reset counter on clean replacement
        return;
      }
      
      // Exponential backoff: 3s, 6s, 12s, 24s, max 30s
      reconnectAttempts++;
      const backoffMs = Math.min(3000 * Math.pow(2, Math.min(reconnectAttempts - 1, 3)), 30000);
      
      log("warn", `RT socket closed (code ${code}), reconnecting in ${backoffMs/1000}s (attempt ${reconnectAttempts})`, { wasReady, reason: reason?.toString() });
      
      if (!wasReady) reject(new Error("RT closed before ready"));
      
      // Reconnect after exponential backoff delay
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectRT(sendToJid).then(c => { 
          rtClient = c; 
          reconnectAttempts = 0; // Reset on successful connection
        }).catch(() => {});
      }, backoffMs);
    });
  });
}

// ── SSE listener (crew-lead /events) ─────────────────────────────────────────

async function listenForAgentReplies(sendToJid) {
  const EVENTS_URL = `${CREW_LEAD_URL}/events`;
  while (true) {
    try {
      const res = await fetch(EVENTS_URL, { signal: AbortSignal.timeout(120000) });
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
            // Route to specific contact if sessionId is "whatsapp-<jid>"
            const whatsappJid = d.sessionId?.startsWith("whatsapp-")
              ? d.sessionId.slice(9) : null;
            
            // CRITICAL: Only send to the matched JID, NEVER broadcast to all sessions
            if (!whatsappJid || !activeSessions.has(whatsappJid)) {
              log("warn", "SSE reply without valid sessionId - NOT sending to prevent wrong recipient", { 
                sessionId: d.sessionId, 
                from: d.from,
                hasSession: whatsappJid ? activeSessions.has(whatsappJid) : false
              });
              continue;
            }
            
            const jid = whatsappJid;
            // Allowlist check on outbound — never send to unauthorized JIDs
            if (ALLOWLIST_ENABLED && !ALLOWED_JIDS.has(jid)) {
              log("warn", "SSE reply blocked by allowlist — not sending to unauthorized JID", { jid, from: d.from });
              continue;
            }
            if (shouldSkipDuplicate(jid, d.content)) {
              log("info", "SSE reply already sent via RT path — skipping", { jid, from: d.from });
              continue;
            }
            const preview = d.content.length > 300 ? d.content.slice(0, 300) + "…" : d.content;
            const msg = `✅ *${d.from}* finished:\n${preview}\n\nReply to follow up.`;
            log("info", "Agent reply forwarded to WhatsApp (SSE)", { jid, from: d.from });
            await sendToJid(jid, msg);
          } catch {}
        }
      }
    } catch (e) {
      log("warn", "SSE disconnected, retrying in 5s", { error: e.message });
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ── Slash command handler ─────────────────────────────────────────────────────

async function handleCommand(jid, text, sendToJid) {
  const lower = text.toLowerCase().trim();

  if (lower === "/status") {
    const rtOk = rtClient?.isReady() ? "✅ connected" : "⚠️ disconnected";
    const sessions = [...activeSessions.keys()].length;
    await sendToJid(jid, `*crewswarm WhatsApp Bridge*\n\nRT bus: ${rtOk}\nActive sessions: ${sessions}\nTarget: ${TARGET}\nAllowlist: ${ALLOWLIST_ENABLED ? `${ALLOWED_JIDS.size} numbers` : "open"}`);
    return true;
  }

  if (lower === "/projects" || lower === "/project") {
    try {
      const projects = await fetchProjects();
      if (!projects.length) {
        await sendToJid(jid, "No projects registered yet. Create one via the dashboard.");
        return true;
      }
      const current = activeProjectByJid.get(jid);
      const lines = projects.map(p => {
        const active = current && current.id === p.id ? " ✅" : "";
        const pct = p.roadmap?.total ? Math.round((p.roadmap.done / p.roadmap.total) * 100) : 0;
        return `• *${p.name}*${active} — ${pct}% done\n  /project ${p.name}\n  📁 ${p.outputDir || "?"}`;
      });
      await sendToJid(jid, `*Projects (${projects.length}):*\n\n${lines.join("\n\n")}\n\n_Use /project <name> to set context. /home to clear._`);
    } catch (e) {
      await sendToJid(jid, `⚠️ Could not fetch projects: ${e.message}`);
    }
    return true;
  }

  if (lower === "/home" || lower === "/project off" || lower === "/project clear") {
    activeProjectByJid.delete(jid);
    await sendToJid(jid, "✅ Back to general mode — no active project.");
    return true;
  }

  if (lower.startsWith("/project ")) {
    const query = text.slice(9).trim().toLowerCase();
    try {
      const projects = await fetchProjects();
      const match = projects.find(p =>
        p.name.toLowerCase() === query ||
        p.name.toLowerCase().includes(query) ||
        (p.outputDir && p.outputDir.toLowerCase().includes(query))
      );
      if (!match) {
        const names = projects.map(p => `  • ${p.name}`).join("\n");
        await sendToJid(jid, `❌ No project matching "${query}".\n\nAvailable:\n${names || "(none)"}`);
        return true;
      }
      activeProjectByJid.set(jid, { id: match.id, name: match.name, outputDir: match.outputDir });
      await sendToJid(jid, `✅ *${match.name}* is now the active project.\n📁 ${match.outputDir || "?"}\n\nEvery message includes this project's context. Use /home to clear.`);
    } catch (e) {
      await sendToJid(jid, `⚠️ Could not look up projects: ${e.message}`);
    }
    return true;
  }

  return false;
}

// ── Main — boot Baileys ───────────────────────────────────────────────────────

async function main() {
  loadPersistedTurns();
  log("info", `Loaded ${persistedTurns.length} persisted conversation turns`);

  // Dynamic import of Baileys (ESM-only package)
  const qrTerminal = require("qrcode-terminal");
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
  } = await import("@whiskeysockets/baileys");

  const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  log("info", `Baileys version: ${version.join(".")}`);

  const sock = makeWASocket({
    version,
    auth: state,
    // Show as "Chrome (Mac)" — least suspicious to WA servers
    browser: Browsers.macOS("Chrome"),
    printQRInTerminal: false,
    // Reduce unnecessary reconnects and noise
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    logger: {
      level: "silent",
      trace: () => {}, debug: () => {}, info: () => {},
      warn: (o, m) => log("warn", m || String(o)),
      error: (o, m) => log("error", m || String(o)),
      fatal: (o, m) => log("error", `FATAL: ${m || String(o)}`),
      child: () => ({ trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {} }),
    },
  });

  // ── Send helper ─────────────────────────────────────────────────────────────

  async function sendToJid(jid, text, agentId = null) {
    if (shouldSkipDuplicate(jid, text)) {
      log("info", "Skipping duplicate", { jid, len: text.length });
      return;
    }
    lastSentByJid.set(jid, { content: text, ts: Date.now() });
    
    // Check if TTS is enabled for this user
    const useTTS = isTTSEnabled(jid) && hasTTSProvider();
    
    if (useTTS) {
      try {
        const ttsConfig = getTTSConfig();
        
        // Get voice for this specific agent (NEW)
        const voiceConfig = getVoiceForAgent(agentId, ttsConfig.voiceMap || {});
        
        // Chunk text if too long for TTS (max 5000 chars)
        const chunks = chunkTextForTTS(text, 4500);
        
        for (const chunk of chunks) {
          // Convert text to speech with agent-specific voice
          const audioBuffer = await textToSpeech(chunk, {
            provider: voiceConfig.provider,
            voiceId: voiceConfig.voiceId,
            voice: voiceConfig.voice,
            modelId: voiceConfig.modelId
          });
          
          // Send as voice message (WhatsApp PTT - Push To Talk)
          await Promise.race([
            sock.sendMessage(jid, {
              audio: audioBuffer,
              mimetype: "audio/mpeg",
              ptt: true // Push-to-talk (voice message)
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error("sendVoice timeout (20s)")), 20000))
          ]);
          
          log("info", "TTS voice sent", { jid, textLength: chunk.length, agentId, voice: voiceConfig.voiceId || voiceConfig.voice });
        }
        return;
      } catch (ttsErr) {
        log("warn", "TTS failed, falling back to text", { error: ttsErr.message, jid });
        // Fall through to text mode
      }
    }
    
    // Standard text mode (or TTS fallback)
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      try {
        // Baileys sock.sendMessage has no built-in timeout — race against a timer
        // so a stale-but-connected socket never freezes the reply path.
        await Promise.race([
          sock.sendMessage(jid, { text: chunk }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("sendMessage timeout (15s)")), 15000)),
        ]);
      } catch (e) {
        log("error", "sendMessage failed", { jid, error: e.message });
        // If socket appears stale, trigger reconnect so next message works
        if (e.message.includes("timeout") || e.message.includes("Connection Closed")) {
          log("warn", "Socket stale — reconnecting", { jid });
          try { await sock.end(new Error("stale socket")); } catch {}
        }
      }
    }
  }

  // Send location pin (lat/long coordinates)
  async function sendLocation(jid, lat, long, name, address) {
    try {
      await sock.sendMessage(jid, {
        location: {
          degreesLatitude: lat,
          degreesLongitude: long,
          name: name || "",
          address: address || ""
        }
      });
      log("info", "Sent location", { jid, name, lat, long });
    } catch (e) {
      log("error", "sendLocation failed", { jid, error: e.message });
    }
  }

  // ── Connection updates (QR / connected / disconnected) ─────────────────────

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n🟢 Scan this QR code with WhatsApp on your phone:");
      console.log("   WhatsApp → Linked Devices → Link a Device\n");
      qrTerminal.generate(qr, { small: true });
      console.log("\n   (QR code expires in ~60s — restart if it times out)\n");
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const reason = DisconnectReason[code] || code;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      log("warn", `Connection closed: ${reason}`, { code, shouldReconnect });

      if (shouldReconnect) {
        log("info", "Reconnecting in 5s...");
        setTimeout(main, 5000);
      } else {
        log("error", "Logged out — delete ~/.crewswarm/whatsapp-auth/ and re-run to re-authenticate.");
        process.exit(1);
      }
    }

    if (connection === "open") {
      const jid = sock.user?.id || "unknown";
      console.log(`\n✅ WhatsApp bridge connected`);
      console.log(`   Number: ${jid.split(":")[0]}`);
      console.log(`   Auth:   ${WA_AUTH_DIR}`);
      console.log(`   RT:     ${RT_URL} (as ${AGENT_NAME})`);
      console.log(`   Default route: → ${TARGET}`);
      if (Object.keys(USER_ROUTING).length > 0) {
        console.log(`   Per-user routing:`);
        Object.entries(USER_ROUTING).forEach(([num, agent]) => {
          console.log(`     ${num} → ${agent}`);
        });
      }
      console.log(`   Allowlist: ${ALLOWLIST_ENABLED ? [...ALLOWED_JIDS].join(", ") : "open (any sender)"}\n`);

      // Connect RT bus and SSE now that WhatsApp is up
      connectRT(sendToJid).then(c => { rtClient = c; }).catch(e => {
        log("warn", "RT unavailable at startup", { error: e.message });
      });
      listenForAgentReplies(sendToJid);
    }
  });

  // ── Credential save ─────────────────────────────────────────────────────────

  sock.ev.on("creds.update", saveCreds);

  // ── Incoming messages ───────────────────────────────────────────────────────

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      const jid = msg.key.remoteJid;
      if (!jid) continue;

      // Only handle 1:1 chats (not groups)
      const isGroup = jid.endsWith("@g.us");
      if (isGroup) continue;

      // WhatsApp multi-device uses @lid (Linked Identity) JIDs for self-chat messages.
      // These arrive as fromMe:true with a @lid suffix — this is the personal bot pattern.
      const isSelfChatLid = msg.key.fromMe && jid.endsWith("@lid");
      const ownJid = sock.user?.id?.split(":")[0] + "@s.whatsapp.net";
      const isSelfChatOwn = msg.key.fromMe && jid === ownJid;

      // Block outgoing messages that aren't self-chat (i.e. bot's own replies going out)
      if (msg.key.fromMe && !isSelfChatLid && !isSelfChatOwn) continue;

      // ── Allowlist check (before any media processing) ─────────────────
      if (!isSelfChatLid && !isSelfChatOwn) {
        if (ALLOWLIST_ENABLED && !ALLOWED_JIDS.has(jid)) {
          log("warn", "Silently ignored unauthorized sender", { jid });
          continue;
        }
      }

      // ── Handle Image Messages ───────────────────────────────────────────
      if (msg.message?.imageMessage && hasVisionProvider()) {
        try {
          const imgMsg = msg.message.imageMessage;
          const caption = imgMsg.caption || "What's in this image? Describe it in detail.";
          
          log("info", "Processing image from WhatsApp", { jid, caption });
          
          // Download image using Baileys helper
          const { default: makeWASocket, downloadMediaMessage } = require("@whiskeysockets/baileys");
          const buffer = await downloadMediaMessage(msg, "buffer", {});
          const base64 = buffer.toString("base64");
          const dataUri = `data:image/jpeg;base64,${base64}`;
          
          await sock.sendMessage(jid, { text: "🖼️ Analyzing image..." });
          const analysis = await analyzeImage(dataUri, caption);
          
          // Forward to crew-lead with context
          const displayName = resolveDisplayName(jid, sock);
          const targetAgent = getTargetAgent(jid, sock);
          const fullMessage = `[Image from ${displayName}]\nUser's question: ${caption}\n\nImage analysis:\n${analysis}`;
          
          // Track contact
          const phoneNumber = jid.split("@")[0].replace(/\D/g, '').replace(/^1/, '');
          const contactId = `whatsapp:${jid}`;
          trackContact(contactId, 'whatsapp', displayName, { phone: `+${phoneNumber}` });
          saveContactMessage(contactId, 'user', fullMessage);
          
          // Add to history
          addToHistory(jid, "user", fullMessage);
          logMessage({ direction: "inbound", jid, text: caption });
          
          // Get active project for this JID
          const activeProj = activeProjectByJid.get(jid);
          
          fetch(`${CREW_LEAD_URL}/chat`, {
            method: "POST",
            headers: { "content-type": "application/json", ...(RT_TOKEN ? { authorization: `Bearer ${RT_TOKEN}` } : {}) },
            body: JSON.stringify({
              message: fullMessage,
              sessionId: `whatsapp-${jid}`,
              firstName: displayName,
              projectId: activeProj?.id || undefined,
              ...(targetAgent !== "crew-lead" ? { targetAgent } : {}),
            }),
            signal: AbortSignal.timeout(65000),
          }).then(async r => {
            const d = await r.json();
            if (d.reply) {
              addToHistory(jid, "assistant", d.reply);
              await sock.sendMessage(jid, { text: d.reply });
            }
          }).catch(async e => {
            log("error", "crew-lead HTTP error (image)", { error: e.message, targetAgent });
            await sock.sendMessage(jid, { text: `⚠️ Error: ${e.message.slice(0, 100)}` });
          });
          continue;
        } catch (err) {
          log("error", "Image analysis failed", { jid, error: err.message });
          await sock.sendMessage(jid, { text: `⚠️ Image analysis failed: ${err.message}` });
          continue;
        }
      }
      
      // ── Handle Voice/Audio Messages ─────────────────────────────────────
      if ((msg.message?.audioMessage) && hasAudioProvider()) {
        try {
          log("info", "Processing voice message from WhatsApp", { jid });
          
          // Download audio using Baileys helper
          const { default: makeWASocket, downloadMediaMessage } = require("@whiskeysockets/baileys");
          const buffer = await downloadMediaMessage(msg, "buffer", {});
          
          await sock.sendMessage(jid, { text: "🎤 Transcribing voice..." });
          const transcription = await transcribeAudio(buffer);
          
          if (!transcription || transcription.trim().length === 0) {
            await sock.sendMessage(jid, { text: "⚠️ Could not transcribe audio (empty result)" });
            continue;
          }
          
          log("info", "Voice transcribed", { jid, length: transcription.length });
          
          // Forward transcription to crew-lead
          const displayName = resolveDisplayName(jid, sock);
          const targetAgent = getTargetAgent(jid, sock);
          const fullMessage = `[Voice message from ${displayName}]\nTranscription: ${transcription}`;
          
          // Track contact
          const phoneNumber = jid.split("@")[0].replace(/\D/g, '').replace(/^1/, '');
          const contactId = `whatsapp:${jid}`;
          trackContact(contactId, 'whatsapp', displayName, { phone: `+${phoneNumber}` });
          saveContactMessage(contactId, 'user', fullMessage);
          
          // Add to history
          addToHistory(jid, "user", fullMessage);
          logMessage({ direction: "inbound", jid, text: transcription });
          
          // Get active project for this JID
          const activeProj = activeProjectByJid.get(jid);
          
          fetch(`${CREW_LEAD_URL}/chat`, {
            method: "POST",
            headers: { "content-type": "application/json", ...(RT_TOKEN ? { authorization: `Bearer ${RT_TOKEN}` } : {}) },
            body: JSON.stringify({
              message: fullMessage,
              sessionId: `whatsapp-${jid}`,
              firstName: displayName,
              projectId: activeProj?.id || undefined,
              ...(targetAgent !== "crew-lead" ? { targetAgent } : {}),
            }),
            signal: AbortSignal.timeout(65000),
          }).then(async r => {
            const d = await r.json();
            if (d.reply) {
              addToHistory(jid, "assistant", d.reply);
              await sock.sendMessage(jid, { text: d.reply });
            }
          }).catch(async e => {
            log("error", "crew-lead HTTP error (voice)", { error: e.message, targetAgent });
            await sock.sendMessage(jid, { text: `⚠️ Error: ${e.message.slice(0, 100)}` });
          });
          continue;
        } catch (err) {
          log("error", "Voice transcription failed", { jid, error: err.message });
          await sock.sendMessage(jid, { text: `⚠️ Voice transcription failed: ${err.message}` });
          continue;
        }
      }

      // Extract text content
      const text = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.buttonsResponseMessage?.selectedDisplayText ||
        ""
      ).trim();

      if (!text) continue;

      log("info", "Incoming WhatsApp message", { jid, fromMe: msg.key.fromMe, preview: text.slice(0, 80) });
      logMessage({ direction: "inbound", jid, text });

      // Track session for reply routing (always reply to the chat JID)
      activeSessions.set(jid, { jid, lastSeen: Date.now() });

      // Handle slash commands
      if (text.startsWith("/")) {
        const handled = await handleCommand(jid, text, sendToJid);
        if (handled) continue;
      }

      // History + persistence
      addToHistory(jid, "user", text);
      persistTurn("user", text, resolveDisplayName(jid));

      const activeProj = activeProjectByJid.get(jid);
      
      // Save user message to project RAG
      if (activeProj?.id && activeProj.id !== 'general') {
        saveBridgeMessage(
          'whatsapp',
          activeProj.id,
          jid,
          'user',
          text,
          null, // user message
          { phoneNumber: jid.split("@")[0], displayName: resolveDisplayName(jid) }
        );
      }

      // Resolve display name from address book (falls back to +number)
      // Pass sock so @lid can be resolved to actual phone number
      const displayName = resolveDisplayName(jid, sock);
      
      // Extract actual phone number (handle @lid)
      let phoneNumber = jid.split("@")[0];
      if (jid.endsWith("@lid") && sock?.user?.id) {
        phoneNumber = sock.user.id.split(":")[0];
      }
      
      // Get the target agent for this specific user (supports per-user routing)
      const targetAgent = getTargetAgent(jid, sock);
      
      log("info", "Routing WhatsApp message", { 
        jid, 
        displayName,
        phoneNumber: `+${phoneNumber}`,
        targetAgent, 
        hasProject: !!activeProj 
      });

      // FAST PATH: Direct LLM call for non-crew-lead agents (bypasses gateway routing)
      // crew-lead uses its own chat handler, but other agents (crew-loco, etc.) should
      // call their LLM directly for instant responses.
      if (targetAgent !== "crew-lead") {
        try {
          const enrichedInput = await enrichTwitterLinks(text, {
            source: "whatsapp:direct-agent",
          });
          // Track contact in universal contacts DB
          const contactId = `whatsapp:${jid}`;
          trackContact(contactId, 'whatsapp', displayName, { phone: `+${phoneNumber}` });
          
          // Save user message to contact history
          saveContactMessage(contactId, 'user', text);
          
          // Load contact profile
          const contact = getContact(contactId);
          
          // Load agent config
          const csSwarm = JSON.parse(readFileSync(join(homedir(), ".crewswarm", "crewswarm.json"), "utf8"));
          const agentCfg = csSwarm.agents.find(a => a.id === targetAgent);
          if (!agentCfg?.model) {
            throw new Error(`Agent ${targetAgent} not found or no model configured`);
          }
          
          // Parse model string
          const [providerKey, ...modelParts] = agentCfg.model.split("/");
          let modelId = modelParts.join("/");
          const provider = csSwarm.providers?.[providerKey];
          if (!provider?.apiKey) {
            throw new Error(`No API key for provider ${providerKey}`);
          }
          // OpenRouter requires full ID (e.g. openrouter/hunter-alpha), not bare "hunter-alpha"
          if ((providerKey === "openrouter" || (provider.baseUrl || "").includes("openrouter.ai")) && modelId && !modelId.startsWith("openrouter/")) {
            modelId = "openrouter/" + modelId;
          }
          
          // Load system prompt
          const agentPrompts = JSON.parse(readFileSync(join(homedir(), ".crewswarm", "agent-prompts.json"), "utf8"));
          const bareId = targetAgent.replace(/^crew-/, "");
          let sysPrompt = agentPrompts[bareId] || `You are ${targetAgent}.`;
          sysPrompt = applySharedChatPromptOverlay(sysPrompt, targetAgent);

          // CRITICAL: Prepend agent identity so agents know who they are
          const agentDisplayName = agentCfg.identity?.name || targetAgent;
          const emoji = agentCfg.identity?.emoji || '🤖';
          sysPrompt = `# Your Identity\n\nYou are **${agentDisplayName}** (${emoji} ${targetAgent}) — responding in WhatsApp direct chat.\n\n` + sysPrompt;

          // Build intelligent tool instructions
          const hasEngine = hasEngineConfigured(agentCfg);
          const permissions = getToolPermissions(targetAgent, agentCfg);
          const toolInstructions = buildToolInstructions({
            agentId: targetAgent,
            permissions,
            hasEngine,
            agentConfig: agentCfg  // Pass full config to enforce global engine settings
          });
          
          sysPrompt += toolInstructions;

          // Inject user preferences into system prompt
          if (contact?.preferences && Object.keys(contact.preferences).length > 0) {
            sysPrompt = buildPreferencePrompt(sysPrompt, contact.preferences, displayName);
          }
          
          // Inject platform-specific formatting instructions
          const platformFormatting = getPlatformFormatting('whatsapp');
          sysPrompt += platformFormatting;
          
          // Build API request
          const messages = [
            { role: "system", content: sysPrompt },
            ...getHistory(jid).map(h => ({ 
              role: h.role, 
              content: h.content,
              // Inject agent identity for assistant messages
              ...(h.role === 'assistant' && { name: targetAgent })
            })),
            { 
              role: "user", 
              content: enrichedInput.text, 
              ...(displayName && displayName !== "User" && { 
                name: displayName,
              })
            }
          ];
          
          // Prepend phone number context (phoneNumber already extracted above with @lid handling)
          messages[messages.length - 1].content = `[From: ${displayName} / +${phoneNumber}]\n${enrichedInput.text}`;
          
          log("info", "Built message for LLM", { 
            displayName, 
            phoneNumber: `+${phoneNumber}`, 
            hasPreferences: !!(contact?.preferences && Object.keys(contact.preferences).length > 0),
            nameField: messages[messages.length - 1].name,
            contentPrefix: messages[messages.length - 1].content.split('\n')[0]
          });
          
          // Call LLM directly
          const response = await fetch(provider.baseUrl + "/chat/completions", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "authorization": `Bearer ${provider.apiKey}`,
            },
            body: JSON.stringify({
              model: modelId,
              messages,
              temperature: 0.7,
            }),
            signal: AbortSignal.timeout(30000),
          });
          
          if (!response.ok) {
            throw new Error(`LLM API returned ${response.status}`);
          }
          
          const data = await response.json();
          let reply = data.choices?.[0]?.message?.content;

          // Execute any @@READ_FILE, @@WRITE_FILE, @@MKDIR tools in the reply
          const toolResults = await execCrewLeadTools(reply);
          if (toolResults.length > 0) {
            // Call LLM again with tool results
            const toolResultText = toolResults.join("\n\n");
            
            const followUpMessages = [
              ...messages,
              { role: "assistant", content: reply },
              { role: "user", content: `[Tool execution results]\n\n${toolResultText}\n\nContinue your response based on these results.` }
            ];
            
            const followUpRes = await fetch(baseUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
              },
              body: JSON.stringify({
                model: modelId,
                messages: followUpMessages,
                temperature: 0.7,
                // Reasoning models (o1/o3/gpt-5 series) don't support max_tokens parameter
                ...(/^(o1|o3|gpt-5)/i.test(modelId) ? {} : { max_tokens: 2000 })
              })
            });
            
            if (followUpRes.ok) {
              const followUpData = await followUpRes.json();
              reply = followUpData.choices?.[0]?.message?.content || reply;
            }
          }

          // Check for @@WEB_SEARCH tags and execute them
          if (reply && reply.includes("@@WEB_SEARCH")) {
            const searchMatch = reply.match(/@@WEB_SEARCH\s+(.+?)(?=\n|$)/);
            if (searchMatch) {
              const query = searchMatch[1].trim();
              log("info", "Executing @@WEB_SEARCH", { query });
              
              try {
                // Call Brave search API (same as crew-lead uses)
                const braveKey = csSwarm.providers?.brave?.apiKey || process.env.BRAVE_API_KEY;
                if (braveKey) {
                  const searchRes = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`, {
                    headers: { "X-Subscription-Token": braveKey, "Accept": "application/json" },
                    signal: AbortSignal.timeout(10000),
                  });
                  if (searchRes.ok) {
                    const searchData = await searchRes.json();
                    const results = searchData.web?.results?.slice(0, 5) || [];
                    const searchResults = results.map(r => `${r.title}\n${r.description}\n${r.url}`).join("\n\n");
                    
                    // Call LLM again with search results
                    const followUpMessages = [
                      ...messages,
                      { role: "assistant", content: reply },
                      { role: "user", content: `[Search results for: ${query}]\n\n${searchResults}\n\nUsing these results, give your final answer. No @@WEB_SEARCH tags.` }
                    ];
                    
                    const followUpRes = await fetch(provider.baseUrl + "/chat/completions", {
                      method: "POST",
                      headers: {
                        "content-type": "application/json",
                        "authorization": `Bearer ${provider.apiKey}`,
                      },
                      body: JSON.stringify({
                        model: modelId,
                        messages: followUpMessages,
                        temperature: 0.7,
                      }),
                      signal: AbortSignal.timeout(30000),
                    });
                    
                    if (followUpRes.ok) {
                      const followUpData = await followUpRes.json();
                      reply = followUpData.choices?.[0]?.message?.content || reply;
                    }
                  }
                }
              } catch (searchErr) {
                log("warn", "Web search failed", { error: searchErr.message });
                // Continue with original reply
              }
            }
          }
          
          // Check for @@WEB_FETCH tags and execute them
          if (reply && reply.includes("@@WEB_FETCH")) {
            const fetchMatch = reply.match(/@@WEB_FETCH\s+(https?:\/\/[^\s\n]+)/);
            if (fetchMatch) {
              const url = fetchMatch[1].trim();
              log("info", "Executing @@WEB_FETCH", { url });
              
              try {
                const fetchRes = await fetch(url, {
                  headers: { "User-Agent": "crewswarm/1.0" },
                  signal: AbortSignal.timeout(15000),
                });
                if (fetchRes.ok) {
                  const html = await fetchRes.text();
                  // Simple text extraction (just strip HTML tags for basic content)
                  const textContent = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 5000);
                  
                  // Call LLM again with fetched content
                  const followUpMessages = [
                    ...messages,
                    { role: "assistant", content: reply },
                    { role: "user", content: `[Content from ${url}]\n\n${textContent}\n\nUsing this content, give your final answer. No @@WEB_FETCH tags.` }
                  ];
                  
                  const followUpRes = await fetch(provider.baseUrl + "/chat/completions", {
                    method: "POST",
                    headers: {
                      "content-type": "application/json",
                      "authorization": `Bearer ${provider.apiKey}`,
                    },
                    body: JSON.stringify({
                      model: modelId,
                      messages: followUpMessages,
                      temperature: 0.7,
                    }),
                    signal: AbortSignal.timeout(30000),
                  });
                  
                  if (followUpRes.ok) {
                    const followUpData = await followUpRes.json();
                    reply = followUpData.choices?.[0]?.message?.content || reply;
                  }
                }
              } catch (fetchErr) {
                log("warn", "Web fetch failed", { error: fetchErr.message });
                // Continue with original reply
              }
            }
          }
          
          // Check for @@CLI execution (new feature - direct CLI calls from agents)
          const cliMatch = reply.match(/@@CLI\s+(\w+)\s+(.+)/s);
          if (cliMatch) {
            const cliName = cliMatch[1].toLowerCase();
            const task = cliMatch[2].trim();
            const preText = reply.slice(0, cliMatch.index).trim();
            
            // Send any text before the CLI call
            if (preText) {
              addToHistory(jid, "assistant", preText);
              persistTurn("assistant", preText, targetAgent);
              logMessage({ direction: "outbound", jid, text: preText });
              lastReplyTime.set(jid, Date.now());
              await sendToJid(jid, preText);
            }
            
            // Show "⚡ Working..." message
            await sendToJid(jid, `⚡ Running ${cliName}...`);
            log("info", "Agent CLI invocation", { targetAgent, cli: cliName, task: task.slice(0, 100) });
            
            try {
              // Dynamic import of CLI executor
              const { executeCLI } = await import("./lib/bridges/cli-executor.mjs");
              
              const result = await executeCLI(
                cliName,
                task,
                targetAgent,
                { 
                  jid, 
                  sessionId: `whatsapp-${jid}`,
                  projectDir: null 
                },
                null // No streaming output for now
              );
              
              // Send result
              const output = result.stdout || result.stderr || "(no output)";
              const resultText = `✅ ${cliName} completed\n\n${output.slice(0, 3000)}${output.length > 3000 ? '\n\n...(truncated)' : ''}`;
              addToHistory(jid, "assistant", resultText);
              persistTurn("assistant", resultText, targetAgent);
              logMessage({ direction: "outbound", jid, text: resultText });
              lastReplyTime.set(jid, Date.now());
              await sendToJid(jid, resultText);
              
              // Save to contacts DB
              saveContactMessage(contactId, 'assistant', resultText);
              
              log("info", "CLI execution completed", { targetAgent, cli: cliName, exitCode: result.exitCode });
            } catch (cliErr) {
              const errText = `❌ ${cliName} failed: ${cliErr.message}`;
              addToHistory(jid, "assistant", errText);
              logMessage({ direction: "outbound", jid, text: errText });
              await sendToJid(jid, errText);
              log("error", "CLI execution failed", { targetAgent, cli: cliName, error: cliErr.message });
            }
            return;
          }
          
          if (reply) {
            addToHistory(jid, "assistant", reply, targetAgent);
            persistTurn("assistant", reply, "crewswarm");
            
            // Save agent reply to project RAG
            const activeProj = activeProjectByJid.get(jid);
            if (activeProj?.id && activeProj.id !== 'general') {
              saveBridgeMessage(
                'whatsapp',
                activeProj.id,
                jid,
                'assistant',
                reply,
                targetAgent,
                { phoneNumber: `+${phoneNumber}`, displayName }
              );
            }
            
            logMessage({ direction: "outbound", jid, text: reply });
            lastReplyTime.set(jid, Date.now());
            await sendToJid(jid, reply, targetAgent);
            
            // Save assistant message to contact history
            saveContactMessage(contactId, 'assistant', reply);
            
            // Auto-extract preferences if conditions are met
            if (shouldExtract(contact.message_count + 1, text)) {
              log("info", "Extracting preferences", { contactId, messageCount: contact.message_count + 1 });
              
              // Extract preferences (async, don't block reply)
              extractPreferences(
                getHistory(jid), 
                async (msgs) => {
                  // LLM caller wrapper
                  const res = await fetch(provider.baseUrl + "/chat/completions", {
                    method: "POST",
                    headers: {
                      "content-type": "application/json",
                      "authorization": `Bearer ${provider.apiKey}`,
                    },
                    body: JSON.stringify({
                      model: modelId,
                      messages: msgs,
                      temperature: 0.3,
                    }),
                    signal: AbortSignal.timeout(15000),
                  });
                  const data = await res.json();
                  return data.choices?.[0]?.message?.content || '{}';
                },
                'food' // Domain: food preferences (for crew-loco)
              ).then(prefs => {
                if (Object.keys(prefs).length > 0) {
                  updatePreferences(contactId, prefs);
                  log("info", "Preferences updated", { contactId, prefs });
                }
              }).catch(err => {
                log("warn", "Preference extraction failed", { error: err.message });
              });
            }
            
            log("info", "Fast LLM reply sent", { agent: targetAgent, model: modelId, replyLength: reply.length });
          }
        } catch (e) {
          log("error", `Direct LLM call to ${targetAgent} failed: ${e.message}`);
          await sendToJid(jid, `⚠️ ${targetAgent} error: ${e.message.slice(0, 80)}`);
        }
      } else {
        // crew-lead path: use the chat handler
        fetch(`${CREW_LEAD_URL}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(RT_TOKEN ? { authorization: `Bearer ${RT_TOKEN}` } : {}) },
          body: JSON.stringify({
            message: text,
            sessionId: `whatsapp-${jid}`,
            firstName: displayName,
            projectId: activeProj?.id || undefined,
          }),
          signal: AbortSignal.timeout(65000),
        }).then(async r => {
          const d = await r.json();
          if (d.reply) {
            addToHistory(jid, "assistant", d.reply);
            persistTurn("assistant", d.reply, "crewswarm");
            logMessage({ direction: "outbound", jid, text: d.reply });
            lastReplyTime.set(jid, Date.now());
            await sendToJid(jid, d.reply, "crew-lead");
          }
        }).catch(async e => {
          log("error", "crew-lead HTTP error", { error: e.message });
          await sendToJid(jid, `⚠️ Error: ${e.message.slice(0, 100)}`);
        });
      }
    }
  });

  // ── Outbound HTTP API ────────────────────────────────────────────────────────
  // POST /send  { "jid": "15551234567@s.whatsapp.net", "text": "hello" }
  // POST /send  { "phone": "+15551234567", "text": "hello" }
  // Used by crew-lead @@WHATSAPP tool.

  const httpServer = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/send") {
      let body = "";
      req.on("data", d => { body += d; });
      req.on("end", async () => {
        try {
          const { jid, phone, text } = JSON.parse(body);
          if (!text) { res.writeHead(400); res.end(JSON.stringify({ error: "text required" })); return; }
          let targetJid = jid;
          if (!targetJid && phone) {
            targetJid = phone.replace(/^\+/, "").replace(/\D/g, "") + "@s.whatsapp.net";
          }
          if (!targetJid) { res.writeHead(400); res.end(JSON.stringify({ error: "jid or phone required" })); return; }
          // Allowlist check on outbound — never send to unauthorized JIDs
          if (ALLOWLIST_ENABLED && !ALLOWED_JIDS.has(targetJid)) {
            log("warn", "HTTP /send blocked by allowlist", { targetJid });
            res.writeHead(403); res.end(JSON.stringify({ error: "JID not in allowlist" })); return;
          }
          await sendToJid(targetJid, text);
          logMessage({ direction: "outbound", jid: targetJid, text });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, jid: targetJid }));
        } catch (e) {
          res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, number: sock.user?.id?.split(":")[0] || null }));
      return;
    }
    res.writeHead(404); res.end("Not found");
  });

  httpServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      log("warn", `Port ${HTTP_PORT} already in use — HTTP API disabled. Is another WhatsApp bridge running? Set WA_HTTP_PORT to use a different port.`);
    } else {
      log("error", `HTTP server error: ${err.message}`);
    }
  });
  httpServer.listen(HTTP_PORT, "127.0.0.1", () => {
    log("info", `WhatsApp HTTP API listening on :${HTTP_PORT}`);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
