#!/usr/bin/env node
/**
 * CrewSwarm MCP Server
 *
 * Exposes the entire CrewSwarm fleet as MCP tools — 100% dynamic.
 * Every agent and every skill discovered at runtime becomes a callable tool.
 *
 * Compatible with: Cursor, Claude Code CLI, OpenCode, Claude Desktop
 *
 * Transports:
 *   HTTP (default)  — point your MCP client at http://localhost:5020/mcp
 *   stdio           — node scripts/mcp-server.mjs --stdio
 *
 * Usage:
 *   node scripts/mcp-server.mjs            # HTTP on :5020
 *   node scripts/mcp-server.mjs --port 5021
 *   node scripts/mcp-server.mjs --stdio    # for Claude Desktop / Claude Code
 *
 * Cursor .cursor/mcp.json:
 *   { "crewswarm": { "url": "http://localhost:5020/mcp" } }
 *
 * Claude Code (~/.claude/mcp.json or via --mcp-config):
 *   { "crewswarm": { "type": "http", "url": "http://localhost:5020/mcp" } }
 */

import http from "http";
import fs   from "fs";
import path from "path";
import os   from "os";

// ── Config ────────────────────────────────────────────────────────────────────
const CREW_LEAD_URL = process.env.CREW_LEAD_URL || "http://127.0.0.1:5010";
const PORT          = parseInt(process.env.MCP_PORT || "5020");
const SKILLS_DIR    = path.join(os.homedir(), ".crewswarm", "skills");
const CONFIG_PATH   = path.join(os.homedir(), ".crewswarm", "config.json");
const CREWSWARM_CFG = path.join(os.homedir(), ".crewswarm", "crewswarm.json");
const STDIO_MODE    = process.argv.includes("--stdio");

function getAuthToken() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))?.rt?.authToken || ""; } catch { return ""; }
}

function crewHeaders() {
  const token = getAuthToken();
  return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

// ── Dynamic agent list ────────────────────────────────────────────────────────
function loadAgents() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CREWSWARM_CFG, "utf8"));
    return (cfg.agents || []).map(a => ({
      id:    a.id,
      name:  a.identity?.name  || a.name  || a.id,
      emoji: a.identity?.emoji || a.emoji || "",
      role:  a.identity?.theme || a._role || "",
      model: a.model || "",
    }));
  } catch { return []; }
}

// ── Dynamic skill list ────────────────────────────────────────────────────────
function loadSkills() {
  const skills = [];
  if (!fs.existsSync(SKILLS_DIR)) return skills;
  try {
    for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        try {
          const def = JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, entry.name), "utf8"));
          skills.push({ name: entry.name.replace(".json",""), description: def.description || "", type: "json" });
        } catch {}
      }
      if (entry.isDirectory()) {
        const md = path.join(SKILLS_DIR, entry.name, "SKILL.md");
        if (fs.existsSync(md)) {
          const raw = fs.readFileSync(md, "utf8");
          const descMatch = raw.match(/^description:\s*(.+)$/m);
          skills.push({ name: entry.name, description: descMatch?.[1]?.trim() || "", type: "skill-md" });
        }
      }
    }
  } catch {}
  return skills;
}

