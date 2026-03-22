/**
 * Setup Wizard — first-run onboarding overlay for CrewSwarm dashboard.
 * Shows when no API keys are configured (firstRun === true).
 * Step 1: Welcome  →  Step 2: API Keys  →  Step 3: CLI Engines
 * Vanilla JS, no frameworks. Matches the existing dark dashboard theme.
 */

import { getJSON, postJSON } from "./core/api.js";

// ── All supported providers (synced with models-tab.js BUILTIN_PROVIDERS) ────
const ALL_PROVIDERS = [
  { id: "anthropic",    label: "Anthropic",        icon: "\uD83D\uDFE3", placeholder: "sk-ant-...",  url: "https://console.anthropic.com/" },
  { id: "openai",       label: "OpenAI",            icon: "\uD83D\uDFE2", placeholder: "sk-...",      url: "https://platform.openai.com/api-keys" },
  { id: "google",       label: "Google (Gemini)",   icon: "\uD83D\uDD35", placeholder: "AIza...",     url: "https://aistudio.google.com/apikey" },
  { id: "groq",         label: "Groq",              icon: "\u26A1",       placeholder: "gsk_...",     url: "https://console.groq.com/keys" },
  { id: "fireworks",    label: "Fireworks AI",      icon: "\uD83C\uDF86", placeholder: "fw_...",      url: "https://fireworks.ai/" },
  { id: "openrouter",   label: "OpenRouter",        icon: "\uD83D\uDD00", placeholder: "sk-or-...",   url: "https://openrouter.ai/keys" },
  { id: "xai",          label: "xAI (Grok)",        icon: "\uD835\uDD4F", placeholder: "xai-...",     url: "https://console.x.ai/" },
  { id: "deepseek",     label: "DeepSeek",          icon: "\uD83C\uDF0A", placeholder: "sk-...",      url: "https://platform.deepseek.com/" },
  { id: "mistral",      label: "Mistral",           icon: "\uD83C\uDF00", placeholder: "...",         url: "https://console.mistral.ai/api-keys" },
  { id: "cerebras",     label: "Cerebras",          icon: "\uD83E\uDDE0", placeholder: "csk-...",     url: "https://cloud.cerebras.ai/" },
  { id: "nvidia",       label: "NVIDIA NIM",        icon: "\uD83C\uDFAE", placeholder: "nvapi-...",   url: "https://build.nvidia.com/" },
  { id: "perplexity",   label: "Perplexity",        icon: "\uD83D\uDD0D", placeholder: "pplx-...",    url: "https://www.perplexity.ai/settings/api" },
  { id: "ollama",       label: "Ollama (local)",    icon: "\uD83C\uDFE0", placeholder: "no key needed", url: "https://ollama.com/download" },
];

// ── CLI engines we can detect ────────────────────────────────────────────────
const CLI_ENGINES = [
  { id: "claude-code", cmd: "claude",   label: "Claude Code",  desc: "Anthropic's CLI agent. Best for complex reasoning and multi-file refactors.", installUrl: "https://docs.anthropic.com/en/docs/claude-code/overview", authCmd: "claude auth",  keyProvider: "anthropic" },
  { id: "codex",       cmd: "codex",    label: "Codex CLI",    desc: "OpenAI's CLI agent. Sandboxed execution with full file write access.",        installUrl: "https://github.com/openai/codex",                        authCmd: "codex auth",   keyProvider: "openai" },
  { id: "crew-cli",    cmd: "crew",     label: "crew-cli",     desc: "CrewSwarm's own 3-tier pipeline. Supports Anthropic, OpenAI, Gemini, Groq, DeepSeek, and more.", installUrl: null,                                                      authCmd: null,           keyProvider: null },
  { id: "opencode",    cmd: "opencode", label: "OpenCode",     desc: "Multi-provider CLI agent. Supports OpenAI, Anthropic, Google, and more.",     installUrl: "https://github.com/opencode-ai/opencode",                authCmd: null,           keyProvider: null },
  { id: "gemini-cli",  cmd: "gemini",   label: "Gemini CLI",   desc: "Google's CLI agent. Fast inference with Gemini models.",                      installUrl: "https://github.com/google-gemini/gemini-cli",            authCmd: "gemini auth",  keyProvider: "google" },
  { id: "cursor",      cmd: "cursor",   label: "Cursor CLI",   desc: "Cursor's agent mode via CLI. Requires Cursor IDE installed.",                 installUrl: "https://www.cursor.com/",                                authCmd: null,           keyProvider: null },
];

