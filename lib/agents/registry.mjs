/**
 * Agent registry — buildAgentMapsFromConfig, config resolvers, agent list/model loading.
 * Extracted from gateway-bridge.mjs.
 * Dependencies: fs, path, os, lib/agent-registry.mjs, lib/runtime/config.mjs
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  BUILT_IN_RT_AGENTS,
  RT_TO_GATEWAY_AGENT_MAP as REGISTRY_RT_TO_GATEWAY_AGENT_MAP,
} from "../agent-registry.mjs";
import {
  CREWSWARM_CONFIG_PATH,
  LEGACY_STATE_DIR,
  TELEGRAM_BRIDGE_CONFIG_PATH,
  PROVIDER_REGISTRY,
  resolveConfig,
  resolveTelegramBridgeConfig,
  resolveProviderConfig,
  loadProviderMap,
  loadAgentLLMConfig,
  loadLoopBrainConfig,
} from "../runtime/config.mjs";

export {
  resolveConfig,
  resolveTelegramBridgeConfig,
  resolveProviderConfig,
  loadProviderMap,
  loadAgentLLMConfig,
  loadLoopBrainConfig,
};



// ── Agent map builder ───────────────────────────────────────────────────────
export function buildAgentMapsFromConfig() {
  const BUILT_IN_MAP = { ...REGISTRY_RT_TO_GATEWAY_AGENT_MAP };

  if (process.env.CREWSWARM_RT_SWARM_AGENTS) {
    const list = process.env.CREWSWARM_RT_SWARM_AGENTS.split(",").map(s => s.trim()).filter(Boolean);
    const map = {};
    for (const a of list) map[a] = BUILT_IN_MAP[a] || a.replace(/^crew-/, "");
    return { list, map };
  }

  const map = { ...BUILT_IN_MAP };
  const listSet = new Set(BUILT_IN_RT_AGENTS);

  const cfgSources = [
    path.join(os.homedir(), ".crewswarm", "crewswarm.json"),
    path.join(os.homedir(), ".openclaw", "openclaw.json"),
  ];

  for (const cfgPath of cfgSources) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      const cfgAgents = Array.isArray(cfg.agents) ? cfg.agents
        : Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];

      for (const agent of cfgAgents) {
        const rawId = agent.id;
        const bareId = rawId.replace(/^crew-/, "");
        const rtId = "crew-" + bareId;
        if (!map[rtId]) { map[rtId] = bareId; listSet.add(rtId); }
        if (rawId === bareId && !map[bareId]) { map[bareId] = bareId; listSet.add(bareId); }
      }
    } catch { }
  }

  return { list: [...listSet], map };
}

const { list: CREWSWARM_RT_SWARM_AGENTS, map: RT_TO_GATEWAY_AGENT_MAP } = buildAgentMapsFromConfig();
export { CREWSWARM_RT_SWARM_AGENTS, RT_TO_GATEWAY_AGENT_MAP };

// Use centralized loadAgentList from config.mjs
import { loadAgentList } from "../runtime/config.mjs";
export { loadAgentList };
