#!/usr/bin/env node
/**
 * crewswarm Dashboard with Build UI (RT Messages, Send, DLQ, Build).
 * Run from crewswarm repo so the Build button is included.
 *
 *   node scripts/dashboard.mjs
 *   → http://127.0.0.1:4319
 *
 * Override port: SWARM_DASH_PORT=4320 node scripts/dashboard.mjs
 *
 * Single instance: enforced by binding listenPort (see server.on("error") EADDRINUSE).
 * Do not use pgrep here — it false-positives (matches unrelated PIDs / races with `&`).
 */

import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import {
  BUILT_IN_RT_AGENTS,
  normalizeRtAgentId,
} from "../lib/agent-registry.mjs";
import { acquireStartupLock } from "../lib/runtime/startup-guard.mjs";
import {
  buildToolInstructions,
  hasEngineConfigured,
  getToolPermissions,
} from "../lib/agents/tool-instructions.mjs";
import {
  StartBuildSchema,
  EnhancePromptSchema,
  StartPMLoopSchema,
  ServiceActionSchema,
  ImportSkillSchema,
  AgentConfigCreateSchema,
  AgentConfigDeleteSchema,
  AgentResetSessionSchema,
  ProviderAddSchema,
  ProviderSaveSchema,
  ProviderTestSchema,
  ProviderBuiltinTestSchema,
  ContinuousBuildSchema,
  ReplayDLQSchema,
  DeleteProjectSchema,
  UpdateProjectSchema,
  RoadmapWriteSchema,
  RoadmapRetryFailedSchema,
  ContactDeleteSchema,
  ContactSendSchema,
  validate,
} from "./dashboard-validation.mjs";
import { execCrewLeadTools } from "../lib/crew-lead/tools.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CREWSWARM_DIR =
  process.env.CREWSWARM_DIR || path.resolve(__dirname, "..");
// Config dir: ~/.crewswarm is canonical
const CFG_DIR =
  process.env.CREWSWARM_CONFIG_DIR || path.join(os.homedir(), ".crewswarm");
// Config filename within CFG_DIR
const CFG_FILE = path.join(CFG_DIR, "crewswarm.json");
const UI_STATE_FILE = path.join(CFG_DIR, "ui-state.json");
const PREFERRED_NODE_BIN = (() => {
  const candidates = [
    process.env.NODE,
    "/usr/local/opt/node/bin/node",
    "/opt/homebrew/opt/node/bin/node",
    "/usr/local/bin/node",
    "/opt/homebrew/bin/node",
    process.execPath,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { }
  }
  return process.execPath;
})();

