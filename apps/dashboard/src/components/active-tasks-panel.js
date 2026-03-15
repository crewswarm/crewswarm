/**
 * Active Tasks Panel - Shows running tasks with individual controls
 */

import { taskManager } from '../core/task-manager.js';

let _container = null;
let _completedTasks = []; // Track recently completed tasks
const COMPLETED_TASK_RETENTION_MS = 5 * 60 * 1000; // Keep for 5 minutes

function getRecentCompletedTasks() {
  const now = Date.now();
  // Filter out tasks older than 5 minutes
  _completedTasks = _completedTasks.filter(t => now - t.completedAt < COMPLETED_TASK_RETENTION_MS);
  return _completedTasks;
}

export function initActiveTasksPanel(containerId = 'activeTasksPanel') {
  _container = document.getElementById(containerId);
  if (!_container) {
    console.warn('Active tasks panel container not found:', containerId);
    return;
  }

  // Subscribe to task changes
  taskManager.subscribe((tasks) => {
    // Track completed tasks before they're removed
    const activeTasks = taskManager.getActiveTasks();
    const taskIds = new Set(activeTasks.map(t => t.id));
    
    // Find tasks that just completed (were in list before, not anymore)
    if (_container._lastTaskIds) {
      _container._lastTaskIds.forEach(oldId => {
        if (!taskIds.has(oldId)) {
          // Task completed or failed - add to completed list
          const existingCompleted = _completedTasks.find(t => t.id === oldId);
          if (!existingCompleted) {
            _completedTasks.push({
              id: oldId,
              agent: 'Task',
              type: 'completed',
              status: 'completed',
              completedAt: Date.now(),
              startTime: Date.now() - 30000, // Estimate it took 30s
              duration: '30s'
            });
          }
        }
      });
    }
    
    _container._lastTaskIds = taskIds;
    renderTasksPanel(tasks);
  });

  // Initial render
  renderTasksPanel(taskManager.getActiveTasks());
}

function renderTasksPanel(tasks) {
  if (!_container) return;

  // Get recent completed tasks
  const recentCompletions = getRecentCompletedTasks();
  const allTasks = [...tasks, ...recentCompletions];

  if (allTasks.length === 0) {
    _container.style.display = 'none';
    return;
  }

  _container.style.display = 'block';
  
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--border);background:var(--surface-2);';
  
  const title = document.createElement('div');
  title.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-1);';
  const activeCount = tasks.length;
  const completedCount = recentCompletions.length;
  title.textContent = `⚡ Tasks: ${activeCount} active${completedCount > 0 ? `, ${completedCount} completed` : ''}`;
  
  const stopAllBtn = document.createElement('button');
  stopAllBtn.textContent = '⏹ Stop All';
  stopAllBtn.style.cssText = 'font-size:11px;padding:3px 8px;border-radius:4px;border:1px solid var(--red-hi);background:transparent;color:var(--red-hi);cursor:pointer;';
  stopAllBtn.onclick = () => {
    if (confirm('Stop all active tasks?')) {
      taskManager.stopAll();
    }
  };
  
  header.appendChild(title);
  if (activeCount > 0) header.appendChild(stopAllBtn);

  const tasksList = document.createElement('div');
  tasksList.style.cssText = 'max-height:200px;overflow-y:auto;';

  allTasks.forEach((task) => {
    const isCompleted = task.status === 'completed' || task.status === 'failed';
    const taskRow = document.createElement('div');
    taskRow.style.cssText = `display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border);background:var(--bg-card);${isCompleted ? 'opacity:0.6;' : ''}`;

    // Status icon
    const statusIcon = document.createElement('span');
    statusIcon.style.cssText = 'font-size:14px;flex-shrink:0;';
    if (task.status === 'completed') {
      statusIcon.textContent = '✅';
    } else if (task.status === 'failed') {
      statusIcon.textContent = '❌';
    } else {
      statusIcon.textContent = '⚡';
    }

    // Agent badge
    const agentBadge = document.createElement('span');
    agentBadge.style.cssText = 'font-size:10px;font-weight:600;padding:2px 6px;border-radius:12px;background:var(--purple);color:#fff;white-space:nowrap;';
    agentBadge.textContent = task.agent || task.type || 'task';

    // Task description
    const desc = document.createElement('div');
    desc.style.cssText = 'flex:1;font-size:12px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    desc.textContent = task.description || (isCompleted ? 'Completed' : 'Working...');
    desc.title = task.description || '';

    // Duration
    const duration = document.createElement('span');
    duration.style.cssText = 'font-size:10px;color:var(--text-3);white-space:nowrap;';
    const elapsed = task.duration || (Math.floor((Date.now() - task.startTime) / 1000) + 's');
    duration.textContent = elapsed;

    taskRow.appendChild(statusIcon);
    taskRow.appendChild(agentBadge);
    taskRow.appendChild(desc);
    taskRow.appendChild(duration);

    // Stop button only for active tasks
    if (!isCompleted) {
      const stopBtn = document.createElement('button');
      stopBtn.textContent = '⏹';
      stopBtn.title = 'Stop this task';
      stopBtn.style.cssText = 'font-size:14px;padding:2px 6px;border-radius:4px;border:1px solid var(--border);background:var(--surface-2);color:var(--red-hi);cursor:pointer;';
      stopBtn.onclick = () => {
        taskManager.stopTask(task.id);
      };
      taskRow.appendChild(stopBtn);
    }

    tasksList.appendChild(taskRow);
  });

  _container.replaceChildren(header, tasksList);

  // Update durations every second
  if (!_container._intervalSet) {
    _container._intervalSet = true;
    setInterval(() => {
      const activeTasks = taskManager.getActiveTasks();
      if (activeTasks.length > 0 || getRecentCompletedTasks().length > 0) {
        renderTasksPanel(activeTasks);
      }
    }, 1000);
  }
}

export function showActiveTasksPanel() {
  if (_container) {
    _container.style.display = 'block';
  }
}

export function hideActiveTasksPanel() {
  if (_container) {
    _container.style.display = 'none';
  }
}
