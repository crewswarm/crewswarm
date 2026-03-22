import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const result = spawnSync(
  "python3",
  [
    "scripts/bench/performance_optimization.py",
    "--url",
    "http://127.0.0.1:4319/api/health",
    "--profile",
    "all",
    "--force-synthetic",
  ],
  {
    cwd: process.cwd(),
    encoding: "utf8",
  },
);

assert.equal(result.status, 0, result.stderr || "scripts/bench/performance_optimization.py exited non-zero");

const payload = JSON.parse(result.stdout);

assert.equal(payload.baseline.mode, "synthetic-fallback");
assert.match(payload.baseline.fallback_reason, /synthetic/i);
assert.equal(payload.profiles.length, 3);

for (const profile of payload.profiles) {
  assert.equal(profile.metrics.mode, "synthetic-fallback");
  assert.equal(profile.metrics.success_rate, 1.0);
  assert.ok(profile.recommendations.length > 0);
}

console.log("performance tooling test passed");
