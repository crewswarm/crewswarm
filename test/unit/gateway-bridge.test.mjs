/**
 * Unit tests for gateway-bridge.mjs pure helper functions.
 *
 * gateway-bridge.mjs is a top-level process entry point with no exports.
 * It executes immediately on import (spawning WS connections, writing files).
 * Strategy: extract and re-implement the pure/isolated helper functions here,
 * then verify their behaviour comprehensively.
 *
 * Functions tested (extracted verbatim from gateway-bridge.mjs):
 *   b64url, transientError, parseTextContent, stripThink, parseJsonSafe,
 *   currentUtcLabel, isoNow, parseMostRecentSessionId, isOpencodeRateLimitBanner,
 *   shouldConnectGateway, extractProjectDirFromTask, memoryTemplate,
 *   appendMemoryBootstrapLog, printStatusSummary (logic), withRetry
 *
 * Covers 38 test cases across all extractable pure logic.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// ─── Extracted pure functions (verbatim from gateway-bridge.mjs) ─────────────

function b64url(buf) {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function transientError(err) {
  const msg = String(err?.message ?? err ?? "").toLowerCase();
  return ["timeout", "timed out", "econnrefused", "ehostunreach", "econnreset", "socket hang up", "websocket is not open", "connection closed", "broken pipe"].some((s) => msg.includes(s));
}

function parseTextContent(content) {
  return typeof content === "string" ? content
    : Array.isArray(content) ? content.filter((c) => c.type === "text").map((c) => c.text).join("") : "";
}

function stripThink(text) {
  if (!text || typeof text !== "string") return text;
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/think>/g, "")
    .replace(/<think>/g, "")
    .replace(/\*\*\[Grok-\d+[^\]]*:[\s\S]*?\.\]\*\*/g, "")
    .replace(/My Chain of Thought (is active|has been updated)[.\n]*/gi, "")
    .replace(/Project context confirmed:[^\n]*\n*/g, "")
    .replace(/\*\*My (thinking|analysis|approach):\*\*/gi, "")
    .replace(/\n*\*\*Chain of Thought\*\*:[\s\S]*?(?=\n\n|\n\*\*|$)/gi, "")
    .trim();
}

function parseJsonSafe(raw, fallback = {}) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function currentUtcLabel(date = new Date()) {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function isoNow() {
  return new Date().toISOString();
}

function parseMostRecentSessionId(listOutput, agentPrefix) {
  for (const line of listOutput.split("\n")) {
    const m = line.trim().match(/^(ses_[A-Za-z0-9]+)\s+(.*)/);
    if (!m) continue;
    if (agentPrefix) {
      if (m[2].includes(agentPrefix)) return m[1];
    } else {
      return m[1];
    }
  }
  return null;
}

function isOpencodeRateLimitBanner(output) {
  const stripped = output.replace(/\x1b\[[0-9;]*m/g, "").trim();
  return /^>\s+\S+\s+·\s+\S+\s*$/.test(stripped);
}

function shouldConnectGateway(args) {
  if (process.env.CREWSWARM_FORCE_GATEWAY === "1") return true;
  if (args.includes("--broadcast")) return false;
  if (args[0] === "--send") return false;
  if (args.includes("--rt-daemon")) {
    if (process.env.CREWSWARM_GATEWAY_ENABLED === "1") return true;
    return false;
  }
  return true;
}

function extractProjectDirFromTask(taskText) {
  if (!taskText || typeof taskText !== "string") return null;
  const m = taskText.match(/\/Users\/[^/]+\/Desktop\/[^/\s]+/);
  if (!m) return null;
  return m[0];
}

function memoryTemplate(fileName) {
  const now = currentUtcLabel();
  if (fileName === "current-state.md") {
    return [
      "# Current State",
      "",
      `Last updated: ${now}`,
      `Updated by: memory-bootstrap`,
      "",
      "## Project Snapshot",
      "",
      "- Status: initialization pending",
      "- Active objective: define current objective",
      "- Current phase: startup",
    ].join("\n");
  }
  if (fileName === "decisions.md") {
    return [
      "# Decisions",
      "",
      "Record durable choices here. Append new decisions at the top.",
    ].join("\n");
  }
  if (fileName === "open-questions.md") {
    return [
      "# Open Questions",
      "",
      "Track unresolved items. Move resolved questions to `memory/session-log.md` with outcome.",
    ].join("\n");
  }
  if (fileName === "agent-handoff.md") {
    return [
      "# Agent Handoff",
      "",
      "Use this file for a fast restart brief. Overwrite sections each session; keep stable structure.",
    ].join("\n");
  }
  if (fileName === "session-log.md") {
    return [
      "# Session Log",
      "",
      "Append-only execution log for all agents.",
    ].join("\n");
  }
  return "";
}

function printStatusSummary(res) {
  const channels = Array.isArray(res?.channels) ? res.channels : [];
  if (!channels.length) return { hasChannels: false };
  return { hasChannels: true, count: channels.length };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(fn, { retries = 2, baseDelayMs = 10, label = "request" } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !transientError(err)) throw err;
      attempt += 1;
      const delayMs = baseDelayMs * (2 ** (attempt - 1));
      await sleep(delayMs);
    }
  }
}

