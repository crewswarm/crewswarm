import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(path.resolve("lib/runtime/startup-guard.mjs")).href;

async function loadStartupGuard(pidDir) {
  process.env.CREWSWARM_PID_DIR = pidDir;
  return import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`);
}

test("startup guard acquires and releases a lock in a writable pid directory", async () => {
  const pidDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewswarm-pids-"));
  const { acquireStartupLock, releaseStartupLock } = await loadStartupGuard(pidDir);

  const result = acquireStartupLock("unit-startup-guard");
  assert.equal(result.ok, true);

  const pidFile = path.join(pidDir, "unit-startup-guard.pid");
  assert.equal(fs.readFileSync(pidFile, "utf8").trim(), String(process.pid));

  releaseStartupLock("unit-startup-guard");
  assert.equal(fs.existsSync(pidFile), false);
});

test("startup guard removes invalid pid files and reacquires the lock", async () => {
  const pidDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewswarm-pids-"));
  const pidFile = path.join(pidDir, "unit-invalid.pid");
  fs.writeFileSync(pidFile, "not-a-pid");

  const { acquireStartupLock, releaseStartupLock } = await loadStartupGuard(pidDir);
  const result = acquireStartupLock("unit-invalid");
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(pidFile, "utf8").trim(), String(process.pid));
  releaseStartupLock("unit-invalid");
});

test("startup guard removes stale dead-process pid files", async () => {
  const pidDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewswarm-pids-"));
  const pidFile = path.join(pidDir, "unit-stale.pid");
  fs.writeFileSync(pidFile, "999999");

  const { acquireStartupLock, releaseStartupLock } = await loadStartupGuard(pidDir);
  const result = acquireStartupLock("unit-stale");
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(pidFile, "utf8").trim(), String(process.pid));
  releaseStartupLock("unit-stale");
});

test("startup guard rejects an already-running live pid", async () => {
  const pidDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewswarm-pids-"));
  const pidFile = path.join(pidDir, "unit-live.pid");
  fs.writeFileSync(pidFile, String(process.pid));

  const { acquireStartupLock } = await loadStartupGuard(pidDir);
  const result = acquireStartupLock("unit-live");
  assert.equal(result.ok, false);
  assert.match(result.message, /already running/);
});
