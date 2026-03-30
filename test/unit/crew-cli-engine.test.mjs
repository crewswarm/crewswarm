/**
 * Unit tests for lib/engines/crew-cli.mjs
 *
 * Covers: initCrewCLI, isCrewCLIAvailable
 *
 * Skips: runCrewCLITask (requires crew-cli engine + LLM API keys)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  initCrewCLI,
  isCrewCLIAvailable,
} from "../../lib/engines/crew-cli.mjs";

describe("crew-cli-engine – initCrewCLI", () => {
  it("accepts a deps object without throwing", () => {
    assert.doesNotThrow(() => {
      initCrewCLI({ CREWSWARM_RT_AGENT: "crew-test" });
    });
  });

  it("accepts an empty deps object", () => {
    assert.doesNotThrow(() => {
      initCrewCLI({});
    });
  });
});

describe("crew-cli-engine – isCrewCLIAvailable", () => {
  it("returns a boolean", async () => {
    const result = await isCrewCLIAvailable();
    assert.ok(typeof result === "boolean");
  });
});
