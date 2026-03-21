/**
 * Swarm (sessions), RT Messages, and DLQ tab — extracted from app.js
 * Deps: getJSON, postJSON (core/api), escHtml, showNotification, fmt, createdAt (core/dom)
 * Inject: initSwarmTab({ hideAllViews, setNavActive })
 */

import { getJSON, postJSON } from '../core/api.js';
import { escHtml, showNotification, fmt, createdAt } from '../core/dom.js';
import { state, persistState, restoreScrollPosition } from '../core/state.js';

let _hideAllViews = () => {};
let _setNavActive = () => {};

export function initSwarmTab({ hideAllViews, setNavActive } = {}) {
  _hideAllViews = hideAllViews || _hideAllViews;
  _setNavActive = setNavActive || _setNavActive;
}

// ── Swarm (Sessions) ───────────────────────────────────────────────────────────

let _selected = state.selected || null;
let _selectedEngine = state.selectedEngine || 'opencode'; // opencode, claude, codex, gemini, crew-cli

export async function loadSessions() {
  const box = document.getElementById('sessions');
  if (box) box.innerHTML = '<div style="padding:20px;">Loading…</div>';
  
  // Add engine selector dropdown if not already present
  const container = box.parentElement;
  let engineSelector = document.getElementById('engine-selector');
  if (!engineSelector) {
    engineSelector = document.createElement('div');
    engineSelector.id = 'engine-selector';
    engineSelector.style.cssText = 'padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;';
    engineSelector.innerHTML = '<label style="font-size:13px;font-weight:500;color:var(--text-2);">CLI:</label>'
      + '<select id="engine-select" style="padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg-1);color:var(--text-1);font-size:13px;cursor:pointer;">'
      + '<option value="opencode">OpenCode</option>'
      + '<option value="claude">Claude Code</option>'
      + '<option value="codex">Codex CLI</option>'
      + '<option value="gemini">Gemini CLI</option>'
      + '<option value="crew-cli">crew-cli</option>'
      + '</select>'
      + '<span style="font-size:12px;color:var(--text-3);margin-left:8px;" id="session-count"></span>';
    container.insertBefore(engineSelector, box);
    
    document.getElementById('engine-select').addEventListener('change', (e) => {
      _selectedEngine = e.target.value;
      state.selectedEngine = _selectedEngine;
      persistState();
      _selected = null; // Reset selection when switching engines
      loadSessions();
    });
  }
  
  // Set dropdown to current engine
  const select = document.getElementById('engine-select');
  if (select) select.value = _selectedEngine;
  
  try {
    const activeProjectId = state.chatActiveProjectId || 'general';
    const endpoint =
      '/api/engine-sessions?engine=' + encodeURIComponent(_selectedEngine) +
      '&projectId=' + encodeURIComponent(activeProjectId);
    const result = await getJSON(endpoint);
    const data = result.sessions || result || [];
    
    const box2 = document.getElementById('sessions');
    const countEl = document.getElementById('session-count');
    
    box2.innerHTML = '';
    
    if (!data.length) {
      const engineNames = {
        'opencode': 'OpenCode',
        'claude': 'Claude Code',
        'codex': 'Codex CLI',
        'gemini': 'Gemini CLI',
        'crew-cli': 'crew-cli'
      };
      const engineName = engineNames[_selectedEngine] || _selectedEngine;
      
      box2.innerHTML = '<div style="padding:20px 16px;">'
        + `<div style="font-size:13px;font-weight:600;margin-bottom:6px;">No ${engineName} sessions</div>`
        + '<div style="font-size:12px;color:var(--text-3);line-height:1.6;">'
        + `No session history found for <strong>${engineName}</strong>. `
        + 'Run a task using this engine to see sessions here.'
        + '</div></div>';
      if (countEl) countEl.textContent = '';
      return;
    }
    
    if (countEl) countEl.textContent = `${data.length} session${data.length !== 1 ? 's' : ''}`;
    if (!_selected && data[0]) _selected = data[0].id;

    function crewAgentFromTitle(title) {
      if (!title || typeof title !== 'string') return null;
      const m = title.match(/\[?(crew-\w+)\]?/);
      return m ? m[1] : null;
    }
    function inferAgentFromTitle(title) {
      if (!title || typeof title !== 'string') return null;
      if (/\bFixer\b|fixer\s+task|fix\s+.*\.py|syntax\s+error/i.test(title)) return 'fixer';
      if (/\bQA\b|qa\s+audit|audit:/i.test(title)) return 'qa';
      if (/\bPM\b|crew-pm|roadmap\b/i.test(title)) return 'pm';
      if (/\bCoder\b|coder\s+task|frontend\b|backend\b/i.test(title)) return 'coder';
      if (/\bSecurity\b|security\s+review/i.test(title)) return 'security';
      if (/\bCopywriter\b|copy\s+task/i.test(title)) return 'copywriter';
      return null;
    }
    function isOpencodeCodename(slug) {
      return slug && /^[a-z]+-[a-z]+$/.test(slug) && !slug.startsWith('crew-');
    }

    data.forEach(s => {
      const div = document.createElement('div');
      const sessionId = s.id || s.sessionId || '';
      div.className = 'row' + (sessionId === _selected ? ' active' : '');
      div.onclick = () => { _selected = sessionId; state.selected = sessionId; persistState(); loadSessions(); loadMessages(); };
      
      // Extract metadata based on engine
      let title = s.title || s.slug || sessionId;
      let meta = s.directory || '';
      let badge = '';
      
      if (_selectedEngine === 'opencode') {
        const crewAgent = crewAgentFromTitle(title);
        const inferred  = inferAgentFromTitle(title);
        const slug      = s.slug || '';
        const agent     = crewAgent || (slug && !isOpencodeCodename(slug) ? slug : null) || inferred;
        const slugLabel = isOpencodeCodename(slug) ? ' (' + slug + ')' : '';
        badge = agent ? ('Assigned to: ' + agent + slugLabel) : (slug ? ('Assigned to: ' + slug + ' (OpenCode session)') : '');
      } else if (_selectedEngine === 'claude') {
        meta = s.file ? s.file.split('/').pop().replace('.jsonl', '') : '';
      } else if (_selectedEngine === 'codex') {
        meta = s.file || '';
      } else if (_selectedEngine === 'gemini') {
        meta = 'Project: ' + sessionId;
      } else if (_selectedEngine === 'crew-cli') {
        badge = s.engine + ' / ' + s.project;
        meta = s.file || '';
      }
      
      // Limit title length
      if (title.length > 80) title = title.slice(0, 77) + '...';
      
      div.innerHTML = '<div><strong>' + escHtml(title) + '</strong></div>'
        + (meta ? '<div class="meta">' + escHtml(meta) + '</div>' : '')
        + (badge ? '<div class="meta" style="font-size:11px;color:var(--accent);">' + escHtml(badge) + '</div>' : '');
      box2.appendChild(div);
    });
  } catch(e) {
    const box = document.getElementById('sessions');
    if (box) box.innerHTML = '<div class="meta" style="padding:20px; color:var(--red-hi);">Error loading sessions.</div>';
  }
}

