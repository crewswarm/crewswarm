/**
 * Unit tests for lib/crew-lead/llm-caller.mjs
 *
 * Tests exported functions: initLlmCaller, patchMessagesWithActiveModel,
 * trimMessagesForFallback. Skips _callLLMOnce and callLLM (network).
 *
 * Run with: node --test test/unit/llm-caller.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  initLlmCaller,
  normalizeExternalModelId,
  patchMessagesWithActiveModel,
  trimMessagesForFallback,
} from "../../lib/crew-lead/llm-caller.mjs";

// ---------------------------------------------------------------------------
// initLlmCaller
// ---------------------------------------------------------------------------

describe("initLlmCaller", () => {
  it("accepts empty options without throwing", () => {
    assert.doesNotThrow(() => initLlmCaller());
  });

  it("accepts a custom llmTimeout", () => {
    assert.doesNotThrow(() => initLlmCaller({ llmTimeout: 5000 }));
  });
});

describe("normalizeExternalModelId", () => {
  it("strips openrouter prefix for raw OpenRouter API calls", () => {
    assert.equal(
      normalizeExternalModelId(
        "openrouter/ai21/jamba-large-1.7",
        "openrouter",
        "https://openrouter.ai/api/v1",
      ),
      "ai21/jamba-large-1.7",
    );
  });

  it("strips perplexity prefix for raw Perplexity API calls", () => {
    assert.equal(
      normalizeExternalModelId(
        "perplexity/sonar",
        "perplexity",
        "https://api.perplexity.ai",
      ),
      "sonar",
    );
  });

  it("leaves normal provider-native model IDs unchanged", () => {
    assert.equal(
      normalizeExternalModelId(
        "claude-3-haiku-20240307",
        "anthropic",
        "https://api.anthropic.com/v1",
      ),
      "claude-3-haiku-20240307",
    );
  });
});

// ---------------------------------------------------------------------------
// patchMessagesWithActiveModel
// ---------------------------------------------------------------------------

describe("patchMessagesWithActiveModel", () => {
  const base = [
    { role: "system", content: "You are crew-lead." },
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there" },
  ];

  it("prepends fallback note to the system message", () => {
    const patched = patchMessagesWithActiveModel(
      base,
      "groq/llama-3.3-70b",
      "anthropic/claude-sonnet-4",
      "rate limit",
    );
    assert.ok(patched[0].content.includes("FALLBACK"));
    assert.ok(patched[0].content.includes("groq/llama-3.3-70b"));
    assert.ok(patched[0].content.includes("rate limit"));
    // Original system prompt is still present after the note
    assert.ok(patched[0].content.includes("You are crew-lead."));
  });

  it("does not mutate the original messages array", () => {
    const original = base.map((m) => ({ ...m }));
    patchMessagesWithActiveModel(base, "x/y", "a/b", "error");
    assert.deepEqual(base, original);
  });

  it("returns unmodified messages when there is no system message", () => {
    const noSystem = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ];
    const result = patchMessagesWithActiveModel(noSystem, "x/y", "a/b", "err");
    assert.equal(result.length, noSystem.length);
    // No system message to patch, so content stays the same
    assert.equal(result[0].content, "Hi");
  });

  it("patches health snapshot in user messages to show fallback model", () => {
    const msgs = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "crew-lead: anthropic/claude-sonnet-4 | status" },
    ];
    const patched = patchMessagesWithActiveModel(
      msgs,
      "groq/llama-70b",
      "anthropic/claude-sonnet-4",
      "rate limit",
    );
    assert.ok(patched[1].content.includes("groq/llama-70b"));
    assert.ok(patched[1].content.includes("fallback"));
  });
});

// ---------------------------------------------------------------------------
// trimMessagesForFallback
// ---------------------------------------------------------------------------

describe("trimMessagesForFallback", () => {
  it("returns messages unchanged when 3 or fewer", () => {
    const short = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const trimmed = trimMessagesForFallback(short);
    assert.equal(trimmed.length, 3);
    assert.equal(trimmed[0].content, "sys");
  });

  it("truncates long system prompts", () => {
    const longSystem = "x".repeat(3000);
    const msgs = [
      { role: "system", content: longSystem },
      { role: "user", content: "a" },
      { role: "user", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
    ];
    const trimmed = trimMessagesForFallback(msgs);
    assert.ok(trimmed[0].content.length < longSystem.length);
    assert.ok(trimmed[0].content.includes("[...system prompt trimmed"));
  });

  it("preserves memory injection messages", () => {
    const msgs = [
      { role: "system", content: "sys" },
      { role: "user", content: "[Shared memory — crew context]" },
      { role: "user", content: "[Project memory — roadmap]" },
      { role: "user", content: "msg1" },
      { role: "user", content: "msg2" },
      { role: "user", content: "msg3" },
      { role: "assistant", content: "reply1" },
      { role: "user", content: "msg4" },
      { role: "assistant", content: "reply2" },
      { role: "user", content: "msg5" },
      { role: "assistant", content: "reply3" },
    ];
    const trimmed = trimMessagesForFallback(msgs);
    // Memory messages should be preserved
    const memoryMsgs = trimmed.filter(
      (m) => m.content.startsWith("[Shared memory") || m.content.startsWith("[Project memory"),
    );
    assert.equal(memoryMsgs.length, 2);
  });

  it("truncates long individual messages in trimmed output", () => {
    const longContent = "y".repeat(3000);
    const msgs = [
      { role: "system", content: "sys" },
      { role: "user", content: longContent },
      { role: "assistant", content: "short" },
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
    ];
    const trimmed = trimMessagesForFallback(msgs);
    for (const m of trimmed) {
      if (m.role !== "system") {
        assert.ok(m.content.length <= 2100, `message should be capped: ${m.content.length}`);
      }
    }
  });

  it("keeps at most 6 recent non-memory messages plus system and memory", () => {
    const msgs = [
      { role: "system", content: "sys" },
      ...Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `msg-${i}`,
      })),
    ];
    const trimmed = trimMessagesForFallback(msgs);
    // system (1) + up to 6 recent = max 7
    assert.ok(trimmed.length <= 7, `trimmed to ${trimmed.length}, expected <= 7`);
  });

  it("truncates memory messages when they are too long", () => {
    const longMemory = "[Shared memory — " + "z".repeat(2000);
    const msgs = [
      { role: "system", content: "sys" },
      { role: "user", content: longMemory },
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
    ];
    const trimmed = trimMessagesForFallback(msgs);
    const mem = trimmed.find((m) => m.content.startsWith("[Shared memory"));
    assert.ok(mem, "memory message should be present");
    assert.ok(mem.content.includes("[...memory trimmed]"));
    assert.ok(mem.content.length <= 1600);
  });
});
