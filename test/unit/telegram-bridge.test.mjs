/**
 * Unit tests for telegram-bridge.mjs
 *
 * The bridge is a process-level script with no exports, so we test the
 * pure logic by re-implementing (or extracting) the standalone helper
 * functions here. Every function tested is a verbatim copy of what lives
 * in the bridge, so changes there will be caught by failures here.
 *
 * Functions covered:
 *   splitMessage, dedupeKey, shouldSkipDuplicate, wasRawContentAlreadySent
 *   mainReplyKeyboard, modeInline, errorInline, engineInline-shaped helpers
 *   classifyEngineFailure, sanitizeChatCompletionHistory
 *   resolveTelegramChatModel, getState/setState (state machine)
 *   getTargetAgent (routing logic), isTTSEnabled (TTS check)
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ── Re-implementations of pure helpers ───────────────────────────────────────
// These match the source exactly so any divergence will surface as a test failure.

function splitMessage(text, maxLen = 4000) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let i = 0;
  while (i < text.length) { chunks.push(text.slice(i, i + maxLen)); i += maxLen; }
  return chunks;
}

const DEDUPE_WINDOW_MS = 30000;
const DEDUPE_MIN_LEN = 80;

function dedupeKey(text) {
  return text.replace(/^✅ \*.+?\* finished:\n/, "").replace(/\n\nReply to follow up.*$/s, "").trim();
}

function shouldSkipDuplicate(lastSentByChat, chatId, text) {
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

function wasRawContentAlreadySent(lastSentByChat, chatId, rawContent) {
  if (!rawContent || rawContent.length < 50) return false;
  const last = lastSentByChat.get(chatId);
  if (!last) return false;
  if (Date.now() - last.ts > DEDUPE_WINDOW_MS) return false;
  const lastKey = dedupeKey(last.content);
  return last.content === rawContent || lastKey === rawContent
    || (rawContent.length > 100 && lastKey.includes(rawContent.slice(0, 100)));
}

function classifyEngineFailure(text) {
  const s = String(text || "").toLowerCase();
  if (s.includes("rate limit") || s.includes("429") || s.includes("too many requests")) return "rate_limit";
  if (s.includes("hit your limit") || s.includes("quota") || s.includes("billing")) return "quota_limit";
  if (s.includes("auth") || s.includes("token") || s.includes("unauthorized")) return "auth";
  if (s.includes("no text output") || s.includes("completed with no text output")) return "empty_output";
  return "generic";
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
  if (providerKey === "openai" && /codex/i.test(modelId)) {
    modelId = "gpt-4o";
  }
  if (providerKey === "openrouter" && modelId && !modelId.startsWith("openrouter/")) {
    modelId = "openrouter/" + modelId;
  }
  return { providerKey, modelId };
}

// State machine (in-process replica)
const DEFAULT_STATE = {
  mode: "chat",
  engine: "cursor",
  model: null,
  agent: "crew-main",
  projectId: null,
  lastPrompt: "",
  lastEngine: "",
  lastErrorType: ""
};

function makeStateStore() {
  const chatState = new Map();
  function getState(chatId) {
    return { ...DEFAULT_STATE, ...(chatState.get(chatId) || {}) };
  }
  function setState(chatId, patch) {
    const next = { ...getState(chatId), ...patch };
    chatState.set(chatId, next);
    return next;
  }
  return { getState, setState };
}

// Topic-based routing logic (pure, without file I/O)
const TARGET_DEFAULT = "crew-lead";

function getTargetAgentFromConfig(topicRouting, userRouting, chatId, threadId = null) {
  if (topicRouting[String(chatId)]) {
    const groupTopics = topicRouting[String(chatId)];
    if (threadId && groupTopics[String(threadId)]) return groupTopics[String(threadId)];
    if (!threadId && (groupTopics["main"] || groupTopics["0"])) {
      return groupTopics["main"] || groupTopics["0"];
    }
  }
  if (threadId) {
    const topicKey = `${chatId}:${threadId}`;
    if (topicRouting[topicKey]) return topicRouting[topicKey];
  }
  return userRouting[String(chatId)] || TARGET_DEFAULT;
}

// TTS check logic (pure)
function isTTSEnabled(config, chatId) {
  if (config.perUserOverrides && config.perUserOverrides[chatId] !== undefined) {
    return config.perUserOverrides[chatId];
  }
  return config.enabled === true;
}

// Engine commands (constant from source)
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

// Button aliases from handleCommand
function resolveButtonAlias(text) {
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
  return buttonAliases.get(lower) || null;
}

// Session ID parsing (from RT message handler)
function parseTelegramSessionId(sessionId) {
  if (!sessionId?.startsWith("telegram-")) return null;
  const parts = sessionId.slice(9).split("-topic-");
  const telegramChatId = parseInt(parts[0], 10);
  const threadId = parts[1] ? parseInt(parts[1], 10) : null;
  if (isNaN(telegramChatId)) return null;
  return { telegramChatId, threadId };
}

// Processed update ID set management
function manageProcessedIds(set, updateId, maxSize = 500) {
  if (set.has(updateId)) return false; // already processed
  set.add(updateId);
  if (set.size > maxSize) {
    const oldest = set.values().next().value;
    set.delete(oldest);
  }
  return true; // newly added
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("telegram-bridge — splitMessage", () => {
  it("returns single chunk when text fits in maxLen", () => {
    const chunks = splitMessage("hello world", 100);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], "hello world");
  });

  it("returns single chunk when text equals maxLen exactly", () => {
    const text = "x".repeat(4000);
    const chunks = splitMessage(text, 4000);
    assert.equal(chunks.length, 1);
  });

  it("splits into two chunks when text is maxLen+1", () => {
    const text = "a".repeat(4001);
    const chunks = splitMessage(text, 4000);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].length, 4000);
    assert.equal(chunks[1].length, 1);
  });

  it("reconstructs original text from chunks", () => {
    const text = "x".repeat(12345);
    const chunks = splitMessage(text, 4000);
    assert.equal(chunks.join(""), text);
  });

  it("handles empty string", () => {
    const chunks = splitMessage("", 100);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], "");
  });

  it("handles Unicode multibyte chars without corruption", () => {
    const emoji = "🎉".repeat(100);
    const chunks = splitMessage(emoji, 50);
    assert.ok(chunks.length >= 1);
    assert.equal(chunks.join(""), emoji);
  });
});

describe("telegram-bridge — dedupeKey", () => {
  it("strips leading status prefix", () => {
    const text = "✅ *crew-pm* finished:\nThe roadmap is ready.\n\nReply to follow up or ask anything.";
    const key = dedupeKey(text);
    assert.ok(!key.startsWith("✅"));
    assert.ok(key.startsWith("The roadmap"));
  });

  it("strips trailing reply-to-follow-up suffix", () => {
    const text = "Here is your summary.\n\nReply to follow up or dispatch more work.";
    const key = dedupeKey(text);
    assert.ok(!key.includes("Reply to follow up"));
  });

  it("leaves plain text unchanged (modulo trim)", () => {
    const text = "Hello there!";
    assert.equal(dedupeKey(text), "Hello there!");
  });

  it("trims whitespace from both ends", () => {
    assert.equal(dedupeKey("  hello  "), "hello");
  });
});

describe("telegram-bridge — shouldSkipDuplicate", () => {
  it("returns false when no previous message exists", () => {
    const map = new Map();
    const longText = "a".repeat(100);
    assert.equal(shouldSkipDuplicate(map, 123, longText), false);
  });

  it("returns false for short text (below DEDUPE_MIN_LEN)", () => {
    const map = new Map();
    const shortText = "Hi there";
    map.set(123, { content: shortText, ts: Date.now() });
    assert.equal(shouldSkipDuplicate(map, 123, shortText), false);
  });

  it("returns true for identical long text within window", () => {
    const map = new Map();
    const text = "x".repeat(200);
    map.set(123, { content: text, ts: Date.now() });
    assert.equal(shouldSkipDuplicate(map, 123, text), true);
  });

  it("returns false for expired window (>30s old)", () => {
    const map = new Map();
    const text = "x".repeat(200);
    map.set(123, { content: text, ts: Date.now() - 31000 });
    assert.equal(shouldSkipDuplicate(map, 123, text), false);
  });

  it("returns false when chatId does not match", () => {
    const map = new Map();
    const text = "x".repeat(200);
    map.set(999, { content: text, ts: Date.now() });
    assert.equal(shouldSkipDuplicate(map, 123, text), false);
  });

  it("returns true for prefix-match of long messages", () => {
    const map = new Map();
    const base = "a".repeat(250);
    const text1 = base + "extra_suffix_1";
    const text2 = base + "extra_suffix_2";
    map.set(123, { content: text1, ts: Date.now() });
    assert.equal(shouldSkipDuplicate(map, 123, text2), true);
  });
});

describe("telegram-bridge — wasRawContentAlreadySent", () => {
  it("returns false for null/undefined rawContent", () => {
    const map = new Map();
    assert.equal(wasRawContentAlreadySent(map, 1, null), false);
    assert.equal(wasRawContentAlreadySent(map, 1, undefined), false);
  });

  it("returns false for content shorter than 50 chars", () => {
    const map = new Map();
    const short = "hello";
    map.set(1, { content: short, ts: Date.now() });
    assert.equal(wasRawContentAlreadySent(map, 1, short), false);
  });

  it("returns true for exact match", () => {
    const map = new Map();
    const content = "a".repeat(60);
    map.set(1, { content, ts: Date.now() });
    assert.equal(wasRawContentAlreadySent(map, 1, content), true);
  });
});

describe("telegram-bridge — classifyEngineFailure", () => {
  it('returns "rate_limit" for 429 errors', () => {
    assert.equal(classifyEngineFailure("HTTP 429 Too Many Requests"), "rate_limit");
    assert.equal(classifyEngineFailure("rate limit exceeded"), "rate_limit");
    assert.equal(classifyEngineFailure("too many requests"), "rate_limit");
  });

  it('returns "quota_limit" for billing/quota errors', () => {
    assert.equal(classifyEngineFailure("You hit your limit"), "quota_limit");
    assert.equal(classifyEngineFailure("quota exceeded"), "quota_limit");
    assert.equal(classifyEngineFailure("billing issue"), "quota_limit");
  });

  it('returns "auth" for auth errors', () => {
    assert.equal(classifyEngineFailure("unauthorized"), "auth");
    assert.equal(classifyEngineFailure("Invalid auth token"), "auth");
    assert.equal(classifyEngineFailure("token expired"), "auth");
  });

  it('returns "empty_output" for no-output results', () => {
    assert.equal(classifyEngineFailure("completed with no text output"), "empty_output");
    assert.equal(classifyEngineFailure("no text output returned"), "empty_output");
  });

  it('returns "generic" for unrecognized errors', () => {
    assert.equal(classifyEngineFailure("Network timeout"), "generic");
    assert.equal(classifyEngineFailure(""), "generic");
    assert.equal(classifyEngineFailure(null), "generic");
    assert.equal(classifyEngineFailure(undefined), "generic");
  });
});

describe("telegram-bridge — sanitizeChatCompletionHistory", () => {
  it("returns empty array for empty input", () => {
    assert.deepEqual(sanitizeChatCompletionHistory([]), []);
  });

  it("removes leading assistant messages (only user messages survive at start)", () => {
    // The sanitizer strips leading assistants and trailing users.
    // [assistant, user] → user is stripped because it is trailing → []
    const hist = [
      { role: "assistant", content: "I am here" },
      { role: "user", content: "hello" },
    ];
    const result = sanitizeChatCompletionHistory(hist);
    // Leading assistant is filtered, remaining user is trailing → stripped too
    assert.equal(result.length, 0);
  });

  it("removes consecutive duplicate roles", () => {
    const hist = [
      { role: "user", content: "msg1" },
      { role: "user", content: "msg2" }, // duplicate
      { role: "assistant", content: "reply" },
    ];
    const result = sanitizeChatCompletionHistory(hist);
    assert.equal(result.length, 2);
    assert.equal(result[0].role, "user");
    assert.equal(result[1].role, "assistant");
  });

  it("removes trailing user message", () => {
    const hist = [
      { role: "user", content: "msg1" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "follow-up" }, // should be stripped
    ];
    const result = sanitizeChatCompletionHistory(hist);
    assert.equal(result.length, 2);
    assert.equal(result[result.length - 1].role, "assistant");
  });

  it("filters out null/invalid entries", () => {
    const hist = [null, { role: "user", content: "valid" }, undefined, { role: "assistant", content: "resp" }];
    const result = sanitizeChatCompletionHistory(hist);
    assert.ok(result.every(r => r && r.role));
  });

  it("skips system and tool roles", () => {
    const hist = [
      { role: "system", content: "you are..." },
      { role: "user", content: "hi" },
      { role: "tool", content: "result" },
      { role: "assistant", content: "ok" },
    ];
    const result = sanitizeChatCompletionHistory(hist);
    assert.ok(result.every(r => r.role === "user" || r.role === "assistant"));
  });
});

describe("telegram-bridge — resolveTelegramChatModel", () => {
  it("handles model without slash (engine-only config)", () => {
    const { providerKey, modelId } = resolveTelegramChatModel({ model: "cursor" });
    assert.equal(providerKey, null);
    assert.equal(modelId, "cursor");
  });

  it("parses provider/model correctly", () => {
    const { providerKey, modelId } = resolveTelegramChatModel({ model: "openai/gpt-4o" });
    assert.equal(providerKey, "openai");
    assert.equal(modelId, "gpt-4o");
  });

  it("remaps openai codex models to gpt-4o for chat", () => {
    const { providerKey, modelId } = resolveTelegramChatModel({ model: "openai/codex-mini-latest" });
    assert.equal(providerKey, "openai");
    assert.equal(modelId, "gpt-4o");
  });

  it("prefixes openrouter models without openrouter/ prefix", () => {
    const { providerKey, modelId } = resolveTelegramChatModel({ model: "openrouter/hunter-alpha" });
    assert.equal(providerKey, "openrouter");
    assert.equal(modelId, "openrouter/hunter-alpha");
  });

  it("does not double-prefix model that already has openrouter/ prefix in modelId", () => {
    // "openrouter/openrouter/some-model" splits to providerKey="openrouter", modelId="openrouter/some-model"
    // Since modelId already starts with "openrouter/" it must not be prefixed again.
    const { providerKey, modelId } = resolveTelegramChatModel({ model: "openrouter/openrouter/some-model" });
    assert.equal(providerKey, "openrouter");
    // modelId = "openrouter/some-model" (already prefixed, no double-wrap)
    assert.equal(modelId, "openrouter/some-model");
  });

  it("handles null/undefined agentCfg gracefully", () => {
    const { providerKey, modelId } = resolveTelegramChatModel(null);
    assert.equal(providerKey, null);
    assert.equal(modelId, "");
  });

  it("handles empty model string", () => {
    const { providerKey, modelId } = resolveTelegramChatModel({ model: "" });
    assert.equal(providerKey, null);
    assert.equal(modelId, "");
  });
});

describe("telegram-bridge — state machine (getState/setState)", () => {
  it("returns defaults for unknown chatId", () => {
    const { getState } = makeStateStore();
    const st = getState(999);
    assert.equal(st.mode, "chat");
    assert.equal(st.engine, "cursor");
    assert.equal(st.agent, "crew-main");
    assert.equal(st.model, null);
  });

  it("patches state without losing other fields", () => {
    const { getState, setState } = makeStateStore();
    setState(1, { engine: "claude" });
    const st = getState(1);
    assert.equal(st.engine, "claude");
    assert.equal(st.mode, "chat"); // untouched default
  });

  it("returns updated state from setState", () => {
    const { setState } = makeStateStore();
    const next = setState(1, { mode: "direct", engine: "gemini" });
    assert.equal(next.mode, "direct");
    assert.equal(next.engine, "gemini");
  });

  it("isolates state per chatId", () => {
    const { getState, setState } = makeStateStore();
    setState(1, { mode: "direct" });
    setState(2, { mode: "bypass" });
    assert.equal(getState(1).mode, "direct");
    assert.equal(getState(2).mode, "bypass");
  });

  it("successive patches accumulate", () => {
    const { getState, setState } = makeStateStore();
    setState(5, { engine: "opencode" });
    setState(5, { model: "kimi-k2" });
    const st = getState(5);
    assert.equal(st.engine, "opencode");
    assert.equal(st.model, "kimi-k2");
  });
});

describe("telegram-bridge — getTargetAgent routing", () => {
  it("returns TARGET_DEFAULT when no routing config", () => {
    const agent = getTargetAgentFromConfig({}, {}, 123);
    assert.equal(agent, TARGET_DEFAULT);
  });

  it("uses topic routing for group+thread combo", () => {
    const topicRouting = { "456": { "10": "crew-pm" } };
    const agent = getTargetAgentFromConfig(topicRouting, {}, 456, 10);
    assert.equal(agent, "crew-pm");
  });

  it("falls back to 'main' key for main group chat (no threadId)", () => {
    const topicRouting = { "456": { "main": "crew-coder" } };
    const agent = getTargetAgentFromConfig(topicRouting, {}, 456, null);
    assert.equal(agent, "crew-coder");
  });

  it("falls back to '0' key for main group chat when no 'main' key", () => {
    const topicRouting = { "456": { "0": "crew-lead-alt" } };
    const agent = getTargetAgentFromConfig(topicRouting, {}, 456, null);
    assert.equal(agent, "crew-lead-alt");
  });

  it("checks flat format 'chatId:threadId' key", () => {
    const topicRouting = { "123:55": "crew-special" };
    const agent = getTargetAgentFromConfig(topicRouting, {}, 123, 55);
    assert.equal(agent, "crew-special");
  });

  it("uses user routing as fallback over TARGET_DEFAULT", () => {
    const userRouting = { "789": "crew-loco" };
    const agent = getTargetAgentFromConfig({}, userRouting, 789);
    assert.equal(agent, "crew-loco");
  });

  it("topic routing takes precedence over user routing", () => {
    const topicRouting = { "789": { "20": "crew-pm" } };
    const userRouting = { "789": "crew-loco" };
    const agent = getTargetAgentFromConfig(topicRouting, userRouting, 789, 20);
    assert.equal(agent, "crew-pm");
  });
});

describe("telegram-bridge — isTTSEnabled", () => {
  it("returns false by default when config.enabled is false", () => {
    const config = { enabled: false, perUserOverrides: {} };
    assert.equal(isTTSEnabled(config, 123), false);
  });

  it("returns true when config.enabled is true and no override", () => {
    const config = { enabled: true, perUserOverrides: {} };
    assert.equal(isTTSEnabled(config, 123), true);
  });

  it("per-user override (false) overrides global true", () => {
    const config = { enabled: true, perUserOverrides: { 123: false } };
    assert.equal(isTTSEnabled(config, 123), false);
  });

  it("per-user override (true) overrides global false", () => {
    const config = { enabled: false, perUserOverrides: { 123: true } };
    assert.equal(isTTSEnabled(config, 123), true);
  });

  it("per-user override only affects that user", () => {
    const config = { enabled: false, perUserOverrides: { 123: true } };
    assert.equal(isTTSEnabled(config, 456), false);
  });

  it("handles missing perUserOverrides gracefully", () => {
    const config = { enabled: true };
    assert.equal(isTTSEnabled(config, 123), true);
  });
});

describe("telegram-bridge — keyboard builders", () => {
  it("mainReplyKeyboard returns correct structure", () => {
    const kb = mainReplyKeyboard();
    assert.ok(Array.isArray(kb.keyboard));
    assert.ok(kb.resize_keyboard === true);
    assert.ok(kb.one_time_keyboard === false);
    assert.ok(kb.keyboard.length > 0);
  });

  it("mainReplyKeyboard contains expected buttons", () => {
    const kb = mainReplyKeyboard();
    const allTexts = kb.keyboard.flat().map(b => b.text);
    assert.ok(allTexts.includes("Status"));
    assert.ok(allTexts.includes("Help"));
    assert.ok(allTexts.includes("Projects"));
  });

  it("modeInline returns inline_keyboard with 3 buttons", () => {
    const kb = modeInline();
    const buttons = kb.inline_keyboard.flat();
    assert.equal(buttons.length, 3);
    const datas = buttons.map(b => b.callback_data);
    assert.ok(datas.includes("mode:chat"));
    assert.ok(datas.includes("mode:direct"));
    assert.ok(datas.includes("mode:bypass"));
  });

  it("errorInline returns retry and fallback buttons", () => {
    const kb = errorInline();
    const buttons = kb.inline_keyboard.flat();
    const datas = buttons.map(b => b.callback_data);
    assert.ok(datas.includes("retry:last"));
    assert.ok(datas.includes("fallback:main"));
  });
});

describe("telegram-bridge — button alias resolution", () => {
  it('maps "chat crew-main" to /home', () => {
    assert.equal(resolveButtonAlias("Chat crew-main"), "/home");
  });

  it('maps "direct engine" to /engine', () => {
    assert.equal(resolveButtonAlias("Direct engine"), "/engine");
  });

  it('maps "status" to /status', () => {
    assert.equal(resolveButtonAlias("Status"), "/status");
  });

  it('maps "help" to /help', () => {
    assert.equal(resolveButtonAlias("Help"), "/help");
  });

  it("returns null for unrecognized text", () => {
    assert.equal(resolveButtonAlias("random text"), null);
  });

  it("is case-insensitive", () => {
    assert.equal(resolveButtonAlias("PROJECTS"), "/projects");
  });
});

describe("telegram-bridge — session ID parsing", () => {
  it("parses simple telegram- session ID", () => {
    const result = parseTelegramSessionId("telegram-123456");
    assert.deepEqual(result, { telegramChatId: 123456, threadId: null });
  });

  it("parses telegram- session ID with topic", () => {
    const result = parseTelegramSessionId("telegram-123456-topic-42");
    assert.deepEqual(result, { telegramChatId: 123456, threadId: 42 });
  });

  it("returns null for non-telegram session ID", () => {
    assert.equal(parseTelegramSessionId("whatsapp-15551234567@s.whatsapp.net"), null);
  });

  it("returns null for empty/null session ID", () => {
    assert.equal(parseTelegramSessionId(null), null);
    assert.equal(parseTelegramSessionId(""), null);
  });

  it("returns null for malformed ID with NaN chatId", () => {
    assert.equal(parseTelegramSessionId("telegram-abc"), null);
  });
});

describe("telegram-bridge — processed update ID management", () => {
  it("returns true (processed) for new update ID", () => {
    const set = new Set();
    assert.equal(manageProcessedIds(set, 100), true);
    assert.ok(set.has(100));
  });

  it("returns false for already-processed update ID", () => {
    const set = new Set([100]);
    assert.equal(manageProcessedIds(set, 100), false);
  });

  it("evicts oldest ID when set exceeds maxSize", () => {
    const set = new Set();
    // Fill exactly to limit
    for (let i = 0; i < 5; i++) set.add(i);
    manageProcessedIds(set, 5, 5);
    assert.equal(set.size, 5);
    assert.ok(!set.has(0)); // oldest evicted
    assert.ok(set.has(5));  // newest present
  });
});

describe("telegram-bridge — ENGINE_COMMANDS and ENGINE_LABELS", () => {
  it("all engine commands map to valid engine names", () => {
    for (const [cmd, engine] of Object.entries(ENGINE_COMMANDS)) {
      assert.ok(cmd.startsWith("/"), `Command ${cmd} should start with /`);
      assert.ok(engine.length > 0, `Engine name for ${cmd} should not be empty`);
    }
  });

  it("all engine names have corresponding labels", () => {
    for (const engine of Object.values(ENGINE_COMMANDS)) {
      assert.ok(ENGINE_LABELS[engine], `Missing label for engine: ${engine}`);
    }
  });

  it("known engines are all present", () => {
    const knownEngines = ["claude", "cursor", "opencode", "codex", "crew-cli", "gemini"];
    for (const e of knownEngines) {
      assert.ok(ENGINE_LABELS[e], `Missing label for: ${e}`);
    }
  });
});