export async function loadMessages() {
  const box = document.getElementById('messages');
  if (!_selected) { if (box) box.innerHTML = '<div class="meta">No session selected.</div>'; return; }
  try {
    // For OpenCode, use the old endpoint. For others, messages are embedded in the session data
    if (_selectedEngine === 'opencode') {
      const data = await getJSON('/api/messages?session=' + encodeURIComponent(_selected));
      box.innerHTML = '';
      data.slice(-40).forEach(m => {
        const text = (m.parts || []).filter(p => p.type === 'text').map(p => p.text).join('').trim();
        if (!text) return;
        const div = document.createElement('div');
        div.className = 'msg ' + ((m.info && m.info.role) === 'assistant' ? 'a' : 'u');
        div.innerHTML = '<div class="meta">' + (m.info && m.info.role) + ' • ' + fmt(createdAt(m.info)) + '</div><div class="t"></div>';
        div.querySelector('.t').textContent = text;
        box.appendChild(div);
      });
    } else {
      // For other engines, find the session in the cached data
      const apiMap = {
        'claude': '/api/claude-sessions',
        'codex': '/api/codex-sessions',
        'gemini': '/api/gemini-sessions',
        'crew-cli': '/api/crew-cli-sessions'
      };
      const endpoint = apiMap[_selectedEngine];
      if (!endpoint) {
        box.innerHTML = '<div class="meta">Engine not supported</div>';
        return;
      }
      
      const result = await getJSON(endpoint);
      const sessions = result.sessions || result || [];
      const session = sessions.find(s => s.id === _selected || s.sessionId === _selected);
      
      if (!session || !session.messages) {
        box.innerHTML = '<div class="meta">No messages found</div>';
        return;
      }
      
      box.innerHTML = '';
      session.messages.slice(-40).forEach(m => {
        const div = document.createElement('div');
        div.className = 'msg ' + (m.role === 'assistant' ? 'a' : 'u');
        const ts = m.ts ? new Date(m.ts).toLocaleString() : '';
        div.innerHTML = '<div class="meta">' + m.role + (ts ? ' • ' + ts : '') + '</div><div class="t"></div>';
        div.querySelector('.t').textContent = m.text || '';
        box.appendChild(div);
      });
    }
    box.scrollTop = box.scrollHeight;
  } catch(e) { if (box) box.innerHTML = '<div class="meta">Error: ' + e.message + '</div>'; }
}

