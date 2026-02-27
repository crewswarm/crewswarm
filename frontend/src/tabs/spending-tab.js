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

export function reportOcCost(cost) {
  _ocTotalCost = cost;
  updateGrandTotal();
}

export async function loadAllUsage() {
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
  loadOcStatsFromUsage(reportOcCost);
}

export async function loadSpending(){
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
  } catch(e) { showError(el, 'Error: ' + e.message); }
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
