import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const restartScript = fs.readFileSync(
  path.resolve("scripts/restart-all-from-repo.sh"),
  "utf8",
);
const healthScript = fs.readFileSync(
  path.resolve("scripts/health-check.mjs"),
  "utf8",
);

test("restart-all script polls critical services and exits non-zero on critical failure", () => {
  assert.match(restartScript, /wait_for_health "http:\/\/127\.0\.0\.1:5010\/health" "crew-lead"/);
  assert.match(restartScript, /wait_for_health "http:\/\/127\.0\.0\.1:4319\/" "dashboard"/);
  assert.match(restartScript, /if \[\[ "\$CREW_LEAD_OK" == "up" \]\] && \{ \[\[ "\$DASHBOARD_OK" == "up" \]\] \|\| \[\[ "\$START_DASH" -eq 0 \]\]; \}; then/);
  assert.match(restartScript, /One or more critical services failed to start\./);
  assert.match(restartScript, /exit 1/);
});

test("restart-all script tracks optional services and bridge skips explicitly", () => {
  assert.match(restartScript, /--no-dashboard/);
  assert.match(restartScript, /--no-studio/);
  assert.match(restartScript, /--no-bridges/);
  assert.match(restartScript, /Skipping messaging bridges — RT bus is not up/);
  assert.match(restartScript, /print_status "telegram"/);
  assert.match(restartScript, /print_status "whatsapp"/);
});

test("health-check supports static mode and machine-readable json", () => {
  assert.match(healthScript, /const JSON_MODE\s+=\s+process\.argv\.includes\("--json"\)/);
  assert.match(healthScript, /const NO_SERVICES\s+=\s+process\.argv\.includes\("--no-services"\)/);
  assert.match(healthScript, /check\("services skipped", "pass", "--no-services mode"\)/);
  assert.match(healthScript, /console\.log\(JSON\.stringify\(\{ pass, fail, warn, results \}, null, 2\)\)/);
});

test("health-check --json --no-services returns structured output under a temporary home", () => {
  const tmpHome = fs.mkdtempSync(path.join(path.resolve("test-output"), "health-home-"));
  const cfgDir = path.join(tmpHome, ".crewswarm");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(
    path.join(cfgDir, "crewswarm.json"),
    JSON.stringify({ rt: { authToken: "test-token" }, providers: {} }),
  );

  const run = spawnSync("node", ["scripts/health-check.mjs", "--json", "--no-services"], {
    cwd: path.resolve("."),
    env: { ...process.env, HOME: tmpHome },
    encoding: "utf8",
  });

  assert.equal(run.status, 0);
  const jsonStart = run.stdout.indexOf("{");
  assert.notEqual(jsonStart, -1);
  const payload = JSON.parse(run.stdout.slice(jsonStart));
  assert.equal(typeof payload.pass, "number");
  assert.equal(typeof payload.fail, "number");
  assert.equal(typeof payload.warn, "number");
  assert.ok(Array.isArray(payload.results));
});
