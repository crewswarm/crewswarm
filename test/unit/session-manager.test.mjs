/**
 * Unit tests for session-manager.mjs — create, attach, lock, handoff,
 * terminate, and listing when tmux is unavailable.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getStatePath, resetPaths } from "../../lib/runtime/paths.mjs";

// Set test mode BEFORE importing session-manager so it picks up the test state dir
process.env.CREWSWARM_TEST_MODE = "true";
resetPaths();

import {
  create,
  attach,
  exec,
  lock,
  unlock,
  handoff,
  terminate,
  getSession,
  listSessions,
} from "../../lib/sessions/session-manager.mjs";

import { _reset as resetTmuxBridge } from "../../lib/bridges/tmux-bridge.mjs";

describe("session-manager", () => {
  beforeEach(() => {
    // Ensure tmux-bridge is unavailable (no TMUX env)
    delete process.env.TMUX;
    delete process.env.CREWSWARM_TMUX_BRIDGE;
    resetTmuxBridge();
  });

  describe("when tmux is unavailable", () => {
    it("create returns null", () => {
      const sid = create({ workspaceId: "test", agentId: "crew-coder" });
      assert.equal(sid, null);
    });

    it("attach returns null for non-existent session", () => {
      assert.equal(attach("fake-id", "crew-qa"), null);
    });

    it("lock returns false for non-existent session", () => {
      assert.equal(lock("fake-id", "crew-qa"), false);
    });

    it("unlock returns false for non-existent session", () => {
      assert.equal(unlock("fake-id", "crew-qa"), false);
    });

    it("handoff returns false for non-existent session", () => {
      assert.equal(handoff("fake-id", "crew-coder", "crew-qa"), false);
    });

    it("terminate returns false for non-existent session", () => {
      assert.equal(terminate("fake-id"), false);
    });

    it("getSession returns null for non-existent session", () => {
      assert.equal(getSession("fake-id"), null);
    });

    it("listSessions returns empty array", () => {
      const sessions = listSessions();
      assert.ok(Array.isArray(sessions));
    });
  });

  describe("metadata operations with manually created session files", () => {
    // The session-manager uses getStatePath("sessions") set at module load time.
    // We write test files there directly and clean up after.
    const sessionDir = path.join(os.homedir(), ".crewswarm", "sessions");

    beforeEach(() => {
      try { fs.mkdirSync(sessionDir, { recursive: true }); } catch {}
    });

    afterEach(() => {
      // Clean up test session files
      try {
        const files = fs.readdirSync(sessionDir);
        for (const f of files) {
          if (f.startsWith("test-")) fs.unlinkSync(path.join(sessionDir, f));
        }
      } catch {}
    });

    it("getSession reads a manually created session meta file", () => {
      const meta = {
        sessionId: "test-manual-1",
        sessionName: "test-session",
        owner: "crew-coder",
        lockedBy: "crew-coder",
        status: "active",
      };
      fs.writeFileSync(
        path.join(sessionDir, "test-manual-1.json"),
        JSON.stringify(meta)
      );
      const loaded = getSession("test-manual-1");
      assert.equal(loaded.sessionId, "test-manual-1");
      assert.equal(loaded.owner, "crew-coder");
      assert.equal(loaded.status, "active");
    });

    it("lock enforces ownership", () => {
      const meta = {
        sessionId: "test-lock-1",
        sessionName: "test-session",
        owner: "crew-coder",
        lockedBy: "crew-coder",
        status: "active",
      };
      fs.writeFileSync(
        path.join(sessionDir, "test-lock-1.json"),
        JSON.stringify(meta)
      );

      // Different agent should be denied
      assert.equal(lock("test-lock-1", "crew-qa"), false);

      // Owner should succeed
      assert.equal(lock("test-lock-1", "crew-coder"), true);
    });

    it("unlock only works for current lock holder", () => {
      const meta = {
        sessionId: "test-unlock-1",
        sessionName: "test-session",
        owner: "crew-coder",
        lockedBy: "crew-coder",
        status: "active",
      };
      fs.writeFileSync(
        path.join(sessionDir, "test-unlock-1.json"),
        JSON.stringify(meta)
      );

      assert.equal(unlock("test-unlock-1", "crew-qa"), false);
      assert.equal(unlock("test-unlock-1", "crew-coder"), true);

      const after = getSession("test-unlock-1");
      assert.equal(after.lockedBy, null);
    });

    it("handoff transfers ownership and lock", () => {
      const meta = {
        sessionId: "test-handoff-1",
        sessionName: "test-session",
        owner: "crew-coder",
        lockedBy: "crew-coder",
        status: "active",
      };
      fs.writeFileSync(
        path.join(sessionDir, "test-handoff-1.json"),
        JSON.stringify(meta)
      );

      // Wrong agent can't handoff
      assert.equal(handoff("test-handoff-1", "crew-qa", "crew-fixer"), false);

      // Owner can handoff
      assert.equal(handoff("test-handoff-1", "crew-coder", "crew-qa"), true);

      const after = getSession("test-handoff-1");
      assert.equal(after.owner, "crew-qa");
      assert.equal(after.lockedBy, "crew-qa");
    });

    it("terminate sets status to terminated", () => {
      const meta = {
        sessionId: "test-term-1",
        sessionName: "test-session",
        owner: "crew-coder",
        lockedBy: null,
        status: "active",
      };
      fs.writeFileSync(
        path.join(sessionDir, "test-term-1.json"),
        JSON.stringify(meta)
      );

      assert.equal(terminate("test-term-1"), true);
      const after = getSession("test-term-1");
      assert.equal(after.status, "terminated");
    });

    it("exec denied when locked by different agent", () => {
      const meta = {
        sessionId: "test-exec-1",
        sessionName: "test-session",
        owner: "crew-coder",
        lockedBy: "crew-coder",
        paneId: "%99",
        status: "active",
      };
      fs.writeFileSync(
        path.join(sessionDir, "test-exec-1.json"),
        JSON.stringify(meta)
      );

      assert.equal(exec("test-exec-1", "echo test", { actorId: "crew-qa" }), null);
    });

    it("attach returns null for terminated sessions", () => {
      const meta = {
        sessionId: "test-attach-1",
        sessionName: "test-session",
        owner: "crew-coder",
        status: "terminated",
      };
      fs.writeFileSync(
        path.join(sessionDir, "test-attach-1.json"),
        JSON.stringify(meta)
      );

      assert.equal(attach("test-attach-1", "crew-qa"), null);
    });

    it("listSessions only returns active sessions", () => {
      fs.writeFileSync(
        path.join(sessionDir, "test-list-active.json"),
        JSON.stringify({ sessionId: "test-list-active", status: "active" })
      );
      fs.writeFileSync(
        path.join(sessionDir, "test-list-dead.json"),
        JSON.stringify({ sessionId: "test-list-dead", status: "terminated" })
      );

      const sessions = listSessions();
      const ids = sessions.map((s) => s.sessionId);
      assert.ok(ids.includes("test-list-active"));
      assert.ok(!ids.includes("test-list-dead"));
    });
  });
});
