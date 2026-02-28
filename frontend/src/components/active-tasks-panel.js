/**
 * Active Tasks Panel - Shows running tasks with individual controls
 */

import { taskManager } from '../core/task-manager.js';

let _container = null;

export function initActiveTasksPanel(containerId = 'activeTasksPanel') {
  _container = document.getElementById(containerId);
  if (!_container) {
    console.warn('Active tasks panel container not found:', containerId);
    return;
  }

  // Subscribe to task changes
  taskManager.subscribe((tasks) => {
    renderTasksPanel(tasks);
  });

  // Initial render
  renderTasksPanel(taskManager.getActiveTasks());
}

function renderTasksPanel(tasks) {
  if (!_container) return;

  if (tasks.length === 0) {
    _container.style.display = 'none';
    return;
  }

  _container.style.display = 'block';
  
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--border);background:var(--surface-2);';
  
  const title = document.createElement('div');
  title.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-1);';
  title.textContent = `⚡ Active Tasks (${tasks.length})`;
  
  const stopAllBtn = document.createElement('button');
  stopAllBtn.textContent = '⏹ Stop All';
  stopAllBtn.style.cssText = 'font-size:11px;padding:3px 8px;border-radius:4px;border:1px solid var(--red-hi);background:transparent;color:var(--red-hi);cursor:pointer;';
  stopAllBtn.onclick = () => {
    if (confirm('Stop all active tasks?')) {
      taskManager.stopAll();
    }
  };
  
  header.appendChild(title);
  header.appendChild(stopAllBtn);

  const tasksList = document.createElement('div');
  tasksList.style.cssText = 'max-height:200px;overflow-y:auto;';

  tasks.forEach((task) => {
    const taskRow = document.createElement('div');
    taskRow.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border);background:var(--bg-card);';

    // Agent badge
    const agentBadge = document.createElement('span');
    agentBadge.style.cssText = 'font-size:10px;font-weight:600;padding:2px 6px;border-radius:12px;background:var(--purple);color:#fff;white-space:nowrap;';
    agentBadge.textContent = task.agent || task.type || 'task';

    // Task description
    const desc = document.createElement('div');
    desc.style.cssText = 'flex:1;font-size:12px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    desc.textContent = task.description || 'Working...';
    desc.title = task.description || '';

    // Duration
    const duration = document.createElement('span');
    duration.style.cssText = 'font-size:10px;color:var(--text-3);white-space:nowrap;';
    const elapsed = Math.floor((Date.now() - task.startTime) / 1000);
    duration.textContent = `${elapsed}s`;

    // Stop button
    const stopBtn = document.createElement('button');
    stopBtn.textContent = '⏹';
    stopBtn.title = 'Stop this task';
    stopBtn.style.cssText = 'font-size:14px;padding:2px 6px;border-radius:4px;border:1px solid var(--border);background:var(--surface-2);color:var(--red-hi);cursor:pointer;';
    stopBtn.onclick = () => {
      taskManager.stopTask(task.id);
    };

    taskRow.appendChild(agentBadge);
    taskRow.appendChild(desc);
    taskRow.appendChild(duration);
    taskRow.appendChild(stopBtn);
    tasksList.appendChild(taskRow);
  });

  _container.replaceChildren(header, tasksList);

  // Update durations every second
  if (!_container._intervalSet) {
    _container._intervalSet = true;
    setInterval(() => {
      const activeTasks = taskManager.getActiveTasks();
      if (activeTasks.length > 0) {
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
