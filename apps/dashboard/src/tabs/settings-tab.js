/**
 * Settings sub-tab loaders — extracted from app.js
 * Deps: getJSON, postJSON (core/api), escHtml, showNotification (core/dom)
 * Inject model deps via initSettingsTab({ getModels, populateModelDropdown })
 */

import { getJSON, postJSON } from '../core/api.js';
import { escHtml, showNotification } from '../core/dom.js';
import { state } from '../core/state.js';
import { setStoredChatProjectId, updateChatProjectHint } from './projects-tab.js';

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

// ── Config Lock/Unlock ─────────────────────────────────────────────────────

export async function loadConfigLockStatus() {
  const badge = document.getElementById('configLockBadge');
  const status = document.getElementById('configLockStatus');
  const lockBtn = document.querySelector('[data-action="lockConfig"]');
  const unlockBtn = document.querySelector('[data-action="unlockConfig"]');
  
  try {
    const d = await getJSON('/api/config/lock-status');
    if (d.locked) {
      badge.textContent = '🔒 Locked';
      badge.style.background = 'rgba(52,211,153,0.15)';
      badge.style.color = 'var(--green)';
      badge.style.borderColor = 'rgba(52,211,153,0.3)';
      if (status) status.textContent = '✓ Config is protected from overwrites';
      
      // Update button states - lock button is active (current state)
      if (lockBtn) {
        lockBtn.className = 'btn-primary';
        lockBtn.style.opacity = '0.6';
        lockBtn.style.pointerEvents = 'none';
      }
      if (unlockBtn) {
        unlockBtn.className = 'btn-ghost';
        unlockBtn.style.opacity = '1';
        unlockBtn.style.pointerEvents = 'auto';
      }
    } else {
      badge.textContent = '🔓 Unlocked';
      badge.style.background = 'rgba(251,191,36,0.15)';
      badge.style.color = 'var(--yellow)';
      badge.style.borderColor = 'rgba(251,191,36,0.3)';
      if (status) status.textContent = '⚠️ Config can be modified — lock it after making changes';
      
      // Update button states - unlock button is active (current state)
      if (lockBtn) {
        lockBtn.className = 'btn-primary';
        lockBtn.style.opacity = '1';
        lockBtn.style.pointerEvents = 'auto';
      }
      if (unlockBtn) {
        unlockBtn.className = 'btn-ghost';
        unlockBtn.style.opacity = '0.6';
        unlockBtn.style.pointerEvents = 'none';
      }
    }
  } catch { if (badge) badge.textContent = '? unknown'; }
}

export async function lockConfig() {
  try {
    await postJSON('/api/config/lock', {});
    showNotification('✓ Config locked — protected from overwrites');
    loadConfigLockStatus();
  } catch(e) { showNotification('Lock failed: ' + e.message, 'error'); }
}

export async function unlockConfig() {
  try {
    await postJSON('/api/config/unlock', {});
    showNotification('✓ Config unlocked — you can now make changes');
    loadConfigLockStatus();
  } catch(e) { showNotification('Unlock failed: ' + e.message, 'error'); }
}

// ── OpenCode / engine settings ────────────────────────────────────────────────

export async function loadOpencodeProject() {
  try {
    const d = await getJSON('/api/settings/opencode-project');
    const inp = document.getElementById('opencodeProjInput');
    const st  = document.getElementById('opencodeProjStatus');
    if (inp) { inp.placeholder = d.dir || 'e.g. /Users/you/Desktop/myproject'; inp.value = d.dir || ''; }
    if (st) st.textContent = d.dir ? ('✅ Current: ' + d.dir) : '⚠️ Not set — OpenCode will write files to the crewswarm repo root. Set this to your project folder.';
    if (document.getElementById('opencodeFallbackSelect') && _getModels) {
      await _getModels();
      if (_populateModelDropdown) _populateModelDropdown('opencodeFallbackSelect', d.fallbackModel || '');
    }
    const fbSt = document.getElementById('opencodeFallbackStatus');
    if (fbSt) fbSt.textContent = d.fallbackModel ? ('✅ Fallback: ' + d.fallbackModel) : '⚠️ Using default groq/kimi-k2-instruct-0905';
    
    // Load primary OpenCode model
    if (document.getElementById('opencodeModelSelect') && _getModels) {
      await _getModels();
      if (_populateModelDropdown) _populateModelDropdown('opencodeModelSelect', d.opencodeModel || '');
    }
    const ocSt = document.getElementById('opencodeModelStatus');
    if (ocSt) ocSt.textContent = d.opencodeModel ? ('✅ Primary: ' + d.opencodeModel) : '⚠️ Using default groq/moonshotai/kimi-k2-instruct-0905';
    
    // Load crew-lead model
    const clSel = document.getElementById('crewLeadModelSelect');
    if (clSel && d.crewLeadModel) clSel.value = d.crewLeadModel;
  } catch {}
}

