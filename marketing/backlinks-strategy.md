# Launch Plan & Backlinks Strategy

## Launch Sequence — Tuesday April 7, 2026

### Pre-launch (Monday night)
- [ ] Repo goes public: `gh repo edit crewswarm/crewswarm --visibility public`
- [ ] Final README check (crew-cli in hero, 8 surfaces, lowercase branding)
- [ ] Blog posts verified (specialist count, provider count)
- [ ] Dev.to article published (set published: true)
- [ ] Verify npm package: `npm info crewswarm-cli`
- [ ] Verify site live: https://crewswarm.ai
- [ ] Screenshots ready for Product Hunt

### Launch day (Tuesday ~10am ET)
1. **HN post** — `show-hn-post.md` — title + URL, first comment immediately
2. **Twitter thread** — `twitter-thread.md` — post from @crewswarm right after HN
3. **Reddit posts** — `reddit-posts.md` — stagger 1-2 hours after HN
   - r/LocalLLaMA (engine angle)
   - r/OpenAI (3-tier pipeline angle)
   - r/webdev (Vibe IDE + TypeScript angle)
   - r/macapps (crewchat angle)
4. **Product Hunt** — `product-hunt.md` — same day or Wednesday
5. **Directory submissions** — `directory-submissions.md` — start same day, run all week

### After launch (Wednesday+)
6. **Backlinks outreach** — see below
7. **HN comment monitoring** — see below

---

## Backlinks Outreach (Post-Launch)

### Week 1: Directories
Submit to all directories in `directory-submissions.md`. Most approve within 24-72 hours.

### Week 1-2: Content seeding
- [ ] Cross-post Dev.to article to Hashnode
- [ ] Post on DEV.to with "discuss" tag to encourage comments
- [ ] Share in relevant Discord servers (AI coding, open source, TypeScript)
- [ ] Tweet thread from personal account linking to @crewswarm

### Week 2: Comparison content
- [ ] Write "crewswarm vs Cursor" comparison (link from AlternativeTo)
- [ ] Write "crewswarm vs Devin" comparison
- [ ] Write "crew-cli vs Claude Code CLI" for r/LocalLLaMA
- [ ] Update OpenClaw comparison page if traffic warrants

### Week 2-3: Outreach
- [ ] Reach out to AI newsletter authors (TLDR, The Batch, AI Breakfast)
- [ ] Contact dev tool YouTubers who review CLI tools
- [ ] Submit to "awesome" lists on GitHub (PRs to awesome-ai-coding, etc.)

### Ongoing: Community engagement
- Answer HN/Reddit questions thoroughly (drives upvotes)
- Share benchmark updates as we test more models
- Post engine deep-dives on Dev.to (technical audience loves internals)

---

## HN Comment Monitoring & Response Prep

**Likely questions and prepared angles:**

**"How is this different from just using Claude Code?"**
Claude Code is one of our 6 engines. crewswarm adds: multi-agent orchestration (20+ specialists in parallel), session resume across engines, crew-cli for models Claude doesn't support, and the execution quality engine. Claude Code is a great coding lane — crewswarm is the operating system for managing many coding lanes.

**"29 models at 100/100 seems too good — what's the benchmark?"**
7 TypeScript tasks: create file, add function, implement utils + tests, bugfix, refactor, fix test, calculator module. Each checked for: correct output, tsc --strict passes, all tests pass, no regressions. The engine prevents common failure modes (unread edits, no verification, repeated failures). Benchmark code is in the repo.

**"Why not just use the cheapest model for everything?"**
Without the engine, cheap models fail ~40-60% of the time on multi-step coding tasks. They skip verification, hallucinate edits, loop. The engine catches these failures deterministically. With the engine, cheap and expensive models converge to the same quality.

**"Is this just a wrapper around other CLIs?"**
crew-cli is built from scratch — ~64K lines of TypeScript. Own tool system (45+ tools), own context compaction, own quality engine. The other 5 engines (Claude Code, Codex, etc.) are integrated as execution lanes, not wrapped.

**"What about security? Agents running shell commands sounds dangerous."**
5-layer security: Docker isolation, AppArmor profiles, network firewall (blocks cloud metadata), command allowlist with dashboard approval, non-root execution. Details at crewswarm.ai/security.html.

**"Solo project? Can this be maintained?"**
Built with AI assistance — that's kind of the point. The PM loop and specialist agents helped build crewswarm itself. ~64K LOC, 877+ tests, MIT license. Community contributions welcome.

---

## Story Angles by Channel

| Channel | Lead angle | Supporting proof |
|---------|-----------|-----------------|
| HN | Rate limits → orchestration layer | Engine + benchmarks + economics |
| r/LocalLLaMA | Engine equalizes local models | Ollama support, 100/100 with Llama |
| r/OpenAI | 3-tier pipeline saves money | GPT-5.4 for planning, cheap for execution |
| r/webdev | Vibe IDE + TypeScript stack | Monaco, 227 endpoints, full architecture |
| Dev.to | Full platform story | crew-cli deep dive + comparison table |
| Product Hunt | PM mental model | 8 surfaces, specialist agents |
| Twitter | Quick hook + thread | Benchmark numbers + links |
