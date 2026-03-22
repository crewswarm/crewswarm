import { getJSON, postJSON } from "../core/api.js";
import { escHtml, showNotification, showEmpty, showError } from "../core/dom.js";
import { state, persistState } from "../core/state.js";

let hideAllViews = () => {};
let setNavActive = () => {};
let currentSwarmMessages = [];
let swarmBindingsReady = false;
let swarmMentionAgents = [];
let lastSwarmMentionLoadAt = 0;
let lastSwarmUserContent = null;
let lastSwarmAssistantContent = null;
let pendingSwarmResponder = null;

function getPendingSwarmResponder(message = "") {
  const mentions = Array.from(String(message || "").matchAll(/@([a-zA-Z0-9_-]+)/g))
    .map((match) => match[1]);
  if (mentions.length !== 1) return null;
  const mentionId = mentions[0];
  const agent =
    swarmMentionAgents.find((entry) => entry.id === mentionId) ||
    swarmMentionAgents.find((entry) => entry.id === `crew-${mentionId}`);
  if (!agent) {
    return {
      id: mentionId,
      name: mentionId,
      emoji: "🤖",
    };
  }
  return {
    id: agent.id,
    name: agent.name || agent.displayName || agent.id,
    emoji: agent.emoji || "🤖",
  };
}

function appendSwarmMessage(message) {
  const box = document.getElementById("swarmChatMessages");
  if (!box) return;
  if (
    box.firstElementChild &&
    box.firstElementChild.textContent?.includes("No shared channel messages yet.")
  ) {
    box.innerHTML = "";
  }
  currentSwarmMessages.push(message);
  box.insertAdjacentHTML("beforeend", renderSwarmMessage(message));
  box.scrollTop = box.scrollHeight;
}

function removeSwarmTyping() {
  document.getElementById("swarm-typing-wrapper")?.remove();
}

function showSwarmTyping(responder = null) {
  const box = document.getElementById("swarmChatMessages");
  if (!box || document.getElementById("swarm-typing-wrapper")) return;
  const speaker =
    responder ||
    pendingSwarmResponder ||
    window._crewLeadInfo || { emoji: "🧠", name: "crew-lead" };
  const wrapper = document.createElement("div");
  wrapper.id = "swarm-typing-wrapper";
  wrapper.style.cssText =
    "display:flex;flex-direction:column;align-items:flex-start;gap:4px;margin-bottom:10px;";
  wrapper.innerHTML = `
    <div style="font-size:11px;color:var(--text-3);padding:0 6px;">${escHtml(speaker.emoji)} ${escHtml(speaker.name)}</div>
    <div style="max-width:84%;padding:10px 14px;border-radius:14px 14px 14px 4px;background:var(--surface-2);color:var(--text-2);font-size:14px;line-height:1.5;border:1px solid var(--border);font-style:italic;opacity:0.8;">thinking...</div>
  `;
  box.appendChild(wrapper);
  box.scrollTop = box.scrollHeight;
}

const SOURCE_META = {
  dashboard: { emoji: "🧠", label: "crew-lead" },
  agent: { emoji: "🤖", label: "agent" },
  "sub-agent": { emoji: "👷", label: "sub-agent" },
  cli: { emoji: "⚡", label: "cli" },
  discord: { emoji: "🎮", label: "discord" },
  system: { emoji: "🛰", label: "system" },
};

export function initSwarmChatTab(deps = {}) {
  hideAllViews = deps.hideAllViews || hideAllViews;
  setNavActive = deps.setNavActive || setNavActive;
  ensureSwarmBindings();
}

