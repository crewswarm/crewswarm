import { getJSON, postJSON } from '../core/api.js';
import { showNotification, renderStatusBadge } from '../core/dom.js';
import { sortAgents } from '../core/state.js';

let hideAllViews = () => {};
let setNavActive = () => {};
let refreshAgents = () => {};

export function initAgentsTab(deps = {}) {
  hideAllViews = deps.hideAllViews || hideAllViews;
  setNavActive = deps.setNavActive || setNavActive;
  refreshAgents = deps.refreshAgents || refreshAgents;
}

export function showAgents(){
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
      const liveDot = renderStatusBadge(a.liveness, a.ageSec);
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
              <button id="route-gemini-${a.id}" data-action="setRoute" data-arg="${a.id}" data-arg2="gemini"
                style="font-size:11px; font-weight:600; padding:5px 12px; border-radius:6px; cursor:pointer; border:1px solid ${a.useGeminiCli ? '#4285f4' : 'var(--border)'}; background:${a.useGeminiCli ? 'rgba(66,133,244,0.12)' : 'var(--surface-2)'}; color:${a.useGeminiCli ? '#4285f4' : 'var(--text-2)'};">
                🔵 Gemini CLI <span style="font-size:10px; font-weight:400; opacity:0.7;">(free · OAuth)</span>
              </button>
            </div>
            <div id="loop-row-${a.id}" style="display:${(a.useOpenCode || a.useCursorCli || a.useClaudeCode || a.useCodex || a.useGeminiCli) ? 'flex' : 'none'}; align-items:center; gap:10px; margin-bottom:10px; padding:8px 10px; background:var(--surface-2); border-radius:8px; border:1px solid var(--border);">
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
            <div id="gemini-model-row-${a.id}" style="display:${a.useGeminiCli ? 'flex' : 'none'}; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:10px;">
              <select id="gemini-model-sel-${a.id}" style="flex:1; min-width:200px; font-size:12px;" onchange="syncGeminiModelText('${a.id}')">
                <option value="">— auto (gemini-2.5-pro) —</option>
                <option value="gemini-2.5-pro" ${(a.geminiCliModel||'') === 'gemini-2.5-pro' ? 'selected' : ''}>gemini-2.5-pro — best reasoning</option>
                <option value="gemini-2.5-flash" ${(a.geminiCliModel||'') === 'gemini-2.5-flash' ? 'selected' : ''}>gemini-2.5-flash — fast &amp; cheap</option>
                <option value="gemini-2.0-flash" ${(a.geminiCliModel||'') === 'gemini-2.0-flash' ? 'selected' : ''}>gemini-2.0-flash — ultra fast</option>
              </select>
              <input id="gemini-model-txt-${a.id}" type="text" placeholder="gemini-2.5-flash or leave blank for auto" value="${a.geminiCliModel || ''}" style="flex:1; min-width:160px; font-size:12px;" />
              <button data-action="saveGeminiCliConfig" data-arg="${a.id}" class="btn-ghost" style="white-space:nowrap; font-size:12px; color:#4285f4; border-color:rgba(66,133,244,0.3);">Save</button>
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

// route toggle — mutually exclusive
async function setRoute(agentId, route) {
  const useOpenCode   = route === 'opencode';
  const useCursorCli  = route === 'cursor';
  const useClaudeCode = route === 'claudecode';
  const useCodex      = route === 'codex';
  const useGeminiCli  = route === 'gemini';
  // Update button styles
  const styles = {
    direct:      { border: 'var(--accent)',    bg: 'rgba(99,102,241,0.15)',   color: 'var(--accent)' },
    opencode:    { border: 'var(--green-hi)',  bg: 'rgba(34,197,94,0.12)',    color: 'var(--green-hi)' },
    cursor:      { border: 'var(--accent)',    bg: 'rgba(56,189,248,0.12)',   color: 'var(--accent)' },
    claudecode:  { border: '#f59e0b',          bg: 'rgba(245,158,11,0.12)',  color: '#f59e0b' },
    codex:       { border: '#a855f7',          bg: 'rgba(168,85,247,0.12)',  color: '#a855f7' },
    gemini:      { border: '#4285f4',          bg: 'rgba(66,133,244,0.12)',  color: '#4285f4' },
    inactive:    { border: 'var(--border)',    bg: 'var(--surface-2)',        color: 'var(--text-2)' },
  };
  ['direct','opencode','cursor','claudecode','codex','gemini'].forEach(r => {
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
  const geminiRow    = document.getElementById('gemini-model-row-' + agentId);
  if (ocRow)      ocRow.style.display      = useOpenCode   ? 'flex' : 'none';
  if (ocFbRow)    ocFbRow.style.display    = useOpenCode   ? 'flex' : 'none';
  if (cursorRow)  cursorRow.style.display  = useCursorCli  ? 'flex' : 'none';
  if (ccRow)      ccRow.style.display      = useClaudeCode ? 'flex' : 'none';
  if (geminiRow)  geminiRow.style.display  = useGeminiCli  ? 'flex' : 'none';
  const loopRow = document.getElementById('loop-row-' + agentId);
  if (loopRow)   loopRow.style.display   = (useOpenCode || useCursorCli || useClaudeCode || useCodex || useGeminiCli) ? 'flex' : 'none';
  // Save
  try {
    await postJSON('/api/agents-config/update', { agentId, useOpenCode, useCursorCli, useClaudeCode, useCodex, useGeminiCli });
    const labels = { direct: 'Direct API', opencode: 'OpenCode', cursor: 'Cursor CLI', claudecode: 'Claude Code', codex: 'Codex CLI', gemini: 'Gemini CLI' };
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

function syncGeminiModelText(agentId) {
  const sel = document.getElementById('gemini-model-sel-' + agentId);
  const txt = document.getElementById('gemini-model-txt-' + agentId);
  if (sel && txt) txt.value = sel.value;
}
window.syncGeminiModelText = syncGeminiModelText;

async function saveGeminiCliConfig(agentId) {
  const geminiCliModel = (document.getElementById('gemini-model-txt-' + agentId)?.value || '').trim();
  try {
    await postJSON('/api/agents-config/update', { agentId, geminiCliModel });
    showNotification(agentId + ' Gemini model → ' + (geminiCliModel || 'auto'));
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
  const labels = { cursor: 'Cursor CLI', opencode: 'OpenCode', claudecode: 'Claude Code', codex: 'Codex CLI', gemini: 'Gemini CLI', direct: 'Direct API' };
  const label = labels[route] || 'Direct API';
  showNotification('Applying ' + label + ' to all coding agents…');
  for (const agentId of CODING_AGENTS) {
    const useOpenCode   = route === 'opencode';
    const useCursorCli  = route === 'cursor';
    const useClaudeCode = route === 'claudecode';
    const useCodex      = route === 'codex';
    const useGeminiCli  = route === 'gemini';
    try {
      const payload = { agentId, useOpenCode, useCursorCli, useClaudeCode, useCodex, useGeminiCli };
      if (model && route === 'cursor')      payload.cursorCliModel  = model;
      if (model && route === 'opencode')    payload.opencodeModel   = model;
      if (model && route === 'claudecode')  payload.claudeCodeModel = model;
      if (model && route === 'gemini')      payload.geminiCliModel  = model;
      await postJSON('/api/agents-config/update', payload);
    } catch(e) { console.error('bulkSetRoute failed for', agentId, e.message); }
  }
  showNotification('Done — ' + CODING_AGENTS.length + ' agents set to ' + label + (model ? ' (' + model + ')' : ''));
  refreshAgents();
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

export function applyNewAgentToolPreset() {
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

export function applyPromptPreset() {
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
}

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

export function populateModelDropdown(selectId, currentVal) {
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
  // Populate preset dropdown dynamically (PRESET_OPTIONS is client-side only)
  const sel = document.getElementById('naPromptPreset');
  if (sel && sel.options.length <= 1) {
    PRESET_OPTIONS.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.value; opt.textContent = p.label;
      sel.appendChild(opt);
    });
  }
  // Populate tool checkboxes dynamically (CREWSWARM_TOOLS is not available at HTML parse time)
  const grid = document.getElementById('naToolsGrid');
  if (grid && grid.querySelectorAll('.naToolCheck').length === 0) {
    grid.innerHTML = CREWSWARM_TOOLS.map(t => `
      <label style="display:flex; align-items:flex-start; gap:7px; font-size:12px; color:var(--text-2); cursor:pointer; padding:6px 8px; border-radius:5px; border:1px solid var(--border); background:var(--bg-card2);">
        <input type="checkbox" class="naToolCheck" data-tool="${t.id}" style="accent-color:var(--accent); margin-top:2px; flex-shrink:0;" />
        <div>
          <code style="font-size:11px; color:var(--text-1);">${t.id}</code>
          <div style="font-size:10px; color:var(--text-3); margin-top:2px; line-height:1.3;">${t.desc}</div>
        </div>
      </label>
    `).join('');
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

export {
  loadAgents_cfg,
  applyToolPreset,
  toggleAgentBody,
  deleteAgent,
  saveAgentModel,
  saveAgentFallback,
  toggleEmojiPicker,
  saveAgentIdentity,
  saveAgentPrompt,
  resetAgentSession,
  saveAgentTools,
  setRoute,
  saveOpenCodeConfig,
  saveOpenCodeFallback,
  saveCursorCliConfig,
  saveClaudeCodeConfig,
  saveGeminiCliConfig,
  bulkSetRoute,
  startCrew,
};
