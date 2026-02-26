#!/usr/bin/env node
/**
 * scan-skills.mjs — audit all SKILL.md files in ~/.crewswarm/skills/
 * Usage: node scripts/scan-skills.mjs
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const SKILLS_DIR = path.join(os.homedir(), ".crewswarm", "skills");

if (!fs.existsSync(SKILLS_DIR)) {
  console.log("No skills directory found at", SKILLS_DIR);
  process.exit(0);
}

const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
const skillDirs = entries
  .filter(e => e.isDirectory() && fs.existsSync(path.join(SKILLS_DIR, e.name, "SKILL.md")))
  .map(e => e.name);

const jsonSkills = entries
  .filter(e => e.isFile() && e.name.endsWith(".json"))
  .map(e => e.name.replace(".json", ""));

console.log(`\n🛡️  CrewSwarm Skill Security Audit`);
console.log(`${"─".repeat(60)}`);
console.log(`Skills dir: ${SKILLS_DIR}`);
console.log(`SKILL.md skills: ${skillDirs.length}  |  JSON skills: ${jsonSkills.length}`);
console.log(`${"─".repeat(60)}\n`);

if (jsonSkills.length) {
  console.log(`✅  JSON skills (data-only, no prompt injection risk):`);
  jsonSkills.forEach(s => console.log(`   • ${s}`));
  console.log();
}

if (!skillDirs.length) {
  console.log("No SKILL.md skills to scan.\n");
  process.exit(0);
}

console.log(`🔍 Scanning ${skillDirs.length} SKILL.md skill(s)...\n`);

let blocked = 0, warned = 0, safe = 0;

for (const name of skillDirs) {
  const dir = path.join(SKILLS_DIR, name);
  try {
    const out = execSync(`npx clawscan scan "${dir}" 2>&1`, {
      timeout: 20000, encoding: "utf8",
    });
    const scoreMatch = out.match(/score:\s*(\d+)/i);
    const score = scoreMatch ? parseInt(scoreMatch[1]) : 0;
    const dangerous = /🔴|DANGEROUS|CRITICAL/i.test(out);
    const warning   = /🟡|WARNING/i.test(out);
    const emoji = dangerous ? "🔴" : warning ? "🟡" : "🟢";
    const label = dangerous ? "DANGEROUS" : warning ? "WARNING" : "SAFE";
    console.log(`${emoji}  ${name.padEnd(35)} score: ${String(score).padStart(3)}/100  ${label}`);
    if (dangerous || warning) {
      // Print relevant findings
      const lines = out.split("\n").filter(l => /finding|inject|steal|exec|shell|credential|obfuscat/i.test(l));
      lines.slice(0, 3).forEach(l => console.log(`      ${l.trim()}`));
    }
    if (dangerous) blocked++;
    else if (warning) warned++;
    else safe++;
  } catch (e) {
    console.log(`⚪  ${name.padEnd(35)} scan failed: ${e.message?.slice(0, 60)}`);
  }
}

console.log(`\n${"─".repeat(60)}`);
console.log(`Summary: 🟢 ${safe} safe  🟡 ${warned} warnings  🔴 ${blocked} dangerous`);
if (blocked > 0) {
  console.log(`\n⛔  Remove dangerous skills from ${SKILLS_DIR}`);
}
console.log();
