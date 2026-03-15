/**
 * HTTP server for crew-lead — extracted from crew-lead.mjs
 * All dependencies injected via initHttpServer().
 */

import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { executeCLI } from "../bridges/cli-executor.mjs";
import { applySharedChatPromptOverlay } from "../chat/shared-chat-prompt-overlay.mjs";
import { classifySharedChatMention } from "../chat/mention-routing-intent.mjs";
import { enrichTwitterLinks } from "../integrations/twitter-links.mjs";
import {
  getThreadBinding,
  setThreadBinding,
} from "../chat/thread-binding.mjs";

let _deps = {};

export function initHttpServer(deps) {
  _deps = deps;
}

// Helper to safely read JSON files
function tryRead(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
    "cache-control": "no-cache, no-store, must-revalidate",
    pragma: "no-cache",
    expires: "0",
  });
  res.end(body);
}

function resolveCliBinary(configured, candidates = []) {
  const all = [configured, ...candidates].filter(Boolean);
  for (const candidate of all) {
    if (candidate.includes("/") && fs.existsSync(candidate)) return candidate;
  }
  return configured;
}

function resolveNodeBinary() {
  const candidates = [
    process.env.NODE,
    "/usr/local/bin/node",
    "/opt/homebrew/bin/node",
    process.execPath,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes("/") && fs.existsSync(candidate)) return candidate;
  }
  return "node";
}

function wrapScriptBinary(bin, args) {
  if (!bin || !bin.includes("/") || !fs.existsSync(bin)) {
    return { bin, args };
  }
  try {
    const firstLine = fs.readFileSync(bin, "utf8").split("\n", 1)[0] || "";
    if (
      firstLine.startsWith("#!/usr/bin/env node") ||
      firstLine.startsWith("#!/usr/bin/env -S node")
    ) {
      return { bin: resolveNodeBinary(), args: [bin, ...args] };
    }
  } catch {}
  return { bin, args };
}

