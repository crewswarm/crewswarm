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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.STUDIO_PORT || 3333);
const DIST_DIR = path.join(__dirname, "dist");
const WORKSPACE_DIR = __dirname;
const STUDIO_DATA_DIR = process.env.STUDIO_DATA_DIR
  ? path.resolve(process.env.STUDIO_DATA_DIR)
  : path.join(__dirname, ".studio-data");
const PROJECTS_FILE = path.join(STUDIO_DATA_DIR, "projects.json");
const MESSAGE_DIR = path.join(STUDIO_DATA_DIR, "project-messages");
const terminalSessions = new Map();
const PTY_HOST = path.join(__dirname, "scripts", "studio-pty-host.py");
const DEFAULT_PROJECT_ID = "studio-local";
const DEFAULT_PROJECT = {
  id: DEFAULT_PROJECT_ID,
  name: "Studio Workspace",
  outputDir: WORKSPACE_DIR,
  description: "Local Studio workspace",
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
  if (!fs.existsSync(PROJECTS_FILE)) {
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify([DEFAULT_PROJECT], null, 2));
    return [DEFAULT_PROJECT];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf8"));
    const projects = Array.isArray(parsed) ? parsed : [];
    if (projects.some((project) => project.id === DEFAULT_PROJECT_ID)) {
      return projects;
    }
    const nextProjects = [DEFAULT_PROJECT, ...projects];
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(nextProjects, null, 2));
    return nextProjects;
  } catch {
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify([DEFAULT_PROJECT], null, 2));
    return [DEFAULT_PROJECT];
  }
}

export function readProjects() {
  return ensureProjects();
}

export function writeProjects(projects) {
  ensureDataDirs();
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
  clearWorkspaceCaches();
}

function clearWorkspaceCaches() {
  workspaceScanCache.clear();
}

