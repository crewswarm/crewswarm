/**
 * LLM caller for crew-lead — extracted from crew-lead.mjs
 * Handles direct HTTP calls to LLM providers with fallback logic,
 * token recording, and message patching for fallback awareness.
 *
 * Inject: initLlmCaller({ llmTimeout })
 */
import fs   from "node:fs";
import path from "node:path";
import os   from "node:os";

let _LLM_TIMEOUT = 180000;

export function initLlmCaller({ llmTimeout } = {}) {
  if (llmTimeout) _LLM_TIMEOUT = llmTimeout;
}

const TOKEN_USAGE_FILE = path.join(os.homedir(), ".crewswarm", "token-usage.json");

export async function _callLLMOnce(baseUrl, apiKey, modelId, providerKey, messages, options = {}) {
  const isAnthropic = providerKey === "anthropic" || baseUrl.includes("anthropic.com");
  const enableStreaming = options.stream || false;
  const onStreamToken = options.onStreamToken || null;
  
  const headers = { "content-type": "application/json" };
  if (isAnthropic) {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers["authorization"] = `Bearer ${apiKey}`;
  }

  const isGemini = providerKey === "google" || baseUrl.includes("googleapis.com");
  const isXai = providerKey === "xai" || baseUrl.includes("x.ai");
  const isOpenAI = providerKey === "openai" || baseUrl.includes("openai.com");
  
  // Gemini 2.5 Flash: input 1,048,576 tokens / output 65,536 tokens
  // Anthropic Claude: output typically capped at 8,192 tokens
  // All others: 4,096 safe default
  const maxOutputTokens = isGemini ? 16384 : isAnthropic ? 8192 : 4096;
  
  let body, endpoint;
  
  if (isAnthropic) {
    // Anthropic uses /messages endpoint with different format
    const systemMsg = messages.find(m => m.role === "system");
    const nonSystemMsgs = messages.filter(m => m.role !== "system");
    
    endpoint = `${baseUrl.replace(/\/$/, "")}/messages`;
    
    // Mark memory/project context messages as cacheable for 90% savings
    const cacheableMessages = nonSystemMsgs.map((m, idx) => {
      const isCacheable = m.role === "user" && (
        m.content?.includes('[Shared memory —') || 
        m.content?.includes('[Project memory —') ||
        m.content?.includes('[Brave search]')  // Cache search results too
      );
      
      // Anthropic requires cache_control on LAST cacheable block in sequence
      return isCacheable ? {
        role: m.role,
        content: [
          {
            type: "text",
            text: m.content,
            cache_control: { type: "ephemeral" }
          }
        ]
      } : m;
    });
    
    body = {
      model: modelId,
      max_tokens: maxOutputTokens,
      temperature: 0.7,
      stream: enableStreaming,
      messages: cacheableMessages
    };
    
    // Add system with explicit cache control
    if (systemMsg) {
      body.system = [
        {
          type: "text",
          text: systemMsg.content,
          cache_control: { type: "ephemeral" }
        }
      ];
    }
  } else {
    // OpenAI-compatible API (Groq, xAI, etc.)
    endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
    
    // Reasoning models (o1/o3/gpt-5 series) don't support max_tokens parameter
    const isReasoningModel = /^(o1|o3|gpt-5)/i.test(modelId);
    
    body = {
      model: modelId,
      messages,
      // Only add max_tokens for non-reasoning models
      ...(!isReasoningModel && { max_tokens: maxOutputTokens }),
      temperature: 0.7,
      stream: enableStreaming,
      // Disable Gemini 2.5 thinking — crew-lead is a conversational router, not a reasoner.
      // Thinking tokens are hidden but count against TPM quota, causing rate limits.
      ...(isGemini && { reasoning_effort: "none" }),
      // xAI/OpenAI: Enable prompt caching via cache_control in messages
      ...(isXai || isOpenAI ? { 
        stream_options: enableStreaming ? { include_usage: true } : undefined 
      } : {})
    };
  }
  
  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(_LLM_TIMEOUT),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    const url = endpoint;
    console.error(`[crew-lead] LLM ${res.status} @ ${url} model=${modelId}: ${err.slice(0, 400)}`);
    throw new Error(`LLM ${res.status}: ${err.slice(0, 200)}`);
  }
  
  // Handle streaming responses
  if (enableStreaming) {
    let fullReply = '';
    let usage = null;
    
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';  // Keep incomplete line in buffer
      
      for (const line of lines) {
        if (!line.trim() || line.trim() === 'data: [DONE]') continue;
        if (!line.startsWith('data: ')) continue;
        
        try {
          const data = JSON.parse(line.slice(6));
          
          // Extract token from stream chunk
          let token = '';
          if (isAnthropic) {
            // Anthropic stream: {type: "content_block_delta", delta: {text: "..."}}
            if (data.type === 'content_block_delta') {
              token = data.delta?.text || '';
            } else if (data.type === 'message_delta' && data.usage) {
              usage = data.usage;
            }
          } else {
            // OpenAI stream: {choices: [{delta: {content: "..."}}]}
            token = data.choices?.[0]?.delta?.content || '';
            if (data.usage) usage = data.usage;
          }
          
          if (token) {
            fullReply += token;
            if (onStreamToken) onStreamToken(token);
          }
        } catch (e) {
          // Skip malformed JSON chunks
        }
      }
    }
    
    _recordCrewLeadTokens(modelId, providerKey, usage);
    return fullReply;
  }
  
  // Non-streaming response
  const data = await res.json();
  
  // Parse response based on provider format
  let reply;
  if (isAnthropic) {
    // Anthropic format: { content: [{type: "text", text: "..."}], ... }
    reply = data?.content?.[0]?.text || "";
  } else {
    // OpenAI format: { choices: [{message: {content: "..."}}], ... }
    reply = data?.choices?.[0]?.message?.content || "";
  }
  
  _recordCrewLeadTokens(modelId, providerKey, data.usage);
  return reply;
}

