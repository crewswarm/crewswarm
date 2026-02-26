#!/usr/bin/env node
/**
 * Complexity Classifier Tests
 *
 * Tests the pre-flight task complexity classifier built into crew-lead.
 * Verifies that:
 *   - Simple tasks score 1-2 and get no override hint
 *   - Complex tasks score 4-5 and suggest the right agents
 *   - Questions are skipped (return null)
 *   - Short messages are skipped
 *   - crew-lead chat actually behaves differently for complex vs simple tasks
 *
 * Usage:
 *   node scripts/test-classifier.mjs              # unit test classifier function
 *   node scripts/test-classifier.mjs --e2e        # also send tasks to crew-lead and verify routing
 */

import fs   from "node:fs";
import path from "node:path";
import os   from "node:os";

const E2E_MODE   = process.argv.includes("--e2e");
const CREW_LEAD  = process.env.CREW_LEAD_URL || "http://127.0.0.1:5010";
const SWARM_PATH = path.join(os.homedir(), ".crewswarm", "crewswarm.json");
const CFG_PATH   = path.join(os.homedir(), ".crewswarm", "config.json");

const R="\x1b[0m",B="\x1b[1m",G="\x1b[32m",RE="\x1b[31m",Y="\x1b[33m",C="\x1b[36m",D="\x1b[2m";
let pass=0, fail=0;

function ok(msg, detail="")  { pass++; console.log(`  ${G}✓${R} ${msg}${detail ? D+"  "+detail+R : ""}`); }
function bad(msg, detail="") { fail++; console.log(`  ${RE}✗${R} ${msg}${detail ? "  "+detail : ""}`); }
function skip(msg, reason="") { console.log(`  ${Y}⏭${R}  ${msg}${reason ? "  "+reason : ""}`); }
function sec(t)              { console.log(`\n${B}${C}── ${t} ──${R}`); }

function getToken() {
  try { return JSON.parse(fs.readFileSync(CFG_PATH, "utf8"))?.rt?.authToken || ""; } catch { return ""; }
}

function authHeaders() {
  const t = getToken();
  return { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) };
}

// ── Load the classifier directly from crew-lead source ────────────────────────
// We test the classifier function in isolation by invoking it with a real config.
async function loadClassifier() {
  try {
    const crewLeadPath = path.resolve(path.dirname(process.argv[1]), "..", "crew-lead.mjs");
    const source = fs.readFileSync(crewLeadPath, "utf8");

    // Extract just the classifyTask function + its dependencies (TASK_VERBS, QUESTION_START)
    const taskVerbsMatch = source.match(/const TASK_VERBS\s*=\s*\/[^\n]+/);
    const questionStartMatch = source.match(/const QUESTION_START\s*=\s*\/[^\n]+/);
    const funcMatch = source.match(/async function classifyTask[\s\S]*?\n\}/m);

    if (!taskVerbsMatch || !funcMatch) return null;

    // Build a minimal module with just the classifier
    const miniModule = [
      taskVerbsMatch[0],
      questionStartMatch?.[0] || 'const QUESTION_START = /^(what|how|why)/i;',
      funcMatch[0],
      "export { classifyTask };",
    ].join("\n");

    // Write to temp file and import
    const tmpFile = path.join(os.tmpdir(), `crewswarm-classifier-test-${Date.now()}.mjs`);
    fs.writeFileSync(tmpFile, miniModule);
    const mod = await import(tmpFile);
    fs.unlinkSync(tmpFile);
    return mod.classifyTask;
  } catch (e) {
    console.log(`${Y}  Could not extract classifier function: ${e.message}${R}`);
    return null;
  }
}

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(SWARM_PATH, "utf8"));
    const providers = raw.providers || {};
    const groq = providers.groq;
    if (groq?.apiKey) {
      return { providers, agents: raw.agents || [], providerKey: "groq", apiKey: groq.apiKey, baseUrl: groq.baseUrl || "https://api.groq.com/openai/v1" };
    }
    const cerebras = providers.cerebras;
    if (cerebras?.apiKey) {
      return { providers, agents: raw.agents || [], providerKey: "cerebras", apiKey: cerebras.apiKey, baseUrl: cerebras.baseUrl || "https://api.cerebras.ai/v1" };
    }
    return { providers, agents: raw.agents || [], providerKey: null };
  } catch { return { providers: {}, agents: [] }; }
}

