import { taskManager } from '../core/task-manager.js';

export function initChatActions(deps) {
  const {
    postJSON,
    getJSON,
    appendChatBubble,
    showNotification,
    state,
    getChatSessionId,
    getChatActiveProjectId,
    getCrewLeadInfo,
    appendRoadmapCard,
    getLastAppendedAssistantContent,
    setLastAppendedAssistantContent,
    setLastAppendedUserContent,
    setLastSentContent,
  } = deps;

  const PASSTHROUGH_LOG_KEY = 'crewswarm_passthrough_log';
  const PASSTHROUGH_LOG_MAX = 200;
  const ATAT_COMMANDS = [
    { id: 'RESET', label: 'Clear session history and start fresh', template: '' },
    { id: 'STOP', label: 'Cancel all running pipelines (agents keep running)', template: '' },
    { id: 'KILL', label: 'Kill all pipelines + terminate all agent bridges', template: '' },
    { id: 'SEARCH_HISTORY', label: 'Search long-term chat history by keyword', template: 'your search terms' },
    { id: 'DISPATCH', label: 'Dispatch task to an agent', template: '{"agent":"crew-coder","task":"Your task here"}' },
    { id: 'PIPELINE', label: 'Multi-step pipeline (waves of agents)', template: '[{"wave":1,"agent":"crew-coder","task":"..."},{"wave":2,"agent":"crew-qa","task":"..."}]' },
    { id: 'PROMPT', label: 'Append or set agent system prompt', template: '{"agent":"crew-lead","append":"Your new rule here"}' },
    { id: 'SKILL', label: 'Run a skill by name', template: 'skillName {"param":"value"}' },
    { id: 'SERVICE', label: 'Restart/stop a service or agent', template: 'restart crew-coder' },
    { id: 'READ_FILE', label: 'Read a file and get its contents', template: '/path/to/file' },
    { id: 'RUN_CMD', label: 'Run a shell command', template: 'ls -la /Users/jeffhobbs/Desktop/CrewSwarm' },
    { id: 'WEB_SEARCH', label: 'Search the web (Perplexity)', template: 'your search query' },
    { id: 'WEB_FETCH', label: 'Fetch a webpage or URL', template: 'https://example.com' },
    { id: 'PROJECT', label: 'Draft a new project roadmap', template: '{"name":"MyApp","description":"...","outputDir":"/path/to/dir"}' },
    { id: 'BRAIN', label: 'Append a fact to brain.md', template: 'crew-lead: fact to remember' },
    { id: 'TOOLS', label: 'Grant/revoke tools for an agent', template: '{"agent":"crew-qa","allow":["read_file","write_file"]}' },
    { id: 'CREATE_AGENT', label: 'Create a dynamic agent', template: '{"id":"crew-ml","role":"coder","description":"ML specialist"}' },
    { id: 'REMOVE_AGENT', label: 'Remove a dynamic agent', template: 'crew-ml' },
    { id: 'DEFINE_SKILL', label: 'Define a new skill (then @@END_SKILL)', template: 'skillName\\n{"description":"...","url":"..."}' },
    { id: 'DEFINE_WORKFLOW', label: 'Save a workflow for cron', template: 'name\\n[{"agent":"crew-copywriter","task":"..."}]' },
  ];

  async function loadChatHistory() {
    try {
      const d = await getJSON('/api/crew-lead/history?sessionId=' + encodeURIComponent(getChatSessionId()));
      const box = document.getElementById('chatMessages');
      
      // Clear and reset state
      box.innerHTML = '';
      setLastAppendedAssistantContent('');
      setLastAppendedUserContent('');
      
      // Load crew-lead history if available
      if (d.history && d.history.length) {
        d.history.forEach((h) => {
          appendChatBubble(h.role === 'user' ? 'user' : 'assistant', h.content);
          if (h.role === 'assistant') setLastAppendedAssistantContent(h.content);
          if (h.role === 'user') setLastAppendedUserContent(h.content);
        });
      }
      
      // Always append passthrough logs (CLI interactions) after crew-lead history
      const passthroughLog = JSON.parse(localStorage.getItem(PASSTHROUGH_LOG_KEY) || '[]');
      if (passthroughLog.length > 0) {
        appendPassthroughLogsToChat(passthroughLog);
      }
      
      box.scrollTop = box.scrollHeight;
    } catch (err) {
      console.warn('Failed to load chat history:', err);
      // Don't clear existing messages on error
    }
  }
  
  function appendPassthroughLogsToChat(log) {
    const box = document.getElementById('chatMessages');
    if (!box || !log.length) return;
    const engineLabels = { claude: 'Claude Code', cursor: 'Cursor CLI', opencode: 'OpenCode', codex: 'Codex CLI', gemini: 'Gemini CLI', 'gemini-cli': 'Gemini CLI', 'docker-sandbox': 'Docker Sandbox' };
    for (const entry of log) {
      if (entry.role === 'user') {
        appendChatBubble('user', entry.text);
      } else {
        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble assistant';
        bubble.style.cssText = 'background:var(--surface-2);border-radius:10px;padding:12px 14px;font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word;font-family:monospace;font-size:12px;color:var(--text-2);';
        const lbl = document.createElement('div');
        lbl.style.cssText = 'font-size:11px;font-weight:700;color:var(--text-3);margin-bottom:6px;';
        lbl.textContent = (engineLabels[entry.engine] || entry.engine) + ' · direct passthrough ✓ (exit ' + (entry.exitCode ?? 0) + ')';
        const cnt = document.createElement('div');
        cnt.textContent = entry.text;
        bubble.appendChild(lbl);
        bubble.appendChild(cnt);
        box.appendChild(bubble);
      }
    }
  }

  function chatAtAtInput() {
    const ta = document.getElementById('chatInput');
    const menu = document.getElementById('chatAtAtMenu');
    const hint = document.getElementById('chatAtAtTemplate');
    if (!ta || !menu || !hint) return;
    try {
      const val = ta.value;
      const caret = ta.selectionStart;
      const before = val.slice(0, caret);
      const lastAt = before.lastIndexOf('@@');
      if (lastAt === -1) { menu.style.display = 'none'; hint.style.display = 'none'; return; }
      const afterAt = before.slice(lastAt + 2);
      if (/\s/.test(afterAt)) { menu.style.display = 'none'; hint.style.display = 'none'; return; }
      const prefix = afterAt.toUpperCase();
      const filtered = ATAT_COMMANDS.filter((c) => c.id.indexOf(prefix) === 0);
      if (filtered.length === 0) { menu.style.display = 'none'; hint.style.display = 'none'; return; }
      menu.style.display = 'block';
      menu.style.visibility = 'visible';
      menu.innerHTML = '';
      filtered.forEach((c) => {
        const row = document.createElement('div');
        row.style.cssText = 'padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border);';
        row.onmouseenter = function onmouseenter() { row.style.background = 'var(--bg-hover)'; };
        row.onmouseleave = function onmouseleave() { row.style.background = ''; };
        row.innerHTML = '<span style="color:var(--accent);font-weight:600;">@@' + c.id + '</span> <span style="color:var(--text-3);">' + c.label + '</span>';
        row.onclick = function onclick() {
          const insert = '@@' + c.id + (c.template ? ' ' + c.template : '');
          ta.value = val.slice(0, lastAt) + insert + val.slice(caret);
          ta.selectionStart = ta.selectionEnd = lastAt + insert.length;
          ta.focus();
          menu.style.display = 'none';
          hint.style.display = 'block';
          hint.textContent = (c.id === 'PROMPT' ? 'Full line to send: @@PROMPT ' : 'Template: ') + (c.template ? c.template : '');
        };
        menu.appendChild(row);
      });
      const exact = filtered.find((c) => c.id === prefix);
      if (exact) {
        hint.style.display = 'block';
        hint.textContent = (exact.id === 'PROMPT' ? 'Full line: @@PROMPT ' : 'Template: ') + (exact.template || '');
      } else {
        hint.style.display = 'none';
      }
    } catch (err) {
      if (typeof console !== 'undefined') console.warn('chatAtAtInput', err);
    }
  }

  function chatKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
    const menu = document.getElementById('chatAtAtMenu');
    if (menu && menu.style.display === 'block' && (e.key === 'Escape' || e.key === 'Tab')) menu.style.display = 'none';
  }

  // Track active chat abort controller so we can cancel regular (non-passthrough) messages
  // DEPRECATED: Now using TaskManager for individual task control
  let _chatAbort = null;

  async function sendChat() {
    const input = document.getElementById('chatInput');
    const sendBtn = document.querySelector('[data-action="sendChat"]');
    const text = input.value.trim();
    if (!text) return;

    // If already sending, abort it (legacy single-task mode)
    if (_chatAbort) {
      _chatAbort.abort();
      _chatAbort = null;
      input.disabled = false;
      if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send';
        sendBtn.className = 'btn-green';
      }
      input.focus();
      return;
    }

    const engine = document.getElementById('passthroughEngine')?.value || '';
    if (engine) { await sendPassthrough(text, engine); return; }

    input.value = '';
    // DON'T disable input - allow concurrent messages
    // input.disabled = true;
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send';
      sendBtn.className = 'btn-green';
    }
    appendChatBubble('user', text);
    setLastAppendedUserContent(text);
    setLastSentContent(text);

    const typingId = 'typing-' + Date.now();
    const typingDiv = document.createElement('div');
    typingDiv.id = typingId;
    typingDiv.style.cssText = 'font-size:12px;color:var(--text-3);padding:4px 6px;';
    const cl = getCrewLeadInfo() || { emoji: '🧠', name: 'crew-lead' };
    typingDiv.textContent = cl.emoji + ' ' + cl.name + ' is thinking...';
    const box = document.getElementById('chatMessages');
    box.appendChild(typingDiv);
    box.scrollTop = box.scrollHeight;

    const controller = new AbortController();
    const taskId = 'chat-' + Date.now();
    
    // Register task with TaskManager
    taskManager.registerTask(taskId, {
      agent: 'crew-lead',
      type: 'chat',
      description: text.slice(0, 60) + (text.length > 60 ? '...' : ''),
      controller,
    });

    try {
      const d = await postJSON('/api/crew-lead/chat', {
        message: text,
        sessionId: getChatSessionId(),
        projectId: getChatActiveProjectId() || undefined,
      }, controller.signal);
      document.querySelectorAll('[id^="typing-"]').forEach((el) => el.remove());
      if (d.ok === false && d.error) {
        appendChatBubble('assistant', '⚠️ ' + d.error);
        setLastAppendedAssistantContent('');
        taskManager.failTask(taskId, d.error);
      } else if (d.reply) {
        const reply = d.reply;
        setTimeout(() => {
          if (reply !== getLastAppendedAssistantContent()) {
            appendChatBubble('assistant', reply);
            setLastAppendedAssistantContent(reply);
            if (box) box.scrollTop = box.scrollHeight;
          }
        }, 400);
        taskManager.completeTask(taskId);
      }
      if (d.dispatched) {
        const note = document.createElement('div');
        note.style.cssText = 'font-size:11px;color:var(--text-3);text-align:center;padding:4px;';
        note.textContent = '⚡ Dispatched to ' + d.dispatched.agent;
        box.appendChild(note);
      }
      if (d.pendingProject) appendRoadmapCard(box, d.pendingProject);
      box.scrollTop = box.scrollHeight;
    } catch (e) {
      document.querySelectorAll('[id^="typing-"]').forEach((el) => el.remove());
      if (e.name === 'AbortError') {
        appendChatBubble('assistant', '⚠️ Message cancelled');
        setLastAppendedAssistantContent('');
        taskManager.stopTask(taskId);
      } else {
        let errMsg = e.message || String(e);
        try {
          const parsed = JSON.parse(errMsg);
          if (parsed && typeof parsed.error === 'string') errMsg = parsed.error;
        } catch {}
        appendChatBubble('assistant', '⚠️ Error: ' + errMsg);
        setLastAppendedAssistantContent('');
        taskManager.failTask(taskId, errMsg);
      }
      box.scrollTop = box.scrollHeight;
    } finally {
      _chatAbort = null;
      // input.disabled = false; // Already enabled for concurrent mode
      if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send';
        sendBtn.className = 'btn-green';
      }
      input.focus();
    }
  }

  async function clearChatHistory() {
    if (!confirm('Clear chat history for this session?')) return;
    document.getElementById('chatMessages').innerHTML = '';
    localStorage.removeItem(PASSTHROUGH_LOG_KEY);
    await postJSON('/api/crew-lead/clear', { sessionId: getChatSessionId() }).catch(() => {});
  }

  function savePassthroughMsg(role, engine, text, exitCode) {
    try {
      const log = JSON.parse(localStorage.getItem(PASSTHROUGH_LOG_KEY) || '[]');
      log.push({ role, engine, text, exitCode, ts: Date.now() });
      if (log.length > PASSTHROUGH_LOG_MAX) log.splice(0, log.length - PASSTHROUGH_LOG_MAX);
      localStorage.setItem(PASSTHROUGH_LOG_KEY, JSON.stringify(log));
    } catch {}
  }

  function restorePassthroughLog() {
    try {
      const log = JSON.parse(localStorage.getItem(PASSTHROUGH_LOG_KEY) || '[]');
      if (!log.length) return;
      
      // Check if loadChatHistory is still pending - if so, don't append yet
      // (loadChatHistory will call appendPassthroughLogsToChat after it finishes)
      const box = document.getElementById('chatMessages');
      if (!box) return;
      
      // Only restore if box is empty or if we're in passthrough mode
      const engine = document.getElementById('passthroughEngine')?.value;
      if (engine && box.children.length === 0) {
        appendPassthroughLogsToChat(log);
        box.scrollTop = box.scrollHeight;
      }
    } catch {}
  }

  // Track active passthrough abort controller so the kill button can cancel it
  // DEPRECATED: Now using TaskManager for individual task control
  let _passthroughAbort = null;

  // Update the session indicator badge — shows green dot when a session exists for current engine+project
  // Backend keys: engine:projectDir:sessionScope (e.g. gemini:/path/to/crew-cli:owner)
  async function refreshSessionIndicator() {
    const indicator = document.getElementById('passthroughSessionIndicator');
    if (!indicator) return;
    const engine = document.getElementById('passthroughEngine')?.value;
    if (!engine) { indicator.style.display = 'none'; return; }
    const activeProjectId = getChatActiveProjectId();
    const activeProj = activeProjectId && state.projectsData[activeProjectId];
    const projectDir = activeProj?.outputDir || null;
    const sessionScope = getChatSessionId() || 'owner';
    try {
      const data = await getJSON('/api/passthrough-sessions');
      const sessions = data.sessions || {};
      // Backend uses engine:projectDir:sessionScope; when no project, backend falls back to config/cwd
      const key = projectDir ? `${engine}:${projectDir}:${sessionScope}` : null;
      // Also check legacy key format (engine:projectDir) for backward compat
      const hasSession = key && (sessions[key] || sessions[`${engine}:${projectDir}`]);
      indicator.style.display = hasSession ? 'inline-block' : 'none';
      indicator.title = hasSession
        ? `Session active for ${activeProj?.name || projectDir?.split('/').pop() || 'this project'} — click to clear`
        : '';
    } catch { indicator.style.display = 'none'; }
  }

  async function clearPassthroughSession() {
    const engine = document.getElementById('passthroughEngine')?.value;
    if (!engine) return;
    const activeProjectId = getChatActiveProjectId();
    const activeProj = activeProjectId && state.projectsData[activeProjectId];
    const projectDir = activeProj?.outputDir || null;
    if (!projectDir) return;
    const sessionScope = getChatSessionId() || 'owner';
    const key = `${engine}:${projectDir}:${sessionScope}`;
    const legacyKey = `${engine}:${projectDir}`;
    try {
      // Try full key first (backend format), then legacy
      await fetch(`/api/passthrough-sessions?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
      await fetch(`/api/passthrough-sessions?key=${encodeURIComponent(legacyKey)}`, { method: 'DELETE' });
      showNotification('Session cleared — next message starts fresh');
      refreshSessionIndicator();
    } catch (e) { showNotification('Failed: ' + e.message, true); }
  }

  // Helper to reset send button to default state
  function resetSendButton() {
    const sendBtn = document.querySelector('[data-action="sendChat"]');
    if (sendBtn) {
      sendBtn.textContent = 'Send';
      sendBtn.className = 'btn-green';
      sendBtn.disabled = false;
    }
  }

  async function sendPassthrough(text, engine) {
    const input = document.getElementById('chatInput');
    const sendBtn = document.querySelector('[data-action="sendChat"]');
    const stopBtn = document.querySelector('[data-action="stopPassthrough"]');
    const modelSelect = document.getElementById('passthroughModel');
    const engineLabels = { claude: 'Claude Code', cursor: 'Cursor CLI', opencode: 'OpenCode', codex: 'Codex CLI', gemini: 'Gemini CLI', 'gemini-cli': 'Gemini CLI', 'docker-sandbox': 'Docker Sandbox' };

    // Legacy single-task abort (kept for backward compatibility)
    if (_passthroughAbort) {
      _passthroughAbort.abort();
      _passthroughAbort = null;
      input.disabled = false;
      if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send';
        sendBtn.className = 'btn-green';
      }
      if (stopBtn) stopBtn.style.display = 'none';
      input.focus();
      return;
    }

    input.value = '';
    // DON'T disable input - allow concurrent operations
    // input.disabled = true;
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send';
      sendBtn.className = 'btn-green';
    }
    // Hide the separate kill button since we're using task manager
    if (stopBtn) { stopBtn.style.display = 'none'; }

    appendChatBubble('user', text);
    const box = document.getElementById('chatMessages');
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble assistant';
    bubble.style.cssText = 'background:var(--surface-2);border-radius:10px;padding:12px 14px;font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word;font-family:monospace;font-size:12px;color:var(--text-2);';
    const label = document.createElement('div');
    label.style.cssText = 'font-size:11px;font-weight:700;color:var(--text-3);margin-bottom:6px;';
    const activeProjectId = getChatActiveProjectId();
    const activeProj = activeProjectId && state.projectsData[activeProjectId];
    const selectedModel = modelSelect?.value || '';
    const modelLabel = selectedModel ? ` [${selectedModel}]` : '';
    label.textContent = (engineLabels[engine] || engine) + modelLabel + ' · direct passthrough' + (activeProj?.outputDir ? ' @ ' + activeProj.outputDir.split('/').pop() : '');
    const content = document.createElement('div');
    bubble.appendChild(label);
    bubble.appendChild(content);
    box.appendChild(bubble);
    box.scrollTop = box.scrollHeight;

    const controller = new AbortController();
    const taskId = 'passthrough-' + engine + '-' + Date.now();
    
    // Register task with TaskManager
    taskManager.registerTask(taskId, {
      agent: engineLabels[engine] || engine,
      type: 'passthrough',
      description: text.slice(0, 60) + (text.length > 60 ? '...' : ''),
      controller,
    });

    try {
      const projectDir = activeProj?.outputDir || undefined;
      const injectHistory = document.getElementById('passthroughInjectHistory')?.checked || false;
      const payload = { engine, message: text };
      if (projectDir) payload.projectDir = projectDir;
      payload.sessionId = getChatSessionId(); // Add session ID for proper isolation
      if (injectHistory) payload.injectHistory = true;
      if (selectedModel) payload.model = selectedModel;
      const resp = await fetch('/api/engine-passthrough', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!resp.ok) { 
        content.textContent = `Error ${resp.status}: ${await resp.text()}`;
        taskManager.failTask(taskId, `HTTP ${resp.status}`);
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.type === 'chunk' && ev.text) {
              content.textContent += ev.text;
              box.scrollTop = box.scrollHeight;
            } else if (ev.type === 'done') {
              const exitCode = ev.exitCode ?? 0;
              label.textContent += ` ✓ (exit ${exitCode})`;
              savePassthroughMsg('user', engine, text, null);
              savePassthroughMsg('engine', engine, content.textContent, exitCode);
              taskManager.completeTask(taskId);
            }
          } catch {}
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        label.textContent += ' ✗ (killed)';
        content.textContent += content.textContent ? '\n\n[stopped]' : '[stopped]';
        taskManager.stopTask(taskId);
      } else {
        content.textContent = 'Error: ' + e.message;
        taskManager.failTask(taskId, e.message);
      }
    } finally {
      _passthroughAbort = null;
      if (stopBtn) { stopBtn.style.display = 'none'; }
      // input.disabled = false; // Already enabled for concurrent mode
      if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send';
        sendBtn.className = 'btn-green';
      }
      input.focus();
      // Update session badge after run completes (Gemini/Codex may now have a session)
      refreshSessionIndicator();
    }
  }

  function killPassthrough() {
    if (_passthroughAbort) {
      _passthroughAbort.abort();
      _passthroughAbort = null;
    }
  }

  async function stopAll() {
    if (!confirm('Stop all running pipelines?')) return;
    try {
      await postJSON('/api/crew-lead/chat', { message: '@@STOP', sessionId: getChatSessionId() });
      showNotification('⏹ Stop signal sent');
    } catch (e) {
      showNotification('Failed: ' + e.message, true);
    }
  }

  async function killAll() {
    if (!confirm('Kill all agents? Bridges must be restarted after.')) return;
    try {
      await postJSON('/api/crew-lead/chat', { message: '@@KILL', sessionId: getChatSessionId() });
      showNotification('☠️ Kill signal sent');
    } catch (e) {
      showNotification('Failed: ' + e.message, true);
    }
  }

  return {
    loadChatHistory,
    chatAtAtInput,
    chatKeydown,
    sendChat,
    clearChatHistory,
    restorePassthroughLog,
    sendPassthrough,
    stopAll,
    killAll,
    killPassthrough,
    refreshSessionIndicator,
    clearPassthroughSession,
    resetSendButton, // Export for use in app.js
  };
}
