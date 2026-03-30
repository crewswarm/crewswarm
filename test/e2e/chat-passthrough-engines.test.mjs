/**
 * E2E: CLI Engine Passthrough Diagnostics
 *
 * Verifies each installed CLI engine responds via the crew-lead passthrough API
 * (the same path Dashboard, Vibe, and API surfaces use to talk to engines).
 *
 * WHAT THIS TESTS:
 *   - crew-lead /api/engine-passthrough SSE endpoint is reachable
 *   - Each CLI engine (Claude Code, Cursor, Gemini CLI, OpenCode) can:
 *     1. Receive a prompt via passthrough
 *     2. Return a non-empty text response
 *     3. Complete within its expected timeout
 *   - Session resume: Claude Code can recall context from a prior message
 *
 * HOW TO READ FAILURES:
 *   - "Passthrough timeout" → engine started but didn't respond in time.
 *     Check engine process, rate limits, or increase PASSTHROUGH_TIMEOUT_MS.
 *   - "Should get non-empty response" → engine responded but returned nothing.
 *     Check engine auth/API keys and crew-lead logs.
 *   - "cancelled" → a prior test in the describe block timed out and killed
 *     remaining tests. Fix the timed-out test first.
 *
 * EXPECTED TIMING (solo, warm):
 *   Claude Code:  5-15s
 *   Cursor CLI:   5-15s
 *   Gemini CLI:   15-30s (cold start can be 30-60s)
 *   OpenCode:     30-60s
 *
 * REQUIRES: crew-lead on :5010 with engines installed.
 * RUN: node --test test/e2e/chat-passthrough-engines.test.mjs
 * NOTE: Run this file SOLO — concurrent e2e tests cause timeouts.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { getCliEngineMetadata, logTestEvidence } from "../helpers/test-log.mjs";
import { logEngineTestContext } from "../helpers/test-context.mjs";

const CREW_LEAD_URL = "http://127.0.0.1:5010";
const CONFIG_PATH = join(homedir(), ".crewswarm", "crewswarm.json");

// Per-engine timeouts based on observed timing (see header).
// These are HTTP request timeouts — the describe timeout must be >= these.
const PASSTHROUGH_TIMEOUT_MS = {
  claude: 90_000,
  cursor: 90_000,
  gemini: 150_000,
  opencode: 120_000,
};

let authToken;
async function getAuthToken() {
  if (authToken) return authToken;
  try {
    const cfg = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    authToken = cfg?.rt?.authToken || "";
    return authToken;
  } catch { return ""; }
}

function isInstalled(bin) {
  try { execSync(`which ${bin}`, { stdio: "pipe", timeout: 3000 }); return true; }
  catch { return false; }
}

/**
 * Send a message through the engine-passthrough SSE endpoint and collect the response.
 * Returns { text, exitCode, durationMs }.
 */
