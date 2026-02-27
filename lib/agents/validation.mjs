/**
 * Agent reply quality-gate validators — extracted from gateway-bridge.mjs.
 * Standalone validators with optional telemetry injection for assertTaskPromptProtocol.
 */

let _telemetry = () => {};

export function initValidation({ telemetry } = {}) {
  if (telemetry) _telemetry = telemetry;
}

export const HOLLOW_REPLY_PATTERNS = [
  /^(sorry,?\s+)?(as an? (AI|language model|llm|assistant))[,.]?\s+i (can'?t|cannot|don'?t|am not able)/i,
  /i('?m| am) not able to (access|read|write|execute|run|perform)/i,
  /i don'?t have (access|permission|the ability) to/i,
  /^(please|kindly)?\s*(wait|hold on|one moment|stand by)[.!]*$/i,
  /^i'?ll? (get|check|look|fetch|read) (that|this|it) (for you\s*)?$/i,
  /^(•\s*)?realtime (daemon )?error:/i,
  /invalid realtime token/i,
  /i (don'?t|do not) have (any )?(tools?|the ability|capabilities?) (to|for) (write|create|modify|execute|run)/i,
];

export const WEASEL_ONLY_PATTERNS = [
  /\b(i will|i would|i can|i could|i should|i might|i plan to|i recommend|i suggest)\b/i,
];

export function validateAgentReply(reply, incomingType, prompt) {
  const text = String(reply || "").trim();

  if (!text || text.length < 15) {
    return { valid: false, reason: "reply too short or empty" };
  }

  for (const pat of HOLLOW_REPLY_PATTERNS) {
    if (pat.test(text)) {
      return { valid: false, reason: `hollow reply pattern: ${pat.toString().slice(0, 60)}` };
    }
  }

  const isCoding = /code|write|build|create|implement|fix|refactor|generate|edit|update|add|remove/i.test(String(prompt || ""));
  if (isCoding && text.length < 300) {
    const allWeasel = WEASEL_ONLY_PATTERNS.every(p => p.test(text));
    const hasAction = /@@WRITE_FILE|@@RUN_CMD|@@READ_FILE|✅|wrote|created|updated|fixed|done|complete/i.test(text);
    if (allWeasel && !hasAction) {
      return { valid: false, reason: "short coding reply is all weasel words with no action evidence" };
    }
  }

  return { valid: true, reason: "ok" };
}

export function validateCodingArtifacts(reply, incomingType, prompt, payload) {
  return validateAgentReply(reply, incomingType, prompt);
}

export function assertTaskPromptProtocol(prompt, source = "task") {
  if (typeof prompt !== "string" || !prompt || prompt === "MEMORY_LOAD_FAILED") {
    const err = new Error("MEMORY_PROTOCOL_MISSING");
    _telemetry("memory_protocol_missing", { source });
    throw err;
  }
}
