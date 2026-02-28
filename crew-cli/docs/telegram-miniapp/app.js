const tg = window.Telegram?.WebApp;

const state = {
  mode: 'chat',
  engine: 'cursor',
  agent: 'crew-main',
  projectId: '',
  prompt: ''
};

const templates = {
  hi: 'hi',
  status: 'show status for active services and agents',
  review: 'run strict review on current diff and summarize high-severity findings',
  fix: 'investigate latest failing tests and propose a minimal fix',
  plan: 'create a 5-step implementation plan with acceptance criteria'
};

const el = {
  tgState: document.getElementById('tgState'),
  modeState: document.getElementById('modeState'),
  engineState: document.getElementById('engineState'),
  modeSelect: document.getElementById('modeSelect'),
  engineSelect: document.getElementById('engineSelect'),
  agentSelect: document.getElementById('agentSelect'),
  projectSelect: document.getElementById('projectSelect'),
  refreshProjects: document.getElementById('refreshProjects'),
  prompt: document.getElementById('prompt'),
  quickActions: document.getElementById('quickActions'),
  sendBtn: document.getElementById('sendBtn'),
  openModeBtn: document.getElementById('openModeBtn'),
  payloadPreview: document.getElementById('payloadPreview')
};

function normalizeProjects(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map(item => ({
      id: String(item.id || item.projectId || item.name || '').trim(),
      name: String(item.name || item.id || item.projectId || '').trim()
    }))
    .filter(p => p.id && p.name);
}

function loadProjects() {
  const raw = window.CREW_MINIAPP_PROJECTS;
  const projects = normalizeProjects(raw);
  el.projectSelect.innerHTML = '<option value="">General mode (no project)</option>';
  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    el.projectSelect.appendChild(opt);
  }
}

function getPayload(action = 'message') {
  return {
    type: 'crew_miniapp',
    action,
    mode: state.mode,
    engine: state.engine,
    agent: state.agent,
    projectId: state.projectId || null,
    prompt: state.prompt,
    ts: new Date().toISOString()
  };
}

function updatePreview(action = 'message') {
  el.payloadPreview.textContent = JSON.stringify(getPayload(action), null, 2);
}

function setMode(mode) {
  state.mode = mode;
  [...el.modeSelect.querySelectorAll('[data-mode]')].forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.mode === mode);
  });
  el.modeState.textContent = `Mode: ${mode}`;
  updatePreview();
}

function setEngine(engine) {
  state.engine = engine;
  [...el.engineSelect.querySelectorAll('[data-engine]')].forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.engine === engine);
  });
  el.engineState.textContent = `Engine: ${engine}`;
  updatePreview();
}

function sendPayload(action = 'message') {
  const payload = getPayload(action);
  if (tg && typeof tg.sendData === 'function') {
    tg.sendData(JSON.stringify(payload));
    tg.HapticFeedback?.impactOccurred?.('soft');
  } else {
    console.log('[miniapp payload]', payload);
    alert('Mini App payload logged to console (Telegram context not detected).');
  }
}

function bindEvents() {
  el.modeSelect.addEventListener('click', event => {
    const btn = event.target.closest('[data-mode]');
    if (!btn) return;
    setMode(btn.dataset.mode);
  });

  el.engineSelect.addEventListener('click', event => {
    const btn = event.target.closest('[data-engine]');
    if (!btn) return;
    setEngine(btn.dataset.engine);
    if (state.mode === 'chat') setMode('direct');
  });

  el.agentSelect.addEventListener('change', () => {
    state.agent = el.agentSelect.value;
    updatePreview();
  });

  el.projectSelect.addEventListener('change', () => {
    state.projectId = el.projectSelect.value;
    updatePreview();
  });

  el.prompt.addEventListener('input', () => {
    state.prompt = el.prompt.value.trim();
    updatePreview();
  });

  el.quickActions.addEventListener('click', event => {
    const btn = event.target.closest('[data-template]');
    if (!btn) return;
    const key = btn.dataset.template;
    el.prompt.value = templates[key] || '';
    state.prompt = el.prompt.value;
    updatePreview();
  });

  el.sendBtn.addEventListener('click', () => {
    state.prompt = el.prompt.value.trim();
    if (!state.prompt) {
      tg?.HapticFeedback?.notificationOccurred?.('error');
      alert('Enter a message first.');
      return;
    }
    sendPayload('message');
  });

  el.openModeBtn.addEventListener('click', () => {
    sendPayload('mode_update');
  });

  el.refreshProjects.addEventListener('click', () => {
    loadProjects();
    updatePreview();
  });
}

function initTelegram() {
  if (!tg) {
    el.tgState.textContent = 'Telegram: Web fallback';
    return;
  }

  tg.ready();
  tg.expand();

  const user = tg.initDataUnsafe?.user;
  const userLabel = user?.username ? `@${user.username}` : (user?.first_name || 'connected');
  el.tgState.textContent = `Telegram: ${userLabel}`;

  tg.MainButton.setText('Send to Crew');
  tg.MainButton.onClick(() => {
    state.prompt = el.prompt.value.trim();
    if (!state.prompt) return;
    sendPayload('message');
  });

  el.prompt.addEventListener('input', () => {
    const hasPrompt = Boolean(el.prompt.value.trim());
    if (hasPrompt) tg.MainButton.show();
    else tg.MainButton.hide();
  });
}

function init() {
  loadProjects();
  bindEvents();
  initTelegram();
  setMode(state.mode);
  setEngine(state.engine);
  updatePreview();
}

init();
