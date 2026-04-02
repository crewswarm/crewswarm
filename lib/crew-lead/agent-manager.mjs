/**
 * Dynamic agent creation and management — extracted from crew-lead.mjs
 * Manages agents in ~/.crewswarm/crewswarm.json.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeAgentTools, writeAgentPrompt } from "../agents/permissions.mjs";
import { getSharedChatPromptOverlay } from "../chat/shared-chat-prompt-overlay.mjs";

function tryRead(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function withSharedChatGuidance(id, body) {
  return `${body}\n\n${getSharedChatPromptOverlay(id)}`;
}

export const AGENT_ROLE_PRESETS = {
  coder: {
    tools: ["read_file", "write_file", "mkdir", "run_cmd", "skill"],
    useOpenCode: false,
    promptTemplate: (id, desc) => withSharedChatGuidance(id, `You are ${id}, a specialist coding agent.\n\nFocus: ${desc || "full-stack development"}\n\nUse @@READ_FILE before modifying files. Always @@WRITE_FILE your output with absolute paths. Report what you did and the full file paths in your reply.`),
  },
  researcher: {
    tools: ["read_file", "web_search", "web_fetch", "skill"],
    useOpenCode: false,
    promptTemplate: (id, desc) => withSharedChatGuidance(id, `You are ${id}, a research specialist.\n\nFocus: ${desc || "deep research and analysis"}\n\nUse @@WEB_SEARCH and @@WEB_FETCH to gather information. Synthesize findings into clear, actionable summaries. Always cite sources.`),
  },
  writer: {
    tools: ["read_file", "write_file", "web_search", "web_fetch", "skill"],
    useOpenCode: false,
    promptTemplate: (id, desc) => withSharedChatGuidance(id, `You are ${id}, a writing specialist.\n\nFocus: ${desc || "technical writing and documentation"}\n\nUse @@WEB_SEARCH for research when needed. Always @@WRITE_FILE your output with absolute paths. Write clear, concise, scannable content.`),
  },
  auditor: {
    tools: ["read_file", "run_cmd", "skill"],
    useOpenCode: false,
    promptTemplate: (id, desc) => withSharedChatGuidance(id, `You are ${id}, an audit and review specialist.\n\nFocus: ${desc || "code review, testing, and quality assurance"}\n\nUse @@READ_FILE to inspect files and @@RUN_CMD for tests. Report issues with specific file paths and line numbers. Never modify files directly.`),
  },
  ops: {
    tools: ["read_file", "write_file", "mkdir", "run_cmd", "git", "skill"],
    useOpenCode: false,
    promptTemplate: (id, desc) => withSharedChatGuidance(id, `You are ${id}, a DevOps and infrastructure specialist.\n\nFocus: ${desc || "deployment, CI/CD, infrastructure, and operations"}\n\nUse @@RUN_CMD for system tasks. Use @@WRITE_FILE for configs and scripts. Report status and any issues.`),
  },
  generalist: {
    tools: ["read_file", "write_file", "mkdir", "run_cmd", "dispatch", "skill"],
    useOpenCode: false,
    promptTemplate: (id, desc) => withSharedChatGuidance(id, `You are ${id}, a generalist agent.\n\nFocus: ${desc || "versatile task execution"}\n\nAdapt to whatever is needed. Use @@READ_FILE, @@WRITE_FILE, @@RUN_CMD as appropriate. You can @@DISPATCH to other agents if a task needs a specialist.`),
  },
};

const MAX_DYNAMIC_AGENTS = Number(process.env.CREWSWARM_MAX_DYNAMIC_AGENTS || "5");

export function createAgent({ id, role, displayName, prompt, description, model }) {
  if (!id) throw new Error("Agent id is required");
  if (!id.startsWith("crew-")) id = `crew-${id}`;

  const swarmPath = path.join(os.homedir(), ".crewswarm", "crewswarm.json");
  const swarm = tryRead(swarmPath) || {};
  if (!Array.isArray(swarm.agents)) swarm.agents = [];

  // Check if agent already exists
  if (swarm.agents.some(a => a.id === id)) {
    throw new Error(`Agent ${id} already exists`);
  }

  // Count dynamic agents (those with _dynamic flag)
  const dynamicCount = swarm.agents.filter(a => a._dynamic).length;
  if (dynamicCount >= MAX_DYNAMIC_AGENTS) {
    throw new Error(`Max dynamic agents (${MAX_DYNAMIC_AGENTS}) reached. Remove an existing dynamic agent first.`);
  }

  const preset = AGENT_ROLE_PRESETS[role] || AGENT_ROLE_PRESETS.generalist;
  const agentModel = model || swarm.agents.find(a => a.id === "crew-main")?.model || "groq/llama-3.3-70b-versatile";

  // OpenCode is opt-in only. Dynamic agents inherit no execution engine unless explicitly assigned.
  const openCodeEnabled = preset.useOpenCode || false;
  const defaultOcModel = (() => {
    const existingCoder = swarm.agents.find(a => a.opencodeModel && a.useOpenCode);
    if (existingCoder) return existingCoder.opencodeModel;
    return process.env.CREWSWARM_OPENCODE_MODEL || "openai/gpt-5.4";
  })();

  const agentEntry = {
    id,
    model: agentModel,
    _dynamic: true,
    _createdAt: new Date().toISOString(),
    _role: role || "generalist",
    useOpenCode: openCodeEnabled,
  };
  if (openCodeEnabled) agentEntry.opencodeModel = defaultOcModel;
  if (displayName) agentEntry.identity = { name: displayName };

  swarm.agents.push(agentEntry);
  fs.writeFileSync(swarmPath, JSON.stringify(swarm, null, 2), "utf8");

  // Set tools
  writeAgentTools(id, preset.tools);

  // Set prompt
  const agentPrompt = prompt || preset.promptTemplate(id, description);
  const bareId = id.replace(/^crew-/, "");
  writeAgentPrompt(bareId, agentPrompt);

  return { id, role: role || "generalist", tools: preset.tools, model: agentModel, displayName, useOpenCode: openCodeEnabled };
}

export function listDynamicAgents() {
  const swarm = tryRead(path.join(os.homedir(), ".crewswarm", "crewswarm.json")) || {};
  return (swarm.agents || []).filter(a => a._dynamic);
}

export function removeDynamicAgent(id) {
  if (!id.startsWith("crew-")) id = `crew-${id}`;
  const swarmPath = path.join(os.homedir(), ".crewswarm", "crewswarm.json");
  const swarm = tryRead(swarmPath) || {};
  if (!Array.isArray(swarm.agents)) return false;
  const idx = swarm.agents.findIndex(a => a.id === id && a._dynamic);
  if (idx < 0) throw new Error(`${id} is not a dynamic agent (or doesn't exist)`);
  swarm.agents.splice(idx, 1);
  fs.writeFileSync(swarmPath, JSON.stringify(swarm, null, 2), "utf8");
  return true;
}
