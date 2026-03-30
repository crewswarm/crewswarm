/**
 * E2E: Dashboard Build-tab planner endpoint.
 *
 * Verifies that /api/enhance-prompt can route planning requests through
 * several CLI engines when they are installed and the dashboard is running.
 *
 * REQUIRES: dashboard on :4319 and whichever CLIs you want to exercise.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { checkServiceUp, httpRequest } from "../helpers/http.mjs";
import { logEngineTestContext } from "../helpers/test-context.mjs";
import { logTestEvidence } from "../helpers/test-log.mjs";

// Use a temp directory so planner engines don't clobber the repo
const TEST_DIR = join(tmpdir(), `crewswarm-planner-test-${Date.now()}`);
mkdirSync(TEST_DIR, { recursive: true });

const DASHBOARD_BASE = process.env.DASHBOARD_BASE || "http://127.0.0.1:4319";
const dashboardUp = await checkServiceUp(`${DASHBOARD_BASE}/health`);
const SKIP = dashboardUp ? false : "dashboard not running on :4319";

function isInstalled(bin) {
  const candidates = {
    claude: [join(homedir(), ".local", "bin", "claude"), "/usr/local/bin/claude", "/opt/homebrew/bin/claude"],
    codex: ["/usr/local/bin/codex", "/opt/homebrew/bin/codex"],
    agent: [join(homedir(), ".local", "bin", "agent"), "/usr/local/bin/agent", "/opt/homebrew/bin/agent"],
    gemini: ["/usr/local/bin/gemini", "/opt/homebrew/bin/gemini"],
    opencode: [join(homedir(), ".opencode", "bin", "opencode"), "/usr/local/bin/opencode", "/opt/homebrew/bin/opencode"],
  };
  for (const candidate of candidates[bin] || []) {
    if (existsSync(candidate)) return true;
  }
  try {
    execSync(`which ${bin}`, { stdio: "pipe", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function planWithDashboard(engine) {
  const { status, data } = await httpRequest(`${DASHBOARD_BASE}/api/enhance-prompt`, {
    method: "POST",
    timeout: 300000,
    trace: {
      test: `planner:${engine}`,
      file: import.meta.filename,
      operation: "dashboard-enhance-prompt",
      extra: { engine, expected_timeout_ms: 300000 },
    },
    body: {
      text: "Build a lightweight dashboard feature to show agent health and recent failures.",
      engine,
    },
  });
  assert.equal(status, 200, `planner request should succeed for ${engine}`);
  assert.ok(data && typeof data === "object", "planner response should be JSON");
  assert.ok(typeof data.enhanced === "string" && data.enhanced.trim().length > 0, `planner should return text for ${engine}`);
  // Planner should return substantive content (not just a one-liner)
  assert.ok(data.enhanced.trim().length > 50, `planner output should be substantive for ${engine} (got ${data.enhanced.trim().length} chars)`);
  return data;
}

after(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});

// Run sequentially — each planner spawns a CLI process; concurrent requests crash the dashboard.
// Total timeout must accommodate all engines (each can take 30-120s).
describe("dashboard build planner", { skip: SKIP, concurrency: 1, timeout: 900000 }, () => {
  const engines = [
    { name: "Claude Code", engine: "claude", bin: "claude" },
    { name: "Codex", engine: "codex", bin: "codex" },
    { name: "Cursor CLI", engine: "cursor", bin: "agent" },
    { name: "Gemini CLI", engine: "gemini", bin: "gemini" },
    { name: "crew-cli", engine: "crew-cli", bin: "crew" },
    { name: "OpenCode", engine: "opencode", bin: "opencode" },
  ];

  for (const { name, engine, bin } of engines) {
    it(`${name}: returns a structured build brief`, { skip: !isInstalled(bin) ? `${name} not available` : false, timeout: 300000 }, async () => {
      // Verify dashboard is still alive before each engine test
      const up = await checkServiceUp(`${DASHBOARD_BASE}/health`);
      assert.ok(up, `Dashboard down before ${name} test — previous engine may have crashed it`);
      logEngineTestContext({
        test: `${name}: returns a structured build brief`,
        file: import.meta.filename,
        engine,
        timeout_ms: 300000,
        project_dir: TEST_DIR,
        notes: "Dashboard planner endpoint should return substantive build text",
      });
      const data = await planWithDashboard(engine);
      logTestEvidence({
        category: "planner_result",
        test: `${name}: returns a structured build brief`,
        file: import.meta.filename,
        engine,
        planner_engine: data.engine || null,
        planner_mode: data.mode || null,
        enhanced_length: data.enhanced?.length || 0,
      });
      console.log(`    ${name} planner engine=${data.engine} mode=${data.mode}`);
    });
  }
});
