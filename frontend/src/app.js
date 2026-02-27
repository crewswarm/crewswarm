import { getJSON, postJSON } from './core/api.js';
import { escHtml, showNotification, fmt, createdAt, appendChatBubble } from './core/dom.js';
import { AGENT_RANK, sortAgents } from './core/state.js';
import { loadBenchmarkOptions, loadBenchmarks, loadBenchmarkLeaderboard } from './tabs/benchmarks-tab.js';

let selected = null;
let agents = [];
async function loadAgents() {
  try {
    agents = sortAgents(await getJSON('/api/agents'));
  } catch (e) { console.error('Failed to load agents:', e); }
}
async function loadSessions(){
  const box = document.getElementById('sessions');
  if (box) box.innerHTML = '<div style="padding:20px;">Loading…</div>';
  try {
    const data = await getJSON('/api/sessions');
    const box = document.getElementById('sessions');
    box.innerHTML = '';
    if (!data.length) {
      box.innerHTML = '<div style="padding:20px 16px;">'
        + '<div style="font-size:13px;font-weight:600;margin-bottom:6px;">No OpenCode sessions</div>'
        + '<div style="font-size:12px;color:var(--text-3);line-height:1.6;">'
        + 'This tab shows sessions from the <strong>OpenCode</strong> execution engine (port 4096). '
        + 'Start it from <strong>Services → Code Engine</strong>, then run a task to see sessions here.<br><br>'
        + '<strong>Claude Code</strong> and <strong>Cursor CLI</strong> don\'t expose a session REST API, '
        + 'so their runs aren\'t listed here — use the Chat tab\'s activity feed or the RT Messages tab to follow those tasks.'
        + '</div></div>';
      return;
    }
    if (!selected && data[0]) selected = data[0].id;
    // Crew agent from title: "[crew-fixer] ..." or "crew-fixer" (we prefix prompts with [agentId])
    function crewAgentFromTitle(title) {
      if (!title || typeof title !== 'string') return null;
      const m = title.match(/\[?(crew-\w+)\]?/);
      return m ? m[1] : null;
    }
    // Infer role from task keywords when slug is OpenCode codename (sunny-comet, calm-tiger)
    function inferAgentFromTitle(title) {
      if (!title || typeof title !== 'string') return null;
      const t = title;
      if (/\bFixer\b|fixer\s+task|fix\s+.*\.py|syntax\s+error/i.test(t)) return 'fixer';
      if (/\bQA\b|qa\s+audit|audit:/i.test(t)) return 'qa';
      if (/\bPM\b|crew-pm|roadmap\b/i.test(t)) return 'pm';
      if (/\bCoder\b|coder\s+task|frontend\b|backend\b/i.test(t)) return 'coder';
      if (/\bSecurity\b|security\s+review/i.test(t)) return 'security';
      if (/\bCopywriter\b|copy\s+task/i.test(t)) return 'copywriter';
      return null;
    }
    // OpenCode uses random adjective-noun slugs (sunny-comet, calm-tiger); they don't map to crew agents
    function isOpencodeCodename(slug) {
      return slug && /^[a-z]+-[a-z]+$/.test(slug) && !slug.startsWith('crew-');
    }
    data.forEach(s => {
      const div = document.createElement('div');
      div.className = 'row' + (s.id === selected ? ' active' : '');
      div.onclick = () => { selected = s.id; refreshAll(); };
      const crewAgent = crewAgentFromTitle(s.title || '');
      const inferred = inferAgentFromTitle(s.title || '');
      const slug = s.slug || '';
      const agent = crewAgent || (slug && !isOpencodeCodename(slug) ? slug : null) || inferred;
      const slugLabel = isOpencodeCodename(slug) ? ' (' + slug + ')' : '';
      const assigned = agent ? ('Assigned to: ' + agent + slugLabel) : (slug ? ('Assigned to: ' + slug + ' (OpenCode session)') : '');
      div.innerHTML = '<div><strong>' + (s.title || s.slug || s.id) + '</strong></div><div class="meta">' + (s.directory || '-') + '</div>' + (assigned ? '<div class="meta" style="font-size:11px;color:var(--accent);">' + assigned + '</div>' : '');
      box.appendChild(div);
    });
  } catch (e) { document.getElementById('sessions').innerHTML = '<div class="meta" style="padding:20px; color:var(--red-hi);">Error loading sessions.</div>'; }
}
async function loadMessages(){
  const box = document.getElementById('messages');
  if (!selected) { box.innerHTML = '<div class="meta">No session selected.</div>'; return; }
  try {
    const data = await getJSON('/api/messages?session=' + encodeURIComponent(selected));
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
    box.scrollTop = box.scrollHeight;
  } catch (e) { box.innerHTML = '<div class="meta">Error</div>'; }
}
// ── RT Messages state ─────────────────────────────────────────────────────────
let _rtPaused = false;
let _rtFilter = 'tasks'; // 'tasks' | 'replies' | 'all'
let _rtSearch = '';
let _rtSeenIds = new Set(); // track rendered message IDs to avoid re-render flicker
const RT_SKIP = new Set(['agent.heartbeat','agent.online','agent.offline']);
const RT_TASK_TYPES = new Set(['task.dispatched','task.completed','task.failed','task.cancelled','task.started']);

function _rtMatchesFilter(m) {
  if (RT_SKIP.has(m.type)) return false;
  const payload = m.payload || {};
  const text = payload.reply || payload.prompt || payload.message || payload.content || '';
  if (!text || text === 'run_task') return false;
  if (_rtFilter === 'tasks' && !RT_TASK_TYPES.has(m.type)) return false;
  if (_rtFilter === 'replies') {
    const hasReply = !!(payload.reply || payload.message || payload.content);
    if (!hasReply) return false;
  }
  if (_rtSearch) {
    const q = _rtSearch.toLowerCase();
    const inFrom = (m.from || '').toLowerCase().includes(q);
    const inTo   = (m.to   || '').toLowerCase().includes(q);
    const inText = text.toLowerCase().includes(q);
    const inType = (m.type || '').toLowerCase().includes(q);
    if (!inFrom && !inTo && !inText && !inType) return false;
  }
  return true;
}

// Phase → badge color + label
const RT_PHASE_STYLE = {
  'task.dispatched': { color: 'var(--purple)',   label: 'dispatched' },
  'task.started':    { color: 'var(--amber)',    label: 'started'    },
  'task.completed':  { color: 'var(--green-hi)', label: 'completed'  },
  'task.failed':     { color: 'var(--red-hi)',   label: 'failed'     },
  'task.cancelled':  { color: 'var(--text-3)',   label: 'cancelled'  },
};

function _rtBuildElement(m) {
  const payload    = m.payload || {};
  const fullText   = payload.reply || payload.prompt || payload.message || payload.content || '';
  const type       = m.type || '';
  const phase      = RT_PHASE_STYLE[type];
  const timeStr    = m.ts ? new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  // First non-empty line as summary
  const firstLine  = fullText.split('\n').map(l => l.trim()).find(l => l.length > 2) || fullText;
  const summary    = firstLine.length > 90 ? firstLine.slice(0, 90) + '…' : firstLine;
  const hasMore    = fullText.length > summary.length || fullText.split('\n').length > 1;

  const row = document.createElement('div');
  row.style.cssText = [
    'display:grid',
    'grid-template-columns:auto auto 1fr auto',
    'align-items:center',
    'gap:10px',
    'padding:7px 10px',
    'border-radius:6px',
    'cursor:' + (hasMore ? 'pointer' : 'default'),
    'transition:background .12s',
    'border-bottom:1px solid var(--border)',
  ].join(';');
  row.onmouseenter = () => { row.style.background = 'var(--bg-2)'; };
  row.onmouseleave = () => { row.style.background = ''; };

  // Agent pill: from → to
  const agents = document.createElement('div');
  agents.style.cssText = 'display:flex;align-items:center;gap:5px;white-space:nowrap;min-width:0;';
  const fromPill = document.createElement('span');
  fromPill.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-1);max-width:110px;overflow:hidden;text-overflow:ellipsis;';
  fromPill.textContent = (m.from || '?').replace('crew-', '');
  fromPill.title = m.from || '';
  agents.appendChild(fromPill);
  if (m.to && m.to !== m.from) {
    const arrow = document.createElement('span');
    arrow.style.cssText = 'font-size:10px;color:var(--text-3);flex-shrink:0;';
    arrow.textContent = '→';
    const toPill = document.createElement('span');
    toPill.style.cssText = 'font-size:11px;color:var(--text-2);max-width:110px;overflow:hidden;text-overflow:ellipsis;';
    toPill.textContent = (m.to || '').replace('crew-', '');
    toPill.title = m.to || '';
    agents.appendChild(arrow);
    agents.appendChild(toPill);
  }

  // Phase badge
  const badge = document.createElement('span');
  const ps = phase || { color: 'var(--text-3)', label: type.split('.').pop() || type };
  badge.style.cssText = 'font-size:10px;font-weight:600;padding:2px 7px;border-radius:20px;white-space:nowrap;flex-shrink:0;color:#fff;background:' + ps.color + ';letter-spacing:.03em;';
  badge.textContent = ps.label;

  // Summary text
  const preview = document.createElement('span');
  preview.style.cssText = 'font-size:12px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;';
  preview.textContent = summary;

  // Time + expand hint
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

  row.appendChild(agents);
  row.appendChild(badge);
  row.appendChild(preview);
  row.appendChild(right);

  // Expand panel — shown on click
  if (hasMore) {
    const detail = document.createElement('div');
    detail.style.cssText = 'display:none;grid-column:1/-1;padding:8px 6px 4px;font-size:12px;color:var(--text-2);white-space:pre-wrap;word-break:break-word;max-height:300px;overflow-y:auto;border-top:1px solid var(--border);margin-top:4px;font-family:monospace;';
    detail.textContent = fullText;
    // Wrap row + detail in a container
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:grid;grid-template-columns:1fr;border-radius:6px;overflow:hidden;border-bottom:1px solid var(--border);';
    row.style.borderBottom = 'none'; // remove double border when wrapped
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

async function loadRTMessages(){
  if (_rtPaused) return;
  const box    = document.getElementById('rtMessages');
  const rtView = document.getElementById('rtView');
  if (!box || !rtView) return;
  box.innerHTML = '<div style="padding:20px;">Loading…</div>';

  const data = await getJSON('/api/rt-messages');
  const filtered = data.filter(_rtMatchesFilter);

  // Check if the set of visible messages changed (by type+ts key)
  const newIds = new Set(filtered.map(m => (m.type||'') + '|' + (m.ts||'') + '|' + (m.from||'')));
  const changed = newIds.size !== _rtSeenIds.size || [...newIds].some(id => !_rtSeenIds.has(id));

  if (!changed) return; // nothing new — don't repaint

  // Record scroll position BEFORE touching the DOM
  const rtAtBottom = () => rtView.scrollHeight - rtView.scrollTop - rtView.clientHeight < 100;
  const wasAtBottom = rtAtBottom();

  _rtSeenIds = newIds;
  box.innerHTML = '';
  if (!filtered.length) {
    box.innerHTML = '<div style="padding:24px;text-align:center;font-size:12px;color:var(--text-3);">No events match the current filter.</div>';
  } else {
    // Subtle column header
    const header = document.createElement('div');
    header.style.cssText = 'display:grid;grid-template-columns:auto auto 1fr auto;gap:10px;padding:4px 10px 6px;font-size:10px;font-weight:600;color:var(--text-3);letter-spacing:.06em;text-transform:uppercase;border-bottom:2px solid var(--border);margin-bottom:2px;';
    ['Agent', 'Phase', 'Summary', 'Time'].forEach(label => {
      const th = document.createElement('span'); th.textContent = label; header.appendChild(th);
    });
    box.appendChild(header);
    filtered.forEach(m => box.appendChild(_rtBuildElement(m)));
  }

  // Only scroll to bottom if user was already at bottom before repaint
  if (wasAtBottom) rtView.scrollTop = rtView.scrollHeight;

  const scrollBtn = document.getElementById('rtScrollBtn');
  if (scrollBtn) scrollBtn.style.display = rtAtBottom() ? 'none' : 'block';

  // Bind scroll listener once
  if (!rtView._scrollListenerBound) {
    rtView._scrollListenerBound = true;
    rtView.addEventListener('scroll', () => {
      if (scrollBtn) scrollBtn.style.display = rtAtBottom() ? 'none' : 'block';
    });
  }
}

function toggleRTPause(){
  _rtPaused = !_rtPaused;
  const btn = document.getElementById('rtPauseBtn');
  if (btn) { btn.textContent = _rtPaused ? '▶ Resume' : '⏸ Pause'; btn.style.background = _rtPaused ? 'var(--accent)' : ''; btn.style.color = _rtPaused ? '#fff' : ''; }
}

function clearRTMessages(){
  _rtSeenIds = new Set();
  const box = document.getElementById('rtMessages');
  if (box) box.innerHTML = '<div class="meta" style="padding:20px;text-align:center;opacity:.6;">Cleared. New messages will appear on next poll.</div>';
}

function _initRTFilters(){
  // Filter chips
  document.querySelectorAll('.rt-filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      _rtFilter = btn.dataset.filter;
      _rtSeenIds = new Set(); // force repaint with new filter
      document.querySelectorAll('.rt-filter-chip').forEach(b => {
        const active = b === btn;
        b.style.background = active ? 'var(--accent)' : 'transparent';
        b.style.color = active ? '#fff' : 'var(--text-2)';
        b.classList.toggle('active', active);
      });
      loadRTMessages();
    });
  });
  // Search
  const search = document.getElementById('rtSearch');
  if (search) {
    search.addEventListener('input', () => {
      _rtSearch = search.value.trim();
      _rtSeenIds = new Set();
      loadRTMessages();
    });
  }
}
async function loadDLQ(){
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
window.replayDLQ = async function(key){ if(!confirm('Replay?')) return; await postJSON('/api/dlq/replay', { key }); showNotification('Replayed'); loadDLQ(); };
async function deleteDLQ(key) {
  if (!confirm('Delete this DLQ entry?')) return;
  try {
    await fetch('/api/dlq/' + encodeURIComponent(key), { method: 'DELETE' });
    showNotification('DLQ entry deleted');
    loadDLQ();
  } catch(e) { showNotification('Failed: ' + e.message, true); }
}
async function refreshAll(){
  try {
    const dot = document.getElementById('statusDot');
    document.getElementById('status').textContent = 'online';
    dot.className = 'status-dot online';
    const dlqData = await getJSON('/api/dlq');
    const badge = document.getElementById('dlqBadge');
    if (dlqData.length) { badge.textContent = dlqData.length; badge.classList.remove('hidden'); }
    else { badge.classList.add('hidden'); }
    const active = document.querySelector('.view.active, .view-sessions.active');
    if (!active) return;
    if (active.id === 'dlqView') await loadDLQ();
    else if (active.id === 'rtView') await loadRTMessages();
    else if (active.id === 'sessionsView') { await loadSessions(); await loadMessages(); }
  } catch (e) {
    document.getElementById('status').textContent = 'error';
    document.getElementById('statusDot').className = 'status-dot error';
  }
}
function setNavActive(navId){
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  const el = document.getElementById(navId); if (el) el.classList.add('active');
}
function hideAllViews(){
  document.querySelectorAll('.view, .view-sessions').forEach(el => el.classList.remove('active'));
  const mb = document.querySelector('.msg-bar');
  if (mb) mb.style.display = '';
}

async function pickFolder(inputId) {
  const input = document.getElementById(inputId);
  const def = encodeURIComponent(input?.value || window._crewHome || '');
  const d = await getJSON('/api/pick-folder?default=' + def).catch(() => null);
  if (d?.path) { if (input) input.value = d.path; }
}
async function loadCrewLeadInfo() {
  try {
    const d = await getJSON('/api/agents-config');
    const cl = (d.agents || []).find(a => a.id === 'crew-lead');
    if (!cl) return;
    window._crewLeadInfo = { emoji: cl.emoji || '🧠', name: cl.name || 'crew-lead', theme: cl.theme || '' };
    const titleEl = document.getElementById('chatAgentTitle');
    const subEl   = document.getElementById('chatAgentSub');
    if (titleEl) titleEl.textContent = (cl.emoji || '🧠') + ' ' + (cl.name || 'Crew Lead');
    if (subEl && cl.theme) subEl.textContent = cl.theme + ' — chat naturally, dispatch tasks to the crew';
  } catch(e) { /* keep defaults */ }
}

async function showChat(){
  hideAllViews();
  document.getElementById('chatView').classList.add('active');
  setNavActive('navChat');
  const mb = document.querySelector('.msg-bar');
  if (mb) mb.style.display = 'none';
  _chatActiveProjectId = getStoredChatProjectId();
  const sel = document.getElementById('chatProjectSelect');
  if (sel && _chatActiveProjectId && sel.querySelector('option[value="' + _chatActiveProjectId + '"]')) sel.value = _chatActiveProjectId;
  checkCrewLeadStatus();
  startAgentReplyListener();
  loadCrewLeadInfo();
  await loadChatHistory();
  restorePassthroughLog();
}
async function loadChatHistory() {
  try {
    const d = await getJSON('/api/crew-lead/history?sessionId=' + encodeURIComponent(chatSessionId));
    const box = document.getElementById('chatMessages');
    if (!d.history || !d.history.length) return;
    box.innerHTML = '';
    lastAppendedAssistantContent = '';
    lastAppendedUserContent = '';
    d.history.forEach(h => {
      appendChatBubble(h.role === 'user' ? 'user' : 'assistant', h.content);
      if (h.role === 'assistant') lastAppendedAssistantContent = h.content;
      if (h.role === 'user') lastAppendedUserContent = h.content;
    });
    box.scrollTop = box.scrollHeight;
  } catch {}
}
function showSwarm(){
  hideAllViews();
  document.getElementById('sessionsView').classList.add('active');
  setNavActive('navSwarm');
  loadSessions(); loadMessages();
}
function showRT(){
  hideAllViews();
  document.getElementById('rtView').classList.add('active');
  setNavActive('navRT');
  _initRTFilters();
  loadRTMessages();
  const scrollBtn = document.getElementById('rtScrollBtn');
  if (scrollBtn) scrollBtn.style.display = 'none';
}
function showDLQ(){
  hideAllViews();
  document.getElementById('dlqView').classList.add('active');
  setNavActive('navDLQ');
  loadDLQ();
}
function showFiles(){
  hideAllViews();
  document.getElementById('filesView').classList.add('active');
  setNavActive('navFiles');
  loadFiles();
}

// ── Chat / crew-lead ──────────────────────────────────────────────────────────
const chatSessionId = 'owner'; // shared with Telegram — one conversation, one memory
let chatPollInterval = null;
let agentReplySSE = null;

function startAgentReplyListener() {
  if (agentReplySSE) return; // already listening
  agentReplySSE = new EventSource('/api/crew-lead/events');
  agentReplySSE.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      const box = document.getElementById('chatMessages');
      if (d.type === 'draft_discarded' && d.draftId) {
        const el = document.querySelector('[data-draft-id="' + d.draftId + '"]');
        if (el) el.remove();
        return;
      }
      if (d.type === 'context_warning' && d.sessionId === chatSessionId) {
        const existing = document.getElementById('contextWarningBanner');
        if (existing) existing.remove();
        const banner = document.createElement('div');
        banner.id = 'contextWarningBanner';
        const isCritical = d.level === 'critical';
        banner.style.cssText = `display:flex;align-items:center;gap:10px;padding:8px 14px;border-radius:8px;margin:6px 0;font-size:12px;background:${isCritical ? 'rgba(239,68,68,0.1)' : 'rgba(245,158,11,0.1)'};border:1px solid ${isCritical ? 'rgba(239,68,68,0.3)' : 'rgba(245,158,11,0.3)'};color:${isCritical ? '#f87171' : '#f59e0b'};`;
        banner.innerHTML = `<span style="flex:1;">${d.message}</span><button onclick="clearChatHistory()" style="padding:2px 8px;font-size:11px;border-radius:4px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer;">Clear now</button><button onclick="this.parentElement.remove()" style="background:none;border:none;cursor:pointer;color:inherit;font-size:14px;padding:0 2px;">✕</button>`;
        const box = document.getElementById('chatMessages');
        if (box) { box.appendChild(banner); box.scrollTop = box.scrollHeight; }
        return;
      }
      if (d.type === 'chat_message' && d.sessionId === chatSessionId) {
        if (d.role === 'user') {
          if (d.content !== lastAppendedUserContent) {
            appendChatBubble('user', d.content);
            lastAppendedUserContent = d.content;
          }
          if (d.content === lastSentContent) lastSentContent = null;
        } else if (d.role === 'assistant') {
          document.querySelectorAll('[id^="typing-"]').forEach(el => el.remove());
          if (d.content !== lastAppendedAssistantContent) {
            appendChatBubble('assistant', d.content, d.fallbackModel, d.fallbackReason);
            lastAppendedAssistantContent = d.content;
          }
        }
        if (box) box.scrollTop = box.scrollHeight;
        return;
      }
      if (d.type === 'pending_project' && d.sessionId === chatSessionId && d.pendingProject && box) {
        appendRoadmapCard(box, d.pendingProject);
        box.scrollTop = box.scrollHeight;
        return;
      }
      // agent_working from OpenCode bridge — show pulsing coding dot on agent card
      if (d.type === 'agent_working' && d.agent) {
        const dot = document.getElementById('coding-dot-' + d.agent);
        if (dot) dot.style.display = 'inline-flex';
      }
      // agent_idle from OpenCode bridge — hide coding dot
      if (d.type === 'agent_idle' && d.agent) {
        const dot = document.getElementById('coding-dot-' + d.agent);
        if (dot) dot.style.display = 'none';
      }
      // OpenCode serve live events — tool calls, file edits, session boundaries
      if (d.type === 'opencode_event') {
        const feed = document.getElementById('ocFeed');
        const liveDot = document.getElementById('ocFeedDot');
        if (!feed) return;
        if (liveDot) liveDot.style.display = 'inline-block';
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 10px;border-radius:8px;background:var(--bg-2);font-size:12px;font-family:var(--font-mono,monospace);animation:fadeIn .25s ease;';
        const time = new Date(d.ts || Date.now()).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
        let icon = '⚙️', label = '';
        if (d.kind === 'session_start') { icon = '▶'; row.style.borderLeft = '3px solid var(--green-hi)'; var _sd = d.dir || ''; label = 'session started' + (_sd ? ' — ' + _sd.split('/').pop() : ''); }
        else if (d.kind === 'session_end') { icon = '■'; row.style.borderLeft = '3px solid var(--text-3)'; label = 'session ended'; if (liveDot) liveDot.style.display = 'none'; }
        else if (d.kind === 'file_edit') { icon = '✏️'; row.style.borderLeft = '3px solid var(--amber)'; label = (d.file || d.path || '') + (d.extra ? ' <span style="opacity:.5;">'+d.extra+'</span>' : ''); }
        else if (d.kind === 'error') { icon = '✗'; row.style.borderLeft = '3px solid var(--red-hi)'; row.style.color = 'var(--red-hi)'; label = d.message || 'error'; }
        else if (d.kind === 'tool') {
          const toolColors = { read_file:'var(--accent)', write_file:'var(--amber)', bash:'var(--purple)', list_directory:'var(--green)', grep:'var(--green)' };
          const tc = toolColors[d.tool] || 'var(--text-2)';
          icon = d.phase === 'done' ? '✓' : '→';
          row.style.borderLeft = '3px solid ' + tc;
          row.style.color = d.phase === 'done' ? 'var(--text-2)' : 'var(--text-1)';
          label = '<span style="color:' + tc + ';font-weight:600;">' + (d.tool || '') + '</span>' + (d.label ? ' <span style="opacity:.6;">' + d.label + '</span>' : '');
        }
        row.innerHTML = '<span style="opacity:.4;flex-shrink:0;">' + time + '</span>' +
          '<span style="flex-shrink:0;">' + icon + '</span>' +
          '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + label + '</span>';
        feed.appendChild(row);
        // Cap at 80 rows
        while (feed.children.length > 80) feed.removeChild(feed.firstChild);
        feed.scrollTop = feed.scrollHeight;
        return;
      }
      // agent_working: crew-lead dispatched a task — show a "waiting" indicator
      if (d.type === 'agent_working' && d.agent) {
        const spinnerId = 'agent-spinner-' + (d.taskId || d.agent);
        if (box && !document.getElementById(spinnerId)) {
          const el = document.createElement('div');
          el.id = spinnerId;
          el.className = 'msg a';
          el.style.cssText = 'opacity:.7; font-style:italic;';
          el.innerHTML = '<div class="meta"><strong>' + d.agent + '</strong> · working…</div>' +
            '<div class="t" style="display:flex;align-items:center;gap:8px;">' +
            '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--accent);animation:pulse 1s ease-in-out infinite;"></span>' +
            'Processing task…</div>';
          box.appendChild(el);
          box.scrollTop = box.scrollHeight;
        }
        return;
      }
      // agent_reply: task completion from any crew member — replace spinner, show reply, notify
      if (d.type === 'agent_reply' || (d.from && d.content)) {
        if (!d.from || !d.content) return;
        const spinnerId = 'agent-spinner-' + (d.taskId || d.from);
        const spinnerEl = document.getElementById(spinnerId);
        if (spinnerEl) spinnerEl.remove();
        const agentSpinner = document.getElementById('agent-spinner-' + d.from);
        if (agentSpinner) agentSpinner.remove();
        appendChatBubble('🤖 ' + d.from, d.content, false);
        if (box) box.scrollTop = box.scrollHeight;
        showNotification(d.from + ' finished a task');
        return;
      }
      // task.timeout: dispatch never claimed or timed out — replace spinner with "No reply" message
      if (d.type === 'task.timeout' && d.agent) {
        const spinnerId = 'agent-spinner-' + (d.taskId || d.agent);
        const spinnerEl = document.getElementById(spinnerId);
        if (spinnerEl) spinnerEl.remove();
        const agentSpinner = document.getElementById('agent-spinner-' + d.agent);
        if (agentSpinner) agentSpinner.remove();
        const msg = '[crew-lead] Task to ' + d.agent + ' timed out (no reply in 90s). Consider @@SERVICE restart ' + d.agent + ' or re-dispatch to another agent.';
        if (box) {
          const el = document.createElement('div');
          el.className = 'msg a';
          el.style.cssText = 'opacity:.85; font-style:italic; color:var(--text-3);';
          el.innerHTML = '<div class="meta"><strong>' + d.agent + '</strong> · no reply</div><div class="t">' + escHtml(msg) + '</div>';
          box.appendChild(el);
          box.scrollTop = box.scrollHeight;
        }
        showNotification('Task to ' + d.agent + ' timed out');
        return;
      }
      // pipeline_progress: a wave or step dispatched
      if (d.type === 'pipeline_progress') {
        let label;
        if (d.agents) {
          label = 'Wave ' + (d.waveIndex + 1) + '/' + d.totalWaves + ' → ' + d.agents.join(' + ');
        } else {
          label = 'Step ' + (d.stepIndex + 1) + '/' + d.total + ' → ' + d.agent;
        }
        const el = document.createElement('div');
        el.style.cssText = 'font-size:11px;color:var(--text-3);padding:2px 8px;margin:2px 0;';
        el.textContent = '↳ ' + label;
        if (box) { box.appendChild(el); box.scrollTop = box.scrollHeight; }
        return;
      }
      // pipeline_quality_gate: wave had issues
      if (d.type === 'pipeline_quality_gate') {
        const el = document.createElement('div');
        const retryNote = d.willRetry ? ' — retrying wave' : ' — advancing anyway';
        el.style.cssText = 'font-size:11px;color:var(--warning, #e8a030);padding:2px 8px;margin:2px 0;';
        el.textContent = '⚠️ Wave ' + (d.waveIndex + 1) + ' quality gate: ' + (d.issues || []).join('; ') + retryNote;
        if (box) { box.appendChild(el); box.scrollTop = box.scrollHeight; }
        return;
      }
      // project_launched: new project registered — reload dropdown and auto-select
      if (d.type === 'project_launched' && d.project) {
        const newId = d.project.projectId || d.project.id;
        setTimeout(async () => {
          await loadProjects();
          if (newId) autoSelectChatProject(newId);
          const box = document.getElementById('chatMessages');
          if (box) {
            const el = document.createElement('div');
            el.style.cssText = 'font-size:11px;color:var(--green);padding:2px 8px;margin:2px 0;';
            el.textContent = '📁 Project "' + (d.project.name || newId) + '" registered — selected in chat';
            box.appendChild(el);
            box.scrollTop = box.scrollHeight;
          }
        }, 800);
        return;
      }
      // pipeline_done: all steps complete
      if (d.type === 'pipeline_done') {
        const el = document.createElement('div');
        el.style.cssText = 'font-size:11px;color:var(--green);padding:2px 8px;margin:2px 0;';
        el.textContent = '✅ Pipeline complete';
        if (box) { box.appendChild(el); box.scrollTop = box.scrollHeight; }
        return;
      }
      // confirm_run_cmd: an agent wants to run a shell command — show approval toast
      if (d.type === 'confirm_run_cmd' && d.approvalId) {
        showCmdApprovalToast(d.approvalId, d.agent, d.cmd);
        return;
      }
      // telemetry: task.lifecycle (schema 1.1) — keep list and refresh Task lifecycle panel if visible
      if (d.type === 'telemetry' && d.payload) {
        window._telemetryEvents = window._telemetryEvents || [];
        window._telemetryEvents.push(d.payload);
        if (window._telemetryEvents.length > 100) window._telemetryEvents.shift();
        const tlView = document.getElementById('toolMatrixView');
        if (tlView && tlView.classList.contains('active')) renderTaskLifecycle(window._telemetryEvents);
      }
    } catch {}
  };
  agentReplySSE.onopen = () => { window._sseReconnectDelay = 2000; };
  agentReplySSE.onerror = () => {
    agentReplySSE.close();
    agentReplySSE = null;
    // Reconnect with exponential backoff (2s → 4s → 8s → 30s max)
    if (window._sseReconnectTimer) clearTimeout(window._sseReconnectTimer);
    window._sseReconnectTimer = setTimeout(() => {
      window._sseReconnectTimer = null;
      window._sseReconnectDelay = Math.min((window._sseReconnectDelay || 2000) * 2, 30000);
      startAgentReplyListener();
    }, window._sseReconnectDelay || 2000);
  };
}

// ── Command approval toast ────────────────────────────────────────────────────

function showCmdApprovalToast(approvalId, agent, cmd) {
  const existing = document.getElementById('cmd-approval-' + approvalId);
  if (existing) return;

  const toast = document.createElement('div');
  toast.id = 'cmd-approval-' + approvalId;
  toast.style.cssText = [
    'position:fixed;bottom:80px;right:24px;z-index:9999;',
    'background:var(--bg-card);border:1px solid var(--border);border-radius:12px;',
    'padding:16px 20px;max-width:440px;box-shadow:0 8px 32px rgba(0,0,0,.4);',
    'display:flex;flex-direction:column;gap:10px;',
  ].join('');

  const header = document.createElement('div');
  header.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-1);';
  header.textContent = '🔐 ' + agent + ' wants to run a command';

  const cmdEl = document.createElement('code');
  cmdEl.style.cssText = 'display:block;font-size:12px;color:var(--accent);background:var(--bg-1);padding:6px 10px;border-radius:6px;word-break:break-all;';
  cmdEl.textContent = cmd;

  // "Always allow" toggle — infers pattern from first word of command
  const alwaysRow = document.createElement('label');
  alwaysRow.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-2);cursor:pointer;';
  const alwaysChk = document.createElement('input');
  alwaysChk.type = 'checkbox';
  alwaysChk.style.cssText = 'width:14px;height:14px;cursor:pointer;accent-color:var(--green);';
  const cmdBase = cmd.trim().split(/\s+/)[0];
  const suggestedPattern = cmdBase + ' *';
  alwaysRow.appendChild(alwaysChk);
  alwaysRow.appendChild(document.createTextNode('Always allow  '));
  const patternSpan = document.createElement('code');
  patternSpan.style.cssText = 'font-size:11px;background:var(--bg-1);padding:2px 6px;border-radius:4px;color:var(--accent);';
  patternSpan.textContent = suggestedPattern;
  alwaysRow.appendChild(patternSpan);

  const timer = document.createElement('div');
  timer.style.cssText = 'font-size:11px;color:var(--text-3);';
  let secs = 60;
  timer.textContent = 'Auto-reject in ' + secs + 's';
  const countdown = setInterval(() => {
    secs--;
    timer.textContent = 'Auto-reject in ' + secs + 's';
    if (secs <= 0) { clearInterval(countdown); toast.remove(); }
  }, 1000);

  const btns = document.createElement('div');
  btns.style.cssText = 'display:flex;gap:8px;';

  const approve = document.createElement('button');
  approve.textContent = '✅ Allow';
  approve.style.cssText = 'flex:1;padding:8px;border-radius:8px;border:none;background:var(--green);color:#fff;cursor:pointer;font-weight:600;font-size:13px;';
  approve.onclick = async () => {
    clearInterval(countdown);
    toast.remove();
    if (alwaysChk.checked) {
      await fetch('/api/cmd-allowlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pattern: suggestedPattern }) });
      showNotification('Allowlisted: ' + suggestedPattern);
    }
    await fetch('/api/cmd-approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvalId }) }).catch(e => showNotification('Approve failed: ' + e.message, true));
    if (!alwaysChk.checked) showNotification(agent + ': command approved');
  };

  const reject = document.createElement('button');
  reject.textContent = '⛔ Deny';
  reject.style.cssText = 'flex:1;padding:8px;border-radius:8px;border:none;background:var(--red-hi);color:#fff;cursor:pointer;font-weight:600;font-size:13px;';
  reject.onclick = async () => {
    clearInterval(countdown);
    toast.remove();
    await fetch('/api/cmd-reject', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvalId }) }).catch(e => showNotification('Reject failed: ' + e.message, true));
    showNotification(agent + ': command denied');
  };

  btns.appendChild(approve);
  btns.appendChild(reject);
  toast.appendChild(header);
  toast.appendChild(cmdEl);
  toast.appendChild(alwaysRow);
  toast.appendChild(timer);
  toast.appendChild(btns);
  document.body.appendChild(toast);
}

// ── Cmd allowlist manager ──────────────────────────────────────────────────────

