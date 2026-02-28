**Title:** Show HN: crew-cli – A terminal orchestrator for multi-agent coding with a local diff sandbox

**Body:**
Hey HN,

I'm sharing `crew-cli`, a tool we built to solve the frustration of AI agents blindly overwriting files or forcing us into walled-garden IDEs.

`crew-cli` sits between your terminal and a "crew" of specialized AI agents (coders, QA, UI experts). Instead of one generic prompt, it routes your intent to the right specialist.

The part I'm most proud of is the Sandbox. When an agent suggests a code change (via Aider-style SEARCH/REPLACE blocks), it doesn't touch your file system. It stages the diff in a local `.crew/` sandbox. You can:
1. `crew preview` to see a unified diff of what the agent wants to do.
2. `crew branch` to test multiple implementations side-by-side (e.g., "build it with WebSockets" vs "build it with long-polling").
3. `crew apply` when you are ready.

We also added a token finder (`crew auth`) that can utilize your existing local session tokens (like Claude Code or Cursor) so you aren't paying double for API keys.

It's open-source and built heavily around TS, esbuild, and Node's native fetch/test modules.

Repo: https://github.com/crewswarm/crew-cli

Would love to hear your thoughts on the sandboxing approach vs direct file edits!
