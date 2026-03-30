/**
 * E2E: Direct chat passthrough — verify each CLI engine responds via the
 * passthrough API (same path Vibe and Dashboard use).
 *
 * Also tests session resume: send two messages, verify the second has
 * context from the first.
 *
 * REQUIRES: crew-lead on :5010 with engines installed.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

const CREW_LEAD_URL = "http://127.0.0.1:5010";
const CONFIG_PATH = join(homedir(), ".crewswarm", "crewswarm.json");
const PASSTHROUGH_TIMEOUT_MS = {
  default: 90000,
  gemini: 150000,
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
 */
async function passthroughChat(engine, message, sessionId = "e2e-test", projectDir = process.cwd()) {
  const token = await getAuthToken();
  const http = await import("node:http");

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
      let fullText = "";
      res.on("data", (d) => {
        chunks += d.toString();
        // Parse SSE events
        for (const line of chunks.split("\n")) {
          if (line.startsWith("data: ")) {
            try {
              const ev = JSON.parse(line.slice(6));
              if (ev.type === "chunk" && ev.text) fullText += ev.text;
              if (ev.type === "done") {
                resolve({ text: fullText.trim(), exitCode: ev.exitCode || 0 });
              }
            } catch { /* partial line */ }
          }
        }
        // Keep only the last partial line
        const parts = chunks.split("\n");
        chunks = parts[parts.length - 1];
      });
      res.on("end", () => {
        resolve({ text: fullText.trim(), exitCode: 0 });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    const timeoutMs = PASSTHROUGH_TIMEOUT_MS[engine] || PASSTHROUGH_TIMEOUT_MS.default;
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error("Passthrough timeout")); });
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
  codex: isInstalled("codex"),
  opencode: isInstalled("opencode"),
};

// ─── Passthrough chat tests ──────────────────────────────────────────────────

describe("passthrough: Claude Code", {
  skip: SKIP || !engines.claude ? "Claude Code not available" : false,
  timeout: 120000
}, () => {
  it("sends message and gets response", async () => {
    const { text, exitCode } = await passthroughChat("claude", "Reply with exactly: PASSTHROUGH_CLAUDE_OK");
    console.log(`    Claude: "${text.slice(0, 80)}" (exit ${exitCode})`);
    assert.ok(text.length > 0, "Should get non-empty response");
  });
});

describe("passthrough: Cursor CLI", {
  skip: SKIP || !engines.cursor ? "Cursor CLI not available" : false,
  timeout: 120000
}, () => {
  it("sends message and gets response", async () => {
    const { text, exitCode } = await passthroughChat("cursor", "Reply with exactly: PASSTHROUGH_CURSOR_OK");
    console.log(`    Cursor: "${text.slice(0, 80)}" (exit ${exitCode})`);
    assert.ok(text.length > 0, "Should get non-empty response");
  });
});

describe("passthrough: Gemini CLI", {
  skip: SKIP || !engines.gemini ? "Gemini CLI not available" : false,
  timeout: 120000
}, () => {
  it("sends message and gets response", async () => {
    const { text, exitCode } = await passthroughChat("gemini", "Reply with exactly: PASSTHROUGH_GEMINI_OK");
    console.log(`    Gemini: "${text.slice(0, 80)}" (exit ${exitCode})`);
    assert.ok(text.length > 0, "Should get non-empty response");
  });
});

describe("passthrough: OpenCode", {
  skip: SKIP || !engines.opencode ? "OpenCode not available" : false,
  timeout: 120000
}, () => {
  it("sends message and gets response", async () => {
    const { text, exitCode } = await passthroughChat("opencode", "Reply with exactly: PASSTHROUGH_OPENCODE_OK");
    console.log(`    OpenCode: "${text.slice(0, 80)}" (exit ${exitCode})`);
    assert.ok(text.length > 0, "Should get non-empty response");
  });
});

// ─── Session resume test ─────────────────────────────────────────────────────

describe("session resume: Claude Code", {
  skip: SKIP || !engines.claude ? "Claude Code not available" : false,
  timeout: 180000
}, () => {
  const sessionId = `e2e-session-resume-${Date.now()}`;

  before(async () => {
    // Clear any existing session
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

  it("message 1: establish context", async () => {
    const { text } = await passthroughChat("claude", "Remember this secret code: MANGO_42. Reply with OK.", sessionId);
    console.log(`    Msg 1: "${text.slice(0, 80)}"`);
    assert.ok(text.length > 0, "Should get response");
  });

  it("message 2: verify context persists", async () => {
    const { text } = await passthroughChat("claude", "What was the secret code I told you?", sessionId);
    console.log(`    Msg 2: "${text.slice(0, 80)}"`);
    assert.ok(text.length > 0, "Should get response");
    assert.ok(
      /mango|42|MANGO_42/i.test(text),
      `Response should contain the secret code MANGO_42, got: "${text.slice(0, 100)}"`
    );
  });
});
