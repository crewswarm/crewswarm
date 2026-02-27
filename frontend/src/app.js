import { getJSON, postJSON } from './core/api.js';
import { escHtml, showNotification, fmt, createdAt, appendChatBubble, showLoading, showEmpty, showError, renderStatusBadge } from './core/dom.js';
import { sortAgents, state } from './core/state.js';
import { showBenchmarks as showBenchmarksTab, loadBenchmarks, loadBenchmarkLeaderboard, loadBenchmarkTasks, onBenchmarkTaskSelect, runBenchmarkTask, stopBenchmarkRun } from './tabs/benchmarks-tab.js';
import {
  initServicesTab,
  showServices,
  loadServices,
  restartService,
  stopService,
} from './tabs/services-tab.js';
import {
  initAgentsTab,
  showAgents,
  loadAgents_cfg,
  applyToolPreset,
  toggleAgentBody,
  deleteAgent,
  saveAgentModel,
  saveAgentFallback,
  toggleEmojiPicker,
  saveAgentIdentity,
  saveAgentPrompt,
  resetAgentSession,
  saveAgentTools,
  setRoute,
  saveOpenCodeConfig,
  saveOpenCodeFallback,
  saveCursorCliConfig,
  saveClaudeCodeConfig,
  bulkSetRoute,
  startCrew,
  populateModelDropdown,
} from './tabs/agents-tab.js';
import {
  showSkills,
  showRunSkills,
  loadRunSkills,
  runSkillFromUI,
  loadSkills,
  renderSkillsList,
  filterSkills,
  editSkill,
  toggleAddSkill,
  toggleImportSkill,
  importSkillFromUrl,
  cancelSkillForm,
  updateSkillAuthFields,
  saveSkill,
  deleteSkill,
} from './tabs/skills-tab.js';
import {
  loadEngines,
  deleteEngine,
  toggleImportEngine,
  importEngineFromUrl,
} from './tabs/engines-tab.js';
import { initChatActions } from './chat/chat-actions.js';
import {
  initSwarmTab,
  showSwarm,
  showRT,
  showDLQ,
  loadSessions,
  loadMessages,
  loadRTMessages,
  toggleRTPause,
  clearRTMessages,
  loadDLQ,
  replayDLQ,
  deleteDLQ,
} from './tabs/swarm-tab.js';
import {
  initModelsTab,
  initAddProviderForm,
  showModels,
  showProviders,
  loadSearchTools,
  saveSearchTool,
  testSearchTool,
  loadBuiltinProviders,
  saveBuiltinKey,
  testBuiltinProvider,
  fetchBuiltinModels,
  loadProviders,
  toggleKeyVis,
  saveKey,
  testKey,
  fetchModels,
} from './tabs/models-tab.js';
import {
  initSettingsTab,
  loadOpenClawStatus,
  loadRTToken,
  saveRTToken,
  loadOpencodeProject,
  saveOpencodeSettings,
  loadBgConsciousness,
  toggleBgConsciousness,
  saveBgConsciousnessModel,
  loadCursorWaves,
  toggleCursorWaves,
  loadClaudeCode,
  toggleClaudeCode,
  loadCodexExecutor,
  toggleCodexExecutor,
  loadGlobalFallback,
  saveGlobalFallback,
  loadGlobalOcLoop,
  saveGlobalOcLoop,
  saveGlobalOcLoopRounds,
  loadPassthroughNotify,
  savePassthroughNotify,
  loadLoopBrain,
  saveLoopBrain,
  loadEnvAdvanced,
} from './tabs/settings-tab.js';
import {
  initCommsTab,
  showMessaging,
  loadCommsTabData,
  loadTgStatus,
  loadTgConfig,
  saveTgConfig,
  startTgBridge,
  stopTgBridge,
  loadWaStatus,
  renderWaContactRows,
  loadWaConfig,
  saveWaConfig,
  startWaBridge,
  stopWaBridge,
  loadWaMessages,
  loadTgMessages,
  loadTelegramSessions,
} from './tabs/comms-tab.js';
import {
  showBuild as _showBuild,
  showProjects as _showProjects,
  loadProjects,
  toggleProjectEdit,
  saveProjectEdit,
  initProjectsList,
  populateChatProjectDropdown,
  onChatProjectChange,
  updateChatProjectHint,
  autoSelectChatProject,
  resumeProject,
  stopProjectPMLoop,
  startProjectPMLoop,
  deleteProject,
  openProjectInBuild as _openProjectInBuild,
  loadBuildProjectPicker,
  onBuildProjectChange,
  stopBuild,
  stopContinuousBuild,
  retryFailed,
  openRoadmapEditor,
  closeRoadmapEditor,
  saveRoadmap,
  addRoadmapItem,
  skipNextItem,
  resetAllFailed,
  loadPhasedProgress,
  runBuild,
  enhancePrompt,
  continuousBuildRun,
} from './tabs/projects-tab.js';


let selected = null;
let agents = [];
async function loadAgents() {
  try {
    agents = sortAgents(await getJSON('/api/agents'));
  } catch (e) { console.error('Failed to load agents:', e); }
}
async function refreshAll(){
  try {
    const dot = document.getElementById('statusDot');
    document.getElementById('status').textContent = 'online';
    dot.className = 'status-dot online';
    const dlqData = await getJSON('/api/dlq');
    const badge = document.getElementById('dlqBadge');
    if (dlqData.length) { badge.textContent = dlqData.length; badge.classList.remove('hidden'); }
    else { badge.classList.add('hidden'); }
    const active = document.querySelector('.view.active, .view-sessions.active');
    if (!active) return;
    if (active.id === 'dlqView') await loadDLQ();
    else if (active.id === 'rtView') await loadRTMessages();
    else if (active.id === 'sessionsView') { await loadSessions(); await loadMessages(); }
  } catch (e) {
    document.getElementById('status').textContent = 'error';
    document.getElementById('statusDot').className = 'status-dot error';
  }
}
function setNavActive(navId){
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  const el = document.getElementById(navId); if (el) el.classList.add('active');
}
function hideAllViews(){
  document.querySelectorAll('.view, .view-sessions').forEach(el => el.classList.remove('active'));
  const mb = document.querySelector('.msg-bar');
  if (mb) mb.style.display = '';
}

initServicesTab({ hideAllViews, setNavActive });
initAgentsTab({ hideAllViews, setNavActive, refreshAgents: loadAgents });
initSwarmTab({ hideAllViews, setNavActive });

async function pickFolder(inputId) {
  const input = document.getElementById(inputId);
  const def = encodeURIComponent(input?.value || window._crewHome || '');
  const d = await getJSON('/api/pick-folder?default=' + def).catch(() => null);
  if (d?.path) { if (input) input.value = d.path; }
}
async function loadCrewLeadInfo() {
  try {
    const d = await getJSON('/api/agents-config');
    const cl = (d.agents || []).find(a => a.id === 'crew-lead');
    if (!cl) return;
    window._crewLeadInfo = { emoji: cl.emoji || '🧠', name: cl.name || 'crew-lead', theme: cl.theme || '' };
    const titleEl = document.getElementById('chatAgentTitle');
    const subEl   = document.getElementById('chatAgentSub');
    if (titleEl) titleEl.textContent = (cl.emoji || '🧠') + ' ' + (cl.name || 'Crew Lead');
    if (subEl && cl.theme) subEl.textContent = cl.theme + ' — chat naturally, dispatch tasks to the crew';
  } catch(e) { /* keep defaults */ }
}

async function showChat(){
  hideAllViews();
  document.getElementById('chatView').classList.add('active');
  setNavActive('navChat');
  const mb = document.querySelector('.msg-bar');
  if (mb) mb.style.display = 'none';
  try { state.chatActiveProjectId = localStorage.getItem('crewswarm_chat_active_project_id') || ''; } catch { state.chatActiveProjectId = ''; }
  const sel = document.getElementById('chatProjectSelect');
  if (sel && state.chatActiveProjectId && sel.querySelector('option[value="' + state.chatActiveProjectId + '"]')) sel.value = state.chatActiveProjectId;
  checkCrewLeadStatus();
  startAgentReplyListener();
  loadCrewLeadInfo();
  await loadChatHistory();
  restorePassthroughLog();
}
function showFiles(){
  hideAllViews();
  document.getElementById('filesView').classList.add('active');
  setNavActive('navFiles');
  loadFiles();
}

// ── Chat / crew-lead ──────────────────────────────────────────────────────────
const chatSessionId = 'owner'; // shared with Telegram — one conversation, one memory
let chatPollInterval = null;
let agentReplySSE = null;

