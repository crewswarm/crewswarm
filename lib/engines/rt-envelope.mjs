/**
 * Real-time envelope handler — processes incoming RT bus commands and tasks.
 * All dependencies are injected via initRtEnvelope(deps).
 */

/**
 * @typedef {{
 *   id?: string,
 *   type?: string,
 *   taskId?: string,
 *   from?: string,
 *   to?: string,
 *   channel?: string,
 *   messageType?: string,
 *   correlationId?: string,
 *   priority?: 'low' | 'medium' | 'high',
 *   payload?: RTPayload
 * }} RTEnvelope
 */

/**
 * @typedef {{
 *   action?: string,
 *   command?: string,
 *   content?: string,
 *   prompt?: string,
 *   reply?: string,
 *   source?: string,
 *   agent?: string,
 *   error?: string,
 *   note?: string,
 *   projectId?: string,
 *   originProjectId?: string,
 *   project?: string,
 *   approvalId?: string,
 *   engineUsed?: string,
 *   model?: string,
 *   stalled?: boolean,
 *   ts?: string
 * }} RTPayload
 */

/**
 * @typedef {{
 *   ack: (msg: { messageId?: string, status: string, note?: string }) => void,
 *   publish: (msg: { channel: string, type: string, to?: string, taskId?: string, correlationId?: string, priority?: string, payload: Object }) => void
 * }} RTClient
 */

import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  recordTaskMemory,
  isSharedMemoryAvailable,
} from "../memory/shared-adapter.mjs";
import {
  recordTaskTrace,
} from "../autoharness/index.mjs";
import { selectEngine } from "./runners.mjs";
import { writeToDLQ, shouldDLQ } from "../runtime/dlq.mjs";
import {
  loadProjectMessages,
  saveProjectMessage,
} from "../chat/project-messages.mjs";
import {
  detectMentions,
  handleAutonomousMentions,
} from "../chat/autonomous-mentions.mjs";
import { agentMustNotUseEngineLlmFallback } from "../agent-registry.mjs";
import { normalizeProjectDir } from "../runtime/project-dir.mjs";

// Module load verification
console.log("[rt-envelope] ✅ Module loaded at", new Date().toISOString());
console.log(
  "[rt-envelope] saveProjectMessage type:",
  typeof saveProjectMessage,
);

