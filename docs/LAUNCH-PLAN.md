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
Show HN: CrewSwarm – Switch between Claude, Cursor, Gemini mid-session. Open source
```

**URL:**
```
https://crewswarm.ai
```

**Text:**
```
I kept hitting rate limits. Claude caps out, switch to Cursor, caps out, switch to Codex. Every tool locks you into one model and one conversation.

CrewSwarm runs 6 coding engines (Claude Code, Cursor, Codex, Gemini CLI, OpenCode, crew-cli) and 24 LLM providers on your local machine. Switch per agent, mid-session. Sessions resume across engines.

It's a full local dev platform, not just a CLI:

- Dashboard (localhost:4319) — web control plane for agents, services, models, spending
- Vibe IDE (localhost:3333) — browser-native Monaco editor with agent chat and terminal
- crew-cli — 3-tier pipeline: Router → Planner (generates 7 docs) → Executor
- Telegram + WhatsApp bridges — chat with your crew from your phone
- PM Loop — describe a feature, the crew plans, builds, tests, and ships it autonomously

22 specialist agents run in parallel waves (PM plans → coder + QA + security execute simultaneously → fixer patches). Each agent gets its own model — cheap for routing, powerful for coding. Shared memory means no agent works blind.

957 tests, 0 failures. Docker install for teams. MIT licensed. Everything local.

npm install -g crewswarm

https://crewswarm.ai
https://github.com/crewswarm/crewswarm
```

**Best time to post:** Wednesday April 2, 9am ET (peak HN traffic, avoids April Fools confusion)

## Twitter/X Thread

Post from @crewswarm (or personal account):

**Tweet 1 (hook — the pain):**
```
I kept hitting rate limits on Claude. Then Cursor. Then Codex.

So we built CrewSwarm — 6 coding engines, switch mid-session. Sessions resume across engines. 24 LLM providers, all local.

Open source today. crewswarm.ai
```

**Tweet 2 (the product — visual):**
```
It's not just a CLI. It's a full local dev platform:

- Dashboard: web control plane for 22 agents
- Vibe IDE: Monaco editor + agent chat in the browser
- crew-cli: 3-tier pipeline (Router → Planner → Executor)
- Telegram + WhatsApp: chat with your crew from your phone

Same agents, any surface.
```

**Tweet 3 (wave orchestration — speed):**
```
Single-agent tools do everything in sequence. CrewSwarm runs agents in parallel waves:

Wave 1: PM plans the feature
Wave 2: crew-coder + crew-qa + crew-security all execute simultaneously
Wave 3: crew-fixer patches anything that broke

3x faster than one agent doing everything.
```

**Tweet 4 (cost — money):**
```
Per-agent model config = massive cost savings:

- Router: Groq Llama 3.3 (free) — decides what to do
- QA: Gemini CLI (free) — runs tests
- Coder: Claude Sonnet — writes the code
- PM: Grok Fast — plans quickly

$0.004 per feature vs $3-5 on a single frontier model.
```

**Tweet 5 (trust — proof):**
```
957 tests, 0 failures.
24 providers configured.
Docker install for teams.
MIT licensed.
OpenClaw plugin for their 336K users.

npm install -g crewswarm

github.com/crewswarm/crewswarm
crewswarm.ai
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
