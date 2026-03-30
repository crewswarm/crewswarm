/**
 * Unit tests for lib/runtime/logger.mjs
 *
 * Covers: log, logger convenience wrappers
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { log, logger } from "../../lib/runtime/logger.mjs";

describe("logger – log function", () => {
  it("does not throw for info level", () => {
    assert.doesNotThrow(() => log("info", "test-comp", "hello"));
  });

  it("does not throw for warn level", () => {
    assert.doesNotThrow(() => log("warn", "test-comp", "caution"));
  });

  it("does not throw for error level", () => {
    assert.doesNotThrow(() => log("error", "test-comp", "bad thing"));
  });

  it("does not throw for debug level", () => {
    assert.doesNotThrow(() => log("debug", "test-comp", "trace info"));
  });

  it("accepts optional data object", () => {
    assert.doesNotThrow(() =>
      log("info", "test-comp", "with data", { key: "val", num: 42 }),
    );
  });
});

describe("logger – convenience wrappers", () => {
  it("logger.info is a function", () => {
    assert.ok(typeof logger.info === "function");
  });

  it("logger.warn is a function", () => {
    assert.ok(typeof logger.warn === "function");
  });

  it("logger.error is a function", () => {
    assert.ok(typeof logger.error === "function");
  });

  it("logger.debug is a function", () => {
    assert.ok(typeof logger.debug === "function");
  });

  it("logger.info does not throw", () => {
    assert.doesNotThrow(() => logger.info("comp", "msg", { x: 1 }));
  });
});
