/**
 * CLI Executor for Telegram/WhatsApp Bridges
 * 
 * Executes OpenCode/Cursor/Crew-CLI tasks with:
 * - Process tracking (so we know not to kill active work)
 * - Activity monitoring (detect hung processes)
 * - Streaming output (show progress in real-time)
 * - Model passthrough (use agent's configured model)
 */

import { execSync, spawn } from "node:child_process";
import { accessSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  registerCLIProcess,
  updateCLIActivity,
  completeCLIProcess,
  isProcessActive
} from "../cli-process-tracker.mjs";

const CREW_CFG_PATH = join(homedir(), ".crewswarm", "crewswarm.json");

/**
 * Execute a CLI task with full tracking and monitoring
 * 
 * @param {string} cliName - "opencode" | "cursor" | "crew-cli" | "codex" | "gemini" | "claude"
 * @param {string} task - Task description
 * @param {string} agentId - Agent ID (e.g. "crew-coder")
 * @param {object} context - { chatId, sessionId, projectDir }
 * @param {function} onOutput - Callback for streaming output: (chunk: string) => void
 * @returns {Promise<{ stdout, stderr, exitCode, duration }>}
 */
export async function executeCLI(cliName, task, agentId = null, context = {}, onOutput = null) {
  const { chatId, sessionId, projectDir } = context;
  const processId = `${sessionId || chatId}-${cliName}-${Date.now()}`;
  
  // Load agent config to get model
  let model = getDefaultModelForCLI(cliName);
  let agentCfg = null;
  if (agentId) {
    try {
      const csSwarm = JSON.parse(readFileSync(CREW_CFG_PATH, "utf8"));
      agentCfg = csSwarm.agents?.find(a => a.id === agentId);
      model = agentCfg?.model || model;
    } catch (e) {
      console.error("[cli-executor] Failed to load agent config:", e.message);
    }
  }
  
  // Build command
  const { bin, args, cwd } = buildCLICommand(cliName, task, model, projectDir, agentCfg);
  
  console.log(`[cli-executor] Starting ${cliName} for ${agentId}`, { bin, args: args.slice(0, 3), model });
  
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let stdout = "";
    let stderr = "";
    let lastActivityTime = startTime;
    
    const proc = spawn(bin, args, {
      cwd: cwd || process.cwd(),
      env: {
        ...process.env,
        CREWSWARM_SESSION_ID: sessionId || chatId,
        CREWSWARM_AGENT: agentId
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    
    // Register process for tracking
    registerCLIProcess(processId, {
      pid: proc.pid,
      agent: agentId,
      cli: cliName,
      task,
      chatId,
      sessionId,
      model
    });
    
    // Idle watchdog: kill if no output for 5 minutes
    const IDLE_TIMEOUT_MS = 300000;
    const idleWatchdog = setInterval(() => {
      const idleFor = Date.now() - lastActivityTime;
      if (idleFor > IDLE_TIMEOUT_MS) {
        console.warn(`[cli-executor] Process ${processId} idle for ${idleFor}ms - killing`);
        clearInterval(idleWatchdog);
        proc.kill("SIGTERM");
        setTimeout(() => proc.kill("SIGKILL"), 5000); // SIGKILL if SIGTERM fails
      }
    }, 30000); // Check every 30s
    
    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      lastActivityTime = Date.now();
      updateCLIActivity(processId, text);
      if (onOutput) onOutput(text);
    });
    
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      lastActivityTime = Date.now();
      updateCLIActivity(processId, text);
      if (onOutput) onOutput(text);
    });
    
    proc.on("error", (err) => {
      clearInterval(idleWatchdog);
      completeCLIProcess(processId, { exitCode: -1, error: err.message });
      reject(new Error(`${cliName} spawn failed: ${err.message}`));
    });
    
    proc.on("close", (code) => {
      clearInterval(idleWatchdog);
      const duration = Date.now() - startTime;
      completeCLIProcess(processId, { exitCode: code, duration });
      
      if (code === 0) {
        resolve({ stdout, stderr, exitCode: code, duration, processId });
      } else {
        const error = new Error(`${cliName} exited with code ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        error.exitCode = code;
        reject(error);
      }
    });
  });
}

/**
 * Build CLI command for execution
 * @private
 */
export function buildCLICommand(
  cliName,
  task,
  model,
  projectDir,
  agentConfig = null,
) {
  const cwd = projectDir || process.cwd();
  
  switch (cliName) {
    case "opencode":
      // OpenCode uses: opencode run [prompt] --model <model>
      // The prompt is a POSITIONAL argument, not --message or --task
      return {
        bin: "opencode",
        args: ["run", "-m", model, task],
        cwd
      };
    
    case "cursor": {
      const cursorDefault =
        process.env.CREWSWARM_CURSOR_MODEL || "composer-2-fast";
      // Per-agent cursorCliModel wins; provider-style model strings (groq/…, anthropic/…) map to Cursor id
      let cursorModel = model;
      if (agentConfig?.cursorCliModel) {
        cursorModel = agentConfig.cursorCliModel;
      } else if (!model || String(model).trim() === "") {
        cursorModel = cursorDefault;
      } else if (String(model).includes("sonnet-4.6")) {
        cursorModel = "sonnet-4.5"; // CLI quirk: 4.6 may error; keep escape hatch
      } else if (String(model).includes("/")) {
        cursorModel = cursorDefault;
      }

      return {
        bin: process.env.CURSOR_CLI_BIN || "/Users/jeffhobbs/.local/bin/agent",
        args: ["--print", "--yolo", "--model", cursorModel, task],
        cwd
      };
    }

    case "crew-cli":
      return {
        bin: process.env.CREW_CLI_BIN || "crew",
        args: [
          "chat",
          task,
          "--json",
          ...(model ? ["--model", model] : []),
          ...(projectDir ? ["--project", projectDir] : []),
        ],
        cwd
      };
    
    case "codex":
      // Codex uses gpt-5.3-codex by default - no --model flag needed!
      // User has ChatGPT account which supports 5.3 by default
      return {
        bin: process.env.CODEX_CLI_BIN || "codex",
        args: ["exec", "--sandbox", "workspace-write", task], // ← No --model flag
        cwd
      };
    
    case "gemini":
      return {
        bin: process.env.GEMINI_CLI_BIN || "gemini",
        args: ["-m", model, "-p", task, "--yolo"],
        cwd
      };

    case "claude":
      // Claude CLI (Claude Code) - uses -p for non-interactive, --model for specific model
      // If no model specified, uses default from Claude Code config
      return {
        bin: process.env.CLAUDE_CLI_BIN || "/Users/jeffhobbs/.local/bin/claude",
        args: [
          "-p",
          "--setting-sources",
          "user",
          "--dangerously-skip-permissions",
          "--output-format",
          "stream-json",
          "--verbose",
          ...(projectDir ? ["--add-dir", projectDir] : []),
          ...(model && !model.includes("/") ? ["--model", model] : []),
          task,
        ],
        cwd: projectDir ? "/tmp" : cwd
      };
    
    default:
      throw new Error(`Unknown CLI: ${cliName}`);
  }
}

/**
 * Parse agent reply for @@CLI calls
 * @param {string} reply - LLM response
 * @returns {{ cli: string, task: string, preText: string } | null}
 */
export function parseCLICall(reply) {
  if (!reply || !reply.includes("@@CLI")) return null;
  
  const match = reply.match(/@@CLI\s+(\w+)\s+(.+)/s);
  if (!match) return null;
  
  return {
    cli: match[1].toLowerCase(),
    task: match[2].trim(),
    preText: reply.slice(0, match.index).trim()
  };
}

/**
 * Get available CLIs (checks if binaries exist)
 * @returns {Array<string>}
 */
export function getAvailableCLIs() {
  const clis = [];
  
  if (which("opencode")) clis.push("opencode");
  if (which("/Users/jeffhobbs/.local/bin/agent") || which("agent")) clis.push("cursor");
  if (which("crew") || existsSync(join(process.cwd(), "crew-cli"))) clis.push("crew-cli");
  if (which("codex")) clis.push("codex");
  if (which("gemini")) clis.push("gemini");
  if (which("/Users/jeffhobbs/.local/bin/claude") || which("claude")) clis.push("claude");
  
  return clis;
}

function which(bin) {
  try {
    execSync(`which ${bin}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function existsSync(path) {
  try {
    accessSync(path);
    return true;
  } catch {
    return false;
  }
}

function getDefaultModelForCLI(cliName) {
  switch (cliName) {
    case "opencode":
      return process.env.CREWSWARM_OPENCODE_MODEL || "groq/moonshotai/kimi-k2-instruct-0905";
    case "cursor":
      return process.env.CURSOR_DEFAULT_MODEL || "gemini-3-flash";
    case "claude":
      return process.env.CREWSWARM_CLAUDE_CODE_MODEL || null;
    case "gemini":
      return process.env.CREWSWARM_GEMINI_CLI_MODEL || null;
    case "crew-cli":
      return process.env.CREWSWARM_CREW_CLI_MODEL || "groq/llama-3.3-70b-versatile";
    case "codex":
    default:
      return null;
  }
}
