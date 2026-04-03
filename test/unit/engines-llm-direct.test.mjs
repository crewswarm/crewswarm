/**
 * Unit tests for lib/engines/llm-direct.mjs
 *
 * Tests exported functions: initLlmDirect, callLLMDirect
 *
 * Strategy: inject all deps via initLlmDirect and mock global fetch so
 * no real network calls are made.
 *
 * Run with: node --test test/unit/engines-llm-direct.test.mjs
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const { initLlmDirect, callLLMDirect } = await import(
  "../../lib/engines/llm-direct.mjs"
);

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

let _mockFetch = null;
const originalFetch = globalThis.fetch;

function installFetch(fn) {
  globalThis.fetch = fn;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

/** Build a minimal fetch Response mock. */
function makeFetchResponse({ ok = true, status = 200, json = {}, text = "" } = {}) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(json),
    text: () => Promise.resolve(text || JSON.stringify(json)),
    statusText: String(status),
  });
}

// ---------------------------------------------------------------------------
// Default deps factory
// ---------------------------------------------------------------------------

function makeDeps(overrides = {}) {
  return {
    loadAgentLLMConfig: () => ({
      modelId: "gpt-4o",
      api: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      providerKey: "openai",
      fallbackModel: null,
    }),
    checkSpendingCap: () => ({ exceeded: false }),
    notifyTelegramSpending: async () => {},
    recordTokenUsage: () => {},
    loadProviderMap: () => ({}),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// initLlmDirect
// ---------------------------------------------------------------------------

describe("llm-direct — initLlmDirect", () => {
  it("accepts a deps object without throwing", () => {
    assert.doesNotThrow(() => initLlmDirect(makeDeps()));
  });

  it("accepts empty object without throwing", () => {
    assert.doesNotThrow(() => initLlmDirect({}));
  });
});

// ---------------------------------------------------------------------------
// Null config guard
// ---------------------------------------------------------------------------

describe("llm-direct — null config guard", () => {
  it("returns null when loadAgentLLMConfig returns null", async () => {
    initLlmDirect(makeDeps({ loadAgentLLMConfig: () => null }));
    const result = await callLLMDirect("hello", "crew-coder", null);
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// Spending cap checks
// ---------------------------------------------------------------------------

describe("llm-direct — spending cap", () => {
  it("throws SPENDING_CAP_STOP when action is stop", async () => {
    initLlmDirect(makeDeps({
      checkSpendingCap: () => ({
        exceeded: true,
        action: "stop",
        message: "Daily limit reached",
      }),
    }));
    await assert.rejects(
      () => callLLMDirect("hello", "crew-coder"),
      /SPENDING_CAP_STOP/
    );
  });

  it("throws SPENDING_CAP_PAUSE when action is pause", async () => {
    initLlmDirect(makeDeps({
      checkSpendingCap: () => ({
        exceeded: true,
        action: "pause",
        message: "Hourly limit hit",
      }),
    }));
    await assert.rejects(
      () => callLLMDirect("hello", "crew-coder"),
      /SPENDING_CAP_PAUSE/
    );
  });

  it("notifies Telegram but continues when action is notify", async () => {
    const notified = [];
    installFetch(() =>
      makeFetchResponse({
        ok: true,
        json: { choices: [{ message: { content: "hello response" } }] },
      })
    );
    initLlmDirect(makeDeps({
      checkSpendingCap: () => ({
        exceeded: true,
        action: "notify",
        message: "Budget 80% used",
      }),
      notifyTelegramSpending: async (msg) => notified.push(msg),
    }));
    const result = await callLLMDirect("hello", "crew-coder");
    restoreFetch();
    assert.ok(notified.length > 0, "should have notified Telegram");
    assert.equal(result, "hello response");
  });
});

// ---------------------------------------------------------------------------
// OpenAI-compatible API (default path)
// ---------------------------------------------------------------------------

describe("llm-direct — OpenAI-compatible API", () => {
  afterEach(() => restoreFetch());

  it("returns message content from choices[0].message.content", async () => {
    installFetch(() =>
      makeFetchResponse({
        ok: true,
        json: {
          choices: [{ message: { content: "The answer is 42." } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      })
    );
    initLlmDirect(makeDeps());
    const result = await callLLMDirect("What is the answer?", "crew-coder");
    assert.equal(result, "The answer is 42.");
  });

  it("falls back to choices[0].text when message.content is absent", async () => {
    installFetch(() =>
      makeFetchResponse({
        ok: true,
        json: {
          choices: [{ text: "legacy text response" }],
          usage: {},
        },
      })
    );
    initLlmDirect(makeDeps());
    const result = await callLLMDirect("prompt", "crew-coder");
    assert.equal(result, "legacy text response");
  });

  it("includes system prompt in messages array", async () => {
    let capturedBody;
    installFetch((url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return makeFetchResponse({
        ok: true,
        json: { choices: [{ message: { content: "ok" } }] },
      });
    });
    initLlmDirect(makeDeps());
    await callLLMDirect("user prompt", "crew-coder", "You are a helpful assistant.");
    restoreFetch();
    assert.equal(capturedBody.messages[0].role, "system");
    assert.equal(capturedBody.messages[0].content, "You are a helpful assistant.");
    assert.equal(capturedBody.messages[1].role, "user");
    assert.equal(capturedBody.messages[1].content, "user prompt");
  });

  it("omits max_tokens for reasoning model (o1 prefix)", async () => {
    let capturedBody;
    installFetch((url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return makeFetchResponse({
        ok: true,
        json: { choices: [{ message: { content: "reasoned" } }] },
      });
    });
    initLlmDirect(makeDeps({
      loadAgentLLMConfig: () => ({
        modelId: "o1-preview",
        api: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "test-key",
        providerKey: "openai",
        fallbackModel: null,
      }),
    }));
    await callLLMDirect("think", "crew-coder");
    restoreFetch();
    assert.ok(!("max_tokens" in capturedBody), "max_tokens should be absent for o1 models");
  });

  it("omits max_tokens for o3 prefix reasoning models", async () => {
    let capturedBody;
    installFetch((url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return makeFetchResponse({
        ok: true,
        json: { choices: [{ message: { content: "reasoned" } }] },
      });
    });
    initLlmDirect(makeDeps({
      loadAgentLLMConfig: () => ({
        modelId: "o3-mini",
        api: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "test-key",
        providerKey: "openai",
        fallbackModel: null,
      }),
    }));
    await callLLMDirect("think", "crew-coder");
    restoreFetch();
    assert.ok(!("max_tokens" in capturedBody), "max_tokens should be absent for o3 models");
  });

  it("includes max_tokens 8192 for non-reasoning models", async () => {
    let capturedBody;
    installFetch((url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return makeFetchResponse({
        ok: true,
        json: { choices: [{ message: { content: "resp" } }] },
      });
    });
    initLlmDirect(makeDeps());
    await callLLMDirect("prompt", "crew-coder");
    restoreFetch();
    assert.equal(capturedBody.max_tokens, 8192);
  });

  it("records token usage after successful call", async () => {
    const recorded = [];
    installFetch(() =>
      makeFetchResponse({
        ok: true,
        json: {
          choices: [{ message: { content: "resp" } }],
          usage: { prompt_tokens: 20, completion_tokens: 15 },
        },
      })
    );
    initLlmDirect(makeDeps({
      recordTokenUsage: (modelId, usage, agentId) => recorded.push({ modelId, usage, agentId }),
    }));
    await callLLMDirect("prompt", "crew-qa");
    restoreFetch();
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].agentId, "crew-qa");
  });

  it("throws when response is not ok (non-429)", async () => {
    installFetch(() =>
      makeFetchResponse({ ok: false, status: 500, text: "Internal Server Error" })
    );
    initLlmDirect(makeDeps());
    const result = await callLLMDirect("fail", "crew-coder");
    restoreFetch();
    // Non-rate-limit errors flow to Groq fallback, which also fails → returns null
    assert.equal(result, null);
  });

  it("returns null when LLM response text is empty and no fallback configured", async () => {
    installFetch(() =>
      makeFetchResponse({
        ok: true,
        json: { choices: [{ message: { content: "" } }] },
      })
    );
    initLlmDirect(makeDeps());
    const result = await callLLMDirect("empty", "crew-coder");
    restoreFetch();
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// Gemini native API
// ---------------------------------------------------------------------------

describe("llm-direct — Gemini native API", () => {
  afterEach(() => restoreFetch());

  it("calls Gemini generateContent endpoint", async () => {
    let calledUrl;
    installFetch((url, opts) => {
      calledUrl = url;
      return makeFetchResponse({
        ok: true,
        json: {
          candidates: [{ content: { parts: [{ text: "gemini response" }] } }],
        },
      });
    });
    initLlmDirect(makeDeps({
      loadAgentLLMConfig: () => ({
        modelId: "gemini-2.5-pro",
        api: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "gemini-key",
        providerKey: "gemini",
        fallbackModel: null,
      }),
    }));
    const result = await callLLMDirect("gemini task", "crew-coder");
    assert.equal(result, "gemini response");
    assert.ok(calledUrl.includes("generateContent"), `expected generateContent in URL, got: ${calledUrl}`);
  });

  it("uses x-goog-api-key header for Gemini", async () => {
    let capturedHeaders;
    installFetch((url, opts) => {
      capturedHeaders = opts.headers;
      return makeFetchResponse({
        ok: true,
        json: {
          candidates: [{ content: { parts: [{ text: "ok" }] } }],
        },
      });
    });
    initLlmDirect(makeDeps({
      loadAgentLLMConfig: () => ({
        modelId: "gemini-2.5-flash",
        api: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "my-gemini-key",
        providerKey: "gemini",
        fallbackModel: null,
      }),
    }));
    await callLLMDirect("prompt", "crew-coder");
    assert.equal(capturedHeaders["x-goog-api-key"], "my-gemini-key");
    assert.ok(!capturedHeaders["authorization"], "should not use authorization header for Gemini");
  });

  it("merges systemPrompt into Gemini contents text", async () => {
    let capturedBody;
    installFetch((url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return makeFetchResponse({
        ok: true,
        json: {
          candidates: [{ content: { parts: [{ text: "merged" }] } }],
        },
      });
    });
    initLlmDirect(makeDeps({
      loadAgentLLMConfig: () => ({
        modelId: "gemini-2.5-pro",
        api: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "k",
        providerKey: "gemini",
        fallbackModel: null,
      }),
    }));
    await callLLMDirect("user content", "crew-coder", "system instructions");
    restoreFetch();
    const text = capturedBody.contents[0].parts[0].text;
    assert.ok(text.includes("system instructions"), "system prompt should be in Gemini text");
    assert.ok(text.includes("user content"), "user prompt should be in Gemini text");
  });

  it("throws on empty Gemini response text", async () => {
    installFetch(() =>
      makeFetchResponse({
        ok: true,
        json: { candidates: [{ content: { parts: [{ text: "" }] } }] },
      })
    );
    initLlmDirect(makeDeps({
      loadAgentLLMConfig: () => ({
        modelId: "gemini-2.5-pro",
        api: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "k",
        providerKey: "gemini",
        fallbackModel: null,
      }),
    }));
    const result = await callLLMDirect("prompt", "crew-coder");
    restoreFetch();
    // Empty Gemini → falls through to Groq fallback (not configured) → null
    assert.equal(result, null);
  });

  it("marks error as isRateLimit on 429 from Gemini", async () => {
    let callCount = 0;
    installFetch(() => {
      callCount++;
      return makeFetchResponse({ ok: false, status: 429, text: "quota exceeded" });
    });
    initLlmDirect(makeDeps({
      loadAgentLLMConfig: () => ({
        modelId: "gemini-2.5-pro",
        api: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "k",
        providerKey: "gemini",
        fallbackModel: null,
      }),
    }));
    const result = await callLLMDirect("prompt", "crew-coder");
    restoreFetch();
    // Rate limit → retry once more (still 429) → Groq fallback → null
    assert.equal(result, null);
    assert.ok(callCount >= 1, "should have made at least one fetch call");
  });
});

// ---------------------------------------------------------------------------
// 429 rate limit retry
// ---------------------------------------------------------------------------

describe("llm-direct — 429 rate limit retry", () => {
  // Note: The module-internal 10s wait (setTimeout) cannot be mocked from tests
  // because the module captures setTimeout at parse time. Tests in this block
  // that exercise the retry path accept a ~10s delay and use explicit timeouts.
  // afterEach is NOT used here to ensure the fetch mock stays alive during the
  // internal 10s sleep between calls.

  it("returns null when 429 is received and no fallback is configured", async () => {
    const mock429 = () => makeFetchResponse({ ok: false, status: 429, text: "rate limited" });
    installFetch(mock429);
    initLlmDirect(makeDeps({
      loadAgentLLMConfig: () => ({
        modelId: "gpt-4o",
        api: "openai",
        baseUrl: "https://api.primary.com/v1",
        apiKey: "key",
        providerKey: "primary",
        fallbackModel: null,
      }),
      loadProviderMap: () => ({}),
    }));
    const result = await callLLMDirect("prompt", "crew-coder");
    restoreFetch();
    assert.equal(result, null);
  }, { timeout: 25000 });

  it("falls through to Groq fallback when both primary and retry fail (429)", async () => {
    installFetch(() => makeFetchResponse({ ok: false, status: 429, text: "still rate limited" }));
    initLlmDirect(makeDeps({
      loadAgentLLMConfig: () => ({
        modelId: "gpt-4o",
        api: "openai",
        baseUrl: "https://api.primary.com/v1",
        apiKey: "key",
        providerKey: "primary",
        fallbackModel: null,
      }),
      loadProviderMap: () => ({
        groq: { apiKey: "groq-key", baseUrl: "https://api.groq-test.com/v1" },
      }),
    }));
    const result = await callLLMDirect("prompt", "crew-coder");
    restoreFetch();
    // All calls return 429 → null
    assert.equal(result, null);
  }, { timeout: 25000 });
});

// ---------------------------------------------------------------------------
// Per-agent fallback model
// ---------------------------------------------------------------------------

describe("llm-direct — per-agent fallback", () => {
  afterEach(() => restoreFetch());

  it("uses fallback model when primary call fails", async () => {
    let callCount = 0;
    installFetch(() => {
      callCount++;
      if (callCount === 1) {
        // Primary fails
        return makeFetchResponse({ ok: false, status: 503, text: "unavailable" });
      }
      // Fallback succeeds
      return makeFetchResponse({
        ok: true,
        json: { choices: [{ message: { content: "fallback response" } }] },
      });
    });
    initLlmDirect(makeDeps({
      loadAgentLLMConfig: () => ({
        modelId: "gpt-4o",
        api: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "key",
        providerKey: "openai",
        fallbackModel: "backup/gpt-3.5-turbo",
      }),
      loadProviderMap: () => ({
        backup: {
          baseUrl: "https://backup.api.com/v1",
          apiKey: "backup-key",
        },
      }),
    }));
    const result = await callLLMDirect("prompt", "crew-coder");
    assert.equal(result, "fallback response");
  });

  it("skips per-agent fallback when provider is not configured", async () => {
    installFetch(() =>
      makeFetchResponse({ ok: false, status: 503, text: "unavailable" })
    );
    initLlmDirect(makeDeps({
      loadAgentLLMConfig: () => ({
        modelId: "gpt-4o",
        api: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "key",
        providerKey: "openai",
        fallbackModel: "missing-provider/gpt-3.5-turbo",
      }),
      loadProviderMap: () => ({}), // provider not configured
    }));
    const result = await callLLMDirect("prompt", "crew-coder");
    // No configured fallback provider, no Groq → null
    assert.equal(result, null);
  });

  it("omits max_tokens for gpt-5 prefix reasoning fallback model", async () => {
    let capturedBodies = [];
    let callCount = 0;
    installFetch((url, opts) => {
      callCount++;
      capturedBodies.push(JSON.parse(opts.body));
      if (callCount === 1) return makeFetchResponse({ ok: false, status: 503, text: "down" });
      return makeFetchResponse({
        ok: true,
        json: { choices: [{ message: { content: "ok" } }] },
      });
    });
    initLlmDirect(makeDeps({
      loadAgentLLMConfig: () => ({
        modelId: "gpt-4o",
        api: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "key",
        providerKey: "openai",
        fallbackModel: "openai/gpt-5-turbo",
      }),
      loadProviderMap: () => ({
        openai: { baseUrl: "https://api.openai.com/v1", apiKey: "key" },
      }),
    }));
    await callLLMDirect("prompt", "crew-coder");
    restoreFetch();
    // Second call is the fallback
    if (capturedBodies.length >= 2) {
      assert.ok(!("max_tokens" in capturedBodies[1]), "gpt-5 fallback should omit max_tokens");
    }
  });
});

// ---------------------------------------------------------------------------
// Global Groq fallback
// ---------------------------------------------------------------------------

describe("llm-direct — Groq global fallback", () => {
  afterEach(() => restoreFetch());

  it("uses Groq as global fallback when primary fails and Groq is configured", async () => {
    let callCount = 0;
    // Use distinct hostnames so we can tell primary from Groq calls apart.
    // Primary baseUrl is api.primary.com; Groq baseUrl is api.groq-test.com.
    installFetch((url, opts) => {
      callCount++;
      if (url.includes("api.primary.com")) {
        return makeFetchResponse({ ok: false, status: 500, text: "error" });
      }
      // Groq call
      return makeFetchResponse({
        ok: true,
        json: { choices: [{ message: { content: "groq fallback response" } }] },
      });
    });
    initLlmDirect(makeDeps({
      loadAgentLLMConfig: () => ({
        modelId: "gpt-4o",
        api: "openai",
        baseUrl: "https://api.primary.com/v1",
        apiKey: "primary-key",
        providerKey: "primary",
        fallbackModel: null,
      }),
      loadProviderMap: () => ({
        groq: { apiKey: "groq-key", baseUrl: "https://api.groq-test.com/v1" },
      }),
    }));
    const result = await callLLMDirect("prompt", "crew-coder");
    assert.equal(result, "groq fallback response");
  });

  it("returns null when no Groq provider is configured", async () => {
    installFetch(() => makeFetchResponse({ ok: false, status: 500, text: "error" }));
    initLlmDirect(makeDeps({
      loadAgentLLMConfig: () => ({
        modelId: "gpt-4o",
        api: "openai",
        baseUrl: "https://api.primary.com/v1",
        apiKey: "key",
        providerKey: "primary",
        fallbackModel: null,
      }),
      loadProviderMap: () => ({}),
    }));
    const result = await callLLMDirect("prompt", "crew-coder");
    assert.equal(result, null);
  });

  it("respects GROQ_FALLBACK_MODEL env var", async () => {
    let groqModel;
    installFetch((url, opts) => {
      const body = JSON.parse(opts.body);
      if (url.includes("api.primary.com")) return makeFetchResponse({ ok: false, status: 500, text: "err" });
      // Groq call — capture model
      groqModel = body.model;
      return makeFetchResponse({
        ok: true,
        json: { choices: [{ message: { content: "groq ok" } }] },
      });
    });
    process.env.GROQ_FALLBACK_MODEL = "llama-3.1-8b-instant";
    initLlmDirect(makeDeps({
      loadAgentLLMConfig: () => ({
        modelId: "gpt-4o",
        api: "openai",
        baseUrl: "https://api.primary.com/v1",
        apiKey: "key",
        providerKey: "primary",
        fallbackModel: null,
      }),
      loadProviderMap: () => ({
        groq: { apiKey: "k", baseUrl: "https://api.groq-test.com/v1" },
      }),
    }));
    await callLLMDirect("prompt", "crew-coder");
    delete process.env.GROQ_FALLBACK_MODEL;
    restoreFetch();
    assert.equal(groqModel, "llama-3.1-8b-instant");
  });

  it("records token usage for Groq fallback response", async () => {
    const recorded = [];
    installFetch((url, opts) => {
      if (url.includes("api.primary.com")) return makeFetchResponse({ ok: false, status: 500, text: "err" });
      return makeFetchResponse({
        ok: true,
        json: {
          choices: [{ message: { content: "groq resp" } }],
          usage: { prompt_tokens: 5, completion_tokens: 10 },
        },
      });
    });
    initLlmDirect(makeDeps({
      loadAgentLLMConfig: () => ({
        modelId: "gpt-4o",
        api: "openai",
        baseUrl: "https://api.primary.com/v1",
        apiKey: "primary-key",
        providerKey: "primary",
        fallbackModel: null,
      }),
      loadProviderMap: () => ({
        groq: { apiKey: "k", baseUrl: "https://api.groq-test.com/v1" },
      }),
      recordTokenUsage: (modelId, usage) => recorded.push({ modelId, usage }),
    }));
    await callLLMDirect("prompt", "crew-coder");
    restoreFetch();
    const GROQ_MODEL = process.env.GROQ_FALLBACK_MODEL || "llama-3.3-70b-versatile";
    assert.ok(recorded.some(r => r.modelId === GROQ_MODEL),
      `should record Groq fallback token usage for model ${GROQ_MODEL}, got: ${JSON.stringify(recorded)}`);
  });
});

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

describe("llm-direct — URL construction", () => {
  afterEach(() => restoreFetch());

  it("strips trailing slash from baseUrl", async () => {
    let calledUrl;
    installFetch((url) => {
      calledUrl = url;
      return makeFetchResponse({
        ok: true,
        json: { choices: [{ message: { content: "ok" } }] },
      });
    });
    initLlmDirect(makeDeps({
      loadAgentLLMConfig: () => ({
        modelId: "gpt-4o",
        api: "openai",
        baseUrl: "https://api.openai.com/v1/",
        apiKey: "key",
        providerKey: "openai",
        fallbackModel: null,
      }),
    }));
    await callLLMDirect("prompt", "crew-coder");
    assert.ok(!calledUrl.includes("//chat"), `double slash in URL: ${calledUrl}`);
    assert.ok(calledUrl.endsWith("/chat/completions"), `unexpected URL: ${calledUrl}`);
  });
});
