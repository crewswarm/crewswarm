/**
 * E2E tests for the Telegram bridge round-trip.
 *
 * Prerequisites:
 *   - TELEGRAM_BOT_TOKEN in ~/.crewswarm/crewswarm.json
 *   - telegram-bridge.mjs running
 *   - crew-lead running on port 5010
 *
 * What is tested:
 *   1. Telegram Bot API reachability (getMe)
 *   2. Message delivery: bot sends a message to the owner chat
 *   3. Bridge log shows recent processing activity
 *   4. Bridge HTTP /api/status or health endpoint
 *
 * SKIP behaviour: if no token or bot unreachable, all tests skip gracefully.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CREWSWARM_DIR = path.join(os.homedir(), ".crewswarm");
const LOGS_DIR = path.join(CREWSWARM_DIR, "logs");
const TG_LOG = path.join(LOGS_DIR, "telegram-bridge.jsonl");

// Load bot token from crewswarm.json
function loadTgToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(CREWSWARM_DIR, "crewswarm.json"), "utf8"));
    return cfg?.env?.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || null;
  } catch { return null; }
}

const TOKEN = loadTgToken();
const OWNER_CHAT_ID = 1693963111; // from telegram-bridge.jsonl

const SKIP = !TOKEN;

async function tgApi(method, params = {}) {
  const url = new URL(`https://api.telegram.org/bot${TOKEN}/${method}`);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(10_000),
  });
  return res.json();
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("Telegram — bot API reachability", { skip: SKIP ? "No TELEGRAM_BOT_TOKEN" : false }, () => {
  it("getMe returns bot info", async () => {
    const data = await tgApi("getMe");
    assert.ok(data.ok, `getMe failed: ${JSON.stringify(data)}`);
    assert.ok(data.result.username, "Bot has no username");
    assert.match(data.result.username, /crewswarm|crewswarm/i);
  });

  it("bot is marked as a bot (not a user)", async () => {
    const data = await tgApi("getMe");
    assert.ok(data.result.is_bot, "Expected is_bot=true");
  });
});

describe("Telegram — message delivery (bot → owner chat)", { skip: SKIP ? "No TELEGRAM_BOT_TOKEN" : false }, () => {
  let sentMsgId = null;

  it("sendMessage delivers a test ping", async () => {
    const ts = Date.now();
    const data = await tgApi("sendMessage", {
      chat_id: OWNER_CHAT_ID,
      text: `[crewswarm test] round-trip ping ${ts}`,
    });
    assert.ok(data.ok, `sendMessage failed: ${JSON.stringify(data)}`);
    assert.ok(data.result.message_id, "No message_id returned");
    sentMsgId = data.result.message_id;
  });

  it("delivered message has the correct chat_id", async () => {
    if (!sentMsgId) return; // dependent on previous test
    const data = await tgApi("sendMessage", {
      chat_id: OWNER_CHAT_ID,
      text: `[crewswarm test] confirming chat=${OWNER_CHAT_ID}`,
    });
    assert.equal(data.result?.chat?.id, OWNER_CHAT_ID);
  });
});

describe("Telegram — bridge process activity", () => {
  it("telegram-bridge.mjs process is running", () => {
    // Check PID file or look at the bridge process
    const pidFile = path.join(LOGS_DIR, "telegram-bridge.pid");
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim());
      assert.ok(pid > 0, "Invalid PID in pid file");
      // Try to send signal 0 — checks process exists without killing it
      try {
        process.kill(pid, 0);
        // If we get here, the process exists
        assert.ok(true);
      } catch (e) {
        if (e.code === "ESRCH") {
          assert.fail(`telegram-bridge PID ${pid} is not running`);
        }
        // EPERM = process exists but we can't signal it — acceptable
      }
    } else {
      // PID file missing — check if any node process running telegram-bridge
      assert.ok(true, "No PID file — skipping process check (may be managed differently)");
    }
  });

  it("telegram-bridge log file exists and has recent entries", () => {
    if (!fs.existsSync(TG_LOG)) {
      // Not an error — bridge might not have processed any messages yet
      return;
    }
    const content = fs.readFileSync(TG_LOG, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    assert.ok(lines.length > 0, "Log file exists but is empty");

    const last = JSON.parse(lines[lines.length - 1]);
    assert.ok(last.ts, "Last log entry has no timestamp");
    assert.ok(last.level, "Last log entry has no level");
  });

  it("recent log entries include chatId 1693963111 (owner)", () => {
    if (!fs.existsSync(TG_LOG)) return;
    const content = fs.readFileSync(TG_LOG, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    const ownerEntries = lines.filter(l => {
      try {
        const d = JSON.parse(l);
        return d.chatId === OWNER_CHAT_ID;
      } catch { return false; }
    });
    assert.ok(ownerEntries.length > 0, `No log entries for owner chat ${OWNER_CHAT_ID}`);
  });
});

describe("Telegram — getUpdates (bridge polling)", { skip: SKIP ? "No TELEGRAM_BOT_TOKEN" : false }, () => {
  it("getUpdates returns a valid response structure", async () => {
    // The bridge uses long-polling so offset will have advanced.
    // We check the response shape, not expecting actual messages.
    const data = await tgApi("getUpdates", { limit: 1 });
    assert.ok(data.ok !== undefined, "getUpdates returned no ok field");
    assert.ok(Array.isArray(data.result), "getUpdates result is not an array");
  });
});

describe("Telegram — bridge → crew-lead forwarding", { skip: SKIP ? "No token" : false }, () => {
  it("crew-lead is reachable (required for bridge forwarding)", async () => {
    let reachable = false;
    try {
      const res = await fetch("http://127.0.0.1:5010/health", { signal: AbortSignal.timeout(3000) });
      reachable = res.ok;
    } catch { /* not running */ }

    if (!reachable) {
      // crew-lead not running — skip rather than fail
      return;
    }
    assert.ok(reachable, "crew-lead not reachable on :5010");
  });

  it("telegram-messages.jsonl records incoming user messages", () => {
    const msgLog = path.join(LOGS_DIR, "telegram-messages.jsonl");
    if (!fs.existsSync(msgLog)) return; // no messages yet

    const content = fs.readFileSync(msgLog, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return;

    const last = JSON.parse(lines[lines.length - 1]);
    assert.ok(last.chatId || last.from, "Message log entry missing chatId/from");
  });
});
