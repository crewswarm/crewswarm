#!/usr/bin/env node
/**
 * PM LOOP — Autonomous "Product Manager" that owns the roadmap and keeps building forever.
 *
 * How it works:
 *   1. Reads website/ROADMAP.md — finds the next unchecked `- [ ]` item
 *   2. Calls Groq PM to expand that item into a precise, scoped coding task
 *   3. Dispatches to crew-coder via gateway-bridge
 *   4. Marks the item `- [x]` in ROADMAP.md when done (or `- [!]` on failure)
 *   5. Every EXTEND_EVERY_N completed items (or when roadmap empties), Groq acts as
 *      "product strategist" — inspects the live website and appends 3–5 new
 *      `- [ ]` items under a "## PM-Generated (Round N)" section.
 *   6. Loops indefinitely — until Stop is pressed, max-items hit, or Groq says "done".
 *
 * To add new work manually: append `- [ ] description` to ROADMAP.md at any time.
 *
 * Usage:
 *   node pm-loop.mjs
 *   node pm-loop.mjs --max-items 50
 *   node pm-loop.mjs --no-extend              (disable self-extending; stop when roadmap empties)
 *   node pm-loop.mjs --dry-run                (show what PM would do, no actual dispatches)
 *   GROQ_API_KEY=xxx node pm-loop.mjs
 *   PM_USE_SPECIALISTS=1 node pm-loop.mjs     (route HTML/CSS → crew-coder-front, JS → crew-coder-back, git → crew-github)
 *   PM_CODER_AGENT=crew-coder-front node pm-loop.mjs  (force all tasks to one specific agent)
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { COORDINATOR_AGENT_IDS } from "./lib/agent-registry.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Args (parsed early so config can reference them) ──────────────────────
const args           = process.argv.slice(2);
const DRY_RUN        = args.includes("--dry-run");
const SELF_EXTEND    = !args.includes("--no-extend");
const EXTEND_EVERY_N = Number(process.env.PM_EXTEND_EVERY || "5");
const maxIdx         = args.indexOf("--max-items");
const MAX_ITEMS      = maxIdx >= 0 ? Number(args[maxIdx + 1]) : 200;
const projDirIdx     = args.indexOf("--project-dir");

// ── Config ────────────────────────────────────────────────────────────────
const CREWSWARM_DIR  = process.env.CREWSWARM_DIR || process.env.OPENCLAW_DIR || __dirname;
const OUTPUT_DIR     = projDirIdx >= 0 ? args[projDirIdx + 1]
                     : (process.env.OPENCREW_OUTPUT_DIR || join(CREWSWARM_DIR, "website"));
const ROADMAP_FILE   = process.env.PM_ROADMAP_FILE || join(OUTPUT_DIR, "ROADMAP.md");
const BRIDGE_PATH    = join(CREWSWARM_DIR, "gateway-bridge.mjs");
const FEATURES_DOC   = process.env.PM_FEATURES_DOC || null;
const LOG_DIR        = join(CREWSWARM_DIR, "orchestrator-logs");
const PM_LOG         = join(LOG_DIR, "pm-loop.jsonl");
// Per-project PID and STOP files — allows multiple projects to run simultaneously
const PROJECT_ID     = process.env.PM_PROJECT_ID || null;
const _pidSuffix     = PROJECT_ID ? `-${PROJECT_ID}` : "";
const STOP_FILE      = join(LOG_DIR, `pm-loop${_pidSuffix}.stop`);
const PID_FILE       = join(LOG_DIR, `pm-loop${_pidSuffix}.pid`);
const TASK_TIMEOUT        = Number(process.env.PHASED_TASK_TIMEOUT_MS  || "300000");
const MAX_CONCURRENT_TASKS = Number(process.env.PM_MAX_CONCURRENT || "20");
const GROQ_API_KEY   = process.env.GROQ_API_KEY || ""; // kept for backwards compat

// ── Search Tools ──────────────────────────────────────────────────────────
function getSearchToolsConfig() {
  const candidates = [
    homedir() + "/.crewswarm/search-tools.json",
    homedir() + "/.openclaw/search-tools.json",
  ];
  for (const p of candidates) {
    try { return JSON.parse(readFileSync(p, "utf8")); } catch {}
  }
  return {};
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
    return results.map((r, i) => `${i+1}. ${r.title}\n   ${r.description || ""}\n   ${r.url}`).join("\n\n");
  } catch { return null; }
}

// Perplexity Sonar Pro — PM orchestrator model with real-time web search
let _ocCfg = null;
function getOCConfig() {
  if (_ocCfg) return _ocCfg;
  const candidates = [
    homedir() + "/.crewswarm/crewswarm.json",
    homedir() + "/.openclaw/openclaw.json",
  ];
  for (const p of candidates) {
    try {
      const cfg = JSON.parse(readFileSync(p, "utf8"));
      if (cfg && typeof cfg === "object") { _ocCfg = cfg; return _ocCfg; }
    } catch {}
  }
  return {};
}
function getPMProviderConfig() {
  const cfg = getOCConfig();
  const providers = { ...(cfg.models?.providers || {}), ...(cfg.providers || {}) };
  const agents = Array.isArray(cfg.agents) ? cfg.agents : (cfg.agents?.list || []);

  // Resolve provider config from an agent's model string (e.g. "perplexity/sonar-pro")
  function fromAgent(agent) {
    if (!agent?.model) return null;
    const [providerKey, ...modelParts] = agent.model.split("/");
    const modelId = modelParts.join("/").trim();
    const prov = providers[providerKey];
    if (!prov?.apiKey || (!prov.baseUrl && providerKey !== "openai")) return null;
    return { baseUrl: prov.baseUrl || "https://api.openai.com/v1", apiKey: prov.apiKey, model: modelId };
  }

  // 1) Orchestrator agent (dashboard "Orchestrator" role) — use this to set PM loop model separately from crew-pm
  const orchestratorAgent = agents.find(a => a.id === "orchestrator");
  const fromOrchestrator = fromAgent(orchestratorAgent);
  if (fromOrchestrator) return fromOrchestrator;

  // 2) crew-pm agent (dashboard "PM" role) — one place for both loop and PM worker if you don't use orchestrator
  const fromPm = fromAgent(agents.find(a => a.id === "crew-pm"));
  if (fromPm) return fromPm;

  // 3) Fallbacks in priority order — free/local first, then paid APIs
  // openai-local: free local models (gpt-5.2-codex etc.) — best for orchestration when server is running
  const localOAI = providers["openai-local"] || cfg.models?.providers?.["openai-local"];
  if (localOAI?.apiKey && localOAI?.baseUrl) return { baseUrl: localOAI.baseUrl, apiKey: localOAI.apiKey, model: "gpt-5.2-codex" };
  // Perplexity Sonar Pro — web-search aware, good for research-heavy roadmaps
  const pplx = providers.perplexity || cfg.models?.providers?.perplexity;
  if (pplx?.apiKey) return { baseUrl: pplx.baseUrl || "https://api.perplexity.ai", apiKey: pplx.apiKey, model: "sonar-pro" };
  // Cerebras — fast inference, strong reasoning
  const cerebras = providers.cerebras || cfg.models?.providers?.cerebras;
  if (cerebras?.apiKey) return { baseUrl: cerebras.baseUrl || "https://api.cerebras.ai/v1", apiKey: cerebras.apiKey, model: "qwen-3-235b-a22b-instruct-2507" };
  if (GROQ_API_KEY) return { baseUrl: "https://api.groq.com/openai/v1", apiKey: GROQ_API_KEY, model: "llama-3.3-70b-versatile" };
  return null;
}
const CODER_AGENT    = process.env.PM_CODER_AGENT || "crew-coder";
// Specialists enabled by default — set PM_USE_SPECIALISTS=0 to disable
const USE_SPECIALISTS = process.env.PM_USE_SPECIALISTS !== "0";
// QA review after each task — set PM_USE_QA=0 to disable
const USE_QA          = process.env.PM_USE_QA !== "0";
// Security audit on security-related tasks — set PM_USE_SECURITY=0 to disable
const USE_SECURITY    = process.env.PM_USE_SECURITY !== "0";

// Role descriptions + routing keywords for well-known agent IDs.
// `role` is used in PM prompts; `keywords` drive the regex fallback when LLM routing fails.
// `nonDoer: true` agents are never assigned implementation tasks.
// New agents in crewswarm.json without an entry here fall back to their identity.theme.
const ROLE_HINTS = {
  "crew-main":        { role: "final synthesizer and verifier — reads all output files, checks coherence, writes FINAL_REPORT.md, gives build verdict", nonDoer: true,  keywords: [] },
  "crew-coder":       { role: "general code, structure, directories, files, setup, create, implement",     nonDoer: false, keywords: ["implement", "create", "build", "file", "module", "class", "function", "script", "python", "ruby", "php", "swift", "kotlin", "go", "rust"] },
  "crew-coder-front": { role: "HTML, CSS, JS UI, visual design, layout, animations, landing pages",        nonDoer: false, keywords: ["html", "css", "style", "section", "design", "layout", "animation", "nav", "hero", "frontend", "ui", "ux", "responsive", "gradient", "transition", "hover", "font", "color", "visual"] },
  "crew-coder-back":  { role: "APIs, Node.js, scripts, databases, backend logic, JSON, server endpoints",  nonDoer: false, keywords: ["api", "server", "node", "express", "endpoint", "database", "backend", "mjs", "rest", "graphql", "sql", "postgres", "mongo", "redis", "lambda", "microservice"] },
  "crew-frontend":    { role: "HTML, CSS, JS UI, visual design, layout, animations, landing pages",        nonDoer: false, keywords: ["html", "css", "style", "design", "layout", "animation", "frontend", "ui", "ux", "responsive"] },
  "crew-github":      { role: "git commits, branches, pull requests, version control, deployment",         nonDoer: false, keywords: ["git", "github", "commit", "push", "pull request", "branch", "merge", "deploy", "release", "tag", "ci", "cd", "workflow"] },
  "crew-qa":          { role: "REVIEW ONLY — testing, validation, QA (never for creating/building)",       nonDoer: true,  keywords: [] },
  "crew-security":    { role: "REVIEW ONLY — security audits, auth flows, secrets (never for creating)",   nonDoer: true,  keywords: [] },
  "crew-copywriter":  { role: "marketing copy, headlines, taglines, CTAs, docs, README",                   nonDoer: false, keywords: ["copy", "headline", "tagline", "cta", "readme", "docs", "documentation", "marketing", "content", "writing", "blog", "landing page text"] },
  "crew-fixer":       { role: "debugging, fixing broken code — dispatched automatically on failure",        nonDoer: true,  keywords: [] },
  "crew-pm":          { role: "project planning, task breakdown, roadmap management",                       nonDoer: true,  keywords: [] },
  "crew-telegram":    { role: "Telegram messaging, notifications — not a task doer",                        nonDoer: true,  keywords: [] },
  "crew-lead":        { role: "team lead, high-level coordination and delegation",                          nonDoer: true,  keywords: [] },
  "orchestrator":     { role: "PM loop orchestrator — internal routing only, not a task doer",              nonDoer: true,  keywords: [] },
  // Extended specialist presets — add these via dashboard and they route correctly automatically
  "crew-devops":      { role: "DevOps, CI/CD, Docker, shell scripts, infrastructure, deployment pipelines", nonDoer: false, keywords: ["docker", "ci", "cd", "pipeline", "deploy", "infrastructure", "terraform", "k8s", "kubernetes", "shell", "bash", "nginx", "linux", "server", "cloud", "aws", "gcp", "azure"] },
  "crew-coder-ios":   { role: "iOS/Swift developer (SwiftUI, UIKit, CoreData, Xcode, Apple platforms)",    nonDoer: false, keywords: ["swift", "swiftui", "uikit", "ios", "xcode", "apple", "iphone", "ipad", "macos", "watchos", "tvos", "coredata", "combine"] },
  "crew-coder-android":{ role: "Android/Kotlin developer (Jetpack Compose, Android SDK, MVVM)",            nonDoer: false, keywords: ["kotlin", "android", "compose", "jetpack", "gradle", "apk", "activity", "fragment", "viewmodel", "coroutine", "flow"] },
  "crew-data":        { role: "Data/analytics specialist (Python, SQL, pandas, data pipelines, charts)",   nonDoer: false, keywords: ["pandas", "sql", "data", "analytics", "csv", "dataframe", "plot", "chart", "matplotlib", "numpy", "jupyter", "pipeline", "etl", "postgres", "sqlite"] },
  "crew-design":      { role: "UI/UX design specs, CSS style guides, component design, animations",        nonDoer: false, keywords: ["design", "ux", "ui", "figma", "spec", "wireframe", "prototype", "component", "style guide", "color", "typography", "spacing"] },
  "crew-pm-agent":    { role: "product planning, feature breakdown, roadmap tasks, project management",    nonDoer: true,  keywords: [] },
  "crew-aiml":        { role: "AI/ML engineer — Python, PyTorch, HuggingFace, embeddings, model training", nonDoer: false, keywords: ["model", "train", "embedding", "inference", "pytorch", "tensorflow", "huggingface", "llm", "neural", "dataset", "fine-tune", "rag", "vector", "ml", "ai"] },
  "crew-api":         { role: "API designer — REST/GraphQL, OpenAPI/Swagger specs, endpoint design",        nonDoer: false, keywords: ["openapi", "swagger", "graphql", "rest", "endpoint", "route", "spec", "api design", "schema", "http"] },
  "crew-database":    { role: "Database specialist — SQL, migrations, indexes, query optimisation",          nonDoer: false, keywords: ["migration", "schema", "index", "postgres", "mysql", "sqlite", "query", "orm", "seed", "table", "column"] },
  "crew-rn":          { role: "React Native specialist — Expo, cross-platform iOS/Android mobile apps",      nonDoer: false, keywords: ["react native", "expo", "rn", "mobile", "navigation", "stylesheet", "platform"] },
  "crew-web3":        { role: "Web3/blockchain — Solidity, smart contracts, ERC20/721, Hardhat, Foundry",   nonDoer: false, keywords: ["solidity", "contract", "blockchain", "web3", "nft", "erc20", "erc721", "hardhat", "foundry", "wagmi", "ethers"] },
  "crew-automation":  { role: "Automation/scraping — Playwright, Puppeteer, Python scrapers, bots",         nonDoer: false, keywords: ["playwright", "puppeteer", "scrape", "scraping", "automation", "bot", "selenium", "crawler", "spider"] },
  "crew-docs":        { role: "Technical docs writer — API docs, README, developer guides, Markdown",        nonDoer: false, keywords: ["readme", "documentation", "docs", "api docs", "guide", "markdown", "wiki", "changelog"] },
};

/**
 * Build a live active agent roster from crewswarm.json.
 * Only includes agents whose provider has a configured API key.
 * Returns: { active: [{id, name, emoji, role, model}], nonDoers: Set<string> }
 */
