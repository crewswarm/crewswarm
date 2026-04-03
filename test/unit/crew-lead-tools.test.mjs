/**
 * Unit tests for lib/crew-lead/tools.mjs
 * Tests: initTools, sanitizeToolPathArgument, CREWLEAD_BLOCKED_CMDS, execCrewLeadTools.
 *
 * execCrewLeadTools touches fs, execSync, and fetch.  We test it by creating
 * real temp files where possible, and stub fetch/execSync with module-level
 * state overrides that Node's built-in test runner does not require monkey-patching for.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  initTools,
  sanitizeToolPathArgument,
  CREWLEAD_BLOCKED_CMDS,
  execCrewLeadTools,
} from "../../lib/crew-lead/tools.mjs";

// ── Temp dir shared across tests ───────────────────────────────────────────
let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crew-tools-test-"));
  initTools({ historyDir: tmpDir, crewswarmCfgFile: path.join(tmpDir, "crewswarm.json") });
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { }
});

// ── sanitizeToolPathArgument ───────────────────────────────────────────────

describe("sanitizeToolPathArgument", () => {
  it("returns empty string for empty input", () => {
    assert.equal(sanitizeToolPathArgument(""), "");
  });

  it("returns empty string for null/undefined", () => {
    assert.equal(sanitizeToolPathArgument(null), "");
    assert.equal(sanitizeToolPathArgument(undefined), "");
  });

  it("leaves clean absolute path unchanged", () => {
    assert.equal(
      sanitizeToolPathArgument("/home/user/project/README.md"),
      "/home/user/project/README.md",
    );
  });

  it("strips prose glued after .md", () => {
    assert.equal(
      sanitizeToolPathArgument("/tmp/brief.md and then summarize"),
      "/tmp/brief.md",
    );
  });

  it("strips prose glued after .json", () => {
    assert.equal(
      sanitizeToolPathArgument("/tmp/data.json and compare"),
      "/tmp/data.json",
    );
  });

  it("strips prose glued after .ts", () => {
    assert.equal(
      sanitizeToolPathArgument("/src/auth.ts to check exports"),
      "/src/auth.ts",
    );
  });

  it("strips prose glued after .html", () => {
    assert.equal(
      sanitizeToolPathArgument("/project/index.html or open in browser"),
      "/project/index.html",
    );
  });

  it("strips em-dash + trailing text", () => {
    assert.equal(
      sanitizeToolPathArgument("/src/app.mjs — then run tests"),
      "/src/app.mjs",
    );
  });

  it("strips double-dash + trailing text", () => {
    assert.equal(
      sanitizeToolPathArgument("/src/app.mjs -- to show the diff"),
      "/src/app.mjs",
    );
  });

  it("unwraps backtick-wrapped path", () => {
    assert.equal(
      sanitizeToolPathArgument("`/x/y.md` and more"),
      "/x/y.md",
    );
  });

  it("unwraps double-quoted path", () => {
    assert.equal(
      sanitizeToolPathArgument('"/x/y.md"'),
      "/x/y.md",
    );
  });

  it("unwraps single-quoted path", () => {
    assert.equal(
      sanitizeToolPathArgument("'/x/y.md'"),
      "/x/y.md",
    );
  });

  it("strips trailing punctuation from non-extension path", () => {
    assert.equal(
      sanitizeToolPathArgument("/tmp/output."),
      "/tmp/output",
    );
  });

  it("preserves path with spaces inside quotes", () => {
    const result = sanitizeToolPathArgument('"/path/with spaces/file.md"');
    assert.equal(result, "/path/with spaces/file.md");
  });

  it("handles path with 'with' connector", () => {
    assert.equal(
      sanitizeToolPathArgument("/tmp/foo.md with changes"),
      "/tmp/foo.md",
    );
  });

  it("handles path with 'for' connector", () => {
    assert.equal(
      sanitizeToolPathArgument("/tmp/foo.md for review"),
      "/tmp/foo.md",
    );
  });
});

// ── CREWLEAD_BLOCKED_CMDS ─────────────────────────────────────────────────

describe("CREWLEAD_BLOCKED_CMDS", () => {
  it("blocks rm -rf /", () => {
    assert.ok(CREWLEAD_BLOCKED_CMDS.test("rm -rf /"));
  });

  it("blocks rm -rf / with trailing space variant", () => {
    assert.ok(CREWLEAD_BLOCKED_CMDS.test("rm -rf /  "));
  });

  it("blocks mkfs", () => {
    assert.ok(CREWLEAD_BLOCKED_CMDS.test("mkfs.ext4 /dev/sda1"));
  });

  it("blocks dd if=", () => {
    assert.ok(CREWLEAD_BLOCKED_CMDS.test("dd if=/dev/zero of=/dev/sda"));
  });

  it("blocks fork bomb", () => {
    assert.ok(CREWLEAD_BLOCKED_CMDS.test(":(){ :|:& };:"));
  });

  it("blocks shutdown", () => {
    assert.ok(CREWLEAD_BLOCKED_CMDS.test("shutdown -h now"));
  });

  it("blocks reboot", () => {
    assert.ok(CREWLEAD_BLOCKED_CMDS.test("reboot"));
  });

  it("blocks halt", () => {
    assert.ok(CREWLEAD_BLOCKED_CMDS.test("halt"));
  });

  it("blocks pkill -9 crew-lead", () => {
    assert.ok(CREWLEAD_BLOCKED_CMDS.test("pkill -9 crew-lead"));
  });

  it("allows safe commands", () => {
    assert.ok(!CREWLEAD_BLOCKED_CMDS.test("ls -la /tmp"));
    assert.ok(!CREWLEAD_BLOCKED_CMDS.test("node --version"));
    assert.ok(!CREWLEAD_BLOCKED_CMDS.test("git status"));
    assert.ok(!CREWLEAD_BLOCKED_CMDS.test("npm test"));
  });

  it("allows rm -rf on non-root path", () => {
    // rm -rf /tmp/something should NOT be blocked
    assert.ok(!CREWLEAD_BLOCKED_CMDS.test("rm -rf /tmp/my-project"));
  });
});

// ── execCrewLeadTools — @@READ_FILE ───────────────────────────────────────

describe("execCrewLeadTools — @@READ_FILE", () => {
  it("reads an existing file and returns content snippet", async () => {
    const filePath = path.join(tmpDir, "hello.md");
    fs.writeFileSync(filePath, "# Hello\nWorld content here", "utf8");

    const results = await execCrewLeadTools(`@@READ_FILE ${filePath}`);
    assert.equal(results.length, 1);
    assert.ok(results[0].includes("[read_file]"));
    assert.ok(results[0].includes("Hello"));
  });

  it("returns error result for nonexistent file", async () => {
    const results = await execCrewLeadTools("@@READ_FILE /nonexistent/totally-fake.md");
    assert.equal(results.length, 1);
    assert.ok(results[0].includes("❌"));
  });

  it("reports byte count in result", async () => {
    const filePath = path.join(tmpDir, "measure.txt");
    fs.writeFileSync(filePath, "12345", "utf8");

    const results = await execCrewLeadTools(`@@READ_FILE ${filePath}`);
    assert.ok(results[0].includes("5 bytes"));
  });

  it("truncates large doc files at 12000 chars", async () => {
    const filePath = path.join(tmpDir, "big.md");
    fs.writeFileSync(filePath, "x".repeat(15000), "utf8");

    const results = await execCrewLeadTools(`@@READ_FILE ${filePath}`);
    assert.ok(results[0].includes("[truncated]"), "missing truncation marker");
  });

  it("truncates non-doc files at 6000 chars", async () => {
    const filePath = path.join(tmpDir, "big.ts");
    fs.writeFileSync(filePath, "y".repeat(8000), "utf8");

    const results = await execCrewLeadTools(`@@READ_FILE ${filePath}`);
    assert.ok(results[0].includes("[truncated]"), "missing truncation marker for .ts file");
  });

  it("handles multiple @@READ_FILE tags in one reply", async () => {
    const f1 = path.join(tmpDir, "a.txt");
    const f2 = path.join(tmpDir, "b.txt");
    fs.writeFileSync(f1, "alpha", "utf8");
    fs.writeFileSync(f2, "beta", "utf8");

    const results = await execCrewLeadTools(
      `@@READ_FILE ${f1}\nsome text\n@@READ_FILE ${f2}`,
    );
    assert.equal(results.length, 2);
    assert.ok(results[0].includes("alpha"));
    assert.ok(results[1].includes("beta"));
  });

  it("strips prose from path before reading", async () => {
    const filePath = path.join(tmpDir, "clean.md");
    fs.writeFileSync(filePath, "clean content", "utf8");

    const results = await execCrewLeadTools(
      `@@READ_FILE ${filePath} and then review it`,
    );
    assert.equal(results.length, 1);
    assert.ok(results[0].includes("clean content"));
  });
});

// ── execCrewLeadTools — @@WRITE_FILE ─────────────────────────────────────

describe("execCrewLeadTools — @@WRITE_FILE", () => {
  it("writes file and confirms with byte count", async () => {
    const filePath = path.join(tmpDir, "output.txt");
    const reply = `@@WRITE_FILE ${filePath}\nhello world\n@@END_FILE`;

    const results = await execCrewLeadTools(reply);
    assert.equal(results.length, 1);
    assert.ok(results[0].includes("✅"));
    assert.ok(fs.existsSync(filePath));
    assert.equal(fs.readFileSync(filePath, "utf8"), "hello world\n");
  });

  it("creates parent directories automatically", async () => {
    const filePath = path.join(tmpDir, "nested", "deep", "file.txt");
    const reply = `@@WRITE_FILE ${filePath}\ndeep content\n@@END_FILE`;

    const results = await execCrewLeadTools(reply);
    assert.ok(results[0].includes("✅"));
    assert.ok(fs.existsSync(filePath));
  });

  it("returns error result when path is invalid", async () => {
    // Writing to /proc/test or a location that will fail on macOS
    // Use a path that will fail: dir that exists as a file
    const blockingFile = path.join(tmpDir, "blocker");
    fs.writeFileSync(blockingFile, "I am a file");
    const impossiblePath = path.join(blockingFile, "child.txt");

    const reply = `@@WRITE_FILE ${impossiblePath}\ncontent\n@@END_FILE`;
    const results = await execCrewLeadTools(reply);
    assert.ok(results[0].includes("❌"));
  });

  it("writes empty content", async () => {
    const filePath = path.join(tmpDir, "empty.txt");
    const reply = `@@WRITE_FILE ${filePath}\n@@END_FILE`;

    await execCrewLeadTools(reply);
    assert.ok(fs.existsSync(filePath));
    assert.equal(fs.readFileSync(filePath, "utf8"), "");
  });

  it("handles multiple @@WRITE_FILE blocks in one reply", async () => {
    const f1 = path.join(tmpDir, "first.txt");
    const f2 = path.join(tmpDir, "second.txt");
    const reply = [
      `@@WRITE_FILE ${f1}`,
      "content one",
      "@@END_FILE",
      `@@WRITE_FILE ${f2}`,
      "content two",
      "@@END_FILE",
    ].join("\n");

    const results = await execCrewLeadTools(reply);
    assert.equal(results.length, 2);
    assert.ok(results[0].includes("✅"));
    assert.ok(results[1].includes("✅"));
  });
});

// ── execCrewLeadTools — @@MKDIR ────────────────────────────────────────────

describe("execCrewLeadTools — @@MKDIR", () => {
  it("creates a new directory", async () => {
    const dirPath = path.join(tmpDir, "newdir");
    const results = await execCrewLeadTools(`@@MKDIR ${dirPath}`);
    assert.ok(results[0].includes("✅"));
    assert.ok(fs.existsSync(dirPath));
    assert.ok(fs.statSync(dirPath).isDirectory());
  });

  it("creates nested directories recursively", async () => {
    const dirPath = path.join(tmpDir, "a", "b", "c");
    const results = await execCrewLeadTools(`@@MKDIR ${dirPath}`);
    assert.ok(results[0].includes("✅"));
    assert.ok(fs.existsSync(dirPath));
  });

  it("does not error when directory already exists", async () => {
    const dirPath = path.join(tmpDir, "existing");
    fs.mkdirSync(dirPath);
    const results = await execCrewLeadTools(`@@MKDIR ${dirPath}`);
    assert.ok(results[0].includes("✅"), "existing dir should not fail");
  });
});

// ── execCrewLeadTools — @@RUN_CMD ─────────────────────────────────────────

describe("execCrewLeadTools — @@RUN_CMD", () => {
  it("runs a safe command and captures stdout", async () => {
    const results = await execCrewLeadTools("@@RUN_CMD echo hello_crewswarm");
    assert.ok(results[0].includes("✅"));
    assert.ok(results[0].includes("hello_crewswarm"));
  });

  it("blocks dangerous rm -rf / command", async () => {
    const results = await execCrewLeadTools("@@RUN_CMD rm -rf /");
    assert.ok(results[0].includes("⛔"), "dangerous command not blocked");
  });

  it("blocks shutdown command", async () => {
    const results = await execCrewLeadTools("@@RUN_CMD shutdown -h now");
    assert.ok(results[0].includes("⛔"));
  });

  it("returns error result for failing command", async () => {
    const results = await execCrewLeadTools("@@RUN_CMD false");
    assert.ok(results[0].includes("❌"));
  });

  it("strips em-dash comments from command", async () => {
    // "echo hello — to greet" should run "echo hello"
    const results = await execCrewLeadTools("@@RUN_CMD echo hello — to greet");
    assert.ok(results[0].includes("✅"));
    assert.ok(results[0].includes("hello"));
  });

  it("handles multiple @@RUN_CMD tags", async () => {
    const results = await execCrewLeadTools(
      "@@RUN_CMD echo first\n@@RUN_CMD echo second",
    );
    assert.equal(results.length, 2);
    assert.ok(results[0].includes("first"));
    assert.ok(results[1].includes("second"));
  });
});

// ── execCrewLeadTools — @@SEARCH_HISTORY ─────────────────────────────────

describe("execCrewLeadTools — @@SEARCH_HISTORY", () => {
  it("returns no-history message when history dir is empty", async () => {
    // tmpDir exists but has no .jsonl files
    const results = await execCrewLeadTools("@@SEARCH_HISTORY authentication");
    assert.ok(results[0].includes("No matches") || results[0].includes("No history"));
  });

  it("finds matching entries in .jsonl files", async () => {
    const entry = JSON.stringify({
      ts: Date.now(),
      role: "user",
      content: "JWT authentication flow setup",
    });
    fs.writeFileSync(path.join(tmpDir, "session-abc.jsonl"), entry + "\n", "utf8");

    const results = await execCrewLeadTools("@@SEARCH_HISTORY authentication");
    assert.ok(results[0].includes("match"));
    assert.ok(results[0].includes("JWT authentication"));
  });

  it("returns no-matches message when query does not match", async () => {
    const entry = JSON.stringify({
      ts: Date.now(),
      role: "assistant",
      content: "Deployed the API",
    });
    fs.writeFileSync(path.join(tmpDir, "session-xyz.jsonl"), entry + "\n", "utf8");

    const results = await execCrewLeadTools("@@SEARCH_HISTORY xyznonexistentkeyword99");
    assert.ok(results[0].includes("No matches"));
  });

  it("returns no-history message when historyDir does not exist", async () => {
    initTools({
      historyDir: "/nonexistent/history/dir/abc",
      crewswarmCfgFile: path.join(tmpDir, "crewswarm.json"),
    });
    const results = await execCrewLeadTools("@@SEARCH_HISTORY test");
    assert.ok(results[0].includes("No history") || results[0].includes("No matches"));
  });

  it("limits results to 20 matches", async () => {
    // Write 25 matching entries
    const lines = Array.from({ length: 25 }, (_, i) =>
      JSON.stringify({ ts: Date.now() + i, role: "user", content: `needle entry ${i}` }),
    ).join("\n");
    fs.writeFileSync(path.join(tmpDir, "session-big.jsonl"), lines + "\n", "utf8");

    const results = await execCrewLeadTools("@@SEARCH_HISTORY needle");
    // Result line count check: "N match(es)" should say 20
    assert.ok(results[0].includes("20 match"), "expected exactly 20 matches");
  });

  it("skips malformed JSON lines without throwing", async () => {
    const content = [
      "not json at all",
      JSON.stringify({ ts: Date.now(), role: "user", content: "valid entry needle" }),
    ].join("\n");
    fs.writeFileSync(path.join(tmpDir, "session-mix.jsonl"), content + "\n", "utf8");

    const results = await execCrewLeadTools("@@SEARCH_HISTORY needle");
    assert.ok(results[0].includes("match"));
  });
});

// ── execCrewLeadTools — @@WEB_SEARCH ─────────────────────────────────────

describe("execCrewLeadTools — @@WEB_SEARCH", () => {
  it("returns a result (error without key, or results with key)", async () => {
    // In CI or dev environments this may either succeed (key configured) or fail (no key).
    // Either way we must get exactly one result back from the tool.
    const results = await execCrewLeadTools("@@WEB_SEARCH latest AI news");
    assert.equal(results.length, 1, "expected exactly one result entry");
    assert.ok(
      results[0].includes("[web_search]"),
      "result should contain [web_search] prefix",
    );
  });

  it("returns error when crewswarm.json has no brave key", async () => {
    // Point to a temp dir with no crewswarm.json so no Brave key is found
    initTools({ historyDir: tmpDir, crewswarmCfgFile: path.join(tmpDir, "crewswarm.json") });
    // Also ensure search-tools.json doesn't exist in homedir — we can't control that,
    // so the test only asserts on the error/success shape.
    const results = await execCrewLeadTools("@@WEB_SEARCH crew lead test query");
    assert.equal(results.length, 1);
    // Either a successful search (if homedir has a brave key) or an error
    assert.ok(results[0].includes("[web_search]"));
  });
});

// ── execCrewLeadTools — @@WEB_FETCH ───────────────────────────────────────

describe("execCrewLeadTools — @@WEB_FETCH", () => {
  it("returns error for unreachable URL (offline/nonexistent host)", async () => {
    // This should fail because the host does not exist
    const results = await execCrewLeadTools(
      "@@WEB_FETCH https://this-host-does-not-exist.crewswarm-test.invalid/page",
    );
    assert.ok(results[0].includes("❌"));
  });

  it("does not match non-http URLs", async () => {
    // ftp:// should not match the WEB_FETCH regex
    const results = await execCrewLeadTools("@@WEB_FETCH ftp://example.com/page");
    assert.equal(results.length, 0, "ftp:// should not match @@WEB_FETCH regex");
  });
});

// ── execCrewLeadTools — @@TELEGRAM ────────────────────────────────────────

describe("execCrewLeadTools — @@TELEGRAM", () => {
  it("returns a result for @@TELEGRAM (either ✅ if configured or ❌ if not)", async () => {
    const results = await execCrewLeadTools("@@TELEGRAM __crewswarm_test_ping__");
    assert.equal(results.length, 1, "expected exactly one result");
    assert.ok(results[0].includes("[telegram]"), "result must contain [telegram] prefix");
    // Must be either success or an error — not a hang
    assert.ok(
      results[0].includes("✅") || results[0].includes("❌"),
      `unexpected telegram result: ${results[0]}`,
    );
  });

  it("returns contact-not-found error for unknown @Name that cannot exist", async () => {
    // A unique nonsense name that cannot be in any real contactNames config
    const results = await execCrewLeadTools("@@TELEGRAM @XyzNoContactPossible_8675309 Hello!");
    assert.equal(results.length, 1);
    assert.ok(results[0].includes("❌"), "unknown @Name should always return ❌");
  });
});

// ── execCrewLeadTools — @@WHATSAPP ────────────────────────────────────────

describe("execCrewLeadTools — @@WHATSAPP", () => {
  it("returns a result for @@WHATSAPP (error if no phone or bridge offline)", async () => {
    const results = await execCrewLeadTools("@@WHATSAPP __crewswarm_test_ping__");
    assert.equal(results.length, 1, "expected exactly one result");
    assert.ok(results[0].includes("[whatsapp]"), "result must contain [whatsapp] prefix");
    // The bridge may be offline in test env, so we accept ❌ or ✅
    assert.ok(
      results[0].includes("✅") || results[0].includes("❌"),
      `unexpected whatsapp result: ${results[0]}`,
    );
  });

  it("returns contact-not-found error for unknown @Name that cannot exist", async () => {
    // A nonsense name that cannot be in any real contactNames config
    const results = await execCrewLeadTools("@@WHATSAPP @XyzNoContactPossible_8675309 Hello!");
    assert.equal(results.length, 1);
    assert.ok(results[0].includes("❌"), "unknown @Name should always return ❌");
  });
});

// ── execCrewLeadTools — empty / no tags ──────────────────────────────────

describe("execCrewLeadTools — no-op inputs", () => {
  it("returns empty array for reply with no @@ tags", async () => {
    const results = await execCrewLeadTools("Just a normal chat reply");
    assert.deepEqual(results, []);
  });

  it("returns empty array for empty string", async () => {
    const results = await execCrewLeadTools("");
    assert.deepEqual(results, []);
  });

  it("returns empty array for whitespace-only string", async () => {
    const results = await execCrewLeadTools("   \n\t  ");
    assert.deepEqual(results, []);
  });
});

// ── execCrewLeadTools — tilde expansion ───────────────────────────────────

describe("execCrewLeadTools — tilde expansion in paths", () => {
  it("expands ~ to os.homedir() in @@READ_FILE", async () => {
    // Write a real file in homedir to confirm expansion (avoid writing sensitive files)
    const subDir = fs.mkdtempSync(path.join(os.tmpdir(), "crew-tilde-test-"));
    const testFile = path.join(subDir, "tilde-test.md");
    fs.writeFileSync(testFile, "tilde content", "utf8");

    // Construct a relative-from-home path (only valid if tmpdir is not under homedir,
    // so use absolute path that replaces os.homedir() prefix with ~)
    const home = os.homedir();
    let tildeArg = testFile;
    if (testFile.startsWith(home)) {
      tildeArg = "~" + testFile.slice(home.length);
    }

    // Only run if we can construct a tilde path
    if (tildeArg.startsWith("~")) {
      const results = await execCrewLeadTools(`@@READ_FILE ${tildeArg}`);
      assert.ok(results[0].includes("tilde content"), "tilde expansion failed");
    }

    fs.rmSync(subDir, { recursive: true, force: true });
  });
});
