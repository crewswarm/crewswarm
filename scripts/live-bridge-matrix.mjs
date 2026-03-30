#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const jsonMode = process.argv.includes("--json");
const home = os.homedir();
const crewDir = path.join(home, ".crewswarm");
const logsDir = path.join(crewDir, "logs");

function exists(file) {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const telegramCfg = readJson(path.join(crewDir, "telegram-bridge.json"));
const whatsappCfg = readJson(path.join(crewDir, "whatsapp-bridge.json"));

const payload = {
  telegram: {
    configured: Boolean(telegramCfg?.token),
    allowedChats: Array.isArray(telegramCfg?.allowedChatIds) ? telegramCfg.allowedChatIds.length : 0,
    logFile: path.join(logsDir, "telegram-bridge.jsonl"),
    messagesFile: path.join(logsDir, "telegram-messages.jsonl"),
    logPresent: exists(path.join(logsDir, "telegram-bridge.jsonl")),
    messagesPresent: exists(path.join(logsDir, "telegram-messages.jsonl")),
  },
  whatsapp: {
    configured: exists(path.join(crewDir, "whatsapp-auth", "creds.json")),
    allowedNumbers: Array.isArray(whatsappCfg?.allowedNumbers) ? whatsappCfg.allowedNumbers.length : 0,
    logFile: path.join(logsDir, "whatsapp-bridge.jsonl"),
    messagesFile: path.join(logsDir, "whatsapp-messages.jsonl"),
    logPresent: exists(path.join(logsDir, "whatsapp-bridge.jsonl")),
    messagesPresent: exists(path.join(logsDir, "whatsapp-messages.jsonl")),
  },
  checklist: [
    "1. Start the stack with `npm run restart-all`.",
    "2. Run `node scripts/health-check.mjs` and confirm crew-lead/dashboard are up.",
    "3. For Telegram: run `node --test test/e2e/telegram-roundtrip.test.mjs` with a configured bot token.",
    "4. For WhatsApp: run `node --test test/e2e/whatsapp-roundtrip.test.mjs` after QR auth is established.",
    "5. Send one inbound message and confirm project/history logs update.",
  ],
};

if (jsonMode) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

console.log("CrewSwarm live bridge matrix");
console.log("");
console.log("Telegram:");
console.log(`  configured: ${payload.telegram.configured ? "yes" : "no"}`);
console.log(`  allowed chats: ${payload.telegram.allowedChats}`);
console.log(`  log present: ${payload.telegram.logPresent ? "yes" : "no"}`);
console.log(`  messages log present: ${payload.telegram.messagesPresent ? "yes" : "no"}`);
console.log("");
console.log("WhatsApp:");
console.log(`  configured: ${payload.whatsapp.configured ? "yes" : "no"}`);
console.log(`  allowed numbers: ${payload.whatsapp.allowedNumbers}`);
console.log(`  log present: ${payload.whatsapp.logPresent ? "yes" : "no"}`);
console.log(`  messages log present: ${payload.whatsapp.messagesPresent ? "yes" : "no"}`);
console.log("");
console.log("Checklist:");
for (const item of payload.checklist) {
  console.log(`  ${item}`);
}
