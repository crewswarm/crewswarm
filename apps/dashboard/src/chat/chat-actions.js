import { taskManager } from "../core/task-manager.js";
import { filterOpenCodePassthroughTextChunk } from "../../../../lib/browser/opencode-passthrough-filter.js";
import { filterGeminiPassthroughTextChunk } from "../../../../lib/gemini-cli-passthrough-noise.mjs";
import {
  createPassthroughStderrLineFilter,
  shouldDropPassthroughStderrLine,
  summarizePassthroughTopErrorLine,
} from "../../../../lib/browser/passthrough-stderr.js";

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

  const PASSTHROUGH_LOG_KEY = "crewswarm_passthrough_log";
  const PASSTHROUGH_LOG_MAX = 200;

  function resolveVisibleChatProjectId() {
    const selector = document.getElementById("chatProjectSelect");
    const selectedValue = String(selector?.value || "").trim();
    const activeTab = document.querySelector(
      '#chatProjectTabs [data-project-id].active',
    );
    const tabValue = String(activeTab?.dataset?.projectId || "").trim();
    const resolved =
      selectedValue && selectedValue !== "undefined"
        ? selectedValue
        : tabValue && tabValue !== "undefined"
          ? tabValue
          : getChatActiveProjectId() || state.chatActiveProjectId || "general";
    state.chatActiveProjectId = resolved;
    try {
      localStorage.setItem("crewswarm_chat_active_project_id", resolved);
    } catch { }
    return resolved;
  }
  const ATAT_COMMANDS = [
    {
      id: "RESET",
      label: "Clear session history and start fresh",
      template: "",
    },
    {
      id: "STOP",
      label: "Cancel all running pipelines (agents keep running)",
      template: "",
    },
    {
      id: "KILL",
      label: "Kill all pipelines + terminate all agent bridges",
      template: "",
    },
    {
      id: "SEARCH_HISTORY",
      label: "Search long-term chat history by keyword",
      template: "your search terms",
    },
    {
      id: "DISPATCH",
      label: "Dispatch task to an agent",
      template: '{"agent":"crew-coder","task":"Your task here"}',
    },
    {
      id: "PIPELINE",
      label: "Multi-step pipeline (waves of agents)",
      template:
        '[{"wave":1,"agent":"crew-coder","task":"..."},{"wave":2,"agent":"crew-qa","task":"..."}]',
    },
    {
      id: "PROMPT",
      label: "Append or set agent system prompt",
      template: '{"agent":"crew-lead","append":"Your new rule here"}',
    },
    {
      id: "SKILL",
      label: "Run a skill by name",
      template: 'skillName {"param":"value"}',
    },
    {
      id: "SERVICE",
      label: "Restart/stop a service or agent",
      template: "restart crew-coder",
    },
    {
      id: "READ_FILE",
      label: "Read a file and get its contents",
      template: "/path/to/file",
    },
    {
      id: "RUN_CMD",
      label: "Run a shell command",
      template: "ls -la /Users/jeffhobbs/Desktop/crewswarm",
    },
    {
      id: "WEB_SEARCH",
      label: "Search the web (Perplexity)",
      template: "your search query",
    },
    {
      id: "WEB_FETCH",
      label: "Fetch a webpage or URL",
      template: "https://example.com",
    },
    {
      id: "PROJECT",
      label: "Draft a new project roadmap",
      template:
        '{"name":"MyApp","description":"...","outputDir":"/path/to/dir"}',
    },
    {
      id: "BRAIN",
      label: "Append a fact to brain.md",
      template: "crew-lead: fact to remember",
    },
    {
      id: "TOOLS",
      label: "Grant/revoke tools for an agent",
      template: '{"agent":"crew-qa","allow":["read_file","write_file"]}',
    },
    {
      id: "CREATE_AGENT",
      label: "Create a dynamic agent",
      template: '{"id":"crew-ml","role":"coder","description":"ML specialist"}',
    },
    {
      id: "REMOVE_AGENT",
      label: "Remove a dynamic agent",
      template: "crew-ml",
    },
    {
      id: "DEFINE_SKILL",
      label: "Define a new skill (then @@END_SKILL)",
      template: 'skillName\\n{"description":"...","url":"..."}',
    },
    {
      id: "DEFINE_WORKFLOW",
      label: "Save a workflow for cron",
      template: 'name\\n[{"agent":"crew-copywriter","task":"..."}]',
    },
  ];

  let latestHistoryLoadId = 0;
  /** Resolvers notified when loadChatHistory finishes (success/cancel/error). */
  const _historyIdleWaiters = [];

  function waitForChatHistoryIdle() {
    const box = document.getElementById("chatMessages");
    if (!box || box.dataset.historyLoading !== "true") {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      _historyIdleWaiters.push(resolve);
    });
  }

  function flushHistoryIdleWaiters() {
    const pending = _historyIdleWaiters.splice(0);
    pending.forEach((r) => {
      try {
        r();
      } catch {
        /* ignore */
      }
    });
  }
  let mentionAgents = [];
  let lastMentionAgentLoadAt = 0;

  async function loadMentionAgents(force = false) {
    const now = Date.now();
    if (!force && mentionAgents.length && now - lastMentionAgentLoadAt < 30000) {
      return mentionAgents;
    }
    const data = await getJSON("/api/agents-config");
    mentionAgents = (data.agents || [])
      .filter((agent) => agent.id && agent.id !== "crew-lead")
      .sort((a, b) => a.id.localeCompare(b.id));
    lastMentionAgentLoadAt = now;
    return mentionAgents;
  }

  async function resolveLeadingMentionAgent(text) {
    const match = String(text || "").match(/^\s*@([a-zA-Z0-9_-]+)\b([\s\S]*)$/);
    if (!match) return null;

    const agentId = match[1];
    if (!agentId || agentId === "crew-lead") return null;

    const agents = await loadMentionAgents();
    const exists = agents.some((agent) => agent.id === agentId);
    if (!exists) return null;

    return {
      agentId,
      message: match[2].trim() || text.trim(),
    };
  }

  async function loadChatHistory() {
    const loadId = ++latestHistoryLoadId;
    const isStale = () => loadId !== latestHistoryLoadId;
    const chatBoxEl = document.getElementById("chatMessages");
    if (chatBoxEl) chatBoxEl.dataset.historyLoading = "true";

    try {
      const projectId = getChatActiveProjectId();
      const normalizedProjectId =
        projectId && projectId !== "undefined" ? projectId : "general";
      console.log("📚 [LOAD HISTORY] ==================");
      console.log("📚 [LOAD HISTORY] START - projectId:", projectId);
      console.log(
        "📚 [LOAD HISTORY] state.chatActiveProjectId:",
        state.chatActiveProjectId,
      );
      console.log("📚 [LOAD HISTORY] URL hash:", window.location.hash);

      // UNIFIED VIEW: Always load from project-messages (all sources), including "general"
      if (normalizedProjectId) {
        console.log(
          "📚 [LOAD HISTORY] Loading unified project messages (all sources)",
        );
        console.log("📚 [LOAD HISTORY] ProjectId:", projectId);

        try {
          // Cap payload; chunk-render below so the main thread stays responsive.
          const url = `/api/crew-lead/project-messages?projectId=${encodeURIComponent(normalizedProjectId)}&limit=250`;
          console.log("📚 [LOAD HISTORY] Fetching:", url);

          const d = await getJSON(url);
          if (isStale()) return;
          console.log("📚 [LOAD HISTORY] Unified response:", {
            ok: d.ok,
            messagesCount: d.messages?.length || 0,
            sources: d.messages
              ? [...new Set(d.messages.map((m) => m.source))]
              : [],
          });

          const box = document.getElementById("chatMessages");
          if (!box) {
            console.error(
              "📚 [LOAD HISTORY] ERROR: chatMessages element not found!",
            );
            return;
          }
          if (isStale()) return;

          // Clear existing messages
          box.innerHTML = "";
          box.dataset.historyLoaded = "false";
          setLastAppendedAssistantContent("");
          setLastAppendedUserContent("");

          // Display messages with source indicators
          if (d.messages && d.messages.length > 0) {
            const sourceEmoji = {
              dashboard: "💻",
              cli: "⚡",
              agent: "🤖", // Direct agent chat (crew-main, crew-security)
              "sub-agent": "👷", // Dispatched task completions (crew-coder, crew-qa)
            };
            let agentsById = new Map();
            try {
              const agentsData = await getJSON("/api/agents-config");
              agentsById = new Map(
                (agentsData?.agents || []).map((a) => [a.id, a]),
              );
            } catch {}
            if (isStale()) return;

            const messages = d.messages;
            console.log(
              "📚 [LOAD HISTORY] Appending",
              messages.length,
              "unified messages (chunked rAF)...",
            );

            const BATCH = 32;
            await new Promise((resolve) => {
              let idx = 0;
              const pump = () => {
                if (isStale()) {
                  resolve();
                  return;
                }
                const end = Math.min(idx + BATCH, messages.length);
                for (; idx < end; idx++) {
                  if (isStale()) {
                    resolve();
                    return;
                  }
                  const msg = messages[idx];
                  const agentId = msg.agent || msg.metadata?.agentId || null;
                  const catalogAgent = agentId ? agentsById.get(agentId) : null;
                  const emoji =
                    msg.metadata?.agentEmoji ||
                    catalogAgent?.emoji ||
                    sourceEmoji[msg.source] ||
                    "📝";
                  const agentName =
                    msg.metadata?.agentName ||
                    catalogAgent?.name ||
                    agentId ||
                    null;
                  const timestamp = new Date(msg.ts).toLocaleTimeString();

                  const sourceInfo = {
                    emoji,
                    source: msg.source,
                    agent: agentName,
                    agentName,
                    agentId,
                    targetAgent:
                      msg.metadata?.targetAgent || msg.metadata?.agentId || null,
                    engine:
                      msg.metadata?.engine ||
                      msg.metadata?.runtime ||
                      msg.metadata?.model ||
                      null,
                    timestamp,
                  };

                  appendChatBubble(
                    msg.role === "user" ? "user" : "assistant",
                    msg.content,
                    null,
                    null,
                    msg.metadata?.model,
                    msg.metadata?.engine,
                    sourceInfo,
                  );
                  if (msg.role === "assistant")
                    setLastAppendedAssistantContent(msg.content);
                  if (msg.role === "user")
                    setLastAppendedUserContent(msg.content);
                }
                if (idx < messages.length) {
                  requestAnimationFrame(pump);
                } else {
                  resolve();
                }
              };
              requestAnimationFrame(pump);
            });

            if (isStale()) return;
            console.log(
              "📚 [LOAD HISTORY] ✅ Loaded unified view with all sources",
            );
            box.dataset.historyLoaded = "true";
            box.scrollTop = box.scrollHeight;
            return;
          } else {
            console.log(
              "📚 [LOAD HISTORY] No messages in unified response (might be empty project)",
            );
            box.dataset.historyLoaded = "true";
            // Don't fall through - empty is valid for new projects
            return;
          }
        } catch (e) {
          console.error("📚 [LOAD HISTORY] ⚠️ Unified view failed:", e);
          console.error("📚 [LOAD HISTORY] Error details:", {
            message: e.message,
            stack: e.stack,
          });

          // Show error message to user
          const box = document.getElementById("chatMessages");
          if (box) {
            const errorDiv = document.createElement("div");
            errorDiv.style.cssText =
              "padding:12px;margin:8px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px;color:#ef4444;font-size:13px;";
            errorDiv.innerHTML = `⚠️ <strong>crew-lead unavailable</strong> — Cannot load project message history.<br><small>Check that crew-lead is running: <code>node crew-lead.mjs</code></small>`;
            box.appendChild(errorDiv);
          }

          // Fall through to load standard crew-lead history (if crew-lead comes back up)
          console.log(
            "📚 [LOAD HISTORY] Falling back to crew-lead-only history...",
          );
        }
      }

      // STANDARD VIEW: Load crew-lead history only (fallback or general chat)
      let url = "/api/crew-lead/history?sessionId=owner";
      if (normalizedProjectId && normalizedProjectId !== "general") {
        url += "&projectId=" + encodeURIComponent(normalizedProjectId);
      }
      console.log("📚 [LOAD HISTORY] Fetching crew-lead history:", url);

      const d = await getJSON(url);
      if (isStale()) return;
      console.log("📚 [LOAD HISTORY] Response:", {
        historyCount: d.history?.length || 0,
      });
      console.log("📚 [LOAD HISTORY] Response projectId:", d.projectId);

      // Log first and last message for debugging
      if (d.history && d.history.length > 0) {
        const userMsgs = d.history.filter((m) => m.role === "user");
        if (userMsgs.length > 0) {
          console.log(
            "📚 [LOAD HISTORY] First user msg:",
            userMsgs[0].content.slice(0, 50),
          );
          console.log(
            "📚 [LOAD HISTORY] Last user msg:",
            userMsgs[userMsgs.length - 1].content.slice(0, 50),
          );
        }
      }

      const box = document.getElementById("chatMessages");
      if (!box) {
        console.error(
          "📚 [LOAD HISTORY] ERROR: chatMessages element not found!",
        );
        return;
      }
      if (isStale()) return;

      // ALWAYS clear on load - fixes hard refresh showing old messages
      console.log("📚 [LOAD HISTORY] Clearing chatMessages...");
      box.innerHTML = "";
      box.dataset.historyLoaded = "false";
      setLastAppendedAssistantContent("");
      setLastAppendedUserContent("");

      // Load crew-lead history if available
      if (d.history && d.history.length) {
        // Only show recent messages to avoid overwhelming UI (last 50)
        const recentHistory = d.history.slice(-50);
        console.log(
          "📚 [LOAD HISTORY] Appending",
          recentHistory.length,
          "messages...",
        );
        recentHistory.forEach((h) => {
          if (isStale()) return;
          appendChatBubble(h.role === "user" ? "user" : "assistant", h.content);
          if (h.role === "assistant")
            setLastAppendedAssistantContent(h.content);
          if (h.role === "user") setLastAppendedUserContent(h.content);
        });
        console.log(
          "📚 [LOAD HISTORY] Appended",
          recentHistory.length,
          "messages",
        );
      } else {
        console.log("📚 [LOAD HISTORY] No history found");
      }

      // Load passthrough logs (CLI interactions) ONLY if no crew-lead history exists
      // This prevents mixing old CLI logs with current crew-lead conversations
      if (!d.history || d.history.length === 0) {
        const passthroughLog = JSON.parse(
          localStorage.getItem(PASSTHROUGH_LOG_KEY) || "[]",
        );

        // Strict timestamp validation: only last 6 hours + valid timestamp
        const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
        const recentLog = passthroughLog.filter((entry) => {
          // Must have timestamp AND be within last 6 hours AND have valid content
          return (
            entry.timestamp &&
            typeof entry.timestamp === "number" &&
            entry.timestamp > sixHoursAgo &&
            entry.text &&
            entry.text.trim().length > 0
          );
        });

        if (recentLog.length > 0) {
          appendPassthroughLogsToChat(recentLog);
        }

        // Clean up localStorage - remove old entries
        if (recentLog.length !== passthroughLog.length) {
          localStorage.setItem(PASSTHROUGH_LOG_KEY, JSON.stringify(recentLog));
        }
      }

      box.scrollTop = box.scrollHeight;
      box.dataset.historyLoaded = "true";
    } catch (err) {
      if (isStale()) return;
      console.warn("Failed to load chat history:", err);
      // On error, still mark as loaded to prevent infinite retry
      const box = document.getElementById("chatMessages");
      if (box) box.dataset.historyLoaded = "true";
    } finally {
      if (chatBoxEl) chatBoxEl.dataset.historyLoading = "false";
      flushHistoryIdleWaiters();
    }
  }

  function appendPassthroughLogsToChat(log) {
    const box = document.getElementById("chatMessages");
    if (!box || !log.length) return;
    const engineLabels = {
      claude: "Claude Code",
      cursor: "Cursor CLI",
      opencode: "OpenCode",
      codex: "Codex CLI",
      gemini: "Gemini CLI",
      "gemini-cli": "Gemini CLI",
      "docker-sandbox": "Docker Sandbox",
      "crew-cli": "Crew CLI",
    };
    for (const entry of log) {
      if (entry.role === "user") {
        appendChatBubble("user", entry.text);
      } else {
        let cleanedText = String(entry.text || "")
          .split("\n")
          .filter((line) => !shouldDropPassthroughStderrLine(entry.engine, line))
          .join("\n")
          .trim();
        cleanedText = filterOpenCodePassthroughTextChunk(entry.engine, cleanedText);
        cleanedText = filterGeminiPassthroughTextChunk(entry.engine, cleanedText);
        const bubble = document.createElement("div");
        bubble.className = "chat-bubble assistant";
        bubble.style.cssText =
          "background:var(--surface-2);border-radius:10px;padding:12px 14px;font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word;font-family:monospace;font-size:12px;color:var(--text-2);";
        const lbl = document.createElement("div");
        lbl.style.cssText =
          "font-size:11px;font-weight:700;color:var(--text-3);margin-bottom:6px;";
        const ex = entry.exitCode ?? 0;
        lbl.textContent =
          (engineLabels[entry.engine] || entry.engine) +
          " · direct passthrough " +
          (ex === 0 ? "✓" : "⚠") +
          " (exit " +
          ex +
          ")";
        const cnt = document.createElement("div");
        cnt.textContent = cleanedText || entry.text;
        bubble.appendChild(lbl);
        bubble.appendChild(cnt);
        box.appendChild(bubble);
      }
    }
  }

  function chatAtAtInput() {
    const ta = document.getElementById("chatInput");
    const menu = document.getElementById("chatAtAtMenu");
    const hint = document.getElementById("chatAtAtTemplate");
    if (!ta || !menu || !hint) return;
    try {
      const val = ta.value;
      const caret = ta.selectionStart;
      const before = val.slice(0, caret);
      const mentionMatch = before.match(/(^|\s)@([a-zA-Z0-9_-]*)$/);
      if (mentionMatch && before.lastIndexOf("@@") !== before.length - mentionMatch[0].length) {
        loadMentionAgents()
          .then((agents) => {
            const prefix = (mentionMatch[2] || "").toLowerCase();
            const filtered = agents
              .filter((agent) => agent.id.toLowerCase().includes(prefix))
              .slice(0, 8);
            if (!filtered.length) {
              menu.style.display = "none";
              hint.style.display = "none";
              return;
            }
            menu.style.display = "block";
            menu.dataset.mode = "mention";
            menu.innerHTML = "";
            filtered.forEach((agent) => {
              const row = document.createElement("div");
              row.style.cssText =
                "padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border);";
              row.onmouseenter = function onmouseenter() {
                row.style.background = "var(--bg-hover)";
              };
              row.onmouseleave = function onmouseleave() {
                row.style.background = "";
              };
              row.innerHTML =
                `<span style="color:var(--accent);font-weight:600;">@${agent.id}</span> <span style="color:var(--text-3);">${agent.name || agent.role || "agent"}</span>`;
              row.onclick = function onclick() {
                const tokenStart =
                  caret - mentionMatch[0].length + mentionMatch[1].length;
                const insert = `@${agent.id} `;
                ta.value = val.slice(0, tokenStart) + insert + val.slice(caret);
                ta.selectionStart = ta.selectionEnd = tokenStart + insert.length;
                ta.focus();
                menu.style.display = "none";
                hint.style.display = "block";
                hint.textContent = `Mention target: @${agent.id}`;
              };
              menu.appendChild(row);
            });
            hint.style.display = "block";
            hint.textContent = prefix
              ? `Matching agents for @${prefix}`
              : "Type an agent name, e.g. @crew-coder";
          })
          .catch(() => {
            menu.style.display = "none";
            hint.style.display = "none";
          });
        return;
      }
      const lastAt = before.lastIndexOf("@@");
      if (lastAt === -1) {
        menu.style.display = "none";
        hint.style.display = "none";
        return;
      }
      const afterAt = before.slice(lastAt + 2);
      if (/\s/.test(afterAt)) {
        menu.style.display = "none";
        hint.style.display = "none";
        return;
      }
      const prefix = afterAt.toUpperCase();
      const filtered = ATAT_COMMANDS.filter((c) => c.id.indexOf(prefix) === 0);
      if (filtered.length === 0) {
        menu.style.display = "none";
        hint.style.display = "none";
        return;
      }
      menu.style.display = "block";
      menu.style.visibility = "visible";
      menu.dataset.mode = "atat";
      menu.innerHTML = "";
      filtered.forEach((c) => {
        const row = document.createElement("div");
        row.style.cssText =
          "padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border);";
        row.onmouseenter = function onmouseenter() {
          row.style.background = "var(--bg-hover)";
        };
        row.onmouseleave = function onmouseleave() {
          row.style.background = "";
        };
        row.innerHTML =
          '<span style="color:var(--accent);font-weight:600;">@@' +
          c.id +
          '</span> <span style="color:var(--text-3);">' +
          c.label +
          "</span>";
        row.onclick = function onclick() {
          const insert = "@@" + c.id + (c.template ? " " + c.template : "");
          ta.value = val.slice(0, lastAt) + insert + val.slice(caret);
          ta.selectionStart = ta.selectionEnd = lastAt + insert.length;
          ta.focus();
          menu.style.display = "none";
          hint.style.display = "block";
          hint.textContent =
            (c.id === "PROMPT"
              ? "Full line to send: @@PROMPT "
              : "Template: ") + (c.template ? c.template : "");
        };
        menu.appendChild(row);
      });
      const exact = filtered.find((c) => c.id === prefix);
      if (exact) {
        hint.style.display = "block";
        hint.textContent =
          (exact.id === "PROMPT" ? "Full line: @@PROMPT " : "Template: ") +
          (exact.template || "");
      } else {
        hint.style.display = "none";
      }
    } catch (err) {
      if (typeof console !== "undefined") console.warn("chatAtAtInput", err);
    }
  }

  function chatKeydown(e) {
    const menu = document.getElementById("chatAtAtMenu");
    if (
      menu &&
      menu.style.display === "block" &&
      (e.key === "Enter" || e.key === "Tab")
    ) {
      const first = menu.firstElementChild;
      if (first) {
        e.preventDefault();
        first.click();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
    if (
      menu &&
      menu.style.display === "block" &&
      (e.key === "Escape" || e.key === "Tab")
    )
      menu.style.display = "none";
  }

  // Track active chat abort controller so we can cancel regular (non-passthrough) messages
  // DEPRECATED: Now using TaskManager for individual task control
  let _chatAbort = null;

  async function sendChat() {
    const input = document.getElementById("chatInput");
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
        sendBtn.textContent = "Send";
        sendBtn.className = "btn-green";
      }
      input.focus();
      return;
    }

    const engine = document.getElementById("passthroughEngine")?.value || "";
    const selectedAgent =
      document.getElementById("chatAgentSelector")?.value || "";

    // NEW: Check unified mode selector
    const modeSelector = document.getElementById("chatModeSelector");
    const selectedMode = modeSelector?.value || "crew-lead";

    if (selectedMode.startsWith("cli:")) {
      // Direct CLI mode (cli:opencode, cli:cursor, etc.)
      const cliName = selectedMode.replace("cli:", "");
      await sendPassthrough(text, cliName);
      return;
    } else if (selectedMode !== "crew-lead") {
      // Direct agent mode (crew-coder, crew-qa, etc.)
      await sendDirectAgent(text, selectedMode);
      return;
    }

    // Legacy fallback: Priority: passthroughEngine > chatAgentSelector > crew-lead
    if (engine) {
      await sendPassthrough(text, engine);
      return;
    }
    if (selectedAgent) {
      await sendDirectAgent(text, selectedAgent);
      return;
    }

    const directMention = await resolveLeadingMentionAgent(text);
    if (directMention) {
      await sendDirectAgent(directMention.message, directMention.agentId);
      return;
    }

    input.value = "";
    // DON'T disable input - allow concurrent messages
    // input.disabled = true;
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.textContent = "Send";
      sendBtn.className = "btn-green";
    }
    appendChatBubble("user", text);
    setLastAppendedUserContent(text);
    setLastSentContent(text);
    setLastAppendedAssistantContent(""); // Reset so HTTP fallback can display if SSE is silent

    const typingId = "typing-" + Date.now();
    const typingDiv = document.createElement("div");
    typingDiv.id = typingId;
    typingDiv.style.cssText =
      "font-size:12px;color:var(--text-3);padding:4px 6px;";
    const cl = getCrewLeadInfo() || { emoji: "🧠", name: "crew-lead" };
    typingDiv.textContent = cl.emoji + " " + cl.name + " is thinking...";
    const box = document.getElementById("chatMessages");
    box.appendChild(typingDiv);
    box.scrollTop = box.scrollHeight;

    const controller = new AbortController();
    const taskId = "chat-" + Date.now();

    // DON'T register chat messages as tasks - they're just conversations
    // Only agent dispatches should show in tasks panel
    // taskManager.registerTask(taskId, {
    //   agent: 'crew-lead',
    //   type: 'chat',
    //   description: text.slice(0, 60) + (text.length > 60 ? '...' : ''),
    //   controller,
    // });

    try {
      const activeProject = resolveVisibleChatProjectId();
      const activeProj = activeProject && state.projectsData[activeProject];
      const d = await postJSON(
        "/api/chat/unified",
        {
          mode: "crew-lead",
          message: text,
          sessionId: getChatSessionId(),
          projectId: activeProject || "general",
          ...(activeProj?.outputDir ? { projectDir: activeProj.outputDir } : {}),
        },
        controller.signal,
      );
      document.querySelectorAll('[id^="typing-"]').forEach((el) => el.remove());
      if (d.ok === false && d.error) {
        appendChatBubble("assistant", "⚠️ " + d.error);
        setLastAppendedAssistantContent("");
        // Don't fail task since we didn't register it
        // taskManager.failTask(taskId, d.error);
      } else if (d.reply) {
        // SSE chat_message is the canonical display path — it removes
        // the streaming bubble and creates the final one.  Only use
        // the HTTP reply when SSE was completely silent (connection drop).
        if (!getLastAppendedAssistantContent()) {
          appendChatBubble("assistant", d.reply);
          setLastAppendedAssistantContent(d.reply);
          if (box) box.scrollTop = box.scrollHeight;
        }
        // Don't complete task since we didn't register it
        // taskManager.completeTask(taskId);
      }
      if (d.dispatched) {
        const dispatchedTargets = Array.isArray(d.dispatched)
          ? d.dispatched
              .map((item) => item?.agent || item?.id)
              .filter(Boolean)
          : [d.dispatched.agent].filter(Boolean);
        const note = document.createElement("div");
        note.style.cssText =
          "font-size:11px;color:var(--text-3);text-align:center;padding:4px;";
        if (dispatchedTargets.length) {
          note.textContent = "⚡ Dispatched to " + dispatchedTargets.join(", ");
          box.appendChild(note);
        }
      }
      if (d.pendingProject) appendRoadmapCard(box, d.pendingProject);
      box.scrollTop = box.scrollHeight;
    } catch (e) {
      document.querySelectorAll('[id^="typing-"]').forEach((el) => el.remove());
      if (e.name === "AbortError") {
        appendChatBubble("assistant", "⚠️ Message cancelled");
        setLastAppendedAssistantContent("");
        // Don't stop task since we didn't register it
        // taskManager.stopTask(taskId);
      } else {
        let errMsg = e.message || String(e);
        try {
          const parsed = JSON.parse(errMsg);
          if (parsed && typeof parsed.error === "string") errMsg = parsed.error;
        } catch {}
        appendChatBubble("assistant", "⚠️ Error: " + errMsg);
        setLastAppendedAssistantContent("");
        // Don't fail task since we didn't register it
        // taskManager.failTask(taskId, errMsg);
      }
      box.scrollTop = box.scrollHeight;
    } finally {
      _chatAbort = null;
      // input.disabled = false; // Already enabled for concurrent mode
      if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.textContent = "Send";
        sendBtn.className = "btn-green";
      }
      input.focus();
    }
  }

  async function clearChatHistory() {
    if (!confirm("Clear chat history for this session?")) return;
    const box = document.getElementById("chatMessages");
    box.innerHTML = "";
    box.dataset.historyLoaded = "false"; // Reset the flag so history reloads
    localStorage.removeItem(PASSTHROUGH_LOG_KEY);
    await postJSON("/api/crew-lead/clear", {
      sessionId: getChatSessionId(),
    }).catch(() => {});
    // Reload fresh history after clearing
    await loadChatHistory();
  }

  function savePassthroughMsg(role, engine, text, exitCode) {
    try {
      const log = JSON.parse(localStorage.getItem(PASSTHROUGH_LOG_KEY) || "[]");
      log.push({ role, engine, text, exitCode, timestamp: Date.now() }); // Changed ts → timestamp
      if (log.length > PASSTHROUGH_LOG_MAX)
        log.splice(0, log.length - PASSTHROUGH_LOG_MAX);
      localStorage.setItem(PASSTHROUGH_LOG_KEY, JSON.stringify(log));
    } catch {}
  }

  function restorePassthroughLog() {
    try {
      const log = JSON.parse(localStorage.getItem(PASSTHROUGH_LOG_KEY) || "[]");
      if (!log.length) return;

      // Check if loadChatHistory is still pending - if so, don't append yet
      // (loadChatHistory will call appendPassthroughLogsToChat after it finishes)
      const box = document.getElementById("chatMessages");
      if (!box) return;

      // Only restore if box is empty or if we're in passthrough mode
      const engine = document.getElementById("passthroughEngine")?.value;
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
    const indicator = document.getElementById("passthroughSessionIndicator");
    if (!indicator) return;
    const engine = document.getElementById("passthroughEngine")?.value;
    if (!engine) {
      indicator.style.display = "none";
      return;
    }
    const activeProjectId = resolveVisibleChatProjectId();
    const activeProj = activeProjectId && state.projectsData[activeProjectId];
    const projectDir = activeProj?.outputDir || null;
    const sessionScope = getChatSessionId() || "owner";
    try {
      const data = await getJSON("/api/passthrough-sessions");
      const sessions = data.sessions || {};
      // Backend uses engine:projectDir:sessionScope; when no project, backend falls back to config/cwd
      const key = projectDir ? `${engine}:${projectDir}:${sessionScope}` : null;
      // Also check legacy key format (engine:projectDir) for backward compat
      const hasSession =
        key && (sessions[key] || sessions[`${engine}:${projectDir}`]);
      indicator.style.display = hasSession ? "inline-block" : "none";
      indicator.title = hasSession
        ? `Session active for ${activeProj?.name || projectDir?.split("/").pop() || "this project"} — click to clear`
        : "";
    } catch {
      indicator.style.display = "none";
    }
  }

  async function clearPassthroughSession() {
    const engine = document.getElementById("passthroughEngine")?.value;
    if (!engine) return;
    const activeProjectId = resolveVisibleChatProjectId();
    const activeProj = activeProjectId && state.projectsData[activeProjectId];
    const projectDir = activeProj?.outputDir || null;
    if (!projectDir) return;
    const sessionScope = getChatSessionId() || "owner";
    const key = `${engine}:${projectDir}:${sessionScope}`;
    const legacyKey = `${engine}:${projectDir}`;
    try {
      // Try full key first (backend format), then legacy
      await fetch(`/api/passthrough-sessions?key=${encodeURIComponent(key)}`, {
        method: "DELETE",
      });
      await fetch(
        `/api/passthrough-sessions?key=${encodeURIComponent(legacyKey)}`,
        { method: "DELETE" },
      );
      showNotification("Session cleared — next message starts fresh");
      refreshSessionIndicator();
    } catch (e) {
      showNotification("Failed: " + e.message, true);
    }
  }

  // Helper to reset send button to default state
  function resetSendButton() {
    const sendBtn = document.querySelector('[data-action="sendChat"]');
    if (sendBtn) {
      sendBtn.textContent = "Send";
      sendBtn.className = "btn-green";
      sendBtn.disabled = false;
    }
  }

  async function sendPassthrough(text, engine) {
    const input = document.getElementById("chatInput");
    const sendBtn = document.querySelector('[data-action="sendChat"]');
    const stopBtn = document.querySelector('[data-action="stopPassthrough"]');
    const modelSelect = document.getElementById("passthroughModel");
    const engineLabels = {
      claude: "Claude Code",
      cursor: "Cursor CLI",
      opencode: "OpenCode",
      codex: "Codex CLI",
      gemini: "Gemini CLI",
      "gemini-cli": "Gemini CLI",
      "docker-sandbox": "Docker Sandbox",
      "crew-cli": "Crew CLI",
    };

    // Legacy single-task abort (kept for backward compatibility)
    if (_passthroughAbort) {
      _passthroughAbort.abort();
      _passthroughAbort = null;
      input.disabled = false;
      if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.textContent = "Send";
        sendBtn.className = "btn-green";
      }
      if (stopBtn) stopBtn.style.display = "none";
      input.focus();
      return;
    }

    input.value = "";
    // DON'T disable input - allow concurrent operations
    // input.disabled = true;
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.textContent = "Send";
      sendBtn.className = "btn-green";
    }
    // Hide the separate kill button since we're using task manager
    if (stopBtn) {
      stopBtn.style.display = "none";
    }

    appendChatBubble("user", text);
    const box = document.getElementById("chatMessages");
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble assistant";
    bubble.style.cssText =
      "background:var(--surface-2);border-radius:10px;padding:12px 14px;font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word;font-family:monospace;font-size:12px;color:var(--text-2);";
    const label = document.createElement("div");
    label.style.cssText =
      "font-size:11px;font-weight:700;color:var(--text-3);margin-bottom:6px;";
    const activeProjectId = resolveVisibleChatProjectId();
    const activeProj = activeProjectId && state.projectsData[activeProjectId];
    const selectedModel = modelSelect?.value || "";
    const modelLabel = selectedModel ? ` [${selectedModel}]` : "";
    label.textContent =
      (engineLabels[engine] || engine) +
      modelLabel +
      " · direct passthrough" +
      (activeProj?.outputDir
        ? " @ " + activeProj.outputDir.split("/").pop()
        : "");
    const content = document.createElement("div");
    bubble.appendChild(label);
    bubble.appendChild(content);
    box.appendChild(bubble);
    box.scrollTop = box.scrollHeight;

    const controller = new AbortController();
    const taskId = "passthrough-" + engine + "-" + Date.now();
    const stderrFilter = createPassthroughStderrLineFilter(engine);
    let stderrFilteredAccum = "";
    let sawAssistantChunk = false;

    // DON'T register passthrough/CLI messages as tasks
    // Only actual agent dispatches should show in tasks panel
    // taskManager.registerTask(taskId, {
    //   agent: engineLabels[engine] || engine,
    //   type: 'passthrough',
    //   description: text.slice(0, 60) + (text.length > 60 ? '...' : ''),
    //   controller,
    // });

    try {
      const projectDir = activeProj?.outputDir || undefined;
      const injectHistory =
        document.getElementById("passthroughInjectHistory")?.checked || false;
      const payload = { engine, message: text };
      if (projectDir) payload.projectDir = projectDir;
      payload.projectId = activeProjectId || "general";
      payload.sessionId = getChatSessionId(); // Add session ID for proper isolation
      if (injectHistory) payload.injectHistory = true;
      if (selectedModel) payload.model = selectedModel;
      const resp = await fetch("/api/chat/unified", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "cli", ...payload }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        content.textContent = `Error ${resp.status}: ${await resp.text()}`;
        // Don't fail task since we didn't register it
        // taskManager.failTask(taskId, `HTTP ${resp.status}`);
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.type === "chunk" && ev.text) {
              let piece = filterOpenCodePassthroughTextChunk(engine, ev.text);
              piece = filterGeminiPassthroughTextChunk(engine, piece);
              if (piece) {
                sawAssistantChunk = true;
                content.textContent += piece;
                box.scrollTop = box.scrollHeight;
              }
            } else if (ev.type === "stderr" && ev.text) {
              const cleaned = stderrFilter.push(ev.text);
              if (cleaned) {
                stderrFilteredAccum += cleaned;
                let stderrPiece = filterOpenCodePassthroughTextChunk(engine, cleaned);
                stderrPiece = filterGeminiPassthroughTextChunk(engine, stderrPiece);
                const inkEngines = engine === "opencode" || engine === "antigravity";
                // Match Vibe for OpenCode: Ink status lines often on stderr; don't spam main bubble
                // after assistant text (no separate trace panel in dashboard passthrough bubble).
                const appendStderr =
                  stderrPiece &&
                  (!inkEngines || !sawAssistantChunk);
                if (appendStderr) {
                  content.textContent += stderrPiece;
                  box.scrollTop = box.scrollHeight;
                }
              }
            } else if (ev.type === "done") {
              const tail = stderrFilter.flush();
              if (tail) {
                stderrFilteredAccum += tail;
                let tailPiece = filterOpenCodePassthroughTextChunk(engine, tail);
                tailPiece = filterGeminiPassthroughTextChunk(engine, tailPiece);
                const inkEngines = engine === "opencode" || engine === "antigravity";
                if (
                  tailPiece &&
                  (!inkEngines || !sawAssistantChunk)
                ) {
                  content.textContent += tailPiece;
                  box.scrollTop = box.scrollHeight;
                }
              }
              const exitCode = ev.exitCode ?? 0;
              const ok = exitCode === 0;
              label.textContent += ` ${ok ? "✓" : "⚠"} (exit ${exitCode})`;
              const topErr = summarizePassthroughTopErrorLine(
                stderrFilteredAccum,
                engine,
              );
              if (!ok && topErr && !content.textContent.includes(topErr)) {
                const hintEl = document.createElement("div");
                hintEl.style.cssText =
                  "font-size:11px;font-weight:600;color:var(--danger, #f87171);margin-top:8px;white-space:pre-wrap;word-break:break-word;";
                hintEl.textContent = `↳ ${topErr}`;
                bubble.appendChild(hintEl);
                box.scrollTop = box.scrollHeight;
              }
              savePassthroughMsg("user", engine, text, null);
              savePassthroughMsg(
                "engine",
                engine,
                content.textContent,
                exitCode,
              );
              // Don't complete task since we didn't register it
              // taskManager.completeTask(taskId);
            }
          } catch {}
        }
      }
      const strayStderr = stderrFilter.flush();
      if (strayStderr) {
        stderrFilteredAccum += strayStderr;
        let stray = filterOpenCodePassthroughTextChunk(engine, strayStderr);
        stray = filterGeminiPassthroughTextChunk(engine, stray);
        const inkEngines = engine === "opencode" || engine === "antigravity";
        if (stray && (!inkEngines || !sawAssistantChunk)) {
          content.textContent += stray;
          box.scrollTop = box.scrollHeight;
        }
      }
    } catch (e) {
      if (e.name === "AbortError") {
        label.textContent += " ✗ (killed)";
        content.textContent += content.textContent
          ? "\n\n[stopped]"
          : "[stopped]";
        // Don't stop task since we didn't register it
        // taskManager.stopTask(taskId);
      } else {
        content.textContent = "Error: " + e.message;
        // Don't fail task since we didn't register it
        // taskManager.failTask(taskId, e.message);
      }
    } finally {
      _passthroughAbort = null;
      if (stopBtn) {
        stopBtn.style.display = "none";
      }
      // input.disabled = false; // Already enabled for concurrent mode
      if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.textContent = "Send";
        sendBtn.className = "btn-green";
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
    if (!confirm("Stop all running pipelines?")) return;
    try {
      await postJSON("/api/crew-lead/chat", {
        message: "@@STOP",
        sessionId: getChatSessionId(),
      });
      showNotification("⏹ Stop signal sent");
    } catch (e) {
      showNotification("Failed: " + e.message, true);
    }
  }

  async function killAll() {
    if (!confirm("Kill all agents? Bridges must be restarted after.")) return;
    try {
      await postJSON("/api/crew-lead/chat", {
        message: "@@KILL",
        sessionId: getChatSessionId(),
      });
      showNotification("☠️ Kill signal sent");
    } catch (e) {
      showNotification("Failed: " + e.message, true);
    }
  }

  // ── Multimodal Functions ─────────────────────────────────────────────────

  let mediaRecorder = null;
  let audioChunks = [];

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function handleImageUpload(file, customPrompt) {
    let fileToProcess;

    if (file instanceof File) {
      fileToProcess = file;
    } else {
      const fileInput = document.getElementById("imageUpload");
      if (!fileInput.files || !fileInput.files[0]) return;
      fileToProcess = fileInput.files[0];
      fileInput.value = ""; // Reset for next upload
    }

    const fileName = fileToProcess.name;
    const fileType = fileToProcess.type;
    const fileSize = (fileToProcess.size / 1024).toFixed(1);

    // Check file type and handle accordingly
    const isImage = fileType.startsWith("image/");
    const isPDF = fileType === "application/pdf";
    const isExcel =
      fileType.includes("spreadsheet") ||
      fileType.includes("excel") ||
      fileName.match(/\.(xlsx?|csv)$/i);
    const isDoc =
      fileType.includes("document") || fileName.match(/\.(docx?|txt|md)$/i);

    let fileIcon = "📎";
    if (isImage) fileIcon = "📷";
    else if (isPDF) fileIcon = "📄";
    else if (isExcel) fileIcon = "📊";
    else if (isDoc) fileIcon = "📝";

    // Get any text from input to send with the file
    const chatInput = document.getElementById("chatInput");
    const userText = chatInput ? chatInput.value.trim() : "";
    const promptToUse =
      customPrompt ||
      userText ||
      (isImage
        ? "Describe this image in detail. What do you see?"
        : `Analyze this ${fileName} file`);

    appendChatBubble(
      "user",
      `${fileIcon} [Attached: ${fileName}] ${userText ? `\n\n${userText}` : ""}`,
    );
    appendChatBubble(
      "assistant",
      `🔍 Analyzing ${isImage ? "image" : "file"}...`,
    );

    try {
      const base64 = await fileToBase64(fileToProcess);

      const result = await postJSON("/api/analyze-image", {
        image: base64,
        prompt: promptToUse,
        fileName: fileName,
        fileType: fileType,
      });

      if (result.ok) {
        appendChatBubble(
          "assistant",
          `**${isImage ? "Image" : "File"} Analysis:**\n\n${result.result}`,
        );

        // Put analysis in input for user to follow up
        if (chatInput) {
          chatInput.value = `[Attached: ${fileName}]\n\n${result.result}\n\n`;
          chatInput.focus();
        }
      } else {
        appendChatBubble("assistant", `⚠️ Analysis failed: ${result.error}`);
      }
    } catch (err) {
      appendChatBubble("assistant", `⚠️ Analysis error: ${err.message}`);
    }

    // Clear input after sending
    if (chatInput && userText) {
      chatInput.value = "";
    }
  }

  async function toggleVoiceRecording() {
    const btn = document.getElementById("recordVoiceBtn");

    if (!mediaRecorder || mediaRecorder.state === "inactive") {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        audioChunks = [];

        mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });

        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) audioChunks.push(e.data);
        };

        mediaRecorder.onstop = async () => {
          const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
          stream.getTracks().forEach((track) => track.stop()); // Stop mic access

          appendChatBubble(
            "user",
            `🎤 [Voice message recorded - ${(audioBlob.size / 1024).toFixed(0)} KB]`,
          );
          appendChatBubble("assistant", "🎤 Transcribing voice...");

          try {
            const formData = new FormData();
            formData.append("audio", audioBlob, "voice.webm");

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s for Groq
            const response = await fetch("/api/transcribe-audio", {
              method: "POST",
              body: formData,
              signal: controller.signal,
            });
            clearTimeout(timeoutId);

            let result;
            try {
              result = await response.json();
            } catch (parseErr) {
              appendChatBubble(
                "assistant",
                `⚠️ Transcription error: Server returned invalid response (${response.status})`,
              );
              audioChunks = [];
              return;
            }

            if (result.ok && result.transcription) {
              appendChatBubble(
                "assistant",
                `**Transcription:**\n\n"${result.transcription}"`,
              );

              // Put transcription in input for user to send
              const chatInput = document.getElementById("chatInput");
              chatInput.value = result.transcription;
              chatInput.focus();
            } else {
              appendChatBubble(
                "assistant",
                `⚠️ Transcription failed: ${result.error || "No result"}`,
              );
            }
          } catch (err) {
            const msg = err.message || String(err);
            const hint = msg === "Failed to fetch"
              ? " (Is the dashboard running on port 4319? Try: npm run restart-dashboard)"
              : "";
            appendChatBubble(
              "assistant",
              `⚠️ Transcription error: ${msg}${hint}`,
            );
          }

          audioChunks = [];
        };

        mediaRecorder.start();
        btn.textContent = "⏹️";
        btn.style.background = "var(--red, #ef4444)";
        showNotification("🎤 Recording... Click again to stop");
      } catch (err) {
        showNotification("⚠️ Microphone access denied: " + err.message, true);
      }
    } else {
      // Stop recording
      mediaRecorder.stop();
      btn.textContent = "🎤";
      btn.style.background = "";
    }
  }

  // Setup drag-and-drop for images/files
  function setupDragAndDrop() {
    const chatInput = document.getElementById("chatInput");
    const chatMessages = document.getElementById("chatMessages");

    [chatInput, chatMessages].forEach((el) => {
      if (!el) return;

      el.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.style.outline = "2px dashed var(--accent, #3b82f6)";
      });

      el.addEventListener("dragleave", (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.style.outline = "";
      });

      el.addEventListener("drop", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.style.outline = "";

        const files = e.dataTransfer.files;
        if (files && files.length > 0) {
          const file = files[0];
          await handleImageUpload(file);
        }
      });
    });
  }

  // Initialize drag-and-drop on module load
  setupDragAndDrop();

  // ── Direct Agent Chat (Dashboard Chat Bridge) ─────────────────────────────────
  // Works like TG/WA bridges: direct LLM call with @@CLI support

  async function sendDirectAgent(text, agentId) {
    const input = document.getElementById("chatInput");
    const sendBtn = document.querySelector('[data-action="sendChat"]');
    const box = document.getElementById("chatMessages");

    input.value = "";
    appendChatBubble("user", text);
    setLastAppendedUserContent(text);
    setLastSentContent(text);

    // Fetch agent info for display
    let agentInfo = { emoji: "🤖", name: agentId, model: "" };
    try {
      const agentsData = await getJSON("/api/agents-config");
      const agent = (agentsData.agents || []).find((a) => a.id === agentId);
      if (agent) {
        agentInfo = {
          emoji: agent.emoji || "🤖",
          name: agent.name || agentId,
          model: formatAgentModelLabel(agent),
        };
      }
    } catch (err) {
      console.warn("Could not fetch agent info:", err);
    }

    // Show typing indicator with agent identity
    const typingId = "typing-" + Date.now();
    const typingDiv = document.createElement("div");
    typingDiv.id = typingId;
    typingDiv.style.cssText =
      "font-size:12px;color:var(--text-3);padding:4px 6px;";
    typingDiv.textContent = `${agentInfo.emoji} ${agentInfo.name} is thinking...`;
    box.appendChild(typingDiv);
    box.scrollTop = box.scrollHeight;

    try {
      const activeProjectId = resolveVisibleChatProjectId();
      const response = await postJSON("/api/chat/unified", {
        mode: "agent",
        agentId,
        message: text,
        sessionId: `dashboard-chat-${agentId}-${getChatSessionId()}`,
        projectId: activeProjectId || "general",
      });

      // Remove typing indicator
      document.querySelectorAll('[id^="typing-"]').forEach((el) => el.remove());

      if (response.error) {
        // Create custom error bubble with agent identity
        appendCustomAgentBubble(agentInfo, "⚠️ " + response.error, box);
        setLastAppendedAssistantContent("");
        return;
      }

      if (response.reply) {
        // Create custom reply bubble with agent identity and model
        appendCustomAgentBubble(agentInfo, response.reply, box);
        setLastAppendedAssistantContent(response.reply);
      }

      // Show CLI execution status
      if (response.cliInvoked) {
        const cliNote = document.createElement("div");
        cliNote.style.cssText =
          "font-size:11px;color:var(--text-3);text-align:center;padding:4px;";
        cliNote.textContent = `⚡ Executing ${response.cliInvoked}... (check process status)`;
        box.appendChild(cliNote);
      }

      box.scrollTop = box.scrollHeight;
    } catch (err) {
      document.querySelectorAll('[id^="typing-"]').forEach((el) => el.remove());
      appendCustomAgentBubble(agentInfo, "⚠️ Error: " + err.message, box);
      setLastAppendedAssistantContent("");
    }
  }

  // Helper to create chat bubble with specific agent identity
  function appendCustomAgentBubble(agentInfo, text, box) {
    const div = document.createElement("div");
    div.style.cssText =
      "display:flex;flex-direction:column;align-items:flex-start;gap:4px;";

    const labelEl = document.createElement("div");
    labelEl.style.cssText =
      "font-size:11px;color:var(--text-3);padding:0 6px;display:flex;align-items:center;gap:6px;";
    labelEl.textContent = `${agentInfo.emoji} ${agentInfo.name}`;

    // Show model badge
    if (agentInfo.model) {
      const badge = document.createElement("span");
      badge.title = "Primary model";
      badge.style.cssText =
        "font-size:10px;padding:1px 6px;border-radius:999px;background:rgba(52,211,153,0.1);color:#34d399;border:1px solid rgba(52,211,153,0.2);cursor:default;";
      const [provider, ...modelParts] = agentInfo.model.split("/");
      badge.textContent = modelParts.join("/") || agentInfo.model;
      labelEl.appendChild(badge);
    }

    const bubble = document.createElement("div");
    bubble.style.cssText =
      "max-width:80%;padding:10px 14px;border-radius:14px 14px 14px 4px;background:var(--surface-2);color:var(--text-2);white-space:pre-wrap;word-break:break-word;line-height:1.5;border:1px solid var(--border);";
    bubble.textContent = text;

    div.appendChild(labelEl);
    div.appendChild(bubble);
    box.appendChild(div);
  }

  function getAgentRouteAndModel(agent) {
    if (agent.useCursorCli) {
      return { route: "cursor", model: agent.cursorCliModel || "auto" };
    }
    if (agent.useClaudeCode) {
      return { route: "claude", model: agent.claudeCodeModel || "auto" };
    }
    if (agent.useCodex) {
      return { route: "codex", model: agent.codexModel || "auto" };
    }
    if (agent.useGeminiCli) {
      return { route: "gemini", model: agent.geminiCliModel || "auto" };
    }
    if (agent.useCrewCLI) {
      return { route: "crew-cli", model: agent.crewCliModel || "auto" };
    }
    if (agent.useOpenCode === true) {
      return {
        route: "opencode",
        model: agent.opencodeModel || agent.model || "default",
      };
    }
    return { route: "llm", model: agent.model || "no model" };
  }

  function formatAgentModelLabel(agent) {
    const { route, model } = getAgentRouteAndModel(agent);
    if (route === "llm") return model;
    return `${route}:${model}`;
  }

  let lastAgentSelectorRefreshAt = 0;

  // Load agent list into unified selector
  async function loadChatAgentSelector(force = false) {
    if (!force && Date.now() - lastAgentSelectorRefreshAt < 5000) return;

    // NEW: Load agents into the unified chatModeSelector
    const modeSelector = document.getElementById("chatModeSelector");
    const agentsOptgroup = document.getElementById("agentsOptgroup");

    if (modeSelector && agentsOptgroup) {
      try {
        const data = await getJSON("/api/agents-config");
        const agents = data.agents || [];

        // Filter out coordinators
        const excludeAgents = new Set([
          "crew-lead",
          "orchestrator",
          "crew-orchestrator",
          "crew-pm-cli",
          "crew-pm-frontend",
          "crew-pm-core",
        ]);

        // Clear and repopulate agents optgroup
        agentsOptgroup.innerHTML = "";
        agents
          .filter((a) => !excludeAgents.has(a.id))
          .sort((a, b) => a.id.localeCompare(b.id))
          .forEach((agent) => {
            const opt = document.createElement("option");
            opt.value = agent.id;
            const emoji = agent.emoji || "🤖";
            const modelName = formatAgentModelLabel(agent);
            opt.textContent = `${emoji} ${agent.id} — ${modelName}`;
            agentsOptgroup.appendChild(opt);
          });
        lastAgentSelectorRefreshAt = Date.now();
      } catch (err) {
        console.error("Failed to load agents for unified mode selector:", err);
      }
    }

    // LEGACY: Also populate old chatAgentSelector if it exists
    const selector = document.getElementById("chatAgentSelector");
    if (!selector) return;

    try {
      const data = await getJSON("/api/agents-config");
      const agents = data.agents || [];

      // Clear existing options (keep default)
      selector.innerHTML = '<option value="">🧠 Crew Lead (default)</option>';

      // Add agents (exclude crew-lead and coordinators)
      const excludeAgents = new Set([
        "crew-lead",
        "orchestrator",
        "crew-orchestrator",
      ]);

      agents
        .filter((a) => !excludeAgents.has(a.id))
        .sort((a, b) => a.id.localeCompare(b.id))
        .forEach((agent) => {
          const opt = document.createElement("option");
          opt.value = agent.id;
          const modelName = formatAgentModelLabel(agent);
          opt.textContent = `${agent.id} — ${modelName}`;
          selector.appendChild(opt);
        });
    } catch (err) {
      console.error("Failed to load agents for chat selector:", err);
    }
  }

  // Load agents on init
  loadChatAgentSelector();

  // Keep model labels fresh when opening/focusing the selector.
  document.getElementById("chatModeSelector")?.addEventListener("focus", () => {
    loadChatAgentSelector(true);
  });

  // Poll for CLI process status when agent is selected
  let processStatusInterval = null;

  function startCLIProcessMonitoring() {
    if (processStatusInterval) clearInterval(processStatusInterval);

    processStatusInterval = setInterval(async () => {
      // NEW: Check unified selector
      const modeSelector = document.getElementById("chatModeSelector");
      const selectedMode = modeSelector?.value || "crew-lead";

      // Extract agent ID (handle both 'agent-id' and 'cli:name' formats)
      let selectedAgent = null;
      if (selectedMode.startsWith("cli:")) {
        // For CLI mode, no specific agent - hide status
        const statusPanel = document.getElementById("chatCLIProcessStatus");
        if (statusPanel) statusPanel.style.display = "none";
        return;
      } else if (selectedMode !== "crew-lead") {
        selectedAgent = selectedMode;
      }

      // LEGACY: fallback to old selector
      if (!selectedAgent) {
        selectedAgent = document.getElementById("chatAgentSelector")?.value;
      }

      if (!selectedAgent) {
        // No agent selected - hide status panel
        const statusPanel = document.getElementById("chatCLIProcessStatus");
        if (statusPanel) statusPanel.style.display = "none";
        return;
      }

      try {
        const data = await getJSON(`/api/cli-processes?agent=${selectedAgent}`);
        const processes = data.processes || [];
        updateCLIProcessStatus(processes);
      } catch (err) {
        console.error("Failed to load CLI process status:", err);
      }
    }, 3000); // Poll every 3 seconds
  }

  function updateCLIProcessStatus(processes) {
    const statusPanel = document.getElementById("chatCLIProcessStatus");
    if (!statusPanel) return;

    if (processes.length === 0) {
      statusPanel.style.display = "none";
      return;
    }

    statusPanel.style.display = "block";
    statusPanel.innerHTML = processes
      .map((proc) => {
        const duration = formatDuration(proc.duration);
        const idleFor = formatDuration(proc.idleFor);
        const statusColor = proc.status === "running" ? "#22c55e" : "#f59e0b";
        const statusIcon = proc.status === "running" ? "⚡" : "⏸️";

        return `
        <div style="border-left:3px solid ${statusColor};padding:8px 12px;background:var(--bg-card2);border-radius:6px;margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
            <span style="font-weight:600;font-family:monospace;font-size:13px;">${statusIcon} ${proc.cli}</span>
            <span style="text-transform:uppercase;font-size:11px;font-weight:700;color:var(--text-3);">${proc.status}</span>
          </div>
          <div style="font-size:12px;color:var(--text-2);line-height:1.5;">
            <div>Task: ${(proc.task || "unknown").slice(0, 80)}</div>
            <div>Duration: ${duration} | Idle: ${idleFor} | Lines: ${proc.outputLines || 0}</div>
          </div>
        </div>
      `;
      })
      .join("");
  }

  function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }

  // Start monitoring
  startCLIProcessMonitoring();

  // Re-load agents when switching back to chat view
  document
    .getElementById("chatAgentSelector")
    ?.addEventListener("change", () => {
      const agentId = document.getElementById("chatAgentSelector")?.value;
      if (agentId) {
        showNotification(
          `Switched to ${agentId} - messages go directly to this agent's LLM`,
          "success",
        );
      }
    });

  return {
    loadChatHistory,
    waitForChatHistoryIdle,
    chatAtAtInput,
    chatKeydown,
    sendChat,
    sendDirectAgent,
    loadChatAgentSelector,
    clearChatHistory,
    restorePassthroughLog,
    sendPassthrough,
    stopAll,
    killAll,
    killPassthrough,
    refreshSessionIndicator,
    clearPassthroughSession,
    resetSendButton, // Export for use in app.js
    handleImageUpload,
    toggleVoiceRecording,
  };
}