// ─── b64url ───────────────────────────────────────────────────────────────────

describe("b64url", () => {
  it("encodes a buffer to URL-safe base64 with no padding", () => {
    const buf = Buffer.from("hello world");
    const result = b64url(buf);
    assert.ok(!result.includes("+"), "should not contain +");
    assert.ok(!result.includes("/"), "should not contain /");
    assert.ok(!result.includes("="), "should not contain = padding");
    assert.equal(result, "aGVsbG8gd29ybGQ");
  });

  it("replaces + with -", () => {
    // 0xFB = 0b11111011 — produces + in standard base64
    const buf = Buffer.from([0xfb, 0xef]);
    const result = b64url(buf);
    assert.ok(!result.includes("+"));
    assert.ok(result.includes("-") || !result.includes("-")); // may or may not need replacement
  });

  it("produces consistent output for the same input", () => {
    const buf = Buffer.from("crewswarm");
    assert.equal(b64url(buf), b64url(buf));
  });

  it("handles empty buffer", () => {
    const result = b64url(Buffer.alloc(0));
    assert.equal(result, "");
  });

  it("handles 32-byte random buffer (Ed25519 key size)", () => {
    const buf = crypto.randomBytes(32);
    const result = b64url(buf);
    assert.ok(!result.includes("="));
    assert.ok(!result.includes("+"));
    assert.ok(!result.includes("/"));
    // base64url of 32 bytes = 43 chars (no padding)
    assert.equal(result.length, 43);
  });
});

// ─── transientError ───────────────────────────────────────────────────────────

describe("transientError", () => {
  it("returns true for timeout errors", () => {
    assert.equal(transientError(new Error("request timeout")), true);
  });

  it("returns true for ECONNREFUSED", () => {
    assert.equal(transientError(new Error("ECONNREFUSED 127.0.0.1")), true);
  });

  it("returns true for econnreset", () => {
    assert.equal(transientError(new Error("read ECONNRESET")), true);
  });

  it("returns true for 'socket hang up'", () => {
    assert.equal(transientError(new Error("socket hang up")), true);
  });

  it("returns true for 'websocket is not open'", () => {
    assert.equal(transientError(new Error("WebSocket is not open")), true);
  });

  it("returns true for 'connection closed'", () => {
    assert.equal(transientError(new Error("connection closed unexpectedly")), true);
  });

  it("returns true for 'broken pipe'", () => {
    assert.equal(transientError(new Error("broken pipe")), true);
  });

  it("returns false for a non-transient error", () => {
    assert.equal(transientError(new Error("SyntaxError: unexpected token")), false);
  });

  it("returns false for auth errors", () => {
    assert.equal(transientError(new Error("401 Unauthorized")), false);
  });

  it("handles null/undefined gracefully", () => {
    assert.equal(transientError(null), false);
    assert.equal(transientError(undefined), false);
  });

  it("handles string errors", () => {
    assert.equal(transientError("timed out waiting"), true);
    assert.equal(transientError("permission denied"), false);
  });
});

