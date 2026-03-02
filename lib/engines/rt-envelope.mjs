/**
 * Real-time envelope handler — processes incoming RT bus commands and tasks.
 * All dependencies are injected via initRtEnvelope(deps).
 */
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { recordTaskMemory, isSharedMemoryAvailable } from "../memory/shared-adapter.mjs";
import { selectEngine } from "./runners.mjs";

let _deps = {};

export function initRtEnvelope(deps) {
  _deps = deps;
}

export async function handleRealtimeEnvelope(envelope, client, bridge) {
  const payload = envelope?.payload && typeof envelope.payload === "object" ? envelope.payload : {};
  const taskId = envelope?.taskId || "";
  const incomingType = envelope?.type || "event";
  const from = envelope?.from || "unknown";
  const to = envelope?.to || "broadcast";
  const correlationId = envelope?.id || undefined;

  const {
    CREWSWARM_RT_AGENT,
    CREWSWARM_RT_COMMAND_TYPES,
    pendingCmdApprovals,
    resolveSpawnTargets,
    spawnAgentDaemon,
    isAgentDaemonRunning,
    readPid,
    dispatchKeyForTask,
    shouldUseDispatchGuard,
    acquireTaskLease,
    renewTaskLease,
    releaseTaskLease,
    markTaskDone,
    telemetry,
    buildTaskPrompt,
    getOpencodeProjectDir,
    assertTaskPromptProtocol,
    selectEngine,
    runGenericEngineTask,
    loadGenericEngines,
    progress,
    getAgentOpenCodeConfig,
    buildMiniTaskForOpenCode,
    runOuroborosStyleLoop,
    runCursorCliTask,
    runClaudeCodeTask,
    runCodexTask,
    runDockerSandboxTask,
    runGeminiCliTask,
    runCrewCLITask,
    runOpenCodeTask,
    callLLMDirect,
    extractProjectDirFromTask,
    loadAgentPrompts,
    stripThink,
    executeToolCalls,
    validateCodingArtifacts,
    isCodingTask,
    shouldRetryTaskFailure,
    CREWSWARM_RT_DISPATCH_LEASE_MS,
    CREWSWARM_RT_DISPATCH_HEARTBEAT_MS,
    CREWSWARM_RT_DISPATCH_MAX_RETRIES,
    CREWSWARM_RT_DISPATCH_MAX_RETRIES_CODING,
    CREWSWARM_RT_DISPATCH_RETRY_BACKOFF_MS,
    CREWSWARM_OPENCODE_AGENT,
    CREWSWARM_OPENCODE_MODEL,
    OPENCODE_FREE_MODEL_CHAIN,
    RT_TO_GATEWAY_AGENT_MAP,
    SHARED_MEMORY_DIR,
    SWARM_DLQ_DIR,
    COORDINATOR_AGENT_IDS,
  } = _deps;

  // Per-agent routing: skip tasks not addressed to us (unless broadcast)
  if (to !== "broadcast" && to !== CREWSWARM_RT_AGENT) {
    client.ack({ messageId: envelope.id, status: "skipped", note: `not for us (to=${to}, we=${CREWSWARM_RT_AGENT})` });
    return;
  }

  if (!CREWSWARM_RT_COMMAND_TYPES.has(incomingType)) {
    client.ack({ messageId: envelope.id, status: "skipped", note: `unsupported type ${incomingType}` });
    return;
  }

  // ── cmd approval resolution (from crew-lead via RT bus) ───────────────────
  if (incomingType === "cmd.approved" || incomingType === "cmd.rejected") {
    const approvalId = payload?.approvalId;
    if (approvalId && pendingCmdApprovals.has(approvalId)) {
      const pending = pendingCmdApprovals.get(approvalId);
      clearTimeout(pending.timer);
      pendingCmdApprovals.delete(approvalId);
      pending.resolve(incomingType === "cmd.approved");
      console.log(`[${CREWSWARM_RT_AGENT}] cmd ${incomingType === "cmd.approved" ? "✅ approved" : "⛔ rejected"}: ${approvalId}`);
    }
    try { client.ack({ messageId: envelope.id, status: "done", note: `cmd ${incomingType}` }); } catch {}
    return;
  }

  const action = String(payload.action || payload.command || "run_task").trim().toLowerCase();
  if (incomingType === "command.spawn_agent") {
    const targets = resolveSpawnTargets(payload);
    const results = targets.map((agent) => spawnAgentDaemon(agent));
    client.publish({
      channel: "done",
      type: "task.done",
      to: from,
      taskId,
      correlationId,
      priority: "high",
      payload: {
        source: CREWSWARM_RT_AGENT,
        incomingType,
        action: "spawn_agent",
        results,
      },
    });
    client.ack({ messageId: envelope.id, status: "done", note: `spawned ${results.length} agent(s)` });
    return;
  }

  if (incomingType === "command.collect_status") {
    const targets = resolveSpawnTargets(payload);
    const status = targets.map((agent) => ({ agent, running: isAgentDaemonRunning(agent), pid: readPid(agent) || null }));
    client.publish({
      channel: "done",
      type: "task.done",
      to: from,
      taskId,
      correlationId,
      priority: "medium",
      payload: {
        source: CREWSWARM_RT_AGENT,
        incomingType,
        action: "collect_status",
        status,
      },
    });
    client.ack({ messageId: envelope.id, status: "done", note: `status for ${status.length} agent(s)` });
    return;
  }

  if (incomingType.startsWith("command.") && action !== "run_task" && action !== "collect_status") {
    client.publish({
      channel: "issues",
      type: "command.unsupported",
      to: from,
      taskId,
      correlationId,
      priority: "medium",
      payload: {
        source: CREWSWARM_RT_AGENT,
        action,
        note: "Legacy bridge supports run_task and collect_status command actions",
      },
    });
    client.ack({ messageId: envelope.id, status: "failed", note: `unsupported action ${action}` });
    return;
  }

  const prompt = payload.prompt || payload.message || payload.description || [payload.title, payload.description].filter(Boolean).join("\n\n");
  if (!prompt || typeof prompt !== "string") {
    client.ack({ messageId: envelope.id, status: "failed", note: "missing prompt/message" });
    return;
  }

  const dispatchAttempt = Number(payload?._dispatchAttempt || 0);
  const dispatchKey = dispatchKeyForTask({
    taskId,
    incomingType,
    prompt,
    idempotencyKey: payload?._dispatchIdempotencyKey || payload?.idempotencyKey,
  });
  const dispatchGuardEnabled = shouldUseDispatchGuard(incomingType);
  let dispatchClaim = null;
  let dispatchHeartbeat = null;

  if (dispatchGuardEnabled) {
    try {
      dispatchClaim = acquireTaskLease({
        key: dispatchKey,
        source: incomingType,
        incomingType,
        from,
        leaseMs: CREWSWARM_RT_DISPATCH_LEASE_MS,
      });
    } catch (err) {
      telemetry("dispatch_claim_error", {
        key: dispatchKey,
        taskId,
        incomingType,
        error: err?.message ?? String(err),
      });
      client.ack({ messageId: envelope.id, status: "failed", note: "dispatch claim error" });
      return;
    }

    if (!dispatchClaim?.acquired) {
      const reason = dispatchClaim?.reason || "claimed";
      telemetry("dispatch_claim_skipped", {
        key: dispatchKey,
        taskId,
        incomingType,
        reason,
        claimedBy: dispatchClaim?.claimedBy || null,
      });
      const note = reason === "already_done"
        ? "duplicate task already completed"
        : `task claimed by ${dispatchClaim?.claimedBy || "another agent"}`;
      if (reason === "already_done" && dispatchClaim?.doneRecord?.reply) {
        client.publish({
          channel: "done",
          type: "task.done",
          to: from,
          taskId,
          correlationId,
          priority: "medium",
          payload: {
            source: CREWSWARM_RT_AGENT,
            incomingType,
            reply: dispatchClaim.doneRecord.reply,
            duplicate: true,
            idempotencyKey: dispatchKey,
            completedBy: dispatchClaim.doneRecord.agent || null,
            completedAt: dispatchClaim.doneRecord.doneAt || null,
          },
        });
      }
      client.ack({ messageId: envelope.id, status: "skipped", note });
      return;
    }

    dispatchHeartbeat = setInterval(() => {
      const renewed = renewTaskLease({
        key: dispatchKey,
        claimId: dispatchClaim.claimId,
        leaseMs: CREWSWARM_RT_DISPATCH_LEASE_MS,
      });
      if (!renewed) {
        telemetry("dispatch_lease_lost", {
          key: dispatchKey,
          taskId,
          incomingType,
          claimId: dispatchClaim?.claimId,
        });
      }
    }, CREWSWARM_RT_DISPATCH_HEARTBEAT_MS);

    telemetry("dispatch_claim_acquired", {
      key: dispatchKey,
      taskId,
      incomingType,
      claimId: dispatchClaim.claimId,
      attempt: dispatchAttempt,
    });
  }

  client.ack({ messageId: envelope.id, status: "received", note: `crewswarm accepted ${incomingType}` });
  client.publish({
    channel: "status",
    type: "task.in_progress",
    to: from,
    taskId,
    correlationId,
    priority: "high",
    payload: {
      source: CREWSWARM_RT_AGENT,
      note: `Processing ${incomingType}`,
      action,
      idempotencyKey: dispatchKey,
      attempt: dispatchAttempt,
    },
  });

  try {
    const taskProjectDir = payload?.projectDir || getOpencodeProjectDir() || null;
    const { finalPrompt, sharedMemory } = buildTaskPrompt(prompt, `Realtime task from ${from} (${incomingType})`, CREWSWARM_RT_AGENT, { projectDir: taskProjectDir });
    if (sharedMemory.loadFailed || finalPrompt === "MEMORY_LOAD_FAILED") {
      throw new Error("MEMORY_LOAD_FAILED");
    }
    assertTaskPromptProtocol(finalPrompt, "realtime");

    // ── Dynamic Engine Selection (registry-based) ──────────────────────────────
    const selectedEngine = selectEngine(payload, incomingType);
    
    if (selectedEngine) {
      progress(`Routing to ${selectedEngine.label || selectedEngine.id} (priority ${selectedEngine.priority})...`);
      telemetry(`realtime_route_${selectedEngine.id}`, { taskId, incomingType, from, agent: CREWSWARM_RT_AGENT });
    } else {
      // Fall back to OpenCode or direct LLM if no engine matches
      progress(`No engine matched — falling back to OpenCode or direct LLM`);
      telemetry("realtime_route_fallback", { taskId, incomingType, from, agent: CREWSWARM_RT_AGENT });
    }
    
    // Emit working indicator for ALL tasks
    client?.publish({ channel: "events", type: "agent_working", to: "broadcast", payload: { agent: CREWSWARM_RT_AGENT, ts: Date.now() } });

    let reply;
    let ocAgentId = null;
    let agentSysPrompt = null;
    let projectDir = taskProjectDir || null;
    let engineUsed = selectedEngine?.id || null;
    let modelUsed = null;
    
    // Token budget tracking (progressive disclosure pattern)
    const estimateTokens = (text) => Math.ceil((text || '').length / 4);
    const contextTokens = estimateTokens(finalPrompt);
    const maxContextTokens = 100000; // Conservative default, can be model-specific
    const tokenBudgetWarning = contextTokens > (maxContextTokens * 0.7) 
      ? `\n\n⏰ **Context Budget:** ${contextTokens.toLocaleString()} / ${maxContextTokens.toLocaleString()} tokens used (${Math.round(contextTokens/maxContextTokens*100)}%). Prioritize completing current work before adding more context.`
      : '';
    
    // Inject warning into prompt if near limit
    let finalPromptWithBudget = finalPrompt;
    if (tokenBudgetWarning) {
      finalPromptWithBudget = finalPrompt + tokenBudgetWarning;
      telemetry("token_budget_warning", { taskId, contextTokens, maxContextTokens, utilization: contextTokens/maxContextTokens });
    }
    
    // Adaptive reasoning budget (LangChain pattern: xhigh-high-xhigh sandwich)
    const isPlanning = /plan|design|architect|scope|roadmap|strategy/i.test(prompt);
    const isVerification = /verify|test|check|validate|review|audit/i.test(prompt);
    const reasoningBudget = isPlanning ? 'xhigh' : isVerification ? 'xhigh' : 'high';
    
    const adaptivePayload = {
      ...payload,
      reasoningBudget,
      contextTokens,
      tokenBudgetWarning: !!tokenBudgetWarning
    };
    
    telemetry("task_start", { 
      taskId, 
      incomingType, 
      contextTokens, 
      reasoningBudget,
      isPlanning,
      isVerification
    });

    // ── Execute via selected engine ─────────────────────────────────────────────
    if (selectedEngine && selectedEngine.run) {
      projectDir = payload?.projectDir || getOpencodeProjectDir() || process.cwd();
      projectDir = String(projectDir).replace(/[.,;!?]+$/, "");
      const enginePrompt = await buildMiniTaskForOpenCode(prompt, CREWSWARM_RT_AGENT, projectDir);
      const agentCfg = getAgentOpenCodeConfig(CREWSWARM_RT_AGENT);
      modelUsed = payload?.model || agentCfg.model || 'unknown';
      
      try {
        // Check for ouroboros-style loop mode
        if (agentCfg.loop && (selectedEngine.id === 'cursor' || selectedEngine.id === 'claude-code')) {
          progress(`${selectedEngine.label} loop mode: LLM ↔ Engine until DONE…`);
          try {
            reply = await runOuroborosStyleLoop(prompt, CREWSWARM_RT_AGENT, projectDir, payload, progress, selectedEngine.id);
          } catch (e) {
            progress(`${selectedEngine.label} loop failed: ${e?.message?.slice(0, 80)} — falling back to single shot`);
            reply = await selectedEngine.run(enginePrompt, { ...payload, agentId: CREWSWARM_RT_AGENT, projectDir });
          }
        } else {
          reply = await selectedEngine.run(enginePrompt, { ...payload, agentId: CREWSWARM_RT_AGENT, projectDir });
        }
      } catch (e) {
        const msg = e?.message ?? String(e);
        const isUsageLimit = /usage.*limit|hit.*limit|quota.*exceeded|limit.*reset/i.test(msg);
        if (isUsageLimit) {
          progress(`${selectedEngine.label} usage limit hit: ${msg.slice(0, 120)}`);
          telemetry(`${selectedEngine.id}_usage_limit`, { taskId, error: msg });
          reply = `❌ ${selectedEngine.label} usage limit reached:\n\n${msg}\n\n(Fallback disabled to show you the error)`;
        } else {
          progress(`${selectedEngine.label} failed: ${msg.slice(0, 120)} — falling back to direct LLM`);
          telemetry(`${selectedEngine.id}_fallback`, { taskId, error: msg });
          reply = await callLLMDirect(finalPrompt, CREWSWARM_RT_AGENT, null);
        }
      }
    } else {
      // No engine matched — fall back to OpenCode or direct LLM
      engineUsed = "opencode";
      projectDir = payload?.projectDir || getOpencodeProjectDir() || null;
      if (!projectDir || projectDir === process.cwd()) {
        const fromTask = extractProjectDirFromTask(prompt);
        if (fromTask) projectDir = fromTask;
      }
      projectDir = projectDir || process.cwd();
      const ocAgentCfg = getAgentOpenCodeConfig(CREWSWARM_RT_AGENT);
      modelUsed = payload?.model || ocAgentCfg.model || CREWSWARM_OPENCODE_MODEL;
      let opencodeErr;

      if (ocAgentCfg.loop) {
        // Ouroboros-style: LLM decomposes → OpenCode executes each step → repeat until DONE
        progress("OpenCode loop mode: LLM ↔ OpenCode until DONE...");
        try {
          reply = await runOuroborosStyleLoop(prompt, CREWSWARM_RT_AGENT, projectDir, payload, progress, "opencode");
        } catch (e) {
          opencodeErr = e;
          progress(`OpenCode loop failed: ${e?.message?.slice(0, 80)} — falling back to single shot`);
          const ocPrompt = await buildMiniTaskForOpenCode(prompt, CREWSWARM_RT_AGENT, projectDir);
          reply = await runOpenCodeTask(ocPrompt, payload);
        }
      } else {
        // Single-shot: mini task only (now includes shared memory context)
        const ocPrompt = await buildMiniTaskForOpenCode(prompt, CREWSWARM_RT_AGENT, projectDir);
        try {
          reply = await runOpenCodeTask(ocPrompt, payload);
        } catch (e) {
        opencodeErr = e;
        const msg = e?.message ?? String(e);
        const isRateLimit = /429|rate\s*limit|usage.*limit|quota.*exceeded|too\s*many\s*requests|banner-only/i.test(msg);
        const isTimeout  = /timeout|timed\s*out|stall/i.test(msg);
        if (isRateLimit || isTimeout) {
          // Build rotation chain: free models first, then configured fallback, deduplicated
          // Track ALL tried models (primary + each fallback attempt) to avoid re-trying failed ones
          const primaryModel = String(payload?.model || CREWSWARM_OPENCODE_MODEL);
          const configFallback = getAgentOpenCodeConfig(CREWSWARM_RT_AGENT).fallbackModel;
          const triedModels = new Set([primaryModel]);
          // Per-agent opencodeFallbackModel goes FIRST, then global free chain as safety net
          const chain = [...(configFallback ? [configFallback] : []), ...OPENCODE_FREE_MODEL_CHAIN]
            .filter((m, i, arr) => m !== primaryModel && arr.indexOf(m) === i);
          for (const fbModel of chain) {
            if (triedModels.has(fbModel)) continue; // skip already-tried models
            triedModels.add(fbModel);
            const reason = isTimeout ? "timed out" : "rate limited";
            progress(`OpenCode ${primaryModel} ${reason} — rotating to ${fbModel}`);
            telemetry("realtime_opencode_fallback", { taskId, incomingType, error: msg, fallbackModel: fbModel });
            try {
              reply = await runOpenCodeTask(ocPrompt, { ...payload, model: fbModel });
              if (reply) break;
            } catch (fbErr) {
              opencodeErr = fbErr;
              const fbMsg = fbErr?.message ?? String(fbErr);
              const fbRateLimit = /429|rate\s*limit|usage.*limit|quota.*exceeded|banner-only|stall/i.test(fbMsg);
              if (!fbRateLimit) break; // non-rate-limit/stall error — stop rotating
              // rate-limited/stalled on this fallback too — continue to next in chain
            }
          }
        }
        if (!reply && bridge?.kind === "gateway") {
          telemetry("realtime_opencode_fallback", { taskId, incomingType, error: opencodeErr?.message || msg });
          progress(`OpenCode failed, falling back to legacy gateway: ${(opencodeErr?.message || msg).slice(0, 120)}`);
          const gatewayAgentId = RT_TO_GATEWAY_AGENT_MAP[CREWSWARM_RT_AGENT] || "main";
          reply = await bridge.chat(finalPrompt, gatewayAgentId, { idempotencyKey: dispatchKey });
        } else if (!reply) {
          // Try direct LLM call (uses agent's configured model/provider from crewswarm.json)
          engineUsed = "direct-llm";
          const ocAgentId = RT_TO_GATEWAY_AGENT_MAP[CREWSWARM_RT_AGENT] || "main";
          const agentSysPrompt = loadAgentPrompts()[ocAgentId] || null;
          const agentCfg = getAgentOpenCodeConfig(CREWSWARM_RT_AGENT);
          modelUsed = agentCfg?.model || 'unknown';
          progress(`Trying direct LLM for ${CREWSWARM_RT_AGENT} (mapped: ${ocAgentId})...`);
          reply = await callLLMDirect(finalPrompt, ocAgentId, agentSysPrompt);
          
          if (!reply) {
            // Fall through to legacy gateway (uses its default model)
            progress(`No direct LLM config for ${ocAgentId}, falling back to legacy gateway...`);
            telemetry("realtime_direct_llm_fallback", { taskId, ocAgentId, incomingType });
            assertTaskPromptProtocol(finalPrompt, "realtime-gateway-chat");
            reply = await bridge.chat(finalPrompt, ocAgentId, { idempotencyKey: dispatchKey });
          }
        }
      }
    }
  }
    if (!reply || reply === "(timeout - no reply)") {
      throw new Error("Chat timeout while processing realtime task");
    }
    reply = stripThink(reply);

    // Execute any tool calls — suppress @@WRITE_FILE if searches are pending in the same reply
    const toolResults = await executeToolCalls(reply, CREWSWARM_RT_AGENT, { suppressWriteIfSearchPending: true });
    if (toolResults.length > 0) {
      reply = reply + "\n\n---\n**Tool execution results:**\n" + toolResults.join("\n");
      telemetry("agent_tools_executed", { taskId, agent: CREWSWARM_RT_AGENT, count: toolResults.length });

      // Do a follow-up LLM call whenever:
      // (a) searches ran (agent needs to see results before writing), OR
      // (b) write was suppressed (agent tried to write before searching)
      const hasSearchResults = toolResults.some(r => r.includes("[tool:web_search]") || r.includes("[tool:web_fetch]") || r.includes("[tool:read_file]"));
      const writeSuppressed = toolResults.some(r => r.includes("⏸ Write suppressed"));
      const didWriteFile = toolResults.some(r => r.includes("[tool:write_file] ✅"));

      if (hasSearchResults && (!didWriteFile || writeSuppressed)) {
        try {
          const followUpPrompt = `${agentSysPrompt || ""}\n\n[Original task]:\n${finalPrompt}\n\n[Tool results from your searches]:\n${toolResults.join("\n")}\n\nUsing ONLY the search results above (not your training data), write the complete output now using @@WRITE_FILE. Do not search again — just synthesize and write.`;
          let followUpReply = ocAgentId
            ? await callLLMDirect(followUpPrompt, ocAgentId, agentSysPrompt)
            : null;
          if (!followUpReply) followUpReply = await bridge.chat(followUpPrompt, ocAgentId || "main", { idempotencyKey: dispatchKey + "-followup" });
          followUpReply = stripThink(followUpReply);
          const followUpTools = await executeToolCalls(followUpReply, CREWSWARM_RT_AGENT);
          reply = reply + "\n\n" + followUpReply;
          if (followUpTools.length > 0) {
            reply = reply + "\n\n---\n**Follow-up tool results:**\n" + followUpTools.join("\n");
          }
        } catch (err) {
          console.warn(`[bridge] Follow-up synthesis call failed: ${err.message}`);
        }
      }
    }

    // Append original task spec for self-verification (LangChain pattern)
    // Helps agent confirm implementation matches ALL requirements
    if (reply && prompt && !reply.includes('[ORIGINAL TASK]')) {
      const taskSpecReminder = `\n\n---\n**[ORIGINAL TASK]:**\n${prompt.slice(0, 500)}${prompt.length > 500 ? '...' : ''}\n\nDoes your implementation address ALL requirements above?`;
      reply = reply + taskSpecReminder;
      telemetry("task_spec_injected", { taskId, promptLength: prompt.length });
    }

    // Validate coding artifacts for coding tasks
    const validation = validateCodingArtifacts(reply, incomingType, prompt, payload);
    if (!validation.valid) {
      telemetry("coding_artifact_validation_failed", {
        taskId,
        incomingType,
        reason: validation.reason,
        replyLength: reply.length,
      });

      // Send feedback to agent before retrying
      client.publish({
        channel: "issues",
        type: "task.artifact_missing",
        to: CREWSWARM_RT_AGENT, // Send feedback to self for learning
        taskId,
        correlationId,
        priority: "high",
        payload: {
          source: "gateway",
          error: `CODING_ARTIFACT_MISSING: ${validation.reason}`,
          feedback: "Your reply must include: (1) Files changed with paths, (2) What changed in each file, (3) Command outputs (build/test/lint), (4) Verification steps. Do not reply with only suggestions or 'Done' without evidence.",
          originalPrompt: String(prompt).slice(0, 500),
          replyPreview: String(reply).slice(0, 500),
        },
      });

      throw new Error(`CODING_ARTIFACT_MISSING: ${validation.reason}`);
    }

    if (dispatchGuardEnabled && dispatchClaim?.acquired) {
      markTaskDone({
        key: dispatchKey,
        claimId: dispatchClaim.claimId,
        taskId,
        incomingType,
        from,
        attempt: dispatchAttempt,
        idempotencyKey: dispatchKey,
        reply,
      });
      telemetry("dispatch_task_done", {
        key: dispatchKey,
        taskId,
        incomingType,
        claimId: dispatchClaim.claimId,
      });
    }

    // Parse @@LESSON: tags — write to project brain (if projectDir) or global lessons.md
    // This is how agents contribute durable knowledge without polluting system prompts
    const lessonMatches = [...reply.matchAll(/@@LESSON:\s*([^\n]+)/g)];
    if (lessonMatches.length > 0) {
      const date = new Date().toISOString().slice(0, 10);
      for (const m of lessonMatches) {
        const entry = m[1].trim();
        if (!entry) continue;
        try {
          if (projectDir) {
            const projectMemDir = path.join(projectDir, ".crewswarm");
            fs.mkdirSync(projectMemDir, { recursive: true });
            const projectBrainPath = path.join(projectMemDir, "brain.md");
            if (!fs.existsSync(projectBrainPath)) {
              fs.writeFileSync(projectBrainPath, "# Project Brain\n\nAccumulated knowledge for this project.\n", "utf8");
            }
            fs.appendFileSync(projectBrainPath, `\n## [${date}] ${CREWSWARM_RT_AGENT}: ${entry}\n`, "utf8");
          } else {
            const lessonsPath = path.join(SHARED_MEMORY_DIR, "lessons.md");
            fs.appendFileSync(lessonsPath, `\n## [${date}] ${CREWSWARM_RT_AGENT}: ${entry}\n`, "utf8");
          }
          console.log(`[bridge:${CREWSWARM_RT_AGENT}] @@LESSON → ${projectDir ? path.basename(projectDir) + "/.crewswarm/brain.md" : "lessons.md"}: ${entry.slice(0, 80)}`);
        } catch (e) {
          console.warn(`[bridge:${CREWSWARM_RT_AGENT}] @@LESSON write failed: ${e.message}`);
        }
      }
    }

    // Parse and execute @@DISPATCH commands from coordinator agents only.
    // Canonical format: @@DISPATCH {"agent":"crew-coder","task":"..."}
    // Legacy format also supported: @@DISPATCH:agent-id|task description
    // Non-coordinator agents are blocked from dispatching to prevent loops.
    const COORDINATOR_AGENTS = new Set(COORDINATOR_AGENT_IDS);
    const rawDispatches = COORDINATOR_AGENTS.has(CREWSWARM_RT_AGENT)
      ? (() => {
          const results = [];
          // Canonical JSON format
          for (const m of reply.matchAll(/@@DISPATCH\s+(\{[^}]+\})/g)) {
            try {
              const d = JSON.parse(m[1]);
              if (d.agent && d.task) results.push({ targetAgent: d.agent.trim(), taskText: d.task.trim() });
            } catch {}
          }
          // Legacy pipe format (still supported, normalized here)
          for (const m of reply.matchAll(/@@DISPATCH:([a-z0-9_-]+)\|([^\n@@]+)/g)) {
            results.push({ targetAgent: m[1].trim(), taskText: m[2].trim() });
          }
          return results;
        })()
      : [];
    if (rawDispatches.length > 0) {
      for (const { targetAgent, taskText } of rawDispatches) {
        // Block self-dispatch and empty targets
        if (!targetAgent || !taskText || targetAgent === CREWSWARM_RT_AGENT) continue;
        try {
          // For audit/QA tasks, inject file contents so the agent can actually read them
          let enrichedTask = taskText;
          const filePaths = [...taskText.matchAll(/([~/\w.-]+\.(?:html|css|js|mjs|ts|md|json))/g)].map(m => m[1]);
          if (filePaths.length > 0) {
            const fileSnippets = [];
            for (const fp of filePaths.slice(0, 3)) {
              try {
                const absPath = fp.startsWith("~") ? fp.replace("~", os.homedir()) : fp;
                const content = fs.readFileSync(absPath, "utf8");
                const lines = content.split("\n");
                // Include full file for small files, truncated for large ones
                const snippet = lines.length <= 600
                  ? content
                  : lines.slice(0, 300).join("\n") + `\n\n... (${lines.length - 300} more lines truncated) ...\n` + lines.slice(-100).join("\n");
                fileSnippets.push(`\n\n--- FILE: ${absPath} (${lines.length} lines) ---\n${snippet}\n--- END FILE ---`);
              } catch { /* file not readable, skip */ }
            }
            if (fileSnippets.length > 0) {
              enrichedTask = taskText + "\n\nFile contents for your audit:" + fileSnippets.join("");
            }
          }
          const dispatchTaskId = "dispatch-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
          client.publish({
            channel: "command",
            type: "command.run_task",
            to: targetAgent,
            taskId: dispatchTaskId,
            priority: "high",
            payload: {
              action: "run_task",
              prompt: enrichedTask,
              dispatchedBy: CREWSWARM_RT_AGENT,
              parentTaskId: taskId,
            },
          });
          telemetry("crew_dispatch_forwarded", { from: CREWSWARM_RT_AGENT, to: targetAgent, taskId: dispatchTaskId });
          progress(`Dispatched task to ${targetAgent}: ${taskText.slice(0, 60)}`);
        } catch (dispErr) {
          console.error(`[bridge] CREW_DISPATCH to ${targetAgent} failed:`, dispErr?.message);
        }
      }
    }

    client.publish({
      channel: "done",
      type: "task.done",
      to: from,
      taskId,
      correlationId,
      priority: "high",
      payload: {
        source: CREWSWARM_RT_AGENT,
        reply,
        incomingType,
        idempotencyKey: dispatchKey,
        engineUsed, // Track which coding engine handled the task (claude, codex, cursor, opencode, etc.)
      },
    });
    
    // Record to shared memory (AgentKeeper) for future recall
    if (isSharedMemoryAvailable()) {
      const projectDir = extractProjectDirFromTask(prompt) || getOpencodeProjectDir() || process.cwd();
      recordTaskMemory(projectDir, {
        runId: taskId,
        tier: 'worker',
        task: prompt,
        result: reply,
        agent: CREWSWARM_RT_AGENT,
        model: modelUsed || 'unknown',
        metadata: {
          engineUsed,
          incomingType,
          success: true,
          timestamp: new Date().toISOString()
        }
      }).catch(err => {
        console.warn(`[${CREWSWARM_RT_AGENT}] Failed to record task memory: ${err.message}`);
      });
    }
    
    client?.publish({ channel: "events", type: "agent_idle", to: "broadcast", payload: { agent: CREWSWARM_RT_AGENT, ts: Date.now() } });
    client.ack({ messageId: envelope.id, status: "done", note: "task completed" });
  } catch (err) {
    const message = err?.message ?? String(err);
    const isCoding = isCodingTask(incomingType, prompt, payload);
    const maxRetries = isCoding ? CREWSWARM_RT_DISPATCH_MAX_RETRIES_CODING : CREWSWARM_RT_DISPATCH_MAX_RETRIES;
    const shouldRetry = dispatchGuardEnabled
      && dispatchClaim?.acquired
      && shouldRetryTaskFailure(err)
      && dispatchAttempt < maxRetries;

    if (shouldRetry) {
      const retryAttempt = dispatchAttempt + 1;
      const retryAfterMs = CREWSWARM_RT_DISPATCH_RETRY_BACKOFF_MS * (2 ** dispatchAttempt);
      telemetry("dispatch_retry_scheduled", {
        key: dispatchKey,
        taskId,
        incomingType,
        attempt: retryAttempt,
        retryAfterMs,
        error: message,
      });
      client.publish({
        channel: "status",
        type: "task.retrying",
        to: from,
        taskId,
        correlationId,
        priority: "high",
        payload: {
          source: CREWSWARM_RT_AGENT,
          incomingType,
          attempt: retryAttempt,
          retryAfterMs,
          error: message,
          idempotencyKey: dispatchKey,
        },
      });

      setTimeout(() => {
        try {
          client.publish({
            channel: "command",
            type: incomingType,
            to: CREWSWARM_RT_AGENT,  // Retry to SELF, not broadcast (prevents 7x amplification)
            taskId,
            priority: "high",
            payload: {
              ...payload,
              _dispatchAttempt: retryAttempt,
              _dispatchIdempotencyKey: dispatchKey,
              _dispatchRetryOf: dispatchAttempt,
              _dispatchLastError: message,
            },
          });
        } catch (publishErr) {
          telemetry("dispatch_retry_publish_error", {
            key: dispatchKey,
            taskId,
            incomingType,
            attempt: retryAttempt,
            error: publishErr?.message ?? String(publishErr),
          });
        }
      }, retryAfterMs);

      return;
    }

    // Write to DLQ if all retries exhausted
    if (dispatchGuardEnabled && dispatchClaim?.acquired && dispatchAttempt >= maxRetries) {
      const dlqPath = path.join(SWARM_DLQ_DIR, `${dispatchKey}.json`);
      const dlqEntry = {
        key: dispatchKey,
        taskId,
        incomingType,
        from,
        agent: CREWSWARM_RT_AGENT,
        attempt: dispatchAttempt,
        error: message,
        prompt: String(prompt).slice(0, 2000),
        payload,
        failedAt: new Date().toISOString(),
        envelope,
      };
      try {
        fs.writeFileSync(dlqPath, JSON.stringify(dlqEntry, null, 2), "utf8");
        telemetry("dlq_write", { key: dispatchKey, taskId, incomingType });
      } catch (dlqErr) {
        telemetry("dlq_write_error", { key: dispatchKey, error: dlqErr?.message });
      }

      // ── Auto-escalate to crew-fixer when coding agents exhaust retries ─────
      const ESCALATABLE_AGENTS = new Set([
        "crew-coder", "crew-coder-front", "crew-coder-back", "crew-frontend", "crew-copywriter",
      ]);
      const isSelf = CREWSWARM_RT_AGENT === "crew-fixer"; // prevent fixer→fixer loop
      if (ESCALATABLE_AGENTS.has(CREWSWARM_RT_AGENT) && !isSelf) {
        const fixerTaskId = `fixer-escalation-${Date.now()}`;
        const fixerPrompt =
          `⚠️ Auto-escalation from ${CREWSWARM_RT_AGENT} (failed after ${dispatchAttempt + 1} attempts).\n\n` +
          `**Original task:**\n${String(prompt).slice(0, 1500)}\n\n` +
          `**Error:**\n${message.slice(0, 500)}\n\n` +
          `Use @@READ_FILE to inspect any relevant files, identify the root cause, and fix it.`;
        try {
          client.publish({
            channel: "command",
            type: "command.run_task",
            to: "crew-fixer",
            taskId: fixerTaskId,
            priority: "high",
            payload: { action: "run_task", prompt: fixerPrompt, escalatedFrom: CREWSWARM_RT_AGENT, parentTaskId: taskId },
          });
          telemetry("task_escalated_to_fixer", { fromAgent: CREWSWARM_RT_AGENT, taskId, fixerTaskId });
          console.log(`[${CREWSWARM_RT_AGENT}] ⬆️ Escalated failed task to crew-fixer (${fixerTaskId})`);
        } catch (escErr) {
          console.error(`[${CREWSWARM_RT_AGENT}] Escalation to crew-fixer failed:`, escErr?.message);
        }
      }
      // ─────────────────────────────────────────────────────────────────────────
    }

    client.publish({
      channel: "issues",
      type: "task.failed",
      to: from,
      taskId,
      correlationId,
      priority: "high",
      payload: {
        source: CREWSWARM_RT_AGENT,
        error: message,
        idempotencyKey: dispatchKey,
        attempt: dispatchAttempt,
      },
    });
    client.ack({ messageId: envelope.id, status: "failed", note: message.slice(0, 240) });
  } finally {
    if (dispatchHeartbeat) {
      clearInterval(dispatchHeartbeat);
      dispatchHeartbeat = null;
    }
    if (dispatchGuardEnabled && dispatchClaim?.acquired) {
      const released = releaseTaskLease({ key: dispatchKey, claimId: dispatchClaim.claimId });
      telemetry("dispatch_claim_released", {
        key: dispatchKey,
        taskId,
        incomingType,
        claimId: dispatchClaim.claimId,
        released,
      });
    }
  }
}
