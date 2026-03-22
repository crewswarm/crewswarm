// Waves Tab - Visual wave pipeline editor

export function initWavesTab() {
  const wavesTab = document.getElementById('waves-tab');
  if (!wavesTab) return;

  let wavesConfig = null;

  async function loadWavesConfig() {
    try {
      const res = await fetch('/api/waves/config');
      wavesConfig = await res.json();
      renderWaves();
    } catch (e) {
      showError('Failed to load waves config: ' + e.message);
    }
  }

  function renderWaves() {
    if (!wavesConfig) return;

    const html = `
      <div class="waves-header" style="margin-bottom: 24px;">
        <h2 style="margin: 0 0 8px 0;">Planning Pipeline Waves</h2>
        <p style="margin: 0; color: var(--text-2); font-size: 14px;">
          Configure the 3-wave planning pipeline that runs when you say "build me X"
        </p>
      </div>

      <div class="wave-templates" style="margin-bottom: 32px;">
        <div style="font-weight: 600; margin-bottom: 12px;">Templates:</div>
        <div style="display: flex; gap: 12px; flex-wrap: wrap;">
          ${Object.entries(wavesConfig.templates || {}).map(([id, tmpl]) => `
            <button class="template-btn" data-template="${id}" style="padding: 12px 16px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer;">
              <div style="font-weight: 600; margin-bottom: 4px;">${tmpl.name}</div>
              <div style="font-size: 12px; color: var(--text-3);">${tmpl.description}</div>
            </button>
          `).join('')}
        </div>
      </div>

      <div class="waves-list">
        ${wavesConfig.waves.map(wave => renderWave(wave)).join('')}
      </div>

      <div style="margin-top: 24px; display: flex; gap: 12px;">
        <button id="saveWavesBtn" style="padding: 12px 24px; background: var(--accent); color: white; border: none; border-radius: 8px; font-weight: 600; cursor: pointer;">
          💾 Save Configuration
        </button>
        <button id="resetWavesBtn" style="padding: 12px 24px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; font-weight: 600; cursor: pointer;">
          ↺ Reset to Default
        </button>
      </div>
    `;

    wavesTab.innerHTML = html;
    attachWaveHandlers();
  }

  function renderWave(wave) {
    return `
      <div class="wave-card" data-wave-id="${wave.id}" style="margin-bottom: 24px; padding: 20px; background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px;">
        <div class="wave-header" style="margin-bottom: 16px;">
          <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 8px;">
            <div style="font-size: 20px; font-weight: 700;">Wave ${wave.id}</div>
            <div style="font-size: 14px; font-weight: 600; color: var(--text-1);">${wave.name}</div>
          </div>
          <div style="font-size: 13px; color: var(--text-3);">${wave.description}</div>
        </div>

        <div class="wave-agents" style="display: flex; flex-direction: column; gap: 12px;">
          ${wave.agents.map((agent, idx) => renderAgent(wave.id, agent, idx)).join('')}
        </div>

        <button class="add-agent-btn" data-wave-id="${wave.id}" style="margin-top: 12px; padding: 8px 16px; background: var(--surface-2); border: 1px dashed var(--border); border-radius: 6px; cursor: pointer; font-size: 13px; color: var(--text-2);">
          + Add Agent to Wave ${wave.id}
        </button>
      </div>
    `;
  }

  function renderAgent(waveId, agent, idx) {
    return `
      <div class="agent-slot" data-wave-id="${waveId}" data-agent-idx="${idx}" style="padding: 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 8px;">
        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 8px;">
          <select class="agent-select" data-wave-id="${waveId}" data-agent-idx="${idx}" style="padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-2); font-size: 13px; font-weight: 600;">
            <option value="${agent.id}" selected>${agent.id}</option>
            <option value="crew-researcher">crew-researcher</option>
            <option value="crew-copywriter">crew-copywriter</option>
            <option value="crew-pm">crew-pm</option>
            <option value="crew-architect">crew-architect</option>
            <option value="crew-coder-front">crew-coder-front</option>
            <option value="crew-frontend">crew-frontend</option>
            <option value="crew-qa">crew-qa</option>
            <option value="crew-security">crew-security</option>
            <option value="crew-main">crew-main</option>
          </select>
          <button class="remove-agent-btn" data-wave-id="${waveId}" data-agent-idx="${idx}" style="padding: 6px 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; font-size: 12px; color: var(--text-3);">
            ✕ Remove
          </button>
        </div>
        <textarea class="agent-task" data-wave-id="${waveId}" data-agent-idx="${idx}" rows="3" style="width: 100%; padding: 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-2); font-size: 12px; font-family: 'SF Mono', monospace; resize: vertical;">${agent.task}</textarea>
      </div>
    `;
  }

  function attachWaveHandlers() {
    // Agent select dropdown
    document.querySelectorAll('.agent-select').forEach(select => {
      select.addEventListener('change', (e) => {
        const waveId = parseInt(e.target.dataset.waveId);
        const idx = parseInt(e.target.dataset.agentIdx);
        const wave = wavesConfig.waves.find(w => w.id === waveId);
        if (wave && wave.agents[idx]) {
          wave.agents[idx].id = e.target.value;
        }
      });
    });

    // Agent task textarea
    document.querySelectorAll('.agent-task').forEach(textarea => {
      textarea.addEventListener('change', (e) => {
        const waveId = parseInt(e.target.dataset.waveId);
        const idx = parseInt(e.target.dataset.agentIdx);
        const wave = wavesConfig.waves.find(w => w.id === waveId);
        if (wave && wave.agents[idx]) {
          wave.agents[idx].task = e.target.value;
        }
      });
    });

    // Remove agent button
    document.querySelectorAll('.remove-agent-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const waveId = parseInt(e.target.dataset.waveId);
        const idx = parseInt(e.target.dataset.agentIdx);
        const wave = wavesConfig.waves.find(w => w.id === waveId);
        if (wave) {
          wave.agents.splice(idx, 1);
          renderWaves();
        }
      });
    });

    // Add agent button
    document.querySelectorAll('.add-agent-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const waveId = parseInt(e.target.dataset.waveId);
        const wave = wavesConfig.waves.find(w => w.id === waveId);
        if (wave) {
          wave.agents.push({
            id: 'crew-main',
            task: '[TASK] Describe what this agent should do...'
          });
          renderWaves();
        }
      });
    });

    // Template buttons
    document.querySelectorAll('.template-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const templateId = e.target.closest('.template-btn').dataset.template;
        applyTemplate(templateId);
      });
    });

    // Save button
    document.getElementById('saveWavesBtn')?.addEventListener('click', saveWavesConfig);

    // Reset button
    document.getElementById('resetWavesBtn')?.addEventListener('click', resetWavesConfig);
  }

  function applyTemplate(templateId) {
    const template = wavesConfig.templates[templateId];
    if (!template) return;

    if (template.wave_overrides) {
      Object.entries(template.wave_overrides).forEach(([waveIdStr, overrides]) => {
        const waveId = parseInt(waveIdStr);
        const wave = wavesConfig.waves.find(w => w.id === waveId);
        if (wave && overrides.agents) {
          wave.agents = overrides.agents;
        }
      });
    }

    renderWaves();
    showSuccess(`Applied template: ${template.name}`);
  }

  async function saveWavesConfig() {
    try {
      const res = await fetch('/api/waves/config', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(wavesConfig)
      });
      if (!res.ok) throw new Error(await res.text());
      showSuccess('Waves configuration saved');
    } catch (e) {
      showError('Failed to save: ' + e.message);
    }
  }

  async function resetWavesConfig() {
    if (!confirm('Reset waves to default configuration?')) return;
    try {
      const res = await fetch('/api/waves/config/reset', {method: 'POST'});
      if (!res.ok) throw new Error(await res.text());
      await loadWavesConfig();
      showSuccess('Reset to default configuration');
    } catch (e) {
      showError('Failed to reset: ' + e.message);
    }
  }

  function showSuccess(msg) {
    // Reuse existing notification system
    const notif = document.createElement('div');
    notif.textContent = '✅ ' + msg;
    notif.style.cssText = 'position: fixed; top: 20px; right: 20px; background: var(--success); color: white; padding: 12px 20px; border-radius: 8px; z-index: 10000; font-weight: 600;';
    document.body.appendChild(notif);
    setTimeout(() => notif.remove(), 3000);
  }

  function showError(msg) {
    const notif = document.createElement('div');
    notif.textContent = '❌ ' + msg;
    notif.style.cssText = 'position: fixed; top: 20px; right: 20px; background: var(--error); color: white; padding: 12px 20px; border-radius: 8px; z-index: 10000; font-weight: 600;';
    document.body.appendChild(notif);
    setTimeout(() => notif.remove(), 5000);
  }

  // Initialize
  loadWavesConfig();
}
