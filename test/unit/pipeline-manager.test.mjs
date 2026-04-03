/**
 * Unit tests for lib/pipeline/manager.mjs
 *
 * Covers:
 *  - initPipelineManager: dependency injection
 *  - pendingProjects: exported Map, lifecycle
 *  - draftProject: happy path, missing args, roadmap content, draftId uniqueness
 *  - confirmProject: draft consumption, file creation, missing draftId
 *  - parseRoadmapPhases: correct phase/item parsing, done/failed markers, empty input
 *  - findNextRoadmapPhase: file not found, all done, partial done, returns first incomplete
 *  - autoAdvanceRoadmap: no project dir, all phases complete, triggers handleChat
 *
 * No live network calls are made. fetch is globally mocked before tests run.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Temporary directory ───────────────────────────────────────────────────────

const TMP_DIR = path.join(os.tmpdir(), `crew-pm-test-${process.pid}`);

function makeTmp(subdir = "") {
  const dir = subdir ? path.join(TMP_DIR, subdir) : TMP_DIR;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Mock global fetch before the module is imported ──────────────────────────
// manager.mjs calls fetch for: generateRoadmarkWithAI (via PM LLM providers) and confirmProject.
// We provide a default that returns a successful project creation response.

let _mockFetchImpl = null;

globalThis.fetch = async (url, opts) => {
  if (_mockFetchImpl) return _mockFetchImpl(url, opts);
  // Default: project creation
  if (String(url).includes("/api/projects")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, project: { id: "proj-123" } }),
      text: async () => JSON.stringify({ ok: true, project: { id: "proj-123" } }),
    };
  }
  // Default: pm-loop/start
  if (String(url).includes("/api/pm-loop/start")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, message: "started" }),
      text: async () => "",
    };
  }
  // Default: LLM provider — return non-ok so we fall through to template
  return {
    ok: false,
    status: 500,
    json: async () => ({}),
    text: async () => "error",
  };
};

// ── Import module under test ──────────────────────────────────────────────────

const {
  initPipelineManager,
  pendingProjects,
  draftProject,
  confirmProject,
  parseRoadmapPhases,
  findNextRoadmapPhase,
  autoAdvanceRoadmap,
} = await import("../../lib/pipeline/manager.mjs");

// ── Shared mock deps ──────────────────────────────────────────────────────────

function createMockDeps(overrides = {}) {
  const broadcastSSE = (...args) => (broadcastSSE.calls = broadcastSSE.calls || []).push(args);
  broadcastSSE.calls = [];
  const appendHistory = (...args) => (appendHistory.calls = appendHistory.calls || []).push(args);
  appendHistory.calls = [];
  const handleChat = async (...args) => (handleChat.calls = handleChat.calls || []).push(args);
  handleChat.calls = [];

  return {
    broadcastSSE,
    appendHistory,
    handleChat,
    loadConfig: () => ({}),
    ...overrides,
  };
}

// ── Test lifecycle ────────────────────────────────────────────────────────────

before(() => {
  makeTmp();
});

after(() => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  pendingProjects.clear();
  _mockFetchImpl = null;
  // Reset to default mock deps
  const deps = createMockDeps();
  initPipelineManager({
    dashboard: "http://127.0.0.1:4319",
    ...deps,
  });
});

// ── initPipelineManager ───────────────────────────────────────────────────────

describe("initPipelineManager", () => {
  it("accepts all dependency fields without throwing", () => {
    const deps = createMockDeps();
    assert.doesNotThrow(() => initPipelineManager({
      dashboard: "http://localhost:9999",
      ...deps,
    }));
  });

  it("accepts empty options without throwing", () => {
    assert.doesNotThrow(() => initPipelineManager({}));
  });

  it("accepts no arguments without throwing (defaults to empty)", () => {
    assert.doesNotThrow(() => initPipelineManager());
  });

  it("accepts partial options (only broadcastSSE)", () => {
    assert.doesNotThrow(() => initPipelineManager({ broadcastSSE: () => {} }));
  });
});

// ── pendingProjects ───────────────────────────────────────────────────────────

describe("pendingProjects", () => {
  it("is an exported Map", () => {
    assert.ok(pendingProjects instanceof Map);
  });

  it("starts empty after beforeEach clear", () => {
    assert.equal(pendingProjects.size, 0);
  });
});

// ── draftProject ──────────────────────────────────────────────────────────────

describe("draftProject", () => {
  it("returns a draftId, name, description, outputDir, and roadmapMd", async () => {
    const outputDir = path.join(TMP_DIR, "draft-project");
    const result = await draftProject({ name: "Test App", description: "A test", outputDir }, "session-1");
    assert.ok(typeof result.draftId === "string");
    assert.ok(result.draftId.length > 0);
    assert.equal(result.name, "Test App");
    assert.equal(result.description, "A test");
    assert.equal(result.outputDir, outputDir);
    assert.ok(typeof result.roadmapMd === "string");
    assert.ok(result.roadmapMd.length > 0);
  });

  it("adds the draft to pendingProjects Map", async () => {
    const outputDir = path.join(TMP_DIR, "draft-map-check");
    const result = await draftProject({ name: "Map App", description: "", outputDir }, "session-2");
    assert.ok(pendingProjects.has(result.draftId));
    const entry = pendingProjects.get(result.draftId);
    assert.equal(entry.name, "Map App");
    assert.equal(entry.sessionId, "session-2");
  });

  it("generates unique draftIds across multiple calls", async () => {
    const outputDir = path.join(TMP_DIR, "unique-ids");
    const r1 = await draftProject({ name: "App 1", description: "", outputDir }, "s1");
    const r2 = await draftProject({ name: "App 2", description: "", outputDir }, "s2");
    assert.notEqual(r1.draftId, r2.draftId);
  });

  it("throws when name is missing", async () => {
    await assert.rejects(
      () => draftProject({ outputDir: "/tmp/foo" }, "session-x"),
      /requires name and outputDir/
    );
  });

  it("throws when outputDir is missing", async () => {
    await assert.rejects(
      () => draftProject({ name: "MyApp" }, "session-x"),
      /requires name and outputDir/
    );
  });

  it("uses template roadmap when no LLM providers are configured", async () => {
    const outputDir = path.join(TMP_DIR, "template-roadmap");
    const result = await draftProject({ name: "Template Test", description: "desc", outputDir }, "s");
    // The template roadmap starts with "# Template Test — Living Roadmap"
    assert.ok(result.roadmapMd.includes("Template Test"));
    assert.ok(result.roadmapMd.includes("Phase"));
  });

  it("falls back to template roadmap when LLM provider returns non-ok response", async () => {
    _mockFetchImpl = async (url) => ({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => "Service Unavailable",
    });
    const outputDir = path.join(TMP_DIR, "fallback-roadmap");
    const result = await draftProject({ name: "Fallback App", description: "", outputDir }, "s");
    assert.ok(result.roadmapMd.includes("Phase"));
  });
});

// ── confirmProject ────────────────────────────────────────────────────────────

describe("confirmProject", () => {
  it("creates project, writes files, removes draft from pendingProjects", async () => {
    const outputDir = path.join(TMP_DIR, "confirm-test");
    const broadcastSSE = (p) => (broadcastSSE.calls = broadcastSSE.calls || []).push(p);
    broadcastSSE.calls = [];
    const appendHistory = (...args) => {};

    initPipelineManager({ dashboard: "http://127.0.0.1:4319", broadcastSSE, appendHistory });

    const draftResult = await draftProject({ name: "Confirm App", description: "testing confirm", outputDir }, "s1");
    const { draftId } = draftResult;
    assert.ok(pendingProjects.has(draftId));

    const confirmed = await confirmProject({ draftId });
    assert.equal(confirmed.name, "Confirm App");
    assert.equal(confirmed.outputDir, outputDir);
    assert.ok(typeof confirmed.projectId === "string");

    // Draft removed
    assert.ok(!pendingProjects.has(draftId));

    // Files written
    assert.ok(fs.existsSync(path.join(outputDir, "ROADMAP.md")));
    assert.ok(fs.existsSync(path.join(outputDir, "PDD.md")));
    assert.ok(fs.existsSync(path.join(outputDir, "TECH-SPEC.md")));
  });

  it("uses overrideMd when provided", async () => {
    const outputDir = path.join(TMP_DIR, "override-roadmap");
    const draftResult = await draftProject({ name: "Override App", description: "", outputDir }, "s");
    const customRoadmap = "# Custom Roadmap\n\n## Phase 1 — Foundation\n- [ ] Custom task\n";
    await confirmProject({ draftId: draftResult.draftId, roadmapMd: customRoadmap });
    const written = fs.readFileSync(path.join(outputDir, "ROADMAP.md"), "utf8");
    assert.equal(written, customRoadmap);
  });

  it("does not overwrite existing PDD.md", async () => {
    const outputDir = path.join(TMP_DIR, "existing-pdd");
    fs.mkdirSync(outputDir, { recursive: true });
    const existingPdd = "# Existing PDD — do not overwrite\n";
    fs.writeFileSync(path.join(outputDir, "PDD.md"), existingPdd, "utf8");

    const draftResult = await draftProject({ name: "Existing PDD App", description: "", outputDir }, "s");
    await confirmProject({ draftId: draftResult.draftId });
    const pddContent = fs.readFileSync(path.join(outputDir, "PDD.md"), "utf8");
    assert.equal(pddContent, existingPdd);
  });

  it("does not overwrite existing TECH-SPEC.md", async () => {
    const outputDir = path.join(TMP_DIR, "existing-techspec");
    fs.mkdirSync(outputDir, { recursive: true });
    const existingSpec = "# Existing Tech Spec\n";
    fs.writeFileSync(path.join(outputDir, "TECH-SPEC.md"), existingSpec, "utf8");

    const draftResult = await draftProject({ name: "Existing Spec App", description: "", outputDir }, "s");
    await confirmProject({ draftId: draftResult.draftId });
    const specContent = fs.readFileSync(path.join(outputDir, "TECH-SPEC.md"), "utf8");
    assert.equal(specContent, existingSpec);
  });

  it("throws when draftId is not found in pendingProjects", async () => {
    await assert.rejects(
      () => confirmProject({ draftId: "nonexistent-draft-id" }),
      /No pending project for draftId/
    );
  });

  it("throws when dashboard returns ok:false", async () => {
    _mockFetchImpl = async (url) => {
      if (String(url).includes("/api/projects")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: false, error: "duplicate name" }),
          text: async () => "",
        };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    };

    const outputDir = path.join(TMP_DIR, "confirm-fail");
    const draftResult = await draftProject({ name: "Fail App", description: "", outputDir }, "s");
    await assert.rejects(
      () => confirmProject({ draftId: draftResult.draftId }),
      /Failed to create project/
    );
  });

  it("broadcasts project_launched SSE event on success", async () => {
    const outputDir = path.join(TMP_DIR, "sse-broadcast");
    const broadcastSSE = (p) => (broadcastSSE.calls = broadcastSSE.calls || []).push(p);
    broadcastSSE.calls = [];
    initPipelineManager({ dashboard: "http://127.0.0.1:4319", broadcastSSE, appendHistory: () => {} });

    const draftResult = await draftProject({ name: "SSE App", description: "", outputDir }, "s");
    await confirmProject({ draftId: draftResult.draftId });
    assert.ok(broadcastSSE.calls.some(p => p.type === "project_launched"));
  });
});

// ── parseRoadmapPhases ────────────────────────────────────────────────────────

describe("parseRoadmapPhases", () => {
  it("returns empty array for empty string", () => {
    const phases = parseRoadmapPhases("");
    assert.deepEqual(phases, []);
  });

  it("returns empty array for content with no phase headers", () => {
    const phases = parseRoadmapPhases("Just some text without phases.\n- [ ] item");
    assert.deepEqual(phases, []);
  });

  it("parses a single phase with unchecked items", () => {
    const content = `# My Project — Living Roadmap\n\n## Phase 1 — Foundation\n\n- [ ] Task one\n- [ ] Task two\n`;
    const phases = parseRoadmapPhases(content);
    assert.equal(phases.length, 1);
    assert.ok(phases[0].title.includes("Phase 1"));
    assert.equal(phases[0].items.length, 2);
    assert.equal(phases[0].items[0].done, false);
    assert.equal(phases[0].items[1].done, false);
  });

  it("parses checked items as done=true", () => {
    const content = `## Phase 1 — Foundation\n- [x] Done task\n- [X] Also done\n- [ ] Pending\n`;
    const phases = parseRoadmapPhases(content);
    assert.equal(phases.length, 1);
    assert.equal(phases[0].items[0].done, true);
    assert.equal(phases[0].items[1].done, true);
    assert.equal(phases[0].items[2].done, false);
  });

  it("parses [!] items as failed=true", () => {
    const content = `## Phase 1 — Foundation\n- [!] Failed task\n- [ ] Normal task\n`;
    const phases = parseRoadmapPhases(content);
    assert.equal(phases[0].items[0].failed, true);
    assert.equal(phases[0].items[0].done, false);
    assert.equal(phases[0].items[1].failed, false);
  });

  it("parses multiple phases", () => {
    const content = [
      "## Phase 1 — Foundation",
      "- [ ] Task A",
      "- [x] Task B",
      "",
      "## Phase 2 — Core Features",
      "- [ ] Task C",
      "",
      "## Phase 3 — Polish & Ship",
      "- [x] Task D",
    ].join("\n");
    const phases = parseRoadmapPhases(content);
    assert.equal(phases.length, 3);
    assert.equal(phases[0].items.length, 2);
    assert.equal(phases[1].items.length, 1);
    assert.equal(phases[2].items.length, 1);
  });

  it("phase items include the full text of the checkbox line", () => {
    const content = `## Phase 1 — Foundation\n- [ ] Build the main feature with React\n`;
    const phases = parseRoadmapPhases(content);
    assert.ok(phases[0].items[0].text.includes("Build the main feature with React"));
  });

  it("ignores non-checkbox lines within a phase", () => {
    const content = `## Phase 1 — Foundation\nSome description text here.\n- [ ] Real task\nMore text.\n`;
    const phases = parseRoadmapPhases(content);
    assert.equal(phases[0].items.length, 1);
  });

  it("handles phase headers with em-dash", () => {
    const content = `## Phase 1 — Core Features\n- [ ] Task\n`;
    const phases = parseRoadmapPhases(content);
    assert.equal(phases.length, 1);
    assert.ok(phases[0].title.includes("Core Features"));
  });

  it("handles phase headers at h1, h2, h3 levels", () => {
    const content = [
      "# Phase 1 — Level One",
      "- [ ] Item",
      "## Phase 2 — Level Two",
      "- [ ] Item",
      "### Phase 3 — Level Three",
      "- [ ] Item",
    ].join("\n");
    const phases = parseRoadmapPhases(content);
    assert.equal(phases.length, 3);
  });

  it("handles indented checkbox items", () => {
    const content = `## Phase 1 — Foundation\n  - [ ] Indented task\n`;
    const phases = parseRoadmapPhases(content);
    assert.equal(phases[0].items.length, 1);
  });

  it("returns correct done counts for mixed phase", () => {
    const content = [
      "## Phase 1 — Foundation",
      "- [x] Done 1",
      "- [x] Done 2",
      "- [ ] Pending 1",
      "- [ ] Pending 2",
      "- [ ] Pending 3",
    ].join("\n");
    const phases = parseRoadmapPhases(content);
    const done = phases[0].items.filter(i => i.done);
    const pending = phases[0].items.filter(i => !i.done);
    assert.equal(done.length, 2);
    assert.equal(pending.length, 3);
  });
});

// ── findNextRoadmapPhase ──────────────────────────────────────────────────────

describe("findNextRoadmapPhase", () => {
  it("returns null when projectDir is undefined", () => {
    assert.equal(findNextRoadmapPhase(undefined), null);
  });

  it("returns null when ROADMAP.md does not exist", () => {
    const dir = path.join(TMP_DIR, "no-roadmap");
    fs.mkdirSync(dir, { recursive: true });
    const result = findNextRoadmapPhase(dir);
    assert.equal(result, null);
  });

  it("returns null when all items are done", () => {
    const dir = path.join(TMP_DIR, "all-done");
    fs.mkdirSync(dir, { recursive: true });
    const roadmap = [
      "## Phase 1 — Foundation",
      "- [x] Task one",
      "- [x] Task two",
      "",
      "## Phase 2 — Core Features",
      "- [x] Task three",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "ROADMAP.md"), roadmap, "utf8");
    const result = findNextRoadmapPhase(dir);
    assert.equal(result, null);
  });

  it("returns the first phase with pending items", () => {
    const dir = path.join(TMP_DIR, "first-incomplete");
    fs.mkdirSync(dir, { recursive: true });
    const roadmap = [
      "## Phase 1 — Foundation",
      "- [x] Task one",
      "- [ ] Task two",
      "",
      "## Phase 2 — Core Features",
      "- [ ] Task three",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "ROADMAP.md"), roadmap, "utf8");
    const result = findNextRoadmapPhase(dir);
    assert.ok(result !== null);
    assert.ok(result.title.includes("Phase 1"));
  });

  it("skips fully-done phase and returns next incomplete phase", () => {
    const dir = path.join(TMP_DIR, "skip-done-phase");
    fs.mkdirSync(dir, { recursive: true });
    const roadmap = [
      "## Phase 1 — Foundation",
      "- [x] Task one",
      "",
      "## Phase 2 — Core Features",
      "- [ ] Task two",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "ROADMAP.md"), roadmap, "utf8");
    const result = findNextRoadmapPhase(dir);
    assert.ok(result.title.includes("Phase 2"));
  });

  it("returns null when ROADMAP.md is empty", () => {
    const dir = path.join(TMP_DIR, "empty-roadmap");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ROADMAP.md"), "", "utf8");
    const result = findNextRoadmapPhase(dir);
    assert.equal(result, null);
  });

  it("returns null when ROADMAP.md has phases but no items", () => {
    const dir = path.join(TMP_DIR, "phases-no-items");
    fs.mkdirSync(dir, { recursive: true });
    const roadmap = "## Phase 1 — Foundation\n\nSome description only, no items.\n";
    fs.writeFileSync(path.join(dir, "ROADMAP.md"), roadmap, "utf8");
    const result = findNextRoadmapPhase(dir);
    assert.equal(result, null);
  });
});

// ── autoAdvanceRoadmap ────────────────────────────────────────────────────────

describe("autoAdvanceRoadmap", () => {
  it("returns early without throwing when projectDir is falsy", async () => {
    await assert.doesNotReject(() => autoAdvanceRoadmap(null, "session-1"));
    await assert.doesNotReject(() => autoAdvanceRoadmap(undefined, "session-1"));
    await assert.doesNotReject(() => autoAdvanceRoadmap("", "session-1"));
  });

  it("logs and returns when all phases are complete (no handleChat call)", async () => {
    const dir = path.join(TMP_DIR, "auto-advance-done");
    fs.mkdirSync(dir, { recursive: true });
    const roadmap = [
      "## Phase 1 — Foundation",
      "- [x] Task one",
      "- [x] Task two",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "ROADMAP.md"), roadmap, "utf8");

    const handleChat = async (...args) => { handleChat.calls = handleChat.calls || []; handleChat.calls.push(args); };
    handleChat.calls = [];
    initPipelineManager({ handleChat, broadcastSSE: () => {}, appendHistory: () => {} });

    await autoAdvanceRoadmap(dir, "session-1");
    assert.equal((handleChat.calls || []).length, 0);
  });

  it("calls handleChat with the next phase task when there are pending items", async () => {
    const dir = path.join(TMP_DIR, "auto-advance-pending");
    fs.mkdirSync(dir, { recursive: true });
    const roadmap = [
      "## Phase 1 — Foundation",
      "- [ ] Build scaffolding",
      "- [ ] Write README",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "ROADMAP.md"), roadmap, "utf8");

    const handleChat = async (...args) => { handleChat.calls = handleChat.calls || []; handleChat.calls.push(args); };
    handleChat.calls = [];
    const broadcastSSE = (p) => { broadcastSSE.calls = broadcastSSE.calls || []; broadcastSSE.calls.push(p); };
    broadcastSSE.calls = [];
    initPipelineManager({ handleChat, broadcastSSE, appendHistory: () => {} });

    await autoAdvanceRoadmap(dir, "session-2");
    assert.equal(handleChat.calls.length, 1);
    const [callArg] = handleChat.calls[0];
    assert.ok(callArg.message.includes("Phase 1"));
    assert.ok(callArg.message.includes("Build scaffolding"));
    assert.equal(callArg.sessionId, "session-2");
    assert.equal(callArg._autoAdvance, true);
  });

  it("broadcasts roadmap_advance SSE event when advancing", async () => {
    const dir = path.join(TMP_DIR, "auto-advance-sse");
    fs.mkdirSync(dir, { recursive: true });
    const roadmap = [
      "## Phase 2 — Core Features",
      "- [ ] Implement API",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "ROADMAP.md"), roadmap, "utf8");

    const broadcastSSE = (p) => { broadcastSSE.calls = broadcastSSE.calls || []; broadcastSSE.calls.push(p); };
    broadcastSSE.calls = [];
    initPipelineManager({ handleChat: async () => {}, broadcastSSE, appendHistory: () => {} });

    await autoAdvanceRoadmap(dir, "session-3");
    assert.ok(broadcastSSE.calls.some(p => p.type === "roadmap_advance"));
    const evt = broadcastSSE.calls.find(p => p.type === "roadmap_advance");
    assert.ok(evt.phase.includes("Phase 2"));
    assert.equal(evt.projectDir, dir);
  });

  it("includes @@READ_FILE and @@PIPELINE directives in the task message", async () => {
    const dir = path.join(TMP_DIR, "auto-advance-directives");
    fs.mkdirSync(dir, { recursive: true });
    const roadmap = [
      "## Phase 1 — Foundation",
      "- [ ] Task X",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "ROADMAP.md"), roadmap, "utf8");

    const handleChat = async (...args) => { handleChat.calls = handleChat.calls || []; handleChat.calls.push(args); };
    handleChat.calls = [];
    initPipelineManager({ handleChat, broadcastSSE: () => {}, appendHistory: () => {} });

    await autoAdvanceRoadmap(dir, "session-4");
    const [callArg] = handleChat.calls[0];
    assert.ok(callArg.message.includes("@@READ_FILE"));
    assert.ok(callArg.message.includes("@@PIPELINE"));
  });

  it("returns early without throwing when ROADMAP.md does not exist", async () => {
    const dir = path.join(TMP_DIR, "auto-advance-no-roadmap");
    fs.mkdirSync(dir, { recursive: true });
    // No ROADMAP.md

    const handleChat = async (...args) => { handleChat.calls = handleChat.calls || []; handleChat.calls.push(args); };
    handleChat.calls = [];
    initPipelineManager({ handleChat, broadcastSSE: () => {}, appendHistory: () => {} });

    await assert.doesNotReject(() => autoAdvanceRoadmap(dir, "session-5"));
    assert.equal((handleChat.calls || []).length, 0);
  });
});
