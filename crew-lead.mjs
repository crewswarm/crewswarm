#!/usr/bin/env node
/**
 * crew-lead.mjs — Conversational commander (HTTP server)
 *
 * Runs a local HTTP server on port 5010.
 * Receives chat messages, responds via LLM, dispatches tasks to agents.
 * Persistent per-session memory. Standalone — no external gateway needed.
 *
 * Usage: node crew-lead.mjs
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import http from "node:http";
import { execSync, spawnSync } from "node:child_process";
import WebSocket from "ws";

// ── Config ────────────────────────────────────────────────────────────────────

const PORT        = Number(process.env.CREW_LEAD_PORT || 5010);
const HISTORY_DIR = path.join(os.homedir(), ".crewswarm", "chat-history");
const MAX_HISTORY = 40;
const LLM_TIMEOUT = 180000; // 3 min — reasoning models (e.g. gpt-5.1-codex) can take 1–2+ min for complex prompts
const CTL_PATH    = (() => {
  const homeBin = path.join(os.homedir(), "bin", "openswitchctl");
  if (fs.existsSync(homeBin)) return homeBin;
  return path.join(process.cwd(), "scripts", "openswitchctl");
})();
const DASHBOARD   = "http://127.0.0.1:4319";

function loadConfig() {
  const cs      = tryRead(path.join(os.homedir(), ".crewswarm", "config.json"))    || {};
  const csSwarm = tryRead(path.join(os.homedir(), ".crewswarm", "crewswarm.json")) || {};

  const agents = Array.isArray(csSwarm.agents) ? csSwarm.agents : [];
  const agentCfg = agents.find(a => a.id === "crew-lead");
  const modelString = agentCfg?.model || process.env.CREW_LEAD_MODEL || "groq/llama-3.3-70b-versatile";
  const [providerKey, ...modelParts] = modelString.split("/");
  const modelId = modelParts.join("/");
  const provider = csSwarm?.providers?.[providerKey] || cs?.providers?.[providerKey];

  const teamAgents = agents.filter(a => a.id && a.id !== "crew-lead");

  const knownAgents = teamAgents.map(a => a.id);
  if (!knownAgents.length) {
    knownAgents.push(
      "crew-main", "crew-pm", "crew-coder", "crew-qa", "crew-fixer",
      "crew-security", "crew-coder-front", "crew-coder-back",
      "crew-github", "crew-frontend", "crew-copywriter"
    );
  }

  const agentModels = {};
  for (const a of agents) {
    if (a.id && a.model) agentModels[a.id] = a.model;
  }

  // Full roster: id, display name, emoji, role/theme, model
  const agentRoster = teamAgents.map(a => ({
    id:    a.id,
    name:  a.identity?.name  || a.name  || a.id,
    emoji: a.identity?.emoji || a.emoji || "",
    role:  a.identity?.theme || "",
    model: a.model || "",
  }));

  const displayName = agentCfg?.identity?.name || "crew-lead";
  const emoji       = agentCfg?.identity?.emoji || "🦊";

  return { modelId, providerKey, provider, knownAgents, agentModels, agentRoster, displayName, emoji };
}

function tryRead(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

// ── Agent tool permission helpers ─────────────────────────────────────────────

const CREWSWARM_TOOL_NAMES = new Set([
  "write_file","read_file","mkdir","run_cmd","git","dispatch","telegram","web_search","web_fetch","skill",
]);

const AGENT_TOOL_ROLE_DEFAULTS = {
  "crew-qa":          ["read_file"],
  "crew-security":    ["read_file","run_cmd"],
  "crew-coder":       ["write_file","read_file","mkdir","run_cmd"],
  "crew-coder-front": ["write_file","read_file","mkdir","run_cmd"],
  "crew-coder-back":  ["write_file","read_file","mkdir","run_cmd"],
  "crew-frontend":    ["write_file","read_file","mkdir","run_cmd"],
  "crew-fixer":       ["write_file","read_file","mkdir","run_cmd"],
  "crew-github":      ["read_file","run_cmd","git"],
  "crew-copywriter":  ["write_file","read_file","web_search","web_fetch"],
  "crew-main":        ["write_file","read_file","mkdir","run_cmd","dispatch","web_search","web_fetch"],
  "crew-pm":          ["read_file","dispatch"],
  "crew-telegram":    ["telegram","read_file"],
};

function readAgentTools(agentId) {
  const swarm = tryRead(path.join(os.homedir(), ".crewswarm", "crewswarm.json")) || {};
  const agents = Array.isArray(swarm.agents) ? swarm.agents : [];
  const agent  = agents.find(a => a.id === agentId);
  const explicit = agent?.tools?.crewswarmAllow || agent?.tools?.alsoAllow || null;
  if (explicit) {
    const valid = explicit.filter(t => CREWSWARM_TOOL_NAMES.has(t));
    if (valid.length) return { source: "config", tools: valid };
  }
  // Fuzzy-match role defaults
  const exact = AGENT_TOOL_ROLE_DEFAULTS[agentId];
  if (exact) return { source: "role-default", tools: exact };
  for (const [key, val] of Object.entries(AGENT_TOOL_ROLE_DEFAULTS)) {
    if (agentId.startsWith(key)) return { source: "role-default", tools: val };
  }
  return { source: "fallback", tools: ["read_file","write_file","mkdir","run_cmd"] };
}

function writeAgentTools(agentId, tools) {
  const valid = tools.filter(t => CREWSWARM_TOOL_NAMES.has(t));
  const swarmPath = path.join(os.homedir(), ".crewswarm", "crewswarm.json");
  const swarm = tryRead(swarmPath) || {};
  if (!Array.isArray(swarm.agents)) swarm.agents = [];
  let agent = swarm.agents.find(a => a.id === agentId);
  if (!agent) {
    agent = { id: agentId };
    swarm.agents.push(agent);
  }
  if (!agent.tools) agent.tools = {};
  agent.tools.crewswarmAllow = valid;
  fs.writeFileSync(swarmPath, JSON.stringify(swarm, null, 2), "utf8");
  return valid;
}

function getSearchToolsConfig() {
  return tryRead(path.join(os.homedir(), ".crewswarm", "search-tools.json"))
      || tryRead(path.join(os.homedir(), ".openclaw",  "search-tools.json"))
      || {};
}

function getAgentPrompts() {
  return tryRead(path.join(os.homedir(), ".crewswarm", "agent-prompts.json"))
      || tryRead(path.join(os.homedir(), ".openclaw",  "agent-prompts.json"))
      || {};
}

function writeAgentPrompt(agentId, promptText) {
  const promptsPath = path.join(os.homedir(), ".crewswarm", "agent-prompts.json");
  const prompts = getAgentPrompts();
  prompts[agentId] = promptText;
  fs.writeFileSync(promptsPath, JSON.stringify(prompts, null, 2), "utf8");
  return promptText;
}

const BRAIN_PATH = path.join(process.cwd(), "memory", "brain.md");
const GLOBAL_RULES_PATH = path.join(os.homedir(), ".crewswarm", "global-rules.md");

function appendToBrain(agentId, entry) {
  const date = new Date().toISOString().slice(0, 10);
  const block = `\n## [${date}] ${agentId}: ${entry}\n`;
  if (!fs.existsSync(BRAIN_PATH)) fs.mkdirSync(path.dirname(BRAIN_PATH), { recursive: true });
  fs.appendFileSync(BRAIN_PATH, block, "utf8");
  return block.trim();
}

function readGlobalRules() {
  try { return fs.readFileSync(GLOBAL_RULES_PATH, "utf8").trim(); } catch { return ""; }
}

function writeGlobalRules(content) {
  fs.writeFileSync(GLOBAL_RULES_PATH, content, "utf8");
  return content;
}

function appendGlobalRule(rule) {
  const existing = readGlobalRules();
  const updated = existing ? `${existing}\n- ${rule}` : `# Global Agent Rules\n\n- ${rule}`;
  writeGlobalRules(updated);
  return updated;
}

async function searchWithBrave(query) {
  const key = getSearchToolsConfig()?.brave?.apiKey || process.env.BRAVE_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&text_decorations=false`,
      { headers: { "Accept": "application/json", "X-Subscription-Token": key }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const results = (data.web?.results || []).slice(0, 5);
    if (!results.length) return null;
    const text = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.description || ""}\n   ${r.url}`).join("\n\n");
    // Debug: so you can verify what Stinki was given (e.g. "did he get Crunchbase?")
    console.log(`[crew-lead] Brave search query="${query.slice(0, 80)}" → ${results.length} results`);
    return text;
  } catch { return null; }
}

function getWorkspaceRoot() {
  return process.env.CREW_LEAD_WORKSPACE || process.cwd();
}

/** Run a text search in the workspace; returns excerpt string or null. Uses rg then grep. */
function searchCodebase(query) {
  const workspace = getWorkspaceRoot();
  if (!query || query.length < 2) return null;
  const maxOutput = 6000;
  const args = [
    "-F", "-i", "-n",
    "-C", "1",
    "--max-files", "20",
    "--max-count", "3",
    "--glob", "!node_modules",
    "--glob", "!.git",
    "--glob", "!*.min.js",
    query,
    workspace,
  ];
  try {
    const out = spawnSync("rg", args, {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: maxOutput,
      windowsHide: true,
    });
    if (out.status !== 0 || !out.stdout?.trim()) return null;
    const lines = out.stdout.trim().split("\n").slice(0, 25);
    return lines.join("\n");
  } catch {
    try {
      const out = execSync(
        `grep -r -F -i -n --include="*.js" --include="*.mjs" --include="*.ts" --include="*.json" --include="*.md" -e ${JSON.stringify(query)} ${JSON.stringify(workspace)} 2>/dev/null | head -25`,
        { encoding: "utf8", timeout: 5000, maxBuffer: maxOutput }
      );
      return out?.trim() || null;
    } catch { return null; }
  }
}

// ── Conversation history ──────────────────────────────────────────────────────

fs.mkdirSync(HISTORY_DIR, { recursive: true });

function sessionFile(sessionId) {
  return path.join(HISTORY_DIR, `${sessionId.replace(/[^a-z0-9_-]/gi, "_")}.jsonl`);
}

function loadHistory(sessionId) {
  const file = sessionFile(sessionId);
  const history = [];
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { history.push(JSON.parse(line)); } catch {}
    }
  }
  return history.slice(-MAX_HISTORY);
}

function appendHistory(sessionId, role, content) {
  fs.appendFileSync(sessionFile(sessionId), JSON.stringify({ role, content, ts: Date.now() }) + "\n");
}

