#!/usr/bin/env node
/**
 * crew-lead.mjs — Conversational commander (HTTP server)
 *
 * Runs a local HTTP server on port 5010.
 * Receives chat messages, responds via LLM, dispatches tasks to agents.
 * Persistent per-session memory. Standalone — no OpenClaw RT bus needed.
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
  const csCfgPath = path.join(os.homedir(), ".crewswarm", "config.json");
  const ocCfgPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  const cs = tryRead(csCfgPath) || {};
  const oc = tryRead(ocCfgPath) || {};

  const agents = Array.isArray(oc.agents) ? oc.agents : (oc.agents?.list || []);
  const agentCfg = agents.find(a => a.id === "crew-lead");
  const modelString = agentCfg?.model || process.env.CREW_LEAD_MODEL || "groq/llama-3.3-70b-versatile";
  const [providerKey, ...modelParts] = modelString.split("/");
  const modelId = modelParts.join("/");
  const provider = oc?.models?.providers?.[providerKey] || cs?.providers?.[providerKey];

  const knownAgents = agents
    .filter(a => a.id !== "crew-lead")
    .map(a => a.id)
    .filter(Boolean);

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

  return { modelId, providerKey, provider, knownAgents, agentModels };
}

function tryRead(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function getSearchToolsConfig() {
  return tryRead(path.join(os.homedir(), ".openclaw", "search-tools.json")) || {};
}

function getAgentPrompts() {
  return tryRead(path.join(os.homedir(), ".openclaw", "agent-prompts.json")) || {};
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
  const agentList = knownAgents.map(a => "  - " + a).join("\n");
  const modelLine = (cfg.providerKey && cfg.modelId)
    ? `Your name is crew-lead. Your backend model is ${cfg.providerKey}/${cfg.modelId}. When asked "what's your name?" or "what model are you?", answer with this; do not search the web or codebase.`
    : "";
  const agentModels = cfg.agentModels || {};
  const agentModelList = Object.keys(agentModels).length
    ? "Each agent's assigned model (use when asked which models agents run):\n" +
      Object.entries(agentModels).map(([id, model]) => `  - ${id}: ${model}`).join("\n")
    : "";
  const rules = [
    ...(modelLine ? [modelLine, ""] : []),
    ...(agentModelList ? [agentModelList, ""] : []),
    "Available agents (for reference only — do NOT dispatch unless explicitly told to):",
    agentList,
    "",
    "Agent roles:",
    "  - crew-pm: project planning, task breakdown, roadmaps",
    "  - crew-coder / crew-coder-front / crew-coder-back: writing code",
    "  - crew-qa: testing and quality assurance",
    "  - crew-fixer: debugging and fixing bugs",
    "  - crew-security: security audits and review",
    "  - crew-github: git operations, PRs, commits",
    "  - crew-frontend / crew-copywriter: UI components and content",
    "  - crew-main: general orchestration fallback",
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
    "When the user message includes [Web context from Brave Search], use that context to answer current events, docs, or factual lookups when relevant. When it includes [Codebase context from workspace], use it to answer questions about this codebase (where things are, how they work, what a file does).",
    "",
    "- Be concise. Under 2000 chars.",
    "- No filler phrases.",
  ].join("\n");
  const defaultIntro = [
    "You are crew-lead, the conversational commander of the CrewSwarm AI development crew.",
    "",
    "You are primarily a CONVERSATIONAL assistant. Your default is to CHAT.",
    "",
  ].join("\n");
  const intro = customPrompt ? customPrompt + "\n\n" : defaultIntro;
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
  const oc = tryRead(path.join(os.homedir(), ".openclaw", "openclaw.json")) || {};
  const p  = oc.models?.providers || {};
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
// Map<taskId, { sessionId, agent, task, ts }>
const pendingDispatches = new Map();

function dispatchTask(agent, task, sessionId = "owner") {
  if (rtPublish) {
    // Dispatch via own RT connection so agent replies go to: "crew-lead"
    try {
      const taskId = rtPublish({ channel: "command", type: "command.run_task", to: agent, payload: { content: task, prompt: task } });
      if (taskId) pendingDispatches.set(taskId, { sessionId, agent, task, ts: Date.now() });
      console.log(`[crew-lead] dispatched via RT to ${agent} (taskId=${taskId}): ${task.slice(0, 60)}`);
      // Notify UI so it can show a "waiting" spinner for this agent
      broadcastSSE({ type: "agent_working", agent, taskId, sessionId, ts: Date.now() });
      return true;
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
  const dispatch = !projectSpec ? parseDispatch(fullReply, message) : null;
  let cleanReply = stripThink(stripProject(stripDispatch(fullReply)));

  appendHistory(sessionId, "assistant", cleanReply);
  broadcastSSE({ type: "chat_message", sessionId, role: "assistant", content: cleanReply });

  let dispatched = null;
  let pendingProject = null;

  if (projectSpec?.name && projectSpec?.outputDir) {
    try {
      pendingProject = await draftProject(projectSpec, sessionId);
      appendHistory(sessionId, "system", `Roadmap drafted for "${projectSpec.name}" — awaiting user approval.`);
      if (pendingProject) broadcastSSE({ type: "pending_project", sessionId, pendingProject });
    } catch (e) {
      console.error(`[crew-lead] Roadmap draft failed: ${e.message}`);
      appendHistory(sessionId, "system", `Roadmap draft failed: ${e.message}`);
    }
  } else if (dispatch && cfg.knownAgents.includes(dispatch.agent)) {
    const ok = dispatchTask(dispatch.agent, dispatch.task, sessionId);
    if (ok) {
      dispatched = dispatch;
      appendHistory(sessionId, "system", `You dispatched to ${dispatch.agent}: "${(dispatch.task || "").slice(0, 200)}".`);
      // So user always sees dispatch confirmation regardless of LLM wording
      const dispatchLine = rtPublish
        ? `\n\n↳ Dispatched to ${dispatch.agent} — reply will show here when they finish.`
        : `\n\n↳ Dispatched to ${dispatch.agent} (via ctl — check RT Messages tab for reply).`;
      cleanReply = (cleanReply || "").trimEnd() + dispatchLine;
    }
  }

  return { reply: cleanReply, dispatched, pendingProject };
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
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".openclaw", "openclaw.json"), "utf8"))?.env?.OPENCREW_RT_AUTH_TOKEN || "";
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

        // Route completion to the session that dispatched this task, falling back to "owner"
        const taskId = env.taskId || env.correlationId || "";
        const dispatch = pendingDispatches.get(taskId);
        const targetSession = dispatch?.sessionId || "owner";
        if (dispatch) pendingDispatches.delete(taskId);

        // Store up to 2000 chars so crew-lead has full context on next question
        appendHistory(targetSession, "system", `[${from} completed task]: ${content.slice(0, 2000)}`);

        // Resolve the spinner and show the reply bubble in the UI
        broadcastSSE({ type: "agent_reply", from, content: content.slice(0, 2000), sessionId: targetSession, taskId, ts: Date.now() });
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