function buildActiveAgentRoster() {
  const cfg = getOCConfig();
  const providers = { ...(cfg.models?.providers || {}), ...(cfg.providers || {}) };
  const agents = Array.isArray(cfg.agents) ? cfg.agents : (cfg.agents?.list || []);

  function hasKey(agentModel) {
    if (!agentModel) return false;
    const [provKey] = agentModel.split("/");
    const prov = providers[provKey];
    // openai baseUrl can be absent (defaults to api.openai.com), but key must exist
    return !!(prov?.apiKey);
  }

  const active = [];
  const nonDoers = new Set();

  // Always mark known non-doers from ROLE_HINTS
  for (const [id, hint] of Object.entries(ROLE_HINTS)) {
    if (hint.nonDoer) nonDoers.add(id);
  }
  for (const id of COORDINATOR_AGENT_IDS) nonDoers.add(id);

  for (const a of agents) {
    if (!a.id) continue;
    // Skip agents with no model or whose provider has no API key
    if (!hasKey(a.model)) continue;

    const hint = ROLE_HINTS[a.id] || {};
    const name  = a.identity?.name  || a.name  || a.id;
    const emoji = a.identity?.emoji || a.emoji || "";
    // Prefer ROLE_HINTS functional description over cosmetic theme names (e.g. "Violet", "Blueprint")
    const role  = hint.role || a.identity?.theme || "general purpose agent";

    // Mark as non-doer if flagged in ROLE_HINTS or identity/theme says so
    if (hint.nonDoer || /review only|not a.*doer|non.task|internal.*only/i.test(role)) {
      nonDoers.add(a.id);
    }

    active.push({ id: a.id, name, emoji, role, model: a.model });
  }

  return { active, nonDoers };
}

