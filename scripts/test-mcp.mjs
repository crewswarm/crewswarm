#!/usr/bin/env node
/**
 * MCP Server Tests
 *
 * Tests the CrewSwarm MCP server end-to-end:
 *   1. Health endpoint
 *   2. MCP initialize handshake
 *   3. tools/list — correct structure and count
 *   4. list_agents tool call — returns agent roster
 *   5. crewswarm_status tool call — system health
 *   6. dispatch_agent with a trivial echo task
 *   7. stdio transport (spawns subprocess, sends JSON-RPC over stdin)
 *
 * Usage:
 *   node scripts/test-mcp.mjs              # HTTP tests (server must be running on :5020)
 *   node scripts/test-mcp.mjs --with-stdio # also test stdio transport
 *   node scripts/test-mcp.mjs --start      # auto-start MCP server if not running
 */

import fs        from "node:fs";
import path      from "node:path";
import os        from "node:os";
import { spawn } from "node:child_process";

const MCP_URL   = process.env.MCP_URL || "http://127.0.0.1:5020";
const WITH_STDIO = process.argv.includes("--with-stdio");
const AUTO_START = process.argv.includes("--start");
const REPO_ROOT  = path.resolve(path.dirname(process.argv[1]), "..");

const R="\x1b[0m",B="\x1b[1m",G="\x1b[32m",RE="\x1b[31m",Y="\x1b[33m",C="\x1b[36m",D="\x1b[2m";
let pass=0, fail=0;

function ok(msg, detail="")  { pass++; console.log(`  ${G}✓${R} ${msg}${detail ? D+"  "+detail+R : ""}`); }
function bad(msg, detail="") { fail++; console.log(`  ${RE}✗${R} ${msg}${detail ? "  "+detail : ""}`); }
function sec(t)              { console.log(`\n${B}${C}── ${t} ──${R}`); }

