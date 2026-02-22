#!/usr/bin/env node
/**
 * PM LOOP — Autonomous "Product Manager" that owns the roadmap and keeps building forever.
 *
 * How it works:
 *   1. Reads website/ROADMAP.md — finds the next unchecked `- [ ]` item
 *   2. Calls Groq PM to expand that item into a precise, scoped coding task
 *   3. Dispatches to crew-coder via gateway-bridge
 *   4. Marks the item `- [x]` in ROADMAP.md when done (or `- [!]` on failure)
 *   5. Every EXTEND_EVERY_N completed items (or when roadmap empties), Groq acts as
 *      "product strategist" — inspects the live website and appends 3–5 new
 *      `- [ ]` items under a "## PM-Generated (Round N)" section.
 *   6. Loops indefinitely — until Stop is pressed, max-items hit, or Groq says "done".
 *
 * To add new work manually: append `- [ ] description` to ROADMAP.md at any time.
 *
 * Usage:
 *   node pm-loop.mjs
 *   node pm-loop.mjs --max-items 50
 *   node pm-loop.mjs --no-extend              (disable self-extending; stop when roadmap empties)
 *   node pm-loop.mjs --dry-run                (show what PM would do, no actual dispatches)
 *   GROQ_API_KEY=xxx node pm-loop.mjs
 *   PM_USE_SPECIALISTS=1 node pm-loop.mjs     (route HTML/CSS → crew-coder-front, JS → crew-coder-back, git → crew-github)
 *   PM_CODER_AGENT=crew-coder-front node pm-loop.mjs  (force all tasks to one specific agent)
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

// ── Args (parsed early so config can reference them) ──────────────────────
const args           = process.argv.slice(2);
const DRY_RUN        = args.includes("--dry-run");
const SELF_EXTEND    = !args.includes("--no-extend");
const EXTEND_EVERY_N = Number(process.env.PM_EXTEND_EVERY || "5");
const maxIdx         = args.indexOf("--max-items");
const MAX_ITEMS      = maxIdx >= 0 ? Number(args[maxIdx + 1]) : 200;
const projDirIdx     = args.indexOf("--project-dir");

// ── Config ────────────────────────────────────────────────────────────────
const OPENCLAW_DIR   = process.env.OPENCLAW_DIR || "/Users/jeffhobbs/Desktop/OpenClaw";
const OUTPUT_DIR     = projDirIdx >= 0 ? args[projDirIdx + 1]
                     : (process.env.OPENCREW_OUTPUT_DIR || join(OPENCLAW_DIR, "website"));
const ROADMAP_FILE   = process.env.PM_ROADMAP_FILE || join(OUTPUT_DIR, "ROADMAP.md");
const BRIDGE_PATH    = join(OPENCLAW_DIR, "gateway-bridge.mjs");
const FEATURES_DOC   = process.env.PM_FEATURES_DOC || null;
const LOG_DIR        = join(OPENCLAW_DIR, "orchestrator-logs");
const PM_LOG         = join(LOG_DIR, "pm-loop.jsonl");
// Per-project PID and STOP files — allows multiple projects to run simultaneously
const PROJECT_ID     = process.env.PM_PROJECT_ID || null;
const _pidSuffix     = PROJECT_ID ? `-${PROJECT_ID}` : "";
const STOP_FILE      = join(LOG_DIR, `pm-loop${_pidSuffix}.stop`);
const PID_FILE       = join(LOG_DIR, `pm-loop${_pidSuffix}.pid`);
const TASK_TIMEOUT   = Number(process.env.PHASED_TASK_TIMEOUT_MS  || "300000");
const GROQ_API_KEY   = process.env.GROQ_API_KEY || ""; // kept for backwards compat

// Perplexity Sonar Pro — PM orchestrator model with real-time web search
let _ocCfg = null;
function getOCConfig() {
  if (_ocCfg) return _ocCfg;
  try { _ocCfg = JSON.parse(readFileSync(homedir() + "/.openclaw/openclaw.json", "utf8")); } catch {}
  return _ocCfg || {};
}
function getPMProviderConfig() {
  const cfg = getOCConfig();
  // Primary: Perplexity Sonar Pro (web search)
  const pplx = cfg.models?.providers?.perplexity;
  if (pplx?.apiKey) return { baseUrl: pplx.baseUrl || "https://api.perplexity.ai", apiKey: pplx.apiKey, model: "sonar-pro" };
  // Fallback 1: Cerebras llama-3.3-70b (fast, no search)
  const cerebras = cfg.models?.providers?.cerebras;
  if (cerebras?.apiKey) return { baseUrl: cerebras.baseUrl || "https://api.cerebras.ai/v1", apiKey: cerebras.apiKey, model: "llama-3.3-70b" };
  // Fallback 2: Groq env var
  if (GROQ_API_KEY) return { baseUrl: "https://api.groq.com/openai/v1", apiKey: GROQ_API_KEY, model: "llama-3.3-70b-versatile" };
  return null;
}
const CODER_AGENT    = process.env.PM_CODER_AGENT || "crew-coder";
// Specialists enabled by default — set PM_USE_SPECIALISTS=0 to disable
const USE_SPECIALISTS = process.env.PM_USE_SPECIALISTS !== "0";
// QA review after each task — set PM_USE_QA=0 to disable
const USE_QA          = process.env.PM_USE_QA !== "0";
// Security audit on security-related tasks — set PM_USE_SECURITY=0 to disable
const USE_SECURITY    = process.env.PM_USE_SECURITY !== "0";

// Route task to the right specialist agent based on keywords
function routeAgent(itemText) {
  if (!USE_SPECIALISTS) return CODER_AGENT;
  const t = itemText.toLowerCase();
  // GitHub / git ops → crew-github
  if (/\bgit\b|github|commit|push|pull.request|branch|deploy/.test(t)) return "crew-github";
  // Backend / server / API / scripts → crew-coder-back
  if (/\bapi\b|server|node|express|script|endpoint|json|database|backend|mjs|\.js\b/.test(t)) return "crew-coder-back";
  // Frontend / HTML / CSS / visual → crew-coder-front
  if (/html|css|style|section|design|layout|animation|nav|hero|frontend|ui\b|ux\b|responsive/.test(t)) return "crew-coder-front";
  return CODER_AGENT;
}

// Determine if task needs a security review
function needsSecurityReview(itemText) {
  if (!USE_SECURITY) return false;
  const t = itemText.toLowerCase();
  return /auth|login|password|token|secret|key|api.key|env|permission|access|inject|xss|csrf|sanitiz/.test(t);
}

// Determine if task needs a copywriter pass before coding
function needsCopywriter(itemText) {
  const t = itemText.toLowerCase();
  return /headline|hero|copy|cta|tagline|subheading|testimonial|social proof|value prop|description|landing|about|message|tone|voice|wording|slogan|pitch/.test(t);
}

// Call copywriter agent and return enriched task with copy included
async function runCopywriterPass(itemText, task) {
  const cfg = getOCConfig();
  const mistral = cfg.models?.providers?.mistral;
  if (!mistral?.apiKey) return task; // no key — skip

  const agentPrompts = (() => {
    try { return JSON.parse(readFileSync(homedir() + "/.openclaw/agent-prompts.json", "utf8")); } catch { return {}; }
  })();
  const copywriterPrompt = agentPrompts["copywriter"] || "You are a conversion copywriter for developer tools. Write punchy, specific copy.";

  console.log(`  ✍️  Copywriter pass for: ${itemText.slice(0, 60)}...`);
  try {
    const resp = await fetch(`${mistral.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${mistral.apiKey}` },
      body: JSON.stringify({
        model: "mistral-large-latest",
        messages: [
          { role: "system", content: copywriterPrompt },
          { role: "user", content: `Write the copy for this task:\n\n"${itemText}"\n\nThe coder will implement your copy. Output labeled copy only (Headline:, Body:, CTA: etc). Be clear and specific.` }
        ],
        max_tokens: 400,
        temperature: 0.6,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await resp.json();
    const copy = data?.choices?.[0]?.message?.content?.trim();
    if (!copy) return task;
    console.log(`  ✍️  Copy ready:\n    ${copy.slice(0, 120).replace(/\n/g, " ")}...`);
    return `${task}\n\nCOPYWRITER PASS — use this exact copy in the HTML (do not change the wording):\n${copy}`;
  } catch (e) {
    console.warn(`  ⚠️  Copywriter pass failed: ${e.message.slice(0, 60)} — proceeding without`);
    return task;
  }
}
const BETWEEN_TASKS  = Number(process.env.PM_PAUSE_MS || "5000");

if (!existsSync(LOG_DIR)) await mkdir(LOG_DIR, { recursive: true });

// ── PID file — prevents duplicate processes ───────────────────────────────
async function writePid() {
  await writeFile(PID_FILE, String(process.pid), "utf8").catch(() => {});
}
async function clearPid() {
  const { unlink } = await import("node:fs/promises");
  await unlink(PID_FILE).catch(() => {});
}
// Clean up PID on any exit
process.on("exit",    () => { try { require("node:fs").unlinkSync(PID_FILE); } catch {} });
process.on("SIGTERM", async () => { await clearPid(); process.exit(0); });
process.on("SIGINT",  async () => { await clearPid(); process.exit(0); });

// ── Logging ───────────────────────────────────────────────────────────────
async function log(entry) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
  await appendFile(PM_LOG, line + "\n").catch(() => {});
}

function banner(msg) { console.log(`\n${"─".repeat(60)}\n  ${msg}\n${"─".repeat(60)}`); }

// ── Roadmap parsing ───────────────────────────────────────────────────────
function parseRoadmap(content) {
  const lines = content.split("\n");
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(-\s+)\[( |x|!)\]\s+(.+)$/);
    if (m) {
      items.push({
        lineIdx: i,
        raw: lines[i],
        prefix: m[1],
        status: m[2] === " " ? "pending" : m[2] === "x" ? "done" : "failed",
        text: m[3].trim(),
      });
    }
  }
  return { lines, items };
}

// Max times to retry a failed item before giving up permanently
const MAX_RETRIES = Number(process.env.PM_MAX_RETRIES || "2");

function retryCount(rawLine) {
  const m = rawLine.match(/✗\s+\d+:\d+:\d+/g);
  return m ? m.length : 0;
}

function nextPending(items) {
  // First: pick any truly pending item
  const pending = items.find(it => it.status === "pending");
  if (pending) return pending;
  // Second: retry failed items that haven't hit MAX_RETRIES yet
  return items.find(it => it.status === "failed" && retryCount(it.raw) < MAX_RETRIES) || null;
}

async function markItem(lineIdx, status) {
  const content = await readFile(ROADMAP_FILE, "utf8");
  const lines = content.split("\n");
  const ts = new Date().toLocaleTimeString();
  if (status === "done") {
    // Mark done — replace any [ ] or [!] marker
    lines[lineIdx] = lines[lineIdx].replace(/\[[ !]\]/, "[x]");
    lines[lineIdx] += `  ✓ ${ts}`;
  } else {
    // Mark failed — keep [!] marker, append another ✗ timestamp for retry tracking
    lines[lineIdx] = lines[lineIdx].replace(/\[ \]/, "[!]");
    lines[lineIdx] += `  ✗ ${ts}`;
  }
  await writeFile(ROADMAP_FILE, lines.join("\n"), "utf8");
}

// ── PM LLM: shared caller — Perplexity Sonar Pro with web search ─────────
async function callPMLLM(messages, { maxTokens = 400, temperature = 0.3 } = {}) {
  const provider = getPMProviderConfig();
  if (!provider) return null;

  const isPerplexity = provider.baseUrl.includes("perplexity");
  const body = {
    model: provider.model,
    messages,
    max_tokens: maxTokens,
    temperature,
    ...(isPerplexity ? { search_recency_filter: "month" } : {}),
  };

  const resp = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${provider.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

// ── PM: turn a roadmap item into a precise coding task ────────────────────
async function expandWithGroq(item, context) {
  const provider = getPMProviderConfig();
  const isPerplexity = provider?.baseUrl?.includes("perplexity");

  if (!provider) {
    // No PM LLM configured — use raw item with safe wrapper
    return `Task: ${item}

Rules:
- Output directory: ${OUTPUT_DIR}
- Read existing files first before modifying — NEVER overwrite a whole file
- If the task is already complete, skip and report done
- Only create a new file if the task explicitly requires it`;
  }

  const featuresSnippet = FEATURES_DOC ? (() => { try { return readFileSync(FEATURES_DOC, "utf8").slice(0, 800); } catch { return ""; } })() : "";

  const systemPrompt = `You are the PM (Product Manager) for a software project.${isPerplexity ? " You have real-time web search — use it to research best practices and modern approaches relevant to the task." : ""}

Your job: receive a roadmap item and write a precise, scoped coding task for a coder agent.

Project output directory: ${OUTPUT_DIR}

Rules:
- ONE deliverable only — no multi-step tasks
- Specify exact file paths using the output dir above
- CRITICAL: Always tell the coder to READ existing files first, then MODIFY/APPEND — NEVER overwrite a whole file unless it's brand new
- If something already exists and satisfies the item, tell coder to SKIP and report done
- Keep tasks under 200 words
- Do NOT explain what you're doing — output the task text only${featuresSnippet ? `\n\nProject context:\n${featuresSnippet}` : ""}`;

  const userPrompt = `Roadmap item: "${item}"

Current project state:
${context}

${isPerplexity ? `Search for best practices relevant to this task if helpful, then write` : "Write"} the precise coder task (task text only, no preamble):`;

  try {
    const result = await callPMLLM(
      [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      { maxTokens: 300, temperature: 0.3 }
    );
    return result || item;
  } catch (e) {
    console.warn(`  ⚠ PM LLM failed (${e.message}), using raw item`);
    return item;
  }
}

async function getProjectContext() {
  if (!existsSync(OUTPUT_DIR)) return `(output dir ${OUTPUT_DIR} does not exist yet)`;
  const { readdir, stat } = await import("node:fs/promises");
  const TRACKED_EXT = new Set([".html",".css",".js",".mjs",".ts",".json",".md",".py",".sh",".yaml",".yml",".go",".rs"]);
  const files = [];
  async function scan(dir, depth = 0) {
    if (depth > 3) return;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".") || e.name === "node_modules") continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) { await scan(full, depth + 1); }
        else if (TRACKED_EXT.has(e.name.slice(e.name.lastIndexOf(".")))) {
          const st = await stat(full).catch(() => null);
          if (st) files.push({ path: full.replace(OUTPUT_DIR + "/", ""), size: st.size });
        }
      }
    } catch { /* skip unreadable dirs */ }
  }
  await scan(OUTPUT_DIR);
  if (!files.length) return `(output dir exists but contains no tracked files yet)`;
  const summary = files.slice(0, 20).map(f => `${f.path} (${Math.round(f.size/1024)}KB)`).join(", ");
  return `${files.length} file(s) in ${OUTPUT_DIR}: ${summary}${files.length > 20 ? ` ... and ${files.length-20} more` : ""}`;
}