const CMD_PRESETS = [
  { label: 'npm',    pattern: 'npm *',        desc: 'install, run, build, test…' },
  { label: 'node',   pattern: 'node *',        desc: 'run any node script' },
  { label: 'python', pattern: 'python *',      desc: 'python / python3 scripts' },
  { label: 'pip',    pattern: 'pip *',         desc: 'pip install packages' },
  { label: 'git',    pattern: 'git *',         desc: 'all git operations' },
  { label: 'cursor', pattern: 'cursor *',      desc: 'open files in Cursor' },
  { label: 'make',   pattern: 'make *',        desc: 'Makefile targets' },
  { label: 'yarn',   pattern: 'yarn *',        desc: 'yarn install / build / run' },
  { label: 'pnpm',   pattern: 'pnpm *',        desc: 'pnpm package manager' },
  { label: 'ls / cat / echo', pattern: 'ls *', desc: 'read-only shell utilities' },
];

async function loadCmdAllowlist() {
  const box = document.getElementById('cmdAllowlistItems');
  const presetsBox = document.getElementById('cmdPresets');
  if (!box) return;

  const d = await getJSON('/api/cmd-allowlist').catch(() => ({ list: [] }));
  const list = d.list || [];

  // Render presets checklist (only when the presets container exists — Settings view)
  if (presetsBox) {
    presetsBox.innerHTML = '';
    CMD_PRESETS.forEach(function(preset) {
      const checked = list.includes(preset.pattern);
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;padding:4px 6px;border-radius:6px;transition:background 0.1s;';
      row.onmouseover = function(){ row.style.background = 'var(--bg-hover)'; };
      row.onmouseout  = function(){ row.style.background = ''; };

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = checked;
      chk.style.cssText = 'width:14px;height:14px;cursor:pointer;accent-color:var(--green);flex-shrink:0;';
      chk.onchange = async function() {
        if (chk.checked) {
          await fetch('/api/cmd-allowlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pattern: preset.pattern }) })
            .catch(e => showNotification('Failed to add pattern: ' + e.message, true));
        } else {
          await fetch('/api/cmd-allowlist', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pattern: preset.pattern }) })
            .catch(e => showNotification('Failed to remove pattern: ' + e.message, true));
        }
        loadCmdAllowlist();
      };

      const nameEl = document.createElement('code');
      nameEl.style.cssText = 'font-size:12px;color:var(--accent);min-width:90px;';
      nameEl.textContent = preset.pattern;

      const descEl = document.createElement('span');
      descEl.style.cssText = 'font-size:11px;color:var(--text-3);';
      descEl.textContent = preset.desc;

      row.appendChild(chk);
      row.appendChild(nameEl);
      row.appendChild(descEl);
      presetsBox.appendChild(row);
    });
  }

  // Render active list (non-preset patterns only, or all if no presets box)
  const presetPatterns = new Set(CMD_PRESETS.map(function(p){ return p.pattern; }));
  const customPatterns = presetsBox ? list.filter(function(p){ return !presetPatterns.has(p); }) : list;

  box.innerHTML = '';
  if (!customPatterns.length) {
    box.innerHTML = '<div style="color:var(--text-3);font-size:12px;padding:4px 0;">' + (presetsBox ? 'No custom patterns yet.' : 'No patterns yet.') + '</div>';
    return;
  }
  for (const pattern of customPatterns) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);';
    const code = document.createElement('code');
    code.style.cssText = 'flex:1;font-size:12px;color:var(--accent);';
    code.textContent = pattern;
    const del = document.createElement('button');
    del.textContent = '✕';
    del.style.cssText = 'border:none;background:transparent;color:var(--text-3);cursor:pointer;font-size:14px;padding:0 4px;';
    del.title = 'Remove';
    del.onclick = async function() {
      await fetch('/api/cmd-allowlist', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pattern }) })
        .catch(e => showNotification('Failed to delete pattern: ' + e.message, true));
      loadCmdAllowlist();
    };
    row.appendChild(code);
    row.appendChild(del);
    box.appendChild(row);
  }
}

async function addAllowlistPattern() {
  const inp = document.getElementById('cmdAllowlistInput');
  const pattern = inp ? inp.value.trim() : '';
  if (!pattern) return;
  await fetch('/api/cmd-allowlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pattern }) })
    .catch(e => showNotification('Failed to add pattern: ' + e.message, true));
  inp.value = '';
  loadCmdAllowlist();
}

// ── Telegram sessions viewer ──────────────────────────────────────────────────

async function loadTelegramSessions() {
  const box = document.getElementById('tgSessionsList');
  if (!box) return;
  const sessions = await getJSON('/api/telegram-sessions').catch(() => []);
  box.innerHTML = '';
  if (!sessions.length) {
    box.innerHTML = '<div style="color:var(--text-3);font-size:12px;padding:8px;">No Telegram sessions yet — send a message to your bot to start one.</div>';
    return;
  }
  for (const s of sessions) {
    const card = document.createElement('div');
    card.style.cssText = 'background:var(--bg-1);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:10px;';
    const ago = s.lastTs ? Math.round((Date.now() - s.lastTs) / 60000) + 'm ago' : 'unknown';
    const msgLines = s.messages.slice(-6).map(m => {
      const color = m.role === 'user' ? 'var(--accent)' : 'var(--green)';
      const icon  = m.role === 'user' ? '👤' : '🤖';
      const txt   = String(m.content || '').slice(0, 100).replace(/</g, '&lt;');
      return '<div style="margin-bottom:4px;"><span style="color:' + color + ';">' + icon + '</span> <span>' + txt + '</span></div>';
    }).join('');
    card.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
        '<span style="font-size:13px;font-weight:600;">chat ' + s.chatId + '</span>' +
        '<span style="font-size:11px;color:var(--text-3);">' + s.messageCount + ' msgs · ' + ago + '</span>' +
      '</div>' +
      '<div style="font-size:12px;color:var(--text-2);border-top:1px solid var(--border);padding-top:8px;max-height:120px;overflow-y:auto;">' +
        msgLines +
      '</div>';
    box.appendChild(card);
  }
}

// ── Token usage widget ────────────────────────────────────────────────────────

// Approximate cost per 1M tokens by model prefix (input / output)
// Keys matched via .includes() — more specific keys must come before general ones
const MODEL_COST_PER_M = {
  // ── xAI Grok (2026 pricing) ───────────────────────────────────────────────
  'grok-4-1-fast':         [0.20,  0.50],  // grok-4.1-fast + non-reasoning variant
  'grok-4-fast':           [0.20,  0.50],
  'grok-4':                [3.00, 15.00],
  'grok-3-mini':           [0.30,  0.50],
  'grok-3':                [3.00, 15.00],
  'grok-code-fast':        [0.20,  1.50],
  'grok-beta':             [5.00, 15.00],  // legacy
  // ── OpenAI gpt-5.x (via openai or openai-local proxy) ───────────────────
  'gpt-5.3-codex':         [2.50, 20.00],  // estimate — newer than 5.2
  'gpt-5.2-codex':         [1.75, 14.00],
  'gpt-5.2':               [1.75, 14.00],
  'gpt-5.1-codex-max':     [2.50, 20.00],  // estimate — max tier
  'gpt-5.1-codex-mini':    [0.25,  2.00],
  'gpt-5.1-codex':         [1.25, 10.00],
  'gpt-5.1':               [1.25, 10.00],
  'gpt-5-codex':           [1.25, 10.00],
  'gpt-5-nano':            [0.15,  0.60],  // estimate
  'gpt-5':                 [1.25, 10.00],
  'codex-mini':            [0.25,  2.00],
  // ── OpenAI legacy ────────────────────────────────────────────────────────
  'gpt-oss-120b':          [0.90,  0.90],  // Groq-hosted OSS model, estimate
  'gpt-oss-20b':           [0.20,  0.20],  // estimate
  'gpt-4o-mini':           [0.15,  0.60],
  'gpt-4o':                [2.50, 10.00],
  'gpt-4':                 [30.0, 60.00],
  // ── DeepSeek ─────────────────────────────────────────────────────────────
  'deepseek-reasoner':     [0.70,  2.50],  // R1
  'deepseek-chat':         [0.27,  1.10],
  // ── Mistral ──────────────────────────────────────────────────────────────
  'mistral-large':         [0.50,  1.50],  // mistral-large-latest = Large 3 2512 (Dec 2025)
  'mistral-small':         [0.10,  0.30],
  // ── Google Gemini 3 (preview, 2026) ──────────────────────────────────────
  'gemini-3.1-pro':        [2.50, 15.00],  // 3.1 Pro preview
  'gemini-3.1-flash':      [0.075, 0.30],  // 3.1 Flash preview
  'gemini-3-pro':          [2.50, 15.00],  // Gemini 3 Pro preview
  'gemini-3-flash':        [0.075, 0.30],  // Gemini 3 Flash preview
  // ── Google Gemini 2.5 ────────────────────────────────────────────────────
  'gemini-2.5-pro':        [1.25, 10.00],
  'gemini-2.5-flash-lite': [0.04,  0.15],  // Flash Lite (lower cost)
  'gemini-2.5-flash':      [0.075, 0.30],
  'gemini-2.0-flash-lite': [0.075, 0.30],
  'gemini-2.0-flash':      [0.10,  0.40],
  // ── Anthropic Claude ─────────────────────────────────────────────────────
  'claude-opus-4':         [15.0, 75.00],
  'claude-sonnet-4':       [3.00, 15.00],
  'claude-haiku-4':        [0.80,  4.00],
  'claude-3-5-haiku':      [0.80,  4.00],
  'claude-3-haiku':        [0.25,  1.25],
  'claude-3-5-sonnet':     [3.00, 15.00],
  'claude-3-7-sonnet':     [3.00, 15.00],
  // ── Groq-hosted (inference pricing) ──────────────────────────────────────
  'kimi-k2-instruct':      [1.00,  3.00],
  'kimi-k2':               [0.60,  2.50],
  'llama-4-maverick':      [0.50,  0.77],
  'llama-4-scout':         [0.11,  0.34],
  'llama-3.3-70b':         [0.59,  0.79],
  'llama-3.1-70b':         [0.59,  0.79],
  'llama3.1-70b':          [0.59,  0.79],
  'llama-3.1-8b':          [0.05,  0.08],
  'llama3.1-8b':           [0.10,  0.10],  // Cerebras pricing
  'qwen3-32b':             [0.29,  0.39],
  'llama-guard':           [0.20,  0.20],
  // ── Perplexity ───────────────────────────────────────────────────────────
  'sonar-pro':             [3.00, 15.00],
  'sonar':                 [1.00,  1.00],
  // ── OpenCode free models ──────────────────────────────────────────────────
  'big-pickle':            [0.00,  0.00],  // free
  'trinity-large-preview': [0.00,  0.00],  // free
  'minimax-m2.5-free':     [0.00,  0.00],  // free
  'glm-':                  [0.10,  0.10],  // estimate
  'minimax':               [0.30,  1.00],  // estimate
  // ── Default fallback ─────────────────────────────────────────────────────
  'default':               [1.00,  3.00],
};

function estimateCost(byModel) {
  let total = 0;
  for (const [model, stats] of Object.entries(byModel || {})) {
    const rateKey = Object.keys(MODEL_COST_PER_M).find(k => model.toLowerCase().includes(k)) || 'default';
    const [inputRate, outputRate] = MODEL_COST_PER_M[rateKey];
    total += (stats.prompt / 1e6) * inputRate + (stats.completion / 1e6) * outputRate;
  }
  return total;
}

async function loadTokenUsage() {
  const box = document.getElementById('tokenUsageWidget');
  if (!box) return;
  const u = await getJSON('/api/token-usage').catch(() => ({}));
  const totalTokens = (u.prompt || 0) + (u.completion || 0);
  const cost = estimateCost(u.byModel);

  // ── Totals row ────────────────────────────────────────────────────────────
  let html =
    '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px;">' +
      '<div style="text-align:center;">' +
        '<div style="font-size:20px;font-weight:700;color:var(--accent);">' + (u.calls||0).toLocaleString() + '</div>' +
        '<div style="font-size:11px;color:var(--text-3);margin-top:2px;">LLM calls</div>' +
      '</div>' +
      '<div style="text-align:center;">' +
        '<div style="font-size:20px;font-weight:700;color:var(--green);">' + (totalTokens/1000).toFixed(1) + 'k</div>' +
        '<div style="font-size:11px;color:var(--text-3);margin-top:2px;">total tokens</div>' +
      '</div>' +
      '<div style="text-align:center;">' +
        '<div style="font-size:20px;font-weight:700;color:var(--yellow);">$' + cost.toFixed(4) + '</div>' +
        '<div style="font-size:11px;color:var(--text-3);margin-top:2px;">est. cost (all-time)</div>' +
      '</div>' +
    '</div>';

  // ── Daily history ─────────────────────────────────────────────────────────
  const byDay = u.byDay || {};
  const days = Object.keys(byDay).sort().reverse().slice(0, 14);
  if (days.length) {
    const maxCost = Math.max(...days.map(function(d){ return estimateCost(byDay[d].byModel || {}); }), 0.0001);
    html += '<div style="font-size:11px;font-weight:600;color:var(--text-2);margin:12px 0 6px;">Daily cost (last ' + days.length + ' days)</div>';
    html += '<div style="display:flex;flex-direction:column;gap:3px;">';
    days.forEach(function(day) {
      const ds = byDay[day];
      const dc = estimateCost(ds.byModel || {});
      const pct = Math.max((dc / maxCost) * 100, 2);
      const tok = ((ds.prompt||0) + (ds.completion||0)) / 1000;
      const isToday = day === new Date().toISOString().slice(0, 10);
      html += '<div style="display:flex;align-items:center;gap:8px;font-size:11px;">' +
        '<span style="width:70px;color:var(--text-3);flex-shrink:0;">' + (isToday ? 'today' : day.slice(5)) + '</span>' +
        '<div style="flex:1;background:var(--bg-1);border-radius:3px;height:14px;overflow:hidden;">' +
          '<div style="width:' + pct.toFixed(1) + '%;height:100%;background:' + (isToday ? 'var(--accent)' : 'var(--green)') + ';border-radius:3px;"></div>' +
        '</div>' +
        '<span style="width:52px;text-align:right;color:var(--yellow);font-weight:600;">$' + dc.toFixed(4) + '</span>' +
        '<span style="width:44px;text-align:right;color:var(--text-3);">' + tok.toFixed(1) + 'k</span>' +
      '</div>';
    });
    html += '</div>';
  } else {
    html += '<div style="font-size:11px;color:var(--text-3);margin-top:8px;">No daily history yet — data accumulates with next LLM call after restart.</div>';
  }

  // ── By model (all-time) ───────────────────────────────────────────────────
  if (Object.keys(u.byModel||{}).length) {
    html += '<div style="font-size:11px;color:var(--text-3);margin:12px 0 6px;">By model (all-time)</div>';
    Object.entries(u.byModel||{})
      .sort((a,b) => (b[1].prompt+b[1].completion) - (a[1].prompt+a[1].completion))
      .forEach(function(entry) {
        const model = entry[0], s = entry[1];
        const rateKey = Object.keys(MODEL_COST_PER_M).find(function(k){ return model.toLowerCase().includes(k); }) || 'default';
        const rates = MODEL_COST_PER_M[rateKey];
        const mc = (s.prompt/1e6)*rates[0] + (s.completion/1e6)*rates[1];
        html += '<div style="display:flex;justify-content:space-between;font-size:11px;padding:3px 0;border-bottom:1px solid var(--border);">' +
          '<code style="color:var(--accent);">' + model + '</code>' +
          '<span style="color:var(--text-2);">' + ((s.prompt+s.completion)/1000).toFixed(1) + 'k tok · $' + mc.toFixed(4) + '</span>' +
          '</div>';
      });
  }
  box.innerHTML = html;
}

async function loadOcStats() {
  const box = document.getElementById('ocStatsWidget');
  if (!box) return;
  const days = document.getElementById('ocStatsDays')?.value || '14';
  _ocTotalCost = null;
  box.innerHTML = '<div style="color:var(--text-3);font-size:12px;">Loading&#x2026;</div>';
  try {
    const d = await getJSON('/api/opencode-stats?days=' + days);
    if (!d.ok || !Object.keys(d.byDay||{}).length) {
      box.innerHTML = '<div style="color:var(--text-3);font-size:12px;">' + (d.error || 'No OpenCode data found') + '</div>';
      return;
    }
    const byDay = d.byDay;
    const sortedDays = Object.keys(byDay).sort().reverse();
    const totalCost = sortedDays.reduce(function(s,day){ return s + byDay[day].cost; }, 0);
    const totalIn   = sortedDays.reduce(function(s,day){ return s + byDay[day].input_tok; }, 0);
    const totalOut  = sortedDays.reduce(function(s,day){ return s + byDay[day].output_tok; }, 0);
    const totalCalls= sortedDays.reduce(function(s,day){ return s + byDay[day].calls; }, 0);
    const maxCost   = Math.max(...sortedDays.map(function(d){ return byDay[d].cost; }), 0.0001);

    let html = '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px;">' +
      '<div style="text-align:center;"><div style="font-size:18px;font-weight:700;color:var(--yellow);">$' + totalCost.toFixed(4) + '</div><div style="font-size:11px;color:var(--text-3);">total cost</div></div>' +
      '<div style="text-align:center;"><div style="font-size:18px;font-weight:700;color:var(--accent);">' + totalCalls.toLocaleString() + '</div><div style="font-size:11px;color:var(--text-3);">messages</div></div>' +
      '<div style="text-align:center;"><div style="font-size:18px;font-weight:700;color:var(--green);">' + (totalIn/1e6).toFixed(1) + 'M</div><div style="font-size:11px;color:var(--text-3);">input tokens</div></div>' +
      '<div style="text-align:center;"><div style="font-size:18px;font-weight:700;color:var(--green);">' + (totalOut/1e6).toFixed(2) + 'M</div><div style="font-size:11px;color:var(--text-3);">output tokens</div></div>' +
    '</div>';

    // Daily bars
    html += '<div style="display:flex;flex-direction:column;gap:4px;margin-bottom:16px;">';
    const today = new Date().toISOString().slice(0,10);
    sortedDays.forEach(function(day) {
      const ds = byDay[day];
      const pct = Math.max((ds.cost / maxCost) * 100, ds.cost > 0 ? 2 : 0);
      const isToday = day === today;
      const tok = (ds.input_tok + ds.output_tok) / 1e6;
      html += '<div style="display:flex;align-items:center;gap:8px;font-size:11px;">' +
        '<span style="width:70px;color:var(--text-3);flex-shrink:0;">' + (isToday ? 'today' : day.slice(5)) + '</span>' +
        '<div style="flex:1;background:var(--bg-1);border-radius:3px;height:16px;overflow:hidden;">' +
          '<div style="width:' + pct.toFixed(1) + '%;height:100%;background:' + (isToday ? 'var(--accent)' : 'var(--green)') + ';border-radius:3px;opacity:0.85;"></div>' +
        '</div>' +
        '<span style="width:60px;text-align:right;color:var(--yellow);font-weight:600;">$' + ds.cost.toFixed(4) + '</span>' +
        '<span style="width:50px;text-align:right;color:var(--text-3);">' + tok.toFixed(2) + 'M</span>' +
        '<span style="width:36px;text-align:right;color:var(--text-3);">' + ds.calls + '</span>' +
      '</div>';
    });
    html += '</div>';

    // All models across period
    const allModels = {};
    sortedDays.forEach(function(day) {
      Object.entries(byDay[day].byModel||{}).forEach(function(e) {
        const m = e[0], s = e[1];
        if (!allModels[m]) allModels[m] = { cost:0, input_tok:0, output_tok:0, calls:0 };
        allModels[m].cost += s.cost;
        allModels[m].input_tok += s.input_tok;
        allModels[m].output_tok += s.output_tok;
        allModels[m].calls += s.calls;
      });
    });
    const sortedModels = Object.entries(allModels).sort(function(a,b){ return b[1].cost - a[1].cost; });
    if (sortedModels.length) {
      html += '<div style="font-size:11px;color:var(--text-3);margin-bottom:6px;">By model</div>';
      sortedModels.forEach(function(e) {
        const m = e[0], s = e[1];
        const tok = (s.input_tok + s.output_tok) / 1e6;
        html += '<div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;padding:3px 0;border-bottom:1px solid var(--border);">' +
          '<code style="color:var(--accent);">' + m + '</code>' +
          '<span style="color:var(--text-2);">' + tok.toFixed(2) + 'M tok · ' + s.calls + ' calls · ' +
            '<span style="color:var(--yellow);font-weight:600;">$' + s.cost.toFixed(4) + '</span>' +
          '</span>' +
        '</div>';
      });
    }
    _ocTotalCost = totalCost;
    updateGrandTotal();
    box.innerHTML = html;
  } catch(e) {
    box.innerHTML = '<div style="color:var(--red);font-size:12px;">Error: ' + e.message + '</div>';
  }
}

async function checkCrewLeadStatus() {
  try {
    const d = await getJSON('/api/crew-lead/status');
    const badge = document.getElementById('crewLeadBadge');
    if (d.online) {
      badge.textContent = '● online'; badge.className = 'status-badge status-running';
    } else {
      badge.textContent = '● offline'; badge.className = 'status-badge status-stopped';
    }
  } catch {}
}

// @@ autocomplete: type @@ for list, @@PROMPT (or pick) shows exact JSON
const ATAT_COMMANDS = [
  { id: 'RESET', label: 'Clear session history and start fresh', template: '' },
  { id: 'STOP', label: 'Cancel all running pipelines (agents keep running)', template: '' },
  { id: 'KILL', label: 'Kill all pipelines + terminate all agent bridges', template: '' },
  { id: 'SEARCH_HISTORY', label: 'Search long-term chat history by keyword', template: 'your search terms' },
  { id: 'DISPATCH', label: 'Dispatch task to an agent', template: '{"agent":"crew-coder","task":"Your task here"}' },
  { id: 'PIPELINE', label: 'Multi-step pipeline (waves of agents)', template: '[{"wave":1,"agent":"crew-coder","task":"..."},{"wave":2,"agent":"crew-qa","task":"..."}]' },
  { id: 'PROMPT', label: 'Append or set agent system prompt', template: '{"agent":"crew-lead","append":"Your new rule here"}' },
  { id: 'SKILL', label: 'Run a skill by name', template: 'skillName {"param":"value"}' },
  { id: 'SERVICE', label: 'Restart/stop a service or agent', template: 'restart crew-coder' },
  { id: 'READ_FILE', label: 'Read a file and get its contents', template: '/path/to/file' },
  { id: 'RUN_CMD', label: 'Run a shell command', template: 'ls -la /Users/jeffhobbs/Desktop/CrewSwarm' },
  { id: 'WEB_SEARCH', label: 'Search the web (Perplexity)', template: 'your search query' },
  { id: 'WEB_FETCH', label: 'Fetch a webpage or URL', template: 'https://example.com' },
  { id: 'PROJECT', label: 'Draft a new project roadmap', template: '{"name":"MyApp","description":"...","outputDir":"/path/to/dir"}' },
  { id: 'BRAIN', label: 'Append a fact to brain.md', template: 'crew-lead: fact to remember' },
  { id: 'TOOLS', label: 'Grant/revoke tools for an agent', template: '{"agent":"crew-qa","allow":["read_file","write_file"]}' },
  { id: 'CREATE_AGENT', label: 'Create a dynamic agent', template: '{"id":"crew-ml","role":"coder","description":"ML specialist"}' },
  { id: 'REMOVE_AGENT', label: 'Remove a dynamic agent', template: 'crew-ml' },
  { id: 'DEFINE_SKILL', label: 'Define a new skill (then @@END_SKILL)', template: 'skillName\\n{"description":"...","url":"..."}' },
  { id: 'DEFINE_WORKFLOW', label: 'Save a workflow for cron', template: 'name\\n[{"agent":"crew-copywriter","task":"..."}]' },
];
function chatAtAtInput() {
  const ta = document.getElementById('chatInput');
  const menu = document.getElementById('chatAtAtMenu');
  const hint = document.getElementById('chatAtAtTemplate');
  if (!ta || !menu || !hint) return;
  try {
  const val = ta.value;
  const caret = ta.selectionStart;
  const before = val.slice(0, caret);
  const lastAt = before.lastIndexOf('@@');
  if (lastAt === -1) { menu.style.display = 'none'; hint.style.display = 'none'; return; }
  const afterAt = before.slice(lastAt + 2);
  if (/\\s/.test(afterAt)) { menu.style.display = 'none'; hint.style.display = 'none'; return; }
  const prefix = afterAt.toUpperCase();
  const filtered = ATAT_COMMANDS.filter(function(c) { return c.id.indexOf(prefix) === 0; });
  if (filtered.length === 0) { menu.style.display = 'none'; hint.style.display = 'none'; return; }
  menu.style.display = 'block';
  menu.style.visibility = 'visible';
  menu.innerHTML = '';
  filtered.forEach(function(c) {
    const row = document.createElement('div');
    row.style.cssText = 'padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border);';
    row.onmouseenter = function() { row.style.background = 'var(--bg-hover)'; };
    row.onmouseleave = function() { row.style.background = ''; };
    row.innerHTML = '<span style="color:var(--accent);font-weight:600;">@@' + c.id + '</span> <span style="color:var(--text-3);">' + c.label + '</span>';
    row.onclick = function() {
      const insert = '@@' + c.id + (c.template ? ' ' + c.template : '');
      ta.value = val.slice(0, lastAt) + insert + val.slice(caret);
      ta.selectionStart = ta.selectionEnd = lastAt + insert.length;
      ta.focus();
      menu.style.display = 'none';
      hint.style.display = 'block';
      hint.textContent = (c.id === 'PROMPT' ? 'Full line to send: @@PROMPT ' : 'Template: ') + (c.template ? c.template : '');
    };
    menu.appendChild(row);
  });
  const exact = filtered.find(function(c) { return c.id === prefix; });
  if (exact) {
    hint.style.display = 'block';
    hint.textContent = (exact.id === 'PROMPT' ? 'Full line: @@PROMPT ' : 'Template: ') + (exact.template || '');
  } else {
    hint.style.display = 'none';
  }
  } catch (err) { if (typeof console !== 'undefined') console.warn('chatAtAtInput', err); }
}
function chatKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  var menu = document.getElementById('chatAtAtMenu');
  if (menu && menu.style.display === 'block' && (e.key === 'Escape' || e.key === 'Tab')) { menu.style.display = 'none'; }
}


function appendRoadmapCard(box, { draftId, name, outputDir, roadmapMd }) {
  function countTasks(md) { return (md.match(/^- \[ \]/gm) || []).length; }

  const wrap = document.createElement('div');
  wrap.setAttribute('data-draft-id', draftId);
  wrap.style.cssText = 'width:100%;display:flex;flex-direction:column;gap:4px;';

  const lbl = document.createElement('div');
  lbl.style.cssText = 'font-size:11px;color:var(--text-3);padding:0 6px;';
  lbl.textContent = '🗺️ Roadmap draft — review before building';

  const card = document.createElement('div');
  card.style.cssText = 'width:100%;border:1px solid var(--border);border-radius:12px;overflow:hidden;background:var(--bg-card);';

  const header = document.createElement('div');
  header.style.cssText = 'background:var(--bg-card2);padding:10px 14px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);';
  header.innerHTML = '<div><div style="font-size:13px;font-weight:600;color:var(--accent);">🚀 ' + name + '</div><div style="font-size:11px;color:var(--blue);margin-top:2px;">' + outputDir + '</div></div>' +
    '<span style="font-size:10px;color:var(--text-3);padding:2px 7px;background:var(--bg-card2);border-radius:10px;" class="task-count">' + countTasks(roadmapMd) + ' tasks</span>';

  const ta = document.createElement('textarea');
  ta.value = roadmapMd;
  ta.spellcheck = false;
  ta.style.cssText = 'width:100%;background:var(--bg-card);border:none;outline:none;color:var(--text-1);font-size:11.5px;font-family:SF Mono,Monaco,Menlo,monospace;line-height:1.6;padding:12px 14px;resize:none;min-height:160px;max-height:320px;display:block;';
  setTimeout(() => { ta.style.height = ''; ta.style.height = Math.min(ta.scrollHeight, 320) + 'px'; }, 50);
  ta.addEventListener('input', () => {
    ta.style.height = ''; ta.style.height = Math.min(ta.scrollHeight, 320) + 'px';
    header.querySelector('.task-count').textContent = countTasks(ta.value) + ' tasks';
  });

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;align-items:center;padding:10px 14px 12px;border-top:1px solid var(--border);background:var(--bg-card2);';

  const startBtn = document.createElement('button');
  startBtn.textContent = '▶ Start Building';
  startBtn.style.cssText = 'background:var(--green-hi);color:#000;border:none;border-radius:8px;padding:8px 16px;font-size:12px;font-weight:700;cursor:pointer;';
  startBtn.onclick = async () => {
    startBtn.disabled = true; startBtn.textContent = '⏳ Launching…';
    try {
      const r = await postJSON('/api/crew-lead/confirm-project', { draftId, roadmapMd: ta.value });
      if (r.ok) {
        card.innerHTML = '<div style="padding:14px;color:var(--green-hi);font-size:13px;font-weight:600;">✅ ' + name + ' — project created, PM loop running!<br><span style="color:var(--blue);font-size:11px;font-weight:400">' + (r.outputDir || outputDir) + '</span></div>';
        appendChatBubble('assistant', '🚀 ' + name + ' is building. Check the Projects tab to watch progress.');
      } else {
        startBtn.disabled = false; startBtn.textContent = '▶ Start Building';
        status.textContent = '⚠️ ' + (r.error || 'Launch failed');
      }
    } catch(e) { startBtn.disabled = false; startBtn.textContent = '▶ Start Building'; status.textContent = '⚠️ ' + e.message; }
  };

  const discardBtn = document.createElement('button');
  discardBtn.textContent = 'Discard';
  discardBtn.style.cssText = 'background:none;border:1px solid var(--border);color:var(--text-3);border-radius:8px;padding:8px 14px;font-size:12px;cursor:pointer;';
  discardBtn.onclick = async () => {
    await postJSON('/api/crew-lead/discard-project', { draftId }).catch(() => {});
    wrap.remove();
  };

  const status = document.createElement('span');
  status.style.cssText = 'font-size:11px;color:var(--blue);margin-left:auto;';
  status.textContent = 'Edit above, then confirm';

  actions.appendChild(startBtn); actions.appendChild(discardBtn); actions.appendChild(status);
  card.appendChild(header); card.appendChild(ta); card.appendChild(actions);
  wrap.appendChild(lbl); wrap.appendChild(card);
  box.appendChild(wrap);
  box.scrollTop = box.scrollHeight;
}

let lastAppendedAssistantContent = '';
let lastAppendedUserContent = '';
let lastSentContent = null;
async function sendChat() {
  const input = document.getElementById('chatInput');
  const sendBtn = document.querySelector('[data-action="sendChat"]');
  const text = input.value.trim();
  if (!text) return;

  // ── Direct engine passthrough mode ──────────────────────────────────────────
  const engine = document.getElementById('passthroughEngine')?.value || '';
  if (engine) { await sendPassthrough(text, engine); return; }

  input.value = '';
  input.disabled = true;
  if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = 'Sending…'; }
  appendChatBubble('user', text);
  lastAppendedUserContent = text;
  lastSentContent = text;
  const typingId = 'typing-' + Date.now();
  const typingDiv = document.createElement('div');
  typingDiv.id = typingId;
  typingDiv.style.cssText = 'font-size:12px;color:var(--text-3);padding:4px 6px;';
  const _cl = window._crewLeadInfo || { emoji: '🧠', name: 'crew-lead' };
  typingDiv.textContent = _cl.emoji + ' ' + _cl.name + ' is thinking...';
  const box = document.getElementById('chatMessages');
  box.appendChild(typingDiv);
  box.scrollTop = box.scrollHeight;
  try {
    const d = await postJSON('/api/crew-lead/chat', { message: text, sessionId: chatSessionId, projectId: _chatActiveProjectId || undefined });
    document.querySelectorAll('[id^="typing-"]').forEach(el => el.remove());
    if (d.ok === false && d.error) {
      appendChatBubble('assistant', '⚠️ ' + d.error);
      lastAppendedAssistantContent = '';
    } else if (d.reply) {
      const reply = d.reply;
      setTimeout(() => {
        if (reply !== lastAppendedAssistantContent) {
          appendChatBubble('assistant', reply);
          lastAppendedAssistantContent = reply;
          if (box) box.scrollTop = box.scrollHeight;
        }
      }, 400);
    }
    if (d.dispatched) {
      const note = document.createElement('div');
      note.style.cssText = 'font-size:11px;color:var(--text-3);text-align:center;padding:4px;';
      note.textContent = '⚡ Dispatched to ' + d.dispatched.agent;
      box.appendChild(note);
    }
    if (d.pendingProject) appendRoadmapCard(box, d.pendingProject);
    box.scrollTop = box.scrollHeight;
  } catch(e) {
    document.querySelectorAll('[id^="typing-"]').forEach(el => el.remove());
    let errMsg = e.message || String(e);
    try {
      const parsed = JSON.parse(errMsg);
      if (parsed && typeof parsed.error === 'string') errMsg = parsed.error;
    } catch {}
    appendChatBubble('assistant', '⚠️ Error: ' + errMsg);
    lastAppendedAssistantContent = '';
    box.scrollTop = box.scrollHeight;
  } finally {
    input.disabled = false;
    if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send'; }
    input.focus();
  }
}

async function clearChatHistory() {
  if (!confirm('Clear chat history for this session?')) return;
  document.getElementById('chatMessages').innerHTML = '';
  localStorage.removeItem(PASSTHROUGH_LOG_KEY);
  await postJSON('/api/crew-lead/clear', { sessionId: chatSessionId }).catch(()=>{});
}

