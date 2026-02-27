export function renderStatusBadge(liveness, ageSec) {
  if (liveness === 'online')
    return '<span title="● online — heartbeat <90s" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 5px var(--green);margin-right:4px;flex-shrink:0;"></span>';
  if (liveness === 'stale')
    return '<span title="● stale — last seen >' + (ageSec || '?') + 's ago" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#f59e0b;margin-right:4px;flex-shrink:0;"></span>';
  if (liveness === 'offline')
    return '<span title="● offline — no heartbeat in 5min" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--red-hi);margin-right:4px;flex-shrink:0;"></span>';
  return '<span title="● unknown — never seen" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--text-3);margin-right:4px;flex-shrink:0;"></span>';
}

export function showLoading(el, msg) {
  if (el) el.innerHTML = '<div class="meta" style="padding:20px;">' + (msg || 'Loading\u2026') + '</div>';
}

export function showEmpty(el, msg) {
  if (el) el.innerHTML = '<div class="meta" style="padding:20px;">' + (msg || 'No items found.') + '</div>';
}

export function showError(el, msg) {
  if (el) el.innerHTML = '<div class="meta" style="padding:20px;color:var(--red-hi);">' + (msg || 'An error occurred.') + '</div>';
}

export function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function showNotification(msg, type) {
  const d = document.createElement('div');
  d.className = 'notification' + (type === 'error' || type === true ? ' error' : type === 'warning' ? ' warning' : '');
  d.setAttribute('role', 'alert');
  d.setAttribute('aria-live', 'polite');
  d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 4500);
}

export function fmt(ts) {
  try { return new Date(ts).toLocaleTimeString(); } catch { return String(ts); }
}

export function createdAt(info) {
  return (info && info.time && info.time.created) || '';
}

export function appendChatBubble(role, text, fallbackModel, fallbackReason) {
  const box = document.getElementById('chatMessages');
  if (!box) return;
  const isUser = role === 'user';
  if (!isUser) {
    const last = box.lastElementChild;
    if (last && last.children.length >= 2) {
      const lastBubbleText = last.children[1].textContent;
      if (lastBubbleText.trim() === String(text).trim()) return;
    }
  }
  const div = document.createElement('div');
  div.style.cssText = 'display:flex;flex-direction:column;align-items:' + (isUser ? 'flex-end' : 'flex-start') + ';gap:4px;';
  const labelEl = document.createElement('div');
  labelEl.style.cssText = 'font-size:11px;color:var(--text-3);padding:0 6px;display:flex;align-items:center;gap:6px;';
  const cl = window._crewLeadInfo || { emoji: '🧠', name: 'crew-lead' };
  const displayName = isUser ? 'You' : (role === 'assistant' ? (cl.emoji + ' ' + cl.name) : role);
  labelEl.textContent = displayName;
  if (!isUser && fallbackModel) {
    const badge = document.createElement('span');
    badge.title = 'Primary failed (' + (fallbackReason || 'error') + ') — running on fallback';
    badge.style.cssText = 'font-size:10px;padding:1px 6px;border-radius:999px;background:rgba(245,158,11,0.15);color:#f59e0b;border:1px solid rgba(245,158,11,0.3);cursor:default;';
    badge.textContent = '⚡ fallback: ' + fallbackModel;
    labelEl.appendChild(badge);
  }
  const bubble = document.createElement('div');
  bubble.style.cssText = 'max-width:80%;padding:10px 14px;border-radius:' + (isUser ? '14px 14px 4px 14px' : '14px 14px 14px 4px') + ';background:' + (isUser ? 'var(--purple)' : 'var(--bg-2)') + ';color:' + (isUser ? '#fff' : 'var(--text-1)') + ';font-size:14px;line-height:1.5;white-space:pre-wrap;word-break:break-word;border:1px solid var(--border);';
  bubble.textContent = text;
  div.appendChild(labelEl); div.appendChild(bubble);
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}