function startAgentReplyListener() {
  if (agentReplySSE) return; // already listening
  agentReplySSE = new EventSource('/api/crew-lead/events');
  agentReplySSE.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      const box = document.getElementById('chatMessages');
      if (d.type === 'draft_discarded' && d.draftId) {
        const el = document.querySelector('[data-draft-id="' + d.draftId + '"]');
        if (el) el.remove();
        return;
      }
      if (d.type === 'context_warning' && d.sessionId === chatSessionId) {
        const existing = document.getElementById('contextWarningBanner');
        if (existing) existing.remove();
        const banner = document.createElement('div');
        banner.id = 'contextWarningBanner';
        const isCritical = d.level === 'critical';
        banner.style.cssText = `display:flex;align-items:center;gap:10px;padding:8px 14px;border-radius:8px;margin:6px 0;font-size:12px;background:${isCritical ? 'rgba(239,68,68,0.1)' : 'rgba(245,158,11,0.1)'};border:1px solid ${isCritical ? 'rgba(239,68,68,0.3)' : 'rgba(245,158,11,0.3)'};color:${isCritical ? '#f87171' : '#f59e0b'};`;
        banner.innerHTML = `<span style="flex:1;">${d.message}</span><button onclick="clearChatHistory()" style="padding:2px 8px;font-size:11px;border-radius:4px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer;">Clear now</button><button onclick="this.parentElement.remove()" style="background:none;border:none;cursor:pointer;color:inherit;font-size:14px;padding:0 2px;">✕</button>`;
        const box = document.getElementById('chatMessages');
        if (box) { box.appendChild(banner); box.scrollTop = box.scrollHeight; }
        return;
      }
      if (d.type === 'chat_message' && d.sessionId === chatSessionId) {
        if (d.role === 'user') {
          if (d.content !== lastAppendedUserContent) {
            appendChatBubble('user', d.content);
            lastAppendedUserContent = d.content;
          }
          if (d.content === lastSentContent) lastSentContent = null;
        } else if (d.role === 'assistant') {
          document.querySelectorAll('[id^="typing-"]').forEach(el => el.remove());
          if (d.content !== lastAppendedAssistantContent) {
            appendChatBubble('assistant', d.content, d.fallbackModel, d.fallbackReason);
            lastAppendedAssistantContent = d.content;
          }
        }
        if (box) box.scrollTop = box.scrollHeight;
        return;
      }
      if (d.type === 'pending_project' && d.sessionId === chatSessionId && d.pendingProject && box) {
        appendRoadmapCard(box, d.pendingProject);
        box.scrollTop = box.scrollHeight;
        return;
      }
      // agent_working from OpenCode bridge — show pulsing coding dot on agent card
      if (d.type === 'agent_working' && d.agent) {
        const dot = document.getElementById('coding-dot-' + d.agent);
        if (dot) dot.style.display = 'inline-flex';
      }
      // agent_idle from OpenCode bridge — hide coding dot
      if (d.type === 'agent_idle' && d.agent) {
        const dot = document.getElementById('coding-dot-' + d.agent);
        if (dot) dot.style.display = 'none';
      }
      // OpenCode serve live events — tool calls, file edits, session boundaries
      if (d.type === 'opencode_event') {
        const feed = document.getElementById('ocFeed');
        const liveDot = document.getElementById('ocFeedDot');
        if (!feed) return;
        if (liveDot) liveDot.style.display = 'inline-block';
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 10px;border-radius:8px;background:var(--bg-2);font-size:12px;font-family:var(--font-mono,monospace);animation:fadeIn .25s ease;';
        const time = new Date(d.ts || Date.now()).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
        let icon = '⚙️', label = '';
        if (d.kind === 'session_start') { icon = '▶'; row.style.borderLeft = '3px solid var(--green-hi)'; var _sd = d.dir || ''; label = 'session started' + (_sd ? ' — ' + _sd.split('/').pop() : ''); }
        else if (d.kind === 'session_end') { icon = '■'; row.style.borderLeft = '3px solid var(--text-3)'; label = 'session ended'; if (liveDot) liveDot.style.display = 'none'; }
        else if (d.kind === 'file_edit') { icon = '✏️'; row.style.borderLeft = '3px solid var(--amber)'; label = (d.file || d.path || '') + (d.extra ? ' <span style="opacity:.5;">'+d.extra+'</span>' : ''); }
        else if (d.kind === 'error') { icon = '✗'; row.style.borderLeft = '3px solid var(--red-hi)'; row.style.color = 'var(--red-hi)'; label = d.message || 'error'; }
        else if (d.kind === 'tool') {
          const toolColors = { read_file:'var(--accent)', write_file:'var(--amber)', bash:'var(--purple)', list_directory:'var(--green)', grep:'var(--green)' };
          const tc = toolColors[d.tool] || 'var(--text-2)';
          icon = d.phase === 'done' ? '✓' : '→';
          row.style.borderLeft = '3px solid ' + tc;
          row.style.color = d.phase === 'done' ? 'var(--text-2)' : 'var(--text-1)';
          label = '<span style="color:' + tc + ';font-weight:600;">' + (d.tool || '') + '</span>' + (d.label ? ' <span style="opacity:.6;">' + d.label + '</span>' : '');
        }
        row.innerHTML = '<span style="opacity:.4;flex-shrink:0;">' + time + '</span>' +
          '<span style="flex-shrink:0;">' + icon + '</span>' +
          '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + label + '</span>';
        feed.appendChild(row);
        // Cap at 80 rows
        while (feed.children.length > 80) feed.removeChild(feed.firstChild);
        feed.scrollTop = feed.scrollHeight;
        return;
      }
      // agent_working: crew-lead dispatched a task — show a "waiting" indicator
      if (d.type === 'agent_working' && d.agent) {
        const spinnerId = 'agent-spinner-' + (d.taskId || d.agent);
        if (box && !document.getElementById(spinnerId)) {
          const el = document.createElement('div');
          el.id = spinnerId;
          el.className = 'msg a';
          el.style.cssText = 'opacity:.7; font-style:italic;';
          el.innerHTML = '<div class="meta"><strong>' + d.agent + '</strong> · working…</div>' +
            '<div class="t" style="display:flex;align-items:center;gap:8px;">' +
            '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--accent);animation:pulse 1s ease-in-out infinite;"></span>' +
            'Processing task…</div>';
          box.appendChild(el);
          box.scrollTop = box.scrollHeight;
        }
        return;
      }
      // agent_reply: task completion from any crew member — replace spinner, show reply, notify
      if (d.type === 'agent_reply' || (d.from && d.content)) {
        if (!d.from || !d.content) return;
        const spinnerId = 'agent-spinner-' + (d.taskId || d.from);
        const spinnerEl = document.getElementById(spinnerId);
        if (spinnerEl) spinnerEl.remove();
        const agentSpinner = document.getElementById('agent-spinner-' + d.from);
        if (agentSpinner) agentSpinner.remove();
        appendChatBubble('🤖 ' + d.from, d.content, false);
        if (box) box.scrollTop = box.scrollHeight;
        showNotification(d.from + ' finished a task');
        return;
      }
      // task.timeout: dispatch never claimed or timed out — replace spinner with "No reply" message
      if (d.type === 'task.timeout' && d.agent) {
        const spinnerId = 'agent-spinner-' + (d.taskId || d.agent);
        const spinnerEl = document.getElementById(spinnerId);
        if (spinnerEl) spinnerEl.remove();
        const agentSpinner = document.getElementById('agent-spinner-' + d.agent);
        if (agentSpinner) agentSpinner.remove();
        const msg = '[crew-lead] Task to ' + d.agent + ' timed out (no reply in 90s). Consider @@SERVICE restart ' + d.agent + ' or re-dispatch to another agent.';
        if (box) {
          const el = document.createElement('div');
          el.className = 'msg a';
          el.style.cssText = 'opacity:.85; font-style:italic; color:var(--text-3);';
          el.innerHTML = '<div class="meta"><strong>' + d.agent + '</strong> · no reply</div><div class="t">' + escHtml(msg) + '</div>';
          box.appendChild(el);
          box.scrollTop = box.scrollHeight;
        }
        showNotification('Task to ' + d.agent + ' timed out');
        return;
      }
      // pipeline_progress: a wave or step dispatched
      if (d.type === 'pipeline_progress') {
        let label;
        if (d.agents) {
          label = 'Wave ' + (d.waveIndex + 1) + '/' + d.totalWaves + ' → ' + d.agents.join(' + ');
        } else {
          label = 'Step ' + (d.stepIndex + 1) + '/' + d.total + ' → ' + d.agent;
        }
        const el = document.createElement('div');
        el.style.cssText = 'font-size:11px;color:var(--text-3);padding:2px 8px;margin:2px 0;';
        el.textContent = '↳ ' + label;
        if (box) { box.appendChild(el); box.scrollTop = box.scrollHeight; }
        return;
      }
      // pipeline_quality_gate: wave had issues
      if (d.type === 'pipeline_quality_gate') {
        const el = document.createElement('div');
        const retryNote = d.willRetry ? ' — retrying wave' : ' — advancing anyway';
        el.style.cssText = 'font-size:11px;color:var(--warning, #e8a030);padding:2px 8px;margin:2px 0;';
        el.textContent = '⚠️ Wave ' + (d.waveIndex + 1) + ' quality gate: ' + (d.issues || []).join('; ') + retryNote;
        if (box) { box.appendChild(el); box.scrollTop = box.scrollHeight; }
        return;
      }
      // project_launched: new project registered — reload dropdown and auto-select
      if (d.type === 'project_launched' && d.project) {
        const newId = d.project.projectId || d.project.id;
        setTimeout(async () => {
          await loadProjects();
          if (newId) autoSelectChatProject(newId);
          const box = document.getElementById('chatMessages');
          if (box) {
            const el = document.createElement('div');
            el.style.cssText = 'font-size:11px;color:var(--green);padding:2px 8px;margin:2px 0;';
            el.textContent = '📁 Project "' + (d.project.name || newId) + '" registered — selected in chat';
            box.appendChild(el);
            box.scrollTop = box.scrollHeight;
          }
        }, 800);
        return;
      }
      // pipeline_done: all steps complete
      if (d.type === 'pipeline_done') {
        const el = document.createElement('div');
        el.style.cssText = 'font-size:11px;color:var(--green);padding:2px 8px;margin:2px 0;';
        el.textContent = '✅ Pipeline complete';
        if (box) { box.appendChild(el); box.scrollTop = box.scrollHeight; }
        return;
      }
      // confirm_run_cmd: an agent wants to run a shell command — show approval toast
      if (d.type === 'confirm_run_cmd' && d.approvalId) {
        showCmdApprovalToast(d.approvalId, d.agent, d.cmd);
        return;
      }
      // telemetry: task.lifecycle (schema 1.1) — keep list and refresh Task lifecycle panel if visible
      if (d.type === 'telemetry' && d.payload) {
        window._telemetryEvents = window._telemetryEvents || [];
        window._telemetryEvents.push(d.payload);
        if (window._telemetryEvents.length > 100) window._telemetryEvents.shift();
        const tlView = document.getElementById('toolMatrixView');
        if (tlView && tlView.classList.contains('active')) renderTaskLifecycle(window._telemetryEvents);
      }
    } catch {}
  };
  agentReplySSE.onopen = () => { window._sseReconnectDelay = 2000; };
  agentReplySSE.onerror = () => {
    agentReplySSE.close();
    agentReplySSE = null;
    // Reconnect with exponential backoff (2s → 4s → 8s → 30s max)
    if (window._sseReconnectTimer) clearTimeout(window._sseReconnectTimer);
    window._sseReconnectTimer = setTimeout(() => {
      window._sseReconnectTimer = null;
      window._sseReconnectDelay = Math.min((window._sseReconnectDelay || 2000) * 2, 30000);
      startAgentReplyListener();
    }, window._sseReconnectDelay || 2000);
  };
}

// ── Command approval toast ────────────────────────────────────────────────────

function showCmdApprovalToast(approvalId, agent, cmd) {
  const existing = document.getElementById('cmd-approval-' + approvalId);
  if (existing) return;

  const toast = document.createElement('div');
  toast.id = 'cmd-approval-' + approvalId;
  toast.style.cssText = [
    'position:fixed;bottom:80px;right:24px;z-index:9999;',
    'background:var(--bg-card);border:1px solid var(--border);border-radius:12px;',
    'padding:16px 20px;max-width:440px;box-shadow:0 8px 32px rgba(0,0,0,.4);',
    'display:flex;flex-direction:column;gap:10px;',
  ].join('');

  const header = document.createElement('div');
  header.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-1);';
  header.textContent = '🔐 ' + agent + ' wants to run a command';

  const cmdEl = document.createElement('code');
  cmdEl.style.cssText = 'display:block;font-size:12px;color:var(--accent);background:var(--bg-1);padding:6px 10px;border-radius:6px;word-break:break-all;';
  cmdEl.textContent = cmd;

  // "Always allow" toggle — infers pattern from first word of command
  const alwaysRow = document.createElement('label');
  alwaysRow.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-2);cursor:pointer;';
  const alwaysChk = document.createElement('input');
  alwaysChk.type = 'checkbox';
  alwaysChk.style.cssText = 'width:14px;height:14px;cursor:pointer;accent-color:var(--green);';
  const cmdBase = cmd.trim().split(/\s+/)[0];
  const suggestedPattern = cmdBase + ' *';
  alwaysRow.appendChild(alwaysChk);
  alwaysRow.appendChild(document.createTextNode('Always allow  '));
  const patternSpan = document.createElement('code');
  patternSpan.style.cssText = 'font-size:11px;background:var(--bg-1);padding:2px 6px;border-radius:4px;color:var(--accent);';
  patternSpan.textContent = suggestedPattern;
  alwaysRow.appendChild(patternSpan);

  const timer = document.createElement('div');
  timer.style.cssText = 'font-size:11px;color:var(--text-3);';
  let secs = 60;
  timer.textContent = 'Auto-reject in ' + secs + 's';
  const countdown = setInterval(() => {
    secs--;
    timer.textContent = 'Auto-reject in ' + secs + 's';
    if (secs <= 0) { clearInterval(countdown); toast.remove(); }
  }, 1000);

  const btns = document.createElement('div');
  btns.style.cssText = 'display:flex;gap:8px;';

  const approve = document.createElement('button');
  approve.textContent = '✅ Allow';
  approve.style.cssText = 'flex:1;padding:8px;border-radius:8px;border:none;background:var(--green);color:#fff;cursor:pointer;font-weight:600;font-size:13px;';
  approve.onclick = async () => {
    clearInterval(countdown);
    toast.remove();
    if (alwaysChk.checked) {
      await fetch('/api/cmd-allowlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pattern: suggestedPattern }) });
      showNotification('Allowlisted: ' + suggestedPattern);
    }
    await fetch('/api/cmd-approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvalId }) }).catch(e => showNotification('Approve failed: ' + e.message, true));
    if (!alwaysChk.checked) showNotification(agent + ': command approved');
  };

  const reject = document.createElement('button');
  reject.textContent = '⛔ Deny';
  reject.style.cssText = 'flex:1;padding:8px;border-radius:8px;border:none;background:var(--red-hi);color:#fff;cursor:pointer;font-weight:600;font-size:13px;';
  reject.onclick = async () => {
    clearInterval(countdown);
    toast.remove();
    await fetch('/api/cmd-reject', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvalId }) }).catch(e => showNotification('Reject failed: ' + e.message, true));
    showNotification(agent + ': command denied');
  };

  btns.appendChild(approve);
  btns.appendChild(reject);
  toast.appendChild(header);
  toast.appendChild(cmdEl);
  toast.appendChild(alwaysRow);
  toast.appendChild(timer);
  toast.appendChild(btns);
  document.body.appendChild(toast);
}

// ── Cmd allowlist manager ──────────────────────────────────────────────────────

