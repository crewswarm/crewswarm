import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { filterOpenCodePassthroughTextChunk } from "../../../lib/browser/opencode-passthrough-filter.js";
import { filterGeminiPassthroughTextChunk } from "../../../lib/gemini-cli-passthrough-noise.mjs";
import {
  createPassthroughStderrLineFilter,
  summarizePassthroughTopErrorLine,
} from "../../../lib/browser/passthrough-stderr.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONFIG
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const RT_WS = "ws://127.0.0.1:18889"; // RT message bus
const STUDIO_WATCH_WS = "ws://127.0.0.1:3334/ws"; // Vibe watch server (CLI file changes)
const STUDIO_API = window.location.origin;
/** Same origin — Vibe server proxies to dashboard :4319 (avoids CORS: localhost:3333 vs 127.0.0.1:4319). */
const DASHBOARD_API = STUDIO_API;
const CHAT_MODE_STORAGE_KEY = "vibe-chat-mode";

window.Terminal = Terminal;

let AUTH_TOKEN = ""; // Loaded from dashboard
const SESSION_ID = "studio-" + Date.now(); // Unique session per Vibe instance

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STATE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let editor = null;
let openTabs = [];
let activeTab = null;
let currentProject = null;
let allProjects = [];
let allAgents = [];
let chatMode = "crew-lead"; // 'crew-lead', 'direct', or 'cli'
let selectedAgent = null;
let ws = null;
let watchWs = null; // WebSocket for CLI file changes
let cliTaskActive = false; // True while a CLI engine is working (for diff preview)
let crewLeadEvents = null;
let crewLeadEventsReconnectTimer = null;
let lastAppendedAssistantContent = "";
let lastAppendedUserContent = "";
let inlineChatAnchor = null;
let languageBootstrapFailed = false;
let hasProjectContextLoaded = false;
let watchReconnectTimer = null;
let watchReconnectEnabled = true;
let monaco = null;
let monacoLoadPromise = null;
let fileTreeLoadToken = 0;
let fileTreeRefreshTimer = null;
let projectReplyPollTimer = null;

const MAX_TERMINAL_ENTRIES = 250;
const FILE_TREE_REFRESH_DEBOUNCE_MS = 150;
const DEFAULT_LOCAL_WORKSPACE_DIR = "apps/vibe";
const CHAT_STREAM_TIMEOUT_MS = 600000;

function getPreferredMonacoTheme() {
  return document.documentElement.classList.contains("dark") ? "vs-dark" : "vs";
}

function normalizeProjectsPayload(data) {
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.projects) ? data.projects : [];
}

function normalizeProjectId(value) {
  return !value || value === "general" ? "general" : String(value);
}

async function loadSharedActiveProjectId() {
  try {
    const data = await fetchJSON(`${STUDIO_API}/api/studio/active-project`);
    const projectId = String(data?.projectId || "").trim();
    return projectId || "general";
  } catch {
    return "general";
  }
}

async function persistSharedActiveProjectId(projectId) {
  const normalizedProjectId =
    projectId && String(projectId).trim() && projectId !== "undefined"
      ? String(projectId).trim()
      : "general";
  try {
    await fetchJSON(`${STUDIO_API}/api/studio/active-project`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: normalizedProjectId }),
    });
  } catch {
    // Best effort only.
  }
}

async function syncProjectFromSharedState() {
  const sharedProjectId = await loadSharedActiveProjectId();
  const normalizedSharedId =
    sharedProjectId && sharedProjectId !== "undefined"
      ? sharedProjectId
      : "general";
  const currentProjectId =
    currentProject?.id && currentProject.id !== "undefined"
      ? currentProject.id
      : "general";
  if (normalizedSharedId === currentProjectId) return;
  const selector = document.getElementById("projectSelector");
  if (
    selector &&
    Array.from(selector.options).some((option) => option.value === normalizedSharedId)
  ) {
    selector.value = normalizedSharedId;
    await switchProject(normalizedSharedId);
  }
}

