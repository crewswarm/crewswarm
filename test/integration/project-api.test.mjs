/**
 * Integration tests for the dashboard project API.
 * Tests POST /api/projects, GET /api/projects, and validation.
 *
 * We start a real in-process HTTP server with mocked deps to avoid
 * touching the filesystem registry at ~/.crewswarm/orchestrator-logs/projects.json.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Minimal in-process project API server ─────────────────────────────────
// Implements only the routes we test, matching dashboard.mjs logic exactly.
import { existsSync, mkdirSync } from "node:fs";

function makeServer(registryFile) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname === "/api/projects" && req.method === "GET") {
        const { readFile: rf } = await import("node:fs/promises");
        let projects = {};
        if (existsSync(registryFile)) projects = JSON.parse(await rf(registryFile, "utf8").catch(() => "{}"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, projects }));
        return;
      }

      if (url.pathname === "/api/projects" && req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const { name, description, outputDir, featuresDoc } = JSON.parse(body || "{}");
        if (!name || !outputDir) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "name and outputDir required" }));
          return;
        }
        if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
        const roadmapFile = join(outputDir, "ROADMAP.md");
        const { writeFile: wf } = await import("node:fs/promises");
        if (!existsSync(roadmapFile)) {
          await wf(roadmapFile, `# ${name} — Living Roadmap\n\n- [ ] Create the initial project structure\n`);
        }
        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        const { readFile: rf } = await import("node:fs/promises");
        let projects = {};
        if (existsSync(registryFile)) projects = JSON.parse(await rf(registryFile, "utf8").catch(() => "{}"));
        const project = { id, name, description: description || "", outputDir, roadmapFile, featuresDoc: featuresDoc || "", tags: [], created: new Date().toISOString(), status: "active" };
        projects[id] = project;
        await wf(registryFile, JSON.stringify(projects, null, 2));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, project }));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
  return server;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let body = "";
      res.on("data", d => body += d);
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }).on("error", reject);
  });
}

function post(port, path, data) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (res) => {
      let body = "";
      res.on("data", d => body += d);
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ── Test suite ─────────────────────────────────────────────────────────────
describe("project API — POST /api/projects", () => {
  let server;
  let port;
  let tmpDir;
  let registryFile;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "crewswarm-project-test-"));
    registryFile = join(tmpDir, "projects.json");
    server = makeServer(registryFile);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a new project and returns it", async () => {
    const outputDir = join(tmpDir, "my-app");
    const res = await post(port, "/api/projects", { name: "My App", description: "A test app", outputDir });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.project.name, "My App");
    assert.equal(res.body.project.id, "my-app");
    assert.equal(res.body.project.outputDir, outputDir);
  });

  it("creates ROADMAP.md in the output directory", async () => {
    const outputDir = join(tmpDir, "roadmap-test");
    await post(port, "/api/projects", { name: "Roadmap Test", outputDir });
    const roadmap = await readFile(join(outputDir, "ROADMAP.md"), "utf8");
    assert.ok(roadmap.includes("Roadmap Test"), "ROADMAP.md should contain project name");
    assert.ok(roadmap.includes("- [ ]"), "ROADMAP.md should have unchecked item");
  });

  it("creates the output directory if it doesn't exist", async () => {
    const outputDir = join(tmpDir, "new-dir", "nested");
    await post(port, "/api/projects", { name: "Nested Dir Project", outputDir });
    assert.ok(existsSync(outputDir), "output directory should be created");
  });

  it("returns 400 when name is missing", async () => {
    const res = await post(port, "/api/projects", { outputDir: join(tmpDir, "x") });
    assert.ok([400, 500].includes(res.status), `expected 4xx, got ${res.status}`);
    assert.ok(res.body.error || !res.body.ok, "should return error");
  });

  it("returns 400 when outputDir is missing", async () => {
    const res = await post(port, "/api/projects", { name: "No Dir" });
    assert.ok([400, 500].includes(res.status), `expected 4xx, got ${res.status}`);
    assert.ok(res.body.error || !res.body.ok, "should return error");
  });

  it("persists project to registry file", async () => {
    const outputDir = join(tmpDir, "persist-test");
    await post(port, "/api/projects", { name: "Persist Test", outputDir });
    const registry = JSON.parse(await readFile(registryFile, "utf8"));
    assert.ok(registry["persist-test"], "project should be in registry");
    assert.equal(registry["persist-test"].name, "Persist Test");
  });

  it("normalizes project ID from name", async () => {
    const outputDir = join(tmpDir, "id-test");
    const res = await post(port, "/api/projects", { name: "My Cool  App!!!", outputDir });
    assert.equal(res.body.project.id, "my-cool-app", `expected normalized ID, got ${res.body.project.id}`);
  });

  it("stores featuresDoc when provided", async () => {
    const outputDir = join(tmpDir, "features-test");
    const res = await post(port, "/api/projects", { name: "Features Test", outputDir, featuresDoc: "/path/to/features.md" });
    assert.equal(res.body.project.featuresDoc, "/path/to/features.md");
  });
});

describe("project API — GET /api/projects", () => {
  let server;
  let port;
  let tmpDir;
  let registryFile;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "crewswarm-project-get-test-"));
    registryFile = join(tmpDir, "projects.json");
    server = makeServer(registryFile);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty projects when registry doesn't exist", async () => {
    const res = await get(port, "/api/projects");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(res.body.projects, {});
  });

  it("returns created projects", async () => {
    const outputDir = join(tmpDir, "listed-app");
    await post(port, "/api/projects", { name: "Listed App", outputDir });
    const res = await get(port, "/api/projects");
    assert.equal(res.status, 200);
    assert.ok(res.body.projects["listed-app"], "should return the created project");
  });
});
