const vscode = acquireVsCodeApi();

const messagesContainer = document.getElementById('messages');
const messageInput = document.getElementById('message-input');
const sendButton = document.getElementById('send-btn');
const statusText = document.getElementById('status-text');
const statusIndicator = document.getElementById('status-indicator');
const modeText = document.getElementById('mode-text');
const contextChips = document.getElementById('context-chips');
const clearContextBtn = document.getElementById('clear-context');

let currentContext = null;
let isConnected = false;

// Initialize
function initialize() {
  // Auto-resize textarea
  messageInput.addEventListener('input', autoResize);
  
  sendButton.onclick = sendMessage;
  messageInput.onkeypress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };
  
  clearContextBtn.onclick = clearContext;
  
  // Notify extension that webview is ready
  vscode.postMessage({ command: 'ready' });
}

function autoResize() {
  this.style.height = 'auto';
  this.style.height = this.scrollHeight + 'px';
}

function sendMessage() {
  const text = messageInput.value.trim();
  if (!text) return;

  addMessage('user', text);
  
  const message = {
    command: 'sendMessage',
    text: text,
    context: currentContext
  };
  
  vscode.postMessage(message);
  messageInput.value = '';
  autoResize.call(messageInput);
}

function addMessage(sender, content, type = 'text') {
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${sender}`;
  
  if (type === 'text') {
    messageDiv.textContent = content;
  } else if (type === 'html') {
    messageDiv.innerHTML = content;
  } else if (type === 'structured') {
    // Handle structured response with actions
    messageDiv.innerHTML = formatStructuredResponse(content);
  }
  
  messagesContainer.appendChild(messageDiv);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function formatStructuredResponse(response) {
  let html = '';
  
  if (response.reply) {
    html += `<div class="response-text">${escapeHtml(response.reply)}</div>`;
  }
  
  // Handle patches
  if (response.patches && response.patches.length > 0) {
    html += '<div class="actions-section">';
    html += '<h4>Code Changes</h4>';
    response.patches.forEach(patch => {
      html += `
        <div class="patch-card">
          <div class="patch-header">
            <span class="patch-path">${escapeHtml(patch.path)}</span>
            <span class="patch-badge">${patch.unifiedDiff.split('\n').filter(l => l.startsWith('+')).length} additions</span>
          </div>
          <pre class="diff-preview">${escapeHtml(patch.unifiedDiff)}</pre>
          <button onclick="applyDiff('${escapeJs(patch.unifiedDiff)}')" class="btn-primary">Apply Diff</button>
        </div>
      `;
    });
    html += '</div>';
  }
  
  // Handle new files
  if (response.files && response.files.length > 0) {
    html += '<div class="actions-section">';
    html += '<h4>New Files</h4>';
    response.files.forEach(file => {
      html += `
        <div class="file-card">
          <div class="file-header">
            <span class="file-path">${escapeHtml(file.path)}</span>
            <span class="file-badge">New</span>
          </div>
          <button onclick="applyFile('${escapeJs(JSON.stringify(file))}')" class="btn-secondary">Create File</button>
        </div>
      `;
    });
    html += '</div>';
  }
  
  return html;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeJs(text) {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
}

function setStatus(connected) {
  isConnected = connected;
  statusIndicator.className = connected ? 'status-connected' : 'status-disconnected';
  statusText.textContent = connected ? 'Connected' : 'Disconnected';
}

function setContext(context) {
  currentContext = context;
  contextChips.style.display = context ? 'block' : 'none';
}

function clearContext() {
  currentContext = null;
  contextChips.style.display = 'none';
}

function setInitialMessage(text) {
  messageInput.value = text;
  autoResize.call(messageInput);
}

// Global functions for button onclick handlers
window.applyDiff = function(diff) {
  vscode.postMessage({ command: 'applyDiff', diff: diff });
};

window.applyFile = function(file) {
  const fileData = JSON.parse(file);
  vscode.postMessage({ command: 'applyFile', file: fileData });
};

// Handle messages from extension
window.addEventListener('message', (event) => {
  const message = event.data;
  
  switch (message.command) {
    case 'addResponse':
      handleResponse(message.response);
      break;
      
    case 'setInitialMessage':
      setInitialMessage(message.text);
      break;
      
    case 'setStatus':
      setStatus(message.connected);
      break;
  }
});

function handleResponse(response) {
  if (typeof response === 'string') {
    // Simple text response
    addMessage('assistant', response);
  } else if (response.reply || response.patches || response.files) {
    // Structured response
    addMessage('assistant', response, 'structured');
  } else {
    // Fallback
    addMessage('assistant', JSON.stringify(response, null, 2));
  }
  
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Initialize on load
initialize();