async function fetchJSON(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

function getStudioWorkspaceProject() {
  return allProjects.find((project) => project.id === "studio-local") || null;
}

function getBrowseDirectory() {
  if (currentProject?.outputDir) {
    return currentProject.outputDir;
  }

  return getStudioWorkspaceProject()?.outputDir || DEFAULT_LOCAL_WORKSPACE_DIR;
}

window.__studioGetCurrentProjectDir = function () {
  return currentProject?.outputDir || getBrowseDirectory();
};

function getRelativeWorkspacePath(filePath, rootDir) {
  return filePath.replace(rootDir, "").replace(/^\//, "");
}

function shouldHideFromExplorer(relativePath) {
  if (!relativePath) return true;

  return [
    relativePath.startsWith("."),
    relativePath.startsWith("dist/"),
    relativePath.startsWith("node_modules/"),
    relativePath.startsWith("output/"),
    relativePath.startsWith(".crew/"),
    relativePath.startsWith(".crewswarm/"),
    relativePath.includes("/dist/"),
  ].some(Boolean);
}

function scoreExplorerPath(relativePath) {
  if (
    relativePath.startsWith("src/") ||
    relativePath.startsWith("tests/") ||
    relativePath.startsWith("public/")
  ) {
    return 0;
  }

  if (
    relativePath === "index.html" ||
    relativePath === "package.json" ||
    relativePath === "README.md" ||
    relativePath === "server.mjs" ||
    relativePath === "vite.config.js"
  ) {
    return 1;
  }

  return 2;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MONACO EDITOR
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function renderEditorPlaceholder() {
  const container = document.getElementById("editor-container");
  if (!container || editor) return;

  container.innerHTML = `
    <div style="height:100%;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;color:var(--text-2);">
      <div>
        <div style="font-size:14px;font-weight:600;color:var(--text-1);margin-bottom:8px;">Editor loads on demand</div>
        <div style="font-size:12px;line-height:1.6;max-width:320px;">Open a file to load Monaco only when you need the full editor.</div>
      </div>
    </div>
  `;
}

let editorStatusTimer = null;

function showEditorStatus(message, tone = "info", sticky = false) {
  const statusEl = document.getElementById("editor-status");
  if (!statusEl) return;

  statusEl.classList.add("visible");
  statusEl.dataset.tone = tone;
  statusEl.innerHTML = `<strong>${tone}</strong><span>${message}</span>`;

  if (editorStatusTimer) {
    clearTimeout(editorStatusTimer);
    editorStatusTimer = null;
  }

  if (!sticky && tone !== "error") {
    editorStatusTimer = window.setTimeout(() => {
      hideEditorStatus();
    }, 2500);
  }
}

function hideEditorStatus() {
  const statusEl = document.getElementById("editor-status");
  if (!statusEl) return;

  statusEl.classList.remove("visible");
  statusEl.dataset.tone = "info";
  statusEl.textContent = "";

  if (editorStatusTimer) {
    clearTimeout(editorStatusTimer);
    editorStatusTimer = null;
  }
}

function updateEditorToolbarState() {
  const buttons = document.querySelectorAll(".editor-toolbar-btn");
  const hasEditor = Boolean(editor);
  const hasActiveTab = Boolean(activeTab);
  const activeLanguage = activeTab?.language || editor?.getModel()?.getLanguageId() || "plaintext";
  const canComment = isCommentActionAvailable(activeLanguage);
  const canFormat = isFormatActionAvailable(activeLanguage);
  const canFind = hasEditor;
  const canReplace = hasEditor;

  buttons.forEach((button) => {
    const action = button.id.replace("editor-", "");
    const requiresTab = action === "save";
    const missingEditor = requiresTab ? !hasEditor || !hasActiveTab : !hasEditor;

    if (missingEditor) {
      button.disabled = true;
      button.title = "Open a file to use this action.";
      return;
    }

    if (action === "comment" && !canComment) {
      button.disabled = true;
      button.title = `Comment toggle is not available for ${activeLanguage}.`;
      return;
    }

    if (action === "find" && !canFind) {
      button.disabled = true;
      button.title = "Find is not available until Monaco finishes loading.";
      return;
    }

    if (action === "replace" && !canReplace) {
      button.disabled = true;
      button.title = "Replace is not available until Monaco finishes loading.";
      return;
    }

    if (action === "format" && !canFormat) {
      button.disabled = true;
      button.title = `Formatting is not available for ${activeLanguage}.`;
      return;
    }

    button.disabled = false;
    button.title = "";
  });
}

function getCommentToken(languageId) {
  const commentTokens = {
    javascript: "//",
    typescript: "//",
    json: null,
    markdown: null,
    html: "<!--",
    css: "/*",
    python: "#",
    shell: "#",
    sh: "#",
    yaml: "#",
    yml: "#",
  };

  return commentTokens[languageId] ?? "//";
}

function isCommentActionAvailable(languageId) {
  return getCommentToken(languageId) !== null;
}

function isFormatActionAvailable(languageId) {
  const formattableLanguages = new Set([
    "javascript",
    "typescript",
    "html",
    "css",
    "json",
    "markdown",
  ]);

  return formattableLanguages.has(languageId);
}

function isEditorActionSupported(actionId) {
  if (!editor) return false;

  const action = editor.getAction(actionId);
  if (!action) {
    return false;
  }

  if (typeof action.isSupported === "function") {
    try {
      return Boolean(action.isSupported());
    } catch {
      return false;
    }
  }

  return true;
}

function fallbackToggleComment(languageId) {
  if (!editor) return false;

  const token = getCommentToken(languageId);
  if (!token) {
    return false;
  }

  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection) {
    return false;
  }

  const startLine = selection.startLineNumber;
  const endLine = selection.endLineNumber;
  const lines = [];

  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
    lines.push(model.getLineContent(lineNumber));
  }

  const shouldUncomment = lines.every((line) => {
    const trimmed = line.trimStart();
    if (!trimmed) return true;
    if (token === "<!--") return trimmed.startsWith("<!--") && trimmed.endsWith("-->");
    if (token === "/*") return trimmed.startsWith("/*") && trimmed.endsWith("*/");
    return trimmed.startsWith(token);
  });

  editor.executeEdits(
    "toolbar-comment-fallback",
    lines.map((line, index) => {
      const lineNumber = startLine + index;
      const lineLength = model.getLineLength(lineNumber);
      const trimmed = line.trimStart();
      const indentLength = line.length - trimmed.length;

      let nextLine = line;
      if (shouldUncomment) {
        if (token === "<!--" && trimmed.startsWith("<!--") && trimmed.endsWith("-->")) {
          nextLine = `${line.slice(0, indentLength)}${trimmed.slice(4, -3).trim()}`;
        } else if (token === "/*" && trimmed.startsWith("/*") && trimmed.endsWith("*/")) {
          nextLine = `${line.slice(0, indentLength)}${trimmed.slice(2, -2).trim()}`;
        } else if (trimmed.startsWith(token)) {
          nextLine = `${line.slice(0, indentLength)}${trimmed.slice(token.length).replace(/^ /, "")}`;
        }
      } else if (trimmed) {
        if (token === "<!--") {
          nextLine = `${line.slice(0, indentLength)}<!-- ${trimmed} -->`;
        } else if (token === "/*") {
          nextLine = `${line.slice(0, indentLength)}/* ${trimmed} */`;
        } else {
          nextLine = `${line.slice(0, indentLength)}${token} ${trimmed}`;
        }
      }

      return {
        range: new monaco.Range(lineNumber, 1, lineNumber, lineLength + 1),
        text: nextLine,
      };
    }),
  );

  editor.focus();
  return true;
}

async function runEditorAction(action) {
  if (!editor) {
    showEditorStatus("Open a file to use editor actions.", "warning");
    return;
  }

  if (action === "save") {
    if (!activeTab) {
      showEditorStatus("Open a file before saving.", "warning");
      return;
    }
    await saveFile(activeTab);
    showEditorStatus(`Saved ${activeTab.name}`, "success");
    return;
  }

  if (action === "undo" || action === "redo") {
    editor.trigger("toolbar", action, null);
    editor.focus();
    return;
  }

  if (action === "find" || action === "replace") {
    editor.focus();
    const commandId =
      action === "find" ? "actions.find" : "editor.action.startFindReplaceAction";
    try {
      const editorAction = editor.getAction(commandId);
      if (editorAction && typeof editorAction.run === "function") {
        await editorAction.run();
      } else {
        editor.trigger("toolbar", commandId, null);
      }
      return;
    } catch (error) {
      showEditorStatus(`Editor action failed: ${error.message}`, "error", true);
      return;
    }
  }

  const actionMap = {
    comment: "editor.action.commentLine",
    format: "editor.action.formatDocument",
  };

  const actionId = actionMap[action];
  if (!actionId) return;
  const editorAction = editor.getAction(actionId);
  const activeLanguage = activeTab?.language || editor.getModel()?.getLanguageId() || "plaintext";

  if (action === "comment" && !isCommentActionAvailable(activeLanguage)) {
    showEditorStatus(`Comment toggle is not available for ${activeLanguage}.`, "warning");
    return;
  }

  if (action === "format" && !isFormatActionAvailable(activeLanguage)) {
    showEditorStatus(`Formatting is not available for ${activeLanguage}.`, "warning");
    return;
  }

  try {
    if (isEditorActionSupported(actionId)) {
      await editorAction.run();
      editor.focus();
      return;
    }

    if (action === "comment" && fallbackToggleComment(activeLanguage)) {
      showEditorStatus(`Toggled comments in ${activeTab?.name || "current file"}`, "success");
      return;
    }

    showEditorStatus(`${action} is not available for ${activeLanguage}.`, "warning");
    editor.focus();
  } catch (error) {
    showEditorStatus(`Editor action failed: ${error.message}`, "error", true);
  }
}

function bindEditorToolbar() {
  const actionIds = ["undo", "redo", "save", "find", "replace", "comment", "format"];

  actionIds.forEach((action) => {
    const button = document.getElementById(`editor-${action}`);
    button?.addEventListener("click", () => {
      runEditorAction(action);
    });
  });

  updateEditorToolbarState();
}

async function loadMonaco() {
  if (monaco) {
    return monaco;
  }

  if (!monacoLoadPromise) {
    monacoLoadPromise = (async () => {
      const [
        monacoModule,
        { default: editorWorker },
        { default: jsonWorker },
        { default: cssWorker },
        { default: htmlWorker },
        { default: tsWorker },
        _findController,
      ] = await Promise.all([
        import("monaco-editor/esm/vs/editor/editor.api"),
        import("monaco-editor/esm/vs/editor/editor.worker?worker"),
        import("monaco-editor/esm/vs/language/json/json.worker?worker"),
        import("monaco-editor/esm/vs/language/css/css.worker?worker"),
        import("monaco-editor/esm/vs/language/html/html.worker?worker"),
        import("monaco-editor/esm/vs/language/typescript/ts.worker?worker"),
        import("monaco-editor/esm/vs/editor/contrib/find/browser/findController.js"),
      ]);

      self.MonacoEnvironment = {
        getWorker(_, label) {
          if (label === "json") {
            return new jsonWorker();
          }
          if (label === "css" || label === "scss" || label === "less") {
            return new cssWorker();
          }
          if (label === "html" || label === "handlebars" || label === "razor") {
            return new htmlWorker();
          }
          if (label === "typescript" || label === "javascript") {
            return new tsWorker();
          }
          return new editorWorker();
        },
      };

      monaco = monacoModule;
      window.monaco = monacoModule;
      await import("./register-all-languages.js");
      if (window.__studioLanguageRegistrationReady) {
        window.__studioLanguageRegistrationReady.catch((err) => {
          languageBootstrapFailed = true;
          console.warn("Vibe language bootstrap degraded:", err);
          addTerminalLine(
            "⚠️ Monaco language extras failed to load; continuing with fallback editor mode",
            "warning",
          );
        });
      }
      return monacoModule;
    })().catch((error) => {
      monacoLoadPromise = null;
      throw error;
    });
  }

  return monacoLoadPromise;
}

async function ensureEditorReady() {
  if (editor) {
    return editor;
  }

  await loadMonaco();
  initEditor();
  updateEditorToolbarState();
  return editor;
}

function initEditor() {
  const container = document.getElementById("editor-container");
  if (!container) {
    throw new Error("Editor container not found");
  }

  // Remove the lazy-load placeholder before Monaco mounts into the container.
  container.innerHTML = "";

  editor = monaco.editor.create(container, {
    value:
      "// crewswarm Vibe is ready.\n// Open a project, edit a file, or run cli:codex from chat.\n",
    language: "plaintext",
    theme: getPreferredMonacoTheme(),
    fontSize: 13,
    minimap: { enabled: true },
    automaticLayout: true,
    scrollBeyondLastLine: false,
    lineNumbers: "on",
    renderWhitespace: "selection",
    tabSize: 2,
  });

  // Auto-save on change (debounced)
  let saveTimeout;
  editor.onDidChangeModelContent(() => {
    if (!activeTab) return;
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => saveFile(activeTab), 1000);
  });

  // Cmd+K for inline chat
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => {
    showInlineChat();
  });

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    runEditorAction("save");
  });

  editor.onDidChangeCursorPosition(() => {
    const overlay = document.getElementById("inline-chat-overlay");
    if (overlay?.classList.contains("visible")) {
      positionInlineChat();
    }
  });

  editor.onDidScrollChange(() => {
    const overlay = document.getElementById("inline-chat-overlay");
    if (overlay?.classList.contains("visible")) {
      positionInlineChat();
    }
  });

  updateEditorToolbarState();
}

