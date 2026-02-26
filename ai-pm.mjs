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

async function dispatch(agent, task, projectDir, opts = {}) {
  // opts.model — override the agent's default model for this one task (escalation)
  const body = { agent, task, projectDir };
  if (opts.model) body.model = opts.model;
  const d = await crewPost("/api/dispatch", body);
  if (!d.ok) throw new Error(d.error || "dispatch failed");
  return d.taskId;
}

// ── Git worktree management ───────────────────────────────────────────────────
// Each parallel task gets its own git worktree so agents can't stomp each other's files.

// git worktree add works on dirty trees — no stash needed
// Kept as no-op so callers compile but stashing was removed (it hid ROADMAP changes)
async function ensureCleanMain(_projectDir) {
  return false;
}

async function createWorktree(projectDir, branchName) {
  const { execSync } = await import("node:child_process");
  const safeName = branchName.replace(/[^a-z0-9-]/gi, "-");
  const wtDir = path.join(os.tmpdir(), `crewswarm-wt-${safeName}`);
  try {
    // Clean up any leftover from a previous run
    execSync(`git -C "${projectDir}" worktree remove "${wtDir}" --force 2>/dev/null || true`, { shell: true });
    execSync(`git -C "${projectDir}" branch -D "${branchName}" 2>/dev/null || true`, { shell: true });
    execSync(`git -C "${projectDir}" worktree add "${wtDir}" -b "${branchName}"`, { shell: true });
    // Copy node_modules + venv symlinks so tests can run in the worktree
    for (const dir of ["node_modules", "venv"]) {
      const src = path.join(projectDir, dir);
      const dst = path.join(wtDir, dir);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        try { fs.symlinkSync(src, dst); } catch {}
      }
    }
    return wtDir;
  } catch (e) {
    console.log(`     ⚠️  Worktree create failed (${e.message?.slice(0, 60)}) — using main dir`);
    return projectDir;
  }
}

async function mergeWorktree(projectDir, wtDir, branchName) {
  const { execSync } = await import("node:child_process");
  try {
    execSync(
      `git -C "${projectDir}" merge --no-ff "${branchName}" -m "feat: ${branchName}"`,
      { shell: true }
    );
    return true;
  } catch (e) {
    console.log(`     ⚠️  Merge conflict for ${branchName}: ${e.message?.slice(0, 80)}`);
    // Abort any in-progress merge
    try { execSync(`git -C "${projectDir}" merge --abort 2>/dev/null || true`, { shell: true }); } catch {}
    return false;
  } finally {
    try {
      if (wtDir !== projectDir) {
        execSync(`git -C "${projectDir}" worktree remove "${wtDir}" --force 2>/dev/null || true`, { shell: true });
      }
      execSync(`git -C "${projectDir}" branch -D "${branchName}" 2>/dev/null || true`, { shell: true });
    } catch {}
  }
}

async function discardWorktree(projectDir, wtDir, branchName) {
  const { execSync } = await import("node:child_process");
  try {
    if (wtDir !== projectDir) {
      execSync(`git -C "${projectDir}" worktree remove "${wtDir}" --force 2>/dev/null || true`, { shell: true });
    }
    execSync(`git -C "${projectDir}" branch -D "${branchName}" 2>/dev/null || true`, { shell: true });
  } catch {}
}

// ── Phase-aware dispatch ──────────────────────────────────────────────────────
// Reads ROADMAP section headers (## ...) as phases. Dispatches items only from
// the earliest phase that still has pending items. Enforces sequential ordering.

function getRoadmapPhases(content) {
  const lines = content.split("\n");
  const phases = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      current = { name: lines[i].replace(/^##\s*/, "").trim(), pendingIdxs: [], doneIdxs: [] };
      phases.push(current);
    } else if (current) {
      if (/^\s*[-*]\s*\[\s*\]/.test(lines[i])) current.pendingIdxs.push(i);
      else if (/^\s*[-*]\s*\[x\]/i.test(lines[i])) current.doneIdxs.push(i);
    }
  }
  return phases;
}

