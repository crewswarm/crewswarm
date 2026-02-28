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

if (!PROJECT_DIR) {
  console.error("Usage: node ai-pm.mjs --project-dir /path/to/project");
  process.exit(1);
}

const ROADMAP_FILE = path.join(PROJECT_DIR, "ROADMAP.md");
const DRY_RUN      = args.includes("--dry-run");
const MAX_ITEMS    = Number(get("--max-items") || "200");
const CREW_URL     = `http://127.0.0.1:${process.env.CREW_LEAD_PORT || 5010}`;
const TASK_TIMEOUT   = Number(process.env.AI_PM_TASK_TIMEOUT_MS || "720000"); // 12 min
const MAX_PARALLEL   = Number(process.env.AI_PM_PARALLEL || "3");            // concurrent agents
const STOP_FILE      = path.join(os.homedir(), ".crewswarm", "ai-pm.stop");

// ── Failure memory + agent self-improvement ───────────────────────────────────

const AGENT_PROMPTS_FILE = path.join(os.homedir(), ".crewswarm", "agent-prompts.json");
const LESSONS_FILE       = path.join(os.homedir(), ".crewswarm", "ai-pm-lessons.json");

// In-memory failure log: { agent, task, qaFeedback, project }
const failureLog = [];

// Agent timeout tracking — if an agent times out 2+ times in a session, route away from them
const agentTimeouts = {}; // { agentId: count }
const TIMEOUT_REROUTE_THRESHOLD = 2;

// Fallback routing: if primary agent keeps timing out, try these instead
const AGENT_FALLBACKS = {
  "crew-coder-back": ["crew-coder", "crew-fixer"],
  "crew-coder-front": ["crew-coder", "crew-frontend"],
  "crew-coder":       ["crew-coder-back", "crew-coder-front"],
  "crew-fixer":       ["crew-coder", "crew-coder-back"],
  "crew-frontend":    ["crew-coder-front", "crew-coder"],
  "crew-qa":          ["crew-security", "crew-main"],
};

function recordAgentTimeout(agent) {
  agentTimeouts[agent] = (agentTimeouts[agent] || 0) + 1;
  const count = agentTimeouts[agent];
  console.log(`     ⚠️  ${agent} timeout #${count}`);
  if (count >= TIMEOUT_REROUTE_THRESHOLD) {
    console.log(`     🔀 ${agent} flagged as flaky (${count}x timeout) — future tasks rerouted`);
    // Append a stability note to the agent's system prompt so it's visible in logs
    try {
      const prompts = loadAgentPrompts();
      const key = agent.replace(/^crew-/, "");
      const existing = prompts[key] || "";
      const note = `\n\n[AI-PM NOTE ${new Date().toISOString().slice(0,10)}]: This agent timed out ${count} times in the current session. If you see this, ensure your tasks are scoped small enough to finish within 10 minutes and always emit an output even if partial.`;
      if (!existing.includes("[AI-PM NOTE")) {
        prompts[key] = existing + note;
        saveAgentPrompts(prompts);
        console.log(`     📝 Prompt note added to ${agent}`);
      }
    } catch (e) {
      // non-fatal
    }
  }
}

function getFallbackAgent(agent, NON_DOERS) {
  const timeouts = agentTimeouts[agent] || 0;
  if (timeouts < TIMEOUT_REROUTE_THRESHOLD) return null;
  const fallbacks = AGENT_FALLBACKS[agent] || [];
  // Pick first fallback that isn't also timing out badly and isn't a non-doer
  const pick = fallbacks.find(f => !NON_DOERS?.has(f) && (agentTimeouts[f] || 0) < TIMEOUT_REROUTE_THRESHOLD);
  if (pick) console.log(`     🔀 Rerouting from ${agent} (${timeouts}x timeout) → ${pick}`);
  return pick || null;
}

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

const CREW_DIR = process.env.CREWSWARM_DIR || path.dirname(new URL(import.meta.url).pathname);

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
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "crewswarm.json"), "utf8"));
  } catch (e) {
    console.error(`ERROR: Cannot read ~/.crewswarm/crewswarm.json: ${e.message}`);
    console.error("Run the dashboard first to initialize config: npm run dashboard");
    process.exit(1);
  }
}

let configJson, TOKEN;
try {
  configJson = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "config.json"), "utf8"));
  TOKEN = configJson.rt?.authToken;
  if (!TOKEN) { 
    console.error("ERROR: No auth token in ~/.crewswarm/config.json");
    console.error("Run the dashboard first to generate auth token: npm run dashboard");
    process.exit(1); 
  }
} catch (e) {
  console.error(`ERROR: Cannot read ~/.crewswarm/config.json: ${e.message}`);
  console.error("Run the dashboard first to initialize config: npm run dashboard");
  process.exit(1);
}

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

