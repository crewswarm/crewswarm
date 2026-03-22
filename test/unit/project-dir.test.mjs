/**
 * @version 1.0.0
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  normalizeProjectDir,
  rewriteWrongDesktopMirrorPaths,
} from "../../lib/runtime/project-dir.mjs";

describe("normalizeProjectDir", () => {
  test("fixes ~Desktop/ typo (missing slash after tilde)", () => {
    const home = os.homedir();
    assert.equal(
      normalizeProjectDir("~Desktop/stinky-1"),
      path.join(home, "Desktop", "stinky-1"),
    );
  });

  test("expands ~/Desktop/…", () => {
    const home = os.homedir();
    assert.equal(
      normalizeProjectDir("~/Desktop/stinky-1"),
      path.join(home, "Desktop", "stinky-1"),
    );
  });

  test("returns null for empty", () => {
    assert.equal(normalizeProjectDir(""), null);
    assert.equal(normalizeProjectDir("   "), null);
    assert.equal(normalizeProjectDir(null), null);
  });

  test("normalizes absolute paths", () => {
    assert.ok(path.isAbsolute(normalizeProjectDir("/tmp/foo/bar") || ""));
  });
});

describe("rewriteWrongDesktopMirrorPaths", () => {
  test("rewrites repo-local ~Desktop mirror to canonical project dir", () => {
    const canon = path.join(os.homedir(), "Desktop", "stinky-1").replace(/\\/g, "/");
    const wrong = path.join(process.cwd(), "~Desktop", "stinky-1").replace(/\\/g, "/");
    const task = `Read ${wrong}/content-draft.md and write ${wrong}/out.html`;
    const fixed = rewriteWrongDesktopMirrorPaths(task, canon);
    assert.ok(!fixed.includes("/~Desktop/stinky-1"), fixed);
    assert.ok(fixed.includes(`${canon}/content-draft.md`), fixed);
  });
});