/**
 * Returns a formatted string listing all active agents for injection into the PM system prompt.
 * Tells the PM exactly who is available so it can write tasks targeted at the right specialist.
 */
function buildAgentRoster() {
  const { active, nonDoers } = buildActiveAgentRoster();
  if (!active.length) return "";
  return active
    .map(a => {
      const nd = nonDoers.has(a.id) ? " [review-only, do not assign implementation tasks]" : "";
      return `- ${a.id}${a.emoji ? " " + a.emoji : ""}: ${a.role}${nd}`;
    })
    .join("\n");
}

// Route task to the right specialist agent
// First tries LLM routing (if PM LLM is available), falls back to keyword regex
const _routeCache = new Map();

async function routeAgent(itemText) {
  if (!USE_SPECIALISTS) return CODER_AGENT;

  // Cache: same item text → same agent
  if (_routeCache.has(itemText)) return _routeCache.get(itemText);

  // Try LLM routing first
  const provider = getPMProviderConfig();
  if (provider) {
    try {
      const { active, nonDoers } = buildActiveAgentRoster();
      // Doable agents = active agents that are not non-doers
      const doable = active.filter(a => !nonDoers.has(a.id));
      const valid   = active.map(a => a.id);

      const agentLines = active.map(a =>
        `${a.emoji ? a.emoji + " " : ""}${a.id}${nonDoers.has(a.id) ? " [REVIEW ONLY — do not choose for implementation]" : ""} — ${a.name}: ${a.role}`
      ).join("\n");

      const doableIds = doable.map(a => a.id).join(", ");

      const result = await callPMLLM([
        {
          role: "system",
          content: `You are a task router. Given a software task description, output EXACTLY ONE agent ID — nothing else.

Active agents (from live config — only these are available):
${agentLines}

Rules:
- For tasks that CREATE or IMPLEMENT: choose from these doable agents only: ${doableIds}
- Agents marked [REVIEW ONLY] are dispatched automatically by the system — never choose them
- Output ONLY the agent ID (e.g. crew-coder-front). No explanation.`,
        },
        { role: "user", content: `Task: "${itemText}"` },
      ], { maxTokens: 20, temperature: 0 });

      const agent = (result || "").trim().toLowerCase().replace(/[^a-z-]/g, "");
      if (valid.includes(agent)) {
        _routeCache.set(itemText, agent);
        return agent;
      }
    } catch {
      // fall through to keyword routing
    }
  }

  // Fallback: keyword regex
  const t = itemText.toLowerCase();
  let agent;
  if (/\bgit\b|github|commit|push|pull.request|branch|deploy/.test(t)) agent = "crew-github";
  else if (/\bapi\b|server|node|express|script|endpoint|json|database|backend|mjs|\.js\b/.test(t)) agent = "crew-coder-back";
  else if (/html|css|style|section|design|layout|animation|nav|hero|frontend|ui\b|ux\b|responsive/.test(t)) agent = "crew-coder-front";
  else agent = CODER_AGENT;

  // Safety: never use non-doer agents as doer via keyword fallback — built dynamically from config
  const { nonDoers: NON_DOERS } = buildActiveAgentRoster();
  if (NON_DOERS.has(agent)) agent = CODER_AGENT;

  _routeCache.set(itemText, agent);
  return agent;
}

// Determine if task needs a security review
function needsSecurityReview(itemText) {
  if (!USE_SECURITY) return false;
  const t = itemText.toLowerCase();
  return /auth|login|password|token|secret|key|api.key|env|permission|access|inject|xss|csrf|sanitiz/.test(t);
}

// Determine if task needs a copywriter pass before coding
function needsCopywriter(itemText) {
  const t = itemText.toLowerCase();
  return /headline|hero|copy|cta|tagline|subheading|testimonial|social proof|value prop|description|landing|about|message|tone|voice|wording|slogan|pitch/.test(t);
}

// Call copywriter agent and return enriched task with copy included
async function runCopywriterPass(itemText, task) {
  const cfg = getOCConfig();
  const mistral = cfg.models?.providers?.mistral;
  if (!mistral?.apiKey) return task; // no key — skip

  const agentPrompts = (() => {
    for (const p of [homedir() + "/.crewswarm/agent-prompts.json", homedir() + "/.openclaw/agent-prompts.json"]) {
      try { return JSON.parse(readFileSync(p, "utf8")); } catch {}
    }
    return {};
  })();
  const copywriterPrompt = agentPrompts["copywriter"] || "You are a conversion copywriter for developer tools. Write punchy, specific copy.";

  // Brave search gives copywriter real-world context — competitor copy, trending phrases, tone refs
  let webContext = "";
  const braveResults = await searchWithBrave(`${itemText} copywriting examples landing page`);
  if (braveResults) {
    webContext = `\n\nWeb research for copy inspiration (Brave Search):\n${braveResults}`;
    console.log(`  🦁 Brave search injected for copywriter`);
  }

  console.log(`  ✍️  Copywriter pass for: ${itemText.slice(0, 60)}...`);
  try {
    const resp = await fetch(`${mistral.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${mistral.apiKey}` },
      body: JSON.stringify({
        model: "mistral-large-latest",
        messages: [
          { role: "system", content: copywriterPrompt },
          { role: "user", content: `Write the copy for this task:\n\n"${itemText}"\n\nThe coder will implement your copy. Output labeled copy only (Headline:, Body:, CTA: etc). Be clear and specific.${webContext}` }
        ],
        max_tokens: 400,
        temperature: 0.6,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await resp.json();
    const copy = data?.choices?.[0]?.message?.content?.trim();
    if (!copy) return task;
    console.log(`  ✍️  Copy ready:\n    ${copy.slice(0, 120).replace(/\n/g, " ")}...`);
    return `${task}\n\nCOPYWRITER PASS — use this exact copy in the HTML (do not change the wording):\n${copy}`;
  } catch (e) {
    console.warn(`  ⚠️  Copywriter pass failed: ${e.message.slice(0, 60)} — proceeding without`);
    return task;
  }
}
const BETWEEN_TASKS  = Number(process.env.PM_PAUSE_MS || "5000");

if (!existsSync(LOG_DIR)) await mkdir(LOG_DIR, { recursive: true });

// ── PID file — prevents duplicate processes ───────────────────────────────
async function writePid() {
  await writeFile(PID_FILE, String(process.pid), "utf8").catch(() => {});
}
async function clearPid() {
  const { unlink } = await import("node:fs/promises");
  await unlink(PID_FILE).catch(() => {});
}
// Clean up PID on any exit
process.on("exit",    () => { try { require("node:fs").unlinkSync(PID_FILE); } catch {} });
process.on("SIGTERM", async () => { await clearPid(); process.exit(0); });
process.on("SIGINT",  async () => { await clearPid(); process.exit(0); });

// ── Logging ───────────────────────────────────────────────────────────────
async function log(entry) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
  await appendFile(PM_LOG, line + "\n").catch(() => {});
}

function banner(msg) { console.log(`\n${"─".repeat(60)}\n  ${msg}\n${"─".repeat(60)}`); }

// ── Roadmap parsing ───────────────────────────────────────────────────────
function parseRoadmap(content) {
  const lines = content.split("\n");
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(-\s+)\[( |x|!)\]\s+(.+)$/);
    if (m) {
      items.push({
        lineIdx: i,
        raw: lines[i],
        prefix: m[1],
        status: m[2] === " " ? "pending" : m[2] === "x" ? "done" : "failed",
        text: m[3].trim(),
      });
    }
  }
  return { lines, items };
}

