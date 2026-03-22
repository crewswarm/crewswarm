import { getJSON, postJSON } from '../core/api.js';
import { escHtml, showNotification } from '../core/dom.js';

let showSettings = () => {};
let showSettingsTab = () => {};
let _waSavedContactNames = {};
let _waSavedUserRouting = {};
let _tgSavedContactNames = {};
let _tgSavedUserRouting = {};
let _tgSavedTopicRouting = {};

export function initCommsTab(deps = {}) {
  showSettings = deps.showSettings || showSettings;
  showSettingsTab = deps.showSettingsTab || showSettingsTab;
}

export function showMessaging() {
  showSettings();
  showSettingsTab('comms');
}

export async function loadCommsTabData() {
  await Promise.allSettled([
    loadTgStatus(),
    loadTelegramSessions(),
    loadTgMessages(),
    loadTgConfig(),
    loadWaStatus(),
    loadWaConfig(),
    loadWaMessages(),
  ]);
}

export async function loadTgStatus() {
  try {
    const d = await getJSON('/api/telegram/status');
    const badge = document.getElementById('tgStatusBadge');
    if (!badge) return;
    if (d.running) {
      badge.textContent = d.botName ? '● @' + d.botName : '● running';
      badge.className = 'status-badge status-active';
    } else {
      badge.textContent = '● stopped';
      badge.className = 'status-badge status-stopped';
    }
  } catch {}
}

export function renderTgContactRows() {
  const listEl = document.getElementById('tgContactNamesList');
  if (!listEl) return;
  const raw = (document.getElementById('tgAllowedIds')?.value || '').trim();
  const ids = raw ? raw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n)) : [];
  listEl.innerHTML = '';
  if (!ids.length) return;
  const title = document.createElement('label');
  title.style.cssText = 'display:block;margin-bottom:6px;font-size:12px;color:var(--text-2);';
  title.textContent = 'Contact names & routing';
  listEl.appendChild(title);
  ids.forEach(id => {
    // Container for 2-line layout
    const container = document.createElement('div');
    container.style.cssText = 'margin-bottom:12px;padding:12px;background:var(--bg-1);border:1px solid var(--border);border-radius:6px;';
    
    // Line 1: Chat ID + Name
    const row1 = document.createElement('div');
    row1.style.cssText = 'display:grid;grid-template-columns:100px 1fr;gap:8px;margin-bottom:8px;align-items:center;';
    
    const span = document.createElement('span');
    span.style.cssText = 'font-size:11px;color:var(--text-3);font-family:monospace;';
    span.textContent = String(id);
    
    const input = document.createElement('input');
    input.id = 'tgContact-' + id;
    input.placeholder = 'Name (e.g. Jeff)';
    input.value = _tgSavedContactNames[String(id)] || '';
    input.style.cssText = 'font-size:12px;padding:6px 8px;background:var(--bg-card);border:1px solid var(--border);border-radius:4px;color:var(--text-1);';
    
    row1.appendChild(span);
    row1.appendChild(input);
    
    // Line 2: Routing label + dropdown
    const row2 = document.createElement('div');
    row2.style.cssText = 'display:grid;grid-template-columns:100px 1fr;gap:8px;align-items:center;';
    
    const routeLabel = document.createElement('span');
    routeLabel.style.cssText = 'font-size:10px;color:var(--text-3);text-transform:uppercase;letter-spacing:0.05em;';
    routeLabel.textContent = 'Routes to →';
    
    const routeSelect = document.createElement('select');
    routeSelect.id = 'tgRoute-' + id;
    routeSelect.style.cssText = 'font-size:12px;padding:6px 8px;background:var(--bg-card);border:1px solid var(--border);border-radius:4px;color:var(--text-1);';
    
    // Get current routing for this chat ID
    const currentRoute = _tgSavedUserRouting[String(id)] || '';
    
    const agents = [
      'crew-lead', 'crew-main', 'crew-coder', 'crew-pm', 'crew-qa', 
      'crew-fixer', 'crew-security', 'crew-frontend', 'crew-coder-front', 
      'crew-coder-back', 'crew-github', 'crew-copywriter', 'crew-researcher',
      'crew-architect', 'crew-seo', 'crew-ml', 'crew-mega', 'crew-loco'
    ];
    
    // Default option
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = '— default (crew-lead) —';
    routeSelect.appendChild(defaultOpt);
    
    // Agent options
    agents.forEach(agent => {
      const opt = document.createElement('option');
      opt.value = agent;
      opt.textContent = agent;
      if (agent === currentRoute) opt.selected = true;
      routeSelect.appendChild(opt);
    });
    
    // Update state immediately when routing changes
    routeSelect.addEventListener('change', (e) => {
      const newAgent = e.target.value;
      if (newAgent) {
        _tgSavedUserRouting[String(id)] = newAgent;
      } else {
        delete _tgSavedUserRouting[String(id)];
      }
    });
    
    row2.appendChild(routeLabel);
    row2.appendChild(routeSelect);
    
    container.appendChild(row1);
    container.appendChild(row2);
    listEl.appendChild(container);
  });
}

