const vscode = acquireVsCodeApi();

const messagesContainer = document.getElementById('messages');
const messageInput = document.getElementById('message-input');
const sendButton = document.getElementById('send-btn');

sendButton.onclick = sendMessage;
messageInput.onkeypress = (e) => {
  if (e.key === 'Enter') {
    sendMessage();
  }
};

function sendMessage() {
  const text = messageInput.value.trim();
  if (text) {
    addMessage('user', text);
    vscode.postMessage({ command: 'sendMessage', text });
    messageInput.value = '';
  }
}

function addMessage(sender, text) {
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${sender}`;
  messageDiv.textContent = text;
  messagesContainer.appendChild(messageDiv);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

window.addEventListener('message', (event) => {
  const message = event.data;
  switch (message.command) {
    case 'addResponse':
      // Simple diff detection
      const diffMatch = message.response.match(/```(?:diff|diff\n)?([\s\S]*?)```/i);
      if (diffMatch) {
        const diff = diffMatch[1];
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message assistant';
        messageDiv.innerHTML = `
          <div>${message.response.replace(diffMatch[0], '')}</div>
          <pre class="diff">${diff}</pre>
          <button onclick="applyDiff('${diff.replace(/'/g, "\\'")}')">Apply Diff</button>
        `;
        messagesContainer.appendChild(messageDiv);
      } else {
        addMessage('assistant', message.response);
      }
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
      break;
  }
});

function applyDiff(diff) {
  vscode.postMessage({ command: 'applyDiff', diff });
}
