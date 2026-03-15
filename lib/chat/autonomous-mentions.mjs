import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { normalizeRtAgentId } from "../agent-registry.mjs";
import { executeCLI } from "../bridges/cli-executor.mjs";
import { dispatchTask } from "../crew-lead/wave-dispatcher.mjs";
import { saveProjectMessage, loadProjectMessages } from "./project-messages.mjs";
import { detectMentionParticipants } from "./participants.mjs";
import { classifySharedChatMention } from "./mention-routing-intent.mjs";

const CHANNEL_HOPS = new Map();
const MAX_AUTONOMOUS_HOPS = Number.parseInt(
  process.env.AUTONOMOUS_MAX_HOPS || "4",
  10,
);
const CONTEXT_WINDOW = Number.parseInt(
  process.env.AUTONOMOUS_CONTEXT_WINDOW || "10",
  10,
);
const CONFIG_PATH = path.join(os.homedir(), ".crewswarm", "config.json");

function getChannelKey(channel, projectId) {
  return String(channel || projectId || "general");
}

export function areAutonomousMentionsEnabled() {
  const envValue = String(
    process.env.CREWSWARM_AUTONOMOUS_MENTIONS || "",
  ).trim().toLowerCase();
  if (envValue === "0" || envValue === "off" || envValue === "false") {
    return false;
  }
  if (envValue === "1" || envValue === "on" || envValue === "true") {
    return true;
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return cfg.settings?.autonomousMentionsEnabled !== false;
  } catch {
    return true;
  }
}

export function detectMentions(content = "") {
  return detectMentionParticipants(stripNonRoutableMentionContext(content)).map(
    (participant) => participant.id,
  );
}

export function detectMentionTargets(content = "") {
  return detectMentionParticipants(stripNonRoutableMentionContext(content));
}

function stripNonRoutableMentionContext(content = "") {
  let text = String(content || "");

  // Agent runtimes append the original task for self-verification. Those echoed
  // mentions are historical context, not fresh routing instructions.
  text = text.replace(
    /\n+---\n\*\*\[ORIGINAL TASK\]:\*\*[\s\S]*$/i,
    "",
  );

  // Ignore fenced code blocks for routing so pasted transcripts/logs do not
  // re-trigger mention dispatches.
  text = text.replace(/```[\s\S]*?```/g, " ");

  return text;
}

export function shouldPauseChannel(channel, projectId) {
  const key = getChannelKey(channel, projectId);
  return (CHANNEL_HOPS.get(key) || 0) >= MAX_AUTONOMOUS_HOPS;
}

export function resetChannelHopCount(channel, projectId) {
  CHANNEL_HOPS.delete(getChannelKey(channel, projectId));
}

export function buildMentionPrompt({
  agent,
  sender,
  channel,
  content,
  chatHistory = [],
}) {
  const context = chatHistory
    .slice(-CONTEXT_WINDOW)
    .map((entry) => {
      const role = entry.sender || entry.role || "message";
      return `${role}: ${entry.content || ""}`;
    })
    .join("\n");

  return [
    `You were @mentioned by ${sender || "a teammate"} in #${channel || "general"}.`,
    "",
    "Recent conversation:",
    context || "(no prior context)",
    "",
    "Message addressed to you:",
    content || "",
    "",
    "Execute only if the message contains a concrete work order with a clear deliverable.",
    "If the request is vague, missing scope, or just says things like 'get on it', do not invent tasks. Reply with the exact missing work order needed to proceed.",
    "If you need to hand off, @mention the next agent explicitly.",
  ].join("\n");
}

