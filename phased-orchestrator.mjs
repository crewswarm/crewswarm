#!/usr/bin/env node
/**
 * PHASED ORCHESTRATOR - PDD-style, phase-by-phase execution
 *
 * Big requirement → PM breaks into phases (MVP, Phase 1, Phase 2)
 * Each phase = 3-5 small tasks → execute incrementally
 * Avoids timeout: shorter PM prompts, smaller task batches
 *
 * Usage: node phased-orchestrator.mjs "Build a marketing website for OpenCrewHQ"
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdir } from "node:fs";
import { readFile, appendFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CREWSWARM_DIR = process.env.CREWSWARM_DIR || process.env.OPENCLAW_DIR || __dirname;
const GATEWAY_BRIDGE_PATH = `${CREWSWARM_DIR}/gateway-bridge.mjs`;
const LOG_DIR = join(CREWSWARM_DIR, "orchestrator-logs");
// All build output goes here so you can find it. Override with OPENCREW_OUTPUT_DIR.
const OUTPUT_DIR = process.env.OPENCREW_OUTPUT_DIR || join(CREWSWARM_DIR, "website");
const DISPATCH_LOG = join(LOG_DIR, "phased-dispatch.jsonl");

if (!existsSync(LOG_DIR)) {
  await import("node:fs/promises").then((fs) => fs.mkdir(LOG_DIR, { recursive: true }));
}

const PHASES = ["MVP", "Phase 1", "Phase 2"];
const MAX_TASKS_PER_PHASE = 5;
const MAX_BREAKDOWN_SUBTASKS = 5; // max subtasks when a task fails (one retry level only)
const AGENT_MAP = {
  coder: "crew-coder",
  codex: "crew-coder",
  qa: "crew-qa",
  tester: "crew-qa",
  fixer: "crew-fixer",
  debugger: "crew-fixer",
  security: "security",
  guardian: "security",
};

// Default 5 min per task so "features section" / "agents table" can finish. Override with PHASED_TASK_TIMEOUT_MS.
const DEFAULT_TASK_TIMEOUT_MS = Number(process.env.PHASED_TASK_TIMEOUT_MS || "300000");

function callAgent(agentId, message, timeoutMs = DEFAULT_TASK_TIMEOUT_MS) {
  const env = { ...process.env, OPENCREW_RT_SEND_TIMEOUT_MS: String(timeoutMs) };
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "node",
      [GATEWAY_BRIDGE_PATH, "--send", agentId, message],
      { stdio: ["inherit", "pipe", "pipe"], env }
    );
    let out = "";
    let err = "";
    proc.stdout?.on("data", (d) => {
      out += d.toString();
    });
    proc.stderr?.on("data", (d) => {
      err += d.toString();
    });
    const t = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Timeout (${timeoutMs}ms)`));
    }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0) reject(new Error(err || out || `exit ${code}`));
      else resolve(out.trim() || err.trim());
    });
  });
}

function parseTasksFromPM(text) {
  const tasks = [];
  const lines = (text || "").split(/\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    // crew-coder: Create index.html
    const m1 = line.match(/^(\w+[-]?\w*):\s*(.+)$/i);
    if (m1) {
      const agent = AGENT_MAP[m1[1].toLowerCase()] || (m1[1].startsWith("crew-") ? m1[1] : "crew-coder");
      tasks.push({ agent, task: m1[2].trim() });
      continue;
    }
    // crew-coder create index.html
    const m2 = line.match(/^(\w+[-]?\w*)\s+(.+)$/i);
    if (m2) {
      const agent = AGENT_MAP[m2[1].toLowerCase()] || (m2[1].startsWith("crew-") ? m2[1] : "crew-coder");
      tasks.push({ agent, task: m2[2].trim() });
    }
  }
  return tasks.slice(0, MAX_TASKS_PER_PHASE);
}

/**
 * On task failure, ask PM to break the task into 2–4 smaller subtasks.
 * Returns array of { agent, task }; empty if PM fails or returns too few.
 */
async function breakTaskIntoSubtasks(requirement, phaseName, failedAgent, failedTask) {
  const prompt = `A task failed and must be broken into smaller steps.

Requirement: "${requirement}"
Output directory: ${OUTPUT_DIR}. Every coding task must use this path.
Phase: ${phaseName}
Failed task: ${failedAgent}: ${failedTask}

List 2–4 smaller tasks that together accomplish the same goal. Each = ONE action.
Format: agent: task (one per line)
Agents: crew-coder, crew-qa, crew-fixer, security
Output ONLY the tasks, one per line.`;

  try {
    const reply = await callAgent("crew-pm", prompt);
    const tasks = parseTasksFromPM(reply).slice(0, MAX_BREAKDOWN_SUBTASKS);
    if (tasks.length >= 2) return tasks;
  } catch (_) {}
  return [];
}