function getPhaseAwarePendingItems(roadmap) {
  const phases = getRoadmapPhases(roadmap);
  const allPending = getPendingItems(roadmap);
  const pendingSet = new Set(allPending.map(p => p.lineIdx));

  for (const phase of phases) {
    const phasePending = phase.pendingIdxs.filter(i => pendingSet.has(i));
    if (phasePending.length > 0) {
      // Return pending items only from this phase
      return allPending.filter(p => phasePending.includes(p.lineIdx));
    }
  }
  return allPending; // fallback: no phase structure found
}

// Count ✗ marks in a task line to get the persistent failure count
function getPersistedFailCount(taskText) {
  return (taskText.match(/✗/g) || []).length;
}

// ── CI/CD loop ────────────────────────────────────────────────────────────────

async function pushAndWatchCI(projectDir, timeoutMs = 300000) {
  const { execSync } = await import("node:child_process");
  console.log(`     🚀 Pushing to origin...`);
  try {
    execSync(`git -C "${projectDir}" push origin HEAD`, { timeout: 30000, shell: true, stdio: "pipe" });
  } catch (e) {
    console.log(`     ⚠️  Push failed: ${e.message?.slice(0, 80)}`);
    return { status: "push_failed" };
  }

  console.log(`     👀 Watching CI...`);
  const deadline = Date.now() + timeoutMs;
  await sleep(8000); // give GitHub time to register the run

  while (Date.now() < deadline) {
    try {
      const out = execSync(
        `gh run list --limit=1 --json status,conclusion,databaseId,name`,
        { encoding: "utf8", cwd: projectDir }
      );
      const [run] = JSON.parse(out);
      if (!run) { await sleep(10000); continue; }

      if (run.status === "completed") {
        if (run.conclusion === "success") {
          console.log(`     ✅ CI passed`);
          return { status: "passed" };
        }
        // CI failed — get the log
        console.log(`     ❌ CI failed (${run.conclusion}) — fetching logs...`);
        let ciLog = "";
        try {
          ciLog = execSync(
            `gh run view ${run.databaseId} --log-failed`,
            { encoding: "utf8", cwd: projectDir, timeout: 20000 }
          ).slice(0, 3000);
        } catch {}
        return { status: "failed", log: ciLog, runId: run.databaseId };
      }

      const elapsed = Math.round((Date.now() - (deadline - timeoutMs)) / 1000);
      console.log(`     ⏳ CI ${run.status}... (${elapsed}s)`);
    } catch {}
    await sleep(15000);
  }
  return { status: "timeout" };
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

// ── Model escalation + task decomposition ────────────────────────────────────
// After a task fails multiple times: escalate model first, then decompose into subtasks.

const taskFailCounts = {}; // taskText → number of in-session failures
const decomposedTasks = new Set(); // tasks already decomposed — don't decompose again

// Break a stuck task into 3-5 smaller concrete subtasks using the LLM.
// Injects the subtasks back into ROADMAP.md above the original failing task line.
async function decomposeTask(item, projectDir, failCount) {
  if (decomposedTasks.has(item.text)) return false; // already tried
  console.log(`     🔬 Decomposing stuck task (${failCount} failures)...`);

  const llm = getLLMConfig();
  let fileTree = "";
  try {
    const { execSync } = await import("node:child_process");
    fileTree = execSync(`find "${projectDir}" -type f -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/venv/*" -not -path "*/__pycache__/*" | head -60`, { encoding: "utf8" });
  } catch {}

  const prompt = `You are a senior engineer decomposing a stuck task into smaller subtasks.

STUCK TASK (failed ${failCount} times): "${item.text}"

PROJECT FILES (relevant subset):
${fileTree.slice(0, 2000)}

Break this into 3-5 SMALL, CONCRETE, independently-implementable subtasks.
Each subtask must:
- Reference a specific file to modify
- Have a clear, single action (add function, fix import, create file, etc.)
- Be completable in one OpenCode session

Reply with ONLY a JSON array of strings. Example:
["Create src/data/polymarket_client.py with fetch_price_history(market_id) function", "Wire fetch_price_history into src/backtest/engine.py replacing the stub"]`;

  try {
    const resp = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify({ model: llm.model, messages: [{ role: "user", content: prompt }], max_tokens: 800, temperature: 0.2 }),
      signal: AbortSignal.timeout(20000),
    });
    const d = await resp.json();
    const raw = d.choices?.[0]?.message?.content?.trim() || "";
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return false;
    const subtasks = JSON.parse(match[0]).filter(s => typeof s === "string" && s.length > 10).slice(0, 5);
    if (subtasks.length < 2) return false;

    // Inject subtasks into ROADMAP above the failing task's line
    const roadmapContent = readRoadmap();
    const lines = roadmapContent.split("\n");
    const insertLines = subtasks.map(s => `- [ ] ${s} <!-- decomposed from: ${item.text.slice(0, 60)} -->`);
    // Insert subtasks above failing task, then mark the original as [x] decomposed
    // (subtasks are inserted first so lineIdx still points to the right line)
    lines.splice(item.lineIdx, 0, ...insertLines);
    // Original task is now at item.lineIdx + insertLines.length — mark it done
    const origIdx = item.lineIdx + insertLines.length;
    if (origIdx < lines.length) {
      lines[origIdx] = lines[origIdx].replace(/\[\s*\]/, "[x]").trimEnd() + " [decomposed]";
    }
    fs.writeFileSync(ROADMAP_FILE, lines.join("\n"));

    decomposedTasks.add(item.text);
    console.log(`     🔬 Decomposed into ${subtasks.length} subtasks:`);
    subtasks.forEach((s, i) => console.log(`        ${i+1}. ${s.slice(0, 80)}`));
    return true;
  } catch (e) {
    console.log(`     ⚠️  Decomposition failed: ${e.message?.slice(0, 60)}`);
    return false;
  }
}

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
  if (model) console.log(`     🆙 Task failed ${fails}x in-session — escalating to ${model}`);
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

  // 2. Check OpenCode server — read port from OPENCODE_PORT env or opencode config
  const OC_PORT = (() => {
    if (process.env.OPENCODE_PORT) return Number(process.env.OPENCODE_PORT);
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".opencode", "config.json"), "utf8"));
      if (cfg.port) return Number(cfg.port);
    } catch {}
    return 4096; // default
  })();
  let ocAlive = false;
  try {
    const ocRes = await fetch(`http://127.0.0.1:${OC_PORT}/`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
    ocAlive = !!ocRes;
  } catch {}

  if (!ocAlive) {
    console.log(`     ❌ OpenCode server DOWN (port ${OC_PORT}) — restarting...`);
    try {
      execSync(`pkill -f "opencode serve" 2>/dev/null; sleep 1; nohup opencode serve --port ${OC_PORT} --hostname 127.0.0.1 >> /tmp/opencode-server.log 2>&1 &`, {
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
    if (/\[FROZEN\]/.test(line)) continue; // skip permanently failed tasks
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

  // Load project-specific hints from .ai-pm.json
  let hints = "";
  const doNotTouch = ["ROADMAP.md", "qa-report.md", ".ai-pm-notes.md", ".ai-pm.json"];
  const hintsFile = path.join(projectDir, ".ai-pm.json");
  if (fs.existsSync(hintsFile)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(hintsFile, "utf8"));
      if (Array.isArray(cfg.hints) && cfg.hints.length) {
        hints = `\n\nProject rules:\n${cfg.hints.map(h => `- ${h}`).join("\n")}`;
      }
      if (cfg.startCmd) hints += `\nStart command: ${cfg.startCmd}`;
      if (cfg.bootVerify) hints += `\nBoot verify: ${cfg.bootVerify}`;
      if (Array.isArray(cfg.doNotTouch)) doNotTouch.push(...cfg.doNotTouch);
    } catch {}
  }

  const tree = scanDir(projectDir).slice(0, 80);
  return `Project directory: ${projectDir}
Project file tree:
${tree.map(f => `- ${f}`).join("\n")}${hints}

STRICT RULES:
- DO NOT modify or touch: ${doNotTouch.join(", ")}
- Only write to source files directly relevant to your task.
- Always @@READ_FILE before @@WRITE_FILE.`.trim();
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

  // Create CI workflow if not present
  const ciWorkflow = path.join(PROJECT_DIR, ".github", "workflows", "ci.yml");
  if (!fs.existsSync(ciWorkflow)) {
    try {
      fs.mkdirSync(path.dirname(ciWorkflow), { recursive: true });
      fs.writeFileSync(ciWorkflow, [
        "name: CI",
        "on:",
        "  push:",
        "    branches: [main]",
        "  pull_request:",
        "    branches: [main]",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - uses: actions/setup-python@v5",
        "        with: { python-version: '3.11', cache: pip }",
        "      - run: pip install -r requirements.txt 2>/dev/null || true",
        "      - run: pytest -x --tb=short -q || true",
        "        env: { PYTHONPATH: . }",
        "      - uses: actions/setup-node@v4",
        "        with: { node-version: '20', cache: npm }",
        "      - run: npm ci && npm test -- --watchAll=false --forceExit --passWithNoTests || true",
        "        env: { CI: true }",
      ].join("\n"));
      console.log(`  📄 Created CI workflow: ${ciWorkflow}`);
    } catch {}
  }

  const MAX_TASK_FAILURES = 6; // stop retrying a task after this many ✗ marks
  let doneCount = 0;
  let failCount = 0;
  let batchNum  = 0;

  while (doneCount + failCount < MAX_ITEMS) {
    if (fs.existsSync(STOP_FILE)) {
      console.log("\n⛔ Stop file detected — exiting gracefully.");
      break;
    }

    const roadmap = readRoadmap();
    const allPending = getPendingItems(roadmap);

    // Skip tasks that have hit the max failure threshold — mark as [FROZEN] on their line
    const frozen = allPending.filter(p => getPersistedFailCount(p.text) >= MAX_TASK_FAILURES);
    if (frozen.length > 0) {
      let roadmapContent = readRoadmap();
      for (const item of frozen) {
        console.log(`  🧊 Freezing task (${getPersistedFailCount(item.text)} failures): ${item.text.slice(0, 60)}...`);
        const lines = roadmapContent.split("\n");
        if (!lines[item.lineIdx].includes("[FROZEN]")) {
          lines[item.lineIdx] = lines[item.lineIdx].trimEnd() + " [FROZEN]";
        }
        roadmapContent = lines.join("\n");
      }
      fs.writeFileSync(ROADMAP_FILE, roadmapContent);
    }

    const pending = getPhaseAwarePendingItems(readRoadmap())
      .filter(p => getPersistedFailCount(p.text) < MAX_TASK_FAILURES);

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

    // Human checkpoint: pause before high-risk tasks unless --auto flag is set
    const RISKY_PATTERNS = /migration|schema.change|drop.table|breaking.change|auth|jwt|password|encrypt|secret|api.key|rename.*column|alter.*table/i;
    const AUTO_APPROVE = args.includes("--auto") || process.env.AI_PM_AUTO === "1";
    if (!AUTO_APPROVE) {
      const riskyTasks = batch.filter(t => RISKY_PATTERNS.test(t.text));
      if (riskyTasks.length > 0) {
        console.log(`\n  ⚠️  HIGH-RISK TASKS detected — requires approval before dispatch:`);
        riskyTasks.forEach((t, i) => console.log(`     ${i+1}. ${t.text.slice(0, 100)}`));
        console.log(`\n  → Touch ${STOP_FILE} within 30s to abort, or wait to proceed...`);
        await sleep(30000);
        if (fs.existsSync(STOP_FILE)) {
          console.log(`  ⛔ Aborted by user`);
          break;
        }
        console.log(`  ✅ No abort received — proceeding with risky tasks`);
      }
    }

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
    // Strip ✗ timestamps and <!-- comments --> before passing to router — cleaner LLM routing
    const cleanText = t => t.replace(/\s*✗\s*\d{4}-\d{2}-\d{2}T[^\s]*/g, "").replace(/<!--[^>]*-->/g, "").trim();
    const assignments = await routeAndExpandBatch(batch.map(i => cleanText(i.text)), effectiveRoster.length > 0 ? effectiveRoster : agentRoster);

    const PROJECT_CONTEXT = buildProjectContext(PROJECT_DIR);

    // Shared agent notes — carry forward findings from previous batches
    const NOTES_FILE = path.join(PROJECT_DIR, ".ai-pm-notes.md");
    let sharedNotes = "";
    try {
      const raw = fs.readFileSync(NOTES_FILE, "utf8");
      // Only include the last 60 lines so context doesn't balloon
      const lines = raw.split("\n");
      sharedNotes = lines.slice(-60).join("\n");
    } catch {}

    const NOTES_INSTRUCTION = `
After completing your task, append 1-3 bullet findings to the file ${NOTES_FILE}.
Format: "- [batch ${batchNum}] <what you found/changed/discovered>"
This is how you share context with parallel and future agents. Use @@WRITE_FILE or echo append — never overwrite the whole file.`;

    // Dispatch all in parallel, collect promises
    let jobs = batch.map((item, idx) => {
      const { agent, task } = assignments[idx];
      const notesSection = sharedNotes
        ? `\n\n## Agent notes from previous batches\n${sharedNotes}`
        : "";
      // NOTE: NOTES_INSTRUCTION is appended AFTER building fullTask so the
      // later PROJECT_DIR→wtDir replacement never touches the absolute notes path.
      const fullTask = `${task}\n\n${PROJECT_CONTEXT}${notesSection}`;
      console.log(`  🚀 [${idx+1}] → ${agent}: ${item.text.substring(0, 60)}...`);
      return { item, agent, fullTask, notesInstruction: NOTES_INSTRUCTION, start: Date.now() };
    });

    // File conflict prevention: defer tasks that target the same files as another task
    jobs = deduplicateBatchByFiles(jobs);

    // Note: git worktree add works on dirty trees — no stash needed

    const results = await Promise.allSettled(
      jobs.map(async ({ item, agent: originalAgent, fullTask, notesInstruction, start }, jobIdx) => {
        // Reroute if this agent has timed out too many times this session
        const fallback = getFallbackAgent(originalAgent, NON_DOERS);
        const agent = fallback || originalAgent;

        // Model escalation: use persistent ✗ count (survives restarts) + in-session count
        const persistedFails = getPersistedFailCount(item.text);
        const sessionFails = taskFailCounts[item.text] || 0;
        const totalFails = persistedFails + sessionFails;
        const escalationModel = totalFails >= 2 ? getEscalationModel(item.text) : null;
        if (escalationModel) console.log(`     🆙 Task has ${totalFails} prior failures — escalating to ${escalationModel}`);

        // Git worktree: each parallel task gets its own isolated branch
        const branchName = `ai-pm/b${batchNum}-t${jobIdx + 1}`;
        const wtDir = await createWorktree(PROJECT_DIR, branchName);
        const useWorktree = wtDir !== PROJECT_DIR;
        if (useWorktree) console.log(`     🌿 Worktree: ${path.basename(wtDir)} (branch: ${branchName})`);

        // Replace PROJECT_DIR with wtDir in task body — done BEFORE appending NOTES_INSTRUCTION
        // so the absolute notes path is never rewritten to the worktree path.
        const taskBody = useWorktree
          ? fullTask.replace(new RegExp(PROJECT_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), wtDir)
          : fullTask;
        const taskForAgent = `${taskBody}\n${notesInstruction}`;

        const taskId = await dispatch(agent, taskForAgent, wtDir, escalationModel ? { model: escalationModel } : {});
        console.log(`     ⏳ ${agent} taskId=${taskId.slice(0,8)}...`);
        let result;
        try {
          result = await waitForTask(taskId);
        } catch (err) {
          const isTimeout = /timed out|stuck pending/i.test(err.message || "");
          if (isTimeout) recordAgentTimeout(agent);
          await discardWorktree(PROJECT_DIR, wtDir, branchName);
          throw err;
        }
        return { item, agent, result, dur: ((Date.now() - start) / 1000).toFixed(1), branchName, wtDir };
      })
    );

    // Architect pass: enforce structure, merge duplicates, fix imports before QA
    async function runArchitect() {
      console.log(`     🏗️  Architect pass — cleaning structure...`);
      // Read project hints from .ai-pm.json for generic canonical paths
      const hints = (() => {
        try { return JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, ".ai-pm.json"), "utf8")); } catch { return {}; }
      })();
      const canonicalTree = hints.canonicalTree || "src/";
      const archPrompt = `Audit and clean the project at ${PROJECT_DIR}:
1. Find files at the project root or outside ${canonicalTree} that duplicate files already inside ${canonicalTree}. Delete the duplicates.
2. Find *.bak, _crew-*.md, extra qa-report-*.md, *.prof, *.pyc, __pycache__ at project root. Delete them.
3. Find broken imports (e.g. from wrong package paths). Fix them.
4. Report exactly: "Deleted: X", "Fixed import: Y". Do NOT touch ROADMAP.md or qa-report.md. Do NOT write business logic.
Canonical source tree: ${canonicalTree}`;
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

      // 1. Run the actual test suite (in agent's working dir, falls back to main)
      let testResult;
      try {
        testResult = await runRealTests(testDir, 90000);
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
      const { item, agent, fullTask, branchName = null, wtDir = PROJECT_DIR } = jobs[i];
      // testDir starts as the worktree; updated to PROJECT_DIR once worktree is merged/discarded
      let testDir = wtDir;

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
          const fixDir = testDir; // always matches where tests run
          const fixPrompt = buildSucceeded
            ? `Fix test failures in ${fixDir}.\n\nTask that was completed: ${item.text}\n\n${isRealTestFailure ? "ACTUAL TEST OUTPUT (fix these specific failures):" : "QA feedback:"}\n${qaFeedback}\n\nRead the relevant source files, fix every failure shown above. Run the tests mentally to verify. DO NOT modify ROADMAP.md or qa-report.md.`
            : `Task failed. Fix and complete it.\n\nTask: ${item.text}\n\nError: ${qaFeedback}\n\nProject: ${fixDir}. Read the relevant source files, diagnose and fix. DO NOT modify ROADMAP.md or qa-report.md.`;
          const fixId = await dispatch("crew-fixer", fixPrompt, fixDir);
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
        // Merge worktree branch back into main
        if (branchName && wtDir !== PROJECT_DIR) {
          const merged = await mergeWorktree(PROJECT_DIR, wtDir, branchName);
          if (!merged) {
            console.log(`  ⚠️  [${i+1}] Merge failed — marking as failed`);
            await discardWorktree(PROJECT_DIR, wtDir, branchName);
            const updated = markItemFailed(readRoadmap(), item.lineIdx);
            fs.writeFileSync(ROADMAP_FILE, updated);
            failCount++;
            recordTaskFailure(item.text);
            continue;
          }
          console.log(`  🔀 [${i+1}] Merged ${branchName} → main`);
          testDir = PROJECT_DIR; // worktree removed by mergeWorktree — test in main from here
          // Post-merge sanity: run tests in main to catch merge-induced breakage
          const postMerge = await runRealTests(PROJECT_DIR, 60000);
          if (postMerge.ran && !postMerge.passed) {
            console.log(`  ❌ [${i+1}] Post-merge tests failed — reverting merge`);
            try {
              const { execSync } = await import("node:child_process");
              execSync(`git -C "${PROJECT_DIR}" reset --hard HEAD~1`, { shell: true });
            } catch {}
            const updated = markItemFailed(readRoadmap(), item.lineIdx);
            fs.writeFileSync(ROADMAP_FILE, updated);
            // Give fixer the actual post-merge failure
            qaFeedback = `POST-MERGE TESTS FAILED:\n${postMerge.failureDetail || postMerge.summary}`;
            failCount++;
            recordTaskFailure(item.text);
            continue;
          }
        }
        const finalAgent = repairCount > 0 ? `crew-fixer` : agent;
        const updated = markItemDone(readRoadmap(), item.lineIdx, finalAgent);
        fs.writeFileSync(ROADMAP_FILE, updated);
        doneCount++;
        batchDone++;
        delete taskFailCounts[item.text];
        console.log(`  ✅ [${i+1}] DONE (${repairCount > 0 ? `fixed in ${repairCount} repair(s)` : "first pass"})`);
      } else {
        // Discard worktree — don't pollute main with broken code
        if (branchName && wtDir !== PROJECT_DIR) {
          await discardWorktree(PROJECT_DIR, wtDir, branchName);
          testDir = PROJECT_DIR; // worktree gone — fixer will run in main
        }
        const updated = markItemFailed(readRoadmap(), item.lineIdx);
        fs.writeFileSync(ROADMAP_FILE, updated);
        failCount++;
        recordTaskFailure(item.text);
        const totalFails = getPersistedFailCount(item.text) + (taskFailCounts[item.text] || 0);
        // If task has failed 3+ times total and hasn't been decomposed, break it up
        if (totalFails >= 3 && !decomposedTasks.has(item.text)) {
          decomposeTask(item, PROJECT_DIR, totalFails).catch(e => {
            console.log(`     ⚠️  Decompose error (non-fatal): ${e.message?.slice(0, 80)}`);
          });
        }
        console.log(`  ⚠️  [${i+1}] SKIPPED after ${MAX_QA_REPAIRS} repair cycles — QA still failing`);
        maybeLearnFromFailure(agent, item.text, qaFeedback).catch(() => {});
      }
    }

    // After each batch — commit, push, watch CI
    if (batchDone > 0) {
      const { execSync } = await import("node:child_process");
      try {
        console.log(`\n  📦 Committing ${batchDone} completed task(s)...`);
        const commitMsg = `feat: batch ${batchNum} — ${batchDone} task(s) completed via AI-PM`;
        execSync(`git -C "${PROJECT_DIR}" add -A && git -C "${PROJECT_DIR}" commit -m "${commitMsg}" || true`, { shell: true, stdio: "pipe" });
        console.log(`  ✅ Committed`);
      } catch (e) {
        console.log(`  ⚠️  Git commit skipped: ${e.message?.slice(0, 60)}`);
      }

      // CI/CD: push + watch GitHub Actions
      try {
        const ci = await pushAndWatchCI(PROJECT_DIR, 600000); // 10-min CI timeout
        if (ci.status === "failed" && ci.log) {
          console.log(`  ❌ CI failed — dispatching crew-fixer with CI log...`);
          const ciFixPrompt = `CI failed after last commit. Fix the failing tests.\n\nCI failure log:\n${ci.log}\n\nProject: ${PROJECT_DIR}. Read the relevant source files, fix every failure shown in the CI log above. DO NOT modify ROADMAP.md or qa-report.md.`;
          try {
            const fixId = await dispatch("crew-fixer", ciFixPrompt, PROJECT_DIR);
            const fixResult = await waitForTask(fixId, TASK_TIMEOUT);
            console.log(`  🔧 CI fixer: ${(fixResult || "").slice(0, 100)}`);
            // Commit and re-push the CI fix
            execSync(`git -C "${PROJECT_DIR}" add -A && git -C "${PROJECT_DIR}" commit -m "fix: CI failures from batch ${batchNum}" || true`, { shell: true, stdio: "pipe" });
            const ci2 = await pushAndWatchCI(PROJECT_DIR, 600000);
            console.log(`  ${ci2.status === "passed" ? "✅" : "⚠️"} CI re-run: ${ci2.status}`);
          } catch (fixErr) {
            console.log(`  ⚠️  CI fix failed: ${fixErr.message?.slice(0, 60)}`);
          }
        } else if (ci.status === "timeout") {
          console.log(`  ⏳ CI still running after 3min — continuing without waiting`);
        }
      } catch (ciErr) {
        console.log(`  ⚠️  CI watch skipped: ${ciErr.message?.slice(0, 60)}`);
      }
    }

    await sleep(1000);
  }

  banner(`AI PM finished  ✓${doneCount}  ✗${failCount}  ⏳${getPendingItems(readRoadmap()).length} remaining`);
}

