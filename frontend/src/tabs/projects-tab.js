/**
 * Projects + Build tab — extracted from app.js
 * Deps: getJSON, postJSON (core/api), escHtml, showNotification (core/dom), state (core/state)
 * Uses showChat, showBuild (app.js) via injected helpers or window globals
 */

import { getJSON, postJSON } from '../core/api.js';
import { escHtml, showNotification } from '../core/dom.js';
import { state } from '../core/state.js';

// ── Nav ───────────────────────────────────────────────────────────────────────

export function showBuild(helpers) {
  helpers.hideAllViews();
  document.getElementById('buildView').classList.add('active');
  helpers.setNavActive('navBuild');
  loadPhasedProgress();
}

export function showProjects(helpers) {
  helpers.hideAllViews();
  document.getElementById('projectsView').classList.add('active');
  helpers.setNavActive('navProjects');
  loadProjects();
}

// ── Project list ──────────────────────────────────────────────────────────────

export async function loadProjects() {
  const list = document.getElementById('projectsList');
  list.innerHTML = '<div class="meta" style="padding:20px;">Loading projects...</div>';
  try {
    const data = await getJSON('/api/projects');
    const projects = data.projects || [];
    state.projectsData = {};
    projects.forEach(p => { state.projectsData[p.id] = p; });
    populateChatProjectDropdown(projects);
    if (!projects.length) {
      list.innerHTML = '<div class="meta" style="padding:20px;">No projects yet. Click &quot;+ New Project&quot; to create one.</div>';
      return;
    }
    list.innerHTML = projects.map(p => {
      const id  = escHtml(p.id);
      const pct = p.roadmap.total ? Math.round((p.roadmap.done / p.roadmap.total) * 100) : 0;
      const barColor   = pct === 100 ? 'var(--green)' : pct > 50 ? 'var(--accent)' : 'var(--yellow)';
      const statusBg   = p.status === 'active' ? 'rgba(52,211,153,0.1)' : 'var(--bg-card2)';
      const statusColor= p.status === 'active' ? 'var(--green)' : 'var(--text-3)';
      const retryBtn   = p.roadmap.failed
        ? '<button data-action="retry-failed" data-id="' + id + '" style="background:rgba(248,113,113,0.15);color:var(--red);border:1px solid rgba(248,113,113,0.3);border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px;font-weight:600;">↩ Retry ' + p.roadmap.failed + ' failed</button>'
        : '';
      return '<div class="card" id="proj-card-' + id + '" data-proj-id="' + id + '">'
        + '<div id="proj-view-' + id + '">'
        + '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;">'
        +   '<div>'
        +     '<strong style="font-size:15px;">' + escHtml(p.name) + '</strong>'
        +     '<span style="margin-left:10px;font-size:11px;padding:2px 8px;border-radius:999px;background:' + statusBg + ';color:' + statusColor + ';border:1px solid ' + statusColor + '40;">' + escHtml(p.status) + '</span>'
        +     (p.running ? '<span style="margin-left:8px;font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(99,102,241,0.15);color:var(--purple);border:1px solid rgba(99,102,241,0.3);">▶ running</span>' : '')
        +     (p.description ? '<div class="meta" style="margin-top:4px;">' + escHtml(p.description) + '</div>' : '')
        +   '</div>'
        +   '<div class="meta">' + new Date(p.created).toLocaleDateString() + '</div>'
        + '</div>'
        + '<div style="margin-bottom:12px;">'
        +   '<div style="display:flex;justify-content:space-between;margin-bottom:6px;">'
        +     '<span class="meta">Roadmap</span>'
        +     '<span class="meta">' + p.roadmap.done + '/' + p.roadmap.total + ' done' + (p.roadmap.failed ? ' · ' + p.roadmap.failed + ' failed' : '') + ' · ' + p.roadmap.pending + ' pending</span>'
        +   '</div>'
        +   '<div class="prog-bar"><div class="prog-fill" style="width:' + pct + '%;background:' + barColor + ';"></div></div>'
        + '</div>'
        + '<div style="font-size:11px;color:var(--text-3);margin-bottom:12px;font-family:monospace;">' + escHtml(p.outputDir) + '</div>'
        + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">'
        +   '<button data-action="pm-toggle" data-id="' + id + '" class="' + (p.running ? 'btn-red' : 'btn-green') + '" style="font-size:13px;">' + (p.running ? '⏹ Stop PM Loop' : '▶ Start PM Loop') + '</button>'
        +   '<button data-action="open-build" data-id="' + id + '" class="btn-ghost" style="font-size:13px;">🔧 Build tab</button>'
        +   '<button data-action="edit-roadmap" data-id="' + id + '" class="btn-ghost" style="font-size:13px;" id="roadmap-btn-' + id + '">📋 Roadmap</button>'
        +   '<button data-action="chat-project" data-id="' + id + '" data-name="' + escHtml(p.name) + '" class="btn-ghost" style="font-size:13px;">🧠 Chat</button>'
        +   retryBtn
        +   '<label style="margin-left:auto;display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:var(--text-3);user-select:none;" title="When enabled, crew-lead automatically starts the next ROADMAP phase when the current pipeline completes">'
        +     '<input type="checkbox" data-action="toggle-auto-advance" data-id="' + id + '" ' + (p.autoAdvance ? 'checked' : '') + ' style="accent-color:var(--green);width:14px;height:14px;cursor:pointer;">'
        +     '⚡ Auto-advance'
        +   '</label>'
        +   '<button data-action="edit" data-id="' + id + '" style="background:transparent;color:var(--text-3);border:1px solid var(--border);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;" title="Edit project">✎ Edit</button>'
        +   '<button data-action="delete" data-id="' + id + '" style="background:transparent;color:var(--text-3);border:1px solid var(--border);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;" title="Remove from dashboard (files stay on disk)">🗑 Delete</button>'
        + '</div>'
        + '</div>'
        + '<div id="proj-edit-' + id + '" style="display:none;padding:12px;border-top:1px solid var(--border);margin-top:12px;">'
        +   '<div style="margin-bottom:8px;"><label style="font-size:11px;color:var(--text-3);">Name</label><input id="proj-name-' + id + '" type="text" value="' + escHtml(p.name) + '" style="margin-top:4px;" /></div>'
        +   '<div style="margin-bottom:8px;"><label style="font-size:11px;color:var(--text-3);">Description</label><input id="proj-desc-' + id + '" type="text" value="' + escHtml(p.description || '') + '" style="margin-top:4px;" placeholder="Optional" /></div>'
        +   '<div style="margin-bottom:8px;"><label style="font-size:11px;color:var(--text-3);">Output directory</label><input id="proj-dir-' + id + '" type="text" value="' + escHtml(p.outputDir || '') + '" style="margin-top:4px;" /></div>'
        +   '<div style="display:flex;gap:8px;"><button data-action="save-project-edit" data-id="' + id + '" class="btn-green" style="font-size:12px;">Save</button><button data-action="cancel-project-edit" data-id="' + id + '" class="btn-ghost" style="font-size:12px;">Cancel</button></div>'
        + '</div>'
        + '<div id="proj-pm-status-' + id + '" style="display:none;margin-top:10px;font-size:12px;padding:8px 12px;background:rgba(99,102,241,0.08);border-radius:6px;border:1px solid rgba(99,102,241,0.2);color:#a5b4fc;"></div>'
        + '<div id="rm-editor-' + id + '" style="display:none;margin-top:14px;">'
        +   '<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">'
        +     '<span class="field-label" style="margin:0;">ROADMAP</span>'
        +     '<span class="meta" style="font-family:monospace;">' + escHtml(p.roadmapFile) + '</span>'
        +     '<div style="margin-left:auto;display:flex;gap:6px;">'
        +       '<button data-action="add-item" data-id="' + id + '" style="font-size:11px;padding:3px 10px;background:var(--green);color:#000;">+ Add item</button>'
        +       '<button data-action="skip-next" data-id="' + id + '" style="font-size:11px;padding:3px 10px;background:var(--yellow);color:#000;">⏭ Skip next</button>'
        +       '<button data-action="reset-failed" data-id="' + id + '" style="font-size:11px;padding:3px 10px;" class="btn-ghost">↩ Reset failed</button>'
        +       '<button data-action="save-roadmap" data-id="' + id + '" style="font-size:11px;padding:3px 10px;background:var(--accent);color:#000;">💾 Save</button>'
        +       '<button data-action="close-editor" data-id="' + id + '" style="font-size:11px;padding:3px 10px;" class="btn-ghost">✕</button>'
        +     '</div>'
        +   '</div>'
        +   '<div style="display:flex;gap:8px;margin-bottom:8px;">'
        +     '<input id="rm-add-' + id + '" type="text" placeholder="New item text… (Enter to add)" style="flex:1;font-size:13px;" data-rm-add-id="' + id + '" />'
        +   '</div>'
        +   '<textarea id="rm-ta-' + id + '" rows="16" class="rm-textarea" spellcheck="false"></textarea>'
        +   '<div id="rm-status-' + id + '" class="meta" style="margin-top:6px;min-height:16px;"></div>'
        + '</div>'
        + '</div>';
    }).join('');

    list.querySelectorAll('[data-rm-add-id]').forEach(inp => {
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') addRoadmapItem(inp.dataset.rmAddId); });
    });

  } catch(e) { list.innerHTML = '<div class="meta" style="padding:20px;color:var(--red-hi);">Failed to load projects: ' + escHtml(e.message) + '</div>'; }
}