function sanitizeDirectChatReply(reply = "") {
  const cleaned = String(reply || "")
    .replace(/^@@[A-Z_]+.*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned || "Hi.";
}

const DIRECT_FANOUT_TIMEOUT_MS = Number(
  process.env.CREWSWARM_DIRECT_FANOUT_TIMEOUT_MS || 20_000,
);
const BROADCAST_ALL_TIMEOUT_MS = Number(
  process.env.CREWSWARM_BROADCAST_ALL_TIMEOUT_MS || 15_000,
);

function isBroadcastAllMode(directChatMetadata = null) {
  return !!directChatMetadata?.broadcastAll;
}

function buildBroadcastReplyInstructions() {
  return [
    "## Broadcast Status Mode",
    "- You were invoked by @crew-all broadcast.",
    "- Reply in one short line only.",
    "- Maximum 12 words.",
    "- State your status only.",
    "- Do NOT explain the system.",
    "- Do NOT ask follow-up questions.",
    "- Do NOT mention dispatch, routing, or mention behavior.",
  ].join("\n");
}

function createFanoutTimeoutError(participantId, timeoutMs) {
  const err = new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`);
  err.code = "DIRECT_FANOUT_TIMEOUT";
  err.participantId = participantId;
  err.timeoutMs = timeoutMs;
  return err;
}

async function withFanoutTimeout(task, participantId, timeoutMs) {
  let timeoutHandle = null;
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(createFanoutTimeoutError(participantId, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function filterDirectChatHistory(history = [], directChatMetadata = null) {
  const entries = Array.isArray(history) ? history : [];
  if (!directChatMetadata?.sharedChat) {
    return entries;
  }
  // Shared-room direct mentions should not inherit crew-lead assistant turns.
  // Keep user context, but drop prior assistant replies from the shared session.
  return entries.filter((entry) => entry?.role !== "assistant");
}

function buildRoutingContextLines(directChatMetadata = null) {
  const binding = directChatMetadata?.threadBinding;
  if (!binding) return [];
  const engine = binding.runtime ? ` (${binding.runtime})` : "";
  return [
    "## Routing Context",
    `- This shared-chat thread is pinned to ${binding.displayName || binding.participantId}${engine}.`,
    "- Keep continuity with prior replies and handoffs already made in this thread.",
    "- Do not deny prior actions from this same thread unless the history explicitly contradicts them.",
  ];
}

async function readBody(req, maxBytes = 1_048_576) {
  let body = "";
  let bytes = 0;
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxBytes) {
      req.destroy();
      throw Object.assign(new Error("Payload too large"), { statusCode: 413 });
    }
    body += chunk;
  }
  return JSON.parse(body);
}

// ── Session scope helpers ────────────────────────────────────────────────────

function scopeSlug(input = "default") {
  return (
    String(input)
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 80) || "default"
  );
}

function codexScopeHome(projectDir, sessionScope) {
  const projHash = crypto
    .createHash("sha1")
    .update(projectDir)
    .digest("hex")
    .slice(0, 10);
  const scope = scopeSlug(sessionScope);
  return path.join(
    projectDir,
    ".crew",
    "sessions",
    "codex",
    `${projHash}-${scope}`,
  );
}

async function pathExists(p) {
  try {
    await fs.promises.stat(p);
    return true;
  } catch {
    return false;
  }
}

function buildDirectChatContext(agent, directChatMetadata = null) {
  const { loadConfig } = _deps;
  const cfg = loadConfig();
  const agentCfg = cfg.agentRoster.find((a) => a.id === agent);
  if (!agentCfg) {
    throw new Error(`Agent ${agent} not found`);
  }

  const agentPrompts =
    tryRead(path.join(os.homedir(), ".crewswarm", "agent-prompts.json")) || {};
  const bareId = agent.replace(/^crew-/, "");
  const sysPrompt = applySharedChatPromptOverlay(
    agentPrompts[agent] || agentPrompts[bareId] || `You are ${agent}.`,
    agent,
  );
  const directChatPrompt = [
    sysPrompt,
    "## Direct Chat Mode",
    "- You are in a fast direct conversation, not execution mode.",
    "- Reply directly to the latest message in plain text.",
    "- Do NOT emit any @@ markers.",
    ...(directChatMetadata?.sharedChat
      ? [
          "- You may tag another participant with a literal @handle when an in-room handoff or follow-up is useful.",
          "- If you hand work off in shared chat, do it visibly with a plain @mention in the reply body.",
          "- Do NOT use @@DISPATCH or @@PIPELINE from direct chat mode.",
        ]
      : [
          "- Do NOT dispatch, delegate, route, or hand off.",
          "- Do NOT ask another agent to take over.",
        ]),
    "- If the message is casual, answer casually and briefly.",
    ...(isBroadcastAllMode(directChatMetadata)
      ? [buildBroadcastReplyInstructions()]
      : []),
    ...buildRoutingContextLines(directChatMetadata),
  ].join("\n\n");

  const [providerKey, ...modelParts] = agentCfg.model.split("/");
  const modelId = modelParts.join("/");
  const csSwarm =
    tryRead(path.join(os.homedir(), ".crewswarm", "crewswarm.json")) || {};
  const providers = csSwarm.providers || {};
  const provider = providers[providerKey];

  if (!provider?.apiKey) {
    throw new Error(
      `No API key for provider "${providerKey}". Check Providers in the dashboard.`,
    );
  }

  const agentConfig = {
    providerKey,
    modelId,
    provider: {
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
    },
    displayName: agent,
    emoji: agentCfg.emoji || "🤖",
    agentRoster: cfg.agentRoster || [],
    knownAgents: cfg.knownAgents || [],
    agentModels: cfg.agentModels || {},
  };

  return { agentCfg, agentConfig, directChatPrompt };
}

async function generateDirectAgentReply({
  agent,
  message,
  history = [],
  firstName,
  directChatMetadata = null,
}) {
  const { callLLM } = _deps;
  const { agentCfg, agentConfig, directChatPrompt } = buildDirectChatContext(
    agent,
    directChatMetadata,
  );
  const messages = [
    { role: "system", content: directChatPrompt },
    ...history,
    { role: "user", content: message, name: firstName || "User" },
  ];
  const llmResult = await callLLM(messages, agentConfig);
  const reply = sanitizeDirectChatReply(llmResult.reply || llmResult);

  return { reply, agentCfg };
}

async function runDirectAgentChat({
  agent,
  message,
  sessionId,
  firstName,
  projectId = null,
  projectDir = null,
  historyUserId = "bridge",
  messageSource = "dashboard",
  threadId = null,
  parentId = null,
  directChatMetadata = null,
}) {
  const { loadHistory, appendHistory } = _deps;
  const history = loadHistory(
    historyUserId,
    sessionId || "default",
    projectId || null,
  );
  const cleanHistory = filterDirectChatHistory(
    history,
    directChatMetadata,
  ).map(({ role, content }) => ({
    role,
    content,
  }));
  const { reply, agentCfg } = await generateDirectAgentReply({
    agent,
    message,
    history: cleanHistory,
    firstName,
    directChatMetadata,
  });

  appendHistory(
    historyUserId,
    sessionId || "default",
    "user",
    message,
    projectId || null,
  );
  appendHistory(
    historyUserId,
    sessionId || "default",
    "assistant",
    reply,
    projectId || null,
  );

  if (projectId) {
    const { saveProjectMessage } = await import("../chat/project-messages.mjs");
    const userMessageId = saveProjectMessage(projectId, {
      source: messageSource,
      role: "user",
      content: message,
      agent: null,
      threadId,
      parentId,
      metadata: {
        directChat: true,
        agentName: "You",
        agentEmoji: "👤",
        targetAgent: agent,
        targetAgentName: agentCfg.name || agent,
        targetAgentEmoji: agentCfg.emoji || "🤖",
        ...(directChatMetadata || {}),
      },
    });
    saveProjectMessage(projectId, {
      source: "agent",
      role: "assistant",
      content: reply,
      agent,
      threadId,
      parentId: userMessageId,
      metadata: {
        agentName: agentCfg.name || agent,
        agentEmoji: agentCfg.emoji || "🤖",
        model: agentCfg.model,
        directChat: true,
        ...(directChatMetadata || {}),
      },
    });
    if (threadId && directChatMetadata?.sharedChat) {
      setThreadBinding(projectId, threadId, {
        participantId: agent,
        kind: "agent",
        runtime: agentCfg.model || null,
        displayName: agentCfg.name || agent,
      });
    }
    await maybeRouteDirectReplyMentions({
      reply,
      sender: agent,
      projectId,
      projectDir,
      sessionId,
      threadId,
      originMessageId: userMessageId,
      directChatMetadata,
    });
  }

  return { reply, agentCfg };
}

async function runDirectAgentFanoutChat({
  agents,
  message,
  sessionId,
  firstName,
  projectId = null,
  historyUserId = "bridge",
  messageSource = "dashboard",
  threadId = null,
  parentId = null,
  directChatMetadata = null,
}) {
  const { loadHistory, appendHistory } = _deps;
  const history = loadHistory(
    historyUserId,
    sessionId || "default",
    projectId || null,
  );
  const cleanHistory = history.map(({ role, content }) => ({
    role,
    content,
  }));

  appendHistory(
    historyUserId,
    sessionId || "default",
    "user",
    message,
    projectId || null,
  );

  let userMessageId = parentId;
  if (projectId) {
    const { saveProjectMessage } = await import("../chat/project-messages.mjs");
    userMessageId = saveProjectMessage(projectId, {
      source: messageSource,
      role: "user",
      content: message,
      agent: null,
      threadId,
      parentId,
      metadata: {
        directChat: true,
        multiDirect: true,
        agentName: "You",
        agentEmoji: "👤",
        targetAgents: agents,
        ...(directChatMetadata || {}),
      },
    });
  }

  const replies = [];
  for (const agent of agents) {
    const { reply, agentCfg } = await generateDirectAgentReply({
      agent,
      message,
      history: cleanHistory,
      firstName,
      directChatMetadata,
    });
    appendHistory(
      historyUserId,
      sessionId || "default",
      "assistant",
      reply,
      projectId || null,
    );
    if (projectId) {
      const { saveProjectMessage } = await import("../chat/project-messages.mjs");
      saveProjectMessage(projectId, {
        source: "agent",
        role: "assistant",
        content: reply,
        agent,
        threadId,
        parentId: userMessageId,
        metadata: {
          agentName: agentCfg.name || agent,
          agentEmoji: agentCfg.emoji || "🤖",
          model: agentCfg.model,
          directChat: true,
          multiDirect: true,
          ...(directChatMetadata || {}),
        },
      });
    }
    replies.push({
      agent,
      agentName: agentCfg.name || agent,
      agentEmoji: agentCfg.emoji || "🤖",
      reply,
    });
  }

  return { replies };
}

function buildDirectCliPrompt({
  participant,
  message,
  history = [],
  directChatMetadata = null,
}) {
  const context = history
    .map(({ role, content }) => `${role}: ${content}`)
    .join("\n");
  return [
    `You are @${participant.id} participating in a shared crewswarm chat.`,
    "",
    "## Direct Chat Mode",
    "- Reply directly to the latest message in plain text.",
    "- You are in direct room chat, not dispatch mode.",
    "- Do NOT explain mention routing or say you cannot be mentioned.",
    "- Do NOT emit @@ markers.",
    ...(directChatMetadata?.sharedChat
      ? [
          "- You may tag another participant with a literal @handle when an in-room handoff or follow-up is useful.",
          "- If you hand work off in shared chat, do it visibly with a plain @mention in the reply body.",
        ]
      : []),
    "- Keep casual chat casual and brief.",
    ...(isBroadcastAllMode(directChatMetadata)
      ? ["", buildBroadcastReplyInstructions()]
      : []),
    ...buildRoutingContextLines(directChatMetadata),
    "",
    "Recent conversation:",
    context || "(no prior context)",
    "",
    "Latest message:",
    message,
  ].join("\n");
}

async function generateDirectCliReply({
  participant,
  message,
  history = [],
  sessionId,
  projectDir = null,
  directChatMetadata = null,
}) {
  const prompt = buildDirectCliPrompt({
    participant,
    message,
    history,
    directChatMetadata,
  });
  const result = await executeCLI(
    participant.runtime,
    prompt,
    null,
    { sessionId, projectDir },
  );
  const reply = sanitizeDirectChatReply(result.stdout || result.stderr || "");
  return {
    reply,
    agentCfg: {
      name: participant.id,
      emoji: "🤖",
      model: participant.runtime,
    },
  };
}

async function runDirectParticipantChat({
  participant,
  message,
  sessionId,
  firstName,
  projectId = null,
  projectDir = null,
  historyUserId = "bridge",
  messageSource = "dashboard",
  threadId = null,
  parentId = null,
  directChatMetadata = null,
}) {
  if (participant.kind === "agent") {
    return runDirectAgentChat({
      agent: participant.id,
      message,
      sessionId,
      firstName,
      projectId,
      projectDir,
      historyUserId,
      messageSource,
      threadId,
      parentId,
      directChatMetadata,
    });
  }

  const { loadHistory, appendHistory } = _deps;
  const history = loadHistory(
    historyUserId,
    sessionId || "default",
    projectId || null,
  );
  const cleanHistory = filterDirectChatHistory(
    history,
    directChatMetadata,
  ).map(({ role, content }) => ({ role, content }));
  const { reply, agentCfg } = await generateDirectCliReply({
    participant,
    message,
    history: cleanHistory,
    sessionId,
    projectDir,
    directChatMetadata,
  });

  appendHistory(
    historyUserId,
    sessionId || "default",
    "user",
    message,
    projectId || null,
  );
  appendHistory(
    historyUserId,
    sessionId || "default",
    "assistant",
    reply,
    projectId || null,
  );

  if (projectId) {
    const { saveProjectMessage } = await import("../chat/project-messages.mjs");
    const userMessageId = saveProjectMessage(projectId, {
      source: messageSource,
      role: "user",
      content: message,
      agent: null,
      threadId,
      parentId,
      metadata: {
        directChat: true,
        agentName: "You",
        agentEmoji: "👤",
        targetAgent: participant.id,
        targetAgentName: agentCfg.name || participant.id,
        targetAgentEmoji: agentCfg.emoji || "🤖",
        ...(directChatMetadata || {}),
      },
    });
    saveProjectMessage(projectId, {
      source: "cli",
      role: "assistant",
      content: reply,
      agent: participant.id,
      threadId,
      parentId: userMessageId,
      metadata: {
        agentName: agentCfg.name || participant.id,
        agentEmoji: agentCfg.emoji || "🤖",
        model: agentCfg.model,
        runtime: participant.runtime,
        directChat: true,
        ...(directChatMetadata || {}),
      },
    });
    if (threadId && directChatMetadata?.sharedChat) {
      setThreadBinding(projectId, threadId, {
        participantId: participant.id,
        kind: "cli",
        runtime: participant.runtime || agentCfg.model || null,
        displayName: agentCfg.name || participant.id,
      });
    }
    await maybeRouteDirectReplyMentions({
      reply,
      sender: participant.id,
      projectId,
      projectDir,
      sessionId,
      threadId,
      originMessageId: userMessageId,
      directChatMetadata,
    });
  }

  return { reply, agentCfg };
}

async function runDirectParticipantFanoutChat({
  participants,
  message,
  sessionId,
  firstName,
  projectId = null,
  projectDir = null,
  historyUserId = "bridge",
  messageSource = "dashboard",
  threadId = null,
  parentId = null,
  directChatMetadata = null,
}) {
  const { loadHistory, appendHistory, recordAgentTimeout } = _deps;
  const history = loadHistory(
    historyUserId,
    sessionId || "default",
    projectId || null,
  );
  const cleanHistory = filterDirectChatHistory(
    history,
    directChatMetadata,
  ).map(({ role, content }) => ({ role, content }));

  appendHistory(
    historyUserId,
    sessionId || "default",
    "user",
    message,
    projectId || null,
  );

  let userMessageId = parentId;
  if (projectId) {
    const { saveProjectMessage } = await import("../chat/project-messages.mjs");
    userMessageId = saveProjectMessage(projectId, {
      source: messageSource,
      role: "user",
      content: message,
      agent: null,
      threadId,
      parentId,
      metadata: {
        directChat: true,
        multiDirect: true,
        agentName: "You",
        agentEmoji: "👤",
        targetAgents: participants.map((participant) => participant.id),
        ...(directChatMetadata || {}),
      },
    });
  }

  const saveProjectMessage =
    projectId
      ? (await import("../chat/project-messages.mjs")).saveProjectMessage
      : null;
  const timeoutMs = isBroadcastAllMode(directChatMetadata)
    ? BROADCAST_ALL_TIMEOUT_MS
    : DIRECT_FANOUT_TIMEOUT_MS;

  async function emitParticipantStatus(participant, content, kind = "error") {
    appendHistory(
      historyUserId,
      sessionId || "default",
      "assistant",
      content,
      projectId || null,
    );
    if (saveProjectMessage) {
      saveProjectMessage(projectId, {
        source: participant.kind === "cli" ? "cli" : "agent",
        role: "assistant",
        content,
        agent: participant.id,
        threadId,
        parentId: userMessageId,
        metadata: {
          agentName: participant.id,
          agentEmoji: participant.kind === "cli" ? "💻" : "🤖",
          directChat: true,
          multiDirect: true,
          timeout: kind === "timeout",
          error: kind === "error",
          ...(participant.kind === "cli" ? { runtime: participant.runtime } : {}),
          ...(directChatMetadata || {}),
        },
      });
    }
    _deps.broadcastSSE?.({
      type: "chat_message",
      sessionId,
      projectId,
      role: "assistant",
      content,
      source: participant.kind === "cli" ? "cli" : "agent",
      agent: participant.id,
      agentName: participant.id,
      agentEmoji: participant.kind === "cli" ? "💻" : "🤖",
      directChat: true,
      multiDirect: true,
      timeout: kind === "timeout",
      error: kind === "error",
    });
  }

  const results = await Promise.all(
    participants.map(async (participant) => {
      try {
        const result = await withFanoutTimeout(
          () =>
            participant.kind === "agent"
              ? generateDirectAgentReply({
                  agent: participant.id,
                  message,
                  history: cleanHistory,
                  firstName,
                  directChatMetadata,
                })
              : generateDirectCliReply({
                  participant,
                  message,
                  history: cleanHistory,
                  sessionId,
                  projectDir,
                  directChatMetadata,
                }),
          participant.id,
          timeoutMs,
        );
      appendHistory(
        historyUserId,
        sessionId || "default",
        "assistant",
        result.reply,
        projectId || null,
      );
      if (saveProjectMessage) {
        saveProjectMessage(projectId, {
          source: participant.kind === "cli" ? "cli" : "agent",
          role: "assistant",
          content: result.reply,
          agent: participant.id,
          threadId,
          parentId: userMessageId,
          metadata: {
            agentName: result.agentCfg.name || participant.id,
            agentEmoji: result.agentCfg.emoji || "🤖",
            model: result.agentCfg.model,
            ...(participant.kind === "cli" ? { runtime: participant.runtime } : {}),
            directChat: true,
            multiDirect: true,
            ...(directChatMetadata || {}),
          },
        });
      }
      _deps.broadcastSSE?.({
        type: "chat_message",
        sessionId,
        projectId,
        role: "assistant",
        content: result.reply,
        source: participant.kind === "cli" ? "cli" : "agent",
        agent: participant.id,
        agentName: result.agentCfg.name || participant.id,
        agentEmoji: result.agentCfg.emoji || "🤖",
        model: result.agentCfg.model,
        directChat: true,
        multiDirect: true,
      });
      await maybeRouteDirectReplyMentions({
        reply: result.reply,
        sender: participant.id,
        projectId,
        projectDir,
        sessionId,
        threadId,
        originMessageId: userMessageId,
        directChatMetadata,
      });
      return {
        agent: participant.id,
        agentName: result.agentCfg.name || participant.id,
        agentEmoji: result.agentCfg.emoji || "🤖",
        reply: result.reply,
      };
      } catch (error) {
        const timeout = error?.code === "DIRECT_FANOUT_TIMEOUT";
        if (timeout) {
          recordAgentTimeout?.(participant.id);
        }
        const content = timeout
          ? `Timed out after ${Math.round(timeoutMs / 1000)}s.`
          : `Failed: ${String(error?.message || error).replace(/\s+/g, " ").slice(0, 160)}`;
        await emitParticipantStatus(
          participant,
          content,
          timeout ? "timeout" : "error",
        );
        return {
          agent: participant.id,
          error: content,
          timeout,
        };
      }
    }),
  );

  const replies = results.filter((entry) => entry?.reply);
  const errors = results
    .filter((entry) => entry?.error)
    .map((entry) => `${entry.agent}: ${entry.error}`);
  return { replies, errors, streamed: true };
}

async function maybeRouteDirectReplyMentions({
  reply,
  sender,
  projectId = null,
  projectDir = null,
  sessionId = "default",
  threadId = null,
  originMessageId = null,
  directChatMetadata = null,
}) {
  if (!projectId || !directChatMetadata?.sharedChat) return;
  const content = String(reply || "").trim();
  if (!content) return;
  try {
    const { handleAutonomousMentions } = await import(
      "../chat/autonomous-mentions.mjs"
    );
    await handleAutonomousMentions({
      message: { content },
      sender,
      channel: projectId,
      projectId,
      sessionId,
      projectDir,
      originThreadId: threadId || `${projectId}:${sessionId}`,
      originMessageId,
      broadcastSSE: _deps.broadcastSSE,
    });
  } catch (error) {
    console.warn(
      `[crew-lead] Direct mention routing failed for ${sender}: ${error.message}`,
    );
  }
}

// Helper to run CLI commands with scoped environment
function runCommand(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("close", (exitCode) => {
      resolve({ exitCode: exitCode || 0, stdout, stderr });
    });

    child.on("error", reject);
  });
}

export function createAndStartServer(PORT) {
  // Debug: check if _deps is properly initialized
  if (!_deps || Object.keys(_deps).length === 0) {
    console.error(
      "[http-server] FATAL: _deps is empty! initHttpServer() was not called.",
    );
    process.exit(1);
  }

  const {
    sseClients,
    loadConfig,
    loadHistory,
    clearHistory,
    appendHistory,
    broadcastSSE,
    handleChat,
    confirmProject,
    pendingProjects,
    dispatchTask,
    pendingDispatches,
    pendingPipelines,
    resolveAgentId,
    readAgentTools,
    writeAgentTools,
    activeOpenCodeAgents,
    agentTimeoutCounts,
    crewswarmToolNames,
    classifyTask,
    tryRead,
    resolveSkillAlias,
    connectRT,
    historyDir,
    dispatchTimeoutMs,
    dispatchTimeoutInterval,
    setDispatchTimeoutInterval,
    checkDispatchTimeouts,
    getRTToken,
    getRtPublish,
    telemetrySchemaVersion,
    readTelemetryEvents,
    bgConsciousnessRef,
    bgConsciousnessIntervalMs,
    cursorWavesRef,
    claudeCodeRef,
  } = _deps;

  // Debug: verify critical deps
  if (!loadConfig || !handleChat) {
    console.error("[http-server] FATAL: Missing critical deps:", {
      loadConfig: !!loadConfig,
      handleChat: !!handleChat,
    });
    process.exit(1);
  }

  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, authorization",
      });
      res.end();
      return;
    }

    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);

      function checkBearer(request) {
        const RT_TOKEN = getRTToken();
        if (!RT_TOKEN) return true; // no token configured → open (local-first default)
        const auth = request.headers["authorization"] || "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
        return token === RT_TOKEN;
      }

      if (url.pathname === "/health" && req.method === "GET") {
        json(res, 200, { ok: true, agent: "crew-lead", port: PORT });
        return;
      }

      // GET /api/services/health — check OpenCode + bridges, optionally restart
      // POST /api/services/restart-opencode — kill + relaunch opencode serve
      if (url.pathname === "/api/services/health" && req.method === "GET") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        const { execSync } = await import("node:child_process");
        let ocAlive = false;
        try {
          const ocRes = await fetch("http://127.0.0.1:4096/health", {
            signal: AbortSignal.timeout(3000),
          }).catch(() => null);
          ocAlive = !!ocRes;
        } catch {}
        let bridgeCount = 0;
        try {
          const out = execSync(
            `pgrep -f "gateway-bridge.mjs --rt-daemon" | wc -l`,
            { encoding: "utf8" },
          );
          bridgeCount = parseInt(out.trim(), 10);
        } catch {}
        json(res, 200, {
          ok: true,
          opencode: { alive: ocAlive, port: 4096 },
          bridges: { count: bridgeCount },
          crewLead: { alive: true, port: PORT },
        });
        return;
      }

      if (
        url.pathname === "/api/services/restart-opencode" &&
        req.method === "POST"
      ) {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        const { execSync } = await import("node:child_process");
        try {
          const logPath = path.join(os.tmpdir(), "opencode-server.log");
          execSync(
            `pkill -f "opencode serve" 2>/dev/null; sleep 1; nohup opencode serve --port 4096 --hostname 127.0.0.1 >> ${logPath} 2>&1 &`,
            { timeout: 5000, shell: true },
          );
          json(res, 200, {
            ok: true,
            message: "OpenCode restart triggered — allow ~6s to come up",
          });
        } catch (e) {
          json(res, 500, { ok: false, error: e.message });
        }
        return;
      }

      if (url.pathname === "/status" && req.method === "GET") {
        const cfg = loadConfig();
        const rtPublish = getRtPublish();
        json(res, 200, {
          ok: true,
          model: cfg.model,
          rtConnected: rtPublish !== null,
          agents: cfg.knownAgents,
        });
        return;
      }

      if (url.pathname === "/chat" && req.method === "POST") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        let message, sessionId, firstName, projectId, projectDir, userId, targetAgent, channelMode;
        try {
          const body = await readBody(req);
          message = (body.message || "").slice(0, 16000); // M2: cap message size
          sessionId = body.sessionId;
          firstName = body.firstName;
          projectId = body.projectId || url.searchParams.get("projectId"); // Support query param too
          projectDir = body.projectDir || null;
          userId = body.userId || "default";
          targetAgent = body.targetAgent; // Per-user routing from WhatsApp/Telegram
          channelMode = body.channelMode === true;
        } catch (e) {
          json(res, 400, {
            ok: false,
            error: "invalid JSON body or missing message",
          });
          return;
        }
        if (!message) {
          json(res, 400, { ok: false, error: "message required" });
          return;
        }

        if (channelMode && !/(^|\s)@[a-zA-Z0-9_-]+/.test(message)) {
          targetAgent = null;
        }

        const channelThreadId =
          channelMode && projectId && sessionId ? `${projectId}:${sessionId}` : null;
        const threadBinding =
          channelMode && projectId && channelThreadId
            ? getThreadBinding(projectId, channelThreadId)
            : null;
        const mentionRoute =
          !targetAgent && channelMode
            ? classifySharedChatMention(message)
            : null;
        console.log(
          `[crew-lead] /chat session=${sessionId || "default"} channelMode=${channelMode ? "1" : "0"} targetAgent=${targetAgent || "-"} mentionMode=${mentionRoute?.mode || "-"} message="${String(message || "").replace(/\s+/g, " ").slice(0, 120)}"`,
        );
        if (mentionRoute?.mode === "direct" && mentionRoute.targetAgent) {
          targetAgent = mentionRoute.targetAgent;
          message = mentionRoute.directMessage;
        }
        if (
          channelMode &&
          !targetAgent &&
          mentionRoute?.mode === "none" &&
          threadBinding
        ) {
          message = String(message || "").trim();
          if (threadBinding.kind === "agent") {
            targetAgent = threadBinding.participantId;
          }
        }
        if (
          channelMode &&
          mentionRoute?.mode === "direct_multi" &&
          Array.isArray(mentionRoute.targetParticipants) &&
          mentionRoute.targetParticipants.length
        ) {
          try {
            const enriched = await enrichTwitterLinks(
              mentionRoute.directMessage,
              { source: "crew-lead:fanout" },
            );
            const result = await runDirectParticipantFanoutChat({
              participants: mentionRoute.targetParticipants,
              message: enriched.text,
              sessionId,
              firstName,
              projectId,
              projectDir,
              historyUserId: userId || "bridge",
              messageSource: "dashboard",
              threadId: channelThreadId,
              directChatMetadata: {
                sharedChat: true,
                mentionDirect: true,
                multiDirect: true,
                broadcastAll: !!mentionRoute.broadcastAll,
              },
            });
            json(res, 200, {
              ok: true,
              directChat: true,
              multiDirect: true,
              streamed: true,
              errors: result.errors || [],
            });
            return;
          } catch (e) {
            console.error(
              "[crew-lead] /chat multi direct route failed:",
              e.message,
              e.stack,
            );
            json(res, 500, { ok: false, error: e.message });
            return;
          }
        }

        const mentionTargetParticipant = mentionRoute?.targetParticipant || null;
        const pinnedParticipant =
          channelMode &&
          mentionRoute?.mode === "none" &&
          threadBinding?.kind === "cli"
            ? {
                id: threadBinding.participantId,
                kind: "cli",
                runtime: threadBinding.runtime,
              }
            : null;
        if (!targetAgent && (mentionTargetParticipant?.kind === "cli" || pinnedParticipant)) {
          try {
            const directMessage =
              mentionTargetParticipant?.kind === "cli"
                ? mentionRoute.directMessage
                : String(message || "").trim();
            const enriched = await enrichTwitterLinks(directMessage, {
              source: "crew-lead:participant",
            });
            const result = await runDirectParticipantChat({
              participant: mentionTargetParticipant || pinnedParticipant,
              message: enriched.text,
              sessionId,
              firstName,
              projectId,
              projectDir,
              historyUserId: userId || "bridge",
              messageSource: "dashboard",
              threadId: channelThreadId,
              directChatMetadata: {
                sharedChat: true,
                ...(mentionTargetParticipant?.kind === "cli"
                  ? { mentionDirect: true }
                  : { threadPinned: true }),
                ...(threadBinding ? { threadBinding } : {}),
              },
            });
            json(res, 200, {
              ok: true,
              reply: result.reply,
              agent: (mentionTargetParticipant || pinnedParticipant).id,
              agentName: result.agentCfg?.name || (mentionTargetParticipant || pinnedParticipant).id,
              agentEmoji: result.agentCfg?.emoji || "🤖",
              directChat: true,
            });
            return;
          } catch (e) {
            console.error(
              `[crew-lead] /chat direct CLI route to ${mentionTargetParticipant.id} failed:`,
              e.message,
              e.stack,
            );
            json(res, 500, { ok: false, error: e.message });
            return;
          }
        }

        // If targetAgent is specified and it's not crew-lead, use direct chat semantics.
        if (targetAgent && targetAgent !== "crew-lead") {
          console.log(
            `[crew-lead] /chat routing to ${targetAgent} via direct chat (session=${sessionId})`,
          );
          try {
            const enriched = await enrichTwitterLinks(message, {
              source: "crew-lead:direct-agent",
            });
            const result = await runDirectAgentChat({
              agent: targetAgent,
              message: enriched.text,
              sessionId,
              firstName,
              projectId,
              historyUserId: userId || "bridge",
              messageSource: "dashboard",
              threadId: channelThreadId,
              directChatMetadata:
                channelMode && (mentionRoute?.mode === "direct" || threadBinding)
                  ? {
                      sharedChat: true,
                      ...(mentionRoute?.mode === "direct"
                        ? { mentionDirect: true }
                        : { threadPinned: true }),
                      ...(threadBinding ? { threadBinding } : {}),
                    }
                  : null,
            });
            json(res, 200, {
              ok: true,
              reply: result.reply,
              routedTo: targetAgent,
              agent: targetAgent,
              agentName: result.agentCfg?.name || targetAgent,
              agentEmoji: result.agentCfg?.emoji || "🤖",
              directChat: true,
            });
            return;
          } catch (e) {
            console.error(
              `[crew-lead] /chat direct route to ${targetAgent} failed:`,
              e.message,
              e.stack,
            );
            json(res, 500, { ok: false, error: e.message });
            return;
          }
        }

        // @@RESET — clear session history and confirm
        if (
          /^@@RESET\b/i.test(message.trim()) ||
          /^\/reset\b/i.test(message.trim())
        ) {
          clearHistory(userId, sessionId || "default", projectId || null);
          const cfg = loadConfig();
          const reply = `Session cleared. Fresh context — ${cfg.providerKey}/${cfg.modelId} primary is back.`;
          appendHistory(
            userId,
            sessionId || "default",
            "assistant",
            reply,
            projectId || null,
          );
          broadcastSSE({
            type: "chat_message",
            sessionId,
            projectId,
            role: "assistant",
            content: reply,
          });
          json(res, 200, { ok: true, reply });
          return;
        }
        console.log(
          `[crew-lead] /chat session=${sessionId} project=${projectId || "none"} msg=${message.slice(0, 60)}`,
        );
        try {
          const enriched = await enrichTwitterLinks(message, {
            source: "crew-lead:chat",
          });
          const result = await handleChat({
            message: enriched.text,
            sessionId,
            userId,
            firstName,
            projectId,
            projectDir,
            channelMode,
          });

          // Publish reply back to RT bus so Telegram/WhatsApp bridges can route it
          // Bridges listen for messages with matching sessionId (telegram-*, whatsapp-*)
          if (result.reply && sessionId) {
            const rtPublish = getRtPublish();
            if (rtPublish) {
              rtPublish({
                channel: "events",
                type: "chat.reply",
                to: "broadcast",
                payload: {
                  content: result.reply,
                  sessionId: sessionId,
                  from: "crew-lead",
                },
              });
              console.log(
                `[crew-lead] Published reply to RT bus for session=${sessionId}`,
              );
            }
          }

          json(res, 200, { ok: true, ...result });
        } catch (e) {
          console.error("[crew-lead] /chat handler error:", e);
          json(res, 500, { ok: false, error: String(e.message || e) });
        }
        return;
      }

      // POST /chat/stream — streaming version of /chat for SSE
      if (url.pathname === "/chat/stream" && req.method === "POST") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        let message, sessionId, firstName, projectId, projectDir, userId, channelMode;
        try {
          const body = await readBody(req);
          message = (body.message || "").slice(0, 16000);
          sessionId = body.sessionId;
          firstName = body.firstName;
          projectId = body.projectId;
          projectDir = body.projectDir || null;
          userId = body.userId || "default";
          channelMode = body.channelMode === true;
        } catch (e) {
          json(res, 400, {
            ok: false,
            error: "invalid JSON body or missing message",
          });
          return;
        }
        if (!message) {
          json(res, 400, { ok: false, error: "message required" });
          return;
        }

        // Setup SSE
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        // Send initial comment to keep connection alive
        res.write(": connected\n\n");

        console.log(
          `[crew-lead] /chat/stream session=${sessionId} project=${projectId || "none"} msg=${message.slice(0, 60)}`,
        );

        try {
          const enriched = await enrichTwitterLinks(message, {
            source: "crew-lead:chat-stream",
          });
          const result = await handleChat({
            message: enriched.text,
            sessionId,
            userId,
            firstName,
            projectId,
            projectDir,
            channelMode,
          });

          // Send final message
          res.write(
            `data: ${JSON.stringify({
              type: "chat_message",
              role: "assistant",
              content: result.reply,
              sessionId,
              projectId,
            })}\n\n`,
          );

          // Publish to RT bus for bridges
          if (result.reply && sessionId) {
            const rtPublish = getRtPublish();
            if (rtPublish) {
              rtPublish({
                channel: "events",
                type: "chat.reply",
                to: "broadcast",
                payload: {
                  content: result.reply,
                  sessionId: sessionId,
                  from: "crew-lead",
                },
              });
            }
          }
        } catch (e) {
          console.error("[crew-lead] /chat/stream handler error:", e);
          res.write(
            `data: ${JSON.stringify({ type: "error", error: String(e.message || e) })}\n\n`,
          );
        }

        res.end();
        return;
      }

      if (url.pathname === "/clear" && req.method === "POST") {
        const { sessionId, userId, projectId } = await readBody(req);
        clearHistory(
          userId || "default",
          sessionId || "default",
          projectId || null,
        );
        json(res, 200, { ok: true });
        return;
      }

      // POST /api/chat-agent — fast direct LLM call for non-crew-lead agents (bypasses dispatch)
      // Body: { agent: "crew-loco", message: "...", sessionId: "whatsapp-xxx", firstName: "Name" }
      // Returns: { ok: true, reply: "..." }
      if (url.pathname === "/api/chat-agent" && req.method === "POST") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        const body = await readBody(req);
        const {
          agent,
          message,
          sessionId,
          firstName,
          projectId: chatAgentProjectId,
        } = body;
        if (!agent || !message) {
          json(res, 400, { ok: false, error: "agent and message required" });
          return;
        }

        console.log(
          `[crew-lead] /api/chat-agent agent=${agent} session=${sessionId} msg=${message.slice(0, 60)}`,
        );

        try {
          const enriched = await enrichTwitterLinks(message, {
            source: "crew-lead:api-chat-agent",
          });
          const result = await runDirectAgentChat({
            agent,
            message: enriched.text,
            sessionId,
            firstName,
            projectId: chatAgentProjectId || null,
            historyUserId: "bridge",
            messageSource: "dashboard",
          });
          console.log(
            `[crew-lead] /api/chat-agent ${agent} replied: ${result.reply.slice(0, 80)}...`,
          );
          json(res, 200, {
            ok: true,
            reply: result.reply,
            agent,
            agentName: result.agentCfg?.name || agent,
            agentEmoji: result.agentCfg?.emoji || "🤖",
            directChat: true,
          });
        } catch (e) {
          console.error(
            `[crew-lead] /api/chat-agent ${agent} failed:`,
            e.message,
            e.stack,
          );
          json(res, 500, { ok: false, error: e.message });
        }
        return;
      }

      // GET /api/crew-lead/history?sessionId=xyz&projectId=abc — load chat history for session (optionally project-scoped)
      if (url.pathname === "/api/crew-lead/history" && req.method === "GET") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        const sessionId = url.searchParams.get("sessionId") || "default";
        const userId = url.searchParams.get("userId") || "default";
        const projectId = url.searchParams.get("projectId") || null;
        const history = loadHistory(userId, sessionId, projectId);
        json(res, 200, { ok: true, sessionId, projectId, history });
        return;
      }

      // GET /api/crew-lead/project-messages?projectId=xyz — load unified project messages (all sources)
      if (
        url.pathname === "/api/crew-lead/project-messages" &&
        req.method === "GET"
      ) {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        const projectId = url.searchParams.get("projectId");
        if (!projectId) {
          json(res, 400, { ok: false, error: "projectId required" });
          return;
        }

        const limit = parseInt(url.searchParams.get("limit") || "100", 10);
        const source = url.searchParams.get("source") || null; // Filter by source if provided
        const agent = url.searchParams.get("agent") || null; // Filter by agent if provided
        const threadId = url.searchParams.get("threadId") || null;
        const mentionedAgent =
          url.searchParams.get("mentionedAgent") || null;
        const sinceRaw = url.searchParams.get("since");
        const since = sinceRaw ? parseInt(sinceRaw, 10) : null;
        const excludeDirect = url.searchParams.get("excludeDirect") === "true";

        try {
          const { loadProjectMessages } =
            await import("../chat/project-messages.mjs");
          const messages = loadProjectMessages(projectId, {
            limit,
            ...(source && { source }),
            ...(agent && { agent }),
            ...(threadId && { threadId }),
            ...(mentionedAgent && { mentionedAgent }),
            ...(Number.isFinite(since) ? { since } : {}),
            ...(excludeDirect ? { excludeDirect: true } : {}),
          });
          json(res, 200, {
            ok: true,
            projectId,
            messages,
            count: messages.length,
          });
        } catch (e) {
          console.error("[crew-lead] Failed to load project messages:", e);
          json(res, 500, { ok: false, error: e.message });
        }
        return;
      }

      // GET /api/crew-lead/search-project-messages?projectId=xyz&q=auth — search project messages
      if (
        url.pathname === "/api/crew-lead/search-project-messages" &&
        req.method === "GET"
      ) {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        const projectId = url.searchParams.get("projectId");
        const query = url.searchParams.get("q");

        if (!projectId || !query) {
          json(res, 400, {
            ok: false,
            error: "projectId and q (query) required",
          });
          return;
        }

        const caseSensitive = url.searchParams.get("caseSensitive") === "true";
        const source = url.searchParams.get("source") || null;
        const agent = url.searchParams.get("agent") || null;
        const limit = parseInt(url.searchParams.get("limit") || "50", 10);

        try {
          const { searchProjectMessages } =
            await import("../chat/project-messages.mjs");
          const results = searchProjectMessages(projectId, query, {
            caseSensitive,
            ...(source && { source }),
            ...(agent && { agent }),
            limit,
          });
          json(res, 200, {
            ok: true,
            projectId,
            query,
            results,
            count: results.length,
          });
        } catch (e) {
          console.error("[crew-lead] Failed to search project messages:", e);
          json(res, 500, { ok: false, error: e.message });
        }
        return;
      }

      // GET /api/crew-lead/export-project-messages?projectId=xyz&format=markdown — export project messages
      if (
        url.pathname === "/api/crew-lead/export-project-messages" &&
        req.method === "GET"
      ) {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        const projectId = url.searchParams.get("projectId");

        if (!projectId) {
          json(res, 400, { ok: false, error: "projectId required" });
          return;
        }

        const format = url.searchParams.get("format") || "markdown"; // markdown, json, csv, txt
        const limit = url.searchParams.get("limit")
          ? parseInt(url.searchParams.get("limit"), 10)
          : null;
        const includeMetadata =
          url.searchParams.get("includeMetadata") === "true";

        try {
          const { exportProjectMessages } =
            await import("../chat/project-messages.mjs");
          const exported = exportProjectMessages(projectId, format, {
            limit,
            includeMetadata,
          });

          // Set appropriate content type
          const contentTypes = {
            json: "application/json",
            markdown: "text/markdown",
            csv: "text/csv",
            txt: "text/plain",
          };

          res.writeHead(200, {
            "content-type": contentTypes[format] || "text/plain",
            "content-disposition": `attachment; filename="project-${projectId}.${format === "markdown" ? "md" : format}"`,
          });
          res.end(exported);
        } catch (e) {
          console.error("[crew-lead] Failed to export project messages:", e);
          json(res, 500, { ok: false, error: e.message });
        }
        return;
      }

      // GET /api/crew-lead/message-threads?projectId=xyz — get message threads
      if (
        url.pathname === "/api/crew-lead/message-threads" &&
        req.method === "GET"
      ) {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        const projectId = url.searchParams.get("projectId");

        if (!projectId) {
          json(res, 400, { ok: false, error: "projectId required" });
          return;
        }

        const threadId = url.searchParams.get("threadId") || null;

        try {
          const { getMessageThreads } =
            await import("../chat/project-messages.mjs");
          const threads = getMessageThreads(projectId, threadId);
          json(res, 200, {
            ok: true,
            projectId,
            threads,
            threadCount: threadId ? 1 : Object.keys(threads).length,
          });
        } catch (e) {
          console.error("[crew-lead] Failed to load message threads:", e);
          json(res, 500, { ok: false, error: e.message });
        }
        return;
      }

      // GET /api/crew-lead/search-messages-semantic?projectId=xyz&q=authentication — semantic search
      if (
        url.pathname === "/api/crew-lead/search-messages-semantic" &&
        req.method === "GET"
      ) {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        const projectId = url.searchParams.get("projectId");
        const query = url.searchParams.get("q");

        if (!query) {
          json(res, 400, { ok: false, error: "q (query) required" });
          return;
        }

        const limit = parseInt(url.searchParams.get("limit") || "10", 10);
        const source = url.searchParams.get("source") || null;
        const agent = url.searchParams.get("agent") || null;

        try {
          const { searchProjectMessagesSemanticly } =
            await import("../chat/project-messages-rag.mjs");
          const results = searchProjectMessagesSemanticly(query, projectId, {
            limit,
            source,
            agent,
          });
          json(res, 200, {
            ok: true,
            projectId,
            query,
            results,
            count: results.length,
          });
        } catch (e) {
          console.error(
            "[crew-lead] Failed to search messages semantically:",
            e,
          );
          json(res, 500, { ok: false, error: e.message });
        }
        return;
      }

      // POST /api/crew-lead/index-project-messages — index project messages into RAG
      if (
        url.pathname === "/api/crew-lead/index-project-messages" &&
        req.method === "POST"
      ) {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        const { projectId } = await readBody(req);

        if (!projectId) {
          json(res, 400, { ok: false, error: "projectId required" });
          return;
        }

        try {
          const { indexProjectMessages } =
            await import("../chat/project-messages-rag.mjs");
          const indexed = indexProjectMessages(projectId);
          json(res, 200, { ok: true, projectId, messagesIndexed: indexed });
        } catch (e) {
          console.error("[crew-lead] Failed to index project messages:", e);
          json(res, 500, { ok: false, error: e.message });
        }
        return;
      }

      // GET /api/crew-lead/message-index-stats — get RAG index statistics
      if (
        url.pathname === "/api/crew-lead/message-index-stats" &&
        req.method === "GET"
      ) {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }

        try {
          const { getIndexStats } =
            await import("../chat/project-messages-rag.mjs");
          const stats = getIndexStats();
          json(res, 200, { ok: true, stats });
        } catch (e) {
          console.error("[crew-lead] Failed to get index stats:", e);
          json(res, 500, { ok: false, error: e.message });
        }
        return;
      }

      if (url.pathname === "/events" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "access-control-allow-origin": "*",
          connection: "keep-alive",
        });
        res.write("retry: 3000\n\n");
        sseClients.add(res);
        // Keepalive comment every 30s — prevents TG/WA bridge AbortSignal timeouts
        const ka = setInterval(() => {
          try {
            res.write(": ka\n\n");
          } catch {
            clearInterval(ka);
          }
        }, 30000);
        req.on("close", () => {
          sseClients.delete(res);
          clearInterval(ka);
        });
        return;
      }

      if (url.pathname === "/history" && req.method === "GET") {
        const sessionId = url.searchParams.get("sessionId") || "default";
        const userId = url.searchParams.get("userId") || "default";
        const history = loadHistory(userId, sessionId);
        json(res, 200, { ok: true, history, count: history.length });
        return;
      }

      if (url.pathname === "/confirm-project" && req.method === "POST") {
        const { draftId, roadmapMd } = await readBody(req);
        if (!draftId) {
          json(res, 400, { ok: false, error: "draftId required" });
          return;
        }
        console.log(`[crew-lead] /confirm-project draftId=${draftId}`);
        try {
          const result = await confirmProject({ draftId, roadmapMd });
          json(res, 200, { ok: true, ...result });
        } catch (e) {
          json(res, 500, { ok: false, error: e.message });
        }
        return;
      }

      if (url.pathname === "/discard-project" && req.method === "POST") {
        const { draftId } = await readBody(req);
        if (draftId) {
          pendingProjects.delete(draftId);
          broadcastSSE({ type: "draft_discarded", draftId });
        }
        json(res, 200, { ok: true });
        return;
      }

      if (url.pathname === "/approve-cmd" && req.method === "POST") {
        const { approvalId } = await readBody(req);
        if (!approvalId) {
          json(res, 400, { ok: false, error: "approvalId required" });
          return;
        }
        const rtPublish = getRtPublish();
        if (rtPublish) {
          rtPublish({
            channel: "events",
            type: "cmd.approved",
            to: "broadcast",
            payload: { approvalId },
          });
          console.log(`[crew-lead] ✅ cmd approved: ${approvalId}`);
        }
        json(res, 200, { ok: true });
        return;
      }

      if (url.pathname === "/reject-cmd" && req.method === "POST") {
        const { approvalId } = await readBody(req);
        if (!approvalId) {
          json(res, 400, { ok: false, error: "approvalId required" });
          return;
        }
        const rtPublish = getRtPublish();
        if (rtPublish) {
          rtPublish({
            channel: "events",
            type: "cmd.rejected",
            to: "broadcast",
            payload: { approvalId },
          });
          console.log(`[crew-lead] ⛔ cmd rejected: ${approvalId}`);
        }
        json(res, 200, { ok: true });
        return;
      }

      if (url.pathname === "/allowlist-cmd" && req.method === "POST") {
        const { pattern } = await readBody(req);
        if (!pattern) {
          json(res, 400, { ok: false, error: "pattern required" });
          return;
        }
        const file = path.join(
          os.homedir(),
          ".crewswarm",
          "cmd-allowlist.json",
        );
        let list = [];
        try {
          list = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch {}
        if (!list.includes(pattern)) {
          list.push(pattern);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, JSON.stringify(list, null, 2));
          console.log(`[crew-lead] ✅ Added to cmd allowlist: ${pattern}`);
        }
        json(res, 200, { ok: true, pattern, list });
        return;
      }

      if (url.pathname === "/allowlist-cmd" && req.method === "DELETE") {
        const { pattern } = await readBody(req);
        const file = path.join(
          os.homedir(),
          ".crewswarm",
          "cmd-allowlist.json",
        );
        let list = [];
        try {
          list = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch {}
        list = list.filter((p) => p !== pattern);
        fs.writeFileSync(file, JSON.stringify(list, null, 2));
        console.log(`[crew-lead] 🗑 Removed from cmd allowlist: ${pattern}`);
        json(res, 200, { ok: true, list });
        return;
      }

      if (url.pathname === "/allowlist-cmd" && req.method === "GET") {
        const file = path.join(
          os.homedir(),
          ".crewswarm",
          "cmd-allowlist.json",
        );
        let list = [];
        try {
          list = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch {}
        json(res, 200, { ok: true, list });
        return;
      }

      if (url.pathname === "/health" && req.method === "GET") {
        json(res, 200, {
          ok: true,
          service: "crew-lead",
          uptime: process.uptime(),
        });
        return;
      }

      // ── External agent API — Bearer token required ────────────────────────────
      // Any external tool (another crewswarm, OpenClaw plugin, scripts) can dispatch tasks
      // and poll status without sharing LLM credentials.
      // Auth: Authorization: Bearer <RT_TOKEN from ~/.crewswarm/config.json rt.authToken>

      // POST /api/dispatch  { agent, task, verify?, done?, sessionId? }
      // Returns { ok, taskId, agent }
      // ── OpenCode plugin push — receives events from the crewswarm-feed plugin
      if (url.pathname === "/api/opencode-event" && req.method === "POST") {
        const evt = await readBody(req).catch(() => null);
        if (evt && typeof evt === "object")
          broadcastSSE({
            type: "opencode_event",
            ...evt,
            ts: evt.ts || Date.now(),
          });
        json(res, 200, { ok: true });
        return;
      }

      // ── /api/classify — task complexity breakdown (used by MCP smart_dispatch) ──
      if (url.pathname === "/api/classify" && req.method === "POST") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        let body;
        try {
          body = await readBody(req);
        } catch {
          json(res, 400, { ok: false, error: "invalid JSON body" });
          return;
        }
        const { task } = body;
        if (!task) {
          json(res, 400, { ok: false, error: "task is required" });
          return;
        }
        const cfg = loadConfig();
        try {
          const result = await classifyTask(task, cfg);
          if (!result) {
            json(res, 200, {
              ok: true,
              score: 1,
              reason: "Simple task — single agent sufficient",
              agents: [],
              breakdown: [],
              skipped: true,
            });
          } else {
            json(res, 200, { ok: true, ...result });
          }
        } catch (e) {
          json(res, 500, { ok: false, error: e.message });
        }
        return;
      }

      if (url.pathname === "/api/dispatch" && req.method === "POST") {
        if (!checkBearer(req)) {
          json(res, 401, {
            ok: false,
            error: "Unauthorized — Bearer token required",
          });
          return;
        }
        const body = await readBody(req);
        let {
          agent,
          task,
          verify,
          done,
          sessionId: sid,
          useClaudeCode,
          useCursorCli,
          runtime,
          projectDir: dispatchProjectDir,
        } = body;
        if (!agent || !task) {
          json(res, 400, { ok: false, error: "agent and task are required" });
          return;
        }
        const cfg = loadConfig();
        agent = resolveAgentId(cfg, agent) || agent;
        const knownAgents = cfg.knownAgents || [];
        if (knownAgents.length && !knownAgents.includes(agent)) {
          json(res, 400, {
            ok: false,
            error: `Unknown agent "${agent}". Known: ${knownAgents.join(", ")}`,
          });
          return;
        }
        const spec = verify || done ? { task, verify, done } : task;
        const routeFlags = {};
        if (useClaudeCode) routeFlags.useClaudeCode = true;
        if (useCursorCli) routeFlags.useCursorCli = true;
        if (runtime) routeFlags.runtime = runtime;
        if (dispatchProjectDir) routeFlags.projectDir = dispatchProjectDir;
        const taskId = dispatchTask(
          agent,
          spec,
          sid || "external",
          Object.keys(routeFlags).length ? routeFlags : null,
        );
        if (!taskId) {
          json(res, 503, {
            ok: false,
            error: "RT bus not connected — agent unreachable",
          });
          return;
        }
        console.log(`[crew-lead] /api/dispatch → ${agent} taskId=${taskId}`);
        json(res, 200, {
          ok: true,
          taskId: taskId === true ? null : taskId,
          agent,
        });
        return;
      }

      // GET /api/status/:taskId  — poll task completion
      // Returns { ok, taskId, status: "pending"|"done"|"unknown", agent, result? }
      if (url.pathname.startsWith("/api/status/") && req.method === "GET") {
        if (!checkBearer(req)) {
          json(res, 401, {
            ok: false,
            error: "Unauthorized — Bearer token required",
          });
          return;
        }
        const taskId = url.pathname.slice("/api/status/".length);
        const dispatch = pendingDispatches.get(taskId);
        if (!dispatch) {
          json(res, 200, { ok: true, taskId, status: "unknown" });
          return;
        }
        const isDone = dispatch.done === true;
        json(res, 200, {
          ok: true,
          taskId,
          status: isDone ? "done" : "pending",
          agent: dispatch.agent,
          sessionId: dispatch.sessionId,
          ...(isDone
            ? {
                result: dispatch.result || null,
                engineUsed: dispatch.engineUsed || null,
              }
            : {}),
          ts: dispatch.ts,
          elapsedMs: Date.now() - dispatch.ts,
        });
        return;
      }

      // GET /api/agents  — list known agents with tools, model, identity
      if (url.pathname === "/api/agents" && req.method === "GET") {
        if (!checkBearer(req)) {
          json(res, 401, {
            ok: false,
            error: "Unauthorized — Bearer token required",
          });
          return;
        }
        const cfg = loadConfig();
        const agents = cfg.agentRoster.length
          ? cfg.agentRoster.map((a) => ({
              ...a,
              tools: readAgentTools(a.id).tools,
            }))
          : (cfg.knownAgents || []).map((id) => ({
              id,
              tools: readAgentTools(id).tools,
            }));
        // Annotate each agent with live OpenCode status
        const enriched = agents.map((a) => ({
          ...a,
          online:
            activeOpenCodeAgents.has(a.id) &&
            activeOpenCodeAgents.get(a.id).online !== false,
          inOpenCode:
            activeOpenCodeAgents.has(a.id) &&
            !!activeOpenCodeAgents.get(a.id).since,
          openCodeSince: activeOpenCodeAgents.get(a.id)?.since || null,
          openCodeModel: activeOpenCodeAgents.get(a.id)?.model || null,
        }));
        json(res, 200, { ok: true, agents: enriched });
        return;
      }

      // GET /api/agents/opencode — who is currently in an OpenCode session
      if (url.pathname === "/api/agents/opencode" && req.method === "GET") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        const active = [...activeOpenCodeAgents.entries()].map(
          ([id, info]) => ({
            id,
            model: info.model,
            since: info.since,
            elapsedMs: Date.now() - info.since,
          }),
        );
        json(res, 200, { ok: true, count: active.length, agents: active });
        return;
      }

      // GET /api/background — background loop status: stalls, timeout patterns, ROADMAP state
      if (url.pathname === "/api/background" && req.method === "GET") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        const timeoutPatterns = [...agentTimeoutCounts.entries()].map(
          ([agent, count]) => ({ agent, count }),
        );
        const stalledPipelines = [...pendingPipelines.entries()]
          .filter(
            ([, p]) =>
              p._lastActivity && Date.now() - p._lastActivity > 15 * 60 * 1000,
          )
          .map(([id, p]) => ({
            id,
            staleMinutes: Math.round((Date.now() - p._lastActivity) / 60000),
            pendingTasks: p.pendingTaskIds.size,
          }));
        json(res, 200, {
          ok: true,
          activePipelines: pendingPipelines.size,
          stalledPipelines,
          timeoutPatterns,
        });
        return;
      }

      // GET /api/agents/:id/tools — read an agent's current tool permissions
      const toolsGetMatch = url.pathname.match(
        /^\/api\/agents\/([^/]+)\/tools$/,
      );
      if (toolsGetMatch && req.method === "GET") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        const agentId = toolsGetMatch[1];
        const result = readAgentTools(agentId);
        json(res, 200, {
          ok: true,
          agentId,
          tools: result.tools,
          source: result.source,
          allTools: [...crewswarmToolNames],
        });
        return;
      }

      // PATCH /api/agents/:id/tools — update an agent's tool permissions
      // Body: { "grant": ["write_file"], "revoke": ["run_cmd"] }  OR  { "set": ["read_file","write_file"] }
      const toolsPatchMatch = url.pathname.match(
        /^\/api\/agents\/([^/]+)\/tools$/,
      );
      if (toolsPatchMatch && req.method === "PATCH") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        const agentId = toolsPatchMatch[1];
        const body = await readBody(req);
        const current = readAgentTools(agentId).tools;
        let updated;
        if (Array.isArray(body.set)) {
          updated = body.set;
        } else {
          const granted = Array.isArray(body.grant) ? body.grant : [];
          const revoked = Array.isArray(body.revoke) ? body.revoke : [];
          updated = [
            ...new Set(
              [...current, ...granted].filter((t) => !revoked.includes(t)),
            ),
          ];
        }
        const saved = writeAgentTools(agentId, updated);
        console.log(
          `[crew-lead] tools updated for ${agentId}: ${saved.join(", ")}`,
        );
        json(res, 200, { ok: true, agentId, tools: saved });
        return;
      }

      // ── Inbound webhook receiver ───────────────────────────────────────────────
      // POST /webhook/:channel   — accepts any JSON payload, forwards to RT bus
      // No auth on this endpoint so external services can push without managing tokens.
      // Use a unique channel name per integration (e.g. /webhook/n8n, /webhook/stripe).
      const webhookMatch = url.pathname.match(/^\/webhook\/([a-zA-Z0-9_\-]+)$/);
      if (webhookMatch && req.method === "POST") {
        const channel = webhookMatch[1];
        let body = {};
        try {
          const raw = await readBody(req);
          body = raw ? JSON.parse(raw) : {};
        } catch {
          /* non-JSON body is fine */
        }
        const event = {
          type: "webhook",
          channel,
          payload: body,
          ts: Date.now(),
        };
        const rtPublish = getRtPublish();
        if (rtPublish) {
          rtPublish({
            channel: `webhook.${channel}`,
            type: "webhook.event",
            payload: event,
          });
          console.log(
            `[crew-lead] webhook → ${channel}: ${JSON.stringify(body).slice(0, 80)}`,
          );
        }
        broadcastSSE({
          type: "webhook_event",
          channel,
          payload: body,
          ts: Date.now(),
        });
        json(res, 200, { ok: true, channel, ts: Date.now() });
        return;
      }

      // ── Skills API ─────────────────────────────────────────────────────────────
      const SKILLS_DIR = path.join(os.homedir(), ".crewswarm", "skills");
      const PENDING_SKILLS_FILE = path.join(
        os.homedir(),
        ".crewswarm",
        "pending-skills.json",
      );

      // GET /api/skills — list installed skills (both API .json and SKILL.md knowledge skills)
      if (url.pathname === "/api/skills" && req.method === "GET") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        try {
          fs.mkdirSync(SKILLS_DIR, { recursive: true });
          const entries = fs.readdirSync(SKILLS_DIR);
          // API skills — .json files
          const apiSkills = entries
            .filter((f) => f.endsWith(".json"))
            .map((f) => {
              try {
                return {
                  name: f.replace(".json", ""),
                  type: "api",
                  ...JSON.parse(
                    fs.readFileSync(path.join(SKILLS_DIR, f), "utf8"),
                  ),
                };
              } catch {
                return {
                  name: f.replace(".json", ""),
                  type: "api",
                  error: "parse failed",
                };
              }
            });
          // Knowledge skills — folders containing SKILL.md
          const knowledgeSkills = entries
            .filter((f) => {
              const fpath = path.join(SKILLS_DIR, f);
              return (
                fs.statSync(fpath).isDirectory() &&
                fs.existsSync(path.join(fpath, "SKILL.md"))
              );
            })
            .map((f) => {
              try {
                const body = fs.readFileSync(
                  path.join(SKILLS_DIR, f, "SKILL.md"),
                  "utf8",
                );
                // Parse YAML frontmatter for name/description/aliases
                const fmMatch = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
                let name = f,
                  description = "",
                  aliases = [];
                if (fmMatch) {
                  const fm = fmMatch[1];
                  const nameM = fm.match(/^name:\s*(.+)$/m);
                  const descM = fm.match(/^description:\s*(.+)$/m);
                  const aliasM = fm.match(/^aliases:\s*\[(.+)\]/m);
                  if (nameM) name = nameM[1].trim().replace(/^['"]|['"]$/g, "");
                  if (descM)
                    description = descM[1].trim().replace(/^['"]|['"]$/g, "");
                  if (aliasM)
                    aliases = aliasM[1]
                      .split(",")
                      .map((a) => a.trim().replace(/^['"]|['"]$/g, ""));
                }
                return {
                  name,
                  type: "knowledge",
                  description,
                  aliases,
                  _folder: f,
                };
              } catch {
                return {
                  name: f,
                  type: "knowledge",
                  error: "parse failed",
                  _folder: f,
                };
              }
            });
          json(res, 200, {
            ok: true,
            skills: [...apiSkills, ...knowledgeSkills],
          });
        } catch (e) {
          json(res, 500, { ok: false, error: e.message });
        }
        return;
      }

      // POST /api/skills  { name, url, method, description, headers, auth, defaultParams, requiresApproval }
      if (url.pathname === "/api/skills" && req.method === "POST") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        const body = await readBody(req);
        if (!body.name || !body.url) {
          json(res, 400, { ok: false, error: "name and url required" });
          return;
        }
        fs.mkdirSync(SKILLS_DIR, { recursive: true });
        const { name, ...def } = body;
        fs.writeFileSync(
          path.join(SKILLS_DIR, `${name}.json`),
          JSON.stringify(def, null, 2),
        );
        json(res, 200, { ok: true, name });
        return;
      }

      // POST /api/skills/:name/run  — execute a skill from the dashboard (params in body)
      const skillRunMatch = url.pathname.match(
        /^\/api\/skills\/([a-zA-Z0-9_\-\.]+)\/run$/,
      );
      if (skillRunMatch && req.method === "POST") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        const skillName = resolveSkillAlias(skillRunMatch[1]);
        const skillFile = path.join(SKILLS_DIR, `${skillName}.json`);
        if (!fs.existsSync(skillFile)) {
          json(res, 404, { ok: false, error: "Skill not found" });
          return;
        }
        let skillDef;
        try {
          skillDef = JSON.parse(fs.readFileSync(skillFile, "utf8"));
        } catch (e) {
          json(res, 500, { ok: false, error: "Invalid skill JSON" });
          return;
        }
        let body = {};
        try {
          body = await readBody(req);
        } catch {}
        const bodyParams = body.params || body;
        const wantDiscovery =
          (typeof bodyParams === "object" &&
            Object.keys(bodyParams || {}).length === 0) ||
          (bodyParams && bodyParams.benchmark_id === "");
        let params =
          wantDiscovery && skillDef.listUrl
            ? {}
            : { ...(skillDef.defaultParams || {}), ...bodyParams };
        const aliases = skillDef.paramAliases || {};
        for (const [param, map] of Object.entries(aliases)) {
          if (params[param] != null && map[params[param]] != null)
            params[param] = map[params[param]];
        }
        const swarmCfg =
          tryRead(path.join(os.homedir(), ".crewswarm", "crewswarm.json")) ||
          {};
        let urlStr;
        const urlParam = (skillDef.url || "").match(/\{(\w+)\}/);
        const emptyKey = urlParam ? urlParam[1] : null;
        const paramEmpty =
          emptyKey &&
          (params[emptyKey] === undefined ||
            params[emptyKey] === null ||
            String(params[emptyKey] || "").trim() === "");
        if (skillDef.listUrl && (wantDiscovery || paramEmpty)) {
          urlStr = skillDef.listUrl;
        } else {
          urlStr = skillDef.url || "";
          for (const [k, v] of Object.entries(params))
            urlStr = urlStr.replace(`{${k}}`, encodeURIComponent(String(v)));
        }
        const headers = {
          "Content-Type": "application/json",
          ...(skillDef.headers || {}),
        };
        if (skillDef.auth) {
          const auth = skillDef.auth;
          let token = auth.token || "";
          if (auth.keyFrom) {
            if (auth.keyFrom.startsWith("env."))
              token = process.env[auth.keyFrom.slice(4)] || "";
            else {
              let val = swarmCfg;
              for (const p of auth.keyFrom.split(".")) val = val?.[p];
              if (val) token = String(val);
            }
          }
          if (token) {
            if (auth.type === "bearer" || !auth.type)
              headers["Authorization"] = `Bearer ${token}`;
            else if (auth.type === "header")
              headers[auth.header || "X-API-Key"] = token;
          }
        }
        const method = (skillDef.method || "POST").toUpperCase();
        const reqOpts = {
          method,
          headers,
          signal: AbortSignal.timeout(skillDef.timeout || 30000),
        };
        if (method !== "GET" && method !== "HEAD")
          reqOpts.body = JSON.stringify(params);
        try {
          const r = await fetch(urlStr, reqOpts);
          const text = await r.text();
          if (!r.ok) {
            json(res, 502, {
              ok: false,
              error: `Upstream ${r.status}: ${text.slice(0, 200)}`,
            });
            return;
          }
          try {
            json(res, 200, { ok: true, result: JSON.parse(text) });
          } catch {
            json(res, 200, { ok: true, result: { response: text } });
          }
        } catch (e) {
          json(res, 502, { ok: false, error: e.message });
        }
        return;
      }

      // DELETE /api/skills/:name
      const skillDeleteMatch = url.pathname.match(
        /^\/api\/skills\/([a-zA-Z0-9_\-\.]+)$/,
      );
      if (skillDeleteMatch && req.method === "DELETE") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        const skillName = skillDeleteMatch[1];
        const skillFile = path.join(SKILLS_DIR, `${skillName}.json`);
        const skillFolder = path.join(SKILLS_DIR, skillName);
        if (fs.existsSync(skillFile)) {
          fs.unlinkSync(skillFile);
          json(res, 200, { ok: true });
        } else if (
          fs.existsSync(skillFolder) &&
          fs.existsSync(path.join(skillFolder, "SKILL.md"))
        ) {
          fs.rmSync(skillFolder, { recursive: true, force: true });
          json(res, 200, { ok: true });
        } else {
          json(res, 404, { ok: false, error: "Skill not found" });
        }
        return;
      }

      // POST /api/skills/approve  { approvalId }  — approve a pending skill call
      if (url.pathname === "/api/skills/approve" && req.method === "POST") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        const body = await readBody(req);
        const { approvalId } = body;
        let pending = {};
        try {
          pending = JSON.parse(fs.readFileSync(PENDING_SKILLS_FILE, "utf8"));
        } catch {}
        const entry = pending[approvalId];
        if (!entry) {
          json(res, 404, {
            ok: false,
            error: "Approval ID not found or expired",
          });
          return;
        }
        delete pending[approvalId];
        fs.writeFileSync(PENDING_SKILLS_FILE, JSON.stringify(pending, null, 2));
        // Execute the skill via the gateway bridge process is impractical from here;
        // instead, push approved result to RT bus so agent can see it
        broadcastSSE({
          type: "skill_approved",
          approvalId,
          skillName: entry.skillName,
          agentId: entry.agentId,
          ts: Date.now(),
        });
        console.log(
          `[crew-lead] skill approved: ${entry.skillName} (${approvalId}) — notifying bridge agents`,
        );
        const rtPublish = getRtPublish();
        if (rtPublish) {
          rtPublish({
            channel: "skill.approved",
            type: "skill.approved",
            payload: {
              approvalId,
              skillName: entry.skillName,
              agentId: entry.agentId,
              params: entry.params,
            },
          });
        }
        json(res, 200, { ok: true, approvalId, skillName: entry.skillName });
        return;
      }

      // POST /api/skills/reject  { approvalId }
      if (url.pathname === "/api/skills/reject" && req.method === "POST") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        const body = await readBody(req);
        const { approvalId } = body;
        let pending = {};
        try {
          pending = JSON.parse(fs.readFileSync(PENDING_SKILLS_FILE, "utf8"));
        } catch {}
        delete pending[approvalId];
        try {
          fs.writeFileSync(
            PENDING_SKILLS_FILE,
            JSON.stringify(pending, null, 2),
          );
        } catch {}
        broadcastSSE({ type: "skill_rejected", approvalId, ts: Date.now() });
        json(res, 200, { ok: true, approvalId });
        return;
      }

      // ── Spending caps API ──────────────────────────────────────────────────────
      const SPENDING_FILE = path.join(
        os.homedir(),
        ".crewswarm",
        "spending.json",
      );

      // GET /api/spending — today's usage across global + per-agent
      if (url.pathname === "/api/spending" && req.method === "GET") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        let spending = {
          date: new Date().toISOString().slice(0, 10),
          global: { tokens: 0, costUSD: 0 },
          agents: {},
        };
        try {
          spending = JSON.parse(fs.readFileSync(SPENDING_FILE, "utf8"));
        } catch {}
        // Attach caps config
        let caps = {};
        try {
          const cfg = JSON.parse(
            fs.readFileSync(
              path.join(os.homedir(), ".crewswarm", "crewswarm.json"),
              "utf8",
            ),
          );
          caps.global = cfg.globalSpendingCaps || {};
          caps.agents = (cfg.agents || []).reduce((acc, a) => {
            if (a.spending) acc[a.id] = a.spending;
            return acc;
          }, {});
        } catch {}
        json(res, 200, { ok: true, spending, caps });
        return;
      }

      // GET/POST /api/settings/bg-consciousness — toggle background consciousness at runtime
      if (url.pathname === "/api/settings/bg-consciousness") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        if (req.method === "GET") {
          json(res, 200, {
            ok: true,
            enabled: bgConsciousnessRef.enabled,
            intervalMs: bgConsciousnessIntervalMs,
            model: bgConsciousnessRef.model,
          });
          return;
        }
        if (req.method === "POST") {
          const body = await readBody(req);
          const enable =
            typeof body.enabled === "boolean"
              ? body.enabled
              : !bgConsciousnessRef.enabled;
          bgConsciousnessRef.enabled = enable;
          if (body.model && typeof body.model === "string")
            bgConsciousnessRef.model = body.model.trim();
          // Persist to config.json so it survives restarts
          try {
            const cfgPath = path.join(
              os.homedir(),
              ".crewswarm",
              "config.json",
            );
            const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
            cfg.bgConsciousness = enable;
            if (body.model) cfg.bgConsciousnessModel = bgConsciousnessRef.model;
            fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
          } catch (e) {
            console.warn(
              "[crew-lead] Could not persist bgConsciousness:",
              e.message,
            );
          }
          console.log(
            `[crew-lead] Background consciousness ${enable ? "ENABLED" : "DISABLED"} model=${bgConsciousnessRef.model} via dashboard`,
          );
          if (enable) bgConsciousnessRef.lastActivityAt = 0;
          json(res, 200, {
            ok: true,
            enabled: bgConsciousnessRef.enabled,
            model: bgConsciousnessRef.model,
          });
          return;
        }
      }

      // GET /api/claude-sessions — list + read Claude Code session history
      // ?dir=<project-path>  (default: current repo)  &limit=20
      if (url.pathname === "/api/claude-sessions" && req.method === "GET") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        try {
          const qDir = url.searchParams.get("dir") || process.cwd();
          const limit = Math.min(
            Number(url.searchParams.get("limit") || "20"),
            100,
          );
          // Claude stores projects as path-with-dashes: /Users/foo/bar → -Users-foo-bar
          const dirKey = qDir.replace(/\//g, "-");
          const projectsBase = path.join(os.homedir(), ".claude", "projects");
          const candidates = fs.existsSync(projectsBase)
            ? fs
                .readdirSync(projectsBase)
                .filter(
                  (d) =>
                    d === dirKey ||
                    d.endsWith(dirKey.split("-").slice(-2).join("-")),
                )
            : [];
          const sessions = [];
          for (const cand of candidates) {
            const sessDir = path.join(projectsBase, cand);
            const files = fs
              .readdirSync(sessDir)
              .filter((f) => f.endsWith(".jsonl"))
              .map((f) => ({
                f,
                mt: fs.statSync(path.join(sessDir, f)).mtimeMs,
              }))
              .sort((a, b) => b.mt - a.mt)
              .slice(0, limit)
              .map((x) => x.f);
            for (const file of files) {
              const sessionId = file.replace(".jsonl", "");
              const messages = [];
              const lines = fs
                .readFileSync(path.join(sessDir, file), "utf8")
                .trim()
                .split("\n");
              for (const line of lines) {
                try {
                  const d = JSON.parse(line);
                  if (d.type !== "user" && d.type !== "assistant") continue;
                  const content = d.message?.content;
                  const text = Array.isArray(content)
                    ? content
                        .filter((c) => c.type === "text")
                        .map((c) => c.text)
                        .join("")
                    : typeof content === "string"
                      ? content
                      : "";
                  if (text)
                    messages.push({
                      role: d.type,
                      text: text.slice(0, 2000),
                      ts: d.timestamp,
                    });
                } catch {}
              }
              if (messages.length) sessions.push({ sessionId, file, messages });
            }
          }
          json(res, 200, { ok: true, dir: qDir, sessions });
        } catch (e) {
          json(res, 200, { ok: true, sessions: [], error: e.message });
        }
        return;
      }

      // GET /api/opencode-sessions — list + read OpenCode session history from SQLite
      // ?limit=10&session=<id>
      if (url.pathname === "/api/opencode-sessions" && req.method === "GET") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        try {
          const { execSync } = await import("node:child_process");
          const dbPath = path.join(
            os.homedir(),
            ".local",
            "share",
            "opencode",
            "opencode.db",
          );
          if (!fs.existsSync(dbPath)) {
            json(res, 200, {
              ok: true,
              sessions: [],
              error: "opencode.db not found",
            });
            return;
          }
          const limit = Math.min(
            Number(url.searchParams.get("limit") || "10"),
            50,
          );
          const sessionFilter = url.searchParams.get("session") || "";

          // List sessions
          const sessRows = execSync(
            `sqlite3 "${dbPath}" "SELECT s.id, s.title, s.time_updated, count(m.id) as msg_count FROM session s LEFT JOIN message m ON m.session_id=s.id ${sessionFilter ? `WHERE s.id='${sessionFilter}'` : ""} GROUP BY s.id ORDER BY s.time_updated DESC LIMIT ${limit};"`,
            { encoding: "utf8" },
          )
            .trim()
            .split("\n")
            .filter(Boolean);

          const sessions = [];
          for (const row of sessRows) {
            const [id, title, timeUpdated, msgCount] = row.split("|");
            // Get parts (actual message content) for this session
            const partRows = execSync(
              `sqlite3 "${dbPath}" "SELECT p.data FROM part p JOIN message m ON p.message_id=m.id WHERE m.session_id='${id}' ORDER BY p.time_created LIMIT 100;"`,
              { encoding: "utf8" },
            )
              .trim()
              .split("\n")
              .filter(Boolean);

            const messages = [];
            let currentRole = null;
            // Group parts by message
            const msgRows = execSync(
              `sqlite3 "${dbPath}" "SELECT m.id, m.data FROM message m WHERE m.session_id='${id}' ORDER BY m.time_created;"`,
              { encoding: "utf8" },
            )
              .trim()
              .split("\n")
              .filter(Boolean);

            for (const mrow of msgRows) {
              const [mid, mdata] = mrow.split("|");
              try {
                const md = JSON.parse(mdata);
                const role = md.role;
                // Get text parts for this message
                const textParts = execSync(
                  `sqlite3 "${dbPath}" "SELECT data FROM part WHERE message_id='${mid}' AND json_extract(data,'$.type')='text';"`,
                  { encoding: "utf8" },
                )
                  .trim()
                  .split("\n")
                  .filter(Boolean);
                const text = textParts
                  .map((p) => {
                    try {
                      return JSON.parse(p).text || "";
                    } catch {
                      return "";
                    }
                  })
                  .join("")
                  .trim();
                const cost = md.cost || 0;
                const tokens = md.tokens || {};
                if (text)
                  messages.push({
                    role,
                    text: text.slice(0, 2000),
                    cost,
                    tokens,
                  });
              } catch {}
            }
            sessions.push({
              id,
              title,
              timeUpdated: Number(timeUpdated),
              msgCount: Number(msgCount),
              messages,
            });
          }
          json(res, 200, { ok: true, sessions });
        } catch (e) {
          json(res, 200, { ok: true, sessions: [], error: e.message });
        }
        return;
      }

      // GET /api/codex-sessions — list Codex CLI session history from ~/.codex/sessions
      // ?limit=10
      if (url.pathname === "/api/codex-sessions" && req.method === "GET") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        try {
          const limit = Math.min(
            Number(url.searchParams.get("limit") || "20"),
            50,
          );
          const sessionsBase = path.join(os.homedir(), ".codex", "sessions");
          const sessions = [];
          if (fs.existsSync(sessionsBase)) {
            // Walk YYYY/MM/DD structure
            const years = fs.readdirSync(sessionsBase).filter(d => /^\d{4}$/.test(d));
            for (const year of years.sort().reverse()) {
              const yearDir = path.join(sessionsBase, year);
              const months = fs.readdirSync(yearDir).filter(d => /^\d{2}$/.test(d));
              for (const month of months.sort().reverse()) {
                const monthDir = path.join(yearDir, month);
                const days = fs.readdirSync(monthDir).filter(d => /^\d{2}$/.test(d));
                for (const day of days.sort().reverse()) {
                  const dayDir = path.join(yearDir, month, day);
                  const files = fs.readdirSync(dayDir)
                    .filter(f => f.endsWith(".jsonl"))
                    .map(f => ({ f, mt: fs.statSync(path.join(dayDir, f)).mtimeMs }))
                    .sort((a, b) => b.mt - a.mt);
                  for (const { f } of files) {
                    if (sessions.length >= limit) break;
                    const sessionId = f.replace(".jsonl", "");
                    const messages = [];
                    const lines = fs.readFileSync(path.join(dayDir, f), "utf8").trim().split("\n");
                    let firstUserMsg = "";
                    for (const line of lines) {
                      try {
                        const ev = JSON.parse(line);
                        if (ev.type === "item.completed" && ev.item) {
                          const role = ev.item.type === "agent_message" ? "assistant" : "user";
                          const text = ev.item.text || "";
                          if (role === "user" && !firstUserMsg) firstUserMsg = text.slice(0, 80);
                          if (text) messages.push({ role, text: text.slice(0, 2000), ts: ev.timestamp });
                        }
                      } catch {}
                    }
                    if (messages.length) {
                      sessions.push({
                        id: sessionId,
                        title: firstUserMsg || sessionId,
                        file: path.join(year, month, day, f),
                        messages,
                      });
                    }
                  }
                  if (sessions.length >= limit) break;
                }
                if (sessions.length >= limit) break;
              }
              if (sessions.length >= limit) break;
            }
          }
          json(res, 200, { ok: true, sessions });
        } catch (e) {
          json(res, 200, { ok: true, sessions: [], error: e.message });
        }
        return;
      }

      // GET /api/gemini-sessions — list Gemini CLI session history from ~/.gemini/history
      // ?limit=10
      if (url.pathname === "/api/gemini-sessions" && req.method === "GET") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        try {
          const limit = Math.min(
            Number(url.searchParams.get("limit") || "20"),
            50,
          );
          const historyBase = path.join(os.homedir(), ".gemini", "history");
          const sessions = [];
          if (fs.existsSync(historyBase)) {
            const projects = fs.readdirSync(historyBase);
            for (const proj of projects) {
              const sessionFile = path.join(historyBase, proj, "session.jsonl");
              if (fs.existsSync(sessionFile)) {
                const messages = [];
                const lines = fs.readFileSync(sessionFile, "utf8").trim().split("\n");
                let firstUserMsg = "";
                for (const line of lines) {
                  try {
                    const ev = JSON.parse(line);
                    if (ev.type === "message") {
                      const role = ev.role || "user";
                      const text = ev.content || "";
                      if (role === "user" && !firstUserMsg) firstUserMsg = text.slice(0, 80);
                      if (text) messages.push({ role, text: text.slice(0, 2000), ts: ev.timestamp });
                    }
                  } catch {}
                }
                if (messages.length) {
                  const stat = fs.statSync(sessionFile);
                  sessions.push({
                    id: proj,
                    title: firstUserMsg || proj,
                    file: sessionFile,
                    messages,
                    timeUpdated: stat.mtimeMs,
                  });
                }
              }
            }
            sessions.sort((a, b) => (b.timeUpdated || 0) - (a.timeUpdated || 0));
          }
          json(res, 200, { ok: true, sessions: sessions.slice(0, limit) });
        } catch (e) {
          json(res, 200, { ok: true, sessions: [], error: e.message });
        }
        return;
      }

      // GET /api/crew-cli-sessions — list crew-cli session history from .crew/sessions
      // ?limit=10
      if (url.pathname === "/api/crew-cli-sessions" && req.method === "GET") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        try {
          const limit = Math.min(
            Number(url.searchParams.get("limit") || "20"),
            50,
          );
          const sessionsBase = path.join(process.cwd(), ".crew", "sessions");
          const sessions = [];
          if (fs.existsSync(sessionsBase)) {
            // Walk engine/project/sessions/YYYY/MM/DD
            const engines = fs.readdirSync(sessionsBase);
            for (const engine of engines) {
              const engineDir = path.join(sessionsBase, engine);
              const projects = fs.readdirSync(engineDir);
              for (const project of projects) {
                const projectSessionsDir = path.join(engineDir, project, "sessions");
                if (!fs.existsSync(projectSessionsDir)) continue;
                const years = fs.readdirSync(projectSessionsDir).filter(d => /^\d{4}$/.test(d));
                for (const year of years.sort().reverse()) {
                  const yearDir = path.join(projectSessionsDir, year);
                  const months = fs.readdirSync(yearDir).filter(d => /^\d{2}$/.test(d));
                  for (const month of months.sort().reverse()) {
                    const monthDir = path.join(yearDir, month);
                    const days = fs.readdirSync(monthDir).filter(d => /^\d{2}$/.test(d));
                    for (const day of days.sort().reverse()) {
                      const dayDir = path.join(yearDir, month, day);
                      const files = fs.readdirSync(dayDir)
                        .filter(f => f.endsWith(".jsonl"))
                        .map(f => ({ f, mt: fs.statSync(path.join(dayDir, f)).mtimeMs }))
                        .sort((a, b) => b.mt - a.mt);
                      for (const { f } of files) {
                        if (sessions.length >= limit) break;
                        const sessionId = f.replace(".jsonl", "");
                        const messages = [];
                        const lines = fs.readFileSync(path.join(dayDir, f), "utf8").trim().split("\n");
                        let firstUserMsg = "";
                        for (const line of lines) {
                          try {
                            const ev = JSON.parse(line);
                            if (ev.type === "item.completed" && ev.item) {
                              const role = ev.item.type === "agent_message" ? "assistant" : "user";
                              const text = ev.item.text || "";
                              if (role === "user" && !firstUserMsg) firstUserMsg = text.slice(0, 80);
                              if (text) messages.push({ role, text: text.slice(0, 2000), ts: ev.timestamp });
                            }
                          } catch {}
                        }
                        if (messages.length) {
                          sessions.push({
                            id: `${engine}/${project}/${sessionId}`,
                            title: firstUserMsg || sessionId,
                            engine,
                            project,
                            file: path.join(year, month, day, f),
                            messages,
                          });
                        }
                      }
                      if (sessions.length >= limit) break;
                    }
                    if (sessions.length >= limit) break;
                  }
                  if (sessions.length >= limit) break;
                }
              }
            }
          }
          json(res, 200, { ok: true, sessions });
        } catch (e) {
          json(res, 200, { ok: true, sessions: [], error: e.message });
        }
        return;
      }

      // GET /api/agent-transcripts/recent — read most recent Cursor agent transcript(s)
      if (
        url.pathname === "/api/agent-transcripts/recent" &&
        req.method === "GET"
      ) {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        try {
          const transcriptsDir = path.join(
            os.homedir(),
            ".cursor",
            "projects",
            fs
              .readdirSync(path.join(os.homedir(), ".cursor", "projects"))
              .filter((d) => d.includes("crewswarm"))
              .sort()
              .pop() || "",
            "agent-transcripts",
          );
          const files = fs.existsSync(transcriptsDir)
            ? fs
                .readdirSync(transcriptsDir)
                .filter((f) => f.endsWith(".jsonl"))
                .map((f) => ({
                  f,
                  mt: fs.statSync(path.join(transcriptsDir, f)).mtimeMs,
                }))
                .sort((a, b) => b.mt - a.mt)
                .slice(0, 3)
                .map((x) => x.f)
            : [];
          const messages = [];
          for (const file of files) {
            const lines = fs
              .readFileSync(path.join(transcriptsDir, file), "utf8")
              .trim()
              .split("\n");
            for (const line of lines) {
              try {
                const d = JSON.parse(line);
                const role = d.role || "";
                const content = d.message?.content || [];
                const text = Array.isArray(content)
                  ? content
                      .filter((c) => c.type === "text")
                      .map((c) => c.text)
                      .join("")
                  : String(content);
                // Strip system wrapper tags
                const clean = text
                  .replace(/<user_query>/g, "")
                  .replace(/<\/user_query>/g, "")
                  .trim();
                if (clean) messages.push({ role, text: clean });
              } catch {}
            }
          }
          json(res, 200, { ok: true, messages: messages.slice(-40) }); // last 40 turns
        } catch (e) {
          json(res, 200, { ok: true, messages: [], error: e.message });
        }
        return;
      }

      // POST /api/engine-passthrough — stream a message directly to Cursor CLI, Claude Code, OpenCode, or Codex
      // Body: { engine: "cursor"|"claude"|"opencode"|"codex", message: string, projectDir?: string, sessionId?: string, injectHistory?: boolean, model?: string }
      // Streams raw output back as SSE: data: {"type":"chunk","text":"..."} then data: {"type":"done"}
      if (url.pathname === "/api/engine-passthrough" && req.method === "POST") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        let body = "";
        for await (const chunk of req) body += chunk;
        const {
          engine = "cursor",
          message,
          projectDir: reqProjectDir,
          sessionId: reqSessionId,
          injectHistory,
          model: reqModel,
        } = JSON.parse(body || "{}");
        if (!message) {
          json(res, 400, { ok: false, error: "message required" });
          return;
        }

        console.log(
          `[Passthrough] engine=${engine} projectDir=${reqProjectDir || "undefined"} sessionId=${reqSessionId || "undefined"}`,
        );

        // Optionally prepend recent Cursor agent chat history as context
        const enriched = await enrichTwitterLinks(message, {
          source: `crew-lead:engine-${engine}`,
        });
        let finalMessage = enriched.text;
        if (injectHistory) {
          try {
            const transcriptsDir = path.join(
              os.homedir(),
              ".cursor",
              "projects",
              fs
                .readdirSync(path.join(os.homedir(), ".cursor", "projects"))
                .filter((d) => d.includes("crewswarm"))
                .sort()
                .pop() || "",
              "agent-transcripts",
            );
            if (fs.existsSync(transcriptsDir)) {
              const files = fs
                .readdirSync(transcriptsDir)
                .filter((f) => f.endsWith(".jsonl"))
                .map((f) => ({
                  f,
                  mt: fs.statSync(path.join(transcriptsDir, f)).mtimeMs,
                }))
                .sort((a, b) => b.mt - a.mt)
                .slice(0, 2)
                .map((x) => x.f);
              const lines = [];
              for (const file of files) {
                const raw = fs
                  .readFileSync(path.join(transcriptsDir, file), "utf8")
                  .trim()
                  .split("\n");
                for (const l of raw) {
                  try {
                    const d = JSON.parse(l);
                    const role = d.role || "";
                    const content = d.message?.content || [];
                    const text = Array.isArray(content)
                      ? content
                          .filter((c) => c.type === "text")
                          .map((c) => c.text)
                          .join("")
                      : String(content);
                    const clean = text
                      .replace(/<user_query>/g, "")
                      .replace(/<\/user_query>/g, "")
                      .trim();
                    if (clean) lines.push(`[${role}]: ${clean.slice(0, 600)}`);
                  } catch {}
                }
              }
              if (lines.length) {
                finalMessage = `[Recent Cursor agent chat context — use as background only]\n${lines.slice(-20).join("\n")}\n\n[Current request]\n${enriched.text}`;
              }
            }
          } catch {}
        }

        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "access-control-allow-origin": "*",
          connection: "keep-alive",
        });
        const send = (obj) => {
          try {
            res.write(`data: ${JSON.stringify(obj)}\n\n`);
          } catch {}
        };

        // Determine working directory:
        // 1. Use reqProjectDir if provided (from Chat project dropdown)
        // 2. Fall back to Settings opencode-project if no Chat project selected
        // 3. Final fallback to process.cwd()
        let projectDir = reqProjectDir;
        if (!projectDir) {
          try {
            const cfg = JSON.parse(
              fs.readFileSync(
                path.join(os.homedir(), ".crewswarm", "config.json"),
                "utf8",
              ),
            );
            projectDir = cfg.settings?.opencodeProject || process.cwd();
          } catch {
            projectDir = process.cwd();
          }
        }

        if (!projectDir || !fs.existsSync(projectDir)) {
          projectDir = process.cwd();
        }

        const sessionScope = reqSessionId || "default";

        let bin, args;
        const continueSession =
          req.headers["x-passthrough-continue"] !== "false"; // default on

        // Session ID store — persisted to disk so restarts don't lose context
        const _sessionStoreFile = path.join(
          os.homedir(),
          ".crewswarm",
          "passthrough-sessions.json",
        );
        if (!global._passthroughSessions) {
          try {
            global._passthroughSessions = JSON.parse(
              fs.readFileSync(_sessionStoreFile, "utf8"),
            );
          } catch {
            global._passthroughSessions = {};
          }
        }
        const _savePassthroughSessions = () => {
          try {
            fs.writeFileSync(
              _sessionStoreFile,
              JSON.stringify(global._passthroughSessions, null, 2),
            );
          } catch {}
        };
        // Build session key with engine + projectDir + sessionScope for parallel sessions
        const sessionKey = (engineId) =>
          `${engineId}:${projectDir}:${sessionScope}`;
        // Legacy in-memory aliases (kept for backward compat with Gemini/Codex refs below)
        global._geminiSessionIds = global._passthroughSessions;
        if (!global._codexHasPriorSession) global._codexHasPriorSession = {};
        if (engine === "cursor") {
          const cursorBin = resolveCliBinary(process.env.CURSOR_CLI_BIN || "cursor", [
            path.join(os.homedir(), ".local", "bin", "cursor"),
            path.join(os.homedir(), ".local", "bin", "agent"),
            "/usr/local/bin/cursor",
            "/opt/homebrew/bin/cursor",
          ]);
          bin = cursorBin;
          args = [
            "agent",
            "--print",
            "--yolo",
            "--trust",
            "--output-format",
            "stream-json",
          ];
          // Default to Gemini 3 Flash if no model specified (avoids Claude rate limits)
          const cursorModel =
            reqModel || process.env.CURSOR_DEFAULT_MODEL || "gemini-3-flash";
          args.push("--model", cursorModel);
          // Add workspace directory context
          if (projectDir) args.push("--add", projectDir);
          args.push(finalMessage);
        } else if (engine === "opencode") {
          bin = resolveCliBinary(process.env.CREWSWARM_OPENCODE_BIN || "opencode", [
            path.join(os.homedir(), ".opencode", "bin", "opencode"),
            "/usr/local/bin/opencode",
            "/opt/homebrew/bin/opencode",
          ]);
          const ocModel =
            reqModel ||
            process.env.CREWSWARM_OPENCODE_MODEL ||
            "groq/moonshotai/kimi-k2-instruct-0905";
          args = ["run", finalMessage, "--model", ocModel];
          // Add workspace directory context
          if (projectDir) args.push("--dir", projectDir);
          if (continueSession) args.push("--continue");
        } else if (engine === "codex") {
          bin = resolveCliBinary(process.env.CODEX_CLI_BIN || "codex", [
            "/usr/local/bin/codex",
            "/opt/homebrew/bin/codex",
          ]);
          const codexKey = sessionKey("codex");

          args = [
            "-a",
            "never",
            "exec",
            "--sandbox",
            "workspace-write",
            "--skip-git-repo-check",
            "--color",
            "never",
            "--json",
          ];
          if (reqModel) args.push("--model", reqModel);
          if (projectDir) args.push("-C", projectDir);
          args.push(finalMessage);

          // Mark session as active (keyed by project + scope for consistency, even though Codex itself doesn't isolate)
          global._passthroughSessions[codexKey] = {
            projectDir,
            sessionScope,
            createdAt: Date.now(),
            lastUsed: Date.now(),
          };
          _savePassthroughSessions();
        } else if (engine === "gemini" || engine === "gemini-cli") {
          bin = resolveCliBinary(process.env.GEMINI_CLI_BIN || "gemini", [
            "/usr/local/bin/gemini",
            "/opt/homebrew/bin/gemini",
          ]);
          const geminiModel =
            reqModel || process.env.CREWSWARM_GEMINI_CLI_MODEL || null;
          const geminiKey = sessionKey("gemini");
          const priorGeminiSession =
            continueSession && global._passthroughSessions[geminiKey];
          // --approval-mode yolo = auto-approve all tool calls (file writes, shell) without blocking prompts
          args = [
            "-p",
            finalMessage,
            "--output-format",
            "stream-json",
            "--approval-mode",
            "yolo",
          ];
          if (geminiModel) args.push("-m", geminiModel);
          // Add workspace directory to allow file operations in projectDir (gemini uses --include-directories)
          if (projectDir) args.push("--include-directories", projectDir);
          // Use stored session ID for continuity — avoids "No previous sessions found" crash
          if (priorGeminiSession) args.push("--resume", priorGeminiSession);
        } else if (engine === "crew-cli") {
          bin = resolveCliBinary(process.env.CREW_CLI_BIN || "crew", [
            path.join(process.cwd(), "crew-cli", "bin", "crew.js"),
          ]);
          const crewCliModel =
            reqModel || process.env.CREWSWARM_CREW_CLI_MODEL || null;
          if (bin.endsWith(".js")) {
            args = [bin, "chat", finalMessage, "--direct", "--json"];
            bin = process.execPath;
          } else {
            args = ["chat", finalMessage, "--direct", "--json"];
          }
          if (crewCliModel) args.push("--model", crewCliModel);
          if (projectDir && projectDir !== process.cwd())
            args.push("--project", projectDir);
        } else if (engine === "antigravity") {
          bin = process.env.CREWSWARM_OPENCODE_BIN || "opencode";
          const agModel =
            process.env.CREWSWARM_ANTIGRAVITY_MODEL ||
            "google/antigravity-gemini-3-pro";
          args = ["run", finalMessage, "--model", agModel];
          if (continueSession) args.push("--continue");
        } else if (engine === "docker-sandbox") {
          bin = "docker";
          const sandboxName =
            process.env.CREWSWARM_DOCKER_SANDBOX_NAME || "crewswarm";
          const innerEngine = (
            process.env.CREWSWARM_DOCKER_SANDBOX_INNER_ENGINE || "claude"
          ).toLowerCase();
          let innerArgs;
          if (innerEngine === "opencode") {
            innerArgs = ["opencode", "run", finalMessage];
          } else if (innerEngine === "codex") {
            innerArgs = [
              "codex",
              "exec",
              "--sandbox",
              "workspace-write",
              "--json",
              finalMessage,
            ];
          } else {
            innerArgs = [
              "claude",
              "-p",
              "--dangerously-skip-permissions",
              "--output-format",
              "stream-json",
              "--verbose",
              finalMessage,
            ];
          }
          args = ["sandbox", "exec", sandboxName, "--", ...innerArgs];
        } else {
          bin = resolveCliBinary(process.env.CLAUDE_CODE_BIN || "claude", [
            path.join(os.homedir(), ".local", "bin", "claude"),
            "/usr/local/bin/claude",
            "/opt/homebrew/bin/claude",
          ]);
          args = [
            "-p",
            "--setting-sources",
            "user",
            "--dangerously-skip-permissions",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
          ];
          if (projectDir) args.push("--add-dir", projectDir);
          if (reqModel) args.push("--model", reqModel);
          if (continueSession) args.push("--continue");
          args.push(finalMessage);
        }

        send({ type: "start", engine, message: message.slice(0, 80) });
        let streamClosed = false;
        const closeStream = (exitCode) => {
          if (streamClosed) return;
          streamClosed = true;
          send({ type: "done", exitCode });
          try {
            res.end();
          } catch {}
        };
        const { spawn: _spawn } = await import("node:child_process");

        ({ bin, args } = wrapScriptBinary(bin, args));

        console.log(
          `[engine-passthrough] spawn ${engine}: ${bin} ${args.join(" ")}`,
        );

        const spawnCwd =
          engine === "claude" && projectDir ? "/tmp" : projectDir;

        const proc = _spawn(bin, args, {
          cwd: spawnCwd,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let lineBuffer = "";
        let fullOutput = "";
        let receivedStreamDeltas = false; // track whether incremental deltas arrived

        const passthroughTimeoutMs = Number(
          process.env.CREWSWARM_PASSTHROUGH_TIMEOUT_MS || "240000",
        );
        const passthroughWatchdog = setTimeout(() => {
          send({
            type: "stderr",
            text: `[engine-passthrough] timeout after ${passthroughTimeoutMs}ms (${engine})`,
          });
          try {
            proc.kill("SIGKILL");
          } catch {}
        }, passthroughTimeoutMs);

        const handleChunk = (chunk) => {
          lineBuffer += chunk.toString();
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.trim()) continue;
            if (engine === "opencode" || engine === "antigravity") {
              send({ type: "chunk", text: line + "\n" });
              fullOutput += line + "\n";
              continue;
            }
            // crew-cli JSON handling - collect entire output, don't stream it
            if (engine === "crew-cli") {
              // Don't send chunks yet - we'll parse and send the response field at the end
              fullOutput += line + "\n";
              continue;
            }
            try {
              const ev = JSON.parse(line);
              // Gemini CLI stream-json events:
              //   { type: "init", sessionId, model }
              // Real stream-json schema (from @google/gemini-cli nonInteractiveCli.js):
              //   init:        { type:"init", timestamp, session_id, model }
              //   message:     { type:"message", role:"assistant"|"user", content:"text", delta:true }
              //   tool_use:    { type:"tool_use", tool_name, tool_id, parameters }
              //   tool_result: { type:"tool_result", tool_id, status, output, error }
              //   result:      { type:"result", status:"success", stats:{...} }  — NO response field
              //   error:       { type:"error", severity, message }
              if (engine === "gemini" || engine === "gemini-cli") {
                if (ev.type === "init" && (ev.session_id || ev.sessionId)) {
                  // Persist session ID so next call (and restarts) can resume for context continuity
                  const sid = ev.session_id || ev.sessionId;
                  global._passthroughSessions[sessionKey("gemini")] = sid;
                  _savePassthroughSessions();
                } else if (
                  ev.type === "message" &&
                  ev.role === "assistant" &&
                  ev.content
                ) {
                  send({ type: "chunk", text: ev.content });
                  fullOutput += ev.content;
                } else if (ev.type === "result") {
                  proc.kill("SIGTERM");
                } else if (ev.type === "error") {
                  send({
                    type: "stderr",
                    text: ev.message || JSON.stringify(ev),
                  });
                }
                continue;
              }
              // Codex CLI --json events (actual format):
              //   { type: "thread.started", thread_id: "..." }
              //   { type: "turn.started" }
              //   { type: "item.completed", item: { type: "reasoning", text: "..." } }  — skip
              //   { type: "item.completed", item: { type: "agent_message", text: "..." } }  — this is the reply
              //   { type: "turn.completed", usage: {...} }
              if (engine === "codex") {
                if (
                  ev.type === "item.completed" &&
                  ev.item?.type === "agent_message" &&
                  ev.item?.text
                ) {
                  send({ type: "chunk", text: ev.item.text });
                  fullOutput += ev.item.text;
                } else if (ev.type === "turn.completed") {
                  proc.kill("SIGTERM");
                }
                continue;
              }
              if (
                ev.type === "stream_event" &&
                ev.event?.type === "content_block_delta"
              ) {
                const t = ev.event.delta?.text || "";
                if (t) {
                  send({ type: "chunk", text: t });
                  fullOutput += t;
                  receivedStreamDeltas = true;
                }
              } else if (ev.type === "assistant") {
                // Skip if we already streamed deltas — the assistant event would duplicate them
                if (!receivedStreamDeltas) {
                  const content = ev.message?.content;
                  if (Array.isArray(content)) {
                    for (const c of content) {
                      if (c.type === "text") {
                        send({ type: "chunk", text: c.text });
                        fullOutput += c.text;
                      }
                    }
                  } else if (typeof content === "string") {
                    send({ type: "chunk", text: content });
                    fullOutput += content;
                  }
                }
              } else if (ev.type === "result") {
                // result.result duplicates streamed content — only use it if we got nothing else
                if (!fullOutput && ev.result) {
                  send({ type: "chunk", text: ev.result });
                  fullOutput += ev.result;
                }
                proc.kill("SIGTERM");
              }
            } catch {
              send({ type: "chunk", text: line + "\n" });
              fullOutput += line + "\n";
            }
          }
        };

        proc.stdout.on("data", handleChunk);
        proc.stderr.on("data", (d) => {
          const text = d.toString();
          console.warn(`[engine-passthrough] stderr ${engine}: ${text.trim()}`);
          send({ type: "stderr", text });
        });
        proc.on("error", (err) => {
          clearTimeout(passthroughWatchdog);
          console.error(
            `[engine-passthrough] spawn error ${engine}: ${err.message || String(err)}`,
          );
          send({ type: "stderr", text: err.message || String(err) });
          closeStream(1);
        });
        proc.on("close", async (code) => {
          clearTimeout(passthroughWatchdog);
          console.log(
            `[engine-passthrough] close ${engine}: exit=${code} outputChars=${fullOutput.length}`,
          );
          if (lineBuffer.trim()) {
            // Don't send lineBuffer yet if it's crew-cli JSON
            if (engine !== "crew-cli") {
              send({ type: "chunk", text: lineBuffer });
            }
            fullOutput += lineBuffer;
          }

          // crew-cli special handling: extract JSON from output (skipping logs) and send only response field
          if (engine === "crew-cli" && fullOutput.trim()) {
            try {
              // crew-cli may emit logs before JSON - use regex to find the JSON object
              // Pattern matches: crew chat --json outputs "chat.result"
              const jsonMatch = fullOutput.match(
                /\{[\s\S]*"kind":\s*"chat\.result"[\s\S]*\}/,
              );
              if (!jsonMatch) {
                throw new Error("No chat.result JSON found in output");
              }
              const parsed = JSON.parse(jsonMatch[0]);
              if (parsed.response) {
                console.error(
                  `[crew-cli] ✅ Extracted response: ${parsed.response.slice(0, 80)}...`,
                );
                // NOW send the actual response as a chunk
                send({ type: "chunk", text: parsed.response });
                fullOutput = parsed.response; // Replace fullOutput for notifications
              } else {
                console.error(`[crew-cli] ⚠️ No response field in JSON`);
                send({ type: "chunk", text: fullOutput }); // Send raw output as fallback
              }
            } catch (err) {
              console.error(
                `[crew-cli] ❌ Failed to extract JSON: ${err.message}`,
              );
              console.error(
                `[crew-cli] First 200 chars: ${fullOutput.slice(0, 200)}`,
              );
              // Send raw output as fallback
              send({ type: "chunk", text: fullOutput });
            }
          }

          closeStream(code);

          // ── Save to unified project messages if projectId provided ──
          const { projectId } = JSON.parse(body || "{}");
          if (projectId) {
            try {
              const { saveProjectMessage } =
                await import("../chat/project-messages.mjs");

              // Save user message
              saveProjectMessage(projectId, {
                source: "cli",
                role: "user",
                content: message,
                agent: null,
                metadata: {
                  engine,
                  sessionId: reqSessionId,
                  agentName: "You",
                  agentEmoji: "👤",
                },
              });

              // Save CLI output
              saveProjectMessage(projectId, {
                source: "cli",
                role: "assistant",
                content: fullOutput.trim() || "(no output)",
                agent: engine,
                metadata: {
                  agentName: engine,
                  agentEmoji: "⚡",
                  engine,
                  exitCode: code,
                  sessionId: reqSessionId,
                  projectDir,
                },
              });

              console.log(
                `[engine-passthrough] ✅ Saved to project messages: ${projectId}`,
              );
            } catch (e) {
              console.warn(
                `[engine-passthrough] ⚠️ Failed to save to project messages: ${e.message}`,
              );
            }
          }

          // ── Notify Telegram/WA on completion (dashboard already saw it stream live) ──
          const summary = fullOutput.trim().slice(0, 3000) || "(no output)";
          const engineLabel =
            engine === "cursor"
              ? "Cursor CLI"
              : engine === "claude"
                ? "Claude Code"
                : engine === "codex"
                  ? "Codex CLI"
                  : engine === "docker-sandbox"
                    ? "Docker Sandbox"
                    : engine === "gemini" || engine === "gemini-cli"
                      ? "Gemini CLI"
                      : engine === "antigravity"
                        ? "Antigravity"
                        : engine === "crew-cli"
                          ? "crew-cli"
                          : "OpenCode";
          const broadcastContent = `⚡ ${engineLabel}: ${summary}`;

          // PASSTHROUGH_NOTIFY: "tg" | "wa" | "both" | "none" (default: "both")
          // Set in ~/.crewswarm/crewswarm.json env block or as env var
          const passthroughNotify = (() => {
            try {
              return (
                process.env.PASSTHROUGH_NOTIFY ||
                JSON.parse(
                  fs.readFileSync(
                    path.join(os.homedir(), ".crewswarm", "crewswarm.json"),
                    "utf8",
                  ),
                ).env?.PASSTHROUGH_NOTIFY ||
                "both"
              ).toLowerCase();
            } catch {
              return "both";
            }
          })();
          const notifyTG =
            passthroughNotify === "both" || passthroughNotify === "tg";
          const notifyWA =
            passthroughNotify === "both" || passthroughNotify === "wa";

          // Broadcast to WhatsApp via /events SSE (whatsapp-bridge listens here)
          // _passthroughSummary flag tells the dashboard frontend to ignore this — it already rendered the stream live
          if (notifyWA)
            broadcastSSE({
              type: "agent_reply",
              from: engineLabel,
              content: broadcastContent,
              sessionId: "owner",
              _passthroughSummary: true,
              ts: Date.now(),
            });

          // Telegram — split into chunks if > 3800 chars (TG max is 4096)
          if (notifyTG)
            try {
              const tgBridge = JSON.parse(
                fs.readFileSync(
                  path.join(os.homedir(), ".crewswarm", "telegram-bridge.json"),
                  "utf8",
                ),
              );
              const botToken =
                process.env.TELEGRAM_BOT_TOKEN || tgBridge.token || "";
              const chatId =
                process.env.TELEGRAM_CHAT_ID ||
                (Array.isArray(tgBridge.allowedChatIds) &&
                tgBridge.allowedChatIds[0]
                  ? String(tgBridge.allowedChatIds[0])
                  : "") ||
                tgBridge.defaultChatId ||
                "";
              if (botToken && chatId) {
                const TG_MAX = 3800;
                const header = `⚡ *${engineLabel}*: \`${message.slice(0, 80)}${message.length > 80 ? "…" : ""}\`\n\n`;
                const chunks = [];
                let remaining = summary;
                chunks.push(
                  header + remaining.slice(0, TG_MAX - header.length),
                );
                remaining = remaining.slice(TG_MAX - header.length);
                while (remaining.length > 0) {
                  chunks.push(remaining.slice(0, TG_MAX));
                  remaining = remaining.slice(TG_MAX);
                }
                for (const chunk of chunks) {
                  await fetch(
                    `https://api.telegram.org/bot${botToken}/sendMessage`,
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        chat_id: chatId,
                        text: chunk,
                        parse_mode: "Markdown",
                      }),
                      signal: AbortSignal.timeout(8000),
                    },
                  ).catch(() => {});
                }
              }
            } catch {}
        });
        req.on("close", () => {
          try {
            proc.kill("SIGTERM");
          } catch {}
        });
        return;
      }

      // GET /api/passthrough-sessions — list active CLI sessions by project
      // DELETE /api/passthrough-sessions?key=<key> — clear a specific session
      // DELETE /api/passthrough-sessions — clear all sessions
      if (url.pathname === "/api/passthrough-sessions") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        const sessionStoreFile = path.join(
          os.homedir(),
          ".crewswarm",
          "passthrough-sessions.json",
        );
        if (!global._passthroughSessions) {
          try {
            global._passthroughSessions = JSON.parse(
              fs.readFileSync(sessionStoreFile, "utf8"),
            );
          } catch {
            global._passthroughSessions = {};
          }
        }
        if (req.method === "GET") {
          json(res, 200, { ok: true, sessions: global._passthroughSessions });
          return;
        }
        if (req.method === "DELETE") {
          const key = url.searchParams.get("key");
          if (key) {
            // Clean up Codex scope directory if it's a Codex session
            const session = global._passthroughSessions[key];
            if (session && typeof session === "object" && session.scopeHome) {
              try {
                await fs.promises.rm(session.scopeHome, {
                  recursive: true,
                  force: true,
                });
                console.log(
                  `[Passthrough] Deleted Codex scope: ${session.scopeHome}`,
                );
              } catch (err) {
                console.warn(
                  `[Passthrough] Failed to delete Codex scope: ${err.message}`,
                );
              }
            }
            delete global._passthroughSessions[key];
          } else {
            // Delete all Codex scope directories
            for (const [k, session] of Object.entries(
              global._passthroughSessions,
            )) {
              if (session && typeof session === "object" && session.scopeHome) {
                try {
                  await fs.promises.rm(session.scopeHome, {
                    recursive: true,
                    force: true,
                  });
                } catch {}
              }
            }
            global._passthroughSessions = {};
          }
          try {
            fs.writeFileSync(
              sessionStoreFile,
              JSON.stringify(global._passthroughSessions, null, 2),
            );
          } catch {}
          json(res, 200, { ok: true, cleared: key || "all" });
          return;
        }
      }

      // GET/POST /api/settings/claude-code — toggle Claude Code executor at runtime
      if (url.pathname === "/api/settings/claude-code") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        if (req.method === "GET") {
          let enabled = false;
          try {
            const cfg = JSON.parse(
              fs.readFileSync(
                path.join(os.homedir(), ".crewswarm", "config.json"),
                "utf8",
              ),
            );
            enabled = cfg.claudeCode === true;
          } catch {}
          const hasKey = !!(
            process.env.ANTHROPIC_API_KEY ||
            (() => {
              try {
                return JSON.parse(
                  fs.readFileSync(
                    path.join(os.homedir(), ".crewswarm", "crewswarm.json"),
                    "utf8",
                  ),
                )?.providers?.anthropic?.apiKey;
              } catch {
                return null;
              }
            })()
          );
          json(res, 200, { ok: true, enabled, hasKey });
          return;
        }
        if (req.method === "POST") {
          const body = await readBody(req);
          const enable =
            typeof body.enabled === "boolean" ? body.enabled : false;
          try {
            const cfgPath = path.join(
              os.homedir(),
              ".crewswarm",
              "config.json",
            );
            const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
            cfg.claudeCode = enable;
            fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
          } catch (e) {
            console.warn(
              "[crew-lead] Could not persist claudeCode:",
              e.message,
            );
          }
          console.log(
            `[crew-lead] Claude Code executor ${enable ? "ENABLED" : "DISABLED"} via dashboard`,
          );
          json(res, 200, { ok: true, enabled: enable });
          return;
        }
      }

      // GET/POST /api/settings/cursor-waves — toggle Cursor parallel wave dispatch at runtime
      if (url.pathname === "/api/settings/cursor-waves") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        if (req.method === "GET") {
          json(res, 200, { ok: true, enabled: cursorWavesRef.enabled });
          return;
        }
        if (req.method === "POST") {
          const body = await readBody(req);
          const enable =
            typeof body.enabled === "boolean"
              ? body.enabled
              : !cursorWavesRef.enabled;
          cursorWavesRef.enabled = enable;
          // Persist to config.json so it survives restarts
          try {
            const cfgPath = path.join(
              os.homedir(),
              ".crewswarm",
              "config.json",
            );
            const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
            cfg.cursorWaves = enable;
            fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
          } catch (e) {
            console.warn(
              "[crew-lead] Could not persist cursorWaves:",
              e.message,
            );
          }
          console.log(
            `[crew-lead] Cursor Waves ${enable ? "ENABLED" : "DISABLED"} via dashboard`,
          );
          json(res, 200, { ok: true, enabled: cursorWavesRef.enabled });
          return;
        }
      }

      // GET/POST /api/settings/global-fallback — set/get global OpenCode fallback model
      if (url.pathname === "/api/settings/global-fallback") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        if (req.method === "GET") {
          let current = "";
          try {
            const swarm = JSON.parse(
              fs.readFileSync(
                path.join(os.homedir(), ".crewswarm", "crewswarm.json"),
                "utf8",
              ),
            );
            current = swarm.globalFallbackModel || "";
          } catch {}
          json(res, 200, { ok: true, globalFallbackModel: current });
          return;
        }
        if (req.method === "POST") {
          const body = await readBody(req);
          const model = String(body.globalFallbackModel || "").trim();
          try {
            const swarmPath = path.join(
              os.homedir(),
              ".crewswarm",
              "crewswarm.json",
            );
            const swarm = JSON.parse(fs.readFileSync(swarmPath, "utf8"));
            swarm.globalFallbackModel = model;
            fs.writeFileSync(swarmPath, JSON.stringify(swarm, null, 2));
            console.log(
              `[crew-lead] Global fallback model set to: ${model || "(cleared)"}`,
            );
            json(res, 200, { ok: true, globalFallbackModel: model });
          } catch (e) {
            json(res, 500, { ok: false, error: e.message });
          }
          return;
        }
      }

      // GET/POST /api/settings/opencode-project — set/get OpenCode project dir, fallback model, and crew-lead model
      if (url.pathname === "/api/settings/opencode-project") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        if (req.method === "GET") {
          let dir = "";
          let fallbackModel = "";
          let crewLeadModel = "";
          try {
            const cfg = JSON.parse(
              fs.readFileSync(
                path.join(os.homedir(), ".crewswarm", "config.json"),
                "utf8",
              ),
            );
            dir = cfg.settings?.opencodeProject || cfg.opencodeProject || "";
            fallbackModel = cfg.opencodeFallbackModel || "";
            crewLeadModel = cfg.crewLeadModel || "";
          } catch {}
          json(res, 200, { ok: true, dir, fallbackModel, crewLeadModel });
          return;
        }
        if (req.method === "POST") {
          const body = await readBody(req);
          try {
            const cfgPath = path.join(
              os.homedir(),
              ".crewswarm",
              "config.json",
            );
            const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
            if (!cfg.settings) cfg.settings = {};
            if (body.dir !== undefined)
              cfg.settings.opencodeProject = body.dir || "";
            if (body.fallbackModel !== undefined)
              cfg.opencodeFallbackModel = body.fallbackModel || "";
            if (body.crewLeadModel !== undefined)
              cfg.crewLeadModel = body.crewLeadModel || "";
            fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
            console.log(
              `[crew-lead] Settings saved: opencodeProject=${cfg.settings.opencodeProject || "(cleared)"} fallback=${cfg.opencodeFallbackModel || "(cleared)"} crewLeadModel=${cfg.crewLeadModel || "(cleared)"}`,
            );
            json(res, 200, {
              ok: true,
              dir: cfg.settings.opencodeProject,
              fallbackModel: cfg.opencodeFallbackModel,
              crewLeadModel: cfg.crewLeadModel,
            });
          } catch (e) {
            json(res, 500, { ok: false, error: e.message });
          }
          return;
        }
      }

      // POST /api/spending/reset — reset today's spending counters
      if (url.pathname === "/api/spending/reset" && req.method === "POST") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        const fresh = {
          date: new Date().toISOString().slice(0, 10),
          global: { tokens: 0, costUSD: 0 },
          agents: {},
        };
        try {
          fs.writeFileSync(SPENDING_FILE, JSON.stringify(fresh, null, 2));
        } catch {}
        json(res, 200, { ok: true, reset: true });
        return;
      }

      // GET /api/health — master health check: all settings, agents, skills, spending, services
      if (url.pathname === "/api/health" && req.method === "GET") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        const cfg = loadConfig();
        const cfgRaw =
          tryRead(path.join(os.homedir(), ".crewswarm", "config.json")) || {};
        const swarmRaw =
          tryRead(path.join(os.homedir(), ".crewswarm", "crewswarm.json")) ||
          {};
        const rtPublish = getRtPublish();

        // OpenCode project dir
        const opencodeProject =
          cfgRaw.opencodeProject ||
          process.env.CREWSWARM_OPENCODE_PROJECT ||
          "";

        // Agents with tools + model
        const agentRows = cfg.agentRoster.map((a) => {
          const tools = readAgentTools(a.id).tools;
          return {
            id: a.id,
            name: a.name,
            emoji: a.emoji,
            role: a.role,
            model: a.model,
            tools,
          };
        });

        // Skills
        const SKILLS_DIR_HEALTH = path.join(
          os.homedir(),
          ".crewswarm",
          "skills",
        );
        let skills = [];
        try {
          fs.mkdirSync(SKILLS_DIR_HEALTH, { recursive: true });
          skills = fs
            .readdirSync(SKILLS_DIR_HEALTH)
            .filter((f) => f.endsWith(".json"))
            .map((f) => {
              try {
                return {
                  name: f.replace(".json", ""),
                  ...JSON.parse(
                    fs.readFileSync(path.join(SKILLS_DIR_HEALTH, f), "utf8"),
                  ),
                };
              } catch {
                return { name: f.replace(".json", ""), error: "parse failed" };
              }
            });
        } catch {}

        // Spending
        let spending = { global: { tokens: 0, costUSD: 0 }, agents: {} };
        try {
          spending = JSON.parse(fs.readFileSync(SPENDING_FILE, "utf8"));
        } catch {}

        // RT bus connectivity
        const rtConnected = !!rtPublish;

        // Providers (keys masked)
        const providers = Object.entries(swarmRaw?.providers || {}).map(
          ([id, p]) => ({
            id,
            baseUrl: p.baseUrl,
            hasKey: !!(p.apiKey || "").trim(),
          }),
        );

        json(res, 200, {
          ok: true,
          ts: new Date().toISOString(),
          crewLead: {
            model: `${cfg.providerKey}/${cfg.modelId}`,
            port: PORT,
            rtConnected,
          },
          settings: {
            opencodeProject,
            rtAuthToken: !!(cfgRaw?.rt?.authToken || "").trim(),
          },
          agents: agentRows,
          skills,
          spending,
          providers,
          telemetry: readTelemetryEvents(20),
        });
        return;
      }

      // GET /api/telemetry — last N task.lifecycle events (schema 1.1)
      if (url.pathname === "/api/telemetry" && req.method === "GET") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        const limit = Math.min(
          parseInt(req.headers["limit"] || String(50), 10) || 50,
          100,
        );
        json(res, 200, {
          ok: true,
          schemaVersion: telemetrySchemaVersion,
          events: readTelemetryEvents(limit),
        });
        return;
      }

      // POST /api/agents/:id/restart — kill and respawn a single bridge process
      const restartMatch = url.pathname.match(
        /^\/api\/agents\/([^/]+)\/restart$/,
      );
      if (restartMatch && req.method === "POST") {
        if (!checkBearer(req)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        const agentId = restartMatch[1];
        const { execSync: exec2 } = await import("node:child_process");
        const RT_TOKEN = getRTToken();
        try {
          exec2(
            `pkill -f "gateway-bridge.mjs.*${agentId}" 2>/dev/null || true`,
            { shell: true },
          );
          // Respawn via start-crew --agent (waits for spawn, then returns)
          setTimeout(async () => {
            try {
              exec2(
                `node ${path.join(process.cwd(), "scripts", "start-crew.mjs")} --agent ${agentId}`,
                {
                  shell: true,
                  timeout: 10000,
                  env: { ...process.env, CREWSWARM_RT_AUTH_TOKEN: RT_TOKEN },
                },
              );
              console.log(`[crew-lead] bridge respawned for ${agentId}`);
            } catch (e2) {
              console.error(
                `[crew-lead] failed to respawn bridge for ${agentId}:`,
                e2.message,
              );
            }
          }, 500);
          console.log(`[crew-lead] restart requested for ${agentId}`);
          json(res, 200, { ok: true, agentId, action: "restart" });
        } catch (e) {
          json(res, 500, { ok: false, error: e.message });
        }
        return;
      }

      json(res, 404, { ok: false, error: "not found" });
    } catch (err) {
      console.error("[crew-lead] error:", err.message);
      json(res, 500, { ok: false, error: err.message });
    }
  });

  const BIND_HOST = process.env.CREWSWARM_BIND_HOST || "127.0.0.1";
  server.listen(PORT, BIND_HOST, () => {
    const cfg = loadConfig();
    console.log(`[crew-lead] HTTP server on http://${BIND_HOST}:${PORT}`);
    console.log(`[crew-lead] Model: ${cfg.providerKey}/${cfg.modelId}`);
    console.log(`[crew-lead] History: ${historyDir}`);
    console.log(`[crew-lead] Agents: ${cfg.knownAgents.join(", ")}`);
    console.log(`[crew-lead] Dispatch timeout: ${dispatchTimeoutMs / 1000}s`);
    if (!dispatchTimeoutInterval) {
      setDispatchTimeoutInterval(setInterval(checkDispatchTimeouts, 15_000)); // check every 15s
    }
    connectRT();
  });

  let _portRetries = 0;
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      if (_portRetries < 6) {
        _portRetries++;
        const delay = _portRetries * 1000;
        console.error(
          `[crew-lead] Port ${PORT} in use — retry ${_portRetries}/6 in ${delay}ms (waiting for old process to exit)`,
        );
        setTimeout(() => {
          server.close();
          server.listen(PORT, BIND_HOST);
        }, delay);
      } else {
        console.error(
          `[crew-lead] Port ${PORT} still in use after 6 retries — run: lsof -ti :${PORT} | xargs kill -9`,
        );
        process.exit(1);
      }
    } else {
      console.error("[crew-lead] server error:", err.message);
      process.exit(1);
    }
  });

  return server;
}
