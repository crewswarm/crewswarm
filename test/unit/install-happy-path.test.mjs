/**
 * Happy-path tests for install.sh
 *
 * Strategy: no actual installation happens here. Instead we:
 *   1. Validate bash syntax with `bash -n`
 *   2. Parse the raw script source for structural correctness (sections,
 *      commands, idempotency guards, env-var flags)
 *   3. Run the script in a throw-away temp $HOME with --non-interactive and
 *      every feature flag off, so only the safe, side-effect-free steps run:
 *      config-directory creation, config-file bootstrapping, and shell-alias
 *      writing.  We never touch the real ~/.crewswarm or any shell rc file.
 *
 * Run: node --test test/unit/install-happy-path.test.mjs
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

// ── Paths ─────────────────────────────────────────────────────────────────────

const REPO_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../.."
);
const INSTALL_SH = path.join(REPO_DIR, "install.sh");
const SCRIPT_SRC = fs.readFileSync(INSTALL_SH, "utf8");

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Run `bash -n` (syntax-check only, no execution) against a file.
 * Returns { ok, stderr }.
 */
function bashSyntaxCheck(filePath) {
  const result = spawnSync("bash", ["-n", filePath], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return { ok: result.status === 0, stderr: result.stderr || "" };
}

/**
 * Create a fresh temp directory that acts as a fake $HOME.
 * Returns the path and a cleanup function.
 */
function makeTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewswarm-install-test-"));
  return {
    dir,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Run install.sh in a fully isolated temp $HOME using --non-interactive with
 * all optional features disabled so the script only performs the core steps
 * (dirs + config files + alias) without touching real system state.
 *
 * We override:
 *   HOME          → temp dir (so ~/.crewswarm stays clean)
 *   SHELL         → /bin/bash (so the alias lands in a predictable rc file)
 *   PATH          → keep real PATH so node/npm are found
 *   NODE          → (inherited)
 *
 * All optional extras are explicitly disabled via env vars so the script
 * never tries to build a Swift app, configure Telegram/WhatsApp, write MCP
 * configs, or start any server.
 */
function runInstallDryRun(fakeHome) {
  // Write a minimal .bash_profile so the alias-append logic doesn't fail on a
  // missing file (the script uses >>  which would create it, but we pre-create
  // to inspect the before/after content cleanly).
  const bashProfile = path.join(fakeHome, ".bash_profile");
  fs.writeFileSync(bashProfile, "# test profile\n", "utf8");

  const result = spawnSync(
    "bash",
    [INSTALL_SH, "--non-interactive"],
    {
      env: {
        // Carry through PATH, TERM, and anything node/npm need.
        ...process.env,
        HOME: fakeHome,
        SHELL: "/bin/bash",
        // Disable every optional extra.
        CREWSWARM_BUILD_CREWCHAT: "N",
        CREWSWARM_SETUP_TELEGRAM: "N",
        CREWSWARM_SETUP_WHATSAPP: "N",
        CREWSWARM_ENABLE_AUTONOMOUS: "N",
        CREWSWARM_SETUP_MCP: "N",
        CREWSWARM_START_NOW: "N",
        // Suppress CI auto-detection so the script runs its normal flow.
        CI: "",
        GITHUB_ACTIONS: "",
      },
      encoding: "utf8",
      timeout: 120_000,
      // Run from REPO_DIR so BASH_SOURCE[0] resolves correctly.
      cwd: REPO_DIR,
    }
  );

  return result;
}

// ── Section 1: Syntax validation ──────────────────────────────────────────────

describe("install.sh — syntax", () => {
  it("file exists and is non-empty", () => {
    assert.ok(fs.existsSync(INSTALL_SH), `install.sh not found at ${INSTALL_SH}`);
    assert.ok(SCRIPT_SRC.length > 0, "install.sh is empty");
  });

  it("has a bash shebang on line 1", () => {
    const firstLine = SCRIPT_SRC.split("\n")[0];
    assert.ok(
      firstLine.startsWith("#!/usr/bin/env bash") ||
        firstLine.startsWith("#!/bin/bash"),
      `Expected bash shebang, got: ${firstLine}`
    );
  });

  it("passes bash -n (no syntax errors)", () => {
    const { ok, stderr } = bashSyntaxCheck(INSTALL_SH);
    assert.ok(ok, `bash -n reported syntax errors:\n${stderr}`);
  });

  it("uses set -euo pipefail for strict error handling", () => {
    assert.ok(
      SCRIPT_SRC.includes("set -euo pipefail"),
      "Expected 'set -euo pipefail' for strict error mode"
    );
  });
});

// ── Section 2: Structural completeness ────────────────────────────────────────

describe("install.sh — structural completeness", () => {
  it("defines all 7 numbered install steps in section headers", () => {
    const steps = ["1/7", "2/7", "3/7", "4/7", "5/7", "6/7", "7/7"];
    for (const step of steps) {
      assert.ok(
        SCRIPT_SRC.includes(step),
        `Missing section header: ${step}`
      );
    }
  });

  it("checks for node and npm prerequisites", () => {
    assert.ok(
      SCRIPT_SRC.includes("command -v node"),
      "Expected node presence check"
    );
    assert.ok(
      SCRIPT_SRC.includes("command -v npm"),
      "Expected npm presence check"
    );
  });

  it("enforces Node.js >= 20 version gate", () => {
    assert.ok(
      SCRIPT_SRC.includes("-lt 20"),
      "Expected Node.js version gate (-lt 20)"
    );
  });

  it("runs npm install to install dependencies", () => {
    assert.ok(
      SCRIPT_SRC.includes("npm install"),
      "Expected 'npm install' in install script"
    );
  });

  it("creates all required ~/.crewswarm subdirectories", () => {
    const requiredDirs = [
      "chat-history",
      "logs",
      "sessions",
      "telemetry",
      "pids",
      "orchestrator-logs",
      "workspace",
      "shared-memory/.crew/agent-memory",
      "shared-memory/.crew/collections",
    ];
    for (const dir of requiredDirs) {
      assert.ok(
        SCRIPT_SRC.includes(dir),
        `Expected directory creation for: ${dir}`
      );
    }
  });

  it("creates config.json with an RT auth token", () => {
    assert.ok(
      SCRIPT_SRC.includes("crewswarm.json"),
      "Expected config.json bootstrap"
    );
    assert.ok(
      SCRIPT_SRC.includes("authToken"),
      "Expected authToken field in config.json"
    );
    assert.ok(
      SCRIPT_SRC.includes("crewswarm-"),
      "Expected 'crewswarm-' token prefix in RT token generation"
    );
  });

  it("creates crewswarm.json with agent and provider configs", () => {
    assert.ok(
      SCRIPT_SRC.includes("crewswarm.json"),
      "Expected crewswarm.json bootstrap"
    );
    assert.ok(
      SCRIPT_SRC.includes('"agents"'),
      "Expected agents array in crewswarm.json"
    );
    assert.ok(
      SCRIPT_SRC.includes('"providers"'),
      "Expected providers map in crewswarm.json"
    );
  });

  it("creates cmd-allowlist.json with default patterns", () => {
    assert.ok(
      SCRIPT_SRC.includes("cmd-allowlist.json"),
      "Expected cmd-allowlist.json creation"
    );
    assert.ok(
      SCRIPT_SRC.includes("npm *"),
      "Expected npm * in default allowlist patterns"
    );
  });

  it("creates token-usage.json initialised to zero counters", () => {
    assert.ok(
      SCRIPT_SRC.includes("token-usage.json"),
      "Expected token-usage.json creation"
    );
    assert.ok(
      SCRIPT_SRC.includes('"calls":0'),
      "Expected zero-initialised calls counter"
    );
  });

  it("writes a crew-cli shell alias", () => {
    assert.ok(
      SCRIPT_SRC.includes("crew-cli"),
      "Expected crew-cli alias to be written"
    );
    assert.ok(
      SCRIPT_SRC.includes("crew-cli.mjs"),
      "Expected crew-cli alias to point at crew-cli.mjs"
    );
  });

  it("supports --help flag with usage output", () => {
    assert.ok(
      SCRIPT_SRC.includes("--help"),
      "Expected --help flag handling"
    );
    assert.ok(
      SCRIPT_SRC.includes("--non-interactive"),
      "Expected --non-interactive in help text"
    );
  });

  it("supports --non-interactive / --ci flags", () => {
    assert.ok(
      SCRIPT_SRC.includes("--non-interactive"),
      "Expected --non-interactive flag"
    );
    assert.ok(
      SCRIPT_SRC.includes("--ci"),
      "Expected --ci flag alias"
    );
  });

  it("auto-detects CI and GITHUB_ACTIONS environments", () => {
    assert.ok(
      SCRIPT_SRC.includes('CI:-'),
      "Expected CI env-var auto-detection"
    );
    assert.ok(
      SCRIPT_SRC.includes("GITHUB_ACTIONS"),
      "Expected GITHUB_ACTIONS env-var auto-detection"
    );
  });
});

// ── Section 3: Idempotency guards ─────────────────────────────────────────────

describe("install.sh — idempotency (already-installed case)", () => {
  it("guards config.json creation with [[ ! -f ]] check", () => {
    // The script assigns CONFIG_FILE="$CREWSWARM_DIR/config.json" then guards
    // with: if [[ ! -f "$CONFIG_FILE" ]]; then
    // We verify both the variable assignment and the guard are present.
    assert.ok(
      SCRIPT_SRC.includes('CONFIG_FILE="$CREWSWARM_DIR/config.json"'),
      "Expected CONFIG_FILE variable assignment"
    );
    const hasGuard = /if\s+\[\[\s*!\s*-f\s+"\$CONFIG_FILE"\s*\]\]/.test(SCRIPT_SRC);
    assert.ok(hasGuard, "config.json creation should be guarded by [[ ! -f \"$CONFIG_FILE\" ]] check");
  });

  it("guards crewswarm.json creation with [[ ! -f ]] check", () => {
    assert.ok(
      SCRIPT_SRC.includes('CREWSWARM_JSON="$CREWSWARM_DIR/crewswarm.json"'),
      "Expected CREWSWARM_JSON variable assignment"
    );
    const hasGuard = /if\s+\[\[\s*!\s*-f\s+"\$CREWSWARM_JSON"\s*\]\]/.test(SCRIPT_SRC);
    assert.ok(hasGuard, "crewswarm.json creation should be guarded by [[ ! -f \"$CREWSWARM_JSON\" ]] check");
  });

  it("guards cmd-allowlist.json creation with [[ ! -f ]] check", () => {
    assert.ok(
      SCRIPT_SRC.includes('ALLOWLIST="$CREWSWARM_DIR/cmd-allowlist.json"'),
      "Expected ALLOWLIST variable assignment"
    );
    const hasGuard = /if\s+\[\[\s*!\s*-f\s+"\$ALLOWLIST"\s*\]\]/.test(SCRIPT_SRC);
    assert.ok(hasGuard, "cmd-allowlist.json creation should be guarded by [[ ! -f \"$ALLOWLIST\" ]] check");
  });

  it("guards agent-prompts.json creation with [[ ! -f ]] check", () => {
    assert.ok(
      SCRIPT_SRC.includes('PROMPTS_FILE="$CREWSWARM_DIR/agent-prompts.json"'),
      "Expected PROMPTS_FILE variable assignment"
    );
    const hasGuard = /if\s+\[\[\s*!\s*-f\s+"\$PROMPTS_FILE"\s*\]\]/.test(SCRIPT_SRC);
    assert.ok(hasGuard, "agent-prompts.json creation should be guarded by [[ ! -f \"$PROMPTS_FILE\" ]] check");
  });

  it("guards shell alias with grep check to avoid duplicate entries", () => {
    assert.ok(
      SCRIPT_SRC.includes('grep -q "crew-cli"'),
      "Expected grep check to avoid adding duplicate crew-cli alias"
    );
  });

  it("emits a 'keeping it' message when config already exists", () => {
    assert.ok(
      SCRIPT_SRC.includes("already exists — keeping it"),
      "Expected 'already exists — keeping it' message for pre-existing configs"
    );
  });
});

// ── Section 4: Non-interactive env-var coverage ───────────────────────────────

describe("install.sh — non-interactive env-var flags", () => {
  const ENV_FLAGS = [
    "CREWSWARM_BUILD_CREWCHAT",
    "CREWSWARM_SETUP_TELEGRAM",
    "TELEGRAM_BOT_TOKEN",
    "CREWSWARM_SETUP_WHATSAPP",
    "CREWSWARM_WHATSAPP_NUMBER",
    "CREWSWARM_WHATSAPP_NAME",
    "CREWSWARM_ENABLE_AUTONOMOUS",
    "CREWSWARM_AUTONOMOUS_MINUTES",
    "CREWSWARM_SETUP_MCP",
    "CREWSWARM_START_NOW",
  ];

  for (const flag of ENV_FLAGS) {
    it(`references env var ${flag}`, () => {
      assert.ok(
        SCRIPT_SRC.includes(flag),
        `Expected env var ${flag} to be referenced in install.sh`
      );
    });
  }
});

// ── Section 5: Live dry-run in isolated temp $HOME ────────────────────────────
//
// This is the only section that actually spawns the script. We do it exactly
// once (in before()) and inspect the file-system artefacts it left behind.
// The script is invoked with --non-interactive and all optional extras
// disabled, so it only performs the safe core steps.

describe("install.sh — live dry-run (isolated temp HOME)", () => {
  let tempHome;
  let runResult;

  before(() => {
    tempHome = makeTempHome();
    runResult = runInstallDryRun(tempHome.dir);
  });

  after(() => {
    if (tempHome) tempHome.cleanup();
  });

  it("exits with status 0", () => {
    if (runResult.status !== 0) {
      // Emit stdout/stderr to help diagnose failures in CI
      process.stderr.write(
        `\n[install dry-run STDOUT]\n${runResult.stdout}\n` +
          `[install dry-run STDERR]\n${runResult.stderr}\n`
      );
    }
    assert.equal(
      runResult.status,
      0,
      `install.sh exited with status ${runResult.status}`
    );
  });

  it("creates the ~/.crewswarm base directory", () => {
    const dir = path.join(tempHome.dir, ".crewswarm");
    assert.ok(
      fs.existsSync(dir),
      `Expected ${dir} to exist after install`
    );
  });

  const SUBDIRS = [
    "chat-history",
    "logs",
    "sessions",
    "telemetry",
    "pids",
    "orchestrator-logs",
    "workspace",
    path.join("shared-memory", ".crew", "agent-memory"),
    path.join("shared-memory", ".crew", "collections"),
    "skills",
    "engines",
  ];

  for (const sub of SUBDIRS) {
    it(`creates ~/.crewswarm/${sub}`, () => {
      const dir = path.join(tempHome.dir, ".crewswarm", sub);
      assert.ok(
        fs.existsSync(dir),
        `Expected ~/.crewswarm/${sub} to exist`
      );
    });
  }

  it("creates ~/.crewswarm/config.json", () => {
    const file = path.join(tempHome.dir, ".crewswarm", "config.json");
    assert.ok(fs.existsSync(file), "config.json not found");
  });

  it("config.json is valid JSON", () => {
    const file = path.join(tempHome.dir, ".crewswarm", "config.json");
    const raw = fs.readFileSync(file, "utf8");
    assert.doesNotThrow(() => JSON.parse(raw), "config.json is not valid JSON");
  });

  it("config.json contains a non-empty rt.authToken", () => {
    const file = path.join(tempHome.dir, ".crewswarm", "config.json");
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(
      typeof cfg?.rt?.authToken === "string" && cfg.rt.authToken.length > 0,
      `Expected a non-empty rt.authToken, got: ${JSON.stringify(cfg?.rt?.authToken)}`
    );
  });

  it("config.json rt.authToken starts with expected prefix", () => {
    const file = path.join(tempHome.dir, ".crewswarm", "config.json");
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(
      cfg.rt.authToken.startsWith("crewswarm-"),
      `Expected token to start with 'crewswarm-', got: ${cfg.rt.authToken}`
    );
  });

  it("creates ~/.crewswarm/crewswarm.json", () => {
    const file = path.join(tempHome.dir, ".crewswarm", "crewswarm.json");
    assert.ok(fs.existsSync(file), "crewswarm.json not found");
  });

  it("crewswarm.json is valid JSON", () => {
    const file = path.join(tempHome.dir, ".crewswarm", "crewswarm.json");
    const raw = fs.readFileSync(file, "utf8");
    assert.doesNotThrow(() => JSON.parse(raw), "crewswarm.json is not valid JSON");
  });

  it("crewswarm.json contains a non-empty agents array", () => {
    const file = path.join(tempHome.dir, ".crewswarm", "crewswarm.json");
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(Array.isArray(cfg.agents) && cfg.agents.length > 0, "Expected agents array");
  });

  it("crewswarm.json agents all have id and model fields", () => {
    const file = path.join(tempHome.dir, ".crewswarm", "crewswarm.json");
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const agent of cfg.agents) {
      assert.ok(
        typeof agent.id === "string" && agent.id.length > 0,
        `Agent missing id: ${JSON.stringify(agent)}`
      );
      assert.ok(
        typeof agent.model === "string" && agent.model.length > 0,
        `Agent ${agent.id} missing model`
      );
    }
  });

  it("crewswarm.json contains a providers map with groq entry", () => {
    const file = path.join(tempHome.dir, ".crewswarm", "crewswarm.json");
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(
      cfg.providers && typeof cfg.providers === "object",
      "Expected providers map"
    );
    assert.ok("groq" in cfg.providers, "Expected groq provider entry");
  });

  it("creates ~/.crewswarm/cmd-allowlist.json", () => {
    const file = path.join(tempHome.dir, ".crewswarm", "cmd-allowlist.json");
    assert.ok(fs.existsSync(file), "cmd-allowlist.json not found");
  });

  it("cmd-allowlist.json is valid JSON with patterns array", () => {
    const file = path.join(tempHome.dir, ".crewswarm", "cmd-allowlist.json");
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(
      Array.isArray(cfg.patterns),
      "Expected cmd-allowlist.json to have a patterns array"
    );
    assert.ok(cfg.patterns.length > 0, "Expected at least one default allow pattern");
  });

  it("cmd-allowlist.json pre-approves npm, node, and npx", () => {
    const file = path.join(tempHome.dir, ".crewswarm", "cmd-allowlist.json");
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    const patterns = cfg.patterns.join(" ");
    assert.ok(patterns.includes("npm"), "Expected npm in allowlist");
    assert.ok(patterns.includes("node"), "Expected node in allowlist");
    assert.ok(patterns.includes("npx"), "Expected npx in allowlist");
  });

  it("creates ~/.crewswarm/token-usage.json", () => {
    const file = path.join(tempHome.dir, ".crewswarm", "token-usage.json");
    assert.ok(fs.existsSync(file), "token-usage.json not found");
  });

  it("token-usage.json is valid JSON with zero-initialised counters", () => {
    const file = path.join(tempHome.dir, ".crewswarm", "token-usage.json");
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(cfg.calls, 0, "Expected calls to be 0");
    assert.equal(cfg.promptTokens, 0, "Expected promptTokens to be 0");
    assert.equal(cfg.completionTokens, 0, "Expected completionTokens to be 0");
    assert.equal(cfg.totalTokens, 0, "Expected totalTokens to be 0");
    assert.equal(cfg.estimatedCostUSD, 0, "Expected estimatedCostUSD to be 0");
  });

  it("creates ~/.crewswarm/agent-prompts.json", () => {
    const file = path.join(tempHome.dir, ".crewswarm", "agent-prompts.json");
    assert.ok(fs.existsSync(file), "agent-prompts.json not found");
  });

  it("agent-prompts.json is valid JSON", () => {
    const file = path.join(tempHome.dir, ".crewswarm", "agent-prompts.json");
    const raw = fs.readFileSync(file, "utf8");
    assert.doesNotThrow(() => JSON.parse(raw), "agent-prompts.json is not valid JSON");
  });

  it("writes crew-cli alias to .bash_profile", () => {
    const profile = path.join(tempHome.dir, ".bash_profile");
    const content = fs.readFileSync(profile, "utf8");
    assert.ok(
      content.includes("crew-cli"),
      "Expected crew-cli alias in .bash_profile"
    );
    assert.ok(
      content.includes("crew-cli.mjs"),
      "Expected crew-cli alias to reference crew-cli.mjs"
    );
  });
});

// ── Section 6: Idempotency — re-running does not overwrite existing configs ───

describe("install.sh — idempotency (re-run does not overwrite)", () => {
  let tempHome;
  let firstToken;

  before(() => {
    // First run
    tempHome = makeTempHome();
    const first = runInstallDryRun(tempHome.dir);
    assert.equal(
      first.status,
      0,
      `First install run failed (status ${first.status}):\n${first.stderr}`
    );

    // Record the generated auth token so we can verify it survives the second run
    const cfgFile = path.join(tempHome.dir, ".crewswarm", "config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    firstToken = cfg?.rt?.authToken;

    // Second run — should be safe and preserve the existing token
    const second = runInstallDryRun(tempHome.dir);
    assert.equal(
      second.status,
      0,
      `Second install run failed (status ${second.status}):\n${second.stderr}`
    );
  });

  after(() => {
    if (tempHome) tempHome.cleanup();
  });

  it("preserves the existing rt.authToken on re-run", () => {
    const cfgFile = path.join(tempHome.dir, ".crewswarm", "config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    assert.equal(
      cfg.rt.authToken,
      firstToken,
      "rt.authToken was overwritten on second run — idempotency broken"
    );
  });

  it("does not duplicate the crew-cli alias on re-run", () => {
    const profile = path.join(tempHome.dir, ".bash_profile");
    const content = fs.readFileSync(profile, "utf8");
    const matchCount = (content.match(/alias crew-cli=/g) || []).length;
    assert.equal(
      matchCount,
      1,
      `Expected exactly 1 crew-cli alias, found ${matchCount} after re-run`
    );
  });
});