function clearHistory(sessionId) {
  const file = sessionFile(sessionId);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(cfg) {
  const knownAgents = cfg.knownAgents || [];
  const agentPrompts = getAgentPrompts();
  const customPrompt = (agentPrompts["crew-lead"] || "").trim();
  // Use functional ROLE_HINTS descriptions where available, fall back to theme
  const FUNCTIONAL_ROLES = {
    "crew-main": "main coordinator, general tasks, orchestration",
    "crew-coder": "general coding, files, setup, implementation",
    "crew-coder-front": "HTML, CSS, JS UI, animations, visual design",
    "crew-coder-back": "APIs, Node.js, backend logic, databases",
    "crew-frontend": "HTML, CSS, JS UI, visual design, landing pages",
    "crew-github": "git commits, branches, PRs, version control",
    "crew-qa": "testing, QA, validation (review only)",
    "crew-security": "security audits, auth, secrets (review only)",
    "crew-fixer": "debugging, fixing broken code",
    "crew-pm": "project planning, roadmaps, task breakdown",
    "crew-copywriter": "marketing copy, headlines, docs",
    "crew-telegram": "Telegram messaging, notifications",
    "crew-devops": "DevOps, CI/CD, Docker, infrastructure",
    "crew-aiml": "AI/ML engineering, Python, embeddings",
    "crew-data": "data, analytics, SQL, pandas",
  };
  const agentList = (cfg.agentRoster || []).length
    ? cfg.agentRoster.map(a => {
        const role = FUNCTIONAL_ROLES[a.id] || a.role || "general agent";
        return `  - ${a.emoji ? a.emoji + " " : ""}${a.name} (${a.id}) — ${role}${a.model ? " [" + a.model + "]" : ""}`;
      }).join("\n")
    : knownAgents.map(a => "  - " + a).join("\n");
  const modelLine = "";  // identity now injected once at top of prompt — no duplicate needed
  const agentModels = cfg.agentModels || {};
  const agentModelList = Object.keys(agentModels).length
    ? "Each agent's assigned model (use when asked which models agents run):\n" +
      Object.entries(agentModels).map(([id, model]) => `  - ${id}: ${model}`).join("\n")
    : "";
  const rules = [
    ...(modelLine ? [modelLine, ""] : []),
    ...(agentModelList ? [agentModelList, ""] : []),
    "Your crew (name, agent ID, role, model):",
    agentList,
    "",
    "DISPATCH RULES — CRITICAL:",
    "- ONLY dispatch when user uses: go build, go write, have crew-X do, dispatch, tell crew-X to, ask crew-X",
    "- Questions / chat / what-if = NEVER dispatch. Just answer.",
    "- One dispatch per reply maximum",
    "- ⚠️  YOU MUST use EXACTLY this format on its own line — no other wording will work:",
    '  @@DISPATCH {"agent":"crew-coder","task":"Build a REST API with JWT auth"}',
    "- NEVER say 'I launched', 'I sent', 'I dispatched' — ONLY the @@DISPATCH line actually sends the task",
    "- If you describe dispatching without the @@DISPATCH line, NOTHING will be sent — the user will be frustrated",
    "",
    "PROJECT CREATION — CRITICAL RULES:",
    "- These trigger words mean the user wants to build NOW — respond with @@PROJECT immediately, no questions:",
    "  'build me', 'build a', 'create a', 'create me', 'make me', 'make a', 'start a', 'kick off', 'let's build', 'i want to build'",
    "- When triggered: write 1-2 sentences max confirming what you are building, then add @@PROJECT at the end",
    "- Do NOT ask 'would you like to add features?' or 'what stack should we use?' — just emit @@PROJECT",
    "- The user will see the full AI-generated roadmap in the UI and can edit it before building starts",
    "- Purely hypothetical questions (what would X look like, can you explain X) = just chat, no @@PROJECT",
    "",
    "To draft a project roadmap (add at very end of reply, on its own line):",
    '@@PROJECT {"name":"FocusFlow","description":"Pomodoro timer: 25/5 intervals, streak tracking, daily stats, task list, desktop notifications","outputDir":"/Users/jeffhobbs/Desktop/focusflow"}',
    "",
    "Rules for @@PROJECT JSON:",
    "- outputDir: /Users/jeffhobbs/Desktop/<kebab-case-slug>",
    "- description: list specific features so the roadmap AI produces real technical tasks, not vague ones",
    "",
    "PIPELINE — use when the user wants multi-agent work (sequential or parallel):",
    "- Emit @@PIPELINE on its own line at the end of your reply",
    "- Each step needs: agent, task, wave (integer). Same wave number = run in PARALLEL. Higher wave = waits for lower wave.",
    '  @@PIPELINE [{"wave":1,"agent":"crew-coder","task":"Write auth.ts"},{"wave":1,"agent":"crew-coder-front","task":"Write Login.tsx"},{"wave":2,"agent":"crew-qa","task":"Audit both files"},{"wave":3,"agent":"crew-github","task":"Commit all changes"}]',
    "- wave:1 tasks run simultaneously. wave:2 starts only after ALL wave:1 tasks finish. wave:3 after wave:2. etc.",
    "- Use same wave for independent tasks (different files/concerns). Use higher wave for tasks that depend on prior results.",
    "- Each step receives the combined output of ALL steps from the previous wave as context.",
    "- Minimum 2 steps. Each must have agent + task + wave. Must be valid JSON on ONE line.",
    "- Do NOT use both @@PIPELINE and @@DISPATCH in the same reply",
    "",
    "DISPATCH with verify/done criteria — for precise tasks where you know exactly what success looks like:",
    '  @@DISPATCH {"agent":"crew-coder","task":"Write JWT auth middleware","verify":"@@READ_FILE src/auth.ts — confirm JWT decode logic is present","done":"File exists, exports verifyToken function, returns 401 on invalid token"}',
    "- verify: what the agent should check after completing (a specific @@READ_FILE or @@RUN_CMD)",
    "- done: exact definition of success — use for precise acceptance criteria",
    "- Both fields are optional — omit for simple open-ended tasks",
    "",
    "AGENT MANAGEMENT — you can read and modify agents' tools, prompts, and global rules:",
    "",
    "1. TOOL PERMISSIONS — @@TOOLS (grant/revoke/set what an agent can do):",
    "   Valid tools: write_file, read_file, mkdir, run_cmd, git, dispatch, telegram, web_search, web_fetch",
    '   @@TOOLS {"agent":"crew-qa","grant":["write_file"],"revoke":[]}',
    '   @@TOOLS {"agent":"crew-coder","set":["read_file","write_file","mkdir","run_cmd","web_search"]}',
    "   grant=add, revoke=remove, set=replace. Default roles: qa=read_file; coder/fixer/frontend=write+read+mkdir+run; copywriter=write+read+web_search+web_fetch; github=read+run+git; main=all except telegram; pm=read+dispatch",
    "",
    "2. SYSTEM PROMPTS — @@PROMPT (read or rewrite any agent's personality/instructions):",
    "   To read: just tell the user — you know all agent prompts from your config.",
    '   @@PROMPT {"agent":"crew-qa","append":"- Always use @@READ_FILE before auditing, never assume file content"}',
    '   @@PROMPT {"agent":"crew-copywriter","set":"You are a sharp B2B copywriter. Use @@WEB_SEARCH before writing. Always @@WRITE_FILE your output."}',
    "   append=add a rule to the existing prompt, set=replace entirely.",
    "",
    "3. GLOBAL RULES — @@GLOBALRULE (a rule injected into ALL agents on every task):",
    "   @@GLOBALRULE Always reply in the same language the user wrote in",
    "   @@GLOBALRULE Never hallucinate file contents — always @@READ_FILE first",
    "   Use sparingly — these apply to every single agent.",
    "",
    "4. BRAIN / SHARED MEMORY — @@BRAIN (append a durable fact to brain.md, shared by all agents):",
    "   @@BRAIN crew-lead: project uses port 4319 for dashboard, 5010 for crew-lead, 18889 for RT bus",
    "   If you say you are 'logging' or 'adding to brain' or 'remembering' something, you MUST emit @@BRAIN on that line — otherwise nothing is persisted. Plain text claims are not logged.",
    "",
    "5. SKILLS — call external APIs or define new ones:",
    "   Skills live in ~/.crewswarm/skills/. Each is a JSON file with a URL, method, auth, and params.",
    "   Any agent with 'skill' permission can call: @@SKILL skillname {\"param\":\"value\"}",
    "   You can list skills by calling GET /api/skills on crew-lead (port 5010).",
    "   To create or update a skill (use crew-main to research the API first):",
    '   @@DISPATCH {"agent":"crew-main","task":"Research the Notion API append-to-database endpoint and create a skill using @@DEFINE_SKILL notion.append\\n{...JSON skill def...}\\n@@END_SKILL"}',
    "   You can create skills yourself with @@DEFINE_SKILL (you have it). When the user asks you to create a skill, emit @@DEFINE_SKILL name\\n{...JSON...}\\n@@END_SKILL. If you need API research first, dispatch to crew-main; otherwise define directly. Example:",
    '   @@DEFINE_SKILL twitter.post',
    '   {"description":"Post a tweet","url":"https://api.twitter.com/2/tweets","method":"POST","auth":{"type":"bearer","keyFrom":"TWITTER_BEARER_TOKEN"},"paramNotes":"text: string (max 280 chars)"}',
    '   @@END_SKILL',
    "   The Tool Matrix / health snapshot lists bridge agents' tools only. You are crew-lead (this server): you implement @@DEFINE_SKILL here — do not say only crew-main or crew-coder can create skills. Say yes and emit @@DEFINE_SKILL when the user asks.",
    "   crew-main and crew-coder can also create skills (define_skill in gateway-bridge); you do not need to delegate unless API research is required.",
    "",
    "5b. WORKFLOWS (scheduled pipelines) — create or update workflows so cron can run them:",
    "   Workflows live in ~/.crewswarm/pipelines/<name>.json. Each has stages: agent + task (+ optional tool label) per stage.",
    "   To create or replace a workflow, emit @@DEFINE_WORKFLOW followed by the name and a JSON array of stages:",
    "   @@DEFINE_WORKFLOW social",
    "   [",
    '     {"agent":"crew-copywriter","task":"Draft a 280-char tweet about … Write to /tmp/cron-tweet.txt and reply with the text.","tool":"write_file"},',
    '     {"agent":"crew-main","task":"Read /tmp/cron-tweet.txt and post with @@SKILL twitter.post. Reply when done.","tool":"skill"}',
    "   ]",
    "   @@END_WORKFLOW",
    "   Each stage: agent (required), task (required), tool (optional label). To modify a workflow, output @@DEFINE_WORKFLOW with the same name and the full updated stages array (replaces the file).",
    "   When the user asks about workflows or pipelines, use the [System health snapshot] — it lists installed pipeline names.",
    "",
    "6. SYSTEM HEALTH — IMPORTANT: You are a Node.js process running locally. You do NOT need to make HTTP calls.",
    "   When the user asks about health, status, agents, services, skills, or settings, a live system snapshot",
    "   is automatically injected into your context as [System health snapshot]. USE THAT DATA — do not say",
    "   'I cannot reach localhost' or 'I am sandboxed'. You already have the information.",
    "   The snapshot includes: RT bus status, Telegram status, OpenCode dir, all agent tools+models, installed skills.",
    "   If the snapshot shows a service is ❌ DOWN or ⚠️ stopped, proactively offer to restart it with @@SERVICE.",
    "",
    "   DASHBOARD (port 4319): Users can run skills without CLI — Workspace → Run skills (params + Run, same as POST /api/skills/:name/run).",
    "   Tool Matrix (Workspace) shows each agent's tools (read/write/run) and a Restart button per agent. Direct users there when they ask who can do what or to restart a single bridge.",
    "",
    "7. SERVICE CONTROL — restart or start any crashed service via @@SERVICE:",
    "   @@SERVICE restart telegram     — restart the Telegram bridge",
    "   @@SERVICE restart agents       — restart ALL agent bridges (all crew-X)",
    "   @@SERVICE restart crew-coder   — restart a SINGLE agent bridge",
    "   @@SERVICE restart rt-bus       — restart the RT message bus",
    "   @@SERVICE restart crew-lead    — restart crew-lead itself (use as last resort)",
    "   @@SERVICE restart opencode     — restart OpenCode server",
    "   @@SERVICE stop telegram        — stop a service without restarting",
    "   Service IDs: telegram, agents, crew-lead, rt-bus, opencode, or any crew-X agent ID.",
    "   Use this when user reports an agent is down, Telegram stopped, or asks to restart something.",
    "   You cannot restart your own process from inside — if the user says 'restart yourself', emit @@SERVICE restart crew-lead; your process will then exit and the runner will respawn you.",
    "",
    "8. PROMPT SELF-TWEAK — Users can change your behavior without code: @@PROMPT {\"agent\":\"crew-lead\",\"append\":\"…new rule…\"}.",
    "   Tell users: to tweak your marching orders, paste that line with their rule in the chat; you will append it to your system prompt. (Crew-lead prompt changes apply on next message; no restart needed.)",
    "",
    "After any change: tell the user to restart the affected bridge(s) for changes to take effect.",
    "",
    "QUICK REFERENCE — You can: (1) Update any agent's prompt with @@PROMPT {\"agent\":\"crew-XXX\",\"append\":\"…\"} or set= to replace. (2) Restart any service or agent with @@SERVICE restart <id> (e.g. crew-pm, crew-coder, telegram, agents, rt-bus, crew-lead). (3) Define skills with @@DEFINE_SKILL name + JSON + @@END_SKILL; define workflows with @@DEFINE_WORKFLOW name + JSON stages + @@END_WORKFLOW. (4) Point users to the dashboard: Run skills (fire skills), Tool Matrix (see who has read/write/run + Restart per agent), Skills tab (CRUD skill JSONs). (5) Users can tweak your own prompt with @@PROMPT {\"agent\":\"crew-lead\",\"append\":\"…\"}. You know about health snapshot, workflows list, and all of the above.",
    "",
    "When the user message includes [Web context from Brave Search], use that context to answer current events, docs, or factual lookups when relevant. When it includes [Codebase context from workspace], use it to answer questions about this codebase (where things are, how they work, what a file does).",
    "",
    "CITING SEARCH: You have NO persistent 'buffer' or 'crawled history' — only (1) the conversation history in this chat and (2) whatever is injected into the current message ([Web context from Brave Search], health snapshot, etc.). When you refer to past search results, only cite details that appear in the conversation (e.g. in a [Brave search] system line). Do NOT invent result numbers, URLs, gists, or 'prior Brave sweep in my buffer'. If the user questions a citation and the exact reference isn't in the history, say you don't have it in front of you; do not double down or get defensive.",
    "",
    "- Be concise. Under 2000 chars.",
    "- No filler phrases.",
  ].join("\n");
  const defaultIntro = [
    `You are ${cfg.emoji} ${cfg.displayName} (agent ID: crew-lead, model: ${cfg.providerKey}/${cfg.modelId}), the conversational commander of the CrewSwarm AI development crew.`,
    "",
    "IMPORTANT: You are running as a local Node.js process on the user's own machine — NOT in a cloud sandbox.",
    "You have direct access to the live system via context injection. When you see [System health snapshot] in",
    "a message, that is real-time data from your own machine. Never say 'I cannot reach localhost' or",
    "'I am sandboxed' — that is wrong. Use the injected data to answer questions about the system.",
    "",
    "You are primarily a CONVERSATIONAL assistant. Your default is to CHAT.",
    "",
  ].join("\n");
  // Always inject identity line so the agent knows its name/model even with a custom prompt
  const identityLine = `You are ${cfg.emoji} ${cfg.displayName} (agent ID: crew-lead, model: ${cfg.providerKey}/${cfg.modelId}).`;
  const intro = customPrompt
    ? identityLine + "\n\n" + customPrompt + "\n\n"
    : defaultIntro;
  return intro + rules;
}

// ── LLM call ─────────────────────────────────────────────────────────────────

async function callLLM(messages, cfg) {
  const { provider, modelId, providerKey } = cfg;
  if (!provider?.apiKey || !provider?.baseUrl) {
    throw new Error(`No API key for provider "${providerKey}". Check Providers in the dashboard.`);
  }

  const isAnthropic = providerKey === "anthropic" || provider.baseUrl.includes("anthropic.com");
  const headers = { "content-type": "application/json" };
  if (isAnthropic) {
    headers["x-api-key"] = provider.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers["authorization"] = `Bearer ${provider.apiKey}`;
  }

  const res = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: modelId, messages, max_tokens: 2048, temperature: 0.7 }),
    signal: AbortSignal.timeout(LLM_TIMEOUT),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`LLM ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

function parseDispatch(text, userMessage = "") {
  // Strip think tags before parsing so <think> content doesn't pollute task text
  const cleanText = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  // Primary: structured @@DISPATCH marker (check original text too in case tags wrap it)
  const match = cleanText.match(/@@DISPATCH\s+(\{[\s\S]*?\})/);
  if (match) {
    try {
      const d = JSON.parse(match[1]);
      // d.verify and d.done are optional acceptance criteria fields
      if (d.agent && d.task) return d;
    } catch {}
  }

  // Fallback: LLM described a dispatch in natural language without using @@DISPATCH
  // Patterns: "launched to crew-X", "sent to crew-coder", "dispatching to crew-pm", "pinged crew-X" etc.
  const nlMatch = cleanText.match(
    /(?:launched|sent|dispatch(?:ed|ing)|message|task(?:ed)?|ask(?:ed|ing)?|told|forward(?:ed)?|pinged|ping(?:ing)?|fired off)\b[^.]*?\b(crew-[a-z0-9-]+)/i
  );
  if (nlMatch) {
    const agent = nlMatch[1].toLowerCase();
    // Use the user's original message as the task (much better than the LLM's reply text)
    // Strip the "go write have crew-X" prefix from user message to get just the task
    const task = userMessage
      ? userMessage.replace(/^(?:go\s+(?:write\s+)?(?:have\s+)?|have\s+|ask\s+|tell\s+)crew-[a-z0-9-]+\s+(?:to\s+)?/i, "").trim() || userMessage
      : cleanText.replace(/\n/g, " ").slice(0, 200).trim();
    if (agent && task) {
      console.log(`[crew-lead] NL dispatch fallback: agent=${agent} task="${task.slice(0, 60)}"`);
      return { agent, task };
    }
  }

  return null;
}

function stripDispatch(text) {
  return text.replace(/@@DISPATCH\s+\{[\s\S]*?\}/g, "").trim();
}

// ── Pipeline DSL ──────────────────────────────────────────────────────────────
// Format: @@PIPELINE [{"wave":1,"agent":"crew-coder","task":"..."},{"wave":1,"agent":"crew-coder-front","task":"..."},{"wave":2,"agent":"crew-qa","task":"..."}]
// Backward-compat: steps without "wave" are assigned sequential waves 1,2,3,...

function parsePipeline(text) {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const match = clean.match(/@@PIPELINE\s+(\[[\s\S]*?\])/);
  if (!match) return null;
  try {
    const steps = JSON.parse(match[1]);
    if (!Array.isArray(steps) || steps.length < 2) return null;
    if (!steps.every(s => s.agent && s.task)) return null;

    // Assign sequential wave numbers to steps that don't have one (backward compat)
    steps.forEach((s, i) => { if (s.wave == null) s.wave = i + 1; });

    // Group into ordered waves: Map<waveNum, step[]>
    const waveMap = new Map();
    for (const s of steps) {
      const w = Number(s.wave);
      if (!waveMap.has(w)) waveMap.set(w, []);
      waveMap.get(w).push(s);
    }
    const sortedWaveNums = [...waveMap.keys()].sort((a, b) => a - b);
    return { steps, waves: sortedWaveNums.map(n => waveMap.get(n)) };
  } catch { return null; }
}

function stripPipeline(text) {
  return text.replace(/@@PIPELINE\s+\[[\s\S]*?\]/g, "").trim();
}

function parseProject(text) {
  const match = text.match(/@@PROJECT\s+(\{[\s\S]*?\})/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

function stripProject(text) {
  return text.replace(/@@PROJECT\s+\{[\s\S]*?\}/, "").trim();
}

/** Remove <think>...</think> reasoning blocks so they are not shown to the user. */
function stripThink(text) {
  if (!text || typeof text !== "string") return text;
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<\/think>/g, "").replace(/<think>/g, "");
  return out.trim();
}

// ── PM LLM config (same sources as pm-loop.mjs) ───────────────────────────────

function getPMLLMProviders() {
  const csSwarm = tryRead(path.join(os.homedir(), ".crewswarm", "crewswarm.json")) || {};
  const p = csSwarm.providers || {};
  const candidates = [
    p.perplexity?.apiKey && { baseUrl: p.perplexity.baseUrl || "https://api.perplexity.ai",       apiKey: p.perplexity.apiKey, model: "sonar-pro",                name: "Perplexity" },
    p.cerebras?.apiKey   && { baseUrl: p.cerebras.baseUrl   || "https://api.cerebras.ai/v1",       apiKey: p.cerebras.apiKey,   model: "llama-3.3-70b",            name: "Cerebras"   },
    p.groq?.apiKey       && { baseUrl: p.groq.baseUrl       || "https://api.groq.com/openai/v1",   apiKey: p.groq.apiKey,       model: "llama-3.3-70b-versatile",  name: "Groq"       },
    p.mistral?.apiKey    && { baseUrl: p.mistral.baseUrl     || "https://api.mistral.ai/v1",        apiKey: p.mistral.apiKey,    model: "mistral-large-latest",     name: "Mistral"    },
    p.openai?.apiKey     && { baseUrl: p.openai.baseUrl      || "https://api.openai.com/v1",        apiKey: p.openai.apiKey,     model: "gpt-4o-mini",              name: "OpenAI"     },
  ].filter(Boolean);

  // Also include crew-lead's own provider as last-resort fallback
  const cfg = loadConfig();
  if (cfg.provider?.apiKey && !candidates.find(c => c.apiKey === cfg.provider.apiKey)) {
    candidates.push({ baseUrl: cfg.provider.baseUrl, apiKey: cfg.provider.apiKey, model: cfg.modelId, name: cfg.providerKey });
  }
  return candidates;
}

// ── AI Roadmap Generator ──────────────────────────────────────────────────────

function templateRoadmap(name, description, outputDir) {
  return `# ${name} — Living Roadmap

