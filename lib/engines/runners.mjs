/**
 * Engine runners — extracted from gateway-bridge.mjs
 * shouldUse* routing and run*Task implementations for Cursor CLI, Claude Code,
 * Codex, Gemini CLI, Docker Sandbox, and generic drop-in JSON engines.
 *
 * Inject: initRunners({ getAgentOpenCodeConfig, loadAgentList, getOpencodeProjectDir,
 *                       buildMiniTaskForOpenCode, runOpenCodeTask, loadGenericEngines })
 *
 * Drop-in engines: place a JSON file in engines/ or ~/.crewswarm/engines/ with
 * { id, bin, args: { run: [...] }, outputMode: "stream-json"|"streaming", agentConfigKey, envToggle }
 * and it is picked up automatically — no code changes needed.
 */

import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { recordTokenUsage, addAgentSpend } from "../runtime/spending.mjs";
import { loadSystemConfig, loadSwarmConfig } from "../runtime/config.mjs";
import { initEngineRegistry, selectEngine as registrySelectEngine, getEngineById } from "./engine-registry.mjs";
import { runCrewCLITask } from "./crew-cli.mjs";
import { normalizeProjectDir } from "../runtime/project-dir.mjs";
import { resolveCursorLaunchSpec } from "./cursor-launcher.mjs";

function which(bin) {
  try { execSync(`which ${bin}`, { stdio: "ignore" }); return true; } catch { return false; }
}

// ── Module-level deps (injected via initRunners) ───────────────────────────
let _getAgentOpenCodeConfig = () => ({ enabled: false, useCursorCli: false, cursorCliModel: null, claudeCodeModel: null });
let _loadAgentList = () => [];
let _getOpencodeProjectDir = () => null;
let _runOpenCodeTask = async () => "";
let _loadGenericEngines = () => [];

function findAgentConfig(agentId) {
  const canonical = String(agentId || CREWSWARM_RT_AGENT || "").toLowerCase();
  try {
    const agents = _loadAgentList();
    return (
      agents.find((a) => a.id === canonical || a.id === `crew-${canonical}`) || null
    );
  } catch {
    return null;
  }
}

function agentUsesEngine(agentId, engineIds = [], flagKey = null) {
  const cfg = findAgentConfig(agentId);
  if (!cfg) return false;
  if (flagKey && cfg?.[flagKey] === true) return true;
  const cfgEngine = String(cfg.engine || "").toLowerCase();
  return !!(cfgEngine && engineIds.includes(cfgEngine));
}

export function initRunners({ getAgentOpenCodeConfig, loadAgentList, getOpencodeProjectDir, buildMiniTaskForOpenCode, runOpenCodeTask, loadGenericEngines } = {}) {
  if (getAgentOpenCodeConfig) _getAgentOpenCodeConfig = getAgentOpenCodeConfig;
  if (loadAgentList) _loadAgentList = loadAgentList;
  if (getOpencodeProjectDir) _getOpencodeProjectDir = getOpencodeProjectDir;
  if (runOpenCodeTask) _runOpenCodeTask = runOpenCodeTask;
  if (loadGenericEngines) _loadGenericEngines = loadGenericEngines;
  
  // Initialize engine registry with runner functions
  initEngineRegistry({
    loadAgentList: _loadAgentList,
    engineRunners: {
      'cursor': runCursorCliTask,
      'claude-code': runClaudeCodeTask,
      'codex': runCodexTask,
      'docker-sandbox': runDockerSandboxTask,
      'crew-cli': runCrewCLITask,
      'gemini-cli': runGeminiCliTask,
      'opencode': runOpenCodeTask
    }
  });
}

// Export selectEngine for use in rt-envelope
export function selectEngine(payload, incomingType) {
  return registrySelectEngine(payload, incomingType);
}

// RT client for agent_working/agent_idle publishes (same pattern as executor.mjs setRtClient)
export let _rtClientForApprovals = null;
export function setRtClientForRunners(rt) {
  _rtClientForApprovals = rt;
}

// ── Consts from process.env ────────────────────────────────────────────────
const CREWSWARM_RT_AGENT = process.env.CREWSWARM_RT_AGENT || "crew-main";
const CREWSWARM_OPENCODE_ENABLED = process.env.CREWSWARM_OPENCODE_ENABLED === "1";  // Opt-IN (was opt-OUT)
const CREWSWARM_CURSOR_WAVES = process.env.CREWSWARM_CURSOR_WAVES === "1";
// Evaluated at call time so env overrides and tests work correctly
function _isClaudeCodeEnabled() {
  if (process.env.CREWSWARM_CLAUDE_CODE) return /^1|true|yes$/i.test(String(process.env.CREWSWARM_CLAUDE_CODE));
  const cfg = loadSystemConfig();
  if (typeof cfg.claudeCode === "boolean") return cfg.claudeCode;
  return false;
}
const CREWSWARM_OPENCODE_FORCE = process.env.CREWSWARM_OPENCODE_FORCE === "1";
// Legacy fixed timeout — kept for OpenCode. Cursor/Claude use activity-based watchdog instead.
const CREWSWARM_OPENCODE_TIMEOUT_MS = Number(process.env.CREWSWARM_OPENCODE_TIMEOUT_MS || "300000");
// Idle watchdog: kill engine if no stdout/stderr activity for this long (default 5 min).
const CREWSWARM_ENGINE_IDLE_TIMEOUT_MS = Number(process.env.CREWSWARM_ENGINE_IDLE_TIMEOUT_MS || "300000");
// Absolute ceiling for any single engine task — safety net (default 45 min).
const CREWSWARM_ENGINE_MAX_TOTAL_MS = Number(process.env.CREWSWARM_ENGINE_MAX_TOTAL_MS || "2700000");
const OPENCODE_SESSION_DIR = path.join(os.homedir(), ".crewswarm", "sessions");