async function ensureEditorLanguage(languageId) {
  await loadMonaco();

  if (!languageId || typeof window.__studioEnsureLanguageRegistered !== "function") {
    return;
  }

  try {
    await window.__studioEnsureLanguageRegistered(languageId);
  } catch (error) {
    console.warn(`Failed to load Monaco language contribution for ${languageId}:`, error);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PROJECT MANAGEMENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function loadProjects() {
  try {
    const data = await fetchJSON(`${STUDIO_API}/api/studio/projects`);
    allProjects = normalizeProjectsPayload(data);

    console.log(
      "[loadProjects] Loaded projects:",
      allProjects.map((p) => ({ id: p.id, name: p.name })),
    );

    const selector = document.getElementById("projectSelector");
    if (!selector) {
      console.warn("Project selector element not found");
      return;
    }
    selector.innerHTML = '<option value="general">General Chat</option>';

    allProjects.forEach((proj) => {
      console.log("[loadProjects] Adding option:", proj.id, proj.name);
      const option = document.createElement("option");
      option.value = proj.id;
      option.textContent = proj.name;
      selector.appendChild(option);
    });

    // Check URL hash for project (restore from URL like dashboard)
    const hash = window.location.hash;
    const match = hash.match(/project=([^&]+)/);
    const urlProjectId = match ? decodeURIComponent(match[1]) : null;
    const sharedProjectId = await loadSharedActiveProjectId();

    if (
      urlProjectId &&
      (urlProjectId === "general" ||
        allProjects.find((p) => p.id === urlProjectId))
    ) {
      // Restore project from URL
      selector.value = urlProjectId;
      await switchProject(urlProjectId);
    } else if (
      sharedProjectId &&
      (sharedProjectId === "general" ||
        allProjects.find((p) => p.id === sharedProjectId))
    ) {
      selector.value = sharedProjectId;
      await switchProject(sharedProjectId);
    } else {
      const defaultProjectId =
        allProjects.find((project) => project.id === DEFAULT_PROJECT_ID)?.id ||
        allProjects[0]?.id ||
        "general";
      selector.value = defaultProjectId;
      await switchProject(defaultProjectId);
    }

    addTerminalLine(`✅ Loaded ${allProjects.length} project(s)`, "info");
  } catch (err) {
    const selector = document.getElementById("projectSelector");
    if (selector) {
      selector.innerHTML = '<option value="studio-local">Vibe Workspace</option>';
      selector.value = "studio-local";
    }
    allProjects = [
      {
        id: "studio-local",
        name: "Vibe Workspace",
        outputDir: DEFAULT_LOCAL_WORKSPACE_DIR,
      },
    ];
    await switchProject("studio-local");
    addTerminalLine(
      `⚠️ Vibe project store unavailable - using local workspace fallback`,
      "warning",
    );
  }
}

async function loadAgents() {
  try {
    // Same-origin /api/agents is proxied to dashboard :4319. After restart-all, dashboard (launchd)
    // can lag Vibe; retry 502/503 so the agent list isn't empty on first paint.
    const maxAttempts = 12;
    const delayMs = 800;
    let response;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        response = await fetch(`${DASHBOARD_API}/api/agents`);
      } catch (netErr) {
        if (attempt < maxAttempts) {
          console.warn(
            `[loadAgents] fetch failed (${netErr?.message || netErr}), retry ${attempt}/${maxAttempts}`,
          );
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        throw netErr;
      }
      if (
        (response.status === 502 || response.status === 503) &&
        attempt < maxAttempts
      ) {
        console.warn(
          `[loadAgents] dashboard proxy not ready (${response.status}), retry ${attempt}/${maxAttempts}`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      break;
    }
    if (!response.ok) {
      throw new Error(`Dashboard API error: ${response.status}`);
    }
    const data = await response.json();

    // Dashboard returns plain array
    allAgents = Array.isArray(data) ? data : [];

    // Populate agents optgroup
    const optgroup = document.getElementById("agentsOptgroup");
    const selector = document.getElementById("chat-mode-selector");
    if (!optgroup) {
      console.warn("Agents optgroup element not found");
      return;
    }
    const preferredMode =
      localStorage.getItem(CHAT_MODE_STORAGE_KEY) || selector?.value || chatMode;

    optgroup.innerHTML = "";
    allAgents.forEach((agent) => {
      const option = document.createElement("option");
      option.value = agent.id;
      option.textContent = `${agent.id}`;
      optgroup.appendChild(option);
    });

    if (selector) {
      const hasPreferredMode = Array.from(selector.options).some(
        (option) => option.value === preferredMode,
      );
      selector.value = hasPreferredMode ? preferredMode : "crew-lead";
      chatMode = selector.value;
    }

    addTerminalLine(`🤖 Loaded ${allAgents.length} agents`, "success");
  } catch (err) {
    addTerminalLine(
      `⚠️ Dashboard not responding - agents unavailable`,
      "warning",
    );
    console.error("loadAgents error:", err);
  }
}

window.switchChatMode = function () {
  const mode = document.getElementById("chat-mode-selector").value;
  chatMode = mode;
  localStorage.setItem(CHAT_MODE_STORAGE_KEY, mode);

  const chatInput = document.getElementById("chat-input");

  if (mode.startsWith("cli:")) {
    const cliName = mode.replace("cli:", "");
    chatInput.placeholder = `Direct ${cliName.toUpperCase()} passthrough (Enter to send)`;
    addTerminalLine(
      `⚡ Mode: ${cliName} CLI passthrough - NO LLM, direct execution`,
      "info",
    );
  } else if (mode !== "crew-lead") {
    // Direct agent mode
    selectedAgent = mode;
    chatInput.placeholder = `Talk directly to ${mode} (Enter to send)`;
    addTerminalLine(`💬 Mode: Direct chat with ${mode}`, "info");
  } else {
    selectedAgent = null;
    chatInput.placeholder =
      "Ask the crew anything... (Enter to send, Shift+Enter for new line)";
    addTerminalLine(`🧠 Mode: crew-lead (smart routing)`, "info");
  }
};

window.clearCliSession = async function () {
  try {
    const pd = currentProject?.outputDir || "";
    const scope = SESSION_ID || "default";
    // Clear all engines for this project+session via crew-lead API
    const res = await fetch(`${STUDIO_API}/api/studio/clear-cli-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectDir: pd, sessionId: scope }),
    });
    const data = await res.json();
    if (data.ok) {
      addTerminalLine(`↻ Session cleared — next message starts fresh${data.cleared?.length ? ` (${data.cleared.join(", ")})` : ""}`, "info");
    } else {
      addTerminalLine(`⚠ Failed to clear session: ${data.error || "unknown"}`, "error");
    }
  } catch (e) {
    addTerminalLine(`⚠ Failed to clear session: ${e.message}`, "error");
  }
};

document.getElementById("agent-selector")?.addEventListener("change", (e) => {
  selectedAgent = e.target.value;
  if (selectedAgent) {
    addTerminalLine(`🎯 Selected agent: ${selectedAgent}`, "info");
  }
});

async function switchProject(projectId) {
  console.log(
    "[switchProject] Called with projectId:",
    projectId,
    "type:",
    typeof projectId,
  );

  // Track current state
  const currentId = currentProject?.id || "general";

  // Don't reload if already on this project
  if (hasProjectContextLoaded && currentId === projectId) {
    console.log("Already on project:", projectId);
    return;
  }

  // Validate projectId
  if (!projectId || projectId === "undefined") {
    console.error("[switchProject] Invalid projectId:", projectId);
    projectId = "general";
  }

  // Update URL hash BEFORE setting currentProject (use projectId param, not currentProject)
  window.location.hash = `studio?project=${encodeURIComponent(projectId)}`;
  await persistSharedActiveProjectId(projectId);

  // Set currentProject based on projectId
  if (projectId === "general") {
    currentProject = null;
  } else {
    currentProject = allProjects.find((p) => p.id === projectId);
    if (!currentProject) {
      console.warn(
        "[switchProject] Project not found, falling back to general:",
        projectId,
      );
      projectId = "general";
      currentProject = null;
    }
  }

  // Update project context hint in chat header
  const hint = document.getElementById("project-context-hint");
  const nameEl = document.getElementById("project-context-name");
  const pathEl = document.getElementById("project-context-path");

  if (currentProject && hint && nameEl && pathEl) {
    hint.style.display = "block";
    nameEl.textContent = currentProject.name;
    pathEl.textContent = currentProject.outputDir || "";
    addTerminalLine(`📁 Switched to project: ${currentProject.name}`, "info");
    addTerminalLine(`📂 Directory: ${currentProject.outputDir}`, "info");
  } else if (projectId === "general" && hint && nameEl && pathEl) {
    hint.style.display = "block";
    nameEl.textContent = "General Chat";
    pathEl.textContent = "No specific project";
    addTerminalLine(`🌐 Switched to general chat (no project context)`, "info");
  } else if (hint) {
    hint.style.display = "none";
  }

  window.dispatchEvent(
    new CustomEvent("studio-projectchange", {
      detail: {
        projectId: currentProject?.id || "general",
        projectName: currentProject?.name || "General Chat",
        projectDir: currentProject?.outputDir || getBrowseDirectory(),
      },
    }),
  );

  // Clear chat history when switching projects (project-scoped sessions)
  const chatMessages = document.getElementById("chat-messages");
  if (chatMessages) {
    chatMessages.innerHTML = "";
  }
  lastAppendedAssistantContent = "";
  lastAppendedUserContent = "";

  // Load chat history and file tree
  await loadChatHistory();
  await loadFileTree();
  hasProjectContextLoaded = true;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CHAT HISTORY (Project-Scoped)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function loadChatHistory() {
  const projectId = currentProject?.id || "general";

  try {
    const data = await fetchJSON(
      `${STUDIO_API}/api/studio/project-messages?projectId=${encodeURIComponent(projectId)}&limit=50`,
    );

    const chatMessages = document.getElementById("chat-messages");
    if (!chatMessages) {
      console.warn("Chat messages container not found");
      return;
    }
    chatMessages.innerHTML = "";

    if (Array.isArray(data.messages) && data.messages.length > 0) {
      data.messages.forEach((msg) => {
        if (!msg || typeof msg !== "object") {
          return;
        }
        const sourceEmoji = {
          dashboard: "💻",
          cli: "⚡",
          "studio-cli": "🟣",
          "sub-agent": "👷",
          agent: "🤖",
        };
        const agentId = msg.agent || msg.metadata?.agentId || null;
        const agentInfo = agentId
          ? allAgents.find((a) => a.id === agentId)
          : null;
        const emoji =
          msg.metadata?.agentEmoji ||
          agentInfo?.emoji ||
          sourceEmoji[msg.source] ||
          "📝";
        const agentName =
          msg.metadata?.agentName || agentInfo?.name || agentId || null;
        const timestamp = new Date(msg.ts).toLocaleTimeString();

        appendChatBubble(
          msg.role === "user" ? "user" : "assistant",
          msg.content,
          {
            emoji,
            source: msg.source,
            agent: agentName,
            agentName,
            agentId,
            targetAgent:
              msg.metadata?.targetAgent || msg.metadata?.agentId || null,
            engine: msg.metadata?.engine || null,
            timestamp,
          },
        );
      });
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  } catch (err) {
    console.warn("Failed to load chat history:", err);
  }
}

function appendChatSystemNote(text) {
  if (!chatMessages) return;
  const note = document.createElement("div");
  note.className = "message assistant";
  note.innerHTML = `
    <div class="message-header">⚡ crew-lead</div>
    <div class="message-content">${escapeHtml(text)}</div>
  `;
  chatMessages.appendChild(note);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function scheduleProjectReplyRefresh(durationMs = 30000, intervalMs = 3000) {
  if (projectReplyPollTimer) {
    clearInterval(projectReplyPollTimer);
    projectReplyPollTimer = null;
  }
  const startedAt = Date.now();
  projectReplyPollTimer = setInterval(async () => {
    if (Date.now() - startedAt > durationMs) {
      clearInterval(projectReplyPollTimer);
      projectReplyPollTimer = null;
      return;
    }
    try {
      await loadChatHistory();
    } catch {
      // best effort
    }
  }, intervalMs);
}

function connectCrewLeadEvents() {
  if (crewLeadEvents) return;
  const eventsUrl = `${STUDIO_API}/api/crew-lead/events`;
  crewLeadEvents = new EventSource(eventsUrl);

  crewLeadEvents.onmessage = async (event) => {
    if (!event.data) return;
    let payload = null;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    const currentProjectId = normalizeProjectId(currentProject?.id || "general");
    const eventProjectId = normalizeProjectId(payload.projectId);
    if (currentProjectId !== eventProjectId) return;

    if (payload.type === "agent_working" && payload.agent) {
      appendChatSystemNote(`${payload.agent} is working...`);
      return;
    }

    if (payload.type === "agent_reply" || (payload.from && payload.content)) {
      addTerminalLine(`🤖 ${payload.from || "agent"} replied`, "info");
      await loadChatHistory();
    }
  };

  crewLeadEvents.onerror = () => {
    try {
      crewLeadEvents?.close();
    } catch {}
    crewLeadEvents = null;
    if (crewLeadEventsReconnectTimer) return;
    crewLeadEventsReconnectTimer = window.setTimeout(() => {
      crewLeadEventsReconnectTimer = null;
      connectCrewLeadEvents();
    }, 2000);
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FILE TREE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function loadFileTree() {
  const loadToken = ++fileTreeLoadToken;
  const container = document.getElementById("file-tree");
  if (!container) {
    console.warn("File tree container not found");
    return;
  }
  container.innerHTML = '<li class="loading">Loading files...</li>';

  // Determine directory to load
  const outputDir = getBrowseDirectory();

  try {
    const data = await fetchJSON(
      `${STUDIO_API}/api/studio/files?dir=${encodeURIComponent(outputDir)}`,
    );
    if (loadToken !== fileTreeLoadToken) {
      return;
    }
    const files = (data.files || []).filter((file) => {
      const relativePath = getRelativeWorkspacePath(file.path, outputDir);
      return !shouldHideFromExplorer(relativePath);
    });

    if (files.length === 0) {
      container.innerHTML =
        '<li style="padding: 16px; color: var(--text-3); font-size: 12px;">No files found in project directory</li>';
      return;
    }

    // Group by directory and display as tree
    const tree = {};
    files.forEach((f) => {
      const relativePath = getRelativeWorkspacePath(f.path, outputDir);
      tree[relativePath] = f;
    });

    // Sort source files and primary project files ahead of generated or peripheral files.
    const sorted = Object.keys(tree).sort((a, b) => {
      const scoreDelta = scoreExplorerPath(a) - scoreExplorerPath(b);
      if (scoreDelta !== 0) return scoreDelta;
      return a.localeCompare(b);
    });

    container.innerHTML = "";
    sorted.slice(0, 100).forEach((relPath) => {
      const ext = relPath.split(".").pop();
      const icon =
        ext === "md"
          ? "📝"
          : ext === "json"
            ? "📦"
            : ext === "js" || ext === "mjs"
              ? "📄"
              : "📄";
      const item = document.createElement("li");
      item.dataset.path = tree[relPath].path;
      item.innerHTML = `
        <span class="icon">${icon}</span>
        <span title="${relPath}">${relPath.length > 40 ? "..." + relPath.slice(-37) : relPath}</span>
      `;
      item.addEventListener("click", () => {
        openFile(tree[relPath].path);
      });
      container.appendChild(item);
    });

    if (sorted.length > 100) {
      const overflow = document.createElement("li");
      overflow.style.cssText =
        "padding: 8px; color: var(--text-3); font-size: 11px;";
      overflow.textContent = `... and ${sorted.length - 100} more files`;
      container.appendChild(overflow);
    }
  } catch (err) {
    container.innerHTML = `<li style="padding: 16px; color: var(--red);">Failed to load files: ${err.message}</li>`;
    addTerminalLine(`⚠️ Failed to load file tree: ${err.message}`, "error");
  }
}

function scheduleFileTreeRefresh() {
  if (fileTreeRefreshTimer) {
    clearTimeout(fileTreeRefreshTimer);
  }

  fileTreeRefreshTimer = window.setTimeout(() => {
    fileTreeRefreshTimer = null;
    loadFileTree();
  }, FILE_TREE_REFRESH_DEBOUNCE_MS);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FILE OPERATIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function openFile(filePath) {
  const browseDirectory = getBrowseDirectory();
  const relativePath = getRelativeWorkspacePath(filePath, browseDirectory);
  if (shouldHideFromExplorer(relativePath)) {
    addTerminalLine(`Skipping generated file: ${relativePath}`, "warning");
    showEditorStatus(`Skipping generated file: ${relativePath}`, "warning");
    return;
  }

  const existingTab = openTabs.find((t) => t.path === filePath);
  if (existingTab) {
    showEditorStatus(`Switched to ${existingTab.name}`, "success");
    await switchToTab(existingTab);
    return;
  }

  try {
    showEditorStatus(`Opening ${relativePath}...`, "info", true);
    const { content, error } = await readFile(filePath);

    const tab = {
      path: filePath,
      name: filePath.split("/").pop(),
      content,
      language: detectLanguage(filePath),
    };

    openTabs.push(tab);
    await ensureEditorReady();
    await switchToTab(tab);
    renderTabs();

    if (error) {
      showEditorStatus(`Failed to load ${relativePath}: ${error}`, "error", true);
    } else {
      showEditorStatus(`Loaded ${relativePath}`, "success");
    }

    // Notify user that this file is now in chat context
    addTerminalLine(
      `📎 ${tab.name} is now in chat context (agents can see this file)`,
      "info",
    );
  } catch (err) {
    addTerminalLine(`Failed to open ${filePath}: ${err.message}`, "error");
  }
}

async function readFile(filePath) {
  try {
    const payload = await fetchJSON(
      `${STUDIO_API}/api/studio/file-content?path=${encodeURIComponent(filePath)}`,
    );
    if (payload.error) {
      throw new Error(payload.error);
    }
    return {
      content: payload.content || "",
      error: null,
    };
  } catch (err) {
    addTerminalLine(`⚠️ Failed to read ${filePath}: ${err.message}`, "error");
    return {
      content: `// Error loading file: ${err.message}\n`,
      error: err.message,
    };
  }
}

async function saveFile(tab) {
  if (!editor) return;
  const content = editor.getValue();
  try {
    await fetchJSON(`${STUDIO_API}/api/studio/file-content`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: tab.path,
        content,
      }),
    });
    tab.content = content;
    addTerminalLine(`💾 Saved ${tab.path}`, "success");
    updateEditorToolbarState();
  } catch (err) {
    addTerminalLine(`❌ Failed to save ${tab.path}: ${err.message}`, "error");
  }
}

