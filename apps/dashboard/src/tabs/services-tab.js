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
  const summary = document.getElementById('servicesSummary');
  if (!grid) return;
  const hasRenderedServices = grid.children.length > 0;
  if (!hasRenderedServices) {
    grid.innerHTML = '<div class="meta" style="padding:20px;">Checking services...</div>';
  }
  try {
    const services = await getJSON('/api/services/status');
    const downCount = services.filter(s => !s.running && !s.optional).length;
    const optionalDown = services.filter(s => !s.running && s.optional).length;
    const badge = document.getElementById('servicesBadge');
    if (badge) {
      if (downCount > 0) {
        badge.textContent = downCount;
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    }
    if (summary) {
      const runningCount = services.filter(s => s.running).length;
      const totalCount = services.length;
      let tone = 'rgba(52, 211, 153, 0.08)';
      let border = 'rgba(52, 211, 153, 0.26)';
      let heading = `Healthy: ${runningCount}/${totalCount} services are up`;
      let detail = 'You can keep working normally.';
      if (downCount > 0) {
        tone = 'rgba(248, 113, 113, 0.08)';
        border = 'rgba(248, 113, 113, 0.28)';
        heading = `${downCount} required service${downCount === 1 ? '' : 's'} down`;
        detail = 'Try the service-specific restart first. If multiple services are down, run `npm run restart-all`, wait a few seconds, then refresh this tab.';
      } else if (optionalDown > 0) {
        tone = 'rgba(251, 191, 36, 0.08)';
        border = 'rgba(251, 191, 36, 0.28)';
        heading = `${optionalDown} optional service${optionalDown === 1 ? '' : 's'} down`;
        detail = 'Core chat/runtime is still available. Start the optional service only if you need that surface.';
      }
      summary.style.display = 'block';
      summary.style.background = tone;
      summary.style.borderColor = border;
      summary.innerHTML =
        '<div style="font-weight:700;margin-bottom:6px;">' + escHtml(heading) + '</div>' +
        '<div style="font-size:12px;color:var(--text-2);line-height:1.5;">' + escHtml(detail) + '</div>';
    }
    grid.innerHTML = services.map(svc => {
      const up = svc.running;
      const canRestart = svc.canRestart;
      const statusColor = up ? 'var(--green-hi)' : 'var(--red-hi)';
      const statusText = svc.statusText || (up ? (svc.pid ? '● running  pid ' + svc.pid : '● running') : '● stopped');
      const uptime = svc.uptimeSec ? formatUptime(svc.uptimeSec) : '';
      const footerNote = svc.noteText || (!canRestart ? 'status only' : '');
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
          (!canRestart ? '<span style="font-size:11px;color:var(--text-3);align-self:center;">' + escHtml(footerNote) + '</span>' : '') +
        '</div>' +
      '</div>';
    }).join('');
  } catch (e) {
    if (summary) {
      summary.style.display = 'block';
      summary.style.background = 'rgba(248, 113, 113, 0.08)';
      summary.style.borderColor = 'rgba(248, 113, 113, 0.28)';
      summary.innerHTML =
        '<div style="font-weight:700;margin-bottom:6px;">Services status unavailable</div>' +
        '<div style="font-size:12px;color:var(--text-2);line-height:1.5;">Run <code>npm run doctor</code> to check the stack, then try <code>npm run restart-all</code> if the dashboard API is up but service status is stale.</div>';
    }
    if (!hasRenderedServices) {
      grid.innerHTML = '<div class="meta" style="padding:20px;color:var(--red-hi);">Error loading services: ' + e.message + '<div style="margin-top:8px;color:var(--text-3);font-size:12px;">Try <code>npm run doctor</code>, then <code>npm run restart-all</code> if core services are down.</div></div>';
    }
    showNotification('⚠️ Failed to load services: ' + e.message, true);
  }
}

function formatUptime(sec) {
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
  return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
}

export async function restartService(id) {
  // Find and disable the button immediately
  const btn = document.querySelector(`button[data-action="restartService"][data-arg="${id}"]`);
  if (btn) {
    btn.disabled = true;
    btn.style.opacity = '0.5';
    btn.style.cursor = 'not-allowed';
  }
  
  // Debounce: prevent rapid double-clicks
  const now = Date.now();
  const lastRestart = window._lastServiceRestart || {};
  if (lastRestart[id] && (now - lastRestart[id]) < 3000) {
    showNotification('⏳ Restart already in progress...', 'warning');
    if (btn) {
      btn.disabled = false;
      btn.style.opacity = '';
      btn.style.cursor = '';
    }
    return;
  }
  if (!window._lastServiceRestart) window._lastServiceRestart = {};
  window._lastServiceRestart[id] = now;
  
  try {
    const r = await postJSON('/api/services/restart', { id });
    if (r && r.ok === false && r.message) {
      showNotification('⚠️ ' + r.message, 'warning');
    } else {
      showNotification('Restarting ' + id + '... Refresh in a few seconds if the status looks stale.');
      // Reload after delay to show new status
      setTimeout(loadServices, id === 'crew-lead' ? 4000 : 3000);
    }
  } catch (e) {
    showNotification('❌ Restart failed: ' + e.message + ' — try `npm run doctor` or a full `npm run restart-all`.', true);
    if (btn) {
      btn.disabled = false;
      btn.style.opacity = '';
      btn.style.cursor = '';
    }
  }
}

export async function stopService(id) {
  // Find and disable all buttons for this service immediately
  const buttons = document.querySelectorAll(`button[data-arg="${id}"]`);
  buttons.forEach(b => {
    b.disabled = true;
    b.style.opacity = '0.5';
    b.style.cursor = 'not-allowed';
  });
  
  // Debounce: prevent rapid double-clicks
  const now = Date.now();
  const lastStop = window._lastServiceStop || {};
  if (lastStop[id] && (now - lastStop[id]) < 2000) {
    showNotification('⏳ Stop already in progress...', 'warning');
    buttons.forEach(b => {
      b.disabled = false;
      b.style.opacity = '';
      b.style.cursor = '';
    });
    return;
  }
  if (!window._lastServiceStop) window._lastServiceStop = {};
  window._lastServiceStop[id] = now;
  
  try {
    const r = await postJSON('/api/services/stop', { id });
    if (r && r.ok === false && r.message) {
      showNotification('⚠️ ' + r.message, 'warning');
    } else {
      showNotification('Stopping ' + id + '...');
      // Reload after delay to show new status
      setTimeout(loadServices, 1500);
    }
  } catch (e) {
    showNotification('❌ Stop failed: ' + e.message + ' — use `npm run doctor` if service state looks inconsistent.', true);
    buttons.forEach(b => {
      b.disabled = false;
      b.style.opacity = '';
      b.style.cursor = '';
    });
  }
}
