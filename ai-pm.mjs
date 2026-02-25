#!/usr/bin/env node
/**
 * ai-pm.mjs — AI-driven project manager.
 *
 * The LLM IS the PM. It reads ROADMAP.md, decides which agent handles each
 * task and how, dispatches through crew-lead's REST API (the same channel a
 * human would use), polls for completion, marks done, and loops autonomously
 * until the roadmap is finished.
 *
 * Usage:
 *   node ai-pm.mjs --project-dir /path/to/project
 *   node ai-pm.mjs --project-dir /path/to/project --max-items 50
 *   node ai-pm.mjs --project-dir /path/to/project --dry-run
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Config ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  if (i !== -1 && args[i + 1]) return args[i + 1];
  const eq = args.find(a => a.startsWith(`${flag}=`));
  return eq ? eq.split("=").slice(1).join("=") : null;
};

const PROJECT_DIR  = get("--project-dir") || process.env.PROJECT_DIR;
const ROADMAP_FILE = path.join(PROJECT_DIR, "ROADMAP.md");
const DRY_RUN      = args.includes("--dry-run");
const MAX_ITEMS    = Number(get("--max-items") || "200");
const CREW_URL     = `http://127.0.0.1:${process.env.CREW_LEAD_PORT || 5010}`;
const TASK_TIMEOUT   = Number(process.env.AI_PM_TASK_TIMEOUT_MS || "720000"); // 12 min
const MAX_PARALLEL   = Number(process.env.AI_PM_PARALLEL || "3");            // concurrent agents
const STOP_FILE      = path.join(os.homedir(), ".crewswarm", "ai-pm.stop");

if (!PROJECT_DIR) {
  console.error("Usage: node ai-pm.mjs --project-dir /path/to/project");
  process.exit(1);
}

// ── Failure memory + agent self-improvement ───────────────────────────────────

const AGENT_PROMPTS_FILE = path.join(os.homedir(), ".crewswarm", "agent-prompts.json");
const LESSONS_FILE       = path.join(os.homedir(), ".crewswarm", "ai-pm-lessons.json");

// In-memory failure log: { agent, task, qaFeedback, project }
const failureLog = [];

function loadAgentPrompts() {
  try { return JSON.parse(fs.readFileSync(AGENT_PROMPTS_FILE, "utf8")); } catch { return {}; }
}

function saveAgentPrompts(prompts) {
  fs.writeFileSync(AGENT_PROMPTS_FILE, JSON.stringify(prompts, null, 2));
}

function loadLessons() {
  try { return JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8")); } catch { return {}; }
}

function saveLessons(lessons) {
  fs.writeFileSync(LESSONS_FILE, JSON.stringify(lessons, null, 2));
}

// Called after a task is marked failed. If the same agent has ≥2 failures,
// ask the LLM to synthesize a lesson and patch the agent's system prompt.
async function maybeLearnFromFailure(agent, task, qaFeedback) {
  const bareAgent = agent.replace(/^crew-/, "");
  failureLog.push({ agent, task, qaFeedback, ts: Date.now() });

  const agentFails = failureLog.filter(f => f.agent === agent);
  if (agentFails.length < 2) return; // not enough signal yet

  console.log(`\n  🧠 ${agent} has ${agentFails.length} failures — synthesizing lesson...`);

  const recentFails = agentFails.slice(-4);
  const synthesis = await llmCall(
    `You improve AI coding agent system prompts based on observed failures. Be concise and direct.`,
    `Agent "${agent}" has failed these tasks repeatedly:

${recentFails.map((f, i) => `${i+1}. Task: ${f.task.slice(0,120)}\n   QA feedback: ${f.qaFeedback.slice(0,120)}`).join("\n\n")}

Write 2-4 bullet points (starting with "- ") that should be APPENDED to this agent's system prompt to prevent these failures. Focus on the root cause pattern. Be specific and actionable. Do not repeat general advice.`
  ).catch(e => { console.log(`     ⚠️  Lesson synthesis failed: ${e.message?.slice(0,60)}`); return null; });

  if (!synthesis) return;

  const lesson = `\n\n# Lessons learned (AI-PM, ${new Date().toISOString().slice(0,10)}):\n${synthesis.trim()}`;
  console.log(`  📝 Lesson for ${agent}:\n${synthesis.trim().split("\n").map(l => "     " + l).join("\n")}`);

  // Patch agent-prompts.json
  try {
    const prompts = loadAgentPrompts();
    prompts[bareAgent] = (prompts[bareAgent] || "") + lesson;
    saveAgentPrompts(prompts);
    console.log(`  ✅ Patched ~/.crewswarm/agent-prompts.json for ${bareAgent}`);
  } catch (e) {
    console.log(`  ⚠️  Could not patch agent prompt: ${e.message?.slice(0,60)}`);
  }

  // Also persist to lessons file for transparency
  try {
    const lessons = loadLessons();
    if (!lessons[agent]) lessons[agent] = [];
    lessons[agent].push({ ts: new Date().toISOString(), lesson: synthesis.trim(), failCount: agentFails.length });
    saveLessons(lessons);
  } catch {}
}

// ── Healthcheck + bridge recovery ────────────────────────────────────────────

const CREW_DIR = path.join(os.homedir(), "Desktop", "CrewSwarm");

async function healthCheck(agentId) {
  // 1. crew-lead reachable?
  try {
    await crewGet("/health");
  } catch {
    console.log(`  🔴 crew-lead unreachable — attempting restart...`);
    try {
      const { spawn } = await import("node:child_process");
      spawn("node", ["crew-lead.mjs"], {
        cwd: CREW_DIR, detached: true, stdio: "ignore",
      }).unref();
      await sleep(5000);
      await crewGet("/health"); // verify it came back
      console.log(`  ✅ crew-lead restarted`);
    } catch (e) {
      console.log(`  ⚠️  crew-lead restart failed: ${e.message?.slice(0,60)}`);
    }
  }

  // 2. Is the target agent's bridge registered?
  if (agentId) {
    try {
      const agents = await crewGet("/api/agents");
      const list = Array.isArray(agents) ? agents : [];
      const found = list.find(a => a.id === agentId);
      if (!found) {
        console.log(`  🔴 ${agentId} bridge not registered — restarting bridges...`);
        const { spawn } = await import("node:child_process");
        spawn("node", ["scripts/start-crew.mjs"], {
          cwd: CREW_DIR, detached: true, stdio: "ignore",
        }).unref();
        await sleep(12000); // give bridges time to connect
        console.log(`  ✅ Bridges restarted`);
      }
    } catch (e) {
      console.log(`  ⚠️  Agent check failed: ${e.message?.slice(0,60)}`);
    }
  }
}

// ── Auth + config ─────────────────────────────────────────────────────────────

function loadCrew() {
  return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "crewswarm.json"), "utf8"));
}

const configJson = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "config.json"), "utf8"));
const TOKEN = configJson.rt?.authToken;
if (!TOKEN) { console.error("No auth token in config.json"); process.exit(1); }

// ── crew-lead API ─────────────────────────────────────────────────────────────

async function crewGet(endpoint) {
  const r = await fetch(`${CREW_URL}${endpoint}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!r.ok) throw new Error(`GET ${endpoint} → ${r.status}`);
  return r.json();
}

async function crewPost(endpoint, body) {
  const r = await fetch(`${CREW_URL}${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`POST ${endpoint} → ${r.status} ${t}`);
  }
  return r.json();
}

async function dispatch(agent, task, projectDir) {
  const d = await crewPost("/api/dispatch", { agent, task, projectDir });
  if (!d.ok) throw new Error(d.error || "dispatch failed");
  return d.taskId;
}

async function waitForTask(taskId, timeoutMs = TASK_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "pending";
  let unknownStreak = 0;
  let pendingSince = Date.now();
  const STALE_BRIDGE_MS = 3 * 60 * 1000; // 3 min stuck on "pending" = bridge likely dead

  while (Date.now() < deadline) {
    await sleep(4000);
    const d = await crewGet(`/api/status/${taskId}`).catch(() => ({ status: "unknown" }));
    const prevStatus = lastStatus;
    lastStatus = d.status;

    if (d.status === "done") return d.result || "(done)";

    if (d.status === "unknown") {
      unknownStreak++;
      if (unknownStreak >= 3) return "(done)"; // cleaned from registry = completed
    } else {
      unknownStreak = 0;
    }

    // Reset stale timer if status changed
    if (d.status !== prevStatus) pendingSince = Date.now();

    // If stuck on "pending" too long, health-check + restart before giving up
    if (d.status === "pending" && Date.now() - pendingSince > STALE_BRIDGE_MS) {
      console.log(`     ⚠️  Task ${taskId.slice(0,8)} stuck pending 3min — running health check...`);
      const healthy = await healthCheckAndRestart();
      if (healthy) {
        // Bridge restarted — re-dispatch the task fresh
        console.log(`     🔄 Bridge restarted — note: original task may need re-dispatch by caller`);
      }
      throw new Error(`Task ${taskId} stuck pending 3min — bridge restarted, re-dispatch needed`);
    }
  }
  throw new Error(`Task ${taskId} timed out after ${Math.round(timeoutMs / 60000)}min (last: ${lastStatus})`);
}

async function healthCheckAndRestart() {
  const { execSync } = await import("node:child_process");
  const crewDir = path.dirname(new URL(import.meta.url).pathname);
  let restarted = false;

  // 1. Verify crew-lead is alive
  try {
    await crewGet("/health");
  } catch {
    console.log(`     ❌ crew-lead unreachable — cannot restart bridges`);
    return false;
  }

  // 2. Check OpenCode server (port 4096)
  let ocAlive = false;
  try {
    const ocRes = await fetch("http://127.0.0.1:4096/health", { signal: AbortSignal.timeout(3000) }).catch(() => null);
    // OpenCode returns HTML on /, not /health — treat any non-error response as alive
    ocAlive = !!ocRes;
  } catch {}

  if (!ocAlive) {
    console.log(`     ❌ OpenCode server DOWN (port 4096) — restarting...`);
    try {
      execSync(`pkill -f "opencode serve" 2>/dev/null; sleep 1; nohup opencode serve --port 4096 --hostname 127.0.0.1 >> /tmp/opencode-server.log 2>&1 &`, {
        timeout: 5000, shell: true,
      });
      await sleep(6000); // give OC time to come up
      console.log(`     ✅ OpenCode restart triggered`);
      restarted = true;
    } catch (e) {
      console.log(`     ⚠️  OpenCode restart failed: ${e.message?.slice(0, 80)}`);
    }
  }

  // 3. Check how many bridge daemons are running
  let bridgeCount = 0;
  try {
    const out = execSync(`pgrep -f "gateway-bridge.mjs --rt-daemon" | wc -l`, { encoding: "utf8" });
    bridgeCount = parseInt(out.trim(), 10);
  } catch {}

  console.log(`     🔍 Health check: crew-lead ✅  OpenCode: ${ocAlive ? "✅" : "⚠️ restarted"}  bridges: ${bridgeCount}`);

  if (bridgeCount < 3) {
    console.log(`     🚀 Low bridge count (${bridgeCount}) — restarting crew daemons...`);
    try {
      execSync(`pkill -f "gateway-bridge.mjs --rt-daemon" 2>/dev/null; sleep 1; node ${crewDir}/scripts/start-crew.mjs >> /tmp/crew-restart-ai-pm.log 2>&1 &`, {
        timeout: 5000, shell: true,
      });
      await sleep(8000);
      console.log(`     ✅ Bridge restart triggered`);
      restarted = true;
    } catch (e) {
      console.log(`     ⚠️  Bridge restart failed: ${e.message?.slice(0, 60)}`);
    }
  }

  return restarted;
}

// ── LLM (PM brain) ────────────────────────────────────────────────────────────

function getLLMConfig() {
  const cfg = loadCrew();
  const providers = { ...(cfg.models?.providers || {}), ...(cfg.providers || {}) };

  // Env override: AI_PM_MODEL=groq/llama-3.3-70b-versatile
  if (process.env.AI_PM_MODEL) {
    const [provName, ...parts] = process.env.AI_PM_MODEL.split("/");
    const prov = providers[provName];
    if (prov?.apiKey) return { baseUrl: prov.baseUrl, apiKey: prov.apiKey, model: parts.join("/"), provName };
  }

  // Prefer Groq (fast, free, reliable) → xAI → Anthropic → any provider with a key
  const preference = ["groq", "xai", "anthropic", "openai", "mistral", "cerebras"];
  const GROQ_MODEL  = "llama-3.3-70b-versatile";
  const XAI_MODEL   = "grok-3-mini";
  const defaultModels = { groq: GROQ_MODEL, xai: XAI_MODEL };

  for (const provName of preference) {
    const prov = providers[provName];
    if (!prov?.apiKey) continue;
    const model = defaultModels[provName] || prov.model || "llama-3.3-70b-versatile";
    return { baseUrl: prov.baseUrl, apiKey: prov.apiKey, model, provName };
  }

  // Last resort: first provider with a key
  for (const [provName, prov] of Object.entries(providers)) {
    if (prov?.apiKey) {
      return { baseUrl: prov.baseUrl, apiKey: prov.apiKey, model: prov.model || "default", provName };
    }
  }

  throw new Error("No LLM provider configured with an API key");
}

async function llmCall(systemPrompt, userPrompt) {
  const cfg = getLLMConfig();
  const isAnthropic = cfg.provName === "anthropic";

  const headers = {
    "Content-Type": "application/json",
    ...(isAnthropic
      ? { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" }
      : { Authorization: `Bearer ${cfg.apiKey}` }),
  };

  let body, url;
  if (isAnthropic) {
    url  = `${cfg.baseUrl}/messages`;
    body = { model: cfg.model, max_tokens: 1024, system: systemPrompt, messages: [{ role: "user", content: userPrompt }] };
  } else {
    // Groq, xAI, OpenAI-compatible
    url  = `${cfg.baseUrl}/chat/completions`;
    body = { model: cfg.model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], temperature: 0, max_tokens: 1024 };
  }

  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`LLM error ${r.status}: ${t.slice(0, 200)}`);
  }
  const d = await r.json();
  const text = isAnthropic
    ? d.content?.[0]?.text?.trim()
    : d.choices?.[0]?.message?.content?.trim();
  return text || "";
}

// Ask the LLM to route and expand a BATCH of roadmap items in one call
async function routeAndExpandBatch(items, agentRoster) {
  const systemPrompt = `You are an engineering PM. Assign each task to the best available agent.

Available agents:
${agentRoster.map(a => `- ${a.id}: ${a.role}`).join("\n")}

Assignment rules:
- Pick the agent whose role best matches the task type
- Spread tasks across different agents when possible to maximise parallelism
- NEVER assign to agents not listed above

Respond with ONLY a valid JSON array, one object per task, same order as input:
[{"agent": "crew-xxx"}, ...]

Only output agent assignments. Do NOT rewrite task text.`;

  const userPrompt = `Project directory: ${PROJECT_DIR}

Tasks to assign (${items.length}):
${items.map((item, i) => `${i + 1}. ${item}`).join("\n")}

Return a JSON array with exactly ${items.length} assignments.`;

  try {
    const text = await llmCall(systemPrompt, userPrompt);
    const arrayMatch = text.match(/\[[\s\S]+\]/);
    if (!arrayMatch) throw new Error("No JSON array in response");
    const parsed = JSON.parse(arrayMatch[0]);
    if (!Array.isArray(parsed) || parsed.length !== items.length) throw new Error("Array length mismatch");
    // Merge agent assignment back with original task text (don't trust LLM-expanded text)
    return parsed.map((p, i) => ({ agent: p.agent, task: items[i] }));
  } catch (e) {
    console.log(`  ⚠️  Batch routing failed (${e.message.slice(0, 60)}), using defaults`);
    return items.map(item => ({ agent: "crew-coder-back", task: item }));
  }
}

// ── Roadmap I/O ───────────────────────────────────────────────────────────────

function readRoadmap() {
  return fs.readFileSync(ROADMAP_FILE, "utf8");
}

function getPendingItems(content) {
  const lines = content.split("\n");
  const pending = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*[-*]\s*\[\s*\]\s+\S/.test(line) || /^\s*\d+\.\s*\[\s*\]\s+\S/.test(line)) {
      pending.push({ lineIdx: i, text: line.replace(/^\s*[-*\d.]+\s*\[\s*\]\s*/, "").trim() });
    }
  }
  return pending;
}

