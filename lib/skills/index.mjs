/**
 * Skills system — extracted from gateway-bridge.mjs
 *
 * Supports two skill formats:
 *   1. JSON skill files  (~/.crewswarm/skills/<name>.json)
 *   2. SKILL.md folders  (~/.crewswarm/skills/<name>/SKILL.md)  (ClawHub-compatible)
 *
 * Inject config resolvers via initSkills({ resolveConfig, resolveTelegramBridgeConfig })
 */

import fs   from "fs";
import path from "path";
import os   from "os";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

const SKILLS_DIR          = path.join(os.homedir(), ".crewswarm", "skills");
const PENDING_SKILLS_FILE = path.join(os.homedir(), ".crewswarm", "pending-skills.json");

let _resolveConfig                = () => ({});
let _resolveTelegramBridgeConfig  = () => ({});

export function initSkills({ resolveConfig, resolveTelegramBridgeConfig } = {}) {
  if (resolveConfig)               _resolveConfig               = resolveConfig;
  if (resolveTelegramBridgeConfig) _resolveTelegramBridgeConfig = resolveTelegramBridgeConfig;
}

// ── SKILL.md parser ───────────────────────────────────────────────────────────

function parseSkillMdFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const front = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (val.startsWith("[")) {
      try { val = JSON.parse(val.replace(/'/g, '"')); }
      catch { val = val.slice(1,-1).split(",").map(s => s.trim().replace(/^['"]|['"]$/g,"")); }
    }
    front[m[1]] = val;
  }
  return front;
}

/** Run clawscan security check on a skill file/dir. Returns { safe, score, findings }. */
function clawscanSkill(skillPath) {
  try {
    const dir = skillPath.endsWith("SKILL.md") ? path.dirname(skillPath) : skillPath;
    const { execSync } = require("child_process");
    const out = execSync(`npx clawscan scan "${dir}" --json 2>/dev/null || npx clawscan scan "${dir}" 2>&1`, {
      timeout: 15000, encoding: "utf8", stdio: ["pipe","pipe","pipe"],
    });
    try {
      const j = JSON.parse(out);
      return { safe: (j.score || 0) < 40, score: j.score || 0, findings: j.findings || [] };
    } catch {}
    const scoreMatch = out.match(/score:\s*(\d+)/i);
    const score = scoreMatch ? parseInt(scoreMatch[1]) : 0;
    const dangerous = /🔴|DANGEROUS|CRITICAL/i.test(out);
    return { safe: !dangerous, score, findings: [], raw: out.slice(0, 500) };
  } catch (e) {
    console.warn("[skill-scan] clawscan unavailable, skipping scan for", skillPath, e?.message?.slice(0,80));
    return { safe: true, score: -1, skipped: true };
  }
}

function loadSkillMd(skillName) {
  const candidates = [
    path.join(SKILLS_DIR, skillName, "SKILL.md"),
    path.join(SKILLS_DIR, skillName + ".md"),
  ];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    try {
      const raw  = fs.readFileSync(f, "utf8");
      const meta = parseSkillMdFrontmatter(raw);
      const body = raw.replace(/^---[\s\S]*?---\r?\n/, "").trim();
      const scan = clawscanSkill(f);
      if (!scan.safe && !scan.skipped) {
        console.error(`[skill-scan] ⛔ BLOCKED skill "${skillName}" — clawscan score ${scan.score}/100.`);
        return null;
      }
      if (scan.score >= 20 && !scan.skipped) {
        console.warn(`[skill-scan] ⚠️  Skill "${skillName}" scored ${scan.score}/100 — loaded with caution.`);
      }
      return {
        _type:         "skill-md",
        name:          meta.name || skillName,
        description:   meta.description || "",
        aliases:       Array.isArray(meta.aliases) ? meta.aliases : (meta.aliases ? [meta.aliases] : []),
        url:           meta.url || null,
        method:        meta.method || "GET",
        defaultParams: meta.defaultParams ? (typeof meta.defaultParams === "string" ? JSON.parse(meta.defaultParams) : meta.defaultParams) : {},
        _body:         body,
        _file:         f,
        _scanScore:    scan.score,
      };
    } catch { continue; }
  }
  // Search subdirs for aliases
  try {
    for (const ent of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const f = path.join(SKILLS_DIR, ent.name, "SKILL.md");
      if (!fs.existsSync(f)) continue;
      try {
        const raw     = fs.readFileSync(f, "utf8");
        const meta    = parseSkillMdFrontmatter(raw);
        const aliases = Array.isArray(meta.aliases) ? meta.aliases : (meta.aliases ? [meta.aliases] : []);
        if (aliases.includes(skillName) || (meta.name && meta.name === skillName)) {
          const body = raw.replace(/^---[\s\S]*?---\r?\n/, "").trim();
          return { _type:"skill-md", name: meta.name || ent.name, description: meta.description||"", aliases, url: meta.url||null, method: meta.method||"GET", defaultParams:{}, _body: body, _file: f };
        }
      } catch { continue; }
    }
  } catch {}
  return null;
}

/** Resolve a skill name alias to its canonical file name. */
export function resolveSkillAlias(skillName) {
  const exact = path.join(SKILLS_DIR, skillName + ".json");
  if (fs.existsSync(exact)) return skillName;
  try {
    for (const f of fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith(".json"))) {
      const def = JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, f), "utf8"));
      if ((def.aliases || []).includes(skillName)) return f.replace(".json", "");
    }
  } catch {}
  return skillName;
}

