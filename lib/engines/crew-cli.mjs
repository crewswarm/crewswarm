import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

let _deps = {};

export function initCrewCLI(deps) {
  _deps = deps;
}

/**
 * Run a task through crew-cli execution engine
 * @param {string} prompt - The task to execute
 * @param {object} payload - Task metadata (agentId, model, projectDir, etc.)
 * @returns {Promise<string>} - The crew-cli output
 */
export async function runCrewCLITask(prompt, payload = {}) {
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
    const model = String(payload?.model || agentConfig.model || process.env.CREWSWARM_CREW_CLI_MODEL || "");

    // Determine project directory
    const projectDir = payload?.projectDir || (getOpencodeProjectDir ? getOpencodeProjectDir() : null) || process.cwd();

    // Build crew-cli command
    // Use "crew run" for execution tasks (like OpenCode)
    const args = [
      "run",
      "-t", prompt,
      "--json", // Get JSON output for parsing
    ];

    // Add model if specified
    if (model) {
      args.push("--model", model);
    }

    // Add project directory context
    if (projectDir && projectDir !== process.cwd()) {
      args.push("--cwd", projectDir);
    }

    // Spawn crew-cli process
    const proc = spawn(bin, args, {
      cwd: projectDir,
      env: {
        ...process.env,
        CREW_OUTPUT_MODE: "json", // Force JSON output
        CREW_HEADLESS: "1", // Headless mode (no interactive prompts)
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

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

      // Parse JSON output if available
      try {
        const lines = stdout.split("\n");
        const jsonLine = lines.find(line => line.trim().startsWith("{"));
        if (jsonLine) {
          const parsed = JSON.parse(jsonLine);
          
          // Extract text result for consistency with other engines
          let textResult = parsed.summary || parsed.result || "";
          if (parsed.files && parsed.files.length > 0) {
            const fileList = parsed.files.slice(0, 3).map(f => f.path).join(", ");
            textResult += `\n\nModified files: ${fileList}${parsed.files.length > 3 ? "..." : ""}`;
          }
          
          resolve(textResult || stdout);
          return;
        }
      } catch {
        // If JSON parsing fails, return raw output
      }

      if (code === 0) {
        resolve(stdout || "(crew-cli completed with no output)");
      } else {
        reject(new Error(`crew-cli failed with exit code ${code}: ${stderr || stdout}`));
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
