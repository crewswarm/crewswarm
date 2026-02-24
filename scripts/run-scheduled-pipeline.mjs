#!/usr/bin/env node
/**
 * Run a scheduled workflow or skill pipeline from cron.
 *
 * WORKFLOW (agent + task per stage):
 *   Pipeline config: ~/.crewswarm/pipelines/<name>.json
 *   {
 *     "stages": [
 *       { "agent": "crew-copywriter", "task": "Draft a 280-char tweet about …", "tool": "write_file" },
 *       { "agent": "crew-main", "task": "Post the tweet using @@SKILL twitter.post with …", "tool": "skill" }
 *     ]
 *   }
 *   Stages run in order; each stage's reply is passed to the next as [Previous step output].
 *   Requires crew-lead + RT bus so dispatch returns a taskId for polling.
 *
 * LEGACY (skill-only steps):
 *   { "steps": [ { "skill": "twitter.post", "params": { "text": "…" } }, ... ] }
 *
 * Usage:
 *   node scripts/run-scheduled-pipeline.mjs <pipeline-name>
 *   node scripts/run-scheduled-pipeline.mjs --skill twitter.post [--params '{"text":"..."}']
 *
 * Crontab example:
 *   0 9 * * * cd /path/to/CrewSwarm && node scripts/run-scheduled-pipeline.mjs social >> ~/.crewswarm/logs/cron.log 2>&1
 */

import fs from "fs";
import path from "path";
import os from "os";

const CREW_LEAD_PORT = process.env.CREW_LEAD_PORT || "5010";
const CREW_LEAD_URL = `http://127.0.0.1:${CREW_LEAD_PORT}`;
const CONFIG_DIR = process.env.CREWSWARM_CONFIG_DIR || path.join(os.homedir(), ".crewswarm");
const PIPELINES_DIR = path.join(CONFIG_DIR, "pipelines");
const POLL_INTERVAL_MS = 2000;
const WORKFLOW_STAGE_TIMEOUT_MS = 120000;

function getToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, "config.json"), "utf8"));
    return cfg?.rt?.authToken || "";
  } catch {
    return "";
  }
}

function authHeaders(token) {
  const h = { "Content-Type": "application/json" };
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

async function runSkill(skillName, params, token) {
  const url = `${CREW_LEAD_URL}/api/skills/${encodeURIComponent(skillName)}/run`;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ params: params || {} }),
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function dispatch(agent, task, token, sessionId = "cron") {
  const res = await fetch(`${CREW_LEAD_URL}/api/dispatch`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ agent, task, sessionId }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

async function pollStatus(taskId, token) {
  const url = `${CREW_LEAD_URL}/api/status/${encodeURIComponent(taskId)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: authHeaders(token),
    signal: AbortSignal.timeout(5000),
  });
  const data = await res.json().catch(() => ({}));
  return data;
}

async function waitForCompletion(taskId, token, log) {
  const deadline = Date.now() + WORKFLOW_STAGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const st = await pollStatus(taskId, token);
    if (st.status === "done") return { ok: true, result: st.result ?? "" };
    if (st.status === "unknown") return { ok: false, result: "", error: "taskId unknown" };
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { ok: false, result: "", error: "timeout" };
}

async function runWorkflowStages(stages, token, log) {
  let prevOutput = "";
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const agent = stage.agent;
    const task = stage.task || stage.taskText;
    const toolHint = stage.tool ? ` [tool: ${stage.tool}]` : "";
    if (!agent || !task) {
      log(`Stage ${i + 1}: missing agent or task, skipping`);
      continue;
    }
    const taskText = prevOutput
      ? `${task}\n\n[Previous step output]:\n${prevOutput.slice(0, 2000)}`
      : task;
    log(`Stage ${i + 1}/${stages.length}: ${agent}${toolHint}`);
    const { ok, data } = await dispatch(agent, taskText, token);
    if (!ok || !data?.taskId) {
      log(`Stage ${i + 1} dispatch failed: ${data?.error || "no taskId (RT bus required)"}`);
      return false;
    }
    const taskId = data.taskId;
    const completed = await waitForCompletion(taskId, token, log);
    if (!completed.ok) {
      log(`Stage ${i + 1} ${completed.error || "failed"}`);
      return false;
    }
    prevOutput = typeof completed.result === "string" ? completed.result : JSON.stringify(completed.result || "");
    log(`Stage ${i + 1} done`);
  }
  return true;
}

async function runSkillSteps(steps, token, log) {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const skill = step.skill || step.name;
    const params = step.params || {};
    if (!skill) {
      log(`Step ${i + 1}: missing "skill", skipping`);
      continue;
    }
    log(`Step ${i + 1}/${steps.length}: ${skill}`);
    const { ok, status, data } = await runSkill(skill, params, token);
    if (ok) {
      log(`${skill}: ok`);
    } else {
      log(`${skill}: ${status} ${data?.error || JSON.stringify(data)}`);
      return false;
    }
  }
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const token = getToken();
  const ts = () => new Date().toISOString();
  const log = (msg) => console.log(`[${ts()}] ${msg}`);
  const logErr = (msg) => console.error(`[${ts()}] ${msg}`);

  if (args[0] === "--skill") {
    const skill = args[1];
    if (!skill) {
      console.error("Usage: run-scheduled-pipeline.mjs --skill <skill.name> [--params '{}']");
      process.exit(1);
    }
    let params = {};
    const paramsIdx = args.indexOf("--params");
    if (paramsIdx !== -1 && args[paramsIdx + 1]) {
      try {
        params = JSON.parse(args[paramsIdx + 1]);
      } catch (e) {
        console.error("Invalid --params JSON:", e.message);
        process.exit(1);
      }
    }
    log(`Running single skill: ${skill}`);
    const { ok } = await runSkillSteps([{ skill, params }], token, log);
    process.exit(ok ? 0 : 1);
  }

  const name = args[0];
  if (!name) {
    console.error("Usage: run-scheduled-pipeline.mjs <pipeline-name>");
    console.error("       run-scheduled-pipeline.mjs --skill <skill.name> [--params '{}']");
    console.error("Pipeline config: ~/.crewswarm/pipelines/<name>.json");
    console.error("  Workflow: { \"stages\": [ { \"agent\", \"task\", \"tool?\" }, ... ] }");
    console.error("  Skills:   { \"steps\": [ { \"skill\", \"params\" }, ... ] }");
    process.exit(1);
  }

  const pipelinePath = path.join(PIPELINES_DIR, `${name}.json`);
  if (!fs.existsSync(pipelinePath)) {
    logErr(`Pipeline not found: ${pipelinePath}`);
    process.exit(1);
  }

  let pipeline;
  try {
    pipeline = JSON.parse(fs.readFileSync(pipelinePath, "utf8"));
  } catch (e) {
    logErr(`Failed to read pipeline: ${e.message}`);
    process.exit(1);
  }

  const stages = pipeline.stages;
  const steps = pipeline.steps;

  if (stages?.length) {
    log(`Workflow "${name}": ${stages.length} stage(s)`);
    const ok = await runWorkflowStages(stages, token, log);
    process.exit(ok ? 0 : 1);
  }

  if (steps?.length) {
    log(`Skill pipeline "${name}": ${steps.length} step(s)`);
    const ok = await runSkillSteps(steps, token, log);
    process.exit(ok ? 0 : 1);
  }

  logErr("Pipeline has no \"stages\" or \"steps\".");
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