export function showSwarm() {
  _hideAllViews();
  document.getElementById('sessionsView').classList.add('active');
  _setNavActive('navSwarm');
  state.activeTab = 'swarm';
  persistState();

  // Check if sessions are already rendered (DOM preserved from previous visit)
  const sessionsBox = document.getElementById('sessions');
  const alreadyLoaded = sessionsBox && sessionsBox.children.length > 1;
  if (!alreadyLoaded) {
    loadSessions(); loadMessages();
  } else {
    restoreScrollPosition('swarm');
  }
}

// ── RT Messages ────────────────────────────────────────────────────────────────

let _rtPaused  = false;
let _rtFilter  = 'tasks';
let _rtSearch  = '';
let _rtSeenIds = new Set();
const RT_SKIP       = new Set(['agent.heartbeat','agent.online','agent.offline']);
const RT_TASK_TYPES = new Set(['task.dispatched','task.done','task.completed','task.failed','task.cancelled','task.started','task.reply']);

function _rtMatchesFilter(m) {
  if (RT_SKIP.has(m.type)) return false;
  const payload = m.payload || {};
  const text = payload.reply || payload.prompt || payload.message || payload.content || '';
  if (!text || text === 'run_task') return false;
  if (_rtFilter === 'tasks' && !RT_TASK_TYPES.has(m.type)) return false;
  if (_rtFilter === 'replies') {
    if (!(payload.reply || payload.message || payload.content)) return false;
  }
  if (_rtSearch) {
    const q = _rtSearch.toLowerCase();
    if (!(m.from||'').toLowerCase().includes(q) &&
        !(m.to  ||'').toLowerCase().includes(q) &&
        !text.toLowerCase().includes(q) &&
        !(m.type||'').toLowerCase().includes(q)) return false;
  }
  return true;
}

const RT_PHASE_STYLE = {
  'task.dispatched': { color: 'var(--purple)',   label: 'dispatched' },
  'task.started':    { color: 'var(--amber)',    label: 'started'    },
  'task.done':       { color: 'var(--green-hi)', label: 'done'       },
  'task.completed':  { color: 'var(--green-hi)', label: 'completed'  },
  'task.reply':      { color: 'var(--accent)',   label: 'reply'      },
  'task.failed':     { color: 'var(--red-hi)',   label: 'failed'     },
  'task.cancelled':  { color: 'var(--text-3)',   label: 'cancelled'  },
};

