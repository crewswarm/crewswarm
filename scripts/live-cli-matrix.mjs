#!/usr/bin/env node

import fs from "node:fs";
import { execFileSync, spawn } from "node:child_process";

const jsonMode = process.argv.includes("--json");
const smokeMode = process.argv.includes("--smoke");
const cwd = process.cwd();
const PROMPT = "Reply with exactly CLI_MATRIX_OK and nothing else.";
const openCodeModel = process.env.CREWSWARM_OPENCODE_MODEL || "opencode/big-pickle";

function hasBin(bin) {
  try {
    if (bin.includes("/") && fs.existsSync(bin)) return true;
    execFileSync("which", [bin], { stdio: "pipe", timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

function runCli(bin, args, timeoutMs = Number(process.env.CREWSWARM_LIVE_CLI_TIMEOUT_MS || 30000)) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        child.kill("SIGKILL");
        resolve({ ok: false, error: `timeout after ${timeoutMs}ms`, stdout, stderr });
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, error: String(error.message || error), stdout, stderr });
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const combined = `${stdout}\n${stderr}`;
      resolve({
        ok: code === 0 && combined.includes("CLI_MATRIX_OK"),
        code,
        stdout,
        stderr,
      });
    });
  });
}

const cursorBin = process.env.CURSOR_CLI_BIN || "agent";
const clis = [
  {
    id: "claude",
    available: hasBin("claude"),
    command: ["claude", ["-p", "--print", PROMPT]],
  },
  {
    id: "codex",
    available: hasBin("codex"),
    command: ["codex", ["exec", "--sandbox", "read-only", "--json", PROMPT]],
  },
  {
    id: "cursor",
    available: hasBin(cursorBin),
    command: [
      cursorBin,
      [
        "-p",
        "--force",
        "--trust",
        "--output-format",
        "stream-json",
        PROMPT,
        "--model",
        process.env.CREWSWARM_CURSOR_MODEL || "composer-2-fast",
        "--workspace",
        cwd,
      ],
    ],
  },
  {
    id: "gemini",
    available: hasBin("gemini"),
    command: ["gemini", ["-p", PROMPT]],
  },
  {
    id: "opencode",
    available: hasBin("opencode"),
    command: ["opencode", ["run", "--model", openCodeModel, PROMPT]],
  },
  {
    id: "crew-cli",
    available: true,
    command: ["node", ["crew-cli/bin/crew.js", "exec", PROMPT]],
  },
];

const results = [];
if (smokeMode) {
  for (const cli of clis.filter((item) => item.available)) {
    const [bin, args] = cli.command;
    const started = Date.now();
    const result = await runCli(bin, args);
    results.push({
      cli: cli.id,
      durationMs: Date.now() - started,
      ...result,
    });
  }
}

const payload = {
  cwd,
  smokeMode,
  clis: clis.map(({ id, available, command }) => ({ id, available, command: [command[0], ...command[1]] })),
  results,
  checklist: [
    "Run `node scripts/live-cli-matrix.mjs --smoke` to execute one tiny one-shot through each installed CLI.",
    "Expect some failures if auth/session state or credits are missing for a given lane.",
    "Use this as a release-time trust check, not an always-on CI gate.",
  ],
};

if (jsonMode) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

console.log("CrewSwarm live CLI matrix");
console.log("");
for (const cli of payload.clis) {
  console.log(`${cli.id.padEnd(10)} ${cli.available ? "available" : "missing"}`);
}
if (smokeMode) {
  console.log("");
  console.log("Smoke results:");
  for (const result of results) {
    const status = result.ok ? "PASS" : "FAIL";
    const detail = result.ok
      ? (result.stdout || result.stderr).trim().slice(0, 120)
      : (result.error || result.stderr || result.stdout || "").trim().slice(0, 160);
    console.log(`${status.padEnd(5)} ${result.cli.padEnd(10)} ${detail}`);
  }
} else {
  console.log("");
  console.log("Run with --smoke to execute one tiny real one-shot through each installed CLI.");
}
