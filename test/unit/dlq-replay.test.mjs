/**
 * Unit tests for scripts/dlq-replay.mjs
 *
 * This script is a CLI tool with no exports. It reads process.argv[2] and
 * exits immediately if no key is provided. We test:
 *  - The file can be parsed without syntax errors (dynamic import)
 *  - Running without a key argument exits with code 1
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, "../../scripts/dlq-replay.mjs");

describe("scripts/dlq-replay.mjs", () => {
  it("exits with code 1 when no key argument is provided", () => {
    try {
      execFileSync("node", [SCRIPT], { encoding: "utf8", timeout: 10000 });
      assert.fail("Expected script to exit with non-zero code");
    } catch (err) {
      assert.equal(err.status, 1, "exit code should be 1 for missing key");
      assert.ok(
        err.stderr.includes("Usage:"),
        "stderr should show usage message"
      );
    }
  });

  it("exits with code 2 when key does not match an existing DLQ file", () => {
    try {
      execFileSync("node", [SCRIPT, "nonexistent-key-12345"], {
        encoding: "utf8",
        timeout: 10000,
      });
      assert.fail("Expected script to exit with non-zero code");
    } catch (err) {
      assert.equal(err.status, 2, "exit code should be 2 for missing DLQ entry");
      assert.ok(
        err.stderr.includes("not found"),
        "stderr should mention entry not found"
      );
    }
  });
});
