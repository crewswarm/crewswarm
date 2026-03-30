import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { applyProjectDirToPipelineSteps } from "../dispatch/parsers.mjs";

let reconnectTimer = null;
let isConnecting = false;
let crewLeadHeartbeat = null;

const CODER_AGENT_RE = /crew-coder|crew-frontend|crew-fixer|crew-ml|crew-coder-back|crew-coder-front/;

function normalizeEngineId(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) return null;
    if (raw === "claude" || raw === "claude-code" || raw.includes("claude code")) return "claude";
    if (raw === "codex" || raw === "codex-cli" || raw.includes("codex")) return "codex";
    if (raw === "cursor" || raw === "cursor-cli" || raw.includes("cursor")) return "cursor";
    return null;
}

export function inferDispatchEngine(dispatch = null, message = "") {
    const explicit =
        normalizeEngineId(dispatch?.engineUsed)
        || normalizeEngineId(dispatch?.runtime)
        || (dispatch?.useCodex === true ? "codex" : null)
        || (dispatch?.useCursorCli === true ? "cursor" : null)
        || (dispatch?.useClaudeCode === true ? "claude" : null);
    if (explicit) return explicit;

    const text = String(message || "");
    if (/claude\s*code|anthropic|sonnet|opus/i.test(text)) return "claude";
    if (/codex|gpt-5(\.\d+)?-codex|openai/i.test(text)) return "codex";
    if (/cursor/i.test(text)) return "cursor";
    return null;
}

export function getNextCoderEngine(currentEngine) {
    const current = normalizeEngineId(currentEngine);
    if (current === "claude") return "codex";
    if (current === "codex") return "claude";
    if (current === "cursor") return null;
    return "codex";
}

export function buildEngineFallbackMeta(dispatch = null, currentEngine = null, trigger = "rate-limit-fallback") {
    const nextEngine = getNextCoderEngine(currentEngine);
    if (!nextEngine) return null;

    return {
        ...(dispatch || {}),
        useClaudeCode: nextEngine === "claude",
        useCodex: nextEngine === "codex",
        useCursorCli: nextEngine === "cursor",
        runtime: nextEngine,
        engineFallbackFrom: normalizeEngineId(currentEngine),
        engineFallbackTo: nextEngine,
        triggeredBy: trigger,
    };
}

