/**
 * Prompts tab — view and edit agent system prompts
 * Deps: getJSON, postJSON (core/api), escHtml, showNotification (core/dom)
 */

import { getJSON, postJSON } from "../core/api.js";
import { escHtml, showNotification } from "../core/dom.js";
import { state, persistState } from "../core/state.js";

let currentEditingAgent = null;

let hideAllViews = () => {};
let setNavActive = () => {};

/** Call once from app.js (same pattern as initAgentsTab). */
export function initPromptsTabDeps(deps = {}) {
  hideAllViews = deps.hideAllViews || hideAllViews;
  setNavActive = deps.setNavActive || setNavActive;
}

export async function initPromptsTab() {
  hideAllViews();
  const view = document.getElementById("promptsView");
  if (view) {
    view.classList.add("active");
  }
  setNavActive("navPrompts");
  state.activeTab = "prompts";
  persistState();
  
  // Wire up event listeners (only once)
  const list = document.getElementById("promptsList");
  if (list && !list.dataset.wired) {
    list.dataset.wired = "true";
    list.addEventListener("click", (e) => {
      if (e.target.closest(".prompt-edit-btn")) {
        const agent = e.target.closest(".prompt-edit-btn").dataset.agent;
        showPromptEditor(agent);
      }
    });
  }

  const cancelBtn = document.getElementById("promptEditorCancel");
  const saveBtn = document.getElementById("promptEditorSave");
  if (cancelBtn && !cancelBtn.dataset.wired) {
    cancelBtn.dataset.wired = "true";
    cancelBtn.addEventListener("click", hidePromptEditor);
  }
  if (saveBtn && !saveBtn.dataset.wired) {
    saveBtn.dataset.wired = "true";
    saveBtn.addEventListener("click", savePrompt);
  }

  await loadPrompts();
}

export async function loadPrompts() {
  try {
    const data = await getJSON('/api/prompts');
    const container = document.getElementById('promptsList');
    if (!container) return;
    
    const prompts = Object.entries(data.prompts || {});
    
    if (!prompts.length) {
      container.innerHTML = '<p style="color:var(--text-2);padding:16px;">No agent prompts configured.</p>';
      return;
    }
    
    const html = prompts.map(([agentId, prompt]) => {
      const preview = (prompt || '').slice(0, 150).replace(/\n/g, ' ');
      const lines = (prompt || '').split('\n').length;
      const chars = (prompt || '').length;
      
      return `
        <div class="prompt-card">
          <div class="prompt-header">
            <div>
              <strong style="font-size:14px;">${escHtml(agentId)}</strong>
              <div style="font-size:11px;color:var(--text-3);margin-top:2px;">
                ${lines} lines · ${chars} chars
              </div>
            </div>
            <button class="btn-secondary prompt-edit-btn" data-agent="${escHtml(agentId)}">
              Edit
            </button>
          </div>
          <div class="prompt-preview">
            ${escHtml(preview)}${prompt.length > 150 ? '...' : ''}
          </div>
        </div>
      `;
    }).join('');
    
    container.innerHTML = html;
    
    // Update stats
    document.getElementById('promptsCount').textContent = prompts.length;
    
  } catch (e) {
    showNotification('Failed to load prompts: ' + e.message, 'error');
  }
}

function showPromptEditor(agentId) {
  currentEditingAgent = agentId;
  
  getJSON('/api/prompts').then(data => {
    const prompt = data.prompts[agentId] || '';
    
    document.getElementById('promptEditorAgent').textContent = agentId;
    document.getElementById('promptEditorTextarea').value = prompt;
    document.getElementById('promptEditorChar').textContent = prompt.length;
    document.getElementById('promptEditorLine').textContent = prompt.split('\n').length;
    
    document.getElementById('promptEditor').style.display = 'block';
    document.getElementById('promptEditorTextarea').focus();
    
    // Live character count
    document.getElementById('promptEditorTextarea').oninput = (e) => {
      const val = e.target.value;
      document.getElementById('promptEditorChar').textContent = val.length;
      document.getElementById('promptEditorLine').textContent = val.split('\n').length;
    };
  }).catch(e => {
    showNotification('Failed to load prompt: ' + e.message, 'error');
  });
}

function hidePromptEditor() {
  document.getElementById('promptEditor').style.display = 'none';
  currentEditingAgent = null;
}

async function savePrompt() {
  if (!currentEditingAgent) return;
  
  const newPrompt = document.getElementById('promptEditorTextarea').value;
  const saveBtn = document.getElementById('promptEditorSave');
  
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';
  
  try {
    await postJSON('/api/prompts', {
      agent: currentEditingAgent,
      prompt: newPrompt
    });
    
    showNotification(`Prompt updated for ${currentEditingAgent}. Restart its bridge to apply.`);
    hidePromptEditor();
    await loadPrompts();
    
  } catch (e) {
    showNotification('Save failed: ' + e.message, 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
  }
}
