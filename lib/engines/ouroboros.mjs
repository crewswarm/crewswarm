/**
 * Ouroboros-style LLM ↔ engine loop — extracted from gateway-bridge.mjs
 * Runs a multi-step loop: the loop brain LLM decomposes a task into STEP/DONE
 * instructions, each STEP is executed by the chosen engine, results feed back.
 *
 * Inject: initOuroboros({ loadAgentList, loadLoopBrainConfig, loadAgentPrompts,
 *                         callLLMDirect, buildMiniTaskForOpenCode,
 *                         runCursorCliTask, runClaudeCodeTask,
 *                         runCodexTask, runOpenCodeTask })
 */

let _deps = {};

export function initOuroboros(deps) {
  _deps = deps;
}

export async function runOuroborosStyleLoop(originalTask, agentId, projectDir, payload, progress, engine = "opencode") {
  const {
    loadAgentList, loadLoopBrainConfig, loadAgentPrompts, callLLMDirect,
    buildMiniTaskForOpenCode, runCursorCliTask, runClaudeCodeTask,
    runCodexTask, runOpenCodeTask,
  } = _deps;

  const agentCfg = loadAgentList().find(a => a.id === agentId) || {};
  const maxRounds = Math.min(20, Math.max(1,
    agentCfg.opencodeLoopMaxRounds ||
    parseInt(process.env.CREWSWARM_ENGINE_LOOP_MAX_ROUNDS || "10", 10)
  ));

  // Central loop brain: one fast model controls all STEP/DONE decisions.
  // Falls back to agent's own model if loopBrain not configured.
  const loopBrain = loadLoopBrainConfig();
  const agentPrompts = loadAgentPrompts();
  const bareId = agentId ? agentId.replace(/^crew-/, "") : null;
  const rolePrompt = (agentId && agentPrompts[agentId]) || (bareId && agentPrompts[bareId]) || "";
  const DECOMPOSER_SYSTEM = [
    "You are a task decomposer controlling a specialist AI agent.",
    rolePrompt ? `The agent's role: ${rolePrompt.slice(0, 300)}` : "",
    "Output exactly one line: either STEP: <one clear instruction for the agent to execute now> or DONE.",
    "No other text. Be specific and actionable. DONE only when the full task is complete.",
  ].filter(Boolean).join("\n");

  const engineLabel = engine === "cursor" ? "Cursor CLI" : engine === "claude" ? "Claude Code" : engine === "docker-sandbox" ? "Docker Sandbox" : "OpenCode";
  const brainLabel = loopBrain ? `${loopBrain.modelId} (central brain)` : `${agentId} model`;
  progress(`Loop brain: ${brainLabel} | Engine: ${engineLabel} | Max ${maxRounds} rounds`);

  const steps = [];
  let prompt = `${originalTask}\n\nOutput the first step: STEP: <instruction> or DONE.`;
  let lastReply = "";

  for (let round = 0; round < maxRounds; round++) {
    // Use central brain if configured, otherwise fall back to agent's own model
    let reply;
    if (loopBrain) {
      const messages = [
        { role: "system", content: DECOMPOSER_SYSTEM },
        { role: "user", content: prompt },
      ];
      try {
        const res = await fetch(`${loopBrain.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${loopBrain.apiKey}` },
          body: JSON.stringify({ model: loopBrain.modelId, messages, max_tokens: 256, stream: false }),
          signal: AbortSignal.timeout(30000),
        });
        if (res.ok) {
          const data = await res.json();
          reply = data?.choices?.[0]?.message?.content?.trim() || "";
        }
      } catch (e) {
        console.warn(`[loop-brain] Central brain failed (${e.message}) — falling back to agent model`);
      }
    }
    if (!reply) reply = await callLLMDirect(prompt, agentId, DECOMPOSER_SYSTEM);
    if (!reply || !reply.trim()) break;
    lastReply = reply.trim();

    if (/^\s*DONE\s*$/im.test(lastReply) || /\bDONE\s*$/im.test(lastReply)) break;

    const stepMatch = lastReply.match(/STEP:\s*([\s\S]+?)(?:\n\n|\n*$)/im) || lastReply.match(/STEP:\s*(.+)/i);
    const step = stepMatch ? stepMatch[1].trim().replace(/\n.*/gs, "").trim() : lastReply.slice(0, 500);
    if (!step) break;

    progress(`[${engineLabel} loop] Round ${round + 1}/${maxRounds}: ${step.slice(0, 60)}${step.length > 60 ? "…" : ""}`);

    const miniTask = buildMiniTaskForOpenCode(step, agentId, projectDir);
    let stepResult;
    try {
      if (engine === "cursor") {
        stepResult = await runCursorCliTask(miniTask, { ...payload, agentId, projectDir });
      } else if (engine === "claude") {
        stepResult = await runClaudeCodeTask(miniTask, { ...payload, agentId, projectDir });
      } else if (engine === "codex") {
        stepResult = await runCodexTask(miniTask, { ...payload, agentId, projectDir });
      } else {
        stepResult = await runOpenCodeTask(miniTask, payload);
      }
    } catch (e) {
      stepResult = `Error: ${e?.message || String(e)}`;
    }
    steps.push({ step, result: stepResult });
    prompt = `Task: ${originalTask}\n\nCompleted steps:\n${steps.map((s, i) => `${i + 1}. ${s.step}\nResult: ${s.result}`).join("\n\n")}\n\nWhat is the next step? Reply with exactly: STEP: <instruction> or DONE.`;
  }

  if (steps.length === 0) return lastReply || "No steps executed.";
  return steps.map(s => s.result).join("\n\n---\n\n");
}
