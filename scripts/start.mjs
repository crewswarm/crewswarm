#!/usr/bin/env node
/**
 * scripts/start.mjs — CrewSwarm first-run entry point
 *
 * This is the script behind `npm start`.  It validates the environment before
 * handing off to the real stack so that a brand-new user who clones the repo
 * and types `npm start` gets clear, actionable guidance rather than a stack
 * trace.
 *
 * Checks performed (in order):
 *   1. Node.js version >= 20
 *   2. ~/.crewswarm/crewswarm.json exists (created by install.sh)
 *   3. ~/.crewswarm/crewswarm.json exists (created by install.sh)
 *   4. At least one provider with an apiKey is configured
 *
 * On success, delegates to `npm run dashboard` (the standard start target).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ── ANSI colour helpers ───────────────────────────────────────────────────────
const isTTY = process.stdout.isTTY;
const bold  = (s) => isTTY ? `\x1b[1m${s}\x1b[0m`  : s;
const red   = (s) => isTTY ? `\x1b[31m${s}\x1b[0m` : s;
const cyan  = (s) => isTTY ? `\x1b[36m${s}\x1b[0m` : s;
const green = (s) => isTTY ? `\x1b[32m${s}\x1b[0m` : s;
const yellow= (s) => isTTY ? `\x1b[33m${s}\x1b[0m` : s;

function info(msg)    { console.log(`${cyan("▶")} ${msg}`); }
function success(msg) { console.log(`${green("✓")} ${msg}`); }
function warn(msg)    { console.log(`${yellow("⚠")} ${msg}`); }
function fatal(msg, hint = "") {
  console.error(`\n${red("✗")} ${bold(msg)}`);
  if (hint) console.error(`\n  ${hint}\n`);
  process.exit(1);
}
function divider() { console.log(bold("─".repeat(60))); }

// ── Header ───────────────────────────────────────────────────────────────────
console.log("");
divider();
console.log(bold("  CrewSwarm — starting up"));
divider();
console.log("");

// ── 1. Node.js version check ─────────────────────────────────────────────────
const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
if (nodeMajor < 20) {
  fatal(
    `Node.js 20+ required (found v${process.versions.node}).`,
    `Update from https://nodejs.org  or via Homebrew:\n  brew install node`
  );
}
success(`Node.js v${process.versions.node}`);

// ── 2. Config directory ───────────────────────────────────────────────────────
const CREWSWARM_DIR = path.join(os.homedir(), ".crewswarm");
const SWARM_CFG     = path.join(CREWSWARM_DIR, "crewswarm.json");
const SYS_CFG       = path.join(CREWSWARM_DIR, "crewswarm.json");
const INSTALL_SH    = path.join(ROOT, "install.sh");

function tryReadJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

if (!fs.existsSync(CREWSWARM_DIR)) {
  fatal(
    `Config directory not found: ${CREWSWARM_DIR}`,
    `Run the installer first:\n\n  bash ${INSTALL_SH}\n\n` +
    `Or, for a one-liner from the web:\n\n` +
    `  bash <(curl -fsSL https://raw.githubusercontent.com/crewswarm/crewswarm/main/install.sh)`
  );
}

// ── 3. crewswarm.json ─────────────────────────────────────────────────────────
if (!fs.existsSync(SWARM_CFG)) {
  fatal(
    `Agent config not found: ${SWARM_CFG}`,
    `Run the installer to create it:\n\n  bash ${INSTALL_SH}`
  );
}
const swarm = tryReadJSON(SWARM_CFG);
if (!swarm) {
  fatal(
    `Cannot parse ${SWARM_CFG} — file may be corrupt.`,
    `Check it is valid JSON, or re-run:\n\n  bash ${INSTALL_SH}`
  );
}
success(`crewswarm.json found`);

// ── 4. config.json ───────────────────────────────────────────────────────────
if (!fs.existsSync(SYS_CFG)) {
  warn(`System config not found: ${SYS_CFG}`);
  warn(`Some features (RT bus auth, background consciousness) will be disabled.`);
  warn(`To configure them, run:  bash ${INSTALL_SH}`);
} else {
  const sys = tryReadJSON(SYS_CFG);
  if (!sys) {
    warn(`Cannot parse ${SYS_CFG} — check it is valid JSON.`);
  } else {
    success(`config.json found`);
  }
}

// ── 5. Provider check ────────────────────────────────────────────────────────
const providers = swarm.providers || {};
const configured = Object.entries(providers).filter(([, v]) => v?.apiKey && String(v.apiKey).trim().length > 0 && !String(v.apiKey).startsWith("your-"));
if (configured.length === 0) {
  warn(`No LLM providers with API keys found in ${SWARM_CFG}.`);
  warn(`Agents will not be able to call LLMs until at least one provider is configured.`);
  warn(`Open ${SWARM_CFG} and add your API key, or run:  bash ${INSTALL_SH}`);
} else {
  success(`${configured.length} provider(s) configured: ${configured.map(([k]) => k).join(", ")}`);
}

// ── 6. Agents check ──────────────────────────────────────────────────────────
const agents = Array.isArray(swarm.agents) ? swarm.agents : [];
if (agents.length === 0) {
  fatal(
    `No agents found in ${SWARM_CFG}.`,
    `The agents array is empty.  Re-run the installer:\n\n  bash ${INSTALL_SH}`
  );
}
info(`${agents.length} agent(s) defined`);

// ── 7. Hand off to dashboard ──────────────────────────────────────────────────
console.log("");
divider();
info("All checks passed — launching dashboard on http://127.0.0.1:4319");
divider();
console.log("");

const result = spawnSync("node", [path.join(ROOT, "scripts", "dashboard.mjs")], {
  cwd: ROOT,
  stdio: "inherit",
  env: process.env,
});

process.exit(result.status ?? 0);
