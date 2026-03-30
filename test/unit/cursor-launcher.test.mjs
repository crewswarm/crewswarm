/**
 * Unit tests for lib/engines/cursor-launcher.mjs
 *
 * Covers: resolveCursorLaunchSpec
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveCursorLaunchSpec } from "../../lib/engines/cursor-launcher.mjs";

describe("cursor-launcher – resolveCursorLaunchSpec", () => {
  it("returns an object with bin, argsPrefix, displayCommand", () => {
    const spec = resolveCursorLaunchSpec();
    assert.ok(typeof spec.bin === "string");
    assert.ok(Array.isArray(spec.argsPrefix));
    assert.ok(typeof spec.displayCommand === "string");
  });

  it("returns consistent results for same input (cache)", () => {
    const a = resolveCursorLaunchSpec("some-binary");
    const b = resolveCursorLaunchSpec("some-binary");
    assert.strictEqual(a, b); // Same reference due to cache
  });

  it("defaults to agent binary", () => {
    const spec = resolveCursorLaunchSpec("");
    assert.ok(spec.bin.length > 0);
  });

  it("handles explicit binary path", () => {
    const spec = resolveCursorLaunchSpec("/usr/local/bin/agent");
    assert.ok(spec.bin.includes("agent"));
  });
});
