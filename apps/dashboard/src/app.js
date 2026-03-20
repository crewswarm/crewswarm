import { getJSON, postJSON } from "./core/api.js";
import {
  escHtml,
  showNotification,
  fmt,
  createdAt,
  appendChatBubble,
  showLoading,
  showEmpty,
  showError,
  renderStatusBadge,
} from "./core/dom.js";
import {
  sortAgents,
  state,
  persistState,
  saveScrollPosition,
  restoreScrollPosition,
} from "./core/state.js";
import { initActiveTasksPanel } from "./components/active-tasks-panel.js";
import { startOrchestrationStatusUpdates } from "./orchestration-status.js";
import "./cli-process.js";
import "./chat/unified-messages.js";
import {
  initSwarmChatTab,
  showSwarmChat,
  handleSwarmSSEEvent,
} from "./tabs/swarm-chat-tab.js";
import {
  showBenchmarks as showBenchmarksTab,
  loadBenchmarks,
  loadBenchmarkLeaderboard,
  loadBenchmarkTasks,
  onBenchmarkTaskSelect,
  runBenchmarkTask,
  stopBenchmarkRun,
} from "./tabs/benchmarks-tab.js";
import { initWavesTab } from "./tabs/waves-tab.js";
import { initWorkflowsTab, showWorkflows } from "./tabs/workflows-tab.js";
import {
  initMemoryTab,
  showMemory,
  loadMemoryStats,
  searchMemory,
  migrateMemory,
  compactMemory,
} from "./tabs/memory-tab.js";
import {
  initServicesTab,
  showServices,
  loadServices,
  restartService,
  stopService,
} from "./tabs/services-tab.js";
import {
  initAgentsTab,
  showAgents,
  loadAgents_cfg,
  applyToolPreset,
  toggleAgentBody,
  deleteAgent,
  saveAgentModel,
  saveAgentFallback,
  saveAgentVoice,
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
  saveGeminiCliConfig,
  saveCrewCLIConfig,
  bulkSetRoute,
  startCrew,
  populateModelDropdown,
  applyNewAgentToolPreset,
  applyPromptPreset,
} from "./tabs/agents-tab.js";
import { initPromptsTab } from "./tabs/prompts-tab.js";
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
} from "./tabs/skills-tab.js";
import {
  showContacts,
  loadContacts,
  applyContactFilters,
  initContactsList,
} from "./tabs/contacts-tab.js";
import {
  loadEngines,
  deleteEngine,
  toggleImportEngine,
  importEngineFromUrl,
} from "./tabs/engines-tab.js";
import { initChatActions } from "./chat/chat-actions.js";
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
} from "./tabs/swarm-tab.js";
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
} from "./tabs/models-tab.js";
import {
  initSettingsTab,
  loadOpenClawStatus,
  loadRTToken,
  saveRTToken,
  loadConfigLockStatus,
  lockConfig,
  unlockConfig,
  loadOpencodeProject,
  saveOpencodeSettings,
  saveOpencodeModel,
  loadBgConsciousness,
  toggleBgConsciousness,
  saveBgConsciousnessModel,
  loadCursorWaves,
  toggleCursorWaves,
  loadAutonomousMentions,
  toggleAutonomousMentions,
  loadClaudeCode,
  toggleClaudeCode,
  loadCodexExecutor,
  toggleCodexExecutor,
  loadGeminiCliExecutor,
  toggleGeminiCliExecutor,
  loadCrewCliExecutor,
  toggleCrewCliExecutor,
  loadOpencodeExecutor,
  toggleOpencodeExecutor,
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
} from "./tabs/settings-tab.js";
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
} from "./tabs/comms-tab.js";
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
} from "./tabs/projects-tab.js";
import {
  loadTokenUsage,
  loadOcStats as loadOcStatsFromUsage,
  loadToolMatrix,
  restartAgentFromUI,
  checkCrewLeadStatus,
  renderTaskLifecycle,
} from "./tabs/usage-tab.js";
import {
  loadAllUsage,
  loadSpending,
  resetSpending,
  saveGlobalCaps,
  reportOcCost,
} from "./tabs/spending-tab.js";
import {
  checkPmStatus,
  startPmLoop,
  stopPmLoop,
  toggleRoadmap,
  initPmLoopTab,
} from "./tabs/pm-loop-tab.js";

