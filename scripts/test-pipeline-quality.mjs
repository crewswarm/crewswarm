#!/usr/bin/env node
/**
 * Pipeline quality test suite
 *
 * Two modes:
 *   1. OFFLINE  — validates parsePipeline() + task quality rules without running services
 *   2. LIVE     — sends a build request to crew-lead /chat, captures the @@PIPELINE, validates it
 *
 * Usage:
 *   node scripts/test-pipeline-quality.mjs              # offline tests only
 *   node scripts/test-pipeline-quality.mjs --live        # offline + live test against running crew-lead
 *   node scripts/test-pipeline-quality.mjs --live --prompt "build a dark landing page for hobbs2"
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const LIVE = process.argv.includes("--live");
const promptIdx = process.argv.indexOf("--prompt");
const CUSTOM_PROMPT = promptIdx >= 0 ? process.argv[promptIdx + 1] : null;
const CREW_LEAD_URL = process.env.CREW_LEAD_URL || "http://127.0.0.1:5010";

// ── Pipeline parser (mirror of crew-lead.mjs) ──────────────────────────────

function parsePipeline(text) {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const match = clean.match(/@@PIPELINE\s+(\[[\s\S]*?\])/);
  if (!match) return null;
  try {
    const steps = JSON.parse(match[1]);
    if (!Array.isArray(steps) || steps.length < 2) return null;
    if (!steps.every(s => s.agent && s.task)) return null;
    steps.forEach((s, i) => { if (s.wave == null) s.wave = i + 1; });
    const waveMap = new Map();
    for (const s of steps) {
      const w = Number(s.wave);
      if (!waveMap.has(w)) waveMap.set(w, []);
      waveMap.get(w).push(s);
    }
    const sortedWaveNums = [...waveMap.keys()].sort((a, b) => a - b);
    return { steps, waves: sortedWaveNums.map(n => waveMap.get(n)) };
  } catch { return null; }
}

// ── Quality validators ─────────────────────────────────────────────────────

const PATH_PATTERN = /(?:\/[A-Za-z][\w.-]*){2,}/;
const READ_FILE_PATTERN = /@@READ_FILE\s+\S+/;
const WRITE_FILE_PATTERN = /@@WRITE_FILE\s+\S+/;
const OUTPUT_EXT_PATTERN = /\.(html|css|js|mjs|ts|tsx|jsx|json|md)(?:\s|$)/;

function validateTaskQuality(steps, waves) {
  const results = [];
  let pass = 0;
  let fail = 0;

  function check(name, ok, detail) {
    if (ok) { pass++; results.push({ name, status: "PASS", detail }); }
    else    { fail++; results.push({ name, status: "FAIL", detail }); }
  }

  // Rule 1: Every task must mention at least one absolute file path
  for (const step of steps) {
    const hasPath = PATH_PATTERN.test(step.task);
    check(
      `${step.agent} task has file path`,
      hasPath,
      hasPath ? "Found path in task" : `No absolute path found in task: "${step.task.slice(0, 80)}..."`
    );
  }

  // Rule 2: Build agents (coders, frontend) should have @@READ_FILE or explicit input reference
  const buildAgents = ["crew-coder", "crew-coder-front", "crew-coder-back", "crew-frontend"];
  for (const step of steps) {
    if (!buildAgents.includes(step.agent)) continue;
    const hasRead = READ_FILE_PATTERN.test(step.task) || /read\s+/i.test(step.task);
    check(
      `${step.agent} task references input files`,
      hasRead,
      hasRead ? "Has read instruction" : `Build agent has no @@READ_FILE or read instruction: "${step.task.slice(0, 80)}..."`
    );
  }

  // Rule 3: Build agents should specify an output file
  for (const step of steps) {
    if (!buildAgents.includes(step.agent)) continue;
    const hasOutput = WRITE_FILE_PATTERN.test(step.task) || OUTPUT_EXT_PATTERN.test(step.task);
    check(
      `${step.agent} task specifies output file`,
      hasOutput,
      hasOutput ? "Has output file reference" : `Build agent has no output file specified: "${step.task.slice(0, 80)}..."`
    );
  }

  // Rule 4: No two agents in the same wave working on the same output file
  for (const wave of waves) {
    if (wave.length < 2) continue;
    const outputFiles = [];
    for (const step of wave) {
      const writeMatch = step.task.match(/@@WRITE_FILE\s+(\S+)/);
      if (writeMatch) outputFiles.push({ agent: step.agent, file: writeMatch[1] });
      const pathMatch = step.task.match(/(?:build|create|write)\s+(\S+\.(?:html|css|js|mjs|ts|tsx|json))/i);
      if (pathMatch) outputFiles.push({ agent: step.agent, file: pathMatch[1] });
    }
    const fileSet = new Map();
    for (const { agent, file } of outputFiles) {
      const norm = path.resolve(file);
      if (fileSet.has(norm)) {
        check(
          `No parallel write conflict in wave`,
          false,
          `${agent} and ${fileSet.get(norm)} both writing to ${file} in same wave`
        );
      } else {
        fileSet.set(norm, agent);
      }
    }
    if (outputFiles.length > 0 && fileSet.size === outputFiles.length) {
      check(`No parallel write conflict in wave`, true, `${wave.length} agents, no file conflicts`);
    }
  }

  // Rule 5: All output paths should share a common project directory
  const allPaths = [];
  for (const step of steps) {
    const matches = step.task.matchAll(/(?:\/[A-Za-z][\w.-]*){2,}/g);
    for (const m of matches) allPaths.push(m[0]);
  }
  if (allPaths.length >= 2) {
    const dirs = allPaths.map(p => {
      const parts = p.split("/").filter(Boolean);
      return parts.length > 2 ? "/" + parts.slice(0, 3).join("/") : "/" + parts.join("/");
    });
    const uniqueDirs = [...new Set(dirs)];
    check(
      "Consistent project directory",
      uniqueDirs.length <= 2,
      uniqueDirs.length <= 2
        ? `All paths under: ${uniqueDirs.join(", ")}`
        : `Scattered across ${uniqueDirs.length} directories: ${uniqueDirs.join(", ")}`
    );
  }

  // Rule 6: PM should be in wave 1 for proper planning phase
  const hasPM = steps.some(s => s.agent === "crew-pm");
  if (hasPM) {
    const pmWave = Math.min(...steps.filter(s => s.agent === "crew-pm").map(s => Number(s.wave)));
    check(
      "PM in first wave (planning phase)",
      pmWave === Math.min(...steps.map(s => Number(s.wave))),
      pmWave === Math.min(...steps.map(s => Number(s.wave)))
        ? `PM is in wave ${pmWave} (earliest)`
        : `PM is in wave ${pmWave} but build starts earlier`
    );
  }

  // Rule 7: Waves are properly ordered (planning before building, QA after building)
  const planAgents = new Set(["crew-pm", "crew-copywriter"]);
  const qaAgents = new Set(["crew-qa", "crew-security"]);
  let minBuildWave = Infinity, maxPlanWave = -1, minQAWave = Infinity;
  for (const step of steps) {
    const w = Number(step.wave);
    if (planAgents.has(step.agent)) maxPlanWave = Math.max(maxPlanWave, w);
    else if (qaAgents.has(step.agent)) minQAWave = Math.min(minQAWave, w);
    else if (buildAgents.includes(step.agent)) minBuildWave = Math.min(minBuildWave, w);
  }
  if (maxPlanWave >= 0 && minBuildWave < Infinity) {
    check(
      "Planning before building",
      maxPlanWave < minBuildWave,
      maxPlanWave < minBuildWave
        ? `Plan wave ${maxPlanWave} < build wave ${minBuildWave}`
        : `Plan wave ${maxPlanWave} >= build wave ${minBuildWave} — planning should finish before building starts`
    );
  }
  if (minQAWave < Infinity && minBuildWave < Infinity) {
    check(
      "QA after building",
      minQAWave > minBuildWave,
      minQAWave > minBuildWave
        ? `QA wave ${minQAWave} > build wave ${minBuildWave}`
        : `QA wave ${minQAWave} <= build wave ${minBuildWave} — QA should run after building`
    );
  }

  return { pass, fail, results };
}

// ── Offline tests ──────────────────────────────────────────────────────────

function runOfflineTests() {
  console.log("═══ OFFLINE PIPELINE TESTS ═══\n");

  const cases = [
    {
      name: "Good pipeline: file paths + proper waves",
      input: `Building the page now.
@@PIPELINE [{"wave":1,"agent":"crew-copywriter","task":"@@READ_FILE /Users/jeff/Desktop/hobbs2/hobbs-is-king-showcase-copy.md and write final polished copy to /Users/jeff/Desktop/hobbs2/content-copy.md via @@WRITE_FILE"},{"wave":2,"agent":"crew-coder-front","task":"@@READ_FILE /Users/jeff/Desktop/hobbs2/content-copy.md then build /Users/jeff/Desktop/hobbs2/index.html using that copy. Dark theme, semantic HTML."},{"wave":3,"agent":"crew-qa","task":"@@READ_FILE /Users/jeff/Desktop/hobbs2/index.html and audit for a11y, performance, and content accuracy vs /Users/jeff/Desktop/hobbs2/content-copy.md"}]`,
      expectParse: true,
      expectPass: true,
    },
    {
      name: "Bad pipeline: no file paths (vague tasks)",
      input: `Let's go!
@@PIPELINE [{"wave":1,"agent":"crew-pm","task":"Lock the IA and requirements"},{"wave":1,"agent":"crew-copywriter","task":"Write the hero copy and value props"},{"wave":2,"agent":"crew-coder-front","task":"Build a dark theme landing page"},{"wave":2,"agent":"crew-frontend","task":"Build the visual design and animations"},{"wave":3,"agent":"crew-qa","task":"Test everything"}]`,
      expectParse: true,
      expectPass: false,
    },
    {
      name: "Bad pipeline: two frontend agents same wave same file",
      input: `Go!
@@PIPELINE [{"wave":1,"agent":"crew-copywriter","task":"Write copy to /Users/jeff/Desktop/hobbs2/content-copy.md"},{"wave":2,"agent":"crew-coder-front","task":"@@READ_FILE /Users/jeff/Desktop/hobbs2/content-copy.md and build /Users/jeff/Desktop/hobbs2/index.html"},{"wave":2,"agent":"crew-frontend","task":"@@READ_FILE /Users/jeff/Desktop/hobbs2/content-copy.md and build /Users/jeff/Desktop/hobbs2/index.html"}]`,
      expectParse: true,
      expectPass: false,
    },
    {
      name: "Unparseable: malformed JSON",
      input: `@@PIPELINE [{agent: crew-coder, task: do stuff}]`,
      expectParse: false,
    },
    {
      name: "Unparseable: only 1 step",
      input: `@@PIPELINE [{"wave":1,"agent":"crew-coder","task":"do something"}]`,
      expectParse: false,
    },
  ];

  let totalPass = 0, totalFail = 0;

  for (const tc of cases) {
    console.log(`── ${tc.name} ──`);
    const parsed = parsePipeline(tc.input);

    if (!tc.expectParse) {
      if (!parsed) {
        console.log("  PASS: correctly rejected unparseable input\n");
        totalPass++;
      } else {
        console.log("  FAIL: should not have parsed but did\n");
        totalFail++;
      }
      continue;
    }

    if (!parsed) {
      console.log("  FAIL: expected parse but got null\n");
      totalFail++;
      continue;
    }

    console.log(`  Parsed: ${parsed.steps.length} steps, ${parsed.waves.length} waves`);
    const { pass, fail, results } = validateTaskQuality(parsed.steps, parsed.waves);

    for (const r of results) {
      const icon = r.status === "PASS" ? "✅" : "❌";
      console.log(`  ${icon} ${r.name}: ${r.detail}`);
    }

    if (tc.expectPass && fail > 0) {
      console.log(`  ⚠️  Expected all checks to pass but ${fail} failed`);
      totalFail++;
    } else if (!tc.expectPass && fail === 0) {
      console.log(`  ⚠️  Expected some checks to fail but all passed`);
      totalFail++;
    } else {
      console.log(`  PASS: ${pass} checks passed, ${fail} failed (as expected)`);
      totalPass++;
    }
    console.log();
  }

  console.log(`\nOffline: ${totalPass} test cases passed, ${totalFail} failed\n`);
  return totalFail === 0;
}

// ── Live test ──────────────────────────────────────────────────────────────

async function runLiveTest() {
  console.log("═══ LIVE PIPELINE TEST (crew-lead /chat) ═══\n");

  const CFG = path.join(os.homedir(), ".crewswarm", "config.json");
  let token;
  try {
    const c = JSON.parse(fs.readFileSync(CFG, "utf8"));
    token = c.rt?.authToken || "";
  } catch {
    console.error("Cannot read token from ~/.crewswarm/config.json");
    return false;
  }

  const prompt = CUSTOM_PROMPT || [
    "Dispatch the crew to build a single-file dark-theme landing page for the Hobbs Is King project at /Users/jeffhobbs/Desktop/hobbs2/.",
    "The copywriter already wrote copy in /Users/jeffhobbs/Desktop/hobbs2/content-copy.md and /Users/jeffhobbs/Desktop/hobbs2/hobbs-is-king-showcase-copy.md.",
    "Output should be /Users/jeffhobbs/Desktop/hobbs2/index.html.",
    "Use @@PIPELINE with proper waves. DO NOT actually dispatch — this is a test. Just show me the @@PIPELINE JSON you would emit.",
  ].join(" ");

  console.log("Prompt:", prompt.slice(0, 150) + "...\n");

  let data;
  try {
    const res = await fetch(`${CREW_LEAD_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: prompt, sessionId: "pipeline-test" }),
    });
    data = await res.json();
  } catch (e) {
    console.error("Cannot reach crew-lead:", e.message);
    console.error("Make sure services are running (npm run restart-all)");
    return false;
  }

  const reply = data.reply || data.message || "";
  console.log("Reply (first 500 chars):", reply.slice(0, 500));
  console.log();

  // Check server-side pipeline execution (@@PIPELINE is stripped from reply)
  let parsed = data.pipeline ? { steps: data.pipeline.steps, waves: data.pipeline.waves } : null;

  // Fallback: try parsing from reply text (in case pipeline marker wasn't stripped)
  if (!parsed) parsed = parsePipeline(reply);

  if (!parsed) {
    const mentionsPipeline = /wave|pipeline|step/i.test(reply);
    if (mentionsPipeline) {
      console.log("⚠️  Reply discusses a pipeline but no @@PIPELINE marker was emitted.");
      console.log("   crew-lead described it in words instead of actually emitting the command.");
    } else {
      console.log("⚠️  No @@PIPELINE found in reply. crew-lead may have answered conversationally.");
    }
    return false;
  }

  console.log(`Pipeline executed: ${parsed.steps.length} steps, ${parsed.waves.length} waves\n`);

  for (let wi = 0; wi < parsed.waves.length; wi++) {
    const wave = parsed.waves[wi];
    console.log(`Wave ${wi + 1}: ${wave.map(s => s.agent).join(" + ")}`);
    for (const s of wave) {
      console.log(`  → ${s.agent}: ${s.task.slice(0, 120)}${s.task.length > 120 ? "..." : ""}`);
    }
  }
  console.log();

  const { pass, fail, results } = validateTaskQuality(parsed.steps, parsed.waves);
  for (const r of results) {
    const icon = r.status === "PASS" ? "✅" : "❌";
    console.log(`${icon} ${r.name}: ${r.detail}`);
  }

  console.log(`\nLive test: ${pass} checks passed, ${fail} failed\n`);
  return fail === 0;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const offlineOk = runOfflineTests();

  if (LIVE) {
    const liveOk = await runLiveTest();
    process.exit(offlineOk && liveOk ? 0 : 1);
  }

  process.exit(offlineOk ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
