/**
 * Test helper for hermetic testing.
 * Sets CREWSWARM_TEST_MODE=true to isolate tests from real ~/.crewswarm state.
 * 
 * Usage:
 *   import { setupHermeticTest } from "../../test/helpers/hermetic.mjs";
 *   
 *   before(() => setupHermeticTest());
 */

import { randomBytes } from "crypto";

/**
 * Enable hermetic test mode.
 * This redirects all CrewSwarm config/state paths to temporary directories.
 * Call this in your test's before() hook.
 */
export function setupHermeticTest() {
  if (process.env.CREWSWARM_TEST_MODE !== "true") {
    process.env.CREWSWARM_TEST_MODE = "true";
    // Force path resolution to re-evaluate after setting env var
    const pathsModule = await import("../../lib/runtime/paths.mjs");
    pathsModule.resetPaths();
  }
}

/**
 * Disable hermetic test mode.
 * Call this in your test's after() hook if you need to restore normal behavior.
 */
export function teardownHermeticTest() {
  delete process.env.CREWSWARM_TEST_MODE;
}

/**
 * Generate a unique test session ID.
 * Useful for tests that need isolated session data.
 */
export function generateTestSessionId(prefix = "test") {
  return `${prefix}-${process.pid}-${randomBytes(4).toString("hex")}`;
}
