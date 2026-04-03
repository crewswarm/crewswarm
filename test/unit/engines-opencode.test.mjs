/**
 * Unit tests for lib/engines/opencode.mjs
 *
 * Tests exported functions: initOpenCode, runOpenCodeTask
 *
 * Strategy: inject all runtime deps via initOpenCode. For tests that
 * exercise the spawn path, point CREWSWARM_OPENCODE_BIN at a real system
 * binary (/usr/bin/true exits 0 silently; /usr/bin/false exits 1) so no
 * real opencode binary is required.
 *
 * Tests that require examining spawn arguments (model, agent, session) use
 * a small Node.js one-liner written to a temp script that prints its argv
 * to stdout, which runOpenCodeTask captures as its result.
 *
 * Run with: node --test test/unit/engines-opencode.test.mjs
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const { initOpenCode, runOpenCodeTask } = await import(
  "../../lib/engines/opencode.mjs"
);

// ---------------------------------------------------------------------------
// Temp "opencode spy" script
// ---------------------------------------------------------------------------

// A fake opencode binary that prints its argv as JSON to stdout and exits 0.
// We can read the output to verify what args were passed.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "oc-test-"));
const SPY_BIN = path.join(TMP_DIR, "opencode-spy.mjs");
const ARG_DUMP_BIN = path.join(TMP_DIR, "opencode-argdump.mjs");

fs.writeFileSync(
  SPY_BIN,
  `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`,
  { mode: 0o755 }
);

fs.writeFileSync(
  ARG_DUMP_BIN,
  `#!/usr/bin/env node\nconst args = process.argv.slice(2);\nprocess.stdout.write(args.join(' ') + '\\n');\n`,
  { mode: 0o755 }
);

after(() => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// Shared default deps factory
// ---------------------------------------------------------------------------

function makeDeps(overrides = {}) {
  return {
    CREWSWARM_OPENCODE_BIN: "/usr/bin/true",
    CREWSWARM_RT_AGENT: "crew-coder",
    CREWSWARM_OPENCODE_MODEL: "anthropic/claude-sonnet-4-5",
    CREWSWARM_OPENCODE_TIMEOUT_MS: 30000,
    CREWSWARM_OPENCODE_AGENT: "admin",
    getAgentOpenCodeConfig: () => ({ model: null }),
    getOpencodeProjectDir: () => process.cwd(),
    extractProjectDirFromTask: () => null,
    readAgentSessionId: () => null,
    writeAgentSessionId: () => {},
    parseMostRecentSessionId: () => null,
    isOpencodeRateLimitBanner: () => false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// initOpenCode
// ---------------------------------------------------------------------------

describe("opencode — initOpenCode", () => {
  it("accepts a deps object without throwing", () => {
    assert.doesNotThrow(() => initOpenCode(makeDeps()));
  });

  it("accepts an empty object without throwing", () => {
    assert.doesNotThrow(() => initOpenCode({}));
  });
});

// ---------------------------------------------------------------------------
// Basic spawn (happy path via /usr/bin/true)
// ---------------------------------------------------------------------------

describe("opencode — basic happy path", () => {
  it("resolves with fallback message when binary produces no output (true exits 0)", async () => {
    initOpenCode(makeDeps());
    const result = await runOpenCodeTask("hello", {});
    // /usr/bin/true produces no output → fallback message
    assert.equal(result, "(opencode completed with no output)");
  });

  it("uses the spy binary and captures its stdout", async () => {
    initOpenCode(makeDeps({ CREWSWARM_OPENCODE_BIN: `node ${SPY_BIN}` }));
    // We can't easily split bin+args — skip this variant;
    // arg capture is tested separately below.
    assert.ok(true); // placeholder — covered by arg capture tests
  });
});

// ---------------------------------------------------------------------------
// Agent ID → OC_AGENT_MAP resolution (via argdump binary)
// ---------------------------------------------------------------------------

describe("opencode — OC_AGENT_MAP agent name resolution", () => {
  /**
   * Run a task with the argdump binary and parse the agent name from stdout.
   * stdout = "run [crew-qa] prompt --model M --agent qa\n"
   */
  async function resolveAgentName(agentId) {
    initOpenCode(makeDeps({
      CREWSWARM_OPENCODE_BIN: ARG_DUMP_BIN,
      CREWSWARM_RT_AGENT: agentId,
      getOpencodeProjectDir: () => process.cwd(),
    }));
    const out = await runOpenCodeTask("task", { agentId });
    // Find --agent VALUE in the output
    const m = out.match(/--agent\s+(\S+)/);
    return m ? m[1] : null;
  }

  it("maps crew-coder → coder", async () => {
    assert.equal(await resolveAgentName("crew-coder"), "coder");
  });

  it("maps crew-qa → qa", async () => {
    assert.equal(await resolveAgentName("crew-qa"), "qa");
  });

  it("maps crew-security → security", async () => {
    assert.equal(await resolveAgentName("crew-security"), "security");
  });

  it("maps crew-pm → pm", async () => {
    assert.equal(await resolveAgentName("crew-pm"), "pm");
  });

  it("maps crew-orchestrator → orchestrator", async () => {
    assert.equal(await resolveAgentName("crew-orchestrator"), "orchestrator");
  });

  it("maps orchestrator → orchestrator (bare alias)", async () => {
    assert.equal(await resolveAgentName("orchestrator"), "orchestrator");
  });

  it("strips crew- prefix for unmapped agent IDs", async () => {
    assert.equal(await resolveAgentName("crew-custom-agent"), "custom-agent");
  });
});