const CMD_PRESETS = [
  { label: 'npm',    pattern: 'npm *',        desc: 'install, run, build, test…' },
  { label: 'node',   pattern: 'node *',        desc: 'run any node script' },
  { label: 'python', pattern: 'python *',      desc: 'python / python3 scripts' },
  { label: 'pip',    pattern: 'pip *',         desc: 'pip install packages' },
  { label: 'git',    pattern: 'git *',         desc: 'all git operations' },
  { label: 'cursor', pattern: 'cursor *',      desc: 'open files in Cursor' },
  { label: 'make',   pattern: 'make *',        desc: 'Makefile targets' },
  { label: 'yarn',   pattern: 'yarn *',        desc: 'yarn install / build / run' },
  { label: 'pnpm',   pattern: 'pnpm *',        desc: 'pnpm package manager' },
  { label: 'ls / cat / echo', pattern: 'ls *', desc: 'read-only shell utilities' },
];

async function loadCmdAllowlist() {
  const box = document.getElementById('cmdAllowlistItems');
  const presetsBox = document.getElementById('cmdPresets');
  if (!box) return;

  const d = await getJSON('/api/cmd-allowlist').catch(() => ({ list: [] }));
  const list = d.list || [];

  // Render presets checklist (only when the presets container exists — Settings view)
  if (presetsBox) {
    presetsBox.innerHTML = '';
    CMD_PRESETS.forEach(function(preset) {
      const checked = list.includes(preset.pattern);
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;padding:4px 6px;border-radius:6px;transition:background 0.1s;';
      row.onmouseover = function(){ row.style.background = 'var(--bg-hover)'; };
      row.onmouseout  = function(){ row.style.background = ''; };

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = checked;
      chk.style.cssText = 'width:14px;height:14px;cursor:pointer;accent-color:var(--green);flex-shrink:0;';
      chk.onchange = async function() {
        if (chk.checked) {
          await fetch('/api/cmd-allowlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pattern: preset.pattern }) })
            .catch(e => showNotification('Failed to add pattern: ' + e.message, true));
        } else {
          await fetch('/api/cmd-allowlist', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pattern: preset.pattern }) })
            .catch(e => showNotification('Failed to remove pattern: ' + e.message, true));
        }
        loadCmdAllowlist();
      };

      const nameEl = document.createElement('code');
      nameEl.style.cssText = 'font-size:12px;color:var(--accent);min-width:90px;';
      nameEl.textContent = preset.pattern;

      const descEl = document.createElement('span');
      descEl.style.cssText = 'font-size:11px;color:var(--text-3);';
      descEl.textContent = preset.desc;

      row.appendChild(chk);
      row.appendChild(nameEl);
      row.appendChild(descEl);
      presetsBox.appendChild(row);
    });
  }

  // Render active list (non-preset patterns only, or all if no presets box)
  const presetPatterns = new Set(CMD_PRESETS.map(function(p){ return p.pattern; }));
  const customPatterns = presetsBox ? list.filter(function(p){ return !presetPatterns.has(p); }) : list;

  box.innerHTML = '';
  if (!customPatterns.length) {
    box.innerHTML = '<div style="color:var(--text-3);font-size:12px;padding:4px 0;">' + (presetsBox ? 'No custom patterns yet.' : 'No patterns yet.') + '</div>';
    return;
  }
  for (const pattern of customPatterns) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);';
    const code = document.createElement('code');
    code.style.cssText = 'flex:1;font-size:12px;color:var(--accent);';
    code.textContent = pattern;
    const del = document.createElement('button');
    del.textContent = '✕';
    del.style.cssText = 'border:none;background:transparent;color:var(--text-3);cursor:pointer;font-size:14px;padding:0 4px;';
    del.title = 'Remove';
    del.onclick = async function() {
      await fetch('/api/cmd-allowlist', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pattern }) })
        .catch(e => showNotification('Failed to delete pattern: ' + e.message, true));
      loadCmdAllowlist();
    };
    row.appendChild(code);
    row.appendChild(del);
    box.appendChild(row);
  }
}

