/**
 * CLI Process View - Orchestration status + model configuration
 */

import { updateOrchestrationStatus, startOrchestrationStatusUpdates, stopOrchestrationStatusUpdates } from './orchestration-status.js';

let cliProcessMode = 'connected';

window.initCLIProcess = async function() {
  await loadCLIProcessConfig();
  startOrchestrationStatusUpdates();
  setupCLIProcessListeners();
};

function setupCLIProcessListeners() {
  document.querySelector('[data-action="toggleCLIProcessMode"]')?.addEventListener('click', toggleCLIProcessMode);
  document.querySelector('[data-action="saveCLIProcessConfig"]')?.addEventListener('click', saveCLIProcessConfig);
  document.querySelector('[data-action="resetCLIProcessConfig"]')?.addEventListener('click', resetCLIProcessConfig);
  document.querySelector('[data-action="refreshCLIProcess"]')?.addEventListener('click', async () => {
    await updateOrchestrationStatus();
    await loadCLIProcessConfig();
  });
}

function toggleCLIProcessMode() {
  cliProcessMode = cliProcessMode === 'connected' ? 'standalone' : 'connected';
  const btn = document.getElementById('cliProcessMode');
  if (btn) {
    btn.textContent = cliProcessMode === 'connected' ? '🔌 Connected Mode' : '🔌 Standalone Mode';
    btn.style.color = cliProcessMode === 'connected' ? '#10b981' : '#6b7280';
  }
  cliProcessMode === 'connected' ? startOrchestrationStatusUpdates() : stopOrchestrationStatusUpdates();
}

async function loadCLIProcessConfig() {
  try {
    const saved = localStorage.getItem('crewswarm_cli_process_config');
    if (saved) {
      const config = JSON.parse(saved);
      document.getElementById('configRouterModel').value = config.CREW_ROUTER_MODEL || '';
      document.getElementById('configReasoningModel').value = config.CREW_REASONING_MODEL || '';
      document.getElementById('configL2AModel').value = config.CREW_L2A_MODEL || '';
      document.getElementById('configL2BModel').value = config.CREW_L2B_MODEL || '';
      document.getElementById('configExecutionModel').value = config.CREW_EXECUTION_MODEL || '';
      document.getElementById('configQAModel').value = config.CREW_QA_MODEL || '';
      document.getElementById('configMaxWorkers').value = config.CREW_MAX_PARALLEL_WORKERS || '6';
      document.getElementById('configExtraValidators').value = config.CREW_L2_EXTRA_VALIDATORS || '';
    }
  } catch (err) {
    console.error('[CLI Process] Failed to load config:', err);
  }
}

async function saveCLIProcessConfig() {
  const config = {
    CREW_ROUTER_MODEL: document.getElementById('configRouterModel')?.value || '',
    CREW_REASONING_MODEL: document.getElementById('configReasoningModel')?.value || '',
    CREW_L2A_MODEL: document.getElementById('configL2AModel')?.value || '',
    CREW_L2B_MODEL: document.getElementById('configL2BModel')?.value || '',
    CREW_EXECUTION_MODEL: document.getElementById('configExecutionModel')?.value || '',
    CREW_QA_MODEL: document.getElementById('configQAModel')?.value || '',
    CREW_MAX_PARALLEL_WORKERS: document.getElementById('configMaxWorkers')?.value || '6',
    CREW_L2_EXTRA_VALIDATORS: document.getElementById('configExtraValidators')?.value || ''
  };
  localStorage.setItem('crewswarm_cli_process_config', JSON.stringify(config));
  alert('✅ CLI configuration saved');
}

function resetCLIProcessConfig() {
  ['configRouterModel','configReasoningModel','configL2AModel','configL2BModel','configExecutionModel','configQAModel','configExtraValidators'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('configMaxWorkers').value = '6';
  alert('↻ Configuration reset');
}

export { cliProcessMode };
