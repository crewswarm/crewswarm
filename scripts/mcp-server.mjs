#!/usr/bin/env node
/**
 * crewswarm MCP Server
 *
 * Exposes the entire crewswarm fleet as MCP tools — 100% dynamic.
 * Every agent and every skill discovered at runtime becomes a callable tool.
 *
 * Compatible with: Cursor, Claude Code CLI, OpenCode, Claude Desktop,
 *                  Open WebUI, LM Studio, Aider, Continue.dev, any OpenAI-compatible tool
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
import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import {
  listProjectsWithMessages,
  loadProjectMessages,
  saveProjectMessage,
} from "../lib/chat/project-messages.mjs";
import { detectMentions } from "../lib/chat/autonomous-mentions.mjs";

// ── Config ────────────────────────────────────────────────────────────────────
const CREW_LEAD_URL = process.env.CREW_LEAD_URL || "http://127.0.0.1:5010";
const PORT = parseInt(process.env.MCP_PORT || "5020");
const SKILLS_DIR = path.join(os.homedir(), ".crewswarm", "skills");
const CONFIG_PATH = path.join(os.homedir(), ".crewswarm", "config.json");
const CREWSWARM_CFG = path.join(os.homedir(), ".crewswarm", "crewswarm.json");
const STDIO_MODE = process.argv.includes("--stdio");

function getAuthToken() {
  try {
    return (
      JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))?.rt?.authToken || ""
    );
  } catch {
    return "";
  }
}

function crewHeaders() {
  const token = getAuthToken();
  return {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function extractMessageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part) return "";
        if (!part.type || part.type === "text") return String(part.text || "");
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function normalizeOpenAIMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((m) => ({
      role: String(m?.role || "")
        .trim()
        .toLowerCase(),
      text: extractMessageText(m?.content).trim(),
    }))
    .filter((m) => m.role && m.text);
}

function composeChatPayloadFromOpenAI(
  messages,
  { maxContextChars = 12000 } = {},
) {
  const normalized = normalizeOpenAIMessages(messages);
  const system = normalized
    .filter((m) => m.role === "system")
    .map((m) => m.text);
  const assistant = normalized
    .filter((m) => m.role === "assistant")
    .map((m) => m.text);
  const users = normalized.filter((m) => m.role === "user");
  const lastUser = users.at(-1)?.text || "";
  const priorUsers = users.slice(0, -1).map((m) => m.text);
  const toolResults = normalized
    .filter((m) => m.role === "tool")
    .map((m) => m.text);
  const historyTail = [...priorUsers, ...assistant].slice(-10);

  const sections = [];
  if (system.length > 0)
    sections.push(`SYSTEM INSTRUCTIONS:\n${system.join("\n\n")}`);
  if (historyTail.length > 0)
    sections.push(`RECENT CONTEXT:\n${historyTail.join("\n\n")}`);
  let context = sections.join("\n\n");
  if (context.length > maxContextChars)
    context = context.slice(context.length - maxContextChars);
  if (toolResults.length > 0)
    context += `${context ? "\n\n" : ""}TOOL RESULTS:\n${toolResults.join("\n\n")}`;

  const inputChars = normalized.reduce((sum, m) => sum + m.text.length, 0);
  return {
    message: lastUser,
    context,
    messageCounts: {
      system: system.length,
      assistant: assistant.length,
      user: users.length,
      total: normalized.length,
    },
    inputChars,
  };
}

function loadPipelineMetricsSummary(baseDir = process.cwd()) {
  const file = path.join(baseDir, ".crew", "pipeline-metrics.jsonl");
  try {
    if (!fs.existsSync(file)) {
      return {
        runs: 0,
        qaApproved: 0,
        qaRejected: 0,
        qaRoundsTotal: 0,
        contextChunksUsed: 0,
        contextCharsSaved: 0,
      };
    }
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    let runs = 0;
    let qaApproved = 0;
    let qaRejected = 0;
    let qaRoundsTotal = 0;
    let contextChunksUsed = 0;
    let contextCharsSaved = 0;
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        runs += 1;
        if (rec.qaApproved === true) qaApproved += 1;
        if (rec.qaApproved === false) qaRejected += 1;
        qaRoundsTotal += Number(rec.qaRounds || 0);
        contextChunksUsed += Number(rec.contextChunksUsed || 0);
        contextCharsSaved += Number(rec.contextCharsSaved || 0);
      } catch {
        // ignore malformed rows
      }
    }
    return {
      runs,
      qaApproved,
      qaRejected,
      qaRoundsTotal,
      contextChunksUsed,
      contextCharsSaved,
    };
  } catch {
    return {
      runs: 0,
      qaApproved: 0,
      qaRejected: 0,
      qaRoundsTotal: 0,
      contextChunksUsed: 0,
      contextCharsSaved: 0,
    };
  }
}

function selectToolCallName(payload, userMessage) {
  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  if (tools.length === 0) return null;
  const names = tools
    .map((t) => String(t?.function?.name || "").trim())
    .filter(Boolean);
  if (names.length === 0) return null;

  const choice = payload?.tool_choice;
  if (choice === "none") return null;
  if (choice && typeof choice === "object") {
    const forced = String(choice?.function?.name || "").trim();
    if (forced && names.includes(forced)) return forced;
  }
  if (choice === "required") return names[0];
  if (choice && choice !== "auto") return null;

  const lower = String(userMessage || "").toLowerCase();
  const likelyAction =
    /\b(build|implement|write|create|edit|refactor|fix|change|update|run|test|analyze)\b/.test(
      lower,
    );
  return likelyAction ? names[0] : null;
}

function buildToolCallResponse({ model, stream, toolName, task }) {
  const completionId = `chatcmpl-${Date.now().toString(36)}`;
  const ts = Math.floor(Date.now() / 1000);
  const toolCall = {
    id: `call_${Date.now().toString(36)}`,
    type: "function",
    function: {
      name: toolName,
      arguments: JSON.stringify({ task: String(task || "") }),
    },
  };

  if (stream) {
    return {
      streamChunks: [
        {
          id: completionId,
          object: "chat.completion.chunk",
          created: ts,
          model,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", tool_calls: [toolCall] },
              finish_reason: null,
            },
          ],
        },
        {
          id: completionId,
          object: "chat.completion.chunk",
          created: ts,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        },
      ],
    };
  }

  return {
    json: {
      id: completionId,
      object: "chat.completion",
      created: ts,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "", tool_calls: [toolCall] },
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        prompt_tokens: Math.ceil(String(task || "").length / 4),
        completion_tokens: 1,
        total_tokens: Math.ceil(String(task || "").length / 4) + 1,
      },
    },
  };
}

// ── Dynamic agent list ────────────────────────────────────────────────────────
function loadAgents() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CREWSWARM_CFG, "utf8"));
    return (cfg.agents || []).map((a) => ({
      id: a.id,
      name: a.identity?.name || a.name || a.id,
      emoji: a.identity?.emoji || a.emoji || "",
      role: a.identity?.theme || a._role || "",
      model: a.model || "",
    }));
  } catch {
    return [];
  }
}

// ── Dynamic skill list ────────────────────────────────────────────────────────
function loadSkills() {
  const skills = [];
  if (!fs.existsSync(SKILLS_DIR)) return skills;
  try {
    for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        try {
          const def = JSON.parse(
            fs.readFileSync(path.join(SKILLS_DIR, entry.name), "utf8"),
          );
          skills.push({
            name: entry.name.replace(".json", ""),
            description: def.description || "",
            type: "json",
          });
        } catch {}
      }
      if (entry.isDirectory()) {
        const md = path.join(SKILLS_DIR, entry.name, "SKILL.md");
        if (fs.existsSync(md)) {
          const raw = fs.readFileSync(md, "utf8");
          const descMatch = raw.match(/^description:\s*(.+)$/m);
          skills.push({
            name: entry.name,
            description: descMatch?.[1]?.trim() || "",
            type: "skill-md",
          });
        }
      }
    }
  } catch {}
  return skills;
}

// ── GitNexus MCP Bridge (external MCP server integration) ─────────────────────
let gitnexusProcess = null;
let gitnexusTools = [];
let gitnexusReady = false;
const GITNEXUS_ENABLED = /^(1|true|yes|on)$/i.test(
  String(process.env.CREWSWARM_GITNEXUS_ENABLED || ""),
);

async function initGitNexusBridge() {
  if (!GITNEXUS_ENABLED) return false;
  // Check if GitNexus is installed and has indexed repos
  try {
    const { execSync } = await import("child_process");
    const statusOutput = execSync("npx gitnexus list 2>/dev/null", {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });

    // If no repos indexed, skip
    if (!statusOutput || statusOutput.includes("No repositories indexed")) {
      return false;
    }

    // Start GitNexus MCP server in stdio mode
    gitnexusProcess = spawn("npx", ["gitnexus", "mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let initBuffer = "";

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.error("[GitNexus] MCP bridge timeout - continuing without it");
        gitnexusProcess?.kill();
        gitnexusProcess = null;
        resolve(false);
      }, 5000);

      gitnexusProcess.stdout.on("data", (chunk) => {
        initBuffer += chunk.toString();
        const lines = initBuffer.split("\n");
        initBuffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            // Handle initialize response to get tools/list
            if (msg.id === "init" && msg.result) {
              clearTimeout(timeout);
              // Now request tools list
              sendGitNexusMessage({
                jsonrpc: "2.0",
                id: "tools-list",
                method: "tools/list",
              })
                .then((resp) => {
                  if (resp.result?.tools) {
                    gitnexusTools = resp.result.tools.map((t) => ({
                      ...t,
                      name: `gitnexus_${t.name}`,
                      description: `[GitNexus] ${t.description}`,
                    }));
                    gitnexusReady = true;
                    console.log(
                      `[GitNexus] MCP bridge ready - ${gitnexusTools.length} tools available`,
                    );
                    resolve(true);
                  }
                })
                .catch(() => resolve(false));
            }
          } catch {}
        }
      });

      gitnexusProcess.stderr.on("data", (chunk) => {
        // Ignore stderr noise during init
      });

      gitnexusProcess.on("exit", () => {
        gitnexusProcess = null;
        gitnexusReady = false;
      });

      // Send initialize request
      gitnexusProcess.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "init",
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "crewswarm-mcp-bridge", version: "1.0.0" },
          },
        }) + "\n",
      );
    });
  } catch (e) {
    return false;
  }
}

function sendGitNexusMessage(msg) {
  return new Promise((resolve, reject) => {
    if (!gitnexusProcess || !gitnexusReady) {
      reject(new Error("GitNexus MCP not ready"));
      return;
    }

    let buffer = "";
    const listener = (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const resp = JSON.parse(line);
          if (resp.id === msg.id) {
            gitnexusProcess.stdout.off("data", listener);
            resolve(resp);
            return;
          }
        } catch {}
      }
    };

    gitnexusProcess.stdout.on("data", listener);
    gitnexusProcess.stdin.write(JSON.stringify(msg) + "\n");

    // Timeout after 30s
    setTimeout(() => {
      gitnexusProcess.stdout.off("data", listener);
      reject(new Error("GitNexus MCP call timeout"));
    }, 30000);
  });
}

async function callGitNexusTool(toolName, args) {
  const actualToolName = toolName.replace("gitnexus_", "");
  try {
    const resp = await sendGitNexusMessage({
      jsonrpc: "2.0",
      id: `call-${Date.now()}`,
      method: "tools/call",
      params: { name: actualToolName, arguments: args },
    });

    if (resp.result) {
      return resp.result;
    }
    if (resp.error) {
      return { error: resp.error.message || "GitNexus tool call failed" };
    }
    return { error: "Unknown GitNexus error" };
  } catch (e) {
    return { error: `GitNexus bridge error: ${e.message}` };
  }
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
        "Send a task to any specialist agent in the crewswarm fleet and wait for the result.",
        "Use this when you need a specialist: security audit, complex code refactor, QA testing, PM planning, copywriting, data analysis.",
        "Each agent runs its own LLM (may be different from yours) with a specialized system prompt.",
        "Rate-limited on your main account? Route through crewswarm agents running on Groq, Mistral, DeepSeek, or local Ollama.",
        "",
        `Available agents: ${agents.map((a) => `${a.emoji} ${a.name} (${a.id}${a.role ? " · " + a.role : ""})`).join(", ")}`,
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          agent: {
            type: "string",
            description: `Agent ID to dispatch to. Options: ${agents.map((a) => a.id).join(", ")}`,
            enum: agents.map((a) => a.id),
          },
          task: {
            type: "string",
            description:
              "The task for the agent. Be specific — include file paths, requirements, and context.",
          },
          timeout_seconds: {
            type: "number",
            description:
              "Max seconds to wait for agent reply (default 90, max 300)",
            default: 90,
          },
        },
        required: ["agent", "task"],
      },
    },
    {
      name: "list_agents",
      description:
        "List all available crewswarm agents with their specialties, models, and current status.",
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
                agent: {
                  type: "string",
                  description: "Agent ID for this stage",
                },
                task: { type: "string", description: "Task for this agent" },
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
        "Talk directly to Stinki (crew-lead) — the crewswarm commander.",
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
      description:
        "Get live status of all crewswarm agents — which are running, their models, and recent task telemetry.",
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
            description:
              "The task to analyze and break down into a multi-agent plan",
          },
        },
        required: ["task"],
      },
    },
    {
      name: "pipeline_metrics",
      description:
        "Return aggregated pipeline QA/context metrics from .crew/pipeline-metrics.jsonl.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "chat_send",
      description:
        "Write a message into the shared crewswarm channel history without dispatching work. Use this for real channel participation.",
      inputSchema: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            description: "Channel/project id. Defaults to general.",
            default: "general",
          },
          content: {
            type: "string",
            description: "Message content to post into the channel.",
          },
          actor: {
            type: "string",
            description: "Agent/client name to attribute the message to.",
            default: "mcp",
          },
          threadId: {
            type: "string",
            description:
              "Optional shared thread id for replying in an existing thread.",
          },
          parentId: {
            type: "string",
            description: "Optional parent message id for reply linkage.",
          },
        },
        required: ["content"],
      },
    },
    {
      name: "chat_read",
      description:
        "Read recent shared channel messages from crewswarm history.",
      inputSchema: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            description: "Channel/project id. Defaults to general.",
            default: "general",
          },
          limit: {
            type: "number",
            description: "Maximum number of recent messages to return.",
            default: 20,
          },
          threadId: {
            type: "string",
            description: "Only return messages from a specific shared thread.",
          },
          mentionsFor: {
            type: "string",
            description:
              "Only return messages that explicitly mention this agent/client id.",
          },
          since: {
            type: "number",
            description: "Only return messages at or after this unix ms timestamp.",
          },
        },
      },
    },
    {
      name: "chat_channels",
      description:
        "List known shared channels/projects with recent activity.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "chat_who",
      description:
        "Show recent participants in a shared channel based on message history.",
      inputSchema: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            description: "Channel/project id. Defaults to general.",
            default: "general",
          },
        },
      },
    },
  ];

  // ── One tool per skill ─────────────────────────────────────────────────────
  for (const skill of skills) {
    tools.push({
      name: `skill_${skill.name.replace(/[^a-zA-Z0-9_]/g, "_")}`,
      description: `Run crewswarm skill: ${skill.name}. ${skill.description}`,
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

  // ── GitNexus MCP bridge tools ──────────────────────────────────────────────
  if (gitnexusReady && gitnexusTools.length > 0) {
    tools.push(...gitnexusTools);
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
        body: JSON.stringify({ agent, task, source: "mcp", via: "mcp-tool" }),
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
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const statusRes = await fetch(
            `${CREW_LEAD_URL}/api/status/${taskId}`,
            {
              headers: crewHeaders(),
              signal: AbortSignal.timeout(5_000),
            },
          );
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
            return {
              agent,
              task_id: taskId,
              status: "failed",
              error: status.error || "Task failed",
            };
          }
        } catch {}
      }
      return {
        agent,
        task_id: taskId,
        status: "timeout",
        error: `Agent did not respond within ${timeout_seconds}s. Task is still running — check dashboard.`,
      };
    } catch (e) {
      return { error: `crew-lead unreachable: ${e.message}` };
    }
  }

  // list_agents
  if (name === "list_agents") {
    try {
      const res = await fetch(`${CREW_LEAD_URL}/api/agents`, {
        headers: crewHeaders(),
        signal: AbortSignal.timeout(8_000),
      });
      const d = await res.json();
      const agents = (d.agents || loadAgents()).map((a) => ({
        id: a.id,
        name: a.identity?.name || a.name || a.id,
        emoji: a.identity?.emoji || a.emoji || "",
        model: a.model || "",
        online: a.online ?? a.alive ?? null,
        tools: a.tools || [],
      }));
      return { agents, count: agents.length };
    } catch (e) {
      return {
        agents: loadAgents(),
        note: "crew-lead offline — showing config data only",
      };
    }
  }

  // crewswarm_status
  if (name === "crewswarm_status") {
    try {
      const res = await fetch(`${CREW_LEAD_URL}/api/health`, {
        headers: crewHeaders(),
        signal: AbortSignal.timeout(8_000),
      });
      const d = await res.json();
      return {
        ok: d.ok,
        agents_online: (d.agents || []).filter((a) => a.online || a.alive)
          .length,
        agents_total: (d.agents || []).length,
        agents: (d.agents || []).map((a) => ({
          id: a.id,
          name: a.identity?.name || a.name || a.id,
          online: a.online ?? a.alive ?? false,
          model: a.model || "",
        })),
        telemetry_recent: (d.telemetry || []).slice(-5),
      };
    } catch (e) {
      return {
        error: `crew-lead unreachable: ${e.message}`,
        note: "Is crewswarm running? Try: npm run restart-all",
      };
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
    if (!Array.isArray(stages) || !stages.length)
      return { error: "stages must be a non-empty array" };
    const results = [];
    let previousOutput = "";
    for (const stage of stages) {
      const task = previousOutput
        ? `${stage.task}\n\n[Previous step output]:\n${previousOutput.slice(0, 2000)}`
        : stage.task;
      const result = await callTool("dispatch_agent", {
        agent: stage.agent,
        task,
        timeout_seconds: 120,
      });
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
      const complexity =
        score <= 2 ? "simple" : score === 3 ? "moderate" : "complex";

      // Build ready-to-use pipeline stages from the breakdown
      const pipeline_stages =
        agents.length > 0 && breakdown.length > 0
          ? breakdown.map((step, i) => ({
              agent: agents[i] || agents[agents.length - 1],
              task: step,
            }))
          : [];

      return {
        score,
        complexity,
        reason,
        agents,
        breakdown,
        skipped: skipped || false,
        pipeline_stages,
        next_steps:
          score >= 4
            ? `Call run_pipeline with pipeline_stages to execute, or customize the stages first.`
            : score >= 3
              ? `Call dispatch_agent("${agents[0] || "crew-coder"}", task) to execute.`
              : `Simple task — call dispatch_agent or handle directly.`,
      };
    } catch (e) {
      return { error: `classify failed: ${e.message}` };
    }
  }

  if (name === "pipeline_metrics") {
    const metrics = loadPipelineMetricsSummary(process.cwd());
    const avgRounds =
      metrics.runs > 0 ? metrics.qaRoundsTotal / metrics.runs : 0;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ...metrics,
              qaRoundsAvg: Number(avgRounds.toFixed(2)),
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (name === "chat_send") {
    const channel = String(args.channel || "general").trim() || "general";
    const actor = String(args.actor || "mcp").trim() || "mcp";
    const content = String(args.content || "").trim();
    const threadId = String(args.threadId || "").trim() || null;
    const parentId = String(args.parentId || "").trim() || null;
    if (!content) return { error: "content is required" };
    const mentions = detectMentions(content);
    const id = saveProjectMessage(channel, {
      source: "agent",
      role: "assistant",
      content,
      agent: actor,
      threadId,
      parentId,
      metadata: {
        agentName: actor,
        via: "mcp",
        channel,
        ...(mentions.length ? { mentions } : {}),
      },
    });
    return { ok: true, channel, id, actor, threadId, parentId, mentions };
  }

  if (name === "chat_read") {
    const channel = String(args.channel || "general").trim() || "general";
    const limit = Math.max(1, Math.min(Number(args.limit || 20), 200));
    const threadId = String(args.threadId || "").trim() || null;
    const mentionsFor = String(args.mentionsFor || "").trim() || null;
    const since = Number(args.since || 0) || null;
    const messages = loadProjectMessages(channel, {
      limit,
      ...(threadId && { threadId }),
      ...(mentionsFor && { mentionedAgent: mentionsFor }),
      ...(since ? { since } : {}),
    }).map((msg) => ({
      id: msg.id,
      ts: msg.ts,
      source: msg.source,
      role: msg.role,
      content: msg.content,
      agent: msg.agent,
      threadId: msg.threadId || null,
      parentId: msg.parentId || null,
      mentions: msg.metadata?.mentions || [],
    }));
    return {
      ok: true,
      channel,
      count: messages.length,
      threadId,
      mentionsFor,
      messages,
    };
  }

  if (name === "chat_channels") {
    const projects = listProjectsWithMessages();
    const channels = [
      { channel: "general", lastActivity: null, messageCount: 0 },
      ...projects.map((project) => ({
        channel: project.projectId,
        lastActivity: project.lastActivity,
        messageCount: project.messageCount,
      })),
    ].filter(
      (entry, index, arr) =>
        arr.findIndex((candidate) => candidate.channel === entry.channel) === index,
    );
    return { ok: true, channels };
  }

  if (name === "chat_who") {
    const channel = String(args.channel || "general").trim() || "general";
    const messages = loadProjectMessages(channel, { limit: 100 });
    const participants = new Map();
    for (const msg of messages) {
      const name =
        msg.metadata?.agentName ||
        msg.agent ||
        (msg.role === "user" ? "user" : msg.source || "assistant");
      participants.set(name, {
        name,
        source: msg.source,
        lastTs: msg.ts,
      });
    }
    return {
      ok: true,
      channel,
      participants: [...participants.values()].sort((a, b) => b.lastTs - a.lastTs),
    };
  }

  // skill_* tools
  if (name.startsWith("skill_")) {
    const skillName = name.replace(/^skill_/, "").replace(/_/g, "-");
    const { params = {} } = args;
    try {
      const res = await fetch(
        `${CREW_LEAD_URL}/api/skill/${encodeURIComponent(skillName)}`,
        {
          method: "POST",
          headers: crewHeaders(),
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(30_000),
        },
      );
      const d = await res.json();
      return d;
    } catch (e) {
      return { error: `Skill ${skillName} failed: ${e.message}` };
    }
  }

  // gitnexus_* tools (MCP bridge)
  if (name.startsWith("gitnexus_")) {
    if (!gitnexusReady) {
      return {
        error: "GitNexus not available",
        note: "GitNexus MCP bridge is not running. Run 'npx gitnexus analyze' to index the current repo, then restart the MCP server.",
      };
    }
    return await callGitNexusTool(name, args);
  }

  return { error: `Unknown tool: ${name}` };
}

// ── MCP message handler ───────────────────────────────────────────────────────
async function handleMcpMessage(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name: "crewswarm",
          version: "1.0.0",
          description: "crewswarm multi-agent fleet as MCP tools",
        },
      },
    };
  }

  if (method === "notifications/initialized" || method === "initialized") {
    // Notification - no response required
    return { _skip: true };
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: buildToolList() },
    };
  }

  if (method === "tools/call") {
    const { name, arguments: toolArgs = {} } = params || {};
    try {
      const result = await callTool(name, toolArgs);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text:
                typeof result === "string"
                  ? result
                  : JSON.stringify(result, null, 2),
            },
          ],
          isError: !!result?.error,
        },
      };
    } catch (e) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          isError: true,
        },
      };
    }
  }

  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

// ── stdio transport (Claude Desktop / Claude Code) ────────────────────────────
if (STDIO_MODE) {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk) => {
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
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          }) + "\n",
        );
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
      const metrics = loadPipelineMetricsSummary(process.cwd());
      const qaRoundsAvg =
        metrics.runs > 0
          ? Number((metrics.qaRoundsTotal / metrics.runs).toFixed(2))
          : 0;
      res.writeHead(200, {
        "content-type": "application/json",
        ...corsHeaders,
      });
      res.end(
        JSON.stringify({
          ok: true,
          server: "crewswarm-mcp",
          version: "1.0.0",
          agents: loadAgents().length,
          skills: loadSkills().length,
          pipeline: {
            runs: metrics.runs,
            qaApproved: metrics.qaApproved,
            qaRejected: metrics.qaRejected,
            qaRoundsAvg,
            contextChunksUsed: metrics.contextChunksUsed,
            contextCharsSavedEst: metrics.contextCharsSaved,
          },
        }),
      );
      return;
    }

    // ── OpenAI-compatible API (/v1/*) ──────────────────────────────────────────
    // Lets any tool with a "custom base URL" setting (Open WebUI, LM Studio,
    // Aider, Continue.dev, Cursor, etc.) use crewswarm agents as models.
    // Set base URL to http://127.0.0.1:5020 — each agent appears as a model.

    if (url.pathname === "/v1/models") {
      const agents = loadAgents();
      const models = [
        // crew-lead (Stinki) — the general-purpose commander
        {
          id: "crewswarm",
          object: "model",
          created: 1700000000,
          owned_by: "crewswarm",
          description: "🧠 Stinki — crew-lead, general purpose commander",
          capabilities: ["chat", "coordination", "dispatch"],
          mode: "chat",
        },
        // One model per agent
        ...agents.map((a) => ({
          id: a.id,
          object: "model",
          created: 1700000000,
          owned_by: "crewswarm",
          description: `${a.emoji || ""} ${a.name} — ${a.role || a.id}`.trim(),
          capabilities: ["dispatch", "tools"],
          mode: "agent",
        })),
      ];
      res.writeHead(200, {
        "content-type": "application/json",
        ...corsHeaders,
      });
      res.end(JSON.stringify({ object: "list", data: models }));
      return;
    }

    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400, {
          "content-type": "application/json",
          ...corsHeaders,
        });
        res.end(
          JSON.stringify({
            error: { message: "Invalid JSON", type: "invalid_request_error" },
          }),
        );
        return;
      }

      const {
        model = "crewswarm",
        messages = [],
        stream = false,
        temperature,
        top_p,
        max_tokens,
        tool_choice,
        tools,
      } = payload;

      const composed = composeChatPayloadFromOpenAI(messages);
      const task = composed.message;
      const contextPack = composed.context;

      if (!task) {
        res.writeHead(400, {
          "content-type": "application/json",
          ...corsHeaders,
        });
        res.end(
          JSON.stringify({
            error: {
              message: "No user message found",
              type: "invalid_request_error",
            },
          }),
        );
        return;
      }

      const selectedTool = selectToolCallName({ tools, tool_choice }, task);
      if (selectedTool) {
        const toolResponse = buildToolCallResponse({
          model,
          stream: Boolean(stream),
          toolName: selectedTool,
          task,
        });
        if (toolResponse.streamChunks) {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            ...corsHeaders,
          });
          for (const chunk of toolResponse.streamChunks) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.writeHead(200, {
          "content-type": "application/json",
          ...corsHeaders,
        });
        res.end(JSON.stringify(toolResponse.json));
        return;
      }

      const startedAt = Date.now();
      const runMeta = {
        source: "openai-wrapper",
        clientModel: model,
        temperature,
        top_p,
        max_tokens,
        hasTools: Array.isArray(tools) && tools.length > 0,
      };

      // Route: "crewswarm" / "crew-lead" → /chat  |  anything else → dispatch
      const isChatRoute = model === "crewswarm" || model === "crew-lead";
      let reply = "";
      try {
        if (isChatRoute) {
          const chatMessage = contextPack ? `${contextPack}\n\n${task}` : task;
          const r = await fetch(`${CREW_LEAD_URL}/chat`, {
            method: "POST",
            headers: crewHeaders(),
            body: JSON.stringify({
              message: chatMessage,
              context: contextPack,
              sessionId: `openai-compat-${Date.now()}`,
              metadata: runMeta,
            }),
            signal: AbortSignal.timeout(120_000),
          });
          const d = await r.json();
          reply = d.reply || d.message || "(no reply)";
        } else {
          const taskWithContext = contextPack
            ? `${task}\n\n${contextPack}`
            : task;
          const r = await fetch(`${CREW_LEAD_URL}/api/dispatch`, {
            method: "POST",
            headers: crewHeaders(),
            body: JSON.stringify({
              agent: model,
              task: taskWithContext,
              context: contextPack,
              source: "openai-wrapper",
              clientModel: model,
              sessionId: `openai-compat-${Date.now()}`,
              metadata: runMeta,
            }),
            signal: AbortSignal.timeout(10_000),
          });
          const dispatched = await r.json();
          const taskId = dispatched.taskId;
          if (!taskId) throw new Error(dispatched.error || "dispatch failed");

          // Poll for result (90s max)
          const start = Date.now();
          while (Date.now() - start < 90_000) {
            await new Promise((r) => setTimeout(r, 2000));
            const sr = await fetch(`${CREW_LEAD_URL}/api/status/${taskId}`, {
              headers: crewHeaders(),
              signal: AbortSignal.timeout(5_000),
            });
            const s = await sr.json();
            if (s.status === "completed" || s.reply) {
              reply = s.reply || s.result || "(done)";
              break;
            }
            if (s.status === "failed") {
              reply = `Error: ${s.error || "task failed"}`;
              break;
            }
          }
          if (!reply)
            reply = `Task dispatched to ${model} (taskId: ${taskId}) — timed out waiting for reply.`;
        }
      } catch (e) {
        reply = `Error: ${e.message}`;
      }

      console.log(
        `[openai-wrapper] model=${model} stream=${Boolean(stream)} route=${isChatRoute ? "chat" : "dispatch"} ` +
          `msgs=${composed.messageCounts.total} (sys:${composed.messageCounts.system},asst:${composed.messageCounts.assistant},usr:${composed.messageCounts.user}) ` +
          `contextChars=${contextPack.length} latencyMs=${Date.now() - startedAt}`,
      );

      const completionId = `chatcmpl-${Date.now().toString(36)}`;
      const ts = Math.floor(Date.now() / 1000);

      if (stream) {
        // Streaming response — send as a single chunk then [DONE]
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          ...corsHeaders,
        });
        const chunk = {
          id: completionId,
          object: "chat.completion.chunk",
          created: ts,
          model,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: reply },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        const done = {
          id: completionId,
          object: "chat.completion.chunk",
          created: ts,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        };
        res.write(`data: ${JSON.stringify(done)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.writeHead(200, {
          "content-type": "application/json",
          ...corsHeaders,
        });
        res.end(
          JSON.stringify({
            id: completionId,
            object: "chat.completion",
            created: ts,
            model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: reply },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: Math.ceil(composed.inputChars / 4),
              completion_tokens: Math.ceil(reply.length / 4),
              total_tokens: Math.ceil((composed.inputChars + reply.length) / 4),
            },
          }),
        );
      }
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
        connection: "keep-alive",
        ...corsHeaders,
      });
      res.write(
        "event: endpoint\ndata: " +
          JSON.stringify({
            uri: `http://localhost:${PORT}/mcp`,
            protocolVersion: "2024-11-05",
          }) +
          "\n\n",
      );
      req.on("close", () => {});
      return;
    }

    if (req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      res.writeHead(200, {
        "content-type": "application/json",
        ...corsHeaders,
      });
      try {
        const msg = JSON.parse(body);
        const resp = await handleMcpMessage(msg);
        if (resp && !resp._skip) {
          res.end(JSON.stringify(resp));
        } else {
          res.end(); // No response for notifications
        }
      } catch (e) {
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error: " + e.message },
          }),
        );
      }
      return;
    }

    res.writeHead(405, corsHeaders);
    res.end("method not allowed");
  });

  server.listen(PORT, "127.0.0.1", async () => {
    const agents = loadAgents();
    const skills = loadSkills();

    console.log(`\n🔌 crewswarm MCP Server`);
    console.log(`${"─".repeat(50)}`);
    console.log(`  HTTP endpoint : http://127.0.0.1:${PORT}/mcp`);
    console.log(`  Health check  : http://127.0.0.1:${PORT}/health`);
    console.log(
      `  Agents        : ${agents.length} (${agents.map((a) => (a.emoji || "") + a.name).join(", ")})`,
    );
    console.log(
      `  Skills        : ${skills.length} (${skills.map((s) => s.name).join(", ")})`,
    );

    // Initialize GitNexus MCP bridge (opt-in, async, non-blocking)
    if (GITNEXUS_ENABLED) {
      console.log(`  GitNexus      : checking...`);
      const gnReady = await initGitNexusBridge();
      if (gnReady) {
        console.log(
          `  GitNexus      : ✅ ${gitnexusTools.length} tools available`,
        );
      } else {
        console.log(
          `  GitNexus      : ⏭️  not indexed (run 'npx gitnexus analyze' to enable)`,
        );
      }
    } else {
      console.log(
        `  GitNexus      : off (set CREWSWARM_GITNEXUS_ENABLED=1 to enable)`,
      );
    }

    console.log(`${"─".repeat(50)}`);
    console.log(`\nMCP clients (Cursor / Claude Code / OpenCode):`);
    console.log(
      `  Cursor .cursor/mcp.json:  { "crewswarm": { "url": "http://127.0.0.1:${PORT}/mcp" } }`,
    );
    console.log(
      `  Claude Code stdio:        node scripts/mcp-server.mjs --stdio`,
    );
    console.log(
      `  OpenCode:                 { "mcpServers": { "crewswarm": { "type": "http", "url": "http://127.0.0.1:${PORT}/mcp" } } }`,
    );
    console.log(
      `\nOpenAI-compatible API (Open WebUI / LM Studio / Aider / Continue.dev):`,
    );
    console.log(`  Base URL : http://127.0.0.1:${PORT}/v1`);
    console.log(
      `  API key  : (any string — uses crewswarm auth token internally)`,
    );
    console.log(
      `  Models   : GET http://127.0.0.1:${PORT}/v1/models   (one per agent)`,
    );
    console.log(
      `  Chat     : POST http://127.0.0.1:${PORT}/v1/chat/completions`,
    );
    console.log();
  });
}