export function toggleProjectEdit(projectId) {
  const viewEl = document.getElementById('proj-view-' + projectId);
  const editEl = document.getElementById('proj-edit-' + projectId);
  if (!viewEl || !editEl) return;
  const isEditing = editEl.style.display !== 'none';
  viewEl.style.display = isEditing ? '' : 'none';
  editEl.style.display = isEditing ? 'none' : 'block';
}

export async function saveProjectEdit(projectId) {
  const name = document.getElementById('proj-name-' + projectId)?.value?.trim();
  const description = document.getElementById('proj-desc-' + projectId)?.value?.trim();
  const outputDir = document.getElementById('proj-dir-' + projectId)?.value?.trim();
  if (!name) { showNotification('Project name is required', true); return; }
  try {
    await postJSON('/api/projects/update', { projectId, name, description, outputDir });
    showNotification('Project saved');
    toggleProjectEdit(projectId);
    loadProjects();
  } catch(e) { showNotification('Failed: ' + e.message, true); }
}

export function initProjectsList(deps) {
  const el = document.getElementById('projectsList');
  if (!el) return;
  el.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id   = btn.dataset.id;
    const proj = state.projectsData[id];
    switch (btn.dataset.action) {
      case 'pm-toggle':    proj && proj.running ? stopProjectPMLoop(id) : startProjectPMLoop(id); break;
      case 'open-build':   openProjectInBuild(id, deps); break;
      case 'edit-roadmap': proj && openRoadmapEditor(id, proj.roadmapFile); break;
      case 'retry-failed': proj && retryFailed(proj.roadmapFile); break;
      case 'delete':       deleteProject(id); break;
      case 'chat-project': {
        deps.showChat();
        autoSelectChatProject(id);
        document.getElementById('chatInput')?.focus();
        break;
      }
      case 'toggle-auto-advance': {
        const checked = btn.checked;
        postJSON('/api/projects/update', { projectId: id, autoAdvance: checked })
          .then(() => {
            if (state.projectsData[id]) state.projectsData[id].autoAdvance = checked;
            showNotification('Auto-advance ' + (checked ? 'enabled' : 'disabled') + ' for ' + (proj?.name || id));
          })
          .catch(e => { showNotification('Failed: ' + e.message, true); btn.checked = !checked; });
        return;
      }
      case 'edit':              toggleProjectEdit(id); break;
      case 'save-project-edit': saveProjectEdit(id); break;
      case 'cancel-project-edit': toggleProjectEdit(id); break;
      case 'add-item':      addRoadmapItem(id); break;
      case 'skip-next':     skipNextItem(id); break;
      case 'reset-failed':  resetAllFailed(id); break;
      case 'save-roadmap':  saveRoadmap(id); break;
      case 'close-editor':  closeRoadmapEditor(id); break;
    }
  });
}