// Max times to retry a failed item before giving up permanently
const MAX_RETRIES = Number(process.env.PM_MAX_RETRIES || "2");

function retryCount(rawLine) {
  const m = rawLine.match(/✗\s+\d+:\d+:\d+/g);
  return m ? m.length : 0;
}

function nextPending(items) {
  // First: pick any truly pending item
  const pending = items.find(it => it.status === "pending");
  if (pending) return pending;
  // Second: retry failed items that haven't hit MAX_RETRIES yet
  return items.find(it => it.status === "failed" && retryCount(it.raw) < MAX_RETRIES) || null;
}

async function markItem(lineIdx, status, agent = null) {
  const content = await readFile(ROADMAP_FILE, "utf8");
  const lines = content.split("\n");
  const ts = new Date().toLocaleTimeString();
  if (status === "done") {
    // Mark done — replace any [ ] or [!] marker
    lines[lineIdx] = lines[lineIdx].replace(/\[[ !]\]/, "[x]");
    lines[lineIdx] += `  ✓ ${ts}`;
    if (agent) lines[lineIdx] += ` (${agent})`;
  } else {
    // Mark failed — keep [!] marker, append another ✗ timestamp for retry tracking
    lines[lineIdx] = lines[lineIdx].replace(/\[ \]/, "[!]");
    lines[lineIdx] += `  ✗ ${ts}`;
  }
  await writeFile(ROADMAP_FILE, lines.join("\n"), "utf8");
}

// ── PM LLM: shared caller — Perplexity Sonar Pro with web search ─────────
async function callPMLLM(messages, { maxTokens = 400, temperature = 0.3 } = {}) {
  const provider = getPMProviderConfig();
  if (!provider) return null;

  const isPerplexity = provider.baseUrl.includes("perplexity");
  const body = {
    model: provider.model,
    messages,
    max_tokens: maxTokens,
    temperature,
    ...(isPerplexity ? { search_recency_filter: "month" } : {}),
  };

  const resp = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${provider.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

// ── PM: turn a roadmap item into a precise coding task ────────────────────
async function expandWithGroq(item, context) {
  const provider = getPMProviderConfig();
  const isPerplexity = provider?.baseUrl?.includes("perplexity");

  if (!provider) {
    const fallbackTask = `Task: ${item}

Output directory: ${OUTPUT_DIR}

WORKFLOW — follow this every time:
1. READ the relevant existing files in ${OUTPUT_DIR} to understand current structure
2. Make targeted edits only — do NOT rewrite entire files
3. READ the file again after each edit to verify the change was applied correctly
4. If a follow-up fix is needed, apply it and read again to confirm
5. If this task is already complete, reply "ALREADY DONE: <reason>" and stop`;
    return { targetAgent: null, task: item, files: null, successCriteria: null, raw: fallbackTask, taskText: fallbackTask };
  }

  const featuresSnippet = FEATURES_DOC ? (() => { try { return readFileSync(FEATURES_DOC, "utf8").slice(0, 800); } catch { return ""; } })() : "";

  // Brave search for non-Perplexity providers — gives Groq/Cerebras fresh web context
  let webSnippet = "";
  if (!isPerplexity) {
    const searchResults = await searchWithBrave(`best practices: ${item}`);
    if (searchResults) {
      webSnippet = `\n\nWeb research (Brave Search):\n${searchResults}`;
      console.log(`  🦁 Brave search injected for PM context`);
    }
  }

  const mainDeliverable = getMainDeliverableHint();
  const mainDeliverableRule = mainDeliverable
    ? `\n- MAIN DELIVERABLE: For styling, CSS, animations, gradients, visual effects, and any user-visible changes, require the coder to apply them to this file: ${mainDeliverable}. Do not accept updates only to templates or other files — the main deliverable must include the requested features so users see them when they open it.`
    : "\n- For styling, CSS, animations, and visual effects: require the coder to apply changes to the main user-facing HTML file (e.g. index.html or the primary page in the output dir), not only to templates or secondary files. The file users actually open must contain the requested features.";

  const agentRoster = buildAgentRoster();
  // Build routing hints dynamically from the active roster so new agents are included automatically
  const { active: rosterActive, nonDoers: rosterNonDoers } = buildActiveAgentRoster();
  const doableAgents = rosterActive.filter(a => !rosterNonDoers.has(a.id));
  const dynamicHints = doableAgents.length
    ? doableAgents.map(a => `- ${a.role} → ${a.id}`).join("\n")
    : "";
  const rosterBlock = agentRoster
    ? `\n\nAvailable specialist agents — route your task to the right one:\n${agentRoster}${dynamicHints ? `\n\nRouting hints (match the task to the best agent):\n${dynamicHints}` : ""}\n- [review-only] agents must NOT be given implementation work`
    : "";

  const isFrontendTask = /animat|css|style|visual|gradient|transition|ui\b|front.?end|html|layout|design|color|font|effect|scroll|fade|hover/i.test(item);
  const frontendRule = isFrontendTask
    ? "\n- This is a visual/frontend task: spell out the exact CSS or JS needed (e.g. 'add CSS keyframe animation for X', 'use IntersectionObserver for scroll-triggered fade-in') — do not leave it vague or it will be skipped"
    : "";

  const systemPrompt = `You are the PM (Product Manager) for a software project.${isPerplexity ? " You have real-time web search — use it to research best practices and modern approaches relevant to the task." : " Web search results will be provided for context."}

Your job: receive a roadmap item and output a precise, scoped coding task in the STRICT schema below.

Project output directory: ${OUTPUT_DIR}${rosterBlock}

Rules:
- ONE deliverable only — no multi-step tasks. No new scope: implement only what the roadmap item says; do NOT add features or expand scope unless the item explicitly says to "expand", "also add", or "include additional".
- Specify exact file paths using the output dir above
- CRITICAL: Always tell the coder to READ existing files first, then MODIFY/APPEND — NEVER overwrite a whole file unless it's brand new
- If something already exists and satisfies the item, tell coder to SKIP and report done
- Every task MUST include acceptance: what file(s) must exist or what behavior must pass for the task to be done
- Output ONLY the following schema (no preamble, no explanation):

TARGET_AGENT: <agent id from roster, e.g. crew-coder or crew-coder-front>
TASK: <precise task text, under 200 words>
FILES: <paths to create or modify relative to output dir, e.g. index.html, style.css>
SUCCESS_CRITERIA: <what file(s) must exist and/or what must pass — e.g. "File X exists with Y; running Z succeeds">${frontendRule}${mainDeliverableRule}${featuresSnippet ? `\n\nProject context:\n${featuresSnippet}` : ""}`;

  const mainHint = mainDeliverable ? `\nMain deliverable file (apply styling/animations here): ${mainDeliverable}\n` : "";
  const userPrompt = `Roadmap item: "${item}"
${mainHint}
Current project state:
${context}${webSnippet}

${isPerplexity ? "Search for best practices relevant to this task, then output" : "Output"} ONLY the four lines: TARGET_AGENT:, TASK:, FILES:, SUCCESS_CRITERIA:`;

  const contextRules = `

---
WORKFLOW — follow this every time:
1. READ the relevant existing files in ${OUTPUT_DIR} to understand current structure
2. Make targeted edits only — do NOT rewrite entire files
3. READ the file again after each edit to verify the change was applied correctly
4. If a follow-up fix is needed, apply it and read again to confirm
5. If this task is already complete, reply "ALREADY DONE: <reason>" and stop`;

  try {
    const result = await callPMLLM(
      [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      { maxTokens: 380, temperature: 0.3 }
    );
    const raw = (result || "").trim() || item;
    // Parse strict schema so caller can use TARGET_AGENT, FILES, SUCCESS_CRITERIA
    const targetMatch = raw.match(/TARGET_AGENT:\s*(\S+)/i);
    const taskMatch = raw.match(/TASK:\s*([\s\S]*?)(?=FILES:|SUCCESS_CRITERIA:|$)/i);
    const filesMatch = raw.match(/FILES:\s*([\s\S]*?)(?=SUCCESS_CRITERIA:|$)/i);
    const criteriaMatch = raw.match(/SUCCESS_CRITERIA:\s*([\s\S]*?)(?=\n\n|$)/i);
    const parsed = {
      targetAgent: targetMatch ? targetMatch[1].trim() : null,
      task: (taskMatch ? taskMatch[1].trim() : raw).replace(/\n+$/, ""),
      files: filesMatch ? filesMatch[1].trim() : null,
      successCriteria: criteriaMatch ? criteriaMatch[1].trim() : null,
      raw,
    };
    const taskText = parsed.task
      + (parsed.files ? `\n\nFiles: ${parsed.files}` : "")
      + (parsed.successCriteria ? `\n\nAcceptance: ${parsed.successCriteria}` : "")
      + contextRules;
    return { ...parsed, taskText };
  } catch (e) {
    console.warn(`  ⚠ PM LLM failed (${e.message}), using raw item`);
    return { targetAgent: null, task: item, files: null, successCriteria: null, raw: item, taskText: item + contextRules };
  }
}

async function getProjectContext() {
  if (!existsSync(OUTPUT_DIR)) return `(output dir ${OUTPUT_DIR} does not exist yet)`;
  const { readdir, stat } = await import("node:fs/promises");
  const TRACKED_EXT = new Set([".html",".css",".js",".mjs",".ts",".json",".md",".py",".sh",".yaml",".yml",".go",".rs"]);
  const files = [];
  async function scan(dir, depth = 0) {
    if (depth > 3) return;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".") || e.name === "node_modules") continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) { await scan(full, depth + 1); }
        else if (TRACKED_EXT.has(e.name.slice(e.name.lastIndexOf(".")))) {
          const st = await stat(full).catch(() => null);
          if (st) files.push({ path: full.replace(OUTPUT_DIR + "/", ""), size: st.size });
        }
      }
    } catch { /* skip unreadable dirs */ }
  }
  await scan(OUTPUT_DIR);
  if (!files.length) return `(output dir exists but contains no tracked files yet)`;
  const summary = files.slice(0, 20).map(f => `${f.path} (${Math.round(f.size/1024)}KB)`).join(", ");
  return `${files.length} file(s) in ${OUTPUT_DIR}: ${summary}${files.length > 20 ? ` ... and ${files.length-20} more` : ""}`;
}

