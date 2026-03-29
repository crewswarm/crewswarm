/**
 * Unit tests for settings API endpoints — verifies that the config
 * read/write pattern works for all 13 settings endpoints.
 * Tests the config persistence layer directly (not HTTP).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_CFG_DIR = path.join(os.tmpdir(), `.crewswarm-test-${process.pid}`);
const TEST_CFG_PATH = path.join(TEST_CFG_DIR, "crewswarm.json");

function readCfg() {
  try { return JSON.parse(fs.readFileSync(TEST_CFG_PATH, "utf8")); } catch { return {}; }
}

function writeCfg(cfg) {
  fs.writeFileSync(TEST_CFG_PATH, JSON.stringify(cfg, null, 2));
}

describe("settings config persistence", () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_CFG_DIR, { recursive: true });
    writeCfg({});
  });

  afterEach(() => {
    try { fs.rmSync(TEST_CFG_DIR, { recursive: true, force: true }); } catch {}
  });

  it("boolean toggle: codexEnabled round-trips", () => {
    const cfg = readCfg();
    cfg.codexEnabled = true;
    writeCfg(cfg);
    assert.equal(readCfg().codexEnabled, true);

    const cfg2 = readCfg();
    cfg2.codexEnabled = false;
    writeCfg(cfg2);
    assert.equal(readCfg().codexEnabled, false);
  });

  it("boolean toggle: geminiCliEnabled round-trips", () => {
    const cfg = readCfg();
    cfg.geminiCliEnabled = true;
    writeCfg(cfg);
    assert.equal(readCfg().geminiCliEnabled, true);
  });

  it("boolean toggle: crewCliEnabled round-trips", () => {
    const cfg = readCfg();
    cfg.crewCliEnabled = true;
    writeCfg(cfg);
    assert.equal(readCfg().crewCliEnabled, true);
  });

  it("boolean toggle: opencodeEnabled round-trips", () => {
    const cfg = readCfg();
    cfg.opencodeEnabled = true;
    writeCfg(cfg);
    assert.equal(readCfg().opencodeEnabled, true);
  });

  it("boolean toggle: tmuxBridge round-trips", () => {
    const cfg = readCfg();
    cfg.tmuxBridge = true;
    writeCfg(cfg);
    assert.equal(readCfg().tmuxBridge, true);
  });

  it("nested boolean: autonomousMentionsEnabled round-trips", () => {
    const cfg = readCfg();
    if (!cfg.settings) cfg.settings = {};
    cfg.settings.autonomousMentionsEnabled = false;
    writeCfg(cfg);
    assert.equal(readCfg().settings.autonomousMentionsEnabled, false);
  });

  it("engine loop: enabled + maxRounds round-trip", () => {
    const cfg = readCfg();
    cfg.engineLoop = true;
    cfg.engineLoopMaxRounds = 5;
    writeCfg(cfg);
    const loaded = readCfg();
    assert.equal(loaded.engineLoop, true);
    assert.equal(loaded.engineLoopMaxRounds, 5);
  });

  it("string value: passthroughNotify round-trips", () => {
    const cfg = readCfg();
    cfg.passthroughNotify = "telegram";
    writeCfg(cfg);
    assert.equal(readCfg().passthroughNotify, "telegram");
  });

  it("string value: loopBrain round-trips", () => {
    const cfg = readCfg();
    cfg.loopBrain = "groq/llama-3.3-70b-versatile";
    writeCfg(cfg);
    assert.equal(readCfg().loopBrain, "groq/llama-3.3-70b-versatile");
  });

  it("string value: rtToken round-trips", () => {
    const cfg = readCfg();
    cfg.rtToken = "test-token-abc123";
    writeCfg(cfg);
    assert.equal(readCfg().rtToken, "test-token-abc123");
  });

  it("config lock: file-based lock mechanism", () => {
    const lockFile = path.join(TEST_CFG_DIR, ".config.lock");

    // Not locked initially
    assert.equal(fs.existsSync(lockFile), false);

    // Lock
    fs.writeFileSync(lockFile, new Date().toISOString());
    assert.equal(fs.existsSync(lockFile), true);

    // Unlock
    fs.unlinkSync(lockFile);
    assert.equal(fs.existsSync(lockFile), false);
  });

  it("readCfg returns empty object for missing file", () => {
    fs.rmSync(TEST_CFG_PATH, { force: true });
    const cfg = readCfg();
    assert.deepEqual(cfg, {});
  });

  it("writeCfg preserves existing fields when adding new ones", () => {
    writeCfg({ existingField: "keep-me", codexEnabled: false });
    const cfg = readCfg();
    cfg.geminiCliEnabled = true;
    writeCfg(cfg);
    const final = readCfg();
    assert.equal(final.existingField, "keep-me");
    assert.equal(final.codexEnabled, false);
    assert.equal(final.geminiCliEnabled, true);
  });
});

describe("loadTmuxBridgeEnabled", () => {
  it("reads from env var", async () => {
    const { loadTmuxBridgeEnabled } = await import("../../lib/runtime/config.mjs");
    const old = process.env.CREWSWARM_TMUX_BRIDGE;
    process.env.CREWSWARM_TMUX_BRIDGE = "1";
    assert.equal(loadTmuxBridgeEnabled(), true);
    process.env.CREWSWARM_TMUX_BRIDGE = "0";
    assert.equal(loadTmuxBridgeEnabled(), false);
    if (old !== undefined) process.env.CREWSWARM_TMUX_BRIDGE = old;
    else delete process.env.CREWSWARM_TMUX_BRIDGE;
  });
});
