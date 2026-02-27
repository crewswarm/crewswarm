/**
 * Agent tool executor — extracted from gateway-bridge.mjs
 * Parses and executes @@TOOL markers from agent LLM replies.
 *
 * Supported: @@WRITE_FILE, @@READ_FILE, @@MKDIR, @@RUN_CMD,
 *            @@WEB_SEARCH, @@WEB_FETCH, @@TELEGRAM,
 *            @@SKILL, @@DEFINE_SKILL
 *
 * Inject: initTools({ resolveConfig, resolveTelegramBridgeConfig,
 *                     loadAgentList, getOpencodeProjectDir,
 *                     loadSkillDef, loadPendingSkills, savePendingSkills,
 *                     notifyTelegramSkillApproval, executeSkill })
 */

import fs   from "fs";
import path from "path";
import os   from "os";

const CREWSWARM_DIR = path.join(os.homedir(), ".crewswarm");
const LEGACY_STATE_DIR = path.join(os.homedir(), ".openclaw");
const SKILLS_DIR = path.join(os.homedir(), ".crewswarm", "skills");

let _resolveConfig               = () => ({});
let _resolveTelegramBridgeConfig = () => ({});
let _loadAgentList               = () => [];
let _getOpencodeProjectDir       = () => null;
let _loadSkillDef                = () => null;
let _loadPendingSkills           = () => ({});
let _savePendingSkills           = () => {};
let _notifyTelegramSkillApproval = async () => {};
let _executeSkill                = async () => ({});

export function initTools({ resolveConfig, resolveTelegramBridgeConfig, loadAgentList, getOpencodeProjectDir, loadSkillDef, loadPendingSkills, savePendingSkills, notifyTelegramSkillApproval, executeSkill } = {}) {
  if (resolveConfig)               _resolveConfig               = resolveConfig;
  if (resolveTelegramBridgeConfig) _resolveTelegramBridgeConfig = resolveTelegramBridgeConfig;
  if (loadAgentList)               _loadAgentList               = loadAgentList;
  if (getOpencodeProjectDir)       _getOpencodeProjectDir       = getOpencodeProjectDir;
  if (loadSkillDef)                _loadSkillDef                = loadSkillDef;
  if (loadPendingSkills)           _loadPendingSkills           = loadPendingSkills;
  if (savePendingSkills)           _savePendingSkills           = savePendingSkills;
  if (notifyTelegramSkillApproval) _notifyTelegramSkillApproval = notifyTelegramSkillApproval;
  if (executeSkill)                _executeSkill                = executeSkill;
}

// ── Agent Tool Execution ───────────────────────────────────────────────────
// Agents embed tool calls in their LLM reply using these markers.
// gateway-bridge parses and executes them, returning a summary of actions.
//
// Supported tools:
//   @@WRITE_FILE /absolute/path/to/file
//   <file contents>
//   @@END_FILE
//
//   @@READ_FILE /absolute/path/to/file
//
//   @@MKDIR /absolute/path/to/dir
//
//   @@RUN_CMD <shell command>  (whitelist-controlled)
//

// Agents that auto-approve @@RUN_CMD without requiring user confirmation
const _AUTO_APPROVE_STATIC = new Set(["crew-fixer", "crew-github", "crew-pm"]);
const _AUTO_APPROVE_ROLES = new Set(["coder", "ops", "generalist"]);

export function isAutoApproveAgent(agentId) {
  if (_AUTO_APPROVE_STATIC.has(agentId)) return true;
  const agents = _loadAgentList();
  const cfg = agents.find(a => a.id === agentId);
  if (cfg?.tools?.autoApproveCmd) return true;
  return cfg?._role ? _AUTO_APPROVE_ROLES.has(cfg._role) : false;
}

// Pending command approvals: approvalId → { resolve, timer }
export const pendingCmdApprovals = new Map();

// Module-level RT client ref so executeToolCalls can publish approval requests
export let _rtClientForApprovals = null;
export function setRtClient(rt) { _rtClientForApprovals = rt; }