function getAllowedRoots() {
  const roots = new Set([WORKSPACE_DIR]);
  for (const project of readProjects()) {
    if (project?.outputDir) {
      roots.add(path.resolve(project.outputDir));
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
  return path.join(DIST_DIR, relativePath);
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
  for (const file of [
    path.join(process.env.HOME || "", ".crewswarm", "config.json"),
    path.join(process.env.HOME || "", ".crewswarm", "crewswarm.json"),
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

  const lines = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

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
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
}

function sendSseEvent(res, payload) {
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
  if (configuredBinary) {
    return configuredBinary;
  }

  const homeAgent = process.env.HOME
    ? path.join(process.env.HOME, ".local", "bin", "agent")
    : "";
  if (homeAgent && fs.existsSync(homeAgent)) {
    return homeAgent;
  }

  return "agent";
}

function createCursorStreamRelay(onChunk) {
  let transcript = "";
  let lineBuffer = "";

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
      if (event.type === "assistant") {
        const content = event.message?.content;
        if (Array.isArray(content)) {
          for (const chunk of content) {
            if (chunk?.type === "text" && chunk.text) {
              appendText(chunk.text);
            }
          }
          return;
        }
        if (typeof content === "string") {
          appendText(content);
          return;
        }
      }

      if (event.type === "result" && !transcript.trim()) {
        appendText(event.result || event.text || "");
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
      /ERROR rmcp::transport::worker/.test(trimmed) ||
      /mcp startup: failed/.test(trimmed)
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
  let transcript = "";
  let rawTranscript = "";
  let lineBuffer = "";
  let collectingAssistant = false;

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
    if (!trimmed) {
      if (collectingAssistant && transcript) {
        appendAssistant("");
      }
      return;
    }

    if (trimmed === "--- Agent Response ---") {
      collectingAssistant = true;
      return;
    }

    if (trimmed === "Pipeline timeline:") {
      collectingAssistant = false;
      return;
    }

    if (collectingAssistant) {
      appendAssistant(cleaned);
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
      return transcript.trim() || summarizeCliFailure("crew-cli", rawTranscript);
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

function createCliRelay(engine, onChunk, onDone) {
  if (engine === "cursor") {
    return createCursorStreamRelay(onChunk);
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
  const cwd = path.resolve(projectDir || WORKSPACE_DIR);
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

export function getCliCommand(engine, projectDir, message) {
  switch (engine) {
    case "codex": {
      const binary = process.env.STUDIO_CODEX_BIN || "codex";
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
      return {
        command: binary,
        args: ["-a", "never", "exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "--color", "never", "-C", projectDir, message],
        stdin: null,
      };
    }
    case "claude":
      // Claude Code uses OAuth — no API key needed
      {
        const args = ["-p", "--setting-sources", "user"];
        // Add workspace directory context
        if (projectDir) args.push("--add-dir", projectDir);
        return {
          command: "claude",
          args,
          stdin: message,
          stripEnv: ["CLAUDECODE", "CLAUDE_CODE"],
        };
      }
    case "cursor":
      {
        const binary = getCursorCommand();
        const args = ["-p", message];
        return {
          command: binary,
          args,
          stdin: null,
        };
      }
    case "gemini":
      {
        const args = ["-p", message, "--output-format", "stream-json", "--yolo"];
        // Add workspace directory to allow file operations in projectDir (gemini uses --include-directories)
        if (projectDir) args.push("--include-directories", projectDir);
        return {
          command: "gemini",
          args,
          stdin: null,
        };
      }
    case "opencode":
      {
        let model = process.env.OPENCODE_MODEL || process.env.CREWSWARM_OPENCODE_MODEL || "";
        if (!model) {
          try {
            const cfgPath = path.join(os.homedir(), ".crewswarm", "config.json");
            const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
            model = cfg.opencodeModel || "";
          } catch {}
        }
        if (!model) model = "opencode/gpt-5.2";
        const args = ["run", "-m", model, message];
        // Add workspace directory context
        if (projectDir) args.push("--dir", projectDir);
        return {
          command: "opencode",
          args,
          stdin: null,
        };
      }
    case "crew-cli": {
      const crewBin = path.join(__dirname, "..", "..", "crew-cli", "bin", "crew.js");
      return {
        command: "node",
        args: [crewBin, "chat", message],
        stdin: null,
      };
    }
    default:
      return null;
  }
}

// Backward compat alias
export function getCodexCommand(projectDir, message) {
  return getCliCommand("codex", projectDir, message);
}

export function runCli({ projectDir, projectId, engine, message, onChunk, onTrace }) {
  return new Promise((resolve, reject) => {
    const cmd = getCliCommand(engine, projectDir, message);
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
    const relay = createCliRelay(engine, onChunk, () => {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    });
    const handleOutput = (chunk) => {
      onTrace?.(chunk.toString("utf8"));
      relay.push(chunk);
    };
    child.stdout.on("data", handleOutput);
    child.stderr.on("data", handleOutput);
    child.on("close", (exitCode) => {
      const normalizedExitCode = Number(exitCode ?? 0);
      transcript = relay.finish();
      appendProjectMessage(projectId, {
        role: "assistant",
        content: transcript.trim(),
        ts: Date.now(),
        source: "studio-cli",
        metadata: { engine, exitCode: normalizedExitCode },
      });
      resolve({ exitCode: normalizedExitCode, transcript: transcript.trim() });
    });

    child.on("error", reject);
  });
}

// Backward compat alias
export function runCodexCli(opts) {
  return runCli(opts);
}

function handleCliChatLocally(req, res, body) {
  const message = String(body.message || "").trim();
  const projectDir = path.resolve(body.projectDir || WORKSPACE_DIR);
  const projectId = body.projectId || DEFAULT_PROJECT_ID;
  const engine = body.engine || "";

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
    source: "studio-cli",
    metadata: { engine },
  });

  sendSseHeaders(res);

  let clientClosed = false;

  runCli({
    projectDir,
    projectId,
    engine,
    message,
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
    .then(({ exitCode, transcript }) => {
      if (!clientClosed) {
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
  const message = String(body.message || "").trim();
  const projectDir = path.resolve(body.projectDir || WORKSPACE_DIR);
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
    signal: AbortSignal.timeout(240000),
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    throw new Error(text || `crew-lead passthrough failed (${upstream.status})`);
  }

  appendProjectMessage(projectId, {
    role: "user",
    content: message,
    ts: Date.now(),
    source: "studio-cli",
    metadata: { engine },
  });

  sendSseHeaders(res);

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
    source: "studio-cli",
    metadata: { engine, exitCode },
  });

  if (!clientClosed) {
    res.end();
  }
}

function handleCliChat(req, res, body) {
  handleCliChatViaCrewLead(req, res, body).catch((error) => {
    console.warn(`[studio] crew-lead passthrough unavailable, falling back local: ${error.message}`);
    handleCliChatLocally(req, res, body);
  });
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

  const outputDir = path.resolve(outputDirRaw);
  fs.mkdirSync(outputDir, { recursive: true });

  const projects = readProjects();
  const existing = projects.find((project) => path.resolve(project.outputDir) === outputDir);
  const id = existing?.id || slugify(name) || `project-${Date.now()}`;
  const project = { id, name, outputDir, description };
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

  if (parsedUrl.pathname === "/api/studio/files" && req.method === "GET") {
    const requestedDir = parsedUrl.searchParams.get("dir");
    const scanDir = requestedDir ? path.resolve(requestedDir) : WORKSPACE_DIR;
    if (!isWithinAllowedRoots(scanDir)) {
      sendJson(res, 403, { error: "path outside configured project roots" });
      return;
    }

    sendJson(res, 200, { files: listWorkspaceFiles(scanDir) });
    return;
  }

  if (parsedUrl.pathname === "/api/studio/file-content" && req.method === "GET") {
    const filePath = parsedUrl.searchParams.get("path") || "";
    const resolvedPath = path.resolve(filePath);
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
      const resolvedPath = path.resolve(String(body.path || ""));
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

  if (parsedUrl.pathname === "/api/studio/chat/unified" && req.method === "POST") {
    try {
      const body = await readBody(req);
      if (body.mode !== "cli") {
        sendJson(res, 400, {
          error: "Local Studio chat only supports CLI passthrough right now",
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

  fs.readFile(servedPath, (err, content) => {
    if (err) {
      if (err.code === "ENOENT") {
        fs.readFile(path.join(DIST_DIR, "index.html"), (fallbackError, html) => {
          if (fallbackError) {
            res.writeHead(500);
            res.end("Server error");
          } else {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(html);
          }
        });
      } else {
        res.writeHead(500);
        res.end("Server error");
      }
      return;
    }

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
