#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _callLLMOnce } from "../lib/crew-lead/llm-caller.mjs";

const jsonMode = process.argv.includes("--json");
const smokeMode = process.argv.includes("--smoke");
const configPath = path.join(os.homedir(), ".crewswarm", "crewswarm.json");
const SMOKE_PROMPT = "Reply with exactly PROVIDER_MATRIX_OK and nothing else.";

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

function modelFromConfig(providerId, providerCfg, agents) {
  const directModel = String(
    providerCfg?.defaultModel || providerCfg?.model || providerCfg?.chatModel || "",
  ).trim();
  if (directModel) return directModel;

  const prefixMap = {
    google: ["google/", "gemini"],
    anthropic: ["anthropic/", "claude"],
    openai: ["openai/", "gpt-"],
    xai: ["xai/", "grok"],
    deepseek: ["deepseek/", "deepseek"],
    groq: ["groq/", "llama", "mixtral", "qwen", "kimi", "compound"],
    mistral: ["mistral/", "mistral"],
    perplexity: ["perplexity/", "sonar"],
    nvidia: ["nvidia/", "meta/", "google/", "deepseek-ai/"],
    cerebras: ["cerebras/"],
    openrouter: ["openrouter/"],
    fireworks: ["fireworks/", "accounts/fireworks/"],
    opencode: [],
    "openai-local": ["openai-local/"],
  };
  const prefixes = prefixMap[providerId] || [];
  const found = agents.find((agent) => {
    const model = String(agent?.model || "").toLowerCase();
    return prefixes.some((prefix) => model.startsWith(prefix) || model.includes(prefix));
  });
  if (found?.model) return String(found.model);

  const firstListed = providerCfg?.models?.[0]?.id;
  if (firstListed) return String(firstListed);

  const hardcoded = {
    google: "gemini-2.5-flash",
    anthropic: "claude-3-5-haiku-latest",
    openai: "gpt-4o-mini",
    xai: "grok-4.1-fast",
    deepseek: "deepseek-chat",
    groq: "llama-3.1-8b-instant",
    mistral: "mistral-small-latest",
    perplexity: "sonar",
    nvidia: "meta/llama-3.1-8b-instruct",
    cerebras: "llama-3.3-70b",
    openrouter: "meta-llama/llama-3.1-8b-instruct:free",
    fireworks: "accounts/fireworks/models/gpt-oss-20b",
    opencode: "gpt-5.4-mini",
    "openai-local": "gpt-4o-mini",
  };
  return hardcoded[providerId] || "(unknown)";
}

function normalizeModel(providerId, modelId, providerCfg) {
  const raw = String(modelId || "").trim();
  if (!raw) return raw;

  const prefixStrips = {
    google: [/^google\/models\//i, /^google\//i],
    anthropic: [/^anthropic\//i],
    openai: [/^openai\//i],
    xai: [/^xai\//i],
    deepseek: [/^deepseek\//i],
    perplexity: [/^perplexity\//i],
    openrouter: [/^openrouter\//i],
    fireworks: [/^fireworks\//i],
  };

  let normalized = raw;
  for (const pattern of prefixStrips[providerId] || []) {
    normalized = normalized.replace(pattern, "");
  }

  if (providerId === "google" && normalized.startsWith("models/")) {
    normalized = normalized.replace(/^models\//i, "");
  }

  const listed = Array.isArray(providerCfg?.models)
    ? providerCfg.models.map((entry) => String(entry?.id || "").trim()).filter(Boolean)
    : [];
  if (listed.includes(normalized)) return normalized;
  if (listed.includes(raw)) return raw;

  if (
    providerId === "nvidia" &&
    listed.length > 0 &&
    (normalized.includes("gemini") || normalized.includes("grok") || normalized.includes("claude"))
  ) {
    return listed[0];
  }

  return normalized;
}

function mapProviderKey(providerId) {
  if (providerId === "google") return "google";
  if (providerId === "xai") return "xai";
  return providerId;
}

async function smokeProvider(providerId, providerCfg, modelId) {
  const messages = [{ role: "user", content: SMOKE_PROMPT }];
  const started = Date.now();
  try {
    const reply = await _callLLMOnce(
      providerCfg.baseUrl,
      providerCfg.apiKey,
      modelId,
      mapProviderKey(providerId),
      messages,
      { stream: false },
    );
    const text = String(reply || "").trim();
    return {
      ok: text.includes("PROVIDER_MATRIX_OK"),
      reply: text.slice(0, 120),
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error),
      durationMs: Date.now() - started,
    };
  }
}

const cfg = readConfig();
const providers = cfg.providers || {};
const agents = Array.isArray(cfg.agents) ? cfg.agents : cfg.agents?.list || [];

const configuredProviders = Object.entries(providers)
  .filter(([, value]) => value?.apiKey && value?.baseUrl)
  .map(([id, value]) => ({
    id,
    baseUrl: value.baseUrl,
    model: normalizeModel(id, modelFromConfig(id, value, agents), value),
    listedModels: Array.isArray(value.models) ? value.models.length : 0,
  }));

const results = [];
if (smokeMode) {
  for (const provider of configuredProviders) {
    const providerCfg = providers[provider.id];
    results.push({
      provider: provider.id,
      model: provider.model,
      ...(await smokeProvider(provider.id, providerCfg, provider.model)),
    });
  }
}

const payload = {
  configPath,
  smokeMode,
  providers: configuredProviders,
  results,
  checklist: [
    "Use `node scripts/live-provider-matrix.mjs --smoke` to run one tiny real call per configured provider.",
    "Use `node scripts/live-provider-failover-matrix.mjs` to inspect route/fallback expectations.",
    "Treat failures as wiring, auth, quota, or model-selection issues to investigate before release.",
  ],
};

if (jsonMode) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

console.log("CrewSwarm live provider matrix");
console.log("");
for (const provider of configuredProviders) {
  console.log(
    `${provider.id.padEnd(14)} model=${provider.model}${provider.listedModels ? `  listedModels=${provider.listedModels}` : ""}`,
  );
}

if (smokeMode) {
  console.log("");
  console.log("Smoke results:");
  for (const result of results) {
    const status = result.ok ? "PASS" : "FAIL";
    const detail = result.ok ? result.reply : result.error;
    console.log(`${status.padEnd(5)} ${result.provider.padEnd(14)} ${result.model}  ${detail}`);
  }
} else {
  console.log("");
  console.log("Run with --smoke to send one tiny real request through each configured provider.");
}