async function addAllowlistPattern() {
  const inp = document.getElementById('cmdAllowlistInput');
  const pattern = inp ? inp.value.trim() : '';
  if (!pattern) return;
  await fetch('/api/cmd-allowlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pattern }) })
    .catch(e => showNotification('Failed to add pattern: ' + e.message, true));
  inp.value = '';
  loadCmdAllowlist();
}

// ── Token usage widget ────────────────────────────────────────────────────────

// Approximate cost per 1M tokens by model prefix (input / output)
// Keys matched via .includes() — more specific keys must come before general ones
const MODEL_COST_PER_M = {
  // ── xAI Grok (2026 pricing) ───────────────────────────────────────────────
  'grok-4-1-fast':         [0.20,  0.50],  // grok-4.1-fast + non-reasoning variant
  'grok-4-fast':           [0.20,  0.50],
  'grok-4':                [3.00, 15.00],
  'grok-3-mini':           [0.30,  0.50],
  'grok-3':                [3.00, 15.00],
  'grok-code-fast':        [0.20,  1.50],
  'grok-beta':             [5.00, 15.00],  // legacy
  // ── OpenAI gpt-5.x (via openai or openai-local proxy) ───────────────────
  'gpt-5.3-codex':         [2.50, 20.00],  // estimate — newer than 5.2
  'gpt-5.2-codex':         [1.75, 14.00],
  'gpt-5.2':               [1.75, 14.00],
  'gpt-5.1-codex-max':     [2.50, 20.00],  // estimate — max tier
  'gpt-5.1-codex-mini':    [0.25,  2.00],
  'gpt-5.1-codex':         [1.25, 10.00],
  'gpt-5.1':               [1.25, 10.00],
  'gpt-5-codex':           [1.25, 10.00],
  'gpt-5-nano':            [0.15,  0.60],  // estimate
  'gpt-5':                 [1.25, 10.00],
  'codex-mini':            [0.25,  2.00],
  // ── OpenAI legacy ────────────────────────────────────────────────────────
  'gpt-oss-120b':          [0.90,  0.90],  // Groq-hosted OSS model, estimate
  'gpt-oss-20b':           [0.20,  0.20],  // estimate
  'gpt-4o-mini':           [0.15,  0.60],
  'gpt-4o':                [2.50, 10.00],
  'gpt-4':                 [30.0, 60.00],
  // ── DeepSeek ─────────────────────────────────────────────────────────────
  'deepseek-reasoner':     [0.70,  2.50],  // R1
  'deepseek-chat':         [0.27,  1.10],
  // ── Mistral ──────────────────────────────────────────────────────────────
  'mistral-large':         [0.50,  1.50],  // mistral-large-latest = Large 3 2512 (Dec 2025)
  'mistral-small':         [0.10,  0.30],
  // ── Google Gemini 3 (preview, 2026) ──────────────────────────────────────
  'gemini-3.1-pro':        [2.50, 15.00],  // 3.1 Pro preview
  'gemini-3.1-flash':      [0.075, 0.30],  // 3.1 Flash preview
  'gemini-3-pro':          [2.50, 15.00],  // Gemini 3 Pro preview
  'gemini-3-flash':        [0.075, 0.30],  // Gemini 3 Flash preview
  // ── Google Gemini 2.5 ────────────────────────────────────────────────────
  'gemini-2.5-pro':        [1.25, 10.00],
  'gemini-2.5-flash-lite': [0.04,  0.15],  // Flash Lite (lower cost)
  'gemini-2.5-flash':      [0.075, 0.30],
  'gemini-2.0-flash-lite': [0.075, 0.30],
  'gemini-2.0-flash':      [0.10,  0.40],
  // ── Anthropic Claude ─────────────────────────────────────────────────────
  'claude-opus-4':         [15.0, 75.00],
  'claude-sonnet-4':       [3.00, 15.00],
  'claude-haiku-4':        [0.80,  4.00],
  'claude-3-5-haiku':      [0.80,  4.00],
  'claude-3-haiku':        [0.25,  1.25],
  'claude-3-5-sonnet':     [3.00, 15.00],
  'claude-3-7-sonnet':     [3.00, 15.00],
  // ── Groq-hosted (inference pricing) ──────────────────────────────────────
  'kimi-k2-instruct':      [1.00,  3.00],
  'kimi-k2':               [0.60,  2.50],
  'llama-4-maverick':      [0.50,  0.77],
  'llama-4-scout':         [0.11,  0.34],
  'llama-3.3-70b':         [0.59,  0.79],
  'llama-3.1-70b':         [0.59,  0.79],
  'llama3.1-70b':          [0.59,  0.79],
  'llama-3.1-8b':          [0.05,  0.08],
  'llama3.1-8b':           [0.10,  0.10],  // Cerebras pricing
  'qwen3-32b':             [0.29,  0.39],
  'llama-guard':           [0.20,  0.20],
  // ── Perplexity ───────────────────────────────────────────────────────────
  'sonar-pro':             [3.00, 15.00],
  'sonar':                 [1.00,  1.00],
  // ── OpenCode free models ──────────────────────────────────────────────────
  'big-pickle':            [0.00,  0.00],  // free
  'trinity-large-preview': [0.00,  0.00],  // free
  'minimax-m2.5-free':     [0.00,  0.00],  // free
  'glm-':                  [0.10,  0.10],  // estimate
  'minimax':               [0.30,  1.00],  // estimate
  // ── Default fallback ─────────────────────────────────────────────────────
  'default':               [1.00,  3.00],
};

function estimateCost(byModel) {
  let total = 0;
  for (const [model, stats] of Object.entries(byModel || {})) {
    const rateKey = Object.keys(MODEL_COST_PER_M).find(k => model.toLowerCase().includes(k)) || 'default';
    const [inputRate, outputRate] = MODEL_COST_PER_M[rateKey];
    total += (stats.prompt / 1e6) * inputRate + (stats.completion / 1e6) * outputRate;
  }
  return total;
}

async function loadTokenUsage() {
  const box = document.getElementById('tokenUsageWidget');
  if (!box) return;
  const u = await getJSON('/api/token-usage').catch(() => ({}));
  const totalTokens = (u.prompt || 0) + (u.completion || 0);
  const cost = estimateCost(u.byModel);

  // ── Totals row ────────────────────────────────────────────────────────────
  let html =
    '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px;">' +
      '<div style="text-align:center;">' +
        '<div style="font-size:20px;font-weight:700;color:var(--accent);">' + (u.calls||0).toLocaleString() + '</div>' +
        '<div style="font-size:11px;color:var(--text-3);margin-top:2px;">LLM calls</div>' +
      '</div>' +
      '<div style="text-align:center;">' +
        '<div style="font-size:20px;font-weight:700;color:var(--green);">' + (totalTokens/1000).toFixed(1) + 'k</div>' +
        '<div style="font-size:11px;color:var(--text-3);margin-top:2px;">total tokens</div>' +
      '</div>' +
      '<div style="text-align:center;">' +
        '<div style="font-size:20px;font-weight:700;color:var(--yellow);">$' + cost.toFixed(4) + '</div>' +
        '<div style="font-size:11px;color:var(--text-3);margin-top:2px;">est. cost (all-time)</div>' +
      '</div>' +
    '</div>';

  // ── Daily history ─────────────────────────────────────────────────────────
  const byDay = u.byDay || {};
  const days = Object.keys(byDay).sort().reverse().slice(0, 14);
  if (days.length) {
    const maxCost = Math.max(...days.map(function(d){ return estimateCost(byDay[d].byModel || {}); }), 0.0001);
    html += '<div style="font-size:11px;font-weight:600;color:var(--text-2);margin:12px 0 6px;">Daily cost (last ' + days.length + ' days)</div>';
    html += '<div style="display:flex;flex-direction:column;gap:3px;">';
    days.forEach(function(day) {
      const ds = byDay[day];
      const dc = estimateCost(ds.byModel || {});
      const pct = Math.max((dc / maxCost) * 100, 2);
      const tok = ((ds.prompt||0) + (ds.completion||0)) / 1000;
      const isToday = day === new Date().toISOString().slice(0, 10);
      html += '<div style="display:flex;align-items:center;gap:8px;font-size:11px;">' +
        '<span style="width:70px;color:var(--text-3);flex-shrink:0;">' + (isToday ? 'today' : day.slice(5)) + '</span>' +
        '<div style="flex:1;background:var(--bg-1);border-radius:3px;height:14px;overflow:hidden;">' +
          '<div style="width:' + pct.toFixed(1) + '%;height:100%;background:' + (isToday ? 'var(--accent)' : 'var(--green)') + ';border-radius:3px;"></div>' +
        '</div>' +
        '<span style="width:52px;text-align:right;color:var(--yellow);font-weight:600;">$' + dc.toFixed(4) + '</span>' +
        '<span style="width:44px;text-align:right;color:var(--text-3);">' + tok.toFixed(1) + 'k</span>' +
      '</div>';
    });
    html += '</div>';
  } else {
    html += '<div style="font-size:11px;color:var(--text-3);margin-top:8px;">No daily history yet — data accumulates with next LLM call after restart.</div>';
  }

  // ── By model (all-time) ───────────────────────────────────────────────────
  if (Object.keys(u.byModel||{}).length) {
    html += '<div style="font-size:11px;color:var(--text-3);margin:12px 0 6px;">By model (all-time)</div>';
    Object.entries(u.byModel||{})
      .sort((a,b) => (b[1].prompt+b[1].completion) - (a[1].prompt+a[1].completion))
      .forEach(function(entry) {
        const model = entry[0], s = entry[1];
        const rateKey = Object.keys(MODEL_COST_PER_M).find(function(k){ return model.toLowerCase().includes(k); }) || 'default';
        const rates = MODEL_COST_PER_M[rateKey];
        const mc = (s.prompt/1e6)*rates[0] + (s.completion/1e6)*rates[1];
        html += '<div style="display:flex;justify-content:space-between;font-size:11px;padding:3px 0;border-bottom:1px solid var(--border);">' +
          '<code style="color:var(--accent);">' + model + '</code>' +
          '<span style="color:var(--text-2);">' + ((s.prompt+s.completion)/1000).toFixed(1) + 'k tok · $' + mc.toFixed(4) + '</span>' +
          '</div>';
      });
  }
  box.innerHTML = html;
}

async function loadOcStats() {
  const box = document.getElementById('ocStatsWidget');
  if (!box) return;
  const days = document.getElementById('ocStatsDays')?.value || '14';
  _ocTotalCost = null;
  showLoading(box);
  try {
    const d = await getJSON('/api/opencode-stats?days=' + days);
    if (!d.ok || !Object.keys(d.byDay||{}).length) {
      showEmpty(box, d.error || 'No OpenCode data found');
      return;
    }
    const byDay = d.byDay;
    const sortedDays = Object.keys(byDay).sort().reverse();
    const totalCost = sortedDays.reduce(function(s,day){ return s + byDay[day].cost; }, 0);
    const totalIn   = sortedDays.reduce(function(s,day){ return s + byDay[day].input_tok; }, 0);
    const totalOut  = sortedDays.reduce(function(s,day){ return s + byDay[day].output_tok; }, 0);
    const totalCalls= sortedDays.reduce(function(s,day){ return s + byDay[day].calls; }, 0);
    const maxCost   = Math.max(...sortedDays.map(function(d){ return byDay[d].cost; }), 0.0001);

    let html = '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px;">' +
      '<div style="text-align:center;"><div style="font-size:18px;font-weight:700;color:var(--yellow);">$' + totalCost.toFixed(4) + '</div><div style="font-size:11px;color:var(--text-3);">total cost</div></div>' +
      '<div style="text-align:center;"><div style="font-size:18px;font-weight:700;color:var(--accent);">' + totalCalls.toLocaleString() + '</div><div style="font-size:11px;color:var(--text-3);">messages</div></div>' +
      '<div style="text-align:center;"><div style="font-size:18px;font-weight:700;color:var(--green);">' + (totalIn/1e6).toFixed(1) + 'M</div><div style="font-size:11px;color:var(--text-3);">input tokens</div></div>' +
      '<div style="text-align:center;"><div style="font-size:18px;font-weight:700;color:var(--green);">' + (totalOut/1e6).toFixed(2) + 'M</div><div style="font-size:11px;color:var(--text-3);">output tokens</div></div>' +
    '</div>';

    // Daily bars
    html += '<div style="display:flex;flex-direction:column;gap:4px;margin-bottom:16px;">';
    const today = new Date().toISOString().slice(0,10);
    sortedDays.forEach(function(day) {
      const ds = byDay[day];
      const pct = Math.max((ds.cost / maxCost) * 100, ds.cost > 0 ? 2 : 0);
      const isToday = day === today;
      const tok = (ds.input_tok + ds.output_tok) / 1e6;
      html += '<div style="display:flex;align-items:center;gap:8px;font-size:11px;">' +
        '<span style="width:70px;color:var(--text-3);flex-shrink:0;">' + (isToday ? 'today' : day.slice(5)) + '</span>' +
        '<div style="flex:1;background:var(--bg-1);border-radius:3px;height:16px;overflow:hidden;">' +
          '<div style="width:' + pct.toFixed(1) + '%;height:100%;background:' + (isToday ? 'var(--accent)' : 'var(--green)') + ';border-radius:3px;opacity:0.85;"></div>' +
        '</div>' +
        '<span style="width:60px;text-align:right;color:var(--yellow);font-weight:600;">$' + ds.cost.toFixed(4) + '</span>' +
        '<span style="width:50px;text-align:right;color:var(--text-3);">' + tok.toFixed(2) + 'M</span>' +
        '<span style="width:36px;text-align:right;color:var(--text-3);">' + ds.calls + '</span>' +
      '</div>';
    });
    html += '</div>';

    // All models across period
    const allModels = {};
    sortedDays.forEach(function(day) {
      Object.entries(byDay[day].byModel||{}).forEach(function(e) {
        const m = e[0], s = e[1];
        if (!allModels[m]) allModels[m] = { cost:0, input_tok:0, output_tok:0, calls:0 };
        allModels[m].cost += s.cost;
        allModels[m].input_tok += s.input_tok;
        allModels[m].output_tok += s.output_tok;
        allModels[m].calls += s.calls;
      });
    });
    const sortedModels = Object.entries(allModels).sort(function(a,b){ return b[1].cost - a[1].cost; });
    if (sortedModels.length) {
      html += '<div style="font-size:11px;color:var(--text-3);margin-bottom:6px;">By model</div>';
      sortedModels.forEach(function(e) {
        const m = e[0], s = e[1];
        const tok = (s.input_tok + s.output_tok) / 1e6;
        html += '<div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;padding:3px 0;border-bottom:1px solid var(--border);">' +
          '<code style="color:var(--accent);">' + m + '</code>' +
          '<span style="color:var(--text-2);">' + tok.toFixed(2) + 'M tok · ' + s.calls + ' calls · ' +
            '<span style="color:var(--yellow);font-weight:600;">$' + s.cost.toFixed(4) + '</span>' +
          '</span>' +
        '</div>';
      });
    }
    _ocTotalCost = totalCost;
    updateGrandTotal();
    box.innerHTML = html;
  } catch(e) {
    showError(box, 'Error: ' + e.message);
  }
}

async function checkCrewLeadStatus() {
  try {
    const d = await getJSON('/api/crew-lead/status');
    const badge = document.getElementById('crewLeadBadge');
    if (d.online) {
      badge.textContent = '● online'; badge.className = 'status-badge status-running';
    } else {
      badge.textContent = '● offline'; badge.className = 'status-badge status-stopped';
    }
  } catch {}
}

function appendRoadmapCard(box, { draftId, name, outputDir, roadmapMd }) {
  function countTasks(md) { return (md.match(/^- \[ \]/gm) || []).length; }

  const wrap = document.createElement('div');
  wrap.setAttribute('data-draft-id', draftId);
  wrap.style.cssText = 'width:100%;display:flex;flex-direction:column;gap:4px;';

  const lbl = document.createElement('div');
  lbl.style.cssText = 'font-size:11px;color:var(--text-3);padding:0 6px;';
  lbl.textContent = '🗺️ Roadmap draft — review before building';

  const card = document.createElement('div');
  card.style.cssText = 'width:100%;border:1px solid var(--border);border-radius:12px;overflow:hidden;background:var(--bg-card);';

  const header = document.createElement('div');
  header.style.cssText = 'background:var(--bg-card2);padding:10px 14px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);';
  header.innerHTML = '<div><div style="font-size:13px;font-weight:600;color:var(--accent);">🚀 ' + name + '</div><div style="font-size:11px;color:var(--blue);margin-top:2px;">' + outputDir + '</div></div>' +
    '<span style="font-size:10px;color:var(--text-3);padding:2px 7px;background:var(--bg-card2);border-radius:10px;" class="task-count">' + countTasks(roadmapMd) + ' tasks</span>';

  const ta = document.createElement('textarea');
  ta.value = roadmapMd;
  ta.spellcheck = false;
  ta.style.cssText = 'width:100%;background:var(--bg-card);border:none;outline:none;color:var(--text-1);font-size:11.5px;font-family:SF Mono,Monaco,Menlo,monospace;line-height:1.6;padding:12px 14px;resize:none;min-height:160px;max-height:320px;display:block;';
  setTimeout(() => { ta.style.height = ''; ta.style.height = Math.min(ta.scrollHeight, 320) + 'px'; }, 50);
  ta.addEventListener('input', () => {
    ta.style.height = ''; ta.style.height = Math.min(ta.scrollHeight, 320) + 'px';
    header.querySelector('.task-count').textContent = countTasks(ta.value) + ' tasks';
  });

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;align-items:center;padding:10px 14px 12px;border-top:1px solid var(--border);background:var(--bg-card2);';

  const startBtn = document.createElement('button');
  startBtn.textContent = '▶ Start Building';
  startBtn.style.cssText = 'background:var(--green-hi);color:#000;border:none;border-radius:8px;padding:8px 16px;font-size:12px;font-weight:700;cursor:pointer;';
  startBtn.onclick = async () => {
    startBtn.disabled = true; startBtn.textContent = '⏳ Launching…';
    try {
      const r = await postJSON('/api/crew-lead/confirm-project', { draftId, roadmapMd: ta.value });
      if (r.ok) {
        card.innerHTML = '<div style="padding:14px;color:var(--green-hi);font-size:13px;font-weight:600;">✅ ' + name + ' — project created, PM loop running!<br><span style="color:var(--blue);font-size:11px;font-weight:400">' + (r.outputDir || outputDir) + '</span></div>';
        appendChatBubble('assistant', '🚀 ' + name + ' is building. Check the Projects tab to watch progress.');
      } else {
        startBtn.disabled = false; startBtn.textContent = '▶ Start Building';
        status.textContent = '⚠️ ' + (r.error || 'Launch failed');
      }
    } catch(e) { startBtn.disabled = false; startBtn.textContent = '▶ Start Building'; status.textContent = '⚠️ ' + e.message; }
  };

  const discardBtn = document.createElement('button');
  discardBtn.textContent = 'Discard';
  discardBtn.style.cssText = 'background:none;border:1px solid var(--border);color:var(--text-3);border-radius:8px;padding:8px 14px;font-size:12px;cursor:pointer;';
  discardBtn.onclick = async () => {
    await postJSON('/api/crew-lead/discard-project', { draftId }).catch(() => {});
    wrap.remove();
  };

  const status = document.createElement('span');
  status.style.cssText = 'font-size:11px;color:var(--blue);margin-left:auto;';
  status.textContent = 'Edit above, then confirm';

  actions.appendChild(startBtn); actions.appendChild(discardBtn); actions.appendChild(status);
  card.appendChild(header); card.appendChild(ta); card.appendChild(actions);
  wrap.appendChild(lbl); wrap.appendChild(card);
  box.appendChild(wrap);
  box.scrollTop = box.scrollHeight;
}

let lastAppendedAssistantContent = '';
let lastAppendedUserContent = '';
let lastSentContent = null;
const {
  loadChatHistory,
  chatAtAtInput,
  chatKeydown,
  sendChat,
  clearChatHistory,
  restorePassthroughLog,
  sendPassthrough,
  stopAll,
  killAll,
} = initChatActions({
  postJSON,
  getJSON,
  appendChatBubble,
  showNotification,
  state,
  getChatSessionId: () => chatSessionId,
  getChatActiveProjectId: () => _chatActiveProjectId,
  getCrewLeadInfo: () => window._crewLeadInfo,
  appendRoadmapCard,
  getLastAppendedAssistantContent: () => lastAppendedAssistantContent,
  setLastAppendedAssistantContent: (value) => { lastAppendedAssistantContent = value; },
  setLastAppendedUserContent: (value) => { lastAppendedUserContent = value; },
  setLastSentContent: (value) => { lastSentContent = value; },
});

/* services tab extracted to tabs/services-tab.js */
async function loadFiles(forceRefresh) {
  const el = document.getElementById('filesContent');
  const dir = document.getElementById('filesDir').value.trim() || window._crewCwd || (window._crewHome ? window._crewHome + '/Desktop/CrewSwarm' : '');
  showLoading(el, 'Scanning ' + dir + '...');
  try {
    const data = await getJSON('/api/files?dir=' + encodeURIComponent(dir));
    if (!data.files || !data.files.length) {
      showEmpty(el, 'No files found in ' + dir);
      return;
    }
    const grouped = {};
    data.files.forEach(f => {
      const ext = f.path.split('.').pop().toLowerCase() || 'other';
      if (!grouped[ext]) grouped[ext] = [];
      grouped[ext].push(f);
    });
    const extOrder = ['html','css','js','mjs','ts','json','md','sh','txt','other'];
    const extEmoji = { html:'🌐', css:'🎨', js:'⚡', mjs:'⚡', ts:'🔷', json:'📋', md:'📝', sh:'🖥️', txt:'📄', other:'📁' };
    let html = '<div style="display:grid;gap:1rem;padding:4px 0;">';
    for (const ext of extOrder) {
      if (!grouped[ext]) continue;
      html += '<div>';
      html += '<div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;padding-left:2px;">' + (extEmoji[ext]||'📁') + ' .' + ext + ' — ' + grouped[ext].length + ' file' + (grouped[ext].length>1?'s':'') + '</div>';
      html += '<div style="display:grid;gap:6px;">';
      grouped[ext].sort((a,b) => b.mtime - a.mtime).forEach(f => {
        const rel = f.path.replace(dir + '/', '');
        const age = formatAge(f.mtime);
        const sz = formatSize(f.size);
        html += '<div class="file-row">';
        html += '<div class="file-info"><span class="file-name">' + rel + '</span><span class="file-meta">' + sz + ' · ' + age + '</span></div>';
        html += '<div class="file-actions">';
        html += '<a href="cursor://file/' + f.path + '" class="file-btn file-btn-cursor" title="Open in Cursor">Cursor</a>';
        html += '<a href="opencode://open?path=' + encodeURIComponent(f.path) + '" class="file-btn file-btn-opencode" title="Open in OpenCode">OpenCode</a>';
        html += '<button data-action="previewFile" data-arg=\'' + f.path.replace(/'/g,'&#39;') + '\' data-self="1" class="file-btn" title="Preview">👁</button>';
        html += '</div></div>';
      });
      html += '</div></div>';
    }
    html += '</div>';
    html += '<div id="file-preview-pane" style="display:none;margin-top:1rem;background:#0d1117;border:1px solid var(--border);border-radius:8px;overflow:hidden;"><div id="file-preview-bar" style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#0d1420;border-bottom:1px solid var(--border);font-size:12px;color:var(--text-2);"><span id="file-preview-name"></span><button data-action="closePreviewPane" style="margin-left:auto;background:none;border:none;color:var(--text-2);cursor:pointer;">✕</button></div><pre id="file-preview-content" style="margin:0;padding:1rem;font-size:0.75rem;overflow:auto;max-height:400px;"></pre></div>';
    el.innerHTML = html;
  } catch(e) {
    showError(el, 'Error: ' + e.message);
  }
}
async function previewFile(filePath, btn) {
  const pane = document.getElementById('file-preview-pane');
  const content = document.getElementById('file-preview-content');
  const name = document.getElementById('file-preview-name');
  if (!pane) return;
  name.textContent = filePath.split('/').pop();
  content.textContent = 'Loading...';
  pane.style.display = 'block';
  pane.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    const data = await getJSON('/api/file-content?path=' + encodeURIComponent(filePath));
    content.textContent = data.content || '(empty)';
  } catch(e) {
    content.textContent = 'Error: ' + e.message;
  }
}
function closePreviewPane() {
  const pane = document.getElementById('file-preview-pane');
  if (pane) pane.style.display = 'none';
}
function formatAge(mtime) {
  const diff = Date.now() - mtime;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h/24) + 'd ago';
}
function formatSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + 'KB';
  return (bytes/1024/1024).toFixed(1) + 'MB';
}
function showSettings(){
  hideAllViews();
  document.getElementById('settingsView').classList.add('active');
  setNavActive('navSettings');
  // Restore last active sub-tab from hash (e.g. #settings/telegram → telegram)
  const hashSubtab = (location.hash || '').replace('#settings/', '');
  // Support legacy deep-link aliases
  const TAB_ALIASES = { system: 'engines', telegram: 'comms', whatsapp: 'comms' };
  const knownTabs = ['usage','engines','comms','security','webhooks'];
  const resolved = TAB_ALIASES[hashSubtab] || hashSubtab;
  showSettingsTab(knownTabs.includes(resolved) ? resolved : 'usage');
}
function showSettingsTab(tab){
  const knownTabs = ['usage','engines','comms','security','webhooks'];
  knownTabs.forEach(t => {
    const panel = document.getElementById('stab-panel-' + t);
    const btn   = document.getElementById('stab-' + t);
    if (!panel || !btn) return;
    panel.style.display = t === tab ? (t === 'usage' ? 'grid' : 'block') : 'none';
    btn.classList.toggle('active', t === tab);
  });
  if (tab === 'usage')    { loadTokenUsage(); loadAllUsage(); }
  if (tab === 'engines')  { loadOpencodeProject(); loadBgConsciousness(); loadGlobalFallback(); loadCursorWaves(); loadClaudeCode(); loadCodexExecutor(); loadGlobalOcLoop(); loadLoopBrain(); loadPassthroughNotify(); }
  if (tab === 'comms')    { loadCommsTabData(); }
  if (tab === 'security') { loadCmdAllowlist(); loadEnvAdvanced(); }
  if (tab === 'webhooks') { /* static */ }
  // Update URL hash for deep linking — e.g. #settings/telegram
  if (document.getElementById('settingsView')?.classList.contains('active')) {
    history.replaceState(null, '', '#settings/' + tab);
  }
}