// ── PM: self-extend — generates new roadmap items from live site ─────────
async function generateNewRoadmapItems(context, completedItems, round) {
  const label = `PM-Generated (Round ${round})`;
  const provider = getPMProviderConfig();
  const isPerplexity = provider?.baseUrl?.includes("perplexity");

  if (!provider) {
    console.log("  💡 No PM LLM configured — appending generic improvement items");
    return [
      "Improve typography: add font-weight hierarchy and tighter line-height for all headings",
      "Add aria-label attributes to all interactive elements for accessibility",
      "Add a 'Back to top' floating button that appears after scrolling 300px",
    ];
  }

  const recentDone = completedItems.slice(-10).map(i => `- ${i}`).join("\n");

  const featuresSnippet = FEATURES_DOC ? await readFile(FEATURES_DOC, "utf8").catch(() => "").then(t => t.substring(0, 1500)) : "";

  const systemPrompt = `You are a senior product manager for a software project.${isPerplexity ? " You have real-time web search — use it to research current best practices." : ""}

Your job: decide what to build next to make the project more complete, robust, and high quality.

Project output directory: ${OUTPUT_DIR}

Rules:
- Generate exactly 4 new roadmap items
- Each item is ONE specific, self-contained deliverable for a coder agent
- Items must be meaningfully distinct from what is already done
- Vary between: new features, polish, tests, accessibility, performance, documentation
- Format: plain sentence describing exactly what to add/change (no markdown bullets, no numbering)
- Output ONLY the 4 items, one per line, nothing else${featuresSnippet ? `\n\nProject context:\n${featuresSnippet}` : ""}`;

  const userPrompt = `Current project state:
${context}

Recently completed items:
${recentDone}

${isPerplexity ? "Search for relevant best practices if helpful, then generate" : "Generate"} 4 new roadmap items that would meaningfully improve this project:`;

  try {
    const resp = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userPrompt },
        ],
        max_tokens: 400,
        temperature: 0.7,
        ...(isPerplexity ? { search_recency_filter: "month" } : {}),
      }),
      signal: AbortSignal.timeout(60000),
    });
    const data = await resp.json();
    const raw = data.choices?.[0]?.message?.content?.trim() || "";
    const items = raw.split("\n").map(l => l.trim()).filter(l => l.length > 10 && !l.startsWith("#"));
    return items.slice(0, 5);
  } catch (e) {
    console.warn(`  ⚠ PM LLM self-extend failed (${e.message})`);
    return [];
  }
}