function formatAgentDisplayName(agentId) {
  if (!agentId) return "agent";
  return String(agentId)
    .replace(/^crew-/, "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

let _deps = {};

export function initRtEnvelope(deps) {
  _deps = deps;
}

/**
 * Process an incoming RT bus envelope — routes commands, tasks, and approvals.
 * @param {RTEnvelope} envelope - The incoming RT bus message envelope
 * @param {RTClient} client - RT client for ack/publish responses
 * @param {Object} bridge - Bridge instance (legacy, may be null)
 * @returns {Promise<void>}
 */
export async function handleRealtimeEnvelope(envelope, client, bridge) {
  const payload =
    envelope?.payload && typeof envelope.payload === "object"
      ? envelope.payload
      : {};
  const taskId = envelope?.taskId || "";
  const incomingType = envelope?.type || "event";
  const from = envelope?.from || "unknown";
  const to = envelope?.to || "broadcast";
  const correlationId = envelope?.id || undefined;
  const projectId =
    payload?.projectId || payload?.originProjectId || payload?.project || "global";

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
    client.ack({
      messageId: envelope.id,
      status: "skipped",
      note: `not for us (to=${to}, we=${CREWSWARM_RT_AGENT})`,
    });
    return;
  }

  if (!CREWSWARM_RT_COMMAND_TYPES.has(incomingType)) {
    client.ack({
      messageId: envelope.id,
      status: "skipped",
      note: `unsupported type ${incomingType}`,
    });
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
      console.log(
        `[${CREWSWARM_RT_AGENT}] cmd ${incomingType === "cmd.approved" ? "✅ approved" : "⛔ rejected"}: ${approvalId}`,
      );
    }
    try {
      client.ack({
        messageId: envelope.id,
        status: "done",
        note: `cmd ${incomingType}`,
      });
    } catch {}
    return;
  }

  const action = String(payload.action || payload.command || "run_task")
    .trim()
    .toLowerCase();
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
    client.ack({
      messageId: envelope.id,
      status: "done",
      note: `spawned ${results.length} agent(s)`,
    });
    return;
  }

  if (incomingType === "command.collect_status") {
    const targets = resolveSpawnTargets(payload);
    const status = targets.map((agent) => ({
      agent,
      running: isAgentDaemonRunning(agent),
      pid: readPid(agent) || null,
    }));
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
    client.ack({
      messageId: envelope.id,
      status: "done",
      note: `status for ${status.length} agent(s)`,
    });
    return;
  }

  if (
    incomingType.startsWith("command.") &&
    action !== "run_task" &&
    action !== "collect_status"
  ) {
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
    client.ack({
      messageId: envelope.id,
      status: "failed",
      note: `unsupported action ${action}`,
    });
    return;
  }

  const prompt =
    payload.prompt ||
    payload.message ||
    payload.description ||
    [payload.title, payload.description].filter(Boolean).join("\n\n");
  if (!prompt || typeof prompt !== "string") {
    client.ack({
      messageId: envelope.id,
      status: "failed",
      note: "missing prompt/message",
    });
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
      client.ack({
        messageId: envelope.id,
        status: "failed",
        note: "dispatch claim error",
      });
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
      const note =
        reason === "already_done"
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

    // ✅ FIX: Emit agent_working IMMEDIATELY after successful claim
    // This prevents tasks from appearing "stuck" if prompt building or engine selection fails
    client?.publish({
      channel: "events",
      type: "agent_working",
      to: "broadcast",
      payload: { agent: CREWSWARM_RT_AGENT, ts: Date.now() },
    });
  }

  client.ack({
    messageId: envelope.id,
    status: "received",
    note: `crewswarm accepted ${incomingType}`,
  });
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
    const taskProjectDir =
      payload?.projectDir || getOpencodeProjectDir() || null;
    const { finalPrompt, sharedMemory } = await buildTaskPrompt(
      prompt,
      `Realtime task from ${from} (${incomingType})`,
      CREWSWARM_RT_AGENT,
      { projectDir: taskProjectDir, projectId },
    );
    if (sharedMemory.loadFailed || finalPrompt === "MEMORY_LOAD_FAILED") {
      throw new Error("MEMORY_LOAD_FAILED");
    }
    assertTaskPromptProtocol(finalPrompt, "realtime");

    // ── Dynamic Engine Selection (registry-based) ──────────────────────────────
    // CRITICAL: Engine selection must use CREWSWARM_RT_AGENT (the agent this gateway represents),
    // NOT payload.agent (which is often undefined in RT dispatch messages).
    // The RT envelope's "to" field routes the message to the right agent gateway;
    // engine selection happens within that agent's gateway process.
    const enrichedPayload = {
      ...payload,
      agent: CREWSWARM_RT_AGENT,
      agentId: CREWSWARM_RT_AGENT,
    };
    console.error(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.error(`[${CREWSWARM_RT_AGENT}] 🔍 ENGINE SELECTION START`);
    console.error(`[${CREWSWARM_RT_AGENT}] TaskID: ${taskId}`);
    console.error(`[${CREWSWARM_RT_AGENT}] IncomingType: ${incomingType}`);
    console.error(`[${CREWSWARM_RT_AGENT}] Agent: ${CREWSWARM_RT_AGENT}`);
    console.error(
      `[${CREWSWARM_RT_AGENT}] Payload flags:`,
      JSON.stringify(
        {
          useCrewCLI: enrichedPayload.useCrewCLI,
          useCursorCli: enrichedPayload.useCursorCli,
          useOpenCode: enrichedPayload.useOpenCode,
          useClaudeCode: enrichedPayload.useClaudeCode,
          runtime: enrichedPayload.runtime,
          executor: enrichedPayload.executor,
        },
        null,
        2,
      ),
    );
    const selectedEngine = selectEngine(enrichedPayload, incomingType);
    console.error(
      `[${CREWSWARM_RT_AGENT}] ✅ SELECTED ENGINE:`,
      selectedEngine
        ? `${selectedEngine.id} (${selectedEngine.label || selectedEngine.id})`
        : "NULL (will fallback)",
    );
    console.error(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    if (selectedEngine) {
      console.error(
        `[${CREWSWARM_RT_AGENT}] 🚀 ROUTING TO: ${selectedEngine.label || selectedEngine.id}`,
      );
      progress(
        `Routing to ${selectedEngine.label || selectedEngine.id}...`,
      );
      telemetry(`realtime_route_${selectedEngine.id}`, {
        taskId,
        incomingType,
        from,
        agent: CREWSWARM_RT_AGENT,
      });
    } else {
      console.error(
        `[${CREWSWARM_RT_AGENT}] ⚠️  NO ENGINE MATCHED — FALLBACK TO OPENCODE OR DIRECT LLM`,
      );
      // Fall back to OpenCode or direct LLM if no engine matches
      progress(`No engine matched — falling back to OpenCode or direct LLM`);
      telemetry("realtime_route_fallback", {
        taskId,
        incomingType,
        from,
        agent: CREWSWARM_RT_AGENT,
      });
    }

    // Emit working indicator for ALL tasks
    client?.publish({
      channel: "events",
      type: "agent_working",
      to: "broadcast",
      payload: { agent: CREWSWARM_RT_AGENT, ts: Date.now() },
    });

    let reply;
    let ocAgentId = null;
    let agentSysPrompt = null;
    let projectDir = taskProjectDir || null;
    let engineUsed = selectedEngine?.id || null;
    let modelUsed = null;

    // Token budget tracking (progressive disclosure pattern)
    const estimateTokens = (text) => Math.ceil((text || "").length / 4);
    const contextTokens = estimateTokens(finalPrompt);
    const maxContextTokens = 100000; // Conservative default, can be model-specific
    const tokenBudgetWarning =
      contextTokens > maxContextTokens * 0.7
        ? `\n\n⏰ **Context Budget:** ${contextTokens.toLocaleString()} / ${maxContextTokens.toLocaleString()} tokens used (${Math.round((contextTokens / maxContextTokens) * 100)}%). Prioritize completing current work before adding more context.`
        : "";

    // Inject warning into prompt if near limit
    let finalPromptWithBudget = finalPrompt;
    if (tokenBudgetWarning) {
      finalPromptWithBudget = finalPrompt + tokenBudgetWarning;
      telemetry("token_budget_warning", {
        taskId,
        contextTokens,
        maxContextTokens,
        utilization: contextTokens / maxContextTokens,
      });
    }

    // Adaptive reasoning budget (LangChain pattern: xhigh-high-xhigh sandwich)
    const isPlanning = /plan|design|architect|scope|roadmap|strategy/i.test(
      prompt,
    );
    const isVerification = /verify|test|check|validate|review|audit/i.test(
      prompt,
    );
    const reasoningBudget = isPlanning
      ? "xhigh"
      : isVerification
        ? "xhigh"
        : "high";

    const adaptivePayload = {
      ...payload,
      reasoningBudget,
      contextTokens,
      tokenBudgetWarning: !!tokenBudgetWarning,
    };

    telemetry("task_start", {
      taskId,
      incomingType,
      contextTokens,
      reasoningBudget,
      isPlanning,
      isVerification,
    });

    // NOTE: agent_working was already emitted right after claim (line ~268)
    // This was moved earlier to prevent "stuck pending" state if prompt/engine selection fails

    // ── Execute via selected engine ─────────────────────────────────────────────
    if (selectedEngine && selectedEngine.run) {
      // Codex/Gemini/Cursor cwd = sandbox root. If dispatch omits projectDir, infer
      // /Users/.../Desktop/<project> from the task so writes go to Chuck (etc.), not repo root.
      let engineProjectDir = payload?.projectDir;
      if (!engineProjectDir) {
        engineProjectDir =
          extractProjectDirFromTask(prompt) ||
          getOpencodeProjectDir() ||
          process.cwd();
      }
      projectDir = String(engineProjectDir).replace(/[.,;!?]+$/, "");
      const expandedPd = normalizeProjectDir(projectDir) || projectDir;
      projectDir = fs.existsSync(expandedPd) ? expandedPd : projectDir;
      if (!fs.existsSync(projectDir)) {
        console.error(
          `[${CREWSWARM_RT_AGENT}] engine cwd: path missing (${projectDir}), using process.cwd()`,
        );
        projectDir = process.cwd();
      }
      const enginePrompt = await buildMiniTaskForOpenCode(
        prompt,
        CREWSWARM_RT_AGENT,
        projectDir,
      );
      const agentCfg = getAgentOpenCodeConfig(CREWSWARM_RT_AGENT);
      modelUsed = payload?.model || agentCfg.model || "unknown";

      // RT `command.run_task` often omits per-agent CLI fields; merge from crewswarm.json
      // so Gemini/Codex/Cursor/Claude get the right `-m` / model flags.
      const enginePayload = {
        ...payload,
        agentId: CREWSWARM_RT_AGENT,
        projectDir,
        model: modelUsed,
      };
      if (enginePayload.geminiCliModel == null && agentCfg.geminiCliModel) {
        enginePayload.geminiCliModel = agentCfg.geminiCliModel;
      }
      if (enginePayload.codexModel == null && agentCfg.codexModel) {
        enginePayload.codexModel = agentCfg.codexModel;
      }
      if (enginePayload.cursorCliModel == null && agentCfg.cursorCliModel) {
        enginePayload.cursorCliModel = agentCfg.cursorCliModel;
      }
      if (enginePayload.claudeCodeModel == null && agentCfg.claudeCodeModel) {
        enginePayload.claudeCodeModel = agentCfg.claudeCodeModel;
      }
      if (enginePayload.crewCliModel == null && agentCfg.crewCliModel) {
        enginePayload.crewCliModel = agentCfg.crewCliModel;
      }

      try {
        // Check for ouroboros-style loop mode
        if (
          agentCfg.loop &&
          (selectedEngine.id === "cursor" ||
            selectedEngine.id === "claude-code")
        ) {
          progress(
            `${selectedEngine.label} loop mode: LLM ↔ Engine until DONE…`,
          );
          try {
            reply = await runOuroborosStyleLoop(
              prompt,
              CREWSWARM_RT_AGENT,
              projectDir,
              enginePayload,
              progress,
              selectedEngine.id,
            );
          } catch (e) {
            progress(
              `${selectedEngine.label} loop failed: ${e?.message?.slice(0, 80)} — falling back to single shot`,
            );
            reply = await selectedEngine.run(enginePrompt, enginePayload);
          }
        } else {
          console.error(
            `[${CREWSWARM_RT_AGENT}] 📞 CALLING ENGINE: ${selectedEngine.id}.run()`,
          );
          console.error(
            `[${CREWSWARM_RT_AGENT}] 📦 Model being sent: ${modelUsed}`,
          );
          reply = await selectedEngine.run(enginePrompt, enginePayload);
          console.error(
            `[${CREWSWARM_RT_AGENT}] ✅ ENGINE RETURNED: ${reply?.length || 0} chars`,
          );
        }
      } catch (e) {
        const msg = e?.message ?? String(e);
        const stack = e?.stack ?? "";
        const isUsageLimit =
          /usage.*limit|hit.*limit|quota.*exceeded|limit.*reset/i.test(msg);

        // Log full error details for debugging
        console.error(`[rt-envelope] Engine error (${selectedEngine.id}):`, {
          message: msg,
          stack: stack.split("\n").slice(0, 5).join("\n"),
          taskId,
          agentId: CREWSWARM_RT_AGENT,
          engineLabel: selectedEngine.label,
        });

        if (isUsageLimit) {
          progress(
            `${selectedEngine.label} usage limit hit: ${msg.slice(0, 120)}`,
          );
          telemetry(`${selectedEngine.id}_usage_limit`, { taskId, error: msg });
          reply = `❌ ${selectedEngine.label} usage limit reached:\n\n${msg}\n\n(Fallback disabled to show you the error)`;
        } else {
          // Agents that assume filesystem / CLI (QA, security, PM, coders, …) must not
          // fall back to LLM-only — user would get fake audits and no qa-report.md.
          const needsEngineExecution =
            agentMustNotUseEngineLlmFallback(CREWSWARM_RT_AGENT);
          const globalDisable = /^1|true|yes$/i.test(
            String(process.env.CREWSWARM_DISABLE_ENGINE_FALLBACK || ""),
          );
          const disableFallback = globalDisable || needsEngineExecution;

          console.error(
            `[${CREWSWARM_RT_AGENT}] ❌ ENGINE ${selectedEngine.id} FAILED: ${msg.slice(0, 200)}`,
          );
          console.error(
            `[${CREWSWARM_RT_AGENT}] Agent type: ${needsEngineExecution ? "TOOL/ENGINE (fail-fast)" : "CONVERSATIONAL (can fallback)"}`,
          );
          console.error(
            `[${CREWSWARM_RT_AGENT}] Fallback disabled: ${disableFallback}`,
          );

          if (disableFallback) {
            // Fail hard mode — throw the error so caller sees it
            progress(
              `❌ ${selectedEngine.label} failed: ${msg.slice(0, 120)} (fallback disabled)`,
            );
            telemetry(`${selectedEngine.id}_failed_no_fallback`, {
              taskId,
              error: msg,
            });
            reply = `❌ **Engine failed**: ${selectedEngine.label} error:\n\n${msg}\n\n${needsEngineExecution ? "(This agent needs the engine for real file/CLI work — fix Codex/Cursor/OpenCode, or switch engine in Settings. No LLM-only fallback.)" : "(Fallback disabled via CREWSWARM_DISABLE_ENGINE_FALLBACK=1)"}`;
          } else {
            // Standard fallback with warning (only for non-coding agents)
            console.error(
              `[${CREWSWARM_RT_AGENT}] 🔄 FALLING BACK TO DIRECT LLM`,
            );
            progress(
              `⚠️ ${selectedEngine.label} failed: ${msg.slice(0, 120)} — falling back to direct LLM (no file access)`,
            );
            telemetry(`${selectedEngine.id}_fallback`, { taskId, error: msg });
            const fallbackReply = await callLLMDirect(
              finalPrompt,
              CREWSWARM_RT_AGENT,
              null,
            );
            reply = `⚠️ **Engine fallback**: ${selectedEngine.label} failed, this response is from LLM only (no file access or code execution).\n\n${fallbackReply}`;
          }
        }
      }
    } else {
      // ── No engine matched — route to direct LLM or OpenCode based on config ──
      // Decision: use OpenCode ONLY if agent explicitly opts in (useOpenCode: true,
      // engine: "opencode", or CREWSWARM_OPENCODE_FORCE=1). Otherwise use direct LLM
      // so agents without a coding engine still get responses via their configured model.
      const ocAgentCfg = getAgentOpenCodeConfig(CREWSWARM_RT_AGENT);
      const forceOpenCode = /^1|true|yes$/i.test(
        String(process.env.CREWSWARM_OPENCODE_FORCE || ""),
      );

      // CRITICAL FIX: Respect explicit useOpenCode: false in config
      // If agent config explicitly disables OpenCode, honor it regardless of tool defaults
      let agentWantsOpenCode = false;
      try {
        const agents = loadAgentList ? loadAgentList() : [];
        const agentCfg = agents.find((a) => a.id === CREWSWARM_RT_AGENT);
        if (agentCfg?.useOpenCode === false) {
          console.error(
            `[${CREWSWARM_RT_AGENT}] ✋ Config explicitly disables OpenCode (useOpenCode: false) — using direct LLM`,
          );
          agentWantsOpenCode = false;
        } else {
          agentWantsOpenCode =
            ocAgentCfg.enabled && (ocAgentCfg.model || forceOpenCode);
        }
      } catch (e) {
        agentWantsOpenCode =
          ocAgentCfg.enabled && (ocAgentCfg.model || forceOpenCode);
      }

      console.error(
        `[${CREWSWARM_RT_AGENT}] ⚠️  FALLBACK PATH: No engine selected. agentWantsOpenCode=${agentWantsOpenCode}, forceOpenCode=${forceOpenCode}, ocEnabled=${ocAgentCfg.enabled}`,
      );

      if (agentWantsOpenCode || forceOpenCode) {
        // Agent explicitly configured for OpenCode — use it
        engineUsed = "opencode";
        projectDir = payload?.projectDir || getOpencodeProjectDir() || null;
        if (!projectDir || projectDir === process.cwd()) {
          const fromTask = extractProjectDirFromTask(prompt);
          if (fromTask) projectDir = fromTask;
        }
        projectDir = projectDir || process.cwd();
        modelUsed =
          payload?.model || ocAgentCfg.model || CREWSWARM_OPENCODE_MODEL;
        let opencodeErr;

        if (ocAgentCfg.loop) {
          progress("OpenCode loop mode: LLM ↔ OpenCode until DONE...");
          try {
            reply = await runOuroborosStyleLoop(
              prompt,
              CREWSWARM_RT_AGENT,
              projectDir,
              payload,
              progress,
              "opencode",
            );
          } catch (e) {
            opencodeErr = e;
            progress(
              `OpenCode loop failed: ${e?.message?.slice(0, 80)} — falling back to single shot`,
            );
            const ocPrompt = await buildMiniTaskForOpenCode(
              prompt,
              CREWSWARM_RT_AGENT,
              projectDir,
            );
            reply = await runOpenCodeTask(ocPrompt, payload);
          }
        } else {
          const ocPrompt = await buildMiniTaskForOpenCode(
            prompt,
            CREWSWARM_RT_AGENT,
            projectDir,
          );
          try {
            reply = await runOpenCodeTask(ocPrompt, payload);
          } catch (e) {
            opencodeErr = e;
            const msg = e?.message ?? String(e);
            const stack = e?.stack ?? "";

            console.error(`[rt-envelope] OpenCode error:`, {
              message: msg,
              stack: stack.split("\n").slice(0, 5).join("\n"),
              taskId,
              agentId: CREWSWARM_RT_AGENT,
              model: payload?.model || CREWSWARM_OPENCODE_MODEL,
            });

            const isRateLimit =
              /429|rate\s*limit|usage.*limit|quota.*exceeded|too\s*many\s*requests|banner-only/i.test(
                msg,
              );
            const isTimeout = /timeout|timed\s*out|stall/i.test(msg);
            const disableFallback = /^1|true|yes$/i.test(
              String(process.env.CREWSWARM_DISABLE_ENGINE_FALLBACK || ""),
            );

            if (disableFallback && (isRateLimit || isTimeout)) {
              progress(
                `❌ OpenCode failed: ${msg.slice(0, 120)} (fallback disabled)`,
              );
              telemetry("realtime_opencode_failed_no_fallback", {
                taskId,
                error: msg,
              });
              reply = `❌ **OpenCode failed**: ${msg}\n\n(Fallback disabled via CREWSWARM_DISABLE_ENGINE_FALLBACK=1)`;
            } else if (isRateLimit || isTimeout) {
              const primaryModel = String(
                payload?.model || CREWSWARM_OPENCODE_MODEL,
              );
              const configFallback =
                getAgentOpenCodeConfig(CREWSWARM_RT_AGENT).fallbackModel;
              const triedModels = new Set([primaryModel]);
              const chain = [
                ...(configFallback ? [configFallback] : []),
                ...OPENCODE_FREE_MODEL_CHAIN,
              ].filter(
                (m, i, arr) => m !== primaryModel && arr.indexOf(m) === i,
              );
              for (const fbModel of chain) {
                if (triedModels.has(fbModel)) continue;
                triedModels.add(fbModel);
                const reason = isTimeout ? "timed out" : "rate limited";
                progress(
                  `OpenCode ${primaryModel} ${reason} — rotating to ${fbModel}`,
                );
                telemetry("realtime_opencode_fallback", {
                  taskId,
                  incomingType,
                  error: msg,
                  fallbackModel: fbModel,
                });
                try {
                  reply = await runOpenCodeTask(ocPrompt, {
                    ...payload,
                    model: fbModel,
                  });
                  if (reply) break;
                } catch (fbErr) {
                  opencodeErr = fbErr;
                  const fbMsg = fbErr?.message ?? String(fbErr);
                  const fbRateLimit =
                    /429|rate\s*limit|usage.*limit|quota.*exceeded|banner-only|stall/i.test(
                      fbMsg,
                    );
                  if (!fbRateLimit) break;
                }
              }
            }
            // OpenCode failed entirely — fall back to direct LLM
            if (!reply) {
              engineUsed = "direct-llm";
              progress(`OpenCode failed — falling back to direct LLM`);
              const ocAgentId =
                RT_TO_GATEWAY_AGENT_MAP[CREWSWARM_RT_AGENT] || "main";
              const agentSysPrompt = loadAgentPrompts()[ocAgentId] || null;
              reply = await callLLMDirect(
                finalPrompt,
                ocAgentId,
                agentSysPrompt,
              );
            }
          }
        }
      } else {
        // ── No coding engine assigned — use direct LLM (agent's configured model) ──
        engineUsed = "direct-llm";
        const ocAgentId = RT_TO_GATEWAY_AGENT_MAP[CREWSWARM_RT_AGENT] || "main";
        const agentSysPrompt = loadAgentPrompts()[ocAgentId] || null;
        const agentCfg = getAgentOpenCodeConfig(CREWSWARM_RT_AGENT);
        modelUsed = agentCfg?.model || payload?.model || "unknown";

        console.error(
          `[${CREWSWARM_RT_AGENT}] 🧠 Direct LLM route (no coding engine): agent=${ocAgentId}, model=${modelUsed}`,
        );
        progress(`Routing to direct LLM (no coding engine assigned)...`);
        telemetry("realtime_route_direct_llm", {
          taskId,
          incomingType,
          agent: CREWSWARM_RT_AGENT,
          model: modelUsed,
        });

        try {
          reply = await callLLMDirect(finalPrompt, ocAgentId, agentSysPrompt);
        } catch (llmErr) {
          const msg = llmErr?.message ?? String(llmErr);
          console.error(`[${CREWSWARM_RT_AGENT}] Direct LLM failed: ${msg}`);

          // Last resort: try legacy gateway if available
          if (bridge?.kind === "gateway") {
            progress(
              `Direct LLM failed — trying legacy gateway: ${msg.slice(0, 80)}`,
            );
            const gatewayAgentId =
              RT_TO_GATEWAY_AGENT_MAP[CREWSWARM_RT_AGENT] || "main";
            reply = await bridge.chat(finalPrompt, gatewayAgentId, {
              idempotencyKey: dispatchKey,
            });
          } else {
            reply = `❌ **No engine available**: No coding engine is assigned to ${CREWSWARM_RT_AGENT} and direct LLM call failed.\n\nError: ${msg}\n\nTo fix: set \`"engine": "crew-cli"\` (or opencode/cursor/gemini-cli/claude-code) in ~/.crewswarm/crewswarm.json for this agent, or set CREWSWARM_OPENCODE_ENABLED=1 to enable OpenCode globally.`;
          }
        }

        if (!reply) {
          // callLLMDirect returned null — no provider configured for this agent
          if (bridge?.kind === "gateway") {
            progress(`No direct LLM config — trying legacy gateway...`);
            const gatewayAgentId =
              RT_TO_GATEWAY_AGENT_MAP[CREWSWARM_RT_AGENT] || "main";
            reply = await bridge.chat(finalPrompt, gatewayAgentId, {
              idempotencyKey: dispatchKey,
            });
          }
          if (!reply) {
            reply = `⚠️ **No engine or LLM configured** for ${CREWSWARM_RT_AGENT}.\n\nTo fix, add this agent to ~/.crewswarm/crewswarm.json with either:\n- \`"engine": "crew-cli"\` (or opencode, cursor, gemini-cli, claude-code)\n- \`"model": "provider/model-id"\` for direct LLM routing\n\nOr set an environment variable: CREWSWARM_CREW_CLI_ENABLED=1, CREWSWARM_OPENCODE_ENABLED=1, etc.`;
          }
        }
      }
    }
    if (!reply || reply === "(timeout - no reply)") {
      throw new Error("Chat timeout while processing realtime task");
    }
    reply = stripThink(reply);
    console.log(`[${CREWSWARM_RT_AGENT}] 🔧 Post-LLM: reply=${reply?.length || 0} chars, starting tool execution...`);

    // Execute gateway-side @@TOOL parsing only for direct-LLM style replies.
    // Native code engines (crew-cli/cursor/claude/codex/gemini-cli/opencode) own
    // their tool execution and file writes; re-parsing here can override engine behavior.
    const engineOwnsTools =
      selectedEngine &&
      [
        "crew-cli",
        "cursor",
        "claude-code",
        "codex",
        "gemini-cli",
        "opencode",
      ].includes(selectedEngine.id);

    const toolResults = engineOwnsTools
      ? []
      : await executeToolCalls(reply, CREWSWARM_RT_AGENT, {
        suppressWriteIfSearchPending: true,
        taskId,
        projectId,
      });
    console.log(`[${CREWSWARM_RT_AGENT}] 🔧 Tool execution done: ${toolResults.length} results`);
    if (toolResults.length > 0) {
      reply =
        reply +
        "\n\n---\n**Tool execution results:**\n" +
        toolResults.join("\n");
      telemetry("agent_tools_executed", {
        taskId,
        agent: CREWSWARM_RT_AGENT,
        count: toolResults.length,
      });

      // Do a follow-up LLM call whenever:
      // (a) searches ran (agent needs to see results before writing), OR
      // (b) write was suppressed (agent tried to write before searching)
      const hasSearchResults = toolResults.some(
        (r) =>
          r.includes("[tool:web_search]") ||
          r.includes("[tool:web_fetch]") ||
          r.includes("[tool:read_file]"),
      );
      const writeSuppressed = toolResults.some((r) =>
        r.includes("⏸ Write suppressed"),
      );
      const didWriteFile = toolResults.some((r) =>
        r.includes("[tool:write_file] ✅"),
      );

      if (hasSearchResults && (!didWriteFile || writeSuppressed)) {
        console.log(`[${CREWSWARM_RT_AGENT}] 🔄 Follow-up synthesis: hasSearch=${hasSearchResults}, didWrite=${didWriteFile}, suppressed=${writeSuppressed}`);
        try {
          const pathGuard = taskProjectDir
            ? `\n\n**Output path rule:** The original task is tied to project directory:\n  ${taskProjectDir}\nYour @@WRITE_FILE path(s) MUST match the file path(s) named in the original task (typically under that directory). Do NOT write to the crewswarm installation repo root or process.cwd() unless the task explicitly requires it.\n`
            : "";
          const followUpPrompt = `${agentSysPrompt || ""}\n\n[Original task]:\n${finalPrompt}\n\n[Tool results from your searches]:\n${toolResults.join("\n")}${pathGuard}\nUsing ONLY the search results above (not your training data), write the complete output now using @@WRITE_FILE. Do not search again — just synthesize and write.`;
          let followUpReply = ocAgentId
            ? await callLLMDirect(followUpPrompt, ocAgentId, agentSysPrompt)
            : null;
          if (!followUpReply)
            followUpReply = await bridge.chat(
              followUpPrompt,
              ocAgentId || "main",
              { idempotencyKey: dispatchKey + "-followup" },
            );
          followUpReply = stripThink(followUpReply);
          const followUpTools = await executeToolCalls(
            followUpReply,
            CREWSWARM_RT_AGENT,
            { taskId, projectId },
          );
          reply = reply + "\n\n" + followUpReply;
          if (followUpTools.length > 0) {
            reply =
              reply +
              "\n\n---\n**Follow-up tool results:**\n" +
              followUpTools.join("\n");
          }
        } catch (err) {
          console.warn(
            `[bridge] Follow-up synthesis call failed: ${err.message}`,
          );
        }
      }
    }

    const requestsExactReply =
      /(?:reply|respond|output|return)\s+with\s+exactly\b/i.test(prompt || "") ||
      /(?:reply|respond|output|return)\s+only\b/i.test(prompt || "") ||
      /and nothing else\b/i.test(prompt || "");

    // Append original task spec for self-verification (LangChain pattern)
    // Skip strict-output prompts where any extra text would violate the task.
    if (
      reply &&
      prompt &&
      !requestsExactReply &&
      !reply.includes("[ORIGINAL TASK]")
    ) {
      const taskSpecReminder = `\n\n---\n**[ORIGINAL TASK]:**\n${prompt.slice(0, 500)}${prompt.length > 500 ? "..." : ""}\n\nDoes your implementation address ALL requirements above?`;
      reply = reply + taskSpecReminder;
      telemetry("task_spec_injected", { taskId, promptLength: prompt.length });
    }

    // Validate coding artifacts for coding tasks
    const validation = validateCodingArtifacts(
      reply,
      incomingType,
      prompt,
      payload,
    );
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
          feedback:
            "Your reply must include: (1) Files changed with paths, (2) What changed in each file, (3) Command outputs (build/test/lint), (4) Verification steps. Do not reply with only suggestions or 'Done' without evidence.",
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
              fs.writeFileSync(
                projectBrainPath,
                "# Project Brain\n\nAccumulated knowledge for this project.\n",
                "utf8",
              );
            }
            fs.appendFileSync(
              projectBrainPath,
              `\n## [${date}] ${CREWSWARM_RT_AGENT}: ${entry}\n`,
              "utf8",
            );
          } else {
            const lessonsPath = path.join(SHARED_MEMORY_DIR, "lessons.md");
            fs.appendFileSync(
              lessonsPath,
              `\n## [${date}] ${CREWSWARM_RT_AGENT}: ${entry}\n`,
              "utf8",
            );
          }
          console.log(
            `[bridge:${CREWSWARM_RT_AGENT}] @@LESSON → ${projectDir ? path.basename(projectDir) + "/.crewswarm/brain.md" : "lessons.md"}: ${entry.slice(0, 80)}`,
          );
        } catch (e) {
          console.warn(
            `[bridge:${CREWSWARM_RT_AGENT}] @@LESSON write failed: ${e.message}`,
          );
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
              if (d.agent && d.task)
                results.push({
                  targetAgent: d.agent.trim(),
                  taskText: d.task.trim(),
                });
            } catch {}
          }
          // Legacy pipe format (still supported, normalized here)
          for (const m of reply.matchAll(
            /@@DISPATCH:([a-z0-9_-]+)\|([^\n@@]+)/g,
          )) {
            results.push({ targetAgent: m[1].trim(), taskText: m[2].trim() });
          }
          return results;
        })()
      : [];
    if (rawDispatches.length > 0) {
      for (const { targetAgent, taskText } of rawDispatches) {
        // Block self-dispatch and empty targets
        if (!targetAgent || !taskText || targetAgent === CREWSWARM_RT_AGENT)
          continue;
        try {
          // For audit/QA tasks, inject file contents so the agent can actually read them
          let enrichedTask = taskText;
          const filePaths = [
            ...taskText.matchAll(
              /([~/\w.-]+\.(?:html|css|js|mjs|ts|md|json))/g,
            ),
          ].map((m) => m[1]);
          if (filePaths.length > 0) {
            const fileSnippets = [];
            for (const fp of filePaths.slice(0, 3)) {
              try {
                const absPath = fp.startsWith("~")
                  ? fp.replace("~", os.homedir())
                  : fp;
                const content = fs.readFileSync(absPath, "utf8");
                const lines = content.split("\n");
                // Include full file for small files, truncated for large ones
                const snippet =
                  lines.length <= 600
                    ? content
                    : lines.slice(0, 300).join("\n") +
                      `\n\n... (${lines.length - 300} more lines truncated) ...\n` +
                      lines.slice(-100).join("\n");
                fileSnippets.push(
                  `\n\n--- FILE: ${absPath} (${lines.length} lines) ---\n${snippet}\n--- END FILE ---`,
                );
              } catch {
                /* file not readable, skip */
              }
            }
            if (fileSnippets.length > 0) {
              enrichedTask =
                taskText +
                "\n\nFile contents for your audit:" +
                fileSnippets.join("");
            }
          }
          const dispatchTaskId =
            "dispatch-" +
            Date.now() +
            "-" +
            Math.random().toString(36).slice(2, 6);
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
          telemetry("crew_dispatch_forwarded", {
            from: CREWSWARM_RT_AGENT,
            to: targetAgent,
            taskId: dispatchTaskId,
          });
          progress(
            `Dispatched task to ${targetAgent}: ${taskText.slice(0, 60)}`,
          );
        } catch (dispErr) {
          console.error(
            `[bridge] CREW_DISPATCH to ${targetAgent} failed:`,
            dispErr?.message,
          );
        }
      }
    }

    // 💾 Save sub-agent response BEFORE publishing done (ensures it always runs)
    // Extract projectId from payload or try to infer from project directory
    const saveProjectId = payload?.projectId || (projectDir ? path.basename(projectDir) : null);
    console.log(
      `[${CREWSWARM_RT_AGENT}] 🔍 SAVE CHECKPOINT - projectId:`,
      saveProjectId,
      "typeof saveProjectMessage:",
      typeof saveProjectMessage,
    );

    if (saveProjectId) {
      try {
        const mentions = detectMentions(reply);
        console.log(
          `[${CREWSWARM_RT_AGENT}] 💾 Calling saveProjectMessage for project:`,
          saveProjectId,
        );
        const savedMessageId = saveProjectMessage(saveProjectId, {
          source: "sub-agent",
          role: "assistant",
          content: reply,
          agent: CREWSWARM_RT_AGENT,
          threadId: payload?.originThreadId || null,
          parentId: payload?.originMessageId || null,
          metadata: {
            agentName: formatAgentDisplayName(CREWSWARM_RT_AGENT),
            agentEmoji: "🤖",
            taskId,
            engineUsed,
            model: modelUsed,
            incomingType,
            ...(payload?.originProjectId
              ? { originProjectId: payload.originProjectId }
              : {}),
            ...(payload?.originChannel
              ? { originChannel: payload.originChannel }
              : {}),
            ...(payload?.originThreadId
              ? { originThreadId: payload.originThreadId }
              : {}),
            ...(payload?.originMessageId
              ? { originMessageId: payload.originMessageId }
              : {}),
            ...(payload?.triggeredBy ? { triggeredBy: payload.triggeredBy } : {}),
            ...(payload?.mentionedBy ? { mentionedBy: payload.mentionedBy } : {}),
            ...(payload?.autonomous !== undefined
              ? { autonomous: payload.autonomous }
              : {}),
            ...(mentions.length ? { mentions } : {}),
          },
        });
        // Shared-chat @mentions are user-facing direct chat by default.
        // Do not let agent replies recursively trigger new routing hops.
        console.log(
          `[${CREWSWARM_RT_AGENT}] ✅ Sub-agent message saved successfully`,
        );
      } catch (e) {
        console.error(
          `[${CREWSWARM_RT_AGENT}] ❌ Failed to save project message:`,
          e.message,
          e.stack,
        );
      }
    } else {
      console.log(
        `[${CREWSWARM_RT_AGENT}] ⏭️  Skipping save - no projectId (payload.projectId:`,
        payload?.projectId,
        ")",
      );
    }

    console.log(`[${CREWSWARM_RT_AGENT}] ✅ Publishing task.done for ${taskId} (reply: ${reply?.length || 0} chars)`);
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
    recordTaskTrace({
      agentId: CREWSWARM_RT_AGENT,
      projectId,
      taskId,
      incomingType,
      prompt,
      reply,
      engineUsed,
      success: true,
    });

    if (isSharedMemoryAvailable()) {
      const projectDir =
        extractProjectDirFromTask(prompt) ||
        getOpencodeProjectDir() ||
        process.cwd();
      recordTaskMemory(projectDir, {
        runId: taskId,
        tier: "worker",
        task: prompt,
        result: reply,
        agent: CREWSWARM_RT_AGENT,
        model: modelUsed || "unknown",
        metadata: {
          engineUsed,
          incomingType,
          success: true,
          timestamp: new Date().toISOString(),
        },
      }).catch((err) => {
        console.warn(
          `[${CREWSWARM_RT_AGENT}] Failed to record task memory: ${err.message}`,
        );
      });
    }

    client?.publish({
      channel: "events",
      type: "agent_idle",
      to: "broadcast",
      payload: { agent: CREWSWARM_RT_AGENT, ts: Date.now() },
    });
    client.ack({
      messageId: envelope.id,
      status: "done",
      note: "task completed",
    });
  } catch (err) {
    const message = err?.message ?? String(err);
    const isCoding = isCodingTask(incomingType, prompt, payload);
    const maxRetries = isCoding
      ? CREWSWARM_RT_DISPATCH_MAX_RETRIES_CODING
      : CREWSWARM_RT_DISPATCH_MAX_RETRIES;
    const shouldRetry =
      dispatchGuardEnabled &&
      dispatchClaim?.acquired &&
      shouldRetryTaskFailure(err) &&
      dispatchAttempt < maxRetries;

    recordTaskTrace({
      agentId: CREWSWARM_RT_AGENT,
      projectId,
      taskId,
      incomingType,
      prompt,
      reply: "",
      error: message,
      engineUsed: typeof engineUsed !== "undefined" ? engineUsed : null,
      success: false,
    });

    // Write to DLQ if max retries exceeded or catastrophic error
    const taskForDLQ = {
      taskId,
      agent: CREWSWARM_RT_AGENT,
      prompt,
      error: message,
      retries: dispatchAttempt,
      correlationId,
      payload: {
        incomingType,
        projectId,
        engineUsed: typeof engineUsed !== "undefined" ? engineUsed : null,
        from,
        envelope,
      },
    };
    
    if (shouldDLQ(taskForDLQ, maxRetries)) {
      const dlqEntry = writeToDLQ(taskForDLQ);
      if (dlqEntry) {
        telemetry("dlq_write", { 
          key: dispatchKey, 
          taskId, 
          incomingType,
          retries: dispatchAttempt,
          maxRetries,
        });
        
        // Broadcast DLQ event
        client.publish({
          channel: "events",
          type: "task.dlq",
          to: from,
          taskId,
          correlationId,
          priority: "high",
          payload: {
            source: CREWSWARM_RT_AGENT,
            agent: CREWSWARM_RT_AGENT,
            error: message,
            retries: dispatchAttempt,
            maxRetries,
            dlqKey: dlqEntry.taskId,
          },
        });
      }
    }

    if (shouldRetry) {
      const retryAttempt = dispatchAttempt + 1;
      const retryAfterMs =
        CREWSWARM_RT_DISPATCH_RETRY_BACKOFF_MS * 2 ** dispatchAttempt;
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
            to: CREWSWARM_RT_AGENT, // Retry to SELF, not broadcast (prevents 7x amplification)
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

    // ── Auto-escalate to crew-fixer when coding agents exhaust retries ─────
    // Note: DLQ write happens above (shouldDLQ check), before escalation
    if (dispatchAttempt >= maxRetries) {
      const ESCALATABLE_AGENTS = new Set([
        "crew-coder",
        "crew-coder-front",
        "crew-coder-back",
        "crew-frontend",
        "crew-copywriter",
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
            payload: {
              action: "run_task",
              prompt: fixerPrompt,
              escalatedFrom: CREWSWARM_RT_AGENT,
              parentTaskId: taskId,
            },
          });
          telemetry("task_escalated_to_fixer", {
            fromAgent: CREWSWARM_RT_AGENT,
            taskId,
            fixerTaskId,
          });
          console.log(
            `[${CREWSWARM_RT_AGENT}] ⬆️ Escalated failed task to crew-fixer (${fixerTaskId})`,
          );
        } catch (escErr) {
          console.error(
            `[${CREWSWARM_RT_AGENT}] Escalation to crew-fixer failed:`,
            escErr?.message,
          );
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

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
    client.ack({
      messageId: envelope.id,
      status: "failed",
      note: message.slice(0, 240),
    });
  } finally {
    // ✅ FIX: ALWAYS emit agent_idle, even on error
    // This prevents agents from appearing "stuck in OpenCode" after crashes/timeouts
    client?.publish({
      channel: "events",
      type: "agent_idle",
      to: "broadcast",
      payload: { agent: CREWSWARM_RT_AGENT, ts: Date.now() },
    });

    if (dispatchHeartbeat) {
      clearInterval(dispatchHeartbeat);
      dispatchHeartbeat = null;
    }
    if (dispatchGuardEnabled && dispatchClaim?.acquired) {
      const released = releaseTaskLease({
        key: dispatchKey,
        claimId: dispatchClaim.claimId,
      });
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
