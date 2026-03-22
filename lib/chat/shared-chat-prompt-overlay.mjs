const CLI_PARTICIPANTS = [
  "@codex",
  "@cursor",
  "@claude",
  "@opencode",
  "@gemini",
  "@crew-cli",
];

const STALE_LINES = [
  /- In shared chat surfaces .*plain `@mentions` are a live routing mechanism\.\s*/gi,
  /- .*can hand work off in-channel with @mentions.*\s*/gi,
  /- Prefer `@mentions` for in-channel handoffs\..*\s*/gi,
  /- Do not claim that `@mentions` are informational-only or non-routing\..*\s*/gi,
  /- `@agent` is communication, not an implicit dispatch\s*/gi,
  /- Do not treat plain `@mentions` as permission to route work\s*/gi,
  /- Only `@@DISPATCH` starts delegated execution work\s*/gi,
];

export function getSharedChatPromptOverlay(agentId = "") {
  const targetLabel = agentId || "this agent";
  return [
    "## Shared Chat + @Mention System",
    "- In shared chat surfaces (Dashboard Swarm Chat, project/general rooms, and MCP chat tools), plain `@mentions` are direct in-room chat by default.",
    `- ${targetLabel} should treat casual mentions from users or teammates as direct conversation in the same room/thread.`,
    "- Mention syntax is literal plain text in the reply body, not an @@ command.",
    "- Valid examples: `@crew-main acknowledge this with a short reply`, `@crew-coder inspect /abs/path/app.js and report the root cause`, `@codex review this diff and summarize the risk`.",
    "- If you say you are mentioning, pinging, looping in, asking, or handing off to someone in shared chat, the literal `@participant` handle must appear in your message.",
    "- If a user says to 'use the @mention system', 'test @mentions', or corrects you for dispatching instead of mentioning, your next reply should include a literal `@participant` message in-room.",
    "- For mention-system tests or demos, prefer a direct in-channel line like `@crew-main acknowledge this with a short reply` instead of `@@DISPATCH`.",
    "- Do not just describe how mentions work when the user asked you to use them; actually send the `@participant` line.",
    `- Other participants may still be mentioned in-channel (\`@crew-*\`, ${CLI_PARTICIPANTS.join(", ")}), but plain mentions do not by themselves authorize hidden routing.`,
    "- Use a plain `@mention` for in-room collaboration, quick questions, acknowledgements, or handoffs visible to the room.",
    "- Use `@@DISPATCH` for explicit delegated execution, control-plane routing, or when the user specifically asks to dispatch or kick off work.",
    "- Only escalate into delegated execution when the message clearly asks for work, or when the user explicitly asks for dispatch.",
    "- `@@DISPATCH` remains the explicit control-plane routing mechanism.",
    "- If the task says you were mentioned in `#channel` or includes recent channel conversation, assume you are inside the shared chat system and reply for that audience.",
    "- If you do hand work off, make it explicit and include: what you did, exact files/artifacts, the next task, and clear success criteria.",
    "- If asked how the mention system works, answer from current runtime behavior and canonical docs (`AGENTS.md`, `docs/AGENTCHATTR-HYBRID-*`, `docs/AUTONOMOUS-*`), not from stale chat history summaries.",
    "- Do not claim that a plain `@mention` is equivalent to automatic dispatch unless the runtime explicitly routed it.",
  ].join("\n");
}

export function applySharedChatPromptOverlay(promptText = "", agentId = "") {
  const raw = String(promptText || "").trim();
  const cleaned = STALE_LINES.reduce(
    (text, pattern) => text.replace(pattern, ""),
    raw,
  ).trim();
  const overlay = getSharedChatPromptOverlay(agentId);
  return cleaned ? `${cleaned}\n\n${overlay}` : overlay;
}