// ── Chat project dropdown ─────────────────────────────────────────────────────

const CHAT_ACTIVE_PROJECT_KEY = 'crewswarm_chat_active_project_id';

export function getStoredChatProjectId() {
  try { return localStorage.getItem(CHAT_ACTIVE_PROJECT_KEY) || ''; } catch { return ''; }
}
export function setStoredChatProjectId(id) {
  try { if (id) localStorage.setItem(CHAT_ACTIVE_PROJECT_KEY, id); else localStorage.removeItem(CHAT_ACTIVE_PROJECT_KEY); } catch {}
}

export function populateChatProjectDropdown(projects) {
  const sel = document.getElementById('chatProjectSelect');
  if (!sel) return;
  const prev = getStoredChatProjectId() || sel.value || state.chatActiveProjectId;
  sel.innerHTML = '<option value="">— none —</option>';
  (projects || []).forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name + (p.outputDir ? ' (' + p.outputDir.split('/').pop() + ')' : '');
    sel.appendChild(opt);
  });
  if (prev && sel.querySelector('option[value="' + prev + '"]')) {
    sel.value = prev;
    state.chatActiveProjectId = prev;
    setStoredChatProjectId(prev);
    const restoredProj = state.projectsData[prev];
    if (restoredProj && restoredProj.outputDir) {
      postJSON('/api/settings/opencode-project', { dir: restoredProj.outputDir }).catch(() => {});
    }
  } else {
    state.chatActiveProjectId = '';
    setStoredChatProjectId('');
  }
  updateChatProjectHint();
}