function _recordCrewLeadTokens(modelId, providerKey, usage) {
  if (!usage) return;
  const p = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const c = Number(usage.completion_tokens || usage.output_tokens || 0);
  if (!p && !c) return;

  // Cached token count — field name varies by provider
  const cached = Number(
    usage.prompt_tokens_details?.cached_tokens   // OpenAI / xAI
    || usage.prompt_cache_hit_tokens             // DeepSeek
    || usage.cache_read_input_tokens             // Anthropic
    || 0
  );
  if (cached > 0) {
    const pct = p > 0 ? Math.round(cached / p * 100) : 0;
    console.log(`[crew-lead] cache hit: ${cached}/${p} tokens cached (${pct}%) — ${providerKey}/${modelId}`);
  }

  const today = new Date().toISOString().slice(0, 10);
  let data = { calls: 0, prompt: 0, completion: 0, cached: 0, byModel: {}, byDay: {} };
  try { data = JSON.parse(fs.readFileSync(TOKEN_USAGE_FILE, "utf8")); } catch {}
  if (!data.byDay) data.byDay = {};
  if (!data.cached) data.cached = 0;
  data.calls++;
  data.prompt     += p;
  data.completion += c;
  data.cached     += cached;
  if (!data.byModel[modelId]) data.byModel[modelId] = { calls: 0, prompt: 0, completion: 0, cached: 0 };
  data.byModel[modelId].calls++;
  data.byModel[modelId].prompt     += p;
  data.byModel[modelId].completion += c;
  data.byModel[modelId].cached     += cached;
  if (!data.byDay[today]) data.byDay[today] = { calls: 0, prompt: 0, completion: 0, cached: 0, byModel: {} };
  data.byDay[today].calls++;
  data.byDay[today].prompt     += p;
  data.byDay[today].completion += c;
  data.byDay[today].cached     += cached;
  if (!data.byDay[today].byModel[modelId]) data.byDay[today].byModel[modelId] = { calls: 0, prompt: 0, completion: 0, cached: 0 };
  data.byDay[today].byModel[modelId].calls++;
  data.byDay[today].byModel[modelId].prompt     += p;
  data.byDay[today].byModel[modelId].completion += c;
  data.byDay[today].byModel[modelId].cached     += cached;
  try {
    fs.mkdirSync(path.dirname(TOKEN_USAGE_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_USAGE_FILE, JSON.stringify(data, null, 2));
  } catch {}
  
  // Calculate cost with cache discount - inline pricing table to avoid circular import
  const PRICING = {
    groq:       { input: 0.05,  output: 0.05,  cached: 0.025 },
    anthropic:  { input: 3.00,  output: 15.00, cached: 0.30 },
    openai:     { input: 5.00,  output: 15.00, cached: 2.50 },
    perplexity: { input: 1.00,  output: 1.00,  cached: 1.00 },
    mistral:    { input: 0.70,  output: 2.00,  cached: 0.70 },
    google:     { input: 0.075, output: 0.30,  cached: 0.00 },  // FREE!
    xai:        { input: 5.00,  output: 15.00, cached: 2.50 },
    deepseek:   { input: 0.27,  output: 1.10,  cached: 0.135 },
    nvidia:     { input: 1.00,  output: 1.00,  cached: 1.00 },
    cerebras:   { input: 0.10,  output: 0.10,  cached: 0.10 },
  };
  
  const pricing = PRICING[providerKey] || { input: 1.0, output: 1.0, cached: 1.0 };
  const uncachedInput = Math.max(0, p - cached);
  const inputCost  = (uncachedInput / 1_000_000) * pricing.input;
  const cachedCost = (cached / 1_000_000) * pricing.cached;
  const outputCost = (c / 1_000_000) * pricing.output;
  const costUSD = inputCost + cachedCost + outputCost;
  
  if (cached > 0 && cached / p > 0.5) {
    const fullCost = (p / 1_000_000) * pricing.input;
    const savings = fullCost - (inputCost + cachedCost);
    console.log(`[crew-lead] cache saved $${savings.toFixed(4)} (would cost $${fullCost.toFixed(4)} without cache)`);
  }
  
  // Record to spending.json for dashboard
  const SPENDING_FILE = path.join(os.homedir(), ".crewswarm", "spending.json");
  try {
    const spendingData = (() => {
      try { return JSON.parse(fs.readFileSync(SPENDING_FILE, "utf8")); }
      catch { return { date: today, global: { tokens: 0, costUSD: 0 }, agents: {} }; }
    })();
    
    // Reset if date rolled over
    if (spendingData.date !== today) {
      spendingData.date = today;
      spendingData.global = { tokens: 0, costUSD: 0 };
      spendingData.agents = {};
    }
    
    const total = p + c;
    spendingData.global.tokens  += total;
    spendingData.global.costUSD += costUSD;
    if (!spendingData.agents["crew-lead"]) spendingData.agents["crew-lead"] = { tokens: 0, costUSD: 0 };
    spendingData.agents["crew-lead"].tokens  += total;
    spendingData.agents["crew-lead"].costUSD += costUSD;
    
    fs.mkdirSync(path.dirname(SPENDING_FILE), { recursive: true });
    fs.writeFileSync(SPENDING_FILE, JSON.stringify(spendingData, null, 2));
  } catch {}
}

/** Inject active-model note when crew-lead is running on fallback. PREPEND so model sees it first.
 *  Also patch health snapshot in user messages so it shows the actual running model, not the primary. */
export function patchMessagesWithActiveModel(messages, activeModel, primaryModel, reason) {
  const out = messages.map(m => ({ ...m }));
  const sysIdx = out.findIndex(m => m.role === "system");
  if (sysIdx < 0) return out;
  const note = `CRITICAL — you are on FALLBACK: ${activeModel} (primary ${primaryModel} failed: ${reason}). When asked what model you use, say ${activeModel}. Never say codex or openai-local — that's crew-main.\n\n`;
  out[sysIdx] = { ...out[sysIdx], content: note + out[sysIdx].content };
  // Fix health snapshot in user messages — it shows cfg primary; when on fallback, show actual model
  for (let i = 0; i < out.length; i++) {
    if (out[i].role === "user" && out[i].content.includes("crew-lead:")) {
      out[i] = {
        ...out[i],
        content: out[i].content.replace(/(crew-lead:)\s*[\w-]+\/[\w.-]+(\s*\|)/g, `$1 ${activeModel} (fallback — primary failed)$2`),
      };
    }
  }
  return out;
}

export function trimMessagesForFallback(messages) {
  if (messages.length <= 3) return messages;
  const system = messages.find(m => m.role === "system");
  const nonSystem = messages.filter(m => m.role !== "system");

  const trimmedSystem = system ? [{
    ...system,
    content: system.content.length > 1500
      ? system.content.slice(0, 1500) + "\n[...system prompt trimmed for context limit — respond concisely]"
      : system.content,
  }] : [];

  // Always preserve memory injections (shared memory + project memory) so the
  // fallback model has context even on a heavily trimmed history
  const memoryMsgs = nonSystem.filter(m => m.role === "user" &&
    (m.content.startsWith("[Shared memory") || m.content.startsWith("[Project memory")));
  const withoutMemory = nonSystem.filter(m => !memoryMsgs.includes(m));
  const recent = withoutMemory.slice(-6);
  const trimmedRecent = recent.map(m => ({
    ...m,
    content: m.content.length > 2000 ? m.content.slice(0, 2000) + "\n[...trimmed]" : m.content,
  }));
  const trimmedMemory = memoryMsgs.map(m => ({
    ...m,
    content: m.content.length > 1500 ? m.content.slice(0, 1500) + "\n[...memory trimmed]" : m.content,
  }));
  return [...trimmedSystem, ...trimmedMemory, ...trimmedRecent];
}

export async function callLLM(messages, cfg, options = {}) {
  const { provider, modelId, providerKey } = cfg;
  if (!provider?.apiKey || !provider?.baseUrl) {
    throw new Error(`No API key for provider "${providerKey}". Check Providers in the dashboard.`);
  }

  const hasFallback = cfg.fallbackProvider?.apiKey && cfg.fallbackProvider?.baseUrl && cfg.fallbackModelId;
  const fbLabel = hasFallback ? `${cfg.fallbackProviderKey}/${cfg.fallbackModelId}` : null;

  try {
    const reply = await _callLLMOnce(provider.baseUrl, provider.apiKey, modelId, providerKey, messages, options);
    const primaryLabel = `${providerKey}/${modelId}`;
    const url = `${provider.baseUrl.replace(/\/$/, "")}/chat/completions`;
    console.log(`[crew-lead] LLM reply from primary ${primaryLabel} @ ${url}`);
    return { reply, usedFallback: false, model: primaryLabel };
  } catch (err) {
    if (!hasFallback) throw err;
    const isRateLimit = /429|rate\s*limit|quota.*exceeded|too\s*many\s*requests|usage.*limit/i.test(err.message);
    const isContextErr = /400.*reduce.*length|400.*context|400.*too long|400.*max.*token|content_length|please reduce/i.test(err.message);
    if (!isRateLimit && !isContextErr) throw err;

    const reason = isRateLimit ? "rate limit" : "context length";
    console.log(`[crew-lead] Primary ${providerKey}/${modelId} failed (${reason}) — falling back to ${fbLabel}`);
    const fallbackMessages = isContextErr ? trimMessagesForFallback(messages) : messages;
    // So crew-lead knows which model is actually running when on fallback
    const primaryLabel = `${providerKey}/${modelId}`;
    const fallbackMessagesWithModelNote = patchMessagesWithActiveModel(fallbackMessages, fbLabel, primaryLabel, reason);

    try {
      // Disable streaming for fallback (simplicity)
      const fallbackOptions = { ...options, stream: false };
      const reply = await _callLLMOnce(cfg.fallbackProvider.baseUrl, cfg.fallbackProvider.apiKey, cfg.fallbackModelId, cfg.fallbackProviderKey, fallbackMessagesWithModelNote, fallbackOptions);
      const fbUrl = `${cfg.fallbackProvider.baseUrl.replace(/\/$/, "")}/chat/completions`;
      console.log(`[crew-lead] LLM reply from fallback ${fbLabel} @ ${fbUrl}`);
      return { reply, usedFallback: true, model: fbLabel, reason };
    } catch (fbErr) {
      const fbContextErr = /400|context.*length|too long|reduce.*length|max.*token|content_length|please reduce/i.test(fbErr.message);
      if (fbContextErr) {
        console.log(`[crew-lead] Fallback also hit context limit — retrying with aggressively trimmed messages`);
        const trimmed = trimMessagesForFallback(messages);
        const trimmedWithNote = patchMessagesWithActiveModel(trimmed, fbLabel, `${providerKey}/${modelId}`, "context length (trimmed)");
        const fallbackOptions = { ...options, stream: false };
        const reply = await _callLLMOnce(cfg.fallbackProvider.baseUrl, cfg.fallbackProvider.apiKey, cfg.fallbackModelId, cfg.fallbackProviderKey, trimmedWithNote, fallbackOptions);
        const fbUrl = `${cfg.fallbackProvider.baseUrl.replace(/\/$/, "")}/chat/completions`;
        console.log(`[crew-lead] LLM reply from fallback ${fbLabel} (trimmed) @ ${fbUrl}`);
        return { reply, usedFallback: true, model: fbLabel, reason: "context length (trimmed)" };
      }
      throw fbErr;
    }
  }
}
