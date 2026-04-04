# Launch Plan

## Pre-flight checklist

- [ ] Flip GitHub repo to public: https://github.com/crewswarm/crewswarm/settings → Danger Zone → Make public
- [ ] Enable GitHub Discussions: Settings → Features → Discussions (gives users a place to talk without opening issues)
- [ ] Uncomment stars badge in `website/index.html` (~line 224)
- [ ] `git push && ./website/deploy-now.sh`
- [ ] Verify: https://crewswarm.ai shows stars badge
- [ ] Verify: `npm view crewswarm` and `npm view crewswarm-cli` both work
- [ ] Upload quickstart.mp4 to YouTube (unlisted or public) for embedding in posts
- [ ] Have GIFs ready for Reddit/X: `website/vibe-assets/quickstart.gif` (442KB) and `demo.gif` (1.1MB)

## Hacker News

Post to: https://news.ycombinator.com/submit

**Title:**
```
Show HN: CrewSwarm – You are the PM, the agents are the engineers
```

**URL:**
```
https://crewswarm.ai
```

**Text:**
```
I kept hitting rate limits and single-agent bottlenecks. Claude caps out, switch to Cursor, caps out, switch to Codex. Even when the model is good, one agent doing everything sequentially is still the wrong operating model.

The mental model that ended up working better was: you are the PM, the agents are the engineers.

CrewSwarm is built around that. It runs 6 coding engines (Claude Code, Cursor, Codex, Gemini CLI, OpenCode, crew-cli) and 24 LLM providers on your local machine. Different agents use different engines and models. Sessions resume across engines.

It's a full local dev platform, not just a CLI:

- Dashboard (localhost:4319) — web control plane for agents, services, models, spending
- Vibe IDE (localhost:3333) — browser-native Monaco editor with agent chat and terminal
- crew-cli — 3-tier pipeline: Router → Planner (generates 7 docs) → Executor
- Telegram + WhatsApp bridges — chat with your crew from your phone
- PM Loop — describe a feature, the crew plans, builds, tests, and ships it autonomously

22 specialist agents run in parallel waves (PM plans → coder + QA + security execute simultaneously → fixer patches). Each agent gets its own model — cheap or local for routing and worker glue, premium for planning and hard reasoning. Shared memory means no agent works blind.

4,355 tests. Docker install for teams. MIT licensed. Everything local.

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

The deeper problem: one person driving one agent is still too sequential.

So we built CrewSwarm — the PM loop for AI engineering. You are the PM, the agents are the engineers. 6 coding engines. 24 providers. All local.

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

The job becomes orchestration: keep the workers unblocked, not watch one agent type.
```

**Tweet 4 (cost — money):**
```
Per-agent model config = massive cost savings:

- Router: cheap or local lane — decides what to do
- PM brain: premium model — planning + hard reasoning
- QA/worker glue: cheap models or local lanes
- Coder: premium only where code quality matters most

Pay for the brain, not the glue.
```

**Tweet 5 (trust — proof):**
```
4,355 tests.
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
Title: Show r/programming: We built a PM loop for AI engineering instead of one giant coding agent

Body: [shorter version, focus on the architecture]
```

**r/ChatGPTCoding:**
```
Title: Built a tool that lets you switch between Claude Code, Cursor, Gemini, and Codex mid-conversation — sessions persist across engines

Body: Every $20/month plan has rate limits. I kept hitting the wall mid-feature. So I built CrewSwarm — it runs all 6 coding CLIs and lets you switch seamlessly. Your session context follows you. 4,355 tests, fully local, MIT licensed. crewswarm.ai
```

**r/SideProject:**
```
Title: CrewSwarm — 22 AI agents that build features for you while you eat dinner (open source)

Body: PM Loop reads your ROADMAP.md and ships. The human acts more like a PM than a typist: define the goal, keep workers unblocked, review outputs. Agents run in parallel waves — backend, frontend, tests all built simultaneously. Built the crewswarm.ai website itself in 30 minutes. npm install -g crewswarm
```

## Product Hunt

Save for Week 2 — don't split attention on launch day. PH needs a dedicated tagline, gallery images, and maker comments.

## HN Comment FAQ (have ready)

**"How is this different from CrewAI / LangGraph / AutoGen?"**
> Those are Python frameworks for building multi-agent systems from scratch. CrewSwarm is a ready-to-run platform — install, configure models, start building. Dashboard, IDE, CLI, messaging bridges all included. No Python, no framework code, no orchestration boilerplate.

**"Why not just use Claude Code?"**
> Claude Code is one excellent coding lane. CrewSwarm is the PM loop around many coding lanes. It runs Claude Code as one of 6 engines — plus Cursor, Codex, Gemini, OpenCode, crew-cli. Different agents use different engines. When Claude hits rate limits, your coder can switch to Codex. When you need fast QA, Gemini or a local lane can run cheaply. The PM Loop plans and ships features autonomously across all of them.

**"This seems over-engineered"**
> For "fix this bug" — yes, use Claude Code directly. CrewSwarm's value shows on multi-step work: "build user auth, test it, review for security." That's 3 agents working in parallel waves, each with the right model. One agent doing all 3 sequentially is slower and more expensive.

**"How does this compare to Devin?"**
> Devin is cloud-hosted, closed-source, and expensive. CrewSwarm runs on your machine. Your code never leaves your disk. MIT licensed. Bring your own API keys — no middleman markup.

**"4,355 tests — are they real?"**
> Yes. The repo has thousands of automated checks across unit, integration, E2E, Playwright, smoke, and live verification tiers. Exact totals move as the suite grows, so point people to `docs/CANONICAL/TESTING.md` for the current breakdown and commands.

## After launch

- Monitor HN comments — respond quickly to technical questions
- Check GitHub issues — first impression matters
- Track npm downloads: `npm view crewswarm`
- Cross-post blog articles to Dev.to
- Join Cursor/Claude Code/OpenCode discords and mention where relevant