/** Infer main user-facing HTML file so PM can require styling/animations there (not only in templates). */
function getMainDeliverableHint() {
  if (!existsSync(OUTPUT_DIR)) return null;
  try {
    const entries = readdirSync(OUTPUT_DIR, { withFileTypes: true });
    const indexHtml = entries.find(e => e.isFile() && e.name === "index.html");
    if (indexHtml) return join(OUTPUT_DIR, "index.html");
    const htmlFiles = entries.filter(e => e.isFile() && e.name.endsWith(".html"));
    if (htmlFiles.length) return join(OUTPUT_DIR, htmlFiles[0].name);
    const testOutput = entries.find(e => e.isDirectory() && e.name === "test-output");
    if (testOutput) {
      const sub = readdirSync(join(OUTPUT_DIR, "test-output"), { withFileTypes: true });
      const first = sub.find(e => e.isFile() && e.name.endsWith(".html"));
      if (first) return join(OUTPUT_DIR, "test-output", first.name);
    }
  } catch {}
  return null;
}

/** Return list of absolute paths for files in OUTPUT_DIR (for QA so it only reads paths that exist). */
async function getOutputDirFilePaths() {
  if (!existsSync(OUTPUT_DIR)) return [];
  const { readdir } = await import("node:fs/promises");
  const TRACKED_EXT = new Set([".html",".css",".js",".mjs",".ts",".json",".md",".py",".sh",".yaml",".yml",".go",".rs"]);
  const out = [];
  async function scan(dir, depth = 0) {
    if (depth > 3) return;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".") || e.name === "node_modules") continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) await scan(full, depth + 1);
        else if (TRACKED_EXT.has(e.name.slice(e.name.lastIndexOf(".")))) out.push(full);
      }
    } catch {}
  }
  await scan(OUTPUT_DIR);
  return out;
}

