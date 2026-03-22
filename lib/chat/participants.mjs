import { BUILT_IN_RT_AGENTS, normalizeRtAgentId } from "../agent-registry.mjs";

const BROADCAST_ALIASES = new Set(["crew-all"]);

const CLI_PARTICIPANTS = [
  { id: "codex", kind: "cli", runtime: "codex", aliases: ["codex-cli"] },
  { id: "cursor", kind: "cli", runtime: "cursor", aliases: ["cursor-cli"] },
  {
    id: "claude",
    kind: "cli",
    runtime: "claude",
    aliases: ["claude-code", "claudecode"],
  },
  {
    id: "opencode",
    kind: "cli",
    runtime: "opencode",
    aliases: ["open-code"],
  },
  {
    id: "crew-cli",
    kind: "cli",
    runtime: "crew-cli",
    aliases: ["crewcli"],
  },
  { id: "gemini", kind: "cli", runtime: "gemini", aliases: ["gemini-cli"] },
];

function buildParticipantMap() {
  const map = new Map();

  for (const agentId of BUILT_IN_RT_AGENTS) {
    const canonicalId = normalizeRtAgentId(agentId);
    if (!canonicalId) continue;
    const bareId = canonicalId.replace(/^crew-/, "");
    const participant = {
      id: canonicalId,
      kind: "agent",
      runtime: null,
      aliases: [bareId],
    };
    map.set(canonicalId, participant);
    map.set(bareId, participant);
  }

  for (const participant of CLI_PARTICIPANTS) {
    map.set(participant.id, participant);
    for (const alias of participant.aliases) {
      map.set(alias, participant);
    }
  }

  return map;
}

export function listCliParticipants() {
  return CLI_PARTICIPANTS.map((participant) => ({ ...participant }));
}

export function listChatParticipants() {
  const seen = new Set();
  const participants = [];
  for (const participant of buildParticipantMap().values()) {
    if (seen.has(participant.id)) continue;
    seen.add(participant.id);
    participants.push({ ...participant });
  }
  return participants.sort((a, b) => a.id.localeCompare(b.id));
}

export function resolveChatParticipant(rawId = "") {
  const key = String(rawId || "").trim().toLowerCase();
  if (!key) return null;
  return buildParticipantMap().get(key) || null;
}

export function detectMentionParticipants(content = "") {
  const found = new Map();
  const text = String(content || "");
  for (const match of text.matchAll(/(^|\s)@([a-zA-Z0-9_-]+)/g)) {
    const raw = String(match[2] || "").trim().toLowerCase();
    if (!raw) continue;
    if (BROADCAST_ALIASES.has(raw)) {
      for (const participant of listChatParticipants()) {
        if (participant.id === "crew-lead") continue;
        if (participant.kind !== "agent") continue;
        found.set(participant.id, participant);
      }
      continue;
    }
    const participant = resolveChatParticipant(raw);
    if (participant) found.set(participant.id, participant);
  }
  return [...found.values()];
}