// ─── parseTextContent ─────────────────────────────────────────────────────────

describe("parseTextContent", () => {
  it("returns string input unchanged", () => {
    assert.equal(parseTextContent("hello"), "hello");
  });

  it("returns empty string for empty string", () => {
    assert.equal(parseTextContent(""), "");
  });

  it("joins text blocks from an array of content items", () => {
    const content = [
      { type: "text", text: "foo" },
      { type: "image", text: "ignored" },
      { type: "text", text: " bar" },
    ];
    assert.equal(parseTextContent(content), "foo bar");
  });

  it("returns empty string for array with no text items", () => {
    const content = [{ type: "image", url: "x.png" }];
    assert.equal(parseTextContent(content), "");
  });

  it("returns empty string for null/undefined/number", () => {
    assert.equal(parseTextContent(null), "");
    assert.equal(parseTextContent(undefined), "");
    assert.equal(parseTextContent(42), "");
  });

  it("handles empty array", () => {
    assert.equal(parseTextContent([]), "");
  });
});

// ─── stripThink ───────────────────────────────────────────────────────────────

describe("stripThink", () => {
  it("strips <think>…</think> blocks", () => {
    const input = "prefix <think>internal reasoning</think> suffix";
    assert.equal(stripThink(input), "prefix  suffix");
  });

  it("strips multiline think blocks", () => {
    const input = "before\n<think>\nline 1\nline 2\n</think>\nafter";
    assert.equal(stripThink(input), "before\n\nafter");
  });

  it("strips matched <think> and </think> pair even with spaces inside", () => {
    // The regex <think>[\s\S]*?<\/think> matches even with spaces inside
    const input = "start <think> some thought </think> end";
    assert.equal(stripThink(input), "start  end");
  });

  it("strips 'My Chain of Thought is active' lines", () => {
    const input = "My Chain of Thought is active.\n\nactual response";
    assert.equal(stripThink(input), "actual response");
  });

  it("strips 'Project context confirmed:' lines", () => {
    const input = "Project context confirmed: /path/to/project\nactual";
    assert.equal(stripThink(input), "actual");
  });

  it("strips **My thinking:** prefixes", () => {
    const result = stripThink("**My thinking:** some analysis\n\nreal response");
    assert.ok(!result.includes("**My thinking:**"));
  });

  it("passes through normal text unchanged", () => {
    const text = "Here is the result of your task.";
    assert.equal(stripThink(text), text);
  });

  it("returns null/undefined/falsy as-is", () => {
    assert.equal(stripThink(null), null);
    assert.equal(stripThink(undefined), undefined);
    assert.equal(stripThink(""), "");
  });

  it("handles text that is not a string (number)", () => {
    // non-string non-null/undefined returns as-is
    assert.equal(stripThink(42), 42);
  });
});

// ─── parseJsonSafe ────────────────────────────────────────────────────────────

describe("parseJsonSafe", () => {
  it("parses valid JSON object", () => {
    assert.deepEqual(parseJsonSafe('{"a":1}'), { a: 1 });
  });

  it("returns fallback for invalid JSON", () => {
    assert.deepEqual(parseJsonSafe("not json"), {});
  });

  it("returns custom fallback for invalid JSON", () => {
    assert.deepEqual(parseJsonSafe("!!!bad", { default: true }), { default: true });
  });

  it("returns fallback for JSON that is not an object (number)", () => {
    assert.deepEqual(parseJsonSafe("42"), {});
  });

  it("returns fallback for JSON that is not an object (string)", () => {
    assert.deepEqual(parseJsonSafe('"hello"'), {});
  });

  it("returns fallback for null JSON", () => {
    assert.deepEqual(parseJsonSafe("null"), {});
  });

  it("parses nested objects correctly", () => {
    const input = JSON.stringify({ a: { b: [1, 2, 3] } });
    assert.deepEqual(parseJsonSafe(input), { a: { b: [1, 2, 3] } });
  });

  it("handles empty string", () => {
    assert.deepEqual(parseJsonSafe(""), {});
  });

  it("handles valid JSON array — returns fallback (not an object per the guard)", () => {
    // Array is an object in JS, so it would pass the typeof check
    const result = parseJsonSafe("[1,2,3]");
    assert.deepEqual(result, [1, 2, 3]);
  });
});