let _currentStep = 1;
let _overlayEl = null;
let _providerKeys = {};       // only keys the user actually typed
let _configuredProviders = []; // already-configured provider IDs from backend
let _detectedEngines = {};     // { engineId: true/false }

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Check first-run status and show wizard if needed.
 * Returns true if wizard was shown, false if skipped.
 */
export async function checkFirstRun() {
  try {
    const data = await getJSON("/api/first-run-status");
    const forceWizard = new URLSearchParams(window.location.search).has("wizard");
    if (!data.firstRun && !forceWizard) return false;
    _configuredProviders = data.configuredProviders || [];
    _showWizard();
    return true;
  } catch (e) {
    console.warn("[setup-wizard] Could not check first-run status:", e);
    return false;
  }
}

// ── Wizard rendering ────────────────────────────────────────────────────────

function _showWizard() {
  _currentStep = 1;
  _providerKeys = {};

  _overlayEl = document.createElement("div");
  _overlayEl.id = "setupWizardOverlay";
  _overlayEl.className = "setup-wizard-overlay";
  _overlayEl.setAttribute("role", "dialog");
  _overlayEl.setAttribute("aria-modal", "true");
  _overlayEl.setAttribute("aria-label", "CrewSwarm setup wizard");

  _renderStep();
  document.body.appendChild(_overlayEl);

  // Force reflow then animate in
  _overlayEl.offsetHeight;
  _overlayEl.classList.add("visible");
}

function _renderStep() {
  if (!_overlayEl) return;

  const card = _buildStepContent();
  _overlayEl.innerHTML = "";

  const wrapper = document.createElement("div");
  wrapper.className = "setup-wizard-card";
  wrapper.appendChild(_buildStepIndicator());
  wrapper.appendChild(card);
  _overlayEl.appendChild(wrapper);

  requestAnimationFrame(() => {
    wrapper.classList.add("visible");
  });
}

function _buildStepIndicator() {
  const labels = ["Welcome", "API Keys", "Engines"];
  const indicator = document.createElement("div");
  indicator.className = "setup-wizard-steps";
  indicator.setAttribute("aria-label", `Step ${_currentStep} of 3`);

  for (let i = 1; i <= 3; i++) {
    const dot = document.createElement("button");
    dot.className = "setup-wizard-step-dot";
    dot.setAttribute("aria-label", `Step ${i}`);
    dot.tabIndex = -1;
    if (i === _currentStep) dot.classList.add("active");
    if (i < _currentStep) dot.classList.add("completed");

    const label = document.createElement("span");
    label.className = "setup-wizard-step-label";
    label.textContent = labels[i - 1];

    const step = document.createElement("div");
    step.className = "setup-wizard-step";
    step.appendChild(dot);
    step.appendChild(label);
    indicator.appendChild(step);

    if (i < 3) {
      const line = document.createElement("div");
      line.className = "setup-wizard-step-line";
      if (i < _currentStep) line.classList.add("completed");
      indicator.appendChild(line);
    }
  }

  return indicator;
}

function _buildStepContent() {
  switch (_currentStep) {
    case 1: return _buildWelcomeStep();
    case 2: return _buildProvidersStep();
    case 3: return _buildEnginesStep();
    default: return _buildWelcomeStep();
  }
}

// ── Step 1: Welcome ─────────────────────────────────────────────────────────

