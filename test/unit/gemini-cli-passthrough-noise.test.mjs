/**
 * Unit tests for lib/gemini-cli-passthrough-noise.mjs
 *
 * Covers:
 *  - shouldSkipGeminiPassthroughLine: all skip patterns + keep patterns
 *  - filterGeminiPassthroughTextChunk: engine gating, multi-line filtering,
 *    ANSI stripping, empty/null inputs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  shouldSkipGeminiPassthroughLine,
  filterGeminiPassthroughTextChunk,
} from "../../lib/gemini-cli-passthrough-noise.mjs";

// ── shouldSkipGeminiPassthroughLine ──────────────────────────────────────────

describe("gemini-passthrough-noise — shouldSkipGeminiPassthroughLine: skip lines", () => {
  it("skips empty string", () => {
    assert.equal(shouldSkipGeminiPassthroughLine(""), true);
  });

  it("skips whitespace-only string", () => {
    assert.equal(shouldSkipGeminiPassthroughLine("   "), true);
  });

  it("skips null input", () => {
    assert.equal(shouldSkipGeminiPassthroughLine(null), true);
  });

  it("skips undefined input", () => {
    assert.equal(shouldSkipGeminiPassthroughLine(undefined), true);
  });

  it("skips 'YOLO mode is enabled' line", () => {
    assert.equal(shouldSkipGeminiPassthroughLine("YOLO mode is enabled"), true);
  });

  it("skips YOLO line case-insensitively", () => {
    assert.equal(shouldSkipGeminiPassthroughLine("yolo mode is enabled"), true);
  });

  it("skips 'All tool calls will be automatically approved'", () => {
    assert.equal(shouldSkipGeminiPassthroughLine("All tool calls will be automatically approved"), true);
  });

  it("skips 'Loaded cached credentials'", () => {
    assert.equal(shouldSkipGeminiPassthroughLine("Loaded cached credentials"), true);
  });

  it("skips 'Using bundled ...' lines", () => {
    assert.equal(shouldSkipGeminiPassthroughLine("Using bundled node runtime"), true);
  });

  it("skips 'Authenticated via ...' lines", () => {
    assert.equal(shouldSkipGeminiPassthroughLine("Authenticated via OAuth"), true);
  });

  it("skips 'OpenTelemetry ...' lines", () => {
    assert.equal(shouldSkipGeminiPassthroughLine("OpenTelemetry exporter started"), true);
  });

  it("skips lines with leading ANSI escape codes followed by skip pattern", () => {
    // ANSI reset + YOLO text
    const ansiYolo = "\u001b[0mYOLO mode is enabled";
    assert.equal(shouldSkipGeminiPassthroughLine(ansiYolo), true);
  });

  it("skips lines with carriage returns (\\r\\n)", () => {
    assert.equal(shouldSkipGeminiPassthroughLine("YOLO mode is enabled\r"), true);
  });
});

describe("gemini-passthrough-noise — shouldSkipGeminiPassthroughLine: keep lines", () => {
  it("does not skip regular chat output", () => {
    assert.equal(shouldSkipGeminiPassthroughLine("Here is the result you asked for."), false);
  });

  it("does not skip code output", () => {
    assert.equal(shouldSkipGeminiPassthroughLine("const x = 42;"), false);
  });

  it("does not skip JSON output", () => {
    assert.equal(shouldSkipGeminiPassthroughLine('{"decision":"CONTINUE"}'), false);
  });

  it("does not skip lines containing 'authenticated' mid-sentence", () => {
    // 'Authenticated via' only matches at start of line
    assert.equal(shouldSkipGeminiPassthroughLine("User is authenticated via session"), false);
  });

  it("does not skip lines with 'Using' mid-sentence", () => {
    assert.equal(shouldSkipGeminiPassthroughLine("I am using bundled resources"), false);
  });

  it("does not skip lines with 'OpenTelemetry' mid-sentence", () => {
    assert.equal(shouldSkipGeminiPassthroughLine("Configured OpenTelemetry for tracing"), false);
  });
});

// ── filterGeminiPassthroughTextChunk ─────────────────────────────────────────

describe("gemini-passthrough-noise — filterGeminiPassthroughTextChunk: engine gating", () => {
  it("passes through unchanged for non-gemini engine", () => {
    const text = "YOLO mode is enabled\nsome real output\n";
    assert.equal(filterGeminiPassthroughTextChunk("opencode", text), text);
  });

  it("passes through unchanged for 'anthropic' engine", () => {
    const text = "Authenticated via OAuth\nreal stuff";
    assert.equal(filterGeminiPassthroughTextChunk("anthropic", text), text);
  });

  it("passes through unchanged for empty engine", () => {
    const text = "YOLO mode is enabled";
    assert.equal(filterGeminiPassthroughTextChunk("", text), text);
  });

  it("filters for 'gemini' engine", () => {
    const text = "YOLO mode is enabled\nThis is real output\n";
    const result = filterGeminiPassthroughTextChunk("gemini", text);
    assert.ok(!result.includes("YOLO mode is enabled"));
    assert.ok(result.includes("This is real output"));
  });

  it("filters for 'gemini-cli' engine", () => {
    const text = "Authenticated via OAuth\nActual response\n";
    const result = filterGeminiPassthroughTextChunk("gemini-cli", text);
    assert.ok(!result.includes("Authenticated via OAuth"));
    assert.ok(result.includes("Actual response"));
  });
});

describe("gemini-passthrough-noise — filterGeminiPassthroughTextChunk: filtering behaviour", () => {
  it("removes all skip lines from multi-line gemini output", () => {
    const text = [
      "YOLO mode is enabled",
      "Loaded cached credentials",
      "Using bundled runtime",
      "Authenticated via OAuth",
      "OpenTelemetry exporter started",
      "All tool calls will be automatically approved",
      "Hello, here is my answer."
    ].join("\n");

    const result = filterGeminiPassthroughTextChunk("gemini", text);
    assert.ok(result.includes("Hello, here is my answer."), "Real output should survive");
    assert.ok(!result.includes("YOLO"));
    assert.ok(!result.includes("Loaded cached"));
    assert.ok(!result.includes("Using bundled"));
    assert.ok(!result.includes("Authenticated via"));
    assert.ok(!result.includes("OpenTelemetry"));
    assert.ok(!result.includes("automatically approved"));
  });

  it("returns empty string when all lines are noise", () => {
    const text = "YOLO mode is enabled\nLoaded cached credentials\n";
    const result = filterGeminiPassthroughTextChunk("gemini", text);
    // All lines removed; only the joining \n characters remain (or empty)
    assert.ok(result.trim() === "");
  });

  it("handles null text without throwing", () => {
    assert.doesNotThrow(() => filterGeminiPassthroughTextChunk("gemini", null));
    const result = filterGeminiPassthroughTextChunk("gemini", null);
    assert.equal(typeof result, "string");
  });

  it("handles undefined text without throwing", () => {
    assert.doesNotThrow(() => filterGeminiPassthroughTextChunk("gemini", undefined));
  });

  it("handles empty string without throwing", () => {
    const result = filterGeminiPassthroughTextChunk("gemini", "");
    assert.equal(typeof result, "string");
  });

  it("strips ANSI codes from noise lines before pattern matching", () => {
    // ANSI-wrapped YOLO line should still be stripped
    const ansiNoise = "\u001b[32mYOLO mode is enabled\u001b[0m\nReal output";
    const result = filterGeminiPassthroughTextChunk("gemini", ansiNoise);
    assert.ok(!result.includes("YOLO"));
    assert.ok(result.includes("Real output"));
  });

  it("preserves newline structure for non-noise lines", () => {
    const text = "Line one\nLine two\nLine three";
    const result = filterGeminiPassthroughTextChunk("gemini", text);
    assert.ok(result.includes("Line one"));
    assert.ok(result.includes("Line two"));
    assert.ok(result.includes("Line three"));
  });
});
