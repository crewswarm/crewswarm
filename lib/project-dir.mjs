import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_PATH = join(homedir(), ".crewswarm", "crewswarm.json");

/**
 * Single source of truth for the active project directory.
 * Priority: explicit env override → config.json (set via Dashboard Settings) → fallback.
 * Reads config.json fresh each call so dashboard changes apply without restart.
 */
export function getProjectDir(fallback) {
  if (process.env.CREWSWARM_OUTPUT_DIR) return process.env.CREWSWARM_OUTPUT_DIR;
  if (process.env.CREWSWARM_OPENCODE_PROJECT) return process.env.CREWSWARM_OPENCODE_PROJECT;
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (cfg.opencodeProject && String(cfg.opencodeProject).trim()) return String(cfg.opencodeProject).trim();
  } catch {}
  return fallback || process.cwd();
}
