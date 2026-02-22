#!/usr/bin/env node
/**
 * CrewSwarm System Test
 * Traces through every layer of the stack and reports pass/fail.
 * Usage: node scripts/crewswarm-test.mjs [--quick] [--agent crew-pm]
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const args = process.argv.slice(2);
const QUICK = args.includes("--quick");
const TEST_AGENT = args[args.indexOf("--agent") + 1] || "crew-pm";

// ── Colours ────────────────────────────────────────────────────────────────
const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const Y = s => `\x1b[33m${s}\x1b[0m`;
const B = s => `\x1b[34m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;

// ── Results ────────────────────────────────────────────────────────────────
const results = [];
function pass(name, detail = "") { results.push({ ok: true,  name, detail }); }
function fail(name, detail = "") { results.push({ ok: false, name, detail }); }
function skip(name, detail = "") { results.push({ ok: null,  name, detail }); }

// ── Helpers ────────────────────────────────────────────────────────────────
function pgrep(pattern) {
  try { return execSync(`pgrep -f "${pattern}" 2>/dev/null`, { encoding: "utf8" }).trim().split("\n").filter(Boolean); }
  catch { return []; }
}

function portOpen(port) {
  try { execSync(`lsof -i :${port} -sTCP:LISTEN -t 2>/dev/null`, { encoding: "utf8", stdio: "pipe" }); return true; }
  catch { return false; }
}

async function httpGet(url, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text };
  } catch (e) { return { ok: false, status: 0, text: e.message }; }
  finally { clearTimeout(t); }
}

function loadConfig() {
  const paths = [
    join(homedir(), ".crewswarm", "config.json"),
    join(homedir(), ".crewswarm", "crewswarm.json"),
    join(homedir(), ".openclaw", "openclaw.json"),
  ];
  for (const p of paths) {
    try { return { path: p, cfg: JSON.parse(readFileSync(p, "utf8")) }; } catch {}
  }
  return { path: null, cfg: {} };
}

function rtToken() {
  for (const p of [
    join(homedir(), ".crewswarm", "config.json"),
    join(homedir(), ".crewswarm", "crewswarm.json"),
    join(homedir(), ".openclaw", "openclaw.json"),
  ]) {
    try {
      const c = JSON.parse(readFileSync(p, "utf8"));
      const t = c?.rt?.authToken || c?.env?.OPENCREW_RT_AUTH_TOKEN || "";
      if (t) return t;
    } catch {}
  }
  return "";
}

// ── Tests ──────────────────────────────────────────────────────────────────

console.log(B("\n━━━ CrewSwarm System Test ━━━\n"));

// 1. Config files
console.log(D("1. Config files"));
{
  const { path: cfgPath, cfg } = loadConfig();
  if (cfgPath) pass("Config file exists", cfgPath);
  else fail("Config file exists", "No config found in ~/.crewswarm/ or ~/.openclaw/");

  const token = rtToken();
  if (token) pass("RT auth token present", `${token.slice(0, 8)}...`);
  else skip("RT auth token", "No token — RT daemon runs unauthenticated (fine for local)");

  const ocPath = join(homedir(), ".openclaw", "openclaw.json");
  if (existsSync(ocPath)) {
    const oc = JSON.parse(readFileSync(ocPath, "utf8"));
    const agents = Array.isArray(oc.agents) ? oc.agents : (oc.agents?.list || []);
    if (agents.length) pass("openclaw.json agents", `${agents.length} agents defined`);
    else fail("openclaw.json agents", "No agents in openclaw.json");
    const providers = Object.keys(oc?.models?.providers || {});
    if (providers.length) pass("LLM providers configured", providers.join(", "));
    else fail("LLM providers configured", "No providers in openclaw.json");
  } else fail("openclaw.json exists", ocPath);
}

// 2. Processes
console.log(D("\n2. Running processes"));
{
  const rtPids = pgrep("opencrew-rt-daemon");
  if (rtPids.length) pass("RT daemon running", `pid ${rtPids[0]}`);
  else fail("RT daemon running", "opencrew-rt-daemon not found");

  const bridgePids = pgrep("gateway-bridge.mjs --rt-daemon");
  if (bridgePids.length >= 10) pass(`Agent bridges running`, `${bridgePids.length} processes`);
  else if (bridgePids.length > 0) fail(`Agent bridges running`, `Only ${bridgePids.length} (expected 13)`);
  else fail("Agent bridges running", "No gateway-bridge processes found");

  const clPids = pgrep("crew-lead.mjs");
  if (clPids.length) pass("crew-lead running", `pid ${clPids[0]}`);
  else fail("crew-lead running", "crew-lead.mjs not found");

  const dbPids = pgrep("scripts/dashboard.mjs");
  if (dbPids.length) pass("Dashboard running", `pid ${dbPids[0]}`);
  else fail("Dashboard running", "scripts/dashboard.mjs not found");
}

// 3. Ports
console.log(D("\n3. Listening ports"));
{
  const checks = [
    [18889, "RT daemon (WS)"],
    [5010,  "crew-lead HTTP"],
    [4319,  "Dashboard"],
    [4096,  "OpenCode serve"],
    [8000,  "Local LLM proxy (Codex)"],
  ];
  for (const [port, label] of checks) {
    if (portOpen(port)) pass(`Port ${port} — ${label}`);
    else if (port === 4096 || port === 8000) skip(`Port ${port} — ${label}`, "optional");
    else fail(`Port ${port} — ${label}`, "not listening");
  }
}

// 4. RT daemon HTTP status
console.log(D("\n4. RT daemon health"));
{
  const res = await httpGet("http://127.0.0.1:18889/status");
  if (!res.ok) {
    fail("RT daemon /status", res.text.slice(0, 100));
  } else {
    try {
      const j = JSON.parse(res.text);
      pass("RT daemon /status reachable", `clients=${j.clients}`);
      const bridges = (j.agents || []).filter(a => a !== "crew-lead");
      if (bridges.length >= 10) pass("Agents authenticated with RT", `${bridges.length}/13: ${bridges.slice(0,5).join(", ")}...`);
      else if (bridges.length > 0) fail("Agents authenticated with RT", `Only ${bridges.length} agents connected: ${bridges.join(", ")}`);
      else fail("Agents authenticated with RT", "No agents in RT daemon — likely token mismatch");

      const hasCrewLead = (j.agents || []).includes("crew-lead");
      if (hasCrewLead) pass("crew-lead connected to RT", "receiving agent replies");
      else fail("crew-lead connected to RT", "crew-lead not in RT agent list — replies won't reach chat");
    } catch { fail("RT daemon /status parse", res.text.slice(0, 100)); }
  }
}

// 5. Dashboard API
console.log(D("\n5. Dashboard API"));
{
  const endpoints = [
    ["/api/services/status", "services status"],
    ["/api/rt-messages",     "RT messages"],
    ["/api/dlq",             "DLQ"],
  ];
  for (const [path, label] of endpoints) {
    const res = await httpGet(`http://127.0.0.1:4319${path}`);
    if (res.ok) {
      try { JSON.parse(res.text); pass(`Dashboard ${label}`, `HTTP ${res.status}`); }
      catch { fail(`Dashboard ${label}`, "response not valid JSON"); }
    } else fail(`Dashboard ${label}`, `HTTP ${res.status}: ${res.text.slice(0, 80)}`);
  }

  // Check agent count from services
  const svcRes = await httpGet("http://127.0.0.1:4319/api/services/status");
  if (svcRes.ok) {
    try {
      const j = JSON.parse(svcRes.text);
      const s = j.services?.find(s => s.id === "bridges") || j.services?.find(s => s.id === "agents");
      const agents = j.agentsOnline ?? j.agents_online;
      if (agents != null) {
        if (agents >= 10) pass("Dashboard agent count", `${agents} online`);
        else fail("Dashboard agent count", `Only ${agents} online`);
      } else skip("Dashboard agent count", "agentsOnline field not in response");
    } catch {}
  }
}

// 6. crew-lead chat
console.log(D("\n6. crew-lead chat"));
{
  const res = await httpGet("http://127.0.0.1:5010/status");
  if (res.ok) {
    try {
      const j = JSON.parse(res.text);
      pass("crew-lead /status", `model=${j.model || "?"}`);
    } catch { pass("crew-lead /status", "responded OK"); }
  } else fail("crew-lead /status", `HTTP ${res.status}`);

  if (!QUICK) {
    // Post a test chat message
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch("http://127.0.0.1:5010/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Reply with exactly: SYSTEM_OK", sessionId: "test-probe" }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const d = await r.json();
      const reply = d.reply || d.response || d.message || "";
      if (reply.toLowerCase().includes("system_ok") || reply.length > 0) pass("crew-lead chat response", reply.slice(0, 80));
      else fail("crew-lead chat response", `unexpected reply: ${reply.slice(0, 80)}`);
    } catch (e) { fail("crew-lead chat response", e.message); }
  } else skip("crew-lead chat response", "--quick mode");
}

// 7. Agent RT dispatch (round-trip)
console.log(D(`\n7. Agent RT round-trip (→ ${TEST_AGENT})`));
if (QUICK) {
  skip("Agent RT round-trip", "--quick mode skipped");
} else {
  const token = rtToken();
  const bridgePath = join(REPO, "gateway-bridge.mjs");
  const env = { ...process.env, OPENCREW_RT_AUTH_TOKEN: token, OPENCLAW_DIR: REPO };

  console.log(D(`   Sending test task to ${TEST_AGENT}...`));
  const result = spawnSync(
    process.execPath,
    [bridgePath, "--send", TEST_AGENT, "Reply with exactly one word: PONG"],
    { env, encoding: "utf8", timeout: 45000, cwd: REPO }
  );

  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();

  // stdout may include bridge startup lines; last non-empty line is the actual reply
  const replyLine = stdout.split("\n").map(l => l.trim()).filter(Boolean).pop() || "";
  if (result.status === 0 && replyLine) {
    pass(`${TEST_AGENT} RT round-trip`, replyLine.slice(0, 80));
  } else {
    const errMsg = stderr.split("\n").filter(l => /error|fail|refused|token/i.test(l)).join(" ");
    fail(`${TEST_AGENT} RT round-trip`, errMsg.slice(0, 120) || "no reply / timeout");
  }
}

// 8. Agent model routing
console.log(D("\n8. Agent model routing"));
{
  const ocPath = join(homedir(), ".openclaw", "openclaw.json");
  if (existsSync(ocPath)) {
    const oc = JSON.parse(readFileSync(ocPath, "utf8"));
    const agents = Array.isArray(oc.agents) ? oc.agents : (oc.agents?.list || []);
    const providers = oc?.models?.providers || {};
    let allOk = true;
    for (const agent of agents) {
      if (!agent.model) continue;
      const [provKey] = agent.model.split("/");
      const prov = providers[provKey];
      if (!prov?.baseUrl || !prov?.apiKey) {
        fail(`${agent.id} model provider`, `"${provKey}" missing baseUrl or apiKey`);
        allOk = false;
      }
    }
    if (allOk && agents.length) pass("All agent models have valid providers", `${agents.filter(a=>a.model).length} configured`);
  }

  // Verify openai-local (Codex) reachable if configured
  if (portOpen(8000)) {
    const r = await httpGet("http://127.0.0.1:8000/v1/models", 3000);
    if (r.ok) {
      const models = JSON.parse(r.text).data?.map(m => m.id) || [];
      pass("Local Codex server reachable", `${models.length} models: ${models.slice(0,3).join(", ")}...`);
    } else fail("Local Codex server reachable", r.text.slice(0, 80));
  } else skip("Local Codex server (port 8000)", "not running");
}

// 9. RT events log
console.log(D("\n9. RT events log"));
{
  const logPath = join(homedir(), ".openclaw", "workspace", "shared-memory", "claw-swarm", "opencrew-rt", "events.jsonl");
  if (existsSync(logPath)) {
    const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
    pass("RT events.jsonl exists", `${lines.length} total events`);
    const recent = lines.slice(-200).filter(l => !l.includes("heartbeat") && !l.includes("agent.online"));
    if (recent.length > 0) {
      const last = JSON.parse(recent[recent.length - 1]);
      const env = last.envelope || last;
      pass("Recent non-heartbeat events", `last: ${env.type} ${env.from}→${env.to} @ ${env.ts?.slice(11,19)}`);
    } else skip("Recent task events", "no task events in last 200 lines");
  } else fail("RT events.jsonl exists", logPath);
}

// 10. SwiftBar / openswitchctl
console.log(D("\n10. SwiftBar / openswitchctl"));
{
  const ctlPath = join(REPO, "scripts", "openswitchctl");
  if (existsSync(ctlPath)) {
    try {
      const out = execSync(`/bin/bash "${ctlPath}" status`, { encoding: "utf8", timeout: 8000 }).trim();
      if (out.includes("running")) pass("openswitchctl status", out.slice(0, 80));
      else fail("openswitchctl status", out.slice(0, 80));
    } catch (e) { fail("openswitchctl status", e.message.slice(0, 80)); }
  } else fail("openswitchctl exists", ctlPath);

  const swiftBarPlugin = join(homedir(), "Library", "Application Support", "SwiftBar", "plugins", "openswitch.10s.sh");
  if (existsSync(swiftBarPlugin)) pass("SwiftBar plugin installed", swiftBarPlugin);
  else fail("SwiftBar plugin installed", swiftBarPlugin);
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log(B("\n━━━ Results ━━━\n"));
let passed = 0, failed = 0, skipped = 0;
for (const r of results) {
  if (r.ok === true)  { console.log(G("✅"), r.name.padEnd(45), D(r.detail)); passed++; }
  if (r.ok === false) { console.log(R("❌"), r.name.padEnd(45), Y(r.detail)); failed++; }
  if (r.ok === null)  { console.log(Y("⏭ "), r.name.padEnd(45), D(r.detail)); skipped++; }
}

console.log(`\n${G(passed + " passed")}  ${failed ? R(failed + " failed") : "0 failed"}  ${D(skipped + " skipped")}`);
if (failed === 0) console.log(G("\n✅ All systems operational!\n"));
else console.log(R(`\n❌ ${failed} test(s) need attention. Fix the red items above.\n`));
