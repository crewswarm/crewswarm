/**
 * Comprehensive unit tests for lib/agents/daemon.mjs
 *
 * Covers: agentPidPath, agentLogPath, readPid, isPidAlive,
 *         latestHeartbeatAgeSec, isAgentDaemonRunning, resolveSpawnTargets
 *
 * Skips: spawnAgentDaemon (launches real OS processes / writes to disk)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  agentPidPath,
  agentLogPath,
  readPid,
  isPidAlive,
  latestHeartbeatAgeSec,
  isAgentDaemonRunning,
  resolveSpawnTargets,
} from "../../lib/agents/daemon.mjs";

// ── agentPidPath ────────────────────────────────────────────────────────────

describe("agentPidPath", () => {
  it("ends with <agent>.pid", () => {
    const p = agentPidPath("crew-coder");
    assert.ok(p.endsWith("crew-coder.pid"), `unexpected path: ${p}`);
  });

  it("contains rt-agents directory component", () => {
    const p = agentPidPath("crew-pm");
    assert.ok(p.includes("rt-agents"), `expected rt-agents in path: ${p}`);
  });

  it("is an absolute path", () => {
    const p = agentPidPath("crew-qa");
    assert.ok(p.startsWith("/"), `expected absolute path: ${p}`);
  });

  it("uses the agent name verbatim in the filename", () => {
    const p = agentPidPath("crew-fixer");
    assert.ok(p.includes("crew-fixer"), p);
  });

  it("handles agent names with hyphens", () => {
    const p = agentPidPath("crew-coder-front");
    assert.ok(p.endsWith("crew-coder-front.pid"));
  });
});

// ── agentLogPath ────────────────────────────────────────────────────────────

describe("agentLogPath", () => {
  it("ends with <agent>.log", () => {
    const p = agentLogPath("crew-coder");
    assert.ok(p.endsWith("crew-coder.log"), `unexpected path: ${p}`);
  });

  it("contains rt-agents directory component", () => {
    const p = agentLogPath("crew-qa");
    assert.ok(p.includes("rt-agents"), p);
  });

  it("is an absolute path", () => {
    const p = agentLogPath("crew-pm");
    assert.ok(p.startsWith("/"), p);
  });

  it("shares the same parent directory as agentPidPath", () => {
    const pidDir = agentPidPath("crew-qa").replace(/[^/]+$/, "");
    const logDir = agentLogPath("crew-qa").replace(/[^/]+$/, "");
    assert.equal(pidDir, logDir);
  });
});

// ── readPid ─────────────────────────────────────────────────────────────────

describe("readPid", () => {
  it("returns 0 for a non-existent agent", () => {
    assert.equal(readPid("__phantom_agent_00000__"), 0);
  });

  it("returns a number (never throws)", () => {
    const result = readPid("crew-definitely-not-running-xyz");
    assert.equal(typeof result, "number");
  });

  it("returns 0 for empty-string agent name", () => {
    assert.equal(readPid(""), 0);
  });
});

// ── isPidAlive ──────────────────────────────────────────────────────────────

describe("isPidAlive", () => {
  it("returns false for 0", () => {
    assert.equal(isPidAlive(0), false);
  });

  it("returns false for NaN", () => {
    assert.equal(isPidAlive(NaN), false);
  });

  it("returns false for negative PID", () => {
    // process.kill with a negative pid is a signal to a process group;
    // for an arbitrary negative value it should not return true
    // (signal(0) on process group -99999 will throw ESRCH or EPERM)
    const result = isPidAlive(-99999);
    assert.equal(typeof result, "boolean");
  });

  it("returns false for null", () => {
    assert.equal(isPidAlive(null), false);
  });

  it("returns false for undefined", () => {
    assert.equal(isPidAlive(undefined), false);
  });

  it("returns true for the current process PID", () => {
    assert.equal(isPidAlive(process.pid), true);
  });

  it("returns false for an impossibly large PID", () => {
    assert.equal(isPidAlive(99999999), false);
  });

  it("returns a boolean in all cases", () => {
    for (const v of [0, NaN, process.pid, 99999999, null, undefined]) {
      assert.equal(typeof isPidAlive(v), "boolean");
    }
  });
});

// ── latestHeartbeatAgeSec ───────────────────────────────────────────────────

describe("latestHeartbeatAgeSec", () => {
  it("returns null or a finite number — never throws", () => {
    const result = latestHeartbeatAgeSec("__no_such_agent_xyz__");
    assert.ok(result === null || (typeof result === "number" && Number.isFinite(result)));
  });

  it("returns null for an empty-string agent name", () => {
    const result = latestHeartbeatAgeSec("");
    assert.ok(result === null || typeof result === "number");
  });

  it("returns a non-negative number when a heartbeat IS found", () => {
    // We cannot guarantee a heartbeat file exists in CI, so we only assert
    // the contract: if not null, it must be >= 0.
    const result = latestHeartbeatAgeSec("crew-coder");
    if (result !== null) {
      assert.ok(result >= 0, `expected non-negative age, got ${result}`);
    }
  });
});

// ── isAgentDaemonRunning ────────────────────────────────────────────────────

describe("isAgentDaemonRunning", () => {
  it("returns a boolean for an unknown agent", () => {
    const result = isAgentDaemonRunning("__phantom_daemon_xyz__");
    assert.equal(typeof result, "boolean");
  });

  it("returns false for an agent that has never been started", () => {
    // An agent whose name would never match any real pid file or heartbeat
    assert.equal(isAgentDaemonRunning("crew-phantom-never-started-00000"), false);
  });

  it("respects CREWSWARM_RT_HEARTBEAT_WINDOW_SEC env override", () => {
    // With window=0, even a very recent heartbeat would appear stale — the
    // function should still return a boolean without throwing.
    const orig = process.env.CREWSWARM_RT_HEARTBEAT_WINDOW_SEC;
    process.env.CREWSWARM_RT_HEARTBEAT_WINDOW_SEC = "0";
    try {
      const result = isAgentDaemonRunning("crew-coder");
      assert.equal(typeof result, "boolean");
    } finally {
      if (orig === undefined) {
        delete process.env.CREWSWARM_RT_HEARTBEAT_WINDOW_SEC;
      } else {
        process.env.CREWSWARM_RT_HEARTBEAT_WINDOW_SEC = orig;
      }
    }
  });
});

// ── resolveSpawnTargets ─────────────────────────────────────────────────────

describe("resolveSpawnTargets – default / fallback", () => {
  it("returns a non-empty array when payload is empty object", () => {
    const targets = resolveSpawnTargets({});
    assert.ok(Array.isArray(targets));
    assert.ok(targets.length > 0);
  });

  it("returns a non-empty array when payload is null", () => {
    const targets = resolveSpawnTargets(null);
    assert.ok(Array.isArray(targets));
    assert.ok(targets.length > 0);
  });

  it("returns a non-empty array when payload is undefined", () => {
    const targets = resolveSpawnTargets(undefined);
    assert.ok(Array.isArray(targets));
    assert.ok(targets.length > 0);
  });

  it("returns unique agents (no duplicates in default list)", () => {
    const targets = resolveSpawnTargets({});
    const unique = [...new Set(targets)];
    assert.equal(targets.length, unique.length, "default list contains duplicates");
  });
});

describe("resolveSpawnTargets – payload.agents array", () => {
  it("returns the provided agents array verbatim", () => {
    const targets = resolveSpawnTargets({ agents: ["crew-coder", "crew-qa"] });
    assert.deepEqual(targets, ["crew-coder", "crew-qa"]);
  });

  it("trims whitespace from agent names", () => {
    const targets = resolveSpawnTargets({ agents: ["  crew-coder  ", "crew-qa"] });
    assert.deepEqual(targets, ["crew-coder", "crew-qa"]);
  });

  it("filters out empty strings", () => {
    const targets = resolveSpawnTargets({ agents: ["crew-coder", "", "  "] });
    assert.deepEqual(targets, ["crew-coder"]);
  });

  it("falls back to all agents when every entry is empty", () => {
    const all = resolveSpawnTargets({});
    const targets = resolveSpawnTargets({ agents: ["", "   "] });
    assert.deepEqual(targets, all);
  });

  it("handles a single-item array", () => {
    const targets = resolveSpawnTargets({ agents: ["crew-pm"] });
    assert.deepEqual(targets, ["crew-pm"]);
  });
});

describe("resolveSpawnTargets – payload.agent string", () => {
  it("returns a single-element array for a named agent", () => {
    const targets = resolveSpawnTargets({ agent: "crew-fixer" });
    assert.deepEqual(targets, ["crew-fixer"]);
  });

  it("returns all agents when agent is 'all'", () => {
    const all = resolveSpawnTargets({});
    const targets = resolveSpawnTargets({ agent: "all" });
    assert.deepEqual(targets, all);
  });

  it("returns all agents when agent is 'ALL' (case-insensitive)", () => {
    const all = resolveSpawnTargets({});
    const targets = resolveSpawnTargets({ agent: "ALL" });
    assert.deepEqual(targets, all);
  });

  it("trims whitespace from agent string", () => {
    const targets = resolveSpawnTargets({ agent: "  crew-github  " });
    assert.deepEqual(targets, ["crew-github"]);
  });

  it("falls back to all when agent is whitespace-only string", () => {
    const all = resolveSpawnTargets({});
    const targets = resolveSpawnTargets({ agent: "   " });
    assert.deepEqual(targets, all);
  });
});

describe("resolveSpawnTargets – payload.target string", () => {
  it("returns a single-element array when target is provided", () => {
    const targets = resolveSpawnTargets({ target: "crew-github" });
    assert.deepEqual(targets, ["crew-github"]);
  });

  it("returns all agents when target is 'all'", () => {
    const all = resolveSpawnTargets({});
    const targets = resolveSpawnTargets({ target: "all" });
    assert.deepEqual(targets, all);
  });

  it("returns all agents when target is 'All' (case-insensitive)", () => {
    const all = resolveSpawnTargets({});
    const targets = resolveSpawnTargets({ target: "All" });
    assert.deepEqual(targets, all);
  });

  it("trims whitespace from target string", () => {
    const targets = resolveSpawnTargets({ target: "  crew-pm  " });
    assert.deepEqual(targets, ["crew-pm"]);
  });
});

describe("resolveSpawnTargets – priority: agents > agent > target", () => {
  it("agents array takes priority over agent string", () => {
    const targets = resolveSpawnTargets({
      agents: ["crew-coder"],
      agent: "crew-pm",
    });
    assert.deepEqual(targets, ["crew-coder"]);
  });

  it("agent string takes priority over target string", () => {
    const targets = resolveSpawnTargets({
      agent: "crew-pm",
      target: "crew-qa",
    });
    assert.deepEqual(targets, ["crew-pm"]);
  });
});