export async function loadTgConfig() {
  try {
    const d = await getJSON('/api/telegram/config');
    if (d.token) document.getElementById('tgTokenInput').value = d.token;
    const ids = d.allowedChatIds && d.allowedChatIds.length ? d.allowedChatIds : [];
    document.getElementById('tgAllowedIds').value = ids.join(', ');
    _tgSavedContactNames = d.contactNames || {};
    _tgSavedUserRouting = d.userRouting || {};
    _tgSavedTopicRouting = d.topicRouting || {};
    renderTgContactRows();
    renderTgTopicRouting();
  } catch {}
}

export function renderTgTopicRouting() {
  const container = document.getElementById('tgTopicRoutingContainer');
  if (!container) return;
  
  // Clear existing content
  container.innerHTML = '';
  
  // Title and explanation
  const header = document.createElement('div');
  header.style.cssText = 'margin-bottom:12px;';
  header.innerHTML = `
    <div style="font-size:13px;font-weight:600;margin-bottom:4px;">📌 Topic Routing (Optional)</div>
    <div style="font-size:11px;color:var(--text-3);line-height:1.4;">
      Route different topics in Forum groups to different agents.
    </div>
  `;
  container.appendChild(header);
  
  // Action buttons
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;';
  
  const discoverBtn = document.createElement('button');
  discoverBtn.textContent = '🔍 Auto-discover Topics';
  discoverBtn.className = 'btn-ghost';
  discoverBtn.style.cssText = 'flex:1;font-size:12px;';
  discoverBtn.onclick = () => discoverTgTopics();
  
  const addGroupBtn = document.createElement('button');
  addGroupBtn.textContent = '➕ Add New Group';
  addGroupBtn.className = 'btn-ghost';
  addGroupBtn.style.cssText = 'flex:1;font-size:12px;';
  addGroupBtn.onclick = () => addTgNewGroup();
  
  btnRow.appendChild(discoverBtn);
  btnRow.appendChild(addGroupBtn);
  container.appendChild(btnRow);
  
  // Topics list container
  const listDiv = document.createElement('div');
  listDiv.id = 'tgTopicsList';
  listDiv.style.cssText = 'margin-bottom:12px;';
  container.appendChild(listDiv);
  
  // Render existing topics
  renderTgTopicsList();
  
  // Advanced: JSON editor (collapsed)
  const advancedToggle = document.createElement('details');
  advancedToggle.style.cssText = 'margin-top:12px;';
  advancedToggle.innerHTML = `
    <summary style="cursor:pointer;font-size:11px;color:var(--text-3);padding:6px 0;">
      ⚙️ Advanced: Edit JSON directly
    </summary>
  `;
  
  const textarea = document.createElement('textarea');
  textarea.id = 'tgTopicRoutingJson';
  textarea.placeholder = `{
  "-100123456789": {
    "5": "crew-coder",
    "8": "crew-copywriter"
  }
}`;
  textarea.value = Object.keys(_tgSavedTopicRouting).length ? JSON.stringify(_tgSavedTopicRouting, null, 2) : '';
  textarea.style.cssText = 'width:100%;min-height:100px;font-family:monospace;font-size:11px;padding:8px;background:var(--bg-1);border:1px solid var(--border);border-radius:4px;color:var(--text-1);resize:vertical;margin-top:8px;';
  advancedToggle.appendChild(textarea);
  
  container.appendChild(advancedToggle);
}