// ── MCP tool definitions ──────────────────────────────────────────────────────
function buildToolList() {
  const agents = loadAgents();
  const skills = loadSkills();

  const tools = [
    // ── Core tools ────────────────────────────────────────────────────────────
    {
      name: "dispatch_agent",
      description: [
        "Send a task to any specialist agent in the CrewSwarm fleet and wait for the result.",
        "Use this when you need a specialist: security audit, complex code refactor, QA testing, PM planning, copywriting, data analysis.",
        "Each agent runs its own LLM (may be different from yours) with a specialized system prompt.",
        "Rate-limited on your main account? Route through CrewSwarm agents running on Groq, Mistral, DeepSeek, or local Ollama.",
        "",
        `Available agents: ${agents.map(a => `${a.emoji} ${a.name} (${a.id}${a.role ? " · " + a.role : ""})`).join(", ")}`,
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          agent: {
            type: "string",
            description: `Agent ID to dispatch to. Options: ${agents.map(a => a.id).join(", ")}`,
            enum: agents.map(a => a.id),
          },
          task: {
            type: "string",
            description: "The task for the agent. Be specific — include file paths, requirements, and context.",
          },
          timeout_seconds: {
            type: "number",
            description: "Max seconds to wait for agent reply (default 90, max 300)",
            default: 90,
          },
        },
        required: ["agent", "task"],
      },
    },
    {
      name: "list_agents",
      description: "List all available CrewSwarm agents with their specialties, models, and current status.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "run_pipeline",
      description: [
        "Run a multi-agent pipeline where each stage passes output to the next.",
        "Use for complex multi-step work: plan → code → test → review.",
        "Stages run sequentially; each stage's reply is injected as context into the next.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          stages: {
            type: "array",
            description: "Pipeline stages to run in order",
            items: {
              type: "object",
              properties: {
                agent: { type: "string", description: "Agent ID for this stage" },
                task:  { type: "string", description: "Task for this agent" },
              },
              required: ["agent", "task"],
            },
          },
        },
        required: ["stages"],
      },
    },
    {
      name: "chat_stinki",
      description: [
        "Talk directly to Stinki (crew-lead) — the CrewSwarm commander.",
        "Use for: roadmap questions, dispatching complex multi-agent workflows, asking about the codebase, getting Stinki to coordinate the crew.",
        "Stinki can read files, search the web, dispatch agents, and roast you if you're being stupid.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "Your message to Stinki" },
        },
        required: ["message"],
      },
    },
    {
      name: "crewswarm_status",
      description: "Get live status of all CrewSwarm agents — which are running, their models, and recent task telemetry.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "smart_dispatch",
      description: [
        "Analyze a task and get a multi-agent breakdown BEFORE executing — returns the proposed plan without firing anything.",
        "Use this when you're unsure how to break down a complex task. Returns score (1-5), suggested agents, and step-by-step breakdown.",
        "After reviewing the plan, call run_pipeline with the returned stages to execute, or call dispatch_agent for a single agent.",
        "Example: smart_dispatch('build auth system with JWT') → { score: 4, agents: ['crew-pm','crew-coder-back','crew-qa'], breakdown: ['plan spec','build endpoints','write tests'] }",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "The task to analyze and break down into a multi-agent plan",
          },
        },
        required: ["task"],
      },
    },
  ];

  // ── One tool per skill ─────────────────────────────────────────────────────
  for (const skill of skills) {
    tools.push({
      name: `skill_${skill.name.replace(/[^a-zA-Z0-9_]/g, "_")}`,
      description: `Run CrewSwarm skill: ${skill.name}. ${skill.description}`,
      inputSchema: {
        type: "object",
        properties: {
          params: {
            type: "object",
            description: "Parameters to pass to the skill",
            additionalProperties: true,
          },
        },
      },
    });
  }

  return tools;
}

