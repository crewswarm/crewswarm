/**
 * Unit tests for lib/crew-lead/http-server.mjs
 *
 * Tests pure/helper functions that are exported.
 * Many helpers (stripAnsiPassthrough, shouldSkipOpenCodePassthroughLine, etc.)
 * are module-private — tests for those are skipped with a note.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

// Dynamic import — the module requires some env setup but we only test
// exported functions, not the server lifecycle.
let mod;
let importError;

try {
  mod = await import("../../lib/crew-lead/http-server.mjs");
} catch (err) {
  importError = err;
}

// ── initHttpServer ──────────────────────────────────────────────────────────

describe("http-server — initHttpServer", () => {
  it("module imports without throwing", () => {
    if (importError) {
      assert.fail(`Failed to import http-server.mjs: ${importError.message}`);
    }
    assert.ok(mod, "module should be importable");
  });

  it("exports initHttpServer as a function", () => {
    if (!mod) return;
    assert.equal(typeof mod.initHttpServer, "function");
  });

  it("initHttpServer accepts a deps object without throwing", () => {
    if (!mod) return;
    assert.doesNotThrow(() => {
      mod.initHttpServer({
        sseClients: new Set(),
        loadConfig: () => ({}),
        loadHistory: () => [],
        clearHistory: () => {},
        appendHistory: () => {},
        broadcastSSE: () => {},
        handleChat: async () => {},
        confirmProject: () => {},
        pendingProjects: new Map(),
        dispatchTask: async () => {},
        pendingDispatches: new Map(),
        pendingPipelines: new Map(),
        resolveAgentId: () => "crew-main",
        readAgentTools: () => [],
        writeAgentTools: () => {},
      });
    });
  });

  it("initHttpServer can be called with empty object", () => {
    if (!mod) return;
    assert.doesNotThrow(() => mod.initHttpServer({}));
  });
});

// ── createAndStartServer ────────────────────────────────────────────────────

describe("http-server — createAndStartServer", () => {
  it("exports createAndStartServer as a function", () => {
    if (!mod) return;
    assert.equal(typeof mod.createAndStartServer, "function");
  });
});

// ── Private helper coverage notes ───────────────────────────────────────────
// The following functions are module-private (not exported) and cannot be
// tested without modifying the source:
//   - stripAnsiPassthrough(text)
//   - shouldSkipOpenCodePassthroughLine(line)
//   - shouldDropPassthroughStderrLine(engine, line)
//   - filterPassthroughStderr(engine, chunk)
//   - resolveCliBinary(configured, candidates)
//   - sanitizeDirectChatReply(reply)
//   - isBroadcastAllMode(directChatMetadata)
//   - resolveNodeBinary()
//   - wrapScriptBinary(bin, args)
//   - createFanoutTimeoutError(participantId, timeoutMs)
//
// To enable unit testing of these helpers, export them from http-server.mjs.
