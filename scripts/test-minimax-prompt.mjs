#!/usr/bin/env node
/**
 * Quick test: send a full production-sized prompt to Minimax M2.1 and M2.5
 * to see if the system is broken or the prompt is too large.
 *
 * Usage (from repo root):
 *   node scripts/test-minimax-prompt.mjs           # full prompt test
 *   node scripts/test-minimax-prompt.mjs --hi     # minimal "say hi" (no memory)
 *
 * To say hi to a model directly from the shell (no script):
 *   opencode run "Say hello in one sentence." --model opencode/minimax-m2.5 --dir .
 *
 * If you see "Missing API key": OpenCode needs a key for that provider.
 * - Run: opencode auth login   (or start opencode, then /connect, select opencode/minimax)
 * - Or add provider in ~/.config/opencode/opencode.json (see open-code.ai/docs/providers)
 * - Credentials live in ~/.local/share/opencode/auth.json
 */
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const SHARED_MEMORY_DIR = path.join(REPO_ROOT, "memory");
const SHARED_MEMORY_MAX_FILE_CHARS = 8000;
const SHARED_MEMORY_MAX_TOTAL_CHARS = 40000;
const SHARED_MEMORY_FILES = [
  "law.md",
  "current-state.md",
  "agent-handoff.md",
  "orchestration-protocol.md",
  "brain.md",
];

function loadSharedMemoryBundle() {
  const sections = [];
  let totalChars = 0;
  for (const fileName of SHARED_MEMORY_FILES) {
    const fullPath = path.join(SHARED_MEMORY_DIR, fileName);
    if (!fs.existsSync(fullPath)) continue;
    let content = fs.readFileSync(fullPath, "utf8");
    if (content.length > SHARED_MEMORY_MAX_FILE_CHARS) {
      content = content.slice(0, SHARED_MEMORY_MAX_FILE_CHARS) + "\n\n[truncated]";
    }
    const section = `### ${fileName}\n${content}`;
    if (totalChars + section.length > SHARED_MEMORY_MAX_TOTAL_CHARS) break;
    sections.push(section);
    totalChars += section.length;
  }
  if (sections.length === 0) {
    return { text: "", bytes: 0 };
  }
  const text = [
    "Persistent shared memory (load this before answering):",
    ...sections,
    "End persistent memory.",
  ].join("\n\n");
  return { text, bytes: Buffer.byteLength(text, "utf8") };
}

function loadAgentPrompt() {
  const p = path.join(process.env.HOME || process.env.USERPROFILE, ".crewswarm", "agent-prompts.json");
  if (!fs.existsSync(p)) return "";
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return j.main || j["crew-main"] || "";
  } catch {
    return "";
  }
}

function buildFullPrompt() {
  const shared = loadSharedMemoryBundle();
  const systemPrompt = loadAgentPrompt();
  const identityHeader =
    'You are crew-main (agent ID: crew-main, model: opencode/minimax-m2.5).';
  const contextNote = `[Shared memory loaded — UTC: ${new Date().toISOString().slice(0, 16).replace("T", " ")}]`;
  const taskText =
    "List the filenames of all Markdown (.md) files in this project. Reply with only the list, one per line. Do not use tools; use only the project files already in context if available.";
  const parts = [];
  if (identityHeader) parts.push(identityHeader);
  if (systemPrompt) parts.push(systemPrompt);
  if (shared.text) parts.push(shared.text);
  parts.push(contextNote);
  parts.push(taskText);
  return parts.join("\n\n");
}

function runOpenCodeWithPrompt(prompt, model, projectDir, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const args = ["run", prompt, "--model", model, "--dir", projectDir];
    const child = spawn("opencode", args, {
      cwd: projectDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Timeout after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const out = (stdout || stderr || "").trim();
      if (code === 0) resolve(out);
      else reject(new Error(`Exit ${code}: ${out.slice(0, 500)}`));
    });
  });
}

async function main() {
  const projectDir = process.env.OPENCREW_OPENCODE_PROJECT || REPO_ROOT;
  const minimalTest = process.argv.includes("--hi");

  const prompt = minimalTest
    ? "Say hello in one sentence."
    : buildFullPrompt();
  const promptChars = prompt.length;
  const approxTokens = Math.ceil(promptChars / 4);

  console.log(minimalTest ? "--- Minimax minimal test (say hi) ---" : "--- Minimax full-prompt test ---");
  console.log("Prompt size:", promptChars, "chars, ~", approxTokens, "tokens");
  console.log("Project dir:", projectDir);
  console.log("");

  const models = [
    "opencode/minimax-m2.1",
    "opencode/minimax-m2.5",
  ];

  for (const model of models) {
    process.stderr.write(`Testing ${model}... `);
    const start = Date.now();
    try {
      const reply = await runOpenCodeWithPrompt(prompt, model, projectDir);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const apiKeyMissing = /missing API key|Missing API key|no API key/i.test(reply);
      if (apiKeyMissing) {
        console.log(`FAIL (${elapsed}s) — API key not configured`);
        console.error("Reply:", reply.slice(0, 400));
      } else {
        console.log(`OK (${elapsed}s)`);
        console.log("Reply preview:", reply.slice(0, 300) + (reply.length > 300 ? "..." : ""));
      }
    } catch (e) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`FAIL (${elapsed}s)`);
      console.error("Error:", e.message);
      const lower = (e.message || "").toLowerCase();
      if (lower.includes("context") || lower.includes("token") || lower.includes("length") || lower.includes("too long")) {
        console.error("(Likely context/prompt too large for this model)");
      }
    }
    console.log("");
  }

  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