function ensureSwarmBindings() {
  if (swarmBindingsReady) return;
  const projectSelect = document.getElementById("swarmChatProject");
  const refreshBtn = document.getElementById("swarmChatRefresh");
  const autonomyBtn = document.getElementById("swarmAutonomyBtn");
  const form = document.getElementById("swarmChatForm");
  const input = document.getElementById("swarmChatInput");
  const sendBtn = document.getElementById("swarmChatSend");
  const messagesBox = document.getElementById("swarmChatMessages");
  if (!projectSelect || !refreshBtn || !form || !input || !sendBtn || !messagesBox) return;

  swarmBindingsReady = true;

  projectSelect.addEventListener("change", async () => {
    state.swarmChatProjectId = projectSelect.value || "general";
    persistState();
    await loadSwarmHistory();
  });

  refreshBtn.addEventListener("click", () => {
    loadSwarmProjects().then(loadSwarmHistory).catch((error) => {
      showNotification(`Failed to refresh Swarm: ${error.message}`, "error");
    });
  });
  autonomyBtn?.addEventListener("click", () => {
    toggleSwarmAutonomy().catch((error) => {
      showNotification(`Failed to toggle autonomy: ${error.message}`, "error");
    });
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    event.stopPropagation();
    sendSwarmMessage();
  });
  sendBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    sendSwarmMessage();
  });
  input.addEventListener("keydown", (event) => {
    const menu = document.getElementById("swarmMentionMenu");
    if (
      menu &&
      menu.style.display === "block" &&
      (event.key === "Enter" || event.key === "Tab")
    ) {
      const first = menu.firstElementChild;
      if (first) {
        event.preventDefault();
        first.click();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendSwarmMessage();
    }
  });
  input.addEventListener("input", () => {
    renderSwarmMentionAutocomplete().catch(() => {});
  });
  messagesBox.addEventListener("click", (event) => {
    const row = event.target.closest("[data-swarm-message-id]");
    if (!row) return;
    renderTracePanel(row.dataset.swarmMessageId);
  });
}

async function loadSwarmMentionAgents(force = false) {
  const now = Date.now();
  if (!force && swarmMentionAgents.length && now - lastSwarmMentionLoadAt < 30_000) {
    return swarmMentionAgents;
  }
  const data = await getJSON("/api/chat-participants");
  const participants = (data.participants || [])
    .filter((participant) => participant.id)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((participant) => ({
      id: participant.id,
      name:
        participant.kind === "cli"
          ? `${participant.runtime} runtime`
          : participant.kind,
      role: participant.kind,
      kind: participant.kind,
    }));
  swarmMentionAgents = participants;
  lastSwarmMentionLoadAt = now;
  return participants;
}

async function renderSwarmMentionAutocomplete() {
  const input = document.getElementById("swarmChatInput");
  const menu = document.getElementById("swarmMentionMenu");
  const hint = document.getElementById("swarmMentionHint");
  if (!input || !menu || !hint) return;

  const value = input.value || "";
  const caret = input.selectionStart || 0;
  const before = value.slice(0, caret);
  const match = before.match(/(^|\s)@([a-zA-Z0-9_-]*)$/);
  if (!match) {
    menu.style.display = "none";
    hint.style.display = "none";
    return;
  }

  const prefix = (match[2] || "").toLowerCase();
  const agents = await loadSwarmMentionAgents();
  const filtered = agents.filter((agent) => agent.id.toLowerCase().includes(prefix)).slice(0, 8);
  if (!filtered.length) {
    menu.style.display = "none";
    hint.style.display = "none";
    return;
  }

  menu.style.display = "block";
  menu.innerHTML = "";
  filtered.forEach((agent) => {
    const row = document.createElement("div");
    row.style.cssText =
      "padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border);";
    row.onmouseenter = () => {
      row.style.background = "var(--bg-hover)";
    };
    row.onmouseleave = () => {
      row.style.background = "";
    };
    row.innerHTML = `<span style="color:var(--accent);font-weight:600;">@${agent.id}</span> <span style="color:var(--text-3);">${agent.name || agent.role || "agent"}</span>`;
    row.onclick = () => {
      const tokenStart = caret - match[0].length + match[1].length;
      const insert = `@${agent.id} `;
      input.value = value.slice(0, tokenStart) + insert + value.slice(caret);
      const nextCaret = tokenStart + insert.length;
      input.selectionStart = input.selectionEnd = nextCaret;
      input.focus();
      menu.style.display = "none";
      hint.style.display = "block";
      hint.textContent =
        agent.id === "crew-lead"
          ? "Mention target: @crew-lead. Use this for notes or routing guidance."
          : `Mention target: @${agent.id}. Use a specific work order if you want execution.`;
    };
    menu.appendChild(row);
  });

  hint.style.display = "block";
  hint.textContent = prefix
    ? `Matching participants for @${prefix}`
    : "Type a participant, e.g. @crew-lead for notes or @crew-coder with a specific work order.";
}

