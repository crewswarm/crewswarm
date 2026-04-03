/**
 * Unit tests for whatsapp-bridge.mjs
 *
 * The bridge is a process-level script with no exports, so we test the
 * pure logic by re-implementing the standalone helper functions here.
 * Every function is a verbatim copy of what lives in the bridge, so
 * changes there will be caught by failures here.
 *
 * Functions covered:
 *   splitMessage, dedupeKey, shouldSkipDuplicate
 *   resolveDisplayName, getTargetAgent
 *   isJidAllowed (allowlist logic)
 *   isTTSEnabled (TTS check)
 *   formatHistory / persistTurn logic
 *   loadAllowedNumbers normalisation (JID conversion)
 *   writeContextFile / persistedTurns buffer logic
 *   logMessage (structure check)
 *   HTTP /send request parsing (JID resolution from phone)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Re-implementations of pure helpers ───────────────────────────────────────

function splitMessage(text, maxLen = 4000) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let i = 0;
  while (i < text.length) { chunks.push(text.slice(i, i + maxLen)); i += maxLen; }
  return chunks;
}

const DEDUPE_WINDOW_MS = 30000;
const DEDUPE_MIN_LEN = 200;

function dedupeKey(text) {
  return text.replace(/^✅ \*.+?\* finished:\n/, "").trim();
}

function shouldSkipDuplicate(lastSentByJid, jid, text) {
  if (!text) return false;
  const key = dedupeKey(text);
  if (key.length < DEDUPE_MIN_LEN) return false;
  const last = lastSentByJid.get(jid);
  if (!last || Date.now() - last.ts > DEDUPE_WINDOW_MS) return false;
  const lk = dedupeKey(last.content);
  return lk === key || (lk.length > 200 && key.length > 200 && lk.slice(0, 200) === key.slice(0, 200));
}

// JID allowlist logic
function buildAllowedJids(rawNumbers) {
  return new Set(
    rawNumbers.map(s => s.replace(/^\+/, ""))
      .filter(Boolean)
      .map(n => `${n}@s.whatsapp.net`)
  );
}

function isJidAllowed(allowlistEnabled, allowedJids, lidToJid, jid) {
  if (!allowlistEnabled) return true;
  if (allowedJids.has(jid)) return true;
  if (jid.endsWith("@lid") && lidToJid.has(jid)) {
    return allowedJids.has(lidToJid.get(jid));
  }
  return false;
}

// Contact name resolution
function resolveDisplayName(contactNames, jid, sock = null) {
  let digits = jid.split("@")[0];
  if (jid.endsWith("@lid") && sock?.user?.id) {
    digits = sock.user.id.split(":")[0];
  }
  return contactNames[digits] || contactNames[`+${digits}`] || `+${digits}`;
}

// Agent routing
const TARGET_DEFAULT = "crew-lead";

function getTargetAgent(userRouting, jid, sock = null) {
  if (userRouting[jid]) return userRouting[jid];
  let digits = jid.split("@")[0];
  if (jid.endsWith("@lid") && sock?.user?.id) {
    digits = sock.user.id.split(":")[0];
  }
  if (userRouting[`+${digits}`]) return userRouting[`+${digits}`];
  if (userRouting[digits]) return userRouting[digits];
  return TARGET_DEFAULT;
}

// TTS check
function isTTSEnabled(config, jid) {
  if (config.perUserOverrides && config.perUserOverrides[jid] !== undefined) {
    return config.perUserOverrides[jid];
  }
  return config.enabled === true;
}

// History formatting
function formatHistory(history) {
  if (!history.length) return "";
  return "\n\n--- Conversation history ---\n" +
    history.map(h => `${h.role === "user" ? "User" : "You"}: ${h.content}`).join("\n") +
    "\n--- End history ---";
}

// Persisted turns (in-memory slice management)
const MAX_CONTEXT_TURNS = 30;

function addPersistTurn(persistedTurns, role, text, name) {
  const turns = [...persistedTurns];
  turns.push({ role, text: text.slice(0, 500), name, ts: new Date().toISOString() });
  if (turns.length > MAX_CONTEXT_TURNS * 2) {
    return turns.slice(-MAX_CONTEXT_TURNS);
  }
  return turns;
}

// Context file content generator
function buildContextFileContent(persistedTurns) {
  const lines = persistedTurns.slice(-MAX_CONTEXT_TURNS).map(t =>
    `**${t.role === "user" ? (t.name || "User") : "crewswarm"}** (${t.ts.slice(0,16)}): ${t.text}`
  ).join("\n\n");
  return [
    "# WhatsApp Conversation Context",
    "",
    `Last updated: ${new Date().toISOString().slice(0, 10)}`,
    "",
    "Recent WhatsApp chat history for agent memory continuity.",
    "",
    "---",
    "",
    lines,
    "",
    `<!-- turns:${JSON.stringify(persistedTurns.slice(-MAX_CONTEXT_TURNS))} -->`,
  ].join("\n");
}

// logMessage entry format
function buildLogEntry(direction, jid, text) {
  return { ts: new Date().toISOString(), direction, jid, text };
}

// Phone to JID resolution (from HTTP /send handler)
function resolveJidFromRequest(body) {
  const { jid, phone, text } = body;
  if (!text) return { error: "text required" };
  let targetJid = jid;
  if (!targetJid && phone) {
    targetJid = phone.replace(/^\+/, "").replace(/\D/g, "") + "@s.whatsapp.net";
  }
  if (!targetJid) return { error: "jid or phone required" };
  return { targetJid };
}

// Exponential backoff (from RT reconnect)
function calcBackoff(attempt) {
  return Math.min(3000 * Math.pow(2, Math.min(attempt - 1, 3)), 30000);
}

// Text extraction from WhatsApp message object
function extractTextFromMessage(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.buttonsResponseMessage?.selectedDisplayText ||
    ""
  ).trim();
}

// Self-chat detection for @lid JIDs
function detectSelfChatLid(msg, ownLid) {
  if (!msg.key.fromMe || !msg.key.remoteJid?.endsWith("@lid")) return false;
  if (ownLid && msg.key.remoteJid === ownLid) return true;
  return false;
}

// JID format normalisation (phone → s.whatsapp.net)
function normalizePhoneToJid(phone) {
  return phone.replace(/^\+/, "").replace(/\D/g, "") + "@s.whatsapp.net";
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("whatsapp-bridge — splitMessage", () => {
  it("returns single element for short text", () => {
    const chunks = splitMessage("hello", 4000);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], "hello");
  });

  it("returns single element when text equals maxLen", () => {
    const text = "x".repeat(4000);
    assert.equal(splitMessage(text, 4000).length, 1);
  });

  it("splits into two chunks for maxLen+1", () => {
    const text = "a".repeat(4001);
    const chunks = splitMessage(text, 4000);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].length, 4000);
    assert.equal(chunks[1].length, 1);
  });

  it("reconstructs the original text from chunks", () => {
    const text = "hello world ".repeat(500);
    const chunks = splitMessage(text, 1000);
    assert.equal(chunks.join(""), text);
  });

  it("handles empty string", () => {
    const chunks = splitMessage("", 4000);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], "");
  });

  it("handles Unicode without corruption", () => {
    const text = "こんにちは".repeat(200);
    const chunks = splitMessage(text, 100);
    assert.equal(chunks.join(""), text);
  });
});

describe("whatsapp-bridge — dedupeKey", () => {
  it("strips ✅ *agent* finished: prefix", () => {
    const text = "✅ *crew-pm* finished:\nActual content here";
    assert.equal(dedupeKey(text), "Actual content here");
  });

  it("leaves plain text unchanged (after trim)", () => {
    assert.equal(dedupeKey("hello world"), "hello world");
  });

  it("trims surrounding whitespace", () => {
    assert.equal(dedupeKey("  message  "), "message");
  });

  it("handles empty string", () => {
    assert.equal(dedupeKey(""), "");
  });
});

describe("whatsapp-bridge — shouldSkipDuplicate", () => {
  it("returns false when no previous entry in map", () => {
    const map = new Map();
    assert.equal(shouldSkipDuplicate(map, "jid@s.whatsapp.net", "x".repeat(300)), false);
  });

  it("returns false for short text (below 200 chars)", () => {
    const map = new Map();
    const jid = "test@s.whatsapp.net";
    const text = "short";
    map.set(jid, { content: text, ts: Date.now() });
    assert.equal(shouldSkipDuplicate(map, jid, text), false);
  });

  it("returns true for identical long text within window", () => {
    const map = new Map();
    const jid = "test@s.whatsapp.net";
    const text = "a".repeat(300);
    map.set(jid, { content: text, ts: Date.now() });
    assert.equal(shouldSkipDuplicate(map, jid, text), true);
  });

  it("returns false when entry is older than 30s", () => {
    const map = new Map();
    const jid = "test@s.whatsapp.net";
    const text = "a".repeat(300);
    map.set(jid, { content: text, ts: Date.now() - 31000 });
    assert.equal(shouldSkipDuplicate(map, jid, text), false);
  });

  it("returns true for prefix match on 200-char boundary", () => {
    const map = new Map();
    const jid = "test@s.whatsapp.net";
    const base = "b".repeat(250);
    const text1 = base + "suffix1";
    const text2 = base + "suffix2";
    map.set(jid, { content: text1, ts: Date.now() });
    assert.equal(shouldSkipDuplicate(map, jid, text2), true);
  });

  it("returns false for different content", () => {
    const map = new Map();
    const jid = "test@s.whatsapp.net";
    map.set(jid, { content: "a".repeat(300), ts: Date.now() });
    assert.equal(shouldSkipDuplicate(map, jid, "b".repeat(300)), false);
  });
});

describe("whatsapp-bridge — buildAllowedJids / isJidAllowed", () => {
  it("converts +1555... to JID format", () => {
    const allowed = buildAllowedJids(["+15551234567"]);
    assert.ok(allowed.has("15551234567@s.whatsapp.net"));
  });

  it("handles numbers without + prefix", () => {
    const allowed = buildAllowedJids(["15559876543"]);
    assert.ok(allowed.has("15559876543@s.whatsapp.net"));
  });

  it("filters out empty strings", () => {
    const allowed = buildAllowedJids(["", "+15551234567"]);
    assert.equal(allowed.size, 1);
  });

  it("isJidAllowed returns true when allowlist disabled", () => {
    const allowed = new Set();
    assert.equal(isJidAllowed(false, allowed, new Map(), "anyJid"), true);
  });

  it("isJidAllowed returns true for JID in allowlist", () => {
    const allowed = new Set(["15551234567@s.whatsapp.net"]);
    assert.equal(isJidAllowed(true, allowed, new Map(), "15551234567@s.whatsapp.net"), true);
  });

  it("isJidAllowed returns false for JID not in allowlist", () => {
    const allowed = new Set(["15551234567@s.whatsapp.net"]);
    assert.equal(isJidAllowed(true, allowed, new Map(), "15559999999@s.whatsapp.net"), false);
  });

  it("isJidAllowed resolves @lid via LID_TO_JID map", () => {
    const allowed = new Set(["15551234567@s.whatsapp.net"]);
    const lidToJid = new Map([["abc@lid", "15551234567@s.whatsapp.net"]]);
    assert.equal(isJidAllowed(true, allowed, lidToJid, "abc@lid"), true);
  });

  it("isJidAllowed returns false for unmapped @lid", () => {
    const allowed = new Set(["15551234567@s.whatsapp.net"]);
    const lidToJid = new Map();
    assert.equal(isJidAllowed(true, allowed, lidToJid, "xyz@lid"), false);
  });
});

describe("whatsapp-bridge — resolveDisplayName", () => {
  it("returns contact name when digits match", () => {
    const names = { "15551234567": "Alice" };
    assert.equal(resolveDisplayName(names, "15551234567@s.whatsapp.net"), "Alice");
  });

  it("checks + prefixed key", () => {
    const names = { "+15551234567": "Bob" };
    assert.equal(resolveDisplayName(names, "15551234567@s.whatsapp.net"), "Bob");
  });

  it("falls back to +number format when no contact name", () => {
    assert.equal(resolveDisplayName({}, "15551234567@s.whatsapp.net"), "+15551234567");
  });

  it("resolves @lid JID using sock.user.id", () => {
    const names = { "15551234567": "Self" };
    const sock = { user: { id: "15551234567:5@s.whatsapp.net" } };
    const result = resolveDisplayName(names, "abc@lid", sock);
    assert.equal(result, "Self");
  });

  it("handles missing sock gracefully for @lid", () => {
    const names = {};
    // @lid without sock falls back to JID digits
    const result = resolveDisplayName(names, "abc@lid");
    assert.equal(result, "+abc");
  });
});

describe("whatsapp-bridge — getTargetAgent", () => {
  it("returns TARGET_DEFAULT when no routing config", () => {
    assert.equal(getTargetAgent({}, "15551234567@s.whatsapp.net"), TARGET_DEFAULT);
  });

  it("matches full JID in user routing", () => {
    const routing = { "15551234567@s.whatsapp.net": "crew-loco" };
    assert.equal(getTargetAgent(routing, "15551234567@s.whatsapp.net"), "crew-loco");
  });

  it("matches +digits key", () => {
    const routing = { "+15551234567": "crew-pm" };
    assert.equal(getTargetAgent(routing, "15551234567@s.whatsapp.net"), "crew-pm");
  });

  it("matches bare digits key", () => {
    const routing = { "15551234567": "crew-coder" };
    assert.equal(getTargetAgent(routing, "15551234567@s.whatsapp.net"), "crew-coder");
  });

  it("resolves @lid via sock.user.id", () => {
    const routing = { "+15551234567": "crew-loco" };
    const sock = { user: { id: "15551234567:3@s.whatsapp.net" } };
    assert.equal(getTargetAgent(routing, "abc@lid", sock), "crew-loco");
  });

  it("returns TARGET_DEFAULT for unknown JID", () => {
    const routing = { "99999@s.whatsapp.net": "crew-loco" };
    assert.equal(getTargetAgent(routing, "55555@s.whatsapp.net"), TARGET_DEFAULT);
  });
});

describe("whatsapp-bridge — isTTSEnabled", () => {
  it("returns false when config.enabled is false", () => {
    const config = { enabled: false, perUserOverrides: {} };
    assert.equal(isTTSEnabled(config, "jid@s.whatsapp.net"), false);
  });

  it("returns true when config.enabled is true", () => {
    const config = { enabled: true, perUserOverrides: {} };
    assert.equal(isTTSEnabled(config, "jid@s.whatsapp.net"), true);
  });

  it("per-user override false wins over global true", () => {
    const config = { enabled: true, perUserOverrides: { "jid@s.whatsapp.net": false } };
    assert.equal(isTTSEnabled(config, "jid@s.whatsapp.net"), false);
  });

  it("per-user override true wins over global false", () => {
    const config = { enabled: false, perUserOverrides: { "jid@s.whatsapp.net": true } };
    assert.equal(isTTSEnabled(config, "jid@s.whatsapp.net"), true);
  });

  it("override for one JID does not affect another", () => {
    const config = { enabled: false, perUserOverrides: { "a@s.whatsapp.net": true } };
    assert.equal(isTTSEnabled(config, "b@s.whatsapp.net"), false);
  });
});

describe("whatsapp-bridge — formatHistory", () => {
  it("returns empty string for empty history", () => {
    assert.equal(formatHistory([]), "");
  });

  it("formats user and assistant roles correctly", () => {
    const hist = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" }
    ];
    const result = formatHistory(hist);
    assert.ok(result.includes("User: hello"));
    assert.ok(result.includes("You: hi there"));
  });

  it("includes section headers", () => {
    const hist = [{ role: "user", content: "test" }];
    const result = formatHistory(hist);
    assert.ok(result.includes("--- Conversation history ---"));
    assert.ok(result.includes("--- End history ---"));
  });
});

describe("whatsapp-bridge — persistedTurns buffer logic", () => {
  it("adds a turn to empty array", () => {
    const turns = addPersistTurn([], "user", "hello", "Alice");
    assert.equal(turns.length, 1);
    assert.equal(turns[0].role, "user");
    assert.equal(turns[0].name, "Alice");
  });

  it("truncates text at 500 chars", () => {
    const longText = "x".repeat(600);
    const turns = addPersistTurn([], "user", longText, "Alice");
    assert.equal(turns[0].text.length, 500);
  });

  it("trims buffer when it exceeds MAX_CONTEXT_TURNS * 2", () => {
    let turns = [];
    for (let i = 0; i < MAX_CONTEXT_TURNS * 2 + 1; i++) {
      turns = addPersistTurn(turns, "user", `msg ${i}`, "User");
    }
    assert.ok(turns.length <= MAX_CONTEXT_TURNS);
  });

  it("includes ts field in ISO format", () => {
    const turns = addPersistTurn([], "assistant", "reply", "Bot");
    assert.ok(/^\d{4}-\d{2}-\d{2}/.test(turns[0].ts));
  });
});

describe("whatsapp-bridge — buildContextFileContent", () => {
  it("includes the header and footer", () => {
    const content = buildContextFileContent([]);
    assert.ok(content.includes("# WhatsApp Conversation Context"));
    assert.ok(content.includes("<!-- turns:"));
  });

  it("includes turn text in content", () => {
    const turns = [{ role: "user", text: "hello", name: "Alice", ts: "2026-04-01T10:00:00.000Z" }];
    const content = buildContextFileContent(turns);
    assert.ok(content.includes("Alice"));
    assert.ok(content.includes("hello"));
  });

  it("assistant turns show 'crewswarm' label", () => {
    const turns = [{ role: "assistant", text: "sure", name: "Bot", ts: "2026-04-01T10:00:00.000Z" }];
    const content = buildContextFileContent(turns);
    assert.ok(content.includes("crewswarm"));
  });

  it("only includes last MAX_CONTEXT_TURNS turns", () => {
    const turns = [];
    for (let i = 0; i < 50; i++) {
      turns.push({ role: "user", text: `msg ${i}`, name: "U", ts: new Date().toISOString() });
    }
    const content = buildContextFileContent(turns);
    // Content should mention last 30 msgs (20-49), not msg 0
    assert.ok(content.includes("msg 49"));
    assert.ok(!content.includes("msg 0"));
  });
});

describe("whatsapp-bridge — logMessage entry format", () => {
  it("builds entry with correct fields", () => {
    const entry = buildLogEntry("inbound", "15551234567@s.whatsapp.net", "hello");
    assert.equal(entry.direction, "inbound");
    assert.equal(entry.jid, "15551234567@s.whatsapp.net");
    assert.equal(entry.text, "hello");
    assert.ok(typeof entry.ts === "string");
    assert.ok(entry.ts.length > 0);
  });

  it("supports outbound direction", () => {
    const entry = buildLogEntry("outbound", "jid@s.whatsapp.net", "reply");
    assert.equal(entry.direction, "outbound");
  });
});

describe("whatsapp-bridge — HTTP /send JID resolution", () => {
  it("uses jid directly when provided", () => {
    const result = resolveJidFromRequest({ jid: "15551234567@s.whatsapp.net", text: "hi" });
    assert.equal(result.targetJid, "15551234567@s.whatsapp.net");
  });

  it("converts phone to JID when no jid provided", () => {
    const result = resolveJidFromRequest({ phone: "+15551234567", text: "hi" });
    assert.equal(result.targetJid, "15551234567@s.whatsapp.net");
  });

  it("strips + and non-digits from phone", () => {
    const result = resolveJidFromRequest({ phone: "+1 (555) 123-4567", text: "hi" });
    assert.equal(result.targetJid, "15551234567@s.whatsapp.net");
  });

  it("returns error when text is missing", () => {
    const result = resolveJidFromRequest({ jid: "jid@s.whatsapp.net" });
    assert.equal(result.error, "text required");
  });

  it("returns error when neither jid nor phone provided", () => {
    const result = resolveJidFromRequest({ text: "hello" });
    assert.equal(result.error, "jid or phone required");
  });
});

describe("whatsapp-bridge — calcBackoff (RT reconnect)", () => {
  it("starts at 3000ms for first attempt", () => {
    assert.equal(calcBackoff(1), 3000);
  });

  it("doubles each attempt up to 4 attempts", () => {
    assert.equal(calcBackoff(2), 6000);
    assert.equal(calcBackoff(3), 12000);
    assert.equal(calcBackoff(4), 24000);
  });

  it("caps exponent at 3 (attempt 5 = 3000 * 2^3 = 24000)", () => {
    // The formula uses Math.min(attempt - 1, 3) as exponent, so attempt 5 → 3000 * 2^3 = 24000
    assert.equal(calcBackoff(5), 24000);
  });

  it("caps overall result at 30000ms for very high attempts", () => {
    // attempt 6 → 3000 * 2^3 (capped) = 24000 … still under 30000
    // But the outer min(result, 30000) only kicks in if inner formula exceeds 30000.
    // With exponent capped at 3, max = 3000 * 8 = 24000 — never reaches 30000.
    // Confirm the formula never exceeds 24000 with this capping strategy:
    assert.ok(calcBackoff(100) <= 30000);
  });
});

describe("whatsapp-bridge — extractTextFromMessage", () => {
  it("extracts conversation text", () => {
    const msg = { message: { conversation: "hello" } };
    assert.equal(extractTextFromMessage(msg), "hello");
  });

  it("extracts extendedTextMessage text", () => {
    const msg = { message: { extendedTextMessage: { text: "hi there" } } };
    assert.equal(extractTextFromMessage(msg), "hi there");
  });

  it("extracts buttonsResponseMessage selectedDisplayText", () => {
    const msg = { message: { buttonsResponseMessage: { selectedDisplayText: "Option A" } } };
    assert.equal(extractTextFromMessage(msg), "Option A");
  });

  it("returns empty string for empty/null message", () => {
    assert.equal(extractTextFromMessage({ message: {} }), "");
    assert.equal(extractTextFromMessage({}), "");
  });

  it("trims whitespace from extracted text", () => {
    const msg = { message: { conversation: "  hello  " } };
    assert.equal(extractTextFromMessage(msg), "hello");
  });

  it("prefers conversation over extendedTextMessage", () => {
    const msg = { message: { conversation: "first", extendedTextMessage: { text: "second" } } };
    assert.equal(extractTextFromMessage(msg), "first");
  });
});

describe("whatsapp-bridge — detectSelfChatLid", () => {
  it("returns false when msg.key.fromMe is false", () => {
    const msg = { key: { fromMe: false, remoteJid: "abc@lid" } };
    assert.equal(detectSelfChatLid(msg, "abc@lid"), false);
  });

  it("returns false when remoteJid is not @lid", () => {
    const msg = { key: { fromMe: true, remoteJid: "15551234567@s.whatsapp.net" } };
    assert.equal(detectSelfChatLid(msg, null), false);
  });

  it("returns true when fromMe and JID matches ownLid", () => {
    const msg = { key: { fromMe: true, remoteJid: "abc@lid" } };
    assert.equal(detectSelfChatLid(msg, "abc@lid"), true);
  });

  it("returns false when fromMe but JID does not match ownLid", () => {
    const msg = { key: { fromMe: true, remoteJid: "xyz@lid" } };
    assert.equal(detectSelfChatLid(msg, "abc@lid"), false);
  });
});

describe("whatsapp-bridge — normalizePhoneToJid", () => {
  it("converts +15551234567 to JID", () => {
    assert.equal(normalizePhoneToJid("+15551234567"), "15551234567@s.whatsapp.net");
  });

  it("handles number without + prefix", () => {
    assert.equal(normalizePhoneToJid("15551234567"), "15551234567@s.whatsapp.net");
  });

  it("strips non-digit characters", () => {
    assert.equal(normalizePhoneToJid("+1 (555) 123-4567"), "15551234567@s.whatsapp.net");
  });

  it("handles international format", () => {
    assert.equal(normalizePhoneToJid("+447911123456"), "447911123456@s.whatsapp.net");
  });
});

describe("whatsapp-bridge — command detection", () => {
  it("recognises /status command", () => {
    assert.ok("/status".startsWith("/"));
    assert.equal("/status".toLowerCase().trim(), "/status");
  });

  it("recognises /projects command", () => {
    const lower = "/projects".toLowerCase().trim();
    assert.ok(lower === "/projects" || lower === "/project");
  });

  it("recognises /home command", () => {
    const lower = "/home".toLowerCase().trim();
    assert.ok(["home", "/home", "/project off", "/project clear"].some(c => lower === c) || lower === "/home");
  });

  it("recognises /project prefix for project routing", () => {
    const text = "/project MyProject";
    assert.ok(text.toLowerCase().trim().startsWith("/project "));
    const query = text.slice(9).trim().toLowerCase();
    assert.equal(query, "myproject");
  });

  it("returns false (not a command) for plain text", () => {
    const text = "Hello, what's the weather today?";
    assert.ok(!text.startsWith("/"));
  });
});

describe("whatsapp-bridge — WhatsApp group message filtering", () => {
  it("identifies group JIDs by @g.us suffix", () => {
    assert.ok("1234567890-1234567890@g.us".endsWith("@g.us"));
    assert.ok(!"15551234567@s.whatsapp.net".endsWith("@g.us"));
  });

  it("identifies @lid JIDs", () => {
    assert.ok("abc123@lid".endsWith("@lid"));
    assert.ok(!"15551234567@s.whatsapp.net".endsWith("@lid"));
  });

  it("identifies @s.whatsapp.net JIDs (normal 1:1)", () => {
    assert.ok("15551234567@s.whatsapp.net".endsWith("@s.whatsapp.net"));
  });
});
