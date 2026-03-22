#!/usr/bin/env node
/**
 * sync-prompts.mjs — Sync canonical agent prompts from repo prompts/ into ~/.crewswarm/agent-prompts.json
 *
 * Usage:
 *   node scripts/sync-prompts.mjs          # merge (repo wins on conflict)
 *   node scripts/sync-prompts.mjs --dry    # show what would change without writing
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PROMPTS_DIR    = path.resolve(process.cwd(), "prompts");
const AGENT_PROMPTS  = path.join(os.homedir(), ".crewswarm", "agent-prompts.json");
const DRY            = process.argv.includes("--dry");

// Map filename → bare agent-prompts.json key
const FILE_TO_KEY = {
  "main.md":         "main",
  "pm.md":           "pm",
  "pm-cli.md":       "pm-cli",
  "pm-frontend.md":  "pm-frontend",
  "pm-core.md":      "pm-core",
  "coder.md":        "coder",
  "coder-front.md":  "coder-front",
  "coder-back.md":   "coder-back",
  "frontend.md":     "frontend",
  "qa.md":           "qa",
  "fixer.md":        "fixer",
  "github.md":       "github",
  "security.md":     "security",
  "copywriter.md":   "copywriter",
};

function canonicalKeysFor(key) {
  if (!key) return [];
  return [key, `crew-${key}`];
}

// Load existing
let existing = {};
try { existing = JSON.parse(fs.readFileSync(AGENT_PROMPTS, "utf8")); } catch {}

let updated = 0;
const merged = { ...existing };

for (const [file, key] of Object.entries(FILE_TO_KEY)) {
  const filePath = path.join(PROMPTS_DIR, file);
  if (!fs.existsSync(filePath)) continue;

  const content = fs.readFileSync(filePath, "utf8").trim();
  const keys = canonicalKeysFor(key);
  const currentValues = keys.map((promptKey) => (existing[promptKey] || "").trim());
  const allMatch = currentValues.every((value) => value === content);

  if (allMatch) {
    console.log(`  = ${key} (unchanged)`);
    continue;
  }

  if (DRY) {
    console.log(`  ~ ${key} (would update)`);
  } else {
    for (const promptKey of keys) {
      merged[promptKey] = content;
    }
    console.log(`  ✓ ${key} (updated)`);
    updated++;
  }
}

if (!DRY && updated > 0) {
  fs.mkdirSync(path.dirname(AGENT_PROMPTS), { recursive: true });
  fs.writeFileSync(AGENT_PROMPTS, JSON.stringify(merged, null, 2));
  console.log(`\nSynced ${updated} prompt(s) → ${AGENT_PROMPTS}`);
} else if (updated === 0 && !DRY) {
  console.log("\nAll prompts up to date.");
}
