import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(
  path.resolve("apps/crewchat/CrewChat.swift"),
  "utf8",
);

test("crewchat mode dropdown includes crew-lead, direct CLIs, and agent section", () => {
  assert.match(source, /modeSelector\.addItem\(withTitle:\s*"🧠 Crew Lead \(default\)"\)/);
  assert.match(source, /\("⚡ OpenCode", "cli:opencode"\)/);
  assert.match(source, /\("🖱 Cursor CLI", "cli:cursor"\)/);
  assert.match(source, /\("🔧 Crew CLI", "cli:crew-cli"\)/);
  assert.match(source, /\("🟣 Codex CLI", "cli:codex"\)/);
  assert.match(source, /\("✨ Gemini CLI", "cli:gemini"\)/);
  assert.match(source, /\("🤖 Claude Code", "cli:claude"\)/);
  assert.match(source, /title:\s*"───── Agents ─────"/);
});

test("crewchat model filtering respects engine families", () => {
  assert.match(source, /case "claude":[\s\S]*provider == "anthropic"[\s\S]*id\.contains\("claude"\)/);
  assert.match(source, /case "gemini":[\s\S]*provider == "google"[\s\S]*id\.contains\("gemini"\)/);
  assert.match(source, /case "codex":[\s\S]*provider == "openai"[\s\S]*id\.contains\("codex"\) \|\| id\.contains\("gpt-5"\)/);
  assert.match(source, /case "opencode", "cursor", "crew-cli":[\s\S]*featuredModels/);
});

test("crewchat fallback models cover Claude, Gemini, Codex, and a general fallback lane", () => {
  assert.match(source, /case "cli:claude":[\s\S]*claude-sonnet-4-5-20250929[\s\S]*claude-opus-4-1-20250805/);
  assert.match(source, /case "cli:gemini":[\s\S]*models\/gemini-2\.5-flash[\s\S]*models\/gemini-2\.5-pro/);
  assert.match(source, /case "cli:codex":[\s\S]*gpt-5-codex[\s\S]*gpt-5\.3-codex/);
  assert.match(source, /default:[\s\S]*grok-4-1-fast-reasoning[\s\S]*deepseek-chat[\s\S]*openai\/gpt-5\.3-codex[\s\S]*models\/gemini-2\.5-flash/);
});

test("crewchat engine labels expose direct API and CLI runtime identity", () => {
  assert.match(source, /if agentData\["useCursorCli"\] as\? Bool == true[\s\S]*return "Cursor CLI"/);
  assert.match(source, /else if agentData\["useClaudeCode"\] as\? Bool == true[\s\S]*return "Claude Code"/);
  assert.match(source, /else if agentData\["useCodex"\] as\? Bool == true[\s\S]*return "Codex CLI"/);
  assert.match(source, /else if agentData\["useGeminiCli"\] as\? Bool == true[\s\S]*return "Gemini CLI"/);
  assert.match(source, /else if agentData\["inOpenCode"\] as\? Bool == true[\s\S]*return "OpenCode"/);
  assert.match(source, /else \{[\s\S]*return "Direct API"/);
});

test("crewchat message source labels preserve source and agent identity", () => {
  assert.match(source, /let sourceEmoji: \[String: String\] = \[[\s\S]*"dashboard": "💻"[\s\S]*"cli": "⚡"[\s\S]*"sub-agent": "👷"[\s\S]*"agent": "🤖"/);
  assert.match(source, /if let agent, !agent\.isEmpty \{\s*return "\\\(emoji\) \\\(agent\)"/);
  assert.match(source, /if !source\.isEmpty \{\s*return "\\\(emoji\) \\\(source\)"/);
});
