/**
 * Token usage widget and tool matrix — extracted from app.js
 * Deps: getJSON (core/api), escHtml, showLoading, showEmpty, showError (core/dom)
 */
import { getJSON } from '../core/api.js';
import { showLoading, showEmpty, showError, showNotification } from '../core/dom.js';

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

export function estimateCost(byModel) {
  let total = 0;
  for (const [model, stats] of Object.entries(byModel || {})) {
    const rateKey = Object.keys(MODEL_COST_PER_M).find(k => model.toLowerCase().includes(k)) || 'default';
    const [inputRate, outputRate] = MODEL_COST_PER_M[rateKey];
    total += (stats.prompt / 1e6) * inputRate + (stats.completion / 1e6) * outputRate;
  }
  return total;
}

export async function loadTokenUsage() {
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

export async function loadOcStats(reportOcCost) {
  const box = document.getElementById('ocStatsWidget');
  if (!box) return;
  const days = document.getElementById('ocStatsDays')?.value || '14';
  if (reportOcCost) reportOcCost(null);
  showLoading(box);
  try {
    const d = await getJSON('/api/opencode-stats?days=' + days);
    if (!d.ok || !Object.keys(d.byDay||{}).length) {
      showEmpty(box, d.error || 'No OpenCode data found');
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
    if (reportOcCost) reportOcCost(totalCost);
    box.innerHTML = html;
  } catch(e) {
    showError(box, 'Error: ' + e.message);
  }
}

export async function checkCrewLeadStatus() {
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

// ── Task lifecycle (telemetry schema 1.1) ────────────────────────────────────────
export function renderTaskLifecycle(events) {
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

export async function loadToolMatrix(){
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
    window._telemetryEvents = d.telemetry || [];
    renderTaskLifecycle(d.telemetry || []);
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
    showError(el, 'Error loading health: ' + (e.message || ''));
  }
}

export async function restartAgentFromUI(agentId){
  if (!agentId) return;
  try {
    const r = await fetch('/api/agents/' + encodeURIComponent(agentId) + '/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const data = await r.json();
    if (data.ok) showNotification('Restarting ' + agentId + '…');
    else showNotification(data.error || 'Restart failed', 'error');
  } catch (e) { showNotification(e.message || 'Request failed', 'error'); }
}
