/**
 * Agent tool permission helpers — extracted from crew-lead.mjs
 * Reads/writes per-agent tool permissions from crewswarm.json.
 */

import fs   from "fs";
import path from "path";
import os   from "os";

function tryRead(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

export const CREWSWARM_TOOL_NAMES = new Set([
  "write_file","read_file","mkdir","run_cmd","git","dispatch","telegram","web_search","web_fetch","skill","define_skill",
]);

export const AGENT_TOOL_ROLE_DEFAULTS = {
  "crew-qa":          ["read_file"],
  "crew-security":    ["read_file","run_cmd"],
  "crew-coder":       ["write_file","read_file","mkdir","run_cmd"],
  "crew-coder-front": ["write_file","read_file","mkdir","run_cmd"],
  "crew-coder-back":  ["write_file","read_file","mkdir","run_cmd"],
  "crew-frontend":    ["write_file","read_file","mkdir","run_cmd"],
  "crew-fixer":       ["write_file","read_file","mkdir","run_cmd"],
  "crew-github":      ["read_file","run_cmd","git"],
  "crew-copywriter":  ["write_file","read_file","web_search","web_fetch"],
  "crew-main":        ["write_file","read_file","mkdir","run_cmd","dispatch","web_search","web_fetch"],
  "crew-pm":          ["read_file","dispatch"],
  "crew-telegram":    ["telegram","read_file"],
};

export function readAgentTools(agentId) {
  const swarm = tryRead(path.join(os.homedir(), ".crewswarm", "crewswarm.json")) || {};
  const agents = Array.isArray(swarm.agents) ? swarm.agents : [];
  const agent  = agents.find(a => a.id === agentId);
  const explicit = agent?.tools?.crewswarmAllow || agent?.tools?.alsoAllow || null;
  if (explicit) {
    const valid = explicit.filter(t => CREWSWARM_TOOL_NAMES.has(t));
    if (valid.length) return { source: "config", tools: valid };
  }
  const exact = AGENT_TOOL_ROLE_DEFAULTS[agentId];
  if (exact) return { source: "role-default", tools: exact };
  for (const [key, val] of Object.entries(AGENT_TOOL_ROLE_DEFAULTS)) {
    if (agentId.startsWith(key)) return { source: "role-default", tools: val };
  }
  return { source: "fallback", tools: ["read_file","write_file","mkdir","run_cmd"] };
}

export function writeAgentTools(agentId, tools) {
  const valid = tools.filter(t => CREWSWARM_TOOL_NAMES.has(t));
  const swarmPath = path.join(os.homedir(), ".crewswarm", "crewswarm.json");
  const swarm = tryRead(swarmPath) || {};
  if (!Array.isArray(swarm.agents)) swarm.agents = [];
  let agent = swarm.agents.find(a => a.id === agentId);
  if (!agent) {
    agent = { id: agentId };
    swarm.agents.push(agent);
  }
  if (!agent.tools) agent.tools = {};
  agent.tools.crewswarmAllow = valid;
  fs.writeFileSync(swarmPath, JSON.stringify(swarm, null, 2), "utf8");
  return valid;
}

export function getSearchToolsConfig() {
  return tryRead(path.join(os.homedir(), ".crewswarm", "search-tools.json")) || {};
}

export function getAgentPrompts() {
  return tryRead(path.join(os.homedir(), ".crewswarm", "agent-prompts.json")) || {};
}

export function writeAgentPrompt(agentId, promptText) {
  const promptsPath = path.join(os.homedir(), ".crewswarm", "agent-prompts.json");
  const prompts = getAgentPrompts();
  prompts[agentId] = promptText;
  fs.writeFileSync(promptsPath, JSON.stringify(prompts, null, 2), "utf8");
  return promptText;
}
