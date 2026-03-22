/**
 * Load and build planning pipeline waves from editable config.
 * Used by crew-lead to construct @@PIPELINE for "build me X" requests.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WAVES_CONFIG_PATH = path.join(__dirname, "waves-config.json");

/**
 * Load waves configuration from waves-config.json
 */
export function loadWavesConfig() {
  try {
    if (!fs.existsSync(WAVES_CONFIG_PATH)) {
      console.warn(`[waves-loader] waves-config.json not found at ${WAVES_CONFIG_PATH}`);
      return null;
    }
    const raw = fs.readFileSync(WAVES_CONFIG_PATH, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[waves-loader] Failed to load waves config: ${e.message}`);
    return null;
  }
}

/**
 * Build planning pipeline steps from waves config
 * @param {Object} projectContext - {projectName, projectPath, userBrief, userRequest}
 * @returns {Array} Pipeline steps in @@PIPELINE format
 */
export function buildPlanningPipeline(projectContext = {}) {
  const config = loadWavesConfig();
  if (!config || !config.waves) {
    console.warn("[waves-loader] No waves configuration available, using fallback");
    return null;
  }

  const steps = [];
  
  for (const wave of config.waves) {
    for (const agent of wave.agents) {
      // Substitute template variables
      let task = agent.task;
      
      // Replace {{projectName}}, {{projectPath}}, {{userBrief}}, {{userRequest}}
      task = task.replace(/\{\{projectName\}\}/g, projectContext.projectName || "X");
      task = task.replace(/\{\{projectPath\}\}/g, projectContext.projectPath || "/path");
      task = task.replace(/\{\{userBrief\}\}/g, projectContext.userBrief || "<user's exact words>");
      task = task.replace(/\{\{userRequest\}\}/g, projectContext.userRequest || "<their request>");
      task = task.replace(/\{\{topic\}\}/g, projectContext.topic || projectContext.projectName || "the topic");
      
      steps.push({
        wave: wave.id,
        agent: agent.id,
        task: task
      });
    }
  }
  
  return steps;
}

/**
 * Format planning pipeline for crew-lead's prompt
 * Returns a human-readable description of the waves for the system prompt
 */
export function formatWavesForPrompt() {
  const config = loadWavesConfig();
  if (!config || !config.waves) {
    return "- Wave configuration not available. Use default 3-wave planning.";
  }

  const lines = [];
  lines.push("PLANNING PHASE — for 'build me X' or 'dispatch the crew' requests:");
  lines.push("- PM cannot receive replies from other agents (one-shot task). So YOU (crew-lead) orchestrate planning via a 3-wave pipeline.");
  lines.push("- Each wave's output is automatically passed as context to the next wave.");
  lines.push("");

  for (const wave of config.waves) {
    lines.push(`- WAVE ${wave.id} — ${wave.name.toUpperCase()} (${wave.description}):`);
    for (const agent of wave.agents) {
      // Show task without template variables for readability
      const taskPreview = agent.task.replace(/\{\{[^}]+\}\}/g, '...');
      const taskShort = taskPreview.length > 150 ? taskPreview.substring(0, 147) + '...' : taskPreview;
      lines.push(`  ${agent.id}: "${taskShort}"`);
    }
    lines.push("");
  }

  lines.push(`- The pipeline STOPS after wave ${config.waves.length} (PM delivers PDD + TECH-SPEC + ROADMAP). User reviews via crew-lead, then you launch a separate build pipeline.`);
  lines.push("- DO NOT skip the planning phase. Even 'build me X' with zero context works — PM scopes it, specialists design it.");

  return lines.join("\n");
}

/**
 * Generate @@PIPELINE JSON for crew-lead to emit
 * @param {Object} projectContext - {projectName, projectPath, userBrief, userRequest}
 * @returns {string} JSON string for @@PIPELINE marker
 */
export function generatePipelineJson(projectContext = {}) {
  const steps = buildPlanningPipeline(projectContext);
  if (!steps) return null;
  
  return JSON.stringify(steps);
}
