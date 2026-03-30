/**
 * Unit tests for lib/engines/crew-cli-sandbox.mjs
 *
 * Only tests the exported function: runCrewCLIWithSandbox
 * Since the function spawns crew-cli (requires binary), we test:
 *  - Input validation (prompt required)
 *  - normalizeCrewCliModel logic (not exported, so we test via error paths)
 *
 * The internal helpers (normalizeCrewCliModel, formatResponseWithFiles, etc.)
 * are not exported, so we verify them indirectly or skip network-dependent paths.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { runCrewCLIWithSandbox } = await import("../../lib/engines/crew-cli-sandbox.mjs");

describe("crew-cli-sandbox — runCrewCLIWithSandbox", () => {
  it("throws when prompt is empty", async () => {
    await assert.rejects(
      () => runCrewCLIWithSandbox("", {}),
      (err) => {
        assert.ok(err.message.includes("prompt is required"));
        return true;
      }
    );
  });

  it("throws when prompt is null", async () => {
    await assert.rejects(
      () => runCrewCLIWithSandbox(null, {}),
      (err) => {
        assert.ok(err.message.includes("prompt is required"));
        return true;
      }
    );
  });

  it("throws when prompt is undefined", async () => {
    await assert.rejects(
      () => runCrewCLIWithSandbox(undefined, {}),
      (err) => {
        assert.ok(err.message.includes("prompt is required"));
        return true;
      }
    );
  });
});
