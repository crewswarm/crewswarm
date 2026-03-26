import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";

import { buildCLICommand } from "../../lib/bridges/cli-executor.mjs";

test("buildCLICommand uses non-interactive cursor flags", () => {
  const result = buildCLICommand("cursor", "inspect this", "sonnet-4.5", "/tmp");
  assert.equal(result.bin, process.env.CURSOR_CLI_BIN || `${homedir()}/.local/bin/agent`);
  assert.deepEqual(result.args, [
    "--print",
    "--yolo",
    "--model",
    "sonnet-4.5",
    "inspect this",
  ]);
});

test("buildCLICommand maps provider model strings to Cursor default (composer-2-fast)", () => {
  const result = buildCLICommand(
    "cursor",
    "inspect this",
    "anthropic/claude-sonnet-4-5",
    "/tmp",
  );
  assert.deepEqual(result.args.slice(0, 4), [
    "--print",
    "--yolo",
    "--model",
    process.env.CREWSWARM_CURSOR_MODEL || "composer-2-fast",
  ]);
  assert.equal(result.args[4], "inspect this");
});

test("buildCLICommand uses skip-permissions for claude", () => {
  const result = buildCLICommand("claude", "inspect this", "sonnet", "/tmp/project");
  assert.deepEqual(result.args, [
    "-p",
    "--dangerously-skip-permissions",
    "--output-format",
    "stream-json",
    "--verbose",
    "--add-dir",
    "/tmp/project",
    "--model",
    "sonnet",
    "inspect this",
  ]);
  assert.equal(result.cwd, "/tmp");
});

test("buildCLICommand uses crew chat json mode for crew-cli", () => {
  const result = buildCLICommand(
    "crew-cli",
    "inspect this",
    "groq/llama-3.3-70b-versatile",
    "/tmp/project",
  );
  assert.equal(result.bin, process.env.CREW_CLI_BIN || "crew");
  assert.deepEqual(result.args, [
    "chat",
    "inspect this",
    "--json",
    "--apply",
    "--model",
    "groq/llama-3.3-70b-versatile",
    "--project",
    "/tmp/project",
  ]);
  assert.equal(result.cwd, "/tmp/project");
});

test("buildCLICommand uses yolo mode for gemini", () => {
  const result = buildCLICommand("gemini", "inspect this", "gemini-2.5-pro", "/tmp");
  assert.deepEqual(result.args, [
    "-m",
    "gemini-2.5-pro",
    "-p",
    "inspect this",
    "--yolo",
  ]);
});

test("buildCLICommand uses -m for opencode", () => {
  const result = buildCLICommand("opencode", "inspect this", "opencode/big-pickle", "/tmp");
  assert.deepEqual(result.args, ["run", "-m", "opencode/big-pickle", "inspect this"]);
});
