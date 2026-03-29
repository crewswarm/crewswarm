#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const configPath = path.join(os.homedir(), ".crewswarm", "crewswarm.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const agents = Array.isArray(config.agents) ? config.agents : config.agents?.list || [];

function detectRoute(agent) {
  if (agent.useCursorCli) return "cursor";
  if (agent.useClaudeCode) return "claude-code";
  if (agent.useCodex) return "codex";
  if (agent.useGeminiCli) return "gemini-cli";
  if (agent.useCrewCLI) return "crew-cli";
  if (agent.useOpenCode) return "opencode";
  if (agent.useDockerSandbox) return "docker-sandbox";
  return "direct";
}

function modelForRoute(agent, route) {
  if (route === "cursor") return agent.cursorCliModel || "(auto)";
  if (route === "claude-code") return agent.claudeCodeModel || "(auto)";
  if (route === "codex") return agent.codexModel || "(auto)";
  if (route === "gemini-cli") return agent.geminiCliModel || "(auto)";
  if (route === "crew-cli") return agent.crewCliModel || "(default)";
  if (route === "opencode") return agent.opencodeModel || "(default)";
  return agent.model || "(none)";
}

const rows = agents.map((agent) => {
  const route = detectRoute(agent);
  return {
    id: agent.id,
    route,
    model: modelForRoute(agent, route),
    fallback: agent.fallbackModel || agent.opencodeFallbackModel || "",
  };
});

console.log("CrewSwarm live engine matrix");
console.log("");
for (const row of rows) {
  console.log(`${row.id.padEnd(22)} ${row.route.padEnd(15)} ${row.model}${row.fallback ? `  fallback=${row.fallback}` : ""}`);
}

console.log("");
console.log("Next step:");
console.log("Run a real task through each important route and confirm the observed runtime/model in logs or UI.");
