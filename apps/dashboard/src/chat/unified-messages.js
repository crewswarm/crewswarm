/**
 * Unified Project Messages UI
 * Adds unified view, search, and export functionality to chat tab
 */

import { getJSON, postJSON } from '../core/api.js';
import { state } from '../core/state.js';
import { showNotification as notify } from '../core/dom.js';

let unifiedViewEnabled = false;

/**
 * Toggle unified view (shows all sources with indicators)
 */
export async function toggleUnifiedView() {
  unifiedViewEnabled = !unifiedViewEnabled;
  
  const btn = document.getElementById('unifiedViewToggle');
  if (unifiedViewEnabled) {
    btn.style.background = 'var(--accent)';
    btn.style.color = '#fff';
    btn.textContent = '📊 Unified ✓';
    notify('Unified view enabled — showing all sources');
  } else {
    btn.style.background = '';
    btn.style.color = '';
    btn.textContent = '📊 Unified View';
    notify('Standard view restored');
  }
  
  // Reload chat history with unified view
  await loadChatHistoryWithUnified();
}

/**
 * Load chat history with unified view (if enabled)
 */
async function loadChatHistoryWithUnified() {
  const projectId = state.chatActiveProjectId;
  if (!projectId || projectId === 'general') {
    // Fall back to standard history for general chat
    return;
  }
  
  if (!unifiedViewEnabled) {
    // Standard view — just reload normally
    if (window.loadChatHistory) {
      await window.loadChatHistory();
    }
    return;
  }
  
  try {
    const data = await getJSON(`/api/crew-lead/project-messages?projectId=${encodeURIComponent(projectId)}&limit=100`);
    
    if (!data.ok) {
      console.error('Failed to load unified messages:', data.error);
      notify('Failed to load unified view', true);
      return;
    }
    
    // Clear and rebuild chat
    const box = document.getElementById('chatMessages');
    if (!box) return;
    
    box.innerHTML = '';
    
    // Source indicators
    const sourceEmoji = {
      dashboard: '💻',
      cli: '⚡',
      'sub-agent': '👷',
      agent: '🤖'
    };
    
    // Render messages
    for (const msg of data.messages) {
      const bubble = document.createElement('div');
      bubble.className = `chat-bubble ${msg.role}`;
      
      const emoji = sourceEmoji[msg.source] || '📝';
      const agentLabel = msg.agent ? ` [${msg.agent}]` : '';
      const timestamp = new Date(msg.ts).toLocaleTimeString();
      
      bubble.innerHTML = `
        <div style="font-size:10px;color:var(--text-3);margin-bottom:4px;">
          ${emoji} <strong>${msg.source}</strong>${agentLabel} · ${timestamp}
        </div>
        <div style="white-space:pre-wrap;word-break:break-word;">${escapeHtml(msg.content)}</div>
      `;
      
      box.appendChild(bubble);
    }
    
    // Scroll to bottom
    box.scrollTop = box.scrollHeight;
    
    notify(`Loaded ${data.messages.length} messages from all sources`);
  } catch (e) {
    console.error('Failed to load unified messages:', e);
    notify('Failed to load unified view', true);
  }
}

/**
 * Open search modal
 */
export function openSearchModal() {
  const projectId = state.chatActiveProjectId;
  if (!projectId || projectId === 'general') {
    notify('Search requires an active project', true);
    return;
  }
  
  const modal = document.getElementById('searchModal');
  if (modal) {
    modal.style.display = 'flex';
    document.getElementById('searchInput')?.focus();
  }
}

/**
 * Close search modal
 */
export function closeSearchModal() {
  const modal = document.getElementById('searchModal');
  if (modal) {
    modal.style.display = 'none';
  }
}

/**
 * Perform search
 */
