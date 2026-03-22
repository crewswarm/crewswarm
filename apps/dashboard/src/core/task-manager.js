/**
 * Task Manager - Tracks and controls active tasks/agents
 * Allows individual stop controls and concurrent operations
 */

export class TaskManager {
  constructor() {
    this.activeTasks = new Map(); // taskId -> { agent, controller, startTime, status, type }
    this.listeners = new Set();
  }

  /**
   * Register a new task with abort controller
   * @param {string} taskId - Unique task identifier
   * @param {object} details - { agent, type, description, controller }
   */
  registerTask(taskId, details) {
    this.activeTasks.set(taskId, {
      ...details,
      startTime: Date.now(),
      status: 'running',
    });
    this.notifyListeners();
  }

  /**
   * Stop a specific task by ID
   * @param {string} taskId
   */
  stopTask(taskId) {
    const task = this.activeTasks.get(taskId);
    if (!task) return false;
    
    if (task.controller) {
      task.controller.abort();
    }
    
    task.status = 'stopped';
    this.activeTasks.delete(taskId);
    this.notifyListeners();
    return true;
  }

  /**
   * Mark task as completed
   * @param {string} taskId
   */
  completeTask(taskId) {
    const task = this.activeTasks.get(taskId);
    if (!task) return;
    
    task.status = 'completed';
    this.activeTasks.delete(taskId);
    this.notifyListeners();
  }

  /**
   * Mark task as failed
   * @param {string} taskId
   * @param {string} error
   */
  failTask(taskId, error) {
    const task = this.activeTasks.get(taskId);
    if (!task) return;
    
    task.status = 'failed';
    task.error = error;
    this.activeTasks.delete(taskId);
    this.notifyListeners();
  }

  /**
   * Get all active tasks
   */
  getActiveTasks() {
    return Array.from(this.activeTasks.entries()).map(([id, task]) => ({
      id,
      ...task,
    }));
  }

  /**
   * Check if a specific agent is currently busy
   * @param {string} agent
   */
  isAgentBusy(agent) {
    return Array.from(this.activeTasks.values()).some(
      (task) => task.agent === agent && task.status === 'running'
    );
  }

  /**
   * Stop all tasks
   */
  stopAll() {
    for (const [taskId] of this.activeTasks) {
      this.stopTask(taskId);
    }
  }

  /**
   * Stop all tasks for a specific agent
   * @param {string} agent
   */
  stopAgent(agent) {
    for (const [taskId, task] of this.activeTasks) {
      if (task.agent === agent) {
        this.stopTask(taskId);
      }
    }
  }

  /**
   * Subscribe to task changes
   * @param {function} callback
   */
  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notifyListeners() {
    for (const listener of this.listeners) {
      try {
        listener(this.getActiveTasks());
      } catch (err) {
        console.error('TaskManager listener error:', err);
      }
    }
  }
}

// Singleton instance
export const taskManager = new TaskManager();