// ── PM: self-extend — generates new roadmap items from live site ─────────
async function generateNewRoadmapItems(context, completedItems, round) {
  const label = `PM-Generated (Round ${round})`;
  const provider = getPMProviderConfig();
  const isPerplexity = provider?.baseUrl?.includes("perplexity");

  if (!provider) {
    console.log("  💡 No PM LLM configured — appending generic improvement items");
    return [
      "Improve typography: add font-weight hierarchy and tighter line-height for all headings",
      "Add aria-label attributes to all interactive elements for accessibility",
      "Add a 'Back to top' floating button that appears after scrolling 300px",
    ];
  }

  const recentDone = completedItems.slice(-10).map(i => `- ${i}`).join("\n");

  const featuresSnippet = FEATURES_DOC ? await readFile(FEATURES_DOC, "utf8").catch(() => "").then(t => t.substring(0, 1500)) : "";

  // Brave search for non-Perplexity providers — fresh web context for self-extend
  let extendWebSnippet = "";
  if (!isPerplexity) {
    const q = `best practices modern web project improvements 2026`;
    const searchResults = await searchWithBrave(q);
    if (searchResults) {
      extendWebSnippet = `\n\nWeb research (Brave Search):\n${searchResults}`;
      console.log(`  🦁 Brave search injected for self-extend`);
    }
  }

  const systemPrompt = `You are a senior product manager for a software project.${isPerplexity ? " You have real-time web search — use it to research current best practices." : " Web search results are provided below for context."}

Your job: decide what to build next to make the project more complete, robust, and high quality.

Project output directory: ${OUTPUT_DIR}

Rules:
- Generate exactly 4 new roadmap items
- Each item is ONE specific, self-contained deliverable for a coder agent
- Items must be meaningfully distinct from what is already done
- Vary between: new features, polish, tests, accessibility, performance, documentation
- Format: plain sentence describing exactly what to add/change (no markdown bullets, no numbering)
- Output ONLY the 4 items, one per line, nothing else${featuresSnippet ? `\n\nProject context:\n${featuresSnippet}` : ""}`;

  const userPrompt = `Current project state:
${context}

Recently completed items:
${recentDone}
${extendWebSnippet}

${isPerplexity ? "Search for relevant best practices, then generate" : "Generate"} 4 new roadmap items that would meaningfully improve this project:`;

  try {
    const resp = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userPrompt },
        ],
        max_tokens: 400,
        temperature: 0.7,
        ...(isPerplexity ? { search_recency_filter: "month" } : {}),
      }),
      signal: AbortSignal.timeout(60000),
    });
    const data = await resp.json();
    const raw = data.choices?.[0]?.message?.content?.trim() || "";
    const items = raw.split("\n").map(l => l.trim()).filter(l => l.length > 10 && !l.startsWith("#"));
    const exactly4 = items.slice(0, 4);
    if (exactly4.length !== 4) {
      console.warn(`  ⚠ PM self-extend returned ${exactly4.length} items (expected 4); using ${exactly4.length} item(s)`);
    }
    return exactly4;
  } catch (e) {
    console.warn(`  ⚠ PM LLM self-extend failed (${e.message})`);
    return [];
  }
}

async function appendGeneratedItems(newItems, round) {
  if (!newItems.length) return;
  const content = await readFile(ROADMAP_FILE, "utf8");
  const section = `\n---\n\n## PM-Generated (Round ${round})\n\n` +
    newItems.map(item => `- [ ] ${item}`).join("\n") + "\n";
  await writeFile(ROADMAP_FILE, content + section, "utf8");
  console.log(`  📝 Appended ${newItems.length} new items to roadmap (Round ${round})`);
  for (const item of newItems) console.log(`     • ${item.substring(0, 80)}`);
}

// ── Final synthesis: crew-main audits, then assembles/patches the full build ──
async function finalSynthesis(opId, completedItems, doneCount, failedCount) {
  if (doneCount === 0) return;
  banner("🦊 crew-main (Quill) — Phase 1: Audit");

  let filePaths = [];
  try { filePaths = await getOutputDirFilePaths(); } catch {}
  const fileManifest = filePaths.length > 0
    ? filePaths.map(f => `  - ${f}`).join("\n")
    : "(no output files found)";
  const taskSummary = completedItems.map((t, i) => `  ${i + 1}. ${t.substring(0, 120)}`).join("\n");

  // ── Phase 1: Audit — read all files, find disconnects ──────────────────
  const auditPrompt = `[SYNTHESIS-AUDIT] You are Quill, the final assembler. All workers have finished. Your job is to audit the full build and find every broken seam.

## Build summary
${doneCount} tasks done, ${failedCount} failed.

## Tasks completed
${taskSummary}

## Output files
${fileManifest}

## Phase 1 instructions — do ALL of this now:

1. Use @@READ_FILE on EVERY file listed above (skip images/fonts/binaries). Read them all.

2. For each file, check:
   - Does it reference other files that exist? (imports, src=, href=, require(), fetch URLs)
   - Are those referenced files actually present?
   - Are function/class names consistent across files?
   - Any duplicate or conflicting logic between files?
   - Any TODO/FIXME/placeholder left by workers?

3. Build a DISCONNECT LIST — every broken seam you found. Format exactly like:
   DISCONNECT: <file> references <thing> which <problem>
   Example: DISCONNECT: index.html references /api/submit but no server file defines that route

4. Write @@WRITE_FILE output/FINAL_REPORT.md with:
   - Build summary (1 paragraph)
   - Full disconnect list
   - Weakest file / biggest risk
   - Verdict: SHIP IT / NEEDS WORK / DO NOT SHIP

5. End your reply with the word AUDIT_DONE so Phase 2 knows you finished.

Start reading files now. Be exhaustive.`;

  let auditResult = "";
  try {
    console.log("  🦊 Quill auditing all output files...");
    auditResult = await callAgent("crew-main", auditPrompt, { timeout: TASK_TIMEOUT * 3 });
    console.log(`  ✅ Audit done: ${String(auditResult).substring(0, 150)}...`);
    await log({ op_id: opId, event: "synthesis_audit_done", agent: "crew-main", result: String(auditResult).substring(0, 500) });
  } catch (e) {
    console.log(`  ⚠️  Audit failed: ${e.message.slice(0, 80)}`);
    await log({ op_id: opId, event: "synthesis_audit_failed", error: e.message });
    return;
  }

  // Extract disconnects — if none found, skip assembly phase
  const hasDisconnects = /DISCONNECT:/i.test(auditResult);
  const verdict = /SHIP IT/i.test(auditResult) ? "SHIP IT" : /DO NOT SHIP/i.test(auditResult) ? "DO NOT SHIP" : "NEEDS WORK";
  console.log(`  📋 Verdict: ${verdict} | Disconnects found: ${hasDisconnects ? "YES — running assembly pass" : "none"}`);

  if (!hasDisconnects && verdict === "SHIP IT") {
    console.log("  ✅ Build is clean — no assembly pass needed.");
    await log({ op_id: opId, event: "synthesis_clean", verdict });
    return;
  }

  // ── Phase 2: Assembly — fix every disconnect found in Phase 1 ───────────
  banner("🦊 crew-main (Quill) — Phase 2: Assembly & Patching");

  const assemblyPrompt = `[SYNTHESIS-ASSEMBLY] You are Quill. Your Phase 1 audit found issues that need fixing before this build ships.

## Audit findings
${auditResult.substring(0, 3000)}

## Phase 2 instructions — patch every disconnect now:

For each DISCONNECT you found:

1. Use @@READ_FILE to re-read the affected files if needed for full context.

2. Determine the minimal targeted fix:
   - Wrong import path → fix the import line only
   - Missing route → add the route to the server file
   - Mismatched function name → rename the call site to match the definition
   - Missing file referenced → create it with @@WRITE_FILE
   - Placeholder/TODO left → implement it

3. Apply the fix with @@WRITE_FILE — write the COMPLETE corrected file content (not a diff, the full file).

4. After all fixes, update @@WRITE_FILE output/FINAL_REPORT.md — append a section:
   ## Assembly Pass
   - List each fix you made (file + what changed)
   - Updated verdict: SHIP IT / NEEDS WORK / DO NOT SHIP

5. Reply with a sharp summary: what you fixed, what still needs human attention, final verdict.

Fix everything you can. If a disconnect is too complex to safely patch (e.g., full architectural mismatch), document it clearly in the report instead of guessing.`;

  try {
    console.log("  🦊 Quill patching disconnects...");
    const assemblyResult = await callAgent("crew-main", assemblyPrompt, { timeout: TASK_TIMEOUT * 4 });
    console.log(`  ✅ Assembly complete:\n  ${String(assemblyResult).substring(0, 200)}`);
    await log({ op_id: opId, event: "synthesis_assembly_done", agent: "crew-main", result: String(assemblyResult).substring(0, 500) });
  } catch (e) {
    console.log(`  ⚠️  Assembly pass failed: ${e.message.slice(0, 80)}`);
    await log({ op_id: opId, event: "synthesis_assembly_failed", error: e.message });
  }
}