let selected = null;
let agents = [];
async function loadAgents() {
  try {
    agents = sortAgents(await getJSON("/api/agents"));
  } catch (e) {
    console.error("Failed to load agents:", e);
  }
}
// Lightweight status updater (just status dot + DLQ badge, no content loading)
async function updateStatusBadges() {
  try {
    const dot = document.getElementById("statusDot");
    document.getElementById("status").textContent = "online";
    dot.className = "status-dot online";
    await checkCrewLeadStatus();
    const dlqData = await getJSON("/api/dlq");
    const badge = document.getElementById("dlqBadge");
    if (dlqData.length) {
      badge.textContent = dlqData.length;
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  } catch (e) {
    document.getElementById("status").textContent = "error";
    document.getElementById("statusDot").className = "status-dot error";
  }
}

// Legacy alias for backwards compatibility
async function refreshAll() {
  await updateStatusBadges();
}
function setNavActive(navId) {
  document
    .querySelectorAll(".nav-item")
    .forEach((b) => b.classList.remove("active"));
  const el = document.getElementById(navId);
  if (el) el.classList.add("active");
}
function hideAllViews() {
  // Save scroll position of the current active view before hiding
  saveScrollPosition(state.activeTab);
  document.querySelectorAll(".view, .view-sessions").forEach((el) => {
    el.classList.remove("active");
    // Also clear any inline display styles that might interfere
    if (el.style.display) el.style.display = "";
  });
  const mb = document.querySelector(".msg-bar");
  if (mb) mb.style.display = "";
}

initServicesTab({ hideAllViews, setNavActive });
initAgentsTab({ hideAllViews, setNavActive, refreshAgents: loadAgents });
initSwarmTab({ hideAllViews, setNavActive });
initMemoryTab(state);
initWavesTab();
initWorkflowsTab({ hideAllViews, setNavActive });

async function pickFolder(inputId) {
  const input = document.getElementById(inputId);
  const def = encodeURIComponent(input?.value || window._crewHome || "");
  const d = await getJSON("/api/pick-folder?default=" + def).catch(() => null);
  if (d?.path) {
    if (input) input.value = d.path;
  }
}
async function loadCrewLeadInfo() {
  try {
    const d = await getJSON("/api/agents-config");
    const cl = (d.agents || []).find((a) => a.id === "crew-lead");
    if (!cl) return;
    window._crewLeadInfo = {
      emoji: cl.emoji || "🧠",
      name: cl.name || "crew-lead",
      theme: cl.theme || "",
    };
    const titleEl = document.getElementById("chatAgentTitle");
    const subEl = document.getElementById("chatAgentSub");
    if (titleEl)
      titleEl.textContent = (cl.emoji || "🧠") + " " + (cl.name || "Crew Lead");
    if (subEl && cl.theme)
      subEl.textContent =
        cl.theme + " — chat naturally, dispatch tasks to the crew";
  } catch (e) {
    /* keep defaults */
  }
}

/**
 * Hash routing: view id is only the segment before ? and before /.
 * e.g. #chat?project=general → view "chat" (NOT "chat?project=general").
 */
function parseRouteFromHash() {
  const raw = (location.hash || "#chat").slice(1);
  const noQuery = raw.split("?")[0] || "chat";
  const parts = noQuery.split("/");
  const view = parts[0] || "chat";
  const subtab = parts[1];
  return { view, subtab, raw };
}

function currentHashBaseView() {
  return parseRouteFromHash().view;
}

/**
 * Set chat project in the URL without firing hashchange — prevents a second
 * showChat() + loadChatHistory() that clears the thread while a reply streams.
 */
function setChatHashProject(projectId) {
  const id =
    projectId && String(projectId).trim() && projectId !== "undefined"
      ? projectId
      : "general";
  const next = `#chat?project=${encodeURIComponent(id)}`;
  if (location.hash !== next) {
    history.replaceState(null, "", next);
  }
}

async function showChat() {
  hideAllViews();
  document.getElementById("chatView").classList.add("active");
  setNavActive("navChat");
  state.activeTab = "chat";
  persistState();
  const mb = document.querySelector(".msg-bar");
  if (mb) mb.style.display = "none";

  // Start orchestration status updates
  startOrchestrationStatusUpdates();

  // Check if chat content is already loaded (DOM preserved from last visit)
  const chatBox = document.getElementById("chatMessages");
  if (chatBox?.dataset.historyLoading === "true") {
    await waitForChatHistoryIdle();
  }
  const alreadyLoaded =
    chatBox &&
    chatBox.dataset.historyLoaded === "true" &&
    chatBox.children.length > 0;

  // Refresh project dropdown (uses TTL cache so fast on re-visits)
  try {
    const data = await getJSON("/api/projects");
    const projects = data.projects || [];
    state.projectsData = {};
    projects.forEach((p) => {
      state.projectsData[p.id] = p;
    });
    persistState();
    populateChatProjectDropdown(projects);
  } catch (e) {
    console.warn("Failed to refresh projects dropdown:", e);
  }

  // Read project from URL first (most explicit), then localStorage, default to "general"
  const urlParams = new URLSearchParams(
    window.location.hash.replace(/^#chat\?/, ""),
  );
  const urlProject = urlParams.get("project");
  if (urlProject) {
    state.chatActiveProjectId = urlProject;
  } else {
    try {
      state.chatActiveProjectId =
        localStorage.getItem("crewswarm_chat_active_project_id") || "general";
    } catch {
      state.chatActiveProjectId = "general";
    }
  }

  // Set initial URL if not set (replaceState — no hashchange storm)
  if (!window.location.hash.includes("?project=")) {
    setChatHashProject(state.chatActiveProjectId);
  }

  console.log("🔵 [INIT] Active project from URL:", state.chatActiveProjectId);

  // Highlight the correct tab based on URL
  const tabsContainer = document.getElementById("chatProjectTabs");
  if (tabsContainer) {
    Array.from(tabsContainer.children).forEach((tab) => {
      if (tab.dataset.projectId === state.chatActiveProjectId) {
        tab.classList.add("active");
      } else {
        tab.classList.remove("active");
      }
    });
  }

  const sel = document.getElementById("chatProjectSelect");
  if (
    sel &&
    state.chatActiveProjectId &&
    sel.querySelector('option[value="' + state.chatActiveProjectId + '"]')
  )
    sel.value = state.chatActiveProjectId;
  checkCrewLeadStatus();
  startAgentReplyListener();
  loadCrewLeadInfo();

  // Load agents into chat agent selector
  if (window.loadChatAgentSelector) {
    window.loadChatAgentSelector();
  }

  // Only reload history if the chat box is empty (first visit or after clear)
  if (!alreadyLoaded) {
    await loadChatHistory();
  } else {
    // Restore scroll position from previous visit
    restoreScrollPosition("chat");
  }
}
function showFiles() {
  hideAllViews();
  document.getElementById("filesView").classList.add("active");
  setNavActive("navFiles");
  state.activeTab = "files";
  persistState();
  loadFiles();
}

// ── Chat / crew-lead ──────────────────────────────────────────────────────────
// Session ID: Always "owner" for dashboard, projectId handles isolation
function getChatSessionId() {
  return "owner";
}

let chatPollInterval = null;
let agentReplySSE = null;

/** Assistant rows from appendChatBubble use align-items:flex-start on the wrapper. */
function chatThreadHasAssistantText(box, text) {
  if (!box || text == null) return false;
  const want = String(text).trim();
  if (!want) return false;
  for (let i = box.children.length - 1; i >= 0; i--) {
    const row = box.children[i];
    if (row.id === "streaming-wrapper") continue;
    if (row.children.length < 2) continue;
    if (!String(row.style.alignItems || "").includes("flex-start")) continue;
    const bubble = row.children[1];
    if ((bubble.textContent || "").trim() === want) return true;
  }
  return false;
}

function startAgentReplyListener() {
  if (agentReplySSE) return; // already listening

  // Connect DIRECTLY to crew-lead's SSE endpoint (not via dashboard proxy)
  // This prevents SSE breakage when dashboard restarts
  const crewLeadPort = 5010;
  // Use same hostname as dashboard to avoid CORS issues (localhost vs 127.0.0.1)
  const hostname = window.location.hostname || '127.0.0.1';
  const sseUrl = `http://${hostname}:${crewLeadPort}/events`;

  console.log("[crewswarm] Starting EventSource listener for", sseUrl);
  agentReplySSE = new EventSource(sseUrl);
  const sseLog =
    typeof localStorage !== "undefined" &&
    localStorage.getItem("crewswarm_debug_sse") === "1";
  agentReplySSE.onmessage = (e) => {
    if (!e.data) {
      console.warn("[crewswarm] SSE message with null/empty data");
      return;
    }
    try {
      const d = JSON.parse(e.data);
      const normalizeProjectId = (value) =>
        !value || value === "general" ? "general" : value;
      const currentSessionId = getChatSessionId();

      if (sseLog) {
        console.log("[crewswarm] SSE:", d.type, e.data.slice(0, 120));
      }

      const box = document.getElementById("chatMessages");

      if (handleSwarmSSEEvent(d)) {
        return;
      }

      // Handle streaming tokens
      if (d.type === "chat_stream" && d.sessionId === currentSessionId) {
        const messageProjectId = normalizeProjectId(d.projectId);
        const currentProjId = normalizeProjectId(state.chatActiveProjectId);

        if (currentProjId !== messageProjectId) {
          return; // Wrong project, skip
        }

        let streamBubble = document.getElementById("streaming-bubble");
        if (!streamBubble) {
          // Create wrapper + label + bubble (matching appendChatBubble structure)
          const wrapper = document.createElement("div");
          wrapper.id = "streaming-wrapper";
          wrapper.style.cssText =
            "display:flex;flex-direction:column;align-items:flex-start;gap:4px;";

          const label = document.createElement("div");
          label.style.cssText =
            "font-size:11px;color:var(--text-3);padding:0 6px;";
          const cl = window._crewLeadInfo || { emoji: "🧠", name: "crew-lead" };
          label.textContent = cl.emoji + " " + cl.name + " (streaming...)";

          streamBubble = document.createElement("div");
          streamBubble.id = "streaming-bubble";
          streamBubble.className = "chat-bubble assistant";
          streamBubble.style.cssText =
            "max-width:80%;padding:10px 14px;border-radius:14px 14px 14px 4px;background:var(--surface-2);color:var(--text-2);font-size:14px;line-height:1.5;white-space:pre-wrap;word-break:break-word;border:1px solid var(--border);";
          // Keep a persistent text node so we can append chunks incrementally
          // instead of rewriting the whole bubble content on every frame.
          streamBubble._textNode = document.createTextNode("");
          streamBubble.appendChild(streamBubble._textNode);

          wrapper.appendChild(label);
          wrapper.appendChild(streamBubble);
          if (box) box.appendChild(wrapper);
        }

        // Batch token paint to animation frames for smoother streaming.
        const nextChunk = (streamBubble.dataset.streamChunk || "") + d.token;
        streamBubble.dataset.streamChunk = nextChunk;
        if (!streamBubble._rafId) {
          streamBubble._rafId = requestAnimationFrame(() => {
            const chunk = streamBubble.dataset.streamChunk || "";
            if (chunk) {
              if (!streamBubble._textNode) {
                streamBubble._textNode = document.createTextNode("");
                streamBubble.appendChild(streamBubble._textNode);
              }
              streamBubble._textNode.textContent += chunk;
              streamBubble.dataset.streamChunk = "";
            }
            if (box) box.scrollTop = box.scrollHeight;
            streamBubble._rafId = null;
          });
        }
        return;
      }

      if (d.type === "draft_discarded" && d.draftId) {
        const el = document.querySelector(
          '[data-draft-id="' + d.draftId + '"]',
        );
        if (el) el.remove();
        return;
      }
      if (d.type === "context_warning" && d.sessionId === getChatSessionId()) {
        const existing = document.getElementById("contextWarningBanner");
        if (existing) existing.remove();
        const banner = document.createElement("div");
        banner.id = "contextWarningBanner";
        const isCritical = d.level === "critical";
        banner.style.cssText = `display:flex;align-items:center;gap:10px;padding:8px 14px;border-radius:8px;margin:6px 0;font-size:12px;background:${isCritical ? "rgba(239,68,68,0.1)" : "rgba(245,158,11,0.1)"};border:1px solid ${isCritical ? "rgba(239,68,68,0.3)" : "rgba(245,158,11,0.3)"};color:${isCritical ? "#f87171" : "#f59e0b"};`;
        banner.innerHTML = `<span style="flex:1;">${d.message}</span><button onclick="clearChatHistory()" style="padding:2px 8px;font-size:11px;border-radius:4px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer;">Clear now</button><button onclick="this.parentElement.remove()" style="background:none;border:none;cursor:pointer;color:inherit;font-size:14px;padding:0 2px;">✕</button>`;
        const box = document.getElementById("chatMessages");
        if (box) {
          box.appendChild(banner);
          box.scrollTop = box.scrollHeight;
        }
        return;
      }
      if (d.type === "chat_message" && d.sessionId === getChatSessionId()) {
        // Additional check: if message has projectId, only show if it matches current project
        const currentProjectId = normalizeProjectId(state.chatActiveProjectId);
        const messageProjectId = normalizeProjectId(d.projectId);

        if (currentProjectId !== messageProjectId) {
          console.log("[crewswarm] ❌ SKIP - projectId mismatch:", {
            current: currentProjectId || "(General)",
            message: messageProjectId || "(General)",
          });
          return;
        }

        console.log("[crewswarm] ✅ Displaying message for current session");

        if (d.role === "user") {
          // Skip SSE echo of messages we already appended locally via sendChat()
          if (d.content === lastSentContent) {
            console.log("[crewswarm] Skipping SSE echo of locally-sent message");
            lastSentContent = null;
            return;
          }
          if (d.content !== lastAppendedUserContent) {
            console.log(
              "[crewswarm] Appending user bubble:",
              d.content.slice(0, 50),
            );
            appendChatBubble("user", d.content);
            lastAppendedUserContent = d.content;
          } else {
            console.log("[crewswarm] Skipping duplicate user message");
          }
        } else if (d.role === "assistant") {
          document
            .querySelectorAll('[id^="typing-"]')
            .forEach((el) => el.remove());

          const streamWrapper = document.getElementById("streaming-wrapper");
          const streamBubble = document.getElementById("streaming-bubble");

          if (streamBubble) {
            if (streamBubble._rafId) cancelAnimationFrame(streamBubble._rafId);
            streamBubble._rafId = null;
            const pending = streamBubble.dataset.streamChunk || "";
            if (pending) {
              if (!streamBubble._textNode) {
                streamBubble._textNode = document.createTextNode("");
                streamBubble.appendChild(streamBubble._textNode);
              }
              streamBubble._textNode.textContent += pending;
              streamBubble.dataset.streamChunk = "";
            }
          }

          // Promote streaming row → final bubble in place (do NOT remove then re-append).
          // Removing the stream loses the only visible copy if append/skip heuristics race.
          if (streamWrapper && streamBubble) {
            const cl = window._crewLeadInfo || { emoji: "🧠", name: "crew-lead" };
            const labelEl = streamWrapper.firstElementChild;
            if (labelEl && labelEl !== streamBubble) {
              labelEl.textContent = cl.emoji + " " + cl.name;
            }
            const finalText = d.content ?? "";
            if (streamBubble._textNode) {
              streamBubble._textNode.textContent = finalText;
            } else {
              streamBubble.textContent = finalText;
            }
            streamWrapper.removeAttribute("id");
            streamBubble.removeAttribute("id");
            delete streamBubble.dataset.streamChunk;
            lastAppendedAssistantContent = d.content;
          } else {
            if (streamWrapper) streamWrapper.remove();
            const skipDuplicate =
              d.content === lastAppendedAssistantContent &&
              chatThreadHasAssistantText(box, d.content);
            if (!skipDuplicate) {
              console.log("[crewswarm] Appending assistant bubble (final)");
              appendChatBubble(
                "assistant",
                d.content,
                d.fallbackModel,
                d.fallbackReason,
                d.model,
                d.engineUsed,
              );
              lastAppendedAssistantContent = d.content;
            } else {
              console.log("[crewswarm] Skipping duplicate assistant message");
            }
          }
        }
        if (box) box.scrollTop = box.scrollHeight;
        return;
      }
      if (
        d.type === "pending_project" &&
        d.sessionId === getChatSessionId() &&
        d.pendingProject &&
        box
      ) {
        appendRoadmapCard(box, d.pendingProject);
        box.scrollTop = box.scrollHeight;
        return;
      }
      // agent_working from OpenCode bridge — show pulsing coding dot on agent card
      if (d.type === "agent_working" && d.agent) {
        const dot = document.getElementById("coding-dot-" + d.agent);
        if (dot) dot.style.display = "inline-flex";
      }
      // agent_idle from OpenCode bridge — hide coding dot
      if (d.type === "agent_idle" && d.agent) {
        const dot = document.getElementById("coding-dot-" + d.agent);
        if (dot) dot.style.display = "none";
      }
      // OpenCode serve live events — tool calls, file edits, session boundaries
      if (d.type === "opencode_event") {
        const feed = document.getElementById("ocFeed");
        const liveDot = document.getElementById("ocFeedDot");
        if (!feed) return;
        if (liveDot) liveDot.style.display = "inline-block";
        const row = document.createElement("div");
        row.style.cssText =
          "display:flex;align-items:center;gap:8px;padding:5px 10px;border-radius:8px;background:var(--bg-2);font-size:12px;font-family:var(--font-mono,monospace);animation:fadeIn .25s ease;";
        const time = new Date(d.ts || Date.now()).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        let icon = "⚙️",
          label = "";
        if (d.kind === "session_start") {
          icon = "▶";
          row.style.borderLeft = "3px solid var(--green-hi)";
          var _sd = d.dir || "";
          label = "session started" + (_sd ? " — " + _sd.split("/").pop() : "");
        } else if (d.kind === "session_end") {
          icon = "■";
          row.style.borderLeft = "3px solid var(--text-3)";
          label = "session ended";
          if (liveDot) liveDot.style.display = "none";
        } else if (d.kind === "file_edit") {
          icon = "✏️";
          row.style.borderLeft = "3px solid var(--amber)";
          label =
            (d.file || d.path || "") +
            (d.extra
              ? ' <span style="opacity:.5;">' + d.extra + "</span>"
              : "");
        } else if (d.kind === "error") {
          icon = "✗";
          row.style.borderLeft = "3px solid var(--red-hi)";
          row.style.color = "var(--red-hi)";
          label = d.message || "error";
        } else if (d.kind === "tool") {
          const toolColors = {
            read_file: "var(--accent)",
            write_file: "var(--amber)",
            bash: "var(--purple)",
            list_directory: "var(--green)",
            grep: "var(--green)",
          };
          const tc = toolColors[d.tool] || "var(--text-2)";
          icon = d.phase === "done" ? "✓" : "→";
          row.style.borderLeft = "3px solid " + tc;
          row.style.color =
            d.phase === "done" ? "var(--text-2)" : "var(--text-1)";
          label =
            '<span style="color:' +
            tc +
            ';font-weight:600;">' +
            (d.tool || "") +
            "</span>" +
            (d.label
              ? ' <span style="opacity:.6;">' + d.label + "</span>"
              : "");
        }
        row.innerHTML =
          '<span style="opacity:.4;flex-shrink:0;">' +
          time +
          "</span>" +
          '<span style="flex-shrink:0;">' +
          icon +
          "</span>" +
          '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
          label +
          "</span>";
        feed.appendChild(row);
        // Cap at 80 rows
        while (feed.children.length > 80) feed.removeChild(feed.firstChild);
        feed.scrollTop = feed.scrollHeight;
        return;
      }
      // agent_working: crew-lead dispatched a task — show a "waiting" indicator
      if (d.type === "agent_working" && d.agent) {
        const spinnerId = "agent-spinner-" + (d.taskId || d.agent);
        if (box && !document.getElementById(spinnerId)) {
          const el = document.createElement("div");
          el.id = spinnerId;
          el.className = "msg a";
          el.style.cssText = "opacity:.7; font-style:italic;";
          el.innerHTML =
            '<div class="meta"><strong>' +
            d.agent +
            "</strong> · working…</div>" +
            '<div class="t" style="display:flex;align-items:center;gap:8px;">' +
            '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--accent);animation:pulse 1s ease-in-out infinite;"></span>' +
            "Processing task…</div>";
          box.appendChild(el);
          box.scrollTop = box.scrollHeight;
        }
        return;
      }
      // agent_reply: task completion from any crew member — replace spinner, show reply, notify
      if (d.type === "agent_reply" || (d.from && d.content)) {
        if (!d.from || !d.content) return;
        // Skip passthrough summaries — the dashboard already rendered the live stream
        if (d._passthroughSummary) return;
        const spinnerId = "agent-spinner-" + (d.taskId || d.from);
        const spinnerEl = document.getElementById(spinnerId);
        if (spinnerEl) spinnerEl.remove();
        const agentSpinner = document.getElementById("agent-spinner-" + d.from);
        if (agentSpinner) agentSpinner.remove();
        appendChatBubble(
          "🤖 " + d.from,
          d.content,
          false,
          null,
          null,
          d.engineUsed,
        );
        if (box) box.scrollTop = box.scrollHeight;
        showNotification(d.from + " finished a task");
        return;
      }
      // task.timeout: dispatch never claimed or timed out — replace spinner with "No reply" message
      if (d.type === "task.timeout" && d.agent) {
        const spinnerId = "agent-spinner-" + (d.taskId || d.agent);
        const spinnerEl = document.getElementById(spinnerId);
        if (spinnerEl) spinnerEl.remove();
        const agentSpinner = document.getElementById(
          "agent-spinner-" + d.agent,
        );
        if (agentSpinner) agentSpinner.remove();
        const msg =
          "[crew-lead] Task to " +
          d.agent +
          " timed out (no reply in 90s). Consider @@SERVICE restart " +
          d.agent +
          " or re-dispatch to another agent.";
        if (box) {
          const el = document.createElement("div");
          el.className = "msg a";
          el.style.cssText =
            "opacity:.85; font-style:italic; color:var(--text-3);";
          el.innerHTML =
            '<div class="meta"><strong>' +
            d.agent +
            '</strong> · no reply</div><div class="t">' +
            escHtml(msg) +
            "</div>";
          box.appendChild(el);
          box.scrollTop = box.scrollHeight;
        }
        showNotification("Task to " + d.agent + " timed out");
        return;
      }
      // pipeline_progress: a wave or step dispatched
      if (d.type === "pipeline_progress") {
        let label;
        if (d.agents) {
          label =
            "Wave " +
            (d.waveIndex + 1) +
            "/" +
            d.totalWaves +
            " → " +
            d.agents.join(" + ");
        } else {
          label = "Step " + (d.stepIndex + 1) + "/" + d.total + " → " + d.agent;
        }
        const el = document.createElement("div");
        el.style.cssText =
          "font-size:11px;color:var(--text-3);padding:2px 8px;margin:2px 0;";
        el.textContent = "↳ " + label;
        if (box) {
          box.appendChild(el);
          box.scrollTop = box.scrollHeight;
        }
        return;
      }
      // pipeline_quality_gate: wave had issues
      if (d.type === "pipeline_quality_gate") {
        const el = document.createElement("div");
        const retryNote = d.willRetry
          ? " — retrying wave"
          : " — advancing anyway";
        el.style.cssText =
          "font-size:11px;color:var(--warning, #e8a030);padding:2px 8px;margin:2px 0;";
        el.textContent =
          "⚠️ Wave " +
          (d.waveIndex + 1) +
          " quality gate: " +
          (d.issues || []).join("; ") +
          retryNote;
        if (box) {
          box.appendChild(el);
          box.scrollTop = box.scrollHeight;
        }
        return;
      }
      // project_launched: new project registered — reload dropdown and auto-select
      if (d.type === "project_launched" && d.project) {
        const newId = d.project.projectId || d.project.id;
        setTimeout(async () => {
          await loadProjects();
          if (newId) autoSelectChatProject(newId);
          const box = document.getElementById("chatMessages");
          if (box) {
            const el = document.createElement("div");
            el.style.cssText =
              "font-size:11px;color:var(--green);padding:2px 8px;margin:2px 0;";
            el.textContent =
              '📁 Project "' +
              (d.project.name || newId) +
              '" registered — selected in chat';
            box.appendChild(el);
            box.scrollTop = box.scrollHeight;
          }
        }, 800);
        return;
      }
      // pipeline_done: all steps complete
      if (d.type === "pipeline_done") {
        const el = document.createElement("div");
        el.style.cssText =
          "font-size:11px;color:var(--green);padding:2px 8px;margin:2px 0;";
        el.textContent = "✅ Pipeline complete";
        if (box) {
          box.appendChild(el);
          box.scrollTop = box.scrollHeight;
        }
        return;
      }
      // confirm_run_cmd: an agent wants to run a shell command — show approval toast
      if (d.type === "confirm_run_cmd" && d.approvalId) {
        showCmdApprovalToast(d.approvalId, d.agent, d.cmd);
        return;
      }
      // telemetry: task.lifecycle (schema 1.1) — keep list and refresh Task lifecycle panel if visible
      if (d.type === "telemetry" && d.payload) {
        window._telemetryEvents = window._telemetryEvents || [];
        window._telemetryEvents.push(d.payload);
        if (window._telemetryEvents.length > 100)
          window._telemetryEvents.shift();
        const tlView = document.getElementById("toolMatrixView");
        if (tlView && tlView.classList.contains("active"))
          renderTaskLifecycle(window._telemetryEvents);
      }
    } catch {}
  };
  agentReplySSE.onopen = () => {
    console.log("[crewswarm] SSE connection opened");
    window._sseReconnectDelay = 2000;
  };
  agentReplySSE.onerror = (err) => {
    console.error("[crewswarm] SSE error:", err);
    agentReplySSE.close();
    agentReplySSE = null;
    // Reconnect with exponential backoff (2s → 4s → 8s → 30s max)
    if (window._sseReconnectTimer) clearTimeout(window._sseReconnectTimer);
    window._sseReconnectTimer = setTimeout(() => {
      window._sseReconnectTimer = null;
      window._sseReconnectDelay = Math.min(
        (window._sseReconnectDelay || 2000) * 2,
        30000,
      );
      startAgentReplyListener();
    }, window._sseReconnectDelay || 2000);
  };
}

// ── Command approval toast ────────────────────────────────────────────────────

function showCmdApprovalToast(approvalId, agent, cmd) {
  const existing = document.getElementById("cmd-approval-" + approvalId);
  if (existing) return;

  const toast = document.createElement("div");
  toast.id = "cmd-approval-" + approvalId;
  toast.style.cssText = [
    "position:fixed;bottom:80px;right:24px;z-index:9999;",
    "background:var(--bg-card);border:1px solid var(--border);border-radius:12px;",
    "padding:16px 20px;max-width:440px;box-shadow:0 8px 32px rgba(0,0,0,.4);",
    "display:flex;flex-direction:column;gap:10px;",
  ].join("");

  const header = document.createElement("div");
  header.style.cssText = "font-size:13px;font-weight:600;color:var(--text-1);";
  header.textContent = "🔐 " + agent + " wants to run a command";

  const cmdEl = document.createElement("code");
  cmdEl.style.cssText =
    "display:block;font-size:12px;color:var(--accent);background:var(--bg-1);padding:6px 10px;border-radius:6px;word-break:break-all;";
  cmdEl.textContent = cmd;

  // "Always allow" toggle — infers pattern from first word of command
  const alwaysRow = document.createElement("label");
  alwaysRow.style.cssText =
    "display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-2);cursor:pointer;";
  const alwaysChk = document.createElement("input");
  alwaysChk.type = "checkbox";
  alwaysChk.style.cssText =
    "width:14px;height:14px;cursor:pointer;accent-color:var(--green);";
  const cmdBase = cmd.trim().split(/\s+/)[0];
  const suggestedPattern = cmdBase + " *";
  alwaysRow.appendChild(alwaysChk);
  alwaysRow.appendChild(document.createTextNode("Always allow  "));
  const patternSpan = document.createElement("code");
  patternSpan.style.cssText =
    "font-size:11px;background:var(--bg-1);padding:2px 6px;border-radius:4px;color:var(--accent);";
  patternSpan.textContent = suggestedPattern;
  alwaysRow.appendChild(patternSpan);

  const timer = document.createElement("div");
  timer.style.cssText = "font-size:11px;color:var(--text-3);";
  let secs = 60;
  timer.textContent = "Auto-reject in " + secs + "s";
  const countdown = setInterval(() => {
    secs--;
    timer.textContent = "Auto-reject in " + secs + "s";
    if (secs <= 0) {
      clearInterval(countdown);
      toast.remove();
    }
  }, 1000);

  const btns = document.createElement("div");
  btns.style.cssText = "display:flex;gap:8px;";

  const approve = document.createElement("button");
  approve.textContent = "✅ Allow";
  approve.style.cssText =
    "flex:1;padding:8px;border-radius:8px;border:none;background:var(--green);color:#fff;cursor:pointer;font-weight:600;font-size:13px;";
  approve.onclick = async () => {
    clearInterval(countdown);
    toast.remove();
    if (alwaysChk.checked) {
      await fetch("/api/cmd-allowlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pattern: suggestedPattern }),
      });
      showNotification("Allowlisted: " + suggestedPattern);
    }
    await fetch("/api/cmd-approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalId }),
    }).catch((e) => showNotification("Approve failed: " + e.message, true));
    if (!alwaysChk.checked) showNotification(agent + ": command approved");
  };

  const reject = document.createElement("button");
  reject.textContent = "⛔ Deny";
  reject.style.cssText =
    "flex:1;padding:8px;border-radius:8px;border:none;background:var(--red-hi);color:#fff;cursor:pointer;font-weight:600;font-size:13px;";
  reject.onclick = async () => {
    clearInterval(countdown);
    toast.remove();
    await fetch("/api/cmd-reject", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalId }),
    }).catch((e) => showNotification("Reject failed: " + e.message, true));
    showNotification(agent + ": command denied");
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
  { label: "npm", pattern: "npm *", desc: "install, run, build, test…" },
  { label: "node", pattern: "node *", desc: "run any node script" },
  { label: "python", pattern: "python *", desc: "python / python3 scripts" },
  { label: "pip", pattern: "pip *", desc: "pip install packages" },
  { label: "git", pattern: "git *", desc: "all git operations" },
  { label: "cursor", pattern: "cursor *", desc: "open files in Cursor" },
  { label: "make", pattern: "make *", desc: "Makefile targets" },
  { label: "yarn", pattern: "yarn *", desc: "yarn install / build / run" },
  { label: "pnpm", pattern: "pnpm *", desc: "pnpm package manager" },
  {
    label: "ls / cat / echo",
    pattern: "ls *",
    desc: "read-only shell utilities",
  },
];