initCommsTab({ showSettings, showSettingsTab });
initSettingsTab({ getModels: loadAgents_cfg, populateModelDropdown });
initModelsTab({ hideAllViews, setNavActive, loadAgents });
initAddProviderForm();

// ── Engines → engines-tab.js ─────────────────────────────────────────────────
function showEngines(){
  hideAllViews();
  document.getElementById('enginesView').classList.add('active');
  setNavActive('navEngines');
  loadEngines();
}

// showSkills / showRunSkills → skills-tab.js

const showBenchmarks = () => showBenchmarksTab({ hideAllViews, setNavActive });

function showToolMatrix(){
  hideAllViews();
  document.getElementById('toolMatrixView').classList.add('active');
  setNavActive('navToolMatrix');
  loadToolMatrix();
}

// keep old name working for any legacy calls
function showIntegrations(){ showSkills(); }

// loadRunSkills / runSkillFromUI → skills-tab.js

// ── Task lifecycle (telemetry schema 1.1) ────────────────────────────────────────
window._telemetryEvents = window._telemetryEvents || [];
function renderTaskLifecycle(events) {
  const el = document.getElementById('taskLifecycleContainer');
  if (!el) return;
  events = events || [];
  if (!events.length) {
    el.innerHTML = '<div class="card" style="padding:12px;"><div class="meta" style="font-size:12px;">Recent task lifecycle (dispatched → completed/failed/cancelled). Dispatch a task to see events.</div></div>';
    return;
  }
  const rows = events.slice().reverse().slice(0, 15).map(ev => {
    const d = ev.data || {};
    const phase = d.phase || '';
    const color = phase === 'completed' ? 'var(--green)' : phase === 'failed' || phase === 'cancelled' ? 'var(--red)' : 'var(--accent)';
    const time = (ev.occurredAt || '').replace('T', ' ').slice(0, 19);
    return '<tr style="border-bottom:1px solid var(--border);"><td style="padding:6px 10px;font-size:11px;color:var(--text-3);">' + time + '</td><td style="padding:6px 10px;font-size:12px;"><span style="color:' + color + ';">' + phase + '</span></td><td style="padding:6px 10px;font-size:12px;">' + (d.agentId || '') + '</td><td style="padding:6px 10px;font-size:11px;color:var(--text-3);">' + (d.taskId || '').slice(0, 20) + '</td></tr>';
  }).join('');
  el.innerHTML = '<div class="card" style="overflow:auto;"><div style="font-size:12px;font-weight:600;padding:8px 12px;border-bottom:1px solid var(--border);">Task lifecycle (schema 1.1)</div><table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="border-bottom:1px solid var(--border);"><th style="text-align:left;padding:6px 10px;">Time</th><th style="text-align:left;padding:6px 10px;">Phase</th><th style="text-align:left;padding:6px 10px;">Agent</th><th style="text-align:left;padding:6px 10px;">Task ID</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

// ── Tool Matrix (agents × tools from health + restart) ───────────────────────────
const TOOL_LABELS = { read_file: 'read', write_file: 'write', mkdir: 'mkdir', run_cmd: 'run', dispatch: 'dispatch', skill: 'skill', define_skill: 'define_skill', git: 'git', telegram: 'tg', whatsapp: 'wa' };

async function loadToolMatrix(){
  const el = document.getElementById('toolMatrixContainer');
  if (!el) return;
  try {
    const res = await fetch('/api/health');
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.ok) {
      const msg = d.error || (res.status === 401 ? 'Unauthorized' : res.statusText || 'Request failed');
      el.innerHTML = '<div class="card" style="padding:16px;"><div style="color:var(--yellow);font-size:13px;font-weight:600;">Health check failed</div>' +
        '<div style="color:var(--text-2);font-size:12px;margin-top:8px;">' + (res.status === 401 ? 'RT token missing or invalid. Set it in Settings → System (RT token) or in ~/.crewswarm/config.json (rt.authToken).' : msg) + '</div>' +
        '<div style="color:var(--text-3);font-size:11px;margin-top:8px;">Ensure crew-lead is running on :5010 (Services tab).</div></div>';
      return;
    }
    renderTaskLifecycle(d.telemetry || []);
    window._telemetryEvents = d.telemetry || [];
    const bridgeAgents = (d.agents || []).filter(a => (a.id || '').toLowerCase() !== 'crew-lead');
    const crewLeadInfo = window._crewLeadInfo || { name: 'Crew Lead', emoji: '🧠' };
    const crewLeadRow = { id: 'crew-lead', name: crewLeadInfo.name, emoji: crewLeadInfo.emoji, tools: ['read_file', 'write_file', 'mkdir', 'run_cmd', 'web_search', 'web_fetch', 'skill', 'define_skill', 'dispatch', 'telegram', 'whatsapp'] };
    const agents = [crewLeadRow, ...bridgeAgents];
    const toolKeys = [...new Set(['define_skill', 'skill', ...agents.flatMap(a => Array.isArray(a.tools) ? a.tools : Object.keys(a.tools || {}))])].sort();
    const labels = toolKeys.map(t => TOOL_LABELS[t] || t);
    if (!agents.length) {
      el.innerHTML = '<div class="card" style="padding:16px;"><div style="color:var(--text-2);font-size:13px;">No agents in roster.</div>' +
        '<div style="color:var(--text-3);font-size:12px;margin-top:6px;">Add agents in Settings → Agents (or ~/.crewswarm/crewswarm.json), then start bridges from Services.</div></div>';
      return;
    }
    let html = '<div class="card" style="overflow:auto;"><table style="width:100%;border-collapse:collapse;font-size:12px;">'
      + '<thead><tr style="border-bottom:1px solid var(--border);">'
      + '<th style="text-align:left;padding:8px 12px;">Agent</th>';
    toolKeys.forEach((t, i) => { html += '<th style="text-align:center;padding:8px 8px;" title="' + (t || '') + '">' + (labels[i] || t) + '</th>'; });
    html += '<th style="text-align:right;padding:8px 12px;">Quick action</th></tr></thead><tbody>';
    agents.forEach(a => {
      const tools = Array.isArray(a.tools) ? a.tools : (a.tools ? Object.keys(a.tools).filter(k => a.tools[k]) : []);
      const name = (a.emoji || '') + ' ' + (a.name || a.id || '');
      html += '<tr style="border-bottom:1px solid var(--border);">';
      html += '<td style="padding:8px 12px;"><strong>' + (name || a.id).replace(/</g, '&lt;') + '</strong></td>';
      toolKeys.forEach(t => {
        const has = tools.includes(t);
        html += '<td style="text-align:center;padding:6px 8px;">' + (has ? '<span style="color:var(--green);" title="' + t + '">✓</span>' : '<span style="color:var(--text-3);">—</span>') + '</td>';
      });
      html += '<td style="text-align:right;padding:8px 12px;"><button class="btn-ghost" style="font-size:11px;" data-action="restartAgentFromUI" data-arg="' + (a.id || '').replace(/"/g, '&quot;') + '">Restart</button></td></tr>';
    });
    html += '</tbody></table></div>';
    el.innerHTML = html;
  } catch (e) {
    showError(el, 'Error loading health: ' + (e.message || ''));
  }
}

async function restartAgentFromUI(agentId){
  if (!agentId) return;
  try {
    const r = await fetch('/api/agents/' + encodeURIComponent(agentId) + '/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const data = await r.json();
    if (data.ok) showNotification('Restarting ' + agentId + '…');
    else showNotification(data.error || 'Restart failed', 'error');
  } catch (e) { showNotification(e.message || 'Request failed', 'error'); }
}

// ── Skills → skills-tab.js ─────────────────────────────────────────────────────

// ── Spending ──────────────────────────────────────────────────────────────────
var _agentTotalCost = null;
var _ocTotalCost = null;
function updateGrandTotal() {
  var a = _agentTotalCost, o = _ocTotalCost;
  var aEl = document.getElementById('gtAgentCost');
  var oEl = document.getElementById('gtOcCost');
  var tEl = document.getElementById('gtTotal');
  if (!aEl) return;
  if (a !== null) aEl.textContent = '$' + a.toFixed(4);
  if (o !== null) oEl.textContent = '$' + o.toFixed(4);
  if (a !== null && o !== null) tEl.textContent = '$' + (a + o).toFixed(4);
}
async function loadAllUsage() {
  var days = parseInt(document.getElementById('grandTotalDays')?.value || '14');
  var ocSel = document.getElementById('ocStatsDays');
  var spSel = document.getElementById('spendingDays');
  if (ocSel) ocSel.value = String(days);
  if (spSel) spSel.value = String(days === 1 ? 1 : days);
  _agentTotalCost = null;
  _ocTotalCost = null;
  document.getElementById('gtAgentCost').textContent = '—';
  document.getElementById('gtOcCost').textContent = '—';
  document.getElementById('gtTotal').textContent = '—';
  loadSpending();
  loadOcStats();
}
async function loadSpending(){
  const el = document.getElementById('spendingWidget');
  const days = parseInt(document.getElementById('spendingDays')?.value || '1');
  try {
    if (days <= 1) {
      // Today: real-time from crew-lead
      const d = await (await fetch('/api/spending')).json();
      const { spending, caps } = d;
      const gTokens = spending.global?.tokens || 0;
      const gCost   = spending.global?.costUSD || 0;
      const gCapTok = caps.global?.dailyTokenLimit;
      const gCapCost = caps.global?.dailyCostLimitUSD;
      let out = '<div style="margin-bottom:10px;">'
              + '<div style="font-size:11px;font-weight:600;color:var(--text-2);margin-bottom:4px;text-transform:uppercase;letter-spacing:.06em;">Global &middot; ' + (spending.date||'today') + '</div>'
              + '<div style="display:flex;gap:20px;"><span>' + gTokens.toLocaleString() + ' tokens' + (gCapTok ? ' / ' + Number(gCapTok).toLocaleString() : '') + '</span>'
              + '<span style="color:var(--yellow);font-weight:600;">$' + gCost.toFixed(4) + '</span>' + (gCapCost ? '<span> / $' + gCapCost + '</span>' : '') + '</div>';
      if (gCapTok) {
        const pct = Math.min(100, (gTokens/gCapTok)*100);
        const barColor = pct > 80 ? 'var(--red)' : pct > 50 ? 'var(--yellow)' : 'var(--green)';
        out += '<div style="margin-top:4px;height:4px;background:var(--border);border-radius:2px;"><div style="width:' + pct + '%;height:100%;background:' + barColor + ';border-radius:2px;transition:width .3s;"></div></div>';
      }
      out += '</div>';
      const agents = Object.entries(spending.agents || {});
      if (agents.length) {
        out += '<div style="font-size:11px;font-weight:600;color:var(--text-2);margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em;">Per Agent</div>';
        out += agents.map(function(entry) {
          var id = entry[0], v = entry[1];
          const agentCap = caps.agents && caps.agents[id];
          const toks  = v.tokens || 0;
          const cost  = (v.costUSD||0).toFixed(4);
          const capTok = agentCap && agentCap.dailyTokenLimit;
          const pct    = capTok ? Math.min(100, (toks/capTok)*100) : null;
          let row = '<div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;">'
                  + '<span style="min-width:140px;font-size:12px;">' + id + '</span>'
                  + '<span style="font-size:12px;">' + toks.toLocaleString() + ' tok' + (capTok ? ' / ' + Number(capTok).toLocaleString() : '') + ' &middot; <span style="color:var(--yellow);">$' + cost + '</span></span>';
          if (pct !== null) {
            const barColor = pct > 80 ? 'var(--red)' : 'var(--accent)';
            row += '<div style="flex:1;height:3px;background:var(--border);border-radius:2px;"><div style="width:' + pct + '%;height:100%;background:' + barColor + ';border-radius:2px;"></div></div>';
          }
          return row + '</div>';
        }).join('');
      } else { out += '<div style="color:var(--text-3);">No per-agent data yet for today.</div>'; }
      if (gCapTok) document.getElementById('gcapTokens').value = gCapTok;
      if (gCapCost) document.getElementById('gcapCost').value = gCapCost;
      _agentTotalCost = gCost;
      updateGrandTotal();
      el.innerHTML = out;
    } else {
      // Multi-day: compute from token-usage.json byDay
      const u = await getJSON('/api/token-usage').catch(function(){ return {}; });
      const byDay = u.byDay || {};
      const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      const filteredDays = Object.keys(byDay).filter(function(d){ return d >= cutoff; }).sort().reverse();
      if (!filteredDays.length) {
        el.innerHTML = '<div style="color:var(--text-3);">No data for this period.</div>';
        _agentTotalCost = 0;
        updateGrandTotal();
        return;
      }
      // Aggregate byModel across days
      const aggByModel = {};
      var totalTok = 0, totalCost = 0;
      filteredDays.forEach(function(day) {
        const dm = byDay[day].byModel || {};
        Object.entries(dm).forEach(function(e) {
          var m = e[0], s = e[1];
          if (!aggByModel[m]) aggByModel[m] = { prompt: 0, completion: 0 };
          aggByModel[m].prompt += s.prompt || 0;
          aggByModel[m].completion += s.completion || 0;
          totalTok += (s.prompt||0) + (s.completion||0);
        });
      });
      totalCost = estimateCost(aggByModel);
      let out = '<div style="margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;">'
              + '<span style="font-size:12px;color:var(--text-3);">Last ' + days + ' days &middot; ' + filteredDays.length + ' days of data</span>'
              + '<span style="font-size:16px;font-weight:700;color:var(--yellow);">$' + totalCost.toFixed(4) + '</span>'
              + '</div>';
      // Daily breakdown bar chart
      const maxDayCost = Math.max(...filteredDays.map(function(d){ return estimateCost(byDay[d].byModel||{}); }), 0.0001);
      const today = new Date().toISOString().slice(0,10);
      out += '<div style="display:flex;flex-direction:column;gap:3px;margin-bottom:12px;">';
      filteredDays.forEach(function(day) {
        const dc = estimateCost(byDay[day].byModel||{});
        const pct = Math.max((dc/maxDayCost)*100, dc > 0 ? 2 : 0);
        const isToday = day === today;
        const tok = ((byDay[day].prompt||0)+(byDay[day].completion||0))/1000;
        out += '<div style="display:flex;align-items:center;gap:8px;font-size:11px;">'
             + '<span style="width:64px;color:var(--text-3);flex-shrink:0;">' + (isToday ? 'today' : day.slice(5)) + '</span>'
             + '<div style="flex:1;background:var(--bg-1);border-radius:3px;height:12px;overflow:hidden;">'
             +   '<div style="width:' + pct.toFixed(1) + '%;height:100%;background:' + (isToday ? 'var(--accent)' : 'var(--green)') + ';border-radius:3px;opacity:.8;"></div>'
             + '</div>'
             + '<span style="width:58px;text-align:right;color:var(--yellow);font-weight:600;">$' + dc.toFixed(4) + '</span>'
             + '<span style="width:40px;text-align:right;color:var(--text-3);">' + tok.toFixed(0) + 'k</span>'
             + '</div>';
      });
      out += '</div>';
      // Top models
      const sortedModels = Object.entries(aggByModel).sort(function(a,b){
        return estimateCost({b:b[1]}) - estimateCost({a:a[1]});
      });
      if (sortedModels.length) {
        out += '<div style="font-size:11px;color:var(--text-3);margin-bottom:4px;">By model</div>';
        sortedModels.slice(0,8).forEach(function(e) {
          var m = e[0], s = e[1];
          const mc = estimateCost({x:s});
          const tok = ((s.prompt||0)+(s.completion||0))/1000;
          out += '<div style="display:flex;justify-content:space-between;font-size:11px;padding:2px 0;border-bottom:1px solid var(--border);">'
               + '<code style="color:var(--accent);">' + m + '</code>'
               + '<span style="color:var(--text-2);">' + tok.toFixed(1) + 'k tok &middot; <span style="color:var(--yellow);">$' + mc.toFixed(4) + '</span></span>'
               + '</div>';
        });
      }
      _agentTotalCost = totalCost;
      updateGrandTotal();
      el.innerHTML = out;
    }
  } catch(e) { showError(el, 'Error: ' + e.message); }
}
async function resetSpending(){
  if (!confirm("Reset today's spending counters?")) return;
  try { await fetch('/api/spending/reset', { method: 'POST', headers:{'content-type':'application/json'}, body: '{}' }); loadSpending(); showNotification('Spending reset'); }
  catch(e) { showNotification('Reset failed', true); }
}
async function saveGlobalCaps(){
  const tokens = parseInt(document.getElementById('gcapTokens').value) || null;
  const cost   = parseFloat(document.getElementById('gcapCost').value) || null;
  showNotification('Add to ~/.crewswarm/crewswarm.json: "globalSpendingCaps": {"dailyTokenLimit":' + (tokens||'null') + ',"dailyCostLimitUSD":' + (cost||'null') + '}', 'warning');
}

// ── Webhooks ──────────────────────────────────────────────────────────────────
async function sendTestWebhook(){
  const channel = document.getElementById('webhookChannel').value.trim() || 'test';
  let payload = {};
  try { const v = document.getElementById('webhookPayload').value.trim(); if(v) payload = JSON.parse(v); } catch { payload = { raw: document.getElementById('webhookPayload').value }; }
  const el = document.getElementById('webhookTestResult');
  try {
    const res = await fetch('/proxy-webhook/' + channel, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    const d = await res.json();
    el.textContent = d.ok ? '✅ Sent to RT bus' : '❌ ' + (d.error||'failed');
    el.style.color = d.ok ? 'var(--green)' : 'var(--red)';
  } catch(e) { el.textContent = '❌ ' + e.message; el.style.color='var(--red)'; }
}

// ── Pending Approvals ─────────────────────────────────────────────────────────
async function loadPendingApprovals(){
  const el = document.getElementById('pendingApprovals');
  // pending-skills.json is at ~/.crewswarm/pending-skills.json — no direct API yet; 
  // crew-lead should expose this but for now show instructions.
  el.innerHTML = '<div style="color:var(--text-3);font-size:12px;">Pending skill approvals appear here when an agent triggers a skill marked requiresApproval. You will also receive a Telegram notification with inline Approve/Reject buttons if Telegram is configured.</div>';
}
async function approveSkill(approvalId){
  try { await fetch('/api/skills/approve', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({approvalId}) }); showNotification('Approved'); loadPendingApprovals(); }
  catch(e) { showNotification('Failed: '+e.message,'error'); }
}
async function rejectSkill(approvalId){
  try { await fetch('/api/skills/reject', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({approvalId}) }); showNotification('Rejected'); loadPendingApprovals(); }
  catch(e) { showNotification('Failed: '+e.message,'error'); }
}

/* agents tab extracted to tabs/agents-tab.js */
function showBuild(){ _showBuild({ hideAllViews, setNavActive }); }
function showProjects(){ _showProjects({ hideAllViews, setNavActive }); }

// ── Projects / Build → projects-tab.js ───────────────────────────────────────
// Wire project list delegated click handler
initProjectsList({ showChat, showBuild });

refreshAll();
setInterval(refreshAll, 3000);
// Populate chat project dropdown on load; respect #projects deep link (e.g. from native app)
(async () => {
  try {
    const data = await getJSON('/api/projects');
    const projects = data.projects || [];
    state.projectsData = {};
    projects.forEach(p => { state.projectsData[p.id] = p; });
    populateChatProjectDropdown(projects);
    if (location.hash === '#projects') showProjects();
  } catch {}
})();
window.addEventListener('hashchange', () => { if (location.hash === '#projects') showProjects(); });
document.getElementById('refreshBtn').onclick = refreshAll;
document.getElementById('runBuildBtn').onclick = runBuild;
document.getElementById('continuousBuildBtn').onclick = continuousBuildRun;
document.getElementById('stopBuildBtn').onclick = stopBuild;
document.getElementById('stopContinuousBtn').onclick = stopContinuousBuild;
document.getElementById('enhancePromptBtn').onclick = enhancePrompt;
loadBuildProjectPicker();
document.getElementById('newProjectBtn').onclick = () => {
  const form = document.getElementById('newProjectForm');
  form.style.display = form.style.display === 'none' ? 'block' : 'none';
};
document.getElementById('npCancelBtn').onclick = () => { document.getElementById('newProjectForm').style.display = 'none'; };
document.getElementById('npCreateBtn').onclick = async () => {
  const name = document.getElementById('npName').value.trim();
  const desc = document.getElementById('npDesc').value.trim();
  const outputDir = document.getElementById('npOutputDir').value.trim();
  const featuresDoc = document.getElementById('npFeaturesDoc').value.trim();
  if (!name || !outputDir) { showNotification('Name and output directory required', true); return; }
  try {
    const r = await postJSON('/api/projects', { name, description: desc, outputDir, featuresDoc });
    showNotification(`Project "${r.project.name}" created!`);
    document.getElementById('newProjectForm').style.display = 'none';
    document.getElementById('npName').value = '';
    document.getElementById('npDesc').value = '';
    document.getElementById('npOutputDir').value = '';
    document.getElementById('npFeaturesDoc').value = '';
    loadProjects();
  } catch(e) { showNotification('Failed: ' + e.message, true); }
};
// sendBtn / messageInput removed (replaced by crew-lead chat)

// ── PM Loop controls ──────────────────────────────────────────────────────
let pmPoller = null;

function getSelectedProjectId() {
  const sel = document.getElementById('buildProjectPicker');
  return sel ? sel.value : '';
}
async function checkPmStatus() {
  try {
    const projectId = getSelectedProjectId();
    const qs = projectId ? '?projectId=' + encodeURIComponent(projectId) : '';
    const s = await fetch('/api/pm-loop/status' + qs).then(r => r.json());
    const badge    = document.getElementById('pmLoopBadge');
    const startBtn = document.getElementById('pmStartBtn');
    const dryBtn   = document.getElementById('pmDryRunBtn');
    const logBox   = document.getElementById('pmLiveLog');
    if (s.running) {
      badge.textContent = 'running (pid ' + s.pid + ')';
      badge.classList.add('running');
      startBtn.disabled = true;
      dryBtn.disabled = true;
      logBox.style.display = 'block';
      if (!pmPoller) startPmLogPoller();
    } else {
      if (badge.textContent.startsWith('running')) {
        badge.textContent = 'idle';
        badge.classList.remove('running');
        startBtn.disabled = false;
        dryBtn.disabled = false;
      }
    }
  } catch(_) {}
}

function startPmLogPoller() {
  if (pmPoller) return;
  pmPoller = setInterval(async () => {
    try {
      const lg = await fetch('/api/pm-loop/log').then(r2 => r2.json());
      const logBox = document.getElementById('pmLiveLog');
      const badge  = document.getElementById('pmLoopBadge');
      const startBtn = document.getElementById('pmStartBtn');
      const dryBtn   = document.getElementById('pmDryRunBtn');
      if (lg.lines && lg.lines.length) {
        logBox.textContent = lg.lines.map(l => {
          if (l.event === 'finish') return `🏁 Done  ✓${l.done}  ✗${l.failed}  ⏳${l.pending}`;
          if (l.event === 'stopped_by_file') return '⛔ Stopped by user';
          if (l.event === 'all_done') return `🏁 All ${l.total} items complete!`;
          const icon = l.status === 'done' ? '✅' : l.status === 'failed' ? '❌' : l.event ? '·' : '·';
          const txt  = l.item ? `${l.item.substring(0, 60)}` : (l.event || '');
          return `${icon} ${txt}`;
        }).join('\\n');
        logBox.scrollTop = logBox.scrollHeight;
        const last = lg.lines[lg.lines.length - 1];
        if (last && (last.event === 'finish' || last.event === 'all_done' || last.event === 'stopped_by_file')) {
          clearInterval(pmPoller); pmPoller = null;
          badge.textContent = last.event === 'all_done' ? '✓ complete' : 'idle';
          badge.classList.remove('running');
          startBtn.disabled = false; dryBtn.disabled = false;
        }
      }
    } catch(_){}
  }, 5000);
}

async function startPmLoop(dryRun = false) {
  const projectId = getSelectedProjectId();
  const badge  = document.getElementById('pmLoopBadge');
  const status = document.getElementById('pmStatus');
  const logBox = document.getElementById('pmLiveLog');
  const startBtn = document.getElementById('pmStartBtn');
  const dryBtn   = document.getElementById('pmDryRunBtn');
  const proj = _buildProjects[projectId];
  if (!projectId) {
    showNotification('Select a project first from the Project picker above', true);
    return;
  }
  try {
    badge.textContent = dryRun ? 'dry run...' : 'starting...';
    badge.classList.add('running');
    startBtn.disabled = true;
    dryBtn.disabled = true;
    logBox.style.display = 'block';
    logBox.textContent = '⚙ Starting PM Loop for ' + (proj ? proj.name : projectId) + (dryRun ? ' (dry run)' : '') + '...\\n';
    const resp = await fetch('/api/pm-loop/start', {
      method: 'POST',
      headers: {'content-type':'application/json'},
      body: JSON.stringify({
        dryRun, projectId,
        pmOptions: {
          useQA:          document.getElementById('pmOptQA')?.checked ?? true,
          useSecurity:    document.getElementById('pmOptSecurity')?.checked ?? true,
          useSpecialists: document.getElementById('pmOptSpecialists')?.checked ?? true,
          selfExtend:     document.getElementById('pmOptSelfExtend')?.checked ?? true,
          maxItems:       parseInt(document.getElementById('pmOptMaxItems')?.value || '200'),
          taskTimeoutMin: parseInt(document.getElementById('pmOptTimeout')?.value || '10'),
          extendEveryN:   parseInt(document.getElementById('pmOptExtendN')?.value || '5'),
          pauseSec:       parseInt(document.getElementById('pmOptPause')?.value || '5'),
          maxRetries:     parseInt(document.getElementById('pmOptMaxRetries')?.value || '2'),
          coderAgent:     document.getElementById('pmOptCoder')?.value.trim() || 'crew-coder',
        }
      })
    });
    const r = await resp.json();
    if (resp.status === 409 || r.alreadyRunning) {
      logBox.textContent = '⚠ Already running (pid ' + r.pid + '). Watch the log below.\\n';
      badge.textContent = 'running (pid ' + r.pid + ')';
      showNotification('PM Loop already running for this project (pid ' + r.pid + ')', true);
      startPmLogPoller();
      return;
    }
    logBox.textContent += '✅ Spawned (pid ' + r.pid + '). PM is reading roadmap...\\n';
    badge.textContent = 'running (pid ' + r.pid + ')';
    showNotification('PM Loop started' + (dryRun ? ' (dry run)' : '') + ' for ' + (proj ? proj.name : projectId));
    startPmLogPoller();
  } catch (e) {
    showNotification('PM Loop failed: ' + e.message, true);
    badge.textContent = 'idle';
    badge.classList.remove('running');
    startBtn.disabled = false;
    dryBtn.disabled = false;
  }
}

async function stopPmLoop() {
  const projectId = getSelectedProjectId();
  try {
    await fetch('/api/pm-loop/stop', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ projectId }) });
    showNotification('Stop signal sent — PM will finish current task then halt.');
    document.getElementById('pmLoopBadge').textContent = 'stopping...';
  } catch (e) { showNotification('Stop failed: ' + e.message, true); }
}