export async function showSwarmChat() {
  ensureSwarmBindings();
  hideAllViews();
  document.getElementById("swarmChatView")?.classList.add("active");
  setNavActive("navSwarmChat");
  state.activeTab = "swarm-chat";
  if (!state.swarmChatProjectId) {
    state.swarmChatProjectId = state.chatActiveProjectId || "general";
  }
  persistState();
  await loadSwarmProjects();
  await loadSwarmAutonomy();
  await loadSwarmHistory();
  // No polling needed - SSE handles real-time updates
  // Tab loads fresh history on switch (event-driven)
  document.getElementById("swarmChatInput")?.focus();
}

async function loadSwarmAutonomy() {
  const btn = document.getElementById("swarmAutonomyBtn");
  const status = document.getElementById("swarmAutonomyStatus");
  const input = document.getElementById("swarmChatInput");
  const data = await getJSON("/api/settings/autonomous-mentions");
  const enabled = data.enabled !== false;
  if (btn) {
    btn.textContent = enabled ? "🕸 Auto ON" : "⚫ Auto OFF";
    btn.style.background = enabled ? "rgba(52,211,153,0.15)" : "";
    btn.style.borderColor = enabled ? "rgba(52,211,153,0.3)" : "";
    btn.style.color = enabled ? "var(--green)" : "";
  }
  if (status) {
    status.textContent = enabled
      ? "Autonomous routing is live in this room. @mentions can dispatch agents or run CLI participants."
      : "Autonomous routing is off. @mentions stay visible in chat, but nothing auto-runs.";
  }
  if (input) {
    input.placeholder = enabled
      ? "Talk in-channel. Use @crew-* or @codex/@cursor/@claude/@opencode/@gemini/@crew-cli to route work."
      : "Autonomy is off. @mentions are informational until you turn routing back on.";
  }
}

async function toggleSwarmAutonomy() {
  const current = await getJSON("/api/settings/autonomous-mentions");
  const next = await postJSON("/api/settings/autonomous-mentions", {
    enabled: !current.enabled,
  });
  showNotification(
    "Swarm autonomy " + (next.enabled ? "ENABLED 🕸" : "DISABLED"),
  );
  await loadSwarmAutonomy();
}

// Removed polling - swarm chat now purely event-driven via SSE
// History loads when switching to tab, real-time updates via SSE connection

async function loadSwarmProjects() {
  const select = document.getElementById("swarmChatProject");
  if (!select) return;

  const activeProjectId = state.swarmChatProjectId || state.chatActiveProjectId || "general";
  const projectOptions = [{ id: "general", name: "General" }];

  try {
    const response = await getJSON("/api/projects");
    for (const project of response.projects || []) {
      projectOptions.push({ id: project.id, name: project.name || project.id });
    }
  } catch {}

  select.innerHTML = projectOptions
    .map((project) => {
      const selected = project.id === activeProjectId ? " selected" : "";
      return `<option value="${escHtml(project.id)}"${selected}>${escHtml(project.name)}</option>`;
    })
    .join("");
  state.swarmChatProjectId = select.value || "general";
  persistState();

  const hint = document.getElementById("swarmChatHint");
  if (hint) {
    const activeProject = projectOptions.find((project) => project.id === state.swarmChatProjectId);
    hint.textContent =
      state.swarmChatProjectId === "general"
        ? "Shared global room. Same unified history store as Chat."
        : `Project channel for ${activeProject?.name || state.swarmChatProjectId}. Same history store as Chat.`;
  }
}

