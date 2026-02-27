/**
 * Settings sub-tab loaders — extracted from app.js
 * Deps: getJSON, postJSON (core/api), escHtml, showNotification (core/dom)
 * Inject model deps via initSettingsTab({ getModels, populateModelDropdown })
 */

import { getJSON, postJSON } from '../core/api.js';
import { escHtml, showNotification } from '../core/dom.js';

let _getModels = null;
let _populateModelDropdown = null;

export function initSettingsTab({ getModels, populateModelDropdown } = {}) {
  _getModels = getModels || _getModels;
  _populateModelDropdown = populateModelDropdown || _populateModelDropdown;
}

// ── OpenClaw / RT token ────────────────────────────────────────────────────────

export async function loadOpenClawStatus() {
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
  } catch { if (badge) badge.textContent = '? unknown'; }
}

export async function loadRTToken() {
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

export async function saveRTToken() {
  const token = document.getElementById('rtTokenInput').value.trim();
  if (!token) { showNotification('Paste a token first', 'error'); return; }
  try {
    await postJSON('/api/settings/rt-token', { token });
    showNotification('RT Bus token saved');
    document.getElementById('rtTokenInput').value = '';
    loadRTToken();
  } catch(e) { showNotification('Save failed: ' + e.message, 'error'); }
}

// ── OpenCode / engine settings ────────────────────────────────────────────────

export async function loadOpencodeProject() {
  try {
    const d = await getJSON('/api/settings/opencode-project');
    const inp = document.getElementById('opencodeProjInput');
    const st  = document.getElementById('opencodeProjStatus');
    if (inp) { inp.placeholder = d.dir || 'e.g. /Users/you/Desktop/myproject'; inp.value = d.dir || ''; }
    if (st) st.textContent = d.dir ? ('✅ Current: ' + d.dir) : '⚠️ Not set — OpenCode will write files to the CrewSwarm repo root. Set this to your project folder.';
    if (document.getElementById('opencodeFallbackSelect') && _getModels) {
      await _getModels();
      if (_populateModelDropdown) _populateModelDropdown('opencodeFallbackSelect', d.fallbackModel || '');
    }
    const fbSt = document.getElementById('opencodeFallbackStatus');
    if (fbSt) fbSt.textContent = d.fallbackModel ? ('✅ Fallback: ' + d.fallbackModel) : '⚠️ Using default groq/kimi-k2-instruct-0905';
  } catch {}
}

export async function saveOpencodeSettings() {
  const dir = (document.getElementById('opencodeProjInput')?.value || '').trim();
  const fallbackModel = (document.getElementById('opencodeFallbackSelect')?.value || '').trim();
  try {
    await postJSON('/api/settings/opencode-project', { dir: dir || undefined, fallbackModel: fallbackModel || undefined });
    showNotification('OpenCode settings saved — fallback takes effect on next task (no restart needed)');
    loadOpencodeProject();
  } catch(e) { showNotification('Save failed: ' + e.message, 'error'); }
}

export async function loadBgConsciousness() {
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

export async function toggleBgConsciousness() {
  try {
    const current = await getJSON('/api/settings/bg-consciousness');
    const d = await postJSON('/api/settings/bg-consciousness', { enabled: !current.enabled });
    showNotification('Background consciousness ' + (d.enabled ? 'ENABLED' : 'DISABLED'));
    loadBgConsciousness();
  } catch(e) { showNotification('Failed: ' + e.message, 'error'); }
}

export async function saveBgConsciousnessModel() {
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

export async function loadCursorWaves() {
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

export async function toggleCursorWaves() {
  try {
    const current = await getJSON('/api/settings/cursor-waves');
    const d = await postJSON('/api/settings/cursor-waves', { enabled: !current.enabled });
    showNotification('Cursor Parallel Waves ' + (d.enabled ? 'ENABLED ⚡' : 'DISABLED'));
    loadCursorWaves();
  } catch(e) { showNotification('Failed: ' + e.message, 'error'); }
}

export async function loadClaudeCode() {
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

export async function toggleClaudeCode() {
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

export async function loadCodexExecutor() {
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

export async function toggleCodexExecutor() {
  try {
    const current = await getJSON('/api/settings/codex');
    const d = await postJSON('/api/settings/codex', { enabled: !current.enabled });
    showNotification('Codex CLI executor ' + (d.enabled ? 'ENABLED 🟣' : 'DISABLED'));
    loadCodexExecutor();
  } catch(e) { showNotification('Failed: ' + e.message, 'error'); }
}

export async function loadGlobalFallback() {
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

export async function saveGlobalFallback() {
  const model = (document.getElementById('globalFallbackInput')?.value || '').trim();
  try {
    await postJSON('/api/settings/global-fallback', { globalFallbackModel: model });
    showNotification(model ? 'Global fallback → ' + model : 'Global fallback cleared');
    loadGlobalFallback();
  } catch(e) { showNotification('Failed: ' + e.message, 'error'); }
}

export async function loadGlobalOcLoop() {
  try {
    const d = await getJSON('/api/settings/global-oc-loop');
    const chk = document.getElementById('globalOcLoop');
    const inp = document.getElementById('globalOcLoopRounds');
    if (chk) chk.checked = d.enabled || false;
    if (inp) inp.value = d.maxRounds ?? 10;
  } catch(e) {}
}

export async function saveGlobalOcLoop() {
  const enabled = document.getElementById('globalOcLoop')?.checked;
  try {
    await postJSON('/api/settings/global-oc-loop', { enabled });
    showNotification('Global OC loop ' + (enabled ? 'enabled' : 'disabled'));
  } catch(e) { showNotification('Failed: ' + e.message, true); }
}

export async function saveGlobalOcLoopRounds() {
  const rounds = parseInt(document.getElementById('globalOcLoopRounds')?.value) || 10;
  try {
    await postJSON('/api/settings/global-oc-loop', { maxRounds: rounds });
    showNotification('Max rounds set to ' + rounds);
  } catch(e) { showNotification('Failed: ' + e.message, true); }
}

export async function loadPassthroughNotify() {
  try {
    const d = await getJSON('/api/settings/passthrough-notify');
    const sel = document.getElementById('passthroughNotifySelect');
    if (sel) sel.value = d.value || 'both';
  } catch(e) {}
}

export async function savePassthroughNotify() {
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

export async function loadLoopBrain() {
  try {
    const d = await getJSON('/api/settings/loop-brain');
    const inp = document.getElementById('loopBrainModel');
    if (inp && d.loopBrain) inp.value = d.loopBrain;
  } catch {}
}

export async function saveLoopBrain() {
  const model = (document.getElementById('loopBrainModel')?.value || '').trim();
  try {
    await postJSON('/api/settings/loop-brain', { loopBrain: model || null });
    showNotification(model ? `Loop brain → ${model}` : 'Loop brain cleared (each agent uses own model)');
  } catch(e) { showNotification('Failed: ' + e.message, true); }
}

// ── Env vars (Security sub-tab) ───────────────────────────────────────────────

const ENV_GROUPS = [
  {
    label: 'Engine — OpenCode',
    vars: [
      { key: 'CREWSWARM_OPENCODE_ENABLED',          hint: 'Route coding agents through OpenCode globally',               default: 'off' },
      { key: 'CREWSWARM_OPENCODE_MODEL',            hint: 'Model passed to OpenCode — leave blank to use per-agent model', default: 'per-agent' },
      { key: 'CREWSWARM_OPENCODE_TIMEOUT_MS',       hint: 'ms before an OpenCode task is killed',                        default: '300000' },
      { key: 'CREWSWARM_OPENCODE_AGENT',            hint: 'Override agent name passed to OpenCode',                      default: 'auto' },
    ],
  },
  {
    label: 'Engine — Claude Code & Cursor',
    note: 'Both use OAuth login (run claude or cursor once). No API key required.',
    vars: [
      { key: 'CREWSWARM_CLAUDE_CODE_MODEL', hint: 'Model passed to claude -p — leave blank for Claude Code default',   default: 'claude default' },
      { key: 'CREWSWARM_CURSOR_MODEL',      hint: 'Model passed to cursor --execute — leave blank for Cursor default', default: 'cursor default' },
    ],
  },
  {
    label: 'Engine — Docker Sandbox',
    note: 'Runs any inner engine inside an isolated Docker microVM. API keys injected by network proxy — never exposed to the agent.',
    vars: [
      { key: 'CREWSWARM_DOCKER_SANDBOX',              hint: 'Route all coding agents through Docker Sandbox globally',        default: 'off' },
      { key: 'CREWSWARM_DOCKER_SANDBOX_NAME',         hint: 'Pre-created sandbox name',                                      default: 'crewswarm' },
      { key: 'CREWSWARM_DOCKER_SANDBOX_INNER_ENGINE', hint: 'Engine inside the sandbox: claude, opencode, or codex',         default: 'claude' },
      { key: 'CREWSWARM_DOCKER_SANDBOX_TIMEOUT_MS',   hint: 'ms before a sandboxed task is killed',                          default: '300000' },
    ],
  },
  {
    label: 'Engine Loop & Dispatch',
    vars: [
      { key: 'CREWSWARM_ENGINE_LOOP',            hint: 'Enable Ouroboros engine loop for all agents',          default: 'off' },
      { key: 'CREWSWARM_ENGINE_LOOP_MAX_ROUNDS', hint: 'Max STEP iterations per loop run',                     default: '10' },
      { key: 'CREWSWARM_DISPATCH_TIMEOUT',       hint: 'ms before a dispatched task times out',                default: '120000' },
      { key: 'CREWSWARM_RT_AGENT',               hint: 'Agent ID used for the RT bus',                         default: 'crew-coder' },
    ],
  },
  {
    label: 'Ports',
    vars: [
      { key: 'CREW_LEAD_PORT',  hint: 'crew-lead HTTP server port', default: '5010' },
      { key: 'SWARM_DASH_PORT', hint: 'Dashboard port',             default: '4319' },
      { key: 'WA_HTTP_PORT',    hint: 'WhatsApp bridge HTTP port',  default: '3000' },
    ],
  },
  {
    label: 'Background Consciousness',
    vars: [
      { key: 'CREWSWARM_BG_CONSCIOUSNESS',              hint: 'Enable idle reflection loop',                                  default: 'off' },
      { key: 'CREWSWARM_BG_CONSCIOUSNESS_INTERVAL_MS',  hint: 'Idle reflection interval in ms',                               default: '900000' },
      { key: 'CREWSWARM_BG_CONSCIOUSNESS_MODEL',        hint: 'Model for background cycle (e.g. groq/llama-3.1-8b-instant)',  default: 'groq/llama-3.1-8b-instant' },
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
      { key: 'PM_MAX_ITEMS',    hint: 'Max roadmap items per PM loop run',    default: '10' },
      { key: 'PM_USE_QA',       hint: 'Include crew-qa in PM pipeline',       default: 'off' },
      { key: 'PM_USE_SECURITY', hint: 'Include crew-security in PM pipeline', default: 'off' },
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

export async function loadEnvAdvanced() {
  const box = document.getElementById('envAdvancedWidget');
  if (!box) return;
  try {
    const [envBasic, d] = await Promise.all([
      fetch('/api/env').then(r => r.json()).catch(() => ({})),
      fetch('/api/env-advanced').then(r => r.json()).catch(() => ({ env: {} })),
    ]);
    const env = d.env || {};
    const uptime = envBasic.uptime != null
      ? (envBasic.uptime < 60 ? envBasic.uptime + 's' : Math.floor(envBasic.uptime / 60) + 'm') : '—';
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
    box.querySelectorAll('[data-env-save]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.envSave;
        const inputEl = box.querySelector(`[data-env-key="${key}"]`);
        const statusEl = box.querySelector(`[data-env-status="${key}"]`);
        if (inputEl && statusEl) saveEnvVar(key, inputEl, statusEl);
      });
    });
    box.querySelectorAll('[data-env-key]').forEach(inp => {
      inp.addEventListener('input', () => {
        inp.style.color = inp.value ? 'var(--text-1)' : 'var(--text-3)';
      });
    });
  } catch(e) {
    if (box) box.textContent = 'Could not load: ' + e.message;
  }
}