const PASSTHROUGH_LOG_KEY = 'crewswarm_passthrough_log';
const PASSTHROUGH_LOG_MAX = 200;
function savePassthroughMsg(role, engine, text, exitCode) {
  try {
    const log = JSON.parse(localStorage.getItem(PASSTHROUGH_LOG_KEY) || '[]');
    log.push({ role, engine, text, exitCode, ts: Date.now() });
    if (log.length > PASSTHROUGH_LOG_MAX) log.splice(0, log.length - PASSTHROUGH_LOG_MAX);
    localStorage.setItem(PASSTHROUGH_LOG_KEY, JSON.stringify(log));
  } catch {}
}
function restorePassthroughLog() {
  try {
    const log = JSON.parse(localStorage.getItem(PASSTHROUGH_LOG_KEY) || '[]');
    const box = document.getElementById('chatMessages');
    if (!box || !log.length) return;
    const engineLabels = { claude: '🤖 Claude Code', cursor: '🖱 Cursor CLI', opencode: '⚡ OpenCode', codex: '🟣 Codex CLI', 'docker-sandbox': '🐳 Docker Sandbox' };
    for (const entry of log) {
      if (entry.role === 'user') {
        appendChatBubble('user', entry.text);
      } else {
        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble assistant';
        bubble.style.cssText = 'background:var(--surface-2);border-radius:10px;padding:12px 14px;font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word;font-family:monospace;font-size:12px;color:var(--text-2);';
        const lbl = document.createElement('div');
        lbl.style.cssText = 'font-size:11px;font-weight:700;color:var(--text-3);margin-bottom:6px;';
        lbl.textContent = (engineLabels[entry.engine] || entry.engine) + ' · direct passthrough ✓ (exit ' + (entry.exitCode ?? 0) + ')';
        const cnt = document.createElement('div');
        cnt.textContent = entry.text;
        bubble.appendChild(lbl); bubble.appendChild(cnt);
        box.appendChild(bubble);
      }
    }
    box.scrollTop = box.scrollHeight;
  } catch {}
}
async function sendPassthrough(text, engine) {
  const input = document.getElementById('chatInput');
  const sendBtn = document.querySelector('[data-action="sendChat"]');
  const engineLabels = { claude: '🤖 Claude Code', cursor: '🖱 Cursor CLI', opencode: '⚡ OpenCode', codex: '🟣 Codex CLI', 'docker-sandbox': '🐳 Docker Sandbox' };
  input.value = '';
  input.disabled = true;
  if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '…'; }

  appendChatBubble('user', text);
  const box = document.getElementById('chatMessages');

  // Create streaming reply bubble
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble assistant';
  bubble.style.cssText = 'background:var(--surface-2);border-radius:10px;padding:12px 14px;font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word;font-family:monospace;font-size:12px;color:var(--text-2);';
  const label = document.createElement('div');
  label.style.cssText = 'font-size:11px;font-weight:700;color:var(--text-3);margin-bottom:6px;';
  const activeProj2 = _chatActiveProjectId && _projectsData[_chatActiveProjectId];
  label.textContent = (engineLabels[engine] || engine) + ' · direct passthrough' + (activeProj2?.outputDir ? ' @ ' + activeProj2.outputDir.split('/').pop() : '');
  const content = document.createElement('div');
  bubble.appendChild(label);
  bubble.appendChild(content);
  box.appendChild(bubble);
  box.scrollTop = box.scrollHeight;

  try {
    const activeProj = _chatActiveProjectId && _projectsData[_chatActiveProjectId];
    const projectDir = activeProj?.outputDir || undefined;
    const injectHistory = document.getElementById('passthroughInjectHistory')?.checked || false;
    const resp = await fetch('/api/engine-passthrough', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engine, message: text, ...(projectDir ? { projectDir } : {}), ...(injectHistory ? { injectHistory: true } : {}) }),
    });
    if (!resp.ok) { content.textContent = `Error ${resp.status}: ${await resp.text()}`; return; }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const ev = JSON.parse(line.slice(6));
          if (ev.type === 'chunk' && ev.text) {
            content.textContent += ev.text;
            box.scrollTop = box.scrollHeight;
          } else if (ev.type === 'done') {
            const exitCode = ev.exitCode ?? 0;
            label.textContent += ` ✓ (exit ${exitCode})`;
            savePassthroughMsg('user', engine, text, null);
            savePassthroughMsg('engine', engine, content.textContent, exitCode);
          }
        } catch {}
      }
    }
  } catch(e) {
    content.textContent = 'Error: ' + e.message;
  } finally {
    input.disabled = false;
    if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send'; }
    input.focus();
  }
}
window.sendPassthrough = sendPassthrough;

async function stopAll() {
  if (!confirm('Stop all running pipelines?')) return;
  try {
    await postJSON('/api/crew-lead/chat', { message: '@@STOP', sessionId: chatSessionId });
    showNotification('⏹ Stop signal sent');
  } catch(e) { showNotification('Failed: ' + e.message, true); }
}
async function killAll() {
  if (!confirm('Kill all agents? Bridges must be restarted after.')) return;
  try {
    await postJSON('/api/crew-lead/chat', { message: '@@KILL', sessionId: chatSessionId });
    showNotification('☠️ Kill signal sent');
  } catch(e) { showNotification('Failed: ' + e.message, true); }
}

function showMessaging(){
  showSettings();
  showSettingsTab('comms');
  loadTgStatus();
}

async function loadTgStatus(){
  try {
    const d = await getJSON('/api/telegram/status');
    const badge = document.getElementById('tgStatusBadge');
    if (d.running) {
      badge.textContent = d.botName ? '● @' + d.botName : '● running';
      badge.className = 'status-badge status-active';
    } else {
      badge.textContent = '● stopped';
      badge.className = 'status-badge status-stopped';
    }
  } catch {}
}

async function loadTgConfig(){
  try {
    const d = await getJSON('/api/telegram/config');
    if (d.token) document.getElementById('tgTokenInput').value = d.token;
    const ids = d.allowedChatIds && d.allowedChatIds.length ? d.allowedChatIds : [];
    document.getElementById('tgAllowedIds').value = ids.join(', ');
    const contactNames = d.contactNames || {};
    const listEl = document.getElementById('tgContactNamesList');
    listEl.innerHTML = '';
    if (ids.length) {
      const title = document.createElement('label');
      title.style.cssText = 'display:block;margin-bottom:6px;font-size:12px;color:var(--text-2);';
      title.textContent = 'Contact names (optional)';
      listEl.appendChild(title);
      ids.forEach(id => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;';
        const span = document.createElement('span');
        span.style.cssText = 'font-size:12px;color:var(--text-3);min-width:100px;';
        span.textContent = id;
        const input = document.createElement('input');
        input.id = 'tgContact-' + id;
        input.placeholder = 'e.g. Jeff';
        input.value = contactNames[String(id)] || '';
        input.style.flex = '1';
        row.appendChild(span);
        row.appendChild(input);
        listEl.appendChild(row);
      });
    }
  } catch {}
}

async function saveTgConfig(){
  const token = document.getElementById('tgTokenInput').value.trim();
  const idsRaw = document.getElementById('tgAllowedIds').value.trim();
  const allowedChatIds = idsRaw
    ? idsRaw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
    : [];
  if (!token) { showNotification('Enter a bot token first', true); return; }
  const contactNames = {};
  allowedChatIds.forEach(id => {
    const el = document.getElementById('tgContact-' + id);
    if (el && el.value.trim()) contactNames[String(id)] = el.value.trim();
  });
  await postJSON('/api/telegram/config', { token, targetAgent: 'crew-lead', allowedChatIds, contactNames });
  showNotification('Config saved');
  loadTgConfig(); // refresh contact names list
}

async function startTgBridge(){
  const token = document.getElementById('tgTokenInput').value.trim();
  const body = { targetAgent: 'crew-lead' };
  if (token) body.token = token;
  const r = await postJSON('/api/telegram/start', body);
  if (r && r.error) { showNotification(r.error, true); return; }
  showNotification(r && r.message === 'Already running' ? 'Already running' : 'Telegram bridge starting...');
  setTimeout(loadTgStatus, 2000);
}

async function stopTgBridge(){
  await postJSON('/api/telegram/stop', {});
  showNotification('Telegram bridge stopped');
  setTimeout(loadTgStatus, 1000);
}

// ── WhatsApp settings ──────────────────────────────────────────────────────────

async function loadWaStatus(){
  try {
    const d = await getJSON('/api/whatsapp/status');
    const badge = document.getElementById('waStatusBadge');
    if (!badge) return;
    if (d.running) {
      badge.textContent = d.number ? '● +' + d.number : '● running';
      badge.className = 'status-badge status-active';
    } else {
      badge.textContent = '● stopped';
      badge.className = 'status-badge status-stopped';
    }
    const authEl = document.getElementById('waAuthStatus');
    if (authEl) authEl.textContent = d.authSaved
      ? '✅ Auth saved — no QR scan needed on restart'
      : '⚠️ No auth saved — run npm run whatsapp in terminal to scan QR';
  } catch {}
}

let _waSavedContactNames = {};

function renderWaContactRows(){
  const listEl = document.getElementById('waContactNamesList');
  if (!listEl) return;
  const raw = (document.getElementById('waAllowedNumbers')?.value || '').trim();
  const numbers = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
  listEl.innerHTML = '';
  if (!numbers.length) return;
  const title = document.createElement('label');
  title.style.cssText = 'display:block;margin-bottom:6px;font-size:12px;color:var(--text-2);';
  title.textContent = 'Contact names (address book)';
  listEl.appendChild(title);
  numbers.forEach(num => {
    const key = num.replace(/\D/g, '');
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;';
    const span = document.createElement('span');
    span.style.cssText = 'font-size:12px;color:var(--text-3);min-width:120px;font-family:monospace;';
    span.textContent = num;
    const input = document.createElement('input');
    input.id = 'waContact-' + key;
    input.placeholder = 'e.g. Jeff';
    input.value = _waSavedContactNames[key] || _waSavedContactNames[num] || '';
    input.style.flex = '1';
    row.appendChild(span);
    row.appendChild(input);
    listEl.appendChild(row);
  });
}

async function loadWaConfig(){
  try {
    const d = await getJSON('/api/whatsapp/config');
    const n = document.getElementById('waAllowedNumbers');
    const t = document.getElementById('waTargetAgent');
    _waSavedContactNames = d.contactNames || {};
    if (n) n.value = (d.allowedNumbers || []).join(', ');
    if (t) t.value = d.targetAgent || 'crew-lead';
    renderWaContactRows();
  } catch {}
}

async function saveWaConfig(){
  const numbersRaw = document.getElementById('waAllowedNumbers').value.trim();
  const allowedNumbers = numbersRaw ? numbersRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const targetAgent = (document.getElementById('waTargetAgent').value.trim()) || 'crew-lead';
  const contactNames = {};
  allowedNumbers.forEach(num => {
    const key = num.replace(/\D/g, '');
    const el = document.getElementById('waContact-' + key);
    if (el && el.value.trim()) contactNames[key] = el.value.trim();
  });
  _waSavedContactNames = contactNames;
  await postJSON('/api/whatsapp/config', { allowedNumbers, targetAgent, contactNames });
  showNotification('WhatsApp config saved');
  renderWaContactRows();
}

async function startWaBridge(){
  const r = await postJSON('/api/whatsapp/start', {});
  if (r && r.error) { showNotification(r.error, true); return; }
  showNotification(r && r.message === 'Already running' ? 'Already running' : 'WhatsApp bridge starting…');
  setTimeout(loadWaStatus, 2000);
}

async function stopWaBridge(){
  await postJSON('/api/whatsapp/stop', {});
  showNotification('WhatsApp bridge stopped');
  setTimeout(loadWaStatus, 1000);
}

async function loadWaMessages(){
  const feed = document.getElementById('waMessageFeed');
  if (!feed) return;
  try {
    const msgs = await getJSON('/api/whatsapp/messages');
    if (!msgs.length) {
      feed.innerHTML = '<div class="meta" style="padding:20px;text-align:center;">No messages yet. Send a WhatsApp message to your linked number.</div>';
      return;
    }
    feed.innerHTML = msgs.slice(-50).reverse().map(m => {
      const isIn = m.direction === 'inbound';
      const time = m.ts ? new Date(m.ts).toLocaleTimeString() : '';
      const number = (m.jid || '').split('@')[0] || '';
      return '<div style="display:flex;gap:10px;padding:8px;background:var(--bg-2);border-radius:6px;align-items:flex-start;">' +
        '<span style="font-size:18px;">' + (isIn ? '📲' : '🤖') + '</span>' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-size:11px;color:var(--text-3);margin-bottom:2px;">' +
            escHtml(isIn ? ('+' + number) : 'CrewSwarm') + (time ? ' · ' + time : '') +
          '</div>' +
          '<div style="font-size:13px;word-break:break-word;">' + escHtml((m.text||'').slice(0,300)) + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch(e) {
    feed.innerHTML = '<div style="color:var(--text-3);font-size:12px;padding:8px;">Could not load messages.</div>';
  }
}

let _servicesPollTimer = null;
function showServices(){
  hideAllViews();
  document.getElementById('servicesView').classList.add('active');
  setNavActive('navServices');
  loadServices();
  if (_servicesPollTimer) clearInterval(_servicesPollTimer);
  _servicesPollTimer = setInterval(() => {
    if (document.getElementById('servicesView').classList.contains('active')) loadServices();
    else { clearInterval(_servicesPollTimer); _servicesPollTimer = null; }
  }, 10000);
}

async function loadServices(){
  const grid = document.getElementById('servicesGrid');
  if (!grid) return;
  grid.innerHTML = '<div class="meta" style="padding:20px;">Checking services...</div>';
  try {
    const services = await getJSON('/api/services/status');
    const downCount = services.filter(s => !s.running).length;
    const badge = document.getElementById('servicesBadge');
    if (downCount > 0) {
      badge.textContent = downCount;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
    grid.innerHTML = services.map(svc => {
      const up = svc.running;
      const canRestart = svc.canRestart;
      const statusColor = up ? 'var(--green-hi)' : 'var(--red-hi)';
      const statusText  = up ? (svc.pid ? '● running  pid ' + svc.pid : '● running') : '● stopped';
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
          (canRestart && up   ? '<button class="btn-ghost" style="font-size:12px;" data-action="restartService" data-arg="' + svc.id + '">↻ Restart</button>' : '') +
          (canRestart && !up  ? '<button class="btn-green" style="font-size:12px;" data-action="restartService" data-arg="' + svc.id + '">▶ Start</button>' : '') +
          (canRestart && up   ? '<button class="btn-red" style="font-size:12px;" data-action="stopService" data-arg="' + svc.id + '">⏹ Stop</button>' : '') +
          (!canRestart        ? '<span style="font-size:11px;color:var(--text-3);align-self:center;">managed externally</span>' : '') +
        '</div>' +
      '</div>';
    }).join('');
  } catch(e) {
    grid.innerHTML = '<div class="meta" style="padding:20px;color:var(--red-hi);">Error loading services: ' + e.message + '</div>';
  }
}

function formatUptime(sec){
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.floor(sec/60) + 'm ' + (sec%60) + 's';
  return Math.floor(sec/3600) + 'h ' + Math.floor((sec%3600)/60) + 'm';
}

async function restartService(id){
  const r = await postJSON('/api/services/restart', { id });
  if (r && r.ok === false && r.message) {
    showNotification('⚠️ ' + r.message, 'warning');
  } else {
    showNotification('Restarting ' + id + '...');
    setTimeout(loadServices, 3000);
  }
}

async function stopService(id){
  const r = await postJSON('/api/services/stop', { id });
  if (r && r.ok === false && r.message) {
    showNotification('⚠️ ' + r.message, 'warning');
  } else {
    showNotification('Stopping ' + id + '...');
    setTimeout(loadServices, 1500);
  }
}

async function loadTgMessages(){
  const feed = document.getElementById('tgMessageFeed');
  if (!feed) return;
  try {
    const msgs = await getJSON('/api/telegram/messages');
    if (!msgs.length) {
      feed.innerHTML = '<div class="meta" style="padding:20px;text-align:center;">No messages yet. Send something to your bot on Telegram.</div>';
      return;
    }
    feed.innerHTML = msgs.slice(-50).reverse().map(m => {
      const isIn = m.direction === 'inbound';
      const time = m.ts ? new Date(m.ts).toLocaleTimeString() : '';
      const who  = isIn ? (m.firstName || m.username || 'User') : 'CrewSwarm';
      const icon = isIn ? '👤' : '⚡';
      return '<div class="card" style="padding:12px;gap:4px;display:flex;flex-direction:column;">' +
        '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-3);">' +
        '<span>' + icon + ' ' + escHtml(who) + (m.username ? ' @' + escHtml(m.username) : '') + '</span>' +
        '<span>' + time + '</span></div>' +
        '<div style="font-size:13px;white-space:pre-wrap;">' + escHtml(m.text || '') + '</div>' +
        '</div>';
    }).join('');
  } catch(e) {
    feed.innerHTML = '<div class="meta" style="padding:20px;color:var(--red-hi);">Error loading messages</div>';
  }
}
async function loadFiles(forceRefresh) {
  const el = document.getElementById('filesContent');
  const dir = document.getElementById('filesDir').value.trim() || window._crewCwd || (window._crewHome ? window._crewHome + '/Desktop/CrewSwarm' : '');
  el.innerHTML = '<div class="meta" style="padding:20px;">Scanning ' + dir + '...</div>';
  try {
    const data = await getJSON('/api/files?dir=' + encodeURIComponent(dir));
    if (!data.files || !data.files.length) {
      el.innerHTML = '<div class="meta" style="padding:20px;">No files found in ' + dir + '</div>';
      return;
    }
    const grouped = {};
    data.files.forEach(f => {
      const ext = f.path.split('.').pop().toLowerCase() || 'other';
      if (!grouped[ext]) grouped[ext] = [];
      grouped[ext].push(f);
    });
    const extOrder = ['html','css','js','mjs','ts','json','md','sh','txt','other'];
    const extEmoji = { html:'🌐', css:'🎨', js:'⚡', mjs:'⚡', ts:'🔷', json:'📋', md:'📝', sh:'🖥️', txt:'📄', other:'📁' };
    let html = '<div style="display:grid;gap:1rem;padding:4px 0;">';
    for (const ext of extOrder) {
      if (!grouped[ext]) continue;
      html += '<div>';
      html += '<div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;padding-left:2px;">' + (extEmoji[ext]||'📁') + ' .' + ext + ' — ' + grouped[ext].length + ' file' + (grouped[ext].length>1?'s':'') + '</div>';
      html += '<div style="display:grid;gap:6px;">';
      grouped[ext].sort((a,b) => b.mtime - a.mtime).forEach(f => {
        const rel = f.path.replace(dir + '/', '');
        const age = formatAge(f.mtime);
        const sz = formatSize(f.size);
        html += '<div class="file-row">';
        html += '<div class="file-info"><span class="file-name">' + rel + '</span><span class="file-meta">' + sz + ' · ' + age + '</span></div>';
        html += '<div class="file-actions">';
        html += '<a href="cursor://file/' + f.path + '" class="file-btn file-btn-cursor" title="Open in Cursor">Cursor</a>';
        html += '<a href="opencode://open?path=' + encodeURIComponent(f.path) + '" class="file-btn file-btn-opencode" title="Open in OpenCode">OpenCode</a>';
        html += '<button data-action="previewFile" data-arg=\'' + f.path.replace(/'/g,'&#39;') + '\' data-self="1" class="file-btn" title="Preview">👁</button>';
        html += '</div></div>';
      });
      html += '</div></div>';
    }
    html += '</div>';
    html += '<div id="file-preview-pane" style="display:none;margin-top:1rem;background:#0d1117;border:1px solid var(--border);border-radius:8px;overflow:hidden;"><div id="file-preview-bar" style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#0d1420;border-bottom:1px solid var(--border);font-size:12px;color:var(--text-2);"><span id="file-preview-name"></span><button data-action="closePreviewPane" style="margin-left:auto;background:none;border:none;color:var(--text-2);cursor:pointer;">✕</button></div><pre id="file-preview-content" style="margin:0;padding:1rem;font-size:0.75rem;overflow:auto;max-height:400px;"></pre></div>';
    el.innerHTML = html;
  } catch(e) {
    el.innerHTML = '<div class="meta" style="padding:20px;color:var(--red);">Error: ' + e.message + '</div>';
  }
}
async function previewFile(filePath, btn) {
  const pane = document.getElementById('file-preview-pane');
  const content = document.getElementById('file-preview-content');
  const name = document.getElementById('file-preview-name');
  if (!pane) return;
  name.textContent = filePath.split('/').pop();
  content.textContent = 'Loading...';
  pane.style.display = 'block';
  pane.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    const data = await getJSON('/api/file-content?path=' + encodeURIComponent(filePath));
    content.textContent = data.content || '(empty)';
  } catch(e) {
    content.textContent = 'Error: ' + e.message;
  }
}
function closePreviewPane() {
  const pane = document.getElementById('file-preview-pane');
  if (pane) pane.style.display = 'none';
}
function formatAge(mtime) {
  const diff = Date.now() - mtime;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h/24) + 'd ago';
}
function formatSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + 'KB';
  return (bytes/1024/1024).toFixed(1) + 'MB';
}
function showModels(){
  hideAllViews();
  document.getElementById('modelsView').classList.add('active');
  setNavActive('navModels');
  loadRTToken();
  loadBuiltinProviders(); // renders built-ins + custom providers in one unified list
  loadSearchTools();
}
// keep old name working for any legacy calls
function showProviders(){ showModels(); }

const BUILTIN_PROVIDERS = [
  { id:'groq',       label:'Groq',       icon:'⚡', url:'https://console.groq.com/keys',         hint:'Fast inference — great for crew-coder, crew-fixer' },
  { id:'anthropic',  label:'Anthropic',  icon:'🟣', url:'https://console.anthropic.com/',         hint:'Claude models — best for complex reasoning tasks' },
  { id:'openai',     label:'OpenAI (API)',     icon:'🟢', url:'https://platform.openai.com/api-keys',   hint:'GPT-4o and o-series — pay per use with API key' },
  { id:'perplexity', label:'Perplexity', icon:'🔍', url:'https://www.perplexity.ai/settings/api', hint:'Sonar Pro — ideal for crew-pm research tasks' },
  { id:'mistral',    label:'Mistral',    icon:'🌀', url:'https://console.mistral.ai/',            hint:'Open-weight models, efficient mid-tier tasks' },
  { id:'deepseek',   label:'DeepSeek',   icon:'🌊', url:'https://platform.deepseek.com/',         hint:'Low cost, strong coding performance' },
  { id:'xai',        label:'xAI (Grok)', icon:'𝕏',  url:'https://console.x.ai/',                 hint:'Grok models from xAI' },
  { id:'ollama',     label:'Ollama',     icon:'🏠', url:'https://ollama.com/download',            hint:'Local models — no API key needed, runs offline' },
  { id:'openai-local', label:'OpenAI (local)', icon:'🟢', url:'https://github.com/RayBytes/ChatMock', hint:'ChatMock — use ChatGPT Plus/Pro subscription. Run ChatMock server first (e.g. port 8000). Key ignored.' },
];

const SEARCH_TOOLS = [
  { id:'parallel', label:'Parallel',    icon:'🔬', url:'https://platform.parallel.ai/signup', hint:'Deep research & web synthesis — used by crew-pm for project planning', envKey:'PARALLEL_API_KEY' },
  { id:'brave',    label:'Brave Search', icon:'🦁', url:'https://api.search.brave.com/',       hint:'Fast web search (~700ms) — best for quick agent lookups',            envKey:'BRAVE_API_KEY'    },
];

async function loadSearchTools(){
  const list = document.getElementById('searchToolsList');
  let saved = {};
  try { saved = (await getJSON('/api/search-tools')).keys || {}; } catch {}
  list.innerHTML = SEARCH_TOOLS.map(p => {
    const hasKey = !!saved[p.id];
    const badge = hasKey
      ? `<span style="font-size:11px;padding:2px 8px;border-radius:999px;font-weight:600;background:rgba(52,211,153,0.15);color:var(--green);border:1px solid rgba(52,211,153,0.3);">set ✓</span>`
      : `<span style="font-size:11px;padding:2px 8px;border-radius:999px;font-weight:600;background:rgba(107,114,128,0.12);color:var(--text-2);border:1px solid var(--border);">no key</span>`;
    return `<div class="card" style="margin-bottom:8px;">
      <div style="display:flex;align-items:center;gap:10px;cursor:pointer;" data-toggle-child=".st-body">
        <span style="font-size:18px;width:24px;text-align:center;">${p.icon}</span>
        <div style="flex:1;">
          <div style="font-weight:600;font-size:13px;">${p.label}</div>
          <div style="font-size:11px;color:var(--text-2);">${p.hint}</div>
        </div>
        ${badge}
        <span style="color:var(--text-2);font-size:12px;">▾</span>
      </div>
      <div class="st-body" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">
        <div style="display:flex;gap:8px;">
          <input id="st_${p.id}" type="password" autocomplete="new-password" placeholder="${hasKey ? '••••••••••••••• (saved — paste to update)' : 'Paste API key'}" style="flex:1;" />
          <button data-action="saveSearchTool" data-arg="${p.id}" class="btn-purple">Save</button>
          <button data-action="testSearchTool" data-arg="${p.id}" class="btn-ghost">Test</button>
          <a href="${p.url}" target="_blank" class="btn-ghost" style="text-decoration:none;font-size:12px;">Keys ↗</a>
        </div>
        <div style="font-size:11px;color:var(--text-2);margin-top:6px;">Saved as <code style="background:rgba(255,255,255,0.06);padding:1px 5px;border-radius:4px;">${p.envKey}</code> in environment</div>
        <div id="st_status_${p.id}" style="font-size:12px;margin-top:8px;color:var(--text-2);"></div>
      </div>
    </div>`;
  }).join('');
}

async function saveSearchTool(toolId){
  const inp = document.getElementById('st_' + toolId);
  const key = inp?.value?.trim();
  if (!key) { showNotification('Paste an API key first', 'error'); return; }
  try {
    await postJSON('/api/search-tools/save', { toolId, key });
    showNotification('Key saved', 'success');
    loadSearchTools();
  } catch(e) { showNotification('Save failed: ' + e.message, 'error'); }
}

async function testSearchTool(toolId){
  const statusEl = document.getElementById('st_status_' + toolId);
  statusEl.textContent = 'Testing…';
  try {
    const r = await postJSON('/api/search-tools/test', { toolId });
    statusEl.style.color = r.ok ? 'var(--green)' : 'var(--red)';
    statusEl.textContent = r.ok ? '✓ ' + (r.message || 'Connected') : '✗ ' + (r.error || 'Failed');
  } catch(e) { statusEl.style.color='var(--red)'; statusEl.textContent = '✗ ' + e.message; }
}

async function loadBuiltinProviders(){
  const list = document.getElementById('builtinProvidersList');
  let saved = {};
  try { saved = (await getJSON('/api/providers/builtin')).keys || {}; } catch {}
  const builtinIds = new Set(BUILTIN_PROVIDERS.map(p => p.id));

  // ── Render built-in provider cards ─────────────────────────────────────────
  let html = BUILTIN_PROVIDERS.map(p => {
    const hasKey = !!saved[p.id];
    const isOllama = p.id === 'ollama';
    const isOpenAiLocal = p.id === 'openai-local';
    const badge = hasKey || isOllama || isOpenAiLocal
      ? `<span style="font-size:11px;padding:2px 8px;border-radius:999px;font-weight:600;background:rgba(52,211,153,0.15);color:var(--green);border:1px solid rgba(52,211,153,0.3);">${(isOllama || isOpenAiLocal) && !hasKey ? 'local' : 'set ✓'}</span>`
      : `<span style="font-size:11px;padding:2px 8px;border-radius:999px;font-weight:600;background:rgba(107,114,128,0.12);color:var(--text-2);border:1px solid var(--border);">no key</span>`;
    return `<div class="card" style="margin-bottom:8px;">
      <div style="display:flex;align-items:center;gap:10px;cursor:pointer;" data-toggle-child=".bp-body">
        <span style="font-size:18px;width:24px;text-align:center;">${p.icon}</span>
        <div style="flex:1;">
          <div style="font-weight:600;font-size:13px;">${p.label}</div>
          <div style="font-size:11px;color:var(--text-2);">${p.hint}</div>
        </div>
        ${badge}
        <span style="color:var(--text-2);font-size:12px;">▾</span>
      </div>
      <div class="bp-body" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">
        ${isOllama ? `<div style="font-size:12px;color:var(--text-2);margin-bottom:8px;">Ollama runs locally — no API key required. Make sure Ollama is running on port 11434.</div>` : ''}
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          ${isOllama ? '' : `<input id="bp_${p.id}" type="password" autocomplete="new-password" placeholder="${hasKey ? '••••••••••••••• (saved — paste to update)' : 'Paste API key'}" style="flex:1;min-width:180px;" />`}
          ${isOllama
            ? `<button data-action="testBuiltinProvider" data-arg="${p.id}" class="btn-ghost">Test Connection</button>
               <button data-action="fetchBuiltinModels" data-arg="${p.id}" data-self="1" class="btn-ghost" style="background:#0f766e20;color:var(--green);border-color:#0f766e40;">↻ Models</button>`
            : `<button data-action="saveBuiltinKey" data-arg="${p.id}" class="btn-purple">Save</button>
               <button data-action="testBuiltinProvider" data-arg="${p.id}" class="btn-ghost">Test</button>
               <button data-action="fetchBuiltinModels" data-arg="${p.id}" data-self="1" class="btn-ghost" style="background:#0f766e20;color:var(--green);border-color:#0f766e40;">↻ Models</button>
               <a href="${p.url}" target="_blank" class="btn-ghost" style="text-decoration:none;font-size:12px;">Keys ↗</a>`}
        </div>
        <div id="bp_status_${p.id}" style="font-size:12px;margin-top:8px;color:var(--text-2);"></div>
        <div id="bp_models_${p.id}" style="margin-top:8px;display:none;">
          <span style="font-size:11px;color:var(--text-2);display:block;margin-bottom:4px;">Models (<span id="bp_mcount_${p.id}">0</span>):</span>
          <span id="bp_mtags_${p.id}"></span>
        </div>
      </div>
    </div>`;
  }).join('');

  // ── Append any custom (non-built-in) providers from crewswarm.json ─────────
  try {
    const data = await getJSON('/api/providers');
    const customs = (data.providers || []).filter(p => !builtinIds.has(p.id));
    if (customs.length) {
      html += `<div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:0.08em;margin:14px 0 8px;padding:0 2px;">Custom Providers</div>`;
      html += customs.map(p => {
        const icon = PROVIDER_ICONS[p.id] || '🔌';
        const hasKey = p.hasKey;
        const badge = hasKey
          ? `<span style="font-size:11px;padding:2px 8px;border-radius:999px;font-weight:600;background:rgba(52,211,153,0.15);color:var(--green);border:1px solid rgba(52,211,153,0.3);">key set ✓</span>`
          : `<span style="font-size:11px;padding:2px 8px;border-radius:999px;font-weight:600;background:rgba(107,114,128,0.12);color:var(--text-2);border:1px solid var(--border);">no key</span>`;
        const modelCount = p.models?.length || 0;
        return `<div class="card" style="margin-bottom:8px;">
          <div style="display:flex;align-items:center;gap:10px;cursor:pointer;" data-toggle-child=".cp-body">
            <span style="font-size:18px;width:24px;text-align:center;">${icon}</span>
            <div style="flex:1;">
              <div style="font-weight:600;font-size:13px;">${p.id}</div>
              <div style="font-size:11px;color:var(--text-2);">${p.baseUrl}${modelCount ? ' · ' + modelCount + ' models' : ''}</div>
            </div>
            ${badge}
            <span style="color:var(--text-2);font-size:12px;">▾</span>
          </div>
          <div class="cp-body" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <input id="key_${p.id}" type="password" autocomplete="new-password" placeholder="${hasKey ? '••••••••••••••• (saved — paste to update)' : 'Paste API key'}" style="flex:1;min-width:180px;" />
              <button data-action="saveKey" data-arg="${p.id}" class="btn-purple">Save</button>
              <button data-action="testKey" data-arg="${p.id}" class="btn-ghost">Test</button>
              <button data-action="fetchModels" data-arg="${p.id}" data-self="1" class="btn-ghost" style="background:#0f766e20;color:var(--green);border-color:#0f766e40;">↻ Models</button>
            </div>
            <div style="font-size:11px;color:var(--text-2);margin-top:6px;">Base URL: <code style="font-size:10px;">${p.baseUrl}</code></div>
            <div id="test_${p.id}" style="font-size:12px;margin-top:8px;color:var(--text-2);"></div>
            <div id="mwrap_${p.id}" style="margin-top:8px;${modelCount ? '' : 'display:none;'}">
              <span style="font-size:11px;color:var(--text-2);">Models (<span id="mcount_${p.id}">${modelCount}</span>):</span>
              <span id="mtags_${p.id}">${(p.models||[]).map(m => '<span class="model-tag">' + (m.id||m) + '</span>').join('')}</span>
            </div>
          </div>
        </div>`;
      }).join('');
    }
  } catch {}

  list.innerHTML = html;
}

async function saveBuiltinKey(providerId){
  const inp = document.getElementById('bp_' + providerId);
  const key = inp?.value?.trim();
  if (!key && providerId !== 'openai-local') { showNotification('Paste an API key first', 'error'); return; }
  await postJSON('/api/providers/builtin/save', { providerId, apiKey: key || '' });
  inp.value = '';
  showNotification('Key saved — fetching models…');
  // Await so the re-rendered card DOM exists before we write into it
  await loadBuiltinProviders();
  // Auto-fetch models so the agent model dropdown populates immediately
  try {
    const r = await postJSON('/api/providers/fetch-models', { providerId });
    if (r.ok) {
      const tags   = document.getElementById('bp_mtags_'  + providerId);
      const count  = document.getElementById('bp_mcount_' + providerId);
      const wrap   = document.getElementById('bp_models_' + providerId);
      const status = document.getElementById('bp_status_' + providerId);
      if (tags)   tags.innerHTML = r.models.map(m => '<span class="model-tag">' + m + '</span>').join('');
      if (count)  count.textContent = r.models.length;
      if (wrap)   wrap.style.display = 'block';
      if (status) { status.style.color = 'var(--green)'; status.textContent = '✓ ' + r.models.length + ' models'; }
      showNotification('Key saved for ' + providerId + ' — ' + r.models.length + ' models ready');
      loadAgents(); // refresh model dropdowns on the Agents tab
    } else {
      showNotification('Key saved — could not fetch models: ' + (r.error || 'unknown'), 'warning');
    }
  } catch(e) {
    showNotification('Key saved — model fetch failed: ' + e.message, 'warning');
  }
}

async function testBuiltinProvider(providerId){
  const statusEl = document.getElementById('bp_status_' + providerId);
  statusEl.textContent = 'Testing…';
  try {
    const r = await postJSON('/api/providers/builtin/test', { providerId });
    statusEl.style.color = r.ok ? 'var(--green)' : 'var(--red)';
    statusEl.textContent = r.ok ? '✓ Connected — ' + (r.model || 'OK') : '✗ ' + (r.error || 'Failed');
  } catch(e) { statusEl.style.color='var(--red)'; statusEl.textContent = '✗ ' + e.message; }
}

async function fetchBuiltinModels(providerId, btn){
  const statusEl = document.getElementById('bp_status_' + providerId);
  const orig = btn.textContent;
  btn.textContent = 'Fetching…';
  btn.disabled = true;
  statusEl.textContent = '';
  try {
    const r = await postJSON('/api/providers/fetch-models', { providerId });
    if (r.ok) {
      const tags  = document.getElementById('bp_mtags_' + providerId);
      const count = document.getElementById('bp_mcount_' + providerId);
      const wrap  = document.getElementById('bp_models_' + providerId);
      if (tags)  tags.innerHTML  = r.models.map(m => '<span class="model-tag">' + m + '</span>').join('');
      if (count) count.textContent = r.models.length;
      if (wrap)  wrap.style.display = 'block';
      statusEl.style.color = 'var(--green)';
      statusEl.textContent = '✓ ' + r.models.length + ' models fetched' + (r.note ? ' — ' + r.note : '');
      loadAgents();
    } else {
      statusEl.style.color = 'var(--red)';
      statusEl.textContent = '✗ ' + (r.error || 'Failed');
    }
  } catch(e) { statusEl.style.color='var(--red)'; statusEl.textContent = '✗ ' + e.message; }
  finally { btn.textContent = orig; btn.disabled = false; }
}

async function loadOpenClawStatus(){
  const badge = document.getElementById('oclawBadge');
  try {
    const d = await getJSON('/api/settings/openclaw-status');
    if (d.installed) {
      badge.textContent = '● installed';
      badge.style.background = 'rgba(52,211,153,0.15)';
      badge.style.color = 'var(--green)';
      badge.style.borderColor = 'rgba(52,211,153,0.3)';
    } else {
      badge.textContent = '○ not detected';
      badge.style.background = 'rgba(107,114,128,0.12)';
      badge.style.color = 'var(--text-2)';
      badge.style.borderColor = 'var(--border)';
    }
  } catch { badge.textContent = '? unknown'; }
}
async function loadRTToken(){
  try {
    const d = await getJSON('/api/settings/rt-token');
    const badge = document.getElementById('rtTokenBadge');
    const inp   = document.getElementById('rtTokenInput');
    if (d.token) {
      badge.textContent = 'set ✓';
      badge.style.background = 'rgba(52,211,153,0.15)';
      badge.style.color = 'var(--green)';
      badge.style.borderColor = 'rgba(52,211,153,0.3)';
      inp.placeholder = '••••••••••••••••••••••• (saved)';
    } else {
      badge.textContent = 'not set';
      badge.style.background = 'rgba(251,191,36,0.15)';
      badge.style.color = 'var(--yellow)';
      badge.style.borderColor = 'rgba(251,191,36,0.3)';
    }
  } catch {}
}
async function saveRTToken(){
  const token = document.getElementById('rtTokenInput').value.trim();
  if (!token) { showNotification('Paste a token first', 'error'); return; }
  try {
    await postJSON('/api/settings/rt-token', { token });
    showNotification('RT Bus token saved');
    document.getElementById('rtTokenInput').value = '';
    loadRTToken();
  } catch(e) { showNotification('Save failed: ' + e.message, 'error'); }
}
async function loadOpencodeProject(){
  try {
    const d = await getJSON('/api/settings/opencode-project');
    const inp = document.getElementById('opencodeProjInput');
    const st  = document.getElementById('opencodeProjStatus');
    if (inp) { inp.placeholder = d.dir || 'e.g. /Users/you/Desktop/myproject'; inp.value = d.dir || ''; }
    if (st) st.textContent = d.dir ? ('✅ Current: ' + d.dir) : '⚠️ Not set — OpenCode will write files to the CrewSwarm repo root. Set this to your project folder.';
    const fbSel = document.getElementById('opencodeFallbackSelect');
    const fbSt  = document.getElementById('opencodeFallbackStatus');
    if (fbSel) {
      if (_allModels.length === 0) {
        const ac = await getJSON('/api/agents-config');
        _allModels = ac.allModels || [];
        _modelsByProvider = ac.modelsByProvider || {};
      }
      populateModelDropdown('opencodeFallbackSelect', d.fallbackModel || '');
    }
    if (fbSt) fbSt.textContent = d.fallbackModel ? ('✅ Fallback: ' + d.fallbackModel) : '⚠️ Using default groq/kimi-k2-instruct-0905';
  } catch {}
}
async function saveOpencodeSettings(){
  const dir = (document.getElementById('opencodeProjInput')?.value || '').trim();
  const fallbackModel = (document.getElementById('opencodeFallbackSelect')?.value || '').trim();
  try {
    await postJSON('/api/settings/opencode-project', { dir: dir || undefined, fallbackModel: fallbackModel || undefined });
    showNotification('OpenCode settings saved — fallback takes effect on next task (no restart needed)');
    loadOpencodeProject();
  } catch(e) { showNotification('Save failed: ' + e.message, 'error'); }
}
async function loadBgConsciousness() {
  const btn = document.getElementById('bgConsciousnessBtn');
  const status = document.getElementById('bgConsciousnessStatus');
  const modelInput = document.getElementById('bgConsciousnessModel');
  try {
    const d = await getJSON('/api/settings/bg-consciousness');
    const on = d.enabled;
    if (btn) {
      btn.textContent = on ? '🟢 ON' : '⚫ OFF';
      btn.style.background = on ? 'rgba(34,197,94,0.15)' : 'var(--surface-2)';
      btn.style.borderColor = on ? 'var(--green-hi)' : 'var(--border)';
      btn.style.color = on ? 'var(--green-hi)' : 'var(--text-2)';
    }
    if (modelInput && d.model) modelInput.placeholder = d.model;
    if (status) status.textContent = on
      ? 'Active — crew-lead reflects every ' + Math.round(d.intervalMs / 60000) + 'min when idle. Model: ' + d.model
      : 'Off — crew-lead will not self-reflect between tasks.';
  } catch(e) {
    if (btn) btn.textContent = 'Error';
    if (status) status.textContent = 'Could not load: ' + e.message;
  }
}
async function toggleBgConsciousness() {
  try {
    const current = await getJSON('/api/settings/bg-consciousness');
    const d = await postJSON('/api/settings/bg-consciousness', { enabled: !current.enabled });
    showNotification('Background consciousness ' + (d.enabled ? 'ENABLED' : 'DISABLED'));
    loadBgConsciousness();
  } catch(e) { showNotification('Failed: ' + e.message, 'error'); }
}
async function saveBgConsciousnessModel() {
  const modelInput = document.getElementById('bgConsciousnessModel');
  const model = (modelInput?.value || '').trim();
  if (!model) { showNotification('Enter a model first (e.g. groq/llama-3.3-70b-versatile)', 'error'); return; }
  try {
    await postJSON('/api/settings/bg-consciousness', { model });
    showNotification('Background consciousness model → ' + model);
    modelInput.value = '';
    loadBgConsciousness();
  } catch(e) { showNotification('Failed: ' + e.message, 'error'); }
}
async function loadCursorWaves() {
  const btn = document.getElementById('cursorWavesBtn');
  const status = document.getElementById('cursorWavesStatus');
  try {
    const d = await getJSON('/api/settings/cursor-waves');
    const on = d.enabled;
    if (btn) {
      btn.textContent = on ? '⚡ ON' : '⚫ OFF';
      btn.style.background = on ? 'rgba(168,85,247,0.15)' : 'var(--surface-2)';
      btn.style.borderColor = on ? '#a855f7' : 'var(--border)';
      btn.style.color = on ? '#c084fc' : 'var(--text-2)';
    }
    if (status) status.textContent = on
      ? 'Active — multi-agent waves fan out to Cursor subagents in parallel. crew-orchestrator coordinates each wave.'
      : 'Off — each agent in a wave dispatches independently through the standard gateway.';
  } catch(e) {
    if (btn) btn.textContent = 'Error';
    if (status) status.textContent = 'Could not load: ' + e.message;
  }
}
async function toggleCursorWaves() {
  try {
    const current = await getJSON('/api/settings/cursor-waves');
    const d = await postJSON('/api/settings/cursor-waves', { enabled: !current.enabled });
    showNotification('Cursor Parallel Waves ' + (d.enabled ? 'ENABLED ⚡' : 'DISABLED'));
    loadCursorWaves();
  } catch(e) { showNotification('Failed: ' + e.message, 'error'); }
}
async function loadClaudeCode() {
  const btn = document.getElementById('claudeCodeBtn');
  const status = document.getElementById('claudeCodeStatus');
  try {
    const d = await getJSON('/api/settings/claude-code');
    const on = d.enabled;
    if (btn) {
      btn.textContent = on ? '🤖 ON' : '⚫ OFF';
      btn.style.background = on ? 'rgba(245,158,11,0.15)' : 'var(--surface-2)';
      btn.style.borderColor = on ? 'var(--amber)' : 'var(--border)';
      btn.style.color = on ? 'var(--yellow)' : 'var(--text-2)';
    }
    if (status) {
      if (!d.hasKey) {
        status.textContent = '⚠️ ANTHROPIC_API_KEY not set — add it to ~/.crewswarm/crewswarm.json under providers.anthropic.apiKey or set the env var.';
        status.style.color = 'var(--amber)';
      } else {
        status.textContent = on
          ? 'Active — tasks route through Claude Code CLI. Per-agent override: set useClaudeCode: true in crewswarm.json.'
          : 'Off — tasks use direct LLM or OpenCode. Enable to run agents through Claude Code CLI.';
        status.style.color = 'var(--text-3)';
      }
    }
  } catch(e) {
    if (btn) btn.textContent = 'Error';
    if (status) status.textContent = 'Could not load: ' + e.message;
  }
}
async function loadCodexExecutor() {
  const btn = document.getElementById('codexBtn');
  const status = document.getElementById('codexStatus');
  try {
    const d = await getJSON('/api/settings/codex');
    const on = d.enabled;
    if (btn) {
      btn.textContent = on ? '🟣 ON' : '⚫ OFF';
      btn.style.background = on ? 'rgba(168,85,247,0.15)' : 'var(--surface-2)';
      btn.style.borderColor = on ? '#a855f7' : 'var(--border)';
      btn.style.color = on ? '#a855f7' : 'var(--text-2)';
    }
    if (status) {
      status.textContent = on
        ? 'Active — tasks route through Codex CLI. Per-agent override: set useCodex: true in crewswarm.json.'
        : 'Off — tasks use direct LLM or other engine. Enable to route all coding agents through Codex CLI.';
      status.style.color = 'var(--text-3)';
    }
  } catch(e) {
    if (btn) btn.textContent = 'Error';
    if (status) { status.textContent = 'Could not load: ' + e.message; status.style.color = 'var(--text-3)'; }
  }
}
async function toggleCodexExecutor() {
  try {
    const current = await getJSON('/api/settings/codex');
    const d = await postJSON('/api/settings/codex', { enabled: !current.enabled });
    showNotification('Codex CLI executor ' + (d.enabled ? 'ENABLED 🟣' : 'DISABLED'));
    loadCodexExecutor();
  } catch(e) { showNotification('Failed: ' + e.message, 'error'); }
}
async function toggleClaudeCode() {
  try {
    const current = await getJSON('/api/settings/claude-code');
    if (!current.hasKey) {
      showNotification('Set ANTHROPIC_API_KEY first — add it in ~/.crewswarm/crewswarm.json under providers.anthropic.apiKey', 'error');
      return;
    }
    const d = await postJSON('/api/settings/claude-code', { enabled: !current.enabled });
    showNotification('Claude Code executor ' + (d.enabled ? 'ENABLED 🤖' : 'DISABLED'));
    loadClaudeCode();
  } catch(e) { showNotification('Failed: ' + e.message, 'error'); }
}
async function loadGlobalFallback() {
  try {
    const d = await getJSON('/api/settings/global-fallback');
    const el = document.getElementById('globalFallbackInput');
    if (el) el.value = d.globalFallbackModel || '';
    const status = document.getElementById('globalFallbackStatus');
    if (status) status.textContent = d.globalFallbackModel
      ? 'Active: any agent without a per-agent fallback will use ' + d.globalFallbackModel
      : 'Not set — agents without fallback will use the built-in default (groq/llama-3.3-70b-versatile).';
  } catch(e) { console.warn('loadGlobalFallback:', e.message); }
}
async function saveGlobalFallback() {
  const model = (document.getElementById('globalFallbackInput')?.value || '').trim();
  try {
    await postJSON('/api/settings/global-fallback', { globalFallbackModel: model });
    showNotification(model ? 'Global fallback → ' + model : 'Global fallback cleared');
    loadGlobalFallback();
  } catch(e) { showNotification('Failed: ' + e.message, 'error'); }
}
async function saveGlobalOcLoop() {
  const enabled = document.getElementById('globalOcLoop')?.checked;
  try {
    await postJSON('/api/settings/global-oc-loop', { enabled });
    showNotification('Global OC loop ' + (enabled ? 'enabled' : 'disabled'));
  } catch(e) { showNotification('Failed: ' + e.message, true); }
}
async function saveGlobalOcLoopRounds() {
  const rounds = parseInt(document.getElementById('globalOcLoopRounds')?.value) || 10;
  try {
    await postJSON('/api/settings/global-oc-loop', { maxRounds: rounds });
    showNotification('Max rounds set to ' + rounds);
  } catch(e) { showNotification('Failed: ' + e.message, true); }
}
async function loadGlobalOcLoop() {
  try {
    const d = await getJSON('/api/settings/global-oc-loop');
    const chk = document.getElementById('globalOcLoop');
    const inp = document.getElementById('globalOcLoopRounds');
    if (chk) chk.checked = d.enabled || false;
    if (inp) inp.value = d.maxRounds ?? 10;
  } catch(e) {}
}
async function loadPassthroughNotify() {
  try {
    const d = await getJSON('/api/settings/passthrough-notify');
    const sel = document.getElementById('passthroughNotifySelect');
    if (sel) sel.value = d.value || 'both';
  } catch(e) {}
}
async function savePassthroughNotify() {
  const value = document.getElementById('passthroughNotifySelect')?.value || 'both';
  const st = document.getElementById('passthroughNotifyStatus');
  try {
    await postJSON('/api/settings/passthrough-notify', { value });
    if (st) { st.textContent = '✓ Saved — takes effect on the next passthrough'; st.style.color = 'var(--green-hi)'; }
    showNotification('Passthrough notifications → ' + value);
  } catch(e) {
    if (st) { st.textContent = 'Error: ' + e.message; st.style.color = 'var(--red)'; }
  }
}

async function saveLoopBrain() {
  const model = (document.getElementById('loopBrainModel')?.value || '').trim();
  try {
    await postJSON('/api/settings/loop-brain', { loopBrain: model || null });
    showNotification(model ? `Loop brain → ${model}` : 'Loop brain cleared (each agent uses own model)');
  } catch(e) { showNotification('Failed: ' + e.message, true); }
}
window.saveLoopBrain = saveLoopBrain;

async function loadLoopBrain() {
  try {
    const d = await getJSON('/api/settings/loop-brain');
    const inp = document.getElementById('loopBrainModel');
    if (inp && d.loopBrain) inp.value = d.loopBrain;
  } catch {}
}

const ENV_GROUPS = [
  {
    label: 'Engine — OpenCode',
    vars: [
      { key: 'CREWSWARM_OPENCODE_ENABLED',          hint: 'Route coding agents through OpenCode globally',           default: 'off' },
      { key: 'CREWSWARM_OPENCODE_MODEL',            hint: 'Model passed to OpenCode — leave blank to use per-agent model', default: 'per-agent' },
      { key: 'CREWSWARM_OPENCODE_TIMEOUT_MS',       hint: 'ms before an OpenCode task is killed',                    default: '300000' },
      { key: 'CREWSWARM_OPENCODE_AGENT',            hint: 'Override agent name passed to OpenCode',                  default: 'auto' },
    ],
  },
  {
    label: 'Engine — Claude Code & Cursor',
    note: 'Both use OAuth login (run claude or cursor once). No API key required.',
    vars: [
      { key: 'CREWSWARM_CLAUDE_CODE_MODEL', hint: 'Model passed to claude -p — leave blank for Claude Code default', default: 'claude default' },
      { key: 'CREWSWARM_CURSOR_MODEL',      hint: 'Model passed to cursor --execute — leave blank for Cursor default', default: 'cursor default' },
    ],
  },
  {
    label: 'Engine — Docker Sandbox',
    note: 'Runs any inner engine inside an isolated Docker microVM. API keys injected by network proxy — never exposed to the agent.',
    vars: [
      { key: 'CREWSWARM_DOCKER_SANDBOX',              hint: 'Route all coding agents through Docker Sandbox globally', default: 'off' },
      { key: 'CREWSWARM_DOCKER_SANDBOX_NAME',         hint: 'Pre-created sandbox name (docker sandbox create --name crewswarm shell <dir>)', default: 'crewswarm' },
      { key: 'CREWSWARM_DOCKER_SANDBOX_INNER_ENGINE', hint: 'Engine inside the sandbox: claude, opencode, or codex',  default: 'claude' },
      { key: 'CREWSWARM_DOCKER_SANDBOX_TIMEOUT_MS',   hint: 'ms before a sandboxed task is killed',                   default: '300000' },
    ],
  },
  {
    label: 'Engine Loop & Dispatch',
    vars: [
      { key: 'CREWSWARM_ENGINE_LOOP',            hint: 'Enable Ouroboros engine loop for all agents (LLM ↔ engine until DONE)', default: 'off' },
      { key: 'CREWSWARM_ENGINE_LOOP_MAX_ROUNDS', hint: 'Max STEP iterations per loop run',                          default: '10' },
      { key: 'CREWSWARM_DISPATCH_TIMEOUT',         hint: 'ms before a dispatched task times out',                     default: '120000' },
      { key: 'CREWSWARM_RT_AGENT',                 hint: 'Agent ID used for the RT bus',                              default: 'crew-coder' },
    ],
  },
  {
    label: 'Ports',
    vars: [
      { key: 'CREW_LEAD_PORT',  hint: 'crew-lead HTTP server port',   default: '5010' },
      { key: 'SWARM_DASH_PORT', hint: 'Dashboard port',               default: '4319' },
      { key: 'WA_HTTP_PORT',    hint: 'WhatsApp bridge HTTP port',    default: '3000' },
    ],
  },
  {
    label: 'Background Consciousness',
    vars: [
      { key: 'CREWSWARM_BG_CONSCIOUSNESS',             hint: 'Enable idle reflection loop (crew-main reflects between tasks)', default: 'off' },
      { key: 'CREWSWARM_BG_CONSCIOUSNESS_INTERVAL_MS', hint: 'Idle reflection interval in ms',                                 default: '900000' },
      { key: 'CREWSWARM_BG_CONSCIOUSNESS_MODEL',       hint: 'Model for background cycle (e.g. groq/llama-3.1-8b-instant)',   default: 'groq/llama-3.1-8b-instant' },
    ],
  },
  {
    label: 'Messaging',
    vars: [
      { key: 'TELEGRAM_ALLOWED_USERNAMES', hint: 'Comma-separated Telegram usernames allowed to message the bot', default: 'all allowed' },
      { key: 'WA_ALLOWED_NUMBERS',         hint: 'Comma-separated WhatsApp numbers in intl format (+1555…)',     default: 'all allowed' },
    ],
  },
  {
    label: 'Memory',
    vars: [
      { key: 'SHARED_MEMORY_NAMESPACE', hint: 'Namespace prefix for shared memory keys', default: 'crewswarm' },
      { key: 'SHARED_MEMORY_DIR',       hint: 'Directory for shared memory files',       default: '~/.crewswarm/memory' },
    ],
  },
  {
    label: 'PM Loop',
    vars: [
      { key: 'PM_MAX_ITEMS',    hint: 'Max roadmap items per PM loop run',         default: '10' },
      { key: 'PM_USE_QA',       hint: 'Include crew-qa in PM pipeline',            default: 'off' },
      { key: 'PM_USE_SECURITY', hint: 'Include crew-security in PM pipeline',      default: 'off' },
    ],
  },
];

async function saveEnvVar(key, inputEl, statusEl) {
  const val = inputEl.value.trim();
  statusEl.textContent = 'Saving…';
  statusEl.style.color = 'var(--text-3)';
  try {
    const r = await fetch('/api/env-advanced', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: val || null }),
    });
    const d = await r.json();
    if (d.ok) {
      statusEl.textContent = val ? '✓ Saved' : '✓ Cleared';
      statusEl.style.color = 'var(--green)';
    } else {
      statusEl.textContent = 'Error: ' + (d.error || 'unknown');
      statusEl.style.color = 'var(--red, #f87171)';
    }
  } catch(e) {
    statusEl.textContent = 'Error: ' + e.message;
    statusEl.style.color = 'var(--red, #f87171)';
  }
  setTimeout(() => { statusEl.textContent = ''; }, 3000);
}

