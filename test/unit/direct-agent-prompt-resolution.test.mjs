/**
 * Direct sub-agent chat loads system text from ~/.crewswarm/agent-prompts.json
 * (see lib/crew-lead/http-server.mjs buildDirectChatContext).
 * Shipped defaults live in config/agent-prompts.json — every agent in the default
 * install roster should resolve to a non-fallback prompt so direct chat matches expectations.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..", "..");
const bundledPromptsPath = path.join(repoRoot, "config", "agent-prompts.json");
const bundled = JSON.parse(fs.readFileSync(bundledPromptsPath, "utf8"));

/** Same resolution as http-server buildDirectChatContext (base prompt only). */
function resolveBundledBasePrompt(agentId) {
  const bareId = String(agentId || "").replace(/^crew-/, "");
  return bundled[agentId] || bundled[bareId] || null;
}

/** Agent IDs from install.sh default crewswarm.json (normalized to crew-* RT ids). */
const DEFAULT_INSTALL_AGENT_IDS = [
  "crew-lead",
  "crew-main",
  "crew-pm",
  "crew-pm-cli",
  "crew-pm-frontend",
  "crew-pm-core",
  "crew-coder",
  "crew-coder-front",
  "crew-coder-back",
  "crew-frontend",
  "crew-qa",
  "crew-fixer",
  "crew-security",
  "crew-github",
  "crew-copywriter",
  "crew-seo",
  "crew-researcher",
  "crew-mega",
  "crew-architect",
  "crew-ml",
  "crew-orchestrator",
  "crew-judge",
];

test("bundled agent-prompts.json resolves every default-install agent id", () => {
  const missing = [];
  for (const id of DEFAULT_INSTALL_AGENT_IDS) {
    const base = resolveBundledBasePrompt(id);
    if (!base || typeof base !== "string" || !base.trim()) {
      missing.push(id);
      continue;
    }
    assert.ok(
      base.length > 20,
      `${id}: prompt too short — likely placeholder`,
    );
  }
  assert.deepEqual(
    missing,
    [],
    `Add keys for full id or bare id (after crew-): ${missing.join(", ")}`,
  );
});

test("crew-ml resolves via bare id 'ml' (not crew-ml key required)", () => {
  const base = resolveBundledBasePrompt("crew-ml");
  assert.ok(base, "crew-ml should resolve");
  assert.match(base, /crew-ml/i);
});

test("crew-main resolves via bare id 'main'", () => {
  const base = resolveBundledBasePrompt("crew-main");
  assert.ok(base, "crew-main should resolve");
  assert.match(base, /Quill|crew-main|coordinator/i);
});
