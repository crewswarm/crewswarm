#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CREW_LEAD_URL = process.env.CREW_LEAD_URL || "http://127.0.0.1:5010";
const CFG = path.join(os.homedir(), ".crewswarm", "config.json");
const timeoutMs = Number(process.env.CREWSWARM_SMOKE_TIMEOUT_MS || "120000");
const pollMs = Number(process.env.CREWSWARM_SMOKE_POLL_MS || "1500");

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
  if (!token) throw new Error("Missing RT token in ~/.crewswarm/config.json (rt.authToken)");

  const res = await fetch(`${CREW_LEAD_URL}/api/dispatch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ agent, task, sessionId: "smoke-dispatch" }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`dispatch ${res.status}: ${body}`);
  }
  const data = await res.json();
  const taskId = data.taskId || data.id;
  if (!taskId) throw new Error("dispatch response missing taskId");
  return String(taskId);
}

async function getStatus(taskId) {
  const token = getToken();
  const res = await fetch(`${CREW_LEAD_URL}/api/status/${taskId}`, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

async function waitDone(taskId, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollMs));
    const status = await getStatus(taskId);
    const state = String(status?.status || "unknown").toLowerCase();
    if (state === "done") return status;
    if (["failed", "error", "issues", "cancelled", "unknown"].includes(state)) {
      const detail = status?.error || status?.result || JSON.stringify(status);
      throw new Error(`${label} ended with status=${state}: ${String(detail).slice(0, 300)}`);
    }
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run() {
  const runId = Date.now().toString(36);
  const projectRoot = path.join(path.dirname(process.argv[1]), "..");
const outDir = path.join(projectRoot, "test-output", "smoke-dispatch");
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`[smoke-dispatch] runId=${runId}`);

  const marker = `SMOKE_DISPATCH_OK_${runId}`;
  const outFile = path.join(outDir, `coder-${runId}.txt`);

  const coderTask = [
    `Create this file with @@WRITE_FILE: ${outFile}`,
    `Write exactly one line: ${marker}`,
    `Do not add extra text to the file.`,
  ].join("\n");

  console.log("[1/2] dispatch crew-coder...");
  const coderTaskId = await dispatch("crew-coder", coderTask);
  const coderResult = await waitDone(coderTaskId, "crew-coder smoke task");
  assert(fs.existsSync(outFile), `expected output file missing: ${outFile}`);
  const fileBody = fs.readFileSync(outFile, "utf8").trim();
  assert(fileBody === marker, `unexpected file content: ${fileBody}`);
  console.log(`[ok] crew-coder done (${coderTaskId})`);

  const mainMarker = `MAIN_OK_${runId}`;
  const mainTask = `Reply with exactly: ${mainMarker}`;

  console.log("[2/2] dispatch crew-main...");
  const mainTaskId = await dispatch("crew-main", mainTask);
  const mainResult = await waitDone(mainTaskId, "crew-main smoke task");
  const text = String(mainResult?.result || "");
  assert(text.includes(mainMarker), `crew-main result missing marker (${mainMarker})`);
  console.log(`[ok] crew-main done (${mainTaskId})`);

  console.log("[smoke-dispatch] PASS");
}

run().catch((err) => {
  console.error(`[smoke-dispatch] FAIL: ${err.message}`);
  process.exit(1);
});
