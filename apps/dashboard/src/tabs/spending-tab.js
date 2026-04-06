/**
 * Spending dashboard — extracted from app.js
 * Deps: getJSON (core/api), showNotification (core/dom), estimateCost (usage-tab)
 */
import { getJSON } from '../core/api.js';
import { showNotification, showError } from '../core/dom.js';
import { estimateCost, loadOcStats as loadOcStatsFromUsage } from './usage-tab.js';

// ── Spending ──────────────────────────────────────────────────────────────────
var _agentTotalCost = null;
var _ocTotalCost = null;
var _crewCliTotalCost = null;

function updateGrandTotal() {
  var a = _agentTotalCost, o = _ocTotalCost, c = _crewCliTotalCost;
  var aEl = document.getElementById('gtAgentCost');
  var oEl = document.getElementById('gtOcCost');
  var cEl = document.getElementById('gtCrewCliCost');
  var tEl = document.getElementById('gtTotal');
  if (!aEl) return;
  if (a !== null) aEl.textContent = '$' + a.toFixed(4);
  if (o !== null) oEl.textContent = '$' + o.toFixed(4);
  if (c !== null && cEl) cEl.textContent = '$' + c.toFixed(4);
  if (a !== null && o !== null && c !== null) tEl.textContent = '$' + (a + o + c).toFixed(4);
}

export function reportOcCost(cost) {
  _ocTotalCost = cost;
  updateGrandTotal();
}

// Sync all dropdowns to the same value and reload everything
function syncAllDropdowns(days) {
  var gt = document.getElementById('grandTotalDays');
  var sp = document.getElementById('spendingDays');
  var oc = document.getElementById('ocStatsDays');
  var cc = document.getElementById('crewCliDays');
  if (gt) gt.value = String(days);
  if (sp) sp.value = String(days);
  if (oc) oc.value = String(days);
  if (cc) cc.value = String(days);
}

export async function loadAllUsage() {
  var days = parseInt(document.getElementById('grandTotalDays')?.value || '14');
  syncAllDropdowns(days);
  _agentTotalCost = null;
  _ocTotalCost = null;
  _crewCliTotalCost = null;
  document.getElementById('gtAgentCost').textContent = '—';
  document.getElementById('gtOcCost').textContent = '—';
  var ccEl = document.getElementById('gtCrewCliCost');
  if (ccEl) ccEl.textContent = '—';
  document.getElementById('gtTotal').textContent = '—';
  loadSpending();
  loadOcStatsFromUsage(reportOcCost);
  loadCrewCliStats();
}

