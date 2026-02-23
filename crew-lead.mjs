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
    return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.description || ""}\n   ${r.url}`).join("\n\n");
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
    "When the user message includes [Web context from Brave Search], use that context to answer current events, docs, or factual lookups when relevant. When it includes [Codebase context from workspace], use it to answer questions about this codebase (where things are, how they work, what a file does).",
    "",
    "- Be concise. Under 2000 chars.",
    "- No filler phrases.",
  ].join("\n");
  const defaultIntro = [
    `You are ${cfg.emoji} ${cfg.displayName} (agent ID: crew-lead, model: ${cfg.providerKey}/${cfg.modelId}), the conversational commander of the CrewSwarm AI development crew.`,
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

  const needsSearch = messageNeedsSearch(message);
  const [braveResults, codebaseResults] = await Promise.all([
    needsSearch ? searchWithBrave(message) : null,
    needsSearch ? Promise.resolve(searchCodebase(message)) : null,
  ]);
  const parts = [message];
  if (braveResults) parts.push(`[Web context from Brave Search]\n${braveResults}`);
  if (codebaseResults) parts.push(`[Codebase context from workspace]\n${codebaseResults}`);
  const userContent = parts.length > 1 ? parts.join("\n\n") : message;

  const messages = [
    { role: "system", content: buildSystemPrompt(cfg) },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: "user", content: userContent },
  ];

  appendHistory(sessionId, "user", message);
  broadcastSSE({ type: "chat_message", sessionId, role: "user", content: message });

  const fullReply = await callLLM(messages, cfg);

  const projectSpec = parseProject(fullReply);
  const pipelineSteps = !projectSpec ? parsePipeline(fullReply) : null;
  const dispatch = !projectSpec && !pipelineSteps ? parseDispatch(fullReply, message) : null;
  let cleanReply = stripThink(stripPipeline(stripProject(stripDispatch(fullReply))));

  appendHistory(sessionId, "assistant", cleanReply);
  broadcastSSE({ type: "chat_message", sessionId, role: "assistant", content: cleanReply });

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
      const { message, sessionId, firstName } = await readBody(req);
      if (!message) { json(res, 400, { ok: false, error: "message required" }); return; }
      console.log(`[crew-lead] /chat session=${sessionId} msg=${message.slice(0, 60)}`);
      const result = await handleChat({ message, sessionId, firstName });
      json(res, 200, { ok: true, ...result });
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
      const auth = request.headers["authorization"] || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      return RT_TOKEN && token === RT_TOKEN;
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

    // GET /api/agents  — list known agents and their up/down status
    if (url.pathname === "/api/agents" && req.method === "GET") {
      if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized — Bearer token required" }); return; }
      const agents = loadConfig().knownAgents || [];
      json(res, 200, { ok: true, agents });
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
  console.error("[crew-lead] server error:", err.message);
  process.exit(1);
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
    console.log("[crew-lead] RT disconnected — reconnecting in 5s");
    setTimeout(connectRT, 5000);
  });

  ws.on("error", (e) => console.error("[crew-lead] RT socket error:", e.message));
}