// Per-role tool defaults — used when agent has no explicit alsoAllow in config
export const AGENT_TOOL_ROLE_DEFAULTS = {
  'crew-qa':          new Set(['read_file','skill']),
  'crew-coder':       new Set(['write_file','read_file','mkdir','run_cmd','skill','define_skill']),
  'crew-coder-front': new Set(['write_file','read_file','mkdir','run_cmd','skill']),
  'crew-coder-back':  new Set(['write_file','read_file','mkdir','run_cmd','skill']),
  'crew-frontend':    new Set(['write_file','read_file','mkdir','run_cmd','skill']),
  'crew-fixer':       new Set(['write_file','read_file','mkdir','run_cmd','skill']),
  'crew-github':      new Set(['read_file','run_cmd','git','skill']),
  'crew-pm':          new Set(['read_file','write_file','mkdir','dispatch','skill']),
  'crew-main':        new Set(['read_file','write_file','run_cmd','dispatch','skill','define_skill']),
  'crew-security':    new Set(['read_file','run_cmd']),
  'crew-copywriter':  new Set(['write_file','read_file','skill']),
  'crew-telegram':    new Set(['telegram','read_file']),
  'crew-lead':        new Set(['read_file','write_file','mkdir','run_cmd','web_search','web_fetch','skill','define_skill','dispatch','telegram','whatsapp']),
};

// CrewSwarm @@TOOL permission names — distinct from legacy gateway tool names
const CREWSWARM_TOOL_NAMES = new Set(['write_file','read_file','mkdir','run_cmd','git','dispatch','skill','define_skill','telegram','web_search','web_fetch']);

export function loadAgentToolPermissions(agentId) {
  // Check config files for explicit CrewSwarm-style tool permissions.
  // tools.alsoAllow in crewswarm.json may contain legacy gateway tool names (exec, web_search, etc.)
  // — only use it if it contains at least one CrewSwarm @@TOOL name.
  try {
    const cfgPaths = [
      path.join(os.homedir(), ".crewswarm", "crewswarm.json"),
      path.join(os.homedir(), ".crewswarm", "config.json"),
      path.join(os.homedir(), ".openclaw", "openclaw.json"),
    ];
    for (const p of cfgPaths) {
      if (!fs.existsSync(p)) continue;
      const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
      const agents = Array.isArray(cfg.agents) ? cfg.agents : (cfg.agents?.list || []);
      const crewId = agentId.startsWith("crew-") ? agentId : `crew-${agentId}`;
      const bareId = agentId.startsWith("crew-") ? agentId.slice(5) : agentId;
      const agent = agents.find(a => a.id === agentId || a.id === crewId || a.id === bareId);
      // Only accept if the list contains CrewSwarm-style tool names, not just legacy gateway names
      const allow = agent?.tools?.crewswarmAllow || agent?.tools?.alsoAllow || [];
      const crewswarmTools = allow.filter(t => CREWSWARM_TOOL_NAMES.has(t));
      if (crewswarmTools.length > 0) {
        return new Set(crewswarmTools);
      }
    }
  } catch {}
  // Fall back to role defaults (covers crew-coder, crew-qa, crew-fixer, etc.)
  if (AGENT_TOOL_ROLE_DEFAULTS[agentId]) return AGENT_TOOL_ROLE_DEFAULTS[agentId];
  // Fuzzy match — e.g. crew-coder-3 → coder defaults
  for (const [key, val] of Object.entries(AGENT_TOOL_ROLE_DEFAULTS)) {
    if (agentId.startsWith(key)) return val;
  }
  // Dynamic agents: derive tools from _role in crewswarm.json
  try {
    const agents = _loadAgentList();
    const cfg = agents.find(a => a.id === agentId);
    if (cfg?._role) {
      const ROLE_TOOL_DEFAULTS = {
        coder:      new Set(['write_file','read_file','mkdir','run_cmd','skill']),
        researcher: new Set(['read_file','web_search','web_fetch','skill']),
        writer:     new Set(['write_file','read_file','web_search','web_fetch','skill']),
        auditor:    new Set(['read_file','run_cmd','skill']),
        ops:        new Set(['read_file','write_file','mkdir','run_cmd','git','skill']),
        generalist: new Set(['read_file','write_file','mkdir','run_cmd','dispatch','skill']),
      };
      if (ROLE_TOOL_DEFAULTS[cfg._role]) return ROLE_TOOL_DEFAULTS[cfg._role];
      // Custom role: check crewswarm.json top-level roleToolDefaults map
      // e.g. "roleToolDefaults": { "analyst": ["read_file","web_search","skill"] }
      try {
        const rootCfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "crewswarm.json"), "utf8"));
        const customTools = rootCfg.roleToolDefaults?.[cfg._role];
        if (Array.isArray(customTools) && customTools.length > 0) return new Set(customTools);
      } catch {}
    }
  } catch {}
  // Unknown agent — allow read/write/mkdir/run by default
  return new Set(['read_file','write_file','mkdir','run_cmd']);
}

