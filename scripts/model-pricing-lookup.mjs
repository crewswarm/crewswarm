#!/usr/bin/env node
/**
 * Look up pricing for models across your configured providers.
 * Reads ~/.crewswarm/crewswarm.json and cross-references with known pricing.
 *
 * Run: node scripts/model-pricing-lookup.mjs
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const CREWSWARM = join(process.env.HOME || "", ".crewswarm", "crewswarm.json");

// Pricing: output $/1M tokens. Source: OpenCode Zen docs, Groq console, provider APIs (Feb 2026)
const PRICING = {
  // OpenCode Zen (opencode/...)
  "opencode/big-pickle": { in: 0, out: 0, provider: "OpenCode Zen" },
  "opencode/gpt-5-nano": { in: 0, out: 0, provider: "OpenCode Zen" },
  "opencode/minimax-m2.1-free": { in: 0, out: 0, provider: "OpenCode Zen" },
  "opencode/kimi-k2.5-free": { in: 0, out: 0, provider: "OpenCode Zen" },
  "opencode/glm-4.7-free": { in: 0, out: 0, provider: "OpenCode Zen" },
  "opencode/gpt-5.1-codex-mini": { in: 0.25, out: 2, provider: "OpenCode Zen" },
  "opencode/minimax-m2.1": { in: 0.3, out: 1.2, provider: "OpenCode Zen" },
  "opencode/minimax-m2.5": { in: 0.3, out: 1.2, provider: "OpenCode Zen" },
  "opencode/minimax-m2.5-free": { in: 0, out: 0, provider: "OpenCode Zen" },
  "opencode/kimi-k2": { in: 0.4, out: 2.5, provider: "OpenCode Zen" },
  "opencode/kimi-k2-thinking": { in: 0.4, out: 2.5, provider: "OpenCode Zen" },
  "opencode/gemini-3-flash": { in: 0.5, out: 3, provider: "OpenCode Zen" },
  "opencode/kimi-k2.5": { in: 0.6, out: 3, provider: "OpenCode Zen" },
  "opencode/glm-4.6": { in: 0.6, out: 2.2, provider: "OpenCode Zen" },
  "opencode/glm-4.7": { in: 0.6, out: 2.2, provider: "OpenCode Zen" },
  "opencode/claude-haiku-4-5": { in: 1, out: 5, provider: "OpenCode Zen" },
  "opencode/claude-3-5-haiku": { in: 0.8, out: 4, provider: "OpenCode Zen" },
  "opencode/gpt-5": { in: 1.07, out: 8.5, provider: "OpenCode Zen" },
  "opencode/gpt-5-codex": { in: 1.07, out: 8.5, provider: "OpenCode Zen" },
  "opencode/gpt-5.1": { in: 1.07, out: 8.5, provider: "OpenCode Zen" },
  "opencode/gpt-5.1-codex": { in: 1.07, out: 8.5, provider: "OpenCode Zen" },
  "opencode/gpt-5.1-codex-max": { in: 1.25, out: 10, provider: "OpenCode Zen" },
  "opencode/gpt-5.2": { in: 1.75, out: 14, provider: "OpenCode Zen" },
  "opencode/gpt-5.2-codex": { in: 1.75, out: 14, provider: "OpenCode Zen" },
  "opencode/claude-sonnet-4": { in: 3, out: 15, provider: "OpenCode Zen" },
  "opencode/claude-sonnet-4-5": { in: 3, out: 15, provider: "OpenCode Zen" },
  "opencode/claude-sonnet-4-6": { in: 6, out: 22.5, provider: "OpenCode Zen" },
  "opencode/gemini-3-pro": { in: 2, out: 12, provider: "OpenCode Zen" },
  "opencode/gemini-3.1-pro": { in: 4, out: 18, provider: "OpenCode Zen" },
  "opencode/claude-opus-4-1": { in: 15, out: 75, provider: "OpenCode Zen" },
  "opencode/claude-opus-4-5": { in: 5, out: 25, provider: "OpenCode Zen" },
  "opencode/claude-opus-4-6": { in: 10, out: 37.5, provider: "OpenCode Zen" },
  // gpt-5.3-codex not in Zen docs — assume ~5.2 tier
  "opencode/gpt-5.3-codex": { in: 1.75, out: 14, provider: "OpenCode Zen (est)" },
  "opencode/alpha-gpt-5.3-codex": { in: 1.75, out: 14, provider: "OpenCode Zen (est)" },
  "opencode/alpha-gpt-5.4": { in: 2, out: 16, provider: "OpenCode Zen (est)" },

  // Groq
  "groq/llama-3.1-8b-instant": { in: 0.05, out: 0.08, provider: "Groq" },
  "groq/openai/gpt-oss-20b": { in: 0.075, out: 0.3, provider: "Groq" },
  "groq/openai/gpt-oss-safeguard-20b": { in: 0.075, out: 0.3, provider: "Groq" },
  "groq/meta-llama/llama-4-scout-17b-16e-instruct": { in: 0.11, out: 0.34, provider: "Groq" },
  "groq/openai/gpt-oss-120b": { in: 0.15, out: 0.6, provider: "Groq" },
  "groq/meta-llama/llama-4-maverick-17b-128e-instruct": { in: 0.2, out: 0.6, provider: "Groq" },
  "groq/qwen/qwen3-32b": { in: 0.29, out: 0.59, provider: "Groq" },
  "groq/llama-3.3-70b-versatile": { in: 0.59, out: 0.79, provider: "Groq" },
  "groq/moonshotai/kimi-k2-instruct": { in: 1, out: 3, provider: "Groq" },
  "groq/moonshotai/kimi-k2-instruct-0905": { in: 1, out: 3, provider: "Groq" },

  // OpenAI (direct)
  "openai/gpt-5-codex": { in: 1.25, out: 10, provider: "OpenAI" },
  "openai/gpt-5.1-codex": { in: 1.07, out: 8.5, provider: "OpenAI" },
  "openai/gpt-5.1-codex-max": { in: 1.25, out: 10, provider: "OpenAI" },
  "openai/gpt-5.2-codex": { in: 1.75, out: 14, provider: "OpenAI" },
  "openai/gpt-5.3-codex": { in: 1.75, out: 14, provider: "OpenAI" },

  // Anthropic
  "anthropic/claude-sonnet-4-20250514": { in: 3, out: 15, provider: "Anthropic" },
  "anthropic/claude-sonnet-4-5-20250929": { in: 3, out: 15, provider: "Anthropic" },
  "anthropic/claude-sonnet-4-6": { in: 6, out: 22.5, provider: "Anthropic" },
  "anthropic/claude-opus-4-20250514": { in: 15, out: 75, provider: "Anthropic" },
  "anthropic/claude-opus-4-5-20251101": { in: 5, out: 25, provider: "Anthropic" },
  "anthropic/claude-haiku-4-5-20251001": { in: 1, out: 5, provider: "Anthropic" },

  // xAI (Grok)
  "xai/grok-3-mini": { in: 0.3, out: 0.5, provider: "xAI" },
  "xai/grok-3": { in: 3, out: 15, provider: "xAI" },
  "xai/grok-4-fast-non-reasoning": { in: 0.2, out: 0.5, provider: "xAI" },
  "xai/grok-4-fast-reasoning": { in: 0.2, out: 0.5, provider: "xAI" },
  "xai/grok-4-1-fast-non-reasoning": { in: 0.2, out: 0.5, provider: "xAI" },
  "xai/grok-4-1-fast-reasoning": { in: 0.2, out: 0.5, provider: "xAI" },
  "xai/grok-code-fast-1": { in: 0.2, out: 1.5, provider: "xAI" },

  // Google
  "google/models/gemini-2.0-flash": { in: 0.075, out: 0.3, provider: "Google" },
  "google/models/gemini-2.5-pro": { in: 1.25, out: 10, provider: "Google" },
  "google/models/gemini-2.5-flash": { in: 0.15, out: 0.6, provider: "Google" },

  // DeepSeek
  "deepseek/deepseek-chat": { in: 0.14, out: 0.28, provider: "DeepSeek" },
  "deepseek/deepseek-reasoner": { in: 0.55, out: 2.19, provider: "DeepSeek" },

  // Mistral
  "mistral/mistral-large-latest": { in: 0.5, out: 1.5, provider: "Mistral" },
  "mistral/mistral-large-2512": { in: 0.5, out: 1.5, provider: "Mistral" },
  "mistral/codestral": { in: 0.15, out: 0.3, provider: "Mistral" },
  "mistral/codestral-latest": { in: 0.15, out: 0.3, provider: "Mistral" },

  // Perplexity
  "perplexity/sonar-pro": { in: 1, out: 5, provider: "Perplexity" },
  "perplexity/sonar": { in: 0.2, out: 0.2, provider: "Perplexity" },

  // Cerebras
  "cerebras/llama3.1-8b": { in: 0.04, out: 0.08, provider: "Cerebras" },
  "cerebras/gpt-oss-120b": { in: 0.15, out: 0.6, provider: "Cerebras" },

  // NVIDIA NIM (approximate)
  "nvidia/minimaxai/minimax-m2": { in: 0.3, out: 1.2, provider: "NVIDIA NIM" },
  "nvidia/minimaxai/minimax-m2.1": { in: 0.3, out: 1.2, provider: "NVIDIA NIM" },
  "nvidia/minimaxai/minimax-m2.5": { in: 0.3, out: 1.2, provider: "NVIDIA NIM" },
  "nvidia/moonshotai/kimi-k2-instruct-0905": { in: 1, out: 3, provider: "NVIDIA NIM" },
};

function resolveModelId(providerId, modelId) {
  if (modelId.includes("/")) return modelId;
  const prov = providerId.toLowerCase();
  if (prov === "groq" && modelId.startsWith("moonshotai/")) return `groq/${modelId}`;
  if (prov === "groq" && modelId.startsWith("openai/")) return `groq/${modelId}`;
  if (prov === "groq" && modelId.startsWith("meta-llama/")) return `groq/${modelId}`;
  if (prov === "groq" && modelId.startsWith("qwen/")) return `groq/${modelId}`;
  if (prov === "opencode") return `opencode/${modelId}`;
  if (prov === "openai") return `openai/${modelId}`;
  if (prov === "anthropic") return `anthropic/${modelId}`;
  if (prov === "google") return `google/${modelId}`;
  if (prov === "xai") return `xai/${modelId}`;
  if (prov === "deepseek") return `deepseek/${modelId}`;
  if (prov === "mistral") return `mistral/${modelId}`;
  if (prov === "perplexity") return `perplexity/${modelId}`;
  if (prov === "cerebras") return `cerebras/${modelId}`;
  if (prov === "nvidia") return `nvidia/${modelId}`;
  return `${prov}/${modelId}`;
}

function main() {
  if (!existsSync(CREWSWARM)) {
    console.error("No ~/.crewswarm/crewswarm.json found");
    process.exit(1);
  }
  const cfg = JSON.parse(readFileSync(CREWSWARM, "utf8"));
  const providers = cfg?.providers || {};
  const agents = cfg?.agents || [];

  // Collect all model IDs in use
  const modelIds = new Set();
  for (const a of agents) {
    const m = a.model || a.opencodeModel || a.fallbackModel;
    if (m) modelIds.add(m);
  }
  for (const [provId, prov] of Object.entries(providers)) {
    const models = prov.models || [];
    for (const m of models) {
      const id = m.id || m.name;
      if (id) modelIds.add(resolveModelId(provId, id));
    }
  }

  console.log("Model pricing lookup (your providers)\n");
  console.log("Sources: OpenCode Zen docs, Groq console, provider APIs — Feb 2026\n");
  console.log("| Model | Provider | Input $/1M | Output $/1M |");
  console.log("|-------|----------|------------|-------------|");

  const found = [];
  const missing = [];
  for (const mid of [...modelIds].sort()) {
    const p = PRICING[mid];
    if (p) {
      const inStr = p.in === 0 ? "free" : `$${p.in.toFixed(2)}`;
      const outStr = p.out === 0 ? "free" : `$${p.out.toFixed(2)}`;
      found.push({ mid, ...p });
      console.log(`| ${mid} | ${p.provider} | ${inStr} | ${outStr} |`);
    } else {
      missing.push(mid);
    }
  }

  if (missing.length) {
    console.log("\n--- Models not in pricing DB (add to PRICING in script) ---");
    for (const m of missing.slice(0, 20)) console.log("  " + m);
    if (missing.length > 20) console.log("  ... and " + (missing.length - 20) + " more");
  }

  console.log("\n--- OpenCode Zen vs direct provider ---");
  console.log("OpenCode Zen: single API key, curated models, pay Zen (at/near cost)");
  console.log("Direct (openai, anthropic, groq): use your own keys, often cheaper for Groq");
  console.log("GPT-5.3 Codex via Zen ≈ $14/1M out | GPT OSS 120B via Groq = $0.60/1M out");
}

main();
