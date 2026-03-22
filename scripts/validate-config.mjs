#!/usr/bin/env node
/**
 * crewswarm Config Validator
 *
 * Validates ~/.crewswarm/crewswarm.json and config.json
 * Checks for missing models, invalid provider configs, and common issues.
 *
 * Usage:
 *   node scripts/validate-config.mjs
 *   node scripts/validate-config.mjs --fix      # Auto-fix common issues
 *   node scripts/validate-config.mjs --json     # Machine-readable output
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const JSON_MODE = process.argv.includes("--json");
const FIX_MODE = process.argv.includes("--fix");
const SWARM_PATH = path.join(os.homedir(), ".crewswarm", "crewswarm.json");
const CONFIG_PATH = path.join(os.homedir(), ".crewswarm", "crewswarm.json");
const BACKUP_PATH = path.join(os.homedir(), ".crewswarm", `crewswarm.json.backup-${Date.now()}`);

// ── Colors ──────────────────────────────────────────────────────────────────
const R = "\x1b[0m", B = "\x1b[1m", G = "\x1b[32m", RE = "\x1b[31m", Y = "\x1b[33m", C = "\x1b[36m";

const results = [];
let errors = 0, warnings = 0, fixed = 0;

function log(level, name, detail = "") {
  results.push({ level, name, detail });
  if (JSON_MODE) return;
  
  if (level === "error") {
    errors++;
    console.log(`  ${RE}✗${R} ${name}${detail ? `\n    ${detail}` : ""}`);
  } else if (level === "warn") {
    warnings++;
    console.log(`  ${Y}⚠${R} ${name}${detail ? `\n    ${detail}` : ""}`);
  } else if (level === "fix") {
    fixed++;
    console.log(`  ${G}✓${R} ${B}FIXED:${R} ${name}${detail ? `\n    ${detail}` : ""}`);
  } else {
    console.log(`  ${G}✓${R} ${name}${detail ? `\n    ${detail}` : ""}`);
  }
}

function section(title) {
  if (!JSON_MODE) console.log(`\n${B}${C}── ${title} ──${R}`);
}

// ── Validation Functions ────────────────────────────────────────────────────

function validateJSON(filePath, label) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(content);
    log("pass", `${label} is valid JSON`);
    return { ok: true, data: parsed };
  } catch (err) {
    log("error", `${label} is invalid`, err.message);
    return { ok: false, error: err.message };
  }
}

function validateProviders(config) {
  const providers = config?.providers || {};
  const keys = Object.keys(providers);
  
  if (keys.length === 0) {
    log("error", "No providers configured", "Add API keys in dashboard → Providers tab");
    return { ok: false, keys: [] };
  }
  
  const withKeys = keys.filter(k => providers[k]?.apiKey?.length > 8);
  
  if (withKeys.length === 0) {
    log("error", "No valid API keys found", "All providers have empty/short keys");
    return { ok: false, keys: [] };
  }
  
  log("pass", `${withKeys.length} providers with API keys`, withKeys.join(", "));
  return { ok: true, keys: withKeys };
}

function validateAgentModels(config) {
  const agents = config?.agents || [];
  
  if (agents.length === 0) {
    log("error", "No agents defined", "Run: bash install.sh");
    return { ok: false, missing: [] };
  }
  
  const withModels = agents.filter(a => a.model && String(a.model).trim());
  const missingModels = agents.filter(a => !a.model || !String(a.model).trim());
  
  if (missingModels.length === agents.length) {
    log("error", `ALL ${agents.length} agents missing models`, 
      `This is likely from a broken bulk operation. Restore from backup:\n` +
      `    cp ~/.crewswarm/crewswarm.json.backup ~/.crewswarm/crewswarm.json`);
    return { ok: false, missing: missingModels.map(a => a.id) };
  }
  
  if (missingModels.length > 0) {
    log("warn", `${missingModels.length} agents missing models`, 
      `Missing: ${missingModels.map(a => a.id).join(", ")}`);
    return { ok: false, missing: missingModels.map(a => a.id) };
  }
  
  log("pass", `All ${agents.length} agents have models assigned`);
  return { ok: true, missing: [] };
}

function validateModelProviders(config, validProviders) {
  const agents = config?.agents || [];
  const invalid = [];
  
  for (const agent of agents) {
    if (!agent.model) continue;
    const [provider] = String(agent.model).split("/");
    if (!validProviders.includes(provider)) {
      invalid.push({ agent: agent.id, model: agent.model, provider });
    }
  }
  
  if (invalid.length > 0) {
    log("warn", `${invalid.length} agents use unconfigured providers`,
      invalid.map(i => `${i.agent}: ${i.model} (no API key for ${i.provider})`).join("\n    "));
    return { ok: false, invalid };
  }
  
  log("pass", "All agent models use configured providers");
  return { ok: true, invalid: [] };
}

function validateEngineAssignments(config) {
  const agents = config?.agents || [];
  const engineFlags = [
    'useOpenCode', 'useCursorCli', 'useClaudeCode', 'useCodex', 
    'useGeminiCli', 'useCrewCLI', 'useDockerSandbox'
  ];
  
  const noEngine = agents.filter(a => {
    return !engineFlags.some(flag => a[flag] === true) && !a.engine;
  });
  
  if (noEngine.length > agents.length * 0.5) {
    log("warn", `${noEngine.length} agents have no engine assigned`,
      "Agents will use direct LLM calls (no file access). Consider assigning engines.");
    return { ok: false, noEngine: noEngine.map(a => a.id) };
  }
  
  if (noEngine.length > 0) {
    log("pass", `${agents.length - noEngine.length} agents have engines`,
      `${noEngine.length} using direct LLM: ${noEngine.map(a => a.id).join(", ")}`);
  } else {
    log("pass", `All ${agents.length} agents have engines assigned`);
  }
  
  return { ok: true, noEngine: noEngine.map(a => a.id) };
}

function validateBackups() {
  const backupDir = path.dirname(SWARM_PATH);
  try {
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith("crewswarm.json.backup"))
      .sort()
      .reverse();
    
    if (files.length === 0) {
      log("warn", "No backup files found", 
        "Create one: cp ~/.crewswarm/crewswarm.json ~/.crewswarm/crewswarm.json.backup");
      return { ok: false, count: 0 };
    }
    
    log("pass", `${files.length} backup files available`, 
      `Latest: ${files[0]}`);
    return { ok: true, count: files.length, latest: files[0] };
  } catch (err) {
    log("error", "Failed to check backups", err.message);
    return { ok: false, count: 0 };
  }
}

function validateRTConfig(config) {
  const rt = config?.rt || {};
  
  if (!rt.authToken || rt.authToken.length < 20) {
    log("error", "RT auth token missing or too short", 
      "Re-run: bash install.sh");
    return { ok: false };
  }
  
  log("pass", "RT auth token configured", `${rt.authToken.slice(0, 8)}...`);
  return { ok: true };
}

// ── Auto-Fix Functions ──────────────────────────────────────────────────────

function autoFixMissingModels(config, missingAgents) {
  if (!FIX_MODE || missingAgents.length === 0) return false;
  
  // Try to find a backup with models
  const backupDir = path.dirname(SWARM_PATH);
  const backups = fs.readdirSync(backupDir)
    .filter(f => f.startsWith("crewswarm.json.backup"))
    .sort()
    .reverse();
  
  for (const backupFile of backups) {
    try {
      const backupPath = path.join(backupDir, backupFile);
      const backupData = JSON.parse(fs.readFileSync(backupPath, "utf8"));
      const backupAgents = backupData?.agents || [];
      
      let restored = 0;
      for (const agentId of missingAgents) {
        const backupAgent = backupAgents.find(a => a.id === agentId);
        if (backupAgent?.model) {
          const currentAgent = config.agents.find(a => a.id === agentId);
          if (currentAgent) {
            currentAgent.model = backupAgent.model;
            restored++;
          }
        }
      }
      
      if (restored > 0) {
        // Backup current before fixing
        fs.copyFileSync(SWARM_PATH, BACKUP_PATH);
        fs.writeFileSync(SWARM_PATH, JSON.stringify(config, null, 2));
        log("fix", `Restored ${restored} agent models from ${backupFile}`,
          `Original backed up to: ${path.basename(BACKUP_PATH)}`);
        return true;
      }
    } catch (err) {
      continue;
    }
  }
  
  log("error", "Auto-fix failed: no valid backup found with models");
  return false;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function run() {
  if (!JSON_MODE) {
    console.log(`\n${B}${C}━━━ crewswarm Config Validator ━━━${R}`);
    if (FIX_MODE) console.log(`${Y}⚡ Auto-fix mode enabled${R}`);
  }
  
  // 1. Check files exist
  section("Files");
  if (!fs.existsSync(SWARM_PATH)) {
    log("error", "crewswarm.json not found", `Expected at: ${SWARM_PATH}\nRun: bash install.sh`);
    process.exit(1);
  }
  if (!fs.existsSync(CONFIG_PATH)) {
    log("error", "config.json not found", `Expected at: ${CONFIG_PATH}\nRun: bash install.sh`);
    process.exit(1);
  }
  
  // 2. Validate JSON
  section("JSON Syntax");
  const swarmResult = validateJSON(SWARM_PATH, "crewswarm.json");
  const configResult = validateJSON(CONFIG_PATH, "crewswarm.json");
  
  if (!swarmResult.ok || !configResult.ok) {
    log("error", "Cannot proceed with invalid JSON", "Fix syntax errors first");
    process.exit(1);
  }
  
  const swarmConfig = swarmResult.data;
  const rtConfig = configResult.data;
  
  // 3. Validate RT config
  section("RT Configuration");
  validateRTConfig(rtConfig);
  
  // 4. Validate providers
  section("Providers");
  const providersResult = validateProviders(swarmConfig);
  
  // 5. Validate agent models
  section("Agent Models");
  const modelsResult = validateAgentModels(swarmConfig);
  
  if (!modelsResult.ok && modelsResult.missing.length > 0) {
    const didFix = autoFixMissingModels(swarmConfig, modelsResult.missing);
    if (didFix) {
      // Re-validate after fix
      const fixedConfig = JSON.parse(fs.readFileSync(SWARM_PATH, "utf8"));
      validateAgentModels(fixedConfig);
    }
  }
  
  // 6. Validate model providers match configured providers
  if (providersResult.ok && modelsResult.ok) {
    section("Model Provider Consistency");
    validateModelProviders(swarmConfig, providersResult.keys);
  }
  
  // 7. Validate engine assignments
  section("Engine Assignments");
  validateEngineAssignments(swarmConfig);
  
  // 8. Check backups
  section("Backup Files");
  validateBackups();
  
  // ── Summary ───────────────────────────────────────────────────────────────
  if (JSON_MODE) {
    console.log(JSON.stringify({ results, errors, warnings, fixed }, null, 2));
  } else {
    console.log(`\n${B}${C}━━━ Summary ━━━${R}`);
    if (fixed > 0) console.log(`  ${G}✓ ${fixed} issue(s) auto-fixed${R}`);
    if (errors === 0 && warnings === 0) {
      console.log(`  ${G}✓ All checks passed!${R}`);
    } else {
      if (errors > 0) console.log(`  ${RE}✗ ${errors} error(s)${R}`);
      if (warnings > 0) console.log(`  ${Y}⚠ ${warnings} warning(s)${R}`);
      
      if (errors > 0 && !FIX_MODE) {
        console.log(`\n${Y}Tip: Run with --fix to auto-repair common issues${R}`);
      }
    }
  }
  
  process.exit(errors > 0 ? 1 : 0);
}

run().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