function detectLanguage(filePath) {
  const ext = filePath.split(".").pop();
  const languageMap = {
    js: "javascript",
    ts: "typescript",
    jsx: "javascript",
    tsx: "typescript",
    json: "json",
    md: "markdown",
    html: "html",
    css: "css",
    py: "python",
  };
  return languageMap[ext] || "plaintext";
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TABS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function renderTabs() {
  const container = document.getElementById("editor-tabs");
  container.innerHTML = "";

  openTabs.forEach((tab) => {
    const button = document.createElement("button");
    button.className = `editor-tab ${tab === activeTab ? "active" : ""}`;
    button.type = "button";
    button.append(document.createTextNode(tab.name));
    button.addEventListener("click", () => {
      switchToTab(tab);
    });

    const close = document.createElement("span");
    close.className = "close";
    close.textContent = "×";
    close.addEventListener("click", (event) => {
      closeTab(tab.path, event);
    });
    button.appendChild(close);
    container.appendChild(button);
  });

  updateEditorToolbarState();
}

window.switchToTab = async function (tab) {
  await ensureEditorReady();
  const previousTab = activeTab;
  activeTab = tab;
  await ensureEditorLanguage(tab.language);
  monaco.editor.setModelLanguage(editor.getModel(), tab.language);
  editor.setValue(tab.content);
  renderTabs();
  updateEditorToolbarState();
  hideEditorStatus();

  document.querySelectorAll(".file-tree li").forEach((el) => {
    el.classList.toggle("active", el.dataset.path === tab.path);
  });

  // Notify context change if switching from another file
  if (previousTab && previousTab.path !== tab.path) {
    addTerminalLine(`📎 Chat context: ${tab.name}`, "info");
  }
};

window.closeTab = function (filePath, event) {
  event?.stopPropagation();
  openTabs = openTabs.filter((t) => t.path !== filePath);

  if (activeTab?.path === filePath) {
    activeTab = openTabs[0] || null;
    if (activeTab) {
      switchToTab(activeTab);
    } else {
      editor?.setValue("// No files open");
      showEditorStatus("No file is open. Select one from the Explorer.", "info");
      updateEditorToolbarState();
    }
  }

  renderTabs();
};

window.openFile = openFile;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CHAT (Uses EXACT Same API as Dashboard)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const chatInput = document.getElementById("chat-input");
const chatMessages = document.getElementById("chat-messages");

// ── Image attachments (drag/drop, paste, picker) ──────────────────────────────
let pendingChatImages = []; // Array of { dataUri, name, size }
const chatPanel = document.getElementById("chat-panel");
const chatImageBtn = document.getElementById("chat-image-btn");
const chatImageFile = document.getElementById("chat-image-file");
const chatImagePreview = document.getElementById("chat-image-preview");
const chatDragOverlay = document.getElementById("chat-drag-overlay");

function addPendingImage(file) {
  if (!file || !file.type.startsWith("image/")) return;
  if (pendingChatImages.length >= 3) return; // max 3 images
  const reader = new FileReader();
  reader.onload = () => {
    pendingChatImages.push({ dataUri: reader.result, name: file.name, size: file.size });
    renderImagePreview();
  };
  reader.readAsDataURL(file);
}

function renderImagePreview() {
  if (!pendingChatImages.length) {
    chatImagePreview.style.display = "none";
    chatImagePreview.innerHTML = "";
    return;
  }
  chatImagePreview.style.display = "flex";
  chatImagePreview.innerHTML = pendingChatImages.map((img, i) => `
    <div style="display:inline-flex;align-items:center;gap:6px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:4px 8px;margin-right:6px;">
      <img src="${img.dataUri}" style="height:36px;width:36px;object-fit:cover;border-radius:4px;" />
      <span style="font-size:11px;color:var(--text-2);max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${img.name}</span>
      <button onclick="removePendingImage(${i})" style="background:none;border:none;color:var(--text-3);cursor:pointer;font-size:14px;padding:0 2px;" title="Remove">&times;</button>
    </div>
  `).join("");
}
window.removePendingImage = function(i) {
  pendingChatImages.splice(i, 1);
  renderImagePreview();
};

// Image button click
if (chatImageBtn) {
  chatImageBtn.addEventListener("click", () => chatImageFile?.click());
}
if (chatImageFile) {
  chatImageFile.addEventListener("change", (e) => {
    if (e.target.files?.[0]) addPendingImage(e.target.files[0]);
    e.target.value = "";
  });
}

// Drag & drop on chat panel
if (chatPanel) {
  let dragCounter = 0;
  chatPanel.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragCounter++;
    if (chatDragOverlay) chatDragOverlay.style.display = "flex";
  });
  chatPanel.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; if (chatDragOverlay) chatDragOverlay.style.display = "none"; }
  });
  chatPanel.addEventListener("dragover", (e) => e.preventDefault());
  chatPanel.addEventListener("drop", (e) => {
    e.preventDefault();
    dragCounter = 0;
    if (chatDragOverlay) chatDragOverlay.style.display = "none";
    for (const file of e.dataTransfer?.files || []) {
      if (file.type.startsWith("image/")) addPendingImage(file);
    }
  });
}

// Ctrl/Cmd+V paste image
chatInput?.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items || [];
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      e.preventDefault();
      addPendingImage(item.getAsFile());
      return;
    }
  }
});