async function passthroughChat(engine, message, sessionId = "e2e-test", projectDir = process.cwd()) {
  const token = await getAuthToken();
  const http = await import("node:http");
  const start = Date.now();
  let fullText = "";

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ engine, message, sessionId, projectDir });
    const req = http.request(`${CREW_LEAD_URL}/api/engine-passthrough`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
    }, (res) => {
      let chunks = "";
      res.on("data", (d) => {
        chunks += d.toString();
        for (const line of chunks.split("\n")) {
          if (line.startsWith("data: ")) {
            try {
              const ev = JSON.parse(line.slice(6));
              if (ev.type === "chunk" && ev.text) fullText += ev.text;
              if (ev.type === "done") {
                logTestEvidence({
                  category: "passthrough_done",
                  test: `passthrough:${engine}`,
                  file: import.meta.filename,
                  engine,
                  exit_code: ev.exitCode || 0,
                  duration_ms: Date.now() - start,
                  session_id: sessionId,
                  project_dir: projectDir,
                  response_length: fullText.trim().length,
                });
                resolve({ text: fullText.trim(), exitCode: ev.exitCode || 0, durationMs: Date.now() - start });
              }
            } catch { /* partial line */ }
          }
        }
        const parts = chunks.split("\n");
        chunks = parts[parts.length - 1];
      });
      res.on("end", () => {
        resolve({ text: fullText.trim(), exitCode: 0, durationMs: Date.now() - start });
      });
      res.on("error", reject);
    });
    req.on("error", (error) => {
      logTestEvidence({
        category: "passthrough_error",
        test: `passthrough:${engine}`,
        file: import.meta.filename,
        engine,
        timeout_ms: PASSTHROUGH_TIMEOUT_MS[engine] || 90_000,
        session_id: sessionId,
        project_dir: projectDir,
        response_length: fullText.length,
        error: error.message,
      });
      reject(error);
    });
    const timeoutMs = PASSTHROUGH_TIMEOUT_MS[engine] || 90_000;
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      const error = new Error(`Passthrough timeout after ${Math.round((Date.now() - start) / 1000)}s (limit: ${timeoutMs / 1000}s)`);
      logTestEvidence({
        category: "passthrough_timeout",
        test: `passthrough:${engine}`,
        file: import.meta.filename,
        engine,
        timeout_ms: timeoutMs,
        session_id: sessionId,
        project_dir: projectDir,
        response_length: fullText.length,
        error: error.message,
      });
      reject(error);
    });
    req.write(body);
    req.end();
  });
}

// Pre-flight
let crewLeadUp = false;
try {
  const http = await import("node:http");
  crewLeadUp = await new Promise((resolve) => {
    http.get(`${CREW_LEAD_URL}/health`, (res) => resolve(res.statusCode === 200)).on("error", () => resolve(false));
  });
} catch { }

const SKIP = crewLeadUp ? false : "crew-lead not running on :5010";
const engines = {
  claude: isInstalled("claude"),
  cursor: isInstalled("agent"),
  gemini: isInstalled("gemini"),
  opencode: isInstalled("opencode"),
};

// ─── Passthrough chat: one test per engine ──────────────────────────────────

describe("passthrough: Claude Code", {
  skip: SKIP || !engines.claude ? "Claude Code not available" : false,
  timeout: 120_000,
}, () => {
  it("Claude Code responds via passthrough", async () => {
    logEngineTestContext({
      test: "Claude Code responds via passthrough",
      file: import.meta.filename,
      engine: "claude",
      timeout_ms: PASSTHROUGH_TIMEOUT_MS.claude,
      project_dir: process.cwd(),
      notes: JSON.stringify(getCliEngineMetadata("claude")),
    });
    const { text, exitCode, durationMs } = await passthroughChat("claude", "Reply with exactly: PASSTHROUGH_CLAUDE_OK");
    console.log(`    Claude Code: "${text.slice(0, 80)}" (${(durationMs / 1000).toFixed(1)}s, exit ${exitCode})`);
    assert.ok(text.length > 0, "Claude Code should return a non-empty response");
  });
});

describe("passthrough: Cursor CLI", {
  skip: SKIP || !engines.cursor ? "Cursor CLI not available" : false,
  timeout: 120_000,
}, () => {
  it("Cursor CLI responds via passthrough", async () => {
    logEngineTestContext({
      test: "Cursor CLI responds via passthrough",
      file: import.meta.filename,
      engine: "cursor",
      timeout_ms: PASSTHROUGH_TIMEOUT_MS.cursor,
      project_dir: process.cwd(),
    });
    const { text, exitCode, durationMs } = await passthroughChat("cursor", "Reply with exactly: PASSTHROUGH_CURSOR_OK");
    console.log(`    Cursor CLI: "${text.slice(0, 80)}" (${(durationMs / 1000).toFixed(1)}s, exit ${exitCode})`);
    assert.ok(text.length > 0, "Cursor CLI should return a non-empty response");
  });
});