async function loadCmdAllowlist() {
  const box = document.getElementById("cmdAllowlistItems");
  const presetsBox = document.getElementById("cmdPresets");
  if (!box) return;

  const d = await getJSON("/api/cmd-allowlist").catch(() => ({ list: [] }));
  const list = d.list || [];

  // Render presets checklist (only when the presets container exists — Settings view)
  if (presetsBox) {
    presetsBox.innerHTML = "";
    CMD_PRESETS.forEach(function (preset) {
      const checked = list.includes(preset.pattern);
      const row = document.createElement("label");
      row.style.cssText =
        "display:flex;align-items:center;gap:8px;cursor:pointer;padding:4px 6px;border-radius:6px;transition:background 0.1s;";
      row.onmouseover = function () {
        row.style.background = "var(--bg-hover)";
      };
      row.onmouseout = function () {
        row.style.background = "";
      };

      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.checked = checked;
      chk.style.cssText =
        "width:14px;height:14px;cursor:pointer;accent-color:var(--green);flex-shrink:0;";
      chk.onchange = async function () {
        if (chk.checked) {
          await fetch("/api/cmd-allowlist", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ pattern: preset.pattern }),
          }).catch((e) =>
            showNotification("Failed to add pattern: " + e.message, true),
          );
        } else {
          await fetch("/api/cmd-allowlist", {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ pattern: preset.pattern }),
          }).catch((e) =>
            showNotification("Failed to remove pattern: " + e.message, true),
          );
        }
        loadCmdAllowlist();
      };

      const nameEl = document.createElement("code");
      nameEl.style.cssText =
        "font-size:12px;color:var(--accent);min-width:90px;";
      nameEl.textContent = preset.pattern;

      const descEl = document.createElement("span");
      descEl.style.cssText = "font-size:11px;color:var(--text-3);";
      descEl.textContent = preset.desc;

      row.appendChild(chk);
      row.appendChild(nameEl);
      row.appendChild(descEl);
      presetsBox.appendChild(row);
    });
  }

  // Render active list (non-preset patterns only, or all if no presets box)
  const presetPatterns = new Set(
    CMD_PRESETS.map(function (p) {
      return p.pattern;
    }),
  );
  const customPatterns = presetsBox
    ? list.filter(function (p) {
        return !presetPatterns.has(p);
      })
    : list;

  box.innerHTML = "";
  if (!customPatterns.length) {
    box.innerHTML =
      '<div style="color:var(--text-3);font-size:12px;padding:4px 0;">' +
      (presetsBox ? "No custom patterns yet." : "No patterns yet.") +
      "</div>";
    return;
  }
  for (const pattern of customPatterns) {
    const row = document.createElement("div");
    row.style.cssText =
      "display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);";
    const code = document.createElement("code");
    code.style.cssText = "flex:1;font-size:12px;color:var(--accent);";
    code.textContent = pattern;
    const del = document.createElement("button");
    del.textContent = "✕";
    del.style.cssText =
      "border:none;background:transparent;color:var(--text-3);cursor:pointer;font-size:14px;padding:0 4px;";
    del.title = "Remove";
    del.onclick = async function () {
      await fetch("/api/cmd-allowlist", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pattern }),
      }).catch((e) =>
        showNotification("Failed to delete pattern: " + e.message, true),
      );
      loadCmdAllowlist();
    };
    row.appendChild(code);
    row.appendChild(del);
    box.appendChild(row);
  }
}