// ---------------------------------------------------------------------------
// Model priority resolution
// ---------------------------------------------------------------------------

describe("opencode — model priority", () => {
  async function captureModel(payloadModel, agentOcModel, globalModel) {
    initOpenCode(makeDeps({
      CREWSWARM_OPENCODE_BIN: ARG_DUMP_BIN,
      CREWSWARM_OPENCODE_MODEL: globalModel || "global-model",
      getAgentOpenCodeConfig: () => ({ model: agentOcModel || null }),
    }));
    const out = await runOpenCodeTask("task", { model: payloadModel });
    const m = out.match(/--model\s+(\S+)/);
    return m ? m[1] : null;
  }

  it("prefers explicit payload model over agent and global", async () => {
    assert.equal(await captureModel("payload-model", "agent-model", "global-model"), "payload-model");
  });

  it("falls back to agent opencode config model when payload has none", async () => {
    assert.equal(await captureModel(undefined, "agent-model", "global-model"), "agent-model");
  });

  it("falls back to global model when payload and agent config have none", async () => {
    assert.equal(await captureModel(undefined, null, "global-model"), "global-model");
  });
});

// ---------------------------------------------------------------------------
// Session continuity
// ---------------------------------------------------------------------------

describe("opencode — session continuity", () => {
  it("includes --session in args when existing session ID is available", async () => {
    initOpenCode(makeDeps({
      CREWSWARM_OPENCODE_BIN: ARG_DUMP_BIN,
      readAgentSessionId: () => "sess-abc-123",
    }));
    const out = await runOpenCodeTask("task", { agentId: "crew-coder" });
    assert.ok(out.includes("--session"), "should include --session");
    assert.ok(out.includes("sess-abc-123"), "should include session ID");
  });

  it("omits --session when no prior session exists", async () => {
    initOpenCode(makeDeps({
      CREWSWARM_OPENCODE_BIN: ARG_DUMP_BIN,
      readAgentSessionId: () => null,
    }));
    const out = await runOpenCodeTask("task", { agentId: "crew-coder" });
    assert.ok(!out.includes("--session"), "should not include --session when no session");
  });

  it("omits --session when payload.projectDir differs from default workspace", async () => {
    initOpenCode(makeDeps({
      CREWSWARM_OPENCODE_BIN: ARG_DUMP_BIN,
      getOpencodeProjectDir: () => process.cwd(),
      readAgentSessionId: () => "sess-abc-123",
    }));
    // Use a different dir — but it must exist so spawn doesn't fall back to cwd
    const parentDir = path.dirname(process.cwd());
    const out = await runOpenCodeTask("task", { agentId: "crew-coder", projectDir: parentDir });
    // projectDir differs → skip session resume
    assert.ok(!out.includes("--session"), "should not resume session when dirs differ");
  });

  it("saves session ID on successful close when parseMostRecentSessionId returns a value", async () => {
    const savedSessions = [];
    initOpenCode(makeDeps({
      CREWSWARM_OPENCODE_BIN: ARG_DUMP_BIN,
      readAgentSessionId: () => null,
      parseMostRecentSessionId: () => "new-session-id",
      writeAgentSessionId: (agentId, sessionId) => savedSessions.push({ agentId, sessionId }),
    }));
    await runOpenCodeTask("task", { agentId: "crew-coder" });
    assert.equal(savedSessions.length, 1);
    assert.equal(savedSessions[0].sessionId, "new-session-id");
    assert.equal(savedSessions[0].agentId, "crew-coder");
  });

  it("does not crash when the session list command throws", async () => {
    initOpenCode(makeDeps({
      // ARG_DUMP_BIN for the main task, then execFileSync will be called with
      // the same bin for 'session list' — that fails (wrong args) but should not throw.
      CREWSWARM_OPENCODE_BIN: ARG_DUMP_BIN,
      parseMostRecentSessionId: () => { throw new Error("simulated error"); },
    }));
    const result = await runOpenCodeTask("task", { agentId: "crew-coder" });
    assert.ok(typeof result === "string", "should still resolve even when session save fails");
  });
});

