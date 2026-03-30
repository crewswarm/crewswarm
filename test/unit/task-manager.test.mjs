/**
 * Unit tests for apps/dashboard/src/core/task-manager.js
 *
 * TaskManager is a pure JS class with no DOM dependencies.
 * Covers:
 *  - registerTask: adds a task to activeTasks
 *  - stopTask: aborts controller, removes task, returns true
 *  - stopTask: returns false for unknown taskId
 *  - completeTask: removes task from activeTasks
 *  - failTask: removes task and stores error
 *  - getActiveTasks: returns array of active tasks with IDs
 *  - isAgentBusy: returns true when agent has running tasks
 *  - isAgentBusy: returns false when agent has no tasks
 *  - stopAll: stops every active task
 *  - stopAgent: stops only tasks for the given agent
 *  - subscribe: calls listener on task changes
 *  - subscribe: returns unsubscribe function
 *  - notifyListeners: swallows listener errors
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { TaskManager } from "../../apps/dashboard/src/core/task-manager.js";

describe("TaskManager", () => {
  let tm;

  beforeEach(() => {
    tm = new TaskManager();
  });

  // ── registerTask ────────────────────────────────────────────────────────

  describe("registerTask", () => {
    it("adds a task to activeTasks", () => {
      tm.registerTask("t1", { agent: "crew-coder", type: "build" });
      const tasks = tm.getActiveTasks();
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].id, "t1");
      assert.equal(tasks[0].agent, "crew-coder");
      assert.equal(tasks[0].status, "running");
    });

    it("sets startTime automatically", () => {
      const before = Date.now();
      tm.registerTask("t1", { agent: "crew-pm" });
      const task = tm.getActiveTasks()[0];
      assert.ok(task.startTime >= before);
      assert.ok(task.startTime <= Date.now());
    });
  });

  // ── stopTask ────────────────────────────────────────────────────────────

  describe("stopTask", () => {
    it("aborts controller and removes the task", () => {
      let aborted = false;
      const controller = { abort() { aborted = true; } };
      tm.registerTask("t1", { agent: "crew-coder", controller });

      const result = tm.stopTask("t1");
      assert.equal(result, true);
      assert.equal(aborted, true);
      assert.equal(tm.getActiveTasks().length, 0);
    });

    it("works when task has no controller", () => {
      tm.registerTask("t1", { agent: "crew-coder" });
      const result = tm.stopTask("t1");
      assert.equal(result, true);
      assert.equal(tm.getActiveTasks().length, 0);
    });

    it("returns false for unknown taskId", () => {
      assert.equal(tm.stopTask("nonexistent"), false);
    });
  });

  // ── completeTask ────────────────────────────────────────────────────────

  describe("completeTask", () => {
    it("removes task from activeTasks", () => {
      tm.registerTask("t1", { agent: "crew-coder" });
      tm.completeTask("t1");
      assert.equal(tm.getActiveTasks().length, 0);
    });

    it("does nothing for unknown taskId", () => {
      tm.completeTask("nonexistent");
      assert.equal(tm.getActiveTasks().length, 0);
    });
  });

  // ── failTask ────────────────────────────────────────────────────────────

  describe("failTask", () => {
    it("removes task from activeTasks", () => {
      tm.registerTask("t1", { agent: "crew-coder" });
      tm.failTask("t1", "timeout");
      assert.equal(tm.getActiveTasks().length, 0);
    });

    it("does nothing for unknown taskId", () => {
      tm.failTask("nonexistent", "error");
      assert.equal(tm.getActiveTasks().length, 0);
    });
  });

  // ── getActiveTasks ──────────────────────────────────────────────────────

  describe("getActiveTasks", () => {
    it("returns empty array when no tasks registered", () => {
      assert.deepEqual(tm.getActiveTasks(), []);
    });

    it("returns all active tasks with their IDs", () => {
      tm.registerTask("t1", { agent: "crew-coder" });
      tm.registerTask("t2", { agent: "crew-pm" });
      const tasks = tm.getActiveTasks();
      assert.equal(tasks.length, 2);
      const ids = tasks.map((t) => t.id);
      assert.ok(ids.includes("t1"));
      assert.ok(ids.includes("t2"));
    });
  });

  // ── isAgentBusy ─────────────────────────────────────────────────────────

  describe("isAgentBusy", () => {
    it("returns true when agent has a running task", () => {
      tm.registerTask("t1", { agent: "crew-coder" });
      assert.equal(tm.isAgentBusy("crew-coder"), true);
    });

    it("returns false when agent has no tasks", () => {
      assert.equal(tm.isAgentBusy("crew-coder"), false);
    });

    it("returns false after agent task is stopped", () => {
      tm.registerTask("t1", { agent: "crew-coder" });
      tm.stopTask("t1");
      assert.equal(tm.isAgentBusy("crew-coder"), false);
    });
  });

  // ── stopAll ─────────────────────────────────────────────────────────────

  describe("stopAll", () => {
    it("stops every active task", () => {
      let abortCount = 0;
      const mkController = () => ({ abort() { abortCount++; } });

      tm.registerTask("t1", { agent: "crew-coder", controller: mkController() });
      tm.registerTask("t2", { agent: "crew-pm", controller: mkController() });
      tm.registerTask("t3", { agent: "crew-qa", controller: mkController() });

      tm.stopAll();
      assert.equal(tm.getActiveTasks().length, 0);
      assert.equal(abortCount, 3);
    });

    it("does nothing when no tasks exist", () => {
      tm.stopAll();
      assert.equal(tm.getActiveTasks().length, 0);
    });
  });

  // ── stopAgent ───────────────────────────────────────────────────────────

  describe("stopAgent", () => {
    it("stops only tasks for the specified agent", () => {
      tm.registerTask("t1", { agent: "crew-coder" });
      tm.registerTask("t2", { agent: "crew-pm" });
      tm.registerTask("t3", { agent: "crew-coder" });

      tm.stopAgent("crew-coder");

      const remaining = tm.getActiveTasks();
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].agent, "crew-pm");
    });
  });

  // ── subscribe / notifyListeners ─────────────────────────────────────────

  describe("subscribe", () => {
    it("calls listener on task registration", () => {
      let called = false;
      tm.subscribe(() => { called = true; });
      tm.registerTask("t1", { agent: "crew-coder" });
      assert.equal(called, true);
    });

    it("calls listener on task stop", () => {
      tm.registerTask("t1", { agent: "crew-coder" });
      let callCount = 0;
      tm.subscribe(() => { callCount++; });
      tm.stopTask("t1");
      assert.ok(callCount >= 1);
    });

    it("returns unsubscribe function", () => {
      let callCount = 0;
      const unsub = tm.subscribe(() => { callCount++; });
      tm.registerTask("t1", { agent: "crew-coder" });
      assert.equal(callCount, 1);

      unsub();
      tm.registerTask("t2", { agent: "crew-pm" });
      assert.equal(callCount, 1, "should not be called after unsubscribe");
    });

    it("swallows listener errors without crashing", () => {
      tm.subscribe(() => {
        throw new Error("listener boom");
      });
      // Should not throw
      tm.registerTask("t1", { agent: "crew-coder" });
      assert.equal(tm.getActiveTasks().length, 1);
    });
  });
});
