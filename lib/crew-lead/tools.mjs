/**
 * crew-lead direct tools executor — extracted from crew-lead.mjs
 * Executes @@READ_FILE, @@WRITE_FILE, @@MKDIR, @@RUN_CMD, @@WEB_SEARCH,
 * @@WEB_FETCH, @@SEARCH_HISTORY, @@TELEGRAM, @@WHATSAPP tags from LLM replies.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

let _historyDir = "";
let _crewswarmCfgFile = "";

export function initTools({ historyDir, crewswarmCfgFile }) {
  if (historyDir !== undefined) _historyDir = historyDir;
  if (crewswarmCfgFile !== undefined) _crewswarmCfgFile = crewswarmCfgFile;
}

export const CREWLEAD_BLOCKED_CMDS = /rm\s+-rf\s+\/(?!\S)|mkfs|dd\s+if=|:(){ :|:& };:|shutdown|reboot|halt|pkill\s+-9\s+crew-lead/i;

export async function execCrewLeadTools(reply) {
  const toolResults = [];
  const resolvePath = p => (p || "").trim().replace(/[.,;!?]+$/, "").replace(/^~/, os.homedir());
  let m;

  // ── @@READ_FILE /path ─────────────────────────────────────────────────────
  const readRe = /@@READ_FILE[ \t]+([^\n@@]+)/g;
  while ((m = readRe.exec(reply)) !== null) {
    const filePath = resolvePath(m[1].trim().replace(/\s+[—–-]{1,2}\s+.*$/, "").trim());
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const isDoc = /\.(md|txt|json|yaml|yml|toml)$/i.test(filePath);
      const limit = isDoc ? 12000 : 6000;
      const snippet = content.length > limit ? content.slice(0, limit) + "\n...[truncated]" : content;
      toolResults.push(`[read_file] 📄 ${filePath} (${content.length} bytes):\n${snippet}`);
      console.log(`[crew-lead:read_file] ${filePath}`);
    } catch (e) { toolResults.push(`[read_file] ❌ ${filePath}: ${e.message}`); }
  }

  // ── @@WRITE_FILE /path\ncontent\n@@END_FILE ───────────────────────────────
  const writeRe = /@@WRITE_FILE[ \t]+([^\n]+)\n([\s\S]*?)@@END_FILE/g;
  while ((m = writeRe.exec(reply)) !== null) {
    const filePath = resolvePath(m[1]);
    const contents = m[2];
    try {
      fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
      fs.writeFileSync(filePath, contents, "utf8");
      toolResults.push(`[write_file] ✅ Wrote ${contents.length} bytes → ${filePath}`);
      console.log(`[crew-lead:write_file] ${filePath}`);
    } catch (e) { toolResults.push(`[write_file] ❌ ${filePath}: ${e.message}`); }
  }

  // ── @@MKDIR /path ─────────────────────────────────────────────────────────
  const mkdirRe = /@@MKDIR[ \t]+([^\n@@]+)/g;
  while ((m = mkdirRe.exec(reply)) !== null) {
    const dirPath = resolvePath(m[1]);
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      toolResults.push(`[mkdir] ✅ Created ${dirPath}`);
      console.log(`[crew-lead:mkdir] ${dirPath}`);
    } catch (e) { toolResults.push(`[mkdir] ❌ ${dirPath}: ${e.message}`); }
  }

  // ── @@RUN_CMD command ─────────────────────────────────────────────────────
  const cmdRe = /@@RUN_CMD[ \t]+([^\n]+)/g;
  while ((m = cmdRe.exec(reply)) !== null) {
    const cmd = m[1].trim().replace(/\s+[—–-]{1,2}\s+.*$/, "").trim();
    if (CREWLEAD_BLOCKED_CMDS.test(cmd)) {
      toolResults.push(`[run_cmd] ⛔ Blocked dangerous command: ${cmd}`);
      continue;
    }
    try {
      const out = execSync(cmd, { timeout: 30000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      toolResults.push(`[run_cmd] ✅ \`${cmd}\`:\n${(out || "").slice(0, 4000)}`);
      console.log(`[crew-lead:run_cmd] ${cmd}`);
    } catch (e) {
      const stderr = e.stderr ? String(e.stderr).slice(0, 1000) : "";
      toolResults.push(`[run_cmd] ❌ \`${cmd}\`: ${e.message}${stderr ? `\n${stderr}` : ""}`);
    }
  }

  // ── @@WEB_SEARCH query ────────────────────────────────────────────────────
  const searchRe = /@@WEB_SEARCH[ \t]+([^\n]+)/g;
  while ((m = searchRe.exec(reply)) !== null) {
    const query = m[1].trim().replace(/\s+[—–-]{1,2}\s+.*$/, "").trim();
    try {
      const perplexityKey = (() => {
        try { return JSON.parse(fs.readFileSync(_crewswarmCfgFile, "utf8"))?.providers?.perplexity?.apiKey || null; }
        catch { return null; }
      })();
      if (!perplexityKey) { toolResults.push(`[web_search] ❌ No Perplexity key configured`); continue; }
      const res = await fetch("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${perplexityKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "sonar",
          messages: [{ role: "user", content: `Search the web and return accurate, detailed results for: ${query}\n\nBe specific, include key facts, numbers, and sources.` }],
          max_tokens: 1024,
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) { toolResults.push(`[web_search] ❌ Perplexity error ${res.status}`); continue; }
      const data = await res.json();
      const answer = data.choices?.[0]?.message?.content || "(no results)";
      const citations = (data.citations || []).map((u, i) => `[${i+1}] ${u}`).join("\n");
      toolResults.push(`[web_search] 🔍 "${query}":\n${answer}${citations ? `\n\nSources:\n${citations}` : ""}`);
      console.log(`[crew-lead:web_search] "${query}" → ${answer.length} chars`);
    } catch (e) { toolResults.push(`[web_search] ❌ ${query}: ${e.message}`); }
  }

  // ── @@WEB_FETCH url ───────────────────────────────────────────────────────
  const fetchRe = /@@WEB_FETCH[ \t]+(https?:\/\/[^\n]+)/g;
  while ((m = fetchRe.exec(reply)) !== null) {
    const url = m[1].trim();
    try {
      const res = await fetch(url, { headers: { "User-Agent": "CrewSwarm/1.0" }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) { toolResults.push(`[web_fetch] ❌ HTTP ${res.status}: ${url}`); continue; }
      const ct = res.headers.get("content-type") || "";
      let text = await res.text();
      if (ct.includes("html")) {
        text = text.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim();
      }
      const snippet = text.length > 8000 ? text.slice(0, 8000) + "\n...[truncated]" : text;
      toolResults.push(`[web_fetch] 🌐 ${url} (${text.length} chars):\n${snippet}`);
      console.log(`[crew-lead:web_fetch] ${url}`);
    } catch (e) { toolResults.push(`[web_fetch] ❌ ${url}: ${e.message}`); }
  }

  // ── @@SEARCH_HISTORY query ────────────────────────────────────────────────
  const searchHistRe = /@@SEARCH_HISTORY[ \t]+([^\n]+)/g;
  while ((m = searchHistRe.exec(reply)) !== null) {
    const query = m[1].trim();
    if (!query) { toolResults.push(`[search_history] ❌ No query provided`); continue; }
    try {
      const histDir = _historyDir;
      if (!fs.existsSync(histDir)) { toolResults.push(`[search_history] No history found`); continue; }
      const files = fs.readdirSync(histDir).filter(f => f.endsWith(".jsonl")).sort();
      const lq = query.toLowerCase();
      const hits = [];
      for (const file of files) {
        const sessionId = file.replace(".jsonl", "");
        const lines = fs.readFileSync(path.join(histDir, file), "utf8").split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if ((entry.content || "").toLowerCase().includes(lq)) {
              const date = entry.ts ? new Date(entry.ts).toISOString().slice(0, 16).replace("T", " ") : "unknown";
              const snippet = (entry.content || "").slice(0, 300).replace(/\n/g, " ");
              hits.push(`[${date}][${sessionId}][${entry.role}] ${snippet}${entry.content?.length > 300 ? "…" : ""}`);
              if (hits.length >= 20) break;
            }
          } catch {}
        }
        if (hits.length >= 20) break;
      }
      if (hits.length === 0) {
        toolResults.push(`[search_history] No matches for "${query}"`);
      } else {
        toolResults.push(`[search_history] ${hits.length} match(es) for "${query}":\n${hits.join("\n")}`);
      }
      console.log(`[crew-lead:search_history] query="${query}" hits=${hits.length}`);
    } catch (e) { toolResults.push(`[search_history] ❌ ${e.message}`); }
  }

  // ── @@TELEGRAM message ────────────────────────────────────────────────────
  const telegramRe = /@@TELEGRAM[ \t]+([^\n]+)/g;
  while ((m = telegramRe.exec(reply)) !== null) {
    let msg = m[1].trim();
    try {
      const tgBridge = (() => {
        try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "telegram-bridge.json"), "utf8")); }
        catch { return {}; }
      })();
      const botToken = process.env.TELEGRAM_BOT_TOKEN || tgBridge.token || "";
      let chatId = process.env.TELEGRAM_CHAT_ID
        || (Array.isArray(tgBridge.allowedChatIds) && tgBridge.allowedChatIds[0] ? String(tgBridge.allowedChatIds[0]) : "")
        || tgBridge.defaultChatId || "";
      const atMatch = msg.match(/^@(\S+)\s+(.*)$/s);
      if (atMatch) {
        const name = atMatch[1].toLowerCase();
        msg = atMatch[2].trim();
        const found = Object.entries(tgBridge.contactNames || {}).find(([, v]) => (v || "").toLowerCase() === name);
        if (found) chatId = found[0];
        else { toolResults.push(`[telegram] ❌ No contact named "${atMatch[1]}"`); continue; }
      }
      if (!botToken || !chatId) { toolResults.push(`[telegram] ❌ Bot token or chat ID not configured`); continue; }
      const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: "Markdown" }),
        signal: AbortSignal.timeout(10000),
      });
      const tgData = await tgRes.json();
      if (tgData.ok) { toolResults.push(`[telegram] ✅ Sent: "${msg.slice(0, 80)}"`); }
      else { toolResults.push(`[telegram] ❌ ${tgData.description}`); }
      console.log(`[crew-lead:telegram] sent to ${chatId}`);
    } catch (e) { toolResults.push(`[telegram] ❌ ${e.message}`); }
  }

  // ── @@WHATSAPP message ────────────────────────────────────────────────────
  const whatsappRe = /@@WHATSAPP[ \t]+([^\n]+)/g;
  while ((m = whatsappRe.exec(reply)) !== null) {
    let msg = m[1].trim();
    try {
      const waBridge = (() => {
        try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "whatsapp-bridge.json"), "utf8")); }
        catch { return {}; }
      })();
      const waPort = process.env.WA_HTTP_PORT || "5015";
      let phone = (waBridge.allowedNumbers || [])[0] || "";
      const atMatch = msg.match(/^@(\S+)\s+(.*)$/s);
      if (atMatch) {
        const name = atMatch[1].toLowerCase();
        msg = atMatch[2].trim();
        const found = Object.entries(waBridge.contactNames || {}).find(([, v]) => (v || "").toLowerCase() === name);
        if (found) phone = found[0];
        else { toolResults.push(`[whatsapp] ❌ No contact named "${atMatch[1]}"`); continue; }
      }
      if (!phone) { toolResults.push(`[whatsapp] ❌ No WhatsApp number configured`); continue; }
      const waRes = await fetch(`http://127.0.0.1:${waPort}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, text: msg }),
        signal: AbortSignal.timeout(10000),
      });
      const waData = await waRes.json();
      if (waData.ok) { toolResults.push(`[whatsapp] ✅ Sent to ${phone}: "${msg.slice(0, 80)}"`); }
      else { toolResults.push(`[whatsapp] ❌ ${waData.error || "send failed"}`); }
      console.log(`[crew-lead:whatsapp] sent to ${phone}`);
    } catch (e) { toolResults.push(`[whatsapp] ❌ ${e.message}`); }
  }

  return toolResults;
}
