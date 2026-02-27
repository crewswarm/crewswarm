#!/usr/bin/env node
/**
 * Replay a single DLQ entry: read the JSON, re-send the task to the same agent
 * via gateway-bridge --send. Used by openswitchctl dlq-replay <key>.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CFG_DIR = process.env.CREWSWARM_CONFIG_DIR
  || process.env.OPENCREWHQ_CONFIG_DIR   // legacy env alias
  || path.join(os.homedir(), ".crewswarm");
const SHARED_MEMORY_BASE = process.env.SHARED_MEMORY_DIR || path.join(os.homedir(), ".crewswarm", "workspace", "shared-memory");
const SHARED_MEMORY_NAMESPACE = process.env.SHARED_MEMORY_NAMESPACE || "claw-swarm";
const DLQ_DIR = path.join(SHARED_MEMORY_BASE, SHARED_MEMORY_NAMESPACE, "opencrew-rt", "dlq");
const CREWSWARM_DIR = process.env.CREWSWARM_DIR || process.env.OPENCLAW_DIR || path.resolve(__dirname, "..");

const key = process.argv[2];
if (!key) {
  console.error("Usage: node scripts/dlq-replay.mjs <key>");
  process.exit(1);
}

const keySafe = key.replace(/[^a-zA-Z0-9_-]/g, "");
const file = path.join(DLQ_DIR, `${keySafe}.json`);
if (!fs.existsSync(file)) {
  console.error(`DLQ entry not found: ${key}`);
  process.exit(2);
}

let entry;
try {
  entry = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (e) {
  console.error("Invalid DLQ JSON:", e.message);
  process.exit(3);
}

const agent = entry.agent;
const prompt = entry.prompt || entry.payload?.prompt || entry.payload?.message || entry.error || "(replay)";
if (!agent) {
  console.error("DLQ entry missing agent");
  process.exit(4);
}

const bridge = path.join(CREWSWARM_DIR, "gateway-bridge.mjs");
const result = spawnSync("node", [bridge, "--send", agent, prompt], {
  cwd: CREWSWARM_DIR,
  encoding: "utf8",
  timeout: 120000,
  env: { ...process.env, CREWSWARM_DIR },
});

if (result.status !== 0) {
  console.error(result.stderr || result.error || "Replay failed");
  process.exit(result.status || 1);
}
if (result.stdout) process.stdout.write(result.stdout);
