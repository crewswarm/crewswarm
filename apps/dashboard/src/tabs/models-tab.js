/**
 * Models / Providers / Search-tools tab — extracted from app.js
 * Deps: getJSON, postJSON (core/api), showNotification (core/dom)
 * Inject: initModelsTab({ hideAllViews, setNavActive, loadAgents: loadAgents_cfg })
 */

import { getJSON, postJSON } from '../core/api.js';
import { showNotification, showLoading, showError } from '../core/dom.js';

let _hideAllViews = () => {};
let _setNavActive = () => {};
let _loadAgents   = () => {};

export function initModelsTab({ hideAllViews, setNavActive, loadAgents } = {}) {
  _hideAllViews = hideAllViews || _hideAllViews;
  _setNavActive = setNavActive || _setNavActive;
  _loadAgents   = loadAgents   || _loadAgents;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const BUILTIN_PROVIDERS = [
  { id:'groq',         label:'Groq',              icon:'⚡', url:'https://console.groq.com/keys',              hint:'Fast inference — great for crew-coder, crew-fixer' },
  { id:'fireworks',    label:'Fireworks AI',      icon:'🎆', url:'https://fireworks.ai/',                       hint:'OpenAI-compatible inference platform — fast serverless models, custom deployments, and easy model discovery' },
  { id:'anthropic',    label:'Anthropic',          icon:'🟣', url:'https://console.anthropic.com/',              hint:'Claude models — best for complex reasoning tasks' },
  { id:'openai',       label:'OpenAI (API)',        icon:'🟢', url:'https://platform.openai.com/api-keys',        hint:'GPT-4o and o-series — pay per use with API key' },
  { id:'cerebras',     label:'Cerebras',            icon:'🧠', url:'https://cloud.cerebras.ai/',                  hint:'Ultra-fast inference on Cerebras hardware — llama-3.3-70b at 2,000 tok/s' },
  { id:'nvidia',       label:'NVIDIA NIM',          icon:'🎮', url:'https://build.nvidia.com/explore/discover',   hint:'NVIDIA NIM microservices — Llama, Mistral, Phi and more' },
  { id:'openrouter',   label:'OpenRouter',           icon:'🔀', url:'https://openrouter.ai/keys',                  hint:'One API key for 400+ models — Claude, GPT-4, Gemini, Hunter Alpha, Llama and more' },
  { id:'perplexity',   label:'Perplexity',          icon:'🔍', url:'https://www.perplexity.ai/settings/api',      hint:'Sonar Pro — ideal for crew-pm research tasks' },
  { id:'mistral',      label:'Mistral',             icon:'🌀', url:'https://console.mistral.ai/',                 hint:'Open-weight models, efficient mid-tier tasks' },
  { id:'deepseek',     label:'DeepSeek',            icon:'🌊', url:'https://platform.deepseek.com/',              hint:'Low cost, strong coding performance' },
  { id:'together',     label:'Together AI',         icon:'🤝', url:'https://api.together.ai/',                    hint:'OpenAI-compatible access to strong open models like Qwen, DeepSeek, Llama, and more' },
  { id:'xai',          label:'xAI (Grok)',          icon:'𝕏',  url:'https://console.x.ai/',                      hint:'Grok models with real-time X/Twitter access, vision (grok-vision-beta), 128K context — ideal for research, social media analysis' },
  { id:'huggingface',  label:'Hugging Face',        icon:'🤗', url:'https://huggingface.co/settings/tokens',      hint:'Open-source model hub — access thousands of models via Inference API' },
  { id:'venice',       label:'Venice AI',           icon:'🏖️', url:'https://venice.ai/settings/api',              hint:'Privacy-focused inference — no logging, no training on your data' },
  { id:'moonshot',     label:'Moonshot / Kimi',     icon:'🌙', url:'https://platform.moonshot.cn/console/api-keys', hint:'128K+ context windows — strong on long codebases, Chinese + English' },
  { id:'minimax',      label:'MiniMax',             icon:'✨', url:'https://www.minimaxi.com/',                    hint:'Chinese LLM provider — competitive pricing, multilingual' },
  { id:'volcengine',   label:'Volcengine',          icon:'🌋', url:'https://console.volcengine.com/ark',          hint:'ByteDance Doubao models — fast inference' },
  { id:'qianfan',      label:'Baidu Qianfan',       icon:'🔵', url:'https://console.bce.baidu.com/qianfan/',      hint:'Baidu ERNIE models — strong on Chinese language and reasoning' },
  { id:'ollama',       label:'Ollama',              icon:'🏠', url:'https://ollama.com/download',                 hint:'Local models — no API key needed, runs offline' },
  { id:'vllm',         label:'vLLM',                icon:'⚡', url:'https://docs.vllm.ai/',                       hint:'Self-hosted inference server — any open model, OpenAI-compatible' },
  { id:'sglang',       label:'SGLang',              icon:'⚡', url:'https://github.com/sgl-project/sglang',      hint:'Self-hosted inference server — fast structured generation' },
  { id:'openai-local', label:'OpenAI (local)',      icon:'🟢', url:'https://github.com/RayBytes/ChatMock',        hint:'ChatMock — use ChatGPT Plus/Pro subscription. Run ChatMock server first (e.g. port 8000). Key ignored.' },
];

const SEARCH_TOOLS = [
  { id:'parallel', label:'Parallel',    icon:'🔬', url:'https://platform.parallel.ai/signup', hint:'Deep research & web synthesis — used by crew-pm for project planning', envKey:'PARALLEL_API_KEY' },
  { id:'brave',    label:'Brave Search', icon:'🦁', url:'https://api.search.brave.com/',       hint:'Fast web search (~700ms) — best for quick agent lookups',            envKey:'BRAVE_API_KEY'    },
];

const PROVIDER_ICONS = {
  opencode:'🚀', groq:'⚡', fireworks:'🎆', nvidia:'🎮', ollama:'🏠', 'openai-local':'🟢', xai:'𝕏',
  google:'🔵', deepseek:'🌊', openai:'🟢', perplexity:'🔍', cerebras:'🧠', mistral:'🌀',
  together:'🤝', cohere:'🔶', anthropic:'🟣', openrouter:'🔀', huggingface:'🤗',
  venice:'🏖️', moonshot:'🌙', minimax:'✨', volcengine:'🌋', qianfan:'🔵', vllm:'⚡', sglang:'⚡',
};

// ── OAuth providers (subscription-based, no API key) ──────────────────────────

const OAUTH_PROVIDERS = [
  {
    id: 'anthropic-oauth',
    label: 'Anthropic (Claude Max/Pro)',
    icon: '🟣',
    hint: 'Use Claude via your Claude.ai subscription — no API key needed. Run <code>claude login</code> to authenticate.',
    models: [
      { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 · Fastest · Lowest cost' },
      { value: 'claude-sonnet-4-6',         label: 'Sonnet 4.6 · Recommended · Best balance' },
      { value: 'claude-opus-4-6',           label: 'Opus 4.6 · Most capable · Heaviest' },
    ],
    configKey: 'claudeOauthModel',
    loginCmd: 'claude login',
  },
  {
    id: 'openai-oauth',
    label: 'OpenAI (ChatGPT Plus/Pro)',
    icon: '🟢',
    hint: 'Use GPT models via your ChatGPT subscription — no API key needed. Run <code>codex login</code> to authenticate.',
    models: [
      { value: 'gpt-4o',    label: 'GPT-4o · Fast & capable' },
      { value: 'gpt-5.4',   label: 'GPT-5.4 · Latest · Recommended' },
      { value: 'o3',        label: 'o3 · Deep reasoning' },
      { value: 'o4-mini',   label: 'o4-mini · Fast reasoning' },
    ],
    configKey: 'openaiOauthModel',
    loginCmd: 'codex login',
  },
];

export async function loadOAuthProviders() {
  const list = document.getElementById('oauthProvidersList');
  if (!list) return;
  let status = {};
  try { status = (await getJSON('/api/oauth/status')).providers || {}; } catch {}
  let cfg = {};
  try { cfg = (await getJSON('/api/oauth/model')).models || {}; } catch {}

  list.innerHTML = OAUTH_PROVIDERS.map(p => {
    const connected = !!status[p.id];
    const badge = connected
      ? `<span style="font-size:11px;padding:2px 8px;border-radius:999px;font-weight:600;background:rgba(52,211,153,0.15);color:var(--green);border:1px solid rgba(52,211,153,0.3);">connected ✓</span>`
      : `<span style="font-size:11px;padding:2px 8px;border-radius:999px;font-weight:600;background:rgba(107,114,128,0.12);color:var(--text-2);border:1px solid var(--border);">not logged in</span>`;
    const currentModel = cfg[p.configKey] || p.models[1]?.value || p.models[0].value;
    const modelOptions = p.models.map(m =>
      `<option value="${m.value}" ${m.value === currentModel ? 'selected' : ''}>${m.label}</option>`
    ).join('');
    return `<div class="card" style="margin-bottom:8px;">
      <div style="display:flex;align-items:center;gap:10px;cursor:pointer;" data-toggle-child=".oa-body-${p.id}">
        <span style="font-size:18px;width:24px;text-align:center;">${p.icon}</span>
        <div style="flex:1;">
          <div style="font-weight:600;font-size:13px;">${p.label}</div>
          <div style="font-size:11px;color:var(--text-2);">${p.hint}</div>
        </div>
        ${badge}
        <span style="color:var(--text-2);font-size:12px;">▾</span>
      </div>
      <div class="oa-body-${p.id}" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">
        ${!connected ? `<div style="font-size:12px;color:var(--yellow);margin-bottom:10px;">Run <code style="background:rgba(255,255,255,0.06);padding:1px 6px;border-radius:4px;">${p.loginCmd}</code> in terminal, then refresh this page.</div>` : ''}
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <label style="font-size:12px;color:var(--text-2);white-space:nowrap;">Active model:</label>
          <select id="oa_model_${p.id}" style="flex:1;min-width:200px;">${modelOptions}</select>
          <button data-action="saveOauthModel" data-arg="${p.id}" class="btn-purple">Save</button>
        </div>
        <div id="oa_status_${p.id}" style="font-size:12px;margin-top:8px;color:var(--text-2);"></div>
      </div>
    </div>`;
  }).join('');
}

export async function saveOauthModel(providerId) {
  const p = OAUTH_PROVIDERS.find(x => x.id === providerId);
  if (!p) return;
  const sel = document.getElementById(`oa_model_${providerId}`);
  const model = sel?.value;
  if (!model) return;
  const statusEl = document.getElementById(`oa_status_${providerId}`);
  try {
    await postJSON('/api/oauth/model', { [p.configKey]: model });
    if (statusEl) { statusEl.style.color = 'var(--green)'; statusEl.textContent = `✓ Saved — agents will use ${model}`; }
  } catch(e) {
    if (statusEl) { statusEl.style.color = 'var(--red)'; statusEl.textContent = '✗ ' + e.message; }
  }
}

// ── Tab entry point ────────────────────────────────────────────────────────────

export function showModels() {
  _hideAllViews();
  document.getElementById('modelsView').classList.add('active');
  _setNavActive('navModels');
  loadRTToken_local();
  loadBuiltinProviders();
  loadOAuthProviders();
  loadSearchTools();
}

export function showProviders() { showModels(); }

// ── RT Token (mirrored here for models view; source of truth in settings-tab) ─

async function loadRTToken_local() {
  try {
    const d = await getJSON('/api/settings/rt-token');
    const badge = document.getElementById('rtTokenBadge');
    const inp   = document.getElementById('rtTokenInput');
    if (!badge) return;
    if (d.token) {
      badge.textContent = 'set ✓';
      badge.style.background = 'rgba(52,211,153,0.15)';
      badge.style.color = 'var(--green)';
      badge.style.borderColor = 'rgba(52,211,153,0.3)';
      if (inp) inp.placeholder = '••••••••••••••••••••••• (saved)';
    } else {
      badge.textContent = 'not set';
      badge.style.background = 'rgba(251,191,36,0.15)';
      badge.style.color = 'var(--yellow)';
      badge.style.borderColor = 'rgba(251,191,36,0.3)';
    }
  } catch {}
}

// ── Search tools ───────────────────────────────────────────────────────────────

export async function loadSearchTools() {
  const list = document.getElementById('searchToolsList');
  if (!list) return;
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

export async function saveSearchTool(toolId) {
  const inp = document.getElementById('st_' + toolId);
  const key = inp?.value?.trim();
  if (!key) { showNotification('Paste an API key first', 'error'); return; }
  try {
    await postJSON('/api/search-tools/save', { toolId, key });
    showNotification('Key saved', 'success');
    loadSearchTools();
  } catch(e) { showNotification('Save failed: ' + e.message, 'error'); }
}

export async function testSearchTool(toolId) {
  const statusEl = document.getElementById('st_status_' + toolId);
  statusEl.textContent = 'Testing…';
  try {
    const r = await postJSON('/api/search-tools/test', { toolId });
    statusEl.style.color = r.ok ? 'var(--green)' : 'var(--red)';
    statusEl.textContent = r.ok ? '✓ ' + (r.message || 'Connected') : '✗ ' + (r.error || 'Failed');
  } catch(e) { statusEl.style.color='var(--red)'; statusEl.textContent = '✗ ' + e.message; }
}

// ── Built-in providers ─────────────────────────────────────────────────────────

export async function loadBuiltinProviders() {
  const list = document.getElementById('builtinProvidersList');
  if (!list) return;
  let saved = {};
  try { saved = (await getJSON('/api/providers/builtin')).keys || {}; } catch {}
  const builtinIds = new Set(BUILTIN_PROVIDERS.map(p => p.id));

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

  try {
    const data = await getJSON('/api/providers');
    const customs = (data.providers || []).filter(p => !builtinIds.has(p.id) && p.id !== 'greptile');
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

export async function saveBuiltinKey(providerId) {
  const inp = document.getElementById('bp_' + providerId);
  const key = inp?.value?.trim();
  if (!key && providerId !== 'openai-local') { showNotification('Paste an API key first', 'error'); return; }
  await postJSON('/api/providers/builtin/save', { providerId, apiKey: key || '' });
  if (inp) inp.value = '';
  showNotification('Key saved — fetching models…');
  await loadBuiltinProviders();
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
      _loadAgents();
    } else {
      showNotification('Key saved — could not fetch models: ' + (r.error || 'unknown'), 'warning');
    }
  } catch(e) {
    showNotification('Key saved — model fetch failed: ' + e.message, 'warning');
  }
}

export async function testBuiltinProvider(providerId) {
  const statusEl = document.getElementById('bp_status_' + providerId);
  statusEl.textContent = 'Testing…';
  try {
    const r = await postJSON('/api/providers/builtin/test', { providerId });
    statusEl.style.color = r.ok ? 'var(--green)' : 'var(--red)';
    statusEl.textContent = r.ok ? '✓ Connected — ' + (r.model || 'OK') : '✗ ' + (r.error || 'Failed');
  } catch(e) { statusEl.style.color='var(--red)'; statusEl.textContent = '✗ ' + e.message; }
}

export async function fetchBuiltinModels(providerId, btn) {
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
      _loadAgents();
    } else {
      statusEl.style.color = 'var(--red)';
      statusEl.textContent = '✗ ' + (r.error || 'Failed');
    }
  } catch(e) { statusEl.style.color='var(--red)'; statusEl.textContent = '✗ ' + e.message; }
  finally { btn.textContent = orig; btn.disabled = false; }
}

// ── Legacy custom provider list (secondary view) ───────────────────────────────

export async function loadProviders() {
  const list = document.getElementById('providersList');
  if (!list) return;
  showLoading(list, 'Loading providers...');
  try {
    const data = await getJSON('/api/providers');
    const providers = data.providers || [];
    if (!providers.length) { showEmpty(list, 'No providers found. Check ~/.crewswarm/crewswarm.json'); return; }
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
          ${p.models.length === 0 ? `<div class="meta" style="margin-top:8px; color:var(--amber);" id="mnone_${p.id}">No models yet — click ↻ Fetch models</div>` : ''}
        </div>
      `;
      list.appendChild(card);
    });
  } catch(e) { showError(list, 'Error: ' + e.message); }
}

export function toggleKeyVis(inputId, btn) {
  const inp = document.getElementById(inputId);
  inp.type = inp.type === 'password' ? 'text' : 'password';
  btn.textContent = inp.type === 'password' ? '👁' : '🙈';
}

export async function saveKey(providerId) {
  const inp = document.getElementById('key_' + providerId);
  const key = inp.value.trim();
  if (!key) { showNotification('Key is empty', true); return; }
  try {
    await postJSON('/api/providers/save', { providerId, apiKey: key });
    showNotification('Saved key for ' + providerId);
    loadProviders();
    _loadAgents();
  } catch(e) { showNotification('Failed: ' + e.message, true); }
}

export async function testKey(providerId) {
  const statusEl = document.getElementById('test_' + providerId);
  statusEl.textContent = 'testing…';
  statusEl.className = 'meta';
  try {
    const r = await postJSON('/api/providers/test', { providerId });
    statusEl.textContent = r.ok ? '✓ ' + (r.model || 'ok') : '✗ ' + r.error;
    statusEl.className = r.ok ? 'test-ok' : 'test-err';
  } catch(e) { statusEl.textContent = '✗ ' + e.message; statusEl.className = 'test-err'; }
}

export async function fetchModels(providerId, btn) {
  const statusEl = document.getElementById('test_' + providerId);
  const origText = btn.textContent;
  btn.textContent = 'Fetching…';
  btn.disabled = true;
  if (statusEl) statusEl.textContent = '';
  try {
    const r = await postJSON('/api/providers/fetch-models', { providerId });
    if (r.ok) {
      const tags  = document.getElementById('mtags_'  + providerId);
      const count = document.getElementById('mcount_' + providerId);
      const none  = document.getElementById('mnone_'  + providerId);
      const wrap  = document.getElementById('mwrap_'  + providerId);
      if (tags)  tags.innerHTML = r.models.map(m => '<span class="model-tag">' + m + '</span>').join('');
      if (count) count.textContent = r.models.length;
      if (none)  none.style.display = 'none';
      if (wrap)  wrap.style.display = 'block';
      if (statusEl) { statusEl.textContent = '✓ ' + r.models.length + ' models'; statusEl.className = 'test-ok'; }
      _loadAgents();
    } else {
      if (statusEl) { statusEl.textContent = '✗ ' + r.error; statusEl.className = 'test-err'; }
    }
  } catch(e) {
    if (statusEl) { statusEl.textContent = '✗ ' + e.message; statusEl.className = 'test-err'; }
  }
  finally { btn.textContent = origText; btn.disabled = false; }
}

// ── Add provider form wiring (called once on DOMContentLoaded) ─────────────────

export function initAddProviderForm() {
  const addBtn = document.getElementById('addProviderBtn');
  if (addBtn) {
    addBtn.onclick = () => {
      const form = document.getElementById('addProviderForm');
      form.style.display = 'block';
      setTimeout(() => form.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
      const firstInput = form.querySelector('input');
      if (firstInput) setTimeout(() => firstInput.focus(), 150);
    };
  }
  const cancelBtn = document.getElementById('apCancelBtn');
  if (cancelBtn) {
    cancelBtn.onclick = () => {
      document.getElementById('addProviderForm').style.display = 'none';
    };
  }
  const saveBtn = document.getElementById('apSaveBtn');
  if (saveBtn) {
    saveBtn.onclick = async () => {
      const id       = document.getElementById('apId').value.trim();
      const baseUrl  = document.getElementById('apBaseUrl').value.trim();
      const apiKey   = document.getElementById('apKey').value.trim();
      const api      = document.getElementById('apApi').value;
      if (!id || !baseUrl) { showNotification('ID and Base URL are required', true); return; }
      try {
        await postJSON('/api/providers/add', { id, baseUrl, apiKey, api });
        showNotification('Provider added: ' + id);
        document.getElementById('addProviderForm').style.display = 'none';
        loadBuiltinProviders();
      } catch(e) { showNotification('Failed: ' + e.message, true); }
    };
  }
  const refreshBtn = document.getElementById('refreshProvidersBtn');
  if (refreshBtn) refreshBtn.onclick = loadBuiltinProviders;
}
