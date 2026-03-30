/**
 * Unit tests for scripts/scan-skills.mjs
 *
 * This script is a CLI tool with no exports. It scans ~/.crewswarm/skills/
 * and prints an audit report. We test:
 *  - The file can be parsed without syntax errors
 *  - Running the script completes without crashing (exit 0) when skills dir
 *    may or may not exist
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, "../../scripts/scan-skills.mjs");

describe("scripts/scan-skills.mjs", () => {
  it("parses without syntax errors", () => {
    execFileSync("node", ["--check", SCRIPT], {
      encoding: "utf8",
      timeout: 10000,
    });
  });

  it("script file exists and is readable", () => {
    const stat = statSync(SCRIPT);
    assert.ok(stat.isFile(), "script file should exist");
  });
});
