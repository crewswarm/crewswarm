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

CrewSwarm runs 6 coding engines (Claude Code, Cursor, Codex, Gemini CLI, OpenCode, crew-cli) and 24 LLM providers on your local machine. Switch per agent, per task, mid-session. No restarts.

But it's more than engine switching:

- 22 specialist agents (PM, coder, QA, security, fixer, etc.) with shared memory
- crew-cli has a 3-tier pipeline: Router ($0.0001) → Planner (generates 7 docs) → Executor (writes files)
- PM Loop reads ROADMAP.md and ships features autonomously — you describe a feature, the crew builds it
- crew test-first: generates tests, implements, validates. TDD in one command for $0.0002
- 731 tests passing, everything runs locally, MIT licensed

Surfaces: Dashboard (localhost:4319), Vibe IDE (browser), crew-cli (terminal), Telegram, WhatsApp — same agents, any surface.

npm install -g crewswarm

https://crewswarm.ai
https://github.com/crewswarm/crewswarm
https://www.npmjs.com/package/crewswarm-cli
```

**Best time to post:** Wednesday April 2, 9am ET (peak HN traffic, avoids April Fools confusion)

## Twitter/X Thread

Post from @crewswarm (or personal account):

**Tweet 1 (hook):**
```
I kept hitting rate limits on Claude. Then Cursor. Then Codex.

So we built CrewSwarm — switch between 6 coding engines mid-session. 24 LLM providers. 22 specialist agents. All local.

Open source today.

crewswarm.ai
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