export function renderTgTopicsList() {
  const listDiv = document.getElementById('tgTopicsList');
  if (!listDiv) return;
  
  listDiv.innerHTML = '';
  
  const agents = [
    'crew-lead', 'crew-main', 'crew-coder', 'crew-pm', 'crew-qa', 
    'crew-fixer', 'crew-security', 'crew-frontend', 'crew-coder-front', 
    'crew-coder-back', 'crew-github', 'crew-copywriter', 'crew-researcher',
    'crew-architect', 'crew-seo', 'crew-ml', 'crew-mega', 'crew-loco'
  ];
  
  // Group topics by chatId
  const groupedTopics = {};
  Object.entries(_tgSavedTopicRouting).forEach(([key, value]) => {
    if (key.startsWith('_')) return; // Skip comment fields
    if (typeof value === 'object') {
      Object.entries(value).forEach(([topicId, agent]) => {
        if (!groupedTopics[key]) groupedTopics[key] = [];
        groupedTopics[key].push({ topicId, agent });
      });
    } else {
      const [chatId, topicId] = key.split(':');
      if (!groupedTopics[chatId]) groupedTopics[chatId] = [];
      groupedTopics[chatId].push({ topicId, agent: value });
    }
  });
  
  if (Object.keys(groupedTopics).length === 0) {
    const emptyMsg = document.createElement('div');
    emptyMsg.style.cssText = 'padding:12px;text-align:center;color:var(--text-3);font-size:11px;background:var(--bg-1);border:1px dashed var(--border);border-radius:4px;';
    emptyMsg.textContent = 'No topics configured. Click "Auto-discover" or "Add Manually" above.';
    listDiv.appendChild(emptyMsg);
    return;
  }
  
  let globalIdx = 0;
  
  // Render each group
  Object.entries(groupedTopics).forEach(([chatId, topics]) => {
    // Group container (class for saveTgConfig selector)
    const groupContainer = document.createElement('div');
    groupContainer.className = 'tg-topic-group';
    groupContainer.style.cssText = 'margin-bottom:16px;padding:12px;background:var(--bg-1);border:1px solid var(--border);border-radius:6px;';
    
    // Group header with chat ID
    const groupHeader = document.createElement('div');
    groupHeader.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--border);';
    
    const groupLabel = document.createElement('span');
    groupLabel.textContent = 'Group ID:';
    groupLabel.style.cssText = 'font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:0.05em;';
    
    const chatIdInput = document.createElement('input');
    chatIdInput.value = chatId;
    chatIdInput.className = 'tg-topic-group-chatid';
    chatIdInput.dataset.groupChatId = chatId;
    chatIdInput.style.cssText = 'flex:1;font-size:11px;padding:5px 8px;background:var(--bg-card);border:1px solid var(--border);border-radius:3px;color:var(--text-1);font-family:monospace;';
    
    // Add topic to this group button
    const addTopicBtn = document.createElement('button');
    addTopicBtn.textContent = '➕';
    addTopicBtn.className = 'btn-ghost';
    addTopicBtn.title = 'Add topic to this group';
    addTopicBtn.style.cssText = 'font-size:14px;padding:4px 8px;width:32px;height:28px;';
    addTopicBtn.addEventListener('click', (e) => {
      e.preventDefault();
      addTgTopicToGroup(chatId);
    });
    
    // Delete group button
    const deleteGroupBtn = document.createElement('button');
    deleteGroupBtn.textContent = '🗑';
    deleteGroupBtn.className = 'btn-ghost';
    deleteGroupBtn.title = 'Delete entire group and all topics';
    deleteGroupBtn.style.cssText = 'font-size:14px;padding:4px 8px;width:32px;height:28px;';
    deleteGroupBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (window.confirm(`Delete group ${chatId} and all topics?`)) {
        delete _tgSavedTopicRouting[String(chatId)];
        renderTgTopicsList();
        showNotification('Group removed - click Save to persist');
      }
    });
    
    groupHeader.appendChild(groupLabel);
    groupHeader.appendChild(chatIdInput);
    groupHeader.appendChild(addTopicBtn);
    groupHeader.appendChild(deleteGroupBtn);
    groupContainer.appendChild(groupHeader);
    
    // Topic rows under this group
    topics.forEach(topic => {
      const row = document.createElement('div');
      row.style.cssText = 'display:grid;grid-template-columns:80px 1fr 36px;gap:8px;align-items:center;padding:6px 8px;margin-bottom:4px;';
      row.dataset.idx = globalIdx;
      row.dataset.chatId = chatId;
      row.dataset.originalTopicId = topic.topicId; // Track for renames
      
      // Topic ID input
      const topicIdInput = document.createElement('input');
      topicIdInput.value = topic.topicId;
      topicIdInput.placeholder = 'Topic 5';
      topicIdInput.className = 'tg-topic-id';
      topicIdInput.style.cssText = 'font-size:11px;padding:5px 8px;background:var(--bg-card);border:1px solid var(--border);border-radius:3px;color:var(--text-1);font-family:monospace;text-align:center;';
      
      // Agent dropdown
      const agentSelect = document.createElement('select');
      agentSelect.className = 'tg-topic-agent';
      agentSelect.style.cssText = 'font-size:11px;padding:5px 8px;background:var(--bg-card);border:1px solid var(--border);border-radius:3px;color:var(--text-1);';
      agents.forEach(agent => {
        const opt = document.createElement('option');
        opt.value = agent;
        opt.textContent = agent;
        if (agent === topic.agent) opt.selected = true;
        agentSelect.appendChild(opt);
      });
      
      // Update state immediately when agent changes
      agentSelect.addEventListener('change', (e) => {
        const newAgent = e.target.value;
        const topicIdInput = row.querySelector('.tg-topic-id');
        const topicId = topicIdInput ? topicIdInput.value.trim() : topic.topicId;
        
        if (topicId && _tgSavedTopicRouting[chatId]) {
          _tgSavedTopicRouting[chatId][topicId] = newAgent;
          
          // Update JSON editor too
          const topicJsonEl = document.getElementById('tgTopicRoutingJson');
          if (topicJsonEl) {
            topicJsonEl.value = JSON.stringify(_tgSavedTopicRouting, null, 2);
          }
        }
      });
      
      // Remove button
      const removeBtn = document.createElement('button');
      removeBtn.textContent = '🗑';
      removeBtn.className = 'btn-ghost';
      removeBtn.title = 'Remove this topic';
      removeBtn.style.cssText = 'font-size:14px;padding:4px;width:28px;height:28px;';
      removeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (window.confirm(`Remove topic ${topic.topicId}?`)) {
          // Direct delete from nested structure (fast - no rebuild)
          if (_tgSavedTopicRouting[chatId] && _tgSavedTopicRouting[chatId][topic.topicId]) {
            delete _tgSavedTopicRouting[chatId][topic.topicId];
            
            // If group is now empty, remove the group key
            if (Object.keys(_tgSavedTopicRouting[chatId]).length === 0) {
              delete _tgSavedTopicRouting[chatId];
            }
            
            // Re-render and update JSON editor
            renderTgTopicsList();
            showNotification(`Topic ${topic.topicId} removed - click Save to persist`);
          }
        }
      });
      
      row.appendChild(topicIdInput);
      row.appendChild(agentSelect);
      row.appendChild(removeBtn);
      groupContainer.appendChild(row);
      
      globalIdx++;
    });
    
    listDiv.appendChild(groupContainer);
  });

  // Keep JSON editor in sync when state changes (e.g. after delete/add)
  const topicJsonEl = document.getElementById('tgTopicRoutingJson');
  if (topicJsonEl) {
    topicJsonEl.value = Object.keys(_tgSavedTopicRouting).length ? JSON.stringify(_tgSavedTopicRouting, null, 2) : '';
  }
}