chatInput.addEventListener("keydown", (e) => {
  // Cmd+Enter or just Enter to send
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

function getChatModeLabel() {
  if (chatMode.startsWith("cli:")) {
    return chatMode.replace("cli:", "");
  }
  if (chatMode !== "crew-lead") {
    return chatMode;
  }
  return "crew-lead";
}

/** Agent id / label for error bubbles (cli:* must not show as crew-lead). */
function getErrorBubbleAgentId() {
  if (chatMode.startsWith("cli:")) return chatMode.replace("cli:", "");
  if (chatMode !== "crew-lead") return chatMode;
  return "crew-lead";
}

async function sendChatMessage() {
  const message = chatInput.value.trim();
  if (!message && !pendingChatImages.length) return;

  // Show user message (with image indicators if any)
  const imageLabel = pendingChatImages.length ? `\n📷 ${pendingChatImages.map(i => i.name).join(", ")}` : "";
  appendChatBubble("user", (message || "(image)") + imageLabel);
  chatInput.value = "";
  const sentImages = [...pendingChatImages];
  pendingChatImages = [];
  renderImagePreview();
  lastAppendedUserContent = message;

  // Track CLI task for diff preview
  cliTaskActive = true;

  // Typing indicator
  const typingDiv = document.createElement("div");
  typingDiv.id = "typing-indicator";
  typingDiv.className = "message agent";
  const thinkingAgent = getChatModeLabel();
  typingDiv.innerHTML = `<div class="message-content" style="color: var(--text-3);">${thinkingAgent} is thinking...</div>`;
  chatMessages.appendChild(typingDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  // Capture file context
  const fileContext = {};
  if (activeTab) {
    fileContext.activeFile = activeTab.path;
    fileContext.activeFileName = activeTab.name;

    // If there's a selection, include it
    if (editor) {
      const selection = editor.getSelection();
      const selectedText = editor.getModel().getValueInRange(selection);
      if (selectedText && selectedText.trim()) {
        fileContext.selectedText = selectedText;
        fileContext.selectionStart = selection.startLineNumber;
        fileContext.selectionEnd = selection.endLineNumber;
      }
    }
  }

  try {
    // Route based on selected mode
    let apiUrl;
    let body;
    let isSSE = true; // All modes now stream via SSE

    if (chatMode.startsWith("cli:")) {
      // CLI Passthrough mode (cli:crew-cli, cli:cursor, etc.) — SSE STREAM
      const cliName = chatMode.replace("cli:", "");
      // All CLI engines run locally via Vibe server (uses OAuth from each CLI)
      apiUrl = `${STUDIO_API}/api/studio/chat/unified`;
      body = {
        mode: "cli",
        engine: cliName,
        message,
        sessionId: SESSION_ID,
        projectDir: currentProject?.outputDir || "",
        projectId: currentProject?.id || "general", // ✅ Added for unified history
        ...fileContext, // ✅ Include active file context
      };
    } else if (chatMode !== "crew-lead") {
      // Direct agent mode — SSE STREAM via dashboard unified endpoint
      apiUrl = `${DASHBOARD_API}/api/chat/unified`;
      body = {
        mode: "agent",
        agentId: chatMode,
        message,
        sessionId: `studio-${chatMode}-${SESSION_ID}`,
        projectId: currentProject?.id || "general",
        ...fileContext,
      };
    } else {
      // crew-lead mode (default) — SSE STREAM via dashboard unified endpoint
      apiUrl = `${DASHBOARD_API}/api/chat/unified`;
      body = {
        mode: "crew-lead",
        message,
        sessionId: SESSION_ID,
        projectId: currentProject?.id || "general",
        ...(currentProject?.outputDir ? { projectDir: currentProject.outputDir } : {}),
      };
    }

    // Attach images if any
    if (sentImages.length) {
      body.images = sentImages.map(img => img.dataUri);
    }

    const dashboardUnified =
      apiUrl.includes("/api/chat/unified") && !apiUrl.includes("/api/studio/");
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(dashboardUnified ? { Accept: "text/event-stream" } : {}),
        ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CHAT_STREAM_TIMEOUT_MS),
    });

    document.getElementById("typing-indicator")?.remove();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    // Handle SSE streaming for CLI passthrough
    if (isSSE) {
      const chatLabel = getChatModeLabel();
      const bubble = createStreamingChatBubble(chatLabel);
      const activityTrace = createActivityTrace(chatLabel);
      const passthroughEngine = chatMode.startsWith("cli:")
        ? chatMode.slice(4)
        : "";
      const stderrFilter = createPassthroughStderrLineFilter(passthroughEngine);
      let stderrFilteredAccum = "";
      let sawAssistantChunk = false;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let rawTranscript = "";
      let traceTranscript = "";
      let exitCode = 0;

      updateStreamingChatBubble(bubble, rawTranscript, { pending: true });

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6));
              if (event.type === "chunk" && event.text) {
                let piece = filterOpenCodePassthroughTextChunk(
                  passthroughEngine,
                  event.text,
                );
                piece = filterGeminiPassthroughTextChunk(passthroughEngine, piece);
                if (piece) {
                  sawAssistantChunk = true;
                  rawTranscript += piece;
                  updateStreamingChatBubble(bubble, rawTranscript, { pending: true });
                }
              } else if (event.type === "trace" && event.text) {
                traceTranscript += event.text;
                activityTrace?.append(event.text);
              } else if (event.type === "stderr" && event.text) {
                const cleaned = stderrFilter.push(event.text);
                if (cleaned) {
                  stderrFilteredAccum += cleaned;
                  // OpenCode Ink status (e.g. "> build · model/id") often arrives on stderr — same as dashboard chat-actions.
                  let stderrPiece = filterOpenCodePassthroughTextChunk(
                    passthroughEngine,
                    cleaned,
                  );
                  stderrPiece = filterGeminiPassthroughTextChunk(
                    passthroughEngine,
                    stderrPiece,
                  );
                  if (stderrPiece) {
                    traceTranscript += stderrPiece;
                    activityTrace?.append(stderrPiece);
                  }
                  // Promote stderr into the main bubble until we see real assistant chunks
                  // (Cursor prints fatal errors on stderr only — avoids empty "No response returned.")
                  if (stderrPiece && !sawAssistantChunk) {
                    rawTranscript += stderrPiece;
                    updateStreamingChatBubble(bubble, rawTranscript, { pending: true });
                  }
                }
              } else if (event.type === "file-changed" && event.path && event.content) {
                // CLI engine wrote a file — show diff preview
                const oldContent = (activeTab?.path === event.path) ? activeTab.content : "";
                if (oldContent !== event.content) {
                  showDiffPreview({ path: event.path, newContent: event.content });
                  addTerminalLine(`🔄 ${event.path} changed — diff preview shown`, "info");
                } else {
                  // Content same or file is new — just refresh
                  if (activeTab?.path === event.path) {
                    activeTab.content = event.content;
                    editor?.setValue(event.content);
                  }
                  scheduleFileTreeRefresh();
                }
              } else if (event.type === "done") {
                exitCode = event.exitCode ?? 0;
                const stderrTail = stderrFilter.flush();
                if (stderrTail) {
                  stderrFilteredAccum += stderrTail;
                  let tailPiece = filterOpenCodePassthroughTextChunk(
                    passthroughEngine,
                    stderrTail,
                  );
                  tailPiece = filterGeminiPassthroughTextChunk(
                    passthroughEngine,
                    tailPiece,
                  );
                  if (tailPiece) {
                    traceTranscript += tailPiece;
                    activityTrace?.append(tailPiece);
                  }
                  if (tailPiece && !sawAssistantChunk) {
                    rawTranscript += tailPiece;
                    updateStreamingChatBubble(bubble, rawTranscript, { pending: true });
                  }
                }
                if (!rawTranscript.trim() && event.transcript) {
                  let t = filterOpenCodePassthroughTextChunk(
                    passthroughEngine,
                    event.transcript,
                  );
                  t = filterGeminiPassthroughTextChunk(passthroughEngine, t);
                  rawTranscript = t;
                }
                if (!traceTranscript.trim() && event.transcript) {
                  activityTrace?.append(event.transcript);
                }
                const topErr = summarizePassthroughTopErrorLine(
                  stderrFilteredAccum,
                  passthroughEngine,
                );
                if (exitCode !== 0 && topErr) {
                  if (!rawTranscript.trim()) {
                    rawTranscript = `↳ ${topErr}`;
                  } else if (!rawTranscript.includes(topErr)) {
                    rawTranscript += `\n\n↳ ${topErr}`;
                  }
                }
                if (!sawAssistantChunk && stderrFilteredAccum.trim()) {
                  let acc = filterOpenCodePassthroughTextChunk(
                    passthroughEngine,
                    stderrFilteredAccum,
                  );
                  acc = filterGeminiPassthroughTextChunk(passthroughEngine, acc);
                  rawTranscript = acc.trim();
                }
              }
            } catch (e) {
              console.warn("Failed to parse SSE event:", line, e);
            }
          }
        }
        const strayStderr = stderrFilter.flush();
        if (strayStderr) {
          stderrFilteredAccum += strayStderr;
          let stray = filterOpenCodePassthroughTextChunk(
            passthroughEngine,
            strayStderr,
          );
          stray = filterGeminiPassthroughTextChunk(passthroughEngine, stray);
          if (stray) {
            traceTranscript += stray;
            activityTrace?.append(stray);
          }
          if (stray && !sawAssistantChunk) {
            rawTranscript += stray;
          }
        }
        if (!sawAssistantChunk && stderrFilteredAccum.trim()) {
          let acc = filterOpenCodePassthroughTextChunk(
            passthroughEngine,
            stderrFilteredAccum,
          );
          acc = filterGeminiPassthroughTextChunk(passthroughEngine, acc);
          rawTranscript = acc.trim();
        }
      } catch (streamErr) {
        const streamMessage = [
          streamErr?.name,
          streamErr?.message,
          streamErr?.cause?.message,
          String(streamErr),
        ]
          .filter(Boolean)
          .join(" ");
        // Chrome: "BodyStreamBuffer was aborted" — disconnect, SSE close, or upstream abort
        const abortedStream =
          streamErr?.name === "AbortError" ||
          /BodyStreamBuffer|stream.*abort|The operation was aborted|user aborted|Loading is aborted/i.test(
            streamMessage,
          );
        const hasVisibleOutput =
          Boolean(rawTranscript.trim()) || Boolean(traceTranscript.trim());

        if (abortedStream && hasVisibleOutput) {
          console.warn("Chat stream interrupted after partial output:", streamErr);
          updateStreamingChatBubble(bubble, rawTranscript, {
            pending: false,
            exitCode,
          });
          activityTrace?.finish(exitCode);
          return;
        }

        throw streamErr;
      }

      updateStreamingChatBubble(bubble, rawTranscript, {
        pending: false,
        exitCode,
      });
      activityTrace?.finish(exitCode);
      if (
        chatMode === "crew-lead" &&
        /dispatch(?:ed)?\s+to\b|reply will show here|working/i.test(rawTranscript)
      ) {
        scheduleProjectReplyRefresh();
      }

      return;
    }

    // Fallback: if server returned JSON instead of SSE (e.g. error before stream started)
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();

      const respondingAgent = getErrorBubbleAgentId();
      const agentInfo =
        allAgents.find(
          (a) => a.id === respondingAgent || a.id === `crew-${respondingAgent}`,
        ) || { emoji: "⚡", agent: respondingAgent };
      const sourceInfo = {
        emoji: agentInfo.emoji || "🤖",
        agent: respondingAgent,
      };

      if (data.error) {
        appendChatBubble("assistant", `⚠️ ${data.error}`, sourceInfo);
      } else if (data.reply) {
        if (data.reply !== lastAppendedAssistantContent) {
          appendChatBubble("assistant", data.reply, sourceInfo);
          lastAppendedAssistantContent = data.reply;
        }
      }

      if (data.dispatched) {
        const note = document.createElement("div");
        note.style.cssText =
          "font-size:11px;color:var(--text-3);text-align:center;padding:4px;";
        note.textContent = `⚡ Dispatched to ${data.dispatched.agent}`;
        chatMessages.appendChild(note);
        scheduleProjectReplyRefresh();
      }
    }

    chatMessages.scrollTop = chatMessages.scrollHeight;
    cliTaskActive = false;
  } catch (err) {
    cliTaskActive = false;
    document.getElementById("typing-indicator")?.remove();
    // sourceInfo is now accessible here since it's declared outside the try block
    const respondingAgent = getErrorBubbleAgentId();
    const agentInfo =
      allAgents.find(
        (a) => a.id === respondingAgent || a.id === `crew-${respondingAgent}`,
      ) || { emoji: "⚡", agent: respondingAgent };
    const errorSourceInfo = {
      emoji: agentInfo.emoji || "🤖",
      agent: respondingAgent,
    };
    const msg = err?.message || String(err || "");
    const benignDisconnect =
      /BodyStreamBuffer|stream.*abort|AbortError|The operation was aborted/i.test(
        [err?.name, msg, err?.cause?.message].filter(Boolean).join(" "),
      );
    const note = benignDisconnect
      ? `${msg}\n\n(Stream ended early: timeout, tab refresh, or disconnect. Partial reply above may still be valid.)`
      : msg;
    appendChatBubble("assistant", `⚠️ Error: ${note}`, errorSourceInfo);
  }
}