> Managed by CrewSwarm PM Loop. Add \`- [ ] items\` here at any time.

---

## Phase 1 — Foundation

- [ ] Set up project structure and entry point in ${outputDir}
- [ ] Create README.md with project overview and setup instructions
- [ ] Define core data models and types for: ${description || name}

## Phase 2 — Core Features

- [ ] Implement primary feature: ${description || name}
- [ ] Build the main UI/frontend in ${outputDir}
- [ ] Add backend logic, API endpoints, and data persistence
- [ ] Add error handling and input validation throughout

## Phase 3 — Polish & QA

- [ ] Write unit tests for core logic
- [ ] QA pass — check for edge cases and broken flows
- [ ] Performance review and optimisation
- [ ] Accessibility and UX improvements

## Phase 4 — Ship

- [ ] Final QA pass
- [ ] Commit all changes to git with clear messages
- [ ] Write deployment/setup documentation
`;
}

async function generateRoadmarkWithAI(name, description, outputDir) {
  const providers = getPMLLMProviders();

  if (!providers.length) {
    console.log("[crew-lead] No PM LLM providers configured — using template roadmap");
    return templateRoadmap(name, description, outputDir);
  }

  const systemPrompt = `You are a senior technical product manager. Generate a detailed, phased ROADMAP.md for a software project.

Rules:
- Output ONLY the roadmap markdown — no preamble, no explanation
- Use EXACTLY this format:

# {Project Name} — Living Roadmap

> Managed by CrewSwarm PM Loop.

---

## Phase 1 — Foundation
- [ ] Task one
- [ ] Task two

## Phase 2 — Core Features
- [ ] Task three

## Phase 3 — Polish & Ship
- [ ] Task

- Include 12-18 total tasks across 3-4 phases
- Each task: specific, actionable, completable by ONE agent in ONE session
- Vary tasks: backend (API/DB/scripts), frontend (HTML/CSS/JS), copy, git, QA, security
- Reference the output directory: ${outputDir}`;

  const userPrompt = `Project: "${name}"
Description: ${description || name}
Output directory: ${outputDir}

Generate the ROADMAP.md:`;

  for (const pmCfg of providers) {
    const isPerplexity = pmCfg.baseUrl.includes("perplexity");
    console.log(`[crew-lead] Generating roadmap via ${pmCfg.name || pmCfg.model}...`);
    try {
      const resp = await fetch(`${pmCfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": `Bearer ${pmCfg.apiKey}` },
        body: JSON.stringify({
          model: pmCfg.model,
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
          max_tokens: 1200,
          temperature: 0.4,
          ...(isPerplexity ? { search_recency_filter: "month" } : {}),
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => resp.statusText);
        console.warn(`[crew-lead] ${pmCfg.name} returned ${resp.status} — trying next provider`);
        continue; // try next provider instead of throwing
      }

      const data = await resp.json();
      const roadmap = data?.choices?.[0]?.message?.content?.trim();
      if (!roadmap) { console.warn(`[crew-lead] ${pmCfg.name} returned empty — trying next`); continue; }

      console.log(`[crew-lead] Roadmap generated via ${pmCfg.name} (${roadmap.length} chars)`);
      return roadmap.startsWith("#") ? roadmap : `# ${name} — Living Roadmap\n\n${roadmap}`;
    } catch (e) {
      console.warn(`[crew-lead] ${pmCfg.name} failed: ${e.message} — trying next provider`);
    }
  }

  // All providers failed — use template
  console.warn("[crew-lead] All PM LLM providers failed — using template roadmap");
  return templateRoadmap(name, description, outputDir);
}

// ── Pending project store (in-memory, keyed by session) ───────────────────────

const pendingProjects = new Map();

// Draft a roadmap without creating the project yet — returns for user review
async function draftProject({ name, description, outputDir }, sessionId) {
  const roadmapMd = await generateRoadmarkWithAI(name, description, outputDir);
  const draftId = crypto.randomUUID();
  pendingProjects.set(draftId, { name, description, outputDir, roadmapMd, sessionId, ts: Date.now() });
  console.log(`[crew-lead] Roadmap draft ready: ${name} (draftId=${draftId})`);
  return { draftId, name, description, outputDir, roadmapMd };
}

// Confirm + create the project, write roadmap, start PM loop
async function confirmProject({ draftId, roadmapMd: overrideMd }) {
  const draft = pendingProjects.get(draftId);
  if (!draft) throw new Error(`No pending project for draftId: ${draftId}`);
  pendingProjects.delete(draftId);

  const { name, description, outputDir, sessionId } = draft;
  const finalRoadmap = overrideMd || draft.roadmapMd;

  // Create project via dashboard API
  const createRes = await fetch(`${DASHBOARD}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, description: description || "", outputDir }),
    signal: AbortSignal.timeout(10000),
  });
  const proj = await createRes.json();
  if (!proj.ok) throw new Error("Failed to create project: " + (proj.error || "unknown"));
  const projectId = proj.project.id;

  // Write the approved roadmap
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "ROADMAP.md"), finalRoadmap, "utf8");
  console.log(`[crew-lead] Project confirmed: ${name} (${projectId}) — roadmap written`);

  // Start PM loop immediately
  try {
    const startRes = await fetch(`${DASHBOARD}/api/pm-loop/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId }),
      signal: AbortSignal.timeout(10000),
    });
    const startData = await startRes.json();
    console.log(`[crew-lead] PM loop started for ${name}:`, startData.pid || startData.message);
  } catch (e) {
    console.error(`[crew-lead] PM loop start failed: ${e.message}`);
  }

  appendHistory(sessionId || "owner", "system", `Project "${name}" confirmed and launched. PM loop running.`);
  broadcastSSE({ type: "project_launched", project: { projectId, name, outputDir } });
  return { projectId, name, outputDir };
}

