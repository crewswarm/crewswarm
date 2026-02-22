#!/usr/bin/env node
/**
 * CONTINUOUS BUILD — "Replit-style" keep building until done.
 *
 * Checks the website after each round, figures out what's missing,
 * and dispatches targeted tasks until all sections are present.
 *
 * Usage:
 *   node continuous-build.mjs "Build the CrewSwarm marketing website in website/"
 *   node continuous-build.mjs --max-rounds 6 "..."
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = process.env.CREWSWARM_DIR || process.env.OPENCLAW_DIR || __dirname;
const GATEWAY_BRIDGE_PATH = join(REPO_DIR, "gateway-bridge.mjs");
const OUTPUT_DIR = process.env.OPENCREW_OUTPUT_DIR || join(REPO_DIR, "website");
const LOG_DIR = join(REPO_DIR, "orchestrator-logs");
const BUILD_LOG = join(LOG_DIR, "continuous-build.jsonl");
const TASK_TIMEOUT_MS = Number(process.env.PHASED_TASK_TIMEOUT_MS || "300000");

if (!existsSync(LOG_DIR)) await mkdir(LOG_DIR, { recursive: true });

// ── What "done" looks like ────────────────────────────────────────────────
const REQUIRED_SECTIONS = [
  { id: "hero",          patterns: [/class=["']hero/i, /<h1/i],                      label: "Hero section" },
  { id: "how-it-works",  patterns: [/how.it.works|how_it_works|how-it-works/i],       label: "How it works" },
  { id: "features",      patterns: [/features|feature.card|feature.grid/i],           label: "Features / feature cards" },
  { id: "get-started",   patterns: [/get.started|getstarted|quick.start/i],           label: "Get started" },
  { id: "styles",        file: join(OUTPUT_DIR, "styles.css"),                        label: "styles.css" },
];

async function checkCompletion() {
  const indexPath = join(OUTPUT_DIR, "index.html");
  const missing = [];
  let html = "";

  if (existsSync(indexPath)) {
    html = await readFile(indexPath, "utf8").catch(() => "");
  } else {
    return { done: false, missing: REQUIRED_SECTIONS.map(s => s.label), html };
  }

  for (const section of REQUIRED_SECTIONS) {
    if (section.file) {
      if (!existsSync(section.file)) missing.push(section.label);
    } else {
      const found = section.patterns.some(p => p.test(html));
      if (!found) missing.push(section.label);
    }
  }

  return { done: missing.length === 0, missing, html };
}

// ── Task dispatch ─────────────────────────────────────────────────────────
function callAgent(agentId, message) {
  const env = {
    ...process.env,
    OPENCREW_RT_SEND_TIMEOUT_MS: String(TASK_TIMEOUT_MS),
    PHASED_TASK_TIMEOUT_MS: String(TASK_TIMEOUT_MS),
  };
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [GATEWAY_BRIDGE_PATH, "--send", agentId, message], {
      stdio: ["inherit", "pipe", "pipe"],
      env,
    });
    let out = "";
    let err = "";
    proc.stdout?.on("data", d => { out += d; });
    proc.stderr?.on("data", d => { err += d; });
    const t = setTimeout(() => { proc.kill("SIGTERM"); reject(new Error(`Timeout (${TASK_TIMEOUT_MS}ms)`)); }, TASK_TIMEOUT_MS);
    proc.on("close", code => {
      clearTimeout(t);
      if (code !== 0) reject(new Error(err || out || `exit ${code}`));
      else resolve(out.trim() || err.trim());
    });
  });
}

async function log(entry) {
  await appendFile(BUILD_LOG, JSON.stringify(entry) + "\n").catch(() => {});
}

// ── Build tasks for each missing section ─────────────────────────────────
function tasksForMissing(missing, requirement) {
  const tasks = [];
  const idx = join(OUTPUT_DIR, "index.html");
  const css = join(OUTPUT_DIR, "styles.css");
  const ref = join(REPO_DIR, "docs", "WEBSITE-FEATURES-AND-USE-CASES.md");

  if (!existsSync(join(OUTPUT_DIR, "index.html"))) {
    tasks.push({
      agent: "crew-coder",
      task: `Create ${idx} with HTML5 boilerplate, link to styles.css, and an empty <main>. Title: "OpenCrewHQ". No content yet — just structure.`,
    });
  }

  for (const label of missing) {
    if (label === "Hero section") {
      tasks.push({
        agent: "crew-coder",
        task: `Add a <section class="hero"> to ${idx} with <h1>OpenCrewHQ</h1> and tagline <p>One requirement, one build, one crew.</p> and a "Get started" CTA button. Use content from ${ref}.`,
      });
    } else if (label === "How it works") {
      tasks.push({
        agent: "crew-coder",
        task: `Add a <section id="how-it-works"> to ${idx} with a 5-step ordered list: Requirement → PM plan → Tasks → Agents → Done. Read ${ref} for exact copy.`,
      });
    } else if (label === "Features / feature cards") {
      tasks.push({
        agent: "crew-coder",
        task: `Add a <section id="features"> to ${idx} with 6 feature cards: PM-led orchestration, Targeted dispatch, Phased builds, Real tool execution, Shared memory, Fault tolerance. Read ${ref} for descriptions.`,
      });
    } else if (label === "Get started") {
      tasks.push({
        agent: "crew-coder",
        task: `Add a <section id="get-started"> to ${idx} with prerequisites list and quick-start steps. Read ${ref} for content.`,
      });
    } else if (label === "styles.css") {
      tasks.push({
        agent: "crew-coder",
        task: `Create ${css} with: dark background (#0f172a), clean sans-serif typography, hero full-viewport styling, 3-column feature card grid (responsive), numbered how-it-works steps, sticky footer. Professional marketing site look.`,
      });
    }
  }

  return tasks;
}

// ── Main loop ─────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const maxRoundsArg = args.findIndex(a => a === "--max-rounds");
  const MAX_ROUNDS = maxRoundsArg >= 0 ? Number(args[maxRoundsArg + 1]) : 8;
  const reqArgs = args.filter((a, i) => a !== "--max-rounds" && args[maxRoundsArg] !== "--max-rounds" || (i !== maxRoundsArg && i !== maxRoundsArg + 1));
  const requirement = reqArgs.filter(a => a !== "--max-rounds").join(" ").trim()
    || "Build the OpenCrewHQ marketing website in website/";

  const opId = `cb-${randomUUID().slice(0, 8)}`;

  console.log(`
═══════════════════════════════════════════════════════════════
  CONTINUOUS BUILD  (max ${MAX_ROUNDS} rounds)
  Op: ${opId}
  Output: ${OUTPUT_DIR}
  Requirement: ${requirement.substring(0, 80)}${requirement.length > 80 ? "..." : ""}
═══════════════════════════════════════════════════════════════
`);

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    console.log(`\n── Round ${round}/${MAX_ROUNDS} ──────────────────────────────────────`);

    const { done, missing } = await checkCompletion();

    if (done) {
      console.log("✅ All sections complete! Build done.");
      await log({ timestamp: new Date().toISOString(), op_id: opId, round, status: "done" });
      break;
    }

    console.log(`Missing: ${missing.join(", ")}`);
    const tasks = tasksForMissing(missing, requirement);

    if (tasks.length === 0) {
      console.log("No tasks generated — stopping.");
      break;
    }

    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      console.log(`  [${i + 1}/${tasks.length}] ${t.agent}: ${t.task.substring(0, 70)}...`);
      const start = Date.now();
      try {
        await callAgent(t.agent, `[Round ${round}] ${t.task}`);
        const dur = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`    ✅ ${dur}s`);
        await log({ timestamp: new Date().toISOString(), op_id: opId, round, agent: t.agent, task: t.task.substring(0, 80), status: "completed", duration_s: parseFloat(dur) });
      } catch (e) {
        const dur = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`    ❌ ${dur}s: ${e.message}`);
        await log({ timestamp: new Date().toISOString(), op_id: opId, round, agent: t.agent, task: t.task.substring(0, 80), status: "failed", duration_s: parseFloat(dur), error: e.message });
      }
    }

    // Brief pause between rounds so agents can settle
    console.log("  ⏳ Checking completion in 3s...");
    await new Promise(r => setTimeout(r, 3000));
  }

  // Final check
  const { done, missing } = await checkCompletion();
  console.log(`
═══════════════════════════════════════════════════════════════
  ${done ? "✅ BUILD COMPLETE" : `⚠️  Still missing: ${missing.join(", ")}`}
  Output: ${OUTPUT_DIR}
═══════════════════════════════════════════════════════════════
`);
}

main().catch(e => { console.error(e); process.exit(1); });