function appendChatBubble(role, content, sourceInfo = null) {
  if (!chatMessages) {
    console.warn("Chat messages container not found");
    return;
  }

  const msgDiv = document.createElement("div");
  msgDiv.className = `message ${role}`;

  let header = role === "user" ? "You" : "crew-lead";
  if (sourceInfo) {
    let label = role === "user" ? "You" : null;
    if (!label) {
      if (sourceInfo.agent) label = sourceInfo.agent;
      else if (sourceInfo.source === "cli") label = sourceInfo.engine || "cli";
      else if (sourceInfo.source === "sub-agent") label = "sub-agent";
      else if (sourceInfo.source === "agent")
        label = sourceInfo.targetAgent || "agent";
      else label = "crew-lead";
    }
    header = `${sourceInfo.emoji} ${label}`;
  }

  const rawContent = String(content || "");
  const displayContent =
    role === "assistant"
      ? deriveCleanAssistantAnswer(rawContent) || rawContent
      : rawContent;

  msgDiv.innerHTML = `
    <div class="message-header">${escapeHtml(header)}</div>
    <div class="message-content">${escapeHtml(displayContent)}</div>
    ${role === "assistant" ? createTranscriptDetails(rawContent) : ""}
  `;
  chatMessages.appendChild(msgDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function createTranscriptDetails(rawTranscript) {
  const normalizedRaw = String(rawTranscript || "").trim();
  const display = deriveCleanAssistantAnswer(normalizedRaw);
  const normalizedDisplay = display.trim();

  if (!normalizedRaw || normalizedRaw === normalizedDisplay) {
    return "";
  }

  return `
    <details class="message-transcript">
      <summary>Show transcript</summary>
      <pre>${escapeHtml(normalizedRaw)}</pre>
    </details>
  `;
}

function getInlineChatElements() {
  return {
    response: document.getElementById("inline-chat-response"),
    answer: document.getElementById("inline-chat-answer"),
    transcript: document.getElementById("inline-chat-transcript"),
    transcriptBody: document.getElementById("inline-chat-transcript-body"),
  };
}

function isTranscriptTraceBlock(block, { hasTooling = false } = {}) {
  if (!block) return false;

  if (
    /(^|\n)(exec|read_mcp_resource|apply_patch|write_stdin|list_mcp_resources|list_mcp_resource_templates)\s*$/m.test(
      block,
    )
  ) {
    return true;
  }

  if (
    /\/bin\/(?:zsh|bash|sh)\s+-lc\b|succeeded in \d+ms:|failed in \d+ms:|Process exited with code|Chunk ID:|Wall time:|Original token count:/i.test(
      block,
    )
  ) {
    return true;
  }

  if (
    hasTooling &&
    /^(I(?:'m| am)\b|Checking\b|Reading\b|Tracing\b|Looking\b|Inspecting\b|Searching\b|Reviewing\b)/i.test(
      block,
    )
  ) {
    return true;
  }

  return false;
}

function deriveCleanAssistantAnswer(rawTranscript) {
  const normalized = String(rawTranscript || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";

  const blocks = normalized
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  if (!blocks.length) return "";

  const hasTooling = blocks.some((block) => isTranscriptTraceBlock(block));
  if (!hasTooling) {
    return normalized;
  }

  let lastTraceIndex = -1;
  blocks.forEach((block, index) => {
    if (isTranscriptTraceBlock(block, { hasTooling: true })) {
      lastTraceIndex = index;
    }
  });

  const answerBlocks = blocks.filter(
    (block, index) =>
      index > lastTraceIndex && !isTranscriptTraceBlock(block, { hasTooling: true }),
  );
  if (answerBlocks.length) {
    return answerBlocks.join("\n\n").trim();
  }

  const cleanedLines = normalized
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (
        /^(exec|read_mcp_resource|apply_patch|write_stdin|list_mcp_resources|list_mcp_resource_templates)$/i.test(
          trimmed,
        )
      ) {
        return false;
      }
      if (
        /\/bin\/(?:zsh|bash|sh)\s+-lc\b|succeeded in \d+ms:|failed in \d+ms:|Process exited with code|Chunk ID:|Wall time:|Original token count:/i.test(
          trimmed,
        )
      ) {
        return false;
      }
      return true;
    })
    .join("\n")
    .trim();

  return cleanedLines || normalized;
}

function renderInlineChatResponse(rawTranscript, options = {}) {
  const { response, answer, transcript, transcriptBody } = getInlineChatElements();
  const raw = String(rawTranscript || "");
  const display = deriveCleanAssistantAnswer(raw);
  const visibleText = display || (options.pending ? "Thinking..." : "No response yet.");

  answer.textContent = visibleText;
  answer.dataset.empty = display ? "false" : "true";

  const normalizedRaw = raw.trim();
  const normalizedDisplay = display.trim();
  const shouldShowTranscript =
    normalizedRaw &&
    normalizedRaw !== normalizedDisplay &&
    !options.hideTranscript;

  transcript.hidden = !shouldShowTranscript;
  transcriptBody.textContent = shouldShowTranscript ? normalizedRaw : "";

  if (!shouldShowTranscript) {
    transcript.open = false;
  }

  response.classList.toggle(
    "visible",
    Boolean(raw || options.pending || options.forceVisible),
  );
}

function createStreamingChatBubble(label) {
  const msgDiv = document.createElement("div");
  msgDiv.className = "message assistant";
  msgDiv.innerHTML = `
    <div class="message-header"></div>
    <div class="message-content"></div>
    <details class="message-transcript" hidden>
      <summary>Show transcript</summary>
      <pre></pre>
    </details>
  `;

  chatMessages.appendChild(msgDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  return {
    label,
    root: msgDiv,
    header: msgDiv.querySelector(".message-header"),
    content: msgDiv.querySelector(".message-content"),
    transcript: msgDiv.querySelector(".message-transcript"),
    transcriptBody: msgDiv.querySelector("pre"),
  };
}

function updateStreamingChatBubble(view, rawTranscript, options = {}) {
  const normalizedRaw = String(rawTranscript || "");
  const cleanAnswer = deriveCleanAssistantAnswer(normalizedRaw);
  const exitCode = options.exitCode ?? 0;
  const visibleText =
    cleanAnswer ||
    (options.pending
      ? `${view.label} is working...`
      : exitCode !== 0
        ? "No assistant output — check the trace for errors (engine may need login, model access, or config)."
        : "No response returned.");

  view.header.textContent = options.pending
    ? `${view.label} · working`
    : `${view.label} · exit ${options.exitCode ?? 0}`;
  view.content.textContent = visibleText;

  const normalizedClean = cleanAnswer.trim();
  const trimmedRaw = normalizedRaw.trim();
  const shouldShowTranscript = trimmedRaw && trimmedRaw !== normalizedClean;

  view.transcript.hidden = !shouldShowTranscript;
  view.transcriptBody.textContent = shouldShowTranscript ? trimmedRaw : "";

  if (!shouldShowTranscript) {
    view.transcript.open = false;
  }

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function createActivityTrace(label) {
  const container = document.getElementById("terminal-content");
  if (!container) {
    return null;
  }

  const trace = document.createElement("details");
  trace.className = "terminal-trace";
  trace.open = true;

  const summary = document.createElement("summary");
  summary.textContent = `${label} · live trace`;

  const body = document.createElement("pre");
  body.className = "terminal-trace-body";

  trace.append(summary, body);
  container.appendChild(trace);
  while (container.children.length > MAX_TERMINAL_ENTRIES) {
    container.removeChild(container.firstElementChild);
  }
  container.scrollTop = container.scrollHeight;

  return {
    append(text) {
      if (!text) return;
      body.textContent += text;
      container.scrollTop = container.scrollHeight;
    },
    finish(exitCode) {
      summary.textContent = `${label} · exit ${exitCode ?? 0}`;
      container.scrollTop = container.scrollHeight;
    },
    fail(message) {
      if (message) {
        if (body.textContent && !body.textContent.endsWith("\n")) {
          body.textContent += "\n";
        }
        body.textContent += message;
      }
      summary.textContent = `${label} · failed`;
      container.scrollTop = container.scrollHeight;
    },
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// INLINE CHAT (Cmd+K)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function showInlineChat() {
  const overlay = document.getElementById("inline-chat-overlay");
  const box = document.getElementById("inline-chat-box");
  const input = document.getElementById("inline-chat-input");
  const meta = document.getElementById("inline-chat-meta");
  const context = document.getElementById("inline-chat-context");

  await ensureEditorReady();

  const selection = editor.getSelection();
  const selectedText = editor.getModel().getValueInRange(selection);
  const position = editor.getPosition();
  const fileName = activeTab?.name || "this file";

  if (selectedText) {
    input.placeholder = `Ask about the selected code in ${fileName}...`;
  } else {
    input.placeholder = `What do you want to do at ${fileName}:${position?.lineNumber || 1}?`;
  }

  context.textContent = position
    ? `${fileName} · line ${position.lineNumber}, column ${position.column}`
    : `${fileName} · current cursor`;
  meta.textContent = "No response yet";
  renderInlineChatResponse("", { hideTranscript: true });
  overlay.classList.add("visible");
  box.setAttribute("data-open", "true");
  requestAnimationFrame(() => {
    positionInlineChat();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
}

window.hideInlineChat = function () {
  const overlay = document.getElementById("inline-chat-overlay");
  const box = document.getElementById("inline-chat-box");
  overlay.classList.remove("visible");
  box.removeAttribute("style");
  box.removeAttribute("data-open");
  document.getElementById("inline-chat-input").value = "";
  renderInlineChatResponse("", { hideTranscript: true });
  inlineChatAnchor = null;
  editor?.focus();
};

window.sendInlineChat = async function () {
  const input = document.getElementById("inline-chat-input");
  const model = document.getElementById("inline-chat-model");
  const meta = document.getElementById("inline-chat-meta");
  const message = input.value.trim();
  if (!message) return;

  if (model.value !== "codex") {
    renderInlineChatResponse("Inline local mode currently supports Codex only.", {
      hideTranscript: true,
      forceVisible: true,
    });
    meta.textContent = `Switch model to Codex to run inline requests`;
    return;
  }

  const selection = editor.getSelection();
  const selectedText = editor.getModel().getValueInRange(selection);
  const position = editor.getPosition();
  const targetFile = activeTab?.path || activeTab?.name || "untitled";
  const prompt = [
    `Inline request for ${targetFile}${position ? `:${position.lineNumber}:${position.column}` : ""}.`,
    selectedText
      ? `Selected code:\n${selectedText}`
      : "No code is selected.",
    `User request: ${message}`,
  ].join("\n\n");

  let rawTranscript = "";
  renderInlineChatResponse("", { pending: true, hideTranscript: true });
  meta.textContent = "Running Codex...";

  try {
    const result = await fetch(`${STUDIO_API}/api/studio/chat/unified`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mode: "cli",
        engine: "codex",
        message: prompt,
        projectId: currentProject?.id || "general",
        projectDir: currentProject?.outputDir || getBrowseDirectory(),
        activeFile: targetFile,
      }),
    });

    if (!result.ok) {
      throw new Error(`HTTP ${result.status}`);
    }

    const reader = result.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const event = JSON.parse(line.slice(6));
        if (event.type === "chunk" && event.text) {
          rawTranscript += event.text;
          renderInlineChatResponse(rawTranscript, { pending: true });
        }
        if (event.type === "done") {
          if (!rawTranscript.trim() && event.transcript) {
            rawTranscript = event.transcript;
          }
          meta.textContent = `Codex finished with exit ${event.exitCode ?? 0}`;
          renderInlineChatResponse(rawTranscript);
        }
      }
    }
  } catch (error) {
    renderInlineChatResponse(`Inline Codex failed: ${error.message}`, {
      hideTranscript: true,
      forceVisible: true,
    });
    meta.textContent = "Inline Codex request failed";
  }

  input.value = "";
};

function positionInlineChat() {
  const overlay = document.getElementById("inline-chat-overlay");
  const box = document.getElementById("inline-chat-box");
  if (!editor || !overlay || !box) return;

  const position = editor.getPosition();
  const domNode = editor.getDomNode();
  if (!position || !domNode) return;

  const cursorCoords = editor.getScrolledVisiblePosition(position);
  const editorRect = domNode.getBoundingClientRect();
  const fallbackTop = editorRect.top + 48;
  const fallbackLeft = editorRect.left + 48;

  const anchorTop = cursorCoords
    ? editorRect.top + cursorCoords.top + cursorCoords.height + 14
    : fallbackTop;
  const anchorLeft = cursorCoords
    ? editorRect.left + cursorCoords.left + 8
    : fallbackLeft;

  inlineChatAnchor = { top: anchorTop, left: anchorLeft };

  box.style.top = "0px";
  box.style.left = "0px";
  box.style.maxWidth = `min(420px, calc(100vw - 24px))`;

  const boxRect = box.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const clampedLeft = Math.min(
    Math.max(12, anchorLeft),
    Math.max(12, viewportWidth - boxRect.width - 12),
  );
  const clampedTop = Math.min(
    Math.max(12, anchorTop),
    Math.max(12, viewportHeight - boxRect.height - 12),
  );

  box.style.left = `${clampedLeft}px`;
  box.style.top = `${clampedTop}px`;
}

document.getElementById("inline-chat-overlay").addEventListener("mousedown", (e) => {
  if (e.target.id === "inline-chat-overlay") {
    hideInlineChat();
  }
});

document.getElementById("inline-chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    hideInlineChat();
  } else if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendInlineChat();
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    hideInlineChat();
  }
});

