import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { CREWSWARM_REPO_ROOT } from "../runtime/config.mjs";

let _deps = {};
let _engineModule = null;

export function initCrewCLI(deps) {
  _deps = deps;
}

/**
 * Lazy-load the crew-cli engine API (dist/engine.mjs).
 * This gives us direct access to runAgenticWorker + Sandbox
 * without spawning a subprocess.
 */
async function getEngine() {
  if (_engineModule) return _engineModule;
  const enginePath = path.join(CREWSWARM_REPO_ROOT, "crew-cli", "dist", "engine.mjs");
  if (!fs.existsSync(enginePath)) {
    throw new Error(
      `crew-cli engine not found at ${enginePath}. Run: cd crew-cli && npm run build`
    );
  }
  _engineModule = await import(enginePath);
  return _engineModule;
}

/**
 * Load providers from crewswarm config (for API keys)
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
 * Run a task through crew-cli's agentic executor — DIRECT function call.
 * No subprocess, no stdout parsing. Just calls runAgenticWorker with tools.
 *
 * @param {string} prompt - The task to execute
 * @param {object} payload - Task metadata (agentId, model, projectDir, etc.)
 * @returns {Promise<string>} - The executor output
 */
export async function runCrewCLITask(prompt, payload = {}) {
  const {
    CREWSWARM_RT_AGENT,
    getAgentOpenCodeConfig,
    getOpencodeProjectDir,
  } = _deps;

  // Resolve model
  const agentId = String(
    payload?.agentId || payload?.agent || CREWSWARM_RT_AGENT || ""
  );
  const agentConfig = getAgentOpenCodeConfig
    ? getAgentOpenCodeConfig(agentId)
    : {};
  let model = String(
    payload?.crewCliModel ||
      agentConfig.crewCliModel ||
      process.env.CREWSWARM_CREW_CLI_MODEL ||
      payload?.model ||
      agentConfig.model ||
      ""
  );

  // Resolve project directory — must be a string (Sandbox requires it)
  const rawDir =
    payload?.projectDir ||
    (getOpencodeProjectDir ? getOpencodeProjectDir() : null) ||
    process.cwd();
  const projectDir = typeof rawDir === "string" && rawDir.trim() ? rawDir.trim() : process.cwd();

  // Ensure API keys are in env
  const providers = loadProviders();
  const geminiKey =
    providers.google?.apiKey ||
    providers.gemini?.apiKey ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY;
  if (geminiKey) {
    process.env.GEMINI_API_KEY = geminiKey;
    process.env.GOOGLE_API_KEY = geminiKey;
  }
  // OpenAI
  const openaiKey = providers.openai?.apiKey || process.env.OPENAI_API_KEY;
  if (openaiKey) process.env.OPENAI_API_KEY = openaiKey;
  // Anthropic
  const anthropicKey = providers.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) process.env.ANTHROPIC_API_KEY = anthropicKey;
  // Groq
  const groqKey = providers.groq?.apiKey || process.env.GROQ_API_KEY;
  if (groqKey) process.env.GROQ_API_KEY = groqKey;
  // xAI / Grok
  const xaiKey = providers.xai?.apiKey || providers.grok?.apiKey || process.env.XAI_API_KEY;
  if (xaiKey) process.env.XAI_API_KEY = xaiKey;
  // DeepSeek
  const deepseekKey = providers.deepseek?.apiKey || process.env.DEEPSEEK_API_KEY;
  if (deepseekKey) process.env.DEEPSEEK_API_KEY = deepseekKey;

  console.log(`[crew-cli engine] Task for ${agentId} | model: ${model || "auto"} | dir: ${projectDir}`);

  // Import the engine API (lazy, cached)
  const engine = await getEngine();

  // Create sandbox pointed at the project directory
  const sandbox = new engine.Sandbox({ baseDir: projectDir });

  // Run the agentic executor directly — THINK→ACT→OBSERVE loop with 34 tools
  const result = await engine.runAgenticWorker(prompt, sandbox, {
    model: model || process.env.CREW_EXECUTION_MODEL || "gemini-2.5-flash",
    maxTurns: 25,
    projectDir,
    verbose: Boolean(process.env.CREW_VERBOSE || process.env.CREW_DEBUG),
  });

  if (sandbox.hasChanges()) {
    const pendingPaths = sandbox.getPendingPaths();
    await sandbox.apply();
    console.log(
      `[crew-cli engine] Applied ${pendingPaths.length} file(s): ${pendingPaths.join(", ")}`
    );
  }

  const output = String(result.output || result.response || "(completed)");
  const turns = result.turns ?? 0;
  const cost = result.cost?.toFixed(6) || "0";
  const tools = result.toolsUsed
    ? [...result.toolsUsed].join(", ")
    : "unknown";

  console.log(
    `[crew-cli engine] ✅ Done in ${turns} turns ($${cost}) — tools: ${tools}`
  );

  return output;
}

/**
 * Check if crew-cli engine is available (dist/engine.mjs exists)
 */
export async function isCrewCLIAvailable() {
  try {
    const enginePath = path.join(CREWSWARM_REPO_ROOT, "crew-cli", "dist", "engine.mjs");
    return fs.existsSync(enginePath);
  } catch {
    return false;
  }
}