export async function saveOpencodeSettings() {
  const dir = (document.getElementById('opencodeProjInput')?.value || '').trim();
  const fallbackModel = (document.getElementById('opencodeFallbackSelect')?.value || '').trim();
  try {
    await postJSON('/api/settings/opencode-project', { dir: dir || undefined, fallbackModel: fallbackModel || undefined });
    showNotification('OpenCode settings saved — fallback takes effect on next task (no restart needed)');
    loadOpencodeProject();
    
    // Sync to chat project dropdown if this directory matches a registered project
    if (dir && state.projectsData) {
      const matchingProj = Object.values(state.projectsData).find(p => p.outputDir === dir);
      if (matchingProj) {
        state.chatActiveProjectId = matchingProj.id;
        setStoredChatProjectId(matchingProj.id);
        const sel = document.getElementById('chatProjectSelect');
        if (sel) sel.value = matchingProj.id;
        updateChatProjectHint();
      }
    }
  } catch(e) { showNotification('Save failed: ' + e.message, 'error'); }
}

export async function saveOpencodeModel() {
  const sel = document.getElementById('opencodeModelSelect');
  const opencodeModel = (sel?.value || '').trim();
  const st = document.getElementById('opencodeModelStatus');
  try {
    await postJSON('/api/settings/opencode-project', { opencodeModel: opencodeModel || undefined });
    if (st) { st.textContent = '✓ Saved'; st.style.color = 'var(--green-hi)'; }
    showNotification(opencodeModel ? `Primary OpenCode model → ${opencodeModel}` : 'OpenCode model reset to default');
    setTimeout(() => { if (st) st.textContent = opencodeModel ? ('✅ Primary: ' + opencodeModel) : '⚠️ Using default groq/moonshotai/kimi-k2-instruct-0905'; }, 3000);
  } catch(e) {
    if (st) { st.textContent = 'Error: ' + e.message; st.style.color = 'var(--red)'; }
    showNotification('Save failed: ' + e.message, 'error');
  }
}

export async function saveCrewLeadModel() {
  const sel = document.getElementById('crewLeadModelSelect');
  const crewLeadModel = (sel?.value || '').trim();
  const st = document.getElementById('crewLeadModelStatus');
  try {
    await postJSON('/api/settings/opencode-project', { crewLeadModel: crewLeadModel || undefined });
    if (st) { st.textContent = '✓ Saved'; st.style.color = 'var(--green-hi)'; }
    showNotification(crewLeadModel ? `Crew lead model → ${crewLeadModel}` : 'Crew lead model reset to default');
    setTimeout(() => { if (st) st.textContent = ''; }, 3000);
  } catch(e) {
    if (st) { st.textContent = 'Error: ' + e.message; st.style.color = 'var(--red)'; }
    showNotification('Save failed: ' + e.message, 'error');
  }
}

