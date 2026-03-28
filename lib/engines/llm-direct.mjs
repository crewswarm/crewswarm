let _deps = {};

export function initLlmDirect(deps) {
  _deps = deps;
}

export async function callLLMDirect(prompt, ocAgentId, systemPrompt) {
  const {
    loadAgentLLMConfig, checkSpendingCap, notifyTelegramSpending,
    recordTokenUsage, loadProviderMap,
  } = _deps;
  const llm = loadAgentLLMConfig(ocAgentId);
  if (!llm) {
    console.error(`[llm-direct] loadAgentLLMConfig("${ocAgentId}") returned null. _deps set: ${!!_deps.loadAgentLLMConfig}. CREWSWARM_RT_AGENT=${process.env.CREWSWARM_RT_AGENT}`);
    return null; // fall through to legacy gateway
  }

  // ── Spending cap pre-check ─────────────────────────────────────────────────
  const capResult = checkSpendingCap(ocAgentId, llm.providerKey || llm.modelId.split("/")[0]);
  if (capResult.exceeded) {
    if (capResult.action === "stop")
      throw new Error(`SPENDING_CAP_STOP: ${capResult.message}`);
    if (capResult.action === "pause") {
      notifyTelegramSpending(`⚠️ ${capResult.message} — ${ocAgentId} paused`).catch(() => {});
      throw new Error(`SPENDING_CAP_PAUSE: ${capResult.message}`);
    }
    if (capResult.action === "notify") {
      notifyTelegramSpending(`⚠️ ${capResult.message} — continuing`).catch(() => {});
      console.warn(`[spending] ${capResult.message} (notify-only, continuing)`);
    }
  }

  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  try {
    // Gemini native API uses different format
    if (llm.api === "gemini") {
      const geminiPayload = {
        contents: [{ parts: [{ text: systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt }] }]
      };
      const res = await fetch(`${llm.baseUrl.replace(/\/$/, "")}/models/${llm.modelId}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": llm.apiKey },
        body: JSON.stringify(geminiPayload),
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) {
        const err = await res.text().catch(() => res.statusText);
        if (res.status === 429) throw Object.assign(new Error(`RATE_LIMITED: ${err.slice(0, 200)}`), { isRateLimit: true });
        throw new Error(`LLM API ${res.status}: ${err.slice(0, 200)}`);
      }
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      if (!text) throw new Error("Empty response from Gemini");
      console.log(`[direct-llm] ${ocAgentId} via ${llm.modelId} — ${text.length} chars`);
      return text;
    }

    // OpenAI-compatible API (default)
    // Reasoning models (o1/o3/gpt-5 series) don't support max_tokens parameter
    const isReasoningModel = /^(o1|o3|gpt-5)/i.test(llm.modelId);
    const payload = { model: llm.modelId, messages, stream: false };
    if (!isReasoningModel) {
      payload.max_tokens = 8192;
    }
    const res = await fetch(`${llm.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      if (res.status === 429) throw Object.assign(new Error(`RATE_LIMITED: ${err.slice(0, 200)}`), { isRateLimit: true });
      throw new Error(`LLM API ${res.status}: ${err.slice(0, 200)}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || "";
    if (!text) throw new Error("Empty response from LLM");
    recordTokenUsage(llm.modelId, data.usage, ocAgentId);
    console.log(`[direct-llm] ${ocAgentId} via ${llm.modelId} — ${text.length} chars${data.usage ? ` (${(data.usage.prompt_tokens||0)+(data.usage.completion_tokens||0)} tokens)` : ""}`);
    return text;
  } catch (e) {
    if (e.isRateLimit) {
      console.error(`[direct-llm] ${ocAgentId} rate-limited (429) on ${llm.modelId} — waiting 10s then retry`);
      await new Promise(r => setTimeout(r, 10000));
      try {
        const payload2 = { model: llm.modelId, messages, stream: false };
        if (!isReasoningModel) {
          payload2.max_tokens = 8192;
        }
        const res2 = await fetch(`${llm.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${llm.apiKey}` },
          body: JSON.stringify(payload2),
          signal: AbortSignal.timeout(120000),
        });
        if (res2.ok) {
          const data2 = await res2.json();
          const text2 = data2?.choices?.[0]?.message?.content || "";
          if (text2) { console.log(`[direct-llm] ${ocAgentId} retry succeeded`); return text2; }
        }
      } catch {}
      console.error(`[direct-llm] ${ocAgentId} retry also failed — checking per-agent fallback`);
    } else {
      console.error(`[direct-llm] ${ocAgentId} failed: ${e.message} — checking per-agent fallback`);
    }

    // ── Per-agent fallback model ─────────────────────────────────────────────
    if (llm.fallbackModel) {
      try {
        const [fbProviderKey, ...fbModelParts] = llm.fallbackModel.split("/");
        const fbModelId = fbModelParts.join("/");
        const fbProviders = loadProviderMap();
        const fbProvider = fbProviders[fbProviderKey];
        if (fbProvider?.baseUrl && fbProvider?.apiKey) {
          console.warn(`[direct-llm] ${ocAgentId} → per-agent fallback (${llm.fallbackModel})`);
          const isFbReasoningModel = /^(o1|o3|gpt-5)/i.test(fbModelId);
          const fbPayload = { model: fbModelId, messages, stream: false };
          if (!isFbReasoningModel) {
            fbPayload.max_tokens = 8192;
          }
          const resFb = await fetch(`${(fbProvider.baseUrl || "").replace(/\/$/, "")}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${fbProvider.apiKey}` },
            body: JSON.stringify(fbPayload),
            signal: AbortSignal.timeout(60000),
          });
          if (resFb.ok) {
            const dataFb = await resFb.json();
            const textFb = dataFb?.choices?.[0]?.message?.content || "";
            if (textFb) {
              recordTokenUsage(fbModelId, dataFb.usage);
              console.log(`[direct-llm] ${ocAgentId} per-agent fallback succeeded (${textFb.length} chars)`);
              return textFb;
            }
          }
          console.error(`[direct-llm] Per-agent fallback also failed (${resFb.status}) — trying Groq global fallback`);
        } else {
          console.warn(`[direct-llm] Per-agent fallback provider "${fbProviderKey}" not configured — skipping`);
        }
      } catch (fbErr) {
        console.error(`[direct-llm] Per-agent fallback error: ${fbErr.message}`);
      }
    }

    // ── Global Groq fallback ─────────────────────────────────────────────────
    // If the agent's primary provider fails (key missing, rate limit, outage),
    // retry on Groq llama-3.3-70b-versatile which is fast and free-tier eligible.
    try {
      const providers = loadProviderMap();
      const groq = providers["groq"];
      if (groq?.apiKey && groq?.baseUrl) {
        const GROQ_FALLBACK_MODEL = process.env.GROQ_FALLBACK_MODEL || "llama-3.3-70b-versatile";
        console.warn(`[direct-llm] ${ocAgentId} → Groq fallback (${GROQ_FALLBACK_MODEL})`);
        const isGroqReasoningModel = /^(o1|o3|gpt-5)/i.test(GROQ_FALLBACK_MODEL);
        const groqPayload = { model: GROQ_FALLBACK_MODEL, messages, stream: false };
        if (!isGroqReasoningModel) {
          groqPayload.max_tokens = 8192;
        }
        const res = await fetch(`${(groq.baseUrl || "").replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${groq.apiKey}` },
          body: JSON.stringify(groqPayload),
          signal: AbortSignal.timeout(60000),
        });
        if (res.ok) {
          const data = await res.json();
          const text = data?.choices?.[0]?.message?.content || "";
          if (text) {
            recordTokenUsage(GROQ_FALLBACK_MODEL, data.usage);
            console.log(`[direct-llm] ${ocAgentId} Groq fallback succeeded (${text.length} chars)`);
            return text;
          }
        }
        console.error(`[direct-llm] Groq fallback also failed (${res.status}) — giving up`);
      } else {
        console.warn(`[direct-llm] No Groq provider configured — cannot fallback`);
      }
    } catch (groqErr) {
      console.error(`[direct-llm] Groq fallback error: ${groqErr.message}`);
    }
    return null;
  }
}