export function initWsRouter(deps) {
    const {
        WebSocket,
        RT_URL,
        RT_TOKEN,
        setRtPublish,
        startBackgroundLoop,
        resumePipelines,
        agentLastHeartbeat,
        pushRtActivity,
        activeOpenCodeAgents,
        broadcastSSE,
        markDispatchClaimed,
        emitTaskLifecycle,
        pendingDispatches,
        getRateLimitFallback,
        RATE_LIMIT_PATTERN,
        dispatchTask,
        appendHistory,
        pendingPipelines,
        handleAutonomousMentions,
        saveProjectMessage,
        checkWaveQualityGate,
        failPipelineOnQualityGate,
        savePipelineState,
        dispatchPipelineWave,
        parsePipeline,
        parseDispatches,
        parseRegisterProject,
        DASHBOARD,
        autonomousPmLoopSessions
    } = deps;

    function connectRT() {
        if (isConnecting) {
            console.log("[crew-lead] Already connecting to RT, skipping duplicate call");
            return;
        }

        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }

        isConnecting = true;
        const ws = new WebSocket(RT_URL);

        ws.on("open", () => {
            console.log("[crew-lead] RT socket open");
            isConnecting = false;
        });

        ws.on("message", (raw) => {
            let p;
            try { p = JSON.parse(raw.toString()); } catch { return; }

            if (p.type === "server.hello") {
                ws.send(JSON.stringify({ type: "hello", agent: "crew-lead", token: RT_TOKEN }));
                return;
            }
            if (p.type === "hello.ack") {
                ws.send(JSON.stringify({ type: "subscribe", channels: ["done", "events", "command", "issues", "status"] }));

                setRtPublish(({ channel, type, to, payload }) => {
                    const taskId = crypto.randomUUID();
                    try {
                        ws.send(JSON.stringify({ type: "publish", channel, messageType: type, to, taskId, priority: "high", payload }));
                    } catch (sendErr) {
                        console.error(`[crew-lead] RT ws.send failed (${sendErr.message}) — triggering reconnect`);
                        setRtPublish(null);
                        try { ws.close(); } catch {}
                        if (reconnectTimer) clearTimeout(reconnectTimer);
                        reconnectTimer = setTimeout(connectRT, 1000);
                        return null;
                    }
                    return taskId;
                });

                console.log("[crew-lead] RT connected — listening for done, events, command, issues");
                setTimeout(resumePipelines, 2000);
                startBackgroundLoop();

                if (crewLeadHeartbeat) clearInterval(crewLeadHeartbeat);
                crewLeadHeartbeat = setInterval(() => {
                    try {
                        const taskId = crypto.randomUUID();
                        ws.send(JSON.stringify({
                            type: "publish", channel: "status", messageType: "agent.heartbeat",
                            to: "broadcast", taskId, priority: "low",
                            payload: { agent: "crew-lead", ts: new Date().toISOString() },
                        }));
                    } catch { }
                }, 30000);
                return;
            }
            if (p.type === "error") {
                console.error("[crew-lead] RT error:", p.message);
                if (/token|auth|unauthorized/i.test(String(p.message))) {
                    console.error("[crew-lead] Tip: Set RT token in dashboard Settings (RT Bus) or in ~/.crewswarm/crewswarm.json (rt.authToken) so agent replies show in chat.");
                }
                return;
            }

            if (p.type === "message" && p.envelope) {
                const env = p.envelope;
                if (env.id) ws.send(JSON.stringify({ type: "ack", messageId: env.id, status: "received" }));

                const from = env.from || env.sender_agent_id || env.payload?.source || "";
                const msgType = env.messageType || env.type || "";
                const reply = env.payload?.reply != null ? String(env.payload.reply).trim() : "";
                const content = reply || (env.payload?.content ? String(env.payload.content).trim() : "");

                if (msgType === "agent.heartbeat" && from) {
                    agentLastHeartbeat.set(from, Date.now());
                }

                const time = new Date().toISOString().slice(11, 19);
                let summary = "";
                if (env.channel === "done" && content) summary = `${from} done: ${content.slice(0, 70)}…`;
                else if (env.channel === "command") summary = `${from} → ${env.to || "?"} ${msgType} ${(env.payload?.content || env.payload?.prompt || "").slice(0, 50)}…`;
                else if (env.channel === "issues") summary = `${from} issue: ${(env.payload?.error || env.payload?.note || "—").slice(0, 60)}`;
                else summary = `${from} ${msgType} ${env.to ? `→ ${env.to}` : ""}`.trim();
                pushRtActivity({ ts: Date.now(), time, channel: env.channel, type: msgType, from, to: env.to, taskId: env.taskId || env.correlationId, summary });

                if (msgType === "agent.online") {
                    const onlineAgent = env.payload?.agent || from;
                    if (onlineAgent && activeOpenCodeAgents.has(onlineAgent)) {
                        activeOpenCodeAgents.delete(onlineAgent);
                        broadcastSSE({ type: "agent_idle", agent: onlineAgent, stalled: false, ts: Date.now() });
                    }
                }

                if (msgType === "agent_working" || msgType === "agent_idle") {
                    const agent = env.payload?.agent || from;
                    const model = env.payload?.model || "";
                    const stalled = env.payload?.stalled || false;
                    if (msgType === "agent_working") {
                        activeOpenCodeAgents.set(agent, { model, since: Date.now() });
                    } else {
                        activeOpenCodeAgents.delete(agent);
                    }
                    broadcastSSE({ type: msgType, agent, model, stalled, ts: Date.now() });
                }

                if (env.channel === "status" && (msgType === "task.in_progress" || msgType === "task.claimed")) {
                    const claimedTaskId = env.taskId || env.correlationId || "";
                    if (claimedTaskId) markDispatchClaimed(claimedTaskId, from);
                }

                if (env.channel === "issues" && (msgType === "task.failed" || env.type === "task.failed")) {
                    const failedTaskId = env.taskId || env.correlationId || "";
                    const errMsg = String(env.payload?.error || env.payload?.note || "").trim();
                    const failedAgent = env.payload?.source || from || "";
                    emitTaskLifecycle("failed", { taskId: failedTaskId, agentId: failedAgent, taskType: "task", error: { message: errMsg } });
                    const dispatch = pendingDispatches.get(failedTaskId);
                    if (dispatch && RATE_LIMIT_PATTERN.test(errMsg)) {
                        const targetSession = dispatch.sessionId || "owner";
                        const currentEngine = inferDispatchEngine({ ...dispatch, engineUsed: env.payload?.engineUsed || dispatch.engineUsed }, errMsg);
                        const engineFallbackMeta = CODER_AGENT_RE.test(failedAgent)
                            ? buildEngineFallbackMeta(dispatch, currentEngine, "rate-limit-engine-fallback")
                            : null;
                        if (engineFallbackMeta) {
                            pendingDispatches.delete(failedTaskId);
                            const newTaskId = dispatchTask(failedAgent, dispatch.task, targetSession, engineFallbackMeta);
                            if (newTaskId) {
                                appendHistory("default", targetSession, "system", `[crew-lead] ${failedAgent} hit rate limit on ${currentEngine || "current engine"} (${errMsg.slice(0, 80)}). Re-dispatched same task on ${engineFallbackMeta.engineFallbackTo}.`);
                                broadcastSSE({ type: "agent_reply", from: "crew-lead", content: `Rate limit: retried ${failedAgent} on ${engineFallbackMeta.engineFallbackTo}.`, sessionId: targetSession, taskId: failedTaskId, ts: Date.now() });
                                console.log(`[crew-lead] Rate limit engine fallback: ${failedAgent} ${currentEngine || "unknown"} → ${engineFallbackMeta.engineFallbackTo}`);
                                return;
                            }
                        }
                        const fallback = getRateLimitFallback(failedAgent);
                        if (fallback !== failedAgent) {
                            pendingDispatches.delete(failedTaskId);
                            const newTaskId = dispatchTask(fallback, dispatch.task, targetSession, { ...dispatch, pipelineId: dispatch.pipelineId, waveIndex: dispatch.waveIndex });
                            if (newTaskId) {
                                appendHistory("default", targetSession, "system", `[crew-lead] ${failedAgent} hit rate limit (${errMsg.slice(0, 80)}). Re-dispatched same task to ${fallback}.`);
                                broadcastSSE({ type: "agent_reply", from: "crew-lead", content: `Rate limit: retried task with ${fallback}.`, sessionId: targetSession, taskId: failedTaskId, ts: Date.now() });
                                console.log(`[crew-lead] Rate limit fallback: ${failedAgent} → ${fallback} (task re-dispatched)`);
                            }
                        }
                    }
                }

                const isDone = msgType === "task.done" || env.channel === "done";

                if (isDone && content && from && from !== "crew-lead") {
                    console.log(`[crew-lead] ✅ Agent reply from ${from}: ${content.slice(0, 120)}`);

                    const taskId = env.taskId || env.correlationId || "";
                    const dispatch = pendingDispatches.get(taskId);
                    const targetSession = dispatch?.sessionId || "owner";
                    if (dispatch) {
                        dispatch.done = true;
                        dispatch.result = content.slice(0, 4000);
                        dispatch.engineUsed = env.payload?.engineUsed || null;
                        setTimeout(() => pendingDispatches.delete(taskId), 600_000);
                    }

                    const _autoRetryKey = `_question_retried_${taskId}`;
                    const _askedQuestion = /(?:would you like|shall i|should i|do you want|want me to|may i|can i proceed|would it help|do you need|is that correct|shall we|ready to proceed|would you prefer|let me know|please (?:confirm|clarify|specify|advise))\??/i.test(content);
                    const _didWork = /@@WRITE_FILE|@@RUN_CMD|wrote|created|updated|fixed|patched|done\.|complete/i.test(content);
                    if (_askedQuestion && !_didWork && !pendingPipelines.has(dispatch?.pipelineId) && !global[_autoRetryKey]) {
                        global[_autoRetryKey] = true;
                        setTimeout(() => { delete global[_autoRetryKey]; }, 600_000);
                        const _originalTask = dispatch?.task || "";
                        const _retryTask = (_originalTask.slice(0, 2000) || content.slice(0, 500)) +
                            "\n\nDo NOT ask for permission or confirmation. Proceed immediately with your best judgment. Just do it.";
                        console.log(`[crew-lead] Agent ${from} asked a question instead of working — auto-retrying`);
                        appendHistory("default", targetSession, "system", `${from} asked a question instead of acting — auto-retrying with explicit instruction.`);
                        dispatchTask(from, _retryTask, targetSession, dispatch ? {
                            originProjectId: dispatch.originProjectId,
                            originChannel: dispatch.originChannel,
                            originThreadId: dispatch.originThreadId,
                            originMessageId: dispatch.originMessageId,
                            triggeredBy: "auto-retry-question",
                        } : null);
                        return;
                    }

                    const _planRetryKey = `_plan_retried_${taskId}`;
                    const _isCoderAgent = CODER_AGENT_RE.test(from);
                    const _returnedPlan = !_didWork && content.length > 300 && (
                        /##\s+(component|feature|file structure|design|breakdown|overview|plan|approach|implementation plan|technical spec)/i.test(content) ||
                        /here'?s? (?:the|my|a|what|how)/i.test(content.slice(0, 200))
                    );
                    if (_isCoderAgent && _returnedPlan && !global[_planRetryKey]) {
                        global[_planRetryKey] = true;
                        setTimeout(() => { delete global[_planRetryKey]; }, 600_000);
                        const _originalTask = dispatch?.task || "";
                        const _retryTask = `STOP PLANNING. Your last response was a plan/analysis with no code written.\n\nOriginal task: ${_originalTask.slice(0, 1500)}\n\nNow WRITE THE CODE. Use @@WRITE_FILE for every file. Do not describe what you will do — do it.`;
                        console.log(`[crew-lead] Agent ${from} returned a plan instead of code — auto-retrying`);
                        appendHistory("default", targetSession, "system", `${from} returned a plan with no code — auto-retrying with explicit execute instruction.`);
                        dispatchTask(from, _retryTask, targetSession, {
                            ...(dispatch?.pipelineId ? { pipelineId: dispatch.pipelineId } : {}),
                            ...(dispatch?.projectDir ? { projectDir: dispatch.projectDir } : {}),
                            originProjectId: dispatch?.originProjectId,
                            originChannel: dispatch?.originChannel,
                            originThreadId: dispatch?.originThreadId,
                            originMessageId: dispatch?.originMessageId,
                            triggeredBy: "auto-retry-plan",
                        });
                        return;
                    }

                    const _bailRetryKey = `_bail_retried_${taskId}`;
                    const _bailed = /couldn'?t complete|could not complete|i'?m sorry[,.]? but|i was unable to|i'?m unable to|session (?:limit|ended|expired)|ran out of|context (?:limit|window)|i (?:apologize|regret)|partial(?:ly)? complete|not (?:all|every|fully) (?:changes?|tasks?|items?|fixes?)/i.test(content);
                    if (_bailed && !global[_bailRetryKey]) {
                        global[_bailRetryKey] = true;
                        setTimeout(() => { delete global[_bailRetryKey]; }, 600_000);
                        const _originalTask = dispatch?.task || "";
                        const currentEngine = inferDispatchEngine(dispatch, content);
                        const engineFallbackMeta = _isCoderAgent
                            ? buildEngineFallbackMeta(dispatch, currentEngine, "auto-retry-bail")
                            : null;
                        const fallbackAgent = engineFallbackMeta ? from : (_isCoderAgent ? from : (getRateLimitFallback(from) || from));
                        const _retryTask = `Your previous attempt at this task was incomplete. You said you couldn't finish.\n\nOriginal task:\n${_originalTask.slice(0, 2000)}\n\nDo not apologize. Do not explain why you couldn't finish. Just complete the remaining work now. Use @@WRITE_FILE for every file you change. If the task is too large, complete the most critical items first.`;
                        console.log(`[crew-lead] Agent ${from} bailed out mid-task — auto-retrying with ${engineFallbackMeta?.engineFallbackTo || fallbackAgent}`);
                        appendHistory("default", targetSession, "system", `${from} bailed mid-task — auto-retrying with ${engineFallbackMeta?.engineFallbackTo || fallbackAgent}.`);
                        dispatchTask(fallbackAgent, _retryTask, targetSession, {
                            ...(engineFallbackMeta || {}),
                            ...(dispatch?.pipelineId ? { pipelineId: dispatch.pipelineId } : {}),
                            ...(dispatch?.projectDir ? { projectDir: dispatch.projectDir } : {}),
                            originProjectId: dispatch?.originProjectId,
                            originChannel: dispatch?.originChannel,
                            originThreadId: dispatch?.originThreadId,
                            originMessageId: dispatch?.originMessageId,
                            triggeredBy: "auto-retry-bail",
                        });
                        return;
                    }

                    appendHistory("default", targetSession, "system", `[${from} completed task]: ${content.slice(0, 4000)}`);
                    if (targetSession === "bg-consciousness" && from === "crew-main") {
                        const short = content.slice(0, 800).replace(/\n+/g, " ").trim();
                        appendHistory("default", "owner", "system", `[crew-main — background]: ${short}`);
                        broadcastSSE({ type: "agent_reply", from: "crew-main", content: short, sessionId: "owner", taskId, _bg: true, ts: Date.now() });
                        try {
                            const statusPath = path.join(os.homedir(), ".crewswarm", "process-status.md");
                            const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
                            const safe = content.slice(0, 2000).replace(/@@/g, "");
                            fs.writeFileSync(statusPath, `# Process status (crew-main)\nLast updated: ${stamp}\n\n${safe}\n`, "utf8");
                        } catch (_) { }
                    }
                    broadcastSSE({
                        type: "agent_reply",
                        from,
                        content: content.slice(0, 2000),
                        sessionId: targetSession,
                        taskId,
                        engineUsed: env.payload?.engineUsed || null,
                        ts: Date.now()
                    });
                    if (dispatch?.ts) {
                        emitTaskLifecycle("completed", {
                            taskId,
                            agentId: from,
                            taskType: "task",
                            durationMs: Date.now() - dispatch.ts,
                            result: { summary: content.slice(0, 200) },
                        });
                    }

                    const originChannel = dispatch?.originChannel || dispatch?.originProjectId || null;

                    // Persist agent result to project messages so swarm chat history is complete
                    if (originChannel && saveProjectMessage) {
                        try {
                            saveProjectMessage(originChannel, {
                                source: "agent",
                                role: "assistant",
                                content: content.slice(0, 8000),
                                agent: from,
                                threadId: dispatch?.originThreadId || `${originChannel}:${targetSession}`,
                                parentId: dispatch?.originMessageId || null,
                                metadata: {
                                    agentName: from,
                                    autonomous: true,
                                    engineUsed: env.payload?.engineUsed || null,
                                    durationMs: dispatch?.ts ? Date.now() - dispatch.ts : null,
                                    triggeredBy: dispatch?.triggeredBy || "dispatch",
                                    taskId,
                                },
                            });
                        } catch (e) {
                            console.warn(`[crew-lead] Failed to save agent result to project messages: ${e.message}`);
                        }
                    }

                    if (originChannel) {
                        void handleAutonomousMentions({
                            message: { content },
                            sender: from,
                            channel: originChannel,
                            projectId: dispatch?.originProjectId || originChannel,
                            sessionId: targetSession,
                            projectDir: dispatch?.projectDir || null,
                            originMessageId: dispatch?.originMessageId || null,
                            originThreadId: dispatch?.originThreadId || `${originChannel}:${targetSession}`,
                            appendToChatHistory: (entry) => {
                                appendHistory("default", targetSession, "system", entry.content || String(entry));
                            },
                            broadcastSSE,
                        }).catch((err) => {
                            console.warn(`[crew-lead] Autonomous mention routing failed for ${from}: ${err.message}`);
                        });
                    }

                    if (dispatch?.pipelineId) {
                        const pipeline = pendingPipelines.get(dispatch.pipelineId);
                        if (pipeline) {
                            pipeline.waveResults.push(content);
                            pipeline.pendingTaskIds.delete(taskId);
                            pipeline._lastActivity = Date.now();

                            console.log(`[crew-lead] Pipeline ${dispatch.pipelineId} wave ${pipeline.currentWave + 1}: ${pipeline.pendingTaskIds.size} task(s) still pending`);

                            if (pipeline.pendingTaskIds.size === 0) {
                                if (!pipeline.completedWaveResults) pipeline.completedWaveResults = [];
                                pipeline.completedWaveResults.push([...pipeline.waveResults]);
                                const gateResult = checkWaveQualityGate(pipeline, dispatch.pipelineId);
                                if (gateResult.pass) {
                                    pipeline.currentWave++;
                                    savePipelineState(dispatch.pipelineId);
                                    dispatchPipelineWave(dispatch.pipelineId);
                                } else if (gateResult.halted) {
                                    failPipelineOnQualityGate(dispatch.pipelineId, gateResult.issues || []);
                                } else {
                                    savePipelineState(dispatch.pipelineId);
                                }
                            }
                        }
                    }

                    // Parse @@DISPATCH markers from any agent result (not just crew-pm).
                    // This lets crew-orchestrator (and others) fan out tasks via @@DISPATCH
                    // even when running on direct-llm without CLI tools.
                    if (from !== "crew-pm" && content.includes("@@DISPATCH")) {
                        const agentDispatches = parseDispatches(content);
                        for (const d of agentDispatches) {
                            const ok = dispatchTask(d.agent, d, targetSession, {
                                originProjectId: dispatch?.originProjectId || dispatch?.projectId || "general",
                                originChannel: dispatch?.originChannel || dispatch?.projectId || "general",
                                originThreadId: dispatch?.originThreadId || `${dispatch?.originProjectId || dispatch?.projectId || "general"}:${targetSession}`,
                                originMessageId: dispatch?.originMessageId || null,
                                projectDir: d.projectDir || dispatch?.projectDir || null,
                                triggeredBy: `${from}-dispatch`,
                            });
                            if (ok) {
                                console.log(`[crew-lead] ${from} dispatched to ${d.agent}: "${(d.task || "").slice(0, 120)}"`);
                                appendHistory("default", targetSession, "system", `${from} dispatched to ${d.agent}: "${(d.task || "").slice(0, 120)}".`);
                            }
                        }
                    }

                    if (from === "crew-pm") {
                        const pipelineSpec = parsePipeline(content);
                        if (pipelineSpec) {
                            const pmProjectDir = dispatch?.projectDir || null;
                            if (pmProjectDir) {
                                applyProjectDirToPipelineSteps(pipelineSpec.steps, pmProjectDir);
                            }
                            const pipelineId = `pm-${Date.now()}`;
                            pendingPipelines.set(pipelineId, {
                                steps: pipelineSpec.steps,
                                waves: pipelineSpec.waves,
                                currentWave: 0,
                                pendingTaskIds: new Set(),
                                waveResults: [],
                                sessionId: targetSession,
                                projectDir: pmProjectDir,
                                originProjectId: dispatch?.originProjectId || dispatch?.projectId || "general",
                                originChannel: dispatch?.originChannel || dispatch?.projectId || "general",
                                originThreadId: dispatch?.originThreadId || `${dispatch?.originProjectId || dispatch?.projectId || "general"}:${targetSession}`,
                                originMessageId: dispatch?.originMessageId || null,
                                triggeredBy: "pm-pipeline",
                            });
                            dispatchPipelineWave(pipelineId);
                            appendHistory("default", targetSession, "system", `PM pipeline started (${pipelineSpec.steps.length} steps).`);
                        } else {
                            const dispatches = parseDispatches(content);
                            for (const d of dispatches) {
                                const ok = dispatchTask(d.agent, d, targetSession, {
                                    originProjectId: dispatch?.originProjectId || dispatch?.projectId || "general",
                                    originChannel: dispatch?.originChannel || dispatch?.projectId || "general",
                                    originThreadId: dispatch?.originThreadId || `${dispatch?.originProjectId || dispatch?.projectId || "general"}:${targetSession}`,
                                    originMessageId: dispatch?.originMessageId || null,
                                    triggeredBy: "pm-dispatch",
                                });
                                if (ok) appendHistory("default", targetSession, "system", `PM dispatched to ${d.agent}: "${(d.task || "").slice(0, 120)}".`);
                            }
                        }
                        const registerProj = parseRegisterProject(content);
                        if (registerProj) {
                            (async () => {
                                try {
                                    const createRes = await fetch(`${DASHBOARD}/api/projects`, {
                                        method: "POST",
                                        headers: { "content-type": "application/json" },
                                        body: JSON.stringify({ name: registerProj.name, description: registerProj.description || "", outputDir: registerProj.outputDir }),
                                        signal: AbortSignal.timeout(10000),
                                    });
                                    const proj = await createRes.json();
                                    if (proj.ok && proj.project) {
                                        appendHistory("default", targetSession, "system", `PM registered project "${registerProj.name}" in dashboard Projects tab (${registerProj.outputDir}).`);
                                        console.log(`[crew-lead] PM registered project: ${registerProj.name} → ${registerProj.outputDir}`);
                                    } else {
                                        appendHistory("default", targetSession, "system", `PM project registration failed: ${proj.error || "unknown"}.`);
                                    }
                                } catch (e) {
                                    appendHistory("default", targetSession, "system", `PM project registration failed: ${e.message}.`);
                                }
                            })();
                        }
                    }

                    if (from !== "crew-pm" && autonomousPmLoopSessions.has(targetSession)) {
                        const handbackTask = `Handback from ${from}: ${content.slice(0, 600)}. Update the roadmap (mark that item done), then dispatch the next task(s) with @@DISPATCH. Keep the pipeline moving until the plan is done or blocked. If no more items, reply "All done." and do not emit @@DISPATCH.`;
                        const pmTaskId = dispatchTask("crew-pm", handbackTask, targetSession, {
                            originProjectId: dispatch?.originProjectId || dispatch?.projectId || "general",
                            originChannel: dispatch?.originChannel || dispatch?.projectId || "general",
                            originThreadId: dispatch?.originThreadId || `${dispatch?.originProjectId || dispatch?.projectId || "general"}:${targetSession}`,
                            originMessageId: dispatch?.originMessageId || null,
                            triggeredBy: "pm-handback",
                        });
                        if (pmTaskId) {
                            appendHistory("default", targetSession, "system", `Autonomous: sent handback to crew-pm to update plan and dispatch next.`);
                        }
                    }
                }

                if (msgType === "cmd.needs_approval" && env.payload?.approvalId) {
                    const { approvalId, agent: approvalAgent, cmd } = env.payload;
                    console.log(`[crew-lead] 🔐 cmd approval needed — ${approvalAgent}: ${cmd}`);
                    broadcastSSE({ type: "confirm_run_cmd", approvalId, agent: approvalAgent, cmd, ts: Date.now() });
                }
            }
        });

        ws.on("close", () => {
            setRtPublish(null);
            isConnecting = false;
            if (crewLeadHeartbeat) { clearInterval(crewLeadHeartbeat); crewLeadHeartbeat = null; }
            console.log("[crew-lead] RT disconnected — reconnecting in 1s");
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(connectRT, 1000);
        });

        ws.on("error", (e) => {
            console.error("[crew-lead] RT socket error:", e.message);
            isConnecting = false;
        });
    }

    return connectRT;
}