async function loadSwarmHistory() {
  const box = document.getElementById("swarmChatMessages");
  if (!box) return;

  const projectId = state.swarmChatProjectId || "general";
  box.innerHTML = "";

  try {
    const response = await getJSON(
      `/api/crew-lead/project-messages?projectId=${encodeURIComponent(projectId)}&limit=300&excludeDirect=true`,
    );
    const messages = response.messages || [];
    currentSwarmMessages = messages;
    if (!messages.length) {
      hideTracePanel();
      showEmpty(box, "No shared channel messages yet.");
      return;
    }
    box.innerHTML = messages.map(renderSwarmMessage).join("");
    box.scrollTop = box.scrollHeight;
  } catch (error) {
    showError(box, `Failed to load shared channel: ${error.message}`);
  }
}

function renderSwarmMessage(message) {
  const meta = SOURCE_META[message.source] || { emoji: "📝", label: message.source || "message" };
  const isUser = message.role === "user";
  const whoEmoji =
    message.metadata?.agentEmoji ||
    (isUser ? "👤" : meta.emoji);
  const who =
    message.metadata?.agentName ||
    message.agent ||
    (isUser ? "You" : meta.label);
  const timestamp = new Date(message.ts || Date.now()).toLocaleTimeString();
  const chips = [];

  if (message.metadata?.channel) chips.push(`#${message.metadata.channel}`);
  if (message.metadata?.directChat) chips.push("direct");
  if (message.metadata?.engine) chips.push(message.metadata.engine);
  if (Array.isArray(message.metadata?.mentions)) {
    message.metadata.mentions.forEach((mention) => chips.push(`@${mention}`));
  }
  if (message.metadata?.triggeredBy === "mention" || message.metadata?.autonomous) {
    chips.push("@mention");
  }
  if (message.parentId || message.metadata?.originMessageId) chips.push("linked");
  if (message.threadId || message.metadata?.originThreadId) chips.push("thread");

  return `
    <div data-swarm-message-id="${escHtml(message.id || "")}" style="display:flex;flex-direction:column;align-items:${isUser ? "flex-end" : "flex-start"};gap:4px;margin-bottom:10px;cursor:pointer;">
      <div style="font-size:11px;color:var(--text-3);padding:0 6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
        <span>${escHtml(whoEmoji)} ${escHtml(who)}</span>
        <span style="opacity:0.7;">${escHtml(timestamp)}</span>
        ${chips.map((chip) => `<span style="padding:1px 6px;border-radius:999px;background:var(--bg-card2);border:1px solid var(--border);">${escHtml(chip)}</span>`).join("")}
      </div>
      <div style="max-width:84%;padding:10px 14px;border-radius:${isUser ? "14px 14px 4px 14px" : "14px 14px 14px 4px"};background:${isUser ? "var(--purple)" : "var(--surface-2)"};color:${isUser ? "#fff" : "var(--text-2)"};font-size:14px;line-height:1.5;white-space:pre-wrap;word-break:break-word;border:1px solid var(--border);">${escHtml(message.content || "")}</div>
    </div>
  `;
}

