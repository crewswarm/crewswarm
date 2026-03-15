import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let _deps = {};

export function initCrewCLI(deps) {
  _deps = deps;
}

/**
 * Load providers from crewswarm config
 */
function loadProviders() {
  const configPath = path.join(os.homedir(), ".crewswarm", "crewswarm.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return cfg.providers || {};
  } catch {
    return {};
  }
}

/**
 * Run a task through crew-cli execution engine
 * @param {string} prompt - The task to execute
 * @param {object} payload - Task metadata (agentId, model, projectDir, etc.)
 * @returns {Promise<string>} - The crew-cli output
 */
export async function runCrewCLITask(prompt, payload = {}) {
  console.error(`[crew-cli] ═══════════════════════════════════════`);
  console.error(`[crew-cli] runCrewCLITask CALLED`);
  console.error(`[crew-cli] prompt length: ${prompt?.length || 0}`);
  console.error(`[crew-cli] payload keys: ${Object.keys(payload || {})}`);
  console.error(`[crew-cli] ═══════════════════════════════════════`);
  
  const {
    CREWSWARM_RT_AGENT,
    getAgentOpenCodeConfig,
    getOpencodeProjectDir,
  } = _deps;

  return new Promise((resolve, reject) => {
    // Find crew binary
    const crewCliPath = path.join(process.cwd(), 'crew-cli', 'bin', 'crew.js');
    const bin = fs.existsSync(crewCliPath) ? crewCliPath : "crew";

    // Get agent model config
    const agentId = String(payload?.agentId || payload?.agent || CREWSWARM_RT_AGENT || "");
    const agentConfig = getAgentOpenCodeConfig ? getAgentOpenCodeConfig(agentId) : {};
    let model = String(payload?.model || agentConfig.model || process.env.CREWSWARM_CREW_CLI_MODEL || "");

    // Normalize model string for crew-cli
    // crewswarm uses format: "provider/models/model-name" or "provider/model-name"
    // crew-cli expects: "model-name"
    if (model) {
      const originalModel = model;
      // Remove provider prefix (google/, openai/, anthropic/, etc.)
      model = model.replace(/^[^\/]+\//, '');
      // Remove models/ prefix if present (e.g. google/models/gemini-2.5-flash)
      model = model.replace(/^models\//, '');
      if (originalModel !== model) {
        console.error(`[crew-cli] Normalized model: ${originalModel} → ${model}`);
      }
    }

    // Determine project directory
    const projectDir = payload?.projectDir || (getOpencodeProjectDir ? getOpencodeProjectDir() : null) || process.cwd();

    // Ensure project directory exists (spawn fails with ENOENT if cwd doesn't exist)
    if (!fs.existsSync(projectDir)) {
      console.error(`[crew-cli] Creating project directory: ${projectDir}`);
      fs.mkdirSync(projectDir, { recursive: true });
    }

    // Build crew-cli command
    // Use "crew chat" with --direct for agent task execution
    const args = [
      "chat",
      prompt, // Task/message
      "--direct", // Bypass conversational routing, execute directly
      "--json",   // Output machine-readable JSON envelope
    ];

    // Add model if specified (crew chat supports --model, crew run does not)
    if (model) {
      args.push("--model", model);
      console.error(`[crew-cli] Model specified: ${model}`);
    } else {
      console.error(`[crew-cli] ⚠️ NO MODEL SPECIFIED (agentConfig.model: ${agentConfig.model})`);
    }

    // Add project directory context
    if (projectDir && projectDir !== process.cwd()) {
      args.push("--project", projectDir);
    }

    // Add gateway routing (direct execution, skip orchestrator)
    args.push("--direct");

    // Load API keys from crewswarm config
    const providers = loadProviders();
    const geminiKey = providers.google?.apiKey || providers.gemini?.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    
    if (geminiKey) {
      console.error(`[crew-cli] ✅ Gemini API key found (${geminiKey.length} chars)`);
    } else {
      console.error(`[crew-cli] ⚠️ No Gemini API key found in config or env`);
    }

    // Spawn crew-cli process with explicit node path
    const nodePath = process.execPath || "node";  // Use current node executable
    
    console.error(`[crew-cli] About to spawn:`);
    console.error(`[crew-cli]   node: ${nodePath}`);
    console.error(`[crew-cli]   bin: ${bin}`);
    console.error(`[crew-cli]   args: ${JSON.stringify(args)}`);
    console.error(`[crew-cli]   cwd: ${projectDir}`);
    console.error(`[crew-cli]   bin exists: ${fs.existsSync(bin)}`);
    console.error(`[crew-cli]   cwd exists: ${fs.existsSync(projectDir)}`);
    console.error(`[crew-cli]   node exists: ${fs.existsSync(nodePath)}`);
    
    let proc;
    try {
      proc = spawn(nodePath, [bin, ...args], {
        cwd: projectDir,
        env: {
          ...process.env,
          CI: "1", // Headless mode (no interactive prompts)
          // Force local-only crew-cli execution when used as a gateway code engine.
          // This prevents recursive routing back through crew-lead/gateway.
          CREW_INTERFACE_MODE: "standalone",
          // Pass Gemini API key if available
          ...(geminiKey ? { 
            GEMINI_API_KEY: geminiKey,
            GOOGLE_API_KEY: geminiKey 
          } : {})
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (spawnError) {
      console.error(`[crew-cli] ❌ Spawn threw synchronous error:`, spawnError);
      return reject(new Error(`Failed to spawn crew-cli (sync): ${spawnError.message}`));
    }
    
    console.error(`[crew-cli] ✅ Spawn succeeded, proc.pid: ${proc.pid}`);

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    // Timeout handling (default 5 minutes)
    const timeoutMs = Number(process.env.CREWSWARM_CREW_CLI_TIMEOUT_MS || 300000);
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`crew-cli task timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);

      const result = {
        stdout,
        stderr,
        exitCode: code || 0,
      };

      // crew chat returns plain text output (not JSON)
      // Return stdout if successful, or error if failed
      if (code === 0) {
        const output = stdout.trim() || stderr.trim() || "(crew-cli completed with no output)";
        resolve(output);
      } else {
        const errorMsg = stderr.trim() || stdout.trim() || "Unknown error";
        reject(new Error(`crew-cli failed with exit code ${code}: ${errorMsg}`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn crew-cli: ${err.message}`));
    });
  });
}

/**
 * Check if crew-cli is installed and available
 * @returns {boolean}
 */
export async function isCrewCLIAvailable() {
  try {
    const crewCliPath = path.join(process.cwd(), 'crew-cli', 'bin', 'crew.js');
    if (fs.existsSync(crewCliPath)) return true;

    // Check if globally installed
    const { execSync } = await import("node:child_process");
    execSync("which crew", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