export function onChatProjectChange() {
  const sel = document.getElementById('chatProjectSelect');
  state.chatActiveProjectId = sel ? sel.value : '';
  setStoredChatProjectId(state.chatActiveProjectId);
  updateChatProjectHint();
  const proj = state.projectsData[state.chatActiveProjectId];
  if (proj && proj.outputDir) {
    postJSON('/api/settings/opencode-project', { dir: proj.outputDir }).catch(() => {});
  }
}

export function updateChatProjectHint() {
  const hint = document.getElementById('chatProjectHint');
  if (!hint) return;
  if (state.chatActiveProjectId && state.projectsData[state.chatActiveProjectId]) {
    const p = state.projectsData[state.chatActiveProjectId];
    hint.textContent = p.outputDir || '';
    hint.style.display = p.outputDir ? 'block' : 'none';
  } else {
    hint.style.display = 'none';
  }
}

export function autoSelectChatProject(projectId) {
  state.chatActiveProjectId = projectId;
  setStoredChatProjectId(projectId);
  const sel = document.getElementById('chatProjectSelect');
  if (sel && sel.querySelector('option[value="' + projectId + '"]')) {
    sel.value = projectId;
    updateChatProjectHint();
  }
}

// ── PM loop controls ──────────────────────────────────────────────────────────

export async function resumeProject(projectId) {
  try {
    const resp = await fetch('/api/pm-loop/start', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ projectId }) });
    const r = await resp.json();
    if (r.alreadyRunning) { showNotification('PM Loop already running (pid ' + r.pid + ')', true); return; }
    showNotification('PM Loop started for project ' + projectId + ' (pid ' + r.pid + ')');
    setTimeout(loadProjects, 3000);
  } catch(e) { showNotification('Failed: ' + e.message, true); }
}

export async function stopProjectPMLoop(projectId) {
  try {
    await postJSON('/api/pm-loop/stop', { projectId });
    showNotification('Stop signal sent — PM will finish current task then halt.');
    const statusEl = document.getElementById('proj-pm-status-' + projectId);
    if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = '⛔ Stopping after current task…'; }
    setTimeout(loadProjects, 3000);
  } catch(e) { showNotification('Stop failed: ' + e.message, true); }
}

export async function startProjectPMLoop(projectId) {
  const statusEl = document.getElementById('proj-pm-status-' + projectId);
  try {
    if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = '⚙ Starting PM Loop…'; }
    const r = await postJSON('/api/pm-loop/start', { projectId });
    if (r.alreadyRunning) {
      showNotification('PM Loop already running (pid ' + r.pid + ')', true);
      if (statusEl) statusEl.textContent = '▶ Already running (pid ' + r.pid + ')';
      return;
    }
    showNotification('PM Loop started (pid ' + r.pid + ')');
    if (statusEl) statusEl.textContent = '▶ Running (pid ' + r.pid + ') — check Build tab for live log';
    setTimeout(loadProjects, 3000);
  } catch(e) {
    showNotification('Start failed: ' + e.message, true);
    if (statusEl) statusEl.style.display = 'none';
  }
}

export async function deleteProject(projectId) {
  const proj = state.projectsData[projectId];
  const name = proj ? proj.name : projectId;
  if (!confirm('Remove "' + name + '" from the dashboard registry?\n\nFiles on disk are NOT deleted.')) return;
  try {
    await postJSON('/api/projects/delete', { projectId });
    showNotification('Project "' + name + '" removed from dashboard.');
    loadProjects();
  } catch(e) { showNotification('Delete failed: ' + e.message, true); }
}

