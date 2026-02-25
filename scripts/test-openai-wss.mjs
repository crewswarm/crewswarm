#!/usr/bin/env node
/**
 * Test OpenAI WebSocket mode (wss://api.openai.com/v1/responses).
 *
 * The doc requires: Authorization: Bearer OPENAI_API_KEY (Platform API key).
 * ChatMock's ~/.chatgpt-local/auth.json has OAuth tokens (access_token, etc.) —
 * those are for the ChatGPT/Codex backend, NOT for api.openai.com, so they
 * won't work for this endpoint.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node scripts/test-openai-wss.mjs
 *   node scripts/test-openai-wss.mjs   # tries ChatMock OAuth token; expect 401
 */

import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const WSS_URL = "wss://api.openai.com/v1/responses";

function getApiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const home = path.join(os.homedir(), ".chatgpt-local", "auth.json");
    const raw = fs.readFileSync(home, "utf8");
    const auth = JSON.parse(raw);
    const token = auth?.tokens?.access_token;
    if (token) return token;
  } catch (_) {}
  return null;
}

async function main() {
  const token = getApiKey();
  const isOAuth = !process.env.OPENAI_API_KEY && !!token;
  if (!token) {
    console.error("No token. Set OPENAI_API_KEY (Platform API key) or have ~/.chatgpt-local/auth.json with OAuth access_token.");
    console.error("Doc: wss://api.openai.com/v1/responses expects Bearer OPENAI_API_KEY, not OAuth.");
    process.exit(1);
  }
  if (isOAuth) {
    console.log("Using OAuth access_token from ~/.chatgpt-local/auth.json (likely 401 — doc wants API key)");
  } else {
    console.log("Using OPENAI_API_KEY");
  }

  const ws = new WebSocket(WSS_URL, {
    headers: { Authorization: `Bearer ${token}` },
  });

  ws.on("open", () => {
    console.log("WebSocket open, sending response.create...");
    ws.send(
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.2",
        store: false,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Say hello in one word." }] }],
        tools: [],
      })
    );
  });

  ws.on("message", (data) => {
    const msg = data.toString();
    const o = (() => {
      try {
        return JSON.parse(msg);
      } catch {
        return msg;
      }
    })();
    console.log("←", typeof o === "string" ? o.slice(0, 200) : JSON.stringify(o).slice(0, 500));
    if (o?.type === "error") {
      console.error("Error:", o.error?.code || o.error?.message || o);
      ws.close();
    }
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });

  ws.on("close", (code, reason) => {
    console.log("Close:", code, reason?.toString() || "");
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
