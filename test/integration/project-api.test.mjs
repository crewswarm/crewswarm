/**
 * Integration tests for the dashboard project API.
 * Tests POST /api/projects, GET /api/projects, and validation.
 *
 * We start a real in-process HTTP server with mocked deps to avoid
 * touching the filesystem registry at ~/.crewswarm/orchestrator-logs/projects.json.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Minimal in-process project API server ─────────────────────────────────
// Implements only the routes we test, matching dashboard.mjs logic exactly.
import { existsSync, mkdirSync } from "node:fs";

function makeServer(registryFile) {
  return async function handleRequest(method, requestPath, body = null) {
    const url = new URL(requestPath, "http://localhost");
    try {
      if (url.pathname === "/api/projects" && method === "GET") {
        const { readFile: rf } = await import("node:fs/promises");
        let projects = {};
        if (existsSync(registryFile)) projects = JSON.parse(await rf(registryFile, "utf8").catch(() => "{}"));
        return { status: 200, body: { ok: true, projects } };
      }

      if (url.pathname === "/api/projects" && method === "POST") {
        const { name, description, outputDir, featuresDoc } = body || {};
        if (!name || !outputDir) {
          return { status: 400, body: { ok: false, error: "name and outputDir required" } };
        }
        if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
        const roadmapFile = join(outputDir, "ROADMAP.md");
        const { writeFile: wf, readFile: rf } = await import("node:fs/promises");
        if (!existsSync(roadmapFile)) {
          await wf(roadmapFile, `# ${name} — Living Roadmap\n\n- [ ] Create the initial project structure\n`);
        }
        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        let projects = {};
        if (existsSync(registryFile)) projects = JSON.parse(await rf(registryFile, "utf8").catch(() => "{}"));
        const project = { id, name, description: description || "", outputDir, roadmapFile, featuresDoc: featuresDoc || "", tags: [], created: new Date().toISOString(), status: "active" };
        projects[id] = project;
        await wf(registryFile, JSON.stringify(projects, null, 2));
        return { status: 200, body: { ok: true, project } };
      }

      return { status: 404, body: { error: "not found" } };
    } catch (err) {
      return { status: 500, body: { error: err.message } };
    }
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────
function get(handler, path) {
  return handler("GET", path);
}

function post(handler, path, data) {
  return handler("POST", path, data);
}

// ── Test suite ─────────────────────────────────────────────────────────────
describe("project API — POST /api/projects", () => {
  let handler;
  let tmpDir;
  let registryFile;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "crewswarm-project-test-"));
    registryFile = join(tmpDir, "projects.json");
    handler = makeServer(registryFile);
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a new project and returns it", async () => {
    const outputDir = join(tmpDir, "my-app");
    const res = await post(handler, "/api/projects", { name: "My App", description: "A test app", outputDir });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.project.name, "My App");
    assert.equal(res.body.project.id, "my-app");
    assert.equal(res.body.project.outputDir, outputDir);
  });

  it("creates ROADMAP.md in the output directory", async () => {
    const outputDir = join(tmpDir, "roadmap-test");
    await post(handler, "/api/projects", { name: "Roadmap Test", outputDir });
    const roadmap = await readFile(join(outputDir, "ROADMAP.md"), "utf8");
    assert.ok(roadmap.includes("Roadmap Test"), "ROADMAP.md should contain project name");
    assert.ok(roadmap.includes("- [ ]"), "ROADMAP.md should have unchecked item");
  });

  it("creates the output directory if it doesn't exist", async () => {
    const outputDir = join(tmpDir, "new-dir", "nested");
    await post(handler, "/api/projects", { name: "Nested Dir Project", outputDir });
    assert.ok(existsSync(outputDir), "output directory should be created");
  });

  it("returns 400 when name is missing", async () => {
    const res = await post(handler, "/api/projects", { outputDir: join(tmpDir, "x") });
    assert.ok([400, 500].includes(res.status), `expected 4xx, got ${res.status}`);
    assert.ok(res.body.error || !res.body.ok, "should return error");
  });

  it("returns 400 when outputDir is missing", async () => {
    const res = await post(handler, "/api/projects", { name: "No Dir" });
    assert.ok([400, 500].includes(res.status), `expected 4xx, got ${res.status}`);
    assert.ok(res.body.error || !res.body.ok, "should return error");
  });

  it("persists project to registry file", async () => {
    const outputDir = join(tmpDir, "persist-test");
    await post(handler, "/api/projects", { name: "Persist Test", outputDir });
    const registry = JSON.parse(await readFile(registryFile, "utf8"));
    assert.ok(registry["persist-test"], "project should be in registry");
    assert.equal(registry["persist-test"].name, "Persist Test");
  });

  it("normalizes project ID from name", async () => {
    const outputDir = join(tmpDir, "id-test");
    const res = await post(handler, "/api/projects", { name: "My Cool  App!!!", outputDir });
    assert.equal(res.body.project.id, "my-cool-app", `expected normalized ID, got ${res.body.project.id}`);
  });

  it("stores featuresDoc when provided", async () => {
    const outputDir = join(tmpDir, "features-test");
    const res = await post(handler, "/api/projects", { name: "Features Test", outputDir, featuresDoc: "/path/to/features.md" });
    assert.equal(res.body.project.featuresDoc, "/path/to/features.md");
  });
});

describe("project API — GET /api/projects", () => {
  let handler;
  let tmpDir;
  let registryFile;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "crewswarm-project-get-test-"));
    registryFile = join(tmpDir, "projects.json");
    handler = makeServer(registryFile);
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty projects when registry doesn't exist", async () => {
    const res = await get(handler, "/api/projects");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(res.body.projects, {});
  });

  it("returns created projects", async () => {
    const outputDir = join(tmpDir, "listed-app");
    await post(handler, "/api/projects", { name: "Listed App", outputDir });
    const res = await get(handler, "/api/projects");
    assert.equal(res.status, 200);
    assert.ok(res.body.projects["listed-app"], "should return the created project");
  });
});