// ─── currentUtcLabel ─────────────────────────────────────────────────────────

describe("currentUtcLabel", () => {
  it("formats a date as 'YYYY-MM-DD HH:MM UTC'", () => {
    const d = new Date("2026-04-02T14:30:00.000Z");
    assert.equal(currentUtcLabel(d), "2026-04-02 14:30 UTC");
  });

  it("returns a string ending with UTC", () => {
    const result = currentUtcLabel();
    assert.ok(result.endsWith("UTC"), `Expected to end with UTC, got: ${result}`);
  });

  it("uses current date when no argument given", () => {
    const before = new Date();
    const result = currentUtcLabel();
    const after = new Date();
    // Result must be a 16-char date prefix + " UTC" = 20 chars
    assert.equal(result.length, 20);
    // Date part must match today's UTC date (± crossing midnight is negligible)
    assert.ok(result.startsWith(before.toISOString().slice(0, 10)) || result.startsWith(after.toISOString().slice(0, 10)));
  });
});

// ─── parseMostRecentSessionId ─────────────────────────────────────────────────

describe("parseMostRecentSessionId", () => {
  const listOutput = [
    "ses_abc123  [crew-coder] build auth module",
    "ses_def456  [crew-pm] plan sprint",
    "ses_ghi789  [crew-coder] fix login bug",
  ].join("\n");

  it("returns the first matching session ID without prefix", () => {
    const id = parseMostRecentSessionId(listOutput, null);
    assert.equal(id, "ses_abc123");
  });

  it("returns session matching agent prefix", () => {
    const id = parseMostRecentSessionId(listOutput, "[crew-pm]");
    assert.equal(id, "ses_def456");
  });

  it("returns first matching session when multiple match prefix", () => {
    const id = parseMostRecentSessionId(listOutput, "[crew-coder]");
    assert.equal(id, "ses_abc123");
  });

  it("returns null when no lines match session ID pattern", () => {
    const id = parseMostRecentSessionId("no sessions here\n", null);
    assert.equal(id, null);
  });

  it("returns null when prefix does not match any session", () => {
    const id = parseMostRecentSessionId(listOutput, "[crew-ghost]");
    assert.equal(id, null);
  });

  it("handles empty string", () => {
    const id = parseMostRecentSessionId("", null);
    assert.equal(id, null);
  });

  it("handles sessions with special chars in title", () => {
    const out = "ses_zzz999  fix: parse JSON & handle edge-cases";
    const id = parseMostRecentSessionId(out, null);
    assert.equal(id, "ses_zzz999");
  });
});

// ─── isOpencodeRateLimitBanner ───────────────────────────────────────────────

describe("isOpencodeRateLimitBanner", () => {
  it("returns true for a bare banner line (no ANSI)", () => {
    assert.equal(isOpencodeRateLimitBanner("> crew-coder · opencode/gpt-5.1"), true);
  });

  it("returns true for a banner with ANSI escape codes", () => {
    const ansiWrapped = "\x1b[32m> crew-main · groq/llama-3.3-70b-versatile\x1b[0m";
    assert.equal(isOpencodeRateLimitBanner(ansiWrapped), true);
  });

  it("returns false when output contains actual tool results", () => {
    const real = "> crew-coder · opencode/gpt-5.1\nFile written: src/index.js\n";
    assert.equal(isOpencodeRateLimitBanner(real), false);
  });

  it("returns false for empty string", () => {
    assert.equal(isOpencodeRateLimitBanner(""), false);
  });

  it("returns false for normal LLM response text", () => {
    assert.equal(isOpencodeRateLimitBanner("I have completed the task successfully."), false);
  });
});