export function openProjectInBuild(projectId, deps) {
  deps.showBuild();
  loadBuildProjectPicker().then(() => {
    const sel = document.getElementById('buildProjectPicker');
    if (sel) { sel.value = projectId; onBuildProjectChange(); }
  });
}

// ── Build tab project picker ──────────────────────────────────────────────────

let _buildProjects = {};

export async function loadBuildProjectPicker() {
  try {
    const data = await getJSON('/api/projects');
    _buildProjects = {};
    const sel = document.getElementById('buildProjectPicker');
    const cur = sel ? sel.value : '';
    if (!sel) return;
    sel.innerHTML = '<option value="">— No project (use defaults) —</option>';
    (data.projects || []).forEach(p => {
      _buildProjects[p.id] = p;
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name + (p.running ? ' ▶' : '') + ' (' + p.roadmap.pending + ' pending)';
      if (p.id === cur) opt.selected = true;
      sel.appendChild(opt);
    });
    onBuildProjectChange();
  } catch(e) { /* ignore */ }
}

export function onBuildProjectChange() {
  const sel = document.getElementById('buildProjectPicker');
  const info = document.getElementById('buildProjectInfo');
  const label = document.getElementById('pmLoopProjectLabel');
  const proj = _buildProjects[sel ? sel.value : ''];
  if (proj) {
    info.style.display = 'block';
    info.innerHTML =
      '<b>' + proj.name + '</b><br>' +
      'Output: ' + proj.outputDir + '<br>' +
      'Roadmap: ' + proj.roadmapFile + '<br>' +
      'Tasks: ' + proj.roadmap.done + ' done · ' + proj.roadmap.pending + ' pending · ' + proj.roadmap.failed + ' failed' +
      (proj.running ? '<br><span style="color:var(--purple);">▶ PM Loop is running</span>' : '');
    if (label) label.innerHTML =
      '<b style="color:var(--accent);">▶ ' + proj.name + '</b>' +
      ' &nbsp;·&nbsp; ' + proj.roadmap.done + ' done · ' + proj.roadmap.pending + ' pending' +
      (proj.running ? ' &nbsp;<span style="color:var(--green-hi); font-weight:600;">● running</span>' : '');
  } else {
    info.style.display = 'none';
    if (label) label.innerHTML = '← Select a project above';
  }
  loadPhasedProgress();
}

// ── Stop build ────────────────────────────────────────────────────────────────

export async function stopBuild() {
  try {
    await postJSON('/api/build/stop', {});
    showNotification('Build stop signal sent');
    document.getElementById('stopBuildBtn').style.display = 'none';
    document.getElementById('runBuildBtn').style.display = '';
    document.getElementById('buildStatus').textContent = '';
  } catch(e) { showNotification('Stop failed: ' + e.message, true); }
}

export async function stopContinuousBuild() {
  try {
    await postJSON('/api/continuous-build/stop', {});
    showNotification('Continuous build stop signal sent');
    document.getElementById('stopContinuousBtn').style.display = 'none';
    document.getElementById('continuousBuildBtn').style.display = '';
  } catch(e) { showNotification('Stop failed: ' + e.message, true); }
}

export async function retryFailed(roadmapFile) {
  if (!confirm('Reset all [!] failed items back to [ ] pending so the PM Loop retries them?')) return;
  try {
    const r = await postJSON('/api/roadmap/retry-failed', { roadmapFile });
    if (r.count === 0) { showNotification('No failed items found in roadmap', true); return; }
    showNotification('↩ ' + r.count + ' failed item' + (r.count !== 1 ? 's' : '') + ' reset — click Resume to retry');
    await loadProjects();
  } catch(e) { showNotification('Retry failed: ' + e.message, true); }
}

// ── Roadmap editor ────────────────────────────────────────────────────────────

const _roadmapFiles = {};

export async function openRoadmapEditor(projectId, roadmapFile) {
  _roadmapFiles[projectId] = roadmapFile;
  const panel = document.getElementById('rm-editor-' + projectId);
  const ta    = document.getElementById('rm-ta-' + projectId);
  const btn   = document.getElementById('roadmap-btn-' + projectId);
  if (!panel || !ta) return;
  if (panel.style.display !== 'none') { closeRoadmapEditor(projectId); return; }
  panel.style.display = 'block';
  if (btn) btn.textContent = '📋 Editing…';
  ta.value = 'Loading…';
  try {
    const r = await postJSON('/api/roadmap/read', { roadmapFile });
    ta.value = r.content || '';
    setRmStatus(projectId, 'Loaded · ' + (r.content || '').split('\n').length + ' lines');
  } catch(e) { ta.value = ''; setRmStatus(projectId, 'Error: ' + e.message, true); }
}

