/**
 * Unit tests for lib/runtime/memory.mjs
 *
 * Covers:
 *  - getAgentExtraMemory: static + role-based lookup
 *  - getLastHandoffTimestamp: regex extraction
 *  - initMemory: dependency injection
 *  - SHARED_MEMORY_FILES: expected constant
 *  - SHARED_MEMORY_MAX_FILE_CHARS / SHARED_MEMORY_MAX_TOTAL_CHARS: expected constants
 *  - _AGENT_EXTRA_MEMORY_STATIC / _EXTRA_MEMORY_BY_ROLE: expected maps
 *
 * Skips loadSharedMemoryBundle and buildTaskPrompt (require filesystem setup
 * and injected dependencies).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

const {
  getAgentExtraMemory,
  getLastHandoffTimestamp,
  initMemory,
  SHARED_MEMORY_FILES,
  SHARED_MEMORY_MAX_FILE_CHARS,
  SHARED_MEMORY_MAX_TOTAL_CHARS,
  _AGENT_EXTRA_MEMORY_STATIC,
  _EXTRA_MEMORY_BY_ROLE,
} = await import("../../lib/runtime/memory.mjs");

// ── Constants ───────────────────────────────────────────────────────────────

describe("runtime-memory — constants", () => {
  it("SHARED_MEMORY_FILES is a non-empty array of strings", () => {
    assert.ok(Array.isArray(SHARED_MEMORY_FILES));
    assert.ok(SHARED_MEMORY_FILES.length > 0);
    for (const f of SHARED_MEMORY_FILES) {
      assert.equal(typeof f, "string");
      assert.ok(f.endsWith(".md"));
    }
  });

  it("SHARED_MEMORY_MAX_FILE_CHARS is a positive number", () => {
    assert.equal(typeof SHARED_MEMORY_MAX_FILE_CHARS, "number");
    assert.ok(SHARED_MEMORY_MAX_FILE_CHARS > 0);
  });

  it("SHARED_MEMORY_MAX_TOTAL_CHARS is a positive number", () => {
    assert.equal(typeof SHARED_MEMORY_MAX_TOTAL_CHARS, "number");
    assert.ok(SHARED_MEMORY_MAX_TOTAL_CHARS > SHARED_MEMORY_MAX_FILE_CHARS);
  });

  it("_AGENT_EXTRA_MEMORY_STATIC has expected agent entries", () => {
    assert.ok("crew-fixer" in _AGENT_EXTRA_MEMORY_STATIC);
    assert.ok("crew-coder" in _AGENT_EXTRA_MEMORY_STATIC);
    assert.ok(Array.isArray(_AGENT_EXTRA_MEMORY_STATIC["crew-coder"]));
  });

  it("_EXTRA_MEMORY_BY_ROLE has coder and ops roles", () => {
    assert.ok("coder" in _EXTRA_MEMORY_BY_ROLE);
    assert.ok("ops" in _EXTRA_MEMORY_BY_ROLE);
  });
});

// ── getAgentExtraMemory ─────────────────────────────────────────────────────

describe("runtime-memory — getAgentExtraMemory", () => {
  it("returns lessons.md for crew-coder", () => {
    const files = getAgentExtraMemory("crew-coder");
    assert.ok(files.includes("lessons.md"));
  });

  it("returns lessons.md for crew-fixer", () => {
    const files = getAgentExtraMemory("crew-fixer");
    assert.ok(files.includes("lessons.md"));
  });

  it("returns empty array for unknown agent", () => {
    const files = getAgentExtraMemory("crew-unknown-xyz");
    assert.ok(Array.isArray(files));
    assert.equal(files.length, 0);
  });
});

// ── getLastHandoffTimestamp ──────────────────────────────────────────────────

describe("runtime-memory — getLastHandoffTimestamp", () => {
  it("extracts timestamp from agent-handoff.md content", () => {
    const sharedMemory = {
      files: {
        "agent-handoff.md": "# Agent Handoff\nLast updated: 2025-01-15T10:30:00Z\nSome content here",
      },
    };
    const ts = getLastHandoffTimestamp(sharedMemory);
    assert.equal(ts, "2025-01-15T10:30:00Z");
  });

  it("returns 'unknown' when no timestamp found", () => {
    const sharedMemory = {
      files: {
        "agent-handoff.md": "# Agent Handoff\nNo timestamp here",
      },
    };
    assert.equal(getLastHandoffTimestamp(sharedMemory), "unknown");
  });

  it("returns 'unknown' when file is missing", () => {
    assert.equal(getLastHandoffTimestamp({ files: {} }), "unknown");
    assert.equal(getLastHandoffTimestamp(null), "unknown");
    assert.equal(getLastHandoffTimestamp(undefined), "unknown");
  });
});

// ── initMemory ──────────────────────────────────────────────────────────────

describe("runtime-memory — initMemory", () => {
  it("accepts dependency injection without throwing", () => {
    // Should not throw
    initMemory({
      telemetry: () => {},
      ensureSharedMemoryFiles: () => ({ created: [], error: null }),
      loadAgentList: () => [],
      loadAgentToolPermissions: () => new Set(),
      buildToolInstructions: () => "",
      getOpencodeProjectDir: () => "",
    });
  });

  it("handles partial injection (only some deps)", () => {
    initMemory({ telemetry: () => {} });
  });

  it("handles empty object", () => {
    initMemory({});
  });
});
