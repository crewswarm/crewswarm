#!/usr/bin/env node
/**
 * Test OpenCode with a simple task.
 * Usage:
 *   node scripts/test-opencode.mjs
 *   CREWSWARM_OPENCODE_MODEL=groq/moonshotai/kimi-k2-instruct-0905 node scripts/test-opencode.mjs
 */
import { spawn } from "child_process";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const model =
  process.env.CREWSWARM_OPENCODE_MODEL || "groq/moonshotai/kimi-k2-instruct-0905";
const prompt =
  "Create a file test-hello.txt in the project directory with the single line: Hello from OpenCode";
const projectDir =
  process.env.CREWSWARM_OPENCODE_PROJECT ||
  mkdtempSync(join(tmpdir(), "opencode-test-"));

console.log("[test-opencode] Model:", model);
console.log("[test-opencode] Project dir:", projectDir);
console.log("[test-opencode] Prompt:", prompt);
console.log("");

const args = ["run", prompt, "--model", model, "--dir", projectDir];
const child = spawn("opencode", args, {
  cwd: projectDir,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => {
  const s = d.toString("utf8");
  stdout += s;
  process.stdout.write(s);
});
child.stderr.on("data", (d) => {
  const s = d.toString("utf8");
  stderr += s;
  process.stderr.write(s);
});

child.on("close", (code) => {
  console.log("");
  console.log("[test-opencode] Exit code:", code);
  if (code === 0) {
    console.log("[test-opencode] OK — OpenCode + Kimi Instruct working");
  } else {
    console.error("[test-opencode] FAILED — stderr:", stderr || stdout);
  }
  process.exit(code ?? 1);
});

child.on("error", (err) => {
  console.error("[test-opencode] Spawn error:", err.message);
  process.exit(1);
});
