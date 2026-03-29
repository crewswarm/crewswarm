import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { initLlmCaller, callLLM } from "../../lib/crew-lead/llm-caller.mjs";

const origFetch = globalThis.fetch;

function installFetchMock(impl) {
  globalThis.fetch = async (url, opts) => impl(url, opts);
}

function restoreFetch() {
  globalThis.fetch = origFetch;
}

const cfg = {
  provider: { baseUrl: "https://api.primary.com/v1", apiKey: "sk-primary" },
  modelId: "gpt-5.4",
  providerKey: "openai",
  fallbackProvider: { baseUrl: "https://api.fallback.com/v1", apiKey: "sk-fallback" },
  fallbackModelId: "llama-3.3-70b",
  fallbackProviderKey: "groq",
};

describe("LLM failover matrix", () => {
  before(() => initLlmCaller({ llmTimeout: 5000 }));
  after(() => restoreFetch());

  test("falls back on quota exceeded errors", async () => {
    let calls = 0;
    installFetchMock(async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: false, status: 429, text: async () => "quota exceeded for this account" };
      }
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "quota-fallback-ok" } }] }),
      };
    });

    const result = await callLLM([{ role: "user", content: "hello" }], cfg);
    assert.equal(result.usedFallback, true);
    assert.equal(result.reason, "rate limit");
    assert.equal(result.reply, "quota-fallback-ok");
  });

  test("falls back on context-length errors", async () => {
    let calls = 0;
    installFetchMock(async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: false, status: 400, text: async () => "Please reduce context length: too long" };
      }
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "context-fallback-ok" } }] }),
      };
    });

    const messages = [
      { role: "system", content: "x".repeat(2000) },
      { role: "user", content: "summarize" },
    ];
    const result = await callLLM(messages, cfg);
    assert.equal(result.usedFallback, true);
    assert.match(result.reason, /context length/);
    assert.equal(result.reply, "context-fallback-ok");
  });

  test("does not fall back on unrelated 500 errors", async () => {
    installFetchMock(async () => ({
      ok: false,
      status: 500,
      text: async () => "internal server error",
    }));

    await assert.rejects(
      () => callLLM([{ role: "user", content: "hello" }], cfg),
      /LLM 500/,
    );
  });
});