export function closeRoadmapEditor(projectId) {
  const panel = document.getElementById('rm-editor-' + projectId);
  const btn   = document.getElementById('roadmap-btn-' + projectId);
  if (panel) panel.style.display = 'none';
  if (btn) btn.textContent = '📋 Edit Roadmap';
}

function setRmStatus(projectId, msg, isErr) {
  const el = document.getElementById('rm-status-' + projectId);
  if (!el) return;
  el.textContent = msg;
  el.style.color = isErr ? 'var(--red)' : 'var(--text-2)';
}

export async function saveRoadmap(projectId) {
  const ta = document.getElementById('rm-ta-' + projectId);
  const roadmapFile = _roadmapFiles[projectId];
  if (!ta || !roadmapFile) return;
  try {
    await postJSON('/api/roadmap/write', { roadmapFile, content: ta.value });
    setRmStatus(projectId, '✓ Saved — ' + new Date().toLocaleTimeString());
    showNotification('Roadmap saved');
    setTimeout(loadProjects, 800);
  } catch(e) { setRmStatus(projectId, 'Save failed: ' + e.message, true); }
}

export function addRoadmapItem(projectId) {
  const ta    = document.getElementById('rm-ta-' + projectId);
  const input = document.getElementById('rm-add-' + projectId);
  if (!ta) return;
  const text = (input ? input.value.trim() : '') || 'New task';
  if (!text) return;
  const line = '- [ ] ' + text;
  ta.value = ta.value.trimEnd() + '\n' + line + '\n';
  ta.scrollTop = ta.scrollHeight;
  if (input) input.value = '';
  setRmStatus(projectId, 'Item added — click 💾 Save to persist');
}

export function skipNextItem(projectId) {
  const ta = document.getElementById('rm-ta-' + projectId);
  if (!ta) return;
  const lines = ta.value.split('\n');
  let skipped = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^- \[ \]/.test(lines[i])) {
      lines[i] = lines[i].replace('- [ ]', '- [x]') + '  ✓ skipped';
      skipped = true;
      break;
    }
  }
  if (skipped) {
    ta.value = lines.join('\n');
    setRmStatus(projectId, 'Next pending item skipped — click 💾 Save to persist');
  } else {
    setRmStatus(projectId, 'No pending items to skip');
  }
}

export async function resetAllFailed(projectId) {
  const ta = document.getElementById('rm-ta-' + projectId);
  if (!ta) return;
  const before = (ta.value.match(/\[!\]/g) || []).length;
  if (!before) { setRmStatus(projectId, 'No failed items to reset'); return; }
  ta.value = ta.value
    .split('\n')
    .map(l => l.replace(/\[!\]/, '[ ]').replace(/\s+✗\s+\d+:\d+:\d+/g, ''))
    .join('\n');
  setRmStatus(projectId, before + ' failed item(s) reset — click 💾 Save to persist');
}

// ── Build tab ─────────────────────────────────────────────────────────────────

export async function loadPhasedProgress() {
  const box = document.getElementById('phasedProgress');
  if (!box) return;
  const projectId = document.getElementById('buildProjectPicker')?.value || '';
  const label = document.getElementById('phasedProgressLabel');
  try {
    const url = '/api/phased-progress' + (projectId ? '?projectId=' + encodeURIComponent(projectId) : '');
    const data = await getJSON(url);
    const scopeText = projectId ? 'This project' : 'All projects (no project selected)';
    if (label) label.textContent = scopeText;
    if (!data.length) {
      box.textContent = projectId ? 'No runs yet for this project.' : 'No phased runs yet.';
      return;
    }
    box.innerHTML = data.map(e => {
      const phase = e.phase || '?';
      const agent = e.agent || '?';
      const task = (e.task || '').slice(0, 50) + ((e.task || '').length > 50 ? '...' : '');
      const status = e.status === 'completed' ? '✅' : '❌';
      const dur = e.duration_s != null ? e.duration_s + 's' : '';
      return `<div style="margin-bottom:4px;">${status} [${phase}] ${agent}: ${task} ${dur}</div>`;
    }).join('');
    box.scrollTop = box.scrollHeight;
  } catch (e) { box.textContent = 'Could not load progress.'; }
}