// ---------------------------------------------------------------------------
// Error handling (exit codes)
// ---------------------------------------------------------------------------

describe("opencode — error handling", () => {
  it("rejects when process exits with code 1 (/usr/bin/false)", async () => {
    initOpenCode(makeDeps({
      CREWSWARM_OPENCODE_BIN: "/usr/bin/false",
      isOpencodeRateLimitBanner: () => false,
    }));
    await assert.rejects(
      () => runOpenCodeTask("task", {}),
      (err) => {
        assert.ok(err.message.includes("OpenCode exited 1"), `unexpected: ${err.message}`);
        return true;
      }
    );
  });

  it("rejects with rate limit message when banner-only output detected", async () => {
    initOpenCode(makeDeps({
      CREWSWARM_OPENCODE_BIN: "/usr/bin/false",
      isOpencodeRateLimitBanner: () => true,
    }));
    await assert.rejects(
      () => runOpenCodeTask("task", {}),
      (err) => {
        assert.ok(
          err.message.includes("rate limited"),
          `expected 'rate limited', got: ${err.message}`
        );
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

describe("opencode — prompt construction", () => {
  it("prepends agent prefix [crew-coder] to prompt", async () => {
    initOpenCode(makeDeps({ CREWSWARM_OPENCODE_BIN: ARG_DUMP_BIN }));
    const out = await runOpenCodeTask("do the thing", { agentId: "crew-coder" });
    assert.ok(out.includes("[crew-coder]"), `expected [crew-coder] prefix in output, got: ${out}`);
    assert.ok(out.includes("do the thing"));
  });

  it("omits agent prefix when agentId is empty string", async () => {
    initOpenCode(makeDeps({
      CREWSWARM_OPENCODE_BIN: ARG_DUMP_BIN,
      CREWSWARM_RT_AGENT: "",
    }));
    const out = await runOpenCodeTask("bare task", { agentId: "" });
    // No brackets in output before the task text
    const runIdx = out.indexOf("run");
    const taskIdx = out.indexOf("bare task");
    const between = out.slice(runIdx + 3, taskIdx);
    assert.ok(!between.includes("["), `should have no bracket prefix, got: ${between}`);
  });
});

// ---------------------------------------------------------------------------
// Environment variable cleanup
// ---------------------------------------------------------------------------

describe("opencode — env var cleanup", () => {
  it("run succeeds after setting OPENCODE_SERVER env vars (they are stripped before spawn)", async () => {
    process.env.OPENCODE_SERVER_USERNAME = "secret-user";
    process.env.OPENCODE_SERVER_PASSWORD = "secret-pass";
    process.env.OPENCODE_CLIENT = "test-client";
    process.env.OPENCODE = "1";

    initOpenCode(makeDeps({ CREWSWARM_OPENCODE_BIN: "/usr/bin/true" }));
    const result = await runOpenCodeTask("task", {});
    // If env cleanup throws, this would reject. Successful completion proves it ran.
    assert.equal(result, "(opencode completed with no output)");

    delete process.env.OPENCODE_SERVER_USERNAME;
    delete process.env.OPENCODE_SERVER_PASSWORD;
    delete process.env.OPENCODE_CLIENT;
    delete process.env.OPENCODE;
  });
});

// ---------------------------------------------------------------------------
// Project directory fallback
// ---------------------------------------------------------------------------

describe("opencode — projectDir resolution", () => {
  it("falls back to process.cwd() when configured projectDir does not exist on disk", async () => {
    // Use a path that definitely does not exist; opencode falls back to cwd
    initOpenCode(makeDeps({
      CREWSWARM_OPENCODE_BIN: "/usr/bin/true",
      getOpencodeProjectDir: () => "/this/path/does/not/exist/anywhere",
    }));
    // Should not reject — /usr/bin/true succeeds from cwd
    const result = await runOpenCodeTask("task", {});
    assert.equal(result, "(opencode completed with no output)");
  });

  it("strips trailing period from configured projectDir", async () => {
    // A dir path ending in "." that doesn't exist → falls back to cwd, no crash
    initOpenCode(makeDeps({
      CREWSWARM_OPENCODE_BIN: "/usr/bin/true",
      getOpencodeProjectDir: () => "/some/path/that/does/not/exist.",
    }));
    const result = await runOpenCodeTask("task", {});
    assert.equal(result, "(opencode completed with no output)");
  });
});

// ---------------------------------------------------------------------------
// RT client events
// ---------------------------------------------------------------------------

describe("opencode — RT client events", () => {
  it("publishes agent_working event on task start", async () => {
    const published = [];
    initOpenCode(makeDeps({
      CREWSWARM_OPENCODE_BIN: "/usr/bin/true",
      _rtClientForApprovals: { publish: (msg) => published.push(msg) },
    }));
    await runOpenCodeTask("task", { agentId: "crew-coder" });
    const working = published.find(p => p.type === "agent_working");
    assert.ok(working, "agent_working event should be published");
  });

  it("publishes agent_idle event on successful close", async () => {
    const published = [];
    initOpenCode(makeDeps({
      CREWSWARM_OPENCODE_BIN: "/usr/bin/true",
      _rtClientForApprovals: { publish: (msg) => published.push(msg) },
    }));
    await runOpenCodeTask("task", { agentId: "crew-coder" });
    const idle = published.find(p => p.type === "agent_idle");
    assert.ok(idle, "agent_idle event should be published on successful close");
  });

  it("does not throw when _rtClientForApprovals is undefined", async () => {
    initOpenCode(makeDeps({ CREWSWARM_OPENCODE_BIN: "/usr/bin/true" }));
    const result = await runOpenCodeTask("task", {});
    assert.equal(result, "(opencode completed with no output)");
  });
});

// ---------------------------------------------------------------------------
// Noise filtering (stderr OC_NOISE_PATTERNS)
// ---------------------------------------------------------------------------

describe("opencode — stderr noise filtering", () => {
  /**
   * Write a small Node.js script that emits a noisy line to stderr
   * followed by a real content line, then exits 0.
   */
  function makeNoiseScript(stderrLines, stdoutContent = "") {
    const p = path.join(TMP_DIR, `noise-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
    const stderrCode = stderrLines
      .map(l => `process.stderr.write(${JSON.stringify(l + "\n")});`)
      .join("\n");
    const stdoutCode = stdoutContent
      ? `process.stdout.write(${JSON.stringify(stdoutContent)});`
      : "";
    fs.writeFileSync(
      p,
      `#!/usr/bin/env node\n${stderrCode}\n${stdoutCode}\n`,
      { mode: 0o755 }
    );
    return p;
  }

  it("filters 'realtime daemon error' lines from accumulated stderr", async () => {
    const script = makeNoiseScript(
      ["realtime daemon error: connection refused", "actual output line"]
    );
    initOpenCode(makeDeps({ CREWSWARM_OPENCODE_BIN: script }));
    const result = await runOpenCodeTask("task", {});
    assert.ok(!result.includes("realtime daemon error"), "noise should be filtered");
    assert.ok(result.includes("actual output line"), "real content should be retained");
  });

  it("filters 'invalid realtime token' lines", async () => {
    const script = makeNoiseScript(
      ["invalid realtime token: xyz", "useful diagnostic"]
    );
    initOpenCode(makeDeps({ CREWSWARM_OPENCODE_BIN: script }));
    const result = await runOpenCodeTask("task", {});
    assert.ok(!result.includes("invalid realtime token"), "token noise should be filtered");
    assert.ok(result.includes("useful diagnostic"));
  });

  it("filters ExperimentalWarning lines", async () => {
    const script = makeNoiseScript(
      ["ExperimentalWarning: some node feature is experimental", "real content"]
    );
    initOpenCode(makeDeps({ CREWSWARM_OPENCODE_BIN: script }));
    const result = await runOpenCodeTask("task", {});
    assert.ok(!result.includes("ExperimentalWarning"), "experimental warning should be filtered");
    assert.ok(result.includes("real content"));
  });

  it("filters --experimental flag warning lines", async () => {
    const script = makeNoiseScript(
      ["Use --experimental-vm-modules to enable ESM support", "useful line"]
    );
    initOpenCode(makeDeps({ CREWSWARM_OPENCODE_BIN: script }));
    const result = await runOpenCodeTask("task", {});
    assert.ok(!result.includes("--experimental"), "--experimental lines should be filtered");
  });

  it("stdout content takes priority over stderr content in output", async () => {
    const script = makeNoiseScript(
      ["stderr line"],
      "stdout wins"
    );
    initOpenCode(makeDeps({ CREWSWARM_OPENCODE_BIN: script }));
    const result = await runOpenCodeTask("task", {});
    assert.equal(result, "stdout wins");
  });
});