export async function loadSpending(){
  const el = document.getElementById('spendingWidget');
  const days = parseInt(document.getElementById('spendingDays')?.value || '1');
  // Keep all dropdowns in sync when any one changes
  syncAllDropdowns(days);
  try {
    {
      // Unified: always use token-usage.json for consistent pricing across all timeframes
      const u = await getJSON('/api/token-usage').catch(function(){ return {}; });
      const byDay = u.byDay || {};
      const cutoff = days <= 1
        ? new Date().toISOString().slice(0, 10)  // today only
        : new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
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
      const periodLabel = days <= 1 ? 'Today' : 'Last ' + days + ' days &middot; ' + filteredDays.length + ' days of data';
      let out = '<div style="margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;">'
              + '<span style="font-size:12px;color:var(--text-3);">' + periodLabel + '</span>'
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
  } catch(e) { showError(el, 'Error: ' + e.message); }
}

// ── crew-cli stats ───────────────────────────────────────────────────────────
export async function loadCrewCliStats() {
  const box = document.getElementById('crewCliStatsWidget');
  if (!box) return;
  const days = parseInt(document.getElementById('crewCliDays')?.value || '14');
  syncAllDropdowns(days);
  box.innerHTML = '<div style="color:var(--text-3);font-size:12px;">Loading\u2026</div>';
  try {
    const d = await getJSON('/api/crew-cli-stats?days=' + days);
    if (!d.ok || !Object.keys(d.byDay || {}).length) {
      box.innerHTML = '<div style="color:var(--text-3);font-size:12px;">' + (d.error || 'No crew-cli data found for this period.') + '</div>';
      _crewCliTotalCost = 0;
      updateGrandTotal();
      return;
    }
    const byDay = d.byDay;
    const sortedDays = Object.keys(byDay).sort().reverse();
    const totalCost = d.totalCost || 0;
    const totalCalls = d.totalCalls || 0;
    const totalPrompt = d.totalPromptTokens || 0;
    const totalCompletion = d.totalCompletionTokens || 0;
    const maxCost = Math.max(...sortedDays.map(function(day){ return byDay[day].cost || 0; }), 0.0001);

    let html = '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px;">' +
      '<div style="text-align:center;"><div style="font-size:18px;font-weight:700;color:var(--yellow);">$' + totalCost.toFixed(4) + '</div><div style="font-size:11px;color:var(--text-3);">total cost</div></div>' +
      '<div style="text-align:center;"><div style="font-size:18px;font-weight:700;color:var(--accent);">' + totalCalls.toLocaleString() + '</div><div style="font-size:11px;color:var(--text-3);">LLM calls</div></div>' +
      '<div style="text-align:center;"><div style="font-size:18px;font-weight:700;color:var(--green);">' + (totalPrompt/1e6).toFixed(2) + 'M</div><div style="font-size:11px;color:var(--text-3);">input tokens</div></div>' +
      '<div style="text-align:center;"><div style="font-size:18px;font-weight:700;color:var(--green);">' + (totalCompletion/1e6).toFixed(2) + 'M</div><div style="font-size:11px;color:var(--text-3);">output tokens</div></div>' +
    '</div>';

    // Daily bars
    const today = new Date().toISOString().slice(0, 10);
    html += '<div style="display:flex;flex-direction:column;gap:4px;margin-bottom:16px;">';
    sortedDays.forEach(function(day) {
      const ds = byDay[day];
      const pct = Math.max((ds.cost / maxCost) * 100, ds.cost > 0 ? 2 : 0);
      const isToday = day === today;
      const tok = ((ds.prompt_tokens || 0) + (ds.completion_tokens || 0)) / 1e6;
      html += '<div style="display:flex;align-items:center;gap:8px;font-size:11px;">' +
        '<span style="width:70px;color:var(--text-3);flex-shrink:0;">' + (isToday ? 'today' : day.slice(5)) + '</span>' +
        '<div style="flex:1;background:var(--bg-1);border-radius:3px;height:16px;overflow:hidden;">' +
          '<div style="width:' + pct.toFixed(1) + '%;height:100%;background:' + (isToday ? 'var(--accent)' : 'var(--purple, #a78bfa)') + ';border-radius:3px;opacity:0.85;"></div>' +
        '</div>' +
        '<span style="width:60px;text-align:right;color:var(--yellow);font-weight:600;">$' + ds.cost.toFixed(4) + '</span>' +
        '<span style="width:50px;text-align:right;color:var(--text-3);">' + tok.toFixed(2) + 'M</span>' +
        '<span style="width:36px;text-align:right;color:var(--text-3);">' + (ds.calls || 0) + '</span>' +
      '</div>';
    });
    html += '</div>';

    // By model
    const allModels = {};
    sortedDays.forEach(function(day) {
      Object.entries(byDay[day].byModel || {}).forEach(function(e) {
        var m = e[0], s = e[1];
        if (!allModels[m]) allModels[m] = { cost: 0, calls: 0 };
        allModels[m].cost += s.cost || 0;
        allModels[m].calls += s.calls || 0;
      });
    });
    const sortedModels = Object.entries(allModels).sort(function(a, b) { return b[1].cost - a[1].cost; });
    if (sortedModels.length) {
      html += '<div style="font-size:11px;color:var(--text-3);margin-bottom:4px;">By model</div>';
      sortedModels.slice(0, 8).forEach(function(e) {
        var m = e[0], s = e[1];
        html += '<div style="display:flex;justify-content:space-between;font-size:11px;padding:2px 0;border-bottom:1px solid var(--border);">' +
          '<code style="color:var(--accent);">' + m + '</code>' +
          '<span style="color:var(--text-2);">' + s.calls + ' calls &middot; <span style="color:var(--yellow);">$' + s.cost.toFixed(4) + '</span></span>' +
        '</div>';
      });
    }

    _crewCliTotalCost = totalCost;
    updateGrandTotal();
    box.innerHTML = html;
  } catch(e) {
    box.innerHTML = '<div style="color:var(--text-3);font-size:12px;">Error: ' + e.message + '</div>';
    _crewCliTotalCost = 0;
    updateGrandTotal();
  }
}

export async function resetSpending(){
  if (!confirm("Reset today's spending counters?")) return;
  try { await fetch('/api/spending/reset', { method: 'POST', headers:{'content-type':'application/json'}, body: '{}' }); loadSpending(); showNotification('Spending reset'); }
  catch(e) { showNotification('Reset failed', true); }
}

export async function saveGlobalCaps(){
  const tokens = parseInt(document.getElementById('gcapTokens').value) || null;
  const cost   = parseFloat(document.getElementById('gcapCost').value) || null;
  showNotification('Add to ~/.crewswarm/crewswarm.json: "globalSpendingCaps": {"dailyTokenLimit":' + (tokens||'null') + ',"dailyCostLimitUSD":' + (cost||'null') + '}', 'warning');
}