export function loadSkillDef(skillName) {
  const resolved = resolveSkillAlias(skillName);
  const file = path.join(SKILLS_DIR, resolved + ".json");
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  }
  return loadSkillMd(skillName);
}

export function loadPendingSkills() {
  try { return JSON.parse(fs.readFileSync(PENDING_SKILLS_FILE, "utf8")); } catch { return {}; }
}

export function savePendingSkills(map) {
  try {
    fs.mkdirSync(path.dirname(PENDING_SKILLS_FILE), { recursive: true });
    fs.writeFileSync(PENDING_SKILLS_FILE, JSON.stringify(map, null, 2));
  } catch {}
}

export async function executeSkill(skillDef, params) {
  // SKILL.md instruction card (no url) → return content directly
  if (skillDef._type === "skill-md" && !skillDef.url) {
    const paramStr = Object.keys(params).length ? `\nCalled with params: ${JSON.stringify(params)}` : "";
    return `[Skill: ${skillDef.name}]\n${skillDef._body}${paramStr}`;
  }
  const cfg    = _resolveConfig();
  const merged = { ...(skillDef.defaultParams || {}), ...params };
  // Apply param aliases
  for (const [param, map] of Object.entries(skillDef.paramAliases || {})) {
    if (merged[param] != null && map[merged[param]] != null) merged[param] = map[merged[param]];
  }
  // Resolve URL — use listUrl when primary path param is empty
  let url;
  const urlParamEmpty = (skillDef.url || "").match(/\{(\w+)\}/);
  const emptyKey = urlParamEmpty ? urlParamEmpty[1] : null;
  const isParamEmpty = emptyKey && (merged[emptyKey] === undefined || merged[emptyKey] === null || String(merged[emptyKey] || "").trim() === "");
  if (skillDef.listUrl && isParamEmpty) {
    url = skillDef.listUrl;
  } else {
    url = skillDef.url;
    for (const [k, v] of Object.entries(merged)) {
      url = url.replace(`{${k}}`, encodeURIComponent(String(v)));
    }
  }
  const headers = { "Content-Type": "application/json", ...(skillDef.headers || {}) };
  // Auth resolution
  if (skillDef.auth) {
    const auth = skillDef.auth;
    let token = auth.token || "";
    if (auth.keyFrom) {
      let val = cfg;
      for (const part of auth.keyFrom.split(".")) { val = val?.[part]; }
      if (val) token = String(val);
    }
    if (token) {
      if (auth.type === "bearer" || !auth.type) headers["Authorization"] = `Bearer ${token}`;
      else if (auth.type === "header") headers[auth.header || "X-API-Key"] = token;
      else if (auth.type === "basic")  headers["Authorization"] = `Basic ${Buffer.from(token).toString("base64")}`;
    }
  }
  const method  = (skillDef.method || "POST").toUpperCase();
  const timeout = skillDef.timeout || 30000;
  const reqOpts = { method, headers, signal: AbortSignal.timeout(timeout) };
  if (method !== "GET" && method !== "HEAD") reqOpts.body = JSON.stringify(merged);
  console.log(`[skills] fetch → ${method} ${url}`);
  const res  = await fetch(url, reqOpts);
  const text = await res.text();
  console.log(`[skills] fetch ← ${res.status} ${text.slice(0, 100).replace(/\n/g, " ")}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return { response: text }; }
}

export async function notifyTelegramSkillApproval(agentId, skillName, params, approvalId) {
  const cfg       = _resolveConfig();
  const tgBridge  = _resolveTelegramBridgeConfig();
  const botToken  = process.env.TELEGRAM_BOT_TOKEN || cfg?.env?.TELEGRAM_BOT_TOKEN || cfg?.TELEGRAM_BOT_TOKEN || tgBridge.token || "";
  const chatId    = process.env.TELEGRAM_CHAT_ID   || cfg?.env?.TELEGRAM_CHAT_ID   || cfg?.TELEGRAM_CHAT_ID
    || (Array.isArray(tgBridge.allowedChatIds) && tgBridge.allowedChatIds.length ? String(tgBridge.allowedChatIds[0]) : "")
    || tgBridge.defaultChatId || "";
  if (!botToken || !chatId.trim()) return;
  const msg = `🔔 *Skill approval needed*\n*${agentId}* → *${skillName}*\nParams: \`${JSON.stringify(params).slice(0, 200)}\`\n\nApprove: POST /api/skills/approve {"approvalId":"${approvalId}"}\nOr reply approve/${approvalId} here`;
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId.trim(), text: msg, parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[
        { text: "✅ Approve", callback_data: `skill_approve:${approvalId}` },
        { text: "❌ Reject",  callback_data: `skill_reject:${approvalId}`  },
      ]]}
    }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => {});
}
