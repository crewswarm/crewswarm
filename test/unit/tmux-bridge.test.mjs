/**
 * Unit tests for tmux-bridge.mjs — detection, caching, no-op behavior,
 * and list parsing.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  detect,
  id,
  label,
  resolve,
  read,
  send,
  list,
  clearCache,
  _reset,
} from "../../lib/bridges/tmux-bridge.mjs";

describe("tmux-bridge", () => {
  beforeEach(() => {
    _reset();
  });

  describe("detect", () => {
    it("returns false when TMUX env is not set", () => {
      delete process.env.TMUX;
      delete process.env.CREWSWARM_TMUX_BRIDGE;
      _reset();
      assert.equal(detect(), false);
    });

    it("returns false when CREWSWARM_TMUX_BRIDGE is not set", () => {
      process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
      delete process.env.CREWSWARM_TMUX_BRIDGE;
      _reset();
      assert.equal(detect(), false);
    });

    it("returns false when CREWSWARM_TMUX_BRIDGE is 0", () => {
      process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
      process.env.CREWSWARM_TMUX_BRIDGE = "0";
      _reset();
      assert.equal(detect(), false);
    });

    it("caches detection result", () => {
      delete process.env.TMUX;
      _reset();
      assert.equal(detect(), false);
      // Even if we set TMUX now, cached result stays false
      process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
      assert.equal(detect(), false);
    });

    it("_reset clears cached detection", () => {
      delete process.env.TMUX;
      _reset();
      assert.equal(detect(), false);
      _reset(); // clear cache
      // Now detection runs fresh (still false because no tmux-bridge binary)
      assert.equal(detect(), false);
    });
  });

  describe("no-op when unavailable", () => {
    beforeEach(() => {
      delete process.env.TMUX;
      delete process.env.CREWSWARM_TMUX_BRIDGE;
      _reset();
    });

    it("id returns null", () => {
      assert.equal(id(), null);
    });

    it("label returns false", () => {
      assert.equal(label("crew-coder"), false);
    });

    it("resolve returns null", () => {
      assert.equal(resolve("crew-coder"), null);
    });

    it("read returns null", () => {
      assert.equal(read("crew-coder"), null);
    });

    it("send returns false", () => {
      assert.equal(send("crew-coder", "hello"), false);
    });

    it("list returns empty array", () => {
      assert.deepEqual(list(), []);
    });
  });

  describe("clearCache", () => {
    it("does not throw", () => {
      assert.doesNotThrow(() => clearCache());
    });
  });
});