export function handleSwarmSSEEvent(event) {
  const box = document.getElementById("swarmChatMessages");
  if (!box) return false;

  const activeProjectId = state.swarmChatProjectId || "general";
  const expectedSessionId = `swarm-${activeProjectId}`;
  const normalizeProjectId = (value) =>
    !value || value === "general" ? "general" : value;

  if (
    normalizeProjectId(event.projectId) !== normalizeProjectId(activeProjectId) ||
    event.sessionId !== expectedSessionId
  ) {
    return false;
  }

  if (event.type === "chat_stream") {
    removeSwarmTyping();
    let streamBubble = document.getElementById("swarm-streaming-bubble");
    if (!streamBubble) {
      const wrapper = document.createElement("div");
      wrapper.id = "swarm-streaming-wrapper";
      wrapper.style.cssText =
        "display:flex;flex-direction:column;align-items:flex-start;gap:4px;margin-bottom:10px;";

      const label = document.createElement("div");
      label.style.cssText =
        "font-size:11px;color:var(--text-3);padding:0 6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;";
      const speaker =
        (event.agentName || event.agentEmoji)
          ? {
              name: event.agentName || event.agent || "agent",
              emoji: event.agentEmoji || "🤖",
            }
          : pendingSwarmResponder || window._crewLeadInfo || { emoji: "🧠", name: "crew-lead" };
      label.textContent = `${speaker.emoji} ${speaker.name}`;

      streamBubble = document.createElement("div");
      streamBubble.id = "swarm-streaming-bubble";
      streamBubble.style.cssText =
        "max-width:84%;padding:10px 14px;border-radius:14px 14px 14px 4px;background:var(--surface-2);color:var(--text-2);font-size:14px;line-height:1.5;white-space:pre-wrap;word-break:break-word;border:1px solid var(--border);";
      streamBubble._textNode = document.createTextNode("");
      streamBubble.appendChild(streamBubble._textNode);

      wrapper.appendChild(label);
      wrapper.appendChild(streamBubble);
      box.appendChild(wrapper);
    }

    streamBubble._textNode.textContent += event.token || "";
    box.scrollTop = box.scrollHeight;
    return true;
  }

  if (event.type !== "chat_message") return false;

  const streamWrapper = document.getElementById("swarm-streaming-wrapper");
  if (streamWrapper && event.role === "assistant") streamWrapper.remove();
  if (event.role === "assistant") {
    removeSwarmTyping();
    pendingSwarmResponder = null;
  }

  if (event.role === "user") {
    if (event.content === lastSwarmUserContent) return true;
    lastSwarmUserContent = event.content;
  } else if (event.role === "assistant") {
    if (event.content === lastSwarmAssistantContent) return true;
    lastSwarmAssistantContent = event.content;
  }

  const assistantAgent =
    event.role === "assistant"
      ? event.agent ||
        (event.source === "agent" || event.source === "cli" ? null : "crew-lead")
      : null;

  const message = {
    id: `live-${event.role}-${Date.now()}`,
    ts: Date.now(),
    source: event.source || "dashboard",
    role: event.role,
    content: event.content || "",
    agent: assistantAgent,
    metadata:
      event.role === "assistant"
        ? {
            agentName:
              event.agentName ||
              (assistantAgent === "crew-lead"
                ? (window._crewLeadInfo || {}).name || "crew-lead"
                : assistantAgent || "agent"),
            agentEmoji:
              event.agentEmoji ||
              (assistantAgent === "crew-lead"
                ? (window._crewLeadInfo || {}).emoji || "🧠"
                : "🤖"),
            model: event.model || null,
            ...(event.directChat ? { directChat: true } : {}),
            ...(event.multiDirect ? { multiDirect: true } : {}),
          }
        : {
            agentName: "You",
            agentEmoji: "👤",
          },
  };

  appendSwarmMessage(message);
  return true;
}

