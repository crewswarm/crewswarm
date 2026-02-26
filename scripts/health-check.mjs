#!/usr/bin/env node
/**
 * CrewSwarm Health Check
 *
 * Fast all-systems status — completes in < 10 seconds.
 * Checks every service, CLI tool, API key, and MCP server.
 *
 * Usage:
 *   node scripts/health-check.mjs           # full check
 *   node scripts/health-check.mjs --json    # machine-readable output
 *   node scripts/health-check.mjs --quiet   # only print failures
 */

import fs   from "node:fs";
import path from "node:path";
import os   from "node:os";
import { execSync } from "node:child_process";

const JSON_MODE  = process.argv.includes("--json");
const QUIET_MODE = process.argv.includes("--quiet");
const CREW_LEAD  = process.env.CREW_LEAD_URL  || "http://127.0.0.1:5010";
const DASHBOARD  = process.env.DASHBOARD_URL  || "http://127.0.0.1:4319";
const MCP_URL    = process.env.MCP_URL        || "http://127.0.0.1:5020";
const CFG_PATH   = path.join(os.homedir(), ".crewswarm", "config.json");
const SWARM_PATH = path.join(os.homedir(), ".crewswarm", "crewswarm.json");

// ── Output helpers ─────────────────────────────────────────────────────────────
const R="\x1b[0m", B="\x1b[1m", G="\x1b[32m", RE="\x1b[31m", Y="\x1b[33m", C="\x1b[36m", D="\x1b[2m";
const results = [];
let pass=0, fail=0, warn=0;

function check(name, status, detail="") {
  results.push({ name, status, detail });
  if (status === "pass") { pass++; if (!QUIET_MODE) console.log(`  ${G}✓${R} ${name}${detail ? D+"  "+detail+R : ""}`); }
  else if (status === "warn") { warn++; console.log(`  ${Y}⚠${R} ${name}${detail ? "  "+detail : ""}`); }
  else { fail++; console.log(`  ${RE}✗${R} ${name}${detail ? "  "+detail : ""}`); }
}

function section(title) {
  if (!QUIET_MODE) console.log(`\n${B}${C}── ${title} ──${R}`);
}

function getToken() {
  try { return JSON.parse(fs.readFileSync(CFG_PATH, "utf8"))?.rt?.authToken || ""; } catch { return ""; }
}

function authHeaders() {
  const t = getToken();
  return { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) };
}

