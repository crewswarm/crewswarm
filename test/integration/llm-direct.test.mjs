/**
 * Integration tests for LLM direct calls.
 * Tests lib/crew-lead/llm-caller.mjs (callLLM, _callLLMOnce) — the importable LLM logic
 * used by crew-lead. callLLMDirect in lib/engines/llm-direct.mjs has similar behavior
 * but requires gateway-bridge deps; llm-caller is the canonical testable implementation.
 *
 * Mocks fetch to avoid real API calls.
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  initLlmCaller,
  callLLM,
  _callLLMOnce,
} from "../../lib/crew-lead/llm-caller.mjs";

const origFetch = globalThis.fetch;
let fetchCalls = [];

function installFetchMock(impl) {
  fetchCalls = [];
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return impl(url, opts);
  };
}

function restoreFetch() {
  globalThis.fetch = origFetch;
}

// ── Successful response ─────────────────────────────────────────────────────

describe("Successful response", () => {
  before(() => initLlmCaller({ llmTimeout: 5000 }));
  beforeEach(() => {
    installFetchMock(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "hello" } }] }),
    }));
  });
  after(restoreFetch);

  test("_callLLMOnce returns content from choices[0].message.content", async () => {
    const reply = await _callLLMOnce(
      "https://api.example.com/v1",
      "sk-test",
      "gpt-4",
      "openai",
      [{ role: "user", content: "hi" }]
    );
    assert.equal(reply, "hello");
  });

  test("callLLM returns reply in result object", async () => {
    const cfg = {
      provider: { baseUrl: "https://api.example.com/v1", apiKey: "sk-test" },
      modelId: "gpt-4",
      providerKey: "openai",
    };
    const result = await callLLM([{ role: "user", content: "hi" }], cfg);
    assert.equal(result.reply, "hello");
    assert.equal(result.usedFallback, false);
  });
});

// ── Provider selection (headers use correct API key) ─────────────────────────

describe("Provider selection", () => {
  before(() => initLlmCaller({ llmTimeout: 5000 }));
  beforeEach(() => {
    installFetchMock(async (url, opts) => {
      const auth = opts?.headers?.authorization || opts?.headers?.["x-api-key"];
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        _auth: auth,
      };
    });
  });
  after(restoreFetch);

  test("groq-style model uses Bearer token in Authorization header", async () => {
    await _callLLMOnce(
      "https://api.groq.com/openai/v1",
      "groq-key-123",
      "llama-3.1-8b-instant",
      "groq",
      [{ role: "user", content: "hi" }]
    );
    assert.equal(fetchCalls.length, 1);
    const auth = fetchCalls[0].opts?.headers?.authorization;
    assert.ok(auth, "should have Authorization header");
    assert.equal(auth, "Bearer groq-key-123");
  });

  test("Anthropic uses x-api-key header", async () => {
    installFetchMock(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    }));
    await _callLLMOnce(
      "https://api.anthropic.com/v1",
      "sk-ant-123",
      "claude-3-sonnet",
      "anthropic",
      [{ role: "user", content: "hi" }]
    );
    assert.equal(fetchCalls.length, 1);
    const xKey = fetchCalls[0].opts?.headers?.["x-api-key"];
    assert.equal(xKey, "sk-ant-123");
  });
});

// ── Retry on 429 ───────────────────────────────────────────────────────────

describe("Retry on 429", () => {
  before(() => initLlmCaller({ llmTimeout: 5000 }));
  after(restoreFetch);

  test("callLLM falls back to fallback provider on 429 from primary", async () => {
    let callCount = 0;
    installFetchMock(async (url) => {
      callCount++;
      if (callCount === 1) {
        return { ok: false, status: 429, text: async () => "rate limit" };
      }
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "fallback-ok" } }] }),
      };
    });

    const cfg = {
      provider: { baseUrl: "https://api.primary.com/v1", apiKey: "sk-primary" },
      modelId: "gpt-4",
      providerKey: "openai",
      fallbackProvider: { baseUrl: "https://api.fallback.com/v1", apiKey: "sk-fb" },
      fallbackModelId: "llama-3",
      fallbackProviderKey: "groq",
    };
    const result = await callLLM([{ role: "user", content: "hi" }], cfg);
    assert.equal(result.reply, "fallback-ok");
    assert.equal(result.usedFallback, true);
    assert.ok(callCount >= 2, "should have retried via fallback");
  });
});

// ── Error on 500 ───────────────────────────────────────────────────────────

describe("Error on 500", () => {
  before(() => initLlmCaller({ llmTimeout: 5000 }));
  beforeEach(() => {
    installFetchMock(async () => ({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    }));
  });
  after(restoreFetch);

  test("_callLLMOnce throws on 500", async () => {
    await assert.rejects(
      async () =>
        _callLLMOnce(
          "https://api.example.com/v1",
          "sk-test",
          "gpt-4",
          "openai",
          [{ role: "user", content: "hi" }]
        ),
      /LLM 500/
    );
  });

  test("callLLM throws when no fallback configured", async () => {
    const cfg = {
      provider: { baseUrl: "https://api.example.com/v1", apiKey: "sk-test" },
      modelId: "gpt-4",
      providerKey: "openai",
    };
    await assert.rejects(
      async () => callLLM([{ role: "user", content: "hi" }], cfg),
      /LLM 500/
    );
  });
});

// ── Empty response ──────────────────────────────────────────────────────────

describe("Empty response", () => {
  before(() => initLlmCaller({ llmTimeout: 5000 }));
  after(restoreFetch);

  test("_callLLMOnce returns empty string when choices is empty", async () => {
    installFetchMock(async () => ({
      ok: true,
      json: async () => ({ choices: [] }),
    }));
    const reply = await _callLLMOnce(
      "https://api.example.com/v1",
      "sk-test",
      "gpt-4",
      "openai",
      [{ role: "user", content: "hi" }]
    );
    assert.equal(reply, "");
  });

  test("_callLLMOnce returns empty string when choices[0].message.content is missing", async () => {
    installFetchMock(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: {} }] }),
    }));
    const reply = await _callLLMOnce(
      "https://api.example.com/v1",
      "sk-test",
      "gpt-4",
      "openai",
      [{ role: "user", content: "hi" }]
    );
    assert.equal(reply, "");
  });
});

// ── Token tracking ──────────────────────────────────────────────────────────

describe("Token tracking", () => {
  before(() => initLlmCaller({ llmTimeout: 5000 }));
  after(restoreFetch);

  test("_callLLMOnce records usage when response includes usage", async () => {
    const tokenUsagePath = path.join(os.homedir(), ".crewswarm", "token-usage.json");
    let beforeCalls = 0;
    try {
      beforeCalls = JSON.parse(fs.readFileSync(tokenUsagePath, "utf8")).calls || 0;
    } catch {}

    installFetchMock(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "tokens" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    }));

    await _callLLMOnce(
      "https://api.example.com/v1",
      "sk-test",
      "gpt-4",
      "openai",
      [{ role: "user", content: "hi" }]
    );

    let afterData = {};
    try {
      afterData = JSON.parse(fs.readFileSync(tokenUsagePath, "utf8"));
    } catch {}
    assert.ok(afterData.calls >= beforeCalls, "token usage should be recorded");
    assert.ok(
      (afterData.prompt || 0) >= 10 && (afterData.completion || 0) >= 5,
      "usage fields should reflect prompt/completion tokens"
    );
  });
});

// ── Timeout ──────────────────────────────────────────────────────────────────

describe("Timeout", () => {
  after(restoreFetch);

  test("_callLLMOnce rejects when AbortSignal fires (timeout)", async () => {
    initLlmCaller({ llmTimeout: 5 }); // 5ms — very short
    installFetchMock(async (url, opts) => {
      // Mock must respect opts.signal — when it aborts, reject
      const delay = new Promise((r) => setTimeout(r, 50));
      const abort = new Promise((_, reject) => {
        if (!opts?.signal) return;
        if (opts.signal.aborted) {
          reject(new DOMException("The operation was aborted", "AbortError"));
          return;
        }
        opts.signal.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted", "AbortError")),
          { once: true }
        );
      });
      await Promise.race([delay, abort]);
      return { ok: true, json: async () => ({ choices: [{ message: { content: "late" } }] }) };
    });

    await assert.rejects(
      async () =>
        _callLLMOnce(
          "https://api.example.com/v1",
          "sk-test",
          "gpt-4",
          "openai",
          [{ role: "user", content: "hi" }]
        ),
      (err) => err?.name === "AbortError" || /abort|timeout/i.test(String(err?.message))
    );
  });
});