// ── Worktree cleanup on exit ──────────────────────────────────────────────────
async function cleanupWorktrees() {
  try {
    const { execSync } = await import("node:child_process");
    const list = execSync(`git -C "${PROJECT_DIR}" worktree list --porcelain 2>/dev/null`, { encoding: "utf8" });
    const staleWTs = list.match(/worktree\s+(\/tmp\/crewswarm-wt-[^\n]+)/g) || [];
    for (const m of staleWTs) {
      const wtPath = m.replace("worktree ", "").trim();
      try { execSync(`git -C "${PROJECT_DIR}" worktree remove "${wtPath}" --force 2>/dev/null`, { shell: true }); } catch {}
    }
    // Also clean ai-pm/* branches that were never merged
    const branches = execSync(`git -C "${PROJECT_DIR}" branch --list "ai-pm/*" 2>/dev/null`, { encoding: "utf8" });
    for (const b of branches.split("\n").map(s => s.trim().replace(/^\*\s*/, "")).filter(Boolean)) {
      try { execSync(`git -C "${PROJECT_DIR}" branch -D "${b}" 2>/dev/null`, { shell: true }); } catch {}
    }
  } catch {}
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    console.log(`\n⛔ ${sig} received — cleaning up worktrees...`);
    await cleanupWorktrees();
    process.exit(0);
  });
}

main().catch(e => {
  console.error("Fatal:", e);
  cleanupWorktrees().finally(() => process.exit(1));
});