function _buildWelcomeStep() {
  const frag = document.createElement("div");
  frag.className = "setup-wizard-content";

  frag.innerHTML = `
    <div class="setup-wizard-hero">
      <div class="setup-wizard-logo-ring">
        <img src="/favicon.png" alt="CrewSwarm" class="setup-wizard-logo" />
      </div>
      <h1 class="setup-wizard-title">Welcome to CrewSwarm</h1>
      <p class="setup-wizard-subtitle">
        Multi-agent orchestration for AI coding tools.<br>
        Let's get you set up in 2 minutes.
      </p>
    </div>
    <div class="setup-wizard-checklist">
      <div class="setup-wizard-check-item">
        <span class="setup-wizard-check-icon done">&check;</span>
        <span>Dashboard installed</span>
      </div>
      <div class="setup-wizard-check-item">
        <span class="setup-wizard-check-icon pending">&bull;</span>
        <span>Add API provider keys</span>
      </div>
      <div class="setup-wizard-check-item">
        <span class="setup-wizard-check-icon pending">&bull;</span>
        <span>Detect & configure CLI engines</span>
      </div>
    </div>
  `;

  const actions = document.createElement("div");
  actions.className = "setup-wizard-actions";

  const nextBtn = document.createElement("button");
  nextBtn.className = "setup-wizard-btn-primary";
  nextBtn.textContent = "Get Started";
  nextBtn.addEventListener("click", () => {
    _currentStep = 2;
    _renderStep();
  });

  const skipBtn = document.createElement("button");
  skipBtn.className = "setup-wizard-btn-ghost";
  skipBtn.textContent = "Skip setup";
  skipBtn.addEventListener("click", _dismiss);

  actions.appendChild(nextBtn);
  actions.appendChild(skipBtn);
  frag.appendChild(actions);

  return frag;
}

// ── Step 2: API Keys ────────────────────────────────────────────────────────

function _buildProvidersStep() {
  const frag = document.createElement("div");
  frag.className = "setup-wizard-content";

  const header = document.createElement("div");
  header.className = "setup-wizard-section-header";
  header.innerHTML = `
    <h2 class="setup-wizard-section-title">API Keys</h2>
    <p class="setup-wizard-section-desc">
      Add keys for the providers you want to use. Already-configured keys are shown with a checkmark.
      Only new keys you enter will be saved &mdash; existing keys won't be touched.
    </p>
  `;
  frag.appendChild(header);

  const list = document.createElement("div");
  list.className = "setup-wizard-provider-list";

  for (const prov of ALL_PROVIDERS) {
    const alreadyConfigured = _configuredProviders.includes(prov.id);

    const row = document.createElement("div");
    row.className = "setup-wizard-provider-row";
    if (alreadyConfigured) row.classList.add("already-configured");

    const labelWrap = document.createElement("div");
    labelWrap.className = "setup-wizard-provider-label";

    const provIcon = document.createElement("span");
    provIcon.className = "setup-wizard-provider-icon";
    provIcon.textContent = prov.icon || "";

    const statusIcon = document.createElement("span");
    statusIcon.className = "setup-wizard-provider-status";
    statusIcon.textContent = alreadyConfigured ? "\u2713" : "";
    statusIcon.title = alreadyConfigured ? "Already configured" : "Not configured";

    const name = document.createElement("span");
    name.className = "setup-wizard-provider-name";
    name.textContent = prov.label;

    const link = document.createElement("a");
    link.href = prov.url;
    link.target = "_blank";
    link.rel = "noopener";
    link.className = "setup-wizard-provider-link";
    link.textContent = "Get key";
    link.setAttribute("aria-label", `Get API key for ${prov.label}`);

    labelWrap.appendChild(provIcon);
    labelWrap.appendChild(name);
    labelWrap.appendChild(statusIcon);
    labelWrap.appendChild(link);

    const inputWrap = document.createElement("div");
    inputWrap.className = "setup-wizard-provider-input-wrap";

    const input = document.createElement("input");
    input.type = "password";
    input.className = "setup-wizard-provider-input";
    input.placeholder = alreadyConfigured ? "configured \u2713" : prov.placeholder;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.dataset.providerId = prov.id;
    input.setAttribute("aria-label", `API key for ${prov.label}`);

    if (_providerKeys[prov.id]) {
      input.value = _providerKeys[prov.id];
    }

    input.addEventListener("input", () => {
      const val = input.value.trim();
      if (val) {
        _providerKeys[prov.id] = val;
        row.classList.add("has-key");
      } else {
        delete _providerKeys[prov.id];
        row.classList.remove("has-key");
      }
      _updateSaveBtn();
    });

    const toggleVis = document.createElement("button");
    toggleVis.type = "button";
    toggleVis.className = "setup-wizard-toggle-vis";
    toggleVis.textContent = "\uD83D\uDC41";
    toggleVis.setAttribute("aria-label", "Toggle key visibility");
    toggleVis.addEventListener("click", () => {
      input.type = input.type === "password" ? "text" : "password";
    });

    inputWrap.appendChild(input);
    inputWrap.appendChild(toggleVis);

    row.appendChild(labelWrap);
    row.appendChild(inputWrap);

    if (_providerKeys[prov.id]) {
      row.classList.add("has-key");
    }

    list.appendChild(row);
  }

  frag.appendChild(list);

  const errorEl = document.createElement("div");
  errorEl.className = "setup-wizard-error hidden";
  errorEl.id = "wizardProviderError";
  frag.appendChild(errorEl);

  const actions = document.createElement("div");
  actions.className = "setup-wizard-actions";

  const backBtn = document.createElement("button");
  backBtn.className = "setup-wizard-btn-ghost";
  backBtn.textContent = "Back";
  backBtn.addEventListener("click", () => {
    _currentStep = 1;
    _renderStep();
  });

  const saveBtn = document.createElement("button");
  saveBtn.className = "setup-wizard-btn-primary";
  saveBtn.id = "wizardSaveBtn";
  // Allow continuing even without new keys (they may all be pre-configured)
  const hasNewKeys = Object.keys(_providerKeys).length > 0;
  const hasExistingKeys = _configuredProviders.length > 0;
  saveBtn.textContent = hasNewKeys ? "Save & Continue" : "Continue";
  saveBtn.disabled = !hasNewKeys && !hasExistingKeys;
  saveBtn.addEventListener("click", _saveProviders);

  actions.appendChild(backBtn);
  actions.appendChild(saveBtn);
  frag.appendChild(actions);

  return frag;
}