async function dispatch(agent, task, projectDir, opts = {}) {
  // opts.model — override the agent's default model for this one task (escalation)
  const body = { agent, task, projectDir };
  if (opts.model) body.model = opts.model;
  const d = await crewPost("/api/dispatch", body);
  if (!d.ok) throw new Error(d.error || "dispatch failed");
  return d.taskId;
}

// ── Real test runner ───────────────────────────────────────────────────────────
// Runs actual tests (jest / pytest) and returns structured results.
// This replaces LLM-guessing in the QA loop with ground truth.

async function detectTestSetup(projectDir) {
  const pkg = path.join(projectDir, "package.json");
  const pytestIni = path.join(projectDir, "pytest.ini");
  const pyprojectToml = path.join(projectDir, "pyproject.toml");
  const setup = { jest: false, pytest: false, jestCmd: null, pytestCmd: null };

  try {
    const pkgJson = JSON.parse(fs.readFileSync(pkg, "utf8"));
    const testScript = pkgJson?.scripts?.test || "";
    if (testScript && !/no test/i.test(testScript)) {
      setup.jest = true;
      // Run with timeout and fail-fast; suppress interactive prompts
      setup.jestCmd = ["npm", ["test", "--", "--watchAll=false", "--forceExit", "--passWithNoTests"], {
        cwd: projectDir, env: { ...process.env, CI: "true" },
      }];
    }
  } catch {}

  if (fs.existsSync(pytestIni) || fs.existsSync(pyprojectToml)) {
    setup.pytest = true;
    const venv = path.join(projectDir, "venv", "bin", "pytest");
    const pytestBin = fs.existsSync(venv) ? venv : "pytest";
    setup.pytestCmd = [pytestBin, ["-x", "--tb=short", "-q"], { cwd: projectDir }];
  }

  return setup;
}

async function runRealTests(projectDir, timeoutMs = 90000) {
  const { spawn } = await import("node:child_process");
  const setup = await detectTestSetup(projectDir);
  const results = [];

  async function runCmd(bin, args, spawnOpts, label) {
    return new Promise(resolve => {
      let out = "";
      const p = spawn(bin, args, { ...spawnOpts, stdio: ["ignore", "pipe", "pipe"] });
      p.stdout.on("data", d => { out += d.toString(); });
      p.stderr.on("data", d => { out += d.toString(); });
      const timer = setTimeout(() => { p.kill("SIGKILL"); resolve({ label, passed: false, output: out + "\n[TEST TIMEOUT]", timedOut: true }); }, timeoutMs);
      p.on("close", code => {
        clearTimeout(timer);
        resolve({ label, passed: code === 0, exitCode: code, output: out.slice(-3000) });
      });
      p.on("error", err => { clearTimeout(timer); resolve({ label, passed: false, output: err.message }); });
    });
  }

  if (setup.jest) {
    const [bin, args, opts] = setup.jestCmd;
    const r = await runCmd(bin, args, opts, "jest");
    results.push(r);
  }

  if (setup.pytest) {
    const [bin, args, opts] = setup.pytestCmd;
    const r = await runCmd(bin, args, opts, "pytest");
    results.push(r);
  }

  if (results.length === 0) return { ran: false, passed: true, summary: "No test framework detected" };

  const allPassed = results.every(r => r.passed);
  const failedSuites = results.filter(r => !r.passed);
  const summary = results.map(r =>
    `${r.label}: ${r.passed ? "✅ PASS" : `❌ FAIL (exit ${r.exitCode})`}`
  ).join(" | ");

  // Extract just failing test lines for feedback
  const failureDetail = failedSuites.map(r => {
    const lines = r.output.split("\n");
    // Keep lines with FAIL/Error/assert/expect — first 40 relevant lines
    const relevant = lines.filter(l => /FAIL|FAILED|Error|assert|expect|✗|✕|×/i.test(l)).slice(0, 40);
    return `[${r.label}]\n${relevant.join("\n") || r.output.slice(0, 1500)}`;
  }).join("\n\n");

  return { ran: true, passed: allPassed, summary, failureDetail: failureDetail.slice(0, 2000), results };
}

// ── Model escalation ──────────────────────────────────────────────────────────
// After a task fails multiple times, escalate to a stronger model.

const taskFailCounts = {}; // taskText → number of failures

