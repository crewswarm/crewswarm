#!/usr/bin/env node
/**
 * Cost–outcome correlation per role.
 * Computes value score (outcome/cost) and recommends best cost-effective model per role.
 *
 * Run: node scripts/model-cost-outcome.mjs
 *
 * Data: Groq pricing (Feb 2026), model-ratings benchmarks, role rankings.
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";

// Output $ per 1M tokens (primary cost driver for generation)
const COST_OUT_PER_1M = {
  "groq/openai/gpt-oss-20b": 0.30,
  "groq/openai/gpt-oss-120b": 0.60,
  "groq/openai/gpt-oss-safeguard-20b": 0.30,
  "groq/moonshotai/kimi-k2-instruct-0905": 3.00,
  "groq/llama-3.3-70b-versatile": 0.79,
  "groq/llama-3.1-8b-instant": 0.08,
  "groq/meta-llama/llama-4-scout-17b-16e-instruct": 0.34,
  "groq/meta-llama/llama-4-maverick-17b-128e-instruct": 0.60,
  "groq/qwen/qwen3-32b": 0.59,
  "mistral/mistral-large-2512": 1.50,
  "mistral/codestral": 0.30, // approximate
  "anthropic/claude-sonnet-4": 15.0, // approx $3/200K
  "anthropic/claude-opus-4": 45.0,
  "anthropic/claude-haiku-4-5": 1.0,
  "openai/gpt-5.3-codex": 15.0, // Zen pricing
  "google/gemini-2.0-flash": 0.30,
  "deepseek/deepseek-chat": 1.10,
  "deepseek/deepseek-reasoner": 2.19,
  "xai/grok-3": 8.0,
  "cerebras/llama3.1-8b": 0.10,
  "perplexity/sonar-pro": 5.0,
  "nvidia/minimaxai/minimax-m2": 1.0,
  "opencode/big-pickle": 0, // free
};

// Outcome scores: SWE-Bench %, HumanEval %, or 0–10 quality proxy
const OUTCOMES = {
  "groq/openai/gpt-oss-20b": { sweBench: 55, humaneval: 81.7 },
  "groq/openai/gpt-oss-120b": { sweBench: 62.4, humaneval: 88.3 },
  "groq/moonshotai/kimi-k2-instruct-0905": { sweBench: 69.2, humaneval: 93.3 },
  "groq/llama-3.3-70b-versatile": { sweBench: 50, humaneval: 50 },
  "groq/llama-3.1-8b-instant": { sweBench: 30, humaneval: 35 },
  "groq/meta-llama/llama-4-scout-17b-16e-instruct": { sweBench: 52, humaneval: 55 },
  "groq/meta-llama/llama-4-maverick-17b-128e-instruct": { sweBench: 55, humaneval: 58 },
  "groq/qwen/qwen3-32b": { sweBench: 55, humaneval: 70 },
  "mistral/mistral-large-2512": { sweBench: 58, humaneval: 91 },
  "mistral/codestral": { sweBench: 52, humaneval: 86.6 },
  "anthropic/claude-sonnet-4": { sweBench: 72.7, humaneval: 92 },
  "anthropic/claude-opus-4": { sweBench: 72.5, humaneval: 90 },
  "anthropic/claude-haiku-4-5": { sweBench: 55, humaneval: 70 },
  "openai/gpt-5.3-codex": { sweBench: 75, humaneval: 93 },
  "google/gemini-2.0-flash": { sweBench: 48, humaneval: 65 },
  "deepseek/deepseek-chat": { sweBench: 58, humaneval: 78 },
  "deepseek/deepseek-reasoner": { sweBench: 65, humaneval: 85 },
  "xai/grok-3": { sweBench: 62, humaneval: 80 },
  "cerebras/llama3.1-8b": { sweBench: 35, humaneval: 40 },
  "perplexity/sonar-pro": { sweBench: 50, humaneval: 65 },
  "nvidia/minimaxai/minimax-m2": { sweBench: 80.2, humaneval: 88 },
  "opencode/big-pickle": { sweBench: 68, humaneval: 85 },
};

// Role -> outcome metric (which benchmark to use)
const ROLE_METRIC = {
  "crew-coder": "sweBench",
  "crew-coder-front": "sweBench",
  "crew-coder-back": "sweBench",
  "crew-frontend": "sweBench",
  "crew-qa": "sweBench",
  "crew-fixer": "sweBench",
  "crew-pm": "humaneval", // proxy for instruction following
  "crew-security": "sweBench",
  "crew-copywriter": "humaneval",
  "crew-github": "sweBench",
  "crew-main": "sweBench",
  "crew-lead": "sweBench",
};

// Fallback: use average of both if role not in map
const DEFAULT_METRIC = "sweBench";

function getOutcome(modelId, metric) {
  const o = OUTCOMES[modelId];
  if (!o) return 50; // unknown
  const m = metric || DEFAULT_METRIC;
  return o[m] ?? o.sweBench ?? o.humaneval ?? 50;
}

function getCost(modelId) {
  const c = COST_OUT_PER_1M[modelId];
  return c === undefined ? 1.0 : c;
}

function valueScore(outcome, costPer1M) {
  const cost = Math.max(costPer1M, 0.01); // avoid div by zero
  return outcome / cost;
}

function main() {
  const models = Object.keys(COST_OUT_PER_1M).filter((m) => OUTCOMES[m] !== undefined);
  const roles = [...new Set(Object.keys(ROLE_METRIC))];

  console.log("Cost–outcome correlation per role\n");
  console.log("Value = outcome / cost (higher = better cost-effectiveness)\n");

  for (const role of roles) {
    const metric = ROLE_METRIC[role] || DEFAULT_METRIC;
    const scored = models
      .map((mid) => {
        const outcome = getOutcome(mid, metric);
        const cost = getCost(mid);
        const value = valueScore(outcome, cost);
        return { model: mid, outcome, cost, value };
      })
      .filter((r) => r.outcome > 0)
      .sort((a, b) => b.value - a.value);

    const top = scored.slice(0, 5);
    console.log(`### ${role} (metric: ${metric})`);
    console.log("| Model | Outcome | $/1M out | Value |");
    console.log("|-------|---------|----------|-------|");
    for (const r of top) {
      const costStr = r.cost === 0 ? "free" : `$${r.cost.toFixed(2)}`;
      console.log(`| ${r.model} | ${r.outcome.toFixed(1)} | ${costStr} | ${r.value.toFixed(1)} |`);
    }
    console.log("");
  }

  // Correlation: outcome vs cost (paid models only)
  const paid = models.filter((m) => getCost(m) > 0);
  const xs = paid.map((m) => getCost(m));
  const ys = paid.map((m) => getOutcome(m, "sweBench"));
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0,
    den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  const slope = den ? num / den : 0;
  const intercept = meanY - slope * meanX;
  const corrNum = paid.reduce((s, _, i) => s + (xs[i] - meanX) * (ys[i] - meanY), 0);
  const corrDen =
    Math.sqrt(paid.reduce((s, _, i) => s + (xs[i] - meanX) ** 2, 0)) *
    Math.sqrt(paid.reduce((s, _, i) => s + (ys[i] - meanY) ** 2, 0));
  const r = corrDen ? corrNum / corrDen : 0;
  console.log("---\n### Cost–outcome correlation (paid models)\n");
  console.log(`Linear: outcome ≈ ${intercept.toFixed(1)} + ${slope.toFixed(2)} * cost`);
  console.log(`Correlation r ≈ ${r.toFixed(3)} (${r > 0.3 ? "moderate" : r > 0 ? "weak" : "negligible"} positive)`);
  console.log("(Higher cost tends to → higher outcome; value = outcome/cost finds best tradeoff)\n");

  // Summary: top value picks across all roles
  console.log("---\n### Best value by cost tier\n");
  const byCost = models
    .map((m) => ({
      model: m,
      cost: getCost(m),
      outcome: (getOutcome(m, "sweBench") + getOutcome(m, "humaneval")) / 2,
      value: valueScore((getOutcome(m, "sweBench") + getOutcome(m, "humaneval")) / 2, getCost(m)),
    }))
    .sort((a, b) => b.value - a.value);

  const free = byCost.filter((r) => r.cost === 0);
  const cheap = byCost.filter((r) => r.cost > 0 && r.cost <= 0.5);
  const mid = byCost.filter((r) => r.cost > 0.5 && r.cost <= 2);
  const premium = byCost.filter((r) => r.cost > 2);

  if (free.length) console.log("Free: " + free.map((r) => r.model).join(", "));
  if (cheap.length) console.log("Cheap (<$0.50/1M): " + cheap.slice(0, 3).map((r) => r.model).join(", "));
  if (mid.length) console.log("Mid ($0.50–2): " + mid.slice(0, 3).map((r) => r.model).join(", "));
  if (premium.length) console.log("Premium: " + premium.slice(0, 3).map((r) => r.model).join(", "));
}

main();
