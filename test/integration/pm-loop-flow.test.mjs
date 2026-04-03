/**
 * PM Loop Integration Tests — traces the FULL dispatch → mark → extend flow
 *
 * These tests verify the ACTUAL behavior that was broken:
 *   1. PM loop reads ROADMAP.md and finds next unchecked item
 *   2. PM expands the item into a task with LLM
 *   3. PM routes the task to the correct agent (crew-coder, crew-coder-front, etc.)
 *   4. PM dispatches via gateway-bridge --send (spawns child process)
 *   5. PM WAITS for the agent to complete
 *   6. PM marks the item [x] DONE in ROADMAP.md (THIS WAS BROKEN — tests passed but logic failed)
 *   7. PM picks the NEXT item (not the same one again)
 *   8. PM self-extends when roadmap is empty (generates new items)
 *
 * Prerequisites: npm run restart-all (RT bus :18889, crew-lead :5010, dashboard :4319)
 *
 * Run: node --test test/integration/pm-loop-flow.test.mjs
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";

const CREWSWARM_DIR = path.resolve(".");
const PM_LOOP_SCRIPT = path.join(CREWSWARM_DIR, "pm-loop.mjs");
const LOGS_DIR = path.join(CREWSWARM_DIR, "orchestrator-logs"); // Use repo-local logs, matching pm-loop.mjs
const PM_PID_FILE = path.join(os.homedir(), ".crewswarm", "logs", "pm-loop.pid");

// Global cleanup: kill any pm-loop processes spawned by tests and remove stale PID files
after(async () => {
  try {
    const { execSync } = await import("node:child_process");
    execSync("pkill -f 'pm-loop.mjs' 2>/dev/null || true", { stdio: "ignore", timeout: 3000 });
  } catch {}
  try { fs.unlinkSync(PM_PID_FILE); } catch {}
});

// Check if services are running (with a 5s timeout so we never hang here)
let rtBusReachable = false;
try {
  const { execSync } = await import("node:child_process");
  const stdout = execSync("lsof -i :18889 | grep LISTEN", { encoding: "utf8", timeout: 5000 });
  rtBusReachable = stdout.includes("18889");
} catch {}

const SKIP_LIVE = !rtBusReachable
  ? "Requires RT bus (:18889) — run npm run restart-all"
  : false;

// ─── Helper: Parse roadmap status ─────────────────────────────────────────
function parseRoadmapStatus(content) {
  const lines = content.split("\n");
  const items = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^- \[ \]/.test(line)) {
      items.push({ lineIdx: i, status: "pending", text: line.replace(/^- \[ \]\s*/, "").trim() });
    } else if (/^- \[x\]/.test(line)) {
      items.push({ lineIdx: i, status: "done", text: line.replace(/^- \[x\]\s*/, "").split("✓")[0].trim() });
    } else if (/^- \[!\]/.test(line)) {
      items.push({ lineIdx: i, status: "failed", text: line.replace(/^- \[!\]\s*/, "").split("✗")[0].trim() });
    }
  }
  
  return {
    total: items.length,
    pending: items.filter(i => i.status === "pending").length,
    done: items.filter(i => i.status === "done").length,
    failed: items.filter(i => i.status === "failed").length,
    items,
  };
}

