export function renderStatusBadge(liveness, ageSec) {
  if (liveness === "online")
    return '<span title="● online — heartbeat <90s" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 5px var(--green);margin-right:4px;flex-shrink:0;"></span>';
  if (liveness === "stale")
    return (
      '<span title="● stale — last seen >' +
      (ageSec || "?") +
      's ago" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#f59e0b;margin-right:4px;flex-shrink:0;"></span>'
    );
  if (liveness === "offline")
    return '<span title="● offline — no heartbeat in 5min" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--red-hi);margin-right:4px;flex-shrink:0;"></span>';
  return '<span title="● unknown — never seen" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--text-3);margin-right:4px;flex-shrink:0;"></span>';
}

export function showLoading(el, msg) {
  if (el)
    el.innerHTML =
      '<div class="meta" style="padding:20px;">' +
      (msg || "Loading\u2026") +
      "</div>";
}

export function showEmpty(el, msg) {
  if (el)
    el.innerHTML =
      '<div class="meta" style="padding:20px;">' +
      (msg || "No items found.") +
      "</div>";
}

export function showError(el, msg) {
  if (el)
    el.innerHTML =
      '<div class="meta" style="padding:20px;color:var(--red-hi);">' +
      (msg || "An error occurred.") +
      "</div>";
}

export function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function showNotification(msg, type) {
  const d = document.createElement("div");
  d.className =
    "notification" +
    (type === "error" || type === true
      ? " error"
      : type === "warning"
        ? " warning"
        : "");
  d.setAttribute("role", "alert");
  d.setAttribute("aria-live", "polite");
  d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 4500);
}

export function fmt(ts) {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return String(ts);
  }
}

export function createdAt(info) {
  return (info && info.time && info.time.created) || "";
}

export function appendChatBubble(
  role,
  text,
  fallbackModel,
  fallbackReason,
  primaryModel,
  engineUsed,
  sourceInfo,
  bubbleOptions,
) {
  const box = document.getElementById("chatMessages");
  if (!box) return;
  const isUser = role === "user";
  const isHistoryRender = Boolean(sourceInfo);
  const forceAppend =
    bubbleOptions &&
    typeof bubbleOptions === "object" &&
    bubbleOptions.force === true;
  if (!isUser && !forceAppend) {
    const last = box.lastElementChild;
    if (last && last.children.length >= 2) {
      const lastBubbleText = last.children[1].textContent;
      if (lastBubbleText.trim() === String(text).trim()) return;
    }
  }
  const div = document.createElement("div");
  div.style.cssText =
    "display:flex;flex-direction:column;align-items:" +
    (isUser ? "flex-end" : "flex-start") +
    ";gap:4px;";
  const labelEl = document.createElement("div");
  labelEl.style.cssText =
    "font-size:11px;color:var(--text-3);padding:0 6px;display:flex;align-items:center;gap:6px;";
  const cl = window._crewLeadInfo || { emoji: "🧠", name: "crew-lead" };

  // If sourceInfo provided (from history), show source indicator instead of default
  if (sourceInfo) {
    let agentName = "crew-lead";
    if (isUser) {
      agentName = "You";
    } else if (sourceInfo.agentName) {
      agentName = sourceInfo.agentName;
    } else if (sourceInfo.agent) {
      agentName = sourceInfo.agent;
    } else if (sourceInfo.source === "cli") {
      agentName = sourceInfo.engine || "cli";
    } else if (sourceInfo.source === "sub-agent") {
      agentName = "sub-agent";
    } else if (sourceInfo.source === "agent") {
      agentName = sourceInfo.targetAgent || "agent";
    } else if (sourceInfo.source === "dashboard") {
      agentName = "crew-lead";
    }
    const engineLabel =
      !isUser && sourceInfo.engine && sourceInfo.engine !== agentName
        ? ` · ${sourceInfo.engine}`
        : "";
    labelEl.textContent = `${sourceInfo.emoji || "🤖"} ${agentName}${engineLabel}`;

    // Add timestamp as a separate subdued span
    const ts = document.createElement("span");
    ts.style.cssText = "opacity:0.6;";
    ts.textContent = sourceInfo.timestamp ? " · " + sourceInfo.timestamp : "";
    labelEl.appendChild(ts);
  } else {
    const displayName = isUser
      ? "You"
      : role === "assistant"
        ? cl.emoji + " " + cl.name
        : role;
    labelEl.textContent = displayName;
  }

  // Show model badge - always for non-user messages
  if (!isUser) {
    const modelToShow = fallbackModel || primaryModel;
    if (modelToShow) {
      const badge = document.createElement("span");
      if (fallbackModel) {
        badge.title =
          "Primary failed (" +
          (fallbackReason || "error") +
          ") — running on fallback";
        badge.style.cssText =
          "font-size:10px;padding:1px 6px;border-radius:999px;background:rgba(245,158,11,0.15);color:#f59e0b;border:1px solid rgba(245,158,11,0.3);cursor:default;";
        badge.textContent = "⚡ fallback: " + fallbackModel;
      } else {
        badge.title = "Primary model";
        badge.style.cssText =
          "font-size:10px;padding:1px 6px;border-radius:999px;background:rgba(52,211,153,0.1);color:#34d399;border:1px solid rgba(52,211,153,0.2);cursor:default;";
        badge.textContent = modelToShow;
      }
      labelEl.appendChild(badge);
    }

    // Show engine badge if available (for coding agents using CLIs)
    if (engineUsed) {
      const engineColors = {
        claude: "#e07a5f",
        codex: "#8338ec",
        cursor: "#3d405b",
        opencode: "#06d6a0",
        gemini: "#4285f4",
        "docker-sandbox": "#0db7ed",
      };
      const engineLabels = {
        claude: "🤖 Claude Code",
        codex: "🟣 Codex",
        cursor: "🖱 Cursor",
        opencode: "⚡ OpenCode",
        gemini: "✨ Gemini",
        "docker-sandbox": "🐳 Docker",
      };
      const engineBadge = document.createElement("span");
      engineBadge.title =
        "Executed by " + (engineLabels[engineUsed] || engineUsed);
      engineBadge.style.cssText =
        "font-size:10px;padding:1px 6px;border-radius:999px;color:#fff;background:" +
        (engineColors[engineUsed] || "var(--text-3)") +
        ";cursor:default;";
      engineBadge.textContent = engineLabels[engineUsed] || engineUsed;
      labelEl.appendChild(engineBadge);
    }
  }

  const bubble = document.createElement("div");
  const assistantBg = "var(--surface-2)";
  const assistantText = "var(--text-2)";
  const assistantBorder = "var(--border)";
  bubble.style.cssText =
    "max-width:80%;padding:10px 14px;border-radius:" +
    (isUser ? "14px 14px 4px 14px" : "14px 14px 14px 4px") +
    ";background:" +
    (isUser ? "var(--purple)" : assistantBg) +
    ";color:" +
    (isUser ? "#fff" : assistantText) +
    ";font-size:14px;line-height:1.5;white-space:pre-wrap;word-break:break-word;border:1px solid " +
    (isUser ? "var(--border)" : assistantBorder) +
    ";";
  bubble.textContent = text;
  div.appendChild(labelEl);
  div.appendChild(bubble);
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}