async function mcpPost(method, params={}) {
  const res = await fetch(`${MCP_URL}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    signal: AbortSignal.timeout(8000),
  });
  return res.json();
}

async function toolCall(name, args={}) {
  return mcpPost("tools/call", { name, arguments: args });
}

// ── Wait for server (if --start) ───────────────────────────────────────────────
async function waitForServer(maxMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${MCP_URL}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function run() {
  console.log(`\n${B}${C}━━━ MCP Server Tests ━━━${R}`);
  console.log(`${D}  endpoint: ${MCP_URL}${R}\n`);

  // ── Auto-start if requested ──────────────────────────────────────────────────
  let serverProc = null;
  if (AUTO_START) {
    try {
      const res = await fetch(`${MCP_URL}/health`, { signal: AbortSignal.timeout(1000) });
      if (!res.ok) throw new Error("not ok");
      console.log(`${D}  MCP server already running${R}`);
    } catch {
      console.log(`${D}  Starting MCP server…${R}`);
      serverProc = spawn("node", [path.join(REPO_ROOT, "scripts", "mcp-server.mjs")], {
        cwd: REPO_ROOT, stdio: "ignore", detached: false,
      });
      const ready = await waitForServer(8000);
      if (!ready) { console.error(`${RE}Could not start MCP server${R}`); process.exit(1); }
      console.log(`${D}  MCP server started (pid ${serverProc.pid})${R}`);
    }
  }

  // ── 1. Health ────────────────────────────────────────────────────────────────
  sec("1 · Health Endpoint");
  try {
    const res = await fetch(`${MCP_URL}/health`, { signal: AbortSignal.timeout(4000) });
    const d = await res.json();
    ok("GET /health returns 200", `agents=${d.agents} skills=${d.skills}`);
    if (d.agents >= 1) ok("Agent count > 0", `${d.agents} agents`);
    else bad("Agent count", "0 agents — crewswarm.json may be missing");
  } catch (e) {
    bad("GET /health", e.message + " — is MCP server running? npm run mcp");
    console.log(`\n${RE}Cannot reach MCP server. Run: npm run mcp${R}\n`);
    process.exit(1);
  }

  // ── 2. Initialize ────────────────────────────────────────────────────────────
  sec("2 · MCP Initialize Handshake");
  try {
    const d = await mcpPost("initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "test", version: "1.0" } });
    ok("initialize response", `version=${d?.result?.protocolVersion}`);
    const info = d?.result?.serverInfo;
    if (info?.name === "crewswarm") ok("serverInfo.name = crewswarm");
    else bad("serverInfo.name", JSON.stringify(info));
    if (d?.result?.capabilities?.tools) ok("capabilities.tools present");
    else bad("capabilities.tools missing");
  } catch (e) { bad("initialize", e.message); }

  // ── 3. tools/list ────────────────────────────────────────────────────────────
  sec("3 · tools/list");
  let tools = [];
  try {
    const d = await mcpPost("tools/list");
    tools = d?.result?.tools || [];
    ok(`${tools.length} tools returned`, tools.map(t => t.name).join(", ").slice(0, 100));

    const requiredTools = ["dispatch_agent", "list_agents", "run_pipeline", "chat_stinki", "crewswarm_status"];
    for (const name of requiredTools) {
      const t = tools.find(x => x.name === name);
      if (t) ok(`  ${name} present`, t.description?.slice(0, 50));
      else bad(`  ${name} missing`);
    }

    const skillTools = tools.filter(t => t.name.startsWith("skill_"));
    if (skillTools.length > 0) ok(`  ${skillTools.length} skill tools`, skillTools.map(t => t.name).join(", "));
    else console.log(`  ${Y}⚠${R}  No skill_ tools (no skills installed in ~/.crewswarm/skills/)`);

    // Check dispatch_agent has enum of agents
    const da = tools.find(t => t.name === "dispatch_agent");
    const enumAgents = da?.inputSchema?.properties?.agent?.enum || [];
    if (enumAgents.length > 0) ok(`  dispatch_agent.agent enum (${enumAgents.length} agents)`, enumAgents.slice(0,5).join(", ")+"…");
    else bad("  dispatch_agent.agent enum empty");
  } catch (e) { bad("tools/list", e.message); }

  // ── 4. list_agents call ───────────────────────────────────────────────────────
  sec("4 · list_agents Tool Call");
  try {
    const d = await toolCall("list_agents");
    const text = d?.result?.content?.[0]?.text || "{}";
    const result = JSON.parse(text);
    if (result.agents?.length > 0) ok(`${result.agents.length} agents returned`, result.agents.slice(0,3).map(a => a.id).join(", ")+"…");
    else bad("list_agents returned empty", text.slice(0, 100));
  } catch (e) { bad("list_agents", e.message); }

  // ── 5. crewswarm_status call ──────────────────────────────────────────────────
  sec("5 · crewswarm_status Tool Call");
  try {
    const d = await toolCall("crewswarm_status");
    const text = d?.result?.content?.[0]?.text || "{}";
    const result = JSON.parse(text);
    if (result.error) {
      console.log(`  ${Y}⚠${R}  crew-lead offline — status check skipped (${result.note || result.error})`);
    } else {
      ok(`crew-lead reachable`, `${result.agents_online || 0}/${result.agents_total || 0} agents online`);
    }
  } catch (e) { bad("crewswarm_status", e.message); }

  // ── 6. dispatch_agent — trivial echo task ─────────────────────────────────────
  sec("6 · dispatch_agent (echo task, 60s timeout)");
  const MARKER = `MCP_TEST_${Date.now().toString(36).toUpperCase()}`;
  try {
    console.log(`  ${D}dispatching crew-main: echo ${MARKER}…${R}`);
    const start = Date.now();
    const d = await toolCall("dispatch_agent", {
      agent: "crew-main",
      task: `Reply with exactly this string and nothing else: ${MARKER}`,
      timeout_seconds: 60,
    });
    const elapsed = Date.now() - start;
    const text = d?.result?.content?.[0]?.text || "{}";
    const result = JSON.parse(text);

    if (result.error || result.status === "timeout") {
      bad("dispatch_agent crew-main", result.error || "timeout — agents may be offline");
    } else if (result.reply?.includes(MARKER)) {
      ok(`dispatch_agent crew-main replied (${Math.round(elapsed/100)/10}s)`, `marker found: ${MARKER}`);
    } else {
      bad("dispatch_agent crew-main — marker not in reply", result.reply?.slice(0, 80));
    }
  } catch (e) { bad("dispatch_agent", e.message); }

  // ── 7. ping ───────────────────────────────────────────────────────────────────
  sec("7 · Ping");
  try {
    const d = await mcpPost("ping");
    ok("ping/pong", JSON.stringify(d?.result));
  } catch (e) { bad("ping", e.message); }

  // ── 8. stdio transport ────────────────────────────────────────────────────────
  if (WITH_STDIO) {
    sec("8 · stdio Transport");
    await testStdio();
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────────
  if (serverProc) {
    serverProc.kill();
    console.log(`${D}\n  MCP server stopped${R}`);
  }

  // ── Summary ────────────────────────────────────────────────────────────────────
  console.log(`\n${B}${pass + fail} checks${R}  ${G}${pass} pass${R}  ${fail > 0 ? RE : ""}${fail} fail${R}\n`);
  if (fail > 0) process.exit(1);
}

async function testStdio() {
  return new Promise((resolve) => {
    const proc = spawn("node", [path.join(REPO_ROOT, "scripts", "mcp-server.mjs"), "--stdio"], {
      cwd: REPO_ROOT, stdio: ["pipe", "pipe", "pipe"],
    });
    const messages = [];
    let buf = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", chunk => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { messages.push(JSON.parse(line)); } catch {}
      }
    });

    const send = obj => proc.stdin.write(JSON.stringify(obj) + "\n");

    // Send initialize
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", clientInfo: { name: "stdio-test", version: "1.0" } } });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

    setTimeout(() => {
      proc.kill();
      const init = messages.find(m => m.id === 1);
      const list = messages.find(m => m.id === 2);
      if (init?.result?.serverInfo?.name === "crewswarm") ok("stdio initialize");
      else bad("stdio initialize", JSON.stringify(init).slice(0,80));
      if (list?.result?.tools?.length > 0) ok(`stdio tools/list (${list.result.tools.length} tools)`);
      else bad("stdio tools/list", JSON.stringify(list).slice(0,80));
      resolve();
    }, 2500);
  });
}

run().catch(e => { console.error(`[test-mcp] fatal: ${e.message}`); process.exit(1); });
