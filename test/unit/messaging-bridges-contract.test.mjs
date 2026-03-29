import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const telegramSource = fs.readFileSync(path.resolve("telegram-bridge.mjs"), "utf8");
const whatsappSource = fs.readFileSync(path.resolve("whatsapp-bridge.mjs"), "utf8");

test("telegram bridge uses startup lock, RT bus, and crew-lead chat/events paths", () => {
  assert.match(telegramSource, /acquireStartupLock\("telegram-bridge", \{ killStale: false \}\)/);
  assert.match(telegramSource, /const RT_URL\s+=[\s\S]*"ws:\/\/127\.0\.0\.1:18889"/);
  assert.match(telegramSource, /const AGENT_NAME\s+=\s+"crew-telegram"/);
  assert.match(telegramSource, /const CREW_LEAD_URL = .*"http:\/\/127\.0\.0\.1:5010"/);
  assert.match(telegramSource, /fetch\(`\$\{CREW_LEAD_URL\}\/chat`, \{/);
  assert.match(telegramSource, /const CREW_LEAD_EVENTS = `\$\{CREW_LEAD_URL\}\/events`/);
  assert.match(telegramSource, /saveBridgeMessage\(/);
  assert.match(telegramSource, /saveBridgeMessage, detectProjectFromMessage/);
});

test("whatsapp bridge exposes local send and health endpoints plus RT and crew-lead wiring", () => {
  assert.match(whatsappSource, /const HTTP_PORT\s+=.*"5015"/);
  assert.match(whatsappSource, /const AGENT_NAME\s+=\s+"crew-whatsapp"/);
  assert.match(whatsappSource, /const RT_URL\s+=.*"ws:\/\/127\.0\.0\.1:18889"/);
  assert.match(whatsappSource, /const CREW_LEAD_URL = .*"http:\/\/127\.0\.0\.1:5010"/);
  assert.match(whatsappSource, /req\.method === "POST" && req\.url === "\/send"/);
  assert.match(whatsappSource, /req\.method === "GET" && req\.url === "\/health"/);
  assert.match(whatsappSource, /httpServer\.listen\(HTTP_PORT, "127\.0\.0\.1"/);
  assert.match(whatsappSource, /saveBridgeMessage\(/);
  assert.match(whatsappSource, /fetch\(`\$\{CREW_LEAD_URL\}\/chat`/);
});

test("messaging bridges persist pid and message logs for resilience and auditing", () => {
  assert.match(telegramSource, /const PID_PATH\s+=/);
  assert.match(telegramSource, /writeFileSync\(PID_PATH, String\(process\.pid\)\)/);
  assert.match(whatsappSource, /const PID_PATH\s+=/);
  assert.match(whatsappSource, /const MSG_LOG\s+=/);
  assert.match(whatsappSource, /function logMessage\(/);
});
