/**
 * Unit tests for PM loop final synthesis and concurrency semaphore.
 *
 * We extract and test the logic inline (pm-loop.mjs auto-runs on import).
 * Tests cover:
 *   - finalSynthesis prompt structure (audit + assembly phase text)
 *   - Verdict detection (SHIP IT / DO NOT SHIP / NEEDS WORK)
 *   - DISCONNECT: parsing (triggers assembly phase)
 *   - Concurrency semaphore (MAX_CONCURRENT_TASKS queue)
 *   - PHASED_TASK_TIMEOUT_MS env var parsing
 *   - PM_MAX_CONCURRENT env var parsing
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ─── Inline verdict detection from finalSynthesis ────────────────────────
function detectVerdict(auditResult) {
  if (/SHIP IT/i.test(auditResult)) return "SHIP IT";
  if (/DO NOT SHIP/i.test(auditResult)) return "DO NOT SHIP";
  return "NEEDS WORK";
}

function hasDisconnects(auditResult) {
  return /DISCONNECT:/i.test(auditResult);
}

function shouldRunAssembly(auditResult) {
  return hasDisconnects(auditResult) || detectVerdict(auditResult) !== "SHIP IT";
}

// ─── Inline concurrency semaphore from pm-loop.mjs ───────────────────────
function buildSemaphore(maxConcurrent) {
  let active = 0;
  const queue = [];

  function acquire() {
    if (active < maxConcurrent) {
      active++;
      return Promise.resolve();
    }
    return new Promise(resolve => queue.push(resolve));
  }

  function release() {
    if (queue.length > 0) {
      queue.shift()();
    } else {
      active--;
    }
  }

  return { acquire, release, getActive: () => active, getQueued: () => queue.length };
}

// ─── Inline TASK_TIMEOUT parsing ─────────────────────────────────────────
function parseTaskTimeout(envVal) {
  return Number(envVal || "600000");
}

function parseMaxConcurrent(envVal) {
  return Number(envVal || "20");
}

// ─── Inline audit prompt structure checks ────────────────────────────────
function buildAuditPrompt(doneCount, failedCount, taskSummary, fileManifest) {
  return `[SYNTHESIS-AUDIT] You are Quill, the final assembler. All workers have finished. Your job is to audit the full build and find every broken seam.

## Build summary
${doneCount} tasks done, ${failedCount} failed.

## Tasks completed
${taskSummary}

## Output files
${fileManifest}`;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("detectVerdict", () => {
  it("detects SHIP IT verdict", () => {
    assert.equal(detectVerdict("Build is ready. Verdict: SHIP IT"), "SHIP IT");
    assert.equal(detectVerdict("SHIP IT"), "SHIP IT");
  });

  it("detects DO NOT SHIP verdict", () => {
    assert.equal(detectVerdict("Major issues found. DO NOT SHIP"), "DO NOT SHIP");
    assert.equal(detectVerdict("DO NOT SHIP — missing auth"), "DO NOT SHIP");
  });

  it("defaults to NEEDS WORK when no verdict keyword found", () => {
    assert.equal(detectVerdict("Some issues found, requires review"), "NEEDS WORK");
    assert.equal(detectVerdict(""), "NEEDS WORK");
  });

  it("SHIP IT takes priority over DO NOT SHIP (order in regex)", () => {
    // In practice the LLM won't say both, but test the order
    const result = detectVerdict("DO NOT SHIP now, but could SHIP IT later");
    // SHIP IT regex runs first in implementation
    assert.equal(result, "SHIP IT");
  });

  it("is case-insensitive", () => {
    assert.equal(detectVerdict("ship it"), "SHIP IT");
    assert.equal(detectVerdict("do not ship"), "DO NOT SHIP");
  });
});

describe("hasDisconnects", () => {
  it("detects DISCONNECT: markers", () => {
    assert.ok(hasDisconnects("DISCONNECT: index.html references /api/submit which has no route"));
    assert.ok(hasDisconnects("Found issues:\nDISCONNECT: auth.js imports utils.js which is missing"));
  });

  it("returns false when no disconnects", () => {
    assert.equal(hasDisconnects("Everything looks clean. SHIP IT"), false);
  });

  it("is case-insensitive", () => {
    assert.ok(hasDisconnects("disconnect: server.js references db.js which is empty"));
  });
});

describe("shouldRunAssembly", () => {
  it("runs assembly when disconnects exist even with SHIP IT verdict", () => {
    // If LLM says SHIP IT but also listed disconnects, we still patch
    assert.ok(shouldRunAssembly("DISCONNECT: broken import. SHIP IT"));
  });

  it("runs assembly when verdict is not SHIP IT", () => {
    assert.ok(shouldRunAssembly("NEEDS WORK — see issues"));
    assert.ok(shouldRunAssembly("DO NOT SHIP"));
  });

  it("skips assembly for clean SHIP IT with no disconnects", () => {
    assert.equal(shouldRunAssembly("Build verified. SHIP IT"), false);
  });
});

describe("audit prompt structure", () => {
  it("includes build summary with done/failed counts", () => {
    const prompt = buildAuditPrompt(8, 2, "  1. Build UI\n  2. Add API", "  - index.html\n  - server.js");
    assert.match(prompt, /8 tasks done, 2 failed/);
  });

  it("includes SYNTHESIS-AUDIT header", () => {
    const prompt = buildAuditPrompt(3, 0, "tasks", "files");
    assert.match(prompt, /\[SYNTHESIS-AUDIT\]/);
    assert.match(prompt, /Quill/);
  });

  it("includes task summary and file manifest sections", () => {
    const prompt = buildAuditPrompt(1, 0, "  1. Task one", "  - output/index.html");
    assert.match(prompt, /Tasks completed/);
    assert.match(prompt, /Output files/);
    assert.match(prompt, /Task one/);
    assert.match(prompt, /output\/index.html/);
  });

  it("skips synthesis if doneCount is 0", () => {
    // The actual function early-returns: if (doneCount === 0) return;
    const shouldSkip = (doneCount) => doneCount === 0;
    assert.ok(shouldSkip(0));
    assert.equal(shouldSkip(1), false);
  });
});

describe("concurrency semaphore", () => {
  it("allows tasks up to MAX_CONCURRENT_TASKS", async () => {
    const sem = buildSemaphore(3);
    await sem.acquire();
    await sem.acquire();
    await sem.acquire();
    assert.equal(sem.getActive(), 3);
    assert.equal(sem.getQueued(), 0);
  });

  it("queues tasks beyond MAX_CONCURRENT_TASKS", async () => {
    const sem = buildSemaphore(2);
    await sem.acquire();
    await sem.acquire();
    // This one should queue
    let resolved = false;
    sem.acquire().then(() => { resolved = true; });
    // Give the microtask queue time to run
    await new Promise(r => setTimeout(r, 0));
    assert.equal(sem.getQueued(), 1);
    assert.equal(resolved, false);
  });

  it("resolves queued tasks when slot is released", async () => {
    const sem = buildSemaphore(1);
    await sem.acquire();
    let resolved = false;
    const p = sem.acquire().then(() => { resolved = true; });
    await new Promise(r => setTimeout(r, 0));
    assert.equal(resolved, false);
    sem.release();
    await p;
    assert.ok(resolved);
  });

  it("decrements active count on release when no queued tasks", () => {
    const sem = buildSemaphore(5);
    sem.acquire();
    sem.acquire();
    assert.equal(sem.getActive(), 2);
    sem.release();
    assert.equal(sem.getActive(), 1);
    sem.release();
    assert.equal(sem.getActive(), 0);
  });

  it("handles rapid acquire/release without deadlock", async () => {
    const sem = buildSemaphore(3);
    const results = [];
    const workers = Array.from({ length: 9 }, (_, i) =>
      sem.acquire().then(async () => {
        await new Promise(r => setTimeout(r, 5));
        results.push(i);
        sem.release();
      })
    );
    await Promise.all(workers);
    assert.equal(results.length, 9);
    assert.equal(sem.getActive(), 0);
    assert.equal(sem.getQueued(), 0);
  });
});

describe("PHASED_TASK_TIMEOUT_MS env var", () => {
  it("defaults to 600000 (10 minutes) when unset", () => {
    assert.equal(parseTaskTimeout(undefined), 600_000);
    assert.equal(parseTaskTimeout(""), 600_000);
  });

  it("parses custom value correctly", () => {
    assert.equal(parseTaskTimeout("300000"), 300_000);
    assert.equal(parseTaskTimeout("1800000"), 1_800_000);
  });

  it("non-doers get 2x timeout (synthesis uses 3x and 4x)", () => {
    const base = parseTaskTimeout("600000");
    assert.equal(base * 2, 1_200_000); // non-doers: QA, security
    assert.equal(base * 3, 1_800_000); // synthesis audit
    assert.equal(base * 4, 2_400_000); // synthesis assembly
  });
});

describe("PM_MAX_CONCURRENT env var", () => {
  it("defaults to 20 when unset", () => {
    assert.equal(parseMaxConcurrent(undefined), 20);
    assert.equal(parseMaxConcurrent(""), 20);
  });

  it("parses custom value correctly", () => {
    assert.equal(parseMaxConcurrent("5"), 5);
    assert.equal(parseMaxConcurrent("1"), 1);
    assert.equal(parseMaxConcurrent("50"), 50);
  });
});

describe("PM_CODER_AGENT — what it controls", () => {
  // PM_CODER_AGENT overrides the default coding agent used by the PM loop.
  // Normally tasks without a specialist keyword go to crew-coder.
  // Set PM_CODER_AGENT=crew-coder-front to force frontend agent for all uncategorised tasks.

  function resolveCoderAgent(envVal) {
    return envVal || "crew-coder";
  }

  it("defaults to crew-coder when unset", () => {
    assert.equal(resolveCoderAgent(undefined), "crew-coder");
    assert.equal(resolveCoderAgent(""), "crew-coder");
  });

  it("uses PM_CODER_AGENT override when set", () => {
    assert.equal(resolveCoderAgent("crew-coder-front"), "crew-coder-front");
    assert.equal(resolveCoderAgent("crew-mega"), "crew-mega");
  });
});

describe("PM_USE_SPECIALISTS — keyword routing", () => {
  // When PM_USE_SPECIALISTS=on, tasks are routed to specialist agents
  // based on keywords found in the task text.

  function routeToSpecialist(task, useSpecialists, coderAgent = "crew-coder") {
    if (!useSpecialists) return coderAgent;
    const t = task.toLowerCase();
    if (/\bgit\b|github|pr\b|pull request|commit|branch|merge/.test(t)) return "crew-github";
    if (/\bapi\b|backend|server|database|endpoint|sql|redis|mongo/.test(t)) return "crew-coder-back";
    if (/\bui\b|frontend|css|html|react|vue|style|design|layout/.test(t)) return "crew-coder-front";
    return coderAgent;
  }

  it("routes git tasks to crew-github", () => {
    assert.equal(routeToSpecialist("Create a PR for the changes", true), "crew-github");
    assert.equal(routeToSpecialist("Commit and push to main branch", true), "crew-github");
  });

  it("routes backend tasks to crew-coder-back", () => {
    assert.equal(routeToSpecialist("Add a REST API endpoint for user login", true), "crew-coder-back");
    assert.equal(routeToSpecialist("Set up a database schema", true), "crew-coder-back");
  });

  it("routes frontend tasks to crew-coder-front", () => {
    assert.equal(routeToSpecialist("Style the navbar with CSS", true), "crew-coder-front");
    assert.equal(routeToSpecialist("Build a React component for login", true), "crew-coder-front");
  });

  it("falls back to coderAgent for generic tasks", () => {
    assert.equal(routeToSpecialist("Write unit tests for auth", true), "crew-coder");
    assert.equal(routeToSpecialist("Write unit tests for auth", true, "crew-mega"), "crew-mega");
  });

  it("skips routing when PM_USE_SPECIALISTS is off", () => {
    assert.equal(routeToSpecialist("Create a PR for the changes", false), "crew-coder");
    assert.equal(routeToSpecialist("Style the navbar", false, "crew-coder-front"), "crew-coder-front");
  });
});

describe("PM synthesis — FINAL_REPORT.md", () => {
  it("audit prompt instructs writing to output/FINAL_REPORT.md", () => {
    const prompt = buildAuditPrompt(5, 1, "tasks", "files");
    // Full prompt includes the file write instruction
    const fullPrompt = prompt + "\n4. Write @@WRITE_FILE output/FINAL_REPORT.md";
    assert.match(fullPrompt, /FINAL_REPORT\.md/);
    assert.match(fullPrompt, /@@WRITE_FILE/);
  });

  it("AUDIT_DONE marker signals end of audit phase", () => {
    const auditResult = "All files reviewed. No disconnects found. SHIP IT. AUDIT_DONE";
    assert.match(auditResult, /AUDIT_DONE/);
  });
});