// rtPublish is set once the RT connection is established
let rtPublish = null;
let crewLeadHeartbeat = null;

// Track dispatched tasks so completions route back to the right session
// Map<taskId, { sessionId, agent, task, ts, pipelineId?, stepIndex? }>
const pendingDispatches = new Map();

// Track active pipelines: pipelineId → { steps, stepIndex, sessionId }
// pendingPipelines: Map<pipelineId, { waves, currentWave, pendingTaskIds, waveResults, sessionId, steps }>
const pendingPipelines = new Map();

function dispatchPipelineWave(pipelineId) {
  const pipeline = pendingPipelines.get(pipelineId);
  if (!pipeline) return;

  const { waves, currentWave, sessionId, steps } = pipeline;
  if (currentWave >= waves.length) {
    // All waves done
    broadcastSSE({ type: "pipeline_done", pipelineId, ts: Date.now() });
    appendHistory(sessionId, "system", `Pipeline complete — all ${steps.length} steps finished.`);
    console.log(`[crew-lead] Pipeline ${pipelineId} complete`);
    pendingPipelines.delete(pipelineId);
    return;
  }

  const waveSteps = waves[currentWave];
  const prevResults = pipeline.waveResults || [];
  const contextBlock = prevResults.length
    ? `\n\n[Results from previous pipeline wave]:\n${prevResults.map((r, i) => `[${i+1}] ${r.slice(0, 600)}`).join("\n\n")}`
    : "";

  pipeline.pendingTaskIds = new Set();
  pipeline.waveResults = [];

  broadcastSSE({ type: "pipeline_progress", pipelineId, waveIndex: currentWave, totalWaves: waves.length, waveSize: waveSteps.length, agents: waveSteps.map(s => s.agent), ts: Date.now() });
  console.log(`[crew-lead] Pipeline ${pipelineId} wave ${currentWave + 1}/${waves.length} — dispatching ${waveSteps.length} agent(s) in parallel: ${waveSteps.map(s => s.agent).join(", ")}`);

  for (const step of waveSteps) {
    // Build full task spec including context from prior wave and optional verify/done criteria
    const stepSpec = {
      task: step.task + contextBlock,
      ...(step.verify ? { verify: step.verify } : {}),
      ...(step.done   ? { done:   step.done   } : {}),
    };
    const taskId = dispatchTask(step.agent, stepSpec, sessionId, { pipelineId, waveIndex: currentWave });
    if (taskId && taskId !== true) pipeline.pendingTaskIds.add(taskId);
  }
}

function buildTaskText(taskSpec) {
  // taskSpec can be a plain string or a {task, verify, done} object
  if (typeof taskSpec === "string") return taskSpec;
  let text = taskSpec.task || "";
  if (taskSpec.verify || taskSpec.done) {
    text += "\n\n## Acceptance criteria";
    if (taskSpec.verify) text += `\n- Verify: ${taskSpec.verify}`;
    if (taskSpec.done)   text += `\n- Done when: ${taskSpec.done}`;
  }
  return text;
}