async function loadEnvAdvanced() {
  const box = document.getElementById('envAdvancedWidget');
  if (!box) return;
  try {
    const [envBasic, d] = await Promise.all([
      getJSON('/api/env').catch(() => ({})),
      getJSON('/api/env-advanced').catch(() => ({ env: {} })),
    ]);
    const env = d.env || {};

    // Runtime info row
    const uptime = envBasic.uptime != null
      ? (envBasic.uptime < 60 ? envBasic.uptime + 's' : Math.floor(envBasic.uptime / 60) + 'm')
      : '—';
    let html = `<div style="display:flex;gap:24px;flex-wrap:wrap;font-size:11px;color:var(--text-3);margin-bottom:16px;padding-bottom:10px;border-bottom:1px solid var(--border);">
      <span>cwd: <code style="color:var(--text-2);">${escHtml(envBasic.cwd || '—')}</code></span>
      <span>node: <code style="color:var(--text-2);">${escHtml(envBasic.node || '—')}</code></span>
      <span>uptime: <code style="color:var(--text-2);">${uptime}</code></span>
    </div>`;

    box.innerHTML = html;

    for (const group of ENV_GROUPS) {
      const section = document.createElement('div');
      section.style.cssText = 'margin-bottom:18px;';
      section.innerHTML = `<div style="font-size:11px;font-weight:700;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:${group.note ? '4px' : '8px'};">${escHtml(group.label)}</div>`
        + (group.note ? `<div style="font-size:11px;color:var(--accent);margin-bottom:8px;line-height:1.4;">${escHtml(group.note)}</div>` : '');

      for (const { key, hint, default: def } of group.vars) {
        const current = env[key] ?? '';
        const placeholder = def ? `default: ${def}` : 'not set';
        const row = document.createElement('div');
        row.style.cssText = 'margin-bottom:8px;';
        row.innerHTML = `
          <div style="display:flex;align-items:baseline;gap:6px;margin-bottom:3px;">
            <span style="font-size:11px;font-family:monospace;color:var(--accent);">${escHtml(key)}</span>
            ${!current && def ? `<span style="font-size:10px;color:var(--text-3);font-family:monospace;background:var(--bg-1);padding:1px 5px;border-radius:4px;border:1px solid var(--border);">${escHtml(def)}</span>` : ''}
          </div>
          <div style="font-size:10px;color:var(--text-3);margin-bottom:4px;">${escHtml(hint)}</div>
          <div style="display:flex;gap:6px;align-items:center;">
            <input data-env-key="${escHtml(key)}" type="text" value="${escHtml(current)}"
              placeholder="${escHtml(placeholder)}"
              style="flex:1;font-size:12px;font-family:monospace;padding:5px 8px;background:var(--bg-1);border:1px solid var(--border);border-radius:6px;color:${current ? 'var(--text-1)' : 'var(--text-3)'};" />
            <button data-env-save="${escHtml(key)}" style="font-size:11px;padding:5px 10px;border-radius:6px;cursor:pointer;border:1px solid var(--border);background:var(--surface-2);color:var(--text-2);white-space:nowrap;">Save</button>
            <span data-env-status="${escHtml(key)}" style="font-size:11px;min-width:50px;"></span>
          </div>`;
        section.appendChild(row);
      }
      box.appendChild(section);
    }

    // Wire up save buttons
    box.querySelectorAll('[data-env-save]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.envSave;
        const inputEl = box.querySelector(`[data-env-key="${key}"]`);
        const statusEl = box.querySelector(`[data-env-status="${key}"]`);
        if (inputEl && statusEl) saveEnvVar(key, inputEl, statusEl);
      });
    });
    // Style inputs on change
    box.querySelectorAll('[data-env-key]').forEach(inp => {
      inp.addEventListener('input', () => {
        inp.style.color = inp.value ? 'var(--text-1)' : 'var(--text-3)';
      });
    });
  } catch(e) {
    if (box) box.textContent = 'Could not load: ' + e.message;
  }
}
function showSettings(){
  hideAllViews();
  document.getElementById('settingsView').classList.add('active');
  setNavActive('navSettings');
  // Restore last active sub-tab from hash (e.g. #settings/telegram → telegram)
  const hashSubtab = (location.hash || '').replace('#settings/', '');
  // Support legacy deep-link aliases
  const TAB_ALIASES = { system: 'engines', telegram: 'comms', whatsapp: 'comms' };
  const knownTabs = ['usage','engines','comms','security','webhooks'];
  const resolved = TAB_ALIASES[hashSubtab] || hashSubtab;
  showSettingsTab(knownTabs.includes(resolved) ? resolved : 'usage');
}
function showSettingsTab(tab){
  const knownTabs = ['usage','engines','comms','security','webhooks'];
  knownTabs.forEach(t => {
    const panel = document.getElementById('stab-panel-' + t);
    const btn   = document.getElementById('stab-' + t);
    if (!panel || !btn) return;
    panel.style.display = t === tab ? (t === 'usage' ? 'grid' : 'block') : 'none';
    btn.classList.toggle('active', t === tab);
  });
  if (tab === 'usage')    { loadTokenUsage(); loadAllUsage(); }
  if (tab === 'engines')  { loadOpencodeProject(); loadBgConsciousness(); loadGlobalFallback(); loadCursorWaves(); loadClaudeCode(); loadCodexExecutor(); loadGlobalOcLoop(); loadLoopBrain(); loadPassthroughNotify(); }
  if (tab === 'comms')    { loadTgStatus(); loadTelegramSessions(); loadTgMessages(); loadTgConfig(); loadWaStatus(); loadWaConfig(); loadWaMessages(); }
  if (tab === 'security') { loadCmdAllowlist(); loadEnvAdvanced(); }
  if (tab === 'webhooks') { /* static */ }
  // Update URL hash for deep linking — e.g. #settings/telegram
  if (document.getElementById('settingsView')?.classList.contains('active')) {
    history.replaceState(null, '', '#settings/' + tab);
  }
}

// ── Engines ──────────────────────────────────────────────────────────────────
const ENGINE_ICONS = {
  opencode:       `<svg viewBox="0 0 24 30" width="20" height="24" fill="#38bdf8"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>`,
  cursor:         `<svg viewBox="0 0 24 24" width="20" height="20" fill="#818cf8"><path d="M4 4l8 16 3-7 7-3L4 4z"/></svg>`,
  claude:         `<svg viewBox="0 0 24 24" width="20" height="20" fill="#d4a853"><path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"/></svg>`,
  codex:          `<svg viewBox="0 0 24 24" width="20" height="20" fill="none"><circle cx="12" cy="12" r="10" stroke="#a78bfa" stroke-width="1.5"/><path d="M8 12l3 3 5-5" stroke="#a78bfa" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  "docker-sandbox": `<svg viewBox="0 0 24 24" width="20" height="20" fill="#2496ed"><path d="M13.983 11.078h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 00.186-.186V3.574a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m0 2.716h2.118a.187.187 0 00.186-.186V6.29a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.887c0 .102.082.186.185.186m-2.93 0h2.12a.186.186 0 00.184-.186V6.29a.185.185 0 00-.185-.185H8.1a.185.185 0 00-.185.185v1.887c0 .102.083.186.185.186m-2.943 0h2.119a.186.186 0 00.185-.186V6.29a.185.185 0 00-.185-.185H5.157a.185.185 0 00-.185.185v1.887c0 .102.083.186.185.186m8.763 2.714h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.185m-2.93 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 00-.75.748 11.376 11.376 0 00.692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137.983.003 1.963-.086 2.93-.266a12.248 12.248 0 003.823-1.389c.98-.567 1.86-1.288 2.61-2.136 1.252-1.418 1.998-2.997 2.553-4.4h.221c1.372 0 2.215-.549 2.68-1.009.309-.293.55-.65.707-1.046l.098-.288Z"/></svg>`,
};

function showEngines(){
  hideAllViews();
  document.getElementById('enginesView').classList.add('active');
  setNavActive('navEngines');
  loadEngines();
}

function toggleImportEngine(){
  const f = document.getElementById('importEngineForm');
  if (f) f.style.display = f.style.display === 'none' ? 'block' : 'none';
}

async function importEngineFromUrl(){
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

async function deleteEngine(id){
  if (!confirm(`Remove engine "${id}"?`)) return;
  await fetch(`/api/engines/${encodeURIComponent(id)}`, { method: 'DELETE' });
  loadEngines();
}

async function loadEngines(){
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
      const statusDot = eng.ready ? '🟢' : eng.installed ? '🟡' : '⚫';
      const statusLabel = eng.ready ? 'Ready' : eng.installed ? 'Installed — missing env vars' : 'Not installed';
      const statusColor = eng.ready ? 'var(--green)' : eng.installed ? 'var(--yellow,#fbbf24)' : 'var(--text-3)';
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
      `;
      grid.appendChild(card);
    }
  } catch(e) {
    grid.innerHTML = `<div style="color:var(--red,#f87171);font-size:13px;">Error: ${escHtml(e.message)}</div>`;
  }
}

function showSkills(){
  hideAllViews();
  document.getElementById('skillsView').classList.add('active');
  setNavActive('navSkills');
  loadSkills();
  loadPendingApprovals();
}

function showRunSkills(){
  hideAllViews();
  document.getElementById('runSkillsView').classList.add('active');
  setNavActive('navRunSkills');
  loadRunSkills();
}

function showBenchmarks(){
  hideAllViews();
  document.getElementById('benchmarksView').classList.add('active');
  setNavActive('navBenchmarks');
  loadBenchmarkOptions().then(() => {
    const sel = document.getElementById('benchmarkSelect');
    if (sel && sel.value) loadBenchmarkLeaderboard(sel.value);
  });
}

function showToolMatrix(){
  hideAllViews();
  document.getElementById('toolMatrixView').classList.add('active');
  setNavActive('navToolMatrix');
  loadToolMatrix();
}

// keep old name working for any legacy calls
function showIntegrations(){ showSkills(); }

// ── Run skills (from health snapshot) ───────────────────────────────────────────
async function loadRunSkills(){
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
        ? JSON.stringify(s.defaultParams, null, 2)
        : '{}';
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

async function runSkillFromUI(skillName){
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
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params })
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