// ── Concurrency semaphore ─────────────────────────────────────────────────
let _activeTasks = 0;
const _taskQueue = [];
function acquireSlot() {
  if (_activeTasks < MAX_CONCURRENT_TASKS) {
    _activeTasks++;
    return Promise.resolve();
  }
  return new Promise(resolve => _taskQueue.push(resolve));
}
function releaseSlot() {
  if (_taskQueue.length > 0) {
    _taskQueue.shift()();
  } else {
    _activeTasks--;
  }
}

// ── Agent dispatch ────────────────────────────────────────────────────────
async function callAgent(agentId, message, { timeout } = {}) {
  await acquireSlot();
  try {
    return await _callAgentRaw(agentId, message, { timeout });
  } finally {
    releaseSlot();
  }
}
function _callAgentRaw(agentId, message, { timeout } = {}) {
  // Non-doers (QA, fixer, security) get extra time — they read files and do analysis
  const { nonDoers: timeoutNonDoers } = buildActiveAgentRoster();
  const agentTimeout = timeout || (timeoutNonDoers.has(agentId) ? TASK_TIMEOUT * 2 : TASK_TIMEOUT);
  const env = {
    ...process.env,
    OPENCREW_RT_SEND_TIMEOUT_MS: String(agentTimeout),
  };
  // So crew-main synthesis runs in OpenCode with the PM output dir (gateway-bridge --send reads this and puts it in payload.projectDir)
  if (agentId === "crew-main") env.OPENCREW_OPENCODE_PROJECT = OUTPUT_DIR;
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [BRIDGE_PATH, "--send", agentId, message], {
      stdio: ["inherit", "pipe", "pipe"],
      env,
    });
    let out = "", err = "";
    proc.stdout?.on("data", d => { out += d; });
    proc.stderr?.on("data", d => { err += d; });
    const timer = setTimeout(() => { proc.kill("SIGTERM"); reject(new Error(`Timeout ${TASK_TIMEOUT}ms`)); }, TASK_TIMEOUT);
    proc.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(err || out || `exit ${code}`));
      else resolve(out.trim() || err.trim());
    });
  });
}