export function buildToolInstructions(allowed) {
  const projectDir = _getOpencodeProjectDir() || process.cwd();
  const tools = [];
  if (allowed.has('write_file')) tools.push(`### Write a file to disk:
@@WRITE_FILE ${projectDir}/file.html
<!DOCTYPE html>
<html>...full file contents here...</html>
@@END_FILE`);
  if (allowed.has('read_file')) tools.push(`### Read a file from disk:
@@READ_FILE /absolute/path/to/file.txt`);
  if (allowed.has('mkdir')) tools.push(`### Create a directory:
@@MKDIR /absolute/path/to/directory`);
  if (allowed.has('run_cmd') || allowed.has('git')) {
    const gitNote = allowed.has('git') ? " Git commands (git status, git add, git commit, git push, git log) are also allowed." : "";
    tools.push(`### Run a shell command (safe subset only — no rm, no sudo):${gitNote}
@@RUN_CMD ls /some/path`);
  }
  if (allowed.has('web_search')) tools.push(`### Search the web (Brave Search):
@@WEB_SEARCH your search query here
Returns top 5 results with title, URL, and snippet. Use this to research facts, find examples, or verify information before writing.`);
  if (allowed.has('web_fetch')) tools.push(`### Fetch a URL and read its content:
@@WEB_FETCH https://example.com/page
Returns the page text (up to 8000 chars). Use to read docs, articles, or any URL before summarising or referencing.`);
  if (allowed.has('telegram')) tools.push(`### Send a Telegram message:
@@TELEGRAM your message text here
@@TELEGRAM @ContactName message text here
Sends a message to the configured Telegram chat (or to a contact by name if you use @Name). Contact names are set in Dashboard → Settings → Telegram → Contact names. Use to notify humans of task completion, errors, or important findings.`);
  if (allowed.has('skill')) {
    const skillList = (() => {
      try {
        if (!fs.existsSync(SKILLS_DIR)) return "(none installed yet)";
        const entries = [];
        // JSON skills
        const jsonFiles = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith(".json"));
        for (const f of jsonFiles) {
          try {
            const d = JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, f), "utf8"));
            const name     = f.replace(".json","");
            const approval = d.requiresApproval ? " ⚠️ requires-approval" : "";
            const urlLine  = d.url  ? `\n      URL: ${d.method||"POST"} ${d.url}` : "";
            const notes    = d.paramNotes ? `\n      Params: ${d.paramNotes}` : "";
            const defaults = d.defaultParams && Object.keys(d.defaultParams).length
              ? `\n      Defaults: ${JSON.stringify(d.defaultParams)}` : "";
            entries.push(`  - ${name}${approval} — ${d.description || ""}${urlLine}${notes}${defaults}`);
          } catch { entries.push(`  - ${f.replace(".json","")}`); }
        }
        // SKILL.md skills (AgentSkills / ClawHub format)
        const dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
          .filter(e => e.isDirectory() && fs.existsSync(path.join(SKILLS_DIR, e.name, "SKILL.md")));
        for (const dir of dirs) {
          const md = loadSkillMd(dir.name);
          if (md) {
            const tag = md.url ? "" : " 📄 instruction-card";
            entries.push(`  - ${dir.name}${tag} — ${md.description}`);
          }
        }
        // Standalone .md skills
        const mdFiles = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith(".md"));
        for (const f of mdFiles) {
          const name = f.replace(".md","");
          if (!jsonFiles.some(j => j.replace(".json","") === name)) {
            const md = loadSkillMd(name);
            if (md) entries.push(`  - ${name} 📄 — ${md.description}`);
          }
        }
        return entries.length ? entries.join("\n") : "(none installed yet)";
      } catch { return ""; }
    })();
    tools.push(`### Call an external skill (API integration):
@@SKILL skillname {"param":"value"}
Available skills:\n${skillList}
Replace skillname with the skill name. Include any required params as inline JSON on the same line.
Example: @@SKILL fly.deploy {"app":"myapp"}
Example: @@SKILL elevenlabs.tts {"text":"Hello world","voice_id":"21m00Tcm4TlvDq8ikWAM"}`);
    if (allowed.has('define_skill')) {
      tools.push(`### Define or update a skill (create a reusable API integration):
@@DEFINE_SKILL skillname
{
  "description": "What this skill does",
  "url": "https://api.example.com/endpoint/{param}",
  "method": "POST",
  "auth": {"type": "bearer", "keyFrom": "providers.PROVIDER.apiKey"},
  "defaultParams": {"model": "default"},
  "paramNotes": "Required: param1. Optional: param2 (default: x).",
  "requiresApproval": false
}
@@END_SKILL
Use @@WEB_SEARCH and @@WEB_FETCH to research the API first, then define the skill.
Auth types: "bearer" (Authorization: Bearer <key>), "header" (custom header + "header" field).
keyFrom format: "providers.PROVIDER.apiKey" (reads from crewswarm.json) or "env.ENV_VAR_NAME".`);
    }
  }
  if (!tools.length) return ""; // agent has no tools — instructions not needed

  const externalProjectHint =
    projectDir === process.cwd()
      ? `- If the task refers to an external project by name (e.g. polymarket-ai-strat), its root is typically ${path.join(os.homedir(), "Desktop", "<project-name>")}, not under PROJECT DIRECTORY. Do not use paths like .../CrewSwarm/<project-name>/...; use .../Desktop/<project-name>/... instead.`
      : "";

  return `
## Agent Tools — ACTIVE for this session

When your task requires actions on disk or network, output the tool markers below directly in your reply.
The system detects and executes them automatically. ALWAYS use absolute paths.

PROJECT DIRECTORY (write all output files here): ${projectDir}

${tools.join("\n\n")}

CRITICAL RULES:
${externalProjectHint ? externalProjectHint + "\n" : ""}- Output the @@TOOL markers directly — do NOT describe or simulate what you would do.
- Use @@WRITE_FILE to write files — never just show code in markdown blocks.
- @@END_FILE MUST appear on its own line immediately after the last line of file content.
- ALL tool calls go in a SINGLE reply — do NOT stop after @@MKDIR and wait for results. Chain @@MKDIR then @@WRITE_FILE immediately in the same response.
- Do NOT write "**Tool execution results:**" — the system appends that automatically.
- Do NOT wrap file contents in markdown fences inside @@WRITE_FILE...@@END_FILE blocks.
- Write ALL output files under ${projectDir}/ unless the task explicitly specifies a different absolute path.
- Disabled tools: ${['write_file','read_file','mkdir','run_cmd','git'].filter(t => !allowed.has(t)).join(', ') || 'none'}
- To log a durable discovery to the shared knowledge base (brain.md), include this anywhere in your reply:
  @@BRAIN: <one-line fact worth remembering for future tasks>
`;
}

