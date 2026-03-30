#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const jsonMode = process.argv.includes("--json");
const repoRoot = process.cwd();
const appPath = path.join(os.homedir(), "Applications", "crewchat.app");
const buildScript = path.join(repoRoot, "build-crewchat.sh");
const sourcePath = path.join(repoRoot, "apps", "crewchat", "CrewChat.swift");

const payload = {
  buildScriptPresent: fs.existsSync(buildScript),
  sourcePresent: fs.existsSync(sourcePath),
  installedAppPresent: fs.existsSync(appPath),
  appPath,
  checklist: [
    "1. Build: ./build-crewchat.sh",
    "2. Launch: open -a crewchat.app",
    "3. Switch between crew-lead, CLI, and agent modes.",
    "4. Send one text message, one image, and one voice note.",
    "5. Confirm per-project and per-mode history isolation.",
  ],
};

if (jsonMode) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

console.log("crewchat live verification");
console.log("");
console.log(`Build script present: ${payload.buildScriptPresent ? "yes" : "no"}`);
console.log(`Source present: ${payload.sourcePresent ? "yes" : "no"}`);
console.log(`Installed app present: ${payload.installedAppPresent ? "yes" : "no"}`);
console.log(`App path: ${payload.appPath}`);
console.log("");
console.log("Checklist:");
for (const item of payload.checklist) {
  console.log(`  ${item}`);
}
