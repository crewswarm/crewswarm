/**
 * Background loop and rate-limit fallback — extracted from crew-lead.mjs
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let _broadcastSSE = () => {};
let _appendHistory = () => {};
let _appendToBrain = () => {};
let _dispatchTask = () => null;
let _findNextRoadmapPhase = () => null;
let _parseDispatches = () => [];
let _pendingPipelines = new Map();
let _readProjectsRegistry = () => [];
let _autoAdvanceRoadmap = async () => {};
let _tryRead = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };

let _bgConsciousnessEnabled = false;
let _getBgConsciousnessEnabled = null;
let _bgConsciousnessIntervalMs = 15 * 60 * 1000;
let _bgConsciousnessModel = "groq/llama-3.1-8b-instant";
let _brainPath = "";

export const _agentTimeoutCounts = new Map();
const _timeoutLog = [];
let _lastBgConsciousnessAt = 0;
let _bgLoopInterval = null;

/** Reset internal state for test isolation. */
export function resetForTesting() {
  _agentTimeoutCounts.clear();
  _timeoutLog.length = 0;
  _lastBgConsciousnessAt = 0;
  if (_bgLoopInterval) { clearInterval(_bgLoopInterval); _bgLoopInterval = null; }
}

/** Stop the background loop interval (prevents process from hanging in tests). */
export function stopBackgroundLoop() {
  if (_bgLoopInterval) { clearInterval(_bgLoopInterval); _bgLoopInterval = null; }
}

export function initBackground({
  broadcastSSE,
  appendHistory,
  appendToBrain,
  dispatchTask,
  findNextRoadmapPhase,
  parseDispatches,
  pendingPipelines,
  readProjectsRegistry,
  autoAdvanceRoadmap,
  tryRead,
  bgConsciousnessEnabled,
  getBgConsciousnessEnabled,
  bgConsciousnessIntervalMs,
  bgConsciousnessModel,
  brainPath,
}) {
  if (broadcastSSE) _broadcastSSE = broadcastSSE;
  if (appendHistory) _appendHistory = appendHistory;
  if (appendToBrain) _appendToBrain = appendToBrain;
  if (dispatchTask) _dispatchTask = dispatchTask;
  if (findNextRoadmapPhase) _findNextRoadmapPhase = findNextRoadmapPhase;
  if (parseDispatches) _parseDispatches = parseDispatches;
  if (pendingPipelines) _pendingPipelines = pendingPipelines;
  if (readProjectsRegistry) _readProjectsRegistry = readProjectsRegistry;
  if (autoAdvanceRoadmap) _autoAdvanceRoadmap = autoAdvanceRoadmap;
  if (tryRead) _tryRead = tryRead;
  if (bgConsciousnessEnabled !== undefined) _bgConsciousnessEnabled = bgConsciousnessEnabled;
  if (getBgConsciousnessEnabled) _getBgConsciousnessEnabled = getBgConsciousnessEnabled;
  if (bgConsciousnessIntervalMs !== undefined) _bgConsciousnessIntervalMs = bgConsciousnessIntervalMs;
  if (bgConsciousnessModel !== undefined) _bgConsciousnessModel = bgConsciousnessModel;
  if (brainPath !== undefined) _brainPath = brainPath;
}

export function recordAgentTimeout(agent) {
  _timeoutLog.push({ agent, ts: Date.now() });
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  while (_timeoutLog.length && _timeoutLog[0].ts < cutoff) _timeoutLog.shift();
  const counts = {};
  for (const e of _timeoutLog) counts[e.agent] = (counts[e.agent] || 0) + 1;
  for (const [id, n] of Object.entries(counts)) _agentTimeoutCounts.set(id, n);
}

function getBgConsciousnessLLM() {
  const cfg = _tryRead(path.join(os.homedir(), ".crewswarm", "crewswarm.json")) || {};
  const providers = cfg.providers || {};
  const [providerKey, ...modelParts] = String(_bgConsciousnessModel).split("/");
  let modelId = modelParts.join("/") || "llama-3.1-8b-instant";
  const p = providers[providerKey];
  if (!p?.apiKey) return null;
  const baseUrl = p.baseUrl || (providerKey === "groq" ? "https://api.groq.com/openai/v1" : "");
  if (!baseUrl) return null;
  // OpenRouter requires full ID (e.g. openrouter/hunter-alpha), not bare "hunter-alpha"
  if ((providerKey === "openrouter" || (baseUrl || "").includes("openrouter.ai")) && modelId && !modelId.startsWith("openrouter/")) {
    modelId = "openrouter/" + modelId;
  }
  return { baseUrl, apiKey: p.apiKey, modelId, providerKey };
}

const BG_CONSCIOUSNESS_LLM_TIMEOUT_MS = 60_000;

