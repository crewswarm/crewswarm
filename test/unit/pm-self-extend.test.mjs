/**
 * Unit tests for pm-loop self-extend logic.
 * pm-loop.mjs auto-runs on import, so we extract and test the logic inline.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── appendGeneratedItems logic (inline from pm-loop.mjs) ───────────────────
async function appendGeneratedItems(roadmapPath, newItems, round) {
  if (!newItems.length) return;
  const content = await readFile(roadmapPath, "utf8");
  const section =
    `\n---\n\n## PM-Generated (Round ${round})\n\n` +
    newItems.map((item) => `- [ ] ${item}`).join("\n") +
    "\n";
  await writeFile(roadmapPath, content + section, "utf8");
}

// ── generateNewRoadmapItems fallback (inline from pm-loop.mjs) ──────────────
function generateNewRoadmapItemsFallback(provider) {
  if (!provider) {
    return [
      "Improve typography: add font-weight hierarchy and tighter line-height for all headings",
      "Add aria-label attributes to all interactive elements for accessibility",
      "Add a 'Back to top' floating button that appears after scrolling 300px",
    ];
  }
  return []; // when provider exists, LLM is used — not tested here
}

// ── pickNextItem (from pm-loop-routing style) ─────────────────────────────
function pickNextItem(roadmapContent) {
  const lines = roadmapContent.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^- \[ \]/.test(line)) {
      return { lineIdx: i, text: line.replace(/^- \[ \]\s*/, "").trim() };
    }
  }
  return null;
}

// ── EXTEND_EVERY_N logic (inline from pm-loop.mjs main loop) ───────────────
function shouldExtend(completedCount, EXTEND_EVERY_N, pending) {
  return (
    completedCount > 0 &&
    completedCount % EXTEND_EVERY_N === 0 &&
    pending === 0
  );
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("pm-loop — appendGeneratedItems", () => {
  it("appends PM-Generated section with correct format", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pm-extend-"));
    const roadmapPath = join(dir, "ROADMAP.md");
    const initial = "# My Project\n\n- [ ] Existing task\n";
    await writeFile(roadmapPath, initial, "utf8");

    await appendGeneratedItems(
      roadmapPath,
      ["item1", "item2"],
      1
    );

    const content = await readFile(roadmapPath, "utf8");
    assert.ok(content.includes("## PM-Generated (Round 1)"));
    assert.ok(content.includes("- [ ] item1"));
    assert.ok(content.includes("- [ ] item2"));
    assert.ok(content.startsWith("# My Project"));
    assert.ok(content.includes("- [ ] Existing task"));
    await rm(dir, { recursive: true, force: true });
  });

  it("preserves existing content when appending", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pm-extend-"));
    const roadmapPath = join(dir, "ROADMAP.md");
    const initial = "# Original\n\n- [x] Done\n- [ ] Pending\n";
    await writeFile(roadmapPath, initial, "utf8");

    await appendGeneratedItems(roadmapPath, ["new task A"], 2);

    const content = await readFile(roadmapPath, "utf8");
    assert.ok(content.includes("# Original"));
    assert.ok(content.includes("- [x] Done"));
    assert.ok(content.includes("- [ ] Pending"));
    assert.ok(content.includes("## PM-Generated (Round 2)"));
    assert.ok(content.includes("- [ ] new task A"));
    await rm(dir, { recursive: true, force: true });
  });

  it("uses correct heading for round=1", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pm-extend-"));
    const roadmapPath = join(dir, "ROADMAP.md");
    await writeFile(roadmapPath, "# X\n", "utf8");

    await appendGeneratedItems(roadmapPath, ["a"], 1);

    const content = await readFile(roadmapPath, "utf8");
    assert.ok(content.includes("## PM-Generated (Round 1)"));
    await rm(dir, { recursive: true, force: true });
  });

  it("leaves file unchanged when newItems is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pm-extend-"));
    const roadmapPath = join(dir, "ROADMAP.md");
    const initial = "# Original\n\n- [ ] One\n";
    await writeFile(roadmapPath, initial, "utf8");

    await appendGeneratedItems(roadmapPath, [], 1);

    const content = await readFile(roadmapPath, "utf8");
    assert.equal(content, initial);
    assert.ok(!content.includes("PM-Generated"));
    await rm(dir, { recursive: true, force: true });
  });
});

describe("pm-loop — generateNewRoadmapItems fallback", () => {
  it("returns exactly 3 items when no provider", () => {
    const items = generateNewRoadmapItemsFallback(null);
    assert.equal(items.length, 3);
  });

  it("fallback items are non-empty strings longer than 10 chars", () => {
    const items = generateNewRoadmapItemsFallback(null);
    for (const item of items) {
      assert.ok(typeof item === "string");
      assert.ok(item.length > 10);
      assert.ok(item.trim().length > 0);
    }
  });
});

describe("pm-loop — pickNextItem after self-extend", () => {
  it("picks unchecked items when roadmap has only PM-Generated items", () => {
    const md = `## PM-Generated (Round 1)

- [ ] new task A
- [ ] new task B
`;
    const item = pickNextItem(md);
    assert.ok(item);
    assert.equal(item.text, "new task A");
  });

  it("returns only unchecked when mix of done and pending", () => {
    const md = `# Roadmap

- [x] Done task
- [ ] Pending task
- [x] Another done
`;
    const item = pickNextItem(md);
    assert.ok(item);
    assert.equal(item.text, "Pending task");
  });
});

describe("pm-loop — EXTEND_EVERY_N logic", () => {
  const EXTEND_EVERY_N = 5;

  it("should extend when completedCount=5, EXTEND_EVERY_N=5, pending=0", () => {
    assert.ok(shouldExtend(5, EXTEND_EVERY_N, 0));
  });

  it("should NOT extend when completedCount=4, EXTEND_EVERY_N=5, pending=0", () => {
    assert.ok(!shouldExtend(4, EXTEND_EVERY_N, 0));
  });

  it("should NOT extend when completedCount=5, EXTEND_EVERY_N=5, pending=2", () => {
    assert.ok(!shouldExtend(5, EXTEND_EVERY_N, 2));
  });
});
