/**
 * Pipeline wave dispatcher — extracted from crew-lead.mjs
 * Handles: pending dispatches, pipelines, timeouts, quality gates, dispatchTask
 * Supports hermetic testing via CREWSWARM_TEST_MODE env var.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { getStatePath, getConfigPath } from "../runtime/paths.mjs";

let _deps = {};

export function initWaveDispatcher(deps) {
  _deps = { ...deps };
}

export const pendingDispatches = new Map();
export const pendingPipelines = new Map();
export let dispatchTimeoutInterval = null;

// ── Dispatch queue cap (runaway protection) ──────────────────────────────────
// Reads from deps.dispatchQueueLimit first (injectable for tests), then env var, then default 50.
const getQueueLimit = () =>
  _deps.dispatchQueueLimit ?? parseInt(process.env.CREWSWARM_DISPATCH_QUEUE_LIMIT || "50", 10);

export function setDispatchTimeoutInterval(v) {
  dispatchTimeoutInterval = v;
}

function getPipelineStateDir() {
  const dir = getStatePath("pipelines");
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

const _PLANNING_AGENTS_STATIC = new Set(["crew-pm", "crew-copywriter"]);
const _BUILD_AGENTS_STATIC = new Set(["crew-coder", "crew-coder-front", "crew-coder-back", "crew-frontend"]);
const _PLANNING_ROLES = new Set(["researcher", "writer", "orchestrator"]);
const _BUILD_ROLES = new Set(["coder", "ops"]);
const MAX_WAVE_RETRIES = 1;

export function checkDispatchTimeouts() {
  const now = Date.now();
  const dispatchTimeoutMs = _deps.dispatchTimeoutMs ?? 300_000;
  const dispatchClaimedTimeoutMs = _deps.dispatchClaimedTimeoutMs ?? 900_000;
  for (const [taskId, d] of pendingDispatches.entries()) {
    if (d.done) continue;
    const elapsed = now - (d.claimedAt || d.ts);
    const limit = d.claimed ? dispatchClaimedTimeoutMs : dispatchTimeoutMs;
    if (elapsed < limit) continue;

    const agent = d.agent || "?";

    // Before timing out unclaimed tasks: check if agent is on the RT bus
    // If online, auto-claim (they're likely just slow, not offline)
    if (!d.claimed) {
      if (!d._autoExtended) {
        d._autoExtended = true;
        _deps.isAgentOnRtBus?.(agent).then(online => {
          if (online && !d.done) {
            d.claimed = true;
            d.claimedAt = Date.now();
            console.log(`[crew-lead] ⚡ Auto-extending timeout for ${agent} (online on RT bus but slow to claim) — ${dispatchClaimedTimeoutMs / 1000}s`);
            _deps.broadcastSSE?.({ type: "task.claimed", taskId, agent, ts: d.claimedAt, autoExtended: true });
          }
        });
        continue; // give the RT bus check a cycle before timing out
      }
    }

    const sessionId = d.sessionId || "owner";
    const kind = d.claimed ? "claimed_timeout" : "never_claimed";
    pendingDispatches.delete(taskId);
    _deps.emitTaskLifecycle?.("cancelled", { taskId, agentId: agent, taskType: "task", error: { code: "DISPATCH_TIMEOUT", message: `${kind}: no reply within ${Math.round(limit / 1000)}s` } });
    const msg = d.claimed
      ? `[crew-lead] Task to ${agent} timed out after ${Math.round(limit / 1000)}s (agent claimed it but never finished). Consider @@SERVICE restart ${agent}.`
      : `[crew-lead] Task to ${agent} never claimed (no response within ${Math.round(limit / 1000)}s). Agent may be offline — try @@SERVICE restart ${agent} or re-dispatch to another agent.`;
    _deps.appendHistory?.(sessionId, "system", msg);
    _deps.broadcastSSE?.({ type: "task.timeout", taskId, agent, sessionId, kind, ts: now });
    console.log(`[crew-lead] ${kind} taskId=${taskId} agent=${agent} elapsed=${Math.round(elapsed / 1000)}s`);
    _deps.recordAgentTimeout?.(agent);
    if (d.pipelineId) {
      const pipeline = pendingPipelines.get(d.pipelineId);
      if (pipeline?.pendingTaskIds) {
        pipeline.pendingTaskIds.delete(taskId);
        pipeline.waveResults.push(`[Timeout: ${agent} — ${kind} after ${Math.round(limit / 1000)}s]`);
        if (pipeline.pendingTaskIds.size === 0) {
          if (!pipeline.completedWaveResults) pipeline.completedWaveResults = [];
          pipeline.completedWaveResults.push([...pipeline.waveResults]);
          pipeline.currentWave++;
          savePipelineState(d.pipelineId);
          dispatchPipelineWave(d.pipelineId);
        }
      }
    }
  }
}

export function markDispatchClaimed(taskId, agent) {
  const d = pendingDispatches.get(taskId);
  if (!d || d.done) return;
  if (!d.claimed) {
    d.claimed = true;
    d.claimedAt = Date.now();
    const dispatchClaimedTimeoutMs = _deps.dispatchClaimedTimeoutMs ?? 900_000;
    console.log(`[crew-lead] ⚡ ${agent || d.agent} claimed task ${taskId} — extending timeout to ${dispatchClaimedTimeoutMs / 1000}s`);
    _deps.broadcastSSE?.({ type: "task.claimed", taskId, agent: agent || d.agent, ts: d.claimedAt });
  }
}

export function savePipelineState(pipelineId) {
  const pipeline = pendingPipelines.get(pipelineId);
  if (!pipeline) return;
  try {
    const serializable = {
      pipelineId,
      sessionId: pipeline.sessionId,
      steps: pipeline.steps,
      waves: pipeline.waves,
      currentWave: pipeline.currentWave,
      completedWaveResults: pipeline.completedWaveResults || [],
      status: "in_progress",
      savedAt: Date.now(),
    };
    // Persist any dynamic keys (retry counters, etc.)
    for (const [k, v] of Object.entries(pipeline)) {
      if (k.startsWith("_")) serializable[k] = v;
    }
    fs.writeFileSync(
      path.join(getPipelineStateDir(), `${pipelineId}.json`),
      JSON.stringify(serializable, null, 2)
    );
  } catch (e) {
    console.error(`[pipeline-state] Failed to save ${pipelineId}:`, e.message);
  }
}

export function deletePipelineState(pipelineId) {
  try { fs.unlinkSync(path.join(getPipelineStateDir(), `${pipelineId}.json`)); } catch {}
}

export function resumePipelines() {
  let resumed = 0;
  try {
    const files = fs.readdirSync(getPipelineStateDir()).filter(f => f.endsWith(".json"));
    for (const file of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(getPipelineStateDir(), file), "utf8"));
        if (raw.status !== "in_progress") { deletePipelineState(raw.pipelineId); continue; }
        // Don't resume pipelines older than 2 hours (stale)
        if (Date.now() - raw.savedAt > 2 * 60 * 60 * 1000) {
          console.log(`[pipeline-state] Dropping stale pipeline ${raw.pipelineId} (saved ${Math.round((Date.now() - raw.savedAt) / 60000)}m ago)`);
          deletePipelineState(raw.pipelineId); continue;
        }
        console.log(`[pipeline-state] Resuming pipeline ${raw.pipelineId} from wave ${raw.currentWave + 1}/${raw.waves.length}`);
        const pipeline = {
          sessionId: raw.sessionId,
          steps: raw.steps,
          waves: raw.waves,
          currentWave: raw.currentWave,
          waveResults: raw.completedWaveResults?.slice(-1)?.[0] || [],
          completedWaveResults: raw.completedWaveResults || [],
          pendingTaskIds: new Set(),
        };
        // Restore dynamic keys
        for (const [k, v] of Object.entries(raw)) {
          if (k.startsWith("_")) pipeline[k] = v;
        }
        pendingPipelines.set(raw.pipelineId, pipeline);
        dispatchPipelineWave(raw.pipelineId);
        resumed++;
      } catch (e) {
        console.error(`[pipeline-state] Failed to resume ${file}:`, e.message);
      }
    }
  } catch {}
  if (resumed > 0) console.log(`[pipeline-state] Resumed ${resumed} pipeline(s)`);
}

export function cancelAllPipelines(sessionId) {
  if (pendingPipelines.size === 0) return 0;
  let cancelled = 0;
  for (const [pid, pipeline] of pendingPipelines) {
    const waveInfo = `wave ${pipeline.currentWave + 1}/${pipeline.waves.length}`;
    console.log(`[crew-lead] Cancelling pipeline ${pid} (${waveInfo}, ${pipeline.pendingTaskIds.size} pending tasks)`);
    _deps.broadcastSSE?.({ type: "pipeline_cancelled", pipelineId: pid, ts: Date.now() });
    deletePipelineState(pid);
    cancelled++;
  }
  pendingPipelines.clear();
  if (sessionId) {
    _deps.appendHistory?.(sessionId, "system", `Cancelled ${cancelled} running pipeline(s).`);
  }
  return cancelled;
}

export function dispatchPipelineWave(pipelineId) {
  const pipeline = pendingPipelines.get(pipelineId);
  if (!pipeline) return;

  const { waves, currentWave, sessionId, steps } = pipeline;
  if (currentWave >= waves.length) {
    // All waves done
    _deps.broadcastSSE?.({ type: "pipeline_done", pipelineId, ts: Date.now() });
    _deps.appendHistory?.(sessionId, "system", `Pipeline complete — all ${steps.length} steps finished.`);
    console.log(`[crew-lead] Pipeline ${pipelineId} complete`);
    _deps.recordOpsEvent?.("pipeline_completed", { pipelineId, steps: steps.length, sessionId });
    _deps.bumpOpsCounter?.("pipelinesCompleted");
    const completedProjectDir = pipeline.projectDir;
    pendingPipelines.delete(pipelineId);
    deletePipelineState(pipelineId);
    // Phase B: auto-advance to next ROADMAP phase if project is registered with autoAdvance
    if (completedProjectDir) {
      const proj = _deps.readProjectsRegistry?.().find(p => p.outputDir === completedProjectDir);
      if (proj?.autoAdvance === true) setTimeout(() => _deps.autoAdvanceRoadmap?.(completedProjectDir, sessionId), 3000);
    }
    return;
  }

  const waveSteps = waves[currentWave];
  const prevResults = pipeline.waveResults || [];
  let contextBlock = "";
  if (prevResults.length) {
    const filePaths = [];
    for (const r of prevResults) {
      const writeMatches = r.matchAll(/@@WRITE_FILE\s+(\S+)/g);
      for (const m of writeMatches) filePaths.push(m[1]);
      const readMatches = r.matchAll(/@@READ_FILE\s+(\S+)/g);
      for (const m of readMatches) filePaths.push(m[1]);
      const pathMatches = r.matchAll(/(?:wrote|created|saved|updated|output)\s+(?:to\s+)?(\S+\.(?:html|css|js|mjs|ts|tsx|md|json))/gi);
      for (const m of pathMatches) filePaths.push(m[1]);
    }
    const uniquePaths = [...new Set(filePaths)];
    const pathBlock = uniquePaths.length ? `\n\nFiles produced by previous wave: ${uniquePaths.join(", ")}` : "";
    contextBlock = `\n\n[Results from previous pipeline wave]:${pathBlock}\n${prevResults.map((r, i) => `[${i+1}] ${r.slice(0, 2000)}`).join("\n\n")}`;
  }

  pipeline.pendingTaskIds = new Set();
  pipeline.waveResults = [];

  const cfg = _deps.loadConfig?.() ?? {};
  const resolvedAgentNames = waveSteps.map(s => (_deps.resolveAgentId?.(cfg, s.agent) || s.agent));
  _deps.broadcastSSE?.({ type: "pipeline_progress", pipelineId, waveIndex: currentWave, totalWaves: waves.length, waveSize: waveSteps.length, agents: resolvedAgentNames, ts: Date.now() });
  console.log(`[crew-lead] Pipeline ${pipelineId} wave ${currentWave + 1}/${waves.length} — dispatching ${waveSteps.length} agent(s) in parallel: ${resolvedAgentNames.join(", ")}`);
  _deps.recordOpsEvent?.("pipeline_wave_started", { pipelineId, waveIndex: currentWave, agents: resolvedAgentNames });
  savePipelineState(pipelineId);

  // ── Cursor wave path ────────────────────────────────────────────────────
  // When Cursor Waves is enabled and the wave has >1 task, route through the
  // crew-orchestrator Cursor subagent which fans all tasks out in parallel.
  // Single-task waves skip the orchestrator overhead and dispatch directly.
  if (_deps._cursorWavesEnabled && waveSteps.length > 1) {
    const waveManifest = {
      wave: currentWave + 1,
      projectDir: pipeline.projectDir || "",
      context: contextBlock ? contextBlock.slice(0, 3000) : undefined,
      tasks: waveSteps.map(step => {
        let taskText = step.task;
        const isQa = step.agent === "crew-qa" || (step.agent && step.agent.includes("qa"));
        if (isQa && pipeline.projectDir && !/qa-report\.md|Write your report to/i.test(taskText)) {
          taskText += `\n\nWrite your report to ${pipeline.projectDir}/qa-report.md (no other filename).`;
        }
        return { agent: _deps.resolveAgentId?.(cfg, step.agent) || step.agent, task: taskText };
      }),
    };
    const orchestratorTask = [
      `[crew-orchestrator] Execute this wave — dispatch ALL tasks to subagents in parallel:`,
      "```json",
      JSON.stringify(waveManifest, null, 2),
      "```",
      `Fan out all ${waveSteps.length} tasks simultaneously and return combined results.`,
    ].join("\n");

    console.log(`[crew-lead] CURSOR_WAVES: routing wave ${currentWave + 1} through crew-orchestrator (${waveSteps.length} parallel tasks)`);
    const taskId = dispatchTask("crew-orchestrator", { task: orchestratorTask, runtime: "cursor-cli" }, sessionId, {
      pipelineId,
      waveIndex: currentWave,
      projectDir: pipeline.projectDir,
      useCursorCli: true,
    });
    if (taskId && taskId !== true) pipeline.pendingTaskIds.add(taskId);
    return;
  }

  // ── Standard path (individual dispatch per agent) ───────────────────────
  for (const step of waveSteps) {
    let taskText = step.task + contextBlock;
    // QA always writes to projectDir/qa-report.md so reports aren't random filenames
    const isQa = step.agent === "crew-qa" || (step.agent && step.agent.includes("qa"));
    if (isQa && pipeline.projectDir && !/qa-report\.md|Write your report to/i.test(taskText)) {
      taskText += `\n\nWrite your report to ${pipeline.projectDir}/qa-report.md (no other filename).`;
    }
    const stepSpec = {
      task: taskText,
      ...(step.verify ? { verify: step.verify } : {}),
      ...(step.done   ? { done:   step.done   } : {}),
    };
    const taskId = dispatchTask(step.agent, stepSpec, sessionId, { pipelineId, waveIndex: currentWave, projectDir: pipeline.projectDir });
    if (taskId && taskId !== true) pipeline.pendingTaskIds.add(taskId);
  }
}

function isPlanningAgent(agentId) {
  if (_PLANNING_AGENTS_STATIC.has(agentId)) return true;
  const swarm = _deps.tryRead?.(getConfigPath("crewswarm.json"));
  const agent = (swarm?.agents || []).find(a => a.id === agentId);
  return agent?._role ? _PLANNING_ROLES.has(agent._role) : false;
}

function isBuildAgent(agentId) {
  if (_BUILD_AGENTS_STATIC.has(agentId)) return true;
  const swarm = _deps.tryRead?.(getConfigPath("crewswarm.json"));
  const agent = (swarm?.agents || []).find(a => a.id === agentId);
  return agent?._role ? _BUILD_ROLES.has(agent._role) : false;
}

export function checkWaveQualityGate(pipeline, pipelineId) {
  const { waves, currentWave, waveResults, sessionId } = pipeline;
  const waveSteps = waves[currentWave];
  const retryKey = `_retries_wave_${currentWave}`;
  pipeline[retryKey] = pipeline[retryKey] || 0;

  const issues = [];
  const nextWaveHasBuilders = currentWave + 1 < waves.length &&
    waves[currentWave + 1].some(s => isBuildAgent(s.agent));

  // ── Cursor waves path: combined orchestrator output covers all steps ──────
  // When _cursorWavesEnabled routed the wave through crew-orchestrator, we get
  // one combined result that covers all agents. Expand it into virtual per-step
  // results so the gate checks each agent correctly.
  let effectiveResults = waveResults;
  let effectiveSteps = waveSteps;
  const isCursorWaveResult = waveResults.length === 1 && waveSteps.length > 1 &&
    /===\s*WAVE\s+\d+\s+RESULTS\s*===/.test(waveResults[0] || "");
  if (isCursorWaveResult) {
    // Parse per-agent sections from the combined report: "[crew-X]: ..."
    const combined = waveResults[0];
    effectiveResults = waveSteps.map(step => {
      const agentId = step.agent || "";
      const pattern = new RegExp(`\\[${agentId.replace(/-/g, "[-]")}\\]:\\s*([\\s\\S]*?)(?=\\n\\[crew-|===\\s*END WAVE|$)`, "i");
      const m = combined.match(pattern);
      return m ? m[1].trim() : combined; // fallback to full combined if not found
    });
    effectiveSteps = waveSteps;
  }

  for (let i = 0; i < effectiveResults.length; i++) {
    const result = effectiveResults[i];
    const step = effectiveSteps[i] || {};
    const agent = step.agent || "unknown";

    // Check if agent asked a question instead of doing work
    const questionPattern = /(?:^|\n)\s*(?:should I|do you want|which|what|where should|can you clarify|please confirm|could you specify)/im;
    if (questionPattern.test(result) && !result.includes("@@WRITE_FILE")) {
      issues.push(`${agent} asked a question instead of producing output — likely missing context in task`);
    }

    // For planning agents: check they mentioned or produced files
    if (isPlanningAgent(agent) && nextWaveHasBuilders) {
      const hasFilePath = /(?:\/[A-Za-z][\w.-]*){2,}/.test(result);
      const hasWriteFile = /@@WRITE_FILE/.test(result);
      if (!hasFilePath && !hasWriteFile) {
        issues.push(`${agent} (planning) produced no file references — downstream builders won't know what to read`);
      }
    }

    // For PM specifically: check if PDD was produced when build wave follows
    if (agent === "crew-pm" && nextWaveHasBuilders) {
      const hasPDD = /PDD\.md|product.design.document/i.test(result);
      const hasRoadmap = /ROADMAP\.md/i.test(result);
      if (!hasPDD && !hasRoadmap) {
        issues.push(`crew-pm did not produce PDD.md or ROADMAP.md — build agents need these before starting`);
      }
    }

    // For build agents: check they actually wrote files
    if (isBuildAgent(agent)) {
      const hasWriteFile = /@@WRITE_FILE/.test(result);
      const wroteFile = /(?:wrote|created|saved|written|updated|enhanced|implemented|added)\s+(?:to\s+)?(?:\/\S+|[a-zA-Z][\w/.-]+\.(?:html|css|js|ts|py|json|md|txt|sh|yaml|yml))/i.test(result);
      const opencodeWrote = /(?:←\s*Write|Wrote file|Write\s+\.\.[\w/.-]+\.(?:html|css|js|ts|py|json|md)|Created\s+`\/)/i.test(result);
      const explicitDone = /Done\.\s+(?:Created|Updated|Enhanced|Implemented|The\s+(?:file|prototype|component))/i.test(result);
      // OpenCode agents write silently — check if any src files changed in last 20 min as fallback
      let opencodeFilesChanged = false;
      if (!hasWriteFile && !wroteFile && !opencodeWrote && !explicitDone) {
        try {
          const cutoff = Date.now() - 20 * 60 * 1000;
          const dirs = ["/Users/jeffhobbs/Desktop/polymarket-ai-strat/src"];
          const exts = new Set([".py",".js",".ts",".html",".css",".md"]);
          const checkDir = (d) => {
            try {
              for (const f of fs.readdirSync(d)) {
                const full = path.join(d, f);
                try {
                  const st = fs.statSync(full);
                  if (st.isDirectory()) { if (checkDir(full)) return true; }
                  else if (exts.has(path.extname(f)) && st.mtimeMs > cutoff) return true;
                } catch {}
              }
            } catch {}
            return false;
          };
          opencodeFilesChanged = dirs.some(checkDir);
        } catch {}
      }
      if (!hasWriteFile && !wroteFile && !opencodeWrote && !explicitDone && !opencodeFilesChanged) {
        issues.push(`${agent} (builder) did not write any files`);
      }
    }
  }

  // ── QA FAIL auto-fixer: if a QA agent returned FAIL verdict, insert fixer wave ──
  const qaFixRetryKey = `_qa_fix_retries_wave_${currentWave}`;
  pipeline[qaFixRetryKey] = pipeline[qaFixRetryKey] || 0;
  const MAX_QA_FIX_LOOPS = 2;

  for (let i = 0; i < effectiveResults.length; i++) {
    const result = effectiveResults[i];
    const step = effectiveSteps[i] || {};
    const agent = step.agent || "unknown";
    const isQaAgent = agent === "crew-qa" || agent.includes("qa");
    if (!isQaAgent) continue;

    const hasFailVerdict = /verdict\s*:\s*FAIL/i.test(result);
    const criticalCount = (result.match(/###\s*CRITICAL|severity.*critical/gi) || []).length;

    if ((hasFailVerdict || criticalCount >= 2) && pipeline[qaFixRetryKey] < MAX_QA_FIX_LOOPS) {
      pipeline[qaFixRetryKey]++;
      console.log(`[crew-lead] Pipeline ${pipelineId} QA FAIL detected — auto-dispatching crew-fixer (loop ${pipeline[qaFixRetryKey]}/${MAX_QA_FIX_LOOPS})`);

      const fixerTask = `Fix all CRITICAL and HIGH issues found by crew-qa. QA report:\n\n${result.slice(0, 4000)}\n\nRead each failing file, patch in place (same path, no _fixed variants), run python3 -m py_compile on each fixed file to confirm PASS.`;

      // Insert: fixer wave, then re-run this QA wave
      const qaWaveClone = waveSteps.map(s => ({ ...s, task: s.task.split("\n\n[Quality gate feedback")[0] }));
      waves.splice(currentWave + 1, 0,
        [{ agent: "crew-fixer", task: fixerTask }],
        qaWaveClone
      );

      _deps.broadcastSSE?.({ type: "pipeline_qa_fail_autofix", pipelineId, waveIndex: currentWave, loop: pipeline[qaFixRetryKey], ts: Date.now() });
      _deps.appendHistory?.(sessionId, "system", `QA FAIL detected — auto-dispatching crew-fixer (loop ${pipeline[qaFixRetryKey]}/${MAX_QA_FIX_LOOPS}), then re-running QA.`);

      pipeline.currentWave++;
      dispatchPipelineWave(pipelineId);
      return { pass: false, qaAutoFix: true };
    }
  }

  if (issues.length === 0) {
    console.log(`[crew-lead] Pipeline ${pipelineId} wave ${currentWave + 1} quality gate: PASS`);
    return { pass: true };
  }

  console.log(`[crew-lead] Pipeline ${pipelineId} wave ${currentWave + 1} quality gate: ${issues.length} issue(s)`);
  for (const issue of issues) console.log(`  ⚠️  ${issue}`);

  // Notify user via SSE
  _deps.broadcastSSE?.({
    type: "pipeline_quality_gate",
    pipelineId,
    waveIndex: currentWave,
    issues,
    willRetry: pipeline[retryKey] < MAX_WAVE_RETRIES,
    ts: Date.now(),
  });
  _deps.appendHistory?.(sessionId, "system", `Pipeline wave ${currentWave + 1} quality gate flagged ${issues.length} issue(s): ${issues.join("; ")}. ${pipeline[retryKey] < MAX_WAVE_RETRIES ? "Retrying wave." : "Advancing anyway."}`);

  if (pipeline[retryKey] < MAX_WAVE_RETRIES) {
    pipeline[retryKey]++;
    // Re-dispatch the wave with feedback so agents know what went wrong
    const feedback = `\n\n[Quality gate feedback — FIX THESE ISSUES]:\n${issues.map((iss, i) => `${i + 1}. ${iss}`).join("\n")}\n\nYou MUST produce concrete file output. Do NOT ask questions — use the information you have.`;
    for (const step of waveSteps) {
      step.task = step.task.split("\n\n[Quality gate feedback")[0] + feedback;
    }
    pipeline.pendingTaskIds = new Set();
    pipeline.waveResults = [];
    // Jittered delay before retry — avoids thundering herd when multiple waves fail simultaneously
    const jitterMs = 500 + Math.floor(Math.random() * 1000);
    console.log(`[crew-lead] Retrying wave ${currentWave + 1} with quality feedback (jitter=${jitterMs}ms)`);
    _deps.broadcastSSE?.({ type: "pipeline_progress", pipelineId, waveIndex: currentWave, totalWaves: waves.length, waveSize: waveSteps.length, agents: waveSteps.map(s => s.agent), ts: Date.now() });

    setTimeout(() => {
      for (const step of waveSteps) {
        let taskText = step.task;
        const isQa = step.agent === "crew-qa" || (step.agent && step.agent.includes("qa"));
        if (isQa && pipeline.projectDir && !/qa-report\.md|Write your report to/i.test(taskText)) {
          taskText += `\n\nWrite your report to ${pipeline.projectDir}/qa-report.md (no other filename).`;
        }
        const stepSpec = { task: taskText, ...(step.verify ? { verify: step.verify } : {}), ...(step.done ? { done: step.done } : {}) };
        const taskId = dispatchTask(step.agent, stepSpec, sessionId, { pipelineId, waveIndex: currentWave });
        if (taskId && taskId !== true) pipeline.pendingTaskIds.add(taskId);
      }
    }, jitterMs);
    return { pass: false, retried: true };
  }

  // Max retries exceeded — advance anyway with warning
  console.log(`[crew-lead] Max retries reached for wave ${currentWave + 1} — advancing with issues`);
  return { pass: true };
}

export function dispatchTask(agent, task, sessionId = "owner", pipelineMeta = null) {
  console.log(`[wave-dispatcher] dispatchTask called: agent=${agent}, sessionId=${sessionId}`);
  const cfg = _deps.loadConfig?.() ?? {};
  agent = (_deps.resolveAgentId?.(cfg, agent) || agent);
  // task may be a plain string or a {task, verify, done} spec object
  const taskText = _deps.buildTaskText?.(task) ?? (typeof task === "string" ? task : task?.task ?? "");
  task = taskText; // normalise to string for the rest of this function

  // ── Queue cap: reject if too many tasks are already pending ─────────────
  const queueLimit = getQueueLimit();
  const activePending = [...pendingDispatches.values()].filter(d => !d.done).length;
  if (activePending >= queueLimit) {
    console.warn(`[crew-lead] Dispatch queue full (${activePending}/${queueLimit}) — rejecting task for ${agent}. Raise CREWSWARM_DISPATCH_QUEUE_LIMIT to increase.`);
    _deps.broadcastSSE?.({ type: "task.queue_full", agent, sessionId, queueDepth: activePending, limit: queueLimit, ts: Date.now() });
    return false;
  }

  // ── Correlation ID — threads this task through all lifecycle events ───────
  const correlationId = pipelineMeta?.correlationId
    || pipelineMeta?.pipelineId
    || `corr-${randomUUID().slice(0, 8)}`;

  // For QA and fixer: write a brief file instead of stuffing everything in the prompt
  const isBriefAgent = agent === "crew-qa" || agent === "crew-fixer" || agent.includes("qa");
  if (isBriefAgent && task.length > 800) {
    const projectDir = pipelineMeta?.projectDir || null;
    task = _deps.writeTaskBrief?.(agent, task, projectDir) ?? task;
  }

  const rp = typeof _deps.getRtPublish === "function" ? _deps.getRtPublish() : null;
  console.log(`[wave-dispatcher] getRtPublish exists: ${typeof _deps.getRtPublish === "function"}, rp is: ${typeof rp}`);
  if (rp) {
    try {
      // Build extraFlags: start with global settings, override with pipeline-specific settings
      const globalClaudeCodeEnabled = typeof _deps.getClaudeCodeEnabled === "function" ? _deps.getClaudeCodeEnabled() : false;
      const extraFlags = {};

      // Apply global Claude Code setting if enabled (can be overridden by pipelineMeta)
      if (globalClaudeCodeEnabled && !pipelineMeta?.useClaudeCode) {
        extraFlags.useClaudeCode = true;
      }

      // Pipeline-specific flags override global settings
      if (pipelineMeta?.useClaudeCode !== undefined) extraFlags.useClaudeCode = pipelineMeta.useClaudeCode;
      if (pipelineMeta?.useCursorCli !== undefined) extraFlags.useCursorCli = pipelineMeta.useCursorCli;
      if (pipelineMeta?.runtime) extraFlags.runtime = pipelineMeta.runtime;
      if (pipelineMeta?.projectDir) extraFlags.projectDir = pipelineMeta.projectDir;

      const taskId = rp({ channel: "command", type: "command.run_task", to: agent, payload: { content: task, prompt: task, correlationId, ...extraFlags } });
      if (taskId) {
        pendingDispatches.set(taskId, {
          sessionId, agent, task, ts: Date.now(), correlationId,
          ...(pipelineMeta || {}),
        });
      }
      console.log(`[crew-lead] dispatched via RT to ${agent} (taskId=${taskId} correlationId=${correlationId}): ${task.slice(0, 60)}`);
      _deps.broadcastSSE?.({ type: "agent_working", agent, taskId, correlationId, sessionId, ts: Date.now() });
      _deps.emitTaskLifecycle?.("dispatched", { taskId, agentId: agent, taskType: "task", correlationId });
      return taskId || true;
    } catch (e) {
      console.error(`[crew-lead] RT dispatch failed: ${e.message}`);
    }
  }
  // Fallback: openswitchctl (no reply routing back to crew-lead)
  console.log("[crew-lead] RT not connected — using openswitchctl send (replies won't appear in chat; check RT Messages tab)");
  try {
    const safeTask = task.replace(/"/g, '\\"').replace(/\n/g, " ");
    _deps.execSync?.(`"${_deps.CTL_PATH}" send "${agent}" "${safeTask}"`, { encoding: "utf8", timeout: 10000 });
    console.log(`[crew-lead] dispatched via ctl to ${agent}: ${task.slice(0, 60)}`);
    return true;
  } catch (e) {
    console.error(`[crew-lead] dispatch failed: ${e.message}`);
    return false;
  }
}
