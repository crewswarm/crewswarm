/**
 * Chat handler — extracted from crew-lead.mjs
 * Handles user messages: LLM response, dispatch, pipelines, skills, tools.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  isSharedMemoryAvailable,
  recallMemoryContext,
  rememberFact,
  getMemoryStats,
  getKeeperStats,
  searchMemory,
} from "../memory/shared-adapter.mjs";

let _deps = {};

export function initChatHandler(deps) {
  _deps = { ...deps };
}

export async function handleChat({ message, sessionId = "default", userId = "default", firstName = "User", projectId = null }) {
  const cfg = _deps.loadConfig();
  let history = _deps.loadHistory(userId, sessionId);

  // ── Discovery Phase: Vague build requests trigger clarifying questions ───────
  // When user says "build X" but X is underspecified, ask 5 key questions before dispatching
  const isBuildRequest = /\b(build|create|make|implement|write|code|develop|ship)\b/i.test(message) && message.length > 15;
  const isVague = isBuildRequest && (
    message.length < 100 || // Too short to be specific
    !/\b(file|path|directory|\.js|\.py|\.html|\.css|src\/|pages\/|components\/|api\/)\b/i.test(message) // No concrete paths
  );
  
  // Check if we're already in discovery mode for this session
  const inDiscovery = history.some(h => h.content?.includes("[Discovery mode]"));
  const hasAnsweredDiscovery = history.some(h => h.role === "user" && h.content?.includes("Discovery answers:"));
  
  if (isVague && !inDiscovery && !hasAnsweredDiscovery) {
    // Enter discovery mode: ask clarifying questions
    const discoveryPrompt = `[Discovery mode] Your request needs more detail to ship something real. Answer these 5 questions (copy/paste and fill in):

**1. Who is this for?** (yourself, a client, a team, end users)
**2. What problem does it solve?** (one sentence)
**3. How do you know it worked?** (success metric or behavior)
**4. What constraints matter?** (tech stack, existing systems, performance, budget)
**5. What are you NOT building?** (scope boundaries, what to skip for v1)

Reply with your answers and I'll turn this into a concrete build plan with file paths and acceptance criteria.`;
    
    _deps.appendHistory(userId, sessionId, "user", message);
    _deps.appendHistory(userId, sessionId, "assistant", discoveryPrompt);
    _deps.broadcastSSE({ type: "chat_message", sessionId, role: "user", content: message });
    _deps.broadcastSSE({ type: "chat_message", sessionId, role: "assistant", content: discoveryPrompt });
    
    return { reply: discoveryPrompt, dispatched: null, pendingProject: null, pipeline: null };
  }

  // Fetch project context early (needed for both memory and project context injection)
  let activeProjectOutputDir = null;
  let projectContext = "";
  let currentProject = null;
  
  if (projectId) {
    try {
      const projRes = await fetch(`${_deps.DASHBOARD}/api/projects`, { signal: AbortSignal.timeout(2000) });
      const projData = await projRes.json();
      currentProject = (projData.projects || []).find(p => p.id === projectId);
      if (currentProject?.outputDir) {
        activeProjectOutputDir = currentProject.outputDir;
        const roadmapNote = currentProject.roadmapFile ? `\nROADMAP: ${currentProject.roadmapFile}` : "";
        projectContext = `\n\n[Active project: "${currentProject.name}" at ${currentProject.outputDir}${roadmapNote}. Use this path only when dispatching (in the task or context)—do not repeat the path in every reply. When dispatching to crew-qa, specify: Write your report to ${currentProject.outputDir}/qa-report.md.]`;
      }
    } catch { /* project lookup failed — proceed without context */ }
  }

  // Inject shared memory once at session start — lands in history and gets
  // prefix-cached on all subsequent calls (effectively free after first message).
  // Now uses CLI's MemoryBroker for unified retrieval (AgentKeeper + AgentMemory + Collections).
  if (history.length === 0) {
    try {
      let memoryContext = '';
      
      // Try CLI's MemoryBroker first (blends all memory sources)
      if (isSharedMemoryAvailable()) {
        const projectDir = activeProjectOutputDir || process.cwd();
        memoryContext = await recallMemoryContext(projectDir, 'session initialization chat context', {
          maxResults: 8,
          includeDocs: true,
          includeCode: false,
          preferSuccessful: true,
          crewId: 'crew-lead',
          userId: userId  // NEW: user-scoped memory
        });
      }
      
      // Fallback to legacy brain.md files if shared memory not available or empty
      if (!memoryContext) {
        const memDir = path.join(process.cwd(), "memory");
        const homeDir = os.homedir();
        const readMem = (p) => { try { return fs.readFileSync(p, "utf8").trim(); } catch { return ""; } };

        const brain     = readMem(_deps.BRAIN_PATH);
        const lessons   = readMem(path.join(memDir, "lessons.md"));
        const decisions = readMem(path.join(memDir, "decisions.md"));
        const rules     = readMem(path.join(homeDir, ".crewswarm", "global-rules.md"));

        const sections = [];
        if (brain)     sections.push(`## Shared Brain (accumulated facts)\n${brain}`);
        if (lessons)   sections.push(`## Lessons Learned\n${lessons}`);
        if (decisions) sections.push(`## Key Decisions\n${decisions}`);
        if (rules)     sections.push(`## Global Rules\n${rules}`);

        if (sections.length > 0) {
          memoryContext = `[Shared memory — injected once at session start]\n${sections.join("\n\n")}`;
        }
      }
      
      if (memoryContext) {
        _deps.appendHistory(userId, sessionId, "system", memoryContext);
        history = _deps.loadHistory(userId, sessionId);
        console.log(`[crew-lead] shared memory injected into session ${userId}:${sessionId} (${memoryContext.length} chars, source: ${isSharedMemoryAvailable() ? 'MemoryBroker' : 'legacy brain.md'})`);
      }
    } catch (e) {
      console.error("[crew-lead] shared memory injection failed:", e.message);
    }
  }

  // If a project is active, inject its brain + ROADMAP + PDD once per session —
  // all cached in the history prefix so subsequent messages get them for free.
  // If the project changes mid-session, inject the new project context with a
  // clear "switched to" marker so crew-lead knows which project is now active.
  if (currentProject?.outputDir) {
    try {
      const projName = currentProject.name || projectId;
      const outDir   = currentProject.outputDir;

      // Check if THIS specific project's context is already in history
      const alreadyInjected = history.some(h => h.content?.includes(`[Project memory — ${projName}`));

      if (!alreadyInjected) {
        const readSafe = (p) => { try { return fs.readFileSync(p, "utf8").trim(); } catch { return ""; } };

        const projBrain = readSafe(path.join(outDir, ".crewswarm", "brain.md"));
        const roadmap   = readSafe(path.join(outDir, "ROADMAP.md"));
        const pddPaths  = ["PDD.md", "pdd.md", `${projName}-pdd.md`, "design.md", "DESIGN.md"];
        const pdd       = pddPaths.map(f => readSafe(path.join(outDir, f))).find(c => c) || "";

        // Detect mid-session project switch (another project was already injected)
        const prevProject = history.find(h => h.content?.includes("[Project memory —"));
        const isSwitch = !!prevProject;
        const switchNote = isSwitch ? `⚠️ User switched active project to "${projName}". Previous project context above is no longer active — use this project's context from here on.\n\n` : "";

        const sections = [];
        if (projBrain) sections.push(`### Project Brain\n${projBrain}`);
        if (roadmap)   sections.push(`### ROADMAP\n${roadmap}`);
        if (pdd)       sections.push(`### PDD / Design\n${pdd.slice(0, 2000)}`);

        const combined = `[Project memory — ${projName} at ${outDir}]\n${switchNote}${sections.join("\n\n") || "(no project files found yet)"}`;
        _deps.appendHistory(userId, sessionId, "system", combined);
        history = _deps.loadHistory(userId, sessionId);
        console.log(`[crew-lead] project context ${isSwitch ? "switched" : "injected"} for "${projName}": brain=${projBrain.length} roadmap=${roadmap.length} pdd=${pdd.length} chars`);
      }
    } catch (e) {
      console.error("[crew-lead] project context injection failed:", e.message);
    }
  }

  // ── Direct @@DISPATCH in user message — bypass LLM and execute immediately ──
  // This prevents the LLM from intercepting user-issued dispatch commands
  const userDispatch = _deps.parseDispatch(message, message);
  if (userDispatch) {
    console.log(`[crew-lead] Direct @@DISPATCH detected from user — bypassing LLM`);
    const resolvedAgent = _deps.resolveAgentId(cfg, userDispatch.agent) || userDispatch.agent;
    if (cfg.knownAgents.includes(resolvedAgent)) {
      userDispatch.agent = resolvedAgent;
      const pipelineMeta = activeProjectOutputDir ? { projectDir: activeProjectOutputDir } : null;
      const taskId = _deps.dispatchTask(resolvedAgent, userDispatch, sessionId, pipelineMeta);
      if (taskId) {
        const reply = `Dispatched to ${resolvedAgent} — reply will show here when they finish.`;
        _deps.appendHistory(userId, sessionId, "user", message);
        _deps.appendHistory(userId, sessionId, "system", `You dispatched to ${resolvedAgent}: "${(userDispatch.task || "").slice(0, 200)}".`);
        _deps.appendHistory(userId, sessionId, "assistant", reply);
        _deps.broadcastSSE({ type: "chat_message", sessionId, role: "user", content: message });
        _deps.broadcastSSE({ type: "chat_message", sessionId, role: "assistant", content: reply });
        return { reply, dispatched: userDispatch, pendingProject: null, pipeline: null };
      }
    } else {
      const reply = `Agent "${userDispatch.agent}" not found. Available: ${cfg.knownAgents.join(", ")}`;
      _deps.appendHistory(userId, sessionId, "user", message);
      _deps.appendHistory(userId, sessionId, "assistant", reply);
      _deps.broadcastSSE({ type: "chat_message", sessionId, role: "user", content: message });
      _deps.broadcastSSE({ type: "chat_message", sessionId, role: "assistant", content: reply });
      return { reply, dispatched: null, pendingProject: null, pipeline: null };
    }
  }

  // ── Programmatic service control — fire immediately, don't wait for LLM ──────
  // This prevents the LLM from ever claiming it "can't" restart services.
  const serviceIntent = _deps.parseServiceIntent(message);
  if (serviceIntent) {
    const { action, id } = serviceIntent;
    const actionLabel = action === "stop" ? "stopped" : "restarted";
    try {
      const isSpecificAgent = id.startsWith("crew-") && id !== "crew-lead";
      let ok = false;
      if (isSpecificAgent) {
        const r = await fetch(`http://127.0.0.1:${_deps.PORT}/api/agents/${id}/restart`, {
          method: "POST",
          headers: _deps.getRTToken() ? { authorization: `Bearer ${_deps.getRTToken()}` } : {},
          signal: AbortSignal.timeout(8000),
        });
        ok = (await r.json())?.ok !== false;
      } else {
        const endpoint = action === "stop" ? "/api/services/stop" : "/api/services/restart";
        const r = await fetch(`${_deps.DASHBOARD}${endpoint}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
          signal: AbortSignal.timeout(8000),
        });
        const data = await r.json();
        if (data?.ok === false && data?.message) {
          const reply = `${data.message}`;
          _deps.appendHistory(userId, sessionId, "user", message);
          _deps.appendHistory(userId, sessionId, "assistant", reply);
          _deps.broadcastSSE({ type: "chat_message", sessionId, role: "user", content: message });
          _deps.broadcastSSE({ type: "chat_message", sessionId, role: "assistant", content: reply });
          return { reply, dispatched: null, pendingProject: null, pipeline: null };
        }
        ok = true;
      }
      if (ok) {
        const reply = `On it — **${id}** ${actionLabel}. Give it 3–5 seconds to reconnect to the RT bus, then ask me "agents online?" for a fresh count.`;
        _deps.appendHistory(userId, sessionId, "user", message);
        _deps.appendHistory(userId, sessionId, "assistant", reply);
        _deps.appendHistory(userId, sessionId, "system", `Service ${id} ${actionLabel} via direct intent detection.`);
        _deps.broadcastSSE({ type: "chat_message", sessionId, role: "user", content: message });
        _deps.broadcastSSE({ type: "chat_message", sessionId, role: "assistant", content: reply });
        console.log(`[crew-lead] service intent: ${action} ${id} → ok`);
        return { reply, dispatched: null, pendingProject: null, pipeline: null };
      }
    } catch (e) {
      console.error(`[crew-lead] service intent failed: ${e.message}`);
      // fall through to normal LLM response on error
    }
  }

  // Autonomous PM loop: user says "run until done" / "build until done" → we auto-ping PM on each handback
  if (/run\s+until\s+done|autonomous\s+build|build\s+until\s+done/i.test(message.trim())) {
    _deps.autonomousPmLoopSessions.add(sessionId);
  }
  if (/stop\s+autonomous|stop\s+(the\s+)?build/i.test(message.trim())) {
    _deps.autonomousPmLoopSessions.delete(sessionId);
  }

  // Hard kill: "kill everything", "kill all agents", "nuke it" — SIGTERM bridges + PM loops
  if (/\bkill\s+(everything|all|it\s+all|all\s+agents?|the\s+agents?)\b|\bnuke\s+it\b|\bnuke\s+everything\b/i.test(message.trim())) {
    const pipelineCancelled = _deps.cancelAllPipelines(sessionId);
    _deps.autonomousPmLoopSessions.clear();
    let pmLoopsKilled = 0, bridgesKilled = 0;
    try {
      const { execSync } = await import("node:child_process");
      const logsDir = _deps.orchestratorLogsDir;
      if (fs.existsSync(logsDir)) {
        for (const f of fs.readdirSync(logsDir)) {
          if (f.startsWith("pm-loop") && f.endsWith(".pid")) {
            fs.writeFileSync(path.join(logsDir, f.replace(".pid", ".stop")), new Date().toISOString());
            const pid = parseInt(fs.readFileSync(path.join(logsDir, f), "utf8").trim(), 10);
            if (pid) { try { process.kill(pid, "SIGTERM"); pmLoopsKilled++; } catch {} }
          }
        }
      }
      try { execSync(`pkill -f "gateway-bridge.mjs" 2>/dev/null`, { stdio: "ignore", shell: true }); bridgesKilled = 1; } catch {}
    } catch {}
    const parts = [];
    if (pipelineCancelled > 0) parts.push(`${pipelineCancelled} pipeline(s) cancelled`);
    if (pmLoopsKilled > 0) parts.push(`${pmLoopsKilled} PM loop(s) killed`);
    if (bridgesKilled) parts.push("all agent bridges killed");
    if (parts.length === 0) parts.push("nothing was running");
    const reply = `💀 Hard kill executed: ${parts.join(", ")}. Use \`@@SERVICE restart agents\` or the Services tab to bring bridges back up.`;
    _deps.broadcastSSE({ type: "chat", from: "crew-lead", content: reply, sessionId, ts: Date.now() });
    _deps.broadcastSSE({ type: "kill_all", ts: Date.now(), summary: parts.join(", ") });
    _deps.appendHistory(userId, sessionId, "assistant", reply);
    return { reply, sessionId };
  }

  // Graceful stop: "stop everything", "stop all", "emergency stop", "halt everything"
  if (/\b(stop|halt|abort|cancel)\s+(everything|all|it\s+all)\b|\bemergency\s+stop\b/i.test(message.trim())) {
    const pipelineCancelled = _deps.cancelAllPipelines(sessionId);
    const wasAutonomous = _deps.autonomousPmLoopSessions.has(sessionId);
    _deps.autonomousPmLoopSessions.clear();
    let pmLoopsStopped = 0;
    try {
      const logsDir = _deps.orchestratorLogsDir;
      if (fs.existsSync(logsDir)) {
        for (const f of fs.readdirSync(logsDir)) {
          if (f.startsWith("pm-loop") && f.endsWith(".pid")) {
            fs.writeFileSync(path.join(logsDir, f.replace(".pid", ".stop")), new Date().toISOString());
            pmLoopsStopped++;
          }
        }
      }
    } catch {}
    const parts = [];
    if (pipelineCancelled > 0) parts.push(`${pipelineCancelled} pipeline(s) cancelled`);
    if (pmLoopsStopped > 0) parts.push(`${pmLoopsStopped} PM loop(s) signalled to stop after current task`);
    if (wasAutonomous) parts.push("autonomous mode cleared");
    if (parts.length === 0) parts.push("nothing was running — all clear");
    const reply = `🛑 Graceful stop: ${parts.join(", ")}. PM loops will finish their current task then halt. Say "kill everything" to hard-kill agent bridges immediately.`;
    _deps.broadcastSSE({ type: "chat", from: "crew-lead", content: reply, sessionId, ts: Date.now() });
    _deps.broadcastSSE({ type: "stop_all", ts: Date.now(), summary: parts.join(", ") });
    _deps.appendHistory(userId, sessionId, "assistant", reply);
    return { reply, sessionId };
  }

  // Pipeline cancel: "stop pipeline", "cancel pipeline", "abort", "stop everything", "kill it"
  if (/\b(stop|cancel|abort|kill|halt)\b.*(pipeline|dispatch|task|everything|it|all|them)\b|\b(pipeline|dispatch).*(stop|cancel|abort|kill|halt)\b/i.test(message.trim())) {
    const count = _deps.cancelAllPipelines(sessionId);
    if (count > 0) {
      const reply = `Cancelled ${count} running pipeline(s). All pending waves have been dropped. You can re-dispatch when ready.`;
      _deps.broadcastSSE({ type: "chat", from: "crew-lead", content: reply, sessionId, ts: Date.now() });
      return { reply, sessionId };
    }
  }

  const needsSearch = _deps.messageNeedsSearch(message);
  // Inject health snapshot broadly — lightweight pgrep + file reads, not HTTP
  const needsHealth = message.length < 6
    ? false
    : /health|status|running|crashed|down\b|restart|skill|agent|workflow|pipeline|who.s.up|who.s.online|anyone.up|each.*up|up\?|is.*up|are.*up|online|services?|telegram|tg\b|opencode|project.*dir|projects?\b|registered.project|what.projects|list.project|settings|what.s.going|what.s.happening|recent.activity|rt.bus|eyes|see.what/i.test(message);
  const needsBenchmarkCatalog = message.length > 4 && /benchmark|zeroeval|leaderboard|llm-stats|swe-bench|livecodebench|mmlu|gpqa|humaneval|gsm8k|what\.tests?|which\.tests?|available\.tests?/i.test(message);
  let braveResults = null;
  let codebaseResults = null;
  let healthData = null;
  let benchmarkCatalog = null;
  const fetchBenchmarkCatalog = async () => {
    const r = await fetch("https://api.zeroeval.com/leaderboard/benchmarks", { signal: AbortSignal.timeout(10000) });
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) return null;
    const limit = 250;
    const rows = arr.slice(0, limit).map(b => {
      const id = b.benchmark_id || b.id || "";
      const name = (b.name || id).slice(0, 35);
      const desc = (b.description || "").slice(0, 60).replace(/\n/g, " ");
      return `${id} | ${name} | ${desc}`;
    });
    const suffix = arr.length > limit ? `\n… and ${arr.length - limit} more (full list at api.zeroeval.com)` : "";
    return `[Benchmark catalog from ZeroEval — use benchmark_id in @@SKILL zeroeval.benchmark {"benchmark_id":"<id>"}]\n${rows.join("\n")}${suffix}`;
  };
  try {
    const [b, c, h, bc] = await Promise.all([
    needsSearch ? _deps.searchWithBrave(message).catch(() => null) : null,
    needsSearch ? Promise.resolve(_deps.searchCodebase(message)).catch(() => null) : null,
    needsHealth ? (async () => {
      try {
        const cfgRaw    = _deps.tryRead(path.join(os.homedir(), ".crewswarm", "config.json")) || {};
        const skillsDir = path.join(os.homedir(), ".crewswarm", "skills");
        let skillsDetail = [];
        try {
          const files = fs.readdirSync(skillsDir).filter(f => f.endsWith(".json"));
          for (const f of files) {
            const name = f.replace(".json", "");
            try {
              const def = JSON.parse(fs.readFileSync(path.join(skillsDir, f), "utf8"));
              const desc = (def.description || "").replace(/\s+/g, " ").trim().slice(0, 100);
              const notes = def.paramNotes || "";
              const example = `@@SKILL ${name} ${JSON.stringify(def.defaultParams || {})}`;
              let line = `  - ${name}: ${desc}`;
              if (notes) line += ` | Params: ${notes}`;
              if (def.listUrl && def.listUrlIdField) {
                try {
                  const r = await fetch(def.listUrl, { signal: AbortSignal.timeout(5000) });
                  const arr = await r.json();
                  if (Array.isArray(arr) && arr.length) {
                    const idField = def.listUrlIdField;
                    const ids = arr.slice(0, 50).map(b => b[idField]).filter(Boolean);
                    line += ` | IDs (live): ${ids.join(", ")}${arr.length > 50 ? ` … +${arr.length - 50} more` : ""}`;
                  }
                } catch {}
              }
              line += ` | Example: ${example}`;
              skillsDetail.push(line);
            } catch { skillsDetail.push(`  - ${name}: (parse failed)`); }
          }
        } catch {}
        // Quick service status via pgrep (processes, not agent connections)
        const { execSync: esc } = await import("node:child_process");
        const isRunning = (pat) => { try { esc(`pgrep -f "${pat}"`, { stdio: "ignore" }); return true; } catch { return false; } };

        // Per-agent bridge status from RT bus — who is actually connected right now
        let rtAgentsOnline = new Set();
        try {
          const rtResp = await fetch("http://127.0.0.1:18889/status", { signal: AbortSignal.timeout(1500) });
          const rtData = await rtResp.json();
          if (Array.isArray(rtData.agents)) rtAgentsOnline = new Set(rtData.agents);
        } catch {}

        const allAgents = cfg.agentRoster.length
          ? cfg.agentRoster
          : cfg.knownAgents.map(id => ({ id, emoji: "🤖", model: "" }));

        const agentRows = allAgents.map(a => {
          const online = rtAgentsOnline.has(a.id);
          const status = online ? "✅" : "❌";
          return `  ${status} ${a.emoji||"🤖"} ${a.id}: tools=${_deps.readAgentTools(a.id).tools.join(",")||"(default)"} model=${a.model||"??"}`;
        });

        const rtBusUp = isRunning("opencrew-rt-daemon");
        const services = [
          `RT bus (18889): ${rtBusUp ? `✅ running — ${rtAgentsOnline.size} agents connected: ${[...rtAgentsOnline].join(", ")||"none"}` : "❌ DOWN — use @@SERVICE restart rt-bus"}`,
          `Telegram bridge: ${isRunning("telegram-bridge") ? "✅ running" : "⚠️ stopped — use @@SERVICE restart telegram"}`,
          `OpenCode (4096): ${isRunning("opencode serve") ? "✅ running" : "⚠️ stopped"}`,
        ];

        let projectsLine = "Registered projects (dashboard Projects tab): (none)";
        try {
          const projRes = await fetch(`${_deps.DASHBOARD}/api/projects`, { signal: AbortSignal.timeout(2000) });
          if (projRes.ok) {
            const projData = await projRes.json();
            const projects = projData.projects || [];
            if (projects.length) {
              projectsLine = `Registered projects (${projects.length}): ${projects.map(p => `${p.name || p.id} → ${p.outputDir || p.roadmapFile || "?"}`).join("; ")}`;
            }
          }
        } catch {}
        const projectsSnapshot = projectsLine;

        const rtActivityLog = _deps.rtActivityLog || [];
        return [
          `[System health snapshot — live data from your local machine, fetched right now]`,
          `crew-lead: ${cfg.providerKey}/${cfg.modelId} | RT connected: ${!!_deps.getRtPublish()} | uptime: ${Math.floor(process.uptime()/300)*5}min`,
          `crew-lead (this process) can create skills: use @@DEFINE_SKILL name + JSON + @@END_SKILL when the user asks. The agent list below is bridge agents only.`,
          `OpenCode project dir: ${cfgRaw.opencodeProject || "(not set — agents write to repo root)"}`,
          projectsSnapshot,
          `Skills installed (${skillsDetail.length}):`,
          ...(skillsDetail.length ? skillsDetail : ["(none)"]),
          ``,
          (() => {
            let pipelineNames = [];
            try {
              const pipelinesDir = path.join(os.homedir(), ".crewswarm", "pipelines");
              if (fs.existsSync(pipelinesDir)) pipelineNames = fs.readdirSync(pipelinesDir).filter(f => f.endsWith(".json")).map(f => f.replace(".json", ""));
            } catch {}
            return `Workflows (pipelines for cron) (${pipelineNames.length}): ${pipelineNames.length ? pipelineNames.join(", ") : "(none)"}`;
          })(),
          ``,
          `Services:`,
          ...services,
          ``,
          `Agents (${agentRows.length}):`,
          ...agentRows,
          ...(rtActivityLog.length > 0 ? [
            ``,
            `Recent RT activity (newest last; crew-lead sees all bus traffic):`,
            ...rtActivityLog.slice(-25).map((e) => `  ${e.time} [${e.channel}] ${e.summary}`),
            ``,
          ] : []),
          `[Use this data to answer the user's question. Do NOT say you cannot reach localhost.]`,
        ].join("\n");
      } catch { return null; }
    })() : null,
    needsBenchmarkCatalog ? fetchBenchmarkCatalog().catch(() => null) : null,
  ]);
    braveResults = b;
    codebaseResults = c;
    healthData = h;
    benchmarkCatalog = bc;
  } catch (e) {
    console.error("[crew-lead] context fetch failed:", e?.message || e);
  }
  // Auto-search history for context when user asks about past conversations
  const needsHistorySearch = message.length > 8 && /\b(last time|before|earlier|previously|we discussed|you said|i asked|remember when|what did|history of|past conversation|mentioned|talked about|said something|tell me again)\b/i.test(message);
  let historyContext = null;
  
  if (needsHistorySearch) {
    try {
      // Extract key terms from the question
      const terms = message
        .replace(/\b(what|when|where|who|how|why|did|do|does|is|are|was|were|have|has|had|tell|show|find|search|remember|mentioned|discussed|said|talked)\b/gi, "")
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter(w => w.length > 4)
        .slice(0, 3)
        .join(" ");
      
      if (terms.trim()) {
        const histDir = path.join(os.homedir(), ".crewswarm", "chat-history");
        if (fs.existsSync(histDir)) {
          const files = fs.readdirSync(histDir).filter(f => f.endsWith(".jsonl")).sort().reverse().slice(0, 10); // Last 10 sessions
          const lq = terms.toLowerCase();
          const hits = [];
          
          for (const file of files) {
            const lines = fs.readFileSync(path.join(histDir, file), "utf8").split("\n");
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const entry = JSON.parse(line);
                if ((entry.content || "").toLowerCase().includes(lq)) {
                  const snippet = (entry.content || "").slice(0, 400).replace(/\n/g, " ");
                  hits.push(`[${entry.role}] ${snippet}`);
                  if (hits.length >= 3) break;
                }
              } catch {}
            }
            if (hits.length >= 3) break;
          }
          
          if (hits.length > 0) {
            historyContext = `[Past conversation context - automatically retrieved]\n${hits.join("\n\n")}`;
            console.log(`[crew-lead] Auto-retrieved ${hits.length} history matches for: ${terms}`);
          }
        }
      }
    } catch (e) {
      console.error(`[crew-lead] Auto history search failed: ${e.message}`);
    }
  }

  const parts = [message + projectContext];
  if (historyContext) parts.push(historyContext);
  if (braveResults) parts.push(`[Web context from Brave Search]\n${braveResults}`);
  if (codebaseResults) parts.push(`[Codebase context from workspace]\n${codebaseResults}`);
  if (healthData) parts.push(healthData);
  if (benchmarkCatalog) parts.push(benchmarkCatalog);
  const userContent = parts.length > 1 ? parts.join("\n\n") : (message + projectContext);

  // Many chat APIs use only the first system message; agent completions (e.g. [crew-pm completed task]) are stored as "system" in history and would be dropped. Send them as "user" with a prefix so Stinki always sees them.
  const historyAsMessages = history.map(h => {
    if (h.role === "system") {
      return { role: "user", content: `[Crew update — use this when answering]\n${h.content}` };
    }
    return { role: h.role, content: h.content };
  });
  const messages = [
    { role: "system", content: _deps.buildSystemPrompt(cfg) },
    ...historyAsMessages,
    { role: "user", content: userContent },
  ];

  _deps.appendHistory(userId, sessionId, "user", message);
  // Audit trail: record what Brave actually injected so later turns (and you) can verify — no "context #5" confabulation
  if (braveResults) {
    const count = (braveResults.match(/\n\n/g) || []).length + 1;
    // Keep full numbered list (1. ... 2. ... 5. ...) in history so later turns can cite accurately — ~1200 chars usually includes result #5
    const preview = braveResults.replace(/\n/g, " ").slice(0, 1200);
    _deps.appendHistory(userId, sessionId, "system", `[Brave search] query="${message.slice(0, 60)}${message.length > 60 ? "…" : ""}" → ${count} results. Preview: ${preview}${braveResults.length > 1200 ? "…" : ""}`);
  }
  _deps.broadcastSSE({ type: "chat_message", sessionId, role: "user", content: message });

  const llmResult = await _deps.callLLM(messages, cfg);
  let fullReply = llmResult.reply;
  const usedFallback = llmResult.usedFallback;
  const activeModel = llmResult.model;
  const fallbackReason = llmResult.reason;

  // ── Direct tool execution (all crew-lead native tools) ──────────────────
  const hasDirectTools = /@@READ_FILE[ \t]|@@WRITE_FILE[ \t]|@@WEB_SEARCH[ \t]|@@WEB_FETCH[ \t]|@@MKDIR[ \t]|@@RUN_CMD[ \t]|@@TELEGRAM[ \t]|@@WHATSAPP[ \t]|@@SEARCH_HISTORY[ \t]/.test(fullReply);
  if (hasDirectTools) {
    const toolResults = await _deps.execCrewLeadTools(fullReply);
    if (toolResults.length > 0) {
      // Follow-up LLM call: show the tool results so crew-lead can give a proper answer
      const followUpMessages = [
        { role: "system", content: _deps.buildSystemPrompt(cfg) },
        ...historyAsMessages,
        { role: "user", content: userContent },
        { role: "assistant", content: fullReply },
        { role: "user", content: `[Tool results]\n${toolResults.join("\n\n")}\n\nUsing only the above results, give a concise, direct answer to the user. IMPORTANT: Do NOT emit any @@ tags in your reply (no @@DISPATCH, @@PIPELINE, @@READ_FILE, @@RUN_CMD, @@WEB_SEARCH, or any other @@command). The tool phase is complete — just answer in plain text.` },
      ];
      try {
        const followUp = await _deps.callLLM(followUpMessages, cfg);
        fullReply = followUp.reply;
      } catch (e) {
        // fallback: append raw tool results if follow-up fails
        fullReply = fullReply + "\n\n---\n" + toolResults.join("\n\n");
      }
    }
  }

  // ── @@TOOLS — permission grant/revoke command ──────────────────────────────
  const toolsCmd = (() => {
    const m = fullReply.match(/@@TOOLS\s+(\{[^}]+\})/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
  })();

  // ── @@PROMPT — read/write an agent's system prompt ─────────────────────────
  // Parsed from LLM reply OR user message so pasting @@PROMPT in chat always runs (LLM often doesn't echo it)
  // @@PROMPT {"agent":"crew-qa","set":"You are a QA specialist..."}
  // @@PROMPT {"agent":"crew-qa","append":"- Always use @@READ_FILE before auditing"}
  const promptCmd = (() => {
    const promptRe = /@@PROMPT\s+(\{[\s\S]*?\})\s*(?:\n|$)/;
    const fromReply = fullReply.match(promptRe);
    if (fromReply) { try { return JSON.parse(fromReply[1]); } catch {} }
    const fromUser = (message || "").match(promptRe);
    if (fromUser) { try { return JSON.parse(fromUser[1]); } catch {} }
    return null;
  })();

  // ── @@CREATE_AGENT — dynamically create a new specialist agent ────────────
  // @@CREATE_AGENT {"id":"crew-ml","role":"coder","displayName":"MLBot","description":"AI/ML and data science"}
  const createAgentCmd = (() => {
    const m = fullReply.match(/@@CREATE_AGENT\s+(\{[^}]+\})/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
  })();

  // ── @@REMOVE_AGENT — remove a dynamically created agent ─────────────────
  // @@REMOVE_AGENT crew-ml
  const removeAgentCmd = (() => {
    const m = fullReply.match(/@@REMOVE_AGENT\s+(crew-[a-zA-Z0-9_-]+)/);
    return m ? m[1] : null;
  })();

  // ── @@BRAIN — append a fact to shared brain.md ─────────────────────────────
  // @@BRAIN crew-lead: some durable fact worth remembering
  const BRAIN_PLACEHOLDERS = /^(note text|some fact|placeholder|example|durable fact|fact here|your fact|insert fact|crew-lead: note|crew-lead: some)/i;
  const brainCmd = (() => {
    const m = fullReply.match(/@@BRAIN\s+([^\n]+)/);
    if (!m) return null;
    const entry = m[1].trim();
    if (BRAIN_PLACEHOLDERS.test(entry) || entry.length < 10) return null; // skip template leakage
    return entry;
  })();

  // ── @@MEMORY — search shared memory (AgentKeeper + AgentMemory + Collections)
  // @@MEMORY search "query text"
  // @@MEMORY stats
  const memoryCmd = (() => {
    const searchMatch = fullReply.match(/@@MEMORY\s+search\s+"([^"]+)"/i) || 
                        fullReply.match(/@@MEMORY\s+search\s+([^\n]+)/i);
    if (searchMatch) return { action: 'search', query: searchMatch[1].trim() };
    
    if (/@@MEMORY\s+stats\b/i.test(fullReply)) return { action: 'stats' };
    
    return null;
  })();

  // ── @@GLOBALRULE — append a rule to global-rules.md (injected into all agents)
  // @@GLOBALRULE Always reply in the language the user wrote in
  const globalRuleCmd = (() => {
    const m = fullReply.match(/@@GLOBALRULE\s+([^\n]+)/);
    return m ? m[1].trim() : null;
  })();

  // ── @@STOP — graceful stop: cancel pipelines + signal PM loops + clear autonomous ─
  // PM loops finish their current task before halting. Agent bridges keep running.
  if (/@@STOP\b/.test(fullReply) && !/@@KILL\b/.test(fullReply)) {
    const pipelineCancelled = _deps.cancelAllPipelines(sessionId);
    const wasAutonomous = _deps.autonomousPmLoopSessions.has(sessionId);
    _deps.autonomousPmLoopSessions.clear();
    let pmLoopsStopped = 0;
    try {
      const logsDir = _deps.orchestratorLogsDir;
      if (fs.existsSync(logsDir)) {
        for (const f of fs.readdirSync(logsDir)) {
          if (f.startsWith("pm-loop") && f.endsWith(".pid")) {
            fs.writeFileSync(path.join(logsDir, f.replace(".pid", ".stop")), new Date().toISOString());
            pmLoopsStopped++;
          }
        }
      }
    } catch {}
    const parts = [];
    if (pipelineCancelled > 0) parts.push(`${pipelineCancelled} pipeline(s) cancelled`);
    if (pmLoopsStopped > 0) parts.push(`${pmLoopsStopped} PM loop(s) signalled to stop after current task`);
    if (wasAutonomous) parts.push("autonomous mode cleared");
    if (parts.length === 0) parts.push("nothing was running");
    console.log(`[crew-lead] @@STOP executed: ${parts.join(", ")}`);
    _deps.broadcastSSE({ type: "stop_all", ts: Date.now(), summary: parts.join(", ") });
  }

  // ── @@KILL — hard kill: everything @@STOP does + SIGTERM agent bridges + PM loop procs ─
  // Use when agents are stuck, looping, or unresponsive and you need them dead now.
  if (/@@KILL\b/.test(fullReply)) {
    const pipelineCancelled = _deps.cancelAllPipelines(sessionId);
    _deps.autonomousPmLoopSessions.clear();
    let pmLoopsKilled = 0;
    let bridgesKilled = 0;
    try {
      const { execSync } = await import("node:child_process");
      const logsDir = _deps.orchestratorLogsDir;
      // Hard-kill each PM loop process by PID
      if (fs.existsSync(logsDir)) {
        for (const f of fs.readdirSync(logsDir)) {
          if (f.startsWith("pm-loop") && f.endsWith(".pid")) {
            fs.writeFileSync(path.join(logsDir, f.replace(".pid", ".stop")), new Date().toISOString());
            const pid = parseInt(fs.readFileSync(path.join(logsDir, f), "utf8").trim(), 10);
            if (pid) { try { process.kill(pid, "SIGTERM"); pmLoopsKilled++; } catch {} }
          }
        }
      }
      // Kill all agent gateway bridges (they will be respawnable via @@SERVICE restart agents)
      try { execSync(`pkill -f "gateway-bridge.mjs" 2>/dev/null`, { stdio: "ignore", shell: true }); bridgesKilled = 1; } catch {}
    } catch {}
    const parts = [];
    if (pipelineCancelled > 0) parts.push(`${pipelineCancelled} pipeline(s) cancelled`);
    if (pmLoopsKilled > 0) parts.push(`${pmLoopsKilled} PM loop process(es) SIGTERM'd`);
    if (bridgesKilled) parts.push("all agent bridges killed (restart with @@SERVICE restart agents)");
    if (parts.length === 0) parts.push("nothing was running");
    console.log(`[crew-lead] @@KILL executed: ${parts.join(", ")}`);
    _deps.broadcastSSE({ type: "kill_all", ts: Date.now(), summary: parts.join(", ") });
  }

  // ── @@SERVICE — restart/stop a service or agent bridge ──────────────────────
  // @@SERVICE restart telegram   @@SERVICE stop agents   @@SERVICE restart crew-coder
  const serviceCmd = (() => {
    const m = fullReply.match(/@@SERVICE\s+(restart|stop|start)\s+([a-zA-Z0-9_\-]+)/);
    return m ? { action: m[1], id: m[2] } : null;
  })();

  // ── @@DEFINE_SKILL — crew-lead writes a skill JSON to ~/.crewswarm/skills/
  // @@DEFINE_SKILL skillname\n{...json...}\n@@END_SKILL
  const defineSkillCmds = [];
  const defineSkillRe = /@@DEFINE_SKILL[ \t]+([a-zA-Z0-9_\-.]+)\n([\s\S]*?)@@END_SKILL/g;
  let dsMatch;
  while ((dsMatch = defineSkillRe.exec(fullReply)) !== null) {
    const skillName = dsMatch[1].trim();
    const rawJson   = dsMatch[2].trim();
    try {
      const def = JSON.parse(rawJson);
      const skillsDir = path.join(os.homedir(), ".crewswarm", "skills");
      fs.mkdirSync(skillsDir, { recursive: true });
      fs.writeFileSync(path.join(skillsDir, skillName + ".json"), JSON.stringify(def, null, 2));
      defineSkillCmds.push({ name: skillName, ok: true });
      console.log(`[crew-lead] @@DEFINE_SKILL saved: ${skillName}`);
    } catch (e) {
      defineSkillCmds.push({ name: skillName, ok: false, error: e.message });
    }
  }

  // ── @@DEFINE_WORKFLOW — create or replace a scheduled pipeline (stages: agent + task per stage)
  // @@DEFINE_WORKFLOW name\n[...]\n@@END_WORKFLOW
  const defineWorkflowCmds = [];
  const defineWorkflowRe = /@@DEFINE_WORKFLOW[ \t]+([a-zA-Z0-9_\-]+)\n([\s\S]*?)@@END_WORKFLOW/g;
  let dwMatch;
  while ((dwMatch = defineWorkflowRe.exec(fullReply)) !== null) {
    const wfName = dwMatch[1].trim();
    const rawJson = dwMatch[2].trim();
    try {
      const stages = JSON.parse(rawJson);
      if (!Array.isArray(stages)) throw new Error("stages must be a JSON array");
      const valid = stages
        .filter(s => s && s.agent && (s.task || s.taskText))
        .map(s => ({ agent: s.agent, task: s.task || s.taskText || "", tool: s.tool || undefined }));
      const pipelinesDir = path.join(os.homedir(), ".crewswarm", "pipelines");
      fs.mkdirSync(pipelinesDir, { recursive: true });
      fs.writeFileSync(path.join(pipelinesDir, wfName + ".json"), JSON.stringify({ stages: valid }, null, 2));
      defineWorkflowCmds.push({ name: wfName, ok: true, stageCount: valid.length });
      console.log(`[crew-lead] @@DEFINE_WORKFLOW saved: ${wfName} (${valid.length} stages)`);
    } catch (e) {
      defineWorkflowCmds.push({ name: wfName, ok: false, error: e.message });
    }
  }

  const pipelineSteps = _deps.parsePipeline(fullReply);
  const projectSpec = !pipelineSteps ? _deps.parseProject(fullReply) : null;
  const dispatch = !projectSpec && !pipelineSteps ? _deps.parseDispatch(fullReply, message) : null;
  
  if (dispatch) {
    console.log(`[chat-handler] parseDispatch found: agent=${dispatch.agent}, isDispatchIntended=${_deps.isDispatchIntended(message)}`);
  }
  // ── @@SKILL — crew-lead executes skills directly (no dispatch needed)
  const skillCalls = [];
  // Require skill name to be followed by JSON params or end-of-line — prevents "@@SKILL line" in prose
  const skillRe = /@@SKILL[ \t]+([a-zA-Z0-9_\-\.]+)[ \t]*(\{[^\n]*\})?(?=[ \t]*$|[ \t]*\n|[ \t]*\{)/gm;
  let skMatch;
  while ((skMatch = skillRe.exec(fullReply)) !== null) {
    const skillName = skMatch[1].trim();
    let params = {};
    try { if (skMatch[2]) params = JSON.parse(skMatch[2]); } catch {}
    skillCalls.push({ skillName, params });
  }

  let cleanReply = _deps.stripThink(_deps.stripPipeline(_deps.stripProject(_deps.stripDispatch(fullReply))))
    .replace(/@@SKILL[ \t]+[a-zA-Z0-9_\-\.]+[ \t]*(\{[^\n]*\})?(?=[ \t]*$|[ \t]*\n|[ \t]*\{)/gm, "")
    .replace(/@@TOOLS\s+\{[^}]+\}/g, "")
    .replace(/@@PROMPT\s+\{[\s\S]*?\}\s*(?:\n|$)/g, "")
    .replace(/@@BRAIN\s+[^\n]+/g, "")
    .replace(/@@MEMORY\s+(search|stats)\s*[^\n]*/gi, "")
    .replace(/@@GLOBALRULE\s+[^\n]+/g, "")
    .replace(/@@DEFINE_SKILL[ \t]+[a-zA-Z0-9_\-.]+\n[\s\S]*?@@END_SKILL/g, "")
    .replace(/@@DEFINE_WORKFLOW[ \t]+[a-zA-Z0-9_\-]+\n[\s\S]*?@@END_WORKFLOW/g, "")
    .replace(/@@SERVICE\s+(restart|stop|start)\s+[a-zA-Z0-9_\-]+/g, "")
    .replace(/@@STOP\b/g, "")
    .replace(/@@KILL\b/g, "")
    .replace(/@@CREATE_AGENT\s+\{[^}]+\}/g, "")
    .replace(/@@REMOVE_AGENT\s+crew-[a-zA-Z0-9_-]+/g, "")
    .trim();

  let dispatched = null;
  let pendingProject = null;
  let pipeline = null;

  if (projectSpec?.name && projectSpec?.outputDir) {
    try {
      pendingProject = await _deps.draftProject(projectSpec, sessionId);
      _deps.appendHistory(userId, sessionId, "system", `Roadmap drafted for "${projectSpec.name}" — awaiting user approval.`);
      if (pendingProject) _deps.broadcastSSE({ type: "pending_project", sessionId, pendingProject });
    } catch (e) {
      console.error(`[crew-lead] Roadmap draft failed: ${e.message}`);
      _deps.appendHistory(userId, sessionId, "system", `Roadmap draft failed: ${e.message}`);
    }
  } else if (pipelineSteps) {
    const pipelineId = crypto.randomUUID();
    const { steps, waves } = pipelineSteps;
    // Use the explicitly selected project only — never infer projectDir from LLM-generated task text,
    // which can contain stale paths from brain.md and incorrectly lock the pipeline to the wrong project.
    const _projectDir = activeProjectOutputDir || null;
    _deps.pendingPipelines.set(pipelineId, { steps, waves, currentWave: 0, pendingTaskIds: new Set(), waveResults: [], sessionId, projectDir: _projectDir });
    _deps.dispatchPipelineWave(pipelineId);
    const waveDesc = waves.length > 1 ? ` in ${waves.length} waves` : "";
    _deps.appendHistory(userId, sessionId, "system", `Pipeline started (${steps.length} steps${waveDesc}): ${waves.map(w => w.map(s => s.agent).join("+")).join(" → ")}`);
    const agentFlow = waves.map(w => w.length > 1 ? `[${w.map(s => s.agent).join(" ∥ ")}]` : w[0].agent).join(" → ");
    cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Pipeline started (${steps.length} steps${waveDesc}): ${agentFlow}`;
    pipeline = { pipelineId, steps, waves };
  } else if (dispatch) {
    console.log(`[chat-handler] LLM dispatch detected! Agent: ${dispatch.agent}, Task: ${(dispatch.task || "").slice(0, 60)}`);
    const resolvedAgent = _deps.resolveAgentId(cfg, dispatch.agent) || dispatch.agent;
    if (!cfg.knownAgents.length || cfg.knownAgents.includes(resolvedAgent)) {
      dispatch.agent = resolvedAgent;
    }
    // QA always writes to projectDir/qa-report.md so crew-lead doesn't tell them a random path
    const isQa = dispatch.agent === "crew-qa" || (dispatch.agent && dispatch.agent.includes("qa"));
    if (isQa && activeProjectOutputDir && !/qa-report\.md|Write your report to/i.test(dispatch.task || "")) {
      dispatch.task = (dispatch.task || "").trimEnd() + `\n\nWrite your report to ${activeProjectOutputDir}/qa-report.md (no other filename).`;
    }
    const pipelineMeta = activeProjectOutputDir ? { projectDir: activeProjectOutputDir } : null;
    if (cfg.knownAgents.includes(dispatch.agent)) {
    // Pass full dispatch spec so verify/done criteria are injected into task text
    const ok = _deps.dispatchTask(dispatch.agent, dispatch, sessionId, pipelineMeta);
    if (ok) {
      dispatched = dispatch;
      _deps.appendHistory(userId, sessionId, "system", `You dispatched to ${dispatch.agent}: "${(dispatch.task || "").slice(0, 200)}".`);
      const dispatchLine = _deps.getRtPublish()
        ? `\n\n↳ Dispatched to ${dispatch.agent} — reply will show here when they finish.`
        : `\n\n↳ Dispatched to ${dispatch.agent} (via ctl — check RT Messages tab for reply).`;
      cleanReply = (cleanReply || "").trimEnd() + dispatchLine;
    }
    }
  }

  // ── Detect "dispatch lie" — LLM claims it dispatched but no @@DISPATCH was parsed ──
  if (!dispatched && !pipeline && cleanReply) {
    // Only trigger if Stinki explicitly claims to have ALREADY dispatched (past tense with confirmation)
    const liedPattern = /\b(?:I (?:just |already |have )?(?:dispatched|sent it|forwarded it|sicced)|consider it done|they'(?:re|ve) got it|it'?s on its way to crew-|I'?ve tasked crew-)/i;
    if (liedPattern.test(cleanReply)) {
      console.log(`[crew-lead] Dispatch-lie detected — auto-retrying with extraction call`);
      let _lieRetryOk = false;
      try {
        const _lieRetryMsgs = [
          ...messages,
          { role: "assistant", content: fullReply },
          { role: "user", content: "You described dispatching but the @@DISPATCH line was missing. Emit ONLY the @@DISPATCH JSON now. No prose, no explanation.\nFormat: @@DISPATCH {\"agent\":\"crew-X\",\"task\":\"...\"}" },
        ];
        const _lieResult = await _deps.callLLM(_lieRetryMsgs, cfg);
        const _lieDispatch = !projectSpec ? _deps.parseDispatch(_lieResult.reply || "", message) : null;
        if (_lieDispatch && _lieDispatch.agent) {
          console.log(`[crew-lead] Dispatch-lie retry succeeded -> ${_lieDispatch.agent}`);
          const _lieTaskId = _deps.dispatchTask(_lieDispatch.agent, _lieDispatch.task, sessionId);
          if (_lieTaskId) {
            dispatched = _lieDispatch;
            cleanReply = (cleanReply || "").trimEnd() + `\n\n\u21b3 Dispatched to ${_lieDispatch.agent} \u2014 reply will show here when they finish.`;
            _lieRetryOk = true;
          }
        }
      } catch (_lieErr) {
        console.error(`[crew-lead] Dispatch-lie retry error: ${_lieErr.message}`);
      }
      if (!_lieRetryOk) {
        cleanReply = (cleanReply || "").trimEnd() + `\n\n\u26a0\ufe0f Dispatch failed even after retry \u2014 please ask me again.`;
        _deps.appendHistory(userId, sessionId, "system", `Warning: LLM described dispatching without emitting @@DISPATCH — retry also failed.`);
      }
    }
  }

  // ── Execute @@TOOLS permission change ──────────────────────────────────────
  if (toolsCmd?.agent) {
    try {
      const current = _deps.readAgentTools(toolsCmd.agent).tools;
      let updated;
      if (Array.isArray(toolsCmd.set)) {
        updated = toolsCmd.set;
      } else {
        const granted = Array.isArray(toolsCmd.grant)  ? toolsCmd.grant  : [];
        const revoked = Array.isArray(toolsCmd.revoke) ? toolsCmd.revoke : [];
        updated = [...new Set([...current, ...granted].filter(t => !revoked.includes(t)))];
      }
      const saved = _deps.writeAgentTools(toolsCmd.agent, updated);
      const note = `\n\n↳ Tool permissions updated for **${toolsCmd.agent}**: ${saved.join(", ")} — restart its bridge for changes to take effect.`;
      cleanReply = (cleanReply || "").trimEnd() + note;
      _deps.appendHistory(userId, sessionId, "system", `Tool permissions for ${toolsCmd.agent} updated to: ${saved.join(", ")}`);
      console.log(`[crew-lead] @@TOOLS: ${toolsCmd.agent} → ${saved.join(", ")}`);
    } catch (e) {
      cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Failed to update tools for ${toolsCmd.agent}: ${e.message}`;
    }
  }

  // ── Execute @@PROMPT system prompt edit ────────────────────────────────────
  if (promptCmd?.agent) {
    try {
      const existing = _deps.getAgentPrompts()[promptCmd.agent] || "";
      let newPrompt;
      if (typeof promptCmd.set === "string") {
        newPrompt = promptCmd.set;
      } else if (typeof promptCmd.append === "string") {
        newPrompt = existing ? `${existing}\n${promptCmd.append}` : promptCmd.append;
      } else {
        newPrompt = existing;
      }
      _deps.writeAgentPrompt(promptCmd.agent, newPrompt);
      const preview = newPrompt.slice(0, 120).replace(/\n/g, " ");
      const restartNote = promptCmd.agent === "crew-lead" ? "Takes effect on your next message; no restart needed." : "Restart its bridge for changes to take effect.";
      const note = `\n\n↳ System prompt updated for **${promptCmd.agent}**: "${preview}${newPrompt.length > 120 ? "…" : ""}" — ${restartNote}`;
      cleanReply = (cleanReply || "").trimEnd() + note;
      _deps.appendHistory(userId, sessionId, "system", `Prompt for ${promptCmd.agent} updated.`);
      console.log(`[crew-lead] @@PROMPT: ${promptCmd.agent} updated (${newPrompt.length} chars)`);
    } catch (e) {
      cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Failed to update prompt for ${promptCmd.agent}: ${e.message}`;
    }
  }

  // ── Execute @@BRAIN append ──────────────────────────────────────────────────
  // Routes to <projectDir>/.crewswarm/brain.md when a project is active, global brain.md otherwise
  // Also stores in AgentMemory if shared memory is available
  if (brainCmd) {
    try {
      const block = _deps.appendToBrain("crew-lead", brainCmd, activeProjectOutputDir || null);
      const dest = activeProjectOutputDir ? `${path.basename(activeProjectOutputDir)}/.crewswarm/brain.md` : "memory/brain.md";
      cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Added to ${dest}: "${block.slice(0, 100)}"`;
      console.log(`[crew-lead] @@BRAIN → ${dest}: ${brainCmd.slice(0, 80)}`);
      
      // Also store in shared AgentMemory for cross-system access
      if (isSharedMemoryAvailable()) {
        const factId = rememberFact('crew-lead', brainCmd, {
          critical: brainCmd.includes('CRITICAL') || brainCmd.includes('MUST'),
          tags: ['brain', 'crew-lead'],
          provider: 'crew-lead-chat'
        });
        if (factId) {
          console.log(`[crew-lead] Fact also stored in shared AgentMemory: ${factId}`);
        }
      }
    } catch (e) {
      cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Failed to write brain: ${e.message}`;
    }
  }

  // ── Execute @@MEMORY commands ───────────────────────────────────────────────
  if (memoryCmd) {
    try {
      if (memoryCmd.action === 'search') {
        if (!isSharedMemoryAvailable()) {
          cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Shared memory not available. Run: cd crew-cli && npm run build`;
        } else {
          const projectDir = activeProjectOutputDir || process.cwd();
          const hits = await searchMemory(projectDir, memoryCmd.query, {
            maxResults: 10,
            includeDocs: true,
            includeCode: false,
            preferSuccessful: true,
            crewId: 'crew-lead'
          });
          
          if (hits.length === 0) {
            cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ **Memory search:** No results for "${memoryCmd.query}"`;
          } else {
            const results = hits.map(h => 
              `- [${h.source}] **${h.title}** (score: ${h.score.toFixed(3)})\n  ${h.text.slice(0, 150)}${h.text.length > 150 ? '...' : ''}`
            ).join('\n\n');
            cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ **Memory search results (${hits.length}):**\n\n${results}`;
          }
          console.log(`[crew-lead] @@MEMORY search "${memoryCmd.query}": ${hits.length} hits`);
        }
      } else if (memoryCmd.action === 'stats') {
        if (!isSharedMemoryAvailable()) {
          cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Shared memory not available. Run: cd crew-cli && npm run build`;
        } else {
          const factStats = getMemoryStats('crew-lead');
          const keeperStats = await getKeeperStats(activeProjectOutputDir || process.cwd());
          
          const lines = [
            '↳ **Shared Memory Statistics:**',
            '',
            '**AgentMemory (cognitive facts):**',
            `- Total facts: ${factStats?.totalFacts || 0}`,
            `- Critical facts: ${factStats?.criticalFacts || 0}`,
            `- Providers: ${factStats?.providers?.join(', ') || 'none'}`,
            '',
            '**AgentKeeper (task memory):**',
            `- Total entries: ${keeperStats?.entries || 0}`,
            `- Storage bytes: ${keeperStats?.bytes ? (keeperStats.bytes / 1024).toFixed(1) + 'KB' : '0KB'}`,
            `- By tier: ${keeperStats?.byTier ? Object.entries(keeperStats.byTier).map(([k,v]) => `${k}=${v}`).join(', ') : 'none'}`,
            `- By agent: ${keeperStats?.byAgent ? Object.entries(keeperStats.byAgent).map(([k,v]) => `${k}=${v}`).join(', ') : 'none'}`
          ];
          cleanReply = (cleanReply || "").trimEnd() + `\n\n${lines.join('\n')}`;
          console.log(`[crew-lead] @@MEMORY stats: ${factStats?.totalFacts || 0} facts, ${keeperStats?.entries || 0} keeper entries`);
        }
      }
    } catch (e) {
      cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Memory command failed: ${e.message}`;
    }
  }

  // ── Execute @@GLOBALRULE append ────────────────────────────────────────────
  if (globalRuleCmd) {
    try {
      _deps.appendGlobalRule(globalRuleCmd);
      cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Global rule added (all agents): "${globalRuleCmd}" — restart bridges to apply.`;
      _deps.appendHistory(userId, sessionId, "system", `Global rule added: ${globalRuleCmd}`);
      console.log(`[crew-lead] @@GLOBALRULE: ${globalRuleCmd}`);
    } catch (e) {
      cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Failed to write global-rules.md: ${e.message}`;
    }
  }

  // ── Execute @@SERVICE control ───────────────────────────────────────────────
  if (serviceCmd) {
    const { action, id } = serviceCmd;
    try {
      // Per-agent restart: if ID looks like a specific agent, use the agents/:id/restart endpoint
      const isSpecificAgent = id.startsWith("crew-") && id !== "crew-lead";
      let result;

      const authHeader = _deps.getRTToken() ? { authorization: `Bearer ${_deps.getRTToken()}` } : {};
      if (action === "stop" && !isSpecificAgent) {
        const r = await fetch(`${_deps.DASHBOARD}/api/services/stop`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
          signal: AbortSignal.timeout(8000),
        });
        result = await r.json();
      } else if (isSpecificAgent && action !== "stop") {
        // Single agent bridge restart via dedicated endpoint
        const r = await fetch(`http://127.0.0.1:${_deps.PORT}/api/agents/${id}/restart`, {
          method: "POST",
          headers: authHeader,
          signal: AbortSignal.timeout(8000),
        });
        result = await r.json();
      } else {
        const r = await fetch(`${_deps.DASHBOARD}/api/services/restart`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
          signal: AbortSignal.timeout(8000),
        });
        result = await r.json();
      }

      if (result?.ok === false && result?.message) {
        cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Service **${id}** — ${result.message}`;
      } else {
        const actionLabel = action === "stop" ? "stopped" : "restarted";
        cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ **${id}** ${actionLabel}. Give it 2–3 seconds to come back online.`;
        _deps.appendHistory(userId, sessionId, "system", `Service ${id} ${actionLabel} via @@SERVICE.`);
        console.log(`[crew-lead] @@SERVICE ${action} ${id}: ok`);
      }
    } catch (e) {
      cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Failed to ${action} **${id}**: ${e.message}`;
    }
  }

  // ── Surface @@DEFINE_SKILL results ─────────────────────────────────────────
  for (const ds of defineSkillCmds) {
    if (ds.ok) {
      cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Skill **${ds.name}** saved to ~/.crewswarm/skills/${ds.name}.json — agents with 'skill' permission can now call it.`;
      _deps.appendHistory(userId, sessionId, "system", `Skill "${ds.name}" defined and saved.`);
    } else {
      cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Failed to save skill **${ds.name}**: ${ds.error}`;
    }
  }

  // ── Surface @@DEFINE_WORKFLOW results ─────────────────────────────────────
  for (const dw of defineWorkflowCmds) {
    if (dw.ok) {
      cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Workflow **${dw.name}** saved to ~/.crewswarm/pipelines/${dw.name}.json (${dw.stageCount} stages). Run with: \`node scripts/run-scheduled-pipeline.mjs ${dw.name}\` or add to crontab.`;
      _deps.appendHistory(userId, sessionId, "system", `Workflow "${dw.name}" defined (${dw.stageCount} stages).`);
    } else {
      cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Failed to save workflow **${dw.name}**: ${dw.error}`;
    }
  }

  // ── Execute @@CREATE_AGENT — create a new specialist agent ────────────────
  if (createAgentCmd?.id) {
    try {
      const result = _deps.createAgent(createAgentCmd);
      const ocNote = result.useOpenCode ? `, OpenCode: ${result.useOpenCode}` : "";

      // Spawn the bridge directly via start-crew.mjs --agent (no dashboard round-trip)
      let spawnNote = "";
      try {
        const startScript = path.join(process.cwd(), "scripts", "start-crew.mjs");
        const { execSync: exec2 } = await import("node:child_process");
        exec2(`node ${startScript} --agent ${result.id}`, {
          timeout: 10000,
          env: { ...process.env, CREWSWARM_RT_AUTH_TOKEN: _deps.getRTToken() },
          stdio: "pipe",
        });
        // Verify bridge is running
        await new Promise(r => setTimeout(r, 1500));
        try {
          const psOut = exec2("ps aux", { encoding: "utf8" });
          const running = psOut.includes(result.id);
          spawnNote = running
            ? " — bridge spawned and online"
            : " — bridge spawned (verifying…)";
        } catch {
          spawnNote = " — bridge spawned";
        }
      } catch (spawnErr) {
        console.error(`[crew-lead] Failed to spawn bridge for ${result.id}:`, spawnErr.message);
        spawnNote = " — restart bridges to bring it online (`npm run restart-all`)";
      }

      cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Agent **${result.id}** created (role: ${result.role}, tools: ${result.tools.join(", ")}${ocNote})${spawnNote}. You can now dispatch tasks to it.`;
      _deps.appendHistory(userId, sessionId, "system", `Dynamic agent ${result.id} created (role: ${result.role}, openCode: ${!!result.useOpenCode}).`);
      console.log(`[crew-lead] @@CREATE_AGENT: ${result.id} (role: ${result.role}, tools: ${result.tools.join(",")}, openCode: ${!!result.useOpenCode})`);
      _deps.broadcastSSE({ type: "agent_created", agent: result, ts: Date.now() });
    } catch (e) {
      cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Failed to create agent: ${e.message}`;
    }
  }

  // ── Execute @@REMOVE_AGENT — remove a dynamically created agent ──────────
  if (removeAgentCmd) {
    try {
      _deps.removeDynamicAgent(removeAgentCmd);
      cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Agent **${removeAgentCmd}** removed. Restart bridges to clean up.`;
      _deps.appendHistory(userId, sessionId, "system", `Dynamic agent ${removeAgentCmd} removed.`);
      console.log(`[crew-lead] @@REMOVE_AGENT: ${removeAgentCmd}`);
    } catch (e) {
      cleanReply = (cleanReply || "").trimEnd() + `\n\n↳ Failed to remove agent: ${e.message}`;
    }
  }

  if (usedFallback) {
    const primaryLabel = `${cfg.providerKey}/${cfg.modelId}`;
    const fbUrl = `${cfg.fallbackProvider.baseUrl.replace(/\/$/, "")}/chat/completions`;
    // Strip any fallback line the model echoed (avoids duplicate banner)
    const stripped = (cleanReply || "").replace(/^⚡\s*\*fallback:[^*]*\*[^\n]*\n?/gm, "").trimStart();
    cleanReply = `⚡ *fallback: ${activeModel}* @ ${fbUrl} (primary ${primaryLabel} failed: ${fallbackReason})\n\n${stripped}`;
  }

  // Trim blank space left by stripped @@SKILL-only replies before appending results
  if (skillCalls.length > 0) cleanReply = (cleanReply || "").trim();

  // Execute @@SKILL calls — collect display blocks (for user) and feedback blocks (for LLM second pass)
  const skillDisplayBlocks = [];
  const skillFeedbackBlocks = [];

  for (const { skillName, params } of skillCalls) {
    try {
      const result = await _deps.executeSkillFromCrewLead(skillName, params);
      console.log(`[crew-lead] @@SKILL ${skillName} → OK`);
      const isBenchmark = skillName === "zeroeval.benchmark" || skillName === "benchmark" || skillName === "benchmarks";
      const _skillCount = isBenchmark && result?.models?.length ? ` · ${Math.min(Number(params?.limit ?? params?.top ?? 100), result.models.length)}/${result.models.length} models` : "";
      const skillTag = `↳ *skill: ${skillName}${_skillCount}*`;

      let displayBlock = "";
      let feedbackBlock = "";

      if (isBenchmark && Array.isArray(result) && result.length) {
        const list = result.slice(0, 50).map(b => {
          const id = typeof b === "object" ? b.benchmark_id : b;
          const name = typeof b === "object" ? b.name || "" : "";
          return `  - ${id}${name ? `: ${name}` : ""}`;
        }).join("\n");
        const body = `**Available benchmarks** (omit benchmark_id or use empty to list):\n${list}${result.length > 50 ? `\n  … and ${result.length - 50} more` : ""}`;
        displayBlock = `${skillTag}\n\n${body}`;
        feedbackBlock = `[Skill result: ${skillName} — benchmark list]\n${body}`;
      } else if (isBenchmark && result && !result.models?.length && !Array.isArray(result)) {
        const name = result.name || result.benchmark_id || skillName;
        displayBlock = `${skillTag}\n\n*${name}* — no models found for this benchmark yet.`;
        feedbackBlock = `[Skill result: ${skillName}]\nNo models found for benchmark "${name}".`;
      } else if (isBenchmark && result?.models?.length) {
        const limit = Number(params?.limit ?? params?.top ?? 100);
        const top = result.models.slice(0, limit);
        const rows = top.map(m => {
          const pct = ((m.normalized_score ?? m.score ?? 0) * 100).toFixed(1);
          const inC = m.input_cost_per_million ?? 0;
          const outC = m.output_cost_per_million ?? 0;
          const inCents = inC > 0 ? Math.round(inC * 100) + '¢' : '?';
          const outCents = outC > 0 ? Math.round(outC * 100) + '¢' : '?';
          const cost = (inC > 0 || outC > 0) ? ` @ ${inCents} → ${outCents}` : "";
          const score = (m.normalized_score ?? m.score) ?? 0;
          const centsPerPt = (inC + outC) > 0 && score > 0 ? ` → ${((inC + outC) * 100 / (score * 100)).toFixed(1)} ¢/pt` : "";
          return `  ${m.rank}. **${m.model_name}** (${m.organization_name}) — ${pct}%${cost}${centsPerPt}`;
        }).join("\n");
        const showing = top.length < result.models.length ? ` (showing ${top.length} of ${result.models.length} — add "limit":N for more)` : ` (all ${result.models.length} models)`;
        const body = `**${result.name || "Benchmark"}** — top ${top.length}${showing}:\n${rows}`;
        displayBlock = `${skillTag}\n\n${body}`;
        feedbackBlock = `[Skill result: ${skillName}]\n${body}`;
      } else if (result?.output !== undefined) {
        const out = String(result.output).trim();
        displayBlock = `${skillTag}\n\n\`\`\`\n${out.slice(0, 3000)}${out.length > 3000 ? "\n… (truncated)" : ""}\n\`\`\``;
        feedbackBlock = `[Skill result: ${skillName}]\n${out.slice(0, 3000)}`;
      } else {
        const raw = typeof result === "object" ? JSON.stringify(result) : String(result);
        displayBlock = `${skillTag}: ${raw.slice(0, 600)}${raw.length > 600 ? "…" : ""}`;
        feedbackBlock = `[Skill result: ${skillName}]\n${raw.slice(0, 600)}`;
      }

      // Check feedbackLoop flag from skill JSON (default: true — opt out with "feedbackLoop": false)
      const resolvedSkillName = _deps.resolveSkillAlias(skillName);
      const skillDefPath = path.join(os.homedir(), ".crewswarm", "skills", `${resolvedSkillName}.json`);
      const skillDefRaw = fs.existsSync(skillDefPath) ? JSON.parse(fs.readFileSync(skillDefPath, "utf8")) : {};
      const wantsFeedback = skillDefRaw.feedbackLoop !== false;

      skillDisplayBlocks.push(displayBlock);
      if (wantsFeedback) skillFeedbackBlocks.push(feedbackBlock);

    } catch (e) {
      console.error(`[crew-lead] @@SKILL ${skillName} failed:`, e.message);
      const errBlock = `↳ *${skillName}* failed: ${e.message}`;
      skillDisplayBlocks.push(errBlock);
      skillFeedbackBlocks.push(`[Skill result: ${skillName}]\nFailed: ${e.message}`);
    }
  }

  // Append display blocks so the user always sees the raw skill data
  if (skillDisplayBlocks.length > 0) {
    cleanReply = (cleanReply ? cleanReply + "\n\n" : "") + skillDisplayBlocks.join("\n\n");
  }

  // Feedback loop: second LLM call so the model actually reads the results and responds
  if (skillFeedbackBlocks.length > 0) {
    try {
      const feedbackUserMsg = skillFeedbackBlocks.join("\n\n")
        + "\n\nBased ONLY on the skill results above, respond to the user's original question. "
        + "Be concise and specific. Do not invent numbers or models not in the results above.";
      const feedbackMessages = [
        ...messages,
        { role: "assistant", content: fullReply },
        { role: "user", content: feedbackUserMsg },
      ];
      console.log(`[crew-lead] Skill feedback loop — second LLM call (${skillFeedbackBlocks.length} skill(s))`);
      const feedbackResult = await _deps.callLLM(feedbackMessages, cfg);
      if (feedbackResult.reply?.trim()) {
        cleanReply = cleanReply + "\n\n" + feedbackResult.reply.trim();
      }
    } catch (fbErr) {
      console.error(`[crew-lead] Skill feedback loop failed:`, fbErr.message);
      // Non-fatal — user still sees raw skill data above
    }
  }

  // Auto-learn from conversation: extract important facts and append to brain
  // Trigger on: user confirms something, agent discovers/fixes something, or decisions are made
  const shouldAutoLearn = (msg) => {
    const lower = msg.toLowerCase();
    // Trigger phrases that indicate learning opportunities
    return /\b(discovered|learned|figured out|found that|turns out|confirmed|fixed by|solution was|root cause|the issue is|mistake was|now i know|remember that|important:|note:|fyi:|btw:)\b/i.test(msg)
      || /\b(always|never|every time|from now on|in future|going forward)\b/i.test(lower)
      || (msg.includes("✅") && msg.length > 30); // Success markers with substance
  };

  // Auto-append to brain when significant facts emerge (after LLM reply)
  if (cleanReply && shouldAutoLearn(cleanReply + " " + message)) {
    try {
      // Extract key fact from the conversation
      const extractFact = (text) => {
        // Look for sentences with learning indicators
        const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 20);
        for (const sent of sentences) {
          if (shouldAutoLearn(sent)) {
            const clean = sent.trim()
              .replace(/^(discovered|learned|figured out|found that|turns out|confirmed|fixed by|solution was|the issue is|mistake was|now i know|remember that|important:|note:|fyi:|btw:)\s*/i, "")
              .replace(/\s+/g, " ")
              .slice(0, 200);
            if (clean.length > 15) return clean;
          }
        }
        return null;
      };

      const fact = extractFact(cleanReply) || extractFact(message);
      if (fact && fact.length > 15 && fact.length < 300) {
        const brainEntry = `crew-lead (auto): ${fact}`;
        _deps.appendToBrain("crew-lead", brainEntry, activeProjectOutputDir || null);
        console.log(`[crew-lead] Auto-learned to brain: ${fact.slice(0, 80)}...`);
      }
    } catch (e) {
      console.error(`[crew-lead] Auto-learn failed: ${e.message}`);
    }
  }
  // not conversation context. Storing it pollutes future LLM requests with noisy boilerplate.
  const historyReply = usedFallback
    ? (cleanReply || "").replace(/^⚡\s*\*fallback:[^*]*\*[^\n]*\n?/gm, "").trimStart()
    : cleanReply;
  _deps.appendHistory(userId, sessionId, "assistant", historyReply);
  _deps.broadcastSSE({ 
    type: "chat_message", 
    sessionId, 
    role: "assistant", 
    content: cleanReply, 
    model: activeModel,  // Always send model info
    ...(usedFallback ? { fallbackModel: activeModel, fallbackReason } : {})
  });

  return { reply: cleanReply, dispatched, pendingProject, pipeline };
}