export function addTgNewGroup() {
  // Add a brand new group
  const newGroupId = prompt('Enter Group ID (e.g., -100123456789):');
  if (!newGroupId || !newGroupId.trim()) return;
  
  const groupId = newGroupId.trim();
  if (!_tgSavedTopicRouting[groupId]) {
    _tgSavedTopicRouting[groupId] = {};
  }
  
  // Add first topic to the new group
  const newTopicId = '1';
  _tgSavedTopicRouting[groupId][newTopicId] = 'crew-lead';
  renderTgTopicsList();
  showNotification(`Added group ${groupId}`);
}

export function addTgTopicToGroup(chatId) {
  // Add topic to specific group
  if (!_tgSavedTopicRouting[chatId]) {
    _tgSavedTopicRouting[chatId] = {};
  }
  
  // Generate new topic ID (find highest + 1)
  const existingIds = Object.keys(_tgSavedTopicRouting[chatId]).map(id => parseInt(id, 10)).filter(n => !isNaN(n));
  const newTopicId = existingIds.length > 0 ? String(Math.max(...existingIds) + 1) : '1';
  
  _tgSavedTopicRouting[chatId][newTopicId] = 'crew-lead';
  renderTgTopicsList();
  showNotification(`Added topic ${newTopicId} to group`);
}

export function addTgTopicRow() {
  // Legacy: Add to first existing group
  const existingChatIds = Object.keys(_tgSavedTopicRouting).filter(k => !k.startsWith('_'));
  if (existingChatIds.length === 0) {
    // No groups exist, create one
    addTgNewGroup();
    return;
  }
  
  // Add to first group
  addTgTopicToGroup(existingChatIds[0]);
}

export function removeTgGroup(chatId) {
  // Remove entire group from topic routing
  delete _tgSavedTopicRouting[String(chatId)];
  renderTgTopicsList();
  showNotification(`Removed group ${chatId} - don't forget to Save config!`);
}

export function removeTgTopicRow(idx) {
  // Rebuild topic routing without this entry
  const topics = [];
  Object.entries(_tgSavedTopicRouting).forEach(([key, value]) => {
    if (key.startsWith('_')) return;
    if (typeof value === 'object') {
      Object.entries(value).forEach(([topicId, agent]) => {
        topics.push({ chatId: key, topicId, agent });
      });
    } else {
      const [chatId, topicId] = key.split(':');
      topics.push({ chatId, topicId, agent: value });
    }
  });
  
  topics.splice(idx, 1);
  
  // Rebuild nested format
  _tgSavedTopicRouting = {};
  topics.forEach(t => {
    if (!_tgSavedTopicRouting[t.chatId]) _tgSavedTopicRouting[t.chatId] = {};
    _tgSavedTopicRouting[t.chatId][t.topicId] = t.agent;
  });
  
  renderTgTopicsList();
}

