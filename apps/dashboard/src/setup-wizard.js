/**
 * Setup Wizard — first-run onboarding overlay for CrewSwarm dashboard.
 * Shows when no API keys are configured (firstRun === true).
 * Vanilla JS, no frameworks. Matches the existing dark dashboard theme.
 */

import { getJSON, postJSON } from "./core/api.js";

// ── Provider definitions for the wizard ─────────────────────────────────────
const WIZARD_PROVIDERS = [
  {
    id: "anthropic",
    label: "Anthropic",
    icon: "\u{1F7E3}",
    placeholder: "sk-ant-...",
    url: "https://console.anthropic.com/",
  },
  {
    id: "openai",
    label: "OpenAI",
    icon: "\u{1F7E2}",
    placeholder: "sk-...",
    url: "https://platform.openai.com/api-keys",
  },
  {
    id: "groq",
    label: "Groq",
    icon: "\u26A1",
    placeholder: "gsk_...",
    url: "https://console.groq.com/keys",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    icon: "\u{1F500}",
    placeholder: "sk-or-...",
    url: "https://openrouter.ai/keys",
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    icon: "\u{1D54F}",
    placeholder: "xai-...",
    url: "https://console.x.ai/",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    icon: "\u{1F30A}",
    placeholder: "sk-...",
    url: "https://platform.deepseek.com/",
  },
];

const PRESETS = [
  {
    id: "fast",
    label: "Fast",
    description: "Cheapest. Uses fast models for everything. Great for simple tasks.",
    icon: "\u26A1",
  },
  {
    id: "balanced",
    label: "Balanced",
    description: "Best value. Smart planning + fast execution.",
    icon: "\u2696\uFE0F",
    default: true,
  },
  {
    id: "quality",
    label: "Quality",
    description: "Maximum quality. Full planning, QA gates, extra validation.",
    icon: "\u{1F3AF}",
  },
];

let _currentStep = 1;
let _overlayEl = null;
let _selectedPreset = "balanced";
let _providerKeys = {};

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
  _selectedPreset = "balanced";
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

  // Animate card entrance
  requestAnimationFrame(() => {
    wrapper.classList.add("visible");
  });
}

function _buildStepIndicator() {
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
    label.textContent = ["Welcome", "Providers", "Preset"][i - 1];

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
    case 1:
      return _buildWelcomeStep();
    case 2:
      return _buildProvidersStep();
    case 3:
      return _buildPresetStep();
    default:
      return _buildWelcomeStep();
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
        Let's get you set up in 2 minutes
      </p>
    </div>
    <div class="setup-wizard-checklist">
      <div class="setup-wizard-check-item">
        <span class="setup-wizard-check-icon done">&check;</span>
        <span>Dashboard installed</span>
      </div>
      <div class="setup-wizard-check-item">
        <span class="setup-wizard-check-icon pending">&bull;</span>
        <span>Add an API provider key</span>
      </div>
      <div class="setup-wizard-check-item">
        <span class="setup-wizard-check-icon pending">&bull;</span>
        <span>Choose a quality preset</span>
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

// ── Step 2: Providers ───────────────────────────────────────────────────────

function _buildProvidersStep() {
  const frag = document.createElement("div");
  frag.className = "setup-wizard-content";

  const header = document.createElement("div");
  header.className = "setup-wizard-section-header";
  header.innerHTML = `
    <h2 class="setup-wizard-section-title">Add a Provider</h2>
    <p class="setup-wizard-section-desc">
      Paste at least one API key. You can add more later in Settings.
    </p>
  `;
  frag.appendChild(header);

  const list = document.createElement("div");
  list.className = "setup-wizard-provider-list";

  for (const prov of WIZARD_PROVIDERS) {
    const row = document.createElement("div");
    row.className = "setup-wizard-provider-row";

    const labelWrap = document.createElement("div");
    labelWrap.className = "setup-wizard-provider-label";

    const icon = document.createElement("span");
    icon.className = "setup-wizard-provider-icon";
    icon.textContent = prov.icon;

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

    labelWrap.appendChild(icon);
    labelWrap.appendChild(name);
    labelWrap.appendChild(link);

    const inputWrap = document.createElement("div");
    inputWrap.className = "setup-wizard-provider-input-wrap";

    const input = document.createElement("input");
    input.type = "password";
    input.className = "setup-wizard-provider-input";
    input.placeholder = prov.placeholder;
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
    toggleVis.textContent = "\u{1F441}";
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
  saveBtn.textContent = "Save & Continue";
  saveBtn.disabled = Object.keys(_providerKeys).length === 0;
  saveBtn.addEventListener("click", _saveProviders);

  actions.appendChild(backBtn);
  actions.appendChild(saveBtn);
  frag.appendChild(actions);

  return frag;
}

function _updateSaveBtn() {
  const btn = document.getElementById("wizardSaveBtn");
  if (btn) {
    btn.disabled = Object.keys(_providerKeys).length === 0;
  }
}

async function _saveProviders() {
  const btn = document.getElementById("wizardSaveBtn");
  const errorEl = document.getElementById("wizardProviderError");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Saving...";
  }
  if (errorEl) errorEl.classList.add("hidden");

  try {
    for (const [providerId, apiKey] of Object.entries(_providerKeys)) {
      if (apiKey && apiKey.length > 0) {
        await postJSON("/api/providers/builtin/save", { providerId, apiKey });
      }
    }
    _currentStep = 3;
    _renderStep();
  } catch (e) {
    if (errorEl) {
      errorEl.textContent = "Failed to save: " + (e.message || "Unknown error");
      errorEl.classList.remove("hidden");
    }
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Save & Continue";
    }
  }
}

// ── Step 3: Preset ──────────────────────────────────────────────────────────

function _buildPresetStep() {
  const frag = document.createElement("div");
  frag.className = "setup-wizard-content";

  const header = document.createElement("div");
  header.className = "setup-wizard-section-header";
  header.innerHTML = `
    <h2 class="setup-wizard-section-title">Choose a Preset</h2>
    <p class="setup-wizard-section-desc">
      This controls how agents balance speed, cost, and quality. You can change it anytime.
    </p>
  `;
  frag.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "setup-wizard-preset-grid";

  for (const preset of PRESETS) {
    const card = document.createElement("button");
    card.className = "setup-wizard-preset-card";
    card.type = "button";
    card.dataset.preset = preset.id;
    card.setAttribute("aria-label", `${preset.label}: ${preset.description}`);
    if (preset.id === _selectedPreset) card.classList.add("selected");

    card.innerHTML = `
      <div class="setup-wizard-preset-icon">${preset.icon}</div>
      <div class="setup-wizard-preset-label">${preset.label}</div>
      <div class="setup-wizard-preset-desc">${preset.description}</div>
    `;

    card.addEventListener("click", () => {
      _selectedPreset = preset.id;
      grid.querySelectorAll(".setup-wizard-preset-card").forEach((c) =>
        c.classList.remove("selected"),
      );
      card.classList.add("selected");
    });

    grid.appendChild(card);
  }

  frag.appendChild(grid);

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
  startBtn.textContent = "Start CrewSwarm";
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
    btn.textContent = "Starting...";
  }

  try {
    await postJSON("/api/settings/preset", { preset: _selectedPreset });
  } catch {
    // Non-critical — preset save can fail silently
  }

  _dismiss();
  // Reload to get fresh state with configured keys
  window.location.reload();
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
  // Fallback removal if transition doesn't fire
  setTimeout(() => {
    if (_overlayEl) {
      _overlayEl.remove();
      _overlayEl = null;
    }
  }, 400);
}
