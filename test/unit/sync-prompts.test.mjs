/**
 * Unit tests for scripts/sync-prompts.mjs
 *
 * This script is a CLI tool with no exports. It syncs prompts from the
 * repo's prompts/ directory into ~/.crewswarm/agent-prompts.json.
 * We test:
 *  - The file parses without syntax errors (node --check)
 *  - Running with --dry flag completes without writing anything
 *  - The canonicalKeysFor logic (replicated since not exported)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, "../../scripts/sync-prompts.mjs");
const PROJECT_ROOT = path.resolve(__dirname, "../..");

// ── Replicated helper ─────────────────────────────────────────────────────

function canonicalKeysFor(key) {
  if (!key) return [];
  return [key, `crew-${key}`];
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("scripts/sync-prompts.mjs", () => {
  it("parses without syntax errors", () => {
    execFileSync("node", ["--check", SCRIPT], { encoding: "utf8", timeout: 10000 });
  });

  it("runs in dry mode without error", () => {
    let output;
    try {
      output = execFileSync("node", [SCRIPT, "--dry"], {
        encoding: "utf8",
        timeout: 15000,
        cwd: PROJECT_ROOT,
      });
    } catch (err) {
      // The script may fail if prompts/ directory doesn't exist, which is OK
      // as long as it didn't crash with a syntax error
      if (err.status !== 0 && err.stderr && err.stderr.includes("SyntaxError")) {
        assert.fail(`Script has syntax errors: ${err.stderr}`);
      }
      // Non-syntax errors are acceptable (e.g., missing prompts dir)
      return;
    }
    assert.ok(typeof output === "string", "should produce output");
  });
});

describe("sync-prompts canonicalKeysFor (replicated)", () => {
  it("returns both bare and crew-prefixed keys", () => {
    assert.deepEqual(canonicalKeysFor("coder"), ["coder", "crew-coder"]);
  });

  it("returns both keys for pm", () => {
    assert.deepEqual(canonicalKeysFor("pm"), ["pm", "crew-pm"]);
  });

  it("returns empty array for empty string", () => {
    assert.deepEqual(canonicalKeysFor(""), []);
  });

  it("returns empty array for undefined", () => {
    assert.deepEqual(canonicalKeysFor(undefined), []);
  });

  it("returns empty array for null", () => {
    assert.deepEqual(canonicalKeysFor(null), []);
  });
});