function _rtBuildElement(m) {
  const payload  = m.payload || {};
  const fullText = payload.reply || payload.prompt || payload.message || payload.content || '';
  const type     = m.type || '';
  const phase    = RT_PHASE_STYLE[type];
  const timeStr  = m.ts ? new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const firstLine = fullText.split('\n').map(l => l.trim()).find(l => l.length > 2) || fullText;
  const summary   = firstLine.length > 90 ? firstLine.slice(0, 90) + '…' : firstLine;
  const hasMore   = fullText.length > summary.length || fullText.split('\n').length > 1;

  const row = document.createElement('div');
  row.style.cssText = 'display:grid;grid-template-columns:auto auto 1fr auto;align-items:center;gap:10px;padding:7px 10px;border-radius:6px;cursor:' + (hasMore ? 'pointer' : 'default') + ';transition:background .12s;border-bottom:1px solid var(--border);';
  row.onmouseenter = () => { row.style.background = 'var(--bg-2)'; };
  row.onmouseleave = () => { row.style.background = ''; };

  const agentsEl = document.createElement('div');
  agentsEl.style.cssText = 'display:flex;align-items:center;gap:5px;white-space:nowrap;min-width:0;';
  const fromPill = document.createElement('span');
  fromPill.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-1);max-width:110px;overflow:hidden;text-overflow:ellipsis;';
  fromPill.textContent = (m.from || '?').replace('crew-', '');
  fromPill.title = m.from || '';
  agentsEl.appendChild(fromPill);
  if (m.to && m.to !== m.from) {
    const arrow = document.createElement('span');
    arrow.style.cssText = 'font-size:10px;color:var(--text-3);flex-shrink:0;';
    arrow.textContent = '→';
    const toPill = document.createElement('span');
    toPill.style.cssText = 'font-size:11px;color:var(--text-2);max-width:110px;overflow:hidden;text-overflow:ellipsis;';
    toPill.textContent = (m.to || '').replace('crew-', '');
    toPill.title = m.to || '';
    agentsEl.appendChild(arrow);
    agentsEl.appendChild(toPill);
  }

  const badgeContainer = document.createElement('div');
  badgeContainer.style.cssText = 'display:flex;align-items:center;gap:4px;flex-shrink:0;';
  
  const badge = document.createElement('span');
  const ps = phase || { color: 'var(--text-3)', label: type.split('.').pop() || type };
  badge.style.cssText = 'font-size:10px;font-weight:600;padding:2px 7px;border-radius:20px;white-space:nowrap;flex-shrink:0;color:#fff;background:' + ps.color + ';letter-spacing:.03em;';
  badge.textContent = ps.label;
  badgeContainer.appendChild(badge);

  // Engine badge for task.done messages
  if (type === 'task.done' && payload.engineUsed) {
    const engineColors = {
      'claude': '#e07a5f',      // warm coral for Claude Code
      'codex': '#8338ec',       // purple for Codex
      'cursor': '#3d405b',      // dark gray for Cursor
      'opencode': '#06d6a0',    // teal for OpenCode
      'gemini': '#4285f4',      // Google blue for Gemini
      'docker-sandbox': '#0db7ed' // Docker blue
    };
    const engineLabels = {
      'claude': '🤖',
      'codex': '🟣',
      'cursor': '🖱',
      'opencode': '⚡',
      'gemini': '✨',
      'docker-sandbox': '🐳'
    };
    const engine = payload.engineUsed;
    const engineBadge = document.createElement('span');
    engineBadge.style.cssText = 'font-size:10px;font-weight:600;padding:2px 6px;border-radius:20px;white-space:nowrap;flex-shrink:0;color:#fff;background:' + (engineColors[engine] || 'var(--text-3)') + ';';
    engineBadge.textContent = (engineLabels[engine] || '') + ' ' + engine;
    engineBadge.title = 'Executed by ' + engine;
    badgeContainer.appendChild(engineBadge);
  }

  const preview = document.createElement('span');
  preview.style.cssText = 'font-size:12px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;';
  preview.textContent = summary;

  const right = document.createElement('div');
  right.style.cssText = 'display:flex;align-items:center;gap:6px;flex-shrink:0;';
  const timeEl = document.createElement('span');
  timeEl.style.cssText = 'font-size:10px;color:var(--text-3);white-space:nowrap;';
  timeEl.textContent = timeStr;
  right.appendChild(timeEl);
  if (hasMore) {
    const hint = document.createElement('span');
    hint.style.cssText = 'font-size:10px;color:var(--text-3);';
    hint.textContent = '▸';
    right.appendChild(hint);
  }

  row.appendChild(agentsEl);
  row.appendChild(badgeContainer);
  row.appendChild(preview);
  row.appendChild(right);

  if (hasMore) {
    const detail = document.createElement('div');
    detail.style.cssText = 'display:none;grid-column:1/-1;padding:8px 6px 4px;font-size:12px;color:var(--text-2);white-space:pre-wrap;word-break:break-word;max-height:300px;overflow-y:auto;border-top:1px solid var(--border);margin-top:4px;font-family:monospace;';
    detail.textContent = fullText;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:grid;grid-template-columns:1fr;border-radius:6px;overflow:hidden;border-bottom:1px solid var(--border);';
    row.style.borderBottom = 'none';
    let open = false;
    row.onclick = () => {
      open = !open;
      detail.style.display = open ? 'block' : 'none';
      const hint = right.querySelector('span:last-child');
      if (hint) hint.textContent = open ? '▾' : '▸';
    };
    wrap.appendChild(row);
    wrap.appendChild(detail);
    return wrap;
  }
  return row;
}

