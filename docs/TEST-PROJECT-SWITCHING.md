# Project Switching Test Guide

Manual verification of CrewSwarm Dashboard project switching for passthrough engines (Gemini, Codex, etc.).

## Prerequisites

- Dashboard at http://localhost:4319
- crew-lead running on :5010
- At least two projects in Projects tab (e.g. crew-cli, website)
- Gemini CLI installed (`gemini -p "test"` works)

## Steps

1. **Navigate** to http://localhost:4319
2. **Chat tab** — should be default view
3. **Project dropdown** (`chatProjectSelect`) — note current selection
4. **Engine dropdown** (`passthroughEngine`) — select **gemini**
5. **With crew-cli project selected:**
   - Type: `what directory are you in?`
   - Send
   - Wait for response
   - **Expected:** Directory = project's `outputDir` (e.g. `/Users/.../CrewSwarm/crew-cli/`)
6. **Change project** to "📁 Select Project..." (root/default)
7. **Send same message:** `what directory are you in?`
   - **Expected:** Directory = `config.settings.opencodeProject` or `process.cwd()` (e.g. repo root)
8. **Session indicator** — after first message with Gemini, "● Session" should appear (green badge)
   - Click it to clear session

## What to Verify

| Check | How |
|-------|-----|
| Different dirs per project | Compare responses from step 5 vs 7 |
| sessionId sent | DevTools → Network → `engine-passthrough` → Request payload has `sessionId: "owner"` |
| projectDir sent | With project selected: payload has `projectDir: "/path/to/project"` |
| Session indicator | Visible after first Gemini message when project is selected |

## API Test (no browser)

```bash
node scripts/test-project-switching.mjs
```

Requires Gemini CLI; may take 30–60s per request.

## Known Behavior

- **Session key format:** Backend uses `engine:projectDir:sessionScope` (e.g. `gemini:/path/to/crew-cli:owner`)
- **No project selected:** Backend falls back to `config.settings.opencodeProject` or `process.cwd()`
- **Session indicator:** Only shows when a project is selected (no project = no indicator)