export async function loadBgConsciousness() {
  const btn = document.getElementById('bgConsciousnessBtn');
  const status = document.getElementById('bgConsciousnessStatus');
  const modelInput = document.getElementById('bgConsciousnessModel');
  try {
    const d = await getJSON('/api/settings/bg-consciousness');
    if (d.ok === false) {
      if (btn) btn.textContent = '⚫ OFF';
      if (status) { status.textContent = '⚠️ Could not reach crew-lead — restart services.'; status.style.color = 'var(--amber)'; }
      return;
    }
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
    if (current.ok === false) { showNotification('Cannot reach crew-lead — restart services first', 'error'); return; }
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
    if (d.ok === false) {
      if (btn) btn.textContent = '⚫ OFF';
      if (status) { status.textContent = '⚠️ Could not reach crew-lead — restart services.'; status.style.color = 'var(--amber)'; }
      return;
    }
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
    if (current.ok === false) { showNotification('Cannot reach crew-lead — restart services first', 'error'); return; }
    const d = await postJSON('/api/settings/cursor-waves', { enabled: !current.enabled });
    showNotification('Cursor Parallel Waves ' + (d.enabled ? 'ENABLED ⚡' : 'DISABLED'));
    loadCursorWaves();
  } catch(e) { showNotification('Failed: ' + e.message, 'error'); }
}

export async function loadTmuxBridge() {
  const btn = document.getElementById('tmuxBridgeBtn');
  const status = document.getElementById('tmuxBridgeStatus');
  try {
    const d = await getJSON('/api/settings/tmux-bridge');
    if (d.ok === false) {
      if (btn) btn.textContent = '⚫ OFF';
      if (status) { status.textContent = '⚠️ Could not reach crew-lead — restart services.'; status.style.color = 'var(--amber)'; }
      return;
    }
    const on = d.enabled;
    if (btn) {
      btn.textContent = on ? '🔌 ON' : '⚫ OFF';
      btn.style.background = on ? 'rgba(52,211,153,0.15)' : 'var(--surface-2)';
      btn.style.borderColor = on ? 'rgba(52,211,153,0.3)' : 'var(--border)';
      btn.style.color = on ? 'var(--green)' : 'var(--text-2)';
    }
    if (status) status.textContent = on
      ? 'Active — agents can share persistent tmux sessions across pipeline waves. Requires tmux + smux.'
      : 'Off — agents use standard cold-start execution (no session persistence).';
  } catch(e) {
    if (btn) btn.textContent = 'Error';
    if (status) status.textContent = 'Could not load: ' + e.message;
  }
}

export async function toggleTmuxBridge() {
  try {
    const current = await getJSON('/api/settings/tmux-bridge');
    if (current.ok === false) { showNotification('Cannot reach crew-lead — restart services first', 'error'); return; }
    const d = await postJSON('/api/settings/tmux-bridge', { enabled: !current.enabled });
    showNotification('tmux-bridge ' + (d.enabled ? 'ENABLED 🔌' : 'DISABLED'));
    loadTmuxBridge();
  } catch(e) { showNotification('Failed: ' + e.message, 'error'); }
}

export async function loadAutonomousMentions() {
  const btn = document.getElementById('autonomousMentionsBtn');
  const status = document.getElementById('autonomousMentionsStatus');
  try {
    const d = await getJSON('/api/settings/autonomous-mentions');
    if (d.ok === false) {
      if (btn) btn.textContent = '⚫ OFF';
      if (status) { status.textContent = '⚠️ Could not reach crew-lead — restart services.'; status.style.color = 'var(--amber)'; }
      return;
    }
    const on = d.enabled !== false;
    if (btn) {
      btn.textContent = on ? '🕸 ON' : '⚫ OFF';
      btn.style.background = on ? 'rgba(52,211,153,0.15)' : 'var(--surface-2)';
      btn.style.borderColor = on ? 'rgba(52,211,153,0.3)' : 'var(--border)';
      btn.style.color = on ? 'var(--green)' : 'var(--text-2)';
    }
    if (status) {
      status.textContent = on
        ? 'Active — shared chat @mentions can auto-route to agents and CLI participants.'
        : 'Off — @mentions are recorded in chat history, but no autonomous routing will fire.';
      status.style.color = 'var(--text-3)';
    }
  } catch (e) {
    if (btn) btn.textContent = 'Error';
    if (status) status.textContent = 'Could not load: ' + e.message;
  }
}

