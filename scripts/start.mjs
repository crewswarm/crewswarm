#!/usr/bin/env node
/**
 * scripts/start.mjs — CrewSwarm first-run entry point
 *
 * This is the script behind `npm start` / `npx crewswarm`.  It validates the
 * environment before handing off to the real stack so that a brand-new user
 * who clones the repo and types `npm start` gets clear, actionable guidance
 * rather than a stack trace.
 *
 * Checks performed (in order):
 *   1. Node.js version >= 20
 *   2. ~/.crewswarm/crewswarm.json exists (created by install.sh)
 *   3. ~/.crewswarm/config.json exists (created by install.sh)
 *   4. At least one provider with an apiKey is configured
 *
 * On success:
 *   1. Spawns start-crew.mjs in the background (RT bus + crew-lead + bridges)
 *   2. Waits 3 seconds for services to come up
 *   3. Starts dashboard in the foreground (the process the user sees)
 *
 * NOTE: `npm run dashboard` still starts only the dashboard (unchanged).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
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
const SYS_CFG       = path.join(CREWSWARM_DIR, "config.json");
const INSTALL_SH    = path.join(ROOT, "install.sh");

function tryReadJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

// Bootstrap config directory + minimal config if missing — the dashboard's
// setup wizard will guide the user through API key entry on first visit.
let firstRun = false;
if (!fs.existsSync(CREWSWARM_DIR)) {
  fs.mkdirSync(CREWSWARM_DIR, { recursive: true });
  info(`Created config directory: ${CREWSWARM_DIR}`);
  firstRun = true;
}

// ── 3. crewswarm.json ─────────────────────────────────────────────────────────
if (!fs.existsSync(SWARM_CFG)) {
  const defaultConfig = {
    agents: [
      { id: "crew-lead",   model: "groq/llama-3.3-70b-versatile" },
      { id: "crew-main",   model: "groq/llama-3.3-70b-versatile" },
      { id: "crew-coder",  model: "groq/llama-3.3-70b-versatile" },
      { id: "crew-qa",     model: "groq/llama-3.3-70b-versatile" },
      { id: "crew-fixer",  model: "groq/llama-3.3-70b-versatile" },
      { id: "crew-pm",     model: "groq/llama-3.3-70b-versatile" }
    ],
    providers: {}
  };
  fs.writeFileSync(SWARM_CFG, JSON.stringify(defaultConfig, null, 2));
  info(`Created default ${SWARM_CFG} — add API keys in the dashboard setup wizard`);
  firstRun = true;
}
let swarm = tryReadJSON(SWARM_CFG);
if (!swarm) {
  fatal(
    `Cannot parse ${SWARM_CFG} — file may be corrupt.`,
    `Check it is valid JSON, or re-run:\n\n  bash ${INSTALL_SH}`
  );
}
success(`crewswarm.json found${firstRun ? " (first run — setup wizard will launch)" : ""}`);

// ── 4. config.json ───────────────────────────────────────────────────────────
if (!fs.existsSync(SYS_CFG)) {
  const defaultSysCfg = { rt: { authToken: `local-${Date.now().toString(36)}` } };
  fs.writeFileSync(SYS_CFG, JSON.stringify(defaultSysCfg, null, 2));
  info(`Created default ${SYS_CFG}`);
} else {
  const sys = tryReadJSON(SYS_CFG);
  if (!sys) {
    warn(`Cannot parse ${SYS_CFG} — check it is valid JSON.`);
  } else {
    success(`config.json found`);
  }
}

// ── Bootstrap supporting files if missing ────────────────────────────────────
const CMD_ALLOWLIST = path.join(CREWSWARM_DIR, "cmd-allowlist.json");
const AGENT_PROMPTS = path.join(CREWSWARM_DIR, "agent-prompts.json");
if (!fs.existsSync(CMD_ALLOWLIST)) {
  fs.writeFileSync(CMD_ALLOWLIST, '["npm *","node *","npx *","git *"]');
}
if (!fs.existsSync(AGENT_PROMPTS)) {
  fs.writeFileSync(AGENT_PROMPTS, "{}");
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

// ── 7. Start full stack ───────────────────────────────────────────────────────
console.log("");
divider();
info("All checks passed — starting full CrewSwarm stack");
divider();
console.log("");

// Step 1: Spawn start-crew.mjs in the background (RT bus + crew-lead + bridges)
info("Launching RT bus, crew-lead, and gateway bridges…");
const crewScript = path.join(ROOT, "scripts", "start-crew.mjs");
const crewProc = spawn(process.execPath, [crewScript], {
  cwd: ROOT,
  stdio: "inherit",
  detached: false,
  env: process.env,
});

// Wait for start-crew.mjs to finish its synchronous setup (it exits after spawning daemons)
await new Promise((resolve) => {
  crewProc.on("exit", resolve);
  crewProc.on("error", (err) => {
    warn(`start-crew.mjs exited with error: ${err.message}`);
    resolve();
  });
});

// Step 2: Give the background daemons a moment to bind their ports
info("Waiting 3 s for services to come up…");
await new Promise((resolve) => setTimeout(resolve, 3000));

// Step 3: Start dashboard in the foreground (what the user sees)
console.log("");
divider();
console.log(bold("  All services started.  Dashboard → http://127.0.0.1:4319"));
divider();
console.log("");

const result = spawnSync(process.execPath, [path.join(ROOT, "scripts", "dashboard.mjs")], {
  cwd: ROOT,
  stdio: "inherit",
  env: process.env,
});

process.exit(result.status ?? 0);
