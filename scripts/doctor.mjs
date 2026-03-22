#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const rootDir = process.cwd();
const homeDir = os.homedir();
const configPath = path.join(homeDir, ".crewswarm", "crewswarm.json");
const dashboardDistPath = path.join(rootDir, "apps", "dashboard", "dist", "index.html");
const vibeDistPath = path.join(rootDir, "apps", "vibe", "dist", "index.html");
const CI_MODE = process.env.CI === "true";
const issues = [];
const warnings = [];
const nextSteps = [];

const C = "\x1b[36m";
const G = "\x1b[32m";
const Y = "\x1b[33m";
const R = "\x1b[31m";
const B = "\x1b[1m";
const N = "\x1b[0m";

function ok(label, detail = "") {
  console.log(`${G}✓${N} ${label}${detail ? `  ${detail}` : ""}`);
}

function warn(label, detail = "") {
  warnings.push(label);
  console.log(`${Y}⚠${N} ${label}${detail ? `  ${detail}` : ""}`);
}

function fail(label, detail = "", nextStep = "") {
  issues.push(label);
  console.log(`${R}✗${N} ${label}${detail ? `  ${detail}` : ""}`);
  if (nextStep) nextSteps.push(nextStep);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function run(cmd) {
  return execSync(cmd, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 20000,
  }).trim();
}

function unique(list) {
  return Array.from(new Set(list.filter(Boolean)));
}

function getPortOccupant(port) {
  try {
    const out = run(`lsof -n -P -iTCP:${port} -sTCP:LISTEN`);
    const lines = out.split("\n").filter(Boolean);
    return lines.length > 1 ? lines[1].trim() : "";
  } catch {
    return "";
  }
}

console.log(`\n${B}${C}crewswarm doctor${N}`);
console.log(`Repo: ${rootDir}`);

try {
  const nodeVersion = process.version;
  const major = Number(nodeVersion.replace(/^v/, "").split(".")[0] || "0");
  if (major >= 20) {
    ok("Node.js", nodeVersion);
  } else {
    fail("Node.js", `${nodeVersion} (need 20+)`, "Install Node 20+ and rerun `npm install`.");
  }
} catch (error) {
  fail("Node.js", error.message, "Install Node 20+.");
}

try {
  ok("npm", run("npm --version"));
} catch (error) {
  fail("npm", error.message, "Install npm / Node.js before continuing.");
}

if (fs.existsSync(configPath)) {
  ok("Config file", configPath);
  try {
    const config = readJson(configPath);
    const providers = config.providers || {};
    const configuredProviders = Object.entries(providers).filter(([, value]) => {
      const apiKey = value?.apiKey || "";
      return typeof apiKey === "string" && apiKey.trim().length > 8;
    });
    if (configuredProviders.length > 0) {
      ok("Provider keys", configuredProviders.map(([name]) => name).join(", "));
    } else {
      if (CI_MODE) {
        warn("Provider keys", "none configured (CI mode)");
      } else {
        fail(
          "Provider keys",
          "none configured",
          "Open Dashboard → Providers and add at least one API key.",
        );
      }
    }
  } catch (error) {
    if (CI_MODE) {
      warn("Config parse", `${error.message} (CI mode)`);
    } else {
      fail("Config parse", error.message, "Re-run `bash install.sh` if your config is corrupted.");
    }
  }
} else {
  if (CI_MODE) {
    warn("Config file", "missing ~/.crewswarm/crewswarm.json (CI mode)");
  } else {
    fail("Config file", "missing ~/.crewswarm/crewswarm.json", "Run `bash install.sh` first.");
  }
}

if (fs.existsSync(dashboardDistPath)) {
  ok("Dashboard build", "apps/dashboard/dist/index.html");
} else {
  fail(
    "Dashboard build",
    "missing apps/dashboard/dist/index.html",
    "Run `cd apps/dashboard && npm run build`.",
  );
}

if (fs.existsSync(vibeDistPath)) {
  ok("Vibe build", "apps/vibe/dist/index.html");
} else {
  warn("Vibe build", "missing apps/vibe/dist/index.html");
  nextSteps.push("Run `cd apps/vibe && npm run build` if you want the Vibe IDE available.");
}

[
  { port: 5010, label: "crew-lead port 5010" },
  { port: 3333, label: "Vibe port 3333" },
  { port: 4096, label: "OpenCode port 4096" },
].forEach(({ port, label }) => {
  const occupant = getPortOccupant(port);
  if (occupant) {
    warn(label, `already in use: ${occupant}`);
    nextSteps.push(`If startup fails, inspect port ${port} with \`lsof -n -P -iTCP:${port} -sTCP:LISTEN\`.`);
  } else {
    ok(label, "free");
  }
});

if (CI_MODE) {
  ok("Live health", "skipped in CI mode");
} else {
  try {
    const health = run("node scripts/health-check.mjs --json");
    const jsonStart = health.indexOf("{");
    const parsed = JSON.parse(jsonStart >= 0 ? health.slice(jsonStart) : health);
    if (parsed.fail === 0) {
      ok("Live health", `${parsed.pass} pass / ${parsed.warn} warn`);
    } else {
      fail(
        "Live health",
        `${parsed.fail} fail / ${parsed.warn} warn`,
        "Run `npm run restart-all` and then `npm run health`.",
      );
    }
  } catch (error) {
    warn("Live health", "services may be down or partially started");
    nextSteps.push("Run `npm run restart-all` and then `npm run health`.");
  }
}

console.log(`\n${B}Summary${N}`);
if (issues.length === 0) {
  console.log(`${G}Ready enough to start using crewswarm.${N}`);
} else {
  console.log(`${R}${issues.length} blocking issue(s) detected.${N}`);
}
if (warnings.length > 0) {
  console.log(`${Y}${warnings.length} warning(s) detected.${N}`);
}

const actions = unique(nextSteps);
if (actions.length > 0) {
  console.log(`\n${B}Next steps${N}`);
  for (const step of actions) {
    console.log(`- ${step}`);
  }
}

process.exit(issues.length > 0 ? 1 : 0);
