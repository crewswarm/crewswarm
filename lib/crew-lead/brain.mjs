/**
 * Brain, global rules, and search helpers — extracted from crew-lead.mjs
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { getSearchToolsConfig } from "../agents/permissions.mjs";

let _brainPath = "";
let _globalRulesPath = "";

export function initBrain({ brainPath, globalRulesPath }) {
  if (brainPath !== undefined) _brainPath = brainPath;
  if (globalRulesPath !== undefined) _globalRulesPath = globalRulesPath;
}

export function appendToBrain(agentId, entry, projectDir = null) {
  const date = new Date().toISOString().slice(0, 10);
  const block = `\n## [${date}] ${agentId}: ${entry}\n`;
  if (projectDir) {
    const projectBrainDir = path.join(projectDir, ".crewswarm");
    const projectBrainPath = path.join(projectBrainDir, "brain.md");
    fs.mkdirSync(projectBrainDir, { recursive: true });
    if (!fs.existsSync(projectBrainPath)) {
      fs.writeFileSync(projectBrainPath, "# Project Brain\n\nAccumulated knowledge for this project. Agents append discoveries here.\n", "utf8");
    }
    fs.appendFileSync(projectBrainPath, block, "utf8");
  } else {
    if (!fs.existsSync(_brainPath)) fs.mkdirSync(path.dirname(_brainPath), { recursive: true });
    fs.appendFileSync(_brainPath, block, "utf8");
  }
  return block.trim();
}

export function readGlobalRules() {
  try { return fs.readFileSync(_globalRulesPath, "utf8").trim(); } catch { return ""; }
}

export function writeGlobalRules(content) {
  fs.writeFileSync(_globalRulesPath, content, "utf8");
  return content;
}

export function appendGlobalRule(rule) {
  const existing = readGlobalRules();
  const updated = existing ? `${existing}\n- ${rule}` : `# Global Agent Rules\n\n- ${rule}`;
  writeGlobalRules(updated);
  return updated;
}

export async function searchWithBrave(query) {
  const key = getSearchToolsConfig()?.brave?.apiKey || process.env.BRAVE_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&text_decorations=false`,
      { headers: { "Accept": "application/json", "X-Subscription-Token": key }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const results = (data.web?.results || []).slice(0, 5);
    if (!results.length) return null;
    const text = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.description || ""}\n   ${r.url}`).join("\n\n");
    console.log(`[crew-lead] Brave search query="${query.slice(0, 80)}" → ${results.length} results`);
    return text;
  } catch { return null; }
}

export function getWorkspaceRoot() {
  return process.env.CREW_LEAD_WORKSPACE || process.cwd();
}

/** Run a text search in the workspace; returns excerpt string or null. Uses rg then grep. */
export function searchCodebase(query) {
  const workspace = getWorkspaceRoot();
  if (!query || query.length < 2) return null;
  const maxOutput = 6000;
  const args = [
    "-F", "-i", "-n",
    "-C", "1",
    "--max-files", "20",
    "--max-count", "3",
    "--glob", "!node_modules",
    "--glob", "!.git",
    "--glob", "!*.min.js",
    query,
    workspace,
  ];
  try {
    const out = spawnSync("rg", args, {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: maxOutput,
      windowsHide: true,
    });
    if (out.status !== 0 || !out.stdout?.trim()) return null;
    const lines = out.stdout.trim().split("\n").slice(0, 25);
    return lines.join("\n");
  } catch {
    try {
      const out = execSync(
        `grep -r -F -i -n --include="*.js" --include="*.mjs" --include="*.ts" --include="*.json" --include="*.md" -e ${JSON.stringify(query)} ${JSON.stringify(workspace)} 2>/dev/null | head -25`,
        { encoding: "utf8", timeout: 5000, maxBuffer: maxOutput }
      );
      return out?.trim() || null;
    } catch { return null; }
  }
}