// ── Tool execution ────────────────────────────────────────────────────────────
async function callTool(name, args) {
  // dispatch_agent — dispatch and poll for result
  if (name === "dispatch_agent") {
    const { agent, task, timeout_seconds = 90 } = args;
    const maxMs = Math.min((timeout_seconds || 90) * 1000, 300_000);
    try {
      // Dispatch
      const dispatchRes = await fetch(`${CREW_LEAD_URL}/api/dispatch`, {
        method: "POST",
        headers: crewHeaders(),
        body: JSON.stringify({ agent, task }),
        signal: AbortSignal.timeout(10_000),
      });
      const dispatched = await dispatchRes.json();
      if (!dispatched.ok && !dispatched.taskId) {
        return { error: dispatched.error || "Dispatch failed" };
      }
      const taskId = dispatched.taskId;

      // Poll for result
      const start = Date.now();
      while (Date.now() - start < maxMs) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const statusRes = await fetch(`${CREW_LEAD_URL}/api/status/${taskId}`, {
            headers: crewHeaders(), signal: AbortSignal.timeout(5_000),
          });
          const status = await statusRes.json();
          if (status.status === "completed" || status.reply) {
            return {
              agent,
              task_id: taskId,
              status: "completed",
              reply: status.reply || status.result || "(no reply)",
              model: status.model || "",
              elapsed_ms: Date.now() - start,
            };
          }
          if (status.status === "failed" || status.error) {
            return { agent, task_id: taskId, status: "failed", error: status.error || "Task failed" };
          }
        } catch {}
      }
      return { agent, task_id: taskId, status: "timeout", error: `Agent did not respond within ${timeout_seconds}s. Task is still running — check dashboard.` };
    } catch (e) {
      return { error: `crew-lead unreachable: ${e.message}` };
    }
  }

  // list_agents
  if (name === "list_agents") {
    try {
      const res = await fetch(`${CREW_LEAD_URL}/api/agents`, { headers: crewHeaders(), signal: AbortSignal.timeout(8_000) });
      const d = await res.json();
      const agents = (d.agents || loadAgents()).map(a => ({
        id:     a.id,
        name:   a.identity?.name || a.name || a.id,
        emoji:  a.identity?.emoji || a.emoji || "",
        model:  a.model || "",
        online: a.online ?? a.alive ?? null,
        tools:  a.tools || [],
      }));
      return { agents, count: agents.length };
    } catch (e) {
      return { agents: loadAgents(), note: "crew-lead offline — showing config data only" };
    }
  }

  // crewswarm_status
  if (name === "crewswarm_status") {
    try {
      const res = await fetch(`${CREW_LEAD_URL}/api/health`, { headers: crewHeaders(), signal: AbortSignal.timeout(8_000) });
      const d = await res.json();
      return {
        ok: d.ok,
        agents_online: (d.agents || []).filter(a => a.online || a.alive).length,
        agents_total: (d.agents || []).length,
        agents: (d.agents || []).map(a => ({
          id: a.id,
          name: a.identity?.name || a.name || a.id,
          online: a.online ?? a.alive ?? false,
          model: a.model || "",
        })),
        telemetry_recent: (d.telemetry || []).slice(-5),
      };
    } catch (e) {
      return { error: `crew-lead unreachable: ${e.message}`, note: "Is CrewSwarm running? Try: npm run restart-all" };
    }
  }

  // chat_stinki
  if (name === "chat_stinki") {
    const { message } = args;
    try {
      const res = await fetch(`${CREW_LEAD_URL}/chat`, {
        method: "POST",
        headers: crewHeaders(),
        body: JSON.stringify({ message, sessionId: "mcp" }),
        signal: AbortSignal.timeout(120_000),
      });
      const d = await res.json();
      return { reply: d.reply || d.message || d.text || JSON.stringify(d) };
    } catch (e) {
      return { error: `crew-lead unreachable: ${e.message}` };
    }
  }

  // run_pipeline
  if (name === "run_pipeline") {
    const { stages } = args;
    if (!Array.isArray(stages) || !stages.length) return { error: "stages must be a non-empty array" };
    const results = [];
    let previousOutput = "";
    for (const stage of stages) {
      const task = previousOutput
        ? `${stage.task}\n\n[Previous step output]:\n${previousOutput.slice(0, 2000)}`
        : stage.task;
      const result = await callTool("dispatch_agent", { agent: stage.agent, task, timeout_seconds: 120 });
      results.push({ agent: stage.agent, ...result });
      previousOutput = result.reply || result.error || "";
      if (result.status === "failed" || result.error) break;
    }
    return { stages_run: results.length, stages_total: stages.length, results };
  }

  // smart_dispatch — get breakdown plan without executing
  if (name === "smart_dispatch") {
    const { task } = args;
    if (!task) return { error: "task is required" };
    try {
      const res = await fetch(`${CREW_LEAD_URL}/api/classify`, {
        method: "POST",
        headers: crewHeaders(),
        body: JSON.stringify({ task }),
        signal: AbortSignal.timeout(10_000),
      });
      const plan = await res.json();
      if (!plan.ok) return { error: plan.error || "classify failed" };

      const { score, reason, agents = [], breakdown = [], skipped } = plan;
      const complexity = score <= 2 ? "simple" : score === 3 ? "moderate" : "complex";

      // Build ready-to-use pipeline stages from the breakdown
      const pipeline_stages = agents.length > 0 && breakdown.length > 0
        ? breakdown.map((step, i) => ({ agent: agents[i] || agents[agents.length - 1], task: step }))
        : [];

      return {
        score,
        complexity,
        reason,
        agents,
        breakdown,
        skipped: skipped || false,
        pipeline_stages,
        next_steps: score >= 4
          ? `Call run_pipeline with pipeline_stages to execute, or customize the stages first.`
          : score >= 3
          ? `Call dispatch_agent("${agents[0] || "crew-coder"}", task) to execute.`
          : `Simple task — call dispatch_agent or handle directly.`,
      };
    } catch (e) {
      return { error: `classify failed: ${e.message}` };
    }
  }

  // skill_* tools
  if (name.startsWith("skill_")) {
    const skillName = name.replace(/^skill_/, "").replace(/_/g, "-");
    const { params = {} } = args;
    try {
      const res = await fetch(`${CREW_LEAD_URL}/api/skill/${encodeURIComponent(skillName)}`, {
        method: "POST",
        headers: crewHeaders(),
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(30_000),
      });
      const d = await res.json();
      return d;
    } catch (e) {
      return { error: `Skill ${skillName} failed: ${e.message}` };
    }
  }

  return { error: `Unknown tool: ${name}` };
}

