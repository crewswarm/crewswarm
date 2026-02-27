#!/usr/bin/env node
/**
 * Test crew-lead dispatch: POST /api/dispatch then poll /api/status until done.
 * Usage: node scripts/test-dispatch.mjs [agent] [task]
 * Default: agent=crew-coder, task=create test-from-lead.txt
 * Example: node scripts/test-dispatch.mjs crew-main "Reply with exactly: MAIN_OK"
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CREW_LEAD_URL = process.env.CREW_LEAD_URL || "http://127.0.0.1:5010";
const CFG = path.join(os.homedir(), ".crewswarm", "config.json");

function getToken() {
  try {
    const c = JSON.parse(fs.readFileSync(CFG, "utf8"));
    return c.rt?.authToken || c.env?.CREWSWARM_RT_AUTH_TOKEN || "";
  } catch {
    return "";
  }
}

async function dispatch(agent, task) {
  const token = getToken();
  if (!token) {
    console.error("No RT token in ~/.crewswarm/config.json (rt.authToken)");
    process.exit(1);
  }
  const res = await fetch(`${CREW_LEAD_URL}/api/dispatch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ agent, task, sessionId: "test-dispatch" }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`dispatch ${res.status}: ${t}`);
  }
  const data = await res.json();
  return data.taskId || data;
}

async function status(taskId) {
  const token = getToken();
  const res = await fetch(`${CREW_LEAD_URL}/api/status/${taskId}`, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

async function main() {
  const agent = process.argv[2] || "crew-coder";
  const task = process.argv[3] || `Create a file named test-from-lead.txt in the current directory (CrewSwarm repo root) with exactly this content: Hello from crew-lead dispatch. Use @@WRITE_FILE.`;

  console.log("Agent:", agent);
  console.log("Task:", task.slice(0, 120) + (task.length > 120 ? "..." : ""));
  console.log("");

  let taskId;
  try {
    taskId = await dispatch(agent, task);
    console.log("Dispatched. taskId:", taskId);
  } catch (e) {
    console.error("Dispatch failed:", e.message);
    process.exit(1);
  }

  if (!taskId || taskId === true) {
    console.log("(No taskId returned — reply may still arrive via RT; check dashboard Chat or RT Messages)");
    process.exit(0);
  }

  const maxWait = 120_000; // 2 min
  const interval = 2000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    await new Promise((r) => setTimeout(r, interval));
    const s = await status(taskId);
    process.stdout.write(`  status: ${s.status} (${Math.round((Date.now() - start) / 1000)}s)\r`);
    if (s.status === "done") {
      console.log("\nDone.");
      if (s.result) console.log("Result:", s.result.slice(0, 500));
      process.exit(0);
    }
    if (s.status === "unknown") {
      console.log("\nTask unknown (may have expired or crew-lead restarted).");
      process.exit(0);
    }
  }
  console.log("\nTimeout waiting for reply.");
  process.exit(1);
}

main();