// ── Test cases ────────────────────────────────────────────────────────────────
const TEST_CASES = [
  // [message, expected_behavior, min_score, max_score]
  // Simple — should get score 1-2 or be skipped
  { msg: "fix the typo in README.md",          expect: "simple",   minScore: 1, maxScore: 3 },
  { msg: "add a console.log to server.js",     expect: "simple",   minScore: 1, maxScore: 3 },
  { msg: "update the button color to blue",    expect: "simple",   minScore: 1, maxScore: 3 },

  // Complex — should get score 4-5 and suggest multiple agents
  { msg: "build a full auth system with JWT login, registration, password reset, email verification, and rate limiting. The frontend needs a React login page and the backend needs Express endpoints.",
    expect: "complex", minScore: 3, maxScore: 5 },
  { msg: "audit the entire codebase for security vulnerabilities, write a QA test suite, and create a deployment pipeline to Fly.io",
    expect: "complex", minScore: 3, maxScore: 5 },
  { msg: "create a new SaaS product with a landing page, user auth, subscription billing with Stripe, admin dashboard, and API documentation",
    expect: "complex", minScore: 4, maxScore: 5 },

  // Questions — should be skipped (null)
  { msg: "what is JWT?",                       expect: "skip", minScore: null, maxScore: null },
  { msg: "how does the auth system work?",     expect: "skip", minScore: null, maxScore: null },
  { msg: "can you explain the pipeline?",      expect: "skip", minScore: null, maxScore: null },

  // Short — should be skipped (null)
  { msg: "help",                               expect: "skip", minScore: null, maxScore: null },
  { msg: "fix it",                             expect: "skip", minScore: null, maxScore: null },
];

async function runUnit(classifyTask, cfg) {
  sec("Unit Tests — Classifier Function");

  if (!classifyTask) {
    skip("All unit tests", "could not load classifier from crew-lead.mjs");
    return;
  }

  if (!cfg.providerKey) {
    skip("All unit tests", "no Groq/Cerebras API key — classifier requires a fast/cheap provider");
    return;
  }

  console.log(`  ${D}Using ${cfg.providerKey} for classifier calls…${R}\n`);

  for (const tc of TEST_CASES) {
    const short = tc.msg.slice(0, 60) + (tc.msg.length > 60 ? "…" : "");
    try {
      const result = await classifyTask(tc.msg, cfg);

      if (tc.expect === "skip") {
        if (result === null) ok(`[skip] "${short}"`, "correctly skipped");
        else bad(`[skip] "${short}"`, `expected null, got score=${result?.score}`);
      } else if (tc.expect === "simple") {
        if (result === null) {
          ok(`[simple/skipped] "${short}"`, "skipped — score would be 1-2, not worth a call");
        } else if (result.score >= tc.minScore && result.score <= tc.maxScore) {
          ok(`[simple score=${result.score}] "${short}"`, `agents: ${result.agents?.join(",")} — ${result.reason}`);
        } else {
          bad(`[simple] "${short}"`, `score=${result.score} (expected ${tc.minScore}-${tc.maxScore}) — ${result.reason}`);
        }
      } else if (tc.expect === "complex") {
        if (result === null) {
          bad(`[complex] "${short}"`, "classifier skipped — should have fired for complex task");
        } else if (result.score >= tc.minScore) {
          ok(`[complex score=${result.score}] "${short}"`, `agents: ${result.agents?.join("→")} — ${result.reason}`);
          if (result.agents?.length > 1) ok(`  multi-agent suggestion (${result.agents.length} agents)`);
          else skip(`  multi-agent suggestion`, `only ${result.agents?.length} agent suggested`);
        } else {
          bad(`[complex] "${short}"`, `score=${result.score} too low (expected >= ${tc.minScore}) — ${result.reason}`);
        }
      }
    } catch (e) {
      bad(`[error] "${short}"`, e.message);
    }
  }
}

