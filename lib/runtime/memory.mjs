/**
 * lib/runtime/memory.mjs
 * Shared memory bundle loading, agent prompt loading, and task prompt assembly.
 * Extracted from gateway-bridge.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Constants ────────────────────────────────────────────────────────────────

export const SHARED_MEMORY_DIR = path.resolve(process.cwd(), "memory");
export const SHARED_MEMORY_MAX_FILE_CHARS = 8000;
export const SHARED_MEMORY_MAX_TOTAL_CHARS = 40000;
export const SHARED_MEMORY_FILES = [
  "law.md",                    // Crew laws — no harm, no unauthorized access, don't break machine, create value
  "current-state.md",          // System overview — what CrewSwarm is, CRITICAL task guidance
  "agent-handoff.md",          // Current status, last completed work, agent rules
  "orchestration-protocol.md", // Agent roster, tool permissions, dispatch syntax
  "brain.md",                  // Accumulated project knowledge — read this to avoid repeating mistakes
  // "decisions.md"            // Architectural decisions — only load when needed
  // "telegram-context.md"     // Telegram chat history — too noisy for code tasks
];

// Extra memory files injected for specific agents (static) + dynamic agents by _role
export const _AGENT_EXTRA_MEMORY_STATIC = {
  "crew-fixer":       ["lessons.md"],
  "crew-coder":       ["lessons.md"],
  "crew-coder-front": ["lessons.md"],
  "crew-coder-back":  ["lessons.md"],
};
export const _EXTRA_MEMORY_BY_ROLE = { coder: ["lessons.md"], ops: ["lessons.md"] };

// ── Injected dependencies ────────────────────────────────────────────────────

let _telemetry = () => {};
let _ensureSharedMemoryFiles = () => ({ created: [], error: null });
let _loadAgentList = () => [];
let _loadAgentToolPermissions = () => new Set();
let _buildToolInstructions = () => "";
let _getOpencodeProjectDir = () => "";

export function initMemory({
  telemetry,
  ensureSharedMemoryFiles,
  loadAgentList,
  loadAgentToolPermissions,
  buildToolInstructions,
  getOpencodeProjectDir,
}) {
  if (telemetry)              _telemetry = telemetry;
  if (ensureSharedMemoryFiles) _ensureSharedMemoryFiles = ensureSharedMemoryFiles;
  if (loadAgentList)          _loadAgentList = loadAgentList;
  if (loadAgentToolPermissions) _loadAgentToolPermissions = loadAgentToolPermissions;
  if (buildToolInstructions)  _buildToolInstructions = buildToolInstructions;
  if (getOpencodeProjectDir)  _getOpencodeProjectDir = getOpencodeProjectDir;
}

// ── Functions ────────────────────────────────────────────────────────────────

export function getAgentExtraMemory(agentId) {
  const bareId = agentId.startsWith("crew-") ? `crew-${agentId.slice(5)}` : agentId;
  if (_AGENT_EXTRA_MEMORY_STATIC[agentId]) return _AGENT_EXTRA_MEMORY_STATIC[agentId];
  if (_AGENT_EXTRA_MEMORY_STATIC[bareId]) return _AGENT_EXTRA_MEMORY_STATIC[bareId];
  try {
    const agents = _loadAgentList();
    const cfg = agents.find(a => a.id === agentId);
    if (cfg?._role && _EXTRA_MEMORY_BY_ROLE[cfg._role]) return _EXTRA_MEMORY_BY_ROLE[cfg._role];
  } catch {}
  return [];
}

export function loadSharedMemoryBundle() {
  try {
    const ensureResult = _ensureSharedMemoryFiles();
    if (ensureResult.error) {
      return {
        text: "",
        missing: SHARED_MEMORY_FILES,
        included: [],
        files: {},
        bytes: 0,
        loadFailed: true,
        bootstrapCreated: ensureResult.created,
      };
    }

    if (!fs.existsSync(SHARED_MEMORY_DIR)) {
      return {
        text: "",
        missing: SHARED_MEMORY_FILES,
        included: [],
        files: {},
        bytes: 0,
        loadFailed: true,
        bootstrapCreated: ensureResult.created,
      };
    }

    const included = [];
    const missing = [];
    const files = {};
    const sections = [];
    let totalChars = 0;

    for (const fileName of SHARED_MEMORY_FILES) {
      const fullPath = path.join(SHARED_MEMORY_DIR, fileName);
      if (!fs.existsSync(fullPath)) {
        missing.push(fileName);
        continue;
      }

      let content = fs.readFileSync(fullPath, "utf8");
      if (content.length > SHARED_MEMORY_MAX_FILE_CHARS) {
        // For append-only files keep the TAIL (newest entries); for others keep the HEAD
        const TAIL_FIRST_FILES = new Set(["brain.md", "session-log.md", "telegram-context.md"]);
        if (TAIL_FIRST_FILES.has(fileName)) {
          content = `[…older entries trimmed]\n\n${content.slice(-SHARED_MEMORY_MAX_FILE_CHARS)}`;
        } else {
          content = `${content.slice(0, SHARED_MEMORY_MAX_FILE_CHARS)}\n\n[truncated]`;
        }
      }

      files[fileName] = content;
      const section = `### ${fileName}\n${content}`;
      if (totalChars + section.length > SHARED_MEMORY_MAX_TOTAL_CHARS) break;

      sections.push(section);
      included.push(fileName);
      totalChars += section.length;
    }

    if (!sections.length) {
      return {
        text: "",
        missing,
        included,
        files,
        bytes: 0,
        loadFailed: false,
        bootstrapCreated: ensureResult.created,
      };
    }

    const text = [
      "Persistent shared memory (load this before answering):",
      ...sections,
      "End persistent memory.",
    ].join("\n\n");
    return {
      text,
      missing,
      included,
      files,
      bytes: Buffer.byteLength(text, "utf8"),
      loadFailed: false,
      bootstrapCreated: ensureResult.created,
    };
  } catch (err) {
    _telemetry("shared_memory_load_error", { message: err?.message ?? String(err) });
    return {
      text: "",
      missing: SHARED_MEMORY_FILES,
      included: [],
      files: {},
      bytes: 0,
      loadFailed: true,
      bootstrapCreated: [],
    };
  }
}

export function getLastHandoffTimestamp(sharedMemory) {
  const handoff = sharedMemory?.files?.["agent-handoff.md"] || "";
  const match = handoff.match(/^Last updated:\s*(.+)$/m);
  return match ? match[1].trim() : "unknown";
}

export function loadAgentPrompts() {
  const candidates = [
    path.join(os.homedir(), ".crewswarm", "agent-prompts.json"),
    path.join(os.homedir(), ".openclaw",  "agent-prompts.json"),
  ];
  for (const p of candidates) {
    try {
      const prompts = JSON.parse(fs.readFileSync(p, "utf8"));
      if (Object.keys(prompts).length > 0) return prompts;
    } catch {}
  }
  return {};
}

export function buildTaskPrompt(taskText, sourceLabel, agentId, options = {}) {
  const { projectDir: taskProjectDir } = options;
  const sharedMemory = loadSharedMemoryBundle();
  if (sharedMemory.loadFailed) {
    return { finalPrompt: "MEMORY_LOAD_FAILED", sharedMemory };
  }
  const lastHandoffTimestamp = getLastHandoffTimestamp(sharedMemory);

  const contextNote = `[Shared memory loaded — UTC: ${new Date().toISOString().slice(0,16).replace('T',' ')} | Last handoff: ${lastHandoffTimestamp.slice(0,16) || 'none'}]`;

  // Inject agent-specific system prompt if one exists
  const agentPrompts = loadAgentPrompts();
  const bareId = agentId ? agentId.replace(/^crew-/, "") : null;
  const agentSystemPrompt = (agentId && agentPrompts[agentId]) || (bareId && agentPrompts[bareId]) || null;

  const agentAllowed = _loadAgentToolPermissions(agentId || "crew-main");
  const toolInstructions = _buildToolInstructions(agentAllowed);

  // Load global rules — injected into every agent if the file exists
  const globalRulesPath = path.join(os.homedir(), ".crewswarm", "global-rules.md");
  const globalRules = (() => {
    try {
      const txt = fs.readFileSync(globalRulesPath, "utf8").trim();
      return txt ? `## Global Rules (apply to all agents)\n${txt}` : "";
    } catch { return ""; }
  })();

  // Load agent-specific extra memory (e.g. lessons.md for coders + fixer)
  const extraMemoryFiles = getAgentExtraMemory(agentId);
  const extraMemorySections = [];
  for (const fileName of extraMemoryFiles) {
    const fullPath = path.join(SHARED_MEMORY_DIR, fileName);
    if (!fs.existsSync(fullPath)) continue;
    try {
      let content = fs.readFileSync(fullPath, "utf8").trim();
      if (content.length > 6000) content = content.slice(-6000); // tail-trim
      if (content) extraMemorySections.push(`### ${fileName}\n${content}`);
    } catch {}
  }

  // Inject agent identity — name, model, and ID so every agent knows who it is
  let identityHeader = "";
  if (agentId) {
    const agentList = _loadAgentList();
    const agentCfg = agentList.find(a => a.id === agentId);
    if (agentCfg) {
      const displayName = agentCfg.identity?.name || agentCfg.name || agentId;
      const emoji       = agentCfg.identity?.emoji || agentCfg.emoji || "";
      const role        = agentCfg.identity?.theme || "";
      const model       = agentCfg.model || "unknown model";
      identityHeader = `You are ${emoji ? emoji + " " : ""}${displayName} (agent ID: ${agentId}${role ? ", role: " + role : ""}, model: ${model}).`;
    }
  }

  // Fixer: when a path in the task doesn't exist, discover it by searching the project (so wrong paths like src/api/routers/main.py → find src/api/main.py)
  const projectRoot = taskProjectDir || (agentId === "crew-fixer" ? _getOpencodeProjectDir() : null);
  const desktopProjectsHint = path.join(os.homedir(), "Desktop", "<project-name>");
  let projectDiscoveryRule = "";
  if (agentId === "crew-fixer") {
    if (projectRoot) {
      projectDiscoveryRule = `## Project discovery (apply when a path in the task is missing or wrong)\nProject root: ${projectRoot}\n- If a path in the task does not exist, search the project first: use @@RUN_CMD find "${projectRoot}" -name '<filename>' (e.g. main.py) or ls to locate the file. Do not report "file not found" until you have tried to resolve the path within this project.`;
    } else {
      projectDiscoveryRule = `## Project discovery (external projects)\n- External projects (e.g. polymarket-ai-strat) are NOT inside the CrewSwarm repo. Their root is typically ${desktopProjectsHint}. If a path contains "CrewSwarm/<project-name>/", replace that with "${path.join(os.homedir(), "Desktop")}/<project-name>/". Example: polymarket-ai-strat main.py is at ${path.join(os.homedir(), "Desktop", "polymarket-ai-strat", "src/api/main.py")} (not under CrewSwarm, and not src/api/routers/main.py). Use @@RUN_CMD find to locate files if unsure.`;
    }
  }

  // Load per-project memory from <projectDir>/.crewswarm/context.md and brain.md
  // context.md = static facts (GitHub, tech stack, danger zones) — human-authored
  // brain.md   = accumulated knowledge — agents append via @@BRAIN when project selected
  const projectMemorySections = [];
  if (taskProjectDir) {
    const projectMemoryDir = path.join(taskProjectDir, ".crewswarm");
    for (const fname of ["context.md", "brain.md"]) {
      const fpath = path.join(projectMemoryDir, fname);
      try {
        let content = fs.readFileSync(fpath, "utf8").trim();
        if (content.length > 8000) content = content.slice(-8000);
        if (content) projectMemorySections.push(`### Project ${fname} (${taskProjectDir})\n${content}`);
      } catch { /* file doesn't exist — skip silently */ }
    }
  }

  const parts = [];
  if (identityHeader) parts.push(identityHeader);
  if (agentSystemPrompt) parts.push(agentSystemPrompt);
  if (globalRules) parts.push(globalRules);
  if (toolInstructions) parts.push(toolInstructions);
  if (projectDiscoveryRule) parts.push(projectDiscoveryRule);
  if (sharedMemory.text) parts.push(sharedMemory.text);
  if (extraMemorySections.length > 0) parts.push(extraMemorySections.join("\n\n"));
  if (projectMemorySections.length > 0) parts.push(projectMemorySections.join("\n\n"));
  parts.push(contextNote);
  parts.push(taskText);

  const finalPrompt = parts.join("\n\n");

  return { finalPrompt, sharedMemory };
}
