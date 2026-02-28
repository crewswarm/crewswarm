/**
 * Integration tests for lib/pipeline/manager.mjs.
 * Uses initPipelineManager with mocked deps; mocks fetch for confirmProject.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  initPipelineManager,
  parseRoadmapPhases,
  findNextRoadmapPhase,
  draftProject,
  confirmProject,
  pendingProjects,
} from "../../lib/pipeline/manager.mjs";

// ── Mock fetch for confirmProject ──────────────────────────────────────────
let fetchCalls = [];
let originalFetch;

before(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    fetchCalls.push({ url, method: opts.method, body: opts.body });
    if (opts.method === "POST" && url.includes("/api/projects")) {
      return {
        ok: true,
        json: async () => ({ ok: true, project: { id: "test-project-id" } }),
      };
    }
    if (opts.method === "POST" && url.includes("/api/pm-loop/start")) {
      return {
        ok: true,
        json: async () => ({ pid: 12345, message: "started" }),
      };
    }
    return originalFetch(url, opts);
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  pendingProjects.clear();
});

// ── parseRoadmapPhases tests (pure function) ───────────────────────────────

describe("pipeline-manager — parseRoadmapPhases", () => {
  it("parses roadmap with ## Phase headers into phases with name and tasks", () => {
    const content = `# Project

## Phase 1 — Foundation
- [ ] Task one
- [ ] Task two

## Phase 2 — Core
- [ ] Task three
`;
    const phases = parseRoadmapPhases(content);
    assert.equal(phases.length, 2);
    assert.ok(phases[0].title.includes("Phase 1"));
    assert.equal(phases[0].items.length, 2);
    assert.equal(phases[0].items[0].text, "- [ ] Task one");
    assert.equal(phases[0].items[0].done, false);
    assert.ok(phases[1].title.includes("Phase 2"));
    assert.equal(phases[1].items.length, 1);
  });

  it("handles mixed checked/unchecked tasks correctly", () => {
    const content = `## Phase 1
- [ ] Pending
- [x] Done
- [ ] Another pending
`;
    const phases = parseRoadmapPhases(content);
    assert.equal(phases.length, 1);
    assert.equal(phases[0].items[0].done, false);
    assert.equal(phases[0].items[1].done, true);
    assert.equal(phases[0].items[2].done, false);
  });

  it("returns single phase or empty when no Phase headers", () => {
    const content = `# Just a title

- [ ] Some task
`;
    const phases = parseRoadmapPhases(content);
    assert.equal(phases.length, 0);
  });

  it("returns [] for empty string", () => {
    const phases = parseRoadmapPhases("");
    assert.deepEqual(phases, []);
  });
});

// ── findNextRoadmapPhase tests (needs temp dir) ────────────────────────────

describe("pipeline-manager — findNextRoadmapPhase", () => {
  it("returns Phase 2 when Phase 1 all done and Phase 2 has pending", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pipeline-"));
    const roadmapPath = join(dir, "ROADMAP.md");
    const content = `# Project

## Phase 1 — Foundation
- [x] Done one
- [x] Done two

## Phase 2 — Core Features
- [ ] Pending A
- [ ] Pending B
`;
    await writeFile(roadmapPath, content, "utf8");

    const phase = findNextRoadmapPhase(dir);
    assert.ok(phase);
    assert.ok(phase.title.includes("Phase 2"));
    assert.equal(phase.items.filter((i) => !i.done).length, 2);

    await rm(dir, { recursive: true, force: true });
  });

  it("returns null when all phases done", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pipeline-"));
    const roadmapPath = join(dir, "ROADMAP.md");
    const content = `# Project

## Phase 1 — Foundation
- [x] Done one
- [x] Done two
`;
    await writeFile(roadmapPath, content, "utf8");

    const phase = findNextRoadmapPhase(dir);
    assert.equal(phase, null);

    await rm(dir, { recursive: true, force: true });
  });
});

// ── draftProject tests ─────────────────────────────────────────────────────

describe("pipeline-manager — draftProject", () => {
  it("adds entry to pendingProjects with correct name/description/outputDir", async () => {
    const outputDir = join(tmpdir(), `draft-${Date.now()}`);
    const result = await draftProject(
      { name: "Test App", description: "a test", outputDir },
      "owner"
    );

    assert.ok(result.draftId);
    assert.equal(result.name, "Test App");
    assert.equal(result.description, "a test");
    assert.equal(result.outputDir, outputDir);
    assert.ok(result.roadmapMd);

    const draft = pendingProjects.get(result.draftId);
    assert.ok(draft);
    assert.equal(draft.name, "Test App");
    assert.equal(draft.description, "a test");
    assert.equal(draft.outputDir, outputDir);
    assert.ok(draft.roadmapMd);

    pendingProjects.delete(result.draftId);
  });

  it("throws when missing name or outputDir", async () => {
    await assert.rejects(
      () => draftProject({ description: "only desc" }, "owner"),
      /name and outputDir|requires name/
    );
  });
});

// ── confirmProject tests (mock fetch) ───────────────────────────────────────

describe("pipeline-manager — confirmProject", () => {
  it("creates ROADMAP.md at outputDir and calls API with correct args", async () => {
    const outputDir = join(tmpdir(), `confirm-${Date.now()}`);
    const draft = await draftProject(
      { name: "Confirm Test", description: "desc", outputDir },
      "owner"
    );

    fetchCalls = [];
    const customRoadmap = `# Custom Roadmap

## Phase 1
- [ ] Custom task one
- [ ] Custom task two
`;

    const result = await confirmProject({
      draftId: draft.draftId,
      roadmapMd: customRoadmap,
    });

    assert.equal(result.name, "Confirm Test");
    assert.equal(result.outputDir, outputDir);
    assert.ok(result.projectId);

    const roadmapPath = join(outputDir, "ROADMAP.md");
    assert.ok(existsSync(roadmapPath));
    const written = await readFile(roadmapPath, "utf8");
    assert.ok(written.includes("Custom Roadmap"));
    assert.ok(written.includes("Custom task one"));

    const projectsCall = fetchCalls.find(
      (c) => c.url.includes("/api/projects") && c.method === "POST"
    );
    assert.ok(projectsCall);
    const body = JSON.parse(projectsCall.body || "{}");
    assert.equal(body.name, "Confirm Test");
    assert.equal(body.outputDir, outputDir);

    const pmStartCall = fetchCalls.find(
      (c) => c.url.includes("/api/pm-loop/start") && c.method === "POST"
    );
    assert.ok(pmStartCall);

    await rm(outputDir, { recursive: true, force: true }).catch(() => {});
  });

  it("throws for unknown/stale draftId", async () => {
    await assert.rejects(
      () =>
        confirmProject({
          draftId: "nonexistent-uuid-12345",
          roadmapMd: "# X\n",
        }),
      /No pending project|draftId/
    );
  });
});