export async function discoverTgTopics() {
  try {
    const allTopics = await getJSON('/api/telegram/discover-topics');
    if (!allTopics.length) {
      showNotification('No topics found in logs. Send messages to topics first.', true);
      return;
    }

    // Group discovered topics by chatId
    const groupedDiscovered = {};
    allTopics.forEach(t => {
      if (!groupedDiscovered[t.chatId]) {
        groupedDiscovered[t.chatId] = [];
      }
      groupedDiscovered[t.chatId].push(t);
    });

    // Build modal with checkboxes per-TOPIC (not per-group)
    const existingGroups = Object.keys(_tgSavedTopicRouting).filter(k => !k.startsWith('_'));
    
    let modalHtml = '<div style="max-height:400px;overflow-y:auto;">';
    Object.entries(groupedDiscovered).forEach(([chatId, topics]) => {
      modalHtml += `
        <div style="background:var(--bg-1);border:1px solid var(--border);border-radius:6px;padding:12px;margin-bottom:12px;">
          <div style="font-weight:600;margin-bottom:8px;font-family:monospace;font-size:12px;">
            Group ${chatId}
          </div>
          <div style="margin-left:12px;">
      `;
      
      // Checkbox for each topic
      topics.forEach(t => {
        const topicId = String(t.threadId);
        const alreadyExists = _tgSavedTopicRouting[chatId]?.[topicId];
        const checked = !alreadyExists ? 'checked' : '';
        const disabledLabel = alreadyExists ? ' <span style="font-size:10px;color:var(--text-3);">(already configured)</span>' : '';
        
        modalHtml += `
          <div style="margin-bottom:6px;display:flex;align-items:center;gap:8px;">
            <input type="checkbox" class="discover-topic-check" data-chat-id="${chatId}" data-thread-id="${topicId}" ${checked} ${alreadyExists ? 'disabled' : ''}>
            <span style="font-size:11px;color:var(--text-2);">Topic ${topicId}${disabledLabel}</span>
          </div>
        `;
      });
      
      modalHtml += `
          </div>
        </div>
      `;
    });
    modalHtml += '</div>';

    // Simple confirmation with HTML
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9999;';
    modal.innerHTML = `
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:20px;max-width:600px;width:90%;">
        <h3 style="margin:0 0 16px;font-size:16px;">Discovered Topics</h3>
        <div style="font-size:11px;color:var(--text-3);margin-bottom:12px;">
          ✓ Select which topics to add. Already configured topics are disabled.
        </div>
        ${modalHtml}
        <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end;">
          <button class="btn-ghost" id="discoverCancel">Cancel</button>
          <button class="btn-primary" id="discoverConfirm">Add Selected</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('discoverCancel').onclick = () => {
      document.body.removeChild(modal);
    };

    document.getElementById('discoverConfirm').onclick = () => {
      const checkedTopics = Array.from(modal.querySelectorAll('.discover-topic-check:checked'));
      let addedCount = 0;

      checkedTopics.forEach(checkbox => {
        const chatId = checkbox.dataset.chatId;
        const threadId = checkbox.dataset.threadId;
        
        if (!_tgSavedTopicRouting[chatId]) {
          _tgSavedTopicRouting[chatId] = {};
        }

        if (!_tgSavedTopicRouting[chatId][threadId]) {
          _tgSavedTopicRouting[chatId][threadId] = 'crew-lead';
          addedCount++;
        }
      });

      document.body.removeChild(modal);
      renderTgTopicsList();
      showNotification(`Added ${addedCount} new topic${addedCount !== 1 ? 's' : ''}! Set agents and click Save.`);
    };
  } catch (e) {
    showNotification('Error discovering topics: ' + e.message, true);
  }
}

export async function saveTgConfig() {
  const token = document.getElementById('tgTokenInput').value.trim();
  const idsRaw = document.getElementById('tgAllowedIds').value.trim();
  const allowedChatIds = idsRaw
    ? idsRaw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
    : [];
  if (!token) { showNotification('Enter a bot token first', true); return; }
  const contactNames = {};
  const userRouting = {};
  
  allowedChatIds.forEach(id => {
    // Contact name
    const nameEl = document.getElementById('tgContact-' + id);
    if (nameEl && nameEl.value.trim()) contactNames[String(id)] = nameEl.value.trim();
    
    // Per-user routing
    const routeEl = document.getElementById('tgRoute-' + id);
    if (routeEl && routeEl.value) {
      userRouting[String(id)] = routeEl.value;
    }
  });
  
  // Collect topic routing from in-memory state (already updated by delete/add)
  // Sync any edits from DOM inputs back to state (only update values, don't rebuild)
  const listDiv = document.getElementById('tgTopicsList');
  if (listDiv) {
    const groups = listDiv.querySelectorAll('.tg-topic-group');
    groups.forEach(groupContainer => {
      const chatIdInput = groupContainer.querySelector('[data-group-chat-id]');
      if (!chatIdInput) return;
      const originalChatId = chatIdInput.dataset.groupChatId;
      const newChatId = chatIdInput.value.trim();
      
      // If chatId changed, rename the key in state
      if (originalChatId && newChatId && originalChatId !== newChatId) {
        if (_tgSavedTopicRouting[originalChatId]) {
          _tgSavedTopicRouting[newChatId] = _tgSavedTopicRouting[originalChatId];
          delete _tgSavedTopicRouting[originalChatId];
        }
      }
      
      // Update topic IDs and agents from DOM (sync all visible rows)
      const targetChatId = newChatId || originalChatId;
      if (!targetChatId) return;
      
      // Make sure group exists in state
      if (!_tgSavedTopicRouting[targetChatId]) {
        _tgSavedTopicRouting[targetChatId] = {};
      }
      
      const rows = groupContainer.querySelectorAll('[data-chat-id]');
      rows.forEach(row => {
        const topicIdEl = row.querySelector('.tg-topic-id');
        const agentEl = row.querySelector('.tg-topic-agent');
        if (topicIdEl && agentEl) {
          const oldTopicId = row.dataset.originalTopicId || topicIdEl.value.trim();
          const newTopicId = topicIdEl.value.trim();
          const newAgent = agentEl.value;
          
          if (!newTopicId) return; // Skip empty topic IDs
          
          // If topic ID changed, update the key
          if (oldTopicId && newTopicId && oldTopicId !== newTopicId) {
            if (_tgSavedTopicRouting[targetChatId][oldTopicId]) {
              delete _tgSavedTopicRouting[targetChatId][oldTopicId];
            }
            _tgSavedTopicRouting[targetChatId][newTopicId] = newAgent;
          } else {
            // Update or create the agent mapping
            _tgSavedTopicRouting[targetChatId][newTopicId] = newAgent;
          }
        }
      });
    });
  }
  
  // Use the in-memory state (respects deletions)
  const topicRouting = { ..._tgSavedTopicRouting };
  
  // Also check JSON editor (advanced mode) if it has content
  const topicJsonEl = document.getElementById('tgTopicRoutingJson');
  if (topicJsonEl && topicJsonEl.value.trim()) {
    try {
      const jsonParsed = JSON.parse(topicJsonEl.value.trim());
      // Merge with form data (JSON takes precedence)
      Object.assign(topicRouting, jsonParsed);
    } catch (e) {
      // Ignore JSON parse errors if form data exists
      if (Object.keys(topicRouting).length === 0) {
        showNotification('Invalid topic routing JSON: ' + e.message, true);
        return;
      }
    }
  }
  
  _tgSavedContactNames = contactNames;
  _tgSavedUserRouting = userRouting;
  _tgSavedTopicRouting = topicRouting;
  
  await postJSON('/api/telegram/config', { token, targetAgent: 'crew-lead', allowedChatIds, contactNames, userRouting, topicRouting });
  showNotification('Telegram config saved');
  renderTgContactRows();
  renderTgTopicsList();
}

export async function startTgBridge() {
  const token = document.getElementById('tgTokenInput').value.trim();
  const body = { targetAgent: 'crew-lead' };
  if (token) body.token = token;
  const r = await postJSON('/api/telegram/start', body);
  if (r && r.error) { showNotification(r.error, true); return; }
  showNotification(r && r.message === 'Already running' ? 'Already running' : 'Telegram bridge starting...');
  setTimeout(loadTgStatus, 2000);
}

export async function stopTgBridge() {
  await postJSON('/api/telegram/stop', {});
  showNotification('Telegram bridge stopped');
  setTimeout(loadTgStatus, 1000);
}

export async function loadWaStatus() {
  try {
    const d = await getJSON('/api/whatsapp/status');
    const badge = document.getElementById('waStatusBadge');
    if (!badge) return;
    if (d.running) {
      badge.textContent = d.number ? '● +' + d.number : '● running';
      badge.className = 'status-badge status-active';
    } else {
      badge.textContent = '● stopped';
      badge.className = 'status-badge status-stopped';
    }
    const authEl = document.getElementById('waAuthStatus');
    if (authEl) {
      authEl.textContent = d.authSaved
        ? '✅ Auth saved — no QR scan needed on restart'
        : '⚠️ No auth saved — run npm run whatsapp in terminal to scan QR';
    }
  } catch {}
}

export function renderWaContactRows() {
  const listEl = document.getElementById('waContactNamesList');
  if (!listEl) return;
  const raw = (document.getElementById('waAllowedNumbers')?.value || '').trim();
  const numbers = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
  listEl.innerHTML = '';
  if (!numbers.length) return;
  const title = document.createElement('label');
  title.style.cssText = 'display:block;margin-bottom:6px;font-size:12px;color:var(--text-2);';
  title.textContent = 'Contact names (address book)';
  listEl.appendChild(title);
  numbers.forEach(num => {
    const key = num.replace(/\D/g, '');
    
    // Container for 2-line layout
    const container = document.createElement('div');
    container.style.cssText = 'margin-bottom:12px;padding:12px;background:var(--bg-1);border:1px solid var(--border);border-radius:6px;';
    
    // Line 1: Number + Name
    const row1 = document.createElement('div');
    row1.style.cssText = 'display:grid;grid-template-columns:140px 1fr;gap:8px;margin-bottom:8px;align-items:center;';
    
    const span = document.createElement('span');
    span.style.cssText = 'font-size:11px;color:var(--text-3);font-family:monospace;';
    span.textContent = num;
    
    const input = document.createElement('input');
    input.id = 'waContact-' + key;
    input.placeholder = 'Name (e.g. Jeff)';
    input.value = _waSavedContactNames[key] || _waSavedContactNames[num] || '';
    input.style.cssText = 'font-size:12px;padding:6px 8px;background:var(--bg-card);border:1px solid var(--border);border-radius:4px;color:var(--text-1);';
    
    row1.appendChild(span);
    row1.appendChild(input);
    
    // Line 2: Routing label + dropdown
    const row2 = document.createElement('div');
    row2.style.cssText = 'display:grid;grid-template-columns:140px 1fr;gap:8px;align-items:center;';
    
    const routeLabel = document.createElement('span');
    routeLabel.style.cssText = 'font-size:10px;color:var(--text-3);text-transform:uppercase;letter-spacing:0.05em;';
    routeLabel.textContent = 'Routes to →';
    
    const routeSelect = document.createElement('select');
    routeSelect.id = 'waRoute-' + key;
    routeSelect.style.cssText = 'font-size:12px;padding:6px 8px;background:var(--bg-card);border:1px solid var(--border);border-radius:4px;color:var(--text-1);';
    
    // Get current routing for this number (check multiple formats)
    const currentRoute = _waSavedUserRouting[num] || _waSavedUserRouting['+' + key] || _waSavedUserRouting[key] || '';
    
    const agents = [
      'crew-lead', 'crew-main', 'crew-coder', 'crew-pm', 'crew-qa', 
      'crew-fixer', 'crew-security', 'crew-frontend', 'crew-coder-front', 
      'crew-coder-back', 'crew-github', 'crew-copywriter', 'crew-researcher',
      'crew-architect', 'crew-seo', 'crew-ml', 'crew-mega', 'crew-loco'
    ];
    
    // Default option
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = '— default (see above) —';
    routeSelect.appendChild(defaultOpt);
    
    // Agent options
    agents.forEach(agent => {
      const opt = document.createElement('option');
      opt.value = agent;
      opt.textContent = agent;
      if (agent === currentRoute) opt.selected = true;
      routeSelect.appendChild(opt);
    });
    
    // Update state immediately when routing changes
    routeSelect.addEventListener('change', (e) => {
      const newAgent = e.target.value;
      if (newAgent) {
        _waSavedUserRouting[num] = newAgent;
      } else {
        delete _waSavedUserRouting[num];
      }
    });
    
    row2.appendChild(routeLabel);
    row2.appendChild(routeSelect);
    
    container.appendChild(row1);
    container.appendChild(row2);
    listEl.appendChild(container);
  });
}

export async function loadWaConfig() {
  try {
    const d = await getJSON('/api/whatsapp/config');
    const n = document.getElementById('waAllowedNumbers');
    const t = document.getElementById('waTargetAgent');
    _waSavedContactNames = d.contactNames || {};
    _waSavedUserRouting = d.userRouting || {};
    if (n) n.value = (d.allowedNumbers || []).join(', ');
    if (t) t.value = d.targetAgent || 'crew-lead';
    renderWaContactRows();
  } catch {}
}

export async function saveWaConfig() {
  const numbersRaw = document.getElementById('waAllowedNumbers').value.trim();
  const allowedNumbers = numbersRaw ? numbersRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const targetAgent = (document.getElementById('waTargetAgent').value.trim()) || 'crew-lead';
  const contactNames = {};
  const userRouting = {};
  
  allowedNumbers.forEach(num => {
    const key = num.replace(/\D/g, '');
    
    // Contact name
    const nameEl = document.getElementById('waContact-' + key);
    if (nameEl && nameEl.value.trim()) contactNames[key] = nameEl.value.trim();
    
    // Per-user routing
    const routeEl = document.getElementById('waRoute-' + key);
    if (routeEl && routeEl.value) {
      userRouting[num] = routeEl.value;
    }
  });
  
  _waSavedContactNames = contactNames;
  _waSavedUserRouting = userRouting;
  
  await postJSON('/api/whatsapp/config', { allowedNumbers, targetAgent, contactNames, userRouting });
  showNotification('WhatsApp config saved');
  renderWaContactRows();
}

export async function startWaBridge() {
  const r = await postJSON('/api/whatsapp/start', {});
  if (r && r.error) { showNotification(r.error, true); return; }
  showNotification(r && r.message === 'Already running' ? 'Already running' : 'WhatsApp bridge starting…');
  setTimeout(loadWaStatus, 2000);
}

export async function stopWaBridge() {
  await postJSON('/api/whatsapp/stop', {});
  showNotification('WhatsApp bridge stopped');
  setTimeout(loadWaStatus, 1000);
}

export async function loadWaMessages() {
  const feed = document.getElementById('waMessageFeed');
  if (!feed) return;
  try {
    const msgs = await getJSON('/api/whatsapp/messages');
    if (!msgs.length) {
      feed.innerHTML = '<div class="meta" style="padding:20px;text-align:center;">No messages yet. Send a WhatsApp message to your linked number.</div>';
      return;
    }
    feed.innerHTML = msgs.slice(-50).reverse().map(m => {
      const isIn = m.direction === 'inbound';
      const time = m.ts ? new Date(m.ts).toLocaleTimeString() : '';
      const number = (m.jid || '').split('@')[0] || '';
      return '<div style="display:flex;gap:10px;padding:8px;background:var(--bg-2);border-radius:6px;align-items:flex-start;">' +
        '<span style="font-size:18px;">' + (isIn ? '📲' : '🤖') + '</span>' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-size:11px;color:var(--text-3);margin-bottom:2px;">' +
            escHtml(isIn ? ('+' + number) : 'crewswarm') + (time ? ' · ' + time : '') +
          '</div>' +
          '<div style="font-size:13px;word-break:break-word;">' + escHtml((m.text || '').slice(0, 300)) + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch {
    feed.innerHTML = '<div style="color:var(--text-3);font-size:12px;padding:8px;">Could not load messages.</div>';
  }
}

export async function loadTgMessages() {
  const feed = document.getElementById('tgMessageFeed');
  if (!feed) return;
  try {
    const msgs = await getJSON('/api/telegram/messages');
    if (!msgs.length) {
      feed.innerHTML = '<div class="meta" style="padding:20px;text-align:center;">No messages yet. Send something to your bot on Telegram.</div>';
      return;
    }
    feed.innerHTML = msgs.slice(-50).reverse().map(m => {
      const isIn = m.direction === 'inbound';
      const time = m.ts ? new Date(m.ts).toLocaleTimeString() : '';
      const who = isIn ? (m.firstName || m.username || 'User') : 'crewswarm';
      const icon = isIn ? '👤' : '⚡';
      return '<div class="card" style="padding:12px;gap:4px;display:flex;flex-direction:column;">' +
        '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-3);">' +
        '<span>' + icon + ' ' + escHtml(who) + (m.username ? ' @' + escHtml(m.username) : '') + '</span>' +
        '<span>' + time + '</span></div>' +
        '<div style="font-size:13px;white-space:pre-wrap;">' + escHtml(m.text || '') + '</div>' +
        '</div>';
    }).join('');
  } catch {
    feed.innerHTML = '<div class="meta" style="padding:20px;color:var(--red-hi);">Error loading messages</div>';
  }
}

export async function loadTelegramSessions() {
  const box = document.getElementById('tgSessionsList');
  if (!box) return;
  const sessions = await getJSON('/api/telegram-sessions').catch(() => []);
  box.innerHTML = '';
  if (!sessions.length) {
    box.innerHTML = '<div style="color:var(--text-3);font-size:12px;padding:8px;">No Telegram sessions yet — send a message to your bot to start one.</div>';
    return;
  }
  for (const s of sessions) {
    const card = document.createElement('div');
    card.style.cssText = 'background:var(--bg-1);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:10px;';
    const ago = s.lastTs ? Math.round((Date.now() - s.lastTs) / 60000) + 'm ago' : 'unknown';
    const msgLines = s.messages.slice(-6).map(m => {
      const color = m.role === 'user' ? 'var(--accent)' : 'var(--green)';
      const icon = m.role === 'user' ? '👤' : '🤖';
      const txt = String(m.content || '').slice(0, 100).replace(/</g, '&lt;');
      return '<div style="margin-bottom:4px;"><span style="color:' + color + ';">' + icon + '</span> <span>' + txt + '</span></div>';
    }).join('');
    card.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
        '<span style="font-size:13px;font-weight:600;">chat ' + s.chatId + '</span>' +
        '<span style="font-size:11px;color:var(--text-3);">' + s.messageCount + ' msgs · ' + ago + '</span>' +
      '</div>' +
      '<div style="font-size:12px;color:var(--text-2);border-top:1px solid var(--border);padding-top:8px;max-height:120px;overflow-y:auto;">' +
        msgLines +
      '</div>';
    box.appendChild(card);
  }
}
