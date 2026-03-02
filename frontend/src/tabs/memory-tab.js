/**
 * Memory tab — shared memory visualization and management
 */

import { getJSON, postJSON } from '../core/api.js';
import { showNotification } from '../core/dom.js';

let _state = null;

export function initMemoryTab(state) {
  _state = state;
}

export async function showMemory() {
  // Note: View activation is handled by showMemoryView() in app.js via hideAllViews() + classList.add('active')
  // Just load the data here
  await loadMemoryStats();
}

export async function loadMemoryStats() {
  try {
    const data = await getJSON('/api/memory/stats');
    
    // Update fact stats
    const factStatsEl = document.getElementById('memoryFactStats');
    if (factStatsEl && data.agentMemory) {
      const stats = data.agentMemory;
      factStatsEl.innerHTML = `
        Total facts: <strong>${stats.totalFacts || 0}</strong><br>
        Critical facts: <strong>${stats.criticalFacts || 0}</strong><br>
        Providers: ${stats.providers?.join(', ') || 'none'}<br>
        ${stats.oldestFact ? `Oldest: ${new Date(stats.oldestFact).toLocaleDateString()}<br>` : ''}
        ${stats.newestFact ? `Newest: ${new Date(stats.newestFact).toLocaleDateString()}` : ''}
      `;
    }
    
    // Update keeper stats
    const keeperStatsEl = document.getElementById('memoryKeeperStats');
    if (keeperStatsEl && data.agentKeeper) {
      const stats = data.agentKeeper;
      keeperStatsEl.innerHTML = `
        Total entries: <strong>${stats.entries || 0}</strong><br>
        Storage: <strong>${stats.bytes ? (stats.bytes / 1024).toFixed(1) + 'KB' : '0KB'}</strong><br>
        ${stats.byTier ? `By tier: ${Object.entries(stats.byTier).map(([k,v]) => `${k}=${v}`).join(', ')}<br>` : ''}
        ${stats.byAgent ? `By agent: ${Object.entries(stats.byAgent).map(([k,v]) => `${k}=${v}`).join(', ')}` : ''}
      `;
    }
    
    // Update storage info
    const storageInfoEl = document.getElementById('memoryStorageInfo');
    if (storageInfoEl) {
      storageInfoEl.innerHTML = `
        Location: <code style="font-size:11px;background:var(--bg-2);padding:2px 6px;border-radius:3px;">${data.storageDir || 'N/A'}</code><br>
        Status: <strong style="color:var(--green);">${data.available ? '✅ Active' : '⚠️ Unavailable'}</strong><br>
        <span style="font-size:10px;color:var(--text-3);">Set CREW_MEMORY_DIR to customize location</span>
      `;
    }
  } catch (err) {
    showNotification(`Failed to load memory stats: ${err.message}`, 'error');
    console.error('[memory] Stats load failed:', err);
  }
}