// ── Task lifecycle (telemetry schema 1.1) ────────────────────────────────────────
window._telemetryEvents = window._telemetryEvents || [];
function renderTaskLifecycle(events) {
  const el = document.getElementById('taskLifecycleContainer');
  if (!el) return;
  events = events || [];
  if (!events.length) {
    el.innerHTML = '<div class="card" style="padding:12px;"><div class="meta" style="font-size:12px;">Recent task lifecycle (dispatched → completed/failed/cancelled). Dispatch a task to see events.</div></div>';
    return;
  }
  const rows = events.slice().reverse().slice(0, 15).map(ev => {
    const d = ev.data || {};
    const phase = d.phase || '';
    const color = phase === 'completed' ? 'var(--green)' : phase === 'failed' || phase === 'cancelled' ? 'var(--red)' : 'var(--accent)';
    const time = (ev.occurredAt || '').replace('T', ' ').slice(0, 19);
    return '<tr style="border-bottom:1px solid var(--border);"><td style="padding:6px 10px;font-size:11px;color:var(--text-3);">' + time + '</td><td style="padding:6px 10px;font-size:12px;"><span style="color:' + color + ';">' + phase + '</span></td><td style="padding:6px 10px;font-size:12px;">' + (d.agentId || '') + '</td><td style="padding:6px 10px;font-size:11px;color:var(--text-3);">' + (d.taskId || '').slice(0, 20) + '</td></tr>';
  }).join('');
  el.innerHTML = '<div class="card" style="overflow:auto;"><div style="font-size:12px;font-weight:600;padding:8px 12px;border-bottom:1px solid var(--border);">Task lifecycle (schema 1.1)</div><table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="border-bottom:1px solid var(--border);"><th style="text-align:left;padding:6px 10px;">Time</th><th style="text-align:left;padding:6px 10px;">Phase</th><th style="text-align:left;padding:6px 10px;">Agent</th><th style="text-align:left;padding:6px 10px;">Task ID</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

// ── Tool Matrix (agents × tools from health + restart) ───────────────────────────
const TOOL_LABELS = { read_file: 'read', write_file: 'write', mkdir: 'mkdir', run_cmd: 'run', dispatch: 'dispatch', skill: 'skill', define_skill: 'define_skill', git: 'git', telegram: 'tg', whatsapp: 'wa' };

async function loadToolMatrix(){
  const el = document.getElementById('toolMatrixContainer');
  if (!el) return;
  try {
    const res = await fetch('/api/health');
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.ok) {
      const msg = d.error || (res.status === 401 ? 'Unauthorized' : res.statusText || 'Request failed');
      el.innerHTML = '<div class="card" style="padding:16px;"><div style="color:var(--yellow);font-size:13px;font-weight:600;">Health check failed</div>' +
        '<div style="color:var(--text-2);font-size:12px;margin-top:8px;">' + (res.status === 401 ? 'RT token missing or invalid. Set it in Settings → System (RT token) or in ~/.crewswarm/config.json (rt.authToken).' : msg) + '</div>' +
        '<div style="color:var(--text-3);font-size:11px;margin-top:8px;">Ensure crew-lead is running on :5010 (Services tab).</div></div>';
      return;
    }
    renderTaskLifecycle(d.telemetry || []);
    window._telemetryEvents = d.telemetry || [];
    const bridgeAgents = (d.agents || []).filter(a => (a.id || '').toLowerCase() !== 'crew-lead');
    const crewLeadInfo = window._crewLeadInfo || { name: 'Crew Lead', emoji: '🧠' };
    const crewLeadRow = { id: 'crew-lead', name: crewLeadInfo.name, emoji: crewLeadInfo.emoji, tools: ['read_file', 'write_file', 'mkdir', 'run_cmd', 'web_search', 'web_fetch', 'skill', 'define_skill', 'dispatch', 'telegram', 'whatsapp'] };
    const agents = [crewLeadRow, ...bridgeAgents];
    const toolKeys = [...new Set(['define_skill', 'skill', ...agents.flatMap(a => Array.isArray(a.tools) ? a.tools : Object.keys(a.tools || {}))])].sort();
    const labels = toolKeys.map(t => TOOL_LABELS[t] || t);
    if (!agents.length) {
      el.innerHTML = '<div class="card" style="padding:16px;"><div style="color:var(--text-2);font-size:13px;">No agents in roster.</div>' +
        '<div style="color:var(--text-3);font-size:12px;margin-top:6px;">Add agents in Settings → Agents (or ~/.crewswarm/crewswarm.json), then start bridges from Services.</div></div>';
      return;
    }
    let html = '<div class="card" style="overflow:auto;"><table style="width:100%;border-collapse:collapse;font-size:12px;">'
      + '<thead><tr style="border-bottom:1px solid var(--border);">'
      + '<th style="text-align:left;padding:8px 12px;">Agent</th>';
    toolKeys.forEach((t, i) => { html += '<th style="text-align:center;padding:8px 8px;" title="' + (t || '') + '">' + (labels[i] || t) + '</th>'; });
    html += '<th style="text-align:right;padding:8px 12px;">Quick action</th></tr></thead><tbody>';
    agents.forEach(a => {
      const tools = Array.isArray(a.tools) ? a.tools : (a.tools ? Object.keys(a.tools).filter(k => a.tools[k]) : []);
      const name = (a.emoji || '') + ' ' + (a.name || a.id || '');
      html += '<tr style="border-bottom:1px solid var(--border);">';
      html += '<td style="padding:8px 12px;"><strong>' + (name || a.id).replace(/</g, '&lt;') + '</strong></td>';
      toolKeys.forEach(t => {
        const has = tools.includes(t);
        html += '<td style="text-align:center;padding:6px 8px;">' + (has ? '<span style="color:var(--green);" title="' + t + '">✓</span>' : '<span style="color:var(--text-3);">—</span>') + '</td>';
      });
      html += '<td style="text-align:right;padding:8px 12px;"><button class="btn-ghost" style="font-size:11px;" data-action="restartAgentFromUI" data-arg="' + (a.id || '').replace(/"/g, '&quot;') + '">Restart</button></td></tr>';
    });
    html += '</tbody></table></div>';
    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = '<div style="color:var(--red);font-size:12px;">Error loading health: ' + (e.message || '') + '</div>';
  }
}

async function restartAgentFromUI(agentId){
  if (!agentId) return;
  try {
    const r = await fetch('/api/agents/' + encodeURIComponent(agentId) + '/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const data = await r.json();
    if (data.ok) showNotification('Restarting ' + agentId + '…');
    else showNotification(data.error || 'Restart failed', 'error');
  } catch (e) { showNotification(e.message || 'Request failed', 'error'); }
}

// ── Skills ────────────────────────────────────────────────────────────────────
let _skillsCache = [];

async function loadSkills(){
  const el = document.getElementById('skillsList');
  try {
    const d = await (await fetch('/api/skills')).json();
    _skillsCache = d.skills || [];
    renderSkillsList(_skillsCache);
  } catch(e) { el.innerHTML = '<div style="color:var(--text-3);font-size:12px;">Error loading skills</div>'; }
}

function renderSkillsList(skills){
  const el = document.getElementById('skillsList');
  if (!skills.length) { el.innerHTML = '<div style="color:var(--text-3);font-size:12px;padding:8px 0;">No skills match. Add one above or copy JSONs to ~/.crewswarm/skills/</div>'; return; }
  el.innerHTML = skills.map(s => {
    const approvalBadge = s.requiresApproval ? '<span style="margin-left:8px;font-size:10px;background:rgba(251,191,36,0.15);color:var(--yellow);padding:2px 6px;border-radius:4px;">⚠️ approval</span>' : '';
    const urlNote = s.url ? ' · <code style="background:var(--bg-1);padding:1px 4px;border-radius:3px;">' + (s.method||'POST') + ' ' + (s.url||'').slice(0,60) + '</code>' : '';
    return '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--bg-2);border-radius:var(--radius);border:1px solid var(--border);">'
         + '<div><span style="font-weight:600;font-size:13px;">' + s.name + '</span>' + approvalBadge
         + '<div style="font-size:11px;color:var(--text-3);margin-top:3px;">' + (s.description||'') + urlNote + '</div></div>'
         + '<div style="display:flex;gap:6px;flex-shrink:0;">'
         + '<button class="btn-ghost" style="font-size:11px;" data-action="editSkill" data-arg="' + s.name + '">Edit</button>'
         + '<button class="btn-ghost" style="font-size:11px;color:var(--red);" data-action="deleteSkill" data-arg="' + s.name + '">Delete</button>'
         + '</div></div>';
  }).join('');
}

function filterSkills(q){
  const lower = q.toLowerCase();
  renderSkillsList(lower ? _skillsCache.filter(s =>
    (s.name||'').toLowerCase().includes(lower) ||
    (s.description||'').toLowerCase().includes(lower) ||
    (s.url||'').toLowerCase().includes(lower)
  ) : _skillsCache);
}

function editSkill(name){
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

function toggleAddSkill(){
  cancelSkillForm();
  document.getElementById('importSkillForm').style.display = 'none';
  const f = document.getElementById('addSkillForm');
  f.style.display = f.style.display === 'none' ? 'block' : 'none';
}

function toggleImportSkill(){
  cancelSkillForm();
  const f = document.getElementById('importSkillForm');
  f.style.display = f.style.display === 'none' ? 'block' : 'none';
  if (f.style.display !== 'none') setTimeout(() => document.getElementById('importSkillUrl').focus(), 50);
}

async function importSkillFromUrl(){
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
    // Show security warnings if any
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

function cancelSkillForm(){
  document.getElementById('skEditName').value = '';
  document.getElementById('addSkillFormTitle').textContent = 'New Skill';
  document.getElementById('saveSkillBtn').textContent = 'Save Skill';
  document.getElementById('addSkillForm').style.display = 'none';
  ['skName','skDesc','skUrl','skAuthKey','skAuthHeader','skDefaults'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  document.getElementById('skAuthType').value = '';
  document.getElementById('skRequiresApproval').checked = false;
  updateSkillAuthFields();
}
function updateSkillAuthFields(){
  const t = document.getElementById('skAuthType').value;
  document.getElementById('skAuthHeaderWrap').style.display = t === 'header' ? 'block' : 'none';
}
async function saveSkill(){
  const name = document.getElementById('skName').value.trim();
  const url  = document.getElementById('skUrl').value.trim();
  if (!name || !url) { alert('Skill name and URL are required'); return; }
  let defaultParams = {};
  try { const v = document.getElementById('skDefaults').value.trim(); if(v) defaultParams = JSON.parse(v); } catch { alert('Default Params must be valid JSON'); return; }
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
    // If renaming, delete old file first
    if (editingName && editingName !== name) {
      await fetch('/api/skills/' + editingName, { method: 'DELETE' });
    }
    const r = await fetch('/api/skills', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(await r.text());
    cancelSkillForm();
    loadSkills();
    showNotification(editingName ? 'Skill updated' : 'Skill saved');
  } catch(e) { showNotification('Failed: ' + e.message, 'error'); }
}
async function deleteSkill(name){
  if (!confirm('Delete skill "' + name + '"?')) return;
  try { const r = await fetch('/api/skills/' + name, { method: 'DELETE' }); if(!r.ok) throw new Error(await r.text()); loadSkills(); showNotification('Deleted'); }
  catch(e) { showNotification('Delete failed: ' + e.message, 'error'); }
}

// ── Spending ──────────────────────────────────────────────────────────────────
var _agentTotalCost = null;
var _ocTotalCost = null;
function updateGrandTotal() {
  var a = _agentTotalCost, o = _ocTotalCost;
  var aEl = document.getElementById('gtAgentCost');
  var oEl = document.getElementById('gtOcCost');
  var tEl = document.getElementById('gtTotal');
  if (!aEl) return;
  if (a !== null) aEl.textContent = '$' + a.toFixed(4);
  if (o !== null) oEl.textContent = '$' + o.toFixed(4);
  if (a !== null && o !== null) tEl.textContent = '$' + (a + o).toFixed(4);
}
async function loadAllUsage() {
  var days = parseInt(document.getElementById('grandTotalDays')?.value || '14');
  var ocSel = document.getElementById('ocStatsDays');
  var spSel = document.getElementById('spendingDays');
  if (ocSel) ocSel.value = String(days);
  if (spSel) spSel.value = String(days === 1 ? 1 : days);
  _agentTotalCost = null;
  _ocTotalCost = null;
  document.getElementById('gtAgentCost').textContent = '—';
  document.getElementById('gtOcCost').textContent = '—';
  document.getElementById('gtTotal').textContent = '—';
  loadSpending();
  loadOcStats();
}
async function loadSpending(){
  const el = document.getElementById('spendingWidget');
  const days = parseInt(document.getElementById('spendingDays')?.value || '1');
  try {
    if (days <= 1) {
      // Today: real-time from crew-lead
      const d = await (await fetch('/api/spending')).json();
      const { spending, caps } = d;
      const gTokens = spending.global?.tokens || 0;
      const gCost   = spending.global?.costUSD || 0;
      const gCapTok = caps.global?.dailyTokenLimit;
      const gCapCost = caps.global?.dailyCostLimitUSD;
      let out = '<div style="margin-bottom:10px;">'
              + '<div style="font-size:11px;font-weight:600;color:var(--text-2);margin-bottom:4px;text-transform:uppercase;letter-spacing:.06em;">Global &middot; ' + (spending.date||'today') + '</div>'
              + '<div style="display:flex;gap:20px;"><span>' + gTokens.toLocaleString() + ' tokens' + (gCapTok ? ' / ' + Number(gCapTok).toLocaleString() : '') + '</span>'
              + '<span style="color:var(--yellow);font-weight:600;">$' + gCost.toFixed(4) + '</span>' + (gCapCost ? '<span> / $' + gCapCost + '</span>' : '') + '</div>';
      if (gCapTok) {
        const pct = Math.min(100, (gTokens/gCapTok)*100);
        const barColor = pct > 80 ? 'var(--red)' : pct > 50 ? 'var(--yellow)' : 'var(--green)';
        out += '<div style="margin-top:4px;height:4px;background:var(--border);border-radius:2px;"><div style="width:' + pct + '%;height:100%;background:' + barColor + ';border-radius:2px;transition:width .3s;"></div></div>';
      }
      out += '</div>';
      const agents = Object.entries(spending.agents || {});
      if (agents.length) {
        out += '<div style="font-size:11px;font-weight:600;color:var(--text-2);margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em;">Per Agent</div>';
        out += agents.map(function(entry) {
          var id = entry[0], v = entry[1];
          const agentCap = caps.agents && caps.agents[id];
          const toks  = v.tokens || 0;
          const cost  = (v.costUSD||0).toFixed(4);
          const capTok = agentCap && agentCap.dailyTokenLimit;
          const pct    = capTok ? Math.min(100, (toks/capTok)*100) : null;
          let row = '<div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;">'
                  + '<span style="min-width:140px;font-size:12px;">' + id + '</span>'
                  + '<span style="font-size:12px;">' + toks.toLocaleString() + ' tok' + (capTok ? ' / ' + Number(capTok).toLocaleString() : '') + ' &middot; <span style="color:var(--yellow);">$' + cost + '</span></span>';
          if (pct !== null) {
            const barColor = pct > 80 ? 'var(--red)' : 'var(--accent)';
            row += '<div style="flex:1;height:3px;background:var(--border);border-radius:2px;"><div style="width:' + pct + '%;height:100%;background:' + barColor + ';border-radius:2px;"></div></div>';
          }
          return row + '</div>';
        }).join('');
      } else { out += '<div style="color:var(--text-3);">No per-agent data yet for today.</div>'; }
      if (gCapTok) document.getElementById('gcapTokens').value = gCapTok;
      if (gCapCost) document.getElementById('gcapCost').value = gCapCost;
      _agentTotalCost = gCost;
      updateGrandTotal();
      el.innerHTML = out;
    } else {
      // Multi-day: compute from token-usage.json byDay
      const u = await getJSON('/api/token-usage').catch(function(){ return {}; });
      const byDay = u.byDay || {};
      const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      const filteredDays = Object.keys(byDay).filter(function(d){ return d >= cutoff; }).sort().reverse();
      if (!filteredDays.length) {
        el.innerHTML = '<div style="color:var(--text-3);">No data for this period.</div>';
        _agentTotalCost = 0;
        updateGrandTotal();
        return;
      }
      // Aggregate byModel across days
      const aggByModel = {};
      var totalTok = 0, totalCost = 0;
      filteredDays.forEach(function(day) {
        const dm = byDay[day].byModel || {};
        Object.entries(dm).forEach(function(e) {
          var m = e[0], s = e[1];
          if (!aggByModel[m]) aggByModel[m] = { prompt: 0, completion: 0 };
          aggByModel[m].prompt += s.prompt || 0;
          aggByModel[m].completion += s.completion || 0;
          totalTok += (s.prompt||0) + (s.completion||0);
        });
      });
      totalCost = estimateCost(aggByModel);
      let out = '<div style="margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;">'
              + '<span style="font-size:12px;color:var(--text-3);">Last ' + days + ' days &middot; ' + filteredDays.length + ' days of data</span>'
              + '<span style="font-size:16px;font-weight:700;color:var(--yellow);">$' + totalCost.toFixed(4) + '</span>'
              + '</div>';
      // Daily breakdown bar chart
      const maxDayCost = Math.max(...filteredDays.map(function(d){ return estimateCost(byDay[d].byModel||{}); }), 0.0001);
      const today = new Date().toISOString().slice(0,10);
      out += '<div style="display:flex;flex-direction:column;gap:3px;margin-bottom:12px;">';
      filteredDays.forEach(function(day) {
        const dc = estimateCost(byDay[day].byModel||{});
        const pct = Math.max((dc/maxDayCost)*100, dc > 0 ? 2 : 0);
        const isToday = day === today;
        const tok = ((byDay[day].prompt||0)+(byDay[day].completion||0))/1000;
        out += '<div style="display:flex;align-items:center;gap:8px;font-size:11px;">'
             + '<span style="width:64px;color:var(--text-3);flex-shrink:0;">' + (isToday ? 'today' : day.slice(5)) + '</span>'
             + '<div style="flex:1;background:var(--bg-1);border-radius:3px;height:12px;overflow:hidden;">'
             +   '<div style="width:' + pct.toFixed(1) + '%;height:100%;background:' + (isToday ? 'var(--accent)' : 'var(--green)') + ';border-radius:3px;opacity:.8;"></div>'
             + '</div>'
             + '<span style="width:58px;text-align:right;color:var(--yellow);font-weight:600;">$' + dc.toFixed(4) + '</span>'
             + '<span style="width:40px;text-align:right;color:var(--text-3);">' + tok.toFixed(0) + 'k</span>'
             + '</div>';
      });
      out += '</div>';
      // Top models
      const sortedModels = Object.entries(aggByModel).sort(function(a,b){
        return estimateCost({b:b[1]}) - estimateCost({a:a[1]});
      });
      if (sortedModels.length) {
        out += '<div style="font-size:11px;color:var(--text-3);margin-bottom:4px;">By model</div>';
        sortedModels.slice(0,8).forEach(function(e) {
          var m = e[0], s = e[1];
          const mc = estimateCost({x:s});
          const tok = ((s.prompt||0)+(s.completion||0))/1000;
          out += '<div style="display:flex;justify-content:space-between;font-size:11px;padding:2px 0;border-bottom:1px solid var(--border);">'
               + '<code style="color:var(--accent);">' + m + '</code>'
               + '<span style="color:var(--text-2);">' + tok.toFixed(1) + 'k tok &middot; <span style="color:var(--yellow);">$' + mc.toFixed(4) + '</span></span>'
               + '</div>';
        });
      }
      _agentTotalCost = totalCost;
      updateGrandTotal();
      el.innerHTML = out;
    }
  } catch(e) { el.innerHTML = '<div style="color:var(--text-3);">Error: ' + e.message + '</div>'; }
}
async function resetSpending(){
  if (!confirm("Reset today's spending counters?")) return;
  try { await fetch('/api/spending/reset', { method: 'POST', headers:{'content-type':'application/json'}, body: '{}' }); loadSpending(); showNotification('Spending reset'); }
  catch(e) { showNotification('Reset failed', true); }
}
async function saveGlobalCaps(){
  const tokens = parseInt(document.getElementById('gcapTokens').value) || null;
  const cost   = parseFloat(document.getElementById('gcapCost').value) || null;
  showNotification('Add to ~/.crewswarm/crewswarm.json: "globalSpendingCaps": {"dailyTokenLimit":' + (tokens||'null') + ',"dailyCostLimitUSD":' + (cost||'null') + '}', 'warning');
}

// ── Webhooks ──────────────────────────────────────────────────────────────────
async function sendTestWebhook(){
  const channel = document.getElementById('webhookChannel').value.trim() || 'test';
  let payload = {};
  try { const v = document.getElementById('webhookPayload').value.trim(); if(v) payload = JSON.parse(v); } catch { payload = { raw: document.getElementById('webhookPayload').value }; }
  const el = document.getElementById('webhookTestResult');
  try {
    const res = await fetch('/proxy-webhook/' + channel, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    const d = await res.json();
    el.textContent = d.ok ? '✅ Sent to RT bus' : '❌ ' + (d.error||'failed');
    el.style.color = d.ok ? 'var(--green)' : 'var(--red)';
  } catch(e) { el.textContent = '❌ ' + e.message; el.style.color='var(--red)'; }
}

// ── Pending Approvals ─────────────────────────────────────────────────────────
async function loadPendingApprovals(){
  const el = document.getElementById('pendingApprovals');
  // pending-skills.json is at ~/.crewswarm/pending-skills.json — no direct API yet; 
  // crew-lead should expose this but for now show instructions.
  el.innerHTML = '<div style="color:var(--text-3);font-size:12px;">Pending skill approvals appear here when an agent triggers a skill marked requiresApproval. You will also receive a Telegram notification with inline Approve/Reject buttons if Telegram is configured.</div>';
}
async function approveSkill(approvalId){
  try { await fetch('/api/skills/approve', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({approvalId}) }); showNotification('Approved'); loadPendingApprovals(); }
  catch(e) { showNotification('Failed: '+e.message,'error'); }
}
async function rejectSkill(approvalId){
  try { await fetch('/api/skills/reject', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({approvalId}) }); showNotification('Rejected'); loadPendingApprovals(); }
  catch(e) { showNotification('Failed: '+e.message,'error'); }
}

function showAgents(){
  hideAllViews();
  document.getElementById('agentsView').classList.add('active');
  setNavActive('navAgents');
  loadAgents_cfg();
}

// ── Agents UI ──────────────────────────────────────────────────────────────
let _allModels = [];
let _modelsByProvider = {};  // { "cerebras": ["llama3.1-8b", ...], ... }

// CrewSwarm gateway-bridge tool definitions
const CREWSWARM_TOOLS = [
  { id: 'write_file', desc: 'Write files to disk (@@WRITE_FILE)' },
  { id: 'read_file',  desc: 'Read files from disk (@@READ_FILE)' },
  { id: 'mkdir',      desc: 'Create directories (@@MKDIR)' },
  { id: 'run_cmd',    desc: 'Run whitelisted shell commands (@@RUN_CMD)' },
  { id: 'git',        desc: 'Git & GitHub CLI operations' },
  { id: 'web_search', desc: 'Web search (Brave Search — @@WEB_SEARCH)' },
  { id: 'web_fetch',  desc: 'Fetch URLs (@@WEB_FETCH)' },
  { id: 'dispatch',   desc: 'Dispatch tasks to other agents' },
  { id: 'telegram',   desc: 'Send Telegram messages (@@TELEGRAM)' },
];

// Role-based tool defaults — applied when "Apply role defaults" is clicked
const AGENT_TOOL_DEFAULTS = {
  'crew-qa':          ['read_file'],
  'crew-coder':       ['write_file','read_file','mkdir','run_cmd'],
  'crew-coder-front': ['write_file','read_file','mkdir','run_cmd'],
  'crew-coder-back':  ['write_file','read_file','mkdir','run_cmd'],
  'crew-frontend':    ['write_file','read_file','mkdir','run_cmd'],
  'crew-fixer':       ['write_file','read_file','mkdir','run_cmd'],
  'crew-github':      ['read_file','run_cmd','git'],
  'crew-pm':          ['read_file','dispatch'],
  'crew-main':        ['read_file','write_file','run_cmd','dispatch'],
  'crew-security':    ['read_file','run_cmd'],
  'crew-copywriter':  ['write_file','read_file'],
  'crew-telegram':    ['telegram','read_file'],
  'crew-lead':        ['dispatch'],
};

function getToolDefaults(agentId) {
  if (AGENT_TOOL_DEFAULTS[agentId]) return AGENT_TOOL_DEFAULTS[agentId];
  // Fuzzy match — e.g. crew-coder-3 → coder defaults
  for (const [key, val] of Object.entries(AGENT_TOOL_DEFAULTS)) {
    if (agentId.startsWith(key) || agentId.includes(key.replace('crew-',''))) return val;
  }
  return ['read_file','write_file','mkdir','run_cmd']; // sensible default for unknown roles
}

async function applyToolPreset(agentId) {
  const defaults = getToolDefaults(agentId);
  const container = document.getElementById('tools-' + agentId);
  if (!container) return;
  container.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.checked = defaults.includes(cb.dataset.tool);
  });
  await saveAgentTools(agentId);
  showNotification('Role defaults applied for ' + agentId);
}

async function loadAgents_cfg(){
  const list = document.getElementById('agentsList');
  list.innerHTML = '<div class="meta" style="padding:20px;">Loading agents…</div>';
  try {
    const data = await getJSON('/api/agents-config');
    _allModels = data.allModels || [];
    _modelsByProvider = data.modelsByProvider || {};
    const agents = sortAgents(data.agents || []);
    if (!agents.length){ list.innerHTML = '<div class="meta" style="padding:20px;">No agents found in config. Check ~/.crewswarm/crewswarm.json</div>'; return; }
    list.innerHTML = '';
    agents.forEach(a => {
      const card = document.createElement('div');
      card.className = 'agent-card';
      card.id = 'agent-card-' + a.id;
      const modelOpts = _allModels.map(m => `<option value="${m}" ${m === a.model ? 'selected' : ''}>${m}</option>`).join('');
      const customOpt = (!a.model || _allModels.includes(a.model)) ? '' : `<option value="${a.model}" selected>${a.model} (custom)</option>`;
      const liveDot = a.liveness === 'online'
        ? '<span title="● online — heartbeat <90s" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 5px var(--green);margin-right:4px;flex-shrink:0;"></span>'
        : a.liveness === 'stale'
        ? '<span title="● stale — last seen >' + (a.ageSec||'?') + 's ago" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#f59e0b;margin-right:4px;flex-shrink:0;"></span>'
        : a.liveness === 'offline'
        ? '<span title="● offline — no heartbeat in 5min" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--red-hi);margin-right:4px;flex-shrink:0;"></span>'
        : '<span title="● unknown — never seen" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--text-3);margin-right:4px;flex-shrink:0;"></span>';
      card.innerHTML = `
        <div class="agent-card-header">
          <div class="agent-avatar" id="avatar-${a.id}" style="position:relative;">${a.emoji}</div>
          <div class="agent-meta">
            <div class="agent-id" style="display:flex;align-items:center;">${liveDot}${a.id} <span class="meta" style="font-weight:400;margin-left:4px;">· ${a.name}</span>
              ${MODEL_ROLE[a.id] ? '<span style="font-size:9px;font-weight:700;letter-spacing:0.04em;padding:1px 6px;border-radius:4px;margin-left:8px;' + (ROLE_STYLE[MODEL_ROLE[a.id]]||'') + '">' + MODEL_ROLE[a.id] + '</span>' : ''}
              <span id="coding-dot-${a.id}" style="display:none;margin-left:8px;align-items:center;gap:4px;font-size:11px;color:var(--accent);">
                <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--accent);animation:pulse 1s ease-in-out infinite;"></span>coding
              </span>
            </div>
            <div id="cur-model-${a.id}" style="margin-top:3px;display:flex;flex-wrap:wrap;align-items:center;gap:6px;">
              <span style="font-size:11px;font-family:'SF Mono',monospace;color:${BROKEN_MODELS.has(a.model)?'var(--red-hi)':'var(--text-2)'};" title="Conversation model — used for direct replies and chat">
                ${BROKEN_MODELS.has(a.model) ? '⚠ ' : '💬 '}${a.model || '(none)'}
              </span>
              ${a.opencodeModel ? '<span style="font-size:11px;font-family:monospace;color:' + (BROKEN_MODELS.has(a.opencodeModel)?'var(--red-hi)':'var(--green-hi)') + ';" title="OpenCode model — used when routing tasks through OpenCode CLI">⚡ ' + a.opencodeModel + '</span>' : ''}
              ${BROKEN_MODELS.has(a.model) ? '<span style="font-size:10px;font-weight:600;color:var(--red-hi);background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);padding:1px 6px;border-radius:4px;">BROKEN — REASSIGN</span>' : ''}
            </div>
          </div>
          <button class="btn-ghost" style="font-size:11px; padding:4px 10px;" data-action="toggleAgentBody" data-arg="${a.id}">Edit ▾</button>
          <button class="btn-ghost" style="font-size:11px; padding:4px 10px; color:var(--red); border-color:rgba(248,113,113,0.3);" data-action="deleteAgent" data-arg="${a.id}">✕</button>
        </div>
        <div class="agent-body" id="body-${a.id}" style="display:none;">
          <div>
            <div class="field-label" style="display:flex;align-items:center;gap:8px;">
              <span>💬 Conversation Model</span>
              <span style="font-size:10px;font-weight:400;color:var(--text-3);">Used for direct replies, planning, and chat. <strong style="color:var(--text-2);">Not used when OpenCode is enabled.</strong></span>
            </div>
            ${BROKEN_MODELS.has(a.model) ? '<div style="font-size:11px;color:var(--red-hi);background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.25);border-radius:5px;padding:6px 10px;margin-bottom:8px;">⚠ Current model <code>' + a.model + '</code> is broken (returns empty responses). Please reassign.</div>' : ''}
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
              <select id="model-${a.id}" style="flex:1; min-width:200px;" onchange="syncModelText('${a.id}')">${customOpt}${modelOpts}</select>
              <input id="modeltext-${a.id}" type="text" placeholder="or type provider/model…" value="${a.model || ''}" style="flex:1; min-width:160px; font-size:12px;" oninput="syncModelSelect('${a.id}')" />
              <button data-action="saveAgentModel" data-arg="${a.id}" class="btn-green" style="white-space:nowrap;">Save</button>
            </div>
            <div style="margin-top:8px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
              <span style="font-size:11px;color:var(--text-3);white-space:nowrap;">↩ Fallback:</span>
              ${(() => {
                const fbCustomOpt = (a.fallbackModel && !_allModels.includes(a.fallbackModel)) ? `<option value="${a.fallbackModel}" selected>${a.fallbackModel} (custom)</option>` : '';
                const fbOpts = _allModels.map(m => `<option value="${m}" ${m === a.fallbackModel ? 'selected' : ''}>${m}</option>`).join('');
                return `<select id="fmodel-${a.id}" style="flex:1;min-width:180px;font-size:11px;" onchange="syncFallbackText('${a.id}')"><option value="">— none —</option>${fbCustomOpt}${fbOpts}</select>`;
              })()}
              <input id="fallback-${a.id}" type="text" placeholder="or type any model…"
                value="${a.fallbackModel || ''}"
                style="flex:1; min-width:140px; font-size:11px; color:var(--text-2);"
                oninput="syncFallbackSelect('${a.id}')" />
              <button data-action="saveAgentFallback" data-arg="${a.id}" class="btn-ghost" style="white-space:nowrap; font-size:11px;">Save</button>
            </div>
          </div>
          <div>
            <div class="field-label">Display name &amp; emoji</div>
            <div style="display:flex; gap:8px;">
              <input id="aname-${a.id}" type="text" value="${a.name}" placeholder="Display name" style="flex:1;" />
              <div class="emoji-picker-wrap">
                <button type="button" class="emoji-btn" id="aemoji-btn-${a.id}" data-action="toggleEmojiPicker" data-arg="${a.id}" title="Pick emoji">${a.emoji||'🤖'}</button>
                <input type="hidden" id="aemoji-${a.id}" value="${a.emoji||'🤖'}" />
                <div class="emoji-picker-panel" id="aemoji-panel-${a.id}">
                  <div class="emoji-grid" id="aemoji-grid-${a.id}"></div>
                </div>
              </div>
              <button data-action="saveAgentIdentity" data-arg="${a.id}" class="btn-ghost">Save</button>
            </div>
            <div style="margin-top:8px;">
              <div class="field-label" style="margin-bottom:4px;">Role / Theme <span style="font-weight:400; color:var(--text-3); font-size:11px;">— used by PM router to assign tasks (e.g. "iOS/Swift developer (SwiftUI, UIKit)")</span></div>
              <input id="atheme-${a.id}" type="text" value="${a.theme||''}" placeholder="Describe what this agent specialises in..." style="width:100%;" />
            </div>
          </div>
          <div>
            <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px;">
              <div class="field-label" style="margin:0;">System Prompt</div>
              ${!a.systemPrompt ? '<span style="font-size:11px; color:var(--yellow);">⚠ No prompt set — agent has no role context</span>' : ''}
              <select style="font-size:11px; padding:3px 8px; margin-left:auto;" onchange="applyAgentPromptPreset('${a.id}', this.value); this.value=''">
                ${buildPresetOptions()}
              </select>
            </div>
            <textarea id="prompt-${a.id}" rows="5" placeholder="Describe this agent's role. It's injected at the top of every task.">${a.systemPrompt || ''}</textarea>
            <div style="margin-top:8px; display:flex; gap:8px;">
              <button data-action="saveAgentPrompt" data-arg="${a.id}" class="btn-ghost">Save prompt</button>
            </div>
          </div>
          <div style="border-top:1px solid var(--border); padding-top:10px;">
            <div class="field-label" style="margin-bottom:8px;">Session</div>
            <div style="display:flex; gap:8px; align-items:center; margin-bottom:12px;">
              <button data-action="resetAgentSession" data-arg="${a.id}" class="btn-ghost" style="font-size:12px;">↺ Reset context window</button>
              <span style="font-size:11px; color:var(--text-3);">Clears accumulated token context. Shared memory is re-injected on next task.</span>
            </div>
          </div>
          <div style="border-top:1px solid var(--border); padding-top:10px;">
            <div class="field-label" style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
              <span>CrewSwarm — Agent Tools</span>
              <span style="font-size:10px; font-weight:600; color:var(--accent); padding:2px 6px; border-radius:4px; background:rgba(56,189,248,0.08); border:1px solid rgba(56,189,248,0.25);">gateway-bridge</span>
            </div>
            <div class="meta" style="margin-bottom:10px; font-size:11px;">Controls which tools this agent can execute on disk and network. Enforced by gateway-bridge on every task — only checked tools are active.</div>
            <div id="tools-${a.id}" style="display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:6px; margin-bottom:12px;">
              ${CREWSWARM_TOOLS.map(t => `
                <label style="display:flex; align-items:flex-start; gap:7px; font-size:12px; color:var(--text-2); cursor:pointer; padding:6px 8px; border-radius:5px; border:1px solid var(--border); background:var(--bg-card2);">
                  <input type="checkbox" data-tool="${t.id}" ${(a.alsoAllow||[]).includes(t.id)?'checked':''} style="accent-color:var(--accent); margin-top:2px; flex-shrink:0;" />
                  <div>
                    <code style="font-size:11px; color:var(--text-1);">${t.id}</code>
                    <div style="font-size:10px; color:var(--text-3); margin-top:2px; line-height:1.3;">${t.desc}</div>
                  </div>
                </label>
              `).join('')}
            </div>
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:10px;">
              <button data-action="saveAgentTools" data-arg="${a.id}" class="btn-ghost" style="font-size:12px;">Save tools</button>
              <button data-action="applyToolPreset" data-arg="${a.id}" class="btn-ghost" style="font-size:12px; color:var(--text-3);">↩ Role defaults</button>
            </div>
            <div class="meta">Workspace: <code style="font-size:11px;">${a.workspace}</code></div>
          </div>
          <div style="border-top:1px solid var(--border); padding-top:10px;">
            <div class="field-label" style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
              <span>⚡ Execution Route</span>
              <span style="font-size:10px; font-weight:600; color:var(--text-3); padding:2px 6px; border-radius:4px; background:var(--surface-2);">pick one — mutually exclusive</span>
            </div>
            <div style="display:flex; gap:6px; margin-bottom:10px; flex-wrap:wrap;">
              <button id="route-direct-${a.id}" data-action="setRoute" data-arg="${a.id}" data-arg2="direct"
                style="font-size:11px; font-weight:600; padding:5px 12px; border-radius:6px; cursor:pointer; border:1px solid ${!a.useOpenCode && !a.useCursorCli ? 'var(--accent)' : 'var(--border)'}; background:${!a.useOpenCode && !a.useCursorCli ? 'rgba(99,102,241,0.15)' : 'var(--surface-2)'}; color:${!a.useOpenCode && !a.useCursorCli ? 'var(--accent)' : 'var(--text-2)'};">
                💬 Direct API
              </button>
              <button id="route-opencode-${a.id}" data-action="setRoute" data-arg="${a.id}" data-arg2="opencode"
                style="font-size:11px; font-weight:600; padding:5px 12px; border-radius:6px; cursor:pointer; border:1px solid ${a.useOpenCode && !a.useCursorCli ? 'var(--green-hi)' : 'var(--border)'}; background:${a.useOpenCode && !a.useCursorCli ? 'rgba(34,197,94,0.12)' : 'var(--surface-2)'}; color:${a.useOpenCode && !a.useCursorCli ? 'var(--green-hi)' : 'var(--text-2)'};">
                ⚡ OpenCode
              </button>
              <button id="route-cursor-${a.id}" data-action="setRoute" data-arg="${a.id}" data-arg2="cursor"
                style="font-size:11px; font-weight:600; padding:5px 12px; border-radius:6px; cursor:pointer; border:1px solid ${a.useCursorCli ? 'var(--accent)' : 'var(--border)'}; background:${a.useCursorCli ? 'rgba(56,189,248,0.12)' : 'var(--surface-2)'}; color:${a.useCursorCli ? 'var(--accent)' : 'var(--text-2)'};">
                🖱 Cursor CLI <span style="font-size:10px; font-weight:400; opacity:0.7;">(free · sub)</span>
              </button>
              <button id="route-claudecode-${a.id}" data-action="setRoute" data-arg="${a.id}" data-arg2="claudecode"
                style="font-size:11px; font-weight:600; padding:5px 12px; border-radius:6px; cursor:pointer; border:1px solid ${a.useClaudeCode ? '#f59e0b' : 'var(--border)'}; background:${a.useClaudeCode ? 'rgba(245,158,11,0.12)' : 'var(--surface-2)'}; color:${a.useClaudeCode ? '#f59e0b' : 'var(--text-2)'};">
                🤖 Claude Code <span style="font-size:10px; font-weight:400; opacity:0.7;">(api key)</span>
              </button>
              <button id="route-codex-${a.id}" data-action="setRoute" data-arg="${a.id}" data-arg2="codex"
                style="font-size:11px; font-weight:600; padding:5px 12px; border-radius:6px; cursor:pointer; border:1px solid ${a.useCodex ? '#a855f7' : 'var(--border)'}; background:${a.useCodex ? 'rgba(168,85,247,0.12)' : 'var(--surface-2)'}; color:${a.useCodex ? '#a855f7' : 'var(--text-2)'};">
                🟣 Codex CLI <span style="font-size:10px; font-weight:400; opacity:0.7;">(subscription)</span>
              </button>
            </div>
            <div id="loop-row-${a.id}" style="display:${(a.useOpenCode || a.useCursorCli || a.useClaudeCode || a.useCodex) ? 'flex' : 'none'}; align-items:center; gap:10px; margin-bottom:10px; padding:8px 10px; background:var(--surface-2); border-radius:8px; border:1px solid var(--border);">
              <label style="display:flex; align-items:center; gap:8px; cursor:pointer; flex:1;">
                <input type="checkbox" id="loop-toggle-${a.id}" ${a.opencodeLoop ? 'checked' : ''} onchange="saveAgentLoop('${a.id}')" style="width:14px; height:14px; cursor:pointer;" />
                <span style="font-size:12px; font-weight:600; color:var(--text-1);">🔁 Ouroboros Loop</span>
                <span style="font-size:11px; color:var(--text-3);">LLM decomposes task → engine runs each step → feeds result back until DONE</span>
              </label>
              <div style="display:flex; align-items:center; gap:6px;">
                <span style="font-size:11px; color:var(--text-3); white-space:nowrap;">Max rounds:</span>
                <input type="number" id="loop-rounds-${a.id}" min="1" max="20" value="${a.opencodeLoopMaxRounds || 10}" style="width:52px; font-size:12px; padding:3px 6px; border-radius:5px; border:1px solid var(--border); background:var(--bg-1); color:var(--text-1); text-align:center;" onchange="saveAgentLoop('${a.id}')" />
              </div>
            </div>
            <div id="oc-model-row-${a.id}" style="display:${a.useOpenCode && !a.useCursorCli ? 'flex' : 'none'}; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:6px;">
              <select id="oc-model-${a.id}" style="flex:1; min-width:200px; font-size:12px;" onchange="syncOcModelText('${a.id}')"></select>
              <input id="oc-modeltext-${a.id}" type="text" placeholder="opencode/model…" value="${a.opencodeModel || ''}" style="flex:1; min-width:160px; font-size:12px;" />
              <button data-action="saveOpenCodeConfig" data-arg="${a.id}" class="btn-green" style="white-space:nowrap; font-size:12px;">Save</button>
            </div>
            <div id="oc-fallback-row-${a.id}" style="display:${a.useOpenCode && !a.useCursorCli ? 'flex' : 'none'}; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:10px;">
              <span style="font-size:11px; color:var(--text-3); white-space:nowrap;">↩ Fallback:</span>
              <select id="oc-fallback-sel-${a.id}" style="flex:1; min-width:200px; font-size:12px;" onchange="syncOcFallbackText('${a.id}')"></select>
              <input id="oc-fallback-${a.id}" type="text" placeholder="opencode/model or leave blank" value="${a.opencodeFallbackModel || ''}" style="flex:1; min-width:160px; font-size:12px;" />
              <button data-action="saveOpenCodeFallback" data-arg="${a.id}" class="btn-ghost" style="white-space:nowrap; font-size:12px;">Save</button>
            </div>
            <div id="cursor-model-row-${a.id}" style="display:${a.useCursorCli ? 'flex' : 'none'}; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:10px;">
              <select id="cursor-model-sel-${a.id}" style="flex:1; min-width:200px; font-size:12px;" onchange="syncCursorModelText('${a.id}')"></select>
              <input id="cursor-model-txt-${a.id}" type="text" placeholder="sonnet-4.6 or leave blank for auto" value="${a.cursorCliModel || ''}" style="flex:1; min-width:160px; font-size:12px;" />
              <button data-action="saveCursorCliConfig" data-arg="${a.id}" class="btn-sky" style="white-space:nowrap; font-size:12px;">Save</button>
            </div>
            <div id="claudecode-model-row-${a.id}" style="display:${a.useClaudeCode ? 'flex' : 'none'}; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:10px;">
              <select id="claudecode-model-sel-${a.id}" style="flex:1; min-width:200px; font-size:12px;" onchange="syncClaudeCodeModelText('${a.id}')">
                <option value="">— auto (claude-sonnet-4-5) —</option>
                <option value="claude-opus-4-5" ${(a.claudeCodeModel||'') === 'claude-opus-4-5' ? 'selected' : ''}>claude-opus-4-5 — best reasoning</option>
                <option value="claude-sonnet-4-5" ${(a.claudeCodeModel||'') === 'claude-sonnet-4-5' ? 'selected' : ''}>claude-sonnet-4-5 — best coding</option>
                <option value="claude-haiku-4-5" ${(a.claudeCodeModel||'') === 'claude-haiku-4-5' ? 'selected' : ''}>claude-haiku-4-5 — fast &amp; cheap</option>
              </select>
              <input id="claudecode-model-txt-${a.id}" type="text" placeholder="claude-sonnet-4-5 or leave blank" value="${a.claudeCodeModel || ''}" style="flex:1; min-width:160px; font-size:12px;" />
              <button data-action="saveClaudeCodeConfig" data-arg="${a.id}" class="btn-ghost" style="white-space:nowrap; font-size:12px; color:#f59e0b; border-color:rgba(245,158,11,0.3);">Save</button>
            </div>
          </div>
          <div style="border-top:1px solid var(--border); padding:10px 16px; display:flex; align-items:center; justify-content:space-between; gap:8px;">
            <div style="font-size:11px; color:var(--text-3);">
              Session context accumulates over time. Reset clears the conversation history and re-injects shared memory.
            </div>
            <button data-action="resetAgentSession" data-arg="${a.id}" class="btn-ghost" style="font-size:12px; white-space:nowrap; color:var(--amber); border-color:rgba(245,158,11,0.3);">↺ Reset session</button>
          </div>
        </div>
      `;
      list.appendChild(card);
    });
    // Re-populate model selects with grouped optgroups
    agents.forEach(a => {
      const sel = document.getElementById('model-' + a.id);
      if (sel) populateModelDropdown('model-' + a.id, a.model);
    });
    // Load OpenCode models and populate dropdowns
    loadOcModels().then(() => {
      agents.forEach(a => {
        populateOcModelDropdown('oc-model-' + a.id, a.opencodeModel || '');
        populateOcModelDropdown('oc-fallback-sel-' + a.id, a.opencodeFallbackModel || '');
        populateCursorModelDropdown('cursor-model-sel-' + a.id, a.cursorCliModel || '');
      });
    });
  } catch(e){ list.innerHTML = '<div class="meta" style="padding:20px; color:var(--red);">Error: ' + e.message + '</div>'; }
}

function toggleAgentBody(id){
  const body = document.getElementById('body-' + id);
  body.style.display = body.style.display === 'none' ? 'grid' : 'none';
}

async function resetAgentSessionRT(agentId){
  if (!confirm('Reset session for ' + agentId + '?\\n\\nThis clears accumulated conversation context. Shared memory (memory/*.md) is preserved and re-injected on next task.')) return;
  try {
    const r = await postJSON('/api/agents/reset-session', { agentId });
    if (r.ok) {
      showNotification('Session reset for ' + agentId);
    } else {
      showNotification('Reset failed: ' + (r.error || 'unknown'), true);
    }
  } catch(e) {
    showNotification('Reset error: ' + e.message, true);
  }
}

async function deleteAgent(agentId){
  if (!confirm('Delete agent "' + agentId + '"? This cannot be undone.')) return;
  // Remove card from DOM instantly so it feels immediate
  const card = document.getElementById('agent-card-' + agentId);
  if (card) card.style.opacity = '0.3';
  try {
    await postJSON('/api/agents-config/delete', { agentId });
    if (card) card.remove();
    showNotification('Agent ' + agentId + ' deleted');
    await loadAgents_cfg();
  } catch(e){
    if (card) card.style.opacity = '1';
    showNotification('Delete failed: ' + e.message, true);
  }
}

function syncModelText(agentId){
  const sel = document.getElementById('model-' + agentId);
  const txt = document.getElementById('modeltext-' + agentId);
  if (txt) txt.value = sel.value;
}
function syncModelSelect(agentId){
  const txt = document.getElementById('modeltext-' + agentId);
  const sel = document.getElementById('model-' + agentId);
  if (!sel) return;
  const typed = txt.value.trim();
  const match = [...sel.options].find(o => o.value === typed);
  sel.value = match ? typed : '';
}
function syncFallbackText(agentId){
  const sel = document.getElementById('fmodel-' + agentId);
  const txt = document.getElementById('fallback-' + agentId);
  if (txt) txt.value = sel.value;
}
function syncFallbackSelect(agentId){
  const txt = document.getElementById('fallback-' + agentId);
  const sel = document.getElementById('fmodel-' + agentId);
  if (!sel) return;
  const typed = txt.value.trim();
  const match = [...sel.options].find(o => o.value === typed);
  sel.value = match ? typed : '';
}
// Expose sync helpers globally — onchange="" attributes in dynamic HTML need window scope
window.syncModelText    = syncModelText;
window.syncModelSelect  = syncModelSelect;
window.syncFallbackText = syncFallbackText;
window.syncFallbackSelect = syncFallbackSelect;
async function resetAgentSession(agentId){
  if (!confirm('Reset context window for ' + agentId + '?\\n\\nThis clears the agent\'s accumulated conversation history. Shared memory files will be re-injected on the next task.')) return;
  showNotification('Resetting ' + agentId + ' session...');
  try {
    await postJSON('/api/agents-config/reset-session', { agentId });
    showNotification(agentId + ' session reset');
  } catch(e) {
    showNotification('Reset failed: ' + e.message, true);
  }
}

function refreshModelHeader(agentId, model, opencodeModel) {
  const el = document.getElementById('cur-model-' + agentId);
  if (!el) return;
  const chatBroken = BROKEN_MODELS.has(model);
  const ocBroken   = opencodeModel && BROKEN_MODELS.has(opencodeModel);
  el.innerHTML =
    `<span style="font-size:11px;font-family:'SF Mono',monospace;color:${chatBroken?'var(--red-hi)':'var(--text-2)'};" title="Conversation model">${chatBroken?'⚠ ':'💬 '}${model||'(none)'}</span>` +
    (opencodeModel ? `<span style="font-size:11px;font-family:'SF Mono',monospace;color:${ocBroken?'var(--red-hi)':'var(--green-hi)'};" title="OpenCode model">⚡ ${opencodeModel}</span>` : '') +
    (chatBroken ? `<span style="font-size:10px;font-weight:600;color:var(--red-hi);background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);padding:1px 6px;border-radius:4px;">BROKEN — REASSIGN</span>` : '');
}

async function saveAgentModel(agentId){
  const txt = document.getElementById('modeltext-' + agentId);
  const sel = document.getElementById('model-' + agentId);
  const model = (txt && txt.value.trim()) || (sel && sel.value) || '';
  if (!model){ showNotification('Select or type a model', true); return; }
  if (BROKEN_MODELS.has(model)) {
    showNotification('⚠ That model returns empty responses — choose another', true);
    return;
  }
  try {
    await postJSON('/api/agents-config/update', { agentId, model });
    const ocModel = document.getElementById('oc-modeltext-' + agentId)?.value.trim() || '';
    refreshModelHeader(agentId, model, ocModel);
    showNotification(`${agentId} → ${model}`);
  } catch(e){ showNotification('Failed: ' + e.message, true); }
}

async function saveAgentFallback(agentId){
  const inp = document.getElementById('fallback-' + agentId);
  const fallbackModel = inp?.value.trim() || '';
  try {
    await postJSON('/api/agents-config/update', { agentId, fallbackModel });
    showNotification(fallbackModel ? `Fallback set: ${fallbackModel}` : `Fallback cleared for ${agentId}`);
  } catch(e){ showNotification('Failed: ' + e.message, true); }
}

// ── OpenCode per-agent config ───────────────────────────────────────────────
let _ocModelsCache = null;

async function loadOcModels() {
  if (_ocModelsCache) return _ocModelsCache;
  try {
    const r = await fetch('/api/opencode-models');
    const d = await r.json();
    _ocModelsCache = Array.isArray(d.models) ? d.models : [];
  } catch { _ocModelsCache = []; }
  return _ocModelsCache;
}

const OC_MODEL_LABELS = {
  'opencode/big-pickle':              'Big Pickle (Stealth)',
  'opencode/trinity-large-preview-free': 'Trinity Large Preview (Stealth)',
  'opencode/gpt-5':                   'GPT 5',
  'opencode/gpt-5-codex':             'GPT 5 Codex',
  'opencode/gpt-5-nano':              'GPT 5 Nano',
  'opencode/gpt-5.1':                 'GPT 5.1',
  'opencode/gpt-5.1-codex':          'GPT 5.1 Codex',
  'opencode/gpt-5.1-codex-max':      'GPT 5.1 Codex Max',
  'opencode/gpt-5.1-codex-mini':     'GPT 5.1 Codex Mini',
  'opencode/gpt-5.2':                 'GPT 5.2',
  'opencode/gpt-5.2-codex':          'GPT 5.2 Codex',
  'opencode/alpha-gpt-5.3-codex':    'GPT 5.3 Codex (alpha)',
  'opencode/alpha-gpt-5.4':          'GPT 5.4 (alpha)',
  'opencode/claude-sonnet-4':         'Claude Sonnet 4',
  'opencode/claude-sonnet-4-5':       'Claude Sonnet 4.5',
  'opencode/claude-sonnet-4-6':       'Claude Sonnet 4.6',
  'opencode/claude-opus-4-1':         'Claude Opus 4.1',
  'opencode/claude-opus-4-5':         'Claude Opus 4.5',
  'opencode/claude-opus-4-6':         'Claude Opus 4.6',
  'opencode/claude-haiku-4-5':        'Claude Haiku 4.5',
  'opencode/claude-3-5-haiku':        'Claude 3.5 Haiku',
  'opencode/gemini-3-flash':          'Gemini 3 Flash',
  'opencode/gemini-3-pro':            'Gemini 3 Pro',
  'opencode/gemini-3.1-pro':          'Gemini 3.1 Pro',
  'opencode/kimi-k2':                 'Kimi K2',
  'opencode/kimi-k2-thinking':        'Kimi K2 Thinking',
  'opencode/kimi-k2.5':               'Kimi K2.5',
  'opencode/kimi-k2.5-free':          'Kimi K2.5 Free',
  'opencode/glm-4.6':                 'GLM 4.6 (Z.ai)',
  'opencode/glm-4.7':                 'GLM 4.7 (Z.ai)',
  'opencode/glm-5':                   'GLM 5 (Z.ai)',
  'opencode/glm-5-free':              'GLM 5 Free (Z.ai)',
  'opencode/minimax-m2.1':            'MiniMax M2.1',
  'opencode/minimax-m2.1-free':       'MiniMax M2.1 Free',
  'opencode/minimax-m2.5':            'MiniMax M2.5',
  'opencode/minimax-m2.5-free':       'MiniMax M2.5 Free',
};

function populateOcModelDropdown(selectId, currentVal) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  sel.innerHTML = '<option value="">— select model —</option>';

  // Merge OpenCode server models + all provider models so Groq/xAI/etc all appear
  const ocModels = (_ocModelsCache || []).map(m =>
    typeof m === 'string' ? m : (m.provider ? m.provider + '/' + m.id : m.id || m.name || String(m))
  );
  const allCombined = [...new Set([...ocModels, ...(_allModels || [])])].filter(Boolean);

  const grouped = {};
  allCombined.forEach(full => {
    const provider = full.includes('/') ? full.split('/')[0] : 'other';
    if (!grouped[provider]) grouped[provider] = [];
    grouped[provider].push(full);
  });

  for (const [provider, ids] of Object.entries(grouped)) {
    const grp = document.createElement('optgroup');
    grp.label = provider.toUpperCase();
    ids.forEach(full => {
      const opt = document.createElement('option');
      opt.value = full;
      opt.textContent = OC_MODEL_LABELS[full] || full;
      if (full === currentVal) opt.selected = true;
      grp.appendChild(opt);
    });
    sel.appendChild(grp);
  }

  if (currentVal && !sel.value) {
    const opt = document.createElement('option');
    opt.value = currentVal;
    opt.textContent = (OC_MODEL_LABELS[currentVal] || currentVal) + ' (custom)';
    opt.selected = true;
    sel.prepend(opt);
  }
}

// Cursor CLI subscription models (populated from agent models command)
const CURSOR_CLI_MODELS = [
  { id: '', label: '— auto (subscription default) —' },
  { id: 'opus-4.6-thinking', label: 'Claude 4.6 Opus (Thinking) — best reasoning' },
  { id: 'opus-4.6', label: 'Claude 4.6 Opus' },
  { id: 'sonnet-4.6-thinking', label: 'Claude 4.6 Sonnet (Thinking)' },
  { id: 'sonnet-4.6', label: 'Claude 4.6 Sonnet — best coding' },
  { id: 'sonnet-4.5', label: 'Claude 4.5 Sonnet' },
  { id: 'gpt-5.3-codex-xhigh', label: 'GPT-5.3 Codex XHigh' },
  { id: 'gpt-5.3-codex-high', label: 'GPT-5.3 Codex High' },
  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  { id: 'gpt-5.3-codex-fast', label: 'GPT-5.3 Codex Fast' },
  { id: 'gpt-5.2', label: 'GPT-5.2' },
  { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
  { id: 'gemini-3-flash', label: 'Gemini 3 Flash' },
  { id: 'grok', label: 'Grok' },
  { id: 'kimi-k2.5', label: 'Kimi K2.5' },
];

function populateCursorModelDropdown(selId, currentVal) {
  const sel = document.getElementById(selId);
  if (!sel) return;
  sel.innerHTML = CURSOR_CLI_MODELS.map(m =>
    '<option value="' + m.id + '"' + (m.id === (currentVal||'') ? ' selected' : '') + '>' + m.label + '</option>'
  ).join('');
}

function syncCursorModelText(agentId) {
  const sel = document.getElementById('cursor-model-sel-' + agentId);
  const txt = document.getElementById('cursor-model-txt-' + agentId);
  if (sel && txt) txt.value = sel.value;
}
window.syncCursorModelText = syncCursorModelText;

// 4-way route toggle — mutually exclusive
async function setRoute(agentId, route) {
  const useOpenCode   = route === 'opencode';
  const useCursorCli  = route === 'cursor';
  const useClaudeCode = route === 'claudecode';
  const useCodex      = route === 'codex';
  // Update button styles
  const styles = {
    direct:      { border: 'var(--accent)',    bg: 'rgba(99,102,241,0.15)',   color: 'var(--accent)' },
    opencode:    { border: 'var(--green-hi)',  bg: 'rgba(34,197,94,0.12)',    color: 'var(--green-hi)' },
    cursor:      { border: 'var(--accent)',    bg: 'rgba(56,189,248,0.12)',   color: 'var(--accent)' },
    claudecode:  { border: '#f59e0b',          bg: 'rgba(245,158,11,0.12)',  color: '#f59e0b' },
    codex:       { border: '#a855f7',          bg: 'rgba(168,85,247,0.12)',  color: '#a855f7' },
    inactive:    { border: 'var(--border)',    bg: 'var(--surface-2)',        color: 'var(--text-2)' },
  };
  ['direct','opencode','cursor','claudecode','codex'].forEach(r => {
    const btn = document.getElementById('route-' + r + '-' + agentId);
    if (!btn) return;
    const s = r === route ? styles[r] : styles.inactive;
    btn.style.borderColor = s.border; btn.style.background = s.bg; btn.style.color = s.color;
  });
  // Show/hide model rows
  const ocRow        = document.getElementById('oc-model-row-' + agentId);
  const ocFbRow      = document.getElementById('oc-fallback-row-' + agentId);
  const cursorRow    = document.getElementById('cursor-model-row-' + agentId);
  const ccRow        = document.getElementById('claudecode-model-row-' + agentId);
  if (ocRow)     ocRow.style.display     = useOpenCode   ? 'flex' : 'none';
  if (ocFbRow)   ocFbRow.style.display   = useOpenCode   ? 'flex' : 'none';
  if (cursorRow) cursorRow.style.display = useCursorCli  ? 'flex' : 'none';
  if (ccRow)     ccRow.style.display     = useClaudeCode ? 'flex' : 'none';
  const loopRow = document.getElementById('loop-row-' + agentId);
  if (loopRow)   loopRow.style.display   = (useOpenCode || useCursorCli || useClaudeCode || useCodex) ? 'flex' : 'none';
  // Save
  try {
    await postJSON('/api/agents-config/update', { agentId, useOpenCode, useCursorCli, useClaudeCode, useCodex });
    const labels = { direct: 'Direct API', opencode: 'OpenCode', cursor: 'Cursor CLI', claudecode: 'Claude Code', codex: 'Codex CLI' };
    showNotification(agentId + ' → ' + (labels[route] || route));
  } catch(e) { showNotification('Failed: ' + e.message, true); }
}

async function saveCursorCliConfig(agentId) {
  const cursorCliModel = (document.getElementById('cursor-model-txt-' + agentId)?.value || '').trim();
  try {
    await postJSON('/api/agents-config/update', { agentId, cursorCliModel });
    showNotification(agentId + ' Cursor model → ' + (cursorCliModel || 'auto'));
  } catch(e) { showNotification('Failed: ' + e.message, true); }
}

async function saveClaudeCodeConfig(agentId) {
  const claudeCodeModel = (document.getElementById('claudecode-model-txt-' + agentId)?.value || '').trim();
  try {
    await postJSON('/api/agents-config/update', { agentId, claudeCodeModel });
    showNotification(agentId + ' Claude Code model → ' + (claudeCodeModel || 'auto'));
  } catch(e) { showNotification('Failed: ' + e.message, true); }
}

async function saveAgentLoop(agentId) {
  const enabled = document.getElementById('loop-toggle-' + agentId)?.checked ?? false;
  const maxRoundsRaw = document.getElementById('loop-rounds-' + agentId)?.value;
  const opencodeLoopMaxRounds = Math.min(20, Math.max(1, parseInt(maxRoundsRaw || '10', 10)));
  try {
    await postJSON('/api/agents-config/update', { agentId, opencodeLoop: enabled, opencodeLoopMaxRounds });
    showNotification(agentId + ' loop ' + (enabled ? `ON (${opencodeLoopMaxRounds} rounds max)` : 'OFF'));
  } catch(e) { showNotification('Failed: ' + e.message, true); }
}
window.saveAgentLoop = saveAgentLoop;

function syncClaudeCodeModelText(agentId) {
  const sel = document.getElementById('claudecode-model-sel-' + agentId);
  const txt = document.getElementById('claudecode-model-txt-' + agentId);
  if (sel && txt) txt.value = sel.value;
}
window.syncClaudeCodeModelText = syncClaudeCodeModelText;

function toggleOpenCodeUI(agentId) {
  // Legacy — kept for any stale references; use setRoute instead
  const checked = document.getElementById('oc-toggle-' + agentId)?.checked;
  if (checked !== undefined) setRoute(agentId, checked ? 'opencode' : 'direct');
}

function syncOcModelText(agentId) {
  const sel = document.getElementById('oc-model-' + agentId);
  const txt = document.getElementById('oc-modeltext-' + agentId);
  if (sel && txt && sel.value) txt.value = sel.value;
}
window.syncOcModelText = syncOcModelText;

function syncOcFallbackText(agentId) {
  const sel = document.getElementById('oc-fallback-sel-' + agentId);
  const txt = document.getElementById('oc-fallback-' + agentId);
  if (sel && txt && sel.value) txt.value = sel.value;
}

async function saveOpenCodeFallback(agentId) {
  const opencodeFallbackModel = (document.getElementById('oc-fallback-' + agentId)?.value || '').trim();
  try {
    await postJSON('/api/agents-config/update', { agentId, opencodeFallbackModel });
    showNotification(opencodeFallbackModel ? agentId + ' OC fallback → ' + opencodeFallbackModel : 'OC fallback cleared for ' + agentId);
  } catch(e) { showNotification('Failed: ' + e.message, true); }
}

async function saveOpenCodeConfig(agentId) {
  // Only saves the opencodeModel — route (useOpenCode flag) is set by the route buttons via setRoute().
  // Reading the old oc-toggle checkbox here was a bug: the checkbox no longer exists, causing it
  // to always send useOpenCode:false and toast "→ direct LLM" even when OpenCode route was active.
  const opencodeModel = (document.getElementById('oc-modeltext-' + agentId)?.value || '').trim();
  try {
    await postJSON('/api/agents-config/update', { agentId, opencodeModel });
    const chatModel = document.getElementById('modeltext-' + agentId)?.value.trim() || '';
    refreshModelHeader(agentId, chatModel, opencodeModel);
    showNotification(agentId + ' OC model → ' + (opencodeModel || 'default'));
  } catch(e) { showNotification('Failed: ' + e.message, true); }
}

async function saveCursorCliToggle(agentId) {
  // Legacy shim — delegates to setRoute
  const useCursorCli = document.getElementById('cursor-cli-toggle-' + agentId)?.checked || false;
  await setRoute(agentId, useCursorCli ? 'cursor' : 'direct');
}

// Bulk route setter — apply a route to all coding agents at once
async function bulkSetRoute(route, model) {
  const CODING_AGENTS = ['crew-coder','crew-coder-front','crew-coder-back','crew-frontend','crew-fixer','crew-architect','crew-ml'];
  const label = route === 'cursor' ? 'Cursor CLI' : route === 'opencode' ? 'OpenCode' : route === 'claudecode' ? 'Claude Code' : 'Direct API';
  showNotification('Applying ' + label + ' to all coding agents…');
  for (const agentId of CODING_AGENTS) {
    const useOpenCode   = route === 'opencode';
    const useCursorCli  = route === 'cursor';
    const useClaudeCode = route === 'claudecode';
    try {
      const payload = { agentId, useOpenCode, useCursorCli, useClaudeCode };
      if (model && route === 'cursor')      payload.cursorCliModel  = model;
      if (model && route === 'opencode')    payload.opencodeModel   = model;
      if (model && route === 'claudecode')  payload.claudeCodeModel = model;
      await postJSON('/api/agents-config/update', payload);
    } catch(e) { console.error('bulkSetRoute failed for', agentId, e.message); }
  }
  showNotification('Done — ' + CODING_AGENTS.length + ' agents set to ' + label + (model ? ' (' + model + ')' : ''));
  loadAgents();
}

const AGENT_EMOJIS = ['🤖','🧠','⚡','🔥','🎯','🛡️','🔧','🐛','🔬','📋','✍️','🐙','🎨','🖥️','📱','🔒','📊','🚀','💡','🌐','⚙️','🦊','🦾','💻','🏗️','🔍','📝','💬','🧪','🎭'];

function toggleEmojiPicker(agentId) {
  const panel = document.getElementById('aemoji-panel-' + agentId);
  const grid  = document.getElementById('aemoji-grid-'  + agentId);
  const isOpen = panel.classList.contains('open');
  document.querySelectorAll('.emoji-picker-panel.open').forEach(p => p.classList.remove('open'));
  if (isOpen) return;
  if (!grid.hasChildNodes()) {
    grid.innerHTML = AGENT_EMOJIS.map(e =>
      '<div class="emoji-opt" data-agent="' + agentId + '" data-emoji="' + e + '" title="' + e + '">' + e + '</div>'
    ).join('');
    grid.addEventListener('click', function(ev) {
      const opt = ev.target.closest('.emoji-opt');
      if (opt) selectEmoji(opt.dataset.agent, opt.dataset.emoji);
    });
  }
  panel.classList.add('open');
}

function selectEmoji(agentId, emoji) {
  const isNew = agentId === '__new__';
  const inputEl = isNew ? document.getElementById('naEmoji') : document.getElementById('aemoji-' + agentId);
  const btnEl   = isNew ? document.getElementById('naEmoji-btn') : document.getElementById('aemoji-btn-' + agentId);
  if (inputEl) inputEl.value = emoji;
  if (btnEl)   btnEl.textContent = emoji;
  document.getElementById('aemoji-panel-' + agentId).classList.remove('open');
}

// close picker when clicking outside
document.addEventListener('click', e => {
  if (!e.target.closest('.emoji-picker-wrap')) {
    document.querySelectorAll('.emoji-picker-panel.open').forEach(p => p.classList.remove('open'));
  }
});

async function saveAgentIdentity(agentId){
  const name  = document.getElementById('aname-'  + agentId).value.trim();
  const emoji = document.getElementById('aemoji-' + agentId).value.trim();
  const theme = document.getElementById('atheme-' + agentId)?.value.trim();
  try {
    await postJSON('/api/agents-config/update', { agentId, name, emoji, theme });
    showNotification('Identity saved for ' + agentId);
  } catch(e){ showNotification('Failed: ' + e.message, true); }
}

window.applyAgentPromptPreset = function(agentId, preset) {
  if (!preset || !PROMPT_PRESETS[preset]) return;
  const ta = document.getElementById('prompt-' + agentId);
  if (ta) ta.value = PROMPT_PRESETS[preset];
  // Auto-fill the theme/role field with the preset's display name (strip leading emoji + whitespace)
  const themeEl = document.getElementById('atheme-' + agentId);
  if (themeEl) {
    const opt = PRESET_OPTIONS.find(p => p.value === preset);
    if (opt) themeEl.value = opt.label.replace(/^[\u{1F000}-\u{1FFFF}\u2600-\u27BF\uFE0F\u20D0-\u20FF\s]+/u, '').trim();
  }
};

async function saveAgentPrompt(agentId){
  const systemPrompt = document.getElementById('prompt-' + agentId).value;
  try {
    await postJSON('/api/agents-config/update', { agentId, systemPrompt });
    showNotification('Prompt saved for ' + agentId);
  } catch(e){ showNotification('Failed: ' + e.message, true); }
}

async function startCrew(){
  try {
    showNotification('Starting crew bridge daemons…');
    const r = await postJSON('/api/crew/start', {});
    showNotification(r.message || 'Crew started');
  } catch(e){ showNotification('Crew start failed: ' + e.message, true); }
}

const NEW_AGENT_TOOL_PRESETS = {
  coder:        ['write_file','read_file','mkdir','run_cmd'],   // frontend, backend, fullstack, ios, android, data, aiml, api, db, rn, web3, automation, fixer
  writer:       ['write_file','read_file'],                     // copywriter, docs, design (no shell exec)
  reviewer:     ['read_file'],                                  // qa, strict read-only audit
  security:     ['read_file','run_cmd'],                        // security auditor — run scanners but never write
  orchestrator: ['read_file','dispatch'],                       // pm, planner — routes tasks but doesn't write files
  coordinator:  ['write_file','read_file','run_cmd','dispatch'],// main/lead — full access + dispatch, no git
  devops:       ['read_file','run_cmd','git'],                  // devops, github ops
  comms:        ['telegram','read_file'],                       // telegram notification agent
};

function applyNewAgentToolPreset() {
  const preset = document.getElementById('naToolPreset').value;
  if (!preset || !NEW_AGENT_TOOL_PRESETS[preset]) return;
  const allowed = NEW_AGENT_TOOL_PRESETS[preset];
  document.querySelectorAll('.naToolCheck').forEach(cb => {
    cb.checked = allowed.includes(cb.dataset.tool);
  });
}

async function saveAgentTools(agentId){
  const container = document.getElementById('tools-' + agentId);
  const checked = [...container.querySelectorAll('input[type=checkbox]:checked')].map(el => el.dataset.tool);
  try {
    await postJSON('/api/agents-config/update', { agentId, alsoAllow: checked });
    showNotification('Tools saved for ' + agentId);
  } catch(e){ showNotification('Failed: ' + e.message, true); }
}

// Single source of truth for all preset options — used by both new-agent form and edit cards
const PRESET_OPTIONS = [
  { value: 'frontend',    label: '🎨 Frontend (HTML/CSS/JS)' },
  { value: 'backend',     label: '⚙️ Backend (Node/API/scripts)' },
  { value: 'fullstack',   label: '🧱 Full-stack coder' },
  { value: 'ios',         label: '📱 iOS / Swift developer' },
  { value: 'android',     label: '🤖 Android / Kotlin developer' },
  { value: 'devops',      label: '🔧 DevOps / Infrastructure' },
  { value: 'data',        label: '📊 Data / Analytics / Python' },
  { value: 'security',    label: '🛡️ Security auditor' },
  { value: 'qa',          label: '🧪 QA / tester' },
  { value: 'github',      label: '🐙 Git & GitHub ops' },
  { value: 'writer',      label: '✍️ Content / copywriter' },
  { value: 'design',      label: '🖌️ UI/UX designer' },
  { value: 'pm',          label: '📋 Product manager / planner' },
  { value: 'aiml',        label: '🤖 AI / ML engineer' },
  { value: 'api',         label: '🔌 API designer (REST/GraphQL)' },
  { value: 'database',    label: '🗄️ Database specialist' },
  { value: 'reactnative', label: '📱 React Native (cross-platform)' },
  { value: 'web3',        label: '🌐 Web3 / Blockchain (Solidity)' },
  { value: 'automation',  label: '🕷️ Automation / scraping' },
  { value: 'docs',        label: '📖 Technical docs writer' },
  { value: 'orchestrator', label: '🧠 Orchestrator / PM loop' },
  { value: 'lead',        label: '🦊 Team lead / coordinator' },
  { value: 'main',        label: '⚡ Main agent (general)' },
];
function buildPresetOptions(placeholder) {
  var ph = placeholder || 'Presets\u2026';
  var opts = PRESET_OPTIONS.map(function(p){ return '<option value="' + p.value + '">' + p.label + '</option>'; }).join('');
  return '<option value="">' + ph + '</option>' + opts;
}

const PROMPT_PRESETS = {
  frontend: `Frontend implementation specialist. Apple/Linear/Vercel-level polish is the baseline.

## Design standard
- Typography: system font stack or Inter. 16-18px body, 1.5 line-height. Weight hierarchy (400/500/600/700).
- Spacing: 8px grid. Section padding 48-96px. Let content breathe.
- Color: muted neutrals + one accent. Dark mode via CSS custom properties. No pure black (#000).
- Motion: 200-300ms ease-out. Fade + translateY for reveals. Respect prefers-reduced-motion.
- Layout: mobile-first, CSS Grid + Flexbox, max-width 1200px. Full-bleed hero sections.
- Components: rounded corners (8-12px), soft layered shadows, no hard borders.
- Accessibility: semantic HTML, focus-visible, 4.5:1 contrast, aria-labels.

## Research — use these sources
- @@WEB_FETCH https://developer.apple.com/design/human-interface-guidelines for Apple HIG
- @@WEB_SEARCH site:uiverse.io [component] for copy-pasteable HTML/CSS examples (7000+ free)
- @@WEB_SEARCH site:css-tricks.com [technique] for CSS guides
- @@WEB_SEARCH awwwards [page type] OR onepagelove [page type] for design inspiration
- @@WEB_FETCH https://developer.mozilla.org/en-US/docs/Web/CSS/[property] for CSS reference
- @@WEB_SEARCH site:codepen.io [component] vanilla CSS for interactive examples

## Rules
- ALWAYS read existing files before editing. Match the design system in place.
- If no design system exists, establish CSS custom properties (--color-*, --space-*, --radius-*).
- Test mental model: 375px, 768px, 1440px — all three must look intentional.`,

  backend: `Backend specialist. Node.js, APIs, databases, server logic.

## Standards
- ES modules, async/await, no callbacks. Prefer native Node APIs over dependencies.
- Every endpoint: input validation, error handling, proper HTTP status codes, structured JSON responses.
- Database: parameterized queries only (never string interpolation), connection pooling, transactions for multi-step writes.
- Auth: bcrypt/argon2 for passwords, JWT with short expiry + refresh tokens. Never plaintext.
- Logging: structured (JSON), include request ID, timestamp, level.
- Config via env vars, never hardcoded secrets. Validate required env vars at startup.
- @@WEB_SEARCH for library APIs and docs when using packages you haven't used recently.

## Rules
- ALWAYS read existing files before editing. Match patterns and naming.
- Think about failures: what happens when the request fails, DB is down, or input is malformed?`,

  fullstack: `Full-stack coding specialist. Clean, readable code across the entire stack.

## Standards
- Small functions, clear names, no dead code. Error handling everywhere.
- ES modules (import/export), async/await. Match existing code patterns.
- Frontend: semantic HTML, accessible, responsive. Backend: validate inputs, handle errors, proper status codes.
- @@WEB_SEARCH for API docs and library usage when using unfamiliar packages.

## Rules
- ALWAYS read existing files before editing — understand what exists.
- Surgical edits only — change what's asked, nothing else.
- Trace the happy path and one error path mentally before reporting done.`,

  qa: `QA specialist. Systematic audits backed by evidence from the actual code.

## Process
1. @@READ_FILE every file you audit — no exceptions
2. Check against: error handling, input validation, edge cases, security, performance, correctness
3. Report ONLY issues you can point to in the actual code with real line numbers

## Output format
### CRITICAL — Line N: [issue] → Fix: [exact code]
### HIGH — Line N: [issue] → Fix: [exact code]
### MEDIUM / LOW
### Summary: X issues. Verdict: PASS / PASS WITH WARNINGS / FAIL

## Rules
- Do NOT invent line numbers. Only cite what you read.
- CRITICAL issues = FAIL verdict. No exceptions.
- You are NOT a coordinator — do NOT use @@DISPATCH.
- @@WEB_SEARCH best practices or known vulnerability patterns when unsure.`,

  github: `Git and GitHub specialist.

## Before any operation
- git status, git config user.name, git config user.email
- For PRs: gh auth status

## Commit standard
- Conventional commits: feat(scope):, fix(scope):, chore:, docs:, refactor:, test:
- Subject ≤72 chars. Body explains WHY, not what.
- Stage specific files — never git add -A unless asked.
- Never commit: .env, *.pem, *credentials*, API keys.

## Rules
- Never force-push to main or master.
- Always git diff --stat before committing.
- One logical change per commit.`,

  writer: `Content and copywriting specialist.

## Voice
- Clear, confident, human. Short sentences. Active voice. Cut every word that doesn't earn its place.
- Headlines: benefit-first, specific, no jargon. "Ship 10x faster" beats "Leverage AI-powered solutions."
- No buzzwords: leverage, synergy, cutting-edge, revolutionary, seamless, robust.
- No filler: "In today's fast-paced world..." — delete it.
- Numbers > adjectives. "3 agents, 12 seconds" beats "multiple agents, incredibly fast."

## Research — mandatory
- @@WEB_SEARCH competitors, market positioning, and facts BEFORE writing. Never invent claims.
- @@WEB_FETCH reference sites for tone/style inspiration.

## Rules
- ALWAYS @@WRITE_FILE your output — never just show text in chat.
- Read existing content first to match voice. After draft, cut 30%.`,

  ios: `iOS/Swift specialist. SwiftUI, UIKit, and native Apple platform code.

## Standards
- SwiftUI for new views unless the project uses UIKit exclusively.
- Swift naming: camelCase vars, PascalCase types. async/await over completion handlers.
- Use @MainActor for UI updates. Structured concurrency with TaskGroup when appropriate.
- Follow MVVM with ObservableObject/Observable. Keep views thin.
- @@WEB_SEARCH Apple developer docs and WWDC sessions for current APIs.

## Rules
- ALWAYS read existing Swift files before editing.
- Handle optionals safely — guard let / if let, never force-unwrap in production.
- Support Dynamic Type and VoiceOver accessibility.`,

  android: `Android/Kotlin specialist. Jetpack Compose, Android SDK, and modern Android architecture.

## Standards
- Jetpack Compose for new UI unless the project uses XML layouts.
- Architecture: MVVM with ViewModel, StateFlow/SharedFlow, Hilt for DI.
- Coroutines and Flow for async. Structured concurrency with viewModelScope.
- Follow Material 3 design guidelines.
- @@WEB_SEARCH Android developer docs for current API patterns and Compose components.

## Rules
- ALWAYS read existing files before editing. Match architecture patterns.
- Handle configuration changes properly. Test on multiple screen sizes.`,

  devops: `DevOps and infrastructure specialist. CI/CD, Docker, shell scripts, IaC.

## Standards
- Idempotent scripts — safe to run multiple times.
- Dockerfiles: multi-stage builds, non-root user, minimal base images, .dockerignore.
- CI/CD: fail fast, cache dependencies, pin action versions.
- IaC: Terraform state management, modular configs, no hardcoded values.
- @@WEB_SEARCH current best practices for tools and cloud services.

## Rules
- ALWAYS read existing configs before editing. Never blindly overwrite deployment configs.
- Secrets in env vars or secret managers, never in source.
- Write clear inline comments in all scripts and configs.`,

  data: `Data and analytics specialist. Python, SQL, pandas, data pipelines.

## Standards
- Clean Python with type hints and docstrings. Validate inputs, handle nulls explicitly.
- pandas/polars for transformation, matplotlib/plotly for visualization.
- SQL: parameterized queries, CTEs for readability, explain plans for optimization.
- @@WEB_SEARCH for library APIs, dataset documentation, and statistical methods.

## Rules
- ALWAYS read existing data files and schemas before writing code.
- NEVER overwrite raw data. Transform into new files/tables.
- Reproducibility: set random seeds, log parameters, version datasets.`,

  security: `Security auditor. OWASP-aware, evidence-based.

## Audit checklist
- Secrets: hardcoded API keys/tokens/passwords, .env in source, secrets in logs or client code
- Injection: SQL string concat, unescaped user input (XSS), user input in exec/spawn, path traversal
- Auth: missing auth on protected routes, broken sessions, privilege escalation, CORS misconfiguration
- Data: plaintext passwords, sensitive data in URLs, missing rate limiting, no input validation
- @@WEB_SEARCH to verify if a pattern is actually exploitable when unsure

## Rules
- @@READ_FILE every file before reporting. Never guess.
- Report only — NEVER modify files.
- Output: severity + file:line + vulnerability + exact remediation.
- Overall risk: CRITICAL / HIGH / MODERATE / LOW.`,

  design: `UI/UX design and implementation specialist. You ship premium, production-ready interfaces.

## Design DNA — Apple.com, Linear.app, Vercel.com, Stripe.com level quality.
- Reduction: remove every element that doesn't serve the user's goal. White space is a feature.
- Typography: Inter or system stack. Scale 14/16/20/28/40/56px. Weight 400/500/600/700. Line-height 1.5 body, 1.2 display.
- Color: neutrals (gray-50→950) + one accent. Dark mode first via custom properties. No pure #000.
- Spacing: 8px grid. Sections 64-96px vertical pad. Cards 24-32px. CSS gap everywhere.
- Shadows: layered — sm (0 1px 2px), md (0 4px 16px), lg (0 12px 48px). rgba(0,0,0,0.06-0.12).
- Motion: 200ms ease-out on interactive elements. Fade + translateY(8px) for reveals. Skeleton screens over spinners.
- Layout: mobile-first (640/768/1024/1280). Max-width 1200px. CSS Grid pages, Flexbox components.

## Research — use these sources
- @@WEB_FETCH https://developer.apple.com/design/human-interface-guidelines for Apple HIG
- @@WEB_SEARCH site:uiverse.io [component] for copy-pasteable HTML/CSS examples (7000+ free)
- @@WEB_SEARCH site:css-tricks.com [technique] for CSS technique guides
- @@WEB_SEARCH awwwards [page type] OR onepagelove [page type] for design inspiration
- @@WEB_SEARCH site:codepen.io [component] vanilla CSS for interactive examples

## Rules
- Accessible: focus-visible, aria-labels, 4.5:1 contrast, semantic HTML.`,

  pm: `Product manager and project planner. Task decomposition and roadmap management.

## Planning principles
- Every task: independently deliverable. If it can't be tested alone, split it.
- Imperative form: "Create X", "Add Y to Z", "Fix W in file F". Never "Improve" or "Look into."
- Each task → one agent, one file path, one deliverable.
- Include acceptance criteria: what does done look like? What should the agent verify?
- Task size: completable in 1-2 minutes of LLM work. Bigger = split.

## Anti-patterns
- "Improve the landing page" → too vague. Which section? What's wrong?
- "Set up the backend" → too broad. Which endpoint? What data? What auth?
- Tasks without file paths → agent won't know where to work.

## Rules
- Flag missing requirements before handoff.
- @@WEB_SEARCH to research approaches for unfamiliar features.
- Update ROADMAP.md with [ ] checkboxes.`,

  aiml: `AI/ML engineering specialist. Model training, fine-tuning, eval, and MLOps.

## Standards
- Reproducibility: set random seeds, log all hyperparameters, version datasets.
- Data: validate schema before training. Check for nulls, duplicates, class imbalance.
- Training: early stopping, gradient clipping, learning rate scheduling.
- Evaluation: never eval on training data. Hold out test set. Report confidence intervals.
- Code: type hints, docstrings on public APIs, structured logging.

## Research — critical for ML
- @@WEB_SEARCH for model cards, API docs, library versions before implementation.
- @@WEB_FETCH HuggingFace docs, paper abstracts, or API references.
- @@WEB_SEARCH "[library] breaking changes" when using specific versions.

## Rules
- ALWAYS read existing code before modifying. Pin dependency versions.
- Never hardcode paths to datasets or models — use env vars or config.`,

  api: `API design specialist. REST and GraphQL APIs.

## Standards
- OpenAPI/Swagger specs for all new endpoints. Schema-first design.
- REST: correct HTTP verbs (GET=read, POST=create, PUT=replace, PATCH=update, DELETE=remove).
- Status codes: 200 OK, 201 Created, 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, 422 Unprocessable, 429 Rate Limited, 500 Server Error.
- Consistent naming: plural nouns for resources (/users, /orders), kebab-case.
- Pagination: cursor-based for large datasets. Include total count and next/prev links.
- Versioning: URL prefix (/v1/) or Accept header.
- @@WEB_SEARCH site:swagger.io/docs [topic] for OpenAPI spec reference.
- @@WEB_FETCH https://developer.mozilla.org/en-US/docs/Web/HTTP/Status for status codes.

## Rules
- ALWAYS read existing routes and schemas before adding new ones. Match patterns.
- Output both the spec and a working implementation stub.`,

  database: `Database specialist. SQL, migrations, indexes, and query optimization.

## Standards
- Idempotent migrations (safe to re-run). Use IF NOT EXISTS / IF EXISTS guards.
- Indexes: all foreign keys, frequently queried columns, composite indexes for common WHERE+ORDER BY.
- Naming: snake_case tables, singular (user not users). FK: target_table_id. Index: idx_table_column.
- Always explain query plans for optimization changes.
- @@WEB_SEARCH site:use-the-index-luke.com [topic] for SQL indexing best practices.
- @@WEB_SEARCH [database engine] documentation [topic] for engine-specific syntax.

## Rules
- ALWAYS read existing schema before writing migrations.
- NEVER drop columns or tables without explicit instruction.
- Transactions for multi-table changes. Rollback strategy for every migration.`,

  reactnative: `React Native specialist. Cross-platform mobile with Expo or bare RN.

## Standards
- Functional components with hooks. StyleSheet.create for all styles.
- Navigation: React Navigation with typed routes. Deep linking support.
- State: Zustand or React Query for server state. Context sparingly.
- Platform differences: Platform.select, Platform.OS checks, platform-specific files (.ios.tsx/.android.tsx).
- @@WEB_SEARCH React Native docs and Expo SDK for current APIs.

## Rules
- ALWAYS read existing components and navigation before editing.
- Test mental model on both iOS and Android.
- Handle safe areas, keyboard avoidance, and different screen sizes.`,

  web3: `Web3 and blockchain specialist. Solidity smart contracts and dApp frontends.

## Standards
- Storage layout: NEVER change variable order in upgradeable contracts.
- NatSpec comments on all public and external functions.
- OpenZeppelin for standard patterns (ERC20, ERC721, AccessControl, Ownable).
- Gas optimization: pack storage vars, use calldata over memory for read-only, avoid loops over unbounded arrays.
- @@WEB_SEARCH site:docs.openzeppelin.com [pattern] for audited contract implementations.
- @@WEB_SEARCH EIP-[number] for Ethereum standard specifications.

## Rules
- ALWAYS read existing contracts before editing.
- Test all contracts with Hardhat or Foundry before reporting done.
- Check: reentrancy guards, integer overflow (Solidity 0.8+ safe), access control on state-changing functions.`,

  automation: `Automation and web scraping specialist. Playwright, Puppeteer, Python scrapers.

## Standards
- Playwright for JS-heavy sites, requests+BeautifulSoup for static HTML.
- Always check for APIs first (@@WEB_SEARCH) — scraping is the fallback, not the default.
- Handle: pagination, login flows, dynamic content, CAPTCHAs (flag, don't bypass).
- Retry logic with exponential backoff for flaky requests.
- @@WEB_FETCH to read a page before deciding the scraping approach.

## Rules
- Store raw data before transforming — never lose the source.
- Respect robots.txt and rate-limit requests (1-2 req/sec default).
- Output structured data (JSON/CSV) with clear field names.`,

  docs: `Technical documentation writer. API docs, READMEs, developer guides.

## Standards
- Write for the reader — assume minimal context, include working examples.
- Structure: Overview → Installation → Quick Start → Usage → API Reference → Examples → Troubleshooting.
- Code examples must be copy-pasteable and actually work.
- @@WEB_SEARCH for prior art, best practices, or similar docs for reference.
- @@WEB_FETCH specific doc pages before paraphrasing or referencing.

## Rules
- ALWAYS read the code you're documenting before writing.
- Keep docs in sync with implementation — flag discrepancies.
- Markdown output unless another format is requested.
- No fluff paragraphs. Scannable: headers, bullets, code blocks.`,

  orchestrator: `PM loop orchestrator. Roadmap reading, task expansion, specialist routing.

## Standards
- Break each roadmap item into a single, scoped, actionable task.
- Include exact file paths and acceptance criteria in every task.
- Route to the right specialist based on work type.
- @@WEB_SEARCH to research approaches for unfamiliar features.

## Rules
- NEVER implement tasks yourself — planning and delegation only.
- Keep task descriptions under 200 words.
- Mark items done only after confirmation from the executing agent.`,

  lead: `Team lead and coordinator. Delegation, progress tracking, blocker escalation.

## Rules
- Assign tasks to the right agent based on their specialty.
- Track what's in progress and what's blocked.
- Escalate failures to crew-fixer and report status.
- Do NOT implement tasks yourself — delegate everything.
- Communicate clearly: who is doing what, and what's blocked.`,

  main: `Main agent and general-purpose coordinator. Fallback for tasks that don't fit a specialist.

## Rules
- Triage requests — handle directly or delegate to the right specialist.
- @@WEB_SEARCH and @@WEB_FETCH for research tasks.
- Write and edit files directly for general tasks.
- Keep responses concise and action-oriented.
- You're the catch-all — if something falls through the cracks, you handle it.`,
};

const PRESET_META = {
  frontend:    { id: 'crew-coder-front', name: 'Frontend Coder',    emoji: '🎨' },
  backend:     { id: 'crew-coder-back',  name: 'Backend Coder',     emoji: '⚙️' },
  fullstack:   { id: 'crew-coder',       name: 'Full-stack Coder',  emoji: '🧱' },
  ios:         { id: 'crew-coder-ios',   name: 'iOS Coder',         emoji: '📱' },
  android:     { id: 'crew-coder-android', name: 'Android Coder',   emoji: '🤖' },
  devops:      { id: 'crew-devops',      name: 'DevOps Engineer',   emoji: '🔧' },
  data:        { id: 'crew-data',        name: 'Data Engineer',     emoji: '📊' },
  security:    { id: 'crew-security',    name: 'Security Auditor',  emoji: '🛡️' },
  qa:          { id: 'crew-qa',          name: 'QA Tester',         emoji: '🧪' },
  github:      { id: 'crew-github',      name: 'Git Ops',           emoji: '🐙' },
  writer:      { id: 'crew-copywriter',  name: 'Copywriter',        emoji: '✍️' },
  design:      { id: 'crew-design',      name: 'UI/UX Designer',    emoji: '🖌️' },
  pm:          { id: 'crew-pm-agent',    name: 'Product Manager',   emoji: '📋' },
  aiml:        { id: 'crew-aiml',        name: 'AI/ML Engineer',    emoji: '🤖' },
  api:         { id: 'crew-api',         name: 'API Designer',      emoji: '🔌' },
  database:    { id: 'crew-database',    name: 'Database Specialist', emoji: '🗄️' },
  reactnative: { id: 'crew-rn',          name: 'React Native Dev',  emoji: '📱' },
  web3:        { id: 'crew-web3',        name: 'Web3 Engineer',     emoji: '🌐' },
  automation:  { id: 'crew-automation',  name: 'Automation Bot',    emoji: '🕷️' },
  docs:        { id: 'crew-docs',        name: 'Docs Writer',       emoji: '📖' },
  orchestrator: { id: 'orchestrator',   name: 'Orchestrator',      emoji: '🧠' },
  lead:        { id: 'crew-lead',       name: 'Crew Lead',         emoji: '🦊' },
  main:        { id: 'crew-main',       name: 'Main Agent',        emoji: '⚡' },
};

window.applyPromptPreset = function() {
  const val = document.getElementById('naPromptPreset').value;
  if (!val || !PROMPT_PRESETS[val]) return;
  document.getElementById('naPrompt').value = PROMPT_PRESETS[val];
  const meta = PRESET_META[val];
  if (meta) {
    const idEl    = document.getElementById('naId');
    const nameEl  = document.getElementById('naName');
    const emojiEl = document.getElementById('naEmoji');
    if (idEl    && !idEl.value)    idEl.value    = meta.id;
    if (nameEl  && !nameEl.value)  nameEl.value  = meta.name;
    if (emojiEl && !emojiEl.value) emojiEl.value = meta.emoji;
  }
  // Auto-fill role/theme from the preset's display label (strip leading emoji)
  const themeEl = document.getElementById('naTheme');
  if (themeEl) {
    const opt = PRESET_OPTIONS.find(p => p.value === val);
    if (opt) themeEl.value = opt.label.replace(/^[\u{1F000}-\u{1FFFF}\u2600-\u27BF\uFE0F\u20D0-\u20FF\s]+/u, '').trim();
  }
};

// Models confirmed broken via API testing — return empty strings
const BROKEN_MODELS = new Set([
  'groq/openai/gpt-oss-120b',
  'groq/openai/gpt-oss-20b',
]);

// Role classification for badge display
const MODEL_ROLE = {
  'crew-pm': 'THINKER', 'crew-architect': 'THINKER', 'crew-ml': 'THINKER',
  'crew-coder': 'EXECUTOR', 'crew-coder-back': 'EXECUTOR', 'crew-coder-front': 'EXECUTOR',
  'crew-frontend': 'EXECUTOR', 'crew-fixer': 'EXECUTOR',
  'crew-lead': 'COORDINATOR', 'crew-main': 'COORDINATOR', 'orchestrator': 'COORDINATOR',
  'crew-qa': 'ANALYST', 'crew-security': 'ANALYST', 'crew-mega': 'ANALYST',
  'crew-researcher': 'RESEARCHER',
};
const ROLE_STYLE = {
  THINKER:    'background:rgba(139,92,246,0.12);border:1px solid rgba(139,92,246,0.35);color:#a78bfa;',
  EXECUTOR:   'background:rgba(34,197,94,0.10);border:1px solid rgba(34,197,94,0.30);color:var(--green-hi);',
  COORDINATOR:'background:rgba(56,189,248,0.10);border:1px solid rgba(56,189,248,0.30);color:var(--accent);',
  ANALYST:    'background:rgba(251,191,36,0.10);border:1px solid rgba(251,191,36,0.30);color:var(--yellow);',
  RESEARCHER: 'background:rgba(249,115,22,0.10);border:1px solid rgba(249,115,22,0.30);color:#fb923c;',
};

function populateModelDropdown(selectId, currentVal) {
  const sel = document.getElementById(selectId);
  sel.innerHTML = '<option value="">— select a model —</option>';
  if (Object.keys(_modelsByProvider).length) {
    // Grouped by provider
    for (const [provider, models] of Object.entries(_modelsByProvider)) {
      const grp = document.createElement('optgroup');
      grp.label = provider.toUpperCase();
      models.forEach(({ id, name }) => {
        const full = provider + '/' + id;
        const broken = BROKEN_MODELS.has(full);
        const opt = document.createElement('option');
        opt.value = full;
        opt.textContent = (broken ? '⚠ BROKEN — ' : '') + (name ? (name + '  (' + id + ')') : full);
        if (broken) opt.style.color = 'var(--red-hi)';
        if (full === currentVal) opt.selected = true;
        grp.appendChild(opt);
      });
      sel.appendChild(grp);
    }
  } else {
    _allModels.forEach(m => {
      const broken = BROKEN_MODELS.has(m);
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = (broken ? '⚠ BROKEN — ' : '') + m;
      if (broken) opt.style.color = 'var(--red-hi)';
      if (m === currentVal) opt.selected = true;
      sel.appendChild(opt);
    });
  }
  // If current value not in list, add it as custom
  if (currentVal && !_allModels.includes(currentVal)) {
    const opt = document.createElement('option');
    opt.value = currentVal; opt.textContent = currentVal + ' (custom)';
    opt.selected = true;
    sel.prepend(opt);
  }
}

document.getElementById('newAgentBtn').onclick = () => {
  document.getElementById('newAgentForm').style.display = 'block';
  populateModelDropdown('naModel', '');
  // Populate preset dropdown dynamically (can't be server-rendered since PRESET_OPTIONS is client-side)
  const sel = document.getElementById('naPromptPreset');
  if (sel && sel.options.length <= 1) {
    PRESET_OPTIONS.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.value; opt.textContent = p.label;
      sel.appendChild(opt);
    });
  }
};
document.getElementById('naCancelBtn').onclick = () => {
  document.getElementById('newAgentForm').style.display = 'none';
};
document.getElementById('naCreateBtn').onclick = async () => {
  const id          = document.getElementById('naId').value.trim();
  const model       = document.getElementById('naModel').value.trim();
  const name        = document.getElementById('naName').value.trim();
  const emoji       = document.getElementById('naEmoji').value.trim();
  const theme       = document.getElementById('naTheme').value.trim();
  const systemPrompt = document.getElementById('naPrompt').value.trim();
  const naTools = [...document.querySelectorAll('.naToolCheck:checked')].map(cb => cb.dataset.tool);
  const alsoAllow = naTools.length ? naTools : getToolDefaults(id);
  if (!id || !model){ showNotification('Agent ID and model are required', true); return; }
  try {
    await postJSON('/api/agents-config/create', { id, model, name, emoji, theme, systemPrompt, alsoAllow });
    showNotification(`Agent "${id}" created — restart gateway-bridge to activate it on the RT bus.`);
    document.getElementById('newAgentForm').style.display = 'none';
    ['naId','naName','naTheme','naPrompt'].forEach(x => { document.getElementById(x).value = ''; });
    document.getElementById('naEmoji').value = '🔥';
    document.getElementById('naEmoji-btn').textContent = '🔥';
    document.getElementById('naModel').innerHTML = '<option value="">— select a model —</option>';
    document.getElementById('naPromptPreset').value = '';
    loadAgents_cfg();
  } catch(e){ showNotification('Failed: ' + e.message, true); }
};
document.getElementById('refreshAgentsBtn').onclick = loadAgents_cfg;
// ── End agents UI ──────────────────────────────────────────────────────────
const PROVIDER_ICONS = { opencode:'🚀', groq:'⚡', nvidia:'🎮', ollama:'🏠', 'openai-local':'🟢', xai:'𝕏', google:'🔵', deepseek:'🌊', openai:'🟢', perplexity:'🔍', cerebras:'🧠', mistral:'🌀', together:'🤝', cohere:'🔶', anthropic:'🟣' };
async function loadProviders(){
  const list = document.getElementById('providersList');
  list.innerHTML = '<div class="meta" style="padding:20px;">Loading providers...</div>';
  try {
    const data = await getJSON('/api/providers');
    const providers = data.providers || [];
    if (!providers.length){ list.innerHTML = '<div class="meta" style="padding:20px;">No providers found. Check ~/.crewswarm/crewswarm.json</div>'; return; }
    list.innerHTML = '';
    providers.forEach(p => {
      const icon = PROVIDER_ICONS[p.id] || '🔌';
      const hasKey = p.hasKey;
      const badgeColor = hasKey ? '#10b981' : 'var(--red-hi)';
      const badgeText = hasKey ? '✓ key set' : '✗ no key';
      const card = document.createElement('div');
      card.className = 'provider-card';
      card.innerHTML = `
        <div class="provider-header" data-toggle-sibling="open">
          <span style="font-size:20px;">${icon}</span>
          <div style="flex:1;">
            <strong style="font-size:15px;">${p.id}</strong>
            <span class="meta" style="margin-left:10px;">${p.baseUrl}</span>
          </div>
          <span class="provider-badge" style="background:${badgeColor}20; color:${badgeColor}; border:1px solid ${badgeColor}40;">${badgeText}</span>
          <span class="meta" style="margin-left:12px;">${p.models.length} model${p.models.length !== 1 ? 's' : ''}</span>
          <span style="color:#64748b; margin-left:8px;">▼</span>
        </div>
        <div class="provider-body">
          <div class="key-row">
            <input class="key-input" type="password" autocomplete="new-password" id="key_${p.id}" value="${p.maskedKey || ''}" placeholder="Paste API key…" />
            <button data-action="toggleKeyVis" data-arg="key_${p.id}" data-self="1" style="background:#334155; padding:6px 10px; font-size:12px;">👁</button>
            <button data-action="saveKey" data-arg="${p.id}" style="background:#6366f1; padding:6px 14px; font-size:12px;">Save</button>
            <button data-action="testKey" data-arg="${p.id}" style="background:#334155; padding:6px 10px; font-size:12px;">Test</button>
            <button data-action="fetchModels" data-arg="${p.id}" data-self="1" style="background:#0f766e; padding:6px 10px; font-size:12px;">↻ Fetch models</button>
            <span id="test_${p.id}"></span>
          </div>
          <div style="margin-bottom:8px;"><span class="meta">Base URL: </span><code style="font-size:11px; color:#94a3b8;">${p.baseUrl}</code></div>
          <div><span class="meta" style="display:block; margin-bottom:6px;">Models (<span id="mcount_${p.id}">${p.models.length}</span>):</span><span id="mtags_${p.id}">${p.models.map(m => '<span class="model-tag">' + m.id + '</span>').join('')}</span></div>
          ${p.models.length === 0 ? '<div class="meta" style="margin-top:8px; color:var(--amber);" id="mnone_${p.id}">No models yet — click ↻ Fetch models</div>' : ''}
        </div>
      `;
      list.appendChild(card);
    });
  } catch(e){ list.innerHTML = '<div class="meta" style="padding:20px; color:var(--red-hi);">Error: ' + e.message + '</div>'; }
}
function toggleKeyVis(inputId, btn){
  const inp = document.getElementById(inputId);
  inp.type = inp.type === 'password' ? 'text' : 'password';
  btn.textContent = inp.type === 'password' ? '👁' : '🙈';
}
async function saveKey(providerId){
  const inp = document.getElementById('key_' + providerId);
  const key = inp.value.trim();
  if (!key){ showNotification('Key is empty', true); return; }
  try {
    await postJSON('/api/providers/save', { providerId, apiKey: key });
    showNotification('Saved key for ' + providerId);
    loadProviders();
  } catch(e){ showNotification('Failed: ' + e.message, true); }
}
async function testKey(providerId){
  const statusEl = document.getElementById('test_' + providerId);
  statusEl.textContent = 'testing…';
  statusEl.className = 'meta';
  try {
    const r = await postJSON('/api/providers/test', { providerId });
    statusEl.textContent = r.ok ? '✓ ' + (r.model || 'ok') : '✗ ' + r.error;
    statusEl.className = r.ok ? 'test-ok' : 'test-err';
  } catch(e){ statusEl.textContent = '✗ ' + e.message; statusEl.className = 'test-err'; }
}
async function fetchModels(providerId, btn){
  const statusEl = document.getElementById('test_' + providerId);
  const origText = btn.textContent;
  btn.textContent = 'Fetching…';
  btn.disabled = true;
  if (statusEl) statusEl.textContent = '';
  try {
    const r = await postJSON('/api/providers/fetch-models', { providerId });
    if (r.ok) {
      const tags = document.getElementById('mtags_' + providerId);
      const count = document.getElementById('mcount_' + providerId);
      const none = document.getElementById('mnone_' + providerId);   // old provider-card style
      const wrap = document.getElementById('mwrap_' + providerId);   // new unified-list style
      if (tags)  tags.innerHTML = r.models.map(m => '<span class="model-tag">' + m + '</span>').join('');
      if (count) count.textContent = r.models.length;
      if (none)  none.style.display = 'none';
      if (wrap)  wrap.style.display = 'block';
      if (statusEl) { statusEl.textContent = '✓ ' + r.models.length + ' models'; statusEl.className = 'test-ok'; }
      loadAgents(); // refresh agent model dropdowns
    } else {
      if (statusEl) { statusEl.textContent = '✗ ' + r.error; statusEl.className = 'test-err'; }
    }
  } catch(e){
    if (statusEl) { statusEl.textContent = '✗ ' + e.message; statusEl.className = 'test-err'; }
  }
  finally { btn.textContent = origText; btn.disabled = false; }
}
document.getElementById('addProviderBtn').onclick = () => {
  const form = document.getElementById('addProviderForm');
  form.style.display = 'block';
  setTimeout(() => form.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  const firstInput = form.querySelector('input');
  if (firstInput) setTimeout(() => firstInput.focus(), 150);
};
document.getElementById('apCancelBtn').onclick = () => {
  document.getElementById('addProviderForm').style.display = 'none';
};
document.getElementById('apSaveBtn').onclick = async () => {
  const id = document.getElementById('apId').value.trim();
  const baseUrl = document.getElementById('apBaseUrl').value.trim();
  const apiKey = document.getElementById('apKey').value.trim();
  const api = document.getElementById('apApi').value;
  if (!id || !baseUrl){ showNotification('ID and Base URL are required', true); return; }
  try {
    await postJSON('/api/providers/add', { id, baseUrl, apiKey, api });
    showNotification('Provider added: ' + id);
    document.getElementById('addProviderForm').style.display = 'none';
    loadBuiltinProviders(); // unified list re-renders with new custom provider appended
  } catch(e){ showNotification('Failed: ' + e.message, true); }
};
document.getElementById('refreshProvidersBtn').onclick = loadBuiltinProviders;
function showBuild(){
  hideAllViews();
  document.getElementById('buildView').classList.add('active');
  setNavActive('navBuild');
  loadPhasedProgress();
}
function showProjects(){
  hideAllViews();
  document.getElementById('projectsView').classList.add('active');
  setNavActive('navProjects');
  loadProjects();
}
// Project registry cache — populated by loadProjects, used by delegated handler
let _projectsData = {};

async function loadProjects(){
  const list = document.getElementById('projectsList');
  list.innerHTML = '<div class="meta" style="padding:20px;">Loading projects...</div>';
  try {
    const data = await getJSON('/api/projects');
    const projects = data.projects || [];
    _projectsData = {};
    projects.forEach(p => { _projectsData[p.id] = p; });
    populateChatProjectDropdown(projects);
    if (!projects.length) {
      list.innerHTML = '<div class="meta" style="padding:20px;">No projects yet. Click &quot;+ New Project&quot; to create one.</div>';
      return;
    }
    // Build HTML using ONLY data-action + data-id on buttons — zero dynamic data in onclick strings
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

    // Wire Enter key on quick-add inputs
    list.querySelectorAll('[data-rm-add-id]').forEach(inp => {
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') addRoadmapItem(inp.dataset.rmAddId); });
    });

  } catch(e) { list.innerHTML = '<div class="meta" style="padding:20px;color:var(--red-hi);">Failed to load projects: ' + escHtml(e.message) + '</div>'; }
}

function toggleProjectEdit(projectId) {
  const viewEl = document.getElementById('proj-view-' + projectId);
  const editEl = document.getElementById('proj-edit-' + projectId);
  if (!viewEl || !editEl) return;
  const isEditing = editEl.style.display !== 'none';
  viewEl.style.display = isEditing ? '' : 'none';
  editEl.style.display = isEditing ? 'none' : 'block';
}

async function saveProjectEdit(projectId) {
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

// Single delegated click handler — replaces ALL onclick strings in project cards
document.getElementById('projectsList').addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id   = btn.dataset.id;
  const proj = _projectsData[id];
  switch (btn.dataset.action) {
    case 'pm-toggle':    proj && proj.running ? stopProjectPMLoop(id) : startProjectPMLoop(id); break;
    case 'open-build':   openProjectInBuild(id); break;
    case 'edit-roadmap': proj && openRoadmapEditor(id, proj.roadmapFile); break;
    case 'retry-failed': proj && retryFailed(proj.roadmapFile); break;
    case 'delete':       deleteProject(id); break;
    case 'chat-project': {
      const name = btn.dataset.name || id;
      showChat();
      // Auto-select this project in the chat dropdown
      autoSelectChatProject(id);
      const inp = document.getElementById('chatInput');
      inp?.focus();
      break;
    }
    case 'toggle-auto-advance': {
      const checked = btn.checked;
      postJSON('/api/projects/update', { projectId: id, autoAdvance: checked })
        .then(() => {
          if (_projectsData[id]) _projectsData[id].autoAdvance = checked;
          showNotification('Auto-advance ' + (checked ? 'enabled' : 'disabled') + ' for ' + (proj?.name || id));
        })
        .catch(e => { showNotification('Failed: ' + e.message, true); btn.checked = !checked; });
      return; // don't prevent default on checkbox
    }
    case 'edit':             toggleProjectEdit(id); break;
    case 'save-project-edit': saveProjectEdit(id); break;
    case 'cancel-project-edit': toggleProjectEdit(id); break;
    case 'add-item':     addRoadmapItem(id); break;
    case 'skip-next':    skipNextItem(id); break;
    case 'reset-failed': resetAllFailed(id); break;
    case 'save-roadmap': saveRoadmap(id); break;
    case 'close-editor': closeRoadmapEditor(id); break;
  }
});