export async function toggleAutonomousMentions() {
  try {
    const current = await getJSON('/api/settings/autonomous-mentions');
    if (current.ok === false) { showNotification('Cannot reach crew-lead — restart services first', 'error'); return; }
    const d = await postJSON('/api/settings/autonomous-mentions', {
      enabled: !current.enabled,
    });
    showNotification(
      'Autonomous mention routing ' + (d.enabled ? 'ENABLED 🕸' : 'DISABLED'),
    );
    loadAutonomousMentions();
  } catch (e) {
    showNotification('Failed: ' + e.message, 'error');
  }
}

export async function loadClaudeCode() {
  const btn = document.getElementById('claudeCodeBtn');
  const status = document.getElementById('claudeCodeStatus');
  try {
    const d = await getJSON('/api/settings/claude-code');
    if (d.ok === false) {
      if (btn) btn.textContent = '⚫ OFF';
      if (status) {
        status.textContent = '⚠️ Could not reach crew-lead — restart services or check that crew-lead is running.';
        status.style.color = 'var(--amber)';
      }
      return;
    }
    const on = d.enabled;
    if (btn) {
      btn.textContent = on ? '🤖 ON' : '⚫ OFF';
      btn.style.background = on ? 'rgba(245,158,11,0.15)' : 'var(--surface-2)';
      btn.style.borderColor = on ? 'var(--amber)' : 'var(--border)';
      btn.style.color = on ? 'var(--yellow)' : 'var(--text-2)';
    }
    if (status) {
      if (!d.hasKey) {
        status.textContent = '⚠️ No Claude auth found — run "claude" in terminal to authenticate via OAuth, or set ANTHROPIC_API_KEY.';
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
    if (current.ok === false) {
      showNotification('Cannot reach crew-lead — restart services first', 'error');
      return;
    }
    if (!current.hasKey) {
      showNotification('No Claude auth found — run "claude" in terminal to authenticate via OAuth, or set ANTHROPIC_API_KEY', 'error');
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
    if (d.ok === false) {
      if (btn) btn.textContent = '⚫ OFF';
      if (status) { status.textContent = '⚠️ Could not reach crew-lead — restart services.'; status.style.color = 'var(--amber)'; }
      return;
    }
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
    if (current.ok === false) { showNotification('Cannot reach crew-lead — restart services first', 'error'); return; }
    const d = await postJSON('/api/settings/codex', { enabled: !current.enabled });
    showNotification('Codex CLI executor ' + (d.enabled ? 'ENABLED 🟣' : 'DISABLED'));
    loadCodexExecutor();
  } catch(e) { showNotification('Failed: ' + e.message, 'error'); }
}

export async function loadGeminiCliExecutor() {
  const btn = document.getElementById('geminiCliBtn');
  const status = document.getElementById('geminiCliStatus');
  try {
    const d = await getJSON('/api/settings/gemini-cli');
    if (d.ok === false) {
      if (btn) btn.textContent = '⚫ OFF';
      if (status) { status.textContent = '⚠️ Could not reach crew-lead — restart services.'; status.style.color = 'var(--amber)'; }
      return;
    }
    const on = d.enabled;
    if (btn) {
      btn.textContent = on ? '🔵 ON' : '⚫ OFF';
      btn.style.background = on ? 'rgba(66,133,244,0.15)' : 'var(--surface-2)';
      btn.style.borderColor = on ? '#4285f4' : 'var(--border)';
      btn.style.color = on ? '#4285f4' : 'var(--text-2)';
    }
    if (status) {
      if (!d.installed) {
        status.textContent = '⚠️ gemini binary not found — run: npm install -g @google/gemini-cli';
        status.style.color = 'var(--amber)';
      } else {
        status.textContent = on
          ? 'Active — tasks route through Gemini CLI. Run gemini auth login if you haven\'t authenticated yet.'
          : 'Off — tasks use direct LLM or other engine. Enable to route coding agents through Gemini CLI (free Google OAuth tier).';
        status.style.color = 'var(--text-3)';
      }
    }
  } catch(e) {
    if (btn) btn.textContent = 'Error';
    if (status) { status.textContent = 'Could not load: ' + e.message; status.style.color = 'var(--text-3)'; }
  }
}

export async function toggleGeminiCliExecutor() {
  try {
    const current = await getJSON('/api/settings/gemini-cli');
    if (current.ok === false) { showNotification('Cannot reach crew-lead — restart services first', 'error'); return; }
    if (!current.installed) {
      showNotification('Install Gemini CLI first: npm install -g @google/gemini-cli', 'error');
      return;
    }
    const d = await postJSON('/api/settings/gemini-cli', { enabled: !current.enabled });
    showNotification('Gemini CLI executor ' + (d.enabled ? 'ENABLED 🔵' : 'DISABLED'));
    loadGeminiCliExecutor();
  } catch(e) { showNotification('Failed: ' + e.message, 'error'); }
}

export async function loadCrewCliExecutor() {
  const btn = document.getElementById('crewCliBtn');
  const status = document.getElementById('crewCliStatus');
  try {
    const d = await getJSON('/api/settings/crew-cli');
    if (d.ok === false) {
      if (btn) btn.textContent = '⚫ OFF';
      if (status) { status.textContent = '⚠️ Could not reach crew-lead — restart services.'; status.style.color = 'var(--amber)'; }
      return;
    }
    const on = d.enabled;
    if (btn) {
      btn.textContent = on ? '🔧 ON' : '⚫ OFF';
      btn.style.background = on ? 'rgba(16,185,129,0.15)' : 'var(--surface-2)';
      btn.style.borderColor = on ? '#10b981' : 'var(--border)';
      btn.style.color = on ? '#10b981' : 'var(--text-2)';
    }
    if (status) {
      status.textContent = on
        ? 'Active — multi-agent swarm tasks route through crew-cli with intelligent dispatch to specialists.'
        : 'Off — tasks use direct LLM or other engine. Enable to route all coding agents through crew-cli natively.';
    }
  } catch(e) {
    if (btn) btn.textContent = 'Error';
    if (status) status.textContent = 'Could not load status';
  }
}

export async function toggleCrewCliExecutor() {
  try {
    const current = await getJSON('/api/settings/crew-cli');
    if (current.ok === false) { showNotification('Cannot reach crew-lead — restart services first', 'error'); return; }
    const d = await postJSON('/api/settings/crew-cli', { enabled: !current.enabled });
    showNotification('Crew CLI executor ' + (d.enabled ? 'ENABLED 🔧' : 'DISABLED'));
    loadCrewCliExecutor();
  } catch(e) { showNotification('Failed: ' + e.message, 'error'); }
}

export async function loadOpencodeExecutor() {
  const btn = document.getElementById('opencodeBtn');
  const status = document.getElementById('opencodeStatus');
  try {
    const d = await getJSON('/api/settings/opencode');
    if (d.ok === false) {
      if (btn) btn.textContent = '⚫ OFF';
      if (status) { status.textContent = '⚠️ Could not reach crew-lead — restart services.'; status.style.color = 'var(--amber)'; }
      return;
    }
    const on = d.enabled;
    if (btn) {
      btn.textContent = on ? '⚡ ON' : '⚫ OFF';
      btn.style.background = on ? 'rgba(52,211,153,0.15)' : 'var(--surface-2)';
      btn.style.borderColor = on ? 'rgba(52,211,153,0.3)' : 'var(--border)';
      btn.style.color = on ? 'var(--green)' : 'var(--text-2)';
    }
    if (status) {
      if (!d.installed) {
        status.textContent = '⚠️ opencode binary not found — install: npm install -g opencode';
        status.style.color = 'var(--amber)';
      } else {
        status.textContent = on
          ? '⚡ Active — coding agents route through OpenCode for full IDE context and session persistence.'
          : '⚫ Off — tasks use direct LLM or other configured engine. Enable to run agents through OpenCode CLI.';
        status.style.color = 'var(--text-3)';
      }
    }
  } catch(e) {
    if (btn) btn.textContent = 'Error';
    if (status) { status.textContent = 'Could not load status'; status.style.color = 'var(--text-3)'; }
  }
}

export async function toggleOpencodeExecutor() {
  try {
    const current = await getJSON('/api/settings/opencode');
    if (current.ok === false) { showNotification('Cannot reach crew-lead — restart services first', 'error'); return; }
    if (!current.installed) {
      showNotification('Install OpenCode CLI first: npm install -g opencode', 'error');
      return;
    }
    const d = await postJSON('/api/settings/opencode', { enabled: !current.enabled });
    showNotification('OpenCode executor ' + (d.enabled ? 'ENABLED ⚡' : 'DISABLED'));
    loadOpencodeExecutor();
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
      { key: 'CREWSWARM_CURSOR_MODEL',      hint: 'Cursor CLI --model when agent has no cursorCliModel (default: composer-2-fast)', default: 'composer-2-fast' },
    ],
  },
  {
    label: 'Engine — Codex & crew-cli',
    note: 'These are the dashboard-wide defaults when an agent does not have a per-route model override.',
    vars: [
      { key: 'CREWSWARM_CODEX_MODEL',     hint: 'Model passed to codex exec --model (leave blank for Codex default)', default: 'codex default' },
      { key: 'CREWSWARM_CREW_CLI_MODEL',  hint: 'Model passed to crew chat --model and gateway crew-cli engine',      default: 'gemini-2.5-flash' },
    ],
  },
  {
    label: 'Engine — Gemini CLI',
    note: 'Free tier via Google account — 60 req/min. Run gemini once to auth.',
    vars: [
      { key: 'CREWSWARM_GEMINI_CLI_ENABLED', hint: 'Route agents through Gemini CLI globally',                               default: 'off' },
      { key: 'CREWSWARM_GEMINI_CLI_MODEL',   hint: 'Model passed to gemini -p (e.g. gemini-2.0-flash) — blank for default',  default: 'gemini default' },
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
      { key: 'CREWSWARM_ENGINE_LOOP',                 hint: 'Enable Ouroboros engine loop for all agents',                      default: 'off' },
      { key: 'CREWSWARM_ENGINE_LOOP_MAX_ROUNDS',      hint: 'Max STEP iterations per loop run',                                 default: '10' },
      { key: 'CREWSWARM_ENGINE_IDLE_TIMEOUT_MS',      hint: 'Kill engine (Cursor/Claude) if no output for this many ms',        default: '300000' },
      { key: 'CREWSWARM_ENGINE_MAX_TOTAL_MS',         hint: 'Absolute max ms for any single engine task',                       default: '2700000' },
      { key: 'CREWSWARM_DISPATCH_TIMEOUT_MS',         hint: 'ms before an unclaimed dispatch times out',                        default: '300000' },
      { key: 'CREWSWARM_DISPATCH_CLAIMED_TIMEOUT_MS', hint: 'ms before a claimed (in-progress) dispatch times out',             default: '900000' },
      { key: 'CREWSWARM_RT_AGENT',                    hint: 'Agent ID used for the RT bus',                                     default: 'crew-coder' },
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
    label: 'crew-cli — Streaming & Hooks',
    note: 'Controls for crew-cli streaming output, tool hooks, and session token limits.',
    vars: [
      { key: 'CREW_NO_STREAM',          hint: 'Disable streaming output — tokens arrive after full response (true/false)', default: 'false' },
      { key: 'CREW_HOOKS_FILE',         hint: 'Path to hooks.json for PreToolUse/PostToolUse hooks',                       default: '.crew/hooks.json' },
      { key: 'CREW_MAX_SESSION_TOKENS',  hint: 'Max estimated tokens per session before oldest turns are trimmed',          default: '100000' },
    ],
  },
  {
    label: 'crew-cli — Codebase Index & RAG',
    note: 'Codebase embedding index auto-builds on startup. Injects relevant file context into every worker prompt.',
    vars: [
      { key: 'CREW_RAG_MODE',            hint: 'RAG mode: auto (use index when ready, else keyword), semantic, keyword, import-graph, off', default: 'auto' },
      { key: 'CREW_EMBEDDING_PROVIDER',  hint: 'Embedding provider: local (zero-cost), openai (best), gemini (free tier)',                  default: 'local' },
      { key: 'CREW_RAG_WORKER_BUDGET',   hint: 'Max tokens of RAG context injected per worker (approximate)',                               default: '4000' },
      { key: 'CREW_RAG_MAX_FILES',       hint: 'Max code files to index (larger repos should increase this)',                                default: '2000' },
      { key: 'CREW_RAG_BATCH_SIZE',      hint: 'Files per embedding batch (higher = faster but more API calls)',                             default: '20' },
    ],
  },
  {
    label: 'crew-cli — Checkpointing',
    note: 'Automatic git checkpoints during pipeline execution for easy rollback.',
    vars: [
      { key: 'CREW_AUTO_CHECKPOINT',         hint: 'Enable auto-commit at task boundaries (true/false)',                     default: 'true' },
      { key: 'CREW_CHECKPOINT_INTERVAL_MS',  hint: 'Periodic git stash snapshot interval during long tasks (ms, 0=off)',     default: '60000' },
    ],
  },
  {
    label: 'PM Loop',
    vars: [
      { key: 'PM_MAX_ITEMS',           hint: 'Max roadmap items per PM loop run',                                        default: '10' },
      { key: 'PM_MAX_CONCURRENT',      hint: 'Max concurrent agent tasks in PM loop',                                    default: '20' },
      { key: 'PM_USE_QA',              hint: 'Include crew-qa review after each PM task',                                default: 'off' },
      { key: 'PM_USE_SECURITY',        hint: 'Include crew-security review for auth/key tasks',                          default: 'off' },
      { key: 'PM_USE_SPECIALISTS',     hint: 'Route tasks to specialist agents (front/back/github) by keyword',          default: 'on' },
      { key: 'PM_SELF_EXTEND',         hint: 'Auto-generate new roadmap items when queue is empty',                      default: 'on' },
      { key: 'PM_EXTEND_EVERY',        hint: 'Generate new items every N completions (0 = only when empty)',             default: '5' },
      { key: 'PM_CODER_AGENT',         hint: 'Override default coding agent for PM loop (e.g. crew-coder-front)',        default: 'crew-coder' },
      { key: 'PM_AGENT_IDLE_TIMEOUT_MS', hint: 'Kill PM dispatch if no activity for this many ms',                      default: '900000' },
      { key: 'PHASED_TASK_TIMEOUT_MS', hint: 'Overall timeout for a single agent task in the PM loop',                  default: '600000' },
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
        const saved = env[key] ?? null;
        // Show saved value if set, otherwise fall back to the default so users
        // can see the effective value and edit from a sensible starting point.
        const current = saved ?? def ?? '';
        const isDefault = saved === null;
        const placeholder = def ? `default: ${def}` : 'not set';
        const row = document.createElement('div');
        row.style.cssText = 'margin-bottom:8px;';
        row.innerHTML = `
          <div style="display:flex;align-items:baseline;gap:6px;margin-bottom:3px;">
            <span style="font-size:11px;font-family:monospace;color:var(--accent);">${escHtml(key)}</span>
            ${isDefault && def ? `<span style="font-size:10px;color:var(--text-3);font-family:monospace;background:var(--bg-1);padding:1px 5px;border-radius:4px;border:1px solid var(--border);">default</span>` : ''}
          </div>
          <div style="font-size:10px;color:var(--text-3);margin-bottom:4px;">${escHtml(hint)}</div>
          <div style="display:flex;gap:6px;align-items:center;">
            <input data-env-key="${escHtml(key)}" data-env-default="${escHtml(def || '')}" type="text" value="${escHtml(current)}"
              placeholder="${escHtml(placeholder)}"
              class="inp-sm inp-mono inp-flex" />
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
        // Dim if empty or if value matches the default (user hasn't customised)
        const isDefault = inp.value === (inp.dataset.envDefault || '');
        inp.style.color = 'var(--text-1)';
        inp.style.opacity = isDefault ? '0.65' : '1';
      });
    });
  } catch(e) {
    if (box) box.textContent = 'Could not load: ' + e.message;
  }
}
