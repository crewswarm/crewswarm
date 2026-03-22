/**
 * Spending caps + token usage accumulator — extracted from gateway-bridge.mjs
 * Inject: initSpending({ resolveConfig, resolveTelegramBridgeConfig })
 */

import fs   from "fs";
import path from "path";
import os   from "os";

const SPENDING_FILE    = path.join(os.homedir(), ".crewswarm", "spending.json");
const TOKEN_USAGE_FILE = path.join(os.homedir(), ".crewswarm", "token-usage.json");

// Cost per 1M tokens per provider (USD) — input / output / cached
// Cached pricing: Gemini=free, Anthropic=90% off, Grok=50% off, others=same as input
const PRICING = {
  groq:       { input: 0.05,  output: 0.05,  cached: 0.025 },  // 50% off
  anthropic:  { input: 3.00,  output: 15.00, cached: 0.30 },   // 90% off
  openai:     { input: 5.00,  output: 15.00, cached: 2.50 },   // 50% off
  perplexity: { input: 1.00,  output: 1.00,  cached: 1.00 },   // no discount
  mistral:    { input: 0.70,  output: 2.00,  cached: 0.70 },   // no discount
  google:     { input: 0.075, output: 0.30,  cached: 0.00 },   // FREE!
  xai:        { input: 5.00,  output: 15.00, cached: 2.50 },   // 50% off (Grok)
  deepseek:   { input: 0.27,  output: 1.10,  cached: 0.135 },  // 50% off
  nvidia:     { input: 1.00,  output: 1.00,  cached: 1.00 },   // no discount
  cerebras:   { input: 0.10,  output: 0.10,  cached: 0.10 },   // no discount
};

// Legacy fallback for old code using COST_PER_1M
const COST_PER_1M = { groq:0.05, anthropic:3.00, openai:5.00, perplexity:1.00, mistral:0.70, google:0.15, xai:2.00, deepseek:0.27, nvidia:1.00, cerebras:0.10 };

let _resolveConfig               = () => ({});
let _resolveTelegramBridgeConfig = () => ({});

export function initSpending({ resolveConfig, resolveTelegramBridgeConfig } = {}) {
  if (resolveConfig)               _resolveConfig               = resolveConfig;
  if (resolveTelegramBridgeConfig) _resolveTelegramBridgeConfig = resolveTelegramBridgeConfig;
}

// ── Spending caps ─────────────────────────────────────────────────────────────

export function loadSpending() {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const d = JSON.parse(fs.readFileSync(getSpendingFile(), "utf8"));
    if (d.date === today) return d;
  } catch {}
  return { date: today, global: { tokens: 0, costUSD: 0 }, agents: {} };
}

export function saveSpending(s) {
  try { 
    const file = getSpendingFile();
    fs.mkdirSync(path.dirname(file), { recursive: true }); 
    fs.writeFileSync(file, JSON.stringify(s, null, 2)); 
  } catch {}
}

export function addAgentSpend(agentId, tokens, costUSD) {
  const s = loadSpending();
  s.global.tokens  += tokens;
  s.global.costUSD += costUSD;
  if (!s.agents[agentId]) s.agents[agentId] = { tokens: 0, costUSD: 0 };
  s.agents[agentId].tokens  += tokens;
  s.agents[agentId].costUSD += costUSD;
  saveSpending(s);
}

export function checkSpendingCap(agentId, providerKey) {
  try {
    const csw = JSON.parse(fs.readFileSync(getCrewswarmConfigPath(), "utf8"));
    const s   = loadSpending();
    const gl  = csw.globalSpendingCaps || {};
    if (gl.dailyTokenLimit && s.global.tokens >= gl.dailyTokenLimit)
      return { exceeded: true, action: "stop", message: `Global daily token limit ${gl.dailyTokenLimit.toLocaleString()} reached` };
    if (gl.dailyCostLimitUSD && s.global.costUSD >= gl.dailyCostLimitUSD)
      return { exceeded: true, action: "stop", message: `Global daily cost limit $${gl.dailyCostLimitUSD} reached` };
    const agent    = (csw.agents || []).find(a => a.id === agentId);
    const agentCap = agent?.spending;
    if (agentCap) {
      const used = s.agents[agentId] || { tokens: 0, costUSD: 0 };
      if (agentCap.dailyTokenLimit && used.tokens >= agentCap.dailyTokenLimit)
        return { exceeded: true, action: agentCap.onExceed || "notify", message: `${agentId} daily token limit ${agentCap.dailyTokenLimit.toLocaleString()} reached` };
      if (agentCap.dailyCostLimitUSD && used.costUSD >= agentCap.dailyCostLimitUSD)
        return { exceeded: true, action: agentCap.onExceed || "notify", message: `${agentId} daily cost limit $${agentCap.dailyCostLimitUSD} reached` };
    }
  } catch {}
  return { exceeded: false };
}