function dispatchTask(agent, task, sessionId = "owner", pipelineMeta = null) {
  // task may be a plain string or a {task, verify, done} spec object
  const taskText = buildTaskText(task);
  task = taskText; // normalise to string for the rest of this function
  if (rtPublish) {
    try {
      const taskId = rtPublish({ channel: "command", type: "command.run_task", to: agent, payload: { content: task, prompt: task } });
      if (taskId) {
        pendingDispatches.set(taskId, {
          sessionId, agent, task, ts: Date.now(),
          ...(pipelineMeta || {}),
        });
      }
      console.log(`[crew-lead] dispatched via RT to ${agent} (taskId=${taskId}): ${task.slice(0, 60)}`);
      broadcastSSE({ type: "agent_working", agent, taskId, sessionId, ts: Date.now() });
      return taskId || true;
    } catch (e) {
      console.error(`[crew-lead] RT dispatch failed: ${e.message}`);
    }
  }
  // Fallback: openswitchctl (no reply routing back to crew-lead)
  console.log("[crew-lead] RT not connected — using openswitchctl send (replies won't appear in chat; check RT Messages tab)");
  try {
    const safeTask = task.replace(/"/g, '\\"').replace(/\n/g, " ");
    execSync(`"${CTL_PATH}" send "${agent}" "${safeTask}"`, { encoding: "utf8", timeout: 10000 });
    console.log(`[crew-lead] dispatched via ctl to ${agent}: ${task.slice(0, 60)}`);
    return true;
  } catch (e) {
    console.error(`[crew-lead] dispatch failed: ${e.message}`);
    return false;
  }
}

function dispatchPipelineStep(steps, stepIndex, sessionId, pipelineId, prevResult = "") {
  const step = steps[stepIndex];
  const taskText = prevResult
    ? `${step.task}\n\n[Context from previous step]:\n${prevResult.slice(0, 800)}`
    : step.task;
  broadcastSSE({ type: "pipeline_progress", pipelineId, stepIndex, total: steps.length, agent: step.agent, ts: Date.now() });
  return dispatchTask(step.agent, taskText, sessionId, { pipelineId, stepIndex, pipelineSteps: steps });
}

/**
 * Detect explicit service restart/stop requests from the user message.
 * Returns { action, id } or null.
 * This fires programmatically so crew-lead never has to "decide" whether it can restart.
 */
function parseServiceIntent(msg) {
  const t = msg.trim().toLowerCase();

  // "restart all agents" / "restart the agents" / "restart agents" / "bring agents back"
  if (/restart\s+(all\s+)?agents?|bring\s+agents?\s+(back|online|up)|start\s+all\s+agents?|agents?\s+back\s+up/.test(t))
    return { action: "restart", id: "agents" };

  // "restart telegram" / "start tg" / "bring telegram back"
  if (/restart\s+(the\s+)?tele?gram|start\s+(the\s+)?tele?gram|tele?gram\s+(back|up)|tg\s+(back|up|restart)/.test(t))
    return { action: "restart", id: "telegram" };

  // "restart the RT bus" / "restart rt"
  if (/restart\s+(the\s+)?rt(\s+bus)?|rt\s+bus\s+(down|crash|restart)/.test(t))
    return { action: "restart", id: "rt-bus" };

  // "restart crew-coder" or "restart crew-qa" etc.
  const agentMatch = t.match(/restart\s+(crew-[a-z0-9-]+)/);
  if (agentMatch) return { action: "restart", id: agentMatch[1] };

  // "can you restart them" / "restart them" / "restart everything" / "restart the crew"
  if (/restart\s+(them|it|everything|the\s+crew|all|bridges?)|bring\s+(them|the\s+crew|everyone)\s+back/.test(t))
    return { action: "restart", id: "agents" };

  // "stop telegram"
  if (/stop\s+(the\s+)?tele?gram|stop\s+tg\b/.test(t))
    return { action: "stop", id: "telegram" };

  return null;
}

/** True only when the user explicitly asks to search, research, or look something up. */
function messageNeedsSearch(msg) {
  const t = msg.trim().toLowerCase();
  if (t.length < 6) return false;
  const searchTriggers = [
    "go search", "search for", "search ", "research ", "look up", "look it up", "look that up",
    "can you search", "please search", "please look up", "please research",
    "run a search", "do a search",
  ];
  return searchTriggers.some(phrase => t.includes(phrase));
}

// ── Core chat handler ─────────────────────────────────────────────────────────

async function handleChat({ message, sessionId = "default", firstName = "User" }) {
  const cfg = loadConfig();
  const history = loadHistory(sessionId);

  // ── Programmatic service control — fire immediately, don't wait for LLM ──────
  // This prevents the LLM from ever claiming it "can't" restart services.
  const serviceIntent = parseServiceIntent(message);
  if (serviceIntent) {
    const { action, id } = serviceIntent;
    const actionLabel = action === "stop" ? "stopped" : "restarted";
    try {
      const isSpecificAgent = id.startsWith("crew-") && id !== "crew-lead";
      let ok = false;
      if (isSpecificAgent) {
        const r = await fetch(`http://127.0.0.1:${PORT}/api/agents/${id}/restart`, {
          method: "POST",
          headers: RT_TOKEN ? { authorization: `Bearer ${RT_TOKEN}` } : {},
          signal: AbortSignal.timeout(8000),
        });
        ok = (await r.json())?.ok !== false;
      } else {
        const endpoint = action === "stop" ? "/api/services/stop" : "/api/services/restart";
        const r = await fetch(`${DASHBOARD}${endpoint}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
          signal: AbortSignal.timeout(8000),
        });
        const data = await r.json();
        if (data?.ok === false && data?.message) {
          const reply = `${data.message}`;
          appendHistory(sessionId, "user", message);
          appendHistory(sessionId, "assistant", reply);
          broadcastSSE({ type: "chat_message", sessionId, role: "user", content: message });
          broadcastSSE({ type: "chat_message", sessionId, role: "assistant", content: reply });
          return { reply, dispatched: null, pendingProject: null, pipeline: null };
        }
        ok = true;
      }
      if (ok) {
        const reply = `On it — **${id}** ${actionLabel}. Give it 3–5 seconds to reconnect to the RT bus, then ask me "agents online?" for a fresh count.`;
        appendHistory(sessionId, "user", message);
        appendHistory(sessionId, "assistant", reply);
        appendHistory(sessionId, "system", `Service ${id} ${actionLabel} via direct intent detection.`);
        broadcastSSE({ type: "chat_message", sessionId, role: "user", content: message });
        broadcastSSE({ type: "chat_message", sessionId, role: "assistant", content: reply });
        console.log(`[crew-lead] service intent: ${action} ${id} → ok`);
        return { reply, dispatched: null, pendingProject: null, pipeline: null };
      }
    } catch (e) {
      console.error(`[crew-lead] service intent failed: ${e.message}`);
      // fall through to normal LLM response on error
    }
  }

  const needsSearch = messageNeedsSearch(message);
  // Inject health snapshot broadly — lightweight pgrep + file reads, not HTTP
  const needsHealth = message.length < 6
    ? false
    : /health|status|running|crashed|down\b|restart|skill|agent|workflow|pipeline|who.s.up|who.s.online|anyone.up|each.*up|up\?|is.*up|are.*up|online|services?|telegram|tg\b|opencode|project.*dir|settings/i.test(message);
  let braveResults = null;
  let codebaseResults = null;
  let healthData = null;
  try {
    const [b, c, h] = await Promise.all([
    needsSearch ? searchWithBrave(message).catch(() => null) : null,
    needsSearch ? Promise.resolve(searchCodebase(message)).catch(() => null) : null,
    needsHealth ? (async () => {
      try {
        const cfgRaw    = tryRead(path.join(os.homedir(), ".crewswarm", "config.json")) || {};
        const skillsDir = path.join(os.homedir(), ".crewswarm", "skills");
        let skills = [];
        try { skills = fs.readdirSync(skillsDir).filter(f => f.endsWith(".json")).map(f => f.replace(".json","")); } catch {}
        // Quick service status via pgrep (processes, not agent connections)
        const { execSync: esc } = await import("node:child_process");
        const isRunning = (pat) => { try { esc(`pgrep -f "${pat}"`, { stdio: "ignore" }); return true; } catch { return false; } };

        // Per-agent bridge status from RT bus — who is actually connected right now
        let rtAgentsOnline = new Set();
        try {
          const rtResp = await fetch("http://127.0.0.1:18889/status", { signal: AbortSignal.timeout(1500) });
          const rtData = await rtResp.json();
          if (Array.isArray(rtData.agents)) rtAgentsOnline = new Set(rtData.agents);
        } catch {}

        const allAgents = cfg.agentRoster.length
          ? cfg.agentRoster
          : cfg.knownAgents.map(id => ({ id, emoji: "🤖", model: "" }));

        const agentRows = allAgents.map(a => {
          const online = rtAgentsOnline.has(a.id);
          const status = online ? "✅" : "❌";
          return `  ${status} ${a.emoji||"🤖"} ${a.id}: tools=${readAgentTools(a.id).tools.join(",")||"(default)"} model=${a.model||"??"}`;
        });

        const rtBusUp = isRunning("opencrew-rt-daemon");
        const services = [
          `RT bus (18889): ${rtBusUp ? `✅ running — ${rtAgentsOnline.size} agents connected: ${[...rtAgentsOnline].join(", ")||"none"}` : "❌ DOWN — use @@SERVICE restart rt-bus"}`,
          `Telegram bridge: ${isRunning("telegram-bridge") ? "✅ running" : "⚠️ stopped — use @@SERVICE restart telegram"}`,
          `OpenCode (4096): ${isRunning("opencode serve") ? "✅ running" : "⚠️ stopped"}`,
        ];

        return [
          `[System health snapshot — live data from your local machine, fetched right now]`,
          `crew-lead: ${cfg.providerKey}/${cfg.modelId} | RT connected: ${!!rtPublish} | uptime: ${Math.floor(process.uptime())}s`,
          `crew-lead (this process) can create skills: use @@DEFINE_SKILL name + JSON + @@END_SKILL when the user asks. The agent list below is bridge agents only.`,
          `OpenCode project dir: ${cfgRaw.opencodeProject || "(not set — agents write to repo root)"}`,
          `Skills installed (${skills.length}): ${skills.length ? skills.join(", ") : "(none)"}`,
          ``,
          (() => {
            let pipelineNames = [];
            try {
              const pipelinesDir = path.join(os.homedir(), ".crewswarm", "pipelines");
              if (fs.existsSync(pipelinesDir)) pipelineNames = fs.readdirSync(pipelinesDir).filter(f => f.endsWith(".json")).map(f => f.replace(".json", ""));
            } catch {}
            return `Workflows (pipelines for cron) (${pipelineNames.length}): ${pipelineNames.length ? pipelineNames.join(", ") : "(none)"}`;
          })(),
          ``,
          `Services:`,
          ...services,
          ``,
          `Agents (${agentRows.length}):`,
          ...agentRows,
          ``,
          `[Use this data to answer the user's question. Do NOT say you cannot reach localhost.]`,
        ].join("\n");
      } catch { return null; }
    })() : null,
  ]);
    braveResults = b;
    codebaseResults = c;
    healthData = h;
  } catch (e) {
    console.error("[crew-lead] context fetch failed:", e?.message || e);
  }
  const parts = [message];
  if (braveResults) parts.push(`[Web context from Brave Search]\n${braveResults}`);
  if (codebaseResults) parts.push(`[Codebase context from workspace]\n${codebaseResults}`);
  if (healthData) parts.push(healthData);
  const userContent = parts.length > 1 ? parts.join("\n\n") : message;

  const messages = [
    { role: "system", content: buildSystemPrompt(cfg) },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: "user", content: userContent },
  ];

  appendHistory(sessionId, "user", message);
  // Audit trail: record what Brave actually injected so later turns (and you) can verify — no "context #5" confabulation
  if (braveResults) {
    const count = (braveResults.match(/\n\n/g) || []).length + 1;
    // Keep full numbered list (1. ... 2. ... 5. ...) in history so later turns can cite accurately — ~1200 chars usually includes result #5
    const preview = braveResults.replace(/\n/g, " ").slice(0, 1200);
    appendHistory(sessionId, "system", `[Brave search] query="${message.slice(0, 60)}${message.length > 60 ? "…" : ""}" → ${count} results. Preview: ${preview}${braveResults.length > 1200 ? "…" : ""}`);
  }
  broadcastSSE({ type: "chat_message", sessionId, role: "user", content: message });

  const fullReply = await callLLM(messages, cfg);

  // ── @@TOOLS — permission grant/revoke command ──────────────────────────────
  const toolsCmd = (() => {
    const m = fullReply.match(/@@TOOLS\s+(\{[^}]+\})/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
  })();

  // ── @@PROMPT — read/write an agent's system prompt ─────────────────────────
  // @@PROMPT {"agent":"crew-qa","set":"You are a QA specialist..."}
  // @@PROMPT {"agent":"crew-qa","append":"- Always use @@READ_FILE before auditing"}
  const promptCmd = (() => {
    const m = fullReply.match(/@@PROMPT\s+(\{[\s\S]*?\})\s*(?:\n|$)/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
  })();

  // ── @@BRAIN — append a fact to shared brain.md ─────────────────────────────
  // @@BRAIN crew-lead: some durable fact worth remembering
  const brainCmd = (() => {
    const m = fullReply.match(/@@BRAIN\s+([^\n]+)/);
    return m ? m[1].trim() : null;
  })();

  // ── @@GLOBALRULE — append a rule to global-rules.md (injected into all agents)
  // @@GLOBALRULE Always reply in the language the user wrote in
  const globalRuleCmd = (() => {
    const m = fullReply.match(/@@GLOBALRULE\s+([^\n]+)/);
    return m ? m[1].trim() : null;
  })();

  // ── @@SERVICE — restart/stop a service or agent bridge ──────────────────────
  // @@SERVICE restart telegram   @@SERVICE stop agents   @@SERVICE restart crew-coder
  const serviceCmd = (() => {
    const m = fullReply.match(/@@SERVICE\s+(restart|stop|start)\s+([a-zA-Z0-9_\-]+)/);
    return m ? { action: m[1], id: m[2] } : null;
  })();

  // ── @@DEFINE_SKILL — crew-lead writes a skill JSON to ~/.crewswarm/skills/
  // @@DEFINE_SKILL skillname\n{...json...}\n@@END_SKILL
  const defineSkillCmds = [];
  const defineSkillRe = /@@DEFINE_SKILL[ \t]+([a-zA-Z0-9_\-.]+)\n([\s\S]*?)@@END_SKILL/g;
  let dsMatch;
  while ((dsMatch = defineSkillRe.exec(fullReply)) !== null) {
    const skillName = dsMatch[1].trim();
    const rawJson   = dsMatch[2].trim();
    try {
      const def = JSON.parse(rawJson);
      const skillsDir = path.join(os.homedir(), ".crewswarm", "skills");
      fs.mkdirSync(skillsDir, { recursive: true });
      fs.writeFileSync(path.join(skillsDir, skillName + ".json"), JSON.stringify(def, null, 2));
      defineSkillCmds.push({ name: skillName, ok: true });
      console.log(`[crew-lead] @@DEFINE_SKILL saved: ${skillName}`);
    } catch (e) {
      defineSkillCmds.push({ name: skillName, ok: false, error: e.message });
    }
  }

  // ── @@DEFINE_WORKFLOW — create or replace a scheduled pipeline (stages: agent + task per stage)
  // @@DEFINE_WORKFLOW name\n[...]\n@@END_WORKFLOW
  const defineWorkflowCmds = [];
  const defineWorkflowRe = /@@DEFINE_WORKFLOW[ \t]+([a-zA-Z0-9_\-]+)\n([\s\S]*?)@@END_WORKFLOW/g;
  let dwMatch;
  while ((dwMatch = defineWorkflowRe.exec(fullReply)) !== null) {
    const wfName = dwMatch[1].trim();
    const rawJson = dwMatch[2].trim();
    try {
      const stages = JSON.parse(rawJson);
      if (!Array.isArray(stages)) throw new Error("stages must be a JSON array");
      const valid = stages
        .filter(s => s && s.agent && (s.task || s.taskText))
        .map(s => ({ agent: s.agent, task: s.task || s.taskText || "", tool: s.tool || undefined }));
      const pipelinesDir = path.join(os.homedir(), ".crewswarm", "pipelines");
      fs.mkdirSync(pipelinesDir, { recursive: true });
      fs.writeFileSync(path.join(pipelinesDir, wfName + ".json"), JSON.stringify({ stages: valid }, null, 2));
      defineWorkflowCmds.push({ name: wfName, ok: true, stageCount: valid.length });
      console.log(`[crew-lead] @@DEFINE_WORKFLOW saved: ${wfName} (${valid.length} stages)`);
    } catch (e) {
      defineWorkflowCmds.push({ name: wfName, ok: false, error: e.message });
    }
  }

  const projectSpec = parseProject(fullReply);
  const pipelineSteps = !projectSpec ? parsePipeline(fullReply) : null;
  const dispatch = !projectSpec && !pipelineSteps ? parseDispatch(fullReply, message) : null;
  let cleanReply = stripThink(stripPipeline(stripProject(stripDispatch(fullReply))))
    .replace(/@@TOOLS\s+\{[^}]+\}/g, "")
    .replace(/@@PROMPT\s+\{[\s\S]*?\}\s*(?:\n|$)/g, "")
    .replace(/@@BRAIN\s+[^\n]+/g, "")
    .replace(/@@GLOBALRULE\s+[^\n]+/g, "")
    .replace(/@@DEFINE_SKILL[ \t]+[a-zA-Z0-9_\-.]+\n[\s\S]*?@@END_SKILL/g, "")
    .replace(/@@DEFINE_WORKFLOW[ \t]+[a-zA-Z0-9_\-]+\n[\s\S]*?@@END_WORKFLOW/g, "")
    .replace(/@@SERVICE\s+(restart|stop|start)\s+[a-zA-Z0-9_\-]+/g, "")
    .trim();

  let dispatched = null;
  let pendingProject = null;
  let pipeline = null;

  if (projectSpec?.name && projectSpec?.outputDir) {
    try {
      pendingProject = await draftProject(projectSpec, sessionId);
      appendHistory(sessionId, "system", `Roadmap drafted for "${projectSpec.name}" — awaiting user approval.`);
      if (pendingProject) broadcastSSE({ type: "pending_project", sessionId, pendingProject });
    } catch (e) {
      console.error(`[crew-lead] Roadmap draft failed: ${e.message}`);
      appendHistory(sessionId, "system", `Roadmap draft failed: ${e.message}`);
    }
  } else if (pipelineSteps) {
    const pipelineId = crypto.randomUUID();
    const { steps, waves } = pipelineSteps;
    pendingPipelines.set(pipelineId, { steps, waves, currentWave: 0, pendingTaskIds: new Set(), waveResults: [], sessionId });
    dispatchPipelineWave(pipelineId);
    const waveDesc = waves.length > 1 ? ` in ${waves.length} waves` : "";
    appendHistory(sessionId, "system", `Pipeline started (${steps.length} steps${waveDesc}): ${waves.map(w => w.map(s => s.agent).join("+")).join(" → ")}`);
    const agentFlow = waves.map(w => w.length > 1 ? `[${w.map(s => s.agent).join(" ∥ ")}]` : w[0].agent).join(" → ");
    cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Pipeline started (${steps.length} steps${waveDesc}): ${agentFlow}`;
    pipeline = { pipelineId, steps, waves };
  } else if (dispatch && cfg.knownAgents.includes(dispatch.agent)) {
    // Pass full dispatch spec so verify/done criteria are injected into task text
    const ok = dispatchTask(dispatch.agent, dispatch, sessionId);
    if (ok) {
      dispatched = dispatch;
      appendHistory(sessionId, "system", `You dispatched to ${dispatch.agent}: "${(dispatch.task || "").slice(0, 200)}".`);
      const dispatchLine = rtPublish
        ? `\n\n↳ Dispatched to ${dispatch.agent} — reply will show here when they finish.`
        : `\n\n↳ Dispatched to ${dispatch.agent} (via ctl — check RT Messages tab for reply).`;
      cleanReply = (cleanReply || "").trimEnd() + dispatchLine;
    }
  }

  // ── Execute @@TOOLS permission change ──────────────────────────────────────
  if (toolsCmd?.agent) {
    try {
      const current = readAgentTools(toolsCmd.agent).tools;
      let updated;
      if (Array.isArray(toolsCmd.set)) {
        updated = toolsCmd.set;
      } else {
        const granted = Array.isArray(toolsCmd.grant)  ? toolsCmd.grant  : [];
        const revoked = Array.isArray(toolsCmd.revoke) ? toolsCmd.revoke : [];
        updated = [...new Set([...current, ...granted].filter(t => !revoked.includes(t)))];
      }
      const saved = writeAgentTools(toolsCmd.agent, updated);
      const note = `\n\n↳ Tool permissions updated for **${toolsCmd.agent}**: ${saved.join(", ")} — restart its bridge for changes to take effect.`;
      cleanReply = (cleanReply || "").trimEnd() + note;
      appendHistory(sessionId, "system", `Tool permissions for ${toolsCmd.agent} updated to: ${saved.join(", ")}`);
      console.log(`[crew-lead] @@TOOLS: ${toolsCmd.agent} → ${saved.join(", ")}`);
    } catch (e) {
      cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Failed to update tools for ${toolsCmd.agent}: ${e.message}`;
    }
  }

  // ── Execute @@PROMPT system prompt edit ────────────────────────────────────
  if (promptCmd?.agent) {
    try {
      const existing = getAgentPrompts()[promptCmd.agent] || "";
      let newPrompt;
      if (typeof promptCmd.set === "string") {
        newPrompt = promptCmd.set;
      } else if (typeof promptCmd.append === "string") {
        newPrompt = existing ? `${existing}\n${promptCmd.append}` : promptCmd.append;
      } else {
        newPrompt = existing;
      }
      writeAgentPrompt(promptCmd.agent, newPrompt);
      const preview = newPrompt.slice(0, 120).replace(/\n/g, " ");
      const note = `\n\n↳ System prompt updated for **${promptCmd.agent}**: "${preview}${newPrompt.length > 120 ? "…" : ""}" — restart its bridge for changes to take effect.`;
      cleanReply = (cleanReply || "").trimEnd() + note;
      appendHistory(sessionId, "system", `Prompt for ${promptCmd.agent} updated.`);
      console.log(`[crew-lead] @@PROMPT: ${promptCmd.agent} updated (${newPrompt.length} chars)`);
    } catch (e) {
      cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Failed to update prompt for ${promptCmd.agent}: ${e.message}`;
    }
  }

  // ── Execute @@BRAIN append ──────────────────────────────────────────────────
  if (brainCmd) {
    try {
      const block = appendToBrain("crew-lead", brainCmd);
      cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Added to brain.md: "${block.slice(0, 100)}"`;
      console.log(`[crew-lead] @@BRAIN: ${brainCmd.slice(0, 80)}`);
    } catch (e) {
      cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Failed to write brain.md: ${e.message}`;
    }
  }

  // ── Execute @@GLOBALRULE append ────────────────────────────────────────────
  if (globalRuleCmd) {
    try {
      appendGlobalRule(globalRuleCmd);
      cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Global rule added (all agents): "${globalRuleCmd}" — restart bridges to apply.`;
      appendHistory(sessionId, "system", `Global rule added: ${globalRuleCmd}`);
      console.log(`[crew-lead] @@GLOBALRULE: ${globalRuleCmd}`);
    } catch (e) {
      cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Failed to write global-rules.md: ${e.message}`;
    }
  }

  // ── Execute @@SERVICE control ───────────────────────────────────────────────
  if (serviceCmd) {
    const { action, id } = serviceCmd;
    try {
      // Per-agent restart: if ID looks like a specific agent, use the agents/:id/restart endpoint
      const isSpecificAgent = id.startsWith("crew-") && id !== "crew-lead";
      let result;

      const authHeader = RT_TOKEN ? { authorization: `Bearer ${RT_TOKEN}` } : {};
      if (action === "stop" && !isSpecificAgent) {
        const r = await fetch(`${DASHBOARD}/api/services/stop`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
          signal: AbortSignal.timeout(8000),
        });
        result = await r.json();
      } else if (isSpecificAgent && action !== "stop") {
        // Single agent bridge restart via dedicated endpoint
        const r = await fetch(`http://127.0.0.1:${PORT}/api/agents/${id}/restart`, {
          method: "POST",
          headers: authHeader,
          signal: AbortSignal.timeout(8000),
        });
        result = await r.json();
      } else {
        const r = await fetch(`${DASHBOARD}/api/services/restart`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
          signal: AbortSignal.timeout(8000),
        });
        result = await r.json();
      }

      if (result?.ok === false && result?.message) {
        cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Service **${id}** — ${result.message}`;
      } else {
        const actionLabel = action === "stop" ? "stopped" : "restarted";
        cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ **${id}** ${actionLabel}. Give it 2–3 seconds to come back online.`;
        appendHistory(sessionId, "system", `Service ${id} ${actionLabel} via @@SERVICE.`);
        console.log(`[crew-lead] @@SERVICE ${action} ${id}: ok`);
      }
    } catch (e) {
      cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Failed to ${action} **${id}**: ${e.message}`;
    }
  }

  // ── Surface @@DEFINE_SKILL results ─────────────────────────────────────────
  for (const ds of defineSkillCmds) {
    if (ds.ok) {
      cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Skill **${ds.name}** saved to ~/.crewswarm/skills/${ds.name}.json — agents with 'skill' permission can now call it.`;
      appendHistory(sessionId, "system", `Skill "${ds.name}" defined and saved.`);
    } else {
      cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Failed to save skill **${ds.name}**: ${ds.error}`;
    }
  }

  // ── Surface @@DEFINE_WORKFLOW results ─────────────────────────────────────
  for (const dw of defineWorkflowCmds) {
    if (dw.ok) {
      cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Workflow **${dw.name}** saved to ~/.crewswarm/pipelines/${dw.name}.json (${dw.stageCount} stages). Run with: \`node scripts/run-scheduled-pipeline.mjs ${dw.name}\` or add to crontab.`;
      appendHistory(sessionId, "system", `Workflow "${dw.name}" defined (${dw.stageCount} stages).`);
    } else {
      cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Failed to save workflow **${dw.name}**: ${dw.error}`;
    }
  }

  appendHistory(sessionId, "assistant", cleanReply);
  broadcastSSE({ type: "chat_message", sessionId, role: "assistant", content: cleanReply });

  return { reply: cleanReply, dispatched, pendingProject, pipeline };
}

// ── HTTP server ───────────────────────────────────────────────────────────────

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(body);
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" });
    res.end();
    return;
  }

  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === "/health" && req.method === "GET") {
      json(res, 200, { ok: true, agent: "crew-lead", port: PORT });
      return;
    }

    if (url.pathname === "/status" && req.method === "GET") {
      const cfg = loadConfig();
      json(res, 200, { ok: true, model: cfg.model, rtConnected: rtPublish !== null, agents: cfg.knownAgents });
      return;
    }

    if (url.pathname === "/chat" && req.method === "POST") {
      let message, sessionId, firstName;
      try {
        const body = await readBody(req);
        message = body.message;
        sessionId = body.sessionId;
        firstName = body.firstName;
      } catch (e) {
        json(res, 400, { ok: false, error: "invalid JSON body or missing message" });
        return;
      }
      if (!message) { json(res, 400, { ok: false, error: "message required" }); return; }
      console.log(`[crew-lead] /chat session=${sessionId} msg=${message.slice(0, 60)}`);
      try {
        const result = await handleChat({ message, sessionId, firstName });
        json(res, 200, { ok: true, ...result });
      } catch (e) {
        console.error("[crew-lead] handleChat failed:", e?.message || e);
        json(res, 500, { ok: false, error: e?.message || String(e), reply: null });
      }
      return;
    }

    if (url.pathname === "/clear" && req.method === "POST") {
      const { sessionId } = await readBody(req);
      clearHistory(sessionId || "default");
      json(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/events" && req.method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "access-control-allow-origin": "*",
        "connection": "keep-alive",
      });
      res.write("retry: 3000\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    if (url.pathname === "/history" && req.method === "GET") {
      const sessionId = url.searchParams.get("sessionId") || "default";
      const history = loadHistory(sessionId);
      json(res, 200, { ok: true, history, count: history.length });
      return;
    }

    if (url.pathname === "/confirm-project" && req.method === "POST") {
      const { draftId, roadmapMd } = await readBody(req);
      if (!draftId) { json(res, 400, { ok: false, error: "draftId required" }); return; }
      console.log(`[crew-lead] /confirm-project draftId=${draftId}`);
      try {
        const result = await confirmProject({ draftId, roadmapMd });
        json(res, 200, { ok: true, ...result });
      } catch (e) {
        json(res, 500, { ok: false, error: e.message });
      }
      return;
    }

    if (url.pathname === "/discard-project" && req.method === "POST") {
      const { draftId } = await readBody(req);
      if (draftId) {
        pendingProjects.delete(draftId);
        broadcastSSE({ type: "draft_discarded", draftId });
      }
      json(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/approve-cmd" && req.method === "POST") {
      const { approvalId } = await readBody(req);
      if (!approvalId) { json(res, 400, { ok: false, error: "approvalId required" }); return; }
      if (rtPublish) {
        rtPublish({ channel: "events", type: "cmd.approved", to: "broadcast", payload: { approvalId } });
        console.log(`[crew-lead] ✅ cmd approved: ${approvalId}`);
      }
      json(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/reject-cmd" && req.method === "POST") {
      const { approvalId } = await readBody(req);
      if (!approvalId) { json(res, 400, { ok: false, error: "approvalId required" }); return; }
      if (rtPublish) {
        rtPublish({ channel: "events", type: "cmd.rejected", to: "broadcast", payload: { approvalId } });
        console.log(`[crew-lead] ⛔ cmd rejected: ${approvalId}`);
      }
      json(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/allowlist-cmd" && req.method === "POST") {
      const { pattern } = await readBody(req);
      if (!pattern) { json(res, 400, { ok: false, error: "pattern required" }); return; }
      const file = path.join(os.homedir(), ".crewswarm", "cmd-allowlist.json");
      let list = [];
      try { list = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
      if (!list.includes(pattern)) {
        list.push(pattern);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(list, null, 2));
        console.log(`[crew-lead] ✅ Added to cmd allowlist: ${pattern}`);
      }
      json(res, 200, { ok: true, pattern, list });
      return;
    }

    if (url.pathname === "/allowlist-cmd" && req.method === "DELETE") {
      const { pattern } = await readBody(req);
      const file = path.join(os.homedir(), ".crewswarm", "cmd-allowlist.json");
      let list = [];
      try { list = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
      list = list.filter(p => p !== pattern);
      fs.writeFileSync(file, JSON.stringify(list, null, 2));
      console.log(`[crew-lead] 🗑 Removed from cmd allowlist: ${pattern}`);
      json(res, 200, { ok: true, list });
      return;
    }

    if (url.pathname === "/allowlist-cmd" && req.method === "GET") {
      const file = path.join(os.homedir(), ".crewswarm", "cmd-allowlist.json");
      let list = [];
      try { list = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
      json(res, 200, { ok: true, list });
      return;
    }

    if (url.pathname === "/health" && req.method === "GET") {
      json(res, 200, { ok: true, service: "crew-lead", uptime: process.uptime() });
      return;
    }

    // ── External agent API — Bearer token required ────────────────────────────
    // Any external tool (another CrewSwarm, OpenClaw plugin, scripts) can dispatch tasks
    // and poll status without sharing LLM credentials.
    // Auth: Authorization: Bearer <RT_TOKEN from ~/.crewswarm/config.json rt.authToken>

    function checkBearer(request) {
      if (!RT_TOKEN) return true; // no token configured → open (local-first default)
      const auth = request.headers["authorization"] || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      return token === RT_TOKEN;
    }

    // POST /api/dispatch  { agent, task, verify?, done?, sessionId? }
    // Returns { ok, taskId, agent }
    if (url.pathname === "/api/dispatch" && req.method === "POST") {
      if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized — Bearer token required" }); return; }
      const body = await readBody(req);
      const { agent, task, verify, done, sessionId: sid } = body;
      if (!agent || !task) { json(res, 400, { ok: false, error: "agent and task are required" }); return; }
      const knownAgents = loadConfig().knownAgents || [];
      if (knownAgents.length && !knownAgents.includes(agent)) {
        json(res, 400, { ok: false, error: `Unknown agent "${agent}". Known: ${knownAgents.join(", ")}` });
        return;
      }
      const spec = verify || done ? { task, verify, done } : task;
      const taskId = dispatchTask(agent, spec, sid || "external");
      if (!taskId) { json(res, 503, { ok: false, error: "RT bus not connected — agent unreachable" }); return; }
      console.log(`[crew-lead] /api/dispatch → ${agent} taskId=${taskId}`);
      json(res, 200, { ok: true, taskId: taskId === true ? null : taskId, agent });
      return;
    }

    // GET /api/status/:taskId  — poll task completion
    // Returns { ok, taskId, status: "pending"|"done"|"unknown", agent, result? }
    if (url.pathname.startsWith("/api/status/") && req.method === "GET") {
      if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized — Bearer token required" }); return; }
      const taskId = url.pathname.slice("/api/status/".length);
      const dispatch = pendingDispatches.get(taskId);
      if (!dispatch) {
        json(res, 200, { ok: true, taskId, status: "unknown" });
        return;
      }
      const isDone = dispatch.done === true;
      json(res, 200, {
        ok: true, taskId, status: isDone ? "done" : "pending",
        agent: dispatch.agent, sessionId: dispatch.sessionId,
        ...(isDone ? { result: dispatch.result || null } : {}),
        ts: dispatch.ts, elapsedMs: Date.now() - dispatch.ts,
      });
      return;
    }

    // GET /api/agents  — list known agents with tools, model, identity
    if (url.pathname === "/api/agents" && req.method === "GET") {
      if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized — Bearer token required" }); return; }
      const cfg = loadConfig();
      const agents = cfg.agentRoster.length
        ? cfg.agentRoster.map(a => ({ ...a, tools: readAgentTools(a.id).tools }))
        : (cfg.knownAgents || []).map(id => ({ id, tools: readAgentTools(id).tools }));
      json(res, 200, { ok: true, agents });
      return;
    }

    // GET /api/agents/:id/tools — read an agent's current tool permissions
    const toolsGetMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/tools$/);
    if (toolsGetMatch && req.method === "GET") {
      if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
      const agentId = toolsGetMatch[1];
      const result  = readAgentTools(agentId);
      json(res, 200, {
        ok: true, agentId,
        tools: result.tools,
        source: result.source,
        allTools: [...CREWSWARM_TOOL_NAMES],
      });
      return;
    }

    // PATCH /api/agents/:id/tools — update an agent's tool permissions
    // Body: { "grant": ["write_file"], "revoke": ["run_cmd"] }  OR  { "set": ["read_file","write_file"] }
    const toolsPatchMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/tools$/);
    if (toolsPatchMatch && req.method === "PATCH") {
      if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
      const agentId = toolsPatchMatch[1];
      const body    = await readBody(req);
      const current = readAgentTools(agentId).tools;
      let updated;
      if (Array.isArray(body.set)) {
        updated = body.set;
      } else {
        const granted  = Array.isArray(body.grant)  ? body.grant  : [];
        const revoked  = Array.isArray(body.revoke) ? body.revoke : [];
        updated = [...new Set([...current, ...granted].filter(t => !revoked.includes(t)))];
      }
      const saved = writeAgentTools(agentId, updated);
      console.log(`[crew-lead] tools updated for ${agentId}: ${saved.join(", ")}`);
      json(res, 200, { ok: true, agentId, tools: saved });
      return;
    }

    // ── Inbound webhook receiver ───────────────────────────────────────────────
    // POST /webhook/:channel   — accepts any JSON payload, forwards to RT bus
    // No auth on this endpoint so external services can push without managing tokens.
    // Use a unique channel name per integration (e.g. /webhook/n8n, /webhook/stripe).
    const webhookMatch = url.pathname.match(/^\/webhook\/([a-zA-Z0-9_\-]+)$/);
    if (webhookMatch && req.method === "POST") {
      const channel = webhookMatch[1];
      let body = {};
      try {
        const raw = await readBody(req);
        body = raw ? JSON.parse(raw) : {};
      } catch { /* non-JSON body is fine */ }
      const event = { type: "webhook", channel, payload: body, ts: Date.now() };
      if (rtPublish) {
        rtPublish({ channel: `webhook.${channel}`, type: "webhook.event", payload: event });
        console.log(`[crew-lead] webhook → ${channel}: ${JSON.stringify(body).slice(0, 80)}`);
      }
      broadcastSSE({ type: "webhook_event", channel, payload: body, ts: Date.now() });
      json(res, 200, { ok: true, channel, ts: Date.now() });
      return;
    }

    // ── Skills API ─────────────────────────────────────────────────────────────
    const SKILLS_DIR         = path.join(os.homedir(), ".crewswarm", "skills");
    const PENDING_SKILLS_FILE = path.join(os.homedir(), ".crewswarm", "pending-skills.json");

    // GET /api/skills — list installed skills
    if (url.pathname === "/api/skills" && req.method === "GET") {
      if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
      try {
        fs.mkdirSync(SKILLS_DIR, { recursive: true });
        const files = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith(".json"));
        const skills = files.map(f => {
          try { return { name: f.replace(".json",""), ...JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, f), "utf8")) }; }
          catch { return { name: f.replace(".json",""), error: "parse failed" }; }
        });
        json(res, 200, { ok: true, skills });
      } catch (e) { json(res, 500, { ok: false, error: e.message }); }
      return;
    }

    // POST /api/skills  { name, url, method, description, headers, auth, defaultParams, requiresApproval }
    if (url.pathname === "/api/skills" && req.method === "POST") {
      if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
      const body = JSON.parse(await readBody(req));
      if (!body.name || !body.url) { json(res, 400, { ok: false, error: "name and url required" }); return; }
      fs.mkdirSync(SKILLS_DIR, { recursive: true });
      const { name, ...def } = body;
      fs.writeFileSync(path.join(SKILLS_DIR, `${name}.json`), JSON.stringify(def, null, 2));
      json(res, 200, { ok: true, name });
      return;
    }

    // POST /api/skills/:name/run  — execute a skill from the dashboard (params in body)
    const skillRunMatch = url.pathname.match(/^\/api\/skills\/([a-zA-Z0-9_\-\.]+)\/run$/);
    if (skillRunMatch && req.method === "POST") {
      if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
      const skillName = skillRunMatch[1];
      const skillFile = path.join(SKILLS_DIR, `${skillName}.json`);
      if (!fs.existsSync(skillFile)) { json(res, 404, { ok: false, error: "Skill not found" }); return; }
      let skillDef;
      try { skillDef = JSON.parse(fs.readFileSync(skillFile, "utf8")); } catch (e) { json(res, 500, { ok: false, error: "Invalid skill JSON" }); return; }
      let body = {};
      try { body = await readBody(req); } catch {}
      const params = { ...(skillDef.defaultParams || {}), ...(body.params || body) };
      const swarmCfg = tryRead(path.join(os.homedir(), ".crewswarm", "crewswarm.json")) || {};
      let urlStr = skillDef.url || "";
      for (const [k, v] of Object.entries(params)) urlStr = urlStr.replace(`{${k}}`, encodeURIComponent(String(v)));
      const headers = { "Content-Type": "application/json", ...(skillDef.headers || {}) };
      if (skillDef.auth) {
        const auth = skillDef.auth;
        let token = auth.token || "";
        if (auth.keyFrom) {
          if (auth.keyFrom.startsWith("env.")) token = process.env[auth.keyFrom.slice(4)] || "";
          else {
            let val = swarmCfg;
            for (const p of auth.keyFrom.split(".")) val = val?.[p];
            if (val) token = String(val);
          }
        }
        if (token) {
          if (auth.type === "bearer" || !auth.type) headers["Authorization"] = `Bearer ${token}`;
          else if (auth.type === "header") headers[auth.header || "X-API-Key"] = token;
        }
      }
      const method = (skillDef.method || "POST").toUpperCase();
      const reqOpts = { method, headers, signal: AbortSignal.timeout(skillDef.timeout || 30000) };
      if (method !== "GET" && method !== "HEAD") reqOpts.body = JSON.stringify(params);
      try {
        const r = await fetch(urlStr, reqOpts);
        const text = await r.text();
        if (!r.ok) { json(res, 502, { ok: false, error: `Upstream ${r.status}: ${text.slice(0, 200)}` }); return; }
        try { json(res, 200, { ok: true, result: JSON.parse(text) }); }
        catch { json(res, 200, { ok: true, result: { response: text } }); }
      } catch (e) { json(res, 502, { ok: false, error: e.message }); }
      return;
    }

    // DELETE /api/skills/:name
    const skillDeleteMatch = url.pathname.match(/^\/api\/skills\/([a-zA-Z0-9_\-\.]+)$/);
    if (skillDeleteMatch && req.method === "DELETE") {
      if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
      const skillFile = path.join(SKILLS_DIR, `${skillDeleteMatch[1]}.json`);
      if (fs.existsSync(skillFile)) { fs.unlinkSync(skillFile); json(res, 200, { ok: true }); }
      else { json(res, 404, { ok: false, error: "Skill not found" }); }
      return;
    }

    // POST /api/skills/approve  { approvalId }  — approve a pending skill call
    if (url.pathname === "/api/skills/approve" && req.method === "POST") {
      if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
      const body = JSON.parse(await readBody(req));
      const { approvalId } = body;
      let pending = {};
      try { pending = JSON.parse(fs.readFileSync(PENDING_SKILLS_FILE, "utf8")); } catch {}
      const entry = pending[approvalId];
      if (!entry) { json(res, 404, { ok: false, error: "Approval ID not found or expired" }); return; }
      delete pending[approvalId];
      fs.writeFileSync(PENDING_SKILLS_FILE, JSON.stringify(pending, null, 2));
      // Execute the skill via the gateway bridge process is impractical from here;
      // instead, push approved result to RT bus so agent can see it
      broadcastSSE({ type: "skill_approved", approvalId, skillName: entry.skillName, agentId: entry.agentId, ts: Date.now() });
      console.log(`[crew-lead] skill approved: ${entry.skillName} (${approvalId}) — notifying bridge agents`);
      if (rtPublish) {
        rtPublish({ channel: "skill.approved", type: "skill.approved", payload: { approvalId, skillName: entry.skillName, agentId: entry.agentId, params: entry.params } });
      }
      json(res, 200, { ok: true, approvalId, skillName: entry.skillName });
      return;
    }

    // POST /api/skills/reject  { approvalId }
    if (url.pathname === "/api/skills/reject" && req.method === "POST") {
      if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
      const body = JSON.parse(await readBody(req));
      const { approvalId } = body;
      let pending = {};
      try { pending = JSON.parse(fs.readFileSync(PENDING_SKILLS_FILE, "utf8")); } catch {}
      delete pending[approvalId];
      try { fs.writeFileSync(PENDING_SKILLS_FILE, JSON.stringify(pending, null, 2)); } catch {}
      broadcastSSE({ type: "skill_rejected", approvalId, ts: Date.now() });
      json(res, 200, { ok: true, approvalId });
      return;
    }

    // ── Spending caps API ──────────────────────────────────────────────────────
    const SPENDING_FILE = path.join(os.homedir(), ".crewswarm", "spending.json");

    // GET /api/spending — today's usage across global + per-agent
    if (url.pathname === "/api/spending" && req.method === "GET") {
      if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
      let spending = { date: new Date().toISOString().slice(0, 10), global: { tokens: 0, costUSD: 0 }, agents: {} };
      try { spending = JSON.parse(fs.readFileSync(SPENDING_FILE, "utf8")); } catch {}
      // Attach caps config
      let caps = {};
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "crewswarm.json"), "utf8"));
        caps.global = cfg.globalSpendingCaps || {};
        caps.agents = (cfg.agents || []).reduce((acc, a) => { if (a.spending) acc[a.id] = a.spending; return acc; }, {});
      } catch {}
      json(res, 200, { ok: true, spending, caps });
      return;
    }

    // POST /api/spending/reset — reset today's spending counters
    if (url.pathname === "/api/spending/reset" && req.method === "POST") {
      if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
      const fresh = { date: new Date().toISOString().slice(0, 10), global: { tokens: 0, costUSD: 0 }, agents: {} };
      try { fs.writeFileSync(SPENDING_FILE, JSON.stringify(fresh, null, 2)); } catch {}
      json(res, 200, { ok: true, reset: true });
      return;
    }

    // GET /api/health — master health check: all settings, agents, skills, spending, services
    if (url.pathname === "/api/health" && req.method === "GET") {
      if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
      const cfg       = loadConfig();
      const cfgRaw    = tryRead(path.join(os.homedir(), ".crewswarm", "config.json"))    || {};
      const swarmRaw  = tryRead(path.join(os.homedir(), ".crewswarm", "crewswarm.json")) || {};

      // OpenCode project dir
      const opencodeProject = cfgRaw.opencodeProject || process.env.OPENCREW_OPENCODE_PROJECT || "";

      // Agents with tools + model
      const agentRows = cfg.agentRoster.map(a => {
        const tools = readAgentTools(a.id).tools;
        return { id: a.id, name: a.name, emoji: a.emoji, role: a.role, model: a.model, tools };
      });

      // Skills
      const SKILLS_DIR = path.join(os.homedir(), ".crewswarm", "skills");
      let skills = [];
      try {
        fs.mkdirSync(SKILLS_DIR, { recursive: true });
        skills = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith(".json")).map(f => {
          try { return { name: f.replace(".json",""), ...JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, f), "utf8")) }; }
          catch { return { name: f.replace(".json",""), error: "parse failed" }; }
        });
      } catch {}

      // Spending
      let spending = { global: { tokens: 0, costUSD: 0 }, agents: {} };
      try { spending = JSON.parse(fs.readFileSync(SPENDING_FILE, "utf8")); } catch {}

      // RT bus connectivity
      const rtConnected = !!rtPublish;

      // Providers (keys masked)
      const providers = Object.entries(swarmRaw?.providers || {}).map(([id, p]) => ({
        id, baseUrl: p.baseUrl, hasKey: !!(p.apiKey || "").trim(),
      }));

      json(res, 200, {
        ok: true,
        ts: new Date().toISOString(),
        crewLead: {
          model:   `${cfg.providerKey}/${cfg.modelId}`,
          port:    PORT,
          rtConnected,
        },
        settings: {
          opencodeProject,
          rtAuthToken: !!(cfgRaw?.rt?.authToken || "").trim(),
        },
        agents: agentRows,
        skills,
        spending,
        providers,
      });
      return;
    }

    // POST /api/agents/:id/restart — kill and respawn a single bridge process
    const restartMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/restart$/);
    if (restartMatch && req.method === "POST") {
      if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
      const agentId = restartMatch[1];
      const { execSync: exec2 } = await import("node:child_process");
      try {
        // Kill existing bridge for this agent
        exec2(`pkill -f "gateway-bridge.mjs.*${agentId}" 2>/dev/null || true`, { shell: true });
        // Brief pause then respawn via start-crew (it will detect which are missing)
        setTimeout(() => {
          try {
            exec2(`node ${path.join(process.cwd(), "scripts", "start-crew.mjs")} --agent ${agentId} &`, { shell: true });
          } catch {}
        }, 500);
        console.log(`[crew-lead] restart requested for ${agentId}`);
        json(res, 200, { ok: true, agentId, action: "restart" });
      } catch (e) {
        json(res, 500, { ok: false, error: e.message });
      }
      return;
    }

    json(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    console.error("[crew-lead] error:", err.message);
    json(res, 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const cfg = loadConfig();
  console.log(`[crew-lead] HTTP server on http://127.0.0.1:${PORT}`);
  console.log(`[crew-lead] Model: ${cfg.providerKey}/${cfg.modelId}`);
  console.log(`[crew-lead] History: ${HISTORY_DIR}`);
  console.log(`[crew-lead] Agents: ${cfg.knownAgents.join(", ")}`);
  connectRT();
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[crew-lead] Port ${PORT} already in use — kill the existing process first`);
  } else {
    console.error("[crew-lead] server error:", err.message);
  }
  process.exit(1);
});

// Keep alive — don't crash on unhandled promise rejections or async errors
process.on("unhandledRejection", (reason) => {
  console.error("[crew-lead] unhandled rejection (kept alive):", reason?.message || reason);
});
process.on("uncaughtException", (err) => {
  console.error("[crew-lead] uncaught exception (kept alive):", err.message);
});

// ── RT Bus listener — receives replies from agents ────────────────────────────

const RT_URL   = process.env.OPENCREW_RT_URL   || "ws://127.0.0.1:18889";
const RT_TOKEN = process.env.OPENCREW_RT_AUTH_TOKEN || (() => {
  try {
    const cs = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "config.json"), "utf8"));
    if (cs?.rt?.authToken) return cs.rt.authToken;
  } catch {}
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".openclaw", "openclaw.json"), "utf8"))?.env?.OPENCREW_RT_AUTH_TOKEN || "";  // legacy fallback
  } catch { return ""; }
})();

// SSE clients listening for agent replies
const sseClients = new Set();

function broadcastSSE(payload) {
  const event = JSON.stringify(payload);
  for (const client of sseClients) {
    try { client.write(`data: ${event}\n\n`); } catch {}
  }
}

function connectRT() {
  const ws = new WebSocket(RT_URL);
  let ready = false;

  ws.on("open", () => console.log("[crew-lead] RT socket open"));

  ws.on("message", (raw) => {
    let p;
    try { p = JSON.parse(raw.toString()); } catch { return; }

    if (p.type === "server.hello") {
      ws.send(JSON.stringify({ type: "hello", agent: "crew-lead", token: RT_TOKEN }));
      return;
    }
    if (p.type === "hello.ack") {
      ws.send(JSON.stringify({ type: "subscribe", channels: ["done", "events"] }));
      ready = true;
      // Expose publish function for dispatchTask
      rtPublish = ({ channel, type, to, payload }) => {
        const taskId = crypto.randomUUID();
        ws.send(JSON.stringify({ type: "publish", channel, messageType: type, to, taskId, priority: "high", payload }));
        return taskId;
      };
      console.log("[crew-lead] RT connected — listening for agent replies");
      // Send heartbeat every 30s so monitoring sees crew-lead as up
      if (crewLeadHeartbeat) clearInterval(crewLeadHeartbeat);
      crewLeadHeartbeat = setInterval(() => {
        try {
          const taskId = crypto.randomUUID();
          ws.send(JSON.stringify({
            type: "publish", channel: "status", messageType: "agent.heartbeat",
            to: "broadcast", taskId, priority: "low",
            payload: { agent: "crew-lead", ts: new Date().toISOString() },
          }));
        } catch {}
      }, 30000);
      return;
    }
    if (p.type === "error") {
      console.error("[crew-lead] RT error:", p.message);
      if (/token|auth|unauthorized/i.test(String(p.message))) {
        console.error("[crew-lead] Tip: Set RT token in dashboard Settings (RT Bus) or in ~/.crewswarm/config.json (rt.authToken) so agent replies show in chat.");
      }
      return;
    }

    if (p.type === "message" && p.envelope) {
      const env = p.envelope;
      if (env.id) ws.send(JSON.stringify({ type: "ack", messageId: env.id, status: "received" }));

      const from    = env.from || env.sender_agent_id || "";
      const msgType = env.messageType || env.type || "";
      const reply   = env.payload?.reply != null ? String(env.payload.reply).trim() : "";
      const content = reply || (env.payload?.content ? String(env.payload.content).trim() : "");

      const isDone = msgType === "task.done" || env.channel === "done";

      if (isDone && content && from && from !== "crew-lead") {
        console.log(`[crew-lead] ✅ Agent reply from ${from}: ${content.slice(0, 120)}`);

        const taskId = env.taskId || env.correlationId || "";
        const dispatch = pendingDispatches.get(taskId);
        const targetSession = dispatch?.sessionId || "owner";
        // Mark done (keep for /api/status polling) but schedule cleanup after 10 min
        if (dispatch) {
          dispatch.done = true;
          dispatch.result = content.slice(0, 4000);
          setTimeout(() => pendingDispatches.delete(taskId), 600_000);
        }

        appendHistory(targetSession, "system", `[${from} completed task]: ${content.slice(0, 2000)}`);
        broadcastSSE({ type: "agent_reply", from, content: content.slice(0, 2000), sessionId: targetSession, taskId, ts: Date.now() });

        // Advance pipeline if this task was part of one (wave-aware)
        if (dispatch?.pipelineId) {
          const pipeline = pendingPipelines.get(dispatch.pipelineId);
          if (pipeline) {
            // Record this task's result and mark it done in the current wave
            pipeline.waveResults.push(content);
            pipeline.pendingTaskIds.delete(taskId);

            console.log(`[crew-lead] Pipeline ${dispatch.pipelineId} wave ${pipeline.currentWave + 1}: ${pipeline.pendingTaskIds.size} task(s) still pending`);

            if (pipeline.pendingTaskIds.size === 0) {
              // All tasks in this wave are done — advance to next wave
              pipeline.currentWave++;
              dispatchPipelineWave(dispatch.pipelineId);
            }
          }
        }
      }

      // ── cmd approval relay ─────────────────────────────────────────────────
      if (msgType === "cmd.needs_approval" && env.payload?.approvalId) {
        const { approvalId, agent: approvalAgent, cmd } = env.payload;
        console.log(`[crew-lead] 🔐 cmd approval needed — ${approvalAgent}: ${cmd}`);
        broadcastSSE({ type: "confirm_run_cmd", approvalId, agent: approvalAgent, cmd, ts: Date.now() });
      }
    }
  });

  ws.on("close", () => {
    ready = false;
    rtPublish = null;
    if (crewLeadHeartbeat) { clearInterval(crewLeadHeartbeat); crewLeadHeartbeat = null; }
    console.log("[crew-lead] RT disconnected — reconnecting in 5s");
    setTimeout(connectRT, 5000);
  });

  ws.on("error", (e) => console.error("[crew-lead] RT socket error:", e.message));
}
