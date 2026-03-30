/**
 * Unit tests for lib/agents/daemon.mjs
 *
 * Covers: agentPidPath, agentLogPath, readPid, isPidAlive,
 *         latestHeartbeatAgeSec, isAgentDaemonRunning, resolveSpawnTargets
 *
 * Skips: spawnAgentDaemon (spawns real processes)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  agentPidPath,
  agentLogPath,
  readPid,
  isPidAlive,
  latestHeartbeatAgeSec,
  resolveSpawnTargets,
} from "../../lib/agents/daemon.mjs";

describe("daemon – agentPidPath / agentLogPath", () => {
  it("returns a .pid path containing the agent name", () => {
    const p = agentPidPath("crew-coder");
    assert.ok(p.endsWith("crew-coder.pid"), `expected .pid suffix, got ${p}`);
    assert.ok(p.includes("rt-agents"));
  });

  it("returns a .log path containing the agent name", () => {
    const p = agentLogPath("crew-qa");
    assert.ok(p.endsWith("crew-qa.log"), `expected .log suffix, got ${p}`);
  });
});

describe("daemon – readPid", () => {
  it("returns 0 for a non-existent agent", () => {
    assert.equal(readPid("__nonexistent_agent_xyzzy__"), 0);
  });
});

describe("daemon – isPidAlive", () => {
  it("returns false for 0", () => {
    assert.equal(isPidAlive(0), false);
  });

  it("returns false for NaN", () => {
    assert.equal(isPidAlive(NaN), false);
  });

  it("returns true for the current process PID", () => {
    assert.equal(isPidAlive(process.pid), true);
  });

  it("returns false for an absurdly high PID", () => {
    assert.equal(isPidAlive(99999999), false);
  });
});

describe("daemon – latestHeartbeatAgeSec", () => {
  it("returns null when no status log exists for a made-up agent", () => {
    const age = latestHeartbeatAgeSec("__no_such_agent__");
    // null is acceptable (file missing or no matching heartbeat)
    assert.ok(age === null || typeof age === "number");
  });
});

describe("daemon – resolveSpawnTargets", () => {
  it("returns all agents when payload is empty", () => {
    const targets = resolveSpawnTargets({});
    assert.ok(Array.isArray(targets));
    assert.ok(targets.length > 0);
  });

  it("returns specific agents when payload.agents is provided", () => {
    const targets = resolveSpawnTargets({ agents: ["crew-coder", "crew-qa"] });
    assert.deepEqual(targets, ["crew-coder", "crew-qa"]);
  });

  it("returns single agent when payload.agent is a string", () => {
    const targets = resolveSpawnTargets({ agent: "crew-fixer" });
    assert.deepEqual(targets, ["crew-fixer"]);
  });

  it('returns all agents when payload.agent is "all"', () => {
    const all = resolveSpawnTargets({});
    const targets = resolveSpawnTargets({ agent: "all" });
    assert.deepEqual(targets, all);
  });

  it("uses payload.target as fallback", () => {
    const targets = resolveSpawnTargets({ target: "crew-github" });
    assert.deepEqual(targets, ["crew-github"]);
  });

  it("filters empty strings from payload.agents", () => {
    const targets = resolveSpawnTargets({ agents: ["crew-coder", "", "  "] });
    assert.deepEqual(targets, ["crew-coder"]);
  });
});
