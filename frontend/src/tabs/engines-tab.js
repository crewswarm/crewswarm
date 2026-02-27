/**
 * Engines tab — extracted from app.js
 * Deps: getJSON, postJSON, escHtml (from core/)
 */

import { getJSON, postJSON } from '../core/api.js';
import { escHtml } from '../core/dom.js';

export const ENGINE_ICONS = {
  opencode:       `<svg viewBox="0 0 24 30" width="20" height="24" fill="#38bdf8"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>`,
  cursor:         `<svg viewBox="0 0 24 24" width="20" height="20" fill="#818cf8"><path d="M4 4l8 16 3-7 7-3L4 4z"/></svg>`,
  claude:         `<svg viewBox="0 0 24 24" width="20" height="20" fill="#d4a853"><path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"/></svg>`,
  codex:          `<svg viewBox="0 0 24 24" width="20" height="20" fill="none"><circle cx="12" cy="12" r="10" stroke="#a78bfa" stroke-width="1.5"/><path d="M8 12l3 3 5-5" stroke="#a78bfa" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  "docker-sandbox": `<svg viewBox="0 0 24 24" width="20" height="20" fill="#2496ed"><path d="M13.983 11.078h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 00.186-.186V3.574a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m0 2.716h2.118a.187.187 0 00.186-.186V6.29a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.887c0 .102.082.186.185.186m-2.93 0h2.12a.186.186 0 00.184-.186V6.29a.185.185 0 00-.185-.185H8.1a.185.185 0 00-.185.185v1.887c0 .102.083.186.185.186m-2.943 0h2.119a.186.186 0 00.185-.186V6.29a.185.185 0 00-.185-.185H5.157a.185.185 0 00-.185.185v1.887c0 .102.083.186.185.186m8.763 2.714h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.185m-2.93 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 00-.75.748 11.376 11.376 0 00.692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137.983.003 1.963-.086 2.93-.266a12.248 12.248 0 003.823-1.389c.98-.567 1.86-1.288 2.61-2.136 1.252-1.418 1.998-2.997 2.553-4.4h.221c1.372 0 2.215-.549 2.68-1.009.309-.293.55-.65.707-1.046l.098-.288Z"/></svg>`,
};

export function showEngines(helpers) {
  helpers.hideAllViews();
  document.getElementById('enginesView').classList.add('active');
  helpers.setNavActive('navEngines');
  loadEngines();
}

export function toggleImportEngine() {
  const f = document.getElementById('importEngineForm');
  if (f) f.style.display = f.style.display === 'none' ? 'block' : 'none';
}

export async function importEngineFromUrl() {
  const inp = document.getElementById('importEngineUrl');
  const status = document.getElementById('importEngineStatus');
  const url = inp?.value?.trim();
  if (!url || !status) return;
  status.textContent = 'Importing…'; status.style.color = 'var(--text-3)';
  try {
    const d = await postJSON('/api/engines/import', { url });
    if (d.ok) {
      status.textContent = `✓ Imported ${d.label}`; status.style.color = 'var(--green)';
      inp.value = '';
      loadEngines();
    } else {
      status.textContent = 'Error: ' + (d.error || 'unknown'); status.style.color = 'var(--red,#f87171)';
    }
  } catch(e) {
    status.textContent = 'Error: ' + e.message; status.style.color = 'var(--red,#f87171)';
  }
}

export async function deleteEngine(id) {
  if (!confirm(`Remove engine "${id}"?`)) return;
  await fetch(`/api/engines/${encodeURIComponent(id)}`, { method: 'DELETE' });
  loadEngines();
}

export async function loadEngines() {
  const grid = document.getElementById('enginesGrid');
  if (!grid) return;
  grid.innerHTML = '<div style="color:var(--text-3);font-size:13px;padding:8px;">Loading…</div>';
  try {
    const { engines = [] } = await getJSON('/api/engines');
    if (!engines.length) {
      grid.innerHTML = '<div style="color:var(--text-3);font-size:13px;padding:8px;">No engines found.</div>';
      return;
    }
    grid.innerHTML = '';
    for (const eng of engines) {
      const card = document.createElement('div');
      card.className = 'card';
      card.style.cssText = 'display:flex;flex-direction:column;gap:10px;';
      const iconHtml = ENGINE_ICONS[eng.icon || eng.id] || `<span style="font-size:20px;">⚙️</span>`;
      const needsAuth = eng.requiresAuth && eng.installed;
      const statusDot = eng.ready && !needsAuth ? '🟢' : eng.installed ? '🟡' : '⚫';
      const statusLabel = eng.ready && !needsAuth ? 'Ready'
        : eng.installed && eng.requiresAuth ? 'Installed — run auth to activate'
        : eng.installed ? 'Installed — missing env vars'
        : 'Not installed';
      const statusColor = eng.ready && !needsAuth ? 'var(--green)' : eng.installed ? 'var(--yellow,#fbbf24)' : 'var(--text-3)';
      const traitsHtml = (eng.traits || []).map(t =>
        `<li style="font-size:11px;color:var(--text-3);list-style:none;padding:2px 0;">▸ ${escHtml(t)}</li>`
      ).join('');
      const missingHtml = eng.missingEnv?.length
        ? `<div style="font-size:11px;color:var(--yellow,#fbbf24);margin-top:4px;">Missing env: ${eng.missingEnv.map(e => `<code style="background:var(--bg-1);padding:1px 3px;border-radius:3px;">${escHtml(e)}</code>`).join(', ')}</div>`
        : '';
      const installHtml = !eng.installed
        ? `<div style="margin-top:6px;"><div style="font-size:11px;color:var(--text-3);margin-bottom:4px;">Install:</div>
           <code style="font-size:11px;background:var(--bg-1);padding:4px 8px;border-radius:4px;display:block;word-break:break-all;">${escHtml(eng.installCmd || '')}</code>
           ${eng.installUrl ? `<a href="${escHtml(eng.installUrl)}" target="_blank" style="font-size:11px;color:var(--accent);margin-top:4px;display:inline-block;">↗ Install guide</a>` : ''}
          </div>` : '';
      const authHtml = eng.authMethods?.length
        ? `<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:10px;">
            <div style="font-size:11px;font-weight:600;color:var(--text-2);margin-bottom:8px;display:flex;align-items:center;gap:6px;">
              <span style="font-size:13px;">🔑</span> Auth setup
              ${eng.authNote ? `<span style="font-weight:400;color:var(--text-3);">— ${escHtml(eng.authNote)}</span>` : ''}
            </div>
            ${eng.authMethods.map((m, i) => `
              <div style="margin-bottom:10px;">
                <div style="font-size:11px;font-weight:600;color:var(--text-2);margin-bottom:4px;">${escHtml(m.label)}</div>
                <div style="position:relative;display:flex;align-items:stretch;gap:0;">
                  <code style="flex:1;font-size:11px;background:var(--bg-1);padding:6px 8px;border-radius:4px 0 0 4px;display:block;word-break:break-all;border:1px solid var(--border);border-right:none;">${escHtml(m.cmd)}</code>
                  <button onclick="navigator.clipboard.writeText(${JSON.stringify(m.cmd)}).then(()=>{this.textContent='✓';setTimeout(()=>this.textContent='Copy',1200)})" style="font-size:10px;padding:0 8px;border-radius:0 4px 4px 0;border:1px solid var(--border);background:var(--bg-card2);color:var(--text-2);cursor:pointer;white-space:nowrap;flex-shrink:0;">Copy</button>
                </div>
                ${m.note ? `<div style="font-size:10px;color:var(--text-3);margin-top:3px;">${escHtml(m.note)}</div>` : ''}
              </div>
            `).join('')}
          </div>`
        : (eng.authNote ? `<div style="font-size:11px;color:var(--text-3);margin-top:6px;">🔑 ${escHtml(eng.authNote)}</div>` : '');
      const bestForHtml = eng.bestFor?.length
        ? `<div style="font-size:11px;color:var(--text-3);">Best for: ${eng.bestFor.map(a => `<code style="background:var(--bg-1);padding:1px 3px;border-radius:3px;">${escHtml(a)}</code>`).join(' ')}</div>`
        : '';
      const deleteBtn = eng.source === 'user'
        ? `<button onclick="deleteEngine('${escHtml(eng.id)}')" style="font-size:11px;padding:4px 8px;border-radius:5px;cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--text-3);">Remove</button>`
        : '';
      card.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
          <div style="display:flex;align-items:center;gap:10px;">
            ${iconHtml}
            <div>
              <div style="font-weight:700;font-size:14px;">${escHtml(eng.label)}</div>
              <div style="font-size:11px;color:${statusColor};">${statusDot} ${escHtml(statusLabel)}</div>
            </div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;">
            ${eng.docsUrl ? `<a href="${escHtml(eng.docsUrl)}" target="_blank" class="btn-ghost" style="font-size:11px;padding:4px 8px;text-decoration:none;">Docs ↗</a>` : ''}
            ${deleteBtn}
          </div>
        </div>
        <div style="font-size:12px;color:var(--text-2);line-height:1.5;">${escHtml(eng.description || '')}</div>
        ${missingHtml}
        ${installHtml}
        <ul style="margin:0;padding:0;">${traitsHtml}</ul>
        ${bestForHtml}
        ${authHtml}
      `;
      grid.appendChild(card);
    }
  } catch(e) {
    grid.innerHTML = `<div style="color:var(--red,#f87171);font-size:13px;">Error: ${escHtml(e.message)}</div>`;
  }
}