// ── Chat project dropdown (next to input; persisted so it survives tab switch and reload) ───

const CHAT_ACTIVE_PROJECT_KEY = 'crewswarm_chat_active_project_id';
let _chatActiveProjectId = '';

function getStoredChatProjectId() {
  try { return localStorage.getItem(CHAT_ACTIVE_PROJECT_KEY) || ''; } catch { return ''; }
}
function setStoredChatProjectId(id) {
  try { if (id) localStorage.setItem(CHAT_ACTIVE_PROJECT_KEY, id); else localStorage.removeItem(CHAT_ACTIVE_PROJECT_KEY); } catch {}
}

function populateChatProjectDropdown(projects) {
  const sel = document.getElementById('chatProjectSelect');
  if (!sel) return;
  const prev = getStoredChatProjectId() || sel.value || _chatActiveProjectId;
  sel.innerHTML = '<option value="">— none —</option>';
  (projects || []).forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name + (p.outputDir ? ' (' + p.outputDir.split('/').pop() + ')' : '');
    sel.appendChild(opt);
  });
  if (prev && sel.querySelector('option[value="' + prev + '"]')) {
    sel.value = prev;
    _chatActiveProjectId = prev;
    setStoredChatProjectId(prev);
    // Sync config.json so gateway-bridge gets the right --dir even after a restart
    const restoredProj = _projectsData[prev];
    if (restoredProj && restoredProj.outputDir) {
      postJSON('/api/settings/opencode-project', { dir: restoredProj.outputDir }).catch(() => {});
    }
  } else {
    _chatActiveProjectId = '';
    setStoredChatProjectId('');
  }
  updateChatProjectHint();
}

