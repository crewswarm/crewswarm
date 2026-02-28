/**
 * HTTP server for crew-lead — extracted from crew-lead.mjs
 * All dependencies injected via initHttpServer().
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let _deps = {};

export function initHttpServer(deps) {
  _deps = deps;
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(body);
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body);
}

export function createAndStartServer(PORT) {
  const {
    sseClients,
    loadConfig,
    loadHistory,
    clearHistory,
    appendHistory,
    broadcastSSE,
    handleChat,
    confirmProject,
    pendingProjects,
    dispatchTask,
    pendingDispatches,
    pendingPipelines,
    resolveAgentId,
    readAgentTools,
    writeAgentTools,
    activeOpenCodeAgents,
    agentTimeoutCounts,
    crewswarmToolNames,
    classifyTask,
    tryRead,
    resolveSkillAlias,
    connectRT,
    historyDir,
    dispatchTimeoutMs,
    dispatchTimeoutInterval,
    setDispatchTimeoutInterval,
    checkDispatchTimeouts,
    getRTToken,
    getRtPublish,
    telemetrySchemaVersion,
    readTelemetryEvents,
    bgConsciousnessRef,
    bgConsciousnessIntervalMs,
    cursorWavesRef,
    claudeCodeRef,
  } = _deps;

  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" });
      res.end();
      return;
    }

    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);

      function checkBearer(request) {
        const RT_TOKEN = getRTToken();
        if (!RT_TOKEN) return true; // no token configured → open (local-first default)
        const auth = request.headers["authorization"] || "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
        return token === RT_TOKEN;
      }

      if (url.pathname === "/health" && req.method === "GET") {
        json(res, 200, { ok: true, agent: "crew-lead", port: PORT });
        return;
      }

      // GET /api/services/health — check OpenCode + bridges, optionally restart
      // POST /api/services/restart-opencode — kill + relaunch opencode serve
      if (url.pathname === "/api/services/health" && req.method === "GET") {
        if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
        const { execSync } = await import("node:child_process");
        let ocAlive = false;
        try {
          const ocRes = await fetch("http://127.0.0.1:4096/health", { signal: AbortSignal.timeout(3000) }).catch(() => null);
          ocAlive = !!ocRes;
        } catch {}
        let bridgeCount = 0;
        try {
          const out = execSync(`pgrep -f "gateway-bridge.mjs --rt-daemon" | wc -l`, { encoding: "utf8" });
          bridgeCount = parseInt(out.trim(), 10);
        } catch {}
        json(res, 200, { ok: true, opencode: { alive: ocAlive, port: 4096 }, bridges: { count: bridgeCount }, crewLead: { alive: true, port: PORT } });
        return;
      }

      if (url.pathname === "/api/services/restart-opencode" && req.method === "POST") {
        if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
        const { execSync } = await import("node:child_process");
        try {
          const logPath = path.join(os.tmpdir(), "opencode-server.log");
          execSync(`pkill -f "opencode serve" 2>/dev/null; sleep 1; nohup opencode serve --port 4096 --hostname 127.0.0.1 >> ${logPath} 2>&1 &`, { timeout: 5000, shell: true });
          json(res, 200, { ok: true, message: "OpenCode restart triggered — allow ~6s to come up" });
        } catch (e) {
          json(res, 500, { ok: false, error: e.message });
        }
        return;
      }

      if (url.pathname === "/status" && req.method === "GET") {
        const cfg = loadConfig();
        const rtPublish = getRtPublish();
        json(res, 200, { ok: true, model: cfg.model, rtConnected: rtPublish !== null, agents: cfg.knownAgents });
        return;
      }

      if (url.pathname === "/chat" && req.method === "POST") {
        if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
        let message, sessionId, firstName, projectId;
        try {
          const body = await readBody(req);
          message = (body.message || "").slice(0, 16000); // M2: cap message size
          sessionId = body.sessionId;
          firstName = body.firstName;
          projectId = body.projectId;
        } catch (e) {
          json(res, 400, { ok: false, error: "invalid JSON body or missing message" });
          return;
        }
        if (!message) { json(res, 400, { ok: false, error: "message required" }); return; }
        // @@RESET — clear session history and confirm
        if (/^@@RESET\b/i.test(message.trim()) || /^\/reset\b/i.test(message.trim())) {
          clearHistory(sessionId || "default");
          const cfg = loadConfig();
          const reply = `Session cleared. Fresh context — ${cfg.providerKey}/${cfg.modelId} primary is back.`;
          appendHistory(sessionId || "default", "assistant", reply);
          broadcastSSE({ type: "chat_message", sessionId, role: "assistant", content: reply });
          json(res, 200, { ok: true, reply });
          return;
        }
        console.log(`[crew-lead] /chat session=${sessionId} project=${projectId || 'none'} msg=${message.slice(0, 60)}`);
        try {
          const result = await handleChat({ message, sessionId, firstName, projectId });
          json(res, 200, { ok: true, ...result });
        } catch (e) {
          console.error("[crew-lead] handleChat failed:", e?.message || e);
          json(res, 500, { ok: false, error: e?.message || String(e), reply: null });
        }
        return;
      }

      if (url.pathname === "/clear" && req.method === "POST") {
        const { sessionId } = await readBody(req);
        clearHistory(sessionId || "default");
        json(res, 200, { ok: true });
        return;
      }

      if (url.pathname === "/events" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "access-control-allow-origin": "*",
          "connection": "keep-alive",
        });
        res.write("retry: 3000\n\n");
        sseClients.add(res);
        // Keepalive comment every 30s — prevents TG/WA bridge AbortSignal timeouts
        const ka = setInterval(() => { try { res.write(": ka\n\n"); } catch { clearInterval(ka); } }, 30000);
        req.on("close", () => { sseClients.delete(res); clearInterval(ka); });
        return;
      }

      if (url.pathname === "/history" && req.method === "GET") {
        const sessionId = url.searchParams.get("sessionId") || "default";
        const history = loadHistory(sessionId);
        json(res, 200, { ok: true, history, count: history.length });
        return;
      }

      if (url.pathname === "/confirm-project" && req.method === "POST") {
        const { draftId, roadmapMd } = await readBody(req);
        if (!draftId) { json(res, 400, { ok: false, error: "draftId required" }); return; }
        console.log(`[crew-lead] /confirm-project draftId=${draftId}`);
        try {
          const result = await confirmProject({ draftId, roadmapMd });
          json(res, 200, { ok: true, ...result });
        } catch (e) {
          json(res, 500, { ok: false, error: e.message });
        }
        return;
      }

      if (url.pathname === "/discard-project" && req.method === "POST") {
        const { draftId } = await readBody(req);
        if (draftId) {
          pendingProjects.delete(draftId);
          broadcastSSE({ type: "draft_discarded", draftId });
        }
        json(res, 200, { ok: true });
        return;
      }

      if (url.pathname === "/approve-cmd" && req.method === "POST") {
        const { approvalId } = await readBody(req);
        if (!approvalId) { json(res, 400, { ok: false, error: "approvalId required" }); return; }
        const rtPublish = getRtPublish();
        if (rtPublish) {
          rtPublish({ channel: "events", type: "cmd.approved", to: "broadcast", payload: { approvalId } });
          console.log(`[crew-lead] ✅ cmd approved: ${approvalId}`);
        }
        json(res, 200, { ok: true });
        return;
      }

      if (url.pathname === "/reject-cmd" && req.method === "POST") {
        const { approvalId } = await readBody(req);
        if (!approvalId) { json(res, 400, { ok: false, error: "approvalId required" }); return; }
        const rtPublish = getRtPublish();
        if (rtPublish) {
          rtPublish({ channel: "events", type: "cmd.rejected", to: "broadcast", payload: { approvalId } });
          console.log(`[crew-lead] ⛔ cmd rejected: ${approvalId}`);
        }
        json(res, 200, { ok: true });
        return;
      }

      if (url.pathname === "/allowlist-cmd" && req.method === "POST") {
        const { pattern } = await readBody(req);
        if (!pattern) { json(res, 400, { ok: false, error: "pattern required" }); return; }
        const file = path.join(os.homedir(), ".crewswarm", "cmd-allowlist.json");
        let list = [];
        try { list = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
        if (!list.includes(pattern)) {
          list.push(pattern);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, JSON.stringify(list, null, 2));
          console.log(`[crew-lead] ✅ Added to cmd allowlist: ${pattern}`);
        }
        json(res, 200, { ok: true, pattern, list });
        return;
      }

      if (url.pathname === "/allowlist-cmd" && req.method === "DELETE") {
        const { pattern } = await readBody(req);
        const file = path.join(os.homedir(), ".crewswarm", "cmd-allowlist.json");
        let list = [];
        try { list = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
        list = list.filter(p => p !== pattern);
        fs.writeFileSync(file, JSON.stringify(list, null, 2));
        console.log(`[crew-lead] 🗑 Removed from cmd allowlist: ${pattern}`);
        json(res, 200, { ok: true, list });
        return;
      }

      if (url.pathname === "/allowlist-cmd" && req.method === "GET") {
        const file = path.join(os.homedir(), ".crewswarm", "cmd-allowlist.json");
        let list = [];
        try { list = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
        json(res, 200, { ok: true, list });
        return;
      }

      if (url.pathname === "/health" && req.method === "GET") {
        json(res, 200, { ok: true, service: "crew-lead", uptime: process.uptime() });
        return;
      }

      // ── External agent API — Bearer token required ────────────────────────────
      // Any external tool (another CrewSwarm, OpenClaw plugin, scripts) can dispatch tasks
      // and poll status without sharing LLM credentials.
      // Auth: Authorization: Bearer <RT_TOKEN from ~/.crewswarm/config.json rt.authToken>

      // POST /api/dispatch  { agent, task, verify?, done?, sessionId? }
      // Returns { ok, taskId, agent }
      // ── OpenCode plugin push — receives events from the crewswarm-feed plugin
      if (url.pathname === "/api/opencode-event" && req.method === "POST") {
        const evt = await readBody(req).catch(() => null);
        if (evt && typeof evt === "object") broadcastSSE({ type: "opencode_event", ...evt, ts: evt.ts || Date.now() });
        json(res, 200, { ok: true });
        return;
      }

      // ── /api/classify — task complexity breakdown (used by MCP smart_dispatch) ──
      if (url.pathname === "/api/classify" && req.method === "POST") {
        if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
        let body;
        try { body = await readBody(req); } catch { json(res, 400, { ok: false, error: "invalid JSON body" }); return; }
        const { task } = body;
        if (!task) { json(res, 400, { ok: false, error: "task is required" }); return; }
        const cfg = loadConfig();
        try {
          const result = await classifyTask(task, cfg);
          if (!result) {
            json(res, 200, { ok: true, score: 1, reason: "Simple task — single agent sufficient", agents: [], breakdown: [], skipped: true });
          } else {
            json(res, 200, { ok: true, ...result });
          }
        } catch (e) {
          json(res, 500, { ok: false, error: e.message });
        }
        return;
      }

      if (url.pathname === "/api/dispatch" && req.method === "POST") {
        if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized — Bearer token required" }); return; }
        const body = await readBody(req);
        let { agent, task, verify, done, sessionId: sid, useClaudeCode, useCursorCli, runtime, projectDir: dispatchProjectDir } = body;
        if (!agent || !task) { json(res, 400, { ok: false, error: "agent and task are required" }); return; }
        const cfg = loadConfig();
        agent = resolveAgentId(cfg, agent) || agent;
        const knownAgents = cfg.knownAgents || [];
        if (knownAgents.length && !knownAgents.includes(agent)) {
          json(res, 400, { ok: false, error: `Unknown agent "${agent}". Known: ${knownAgents.join(", ")}` });
          return;
        }
        const spec = verify || done ? { task, verify, done } : task;
        const routeFlags = {};
        if (useClaudeCode) routeFlags.useClaudeCode = true;
        if (useCursorCli) routeFlags.useCursorCli = true;
        if (runtime) routeFlags.runtime = runtime;
        if (dispatchProjectDir) routeFlags.projectDir = dispatchProjectDir;
        const taskId = dispatchTask(agent, spec, sid || "external", Object.keys(routeFlags).length ? routeFlags : null);
        if (!taskId) { json(res, 503, { ok: false, error: "RT bus not connected — agent unreachable" }); return; }
        console.log(`[crew-lead] /api/dispatch → ${agent} taskId=${taskId}`);
        json(res, 200, { ok: true, taskId: taskId === true ? null : taskId, agent });
        return;
      }

      // GET /api/status/:taskId  — poll task completion
      // Returns { ok, taskId, status: "pending"|"done"|"unknown", agent, result? }
      if (url.pathname.startsWith("/api/status/") && req.method === "GET") {
        if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized — Bearer token required" }); return; }
        const taskId = url.pathname.slice("/api/status/".length);
        const dispatch = pendingDispatches.get(taskId);
        if (!dispatch) {
          json(res, 200, { ok: true, taskId, status: "unknown" });
          return;
        }
        const isDone = dispatch.done === true;
        json(res, 200, {
          ok: true, taskId, status: isDone ? "done" : "pending",
          agent: dispatch.agent, sessionId: dispatch.sessionId,
          ...(isDone ? { result: dispatch.result || null } : {}),
          ts: dispatch.ts, elapsedMs: Date.now() - dispatch.ts,
        });
        return;
      }

      // GET /api/agents  — list known agents with tools, model, identity
      if (url.pathname === "/api/agents" && req.method === "GET") {
        if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized — Bearer token required" }); return; }
        const cfg = loadConfig();
        const agents = cfg.agentRoster.length
          ? cfg.agentRoster.map(a => ({ ...a, tools: readAgentTools(a.id).tools }))
          : (cfg.knownAgents || []).map(id => ({ id, tools: readAgentTools(id).tools }));
        // Annotate each agent with live OpenCode status
        const enriched = agents.map(a => ({
          ...a,
          inOpenCode: activeOpenCodeAgents.has(a.id),
          openCodeSince: activeOpenCodeAgents.get(a.id)?.since || null,
          openCodeModel: activeOpenCodeAgents.get(a.id)?.model || null,
        }));
        json(res, 200, { ok: true, agents: enriched });
        return;
      }

      // GET /api/agents/opencode — who is currently in an OpenCode session
      if (url.pathname === "/api/agents/opencode" && req.method === "GET") {
        if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
        const active = [...activeOpenCodeAgents.entries()].map(([id, info]) => ({
          id, model: info.model, since: info.since, elapsedMs: Date.now() - info.since,
        }));
        json(res, 200, { ok: true, count: active.length, agents: active });
        return;
      }

      // GET /api/background — background loop status: stalls, timeout patterns, ROADMAP state
      if (url.pathname === "/api/background" && req.method === "GET") {
        if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
        const timeoutPatterns = [...agentTimeoutCounts.entries()].map(([agent, count]) => ({ agent, count }));
        const stalledPipelines = [...pendingPipelines.entries()]
          .filter(([, p]) => p._lastActivity && (Date.now() - p._lastActivity) > 15 * 60 * 1000)
          .map(([id, p]) => ({ id, staleMinutes: Math.round((Date.now() - p._lastActivity) / 60000), pendingTasks: p.pendingTaskIds.size }));
        json(res, 200, { ok: true, activePipelines: pendingPipelines.size, stalledPipelines, timeoutPatterns });
        return;
      }

      // GET /api/agents/:id/tools — read an agent's current tool permissions
      const toolsGetMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/tools$/);
      if (toolsGetMatch && req.method === "GET") {
        if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
        const agentId = toolsGetMatch[1];
        const result  = readAgentTools(agentId);
        json(res, 200, {
          ok: true, agentId,
          tools: result.tools,
          source: result.source,
          allTools: [...crewswarmToolNames],
        });
        return;
      }

      // PATCH /api/agents/:id/tools — update an agent's tool permissions
      // Body: { "grant": ["write_file"], "revoke": ["run_cmd"] }  OR  { "set": ["read_file","write_file"] }
      const toolsPatchMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/tools$/);
      if (toolsPatchMatch && req.method === "PATCH") {
        if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
        const agentId = toolsPatchMatch[1];
        const body    = await readBody(req);
        const current = readAgentTools(agentId).tools;
        let updated;
        if (Array.isArray(body.set)) {
          updated = body.set;
        } else {
          const granted  = Array.isArray(body.grant)  ? body.grant  : [];
          const revoked  = Array.isArray(body.revoke) ? body.revoke : [];
          updated = [...new Set([...current, ...granted].filter(t => !revoked.includes(t)))];
        }
        const saved = writeAgentTools(agentId, updated);
        console.log(`[crew-lead] tools updated for ${agentId}: ${saved.join(", ")}`);
        json(res, 200, { ok: true, agentId, tools: saved });
        return;
      }

      // ── Inbound webhook receiver ───────────────────────────────────────────────
      // POST /webhook/:channel   — accepts any JSON payload, forwards to RT bus
      // No auth on this endpoint so external services can push without managing tokens.
      // Use a unique channel name per integration (e.g. /webhook/n8n, /webhook/stripe).
      const webhookMatch = url.pathname.match(/^\/webhook\/([a-zA-Z0-9_\-]+)$/);
      if (webhookMatch && req.method === "POST") {
        const channel = webhookMatch[1];
        let body = {};
        try {
          const raw = await readBody(req);
          body = raw ? JSON.parse(raw) : {};
        } catch { /* non-JSON body is fine */ }
        const event = { type: "webhook", channel, payload: body, ts: Date.now() };
        const rtPublish = getRtPublish();
        if (rtPublish) {
          rtPublish({ channel: `webhook.${channel}`, type: "webhook.event", payload: event });
          console.log(`[crew-lead] webhook → ${channel}: ${JSON.stringify(body).slice(0, 80)}`);
        }
        broadcastSSE({ type: "webhook_event", channel, payload: body, ts: Date.now() });
        json(res, 200, { ok: true, channel, ts: Date.now() });
        return;
      }

      // ── Skills API ─────────────────────────────────────────────────────────────
      const SKILLS_DIR         = path.join(os.homedir(), ".crewswarm", "skills");
      const PENDING_SKILLS_FILE = path.join(os.homedir(), ".crewswarm", "pending-skills.json");

      // GET /api/skills — list installed skills (both API .json and SKILL.md knowledge skills)
      if (url.pathname === "/api/skills" && req.method === "GET") {
        if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
        try {
          fs.mkdirSync(SKILLS_DIR, { recursive: true });
          const entries = fs.readdirSync(SKILLS_DIR);
          // API skills — .json files
          const apiSkills = entries.filter(f => f.endsWith(".json")).map(f => {
            try { return { name: f.replace(".json",""), type: "api", ...JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, f), "utf8")) }; }
            catch { return { name: f.replace(".json",""), type: "api", error: "parse failed" }; }
          });
          // Knowledge skills — folders containing SKILL.md
          const knowledgeSkills = entries.filter(f => {
            const fpath = path.join(SKILLS_DIR, f);
            return fs.statSync(fpath).isDirectory() && fs.existsSync(path.join(fpath, "SKILL.md"));
          }).map(f => {
            try {
              const body = fs.readFileSync(path.join(SKILLS_DIR, f, "SKILL.md"), "utf8");
              // Parse YAML frontmatter for name/description/aliases
              const fmMatch = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
              let name = f, description = "", aliases = [];
              if (fmMatch) {
                const fm = fmMatch[1];
                const nameM = fm.match(/^name:\s*(.+)$/m);
                const descM = fm.match(/^description:\s*(.+)$/m);
                const aliasM = fm.match(/^aliases:\s*\[(.+)\]/m);
                if (nameM) name = nameM[1].trim().replace(/^['"]|['"]$/g, "");
                if (descM) description = descM[1].trim().replace(/^['"]|['"]$/g, "");
                if (aliasM) aliases = aliasM[1].split(",").map(a => a.trim().replace(/^['"]|['"]$/g, ""));
              }
              return { name, type: "knowledge", description, aliases, _folder: f };
            } catch { return { name: f, type: "knowledge", error: "parse failed", _folder: f }; }
          });
          json(res, 200, { ok: true, skills: [...apiSkills, ...knowledgeSkills] });
        } catch (e) { json(res, 500, { ok: false, error: e.message }); }
        return;
      }

      // POST /api/skills  { name, url, method, description, headers, auth, defaultParams, requiresApproval }
      if (url.pathname === "/api/skills" && req.method === "POST") {
        if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
        const body = await readBody(req);
        if (!body.name || !body.url) { json(res, 400, { ok: false, error: "name and url required" }); return; }
        fs.mkdirSync(SKILLS_DIR, { recursive: true });
        const { name, ...def } = body;
        fs.writeFileSync(path.join(SKILLS_DIR, `${name}.json`), JSON.stringify(def, null, 2));
        json(res, 200, { ok: true, name });
        return;
      }

      // POST /api/skills/:name/run  — execute a skill from the dashboard (params in body)
      const skillRunMatch = url.pathname.match(/^\/api\/skills\/([a-zA-Z0-9_\-\.]+)\/run$/);
      if (skillRunMatch && req.method === "POST") {
        if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
        const skillName = resolveSkillAlias(skillRunMatch[1]);
        const skillFile = path.join(SKILLS_DIR, `${skillName}.json`);
        if (!fs.existsSync(skillFile)) { json(res, 404, { ok: false, error: "Skill not found" }); return; }
        let skillDef;
        try { skillDef = JSON.parse(fs.readFileSync(skillFile, "utf8")); } catch (e) { json(res, 500, { ok: false, error: "Invalid skill JSON" }); return; }
        let body = {};
        try { body = await readBody(req); } catch {}
        const bodyParams = body.params || body;
        const wantDiscovery = (typeof bodyParams === "object" && Object.keys(bodyParams || {}).length === 0) || (bodyParams && bodyParams.benchmark_id === "");
        let params = wantDiscovery && skillDef.listUrl ? {} : { ...(skillDef.defaultParams || {}), ...bodyParams };
        const aliases = skillDef.paramAliases || {};
        for (const [param, map] of Object.entries(aliases)) {
          if (params[param] != null && map[params[param]] != null) params[param] = map[params[param]];
        }
        const swarmCfg = tryRead(path.join(os.homedir(), ".crewswarm", "crewswarm.json")) || {};
        let urlStr;
        const urlParam = (skillDef.url || "").match(/\{(\w+)\}/);
        const emptyKey = urlParam ? urlParam[1] : null;
        const paramEmpty = emptyKey && (params[emptyKey] === undefined || params[emptyKey] === null || String(params[emptyKey] || "").trim() === "");
        if (skillDef.listUrl && (wantDiscovery || paramEmpty)) {
          urlStr = skillDef.listUrl;
        } else {
          urlStr = skillDef.url || "";
          for (const [k, v] of Object.entries(params)) urlStr = urlStr.replace(`{${k}}`, encodeURIComponent(String(v)));
        }
        const headers = { "Content-Type": "application/json", ...(skillDef.headers || {}) };
        if (skillDef.auth) {
          const auth = skillDef.auth;
          let token = auth.token || "";
          if (auth.keyFrom) {
            if (auth.keyFrom.startsWith("env.")) token = process.env[auth.keyFrom.slice(4)] || "";
            else {
              let val = swarmCfg;
              for (const p of auth.keyFrom.split(".")) val = val?.[p];
              if (val) token = String(val);
            }
          }
          if (token) {
            if (auth.type === "bearer" || !auth.type) headers["Authorization"] = `Bearer ${token}`;
            else if (auth.type === "header") headers[auth.header || "X-API-Key"] = token;
          }
        }
        const method = (skillDef.method || "POST").toUpperCase();
        const reqOpts = { method, headers, signal: AbortSignal.timeout(skillDef.timeout || 30000) };
        if (method !== "GET" && method !== "HEAD") reqOpts.body = JSON.stringify(params);
        try {
          const r = await fetch(urlStr, reqOpts);
          const text = await r.text();
          if (!r.ok) { json(res, 502, { ok: false, error: `Upstream ${r.status}: ${text.slice(0, 200)}` }); return; }
          try { json(res, 200, { ok: true, result: JSON.parse(text) }); }
          catch { json(res, 200, { ok: true, result: { response: text } }); }
        } catch (e) { json(res, 502, { ok: false, error: e.message }); }
        return;
      }

      // DELETE /api/skills/:name
      const skillDeleteMatch = url.pathname.match(/^\/api\/skills\/([a-zA-Z0-9_\-\.]+)$/);
      if (skillDeleteMatch && req.method === "DELETE") {
        if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
        const skillName = skillDeleteMatch[1];
        const skillFile = path.join(SKILLS_DIR, `${skillName}.json`);
        const skillFolder = path.join(SKILLS_DIR, skillName);
        if (fs.existsSync(skillFile)) {
          fs.unlinkSync(skillFile);
          json(res, 200, { ok: true });
        } else if (fs.existsSync(skillFolder) && fs.existsSync(path.join(skillFolder, "SKILL.md"))) {
          fs.rmSync(skillFolder, { recursive: true, force: true });
          json(res, 200, { ok: true });
        } else {
          json(res, 404, { ok: false, error: "Skill not found" });
        }
        return;
      }

      // POST /api/skills/approve  { approvalId }  — approve a pending skill call
      if (url.pathname === "/api/skills/approve" && req.method === "POST") {
        if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
        const body = await readBody(req);
        const { approvalId } = body;
        let pending = {};
        try { pending = JSON.parse(fs.readFileSync(PENDING_SKILLS_FILE, "utf8")); } catch {}
        const entry = pending[approvalId];
        if (!entry) { json(res, 404, { ok: false, error: "Approval ID not found or expired" }); return; }
        delete pending[approvalId];
        fs.writeFileSync(PENDING_SKILLS_FILE, JSON.stringify(pending, null, 2));
        // Execute the skill via the gateway bridge process is impractical from here;
        // instead, push approved result to RT bus so agent can see it
        broadcastSSE({ type: "skill_approved", approvalId, skillName: entry.skillName, agentId: entry.agentId, ts: Date.now() });
        console.log(`[crew-lead] skill approved: ${entry.skillName} (${approvalId}) — notifying bridge agents`);
        const rtPublish = getRtPublish();
        if (rtPublish) {
          rtPublish({ channel: "skill.approved", type: "skill.approved", payload: { approvalId, skillName: entry.skillName, agentId: entry.agentId, params: entry.params } });
        }
        json(res, 200, { ok: true, approvalId, skillName: entry.skillName });
        return;
      }

      // POST /api/skills/reject  { approvalId }
      if (url.pathname === "/api/skills/reject" && req.method === "POST") {
        if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
        const body = await readBody(req);
        const { approvalId } = body;
        let pending = {};
        try { pending = JSON.parse(fs.readFileSync(PENDING_SKILLS_FILE, "utf8")); } catch {}
        delete pending[approvalId];
        try { fs.writeFileSync(PENDING_SKILLS_FILE, JSON.stringify(pending, null, 2)); } catch {}
        broadcastSSE({ type: "skill_rejected", approvalId, ts: Date.now() });
        json(res, 200, { ok: true, approvalId });
        return;
      }

      // ── Spending caps API ──────────────────────────────────────────────────────
      const SPENDING_FILE = path.join(os.homedir(), ".crewswarm", "spending.json");

      // GET /api/spending — today's usage across global + per-agent
      if (url.pathname === "/api/spending" && req.method === "GET") {
        if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
        let spending = { date: new Date().toISOString().slice(0, 10), global: { tokens: 0, costUSD: 0 }, agents: {} };
        try { spending = JSON.parse(fs.readFileSync(SPENDING_FILE, "utf8")); } catch {}
        // Attach caps config
        let caps = {};
        try {
          const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "crewswarm.json"), "utf8"));
          caps.global = cfg.globalSpendingCaps || {};
          caps.agents = (cfg.agents || []).reduce((acc, a) => { if (a.spending) acc[a.id] = a.spending; return acc; }, {});
        } catch {}
        json(res, 200, { ok: true, spending, caps });
        return;
      }

      // GET/POST /api/settings/bg-consciousness — toggle background consciousness at runtime
      if (url.pathname === "/api/settings/bg-consciousness") {
        if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
        if (req.method === "GET") {
          json(res, 200, { ok: true, enabled: bgConsciousnessRef.enabled, intervalMs: bgConsciousnessIntervalMs, model: bgConsciousnessRef.model });
          return;
        }
        if (req.method === "POST") {
          const body = await readBody(req);
          const enable = typeof body.enabled === "boolean" ? body.enabled : !bgConsciousnessRef.enabled;
          bgConsciousnessRef.enabled = enable;
          if (body.model && typeof body.model === "string") bgConsciousnessRef.model = body.model.trim();
          // Persist to config.json so it survives restarts
          try {
            const cfgPath = path.join(os.homedir(), ".crewswarm", "config.json");
            const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
            cfg.bgConsciousness = enable;
            if (body.model) cfg.bgConsciousnessModel = bgConsciousnessRef.model;
            fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
          } catch (e) { console.warn("[crew-lead] Could not persist bgConsciousness:", e.message); }
          console.log(`[crew-lead] Background consciousness ${enable ? "ENABLED" : "DISABLED"} model=${bgConsciousnessRef.model} via dashboard`);
          if (enable) bgConsciousnessRef.lastActivityAt = 0;
          json(res, 200, { ok: true, enabled: bgConsciousnessRef.enabled, model: bgConsciousnessRef.model });
          return;
        }
      }

      // GET /api/claude-sessions — list + read Claude Code session history
      // ?dir=<project-path>  (default: current repo)  &limit=20
      if (url.pathname === "/api/claude-sessions" && req.method === "GET") {
        if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
        try {
          const qDir = url.searchParams.get("dir") || process.cwd();
          const limit = Math.min(Number(url.searchParams.get("limit") || "20"), 100);
          // Claude stores projects as path-with-dashes: /Users/foo/bar → -Users-foo-bar
          const dirKey = qDir.replace(/\//g, "-");
          const projectsBase = path.join(os.homedir(), ".claude", "projects");
          const candidates = fs.existsSync(projectsBase)
            ? fs.readdirSync(projectsBase).filter(d => d === dirKey || d.endsWith(dirKey.split("-").slice(-2).join("-")))
            : [];
          const sessions = [];
          for (const cand of candidates) {
            const sessDir = path.join(projectsBase, cand);
            const files = fs.readdirSync(sessDir).filter(f => f.endsWith(".jsonl"))
              .map(f => ({ f, mt: fs.statSync(path.join(sessDir, f)).mtimeMs }))
              .sort((a, b) => b.mt - a.mt).slice(0, limit).map(x => x.f);
            for (const file of files) {
              const sessionId = file.replace(".jsonl", "");
              const messages = [];
              const lines = fs.readFileSync(path.join(sessDir, file), "utf8").trim().split("\n");
              for (const line of lines) {
                try {
                  const d = JSON.parse(line);
                  if (d.type !== "user" && d.type !== "assistant") continue;
                  const content = d.message?.content;
                  const text = Array.isArray(content)
                    ? content.filter(c => c.type === "text").map(c => c.text).join("")
                    : typeof content === "string" ? content : "";
                  if (text) messages.push({ role: d.type, text: text.slice(0, 2000), ts: d.timestamp });
                } catch {}
              }
              if (messages.length) sessions.push({ sessionId, file, messages });
            }
          }
          json(res, 200, { ok: true, dir: qDir, sessions });
        } catch (e) {
          json(res, 200, { ok: true, sessions: [], error: e.message });
        }
        return;
      }

      // GET /api/opencode-sessions — list + read OpenCode session history from SQLite
      // ?limit=10&session=<id>
      if (url.pathname === "/api/opencode-sessions" && req.method === "GET") {
        if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
        try {
          const { execSync } = await import("node:child_process");
          const dbPath = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
          if (!fs.existsSync(dbPath)) { json(res, 200, { ok: true, sessions: [], error: "opencode.db not found" }); return; }
          const limit = Math.min(Number(url.searchParams.get("limit") || "10"), 50);
          const sessionFilter = url.searchParams.get("session") || "";

          // List sessions
          const sessRows = execSync(
            `sqlite3 "${dbPath}" "SELECT s.id, s.title, s.time_updated, count(m.id) as msg_count FROM session s LEFT JOIN message m ON m.session_id=s.id ${sessionFilter ? `WHERE s.id='${sessionFilter}'` : ""} GROUP BY s.id ORDER BY s.time_updated DESC LIMIT ${limit};"`,
            { encoding: "utf8" }
          ).trim().split("\n").filter(Boolean);

          const sessions = [];
          for (const row of sessRows) {
            const [id, title, timeUpdated, msgCount] = row.split("|");
            // Get parts (actual message content) for this session
            const partRows = execSync(
              `sqlite3 "${dbPath}" "SELECT p.data FROM part p JOIN message m ON p.message_id=m.id WHERE m.session_id='${id}' ORDER BY p.time_created LIMIT 100;"`,
              { encoding: "utf8" }
            ).trim().split("\n").filter(Boolean);

            const messages = [];
            let currentRole = null;
            // Group parts by message
            const msgRows = execSync(
              `sqlite3 "${dbPath}" "SELECT m.id, m.data FROM message m WHERE m.session_id='${id}' ORDER BY m.time_created;"`,
              { encoding: "utf8" }
            ).trim().split("\n").filter(Boolean);

            for (const mrow of msgRows) {
              const [mid, mdata] = mrow.split("|");
              try {
                const md = JSON.parse(mdata);
                const role = md.role;
                // Get text parts for this message
                const textParts = execSync(
                  `sqlite3 "${dbPath}" "SELECT data FROM part WHERE message_id='${mid}' AND json_extract(data,'$.type')='text';"`,
                  { encoding: "utf8" }
                ).trim().split("\n").filter(Boolean);
                const text = textParts.map(p => { try { return JSON.parse(p).text || ""; } catch { return ""; } }).join("").trim();
                const cost = md.cost || 0;
                const tokens = md.tokens || {};
                if (text) messages.push({ role, text: text.slice(0, 2000), cost, tokens });
              } catch {}
            }
            sessions.push({ id, title, timeUpdated: Number(timeUpdated), msgCount: Number(msgCount), messages });
          }
          json(res, 200, { ok: true, sessions });
        } catch (e) {
          json(res, 200, { ok: true, sessions: [], error: e.message });
        }
        return;
      }

      // GET /api/agent-transcripts/recent — read most recent Cursor agent transcript(s)
      if (url.pathname === "/api/agent-transcripts/recent" && req.method === "GET") {
        if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
        try {
          const transcriptsDir = path.join(
            os.homedir(), ".cursor", "projects",
            fs.readdirSync(path.join(os.homedir(), ".cursor", "projects"))
              .filter(d => d.includes("CrewSwarm"))
              .sort().pop() || "",
            "agent-transcripts"
          );
          const files = fs.existsSync(transcriptsDir)
            ? fs.readdirSync(transcriptsDir).filter(f => f.endsWith(".jsonl"))
                .map(f => ({ f, mt: fs.statSync(path.join(transcriptsDir, f)).mtimeMs }))
                .sort((a, b) => b.mt - a.mt)
                .slice(0, 3).map(x => x.f)
            : [];
          const messages = [];
          for (const file of files) {
            const lines = fs.readFileSync(path.join(transcriptsDir, file), "utf8").trim().split("\n");
            for (const line of lines) {
              try {
                const d = JSON.parse(line);
                const role = d.role || "";
                const content = (d.message?.content || []);
                const text = Array.isArray(content)
                  ? content.filter(c => c.type === "text").map(c => c.text).join("")
                  : String(content);
                // Strip system wrapper tags
                const clean = text.replace(/<user_query>/g, "").replace(/<\/user_query>/g, "").trim();
                if (clean) messages.push({ role, text: clean });
              } catch {}
            }
          }
          json(res, 200, { ok: true, messages: messages.slice(-40) }); // last 40 turns
        } catch (e) {
          json(res, 200, { ok: true, messages: [], error: e.message });
        }
        return;
      }

      // POST /api/engine-passthrough — stream a message directly to Cursor CLI, Claude Code, OpenCode, or Codex
      // Body: { engine: "cursor"|"claude"|"opencode"|"codex", message: string, projectDir?: string, injectHistory?: boolean, model?: string }
      // Streams raw output back as SSE: data: {"type":"chunk","text":"..."} then data: {"type":"done"}
      if (url.pathname === "/api/engine-passthrough" && req.method === "POST") {
        if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
        let body = ""; for await (const chunk of req) body += chunk;
        const { engine = "claude", message, projectDir: reqProjectDir, injectHistory, model: reqModel } = JSON.parse(body || "{}");
        if (!message) { json(res, 400, { ok: false, error: "message required" }); return; }

        // Optionally prepend recent Cursor agent chat history as context
        let finalMessage = message;
        if (injectHistory) {
          try {
            const transcriptsDir = path.join(
              os.homedir(), ".cursor", "projects",
              fs.readdirSync(path.join(os.homedir(), ".cursor", "projects"))
                .filter(d => d.includes("CrewSwarm")).sort().pop() || "",
              "agent-transcripts"
            );
            if (fs.existsSync(transcriptsDir)) {
              const files = fs.readdirSync(transcriptsDir).filter(f => f.endsWith(".jsonl"))
                .map(f => ({ f, mt: fs.statSync(path.join(transcriptsDir, f)).mtimeMs }))
                .sort((a, b) => b.mt - a.mt).slice(0, 2).map(x => x.f);
              const lines = [];
              for (const file of files) {
                const raw = fs.readFileSync(path.join(transcriptsDir, file), "utf8").trim().split("\n");
                for (const l of raw) {
                  try {
                    const d = JSON.parse(l);
                    const role = d.role || "";
                    const content = d.message?.content || [];
                    const text = Array.isArray(content)
                      ? content.filter(c => c.type === "text").map(c => c.text).join("")
                      : String(content);
                    const clean = text.replace(/<user_query>/g, "").replace(/<\/user_query>/g, "").trim();
                    if (clean) lines.push(`[${role}]: ${clean.slice(0, 600)}`);
                  } catch {}
                }
              }
              if (lines.length) {
                finalMessage = `[Recent Cursor agent chat context — use as background only]\n${lines.slice(-20).join("\n")}\n\n[Current request]\n${message}`;
              }
            }
          } catch {}
        }

        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "access-control-allow-origin": "*",
          "connection": "keep-alive",
        });
        const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} };
        const projectDir = reqProjectDir || process.cwd();
        const sessionScope = reqSessionId || "default";

        let bin, args;
        const continueSession = req.headers["x-passthrough-continue"] !== "false"; // default on

        // Session ID store — persisted to disk so restarts don't lose context
        const _sessionStoreFile = path.join(os.homedir(), ".crewswarm", "passthrough-sessions.json");
        if (!global._passthroughSessions) {
          try { global._passthroughSessions = JSON.parse(fs.readFileSync(_sessionStoreFile, "utf8")); } catch { global._passthroughSessions = {}; }
        }
        const _savePassthroughSessions = () => {
          try { fs.writeFileSync(_sessionStoreFile, JSON.stringify(global._passthroughSessions, null, 2)); } catch {}
        };
        // Build session key with engine + projectDir + sessionScope for parallel sessions
        const sessionKey = (engineId) => `${engineId}:${projectDir}:${sessionScope}`;
        // Legacy in-memory aliases (kept for backward compat with Gemini/Codex refs below)
        global._geminiSessionIds = global._passthroughSessions;
        if (!global._codexHasPriorSession) global._codexHasPriorSession = {};
        if (engine === "cursor") {
          const cursorBin = process.env.CURSOR_CLI_BIN || "cursor";
          bin = cursorBin;
          args = ["agent", "--print", "--yolo", "--output-format", "stream-json"];
          if (reqModel) args.push("--model", reqModel);
          args.push(finalMessage);
        } else if (engine === "opencode") {
          bin = process.env.CREWSWARM_OPENCODE_BIN || "opencode";
          const ocModel = reqModel || process.env.CREWSWARM_OPENCODE_MODEL || "groq/moonshotai/kimi-k2-instruct-0905";
          args = ["run", finalMessage, "--model", ocModel];
          if (continueSession) args.push("--continue");
        } else if (engine === "codex") {
          bin = process.env.CODEX_CLI_BIN || "codex";
          // Only use resume --last if a prior Codex session actually exists for this scope
          const codexKey = sessionKey("codex");
          const codexHasPrior = continueSession && global._passthroughSessions[codexKey];
          if (codexHasPrior) {
            args = ["exec", "resume", "--last", "--full-auto", "--json", finalMessage];
          } else {
            // --full-auto = workspace-write sandbox + auto-approve write requests (no blocking prompts)
            args = ["exec", "--full-auto", "--json", finalMessage];
          }
          // Mark that a session now exists for this scope — persisted to disk so restarts don't lose it
          global._passthroughSessions[codexKey] = true;
          _savePassthroughSessions();
        } else if (engine === "gemini" || engine === "gemini-cli") {
          bin = process.env.GEMINI_CLI_BIN || "gemini";
          const geminiModel = reqModel || process.env.CREWSWARM_GEMINI_CLI_MODEL || null;
          const geminiKey = sessionKey("gemini");
          const priorGeminiSession = continueSession && global._passthroughSessions[geminiKey];
          // --approval-mode yolo = auto-approve all tool calls (file writes, shell) without blocking prompts
          args = ["-p", finalMessage, "--output-format", "stream-json", "--approval-mode", "yolo"];
          if (geminiModel) args.push("-m", geminiModel);
          // Use stored session ID for continuity — avoids "No previous sessions found" crash
          if (priorGeminiSession) args.push("--resume", priorGeminiSession);
        } else if (engine === "antigravity") {
          bin = process.env.CREWSWARM_OPENCODE_BIN || "opencode";
          const agModel = process.env.CREWSWARM_ANTIGRAVITY_MODEL || "google/antigravity-gemini-3-pro";
          args = ["run", finalMessage, "--model", agModel];
          if (continueSession) args.push("--continue");
        } else if (engine === "docker-sandbox") {
          bin = "docker";
          const sandboxName = process.env.CREWSWARM_DOCKER_SANDBOX_NAME || "crewswarm";
          const innerEngine = (process.env.CREWSWARM_DOCKER_SANDBOX_INNER_ENGINE || "claude").toLowerCase();
          let innerArgs;
          if (innerEngine === "opencode") {
            innerArgs = ["opencode", "run", finalMessage];
          } else if (innerEngine === "codex") {
            innerArgs = ["codex", "exec", "--sandbox", "workspace-write", "--json", finalMessage];
          } else {
            innerArgs = ["claude", "-p", "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose", finalMessage];
          }
          args = ["sandbox", "exec", sandboxName, "--", ...innerArgs];
        } else {
          bin = process.env.CLAUDE_CODE_BIN || "claude";
          args = ["-p", "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
          if (reqModel) args.push("--model", reqModel);
          if (continueSession) args.push("--continue");
          args.push(finalMessage);
        }

        send({ type: "start", engine, message: message.slice(0, 80) });
        const { spawn: _spawn } = await import("node:child_process");
        const proc = _spawn(bin, args, { cwd: projectDir, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
        let lineBuffer = "";
        let fullOutput = "";
        let receivedStreamDeltas = false; // track whether incremental deltas arrived

        const handleChunk = (chunk) => {
          lineBuffer += chunk.toString();
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.trim()) continue;
            if (engine === "opencode" || engine === "antigravity") {
              send({ type: "chunk", text: line + "\n" });
              fullOutput += line + "\n";
              continue;
            }
            try {
              const ev = JSON.parse(line);
              // Gemini CLI stream-json events:
              //   { type: "init", sessionId, model }
              // Real stream-json schema (from @google/gemini-cli nonInteractiveCli.js):
              //   init:        { type:"init", timestamp, session_id, model }
              //   message:     { type:"message", role:"assistant"|"user", content:"text", delta:true }
              //   tool_use:    { type:"tool_use", tool_name, tool_id, parameters }
              //   tool_result: { type:"tool_result", tool_id, status, output, error }
              //   result:      { type:"result", status:"success", stats:{...} }  — NO response field
              //   error:       { type:"error", severity, message }
              if (engine === "gemini" || engine === "gemini-cli") {
                if (ev.type === "init" && (ev.session_id || ev.sessionId)) {
                  // Persist session ID so next call (and restarts) can resume for context continuity
                  const sid = ev.session_id || ev.sessionId;
                  global._passthroughSessions[sessionKey("gemini")] = sid;
                  _savePassthroughSessions();
                } else if (ev.type === "message" && ev.role === "assistant" && ev.content) {
                  send({ type: "chunk", text: ev.content });
                  fullOutput += ev.content;
                } else if (ev.type === "result") {
                  proc.kill("SIGTERM");
                } else if (ev.type === "error") {
                  send({ type: "stderr", text: ev.message || JSON.stringify(ev) });
                }
                continue;
              }
              // Codex CLI --json events (actual format):
              //   { type: "thread.started", thread_id: "..." }
              //   { type: "turn.started" }
              //   { type: "item.completed", item: { type: "reasoning", text: "..." } }  — skip
              //   { type: "item.completed", item: { type: "agent_message", text: "..." } }  — this is the reply
              //   { type: "turn.completed", usage: {...} }
              if (engine === "codex") {
                if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item?.text) {
                  send({ type: "chunk", text: ev.item.text }); fullOutput += ev.item.text;
                } else if (ev.type === "turn.completed") {
                  proc.kill("SIGTERM");
                }
                continue;
              }
              if (ev.type === "stream_event" && ev.event?.type === "content_block_delta") {
                const t = ev.event.delta?.text || "";
                if (t) { send({ type: "chunk", text: t }); fullOutput += t; receivedStreamDeltas = true; }
              } else if (ev.type === "assistant") {
                // Skip if we already streamed deltas — the assistant event would duplicate them
                if (!receivedStreamDeltas) {
                  const content = ev.message?.content;
                  if (Array.isArray(content)) { for (const c of content) { if (c.type === "text") { send({ type: "chunk", text: c.text }); fullOutput += c.text; } } }
                  else if (typeof content === "string") { send({ type: "chunk", text: content }); fullOutput += content; }
                }
              } else if (ev.type === "result") {
                // result.result duplicates streamed content — only use it if we got nothing else
                if (!fullOutput && ev.result) { send({ type: "chunk", text: ev.result }); fullOutput += ev.result; }
                proc.kill("SIGTERM");
              }
            } catch { send({ type: "chunk", text: line + "\n" }); fullOutput += line + "\n"; }
          }
        };

        proc.stdout.on("data", handleChunk);
        proc.stderr.on("data", (d) => send({ type: "stderr", text: d.toString() }));
        proc.on("close", async (code) => {
          if (lineBuffer.trim()) { send({ type: "chunk", text: lineBuffer }); fullOutput += lineBuffer; }
          send({ type: "done", exitCode: code });
          try { res.end(); } catch {}

          // ── Notify Telegram/WA on completion (dashboard already saw it stream live) ──
          const summary = fullOutput.trim().slice(0, 3000) || "(no output)";
          const engineLabel = engine === "cursor" ? "Cursor CLI" : engine === "claude" ? "Claude Code" : engine === "codex" ? "Codex CLI" : engine === "docker-sandbox" ? "Docker Sandbox" : (engine === "gemini" || engine === "gemini-cli") ? "Gemini CLI" : engine === "antigravity" ? "Antigravity" : "OpenCode";
          const broadcastContent = `⚡ ${engineLabel}: ${summary}`;

          // PASSTHROUGH_NOTIFY: "tg" | "wa" | "both" | "none" (default: "both")
          // Set in ~/.crewswarm/crewswarm.json env block or as env var
          const passthroughNotify = (() => {
            try { return (process.env.PASSTHROUGH_NOTIFY || JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "crewswarm.json"), "utf8")).env?.PASSTHROUGH_NOTIFY || "both").toLowerCase(); } catch { return "both"; }
          })();
          const notifyTG = passthroughNotify === "both" || passthroughNotify === "tg";
          const notifyWA = passthroughNotify === "both" || passthroughNotify === "wa";

          // Broadcast to WhatsApp via /events SSE (whatsapp-bridge listens here)
          // _passthroughSummary flag tells the dashboard frontend to ignore this — it already rendered the stream live
          if (notifyWA) broadcastSSE({ type: "agent_reply", from: engineLabel, content: broadcastContent, sessionId: "owner", _passthroughSummary: true, ts: Date.now() });

          // Telegram — split into chunks if > 3800 chars (TG max is 4096)
          if (notifyTG) try {
            const tgBridge = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "telegram-bridge.json"), "utf8"));
            const botToken = process.env.TELEGRAM_BOT_TOKEN || tgBridge.token || "";
            const chatId = process.env.TELEGRAM_CHAT_ID
              || (Array.isArray(tgBridge.allowedChatIds) && tgBridge.allowedChatIds[0] ? String(tgBridge.allowedChatIds[0]) : "")
              || tgBridge.defaultChatId || "";
            if (botToken && chatId) {
              const TG_MAX = 3800;
              const header = `⚡ *${engineLabel}*: \`${message.slice(0, 80)}${message.length > 80 ? "…" : ""}\`\n\n`;
              const chunks = [];
              let remaining = summary;
              chunks.push(header + remaining.slice(0, TG_MAX - header.length));
              remaining = remaining.slice(TG_MAX - header.length);
              while (remaining.length > 0) { chunks.push(remaining.slice(0, TG_MAX)); remaining = remaining.slice(TG_MAX); }
              for (const chunk of chunks) {
                await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: "Markdown" }),
                  signal: AbortSignal.timeout(8000),
                }).catch(() => {});
              }
            }
          } catch {}
        });
        req.on("close", () => { try { proc.kill("SIGTERM"); } catch {} });
        return;
      }

      // GET /api/passthrough-sessions — list active CLI sessions by project
      // DELETE /api/passthrough-sessions?key=<key> — clear a specific session
      // DELETE /api/passthrough-sessions — clear all sessions
      if (url.pathname === "/api/passthrough-sessions") {
        if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
        const sessionStoreFile = path.join(os.homedir(), ".crewswarm", "passthrough-sessions.json");
        if (!global._passthroughSessions) {
          try { global._passthroughSessions = JSON.parse(fs.readFileSync(sessionStoreFile, "utf8")); } catch { global._passthroughSessions = {}; }
        }
        if (req.method === "GET") {
          json(res, 200, { ok: true, sessions: global._passthroughSessions });
          return;
        }
        if (req.method === "DELETE") {
          const key = url.searchParams.get("key");
          if (key) {
            delete global._passthroughSessions[key];
          } else {
            global._passthroughSessions = {};
          }
          try { fs.writeFileSync(sessionStoreFile, JSON.stringify(global._passthroughSessions, null, 2)); } catch {}
          json(res, 200, { ok: true, cleared: key || "all" });
          return;
        }
      }

      // GET/POST /api/settings/claude-code — toggle Claude Code executor at runtime
      if (url.pathname === "/api/settings/claude-code") {
        if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
        if (req.method === "GET") {
          let enabled = false;
          try {
            const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "config.json"), "utf8"));
            enabled = cfg.claudeCode === true;
          } catch {}
          const hasKey = !!(process.env.ANTHROPIC_API_KEY ||
            (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "crewswarm.json"), "utf8"))?.providers?.anthropic?.apiKey; } catch { return null; } })());
          json(res, 200, { ok: true, enabled, hasKey });
          return;
        }
        if (req.method === "POST") {
          const body = await readBody(req);
          const enable = typeof body.enabled === "boolean" ? body.enabled : false;
          try {
            const cfgPath = path.join(os.homedir(), ".crewswarm", "config.json");
            const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
            cfg.claudeCode = enable;
            fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
          } catch (e) { console.warn("[crew-lead] Could not persist claudeCode:", e.message); }
          console.log(`[crew-lead] Claude Code executor ${enable ? "ENABLED" : "DISABLED"} via dashboard`);
          json(res, 200, { ok: true, enabled: enable });
          return;
        }
      }

      // GET/POST /api/settings/cursor-waves — toggle Cursor parallel wave dispatch at runtime
      if (url.pathname === "/api/settings/cursor-waves") {
        if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
        if (req.method === "GET") {
          json(res, 200, { ok: true, enabled: cursorWavesRef.enabled });
          return;
        }
        if (req.method === "POST") {
          const body = await readBody(req);
          const enable = typeof body.enabled === "boolean" ? body.enabled : !cursorWavesRef.enabled;
          cursorWavesRef.enabled = enable;
          // Persist to config.json so it survives restarts
          try {
            const cfgPath = path.join(os.homedir(), ".crewswarm", "config.json");
            const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
            cfg.cursorWaves = enable;
            fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
          } catch (e) { console.warn("[crew-lead] Could not persist cursorWaves:", e.message); }
          console.log(`[crew-lead] Cursor Waves ${enable ? "ENABLED" : "DISABLED"} via dashboard`);
          json(res, 200, { ok: true, enabled: cursorWavesRef.enabled });
          return;
        }
      }

      // GET/POST /api/settings/global-fallback — set/get global OpenCode fallback model
      if (url.pathname === "/api/settings/global-fallback") {
        if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
        if (req.method === "GET") {
          let current = "";
          try {
            const swarm = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "crewswarm.json"), "utf8"));
            current = swarm.globalFallbackModel || "";
          } catch {}
          json(res, 200, { ok: true, globalFallbackModel: current });
          return;
        }
        if (req.method === "POST") {
          const body = await readBody(req);
          const model = String(body.globalFallbackModel || "").trim();
          try {
            const swarmPath = path.join(os.homedir(), ".crewswarm", "crewswarm.json");
            const swarm = JSON.parse(fs.readFileSync(swarmPath, "utf8"));
            swarm.globalFallbackModel = model;
            fs.writeFileSync(swarmPath, JSON.stringify(swarm, null, 2));
            console.log(`[crew-lead] Global fallback model set to: ${model || "(cleared)"}`);
            json(res, 200, { ok: true, globalFallbackModel: model });
          } catch (e) { json(res, 500, { ok: false, error: e.message }); }
          return;
        }
      }

      // POST /api/spending/reset — reset today's spending counters
      if (url.pathname === "/api/spending/reset" && req.method === "POST") {
        if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
        const fresh = { date: new Date().toISOString().slice(0, 10), global: { tokens: 0, costUSD: 0 }, agents: {} };
        try { fs.writeFileSync(SPENDING_FILE, JSON.stringify(fresh, null, 2)); } catch {}
        json(res, 200, { ok: true, reset: true });
        return;
      }

      // GET /api/health — master health check: all settings, agents, skills, spending, services
      if (url.pathname === "/api/health" && req.method === "GET") {
        if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
        const cfg       = loadConfig();
        const cfgRaw    = tryRead(path.join(os.homedir(), ".crewswarm", "config.json"))    || {};
        const swarmRaw  = tryRead(path.join(os.homedir(), ".crewswarm", "crewswarm.json")) || {};
        const rtPublish = getRtPublish();

        // OpenCode project dir
        const opencodeProject = cfgRaw.opencodeProject || process.env.CREWSWARM_OPENCODE_PROJECT || "";

        // Agents with tools + model
        const agentRows = cfg.agentRoster.map(a => {
          const tools = readAgentTools(a.id).tools;
          return { id: a.id, name: a.name, emoji: a.emoji, role: a.role, model: a.model, tools };
        });

        // Skills
        const SKILLS_DIR_HEALTH = path.join(os.homedir(), ".crewswarm", "skills");
        let skills = [];
        try {
          fs.mkdirSync(SKILLS_DIR_HEALTH, { recursive: true });
          skills = fs.readdirSync(SKILLS_DIR_HEALTH).filter(f => f.endsWith(".json")).map(f => {
            try { return { name: f.replace(".json",""), ...JSON.parse(fs.readFileSync(path.join(SKILLS_DIR_HEALTH, f), "utf8")) }; }
            catch { return { name: f.replace(".json",""), error: "parse failed" }; }
          });
        } catch {}

        // Spending
        let spending = { global: { tokens: 0, costUSD: 0 }, agents: {} };
        try { spending = JSON.parse(fs.readFileSync(SPENDING_FILE, "utf8")); } catch {}

        // RT bus connectivity
        const rtConnected = !!rtPublish;

        // Providers (keys masked)
        const providers = Object.entries(swarmRaw?.providers || {}).map(([id, p]) => ({
          id, baseUrl: p.baseUrl, hasKey: !!(p.apiKey || "").trim(),
        }));

        json(res, 200, {
          ok: true,
          ts: new Date().toISOString(),
          crewLead: {
            model:   `${cfg.providerKey}/${cfg.modelId}`,
            port:    PORT,
            rtConnected,
          },
          settings: {
            opencodeProject,
            rtAuthToken: !!(cfgRaw?.rt?.authToken || "").trim(),
          },
          agents: agentRows,
          skills,
          spending,
          providers,
          telemetry: readTelemetryEvents(20),
        });
        return;
      }

      // GET /api/telemetry — last N task.lifecycle events (schema 1.1)
      if (url.pathname === "/api/telemetry" && req.method === "GET") {
        if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
        const limit = Math.min(parseInt(req.headers["limit"] || String(50), 10) || 50, 100);
        json(res, 200, { ok: true, schemaVersion: telemetrySchemaVersion, events: readTelemetryEvents(limit) });
        return;
      }

      // POST /api/agents/:id/restart — kill and respawn a single bridge process
      const restartMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/restart$/);
      if (restartMatch && req.method === "POST") {
        if (!checkBearer(req)) { json(res, 401, { ok: false, error: "Unauthorized" }); return; }
        const agentId = restartMatch[1];
        const { execSync: exec2 } = await import("node:child_process");
        const RT_TOKEN = getRTToken();
        try {
          exec2(`pkill -f "gateway-bridge.mjs.*${agentId}" 2>/dev/null || true`, { shell: true });
          // Respawn via start-crew --agent (waits for spawn, then returns)
          setTimeout(async () => {
            try {
              exec2(`node ${path.join(process.cwd(), "scripts", "start-crew.mjs")} --agent ${agentId}`, {
                shell: true,
                timeout: 10000,
                env: { ...process.env, CREWSWARM_RT_AUTH_TOKEN: RT_TOKEN },
              });
              console.log(`[crew-lead] bridge respawned for ${agentId}`);
            } catch (e2) {
              console.error(`[crew-lead] failed to respawn bridge for ${agentId}:`, e2.message);
            }
          }, 500);
          console.log(`[crew-lead] restart requested for ${agentId}`);
          json(res, 200, { ok: true, agentId, action: "restart" });
        } catch (e) {
          json(res, 500, { ok: false, error: e.message });
        }
        return;
      }

      json(res, 404, { ok: false, error: "not found" });
    } catch (err) {
      console.error("[crew-lead] error:", err.message);
      json(res, 500, { ok: false, error: err.message });
    }
  });

  const BIND_HOST = process.env.CREWSWARM_BIND_HOST || "127.0.0.1";
  server.listen(PORT, BIND_HOST, () => {
    const cfg = loadConfig();
    console.log(`[crew-lead] HTTP server on http://${BIND_HOST}:${PORT}`);
    console.log(`[crew-lead] Model: ${cfg.providerKey}/${cfg.modelId}`);
    console.log(`[crew-lead] History: ${historyDir}`);
    console.log(`[crew-lead] Agents: ${cfg.knownAgents.join(", ")}`);
    console.log(`[crew-lead] Dispatch timeout: ${dispatchTimeoutMs / 1000}s`);
    if (!dispatchTimeoutInterval) {
      setDispatchTimeoutInterval(setInterval(checkDispatchTimeouts, 15_000)); // check every 15s
    }
    connectRT();
  });

  let _portRetries = 0;
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      if (_portRetries < 6) {
        _portRetries++;
        const delay = _portRetries * 1000;
        console.error(`[crew-lead] Port ${PORT} in use — retry ${_portRetries}/6 in ${delay}ms (waiting for old process to exit)`);
        setTimeout(() => {
          server.close();
          server.listen(PORT, BIND_HOST);
        }, delay);
      } else {
        console.error(`[crew-lead] Port ${PORT} still in use after 6 retries — run: lsof -ti :${PORT} | xargs kill -9`);
        process.exit(1);
      }
    } else {
      console.error("[crew-lead] server error:", err.message);
      process.exit(1);
    }
  });

  return server;
}
