#!/usr/bin/env node
/**
 * telegram-bridge.mjs — Connects Telegram to the crewswarm RT bus.
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
import { randomUUID } from "node:crypto";
import { trackContact, getContact, updatePreferences, saveMessage as saveContactMessage } from "./lib/contacts/index.mjs";
import { extractPreferences, shouldExtract, buildPreferencePrompt } from "./lib/preferences/extractor.mjs";
import { analyzeImage, transcribeAudio, downloadToBuffer, hasVisionProvider, hasAudioProvider } from "./lib/integrations/multimodal.mjs";
import { textToSpeech, hasTTSProvider, chunkTextForTTS, getVoiceForAgent } from "./lib/integrations/tts.mjs";
import { execCrewLeadTools } from "./lib/crew-lead/tools.mjs";
import { buildToolInstructions, hasEngineConfigured, getToolPermissions } from "./lib/agents/tool-instructions.mjs";
import { getPlatformFormatting } from "./lib/agents/platform-formatting.mjs";
import { saveBridgeMessage, detectProjectFromMessage } from "./lib/bridges/integration.mjs";
import { streamToTelegram, supportsNativeStreaming } from "./lib/integrations/telegram-streaming.mjs";
import { enrichTwitterLinks } from "./lib/integrations/twitter-links.mjs";
import { applySharedChatPromptOverlay } from "./lib/chat/shared-chat-prompt-overlay.mjs";
import { acquireStartupLock } from "./lib/runtime/startup-guard.mjs";

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

const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN || (() => {
  // Fall back to telegram-bridge.json token (dashboard saves here)
  try {
    const tgConfig = JSON.parse(readFileSync(TG_BRIDGE_CFG_PATH, "utf8"));
    return tgConfig.token || "";
  } catch {
    return "";
  }
})();
const RT_URL      = process.env.CREWSWARM_RT_URL    || env.CREWSWARM_RT_URL    || "ws://127.0.0.1:18889";
const RT_TOKEN    = process.env.CREWSWARM_RT_AUTH_TOKEN || env.CREWSWARM_RT_AUTH_TOKEN || (() => {
  // Fall back to ~/.crewswarm/config.json → rt.authToken (canonical location)
  try {
    const configPath = join(homedir(), ".crewswarm", "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    return config?.rt?.authToken || "";
  } catch {
    return "";
  }
})();
const AGENT_NAME  = "crew-telegram";
const TELEGRAM_CONTEXT_PATH = process.env.TELEGRAM_CONTEXT_PATH || join(homedir(), "Desktop", "crewswarm", "memory", "telegram-context.md");
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

// Per-user agent routing — map chatId to specific agent (like WhatsApp)
function getUserRouting() {
  try {
    const c = JSON.parse(readFileSync(TG_BRIDGE_CFG_PATH, "utf8"));
    return c.userRouting || {};
  } catch { return {}; }
}

// Topic-based routing — map chatId + threadId to specific agent
function getTopicRouting() {
  try {
    const c = JSON.parse(readFileSync(TG_BRIDGE_CFG_PATH, "utf8"));
    return c.topicRouting || {};
  } catch { return {}; }
}

// TTS configuration
function getTTSConfig() {
  try {
    const c = JSON.parse(readFileSync(TG_BRIDGE_CFG_PATH, "utf8"));
    return c.tts || { enabled: false, provider: "auto", perUserOverrides: {} };
  } catch { 
    return { enabled: false, provider: "auto", perUserOverrides: {} };
  }
}

// Check if TTS is enabled for a specific user
function isTTSEnabled(chatId) {
  const config = getTTSConfig();
  
  // Check per-user override first
  if (config.perUserOverrides && config.perUserOverrides[chatId] !== undefined) {
    return config.perUserOverrides[chatId];
  }
  
  // Fall back to global setting
  return config.enabled === true;
}

// Get target agent for a specific chatId and optional threadId
function getTargetAgent(chatId, threadId = null) {
  const topicRouting = getTopicRouting();
  
  log("info", "getTargetAgent called", { 
    chatId: String(chatId), 
    threadId: threadId ? String(threadId) : null,
    hasGroupConfig: !!topicRouting[String(chatId)],
    groupConfig: topicRouting[String(chatId)] || null
  });
  
  // Check if this group has topic routing configured
  if (topicRouting[String(chatId)]) {
    const groupTopics = topicRouting[String(chatId)];
    
    // If threadId exists, use specific topic routing
    if (threadId && groupTopics[String(threadId)]) {
      const agent = groupTopics[String(threadId)];
      log("info", "Topic routing matched", { chatId, threadId, agent });
      return agent;
    }
    
    // If no threadId (main group chat), check for "main" or "0" as default
    if (!threadId && (groupTopics["main"] || groupTopics["0"])) {
      const agent = groupTopics["main"] || groupTopics["0"];
      log("info", "Main chat routing matched", { chatId, agent });
      return agent;
    }
  }
  
  // Also check flat format: "chatId:threadId": "agent"
  if (threadId) {
    const topicKey = `${chatId}:${threadId}`;
    if (topicRouting[topicKey]) {
      log("info", "Flat format routing matched", { topicKey, agent: topicRouting[topicKey] });
      return topicRouting[topicKey];
    }
  }
  
  // Fall back to user routing (for individual DMs without topic config)
  const routing = getUserRouting();
  const fallbackAgent = routing[String(chatId)] || TARGET;
  log("info", "Fallback routing", { chatId, agent: fallbackAgent, source: routing[String(chatId)] ? "user routing" : "TARGET default" });
  return fallbackAgent;
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

// ── Singleton guard ───────────────────────────────────────────────────────────
const startupLock = acquireStartupLock("telegram-bridge", { killStale: false });
if (!startupLock.ok) {
  console.error(`[telegram-bridge] ${startupLock.message}`);
  process.exit(0);
}

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

async function tgSend(chatId, text, threadId = null, agentId = null) {
  if (shouldSkipDuplicate(chatId, text)) {
    log("info", "Skipping duplicate message to Telegram", { chatId, len: text.length });
    return;
  }
  lastSentByChat.set(chatId, { content: text, ts: Date.now() });
  
  // Check if TTS is enabled for this user
  const ttsEnabled = isTTSEnabled(chatId);
  const hasProvider = hasTTSProvider();
  const useTTS = ttsEnabled && hasProvider;
  
  log("info", "TTS check", { chatId, ttsEnabled, hasProvider, useTTS, agentId });
  
  if (useTTS) {
    try {
      const ttsConfig = getTTSConfig();
      log("info", "TTS config loaded", { hasVoiceMap: !!(ttsConfig.voiceMap), provider: ttsConfig.provider });
      
      // Get voice for this specific agent (NEW)
      const voiceConfig = getVoiceForAgent(agentId, ttsConfig.voiceMap || {});
      log("info", "Voice config for agent", { agentId, voiceConfig });
      
      // Chunk text if too long for TTS (max 5000 chars)
      const chunks = chunkTextForTTS(text, 4500);
      log("info", "Text chunked for TTS", { chunks: chunks.length, totalLength: text.length });
      
      for (const chunk of chunks) {
        // Convert text to speech with agent-specific voice
        log("info", "Calling textToSpeech", { chunkLength: chunk.length, provider: voiceConfig.provider });
        const audioBuffer = await textToSpeech(chunk, {
          provider: voiceConfig.provider,
          voiceId: voiceConfig.voiceId,
          voice: voiceConfig.voice,
          modelId: voiceConfig.modelId
        });
        log("info", "Audio buffer created", { size: audioBuffer.length });
        
        // Send as voice message (Telegram API uses multipart/form-data)
        const formData = new FormData();
        formData.append("chat_id", chatId);
        formData.append("voice", new Blob([audioBuffer], { type: "audio/mpeg" }), "voice.mp3");
        if (threadId) {
          formData.append("message_thread_id", threadId);
        }
        
        log("info", "Sending voice to Telegram API", { chatId, threadId });
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendVoice`, {
          method: "POST",
          body: formData
        });
        
        if (!res.ok) {
          const errorText = await res.text();
          log("error", "Telegram sendVoice API error", { status: res.status, error: errorText });
          throw new Error(`Telegram sendVoice failed: ${res.status} - ${errorText}`);
        }
        
        log("info", "TTS voice sent", { chatId, textLength: chunk.length, agentId, voice: voiceConfig.voiceId || voiceConfig.voice });
      }
      return;
    } catch (ttsErr) {
      log("warn", "TTS failed, falling back to text", { error: ttsErr.message, stack: ttsErr.stack, chatId, agentId });
      // Fall through to text mode
    }
  }
  
  // Standard text mode (or TTS fallback)
  const chunks = splitMessage(text, 4000);
  for (const chunk of chunks) {
    const params = {
      chat_id: chatId,
      text: chunk,
      parse_mode: "Markdown",
    };
    
    // Include message_thread_id for topic/forum group replies
    if (threadId) {
      params.message_thread_id = threadId;
    }
    
    await tgRequest("sendMessage", params).catch(() =>
      tgRequest("sendMessage", { chat_id: chatId, text: chunk, ...(threadId && { message_thread_id: threadId }) })
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
      [{ text: "Chat crew-main" }, { text: "Direct engine" }, { text: "Projects" }],
      [{ text: "Set engine" }, { text: "Models" }, { text: "Voice" }],
      [{ text: "Status" }, { text: "Help" }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

function availableEngineEntries() {
  return Object.entries(ENGINE_LABELS).map(([engine, label]) => ({ engine, label }));
}

function engineInline() {
  const rows = [];
  const entries = availableEngineEntries();
  for (let i = 0; i < entries.length; i += 2) {
    rows.push(
      entries.slice(i, i + 2).map(({ engine, label }) => ({
        text: label.replace(/^[^\p{L}\p{N}]+/u, "").trim(),
        callback_data: `eng:${engine}`
      }))
    );
  }
  return {
    inline_keyboard: rows
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
  
  if (data.startsWith("voice:")) {
    const parts = data.split(":");
    const action = parts[1]; // "on", "off", or "provider"
    
    try {
      const config = JSON.parse(readFileSync(TG_BRIDGE_CFG_PATH, "utf8"));
      if (!config.tts) config.tts = { enabled: false, provider: "auto", perUserOverrides: {}, voiceMap: {} };
      
      // Handle provider switch (voice:provider:elevenlabs:crew-pm)
      if (action === "provider") {
        const provider = parts[2]; // "elevenlabs" or "google"
        const agentId = parts[3]; // "crew-pm", etc.
        
        if (!config.tts.voiceMap) config.tts.voiceMap = {};
        if (!config.tts.voiceMap[agentId]) config.tts.voiceMap[agentId] = {};
        
        config.tts.voiceMap[agentId].provider = provider;
        writeFileSync(TG_BRIDGE_CFG_PATH, JSON.stringify(config, null, 2));
        
        await tgRequest("sendMessage", {
          chat_id: chatId,
          text: `✅ ${agentId} now uses ${provider === "elevenlabs" ? "ElevenLabs (premium)" : "Google TTS (FREE)"}`,
          parse_mode: "Markdown"
        });
        
        log("info", "Voice provider changed", { chatId, agentId, provider });
        return;
      }
      
      // Handle on/off toggle (voice:on:crew-pm or voice:off:crew-pm)
      const enable = action === "on";
      const agentId = parts[2] || "global";
      
      if (!config.tts.perUserOverrides) config.tts.perUserOverrides = {};
      config.tts.perUserOverrides[chatId] = enable;
      
      writeFileSync(TG_BRIDGE_CFG_PATH, JSON.stringify(config, null, 2));
      
      await tgRequest("sendMessage", {
        chat_id: chatId,
        text: `🎤 Voice replies ${enable ? "✅ enabled" : "❌ disabled"} for ${agentId}${enable ? "\n\nAgents will now reply with voice messages (tap 🎤 to play)" : "\n\nAgents will reply with text"}`,
        parse_mode: "Markdown"
      });
      
      log("info", "Voice toggle via button", { chatId, agentId, enabled: enable });
    } catch (e) {
      await tgRequest("sendMessage", {
        chat_id: chatId,
        text: `⚠️ Error: ${e.message}`
      });
    }
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

// ── Conversation history — NOW PERSISTENT (same as WhatsApp) ──────────────────
// History survives restarts and is shared with crew-lead's session system
// Format: ~/.crewswarm/chat-history/telegram/{chatId}.jsonl
import { loadHistory, appendHistory } from "./lib/chat/history.mjs";
import { shouldUseUnifiedHistory, formatUnifiedHistory } from "./lib/chat/unified-history.mjs";

function getHistory(chatId, threadId = null) {
  const contactId = `telegram:${chatId}`;
  
  // Check if this user has unified identity enabled
  if (shouldUseUnifiedHistory(contactId)) {
    // Load unified history from all linked platforms
    return formatUnifiedHistory(contactId);
  }
  
  // Otherwise, use platform-specific history (existing behavior)
  const sessionKey = threadId ? `${chatId}-topic-${threadId}` : String(chatId);
  return loadHistory("telegram", sessionKey);
}

function addToHistory(chatId, role, content, threadId = null, agent = null) {
  const sessionKey = threadId ? `${chatId}-topic-${threadId}` : String(chatId);
  appendHistory("telegram", sessionKey, role, content, agent);
}

function formatHistory(chatId, threadId = null) {
  const hist = getHistory(chatId, threadId);
  if (!hist.length) return "";
  return "\n\n--- Conversation history ---\n" +
    hist.map(h => `${h.role === "user" ? "User" : "You"}: ${h.content}`).join("\n") +
    "\n--- End history ---";
}

function sanitizeChatCompletionHistory(history = []) {
  const sanitized = [];
  let lastRole = "system";
  for (const item of history) {
    if (!item || !item.role || item.content == null) continue;
    if (item.role !== "user" && item.role !== "assistant") continue;
    if (sanitized.length === 0 && item.role !== "user") continue;
    if (item.role === lastRole) continue;
    sanitized.push({ role: item.role, content: String(item.content) });
    lastRole = item.role;
  }
  if (sanitized.length && sanitized[sanitized.length - 1].role === "user") {
    sanitized.pop();
  }
  return sanitized;
}

function resolveTelegramChatModel(agentCfg) {
  const rawModel = String(agentCfg?.model || "").trim();
  if (!rawModel.includes("/")) return { providerKey: null, modelId: rawModel };
  const [providerKey, ...modelParts] = rawModel.split("/");
  let modelId = modelParts.join("/");

  // Telegram topic chat uses chat/completions, not CLI exec. Remap engine-only models.
  if (providerKey === "openai" && /codex/i.test(modelId)) {
    modelId = "gpt-4o";
  }

  return { providerKey, modelId };
}

const TELEGRAM_CHAT_COMPLETION_TIMEOUT_MS = 60000;

// Track active chat sessions (chatId → {username, firstName, lastSeen})
const activeSessions = new Map();

// Track last crew-main reply time to debounce rapid messages
const lastReplyTime = new Map();

// ── Per-chat state for mode, engine, agent selection ─────────────────────────
const chatState = new Map(); // stateKey (chatId or chatId:threadId) -> { mode, engine, agent, projectId, lastPrompt, lastEngine, lastErrorType }
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
// /claude <msg>, /cursor <msg>, /opencode <msg>, /codex <msg>, /crew <msg>, /gemini <msg>
// Streams the response back to TG in chunks as it arrives.
const ENGINE_COMMANDS = { 
  "/claude": "claude", 
  "/cursor": "cursor", 
  "/opencode": "opencode", 
  "/codex": "codex", 
  "/crew": "crew-cli", 
  "/gemini": "gemini" 
};
const ENGINE_LABELS = { 
  "claude": "🤖 Claude Code", 
  "cursor": "🖱 Cursor CLI", 
  "opencode": "⚡ OpenCode", 
  "codex": "🟣 Codex CLI", 
  "crew-cli": "🐝 Crew CLI", 
  "gemini": "✨ Gemini CLI" 
};

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

  const buttonAliases = new Map([
    ["chat crew-main", "/home"],
    ["direct engine", "/engine"],
    ["set engine", "/engine"],
    ["projects", "/projects"],
    ["models", "/models"],
    ["voice", "/voice"],
    ["status", "/status"],
    ["help", "/help"]
  ]);
  if (buttonAliases.has(lower)) {
    return handleCommand(chatId, buttonAliases.get(lower));
  }

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
    await tgSend(chatId, `🎛 *crewswarm Mini App Control Deck*

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

  // /voice — show voice control for CURRENT AGENT (context-aware)
  if (lower === "/voice") {
    // Determine current agent based on topic routing or mode
    let currentAgent = "crew-lead";
    
    // Check topic routing first
    if (threadId) {
      const topicRouting = getTopicRouting();
      const groupConfig = topicRouting[String(chatId)];
      if (groupConfig) {
        currentAgent = groupConfig[String(threadId)] || groupConfig.main || groupConfig.default || "crew-lead";
      }
    } else {
      // Use per-user routing or state
      const userRouting = getUserRouting();
      currentAgent = userRouting[String(chatId)] || getState(chatId).agent || "crew-lead";
    }
    
    // Get current voice config for this agent
    const ttsConfig = getTTSConfig();
    const agentVoice = (ttsConfig.voiceMap || {})[currentAgent] || {};
    const hasVoice = !!(agentVoice.voiceId || agentVoice.voice);
    const provider = agentVoice.provider || "none";
    const voiceName = agentVoice.name || "Default";
    
    // Check if TTS is enabled for this user
    const userTTSEnabled = isTTSEnabled(chatId);
    
    const keyboard = [
      [
        { text: userTTSEnabled && hasVoice ? "✅ Voice ON" : "🔘 Voice ON", callback_data: `voice:on:${currentAgent}` },
        { text: !userTTSEnabled ? "✅ Voice OFF" : "🔘 Voice OFF", callback_data: `voice:off:${currentAgent}` }
      ],
      [
        { text: provider === "elevenlabs" ? "✅ ElevenLabs" : "🔘 ElevenLabs", callback_data: `voice:provider:elevenlabs:${currentAgent}` },
        { text: provider === "google" ? "✅ Google (FREE)" : "🔘 Google (FREE)", callback_data: `voice:provider:google:${currentAgent}` }
      ]
    ];
    
    await tgRequest("sendMessage", {
      chat_id: chatId,
      text: `🎤 *Voice Control for ${currentAgent}*\n\n**Current:**\n• Status: ${userTTSEnabled && hasVoice ? "✅ ON" : "❌ OFF"}\n• Provider: ${provider === "elevenlabs" ? "ElevenLabs" : provider === "google" ? "Google (FREE)" : "None"}\n• Voice: ${voiceName}\n\nTap to toggle:`,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard }
    });
    return true;
  }

  // Legacy text commands (still work)
  if (lower === "/voice on" || lower === "/voice off") {
    const enable = lower === "/voice on";
    
    try {
      const config = JSON.parse(readFileSync(TG_BRIDGE_CFG_PATH, "utf8"));
      if (!config.tts) config.tts = { enabled: false, provider: "auto", perUserOverrides: {}, voiceMap: {} };
      if (!config.tts.perUserOverrides) config.tts.perUserOverrides = {};
      
      config.tts.perUserOverrides[chatId] = enable;
      writeFileSync(TG_BRIDGE_CFG_PATH, JSON.stringify(config, null, 2));
      
      await tgSend(chatId, `🎤 Voice replies ${enable ? "enabled" : "disabled"} for you.`);
      log("info", "Voice toggle", { chatId, enabled: enable });
    } catch (e) {
      await tgSend(chatId, `⚠️ Failed to update voice settings: ${e.message}`);
    }
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
    const lines = Object.entries(ENGINE_COMMANDS).map(([cmd, engine]) => `${ENGINE_LABELS[engine]} → \`${cmd} <message>\``);
    await tgSend(chatId, `*Direct engine passthrough:*\n\n${lines.join("\n")}\n\n_Bypasses crew-lead — sends directly to the CLI tool and streams the reply._`);
    return true;
  }

  if (lower === "/help") {
    await tgSend(chatId, [
      "*crewswarm Telegram*",
      "",
      "`/menu` quick buttons",
      "`/mode` choose chat/direct mode",
      "`/engine` choose direct CLI engine",
      "`/models` choose model override for the selected engine",
      "`/projects` pick active project context",
      "`/status` show current mode/engine/project",
      "`/voice` control voice replies",
      "",
      "*Direct CLI commands:*",
      ...Object.entries(ENGINE_COMMANDS).map(([cmd, engine]) => `${cmd} <message> → ${ENGINE_LABELS[engine]}`)
    ].join("\n"));
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

let reconnectAttempts = 0; // Module-level for RT reconnection tracking
let reconnecting = false; // Guard against concurrent reconnection attempts
let reconnectTimer = null; // Prevent stale reconnect timers from replacing healthy sockets

function connectRT() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RT_URL);
    let ready = false;
    let pingInterval = null;

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
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        reconnecting = false;
        
        // Start heartbeat ping to keep connection alive
        pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, 15000); // Ping every 15 seconds
        
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
            // Format: "telegram-<chatId>" or "telegram-<chatId>-topic-<threadId>"
            // IMPORTANT: Only forward to Telegram if sessionId explicitly starts with "telegram-"
            if (sessionId?.startsWith("telegram-")) {
              let telegramChatId = null;
              let threadId = null;
              const parts = sessionId.slice(9).split("-topic-");
              telegramChatId = parseInt(parts[0], 10);
              if (parts[1]) threadId = parseInt(parts[1], 10);
              
              // Only forward if we have a valid Telegram session
              const targetSessions = telegramChatId && !isNaN(telegramChatId) && activeSessions.has(telegramChatId)
                ? [[telegramChatId, activeSessions.get(telegramChatId)]]
                : []; // Don't broadcast to all sessions
                
              for (const [chatId, session] of targetSessions) {
                const lastReply = lastReplyTime.get(chatId) || 0;
                if (Date.now() - lastReply >= 2000) { // Only send if not too recent
                  lastReplyTime.set(chatId, Date.now());
                log("info", "Forwarding crew-lead reply to Telegram", { chatId, threadId, preview: content.slice(0, 80) });
                addToHistory(chatId, "assistant", content, threadId);
                persistTurn("assistant", content, "crewswarm");
                logMessage({ direction: "outbound", chatId, text: content });
                await tgSend(chatId, content, threadId);
                
                // Save to contacts DB and extract preferences
                const contactId = `telegram:${chatId}`;
                saveContactMessage(contactId, 'assistant', content);
                
                const contact = getContact(contactId);
                if (contact && shouldExtract(contact.message_count + 1, content)) {
                  log("info", "Extracting preferences and profile", { contactId, messageCount: contact.message_count + 1 });
                  
                  // Extract food preferences
                  extractPreferences(
                    getHistory(chatId, threadId),
                    async (msgs) => {
                      const res = await fetch(`${CREW_LEAD_URL}/chat`, {
                        method: "POST",
                        headers: { 
                          "content-type": "application/json",
                          ...(RT_TOKEN ? { authorization: `Bearer ${RT_TOKEN}` } : {})
                        },
                        body: JSON.stringify({
                          message: msgs[msgs.length - 1].content,
                          sessionId: `telegram-pref-extract-${chatId}`,
                          firstName: "PreferenceExtractor"
                        }),
                        signal: AbortSignal.timeout(15000),
                      });
                      const data = await res.json();
                      return data.reply || '{}';
                    },
                    'food'
                  ).then(prefs => {
                    if (Object.keys(prefs).length > 0) {
                      updatePreferences(contactId, prefs);
                      log("info", "Food preferences updated", { contactId, prefs });
                    }
                  }).catch(err => {
                    log("warn", "Preference extraction failed", { error: err.message });
                  });
                  
                  // Extract profile data (location, phone, notes)
                  const { extractAndSaveProfile } = await import("./lib/preferences/extractor.mjs");
                  const { updateContact } = await import("./lib/contacts/index.mjs");
                  
                  extractAndSaveProfile(
                    getHistory(chatId, threadId),
                    async (msgs) => {
                      const res = await fetch(`${CREW_LEAD_URL}/chat`, {
                        method: "POST",
                        headers: { 
                          "content-type": "application/json",
                          ...(RT_TOKEN ? { authorization: `Bearer ${RT_TOKEN}` } : {})
                        },
                        body: JSON.stringify({
                          message: msgs[msgs.length - 1].content,
                          sessionId: `telegram-profile-extract-${chatId}`,
                          firstName: "ProfileExtractor"
                        }),
                        signal: AbortSignal.timeout(15000),
                      });
                      const data = await res.json();
                      return data.reply || '{}';
                    },
                    contactId,
                    updateContact
                  ).then(profile => {
                    if (Object.keys(profile).length > 0) {
                      log("info", "Profile extracted and saved", { contactId, profile });
                    }
                  }).catch(err => {
                    log("warn", "Profile extraction failed", { error: err.message });
                  });
                }
                } // Close if (Date.now() - lastReply >= 2000)
              } // Close for loop
            } // Close if (sessionId?.startsWith("telegram-"))
          }
        }
      }
    });

    ws.on("error", (e) => {
      log("error", "RT socket error", { error: e.message });
      if (!ready) reject(e);
    });

    ws.on("close", (code, reason) => {
      // Clean up ping interval
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
      }

      const isCurrentSocket = rtClient?.ws === ws;
      const reasonText =
        typeof reason === "string" ? reason : reason?.toString?.() || "none";

      // If this socket has already been superseded, ignore its close event.
      if (!isCurrentSocket && reasonText.includes("replaced by new connection")) {
        log("info", "Ignoring close from superseded RT socket", { code, reason: reasonText });
        return;
      }
      if (reasonText.includes("replaced by new connection")) {
        log("info", "Current RT socket was replaced by a newer connection; not scheduling another reconnect", {
          code,
          reason: reasonText,
        });
        return;
      }
      
      // Prevent concurrent reconnection attempts
      if (reconnecting) {
        log("info", "Reconnection already in progress, skipping duplicate");
        return;
      }
      
      reconnecting = true;
      reconnectAttempts++;
      
      // Exponential backoff with max 30s
      const backoffMs = Math.min(1500 * Math.pow(2, reconnectAttempts - 1), 30000);
      
      log("warn", `RT socket closed (code=${code}, reason=${reasonText || 'none'}) — reconnecting in ${backoffMs/1000}s (attempt ${reconnectAttempts})`);
      if (!ready) reject(new Error("RT closed before ready"));
      ready = false;
      if (isCurrentSocket) {
        rtClient = null;
      }
      
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (rtClient?.isReady?.()) {
          reconnecting = false;
          log("info", "Skipping stale RT reconnect timer because a healthy socket already exists");
          return;
        }
        connectRT().then(c => { 
          rtClient = c; 
          reconnectAttempts = 0; // Reset on successful connection
        }).catch(() => {
          reconnecting = false; // Clear guard on failure too
        });
      }, backoffMs);
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

async function routeByState(chatId, text, threadId = null) {
  const st = setState(chatId, { lastPrompt: text, lastEngine: getState(chatId).engine });
  log("info", `routeByState called`, { chatId, threadId, mode: st.mode, agent: st.agent });
  
  if (st.mode === "direct") {
    await handleEnginePassthrough(chatId, st.engine, text);
    return;
  }
  if (st.mode === "bypass") {
    // TODO: implement bypass dispatch via crew-lead /api/dispatch with direct=true, bypass=true
    await tgSend(chatId, `⚠️ Bypass mode not yet implemented. Falling back to chat mode.`);
    await dispatchChat(chatId, text, st.agent || "crew-main", threadId);
    return;
  }
  await dispatchChat(chatId, text, st.agent || "crew-main", threadId);
}

async function dispatchChat(chatId, text, agent = "crew-main", threadId = null) {
  const taskId = randomUUID();
  const history = formatHistory(chatId, threadId);
  const activeProj = activeProjectByChatId.get(chatId);
  const isRoomChat = Number(chatId) < 0 || !!threadId;

  // Add to conversation history
  addToHistory(chatId, "user", text, threadId);
  persistTurn("user", text, activeSessions.get(chatId)?.firstName || "User");

  // Save to project RAG (if project context exists and not excluded)
  if (activeProj?.id && activeProj.id !== 'general') {
    saveBridgeMessage(
      'telegram',
      activeProj.id,
      chatId,
      'user',
      text,
      null, // user message, no agent
      { 
        threadId, 
        firstName: activeSessions.get(chatId)?.firstName || "User",
        username: activeSessions.get(chatId)?.username || ""
      }
    );
  }

  // ALWAYS check topic routing - don't trust the agent parameter from state
  const targetAgent = getTargetAgent(chatId, threadId);
  log("info", `Target agent from routing`, { chatId, threadId, targetAgent });
  
  // If target is not crew-lead, call LLM directly (same as WhatsApp fast path)
  if (targetAgent !== "crew-lead") {
    log("info", `Direct routing to ${targetAgent}`, { chatId, threadId });
    
    try {
      const enrichedInput = await enrichTwitterLinks(text, {
        source: "telegram:direct-agent",
      });
      // Load agent config
      const csSwarm = JSON.parse(readFileSync(join(homedir(), ".crewswarm", "crewswarm.json"), "utf8"));
      const agentCfg = csSwarm.agents.find(a => a.id === targetAgent);
      if (!agentCfg?.model) {
        await tgSend(chatId, `⚠️ Agent ${targetAgent} not configured`);
        return;
      }
      
      // Parse model string with Telegram-safe chat fallback for engine-only models.
      const { providerKey, modelId } = resolveTelegramChatModel(agentCfg);
      log("info", "Resolved Telegram chat model", {
        targetAgent,
        configuredModel: agentCfg.model || "",
        providerKey: providerKey || "none",
        modelId: modelId || "none",
      });
      const provider = csSwarm.providers?.[providerKey];
      if (!provider?.apiKey) {
        await tgSend(chatId, `⚠️ No API key for ${providerKey}`);
        return;
      }
      
      // Load system prompt
      const promptPath = join(homedir(), ".crewswarm", "agent-prompts.json");
      let systemPrompt = `You are ${targetAgent}.`;
      try {
        const prompts = JSON.parse(readFileSync(promptPath, "utf8"));
        const bareAgentName = targetAgent.replace(/^crew-/, "");
        systemPrompt = prompts[bareAgentName] || prompts[targetAgent] || systemPrompt;
      } catch {}
      systemPrompt = applySharedChatPromptOverlay(systemPrompt, targetAgent);
      
      // CRITICAL: Prepend agent identity so agents know who they are
      const displayName = agentCfg.identity?.name || targetAgent;
      const emoji = agentCfg.identity?.emoji || '🤖';
      systemPrompt = `# Your Identity\n\nYou are **${displayName}** (${emoji} ${targetAgent}) — responding in Telegram direct chat.\n\n` + systemPrompt;
      
      // Build intelligent tool instructions
      const hasEngine = hasEngineConfigured(agentCfg);
      const permissions = getToolPermissions(targetAgent, agentCfg);
      const toolInstructions = buildToolInstructions({
        agentId: targetAgent,
        permissions,
        hasEngine,
        agentConfig: agentCfg // Pass full config to enforce global engine settings
      });
      
      systemPrompt += toolInstructions;
      
      // Inject platform-specific formatting instructions
      const platformFormatting = getPlatformFormatting('telegram');
      systemPrompt += platformFormatting;
      
      // Fetch and inject projects context for PM agents
      let projectsContext = "";
      if (permissions.projects) {
        try {
          const projects = await fetchProjects();
          if (projects.length > 0) {
            projectsContext = `\n\n**System Projects (read-only context):**\n`;
            projectsContext += projects.map(p => 
              `• **${p.name}** (${p.id})\n  Path: ${p.outputDir}\n  Roadmap: ${p.roadmapFile || "none"}\n  Status: ${p.roadmap ? `${p.roadmap.done}/${p.roadmap.total} done` : "unknown"}`
            ).join("\n");
          }
        } catch (err) {
          log("warn", "Could not fetch projects for topic agent", { targetAgent, error: err.message });
        }
      }
      
      // Build tool capabilities based on permissions
      let toolsSection = `\n\n**Tool execution:** You're in chat mode (fast LLM replies).`;
      
      if (permissions.web) {
        toolsSection += `\n\n**Web tools:**
- @@WEB_SEARCH query — Search the web for current information
- @@WEB_FETCH https://url — Fetch and extract content from a URL

**When to use @@WEB_SEARCH:**
- User asks about current events, news, or recent information
- Need to look up facts, prices, reviews, or public data
- Questions that require real-time or up-to-date information

**Example:**
User: "What are the best restaurants in Toronto?"
You: Let me search for that. @@WEB_SEARCH best restaurants Toronto 2026 reviews`;
      }
      
      if (permissions.cli) {
        // PM agents should use direct tools, not CLI commands
        const isPMAgent = targetAgent.includes('crew-pm');
        
        if (isPMAgent) {
          toolsSection += `\n\n**Direct file tools:**
- @@READ_FILE /absolute/path — Read any file
- @@WRITE_FILE /absolute/path — Write a file (followed by content, then @@END_FILE)
- @@MKDIR /path/to/dir — Create directory

Example:
@@READ_FILE /path/to/ROADMAP.md
(content appears here)

@@WRITE_FILE /path/to/output.md
Your content here
@@END_FILE`;
        } else {
          // Use the same intelligent tool instructions from buildToolInstructions
          // Get preferred CLI from agent config
          const { getPreferredCLI } = await import("./lib/agents/tool-instructions.mjs");
          const preferredCLI = getPreferredCLI(agentCfg);
          
          if (preferredCLI) {
            const cliLabels = {
              'crew-cli': 'TypeScript specialist',
              'opencode': 'Full workspace context, file editing',
              'cursor': 'Complex reasoning, multi-file refactors',
              'claude': 'Multi-file refactors (Claude Code)',
              'codex': 'OpenAI Codex',
              'gemini': 'Gemini CLI'
            };
            toolsSection += `\n\n**Coding CLI for file operations:**
- @@CLI ${preferredCLI} <task> — ${cliLabels[preferredCLI] || preferredCLI}

**Your preferred CLI is ${preferredCLI}.** Use this for all file operations.`;
          } else {
            // No preference - show all options
            toolsSection += `\n\n**Coding CLIs for file operations:**
- @@CLI opencode <task> — Full workspace context, file editing
- @@CLI cursor <task> — Complex reasoning, multi-file refactors
- @@CLI crew-cli <task> — TypeScript specialist`;
          }
        }
      }
      
      if (permissions.dispatch) {
        toolsSection += `\n\n**Delegation:**
- @@DISPATCH agent-id task — Delegate to another specialist agent

Example: "I'll create that for you. @@DISPATCH crew-coder Create /src/auth.js with JWT login endpoint"`;
      }
      
      if (targetAgent === "crew-loco") {
        toolsSection += `\n\n**IMPORTANT:** You are a conversational assistant only. You have NO access to:
- File system operations (no @@CLI)
- Task delegation (no @@DISPATCH)
- Project management features
- System state or configuration

Keep responses conversational and use @@WEB_SEARCH when you need current information.`;
      }
      
      systemPrompt += projectsContext + toolsSection;
      
      // Load user preferences and inject into system prompt
      const contactId = `telegram:${chatId}`;
      const contact = getContact(contactId);
      
      // Get session data once
      const session = activeSessions.get(chatId) || {};
      const firstName = session.firstName || "User";
      const username = session.username || "";
      const userDisplayName = firstName || username || String(chatId);
      
      // Inject preferences AND/OR location if available
      const hasPreferences = contact?.preferences && Object.keys(contact.preferences).length > 0;
      const hasLocation = contact?.last_location;
      
      if (hasPreferences || hasLocation) {
        systemPrompt = buildPreferencePrompt(
          systemPrompt, 
          contact.preferences || {}, 
          userDisplayName, 
          contact
        );
      }
      
      // Build conversation history
      const history = sanitizeChatCompletionHistory(getHistory(chatId, threadId));
      
      const messages = [
        { role: "system", content: systemPrompt },
        ...history.map(h => ({
          role: h.role,
          content: h.content
        })),
        { 
          role: "user", 
          content: `[From: ${firstName}${username ? ' (@' + username + ')' : ''} / User ID: ${session.userId || 'unknown'} / Telegram:${chatId}${threadId ? ` / Topic:${threadId}` : ''}]\n${enrichedInput.text}`
        }
      ];
      
      // Check if native streaming is supported (private chats only)
      const useStreaming = supportsNativeStreaming(chatId);
      let reply;
      
      if (useStreaming) {
        log("info", "Using native Telegram streaming", { targetAgent, chatId, threadId });
        
        // Stream response with sendMessageDraft
        reply = await streamToTelegram({
          chatId,
          threadId,
          targetAgent,
          provider: { baseUrl: provider.baseUrl || "https://api.openai.com/v1", apiKey: provider.apiKey },
          modelId,
          messages,
          tgRequest,
          log
        });
      } else {
        log("info", "Streaming not supported (group chat), using standard call", { targetAgent, chatId });
        
        // Standard non-streaming call for group chats
        const response = await fetch(`${provider.baseUrl || `https://api.openai.com/v1`}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${provider.apiKey}`
          },
          body: JSON.stringify({
            model: modelId,
            messages,
            temperature: 0.7,
            // Reasoning models (o1/o3/gpt-5 series) don't support max_tokens parameter
            ...(/^(o1|o3|gpt-5)/i.test(modelId) ? {} : { max_tokens: 2000 })
          }),
          signal: AbortSignal.timeout(TELEGRAM_CHAT_COMPLETION_TIMEOUT_MS)
        });
        
        if (!response.ok) {
          const error = await response.text();
          log("error", "LLM call failed", { targetAgent, error });
          await tgSend(chatId, `⚠️ LLM error: ${error.slice(0, 200)}`, threadId);
          return;
        }
        
        const data = await response.json();
        reply = data.choices?.[0]?.message?.content || "(no response)";
      }
      
      // Execute any @@READ_FILE, @@WRITE_FILE, @@MKDIR tools in the reply
      const toolResults = await execCrewLeadTools(reply);
      if (toolResults.length > 0) {
        log("info", "Tool execution results", { targetAgent, toolCount: toolResults.length, results: toolResults.map(r => r.slice(0, 100)) });
        // Call LLM again with tool results
        const toolResultText = toolResults.join("\n\n");
        
        const followUpMessages = [
          ...messages,
          { role: "assistant", content: reply },
          { role: "user", content: `[Tool execution results]\n\n${toolResultText}\n\nContinue your response based on these results.` }
        ];
        
        const followUpRes = await fetch(`${provider.baseUrl || `https://api.openai.com/v1`}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${provider.apiKey}`
          },
          body: JSON.stringify({
            model: modelId,
            messages: followUpMessages,
            temperature: 0.7,
            // Reasoning models (o1/o3/gpt-5 series) don't support max_tokens parameter
            ...(/^(o1|o3|gpt-5)/i.test(modelId) ? {} : { max_tokens: 2000 })
          }),
          signal: AbortSignal.timeout(TELEGRAM_CHAT_COMPLETION_TIMEOUT_MS)
        });
        
        if (followUpRes.ok) {
          const followUpData = await followUpRes.json();
          reply = followUpData.choices?.[0]?.message?.content || reply;
        }
      }
      
      // Check for @@WEB_SEARCH tags and execute them
      if (reply && reply.includes("@@WEB_SEARCH")) {
        log("info", "@@WEB_SEARCH detected in reply", { targetAgent, replyPreview: reply.slice(0, 200) });
        const searchMatch = reply.match(/@@WEB_SEARCH\s+(.+?)(?=\n|$)/);
        if (searchMatch) {
          const query = searchMatch[1].trim();
          log("info", "Executing @@WEB_SEARCH", { query, targetAgent });
          
          try {
            // Call Brave search API (load key from search-tools.json)
            let braveKey = csSwarm.providers?.brave?.apiKey || csSwarm.brave?.apiKey || process.env.BRAVE_API_KEY;
            
            // Fallback: check search-tools.json (where dashboard saves it)
            if (!braveKey) {
              try {
                const searchTools = JSON.parse(readFileSync(join(homedir(), ".crewswarm", "search-tools.json"), "utf8"));
                braveKey = searchTools.brave?.apiKey;
              } catch {}
            }
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
                
                const followUpRes = await fetch(`${provider.baseUrl || `https://api.openai.com/v1`}/chat/completions`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${provider.apiKey}`
                  },
                  body: JSON.stringify({
                    model: modelId,
                    messages: followUpMessages,
                    temperature: 0.7,
                    // Reasoning models (o1/o3/gpt-5 series) don't support max_tokens parameter
                    ...(/^(o1|o3|gpt-5)/i.test(modelId) ? {} : { max_tokens: 2000 })
                  }),
                  signal: AbortSignal.timeout(TELEGRAM_CHAT_COMPLETION_TIMEOUT_MS)
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
              
              const followUpRes = await fetch(`${provider.baseUrl || `https://api.openai.com/v1`}/chat/completions`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${provider.apiKey}`
                },
                body: JSON.stringify({
                  model: modelId,
                  messages: followUpMessages,
                  temperature: 0.7,
                  // Reasoning models (o1/o3/gpt-5 series) don't support max_tokens parameter
                  ...(/^(o1|o3|gpt-5)/i.test(modelId) ? {} : { max_tokens: 2000 })
                }),
                signal: AbortSignal.timeout(TELEGRAM_CHAT_COMPLETION_TIMEOUT_MS)
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
        // Permission check
        if (!permissions.cli) {
          const errMsg = `⚠️ ${targetAgent} does not have CLI tool permissions (chat-only mode)`;
          addToHistory(chatId, "assistant", errMsg, threadId);
          await tgSend(chatId, errMsg, threadId);
          log("warn", "CLI tool blocked by permissions", { targetAgent, permissions });
          return;
        }
        
        const cliName = cliMatch[1].toLowerCase();
        const task = cliMatch[2].trim();
        const preText = reply.slice(0, cliMatch.index).trim();
        
        // Send any text before the CLI call
        if (preText) {
          addToHistory(chatId, "assistant", preText, threadId);
          persistTurn("assistant", preText, targetAgent);
          await tgSend(chatId, preText, threadId);
        }
        
        // Show "⚡ Working..." message
        await tgSend(chatId, `⚡ Running ${cliName}...`, threadId);
        log("info", "Agent CLI invocation", { targetAgent, cli: cliName, task: task.slice(0, 100) });
        
        try {
          // Dynamic import of CLI executor
          const { executeCLI } = await import("./lib/bridges/cli-executor.mjs");
          
          const result = await executeCLI(
            cliName,
            task,
            targetAgent,
            { 
              chatId, 
              sessionId: `telegram-${chatId}${threadId ? `-topic-${threadId}` : ''}`,
              projectDir: null 
            },
            null // No streaming output for now
          );
          
          // Send result
          const output = result.stdout || result.stderr || "(no output)";
          const resultText = `✅ ${cliName} completed\n\n${output.slice(0, 3000)}${output.length > 3000 ? '\n\n...(truncated)' : ''}`;
          addToHistory(chatId, "assistant", resultText, threadId);
          persistTurn("assistant", resultText, targetAgent);
          await tgSend(chatId, resultText, threadId);
          
          log("info", "CLI execution completed", { targetAgent, cli: cliName, exitCode: result.exitCode });
        } catch (cliErr) {
          const errText = `❌ ${cliName} failed: ${cliErr.message}`;
          addToHistory(chatId, "assistant", errText, threadId);
          await tgSend(chatId, errText, threadId);
          log("error", "CLI execution failed", { targetAgent, cli: cliName, error: cliErr.message });
        }
        return;
      }
      
      // Check if agent wants to self-dispatch for tool execution
      const dispatchMatch = reply.match(/@@DISPATCH\s+(\S+)\s+(.+)/s);
      if (dispatchMatch) {
        // Permission check
        if (!permissions.dispatch) {
          const errMsg = `⚠️ ${targetAgent} does not have dispatch permissions (chat-only mode)`;
          addToHistory(chatId, "assistant", errMsg, threadId);
          await tgSend(chatId, errMsg, threadId);
          log("warn", "Dispatch blocked by permissions", { targetAgent, permissions });
          return;
        }
        
        const [, dispatchAgent, taskDesc] = dispatchMatch;
        const cleanReply = reply.replace(/@@DISPATCH\s+\S+\s+.+/s, "").trim();
        
        // Send any text before the dispatch
        if (cleanReply) {
          addToHistory(chatId, "assistant", cleanReply, threadId);
          persistTurn("assistant", cleanReply, targetAgent);
          
          // Save pre-dispatch message to project RAG
          const activeProj = activeProjectByChatId.get(chatId);
          if (activeProj?.id && activeProj.id !== 'general') {
            saveBridgeMessage(
              'telegram',
              activeProj.id,
              chatId,
              'assistant',
              cleanReply,
              targetAgent,
              { threadId, dispatchingTo: dispatchAgent }
            );
          }
          
          await tgSend(chatId, cleanReply, threadId);
        }
        
        // Show dispatch notification
        await tgSend(chatId, `⚡ ${targetAgent} dispatching to ${dispatchAgent}...`, threadId);
        log("info", "Agent self-dispatch", { from: targetAgent, to: dispatchAgent, task: taskDesc.slice(0, 100) });
        
        // Dispatch via RT bus
        if (rtClient?.isOpen) {
          const dispatchTaskId = randomUUID();
          rtClient.publish({
            type: "task.dispatch",
            agent: dispatchAgent,
            task: taskDesc.trim(),
            taskId: dispatchTaskId,
            sessionId: `telegram-${chatId}${threadId ? `-topic-${threadId}` : ''}`,
            context: { from: targetAgent, chatId, threadId }
          });
          
          // Note: Result will come back via RT bus handler and be sent to chat
        } else {
          await tgSend(chatId, `⚠️ RT bus not connected - cannot dispatch`, threadId);
        }
        return;
      }
      
      // No dispatch - send reply normally
      addToHistory(chatId, "assistant", reply, threadId, targetAgent);
      persistTurn("assistant", reply, targetAgent);
      
      // Save agent reply to project RAG
      const activeProj = activeProjectByChatId.get(chatId);
      if (activeProj?.id && activeProj.id !== 'general') {
        saveBridgeMessage(
          'telegram',
          activeProj.id,
          chatId,
          'assistant',
          reply,
          targetAgent, // agent that replied
          { 
            threadId,
            model: agentCfg?.model || 'unknown'
          }
        );
      }
      
      // Send reply with agent ID for voice selection
      await tgSend(chatId, reply, threadId, targetAgent);
      const currentSession = activeSessions.get(chatId) || {};
      logMessage({ direction: "outbound", chatId, username: currentSession.username, text: reply });
      
      log("info", "Direct LLM response sent", { targetAgent, chatId, threadId });
    } catch (e) {
      log("error", "Direct routing failed", { targetAgent, error: e.message });
      await tgSend(chatId, `⚠️ Error: ${e.message}`, threadId);
    }
    return;
  }

  // Otherwise, send to crew-lead HTTP server
  fetch(`${CREW_LEAD_URL}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(RT_TOKEN ? { authorization: `Bearer ${RT_TOKEN}` } : {}) },
    body: JSON.stringify({
      message: text,
      sessionId: `telegram-${chatId}${threadId ? `-topic-${threadId}` : ''}`,
      firstName: activeSessions.get(chatId)?.firstName || "User",
      projectId: activeProj?.id || undefined,
      ...(isRoomChat ? { channelMode: true } : {}),
    }),
    signal: AbortSignal.timeout(65000),
  }).then(async r => {
    const d = await r.json();
    if (d.reply) {
      addToHistory(chatId, "assistant", d.reply, threadId);
      persistTurn("assistant", d.reply, "crewswarm");
      logMessage({ direction: "outbound", chatId, text: d.reply });
      lastReplyTime.set(chatId, Date.now());
      await tgSend(chatId, d.reply, threadId, "crew-lead");
      if (d.dispatched) {
        const targets = Array.isArray(d.dispatched)
          ? d.dispatched.map((item) => item?.agent || item?.id).filter(Boolean)
          : [d.dispatched.agent].filter(Boolean);
        if (targets.length) {
          await tgSend(chatId, `⚡ Dispatching to ${targets.join(", ")}...`, threadId);
        }
      }
    }
  }).catch(async e => {
    log("error", "crew-lead HTTP error", { error: e.message });
    await tgSend(chatId, `⚠️ crew-lead error: ${e.message.slice(0,100)}`, threadId);
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
      `**${t.role === "user" ? (t.name || "User") : "crewswarm"}** (${t.ts.slice(0,16)}): ${t.text}`
    ).join("\n\n");
    const content = `# Telegram Conversation Context\n\nLast updated: ${new Date().toISOString()}\n\nThis file contains recent Telegram chat history. Use it to maintain continuity across sessions.\n\n---\n\n${lines}\n\n<!-- turns:${JSON.stringify(persistedTurns.slice(-TG_CONTEXT_MAX_TURNS))} -->`;
    writeFileSync(TG_CONTEXT_FILE, content);
  } catch {}
}

function persistTurn(role, text, name) {
  // Exclude crew-loco (food bot) from persistent memory - it's a segregated test bot
  if (name === 'crew-loco' || text.includes('¡Órale') || text.includes('CrewLoco')) {
    return; // Skip crew-loco conversations
  }
  
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
    `> This context is from the active Telegram conversation via @crewswarm_bot. Use it to maintain continuity.`,
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
            // Route to specific chat if sessionId is "telegram-<chatId>-topic-<threadId>"
            const sessionParts = (d.sessionId || "").split("-");
            const telegramChatId = d.sessionId?.startsWith("telegram-")
              ? parseInt(sessionParts[1], 10) : null;
            
            // Extract threadId from sessionId format: telegram-<chatId>-topic-<threadId>
            const threadId = (sessionParts[2] === "topic" && sessionParts[3])
              ? parseInt(sessionParts[3], 10) : null;
            
            // CRITICAL: Only send to Telegram if this message has a telegram- sessionId
            // Dashboard messages (no telegram- prefix) should NOT broadcast to Telegram
            if (!telegramChatId || isNaN(telegramChatId) || !activeSessions.has(telegramChatId)) {
              continue; // Skip - not a Telegram session
            }
            
            const targetChatIds = [telegramChatId]; // Always single chat, never broadcast
            for (const chatId of targetChatIds) {
              if (wasRawContentAlreadySent(chatId, d.content)) {
                log("info", "SSE reply already sent via RT path — skipping", { chatId, from: d.from });
                continue;
              }
              const preview = d.content.length > 300 ? d.content.slice(0, 300) + "…" : d.content;
              const msg = `✅ *${d.from}* finished:\n${preview}\n\nReply to follow up or dispatch more work.`;
              log("info", "Agent reply forwarded to Telegram (SSE)", { chatId, threadId, from: d.from });
              await tgSend(chatId, msg, threadId);
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

const _processedUpdateIds = new Set();
const PROCESSED_IDS_MAX = 500;

async function pollLoop() {
  log("info", "Starting Telegram poll loop");
  while (true) {
    try {
      log("info", "Polling Telegram updates", { offset });
      const updates = await tgRequest("getUpdates", {
        offset,
        timeout: POLL_TIMEOUT,
        allowed_updates: ["message", "callback_query"],
      });
      log("info", "Telegram updates received", { count: Array.isArray(updates) ? updates.length : -1, offset });

      for (const update of updates) {
        offset = update.update_id + 1;
        // Skip already-processed updates (guard against re-delivery)
        if (_processedUpdateIds.has(update.update_id)) {
          log("info", "Skipping already-processed update", { updateId: update.update_id });
          continue;
        }
        _processedUpdateIds.add(update.update_id);
        // Prevent unbounded growth
        if (_processedUpdateIds.size > PROCESSED_IDS_MAX) {
          const oldest = _processedUpdateIds.values().next().value;
          _processedUpdateIds.delete(oldest);
        }
        try {
          await handleTelegramUpdate(update);
        } catch (err) {
          log("error", "Telegram update handler failed", {
            updateId: update.update_id,
            error: err?.message || String(err),
          });
        }
      }
    } catch (e) {
      log("error", "Poll error", { error: e.message });
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

async function handleTelegramUpdate(update) {
  if (update.callback_query) {
    await handleCallback(update.callback_query);
    return;
  }

  const msg = update.message;
  if (!msg) return;

  if (msg?.web_app_data?.data) {
    await handleMiniAppData(msg);
    return;
  }

  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || null;
  const username = msg.from?.username || "";
  const firstName = msg.from?.first_name || "";
  const userId = msg.from?.id || null;

  if (msg?.photo && hasVisionProvider()) {
    try {
      const photo = msg.photo[msg.photo.length - 1];
      const fileRes = await tgRequest("getFile", { file_id: photo.file_id });
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileRes.file_path}`;
      const caption = msg.caption || "What's in this image? Describe it in detail.";
      log("info", "Processing image from Telegram", { chatId, caption });
      await tgSend(chatId, "🖼️ Analyzing image...", threadId);
      const analysis = await analyzeImage(fileUrl, caption);
      const fullMessage = `[Image from ${firstName || username || "user"}]\nUser's question: ${caption}\n\nImage analysis:\n${analysis}`;
      activeSessions.set(chatId, { username, firstName, userId, lastSeen: Date.now() });
      logMessage({ direction: "inbound", chatId, username, firstName, text: caption });
      const contactId = `telegram:${chatId}`;
      trackContact(contactId, "telegram", firstName || username || String(chatId), { username });
      saveContactMessage(contactId, "user", fullMessage);
      const mediaAgent = getTargetAgent(chatId, threadId);
      const finalAgent = mediaAgent === "crew-lead" ? "crew-main" : mediaAgent;
      log("info", "Image routing (direct, bypass crew-lead)", { chatId, threadId, from: mediaAgent, to: finalAgent });
      addToHistory(chatId, "user", fullMessage, threadId);
      await dispatchChat(chatId, fullMessage, finalAgent, threadId);
      return;
    } catch (err) {
      log("error", "Image analysis failed", { chatId, error: err.message });
      await tgSend(chatId, `⚠️ Image analysis failed: ${err.message}`);
      return;
    }
  }

  if ((msg?.voice || msg?.audio) && hasAudioProvider()) {
    try {
      const audioFile = msg.voice || msg.audio;
      const fileRes = await tgRequest("getFile", { file_id: audioFile.file_id });
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileRes.file_path}`;
      log("info", "Processing voice message from Telegram", { chatId, duration: audioFile.duration });
      await tgSend(chatId, "🎤 Transcribing voice...");
      const audioBuffer = await downloadToBuffer(fileUrl);
      const transcription = await transcribeAudio(audioBuffer);
      if (!transcription || transcription.trim().length === 0) {
        await tgSend(chatId, "⚠️ Could not transcribe audio (empty result)");
        return;
      }
      log("info", "Voice transcribed", { chatId, length: transcription.length });
      const fullMessage = `[Voice message from ${firstName || username || "user"}]\nTranscription: ${transcription}`;
      activeSessions.set(chatId, { username, firstName, userId, lastSeen: Date.now() });
      logMessage({ direction: "inbound", chatId, username, firstName, text: transcription });
      const contactId = `telegram:${chatId}`;
      trackContact(contactId, "telegram", firstName || username || String(chatId), { username });
      saveContactMessage(contactId, "user", fullMessage);
      const mediaAgent = getTargetAgent(chatId, threadId);
      const finalAgent = mediaAgent === "crew-lead" ? "crew-main" : mediaAgent;
      log("info", "Voice routing (direct, bypass crew-lead)", { chatId, threadId, from: mediaAgent, to: finalAgent });
      addToHistory(chatId, "user", fullMessage, threadId);
      await dispatchChat(chatId, fullMessage, finalAgent, threadId);
      return;
    } catch (err) {
      log("error", "Voice transcription failed", { chatId, error: err.message });
      await tgSend(chatId, `⚠️ Voice transcription failed: ${err.message}`);
      return;
    }
  }

  if (!msg?.text) return;
  const text = msg.text.trim();
  const allowed = getAllowedIds();
  if (allowed && !allowed.has(chatId)) {
    log("warn", "Blocked unauthorized sender", { chatId, username });
    await tgSend(chatId, "⛔ Unauthorized. Ask your admin to add your chat ID to the allowlist.\n\nAdmin: Use @userinfobot to get user/group IDs.");
    return;
  }

  if (text.toLowerCase() === "/chatid") {
    const chatType = chatId > 0 ? "Private chat" : (chatId.toString().startsWith("-100") ? "Supergroup" : "Group");
    await tgSend(chatId, `📍 **${chatType} Info**\n\nChat ID: \`${chatId}\`${threadId ? `\nTopic ID: \`${threadId}\`` : ""}\n\nUse this ID in topic routing config.`);
    log("info", "/chatid command executed", { chatId, threadId, username });
    return;
  }

  log("info", "Incoming Telegram message", { chatId, threadId, username, text: text.slice(0, 80) });
  logMessage({ direction: "inbound", chatId, username, firstName, text });
  const contactId = `telegram:${chatId}`;
  trackContact(contactId, "telegram", firstName || username || String(chatId), { username });
  saveContactMessage(contactId, "user", text);
  activeSessions.set(chatId, { username, firstName, userId, lastSeen: Date.now() });

  if (text.startsWith("/")) {
    const handled = await handleCommand(chatId, text);
    if (handled) return;
  }

  await routeByState(chatId, text, threadId);
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