async function toggleRoadmap() {
  const panel = document.getElementById('pmRoadmapPanel');
  if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }
  try {
    const projectId = getSelectedProjectId();
    const proj = _buildProjects[projectId];
    // If we have a project selected, fetch its roadmap file directly via file API
    let content = '';
    if (proj && proj.roadmapFile) {
      const r = await fetch('/api/file-content?path=' + encodeURIComponent(proj.roadmapFile)).then(r2 => r2.json());
      content = r.content || '(empty)';
    } else {
      const r = await fetch('/api/pm-loop/roadmap').then(r2 => r2.json());
      content = r.content || '(empty)';
    }
    panel.textContent = content;
    panel.style.display = 'block';
  } catch (e) { panel.textContent = 'Could not load roadmap: ' + e.message; panel.style.display = 'block'; }
}

document.getElementById('pmStartBtn').onclick  = () => startPmLoop(false);
document.getElementById('pmDryRunBtn').onclick  = () => startPmLoop(true);
document.getElementById('pmStopBtn').onclick    = stopPmLoop;
document.getElementById('pmRoadmapBtn').onclick = toggleRoadmap;
// Check PM status after picker loads so we use the right projectId
loadBuildProjectPicker().then(() => checkPmStatus());
// Re-check status whenever the project picker changes
document.getElementById('buildProjectPicker').addEventListener('change', () => {
  if (pmPoller) { clearInterval(pmPoller); pmPoller = null; }
  checkPmStatus();
});
// ── Hash routing — persist active view across refresh ────────────────────────
// ── Hash routing ─────────────────────────────────────────────────────────────
// Patch each top-level show* function so calling it (via onclick or code)
// automatically updates location.hash. Refresh → restores the same tab.
const VIEW_MAP = {
  'chat':        showChat,
  'swarm':       showSwarm,
  'rt':          showRT,
  'dlq':         showDLQ,
  'files':       showFiles,
  'services':    showServices,
  'agents':      showAgents,
  'models':      showModels,
  'settings':    showSettings,
  'engines':     showEngines,
  'skills':      showSkills,
  'run-skills':  showRunSkills,
  'benchmarks':  showBenchmarks,
  'tool-matrix': showToolMatrix,
  'build':       showBuild,
  'messaging':   showMessaging,
  'projects':    showProjects,
};