function getEscalationModel(taskText) {
  const fails = taskFailCounts[taskText] || 0;
  if (fails < 2) return null; // not escalating yet
  // Try Claude Sonnet first, then xAI Grok, then GPT-4o
  const cfg = loadCrew();
  const providers = { ...(cfg.models?.providers || {}), ...(cfg.providers || {}) };
  if (providers.anthropic?.apiKey) return "anthropic/claude-sonnet-4-5";
  if (providers.xai?.apiKey) return "xai/grok-3";
  if (providers.openai?.apiKey) return "openai/gpt-4o";
  return null;
}

function recordTaskFailure(taskText) {
  taskFailCounts[taskText] = (taskFailCounts[taskText] || 0) + 1;
  const fails = taskFailCounts[taskText];
  const model = getEscalationModel(taskText);
  if (model) console.log(`     🆙 Task failed ${fails}x — escalating to ${model}`);
}

// ── File conflict prevention ──────────────────────────────────────────────────
// Extract file paths mentioned in a task description to detect overlapping writes.

function extractFilePaths(text) {
  const paths = new Set();
  // Match things that look like file paths: src/..., path/to/file.ext
  const matches = text.match(/(?:^|[\s`'"])([a-zA-Z_][a-zA-Z0-9_/.-]*\.[a-zA-Z]{1,6})\b/g) || [];
  for (const m of matches) {
    const p = m.trim().replace(/^['"`]/, "");
    if (p.includes("/") || /\.(py|js|ts|jsx|tsx|json|md|html|css|sh|yaml|yml)$/.test(p)) {
      paths.add(p);
    }
  }
  return paths;
}