async function addAllowlistPattern() {
  const inp = document.getElementById("cmdAllowlistInput");
  const pattern = inp ? inp.value.trim() : "";
  if (!pattern) return;
  await fetch("/api/cmd-allowlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pattern }),
  }).catch((e) =>
    showNotification("Failed to add pattern: " + e.message, true),
  );
  inp.value = "";
  loadCmdAllowlist();
}

// Token usage + Tool Matrix → tabs/usage-tab.js
window._telemetryEvents = window._telemetryEvents || [];

const loadOcStats = () => loadOcStatsFromUsage(reportOcCost);

function appendRoadmapCard(box, { draftId, name, outputDir, roadmapMd }) {
  function countTasks(md) {
    return (md.match(/^- \[ \]/gm) || []).length;
  }

  const wrap = document.createElement("div");
  wrap.setAttribute("data-draft-id", draftId);
  wrap.style.cssText = "width:100%;display:flex;flex-direction:column;gap:4px;";

  const lbl = document.createElement("div");
  lbl.style.cssText = "font-size:11px;color:var(--text-3);padding:0 6px;";
  lbl.textContent = "🗺️ Roadmap draft — review before building";

  const card = document.createElement("div");
  card.style.cssText =
    "width:100%;border:1px solid var(--border);border-radius:12px;overflow:hidden;background:var(--bg-card);";

  const header = document.createElement("div");
  header.style.cssText =
    "background:var(--bg-card2);padding:10px 14px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);";
  header.innerHTML =
    '<div><div style="font-size:13px;font-weight:600;color:var(--accent);">🚀 ' +
    name +
    '</div><div style="font-size:11px;color:var(--blue);margin-top:2px;">' +
    outputDir +
    "</div></div>" +
    '<span style="font-size:10px;color:var(--text-3);padding:2px 7px;background:var(--bg-card2);border-radius:10px;" class="task-count">' +
    countTasks(roadmapMd) +
    " tasks</span>";

  const ta = document.createElement("textarea");
  ta.value = roadmapMd;
  ta.spellcheck = false;
  ta.style.cssText =
    "width:100%;background:var(--bg-card);border:none;outline:none;color:var(--text-1);font-size:11.5px;font-family:SF Mono,Monaco,Menlo,monospace;line-height:1.6;padding:12px 14px;resize:none;min-height:160px;max-height:320px;display:block;";
  setTimeout(() => {
    ta.style.height = "";
    ta.style.height = Math.min(ta.scrollHeight, 320) + "px";
  }, 50);
  ta.addEventListener("input", () => {
    ta.style.height = "";
    ta.style.height = Math.min(ta.scrollHeight, 320) + "px";
    header.querySelector(".task-count").textContent =
      countTasks(ta.value) + " tasks";
  });

  const actions = document.createElement("div");
  actions.style.cssText =
    "display:flex;gap:8px;align-items:center;padding:10px 14px 12px;border-top:1px solid var(--border);background:var(--bg-card2);";

  const startBtn = document.createElement("button");
  startBtn.textContent = "▶ Start Building";
  startBtn.style.cssText =
    "background:var(--green-hi);color:#000;border:none;border-radius:8px;padding:8px 16px;font-size:12px;font-weight:700;cursor:pointer;";
  startBtn.onclick = async () => {
    startBtn.disabled = true;
    startBtn.textContent = "⏳ Launching…";
    try {
      const r = await postJSON("/api/crew-lead/confirm-project", {
        draftId,
        roadmapMd: ta.value,
      });
      if (r.ok) {
        card.innerHTML =
          '<div style="padding:14px;color:var(--green-hi);font-size:13px;font-weight:600;">✅ ' +
          name +
          ' — project created, PM loop running!<br><span style="color:var(--blue);font-size:11px;font-weight:400">' +
          (r.outputDir || outputDir) +
          "</span></div>";
        appendChatBubble(
          "assistant",
          "🚀 " +
            name +
            " is building. Check the Projects tab to watch progress.",
        );
      } else {
        startBtn.disabled = false;
        startBtn.textContent = "▶ Start Building";
        status.textContent = "⚠️ " + (r.error || "Launch failed");
      }
    } catch (e) {
      startBtn.disabled = false;
      startBtn.textContent = "▶ Start Building";
      status.textContent = "⚠️ " + e.message;
    }
  };

  const discardBtn = document.createElement("button");
  discardBtn.textContent = "Discard";
  discardBtn.style.cssText =
    "background:none;border:1px solid var(--border);color:var(--text-3);border-radius:8px;padding:8px 14px;font-size:12px;cursor:pointer;";
  discardBtn.onclick = async () => {
    await postJSON("/api/crew-lead/discard-project", { draftId }).catch(
      () => {},
    );
    wrap.remove();
  };

  const status = document.createElement("span");
  status.style.cssText = "font-size:11px;color:var(--blue);margin-left:auto;";
  status.textContent = "Edit above, then confirm";

  actions.appendChild(startBtn);
  actions.appendChild(discardBtn);
  actions.appendChild(status);
  card.appendChild(header);
  card.appendChild(ta);
  card.appendChild(actions);
  wrap.appendChild(lbl);
  wrap.appendChild(card);
  box.appendChild(wrap);
  box.scrollTop = box.scrollHeight;
}

