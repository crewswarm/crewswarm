#!/usr/bin/env node
/**
 * whatsapp-bridge.mjs — Connects WhatsApp to the CrewSwarm RT bus.
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

const RT_URL        = process.env.OPENCREW_RT_URL        || env.OPENCREW_RT_URL        || "ws://127.0.0.1:18889";
const RT_TOKEN      = process.env.OPENCREW_RT_AUTH_TOKEN || env.OPENCREW_RT_AUTH_TOKEN || "";
const CREW_LEAD_URL = process.env.CREW_LEAD_URL          || "http://127.0.0.1:5010";
const DASHBOARD_URL = process.env.DASHBOARD_URL          || "http://127.0.0.1:4319";
const AGENT_NAME    = "crew-whatsapp";
const TARGET        = process.env.WA_TARGET_AGENT        || env.WA_TARGET_AGENT        || "crew-lead";
const HTTP_PORT     = parseInt(process.env.WA_HTTP_PORT  || env.WA_HTTP_PORT           || "5015", 10);

// Allowlist — phone numbers in international format, e.g. "+15551234567"
// Numbers are normalised to JID format: "15551234567@s.whatsapp.net"
const ALLOWED_RAW = process.env.WA_ALLOWED_NUMBERS || env.WA_ALLOWED_NUMBERS || "";
const ALLOWED_JIDS = new Set(
  ALLOWED_RAW.split(",")
    .map(s => s.trim().replace(/^\+/, ""))
    .filter(Boolean)
    .map(n => `${n}@s.whatsapp.net`)
);
const ALLOWLIST_ENABLED = ALLOWED_JIDS.size > 0;

// Contact names — loaded from whatsapp-bridge.json (saved by dashboard)
const WA_BRIDGE_CFG_PATH = join(homedir(), ".crewswarm", "whatsapp-bridge.json");
function loadContactNames() {
  try {
    const c = JSON.parse(readFileSync(WA_BRIDGE_CFG_PATH, "utf8"));
    return c.contactNames || {};
  } catch { return {}; }
}
// Resolve a JID like "15551234567@s.whatsapp.net" → "Jeff" or "+15551234567"
function resolveDisplayName(jid) {
  const digits = jid.split("@")[0];
  const names = loadContactNames();
  return names[digits] || names[`+${digits}`] || `+${digits}`;
}

// ── Logging ────────────────────────────────────────────────────────────────────

function log(level, msg, data = {}) {
  const entry = { ts: new Date().toISOString(), level, msg, ...data };
  console.log(`[whatsapp-bridge] [${level}] ${msg}`, Object.keys(data).length ? data : "");
  try { appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n"); } catch {}
}

try { writeFileSync(PID_PATH, String(process.pid)); } catch {}
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

// ── Conversation history ───────────────────────────────────────────────────────

const MAX_HISTORY = 20;
const conversations = new Map();

function getHistory(jid) { return conversations.get(jid) || []; }

function addToHistory(jid, role, content) {
  const hist = conversations.get(jid) || [];
  hist.push({ role, content, ts: new Date().toISOString() });
  if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - MAX_HISTORY);
  conversations.set(jid, hist);
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
      `**${t.role === "user" ? (t.name || "User") : "CrewSwarm"}** (${t.ts.slice(0,16)}): ${t.text}`
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

function connectRT(sendToJid) {
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
        ws.send(JSON.stringify({ type: "hello", agent: AGENT_NAME, token: RT_TOKEN }));
        return;
      }

      if (p.type === "hello.ack") {
        ws.send(JSON.stringify({ type: "subscribe", channels: ["command", "assign", "done", "status", "events"] }));
        ready = true;
        resolve(client);
        log("info", `RT connected as ${AGENT_NAME}`);
        return;
      }

      if (p.type === "message" && p.envelope) {
        const env = p.envelope;
        if (env.messageId) client.ack({ messageId: env.messageId });

        const from    = env.from || env.sender_agent_id || "";
        const content = env.payload?.content ? String(env.payload.content).trim() : "";
        const isChatReply = env.messageType === "chat.reply" || env.type === "chat.reply";
        const sessionId = env.payload?.sessionId;

        if ((from === TARGET || isChatReply) && content && content.length > 2) {
          const isHeartbeat = env.type === "agent.heartbeat" || env.channel === "status";
          const isTaskNoise = content.startsWith("@@DISPATCH") || content.startsWith("[bridge]");
          if (!isHeartbeat && !isTaskNoise) {
            const targetSessions = sessionId && activeSessions.has(sessionId)
              ? [[sessionId, activeSessions.get(sessionId)]]
              : [...activeSessions];
            for (const [jid] of targetSessions) {
              const lastReply = lastReplyTime.get(jid) || 0;
              if (Date.now() - lastReply < 2000) continue;
              lastReplyTime.set(jid, Date.now());
              log("info", "Forwarding crew-lead reply to WhatsApp", { jid, preview: content.slice(0, 80) });
              addToHistory(jid, "assistant", content);
              persistTurn("assistant", content, "CrewSwarm");
              logMessage({ direction: "outbound", jid, text: content });
              await sendToJid(jid, content);
            }
          }
        }
      }
    });

    ws.on("error", (e) => { log("error", "RT error", { error: e.message }); if (!ready) reject(e); });

    ws.on("close", () => {
      log("warn", "RT socket closed — reconnecting in 3s");
      if (!ready) reject(new Error("RT closed before ready"));
      ready = false;
      rtClient = null;
      setTimeout(() => connectRT(sendToJid).then(c => { rtClient = c; }).catch(() => {}), 3000);
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
            let alreadySent = false;
            for (const [jid] of activeSessions) {
              if (shouldSkipDuplicate(jid, d.content)) { alreadySent = true; break; }
            }
            if (alreadySent) continue;
            const preview = d.content.length > 300 ? d.content.slice(0, 300) + "…" : d.content;
            const msg = `✅ *${d.from}* finished:\n${preview}\n\nReply to follow up.`;
            for (const [jid] of activeSessions) {
              await sendToJid(jid, msg);
            }
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
    await sendToJid(jid, `*CrewSwarm WhatsApp Bridge*\n\nRT bus: ${rtOk}\nActive sessions: ${sessions}\nTarget: ${TARGET}\nAllowlist: ${ALLOWLIST_ENABLED ? `${ALLOWED_JIDS.size} numbers` : "open"}`);
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

  async function sendToJid(jid, text) {
    if (shouldSkipDuplicate(jid, text)) {
      log("info", "Skipping duplicate", { jid, len: text.length });
      return;
    }
    lastSentByJid.set(jid, { content: text, ts: Date.now() });
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      try {
        await sock.sendMessage(jid, { text: chunk });
      } catch (e) {
        log("error", "sendMessage failed", { jid, error: e.message });
      }
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
      console.log(`   Routes: → ${TARGET}`);
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

      // Extract text content
      const text = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.buttonsResponseMessage?.selectedDisplayText ||
        ""
      ).trim();

      if (!text) continue;

      // Self-chat via @lid is implicitly trusted (it's the linked number's own messages).
      // For regular DMs, check the allowlist against the sender's JID.
      if (!isSelfChatLid && !isSelfChatOwn) {
        if (ALLOWLIST_ENABLED && !ALLOWED_JIDS.has(jid)) {
          log("warn", "Blocked unauthorized sender", { jid });
          await sendToJid(jid, "⛔ Unauthorized.");
          continue;
        }
      }

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

      // Resolve display name from address book (falls back to +number)
      const displayName = resolveDisplayName(jid);

      // Send to crew-lead
      fetch(`${CREW_LEAD_URL}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
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
          persistTurn("assistant", d.reply, "CrewSwarm");
          logMessage({ direction: "outbound", jid, text: d.reply });
          lastReplyTime.set(jid, Date.now());
          await sendToJid(jid, d.reply);
          if (d.dispatched) {
            await sendToJid(jid, `⚡ Dispatching to ${d.dispatched.agent}…`);
          }
        }
      }).catch(async e => {
        log("error", "crew-lead HTTP error", { error: e.message });
        await sendToJid(jid, `⚠️ crew-lead error: ${e.message.slice(0, 100)}`);
      });
    }
  });

  // ── Outbound HTTP API ────────────────────────────────────────────────────────
  // POST /send  { "jid": "13109050857@s.whatsapp.net", "text": "hello" }
  // POST /send  { "phone": "+13109050857", "text": "hello" }
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

  httpServer.listen(HTTP_PORT, "127.0.0.1", () => {
    log("info", `WhatsApp HTTP API listening on :${HTTP_PORT}`);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
