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
      if (!d.history || !d.history.length) return;
      box.innerHTML = '';
      setLastAppendedAssistantContent('');
      setLastAppendedUserContent('');
      d.history.forEach((h) => {
        appendChatBubble(h.role === 'user' ? 'user' : 'assistant', h.content);
        if (h.role === 'assistant') setLastAppendedAssistantContent(h.content);
        if (h.role === 'user') setLastAppendedUserContent(h.content);
      });
      box.scrollTop = box.scrollHeight;
    } catch {}
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

  async function sendChat() {
    const input = document.getElementById('chatInput');
    const sendBtn = document.querySelector('[data-action="sendChat"]');
    const text = input.value.trim();
    if (!text) return;

    const engine = document.getElementById('passthroughEngine')?.value || '';
    if (engine) { await sendPassthrough(text, engine); return; }

    input.value = '';
    input.disabled = true;
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = 'Sending…'; }
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
    try {
      const d = await postJSON('/api/crew-lead/chat', {
        message: text,
        sessionId: getChatSessionId(),
        projectId: getChatActiveProjectId() || undefined,
      });
      document.querySelectorAll('[id^="typing-"]').forEach((el) => el.remove());
      if (d.ok === false && d.error) {
        appendChatBubble('assistant', '⚠️ ' + d.error);
        setLastAppendedAssistantContent('');
      } else if (d.reply) {
        const reply = d.reply;
        setTimeout(() => {
          if (reply !== getLastAppendedAssistantContent()) {
            appendChatBubble('assistant', reply);
            setLastAppendedAssistantContent(reply);
            if (box) box.scrollTop = box.scrollHeight;
          }
        }, 400);
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
      let errMsg = e.message || String(e);
      try {
        const parsed = JSON.parse(errMsg);
        if (parsed && typeof parsed.error === 'string') errMsg = parsed.error;
      } catch {}
      appendChatBubble('assistant', '⚠️ Error: ' + errMsg);
      setLastAppendedAssistantContent('');
      box.scrollTop = box.scrollHeight;
    } finally {
      input.disabled = false;
      if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send'; }
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
      const box = document.getElementById('chatMessages');
      if (!box || !log.length) return;
      const engineLabels = { claude: '🤖 Claude Code', cursor: '🖱 Cursor CLI', opencode: '⚡ OpenCode', codex: '🟣 Codex CLI', 'docker-sandbox': '🐳 Docker Sandbox' };
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
      box.scrollTop = box.scrollHeight;
    } catch {}
  }

  async function sendPassthrough(text, engine) {
    const input = document.getElementById('chatInput');
    const sendBtn = document.querySelector('[data-action="sendChat"]');
    const engineLabels = { claude: '🤖 Claude Code', cursor: '🖱 Cursor CLI', opencode: '⚡ OpenCode', codex: '🟣 Codex CLI', 'docker-sandbox': '🐳 Docker Sandbox' };
    input.value = '';
    input.disabled = true;
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '…'; }

    appendChatBubble('user', text);
    const box = document.getElementById('chatMessages');
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble assistant';
    bubble.style.cssText = 'background:var(--surface-2);border-radius:10px;padding:12px 14px;font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word;font-family:monospace;font-size:12px;color:var(--text-2);';
    const label = document.createElement('div');
    label.style.cssText = 'font-size:11px;font-weight:700;color:var(--text-3);margin-bottom:6px;';
    const activeProjectId = getChatActiveProjectId();
    const activeProj = activeProjectId && state.projectsData[activeProjectId];
    label.textContent = (engineLabels[engine] || engine) + ' · direct passthrough' + (activeProj?.outputDir ? ' @ ' + activeProj.outputDir.split('/').pop() : '');
    const content = document.createElement('div');
    bubble.appendChild(label);
    bubble.appendChild(content);
    box.appendChild(bubble);
    box.scrollTop = box.scrollHeight;

    try {
      const projectDir = activeProj?.outputDir || undefined;
      const injectHistory = document.getElementById('passthroughInjectHistory')?.checked || false;
      const resp = await fetch('/api/engine-passthrough', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ engine, message: text, ...(projectDir ? { projectDir } : {}), ...(injectHistory ? { injectHistory: true } : {}) }),
      });
      if (!resp.ok) { content.textContent = `Error ${resp.status}: ${await resp.text()}`; return; }

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
            }
          } catch {}
        }
      }
    } catch (e) {
      content.textContent = 'Error: ' + e.message;
    } finally {
      input.disabled = false;
      if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send'; }
      input.focus();
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
  };
}
