#!/usr/bin/env node
/**
 * CrewSwarm Quickstart Video — Simulated Install + First Run
 *
 * Creates a terminal-style recording showing the install and first use flow.
 * Uses Playwright to render HTML terminal frames and capture as screenshots,
 * then stitches into a video with ffmpeg.
 */
import { chromium } from "playwright";
import { mkdirSync, rmSync, existsSync, statSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "..", "website", "vibe-assets");
const FINAL_MP4 = join(OUT, "quickstart.mp4");
const FINAL_WEBM = join(OUT, "quickstart.webm");
const VIEWPORT = { width: 900, height: 560 };
const SLIDE_DURATION = 3;

mkdirSync(OUT, { recursive: true });

// Clean old quickstart slides
for (const f of readdirSync(OUT)) {
  if (f.startsWith("qs-") && f.endsWith(".png")) rmSync(join(OUT, f), { force: true });
}

function terminalHTML(lines, title = "Terminal — crewswarm") {
  const content = lines.map(l => {
    if (l.startsWith("$")) return `<span style="color:#4ade80;">${esc(l)}</span>`;
    if (l.startsWith("//")) return `<span style="color:#6b7280;font-style:italic;">${esc(l)}</span>`;
    if (l.includes("✓") || l.includes("✔") || l.includes("Done") || l.includes("ready")) return `<span style="color:#4ade80;">${esc(l)}</span>`;
    if (l.includes("⚡") || l.includes("→")) return `<span style="color:#60a5fa;">${esc(l)}</span>`;
    if (l.includes("🧠") || l.includes("📐") || l.includes("🔧")) return `<span style="color:#fbbf24;">${esc(l)}</span>`;
    return esc(l);
  }).join("\n");

  return `<!DOCTYPE html>
<html><head><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#0a0e17; font-family:'SF Mono','Fira Code',monospace; padding:20px; }
  .terminal { background:#0d1117; border:1px solid #21262d; border-radius:12px; overflow:hidden; }
  .bar { background:#161b22; padding:10px 14px; display:flex; align-items:center; gap:8px; }
  .dot { width:12px; height:12px; border-radius:50%; }
  .red { background:#ff5f57; } .yellow { background:#febc2e; } .green { background:#28c840; }
  .title { color:#8b949e; font-size:13px; margin-left:8px; }
  .body { padding:16px 20px; color:#c9d1d9; font-size:14px; line-height:1.7; white-space:pre-wrap; min-height:400px; }
</style></head><body>
<div class="terminal">
  <div class="bar">
    <div class="dot red"></div><div class="dot yellow"></div><div class="dot green"></div>
    <span class="title">${esc(title)}</span>
  </div>
  <div class="body">${content}</div>
</div>
</body></html>`;
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const frames = [
  {
    title: "Install — 60 seconds",
    lines: [
      "$ npm install -g crewswarm",
      "",
      "added 47 packages in 8s",
      "",
      "✓ crewswarm@0.8.1 installed globally",
      "",
      "$ crewswarm",
      "",
      "⚡ crewswarm v0.8.1",
      "→ Dashboard:  http://localhost:4319",
      "→ Vibe IDE:   http://localhost:3333",
      "→ crew-lead:  http://localhost:5010",
      "→ MCP server: http://localhost:5020",
      "",
      "✓ All services ready",
    ],
  },
  {
    title: "Configure — pick your models",
    lines: [
      "// Open Dashboard → Models tab",
      "// Set a model per agent — or use CLI OAuth (no keys needed)",
      "",
      "  crew-lead ......... Groq Llama 3.3 70B      Free",
      "  crew-pm ........... Gemini 2.5 Flash         $0.075/M",
      "  crew-coder ........ Claude Sonnet 4.6        $3/M",
      "  crew-coder-front .. Cursor (composer-2)      Cursor sub",
      "  crew-qa ........... Gemini CLI (OAuth)       Free",
      "  crew-fixer ........ Codex CLI (OAuth)        Codex sub",
      "",
      "// Or use Claude Code / Cursor / Gemini CLI directly —",
      "// just login once with OAuth, no API keys",
      "",
      "✓ Models configured from dashboard — no config files",
    ],
  },
  {
    title: "Build — one sentence, full feature",
    lines: [
      '$ crew run "Build a REST API with auth, tests, and docs"',
      "",
      "🧠 crew-pm planning...",
      "  → Phase MVP: 3 tasks (auth, routes, tests)",
      "  → Phase 1:   2 tasks (docs, error handling)",
      "",
      "📐 Wave 1: dispatching to 3 agents in parallel",
      "  → crew-coder-back: auth middleware + JWT",
      "  → crew-coder-back: CRUD routes + validation",
      "  → crew-qa:         test suite (jest)",
      "",
      "✓ Wave 1 complete (2m 14s)",
      "",
      "📐 Wave 2: dispatching to 2 agents",
      "  → crew-coder:  API docs (OpenAPI spec)",
      "  → crew-fixer:  error handling + edge cases",
    ],
  },
  {
    title: "Build — done",
    lines: [
      "✓ Wave 2 complete (1m 38s)",
      "",
      "🧠 crew-pm: all phases complete",
      "",
      "  Files created:",
      "    src/middleware/auth.js      ✓",
      "    src/routes/users.js         ✓",
      "    src/routes/posts.js         ✓",
      "    tests/auth.test.js          ✓",
      "    tests/routes.test.js        ✓",
      "    docs/openapi.yaml           ✓",
      "",
      "  Tests: 14 passed, 0 failed",
      "  Duration: 3m 52s (2 phases, 2 waves)",
      "",
      "✓ Build complete. Files on disk. Ship it.",
    ],
  },
  {
    title: "Rate limited? Switch engines",
    lines: [
      "// Claude hit rate limit mid-session?",
      "// Switch to Cursor or Gemini — session context preserved",
      "",
      "  Dashboard → Engines tab → click any engine",
      "",
      "  Claude Code .... --resume <session-id>",
      "  Cursor CLI ..... --resume=<chat-id>",
      "  Gemini CLI ..... --resume <session-id>",
      "  Codex CLI ...... codex resume <thread-id>",
      "  OpenCode ....... --continue",
      "",
      "// Or in Vibe: just pick a different CLI from the dropdown",
      "// Your conversation continues where you left off",
      "",
      "✓ 6 engines. Native session resume. No vendor lock-in.",
    ],
  },
  {
    title: "Vibe IDE — code in your browser",
    lines: [
      "// Open http://localhost:3333",
      "",
      "  ┌─────────────────────────────────────────────┐",
      "  │  Files  │  Monaco Editor    │  Chat         │",
      "  │         │                   │               │",
      "  │  src/   │  server.mjs       │  Claude Code  │",
      "  │  tests/ │  import http...   │  Cursor CLI   │",
      "  │  docs/  │  const app = ...  │  Gemini CLI   │",
      "  │         │                   │  OpenCode     │",
      "  │         │──────────────────│  Codex CLI    │",
      "  │         │  Terminal         │               │",
      "  │         │  $ npm test       │  [Clear]      │",
      "  └─────────────────────────────────────────────┘",
      "",
      "  Editor + terminal + chat + 6 engines. All in one tab.",
    ],
  },
];

async function capture() {
  console.log("Capturing quickstart frames...");
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: VIEWPORT, colorScheme: "dark" });

  let slideNum = 0;
  for (const frame of frames) {
    slideNum++;
    const page = await ctx.newPage();
    const html = terminalHTML(frame.lines, frame.title);
    const tmpHtml = join(OUT, `_qs_tmp.html`);
    writeFileSync(tmpHtml, html);
    await page.goto(`file://${tmpHtml}`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    const path = join(OUT, `qs-${String(slideNum).padStart(2, "0")}.png`);
    await page.screenshot({ path });
    console.log(`  [${slideNum}] ${frame.title}`);
    await page.close();
  }

  rmSync(join(OUT, "_qs_tmp.html"), { force: true });
  await ctx.close();
  await browser.close();
  return slideNum;
}