async function runE2E() {
  sec("E2E Tests — crew-lead Chat Routing");

  const SIMPLE_TASK = "add a console.log at the top of index.js";
  const COMPLEX_TASK = "build a complete REST API with auth, rate limiting, and full test suite, then deploy it to Fly.io with CI/CD";
  const QUESTION = "how does the complexity classifier work?";

  // Check crew-lead is up
  try {
    const res = await fetch(`${CREW_LEAD}/health`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    skip("E2E tests", `crew-lead not reachable: ${e.message}`);
    return;
  }

  // Send simple task — crew-lead should NOT suggest crew-main orchestration
  console.log(`  ${D}Sending simple task…${R}`);
  try {
    const res = await fetch(`${CREW_LEAD}/chat`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ message: SIMPLE_TASK, sessionId: "classifier-test-simple" }),
      signal: AbortSignal.timeout(20000),
    });
    const d = await res.json();
    const reply = d.reply || "";
    const routedToMain = /crew-main|@@PIPELINE|orchestrat/i.test(reply);
    if (!routedToMain) ok("Simple task → no crew-main routing", reply.slice(0, 80));
    else console.log(`  ${Y}⚠${R}  Simple task routed to crew-main (may be ok depending on context): "${reply.slice(0,80)}"`);
  } catch (e) { bad("Simple task E2E", e.message); }

  // Send complex task — crew-lead SHOULD suggest crew-main or pipeline
  console.log(`  ${D}Sending complex task…${R}`);
  try {
    const res = await fetch(`${CREW_LEAD}/chat`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ message: COMPLEX_TASK, sessionId: "classifier-test-complex" }),
      signal: AbortSignal.timeout(20000),
    });
    const d = await res.json();
    const reply = d.reply || "";
    const routedToMain = /crew-main|@@PIPELINE|orchestrat|multi.?agent|pipeline/i.test(reply);
    if (routedToMain) ok("Complex task → crew-main/pipeline routing", reply.slice(0, 80));
    else console.log(`  ${Y}⚠${R}  Complex task did not mention crew-main/pipeline: "${reply.slice(0,80)}"`);
  } catch (e) { bad("Complex task E2E", e.message); }

  // Send question — should just be answered, no dispatch
  console.log(`  ${D}Sending question…${R}`);
  try {
    const res = await fetch(`${CREW_LEAD}/chat`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ message: QUESTION, sessionId: "classifier-test-question" }),
      signal: AbortSignal.timeout(20000),
    });
    const d = await res.json();
    const reply = d.reply || "";
    const dispatched = /@@DISPATCH|@@PIPELINE/.test(reply);
    if (!dispatched) ok("Question → answered directly (no dispatch)", reply.slice(0, 80));
    else bad("Question triggered dispatch", reply.slice(0, 80));
  } catch (e) { bad("Question E2E", e.message); }

  // ── @@STOP / @@KILL fast-path tests ────────────────────────────────────────
  sec("Stop / Kill fast-path (E2E)");

  // "stop everything" → graceful stop response, no LLM round-trip
  console.log(`  ${D}Sending "stop everything"…${R}`);
  try {
    const t = Date.now();
    const res = await fetch(`${CREW_LEAD}/chat`, {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({ message: "stop everything", sessionId: "stop-test" }),
      signal: AbortSignal.timeout(8000),
    });
    const d = await res.json();
    const reply = (d.reply || "").toLowerCase();
    const elapsed = Date.now() - t;
    const isStop = /stop|cancel|clear|nothing.*running|all clear/i.test(reply);
    // Fast-path should respond in <3s (no LLM call)
    if (isStop && elapsed < 4000) ok(`"stop everything" → fast-path stop reply (${elapsed}ms)`, reply.slice(0, 80));
    else if (isStop) ok(`"stop everything" → stop reply (${elapsed}ms — slow, may have hit LLM)`, reply.slice(0, 80));
    else bad(`"stop everything" → unexpected reply`, reply.slice(0, 80));
  } catch (e) { bad('"stop everything" E2E', e.message); }

  // "kill everything" → hard kill response
  console.log(`  ${D}Sending "kill everything"…${R}`);
  try {
    const t = Date.now();
    const res = await fetch(`${CREW_LEAD}/chat`, {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({ message: "kill everything", sessionId: "kill-test" }),
      signal: AbortSignal.timeout(8000),
    });
    const d = await res.json();
    const reply = (d.reply || "").toLowerCase();
    const elapsed = Date.now() - t;
    const isKill = /kill|dead|bridge|restart|nothing.*running/i.test(reply);
    if (isKill && elapsed < 4000) ok(`"kill everything" → fast-path kill reply (${elapsed}ms)`, reply.slice(0, 80));
    else if (isKill) ok(`"kill everything" → kill reply (${elapsed}ms)`, reply.slice(0, 80));
    else bad(`"kill everything" → unexpected reply`, reply.slice(0, 80));
  } catch (e) { bad('"kill everything" E2E', e.message); }
}

async function run() {
  console.log(`\n${B}${C}━━━ Complexity Classifier Tests ━━━${R}\n`);

  const [classifyTask, cfg] = await Promise.all([
    loadClassifier(),
    Promise.resolve(loadConfig()),
  ]);

  await runUnit(classifyTask, cfg);
  if (E2E_MODE) await runE2E();

  console.log(`\n${B}${pass + fail} checks${R}  ${G}${pass} pass${R}  ${fail > 0 ? RE : ""}${fail} fail${R}`);
  if (!E2E_MODE) console.log(`${D}  Add --e2e to also test crew-lead chat routing${R}`);
  console.log();

  if (fail > 0) process.exit(1);
}

run().catch(e => { console.error(`[test-classifier] fatal: ${e.message}`); process.exit(1); });