export async function loadRTMessages() {
  if (_rtPaused) return;
  const box    = document.getElementById('rtMessages');
  const rtView = document.getElementById('rtView');
  if (!box || !rtView) return;
  
  // Check if this is first load - only if box has no child elements at all
  const firstLoad = box.children.length === 0;
  if (firstLoad) {
    const loadingDiv = document.createElement('div');
    loadingDiv.style.cssText = 'padding:20px;';
    loadingDiv.textContent = 'Loading…';
    box.replaceChildren(loadingDiv);
  }

  const data     = await getJSON('/api/rt-messages');
  const filtered = data.filter(_rtMatchesFilter);
  
  // PERFORMANCE FIX: Limit to last 100 messages to prevent DOM bloat
  const limited = filtered.slice(-100);

  // Use stable hash based on message content, not timestamp
  const newHash = limited.map(m => {
    const payload = m.payload || {};
    const text = payload.reply || payload.prompt || payload.message || payload.content || '';
    return `${m.type}|${m.from}|${m.to}|${text.slice(0, 100)}`;
  }).join('::');

  if (newHash === window._rtLastHash && !firstLoad) {
    return; // No changes, skip redraw
  }
  window._rtLastHash = newHash;

  const rtAtBottom = () => rtView.scrollHeight - rtView.scrollTop - rtView.clientHeight < 100;
  const wasAtBottom = rtAtBottom();
  const scrollPos = rtView.scrollTop; // Save scroll position
  
  // CRITICAL FIX: Use DocumentFragment + replaceChildren to avoid flash
  const fragment = document.createDocumentFragment();

  if (!limited.length) {
    const emptyDiv = document.createElement('div');
    emptyDiv.style.cssText = 'padding:24px;text-align:center;font-size:12px;color:var(--text-3);';
    emptyDiv.textContent = 'No events match the current filter.';
    fragment.appendChild(emptyDiv);
  } else {
    const header = document.createElement('div');
    header.style.cssText = 'display:grid;grid-template-columns:auto auto 1fr auto;gap:10px;padding:4px 10px 6px;font-size:10px;font-weight:600;color:var(--text-3);letter-spacing:.06em;text-transform:uppercase;border-bottom:2px solid var(--border);margin-bottom:2px;';
    ['Agent', 'Phase', 'Summary', 'Time'].forEach(label => {
      const th = document.createElement('span'); th.textContent = label; header.appendChild(th);
    });
    fragment.appendChild(header);
    limited.forEach(m => fragment.appendChild(_rtBuildElement(m)));
  }
  
  // CRITICAL: Use replaceChildren instead of innerHTML = '' to prevent flash
  box.replaceChildren(fragment);

  // Restore scroll position: if user was at bottom, stay at bottom; otherwise preserve their scroll position
  if (wasAtBottom) {
    rtView.scrollTop = rtView.scrollHeight;
  } else {
    // If saved position is now beyond the new content height, scroll to the bottom of new content minus viewport
    const maxScroll = Math.max(0, rtView.scrollHeight - rtView.clientHeight);
    rtView.scrollTop = Math.min(scrollPos, maxScroll);
  }
  const scrollBtn = document.getElementById('rtScrollBtn');
  if (scrollBtn) scrollBtn.style.display = rtAtBottom() ? 'none' : 'block';

  if (!rtView._scrollListenerBound) {
    rtView._scrollListenerBound = true;
    rtView.addEventListener('scroll', () => {
      if (scrollBtn) scrollBtn.style.display = rtAtBottom() ? 'none' : 'block';
    });
  }
}