function _updateSaveBtn() {
  const btn = document.getElementById("wizardSaveBtn");
  if (!btn) return;
  const hasNewKeys = Object.keys(_providerKeys).length > 0;
  const hasExistingKeys = _configuredProviders.length > 0;
  btn.textContent = hasNewKeys ? "Save & Continue" : "Continue";
  btn.disabled = !hasNewKeys && !hasExistingKeys;
}

async function _saveProviders() {
  const btn = document.getElementById("wizardSaveBtn");
  const errorEl = document.getElementById("wizardProviderError");

  const newKeys = Object.entries(_providerKeys).filter(([, v]) => v && v.length > 0);

  if (newKeys.length > 0) {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Saving...";
    }
    if (errorEl) errorEl.classList.add("hidden");

    try {
      for (const [providerId, apiKey] of newKeys) {
        await postJSON("/api/providers/builtin/save", { providerId, apiKey });
      }
    } catch (e) {
      if (errorEl) {
        errorEl.textContent = "Failed to save: " + (e.message || "Unknown error");
        errorEl.classList.remove("hidden");
      }
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Save & Continue";
      }
      return;
    }
  }

  // Detect engines before showing step 3
  await _detectEngines();
  _currentStep = 3;
  _renderStep();
}

// ── Step 3: CLI Engines ─────────────────────────────────────────────────────

async function _detectEngines() {
  try {
    const data = await getJSON("/api/first-run-engines");
    _detectedEngines = data.engines || {};
  } catch {
    // If endpoint doesn't exist yet, fall back to empty
    _detectedEngines = {};
  }
}