async function appendGeneratedItems(newItems, round) {
  if (!newItems.length) return;
  const content = await readFile(ROADMAP_FILE, "utf8");
  const section = `\n---\n\n## PM-Generated (Round ${round})\n\n` +
    newItems.map(item => `- [ ] ${item}`).join("\n") + "\n";
  await writeFile(ROADMAP_FILE, content + section, "utf8");
  console.log(`  📝 Appended ${newItems.length} new items to roadmap (Round ${round})`);
  for (const item of newItems) console.log(`     • ${item.substring(0, 80)}`);
}

// ── Agent dispatch ────────────────────────────────────────────────────────
function callAgent(agentId, message, { timeout } = {}) {
  // QA and fixer get extra time — they read files and do analysis
  const agentTimeout = timeout || (["crew-qa","crew-fixer","security"].includes(agentId) ? TASK_TIMEOUT * 2 : TASK_TIMEOUT);
  const env = {
    ...process.env,
    OPENCREW_RT_SEND_TIMEOUT_MS: String(agentTimeout),
  };
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [BRIDGE_PATH, "--send", agentId, message], {
      stdio: ["inherit", "pipe", "pipe"],
      env,
    });
    let out = "", err = "";
    proc.stdout?.on("data", d => { out += d; });
    proc.stderr?.on("data", d => { err += d; });
    const timer = setTimeout(() => { proc.kill("SIGTERM"); reject(new Error(`Timeout ${TASK_TIMEOUT}ms`)); }, TASK_TIMEOUT);
    proc.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(err || out || `exit ${code}`));
      else resolve(out.trim() || err.trim());
    });
  });
}

