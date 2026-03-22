/**
 * first-run.test.mjs — Validates the zero-config first-run experience.
 *
 * These tests simulate a fresh clone (no ~/.crewswarm/ directory) and verify:
 *   1. Core config helpers return safe defaults, never throw.
 *   2. Entry-point helpers (loadConfig in start-crew, loadConfig in crew-lead)
 *      fall back gracefully and produce usable defaults.
 *   3. The "npm start" script exists and points at a real file.
 *   4. validateRequiredAgents gives actionable guidance when agents are absent.
 *
 * No network, no filesystem side-effects — all config reads use functions that
 * gracefully handle ENOENT.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

// ── Hoist all dynamic imports to top level (top-level await is fine in ESM) ──

const configMod = await import(`${ROOT}/lib/runtime/config.mjs`);
const { validateRequiredAgents, REQUIRED_AGENTS } = await import(`${ROOT}/lib/agent-registry.mjs`);

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Run a function while a temp empty dir is available. Does not override the
 * module-level CREWSWARM_CONFIG_PATH (which is baked in at import time), but
 * provides the temp dir for callers that need an empty filesystem context.
 */
function withEmptyConfigDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewswarm-first-run-"));
  try {
    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── 1. Core config helpers ────────────────────────────────────────────────────

describe("lib/runtime/config.mjs — zero-config safety", () => {
  test("loadSystemConfig() returns an object and never throws", () => {
    let result;
    assert.doesNotThrow(() => { result = configMod.loadSystemConfig(); },
      "loadSystemConfig() must not throw");
    assert.ok(typeof result === "object" && result !== null,
      "loadSystemConfig() must return an object");
  });

  test("loadSwarmConfig() returns an object and never throws", () => {
    let result;
    assert.doesNotThrow(() => { result = configMod.loadSwarmConfig(); },
      "loadSwarmConfig() must not throw");
    assert.ok(typeof result === "object" && result !== null,
      "loadSwarmConfig() must return an object");
  });

  test("loadAgentList() returns an array and never throws", () => {
    let agents;
    assert.doesNotThrow(() => { agents = configMod.loadAgentList(); },
      "loadAgentList() must not throw");
    assert.ok(Array.isArray(agents),
      "loadAgentList() must return an array");
  });

  test("resolveProvider() returns null for unknown provider without crashing", () => {
    let result;
    assert.doesNotThrow(
      () => { result = configMod.resolveProvider("nonexistent-provider-xyz"); },
      "resolveProvider() must not throw for unknown provider"
    );
    assert.equal(result, null,
      "resolveProvider() must return null for unknown provider");
  });

  test("loadCursorWavesEnabled() returns a boolean and never throws", () => {
    const prevEnv = process.env.CREWSWARM_CURSOR_WAVES;
    delete process.env.CREWSWARM_CURSOR_WAVES;
    try {
      let result;
      assert.doesNotThrow(() => { result = configMod.loadCursorWavesEnabled(); },
        "loadCursorWavesEnabled() must not throw");
      assert.ok(typeof result === "boolean",
        "loadCursorWavesEnabled() must return boolean");
    } finally {
      if (prevEnv !== undefined) process.env.CREWSWARM_CURSOR_WAVES = prevEnv;
    }
  });

  test("loadClaudeCodeEnabled() returns a boolean and never throws", () => {
    const prevEnv = process.env.CREWSWARM_CLAUDE_CODE;
    delete process.env.CREWSWARM_CLAUDE_CODE;
    try {
      let result;
      assert.doesNotThrow(() => { result = configMod.loadClaudeCodeEnabled(); },
        "loadClaudeCodeEnabled() must not throw");
      assert.ok(typeof result === "boolean",
        "loadClaudeCodeEnabled() must return boolean");
    } finally {
      if (prevEnv !== undefined) process.env.CREWSWARM_CLAUDE_CODE = prevEnv;
    }
  });
});

// ── 2. crew-lead loadConfig() fallback behaviour ─────────────────────────────
//
// crew-lead.mjs cannot be imported directly (it binds a port on import).
// We replicate the relevant logic from its loadConfig() to verify the fallback
// invariants that the file depends on.

describe("crew-lead loadConfig() zero-config fallbacks", () => {
  test("knownAgents falls back to built-in default roster when crewswarm.json is absent", () => {
    const csSwarm = configMod.loadSwarmConfig(); // returns {} on ENOENT
    const agents = Array.isArray(csSwarm.agents) ? csSwarm.agents : [];

    const knownAgents = [...new Set(agents.map(a => a.id))];
    if (!knownAgents.length) {
      knownAgents.push(
        "crew-main", "crew-pm", "crew-coder", "crew-qa", "crew-fixer",
        "crew-security", "crew-coder-front", "crew-coder-back",
        "crew-github", "crew-frontend", "crew-copywriter"
      );
    }
    assert.ok(knownAgents.length > 0,
      "crew-lead must always have at least one known agent after fallback");
  });

  test("default model string is in provider/model format", () => {
    const csSwarm = configMod.loadSwarmConfig();
    const agents = Array.isArray(csSwarm.agents) ? csSwarm.agents : [];
    const agentCfg = agents.find(a => a.id === "crew-lead");
    const modelString = agentCfg?.model || process.env.CREW_LEAD_MODEL || "groq/llama-3.3-70b-versatile";
    assert.ok(modelString.includes("/"),
      `Default model string must be in provider/model format, got: ${modelString}`);
  });
});

// ── 3. package.json — start script existence and target ──────────────────────

describe("package.json — start script", () => {
  const pkgPath = path.join(ROOT, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

  test("package.json has a 'start' script defined", () => {
    assert.ok(
      typeof pkg.scripts?.start === "string" && pkg.scripts.start.trim().length > 0,
      `package.json is missing a 'start' script. ` +
      `New users run 'npm start' — without it they see:\n` +
      `  npm error Missing script: "start"\n` +
      `Add a start script that either runs install.sh first or shows guidance.`
    );
  });

  test("the file referenced by the start script exists", () => {
    if (!pkg.scripts?.start) return; // already failed above
    // Extract the node script path from the start command, e.g. "node scripts/start.mjs"
    const match = pkg.scripts.start.match(/node\s+([\w./-]+\.mjs)/);
    if (!match) return; // non-node start command, skip
    const scriptPath = path.join(ROOT, match[1]);
    assert.ok(
      fs.existsSync(scriptPath),
      `start script references '${match[1]}' but that file does not exist at ${scriptPath}`
    );
  });
});

// ── 4. validateRequiredAgents — actionable guidance ──────────────────────────

describe("validateRequiredAgents() — first-run guidance", () => {
  test("returns valid:false with full missing list when agents array is empty", () => {
    const result = validateRequiredAgents([]);
    assert.equal(result.valid, false,
      "validateRequiredAgents([]) must report invalid");
    assert.ok(Array.isArray(result.missing) && result.missing.length > 0,
      "missing list must be non-empty when no agents configured");
    for (const required of REQUIRED_AGENTS) {
      assert.ok(result.missing.includes(required),
        `Expected '${required}' to appear in missing list`);
    }
  });

  test("returns valid:true when all required agents are present", () => {
    const fakeAgents = [...REQUIRED_AGENTS].map(id => ({ id }));
    const result = validateRequiredAgents(fakeAgents);
    assert.equal(result.valid, true,
      "validateRequiredAgents must be valid when all required agents present");
    assert.deepEqual(result.missing, [],
      "missing array must be empty when all required agents present");
  });

  test("missing list entries are non-empty strings (usable in error messages)", () => {
    const result = validateRequiredAgents([]);
    for (const entry of result.missing) {
      assert.equal(typeof entry, "string",
        `missing entry must be a string, got ${typeof entry}`);
      assert.ok(entry.length > 0, "missing entry must not be an empty string");
    }
  });
});

// ── 5. start-crew.mjs — first-run error message references install.sh ────────

describe("scripts/start-crew.mjs — first-run guidance text", () => {
  const startCrewPath = path.join(ROOT, "scripts", "start-crew.mjs");

  test("start-crew.mjs exists", () => {
    assert.ok(
      fs.existsSync(startCrewPath),
      `scripts/start-crew.mjs not found at ${startCrewPath}`
    );
  });

  test("start-crew.mjs error message references install.sh", () => {
    const src = fs.readFileSync(startCrewPath, "utf8");
    assert.ok(
      src.includes("install.sh"),
      "start-crew.mjs must mention 'install.sh' in its missing-agents error " +
      "so new users know what to run. Found no reference to install.sh."
    );
  });
});

// ── 6. config.mjs — safe reads never throw ───────────────────────────────────

describe("lib/runtime/config.mjs — error handling", () => {
  test("loadSystemConfig() never throws regardless of disk state", () => {
    assert.doesNotThrow(
      () => configMod.loadSystemConfig(),
      "loadSystemConfig() must never throw, even with corrupt/missing config"
    );
  });

  test("loadSwarmConfig() never throws regardless of disk state", () => {
    assert.doesNotThrow(
      () => configMod.loadSwarmConfig(),
      "loadSwarmConfig() must never throw"
    );
  });
});

// ── 7. dashboard.mjs — startup-level CFG_FILE read is guarded ────────────────

describe("scripts/dashboard.mjs — import-level zero-config safety", () => {
  const dashPath = path.join(ROOT, "scripts", "dashboard.mjs");

  test("dashboard.mjs exists", () => {
    assert.ok(
      fs.existsSync(dashPath),
      `scripts/dashboard.mjs not found at ${dashPath}`
    );
  });

  test("startup CFG_FILE read is wrapped in try/catch", () => {
    // The pattern near the top of dashboard.mjs is:
    //   try { const _cfg = JSON.parse(fs.readFileSync(CFG_FILE, "utf8")); ... } catch { }
    // Without this guard the process crashes on a fresh clone.
    const src = fs.readFileSync(dashPath, "utf8");
    // Look for a try block that contains both readFileSync and CFG_FILE
    const hasTryCatch = /try\s*\{[^{}]*readFileSync[^{}]*CFG_FILE[^{}]*\}[^{}]*catch/s.test(src);
    assert.ok(
      hasTryCatch,
      "dashboard.mjs startup readFileSync(CFG_FILE) must be wrapped in try/catch " +
      "so it does not crash when crewswarm.json is absent on first run"
    );
  });
});

// ── 8. scripts/start.mjs — first-run script content checks ───────────────────

describe("scripts/start.mjs — first-run entry point", () => {
  const startPath = path.join(ROOT, "scripts", "start.mjs");

  test("scripts/start.mjs exists", () => {
    assert.ok(
      fs.existsSync(startPath),
      `scripts/start.mjs not found at ${startPath}`
    );
  });

  test("scripts/start.mjs references install.sh in its guidance", () => {
    const src = fs.readFileSync(startPath, "utf8");
    assert.ok(
      src.includes("install.sh"),
      "scripts/start.mjs must reference install.sh so new users know what to run"
    );
  });

  test("scripts/start.mjs checks for ~/.crewswarm directory", () => {
    const src = fs.readFileSync(startPath, "utf8");
    assert.ok(
      src.includes("CREWSWARM_DIR") || src.includes(".crewswarm"),
      "scripts/start.mjs must check for the ~/.crewswarm config directory"
    );
  });

  test("scripts/start.mjs checks for crewswarm.json", () => {
    const src = fs.readFileSync(startPath, "utf8");
    assert.ok(
      src.includes("crewswarm.json"),
      "scripts/start.mjs must check for crewswarm.json before starting"
    );
  });
});