export async function notifyTelegramSpending(message) {
  const cfg      = _resolveConfig();
  const tgBridge = _resolveTelegramBridgeConfig();
  const botToken = process.env.TELEGRAM_BOT_TOKEN || cfg?.env?.TELEGRAM_BOT_TOKEN || cfg?.TELEGRAM_BOT_TOKEN || tgBridge.token || "";
  const chatId   = process.env.TELEGRAM_CHAT_ID   || cfg?.env?.TELEGRAM_CHAT_ID   || cfg?.TELEGRAM_CHAT_ID
    || (Array.isArray(tgBridge.allowedChatIds) && tgBridge.allowedChatIds.length ? String(tgBridge.allowedChatIds[0]) : "") || tgBridge.defaultChatId || "";
  const chatIdVal = chatId.trim();
  if (!botToken || !chatIdVal) return;
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatIdVal, text: `💸 Spending alert: ${message}`, parse_mode: "Markdown" }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

// ── Token/cost accumulator ────────────────────────────────────────────────────

export const tokenUsage = (() => {
  try { return JSON.parse(fs.readFileSync(getTokenUsageFile(), "utf8")); } catch {}
  return { calls: 0, prompt: 0, completion: 0, byModel: {}, sessionStart: new Date().toISOString() };
})();

export function recordTokenUsage(modelId, usage, agentId) {
  if (!usage) return;
  const p = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const c = Number(usage.completion_tokens || usage.output_tokens || 0);
  if (!p && !c) return;
  const cached = Number(
    usage.prompt_tokens_details?.cached_tokens  // OpenAI / xAI / Groq
    || usage.prompt_cache_hit_tokens            // DeepSeek
    || usage.cache_read_input_tokens            // Anthropic
    || 0
  );
  if (cached > 0) {
    const pct = p > 0 ? Math.round(cached / p * 100) : 0;
    console.log(`[bridge:${agentId || modelId}] cache hit: ${cached}/${p} tokens cached (${pct}%) — ${modelId}`);
  }
  const today = new Date().toISOString().slice(0, 10);
  tokenUsage.calls++;
  tokenUsage.prompt     += p;
  tokenUsage.completion += c;
  if (!tokenUsage.cached) tokenUsage.cached = 0;
  tokenUsage.cached += cached;
  if (!tokenUsage.byModel[modelId]) tokenUsage.byModel[modelId] = { calls: 0, prompt: 0, completion: 0, cached: 0 };
  tokenUsage.byModel[modelId].calls++;
  tokenUsage.byModel[modelId].prompt     += p;
  tokenUsage.byModel[modelId].completion += c;
  tokenUsage.byModel[modelId].cached     += cached;
  if (!tokenUsage.byDay) tokenUsage.byDay = {};
  if (!tokenUsage.byDay[today]) tokenUsage.byDay[today] = { calls: 0, prompt: 0, completion: 0, cached: 0, byModel: {} };
  tokenUsage.byDay[today].calls++;
  tokenUsage.byDay[today].prompt     += p;
  tokenUsage.byDay[today].completion += c;
  tokenUsage.byDay[today].cached     += cached;
  if (!tokenUsage.byDay[today].byModel[modelId]) tokenUsage.byDay[today].byModel[modelId] = { calls: 0, prompt: 0, completion: 0, cached: 0 };
  tokenUsage.byDay[today].byModel[modelId].calls++;
  tokenUsage.byDay[today].byModel[modelId].prompt     += p;
  tokenUsage.byDay[today].byModel[modelId].completion += c;
  tokenUsage.byDay[today].byModel[modelId].cached     += cached;
  if (tokenUsage.calls % 5 === 0) {
    try {
      const file = getTokenUsageFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(tokenUsage, null, 2));
    } catch {}
  }
  if (agentId) {
    const providerKey = modelId.split("/")[0] || "unknown";
    const pricing = PRICING[providerKey] || { input: 1.0, output: 1.0, cached: 1.0 };
    
    // Calculate cost with cache discount
    const uncachedInput = Math.max(0, p - cached);
    const inputCost  = (uncachedInput / 1_000_000) * pricing.input;
    const cachedCost = (cached / 1_000_000) * pricing.cached;
    const outputCost = (c / 1_000_000) * pricing.output;
    const costUSD = inputCost + cachedCost + outputCost;
    
    // Log cache savings for high cache hit rates
    if (cached > 0 && cached / p > 0.5) {
      const savings = ((uncachedInput / 1_000_000) * pricing.input) - cachedCost;
      console.log(`[spending:${agentId}] cache saved $${savings.toFixed(4)} on ${cached.toLocaleString()} tokens`);
    }
    
    const total = p + c; // Total tokens (for cap checking)
    addAgentSpend(agentId, total, costUSD);
  }
}