// ── MCP message handler ───────────────────────────────────────────────────────
async function handleMcpMessage(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "crewswarm", version: "1.0.0", description: "CrewSwarm multi-agent fleet as MCP tools" },
      },
    };
  }

  if (method === "notifications/initialized" || method === "initialized") {
    return null; // no response needed
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0", id,
      result: { tools: buildToolList() },
    };
  }

  if (method === "tools/call") {
    const { name, arguments: toolArgs = {} } = params || {};
    try {
      const result = await callTool(name, toolArgs);
      return {
        jsonrpc: "2.0", id,
        result: {
          content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
          isError: !!(result?.error),
        },
      };
    } catch (e) {
      return {
        jsonrpc: "2.0", id,
        result: { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true },
      };
    }
  }

  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  return {
    jsonrpc: "2.0", id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

// ── stdio transport (Claude Desktop / Claude Code) ────────────────────────────
if (STDIO_MODE) {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async chunk => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const resp = await handleMcpMessage(msg);
        if (resp) process.stdout.write(JSON.stringify(resp) + "\n");
      } catch (e) {
        process.stdout.write(JSON.stringify({ jsonrpc:"2.0", id:null, error:{ code:-32700, message:"Parse error" } }) + "\n");
      }
    }
  });
  process.stderr.write(`[crewswarm-mcp] stdio transport ready\n`);
  process.stdin.on("end", () => process.exit(0));

} else {
  // ── HTTP transport ──────────────────────────────────────────────────────────
  const server = http.createServer(async (req, res) => {
    const corsHeaders = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
    };

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);

    // Health check
    if (url.pathname === "/health" || url.pathname === "/") {
      res.writeHead(200, { "content-type": "application/json", ...corsHeaders });
      res.end(JSON.stringify({ ok: true, server: "crewswarm-mcp", version: "1.0.0", agents: loadAgents().length, skills: loadSkills().length }));
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404, corsHeaders);
      res.end("not found");
      return;
    }

    if (req.method === "GET") {
      // SSE endpoint for Cursor / streamable HTTP clients
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
        ...corsHeaders,
      });
      res.write("event: endpoint\ndata: " + JSON.stringify({ uri: `http://localhost:${PORT}/mcp`, protocolVersion: "2024-11-05" }) + "\n\n");
      req.on("close", () => {});
      return;
    }

    if (req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      res.writeHead(200, { "content-type": "application/json", ...corsHeaders });
      try {
        const msg = JSON.parse(body);
        const resp = await handleMcpMessage(msg);
        res.end(resp ? JSON.stringify(resp) : "{}");
      } catch (e) {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: " + e.message } }));
      }
      return;
    }

    res.writeHead(405, corsHeaders);
    res.end("method not allowed");
  });

  server.listen(PORT, "127.0.0.1", () => {
    const agents = loadAgents();
    const skills = loadSkills();
    console.log(`\n🔌 CrewSwarm MCP Server`);
    console.log(`${"─".repeat(50)}`);
    console.log(`  HTTP endpoint : http://127.0.0.1:${PORT}/mcp`);
    console.log(`  Health check  : http://127.0.0.1:${PORT}/health`);
    console.log(`  Agents        : ${agents.length} (${agents.map(a => (a.emoji || "") + a.name).join(", ")})`);
    console.log(`  Skills        : ${skills.length} (${skills.map(s => s.name).join(", ")})`);
    console.log(`${"─".repeat(50)}`);
    console.log(`\nCursor .cursor/mcp.json:`);
    console.log(`  { "crewswarm": { "url": "http://127.0.0.1:${PORT}/mcp" } }`);
    console.log(`\nClaude Code stdio:`);
    console.log(`  node scripts/mcp-server.mjs --stdio`);
    console.log(`\nOpenCode mcp config:`);
    console.log(`  { "mcpServers": { "crewswarm": { "type": "http", "url": "http://127.0.0.1:${PORT}/mcp" } } }`);
    console.log();
  });
}