let lastAppendedAssistantContent = "";
let lastAppendedUserContent = "";
let lastSentContent = null;
const {
  loadChatHistory,
  waitForChatHistoryIdle,
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
  resetSendButton,
  handleImageUpload,
  toggleVoiceRecording,
} = initChatActions({
  postJSON,
  getJSON,
  appendChatBubble,
  showNotification,
  state,
  getChatSessionId: () => getChatSessionId(),
  getChatActiveProjectId: () => state.chatActiveProjectId,
  getCrewLeadInfo: () => window._crewLeadInfo,
  appendRoadmapCard,
  getLastAppendedAssistantContent: () => lastAppendedAssistantContent,
  setLastAppendedAssistantContent: (value) => {
    lastAppendedAssistantContent = value;
  },
  setLastAppendedUserContent: (value) => {
    lastAppendedUserContent = value;
  },
  setLastSentContent: (value) => {
    lastSentContent = value;
  },
});

// Wire up multimodal buttons
document.getElementById("attachImageBtn")?.addEventListener("click", () => {
  document.getElementById("imageUpload").click();
});
document
  .getElementById("imageUpload")
  ?.addEventListener("change", handleImageUpload);
document
  .getElementById("recordVoiceBtn")
  ?.addEventListener("click", toggleVoiceRecording);

// Expose loadChatHistory globally for project tab switching
window.loadChatHistory = loadChatHistory;

// Expose getChatSessionId for testing and debugging
window.getChatSessionId = getChatSessionId;

// Expose selectProjectTab for General tab onclick in HTML
window.selectProjectTab = (projectId) => {
  // Normalize: missing or invalid id => general (avoids #chat?project=undefined)
  const normalizedId =
    projectId && String(projectId).trim() && projectId !== "undefined"
      ? projectId
      : "general";
  const currentProjectId = state.chatActiveProjectId;
  console.log(
    "🔵 [TAB CLICK] START",
    normalizedId,
    "- from:",
    currentProjectId,
  );

  const tabsContainer = document.getElementById("chatProjectTabs");
  if (!tabsContainer) {
    console.error("🔵 [TAB CLICK] ERROR: chatProjectTabs container not found!");
    return;
  }

  if (currentProjectId === normalizedId) {
    console.log("🔵 [TAB CLICK] Already on this tab, skipping reload");
    return;
  }

  setChatHashProject(normalizedId);

  // Update UI: deactivate all, activate selected
  Array.from(tabsContainer.children).forEach((tab) => {
    tab.classList.remove("active");
  });

  const selectedTab = Array.from(tabsContainer.children).find(
    (tab) => tab.dataset.projectId === normalizedId,
  );
  if (selectedTab) {
    selectedTab.classList.add("active");
  }

  state.chatActiveProjectId = normalizedId;
  try {
    localStorage.setItem("crewswarm_chat_active_project_id", normalizedId);
  } catch {}

  console.log("🔵 [TAB CLICK] Updated state:", {
    projectId: state.chatActiveProjectId,
    sessionId: getChatSessionId(),
    url: window.location.hash,
  });

  console.log("🔵 [TAB CLICK] Calling loadChatHistory()...");

  // Reload history
  loadChatHistory()
    .then(() => {
      console.log("🔵 [TAB CLICK] loadChatHistory() completed");
      const box = document.getElementById("chatMessages");
      console.log("🔵 [TAB CLICK] Messages in DOM:", box?.children.length || 0);
    })
    .catch((err) => {
      console.error("🔵 [TAB CLICK] loadChatHistory() ERROR:", err);
    });
};

/* services tab extracted to tabs/services-tab.js */
async function loadFiles(forceRefresh) {
  const el = document.getElementById("filesContent");
  const dir =
    document.getElementById("filesDir").value.trim() ||
    window._crewCwd ||
    (window._crewHome ? window._crewHome + "/Desktop/crewswarm" : "");
  showLoading(el, "Scanning " + dir + "...");
  try {
    const data = await getJSON("/api/files?dir=" + encodeURIComponent(dir));
    if (!data.files || !data.files.length) {
      showEmpty(el, "No files found in " + dir);
      return;
    }
    const grouped = {};
    data.files.forEach((f) => {
      const ext = f.path.split(".").pop().toLowerCase() || "other";
      if (!grouped[ext]) grouped[ext] = [];
      grouped[ext].push(f);
    });
    const extOrder = [
      "html",
      "css",
      "js",
      "mjs",
      "ts",
      "json",
      "md",
      "sh",
      "txt",
      "other",
    ];
    const extEmoji = {
      html: "🌐",
      css: "🎨",
      js: "⚡",
      mjs: "⚡",
      ts: "🔷",
      json: "📋",
      md: "📝",
      sh: "🖥️",
      txt: "📄",
      other: "📁",
    };
    let html = '<div style="display:grid;gap:1rem;padding:4px 0;">';
    for (const ext of extOrder) {
      if (!grouped[ext]) continue;
      html += "<div>";
      html +=
        '<div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;padding-left:2px;">' +
        (extEmoji[ext] || "📁") +
        " ." +
        ext +
        " — " +
        grouped[ext].length +
        " file" +
        (grouped[ext].length > 1 ? "s" : "") +
        "</div>";
      html += '<div style="display:grid;gap:6px;">';
      grouped[ext]
        .sort((a, b) => b.mtime - a.mtime)
        .forEach((f) => {
          const rel = f.path.replace(dir + "/", "");
          const age = formatAge(f.mtime);
          const sz = formatSize(f.size);
          html += '<div class="file-row">';
          html +=
            '<div class="file-info"><span class="file-name">' +
            rel +
            '</span><span class="file-meta">' +
            sz +
            " · " +
            age +
            "</span></div>";
          html += '<div class="file-actions">';
          html +=
            '<a href="cursor://file/' +
            f.path +
            '" class="file-btn file-btn-cursor" title="Open in Cursor">Cursor</a>';
          html +=
            '<a href="opencode://open?path=' +
            encodeURIComponent(f.path) +
            '" class="file-btn file-btn-opencode" title="Open in OpenCode">OpenCode</a>';
          html +=
            '<button data-action="previewFile" data-arg=\'' +
            f.path.replace(/'/g, "&#39;") +
            '\' data-self="1" class="file-btn" title="Preview">👁</button>';
          html += "</div></div>";
        });
      html += "</div></div>";
    }
    html += "</div>";
    html +=
      '<div id="file-preview-pane" style="display:none;margin-top:1rem;background:#0d1117;border:1px solid var(--border);border-radius:8px;overflow:hidden;"><div id="file-preview-bar" style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#0d1420;border-bottom:1px solid var(--border);font-size:12px;color:var(--text-2);"><span id="file-preview-name"></span><button data-action="closePreviewPane" style="margin-left:auto;background:none;border:none;color:var(--text-2);cursor:pointer;">✕</button></div><pre id="file-preview-content" style="margin:0;padding:1rem;font-size:0.75rem;overflow:auto;max-height:400px;"></pre></div>';
    el.innerHTML = html;
  } catch (e) {
    showError(el, "Error: " + e.message);
  }
}
async function previewFile(filePath, btn) {
  const pane = document.getElementById("file-preview-pane");
  const content = document.getElementById("file-preview-content");
  const name = document.getElementById("file-preview-name");
  if (!pane) return;
  name.textContent = filePath.split("/").pop();
  content.textContent = "Loading...";
  pane.style.display = "block";
  pane.scrollIntoView({ behavior: "smooth", block: "nearest" });
  try {
    const data = await getJSON(
      "/api/file-content?path=" + encodeURIComponent(filePath),
    );
    content.textContent = data.content || "(empty)";
  } catch (e) {
    content.textContent = "Error: " + e.message;
  }
}
function closePreviewPane() {
  const pane = document.getElementById("file-preview-pane");
  if (pane) pane.style.display = "none";
}
function formatAge(mtime) {
  const diff = Date.now() - mtime;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}
function formatSize(bytes) {
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "KB";
  return (bytes / 1024 / 1024).toFixed(1) + "MB";
}
function showSettings() {
  hideAllViews();
  document.getElementById("settingsView").classList.add("active");
  setNavActive("navSettings");
  state.activeTab = "settings";
  persistState();
  // Restore last active sub-tab from hash (e.g. #settings/telegram → telegram)
  const hashSubtab = (location.hash || "").replace("#settings/", "");
  // Support legacy deep-link aliases
  const TAB_ALIASES = {
    system: "engines",
    telegram: "comms",
    whatsapp: "comms",
  };
  const knownTabs = ["usage", "engines", "comms", "security", "webhooks"];
  const resolved = TAB_ALIASES[hashSubtab] || hashSubtab;
  showSettingsTab(knownTabs.includes(resolved) ? resolved : "usage");
}
function showSettingsTab(tab) {
  const knownTabs = ["usage", "engines", "comms", "security", "webhooks"];
  knownTabs.forEach((t) => {
    const panel = document.getElementById("stab-panel-" + t);
    const btn = document.getElementById("stab-" + t);
    if (!panel || !btn) return;
    panel.style.display =
      t === tab ? (t === "usage" ? "grid" : "block") : "none";
    btn.classList.toggle("active", t === tab);
  });
  if (tab === "usage") {
    loadTokenUsage();
    loadAllUsage();
  }
  if (tab === "engines") {
    loadOpencodeProject();
    loadBgConsciousness();
    loadGlobalFallback();
    loadConfigLockStatus();
    loadCursorWaves();
    loadAutonomousMentions();
    loadClaudeCode();
    loadCodexExecutor();
    loadGeminiCliExecutor();
    loadCrewCliExecutor();
    loadOpencodeExecutor();
    loadGlobalOcLoop();
    loadLoopBrain();
    loadPassthroughNotify();
  }
  if (tab === "comms") {
    loadCommsTabData();
  }
  if (tab === "security") {
    loadCmdAllowlist();
    loadEnvAdvanced();
  }
  if (tab === "webhooks") {
    /* static */
  }
  // Update URL hash for deep linking — e.g. #settings/telegram
  if (document.getElementById("settingsView")?.classList.contains("active")) {
    history.replaceState(null, "", "#settings/" + tab);
  }
}

initCommsTab({ showSettings, showSettingsTab });
initSettingsTab({ getModels: loadAgents_cfg, populateModelDropdown });
initModelsTab({ hideAllViews, setNavActive, loadAgents });
initAddProviderForm();
initSwarmChatTab({ hideAllViews, setNavActive });

// ── Engines → engines-tab.js ─────────────────────────────────────────────────
function showEngines() {
  hideAllViews();
  document.getElementById("enginesView").classList.add("active");
  setNavActive("navEngines");
  loadEngines();
}

// showSkills / showRunSkills → skills-tab.js

const showBenchmarks = () => showBenchmarksTab({ hideAllViews, setNavActive });

function showMemoryView() {
  hideAllViews();
  document.getElementById("memoryView").classList.add("active");
  setNavActive("navMemory");
  showMemory();
}

function showCLIProcess() {
  hideAllViews();
  document.getElementById("cliProcessView").classList.add("active");
  setNavActive("navCLI");
  // Initialize CLI process view
  if (window.initCLIProcess) window.initCLIProcess();
}

function showToolMatrix() {
  hideAllViews();
  document.getElementById("toolMatrixView").classList.add("active");
  setNavActive("navToolMatrix");
  loadToolMatrix();
}

// keep old name working for any legacy calls
function showIntegrations() {
  showSkills();
}

// loadRunSkills / runSkillFromUI → skills-tab.js

// Tool Matrix → tabs/usage-tab.js

// Spending → tabs/spending-tab.js

// ── Webhooks ──────────────────────────────────────────────────────────────────
async function sendTestWebhook() {
  const channel =
    document.getElementById("webhookChannel").value.trim() || "test";
  let payload = {};
  try {
    const v = document.getElementById("webhookPayload").value.trim();
    if (v) payload = JSON.parse(v);
  } catch {
    payload = { raw: document.getElementById("webhookPayload").value };
  }
  const el = document.getElementById("webhookTestResult");
  try {
    const res = await fetch("/proxy-webhook/" + channel, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await res.json();
    el.textContent = d.ok ? "✅ Sent to RT bus" : "❌ " + (d.error || "failed");
    el.style.color = d.ok ? "var(--green)" : "var(--red)";
  } catch (e) {
    el.textContent = "❌ " + e.message;
    el.style.color = "var(--red)";
  }
}

// ── Pending Approvals ─────────────────────────────────────────────────────────
async function loadPendingApprovals() {
  const el = document.getElementById("pendingApprovals");
  // pending-skills.json is at ~/.crewswarm/pending-skills.json — no direct API yet;
  // crew-lead should expose this but for now show instructions.
  el.innerHTML =
    '<div style="color:var(--text-3);font-size:12px;">Pending skill approvals appear here when an agent triggers a skill marked requiresApproval. You will also receive a Telegram notification with inline Approve/Reject buttons if Telegram is configured.</div>';
}
async function approveSkill(approvalId) {
  try {
    await fetch("/api/skills/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalId }),
    });
    showNotification("Approved");
    loadPendingApprovals();
  } catch (e) {
    showNotification("Failed: " + e.message, "error");
  }
}
async function rejectSkill(approvalId) {
  try {
    await fetch("/api/skills/reject", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalId }),
    });
    showNotification("Rejected");
    loadPendingApprovals();
  } catch (e) {
    showNotification("Failed: " + e.message, "error");
  }
}

