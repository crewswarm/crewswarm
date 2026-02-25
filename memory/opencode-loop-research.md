# OpenCode run: multi-turn or single-shot?

**Research question:** Is one `opencode run "task"` a single LLM response, or does OpenCode run an internal tool loop (LLM → tools → LLM → …) until done?

## Finding: OpenCode `run` is multi-turn with tools

- **Official agents doc** ([open-code.ai/docs/en/agents](https://open-code.ai/docs/en/agents)): *"Max steps — Control the maximum number of **agentic iterations** an agent can perform before being forced to respond with text only. If this is not set, **the agent will continue to iterate until the model chooses to stop** or the user interrupts the session."* So one session = many iterations (LLM → tools → LLM) until the model stops or max steps.

- **Inside OpenCode** ([cefboud.com deep dive](https://cefboud.com/posts/coding-agents-internals-opencode-deepdive/)): The LLM outputs `tool_use`; the client runs the tool and **feeds the result back into the LLM’s context**; the model can then call edit, bash, etc., and **either stop or keep iterating**. So one run is an internal loop.

- **CLI behavior:** `opencode run "task"` is “non-interactive” and “fire & exit” from the *user’s* perspective, but under the hood it’s one **session** that runs the agent loop until the task is done or the agent responds with text only.

## Practical takeaway

- **OpenCode already does the Ouroboros-style loop inside one run:** one task, one `opencode run`, loop inside the agent (LLM ↔ tools until done). So we don’t need a gateway-owned “LLM → mini-task → OpenCode → result → LLM” loop just to get multi-step behavior.

- **Prefer single-shot to OpenCode:** Send one clear task (+ project path) and let OpenCode’s internal loop handle steps. That’s what we do when `opencodeLoop` is off (mini task only). No need to turn on the gateway loop unless you have a specific reason.

- **When the gateway loop is still useful:** (1) You want a **different** model to decompose (e.g. cheap LLM for “next step”, OpenCode only executes). (2) You want to **interleave** other agents or tools between OpenCode steps. (3) You hit OpenCode context limits and want to keep each OpenCode call tiny (one step at a time). Otherwise, **one task, one run, loop inside the agent** is the better approach.

Last updated: 2026-02-25