export async function runBuild() {
  const req = document.getElementById('buildRequirement').value.trim();
  if (!req) { showNotification('Enter a requirement', true); return; }
  const status = document.getElementById('buildStatus');
  const btn = document.getElementById('runBuildBtn');
  const stopBtn = document.getElementById('stopBuildBtn');
  const projectId = document.getElementById('buildProjectPicker')?.value || '';
  try {
    status.textContent = 'Starting...';
    btn.disabled = true;
    const r = await postJSON('/api/build', { requirement: req, projectId });
    showNotification('Build started (pid ' + r.pid + '). Watch RT Messages or Phased Progress.');
    status.textContent = 'Running (pid ' + r.pid + ')';
    btn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = '';
    setTimeout(() => {
      status.textContent = '';
      btn.disabled = false;
      btn.style.display = '';
      if (stopBtn) stopBtn.style.display = 'none';
    }, 120000);
  } catch (e) { showNotification('Build failed: ' + e.message, true); status.textContent = ''; btn.disabled = false; }
}

export async function enhancePrompt() {
  const ta = document.getElementById('buildRequirement');
  const raw = ta.value.trim();
  const btn = document.getElementById('enhancePromptBtn');
  if (!raw) { showNotification('Type an idea first', true); return; }
  try {
    btn.disabled = true;
    document.getElementById('buildStatus').textContent = 'Enhancing...';
    const r = await postJSON('/api/enhance-prompt', { text: raw });
    if (r.enhanced) { ta.value = r.enhanced; showNotification('Prompt updated'); }
    else { showNotification(r.error || 'No result', true); }
  } catch (e) { showNotification('Enhance failed: ' + e.message, true); }
  finally { btn.disabled = false; document.getElementById('buildStatus').textContent = ''; }
}

export async function continuousBuildRun() {
  const req = document.getElementById('buildRequirement').value.trim();
  if (!req) { showNotification('Enter a requirement first', true); return; }
  const status = document.getElementById('buildStatus');
  const btn = document.getElementById('continuousBuildBtn');
  const stopBtn = document.getElementById('stopContinuousBtn');
  const logBox = document.getElementById('buildLiveLog');
  const projectId = document.getElementById('buildProjectPicker')?.value || '';
  try {
    status.textContent = 'Running continuously...';
    btn.disabled = true;
    btn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = '';
    logBox.style.display = 'block';
    logBox.textContent = '⚙ Starting continuous build...\n';
    const r = await postJSON('/api/continuous-build', { requirement: req, projectId });
    logBox.textContent += '✅ Spawned (pid ' + r.pid + '). Checking progress below and in RT Messages tab.\n';
    showNotification('Continuous build started — will keep going until all sections are done.');
    status.textContent = 'Running (continuous)';
    const poller = setInterval(async () => {
      try {
        const lg = await fetch('/api/continuous-build/log').then(r2 => r2.json());
        if (lg.lines && lg.lines.length) {
          logBox.textContent = lg.lines.map(l => {
            const icon = l.status === 'completed' ? '✅' : l.status === 'failed' ? '❌' : l.status === 'done' ? '🏁' : '·';
            return `${icon} [rd${l.round||'?'}] ${l.agent ? l.agent+': ' : ''}${l.task || l.status || JSON.stringify(l)}`;
          }).join('\n');
          logBox.scrollTop = logBox.scrollHeight;
          const last = lg.lines[lg.lines.length - 1];
          if (last && last.status === 'done') {
            clearInterval(poller);
            btn.disabled = false;
            btn.style.display = '';
            if (stopBtn) stopBtn.style.display = 'none';
            status.textContent = '🏁 Done!';
            showNotification('🏁 Continuous build complete!');
          }
        }
      } catch(_){}
    }, 4000);
    setTimeout(() => {
      clearInterval(poller);
      btn.disabled = false;
      btn.style.display = '';
      if (stopBtn) stopBtn.style.display = 'none';
      if (status.textContent.includes('continuous')) status.textContent = '';
    }, 30 * 60 * 1000);
  } catch (e) {
    showNotification('Continuous build failed: ' + e.message, true);
    status.textContent = '';
    btn.disabled = false;
    btn.style.display = '';
    if (stopBtn) stopBtn.style.display = 'none';
  }
}