export function toggleRTPause() {
  _rtPaused = !_rtPaused;
  const btn = document.getElementById('rtPauseBtn');
  if (btn) { btn.textContent = _rtPaused ? '▶ Resume' : '⏸ Pause'; btn.style.background = _rtPaused ? 'var(--accent)' : ''; btn.style.color = _rtPaused ? '#fff' : ''; }
}

export function clearRTMessages() {
  _rtSeenIds = new Set();
  const box = document.getElementById('rtMessages');
  if (box) box.innerHTML = '<div class="meta" style="padding:20px;text-align:center;opacity:.6;">Cleared. New messages will appear on next poll.</div>';
}

function _initRTFilters() {
  document.querySelectorAll('.rt-filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      _rtFilter = btn.dataset.filter;
      _rtSeenIds = new Set();
      document.querySelectorAll('.rt-filter-chip').forEach(b => {
        const active = b === btn;
        b.style.background = active ? 'var(--accent)' : 'transparent';
        b.style.color = active ? '#fff' : 'var(--text-2)';
        b.classList.toggle('active', active);
      });
      loadRTMessages();
    });
  });
  const search = document.getElementById('rtSearch');
  if (search) {
    search.addEventListener('input', () => {
      _rtSearch = search.value.trim();
      _rtSeenIds = new Set();
      loadRTMessages();
    });
  }
}

export function showRT() {
  _hideAllViews();
  document.getElementById('rtView').classList.add('active');
  _setNavActive('navRT');
  _initRTFilters();
  loadRTMessages();
  const scrollBtn = document.getElementById('rtScrollBtn');
  if (scrollBtn) scrollBtn.style.display = 'none';
}

// ── DLQ ───────────────────────────────────────────────────────────────────────

export async function loadDLQ() {
  const box = document.getElementById('dlqMessages');
  if (box) box.innerHTML = '<div style="padding:20px;">Loading…</div>';
  const data = await getJSON('/api/dlq');
  const dlqBadgeEl = document.getElementById('dlqBadge');
  if (dlqBadgeEl) { dlqBadgeEl.textContent = data.length; dlqBadgeEl.classList.toggle('hidden', !data.length); }
  if (!box) return;
  box.innerHTML = data.length ? data.map(entry => {
    const key = entry.key || (entry.filename || '').replace('.json', '') || '?';
    const keyAttr = escHtml(key);
    return '<div class="msg dlq-item"><div class="meta"><strong>⚠️ Failed</strong> | ' + (entry.agent || '?') + ' | ' + (entry.failedAt ? new Date(entry.failedAt).toLocaleString() : '') + ' <button class="replay-btn" data-action="replayDLQ" data-arg="' + keyAttr + '">Replay</button> <button data-action="deleteDLQ" data-arg="' + keyAttr + '" style="font-size:11px;padding:3px 8px;border-radius:4px;border:1px solid var(--red-hi);background:transparent;color:var(--red-hi);cursor:pointer;">Delete</button></div><div class="t">' + (entry.error || '') + '</div></div>';
  }).join('') : '<div class="meta" style="padding:20px; text-align:center;">✓ DLQ empty</div>';
}

export async function replayDLQ(key) {
  if (!confirm('Replay?')) return;
  await postJSON('/api/dlq/replay', { key });
  showNotification('Replayed');
  loadDLQ();
}

export async function deleteDLQ(key) {
  if (!confirm('Delete this DLQ entry?')) return;
  try {
    await fetch('/api/dlq/' + encodeURIComponent(key), { method: 'DELETE' });
    showNotification('DLQ entry deleted');
    loadDLQ();
  } catch(e) { showNotification('Failed: ' + e.message, true); }
}

export function showDLQ() {
  _hideAllViews();
  document.getElementById('dlqView').classList.add('active');
  _setNavActive('navDLQ');
  loadDLQ();
}
