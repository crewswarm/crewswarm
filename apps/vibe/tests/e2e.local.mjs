import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.STUDIO_DISABLE_LISTEN = "1";
process.env.STUDIO_DATA_DIR = path.join(process.cwd(), ".tmp-e2e-data");

const { createOrUpdateProject, listWorkspaceFiles, readProjects } = await import("../server.mjs");

const projectDir = await fs.mkdtemp(
  path.join(os.tmpdir(), "crewswarm-vibe-e2e-"),
);

try {
  const created = createOrUpdateProject({
    name: "E2E Project",
    description: "Local E2E check",
    outputDir: projectDir,
  });
  assert.equal(created.status, 200);

  await fs.writeFile(
    path.join(projectDir, "README.md"),
    "# E2E Project\n\nLocal test file.\n",
    "utf8",
  );

  const projectsPayload = {
    projects: readProjects(),
  };
  assert.ok(
    projectsPayload.projects.some((project) => project.id === created.payload.project.id),
  );

  const filesPayload = {
    files: listWorkspaceFiles(projectDir),
  };
  assert.ok(filesPayload.files.some((entry) => entry.path.endsWith("README.md")));

  const filePayload = {
    content: await fs.readFile(path.join(projectDir, "README.md"), "utf8"),
  };
  assert.match(filePayload.content, /Local test file/);

  const distIndex = await fs.readFile(path.join(process.cwd(), "dist", "index.html"), "utf8");
  assert.match(distIndex, /toggle-bottom-terminal/);
  assert.doesNotMatch(distIndex, /cdn\.jsdelivr\.net\/npm\/xterm/);

  console.log("Studio local e2e checks passed");
} finally {
  await fs.rm(projectDir, { recursive: true, force: true });
  await fs.rm(process.env.STUDIO_DATA_DIR, { recursive: true, force: true });
}
