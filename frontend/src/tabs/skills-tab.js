/**
 * Skills tab — extracted from app.js
 * Deps: getJSON, postJSON, showNotification (from core/)
 */

import { getJSON, postJSON } from '../core/api.js';
import { showNotification } from '../core/dom.js';

let _skillsCache = [];

export function showSkills() {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('skillsView').classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const nav = document.getElementById('navSkills');
  if (nav) nav.classList.add('active');
  loadSkills();
  if (typeof loadPendingApprovals === 'function') loadPendingApprovals();
}

export function showRunSkills() {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const view = document.getElementById('runSkillsView');
  if (view) view.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const nav = document.getElementById('navRunSkills');
  if (nav) nav.classList.add('active');
  loadRunSkills();
}

export async function loadRunSkills() {
  const el = document.getElementById('runSkillsGrid');
  if (!el) return;
  try {
    const d = await (await fetch('/api/health')).json();
    const skills = (d.skills || []).filter(s => !s.error);
    if (!skills.length) {
      el.innerHTML = '<div style="color:var(--text-3);font-size:13px;">No skills in health snapshot. Add skills in the Skills tab or add JSON files to ~/.crewswarm/skills/</div>';
      return;
    }
    el.innerHTML = skills.map(s => {
      const defaults = s.defaultParams && Object.keys(s.defaultParams).length
        ? JSON.stringify(s.defaultParams, null, 2) : '{}';
      const paramHint = (s.paramNotes || s.description || '').slice(0, 120);
      const safeName = (s.name || '').replace(/"/g, '&quot;');
      return '<div class="card" style="display:flex;flex-direction:column;">'
        + '<div class="card-title" style="margin-bottom:6px;">' + (s.name || 'unnamed') + '</div>'
        + '<div style="font-size:12px;color:var(--text-3);margin-bottom:10px;line-height:1.4;">' + (s.description || '') + '</div>'
        + (paramHint ? '<div style="font-size:11px;color:var(--text-2);margin-bottom:8px;">' + paramHint + '</div>' : '')
        + '<label style="font-size:11px;color:var(--text-2);margin-bottom:4px;">Params (JSON)</label>'
        + '<textarea data-skill="' + safeName + '" rows="4" style="font-family:monospace;font-size:12px;width:100%;margin-bottom:10px;resize:vertical;" class="runskills-params">' + defaults.replace(/</g, '&lt;') + '</textarea>'
        + '<div style="display:flex;align-items:center;gap:8px;margin-top:auto;">'
        + '<button class="btn-green" style="font-size:12px;" data-action="runSkillFromUI" data-arg="' + safeName + '">Run</button>'
        + '<span class="runskills-result" data-skill="' + safeName + '" style="font-size:11px;color:var(--text-3);"></span>'
        + '</div></div>';
    }).join('');
  } catch (e) {
    el.innerHTML = '<div style="color:var(--red);font-size:12px;">Error loading health/skills: ' + (e.message || '') + '</div>';
  }
}

export async function runSkillFromUI(skillName) {
  const textarea = document.querySelector('.runskills-params[data-skill="' + (skillName || '').replace(/"/g, '\\"') + '"]');
  const resultEl = document.querySelector('.runskills-result[data-skill="' + (skillName || '').replace(/"/g, '\\"') + '"]');
  if (!textarea) return;
  let params = {};
  try { params = JSON.parse(textarea.value.trim() || '{}'); } catch (e) {
    if (resultEl) resultEl.textContent = 'Invalid JSON';
    return;
  }
  if (resultEl) resultEl.textContent = 'Running…';
  try {
    const r = await fetch('/api/skills/' + encodeURIComponent(skillName) + '/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ params })
    });
    const data = await r.json();
    if (resultEl) {
      if (data.ok) resultEl.textContent = 'Done';
      else resultEl.textContent = data.error || 'Error';
      resultEl.style.color = data.ok ? 'var(--green)' : 'var(--red)';
    }
    if (!data.ok) return;
    if (data.result !== undefined && resultEl) {
      const preview = typeof data.result === 'string' ? data.result : JSON.stringify(data.result).slice(0, 120);
      resultEl.textContent = preview + (preview.length >= 120 ? '…' : '');
    }
  } catch (e) {
    if (resultEl) { resultEl.textContent = e.message || 'Request failed'; resultEl.style.color = 'var(--red)'; }
  }
}

export async function loadSkills() {
  const el = document.getElementById('skillsList');
  try {
    const d = await (await fetch('/api/skills')).json();
    _skillsCache = d.skills || [];
    renderSkillsList(_skillsCache);
  } catch(e) {
    if (el) el.innerHTML = '<div style="color:var(--text-3);font-size:12px;">Error loading skills</div>';
  }
}

export function renderSkillsList(skills) {
  const el = document.getElementById('skillsList');
  if (!el) return;
  if (!skills.length) {
    el.innerHTML = '<div style="color:var(--text-3);font-size:12px;padding:8px 0;">No skills match. Add one above or copy JSONs to ~/.crewswarm/skills/</div>';
    return;
  }
  el.innerHTML = skills.map(s => {
    const approvalBadge = s.requiresApproval
      ? '<span style="margin-left:8px;font-size:10px;background:rgba(251,191,36,0.15);color:var(--yellow);padding:2px 6px;border-radius:4px;">⚠️ approval</span>' : '';
    const urlNote = s.url
      ? ' · <code style="background:var(--bg-1);padding:1px 4px;border-radius:3px;">' + (s.method||'POST') + ' ' + (s.url||'').slice(0,60) + '</code>' : '';
    return '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--bg-2);border-radius:var(--radius);border:1px solid var(--border);">'
      + '<div><span style="font-weight:600;font-size:13px;">' + s.name + '</span>' + approvalBadge
      + '<div style="font-size:11px;color:var(--text-3);margin-top:3px;">' + (s.description||'') + urlNote + '</div></div>'
      + '<div style="display:flex;gap:6px;flex-shrink:0;">'
      + '<button class="btn-ghost" style="font-size:11px;" data-action="editSkill" data-arg="' + s.name + '">Edit</button>'
      + '<button class="btn-ghost" style="font-size:11px;color:var(--red);" data-action="deleteSkill" data-arg="' + s.name + '">Delete</button>'
      + '</div></div>';
  }).join('');
}

export function filterSkills(q) {
  const lower = q.toLowerCase();
  renderSkillsList(lower ? _skillsCache.filter(s =>
    (s.name||'').toLowerCase().includes(lower) ||
    (s.description||'').toLowerCase().includes(lower) ||
    (s.url||'').toLowerCase().includes(lower)
  ) : _skillsCache);
}

export function editSkill(name) {
  const s = _skillsCache.find(x => x.name === name);
  if (!s) return;
  document.getElementById('skEditName').value = name;
  document.getElementById('addSkillFormTitle').textContent = 'Edit Skill';
  document.getElementById('saveSkillBtn').textContent = 'Update Skill';
  document.getElementById('skName').value = s.name || '';
  document.getElementById('skDesc').value = s.description || '';
  document.getElementById('skUrl').value = s.url || '';
  const meth = document.getElementById('skMethod');
  for (let i = 0; i < meth.options.length; i++) if (meth.options[i].value === s.method) { meth.selectedIndex = i; break; }
  const authType = s.auth?.type || '';
  document.getElementById('skAuthType').value = authType;
  document.getElementById('skAuthKey').value = s.auth?.keyFrom || s.auth?.token || '';
  document.getElementById('skAuthHeader').value = s.auth?.header || '';
  document.getElementById('skRequiresApproval').checked = !!s.requiresApproval;
  document.getElementById('skDefaults').value = s.defaultParams && Object.keys(s.defaultParams).length ? JSON.stringify(s.defaultParams, null, 2) : '';
  updateSkillAuthFields();
  const f = document.getElementById('addSkillForm');
  f.style.display = 'block';
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function toggleAddSkill() {
  cancelSkillForm();
  document.getElementById('importSkillForm').style.display = 'none';
  const f = document.getElementById('addSkillForm');
  f.style.display = f.style.display === 'none' ? 'block' : 'none';
}

export function toggleImportSkill() {
  cancelSkillForm();
  const f = document.getElementById('importSkillForm');
  f.style.display = f.style.display === 'none' ? 'block' : 'none';
  if (f.style.display !== 'none') setTimeout(() => document.getElementById('importSkillUrl').focus(), 50);
}

export async function importSkillFromUrl() {
  const urlInput = document.getElementById('importSkillUrl');
  const status   = document.getElementById('importSkillStatus');
  const btn      = document.getElementById('importSkillBtn');
  const skillUrl = urlInput.value.trim();
  if (!skillUrl) { status.style.color = 'var(--red)'; status.textContent = 'Paste a URL first.'; return; }
  btn.disabled = true; btn.textContent = 'Importing…';
  status.style.color = 'var(--text-3)'; status.textContent = 'Fetching & scanning…';
  try {
    const r = await fetch('/api/skills/import', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ url: skillUrl }) });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || 'Import failed');
    if (d.warnings && d.warnings.length) {
      status.style.color = 'var(--yellow)';
      const warnLabels = { cmd_skill: '⚠ executes shell commands', ssrf_risk: '⚠ targets private network', insecure_url: '⚠ non-HTTPS endpoint', no_approval: '⚠ no approval gate on write' };
      const msgs = d.warnings.map(w => warnLabels[w.split(':')[0]] || w);
      status.innerHTML = '✓ Imported <strong>"' + d.name + '"</strong> — ' + msgs.join(' · ');
    } else {
      status.style.color = 'var(--green)';
      status.textContent = '✓ Imported "' + d.name + '" — no security warnings';
    }
    urlInput.value = '';
    await loadSkills();
    if (!d.warnings || !d.warnings.length) {
      setTimeout(() => { document.getElementById('importSkillForm').style.display = 'none'; status.textContent = ''; }, 3000);
    }
  } catch(e) {
    status.style.color = 'var(--red)';
    status.textContent = 'Error: ' + e.message;
  } finally { btn.disabled = false; btn.textContent = 'Import'; }
}

export function cancelSkillForm() {
  document.getElementById('skEditName').value = '';
  document.getElementById('addSkillFormTitle').textContent = 'New Skill';
  document.getElementById('saveSkillBtn').textContent = 'Save Skill';
  document.getElementById('addSkillForm').style.display = 'none';
  ['skName','skDesc','skUrl','skAuthKey','skAuthHeader','skDefaults'].forEach(id => {
    const el = document.getElementById(id); if(el) el.value = '';
  });
  document.getElementById('skAuthType').value = '';
  document.getElementById('skRequiresApproval').checked = false;
  updateSkillAuthFields();
}

export function updateSkillAuthFields() {
  const t = document.getElementById('skAuthType').value;
  document.getElementById('skAuthHeaderWrap').style.display = t === 'header' ? 'block' : 'none';
}

export async function saveSkill() {
  const name = document.getElementById('skName').value.trim();
  const url  = document.getElementById('skUrl').value.trim();
  if (!name || !url) { alert('Skill name and URL are required'); return; }
  let defaultParams = {};
  try { const v = document.getElementById('skDefaults').value.trim(); if(v) defaultParams = JSON.parse(v); }
  catch { alert('Default Params must be valid JSON'); return; }
  const authType = document.getElementById('skAuthType').value;
  const authKeyRaw = document.getElementById('skAuthKey').value.trim();
  let auth = {};
  if (authType && authKeyRaw) {
    auth = { type: authType };
    if (authKeyRaw.startsWith('providers.') || authKeyRaw.startsWith('env.')) auth.keyFrom = authKeyRaw;
    else auth.token = authKeyRaw;
    if (authType === 'header') auth.header = document.getElementById('skAuthHeader').value.trim() || 'X-API-Key';
  }
  const editingName = document.getElementById('skEditName').value.trim();
  const body = { name, url, method: document.getElementById('skMethod').value, description: document.getElementById('skDesc').value.trim(), auth: Object.keys(auth).length ? auth : undefined, defaultParams, requiresApproval: document.getElementById('skRequiresApproval').checked };
  try {
    if (editingName && editingName !== name) await fetch('/api/skills/' + editingName, { method: 'DELETE' });
    const r = await fetch('/api/skills', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(await r.text());
    cancelSkillForm();
    loadSkills();
    showNotification(editingName ? 'Skill updated' : 'Skill saved');
  } catch(e) { showNotification('Failed: ' + e.message, 'error'); }
}

export async function deleteSkill(name) {
  if (!confirm('Delete skill "' + name + '"?')) return;
  try {
    const r = await fetch('/api/skills/' + name, { method: 'DELETE' });
    if(!r.ok) throw new Error(await r.text());
    loadSkills();
    showNotification('Deleted');
  } catch(e) { showNotification('Delete failed: ' + e.message, 'error'); }
}