/* agents tab extracted to tabs/agents-tab.js */
function showBuild() {
  _showBuild({ hideAllViews, setNavActive });
}
function showProjects() {
  _showProjects({ hideAllViews, setNavActive });
}

// ── Projects / Build → projects-tab.js ───────────────────────────────────────
// Wire project list delegated click handler
initProjectsList({ showChat, showBuild });

// Initial status check
updateStatusBadges();

// Lightweight status badge updates only (DLQ count + status dot)
// Content loads on-demand when switching tabs (event-driven, not polling)
setInterval(updateStatusBadges, 30000); // Every 30s for badge/status only
// Populate chat project dropdown on load; respect #projects deep link (e.g. from native app)
(async () => {
  try {
    const data = await getJSON("/api/projects");
    const projects = data.projects || [];
    state.projectsData = {};
    projects.forEach((p) => {
      state.projectsData[p.id] = p;
    });
    populateChatProjectDropdown(projects);
    persistState();
    if (location.hash === "#projects") showProjects();
  } catch {}
})();
document.getElementById("refreshBtn").onclick = refreshAll;
document.getElementById("runBuildBtn").onclick = runBuild;
document.getElementById("continuousBuildBtn").onclick = continuousBuildRun;
document.getElementById("stopBuildBtn").onclick = stopBuild;
document.getElementById("stopContinuousBtn").onclick = stopContinuousBuild;
document.getElementById("enhancePromptBtn").onclick = enhancePrompt;
initPmLoopTab();
document.getElementById("newProjectBtn").onclick = () => {
  const form = document.getElementById("newProjectForm");
  form.style.display = form.style.display === "none" ? "block" : "none";
};
document.getElementById("npCancelBtn").onclick = () => {
  document.getElementById("newProjectForm").style.display = "none";
};
document.getElementById("npCreateBtn").onclick = async () => {
  const name = document.getElementById("npName").value.trim();
  const desc = document.getElementById("npDesc").value.trim();
  const outputDir = document.getElementById("npOutputDir").value.trim();
  const featuresDoc = document.getElementById("npFeaturesDoc").value.trim();
  if (!name || !outputDir) {
    showNotification("Name and output directory required", true);
    return;
  }
  try {
    const r = await postJSON("/api/projects", {
      name,
      description: desc,
      outputDir,
      featuresDoc,
    });
    showNotification(`Project "${r.project.name}" created!`);
    document.getElementById("newProjectForm").style.display = "none";
    document.getElementById("npName").value = "";
    document.getElementById("npDesc").value = "";
    document.getElementById("npOutputDir").value = "";
    document.getElementById("npFeaturesDoc").value = "";
    loadProjects();
  } catch (e) {
    showNotification("Failed: " + e.message, true);
  }
};
// sendBtn / messageInput removed (replaced by crew-lead chat)

// PM Loop controls → tabs/pm-loop-tab.js
// ── Hash routing — persist active view across refresh ────────────────────────
// ── Hash routing ─────────────────────────────────────────────────────────────
// Patch each top-level show* function so calling it (via onclick or code)
// automatically updates location.hash. Refresh → restores the same tab.
const VIEW_MAP = {
  chat: showChat,
  "swarm-chat": showSwarmChat,
  swarm: showSwarm,
  rt: showRT,
  dlq: showDLQ,
  files: showFiles,
  services: showServices,
  agents: showAgents,
  models: showModels,
  settings: showSettings,
  engines: showEngines,
  skills: showSkills,
  "run-skills": showRunSkills,
  benchmarks: showBenchmarks,
  "tool-matrix": showToolMatrix,
  build: showBuild,
  messaging: showMessaging,
  projects: showProjects,
  contacts: showContacts,
  memory: showMemoryView,
  workflows: showWorkflows,
  "cli-process": showCLIProcess,
  prompts: initPromptsTab,
};

// Wrap each show* so it updates the hash when called from anywhere
for (const [hash, fn] of Object.entries(VIEW_MAP)) {
  const original = fn;
  const wrapped = function (...args) {
    const cur = location.hash || "";
    if (hash === "chat") {
      // Never replaceState to bare #chat when already on #chat?project=… — that
      // fires hashchange in some browsers and doubles showChat + 500-msg reloads.
      if (!cur.startsWith("#chat")) {
        history.replaceState(null, "", "#chat");
      }
    } else {
      history.replaceState(null, "", "#" + hash);
    }
    return original(...args);
  };
  // Update the reference in the map and on window (for onclick= handlers)
  VIEW_MAP[hash] = wrapped;
  window[original.name] = wrapped;
}

function navigateTo(view) {
  const base = String(view || "chat").split("?")[0].split("/")[0];
  const fn = VIEW_MAP[base] || VIEW_MAP["chat"];
  fn();
}

// On load: restore from hash or default to chat
// Supports top-level (#chat, #services) and sub-tab deep links (#settings/telegram)
const { view: startView, subtab: startSubtab } = parseRouteFromHash();
const params = new URLSearchParams(window.location.search);
if (params.get("focus") === "1") {
  setTimeout(() => {
    const ci = document.getElementById("chatInput");
    if (ci) {
      navigateTo("chat");
      ci.focus();
    }
  }, 500);
} else {
  navigateTo(startView || "chat");
  if (startView === "settings" && startSubtab) {
    showSettingsTab(startSubtab);
  }
}

// Handle browser back/forward buttons
window.addEventListener("hashchange", () => {
  const { view, subtab } = parseRouteFromHash();

  // Navigate to the view from hash
  const viewFn = NAV_VIEW_MAP[view];
  if (viewFn) {
    viewFn();
    // If it's a settings subtab, show that too
    if (view === "settings" && subtab) {
      showSettingsTab(subtab);
    }
  } else {
    // Fallback to chat if invalid hash
    showChat();
  }
});
// Resolve server-side env vars (HOME, cwd) once on boot
fetch("/api/env")
  .then((r) => r.json())
  .then((env) => {
    window._crewHome = env.HOME || "";
    window._crewCwd = env.cwd || "";
    const filesDir = document.getElementById("filesDir");
    if (filesDir && !filesDir.value) filesDir.value = env.cwd || "";
  })
  .catch(() => {});

loadAgents();
refreshAll();

// Wrap every type="password" input in a <form display:contents> so Chrome
// stops emitting "Password field is not contained in a form" warnings.
// Works for both static inputs and dynamically rendered provider key fields.
(function () {
  function wrapOrphanPwd(inp) {
    if (inp.closest("form")) return;
    const form = document.createElement("form");
    form.autocomplete = "off";
    form.onsubmit = () => false;
    form.style.cssText = "margin:0;padding:0;display:contents;";
    // Hidden username field — satisfies Chrome's "password forms need a username" check
    const u = document.createElement("input");
    u.type = "text";
    u.autocomplete = "username";
    u.setAttribute("aria-hidden", "true");
    u.style.cssText =
      "display:none;position:absolute;width:0;height:0;opacity:0;";
    form.appendChild(u);
    inp.parentNode.insertBefore(form, inp);
    form.appendChild(inp);
  }
  function scanAndWrap(root) {
    (root || document)
      .querySelectorAll('input[type="password"]')
      .forEach(wrapOrphanPwd);
  }
  scanAndWrap();
  const obs = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches && node.matches('input[type="password"]'))
          wrapOrphanPwd(node);
        else scanAndWrap(node);
      }
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
})();