async function ping(url, label, opts = {}) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeout || 4000), headers: authHeaders() });
    return { ok: res.ok || res.status < 500, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function cliCheck(cmd, label) {
  try {
    const out = execSync(cmd, { encoding: "utf8", timeout: 4000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    return { ok: true, version: out.split("\n")[0].trim().slice(0, 60) };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 80) };
  }
}

// ── Run all checks in parallel ────────────────────────────────────────────────
async function run() {
  if (!QUIET_MODE) {
    console.log(`\n${B}${C}━━━ CrewSwarm Health Check ━━━${R}`);
    console.log(`${D}  ${new Date().toLocaleString()}${R}`);
  }

  // ── 1. Config files ──────────────────────────────────────────────────────────
  section("Config");
  const hasConfig = fs.existsSync(CFG_PATH);
  const hasSwarm  = fs.existsSync(SWARM_PATH);
  check("~/.crewswarm/config.json", hasConfig ? "pass" : "fail", hasConfig ? "" : "run: bash install.sh");
  check("~/.crewswarm/crewswarm.json", hasSwarm ? "pass" : "fail", hasSwarm ? "" : "run: bash install.sh");

  const token = getToken();
  check("Auth token", token ? "pass" : "fail", token ? `${token.slice(0,8)}…` : "missing rt.authToken");

  // ── 2. API keys ──────────────────────────────────────────────────────────────
  section("API Keys");
  let providers = {};
  try { providers = JSON.parse(fs.readFileSync(SWARM_PATH, "utf8"))?.providers || {}; } catch {}
  const KEY_PROVIDERS = ["groq","anthropic","openai","mistral","cerebras","deepseek","xai","google","perplexity","nvidia","groq"];
  const configuredKeys = Object.entries(providers).filter(([,v]) => v?.apiKey?.length > 8);
  if (configuredKeys.length === 0) {
    check("API keys", "fail", "no provider keys found — open dashboard → Providers");
  } else {
    for (const [name, v] of configuredKeys) {
      check(`${name} key`, "pass", `${v.apiKey.slice(0,8)}…`);
    }
  }

  // ── 3. Services (parallel) ───────────────────────────────────────────────────
  section("Services");
  const [crewLead, dashboard, mcpServer] = await Promise.all([
    ping(`${CREW_LEAD}/health`, "crew-lead"),
    ping(`${DASHBOARD}/`, "dashboard"),           // dashboard serves HTML on /
    ping(`${MCP_URL}/health`, "mcp-server"),
  ]);

  check("crew-lead :5010", crewLead.ok ? "pass" : "fail",
    crewLead.ok ? `HTTP ${crewLead.status}` : crewLead.error || `HTTP ${crewLead.status}`);
  check("dashboard :4319", dashboard.ok ? "pass" : "fail",
    dashboard.ok ? `HTTP ${dashboard.status}` : (dashboard.error || `HTTP ${dashboard.status}`) + " — run: node scripts/dashboard.mjs");
  check("mcp-server :5020", mcpServer.ok ? "pass" : "warn",
    mcpServer.ok ? `HTTP ${mcpServer.status}` : "not running — start: npm run mcp");

  // ── 4. Agents online ─────────────────────────────────────────────────────────
  section("Agents");
  try {
    const res = await fetch(`${CREW_LEAD}/api/agents`, { headers: authHeaders(), signal: AbortSignal.timeout(5000) });
    const d = await res.json();
    const agents = d.agents || [];
    // crew-lead /api/agents uses liveness field; dashboard /api/agents uses online/alive/liveness
    const online = agents.filter(a => a.online || a.alive || a.liveness === "alive");
    const coreAgents = ["crew-coder","crew-qa","crew-pm","crew-main","crew-fixer"];
    check(`Agents online (${online.length}/${agents.length})`,
      online.length > 0 ? "pass" : "warn",
      online.length === 0 ? "bridges not started — run: npm run start-crew" : online.map(a => a.id?.replace("crew-","")).join(", ").slice(0,80));
    for (const core of coreAgents) {
      const a = agents.find(x => x.id === core);
      const isOnline = a?.online || a?.alive || a?.liveness === "alive";
      check(`  ${core}`, isOnline ? "pass" : "warn", isOnline ? "" : "bridge not running");
    }
  } catch (e) {
    check("Agents", "fail", `could not reach crew-lead: ${e.message}`);
  }

  // ── 5. CLI tools ─────────────────────────────────────────────────────────────
  section("CLI Tools");
  const [cursorCli, claudeCli, opencodeCli, nodeCli] = await Promise.all([
    Promise.resolve(cliCheck("cursor --version 2>/dev/null || cursor-cli --version 2>/dev/null", "cursor")),
    Promise.resolve(cliCheck("echo '' | timeout 3 claude --version 2>/dev/null || echo 'not found'", "claude")),
    Promise.resolve(cliCheck("opencode --version 2>/dev/null || echo 'not found'", "opencode")),
    Promise.resolve(cliCheck("node --version", "node")),
  ]);

  check("node", nodeCli.ok ? "pass" : "fail", nodeCli.version || nodeCli.error);
  check("cursor cli", cursorCli.ok && !cursorCli.version?.includes("not found") ? "pass" : "warn",
    cursorCli.version?.includes("not found") ? "install cursor CLI — Cursor → Settings → Install command" : (cursorCli.version || cursorCli.error));
  check("claude code cli", claudeCli.ok && !claudeCli.version?.includes("not found") ? "pass" : "warn",
    claudeCli.version?.includes("not found") ? "npm install -g @anthropic-ai/claude-code" : (claudeCli.version || claudeCli.error));
  check("opencode cli", opencodeCli.ok && !opencodeCli.version?.includes("not found") ? "pass" : "warn",
    opencodeCli.version?.includes("not found") ? "npm install -g opencode-ai" : (opencodeCli.version || opencodeCli.error));

  // ── 6. MCP protocol (if server is up) ────────────────────────────────────────
  if (mcpServer.ok) {
    section("MCP Protocol");
    try {
      const initRes = await fetch(`${MCP_URL}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", clientInfo: { name: "health-check", version: "1.0" } } }),
        signal: AbortSignal.timeout(4000),
      });
      const initData = await initRes.json();
      check("MCP initialize", initData?.result?.serverInfo ? "pass" : "fail",
        initData?.result?.serverInfo?.name || JSON.stringify(initData).slice(0,60));

      const toolsRes = await fetch(`${MCP_URL}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
        signal: AbortSignal.timeout(4000),
      });
      const toolsData = await toolsRes.json();
      const toolCount = toolsData?.result?.tools?.length || 0;
      check(`MCP tools/list (${toolCount} tools)`, toolCount >= 5 ? "pass" : "warn",
        toolsData?.result?.tools?.map(t => t.name).join(", ").slice(0, 80));
    } catch (e) {
      check("MCP protocol", "fail", e.message);
    }
  }

  // ── 7. Quick crew-lead chat ───────────────────────────────────────────────────
  section("crew-lead Chat");
  try {
    const start = Date.now();
    const res = await fetch(`${CREW_LEAD}/chat`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ message: "say: HEALTH_OK", sessionId: "health-check" }),
      signal: AbortSignal.timeout(15000),
    });
    const d = await res.json();
    const elapsed = Date.now() - start;
    const reply = d.reply || d.message || "";
    check("crew-lead responds", reply.length > 0 ? "pass" : "fail",
      `${Math.round(elapsed/100)/10}s — "${reply.slice(0,60)}"`);
  } catch (e) {
    check("crew-lead chat", "fail", e.message);
  }

  // ── Summary ───────────────────────────────────────────────────────────────────
  console.log(`\n${B}${pass + fail + warn} checks${R}  ${G}${pass} pass${R}  ${warn > 0 ? Y : ""}${warn} warn${R}  ${fail > 0 ? RE : ""}${fail} fail${R}\n`);

  if (JSON_MODE) {
    console.log(JSON.stringify({ pass, fail, warn, results }, null, 2));
  }

  if (fail > 0) process.exit(1);
}

run().catch(e => { console.error(`[health-check] fatal: ${e.message}`); process.exit(1); });
