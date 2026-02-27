/**
 * Engine runners — extracted from gateway-bridge.mjs
 * shouldUse* routing and run*Task implementations for Cursor CLI, Claude Code,
 * Codex, Gemini CLI, Antigravity, Docker Sandbox.
 *
 * Inject: initRunners({ getAgentOpenCodeConfig, loadAgentList, getOpencodeProjectDir,
 *                       buildMiniTaskForOpenCode, runOpenCodeTask })
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { recordTokenUsage, addAgentSpend } from "../runtime/spending.mjs";

// ── Module-level deps (injected via initRunners) ───────────────────────────
let _getAgentOpenCodeConfig = () => ({ enabled: false, useCursorCli: false, cursorCliModel: null, claudeCodeModel: null });
let _loadAgentList = () => [];
let _getOpencodeProjectDir = () => null;
let _runOpenCodeTask = async () => "";

export function initRunners({ getAgentOpenCodeConfig, loadAgentList, getOpencodeProjectDir, buildMiniTaskForOpenCode, runOpenCodeTask } = {}) {
  if (getAgentOpenCodeConfig) _getAgentOpenCodeConfig = getAgentOpenCodeConfig;
  if (loadAgentList) _loadAgentList = loadAgentList;
  if (getOpencodeProjectDir) _getOpencodeProjectDir = getOpencodeProjectDir;
  if (runOpenCodeTask) _runOpenCodeTask = runOpenCodeTask;
}

// RT client for agent_working/agent_idle publishes (same pattern as executor.mjs setRtClient)
export let _rtClientForApprovals = null;
export function setRtClientForRunners(rt) {
  _rtClientForApprovals = rt;
}

// ── Consts from process.env ────────────────────────────────────────────────
const CREWSWARM_RT_AGENT = process.env.CREWSWARM_RT_AGENT || "crew-main";
const CREWSWARM_OPENCODE_ENABLED = (process.env.CREWSWARM_OPENCODE_ENABLED || "1") !== "0";
const CREWSWARM_CURSOR_WAVES = process.env.CREWSWARM_CURSOR_WAVES === "1";
const CREWSWARM_CLAUDE_CODE = process.env.CREWSWARM_CLAUDE_CODE === "1";
const CREWSWARM_OPENCODE_FORCE = process.env.CREWSWARM_OPENCODE_FORCE === "1";
const CREWSWARM_OPENCODE_TIMEOUT_MS = Number(process.env.CREWSWARM_OPENCODE_TIMEOUT_MS || "300000");
const OPENCODE_SESSION_DIR = path.join(os.homedir(), ".crewswarm", "sessions");

const CODEX_CLI_BIN = process.env.CODEX_CLI_BIN || "codex";
const CODEX_CLI_TIMEOUT_MS = Number(process.env.CODEX_CLI_TIMEOUT_MS || "300000");
const CREWSWARM_CODEX = process.env.CREWSWARM_CODEX === "1" ||
  (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "crewswarm.json"), "utf8"))?.codex === true; } catch { return false; } })();

const GEMINI_CLI_BIN = process.env.GEMINI_CLI_BIN || "gemini";
const GEMINI_CLI_TIMEOUT_MS = Number(process.env.GEMINI_CLI_TIMEOUT_MS || "300000");

const CREWSWARM_ANTIGRAVITY_ENABLED = process.env.CREWSWARM_ANTIGRAVITY_ENABLED === "1";
const CREWSWARM_ANTIGRAVITY_MODEL = process.env.CREWSWARM_ANTIGRAVITY_MODEL || "google/antigravity-gemini-3-pro";

const CURSOR_CLI_BIN = process.env.CURSOR_CLI_BIN ||
  (fs.existsSync(path.join(os.homedir(), ".local", "bin", "agent"))
    ? path.join(os.homedir(), ".local", "bin", "agent")
    : "agent");
const CURSOR_SESSION_DIR = OPENCODE_SESSION_DIR;

const CLAUDE_CODE_BIN = process.env.CLAUDE_CODE_BIN || "claude";
const CLAUDE_SESSION_DIR = OPENCODE_SESSION_DIR;

// ── shouldUse* routing ────────────────────────────────────────────────────

export function shouldUseCursorCli(payload, incomingType) {
  if (incomingType !== "command.run_task" && incomingType !== "task.assigned") return false;
  const runtime = String(payload?.runtime || payload?.executor || "").toLowerCase();
  if (runtime === "cursor" || runtime === "cursor-cli") return true;
  if (payload?.useCursorCli === true) return true;
  const agentId = String(payload?.agentId || payload?.agent || CREWSWARM_RT_AGENT || "").toLowerCase();
  if (agentId === "crew-orchestrator" || agentId === "orchestrator") {
    const ocCfg = _getAgentOpenCodeConfig(agentId);
    if (ocCfg.useCursorCli === true) return true;
    return CREWSWARM_CURSOR_WAVES;
  }
  return _getAgentOpenCodeConfig(agentId).useCursorCli === true;
}

export function shouldUseClaudeCode(payload, incomingType) {
  if (incomingType !== "command.run_task" && incomingType !== "task.assigned") return false;
  if (shouldUseCursorCli(payload, incomingType)) return false;
  const runtime = String(payload?.runtime || payload?.executor || "").toLowerCase();
  if (runtime === "claude" || runtime === "claude-code") return true;
  if (payload?.useClaudeCode === true) return true;
  const agentId = String(payload?.agentId || payload?.agent || CREWSWARM_RT_AGENT || "").toLowerCase();
  try {
    const agents = _loadAgentList();
    const cfg = agents.find(a => a.id === agentId || a.id === `crew-${agentId}`);
    if (cfg?.useClaudeCode === true) return true;
  } catch {}
  return CREWSWARM_CLAUDE_CODE;
}

export function shouldUseOpenCode(payload, prompt, incomingType) {
  if (!CREWSWARM_OPENCODE_ENABLED) return false;
  if (CREWSWARM_OPENCODE_FORCE) return true;
  if (shouldUseCursorCli(payload, incomingType)) return false;

  if (incomingType !== "command.run_task" && incomingType !== "task.assigned") return false;

  const runtime = String(payload?.runtime || payload?.executor || payload?.engine || "").toLowerCase();
  if (runtime === "opencode" || runtime === "gpt5" || runtime === "gpt-5") return true;
  if (payload?.useOpenCode === true) return true;

  const agentId = String(payload?.agentId || payload?.agent || CREWSWARM_RT_AGENT || "").toLowerCase();
  const ocCfg = _getAgentOpenCodeConfig(agentId);
  return ocCfg.enabled;
}

export function shouldUseCodex(payload, incomingType) {
  if (incomingType !== "command.run_task" && incomingType !== "task.assigned") return false;
  if (shouldUseCursorCli(payload, incomingType)) return false;
  if (shouldUseClaudeCode(payload, incomingType)) return false;
  const runtime = String(payload?.runtime || payload?.executor || payload?.engine || "").toLowerCase();
  if (runtime === "codex" || runtime === "codex-cli") return true;
  if (payload?.useCodex === true) return true;
  const agentId = String(payload?.agentId || payload?.agent || CREWSWARM_RT_AGENT || "").toLowerCase();
  try {
    const agents = _loadAgentList();
    const cfg = agents.find(a => a.id === agentId || a.id === `crew-${agentId}`);
    if (cfg?.useCodex === true) return true;
  } catch {}
  return CREWSWARM_CODEX;
}

export function shouldUseGeminiCli(payload, incomingType) {
  if (incomingType !== "command.run_task" && incomingType !== "task.assigned") return false;
  const runtime = String(payload?.runtime || payload?.executor || payload?.engine || "").toLowerCase();
  if (runtime === "gemini" || runtime === "gemini-cli") return true;
  if (payload?.useGeminiCli === true) return true;
  const agentId = String(payload?.agentId || payload?.agent || CREWSWARM_RT_AGENT || "").toLowerCase();
  try {
    const agents = _loadAgentList();
    const cfg = agents.find(a => a.id === agentId || a.id === `crew-${agentId}`);
    if (cfg?.useGeminiCli === true) return true;
  } catch {}
  return process.env.CREWSWARM_GEMINI_CLI_ENABLED === "1";
}

export async function runGeminiCliTask(prompt, payload = {}) {
  return new Promise((resolve, reject) => {
    const agentId = String(payload?.agentId || payload?.agent || CREWSWARM_RT_AGENT || "");
    const configuredDir = _getOpencodeProjectDir();
    let projectDir = payload?.projectDir || configuredDir || process.cwd();
    projectDir = String(projectDir).replace(/[.,;!?]+$/, "");

    const agentPrefix = agentId ? `[${agentId}]` : "";
    const titledPrompt = agentPrefix ? `${agentPrefix} ${String(prompt)}` : String(prompt);

    const model = payload?.geminiCliModel || payload?.model || process.env.CREWSWARM_GEMINI_CLI_MODEL || null;
    const args = ["-p", titledPrompt, "--output-format", "stream-json"];
    if (model) args.push("-m", model);

    console.error(`[GeminiCli:${agentId}] Running: ${GEMINI_CLI_BIN} -p ... (model=${model || "default"}, cwd=${projectDir})`);

    _rtClientForApprovals?.publish({ channel: "events", type: "agent_working", to: "broadcast",
      payload: { agent: agentId, model: model || "gemini/auto", ts: Date.now() } });

    const child = spawn(GEMINI_CLI_BIN, args, {
      cwd: projectDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let lineBuffer = "";
    let accumulatedText = "";
    let resultReceived = false;

    const hardTimer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!resultReceived) reject(new Error(`GeminiCli timeout after ${GEMINI_CLI_TIMEOUT_MS}ms`));
    }, GEMINI_CLI_TIMEOUT_MS);

    function handleLine(line) {
      line = line.trim();
      if (!line) return;
      try {
        const ev = JSON.parse(line);
        if (ev.type === "message" && ev.role === "assistant" && ev.content) {
          accumulatedText += ev.content;
        }
        if (ev.type === "result" && !resultReceived) {
          resultReceived = true;
          clearTimeout(hardTimer);
          child.kill("SIGTERM");
          const out = accumulatedText.trim() || "(gemini cli completed with no text output)";
          console.log(`[GeminiCli:${agentId}] Done — ${out.length} chars`);
          resolve(out);
        }
        if (ev.type === "error") {
          console.error(`[GeminiCli:${agentId}] Error event (${ev.severity}):`, ev.message || JSON.stringify(ev));
        }
      } catch {}
    }

    child.stdout.on("data", (chunk) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop();
      for (const l of lines) handleLine(l);
    });
    child.stderr.on("data", (chunk) => {
      const txt = chunk.toString();
      console.error(`[GeminiCli:${agentId}] stderr: ${txt.slice(0, 200)}`);
    });

    child.on("close", (code) => {
      clearTimeout(hardTimer);
      if (lineBuffer.trim()) handleLine(lineBuffer);
      if (!resultReceived) {
        resultReceived = true;
        if (accumulatedText.trim()) resolve(accumulatedText.trim());
        else reject(new Error(`GeminiCli exited with code ${code} and no output`));
      }
    });

    child.on("error", (e) => {
      clearTimeout(hardTimer);
      if (!resultReceived) { resultReceived = true; reject(e); }
    });
  });
}

export function shouldUseAntigravity(payload, incomingType) {
  if (incomingType !== "command.run_task" && incomingType !== "task.assigned") return false;
  const runtime = String(payload?.runtime || payload?.executor || payload?.engine || "").toLowerCase();
  if (runtime === "antigravity") return true;
  if (payload?.useAntigravity === true) return true;
  const agentId = String(payload?.agentId || payload?.agent || CREWSWARM_RT_AGENT || "").toLowerCase();
  try {
    const agents = _loadAgentList();
    const cfg = agents.find(a => a.id === agentId || a.id === `crew-${agentId}`);
    if (cfg?.useAntigravity === true) return true;
  } catch {}
  return CREWSWARM_ANTIGRAVITY_ENABLED;
}

export async function runAntigravityTask(prompt, payload = {}) {
  const agentId = String(payload?.agentId || payload?.agent || CREWSWARM_RT_AGENT || "");
  const model = payload?.antigravityModel || payload?.model || CREWSWARM_ANTIGRAVITY_MODEL;
  const resolvedModel = model.startsWith("google/") ? model : `google/${model}`;
  return _runOpenCodeTask(prompt, { ...payload, agentId, model: resolvedModel });
}

// ── Cursor CLI session + run ──────────────────────────────────────────────

function readCursorSessionId(agentId) {
  if (!agentId) return null;
  try {
    const f = path.join(CURSOR_SESSION_DIR, `${agentId}.cursor-session`);
    if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim() || null;
  } catch {}
  return null;
}

function writeCursorSessionId(agentId, chatId) {
  if (!agentId || !chatId) return;
  try {
    fs.mkdirSync(CURSOR_SESSION_DIR, { recursive: true });
    fs.writeFileSync(path.join(CURSOR_SESSION_DIR, `${agentId}.cursor-session`), chatId, "utf8");
  } catch {}
}

export async function runCursorCliTask(prompt, payload = {}) {
  return new Promise((resolve, reject) => {
    const agentId = String(payload?.agentId || payload?.agent || CREWSWARM_RT_AGENT || "");
    const configuredDir = _getOpencodeProjectDir();
    let projectDir = payload?.projectDir || configuredDir || process.cwd();
    projectDir = String(projectDir).replace(/[.,;!?]+$/, "");

    const agentPrefix = agentId ? `[${agentId}]` : "";
    const titledPrompt = agentPrefix ? `${agentPrefix} ${String(prompt)}` : String(prompt);

    const args = ["-p", "--force", "--trust", "--output-format", "stream-json", titledPrompt];

    const agentCfg = _getAgentOpenCodeConfig(agentId);
    const model = payload?.cursorCliModel || agentCfg.cursorCliModel || payload?.model || null;
    if (model) args.push("--model", model);

    args.push("--workspace", projectDir);

    const existingChatId = readCursorSessionId(agentId);
    if (existingChatId) {
      args.push(`--resume=${existingChatId}`);
      console.error(`[CursorCLI:${agentId}] Resuming chat ${existingChatId}`);
    }

    console.error(`[CursorCLI:${agentId}] Running: ${CURSOR_CLI_BIN} -p --force --output-format stream-json (workspace=${projectDir})`);

    _rtClientForApprovals?.publish({ channel: "events", type: "agent_working", to: "broadcast",
      payload: { agent: agentId, model: model || "cursor/auto", ts: Date.now() } });

    const child = spawn(CURSOR_CLI_BIN, args, {
      cwd: projectDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let lineBuffer = "";
    let accumulatedText = "";
    let resultReceived = false;
    let resultChatId = null;

    const hardTimer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!resultReceived) reject(new Error(`CursorCLI timeout after ${CREWSWARM_OPENCODE_TIMEOUT_MS}ms`));
    }, CREWSWARM_OPENCODE_TIMEOUT_MS);

    function handleLine(line) {
      line = line.trim();
      if (!line) return;
      try {
        const ev = JSON.parse(line);
        if (ev.type === "assistant") {
          const content = ev.message?.content;
          if (Array.isArray(content)) {
            for (const c of content) {
              if (c.type === "text" && c.text) accumulatedText += c.text;
            }
          } else if (typeof content === "string") {
            accumulatedText += content;
          }
        }
        if (ev.type === "result" && !resultReceived) {
          resultReceived = true;
          resultChatId = ev.chatId || null;
          clearTimeout(hardTimer);
          child.kill("SIGTERM");
          const out = accumulatedText.trim() || "(cursor agent completed with no text output)";
          console.log(`[CursorCLI:${agentId}] Done via stream-json result event — ${out.length} chars`);
          _rtClientForApprovals?.publish({ channel: "events", type: "agent_idle", to: "broadcast",
            payload: { agent: agentId, ts: Date.now() } });
          if (agentId && resultChatId) {
            writeCursorSessionId(agentId, resultChatId);
            console.error(`[CursorCLI:${agentId}] Chat session saved: ${resultChatId}`);
          }
          resolve(out);
        }
      } catch {}
    }

    child.stdout.on("data", (d) => {
      lineBuffer += d.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop();
      lines.forEach(handleLine);
    });
    child.stderr.on("data", (d) => {
      const s = d.toString().trim();
      if (s && !s.startsWith("\x1b")) console.error(`[CursorCLI:${agentId}] stderr: ${s.slice(0, 120)}`);
    });

    child.on("error", (err) => {
      clearTimeout(hardTimer);
      if (!resultReceived) reject(err);
    });

    child.on("close", () => {
      clearTimeout(hardTimer);
      if (!resultReceived) {
        reject(new Error(`CursorCLI exited without a result event. Output so far: ${accumulatedText.slice(0, 300)}`));
      }
    });
  });
}

// ── Claude Code session + run ───────────────────────────────────────────────

function readClaudeSessionId(agentId) {
  if (!agentId) return null;
  try {
    const f = path.join(CLAUDE_SESSION_DIR, `${agentId}.claude-session`);
    if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim() || null;
  } catch {}
  return null;
}

function writeClaudeSessionId(agentId, sessionId) {
  if (!agentId || !sessionId) return;
  try {
    fs.mkdirSync(CLAUDE_SESSION_DIR, { recursive: true });
    fs.writeFileSync(path.join(CLAUDE_SESSION_DIR, `${agentId}.claude-session`), sessionId, "utf8");
  } catch {}
}

export async function runCodexTask(prompt, payload = {}) {
  return new Promise((resolve, reject) => {
    const agentId = String(payload?.agentId || payload?.agent || CREWSWARM_RT_AGENT || "");
    const configuredDir = _getOpencodeProjectDir();
    let projectDir = payload?.projectDir || configuredDir || process.cwd();
    projectDir = String(projectDir).replace(/[.,;!?]+$/, "");

    const agentPrefix = agentId ? `[${agentId}]` : "";
    const titledPrompt = agentPrefix ? `${agentPrefix} ${String(prompt)}` : String(prompt);

    const args = ["exec", "--sandbox", "workspace-write", "--json", titledPrompt];

    console.error(`[Codex:${agentId}] Running: ${CODEX_CLI_BIN} exec --json (cwd=${projectDir})`);

    _rtClientForApprovals?.publish({ channel: "events", type: "agent_working", to: "broadcast",
      payload: { agent: agentId, model: "codex/auto", ts: Date.now() } });

    const child = spawn(CODEX_CLI_BIN, args, {
      cwd: projectDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let lineBuffer = "";
    let accumulatedText = "";
    let resolved = false;

    const hardTimer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!resolved) reject(new Error(`Codex timeout after ${CODEX_CLI_TIMEOUT_MS}ms`));
    }, CODEX_CLI_TIMEOUT_MS);

    function handleLine(line) {
      line = line.trim();
      if (!line) return;
      try {
        const ev = JSON.parse(line);
        if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item?.text) {
          accumulatedText += ev.item.text;
        } else if (ev.type === "turn.completed") {
          clearTimeout(hardTimer);
          resolved = true;
          child.kill("SIGTERM");
          resolve(accumulatedText.trim() || "(no output from Codex)");
        }
      } catch {}
    }

    function onData(chunk) {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || "";
      for (const line of lines) handleLine(line);
    }

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("close", (code) => {
      clearTimeout(hardTimer);
      if (lineBuffer.trim()) handleLine(lineBuffer);
      if (!resolved) {
        resolved = true;
        if (accumulatedText.trim()) resolve(accumulatedText.trim());
        else reject(new Error(`Codex exited with code ${code} and no output`));
      }
    });

    child.on("error", (e) => {
      clearTimeout(hardTimer);
      if (!resolved) { resolved = true; reject(e); }
    });
  });
}

export function shouldUseDockerSandbox(payload, incomingType) {
  if (incomingType !== "command.run_task" && incomingType !== "task.assigned") return false;
  const runtime = String(payload?.runtime || payload?.executor || payload?.engine || "").toLowerCase();
  if (runtime === "docker-sandbox" || runtime === "docker") return true;
  if (payload?.useDockerSandbox === true) return true;
  const agentId = String(payload?.agentId || payload?.agent || CREWSWARM_RT_AGENT || "").toLowerCase();
  try {
    const agents = _loadAgentList();
    const cfg = agents.find(a => a.id === agentId || a.id === `crew-${agentId}`);
    if (cfg?.useDockerSandbox === true) return true;
  } catch {}
  return process.env.CREWSWARM_DOCKER_SANDBOX === "1";
}

export async function runDockerSandboxTask(prompt, payload = {}) {
  return new Promise((resolve, reject) => {
    const agentId = String(payload?.agentId || payload?.agent || CREWSWARM_RT_AGENT || "");
    const configuredDir = _getOpencodeProjectDir();
    let projectDir = payload?.projectDir || configuredDir || process.cwd();
    projectDir = String(projectDir).replace(/[.,;!?]+$/, "");

    const sandboxName = process.env.CREWSWARM_DOCKER_SANDBOX_NAME || "crewswarm";
    const innerEngine = (process.env.CREWSWARM_DOCKER_SANDBOX_INNER_ENGINE || "claude").toLowerCase();

    const agentPrefix = agentId ? `[${agentId}]` : "";
    const titledPrompt = agentPrefix ? `${agentPrefix} ${String(prompt)}` : String(prompt);

    let innerArgs;
    if (innerEngine === "opencode") {
      innerArgs = ["opencode", "run", titledPrompt, "--model", process.env.CREWSWARM_OPENCODE_MODEL || "anthropic/claude-sonnet-4-5"];
    } else if (innerEngine === "codex") {
      innerArgs = ["codex", "exec", "--sandbox", "workspace-write", "--json", titledPrompt];
    } else {
      innerArgs = ["claude", "-p", "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose", titledPrompt];
    }

    const args = ["sandbox", "exec", sandboxName, "--", ...innerArgs];
    console.error(`[DockerSandbox:${agentId}] Running: docker ${args.slice(0, 4).join(" ")} (inner=${innerEngine}, cwd=${projectDir})`);

    _rtClientForApprovals?.publish({ channel: "events", type: "agent_working", to: "broadcast",
      payload: { agent: agentId, model: `docker-sandbox/${innerEngine}`, ts: Date.now() } });

    const TIMEOUT_MS = parseInt(process.env.CREWSWARM_DOCKER_SANDBOX_TIMEOUT_MS || "300000", 10);
    const child = spawn("docker", args, {
      cwd: projectDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let lineBuffer = "";
    let accumulatedText = "";
    let resolved = false;
    let receivedDeltas = false;

    const hardTimer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!resolved) reject(new Error(`Docker Sandbox timeout after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    function handleLine(line) {
      line = line.trim();
      if (!line) return;
      if (innerEngine === "opencode") {
        accumulatedText += line + "\n";
        return;
      }
      if (innerEngine === "codex") {
        try {
          const ev = JSON.parse(line);
          if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item?.text) {
            accumulatedText += ev.item.text;
          } else if (ev.type === "turn.completed") {
            clearTimeout(hardTimer); resolved = true;
            child.kill("SIGTERM");
            resolve(accumulatedText.trim() || "(no output from Docker Sandbox / Codex)");
          }
        } catch {}
        return;
      }
      try {
        const ev = JSON.parse(line);
        if (ev.type === "stream_event" && ev.event?.type === "content_block_delta") {
          const t = ev.event.delta?.text || "";
          if (t) { accumulatedText += t; receivedDeltas = true; }
        } else if (ev.type === "assistant" && !receivedDeltas) {
          const content = ev.message?.content;
          if (Array.isArray(content)) { for (const c of content) { if (c.type === "text") accumulatedText += c.text; } }
          else if (typeof content === "string") accumulatedText += content;
        } else if (ev.type === "result") {
          if (!accumulatedText && ev.result) accumulatedText += ev.result;
          clearTimeout(hardTimer); resolved = true;
          child.kill("SIGTERM");
          resolve(accumulatedText.trim() || "(no output from Docker Sandbox / Claude)");
        }
      } catch { accumulatedText += line + "\n"; }
    }

    function onData(chunk) {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || "";
      for (const line of lines) handleLine(line);
    }

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("close", (code) => {
      clearTimeout(hardTimer);
      if (lineBuffer.trim()) handleLine(lineBuffer);
      if (!resolved) {
        resolved = true;
        if (accumulatedText.trim()) resolve(accumulatedText.trim());
        else reject(new Error(`Docker Sandbox exited with code ${code} and no output`));
      }
    });

    child.on("error", (e) => {
      clearTimeout(hardTimer);
      if (!resolved) { resolved = true; reject(e); }
    });
  });
}

export async function runClaudeCodeTask(prompt, payload = {}) {
  return new Promise((resolve, reject) => {
    const agentId = String(payload?.agentId || payload?.agent || CREWSWARM_RT_AGENT || "");
    const configuredDir = _getOpencodeProjectDir();
    let projectDir = payload?.projectDir || configuredDir || process.cwd();
    projectDir = String(projectDir).replace(/[.,;!?]+$/, "");

    const agentPrefix = agentId ? `[${agentId}]` : "";
    const titledPrompt = agentPrefix ? `${agentPrefix} ${String(prompt)}` : String(prompt);

    const args = [
      "-p",
      "--dangerously-skip-permissions",
      "--output-format", "stream-json",
    ];

    const agentCfg = _getAgentOpenCodeConfig(agentId);
    const model = payload?.claudeCodeModel || agentCfg.claudeCodeModel || payload?.model || null;
    if (model && !model.includes("/")) {
      args.push("--model", model);
    }

    const existingSession = readClaudeSessionId(agentId);
    if (existingSession) {
      args.push("--resume", existingSession);
      console.error(`[ClaudeCode:${agentId}] Resuming session ${existingSession}`);
    }

    args.push(titledPrompt);

    console.error(`[ClaudeCode:${agentId}] Running: ${CLAUDE_CODE_BIN} -p --dangerously-skip-permissions (cwd=${projectDir})`);

    _rtClientForApprovals?.publish({ channel: "events", type: "agent_working", to: "broadcast",
      payload: { agent: agentId, model: model || "claude/auto", ts: Date.now() } });

    const child = spawn(CLAUDE_CODE_BIN, args, {
      cwd: projectDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let lineBuffer = "";
    let accumulatedText = "";
    let resultReceived = false;
    let resultSessionId = null;

    const hardTimer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!resultReceived) reject(new Error(`ClaudeCode timeout after ${CREWSWARM_OPENCODE_TIMEOUT_MS}ms`));
    }, CREWSWARM_OPENCODE_TIMEOUT_MS);

    function handleLine(line) {
      line = line.trim();
      if (!line) return;
      try {
        const ev = JSON.parse(line);

        if (ev.type === "stream_event") {
          const inner = ev.event;
          if (inner?.type === "content_block_delta" && inner?.delta?.type === "text_delta") {
            accumulatedText += inner.delta.text || "";
          }
        }

        if (ev.type === "assistant") {
          const content = ev.message?.content;
          if (Array.isArray(content)) {
            for (const c of content) {
              if (c.type === "text" && c.text) accumulatedText += c.text;
            }
          } else if (typeof content === "string") {
            accumulatedText += content;
          }
        }

        if (ev.type === "result" && !resultReceived) {
          resultReceived = true;
          resultSessionId = ev.session_id || ev.sessionId || ev.chatId || null;
          clearTimeout(hardTimer);
          child.kill("SIGTERM");
          const out = (ev.result || accumulatedText).trim() || "(claude code completed with no text output)";
          console.log(`[ClaudeCode:${agentId}] Done — ${out.length} chars`);

          try {
            const modelUsage = ev.modelUsage || {};
            const modelEntries = Object.entries(modelUsage);
            let totalInputTokens = 0, totalOutputTokens = 0;
            if (modelEntries.length > 0) {
              for (const [mid, mu] of modelEntries) {
                const p = (mu.inputTokens || 0) + (mu.cacheCreationInputTokens || 0);
                const c = mu.outputTokens || 0;
                totalInputTokens  += p;
                totalOutputTokens += c;
                recordTokenUsage(mid, {
                  prompt_tokens:          p,
                  completion_tokens:      c,
                  cache_read_input_tokens: mu.cacheReadInputTokens || 0,
                }, null);
              }
            } else if (ev.usage) {
              const u = ev.usage;
              totalInputTokens  = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
              totalOutputTokens = u.output_tokens || 0;
              recordTokenUsage("claude/auto", {
                prompt_tokens:          totalInputTokens,
                completion_tokens:      totalOutputTokens,
                cache_read_input_tokens: u.cache_read_input_tokens || 0,
              }, null);
            }
            const exactCost = Number(ev.total_cost_usd || 0);
            if (agentId && (exactCost > 0 || totalInputTokens > 0)) {
              addAgentSpend(agentId, totalInputTokens + totalOutputTokens, exactCost);
              console.log(`[ClaudeCode:${agentId}] Cost: $${exactCost.toFixed(6)} (${totalInputTokens}in + ${totalOutputTokens}out tokens)`);
            }
          } catch (usageErr) {
            console.warn(`[ClaudeCode:${agentId}] Usage capture failed: ${usageErr.message}`);
          }

          _rtClientForApprovals?.publish({ channel: "events", type: "agent_idle", to: "broadcast",
            payload: { agent: agentId, ts: Date.now() } });
          if (agentId && resultSessionId) {
            writeClaudeSessionId(agentId, resultSessionId);
            console.error(`[ClaudeCode:${agentId}] Session saved: ${resultSessionId}`);
          }
          resolve(out);
        }
      } catch {}
    }

    child.stdout.on("data", (d) => {
      lineBuffer += d.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop();
      lines.forEach(handleLine);
    });
    child.stderr.on("data", (d) => {
      const s = d.toString().trim();
      if (s && !s.startsWith("\x1b")) console.error(`[ClaudeCode:${agentId}] stderr: ${s.slice(0, 160)}`);
    });
    child.on("error", (err) => {
      clearTimeout(hardTimer);
      if (!resultReceived) reject(err);
    });
    child.on("close", () => {
      clearTimeout(hardTimer);
      if (!resultReceived) {
        reject(new Error(`ClaudeCode exited without a result event. Output so far: ${accumulatedText.slice(0, 300)}`));
      }
    });
  });
}
