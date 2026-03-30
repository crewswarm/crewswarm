/**
 * Unit tests for lib/integrations/tts.mjs
 *
 * Tests the pure helper functions: stripMarkdownForTTS, truncateForTTS,
 * chunkTextForTTS, hasTTSProvider, getActiveTTSProviders, getVoiceForAgent.
 * Network-calling TTS functions are skipped.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  stripMarkdownForTTS,
  truncateForTTS,
  chunkTextForTTS,
  hasTTSProvider,
  getActiveTTSProviders,
  getVoiceForAgent,
  textToSpeech,
} from "../../lib/integrations/tts.mjs";

// ── stripMarkdownForTTS ──────────────────────────────────────────────────────

describe("stripMarkdownForTTS", () => {
  it("removes bold markdown", () => {
    assert.equal(stripMarkdownForTTS("This is **bold** text"), "This is bold text");
  });

  it("removes italic markdown", () => {
    assert.equal(stripMarkdownForTTS("This is *italic* text"), "This is italic text");
  });

  it("removes inline code", () => {
    assert.equal(stripMarkdownForTTS("Run `npm install` now"), "Run npm install now");
  });

  it("removes code blocks", () => {
    const input = "Before\n```js\nconsole.log('hi');\n```\nAfter";
    const result = stripMarkdownForTTS(input);
    assert.ok(result.includes("[code block]"));
    assert.ok(result.includes("Before"));
    assert.ok(result.includes("After"));
    assert.ok(!result.includes("console.log"));
  });

  it("removes links but keeps text", () => {
    assert.equal(stripMarkdownForTTS("See [docs](https://example.com) here"), "See docs here");
  });

  it("removes @@COMMANDS", () => {
    const result = stripMarkdownForTTS("Output: @@DISPATCH crew-coder fix bug\nDone");
    assert.ok(!result.includes("@@DISPATCH"));
    assert.ok(result.includes("Done"));
  });

  it("removes heading markers", () => {
    assert.equal(stripMarkdownForTTS("## Heading\nContent").trim(), "Heading Content");
  });

  it("removes list markers", () => {
    const input = "- Item one\n- Item two";
    const result = stripMarkdownForTTS(input);
    assert.ok(result.includes("Item one"));
    assert.ok(!result.startsWith("-"));
  });

  it("collapses multiple spaces", () => {
    const result = stripMarkdownForTTS("too   many    spaces");
    assert.equal(result, "too many spaces");
  });

  it("handles empty string", () => {
    assert.equal(stripMarkdownForTTS(""), "");
  });

  it("removes underscore bold", () => {
    assert.equal(stripMarkdownForTTS("__bold text__"), "bold text");
  });

  it("removes underscore italic", () => {
    assert.equal(stripMarkdownForTTS("_italic text_"), "italic text");
  });
});

// ── truncateForTTS ───────────────────────────────────────────────────────────

describe("truncateForTTS", () => {
  it("returns short text unchanged (after stripping)", () => {
    const result = truncateForTTS("Hello world.", 800);
    assert.equal(result, "Hello world.");
  });

  it("truncates at sentence boundary", () => {
    const input = "First sentence. Second sentence. Third sentence. Fourth sentence.";
    const result = truncateForTTS(input, 40);
    assert.ok(result.length <= 45); // 40 + ellipsis
    assert.ok(result.includes("First sentence."));
  });

  it("adds ellipsis when truncated", () => {
    const longText = Array(20).fill("This is a long sentence.").join(" ");
    const result = truncateForTTS(longText, 100);
    assert.ok(result.endsWith("..."));
  });

  it("strips markdown before truncating", () => {
    const input = "**Bold sentence.** Normal sentence.";
    const result = truncateForTTS(input, 800);
    assert.ok(!result.includes("**"));
    assert.ok(result.includes("Bold sentence."));
  });

  it("uses default maxChars of 800", () => {
    const longText = "A".repeat(900) + ".";
    const result = truncateForTTS(longText);
    assert.ok(result.length <= 810);
  });

  it("handles text with no sentence endings", () => {
    const input = "A".repeat(1000);
    const result = truncateForTTS(input, 100);
    assert.ok(result.length <= 110);
  });
});

// ── chunkTextForTTS ──────────────────────────────────────────────────────────

describe("chunkTextForTTS", () => {
  it("returns single chunk for short text", () => {
    const chunks = chunkTextForTTS("Hello world.");
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], "Hello world.");
  });

  it("returns non-empty chunks", () => {
    const chunks = chunkTextForTTS("Some text here. Another part.");
    assert.ok(chunks.length >= 1);
    for (const chunk of chunks) {
      assert.ok(chunk.length > 0);
    }
  });

  it("strips markdown in output", () => {
    const chunks = chunkTextForTTS("**Bold** and `code` text.");
    assert.ok(!chunks[0].includes("**"));
    assert.ok(!chunks[0].includes("`"));
  });
});

// ── hasTTSProvider / getActiveTTSProviders ────────────────────────────────────

describe("hasTTSProvider", () => {
  it("returns a boolean", () => {
    assert.equal(typeof hasTTSProvider(), "boolean");
  });
});

describe("getActiveTTSProviders", () => {
  it("returns an array", () => {
    assert.ok(Array.isArray(getActiveTTSProviders()));
  });

  it("only contains known provider names", () => {
    const valid = new Set(["elevenlabs", "google"]);
    for (const p of getActiveTTSProviders()) {
      assert.ok(valid.has(p), `Unexpected TTS provider: ${p}`);
    }
  });
});

// ── getVoiceForAgent ─────────────────────────────────────────────────────────

describe("getVoiceForAgent", () => {
  it("returns default voice for unknown agent with empty voiceMap", () => {
    const voice = getVoiceForAgent("crew-unknown", {});
    assert.equal(voice.provider, "auto");
    assert.ok(voice.voiceId);
    assert.ok(voice.voice);
    assert.ok(voice.modelId);
  });

  it("returns default voice when voiceMap is undefined", () => {
    const voice = getVoiceForAgent("crew-coder");
    assert.equal(voice.provider, "auto");
  });

  it("uses voiceMap entry when provided", () => {
    const voiceMap = {
      "crew-coder": { voiceId: "custom-voice-id", provider: "elevenlabs" },
    };
    const voice = getVoiceForAgent("crew-coder", voiceMap);
    assert.equal(voice.voiceId, "custom-voice-id");
    assert.equal(voice.provider, "elevenlabs");
  });

  it("uses voice from voiceMap (Google-style voice name)", () => {
    const voiceMap = {
      "crew-pm": { voice: "en-US-Neural2-F", provider: "google" },
    };
    const voice = getVoiceForAgent("crew-pm", voiceMap);
    assert.equal(voice.voice, "en-US-Neural2-F");
    assert.equal(voice.provider, "google");
  });
});

// ── textToSpeech (provider selection) ────────────────────────────────────────

describe("textToSpeech (provider selection)", () => {
  it("throws for unknown provider", async () => {
    await assert.rejects(
      () => textToSpeech("hello", { provider: "nonexistent" }),
      /Unknown TTS provider/
    );
  });
});