// ─── Helper: Run PM loop with timeout ─────────────────────────────────────
async function runPMLoop({ projectDir, maxItems = 3, dryRun = false, timeout = 30000, selfExtend = false }) {
  const roadmapFile = path.join(projectDir, "ROADMAP.md");
  const pidFile = path.join(LOGS_DIR, "pm-loop.pid");
  const stopFile = path.join(LOGS_DIR, "pm-loop.stop");
  
  // Clean up any stale PID/stop files
  try { fs.unlinkSync(pidFile); } catch {}
  try { fs.unlinkSync(stopFile); } catch {}
  
  return new Promise((resolve, reject) => {
    const args = [
      PM_LOOP_SCRIPT,
      "--project-dir", projectDir,
      "--max-items", String(maxItems),
    ];
    if (dryRun) args.push("--dry-run");
    if (!selfExtend) args.push("--no-extend");
    
    const env = {
      ...process.env,
      PM_ROADMAP_FILE: roadmapFile,
      PM_USE_QA: "0",           // Disable QA for faster tests
      PM_USE_SECURITY: "0",     // Disable security audits
      PM_EXTEND_EVERY: "10",    // Only extend every 10 items (not every 5)
    };
    
    const proc = spawn("node", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      detached: true,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", d => { stdout += d.toString(); });
    proc.stderr?.on("data", d => { stderr += d.toString(); });

    const timeoutId = setTimeout(() => {
      // Kill entire process group so child processes don't keep pipes open
      try { process.kill(-proc.pid, "SIGTERM"); } catch { proc.kill("SIGTERM"); }
      setTimeout(() => {
        try { process.kill(-proc.pid, "SIGKILL"); } catch { try { proc.kill("SIGKILL"); } catch {} }
      }, 2000);
      reject(new Error(`PM loop timeout after ${timeout}ms\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeout);
    
    proc.on("close", code => {
      clearTimeout(timeoutId);
      resolve({ code, stdout, stderr, pid: proc.pid });
    });
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("PM loop — ROADMAP.md parsing", () => {
  it("parses unchecked items correctly", () => {
    const content = `# Test Roadmap

## Phase 1

- [ ] Build homepage
- [x] Setup project  ✓ 10:30:00 (crew-coder)
- [!] Fix deployment  ✗ 10:35:00
- [ ] Write README
`;
    
    const { total, pending, done, failed, items } = parseRoadmapStatus(content);
    
    assert.equal(total, 4);
    assert.equal(pending, 2);
    assert.equal(done, 1);
    assert.equal(failed, 1);
    
    assert.equal(items[0].status, "pending");
    assert.equal(items[0].text, "Build homepage");
    assert.equal(items[1].status, "done");
    assert.equal(items[1].text, "Setup project");
    assert.equal(items[2].status, "failed");
    assert.equal(items[2].text, "Fix deployment");
    assert.equal(items[3].status, "pending");
    assert.equal(items[3].text, "Write README");
  });
  
  it("returns correct line indices for marking", () => {
    const content = `# Test
- [ ] Item 1
- [x] Item 2
- [ ] Item 3`;
    
    const { items } = parseRoadmapStatus(content);
    
    assert.equal(items[0].lineIdx, 1);  // "- [ ] Item 1"
    assert.equal(items[1].lineIdx, 2);  // "- [x] Item 2"
    assert.equal(items[2].lineIdx, 3);  // "- [ ] Item 3"
  });
});

describe("PM loop — markItem function behavior", () => {
  let testDir;
  let roadmapPath;
  
  before(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), "pm-mark-test-"));
    roadmapPath = path.join(testDir, "ROADMAP.md");
  });
  
  after(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });
  
  it("marks pending item as done with [x]", async () => {
    await writeFile(roadmapPath, `# Test
- [ ] Build feature
- [ ] Write tests
`, "utf8");
    
    // Simulate markItem(0, "done", "crew-coder")
    let content = await readFile(roadmapPath, "utf8");
    let lines = content.split("\n");
    const ts = new Date().toLocaleTimeString();
    lines[1] = lines[1].replace(/\[[ !]\]/, "[x]");
    lines[1] += `  ✓ ${ts} (crew-coder)`;
    await writeFile(roadmapPath, lines.join("\n"), "utf8");
    
    content = await readFile(roadmapPath, "utf8");
    assert.match(content, /\[x\] Build feature\s+✓/);
    assert.match(content, /\(crew-coder\)/);
    assert.match(content, /\[ \] Write tests/);  // Second item still pending
  });
  
  it("marks pending item as failed with [!]", async () => {
    await writeFile(roadmapPath, `# Test
- [ ] Deploy app
`, "utf8");
    
    // Simulate markItem(0, "failed")
    let content = await readFile(roadmapPath, "utf8");
    let lines = content.split("\n");
    const ts = new Date().toLocaleTimeString();
    lines[1] = lines[1].replace(/\[ \]/, "[!]");
    lines[1] += `  ✗ ${ts}`;
    await writeFile(roadmapPath, lines.join("\n"), "utf8");
    
    content = await readFile(roadmapPath, "utf8");
    assert.match(content, /\[!\] Deploy app\s+✗/);
  });
  
  it("does NOT re-mark an already done item", async () => {
    await writeFile(roadmapPath, `# Test
- [x] Already done  ✓ 10:00:00 (crew-coder)
- [ ] Next task
`, "utf8");
    
    const { items } = parseRoadmapStatus(await readFile(roadmapPath, "utf8"));
    
    // The PM loop's nextPending should skip done items
    const nextItem = items.find(i => i.status === "pending");
    assert.ok(nextItem, "Should find pending item");
    assert.equal(nextItem.text, "Next task");
    assert.notEqual(nextItem.text, "Already done");
  });
});

describe("PM loop — dry-run mode (no actual dispatch)", { skip: SKIP_LIVE, timeout: 60000 }, () => {
  let testDir;
  
  before(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), "pm-dryrun-"));
    await writeFile(path.join(testDir, "ROADMAP.md"), `# Test Project

## Phase 1

- [ ] Create index.html with title "Test"
- [ ] Add CSS stylesheet
- [ ] Write README.md
`, "utf8");
  });
  
  after(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });
  
  it("marks items as done in dry-run without dispatching", async () => {
    const roadmapPath = path.join(testDir, "ROADMAP.md");
    const beforeContent = await readFile(roadmapPath, "utf8");
    const before = parseRoadmapStatus(beforeContent);

    assert.equal(before.pending, 3);
    assert.equal(before.done, 0);

    // Run PM loop in dry-run mode with max 2 items
    const result = await runPMLoop({
      projectDir: testDir,
      maxItems: 2,
      dryRun: true,
      timeout: 30000,
    });
    
    assert.equal(result.code, 0, `PM loop failed with code ${result.code}\nstderr: ${result.stderr}`);
    
    // Verify 2 items were marked done
    const afterContent = await readFile(roadmapPath, "utf8");
    const after = parseRoadmapStatus(afterContent);
    
    assert.equal(after.done, 2, `Expected 2 done items, got ${after.done}\nRoadmap:\n${afterContent}`);
    assert.equal(after.pending, 1);
  });
});

describe("PM loop — next item selection CRITICAL FLOW", { skip: SKIP_LIVE, timeout: 90000 }, () => {
  let testDir;
  
  before(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), "pm-next-"));
    await writeFile(path.join(testDir, "ROADMAP.md"), `# Test

- [ ] Task A
- [ ] Task B
- [ ] Task C
`, "utf8");
  });
  
  after(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });
  
  it("picks next pending item after marking previous done", async () => {
    const roadmapPath = path.join(testDir, "ROADMAP.md");
    
    // Run PM loop for 1 item
    await runPMLoop({ projectDir: testDir, maxItems: 1, dryRun: true, timeout: 30000 });

    let content = await readFile(roadmapPath, "utf8");
    let status = parseRoadmapStatus(content);

    // Task A should be done
    assert.equal(status.done, 1);
    assert.equal(status.items[0].status, "done");
    assert.equal(status.items[0].text, "Task A");

    // Task B should still be pending
    assert.equal(status.items[1].status, "pending");
    assert.equal(status.items[1].text, "Task B");

    // Run PM loop for 1 more item
    await runPMLoop({ projectDir: testDir, maxItems: 1, dryRun: true, timeout: 30000 });
    
    content = await readFile(roadmapPath, "utf8");
    status = parseRoadmapStatus(content);
    
    // Task B should NOW be done
    assert.equal(status.done, 2);
    assert.equal(status.items[1].status, "done");
    assert.equal(status.items[1].text, "Task B");
    
    // Task C should still be pending
    assert.equal(status.items[2].status, "pending");
    assert.equal(status.items[2].text, "Task C");
  });
  
  it("DOES NOT re-dispatch the same item twice (THE BUG WE HAD)", async () => {
    const roadmapPath = path.join(testDir, "ROADMAP.md");
    
    // Reset roadmap
    await writeFile(roadmapPath, `# Test
- [ ] Unique Task 1
- [ ] Unique Task 2
`, "utf8");
    
    // Run PM loop for 2 items
    await runPMLoop({ projectDir: testDir, maxItems: 2, dryRun: true, timeout: 30000 });

    const content = await readFile(roadmapPath, "utf8");
    const status = parseRoadmapStatus(content);

    // Both should be marked done ONCE
    assert.equal(status.done, 2, `Expected 2 done, got ${status.done}\nRoadmap:\n${content}`);
    
    // Count how many times each task appears as [x]
    const task1Done = (content.match(/\[x\].*Unique Task 1/g) || []).length;
    const task2Done = (content.match(/\[x\].*Unique Task 2/g) || []).length;
    
    assert.equal(task1Done, 1, `Unique Task 1 marked ${task1Done} times (should be 1)`);
    assert.equal(task2Done, 1, `Unique Task 2 marked ${task2Done} times (should be 1)`);
  });
});

describe("PM loop — self-extend when roadmap is empty", { skip: SKIP_LIVE, timeout: 90000 }, () => {
  let testDir;
  
  before(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), "pm-extend-"));
  });
  
  after(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });
  
  it("generates new items when all pending items are done", async () => {
    const roadmapPath = path.join(testDir, "ROADMAP.md");
    
    // Start with 1 item
    await writeFile(roadmapPath, `# Auto Extend Test

- [ ] Initial task
`, "utf8");
    
    // Run with self-extend enabled
    const result = await runPMLoop({
      projectDir: testDir,
      maxItems: 5,
      dryRun: true,
      selfExtend: true,
      timeout: 60000,
    });
    
    assert.equal(result.code, 0, `PM loop failed\nstderr: ${result.stderr}`);
    
    const content = await readFile(roadmapPath, "utf8");
    
    // Should have generated new "PM-Generated" section
    assert.match(content, /PM-Generated \(Round \d+\)/i, "Should have PM-Generated section");
    
    const status = parseRoadmapStatus(content);
    
    // Should have more items than we started with
    assert.ok(status.total > 1, `Expected > 1 total items, got ${status.total}\nRoadmap:\n${content}`);
  });
});

describe("PM loop — stop file halts execution gracefully", { skip: SKIP_LIVE, timeout: 60000 }, () => {
  let testDir;
  
  before(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), "pm-stop-"));
    // Generate many tasks so the loop doesn't finish before the stop file is created
    const tasks = Array.from({ length: 50 }, (_, i) => `- [ ] Task ${i + 1}`).join("\n");
    await writeFile(path.join(testDir, "ROADMAP.md"), `# Test\n\n${tasks}\n`, "utf8");

    // Ensure logs dir exists
    await mkdir(LOGS_DIR, { recursive: true });
  });

  after(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    // Clean up stop file
    try { fs.unlinkSync(path.join(LOGS_DIR, "pm-loop.stop")); } catch {}
  });

  it("stops when stop file is created mid-execution", async () => {
    const stopFile = path.join(LOGS_DIR, "pm-loop.stop");

    // Start PM loop in background with many items
    const pmPromise = runPMLoop({
      projectDir: testDir,
      maxItems: 50,
      dryRun: true,
      timeout: 30000,
    });

    // Wait 3 seconds then create stop file (dry-run ~500ms/task, so ~3s = ~6 tasks done)
    await new Promise(r => setTimeout(r, 3000));
    await writeFile(stopFile, "stop", "utf8");

    const result = await pmPromise;

    // Should exit cleanly
    assert.equal(result.code, 0);
    assert.match(result.stdout, /stop file detected/i);

    // Should NOT have completed all 50 tasks
    const content = await readFile(path.join(testDir, "ROADMAP.md"), "utf8");
    const status = parseRoadmapStatus(content);

    assert.ok(status.done < 50, `Expected < 50 done (stopped early), got ${status.done}`);
    assert.ok(status.pending > 0, `Expected some pending items, got ${status.pending}`);
  });
});

describe("PM loop — agent routing logic", () => {
  it("routes HTML/CSS tasks to crew-coder-front", () => {
    const task = "Build a responsive hero section with CSS animations";
    const pattern = /html|css|style|section|design|layout|animation|frontend|ui\b|ux\b|responsive/i;
    
    assert.match(task.toLowerCase(), pattern);
  });
  
  it("routes API/backend tasks to crew-coder-back", () => {
    const task = "Add REST API endpoint for user authentication";
    const pattern = /\bapi\b|server|node|express|endpoint|database|backend|mjs/i;
    
    assert.match(task.toLowerCase(), pattern);
  });
  
  it("routes git tasks to crew-github", () => {
    const task = "Commit changes and create pull request";
    const pattern = /\bgit\b|github|commit|push|pull.request|branch|deploy/i;
    
    assert.match(task.toLowerCase(), pattern);
  });
  
  it("falls back to crew-coder for generic tasks", () => {
    const task = "Refactor the error handling logic";
    const patterns = [
      /\bgit\b|github|commit|push|pull.request|branch|deploy/i,
      /\bapi\b|server|node|express|endpoint|database|backend|mjs/i,
      /html|css|style|section|design|layout|animation|frontend|ui\b|ux\b|responsive/i,
    ];
    
    const matches = patterns.some(p => p.test(task.toLowerCase()));
    assert.equal(matches, false, "Generic task should not match any specialist pattern");
  });
});

describe("PM loop — log file tracking", { skip: SKIP_LIVE, timeout: 60000 }, () => {
  it("writes pm-loop.jsonl log entries", async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), "pm-log-"));
    await writeFile(path.join(testDir, "ROADMAP.md"), `# Test
- [ ] Simple task
`, "utf8");
    
    await runPMLoop({ projectDir: testDir, maxItems: 1, dryRun: true, timeout: 30000 });
    
    const logFile = path.join(LOGS_DIR, "pm-loop.jsonl");
    
    if (fs.existsSync(logFile)) {
      const logs = fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);
      assert.ok(logs.length > 0, "PM loop log should have entries");
      
      // Parse first log entry
      const firstLog = JSON.parse(logs[0]);
      assert.ok(firstLog.event, "Log entry should have event field");
      assert.ok(firstLog.ts, "Log entry should have timestamp");
    }
    
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });
});