function _buildEnginesStep() {
  const frag = document.createElement("div");
  frag.className = "setup-wizard-content";

  const header = document.createElement("div");
  header.className = "setup-wizard-section-header";
  header.innerHTML = `
    <h2 class="setup-wizard-section-title">CLI Engines</h2>
    <p class="setup-wizard-section-desc">
      CrewSwarm dispatches tasks to these CLI coding agents.
      You need at least one installed. Use the API keys from Step 2 to authenticate.
    </p>
  `;
  frag.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "setup-wizard-engine-grid";

  const detectedCount = Object.values(_detectedEngines).filter(Boolean).length;

  for (const engine of CLI_ENGINES) {
    const detected = _detectedEngines[engine.id] === true;
    // crew-cli is always available (it's part of this repo)
    const available = engine.id === "crew-cli" || detected;

    const card = document.createElement("div");
    card.className = "setup-wizard-engine-card";
    if (available) card.classList.add("available");

    // Status badge
    const badge = document.createElement("div");
    badge.className = "setup-wizard-engine-badge";
    if (available) {
      badge.textContent = "\u2713 Installed";
      badge.classList.add("installed");
    } else {
      badge.textContent = "Not found";
      badge.classList.add("missing");
    }
    card.appendChild(badge);

    // Engine name + command
    const title = document.createElement("div");
    title.className = "setup-wizard-engine-title";
    title.textContent = engine.label;
    card.appendChild(title);

    const cmd = document.createElement("code");
    cmd.className = "setup-wizard-engine-cmd";
    cmd.textContent = engine.cmd;
    card.appendChild(cmd);

    // Description
    const desc = document.createElement("p");
    desc.className = "setup-wizard-engine-desc";
    desc.textContent = engine.desc;
    card.appendChild(desc);

    // Action area
    const actionArea = document.createElement("div");
    actionArea.className = "setup-wizard-engine-action";

    if (available && engine.authCmd) {
      const authLabel = document.createElement("span");
      authLabel.className = "setup-wizard-engine-auth-label";
      authLabel.textContent = "Auth:";
      const authCode = document.createElement("code");
      authCode.className = "setup-wizard-engine-auth-cmd";
      authCode.textContent = engine.authCmd;
      actionArea.appendChild(authLabel);
      actionArea.appendChild(authCode);
    } else if (available && engine.keyProvider) {
      const keyNote = document.createElement("span");
      keyNote.className = "setup-wizard-engine-key-note";
      const provLabel = ALL_PROVIDERS.find(p => p.id === engine.keyProvider)?.label || engine.keyProvider;
      const hasKey = _configuredProviders.includes(engine.keyProvider);
      keyNote.textContent = hasKey ? `Uses ${provLabel} key \u2713` : `Needs ${provLabel} key`;
      keyNote.classList.add(hasKey ? "key-ok" : "key-missing");
      actionArea.appendChild(keyNote);
    } else if (!available && engine.installUrl) {
      const installLink = document.createElement("a");
      installLink.href = engine.installUrl;
      installLink.target = "_blank";
      installLink.rel = "noopener";
      installLink.className = "setup-wizard-engine-install-btn";
      installLink.textContent = "Install \u2192";
      actionArea.appendChild(installLink);
    }

    card.appendChild(actionArea);
    grid.appendChild(card);
  }

  frag.appendChild(grid);

  if (detectedCount === 0 && Object.keys(_detectedEngines).length > 0) {
    const hint = document.createElement("p");
    hint.className = "setup-wizard-engine-hint";
    hint.innerHTML = "No external CLI engines detected. <strong>crew-cli</strong> is built in and always available.";
    frag.appendChild(hint);
  }

  const actions = document.createElement("div");
  actions.className = "setup-wizard-actions";

  const backBtn = document.createElement("button");
  backBtn.className = "setup-wizard-btn-ghost";
  backBtn.textContent = "Back";
  backBtn.addEventListener("click", () => {
    _currentStep = 2;
    _renderStep();
  });

  const startBtn = document.createElement("button");
  startBtn.className = "setup-wizard-btn-primary setup-wizard-btn-start";
  startBtn.textContent = "Launch Dashboard";
  startBtn.addEventListener("click", _finishSetup);

  actions.appendChild(backBtn);
  actions.appendChild(startBtn);
  frag.appendChild(actions);

  return frag;
}

// ── Finish / dismiss ────────────────────────────────────────────────────────

async function _finishSetup() {
  const btn = _overlayEl?.querySelector(".setup-wizard-btn-start");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Loading...";
  }

  _dismiss();
  window.location.href = window.location.pathname; // strip ?wizard param
}

function _dismiss() {
  if (!_overlayEl) return;
  _overlayEl.classList.remove("visible");
  _overlayEl.classList.add("dismissing");
  _overlayEl.addEventListener(
    "transitionend",
    () => {
      _overlayEl.remove();
      _overlayEl = null;
    },
    { once: true },
  );
  setTimeout(() => {
    if (_overlayEl) {
      _overlayEl.remove();
      _overlayEl = null;
    }
  }, 400);
}