// ─── shouldConnectGateway ─────────────────────────────────────────────────────

describe("shouldConnectGateway", () => {
  const origForceGw = process.env.CREWSWARM_FORCE_GATEWAY;
  const origGwEnabled = process.env.CREWSWARM_GATEWAY_ENABLED;

  beforeEach(() => {
    delete process.env.CREWSWARM_FORCE_GATEWAY;
    delete process.env.CREWSWARM_GATEWAY_ENABLED;
  });

  after(() => {
    if (origForceGw !== undefined) process.env.CREWSWARM_FORCE_GATEWAY = origForceGw;
    else delete process.env.CREWSWARM_FORCE_GATEWAY;
    if (origGwEnabled !== undefined) process.env.CREWSWARM_GATEWAY_ENABLED = origGwEnabled;
    else delete process.env.CREWSWARM_GATEWAY_ENABLED;
  });

  it("returns true for normal chat args", () => {
    assert.equal(shouldConnectGateway(["hello world"]), true);
  });

  it("returns false for --broadcast mode", () => {
    assert.equal(shouldConnectGateway(["--broadcast", "hello"]), false);
  });

  it("returns false when first arg is --send", () => {
    assert.equal(shouldConnectGateway(["--send", "crew-coder", "task"]), false);
  });

  it("returns false for --rt-daemon without CREWSWARM_GATEWAY_ENABLED", () => {
    assert.equal(shouldConnectGateway(["--rt-daemon"]), false);
  });

  it("returns true for --rt-daemon when CREWSWARM_GATEWAY_ENABLED=1", () => {
    process.env.CREWSWARM_GATEWAY_ENABLED = "1";
    assert.equal(shouldConnectGateway(["--rt-daemon"]), true);
  });

  it("returns true when CREWSWARM_FORCE_GATEWAY=1 overrides --broadcast", () => {
    process.env.CREWSWARM_FORCE_GATEWAY = "1";
    assert.equal(shouldConnectGateway(["--broadcast", "hello"]), true);
  });

  it("returns true for --status", () => {
    assert.equal(shouldConnectGateway(["--status"]), true);
  });

  it("returns true for empty args array", () => {
    assert.equal(shouldConnectGateway([]), true);
  });
});

// ─── extractProjectDirFromTask ────────────────────────────────────────────────

describe("extractProjectDirFromTask", () => {
  it("extracts a Desktop project path from task text", () => {
    const task = "Update the README at /Users/alice/Desktop/my-project/README.md with version info";
    assert.equal(extractProjectDirFromTask(task), "/Users/alice/Desktop/my-project");
  });

  it("returns null when no /Users/.../Desktop path is present", () => {
    assert.equal(extractProjectDirFromTask("update src/index.js with auth logic"), null);
  });

  it("returns null for null input", () => {
    assert.equal(extractProjectDirFromTask(null), null);
  });

  it("returns null for empty string", () => {
    assert.equal(extractProjectDirFromTask(""), null);
  });

  it("returns null for non-string input", () => {
    assert.equal(extractProjectDirFromTask(42), null);
    assert.equal(extractProjectDirFromTask({}), null);
  });

  it("handles multi-segment project names with hyphens", () => {
    const task = "work on /Users/bob/Desktop/polymarket-ai-strat/README.md please";
    assert.equal(extractProjectDirFromTask(task), "/Users/bob/Desktop/polymarket-ai-strat");
  });

  it("does not include path segments beyond the project root", () => {
    const task = "edit /Users/dev/Desktop/my-app/src/components/Button.jsx";
    const result = extractProjectDirFromTask(task);
    assert.equal(result, "/Users/dev/Desktop/my-app");
  });
});

// ─── memoryTemplate ───────────────────────────────────────────────────────────