// ── Main loop ─────────────────────────────────────────────────────────────
async function main() {
  const opId = `pm-${randomUUID().slice(0, 8)}`;

  banner(`PM LOOP  op=${opId}  max=${MAX_ITEMS}${DRY_RUN ? "  DRY RUN" : ""}${SELF_EXTEND ? `  self-extend every ${EXTEND_EVERY_N}` : "  no-extend"}`);
  console.log(`Roadmap: ${ROADMAP_FILE}`);
  console.log(`Output:  ${OUTPUT_DIR}`);
  const roster = buildAgentRoster();
  if (roster) {
    console.log(`Agents (from config):\n${roster.split("\n").map(l => "  " + l).join("\n")}`);
  } else {
    console.log(`Agents:  ${USE_SPECIALISTS ? "crew-coder-front (HTML/CSS) | crew-coder-back (JS/API) | crew-github (git) | crew-coder (default)" : CODER_AGENT}`);
  }
  console.log(`QA:      ${USE_QA ? "crew-qa reviews after each task" : "disabled (PM_USE_QA=0)"}`);
  console.log(`Fixer:   crew-fixer auto-repairs failed tasks`);
  console.log(`Security:${USE_SECURITY ? " security agent reviews auth/key tasks" : " disabled (PM_USE_SECURITY=0)"}`);
  const pmProv = getPMProviderConfig();
  const pmProvLabel = pmProv?.baseUrl?.includes("127.0.0.1") || pmProv?.baseUrl?.includes("localhost")
                    ? `openai-local ${pmProv.model} (free/local)`
                    : pmProv?.baseUrl?.includes("perplexity") ? `Perplexity ${pmProv.model} (web search ✓)`
                    : pmProv?.baseUrl?.includes("cerebras")   ? `Cerebras ${pmProv.model}`
                    : pmProv?.baseUrl?.includes("openai")     ? `OpenAI ${pmProv.model}`
                    : pmProv ? `${pmProv.model}` : "none — raw item text";
  console.log(`PM LLM:  ${pmProvLabel}`);
  console.log(`Extend:  ${SELF_EXTEND ? `every ${EXTEND_EVERY_N} completions OR when roadmap empties` : "disabled (--no-extend)"}`);
  console.log(`\nTip: touch ${STOP_FILE} to stop gracefully between tasks\n`);

  if (!existsSync(ROADMAP_FILE)) {
    console.error(`❌ ROADMAP.md not found at ${ROADMAP_FILE}`);
    process.exit(1);
  }

  await writePid();
  await log({ op_id: opId, event: "start", dry_run: DRY_RUN, self_extend: SELF_EXTEND, max_items: MAX_ITEMS, pid: process.pid });

  let itemCount   = 0;
  let doneCount   = 0;
  let extendRound = 0;
  const completedItems = [];  // rolling list of done item texts for Groq context

  while (itemCount < MAX_ITEMS) {
    // Graceful stop
    if (existsSync(STOP_FILE)) {
      console.log("\n⛔ Stop file detected — exiting gracefully.");
      await log({ op_id: opId, event: "stopped_by_file" });
      break;
    }

    const roadmapContent = await readFile(ROADMAP_FILE, "utf8");
    const { items } = parseRoadmap(roadmapContent);
    const item = nextPending(items);

    const total   = items.length;
    const done    = items.filter(i => i.status === "done").length;
    const failed  = items.filter(i => i.status === "failed").length;
    const pending = items.filter(i => i.status === "pending").length;

    console.log(`\n📋 Roadmap: ${done}/${total} done, ${failed} failed, ${pending} pending`);

    // ── Self-extend: roadmap exhausted or every N completions ────────────
    if (SELF_EXTEND && !DRY_RUN && (!item || (doneCount > 0 && doneCount % EXTEND_EVERY_N === 0 && pending === 0))) {
      extendRound++;
      console.log(`\n🧠 PM self-extend round ${extendRound} — generating new roadmap items...`);
      const context = await getProjectContext();
      const newItems = await generateNewRoadmapItems(context, completedItems, extendRound);
      if (newItems.length > 0) {
        await appendGeneratedItems(newItems, extendRound);
        await log({ op_id: opId, event: "self_extend", round: extendRound, new_items: newItems.length });
        // Reset doneCount so next extend fires after another EXTEND_EVERY_N completions
        doneCount = 0;
        continue;  // re-enter loop to pick up new items
      } else if (!item) {
        // No new items generated and nothing pending — we're genuinely done
        banner("🏁 Roadmap exhausted and PM has no new ideas — build complete!");
        await log({ op_id: opId, event: "all_done", total, done });
        break;
      }
    }

    if (!item) {
      if (!SELF_EXTEND) {
        banner("🏁 All roadmap items complete!");
        await log({ op_id: opId, event: "all_done", total, done });
      }
      break;
    }

    itemCount++;
    console.log(`\n[${itemCount}/${MAX_ITEMS}] Next item:\n  "${item.text}"`);

    const context = await getProjectContext();
    console.log(`  Website state: ${context}`);

    let task;
    if (DRY_RUN) {
      task = `[DRY RUN] Would dispatch: ${item.text}`;
      console.log(`  📝 Task (dry run):\n    ${task}`);
      await log({ op_id: opId, item: item.text, status: "dry_run" });
      await markItem(item.lineIdx, "done");
      await new Promise(r => setTimeout(r, 300));
      continue;
    }

    console.log("  🤔 PM expanding item into task...");
    const expanded = await expandWithGroq(item.text, context);
    task = expanded.taskText;
    console.log(`  📝 Task:\n    ${task.substring(0, 120)}${task.length > 120 ? "..." : ""}`);

    let targetAgent = expanded.targetAgent || (await routeAgent(item.text));
    // QA and security are review-only — never send implementation tasks to them as doer
    // Never use non-doer agents as the primary task doer — derived live from config
    const { nonDoers: dynamicNonDoers } = buildActiveAgentRoster();
    if (dynamicNonDoers.has(targetAgent)) {
      console.log(`  ↳ Router returned ${targetAgent}; using ${CODER_AGENT} as doer (${targetAgent} is not a task doer).`);
      targetAgent = CODER_AGENT;
    }

    // Copywriter pass — runs before coder-front on copy-heavy tasks
    if (needsCopywriter(item.text) && targetAgent === "crew-coder-front") {
      task = await runCopywriterPass(item.text, task);
    }

    const start = Date.now();
    try {
      console.log(`  🚀 Dispatching to ${targetAgent}${targetAgent !== CODER_AGENT ? ` (specialist)` : ""}...`);
      await callAgent(targetAgent, `[PM-Loop] ${task}`);
      const dur = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`  ✅ Done in ${dur}s`);

      // QA review pass — if QA fails, route issues to crew-fixer
      if (USE_QA) {
        try {
          console.log(`  🔍 QA review via crew-qa...`);
          const qaFilePaths = await getOutputDirFilePaths();
          const qaFilesHint = qaFilePaths.length > 0
            ? `\n\nOnly these paths exist in the output dir — use @@READ_FILE on these only:\n${qaFilePaths.join("\n")}\n`
            : `\n\n(Output dir ${OUTPUT_DIR} has no tracked files yet; skip file reads and reply PASS or FAIL based on the task.)\n`;
          const qaPrompt = `[QA-Review] ${targetAgent} just completed this task:\n\n"${task.substring(0, 300)}"\n\nRead the relevant files in ${OUTPUT_DIR} to review the changes. Check for: broken HTML/CSS, JS errors, missing files, visual regressions, Tailwind or unknown CSS classes on a non-Tailwind site.${qaFilesHint}\nReply with exactly one of:\n- "PASS" if everything looks correct\n- "FAIL: <specific issues>" if there are problems that need fixing`;
          const qaResult = await callAgent("crew-qa", qaPrompt);
          const qaText = String(qaResult).trim();
          const qaPass = /^PASS/i.test(qaText);
          console.log(`  📋 QA: ${qaPass ? "✅ PASS" : "❌ FAIL"} — ${qaText.substring(0, 120)}`);
          await log({ op_id: opId, item: item.text, agent: "crew-qa", status: qaPass ? "qa_pass" : "qa_fail", qa_result: qaText.substring(0, 300) });

          // If QA flagged issues, send them to crew-fixer before marking done
          if (!qaPass) {
            try {
              console.log(`  🔧 QA failed — routing issues to crew-fixer...`);
              const fixPrompt = `[QA-Fixer] QA found issues after this task was completed:\n\nOriginal task: "${task.substring(0, 300)}"\n\nQA issues:\n${qaText}\n\nRead the affected files in ${OUTPUT_DIR} first, then fix only what QA flagged — do not rewrite whole files. Confirm what you fixed.`;
              const fixResult = await callAgent("crew-fixer", fixPrompt);
              console.log(`  ✅ Fixer resolved QA issues: ${String(fixResult).substring(0, 80)}`);
              await log({ op_id: opId, item: item.text, agent: "crew-fixer", status: "qa_fixed", fix_result: String(fixResult).substring(0, 200) });
            } catch (fixErr) {
              console.log(`  ⚠️  Fixer couldn't resolve QA issues: ${fixErr.message.slice(0, 60)}`);
            }
          }
        } catch (qaErr) {
          console.log(`  ⚠️  QA skipped: ${qaErr.message.slice(0, 60)}`);
        }
      }

      // Security review for sensitive tasks
      if (needsSecurityReview(item.text)) {
        try {
          console.log(`  🔒 Security review via security agent...`);
          const secPrompt = `[Security-Review] Review the recent changes for security issues. Task was: "${task.substring(0, 200)}". Check for exposed secrets, injection risks, insecure patterns. Reply with CLEAR or list vulnerabilities.`;
          const secResult = await callAgent("crew-security", secPrompt);
          console.log(`  🛡️  Security: ${String(secResult).substring(0, 80)}`);
          await log({ op_id: opId, item: item.text, agent: "security", status: "security_reviewed", sec_result: String(secResult).substring(0, 200) });
        } catch (secErr) {
          console.log(`  ⚠️  Security review skipped: ${secErr.message.slice(0, 60)}`);
        }
      }

      await markItem(item.lineIdx, "done", targetAgent);
      await log({ op_id: opId, item: item.text, task: task.substring(0, 120), agent: targetAgent, status: "done", duration_s: parseFloat(dur) });
      doneCount++;
      completedItems.push(item.text);
    } catch (e) {
      const dur = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`  ❌ Failed in ${dur}s: ${e.message}`);
      await markItem(item.lineIdx, "failed");

      // Ask crew-fixer to attempt a repair
      try {
        console.log(`  🔧 Asking crew-fixer to repair...`);
        const fixPrompt = `[Fixer] The following task failed: "${task.substring(0, 300)}"\n\nError: ${e.message.slice(0, 200)}\n\nRead the relevant files in ${OUTPUT_DIR} first to understand the current state, then make targeted fixes — do not rewrite whole files.`;
        await callAgent("crew-fixer", fixPrompt);
        console.log(`  🔧 Fixer done — marking as done`);
        await markItem(item.lineIdx, "done", "crew-fixer");
        await log({ op_id: opId, item: item.text, task: task.substring(0, 120), agent: "crew-fixer", status: "fixed", duration_s: parseFloat(dur) });
        doneCount++;
        completedItems.push(item.text);
      } catch (fixErr) {
        console.log(`  ❌ Fixer also failed: ${fixErr.message.slice(0, 60)}`);
        await log({ op_id: opId, item: item.text, task: task.substring(0, 120), agent: CODER_AGENT, status: "failed", duration_s: parseFloat(dur), error: e.message });
      }
    }

    if (BETWEEN_TASKS > 0 && pending > 1) {
      console.log(`  ⏳ Pausing ${BETWEEN_TASKS / 1000}s before next item...`);
      await new Promise(r => setTimeout(r, BETWEEN_TASKS));
    }
  }

  // Final summary
  const finalContent = await readFile(ROADMAP_FILE, "utf8");
  const { items: finalItems } = parseRoadmap(finalContent);
  const done    = finalItems.filter(i => i.status === "done").length;
  const failed  = finalItems.filter(i => i.status === "failed").length;
  const pending = finalItems.filter(i => i.status === "pending").length;

  // crew-main synthesizes and verifies the full build before we close out
  if (!DRY_RUN) {
    await finalSynthesis(opId, completedItems, done, failed);
  }

  banner(`PM Loop finished  ✓${done}  ✗${failed}  ⏳${pending} remaining`);
  console.log(`Roadmap: ${ROADMAP_FILE}`);
  console.log(`Log:     ${PM_LOG}`);
  await log({ op_id: opId, event: "finish", done, failed, pending });
  await clearPid();
}

main().catch(e => { console.error(e); process.exit(1); });