function onChatProjectChange() {
  const sel = document.getElementById('chatProjectSelect');
  _chatActiveProjectId = sel ? sel.value : '';
  setStoredChatProjectId(_chatActiveProjectId);
  updateChatProjectHint();
  const proj = _projectsData[_chatActiveProjectId];
  if (proj && proj.outputDir) {
    postJSON('/api/settings/opencode-project', { dir: proj.outputDir }).catch(() => {});
  }
}

function updateChatProjectHint() {
  const hint = document.getElementById('chatProjectHint');
  if (!hint) return;
  if (_chatActiveProjectId && _projectsData[_chatActiveProjectId]) {
    const p = _projectsData[_chatActiveProjectId];
    hint.textContent = p.outputDir || '';
    hint.style.display = p.outputDir ? 'block' : 'none';
  } else {
    hint.style.display = 'none';
  }
}

function autoSelectChatProject(projectId) {
  _chatActiveProjectId = projectId;
  setStoredChatProjectId(projectId);
  const sel = document.getElementById('chatProjectSelect');
  if (sel && sel.querySelector('option[value="' + projectId + '"]')) {
    sel.value = projectId;
    updateChatProjectHint();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function resumeProject(projectId) {
  try {
    const resp = await fetch('/api/pm-loop/start', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ projectId }) });
    const r = await resp.json();
    if (r.alreadyRunning) { showNotification('PM Loop already running (pid ' + r.pid + ')', true); return; }
    showNotification('PM Loop started for project ' + projectId + ' (pid ' + r.pid + ')');
    setTimeout(loadProjects, 3000);
  } catch(e) { showNotification('Failed: ' + e.message, true); }
}
async function stopProjectPMLoop(projectId) {
  try {
    await postJSON('/api/pm-loop/stop', { projectId });
    showNotification('Stop signal sent — PM will finish current task then halt.');
    const statusEl = document.getElementById('proj-pm-status-' + projectId);
    if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = '⛔ Stopping after current task…'; }
    setTimeout(loadProjects, 3000);
  } catch(e) { showNotification('Stop failed: ' + e.message, true); }
}
async function startProjectPMLoop(projectId) {
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
    if (statusEl) { statusEl.style.display = 'none'; }
  }
}
async function deleteProject(projectId) {
  const proj = _projectsData[projectId];
  const name = proj ? proj.name : projectId;
  if (!confirm('Remove "' + name + '" from the dashboard registry?\\n\\nFiles on disk are NOT deleted.')) return;
  try {
    await postJSON('/api/projects/delete', { projectId });
    showNotification('Project "' + name + '" removed from dashboard.');
    loadProjects();
  } catch(e) { showNotification('Delete failed: ' + e.message, true); }
}
// Open a project in the Build tab with it pre-selected
function openProjectInBuild(projectId) {
  showBuild();
  loadBuildProjectPicker().then(() => {
    const sel = document.getElementById('buildProjectPicker');
    if (sel) { sel.value = projectId; onBuildProjectChange(); }
  });
}

