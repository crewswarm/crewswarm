#!/usr/bin/env node
/**
 * sync-agents.mjs
 * Reads ~/.crewswarm/crewswarm.json and regenerates the agent table
 * in memory/orchestration-protocol.md + memory/current-state.md
 *
 * Run manually: node scripts/sync-agents.mjs
 * Or hook into dashboard agent save actions.
 */

import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const CREWSWARM_CONFIG = path.join(homedir(), ".crewswarm", "crewswarm.json");
const OPENCLAW_CONFIG  = path.join(homedir(), ".openclaw", "openclaw.json");   // legacy fallback
const AGENT_PROMPTS    = path.join(homedir(), ".crewswarm", "agent-prompts.json");
const PROTOCOL_FILE   = new URL("../memory/orchestration-protocol.md", import.meta.url).pathname;
const STATE_FILE      = new URL("../memory/current-state.md", import.meta.url).pathname;

// Role descriptions — extend this as you add new agents
const ROLE_META = {
  "main":         { emoji: "🦊", label: "Coordination",            best: "Chat, triage, fallback, dispatch" },
  "pm":           { emoji: "📋", label: "Planning",                 best: "Break requirements into phased tasks" },
  "coder":        { emoji: "⚡", label: "Implementation",           best: "General code, files, shell commands" },
  "coder-front":  { emoji: "🎨", label: "Frontend specialist",      best: "HTML, CSS, JS, UI, design system" },
  "coder-back":   { emoji: "🔧", label: "Backend specialist",       best: "APIs, DBs, server-side logic" },
  "copywriter":   { emoji: "✍️", label: "Copywriting",              best: "Headlines, CTAs, product copy" },
  "qa":           { emoji: "🔬", label: "Quality assurance",        best: "Tests, validation, audits" },
  "fixer":        { emoji: "🐛", label: "Bug fixing",               best: "Debug failures, patch QA issues" },
  "github":       { emoji: "🐙", label: "Git operations",           best: "Commits, PRs, branches, push" },
  "frontend":     { emoji: "🖥️", label: "Frontend (alt)",           best: "UI implementation" },
  "security":     { emoji: "🛡️", label: "Security review",          best: "Vulnerability audits, hardening" },
  "lead":         { emoji: "🧠", label: "Crew Lead",                best: "Top-level coordinator, user-facing chat" },
  "orchestrator": { emoji: "🎯", label: "Orchestrator",             best: "Internal pipeline routing" },
  "seo":          { emoji: "📈", label: "SEO specialist",           best: "Metadata, keywords, site structure" },
  "ml":           { emoji: "🧮", label: "Machine learning",         best: "Models, data pipelines, training" },
  "mega":         { emoji: "🔥", label: "Polymarket strategy",      best: "Prediction market AI, backtesting" },
  "researcher":   { emoji: "🔍", label: "Research",                 best: "Web search, fact-finding, reports" },
  "architect":    { emoji: "🏗️", label: "Architecture",             best: "System design, ADRs, tech decisions" },
  "telegram":     { emoji: "💬", label: "Telegram",                 best: "Send messages via Telegram bridge" },
  "db-migrator":  { emoji: "🗄️", label: "DB migrations",            best: "Schema changes, migrations, seeds" },
};

function normalizeId(id) {
  // Strip crew- prefix to get the bare role key used in ROLE_META
  return (id || "").replace(/^crew-/, "");
}

function getAgentName(id) {
  // IDs in crewswarm.json already carry the crew- prefix; preserve them as-is.
  // Only add crew- prefix for legacy bare IDs that don't have it yet.
  return (id || "").startsWith("crew-") ? id : `crew-${id}`;
}

async function loadAgents() {
  for (const cfgPath of [CREWSWARM_CONFIG, OPENCLAW_CONFIG]) {
    try {
      const raw = await readFile(cfgPath, "utf8");
      const cfg = JSON.parse(raw);
      const list = cfg.agents?.list || (Array.isArray(cfg.agents) ? cfg.agents : []);
      if (list.length === 0) continue;
      return list.map(a => ({
        id:    a.id || "?",
        model: a.model || "unknown",
        name:  getAgentName(a.id || ""),
        meta:  ROLE_META[normalizeId(a.id)] || { emoji: "🤖", label: a.id, best: "General tasks" },
      }));
    } catch {}
  }
  console.error("Could not load agent list from ~/.crewswarm/crewswarm.json (or ~/.openclaw/openclaw.json legacy fallback)");
  return [];
}

function buildAgentTable(agents) {
  const header = `| Agent | Role | Best for |
|-------|------|----------|`;
  const rows = agents.map(a =>
    `| \`${a.name}\` | ${a.meta.emoji} ${a.meta.label} | ${a.meta.best} |`
  );
  return [header, ...rows].join("\n");
}

function buildAgentList(agents) {
  return agents.map(a =>
    `- \`${a.name}\` — ${a.meta.label}: ${a.meta.best}`
  ).join("\n");
}

const AGENT_TABLE_START = "<!-- AGENT_TABLE_START -->";
const AGENT_TABLE_END   = "<!-- AGENT_TABLE_END -->";

async function updateFile(filePath, table, list) {
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    console.log(`Skipping ${filePath} (not found)`);
    return;
  }

  // Replace between markers if they exist
  if (content.includes(AGENT_TABLE_START)) {
    const before = content.split(AGENT_TABLE_START)[0];
    const after  = content.split(AGENT_TABLE_END)[1] || "";
    content = `${before}${AGENT_TABLE_START}\n${table}\n${AGENT_TABLE_END}${after}`;
  }

  await writeFile(filePath, content, "utf8");
  console.log(`✅ Updated: ${filePath}`);
}

async function main() {
  const agents = await loadAgents();
  if (!agents.length) {
    console.error("No agents found — check ~/.crewswarm/crewswarm.json");
    process.exit(1);
  }

  console.log(`Found ${agents.length} agents: ${agents.map(a => a.name).join(", ")}`);
  const table = buildAgentTable(agents);
  const list  = buildAgentList(agents);

  console.log("\nAgent table:\n" + table + "\n");

  await updateFile(PROTOCOL_FILE, table, list);
  await updateFile(STATE_FILE, table, list);

  // Also write a standalone agents.md for quick reference
  const agentsMd = new URL("../memory/agents.md", import.meta.url).pathname;
  const agentsContent = `# Live Agent Registry
> Auto-generated by \`scripts/sync-agents.mjs\` — do not edit manually.
> Run \`node scripts/sync-agents.mjs\` after adding/removing agents.

Last updated: ${new Date().toISOString()}

## Dispatch command
\`\`\`bash
node ~/Desktop/CrewSwarm/gateway-bridge.mjs --send <agent-name> "<task>"
\`\`\`

## Available agents
${table}

## Model assignments
${agents.map(a => `- \`${a.name}\` → \`${a.model}\``).join("\n")}
`;
  await writeFile(agentsMd, agentsContent, "utf8");
  console.log(`✅ Written: ${agentsMd}`);
}

main().catch(console.error);