// Wrap each show* so it updates the hash when called from anywhere
for (const [hash, fn] of Object.entries(VIEW_MAP)) {
  const original = fn;
  const wrapped = function(...args) {
    history.replaceState(null, '', '#' + hash);
    return original(...args);
  };
  // Update the reference in the map and on window (for onclick= handlers)
  VIEW_MAP[hash] = wrapped;
  window[original.name] = wrapped;
}

function navigateTo(view) {
  const fn = VIEW_MAP[view] || VIEW_MAP['chat'];
  fn();
}

// On load: restore from hash or default to chat
// Supports top-level (#chat, #services) and sub-tab deep links (#settings/telegram)
const startHash = (location.hash || '#chat').slice(1);
const [startView, startSubtab] = startHash.split('/');
const params = new URLSearchParams(window.location.search);
if (params.get('focus') === '1') {
  setTimeout(() => { const ci = document.getElementById('chatInput'); if (ci) { navigateTo('chat'); ci.focus(); } }, 500);
} else {
  navigateTo(startView || 'chat');
  if (startView === 'settings' && startSubtab) {
    showSettingsTab(startSubtab);
  }
}
// Resolve server-side env vars (HOME, cwd) once on boot
fetch('/api/env').then(r => r.json()).then(env => {
  window._crewHome = env.HOME || '';
  window._crewCwd  = env.cwd  || '';
  const filesDir = document.getElementById('filesDir');
  if (filesDir && !filesDir.value) filesDir.value = env.cwd || '';
}).catch(() => {});