// ── Expose functions to global scope for inline HTML event handlers ───────────
// ── Global delegated click dispatcher ──────────────────────────────────────────
// MetaMask's SES lockdown runs onclick handlers in an isolated Compartment where
// neither globalThis.fn nor window.fn resolves. Using data-action + addEventListener
// bypasses the Compartment entirely — the listener closure has full module scope.
const ACTION_REGISTRY = {
  // Nav views
  showChat,
  showSwarm,
  showRT,
  showBuild,
  showFiles,
  showDLQ,
  showProjects,
  showAgents,
  showModels,
  showEngines,
  showSkills,
  showRunSkills,
  showBenchmarks,
  showToolMatrix,
  showServices,
  showSettings,
  // Static HTML actions (previously onclick="window.fn()")
  pickFolder: (id) => pickFolder(id),
  loadFiles: (force) => loadFiles(force === "true" || force === true),
  clearChatHistory,
  clearAgentChat: () => {
    const agentSelect = document.getElementById("agentChatSelector");
    const messages = document.getElementById("agentChatMessages");
    const input = document.getElementById("agentChatInput");
    if (messages)
      messages.innerHTML =
        '<div class="empty-state">No messages yet. Start chatting!</div>';
    if (input) input.value = "";
    if (agentSelect?.value) {
      // TODO: Clear history from backend/localStorage
      showNotification("Chat history cleared", "success");
    }
  },
  sendChat,
  stopAll,
  killAll,
  stopPassthrough: killPassthrough,
  clearPassthroughSession,
  loadServices,
  saveRTToken,
  lockConfig,
  unlockConfig,
  startCrew,
  toggleEmojiPicker: (id) => toggleEmojiPicker(id),
  bulkSetRoute: (route, model) => bulkSetRoute(route, model),
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
  saveOpencodeModel,
  saveGlobalFallback,
  toggleBgConsciousness,
  toggleCursorWaves,
  toggleAutonomousMentions,
  toggleClaudeCode,
  toggleCodexExecutor,
  toggleGeminiCliExecutor,
  toggleCrewCliExecutor,
  toggleOpencodeExecutor,
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
  // Memory
  loadMemoryStats,
  searchMemory,
  migrateMemory,
  compactMemory,
  loadEngines,
  toggleImportEngine,
  importEngineFromUrl,
  deleteEngine: (id) => deleteEngine(id),
  loadToolMatrix,
  loadBuildProjectPicker,
  // RT scroll button
  scrollRTToBottom: () => {
    const v = document.getElementById("rtView");
    if (v) v.scrollTop = v.scrollHeight;
  },
  toggleRTPause,
  clearRTMessages,
  togglePmAdvanced: () => {
    const el = document.getElementById("pmAdvanced");
    if (el) el.style.display = el.style.display === "none" ? "block" : "none";
  },
  // RT token visibility toggle
  toggleRTTokenVis: () => {
    const i = document.getElementById("rtTokenInput");
    if (i) i.type = i.type === "password" ? "text" : "password";
  },
  // Services
  restartService: (id) => restartService(id),
  stopService: (id) => stopService(id),
  // Files
  closePreviewPane,
  previewFile: (path, el) => previewFile(path, el),
  // DLQ
  replayDLQ: (key) => replayDLQ(key),
  deleteDLQ: (key) => deleteDLQ(key),
  // Skills
  runSkillFromUI: (name) => runSkillFromUI(name),
  editSkill: (name) => editSkill(name),
  deleteSkill: (name) => deleteSkill(name),
  // Tool matrix
  restartAgentFromUI: (id) => restartAgentFromUI(id),
  // Models / providers
  saveSearchTool: (id) => saveSearchTool(id),
  testSearchTool: (id) => testSearchTool(id),
  saveBuiltinKey: (id) => saveBuiltinKey(id),
  testBuiltinProvider: (id) => testBuiltinProvider(id),
  fetchBuiltinModels: (id, el) => fetchBuiltinModels(id, el),
  saveKey: (id) => saveKey(id),
  testKey: (id) => testKey(id),
  fetchModels: (id, el) => fetchModels(id, el),
  toggleKeyVis: (inputId, el) => toggleKeyVis(inputId, el),
  // Agents
  toggleAgentBody: (id) => toggleAgentBody(id),
  deleteAgent: (id) => deleteAgent(id),
  saveAgentModel: (id) => saveAgentModel(id),
  saveAgentFallback: (id) => saveAgentFallback(id),
  saveAgentVoice: (id) => saveAgentVoice(id),
  toggleEmojiPicker: (id) => toggleEmojiPicker(id),
  saveAgentIdentity: (id) => saveAgentIdentity(id),
  saveAgentPrompt: (id) => saveAgentPrompt(id),
  resetAgentSession: (id) => resetAgentSession(id),
  saveAgentTools: (id) => saveAgentTools(id),
  applyToolPreset: (id) => applyToolPreset(id),
  setRoute: (id, route) => setRoute(id, route),
  saveOpenCodeConfig: (id) => saveOpenCodeConfig(id),
  saveOpenCodeFallback: (id) => saveOpenCodeFallback(id),
  saveCursorCliConfig: (id) => saveCursorCliConfig(id),
  saveClaudeCodeConfig: (id) => saveClaudeCodeConfig(id),
  saveGeminiCliConfig: (id) => saveGeminiCliConfig(id),
  saveCrewCLIConfig: (id) => saveCrewCLIConfig(id),
  // PM Loop / Projects
  "pm-toggle": (id) => {
    const proj = state.projects?.find((p) => p.id === id);
    proj && proj.running ? stopProjectPMLoop(id) : startProjectPMLoop(id);
  },
  "edit-roadmap": (id) => {
    const proj = state.projects?.find((p) => p.id === id);
    if (proj) openRoadmapEditor(id, proj.roadmapFile);
  },
  "retry-failed": (id) => {
    const proj = state.projects?.find((p) => p.id === id);
    if (proj) retryFailed(proj.roadmapFile);
  },
  "save-roadmap": (id) => saveRoadmap(id),
  "reset-failed": (id) => resetAllFailed(id),
  // Settings tabs
  showSettingsTab: (tab) => showSettingsTab(tab),
};

document.addEventListener("click", (e) => {
  if (!(e.target instanceof Element)) return;
  const el = e.target.closest("[data-action]");
  if (!el) return;
  e.stopPropagation();
  const action = el.dataset.action;
  const fn = ACTION_REGISTRY[action];
  if (!fn) {
    console.warn("[crewswarm] unknown data-action:", action);
    return;
  }
  const arg = el.dataset.arg ?? null;
  const arg2 = el.dataset.arg2 ?? null;
  const needsEl = el.dataset.self === "1";
  if (arg !== null && arg2 !== null) fn(arg, arg2);
  else if (arg !== null && needsEl) fn(arg, el);
  else if (arg !== null) fn(arg);
  else if (needsEl) fn(el);
  else fn();
});

// ── Delegated change listener (data-onchange) ────────────────────────────────
document.addEventListener("change", (e) => {
  const el = e.target.closest("[data-onchange]");
  if (!el) return;
  const fn = ACTION_REGISTRY[el.dataset.onchange];
  if (!fn) return;
  // Pass element value if data-onchange-arg="this.value", otherwise no arg
  const arg = el.dataset.onchangeArg === "this.value" ? el.value : null;
  arg !== null ? fn(arg) : fn();
});

// Wire chatInput keydown + oninput via addEventListener (SES-safe)
document.addEventListener(
  "DOMContentLoaded",
  () => {
    // Initialize active tasks panel
    initActiveTasksPanel("activeTasksPanel");

    // Initialize contacts tab event listeners
    initContactsList();

    // Set sidebar self-link to actual origin (avoids hardcoded localhost:4319)
    const dashLink = document.getElementById("dashSelfLink");
    if (dashLink) {
      dashLink.href = window.location.origin;
      dashLink.textContent = window.location.host;
    }

    // Wire nav buttons for all tabs
    document.querySelectorAll(".nav-item").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const view = btn.dataset.view;
        if (!view) return;
        if (currentHashBaseView() !== view) {
          window.location.hash = view;
          return;
        }
        const fn = NAV_VIEW_MAP[view];
        if (fn) fn();
      });
    });

    const chatInput = document.getElementById("chatInput");
    if (chatInput && !chatInput.dataset.boundChatComposer) {
      chatInput.dataset.boundChatComposer = "1";
      chatInput.addEventListener("keydown", chatKeydown);
      chatInput.addEventListener("input", chatAtAtInput);
    }
    const chatSendBtn =
      document.getElementById("chatSendBtn") ||
      document.querySelector('[data-action="sendChat"]');
    if (chatSendBtn && !chatSendBtn.dataset.boundChatComposer) {
      chatSendBtn.dataset.boundChatComposer = "1";
      chatSendBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        sendChat();
      });
    }
    const cmdInput = document.getElementById("cmdAllowlistInput");
    if (cmdInput) {
      cmdInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") addAllowlistPattern();
      });
    }
    const waNumbers = document.getElementById("waAllowedNumbers");
    if (waNumbers) waNumbers.addEventListener("input", renderWaContactRows);
    const skillSearchInput = document.getElementById("skillSearch");
    if (skillSearchInput)
      skillSearchInput.addEventListener("input", (e) =>
        filterSkills(e.target.value),
      );

    // Refresh session indicator when engine or project changes
    const engineSel = document.getElementById("passthroughEngine");
    if (engineSel) {
      engineSel.addEventListener("change", () => {
        refreshSessionIndicator();
        updatePassthroughModelDropdown();
        // Reset send button state when switching engines
        resetSendButton();
      });
    }
    const projSel = document.getElementById("chatProjectSelect");
    if (projSel) projSel.addEventListener("change", refreshSessionIndicator);

    // Reset send button when model changes
    const modelSel = document.getElementById("passthroughModel");
    if (modelSel) {
      modelSel.addEventListener("change", () => {
        resetSendButton();
      });
    }
  },
  { once: true },
);

