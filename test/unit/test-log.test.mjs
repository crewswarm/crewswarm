import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewswarm-test-log-"));
process.env.TEST_RESULTS_DIR = tmpDir;

const {
  logTestEvidence,
  detectProviderFromModel,
  getCliEngineMetadata,
  getAgentRuntimeMetadata,
  logHttpInteraction,
} = await import("../../test/helpers/test-log.mjs");

const {
  buildSelector,
  classifyFailure,
  classifySkip,
} = await import("../../scripts/test-reporter.mjs");

describe("test log helpers", () => {
  const logPath = path.join(tmpDir, "test-log.jsonl");
  const currentRunPath = path.join(tmpDir, ".current-run.json");
  const configPath = path.join(tmpDir, "crewswarm.json");

  beforeEach(() => {
    fs.writeFileSync(currentRunPath, JSON.stringify({ runId: "unit-test-run" }) + "\n");
    fs.rmSync(logPath, { force: true });
  });

  afterEach(() => {
    fs.rmSync(configPath, { force: true });
  });

  it("detectProviderFromModel infers provider prefixes", () => {
    assert.equal(detectProviderFromModel("openai/gpt-5.2"), "openai");
    assert.equal(detectProviderFromModel("claude-sonnet-4"), "anthropic");
    assert.equal(detectProviderFromModel("google/models/gemini-2.5-flash"), "google");
  });

  it("logTestEvidence appends JSONL entries with current run metadata", () => {
    const entry = logTestEvidence({ category: "unit", test: "writes entry" });
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].runId, "unit-test-run");
    assert.equal(lines[0].entry_type, "evidence");
    assert.equal(entry.test, "writes entry");
  });

  it("logHttpInteraction redacts authorization headers", () => {
    logHttpInteraction({
      test: "http trace",
      file: import.meta.filename,
      operation: "GET /health",
      url: "http://127.0.0.1:4319/health",
      method: "GET",
      timeout_ms: 5000,
      status: 200,
      duration_ms: 25,
      request_headers: { authorization: "Bearer secret", "x-test": "ok" },
      response_body: { ok: true },
    });
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines[0].request_headers.authorization, "[redacted]");
    assert.equal(lines[0].request_headers["x-test"], "ok");
  });

  it("getAgentRuntimeMetadata loads agent model, provider, and route flags", () => {
    fs.writeFileSync(configPath, JSON.stringify({
      agents: [
        {
          id: "crew-coder",
          model: "openai/gpt-5.2",
          useCodex: true,
          useCursorCli: false,
          useGeminiCli: false,
          useOpenCode: false,
          useCrewCLI: false,
        },
      ],
    }, null, 2));
    const meta = getAgentRuntimeMetadata("crew-coder", configPath);
    assert.equal(meta.model, "openai/gpt-5.2");
    assert.equal(meta.provider, "openai");
    assert.equal(meta.enabledRoute, "useCodex");
    assert.equal(meta.routeFlags.useCodex, true);
  });

  it("getCliEngineMetadata returns provider metadata for known engines", () => {
    const meta = getCliEngineMetadata("codex");
    assert.equal(meta.provider, "openai");
    assert.equal(meta.engine, "codex");
    assert.ok("binary" in meta);
  });

  it("buildSelector creates a one-by-one rerun command", () => {
    const selector = buildSelector("/repo/test/e2e/example.test.mjs", "engine times out");
    assert.equal(selector.file, "/repo/test/e2e/example.test.mjs");
    assert.equal(selector.test_name, "engine times out");
    assert.match(selector.command, /--test-name-pattern='engine times out'/);
    assert.match(selector.command, /example\.test\.mjs'/);
  });

  it("classifyFailure detects timeout and agent connectivity failures", () => {
    const timeout = classifyFailure(
      { error: "Passthrough timeout after 120s", error_name: "Error" },
      {}
    );
    assert.equal(timeout.reason_code, "timeout");

    const unreachable = classifyFailure(
      { error: "RT bus not connected - agent unreachable", error_name: "Error" },
      {}
    );
    assert.equal(unreachable.reason_code, "agent_unreachable");
  });

  it("classifySkip detects service and engine availability skips", () => {
    const service = classifySkip({ skip_reason: "crew-lead not running on :5010" });
    assert.equal(service.reason_code, "service_down");

    const engine = classifySkip({ skip_reason: "Claude Code not available" });
    assert.equal(engine.reason_code, "engine_unavailable");
  });
});