window.addEventListener("keydown", (e) => {
  const isShortcut = (e.metaKey || e.ctrlKey) && e.code === "KeyK";
  if (!isShortcut) return;

  const overlay = document.getElementById("inline-chat-overlay");
  if (!overlay.classList.contains("visible")) return;

  e.preventDefault();
  hideInlineChat();
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const overlay = document.getElementById("inline-chat-overlay");
    if (overlay.classList.contains("visible")) {
      e.preventDefault();
      hideInlineChat();
    }
  }
});

window.addEventListener("resize", () => {
  const overlay = document.getElementById("inline-chat-overlay");
  if (overlay.classList.contains("visible")) {
    positionInlineChat();
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DIFF PREVIEW
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let diffEditor = null;
let pendingChange = null;
let diffQueue = []; // Queue of { path, newContent, oldContent } for multi-file diffs

function parseFileChanges(agentReply) {
  const fileRegex =
    /@@WRITE_FILE\s+(.+?)\n([\s\S]+?)(?=@@END_FILE|@@WRITE_FILE|$)/g;
  const changes = [];
  let match;
  while ((match = fileRegex.exec(agentReply)) !== null) {
    changes.push({ path: match[1].trim(), newContent: match[2].trim() });
  }
  return changes;
}

async function showDiffPreview(change) {
  // If a diff is already showing, queue this one
  const overlay = document.getElementById("diff-preview-overlay");
  if (overlay.classList.contains("visible") && pendingChange) {
    diffQueue.push(change);
    updateDiffCounter();
    return;
  }

  pendingChange = change;
  await ensureEditorReady();
  await ensureEditorLanguage(detectLanguage(change.path));

  const container = document.getElementById("diff-editor");
  const filePathEl = document.getElementById("diff-file-path");

  // Get current file content
  const oldContent = activeTab?.path === change.path
    ? activeTab.content
    : await readFile(change.path).catch(() => "");
  pendingChange.oldContent = oldContent;

  if (diffEditor) diffEditor.dispose();
  diffEditor = monaco.editor.createDiffEditor(container, {
    theme: getPreferredMonacoTheme(),
    readOnly: false,
    fontSize: 13,
    renderSideBySide: true,
    automaticLayout: true,
  });
  diffEditor.setModel({
    original: monaco.editor.createModel(oldContent, detectLanguage(change.path)),
    modified: monaco.editor.createModel(change.newContent, detectLanguage(change.path)),
  });

  filePathEl.textContent = change.path;
  overlay.classList.add("visible");
  updateDiffCounter();
}

function updateDiffCounter() {
  const counter = document.getElementById("diff-queue-counter");
  const acceptAllBtn = document.getElementById("diff-accept-all-btn");
  const total = diffQueue.length + (pendingChange ? 1 : 0);
  if (counter) {
    counter.textContent = total > 1 ? `${total} files changed` : "";
    counter.style.display = total > 1 ? "inline" : "none";
  }
  if (acceptAllBtn) {
    acceptAllBtn.style.display = total > 1 ? "inline-block" : "none";
  }
}

async function applyOneChange(change) {
  try {
    await fetchJSON(`${STUDIO_API}/api/studio/file-content`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: change.path, content: change.newContent }),
    });
    const openTab = openTabs.find((tab) => tab.path === change.path);
    if (openTab) {
      openTab.content = change.newContent;
      if (activeTab?.path === change.path) editor?.setValue(change.newContent);
    }
    addTerminalLine(`✅ Applied ${change.path}`, "success");
  } catch (err) {
    addTerminalLine(`❌ Failed to apply ${change.path}: ${err.message}`, "error");
  }
}

async function showNextDiff() {
  if (diffQueue.length > 0) {
    const next = diffQueue.shift();
    pendingChange = null;
    await showDiffPreview(next);
  } else {
    closeDiffPreview();
    await loadFileTree();
  }
}

window.acceptDiff = async function () {
  if (!pendingChange) return;
  await applyOneChange(pendingChange);
  pendingChange = null;
  await showNextDiff();
};

window.acceptAllDiffs = async function () {
  // Accept current + all queued
  if (pendingChange) {
    await applyOneChange(pendingChange);
    pendingChange = null;
  }
  for (const change of diffQueue) {
    await applyOneChange(change);
  }
  diffQueue = [];
  closeDiffPreview();
  await loadFileTree();
  addTerminalLine(`✅ All changes applied`, "success");
};

window.rejectDiff = async function () {
  if (pendingChange) {
    const openTab = openTabs.find((tab) => tab.path === pendingChange.path);
    if (openTab && pendingChange.oldContent !== undefined && openTab.content !== pendingChange.newContent) {
      try {
        await fetchJSON(`${STUDIO_API}/api/studio/file-content`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: pendingChange.path, content: pendingChange.oldContent }),
        });
        if (activeTab?.path === pendingChange.path) editor?.setValue(pendingChange.oldContent);
        addTerminalLine(`↩️ Reverted ${pendingChange.path}`, "warning");
      } catch {
        addTerminalLine(`⚠️ Could not revert ${pendingChange.path}`, "error");
      }
    } else {
      addTerminalLine(`🗑️ Dismissed ${pendingChange.path}`, "warning");
    }
  }
  pendingChange = null;
  await showNextDiff();
};

window.addEventListener("studio-themechange", () => {
  if (monaco) {
    monaco.editor.setTheme(getPreferredMonacoTheme());
  }
});