function readUiState() {
  try {
    return JSON.parse(fs.readFileSync(UI_STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeUiState(nextState = {}) {
  fs.mkdirSync(CFG_DIR, { recursive: true });
  fs.writeFileSync(UI_STATE_FILE, JSON.stringify(nextState, null, 2));
}
// Load crewswarm.json env block into process.env on startup (so dashboard reads them)
// Credentials are excluded — only operational config vars are applied this way.
const ENV_CREDENTIAL_KEYS = new Set([
  "CREWSWARM_RT_AUTH_TOKEN",
  "CREWSWARM_RT_URL",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_TARGET_AGENT",
  "WA_TARGET_AGENT",
  "CREWSWARM_TOKEN",
]);
try {
  const _startupCfg = JSON.parse(fs.readFileSync(CFG_FILE, "utf8"));
  for (const [k, v] of Object.entries(_startupCfg.env || {})) {
    if (!ENV_CREDENTIAL_KEYS.has(k) && v && !process.env[k]) {
      process.env[k] = String(v);
    }
  }
} catch { }

// Default 4319 so we don't conflict with crewswarm RT Messages dashboard on 4318
const listenPort = Number(process.env.SWARM_DASH_PORT || 4319);
const listenHost = process.env.CREWSWARM_BIND_HOST || "127.0.0.1";

// ── Startup Guard: Ensure only one dashboard instance ────────────────────────
const lockResult = acquireStartupLock("crewswarm-dashboard", {
  port: listenPort,
  killStale: true,
});
if (!lockResult.ok) {
  console.error(`[dashboard] ${lockResult.message}`);
  process.exit(1);
}

const opencodeBase = process.env.OPENCODE_URL || "http://127.0.0.1:4096";

function resolveCommandPath(bin, extraPaths = []) {
  const candidate = String(bin || "").trim();
  if (!candidate) return null;
  const checks = [];
  if (candidate.includes("/")) {
    checks.push(candidate);
  } else {
    checks.push(
      ...extraPaths,
      path.join("/usr/local/bin", candidate),
      path.join("/opt/homebrew/bin", candidate),
      path.join(os.homedir(), ".local", "bin", candidate),
      path.join(os.homedir(), "bin", candidate),
    );
  }
  for (const item of checks) {
    try {
      if (item && fs.existsSync(item)) return item;
    } catch {}
  }
  try {
    const out = execSync(`command -v "${candidate.replace(/"/g, '\\"')}"`, {
      stdio: ["ignore", "pipe", "ignore"],
      shell: "/bin/zsh",
      env: {
        ...process.env,
        PATH: [
          process.env.PATH || "",
          "/usr/local/bin",
          "/opt/homebrew/bin",
          path.join(os.homedir(), ".local", "bin"),
          path.join(os.homedir(), "bin"),
        ].filter(Boolean).join(":"),
      },
    }).toString("utf8").trim();
    return out || null;
  } catch {
    return null;
  }
}

function commandExists(bin, extraPaths = []) {
  return !!resolveCommandPath(bin, extraPaths);
}

function readSwarmConfigSafe() {
  try {
    return JSON.parse(fs.readFileSync(CFG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function getEngineRuntimeStatuses() {
  const swarmCfg = readSwarmConfigSafe();
  const cfgEnv = swarmCfg?.env || {};
  const codexInstalled = commandExists(process.env.CODEX_CLI_BIN || "codex");
  const claudeInstalled = commandExists(process.env.CLAUDE_CODE_BIN || "claude");
  const cursorInstalled =
    commandExists(
      process.env.CURSOR_CLI_BIN || path.join(os.homedir(), ".local", "bin", "agent"),
      [path.join(os.homedir(), ".local", "bin", "agent")],
    ) || commandExists("agent", [path.join(os.homedir(), ".local", "bin", "agent")]);
  const geminiInstalled = commandExists(process.env.GEMINI_CLI_BIN || "gemini");
  const crewCliInstalled =
    commandExists("crew", [path.join(CREWSWARM_DIR, "crew-cli", "dist", "index.js")]) ||
    fs.existsSync(path.join(CREWSWARM_DIR, "crew-cli", "dist", "index.js"));
  const opencodeInstalled =
    commandExists(process.env.CREWSWARM_OPENCODE_BIN || "opencode") ||
    fs.existsSync(path.join(os.homedir(), ".opencode", "bin", "opencode"));
  const opencodeRunning =
    (() => {
      try {
        return !!execSync(`lsof -ti :4096`, { stdio: ["ignore", "pipe", "ignore"] }).toString("utf8").trim();
      } catch {
        return false;
      }
    })();
  return [
    {
      id: "opencode",
      label: "OpenCode",
      kind: "daemon",
      installed: opencodeInstalled,
      enabled:
        cfgEnv.CREWSWARM_OPENCODE_ENABLED === "on" ||
        cfgEnv.CREWSWARM_OPENCODE_ENABLED === "1" ||
        process.env.CREWSWARM_OPENCODE_ENABLED === "on" ||
        process.env.CREWSWARM_OPENCODE_ENABLED === "1",
      running: opencodeRunning,
      optionalDaemon: true,
      port: 4096,
    },
    {
      id: "codex",
      label: "Codex CLI",
      kind: "spawned",
      installed: codexInstalled,
      enabled: swarmCfg.codex === true || process.env.CREWSWARM_CODEX === "1",
      running: codexInstalled,
    },
    {
      id: "claude",
      label: "Claude Code",
      kind: "spawned",
      installed: claudeInstalled,
      enabled: swarmCfg.claudeCode === true,
      running: claudeInstalled,
    },
    {
      id: "cursor",
      label: "Cursor CLI",
      kind: "spawned",
      installed: cursorInstalled,
      enabled: swarmCfg.cursorWaves === true,
      running: cursorInstalled,
    },
    {
      id: "gemini",
      label: "Gemini CLI",
      kind: "spawned",
      installed: geminiInstalled,
      enabled:
        swarmCfg.geminiCli === true ||
        process.env.CREWSWARM_GEMINI_CLI_ENABLED === "1",
      running: geminiInstalled,
    },
    {
      id: "crew-cli",
      label: "crew-cli",
      kind: "spawned",
      installed: crewCliInstalled,
      enabled:
        swarmCfg.crewCli === true ||
        process.env.CREWSWARM_CREW_CLI_ENABLED === "1",
      running: crewCliInstalled,
    },
  ];
}
const phasedOrchestrator = path.join(CREWSWARM_DIR, "phased-orchestrator.mjs");
const continuousBuild = path.join(CREWSWARM_DIR, "continuous-build.mjs");
const pmLoop = path.join(CREWSWARM_DIR, "pm-loop.mjs");
const pmStopFile = path.join(CFG_DIR, "pm-loop.stop");
const pmLogFile = path.join(CFG_DIR, "pm-loop.jsonl");
const roadmapFile = path.join(CREWSWARM_DIR, "website", "ROADMAP.md");
const workflowsDir = path.join(CFG_DIR, "pipelines");
const workflowLogsDir = path.join(CFG_DIR, "logs", "workflows");
const user = process.env.OPENCODE_SERVER_USERNAME || "opencode";
const pass =
  process.env.OPENCODE_SERVER_PASSWORD ||
  process.env.SWARM_PASSWORD ||
  "opencode";

/**
 * RT bearer token for crew-lead HTTP API — must match what crew-lead loads
 * (~/.crewswarm/crewswarm.json, then ~/.crewswarm/config.json).
 */
function readRtAuthTokenFromUserConfig() {
  const home = os.homedir();
  for (const name of ["crewswarm.json", "config.json"]) {
    try {
      const p = path.join(home, ".crewswarm", name);
      const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
      const t = (cfg?.rt?.authToken || "").trim();
      if (t) return t;
    } catch {
      /* try next */
    }
  }
  return "";
}

function resolveCrewLeadAuthToken() {
  const e = (process.env.CREWSWARM_RT_AUTH_TOKEN || "").trim();
  if (e) return e;
  return readRtAuthTokenFromUserConfig();
}

// ── Safe config writer: centralised EPERM / uchg handling ───────────────────
// Returns null on success, or { status, message } on error.
async function safeWriteConfig(cfg, indent = 4) {
  try {
    await fs.promises.writeFile(
      CFG_FILE,
      JSON.stringify(cfg, null, indent),
      "utf8",
    );
    return null;
  } catch (err) {
    if (err.code === "EPERM") {
      return {
        status: 403,
        message:
          "Config file is locked. Unlock it in Settings → Config Lock before making changes.",
      };
    }
    return { status: 500, message: err.message };
  }
}

// ── crewswarm tool definitions (server-side, also injected into client) ────
const CREWSWARM_TOOLS = [
  { id: "write_file", desc: "Write files to disk (@@WRITE_FILE)" },
  { id: "read_file", desc: "Read files from disk (@@READ_FILE)" },
  { id: "mkdir", desc: "Create directories (@@MKDIR)" },
  { id: "run_cmd", desc: "Run whitelisted shell commands (@@RUN_CMD)" },
  { id: "git", desc: "Git & GitHub CLI operations" },
  { id: "web_search", desc: "Web search (Brave Search — @@WEB_SEARCH)" },
  { id: "web_fetch", desc: "Fetch URLs (@@WEB_FETCH)" },
  { id: "dispatch", desc: "Dispatch tasks to other agents" },
  { id: "telegram", desc: "Send Telegram messages (@@TELEGRAM)" },
];

const ctlPath = (() => {
  const homeBin = path.join(os.homedir(), "bin", "openswitchctl");
  if (fs.existsSync(homeBin)) return homeBin;
  return path.join(CREWSWARM_DIR, "scripts", "openswitchctl");
})();
// Match RT daemon paths so RT Messages tab shows same events (daemon uses SHARED_MEMORY_DIR or ~/.openclaw/workspace/...)
const memoryBase =
  process.env.SHARED_MEMORY_DIR ||
  path.join(CFG_DIR, "workspace", "shared-memory");
const rtEventsLog = path.join(
  memoryBase,
  "claw-swarm",
  "opencrew-rt",
  "events.jsonl",
);
const rtDoneLog = path.join(
  memoryBase,
  "claw-swarm",
  "opencrew-rt",
  "channels",
  "done.jsonl",
);
const rtCommandLog = path.join(
  memoryBase,
  "claw-swarm",
  "opencrew-rt",
  "channels",
  "command.jsonl",
);
const dlqDir = path.join(memoryBase, "claw-swarm", "opencrew-rt", "dlq");
const phasedDispatchLog = path.join(CFG_DIR, "phased-dispatch.jsonl");

const authHeader = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

// ── Agent heartbeat liveness tracker ─────────────────────────────────────────
// Updated every 30s from events.jsonl — reflects actual bridge pulse, not just config.
const agentHeartbeats = new Map(); // agentId → lastSeenMs

function refreshHeartbeats() {
  try {
    if (!fs.existsSync(rtEventsLog)) return;
    const stat = fs.statSync(rtEventsLog);
    const readBytes = Math.max(0, stat.size - 65536); // read last ~64 KB
    const fd = fs.openSync(rtEventsLog, "r");
    const buf = Buffer.alloc(stat.size - readBytes);
    fs.readSync(fd, buf, 0, buf.length, readBytes);
    fs.closeSync(fd);
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.includes("agent.heartbeat")) continue;
      try {
        const obj = JSON.parse(line);
        const envelope = obj?.envelope || obj;  // Support both wrapped and unwrapped format
        const agentId =
          envelope?.payload?.agent || envelope?.from || envelope?.sender_agent_id;
        const ts = envelope?.ts ? new Date(envelope.ts).getTime() : null;
        if (
          agentId &&
          ts &&
          (!agentHeartbeats.has(agentId) || agentHeartbeats.get(agentId) < ts)
        ) {
          agentHeartbeats.set(agentId, ts);
        }
      } catch { }
    }
  } catch { }
}

// Prime the map immediately, then refresh every 30s
refreshHeartbeats();
setInterval(refreshHeartbeats, 30000);

const workflowRuntime = {
  runs: new Map(), // workflowName -> run state
  enabled: true,
  tickMs: 30000,
};

function ensureWorkflowDirs() {
  try {
    fs.mkdirSync(workflowsDir, { recursive: true });
  } catch { }
  try {
    fs.mkdirSync(workflowLogsDir, { recursive: true });
  } catch { }
}

function isValidWorkflowName(name) {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(String(name || ""));
}

function getWorkflowFile(name) {
  return path.join(workflowsDir, `${name}.json`);
}

function parseCronField(field, min, max, current, isDow = false) {
  const part = String(field || "").trim();
  if (!part) return false;
  if (part === "*") return true;

  const chunks = part
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!chunks.length) return false;

  const normalizeDow = (v) => {
    if (!isDow) return v;
    // Cron accepts 0 or 7 as Sunday.
    if (v === 7) return 0;
    return v;
  };

  const inRange = (v) => v >= min && v <= max;

  for (const chunk of chunks) {
    let base = chunk;
    let step = 1;
    if (chunk.includes("/")) {
      const seg = chunk.split("/");
      if (seg.length !== 2) return false;
      base = seg[0];
      step = Number(seg[1]);
      if (!Number.isInteger(step) || step <= 0) return false;
    }

    if (base === "*") {
      if ((current - min) % step === 0) return true;
      continue;
    }

    if (base.includes("-")) {
      const [startRaw, endRaw] = base.split("-");
      let start = Number(startRaw);
      let end = Number(endRaw);
      if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
      start = normalizeDow(start);
      end = normalizeDow(end);
      if (!inRange(start) || !inRange(end) || start > end) return false;
      if (current >= start && current <= end && (current - start) % step === 0)
        return true;
      continue;
    }

    let exact = Number(base);
    if (!Number.isInteger(exact)) return false;
    exact = normalizeDow(exact);
    if (!inRange(exact)) return false;
    if (step !== 1) {
      if (current >= exact && (current - exact) % step === 0) return true;
    } else if (current === exact) {
      return true;
    }
  }
  return false;
}

function cronMatches(expr, date = new Date()) {
  const parts = String(expr || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length !== 5) return false;
  const [min, hour, dom, month, dow] = parts;
  const minute = date.getMinutes();
  const hr = date.getHours();
  const dayOfMonth = date.getDate();
  const mon = date.getMonth() + 1;
  const dayOfWeek = date.getDay();

  const minOk = parseCronField(min, 0, 59, minute);
  const hourOk = parseCronField(hour, 0, 23, hr);
  const monthOk = parseCronField(month, 1, 12, mon);
  const domOk = parseCronField(dom, 1, 31, dayOfMonth);
  const dowOk = parseCronField(dow, 0, 6, dayOfWeek, true);
  if (!minOk || !hourOk || !monthOk) return false;

  const domAny = dom.trim() === "*";
  const dowAny = dow.trim() === "*";
  const dayOk =
    domAny && dowAny ? true : domAny ? dowOk : dowAny ? domOk : domOk || dowOk;
  return dayOk;
}

function isCronExpressionValid(expr) {
  const parts = String(expr || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length !== 5) return false;

  const validators = [
    () => parseCronField(parts[0], 0, 59, 0),
    () => parseCronField(parts[1], 0, 23, 0),
    () => parseCronField(parts[2], 1, 31, 1),
    () => parseCronField(parts[3], 1, 12, 1),
    () => parseCronField(parts[4], 0, 6, 0, true),
  ];

  return validators.every((fn) => {
    try {
      fn();
      return true;
    } catch {
      return false;
    }
  });
}

function getMinuteKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function readWorkflowByName(name) {
  if (!isValidWorkflowName(name)) throw new Error("Invalid workflow name");
  ensureWorkflowDirs();
  const fp = getWorkflowFile(name);
  if (!fs.existsSync(fp)) throw new Error("Workflow not found");
  const raw = await fs.promises.readFile(fp, "utf8");
  const json = JSON.parse(raw || "{}");
  const st = await fs.promises.stat(fp).catch(() => null);
  return {
    name,
    filePath: fp,
    mtime: st?.mtime?.toISOString() || null,
    workflow: json,
  };
}

async function listWorkflows() {
  ensureWorkflowDirs();
  const names = (await fs.promises.readdir(workflowsDir).catch(() => []))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .filter(isValidWorkflowName)
    .sort();
  const out = [];
  for (const name of names) {
    try {
      const item = await readWorkflowByName(name);
      const wf = item.workflow || {};
      const run = workflowRuntime.runs.get(name) || {};
      out.push({
        name,
        description: wf.description || "",
        enabled: !!wf.enabled,
        schedule: String(wf.schedule || "").trim(),
        timezone:
          wf.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
        stageCount: Array.isArray(wf.stages) ? wf.stages.length : 0,
        stepCount: Array.isArray(wf.steps) ? wf.steps.length : 0,
        updatedAt: wf.updatedAt || item.mtime,
        runState: run,
      });
    } catch { }
  }
  return out;
}

function appendWorkflowLog(name, message) {
  ensureWorkflowDirs();
  const line = `[${new Date().toISOString()}] ${message}\n`;
  const fp = path.join(workflowLogsDir, `${name}.log`);
  try {
    fs.appendFileSync(fp, line, "utf8");
  } catch { }
  return fp;
}

async function startWorkflowRun(name, trigger = "manual") {
  if (!isValidWorkflowName(name)) {
    return { ok: false, error: "Invalid workflow name" };
  }
  let item;
  try {
    item = await readWorkflowByName(name);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const wf = item.workflow || {};
  const hasStages = Array.isArray(wf.stages) && wf.stages.length > 0;
  const hasSteps = Array.isArray(wf.steps) && wf.steps.length > 0;
  if (!hasStages && !hasSteps) {
    return { ok: false, error: 'Workflow must include "stages" or "steps"' };
  }

  const prev = workflowRuntime.runs.get(name) || {};
  if (prev.running) {
    return {
      ok: false,
      alreadyRunning: true,
      error: "Workflow is already running",
      runState: prev,
    };
  }

  const { spawn } = await import("node:child_process");
  const scriptPath = path.join(
    CREWSWARM_DIR,
    "scripts",
    "run-scheduled-pipeline.mjs",
  );
  const proc = spawn("node", [scriptPath, name], {
    cwd: CREWSWARM_DIR,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const startedAt = new Date().toISOString();
  const next = {
    running: true,
    pid: proc.pid || null,
    trigger,
    lastStartedAt: startedAt,
    lastFinishedAt: null,
    lastExitCode: null,
    lastError: null,
    lastScheduledMinute: prev.lastScheduledMinute || null,
  };
  workflowRuntime.runs.set(name, next);
  const logPath = appendWorkflowLog(
    name,
    `RUN START trigger=${trigger} pid=${proc.pid || "n/a"}`,
  );

  const onData = (stream, type) => {
    if (!stream) return;
    stream.on("data", (chunk) => {
      const text = String(chunk || "").trimEnd();
      if (!text) return;
      appendWorkflowLog(name, `${type}: ${text}`);
    });
  };
  onData(proc.stdout, "OUT");
  onData(proc.stderr, "ERR");

  proc.on("error", (err) => {
    const cur = workflowRuntime.runs.get(name) || {};
    workflowRuntime.runs.set(name, {
      ...cur,
      running: false,
      lastFinishedAt: new Date().toISOString(),
      lastExitCode: -1,
      lastError: err?.message || "spawn error",
    });
    appendWorkflowLog(name, `RUN ERROR ${err?.message || "spawn error"}`);
  });
  proc.on("close", (code, signal) => {
    const cur = workflowRuntime.runs.get(name) || {};
    const err =
      code === 0 ? null : `exit=${code}${signal ? ` signal=${signal}` : ""}`;
    workflowRuntime.runs.set(name, {
      ...cur,
      running: false,
      lastFinishedAt: new Date().toISOString(),
      lastExitCode: code,
      lastError: err,
    });
    appendWorkflowLog(
      name,
      `RUN END exit=${code}${signal ? ` signal=${signal}` : ""}`,
    );
  });

  return {
    ok: true,
    started: true,
    pid: proc.pid || null,
    logPath,
    runState: next,
  };
}

async function tickWorkflowScheduler() {
  if (!workflowRuntime.enabled) return;
  const now = new Date();
  const minuteKey = getMinuteKey(now);
  const items = await listWorkflows();
  for (const item of items) {
    const wfName = item.name;
    const schedule = String(item.schedule || "").trim();
    if (!item.enabled || !schedule) continue;
    if (!cronMatches(schedule, now)) continue;
    const prev = workflowRuntime.runs.get(wfName) || {};
    if (prev.lastScheduledMinute === minuteKey) continue;
    workflowRuntime.runs.set(wfName, {
      ...prev,
      lastScheduledMinute: minuteKey,
    });
    const run = await startWorkflowRun(wfName, "schedule");
    if (!run.ok && !run.alreadyRunning) {
      appendWorkflowLog(
        wfName,
        `SCHEDULE FAIL ${run.error || "unknown error"}`,
      );
    }
  }
}

ensureWorkflowDirs();
setInterval(() => {
  tickWorkflowScheduler().catch(() => { });
}, workflowRuntime.tickMs);
setTimeout(() => {
  tickWorkflowScheduler().catch(() => { });
}, 4000);

async function proxyJSON(pathname) {
  try {
    const res = await fetch(`${opencodeBase}${pathname}`, {
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const text = await res.text();
    if (text.trim().startsWith("<!doctype") || text.trim().startsWith("<html"))
      return [];
    return JSON.parse(text);
  } catch (err) {
    if (
      err.name === "TimeoutError" ||
      err.code === "ECONNREFUSED" ||
      err instanceof SyntaxError
    )
      return [];
    throw err;
  }
}

async function sendCrewMessage(to, message) {
  const { execSync } = await import("node:child_process");
  return execSync(
    `"${ctlPath}" send "${to}" "${message.replace(/"/g, '\\"')}"`,
    {
      encoding: "utf8",
      timeout: 10000,
    },
  );
}

async function getAgentList() {
  const merged = new Set();

  // 1. Live RT bus agents (currently connected)
  try {
    const { execSync } = await import("node:child_process");
    const result = execSync(`"${ctlPath}" agents`, {
      encoding: "utf8",
      timeout: 5000,
    });
    result
      .trim()
      .split("\n")
      .filter(Boolean)
      .forEach((a) => {
        const rtName = normalizeRtAgentId(a);
        if (rtName) merged.add(rtName);
      });
  } catch { }

  // 2. All agents defined in crewswarm.json / openclaw.json (online or not) — shown with [offline] indicator handled client-side
  try {
    const cfgPath = CFG_FILE;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const raw = Array.isArray(cfg.agents)
      ? cfg.agents
      : Array.isArray(cfg.agents?.list)
        ? cfg.agents.list
        : [];
    raw.forEach((a) => {
      const rtName = normalizeRtAgentId(a.id);
      if (rtName) merged.add(rtName);
    });
  } catch { }

  // 3. Hard fallback if both fail
  if (!merged.size) {
    BUILT_IN_RT_AGENTS.forEach((a) => merged.add(a));
  }

  // Annotate each agent with last heartbeat time for liveness display
  const now = Date.now();
  return [...merged].map((id) => {
    const lastSeen = agentHeartbeats.get(id) || null;
    const ageSec = lastSeen ? Math.floor((now - lastSeen) / 1000) : null;
    // online < 90s | stale 90-300s | offline > 300s | unknown = never seen
    const liveness =
      ageSec === null
        ? "unknown"
        : ageSec < 90
          ? "online"
          : ageSec < 300
            ? "stale"
            : "offline";
    return { id, lastSeen, ageSec, liveness };
  });
}

async function getRecentRTMessages(limit = 100) {
  const { readFile, stat } = await import("node:fs/promises");
  const SKIP_TYPES = new Set([
    "agent.heartbeat",
    "agent.online",
    "agent.offline",
  ]);
  const MAX_REPLY_CHARS = 3000; // truncate large replies so JSON stays small

  async function readJsonlTail(filePath, n) {
    try {
      const content = await readFile(filePath, "utf8");
      const lines = content.trim().split("\n").filter(Boolean);
      const out = [];
      for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
        try {
          out.push(JSON.parse(lines[i]));
        } catch { }
      }
      return out.reverse();
    } catch {
      return [];
    }
  }

  // Merge: done.jsonl (task completions) + events.jsonl (commands/lifecycle)
  const [doneRaw, eventsRaw] = await Promise.all([
    readJsonlTail(rtDoneLog, limit),
    readJsonlTail(rtEventsLog, limit),
  ]);

  const msgs = [];
  for (const obj of [...eventsRaw, ...doneRaw]) {
    const env = obj.envelope || obj;
    if (SKIP_TYPES.has(env.type)) continue;
    // Truncate large reply payloads so the browser doesn't choke
    if (env.payload?.reply?.length > MAX_REPLY_CHARS) {
      env.payload = {
        ...env.payload,
        reply: env.payload.reply.slice(0, MAX_REPLY_CHARS) + "\n…[truncated]",
      };
    }
    msgs.push(env);
  }

  // Sort by ts, deduplicate by id and by content fingerprint (catches same message in both logs)
  msgs.sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));
  const seen = new Set();
  const deduped = msgs.filter((m) => {
    // Primary key: explicit id or ts+from
    const idKey = m.id || m.ts + m.from;
    if (seen.has(idKey)) return false;
    seen.add(idKey);
    // Secondary key: content fingerprint — same reply/prompt from same sender within 5s
    const payload = m.payload || {};
    const text = (
      payload.reply ||
      payload.prompt ||
      payload.message ||
      payload.content ||
      ""
    ).slice(0, 120);
    if (text.length > 30) {
      const contentKey = (m.from || "") + "|" + text;
      if (seen.has(contentKey)) return false;
      seen.add(contentKey);
    }
    return true;
  });
  return deduped.slice(-limit);
}

async function getDLQEntries() {
  try {
    const { listDLQEntries } = await import("../lib/runtime/dlq.mjs");
    const entries = listDLQEntries();
    // Add filename for compatibility with existing dashboard UI
    return entries.map((entry) => ({
      ...entry,
      filename: `${entry.taskId}.json`,
    }));
  } catch (err) {
    console.error("[dashboard] Failed to list DLQ entries:", err.message);
    // Fallback to manual file reading if module import fails
    const { readdir, readFile } = await import("node:fs/promises");
    try {
      const files = await readdir(dlqDir);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));
      const entries = [];
      for (const file of jsonFiles) {
        try {
          const content = await readFile(path.join(dlqDir, file), "utf8");
          entries.push({ ...JSON.parse(content), filename: file });
        } catch { }
      }
      return entries.sort((a, b) =>
        (b.failedAt || "").localeCompare(a.failedAt || ""),
      );
    } catch {
      return [];
    }
  }
}

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";

async function enhancePromptWithGroq(userText) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY not set");
  const systemPrompt = `You help turn rough ideas into a single clear build requirement for a phased orchestrator (MVP → Phase 1 → Phase 2).
Output ONLY the improved requirement: one or two sentences, concrete and actionable. No preamble or explanation.
Examples:
- "website for our product" → "Build a marketing website for the product in website/ with hero, feature list, and contact CTA."
- "fix the bug" → "Fix the login validation bug in the auth flow and add a unit test for it."
Keep the same intent; make it specific enough for a PM to break into small tasks.`;

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText },
      ],
      temperature: 0.3,
      max_tokens: 256,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("Empty response from Groq");
  return content;
}

function getRtAuthToken() {
  try {
    return readSwarmConfigSafe()?.rt?.authToken || "";
  } catch {
    return "";
  }
}

function resolvePlannerEngine(preferredEngine = null, preferredModel = null) {
  if (preferredEngine) {
    return {
      engine: preferredEngine,
      model: preferredModel || null,
      permissionMode: null,
      sandbox: preferredEngine === "codex" ? "read-only" : null,
      source: "request",
    };
  }

  const cfg = readSwarmConfigSafe();
  const agents = Array.isArray(cfg?.agents) ? cfg.agents : [];
  const pm = agents.find((agent) => agent?.id === "crew-pm") || {};

  if (pm.useClaudeCode) {
    return {
      engine: "claude",
      model: pm.claudeCodeModel || null,
      // Claude's plan mode can exit 0 with no streamed text for this planner path.
      // Use the normal direct lane here; the build-planner prompt already forbids edits.
      permissionMode: null,
      sandbox: null,
      source: "crew-pm",
    };
  }
  if (pm.useCodex) {
    return {
      engine: "codex",
      model: pm.codexModel || null,
      permissionMode: null,
      sandbox: "read-only",
      source: "crew-pm",
    };
  }
  if (pm.useCursorCli) {
    return {
      engine: "cursor",
      model: pm.cursorCliModel || null,
      permissionMode: null,
      sandbox: null,
      source: "crew-pm",
    };
  }
  if (pm.useGeminiCli) {
    return {
      engine: "gemini",
      model: pm.geminiCliModel || null,
      permissionMode: null,
      sandbox: null,
      source: "crew-pm",
    };
  }
  if (pm.useCrewCLI) {
    return {
      engine: "crew-cli",
      model: pm.crewCliModel || null,
      permissionMode: null,
      sandbox: null,
      source: "crew-pm",
    };
  }
  if (pm.useOpenCode) {
    return {
      engine: "opencode",
      model: pm.opencodeModel || null,
      permissionMode: null,
      sandbox: null,
      source: "crew-pm",
    };
  }

  const fallbacks = [
    commandExists(process.env.CLAUDE_CODE_BIN || "claude") && { engine: "claude", model: process.env.CREWSWARM_CLAUDE_CODE_MODEL || null, permissionMode: null, sandbox: null, source: "fallback" },
    commandExists(process.env.CODEX_CLI_BIN || "codex") && { engine: "codex", model: process.env.CREWSWARM_CODEX_MODEL || null, permissionMode: null, sandbox: "read-only", source: "fallback" },
    commandExists(process.env.CURSOR_CLI_BIN || path.join(os.homedir(), ".local", "bin", "agent"), [path.join(os.homedir(), ".local", "bin", "agent")]) && { engine: "cursor", model: process.env.CREWSWARM_CURSOR_MODEL || process.env.CURSOR_DEFAULT_MODEL || null, permissionMode: null, sandbox: null, source: "fallback" },
    commandExists(process.env.GEMINI_CLI_BIN || "gemini") && { engine: "gemini", model: process.env.CREWSWARM_GEMINI_CLI_MODEL || null, permissionMode: null, sandbox: null, source: "fallback" },
    commandExists(process.env.CREWSWARM_OPENCODE_BIN || "opencode") && { engine: "opencode", model: process.env.CREWSWARM_OPENCODE_MODEL || null, permissionMode: null, sandbox: null, source: "fallback" },
  ].filter(Boolean);

  return fallbacks[0] || null;
}

function buildRequirementPlanningPrompt(userText, projectDir = null) {
  return [
    "You are the planning stage for CrewSwarm's Build tab.",
    "Transform the user's rough build idea into a concrete build brief that crew-pm can execute.",
    "If repository context is relevant, inspect the workspace before answering. Do not edit files.",
    "",
    "Output format:",
    "## Build Brief",
    "A 1-2 paragraph concrete requirement with explicit scope and deliverables.",
    "",
    "## Acceptance Criteria",
    "- 3 to 7 flat bullets",
    "",
    "## Constraints / Assumptions",
    "- Flat bullets only when needed",
    "",
    "Rules:",
    "- Preserve the user's intent; do not invent a different product.",
    "- Make it specific enough for PM decomposition and agent dispatch.",
    "- Mention likely subsystems or files only if you have evidence from the repo.",
    "- Keep it concise and actionable.",
    "- Do not include implementation code, shell commands, or extra commentary.",
    projectDir ? `- Current project directory: ${projectDir}` : "",
    "",
    "User idea:",
    userText.trim(),
  ].filter(Boolean).join("\n");
}

async function collectClaudePlannerTextDirect({ message, projectDir, model = null }) {
  const claudeBin = resolveCommandPath(process.env.CLAUDE_CODE_BIN || "claude", [
    path.join(os.homedir(), ".local", "bin", "claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ]) || (process.env.CLAUDE_CODE_BIN || "claude");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const args = ["-p"];
  if (projectDir) args.push("--add-dir", projectDir);
  if (model) args.push("--model", model);
  // Match the fixed engine-passthrough Claude invocation:
  // skip user MCP startup and terminate option parsing before the prompt.
  args.push(
    "--strict-mcp-config",
    "--mcp-config",
    path.join(os.homedir(), ".crewswarm", "config", "empty-mcp.json"),
    "--",
    message,
  );
  const { stdout, stderr } = await execFileAsync(claudeBin, args, {
    cwd: projectDir || process.cwd(),
    env: process.env,
    timeout: Number(process.env.CREWSWARM_PLANNER_TIMEOUT_MS || 300000),
    maxBuffer: 2 * 1024 * 1024,
  });
  const trimmed = String(stdout || "").trim();
  if (trimmed) return trimmed;
  const stderrText = String(stderr || "").trim();
  if (stderrText) throw new Error(stderrText);
  throw new Error("planner produced no output");
}

async function collectPassthroughText({
  engine,
  message,
  projectDir,
  model = null,
  permissionMode = null,
  sandbox = null,
  forceL2 = false,
}) {
  if (engine === "claude") {
    return collectClaudePlannerTextDirect({ message, projectDir, model });
  }
  const token = getRtAuthToken();
  const crewLeadPort = process.env.CREW_LEAD_PORT || "5010";
  let upstream;
  try {
    upstream = await fetch(`http://127.0.0.1:${crewLeadPort}/api/engine-passthrough`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "x-passthrough-continue": "false",
      },
      body: JSON.stringify({
        engine,
        message,
        projectDir: projectDir || process.cwd(),
        sessionId: "build-planner",
        ...(model ? { model } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(sandbox ? { sandbox } : {}),
        ...(forceL2 ? { forceL2: true } : {}),
      }),
      signal: AbortSignal.timeout(300_000),
    });
  } catch (fetchErr) {
    throw new Error(`planner fetch failed for ${engine}: ${fetchErr.message}`);
  }

  if (!upstream.ok) {
    throw new Error(`planner upstream ${upstream.status}`);
  }

  let rawSSE;
  try {
    rawSSE = await upstream.text();
  } catch (readErr) {
    throw new Error(`planner SSE read failed for ${engine}: ${readErr.message}`);
  }
  let text = "";
  let stderr = "";
  let exitCode = 0;

  for (const line of rawSSE.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const ev = JSON.parse(line.slice(6));
      if (ev.type === "chunk" && ev.text) text += ev.text;
      else if (ev.type === "stderr" && ev.text) stderr += ev.text;
      else if (ev.type === "done") exitCode = ev.exitCode ?? 0;
    } catch {}
  }

  const trimmed = text.trim();
  if (!trimmed && stderr.trim()) {
    throw new Error(stderr.trim());
  }
  if (!trimmed) {
    throw new Error(`planner produced no output${exitCode ? ` (exit ${exitCode})` : ""}`);
  }
  return trimmed;
}

async function getPhasedProgress(limit = 80) {
  const { readFile } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  if (!existsSync(phasedDispatchLog)) return [];
  try {
    const content = await readFile(phasedDispatchLog, "utf8");
    const lines = content.trim().split("\n").filter(Boolean).slice(-limit);
    return lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ── DASHBOARD UI ──────────────────────────────────────────────────────────────
// The dashboard UI lives in apps/dashboard/src/app.js + apps/dashboard/index.html (Vite).
// Build: cd apps/dashboard && npm run build  →  outputs to apps/dashboard/dist/
// This server serves apps/dashboard/dist/ as the live dashboard.
//
// DO NOT ADD UI CODE HERE. Edit apps/dashboard/src/app.js and apps/dashboard/index.html.
// The `html` variable below is a last-resort fallback only shown when
// apps/dashboard/dist/ has not been built yet.
const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>crewswarm</title></head>
<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a12;color:#e5e7eb;">
<div style="text-align:center;max-width:480px;padding:40px;">
  <div style="font-size:48px;margin-bottom:16px;">🚧</div>
  <h2 style="margin:0 0 12px;font-size:22px;">Frontend not built</h2>
  <p style="color:#9ca3af;margin:0 0 24px;line-height:1.6;">
    The dashboard UI hasn't been compiled yet. Run the build command and restart the server.
  </p>
  <code style="display:block;background:#1a1a2e;border:1px solid #333;border-radius:8px;padding:16px;font-size:13px;text-align:left;color:#a3e635;">
    cd apps/dashboard &amp;&amp; npm run build
  </code>
</div>
</body>
</html>`;

// ── Static frontend (Vite dist) ───────────────────────────────────────────────
const FRONTEND_DIST = path.resolve(__dirname, "../apps/dashboard/dist");
const FRONTEND_SRC = path.resolve(__dirname, "../apps/dashboard");
const STATIC_MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

const COMPRESSIBLE_EXTENSIONS = new Set([
  ".html",
  ".js",
  ".css",
  ".json",
  ".svg",
  ".txt",
  ".xml",
]);

function shouldUseImmutableCache(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.includes("/assets/");
}

function getStaticCacheControl(filePath) {
  if (shouldUseImmutableCache(filePath)) {
    return "public, max-age=31536000, immutable";
  }
  return "no-cache";
}

function ensureCompressedVariant(filePath, encoding) {
  const ext = path.extname(filePath).toLowerCase();
  if (!COMPRESSIBLE_EXTENSIONS.has(ext)) {
    return null;
  }

  const compressedPath = `${filePath}.${encoding === "br" ? "br" : "gz"}`;

  try {
    const sourceStat = fs.statSync(filePath);
    const compressedStat = fs.existsSync(compressedPath)
      ? fs.statSync(compressedPath)
      : null;

    if (compressedStat && compressedStat.mtimeMs >= sourceStat.mtimeMs) {
      return compressedPath;
    }

    const source = fs.readFileSync(filePath);
    const compressed = encoding === "br"
      ? zlib.brotliCompressSync(source)
      : zlib.gzipSync(source);
    fs.writeFileSync(compressedPath, compressed);
    return compressedPath;
  } catch {
    return null;
  }
}

function getServedStaticAsset(filePath, acceptEncoding = "") {
  const normalized = String(acceptEncoding || "").toLowerCase();

  if (normalized.includes("br")) {
    const brotliPath = ensureCompressedVariant(filePath, "br");
    if (brotliPath) {
      return { filePath: brotliPath, encoding: "br" };
    }
  }

  if (normalized.includes("gzip")) {
    const gzipPath = ensureCompressedVariant(filePath, "gzip");
    if (gzipPath) {
      return { filePath: gzipPath, encoding: "gzip" };
    }
  }

  return { filePath, encoding: null };
}

function serveStatic(req, res, filePath) {
  try {
    const { filePath: servedPath, encoding } = getServedStaticAsset(
      filePath,
      req?.headers?.["accept-encoding"] || "",
    );
    const data = fs.readFileSync(servedPath);
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      "content-type": STATIC_MIME[ext] || "application/octet-stream",
      "cache-control": getStaticCacheControl(filePath),
      vary: "Accept-Encoding",
    };
    if (encoding) {
      headers["content-encoding"] = encoding;
    }
    res.writeHead(200, headers);
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${listenPort}`);

  // CORS: echo local dev Origins so http://localhost:3333 (Vibe) works with http://127.0.0.1:4319
  // (browsers treat hostnames as distinct origins). Non-local callers still get *.
  const _corsOrigin = String(req.headers.origin || "");
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(_corsOrigin)) {
    res.setHeader("Access-Control-Allow-Origin", _corsOrigin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

  // Handle preflight requests
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // Serve frontend static assets (Vite dist in prod, src in dev fallback)
    if (
      !url.pathname.startsWith("/api/") &&
      !url.pathname.startsWith("/events")
    ) {
      const distFile = path.join(
        FRONTEND_DIST,
        url.pathname === "/" ? "index.html" : url.pathname,
      );
      if (serveStatic(req, res, distFile)) return;
      // Dev fallback: serve from apps/dashboard/src or apps/dashboard/index.html directly
      if (url.pathname === "/") {
        const devIndex = path.join(FRONTEND_SRC, "index.html");
        if (serveStatic(req, res, devIndex)) return;
      }
      const srcFile = path.join(FRONTEND_SRC, url.pathname);
      if (serveStatic(req, res, srcFile)) return;
    }
    if (url.pathname === "/") {
      // Final fallback — serve legacy inline HTML if frontend not built yet
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store, no-cache, must-revalidate",
        pragma: "no-cache",
      });
      res.end(html);
      return;
    }
    if (url.pathname === "/crew-chat.html") {
      const chatFile = path.join(CREWSWARM_DIR, "crew-chat.html");
      try {
        const chatHtml = fs.readFileSync(chatFile, "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(chatHtml);
      } catch {
        res.writeHead(404);
        res.end("Not found");
      }
      return;
    }
    if (url.pathname === "/signup" || url.pathname === "/signup.html") {
      const signupFile = path.join(FRONTEND_SRC, "public", "signup.html");
      try {
        const signupHtml = fs.readFileSync(signupFile, "utf8");
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store, no-cache, must-revalidate",
        });
        res.end(signupHtml);
      } catch (e) {
        console.error("[dashboard] Signup page not found:", signupFile);
        res.writeHead(404);
        res.end("Signup page not found");
      }
      return;
    }
    // ── First-run detection ──────────────────────────────────────────────────
    if (url.pathname === "/api/first-run-status" && req.method === "GET") {
      const cfg = readSwarmConfigSafe();
      const providers = cfg.providers || {};
      const envBlock = cfg.env || {};
      const configuredProviders = [];

      // Check providers object for keys with length > 8
      for (const [id, prov] of Object.entries(providers)) {
        if (prov?.apiKey && String(prov.apiKey).length > 8) {
          configuredProviders.push(id);
        }
      }
      // Also check env block for *_API_KEY entries
      for (const [k, v] of Object.entries(envBlock)) {
        if (k.endsWith("_API_KEY") && v && String(v).length > 8) {
          const pid = k.replace(/_API_KEY$/, "").toLowerCase();
          if (!configuredProviders.includes(pid)) configuredProviders.push(pid);
        }
      }

      const hasApiKeys = configuredProviders.length > 0;

      // Check crew-lead health
      let crewLeadUp = false;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        const resp = await fetch("http://127.0.0.1:5010/health", {
          signal: controller.signal,
        });
        clearTimeout(timer);
        crewLeadUp = resp.ok;
      } catch {
        crewLeadUp = false;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          firstRun: !hasApiKeys,
          checks: {
            hasApiKeys,
            servicesUp: crewLeadUp,
            crewLeadUp,
          },
          configuredProviders,
        }),
      );
      return;
    }

    // /api/health handled by crew-lead proxy below (line ~8423)
    if (url.pathname === "/api/sessions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(await proxyJSON("/session")));
      return;
    }
    if (url.pathname === "/api/messages") {
      const sid = url.searchParams.get("session");
      if (!sid) throw new Error("missing session");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          await proxyJSON(`/session/${encodeURIComponent(sid)}/message`),
        ),
      );
      return;
    }

    if (url.pathname === "/api/engine-runtimes" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, engines: getEngineRuntimeStatuses() }));
      return;
    }

    // ── Multi-CLI Session APIs ─────────────────────────────────────────────────

    if (url.pathname === "/api/engine-sessions" && req.method === "GET") {
      const engine = String(url.searchParams.get("engine") || "opencode").trim();
      const limit = Math.min(Number(url.searchParams.get("limit") || "20"), 50);
      const projectId = String(url.searchParams.get("projectId") || "").trim();
      const projectDir = (() => {
        if (!projectId || projectId === "general") return "";
        try {
          const registryFile = path.join(CFG_DIR, "projects.json");
          const projects = JSON.parse(fs.readFileSync(registryFile, "utf8"));
          return String(projects?.[projectId]?.outputDir || "").trim();
        } catch {
          return "";
        }
      })();
      const endpointMap = {
        opencode: "/api/sessions",
        codex: "/api/codex-sessions",
        claude: "/api/claude-sessions",
        gemini: "/api/gemini-sessions",
        "crew-cli": "/api/crew-cli-sessions",
      };
      const endpoint = endpointMap[engine] || endpointMap.opencode;
      const qs = new URLSearchParams();
      if (limit) qs.set("limit", String(limit));
      if (engine === "claude" && projectDir) qs.set("dir", projectDir);
      const target =
        endpoint + (qs.toString() ? `?${qs.toString()}` : "");
      let payload = {};
      try {
        if (endpoint === "/api/sessions") payload = await proxyJSON("/session");
        else {
          const upstream = await fetch(
            `http://127.0.0.1:${listenPort}${target}`,
            { signal: AbortSignal.timeout(8000) },
          );
          payload = await upstream.json();
        }
      } catch (error) {
        payload = { ok: false, sessions: [], error: error.message };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: payload?.ok !== false,
          engine,
          projectId: projectId || null,
          sessions: payload?.sessions || payload || [],
          error: payload?.error,
        }),
      );
      return;
    }

    if (url.pathname === "/api/codex-sessions") {
      const limit = Math.min(Number(url.searchParams.get("limit") || "20"), 50);
      const sessionsBase = path.join(os.homedir(), ".codex", "sessions");
      const sessions = [];
      if (fs.existsSync(sessionsBase)) {
        const years = fs.readdirSync(sessionsBase).filter(d => /^\d{4}$/.test(d));
        for (const year of years.sort().reverse()) {
          const yearDir = path.join(sessionsBase, year);
          const months = fs.readdirSync(yearDir).filter(d => /^\d{2}$/.test(d));
          for (const month of months.sort().reverse()) {
            const monthDir = path.join(yearDir, month);
            const days = fs.readdirSync(monthDir).filter(d => /^\d{2}$/.test(d));
            for (const day of days.sort().reverse()) {
              const dayDir = path.join(yearDir, month, day);
              const files = fs.readdirSync(dayDir)
                .filter(f => f.endsWith(".jsonl"))
                .map(f => ({ f, mt: fs.statSync(path.join(dayDir, f)).mtimeMs }))
                .sort((a, b) => b.mt - a.mt);
              for (const { f } of files) {
                if (sessions.length >= limit) break;
                const sessionId = f.replace(".jsonl", "");
                const filePath = path.join(dayDir, f);

                // Skip files larger than 10MB to avoid memory issues
                const stats = fs.statSync(filePath);
                if (stats.size > 10 * 1024 * 1024) {
                  sessions.push({
                    id: sessionId,
                    title: `${sessionId} (file too large)`,
                    file: path.join(year, month, day, f),
                    messages: [{ role: "system", text: `Session file is ${Math.round(stats.size / 1024 / 1024)}MB - too large to display. View in terminal.`, ts: stats.mtimeMs }],
                  });
                  continue;
                }

                const messages = [];
                const allLines = fs.readFileSync(filePath, "utf8").trim().split("\n");
                const lines = allLines.slice(-100); // Last 100 lines only
                let firstUserMsg = "";
                for (const line of lines) {
                  try {
                    const ev = JSON.parse(line);
                    if (ev.type === "item.completed" && ev.item) {
                      const role = ev.item.type === "agent_message" ? "assistant" : "user";
                      const text = ev.item.text || "";
                      if (role === "user" && !firstUserMsg) firstUserMsg = text.slice(0, 80);
                      if (text) messages.push({ role, text: text.slice(0, 2000), ts: ev.timestamp });
                    }
                  } catch { }
                }
                if (messages.length || firstUserMsg) {
                  sessions.push({
                    id: sessionId,
                    title: firstUserMsg || sessionId,
                    file: path.join(year, month, day, f),
                    messages: messages.slice(-40),
                  });
                }
              }
              if (sessions.length >= limit) break;
            }
            if (sessions.length >= limit) break;
          }
          if (sessions.length >= limit) break;
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, sessions }));
      return;
    }

    if (url.pathname === "/api/claude-sessions") {
      const limit = Math.min(Number(url.searchParams.get("limit") || "20"), 50);
      const qDir = url.searchParams.get("dir") || process.cwd();
      const dirKey = qDir.replace(/\//g, "-");
      const projectsBase = path.join(os.homedir(), ".claude", "projects");
      const candidates = fs.existsSync(projectsBase)
        ? fs.readdirSync(projectsBase).filter(d => d === dirKey || d.endsWith(dirKey.split("-").slice(-2).join("-")))
        : [];
      const sessions = [];
      for (const cand of candidates) {
        const sessDir = path.join(projectsBase, cand);
        const files = fs.readdirSync(sessDir)
          .filter(f => f.endsWith(".jsonl"))
          .map(f => ({ f, mt: fs.statSync(path.join(sessDir, f)).mtimeMs }))
          .sort((a, b) => b.mt - a.mt)
          .slice(0, limit)
          .map(x => x.f);
        for (const file of files) {
          const sessionId = file.replace(".jsonl", "");
          const messages = [];
          const lines = fs.readFileSync(path.join(sessDir, file), "utf8").trim().split("\n");
          for (const line of lines) {
            try {
              const d = JSON.parse(line);
              if (d.type !== "user" && d.type !== "assistant") continue;
              const content = d.message?.content;
              const text = Array.isArray(content)
                ? content.filter(c => c.type === "text").map(c => c.text).join("")
                : typeof content === "string" ? content : "";
              if (text) messages.push({ role: d.type, text: text.slice(0, 2000), ts: d.timestamp });
            } catch { }
          }
          if (messages.length) sessions.push({ sessionId, file, messages });
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, dir: qDir, sessions }));
      return;
    }

    if (url.pathname === "/api/gemini-sessions") {
      const limit = Math.min(Number(url.searchParams.get("limit") || "20"), 50);
      const historyBase = path.join(os.homedir(), ".gemini", "history");
      const sessions = [];
      if (fs.existsSync(historyBase)) {
        const projects = fs.readdirSync(historyBase);
        for (const proj of projects) {
          const sessionFile = path.join(historyBase, proj, "session.jsonl");
          if (fs.existsSync(sessionFile)) {
            const messages = [];
            const lines = fs.readFileSync(sessionFile, "utf8").trim().split("\n");
            let firstUserMsg = "";
            for (const line of lines) {
              try {
                const ev = JSON.parse(line);
                if (ev.type === "message") {
                  const role = ev.role || "user";
                  const text = ev.content || "";
                  if (role === "user" && !firstUserMsg) firstUserMsg = text.slice(0, 80);
                  if (text) messages.push({ role, text: text.slice(0, 2000), ts: ev.timestamp });
                }
              } catch { }
            }
            if (messages.length) {
              const stat = fs.statSync(sessionFile);
              sessions.push({
                id: proj,
                title: firstUserMsg || proj,
                file: sessionFile,
                messages,
                timeUpdated: stat.mtimeMs,
              });
            }
          }
        }
        sessions.sort((a, b) => (b.timeUpdated || 0) - (a.timeUpdated || 0));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, sessions: sessions.slice(0, limit) }));
      return;
    }

    if (url.pathname === "/api/crew-cli-sessions") {
      const limit = Math.min(Number(url.searchParams.get("limit") || "20"), 50);
      const sessionsBase = path.join(process.cwd(), ".crew", "sessions");
      const sessions = [];
      if (fs.existsSync(sessionsBase)) {
        const engines = fs.readdirSync(sessionsBase);
        for (const engine of engines) {
          const engineDir = path.join(sessionsBase, engine);
          const projects = fs.readdirSync(engineDir);
          for (const project of projects) {
            const projectSessionsDir = path.join(engineDir, project, "sessions");
            if (!fs.existsSync(projectSessionsDir)) continue;
            const years = fs.readdirSync(projectSessionsDir).filter(d => /^\d{4}$/.test(d));
            for (const year of years.sort().reverse()) {
              const yearDir = path.join(projectSessionsDir, year);
              const months = fs.readdirSync(yearDir).filter(d => /^\d{2}$/.test(d));
              for (const month of months.sort().reverse()) {
                const monthDir = path.join(yearDir, month);
                const days = fs.readdirSync(monthDir).filter(d => /^\d{2}$/.test(d));
                for (const day of days.sort().reverse()) {
                  const dayDir = path.join(yearDir, month, day);
                  const files = fs.readdirSync(dayDir)
                    .filter(f => f.endsWith(".jsonl"))
                    .map(f => ({ f, mt: fs.statSync(path.join(dayDir, f)).mtimeMs }))
                    .sort((a, b) => b.mt - a.mt);
                  for (const { f } of files) {
                    if (sessions.length >= limit) break;
                    const sessionId = f.replace(".jsonl", "");
                    const messages = [];
                    // Limit to last 100 lines to avoid huge session files
                    const allLines = fs.readFileSync(path.join(dayDir, f), "utf8").trim().split("\n");
                    const lines = allLines.slice(-100);
                    let firstUserMsg = "";
                    for (const line of lines) {
                      try {
                        const ev = JSON.parse(line);
                        if (ev.type === "item.completed" && ev.item) {
                          const role = ev.item.type === "agent_message" ? "assistant" : "user";
                          const text = ev.item.text || "";
                          if (role === "user" && !firstUserMsg) firstUserMsg = text.slice(0, 80);
                          if (text) messages.push({ role, text: text.slice(0, 2000), ts: ev.timestamp });
                        }
                      } catch { }
                    }
                    if (messages.length) {
                      sessions.push({
                        id: `${engine}/${project}/${sessionId}`,
                        title: firstUserMsg || sessionId,
                        engine,
                        project,
                        file: path.join(year, month, day, f),
                        messages: messages.slice(-40), // Keep last 40 messages only
                      });
                    }
                  }
                  if (sessions.length >= limit) break;
                }
                if (sessions.length >= limit) break;
              }
              if (sessions.length >= limit) break;
            }
          }
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, sessions }));
      return;
    }
    if (url.pathname === "/api/send" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON" }));
        return;
      }
      const { to, message } = parsed;
      if (!to || !message) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing to or message" }));
        return;
      }
      await sendCrewMessage(to, message);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/api/rt-messages") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(await getRecentRTMessages(100)));
      return;
    }

    // ── Passthrough sessions (Gemini CLI, Codex CLI session persistence) ──────
    if (url.pathname === "/api/passthrough-sessions") {
      if (req.method === "GET") {
        try {
          const sessionFile = path.join(
            os.homedir(),
            ".crewswarm",
            "passthrough-sessions.json",
          );
          let sessions = {};
          if (fs.existsSync(sessionFile)) {
            sessions = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ sessions }));
        } catch (e) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ sessions: {} }));
        }
        return;
      }
      if (req.method === "DELETE") {
        const key = url.searchParams.get("key");
        if (!key) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "key parameter required" }));
          return;
        }
        try {
          const sessionFile = path.join(
            os.homedir(),
            ".crewswarm",
            "passthrough-sessions.json",
          );
          let sessions = {};
          if (fs.existsSync(sessionFile)) {
            sessions = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
          }
          delete sessions[key];
          fs.writeFileSync(
            sessionFile,
            JSON.stringify(sessions, null, 2),
            "utf8",
          );
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }
    }

    // ── Token usage ──────────────────────────────────────────────────────────
    if (url.pathname === "/api/token-usage") {
      const usageFile = path.join(
        os.homedir(),
        ".crewswarm",
        "token-usage.json",
      );
      let usage = { calls: 0, prompt: 0, completion: 0, byModel: {} };
      try {
        usage = JSON.parse(fs.readFileSync(usageFile, "utf8"));
      } catch { }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(usage));
      return;
    }

    // ── Cmd allowlist (proxied to crew-lead) ─────────────────────────────────
    if (url.pathname === "/api/cmd-allowlist") {
      const CREW_LEAD = "http://127.0.0.1:5010";
      try {
        if (req.method === "GET") {
          const r = await fetch(`${CREW_LEAD}/allowlist-cmd`);
          const d = await r.json();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(d));
        } else if (req.method === "POST") {
          let body = "";
          for await (const c of req) body += c;
          const r = await fetch(`${CREW_LEAD}/allowlist-cmd`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          });
          const d = await r.json();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(d));
        } else if (req.method === "DELETE") {
          let body = "";
          for await (const c of req) body += c;
          const r = await fetch(`${CREW_LEAD}/allowlist-cmd`, {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body,
          });
          const d = await r.json();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(d));
        } else {
          res.writeHead(405);
          res.end();
        }
      } catch (e) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    if (url.pathname === "/api/cmd-approve" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const CREW_LEAD_PORT = process.env.CREW_LEAD_PORT || "5010";
      try {
        const r = await fetch(
          `http://127.0.0.1:${CREW_LEAD_PORT}/approve-cmd`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
            signal: AbortSignal.timeout(5000),
          },
        );
        const d = await r.json().catch(() => ({}));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(d));
      } catch (e) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (url.pathname === "/api/cmd-reject" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const CREW_LEAD_PORT = process.env.CREW_LEAD_PORT || "5010";
      try {
        const r = await fetch(`http://127.0.0.1:${CREW_LEAD_PORT}/reject-cmd`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(5000),
        });
        const d = await r.json().catch(() => ({}));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(d));
      } catch (e) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ── Telegram sessions (reads crew-lead chat-history for telegram-* sessions) ──
    if (url.pathname === "/api/telegram-sessions") {
      const histDir = path.join(os.homedir(), ".crewswarm", "chat-history");
      const sessions = [];
      try {
        const files = fs
          .readdirSync(histDir)
          .filter((f) => f.startsWith("telegram-") && f.endsWith(".jsonl"));
        for (const file of files) {
          const chatId = file.replace(/^telegram-/, "").replace(/\.jsonl$/, "");
          const lines = fs
            .readFileSync(path.join(histDir, file), "utf8")
            .split("\n")
            .filter(Boolean);
          const msgs = lines
            .map((l) => {
              try {
                return JSON.parse(l);
              } catch {
                return null;
              }
            })
            .filter(Boolean);
          const last = msgs[msgs.length - 1];
          sessions.push({
            chatId,
            messageCount: msgs.length,
            lastTs: last?.ts || null,
            messages: msgs.slice(-20),
          });
        }
      } catch { }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(sessions));
      return;
    }

    if (url.pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, uptime: Math.round(process.uptime()) }));
      return;
    }

    if (url.pathname === "/api/env" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          HOME: process.env.HOME || os.homedir(),
          cwd: process.cwd(),
          node: process.version,
          pid: process.pid,
          uptime: Math.round(process.uptime()),
          platform: process.platform,
        }),
      );
      return;
    }
    if (url.pathname === "/api/env-advanced" && req.method === "GET") {
      const vars = [
        // Engine — OpenCode
        "CREWSWARM_OPENCODE_ENABLED",
        "CREWSWARM_OPENCODE_MODEL",
        "CREWSWARM_OPENCODE_TIMEOUT_MS",
        "CREWSWARM_OPENCODE_AGENT",
        // Engine — Claude Code & Cursor
        "CREWSWARM_CLAUDE_CODE_MODEL",
        "CREWSWARM_CURSOR_MODEL",
        // Engine — Codex & crew-cli
        "CREWSWARM_CODEX_MODEL",
        "CREWSWARM_CREW_CLI_MODEL",
        // Engine — Gemini CLI
        "CREWSWARM_GEMINI_CLI_ENABLED",
        "CREWSWARM_GEMINI_CLI_MODEL",
        // Engine — Docker Sandbox
        "CREWSWARM_DOCKER_SANDBOX",
        "CREWSWARM_DOCKER_SANDBOX_NAME",
        "CREWSWARM_DOCKER_SANDBOX_INNER_ENGINE",
        "CREWSWARM_DOCKER_SANDBOX_TIMEOUT_MS",
        // Engine Loop & Dispatch
        "CREWSWARM_ENGINE_LOOP",
        "CREWSWARM_ENGINE_LOOP_MAX_ROUNDS",
        "CREWSWARM_ENGINE_IDLE_TIMEOUT_MS",
        "CREWSWARM_ENGINE_MAX_TOTAL_MS",
        "CREWSWARM_DISPATCH_TIMEOUT_MS",
        "CREWSWARM_DISPATCH_CLAIMED_TIMEOUT_MS",
        "CREWSWARM_RT_AGENT",
        // Ports
        "CREW_LEAD_PORT",
        "SWARM_DASH_PORT",
        "WA_HTTP_PORT",
        // Background Consciousness
        "CREWSWARM_BG_CONSCIOUSNESS",
        "CREWSWARM_BG_CONSCIOUSNESS_INTERVAL_MS",
        "CREWSWARM_BG_CONSCIOUSNESS_MODEL",
        // Messaging
        "TELEGRAM_ALLOWED_USERNAMES",
        "WA_ALLOWED_NUMBERS",
        // Memory
        "SHARED_MEMORY_NAMESPACE",
        "SHARED_MEMORY_DIR",
        // PM Loop
        "PM_MAX_ITEMS",
        "PM_MAX_CONCURRENT",
        "PM_USE_QA",
        "PM_USE_SECURITY",
        "PM_USE_SPECIALISTS",
        "PM_SELF_EXTEND",
        "PM_EXTEND_EVERY",
        "PM_CODER_AGENT",
        "PM_AGENT_IDLE_TIMEOUT_MS",
        "PHASED_TASK_TIMEOUT_MS",
      ];
      // Read from crewswarm.json env block first, fall back to process.env
      // Credential keys are never exposed here
      let cfgEnv = {};
      try {
        cfgEnv = JSON.parse(fs.readFileSync(CFG_FILE, "utf8")).env || {};
      } catch { }
      const result = {};
      for (const v of vars) {
        if (ENV_CREDENTIAL_KEYS.has(v)) continue;
        result[v] = cfgEnv[v] ?? process.env[v] ?? null;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ env: result }));
      return;
    }

    if (url.pathname === "/api/env-advanced" && req.method === "POST") {
      const body = await (async () => {
        let b = "";
        for await (const c of req) b += c;
        return b;
      })();
      let updates;
      try {
        updates = JSON.parse(body);
      } catch {
        updates = {};
      }
      const cfgPath = path.join(os.homedir(), ".crewswarm", "crewswarm.json");
      try {
        const raw = (() => {
          try {
            return fs.readFileSync(cfgPath, "utf8");
          } catch {
            return "{}";
          }
        })();
        const cfg = JSON.parse(raw);
        if (!cfg.env) cfg.env = {};
        for (const [k, v] of Object.entries(updates)) {
          if (v === null || v === "") {
            delete cfg.env[k];
            delete process.env[k];
          } else {
            cfg.env[k] = String(v);
            process.env[k] = String(v);
          }
        }
        const writeErr = await safeWriteConfig(cfg);
        if (writeErr) {
          res.writeHead(writeErr.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: writeErr.message }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ── Auth Token (for Vibe) ─────────────────────────────────────────────────────
    if (url.pathname === "/api/auth/token") {
      res.writeHead(200, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
      });
      const token = resolveCrewLeadAuthToken();
      res.end(JSON.stringify({ token }));
      return;
    }

    if (url.pathname === "/api/agents") {
      res.writeHead(200, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
      });
      res.end(JSON.stringify(await getAgentList()));
      return;
    }

    // ── Public Signup ─────────────────────────────────────────────────────────────
    if (url.pathname === "/api/signup" && req.method === "POST") {
      try {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw || "{}");

        // Sanitize and validate inputs (prevent injection attacks)
        const sanitize = (str, maxLen = 100) => {
          if (!str) return "";
          return String(str).trim().slice(0, maxLen).replace(/[<>]/g, "");
        };

        const name = sanitize(body.name, 100);
        const phone = sanitize(body.phone, 20);
        const email = sanitize(body.email, 100);
        const city = sanitize(body.city, 100);
        const state = sanitize(body.state, 100);
        const country = sanitize(body.country, 100);
        const preferences = body.preferences || {};

        // Validate required fields
        if (!name || name.length < 2) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ error: "Name is required (min 2 characters)" }),
          );
          return;
        }

        // Validate phone format (E.164: +[1-9][0-9]{1,14})
        const phoneRegex = /^\+[1-9]\d{1,14}$/;
        if (!phone || !phoneRegex.test(phone)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error:
                "Valid phone number with country code required (e.g., +1234567890)",
            }),
          );
          return;
        }

        // Validate email if provided
        if (email) {
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(email)) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid email address" }));
            return;
          }
        }

        // Sanitize preferences
        const cleanPrefs = {};
        const allowedPrefs = [
          "diet",
          "spiceLevel",
          "budget",
          "allergies",
          "favCuisines",
        ];
        for (const key of allowedPrefs) {
          if (preferences[key]) {
            if (Array.isArray(preferences[key])) {
              cleanPrefs[key] = preferences[key]
                .map((v) => sanitize(String(v), 50))
                .filter(Boolean);
            } else {
              cleanPrefs[key] = sanitize(String(preferences[key]), 50);
            }
          }
        }

        // Convert phone to WhatsApp JID format
        const jid = phone.replace(/[^\d]/g, "") + "@s.whatsapp.net";

        // Build location string from city, state, country
        let location = "";
        if (city && state && country) {
          location = `${city}, ${state}, ${country}`;
        } else if (city && country) {
          location = `${city}, ${country}`;
        } else if (city) {
          location = city;
        }

        // Store in contacts database
        const { trackContact, updateContact } =
          await import("../lib/contacts/index.mjs");
        trackContact(jid, "whatsapp", name, { phone, email });

        // Update with preferences, email, and location
        const updates = {};
        if (Object.keys(cleanPrefs).length > 0)
          updates.preferences = cleanPrefs;
        if (email) updates.email = email;
        if (location) updates.last_location = location;

        if (Object.keys(updates).length > 0) {
          updateContact(jid, updates);
        }

        console.log(`[dashboard] New signup: ${name} (${phone})`);

        // Return success with WhatsApp number
        const whatsappNumber =
          process.env.CREWSWARM_WHATSAPP_NUMBER || "+1234567890";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            message: "Account created successfully!",
            whatsappNumber,
          }),
        );
      } catch (e) {
        console.error("[dashboard] Signup error:", e);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: e.message || "Internal server error" }),
        );
      }
      return;
    }

    // ── Agent Direct Chat ────────────────────────────────────────────────────────
    if (url.pathname === "/api/agent-chat" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { agentId, message, sessionId, projectId } = JSON.parse(
        body || "{}",
      );

      if (!agentId || !message) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "agentId and message required" }));
        return;
      }

      try {
        // Load agent config
        const csSwarm = JSON.parse(fs.readFileSync(CFG_FILE, "utf8"));
        const agentCfg = csSwarm.agents?.find((a) => a.id === agentId);
        if (!agentCfg?.model) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: `Agent ${agentId} not found or no model configured`,
            }),
          );
          return;
        }

        // Parse model string
        const [providerKey, ...modelParts] = agentCfg.model.split("/");
        let modelId = modelParts.join("/");
        const provider = csSwarm.providers?.[providerKey];
        if (!provider?.apiKey) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ error: `No API key for provider ${providerKey}` }),
          );
          return;
        }
        // OpenRouter requires full ID (e.g. openrouter/hunter-alpha), not bare "hunter-alpha"
        if ((providerKey === "openrouter" || (provider.baseUrl || "").includes("openrouter.ai")) && modelId && !modelId.startsWith("openrouter/")) {
          modelId = "openrouter/" + modelId;
        }

        // Load system prompt
        const agentPromptsPath = path.join(CFG_DIR, "agent-prompts.json");
        let systemPrompt = `You are ${agentId}.`;
        try {
          const agentPrompts = JSON.parse(
            fs.readFileSync(agentPromptsPath, "utf8"),
          );
          const bareId = agentId.replace(/^crew-/, "");
          systemPrompt =
            agentPrompts[agentId] || agentPrompts[bareId] || systemPrompt;
        } catch { }

        // Build intelligent tool instructions
        const hasEngine = hasEngineConfigured(agentCfg);
        const permissions = getToolPermissions(agentId, agentCfg);
        const toolInstructions = buildToolInstructions({
          agentId,
          permissions,
          hasEngine,
          agentConfig: agentCfg, // Pass full config to enforce global engine settings
        });

        systemPrompt += toolInstructions;

        // Build messages (session history loaded separately via chat API)
        const messages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: message },
        ];

        // Call LLM (uses built-in fetch, available since Node 18)
        const baseUrl = provider.baseUrl || "https://api.openai.com/v1";
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${provider.apiKey}`,
          },
          body: JSON.stringify({
            model: modelId,
            messages,
            temperature: 0.7,
          }),
        });

        if (!response.ok) {
          const error = await response.text();
          res.writeHead(500, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ error: `LLM API error: ${error.slice(0, 200)}` }),
          );
          return;
        }

        const data = await response.json();
        let reply = data.choices?.[0]?.message?.content || "(no response)";

        // Execute direct tools (@@READ_FILE, @@WRITE_FILE, @@MKDIR) if present
        const toolResults = await execCrewLeadTools(reply);
        if (toolResults.length > 0) {
          // Call LLM again with tool results
          const toolResultText = toolResults.join("\n\n");

          const followUpMessages = [
            ...messages,
            { role: "assistant", content: reply },
            {
              role: "user",
              content: `[Tool execution results]\n\n${toolResultText}\n\nContinue your response based on these results.`,
            },
          ];

          const followUpRes = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${provider.apiKey}`,
            },
            body: JSON.stringify({
              model: modelId,
              messages: followUpMessages,
              temperature: 0.7,
            }),
          });

          if (followUpRes.ok) {
            const followUpData = await followUpRes.json();
            reply = followUpData.choices?.[0]?.message?.content || reply;
          }
        }

        // Check if agent wants to use @@CLI
        const cliMatch = reply.match(/@@CLI\s+(\w+)\s+(.+)/s);
        if (cliMatch) {
          const cli = cliMatch[1].toLowerCase();
          const task = cliMatch[2].trim();
          const preText = reply.slice(0, cliMatch.index).trim();
          const displayReply = preText || `⚡ Running ${cli}...`;
          if (projectId && projectId !== "general") {
            try {
              const { saveProjectMessage } =
                await import("../lib/chat/project-messages.mjs");
              saveProjectMessage(projectId, {
                source: "agent",
                role: "user",
                content: message,
                agent: null,
                metadata: { agentId },
              });
              saveProjectMessage(projectId, {
                source: "agent",
                role: "assistant",
                content: displayReply,
                agent: agentId,
                metadata: { model: agentCfg.model, cliInvoked: cli },
              });
            } catch (e) {
              console.warn("[dashboard] agent-chat @@CLI save:", e.message);
            }
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              reply: displayReply,
              cliInvoked: cli,
            }),
          );
          return;
        }

        if (projectId && projectId !== "general") {
          try {
            const { saveProjectMessage } =
              await import("../lib/chat/project-messages.mjs");
            saveProjectMessage(projectId, {
              source: "agent",
              role: "user",
              content: message,
              agent: null,
              metadata: { agentId },
            });
            saveProjectMessage(projectId, {
              source: "agent",
              role: "assistant",
              content: reply,
              agent: agentId,
              metadata: { model: agentCfg.model },
            });
          } catch (e) {
            console.warn("[dashboard] agent-chat save:", e.message);
          }
        }

        // Normal LLM response
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ reply }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ── CLI Processes Status ──────────────────────────────────────────────────────
    if (url.pathname === "/api/cli-processes" && req.method === "GET") {
      try {
        // Import process tracker (dynamic to avoid startup errors if file missing)
        const { getActiveProcesses, getAgentProcesses } =
          await import("../lib/cli-process-tracker.mjs");
        const agent = url.searchParams.get("agent");

        const processes = agent
          ? getAgentProcesses(agent)
          : getActiveProcesses();

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ processes }));
      } catch (err) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ processes: [], error: err.message }));
      }
      return;
    }

    // ── Agent Chat History ────────────────────────────────────────────────────────
    if (
      url.pathname.startsWith("/api/agent-chat-history/") &&
      req.method === "GET"
    ) {
      const agentId = url.pathname.split("/").pop();
      const historyPath = path.join(
        CFG_DIR,
        "agent-chat-history",
        `${agentId}.jsonl`,
      );

      try {
        if (!fs.existsSync(historyPath)) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ history: [] }));
          return;
        }

        const lines = fs
          .readFileSync(historyPath, "utf8")
          .split("\n")
          .filter(Boolean);
        const history = lines.map((line) => JSON.parse(line));

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ history: history.slice(-50) })); // Last 50 messages
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === "/api/dlq") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(await getDLQEntries()));
      return;
    }
    if (url.pathname === "/api/phased-progress") {
      const limit = Math.min(Number(url.searchParams.get("limit")) || 80, 200);
      const filterProject = url.searchParams.get("projectId") || null;
      let entries = await getPhasedProgress(200); // fetch more so filter has enough to work with
      if (filterProject) {
        entries = entries.filter((e) => e.projectId === filterProject);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(entries.slice(-limit)));
      return;
    }
    if (url.pathname === "/api/enhance-prompt" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body || "{}"); } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
        return;
      }
      const vr = validate(EnhancePromptSchema, parsed);
      if (!vr.ok) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: vr.error }));
        return;
      }
      const { text, projectId, engine: requestedEngine, model: requestedModel } = vr.data;
      try {
        // Default to cwd for planner context — engines need repo access to produce aware briefs.
        // Claude/Cursor/Codex use --add-dir for safe read access; crew-cli uses --project.
        // Fall back to temp dir only if no project context is available.
        let projectDir = process.cwd();
        if (projectId) {
          const regPath = path.join(CFG_DIR, "projects.json");
          if (fs.existsSync(regPath)) {
            const reg = JSON.parse(fs.readFileSync(regPath, "utf8") || "{}");
            const proj = reg[projectId];
            if (proj?.outputDir) projectDir = proj.outputDir;
          }
        }
        fs.mkdirSync(projectDir, { recursive: true });

        const planner = resolvePlannerEngine(requestedEngine, requestedModel);
        if (!planner) throw new Error("No planning engine is configured or installed");

        const planned = await collectPassthroughText({
          engine: planner.engine,
          message: buildRequirementPlanningPrompt(text, projectDir),
          projectDir,
          model: planner.model,
          permissionMode: planner.permissionMode,
          sandbox: planner.sandbox,
          forceL2: planner.engine === "crew-cli",
        });

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          enhanced: planned,
          engine: planner.engine,
          model: planner.model,
          mode: planner.permissionMode || planner.sandbox || "prompt",
          source: planner.source,
        }));
      } catch (err) {
        try {
          const enhanced = await enhancePromptWithGroq(text);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            enhanced,
            engine: "groq",
            model: "llama-3.3-70b-versatile",
            mode: "fallback-rewrite",
            source: "fallback",
            warning: err?.message || String(err),
          }));
        } catch (fallbackErr) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: fallbackErr?.message || err?.message || String(fallbackErr || err),
              enhanced: null,
            }),
          );
        }
      }
      return;
    }
    if (url.pathname === "/api/build" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body || "{}"); } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
        return;
      }
      const vr = validate(StartBuildSchema, parsed);
      if (!vr.ok) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: vr.error }));
        return;
      }
      const { requirement, projectId } = vr.data;
      // Resolve project output dir if projectId provided
      let projectEnv = {};
      if (projectId) {
        const { existsSync: ex } = await import("node:fs");
        const { readFile: rf } = await import("node:fs/promises");
        const regPath = path.join(
          CFG_DIR,
          "projects.json",
        );
        if (ex(regPath)) {
          const reg = JSON.parse(await rf(regPath, "utf8").catch(() => "{}"));
          const proj = reg[projectId];
          if (proj) {
            projectEnv = {
              CREWSWARM_OUTPUT_DIR: proj.outputDir,
              PM_ROADMAP_FILE: proj.roadmapFile,
              PM_PROJECT_ID: projectId,
              ...(proj.featuresDoc
                ? { PM_FEATURES_DOC: proj.featuresDoc }
                : {}),
            };
          }
        }
      }
      const { spawn } = await import("node:child_process");
      const { existsSync } = await import("node:fs");
      if (!existsSync(phasedOrchestrator))
        throw new Error(
          "phased-orchestrator.mjs not found at " + phasedOrchestrator,
        );
      const proc = spawn(PREFERRED_NODE_BIN, [phasedOrchestrator, "--all", requirement], {
        cwd: CREWSWARM_DIR,
        stdio: "ignore",
        detached: true,
        env: {
          ...process.env,
          CREWSWARM_DIR,
          ...projectEnv,
          PHASED_TASK_TIMEOUT_MS:
            process.env.PHASED_TASK_TIMEOUT_MS || "300000",
          CREWSWARM_RT_SEND_TIMEOUT_MS:
            process.env.CREWSWARM_RT_SEND_TIMEOUT_MS || "300000",
        },
      });
      proc.unref();
      // Track PID for stop functionality
      const pidFile = path.join(
        CREWSWARM_DIR,
        "orchestrator-logs",
        projectId ? "phased-" + projectId + ".pid" : "phased-orchestrator.pid",
      );
      await import("node:fs/promises")
        .then((m) => m.writeFile(pidFile, String(proc.pid), "utf8"))
        .catch(() => { });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ ok: true, pid: proc.pid, message: "Build started" }),
      );
      return;
    }
    if (url.pathname === "/api/build/stop" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { projectId } = JSON.parse(body || "{}");
      const pidFile = path.join(
        CREWSWARM_DIR,
        "orchestrator-logs",
        projectId ? "phased-" + projectId + ".pid" : "phased-orchestrator.pid",
      );
      try {
        const pidStr = fs.readFileSync(pidFile, "utf8").trim();
        const pid = parseInt(pidStr, 10);
        if (pid) process.kill(pid, "SIGTERM");
        fs.unlinkSync(pidFile);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, pid }));
      } catch (e) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    if (url.pathname === "/api/continuous-build" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body || "{}"); } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
        return;
      }
      const vr = validate(ContinuousBuildSchema, parsed);
      if (!vr.ok) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: vr.error }));
        return;
      }
      const { requirement, projectId } = vr.data;
      let projectEnv = {};
      if (projectId) {
        const { existsSync: ex } = await import("node:fs");
        const { readFile: rf } = await import("node:fs/promises");
        const regPath = path.join(
          CFG_DIR,
          "projects.json",
        );
        if (ex(regPath)) {
          const reg = JSON.parse(await rf(regPath, "utf8").catch(() => "{}"));
          const proj = reg[projectId];
          if (proj) {
            projectEnv = {
              CREWSWARM_OUTPUT_DIR: proj.outputDir,
              PM_ROADMAP_FILE: proj.roadmapFile,
              PM_PROJECT_ID: projectId,
              ...(proj.featuresDoc
                ? { PM_FEATURES_DOC: proj.featuresDoc }
                : {}),
            };
          }
        }
      }
      const { spawn } = await import("node:child_process");
      const { existsSync } = await import("node:fs");
      if (!existsSync(continuousBuild))
        throw new Error("continuous-build.mjs not found at " + continuousBuild);
      const proc = spawn(PREFERRED_NODE_BIN, [continuousBuild, requirement], {
        cwd: CREWSWARM_DIR,
        stdio: "ignore",
        detached: true,
        env: {
          ...process.env,
          CREWSWARM_DIR,
          ...projectEnv,
          PHASED_TASK_TIMEOUT_MS:
            process.env.PHASED_TASK_TIMEOUT_MS || "300000",
          CREWSWARM_RT_SEND_TIMEOUT_MS:
            process.env.CREWSWARM_RT_SEND_TIMEOUT_MS || "300000",
        },
      });
      proc.unref();
      const pidFile = path.join(
        CREWSWARM_DIR,
        "orchestrator-logs",
        projectId ? "continuous-" + projectId + ".pid" : "continuous-build.pid",
      );
      await import("node:fs/promises")
        .then((m) => m.writeFile(pidFile, String(proc.pid), "utf8"))
        .catch(() => { });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          pid: proc.pid,
          message: "Continuous build started",
        }),
      );
      return;
    }
    if (
      url.pathname === "/api/continuous-build/stop" &&
      req.method === "POST"
    ) {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { projectId } = JSON.parse(body || "{}");
      const pidFile = path.join(
        CREWSWARM_DIR,
        "orchestrator-logs",
        projectId ? "continuous-" + projectId + ".pid" : "continuous-build.pid",
      );
      try {
        const pidStr = fs.readFileSync(pidFile, "utf8").trim();
        const pid = parseInt(pidStr, 10);
        if (pid) process.kill(pid, "SIGTERM");
        fs.unlinkSync(pidFile);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, pid }));
      } catch (e) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    if (url.pathname === "/api/continuous-build/log" && req.method === "GET") {
      const { existsSync } = await import("node:fs");
      const { readFile } = await import("node:fs/promises");
      const logPath = path.join(
        CREWSWARM_DIR,
        "orchestrator-logs",
        "continuous-build.jsonl",
      );
      let lines = [];
      if (existsSync(logPath)) {
        const raw = await readFile(logPath, "utf8").catch(() => "");
        lines = raw
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        lines = lines.slice(-50); // last 50 entries
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, lines }));
      return;
    }

    function getEmbeddedWavesConfig() {
      return {
        _note:
          "Planning pipeline wave configuration. Edit via dashboard Waves tab.",
        waves: [
          {
            id: 1,
            name: "Scope + Research",
            description: "Define project scope and research context",
            agents: [
              {
                id: "crew-pm",
                task: "[SCOPE] Project: {{projectName}} at {{projectPath}}. User brief: {{userBrief}}. Use @@SKILL problem-statement {} to run a problem framing canvas, then write an initial scope doc covering: who the user is, what problem is solved, proposed features/sections, rough IA, key decisions. @@WRITE_FILE {{projectPath}}/scope-draft.md",
              },
              {
                id: "crew-copywriter",
                task: "[RESEARCH] Project: {{projectName}} at {{projectPath}}. User request: {{userRequest}}. Research the topic, brainstorm content angles, develop initial content strategy and section ideas. Use @@WEB_SEARCH if helpful. Reply with your findings and recommendations.",
              },
              {
                id: "crew-main",
                task: "[RESEARCH] Project: {{projectName}} at {{projectPath}}. User request: {{userRequest}}. Explore similar projects/pages, identify best practices and patterns. Reply with competitive landscape and recommendations.",
              },
            ],
          },
          {
            id: 2,
            name: "Technical Consultation",
            description:
              "Specialists provide architecture, design, security input",
            agents: [
              {
                id: "crew-architect",
                task: "[CONSULT] Review the scope from wave 1. Provide: system architecture (mermaid diagram if applicable), tech stack with versions, file/directory structure, data models/schema, API contracts, deployment strategy. Be specific and technical.",
              },
              {
                id: "crew-coder-front",
                task: "[CONSULT] Review the scope and content research from wave 1. Provide: component breakdown, file structure, tech stack, responsive strategy for this project.",
              },
              {
                id: "crew-frontend",
                task: "[CONSULT] Review the scope from wave 1. Provide: design system proposal (color tokens, typography, spacing, animation strategy, theme approach) for this project.",
              },
              {
                id: "crew-qa",
                task: "[CONSULT] Review the scope from wave 1. Provide: test strategy, acceptance criteria per feature, performance budgets, a11y requirements.",
              },
              {
                id: "crew-security",
                task: "[CONSULT] Review the scope from wave 1. Provide: security considerations (CSP, CORS, dependencies, auth if needed).",
              },
            ],
          },
          {
            id: 3,
            name: "PM Compiles",
            description: "PM synthesizes all input into planning documents",
            agents: [
              {
                id: "crew-pm",
                task: "Compile ALL specialist input from previous waves. Use @@SKILL roadmap-planning {} to structure the output. Write THREE files: (1) {{projectPath}}/PDD.md (product design doc: persona, problem, success metrics, constraints, non-goals, technical decisions), (2) {{projectPath}}/TECH-SPEC.md (technical specification: architecture diagram from crew-architect, tech stack, data models, API contracts, file structure, deployment, security), (3) {{projectPath}}/ROADMAP.md (phased tasks with agents, file paths, acceptance criteria). @@WRITE_FILE all three files. Do NOT dispatch build tasks — present for user approval.",
              },
            ],
          },
        ],
        templates: {
          default: {
            name: "Default Planning Pipeline",
            description: "Standard 3-wave planning for general projects",
            waves: [1, 2, 3],
          },
        },
      };
    }

    // ── Waves Configuration APIs ──────────────────────────────────────────
    if (url.pathname === "/api/waves/config" && req.method === "GET") {
      const { existsSync, readFileSync } = await import("node:fs");
      const { readFile: rf } = await import("node:fs/promises");
      const wavesConfigPath = path.join(
        CREWSWARM_DIR,
        "lib",
        "crew-lead",
        "waves-config.json",
      );

      if (!existsSync(wavesConfigPath)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Waves config not found" }));
        return;
      }

      try {
        let raw = "";
        try {
          raw = await rf(wavesConfigPath, "utf8");
        } catch (readErr) {
          try {
            raw = await rf(wavesConfigPath, "utf8");
          } catch {
            try {
              raw = readFileSync(wavesConfigPath, "utf8");
            } catch {
              raw = JSON.stringify(getEmbeddedWavesConfig());
            }
          }
          console.warn("[dashboard] Waves config read failed, used fallback:", readErr?.message || readErr);
        }
        const config = JSON.parse(raw);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(config));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (url.pathname === "/api/waves/config" && req.method === "POST") {
      const { writeFile: wf } = await import("node:fs/promises");
      const wavesConfigPath = path.join(
        CREWSWARM_DIR,
        "lib",
        "crew-lead",
        "waves-config.json",
      );

      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const config = JSON.parse(body);
          await wf(wavesConfigPath, JSON.stringify(config, null, 2), "utf8");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    if (url.pathname === "/api/waves/config/reset" && req.method === "POST") {
      const { readFile: rf, writeFile: wf } = await import("node:fs/promises");
      const wavesConfigPath = path.join(
        CREWSWARM_DIR,
        "lib",
        "crew-lead",
        "waves-config.json",
      );
      const wavesConfigBackup = wavesConfigPath + ".default";

      try {
        // Check if we have a backup
        const { existsSync } = await import("node:fs");
        if (existsSync(wavesConfigBackup)) {
          const defaultConfig = await rf(wavesConfigBackup, "utf8");
          await wf(wavesConfigPath, defaultConfig, "utf8");
        } else {
          await wf(
            wavesConfigPath,
            JSON.stringify(getEmbeddedWavesConfig(), null, 2),
            "utf8",
          );
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // ── Workflow Cron APIs ───────────────────────────────────────────────
    if (url.pathname === "/api/workflows/list" && req.method === "GET") {
      try {
        const workflows = await listWorkflows();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            workflows,
          }),
        );
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (url.pathname === "/api/workflows/item" && req.method === "GET") {
      const name = String(url.searchParams.get("name") || "").trim();
      if (!isValidWorkflowName(name)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid workflow name" }));
        return;
      }
      try {
        const item = await readWorkflowByName(name);
        const runState = workflowRuntime.runs.get(name) || {};
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            name,
            workflow: item.workflow,
            runState,
            filePath: item.filePath,
            updatedAt: item.mtime,
            cronExample: `*/15 * * * * cd ${CREWSWARM_DIR} && node scripts/run-scheduled-pipeline.mjs ${name} >> ~/.crewswarm/logs/cron.log 2>&1`,
          }),
        );
      } catch (e) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (url.pathname === "/api/workflows/save" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const parsed = JSON.parse(body || "{}");
        const name = String(parsed?.name || "").trim();
        if (!isValidWorkflowName(name)) {
          throw new Error(
            "Invalid workflow name (allowed: letters, numbers, - and _)",
          );
        }

        const inWf =
          parsed?.workflow && typeof parsed.workflow === "object"
            ? parsed.workflow
            : parsed;
        const stages = Array.isArray(inWf.stages)
          ? inWf.stages
            .map((s) => ({
              agent: String(s?.agent || "").trim(),
              task: String(s?.task || s?.taskText || "").trim(),
              ...(s?.tool ? { tool: String(s.tool).trim() } : {}),
            }))
            .filter((s) => s.agent && s.task)
          : [];
        const steps = Array.isArray(inWf.steps)
          ? inWf.steps
            .map((s) => ({
              skill: String(s?.skill || s?.name || "").trim(),
              params:
                s?.params && typeof s.params === "object" ? s.params : {},
            }))
            .filter((s) => s.skill)
          : [];
        if (!stages.length && !steps.length) {
          throw new Error(
            'Workflow must include at least one "stage" or "step"',
          );
        }

        const schedule = String(inWf.schedule || "").trim();
        if (schedule && !isCronExpressionValid(schedule)) {
          throw new Error("Invalid cron schedule (expected 5 cron fields)");
        }

        ensureWorkflowDirs();
        const out = {
          description: String(inWf.description || "").trim(),
          enabled: Boolean(inWf.enabled),
          schedule,
          timezone:
            String(inWf.timezone || "").trim() ||
            Intl.DateTimeFormat().resolvedOptions().timeZone,
          ...(stages.length ? { stages } : {}),
          ...(steps.length ? { steps } : {}),
          updatedAt: new Date().toISOString(),
          updatedBy: "dashboard",
        };

        const fp = getWorkflowFile(name);
        await fs.promises.writeFile(fp, JSON.stringify(out, null, 2), "utf8");
        const prev = workflowRuntime.runs.get(name) || {};
        workflowRuntime.runs.set(name, {
          ...prev,
          configUpdatedAt: out.updatedAt,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, name, filePath: fp }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (url.pathname === "/api/workflows/delete" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const parsed = JSON.parse(body || "{}");
        const name = String(parsed?.name || "").trim();
        if (!isValidWorkflowName(name))
          throw new Error("Invalid workflow name");
        const fp = getWorkflowFile(name);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
        workflowRuntime.runs.delete(name);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (url.pathname === "/api/workflows/run" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const parsed = JSON.parse(body || "{}");
        const name = String(parsed?.name || "").trim();
        const started = await startWorkflowRun(name, "manual");
        if (!started.ok) {
          res.writeHead(started.alreadyRunning ? 409 : 400, {
            "Content-Type": "application/json",
          });
          res.end(JSON.stringify(started));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(started));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (url.pathname === "/api/workflows/status" && req.method === "GET") {
      const runs = {};
      for (const [name, state] of workflowRuntime.runs.entries()) {
        runs[name] = state;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          scheduler: {
            enabled: workflowRuntime.enabled,
            tickMs: workflowRuntime.tickMs,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
          runs,
        }),
      );
      return;
    }

    if (url.pathname === "/api/workflows/log" && req.method === "GET") {
      const name = String(url.searchParams.get("name") || "").trim();
      const limit = Number(url.searchParams.get("limit") || "120");
      if (!isValidWorkflowName(name)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid workflow name" }));
        return;
      }
      const fp = path.join(workflowLogsDir, `${name}.log`);
      try {
        const raw = await fs.promises.readFile(fp, "utf8");
        const lines = raw
          .split("\n")
          .filter(Boolean)
          .slice(-Math.max(1, Math.min(limit, 500)));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, lines, filePath: fp }));
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, lines: [], filePath: fp }));
      }
      return;
    }

    // ── Project management APIs ───────────────────────────────────────────
    if (url.pathname === "/api/projects" && req.method === "GET") {
      const { existsSync } = await import("node:fs");
      const { readFile: rf } = await import("node:fs/promises");
      const registryFile = path.join(CFG_DIR, "projects.json");
      let projects = {};
      if (existsSync(registryFile)) {
        projects = JSON.parse(await rf(registryFile, "utf8").catch(() => "{}"));
      }
      // Enrich each project with live roadmap stats and running status.
      // Ensure every project has an id (registry is keyed by id; stored entries may omit it).
      const logsDir2 = path.join(CREWSWARM_DIR, "orchestrator-logs");
      const enriched = await Promise.all(
        Object.entries(projects).map(async ([keyId, p]) => {
          const id = p.id || keyId;
          const project = { ...p, id };
          let done = 0,
            failed = 0,
            pending = 0,
            total = 0;
          if (existsSync(project.roadmapFile)) {
            const rm = await rf(project.roadmapFile, "utf8").catch(() => "");
            const lines = rm.split("\n").filter((l) => /^- \[/.test(l));
            total = lines.length;
            done = lines.filter((l) => /^- \[x\]/.test(l)).length;
            failed = lines.filter((l) => /^- \[!\]/.test(l)).length;
            pending = lines.filter((l) => /^- \[ \]/.test(l)).length;
          }
          let running = false;
          const pidPath = path.join(logsDir2, `pm-loop-${id}.pid`);
          if (existsSync(pidPath)) {
            try {
              const pidStr = await rf(pidPath, "utf8").catch(() => "");
              const pid = parseInt(pidStr.trim(), 10);
              if (pid) {
                process.kill(pid, 0);
                running = true;
              }
            } catch {
              /* not running */
            }
          }
          return {
            ...project,
            roadmap: { done, failed, pending, total },
            running,
          };
        }),
      );
      res.writeHead(200, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
      });
      res.end(JSON.stringify({ ok: true, projects: enriched }));
      return;
    }
    if (url.pathname === "/api/ui/active-project") {
      if (req.method === "GET") {
        const uiState = readUiState();
        res.writeHead(200, {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        });
        res.end(
          JSON.stringify({
            ok: true,
            projectId: String(uiState.chatActiveProjectId || "general"),
          }),
        );
        return;
      }
      if (req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const { projectId } = JSON.parse(body || "{}");
        const normalizedProjectId =
          projectId && String(projectId).trim()
            ? String(projectId).trim()
            : "general";
        const uiState = readUiState();
        uiState.chatActiveProjectId = normalizedProjectId;
        writeUiState(uiState);
        res.writeHead(200, {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        });
        res.end(JSON.stringify({ ok: true, projectId: normalizedProjectId }));
        return;
      }
    }
    if (url.pathname === "/api/projects" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { name, description, outputDir, featuresDoc } = JSON.parse(
        body || "{}",
      );
      if (!name || !outputDir) throw new Error("name and outputDir required");
      const { existsSync, mkdirSync } = await import("node:fs");
      const { readFile: rf, writeFile: wf } = await import("node:fs/promises");
      // Create output dir and ROADMAP.md if they don't exist
      if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
      const roadmapFile = path.join(outputDir, "ROADMAP.md");
      if (!existsSync(roadmapFile)) {
        await wf(
          roadmapFile,
          `# ${name} — Living Roadmap\n\n> Managed by pm-loop.mjs. Add \`- [ ] items\` here at any time.\n\n---\n\n## Phase 0 — Getting Started\n\n- [ ] Create the initial project structure and entry point\n`,
        );
      }
      const id = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      const registryFile = path.join(CFG_DIR, "projects.json");
      let projects = {};
      if (existsSync(registryFile))
        projects = JSON.parse(await rf(registryFile, "utf8").catch(() => "{}"));
      projects[id] = {
        id,
        name,
        description: description || "",
        outputDir,
        roadmapFile,
        featuresDoc: featuresDoc || "",
        tags: [],
        created: new Date().toISOString(),
        status: "active",
      };
      await wf(registryFile, JSON.stringify(projects, null, 2));
      res.writeHead(200, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
      });
      res.end(JSON.stringify({ ok: true, project: projects[id] }));
      return;
    }
    if (url.pathname === "/api/projects/delete" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body || "{}"); } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
        return;
      }
      const vr = validate(DeleteProjectSchema, parsed);
      if (!vr.ok) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: vr.error }));
        return;
      }
      const { projectId } = vr.data;
      const registryFile = path.join(CFG_DIR, "projects.json");
      const { existsSync, rmSync, writeFileSync, unlinkSync } = await import("node:fs");
      const { readFile: rf, writeFile: wf } = await import("node:fs/promises");
      let projects = {};
      if (existsSync(registryFile))
        projects = JSON.parse(await rf(registryFile, "utf8").catch(() => "{}"));
      if (!projects[projectId])
        throw new Error("Project not found: " + projectId);
      const logsDir = path.join(CREWSWARM_DIR, "orchestrator-logs");
      const pidPath = path.join(logsDir, `pm-loop-${projectId}.pid`);
      const stopPath = path.join(logsDir, `pm-loop-${projectId}.stop`);
      const logPath = path.join(logsDir, `pm-loop-${projectId}.jsonl`);
      let stoppedPmLoop = false;
      if (existsSync(pidPath)) {
        const pidStr = await rf(pidPath, "utf8").catch(() => "");
        const pid = parseInt(pidStr.trim(), 10);
        if (pid) {
          try {
            process.kill(pid, "SIGTERM");
            stoppedPmLoop = true;
          } catch { }
        }
      }
      try {
        writeFileSync(stopPath, new Date().toISOString());
      } catch { }
      for (const cleanupPath of [pidPath, stopPath, logPath]) {
        if (!existsSync(cleanupPath)) continue;
        try {
          unlinkSync(cleanupPath);
        } catch { }
      }
      const projectMessageDir = path.join(CFG_DIR, "project-messages", projectId);
      if (existsSync(projectMessageDir)) {
        try {
          rmSync(projectMessageDir, { recursive: true, force: true });
        } catch { }
      }
      delete projects[projectId];
      await wf(registryFile, JSON.stringify(projects, null, 2));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, stoppedPmLoop }));
      return;
    }
    if (url.pathname === "/api/projects/update" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body || "{}"); } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
        return;
      }
      const vr = validate(UpdateProjectSchema, parsed);
      if (!vr.ok) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: vr.error }));
        return;
      }
      const { projectId, autoAdvance, name, description, outputDir } = vr.data;
      const registryFile = path.join(CFG_DIR, "projects.json");
      const { existsSync } = await import("node:fs");
      const { readFile: rf, writeFile: wf } = await import("node:fs/promises");
      let projects = {};
      if (existsSync(registryFile))
        projects = JSON.parse(await rf(registryFile, "utf8").catch(() => "{}"));
      if (!projects[projectId])
        throw new Error("Project not found: " + projectId);
      const proj = projects[projectId];
      if (autoAdvance !== undefined) proj.autoAdvance = Boolean(autoAdvance);
      if (name) proj.name = name;
      if (description !== undefined) proj.description = description;
      if (outputDir) proj.outputDir = outputDir;
      await wf(registryFile, JSON.stringify(projects, null, 2));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, project: projects[projectId] }));
      return;
    }
    if (url.pathname === "/api/pm-loop/status" && req.method === "GET") {
      const { existsSync } = await import("node:fs");
      const { readFile: rf } = await import("node:fs/promises");
      const statusProjectId = url.searchParams.get("projectId") || "";
      const suffix = statusProjectId ? `-${statusProjectId}` : "";
      const pidPath = path.join(
        CREWSWARM_DIR,
        "orchestrator-logs",
        `pm-loop${suffix}.pid`,
      );
      let running = false,
        pid = null;
      if (existsSync(pidPath)) {
        const pidStr = await rf(pidPath, "utf8").catch(() => "");
        pid = parseInt(pidStr.trim(), 10);
        if (pid) {
          try {
            process.kill(pid, 0);
            running = true;
          } catch {
            running = false;
            pid = null;
          }
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, running, pid }));
      return;
    }
    if (url.pathname === "/api/pm-loop/start" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body || "{}"); } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
        return;
      }
      const vr = validate(StartPMLoopSchema, parsed);
      if (!vr.ok) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: vr.error }));
        return;
      }
      const { dryRun, projectId, pmOptions = {} } = vr.data;
      const { spawn } = await import("node:child_process");
      const { existsSync, mkdirSync, unlinkSync } = await import("node:fs");
      const { readFile: rf } = await import("node:fs/promises");
      if (!existsSync(pmLoop))
        throw new Error("pm-loop.mjs not found at " + pmLoop);
      // Resolve project config if projectId provided
      let projectDir = null,
        projectRoadmap = null,
        projectFeaturesDoc = null;
      if (projectId) {
        const registryFile = path.join(CFG_DIR, "projects.json");
        if (existsSync(registryFile)) {
          const reg = JSON.parse(
            await rf(registryFile, "utf8").catch(() => "{}"),
          );
          const proj = reg[projectId];
          if (proj) {
            projectDir = proj.outputDir;
            projectRoadmap = proj.roadmapFile;
            projectFeaturesDoc = proj.featuresDoc || null;
          }
        }
      }
      // Per-project PID file (supports multiple simultaneous projects)
      const pidSuffix = projectId ? `-${projectId}` : "";
      const pidFile = path.join(
        CREWSWARM_DIR,
        "orchestrator-logs",
        `pm-loop${pidSuffix}.pid`,
      );
      const stopFilePath = path.join(
        CREWSWARM_DIR,
        "orchestrator-logs",
        `pm-loop${pidSuffix}.stop`,
      );
      if (existsSync(pidFile)) {
        const pidStr = await rf(pidFile, "utf8").catch(() => "");
        const existingPid = parseInt(pidStr.trim(), 10);
        if (existingPid) {
          try {
            process.kill(existingPid, 0); // throws if not running
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                ok: true,
                alreadyRunning: true,
                pid: existingPid,
                message: "PM Loop already running (pid " + existingPid + ")",
              }),
            );
            return;
          } catch {
            /* process dead — stale PID file, continue */
          }
        }
      }
      // Clear any stale stop file
      if (existsSync(stopFilePath)) {
        try {
          unlinkSync(stopFilePath);
        } catch { }
      }
      const logsDir = path.join(CREWSWARM_DIR, "orchestrator-logs");
      if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
      // Load RT token so pm-loop and its child gateway-bridge --send can authenticate with the RT daemon
      let rtToken = process.env.CREWSWARM_RT_AUTH_TOKEN || "";
      if (!rtToken) {
        const home = os.homedir();
        for (const p of [
          path.join(CFG_DIR, "crewswarm.json"),
          path.join(home, ".crewswarm", "crewswarm.json"),
          path.join(CFG_DIR, "crewswarm.json"),
          path.join(home, ".crewswarm", "crewswarm.json"),
          path.join(home, ".openclaw", "openclaw.json"),
        ]) {
          try {
            const c = JSON.parse(await rf(p, "utf8"));
            rtToken = c?.rt?.authToken || c?.env?.CREWSWARM_RT_AUTH_TOKEN || "";
            if (rtToken) break;
          } catch { }
        }
      }
      if (!rtToken) {
        console.warn(
          "[pm-loop/start] No CREWSWARM_RT_AUTH_TOKEN found in env or ~/.crewswarm/crewswarm.json (rt.authToken) — dispatches will fail with 'invalid realtime token'.",
        );
      }
      const spawnArgs = [
        pmLoop,
        ...(dryRun ? ["--dry-run"] : []),
        ...(projectDir ? ["--project-dir", projectDir] : []),
      ];
      const spawnEnv = {
        ...process.env,
        CREWSWARM_DIR,
        ...(rtToken ? { CREWSWARM_RT_AUTH_TOKEN: rtToken } : {}),
        PHASED_TASK_TIMEOUT_MS: process.env.PHASED_TASK_TIMEOUT_MS || "300000",
        CREWSWARM_RT_SEND_TIMEOUT_MS:
          process.env.CREWSWARM_RT_SEND_TIMEOUT_MS || "300000",
        CREWSWARM_RT_SEND_SENDER: "orchestrator",
        CREWSWARM_RT_BROADCAST_SENDER: "orchestrator",
        ...(projectId ? { PM_PROJECT_ID: projectId } : {}),
        ...(projectDir ? { CREWSWARM_OUTPUT_DIR: projectDir } : {}),
        ...(projectRoadmap ? { PM_ROADMAP_FILE: projectRoadmap } : {}),
        ...(projectFeaturesDoc ? { PM_FEATURES_DOC: projectFeaturesDoc } : {}),
        ...(pmOptions.useQA === false ? { PM_USE_QA: "0" } : {}),
        ...(pmOptions.useSecurity === false ? { PM_USE_SECURITY: "0" } : {}),
        ...(pmOptions.useSpecialists === false
          ? { PM_USE_SPECIALISTS: "0" }
          : {}),
        ...(pmOptions.selfExtend === false ? { PM_SELF_EXTEND: "0" } : {}),
        ...(pmOptions.maxItems
          ? { PM_MAX_ITEMS: String(pmOptions.maxItems) }
          : {}),
        ...(pmOptions.taskTimeoutMin
          ? { PHASED_TASK_TIMEOUT_MS: String(pmOptions.taskTimeoutMin * 60000) }
          : {}),
        ...(pmOptions.extendEveryN
          ? { PM_EXTEND_EVERY: String(pmOptions.extendEveryN) }
          : {}),
        ...(pmOptions.pauseSec !== undefined
          ? { PM_PAUSE_MS: String(pmOptions.pauseSec * 1000) }
          : {}),
        ...(pmOptions.maxRetries !== undefined
          ? { PM_MAX_RETRIES: String(pmOptions.maxRetries) }
          : {}),
        ...(pmOptions.coderAgent
          ? { PM_CODER_AGENT: pmOptions.coderAgent }
          : {}),
      };
      // Generate correlation ID for tracing
      const correlationId = `pm-${projectId || "default"}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // Add correlation ID to environment
      spawnEnv.PM_CORRELATION_ID = correlationId;

      const proc = spawn("node", spawnArgs, {
        cwd: CREWSWARM_DIR,
        stdio: "ignore",
        detached: true,
        env: spawnEnv,
      });
      proc.unref();

      // Log PM loop start
      console.log(`[dashboard] PM loop started: projectId=${projectId || "(default)"} pid=${proc.pid} correlation=${correlationId}`);

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, pid: proc.pid, correlationId, dryRun: !!dryRun }));
      return;
    }
    if (url.pathname === "/api/pm-loop/stop" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { projectId } = JSON.parse(body || "{}");
      const { writeFileSync, mkdirSync, existsSync } = await import("node:fs");
      const logsDir = path.join(CREWSWARM_DIR, "orchestrator-logs");
      if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
      // Write project-specific stop file if projectId provided
      const suffix = projectId ? `-${projectId}` : "";
      const stopFilePath = path.join(logsDir, `pm-loop${suffix}.stop`);
      writeFileSync(stopFilePath, new Date().toISOString());
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          message: "Stop signal sent — PM will halt after current task",
        }),
      );
      return;
    }
    if (url.pathname === "/api/pm-loop/log" && req.method === "GET") {
      const { existsSync } = await import("node:fs");
      const { readFile } = await import("node:fs/promises");
      let lines = [];
      if (existsSync(pmLogFile)) {
        const raw = await readFile(pmLogFile, "utf8").catch(() => "");
        lines = raw
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        lines = lines.slice(-60);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, lines }));
      return;
    }
    if (url.pathname === "/api/pm-loop/roadmap" && req.method === "GET") {
      const { existsSync } = await import("node:fs");
      const { readFile } = await import("node:fs/promises");
      let content = "(ROADMAP.md not found — create website/ROADMAP.md)";
      if (existsSync(roadmapFile)) {
        content = await readFile(roadmapFile, "utf8").catch(
          () => "(unreadable)",
        );
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, content }));
      return;
    }
    if (url.pathname === "/api/dlq/replay" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
        return;
      }
      const vr = validate(ReplayDLQSchema, parsed);
      if (!vr.ok) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: vr.error }));
        return;
      }
      const { key } = vr.data;
      const { execSync } = await import("node:child_process");
      execSync(`"${ctlPath}" dlq-replay "${key}"`, {
        encoding: "utf8",
        timeout: 10000,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname.startsWith("/api/dlq/") && req.method === "DELETE") {
      const raw = url.pathname.replace("/api/dlq/", "");
      const taskId = decodeURIComponent(raw).replace(/[^a-zA-Z0-9_.-]/g, "");
      try {
        const { deleteDLQEntry } = await import("../lib/runtime/dlq.mjs");
        const deleted = deleteDLQEntry(taskId);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: deleted }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }
    // ── Settings: Preset (from setup wizard) ────────────────────────────────
    // ── Engine detection for first-run wizard ─────────────────────────────
    if (url.pathname === "/api/first-run-engines" && req.method === "GET") {
      const { execSync } = await import("node:child_process");
      // Expand PATH to include common install locations (launchd has restricted PATH)
      const extraPaths = [
        `${os.homedir()}/.local/bin`,
        "/usr/local/bin",
        "/opt/homebrew/bin",
        `${os.homedir()}/.npm-global/bin`,
        `${os.homedir()}/.nvm/versions/node/*/bin`,
      ].join(":");
      const fullPath = `${extraPaths}:${process.env.PATH || ""}`;
      const checks = [
        { id: "claude-code", bin: "claude" },
        { id: "codex",       bin: "codex" },
        { id: "opencode",    bin: "opencode" },
        { id: "gemini-cli",  bin: "gemini" },
        { id: "cursor",      bin: "cursor" },
      ];
      const engines = { "crew-cli": true }; // always available (part of this repo)
      const searchDirs = [
        "/usr/local/bin",
        "/opt/homebrew/bin",
        `${os.homedir()}/.local/bin`,
        `${os.homedir()}/.npm-global/bin`,
      ];
      for (const { id, bin } of checks) {
        // Check common paths directly (launchd PATH is restricted)
        if (searchDirs.some(d => fs.existsSync(path.join(d, bin)))) {
          engines[id] = true;
          continue;
        }
        // Fallback: try login shell
        try {
          execSync(`/bin/zsh -lc 'command -v ${bin}'`, { stdio: "pipe", timeout: 5000 });
          engines[id] = true;
        } catch {
          engines[id] = false;
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ engines }));
      return;
    }
    // ── Settings: RT Bus token ─────────────────────────────────────────────
    if (url.pathname === "/api/settings/rt-token" && req.method === "GET") {
      const csConfigPath = path.join(os.homedir(), ".crewswarm", "crewswarm.json");
      let token = "";
      try {
        token =
          JSON.parse(fs.readFileSync(csConfigPath, "utf8"))?.rt?.authToken ||
          "";
      } catch { }
      if (!token) token = process.env.CREWSWARM_RT_AUTH_TOKEN || "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: token ? "SET" : "" }));
      return;
    }
    if (url.pathname === "/api/settings/rt-token" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { token } = JSON.parse(body);
      const csDir = path.join(os.homedir(), ".crewswarm");
      const csConfigPath = path.join(csDir, "crewswarm.json");
      fs.mkdirSync(csDir, { recursive: true });
      let cfg = {};
      try {
        cfg = JSON.parse(fs.readFileSync(csConfigPath, "utf8"));
      } catch { }
      cfg.rt = { ...(cfg.rt || {}), authToken: token };
      fs.writeFileSync(csConfigPath, JSON.stringify(cfg, null, 2));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // ── Settings: Config lock/unlock ────────────────────────────────────────
    if (url.pathname === "/api/config/lock-status" && req.method === "GET") {
      const cfgPath = path.join(os.homedir(), ".crewswarm", "crewswarm.json");
      let locked = false;
      try {
        const { execSync } = require("child_process");
        // Use stat command which is more reliable than ls
        const output = execSync(`stat -f "%Sf" "${cfgPath}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        locked = output.trim().includes('uchg');
      } catch (e) {
        // If stat fails, try ls as fallback
        try {
          const output2 = execSync(`ls -lO "${cfgPath}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
          locked = output2.includes('uchg');
        } catch { }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ locked }));
      return;
    }
    if (url.pathname === "/api/config/lock" && req.method === "POST") {
      const cfgPath = path.join(os.homedir(), ".crewswarm", "crewswarm.json");
      try {
        execSync(`chflags uchg "${cfgPath}"`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, locked: true }));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (url.pathname === "/api/config/unlock" && req.method === "POST") {
      const cfgPath = path.join(os.homedir(), ".crewswarm", "crewswarm.json");
      try {
        execSync(`chflags nouchg "${cfgPath}"`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, locked: false }));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    // ── Settings: OpenCode project dir + fallback model ─────────────────────
    if (
      url.pathname === "/api/settings/opencode-project" &&
      req.method === "GET"
    ) {
      const cfgPath = path.join(os.homedir(), ".crewswarm", "crewswarm.json");
      let dir = process.env.CREWSWARM_OPENCODE_PROJECT || "";
      let fallbackModel =
        process.env.CREWSWARM_OPENCODE_FALLBACK_MODEL ||
        "groq/moonshotai/kimi-k2-instruct-0905";
      let opencodeModel =
        process.env.CREWSWARM_OPENCODE_MODEL ||
        "groq/moonshotai/kimi-k2-instruct-0905";
      let crewLeadModel = process.env.CREWSWARM_CREW_LEAD_MODEL || "";
      try {
        const c = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        if (c.opencodeProject) dir = c.opencodeProject;
        if (c.opencodeFallbackModel) fallbackModel = c.opencodeFallbackModel;
        if (c.opencodeModel) opencodeModel = c.opencodeModel;
        if (c.crewLeadModel) crewLeadModel = c.crewLeadModel;
      } catch { }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ dir, fallbackModel, opencodeModel, crewLeadModel }),
      );
      return;
    }
    if (
      url.pathname === "/api/settings/opencode-project" &&
      req.method === "POST"
    ) {
      let body = "";
      for await (const chunk of req) body += chunk;
      let { dir, fallbackModel, opencodeModel, crewLeadModel } =
        JSON.parse(body);
      // Normalize: expand ~, ensure absolute path
      if (dir !== undefined) {
        if (dir) {
          dir = dir.trim();
          if (dir.startsWith("~")) dir = os.homedir() + dir.slice(1);
          if (!path.isAbsolute(dir)) dir = "/" + dir;
          dir = path.normalize(dir);
        }
      }
      const cfgDir = path.join(os.homedir(), ".crewswarm");
      const cfgPath = path.join(cfgDir, "crewswarm.json");
      fs.mkdirSync(cfgDir, { recursive: true });
      let cfg = {};
      try {
        cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      } catch { }
      if (dir !== undefined) {
        if (dir) cfg.opencodeProject = dir;
        else delete cfg.opencodeProject;
        process.env.CREWSWARM_OPENCODE_PROJECT = dir || "";
      }
      if (fallbackModel !== undefined) {
        if (fallbackModel && String(fallbackModel).trim())
          cfg.opencodeFallbackModel = String(fallbackModel).trim();
        else delete cfg.opencodeFallbackModel;
      }
      if (opencodeModel !== undefined) {
        if (opencodeModel && String(opencodeModel).trim()) {
          cfg.opencodeModel = String(opencodeModel).trim();
          process.env.CREWSWARM_OPENCODE_MODEL = cfg.opencodeModel;
        } else {
          delete cfg.opencodeModel;
          delete process.env.CREWSWARM_OPENCODE_MODEL;
        }
      }
      if (crewLeadModel !== undefined) {
        if (crewLeadModel && String(crewLeadModel).trim())
          cfg.crewLeadModel = String(crewLeadModel).trim();
        else delete cfg.crewLeadModel;
      }
      const writeErr = await safeWriteConfig(cfg, 2);
      if (writeErr) {
        res.writeHead(writeErr.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: writeErr.message }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          dir: cfg.opencodeProject,
          fallbackModel: cfg.opencodeFallbackModel,
          opencodeModel: cfg.opencodeModel,
          crewLeadModel: cfg.crewLeadModel,
        }),
      );
      return;
    }
    // ── Built-in providers (crewswarm standalone config) ─────────────────
    const BUILTIN_URLS = {
      groq: "https://api.groq.com/openai/v1",
      fireworks: "https://api.fireworks.ai/inference/v1",
      anthropic: "https://api.anthropic.com/v1",
      openai: "https://api.openai.com/v1",
      cerebras: "https://api.cerebras.ai/v1",
      nvidia: "https://integrate.api.nvidia.com/v1",
      google: "https://generativelanguage.googleapis.com/v1beta/openai",
      perplexity: "https://api.perplexity.ai",
      mistral: "https://api.mistral.ai/v1",
      deepseek: "https://api.deepseek.com/v1",
      together: "https://api.together.xyz/v1",
      xai: "https://api.x.ai/v1",
      cohere: "https://api.cohere.ai/v1",
      ollama: "http://localhost:11434/v1",
      openrouter: "https://openrouter.ai/api/v1",
      "openai-local": "http://127.0.0.1:8000/v1",
    };
    const csDir = path.join(os.homedir(), ".crewswarm");
    const csConfig = path.join(csDir, "crewswarm.json");
    const csSwarmConfig = path.join(csDir, "crewswarm.json");
    const ocConfig = path.join(os.homedir(), ".openclaw", "openclaw.json");
    function readCSConfig() {
      try {
        return JSON.parse(fs.readFileSync(csConfig, "utf8"));
      } catch {
        return {};
      }
    }
    function readCSSwarmConfig() {
      try {
        return JSON.parse(fs.readFileSync(csSwarmConfig, "utf8"));
      } catch {
        return {};
      }
    }
    function writeCSSwarmConfig(c) {
      fs.mkdirSync(csDir, { recursive: true });
      fs.writeFileSync(csSwarmConfig, JSON.stringify(c, null, 2));
    }
    function readOCConfig() {
      try {
        return JSON.parse(fs.readFileSync(ocConfig, "utf8"));
      } catch {
        return null;
      }
    }
    function writeOCConfig(c) {
      fs.writeFileSync(ocConfig, JSON.stringify(c, null, 4));
    }
    function getBuiltinKey(id) {
      const sw = readCSSwarmConfig();
      const cs = readCSConfig();
      const oc = readOCConfig();
      return (
        sw?.providers?.[id]?.apiKey ||
        sw?.env?.[id.toUpperCase() + "_API_KEY"] ||
        cs?.providers?.[id]?.apiKey ||
        cs?.env?.[id.toUpperCase() + "_API_KEY"] ||
        oc?.models?.providers?.[id]?.apiKey ||
        ""
      );
    }

    if (url.pathname === "/api/providers/builtin" && req.method === "GET") {
      const keys = {};
      for (const id of Object.keys(BUILTIN_URLS)) {
        keys[id] = getBuiltinKey(id) ? "SET" : "";
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, keys }));
      return;
    }
    if (
      url.pathname === "/api/providers/builtin/save" &&
      req.method === "POST"
    ) {
      let body = "";
      for await (const chunk of req) body += chunk;
      let { providerId, apiKey } = JSON.parse(body);
      // OpenAI (local)/ChatMock ignores key; use placeholder so crew-lead has a truthy apiKey
      if (providerId === "openai-local" && !(apiKey && apiKey.trim()))
        apiKey = "key";
      // Write to ~/.crewswarm/crewswarm.json
      const cfg = readCSSwarmConfig();
      if (!cfg.providers) cfg.providers = {};
      cfg.providers[providerId] = {
        ...(cfg.providers[providerId] || {}),
        apiKey,
        baseUrl: BUILTIN_URLS[providerId],
      };
      writeCSSwarmConfig(cfg);
      // Sync to ~/.openclaw/openclaw.json if it exists (legacy compat)
      const oc = readOCConfig();
      if (oc) {
        if (!oc.models) oc.models = {};
        if (!oc.models.providers) oc.models.providers = {};
        if (!oc.models.providers[providerId]) {
          oc.models.providers[providerId] = {
            baseUrl: BUILTIN_URLS[providerId],
            api: "openai-completions",
            models: [],
          };
        }
        oc.models.providers[providerId].apiKey = apiKey;
        writeOCConfig(oc);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (
      url.pathname === "/api/providers/builtin/test" &&
      req.method === "POST"
    ) {
      let body = "";
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
        return;
      }
      const vr = validate(ProviderBuiltinTestSchema, parsed);
      if (!vr.ok) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: vr.error }));
        return;
      }
      const { providerId } = vr.data;
      const apiKey = getBuiltinKey(providerId);
      const baseUrl = BUILTIN_URLS[providerId] || "";
      if (providerId === "ollama") {
        try {
          const r = await fetch("http://localhost:11434/api/tags", {
            signal: AbortSignal.timeout(4000),
          });
          const d = await r.json();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              model: d.models?.[0]?.name || "connected",
            }),
          );
        } catch (e) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }
      if (providerId === "openai-local") {
        const key = apiKey || "key";
        try {
          const r = await fetch(baseUrl + "/models", {
            headers: { authorization: "Bearer " + key },
            signal: AbortSignal.timeout(6000),
          });
          const d = await r.json().catch(() => ({}));
          const model =
            d?.data?.[0]?.id || (r.ok ? "ChatMock connected" : null);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: r.ok,
              model,
              error: r.ok
                ? undefined
                : (d?.error?.message || r.statusText)?.slice(0, 80),
            }),
          );
        } catch (e) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }
      if (!apiKey) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "No API key saved" }));
        return;
      }
      try {
        let r, d, model;
        if (providerId === "anthropic") {
          // Anthropic uses x-api-key + anthropic-version, and /v1/models
          r = await fetch("https://api.anthropic.com/v1/models", {
            headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
            signal: AbortSignal.timeout(8000),
          });
          d = await r.json();
          model = d?.data?.[0]?.id || (r.ok ? "connected" : null);
        } else {
          r = await fetch(baseUrl + "/models", {
            headers: { authorization: "Bearer " + apiKey },
            signal: AbortSignal.timeout(8000),
          });
          d = await r.json();
          model = d?.data?.[0]?.id || (r.ok ? "connected" : null);
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: r.ok,
            model,
            error: r.ok ? undefined : d?.error?.message || r.statusText,
          }),
        );
      } catch (e) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    // ── Proxy /api/settings/bg-consciousness → crew-lead:5010 ────────────────
    if (url.pathname === "/api/settings/bg-consciousness") {
      try {
        const rawBody =
          req.method === "POST"
            ? await (async () => {
              let b = "";
              for await (const c of req) b += c;
              return b;
            })()
            : null;
        const token = (() => {
          try {
            return (
              JSON.parse(
                fs.readFileSync(
                  path.join(os.homedir(), ".crewswarm", "crewswarm.json"),
                  "utf8",
                ),
              )?.rt?.authToken || ""
            );
          } catch {
            return "";
          }
        })();
        const r = await fetch(
          "http://127.0.0.1:5010/api/settings/bg-consciousness",
          {
            method: req.method,
            headers: {
              "content-type": "application/json",
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            ...(rawBody ? { body: rawBody } : {}),
            signal: AbortSignal.timeout(8000),
          },
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(await r.text());
      } catch (e) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: "crew-lead unreachable: " + e.message,
          }),
        );
      }
      return;
    }
    // ── Proxy /api/settings/cursor-waves → crew-lead:5010 ───────────────────
    if (url.pathname === "/api/settings/cursor-waves") {
      try {
        const rawBody =
          req.method === "POST"
            ? await (async () => {
              let b = "";
              for await (const c of req) b += c;
              return b;
            })()
            : null;
        const token = (() => {
          try {
            return (
              JSON.parse(
                fs.readFileSync(
                  path.join(os.homedir(), ".crewswarm", "crewswarm.json"),
                  "utf8",
                ),
              )?.rt?.authToken || ""
            );
          } catch {
            return "";
          }
        })();
        const r = await fetch(
          "http://127.0.0.1:5010/api/settings/cursor-waves",
          {
            method: req.method,
            headers: {
              "content-type": "application/json",
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            ...(rawBody ? { body: rawBody } : {}),
            signal: AbortSignal.timeout(8000),
          },
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(await r.text());
      } catch (e) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: "crew-lead unreachable: " + e.message,
          }),
        );
      }
      return;
    }
    // ── Proxy /api/settings/claude-code → crew-lead:5010 ────────────────────
    if (url.pathname === "/api/settings/claude-code") {
      try {
        const rawBody =
          req.method === "POST"
            ? await (async () => {
              let b = "";
              for await (const c of req) b += c;
              return b;
            })()
            : null;
        const token = (() => {
          try {
            return (
              JSON.parse(
                fs.readFileSync(
                  path.join(os.homedir(), ".crewswarm", "crewswarm.json"),
                  "utf8",
                ),
              )?.rt?.authToken || ""
            );
          } catch {
            return "";
          }
        })();
        const r = await fetch(
          "http://127.0.0.1:5010/api/settings/claude-code",
          {
            method: req.method,
            headers: {
              "content-type": "application/json",
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            ...(rawBody ? { body: rawBody } : {}),
            signal: AbortSignal.timeout(8000),
          },
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(await r.text());
      } catch (e) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: "crew-lead unreachable: " + e.message,
          }),
        );
      }
      return;
    }
    // ── Codex CLI executor toggle ──────────────────────────────────────────────
    if (url.pathname === "/api/settings/codex") {
      const { readFile, writeFile } = await import("node:fs/promises");
      const cfgPath = CFG_FILE;
      if (req.method === "GET") {
        try {
          const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
          const enabled =
            cfg.codex === true || process.env.CREWSWARM_CODEX === "1";
          const installed = commandExists(process.env.CODEX_CLI_BIN || "codex");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ enabled, installed }));
        } catch {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ enabled: false, installed: false }));
        }
        return;
      }
      if (req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const { enabled } = JSON.parse(body || "{}");
        const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
        cfg.codex = enabled === true;
        const writeErr = await safeWriteConfig(cfg);
        if (writeErr) {
          res.writeHead(writeErr.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: writeErr.message }));
          return;
        }
        process.env.CREWSWARM_CODEX = enabled ? "1" : "0";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, enabled: cfg.codex }));
        return;
      }
    }
    // ── Gemini CLI executor toggle ─────────────────────────────────────────────
    if (url.pathname === "/api/settings/gemini-cli") {
      const { readFile, writeFile } = await import("node:fs/promises");
      const cfgPath = CFG_FILE;
      if (req.method === "GET") {
        try {
          const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
          const enabled =
            cfg.geminiCli === true ||
            process.env.CREWSWARM_GEMINI_CLI_ENABLED === "1";
          const installed = commandExists(process.env.GEMINI_CLI_BIN || "gemini");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ enabled, installed }));
        } catch {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ enabled: false, installed: false }));
        }
        return;
      }
      if (req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const { enabled } = JSON.parse(body || "{}");
        const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
        cfg.geminiCli = enabled === true;
        const writeErr = await safeWriteConfig(cfg);
        if (writeErr) {
          res.writeHead(writeErr.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: writeErr.message }));
          return;
        }
        process.env.CREWSWARM_GEMINI_CLI_ENABLED = enabled ? "1" : "0";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, enabled: cfg.geminiCli }));
        return;
      }
    }
    // ── Crew CLI executor toggle ─────────────────────────────────────────────────
    if (url.pathname === "/api/settings/crew-cli") {
      const { readFile, writeFile } = await import("node:fs/promises");
      const cfgPath = CFG_FILE;
      if (req.method === "GET") {
        try {
          const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
          const enabled =
            cfg.crewCli === true ||
            process.env.CREWSWARM_CREW_CLI_ENABLED === "1";
          const installed =
            commandExists("crew") ||
            fs.existsSync(path.join(CREWSWARM_DIR, "crew-cli", "dist", "index.js"));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ enabled, installed }));
        } catch {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ enabled: false, installed: false }));
        }
        return;
      }
      if (req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const { enabled } = JSON.parse(body || "{}");
        const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
        cfg.crewCli = enabled === true;
        const writeErr = await safeWriteConfig(cfg);
        if (writeErr) {
          res.writeHead(writeErr.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: writeErr.message }));
          return;
        }
        process.env.CREWSWARM_CREW_CLI_ENABLED = enabled ? "1" : "0";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, enabled: cfg.crewCli }));
        return;
      }
    }
    // ── Crew CLI tier models (L1/L2/L3) — persisted to crewswarm.json env ─────────
    if (url.pathname === "/api/settings/cli-models") {
      const { readFile } = await import("node:fs/promises");
      const CLI_MODEL_KEYS = [
        "CREW_CHAT_MODEL",
        "CREW_ROUTER_MODEL",
        "CREW_REASONING_MODEL",
        "CREW_L2A_MODEL",
        "CREW_L2B_MODEL",
        "CREW_EXECUTION_MODEL",
        "CREW_QA_MODEL",
        "CREW_JSON_REPAIR_MODEL",
        "CREW_MAX_PARALLEL_WORKERS",
        "CREW_L2_EXTRA_VALIDATORS",
      ];
      if (req.method === "GET") {
        try {
          const cfg = JSON.parse(await readFile(CFG_FILE, "utf8"));
          const env = cfg.env || {};
          const result = {};
          for (const k of CLI_MODEL_KEYS) {
            result[k] = env[k] ?? process.env[k] ?? "";
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(err.message) }));
        }
        return;
      }
      if (req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        let updates;
        try {
          updates = JSON.parse(body || "{}");
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }
        try {
          const raw = (() => {
            try {
              return fs.readFileSync(CFG_FILE, "utf8");
            } catch {
              return "{}";
            }
          })();
          const cfg = JSON.parse(raw);
          if (!cfg.env) cfg.env = {};
          for (const k of CLI_MODEL_KEYS) {
            const v = updates[k];
            if (v !== undefined) {
              const s = String(v || "").trim();
              if (s) cfg.env[k] = s;
              else delete cfg.env[k];
            }
          }
          const writeErr = await safeWriteConfig(cfg);
          if (writeErr) {
            res.writeHead(writeErr.status, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: writeErr.message }));
            return;
          }
          for (const k of CLI_MODEL_KEYS) {
            if (updates[k] !== undefined) {
              const s = String(updates[k] || "").trim();
              if (s) process.env[k] = s;
              else delete process.env[k];
            }
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(err.message) }));
        }
        return;
      }
    }
    // ── OpenCode executor toggle ──────────────────────────────────────────────────
    if (url.pathname === "/api/settings/opencode") {
      const { readFile, writeFile } = await import("node:fs/promises");
      const cfgPath = CFG_FILE;
      if (req.method === "GET") {
        try {
          const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
          const env = cfg.env || {};
          const enabled =
            env.CREWSWARM_OPENCODE_ENABLED === "on" ||
            env.CREWSWARM_OPENCODE_ENABLED === "1" ||
            process.env.CREWSWARM_OPENCODE_ENABLED === "on" ||
            process.env.CREWSWARM_OPENCODE_ENABLED === "1";
          const installed =
            commandExists(process.env.CREWSWARM_OPENCODE_BIN || "opencode") ||
            fs.existsSync(path.join(os.homedir(), ".opencode", "bin", "opencode"));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ enabled, installed }));
        } catch {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ enabled: false, installed: false }));
        }
        return;
      }
      if (req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const { enabled } = JSON.parse(body || "{}");
        const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
        if (!cfg.env) cfg.env = {};
        cfg.env.CREWSWARM_OPENCODE_ENABLED = enabled ? "on" : "off";
        const writeErr = await safeWriteConfig(cfg);
        if (writeErr) {
          res.writeHead(writeErr.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: writeErr.message }));
          return;
        }
        process.env.CREWSWARM_OPENCODE_ENABLED = enabled ? "on" : "off";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, enabled }));
        return;
      }
    }
    // ── Global OpenCode loop (Ouroboros) ───────────────────────────────────────
    if (url.pathname === "/api/settings/global-oc-loop") {
      const { readFile, writeFile } = await import("node:fs/promises");
      const cfgPath = CFG_FILE;
      if (req.method === "GET") {
        try {
          const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              enabled: cfg.opencodeLoop ?? false,
              maxRounds: cfg.opencodeLoopMaxRounds ?? 10,
            }),
          );
        } catch (e) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ enabled: false, maxRounds: 10 }));
        }
        return;
      }
      if (req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const { enabled, maxRounds } = JSON.parse(body || "{}");
        const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
        if (enabled !== undefined) cfg.opencodeLoop = enabled;
        if (maxRounds !== undefined) cfg.opencodeLoopMaxRounds = maxRounds;
        const writeErr = await safeWriteConfig(cfg);
        if (writeErr) {
          res.writeHead(writeErr.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: writeErr.message }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
    }
    // ── Autonomous mention routing toggle ────────────────────────────────────
    if (url.pathname === "/api/settings/autonomous-mentions") {
      const { readFile, writeFile } = await import("node:fs/promises");
      const cfgPath = CFG_FILE;
      if (req.method === "GET") {
        try {
          const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
          const enabled = cfg.settings?.autonomousMentionsEnabled !== false;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ enabled }));
        } catch {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ enabled: true }));
        }
        return;
      }
      if (req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const { enabled } = JSON.parse(body || "{}");
        const cfg = JSON.parse(await readFile(cfgPath, "utf8").catch(() => "{}"));
        if (!cfg.settings) cfg.settings = {};
        cfg.settings.autonomousMentionsEnabled = enabled !== false;
        const writeErr = await safeWriteConfig(cfg);
        if (writeErr) {
          res.writeHead(writeErr.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: writeErr.message }));
          return;
        }
        process.env.CREWSWARM_AUTONOMOUS_MENTIONS =
          enabled === false ? "off" : "on";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            enabled: cfg.settings.autonomousMentionsEnabled,
          }),
        );
        return;
      }
    }
    // ── Passthrough notification routing ──────────────────────────────────────
    if (url.pathname === "/api/settings/passthrough-notify") {
      const { readFile, writeFile } = await import("node:fs/promises");
      const cfgPath = CFG_FILE;
      if (req.method === "GET") {
        try {
          const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
          const value = cfg.env?.PASSTHROUGH_NOTIFY || "both";
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ value }));
        } catch {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ value: "both" }));
        }
        return;
      }
      if (req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const { value } = JSON.parse(body || "{}");
        const allowed = ["both", "tg", "wa", "none"];
        const safe = allowed.includes(value) ? value : "both";
        const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
        if (!cfg.env) cfg.env = {};
        cfg.env.PASSTHROUGH_NOTIFY = safe;
        const writeErr = await safeWriteConfig(cfg);
        if (writeErr) {
          res.writeHead(writeErr.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: writeErr.message }));
          return;
        }
        // Also set in process.env so it takes effect without crew-lead restart
        process.env.PASSTHROUGH_NOTIFY = safe;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, value: safe }));
        return;
      }
    }
    // ── Role defaults (dashboard-managed) ─────────────────────────────────────
    if (url.pathname === "/api/settings/role-defaults") {
      const cfgPath = CFG_FILE;
      if (req.method === "GET") {
        try {
          const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
          const roles = cfg.roleToolDefaults || {};
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ roles }));
        } catch (e) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }
      if (req.method === "POST") {
        try {
          let body = "";
          for await (const chunk of req) body += chunk;
          const { roles } = JSON.parse(body || "{}");
          const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
          cfg.roleToolDefaults = roles || {};
          const writeErr = await safeWriteConfig(cfg);
          if (writeErr) {
            res.writeHead(writeErr.status, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: writeErr.message }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }
    }
    // ── Spending caps (dashboard-managed) ────────────────────────────────────
    if (url.pathname === "/api/settings/spending-caps") {
      const cfgPath = CFG_FILE;
      if (req.method === "GET") {
        try {
          const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
          const caps = cfg.globalSpendingCaps || {};
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              dailyTokenLimit: caps.dailyTokenLimit ?? null,
              dailyCostLimitUSD: caps.dailyCostLimitUSD ?? null,
            }),
          );
        } catch (e) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }
      if (req.method === "POST") {
        try {
          let body = "";
          for await (const chunk of req) body += chunk;
          const { dailyTokenLimit, dailyCostLimitUSD } = JSON.parse(
            body || "{}",
          );
          const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
          cfg.globalSpendingCaps = {
            dailyTokenLimit: dailyTokenLimit ?? undefined,
            dailyCostLimitUSD: dailyCostLimitUSD ?? undefined,
          };
          // Remove keys with undefined to keep JSON clean
          if (cfg.globalSpendingCaps.dailyTokenLimit === undefined)
            delete cfg.globalSpendingCaps.dailyTokenLimit;
          if (cfg.globalSpendingCaps.dailyCostLimitUSD === undefined)
            delete cfg.globalSpendingCaps.dailyCostLimitUSD;
          const writeErr = await safeWriteConfig(cfg);
          if (writeErr) {
            res.writeHead(writeErr.status, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: writeErr.message }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }
    }
    // ── Global rules (dashboard-managed, not proxied) ────────────────────────
    if (url.pathname === "/api/settings/global-rules") {
      const rulesPath = path.join(CFG_DIR, "global-rules.md");
      if (req.method === "GET") {
        try {
          const content = fs.existsSync(rulesPath)
            ? fs.readFileSync(rulesPath, "utf8")
            : "";
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ content }));
        } catch (e) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }
      if (req.method === "POST") {
        try {
          let body = "";
          for await (const chunk of req) body += chunk;
          const { content } = JSON.parse(body || "{}");
          fs.writeFileSync(rulesPath, content || "", "utf8");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }
    }
    // ── GET/POST /api/settings/loop-brain ────────────────────────────────────────
    if (url.pathname === "/api/settings/loop-brain") {
      const { readFile, writeFile } = await import("node:fs/promises");
      if (req.method === "GET") {
        try {
          const cfg = JSON.parse(await readFile(CFG_FILE, "utf8"));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ loopBrain: cfg.loopBrain || null }));
        } catch {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ loopBrain: null }));
        }
        return;
      }
      if (req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const { loopBrain } = JSON.parse(body || "{}");
        const cfg = JSON.parse(await readFile(CFG_FILE, "utf8"));
        if (loopBrain) cfg.loopBrain = loopBrain;
        else delete cfg.loopBrain;
        const writeErr = await safeWriteConfig(cfg);
        if (writeErr) {
          res.writeHead(writeErr.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: writeErr.message }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
    }
    // ── Proxy /api/engine-passthrough → crew-lead:5010 (SSE streaming) ─────────
    if (url.pathname === "/api/engine-passthrough" && req.method === "POST") {
      try {
        const rawBody = await (async () => {
          let b = "";
          for await (const c of req) b += c;
          return b;
        })();
        const token = (() => {
          try {
            return (
              JSON.parse(
                fs.readFileSync(
                  path.join(os.homedir(), ".crewswarm", "crewswarm.json"),
                  "utf8",
                ),
              )?.rt?.authToken || ""
            );
          } catch {
            return "";
          }
        })();
        const upstream = await fetch(
          "http://127.0.0.1:5010/api/engine-passthrough",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            body: rawBody,
          },
        );
        res.writeHead(upstream.status, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "access-control-allow-origin": "*",
        });
        // Stream SSE chunks straight through
        const reader = upstream.body.getReader();
        const pump = async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                try {
                  res.end();
                } catch { }
                break;
              }
              try {
                res.write(value);
              } catch {
                reader.cancel();
                break;
              }
            }
          } catch { }
        };
        pump();
        req.on("close", () => {
          try {
            reader.cancel();
          } catch { }
        });
      } catch (e) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({ type: "done", exitCode: 1, error: e.message })}\n\n`,
        );
        res.end();
      }
      return;
    }
    // ── Proxy /api/settings/global-fallback → crew-lead:5010 ─────────────────
    if (url.pathname === "/api/settings/global-fallback") {
      try {
        const rawBody =
          req.method === "POST"
            ? await (async () => {
              let b = "";
              for await (const c of req) b += c;
              return b;
            })()
            : null;
        const token = (() => {
          try {
            return (
              JSON.parse(
                fs.readFileSync(
                  path.join(os.homedir(), ".crewswarm", "crewswarm.json"),
                  "utf8",
                ),
              )?.rt?.authToken || ""
            );
          } catch {
            return "";
          }
        })();
        const r = await fetch(
          "http://127.0.0.1:5010/api/settings/global-fallback",
          {
            method: req.method,
            headers: {
              "content-type": "application/json",
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            ...(rawBody ? { body: rawBody } : {}),
            signal: AbortSignal.timeout(8000),
          },
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(await r.text());
      } catch (e) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: "crew-lead unreachable: " + e.message,
          }),
        );
      }
      return;
    }
    if (
      url.pathname === "/api/settings/openclaw-status" &&
      req.method === "GET"
    ) {
      const deviceJson = path.join(
        os.homedir(),
        ".openclaw",
        "devices",
        "paired.json",
      );
      const deviceJsonAlt = path.join(os.homedir(), ".openclaw", "device.json");
      const installed =
        fs.existsSync(deviceJson) || fs.existsSync(deviceJsonAlt);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, installed }));
      return;
    }
    // ── crew-lead chat API ────────────────────────────────────────────────────
    if (url.pathname === "/api/crew-lead/status" && req.method === "GET") {
      try {
        let online = false;
        try {
          const health = await fetch("http://127.0.0.1:5010/health", {
            signal: AbortSignal.timeout(1500),
          });
          online = health.ok;
        } catch { }
        if (!online) {
          const { execSync: es } = await import("node:child_process");
          es("pgrep -f 'crew-lead.mjs'", {
            encoding: "utf8",
            timeout: 2000,
            stdio: "pipe",
          });
          online = true;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, online }));
      } catch {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, online: false }));
      }
      return;
    }

    // ── Models API (list available models for crewchat dropdown) ─────────────
    if (url.pathname === "/api/models" && req.method === "GET") {
      try {
        const csSwarm = JSON.parse(
          fs.readFileSync(
            path.join(os.homedir(), ".crewswarm", "crewswarm.json"),
            "utf8",
          ),
        );
        const providers = csSwarm.providers || {};
        const models = [];

        // Featured models (top picks) - will be shown first
        const featuredIds = [
          "opencode/claude-sonnet-4-5",
          "anthropic/claude-sonnet-4-5-20250929",
          "google/gemini-2.5-flash",
          "google/gemini-exp-1206",
          "google/gemini-2.0-pro-exp",
          "groq/llama-3.3-70b-versatile",
          "deepseek/deepseek-chat",
          "nvidia/deepseek-ai/deepseek-coder-6.7b-instruct",
          "perplexity/sonar",
          "perplexity/sonar-pro",
          "openai/gpt-5.3-codex",
        ];

        // Build a comprehensive model list from providers that have stored models
        for (const [providerId, providerData] of Object.entries(providers)) {
          if (!providerData.apiKey) continue; // Skip providers without API keys

          // If provider has a models array (from fetch-models), use those
          if (
            Array.isArray(providerData.models) &&
            providerData.models.length > 0
          ) {
            for (const modelInfo of providerData.models) {
              const modelId = modelInfo.id || modelInfo.name;
              if (modelId) {
                const fullId = `${providerId}/${modelId}`;
                models.push({
                  id: fullId,
                  provider: providerId,
                  model: modelId,
                  name: modelInfo.name || modelId,
                  ready: true,
                  featured: featuredIds.includes(fullId),
                });
              }
            }
          }
        }

        // Also add models currently used by agents (in case they're not in provider.models)
        const seenModels = new Set(models.map((m) => m.id));
        if (csSwarm.agents) {
          for (const agent of csSwarm.agents) {
            if (agent.model && !seenModels.has(agent.model)) {
              seenModels.add(agent.model);
              const [provider, ...modelParts] = agent.model.split("/");
              const modelId = modelParts.join("/");
              if (providers[provider]?.apiKey) {
                models.push({
                  id: agent.model,
                  provider: provider,
                  model: modelId,
                  ready: true,
                  featured: featuredIds.includes(agent.model),
                });
              }
            }
          }
        }

        // Sort: featured first, then alphabetically
        models.sort((a, b) => {
          if (a.featured && !b.featured) return -1;
          if (!a.featured && b.featured) return 1;
          return a.id.localeCompare(b.id);
        });

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err.message, models: [] }));
      }
      return;
    }

    // ── CLI Chat API (crewchat CLI mode passthrough) ──────────────────────
    if (url.pathname === "/api/cli/chat" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const { engine, message, sessionId, model, projectId } =
          JSON.parse(body);
        if (!engine || !message) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ ok: false, error: "engine and message required" }),
          );
          return;
        }

        const crewLeadPort = process.env.CREW_LEAD_PORT || "5010";
        const clAuthToken = resolveCrewLeadAuthToken();

        let projectDir = null;
        if (projectId) {
          try {
            const registryFile = path.join(CFG_DIR, "projects.json");
            const projects = fs.existsSync(registryFile)
              ? JSON.parse(fs.readFileSync(registryFile, "utf8"))
              : {};
            projectDir = projects?.[projectId]?.outputDir || null;
          } catch { }
        }

        const clRes = await fetch(
          `http://127.0.0.1:${crewLeadPort}/api/engine-passthrough`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(clAuthToken ? { authorization: `Bearer ${clAuthToken}` } : {}),
            },
            body: JSON.stringify({
              engine,
              message,
              sessionId: sessionId || "cli",
              ...(model ? { model } : {}),
              ...(projectId ? { projectId } : {}),
              ...(projectDir ? { projectDir } : {}),
            }),
            signal: AbortSignal.timeout(240000),
          },
        );

        if (!clRes.ok || !clRes.body) {
          const txt = await clRes.text().catch(() => "");
          res.writeHead(clRes.status || 500, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: txt || `crew-lead passthrough failed (${clRes.status})`,
            }),
          );
          return;
        }

        const reader = clRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let output = "";
        let stderr = "";
        let exitCode = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() || "";
          for (const event of events) {
            const dataLine = event
              .split("\n")
              .find((line) => line.startsWith("data: "));
            if (!dataLine) continue;
            try {
              const payload = JSON.parse(dataLine.slice(6));
              if (payload.type === "chunk" && payload.text) {
                output += payload.text;
              } else if (payload.type === "stderr" && payload.text) {
                stderr += payload.text;
              } else if (payload.type === "done") {
                exitCode = Number(payload.exitCode || 0);
              }
            } catch { }
          }
        }

        const finalOutput = (output || stderr || "(no output)").trim();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: exitCode === 0,
            output: finalOutput,
            exitCode,
            engine,
          }),
        );
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // ── Agent Chat API (Dashboard direct agent chat like TG topics) ─────────────
    if (url.pathname === "/api/agent-chat" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;

      try {
        const { agentId, message, sessionId, projectId } = JSON.parse(body);
        if (!agentId || !message) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "agentId and message required" }));
          return;
        }

        // Load agent config
        const csSwarm = JSON.parse(
          fs.readFileSync(
            path.join(os.homedir(), ".crewswarm", "crewswarm.json"),
            "utf8",
          ),
        );
        const agent = csSwarm.agents?.find((a) => a.id === agentId);
        if (!agent?.model) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: `Agent ${agentId} not found or has no model`,
            }),
          );
          return;
        }

        // Parse model string
        const [providerKey, ...modelParts] = agent.model.split("/");
        let modelId = modelParts.join("/");
        const provider = csSwarm.providers?.[providerKey];
        if (!provider?.apiKey) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ error: `No API key for provider ${providerKey}` }),
          );
          return;
        }
        // OpenRouter requires full ID (e.g. openrouter/hunter-alpha), not bare "hunter-alpha"
        if ((providerKey === "openrouter" || (provider.baseUrl || "").includes("openrouter.ai")) && modelId && !modelId.startsWith("openrouter/")) {
          modelId = "openrouter/" + modelId;
        }

        // Load system prompt
        const promptPath = path.join(
          os.homedir(),
          ".crewswarm",
          "agent-prompts.json",
        );
        let systemPrompt = `You are ${agentId}.`;
        try {
          const prompts = JSON.parse(fs.readFileSync(promptPath, "utf8"));
          const bareId = agentId.replace(/^crew-/, "");
          systemPrompt = prompts[agentId] || prompts[bareId] || systemPrompt;
        } catch { }

        // Call LLM
        const messages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: message },
        ];

        const llmRes = await fetch(
          `${provider.baseUrl || `https://api.openai.com/v1`}/chat/completions`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${provider.apiKey}`,
            },
            body: JSON.stringify({
              model: modelId,
              messages,
              temperature: 0.7,
              // Reasoning models (o1/o3/gpt-5 series) don't support max_tokens parameter
              ...(/^(o1|o3|gpt-5)/i.test(modelId) ? {} : { max_tokens: 2000 }),
            }),
            signal: AbortSignal.timeout(60000),
          },
        );

        if (!llmRes.ok) {
          res.writeHead(llmRes.status, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ error: `LLM call failed: ${llmRes.statusText}` }),
          );
          return;
        }

        const llmData = await llmRes.json();
        const reply = llmData.choices?.[0]?.message?.content || "(no response)";

        // Save to unified project messages when projectId provided
        if (projectId && projectId !== "general") {
          try {
            const { saveProjectMessage } =
              await import("../lib/chat/project-messages.mjs");
            saveProjectMessage(projectId, {
              source: "agent",
              role: "user",
              content: message,
              agent: null,
              metadata: { agentId },
            });
            saveProjectMessage(projectId, {
              source: "agent",
              role: "assistant",
              content: reply,
              agent: agentId,
              metadata: { model: agent?.model },
            });
          } catch (e) {
            console.warn(
              "[dashboard] agent-chat (2) save to project messages:",
              e.message,
            );
          }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ reply }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ── Chat Agent API (crewchat direct agent chat) ──────────────────────────
    if (url.pathname === "/api/chat-agent" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const crewLeadPort = process.env.CREW_LEAD_PORT || "5010";

      const clAuthToken = resolveCrewLeadAuthToken();

      try {
        const clRes = await fetch(
          `http://127.0.0.1:${crewLeadPort}/api/chat-agent`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(clAuthToken
                ? { authorization: `Bearer ${clAuthToken}` }
                : {}),
            },
            body,
            signal: AbortSignal.timeout(200000),
          },
        );

        const text = await clRes.text();
        let clData;
        try {
          clData = JSON.parse(text);
        } catch {
          clData = { ok: false, error: text.slice(0, 200) || clRes.statusText };
        }

        res.writeHead(clRes.ok ? 200 : clRes.status, {
          "content-type": "application/json",
        });
        res.end(JSON.stringify(clData));
      } catch (e) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: "crew-lead unreachable: " + (e?.message || String(e)),
          }),
        );
      }
      return;
    }

    // ── Dispatch API (crewchat agent direct mode) ─────────────────────────────
    if (url.pathname === "/api/dispatch" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const crewLeadPort = process.env.CREW_LEAD_PORT || "5010";

      const clAuthToken = resolveCrewLeadAuthToken();

      try {
        // Forward to crew-lead's /api/dispatch endpoint (not /dispatch!)
        const clRes = await fetch(
          `http://127.0.0.1:${crewLeadPort}/api/dispatch`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(clAuthToken
                ? { authorization: `Bearer ${clAuthToken}` }
                : {}),
            },
            body,
            signal: AbortSignal.timeout(200000),
          },
        );

        const text = await clRes.text();
        let clData;
        try {
          clData = JSON.parse(text);
        } catch {
          clData = { ok: false, error: text.slice(0, 200) || clRes.statusText };
        }

        res.writeHead(clRes.ok ? 200 : clRes.status, {
          "content-type": "application/json",
        });
        res.end(JSON.stringify(clData));
      } catch (e) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: "crew-lead unreachable: " + (e?.message || String(e)),
          }),
        );
      }
      return;
    }

    // ── Multimodal API endpoints ───────────────────────────────────────────
    if (url.pathname === "/api/analyze-image" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const { image, prompt } = JSON.parse(body);
        const { analyzeImage } =
          await import("../lib/integrations/multimodal.mjs");
        const result = await analyzeImage(
          image,
          prompt || "Describe this image in detail.",
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (url.pathname === "/api/transcribe-audio" && req.method === "POST") {
      // Expects multipart/form-data with audio file (crewchat: m4a, Dashboard: webm)
      // Per Groq docs: https://console.groq.com/docs/speech-to-text — file, model required
      const sendJson = (status, body) => {
        if (res.headersSent) return;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      try {
        const busboy = await import("busboy");
        const chunks = [];
        let mimeType = "audio/m4a"; // crewchat default
        let resolved = false;
        const resolveOnce = () => {
          if (resolved) return;
          resolved = true;
        };
        const bb = busboy.default({ headers: req.headers });
        bb.on("file", (name, file, info) => {
          if (info?.mimeType) mimeType = info.mimeType;
          file.on("data", (data) => chunks.push(data));
        });
        bb.on("error", (err) => {
          sendJson(500, { ok: false, error: err.message });
          resolveOnce();
        });
        req.on("error", (err) => {
          sendJson(500, { ok: false, error: err.message });
          resolveOnce();
        });
        bb.on("finish", async () => {
          try {
            const audioBuffer = Buffer.concat(chunks);
            if (audioBuffer.length === 0) {
              sendJson(400, { ok: false, error: "No audio data received" });
              resolveOnce();
              return;
            }
            const { transcribeAudio } =
              await import("../lib/integrations/multimodal.mjs");
            const transcription = await transcribeAudio(audioBuffer, { mimeType });
            sendJson(200, { ok: true, transcription: transcription || "" });
          } catch (err) {
            sendJson(500, { ok: false, error: err.message });
          }
          resolveOnce();
        });
        req.pipe(bb);
      } catch (err) {
        sendJson(500, { ok: false, error: err.message });
      }
      return;
    }

    async function proxyCrewLeadChat({
      rawBody,
      projectIdFromQuery = null,
      defaultMode = "crew-lead",
    }) {
      const crewLeadPort = process.env.CREW_LEAD_PORT || "5010";
      let parsed = {};
      try {
        parsed = JSON.parse(rawBody || "{}");
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
        return true;
      }

      if (projectIdFromQuery && projectIdFromQuery !== "null" && !parsed.projectId) {
        parsed.projectId = projectIdFromQuery;
      }

      const {
        mode = defaultMode,
        message,
        sessionId = "owner",
        projectId,
        agentId,
        engine,
        projectDir,
        model,
        injectHistory,
        channelMode,
      } = parsed;

      if (!message || !String(message).trim()) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "message required" }));
        return true;
      }

      const clAuthToken = resolveCrewLeadAuthToken();
      let resolvedProjectDir = projectDir || null;
      if (!resolvedProjectDir && projectId) {
        try {
          const registryFile = path.join(CFG_DIR, "projects.json");
          const projects = fs.existsSync(registryFile)
            ? JSON.parse(fs.readFileSync(registryFile, "utf8"))
            : {};
          resolvedProjectDir = projects?.[projectId]?.outputDir || null;
        } catch { }
      }

      if (mode === "cli" || String(mode).startsWith("cli:")) {
        const cliEngine = engine || String(mode).replace(/^cli:/, "");
        if (!cliEngine) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: "engine required for cli mode",
            }),
          );
          return true;
        }
        try {
          const payload = {
            engine: cliEngine,
            message,
            sessionId,
            ...(projectId ? { projectId } : {}),
            ...(resolvedProjectDir ? { projectDir: resolvedProjectDir } : {}),
            ...(model ? { model } : {}),
            ...(injectHistory ? { injectHistory: true } : {}),
          };

          const upstream = await fetch(
            `http://127.0.0.1:${listenPort}/api/engine-passthrough`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
              signal: AbortSignal.timeout(240000),
            },
          ).catch(() => null);

          if (!upstream || !upstream.body || !upstream.ok) {
            const status = upstream?.status || 503;
            const txt = upstream
              ? await upstream.text().catch(() => "")
              : "unreachable";
            res.writeHead(status, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                ok: false,
                error: `cli upstream failed: ${txt || status}`,
              }),
            );
            return true;
          }

          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
            "access-control-allow-origin": "*",
          });
          const reader = upstream.body.getReader();
          req.on("close", () => reader.cancel().catch(() => { }));
          (async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(value);
              }
            } catch {
            } finally {
              res.end();
            }
          })();
          return true;
        } catch (e) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ ok: false, error: e?.message || String(e) }),
          );
          return true;
        }
      }

      if (mode === "agent") {
        if (!agentId) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: "agentId required for agent mode",
            }),
          );
          return true;
        }
        const wantAgentSSE = String(req.headers.accept || "").includes("text/event-stream");
        const agentEndpoint = wantAgentSSE ? "/chat/stream" : "/chat";
        try {
          const upstream = await fetch(
            `http://127.0.0.1:${crewLeadPort}${agentEndpoint}`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...(clAuthToken
                  ? { authorization: `Bearer ${clAuthToken}` }
                  : {}),
              },
              body: JSON.stringify({
                agentId,
                message,
                sessionId,
                ...(projectId ? { projectId } : {}),
                ...(resolvedProjectDir ? { projectDir: resolvedProjectDir } : {}),
              }),
              signal: AbortSignal.timeout(120000),
            },
          );
          if (!upstream.ok) {
            const txt = upstream
              ? await upstream.text().catch(() => "")
              : "unreachable";
            res.writeHead(upstream?.status || 503, {
              "content-type": "application/json",
            });
            res.end(
              JSON.stringify({
                ok: false,
                error: `agent ${wantAgentSSE ? "stream" : "chat"} failed: ${txt || upstream?.status}`,
              }),
            );
            return true;
          }

          if (wantAgentSSE && upstream.body) {
            // SSE streaming path (Dashboard or Vibe)
            res.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "keep-alive",
              "access-control-allow-origin": "*",
            });
            const reader = upstream.body.getReader();
            req.on("close", () => reader.cancel().catch(() => {}));
            (async () => {
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  res.write(value);
                }
              } catch {
              } finally {
                res.end();
              }
            })();
          } else {
            // JSON path (Dashboard frontend)
            const agentCT = String(upstream.headers.get("content-type") || "");
            if (agentCT.includes("text/event-stream") && upstream.body) {
              // crew-lead returned SSE but caller wanted JSON — extract final reply
              const rawSSE = await upstream.text().catch(() => "");
              let reply = "";
              for (const line of rawSSE.split("\n")) {
                if (!line.startsWith("data: ")) continue;
                try {
                  const ev = JSON.parse(line.slice(6));
                  if (ev.type === "done" && ev.transcript) reply = ev.transcript;
                  else if (ev.type === "chat_message" && ev.content) reply = ev.content;
                  else if (ev.type === "chunk" && ev.text) reply += ev.text;
                } catch {}
              }
              res.writeHead(200, {
                "content-type": "application/json",
                "access-control-allow-origin": "*",
              });
              res.end(JSON.stringify({ ok: true, reply: reply || "(no reply)" }));
            } else {
              const data = await upstream.json().catch(() => ({}));
              res.writeHead(200, {
                "content-type": "application/json",
                "access-control-allow-origin": "*",
              });
              res.end(JSON.stringify(data));
            }
          }
          return true;
        } catch (e) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: "crew-lead unreachable: " + (e?.message || String(e)),
            }),
          );
          return true;
        }
      }

      // crew-lead mode — SSE if caller accepts it, JSON otherwise
      const wantSSE = String(req.headers.accept || "").includes("text/event-stream");
      const chatEndpoint = wantSSE ? "/chat/stream" : "/chat";
      try {
        const upstream = await fetch(`http://127.0.0.1:${crewLeadPort}${chatEndpoint}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(clAuthToken ? { authorization: `Bearer ${clAuthToken}` } : {}),
          },
          body: JSON.stringify({
            message,
            sessionId,
            ...(projectId ? { projectId } : {}),
            ...(resolvedProjectDir ? { projectDir: resolvedProjectDir } : {}),
            ...(channelMode ? { channelMode: true } : {}),
          }),
          signal: AbortSignal.timeout(200000),
        });
        if (!upstream.ok) {
          const txt = upstream
            ? await upstream.text().catch(() => "")
            : "unreachable";
          res.writeHead(upstream?.status || 503, {
            "content-type": "application/json",
          });
          res.end(
            JSON.stringify({
              ok: false,
              error: `crew-lead ${wantSSE ? "stream" : "chat"} failed: ${txt || upstream?.status}`,
            }),
          );
          return true;
        }

        if (wantSSE && upstream.body) {
          // SSE streaming path (Dashboard or Vibe)
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
            "access-control-allow-origin": "*",
          });
          const reader = upstream.body.getReader();
          req.on("close", () => reader.cancel().catch(() => {}));
          (async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(value);
              }
            } catch {
            } finally {
              res.end();
            }
          })();
        } else {
          // JSON path (Dashboard frontend)
          const upstreamCT = String(upstream.headers.get("content-type") || "");
          if (upstreamCT.includes("text/event-stream") && upstream.body) {
            // crew-lead returned SSE but caller wanted JSON — extract final reply
            const rawSSE = await upstream.text().catch(() => "");
            let reply = "";
            for (const line of rawSSE.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              try {
                const ev = JSON.parse(line.slice(6));
                if (ev.type === "done" && ev.transcript) reply = ev.transcript;
                else if (ev.type === "chat_message" && ev.content) reply = ev.content;
                else if (ev.type === "chunk" && ev.text) reply += ev.text;
              } catch {}
            }
            res.writeHead(200, {
              "content-type": "application/json",
              "access-control-allow-origin": "*",
            });
            res.end(JSON.stringify({ ok: true, reply: reply || "(no reply)" }));
          } else {
            const data = await upstream.json().catch(() => ({}));
            res.writeHead(200, {
              "content-type": "application/json",
              "access-control-allow-origin": "*",
            });
            res.end(JSON.stringify(data));
          }
        }
      } catch (e) {
        console.error(
          `[dashboard] proxyCrewLeadChat error: ${e?.message || String(e)}`,
        );
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: "crew-lead unreachable: " + (e?.message || String(e)),
          }),
        );
      }
      return true;
    }

    if (url.pathname === "/api/chat/unified" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      await proxyCrewLeadChat({ rawBody: body });
      return;
    }

    if (url.pathname === "/api/crew-lead/chat" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      await proxyCrewLeadChat({
        rawBody: body,
        projectIdFromQuery: url.searchParams.get("projectId"),
      });
      return;
    }
    if (url.pathname === "/api/crew-lead/clear" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const crewLeadPort = process.env.CREW_LEAD_PORT || "5010";
      const clAuthToken2 = resolveCrewLeadAuthToken();
      const clRes = await fetch(`http://127.0.0.1:${crewLeadPort}/clear`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(clAuthToken2 ? { authorization: `Bearer ${clAuthToken2}` } : {}),
        },
        body,
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/api/crew-lead/events" && req.method === "GET") {
      const crewLeadPort = process.env.CREW_LEAD_PORT || "5010";
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "access-control-allow-origin": "*",
      });
      res.write("retry: 3000\n\n");
      // Proxy SSE from crew-lead
      const upstream = await fetch(`http://127.0.0.1:${crewLeadPort}/events`, {
        signal: req.socket.destroyed ? AbortSignal.abort() : undefined,
      }).catch(() => null);
      if (!upstream?.body) {
        res.end();
        return;
      }
      const reader = upstream.body.getReader();
      req.on("close", () => reader.cancel());
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        } catch {
        } finally {
          res.end();
        }
      })();
      return;
    }
    if (url.pathname === "/api/crew-lead/history" && req.method === "GET") {
      const crewLeadPort = process.env.CREW_LEAD_PORT || "5010";
      const sessionId = url.searchParams.get("sessionId") || "owner";
      const projectId = url.searchParams.get("projectId");

      console.log(
        "[dashboard] /api/crew-lead/history - sessionId:",
        sessionId,
        "projectId:",
        projectId || "(none)",
      );

      const token = resolveCrewLeadAuthToken();

      // Build crew-lead URL with both sessionId and projectId
      let clUrl = `http://127.0.0.1:${crewLeadPort}/api/crew-lead/history?sessionId=${encodeURIComponent(sessionId)}`;
      if (projectId) {
        clUrl += `&projectId=${encodeURIComponent(projectId)}`;
      }

      console.log("[dashboard] Forwarding to crew-lead:", clUrl);

      const clRes = await fetch(clUrl, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);
      if (!clRes || !clRes.ok) {
        console.log(
          "[dashboard] crew-lead request failed, status:",
          clRes?.status || "timeout",
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, history: [] }));
        return;
      }
      const clData = await clRes.json();
      console.log(
        "[dashboard] Got response, history count:",
        clData.history?.length || 0,
        "projectId:",
        clData.projectId,
      );
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-cache, no-store, must-revalidate",
        pragma: "no-cache",
        expires: "0",
      });
      res.end(JSON.stringify(clData));
      return;
    }

    // Proxy /api/crew-lead/project-messages to crew-lead
    if (
      url.pathname === "/api/crew-lead/project-messages" &&
      req.method === "GET"
    ) {
      const crewLeadPort = process.env.CREW_LEAD_PORT || "5010";
      const projectId = url.searchParams.get("projectId");
      const limit = url.searchParams.get("limit") || "100";
      const source = url.searchParams.get("source");

      console.log(
        "[dashboard] /api/crew-lead/project-messages - projectId:",
        projectId,
        "limit:",
        limit,
      );

      if (!projectId) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "projectId required" }));
        return;
      }

      const token = resolveCrewLeadAuthToken();

      // Build crew-lead URL
      let clUrl = `http://127.0.0.1:${crewLeadPort}/api/crew-lead/project-messages?projectId=${encodeURIComponent(projectId)}&limit=${encodeURIComponent(limit)}`;
      if (source) {
        clUrl += `&source=${encodeURIComponent(source)}`;
      }

      console.log("[dashboard] Forwarding to crew-lead:", clUrl);

      const clRes = await fetch(clUrl, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);

      if (!clRes || !clRes.ok) {
        const status = clRes?.status || "timeout";
        console.error(
          "[dashboard] crew-lead /project-messages failed:",
          status,
          "- crew-lead may be down",
        );
        res.writeHead(503, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: `crew-lead unavailable (${status})`,
            messages: [],
          }),
        );
        return;
      }

      const clData = await clRes.json();
      console.log(
        "[dashboard] Got response, message count:",
        clData.messages?.length || 0,
        "projectId:",
        clData.projectId,
      );

      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-cache, no-store, must-revalidate",
        pragma: "no-cache",
        expires: "0",
      });
      res.end(JSON.stringify(clData));
      return;
    }

    if (
      url.pathname === "/api/crew-lead/confirm-project" &&
      req.method === "POST"
    ) {
      let body = "";
      for await (const chunk of req) body += chunk;
      const crewLeadPort = process.env.CREW_LEAD_PORT || "5010";
      const clRes = await fetch(
        `http://127.0.0.1:${crewLeadPort}/confirm-project`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(15000),
        },
      );
      const clData = await clRes.json();
      res.writeHead(clRes.status, { "content-type": "application/json" });
      res.end(JSON.stringify(clData));
      return;
    }
    if (
      url.pathname === "/api/crew-lead/discard-project" &&
      req.method === "POST"
    ) {
      let body = "";
      for await (const chunk of req) body += chunk;
      const crewLeadPort = process.env.CREW_LEAD_PORT || "5010";
      await fetch(`http://127.0.0.1:${crewLeadPort}/discard-project`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // ── Folder picker (native macOS) ──────────────────────────────────────
    if (url.pathname === "/api/pick-folder" && req.method === "GET") {
      const { execSync: es } = await import("node:child_process");
      const defaultPath = url.searchParams.get("default") || os.homedir();
      try {
        const script = `tell application "Finder" to set f to (choose folder with prompt "Select project folder:" default location POSIX file "${defaultPath}") \nreturn POSIX path of f`;
        const chosen = es(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
          encoding: "utf8",
          timeout: 30000,
        }).trim();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, path: chosen }));
      } catch {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, path: "" }));
      }
      return;
    }
    // ── Providers API ─────────────────────────────────────────────────────
    if (url.pathname === "/api/providers" && req.method === "GET") {
      const { readFile } = await import("node:fs/promises");
      const cfgPath = CFG_FILE;
      const cfg = JSON.parse(await readFile(cfgPath, "utf8").catch(() => "{}"));
      // Support both locations: legacy/openclaw used top-level "providers", dashboard also uses "models.providers"
      const providerMap = cfg?.models?.providers || cfg?.providers || {};
      const providers = Object.entries(providerMap).map(([id, p]) => {
        const key = p.apiKey || "";
        const masked =
          key.length > 8
            ? key.slice(0, 4) +
            "•".repeat(Math.min(key.length - 8, 20)) +
            key.slice(-4)
            : key.length > 0
              ? "•".repeat(key.length)
              : "";
        return {
          id,
          baseUrl: p.baseUrl || "",
          hasKey: key.length > 0,
          maskedKey: masked,
          models: p.models || [],
          api: p.api || "openai-completions",
        };
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, providers }));
      return;
    }
    if (url.pathname === "/api/providers/save" && req.method === "POST") {
      const { readFile, writeFile } = await import("node:fs/promises");
      let body = "";
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
        return;
      }
      const vr = validate(ProviderSaveSchema, parsed);
      if (!vr.ok) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: vr.error }));
        return;
      }
      const { providerId, apiKey } = vr.data;
      const cfgPath = CFG_FILE;
      const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
      const fromModels = cfg?.models?.providers?.[providerId];
      const fromTop = cfg?.providers?.[providerId];
      if (!fromModels && !fromTop)
        throw new Error("Provider not found: " + providerId);
      if (fromTop) {
        cfg.providers[providerId].apiKey = apiKey;
      }
      if (fromModels) {
        cfg.models.providers[providerId].apiKey = apiKey;
      }
      if (!fromModels && fromTop) {
        if (!cfg.models) cfg.models = {};
        if (!cfg.models.providers) cfg.models.providers = {};
        cfg.models.providers[providerId] = {
          ...cfg.providers[providerId],
          apiKey,
        };
      }
      const writeErr = await safeWriteConfig(cfg);
      if (writeErr) {
        res.writeHead(writeErr.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: writeErr.message }));
        return;
      }
      // Sync to ~/.crewswarm/crewswarm.json
      try {
        const cs = readCSConfig();
        if (!cs.providers) cs.providers = {};
        const baseUrl =
          (fromModels || fromTop)?.baseUrl || BUILTIN_URLS[providerId] || "";
        cs.providers[providerId] = {
          ...(cs.providers[providerId] || {}),
          apiKey,
          baseUrl,
        };
        writeCSConfig(cs);
      } catch { }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/api/providers/add" && req.method === "POST") {
      const { readFile, writeFile } = await import("node:fs/promises");
      let body = "";
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
        return;
      }
      const vr = validate(ProviderAddSchema, parsed);
      if (!vr.ok) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: vr.error }));
        return;
      }
      const { id, baseUrl, apiKey, api } = vr.data;
      const cfgPath = CFG_FILE;
      const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
      if (!cfg.models) cfg.models = {};
      if (!cfg.models.providers) cfg.models.providers = {};
      cfg.models.providers[id] = {
        baseUrl,
        apiKey: apiKey || "",
        api: api || "openai-completions",
        models: [],
      };
      const writeErr = await safeWriteConfig(cfg);
      if (writeErr) {
        res.writeHead(writeErr.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: writeErr.message }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (
      url.pathname === "/api/providers/fetch-models" &&
      req.method === "POST"
    ) {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { providerId } = JSON.parse(body);
      const { readFile, writeFile } = await import("node:fs/promises");
      const cfgPath = CFG_FILE;
      const cfg = JSON.parse(await readFile(cfgPath, "utf8").catch(() => "{}"));
      const provider =
        cfg?.models?.providers?.[providerId] || cfg?.providers?.[providerId];
      if (!provider) throw new Error("Provider not found: " + providerId);
      const key = provider.apiKey;
      const baseUrl = (provider.baseUrl || "").replace(/\/$/, "");
      // Ollama is keyless — fetch directly from /api/tags and return the model list
      if (providerId === "ollama" || baseUrl.includes("11434")) {
        try {
          const r = await fetch("http://localhost:11434/api/tags", {
            signal: AbortSignal.timeout(5000),
          });
          const d = await r.json();
          const models = (d.models || []).map((m) => ({
            id: m.name,
            name: m.name,
          }));
          if (provider) {
            if (cfg.models?.providers?.[providerId])
              cfg.models.providers[providerId].models = models;
            if (cfg.providers?.[providerId])
              cfg.providers[providerId].models = models;
            const cfgWriteErr = await safeWriteConfig(cfg);
            if (cfgWriteErr) {
              res.writeHead(cfgWriteErr.status, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: cfgWriteErr.message }));
              return;
            }
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              models: models.map((m) => m.id),
              count: models.length,
            }),
          );
        } catch (e) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: "Ollama not reachable: " + e.message,
            }),
          );
        }
        return;
      }
      if (!key) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "No API key set" }));
        return;
      }
      const isSlowProvider =
        providerId === "nvidia" ||
        (provider.baseUrl || "").includes("nvidia.com");
      const isFetchAnthropic =
        providerId === "anthropic" || baseUrl.includes("anthropic.com");
      const isPerplexity =
        (providerId && providerId.toLowerCase() === "perplexity") ||
        (baseUrl && baseUrl.toLowerCase().includes("perplexity"));
      const isXai =
        (providerId && providerId.toLowerCase() === "xai") ||
        (baseUrl && baseUrl.toLowerCase().includes("x.ai"));
      const isOpenRouter =
        (providerId && providerId.toLowerCase() === "openrouter") ||
        (baseUrl && baseUrl.toLowerCase().includes("openrouter.ai"));
      // Perplexity: fetch from /v1/models; xAI: fetch from /models; both fallback when empty
      // OpenRouter: try API first; if empty/fail, use known list (Hunter Alpha, Claude, GPT-4, etc.)
      // Default returns text-only (~350); output_modalities=all returns text+image+audio (~382)
      if (isOpenRouter) {
        try {
          const r = await fetch(`${baseUrl}/models?output_modalities=all`, {
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
            signal: AbortSignal.timeout(15000),
          });
          const d = await r.json().catch(() => ({}));
          let rawModels = d.data || d.models || [];
          if (rawModels.length === 0) throw new Error("Empty response");
          const models = rawModels
            .filter((m) => m.id || m.name)
            .map((m) => ({ id: m.id || m.name, name: m.name || m.id }))
            .sort((a, b) => a.id.localeCompare(b.id));
          provider.models = models;
          if (cfg.models?.providers?.[providerId]) cfg.models.providers[providerId].models = models;
          if (cfg.providers?.[providerId]) cfg.providers[providerId].models = models;
          const writeErr = await safeWriteConfig(cfg);
          if (writeErr) {
            res.writeHead(writeErr.status, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: writeErr.message }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, models: models.map((m) => m.id), count: models.length }));
        } catch (e) {
          const knownModels = [
            { id: "openrouter/hunter-alpha", name: "Hunter Alpha (1T params, 1M context)" },
            { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4" },
            { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet" },
            { id: "openai/gpt-4o", name: "GPT-4o" },
            { id: "openai/gpt-4o-mini", name: "GPT-4o Mini" },
            { id: "google/gemini-2.0-flash-001", name: "Gemini 2.0 Flash" },
            { id: "google/gemini-2.5-flash-preview", name: "Gemini 2.5 Flash" },
            { id: "meta-llama/llama-4-scout-17b-16e-instruct", name: "Llama 4 Scout 17B" },
            { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B" },
            { id: "deepseek/deepseek-chat-v3-0324", name: "DeepSeek Chat V3" },
            { id: "mistralai/mistral-large-2411", name: "Mistral Large" },
          ];
          provider.models = knownModels;
          if (cfg.models?.providers?.[providerId]) cfg.models.providers[providerId].models = knownModels;
          if (cfg.providers?.[providerId]) cfg.providers[providerId].models = knownModels;
          const writeErr = await safeWriteConfig(cfg);
          if (writeErr) {
            res.writeHead(writeErr.status, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: writeErr.message }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            ok: true,
            models: knownModels.map((m) => m.id),
            count: knownModels.length,
            note: "OpenRouter API unreachable; built-in model list used. Includes Hunter Alpha.",
          }));
        }
        return;
      }
      const isGoogle =
        providerId === "google" || baseUrl.includes("googleapis.com");
      const fetchHeaders = isFetchAnthropic
        ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
        : isGoogle
          ? { "x-goog-api-key": key, "content-type": "application/json" }
          : {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
          };
      const modelsUrl = isGoogle
        ? `${baseUrl}/models?key=${key}`
        : isPerplexity
          ? `${baseUrl.replace(/\/$/, "")}/v1/models`
          : `${baseUrl}/models`;
      try {
        const modelsRes = await fetch(modelsUrl, {
          headers: fetchHeaders,
          signal: AbortSignal.timeout(isSlowProvider ? 30000 : 12000),
        });
        if (modelsRes.status === 404) {
          // Provider has no /models endpoint — keep existing model list
          const existing = provider.models || [];
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              models: existing.map((m) => m.id || m),
              count: existing.length,
              note: "Provider has no /models endpoint; existing list kept.",
            }),
          );
          return;
        }
        if (modelsRes.status === 429) {
          // Rate limited — keep existing model list, don't overwrite
          const existing = provider.models || [];
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              models: existing.map((m) => m.id || m),
              count: existing.length,
              note: "Rate limited (429); existing model list kept.",
            }),
          );
          return;
        }
        if (!modelsRes.ok) {
          const txt = await modelsRes.text().catch(() => modelsRes.statusText);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: `${modelsRes.status}: ${txt.slice(0, 120)}`,
            }),
          );
          return;
        }
        const json = await modelsRes.json();
        let rawModels = json.data || json.models || [];
        // Perplexity / xAI may return 200 with empty or unexpected list — use built-in
        if (rawModels.length === 0 && baseUrl) {
          const u = baseUrl.toLowerCase();
          if (u.includes("perplexity")) {
            const knownModels = [
              { id: "sonar", name: "Sonar" },
              { id: "sonar-pro", name: "Sonar Pro" },
              { id: "sonar-reasoning", name: "Sonar Reasoning" },
              { id: "sonar-reasoning-pro", name: "Sonar Reasoning Pro" },
            ];
            provider.models = knownModels;
            if (cfg.models?.providers?.[providerId])
              cfg.models.providers[providerId].models = knownModels;
            if (cfg.providers?.[providerId])
              cfg.providers[providerId].models = knownModels;
            const writeErr = await safeWriteConfig(cfg);
            if (writeErr) {
              res.writeHead(writeErr.status, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: writeErr.message }));
              return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                ok: true,
                models: knownModels.map((m) => m.id),
                count: knownModels.length,
                note: "Perplexity returned no /models; built-in list used.",
              }),
            );
            return;
          }
          if (u.includes("x.ai")) {
            const knownModels = [
              { id: "grok-3-mini", name: "Grok 3 Mini" },
              { id: "grok-3", name: "Grok 3" },
              { id: "grok-4-fast-non-reasoning", name: "Grok 4 Fast (non-reasoning)" },
              { id: "grok-4-fast-reasoning", name: "Grok 4 Fast (reasoning)" },
              { id: "grok-4-1-fast-non-reasoning", name: "Grok 4.1 Fast (non-reasoning)" },
              { id: "grok-4-1-fast-reasoning", name: "Grok 4.1 Fast (reasoning)" },
              { id: "grok-4.20-multi-agent-beta-0309", name: "Grok 4.20 Multi-Agent Beta" },
              { id: "grok-4.20-beta-0309-reasoning", name: "Grok 4.20 Beta (reasoning)" },
              { id: "grok-4.20-beta-0309-non-reasoning", name: "Grok 4.20 Beta (non-reasoning)" },
              { id: "grok-4-0709", name: "Grok 4 0709" },
              { id: "grok-code-fast-1", name: "Grok Code Fast" },
              { id: "grok-2-vision-1212", name: "Grok 2 Vision" },
            ];
            provider.models = knownModels;
            if (cfg.models?.providers?.[providerId])
              cfg.models.providers[providerId].models = knownModels;
            if (cfg.providers?.[providerId])
              cfg.providers[providerId].models = knownModels;
            const writeErr = await safeWriteConfig(cfg);
            if (writeErr) {
              res.writeHead(writeErr.status, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: writeErr.message }));
              return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                ok: true,
                models: knownModels.map((m) => m.id),
                count: knownModels.length,
                note: "xAI returned no /models; built-in list used.",
              }),
            );
            return;
          }
        }
        const models = rawModels
          .filter((m) => m.id || m.name)
          .map((m) => ({ id: m.id || m.name, name: m.name || m.id }))
          .sort((a, b) => a.id.localeCompare(b.id));
        provider.models = models;
        if (cfg.models?.providers?.[providerId])
          cfg.models.providers[providerId].models = models;
        if (cfg.providers?.[providerId])
          cfg.providers[providerId].models = models;
        const writeErr = await safeWriteConfig(cfg);
        if (writeErr) {
          res.writeHead(writeErr.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: writeErr.message }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            models: models.map((m) => m.id),
            count: models.length,
          }),
        );
      } catch (e) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    if (url.pathname === "/api/providers/test" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
        return;
      }
      const vr = validate(ProviderTestSchema, parsed);
      if (!vr.ok) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: vr.error }));
        return;
      }
      const { providerId } = vr.data;
      const { readFile } = await import("node:fs/promises");
      const cfgPath = CFG_FILE;
      const cfg = JSON.parse(await readFile(cfgPath, "utf8").catch(() => "{}"));
      const provider =
        cfg?.models?.providers?.[providerId] || cfg?.providers?.[providerId];
      if (!provider) throw new Error("Provider not found");
      const key = provider.apiKey;
      if (!key) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "No API key set" }));
        return;
      }
      const baseUrl = (provider.baseUrl || "").replace(/\/$/, "");
      const isAnthropic =
        providerId === "anthropic" || baseUrl.includes("anthropic.com");
      const isNvidia =
        providerId === "nvidia" || baseUrl.includes("nvidia.com");
      const isGoogle =
        providerId === "google" || baseUrl.includes("googleapis.com");
      const isPerplexityTest =
        (providerId && providerId.toLowerCase() === "perplexity") ||
        (baseUrl && baseUrl.toLowerCase().includes("perplexity"));
      const isXaiTest =
        (providerId && providerId.toLowerCase() === "xai") ||
        (baseUrl && baseUrl.toLowerCase().includes("x.ai"));
      const defaultModel = isAnthropic
        ? "claude-3-haiku-20240307"
        : isGoogle
          ? "gemini-1.5-flash"
          : isPerplexityTest
            ? "sonar-pro"
            : isXaiTest
              ? "grok-3-mini"
              : "gpt-4o-mini";
      const firstModel = provider.models?.[0]?.id || defaultModel;
      try {
        let testRes, ok, model, errText;
        if (isAnthropic) {
          testRes = await fetch(`${baseUrl}/models`, {
            headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
            signal: AbortSignal.timeout(10000),
          });
          const d = await testRes.json().catch(() => ({}));
          ok = testRes.ok;
          model = d?.data?.[0]?.id || (ok ? "connected" : null);
          errText = d?.error?.message || testRes.statusText;
        } else if (isGoogle) {
          const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
          testRes = await fetch(listUrl, {
            signal: AbortSignal.timeout(10000),
          });
          const gd = await testRes.json().catch(() => ({}));
          ok = testRes.ok && !!gd.models;
          const chatModels = (gd.models || []).filter(
            (m) =>
              m.name &&
              m.supportedGenerationMethods?.includes("generateContent"),
          );
          model =
            chatModels[0]?.name?.replace("models/", "") ||
            (ok ? "connected" : null);
          errText = gd.error?.message || testRes.statusText;
        } else if (isPerplexityTest) {
          testRes = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${key}`,
            },
            body: JSON.stringify({
              model: firstModel,
              messages: [{ role: "user", content: "hi" }],
              // Reasoning models (o1/o3/gpt-5 series) don't support max_tokens parameter
              ...(/^(o1|o3|gpt-5)/i.test(firstModel) ? {} : { max_tokens: 1 }),
            }),
            signal: AbortSignal.timeout(15000),
          });
          ok = testRes.ok || testRes.status === 400;
          model = firstModel;
          errText = ok
            ? undefined
            : await testRes.text().catch(() => testRes.statusText);
        } else {
          // Default: validate via /models endpoint (no inference, no rate limits, works with all OpenAI-compatible APIs)
          testRes = await fetch(`${baseUrl}/models`, {
            headers: { authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(15000),
          });
          const d = await testRes.json().catch(() => ({}));
          ok = testRes.ok;
          const chatModel = (d?.data || []).find((m) =>
            /chat|instruct|turbo|gpt|llama|qwen|mistral|gemma|codex|deepseek/i.test(
              m?.id || "",
            ),
          );
          model =
            chatModel?.id || d?.data?.[0]?.id || (ok ? "connected" : null);
          errText = d?.error?.message || testRes.statusText;
          if (!ok && testRes.status === 404) {
            // Fallback: /models not supported, try chat/completions
            testRes = await fetch(`${baseUrl}/chat/completions`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${key}`,
              },
              body: JSON.stringify({
                model: firstModel,
                messages: [{ role: "user", content: "hi" }],
                // Reasoning models (o1/o3/gpt-5 series) don't support max_tokens parameter
                ...(/^(o1|o3|gpt-5)/i.test(firstModel) ? {} : { max_tokens: 1 }),
              }),
              signal: AbortSignal.timeout(15000),
            });
            ok = testRes.ok || testRes.status === 400;
            model = firstModel;
            errText = ok
              ? undefined
              : await testRes.text().catch(() => testRes.statusText);
          }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok,
            model,
            error: ok ? undefined : errText?.slice(0, 120),
          }),
        );
      } catch (e) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    // ── Search Tools API ────────────────────────────────────────────────────
    if (url.pathname === "/api/search-tools" && req.method === "GET") {
      const csTools = path.join(
        os.homedir(),
        ".crewswarm",
        "search-tools.json",
      );
      const ocTools = path.join(os.homedir(), ".openclaw", "search-tools.json");
      const savedCs = await fs.promises
        .readFile(csTools, "utf8")
        .catch(() => "{}")
        .then((d) => {
          try {
            return JSON.parse(d);
          } catch {
            return {};
          }
        });
      const savedOc = await fs.promises
        .readFile(ocTools, "utf8")
        .catch(() => "{}")
        .then((d) => {
          try {
            return JSON.parse(d);
          } catch {
            return {};
          }
        });
      const keys = {};
      keys.parallel = !!(
        savedCs.parallel?.apiKey ||
        savedOc.parallel?.apiKey ||
        process.env.PARALLEL_API_KEY
      );
      keys.brave = !!(
        savedCs.brave?.apiKey ||
        savedOc.brave?.apiKey ||
        process.env.BRAVE_API_KEY
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys }));
      return;
    }
    if (url.pathname === "/api/search-tools/save" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { toolId, key } = JSON.parse(body);
      const csTools = path.join(
        os.homedir(),
        ".crewswarm",
        "search-tools.json",
      );
      const ocTools = path.join(os.homedir(), ".openclaw", "search-tools.json");
      const savedCs = await fs.promises
        .readFile(csTools, "utf8")
        .catch(() => "{}")
        .then((d) => {
          try {
            return JSON.parse(d);
          } catch {
            return {};
          }
        });
      savedCs[toolId] = { apiKey: key };
      await fs.promises
        .mkdir(path.dirname(csTools), { recursive: true })
        .catch(() => { });
      await fs.promises.writeFile(csTools, JSON.stringify(savedCs, null, 2));
      const savedOc = await fs.promises
        .readFile(ocTools, "utf8")
        .catch(() => "{}")
        .then((d) => {
          try {
            return JSON.parse(d);
          } catch {
            return {};
          }
        });
      savedOc[toolId] = { apiKey: key };
      await fs.promises
        .mkdir(path.dirname(ocTools), { recursive: true })
        .catch(() => { });
      await fs.promises.writeFile(ocTools, JSON.stringify(savedOc, null, 2));
      // Also persist to ~/.zshrc so agents and shells pick it up
      const envKey =
        toolId === "parallel"
          ? "PARALLEL_API_KEY"
          : toolId === "brave"
            ? "BRAVE_API_KEY"
            : null;
      if (envKey) {
        const zshrc = path.join(os.homedir(), ".zshrc");
        let content = await fs.promises.readFile(zshrc, "utf8").catch(() => "");
        const line = `export ${envKey}="${key}"`;
        const regex = new RegExp(`^export ${envKey}=.*$`, "m");
        content = regex.test(content)
          ? content.replace(regex, line)
          : content + `\n${line}\n`;
        await fs.promises.writeFile(zshrc, content);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/api/search-tools/test" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { toolId } = JSON.parse(body);
      const csTools = path.join(
        os.homedir(),
        ".crewswarm",
        "search-tools.json",
      );
      const ocTools = path.join(os.homedir(), ".openclaw", "search-tools.json");
      const savedCs = await fs.promises
        .readFile(csTools, "utf8")
        .catch(() => "{}")
        .then((d) => {
          try {
            return JSON.parse(d);
          } catch {
            return {};
          }
        });
      const savedOc = await fs.promises
        .readFile(ocTools, "utf8")
        .catch(() => "{}")
        .then((d) => {
          try {
            return JSON.parse(d);
          } catch {
            return {};
          }
        });
      const key =
        savedCs[toolId]?.apiKey ||
        savedOc[toolId]?.apiKey ||
        process.env[
        toolId === "parallel"
          ? "PARALLEL_API_KEY"
          : toolId === "brave"
            ? "BRAVE_API_KEY"
            : ""
        ];
      if (!key) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "No key saved" }));
        return;
      }
      try {
        let ok, message, error;
        if (toolId === "parallel") {
          // Validate via chat completions — lightest endpoint
          const r = await fetch("https://api.parallel.ai/chat/completions", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${key}`,
            },
            body: JSON.stringify({
              model: "speed",
              messages: [{ role: "user", content: "hi" }],
              stream: false,
            }),
            signal: AbortSignal.timeout(15000),
          });
          ok = r.ok || r.status === 400;
          message = ok ? "Connected — parallel.ai ready" : null;
          error = ok ? undefined : `${r.status} ${r.statusText}`;
        } else if (toolId === "brave") {
          const r = await fetch(
            "https://api.search.brave.com/res/v1/web/search?q=test&count=1",
            {
              headers: {
                Accept: "application/json",
                "X-Subscription-Token": key,
              },
              signal: AbortSignal.timeout(10000),
            },
          );
          ok = r.ok;
          message = ok ? "Connected — Brave Search ready" : null;
          error = ok ? undefined : `${r.status} ${r.statusText}`;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok, message, error }));
      } catch (e) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    // ── OpenCode stats API (queries DB directly) ─────────────────────────────
    if (url.pathname === "/api/opencode-stats" && req.method === "GET") {
      const days = Number(url.searchParams.get("days") || "14");
      const dbPath = path.join(
        os.homedir(),
        ".local",
        "share",
        "opencode",
        "opencode.db",
      );
      try {
        const { execFile } = await import("node:child_process");
        const query = `
SELECT
  date(p.time_created/1000,'unixepoch') as day,
  json_extract(m.data,'$.providerID') || '/' || json_extract(m.data,'$.modelID') as model,
  ROUND(SUM(json_extract(p.data,'$.cost')),6) as cost,
  SUM(json_extract(p.data,'$.tokens.input')) as input_tok,
  SUM(json_extract(p.data,'$.tokens.output')) as output_tok,
  SUM(json_extract(p.data,'$.tokens.cache.read')) as cache_read,
  COUNT(*) as calls
FROM part p
JOIN message m ON m.id = p.message_id
WHERE json_extract(p.data,'$.type') = 'step-finish'
  AND p.time_created > (strftime('%s','now') - ${days}*86400)*1000
GROUP BY day, model
ORDER BY day DESC, cost DESC;`;
        const rows = await new Promise((resolve, reject) => {
          // -readonly avoids competing with the opencode server write lock; 30s timeout for large DBs
          execFile(
            "sqlite3",
            [dbPath, "-readonly", "-separator", "\t", query],
            { timeout: 30000 },
            (err, stdout) => {
              if (err) return reject(err);
              const result = [];
              for (const line of stdout.trim().split("\n").filter(Boolean)) {
                const [
                  day,
                  model,
                  cost,
                  input_tok,
                  output_tok,
                  cache_read,
                  calls,
                ] = line.split("\t");
                result.push({
                  day,
                  model,
                  cost: Number(cost) || 0,
                  input_tok: Number(input_tok) || 0,
                  output_tok: Number(output_tok) || 0,
                  cache_read: Number(cache_read) || 0,
                  calls: Number(calls) || 0,
                });
              }
              resolve(result);
            },
          );
        });
        // Roll up by day for summary
        const byDay = {};
        for (const r of rows) {
          if (!byDay[r.day])
            byDay[r.day] = {
              cost: 0,
              input_tok: 0,
              output_tok: 0,
              calls: 0,
              byModel: {},
            };
          byDay[r.day].cost += r.cost;
          byDay[r.day].input_tok += r.input_tok;
          byDay[r.day].output_tok += r.output_tok;
          byDay[r.day].calls += r.calls;
          byDay[r.day].byModel[r.model] = {
            cost: r.cost,
            input_tok: r.input_tok,
            output_tok: r.output_tok,
            calls: r.calls,
          };
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, rows, byDay }));
      } catch (e) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ ok: false, error: e.message, rows: [], byDay: {} }),
        );
      }
      return;
    }
    // ── OpenCode models API ──────────────────────────────────────────────────
    if (url.pathname === "/api/opencode-models" && req.method === "GET") {
      let models = [];
      // Try CLI first (may hang if OpenCode desktop holds DB lock, so short timeout)
      try {
        const { execFile } = await import("node:child_process");
        const ocBin = path.join(os.homedir(), ".opencode", "bin", "opencode");
        const bin = fs.existsSync(ocBin) ? ocBin : "opencode";
        models = await new Promise((resolve, reject) => {
          const child = execFile(
            bin,
            ["models", "list", "--format", "json"],
            { timeout: 8000, env: { ...process.env } },
            (err, stdout) => {
              if (err) return reject(err);
              try {
                resolve(JSON.parse(stdout));
              } catch {
                resolve([]);
              }
            },
          );
        });
      } catch {
        // Fallback: read auth.json to discover configured providers, then return known models
        try {
          const authPath = path.join(
            os.homedir(),
            ".local",
            "share",
            "opencode",
            "auth.json",
          );
          const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
          const providers = Object.keys(auth || {}).map((k) => k.toLowerCase());
          const knownModels = {
            openai: [
              "openai/gpt-5.3-codex",
              "openai/gpt-5.3-codex-spark",
              "openai/gpt-5.2-codex",
              "openai/gpt-5.2",
              "openai/gpt-5.1-codex-max",
              "openai/gpt-5.1-codex",
              "openai/gpt-5.1-codex-mini",
              "openai/gpt-5-codex",
              "openai/codex-mini-latest",
            ],
            opencode: [
              // Stealth
              "opencode/big-pickle",
              "opencode/trinity-large-preview-free",
              // OpenAI
              "opencode/gpt-5.1-codex-max",
              "opencode/gpt-5.1-codex",
              "opencode/gpt-5.1-codex-mini",
              "opencode/gpt-5.1",
              "opencode/gpt-5.2-codex",
              "opencode/gpt-5.2",
              "opencode/alpha-gpt-5.3-codex",
              "opencode/alpha-gpt-5.4",
              "opencode/gpt-5-codex",
              "opencode/gpt-5",
              "opencode/gpt-5-nano",
              // Anthropic
              "opencode/claude-sonnet-4-6",
              "opencode/claude-sonnet-4-5",
              "opencode/claude-sonnet-4",
              "opencode/claude-opus-4-6",
              "opencode/claude-opus-4-5",
              "opencode/claude-opus-4-1",
              "opencode/claude-haiku-4-5",
              "opencode/claude-3-5-haiku",
              // Google
              "opencode/gemini-3.1-pro",
              "opencode/gemini-3-pro",
              "opencode/gemini-3-flash",
              // Moonshot AI
              "opencode/kimi-k2.5",
              "opencode/kimi-k2.5-free",
              "opencode/kimi-k2-thinking",
              "opencode/kimi-k2",
              // Z.ai
              "opencode/glm-5",
              "opencode/glm-5-free",
              "opencode/glm-4.7",
              "opencode/glm-4.6",
              // MiniMax
              "opencode/minimax-m2.5",
              "opencode/minimax-m2.5-free",
              "opencode/minimax-m2.1",
              "opencode/minimax-m2.1-free",
            ],
            groq: [
              "groq/moonshotai/kimi-k2-instruct-0905",
              "groq/openai/gpt-oss-120b",
              "groq/openai/gpt-oss-20b",
              "groq/meta-llama/llama-4-maverick-17b-128e-instruct",
              "groq/meta-llama/llama-4-scout-17b-16e-instruct",
              "groq/qwen/qwen3-32b",
              "groq/llama-3.3-70b-versatile",
              "groq/llama-3.1-8b-instant",
            ],
            xai: [
              "xai/grok-4-1-fast",
              "xai/grok-4-1-fast-non-reasoning",
              "xai/grok-4",
              "xai/grok-4-fast",
              "xai/grok-4-fast-non-reasoning",
              "xai/grok-code-fast-1",
              "xai/grok-3",
              "xai/grok-3-latest",
              "xai/grok-3-fast",
              "xai/grok-3-fast-latest",
              "xai/grok-3-mini",
              "xai/grok-3-mini-latest",
              "xai/grok-3-mini-fast",
              "xai/grok-3-mini-fast-latest",
              "xai/grok-2-latest",
              "xai/grok-2",
              "xai/grok-2-1212",
              "xai/grok-2-vision-latest",
              "xai/grok-2-vision",
              "xai/grok-2-vision-1212",
              "xai/grok-beta",
              "xai/grok-vision-beta",
            ],
          };
          for (const p of providers) {
            if (knownModels[p]) models.push(...knownModels[p]);
          }
          // Also check env vars for additional providers
          if (process.env.GROQ_API_KEY && !providers.includes("groq"))
            models.push(...(knownModels.groq || []));
          if (process.env.XAI_API_KEY && !providers.includes("xai"))
            models.push(...(knownModels.xai || []));
        } catch {
          /* no auth info available */
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, models }));
      return;
    }
    // ── Agents API ──────────────────────────────────────────────────────────
    if (url.pathname === "/api/agents-config" && req.method === "GET") {
      const { readFile } = await import("node:fs/promises");
      const cfgPath = CFG_FILE;
      const promptsPath = path.join(CFG_DIR, "agent-prompts.json");
      const cfg = JSON.parse(await readFile(cfgPath, "utf8").catch(() => "{}"));
      const agentPrompts = JSON.parse(
        await readFile(promptsPath, "utf8").catch(() => "{}"),
      );
      const rawList = Array.isArray(cfg.agents)
        ? cfg.agents
        : Array.isArray(cfg.agents?.list)
          ? cfg.agents.list
          : [];
      const nowMs = Date.now();
      const byCanonicalId = new Map();
      rawList.forEach((a) => {
        const canonicalId = a.id === "orchestrator" ? "crew-orchestrator" : a.id;
        const heartbeatKey = normalizeRtAgentId(canonicalId);
        const lastSeen =
          agentHeartbeats.get(canonicalId) ||
          (heartbeatKey ? agentHeartbeats.get(heartbeatKey) : null) ||
          null;
        const ageSec = lastSeen ? Math.floor((nowMs - lastSeen) / 1000) : null;
        const liveness =
          ageSec === null
            ? "unknown"
            : ageSec < 90
              ? "online"
              : ageSec < 300
                ? "stale"
                : "offline";
        const entry = {
          id: canonicalId,
          model: a.model || "",
          fallbackModel: a.fallbackModel || "",
          voice: a.voice || null,
          name: a.identity?.name || canonicalId,
          emoji: a.identity?.emoji || "🤖",
          theme: a.identity?.theme || "",
          systemPrompt:
            agentPrompts[canonicalId] ||
            agentPrompts[canonicalId.replace(/^crew-/, "")] ||
            "",
          toolProfile: a.tools?.profile || "default",
          alsoAllow: a.tools?.crewswarmAllow || a.tools?.alsoAllow || [],
          workspace: a.workspace || "",
          useOpenCode: a.useOpenCode,
          opencodeModel: a.opencodeModel || "",
          useCursorCli: a.useCursorCli || false,
          opencodeFallbackModel: a.opencodeFallbackModel || "",
          cursorCliModel: a.cursorCliModel || "",
          useClaudeCode: a.useClaudeCode || false,
          claudeCodeModel: a.claudeCodeModel || "",
          useCodex: a.useCodex || false,
          codexModel: a.codexModel || "",
          useGeminiCli: a.useGeminiCli || false,
          geminiCliModel: a.geminiCliModel || "",
          useCrewCLI: a.useCrewCLI || false,
          crewCliModel: a.crewCliModel || "",
          useDockerSandbox: a.useDockerSandbox || false,
          role: a._role || "",
          opencodeLoop: a.opencodeLoop || false,
          opencodeLoopMaxRounds: a.opencodeLoopMaxRounds || 10,
          liveness,
          lastSeen,
          ageSec,
        };
        const prev = byCanonicalId.get(canonicalId);
        // Prefer the canonical crew-* config if both alias and canonical exist.
        if (!prev || a.id === canonicalId) byCanonicalId.set(canonicalId, entry);
      });
      const agentList = [...byCanonicalId.values()];
      // Always show crew-lead in Agents so user can set his model (crew-lead.mjs reads from this config)
      if (!agentList.some((a) => a.id === "crew-lead")) {
        agentList.push({
          id: "crew-lead",
          model: "groq/llama-3.3-70b-versatile",
          name: "Crew Lead",
          emoji: "🦊",
          theme: "",
          systemPrompt: agentPrompts["crew-lead"] || "",
          toolProfile: "default",
          alsoAllow: ["dispatch"],
          workspace: "",
          liveness: "unknown",
          lastSeen: null,
          ageSec: null,
        });
      }
      // Always show crew-orchestrator in Agents — PM loop uses this model
      // for routing/expanding (or falls back to crew-pm).
      if (!agentList.some((a) => a.id === "crew-orchestrator")) {
        agentList.push({
          id: "crew-orchestrator",
          model: "",
          name: "Orchestrator (PM Loop)",
          emoji: "🧠",
          theme: "",
          systemPrompt:
            agentPrompts["crew-orchestrator"] ||
            agentPrompts["orchestrator"] ||
            "",
          toolProfile: "default",
          alsoAllow: ["read_file", "dispatch"],
          workspace: "",
          liveness: "unknown",
          lastSeen: null,
          ageSec: null,
        });
      }
      // Merge providers from both locations so MODEL dropdown gets custom models from either
      const topProviders = cfg?.providers || {};
      const nestedProviders = cfg?.models?.providers || {};
      const providerMap = {};
      for (const id of new Set([
        ...Object.keys(topProviders),
        ...Object.keys(nestedProviders),
      ])) {
        const t = topProviders[id];
        const n = nestedProviders[id];
        const merged = { ...(t || {}), ...(n || {}) };
        merged.models = (n?.models?.length ? n.models : t?.models) || [];
        providerMap[id] = merged;
      }
      const allModels = [];
      const modelsByProvider = {};
      const OPENAI_LOCAL_DEFAULT_MODELS = [
        { id: "gpt-5", name: "GPT-5" },
        { id: "gpt-5.1", name: "GPT-5.1" },
        { id: "gpt-5.2", name: "GPT-5.2" },
        { id: "gpt-5-codex", name: "GPT-5 Codex" },
        { id: "gpt-5.1-codex", name: "GPT-5.1 Codex" },
        { id: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini" },
        { id: "codex-mini", name: "Codex Mini" },
      ];
      for (const [pid, p] of Object.entries(providerMap)) {
        let models = p.models || [];
        if (pid === "openai-local" && !models.length)
          models = OPENAI_LOCAL_DEFAULT_MODELS;
        if (!models.length) continue;
        modelsByProvider[pid] = models.map((m) => ({
          id: typeof m === "string" ? m : m.id,
          name: typeof m === "string" ? m : m.name || m.id,
        }));
        for (const m of models) {
          const mid = typeof m === "string" ? m : m.id;
          allModels.push(pid + "/" + mid);
        }
      }
      const defaultModels = Object.keys(cfg.agents?.defaults?.models || {});
      for (const m of defaultModels) {
        if (!allModels.includes(m)) allModels.push(m);
      }
      const roleToolDefaults = cfg.roleToolDefaults || {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          agents: agentList,
          allModels,
          modelsByProvider,
          roleToolDefaults,
        }),
      );
      return;
    }
    if (url.pathname === "/api/chat-participants" && req.method === "GET") {
      const { listChatParticipants } = await import("../lib/chat/participants.mjs");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, participants: listChatParticipants() }));
      return;
    }

    // ── Memory API ──────────────────────────────────────────────────────────
    if (url.pathname === "/api/memory/stats" && req.method === "GET") {
      const {
        getMemoryStats,
        getKeeperStats,
        CREW_MEMORY_DIR,
        isSharedMemoryAvailable,
      } = await import("../lib/memory/shared-adapter.mjs");

      try {
        const agentMemoryStats = isSharedMemoryAvailable() ? getMemoryStats("crew-lead") : null;
        const keeperStats = isSharedMemoryAvailable() ? await getKeeperStats(process.cwd()) : null;

        res.end(
          JSON.stringify({
            agentMemory: agentMemoryStats || {},
            agentKeeper: keeperStats || {},
            storageDir: CREW_MEMORY_DIR,
            available: isSharedMemoryAvailable(),
          }),
        );
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === "/api/memory/search" && req.method === "POST") {
      const { searchMemory } = await import("../lib/memory/shared-adapter.mjs");
      let body = "";
      for await (const chunk of req) body += chunk;
      const { query, maxResults } = JSON.parse(body);

      if (!query) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "query required" }));
        return;
      }

      try {
        const hits = await searchMemory(process.cwd(), query, {
          maxResults: maxResults || 20,
        });
        res.end(JSON.stringify({ hits }));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === "/api/memory/migrate" && req.method === "POST") {
      const { migrateBrainToMemory } =
        await import("../lib/memory/shared-adapter.mjs");
      const brainPath = path.join(CREWSWARM_DIR, "memory", "brain.md");

      if (!fs.existsSync(brainPath)) {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, error: "brain.md not found" }));
        return;
      }

      try {
        const result = await migrateBrainToMemory(brainPath, "crew-lead");
        res.end(JSON.stringify(result));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (url.pathname === "/api/memory/compact" && req.method === "POST") {
      const { compactKeeperStore } =
        await import("../lib/memory/shared-adapter.mjs");

      try {
        const result = await compactKeeperStore(process.cwd());
        if (!result) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "AgentKeeper not available" }));
          return;
        }
        res.end(JSON.stringify(result));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === "/api/agents-config/update" && req.method === "POST") {
      const { readFile, writeFile } = await import("node:fs/promises");
      let body = "";
      for await (const chunk of req) body += chunk;
      const {
        agentId,
        model,
        fallbackModel,
        systemPrompt,
        name,
        emoji,
        theme,
        toolProfile,
        alsoAllow,
        useOpenCode,
        opencodeModel,
        opencodeFallbackModel,
        useCursorCli,
        cursorCliModel,
        useClaudeCode,
        claudeCodeModel,
        useCodex,
        codexModel,
        useGeminiCli,
        geminiCliModel,
        useCrewCLI,
        crewCliModel,
        useDockerSandbox,
        role,
        opencodeLoop,
        opencodeLoopMaxRounds,
        voice,
        workspace,
      } = JSON.parse(body);
      if (!agentId) throw new Error("agentId required");
      const cfgPath = CFG_FILE;
      const promptsPath = path.join(CFG_DIR, "agent-prompts.json");
      const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
      let list = Array.isArray(cfg.agents)
        ? cfg.agents
        : Array.isArray(cfg.agents?.list)
          ? cfg.agents.list
          : [];
      let agent = list.find((a) => a.id === agentId);
      if (!agent && agentId === "crew-lead") {
        if (!Array.isArray(cfg.agents))
          cfg.agents =
            cfg.agents?.list != null ? { list: cfg.agents.list } : [];
        const arr = Array.isArray(cfg.agents) ? cfg.agents : cfg.agents.list;
        if (!arr)
          throw new Error(
            "Cannot determine agents list structure in crewswarm.json",
          );
        agent = {
          id: "crew-lead",
          model: "groq/llama-3.3-70b-versatile",
          identity: { name: "Crew Lead", emoji: "🦊" },
          tools: { profile: "default", alsoAllow: ["dispatch"] },
        };
        arr.push(agent);
        list = arr;
      }
      const resolvedAgentId =
        agentId === "orchestrator" ? "crew-orchestrator" : agentId;
      if (!agent) {
        agent = list.find((a) => a.id === resolvedAgentId);
      }
      if (!agent && resolvedAgentId === "crew-orchestrator") {
        if (!Array.isArray(cfg.agents))
          cfg.agents =
            cfg.agents?.list != null ? { list: cfg.agents.list } : [];
        const arr = Array.isArray(cfg.agents) ? cfg.agents : cfg.agents.list;
        if (!arr)
          throw new Error(
            "Cannot determine agents list structure in crewswarm.json",
          );
        agent = {
          id: "crew-orchestrator",
          model: "",
          identity: { name: "Orchestrator (PM Loop)", emoji: "🧠" },
          tools: { profile: "default", alsoAllow: ["read_file", "dispatch"] },
        };
        arr.push(agent);
        list = arr;
      }
      if (!agent) throw new Error("Agent not found: " + agentId);
      if (model) agent.model = model;
      if (fallbackModel !== undefined)
        agent.fallbackModel = fallbackModel || undefined;
      if (name) {
        if (!agent.identity) agent.identity = {};
        agent.identity.name = name;
      }
      if (emoji) {
        if (!agent.identity) agent.identity = {};
        agent.identity.emoji = emoji;
      }
      if (theme !== undefined && theme !== null) {
        if (!agent.identity) agent.identity = {};
        agent.identity.theme = theme;
      }
      if (toolProfile) {
        if (!agent.tools) agent.tools = {};
        agent.tools.profile = toolProfile;
      }
      if (alsoAllow !== undefined) {
        if (!agent.tools) agent.tools = {};
        agent.tools.crewswarmAllow = alsoAllow;
        agent.tools.alsoAllow = alsoAllow;
        agent.tools.profile = "crewswarm";
      }
      if (useOpenCode !== undefined) agent.useOpenCode = useOpenCode;
      if (opencodeModel !== undefined)
        agent.opencodeModel = opencodeModel || undefined;
      if (opencodeFallbackModel !== undefined)
        agent.opencodeFallbackModel = opencodeFallbackModel || undefined;
      if (useCursorCli !== undefined) agent.useCursorCli = useCursorCli;
      if (cursorCliModel !== undefined)
        agent.cursorCliModel = cursorCliModel || undefined;
      if (useClaudeCode !== undefined) agent.useClaudeCode = useClaudeCode;
      if (claudeCodeModel !== undefined)
        agent.claudeCodeModel = claudeCodeModel || undefined;
      if (useCodex !== undefined) agent.useCodex = useCodex;
      if (codexModel !== undefined)
        agent.codexModel = codexModel || undefined;
      if (useGeminiCli !== undefined) agent.useGeminiCli = useGeminiCli;
      if (geminiCliModel !== undefined)
        agent.geminiCliModel = geminiCliModel || undefined;
      if (useCrewCLI !== undefined) agent.useCrewCLI = useCrewCLI;
      if (crewCliModel !== undefined)
        agent.crewCliModel = crewCliModel || undefined;
      if (useDockerSandbox !== undefined)
        agent.useDockerSandbox = useDockerSandbox;
      if (role !== undefined) agent._role = role || undefined;
      if (opencodeLoop !== undefined)
        agent.opencodeLoop = opencodeLoop || undefined;
      if (opencodeLoopMaxRounds !== undefined)
        agent.opencodeLoopMaxRounds =
          opencodeLoopMaxRounds > 0 ? opencodeLoopMaxRounds : undefined;
      if (voice !== undefined) agent.voice = voice || undefined;
      if (workspace !== undefined) agent.workspace = workspace || undefined;

      // Create timestamped backup before writing
      const backupPath = path.join(
        CFG_DIR,
        `crewswarm.json.backup.${Date.now()}`,
      );
      await writeFile(backupPath, await readFile(cfgPath, "utf8"), "utf8");

      // Keep only last 10 backups
      const { readdir, unlink } = await import("node:fs/promises");
      try {
        const files = await readdir(CFG_DIR);
        const backups = files
          .filter((f) => f.startsWith("crewswarm.json.backup."))
          .sort()
          .reverse();
        for (const old of backups.slice(10)) {
          await unlink(path.join(CFG_DIR, old)).catch(() => { });
        }
      } catch { }

      const writeErr = await safeWriteConfig(cfg);
      if (writeErr) {
        res.writeHead(writeErr.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: writeErr.message }));
        return;
      }
      // System prompts live in agent-prompts.json, not crewswarm.json
      if (systemPrompt !== undefined) {
        const prompts = JSON.parse(
          await readFile(promptsPath, "utf8").catch(() => "{}"),
        );
        prompts[agentId] = systemPrompt;
        await writeFile(promptsPath, JSON.stringify(prompts, null, 2), "utf8");
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/api/agents-config/create" && req.method === "POST") {
      const { readFile, writeFile } = await import("node:fs/promises");
      let body = "";
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
        return;
      }
      const vr = validate(AgentConfigCreateSchema, parsed);
      if (!vr.ok) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: vr.error }));
        return;
      }
      const {
        id,
        model,
        name,
        emoji,
        theme,
        systemPrompt,
        alsoAllow: reqAlsoAllow,
      } = vr.data;
      const rawId = String(id || "");
      const normalizedId =
        rawId && !rawId.startsWith("crew-")
          ? rawId === "orchestrator"
            ? "crew-orchestrator"
            : `crew-${rawId}`
          : rawId;
      if (!normalizedId || !model) throw new Error("id and model required");
      const cfgPath = CFG_FILE;
      const promptsPath = path.join(CFG_DIR, "agent-prompts.json");
      const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
      const list = Array.isArray(cfg.agents)
        ? cfg.agents
        : Array.isArray(cfg.agents?.list)
          ? cfg.agents.list
          : null;
      if (!list)
        throw new Error(
          "Cannot determine agents list structure in crewswarm.json",
        );
      if (list.find((a) => a.id === normalizedId))
        throw new Error("Agent ID already exists: " + normalizedId);
      const defaultWorkspace = list[0]?.workspace || process.cwd();
      // Role-based tool defaults used when no explicit alsoAllow provided
      const ROLE_DEFAULTS = {
        "crew-qa": ["read_file"],
        "crew-github": ["read_file", "run_cmd", "git"],
        "crew-pm": ["read_file", "dispatch"],
        "crew-lead": ["dispatch"],
        "crew-telegram": ["telegram", "read_file"],
        "crew-security": ["read_file", "run_cmd"],
        "crew-copywriter": ["write_file", "read_file"],
        "crew-main": ["read_file", "write_file", "run_cmd", "dispatch"],
      };
      const defaultTools = reqAlsoAllow?.length
        ? reqAlsoAllow
        : ROLE_DEFAULTS[normalizedId] || [
          "write_file",
          "read_file",
          "mkdir",
          "run_cmd",
        ];
      list.push({
        id: normalizedId,
        model,
        identity: {
          name: name || normalizedId,
          emoji: emoji || "🤖",
          theme: theme || "",
        },
        tools: { profile: "crewswarm", alsoAllow: defaultTools },
        workspace: defaultWorkspace,
      });
      const writeErr = await safeWriteConfig(cfg);
      if (writeErr) {
        res.writeHead(writeErr.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: writeErr.message }));
        return;
      }
      // Save system prompt to agent-prompts.json
      const defaultPrompt =
        systemPrompt ||
        "You are " +
        (name || normalizedId) +
        ". You are a coding specialist in the crewswarm crew. Always read files before editing. Never replace entire files — only patch.";
      const prompts = JSON.parse(
        await readFile(promptsPath, "utf8").catch(() => "{}"),
      );
      prompts[normalizedId] = defaultPrompt;
      await writeFile(promptsPath, JSON.stringify(prompts, null, 2), "utf8");
      // Auto-sync agent registry in shared memory
      import("node:child_process")
        .then(({ execFile }) =>
          execFile(
            "node",
            [new URL("./sync-agents.mjs", import.meta.url).pathname],
            { cwd: path.dirname(new URL(".", import.meta.url).pathname) },
            () => { },
          ),
        )
        .catch(() => { });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, id: normalizedId }));
      return;
    }
    if (url.pathname === "/api/agents-config/delete" && req.method === "POST") {
      const { readFile, writeFile } = await import("node:fs/promises");
      let body = "";
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
        return;
      }
      const vr = validate(AgentConfigDeleteSchema, parsed);
      if (!vr.ok) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: vr.error }));
        return;
      }
      const { agentId } = vr.data;
      const cfgPath = CFG_FILE;
      const promptsPath = path.join(CFG_DIR, "agent-prompts.json");
      const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
      const list = Array.isArray(cfg.agents)
        ? cfg.agents
        : Array.isArray(cfg.agents?.list)
          ? cfg.agents.list
          : [];
      const idx = list.findIndex((a) => a.id === agentId);
      if (idx === -1) throw new Error("Agent not found: " + agentId);
      list.splice(idx, 1);
      const writeErr = await safeWriteConfig(cfg);
      if (writeErr) {
        res.writeHead(writeErr.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: writeErr.message }));
        return;
      }
      // Also remove from agent-prompts.json
      try {
        const prompts = JSON.parse(
          await readFile(promptsPath, "utf8").catch(() => "{}"),
        );
        delete prompts[agentId];
        await writeFile(promptsPath, JSON.stringify(prompts, null, 2), "utf8");
      } catch { }
      // Auto-sync agent registry in shared memory
      import("node:child_process")
        .then(({ execFile }) =>
          execFile(
            "node",
            [new URL("./sync-agents.mjs", import.meta.url).pathname],
            { cwd: path.dirname(new URL(".", import.meta.url).pathname) },
            () => { },
          ),
        )
        .catch(() => { });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (
      (url.pathname === "/api/agents-config/reset-session" ||
        url.pathname === "/api/agents/reset-session") &&
      req.method === "POST"
    ) {
      let body = "";
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body || "{}"); } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
        return;
      }
      const vr = validate(AgentResetSessionSchema, parsed);
      if (!vr.ok) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: vr.error }));
        return;
      }
      const { agentId } = vr.data;
      const { execFile } = await import("node:child_process");
      const bridgePath = path.join(CREWSWARM_DIR, "gateway-bridge.mjs");
      // 1. Reset the agent session via gateway-bridge --reset-session
      execFile(
        "node",
        [bridgePath, "--reset-session", agentId],
        { cwd: CREWSWARM_DIR, timeout: 15000 },
        () => { },
      );
      // 2. After reset, re-inject shared memory as first message so agent has context
      setTimeout(() => {
        execFile(
          "node",
          [
            bridgePath,
            "--send",
            agentId,
            "[SYSTEM] Session reset by operator. You are " +
            agentId +
            ". Read memory/current-state.md and memory/agent-handoff.md to restore context. Confirm with a one-line status.",
          ],
          { cwd: CREWSWARM_DIR, timeout: 15000 },
          () => { },
        );
      }, 2000);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, agentId }));
      return;
    }

    if (url.pathname === "/api/crew/start" && req.method === "POST") {
      const { spawn: spawnProc } = await import("node:child_process");
      const { existsSync: eS } = await import("node:fs");
      const crewScript = path.join(CREWSWARM_DIR, "scripts", "start-crew.mjs");
      if (!eS(crewScript))
        throw new Error(
          "start-crew.mjs not found — is the dashboard running from the crewswarm repo?",
        );
      const result = await new Promise((resolve, reject) => {
        const proc = spawnProc("node", [crewScript, "--force"], {
          cwd: CREWSWARM_DIR,
          env: { ...process.env, CREWSWARM_DIR },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        proc.stdout.on("data", (d) => (out += d));
        proc.stderr.on("data", (d) => (out += d));
        proc.on("close", (code) =>
          code === 0 ? resolve(out.trim()) : reject(new Error(out.trim())),
        );
      });
      const launched = (result.match(/Spawned .+ \(pid/g) || []).length;
      const msg = launched
        ? `⚡ ${launched} new bridge(s) started`
        : "✓ All bridges already running";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: msg, detail: result }));
      return;
    }
    // ── End agents API ───────────────────────────────────────────────────────

    // ── Roadmap read/write ───────────────────────────────────────────────────
    if (url.pathname === "/api/roadmap/read" && req.method === "POST") {
      const { readFile } = await import("node:fs/promises");
      let body = "";
      for await (const chunk of req) body += chunk;
      const { roadmapFile } = JSON.parse(body);
      if (!roadmapFile) throw new Error("roadmapFile required");
      const content = await readFile(roadmapFile, "utf8").catch(() => "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, content }));
      return;
    }
    if (url.pathname === "/api/roadmap/write" && req.method === "POST") {
      const { writeFile } = await import("node:fs/promises");
      let body = "";
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
        return;
      }
      const vr = validate(RoadmapWriteSchema, parsed);
      if (!vr.ok) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: vr.error }));
        return;
      }
      const { roadmapFile, content } = vr.data;
      await writeFile(roadmapFile, content, "utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Reset [!] failed items back to [ ] so PM Loop will retry them
    if (url.pathname === "/api/roadmap/retry-failed" && req.method === "POST") {
      const { readFile, writeFile } = await import("node:fs/promises");
      let body = "";
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
        return;
      }
      const vr = validate(RoadmapRetryFailedSchema, parsed);
      if (!vr.ok) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: vr.error }));
        return;
      }
      const { roadmapFile } = vr.data;
      const content = await readFile(roadmapFile, "utf8");
      // Strip [!] markers back to [ ] and remove failure timestamps
      const reset = content
        .split("\n")
        .map((line) =>
          line.replace(/\[!\]/, "[ ]").replace(/\s+✗\s+\d+:\d+:\d+/g, ""),
        )
        .join("\n");
      const count = (content.match(/\[!\]/g) || []).length;
      await writeFile(roadmapFile, reset, "utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, count }));
      return;
    }

    if (url.pathname === "/favicon.ico" || url.pathname === "/favicon.png") {
      const faviconPath = new URL("../website/favicon.png", import.meta.url)
        .pathname;
      try {
        const { readFile } = await import("node:fs/promises");
        const data = await readFile(faviconPath);
        res.writeHead(200, {
          "content-type": "image/png",
          "cache-control": "public, max-age=86400",
        });
        res.end(data);
      } catch {
        res.writeHead(204);
        res.end();
      }
      return;
    }

    // ── Agent Prompts API ─────────────────────────────────────────────────────
    // GET /api/prompts — read all agent prompts from ~/.crewswarm/agent-prompts.json
    if (url.pathname === "/api/prompts" && req.method === "GET") {
      const promptsFile = path.join(
        os.homedir(),
        ".crewswarm",
        "agent-prompts.json",
      );
      try {
        const promptsRaw = JSON.parse(fs.readFileSync(promptsFile, "utf8"));
        const { applySharedChatPromptOverlay } = await import(
          "../lib/chat/shared-chat-prompt-overlay.mjs"
        );
        let agents = [];
        try {
          const cfg = JSON.parse(fs.readFileSync(CFG_FILE, "utf8"));
          const list = Array.isArray(cfg.agents)
            ? cfg.agents
            : Array.isArray(cfg.agents?.list)
              ? cfg.agents.list
              : [];
          agents = list.map((a) => a.id).filter(Boolean);
        } catch { }

        const shouldCanonicalize = (key, allKeys) => {
          if (!key || key.startsWith("crew-")) return false;
          const candidate = `crew-${key}`;
          return allKeys.has(candidate) || agents.includes(candidate);
        };

        const keys = Object.keys(promptsRaw);
        const keySet = new Set(keys);
        const prompts = {};
        for (const key of keys) {
          const canonical = shouldCanonicalize(key, keySet)
            ? `crew-${key}`
            : key;
          const next = promptsRaw[key];
          const prev = prompts[canonical];
          if (
            typeof prev !== "string" ||
            String(next || "").length > prev.length
          ) {
            prompts[canonical] = applySharedChatPromptOverlay(next, canonical);
          }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, prompts }));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // POST /api/prompts — update a single agent's prompt
    // Body: { agent: "crew-coder", prompt: "You are..." }
    if (url.pathname === "/api/prompts" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { agent, prompt } = JSON.parse(body);

      if (!agent || prompt === undefined) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ ok: false, error: "agent and prompt required" }),
        );
        return;
      }

      const promptsFile = path.join(
        os.homedir(),
        ".crewswarm",
        "agent-prompts.json",
      );
      try {
        let prompts = {};
        try {
          prompts = JSON.parse(fs.readFileSync(promptsFile, "utf8"));
        } catch { }

        const keySet = new Set(Object.keys(prompts));
        let agentIds = [];
        try {
          const cfg = JSON.parse(fs.readFileSync(CFG_FILE, "utf8"));
          const list = Array.isArray(cfg.agents)
            ? cfg.agents
            : Array.isArray(cfg.agents?.list)
              ? cfg.agents.list
              : [];
          agentIds = list.map((a) => a.id).filter(Boolean);
        } catch { }
        const canonicalAgent = normalizeRtAgentId(agent);

        // Update canonical key and remove obvious legacy alias
        prompts[canonicalAgent] = prompt;
        if (
          canonicalAgent.startsWith("crew-") &&
          prompts[canonicalAgent.slice(5)] !== undefined
        ) {
          delete prompts[canonicalAgent.slice(5)];
        }

        fs.writeFileSync(promptsFile, JSON.stringify(prompts, null, 2), "utf8");
        console.log(
          `[dashboard] Prompt updated for ${canonicalAgent} (${prompt.length} chars)`,
        );

        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            agent: canonicalAgent,
            length: prompt.length,
          }),
        );
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // Files API — scan a directory and return file metadata
    if (url.pathname === "/api/files" && req.method === "GET") {
      const scanDir = url.searchParams.get("dir") || os.homedir();
      const ALLOWED_EXT = new Set([
        ".html",
        ".css",
        ".js",
        ".mjs",
        ".ts",
        ".json",
        ".md",
        ".sh",
        ".txt",
        ".yaml",
        ".yml",
      ]);
      const MAX_FILES = 500;
      const results = [];
      function walk(dir, depth) {
        if (depth > 5) return;
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (e.name.startsWith(".") || e.name === "node_modules") continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            walk(full, depth + 1);
          } else if (e.isFile()) {
            const ext = path.extname(e.name).toLowerCase();
            if (!ALLOWED_EXT.has(ext)) continue;
            try {
              const st = fs.statSync(full);
              results.push({ path: full, size: st.size, mtime: st.mtimeMs });
            } catch {
              /* skip */
            }
            if (results.length >= MAX_FILES) return;
          }
        }
      }
      walk(scanDir, 0);
      results.sort((a, b) => b.mtime - a.mtime);
      res.writeHead(200, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
      });
      res.end(JSON.stringify({ files: results }));
      return;
    }

    // File content preview — returns first 300 lines of a file
    if (url.pathname === "/api/file-content" && req.method === "GET") {
      const filePath = url.searchParams.get("path") || "";
      if (!filePath || filePath.includes("..")) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid path" }));
        return;
      }
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        const lines = raw.split("\n");
        const content =
          lines.length > 300
            ? lines.slice(0, 300).join("\n") +
            `\n\n... (${lines.length - 300} more lines)`
            : raw;
        res.writeHead(200, {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        });
        res.end(JSON.stringify({ content, lines: lines.length }));
      } catch (e) {
        res.writeHead(404, {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ── Telegram Bridge API ────────────────────────────────────────────────────
    const TG_CONFIG_PATH = path.join(
      os.homedir(),
      ".crewswarm",
      "telegram-bridge.json",
    );
    const TG_PID_PATH = path.join(
      os.homedir(),
      ".crewswarm",
      "logs",
      "telegram-bridge.pid",
    );
    const TG_MSG_PATH = path.join(
      os.homedir(),
      ".crewswarm",
      "logs",
      "telegram-messages.jsonl",
    );

    function loadTgConfig() {
      try {
        return JSON.parse(fs.readFileSync(TG_CONFIG_PATH, "utf8"));
      } catch {
        return {};
      }
    }

    function isTgRunning() {
      try {
        const pid = parseInt(fs.readFileSync(TG_PID_PATH, "utf8").trim(), 10);
        if (!pid) return false;
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }

    if (url.pathname === "/api/telegram/status") {
      const running = isTgRunning();
      const cfg = loadTgConfig();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ running, botName: cfg.botName || "" }));
      return;
    }

    if (url.pathname === "/api/telegram/config" && req.method === "GET") {
      const cfg = loadTgConfig();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          token: cfg.token || "",
          targetAgent: cfg.targetAgent || "crew-main",
          allowedChatIds: cfg.allowedChatIds || [],
          contactNames: cfg.contactNames || {},
          userRouting: cfg.userRouting || {},
          topicRouting: cfg.topicRouting || {},
        }),
      );
      return;
    }

    if (url.pathname === "/api/telegram/config" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || "{}");
      const existing = loadTgConfig();
      const updated = { ...existing, ...body };
      fs.writeFileSync(TG_CONFIG_PATH, JSON.stringify(updated, null, 2));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/api/telegram/start" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || "{}");
      if (body.token) {
        const existing = loadTgConfig();
        fs.writeFileSync(
          TG_CONFIG_PATH,
          JSON.stringify({ ...existing, ...body }, null, 2),
        );
      }
      const cfg = loadTgConfig();
      if (!cfg.token) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "No token configured" }));
        return;
      }
      if (isTgRunning()) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, message: "Already running" }));
        return;
      }
      const { spawn: spawnBridge } = await import("node:child_process");
      const bridgePath = path.join(CREWSWARM_DIR, "telegram-bridge.mjs");
      const env = {
        ...process.env,
        TELEGRAM_BOT_TOKEN: cfg.token,
        TELEGRAM_TARGET_AGENT: cfg.targetAgent || "crew-main",
      };
      const proc = spawnBridge("node", [bridgePath], {
        env,
        detached: true,
        stdio: "ignore",
      });
      proc.unref();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, pid: proc.pid }));
      return;
    }

    if (url.pathname === "/api/telegram/stop" && req.method === "POST") {
      try {
        const pid = parseInt(fs.readFileSync(TG_PID_PATH, "utf8").trim(), 10);
        if (pid) process.kill(pid, "SIGTERM");
      } catch { }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/api/telegram/messages") {
      try {
        const raw = fs.readFileSync(TG_MSG_PATH, "utf8");
        const msgs = raw
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(msgs.slice(-100)));
      } catch {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("[]");
      }
      return;
    }

    if (url.pathname === "/api/telegram/discover-topics") {
      try {
        const TG_LOG_PATH = path.join(
          os.homedir(),
          ".crewswarm",
          "logs",
          "telegram-bridge.jsonl",
        );
        const raw = fs.readFileSync(TG_LOG_PATH, "utf8");
        const lines = raw.trim().split("\n").filter(Boolean);
        const topics = new Map(); // chatId:threadId -> {chatId, threadId, lastSeen, text}

        lines.slice(-500).forEach((line) => {
          try {
            const entry = JSON.parse(line);
            if (entry.threadId && entry.chatId) {
              const key = `${entry.chatId}:${entry.threadId}`;
              topics.set(key, {
                chatId: entry.chatId,
                threadId: entry.threadId,
                lastSeen: entry.ts || new Date().toISOString(),
                text: (entry.text || "").slice(0, 50),
              });
            }
          } catch { }
        });

        const result = Array.from(topics.values()).sort(
          (a, b) => new Date(b.lastSeen) - new Date(a.lastSeen),
        );

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("[]");
      }
      return;
    }

    // ── WhatsApp API ──────────────────────────────────────────────────────────
    const WA_CONFIG_PATH = path.join(
      os.homedir(),
      ".crewswarm",
      "whatsapp-bridge.json",
    );
    const WA_PID_PATH = path.join(
      os.homedir(),
      ".crewswarm",
      "logs",
      "whatsapp-bridge.pid",
    );
    const WA_MSG_PATH = path.join(
      os.homedir(),
      ".crewswarm",
      "logs",
      "whatsapp-messages.jsonl",
    );
    const WA_AUTH_DIR = path.join(os.homedir(), ".crewswarm", "whatsapp-auth");

    function loadWaCfg() {
      try {
        return JSON.parse(fs.readFileSync(WA_CONFIG_PATH, "utf8"));
      } catch {
        return {};
      }
    }
    function isWaRunning() {
      try {
        const pid = parseInt(fs.readFileSync(WA_PID_PATH, "utf8").trim(), 10);
        if (!pid) return false;
        process.kill(pid, 0);
        return true;
      } catch {
        try {
          const out = execSync('pgrep -f "whatsapp-bridge.mjs"', {
            encoding: "utf8",
            timeout: 1500,
            stdio: ["pipe", "pipe", "pipe"],
          }).trim();
          return Boolean(out.split("\n").filter(Boolean).length);
        } catch {
          return false;
        }
      }
    }

    if (url.pathname === "/api/whatsapp/status") {
      const running = isWaRunning();
      const authSaved = fs.existsSync(path.join(WA_AUTH_DIR, "creds.json"));
      const cfg = loadWaCfg();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ running, authSaved, number: cfg.number || "" }));
      return;
    }

    if (url.pathname === "/api/whatsapp/config" && req.method === "GET") {
      const cfg = loadWaCfg();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          allowedNumbers: cfg.allowedNumbers || [],
          targetAgent: cfg.targetAgent || "crew-lead",
          contactNames: cfg.contactNames || {},
          userRouting: cfg.userRouting || {},
        }),
      );
      return;
    }

    if (url.pathname === "/api/whatsapp/config" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || "{}");
      const existing = loadWaCfg();
      fs.writeFileSync(
        WA_CONFIG_PATH,
        JSON.stringify({ ...existing, ...body }, null, 2),
      );
      // Also write WA_ALLOWED_NUMBERS into crewswarm.json env block so the bridge picks it up
      try {
        const swarmPath = path.join(
          os.homedir(),
          ".crewswarm",
          "crewswarm.json",
        );
        const swarm = JSON.parse(fs.readFileSync(swarmPath, "utf8"));
        swarm.env = swarm.env || {};
        if (body.allowedNumbers !== undefined) {
          swarm.env.WA_ALLOWED_NUMBERS = (body.allowedNumbers || []).join(",");
        }
        if (body.targetAgent) swarm.env.WA_TARGET_AGENT = body.targetAgent;
        fs.writeFileSync(swarmPath, JSON.stringify(swarm, null, 2));
      } catch { }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/api/whatsapp/start" && req.method === "POST") {
      if (isWaRunning()) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, message: "Already running" }));
        return;
      }
      const cfg = loadWaCfg();
      const swarm = (() => {
        try {
          return JSON.parse(
            fs.readFileSync(
              path.join(os.homedir(), ".crewswarm", "crewswarm.json"),
              "utf8",
            ),
          );
        } catch {
          return {};
        }
      })();
      const waEnv = swarm.env || {};
      const { spawn: spawnBridge } = await import("node:child_process");
      const bridgePath = path.join(CREWSWARM_DIR, "whatsapp-bridge.mjs");
      const waLogPath = path.join("/tmp", "whatsapp-bridge.log");
      const env = {
        ...process.env,
        ...(waEnv.WA_ALLOWED_NUMBERS
          ? { WA_ALLOWED_NUMBERS: waEnv.WA_ALLOWED_NUMBERS }
          : {}),
        ...(waEnv.WA_TARGET_AGENT
          ? { WA_TARGET_AGENT: waEnv.WA_TARGET_AGENT }
          : {}),
      };
      const proc = spawnBridge("node", [bridgePath], {
        env,
        detached: true,
        stdio: ["ignore", fs.openSync(waLogPath, "a"), fs.openSync(waLogPath, "a")],
        cwd: CREWSWARM_DIR,
      });
      proc.unref();
      await new Promise((r) => setTimeout(r, 1500));
      const running = isWaRunning();
      res.writeHead(running ? 200 : 500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: running,
          pid: proc.pid,
          running,
          logPath: waLogPath,
          error: running ? undefined : "WhatsApp bridge exited during startup",
        }),
      );
      return;
    }

    if (url.pathname === "/api/whatsapp/stop" && req.method === "POST") {
      try {
        const pid = parseInt(fs.readFileSync(WA_PID_PATH, "utf8").trim(), 10);
        if (pid) process.kill(pid, "SIGTERM");
      } catch { }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/api/whatsapp/messages") {
      try {
        const raw = fs.readFileSync(WA_MSG_PATH, "utf8");
        const msgs = raw
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(msgs.slice(-100)));
      } catch {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("[]");
      }
      return;
    }

    // ── Contacts API ──────────────────────────────────────────────────────────────
    if (url.pathname === "/api/contacts" && req.method === "GET") {
      try {
        const { listContacts, contactsDbAvailable } =
          await import("../lib/contacts/index.mjs");
        const platform = url.searchParams.get("platform");
        const search = url.searchParams.get("search");
        const tags = url.searchParams.get("tags");
        const contacts = contactsDbAvailable()
          ? listContacts({ platform, search, tags })
          : [];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            contacts,
            sqliteAvailable: contactsDbAvailable(),
          }),
        );
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (url.pathname === "/api/contacts/update" && req.method === "POST") {
      try {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw || "{}");
        const { contactId, ...updates } = body;
        if (!contactId) throw new Error("contactId required");
        console.log(
          "[dashboard] Updating contact:",
          contactId,
          "with:",
          JSON.stringify(updates).slice(0, 200),
        );
        const { updateContact } = await import("../lib/contacts/index.mjs");
        updateContact(contactId, updates);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        console.error("[dashboard] Contact update error:", e.message, e.stack);
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (url.pathname === "/api/contacts/delete" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let parsed;
      try { parsed = JSON.parse(raw || "{}"); } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
        return;
      }
      const vr = validate(ContactDeleteSchema, parsed);
      if (!vr.ok) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: vr.error }));
        return;
      }
      const { contactId } = vr.data;
      try {
        const { deleteContact } = await import("../lib/contacts/index.mjs");
        deleteContact(contactId);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (url.pathname === "/api/contacts/send" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let parsedSend;
      try { parsedSend = JSON.parse(raw || "{}"); } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
        return;
      }
      const vrSend = validate(ContactSendSchema, parsedSend);
      if (!vrSend.ok) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: vrSend.error }));
        return;
      }
      const { contactId, platform, message } = vrSend.data;
      try {

        const { getContact } = await import("../lib/contacts/index.mjs");
        const contact = getContact(contactId);
        if (!contact) throw new Error("Contact not found");

        const platformLinks = JSON.parse(contact.platform_links || "{}");

        // Send to WhatsApp
        if (platform === "whatsapp" || platform === "both") {
          const waJid =
            contact.platform === "whatsapp"
              ? contact.contact_id
              : platformLinks.whatsapp;
          if (waJid) {
            // Call WhatsApp bridge's sendMessage function
            const waUrl = `http://127.0.0.1:${process.env.WA_HTTP_PORT || 5015}/send`;
            const waRes = await fetch(waUrl, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ jid: waJid, text: message }),
            });
            const waData = await waRes.json().catch(() => ({}));
            if (!waRes.ok || !waData.ok) {
              throw new Error(
                waData.error ||
                  `WhatsApp send failed (${waRes.status})`,
              );
            }
          }
        }

        // Send to Telegram
        if (platform === "telegram" || platform === "both") {
          const tgChatId =
            contact.platform === "telegram"
              ? contact.contact_id.replace("telegram:", "")
              : platformLinks.telegram;
          if (tgChatId) {
            const TG_CONFIG_PATH = path.join(
              os.homedir(),
              ".crewswarm",
              "telegram-bridge.json",
            );
            const tgCfg = JSON.parse(fs.readFileSync(TG_CONFIG_PATH, "utf8"));
            const botToken = tgCfg.token;
            if (botToken) {
              const tgRes = await fetch(
                `https://api.telegram.org/bot${botToken}/sendMessage`,
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ chat_id: tgChatId, text: message }),
                },
              );
              const tgData = await tgRes.json().catch(() => ({}));
              if (!tgRes.ok || !tgData.ok) {
                throw new Error(
                  tgData.description ||
                    tgData.error ||
                    `Telegram send failed (${tgRes.status})`,
                );
              }
            }
          }
        }

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ── Services API ──────────────────────────────────────────────────────────
    if (url.pathname === "/api/services/status") {
      let services;
      try {
        const { execSync } = await import("node:child_process");
        const net = await import("node:net");

        function portListening(port, timeoutMs = 2000) {
          return new Promise((resolve) => {
            const sock = new net.default.Socket();
            let done = false;
            const finish = (value) => {
              if (done) return;
              done = true;
              try {
                sock.destroy();
              } catch { }
              resolve(value);
            };
            sock.setTimeout(timeoutMs);
            sock.once("connect", () => {
              finish(true);
            });
            sock.once("error", () => finish(false));
            sock.once("timeout", () => finish(false));
            sock.connect(port, "127.0.0.1");
          });
        }

        async function httpOk(url, timeoutMs = 3000) {
          try {
            const r = await fetch(url, {
              signal: AbortSignal.timeout(timeoutMs),
            });
            return r.ok;
          } catch {
            return false;
          }
        }

        function pidRunning(pidFile) {
          try {
            const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
            if (!pid) return null;
            process.kill(pid, 0);
            return pid;
          } catch {
            return null;
          }
        }

        function countProcs(pattern) {
          try {
            const out = execSync(`pgrep -f "${pattern}" | wc -l`, {
              encoding: "utf8",
              timeout: 300,
              stdio: ["pipe", "pipe", "pipe"],
            }).trim();
            return parseInt(out, 10) || 0;
          } catch {
            return 0;
          }
        }

        function getPid(pattern) {
          try {
            const out = execSync(`pgrep -f "${pattern}"`, {
              encoding: "utf8",
              timeout: 300,
              stdio: ["pipe", "pipe", "pipe"],
            }).trim();
            const pids = out
              .split("\n")
              .filter(Boolean)
              .map((p) => parseInt(p, 10));
            return pids.length > 0 ? pids[0] : null;
          } catch {
            return null;
          }
        }

        function getAllPids(pattern) {
          try {
            const out = execSync(`pgrep -f "${pattern}"`, {
              encoding: "utf8",
              timeout: 300,
              stdio: ["pipe", "pipe", "pipe"],
            }).trim();
            return out
              .split("\n")
              .filter(Boolean)
              .map((p) => parseInt(p, 10));
          } catch {
            return [];
          }
        }

        function procStartTime(pid) {
          try {
            const out = execSync(`ps -p ${pid} -o lstart=`, {
              encoding: "utf8",
              timeout: 300,
              stdio: ["pipe", "pipe", "pipe"],
            }).trim();
            return out ? new Date(out).getTime() : null;
          } catch {
            return null;
          }
        }

        const crewLeadPort = Number(process.env.CREW_LEAD_PORT || 5010);
        const tgPid = pidRunning(
          path.join(os.homedir(), ".crewswarm", "logs", "telegram-bridge.pid"),
        );
        const waPid =
          pidRunning(
            path.join(os.homedir(), ".crewswarm", "logs", "whatsapp-bridge.pid"),
          ) || getPid("whatsapp-bridge.mjs");
        const rtStatusPromise = fetch("http://127.0.0.1:18889/status", {
          signal: AbortSignal.timeout(2000),
        });
        const mcpHealthPromise = httpOk("http://127.0.0.1:5020/health", 3000);
        const [
          rtUp,
          crewLeadUp,
          gwUp,
          ocPortUp,
          dashUp,
          studioUp,
          watchUp,
        ] = await Promise.all([
          portListening(18889),
          portListening(crewLeadPort),
          portListening(18789),
          portListening(4096),
          portListening(listenPort),
          portListening(3333),
          portListening(3334),
        ]);
        const rtPid = getPid("opencrew-rt-daemon");
        const crewLeadPid = getPid("crew-lead.mjs");
        const gwPid = getPid("openclaw-gateway");
        const oclawPaired =
          fs.existsSync(
            path.join(os.homedir(), ".openclaw", "devices", "paired.json"),
          ) ||
          fs.existsSync(path.join(os.homedir(), ".openclaw", "device.json"));
        const ocPid =
          getPid("\\.opencode serve") ||
          getPid("opencode serve") ||
          getPid("bin/.opencode") ||
          getPid("/.opencode");
        const ocUp = ocPortUp || ocPid !== null;
        const codexInstalled = commandExists(process.env.CODEX_CLI_BIN || "codex");
        const claudeInstalled = commandExists(process.env.CLAUDE_CODE_BIN || "claude");
        const cursorInstalled = commandExists(
          process.env.CURSOR_CLI_BIN ||
            path.join(os.homedir(), ".local", "bin", "agent"),
          [path.join(os.homedir(), ".local", "bin", "agent")],
        ) || commandExists("agent", [path.join(os.homedir(), ".local", "bin", "agent")]);
        const geminiInstalled = commandExists(process.env.GEMINI_CLI_BIN || "gemini");
        const crewCliInstalled =
          commandExists("crew", [
            path.join(CREWSWARM_DIR, "crew-cli", "dist", "index.js"),
          ]) ||
          fs.existsSync(path.join(CREWSWARM_DIR, "crew-cli", "dist", "index.js"));
        let swarmCfg = {};
        try {
          swarmCfg = JSON.parse(
            fs.readFileSync(
              path.join(os.homedir(), ".crewswarm", "crewswarm.json"),
              "utf8",
            ),
          );
        } catch {}
        const cfgEnv = swarmCfg?.env || {};
        const codexEnabled =
          swarmCfg.codex === true || process.env.CREWSWARM_CODEX === "1";
        const claudeEnabled = swarmCfg.claudeCode === true;
        const cursorEnabled = swarmCfg.cursorWaves === true;
        const geminiEnabled =
          swarmCfg.geminiCli === true ||
          process.env.CREWSWARM_GEMINI_CLI_ENABLED === "1";
        const crewCliEnabled =
          swarmCfg.crewCli === true ||
          process.env.CREWSWARM_CREW_CLI_ENABLED === "1";
        const opencodeEnabled =
          cfgEnv.CREWSWARM_OPENCODE_ENABLED === "on" ||
          cfgEnv.CREWSWARM_OPENCODE_ENABLED === "1" ||
          process.env.CREWSWARM_OPENCODE_ENABLED === "on" ||
          process.env.CREWSWARM_OPENCODE_ENABLED === "1";
        const mcpPid = getPid("mcp-server.mjs");
        const studioPid =
          getPid("apps/vibe/server.mjs") || getPid("npm.*studio:start");
        const watchPid = getPid("watch-server.mjs");

        // Agent count: ask RT bus which agents are actually connected (most reliable source)
        let agentsOnline = 0;
        let rtAgentList = [];
        let agentPids = [];
        try {
          const rtStatusRes = await rtStatusPromise;
          const rtStatus = await rtStatusRes.json();
          const raw = (rtStatus.agents || []).filter(Boolean);
          rtAgentList = raw.filter(
            (a) => String(a).toLowerCase() !== "crew-lead",
          );
          agentsOnline = rtAgentList.length;
          agentPids = getAllPids("gateway-bridge.mjs --rt-daemon");
        } catch {
          // RT not reachable — fall back to pgrep for count, config for names
          agentsOnline = countProcs("gateway-bridge.mjs --rt-daemon");
          agentPids = getAllPids("gateway-bridge.mjs --rt-daemon");
          try {
            rtAgentList = (swarmCfg.agents || [])
              .map((a) => a.id)
              .filter((id) => id && String(id).toLowerCase() !== "crew-lead");
          } catch { }
        }
        // Total: count configured agents (minus crew-lead); never show X/Y with X > Y
        let agentsTotal = 0;
        try {
          agentsTotal = (swarmCfg.agents || []).filter(
            (a) => a.id && String(a.id).toLowerCase() !== "crew-lead",
          ).length;
        } catch { }
        if (agentsTotal === 0) agentsTotal = 14;
        agentsTotal = Math.max(agentsTotal, agentsOnline);
        const pmCount = countProcs("pm-loop.mjs");

        services = [
          {
            id: "rt-bus",
            label: "RT Message Bus",
            description: "opencrew-rt-daemon — agent communication backbone",
            port: 18889,
            running: rtUp,
            canRestart: true,
            pid: rtPid,
          },
          {
            id: "agents",
            label: "Sub-Agents (Worker Bridges)",
            description:
              agentsOnline > 0
                ? `${agentsOnline}/${agentsTotal} agents online — ${rtAgentList.slice(0, 5).join(", ")}${rtAgentList.length > 5 ? "…" : ""}`
                : `0/${agentsTotal} agents online — bridges not connected to RT bus`,
            port: null,
            running: agentsOnline > 0,
            canRestart: true,
            pid:
              agentPids.length > 1
                ? `${agentPids.length} procs`
                : agentPids[0] || null,
          },
          {
            id: "crew-lead",
            label: "crew-lead",
            description: "Chat commander — dashboard chat, crewchat, Telegram",
            port: crewLeadPort,
            running: crewLeadUp,
            canRestart: true,
            pid: crewLeadPid,
          },
          {
            id: "telegram",
            label: "Telegram Bridge",
            description: "@crewswarm_bot → crew-main",
            port: null,
            running: tgPid !== null,
            canRestart: true,
            pid: tgPid,
          },
          {
            id: "whatsapp",
            label: "WhatsApp Bridge",
            description:
              waPid !== null
                ? "Personal bot via Baileys — linked device active"
                : "Personal bot via Baileys — run once to scan QR",
            port: null,
            running: waPid !== null,
            canRestart: true,
            pid: waPid,
          },
          {
            id: "opencode",
            label: "OpenCode Session Server",
            description:
              "Optional OpenCode daemon for session browsing/history on port 4096. OpenCode task execution itself runs per-task like the other CLIs.",
            port: 4096,
            running: ocUp,
            canRestart: true,
            optional: true,
            pid: ocPid,
          },
          {
            id: "cli-codex",
            label: "Codex CLI Runtime",
            description: codexInstalled
              ? `Per-task Codex runner${codexEnabled ? " — globally enabled" : ""}`
              : "Codex CLI binary not found",
            port: null,
            running: codexInstalled,
            canRestart: false,
            pid: null,
            statusText: codexInstalled
              ? `● available${codexEnabled ? " · enabled" : ""}`
              : "● missing",
          },
          {
            id: "cli-claude",
            label: "Claude Code Runtime",
            description: claudeInstalled
              ? `Per-task Claude Code runner${claudeEnabled ? " — globally enabled" : ""}`
              : "Claude Code CLI binary not found",
            port: null,
            running: claudeInstalled,
            canRestart: false,
            pid: null,
            statusText: claudeInstalled
              ? `● available${claudeEnabled ? " · enabled" : ""}`
              : "● missing",
          },
          {
            id: "cli-cursor",
            label: "Cursor CLI Runtime",
            description: cursorInstalled
              ? `Per-task Cursor agent runner${cursorEnabled ? " — cursor waves enabled" : ""}`
              : "Cursor agent CLI binary not found",
            port: null,
            running: cursorInstalled,
            canRestart: false,
            pid: null,
            statusText: cursorInstalled
              ? `● available${cursorEnabled ? " · enabled" : ""}`
              : "● missing",
          },
          {
            id: "cli-gemini",
            label: "Gemini CLI Runtime",
            description: geminiInstalled
              ? `Per-task Gemini runner${geminiEnabled ? " — globally enabled" : ""}`
              : "Gemini CLI binary not found",
            port: null,
            running: geminiInstalled,
            canRestart: false,
            pid: null,
            statusText: geminiInstalled
              ? `● available${geminiEnabled ? " · enabled" : ""}`
              : "● missing",
          },
          {
            id: "cli-crew",
            label: "crew-cli Runtime",
            description: crewCliInstalled
              ? `Per-task crew-cli runner${crewCliEnabled ? " — globally enabled" : ""}`
              : "crew-cli build/binary not found",
            port: null,
            running: crewCliInstalled,
            canRestart: false,
            pid: null,
            statusText: crewCliInstalled
              ? `● available${crewCliEnabled ? " · enabled" : ""}`
              : "● missing",
          },
          {
            id: "dashboard",
            label: "Dashboard",
            description: "This dashboard — will briefly disconnect then reload",
            port: listenPort,
            running: dashUp,
            canRestart: true,
            pid: process.pid,
          },
          {
            id: "mcp",
            label: "MCP + OpenAI API",
            description:
              "MCP tools + /v1/chat/completions for Open WebUI, LM Studio, Aider — port 5020",
            port: 5020,
            running: await mcpHealthPromise,
            canRestart: true,
            pid: mcpPid,
          },
          {
            id: "studio",
            label: "Vibe UI",
            description: studioUp
              ? "Monaco editor + agent chat — Cursor-like IDE for crewswarm"
              : "Run: npm run vibe:start (port 3333)",
            port: 3333,
            running: studioUp,
            canRestart: true,
            optional: true,
            pid: studioPid,
          },
          {
            id: "studio-watch",
            label: "Vibe Watch Server",
            description: watchUp
              ? "CLI → Vibe live reload WebSocket relay (port 3334)"
              : "Run: npm run vibe:watch — enables live file reload in Vibe",
            port: 3334,
            running: watchUp,
            canRestart: true,
            optional: true,
            pid: watchPid,
          },
          {
            id: "openclaw-gateway",
            label: "OpenClaw Gateway (optional)",
            description: gwUp
              ? oclawPaired
                ? "App paired ✓ — legacy plugin communicating via port 18789"
                : "Listening on port 18789 — legacy only"
              : "Optional legacy service (port 18789). Only needed if using the OpenClaw desktop app. crewswarm works fully without it.",
            port: 18789,
            running: gwUp,
            optional: true,
            canRestart: true,
            pid: gwPid,
          },
          {
            id: "pm-loops",
            label: "PM Loops",
            description: (() => {
              if (pmCount === 0) return "No active PM loops";
              if (pmCount === 1) return "1 PM loop running (managing roadmap)";
              return `${pmCount} PM loops running ⚠️ (should be 0-1)`;
            })(),
            port: null,
            running: pmCount > 0,
            optional: true,
            canRestart: false,
            pid: (() => {
              try {
                const pids = execSync("pgrep -f 'pm-loop.mjs'", {
                  encoding: "utf8",
                  timeout: 300,
                  stdio: ["pipe", "pipe", "pipe"],
                }).trim().split("\n").filter(Boolean).map(p => parseInt(p, 10));
                return pids.length === 1 ? pids[0] : pids;
              } catch {
                return null;
              }
            })(),
            count: pmCount,
          },
        ];
      } catch (statusErr) {
        console.error(
          "[dashboard] /api/services/status error:",
          statusErr?.message || statusErr,
        );
        services = [
          {
            id: "rt-bus",
            label: "RT Message Bus",
            description: "opencrew-rt-daemon",
            port: 18889,
            running: false,
            canRestart: true,
            pid: null,
          },
          {
            id: "agents",
            label: "Sub-Agents (Worker Bridges)",
            description: "0 agents connected",
            port: null,
            running: false,
            canRestart: true,
            pid: null,
          },
          {
            id: "crew-lead",
            label: "crew-lead",
            description: "Chat commander",
            port: 5010,
            running: false,
            canRestart: true,
            pid: null,
          },
          {
            id: "telegram",
            label: "Telegram Bridge",
            description: "@crewswarm_bot",
            port: null,
            running: false,
            canRestart: true,
            pid: null,
          },
          {
            id: "opencode",
            label: "OpenCode Session Server",
            description: "Optional OpenCode daemon for session browsing/history — port 4096",
            port: 4096,
            running: false,
            canRestart: true,
            optional: true,
            pid: null,
          },
          {
            id: "cli-codex",
            label: "Codex CLI Runtime",
            description: "Per-task Codex runner",
            port: null,
            running: false,
            canRestart: false,
            pid: null,
            statusText: "● unknown",
          },
          {
            id: "cli-claude",
            label: "Claude Code Runtime",
            description: "Per-task Claude Code runner",
            port: null,
            running: false,
            canRestart: false,
            pid: null,
            statusText: "● unknown",
          },
          {
            id: "cli-cursor",
            label: "Cursor CLI Runtime",
            description: "Per-task Cursor agent runner",
            port: null,
            running: false,
            canRestart: false,
            pid: null,
            statusText: "● unknown",
          },
          {
            id: "cli-gemini",
            label: "Gemini CLI Runtime",
            description: "Per-task Gemini runner",
            port: null,
            running: false,
            canRestart: false,
            pid: null,
            statusText: "● unknown",
          },
          {
            id: "cli-crew",
            label: "crew-cli Runtime",
            description: "Per-task crew-cli runner",
            port: null,
            running: false,
            canRestart: false,
            pid: null,
            statusText: "● unknown",
          },
          {
            id: "dashboard",
            label: "Dashboard",
            description: "This dashboard",
            port: listenPort,
            running: true,
            canRestart: true,
            pid: process.pid,
          },
          {
            id: "openclaw-gateway",
            label: "OpenClaw Gateway (optional)",
            description:
              "Optional legacy service — only needed if using the OpenClaw desktop app",
            port: 18789,
            running: false,
            optional: true,
            canRestart: true,
            pid: null,
          },
        ];
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(services));
      return;
    }

    if (url.pathname === "/api/services/restart" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let parsed;
      try { parsed = JSON.parse(raw || "{}"); } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
        return;
      }
      const vr = validate(ServiceActionSchema, parsed);
      if (!vr.ok) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: vr.error }));
        return;
      }
      const { id } = vr.data;
      const { execFileSync } = await import("node:child_process");

      if (id === "dashboard") {
        // Dashboard cannot restart itself - race condition between spawn and exit
        // Manual restart: pkill -9 -f dashboard.mjs && npm run dashboard
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            message:
              "Dashboard cannot restart itself (prevents race condition). Manual restart: pkill -9 -f dashboard.mjs && npm run dashboard",
          }),
        );
        return;
      }

      try {
        const restartScript = path.join(
          CREWSWARM_DIR,
          "scripts",
          "restart-service.sh",
        );
        const output = execFileSync("bash", [restartScript, id], {
          cwd: CREWSWARM_DIR,
          env: process.env,
          encoding: "utf8",
          timeout: 30000,
        }).trim();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, message: output || `${id} restarted` }));
        return;
      } catch (err) {
        const message =
          err?.stderr?.toString?.().trim?.() ||
          err?.stdout?.toString?.().trim?.() ||
          err?.message ||
          `Failed to restart ${id}`;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, message }));
        return;
      }
    }

    if (url.pathname === "/api/services/stop" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const { id } = JSON.parse(raw || "{}");
      const { execSync } = await import("node:child_process");

      if (id === "agents") {
        try {
          execSync(`pkill -f "gateway-bridge.mjs --rt-daemon"`, {
            stdio: "ignore",
          });
        } catch { }
      } else if (id === "telegram") {
        try {
          const pid = parseInt(
            fs
              .readFileSync(
                path.join(
                  os.homedir(),
                  ".crewswarm",
                  "logs",
                  "telegram-bridge.pid",
                ),
                "utf8",
              )
              .trim(),
            10,
          );
          if (pid) process.kill(pid, "SIGTERM");
        } catch { }
      } else if (id === "whatsapp") {
        try {
          const pid = parseInt(
            fs
              .readFileSync(
                path.join(
                  os.homedir(),
                  ".crewswarm",
                  "logs",
                  "whatsapp-bridge.pid",
                ),
                "utf8",
              )
              .trim(),
            10,
          );
          if (pid) process.kill(pid, "SIGTERM");
        } catch { }
      } else if (id === "crew-lead") {
        // Use PID file for reliable killing (prevents collateral dashboard deaths)
        const pidFile = path.join(
          os.homedir(),
          ".crewswarm",
          "logs",
          "crew-lead.pid",
        );
        let killed = false;

        try {
          if (fs.existsSync(pidFile)) {
            const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
            if (pid && !isNaN(pid)) {
              try {
                process.kill(pid, 0); // Check if process exists
                process.kill(pid, "SIGTERM");
                await new Promise((r) => setTimeout(r, 500));
                killed = true;
                console.log(
                  `[dashboard] Stopped crew-lead via PID file (pid ${pid})`,
                );
              } catch (e) {
                // Process doesn't exist, clean up stale PID file
                fs.writeFileSync(pidFile, "");
              }
            }
          }
        } catch (e) {
          console.warn(`[dashboard] PID file method failed: ${e.message}`);
        }

        // Fallback: pattern-based kill only if PID method didn't work
        if (!killed) {
          try {
            execSync(
              `pgrep -f "^node.*crew-lead\\.mjs$" | xargs kill -9 2>/dev/null`,
              { stdio: "ignore", shell: true },
            );
            console.log(
              `[dashboard] Stopped crew-lead via pattern match (fallback)`,
            );
          } catch { }
        }

        // NOTE: We do NOT kill by port here - that can kill dashboard's connection to crew-lead
        // and cause dashboard to crash. PID file method is reliable enough.
      } else if (id === "rt-bus") {
        try {
          execSync(`pkill -f "opencrew-rt-daemon"`, { stdio: "ignore" });
        } catch { }
      } else if (id === "openclaw-gateway") {
        try {
          execSync(`pkill -f "openclaw-gateway"`, { stdio: "ignore" });
        } catch { }
        await new Promise((r) => setTimeout(r, 1000));
        try {
          execSync(`open -a OpenClaw`, { stdio: "ignore" });
        } catch { }
      } else if (id === "studio") {
        try {
          execSync(`pkill -f "apps/vibe/server.mjs"`, { stdio: "ignore" });
        } catch { }
        try {
          execSync(`pkill -f "vite.*studio"`, { stdio: "ignore" });
        } catch { }
        try {
          execSync(`lsof -ti :3333 | xargs kill -9 2>/dev/null`, {
            stdio: "ignore",
            shell: true,
          });
        } catch { }
        try {
          execSync(`lsof -ti :3335 | xargs kill -9 2>/dev/null`, {
            stdio: "ignore",
            shell: true,
          });
        } catch { }
      } else if (id === "studio-watch") {
        try {
          execSync(`pkill -f "watch-server.mjs"`, { stdio: "ignore" });
        } catch { }
        try {
          execSync(`lsof -ti :3334 | xargs kill -9 2>/dev/null`, {
            stdio: "ignore",
            shell: true,
          });
        } catch { }
      } else if (id === "opencode") {
        try {
          execSync(`pkill -f "opencode serve"`, { stdio: "ignore" });
        } catch { }
      } else if (id === "mcp") {
        try {
          execSync(`pkill -f "mcp-server.mjs"`, { stdio: "ignore" });
        } catch { }
        try {
          execSync(`lsof -ti :5020 | xargs kill -9 2>/dev/null`, {
            stdio: "ignore",
            shell: true,
          });
        } catch { }
      } else if (id === "dashboard") {
        // Dashboard cannot restart/stop itself - race condition between spawn and exit
        // Use: pkill -9 -f dashboard.mjs to stop manually
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            message:
              "Dashboard cannot stop/restart itself. Use: pkill -9 -f dashboard.mjs",
          }),
        );
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── Skills + Spending proxy → crew-lead:5010 ──────────────────────────────
    // These routes read the auth token and proxy to the crew-lead HTTP API so
    // the browser doesn't need to know the token.
    const CREW_LEAD_URL = "http://127.0.0.1:5010";
    function getCLToken() {
      return resolveCrewLeadAuthToken();
    }
    async function proxyToCL(method, path_, body) {
      const token = getCLToken();
      const opts = {
        method,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(15000),
      };
      if (body) opts.body = body;
      try {
        const r = await fetch(CREW_LEAD_URL + path_, opts);
        const text = await r.text();
        return { status: r.status, body: text };
      } catch (err) {
        // crew-lead is down or unreachable - return 503 instead of crashing
        return {
          status: 503,
          body: JSON.stringify({
            error: "crew-lead unreachable",
            detail: String(err?.message || err),
            hint: "Start crew-lead: npm run restart-all",
          }),
        };
      }
    }

    // ── ZeroEval / llm-stats benchmark API proxy ────────────────────────────────
    // Data from https://llm-stats.com (api.zeroeval.com) — SWE-Bench, LiveCodeBench, etc.
    const zeroevalBenchMatch = url.pathname.match(
      /^\/api\/zeroeval\/benchmarks(?:\/([a-zA-Z0-9_\-\(\)\.%]+))?$/,
    );
    if (zeroevalBenchMatch && req.method === "GET") {
      const benchmarkId = zeroevalBenchMatch[1]
        ? decodeURIComponent(zeroevalBenchMatch[1])
        : null;
      const zurl = benchmarkId
        ? `https://api.zeroeval.com/leaderboard/benchmarks/${encodeURIComponent(benchmarkId)}`
        : "https://api.zeroeval.com/leaderboard/benchmarks";
      try {
        const r = await fetch(zurl, { signal: AbortSignal.timeout(15000) });
        const text = await r.text();
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(text);
      } catch (err) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: "ZeroEval API unreachable",
            detail: String(err?.message || err),
          }),
        );
      }
      return;
    }

    // ── Benchmark runner — fetch SWE-Bench / LiveCodeBench tasks and run on a local engine ──
    // GET  /api/benchmark-tasks?benchmark=swe-bench-verified&offset=0&length=20
    //   → proxies HuggingFace dataset rows for SWE-Bench Verified
    // POST /api/benchmark-run
    //   body: { instanceId, problemStatement, repo, engine, model, projectDir }
    //   → builds a structured prompt and streams it through engine-passthrough SSE
    if (url.pathname === "/api/benchmark-tasks" && req.method === "GET") {
      const offset = parseInt(url.searchParams.get("offset") || "0", 10);
      const length = Math.min(
        parseInt(url.searchParams.get("length") || "20", 10),
        50,
      );
      const benchmark =
        url.searchParams.get("benchmark") || "swe-bench-verified";
      let hfUrl;
      if (benchmark === "swe-bench-verified" || benchmark === "swe-bench") {
        hfUrl = `https://datasets-server.huggingface.co/rows?dataset=princeton-nlp%2FSWE-bench_Verified&config=default&split=test&offset=${offset}&length=${length}`;
      } else if (benchmark === "livecodebench") {
        hfUrl = `https://datasets-server.huggingface.co/rows?dataset=livecodebench%2Flivecodebench&config=default&split=test&offset=${offset}&length=${length}`;
      } else {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error:
              "Unsupported benchmark for task runner. Supported: swe-bench-verified, livecodebench",
          }),
        );
        return;
      }
      try {
        const r = await fetch(hfUrl, { signal: AbortSignal.timeout(15000) });
        const text = await r.text();
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(text);
      } catch (err) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: "HuggingFace dataset unreachable",
            detail: String(err?.message || err),
          }),
        );
      }
      return;
    }

    if (url.pathname === "/api/benchmark-run" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const {
        instanceId,
        problemStatement,
        repo,
        hints,
        engine = "claude",
        model,
        projectDir,
      } = JSON.parse(body || "{}");
      if (!instanceId || !problemStatement) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: "instanceId and problemStatement required" }),
        );
        return;
      }
      const prompt = [
        `# SWE-Bench Task: ${instanceId}`,
        repo ? `Repository: ${repo}` : "",
        "",
        "## Problem Statement",
        problemStatement.trim(),
        hints ? `\n## Hints\n${hints.trim()}` : "",
        "",
        "## Your Task",
        "Analyze the problem statement above. Identify the root cause of the bug or missing feature.",
        "Write a minimal, correct patch that fixes the issue. Output the patch in unified diff format.",
        "Do not modify tests. Do not add unrelated changes.",
      ]
        .filter(Boolean)
        .join("\n");

      const token = (() => {
        try {
          return (
            JSON.parse(
              fs.readFileSync(
                path.join(os.homedir(), ".crewswarm", "crewswarm.json"),
                "utf8",
              ),
            )?.rt?.authToken || ""
          );
        } catch {
          return "";
        }
      })();
      try {
        const upstream = await fetch(
          "http://127.0.0.1:5010/api/engine-passthrough",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({
              engine,
              message: prompt,
              projectDir: projectDir || process.cwd(),
              ...(model ? { model } : {}),
            }),
          },
        );
        res.writeHead(upstream.status, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "access-control-allow-origin": "*",
        });
        const reader = upstream.body.getReader();
        const pump = async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                try {
                  res.end();
                } catch { }
                break;
              }
              try {
                res.write(value);
              } catch {
                reader.cancel();
                break;
              }
            }
          } catch { }
        };
        pump();
        req.on("close", () => {
          try {
            reader.cancel();
          } catch { }
        });
      } catch (e) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({ type: "done", exitCode: 1, error: e.message })}\n\n`,
        );
        res.end();
      }
      return;
    }

    // Proxy test webhook through dashboard (avoids browser needing token)
    const webhookProxyMatch = url.pathname.match(
      /^\/proxy-webhook\/([a-zA-Z0-9_\-]+)$/,
    );
    if (webhookProxyMatch && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { status, body: rb } = await proxyToCL(
        "POST",
        `/webhook/${webhookProxyMatch[1]}`,
        body || "{}",
      );
      res.writeHead(status, { "content-type": "application/json" });
      res.end(rb);
      return;
    }

    // Proxy health (single source for skills + agent tools) and agent restart
    if (url.pathname === "/api/health" && req.method === "GET") {
      const { status, body: rb } = await proxyToCL(
        "GET",
        "/api/health",
        undefined,
      );
      res.writeHead(status, { "content-type": "application/json" });
      res.end(rb);
      return;
    }
    const agentRestartMatch = url.pathname.match(
      /^\/api\/agents\/([^/]+)\/restart$/,
    );
    if (agentRestartMatch && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { status, body: rb } = await proxyToCL(
        "POST",
        url.pathname,
        body || undefined,
      );
      res.writeHead(status, { "content-type": "application/json" });
      res.end(rb);
      return;
    }

    // ── Engines API ─────────────────────────────────────────────────────────────
    if (url.pathname === "/api/engines" && req.method === "GET") {
      try {
        const { execSync } = await import("node:child_process");
        const bundledDir = path.join(
          path.dirname(new URL(import.meta.url).pathname),
          "..",
          "engines",
        );
        const userDir = path.join(os.homedir(), ".crewswarm", "engines");
        const enginesMap = {};
        for (const dir of [bundledDir, userDir]) {
          if (!fs.existsSync(dir)) continue;
          for (const f of fs
            .readdirSync(dir)
            .filter((f) => f.endsWith(".json"))) {
            try {
              const eng = JSON.parse(
                fs.readFileSync(path.join(dir, f), "utf8"),
              );
              if (eng.id)
                enginesMap[eng.id] = {
                  ...eng,
                  source: dir === userDir ? "user" : "bundled",
                };
            } catch { }
          }
        }
        // Load env vars to check enabled status
        const configPath = path.join(os.homedir(), ".crewswarm", "crewswarm.json");
        let envVars = {};
        try {
          const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
          envVars = cfg.env || {};
        } catch { }

        const engines = Object.values(enginesMap).map((eng) => {
          let installed = false;
          try {
            const bin = eng.bin || eng.id;
            execSync(`which ${bin}`, { stdio: "ignore" });
            installed = true;
          } catch {
            if (eng.binAlternate) {
              const alt = eng.binAlternate.replace(/^~/, os.homedir());
              installed = fs.existsSync(alt);
            }
          }
          const missingEnv = eng.requiresAuth
            ? []
            : (eng.requiresEnv || []).filter((k) => !process.env[k]);

          // Check if globally enabled
          let enabled = false;
          if (eng.envToggle) {
            const val = envVars[eng.envToggle];
            enabled = val === "1" || val === "true" || val === "yes";
          }

          return {
            ...eng,
            installed,
            missingEnv,
            ready: installed && missingEnv.length === 0,
            enabled,
          };
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ engines }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === "/api/engines/import" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const { url: engineUrl } = JSON.parse(body || "{}");
        if (!engineUrl) throw new Error("url required");
        const rawUrl = engineUrl
          .replace("github.com", "raw.githubusercontent.com")
          .replace("/blob/", "/");
        const resp = await fetch(rawUrl, {
          signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const eng = await resp.json();
        if (!eng.id || !eng.label)
          throw new Error("Engine descriptor must have id and label");
        const engDir = path.join(os.homedir(), ".crewswarm", "engines");
        if (!fs.existsSync(engDir)) fs.mkdirSync(engDir, { recursive: true });
        const outPath = path.join(engDir, `${eng.id}.json`);
        if (!outPath.startsWith(engDir)) throw new Error("Invalid engine id");
        fs.writeFileSync(outPath, JSON.stringify(eng, null, 2), "utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, id: eng.id, label: eng.label }));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === "/api/engines/toggle" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const { engineId, enabled } = JSON.parse(body || "{}");
        if (!engineId) throw new Error("engineId required");

        const bundledDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "engines");
        const userDir = path.join(os.homedir(), ".crewswarm", "engines");

        let engineDef = null;
        for (const dir of [bundledDir, userDir]) {
          const p = path.join(dir, `${engineId}.json`);
          if (fs.existsSync(p)) {
            engineDef = JSON.parse(fs.readFileSync(p, "utf8"));
            break;
          }
        }

        if (!engineDef || !engineDef.envToggle) {
          throw new Error(`Engine ${engineId} not found or has no envToggle`);
        }

        const envVarName = engineDef.envToggle;
        const configPath = path.join(os.homedir(), ".crewswarm", "crewswarm.json");
        const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));

        if (!cfg.env) cfg.env = {};
        cfg.env[envVarName] = enabled ? "1" : "off";

        fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf8");

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, engineId, enabled, envVar: envVarName }));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname.startsWith("/api/engines/") && req.method === "DELETE") {
      const id = url.pathname.split("/").pop();
      const engDir = path.join(os.homedir(), ".crewswarm", "engines");
      const target = path.join(engDir, `${id}.json`);
      if (!target.startsWith(engDir)) {
        res.writeHead(400);
        res.end("{}");
        return;
      }
      try {
        fs.unlinkSync(target);
      } catch { }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Skill import from URL — handled directly (not proxied, needs outbound fetch)
    if (url.pathname === "/api/skills/import" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        let parsed;
        try { parsed = JSON.parse(body || "{}"); } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
          return;
        }
        const vr = validate(ImportSkillSchema, parsed);
        if (!vr.ok) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: vr.error }));
          return;
        }
        const { url: skillUrl } = vr.data;

        // ── Security: validate import source URL ─────────────────────────────
        let parsedImportUrl;
        try {
          parsedImportUrl = new URL(skillUrl);
        } catch {
          throw new Error("Invalid URL");
        }
        const importHost = parsedImportUrl.hostname.toLowerCase();
        // Block SSRF: reject private/loopback addresses and non-HTTPS sources
        const BLOCKED_HOSTS =
          /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1|0\.0\.0\.0)/;
        if (BLOCKED_HOSTS.test(importHost))
          throw new Error(
            "Blocked: cannot import from private/loopback addresses",
          );
        if (parsedImportUrl.protocol !== "https:")
          throw new Error("Only HTTPS import URLs are allowed");

        // Convert GitHub blob URLs to raw
        const rawUrl = skillUrl
          .replace("https://github.com/", "https://raw.githubusercontent.com/")
          .replace("/blob/", "/");

        const resp = await fetch(rawUrl, {
          signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok)
          throw new Error(`Fetch failed: ${resp.status} ${resp.statusText}`);
        const text = await resp.text();
        // Reject unreasonably large skill files (>64KB)
        if (text.length > 65536)
          throw new Error("Skill file too large (>64KB)");

        let skill;
        const lowerUrl = rawUrl.toLowerCase();

        if (lowerUrl.endsWith(".json")) {
          // JSON skill format
          skill = JSON.parse(text);
          if (!skill.description)
            throw new Error("Invalid skill JSON: missing description");
        } else {
          // SKILL.md format — parse YAML frontmatter
          const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
          const fm = {};
          if (fmMatch) {
            for (const line of fmMatch[1].split(/\r?\n/)) {
              const m = line.match(/^(\w[\w-]*):\s*(.+)/);
              if (m) fm[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
            }
          }
          const urlParts = rawUrl.split("/");
          const fileBase = urlParts[urlParts.length - 1].replace(
            /\.(md|json)$/i,
            "",
          );
          const folderName = urlParts[urlParts.length - 2] || fileBase;
          skill = {
            description:
              fm.description || fm.name || `Skill from ${folderName}`,
            url: fm.url || "",
            method: fm.method || "POST",
          };
          if (fm.name) skill._importedName = fm.name;
          const body2 = text.replace(/^---[\s\S]*?---\r?\n/, "").trim();
          if (body2) skill.paramNotes = body2.slice(0, 500);
        }

        // ── Security: scan the skill payload itself ───────────────────────────
        const warnings = [];
        // Flag cmd-type skills (can execute arbitrary shell commands)
        if (skill.type === "cmd" || skill.cmd) {
          warnings.push(
            "cmd_skill: this skill executes shell commands via @@RUN_CMD",
          );
        }
        // Flag skill URLs targeting private/loopback ranges (SSRF in skill execution)
        if (skill.url) {
          try {
            const su = new URL(skill.url.replace(/\{[^}]*\}/g, "placeholder"));
            const sh = su.hostname.toLowerCase();
            if (BLOCKED_HOSTS.test(sh))
              warnings.push(
                "ssrf_risk: skill url targets a private/loopback address",
              );
            if (su.protocol !== "https:" && !sh.includes("localhost"))
              warnings.push("insecure_url: skill url uses non-HTTPS");
          } catch {
            /* relative or template URL — ok */
          }
        }
        // Flag requiresApproval=false on skills that write data (POST/PUT/DELETE)
        const method = (skill.method || "GET").toUpperCase();
        if (
          ["POST", "PUT", "DELETE", "PATCH"].includes(method) &&
          skill.requiresApproval === false
        ) {
          warnings.push(
            "no_approval: write-method skill has requiresApproval:false — agents can use it without confirmation",
          );
        }

        // Determine skill name: prefer explicit field, else infer from URL
        const urlParts = rawUrl.split("/");
        const fileBase = urlParts[urlParts.length - 1].replace(
          /\.(md|json)$/i,
          "",
        );
        const folderName = urlParts[urlParts.length - 2];
        const rawName =
          skill.name ||
          skill._importedName ||
          (folderName && folderName !== "skills" ? folderName : fileBase);
        // Sanitize: strip path traversal, lowercase, replace unsafe chars
        const skillName = rawName
          .toLowerCase()
          .replace(/\.\./g, "")
          .replace(/[^a-z0-9._-]/g, "-")
          .replace(/^[-.]|[-.]$/g, "");
        if (!skillName)
          throw new Error("Could not determine a valid skill name");
        delete skill._importedName;
        delete skill.name;

        // Save to ~/.crewswarm/skills/<name>.json
        const skillsDir = path.join(
          process.env.HOME || "/tmp",
          ".crewswarm",
          "skills",
        );
        if (!fs.existsSync(skillsDir))
          fs.mkdirSync(skillsDir, { recursive: true });
        const outPath = path.join(skillsDir, `${skillName}.json`);
        // Final path traversal guard
        if (!outPath.startsWith(skillsDir))
          throw new Error("Invalid skill name");
        fs.writeFileSync(outPath, JSON.stringify(skill, null, 2), "utf8");

        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            name: skillName,
            skill,
            path: outPath,
            warnings,
          }),
        );
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    const skillsMatch = url.pathname.match(/^\/api\/skills(\/.*)?$/);
    if (skillsMatch) {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { status, body: rb } = await proxyToCL(
        req.method,
        url.pathname + (url.search || ""),
        body || undefined,
      );
      res.writeHead(status, { "content-type": "application/json" });
      res.end(rb);
      return;
    }

    if (url.pathname.startsWith("/api/spending")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { status, body: rb } = await proxyToCL(
        req.method,
        url.pathname + (url.search || ""),
        body || undefined,
      );
      res.writeHead(status, { "content-type": "application/json" });
      res.end(rb);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
    }
  }
});

if (process.argv.includes("--print-html")) {
  process.stdout.write(html, (err) => process.exit(err ? 1 : 0));
} else {
  let _dashPortRetries = 0;
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      if (_dashPortRetries < 5) {
        _dashPortRetries++;
        const wait = _dashPortRetries * 2000;
        console.error(
          `[dashboard] Port ${listenPort} in use — retry ${_dashPortRetries}/5 in ${wait / 1000}s`,
        );
        setTimeout(() => server.listen(listenPort, listenHost), wait);
      } else {
        console.error(
          `[dashboard] Port ${listenPort} still in use after 5 retries — exiting`,
        );
        console.error(
          `[dashboard] Free the port:  lsof -nP -iTCP:${listenPort} -sTCP:LISTEN`,
        );
        console.error(
          `[dashboard] Then:            kill -9 $(lsof -ti :${listenPort})`,
        );
        process.exit(1);
      }
    } else {
      console.error("[dashboard] server error:", err.message);
      process.exit(1);
    }
  });
  server.listen(listenPort, listenHost, () => {
    console.log(
      `crewswarm Dashboard (with Build) at http://${listenHost}:${listenPort}`,
    );
  });
}