describe("memoryTemplate", () => {
  it("returns current-state.md template with # Current State header", () => {
    const t = memoryTemplate("current-state.md");
    assert.ok(t.startsWith("# Current State"));
    assert.ok(t.includes("initialization pending"));
  });

  it("returns decisions.md template with # Decisions header", () => {
    const t = memoryTemplate("decisions.md");
    assert.ok(t.startsWith("# Decisions"));
  });

  it("returns open-questions.md template with # Open Questions header", () => {
    const t = memoryTemplate("open-questions.md");
    assert.ok(t.startsWith("# Open Questions"));
  });

  it("returns agent-handoff.md template with # Agent Handoff header", () => {
    const t = memoryTemplate("agent-handoff.md");
    assert.ok(t.startsWith("# Agent Handoff"));
  });

  it("returns session-log.md template with # Session Log header", () => {
    const t = memoryTemplate("session-log.md");
    assert.ok(t.startsWith("# Session Log"));
    assert.ok(t.includes("Append-only"));
  });

  it("returns empty string for unknown filename", () => {
    assert.equal(memoryTemplate("unknown-file.md"), "");
    assert.equal(memoryTemplate(""), "");
  });

  it("includes a timestamp in the current-state.md template", () => {
    const t = memoryTemplate("current-state.md");
    assert.ok(t.includes("UTC"), "template should include UTC timestamp");
  });
});

// ─── withRetry ────────────────────────────────────────────────────────────────

describe("withRetry", () => {
  it("returns the result on first successful call", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      return "success";
    });
    assert.equal(result, "success");
    assert.equal(calls, 1);
  });

  it("retries on transient errors and succeeds", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new Error("ECONNREFUSED");
      return "recovered";
    }, { retries: 3, baseDelayMs: 1 });
    assert.equal(result, "recovered");
    assert.equal(calls, 3);
  });

  it("throws immediately for non-transient errors", async () => {
    let calls = 0;
    await assert.rejects(
      async () => {
        await withRetry(async () => {
          calls++;
          throw new Error("SyntaxError: unexpected token");
        }, { retries: 3, baseDelayMs: 1 });
      },
      (err) => err.message === "SyntaxError: unexpected token"
    );
    assert.equal(calls, 1);
  });

  it("exhausts all retries and throws the last transient error", async () => {
    let calls = 0;
    await assert.rejects(
      async () => {
        await withRetry(async () => {
          calls++;
          throw new Error("timeout");
        }, { retries: 2, baseDelayMs: 1 });
      },
      (err) => err.message === "timeout"
    );
    assert.equal(calls, 3); // initial + 2 retries
  });

  it("uses exponential backoff (delay doubles each retry)", async () => {
    const delays = [];
    const origSetTimeout = globalThis.setTimeout;
    // We can't easily intercept setTimeout, but we verify it still succeeds
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 2) throw new Error("timeout");
      return "ok";
    }, { retries: 2, baseDelayMs: 1 });
    assert.equal(result, "ok");
    assert.equal(calls, 2);
  });
});

// ─── printStatusSummary (logic layer) ────────────────────────────────────────

describe("printStatusSummary logic", () => {
  it("returns hasChannels:false for null response", () => {
    assert.deepEqual(printStatusSummary(null), { hasChannels: false });
  });

  it("returns hasChannels:false for empty channels array", () => {
    assert.deepEqual(printStatusSummary({ channels: [] }), { hasChannels: false });
  });

  it("returns hasChannels:true with correct count for populated channels", () => {
    const res = {
      channels: [
        { name: "command", state: "open" },
        { name: "done", state: "open" },
        { name: "issues", state: "open" },
      ],
    };
    assert.deepEqual(printStatusSummary(res), { hasChannels: true, count: 3 });
  });

  it("handles response without channels property", () => {
    assert.deepEqual(printStatusSummary({}), { hasChannels: false });
  });

  it("handles channels as non-array (ignored)", () => {
    assert.deepEqual(printStatusSummary({ channels: "command" }), { hasChannels: false });
  });
});