function closeDiffPreview() {
  const overlay = document.getElementById("diff-preview-overlay");
  overlay.classList.remove("visible");
  if (diffEditor) {
    diffEditor.dispose();
    diffEditor = null;
  }
  pendingChange = null;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TERMINAL
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function addTerminalLine(text, type = "info") {
  const container = document.getElementById("terminal-content");
  if (!container) return;
  const line = document.createElement("div");
  line.className = `terminal-line ${type}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  container.appendChild(line);
  while (container.children.length > MAX_TERMINAL_ENTRIES) {
    container.removeChild(container.firstElementChild);
  }
  container.scrollTop = container.scrollHeight;

  // Update status bar
  const statusText = document.getElementById("status-text");
  if (statusText) {
    statusText.textContent =
      text.slice(0, 60) + (text.length > 60 ? "..." : "");
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// RT MESSAGE BUS (WebSocket)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function connectRTBus() {
  ws = new WebSocket(RT_WS);

  ws.onopen = () => {
    addTerminalLine("🔗 Connected to RT message bus", "success");
    document.getElementById("statusDot").style.background = "var(--green)";
    document.getElementById("statusText").textContent = "Connected";
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === "task_claimed") {
        addTerminalLine(`⚡ ${msg.agent} started working on task`, "info");
      } else if (msg.type === "task_completed") {
        addTerminalLine(`✅ ${msg.agent} completed task`, "success");
      } else if (msg.type === "tool_call") {
        addTerminalLine(`🔧 ${msg.agent} → ${msg.tool}`, "info");
      } else if (msg.type === "error") {
        addTerminalLine(`❌ ${msg.agent}: ${msg.error}`, "error");
      }
    } catch (err) {
      // Ignore parse errors
    }
  };

  ws.onerror = (err) => {
    addTerminalLine("❌ RT bus connection error", "error");
    document.getElementById("statusDot").style.background = "var(--red)";
    document.getElementById("statusText").textContent = "Disconnected";
  };

  ws.onclose = () => {
    addTerminalLine("🔌 RT bus disconnected", "warning");
    document.getElementById("statusDot").style.background = "var(--yellow)";
    document.getElementById("statusText").textContent = "Reconnecting...";
    setTimeout(connectRTBus, 3000);
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STUDIO WATCH (CLI FILE CHANGES)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function connectStudioWatch() {
  if (!watchReconnectEnabled) {
    updateWatchStatus("disabled");
    return;
  }

  if (watchWs && watchWs.readyState === WebSocket.OPEN) {
    return; // Already connected
  }

  if (watchReconnectTimer) {
    clearTimeout(watchReconnectTimer);
    watchReconnectTimer = null;
  }

  updateWatchStatus("connecting");

  watchWs = new WebSocket(STUDIO_WATCH_WS);

  watchWs.onopen = () => {
    addTerminalLine(
      "🔗 Connected to CLI watch server (live reload enabled)",
      "success",
    );
    updateWatchStatus("connected");
  };

  watchWs.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === "file-changed") {
        // File changed by CLI
        addTerminalLine(`🔄 ${msg.path} updated by CLI`, "info");

        // If file is open in editor AND a CLI task is active, show diff preview
        if (cliTaskActive && activeTab && activeTab.path === msg.path && msg.content) {
          const oldContent = activeTab.content || "";
          if (oldContent !== msg.content) {
            showDiffPreview({ path: msg.path, newContent: msg.content });
            addTerminalLine(`  ↳ Diff preview shown — accept or dismiss`, "info");
          }
        } else if (activeTab && activeTab.path === msg.path && msg.content) {
          // No active task — silently reload as before
          activeTab.content = msg.content;
          editor?.setValue(msg.content);
          addTerminalLine(`  ↳ Reloaded in editor`, "success");
        }

        // Refresh file tree to show changes
        scheduleFileTreeRefresh();
      } else if (msg.type === "file-created") {
        // For new files during active CLI task, show diff (old content is empty)
        if (cliTaskActive && msg.content) {
          showDiffPreview({ path: msg.path, newContent: msg.content });
          addTerminalLine(`✨ ${msg.path} created by CLI — diff preview shown`, "success");
        } else {
          addTerminalLine(`✨ ${msg.path} created by CLI`, "success");
        }
        scheduleFileTreeRefresh();
      } else if (msg.type === "file-deleted") {
        addTerminalLine(`🗑️  ${msg.path} deleted by CLI`, "warning");

        // Close tab if deleted file is open
        if (activeTab && activeTab.path === msg.path) {
          closeTab(activeTab.path);
        }

        scheduleFileTreeRefresh();
      } else if (msg.type === "connected") {
        addTerminalLine(`💬 ${msg.message}`, "info");
      }
    } catch (err) {
      // Ignore parse errors
    }
  };

  watchWs.onerror = () => {
    // Watch server not running - that's OK, just won't get live updates
    updateWatchStatus("error");
  };

  watchWs.onclose = () => {
    watchWs = null;
    if (!watchReconnectEnabled) {
      updateWatchStatus("disabled");
      return;
    }

    updateWatchStatus("disconnected");
    watchReconnectTimer = setTimeout(() => {
      watchReconnectTimer = null;
      connectStudioWatch();
    }, 5000);
  };
}

function updateWatchStatus(status) {
  const dot = document.getElementById("watchStatusDot");
  const text = document.getElementById("watchStatusText");

  if (!dot || !text) return;

  if (status === "connected") {
    dot.style.background = "var(--green)";
    text.textContent = "Watch Server";
  } else if (status === "disconnected") {
    dot.style.background = "var(--yellow)";
    text.textContent = "Watch Server (reconnecting...)";
  } else if (status === "error") {
    dot.style.background = "var(--red)";
    text.textContent = "Watch Server (offline)";
  } else if (status === "connecting") {
    dot.style.background = "var(--yellow)";
    text.textContent = "Watch Server (connecting...)";
  } else if (status === "disabled") {
    dot.style.background = "var(--text-3)";
    text.textContent = "Watch Server (disabled)";
  }
}

window.toggleWatchConnection = function () {
  if (!watchReconnectEnabled) {
    watchReconnectEnabled = true;
    addTerminalLine("🔄 Reconnecting to watch server...", "info");
    connectStudioWatch();
  } else {
    watchReconnectEnabled = false;
    if (watchReconnectTimer) {
      clearTimeout(watchReconnectTimer);
      watchReconnectTimer = null;
    }
    addTerminalLine("⏸️ Disconnecting from watch server...", "warning");
    watchWs?.close();
    updateWatchStatus("disabled");
  }
};

function bindWatchToggleButton() {
  const watchToggle = document.getElementById("watchToggle");
  if (!watchToggle) return;
  watchToggle.addEventListener("click", () => {
    window.toggleWatchConnection();
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AUTH
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function loadAuthToken() {
  try {
    const response = await fetch(`${DASHBOARD_API}/api/auth/token`);
    if (response.ok) {
      const data = await response.json();
      AUTH_TOKEN = data.token || "";
      if (AUTH_TOKEN) {
        addTerminalLine(`✅ Loaded auth token`, "success");
      } else {
        addTerminalLine(
          `⚠️ No auth token configured (running in open mode)`,
          "warning",
        );
      }
    } else {
      addTerminalLine(
        `⚠️ Dashboard not reachable - running without auth`,
        "warning",
      );
    }
  } catch (err) {
    addTerminalLine(`⚠️ Could not load auth token: ${err.message}`, "warning");
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PROJECT SELECTOR EVENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

document.getElementById("projectSelector")?.addEventListener("change", (e) => {
  const projectId = e.target.value;
  console.log(
    "[projectSelector] Change event - value:",
    projectId,
    "options:",
    Array.from(e.target.options).map((o) => ({
      value: o.value,
      text: o.textContent,
    })),
  );
  switchProject(projectId);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// INIT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Listen to hash changes for project routing (like dashboard)
window.addEventListener("hashchange", () => {
  const hash = window.location.hash;
  const match = hash.match(/project=([^&]+)/);
  if (match) {
    const projectId = decodeURIComponent(match[1]);
    const selector = document.getElementById("projectSelector");
    if (selector && selector.value !== projectId) {
      selector.value = projectId;
      switchProject(projectId);
    }
  }
});

window.addEventListener("focus", () => {
  syncProjectFromSharedState().catch(() => {});
});

async function init() {
  try {
    addTerminalLine("🐝 crewswarm Vibe starting...", "info");

renderEditorPlaceholder();
bindEditorToolbar();
    bindWatchToggleButton();
    await loadAuthToken();
    await loadProjects();
    await loadAgents();
    window.switchChatMode();
    connectCrewLeadEvents();
    connectRTBus();
    connectStudioWatch(); // Connect to CLI watch server for live reload

    addTerminalLine("✅ Vibe ready", "success");
    if (languageBootstrapFailed) {
      addTerminalLine(
        "ℹ️ Syntax highlighting may be limited until the language loader issue is fixed",
        "info",
      );
    }
    addTerminalLine(
      "💡 Tip: Press Cmd+K in the editor to chat about your code",
      "info",
    );
  } catch (err) {
    console.error("Vibe init failed:", err);
    addTerminalLine(`❌ Vibe failed to initialize: ${err.message}`, "error");
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NEW PROJECT MODAL
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

window.showNewProjectModal = function () {
  document.getElementById("new-project-overlay").style.display = "flex";
  document.getElementById("new-project-name").focus();
};

window.hideNewProjectModal = function () {
  document.getElementById("new-project-overlay").style.display = "none";
  document.getElementById("new-project-name").value = "";
  document.getElementById("new-project-desc").value = "";
  document.getElementById("new-project-dir").value = "";
};

window.createNewProject = async function () {
  const name = document.getElementById("new-project-name").value.trim();
  const description = document.getElementById("new-project-desc").value.trim();
  const outputDir = document.getElementById("new-project-dir").value.trim();

  if (!name) {
    alert("Project name is required");
    return;
  }

  if (!outputDir) {
    alert("Output directory is required");
    return;
  }

  try {
    const response = await fetch(`${STUDIO_API}/api/studio/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        description,
        outputDir,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    if (data.ok && data.project) {
      addTerminalLine(`✅ Created project: ${name}`, "success");
      hideNewProjectModal();
      await loadProjects();

      // Auto-select the new project
      const selector = document.getElementById("projectSelector");
      selector.value = data.project.id;
      await switchProject(data.project.id);
    } else {
      addTerminalLine(
        `❌ Failed to create project: ${data.error || "Unknown error"}`,
        "error",
      );
    }
  } catch (err) {
    addTerminalLine(`❌ Failed to create project: ${err.message}`, "error");
  }
};

init();