// Update passthrough model dropdown based on selected engine
function updatePassthroughModelDropdown() {
  const engineSel = document.getElementById("passthroughEngine");
  const modelSel = document.getElementById("passthroughModel");
  if (!engineSel || !modelSel) return;

  const engine = engineSel.value;
  const modelsByEngine = {
    cursor: [
      { value: "", label: "— default (opus-4.6-thinking) —" },
      { optgroup: "Recommended (No Rate Limits)" },
      { value: "gemini-3-flash", label: "🟢 Gemini 3 Flash (fastest)" },
      { value: "gemini-3-pro", label: "🟢 Gemini 3 Pro" },
      { value: "gemini-3.1-pro", label: "🟢 Gemini 3.1 Pro" },
      { value: "gpt-5.2-codex", label: "🟢 GPT-5.2 Codex" },
      { value: "gpt-5.3-codex", label: "🟢 GPT-5.3 Codex" },
      { optgroup: "Claude Models (May Hit Rate Limits)" },
      { value: "sonnet-4.5", label: "🟡 Claude 4.5 Sonnet" },
      { value: "sonnet-4.6", label: "🟡 Claude 4.6 Sonnet (current)" },
      { value: "opus-4.5", label: "🟡 Claude 4.5 Opus" },
      { value: "opus-4.6", label: "🟡 Claude 4.6 Opus" },
      { optgroup: "Thinking Models (Slower)" },
      { value: "sonnet-4.5-thinking", label: "Claude 4.5 Sonnet Thinking" },
      { value: "opus-4.6-thinking", label: "Claude 4.6 Opus Thinking" },
      { optgroup: "Other" },
      { value: "grok", label: "xAI Grok" },
      { value: "kimi-k2.5", label: "Moonshot Kimi K2.5" },
    ],
    claude: [
      { value: "", label: "— default (Sonnet 4.6) —" },
      { optgroup: "Recommended" },
      { value: "sonnet", label: "🟢 Sonnet (alias for latest)" },
      { value: "Default", label: "🟢 Default (Sonnet 4.6)" },
      { optgroup: "Specific Versions" },
      {
        value: "claude-sonnet-4-6",
        label: "Sonnet 4.6 · Best for everyday tasks",
      },
      {
        value: "Opus",
        label: "Opus (Opus 4.6) · Most capable for complex work",
      },
      { value: "claude-opus-4-6", label: "Opus 4.6 · Most capable" },
      {
        value: "Haiku",
        label: "Haiku (Haiku 4.5) · Fastest for quick answers",
      },
      { value: "claude-haiku-4-5", label: "Haiku 4.5 · Fastest" },
      { optgroup: "Legacy" },
      { value: "claude-sonnet-4-5", label: "Sonnet 4.5 (legacy)" },
    ],
    codex: [
      { value: "", label: "— default (gpt-5.3-codex) —" },
      { optgroup: "Recommended" },
      { value: "gpt-5.3-codex", label: "🟢 GPT-5.3 Codex (current)" },
      { value: "gpt-5.2-codex", label: "🟢 GPT-5.2 Codex" },
      { optgroup: "Specialized" },
      {
        value: "gpt-5.1-codex-max",
        label: "GPT-5.1 Codex Max (deep reasoning)",
      },
      { value: "gpt-5.2", label: "GPT-5.2 (general purpose)" },
      {
        value: "gpt-5.1-codex-mini",
        label: "GPT-5.1 Codex Mini (fast & cheap)",
      },
    ],
    opencode: [
      { value: "", label: "— default —" },
      { optgroup: "Free Models 🎁" },
      { value: "opencode/big-pickle", label: "🆓 Big Pickle (Free)" },
      { value: "opencode/minimax-m2.5-free", label: "🆓 MiniMax M2.5 Free" },
      { value: "openai/gpt-5-nano", label: "🆓 GPT 5 Nano (Free)" },
      { optgroup: "Budget Models 💰" },
      {
        value: "openai/gpt-5.1-codex-mini",
        label: "💰 GPT 5.1 Codex Mini ($0.25/$2)",
      },
      { value: "google/gemini-3-flash", label: "💰 Gemini 3 Flash ($0.50/$3)" },
      {
        value: "anthropic/claude-haiku-4-5",
        label: "💰 Claude Haiku 4.5 ($1/$5)",
      },
      { optgroup: "Interesting Models 🎯" },
      { value: "moonshot/kimi-k2.5", label: "Kimi K2.5 ($0.60/$3)" },
      {
        value: "moonshot/kimi-k2-thinking",
        label: "Kimi K2 Thinking ($0.40/$2.50)",
      },
      {
        value: "alibaba/qwen3-coder-480b",
        label: "Qwen3 Coder 480B ($0.45/$1.50)",
      },
      { value: "zhipu/glm-5", label: "GLM 5 ($1/$3.20)" },
      { optgroup: "Premium Claude" },
      {
        value: "anthropic/claude-sonnet-4-6",
        label: "Claude Sonnet 4.6 ($3/$15)",
      },
      { value: "anthropic/claude-opus-4-6", label: "Claude Opus 4.6 ($5/$25)" },
      { optgroup: "Premium OpenAI" },
      { value: "openai/gpt-5.3-codex", label: "GPT 5.3 Codex ($1.75/$14)" },
      { value: "openai/gpt-5.2-codex", label: "GPT 5.2 Codex ($1.75/$14)" },
      {
        value: "openai/gpt-5.1-codex-max",
        label: "GPT 5.1 Codex Max ($1.25/$10)",
      },
      { optgroup: "Premium Google" },
      { value: "google/gemini-3.1-pro", label: "Gemini 3.1 Pro ($2/$12)" },
      { value: "google/gemini-3-pro", label: "Gemini 3 Pro ($2/$12)" },
    ],
    gemini: [
      { value: "", label: "— default (gemini-3-flash-preview) —" },
      { optgroup: "Recommended (Latest)" },
      {
        value: "gemini-3-flash-preview",
        label: "🟢 Gemini 3 Flash Preview (current)",
      },
      { value: "gemini-3.1-pro-preview", label: "🟢 Gemini 3.1 Pro Preview" },
      { optgroup: "Gemini 2.5 Series" },
      { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      {
        value: "gemini-2.5-flash-lite",
        label: "Gemini 2.5 Flash Lite (fastest)",
      },
    ],
  };

  if (!engine || !modelsByEngine[engine]) {
    modelSel.style.display = "none";
    return;
  }

  modelSel.style.display = "inline-block";
  modelSel.innerHTML = "";

  let currentOptgroup = null;
  for (const item of modelsByEngine[engine]) {
    if (item.optgroup) {
      // Create optgroup
      currentOptgroup = document.createElement("optgroup");
      currentOptgroup.label = item.optgroup;
      modelSel.appendChild(currentOptgroup);
    } else {
      // Create option
      const opt = document.createElement("option");
      opt.value = item.value;
      opt.textContent = item.label;
      if (currentOptgroup) {
        currentOptgroup.appendChild(opt);
      } else {
        modelSel.appendChild(opt);
      }
    }
  }
}

// Nav view delegation (data-view buttons in sidebar)
const NAV_VIEW_MAP = {
  chat: showChat,
  "swarm-chat": showSwarmChat,
  swarm: showSwarm,
  rt: showRT,
  build: showBuild,
  files: showFiles,
  dlq: showDLQ,
  projects: showProjects,
  contacts: showContacts,
  agents: showAgents,
  models: showModels,
  engines: showEngines,
  skills: showSkills,
  "run-skills": showRunSkills,
  waves: () => {
    hideAllViews();
    document.getElementById("wavesView").style.display = "block";
    setNavActive("navWaves");
  },
  workflows: showWorkflows,
  benchmarks: showBenchmarks,
  "tool-matrix": showToolMatrix,
  memory: showMemoryView,
  "cli-process": showCLIProcess,
  services: showServices,
  prompts: initPromptsTab,
  settings: showSettings,
};
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-view]");
  if (btn) {
    const viewName = btn.dataset.view;
    const fn = NAV_VIEW_MAP[viewName];
    if (fn) {
      // Let hashchange drive navigation to avoid double-render/jitter.
      if (currentHashBaseView() !== viewName) {
        window.location.hash = viewName;
      } else {
        fn();
      }
    }
    return;
  }
  const stab = e.target.closest("[data-stab]");
  if (stab) {
    const subtab = stab.dataset.stab;
    // Update URL hash for settings sub-tabs
    window.location.hash = `settings/${subtab}`;
    showSettingsTab(subtab);
  }
  // Collapse/expand panels with data-toggle-child
  const tog = e.target.closest("[data-toggle-child]");
  if (tog) {
    const sel = tog.dataset.toggleChild;
    const body = tog.parentElement && tog.parentElement.querySelector(sel);
    if (body)
      body.style.display = body.style.display === "none" ? "block" : "none";
  }
  // Collapse/expand next sibling with data-toggle-sibling (e.g. provider-header → provider-body)
  const togSib = e.target.closest("[data-toggle-sibling]");
  if (togSib && togSib.nextElementSibling) {
    togSib.nextElementSibling.classList.toggle(togSib.dataset.toggleSibling);
  }
});

// Vite wraps modules in a closure; onclick="window.fn()" attrs in static + dynamic HTML need window.fn.
Object.assign(window, {
  // ── Static HTML handlers ──
  addAllowlistPattern,
  applyNewAgentToolPreset,
  applyPromptPreset,
  bulkSetRoute,
  cancelSkillForm,
  chatAtAtInput,
  chatKeydown,
  clearChatHistory,
  filterSkills,
  loadAllUsage,
  loadBenchmarkLeaderboard,
  loadBenchmarks,
  loadBenchmarkTasks,
  onBenchmarkTaskSelect,
  runBenchmarkTask,
  stopBenchmarkRun,
  loadMemoryStats,
  searchMemory,
  migrateMemory,
  compactMemory,
  loadBuildProjectPicker,
  loadFiles,
  loadOcStats,
  loadRunSkills,
  loadServices,
  loadSpending,
  loadTelegramSessions,
  loadTgMessages,
  loadToolMatrix,
  loadWaMessages,
  onBuildProjectChange,
  onChatProjectChange,
  pickFolder,
  renderWaContactRows,
  resetSpending,
  approveSkill,
  loadPendingApprovals,
  rejectSkill,
  saveGlobalCaps,
  saveGlobalFallback,
  saveBgConsciousnessModel,
  saveOpencodeSettings,
  saveRTToken,
  saveSkill,
  saveTgConfig,
  saveWaConfig,
  sendChat,
  sendTestWebhook,
  showAgents,
  showBenchmarks,
  showBuild,
  showChat,
  showContacts,
  showDLQ,
  showFiles,
  showModels,
  showProjects,
  showRT,
  showRunSkills,
  showServices,
  showSettings,
  showSettingsTab,
  showSkills,
  showSwarm,
  showToolMatrix,
  showMemoryView,
  startCrew,
  startTgBridge,
  startWaBridge,
  stopTgBridge,
  stopWaBridge,
  toggleAddSkill,
  toggleBgConsciousness,
  toggleCursorWaves,
  toggleClaudeCode,
  toggleEmojiPicker,
  updateSkillAuthFields,
  navigateTo,
  renderStatusBadge,
  showLoading,
  showEmpty,
  showError,
  loadContacts,
  applyContactFilters,
  // ── Dynamic HTML handlers (innerHTML-rendered) ──
  applyToolPreset,
  closePreviewPane,
  deleteAgent,
  deleteSkill,
  editSkill,
  fetchBuiltinModels,
  fetchModels,
  previewFile,
  resetAgentSession,
  restartAgentFromUI,
  restartService,
  runSkillFromUI,
  saveAgentFallback,
  saveAgentVoice,
  saveAgentIdentity,
  saveAgentModel,
  saveAgentPrompt,
  saveAgentTools,
  saveBuiltinKey,
  saveCursorCliConfig,
  saveClaudeCodeConfig,
  saveGeminiCliConfig,
  saveKey,
  saveOpenCodeConfig,
  saveOpenCodeFallback,
  saveSearchTool,
  setRoute,
  stopService,
  testBuiltinProvider,
  testKey,
  testSearchTool,
  toggleAgentBody,
  toggleKeyVis,
});

// Project tabs: startup IIFE (near initProjectsList) already fetches /api/projects
// and populates the dropdown — avoid a duplicate fetch here.
