import { detectMentionParticipants } from "./participants.mjs";

const WORK_INTENT_PATTERNS = [
  /\b(build|create|implement|write|fix|debug|audit|review|test|investigate|research|analyze|scope|plan|draft|summarize|check|look into|inspect|trace|triage|patch|refactor|ship)\b/i,
  /\bplease\b/i,
  /\bcan you\b/i,
  /\bneed you to\b/i,
  /\bdo this\b/i,
  /\bwork on\b/i,
  /\bhandle this\b/i,
  /@@[A-Z_]+/,
];

const STRONG_EXECUTION_PATTERNS = [
  /\b(build|create|implement|write|fix|debug|investigate|research|analyze|scope|plan|draft|summarize|inspect|trace|triage|patch|refactor|ship)\b/i,
];

const HANDOFF_CHAT_PATTERNS = [
  /\b(ask|tell|ping|loop in|cc|send|share|pass|forward|hand(?: |-)?off)\b/i,
];

const HANDOFF_TARGET_PATTERNS = [
  /\b(?:to|with)\s+crew-[a-z0-9_-]+\b/i,
  /\bcrew-[a-z0-9_-]+\b/i,
  /\b(findings|docs?|report|notes|summary|link|links|writeup|write-up)\b/i,
];

const CASUAL_CHAT_PATTERNS = [
  /^(hi|hello|hey|yo|sup|hiya)\b/i,
  /\bwhat'?s good\b/i,
  /\bwhat'?s up\b/i,
  /\bhow are you\b/i,
  /\byou there\b/i,
  /\bcan you hear me\b/i,
];

const VAGUE_EXECUTION_ONLY_PATTERNS = [
  /^(?:please\s+)?(?:get on it|handle it|handle this|take care of it|do it|do this|work on it|look into it|check it|fix it|ship it)\W*$/i,
  /^(?:please\s+)?(?:go|start|continue|finish)\W*$/i,
];

const SPECIFIC_WORK_ORDER_CUES = [
  /@@[A-Z_]+/,
  /`[^`]+`/,
  /\/[A-Za-z0-9._/-]+/,
  /\b(?:file|path|endpoint|route|test|spec|bug|issue|error|diff|output|screenshot|dependency|permission|autoharness|playwright|browser|dashboard|chat|agent|prompt|regression|coverage)\b/i,
  /\b(?:for|in|on|with|under|into|from)\s+[A-Za-z0-9_./-]{2,}/i,
];

export function stripMentionHandles(content = "") {
  return String(content || "")
    .replace(/(^|\s)@[a-zA-Z0-9_-]+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function hasExplicitWorkIntent(content = "") {
  const text = stripMentionHandles(content);
  if (!text) return false;
  if (CASUAL_CHAT_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return WORK_INTENT_PATTERNS.some((pattern) => pattern.test(text));
}

export function hasExplicitHandoffChatIntent(content = "") {
  const text = stripMentionHandles(content);
  if (!text) return false;
  const hasHandoffVerb = HANDOFF_CHAT_PATTERNS.some((pattern) =>
    pattern.test(text),
  );
  if (!hasHandoffVerb) return false;
  const hasTargetCue = HANDOFF_TARGET_PATTERNS.some((pattern) =>
    pattern.test(text),
  );
  if (!hasTargetCue) return false;
  const hasStrongExecution = STRONG_EXECUTION_PATTERNS.some((pattern) =>
    pattern.test(text),
  );
  return !hasStrongExecution;
}

export function hasSpecificWorkOrder(content = "") {
  const text = stripMentionHandles(content);
  if (!text) return false;
  if (VAGUE_EXECUTION_ONLY_PATTERNS.some((pattern) => pattern.test(text))) return false;
  if (SPECIFIC_WORK_ORDER_CUES.some((pattern) => pattern.test(text))) return true;
  const words = text.split(/\s+/).filter(Boolean);
  return words.length >= 4;
}

export function classifySharedChatMention(content = "") {
  const participants = detectMentionParticipants(content);
  const broadcastAll = /(^|\s)@crew-all\b/i.test(String(content || ""));
  if (participants.length > 1) {
    return {
      mode: "direct_multi",
      targetAgent: null,
      targetParticipant: null,
      targetAgents: participants
        .filter((participant) => participant.kind === "agent")
        .map((participant) => participant.id),
      targetParticipants: participants,
      directMessage: stripMentionHandles(content) || "hi",
      broadcastAll,
    };
  }

  if (participants.length !== 1) {
    return {
      mode: "none",
      targetAgent: null,
      targetParticipant: null,
      targetAgents: [],
      targetParticipants: [],
      directMessage: stripMentionHandles(content),
      broadcastAll,
    };
  }

  const targetParticipant = participants[0];
  const targetAgent =
    targetParticipant.kind === "agent" ? targetParticipant.id : null;
  const directMessage = stripMentionHandles(content) || "hi";
  const shouldDispatch =
    !hasExplicitHandoffChatIntent(content) &&
    hasExplicitWorkIntent(content) &&
    hasSpecificWorkOrder(content);
  return {
    mode: shouldDispatch ? "dispatch" : "direct",
    targetAgent,
    targetParticipant,
    targetAgents: [targetAgent],
    targetParticipants: [targetParticipant],
    directMessage,
    broadcastAll,
  };
}
