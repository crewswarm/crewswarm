# Phased Orchestrator

**Context:** This repo is the OpenCrew plugin (folder may still be named OpenClaw). The dashboard you use for **OpenCrew RT Messages** is usually at http://127.0.0.1:4318 (served by `~/.openclaw/workspace/skills/swarm_mcp/dashboard.mjs`).

**Problem:** Large tasks cause PM timeouts. The unified orchestrator asks for one big plan → PM takes too long → 120s timeout.

**Solution:** `phased-orchestrator.mjs` breaks work into phases (PDD-style: MVP → Phase 1 → Phase 2). Each phase = 3–5 small tasks. Shorter PM prompts = faster response = no timeout.

## Usage

```bash
# MVP only (3–5 small tasks)
node phased-orchestrator.mjs "Build a marketing website for CrewSwarm in website/"

# All phases (MVP + Phase 1 + Phase 2)
node phased-orchestrator.mjs --all "Build a marketing website for CrewSwarm in website/"
```

## Flow

1. **PDD step** – PM breaks requirement into MVP tasks (short prompt, ~30s)
2. **Execute MVP** – Run 3–5 small tasks sequentially
3. **Phase 1** (with `--all`) – PM lists Phase 1 tasks, execute
4. **Phase 2** (with `--all`) – PM lists Phase 2 tasks, execute

Each task = ONE action (~60s), so no timeout.

**On failure:** If a task fails (timeout or error), the orchestrator asks the PM to break it into 2–4 smaller subtasks, then runs those. Only one level of breakdown (subtasks are not broken down again).

## Dashboard Build UI

- **OpenCrew RT Messages** (the dashboard you use) is at **http://127.0.0.1:4318**. That server is `~/.openclaw/workspace/skills/swarm_mcp/dashboard.mjs`; it already has the Build button in the code. **To see Build on 4318:** restart that dashboard (kill the process on 4318, then run `node ~/.openclaw/workspace/skills/swarm_mcp/dashboard.mjs`).
- **Or** run the dashboard from this repo (recommended for Build: uses 3 min timeout + breakdown); it defaults to port **4319** so it doesn’t steal 4318:

```bash
cd /path/to/OpenClaw   # or: cd ~/Desktop/OpenClaw
node scripts/dashboard.mjs
# Open http://127.0.0.1:4319  (Build is in the header)
```

In either dashboard, click **Build** to:

1. Type your requirement in the textarea (or use **Enhance prompt** to turn a rough idea into a clear requirement via Groq).
2. Click **Run Build**
3. Phased orchestrator runs with `--all`
4. Watch RT Messages for progress

**No reboot needed:** After code changes (timeouts, breakdown logic), just run the build again. Restart the dashboard only if you want UI changes to apply.

**Good prompts:** One or two clear sentences work best. Examples:
- *"Build a marketing website for OpenCrew in website/ with hero, feature list, and CTA."*
- *"Add a README to the OpenClaw repo describing the phased orchestrator and how to run a build from the dashboard."*

**Enhance prompt:** The Build tab has an **Enhance prompt** button that uses Groq (env `GROQ_API_KEY`) to rewrite your idea into a single, concrete requirement. Set `GROQ_API_KEY` in your environment or in the shell that starts the dashboard.

**Do agents know about this plugin?** They only see the task text and shared memory (e.g. handoff context). To have them use this repo or its features, say so in the requirement (e.g. *"In the OpenClaw plugin repo at ... add ..."*) or add a memory/skill that describes the plugin layout and capabilities.

## Logs

- `orchestrator-logs/phased-dispatch.jsonl` – Per-task status (MVP, Phase 1, Phase 2). Status values: `completed`, `failed`, `subtask_completed`, `subtask_failed`. Failed tasks that were broken down include `breakdown_of` (original task text).

## Timeouts and output

- **Per-task timeout:** 5 minutes (300s) by default so “features section” / “agents table” tasks can finish. Override with `PHASED_TASK_TIMEOUT_MS`. PM is instructed to split so each task = one small deliverable (e.g. one subsection), not multiple in one task.
- **Bridge wait:** `gateway-bridge.mjs --send` waits up to `OPENCREW_RT_SEND_TIMEOUT_MS` (default 120s). The phased orchestrator sets this to the same value as its task timeout so the bridge doesn’t give up before the orchestrator.
- **Output:** By default all build output is directed to `OPENCLAW_DIR/website/` (e.g. `~/Desktop/OpenClaw/website/`). The PM is told to put this path in every coding task. Override with `OPENCREW_OUTPUT_DIR`. If the agent’s runtime uses a different cwd (e.g. workspace), set `OPENCREW_OUTPUT_DIR` to a path that runtime can write to (e.g. absolute path under the repo or workspace).

## "Permission requested: external_directory … auto-rejecting"

**Symptom:** crew-coder fails with `permission requested: external_directory (/Users/jeffhobbs/Desktop/OpenClaw/website/*); auto-rejecting` when creating or writing files in the output path.

**Cause:** The OpenClaw Gateway (or app) that runs the agents uses a sandbox that only allows writes inside its configured “project” or allowlist. The OpenClaw *plugin* repo path is treated as external and blocked.

**Fix (pick one):**

1. **Allow the plugin repo in OpenClaw**  
   In the OpenClaw app that runs the gateway/agents, add the plugin repo (or the `website` directory) to the allowed paths for tool writes. Where that is depends on your OpenClaw version (e.g. project settings, `openclaw.json`, or “allowed directories” / “external_directory” allowlist). Once the path is allowed, crew-coder can write to `…/OpenClaw/website/`.

2. **Use the workspace as output**  
   If the agent’s allowed project is `~/.openclaw/workspace`, send build output there instead:
   ```bash
   OPENCREW_OUTPUT_DIR="/Users/jeffhobbs/.openclaw/workspace/website" node phased-orchestrator.mjs --all "Build marketing site..."
   ```
   Then check `~/.openclaw/workspace/website/` for generated files. Copy into the plugin repo if needed.

3. **Create `website/` in the repo**  
   Ensure `website/` exists in the plugin repo (e.g. `mkdir -p ~/Desktop/OpenClaw/website`). Some sandboxes only allow writes into existing directories; creating the dir first can help. You still need the path to be allowed (fix 1) for the agent to write into it.