async function runBackgroundConsciousnessDirect() {
  const llm = getBgConsciousnessLLM();
  if (!llm) return false;
  let brainContent = "";
  try {
    const raw = fs.readFileSync(_brainPath, "utf8");
    const stripped = raw.replace(/^#[^\n]*\n/gm, "").replace(/^Agents: append.*\n?/gm, "").replace(/^This is the persistent.*\n?/gm, "").replace(/^Read it to.*\n?/gm, "").replace(/^Write to it.*\n?/gm, "").trim();
    if (stripped.length < 80) {
      console.log("[bg-loop] Brain empty — skipping consciousness cycle");
      return true;
    }
    brainContent = raw.slice(-6000);
  } catch {
    console.log("[bg-loop] brain.md not found — skipping consciousness cycle");
    return true;
  }
  const system = "You are crew-main managing the process for the user. Reply in under 100 words. Output: 1) One sentence on system/crew state or suggested next step. 2) If something needs follow-up, emit exactly one line: @@BRAIN crew-main: <fact> OR @@DISPATCH {\"agent\":\"...\",\"task\":\"...\"}. Otherwise reply NO_ACTION.";
  const user = `Shared memory (recent):\n${brainContent}\n\nWhat should the user know? Any follow-up? Reply briefly.`;
  const messages = [{ role: "system", content: system }, { role: "user", content: user }];
  let content;
  try {
    // Reasoning models (o1/o3/gpt-5 series) don't support max_tokens parameter
    const isReasoningModel = /^(o1|o3|gpt-5)/i.test(llm.modelId);
    const payload = { model: llm.modelId, messages, temperature: 0.5, stream: false };
    if (!isReasoningModel) {
      payload.max_tokens = 256;
    }
    const res = await fetch(`${llm.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": `Bearer ${llm.apiKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(BG_CONSCIOUSNESS_LLM_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text().catch(() => "")}`);
    const data = await res.json();
    content = data?.choices?.[0]?.message?.content || "NO_ACTION";
  } catch (e) {
    console.error("[bg-loop] Background consciousness LLM failed:", e.message);
    return true;
  }
  content = content.trim();
  const brainMatch = content.match(/@@BRAIN\s+([^\n]+)/);
  if (brainMatch) {
    const entry = brainMatch[1].trim();
    // Quality gate: reject chat fragments, status spam, and personality leaks
    const BRAIN_JUNK = /^(crew-lead \(auto\)|Services:|System Status|All (systems|agents)|✅|Hello|Hey|Hi[,!.\s]|Yo[,!\s]|I'm |You |What |Now |Look|Always|Hell |Cute|First|RT bus)/i;
    const looksLikeChat = entry.length < 20 || BRAIN_JUNK.test(entry) || !/[a-z]/.test(entry);
    if (looksLikeChat) {
      console.log("[bg-loop] @@BRAIN rejected (chat fragment):", entry.slice(0, 60));
    } else {
      try {
        _appendToBrain("crew-main", entry);
        console.log("[crew-lead] @@BRAIN (bg):", entry.slice(0, 60));
      } catch (e) {
        console.error("[bg-loop] Brain append failed:", e.message);
      }
    }
  }
  const dispatches = _parseDispatches(content);
  for (const d of dispatches) {
    try {
      _dispatchTask(d.agent, d.task, "bg-consciousness", null);
      console.log("[crew-lead] @@DISPATCH (bg):", d.agent, d.task?.slice(0, 50));
    } catch (e) {
      console.error("[bg-loop] Dispatch failed:", e.message);
    }
  }
  const short = content.replace(/\n+/g, " ").slice(0, 800).trim();
  const isNoAction = /^NO_ACTION/i.test(short) || short.length < 10;
  if (!isNoAction) {
    _appendHistory("default", "owner", "system", `[crew-main — background]: ${short}`);
    _broadcastSSE({ type: "agent_reply", from: "crew-main", content: short, sessionId: "owner", _bg: true, ts: Date.now() });
  }
  try {
    const statusPath = path.join(os.homedir(), ".crewswarm", "process-status.md");
    const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
    fs.writeFileSync(statusPath, `# Process status (crew-main)\nLast updated: ${stamp}\n\n${content.slice(0, 2000).replace(/@@/g, "")}\n`, "utf8");
  } catch (_) {}
  return true;
}

function backgroundLoop() {
  try {
    for (const [pid, pipeline] of _pendingPipelines) {
      if (!pipeline._lastActivity) pipeline._lastActivity = Date.now();
      const staleMs = Date.now() - pipeline._lastActivity;
      if (staleMs > 15 * 60 * 1000 && pipeline.pendingTaskIds.size > 0) {
        console.log(`[bg-loop] Pipeline ${pid} appears stalled (${Math.round(staleMs / 60000)}m no activity) — ${pipeline.pendingTaskIds.size} tasks pending`);
        _broadcastSSE({ type: "pipeline_stalled", pipelineId: pid, staleMinutes: Math.round(staleMs / 60000), ts: Date.now() });
      }
    }

    for (const [agent, count] of _agentTimeoutCounts) {
      if (count >= 3) {
        console.log(`[bg-loop] ⚠️  ${agent} has timed out ${count}x in last 24h — consider checking its model or restarting its bridge`);
        _broadcastSSE({ type: "agent_timeout_pattern", agent, count, ts: Date.now() });
      }
    }

    if (_pendingPipelines.size === 0) {
      const projects = _readProjectsRegistry();
      for (const project of projects) {
        if (!project.outputDir || project.autoAdvance !== true) continue;
        const nextPhase = _findNextRoadmapPhase(project.outputDir);
        if (nextPhase) {
          console.log(`[bg-loop] Auto-advancing "${project.name}" → "${nextPhase.title}"`);
          _autoAdvanceRoadmap(project.outputDir, "owner");
        }
      }

      const bgEnabled = _getBgConsciousnessEnabled ? _getBgConsciousnessEnabled() : _bgConsciousnessEnabled;
      if (bgEnabled && Date.now() - _lastBgConsciousnessAt >= _bgConsciousnessIntervalMs) {
        _lastBgConsciousnessAt = Date.now();
        const useDirect = getBgConsciousnessLLM();
        if (useDirect) {
          console.log("[bg-loop] Running background consciousness via", useDirect.providerKey + "/" + useDirect.modelId);
          runBackgroundConsciousnessDirect().catch((e) => {
            console.error("[bg-loop] Background consciousness error:", e.message);
          });
        } else {
          const consciousnessTask = `BACKGROUND CYCLE — you are managing the process for the user. Your reply is shown in their chat and written to ~/.crewswarm/process-status.md.
@@READ_FILE ${_brainPath}
Consider: what should the user know? (stalled work, next steps, blockers, health.) Reply in under 100 words.
Reply with: 1) One sentence on system/crew state or suggested next step. 2) If something needs follow-up, emit exactly one @@BRAIN: or @@DISPATCH line (e.g. dispatch to fix a stuck pipeline). Otherwise reply NO_ACTION.`;
          try {
            _dispatchTask("crew-main", consciousnessTask, "bg-consciousness", null);
            console.log("[bg-loop] Dispatched background consciousness cycle to crew-main (no cheap model configured)");
          } catch (e) {
            console.error("[bg-loop] Background consciousness dispatch failed:", e.message);
          }
        }
      }
    }
  } catch (e) {
    console.error("[bg-loop] Error:", e.message);
  }
}

export function startBackgroundLoop() {
  if (_bgLoopInterval) clearInterval(_bgLoopInterval);
  _bgLoopInterval = setInterval(backgroundLoop, 5 * 60 * 1000);
  console.log("[crew-lead] Background loop started (5m interval)");
  const bgEnabled = _getBgConsciousnessEnabled ? _getBgConsciousnessEnabled() : _bgConsciousnessEnabled;
  if (bgEnabled) {
    console.log("[crew-lead] Background consciousness ON — reflect every " + (_bgConsciousnessIntervalMs / 60000) + "m when idle");
  } else {
    console.log("[crew-lead] Background consciousness OFF — toggle in Dashboard → Settings");
  }
}

const _RATE_LIMIT_FALLBACK_STATIC = {
  "crew-coder-back": "crew-coder",
  "crew-coder-front": "crew-coder",
  "crew-coder": "crew-main",
  "crew-frontend": "crew-coder",
  "crew-pm": "crew-main",
  "crew-qa": "crew-main",
  "crew-copywriter": "crew-main",
  "crew-security": "crew-main",
};
const _ROLE_FALLBACK = {
  coder: "crew-coder",
  writer: "crew-copywriter",
  researcher: "crew-main",
  auditor: "crew-qa",
  ops: "crew-main",
  generalist: "crew-main",
};

export function getRateLimitFallback(agentId) {
  if (_RATE_LIMIT_FALLBACK_STATIC[agentId]) return _RATE_LIMIT_FALLBACK_STATIC[agentId];
  const swarm = _tryRead(path.join(os.homedir(), ".crewswarm", "crewswarm.json"));
  const agent = (swarm?.agents || []).find(a => a.id === agentId);
  if (agent?.fallbackModel) return agentId;
  if (agent?._role && _ROLE_FALLBACK[agent._role]) return _ROLE_FALLBACK[agent._role];
  return "crew-main";
}

export const RATE_LIMIT_PATTERN = /429|rate[\s_]*limit|throttl|quota[\s_]*exceeded|too[\s_]*many[\s_]*requests|resource_exhausted|overloaded/i;