export async function searchMemory() {
  const queryEl = document.getElementById('memorySearchQuery');
  if (!queryEl) return;
  
  const query = queryEl.value.trim();
  if (!query) {
    showNotification('Enter a search query', 'error');
    return;
  }
  
  const resultsEl = document.getElementById('memorySearchResults');
  if (!resultsEl) return;
  
  resultsEl.style.display = 'block';
  resultsEl.innerHTML = '<div style="padding:12px;color:var(--text-2);">Searching...</div>';
  
  try {
    const data = await postJSON('/api/memory/search', { query, maxResults: 20 });
    
    if (!data.hits || data.hits.length === 0) {
      resultsEl.innerHTML = '<div style="padding:12px;color:var(--text-2);">No results found</div>';
      return;
    }
    
    const html = data.hits.map(hit => {
      const sourceColor = hit.source === 'agentkeeper' ? 'var(--blue)' : 
                         hit.source === 'agent-memory' ? 'var(--green)' : 'var(--purple)';
      const preview = hit.text.length > 300 ? hit.text.slice(0, 300) + '...' : hit.text;
      
      return `
        <div style="padding:12px;border-left:3px solid ${sourceColor};background:var(--bg-2);border-radius:6px;margin-bottom:8px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <span style="font-size:10px;font-weight:600;color:${sourceColor};text-transform:uppercase;">${hit.source}</span>
            <span style="font-size:11px;font-weight:600;color:var(--text-1);flex:1;">${escapeHtml(hit.title)}</span>
            <span style="font-size:10px;color:var(--text-3);font-family:monospace;">score: ${hit.score.toFixed(3)}</span>
          </div>
          <div style="font-size:11px;color:var(--text-2);line-height:1.5;white-space:pre-wrap;">${escapeHtml(preview)}</div>
          ${hit.metadata ? `<div style="font-size:10px;color:var(--text-3);margin-top:6px;">${JSON.stringify(hit.metadata)}</div>` : ''}
        </div>
      `;
    }).join('');
    
    resultsEl.innerHTML = `
      <div style="padding:8px 0;font-size:12px;color:var(--text-2);">
        Found <strong>${data.hits.length}</strong> result(s) for "<strong>${escapeHtml(query)}</strong>"
      </div>
      ${html}
    `;
  } catch (err) {
    resultsEl.innerHTML = `<div style="padding:12px;color:var(--red);">Search failed: ${escapeHtml(err.message)}</div>`;
    showNotification(`Memory search failed: ${err.message}`, 'error');
  }
}

export async function migrateMemory() {
  const resultEl = document.getElementById('memoryActionResult');
  if (!resultEl) return;
  
  resultEl.style.display = 'block';
  resultEl.innerHTML = '<div style="color:var(--text-2);">Migrating brain.md entries to shared memory...</div>';
  
  try {
    const data = await postJSON('/api/memory/migrate', {});
    
    if (data.ok) {
      resultEl.innerHTML = `
        <div style="color:var(--green);">✅ Migration complete</div>
        <div style="margin-top:6px;font-size:11px;">
          Imported: ${data.imported}, Skipped: ${data.skipped}, Errors: ${data.errors}
        </div>
      `;
      showNotification('Brain.md migrated successfully', 'success');
      await loadMemoryStats();
    } else {
      resultEl.innerHTML = `<div style="color:var(--red);">❌ Migration failed: ${escapeHtml(data.error || 'unknown error')}</div>`;
      showNotification(`Migration failed: ${data.error}`, 'error');
    }
  } catch (err) {
    resultEl.innerHTML = `<div style="color:var(--red);">❌ Migration failed: ${escapeHtml(err.message)}</div>`;
    showNotification(`Migration failed: ${err.message}`, 'error');
  }
}

export async function compactMemory() {
  const resultEl = document.getElementById('memoryActionResult');
  if (!resultEl) return;
  
  resultEl.style.display = 'block';
  resultEl.innerHTML = '<div style="color:var(--text-2);">Compacting AgentKeeper store...</div>';
  
  try {
    const data = await postJSON('/api/memory/compact', {});
    
    if (data.entriesBefore !== undefined) {
      const bytesFreedKB = (data.bytesFreed / 1024).toFixed(1);
      resultEl.innerHTML = `
        <div style="color:var(--green);">✅ Compaction complete</div>
        <div style="margin-top:6px;font-size:11px;">
          Entries: ${data.entriesBefore} → ${data.entriesAfter}<br>
          Space freed: ${bytesFreedKB}KB
        </div>
      `;
      showNotification('AgentKeeper compacted successfully', 'success');
      await loadMemoryStats();
    } else {
      resultEl.innerHTML = `<div style="color:var(--red);">❌ Compaction failed: ${escapeHtml(data.error || 'unknown error')}</div>`;
      showNotification(`Compaction failed: ${data.error}`, 'error');
    }
  } catch (err) {
    resultEl.innerHTML = `<div style="color:var(--red);">❌ Compaction failed: ${escapeHtml(err.message)}</div>`;
    showNotification(`Compaction failed: ${err.message}`, 'error');
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
