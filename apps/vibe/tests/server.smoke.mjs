import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

// Set env vars to avoid side effects during import
process.env.STUDIO_DISABLE_LISTEN = "1";
process.env.STUDIO_DATA_DIR = path.join(rootDir, ".tmp-smoke-data");

const {
  ensureDataDirs,
  readProjects,
  listWorkspaceFiles,
  createOrUpdateProject,
  createTerminalSession,
} = await import("../server.mjs");

async function runSmokeTests() {
  console.log("Starting Studio smoke tests...");

  try {
    // 1. Data directories
    ensureDataDirs();
    const dataDirExists = await fs.stat(process.env.STUDIO_DATA_DIR).then(s => s.isDirectory()).catch(() => false);
    assert.ok(dataDirExists, "Data directory should be created");

    // 2. Projects
    const projects = readProjects();
    assert.ok(Array.isArray(projects), "Projects should be an array");
    assert.ok(projects.length > 0, "Should have at least one project");
    assert.equal(projects[0].id, "studio-local", "First project should be the default one");

    // 3. Workspace files
    const files = listWorkspaceFiles(rootDir);
    console.log(`Found ${files.length} files in ${rootDir}`);
    if (files.length > 0) {
      console.log("Sample file paths:", files.slice(0, 5).map(f => f.path));
    }
    assert.ok(Array.isArray(files), "Files should be an array");
    assert.ok(files.some(f => f.path.endsWith("package.json")), "Should find package.json in root");

    // 4. Create project
    const tempProjectDir = await fs.mkdtemp(path.join(rootDir, ".tmp-project-"));
    const newProject = {
      name: "Smoke Test Project",
      description: "Temporary project for smoke test",
      outputDir: tempProjectDir
    };
    const result = createOrUpdateProject(newProject);
    assert.equal(result.status, 200, "Should create project successfully");
    assert.ok(result.payload.project.id, "Created project should have an ID");

    // 5. Terminal session
    process.env.STUDIO_SHELL_BIN = "/bin/sh";
    process.env.STUDIO_SHELL_ARGS_JSON = JSON.stringify([
      "-lc",
      "printf terminal-smoke-ready\\n",
    ]);
    const terminalOutput = [];
    let terminalExitCode = null;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Terminal smoke test timed out"));
      }, 5000);

      createTerminalSession({
        projectDir: rootDir,
        cols: 80,
        rows: 24,
        onData(chunk) {
          terminalOutput.push(chunk);
        },
        onExit(code) {
          terminalExitCode = code;
          clearTimeout(timeout);
          resolve();
        },
      });
    });
    assert.equal(terminalExitCode, 0, "Terminal session should exit cleanly");
    assert.match(
      terminalOutput.join(""),
      /terminal-smoke-ready/,
      "Terminal should produce shell output",
    );

    // Cleanup temp project dir
    await fs.rm(tempProjectDir, { recursive: true, force: true });

    console.log("Studio smoke tests passed!");
  } finally {
    // Cleanup smoke data dir
    await fs.rm(process.env.STUDIO_DATA_DIR, { recursive: true, force: true });
  }
}

runSmokeTests().catch(err => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
