#!/usr/bin/env node
/**
 * crewswarm Vibe local server
 *
 * Standalone local mode owns:
 * - project persistence
 * - file listing / read / write
 * - Codex CLI passthrough for local coding
 * - lightweight local chat history
 */

import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { shouldSkipGeminiPassthroughLine } from "../../lib/gemini-cli-passthrough-noise.mjs";
import { normalizeProjectDir } from "../../lib/runtime/project-dir.mjs";
import { resolveCursorLaunchSpec } from "../../lib/engines/cursor-launcher.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version;
const SERVER_START = Date.now();
const PORT = Number(process.env.STUDIO_PORT || 3333);
const DIST_DIR = path.join(__dirname, "dist");
const WORKSPACE_DIR = __dirname;
const STUDIO_DATA_DIR = process.env.STUDIO_DATA_DIR
  ? path.resolve(process.env.STUDIO_DATA_DIR)
  : path.join(__dirname, ".studio-data");
const MESSAGE_DIR = path.join(STUDIO_DATA_DIR, "project-messages");
const terminalSessions = new Map();
// CLI session resume: maps "engine:projectDir" → { sessionId, conversationId, ts }
const cliResumeSessions = new Map();
const PTY_HOST = path.join(__dirname, "scripts", "studio-pty-host.py");
const DEFAULT_PROJECT_ID = "studio-local";
const CREWSWARM_CFG_DIR = path.join(os.homedir(), ".crewswarm");
const SHARED_PROJECTS_FILE = path.join(CREWSWARM_CFG_DIR, "projects.json");
const UI_STATE_FILE = path.join(CREWSWARM_CFG_DIR, "ui-state.json");
const DEFAULT_PROJECT = {
  id: DEFAULT_PROJECT_ID,
  name: "Vibe Workspace",
  outputDir: WORKSPACE_DIR,
  description: "Local Vibe workspace",
};

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const COMPRESSIBLE_EXTENSIONS = new Set([".html", ".js", ".css", ".json", ".svg"]);
const WORKSPACE_SCAN_CACHE_TTL_MS = Number(process.env.STUDIO_SCAN_CACHE_TTL_MS || 1_500);
const workspaceScanCache = new Map();
const auditFileCache = new Map();

export function ensureDataDirs() {
  fs.mkdirSync(STUDIO_DATA_DIR, { recursive: true });
  fs.mkdirSync(MESSAGE_DIR, { recursive: true });
}

function slugify(value = "") {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function ensureProjects() {
  ensureDataDirs();
  try {
    const parsed = JSON.parse(fs.readFileSync(SHARED_PROJECTS_FILE, "utf8"));
    const sharedProjects = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object"
        ? Object.values(parsed)
        : [];
    const deduped = sharedProjects.filter(
      (project) => project && project.id && project.id !== DEFAULT_PROJECT_ID,
    );
    return [...deduped, DEFAULT_PROJECT];
  } catch {
    return [DEFAULT_PROJECT];
  }
}

export function readProjects() {
  return ensureProjects();
}

export function writeProjects(projects) {
  ensureDataDirs();
  fs.mkdirSync(CREWSWARM_CFG_DIR, { recursive: true });
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(SHARED_PROJECTS_FILE, "utf8"));
  } catch {
    existing = {};
  }
  const next = { ...(existing && typeof existing === "object" ? existing : {}) };
  for (const project of Array.isArray(projects) ? projects : []) {
    if (!project?.id || project.id === DEFAULT_PROJECT_ID) continue;
    next[project.id] = {
      ...(next[project.id] || {}),
      ...project,
    };
  }
  fs.writeFileSync(SHARED_PROJECTS_FILE, JSON.stringify(next, null, 2));
  clearWorkspaceCaches();
}