export async function performSearch() {
  const projectId = state.chatActiveProjectId;
  if (!projectId || projectId === 'general') {
    notify('Search requires an active project', true);
    return;
  }
  
  const query = document.getElementById('searchInput')?.value?.trim();
  if (!query) {
    notify('Enter a search query', true);
    return;
  }
  
  const caseSensitive = document.getElementById('searchCaseSensitive')?.checked || false;
  const source = document.getElementById('searchSource')?.value || '';
  
  const resultsDiv = document.getElementById('searchResults');
  if (!resultsDiv) return;
  
  resultsDiv.innerHTML = '<div style="text-align:center;padding:20px;">Searching...</div>';
  
  try {
    let url = `/api/crew-lead/search-project-messages?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(query)}`;
    if (caseSensitive) url += '&caseSensitive=true';
    if (source) url += `&source=${encodeURIComponent(source)}`;
    
    const data = await getJSON(url);
    
    if (!data.ok) {
      resultsDiv.innerHTML = `<div style="color:var(--red);padding:20px;">Error: ${escapeHtml(data.error)}</div>`;
      return;
    }
    
    if (data.results.length === 0) {
      resultsDiv.innerHTML = '<div style="text-align:center;color:var(--text-3);padding:20px;">No results found</div>';
      return;
    }
    
    // Render results
    const sourceEmoji = {
      dashboard: '💻',
      cli: '⚡',
      'sub-agent': '👷',
      agent: '🤖'
    };
    
    let html = `<div style="margin-bottom:12px;font-weight:600;color:var(--text-2);">${data.results.length} results</div>`;
    
    for (const result of data.results) {
      const emoji = sourceEmoji[result.source] || '📝';
      const agentLabel = result.agent ? ` [${result.agent}]` : '';
      const timestamp = new Date(result.ts).toLocaleString();
      
      html += `
        <div style="border:1px solid var(--border);border-radius:6px;padding:12px;margin-bottom:8px;background:var(--bg-card2);">
          <div style="font-size:11px;color:var(--text-3);margin-bottom:6px;">
            ${emoji} <strong>${result.source}</strong>${agentLabel} · ${timestamp}
          </div>
          <div style="font-size:13px;color:var(--text-1);">
            ${escapeHtml(result.snippet)}
          </div>
        </div>
      `;
    }
    
    resultsDiv.innerHTML = html;
    notify(`Found ${data.results.length} results`);
  } catch (e) {
    console.error('Search failed:', e);
    resultsDiv.innerHTML = `<div style="color:var(--red);padding:20px;">Search failed: ${escapeHtml(e.message)}</div>`;
  }
}

/**
 * Export messages
 */
export async function exportMessages() {
  const projectId = state.chatActiveProjectId;
  if (!projectId || projectId === 'general') {
    notify('Export requires an active project', true);
    return;
  }
  
  // Ask user for format
  const format = await new Promise(resolve => {
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:10001;display:flex;align-items:center;justify-content:center;';
    
    modal.innerHTML = `
      <div style="background:var(--bg-card);border-radius:12px;padding:24px;max-width:400px;">
        <h3 style="margin:0 0 16px 0;">Export Format</h3>
        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px;">
          <button class="export-format-btn btn-ghost" data-format="markdown" style="text-align:left;padding:12px;">
            📝 Markdown (.md) — Best for reading
          </button>
          <button class="export-format-btn btn-ghost" data-format="json" style="text-align:left;padding:12px;">
            📋 JSON — Full data with metadata
          </button>
          <button class="export-format-btn btn-ghost" data-format="csv" style="text-align:left;padding:12px;">
            📊 CSV — Spreadsheet compatible
          </button>
          <button class="export-format-btn btn-ghost" data-format="txt" style="text-align:left;padding:12px;">
            📄 Plain Text (.txt)
          </button>
        </div>
        <button onclick="this.closest('div').parentElement.remove()" class="btn-ghost" style="width:100%;">Cancel</button>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    modal.querySelectorAll('.export-format-btn').forEach(btn => {
      btn.onclick = () => {
        resolve(btn.dataset.format);
        modal.remove();
      };
    });
    
    modal.onclick = (e) => {
      if (e.target === modal) {
        resolve(null);
        modal.remove();
      }
    };
  });
  
  if (!format) return;
  
  try {
    notify('Exporting...');
    
    const url = `/api/crew-lead/export-project-messages?projectId=${encodeURIComponent(projectId)}&format=${format}&includeMetadata=true`;
    
    // Download file
    const a = document.createElement('a');
    a.href = url;
    a.download = `project-${projectId}.${format === 'markdown' ? 'md' : format}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    
    notify(`Exported as ${format.toUpperCase()}`);
  } catch (e) {
    console.error('Export failed:', e);
    notify('Export failed: ' + e.message, true);
  }
}

/**
 * Escape HTML
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Expose functions globally
if (typeof window !== 'undefined') {
  window.toggleUnifiedView = toggleUnifiedView;
  window.openSearchModal = openSearchModal;
  window.closeSearchModal = closeSearchModal;
  window.performSearch = performSearch;
  window.exportMessages = exportMessages;
}

// Add keyboard shortcuts
if (typeof window !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    // Cmd/Ctrl + K to open search
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      const projectId = state.chatActiveProjectId;
      if (projectId && projectId !== 'general') {
        e.preventDefault();
        openSearchModal();
      }
    }
    
    // Escape to close search modal
    if (e.key === 'Escape') {
      const modal = document.getElementById('searchModal');
      if (modal && modal.style.display !== 'none') {
        closeSearchModal();
      }
    }
    
    // Enter in search input to perform search
    if (e.key === 'Enter' && e.target.id === 'searchInput') {
      e.preventDefault();
      performSearch();
    }
  });
}
