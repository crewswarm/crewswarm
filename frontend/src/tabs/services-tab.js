import { getJSON, postJSON } from '../core/api.js';
import { escHtml, showNotification } from '../core/dom.js';

let servicesPollTimer = null;
let hideAllViews = () => {};
let setNavActive = () => {};

export function initServicesTab(deps = {}) {
  hideAllViews = deps.hideAllViews || hideAllViews;
  setNavActive = deps.setNavActive || setNavActive;
}

export function showServices() {
  hideAllViews();
  document.getElementById('servicesView').classList.add('active');
  setNavActive('navServices');
  loadServices();
  if (servicesPollTimer) clearInterval(servicesPollTimer);
  servicesPollTimer = setInterval(() => {
    if (document.getElementById('servicesView').classList.contains('active')) loadServices();
    else { clearInterval(servicesPollTimer); servicesPollTimer = null; }
  }, 10000);
}

export async function loadServices() {
  const grid = document.getElementById('servicesGrid');
  if (!grid) return;
  grid.innerHTML = '<div class="meta" style="padding:20px;">Checking services...</div>';
  try {
    const services = await getJSON('/api/services/status');
    const downCount = services.filter(s => !s.running).length;
    const badge = document.getElementById('servicesBadge');
    if (badge) {
      if (downCount > 0) {
        badge.textContent = downCount;
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    }
    grid.innerHTML = services.map(svc => {
      const up = svc.running;
      const canRestart = svc.canRestart;
      const statusColor = up ? 'var(--green-hi)' : 'var(--red-hi)';
      const statusText = up ? (svc.pid ? '● running  pid ' + svc.pid : '● running') : '● stopped';
      const uptime = svc.uptimeSec ? formatUptime(svc.uptimeSec) : '';
      return '<div class="card" style="display:flex;flex-direction:column;gap:10px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;">' +
          '<div>' +
            '<div style="font-weight:700;font-size:14px;margin-bottom:3px;">' + escHtml(svc.label) + '</div>' +
            '<div style="font-size:11px;color:var(--text-3);">' + escHtml(svc.description) + '</div>' +
          '</div>' +
          '<span style="font-size:11px;font-weight:600;color:' + statusColor + ';white-space:nowrap;margin-left:8px;">' + statusText + '</span>' +
        '</div>' +
        (uptime ? '<div style="font-size:11px;color:var(--text-3);">Up ' + uptime + '</div>' : '') +
        (svc.port ? '<div style="font-size:11px;color:var(--text-3);">Port ' + svc.port + '</div>' : '') +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
          (canRestart && up ? '<button class="btn-ghost" style="font-size:12px;" data-action="restartService" data-arg="' + svc.id + '">↻ Restart</button>' : '') +
          (canRestart && !up ? '<button class="btn-green" style="font-size:12px;" data-action="restartService" data-arg="' + svc.id + '">▶ Start</button>' : '') +
          (canRestart && up ? '<button class="btn-red" style="font-size:12px;" data-action="stopService" data-arg="' + svc.id + '">⏹ Stop</button>' : '') +
          (!canRestart ? '<span style="font-size:11px;color:var(--text-3);align-self:center;">managed externally</span>' : '') +
        '</div>' +
      '</div>';
    }).join('');
  } catch (e) {
    grid.innerHTML = '<div class="meta" style="padding:20px;color:var(--red-hi);">Error loading services: ' + e.message + '</div>';
    showNotification('⚠️ Failed to load services: ' + e.message, true);
  }
}

function formatUptime(sec) {
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
  return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
}

export async function restartService(id) {
  // Debounce: prevent rapid double-clicks
  const now = Date.now();
  const lastRestart = window._lastServiceRestart || {};
  if (lastRestart[id] && (now - lastRestart[id]) < 3000) {
    showNotification('⏳ Restart already in progress...', 'warning');
    return;
  }
  if (!window._lastServiceRestart) window._lastServiceRestart = {};
  window._lastServiceRestart[id] = now;
  
  const r = await postJSON('/api/services/restart', { id });
  if (r && r.ok === false && r.message) {
    showNotification('⚠️ ' + r.message, 'warning');
  } else {
    showNotification('Restarting ' + id + '...');
    setTimeout(loadServices, 3000);
  }
}

export async function stopService(id) {
  // Debounce: prevent rapid double-clicks
  const now = Date.now();
  const lastStop = window._lastServiceStop || {};
  if (lastStop[id] && (now - lastStop[id]) < 2000) {
    showNotification('⏳ Stop already in progress...', 'warning');
    return;
  }
  if (!window._lastServiceStop) window._lastServiceStop = {};
  window._lastServiceStop[id] = now;
  
  const r = await postJSON('/api/services/stop', { id });
  if (r && r.ok === false && r.message) {
    showNotification('⚠️ ' + r.message, 'warning');
  } else {
    showNotification('Stopping ' + id + '...');
    setTimeout(loadServices, 1500);
  }
}
