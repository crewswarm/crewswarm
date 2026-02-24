# Brain — Project Knowledge

Agents: append discoveries here. This is the persistent knowledge base for this workspace.
Read it to avoid repeating mistakes. Write to it when you learn something durable.

## Format

```
## [YYYY-MM-DD] agent-name: one-line title
Key fact or decision. Max 3 sentences. Be specific — no fluff.
```

---

## [2026-02-22] system: CrewSwarm repo facts
- Repo lives at `/Users/jeffhobbs/Desktop/CrewSwarm/`
- The RT bus runs on `ws://localhost:18889`; crew-lead HTTP on `http://localhost:5010`; dashboard on `http://localhost:4319`
- All agent tool permissions live in `~/.crewswarm/crewswarm.json` → `agents[].tools.alsoAllow` (or `tools.crewswarmAllow` for CrewSwarm @@TOOL names)

## [2026-02-22] crew-coder: tool call rules that work
- Output ALL tool calls in ONE reply — never stop after @@MKDIR and wait for a response.
- @@END_FILE must be on its own line with no trailing content; the regex will miss it otherwise.
- The directory for a new file should already exist or be created with @@MKDIR in the same reply, before @@WRITE_FILE.

## [2026-02-22] system: shared memory loading order
- SHARED_MEMORY_FILES loaded into every prompt: current-state.md, agent-handoff.md, orchestration-protocol.md
- telegram-context.md and decisions.md are NOT loaded into task prompts (too noisy)
- brain.md (this file) IS loaded — keep entries brief; it will grow

## [2026-02-23] crew-lead: …`.

## [2026-02-23] system: dashboard edits — always run check script
- **Every** change to `scripts/dashboard.mjs` must be followed by `node scripts/check-dashboard.mjs`. Dashboard updates frequently break the inline script (nested quotes, template literals); the check prints the exact line that breaks.
- If the full check hangs, use `node scripts/check-dashboard.mjs --source-only`.