function markItemDone(content, lineIdx, agent) {
  const lines = content.split("\n");
  if (lineIdx >= 0 && lineIdx < lines.length) {
    lines[lineIdx] = lines[lineIdx]
      .replace(/\[\s*\]/, "[x]")
      .trimEnd() + ` ✓ ${agent}`;
  }
  return lines.join("\n");
}

function markItemFailed(content, lineIdx) {
  const lines = content.split("\n");
  if (lineIdx >= 0 && lineIdx < lines.length) {
    lines[lineIdx] = lines[lineIdx]
      .replace(/\[\s*\]/, "[ ]")
      .trimEnd() + ` ✗ ${new Date().toISOString()}`;
  }
  return lines.join("\n");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function banner(title) {
  const line = "─".repeat(60);
  console.log(`\n${line}\n  ${title}\n${line}`);
}

function getAgentRoster() {
  try {
    const cfg = loadCrew();
    const providers = { ...(cfg.models?.providers || {}), ...(cfg.providers || {}) };
    const agents = Array.isArray(cfg.agents) ? cfg.agents : [];
    const ROLE_MAP = {
      "crew-coder-back":  "backend APIs, databases, server-side logic",
      "crew-coder-front": "HTML, CSS, JavaScript UI, frontend, visual design",
      "crew-frontend":    "HTML, CSS, JavaScript UI, frontend, visual design",
      "crew-coder":       "general coding, modules, scripts, full-stack",
      "crew-ml":          "machine learning, AI models, data science, training pipelines",
      "crew-mega":        "versatile general-purpose tasks",
    };
    const NON_DOERS = new Set(["crew-qa","crew-security","crew-fixer","crew-pm","crew-lead","orchestrator","crew-telegram","crew-main","crew-researcher","crew-seo","crew-copywriter","crew-github","crew-architect"]);
    return agents
      .filter(a => {
        if (NON_DOERS.has(a.id)) return false;
        const [provName] = (a.model || "").split("/");
        const prov = providers[provName];
        return prov?.apiKey;
      })
      .map(a => ({ id: a.id, role: ROLE_MAP[a.id] || "general coding" }));
  } catch {
    return [
      { id: "crew-coder", role: "general coding, scripts, full-stack" },
    ];
  }
}

// Scan the project directory and build a compact file tree for agent context.
// Reads an optional .ai-pm.json config file from the project root for overrides.
function buildProjectContext(projectDir) {
  const IGNORE = new Set([".git","node_modules","__pycache__",".pytest_cache",".DS_Store","dist","build",".venv","venv","env",".env","*.pyc"]);
  const CODE_EXT = new Set([".py",".js",".ts",".jsx",".tsx",".html",".css",".json",".yaml",".yml",".toml",".sh",".md"]);

  function scanDir(dir, depth = 0, maxDepth = 3) {
    if (depth > maxDepth) return [];
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    const lines = [];
    for (const e of entries) {
      if (IGNORE.has(e.name) || e.name.startsWith(".")) continue;
      const rel = path.relative(projectDir, path.join(dir, e.name));
      if (e.isDirectory()) {
        lines.push(`${rel}/`);
        lines.push(...scanDir(path.join(dir, e.name), depth + 1, maxDepth));
      } else if (CODE_EXT.has(path.extname(e.name))) {
        lines.push(rel);
      }
    }
    return lines;
  }

  // Check for optional project-specific hints file
  let hints = "";
  const hintsFile = path.join(projectDir, ".ai-pm.json");
  if (fs.existsSync(hintsFile)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(hintsFile, "utf8"));
      if (cfg.context) hints = `\nProject notes: ${cfg.context}`;
      if (cfg.entryPoints) hints += `\nEntry points: ${cfg.entryPoints.join(", ")}`;
    } catch {}
  }

  const tree = scanDir(projectDir).slice(0, 80); // cap to avoid huge prompts
  return `Project directory: ${projectDir}
Project file tree:
${tree.map(f => `- ${f}`).join("\n")}${hints}

STRICT RULES:
- DO NOT modify, uncheck, or add items to ROADMAP.md — managed by AI-PM only.
- DO NOT modify qa-report.md.
- Only write to source files relevant to your task.`.trim();
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  banner(`AI PM  project=${PROJECT_DIR}  max=${MAX_ITEMS}${DRY_RUN ? "  DRY RUN" : ""}`);

  // Remove stale stop file
  if (fs.existsSync(STOP_FILE)) {
    fs.unlinkSync(STOP_FILE);
    console.log("🧹 Removed stale stop file");
  }

  if (!fs.existsSync(ROADMAP_FILE)) {
    console.error(`❌ ROADMAP.md not found: ${ROADMAP_FILE}`);
    process.exit(1);
  }

  // Verify crew-lead is reachable
  try {
    await crewGet("/health");
  } catch {
    console.error(`❌ crew-lead not reachable at ${CREW_URL} — is it running?`);
    process.exit(1);
  }

  console.log(`\nTip: touch ${STOP_FILE} to stop gracefully between tasks\n`);

  const agentRoster = getAgentRoster();
  console.log(`Agents available (${agentRoster.length}): ${agentRoster.map(a => a.id).join(", ")}`);
  console.log(`Parallel workers: ${MAX_PARALLEL}`);

  let doneCount = 0;
  let failCount = 0;
  let batchNum  = 0;

  while (doneCount + failCount < MAX_ITEMS) {
    if (fs.existsSync(STOP_FILE)) {
      console.log("\n⛔ Stop file detected — exiting gracefully.");
      break;
    }

    const roadmap = readRoadmap();
    const pending = getPendingItems(roadmap);
    if (pending.length === 0) { banner("✅ All roadmap tasks complete!"); break; }

    // Pick next batch (up to MAX_PARALLEL items)
    const batch = pending.slice(0, MAX_PARALLEL);
    batchNum++;
    console.log(`\n${"─".repeat(60)}`);
    console.log(`  Batch ${batchNum} — ${batch.length} tasks in parallel  (${doneCount}✓ ${failCount}✗ ${pending.length} pending)`);
    console.log(`${"─".repeat(60)}`);
    batch.forEach((item, i) => console.log(`  [${i+1}] ${item.text.substring(0, 100)}`));

    if (DRY_RUN) {
      console.log(`  [DRY RUN] Would dispatch ${batch.length} tasks`);
      break;
    }

    // Groq assigns all tasks in one call
    console.log(`\n  🤔 Groq routing ${batch.length} tasks...`);
    const assignments = await routeAndExpandBatch(batch.map(i => i.text), agentRoster);

    const PROJECT_CONTEXT = buildProjectContext(PROJECT_DIR);

    // Dispatch all in parallel, collect promises
    const jobs = batch.map((item, idx) => {
      const { agent, task } = assignments[idx];
      const fullTask = `${task}\n\n${PROJECT_CONTEXT}`;
      console.log(`  🚀 [${idx+1}] → ${agent}: ${item.text.substring(0, 60)}...`);
      return { item, agent, fullTask, start: Date.now() };
    });

    const results = await Promise.allSettled(
      jobs.map(async ({ item, agent, fullTask, start }) => {
        const taskId = await dispatch(agent, fullTask, PROJECT_DIR);
        console.log(`     ⏳ ${agent} taskId=${taskId.slice(0,8)}...`);
        const result = await waitForTask(taskId);
        return { item, agent, result, dur: ((Date.now() - start) / 1000).toFixed(1) };
      })
    );

    // Architect pass: enforce structure, merge duplicates, fix imports before QA
    async function runArchitect() {
      console.log(`     🏗️  Architect pass — cleaning structure...`);
      const archPrompt = `Audit and clean the project at ${PROJECT_DIR}:
1. Delete any files outside src/ that duplicate files inside src/ (e.g. backend/main.py, database.py at root, *.bak, _crew-*.md, extra qa-report-*.md, *.prof, extra *.sqlite/.db files beyond app.db)
2. Fix any broken imports in src/api/main.py and src/api/routers/ (e.g. "from ..backend" should be "from src", "Database()" must be imported)
3. Remove duplicate router includes in main.py
4. Report: "Deleted: X", "Fixed import: Y". Do NOT touch ROADMAP.md or qa-report.md. Do NOT write business logic.
Project canonical tree: src/api/main.py, src/api/routers/, src/backtest/, src/data/, src/frontend/, src/ai/`;
      try {
        const archId = await dispatch("crew-architect", archPrompt, PROJECT_DIR);
        const archResult = await waitForTask(archId, TASK_TIMEOUT);
        console.log(`     🏗️  Architect done: ${(archResult || "").slice(0, 120)}`);
      } catch (e) {
        console.log(`     ⚠️  Architect pass failed (non-fatal): ${e.message?.slice(0, 60)}`);
      }
    }

    // QA helper: ask crew-qa to audit a completed task. Returns { passed, feedback }.
    async function runQA(taskDescription, attemptNum) {
      const qaPrompt = `QA this task in ${PROJECT_DIR} — reply QA_PASS or QA_FAIL: <issues>. Do NOT modify ROADMAP.md or qa-report.md. Task: ${taskDescription}`;

      console.log(`     🔍 QA pass ${attemptNum}...`);
      const qaId = await dispatch("crew-qa", qaPrompt, PROJECT_DIR);
      let qaResult = await waitForTask(qaId, TASK_TIMEOUT);
      // If we lost the result (registry cleaned), re-dispatch once to get a real verdict
      if (!qaResult || qaResult === "(done)" || qaResult.trim().length < 5) {
        console.log(`     ⚠️  QA result lost — re-dispatching for verdict`);
        const qaId2 = await dispatch("crew-qa", qaPrompt, PROJECT_DIR);
        qaResult = await waitForTask(qaId2, TASK_TIMEOUT);
      }
      const passed = /QA_PASS/i.test(qaResult);
      const feedback = qaResult.replace(/QA_PASS|QA_FAIL:/gi, "").trim().slice(0, 400);
      console.log(`     ${passed ? "✅ QA passed" : `❌ QA failed: ${feedback.slice(0, 120)}`}`);
      return { passed, feedback };
    }

    // Architect pass: clean up duplicates + fix imports before QA sees the code
    await runArchitect();

    // Process results with QA → Fix → QA loop (max 2 repair cycles per task)
    const MAX_QA_REPAIRS = 2;
    let batchDone = 0;
    for (let i = 0; i < results.length; i++) {
      let r = results[i];
      const { item, agent, fullTask } = jobs[i];

      let buildSucceeded = false;
      let lastError = "";

      // Phrases that indicate the agent couldn't do the work (not an actual implementation)
      const AGENT_FAIL_PATTERNS = [
        /does not exist/i, /directory.*empty/i, /empty.*directory/i,
        /cannot find.*director/i, /no such file/i, /path.*not found/i,
        /unable to.*access/i, /could not.*open/i, /file.*not found/i,
        /verify.*correct.*path/i, /ensure.*files.*are.*in.*place/i,
        /appears to be empty/i, /please.*verify/i,
      ];

      if (r.status === "fulfilled") {
        const { dur, result: agentReply } = r.value;
        const agentFailure = AGENT_FAIL_PATTERNS.some(p => p.test(agentReply || ""));
        if (agentFailure) {
          console.log(`  ⚠️  [${i+1}] ${agent} replied with error (${(agentReply||"").slice(0,80)}...) — treating as fail`);
          lastError = (agentReply || "").slice(0, 200);
        } else {
          console.log(`  ✅ [${i+1}] ${agent} built in ${dur}s — running QA`);
          buildSucceeded = true;
        }
      } else {
        lastError = r.reason?.message?.slice(0, 120) || "unknown error";
        // Bridge restart path — re-dispatch to same agent before fixer
        if (/re-dispatch needed|bridge restarted/i.test(lastError)) {
          console.log(`  🔄 [${i+1}] Re-dispatching to ${agent} after bridge restart...`);
          try {
            const retryId = await dispatch(agent, jobs[i].fullTask, PROJECT_DIR);
            const retryResult = await waitForTask(retryId);
            const retryFail = AGENT_FAIL_PATTERNS.some(p => p.test(retryResult || ""));
            if (!retryFail) {
              r = { status: "fulfilled", value: { dur: "retry", result: retryResult } };
              console.log(`  ✅ [${i+1}] ${agent} succeeded on retry`);
            } else {
              lastError = retryResult?.slice(0, 120) || "retry failed";
              console.log(`  ❌ [${i+1}] ${agent} retry also failed`);
            }
          } catch (retryErr) {
            lastError = retryErr.message?.slice(0, 120) || "retry error";
            console.log(`  ❌ [${i+1}] Retry failed: ${lastError}`);
          }
        } else {
          console.log(`  ❌ [${i+1}] ${agent} build failed: ${lastError}`);
        }
      }

      let passed = false;
      let qaFeedback = lastError;

      if (buildSucceeded) {
        // First QA pass
        try {
          const qa = await runQA(item.text, 1);
          passed = qa.passed;
          qaFeedback = qa.feedback;
        } catch (e) {
          console.log(`     ⚠️  QA dispatch failed: ${e.message?.slice(0,60)} — treating as FAIL, will attempt fix`);
          passed = false;
          qaFeedback = `QA could not run: ${e.message?.slice(0, 200)}`;
        }
      }

      // Fix → QA loop (up to MAX_QA_REPAIRS times)
      let repairCount = 0;
      while (!passed && repairCount < MAX_QA_REPAIRS) {
        repairCount++;
        console.log(`     🔧 Repair cycle ${repairCount}/${MAX_QA_REPAIRS} — dispatching crew-fixer...`);
        try {
          const fixPrompt = buildSucceeded
            ? `QA found issues after task completion. Fix them.\n\nOriginal task: ${item.text}\n\nQA feedback: ${qaFeedback}\n\nProject: ${PROJECT_DIR}. Read the relevant source files, fix every issue QA reported, verify the fix. DO NOT modify ROADMAP.md or qa-report.md.`
            : `Task failed to build. Fix and complete it.\n\nTask: ${item.text}\n\nError: ${qaFeedback}\n\nProject: ${PROJECT_DIR}. Read the relevant source files, diagnose, implement the fix. DO NOT modify ROADMAP.md or qa-report.md.`;
          const fixId = await dispatch("crew-fixer", fixPrompt, PROJECT_DIR);
          const fixResult = await waitForTask(fixId, TASK_TIMEOUT);
          // If fixer says it's already done, skip re-QA and treat as pass
          const ALREADY_DONE = [
            /already implemented/i, /already exists/i, /no work needed/i,
            /already (in place|present|there|done|complete)/i,
            /nothing to (fix|implement|change|do)/i,
            /endpoints? (are|is) already/i,
          ];
          if (ALREADY_DONE.some(p => p.test(fixResult || ""))) {
            console.log(`     ✅ Fixer confirmed already done — skipping re-QA`);
            passed = true;
            break;
          }
          console.log(`     ✅ Fixer done — re-running QA`);
          buildSucceeded = true;
        } catch (fixErr) {
          console.log(`     ⚠️  Fixer failed (${fixErr.message?.slice(0,60)}) — skipping repair`);
          break;
        }

        // QA re-check
        try {
          const qa = await runQA(item.text, repairCount + 1);
          passed = qa.passed;
          qaFeedback = qa.feedback;
        } catch (e) {
          console.log(`     ⚠️  QA re-check failed: ${e.message?.slice(0,60)} — still treating as fail`);
          passed = false;
          qaFeedback = `QA re-check could not run: ${e.message?.slice(0, 200)}`;
        }
      }

      // Write result to roadmap
      if (passed) {
        const finalAgent = repairCount > 0 ? `crew-fixer` : agent;
        const updated = markItemDone(readRoadmap(), item.lineIdx, finalAgent);
        fs.writeFileSync(ROADMAP_FILE, updated);
        doneCount++;
        batchDone++;
        console.log(`  ✅ [${i+1}] DONE (${repairCount > 0 ? `fixed in ${repairCount} repair(s)` : "first pass"})`);
      } else {
        const updated = markItemFailed(readRoadmap(), item.lineIdx);
        fs.writeFileSync(ROADMAP_FILE, updated);
        failCount++;
        console.log(`  ⚠️  [${i+1}] SKIPPED after ${MAX_QA_REPAIRS} repair cycles — QA still failing`);
        // Learn from this failure — may patch agent system prompt
        maybeLearnFromFailure(agent, item.text, qaFeedback).catch(() => {});
      }
    }

    // After each batch — if anything passed QA, have crew-github commit it
    if (batchDone > 0) {
      try {
        console.log(`\n  📦 crew-github committing ${batchDone} completed task(s)...`);
        const commitMsg = `feat: batch ${batchNum} — ${batchDone} task(s) completed via AI-PM`;
        const gitTask = `In ${PROJECT_DIR}: stage all changes (git add -A), commit with message "${commitMsg}", do not push. Only run git commands.`;
        const gitId = await dispatch("crew-github", gitTask, PROJECT_DIR);
        await waitForTask(gitId, 120000);
        console.log(`  ✅ Committed`);
      } catch (e) {
        console.log(`  ⚠️  Git commit skipped: ${e.message?.slice(0, 60)}`);
      }
    }

    await sleep(1000);
  }

  banner(`AI PM finished  ✓${doneCount}  ✗${failCount}  ⏳${getPendingItems(readRoadmap()).length} remaining`);
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