// ── Main loop ─────────────────────────────────────────────────────────────
async function main() {
  const opId = `pm-${randomUUID().slice(0, 8)}`;

  banner(`PM LOOP  op=${opId}  max=${MAX_ITEMS}${DRY_RUN ? "  DRY RUN" : ""}${SELF_EXTEND ? `  self-extend every ${EXTEND_EVERY_N}` : "  no-extend"}`);
  console.log(`Roadmap: ${ROADMAP_FILE}`);
  console.log(`Output:  ${OUTPUT_DIR}`);
  console.log(`Agents:  ${USE_SPECIALISTS ? "crew-coder-front (HTML/CSS) | crew-coder-back (JS/API) | crew-github (git) | crew-coder (default)" : CODER_AGENT}`);
  console.log(`QA:      ${USE_QA ? "crew-qa reviews after each task" : "disabled (PM_USE_QA=0)"}`);
  console.log(`Fixer:   crew-fixer auto-repairs failed tasks`);
  console.log(`Security:${USE_SECURITY ? " security agent reviews auth/key tasks" : " disabled (PM_USE_SECURITY=0)"}`);
  const pmProv = getPMProviderConfig();
  const pmProvLabel = pmProv?.baseUrl?.includes("perplexity") ? `Perplexity ${pmProv.model} (web search ✓)`
                    : pmProv?.baseUrl?.includes("cerebras")   ? `Cerebras ${pmProv.model}`
                    : pmProv ? `Groq ${pmProv.model}` : "none — raw item text";
  console.log(`PM LLM:  ${pmProvLabel}`);
  console.log(`Extend:  ${SELF_EXTEND ? `every ${EXTEND_EVERY_N} completions OR when roadmap empties` : "disabled (--no-extend)"}`);
  console.log(`\nTip: touch ${STOP_FILE} to stop gracefully between tasks\n`);

  if (!existsSync(ROADMAP_FILE)) {
    console.error(`❌ ROADMAP.md not found at ${ROADMAP_FILE}`);
    process.exit(1);
  }

  await writePid();
  await log({ op_id: opId, event: "start", dry_run: DRY_RUN, self_extend: SELF_EXTEND, max_items: MAX_ITEMS, pid: process.pid });

  let itemCount   = 0;
  let doneCount   = 0;
  let extendRound = 0;
  const completedItems = [];  // rolling list of done item texts for Groq context

  while (itemCount < MAX_ITEMS) {
    // Graceful stop
    if (existsSync(STOP_FILE)) {
      console.log("\n⛔ Stop file detected — exiting gracefully.");
      await log({ op_id: opId, event: "stopped_by_file" });
      break;
    }

    const roadmapContent = await readFile(ROADMAP_FILE, "utf8");
    const { items } = parseRoadmap(roadmapContent);
    const item = nextPending(items);

    const total   = items.length;
    const done    = items.filter(i => i.status === "done").length;
    const failed  = items.filter(i => i.status === "failed").length;
    const pending = items.filter(i => i.status === "pending").length;

    console.log(`\n📋 Roadmap: ${done}/${total} done, ${failed} failed, ${pending} pending`);

    // ── Self-extend: roadmap exhausted or every N completions ────────────
    if (SELF_EXTEND && !DRY_RUN && (!item || (doneCount > 0 && doneCount % EXTEND_EVERY_N === 0 && pending === 0))) {
      extendRound++;
      console.log(`\n🧠 PM self-extend round ${extendRound} — generating new roadmap items...`);
      const context = await getProjectContext();
      const newItems = await generateNewRoadmapItems(context, completedItems, extendRound);
      if (newItems.length > 0) {
        await appendGeneratedItems(newItems, extendRound);
        await log({ op_id: opId, event: "self_extend", round: extendRound, new_items: newItems.length });
        // Reset doneCount so next extend fires after another EXTEND_EVERY_N completions
        doneCount = 0;
        continue;  // re-enter loop to pick up new items
      } else if (!item) {
        // No new items generated and nothing pending — we're genuinely done
        banner("🏁 Roadmap exhausted and PM has no new ideas — build complete!");
        await log({ op_id: opId, event: "all_done", total, done });
        break;
      }
    }

    if (!item) {
      if (!SELF_EXTEND) {
        banner("🏁 All roadmap items complete!");
        await log({ op_id: opId, event: "all_done", total, done });
      }
      break;
    }

    itemCount++;
    console.log(`\n[${itemCount}/${MAX_ITEMS}] Next item:\n  "${item.text}"`);

    const context = await getProjectContext();
    console.log(`  Website state: ${context}`);

    let task;
    if (DRY_RUN) {
      task = `[DRY RUN] Would dispatch: ${item.text}`;
      console.log(`  📝 Task (dry run):\n    ${task}`);
      await log({ op_id: opId, item: item.text, status: "dry_run" });
      await markItem(item.lineIdx, "done");
      await new Promise(r => setTimeout(r, 300));
      continue;
    }

    console.log("  🤔 PM expanding item into task...");
    task = await expandWithGroq(item.text, context);
    console.log(`  📝 Task:\n    ${task.substring(0, 120)}${task.length > 120 ? "..." : ""}`);

    const targetAgent = routeAgent(item.text);

    // Copywriter pass — runs before coder-front on copy-heavy tasks
    if (needsCopywriter(item.text) && targetAgent === "crew-coder-front") {
      task = await runCopywriterPass(item.text, task);
    }

    const start = Date.now();
    try {
      console.log(`  🚀 Dispatching to ${targetAgent}${targetAgent !== CODER_AGENT ? ` (specialist)` : ""}...`);
      await callAgent(targetAgent, `[PM-Loop] ${task}`);
      const dur = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`  ✅ Done in ${dur}s`);

      // QA review pass — if QA fails, route issues to crew-fixer
      if (USE_QA) {
        try {
          console.log(`  🔍 QA review via crew-qa...`);
          const qaPrompt = `[QA-Review] ${targetAgent} just completed this task:\n\n"${task.substring(0, 300)}"\n\nReview the changes in ${OUTPUT_DIR}. Check for: broken HTML/CSS, JS errors, missing files, visual regressions, Tailwind or unknown CSS classes on a non-Tailwind site.\n\nReply with exactly one of:\n- "PASS" if everything looks correct\n- "FAIL: <specific issues>" if there are problems that need fixing`;
          const qaResult = await callAgent("crew-qa", qaPrompt);
          const qaText = String(qaResult).trim();
          const qaPass = /^PASS/i.test(qaText);
          console.log(`  📋 QA: ${qaPass ? "✅ PASS" : "❌ FAIL"} — ${qaText.substring(0, 120)}`);
          await log({ op_id: opId, item: item.text, agent: "crew-qa", status: qaPass ? "qa_pass" : "qa_fail", qa_result: qaText.substring(0, 300) });

          // If QA flagged issues, send them to crew-fixer before marking done
          if (!qaPass) {
            try {
              console.log(`  🔧 QA failed — routing issues to crew-fixer...`);
              const fixPrompt = `[QA-Fixer] QA found issues after this task was completed:\n\nOriginal task: "${task.substring(0, 300)}"\n\nQA issues:\n${qaText}\n\nFix the issues in ${OUTPUT_DIR}. Do not rewrite the whole file — only fix what QA flagged. Confirm what you fixed.`;
              const fixResult = await callAgent("crew-fixer", fixPrompt);
              console.log(`  ✅ Fixer resolved QA issues: ${String(fixResult).substring(0, 80)}`);
              await log({ op_id: opId, item: item.text, agent: "crew-fixer", status: "qa_fixed", fix_result: String(fixResult).substring(0, 200) });
            } catch (fixErr) {
              console.log(`  ⚠️  Fixer couldn't resolve QA issues: ${fixErr.message.slice(0, 60)}`);
            }
          }
        } catch (qaErr) {
          console.log(`  ⚠️  QA skipped: ${qaErr.message.slice(0, 60)}`);
        }
      }

      // Security review for sensitive tasks
      if (needsSecurityReview(item.text)) {
        try {
          console.log(`  🔒 Security review via security agent...`);
          const secPrompt = `[Security-Review] Review the recent changes for security issues. Task was: "${task.substring(0, 200)}". Check for exposed secrets, injection risks, insecure patterns. Reply with CLEAR or list vulnerabilities.`;
          const secResult = await callAgent("crew-security", secPrompt);
          console.log(`  🛡️  Security: ${String(secResult).substring(0, 80)}`);
          await log({ op_id: opId, item: item.text, agent: "security", status: "security_reviewed", sec_result: String(secResult).substring(0, 200) });
        } catch (secErr) {
          console.log(`  ⚠️  Security review skipped: ${secErr.message.slice(0, 60)}`);
        }
      }

      await markItem(item.lineIdx, "done");
      await log({ op_id: opId, item: item.text, task: task.substring(0, 120), agent: targetAgent, status: "done", duration_s: parseFloat(dur) });
      doneCount++;
      completedItems.push(item.text);
    } catch (e) {
      const dur = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`  ❌ Failed in ${dur}s: ${e.message}`);
      await markItem(item.lineIdx, "failed");

      // Ask crew-fixer to attempt a repair
      try {
        console.log(`  🔧 Asking crew-fixer to repair...`);
        const fixPrompt = `[Fixer] The following task failed: "${task.substring(0, 300)}"\n\nError: ${e.message.slice(0, 200)}\n\nPlease review the output in ${OUTPUT_DIR}, identify what went wrong, and fix it.`;
        await callAgent("crew-fixer", fixPrompt);
        console.log(`  🔧 Fixer done — marking as done`);
        await markItem(item.lineIdx, "done");
        await log({ op_id: opId, item: item.text, task: task.substring(0, 120), agent: "crew-fixer", status: "fixed", duration_s: parseFloat(dur) });
        doneCount++;
        completedItems.push(item.text);
      } catch (fixErr) {
        console.log(`  ❌ Fixer also failed: ${fixErr.message.slice(0, 60)}`);
        await log({ op_id: opId, item: item.text, task: task.substring(0, 120), agent: CODER_AGENT, status: "failed", duration_s: parseFloat(dur), error: e.message });
      }
    }

    if (BETWEEN_TASKS > 0 && pending > 1) {
      console.log(`  ⏳ Pausing ${BETWEEN_TASKS / 1000}s before next item...`);
      await new Promise(r => setTimeout(r, BETWEEN_TASKS));
    }
  }

  // Final summary
  const finalContent = await readFile(ROADMAP_FILE, "utf8");
  const { items: finalItems } = parseRoadmap(finalContent);
  const done    = finalItems.filter(i => i.status === "done").length;
  const failed  = finalItems.filter(i => i.status === "failed").length;
  const pending = finalItems.filter(i => i.status === "pending").length;

  banner(`PM Loop finished  ✓${done}  ✗${failed}  ⏳${pending} remaining`);
  console.log(`Roadmap: ${ROADMAP_FILE}`);
  console.log(`Log:     ${PM_LOG}`);
  await log({ op_id: opId, event: "finish", done, failed, pending });
  await clearPid();
}

main().catch(e => { console.error(e); process.exit(1); });