loadAgents();
refreshAll();

// Wrap every type="password" input in a <form display:contents> so Chrome
// stops emitting "Password field is not contained in a form" warnings.
// Works for both static inputs and dynamically rendered provider key fields.
(function () {
  function wrapOrphanPwd(inp) {
    if (inp.closest('form')) return;
    const form = document.createElement('form');
    form.autocomplete = 'off';
    form.onsubmit = () => false;
    form.style.cssText = 'margin:0;padding:0;display:contents;';
    // Hidden username field — satisfies Chrome's "password forms need a username" check
    const u = document.createElement('input');
    u.type = 'text';
    u.autocomplete = 'username';
    u.setAttribute('aria-hidden', 'true');
    u.style.cssText = 'display:none;position:absolute;width:0;height:0;opacity:0;';
    form.appendChild(u);
    inp.parentNode.insertBefore(form, inp);
    form.appendChild(inp);
  }
  function scanAndWrap(root) {
    (root || document).querySelectorAll('input[type="password"]').forEach(wrapOrphanPwd);
  }
  scanAndWrap();
  const obs = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches && node.matches('input[type="password"]')) wrapOrphanPwd(node);
        else scanAndWrap(node);
      }
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}());

// ── Expose functions to global scope for inline HTML event handlers ───────────
// ── Global delegated click dispatcher ──────────────────────────────────────────
// MetaMask's SES lockdown runs onclick handlers in an isolated Compartment where
// neither globalThis.fn nor window.fn resolves. Using data-action + addEventListener
// bypasses the Compartment entirely — the listener closure has full module scope.
const ACTION_REGISTRY = {
  // Nav views
  showChat, showSwarm, showRT, showBuild, showFiles, showDLQ,
  showProjects, showAgents, showModels, showEngines, showSkills, showRunSkills,
  showBenchmarks, showToolMatrix, showServices, showSettings,
  // Static HTML actions (previously onclick="window.fn()")
  pickFolder:          (id) => pickFolder(id),
  loadFiles:           (force) => loadFiles(force === 'true' || force === true),
  clearChatHistory,
  sendChat,
  stopAll,
  killAll,
  loadServices,
  saveRTToken,
  startCrew,
  toggleEmojiPicker:   (id) => toggleEmojiPicker(id),
  bulkSetRoute:        (route, model) => bulkSetRoute(route, model),
  loadSpending,
  resetSpending,
  saveGlobalCaps,
  loadOcStats,
  addAllowlistPattern,
  sendTestWebhook,
  startTgBridge,
  stopTgBridge,
  saveTgConfig,
  loadTelegramSessions,
  loadTgMessages,
  startWaBridge,
  stopWaBridge,
  saveWaConfig,
  loadWaMessages,
  saveOpencodeSettings,
  saveGlobalFallback,
  toggleBgConsciousness,
  toggleCursorWaves,
  toggleClaudeCode,
  toggleCodexExecutor,
  saveGlobalOcLoop,
  saveGlobalOcLoopRounds,
  savePassthroughNotify,
  toggleAddSkill,
  toggleImportSkill,
  importSkillFromUrl,
  showSkills,
  saveSkill,
  cancelSkillForm,
  loadRunSkills,
  loadBenchmarks,
  loadBenchmarkLeaderboard,
  loadBenchmarkTasks,
  onBenchmarkTaskSelect,
  runBenchmarkTask,
  stopBenchmarkRun,
  loadEngines,
  toggleImportEngine,
  importEngineFromUrl,
  deleteEngine: (id) => deleteEngine(id),
  loadToolMatrix,
  loadBuildProjectPicker,
  // RT scroll button
  scrollRTToBottom: () => {
    const v = document.getElementById('rtView');
    if (v) v.scrollTop = v.scrollHeight;
  },
  toggleRTPause,
  clearRTMessages,
  togglePmAdvanced: () => {
    const el = document.getElementById('pmAdvanced');
    if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
  },
  // RT token visibility toggle
  toggleRTTokenVis: () => {
    const i = document.getElementById('rtTokenInput');
    if (i) i.type = i.type === 'password' ? 'text' : 'password';
  },
  // Services
  restartService: (id) => restartService(id),
  stopService:    (id) => stopService(id),
  // Files
  closePreviewPane,
  previewFile:    (path, el) => previewFile(path, el),
  // DLQ
  replayDLQ:      (key) => replayDLQ(key),
  deleteDLQ:      (key) => deleteDLQ(key),
  // Skills
  runSkillFromUI: (name) => runSkillFromUI(name),
  editSkill:      (name) => editSkill(name),
  deleteSkill:    (name) => deleteSkill(name),
  // Tool matrix
  restartAgentFromUI: (id) => restartAgentFromUI(id),
  // Models / providers
  saveSearchTool:      (id) => saveSearchTool(id),
  testSearchTool:      (id) => testSearchTool(id),
  saveBuiltinKey:      (id) => saveBuiltinKey(id),
  testBuiltinProvider: (id) => testBuiltinProvider(id),
  fetchBuiltinModels:  (id, el) => fetchBuiltinModels(id, el),
  saveKey:             (id) => saveKey(id),
  testKey:             (id) => testKey(id),
  fetchModels:         (id, el) => fetchModels(id, el),
  toggleKeyVis:        (inputId, el) => toggleKeyVis(inputId, el),
  // Agents
  toggleAgentBody: (id) => toggleAgentBody(id),
  deleteAgent:     (id) => deleteAgent(id),
  saveAgentModel:  (id) => saveAgentModel(id),
  saveAgentFallback: (id) => saveAgentFallback(id),
  toggleEmojiPicker: (id) => toggleEmojiPicker(id),
  saveAgentIdentity: (id) => saveAgentIdentity(id),
  saveAgentPrompt:   (id) => saveAgentPrompt(id),
  resetAgentSession: (id) => resetAgentSession(id),
  saveAgentTools:    (id) => saveAgentTools(id),
  applyToolPreset:   (id) => applyToolPreset(id),
  setRoute:          (id, route) => setRoute(id, route),
  saveOpenCodeConfig:   (id) => saveOpenCodeConfig(id),
  saveOpenCodeFallback: (id) => saveOpenCodeFallback(id),
  saveCursorCliConfig:  (id) => saveCursorCliConfig(id),
  saveClaudeCodeConfig: (id) => saveClaudeCodeConfig(id),
  // Settings tabs
  showSettingsTab: (tab) => showSettingsTab(tab),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  e.stopPropagation();
  const action = el.dataset.action;
  const fn = ACTION_REGISTRY[action];
  if (!fn) { console.warn('[CrewSwarm] unknown data-action:', action); return; }
  const arg  = el.dataset.arg  ?? null;
  const arg2 = el.dataset.arg2 ?? null;
  const needsEl = el.dataset.self === '1';
  if (arg !== null && arg2 !== null) fn(arg, arg2);
  else if (arg !== null && needsEl)  fn(arg, el);
  else if (arg !== null)             fn(arg);
  else if (needsEl)                  fn(el);
  else                               fn();
});

// ── Delegated change listener (data-onchange) ────────────────────────────────
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-onchange]');
  if (!el) return;
  const fn = ACTION_REGISTRY[el.dataset.onchange];
  if (!fn) return;
  // Pass element value if data-onchange-arg="this.value", otherwise no arg
  const arg = el.dataset.onchangeArg === 'this.value' ? el.value : null;
  arg !== null ? fn(arg) : fn();
});

// Wire chatInput keydown + oninput via addEventListener (SES-safe)
document.addEventListener('DOMContentLoaded', () => {
  // Set sidebar self-link to actual origin (avoids hardcoded localhost:4319)
  const dashLink = document.getElementById('dashSelfLink');
  if (dashLink) {
    dashLink.href = window.location.origin;
    dashLink.textContent = window.location.host;
  }

  const chatInput = document.getElementById('chatInput');
  if (chatInput) {
    chatInput.addEventListener('keydown', chatKeydown);
    chatInput.addEventListener('input',   chatAtAtInput);
  }
  const cmdInput = document.getElementById('cmdAllowlistInput');
  if (cmdInput) {
    cmdInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addAllowlistPattern();
    });
  }
  const waNumbers = document.getElementById('waAllowedNumbers');
  if (waNumbers) waNumbers.addEventListener('input', renderWaContactRows);
  const skillSearchInput = document.getElementById('skillSearch');
  if (skillSearchInput) skillSearchInput.addEventListener('input', (e) => filterSkills(e.target.value));
}, { once: true });

// Nav view delegation (data-view buttons in sidebar)
const NAV_VIEW_MAP = {
  chat: showChat, swarm: showSwarm, rt: showRT, build: showBuild,
  files: showFiles, dlq: showDLQ, projects: showProjects, agents: showAgents,
  models: showModels, engines: showEngines, skills: showSkills, 'run-skills': showRunSkills,
  benchmarks: showBenchmarks, 'tool-matrix': showToolMatrix,
  services: showServices, settings: showSettings,
};
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-view]');
  if (btn) { const fn = NAV_VIEW_MAP[btn.dataset.view]; if (fn) fn(); return; }
  const stab = e.target.closest('[data-stab]');
  if (stab) showSettingsTab(stab.dataset.stab);
  // Collapse/expand panels with data-toggle-child
  const tog = e.target.closest('[data-toggle-child]');
  if (tog) {
    const sel = tog.dataset.toggleChild;
    const body = tog.parentElement && tog.parentElement.querySelector(sel);
    if (body) body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
  // Collapse/expand next sibling with data-toggle-sibling (e.g. provider-header → provider-body)
  const togSib = e.target.closest('[data-toggle-sibling]');
  if (togSib && togSib.nextElementSibling) {
    togSib.nextElementSibling.classList.toggle(togSib.dataset.toggleSibling);
  }
});

// Vite wraps modules in a closure; onclick="window.fn()" attrs in static + dynamic HTML need window.fn.
Object.assign(window, {
  // ── Static HTML handlers ──
  addAllowlistPattern, applyNewAgentToolPreset, applyPromptPreset,
  bulkSetRoute, cancelSkillForm, chatAtAtInput, chatKeydown,
  clearChatHistory, filterSkills, loadAllUsage, loadBenchmarkLeaderboard,
  loadBenchmarks, loadBenchmarkTasks, onBenchmarkTaskSelect, runBenchmarkTask, stopBenchmarkRun,
  loadBuildProjectPicker, loadFiles, loadOcStats,
  loadRunSkills, loadServices, loadSpending, loadTelegramSessions,
  loadTgMessages, loadToolMatrix, loadWaMessages, onBuildProjectChange,
  onChatProjectChange, pickFolder, renderWaContactRows, resetSpending,
  saveGlobalCaps, saveGlobalFallback, saveOpencodeSettings, saveRTToken,
  saveSkill, saveTgConfig, saveWaConfig, sendChat, sendTestWebhook,
  showAgents, showBenchmarks, showBuild, showChat, showDLQ, showFiles,
  showModels, showProjects, showRT, showRunSkills, showServices,
  showSettings, showSettingsTab, showSkills, showSwarm, showToolMatrix,
  startCrew, startTgBridge, startWaBridge, stopTgBridge, stopWaBridge,
  toggleAddSkill, toggleBgConsciousness, toggleCursorWaves, toggleClaudeCode, toggleEmojiPicker,
  updateSkillAuthFields, navigateTo,
  renderStatusBadge, renderAgentCard, renderProviderCard,
  showLoading, showEmpty, showError,
  // ── Dynamic HTML handlers (innerHTML-rendered) ──
  applyToolPreset, closePreviewPane, deleteAgent, deleteSkill, editSkill,
  fetchBuiltinModels, fetchModels, previewFile, resetAgentSession,
  restartAgentFromUI, restartService, runSkillFromUI,
  saveAgentFallback, saveAgentIdentity, saveAgentModel, saveAgentPrompt,
  saveAgentTools, saveBuiltinKey, saveCursorCliConfig, saveKey,
  saveOpenCodeConfig, saveOpenCodeFallback, saveSearchTool, setRoute,
  stopService, testBuiltinProvider, testKey, testSearchTool,
  toggleAgentBody, toggleKeyVis,
});