describe("passthrough: Gemini CLI", {
  skip: SKIP || !engines.gemini ? "Gemini CLI not available" : false,
  timeout: 180_000,
}, () => {
  it("Gemini CLI responds via passthrough", async () => {
    logEngineTestContext({
      test: "Gemini CLI responds via passthrough",
      file: import.meta.filename,
      engine: "gemini",
      timeout_ms: PASSTHROUGH_TIMEOUT_MS.gemini,
      project_dir: process.cwd(),
    });
    const { text, exitCode, durationMs } = await passthroughChat("gemini", "Reply with exactly: PASSTHROUGH_GEMINI_OK");
    console.log(`    Gemini CLI: "${text.slice(0, 80)}" (${(durationMs / 1000).toFixed(1)}s, exit ${exitCode})`);
    assert.ok(text.length > 0, "Gemini CLI should return a non-empty response");
  });
});

describe("passthrough: OpenCode", {
  skip: SKIP || !engines.opencode ? "OpenCode not available" : false,
  timeout: 150_000,
}, () => {
  it("OpenCode responds via passthrough", async () => {
    logEngineTestContext({
      test: "OpenCode responds via passthrough",
      file: import.meta.filename,
      engine: "opencode",
      timeout_ms: PASSTHROUGH_TIMEOUT_MS.opencode,
      project_dir: process.cwd(),
    });
    const { text, exitCode, durationMs } = await passthroughChat("opencode", "Reply with exactly: PASSTHROUGH_OPENCODE_OK");
    console.log(`    OpenCode: "${text.slice(0, 80)}" (${(durationMs / 1000).toFixed(1)}s, exit ${exitCode})`);
    assert.ok(text.length > 0, "OpenCode should return a non-empty response");
  });
});

// ─── Session resume: verify multi-turn context ─────────────────────────────

describe("session resume: Claude Code", {
  skip: SKIP || !engines.claude ? "Claude Code not available" : false,
  timeout: 180_000,
}, () => {
  const sessionId = `e2e-session-resume-${Date.now()}`;

  before(async () => {
    const token = await getAuthToken();
    const http = await import("node:http");
    await new Promise((resolve) => {
      const req = http.request(`${CREW_LEAD_URL}/api/engine-passthrough/clear-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      }, (res) => { res.on("data", () => {}); res.on("end", resolve); });
      req.write(JSON.stringify({ sessionId, projectDir: process.cwd() }));
      req.end();
    });
  });

  it("Claude Code msg 1: establish context (secret code MANGO_42)", async () => {
    logEngineTestContext({
      test: "Claude Code msg 1: establish context (secret code MANGO_42)",
      file: import.meta.filename,
      engine: "claude",
      timeout_ms: PASSTHROUGH_TIMEOUT_MS.claude,
      project_dir: process.cwd(),
      notes: `sessionId=${sessionId}`,
    });
    const { text, durationMs } = await passthroughChat("claude", "Remember this secret code: MANGO_42. Reply with OK.", sessionId);
    console.log(`    Msg 1: "${text.slice(0, 80)}" (${(durationMs / 1000).toFixed(1)}s)`);
    assert.ok(text.length > 0, "Should get response");
  });

  it("Claude Code msg 2: verify context persists (recalls MANGO_42)", async () => {
    logEngineTestContext({
      test: "Claude Code msg 2: verify context persists (recalls MANGO_42)",
      file: import.meta.filename,
      engine: "claude",
      timeout_ms: PASSTHROUGH_TIMEOUT_MS.claude,
      project_dir: process.cwd(),
      notes: `sessionId=${sessionId}`,
    });
    const { text, durationMs } = await passthroughChat("claude", "What was the secret code I told you?", sessionId);
    console.log(`    Msg 2: "${text.slice(0, 80)}" (${(durationMs / 1000).toFixed(1)}s)`);
    assert.ok(text.length > 0, "Should get response");
    assert.ok(
      /mango|42|MANGO_42/i.test(text),
      `Response should contain the secret code MANGO_42, got: "${text.slice(0, 100)}"`
    );
  });
});