async function logDispatch(entry) {
  try {
    await appendFile(DISPATCH_LOG, JSON.stringify(entry) + "\n");
  } catch (_) {}
}

async function runPhase(requirement, phaseName, opId) {
  const prompt = `Requirement: "${requirement}"

Output directory: ALL code and HTML must go in ${OUTPUT_DIR} (create it if needed). Every coding task must mention this path.
For ${phaseName} ONLY, list 3–5 small tasks. Each task = ONE small deliverable only (e.g. "Add orchestration modes subsection" or "Add agents table" — do not combine multiple subsections in one task). Tasks can take up to 5 min.
Format: agent: task (one per line)
Agents: crew-coder, crew-qa, crew-fixer, security
Example:
crew-coder: Create ${OUTPUT_DIR}/index.html with base structure
crew-coder: Add hero section HTML only in ${OUTPUT_DIR}/index.html

${phaseName} tasks:`;

  const reply = await callAgent("crew-pm", prompt);
  const tasks = parseTasksFromPM(reply);
  if (tasks.length === 0) {
    tasks.push({ agent: "crew-coder", task: `${phaseName}: ${requirement}` });
  }

  const results = [];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const taskWithPhase = `[${phaseName}] ${t.task}`;
    console.log(`  [${i + 1}/${tasks.length}] ${t.agent}: ${t.task.substring(0, 60)}...`);
    const start = Date.now();
    try {
      const out = await callAgent(t.agent, taskWithPhase);
      const dur = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`    ✅ ${dur}s`);
      await logDispatch({
        timestamp: new Date().toISOString(),
        op_id: opId,
        phase: phaseName,
        task_num: i + 1,
        agent: t.agent,
        task: t.task,
        status: "completed",
        duration_s: parseFloat(dur),
      });
      results.push({ ok: true, agent: t.agent, task: t.task, output: out });
    } catch (e) {
      const dur = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`    ❌ ${dur}s: ${e.message}`);
      await logDispatch({
        timestamp: new Date().toISOString(),
        op_id: opId,
        phase: phaseName,
        task_num: i + 1,
        agent: t.agent,
        task: t.task,
        status: "failed",
        duration_s: parseFloat(dur),
        error: e.message,
      });
      results.push({ ok: false, agent: t.agent, task: t.task, error: e.message });
      // Break failed task into smaller subtasks and run them
      const subtasks = await breakTaskIntoSubtasks(requirement, phaseName, t.agent, t.task);
      if (subtasks.length > 0) {
        console.log(`    ↳ Breaking into ${subtasks.length} subtasks...`);
        for (let s = 0; s < subtasks.length; s++) {
          const st = subtasks[s];
          const subMsg = `[${phaseName}] ${st.task}`;
          const subStart = Date.now();
          try {
            const out = await callAgent(st.agent, subMsg);
            const subDur = ((Date.now() - subStart) / 1000).toFixed(1);
            console.log(`      [${s + 1}/${subtasks.length}] ${st.agent} ✅ ${subDur}s`);
            await logDispatch({
              timestamp: new Date().toISOString(),
              op_id: opId,
              phase: phaseName,
              task_num: i + 1,
              agent: st.agent,
              task: st.task,
              status: "subtask_completed",
              duration_s: parseFloat(subDur),
              breakdown_of: t.task,
            });
            results.push({ ok: true, agent: st.agent, task: st.task, output: out, breakdown_of: t.task });
          } catch (subErr) {
            const subDur = ((Date.now() - subStart) / 1000).toFixed(1);
            console.log(`      [${s + 1}/${subtasks.length}] ${st.agent} ❌ ${subDur}s: ${subErr.message}`);
            await logDispatch({
              timestamp: new Date().toISOString(),
              op_id: opId,
              phase: phaseName,
              task_num: i + 1,
              agent: st.agent,
              task: st.task,
              status: "subtask_failed",
              duration_s: parseFloat(subDur),
              error: subErr.message,
              breakdown_of: t.task,
            });
            results.push({ ok: false, agent: st.agent, task: st.task, error: subErr.message, breakdown_of: t.task });
          }
        }
      }
    }
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const runAllPhases = args.includes("--all");
  const reqArgs = args.filter((a) => a !== "--all");
  const requirement = reqArgs.join(" ").trim();
  if (!requirement) {
    console.error("Usage: node phased-orchestrator.mjs \"<requirement>\"");
    process.exit(1);
  }

  const opId = `op-${randomUUID().slice(0, 8)}`;
  console.log(`
═══════════════════════════════════════════════════════════════
  PHASED ORCHESTRATOR
  Op: ${opId}
  Requirement: ${requirement.substring(0, 80)}${requirement.length > 80 ? "..." : ""}
═══════════════════════════════════════════════════════════════
`);

  // Step 1: Get PDD (phases) - short prompt
  console.log("📋 Step 1: PM creates PDD (phases)...\n");
  const pddPrompt = `Requirement: "${requirement}"

Output directory: ALL code and HTML must go in ${OUTPUT_DIR} (create it if needed). Every coding task must mention this path.
Break into phases: MVP, Phase 1, Phase 2.
For MVP only: list 3–5 small tasks. Each task = ONE action (coding tasks can take up to 3 min).
Format: agent: task (one per line)
Agents: crew-coder, crew-qa, crew-fixer, security
Output ONLY the MVP tasks, one per line.`;

  let mvpTasks = [];
  try {
    const pddReply = await callAgent("crew-pm", pddPrompt);
    mvpTasks = parseTasksFromPM(pddReply);
    if (mvpTasks.length === 0) {
      mvpTasks = [{ agent: "crew-coder", task: `MVP: Create scaffold for "${requirement}"` }];
    }
  } catch (e) {
    console.error("❌ PM PDD failed:", e.message);
    mvpTasks = [{ agent: "crew-coder", task: requirement }];
  }

  // Execute MVP (prepend [MVP] so RT Messages show phase)
  console.log("\n🚀 Step 2: Executing MVP...\n");
  for (let i = 0; i < mvpTasks.length; i++) {
    const t = mvpTasks[i];
    const taskWithPhase = `[MVP] ${t.task}`;
    console.log(`  [${i + 1}/${mvpTasks.length}] ${t.agent}: ${t.task.substring(0, 60)}...`);
    const start = Date.now();
    try {
      await callAgent(t.agent, taskWithPhase);
      const dur = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`    ✅ ${dur}s`);
      await logDispatch({
        timestamp: new Date().toISOString(),
        op_id: opId,
        phase: "MVP",
        task_num: i + 1,
        agent: t.agent,
        task: t.task,
        status: "completed",
        duration_s: parseFloat(dur),
      });
    } catch (e) {
      const dur = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`    ❌ ${dur}s: ${e.message}`);
      await logDispatch({
        timestamp: new Date().toISOString(),
        op_id: opId,
        phase: "MVP",
        task_num: i + 1,
        agent: t.agent,
        task: t.task,
        status: "failed",
        duration_s: parseFloat(dur),
        error: e.message,
      });
      // Break failed task into smaller subtasks and run them
      const subtasks = await breakTaskIntoSubtasks(requirement, "MVP", t.agent, t.task);
      if (subtasks.length > 0) {
        console.log(`    ↳ Breaking into ${subtasks.length} subtasks...`);
        for (let s = 0; s < subtasks.length; s++) {
          const st = subtasks[s];
          const subMsg = `[MVP] ${st.task}`;
          const subStart = Date.now();
          try {
            await callAgent(st.agent, subMsg);
            const subDur = ((Date.now() - subStart) / 1000).toFixed(1);
            console.log(`      [${s + 1}/${subtasks.length}] ${st.agent} ✅ ${subDur}s`);
            await logDispatch({
              timestamp: new Date().toISOString(),
              op_id: opId,
              phase: "MVP",
              task_num: i + 1,
              agent: st.agent,
              task: st.task,
              status: "subtask_completed",
              duration_s: parseFloat(subDur),
              breakdown_of: t.task,
            });
          } catch (subErr) {
            const subDur = ((Date.now() - subStart) / 1000).toFixed(1);
            console.log(`      [${s + 1}/${subtasks.length}] ${st.agent} ❌ ${subDur}s: ${subErr.message}`);
            await logDispatch({
              timestamp: new Date().toISOString(),
              op_id: opId,
              phase: "MVP",
              task_num: i + 1,
              agent: st.agent,
              task: st.task,
              status: "subtask_failed",
              duration_s: parseFloat(subDur),
              error: subErr.message,
              breakdown_of: t.task,
            });
          }
        }
      }
    }
  }

  if (!runAllPhases) {
    console.log(`
═══════════════════════════════════════════════════════════════
  ✅ MVP complete. To run all phases:
  node phased-orchestrator.mjs --all "${requirement}"
═══════════════════════════════════════════════════════════════
`);
    return;
  }

  // Phase 1
  console.log("\n🚀 Step 3: Executing Phase 1...\n");
  await runPhase(requirement, "Phase 1", opId);

  // Phase 2
  console.log("\n🚀 Step 4: Executing Phase 2...\n");
  await runPhase(requirement, "Phase 2", opId);

  console.log(`
═══════════════════════════════════════════════════════════════
  ✅ All phases complete.
═══════════════════════════════════════════════════════════════
`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