function readUiState() {
  try {
    return JSON.parse(fs.readFileSync(UI_STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeUiState(nextState = {}) {
  ensureDataDirs();
  fs.mkdirSync(CREWSWARM_CFG_DIR, { recursive: true });
  fs.writeFileSync(UI_STATE_FILE, JSON.stringify(nextState, null, 2));
}

function clearWorkspaceCaches() {
  workspaceScanCache.clear();
}

function resolveStudioProjectPath(rawPath, fallback = WORKSPACE_DIR) {
  const normalized = normalizeProjectDir(rawPath);
  if (normalized) return normalized;
  const source =
    rawPath == null || String(rawPath).trim() === "" ? fallback : String(rawPath);
  return path.resolve(source);
}

function getAllowedRoots() {
  const roots = new Set([WORKSPACE_DIR]);
  for (const project of readProjects()) {
    if (project?.outputDir) {
      roots.add(resolveStudioProjectPath(project.outputDir));
    }
  }
  return [...roots];
}

function isWithinAllowedRoots(targetPath) {
  const resolved = path.resolve(targetPath);
  return getAllowedRoots().some(
    (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`),
  );
}

function resolveRequestPath(url = "/") {
  const parsedUrl = new URL(url, "http://127.0.0.1");
  let pathname = decodeURIComponent(parsedUrl.pathname);

  if (pathname === "/") {
    pathname = "/index.html";
  }

  if (pathname.startsWith("/dist/")) {
    pathname = pathname.slice("/dist".length);
  }

  const relativePath = pathname.replace(/^\/+/, "");
  const distPath = path.join(DIST_DIR, relativePath);
  // Fall back to source directory if file doesn't exist in dist (e.g. unbundled dev mode)
  if (!fs.existsSync(distPath)) {
    const srcPath = path.join(__dirname, relativePath);
    if (fs.existsSync(srcPath)) return srcPath;
  }
  return distPath;
}

function getCacheControlHeader(filePath) {
  const relativePath = path.relative(DIST_DIR, filePath).replace(/\\/g, "/");
  if (relativePath.startsWith("assets/")) {
    return "public, max-age=31536000, immutable";
  }
  return "no-cache";
}

function getEncodedAsset(filePath, acceptEncoding = "") {
  const ext = path.extname(filePath).toLowerCase();
  if (!COMPRESSIBLE_EXTENSIONS.has(ext)) {
    return { filePath, encoding: null };
  }

  if (acceptEncoding.includes("br")) {
    const brotliPath = `${filePath}.br`;
    if (fs.existsSync(brotliPath)) {
      return { filePath: brotliPath, encoding: "br" };
    }
  }

  if (acceptEncoding.includes("gzip")) {
    const gzipPath = `${filePath}.gz`;
    if (fs.existsSync(gzipPath)) {
      return { filePath: gzipPath, encoding: "gzip" };
    }
  }

  return { filePath, encoding: null };
}

function readUtf8FileSyncWithRetry(filePath, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function readFileWithRetry(filePath, attempts = 3, delayMs = 25) {
  return new Promise((resolve, reject) => {
    const tryRead = (attempt) => {
      fs.readFile(filePath, (err, content) => {
        if (!err) {
          resolve(content);
          return;
        }
        if (attempt < attempts) {
          setTimeout(() => tryRead(attempt + 1), delayMs);
          return;
        }
        reject(err);
      });
    };
    tryRead(1);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

export function listWorkspaceFiles(scanDir) {
  const resolvedScanDir = path.resolve(scanDir);
  const cached = workspaceScanCache.get(resolvedScanDir);
  if (cached && Date.now() - cached.createdAt < WORKSPACE_SCAN_CACHE_TTL_MS) {
    return cached.files;
  }

  const ALLOWED_EXT = new Set([
    ".html",
    ".css",
    ".js",
    ".mjs",
    ".ts",
    ".json",
    ".md",
    ".sh",
    ".txt",
    ".yaml",
    ".yml",
  ]);
  const MAX_FILES = 800;
  const results = [];

  function walk(dir, depth) {
    if (depth > 6 || results.length >= MAX_FILES) return;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= MAX_FILES) return;
      if (
        entry.name.startsWith(".") ||
        entry.name === "node_modules" ||
        entry.name === "dist"
      ) {
        continue;
      }

      const full = path.join(dir, entry.name);
      if (!isWithinAllowedRoots(full)) {
        continue;
      }

      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) {
        continue;
      }

      try {
        const stat = fs.statSync(full);
        results.push({ path: full, size: stat.size, mtime: stat.mtimeMs });
      } catch {
        // Skip unreadable files.
      }
    }
  }

  walk(resolvedScanDir, 0);
  results.sort((a, b) => b.mtime - a.mtime);
  workspaceScanCache.set(resolvedScanDir, {
    createdAt: Date.now(),
    files: results,
  });
  return results;
}

function invalidateWorkspaceScanCache(targetPath) {
  const resolved = path.resolve(targetPath);

  for (const cache of [workspaceScanCache, auditFileCache]) {
    for (const [root] of cache) {
      if (
        resolved === root ||
        resolved.startsWith(`${root}${path.sep}`) ||
        root.startsWith(`${resolved}${path.sep}`)
      ) {
        cache.delete(root);
      }
    }
  }
}


function projectMessageFile(projectId) {
  const safeId = slugify(projectId || "general") || "general";
  return path.join(MESSAGE_DIR, `${safeId}.jsonl`);
}

function loadCrewswarmRtToken() {
  const envToken = (process.env.CREWSWARM_RT_AUTH_TOKEN || "").trim();
  if (envToken) return envToken;
  for (const file of [
    path.join(process.env.HOME || "", ".crewswarm", "crewswarm.json"),
    path.join(process.env.HOME || "", ".crewswarm", "config.json"),
  ]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const token =
        parsed?.rt?.authToken || parsed?.env?.CREWSWARM_RT_AUTH_TOKEN || "";
      if (token) return token;
    } catch {
      // Ignore unreadable local config files.
    }
  }
  return "";
}

export function appendProjectMessage(projectId, message) {
  ensureDataDirs();
  fs.appendFileSync(projectMessageFile(projectId), `${JSON.stringify(message)}\n`);
}

export function readProjectMessages(projectId, limit = 50) {
  const file = projectMessageFile(projectId);
  if (!fs.existsSync(file)) {
    return [];
  }

  let lines;
  try {
    lines = readUtf8FileSyncWithRetry(file)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    console.warn(
      `[vibe] Failed to read project messages for ${projectId}: ${error.message}`,
    );
    return [];
  }

  return lines
    .slice(-Math.max(1, Math.min(Number(limit) || 50, 200)))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function sendSseHeaders(res) {
  if (res.headersSent || res.writableEnded) {
    return false;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  return true;
}

function sendSseEvent(res, payload) {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function randomSessionId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getTerminalCommand() {
  const binary =
    process.env.STUDIO_SHELL_BIN ||
    resolveExistingBinary([
      process.env.SHELL,
      "/bin/zsh",
      "/bin/bash",
      "/bin/sh",
    ]) ||
    "/bin/sh";
  const argsJson = process.env.STUDIO_SHELL_ARGS_JSON;
  const argsRaw = process.env.STUDIO_SHELL_ARGS;
  let parsedArgs = [];
  if (argsJson) {
    try {
      const parsed = JSON.parse(argsJson);
      if (Array.isArray(parsed)) {
        parsedArgs = parsed.map((value) => String(value));
      }
    } catch {}
  }
  if (!parsedArgs.length) {
    parsedArgs = (argsRaw || "")
      .split(" ")
      .map((value) => value.trim())
      .filter(Boolean);
  }
  const args = parsedArgs.length ? parsedArgs : ["-i"];
  const resolvedArgs = args.map((arg, index) => {
    if (
      process.env.STUDIO_SHELL_BIN &&
      index === 0 &&
      (arg.endsWith(".js") || arg.endsWith(".mjs")) &&
      !path.isAbsolute(arg)
    ) {
      return path.join(WORKSPACE_DIR, arg);
    }
    return arg;
  });
  return { command: binary, args: resolvedArgs };
}

function resolveExistingBinary(candidates = []) {
  for (const candidate of candidates) {
    if (candidate && candidate.includes("/") && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return "";
}

function resolvePythonBinary() {
  return (
    resolveExistingBinary([
      process.env.STUDIO_PYTHON_BIN,
      process.env.PYTHON,
      "/usr/local/bin/python3",
      "/opt/homebrew/bin/python3",
      "/usr/bin/python3",
    ]) || "python3"
  );
}

function normalizeTerminalSize(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, parsed);
}

function getCursorCommand() {
  const configuredBinary = process.env.STUDIO_CURSOR_BIN || process.env.CURSOR_CLI_BIN;
  return resolveCursorLaunchSpec(configuredBinary);
}

/** Same defaults as crew-lead / gateway `runCursorCliTask` (not the IDE `cursor` opener). */
function resolveStudioCursorModel(bodyModel) {
  const cursorDefault =
    process.env.CREWSWARM_CURSOR_MODEL ||
    process.env.CURSOR_DEFAULT_MODEL ||
    "composer-2-fast";
  let m =
    (bodyModel && String(bodyModel).trim()) ||
    process.env.STUDIO_CURSOR_MODEL ||
    cursorDefault;
  if (String(m).includes("/")) m = cursorDefault;
  else if (String(m).includes("sonnet-4.6")) m = "sonnet-4.5";
  return m;
}

function createCursorStreamRelay(onChunk, onTerminal) {
  let transcript = "";
  let lineBuffer = "";
  let sawAssistantDelta = false;
  let lastAssistantNorm = "";

  const appendText = (text) => {
    if (!text) return;
    transcript += text;
    onChunk?.(text);
  };

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const event = JSON.parse(trimmed);
      if (event.type === "stream_event" && event.event?.type === "content_block_delta") {
        const t = event.event.delta?.text || "";
        if (t) {
          sawAssistantDelta = true;
          appendText(t);
        }
        return;
      }
      if (event.type === "assistant") {
        const content = event.message?.content;
        let combined = "";
        if (Array.isArray(content)) {
          for (const chunk of content) {
            if (chunk?.type === "text" && chunk.text) combined += chunk.text;
          }
        } else if (typeof content === "string") {
          combined = content;
        }
        const norm = combined.replace(/\r/g, "").trim();
        if (norm && norm === lastAssistantNorm) {
          return;
        }
        if (norm) lastAssistantNorm = norm;
        if (!sawAssistantDelta && combined) {
          if (Array.isArray(content)) {
            for (const chunk of content) {
              if (chunk?.type === "text" && chunk.text) appendText(chunk.text);
            }
          } else {
            appendText(combined);
          }
        }
        return;
      }

      if (event.type === "result") {
        if (!transcript.trim() && (event.result || event.text)) {
          appendText(String(event.result || event.text || ""));
        }
        onTerminal?.();
        return;
      }

      if (event.type === "error") {
        appendText(`${event.message || trimmed}\n`);
        return;
      }
    } catch {
      appendText(`${line}\n`);
    }
  };

  return {
    push(chunk) {
      lineBuffer += chunk.toString("utf8");
      while (lineBuffer.includes("\n")) {
        const newlineIndex = lineBuffer.indexOf("\n");
        const line = lineBuffer.slice(0, newlineIndex);
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        handleLine(line);
      }
    },
    finish() {
      if (lineBuffer.trim()) {
        handleLine(lineBuffer);
        lineBuffer = "";
      }
      return transcript.trim();
    },
  };
}

function stripAnsi(text) {
  return String(text || "").replace(/\u001B\[[0-9;]*[A-Za-z]/g, "");
}

function appendNormalizedChunk(current, next) {
  const incoming = String(next || "").replace(/\r/g, "").trimEnd();
  if (!incoming) return current;
  return current ? `${current}\n${incoming}` : incoming;
}

function summarizeCliFailure(engine, rawTranscript) {
  const lines = stripAnsi(rawTranscript)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const candidates = lines.filter((line) =>
    /error|failed|fatal|transport channel closed|handshaking/i.test(line),
  );

  const selected = (candidates.length > 0 ? candidates : lines).slice(-3);
  if (selected.length === 0) {
    return `${engine} exited without producing a response.`;
  }
  return selected.join("\n");
}

function createCodexStreamRelay(onChunk) {
  let transcript = "";
  let rawTranscript = "";
  let lineBuffer = "";
  let collectingAssistant = false;
  let stopCollection = false;

  const appendAssistant = (text) => {
    const normalized = String(text || "").replace(/\r/g, "").trimEnd();
    if (!normalized) return;
    transcript = appendNormalizedChunk(transcript, normalized);
    onChunk?.(`${normalized}\n`);
  };

  const isNoiseLine = (line) => {
    const trimmed = line.trim();
    return (
      !trimmed ||
      trimmed === "--------" ||
      trimmed === "user" ||
      trimmed.startsWith("mcp:") ||
      trimmed.startsWith("OpenAI Codex ") ||
      trimmed.startsWith("workdir:") ||
      trimmed.startsWith("model:") ||
      trimmed.startsWith("provider:") ||
      trimmed.startsWith("approval:") ||
      trimmed.startsWith("sandbox:") ||
      trimmed.startsWith("reasoning effort:") ||
      trimmed.startsWith("reasoning summaries:") ||
      trimmed.startsWith("session id:") ||
      /^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*\b(ERROR|WARN|INFO)\b/.test(trimmed) ||
      /rmcp::/i.test(trimmed) ||
      /ERROR rmcp::transport::worker/.test(trimmed) ||
      /mcp startup: failed/.test(trimmed) ||
      (/\/mcp/i.test(trimmed) &&
        /127\.0\.0\.1:\d+|localhost:\d+/i.test(trimmed) &&
        /Connection refused|ConnectError|Transport channel closed|tcp connect error/i.test(
          trimmed,
        ))
    );
  };

  const handleLine = (line) => {
    const cleaned = stripAnsi(line).replace(/\r/g, "");
    rawTranscript = appendNormalizedChunk(rawTranscript, cleaned);
    const trimmed = cleaned.trim();
    if (!trimmed) return;

    if (/^tokens used$/i.test(trimmed)) {
      stopCollection = true;
      collectingAssistant = false;
      return;
    }

    if (trimmed === "codex") {
      collectingAssistant = true;
      stopCollection = false;
      return;
    }

    if (stopCollection || isNoiseLine(trimmed)) {
      return;
    }

    if (collectingAssistant) {
      appendAssistant(trimmed);
    }
  };

  return {
    push(chunk) {
      lineBuffer += chunk.toString("utf8");
      while (lineBuffer.includes("\n")) {
        const newlineIndex = lineBuffer.indexOf("\n");
        const line = lineBuffer.slice(0, newlineIndex);
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        handleLine(line);
      }
    },
    finish() {
      if (lineBuffer.trim()) {
        handleLine(lineBuffer);
        lineBuffer = "";
      }
      return transcript.trim() || summarizeCliFailure("codex", rawTranscript);
    },
  };
}

function createCrewCliStreamRelay(onChunk) {
  // Buffer ALL output — don't stream anything until we can extract the response.
  // crew-cli emits logs + a JSON envelope; we only want the response field.
  let rawOutput = "";

  return {
    push(chunk) {
      rawOutput += chunk.toString("utf8");
    },
    finish() {
      const cleaned = stripAnsi(rawOutput).replace(/\r/g, "");

      // Strategy 1: Find JSON envelope with "response" field
      const jsonMatch = cleaned.match(/\{[\s\S]*"kind":\s*"[^"]+\.result"[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.response) {
            onChunk?.(parsed.response);
            return parsed.response;
          }
        } catch { /* fall through to other strategies */ }
      }

      // Strategy 2: Extract "response" field via regex (handles malformed JSON)
      const respMatch = cleaned.match(/"response":\s*"((?:[^"\\]|\\.)*)"/);
      if (respMatch) {
        const response = respMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\t/g, "\t");
        onChunk?.(response);
        return response;
      }

      // Strategy 3: Legacy "--- Agent Response ---" marker
      const markerIdx = cleaned.indexOf("--- Agent Response ---");
      if (markerIdx >= 0) {
        let response = cleaned.slice(markerIdx + "--- Agent Response ---".length);
        const timelineIdx = response.indexOf("Pipeline timeline:");
        if (timelineIdx >= 0) response = response.slice(0, timelineIdx);
        response = response.trim();
        if (response) {
          onChunk?.(response);
          return response;
        }
      }

      // Fallback: send raw output (stripped of common log prefixes)
      const fallback = summarizeCliFailure("crew-cli", cleaned);
      onChunk?.(fallback);
      return fallback;
    },
  };
}

function createGeminiStreamRelay(onChunk, onDone) {
  let transcript = "";
  let rawTranscript = "";
  let lineBuffer = "";

  const appendAssistant = (text) => {
    const normalized = String(text || "").replace(/\r/g, "").trimEnd();
    if (!normalized) return;
    transcript = appendNormalizedChunk(transcript, normalized);
    onChunk?.(`${normalized}\n`);
  };

  const handleLine = (line) => {
    const cleaned = stripAnsi(line).replace(/\r/g, "");
    rawTranscript = appendNormalizedChunk(rawTranscript, cleaned);
    const trimmed = cleaned.trim();
    if (!trimmed) return;

    try {
      const event = JSON.parse(trimmed);
      if (event.type === "message" && event.role === "assistant" && event.content) {
        appendAssistant(event.content);
        return;
      }
      if (event.type === "result") {
        onDone?.();
        return;
      }
      if (event.type === "error") {
        appendAssistant(event.message || trimmed);
        return;
      }
    } catch {
      // Fall through so plain-text stderr still surfaces.
    }

    if (!trimmed.startsWith("{")) {
      if (shouldSkipGeminiPassthroughLine(trimmed)) return;
      appendAssistant(trimmed);
    }
  };

  return {
    push(chunk) {
      lineBuffer += chunk.toString("utf8");
      while (lineBuffer.includes("\n")) {
        const newlineIndex = lineBuffer.indexOf("\n");
        const line = lineBuffer.slice(0, newlineIndex);
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        handleLine(line);
      }
    },
    finish() {
      if (lineBuffer.trim()) {
        handleLine(lineBuffer);
        lineBuffer = "";
      }
      return transcript.trim() || summarizeCliFailure("gemini", rawTranscript);
    },
  };
}

function createDefaultCliRelay(onChunk) {
  let transcript = "";

  return {
    push(chunk) {
      const text = chunk.toString("utf8");
      transcript += text;
      onChunk?.(text);
    },
    finish() {
      return transcript.trim();
    },
  };
}

function createClaudeStreamRelay(onChunk) {
  let buffer = "";
  let transcript = "";

  return {
    push(chunk) {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const ev = JSON.parse(trimmed);
          // Stream events with text deltas
          if (ev.type === "stream_event") {
            const inner = ev.event;
            if (inner?.type === "content_block_delta" && inner?.delta?.type === "text_delta") {
              const text = inner.delta.text || "";
              transcript += text;
              onChunk?.(text);
            }
          }
          // Final assistant message
          if (ev.type === "assistant") {
            const content = ev.message?.content;
            if (Array.isArray(content)) {
              for (const c of content) {
                if (c.type === "text" && c.text) {
                  transcript += c.text;
                  onChunk?.(c.text);
                }
              }
            }
          }
          // Result event
          if (ev.type === "result" && ev.result) {
            if (!transcript) {
              transcript = ev.result;
              onChunk?.(ev.result);
            }
          }
        } catch { /* not JSON, skip */ }
      }
    },
    finish() {
      return transcript.trim();
    },
  };
}

function createCliRelay(engine, onChunk, onDone) {
  if (engine === "claude") {
    return createClaudeStreamRelay(onChunk);
  }
  if (engine === "cursor") {
    return createCursorStreamRelay(onChunk, onDone);
  }
  if (engine === "codex") {
    return createCodexStreamRelay(onChunk);
  }
  if (engine === "gemini") {
    return createGeminiStreamRelay(onChunk, onDone);
  }
  if (engine === "crew-cli") {
    return createCrewCliStreamRelay(onChunk);
  }
  return createDefaultCliRelay(onChunk);
}

function broadcastTerminalMessage(sessionId, payload) {
  const session = terminalSessions.get(sessionId);
  if (!session) return;
  const message = JSON.stringify(payload);
  for (const socket of session.sockets) {
    if (socket.readyState === 1) {
      socket.send(message);
    }
  }
}

export function createTerminalSession({ projectDir, onData, onExit, cols, rows }) {
  const cwd = resolveStudioProjectPath(projectDir, WORKSPACE_DIR);
  if (!isWithinAllowedRoots(cwd)) {
    throw new Error("projectDir is outside configured project roots");
  }
  if (!fs.existsSync(PTY_HOST)) {
    throw new Error(`terminal host missing at ${PTY_HOST}`);
  }

  const sessionId = randomSessionId("terminal");
  const { command, args } = getTerminalCommand();
  const pythonBin = resolvePythonBinary();
  const initialCols = normalizeTerminalSize(cols, 120);
  const initialRows = normalizeTerminalSize(rows, 32);
  const child = spawn(pythonBin, [PTY_HOST, cwd, command, ...args], {
    cwd,
    env: {
      ...process.env,
      TERM: process.env.TERM || "xterm-256color",
      FORCE_COLOR: "0",
      HISTFILE: process.env.HISTFILE || "/dev/null",
      // Avoid macOS zsh session persistence writes in sandboxed terminals.
      SHELL_SESSIONS_DISABLE: process.env.SHELL_SESSIONS_DISABLE || "1",
      STUDIO_TERM_COLS: String(initialCols),
      STUDIO_TERM_ROWS: String(initialRows),
    },
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  const session = {
    id: sessionId,
    child,
    control: child.stdio[3],
    cwd,
    cols: initialCols,
    rows: initialRows,
    sockets: new Set(),
  };
  terminalSessions.set(sessionId, session);

  const relay = (chunk) => {
    onData?.(chunk.toString("utf8"));
    broadcastTerminalMessage(sessionId, {
      type: "output",
      data: chunk.toString("utf8"),
    });
  };

  child.stdout.on("data", relay);
  child.stderr.on("data", relay);
  child.on("error", (error) => {
    broadcastTerminalMessage(sessionId, { type: "error", message: error.message });
  });
  child.on("close", (exitCode) => {
    const normalizedExitCode = Number(exitCode ?? 0);
    onExit?.(normalizedExitCode);
    broadcastTerminalMessage(sessionId, { type: "exit", exitCode: normalizedExitCode });
    for (const socket of session.sockets) {
      socket.close();
    }
    terminalSessions.delete(sessionId);
  });

  return { sessionId, cwd };
}

export function writeTerminalSession(sessionId, data) {
  const session = terminalSessions.get(sessionId);
  if (!session) {
    throw new Error("terminal session not found");
  }
  session.child.stdin.write(data);
}

export function resizeTerminalSession(sessionId, cols, rows) {
  const session = terminalSessions.get(sessionId);
  if (!session) {
    throw new Error("terminal session not found");
  }
  const nextCols = normalizeTerminalSize(cols, session.cols || 120);
  const nextRows = normalizeTerminalSize(rows, session.rows || 32);
  session.cols = nextCols;
  session.rows = nextRows;
  session.control?.write(`${JSON.stringify({ type: "resize", cols: nextCols, rows: nextRows })}\n`);
}

export function closeTerminalSession(sessionId) {
  const session = terminalSessions.get(sessionId);
  if (!session) return false;
  session.control?.write(`${JSON.stringify({ type: "close" })}\n`);
  session.child.kill("SIGTERM");
  return true;
}

const SUPPORTED_ENGINES = ["codex", "claude", "cursor", "gemini", "opencode", "crew-cli"];

export function getCliCommand(engine, projectDir, message, modelOverride, resumeSession) {
  switch (engine) {
    case "codex": {
      const binary = process.env.STUDIO_CODEX_BIN || "codex";
      const model = modelOverride || process.env.CREWSWARM_CODEX_MODEL || "";
      const prefixArgs = (process.env.STUDIO_CODEX_BIN_ARGS || "")
        .split(" ")
        .map((value) => value.trim())
        .filter(Boolean);
      const resolvedPrefixArgs = prefixArgs.map((arg, index) => {
        if (
          index === 0 &&
          (arg.endsWith(".js") || arg.endsWith(".mjs")) &&
          !path.isAbsolute(arg)
        ) {
          return path.join(WORKSPACE_DIR, arg);
        }
        return arg;
      });
      if (process.env.STUDIO_CODEX_BIN) {
        return { command: binary, args: [...resolvedPrefixArgs, projectDir, message], stdin: null };
      }
      const codexArgs = ["-a", "never", "exec", "--sandbox", "danger-full-access", "--skip-git-repo-check", "--color", "never", ...(model ? ["--model", model] : []), "-C", projectDir];
      // Resume: codex supports --conversation-id for session continuity
      if (resumeSession?.conversationId) codexArgs.push("--conversation-id", resumeSession.conversationId);
      codexArgs.push(message);
      return {
        command: binary,
        args: codexArgs,
        stdin: null,
      };
    }
    case "claude":
      // Claude Code uses OAuth — no API key needed
      {
        const args = ["-p", "--setting-sources", "user", "--output-format", "stream-json", "--verbose"];
        const model = modelOverride || process.env.CREWSWARM_CLAUDE_CODE_MODEL || "";
        // Add workspace directory context
        if (projectDir) args.push("--add-dir", projectDir);
        if (model) args.push("--model", model);
        // Resume: claude supports --resume <sessionId> for conversation continuity
        if (resumeSession?.sessionId) args.push("--resume", resumeSession.sessionId);
        args.push(message);
        return {
          command: "claude",
          args,
          stdin: null,
          stripEnv: ["CLAUDECODE", "CLAUDE_CODE"],
        };
      }
    case "cursor":
      {
        const cursorSpec = getCursorCommand();
        const cwd = projectDir || WORKSPACE_DIR;
        const model = resolveStudioCursorModel(modelOverride);
        const args = [
          ...cursorSpec.argsPrefix,
          "-p",
          "--force",
          "--trust",
          "--output-format",
          "stream-json",
          "--stream-partial-output",
          message,
          "--model",
          model,
          "--workspace",
          cwd,
        ];
        // Resume: cursor supports --thread-id for session continuity
        if (resumeSession?.sessionId) args.push("--thread-id", resumeSession.sessionId);
        return {
          command: cursorSpec.bin,
          args,
          stdin: null,
        };
      }
    case "gemini":
      {
        const args = ["-p", message, "--output-format", "stream-json", "--yolo"];
        const model = modelOverride || process.env.CREWSWARM_GEMINI_CLI_MODEL || "";
        if (model) args.push("-m", model);
        // Add workspace directory to allow file operations in projectDir (gemini uses --include-directories)
        if (projectDir) args.push("--include-directories", projectDir);
        // Resume: gemini supports --session for conversation continuity
        if (resumeSession?.sessionId) args.push("--session", resumeSession.sessionId);
        return {
          command: "gemini",
          args,
          stdin: null,
        };
      }
    case "opencode":
      {
        let model = modelOverride || process.env.OPENCODE_MODEL || process.env.CREWSWARM_OPENCODE_MODEL || "";
        if (!model) {
          try {
            const cfgPath = path.join(os.homedir(), ".crewswarm", "crewswarm.json");
            const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
            model = cfg.opencodeModel || "";
          } catch {}
        }
        if (!model) model = "opencode/gpt-5.2";
        const args = ["run", "-m", model, message];
        // Add workspace directory context
        if (projectDir) args.push("--dir", projectDir);
        // Resume: opencode supports --session for conversation continuity
        if (resumeSession?.sessionId) args.push("--session", resumeSession.sessionId);
        return {
          command: "opencode",
          args,
          stdin: null,
        };
      }
    case "crew-cli": {
      const crewBin = path.join(__dirname, "..", "..", "crew-cli", "bin", "crew.js");
      const model = modelOverride || process.env.CREWSWARM_CREW_CLI_MODEL || "";
      const crewArgs = [crewBin, "chat", message, "--apply", ...(projectDir ? ["--project", projectDir] : []), ...(model ? ["--model", model] : [])];
      // Resume: crew-cli supports --session for conversation continuity
      if (resumeSession?.sessionId) crewArgs.push("--session", resumeSession.sessionId);
      return {
        command: "node",
        args: crewArgs,
        stdin: null,
      };
    }
    default:
      return null;
  }
}

// Backward compat alias
export function getCodexCommand(projectDir, message) {
  return getCliCommand("codex", projectDir, message, undefined);
}

export function getCliResumeKey(engine, projectDir) {
  return `${engine}:${projectDir || "default"}`;
}

export function runCli({
  projectDir,
  projectId,
  engine,
  message,
  onChunk,
  onTrace,
  model,
  resume = true,
}) {
  return new Promise((resolve, reject) => {
    // Look up existing session for resume
    const resumeKey = getCliResumeKey(engine, projectDir);
    const resumeSession = resume ? cliResumeSessions.get(resumeKey) : undefined;
    const cmd = getCliCommand(engine, projectDir, message, model, resumeSession);
    if (!cmd) {
      reject(new Error(`Unknown engine "${engine}". Supported: ${SUPPORTED_ENGINES.join(", ")}`));
      return;
    }

    const childEnv = { ...process.env, FORCE_COLOR: "0" };
    // Strip env vars that block nested CLI sessions (e.g. CLAUDECODE)
    if (cmd.stripEnv) {
      for (const key of cmd.stripEnv) {
        delete childEnv[key];
      }
    }

    const child = spawn(cmd.command, cmd.args, {
      cwd: projectDir,
      env: childEnv,
    });

    // Pipe stdin for CLIs that read prompt from stdin (claude, cursor)
    if (cmd.stdin) {
      child.stdin.write(cmd.stdin);
      child.stdin.end();
    } else {
      // Close stdin so CLIs like opencode don't hang waiting for input
      child.stdin.end();
    }

    let transcript = "";
    let extractedSessionId = null;
    let extractedConversationId = null;
    const relay = createCliRelay(engine, onChunk, () => {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    });
    const SESSION_ID_RE = /session[ _-]?id:\s*(.+)/i;
    const CONVERSATION_ID_RE = /conversation[ _-]?id:\s*(.+)/i;
    const handleOutput = (chunk) => {
      const text = chunk.toString("utf8");
      onTrace?.(text);
      relay.push(chunk);
      // Extract session/conversation IDs from CLI output for resume
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        const sMatch = SESSION_ID_RE.exec(trimmed);
        if (sMatch) extractedSessionId = sMatch[1].trim();
        const cMatch = CONVERSATION_ID_RE.exec(trimmed);
        if (cMatch) extractedConversationId = cMatch[1].trim();
      }
    };
    child.stdout.on("data", handleOutput);
    child.stderr.on("data", handleOutput);
    child.on("close", (exitCode) => {
      const normalizedExitCode = Number(exitCode ?? 0);
      transcript = relay.finish();
      // Store session ID for resume on subsequent calls
      if (extractedSessionId || extractedConversationId) {
        cliResumeSessions.set(resumeKey, {
          sessionId: extractedSessionId,
          conversationId: extractedConversationId,
          engine,
          ts: Date.now(),
        });
      }
      // Cursor agent often exits non-zero after we SIGTERM following a `result` event; treat as OK if we got text.
      const effectiveExit =
        engine === "cursor" && transcript.trim()
          ? 0
          : normalizedExitCode;
      appendProjectMessage(projectId, {
        role: "assistant",
        content: transcript.trim(),
        ts: Date.now(),
        source: "studio-cli",
        metadata: { engine, exitCode: effectiveExit },
      });
      resolve({ exitCode: effectiveExit, transcript: transcript.trim() });
    });

    child.on("error", reject);
  });
}

// Backward compat alias
export function runCodexCli(opts) {
  return runCli(opts);
}

function handleCliChatLocally(req, res, body) {
  let message = String(body.message || "").trim();
  const projectDir = resolveStudioProjectPath(body.projectDir, WORKSPACE_DIR);
  const projectId = body.projectId || DEFAULT_PROJECT_ID;
  const engine = body.engine || "";

  // Inject open file context from Vibe editor into the message
  if (body.activeFile) {
    const ctx = [`[Currently open file: ${body.activeFile}]`];
    if (body.selectedText) {
      ctx.push(`[Selected text (lines ${body.selectionStart || "?"}-${body.selectionEnd || "?"}):\n${body.selectedText}\n]`);
    }
    message = `${ctx.join("\n")}\n\n${message}`;
  }

  if (!message) {
    sendJson(res, 400, { error: "message is required" });
    return;
  }

  if (!SUPPORTED_ENGINES.includes(engine)) {
    sendJson(res, 400, {
      error: `Unsupported engine "${engine || "unknown"}". Supported: ${SUPPORTED_ENGINES.join(", ")}`,
    });
    return;
  }

  if (!isWithinAllowedRoots(projectDir)) {
    sendJson(res, 403, { error: "projectDir is outside configured project roots" });
    return;
  }

  appendProjectMessage(projectId, {
    role: "user",
    content: message,
    ts: Date.now(),
    source: "cli",
    metadata: { engine, agentName: "You", agentEmoji: "👤" },
  });

  if (!sendSseHeaders(res)) {
    return;
  }

  let clientClosed = false;

  runCli({
    projectDir,
    projectId,
    engine,
    message,
    model: body.model ? String(body.model) : undefined,
    onChunk(text) {
      if (!clientClosed) {
        sendSseEvent(res, { type: "chunk", text });
      }
    },
    onTrace(text) {
      if (!clientClosed) {
        sendSseEvent(res, { type: "trace", text });
      }
    },
  })
    .then(async ({ exitCode, transcript }) => {
      if (!clientClosed) {
        // Scan for files changed during CLI execution and notify frontend for diff preview
        try {
          const since = Date.now() - 120_000; // Last 2 minutes
          const { execSync } = await import("node:child_process");
          const sinceUnix = Math.floor(since / 1000);
          const changedFiles = execSync(
            `find "${projectDir}" -maxdepth 5 -type f -newermt "@${sinceUnix}" ! -path "*/node_modules/*" ! -path "*/.git/*" ! -path "*/.crew/*" 2>/dev/null | head -20`,
            { encoding: "utf8", timeout: 3000 }
          ).trim().split("\n").filter(Boolean);
          for (const filePath of changedFiles) {
            try {
              const relPath = path.relative(projectDir, filePath);
              const content = fs.readFileSync(filePath, "utf8");
              sendSseEvent(res, { type: "file-changed", path: relPath, content });
            } catch { /* binary or unreadable */ }
          }
        } catch { /* scan failed, non-fatal */ }
        sendSseEvent(res, { type: "done", exitCode, transcript });
        res.end();
      }
    })
    .catch((error) => {
      if (!clientClosed) {
        sendSseEvent(res, { type: "chunk", text: `${error.message}\n` });
        sendSseEvent(res, { type: "done", exitCode: 1 });
        res.end();
      }
      appendProjectMessage(projectId, {
        role: "assistant",
        content: error.message,
        ts: Date.now(),
        source: "studio-cli",
        metadata: { engine, exitCode: 1 },
      });
    });

  req.on("close", () => {
    clientClosed = true;
  });
}

async function handleCliChatViaCrewLead(req, res, body) {
  let message = String(body.message || "").trim();
  const projectDir = resolveStudioProjectPath(body.projectDir, WORKSPACE_DIR);

  // Inject open file context from Vibe editor into the message
  if (body.activeFile) {
    const ctx = [`[Currently open file: ${body.activeFile}]`];
    if (body.selectedText) {
      ctx.push(`[Selected text (lines ${body.selectionStart || "?"}-${body.selectionEnd || "?"}):\n${body.selectedText}\n]`);
    }
    message = `${ctx.join("\n")}\n\n${message}`;
  }
  const projectId = body.projectId || DEFAULT_PROJECT_ID;
  const sessionId = String(body.sessionId || "studio-cli");
  const engine = body.engine || "";
  const model = body.model ? String(body.model) : "";
  const token = loadCrewswarmRtToken();

  if (!token) {
    throw new Error("CrewSwarm RT auth token unavailable");
  }

  const upstream = await fetch("http://127.0.0.1:5010/api/engine-passthrough", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      engine,
      message,
      projectDir,
      projectId,
      sessionId,
      ...(model ? { model } : {}),
    }),
    // Align with Vibe client CHAT_STREAM_TIMEOUT_MS (10m) — 240s was aborting long Codex/OpenCode runs
    signal: AbortSignal.timeout(
      Number(process.env.STUDIO_CREW_LEAD_FETCH_MS || "600000"),
    ),
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    throw new Error(text || `crew-lead passthrough failed (${upstream.status})`);
  }

  appendProjectMessage(projectId, {
    role: "user",
    content: message,
    ts: Date.now(),
    source: "cli",
    metadata: { engine, agentName: "You", agentEmoji: "👤" },
  });

  if (!sendSseHeaders(res)) {
    throw new Error("SSE response already started");
  }

  let clientClosed = false;
  let sseBuffer = "";
  let transcript = "";
  let stderrText = "";
  let exitCode = 1;

  const reader = upstream.body.getReader();
  req.on("close", () => {
    clientClosed = true;
    reader.cancel().catch(() => {});
  });

  const parseEventPayload = (rawEvent) => {
    const dataLines = rawEvent
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!dataLines) return null;
    try {
      return JSON.parse(dataLines);
    } catch {
      return null;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = Buffer.from(value).toString("utf8");
    if (!clientClosed) {
      res.write(text);
    }
    sseBuffer += text;

    while (sseBuffer.includes("\n\n")) {
      const boundary = sseBuffer.indexOf("\n\n");
      const rawEvent = sseBuffer.slice(0, boundary);
      sseBuffer = sseBuffer.slice(boundary + 2);
      const payload = parseEventPayload(rawEvent);
      if (!payload) continue;
      if (payload.type === "chunk" && payload.text) {
        transcript += payload.text;
      } else if (payload.type === "stderr" && payload.text) {
        stderrText += payload.text;
      } else if (payload.type === "done") {
        exitCode = Number(payload.exitCode ?? 0);
      }
    }
  }

  appendProjectMessage(projectId, {
    role: "assistant",
    content: (transcript || stderrText || "(no output)").trim(),
    ts: Date.now(),
    source: "cli",
    agent: engine,
    metadata: { engine, exitCode, agentName: engine, agentEmoji: "⚡" },
  });

  if (!clientClosed) {
    res.end();
  }
}

function handleCliChat(req, res, body) {
  handleCliChatViaCrewLead(req, res, body).catch((error) => {
    if (!res.headersSent && !res.writableEnded) {
      console.warn(`[studio] crew-lead passthrough unavailable, falling back local: ${error.message}`);
      handleCliChatLocally(req, res, body);
      return;
    }
    console.warn(`[studio] crew-lead stream failed after response start: ${error.message}`);
    if (!res.writableEnded) {
      sendSseEvent(res, { type: "trace", text: `crew-lead stream interrupted: ${error.message}` });
      sendSseEvent(res, { type: "done", exitCode: 1 });
      res.end();
    }
  });
}

/** Dashboard HTTP API (crew-lead proxy, agents list, token). Override if dashboard is not on :4319. */
const DASHBOARD_PROXY_TARGET = String(
  process.env.CREWSWARM_DASHBOARD_URL || "http://127.0.0.1:4319",
).replace(/\/$/, "");

async function readRequestBuffer(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
}

/**
 * Server-side forward to the dashboard so the browser stays same-origin (e.g. localhost:3333).
 * Avoids CORS when :4319 responds with Access-Control-Allow-Origin: http://localhost:4319 or when
 * the page is http://localhost:3333 but fetch targets http://127.0.0.1:4319.
 */
async function proxyRequestToDashboard(req, res, pathWithQuery) {
  const targetUrl = `${DASHBOARD_PROXY_TARGET}${pathWithQuery}`;
  const headers = {};
  for (const name of ["content-type", "authorization", "accept"]) {
    const v = req.headers[name];
    if (v) headers[name] = v;
  }
  const init = {
    method: req.method,
    headers,
    signal: AbortSignal.timeout(660000),
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await readRequestBuffer(req);
  }
  let upstream;
  try {
    upstream = await fetch(targetUrl, init);
  } catch (err) {
    console.warn("[vibe] dashboard proxy fetch failed:", err?.message || err);
    sendJson(res, 502, {
      ok: false,
      error: `dashboard unreachable (${DASHBOARD_PROXY_TARGET}): ${err?.message || err}`,
    });
    return;
  }
  if (!upstream.ok) {
    const txt = await upstream.text().catch(() => "");
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/json",
    });
    res.end(txt || JSON.stringify({ ok: false, error: String(upstream.status) }));
    return;
  }
  const ct = upstream.headers.get("content-type") || "";
  const out = {
    "content-type": ct || "application/octet-stream",
    "cache-control": upstream.headers.get("cache-control") || "no-cache",
  };
  if (ct.includes("text/event-stream")) {
    out.connection = "keep-alive";
  }
  res.writeHead(upstream.status, out);
  if (!upstream.body) {
    res.end();
    return;
  }
  const reader = upstream.body.getReader();
  req.on("close", () => reader.cancel().catch(() => {}));
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.byteLength) res.write(Buffer.from(value));
    }
  } catch (err) {
    console.warn("[vibe] dashboard proxy stream:", err?.message || err);
  } finally {
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
}

export function createOrUpdateProject(body) {
  const name = String(body.name || "").trim();
  const outputDirRaw = String(body.outputDir || "").trim();
  const description = String(body.description || "").trim();

  if (!name) {
    return { status: 400, payload: { error: "name is required" } };
  }

  if (!outputDirRaw) {
    return { status: 400, payload: { error: "outputDir is required" } };
  }

  const outputDir = resolveStudioProjectPath(outputDirRaw);
  fs.mkdirSync(outputDir, { recursive: true });
  const roadmapFile = path.join(outputDir, "ROADMAP.md");

  const projects = readProjects();
  const existing = projects.find((project) => path.resolve(project.outputDir) === outputDir);
  const id = existing?.id || slugify(name) || `project-${Date.now()}`;
  const project = {
    ...(existing || {}),
    id,
    name,
    outputDir,
    description,
    roadmapFile: existing?.roadmapFile || roadmapFile,
    featuresDoc: existing?.featuresDoc || "",
    tags: Array.isArray(existing?.tags) ? existing.tags : [],
    created: existing?.created || new Date().toISOString(),
    status: existing?.status || "active",
  };
  const nextProjects = existing
    ? projects.map((entry) => (entry.id === existing.id ? project : entry))
    : [...projects, project];

  writeProjects(nextProjects);
  invalidateWorkspaceScanCache(outputDir);
  return { status: 200, payload: { ok: true, project } };
}

export const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url || "/", "http://127.0.0.1");

  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  const dashboardProxyPath = parsedUrl.pathname + (parsedUrl.search || "");
  if (parsedUrl.pathname === "/api/chat/unified" && req.method === "POST") {
    await proxyRequestToDashboard(req, res, dashboardProxyPath);
    return;
  }
  if (parsedUrl.pathname === "/api/version" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      version: PKG_VERSION,
      uptime: Math.floor((Date.now() - SERVER_START) / 1000),
      uptimeHuman: `${Math.floor((Date.now() - SERVER_START) / 3600000)}h ${Math.floor(((Date.now() - SERVER_START) % 3600000) / 60000)}m`,
    }));
    return;
  }
  if (parsedUrl.pathname === "/api/auth/token" && req.method === "GET") {
    await proxyRequestToDashboard(req, res, dashboardProxyPath);
    return;
  }
  if (parsedUrl.pathname === "/api/agents" && req.method === "GET") {
    await proxyRequestToDashboard(req, res, dashboardProxyPath);
    return;
  }

  // CLI session resume management
  if (parsedUrl.pathname === "/api/studio/sessions" && req.method === "GET") {
    const sessions = {};
    for (const [key, val] of cliResumeSessions) sessions[key] = val;
    sendJson(res, 200, { sessions });
    return;
  }
  if (parsedUrl.pathname === "/api/studio/sessions" && req.method === "DELETE") {
    const engine = parsedUrl.searchParams.get("engine");
    if (engine) {
      for (const key of cliResumeSessions.keys()) {
        if (key.startsWith(`${engine}:`)) cliResumeSessions.delete(key);
      }
    } else {
      cliResumeSessions.clear();
    }
    sendJson(res, 200, { ok: true, cleared: engine || "all" });
    return;
  }

  if (parsedUrl.pathname === "/api/studio/projects" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      projects: readProjects(),
    });
    return;
  }

  if (parsedUrl.pathname === "/api/studio/projects" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const { status, payload } = createOrUpdateProject(body);
      sendJson(res, status, payload);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (parsedUrl.pathname === "/api/studio/active-project") {
    if (req.method === "GET") {
      const uiState = readUiState();
      sendJson(res, 200, {
        ok: true,
        projectId: String(uiState.chatActiveProjectId || "general"),
      });
      return;
    }
    if (req.method === "POST") {
      try {
        const body = await readBody(req);
        const normalizedProjectId =
          body?.projectId && String(body.projectId).trim()
            ? String(body.projectId).trim()
            : "general";
        const uiState = readUiState();
        uiState.chatActiveProjectId = normalizedProjectId;
        writeUiState(uiState);
        sendJson(res, 200, { ok: true, projectId: normalizedProjectId });
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return;
    }
  }

  if (parsedUrl.pathname === "/api/studio/files" && req.method === "GET") {
    const requestedDir = parsedUrl.searchParams.get("dir");
    const scanDir = requestedDir
      ? resolveStudioProjectPath(requestedDir, WORKSPACE_DIR)
      : WORKSPACE_DIR;
    if (!isWithinAllowedRoots(scanDir)) {
      sendJson(res, 403, { error: "path outside configured project roots" });
      return;
    }

    sendJson(res, 200, { files: listWorkspaceFiles(scanDir) });
    return;
  }

  if (parsedUrl.pathname === "/api/studio/file-content" && req.method === "GET") {
    const filePath = parsedUrl.searchParams.get("path") || "";
    const resolvedPath = resolveStudioProjectPath(filePath, "");
    if (!filePath || !isWithinAllowedRoots(resolvedPath)) {
      sendJson(res, 400, { error: "invalid path" });
      return;
    }

    try {
      const raw = fs.readFileSync(resolvedPath, "utf8");
      sendJson(res, 200, { content: raw, lines: raw.split("\n").length });
    } catch (error) {
      sendJson(res, 404, { error: error.message });
    }
    return;
  }

  if (parsedUrl.pathname === "/api/studio/file-content" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const resolvedPath = resolveStudioProjectPath(String(body.path || ""), "");
      const content = typeof body.content === "string" ? body.content : "";
      if (!resolvedPath || !isWithinAllowedRoots(resolvedPath)) {
        sendJson(res, 400, { error: "invalid path" });
        return;
      }

      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
      fs.writeFileSync(resolvedPath, content);
      invalidateWorkspaceScanCache(resolvedPath);
      const stat = fs.statSync(resolvedPath);
      sendJson(res, 200, { ok: true, path: resolvedPath, size: stat.size });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (parsedUrl.pathname === "/api/studio/project-messages" && req.method === "GET") {
    sendJson(res, 200, {
      messages: readProjectMessages(
        parsedUrl.searchParams.get("projectId") || DEFAULT_PROJECT_ID,
        parsedUrl.searchParams.get("limit") || "50",
      ),
    });
    return;
  }


  if (parsedUrl.pathname === "/api/studio/engines" && req.method === "GET") {
    sendJson(res, 200, { engines: SUPPORTED_ENGINES });
    return;
  }

  if (parsedUrl.pathname === "/api/studio/clear-cli-session" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const token = loadCrewswarmRtToken();
      const upstream = await fetch("http://127.0.0.1:5010/api/engine-passthrough/clear-session", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await upstream.json();
      sendJson(res, upstream.status, data);
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // GET /api/studio/git-diff — return changed files with old/new content for diff preview
  if (parsedUrl.pathname === "/api/studio/git-diff" && req.method === "GET") {
    const projDir = parsedUrl.searchParams.get("projectDir") || WORKSPACE_DIR;
    const resolved = resolveStudioProjectPath(projDir, WORKSPACE_DIR);
    try {
      const { execSync } = await import("node:child_process");
      const hasGit = fs.existsSync(path.join(resolved, ".git"));
      if (!hasGit) {
        sendJson(res, 200, { ok: true, files: [], message: "Not a git repository" });
        return;
      }
      const filesRaw = execSync("git diff --name-only", { cwd: resolved, encoding: "utf8", timeout: 3000 }).trim();
      const files = filesRaw ? filesRaw.split("\n").filter(Boolean) : [];
      // For each changed file, get old (HEAD) and new (working tree) content
      const changes = [];
      for (const f of files.slice(0, 20)) {
        try {
          let oldContent = "";
          try { oldContent = execSync(`git show HEAD:${f}`, { cwd: resolved, encoding: "utf8", timeout: 3000 }); } catch { /* new file */ }
          const newContent = fs.readFileSync(path.join(resolved, f), "utf8");
          changes.push({ path: f, oldContent, newContent });
        } catch { /* skip unreadable */ }
      }
      sendJson(res, 200, { ok: true, files, changes });
    } catch (e) {
      sendJson(res, 200, { ok: true, files: [], changes: [], error: e.message });
    }
    return;
  }

  if (parsedUrl.pathname === "/api/studio/chat/unified" && req.method === "POST") {
    try {
      const body = await readBody(req);
      if (body.mode !== "cli") {
        sendJson(res, 400, {
          error: "Local Vibe chat only supports CLI passthrough right now",
        });
        return;
      }
      handleCliChat(req, res, body);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (parsedUrl.pathname === "/api/studio/terminal/start" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const { sessionId, cwd } = createTerminalSession({
        projectDir: String(body.projectDir || WORKSPACE_DIR),
        cols: body.cols,
        rows: body.rows,
      });
      sendJson(res, 200, { ok: true, sessionId, cwd });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (parsedUrl.pathname === "/api/studio/terminal" && req.method === "DELETE") {
    const sessionId = parsedUrl.searchParams.get("sessionId") || "";
    if (!sessionId) {
      sendJson(res, 400, { error: "sessionId is required" });
      return;
    }
    sendJson(res, 200, { ok: closeTerminalSession(sessionId) });
    return;
  }

  const filePath = resolveRequestPath(req.url);
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const { filePath: servedPath, encoding } = getEncodedAsset(
    filePath,
    req.headers["accept-encoding"] || "",
  );

  readFileWithRetry(servedPath)
    .then((content) => {
      const headers = {
        "Content-Type": contentType,
        "Cache-Control": getCacheControlHeader(filePath),
        Vary: "Accept-Encoding",
      };

      if (encoding) {
        headers["Content-Encoding"] = encoding;
      }

      res.writeHead(200, headers);
      res.end(content);
    })
    .catch((err) => {
      if (err.code === "ENOENT") {
        readFileWithRetry(path.join(DIST_DIR, "index.html"))
          .then((html) => {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(html);
          })
          .catch(() => {
            res.writeHead(500);
            res.end("Server error");
          });
        return;
      }
      res.writeHead(500);
      res.end("Server error");
    });
});

const terminalWss = new WebSocketServer({ noServer: true });

terminalWss.on("connection", (socket, request) => {
  const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
  const sessionId = requestUrl.searchParams.get("sessionId") || "";
  const session = terminalSessions.get(sessionId);

  if (!session) {
    socket.send(JSON.stringify({ type: "error", message: "terminal session not found" }));
    socket.close();
    return;
  }

  session.sockets.add(socket);
  socket.send(JSON.stringify({ type: "ready", sessionId, cwd: session.cwd }));

  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString("utf8"));
      if (message.type === "input" && typeof message.data === "string") {
        writeTerminalSession(sessionId, message.data);
        return;
      }
      if (message.type === "resize") {
        resizeTerminalSession(sessionId, message.cols, message.rows);
        return;
      }
      if (message.type === "kill") {
        closeTerminalSession(sessionId);
      }
    } catch (error) {
      socket.send(JSON.stringify({ type: "error", message: error.message }));
    }
  });

  socket.on("close", () => {
    session.sockets.delete(socket);
  });
});

server.on("upgrade", (request, socket, head) => {
  const parsedUrl = new URL(request.url || "/", "http://127.0.0.1");
  if (parsedUrl.pathname !== "/ws/studio/terminal") {
    socket.destroy();
    return;
  }

  terminalWss.handleUpgrade(request, socket, head, (ws) => {
    terminalWss.emit("connection", ws, request);
  });
});

if (process.env.STUDIO_DISABLE_LISTEN !== "1") {
  server.listen(PORT, "127.0.0.1", () => {
    ensureProjects();
    const address = server.address();
    const boundPort =
      address && typeof address === "object" ? address.port : PORT;
    console.log(`🐝 crewswarm Vibe running at http://127.0.0.1:${boundPort}`);
  });
}