function renderTracePanel(messageId) {
  const panel = document.getElementById("swarmTracePanel");
  if (!panel) return;
  const message = currentSwarmMessages.find((entry) => entry.id === messageId);
  if (!message) return;
  const metadata = message.metadata || {};
  const rows = [
    ["messageId", message.id],
    ["source", message.source],
    ["agent", message.agent || null],
    ["taskId", metadata.taskId || null],
    ["threadId", message.threadId || metadata.originThreadId || null],
    ["parentId", message.parentId || metadata.originMessageId || null],
    ["originProjectId", metadata.originProjectId || null],
    ["originChannel", metadata.originChannel || metadata.channel || null],
    ["triggeredBy", metadata.triggeredBy || null],
    ["mentionedBy", metadata.mentionedBy || null],
  ].filter(([, value]) => value);

  panel.style.display = "block";
  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;">
      <strong style="color:var(--text-1);">Trace</strong>
      <button type="button" id="swarmTraceClose" class="btn-ghost" style="font-size:11px;padding:4px 8px;">Close</button>
    </div>
    <div style="display:grid;grid-template-columns:140px 1fr;gap:6px 10px;">
      ${rows
        .map(
          ([label, value]) =>
            `<div style="color:var(--text-3);">${escHtml(label)}</div><div style="font-family:monospace;word-break:break-all;">${escHtml(String(value))}</div>`,
        )
        .join("")}
    </div>
  `;
  panel.querySelector("#swarmTraceClose")?.addEventListener("click", hideTracePanel, { once: true });
}

function hideTracePanel() {
  const panel = document.getElementById("swarmTracePanel");
  if (!panel) return;
  panel.style.display = "none";
  panel.innerHTML = "";
}

async function sendSwarmMessage() {
  const input = document.getElementById("swarmChatInput");
  const sendBtn = document.getElementById("swarmChatSend");
  if (!input || !sendBtn) return;

  const message = input.value.trim();
  if (!message) return;

  const projectId = state.swarmChatProjectId || "general";
  sendBtn.disabled = true;
  input.value = "";
  pendingSwarmResponder = getPendingSwarmResponder(message);

  appendSwarmMessage({
    id: `local-user-${Date.now()}`,
    ts: Date.now(),
    source: "dashboard",
    role: "user",
    content: message,
    agent: null,
    metadata: {
      agentName: "You",
      agentEmoji: "👤",
    },
  });
  lastSwarmUserContent = message;
  showSwarmTyping(pendingSwarmResponder);

  try {
    const response = await postJSON("/api/chat/unified", {
      message,
      sessionId: `swarm-${projectId}`,
      projectId,
      channelMode: true,
    });
    if (Array.isArray(response?.replies) && response.replies.length) {
      removeSwarmTyping();
      for (const entry of response.replies) {
        appendSwarmMessage({
          id: `local-assistant-${entry.agent}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          ts: Date.now(),
          source: "agent",
          role: "assistant",
          content: entry.reply || "",
          agent: entry.agent || null,
          metadata: {
            agentName: entry.agentName || entry.agent || "agent",
            agentEmoji: entry.agentEmoji || "🤖",
            directChat: true,
            multiDirect: true,
          },
        });
      }
      lastSwarmAssistantContent = response.replies[response.replies.length - 1]?.reply || null;
      pendingSwarmResponder = null;
      return;
    }
    if (
      response?.reply &&
      response.reply !== lastSwarmAssistantContent &&
      !document.getElementById("swarm-streaming-wrapper")
    ) {
      removeSwarmTyping();
      const replyAgent = response.agent || response.routedTo || "crew-lead";
      const replyAgentName =
        response.agentName ||
        pendingSwarmResponder?.name ||
        (replyAgent === "crew-lead"
          ? (window._crewLeadInfo || {}).name || "crew-lead"
          : replyAgent);
      const replyAgentEmoji =
        response.agentEmoji ||
        pendingSwarmResponder?.emoji ||
        (replyAgent === "crew-lead"
          ? (window._crewLeadInfo || {}).emoji || "🧠"
          : "🤖");
      appendSwarmMessage({
        id: `local-assistant-${Date.now()}`,
        ts: Date.now(),
        source: response.directChat ? "agent" : "dashboard",
        role: "assistant",
        content: response.reply,
        agent: replyAgent,
        metadata: {
          agentName: replyAgentName,
          agentEmoji: replyAgentEmoji,
          ...(response.directChat ? { directChat: true } : {}),
        },
      });
      lastSwarmAssistantContent = response.reply;
      pendingSwarmResponder = null;
    }
  } catch (error) {
    removeSwarmTyping();
    pendingSwarmResponder = null;
    showNotification(`Swarm send failed: ${error.message}`, "error");
    appendSwarmMessage({
      id: `local-error-${Date.now()}`,
      ts: Date.now(),
      source: "system",
      role: "assistant",
      content: `Failed to send: ${error.message}`,
      agent: "crew-lead",
      metadata: {
        agentName: "system",
        agentEmoji: "🛰",
      },
    });
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}