const CODEX_CLI_BIN = process.env.CODEX_CLI_BIN || "codex";
const CODEX_CLI_TIMEOUT_MS = Number(process.env.CODEX_CLI_TIMEOUT_MS || "300000");
// Evaluated at call time so env overrides and tests work correctly
function _isCodexEnabled() {
  if (process.env.CREWSWARM_CODEX === "1") return true;
  const swarm = loadSwarmConfig();
  return swarm?.codex === true;
}

const GEMINI_CLI_BIN = process.env.GEMINI_CLI_BIN || "gemini";
const GEMINI_CLI_TIMEOUT_MS = Number(process.env.GEMINI_CLI_TIMEOUT_MS || "300000");

/**
 * `gemini -m` expects a Google model id (e.g. gemini-2.5-flash), not crewswarm roster strings
 * like openai/gpt-5.2 — those produce ModelNotFoundError (404) from the Gemini API.
 *
 * @param {Record<string, unknown>} payload
 * @returns {string|null}
 */
function normalizeGeminiCliModelId(raw) {
  let s = String(raw || "").trim();
  if (!s) return null;
  s = s.replace(/^models\//i, "");
  return s || null;
}

function resolveGeminiCliModelFlag(payload) {
  const explicit = normalizeGeminiCliModelId(payload?.geminiCliModel);
  if (explicit) return explicit;
  const envM = normalizeGeminiCliModelId(process.env.CREWSWARM_GEMINI_CLI_MODEL);
  if (envM) return envM;
  const agentModel = String(payload?.model || "").trim();
  if (!agentModel) return null;
  if (agentModel.includes("/")) {
    if (/^google\/models\//i.test(agentModel)) {
      return normalizeGeminiCliModelId(
        agentModel.replace(/^google\/models\//i, "").replace(/^google\//i, ""),
      );
    }
    if (/^google\//i.test(agentModel)) {
      return normalizeGeminiCliModelId(agentModel.replace(/^google\//i, ""));
    }
    return null;
  }
  if (/^gemini[\w.-]+$/i.test(agentModel))
    return normalizeGeminiCliModelId(agentModel);
  return null;
}

function resolveCodexCliModel(payload, agentCfg = null) {
  const explicit = String(payload?.codexModel || "").trim();
  if (explicit) return explicit;
  const agentModel = String(agentCfg?.codexModel || "").trim();
  if (agentModel) return agentModel;
  const envModel = String(process.env.CREWSWARM_CODEX_MODEL || "").trim();
  if (envModel) return envModel;
  return null;
}

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
  if (agentUsesEngine(agentId, ["cursor", "cursor-cli"], "useCursorCli")) return true;
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
  if (agentUsesEngine(agentId, ["claude", "claude-code"], "useClaudeCode")) return true;
  // Global fallback — but skip if the agent explicitly uses another engine
  if (_isClaudeCodeEnabled()) {
    const ocCfg = _getAgentOpenCodeConfig(agentId);
    // Skip if agent explicitly uses crew-cli, codex, gemini-cli, docker-sandbox, or opencode
    if (ocCfg.useCrewCLI === true) return false;
    if (ocCfg.useCodex === true) return false;
    if (ocCfg.useGeminiCli === true) return false;
    if (ocCfg.useDockerSandbox === true) return false;
    if (ocCfg.enabled) return false; // useOpenCode
    const cfg = findAgentConfig(agentId);
    const eng = String(cfg?.engine || "").toLowerCase();
    if (
      eng &&
      ["codex", "codex-cli", "cursor", "cursor-cli", "opencode", "gpt5", "gpt-5", "gemini", "gemini-cli", "crew-cli", "crewcli", "docker-sandbox"].includes(eng)
    ) {
      return false;
    }
    // Skip agents with no engine set but a specific model (they use LLM-direct)
    if (!eng && cfg?.model) {
      return false;
    }
    return true;
  }
  return false;
}

export function shouldUseOpenCode(payload, prompt, incomingType) {
  if (!CREWSWARM_OPENCODE_ENABLED) return false;
  if (CREWSWARM_OPENCODE_FORCE) return true;
  if (shouldUseCursorCli(payload, incomingType)) return false;
  if (shouldUseClaudeCode(payload, incomingType)) return false;
  if (shouldUseCodex(payload, incomingType)) return false;

  if (incomingType !== "command.run_task" && incomingType !== "task.assigned") return false;

  const runtime = String(payload?.runtime || payload?.executor || payload?.engine || "").toLowerCase();
  if (runtime === "opencode" || runtime === "gpt5" || runtime === "gpt-5") return true;
  if (payload?.useOpenCode === true) return true;

  const agentId = String(payload?.agentId || payload?.agent || CREWSWARM_RT_AGENT || "").toLowerCase();
  if (agentUsesEngine(agentId, ["opencode", "gpt5", "gpt-5"], "useOpenCode")) return true;
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
  if (agentUsesEngine(agentId, ["codex", "codex-cli"], "useCodex")) return true;
  if (_isCodexEnabled()) {
    const cfg = findAgentConfig(agentId);
    const eng = String(cfg?.engine || "").toLowerCase();
    // Skip agents that explicitly use a different engine
    if (eng && !["codex", "codex-cli"].includes(eng)) {
      return false;
    }
    // Skip agents with no engine set but a specific model (they use LLM-direct)
    if (!eng && cfg?.model) {
      return false;
    }
    return true;
  }
  return false;
}

export function shouldUseGeminiCli(payload, incomingType) {
  if (incomingType !== "command.run_task" && incomingType !== "task.assigned") return false;
  // Check higher-priority engines first
  if (shouldUseCursorCli(payload, incomingType)) return false;
  if (shouldUseClaudeCode(payload, incomingType)) return false;
  if (shouldUseCodex(payload, incomingType)) return false;
  if (shouldUseDockerSandbox(payload, incomingType)) return false;
  if (shouldUseCrewCLI(payload, incomingType)) return false;
  
  const runtime = String(payload?.runtime || payload?.executor || payload?.engine || "").toLowerCase();
  if (runtime === "gemini" || runtime === "gemini-cli") return true;
  if (payload?.useGeminiCli === true) return true;
  const agentId = String(payload?.agentId || payload?.agent || CREWSWARM_RT_AGENT || "").toLowerCase();
  if (agentUsesEngine(agentId, ["gemini", "gemini-cli"], "useGeminiCli")) return true;
  return process.env.CREWSWARM_GEMINI_CLI_ENABLED === "1";
}

export function shouldUseCrewCLI(payload, incomingType) {
  if (incomingType !== "command.run_task" && incomingType !== "task.assigned") return false;
  // Check higher-priority engines first
  if (shouldUseCursorCli(payload, incomingType)) return false;
  if (shouldUseClaudeCode(payload, incomingType)) return false;
  if (shouldUseCodex(payload, incomingType)) return false;
  if (shouldUseDockerSandbox(payload, incomingType)) return false;
  
  const runtime = String(payload?.runtime || payload?.executor || payload?.engine || "").toLowerCase();
  if (runtime === "crew-cli" || runtime === "crewcli") return true;
  if (payload?.useCrewCLI === true) return true;
  const agentId = String(payload?.agentId || payload?.agent || CREWSWARM_RT_AGENT || "").toLowerCase();
  try {
    const agents = _loadAgentList();
    const cfg = agents.find(a => a.id === agentId || a.id === `crew-${agentId}`);
    if (cfg?.useCrewCLI === true) return true;
  } catch {}
  return process.env.CREWSWARM_CREW_CLI_ENABLED === "1";
}

export async function runGeminiCliTask(prompt, payload = {}) {
  return new Promise((resolve, reject) => {
    const agentId = String(payload?.agentId || payload?.agent || CREWSWARM_RT_AGENT || "");
    const taskBody = String(prompt ?? "").trim();
    if (!taskBody) {
      reject(
        new Error(
          "Gemini CLI: task text is empty — the gateway sent no instructions.",
        ),
      );
      return;
    }

    const configuredDir = _getOpencodeProjectDir();
    let projectDir = payload?.projectDir || configuredDir || process.cwd();
    projectDir = String(projectDir).replace(/[.,;!?]+$/, "");
    const expandedDir = normalizeProjectDir(projectDir) || projectDir;
    if (expandedDir && fs.existsSync(expandedDir)) {
      projectDir = expandedDir;
    } else if (!fs.existsSync(projectDir)) {
      console.error(
        `[GeminiCli:${agentId}] projectDir not found (${projectDir}), using process.cwd()`,
      );
      projectDir = process.cwd();
    }

    const agentPrefix = agentId ? `[${agentId}]` : "";
    const titledPrompt = agentPrefix ? `${agentPrefix} ${String(prompt)}` : String(prompt);

    const model = resolveGeminiCliModelFlag(payload);
    const args = ["-p", titledPrompt, "--output-format", "stream-json", "--yolo"];
    if (model) args.push("-m", model);
    else if (payload?.model && String(payload.model).includes("/")) {
      console.error(
        `[GeminiCli:${agentId}] Omitting -m: roster model "${payload.model}" is not a Gemini CLI id. Set per-agent geminiCliModel (e.g. gemini-2.5-flash) or CREWSWARM_GEMINI_CLI_MODEL — using CLI default.`,
      );
    }

    console.error(
      `[GeminiCli:${agentId}] spawn: ${GEMINI_CLI_BIN} -m ${model || "(default)"} … cwd=${projectDir} payload.geminiCliModel=${payload?.geminiCliModel ?? "(none)"}`,
    );

    _rtClientForApprovals?.publish({ channel: "events", type: "agent_working", to: "broadcast",
      payload: { agent: agentId, model: model || "gemini/auto", ts: Date.now() } });

    const child = spawn(GEMINI_CLI_BIN, args, {
      cwd: projectDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let lineBuffer = "";
    let accumulatedText = "";
    let orphanStream = "";
    const appendOrphan = (line) => {
      const s = String(line).trim();
      if (!s) return;
      orphanStream = (orphanStream + (orphanStream ? "\n" : "") + s).slice(-8000);
    };
    /** @type {string[]} */
    const geminiErrorEvents = [];
    let stderrBuf = "";
    let resultReceived = false;

    const hardTimer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!resultReceived) reject(new Error(`GeminiCli timeout after ${GEMINI_CLI_TIMEOUT_MS}ms`));
    }, GEMINI_CLI_TIMEOUT_MS);

    function failEmpty(label, code, signal) {
      const errTail = geminiErrorEvents.length
        ? `\n--- Gemini JSON error events ---\n${geminiErrorEvents.join("\n")}`
        : "";
      const stderrTail = stderrBuf.trim()
        ? `\n--- stderr ---\n${stderrBuf.trim().slice(-6000)}`
        : "";
      const orphanTail = orphanStream.trim()
        ? `\n--- non-JSON stdout ---\n${orphanStream.trim().slice(-4000)}`
        : "";
      const meta = `\n(cwd=${projectDir}, bin=${GEMINI_CLI_BIN}, code=${code}${signal ? `, signal=${signal}` : ""})`;
      console.error(`[GeminiCli:${agentId}] ${label}${meta}${stderrTail.slice(0, 500)}`);
      reject(new Error(`${label}${errTail}${stderrTail}${orphanTail}${meta}`));
    }

    function handleLine(line) {
      line = line.trim();
      if (!line) return;
      try {
        const ev = JSON.parse(line);
        // Collect streaming text chunks (delta:true) or fall back to any assistant message
        if (ev.type === "message" && ev.role === "assistant") {
          if (ev.delta === true && ev.content) {
            accumulatedText += ev.content;
          } else if (ev.delta !== false && ev.content && !accumulatedText) {
            // Some versions may not have delta flag — only use if we have nothing yet
            accumulatedText += ev.content;
          }
        }
        if (ev.type === "result" && !resultReceived) {
          resultReceived = true;
          clearTimeout(hardTimer);
          child.kill("SIGTERM");
          const fromResult = (ev.response || "").trim();
          const out = accumulatedText.trim() || fromResult;
          if (!out) {
            failEmpty(
              "Gemini CLI returned an empty result (no assistant text and no response field).",
              0,
              null,
            );
            return;
          }
          console.log(`[GeminiCli:${agentId}] Done — ${out.length} chars`);
          resolve(out);
          return;
        }
        if (ev.type === "error") {
          const msg = ev.message || JSON.stringify(ev);
          geminiErrorEvents.push(msg);
          console.error(`[GeminiCli:${agentId}] Error event (${ev.severity}):`, msg);
        }
      } catch {
        appendOrphan(line);
      }
    }

    child.stdout.on("data", (chunk) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop();
      for (const l of lines) handleLine(l);
    });
    child.stderr.on("data", (chunk) => {
      const txt = chunk.toString();
      stderrBuf = (stderrBuf + txt).slice(-12000);
      console.error(`[GeminiCli:${agentId}] stderr: ${txt.slice(0, 400)}`);
    });

    child.on("close", (code, signal) => {
      clearTimeout(hardTimer);
      if (lineBuffer.trim()) handleLine(lineBuffer);
      if (!resultReceived) {
        resultReceived = true;
        if (accumulatedText.trim()) resolve(accumulatedText.trim());
        else
          failEmpty(
            `GeminiCli exited with code ${code} and no usable output`,
            code,
            signal,
          );
      }
    });

    child.on("error", (e) => {
      clearTimeout(hardTimer);
      if (!resultReceived) {
        resultReceived = true;
        reject(
          new Error(
            `${e?.message || e} (cwd=${projectDir}, bin=${GEMINI_CLI_BIN})`,
          ),
        );
      }
    });
  });
}

// ── Generic drop-in engine runner ────────────────────────────────────────────
// Handles any engine JSON that has: bin, args.run, outputMode, agentConfigKey.
// To add a new engine: drop a JSON in engines/ or ~/.crewswarm/engines/ — no code changes needed.

export function shouldUseGenericEngine(engineDef, payload, incomingType) {
  if (incomingType !== "command.run_task" && incomingType !== "task.assigned") return false;
  const runtime = String(payload?.runtime || payload?.executor || payload?.engine || "").toLowerCase();
  if (runtime === engineDef.id) return true;
  if (Array.isArray(engineDef.runtimeAlias) && engineDef.runtimeAlias.includes(runtime)) return true;
  const configKey = engineDef.agentConfigKey;
  if (configKey && payload?.[configKey] === true) return true;
  const agentId = String(payload?.agentId || payload?.agent || CREWSWARM_RT_AGENT || "").toLowerCase();
  try {
    const agents = _loadAgentList();
    const cfg = agents.find(a => a.id === agentId || a.id === `crew-${agentId}`);
    const cfgEngine = String(cfg?.engine || "").toLowerCase();
    if (configKey && cfg?.[configKey] === true) return true;
    if (
      cfgEngine &&
      (cfgEngine === engineDef.id ||
        (Array.isArray(engineDef.runtimeAlias) && engineDef.runtimeAlias.includes(cfgEngine)))
    ) {
      return true;
    }
  } catch {}
  if (engineDef.envToggle) return process.env[engineDef.envToggle] === "1";
  return false;
}

export async function runGenericEngineTask(engineDef, prompt, payload = {}) {
  return new Promise((resolve, reject) => {
    const agentId = String(payload?.agentId || payload?.agent || CREWSWARM_RT_AGENT || "");
    const configuredDir = _getOpencodeProjectDir();
    let projectDir = payload?.projectDir || configuredDir || process.cwd();
    projectDir = String(projectDir).replace(/[.,;!?]+$/, "");

    const agentPrefix = agentId ? `[${agentId}]` : "";
    const titledPrompt = agentPrefix ? `${agentPrefix} ${String(prompt)}` : String(prompt);

    // Resolve model: payload modelKey → payload.model → env var → default
    const modelKey = engineDef.modelKey ||
      (engineDef.agentConfigKey ? engineDef.agentConfigKey.replace(/^use/, '').replace(/^./, c => c.toLowerCase()) + 'Model' : null);
    const rawModel = (modelKey && payload?.[modelKey])
      || payload?.model
      || (engineDef.modelEnvVar ? process.env[engineDef.modelEnvVar] : null)
      || engineDef.defaultModel
      || null;

    // Build args from template — use run_with_model if model is set and template exists
    const argsTemplate = (rawModel && engineDef.args?.run_with_model)
      ? engineDef.args.run_with_model
      : engineDef.args?.run || ["-p", "{prompt}"];
    const args = argsTemplate.map(a =>
      a.replace(/{prompt}/g, titledPrompt)
       .replace(/{model}/g, rawModel || "")
       .replace(/{agent}/g, agentId)
    ).filter(a => a !== "");

    const bin = engineDef.bin;
    const outputMode = engineDef.outputMode || "streaming";
    const timeoutMs = Number(
      (engineDef.timeoutEnv ? process.env[engineDef.timeoutEnv] : null) || engineDef.timeoutMs || 300000
    );

    console.error(`[${engineDef.id}:${agentId}] Running: ${bin} ${args.slice(0, 3).join(" ")}... (model=${rawModel || "default"}, cwd=${projectDir})`);

    _rtClientForApprovals?.publish({ channel: "events", type: "agent_working", to: "broadcast",
      payload: { agent: agentId, model: rawModel || engineDef.id, ts: Date.now() } });

    const child = spawn(bin, args, { cwd: projectDir, env: process.env, stdio: ["ignore", "pipe", "pipe"] });

    let lineBuffer = "";
    let accumulatedText = "";
    let resultReceived = false;

    const hardTimer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!resultReceived) reject(new Error(`${engineDef.label || engineDef.id} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function handleStreamJsonLine(line) {
      line = line.trim();
      if (!line) return;
      try {
        const ev = JSON.parse(line);
        if (ev.type === "message" && ev.role === "assistant" && ev.content) accumulatedText += ev.content;
        if (ev.type === "result" && !resultReceived) {
          resultReceived = true;
          clearTimeout(hardTimer);
          child.kill("SIGTERM");
          const out = accumulatedText.trim() || `(${engineDef.id} completed with no text output)`;
          console.log(`[${engineDef.id}:${agentId}] Done — ${out.length} chars`);
          resolve(out);
        }
        if (ev.type === "error") {
          console.error(`[${engineDef.id}:${agentId}] Error:`, ev.message || JSON.stringify(ev));
        }
      } catch {}
    }

    child.stdout.on("data", (chunk) => {
      if (outputMode === "stream-json") {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop();
        for (const l of lines) handleStreamJsonLine(l);
      } else {
        accumulatedText += chunk.toString();
      }
    });
    child.stderr.on("data", (chunk) => {
      console.error(`[${engineDef.id}:${agentId}] stderr: ${chunk.toString().slice(0, 200)}`);
    });
    child.on("close", (code) => {
      clearTimeout(hardTimer);
      if (outputMode === "stream-json" && lineBuffer.trim()) handleStreamJsonLine(lineBuffer);
      if (!resultReceived) {
        resultReceived = true;
        if (accumulatedText.trim()) resolve(accumulatedText.trim());
        else reject(new Error(`${engineDef.label || engineDef.id} exited code=${code} with no output`));
      }
    });
    child.on("error", (e) => {
      clearTimeout(hardTimer);
      if (!resultReceived) { resultReceived = true; reject(e); }
    });
  });
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

    const args = [
      "-p",
      "--force",
      "--trust",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      titledPrompt,
    ];

    const agentCfg = _getAgentOpenCodeConfig(agentId);
    const cursorDefault =
      process.env.CREWSWARM_CURSOR_MODEL || "composer-2-fast";
    let model =
      payload?.cursorCliModel || agentCfg.cursorCliModel || null;
    if (!model || String(model).trim() === "") {
      model = cursorDefault;
    } else if (String(model).includes("/")) {
      // Provider assignment (e.g. anthropic/claude-…) is not a Cursor CLI id
      model = cursorDefault;
    } else if (String(model).includes("sonnet-4.6")) {
      model = "sonnet-4.5";
    }
    args.push("--model", model);

    args.push("--workspace", projectDir);

    const existingChatId = readCursorSessionId(agentId);
    if (existingChatId) {
      args.push(`--resume=${existingChatId}`);
      console.error(`[CursorCLI:${agentId}] Resuming chat ${existingChatId}`);
    }

    const cursorSpec = resolveCursorLaunchSpec(CURSOR_CLI_BIN);

    // Early exit if binary doesn't exist — triggers fallback to OpenCode in rt-envelope.
    if (!fs.existsSync(cursorSpec.bin) && !which(cursorSpec.bin)) {
      throw new Error(`CursorCLI binary not found: "${cursorSpec.bin}". Install Cursor or set CURSOR_CLI_BIN.`);
    }

    const spawnArgs = [...cursorSpec.argsPrefix, ...args];
    console.error(`[CursorCLI:${agentId}] Running: ${cursorSpec.displayCommand} -p --force --trust --output-format stream-json --stream-partial-output (workspace=${projectDir})`);

    _rtClientForApprovals?.publish({ channel: "events", type: "agent_working", to: "broadcast",
      payload: { agent: agentId, model: model || "cursor/auto", ts: Date.now() } });

    const child = spawn(cursorSpec.bin, spawnArgs, {
      cwd: projectDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let lineBuffer = "";
    let accumulatedText = "";
    let lastCursorAssistantNorm = "";
    let receivedStreamDeltas = false;
    let resultReceived = false;
    let resultChatId = null;
    let stderrAccum = "";

    // Activity-based watchdog: extend deadline as long as output is flowing.
    // Kills only when idle for CREWSWARM_ENGINE_IDLE_TIMEOUT_MS or absolute ceiling hit.
    let lastActivity = Date.now();
    const startTime = Date.now();
    const watchdog = setInterval(() => {
      if (resultReceived) { clearInterval(watchdog); return; }
      const idle = Date.now() - lastActivity;
      const total = Date.now() - startTime;
      if (idle > CREWSWARM_ENGINE_IDLE_TIMEOUT_MS) {
        clearInterval(watchdog);
        child.kill("SIGKILL");
        if (!resultReceived) reject(new Error(`CursorCLI idle timeout: no output for ${Math.round(idle / 1000)}s`));
      } else if (total > CREWSWARM_ENGINE_MAX_TOTAL_MS) {
        clearInterval(watchdog);
        child.kill("SIGKILL");
        if (!resultReceived) reject(new Error(`CursorCLI absolute max time exceeded: ${Math.round(total / 1000)}s`));
      } else {
        console.error(`[CursorCLI:${agentId}] Still working — idle=${Math.round(idle / 1000)}s, total=${Math.round(total / 1000)}s`);
      }
    }, 30_000);

    function handleLine(line) {
      line = line.trim();
      if (!line) return;
      try {
        const ev = JSON.parse(line);
        // Match dashboard engine-passthrough: Cursor can emit errors as JSON on stdout
        if (ev.type === "error") {
          const msg =
            ev.message ||
            ev.error ||
            (typeof ev.text === "string" ? ev.text : "") ||
            "";
          if (String(msg).trim()) {
            accumulatedText += `\n[Cursor error] ${String(msg).trim()}\n`;
          }
          return;
        }
        // Stream-json text deltas (newer Cursor agent CLI) — gateway previously only read `assistant`
        if (
          ev.type === "stream_event" &&
          ev.event?.type === "content_block_delta"
        ) {
          const t = ev.event.delta?.text || "";
          if (t) {
            receivedStreamDeltas = true;
            accumulatedText += t;
          }
          return;
        }
        if (ev.type === "assistant") {
          const content = ev.message?.content;
          let piece = "";
          if (Array.isArray(content)) {
            for (const c of content) {
              if (c.type === "text" && c.text) piece += c.text;
            }
          } else if (typeof content === "string") {
            piece = content;
          }
          const norm = piece.replace(/\r/g, "").trim();
          if (norm && norm === lastCursorAssistantNorm) {
            /* duplicate assistant NDJSON line from Cursor */
          } else if (piece) {
            if (norm) lastCursorAssistantNorm = norm;
            if (!receivedStreamDeltas) accumulatedText += piece;
          }
        }
        if (ev.type === "result" && !resultReceived) {
          resultReceived = true;
          resultChatId = ev.chatId || null;
          clearInterval(watchdog);
          child.kill("SIGTERM");
          if (ev.is_error === true) {
            const errText =
              (typeof ev.result === "string" && ev.result) ||
              ev.error ||
              ev.message ||
              "Cursor reported result error";
            reject(new Error(String(errText).trim() || "Cursor result error"));
            return;
          }
          if (!accumulatedText.trim() && typeof ev.result === "string" && ev.result.trim()) {
            accumulatedText = ev.result;
          }
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
      } catch {
        /* non-JSON line — ignore (Cursor may print rare plain text) */
      }
    }

    child.stdout.on("data", (d) => {
      lastActivity = Date.now();
      lineBuffer += d.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop();
      lines.forEach(handleLine);
    });
    child.stderr.on("data", (d) => {
      lastActivity = Date.now();
      const raw = d.toString();
      const s = raw.trim();
      if (s && !s.startsWith("\x1b")) console.error(`[CursorCLI:${agentId}] stderr: ${s.slice(0, 200)}`);
      if (stderrAccum.length < 8000) stderrAccum += raw;
    });

    child.on("error", (err) => {
      clearInterval(watchdog);
      if (!resultReceived) reject(err);
    });

    child.on("close", (code) => {
      clearInterval(watchdog);
      if (lineBuffer.trim()) handleLine(lineBuffer);
      if (!resultReceived) {
        if (accumulatedText.trim()) {
          console.warn(
            `[CursorCLI:${agentId}] No stream-json result event; accepting ${accumulatedText.length} chars of accumulated output (exit ${code})`,
          );
          resultReceived = true;
          _rtClientForApprovals?.publish({ channel: "events", type: "agent_idle", to: "broadcast",
            payload: { agent: agentId, ts: Date.now() } });
          resolve(accumulatedText.trim());
          return;
        }
        const tail = stderrAccum.replace(/\u001b\[[\d;?]*[ -/]*[@-~]/g, "").trim();
        const hint =
          existingChatId
            ? ` Stale Cursor session resume (chat ${existingChatId.slice(0, 8)}…)? Delete ${path.join(CURSOR_SESSION_DIR, `${agentId}.cursor-session`)} and retry.`
            : "";
        reject(
          new Error(
            `CursorCLI exited without a result event (code ${code}).${hint}` +
              (tail ? ` stderr: ${tail.slice(0, 1200)}` : " No stderr captured — check \`agent -p\` in the project directory or CURSOR_CLI_BIN."),
          ),
        );
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
    const taskBody = String(prompt ?? "").trim();
    if (!taskBody) {
      reject(
        new Error(
          "Codex: task text is empty — the gateway sent no instructions. Check dispatch/pipeline payload.",
        ),
      );
      return;
    }

    const configuredDir = _getOpencodeProjectDir();
    let projectDir = payload?.projectDir || configuredDir || process.cwd();
    projectDir = String(projectDir).replace(/[.,;!?]+$/, "");
    const expandedDir = normalizeProjectDir(projectDir) || projectDir;
    if (expandedDir && fs.existsSync(expandedDir)) {
      projectDir = expandedDir;
    } else if (!fs.existsSync(projectDir)) {
      console.error(
        `[Codex:${agentId}] projectDir not found (${projectDir}), using process.cwd()`,
      );
      projectDir = process.cwd();
    }

    const agentPrefix = agentId ? `[${agentId}]` : "";
    const titledPrompt = agentPrefix ? `${agentPrefix} ${String(prompt)}` : String(prompt);

    // Match crew-lead engine passthrough (http-server codex path): allow cwd outside a trusted git root.
    const agentCfg = _getAgentOpenCodeConfig(agentId);
    const codexModel = resolveCodexCliModel(payload, agentCfg);
    const args = [
      "-a",
      "never",
      "exec",
      "--sandbox",
      "danger-full-access",
      "--skip-git-repo-check",
      "--json",
    ];
    if (codexModel) args.push("--model", codexModel);
    args.push(titledPrompt);

    console.error(`[Codex:${agentId}] Running: ${CODEX_CLI_BIN} exec --json (cwd=${projectDir})`);

    _rtClientForApprovals?.publish({ channel: "events", type: "agent_working", to: "broadcast",
      payload: { agent: agentId, model: codexModel || "codex/auto", ts: Date.now() } });

    const child = spawn(CODEX_CLI_BIN, args, {
      cwd: projectDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let lineBuffer = "";
    let accumulatedText = "";
    /** Non-JSON lines (stderr, errors, usage) — previously swallowed by catch {} */
    let orphanStream = "";
    const appendOrphan = (line) => {
      const s = String(line).trim();
      if (!s) return;
      const chunk = (orphanStream ? "\n" : "") + s;
      orphanStream = (orphanStream + chunk).slice(-8000);
    };
    /** Codex emits {type:"error"} / {type:"turn.failed"} on stdout — capture for reject() */
    let lastCodexError = null;
    let resolved = false;

    // Activity-based watchdog: kill only if idle for too long OR absolute max exceeded
    let lastActivity = Date.now();
    const startTime = Date.now();
    const watchdog = setInterval(() => {
      if (resolved) { clearInterval(watchdog); return; }
      const idle = Date.now() - lastActivity;
      const total = Date.now() - startTime;
      if (idle > CREWSWARM_ENGINE_IDLE_TIMEOUT_MS) {
        clearInterval(watchdog);
        child.kill("SIGKILL");
        if (!resolved) reject(new Error(`Codex idle timeout: no output for ${Math.round(idle / 1000)}s`));
      } else if (total > CREWSWARM_ENGINE_MAX_TOTAL_MS) {
        clearInterval(watchdog);
        child.kill("SIGKILL");
        if (!resolved) reject(new Error(`Codex absolute max time exceeded: ${Math.round(total / 1000)}s`));
      } else {
        console.error(`[Codex:${agentId}] Still working — idle=${Math.round(idle / 1000)}s, total=${Math.round(total / 1000)}s`);
      }
    }, 30_000);

    function handleLine(line) {
      line = line.trim();
      if (!line) return;
      try {
        const ev = JSON.parse(line);
        if (ev.type === "error" && ev.message) {
          lastCodexError = String(ev.message).trim();
          return;
        }
        if (ev.type === "turn.failed") {
          const msg =
            (ev.error && String(ev.error.message || "").trim()) ||
            String(ev.message || "").trim();
          if (msg) lastCodexError = msg;
          return;
        }
        if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item?.text) {
          accumulatedText += ev.item.text;
        } else         if (ev.type === "turn.completed") {
          clearInterval(watchdog);
          resolved = true;
          child.kill("SIGTERM");
          resolve(accumulatedText.trim() || "(no output from Codex)");
        }
      } catch {
        appendOrphan(line);
      }
    }

    function onData(chunk) {
      lastActivity = Date.now(); // Reset activity timer on ANY output
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || "";
      for (const line of lines) handleLine(line);
    }

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("close", (code, signal) => {
      clearInterval(watchdog);
      if (lineBuffer.trim()) handleLine(lineBuffer);
      if (!resolved) {
        resolved = true;
        if (accumulatedText.trim()) resolve(accumulatedText.trim());
        else if (lastCodexError)
          reject(new Error(lastCodexError));
        else {
          const tail = orphanStream.trim();
          const hint = tail
            ? `\n\n--- Codex raw stream (non-JSON / stderr) ---\n${tail}`
            : "";
          const meta = `\n(cwd=${projectDir}, bin=${CODEX_CLI_BIN}, code=${code}${
            signal ? `, signal=${signal}` : ""
          })`;
          console.error(
            `[Codex:${agentId}] exit ${code}${signal ? ` (${signal})` : ""} no JSON result${hint ? ` — ${tail.slice(0, 500)}` : ""}${meta}`,
          );
          reject(
            new Error(
              `Codex exited with code ${code} and no JSON result.${hint}${meta}`,
            ),
          );
        }
      }
    });

    child.on("error", (e) => {
      clearInterval(watchdog);
      if (!resolved) {
        resolved = true;
        reject(
          new Error(
            `${e?.message || e} (cwd=${projectDir}, bin=${CODEX_CLI_BIN})`,
          ),
        );
      }
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
      "--bare",
      "--dangerously-skip-permissions",
      "--output-format", "stream-json",
      "--verbose",
    ];

    const agentCfg = _getAgentOpenCodeConfig(agentId);
    const model = payload?.claudeCodeModel || agentCfg.claudeCodeModel || process.env.CREWSWARM_CLAUDE_CODE_MODEL || null;
    if (model && !model.includes("/")) {
      args.push("--model", model);
    }

    // Only resume session if explicitly requested (e.g. conversational follow-up).
    // Pipeline/dispatch tasks should start fresh to avoid prior context poisoning simple tasks.
    const shouldResume = payload?.resumeSession === true;
    if (shouldResume) {
      const existingSession = readClaudeSessionId(agentId);
      if (existingSession) {
        args.push("--resume", existingSession);
        console.error(`[ClaudeCode:${agentId}] Resuming session ${existingSession}`);
      }
    }
    
    // CRITICAL: Claude Code expects the prompt as a command-line argument, NOT via stdin
    args.push(titledPrompt);

    if (!which(CLAUDE_CODE_BIN)) {
      throw new Error(`Claude Code CLI not found: "${CLAUDE_CODE_BIN}". Install with: npm i -g @anthropic-ai/claude-code`);
    }

    console.error(`[ClaudeCode:${agentId}] Running: ${CLAUDE_CODE_BIN} -p --dangerously-skip-permissions (cwd=${projectDir})`);

    _rtClientForApprovals?.publish({ channel: "events", type: "agent_working", to: "broadcast",
      payload: { agent: agentId, model: model || "claude/auto", ts: Date.now() } });

    const child = spawn(CLAUDE_CODE_BIN, args, {
      cwd: projectDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],  // Changed from "pipe" to "ignore" for stdin since we use args
    });

    let lineBuffer = "";
    let accumulatedText = "";
    let stderrText = "";
    let resultReceived = false;
    let resultSessionId = null;

    // Activity-based watchdog — same logic as Cursor CLI runner.
    let lastActivity = Date.now();
    const startTime = Date.now();
    const watchdog = setInterval(() => {
      if (resultReceived) { clearInterval(watchdog); return; }
      const idle = Date.now() - lastActivity;
      const total = Date.now() - startTime;
      if (idle > CREWSWARM_ENGINE_IDLE_TIMEOUT_MS) {
        clearInterval(watchdog);
        child.kill("SIGKILL");
        if (!resultReceived) {
          const hint = stderrText.trim() ? ` stderr: ${stderrText.slice(-300)}` : "";
          reject(new Error(`ClaudeCode idle timeout: no output for ${Math.round(idle / 1000)}s.${hint}`));
        }
      } else if (total > CREWSWARM_ENGINE_MAX_TOTAL_MS) {
        clearInterval(watchdog);
        child.kill("SIGKILL");
        if (!resultReceived) {
          const hint = stderrText.trim() ? ` stderr: ${stderrText.slice(-300)}` : "";
          reject(new Error(`ClaudeCode absolute max time exceeded: ${Math.round(total / 1000)}s.${hint}`));
        }
      } else {
        console.error(`[ClaudeCode:${agentId}] Still working — idle=${Math.round(idle / 1000)}s, total=${Math.round(total / 1000)}s`);
      }
    }, 30_000);

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
          clearInterval(watchdog);
          child.kill("SIGTERM");
          
          // Try to extract meaningful output
          let out = (ev.result || accumulatedText).trim();
          
          // If no text output, check for file operations in the event metadata
          if (!out && ev.filesModified && ev.filesModified.length > 0) {
            out = `Modified ${ev.filesModified.length} file(s): ${ev.filesModified.slice(0, 3).join(", ")}${ev.filesModified.length > 3 ? "..." : ""}`;
          } else if (!out && ev.operations && ev.operations.length > 0) {
            const opSummary = ev.operations.map(op => `${op.type}: ${op.path || op.file || "file"}`).slice(0, 3).join("; ");
            out = `Completed ${ev.operations.length} operation(s): ${opSummary}${ev.operations.length > 3 ? "..." : ""}`;
          } else if (!out) {
            // Check if projectDir exists and was modified (fallback file check)
            try {
              const { execSync } = require("node:child_process");
              const since = Math.floor(Date.now() / 1000) - 60; // Last 60 seconds
              const changedFiles = execSync(`find "${projectDir}" -type f -newermt "@${since}" 2>/dev/null | head -5`, 
                { encoding: "utf8", timeout: 2000 }).trim().split("\n").filter(Boolean);
              if (changedFiles.length > 0) {
                const fileNames = changedFiles.map(f => f.split("/").pop()).slice(0, 3);
                out = `Task completed. Modified: ${fileNames.join(", ")}${changedFiles.length > 3 ? "..." : ""}`;
              } else {
                out = "(claude code completed with no text output)";
              }
            } catch {
              out = "(claude code completed with no text output)";
            }
          }
          
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
      lastActivity = Date.now();
      lineBuffer += d.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop();
      lines.forEach(handleLine);
    });
    child.stderr.on("data", (d) => {
      lastActivity = Date.now();
      const s = d.toString().trim();
      stderrText += s + "\n";
      if (s && !s.startsWith("\x1b")) console.error(`[ClaudeCode:${agentId}] stderr: ${s.slice(0, 160)}`);
    });
    child.on("error", (err) => {
      clearInterval(watchdog);
      if (!resultReceived) reject(err);
    });
    child.on("close", (exitCode) => {
      clearInterval(watchdog);
      if (!resultReceived) {
        const hint = stderrText.trim() ? `\nstderr: ${stderrText.slice(-500)}` : "";
        reject(new Error(`ClaudeCode exited (code ${exitCode}) without result event. Output: ${accumulatedText.slice(0, 300)}${hint}`));
      }
    });
  });
}
