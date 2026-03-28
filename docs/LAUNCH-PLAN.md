# Launch Plan

## Pre-flight checklist

- [ ] Flip GitHub repo to public: https://github.com/crewswarm/crewswarm/settings → Danger Zone → Make public
- [ ] Uncomment stars badge in `website/index.html` (~line 224)
- [ ] `git push && bash website/deploy-now.sh`
- [ ] Verify: https://crewswarm.ai shows stars badge
- [ ] Verify: `npm view crewswarm` and `npm view crewswarm-cli` both work

## Hacker News

Post to: https://news.ycombinator.com/submit

**Title:**
```
Show HN: CrewSwarm – Open-source multi-agent coding orchestration (local-first)
```

**URL:**
```
https://github.com/crewswarm/crewswarm
```

**Text (leave blank or short):**
```
CrewSwarm is a local-first multi-agent orchestration platform for software development. Instead of one AI model doing everything, it runs 22 specialist agents (PM, coder, QA, security, etc.) coordinated by an autonomous PM loop.

Key differences from single-agent tools (Claude Code, Cursor, Codex):
- 3-tier pipeline in crew-cli: Router → Planner → Executor (different models per tier)
- 6 coding engines: Claude Code, Cursor, Codex, Gemini CLI, OpenCode, crew-cli
- 24 LLM providers — mix per agent (cheap for routing, powerful for coding)
- PM Loop reads a ROADMAP.md and ships features autonomously
- Shared memory across all agents — no agent works blind
- Dashboard, Vibe IDE, crew-cli, Telegram, WhatsApp — same crew, any surface

Everything runs on your machine. Your code, your keys, no cloud proxy. MIT licensed.

npm install -g crewswarm
```

**Best time to post:** 8-9am ET weekday (highest HN traffic)

## Twitter/X Thread

Post from @crewswarm (or personal account):

**Tweet 1 (hook):**
```
We just open-sourced CrewSwarm — a local-first multi-agent orchestration platform for software development.

22 specialist AI agents. 6 coding engines. One crew.

Instead of one model doing everything, we split the work: PM plans, coder builds, QA tests, fixer debugs.

github.com/crewswarm/crewswarm
```

**Tweet 2 (the pipeline):**
```
The crew-cli has a 3-tier pipeline that no other CLI agent has:

1. Router (fast model, $0.0001) — decides HOW to handle the task
2. Planner — generates 7 docs (PDD, ROADMAP, ARCH) before code
3. Executor — writes files, runs commands, verifies output

Simple tasks skip planning. Complex ones get the full treatment.
```

**Tweet 3 (cost):**
```
Cost comparison for a real feature build:

Single-agent (Claude/GPT): $3-5 per feature
CrewSwarm: $0.004-0.05 per feature

How? Cheap models for routing ($0.0001), free models for QA (Gemini CLI), expensive models only for the hard stuff.
```

**Tweet 4 (engines):**
```
6 coding engines, your choice per agent:
- Claude Code (reasoning)
- Cursor CLI (fast edits)
- Codex CLI (sandboxed)
- Gemini CLI (free tier)
- OpenCode (any provider)
- crew-cli (3-tier pipeline)

Switch from the dashboard. No restarts.
```

**Tweet 5 (CTA):**
```
npm install -g crewswarm

24 providers. 22 agents. 7 surfaces. MIT licensed.

github.com/crewswarm/crewswarm
crewswarm.ai
npm: crewswarm
```

## Reddit

**r/LocalLLaMA** (most relevant):
```
Title: CrewSwarm: open-source local-first multi-agent orchestration — 22 agents, 24 providers, runs on your machine

Body: [same as HN text, add: "Works with Ollama for fully offline operation"]
```

**r/programming:**
```
Title: Show r/programming: We built a multi-agent coding platform that uses different models for different jobs

Body: [shorter version, focus on the architecture]
```

## Product Hunt

Save for Week 2 — don't split attention on launch day. PH needs a dedicated tagline, gallery images, and maker comments.

## After launch

- Monitor HN comments — respond quickly to technical questions
- Check GitHub issues — first impression matters
- Track npm downloads: `npm view crewswarm`
- Cross-post blog articles to Dev.to
- Join Cursor/Claude Code/OpenCode discords and mention where relevant