// ── Build tab project picker ──────────────────────────────────────────────
let _buildProjects = {};
async function loadBuildProjectPicker() {
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
function onBuildProjectChange() {
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
  // Reload dispatch log filtered to the newly selected project
  loadPhasedProgress();
}

// ── Stop build/continuous-build ───────────────────────────────────────────
async function stopBuild() {
  try {
    await postJSON('/api/build/stop', {});
    showNotification('Build stop signal sent');
    document.getElementById('stopBuildBtn').style.display = 'none';
    document.getElementById('runBuildBtn').style.display = '';
    document.getElementById('buildStatus').textContent = '';
  } catch(e) { showNotification('Stop failed: ' + e.message, true); }
}
async function stopContinuousBuild() {
  try {
    await postJSON('/api/continuous-build/stop', {});
    showNotification('Continuous build stop signal sent');
    document.getElementById('stopContinuousBtn').style.display = 'none';
    document.getElementById('continuousBuildBtn').style.display = '';
  } catch(e) { showNotification('Stop failed: ' + e.message, true); }
}
async function retryFailed(roadmapFile) {
  if (!confirm('Reset all [!] failed items back to [ ] pending so the PM Loop retries them?')) return;
  try {
    const r = await postJSON('/api/roadmap/retry-failed', { roadmapFile });
    if (r.count === 0) { showNotification('No failed items found in roadmap', true); return; }
    showNotification('↩ ' + r.count + ' failed item' + (r.count !== 1 ? 's' : '') + ' reset — click Resume to retry');
    await loadProjects();
  } catch(e) { showNotification('Retry failed: ' + e.message, true); }
}
// ── Roadmap editor ──────────────────────────────────────────────────────────
const _roadmapFiles = {};   // projectId → roadmapFile path

async function openRoadmapEditor(projectId, roadmapFile) {
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
    setRmStatus(projectId, 'Loaded · ' + (r.content || '').split('\\n').length + ' lines');
  } catch(e) { ta.value = ''; setRmStatus(projectId, 'Error: ' + e.message, true); }
}

function closeRoadmapEditor(projectId) {
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

async function saveRoadmap(projectId) {
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

function addRoadmapItem(projectId) {
  const ta    = document.getElementById('rm-ta-' + projectId);
  const input = document.getElementById('rm-add-' + projectId);
  if (!ta) return;
  const text = (input ? input.value.trim() : '') || 'New task';
  if (!text) return;
  const line = '- [ ] ' + text;
  ta.value = ta.value.trimEnd() + '\\n' + line + '\\n';
  ta.scrollTop = ta.scrollHeight;
  if (input) input.value = '';
  setRmStatus(projectId, 'Item added — click 💾 Save to persist');
}

function skipNextItem(projectId) {
  const ta = document.getElementById('rm-ta-' + projectId);
  if (!ta) return;
  const lines = ta.value.split('\\n');
  let skipped = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^- \[ \]/.test(lines[i])) {
      lines[i] = lines[i].replace('- [ ]', '- [x]') + '  ✓ skipped';
      skipped = true;
      break;
    }
  }
  if (skipped) {
    ta.value = lines.join('\\n');
    setRmStatus(projectId, 'Next pending item skipped — click 💾 Save to persist');
  } else {
    setRmStatus(projectId, 'No pending items to skip');
  }
}

async function resetAllFailed(projectId) {
  const ta = document.getElementById('rm-ta-' + projectId);
  if (!ta) return;
  const before = (ta.value.match(/\[!\]/g) || []).length;
  if (!before) { setRmStatus(projectId, 'No failed items to reset'); return; }
  ta.value = ta.value
    .split('\\n')
    .map(l => l.replace(/\[!\]/, '[ ]').replace(/\s+✗\s+\d+:\d+:\d+/g, ''))
    .join('\\n');
  setRmStatus(projectId, before + ' failed item(s) reset — click 💾 Save to persist');
}
async function loadPhasedProgress(){
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
async function runBuild(){
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
    // Auto-clear after 2 minutes (phased build is typically done by then)
    setTimeout(() => {
      status.textContent = '';
      btn.disabled = false;
      btn.style.display = '';
      if (stopBtn) stopBtn.style.display = 'none';
    }, 120000);
  } catch (e) { showNotification('Build failed: ' + e.message, true); status.textContent = ''; btn.disabled = false; }
}
async function enhancePrompt(){
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
async function continuousBuildRun(){
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
    logBox.textContent = '⚙ Starting continuous build...\\n';
    const r = await postJSON('/api/continuous-build', { requirement: req, projectId });
    logBox.textContent += '✅ Spawned (pid ' + r.pid + '). Checking progress below and in RT Messages tab.\\n';
    showNotification('Continuous build started — will keep going until all sections are done.');
    status.textContent = 'Running (continuous)';
    // Poll build log every 4s
    const poller = setInterval(async () => {
      try {
        const lg = await fetch('/api/continuous-build/log').then(r2 => r2.json());
        if (lg.lines && lg.lines.length) {
          logBox.textContent = lg.lines.map(l => {
            const icon = l.status === 'completed' ? '✅' : l.status === 'failed' ? '❌' : l.status === 'done' ? '🏁' : '·';
            return `${icon} [rd${l.round||'?'}] ${l.agent ? l.agent+': ' : ''}${l.task || l.status || JSON.stringify(l)}`;
          }).join('\\n');
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
    // Safety: re-enable button after 30 minutes max
    setTimeout(() => {
      clearInterval(poller);
      btn.disabled = false;
      btn.style.display = '';
      if (stopBtn) stopBtn.style.display = 'none';
      if (status.textContent.includes('continuous')) status.textContent = '';
    }, 30 * 60 * 1000);
  } catch (e) { showNotification('Continuous build failed: ' + e.message, true); status.textContent = ''; btn.disabled = false; btn.style.display = ''; if (stopBtn) stopBtn.style.display = 'none'; }
}
refreshAll();
setInterval(refreshAll, 3000);
// Populate chat project dropdown on load; respect #projects deep link (e.g. from native app)
(async () => {
  try {
    const data = await getJSON('/api/projects');
    const projects = data.projects || [];
    _projectsData = {};
    projects.forEach(p => { _projectsData[p.id] = p; });
    populateChatProjectDropdown(projects);
    if (location.hash === '#projects') showProjects();
  } catch {}
})();
window.addEventListener('hashchange', () => { if (location.hash === '#projects') showProjects(); });
document.getElementById('refreshBtn').onclick = refreshAll;
document.getElementById('runBuildBtn').onclick = runBuild;
document.getElementById('continuousBuildBtn').onclick = continuousBuildRun;
document.getElementById('stopBuildBtn').onclick = stopBuild;
document.getElementById('stopContinuousBtn').onclick = stopContinuousBuild;
document.getElementById('enhancePromptBtn').onclick = enhancePrompt;
loadBuildProjectPicker();
document.getElementById('newProjectBtn').onclick = () => {
  const form = document.getElementById('newProjectForm');
  form.style.display = form.style.display === 'none' ? 'block' : 'none';
};
document.getElementById('npCancelBtn').onclick = () => { document.getElementById('newProjectForm').style.display = 'none'; };
document.getElementById('npCreateBtn').onclick = async () => {
  const name = document.getElementById('npName').value.trim();
  const desc = document.getElementById('npDesc').value.trim();
  const outputDir = document.getElementById('npOutputDir').value.trim();
  const featuresDoc = document.getElementById('npFeaturesDoc').value.trim();
  if (!name || !outputDir) { showNotification('Name and output directory required', true); return; }
  try {
    const r = await postJSON('/api/projects', { name, description: desc, outputDir, featuresDoc });
    showNotification(`Project "${r.project.name}" created!`);
    document.getElementById('newProjectForm').style.display = 'none';
    document.getElementById('npName').value = '';
    document.getElementById('npDesc').value = '';
    document.getElementById('npOutputDir').value = '';
    document.getElementById('npFeaturesDoc').value = '';
    loadProjects();
  } catch(e) { showNotification('Failed: ' + e.message, true); }
};
// sendBtn / messageInput removed (replaced by crew-lead chat)

// ── PM Loop controls ──────────────────────────────────────────────────────
let pmPoller = null;

function getSelectedProjectId() {
  const sel = document.getElementById('buildProjectPicker');
  return sel ? sel.value : '';
}
async function checkPmStatus() {
  try {
    const projectId = getSelectedProjectId();
    const qs = projectId ? '?projectId=' + encodeURIComponent(projectId) : '';
    const s = await fetch('/api/pm-loop/status' + qs).then(r => r.json());
    const badge    = document.getElementById('pmLoopBadge');
    const startBtn = document.getElementById('pmStartBtn');
    const dryBtn   = document.getElementById('pmDryRunBtn');
    const logBox   = document.getElementById('pmLiveLog');
    if (s.running) {
      badge.textContent = 'running (pid ' + s.pid + ')';
      badge.classList.add('running');
      startBtn.disabled = true;
      dryBtn.disabled = true;
      logBox.style.display = 'block';
      if (!pmPoller) startPmLogPoller();
    } else {
      if (badge.textContent.startsWith('running')) {
        badge.textContent = 'idle';
        badge.classList.remove('running');
        startBtn.disabled = false;
        dryBtn.disabled = false;
      }
    }
  } catch(_) {}
}

function startPmLogPoller() {
  if (pmPoller) return;
  pmPoller = setInterval(async () => {
    try {
      const lg = await fetch('/api/pm-loop/log').then(r2 => r2.json());
      const logBox = document.getElementById('pmLiveLog');
      const badge  = document.getElementById('pmLoopBadge');
      const startBtn = document.getElementById('pmStartBtn');
      const dryBtn   = document.getElementById('pmDryRunBtn');
      if (lg.lines && lg.lines.length) {
        logBox.textContent = lg.lines.map(l => {
          if (l.event === 'finish') return `🏁 Done  ✓${l.done}  ✗${l.failed}  ⏳${l.pending}`;
          if (l.event === 'stopped_by_file') return '⛔ Stopped by user';
          if (l.event === 'all_done') return `🏁 All ${l.total} items complete!`;
          const icon = l.status === 'done' ? '✅' : l.status === 'failed' ? '❌' : l.event ? '·' : '·';
          const txt  = l.item ? `${l.item.substring(0, 60)}` : (l.event || '');
          return `${icon} ${txt}`;
        }).join('\\n');
        logBox.scrollTop = logBox.scrollHeight;
        const last = lg.lines[lg.lines.length - 1];
        if (last && (last.event === 'finish' || last.event === 'all_done' || last.event === 'stopped_by_file')) {
          clearInterval(pmPoller); pmPoller = null;
          badge.textContent = last.event === 'all_done' ? '✓ complete' : 'idle';
          badge.classList.remove('running');
          startBtn.disabled = false; dryBtn.disabled = false;
        }
      }
    } catch(_){}
  }, 5000);
}

async function startPmLoop(dryRun = false) {
  const projectId = getSelectedProjectId();
  const badge  = document.getElementById('pmLoopBadge');
  const status = document.getElementById('pmStatus');
  const logBox = document.getElementById('pmLiveLog');
  const startBtn = document.getElementById('pmStartBtn');
  const dryBtn   = document.getElementById('pmDryRunBtn');
  const proj = _buildProjects[projectId];
  if (!projectId) {
    showNotification('Select a project first from the Project picker above', true);
    return;
  }
  try {
    badge.textContent = dryRun ? 'dry run...' : 'starting...';
    badge.classList.add('running');
    startBtn.disabled = true;
    dryBtn.disabled = true;
    logBox.style.display = 'block';
    logBox.textContent = '⚙ Starting PM Loop for ' + (proj ? proj.name : projectId) + (dryRun ? ' (dry run)' : '') + '...\\n';
    const resp = await fetch('/api/pm-loop/start', {
      method: 'POST',
      headers: {'content-type':'application/json'},
      body: JSON.stringify({
        dryRun, projectId,
        pmOptions: {
          useQA:          document.getElementById('pmOptQA')?.checked ?? true,
          useSecurity:    document.getElementById('pmOptSecurity')?.checked ?? true,
          useSpecialists: document.getElementById('pmOptSpecialists')?.checked ?? true,
          selfExtend:     document.getElementById('pmOptSelfExtend')?.checked ?? true,
          maxItems:       parseInt(document.getElementById('pmOptMaxItems')?.value || '200'),
          taskTimeoutMin: parseInt(document.getElementById('pmOptTimeout')?.value || '10'),
          extendEveryN:   parseInt(document.getElementById('pmOptExtendN')?.value || '5'),
          pauseSec:       parseInt(document.getElementById('pmOptPause')?.value || '5'),
          maxRetries:     parseInt(document.getElementById('pmOptMaxRetries')?.value || '2'),
          coderAgent:     document.getElementById('pmOptCoder')?.value.trim() || 'crew-coder',
        }
      })
    });
    const r = await resp.json();
    if (resp.status === 409 || r.alreadyRunning) {
      logBox.textContent = '⚠ Already running (pid ' + r.pid + '). Watch the log below.\\n';
      badge.textContent = 'running (pid ' + r.pid + ')';
      showNotification('PM Loop already running for this project (pid ' + r.pid + ')', true);
      startPmLogPoller();
      return;
    }
    logBox.textContent += '✅ Spawned (pid ' + r.pid + '). PM is reading roadmap...\\n';
    badge.textContent = 'running (pid ' + r.pid + ')';
    showNotification('PM Loop started' + (dryRun ? ' (dry run)' : '') + ' for ' + (proj ? proj.name : projectId));
    startPmLogPoller();
  } catch (e) {
    showNotification('PM Loop failed: ' + e.message, true);
    badge.textContent = 'idle';
    badge.classList.remove('running');
    startBtn.disabled = false;
    dryBtn.disabled = false;
  }
}

async function stopPmLoop() {
  const projectId = getSelectedProjectId();
  try {
    await fetch('/api/pm-loop/stop', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ projectId }) });
    showNotification('Stop signal sent — PM will finish current task then halt.');
    document.getElementById('pmLoopBadge').textContent = 'stopping...';
  } catch (e) { showNotification('Stop failed: ' + e.message, true); }
}

async function toggleRoadmap() {
  const panel = document.getElementById('pmRoadmapPanel');
  if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }
  try {
    const projectId = getSelectedProjectId();
    const proj = _buildProjects[projectId];
    // If we have a project selected, fetch its roadmap file directly via file API
    let content = '';
    if (proj && proj.roadmapFile) {
      const r = await fetch('/api/file-content?path=' + encodeURIComponent(proj.roadmapFile)).then(r2 => r2.json());
      content = r.content || '(empty)';
    } else {
      const r = await fetch('/api/pm-loop/roadmap').then(r2 => r2.json());
      content = r.content || '(empty)';
    }
    panel.textContent = content;
    panel.style.display = 'block';
  } catch (e) { panel.textContent = 'Could not load roadmap: ' + e.message; panel.style.display = 'block'; }
}

document.getElementById('pmStartBtn').onclick  = () => startPmLoop(false);
document.getElementById('pmDryRunBtn').onclick  = () => startPmLoop(true);
document.getElementById('pmStopBtn').onclick    = stopPmLoop;
document.getElementById('pmRoadmapBtn').onclick = toggleRoadmap;
// Check PM status after picker loads so we use the right projectId
loadBuildProjectPicker().then(() => checkPmStatus());
// Re-check status whenever the project picker changes
document.getElementById('buildProjectPicker').addEventListener('change', () => {
  if (pmPoller) { clearInterval(pmPoller); pmPoller = null; }
  checkPmStatus();
});
// ── Hash routing — persist active view across refresh ────────────────────────
// ── Hash routing ─────────────────────────────────────────────────────────────
// Patch each top-level show* function so calling it (via onclick or code)
// automatically updates location.hash. Refresh → restores the same tab.
const VIEW_MAP = {
  'chat':        showChat,
  'swarm':       showSwarm,
  'rt':          showRT,
  'dlq':         showDLQ,
  'files':       showFiles,
  'services':    showServices,
  'agents':      showAgents,
  'models':      showModels,
  'settings':    showSettings,
  'engines':     showEngines,
  'skills':      showSkills,
  'run-skills':  showRunSkills,
  'benchmarks':  showBenchmarks,
  'tool-matrix': showToolMatrix,
  'build':       showBuild,
  'messaging':   showMessaging,
  'projects':    showProjects,
};

// Wrap each show* so it updates the hash when called from anywhere
for (const [hash, fn] of Object.entries(VIEW_MAP)) {
  const original = fn;
  const wrapped = function(...args) {
    history.replaceState(null, '', '#' + hash);
    return original(...args);
  };
  // Update the reference in the map and on window (for onclick= handlers)
  VIEW_MAP[hash] = wrapped;
  window[original.name] = wrapped;
}

function navigateTo(view) {
  const fn = VIEW_MAP[view] || VIEW_MAP['chat'];
  fn();
}

// On load: restore from hash or default to chat
// Supports top-level (#chat, #services) and sub-tab deep links (#settings/telegram)
const startHash = (location.hash || '#chat').slice(1);
const [startView, startSubtab] = startHash.split('/');
const params = new URLSearchParams(window.location.search);
if (params.get('focus') === '1') {
  setTimeout(() => { const ci = document.getElementById('chatInput'); if (ci) { navigateTo('chat'); ci.focus(); } }, 500);
} else {
  navigateTo(startView || 'chat');
  if (startView === 'settings' && startSubtab) {
    showSettingsTab(startSubtab);
  }
}
// Resolve server-side env vars (HOME, cwd) once on boot
fetch('/api/env').then(r => r.json()).then(env => {
  window._crewHome = env.HOME || '';
  window._crewCwd  = env.cwd  || '';
  const filesDir = document.getElementById('filesDir');
  if (filesDir && !filesDir.value) filesDir.value = env.cwd || '';
}).catch(() => {});

loadAgents();
refreshAll();

// Wrap every type="password" input in a <form display:contents> so Chrome
// stops emitting "Password field is not contained in a form" warnings.
// Works for both static inputs and dynamically rendered provider key fields.
(function () {
  function wrapOrphanPwd(inp) {
    if (inp.closest('form')) return;
    const form = document.createElement('form');
    form.autocomplete = 'off';
    form.onsubmit = () => false;
    form.style.cssText = 'margin:0;padding:0;display:contents;';
    // Hidden username field — satisfies Chrome's "password forms need a username" check
    const u = document.createElement('input');
    u.type = 'text';
    u.autocomplete = 'username';
    u.setAttribute('aria-hidden', 'true');
    u.style.cssText = 'display:none;position:absolute;width:0;height:0;opacity:0;';
    form.appendChild(u);
    inp.parentNode.insertBefore(form, inp);
    form.appendChild(inp);
  }
  function scanAndWrap(root) {
    (root || document).querySelectorAll('input[type="password"]').forEach(wrapOrphanPwd);
  }
  scanAndWrap();
  const obs = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches && node.matches('input[type="password"]')) wrapOrphanPwd(node);
        else scanAndWrap(node);
      }
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}());

// ── Expose functions to global scope for inline HTML event handlers ───────────
// ── Global delegated click dispatcher ──────────────────────────────────────────
// MetaMask's SES lockdown runs onclick handlers in an isolated Compartment where
// neither globalThis.fn nor window.fn resolves. Using data-action + addEventListener
// bypasses the Compartment entirely — the listener closure has full module scope.
const ACTION_REGISTRY = {
  // Nav views
  showChat, showSwarm, showRT, showBuild, showFiles, showDLQ,
  showProjects, showAgents, showModels, showEngines, showSkills, showRunSkills,
  showBenchmarks, showToolMatrix, showServices, showSettings,
  // Static HTML actions (previously onclick="window.fn()")
  pickFolder:          (id) => pickFolder(id),
  loadFiles:           (force) => loadFiles(force === 'true' || force === true),
  clearChatHistory,
  sendChat,
  stopAll,
  killAll,
  loadServices,
  saveRTToken,
  startCrew,
  toggleEmojiPicker:   (id) => toggleEmojiPicker(id),
  bulkSetRoute:        (route, model) => bulkSetRoute(route, model),
  loadSpending,
  resetSpending,
  saveGlobalCaps,
  loadOcStats,
  addAllowlistPattern,
  sendTestWebhook,
  startTgBridge,
  stopTgBridge,
  saveTgConfig,
  loadTelegramSessions,
  loadTgMessages,
  startWaBridge,
  stopWaBridge,
  saveWaConfig,
  loadWaMessages,
  saveOpencodeSettings,
  saveGlobalFallback,
  toggleBgConsciousness,
  toggleCursorWaves,
  toggleClaudeCode,
  toggleCodexExecutor,
  saveGlobalOcLoop,
  saveGlobalOcLoopRounds,
  savePassthroughNotify,
  toggleAddSkill,
  toggleImportSkill,
  importSkillFromUrl,
  showSkills,
  saveSkill,
  cancelSkillForm,
  loadRunSkills,
  loadBenchmarks,
  loadBenchmarkLeaderboard,
  loadEngines,
  toggleImportEngine,
  importEngineFromUrl,
  deleteEngine: (id) => deleteEngine(id),
  loadToolMatrix,
  loadBuildProjectPicker,
  // RT scroll button
  scrollRTToBottom: () => {
    const v = document.getElementById('rtView');
    if (v) v.scrollTop = v.scrollHeight;
  },
  toggleRTPause,
  clearRTMessages,
  togglePmAdvanced: () => {
    const el = document.getElementById('pmAdvanced');
    if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
  },
  // RT token visibility toggle
  toggleRTTokenVis: () => {
    const i = document.getElementById('rtTokenInput');
    if (i) i.type = i.type === 'password' ? 'text' : 'password';
  },
  // Services
  restartService: (id) => restartService(id),
  stopService:    (id) => stopService(id),
  // Files
  closePreviewPane,
  previewFile:    (path, el) => previewFile(path, el),
  // DLQ
  replayDLQ:      (key) => replayDLQ(key),
  deleteDLQ:      (key) => deleteDLQ(key),
  // Skills
  runSkillFromUI: (name) => runSkillFromUI(name),
  editSkill:      (name) => editSkill(name),
  deleteSkill:    (name) => deleteSkill(name),
  // Tool matrix
  restartAgentFromUI: (id) => restartAgentFromUI(id),
  // Models / providers
  saveSearchTool:      (id) => saveSearchTool(id),
  testSearchTool:      (id) => testSearchTool(id),
  saveBuiltinKey:      (id) => saveBuiltinKey(id),
  testBuiltinProvider: (id) => testBuiltinProvider(id),
  fetchBuiltinModels:  (id, el) => fetchBuiltinModels(id, el),
  saveKey:             (id) => saveKey(id),
  testKey:             (id) => testKey(id),
  fetchModels:         (id, el) => fetchModels(id, el),
  toggleKeyVis:        (inputId, el) => toggleKeyVis(inputId, el),
  // Agents
  toggleAgentBody: (id) => toggleAgentBody(id),
  deleteAgent:     (id) => deleteAgent(id),
  saveAgentModel:  (id) => saveAgentModel(id),
  saveAgentFallback: (id) => saveAgentFallback(id),
  toggleEmojiPicker: (id) => toggleEmojiPicker(id),
  saveAgentIdentity: (id) => saveAgentIdentity(id),
  saveAgentPrompt:   (id) => saveAgentPrompt(id),
  resetAgentSession: (id) => resetAgentSession(id),
  saveAgentTools:    (id) => saveAgentTools(id),
  applyToolPreset:   (id) => applyToolPreset(id),
  setRoute:          (id, route) => setRoute(id, route),
  saveOpenCodeConfig:   (id) => saveOpenCodeConfig(id),
  saveOpenCodeFallback: (id) => saveOpenCodeFallback(id),
  saveCursorCliConfig:  (id) => saveCursorCliConfig(id),
  saveClaudeCodeConfig: (id) => saveClaudeCodeConfig(id),
  // Settings tabs
  showSettingsTab: (tab) => showSettingsTab(tab),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  e.stopPropagation();
  const action = el.dataset.action;
  const fn = ACTION_REGISTRY[action];
  if (!fn) { console.warn('[CrewSwarm] unknown data-action:', action); return; }
  const arg  = el.dataset.arg  ?? null;
  const arg2 = el.dataset.arg2 ?? null;
  const needsEl = el.dataset.self === '1';
  if (arg !== null && arg2 !== null) fn(arg, arg2);
  else if (arg !== null && needsEl)  fn(arg, el);
  else if (arg !== null)             fn(arg);
  else if (needsEl)                  fn(el);
  else                               fn();
});

// ── Delegated change listener (data-onchange) ────────────────────────────────
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-onchange]');
  if (!el) return;
  const fn = ACTION_REGISTRY[el.dataset.onchange];
  if (!fn) return;
  // Pass element value if data-onchange-arg="this.value", otherwise no arg
  const arg = el.dataset.onchangeArg === 'this.value' ? el.value : null;
  arg !== null ? fn(arg) : fn();
});

// Wire chatInput keydown + oninput via addEventListener (SES-safe)
document.addEventListener('DOMContentLoaded', () => {
  // Set sidebar self-link to actual origin (avoids hardcoded localhost:4319)
  const dashLink = document.getElementById('dashSelfLink');
  if (dashLink) {
    dashLink.href = window.location.origin;
    dashLink.textContent = window.location.host;
  }

  const chatInput = document.getElementById('chatInput');
  if (chatInput) {
    chatInput.addEventListener('keydown', chatKeydown);
    chatInput.addEventListener('input',   chatAtAtInput);
  }
  const cmdInput = document.getElementById('cmdAllowlistInput');
  if (cmdInput) {
    cmdInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addAllowlistPattern();
    });
  }
  const waNumbers = document.getElementById('waAllowedNumbers');
  if (waNumbers) waNumbers.addEventListener('input', renderWaContactRows);
  const skillSearchInput = document.getElementById('skillSearch');
  if (skillSearchInput) skillSearchInput.addEventListener('input', (e) => filterSkills(e.target.value));
}, { once: true });

// Nav view delegation (data-view buttons in sidebar)
const NAV_VIEW_MAP = {
  chat: showChat, swarm: showSwarm, rt: showRT, build: showBuild,
  files: showFiles, dlq: showDLQ, projects: showProjects, agents: showAgents,
  models: showModels, engines: showEngines, skills: showSkills, 'run-skills': showRunSkills,
  benchmarks: showBenchmarks, 'tool-matrix': showToolMatrix,
  services: showServices, settings: showSettings,
};
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-view]');
  if (btn) { const fn = NAV_VIEW_MAP[btn.dataset.view]; if (fn) fn(); return; }
  const stab = e.target.closest('[data-stab]');
  if (stab) showSettingsTab(stab.dataset.stab);
  // Collapse/expand panels with data-toggle-child
  const tog = e.target.closest('[data-toggle-child]');
  if (tog) {
    const sel = tog.dataset.toggleChild;
    const body = tog.parentElement && tog.parentElement.querySelector(sel);
    if (body) body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
  // Collapse/expand next sibling with data-toggle-sibling (e.g. provider-header → provider-body)
  const togSib = e.target.closest('[data-toggle-sibling]');
  if (togSib && togSib.nextElementSibling) {
    togSib.nextElementSibling.classList.toggle(togSib.dataset.toggleSibling);
  }
});

// Vite wraps modules in a closure; onclick="window.fn()" attrs in static + dynamic HTML need window.fn.
Object.assign(window, {
  // ── Static HTML handlers ──
  addAllowlistPattern, applyNewAgentToolPreset, applyPromptPreset,
  bulkSetRoute, cancelSkillForm, chatAtAtInput, chatKeydown,
  clearChatHistory, filterSkills, loadAllUsage, loadBenchmarkLeaderboard,
  loadBenchmarks, loadBuildProjectPicker, loadFiles, loadOcStats,
  loadRunSkills, loadServices, loadSpending, loadTelegramSessions,
  loadTgMessages, loadToolMatrix, loadWaMessages, onBuildProjectChange,
  onChatProjectChange, pickFolder, renderWaContactRows, resetSpending,
  saveGlobalCaps, saveGlobalFallback, saveOpencodeSettings, saveRTToken,
  saveSkill, saveTgConfig, saveWaConfig, sendChat, sendTestWebhook,
  showAgents, showBenchmarks, showBuild, showChat, showDLQ, showFiles,
  showModels, showProjects, showRT, showRunSkills, showServices,
  showSettings, showSettingsTab, showSkills, showSwarm, showToolMatrix,
  startCrew, startTgBridge, startWaBridge, stopTgBridge, stopWaBridge,
  toggleAddSkill, toggleBgConsciousness, toggleCursorWaves, toggleClaudeCode, toggleEmojiPicker,
  updateSkillAuthFields, navigateTo,
  // ── Dynamic HTML handlers (innerHTML-rendered) ──
  applyToolPreset, closePreviewPane, deleteAgent, deleteSkill, editSkill,
  fetchBuiltinModels, fetchModels, previewFile, resetAgentSession,
  restartAgentFromUI, restartService, runSkillFromUI,
  saveAgentFallback, saveAgentIdentity, saveAgentModel, saveAgentPrompt,
  saveAgentTools, saveBuiltinKey, saveCursorCliConfig, saveKey,
  saveOpenCodeConfig, saveOpenCodeFallback, saveSearchTool, setRoute,
  stopService, testBuiltinProvider, testKey, testSearchTool,
  toggleAgentBody, toggleKeyVis,
});