// Commands that are always blocked regardless of agent permissions or allowlist
const BLOCKED_CMD_PATTERNS = [
  /\brm\s+-[rf]{1,2}f?\b/,
  /\bsudo\b/,
  /curl[^|\n]*\|\s*(bash|sh|zsh|fish)\b/i,
  /wget[^|\n]*\|\s*(bash|sh|zsh|fish)\b/i,
  /:\(\)\s*\{\s*:\|:&\s*\};?\s*:/,   // fork bomb
  /\bdd\s+if=/,
  /\bmkfs\b/,
  /\bfdisk\b/,
  /\bchmod\s+[0-9]*7[0-9]*\s+\/\b/,  // chmod 777 /...
  /\bkillall\b/,
];

const SAFE_GIT_CMD_WHITELIST = /^(git (status|log|diff|add|commit|push|pull|fetch|branch|checkout|show|rev-parse|remote|tag|stash))\b/;

// Allowlist — patterns stored in ~/.crewswarm/cmd-allowlist.json
const CMD_ALLOWLIST_FILE = path.join(os.homedir(), ".crewswarm", "cmd-allowlist.json");

export function loadCmdAllowlist() {
  try { return JSON.parse(fs.readFileSync(CMD_ALLOWLIST_FILE, "utf8")); } catch { return []; }
}

export function isCommandBlocked(cmd) {
  return BLOCKED_CMD_PATTERNS.some(re => re.test(cmd));
}

export function isCommandAllowlisted(cmd) {
  const list = loadCmdAllowlist();
  return list.some(pattern => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}`, "i").test(cmd.trim());
  });
}

// Sanitize paths from agent replies — strip markdown/hallucination (backticks, trailing punctuation)
export function sanitizeToolPath(raw) {
  if (typeof raw !== "string") return "";
  let s = raw.trim().replace(/\s+/g, " ").replace(/`/g, "");
  while (s.length > 1 && (s.endsWith(".") || s.endsWith(","))) s = s.slice(0, -1).trim();
  s = s.replace(/^~/, os.homedir());
  // Resolve relative paths against the configured project dir so agents
  // that output bare filenames don't accidentally write to the CrewSwarm root.
  if (!path.isAbsolute(s)) {
    const base = _getOpencodeProjectDir() || process.cwd();
    s = path.join(base, s);
  }
  return s;
}

