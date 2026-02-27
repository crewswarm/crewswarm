import { getJSON, postJSON } from '../core/api.js';
import { escHtml, showNotification } from '../core/dom.js';

let showSettings = () => {};
let showSettingsTab = () => {};
let _waSavedContactNames = {};

export function initCommsTab(deps = {}) {
  showSettings = deps.showSettings || showSettings;
  showSettingsTab = deps.showSettingsTab || showSettingsTab;
}

export function showMessaging() {
  showSettings();
  showSettingsTab('comms');
}

export async function loadCommsTabData() {
  await Promise.allSettled([
    loadTgStatus(),
    loadTelegramSessions(),
    loadTgMessages(),
    loadTgConfig(),
    loadWaStatus(),
    loadWaConfig(),
    loadWaMessages(),
  ]);
}

export async function loadTgStatus() {
  try {
    const d = await getJSON('/api/telegram/status');
    const badge = document.getElementById('tgStatusBadge');
    if (!badge) return;
    if (d.running) {
      badge.textContent = d.botName ? '● @' + d.botName : '● running';
      badge.className = 'status-badge status-active';
    } else {
      badge.textContent = '● stopped';
      badge.className = 'status-badge status-stopped';
    }
  } catch {}
}

export async function loadTgConfig() {
  try {
    const d = await getJSON('/api/telegram/config');
    if (d.token) document.getElementById('tgTokenInput').value = d.token;
    const ids = d.allowedChatIds && d.allowedChatIds.length ? d.allowedChatIds : [];
    document.getElementById('tgAllowedIds').value = ids.join(', ');
    const contactNames = d.contactNames || {};
    const listEl = document.getElementById('tgContactNamesList');
    if (!listEl) return;
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

export async function saveTgConfig() {
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
  loadTgConfig();
}

export async function startTgBridge() {
  const token = document.getElementById('tgTokenInput').value.trim();
  const body = { targetAgent: 'crew-lead' };
  if (token) body.token = token;
  const r = await postJSON('/api/telegram/start', body);
  if (r && r.error) { showNotification(r.error, true); return; }
  showNotification(r && r.message === 'Already running' ? 'Already running' : 'Telegram bridge starting...');
  setTimeout(loadTgStatus, 2000);
}

export async function stopTgBridge() {
  await postJSON('/api/telegram/stop', {});
  showNotification('Telegram bridge stopped');
  setTimeout(loadTgStatus, 1000);
}

export async function loadWaStatus() {
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
    if (authEl) {
      authEl.textContent = d.authSaved
        ? '✅ Auth saved — no QR scan needed on restart'
        : '⚠️ No auth saved — run npm run whatsapp in terminal to scan QR';
    }
  } catch {}
}

export function renderWaContactRows() {
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

export async function loadWaConfig() {
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

export async function saveWaConfig() {
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

export async function startWaBridge() {
  const r = await postJSON('/api/whatsapp/start', {});
  if (r && r.error) { showNotification(r.error, true); return; }
  showNotification(r && r.message === 'Already running' ? 'Already running' : 'WhatsApp bridge starting…');
  setTimeout(loadWaStatus, 2000);
}

export async function stopWaBridge() {
  await postJSON('/api/whatsapp/stop', {});
  showNotification('WhatsApp bridge stopped');
  setTimeout(loadWaStatus, 1000);
}

export async function loadWaMessages() {
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
          '<div style="font-size:13px;word-break:break-word;">' + escHtml((m.text || '').slice(0, 300)) + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch {
    feed.innerHTML = '<div style="color:var(--text-3);font-size:12px;padding:8px;">Could not load messages.</div>';
  }
}

export async function loadTgMessages() {
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
      const who = isIn ? (m.firstName || m.username || 'User') : 'CrewSwarm';
      const icon = isIn ? '👤' : '⚡';
      return '<div class="card" style="padding:12px;gap:4px;display:flex;flex-direction:column;">' +
        '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-3);">' +
        '<span>' + icon + ' ' + escHtml(who) + (m.username ? ' @' + escHtml(m.username) : '') + '</span>' +
        '<span>' + time + '</span></div>' +
        '<div style="font-size:13px;white-space:pre-wrap;">' + escHtml(m.text || '') + '</div>' +
        '</div>';
    }).join('');
  } catch {
    feed.innerHTML = '<div class="meta" style="padding:20px;color:var(--red-hi);">Error loading messages</div>';
  }
}

export async function loadTelegramSessions() {
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
      const icon = m.role === 'user' ? '👤' : '🤖';
      const txt = String(m.content || '').slice(0, 100).replace(/</g, '&lt;');
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
