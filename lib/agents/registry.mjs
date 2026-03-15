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
} from "../runtime/config.mjs";

// ── Config resolver: ~/.crewswarm/config.json first, ~/.openclaw/openclaw.json fallback ──
export function resolveConfig() {
  const paths = [CREWSWARM_CONFIG_PATH, path.join(LEGACY_STATE_DIR, "openclaw.json")];
  for (const p of paths) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
      cfg.__source = p;
      return cfg;
    } catch { /* try next */ }
  }
  return {};
}

/** Load ~/.crewswarm/telegram-bridge.json for @@TELEGRAM (token + default chat). */
export function resolveTelegramBridgeConfig() {
  try {
    return JSON.parse(fs.readFileSync(TELEGRAM_BRIDGE_CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function resolveProviderConfig(cfg, providerKey) {
  const explicit = cfg?.models?.providers?.[providerKey] || cfg?.providers?.[providerKey];
  const builtin  = PROVIDER_REGISTRY[providerKey];
  if (!explicit && !builtin) return null;
  return {
    baseUrl: explicit?.baseUrl || builtin?.baseUrl,
    apiKey:  explicit?.apiKey  || cfg?.env?.[`${providerKey.toUpperCase()}_API_KEY`] || null,
  };
}

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
        const rtId   = "crew-" + bareId;
        if (!map[rtId]) { map[rtId] = bareId; listSet.add(rtId); }
        if (rawId === bareId && !map[bareId]) { map[bareId] = bareId; listSet.add(bareId); }
      }
    } catch {}
  }

  return { list: [...listSet], map };
}

const { list: CREWSWARM_RT_SWARM_AGENTS, map: RT_TO_GATEWAY_AGENT_MAP } = buildAgentMapsFromConfig();
export { CREWSWARM_RT_SWARM_AGENTS, RT_TO_GATEWAY_AGENT_MAP };

// ── Agent list and provider loading ─────────────────────────────────────────
export function loadAgentList() {
  const cfgPath = path.join(os.homedir(), ".crewswarm", "crewswarm.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const agents = Array.isArray(cfg.agents) ? cfg.agents : (cfg.agents?.list || []);
    return agents.length > 0 ? agents : [];
  } catch (e) {
    console.error(`[registry] Failed to load agents from ${cfgPath}: ${e.message}`);
    return [];
  }
}

export function loadProviderMap() {
  const sources = [
    path.join(os.homedir(), ".crewswarm", "crewswarm.json"),
    path.join(os.homedir(), ".crewswarm", "config.json"),
  ];
  const merged = {};
  for (const p of sources) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
      const provs = cfg.providers || cfg.models?.providers || {};
      for (const [k, v] of Object.entries(provs)) {
        if (!merged[k] && v?.apiKey && v?.baseUrl) merged[k] = v;
      }
    } catch {}
  }
  return merged;
}

export function loadAgentLLMConfig(ocAgentId) {
  try {
    const agents = loadAgentList();
    const crewId = ocAgentId.startsWith("crew-") ? ocAgentId : `crew-${ocAgentId}`;
    const bareId = ocAgentId.startsWith("crew-") ? ocAgentId.slice(5) : ocAgentId;
    const agent = agents.find(a => a.id === ocAgentId) ||
                  agents.find(a => a.id === crewId) ||
                  agents.find(a => a.id === bareId);
    if (!agent?.model) return null;

    const [providerKey, ...modelParts] = agent.model.split("/");
    const modelId = modelParts.join("/");
    const providers = loadProviderMap();
    const provider = providers[providerKey];
    if (!provider?.baseUrl || !provider?.apiKey) {
      console.warn(`[bridge] No provider config for "${providerKey}" (agent ${ocAgentId}) — check ~/.crewswarm/config.json providers`);
      return null;
    }

    return { baseUrl: provider.baseUrl, apiKey: provider.apiKey, modelId, agentId: agent.id, providerKey, fallbackModel: agent.fallbackModel || null };
  } catch (e) {
    console.warn(`[bridge] loadAgentLLMConfig error: ${e.message}`);
    return null;
  }
}

/**
 * Load the central loop brain config from crewswarm.json → loopBrain field.
 */
export function loadLoopBrainConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CREWSWARM_CONFIG_PATH, "utf8"));
    const loopBrain = cfg.loopBrain || process.env.CREWSWARM_LOOP_BRAIN || null;
    if (!loopBrain) return null;
    const [providerKey, ...modelParts] = loopBrain.split("/");
    const modelId = modelParts.join("/");
    const providers = loadProviderMap();
    const provider = providers[providerKey];
    if (!provider?.baseUrl || !provider?.apiKey) return null;
    return { baseUrl: provider.baseUrl, apiKey: provider.apiKey, modelId, providerKey };
  } catch { return null; }
}