export async function executeToolCalls(reply, agentId, { suppressWriteIfSearchPending = false } = {}) {
  const allowed = loadAgentToolPermissions(agentId);
  const results = [];

  // If the reply contains both @@WEB_SEARCH/@@WEB_FETCH and @@WRITE_FILE in the same
  // message, the model is writing before it has seen real search results — suppress
  // the write so the caller can do a follow-up call with actual search data.
  const hasPendingSearches = /@@WEB_SEARCH[ \t]+\S|@@WEB_FETCH[ \t]+https?:\/\//.test(reply);
  const hasWrite = /@@WRITE_FILE[ \t]+\S/.test(reply);
  const blockWrite = suppressWriteIfSearchPending && hasPendingSearches && hasWrite;

  // ── @@WRITE_FILE ──────────────────────────────────────────────────────────
  const writeRe = /@@WRITE_FILE[ \t]+([^\n]+)\n([\s\S]*?)@@END_FILE/g;
  let m;
  while ((m = writeRe.exec(reply)) !== null) {
    if (blockWrite) {
      results.push(`[tool:write_file] ⏸ Write suppressed — waiting for search results first`);
      continue;
    }
    if (!allowed.has('write_file')) {
      results.push(`[tool:write_file] ⛔ ${agentId} does not have write_file permission`);
      continue;
    }
    const filePath = sanitizeToolPath(m[1]);
    const absPath = path.resolve(filePath);
    const contents = m[2];
    try {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, contents, "utf8");
      const msg = `[tool:write_file] ✅ Wrote ${contents.length} bytes → ${absPath}`;
      results.push(msg);
      console.log(`[${agentId}] ${msg}`);
    } catch (err) {
      const msg = `[tool:write_file] ❌ Failed to write ${absPath}: ${err.message}`;
      results.push(msg);
      console.error(`[${agentId}] ${msg}`);
    }
  }

  // ── @@READ_FILE ───────────────────────────────────────────────────────────
  // Path stops at newline or next @@ so multiple @@READ_FILE on one line are parsed separately
  const readRe = /@@READ_FILE[ \t]+([^\n@@]+)/g;
  while ((m = readRe.exec(reply)) !== null) {
    if (!allowed.has('read_file')) {
      results.push(`[tool:read_file] ⛔ ${agentId} does not have read_file permission`);
      continue;
    }
    const filePath = sanitizeToolPath(m[1]);
    try {
      const content = fs.readFileSync(filePath, "utf8");
      // Docs/briefs get a higher limit — they are reference material, not code blobs
      const isDoc = /\.(md|txt|json|yaml|yml|toml)$/i.test(filePath);
      const readLimit = isDoc ? 12000 : 4000;
      const snippet = content.length > readLimit ? content.slice(0, readLimit) + "\n...[truncated]" : content;
      results.push(`[tool:read_file] 📄 ${filePath} (${content.length} bytes):\n${snippet}`);
    } catch (err) {
      results.push(`[tool:read_file] ❌ Cannot read ${filePath}: ${err.message}`);
    }
  }

  // ── @@MKDIR ───────────────────────────────────────────────────────────────
  const mkdirRe = /@@MKDIR[ \t]+([^\n@@]+)/g;
  while ((m = mkdirRe.exec(reply)) !== null) {
    if (!allowed.has('mkdir')) {
      results.push(`[tool:mkdir] ⛔ ${agentId} does not have mkdir permission`);
      continue;
    }
    const dirPath = sanitizeToolPath(m[1]);
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      results.push(`[tool:mkdir] ✅ Created directory: ${dirPath}`);
    } catch (err) {
      results.push(`[tool:mkdir] ❌ Failed: ${err.message}`);
    }
  }

  // ── @@RUN_CMD ─────────────────────────────────────────────────────────────
  const cmdRe = /@@RUN_CMD[ \t]+([^\n]+)/g;
  while ((m = cmdRe.exec(reply)) !== null) {
    const cmd = m[1].trim();
    const isGit = SAFE_GIT_CMD_WHITELIST.test(cmd);

    // Hard block — dangerous patterns regardless of permissions
    if (isCommandBlocked(cmd)) {
      results.push(`[tool:run_cmd] ⛔ Blocked dangerous command: ${cmd}`);
      continue;
    }
    if (isGit && !allowed.has('git') && !allowed.has('run_cmd')) {
      results.push(`[tool:run_cmd] ⛔ ${agentId} does not have git permission`);
      continue;
    }
    if (!isGit && !allowed.has('run_cmd')) {
      results.push(`[tool:run_cmd] ⛔ ${agentId} does not have run_cmd permission`);
      continue;
    }

    // ── Approval gate — skip for git, auto-approved agents, or allowlisted commands ─
    const needsApproval = !isGit && !isAutoApproveAgent(agentId) && !isCommandAllowlisted(cmd) && _rtClientForApprovals;
    if (needsApproval) {
      const approvalId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        _rtClientForApprovals.publish({
          channel: "events",
          type: "cmd.needs_approval",
          to: "broadcast",
          payload: { approvalId, agent: agentId, cmd, ts: new Date().toISOString() },
        });
      } catch (pubErr) {
        console.warn(`[${agentId}] Could not publish cmd.needs_approval: ${pubErr?.message}`);
      }

      console.log(`[${agentId}] ⏳ Awaiting approval to run: ${cmd}`);
      const approved = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingCmdApprovals.delete(approvalId);
          console.warn(`[${agentId}] cmd approval timed out (60s): ${cmd}`);
          resolve(false);
        }, 60000);
        pendingCmdApprovals.set(approvalId, { resolve, timer });
      });

      if (!approved) {
        results.push(`[tool:run_cmd] ⛔ Command rejected or timed out: \`${cmd}\``);
        continue;
      }
      console.log(`[${agentId}] ✅ cmd approved, executing: ${cmd}`);
    }

    try {
      const { execSync } = await import("node:child_process");
      const out = execSync(cmd, { timeout: 15000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      results.push(`[tool:run_cmd] ✅ $ ${cmd}\n${out.slice(0, 2000)}`);
    } catch (err) {
      results.push(`[tool:run_cmd] ❌ $ ${cmd}\n${err.message}`);
    }
  }

  // ── @@WEB_SEARCH ──────────────────────────────────────────────────────────
  // Uses Perplexity sonar (web-grounded LLM) as primary, falls back to Brave
  const webSearchRe = /@@WEB_SEARCH[ \t]+([^\n]+)/g;
  while ((m = webSearchRe.exec(reply)) !== null) {
    if (!allowed.has('web_search')) {
      results.push(`[tool:web_search] ⛔ ${agentId} does not have web_search permission`);
      continue;
    }
    const query = m[1].trim();
    try {
      // ── Try Perplexity sonar first (web-grounded, accurate results) ──
      const perplexityKey = (() => {
        try {
          const cfg = JSON.parse(fs.readFileSync(path.join(CREWSWARM_DIR, "crewswarm.json"), "utf8"));
          return cfg?.providers?.perplexity?.apiKey || null;
        } catch { return null; }
      })();

      if (perplexityKey) {
        const pRes = await fetch("https://api.perplexity.ai/chat/completions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${perplexityKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "sonar",
            messages: [{ role: "user", content: `Search the web and return accurate, detailed results for: ${query}\n\nInclude: key facts, URLs of official sources, pricing if relevant, and any important technical details. Be specific and factual.` }],
            max_tokens: 1024,
          }),
          signal: AbortSignal.timeout(20000),
        });
        if (pRes.ok) {
          const pData = await pRes.json();
          const answer = pData.choices?.[0]?.message?.content || "";
          const citations = (pData.citations || []).map((u, i) => `[${i+1}] ${u}`).join("\n");
          const out = answer + (citations ? `\n\nSources:\n${citations}` : "");
          results.push(`[tool:web_search] 🔍 Results for "${query}":\n${out}`);
          console.log(`[${agentId}] web_search (perplexity): "${query}" → ${answer.length} chars`);
          continue;
        }
      }

      // ── Fallback: Brave search ──
      const braveKey = (() => {
        const stPaths = [
          path.join(CREWSWARM_DIR, "search-tools.json"),
          path.join(LEGACY_STATE_DIR, "search-tools.json"),
        ];
        for (const p of stPaths) {
          try { return JSON.parse(fs.readFileSync(p, "utf8"))?.brave?.apiKey; } catch {}
        }
        return process.env.BRAVE_API_KEY || null;
      })();
      if (!braveKey) {
        results.push(`[tool:web_search] ❌ No search provider available (no Perplexity or Brave key)`);
        continue;
      }
      const res = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&text_decorations=false`,
        { headers: { Accept: "application/json", "X-Subscription-Token": braveKey }, signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) {
        results.push(`[tool:web_search] ❌ Brave API error ${res.status} for: ${query}`);
        continue;
      }
      const data = await res.json();
      const hits = (data.web?.results || []).slice(0, 5);
      if (!hits.length) {
        results.push(`[tool:web_search] ℹ️ No results for: ${query}`);
        continue;
      }
      const formatted = hits.map((r, i) =>
        `${i + 1}. **${r.title}** — ${r.url}\n   ${r.description || ""}`
      ).join("\n");
      results.push(`[tool:web_search] 🔍 Results for "${query}":\n${formatted}`);
      console.log(`[${agentId}] web_search (brave): "${query}" → ${hits.length} results`);
    } catch (err) {
      results.push(`[tool:web_search] ❌ Search failed: ${err.message}`);
    }
  }

  // ── @@WEB_FETCH ───────────────────────────────────────────────────────────
  const webFetchRe = /@@WEB_FETCH[ \t]+(https?:\/\/[^\n]+)/g;
  while ((m = webFetchRe.exec(reply)) !== null) {
    if (!allowed.has('web_fetch')) {
      results.push(`[tool:web_fetch] ⛔ ${agentId} does not have web_fetch permission`);
      continue;
    }
    const url = m[1].trim();
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "CrewSwarm/1.0 (agent fetch)" },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) {
        results.push(`[tool:web_fetch] ❌ HTTP ${res.status} fetching: ${url}`);
        continue;
      }
      const ct = res.headers.get("content-type") || "";
      let text = await res.text();
      // Strip HTML tags to extract readable text
      if (ct.includes("html")) {
        text = text
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s{2,}/g, " ")
          .trim();
      }
      const snippet = text.length > 8000 ? text.slice(0, 8000) + "\n...[truncated]" : text;
      results.push(`[tool:web_fetch] 🌐 ${url} (${text.length} chars):\n${snippet}`);
      console.log(`[${agentId}] web_fetch: ${url} → ${text.length} chars`);
    } catch (err) {
      results.push(`[tool:web_fetch] ❌ Fetch failed for ${url}: ${err.message}`);
    }
  }

  // ── @@TELEGRAM ────────────────────────────────────────────────────────────
  // Supports: @@TELEGRAM message  (default chat) or @@TELEGRAM @Name message  (contact by name)
  const telegramRe = /@@TELEGRAM[ \t]+([^\n]+)/g;
  while ((m = telegramRe.exec(reply)) !== null) {
    if (!allowed.has('telegram')) {
      results.push(`[tool:telegram] ⛔ ${agentId} does not have telegram permission`);
      continue;
    }
    let message = m[1].trim();
    try {
      const cfg = _resolveConfig();
      const tgBridge = _resolveTelegramBridgeConfig();
      const botToken = process.env.TELEGRAM_BOT_TOKEN || cfg?.env?.TELEGRAM_BOT_TOKEN || cfg?.TELEGRAM_BOT_TOKEN || tgBridge.token || "";
      let chatId = process.env.TELEGRAM_CHAT_ID || cfg?.env?.TELEGRAM_CHAT_ID || cfg?.TELEGRAM_CHAT_ID
        || (Array.isArray(tgBridge.allowedChatIds) && tgBridge.allowedChatIds.length ? String(tgBridge.allowedChatIds[0]) : "")
        || tgBridge.defaultChatId || "";
      const contactNames = tgBridge.contactNames || {};
      const atNameMatch = message.match(/^@(\S+)\s+(.*)$/s);
      if (atNameMatch) {
        const name = atNameMatch[1];
        message = atNameMatch[2].trim();
        const nameLower = name.toLowerCase();
        const found = Object.entries(contactNames).find(([, v]) => (v || "").toLowerCase() === nameLower);
        if (found) chatId = found[0];
        else {
          results.push(`[tool:telegram] ❌ No contact named "${name}" in Settings → Telegram → Contact names`);
          continue;
        }
      }
      chatId = chatId.trim();
      if (!botToken || !chatId) {
        results.push(`[tool:telegram] ❌ TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set in env, ~/.crewswarm/config.json, or ~/.crewswarm/telegram-bridge.json (token + allowedChatIds or defaultChatId)`);
        continue;
      }
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: `[${agentId}] ${message}`, parse_mode: "Markdown" }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      if (!data.ok) {
        results.push(`[tool:telegram] ❌ Telegram error: ${data.description}`);
      } else {
        results.push(`[tool:telegram] ✅ Sent: ${message.slice(0, 80)}${message.length > 80 ? "…" : ""}`);
        console.log(`[${agentId}] telegram: sent message`);
      }
    } catch (err) {
      results.push(`[tool:telegram] ❌ Send failed: ${err.message}`);
    }
  }

  // ── @@SKILL ───────────────────────────────────────────────────────────────
  // Format: @@SKILL skillname {"param":"value"}
  const skillRe = /@@SKILL[ \t]+([a-zA-Z0-9_\-\.]+)[ \t]*(\{[^\n]*\})?/g;
  while ((m = skillRe.exec(reply)) !== null) {
    if (!allowed.has('skill')) {
      results.push(`[tool:skill] ⛔ ${agentId} does not have skill permission`);
      continue;
    }
    const skillName = m[1].trim();
    let params = {};
    if (m[2]) {
      try { params = JSON.parse(m[2]); } catch { results.push(`[tool:skill] ❌ ${skillName}: bad JSON params — ${m[2].slice(0, 100)}`); continue; }
    }
    const skillDef = _loadSkillDef(skillName);
    if (!skillDef) {
      results.push(`[tool:skill] ❌ Skill "${skillName}" not found in ${SKILLS_DIR}`);
      continue;
    }
    // Merge defaults
    const merged = { ...(skillDef.defaultParams || {}), ...params };
    // Check requiresApproval
    if (skillDef.requiresApproval) {
      const crypto = await import("crypto");
      const approvalId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36);
      const pending = _loadPendingSkills();
      pending[approvalId] = { agentId, skillName, params: merged, skillDef, createdAt: Date.now() };
      _savePendingSkills(pending);
      await _notifyTelegramSkillApproval(agentId, skillName, merged, approvalId);
      results.push(`[tool:skill] 🔔 "${skillName}" requires approval. Approval ID: ${approvalId}. Approve via POST /api/skills/approve {"approvalId":"${approvalId}"} or Telegram.`);
      console.log(`[${agentId}] skill:${skillName} awaiting approval (${approvalId})`);
      continue;
    }
    try {
      console.log(`[${agentId}] skill:${skillName} → ${skillDef.url?.slice(0, 60)}`);
      const result = await _executeSkill(skillDef, merged);
      let preview;
      const isBenchmark = skillName === "zeroeval.benchmark" || skillName === "benchmark" || skillName === "benchmarks";
      if (isBenchmark && Array.isArray(result) && result.length) {
        const list = result.slice(0, 30).map(b => typeof b === "object" ? b.benchmark_id : b).join(", ");
        preview = `${result.length} benchmarks (sample): ${list}${result.length > 30 ? ` … +${result.length - 30} more` : ""}`;
      } else if (isBenchmark && result?.models?.length) {
        const top = result.models.slice(0, 5).map(m => `${m.model_name}: ${((m.normalized_score ?? m.score ?? 0) * 100).toFixed(1)}%`);
        preview = `${result.name || "Benchmark"} — top 5: ${top.join("; ")}`;
      } else {
        preview = typeof result === "string" ? result : JSON.stringify(result);
        if (preview.length > 400) preview = preview.slice(0, 400) + "…";
      }
      results.push(`[tool:skill] ✅ ${skillName}: ${preview}`);
    } catch (err) {
      results.push(`[tool:skill] ❌ ${skillName} failed: ${err.message.slice(0, 200)}`);
      console.error(`[${agentId}] skill:${skillName} error: ${err.message}`);
    }
  }

  // ── @@DEFINE_SKILL ────────────────────────────────────────────────────────
  // Format: @@DEFINE_SKILL skillname\n{json}\n@@END_SKILL
  const defineSkillRe = /@@DEFINE_SKILL[ \t]+([a-zA-Z0-9_\-\.]+)\n([\s\S]*?)@@END_SKILL/g;
  while ((m = defineSkillRe.exec(reply)) !== null) {
    if (!allowed.has('define_skill')) {
      results.push(`[tool:define_skill] ⛔ ${agentId} does not have define_skill permission`);
      continue;
    }
    const skillName = m[1].trim();
    const rawJson   = m[2].trim();
    let def;
    try { def = JSON.parse(rawJson); } catch(e) {
      results.push(`[tool:define_skill] ❌ ${skillName}: invalid JSON — ${e.message}`);
      continue;
    }
    try {
      fs.mkdirSync(SKILLS_DIR, { recursive: true });
      const outPath = path.join(SKILLS_DIR, skillName + ".json");
      fs.writeFileSync(outPath, JSON.stringify(def, null, 2), "utf8");
      results.push(`[tool:define_skill] ✅ Skill "${skillName}" saved to ${outPath}`);
      console.log(`[${agentId}] define_skill:${skillName} → ${outPath}`);
    } catch(e) {
      results.push(`[tool:define_skill] ❌ Failed to save skill "${skillName}": ${e.message}`);
    }
  }

  return results;
}

// Coding tool IDs — agents whose role defaults include write_file are considered
// "coding" roles and default to useOpenCode=true when no explicit config is set.
const OPENCODE_CODING_TOOLS = new Set(["write_file"]);
