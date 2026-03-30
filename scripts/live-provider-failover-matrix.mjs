#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const jsonMode = process.argv.includes("--json");
const configPath = path.join(os.homedir(), ".crewswarm", "crewswarm.json");

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

const cfg = readConfig();
const providers = cfg.providers || {};
const agents = Array.isArray(cfg.agents) ? cfg.agents : cfg.agents?.list || [];

const activeProviders = Object.entries(providers)
  .filter(([, value]) => value?.apiKey && String(value.apiKey).trim())
  .map(([id, value]) => ({
    id,
    hasBaseUrl: Boolean(value.baseUrl),
  }));

const interestingAgents = agents
  .filter((agent) => {
    return (
      agent.id === "crew-main" ||
      agent.id === "crew-coder" ||
      agent.id === "crew-qa" ||
      agent.id === "crew-pm" ||
      agent.useClaudeCode ||
      agent.useCodex ||
      agent.useGeminiCli ||
      agent.useCrewCLI ||
      agent.useCursorCli
    );
  })
  .map((agent) => ({
    id: agent.id,
    primary: agent.model || "(none)",
    fallback: agent.fallbackModel || agent.opencodeFallbackModel || "",
    route:
      agent.useClaudeCode ? "claude-code" :
      agent.useCodex ? "codex" :
      agent.useGeminiCli ? "gemini-cli" :
      agent.useCrewCLI ? "crew-cli" :
      agent.useCursorCli ? "cursor" :
      agent.useOpenCode ? "opencode" :
      "direct",
  }));

const payload = {
  configPath,
  configuredProviders: activeProviders,
  agents: interestingAgents,
  checklist: [
    "1. Run `npm run restart-all` and confirm `node scripts/health-check.mjs` passes.",
    "2. For each important route, trigger one real task and confirm the observed runtime/model in logs or UI.",
    "3. Intentionally disable or exhaust one primary provider, then confirm fallback activates.",
    "4. Record which routes fail closed vs. fail over successfully.",
  ],
  sampleTasks: [
    'crew-main: "say: PROVIDER_FAILOVER_OK"',
    'crew-coder: "Create test-output/provider-fallback.txt with one line: PROVIDER_FALLBACK_OK"',
    'crew-qa: "Summarize which provider/model you are using in one line"',
  ],
};

if (jsonMode) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

console.log("CrewSwarm live provider/failover matrix");
console.log("");
console.log(`Config: ${configPath}`);
console.log("");
console.log("Configured providers:");
if (!activeProviders.length) {
  console.log("  (none)");
} else {
  for (const provider of activeProviders) {
    console.log(`  - ${provider.id}${provider.hasBaseUrl ? " (custom baseUrl)" : ""}`);
  }
}
console.log("");
console.log("Interesting agents/routes:");
for (const agent of interestingAgents) {
  console.log(
    `  - ${agent.id}: route=${agent.route} primary=${agent.primary}${agent.fallback ? ` fallback=${agent.fallback}` : ""}`,
  );
}
console.log("");
console.log("Checklist:");
for (const item of payload.checklist) {
  console.log(`  ${item}`);
}
console.log("");
console.log("Sample tasks:");
for (const item of payload.sampleTasks) {
  console.log(`  - ${item}`);
}