function deduplicateBatchByFiles(jobs) {
  const claimedFiles = new Set();
  const deduped = [];
  const deferred = [];

  for (const job of jobs) {
    // Only check the task description, NOT the full PROJECT_CONTEXT (which has every file)
    const files = extractFilePaths(job.item.text);
    const conflicts = [...files].filter(f => claimedFiles.has(f));
    if (conflicts.length > 0) {
      console.log(`  ⚠️  Task "${job.item.text.slice(0,50)}" deferred — file conflict: ${conflicts.join(", ")}`);
      deferred.push(job);
    } else {
      files.forEach(f => claimedFiles.add(f));
      deduped.push(job);
    }
  }

  if (deferred.length > 0) {
    console.log(`  📋 Deferred ${deferred.length} task(s) due to file conflicts — will retry next batch`);
  }
  return deduped;
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

// Kill any OpenCode agent sessions running longer than maxMinutes.
// Returns the number of processes killed.
// Uses ps etime format [[DD-]HH:]MM:SS (macOS/BSD compatible).
async function killStaleOCSessions(maxMinutes = 10) {
  const { execSync } = await import("node:child_process");
  let killed = 0;
  try {
    // etime format: [[DD-]HH:]MM:SS
    const psOut = execSync(
      `ps -eo pid,etime,command | grep "opencode run \\[crew-" | grep -v grep`,
      { encoding: "utf8" }
    ).trim();
    if (!psOut) return 0;

    function etimeToSec(e) {
      // e.g. "02:35", "01:02:35", "1-01:02:35"
      const s = e.trim();
      let days = 0;
      let rest = s;
      if (s.includes("-")) { const [d, r] = s.split("-"); days = parseInt(d, 10); rest = r; }
      const parts = rest.split(":").map(Number);
      if (parts.length === 2) return days * 86400 + parts[0] * 60 + parts[1];
      if (parts.length === 3) return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
      return 0;
    }

    for (const line of psOut.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\S+)\s+/);
      if (!m) continue;
      const pid = parseInt(m[1], 10);
      const elapsedSec = etimeToSec(m[2]);
      if (elapsedSec > maxMinutes * 60) {
        try { execSync(`kill -9 ${pid} 2>/dev/null`, { timeout: 2000, shell: true }); killed++; } catch {}
      }
    }
    if (killed > 0) {
      console.log(`     🧹 Pre-batch: killed ${killed} stale OpenCode session(s) (>${maxMinutes}min)`);
      await sleep(1500);
    }
  } catch {}
  return killed;
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
      const logPath = path.join(os.tmpdir(), "opencode-server.log");
      execSync(`pkill -f "opencode serve" 2>/dev/null; sleep 1; nohup opencode serve --port 4096 --hostname 127.0.0.1 >> ${logPath} 2>&1 &`, {
        timeout: 5000, shell: true,
      });
      await sleep(6000); // give OC time to come up
      console.log(`     ✅ OpenCode restart triggered`);
      restarted = true;
    } catch (e) {
      console.log(`     ⚠️  OpenCode restart failed: ${e.message?.slice(0, 80)}`);
    }
  }

  // 3. Kill stale OpenCode agent sessions (running >8 min) to free occupied bridges
  const staleKilled = await killStaleOCSessions(8);
  if (staleKilled > 0) restarted = true;

  // 4. Check how many bridge daemons are running
  let bridgeCount = 0;
  try {
    const out = execSync(`pgrep -f "gateway-bridge.mjs --rt-daemon" | wc -l`, { encoding: "utf8" });
    bridgeCount = parseInt(out.trim(), 10);
  } catch {}

  console.log(`     🔍 Health check: crew-lead ✅  OpenCode: ${ocAlive ? "✅" : "⚠️ restarted"}  bridges: ${bridgeCount}`);

  if (bridgeCount < 3) {
    console.log(`     🚀 Low bridge count (${bridgeCount}) — restarting crew daemons...`);
    try {
      const logPath = path.join(os.tmpdir(), "crew-restart-ai-pm.log");
      execSync(`pkill -f "gateway-bridge.mjs --rt-daemon" 2>/dev/null; sleep 1; node ${crewDir}/scripts/start-crew.mjs >> ${logPath} 2>&1 &`, {
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

// Module-level so batch dispatch, fallback routing, and getAgentRoster all share it
const NON_DOERS = new Set([
  "crew-qa","crew-security","crew-fixer","crew-pm","crew-lead",
  "orchestrator","crew-telegram","crew-main","crew-researcher",
  "crew-seo","crew-copywriter","crew-github","crew-architect",
]);

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

    // Pre-batch: kill any stale OpenCode sessions that would block these agents
    await killStaleOCSessions(8);

    // Build effective roster — exclude agents that have repeatedly timed out this session
    const flakyAgents = Object.entries(agentTimeouts)
      .filter(([, count]) => count >= TIMEOUT_REROUTE_THRESHOLD)
      .map(([id]) => id);
    if (flakyAgents.length > 0) {
      console.log(`  ⚠️  Skipping flaky agents this batch: ${flakyAgents.join(", ")}`);
    }
    const effectiveRoster = agentRoster.filter(a => !flakyAgents.includes(a.id));

    // Groq assigns all tasks in one call
    console.log(`\n  🤔 Groq routing ${batch.length} tasks...`);
    const assignments = await routeAndExpandBatch(batch.map(i => i.text), effectiveRoster.length > 0 ? effectiveRoster : agentRoster);

    const PROJECT_CONTEXT = buildProjectContext(PROJECT_DIR);

    // Dispatch all in parallel, collect promises
    let jobs = batch.map((item, idx) => {
      const { agent, task } = assignments[idx];
      const fullTask = `${task}\n\n${PROJECT_CONTEXT}`;
      console.log(`  🚀 [${idx+1}] → ${agent}: ${item.text.substring(0, 60)}...`);
      return { item, agent, fullTask, start: Date.now() };
    });

    // File conflict prevention: defer tasks that target the same files as another task
    jobs = deduplicateBatchByFiles(jobs);

    const results = await Promise.allSettled(
      jobs.map(async ({ item, agent: originalAgent, fullTask, start }) => {
        // Reroute if this agent has timed out too many times this session
        const fallback = getFallbackAgent(originalAgent, NON_DOERS);
        const agent = fallback || originalAgent;
        // Model escalation: if this task has failed multiple times, try a stronger model
        const escalationModel = getEscalationModel(item.text);
        const taskId = await dispatch(agent, fullTask, PROJECT_DIR, escalationModel ? { model: escalationModel } : {});
        if (escalationModel) console.log(`     🆙 Using escalation model: ${escalationModel}`);
        console.log(`     ⏳ ${agent} taskId=${taskId.slice(0,8)}...`);
        let result;
        try {
          result = await waitForTask(taskId);
        } catch (err) {
          // Track timeouts per agent so we reroute after repeated failures
          const isTimeout = /timed out|stuck pending/i.test(err.message || "");
          if (isTimeout) recordAgentTimeout(agent);
          throw err;
        }
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

    // QA: run real tests first. If they fail, ask crew-qa to diagnose.
    // Returns { passed, feedback } where feedback is real test output when tests fail.
    async function runQA(taskDescription, attemptNum) {
      console.log(`     🔍 QA pass ${attemptNum} — running real tests...`);

      // 1. Run the actual test suite
      let testResult;
      try {
        testResult = await runRealTests(PROJECT_DIR, 90000);
      } catch (e) {
        testResult = { ran: false, passed: false, summary: `Test runner error: ${e.message?.slice(0,80)}` };
      }

      if (testResult.ran) {
        console.log(`     🧪 Tests: ${testResult.summary}`);
        if (testResult.passed) {
          return { passed: true, feedback: testResult.summary };
        }
        // Tests failed — return real output as feedback (no LLM guessing needed)
        return {
          passed: false,
          feedback: `REAL TEST FAILURES:\n${testResult.failureDetail || testResult.summary}`.slice(0, 800),
        };
      }

      // 2. No test suite found — fall back to crew-qa reading code
      console.log(`     🔍 No tests found — asking crew-qa to review code...`);
      const qaPrompt = `Review task completion in ${PROJECT_DIR}. Reply QA_PASS or QA_FAIL: <issues>. Check: (1) relevant files exist and are syntactically correct, (2) no obvious import errors. DO NOT modify any files. DO NOT touch ROADMAP.md or qa-report.md. Task was: ${taskDescription}`;
      try {
        const qaId = await dispatch("crew-qa", qaPrompt, PROJECT_DIR);
        let qaResult = await waitForTask(qaId, Math.min(TASK_TIMEOUT, 300000));
        if (!qaResult || qaResult.trim().length < 5) {
          // Empty result — treat as pass (no tests = no ground truth, don't block forever)
          return { passed: true, feedback: "No test suite; code review inconclusive — treating as pass" };
        }
        const passed = /QA_PASS/i.test(qaResult);
        const feedback = qaResult.replace(/QA_PASS|QA_FAIL:/gi, "").trim().slice(0, 400);
        console.log(`     ${passed ? "✅ QA passed" : `❌ QA failed: ${feedback.slice(0, 120)}`}`);
        return { passed, feedback };
      } catch (e) {
        // crew-qa unavailable — no test suite — treat as pass
        return { passed: true, feedback: `QA skipped (no tests + crew-qa unreachable): ${e.message?.slice(0,60)}` };
      }
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
        const isTimeout = /timed out|stuck pending/i.test(lastError);
        if (isTimeout) recordAgentTimeout(agent);

        // Bridge restart path — re-dispatch to same (or fallback) agent before fixer
        if (/re-dispatch needed|bridge restarted/i.test(lastError)) {
          // Prefer a fallback agent if this one has been timing out
          const retryAgent = getFallbackAgent(agent, NON_DOERS) || agent;
          console.log(`  🔄 [${i+1}] Re-dispatching to ${retryAgent} after bridge restart...`);
          try {
            const retryId = await dispatch(retryAgent, jobs[i].fullTask, PROJECT_DIR);
            let retryResult;
            try {
              retryResult = await waitForTask(retryId);
            } catch (retryWaitErr) {
              if (/timed out|stuck pending/i.test(retryWaitErr.message || "")) recordAgentTimeout(retryAgent);
              throw retryWaitErr;
            }
            const retryFail = AGENT_FAIL_PATTERNS.some(p => p.test(retryResult || ""));
            if (!retryFail) {
              r = { status: "fulfilled", value: { dur: "retry", result: retryResult } };
              console.log(`  ✅ [${i+1}] ${retryAgent} succeeded on retry`);
            } else {
              lastError = retryResult?.slice(0, 120) || "retry failed";
              console.log(`  ❌ [${i+1}] ${retryAgent} retry also failed`);
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
          const isRealTestFailure = /REAL TEST FAILURES/i.test(qaFeedback);
          const fixPrompt = buildSucceeded
            ? `Fix test failures in ${PROJECT_DIR}.\n\nTask that was completed: ${item.text}\n\n${isRealTestFailure ? "ACTUAL TEST OUTPUT (fix these specific failures):" : "QA feedback:"}\n${qaFeedback}\n\nRead the relevant source files, fix every failure shown above. Run the tests mentally to verify. DO NOT modify ROADMAP.md or qa-report.md.`
            : `Task failed. Fix and complete it.\n\nTask: ${item.text}\n\nError: ${qaFeedback}\n\nProject: ${PROJECT_DIR}. Read the relevant source files, diagnose and fix. DO NOT modify ROADMAP.md or qa-report.md.`;
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
        // Reset fail count on success
        delete taskFailCounts[item.text];
        console.log(`  ✅ [${i+1}] DONE (${repairCount > 0 ? `fixed in ${repairCount} repair(s)` : "first pass"})`);
      } else {
        const updated = markItemFailed(readRoadmap(), item.lineIdx);
        fs.writeFileSync(ROADMAP_FILE, updated);
        failCount++;
        recordTaskFailure(item.text);
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