process.on("uncaughtException", (err) => {
  const msg = String(err?.message || err || "");
  console.error(
    "[dashboard] uncaughtException:",
    err?.stack || msg,
  );

  // Benign errors from engine passthrough / SSE streams — keep alive
  if (
    msg === "terminated" ||
    msg === "aborted" ||
    /client.*disconnect/i.test(msg) ||
    /socket hang up/i.test(msg) ||
    /ECONNRESET/i.test(msg) ||
    /EPIPE/i.test(msg) ||
    /fetch failed/i.test(msg) ||
    /UND_ERR/i.test(msg)
  ) {
    console.error("[dashboard] Non-fatal uncaughtException — keeping alive");
    return;
  }

  // Fatal errors: port conflicts, permissions, OOM — must exit
  if (/EADDRINUSE|EACCES|out of memory|cannot allocate/i.test(msg)) {
    console.error("[dashboard] FATAL — exiting due to uncaught exception");
    process.exit(1);
  }

  // Default: log but keep alive — engine passthrough errors shouldn't kill the dashboard
  console.error("[dashboard] Unexpected uncaughtException — keeping alive (not fatal)");
});

process.on("unhandledRejection", (reason) => {
  const msg = reason?.message || String(reason);

  // Benign errors: SSE/fetch aborted when client disconnects — keep alive
  if (
    msg === "terminated" ||
    msg === "aborted" ||
    /client.*disconnect/i.test(msg)
  ) {
    return; // Silent — normal operation
  }

  console.error("[dashboard] unhandledRejection:", msg);
  console.error("Stack:", reason?.stack);

  // Critical errors: die gracefully
  if (/EADDRINUSE|EACCES|out of memory|cannot allocate/i.test(msg)) {
    console.error("[dashboard] FATAL — exiting");
    process.exit(1);
  }
  // Non-critical: keep alive but warn
});