export async function handleAutonomousMentions({
  message,
  sender = "crew-lead",
  channel = "general",
  projectId = "general",
  sessionId = "owner",
  projectDir = null,
  chatHistory = [],
  originMessageId = null,
  originThreadId = null,
  appendToChatHistory,
  onDispatch,
  broadcastSSE,
} = {}) {
  if (!areAutonomousMentionsEnabled()) return [];
  const content = String(message?.content || "");
  const mentionRoute = classifySharedChatMention(content);
  if (mentionRoute.mode !== "dispatch") return [];
  const mentions = mentionRoute.targetParticipants || detectMentionTargets(content);
  if (!mentions.length) return [];

  const key = getChannelKey(channel, projectId);
  const currentHops = CHANNEL_HOPS.get(key) || 0;
  if (currentHops >= MAX_AUTONOMOUS_HOPS) {
    appendToChatHistory?.({
      content: `⏸ ${channel} paused after ${currentHops} @mention hops. Send /continue to resume.`,
      metadata: {
        autonomous: true,
        channel,
        hopCount: currentHops,
      },
    });
    return [];
  }

  CHANNEL_HOPS.set(key, currentHops + 1);

  const dispatches = [];
  for (const participant of mentions) {
    if (participant.id === "crew-lead") continue;
    if (participant.id === normalizeRtAgentId(sender)) continue;

    const task = buildMentionPrompt({
      agent: participant.id,
      sender,
      channel,
      content,
      chatHistory:
        chatHistory.length
          ? chatHistory
          : loadProjectMessages(channel, {
              limit: CONTEXT_WINDOW,
              excludeDirect: true,
              ...(originThreadId ? { threadId: originThreadId } : {}),
            }),
    });

    if (participant.kind === "agent") {
      const taskId = dispatchTask(participant.id, task, sessionId, {
        projectId,
        originProjectId: projectId,
        originChannel: channel,
        originThreadId,
        originMessageId,
        triggeredBy: "mention",
        mentionedBy: sender,
        autonomous: true,
        ...(projectDir ? { projectDir } : {}),
      });

      if (!taskId) continue;

      appendToChatHistory?.({
        content: `⚡ @${participant.id} dispatched from #${channel}`,
        metadata: {
          autonomous: true,
          channel,
          taskId,
          targetAgent: participant.id,
          triggeredBy: "mention",
          mentionedBy: sender,
        },
      });

      onDispatch?.({
        id: participant.id,
        kind: participant.kind,
        taskId,
        channel,
      });
      dispatches.push({
        id: participant.id,
        kind: participant.kind,
        taskId,
        channel,
        triggeredBy: "mention",
      });
      continue;
    }

    const startedAt = Date.now();
    const runningNotice = `⚡ @${participant.id} running from #${channel}`;
    appendToChatHistory?.({
      content: runningNotice,
      metadata: {
        autonomous: true,
        channel,
        targetAgent: participant.id,
        triggeredBy: "mention",
        mentionedBy: sender,
        runtime: participant.runtime,
      },
    });
    if (channel) {
      saveProjectMessage(channel, {
        source: "cli",
        role: "assistant",
        content: runningNotice,
        agent: participant.id,
        threadId: originThreadId,
        parentId: originMessageId,
        metadata: {
          agentName: participant.id,
          runtime: participant.runtime,
          autonomous: true,
          status: "running",
          triggeredBy: "mention",
          mentionedBy: sender,
        },
      });
    }
    broadcastSSE?.({
      type: "agent_working",
      agent: participant.id,
      model: participant.runtime,
      sessionId,
      ts: startedAt,
    });
    onDispatch?.({
      id: participant.id,
      kind: participant.kind,
      channel,
      runtime: participant.runtime,
    });
    dispatches.push({
      id: participant.id,
      kind: participant.kind,
      channel,
      runtime: participant.runtime,
      triggeredBy: "mention",
    });

    void executeCLI(
      participant.runtime,
      task,
      null,
      { sessionId, projectDir },
      null,
    )
      .then((result) => {
        const reply =
          String(result.stdout || "").trim() ||
          String(result.stderr || "").trim() ||
          `(${participant.id} completed with no text output)`;
        const replyMessageId = channel
          ? saveProjectMessage(channel, {
              source: "cli",
              role: "assistant",
              content: reply,
              agent: participant.id,
              threadId: originThreadId,
              parentId: originMessageId,
              metadata: {
                agentName: participant.id,
                runtime: participant.runtime,
                autonomous: true,
                triggeredBy: "mention",
                mentionedBy: sender,
                durationMs: Date.now() - startedAt,
                mentions: detectMentions(reply),
              },
            })
          : null;
        appendToChatHistory?.({
          content: reply,
          agent: participant.id,
          metadata: {
            autonomous: true,
            channel,
            targetAgent: participant.id,
            runtime: participant.runtime,
            triggeredBy: "mention",
            mentionedBy: sender,
          },
        });
        broadcastSSE?.({
          type: "agent_reply",
          from: participant.id,
          content: reply.slice(0, 2000),
          sessionId,
          engineUsed: participant.runtime,
          ts: Date.now(),
        });
        broadcastSSE?.({
          type: "agent_idle",
          agent: participant.id,
          sessionId,
          ts: Date.now(),
        });
        // Do not recursively route plain @mentions from CLI participant replies.
      })
      .catch((error) => {
        const reply = `❌ @${participant.id} failed: ${error.message}`;
        if (channel) {
          saveProjectMessage(channel, {
            source: "cli",
            role: "assistant",
            content: reply,
            agent: participant.id,
            threadId: originThreadId,
            parentId: originMessageId,
            metadata: {
              agentName: participant.id,
              runtime: participant.runtime,
              autonomous: true,
              triggeredBy: "mention",
              mentionedBy: sender,
              failed: true,
            },
          });
        }
        appendToChatHistory?.({
          content: reply,
          agent: participant.id,
          metadata: {
            autonomous: true,
            channel,
            targetAgent: participant.id,
            runtime: participant.runtime,
            triggeredBy: "mention",
            mentionedBy: sender,
            failed: true,
          },
        });
        broadcastSSE?.({
          type: "agent_reply",
          from: participant.id,
          content: reply,
          sessionId,
          engineUsed: participant.runtime,
          ts: Date.now(),
        });
        broadcastSSE?.({
          type: "agent_idle",
          agent: participant.id,
          sessionId,
          ts: Date.now(),
          failed: true,
        });
      });
  }

  return dispatches;
}