function buildVideo(totalSlides) {
  console.log("\nBuilding quickstart video...");
  const slides = [];
  for (let i = 1; i <= totalSlides; i++) {
    const p = join(OUT, `qs-${String(i).padStart(2, "0")}.png`);
    if (existsSync(p)) slides.push(p);
  }

  const inputs = slides.map(s => `-loop 1 -t ${SLIDE_DURATION} -i "${s}"`).join(" ");
  const cf = 0.6;

  let filterComplex = "";
  let lastLabel = "0:v";
  for (let i = 1; i < slides.length; i++) {
    const offset = i * SLIDE_DURATION - i * cf;
    const outLabel = i === slides.length - 1 ? "outv" : `v${i}`;
    filterComplex += `[${lastLabel}][${i}:v]xfade=transition=fade:duration=${cf}:offset=${offset.toFixed(2)}[${outLabel}];`;
    lastLabel = outLabel;
  }
  filterComplex = filterComplex.replace(/;$/, "");

  rmSync(FINAL_MP4, { force: true });
  rmSync(FINAL_WEBM, { force: true });

  console.log("  → mp4...");
  execSync(`ffmpeg -y ${inputs} -filter_complex "${filterComplex}" -map "[outv]" -c:v libx264 -crf 23 -preset slow -pix_fmt yuv420p -movflags +faststart -an "${FINAL_MP4}"`,
    { stdio: "pipe", timeout: 60_000 });

  console.log("  → webm...");
  execSync(`ffmpeg -y -i "${FINAL_MP4}" -c:v libvpx-vp9 -crf 30 -b:v 0 -an "${FINAL_WEBM}"`,
    { stdio: "pipe", timeout: 60_000 });

  const mp4KB = Math.round(statSync(FINAL_MP4).size / 1024);
  const webmKB = Math.round(statSync(FINAL_WEBM).size / 1024);
  console.log(`\nDone:`);
  console.log(`  mp4:  ${mp4KB} KB`);
  console.log(`  webm: ${webmKB} KB`);
}

capture()
  .then(n => { buildVideo(n); console.log("\nQuickstart video complete!"); })
  .catch(e => { console.error("Failed:", e.message); process.exit(1); });
