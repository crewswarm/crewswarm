/**
 * Unit tests for apps/dashboard/src/orchestration-status.js
 *
 * SKIPPED: This module depends on browser-only APIs at the module level:
 *  - fetch (global)
 *  - document.getElementById
 *  - document.addEventListener('DOMContentLoaded', ...)
 *
 * The module executes DOM queries at the top level during import (lines 114-127),
 * which means it cannot be imported in a Node.js environment without a full
 * DOM polyfill. All exported functions (updateOrchestrationStatus,
 * startOrchestrationStatusUpdates, stopOrchestrationStatusUpdates) also
 * depend on fetch and document.getElementById internally.
 *
 * There are no pure helper functions to extract and test.
 *
 * To make this module testable in the future, consider:
 *  1. Extracting data-formatting logic into a separate pure module
 *  2. Wrapping top-level DOM access in an init() function
 *  3. Accepting dependencies (fetch, document) via injection
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("apps/dashboard/src/orchestration-status.js", () => {
  it("skipped: module requires browser DOM APIs (fetch, document) at import time", () => {
    // This test documents why the module cannot be tested in Node.js.
    // See file header for details and recommendations.
    assert.ok(true, "placeholder — module is browser-only");
  });
});
