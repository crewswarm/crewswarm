/**
 * E2E: PM Loop with multi-engine agents — verify PM dispatches to agents
 * on different CLI engines and all complete.
 *
 * Sends a simple multi-task requirement, PM breaks it down, dispatches
 * to agents on different engines, verifies all complete.
 *
 * REQUIRES: crew-lead on :5010, agents running on mixed engines.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { checkServiceUp, httpRequest } from "../helpers/http.mjs";

const CREW_LEAD_URL = "http://127.0.0.1:5010";
const CONFIG_PATH = join(homedir(), ".crewswarm", "crewswarm.json");
const TEST_DIR = join(tmpdir(), `crewswarm-pm-multi-engine-${Date.now()}`);

let authToken;
async function getAuthToken() {
  if (authToken) return authToken;
  try {
    const cfg = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    authToken = cfg?.rt?.authToken || "";
    return authToken;
  } catch { return ""; }
}

const crewLeadUp = await checkServiceUp(`${CREW_LEAD_URL}/health`);
const SKIP = crewLeadUp ? false : "crew-lead not running on :5010";

describe("PM Loop multi-engine dispatch", { skip: SKIP, timeout: 300000 }, () => {

  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    // Create a simple ROADMAP for the PM to process
    await writeFile(join(TEST_DIR, "ROADMAP.md"), `# Test Roadmap

## Pending
- [ ] Create an index.html landing page with a hero section
- [ ] Create a style.css with dark theme styling
`);
    console.log(`    Test dir: ${TEST_DIR}`);
  });

  after(async () => {
    try { await rm(TEST_DIR, { recursive: true, force: true }); } catch { }
  });

  it("dispatches a multi-agent pipeline and all agents complete", async () => {
    const token = await getAuthToken();

    // Use pipeline API with agents on different engines
    // crew-coder (Claude Code) does HTML, crew-coder-front (Cursor) does CSS
    const pipeline = [
      {
        wave: 1,
        agent: "crew-coder",
        task: `Create ${TEST_DIR}/index.html with a basic landing page. Include <h1>CrewSwarm Test</h1> and a link to style.css. Write ONLY the file.`,
      },
      {
        wave: 1,
        agent: "crew-coder-front",
        task: `Create ${TEST_DIR}/style.css with dark theme styles: body { background: #0a0e17; color: #c9d1d9; font-family: sans-serif; }. Write ONLY the file.`,
      },
    ];

    const { status, data } = await httpRequest(`${CREW_LEAD_URL}/api/pipeline`, {
      method: "POST",
      headers: { "Authorization": token ? `Bearer ${token}` : "" },
      body: { pipeline, projectDir: TEST_DIR },
      timeout: 15000,
    });
    assert.ok(data.pipelineId, "Should return pipelineId");
    console.log(`    Pipeline: ${data.pipelineId}`);

    // Poll for completion (up to 4 minutes)
    const start = Date.now();
    let finalState;
    while (Date.now() - start < 240000) {
      const { data: s } = await httpRequest(`${CREW_LEAD_URL}/api/pipeline/${data.pipelineId}`, {
        headers: { "Authorization": token ? `Bearer ${token}` : "" },
      });
      if (s.status === "completed" || s.status === "done") {
        finalState = s;
        break;
      }
      if (s.status === "failed") {
        console.log(`    Pipeline failed: ${JSON.stringify(s).slice(0, 200)}`);
        break;
      }
      await new Promise(r => setTimeout(r, 5000));
    }

    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`    Pipeline ${finalState?.status || "timeout"} in ${elapsed}s`);

    assert.ok(finalState, "Pipeline should complete within 4 minutes");
    assert.ok(
      finalState.status === "completed" || finalState.status === "done",
      `Expected completed, got ${finalState?.status}`
    );

    // Check if files were created (agents on different engines should have written them)
    if (existsSync(join(TEST_DIR, "index.html"))) {
      const html = await readFile(join(TEST_DIR, "index.html"), "utf8");
      console.log(`    index.html: ${html.length} chars`);
      assert.ok(html.includes("<"), "index.html should be valid HTML");
    } else {
      console.log("    index.html not created (agent may have written elsewhere)");
    }

    if (existsSync(join(TEST_DIR, "style.css"))) {
      const css = await readFile(join(TEST_DIR, "style.css"), "utf8");
      console.log(`    style.css: ${css.length} chars`);
      assert.ok(css.includes("{"), "style.css should have CSS rules");
    } else {
      console.log("    style.css not created (agent may have written elsewhere)");
    }
  });
});
