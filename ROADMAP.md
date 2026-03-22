# crewswarm — Product Roadmap

> Core product development (ops, features, infrastructure). Last updated: **2026-03-16**

---

## Current Status (March 2026)

**Production-ready:** ✅ All core features working  
**Documentation:** ✅ Cleaned up (168 → 15 essential docs)  
**Docker:** ✅ Multi-arch images (AMD64 + ARM64)  
**Security:** ✅ API keys purged from git history  
**Brand:** ✅ Lowercase "crewswarm" (consistent)  
**Ready for:** Public beta release

## ✅ Completed Features (Production-Ready)

### Core Infrastructure
- ✅ **Modular architecture** — Extracted from monolithic files
  - `lib/crew-lead/` — HTTP server, chat handling, classification
  - `lib/pipeline/` — Multi-agent orchestration
  - `lib/skills/` — Skill loader + runner with transformation support
  - `lib/agents/` — Agent registry + dispatch
  - `lib/engines/` — OpenCode, Cursor CLI, Claude Code, Codex adapters
  - `lib/tools/` — Tool executor + permissions
  - `lib/runtime/` — Config, memory, startup guards
  - `apps/dashboard/src/tabs/` — Dashboard tab modules
  
- ✅ **CI/CD** — GitHub Actions smoke tests (static + integration)
- ✅ **Docker** — Multi-arch images (AMD64 + ARM64)
- ✅ **Install script** — Non-interactive mode for automation

### Engine Integration
- ✅ **Multi-engine support** — OpenCode, Cursor CLI, Claude Code, Codex CLI
- ✅ **Ouroboros loop** — LLM ↔ Engine iterative refinement
- ✅ **Engine passthrough** — Direct chat to any coding engine
- ✅ **OpenCode --attach** — Persistent MCP server (no cold boot)

### Agent Capabilities
- ✅ **20 specialist agents** — Full-stack, frontend, backend, QA, security, PM, etc.
- ✅ **Domain-aware planning** — Subsystem-specific PM agents (crew-pm-cli, crew-pm-frontend, crew-pm-core)
- ✅ **MCP server** — Expose all agents as MCP tools for Cursor/Claude/OpenCode
- ✅ **Skill system** — 46+ skills (API + knowledge-based)
- ✅ **Tool permissions** — Per-agent granular control

### Communication & Integrations
- ✅ **Telegram bridge** — Topic routing, self-dispatch, role-based permissions
- ✅ **WhatsApp bridge** — Personal bot via Baileys
- ✅ **Dashboard** — Web UI for management + chat
- ✅ **Vibe** — Full IDE with Monaco editor (port 3333)
- ✅ **CrewChat.app** — Native macOS app (Quick + Advanced modes)

### Memory & Context
- ✅ **Shared memory** — Unified AgentMemory + AgentKeeper across all agents
- ✅ **Chat history persistence** — Project-level message storage + RAG search
- ✅ **Background consciousness** — Idle reflection loop (crew-main)

### Workflow Automation
- ✅ **Workflow system** — Cron-based scheduling with workflow CRUD APIs
- ✅ **Continuous build** — Build automation infrastructure
- ✅ **Pipeline orchestration** — Phased dispatch with concurrency control


## Backlog

### Grok/xAI Integration ✅ COMPLETE

**Two implementations:**

1. **crew-lead** — Skill-based integration
   - `grok.x-search` — Real-time Twitter/X search
   - `grok.vision` — Image analysis with grok-vision-beta
   - Skills use transformation layer (`_bodyTransform` / `_responseExtract`)
   - Works for any OpenAI-compatible API

2. **crew-cli** — Native tool support
   - `crew x-search` command with full `/v1/responses` API
   - Citations with X post URLs
   - Advanced filters (date ranges, handles, media types)
   - Dedicated TypeScript integration

**Configuration:**
```json
// ~/.crewswarm/crewswarm.json
{
  "providers": {
    "xai": { "apiKey": "xai-..." }
  }
}
```

**Market differentiation:** Only AI coding platform with real-time X/Twitter intelligence.

---

## 🔮 Planned Features

### Shared Chat Hybrid (agentchattr-style, optional) 🆕
**Priority:** Medium-High  
**Effort:** 7-12 days for MVP
**Status:** In progress

**What it does**: Adds a shared chat coordination layer for humans and agents without replacing `@@DISPATCH`.

**Product shape**:
- `@@DISPATCH` remains the command plane
- Shared channels become the swarm coordination plane
- MCP chat tools let any agent runtime participate

**MVP scope**:
- Shared channel/message substrate
- Dashboard main chat + direct agent chat on one mention-aware path
- MCP tools: `chat_send`, `chat_read`, `chat_channels`, `chat_who`
- Dispatch completion write-back into channels

**Implemented so far**:
- Shared `projectId` / `general` message substrate remains the source of truth
- Main chat and direct agent chat now share the same autonomous mention router
- MCP MVP chat tools are wired on top of the shared history store
- Dispatch origin metadata now flows into sub-agent unified-history write-back
- Dashboard Swarm Chat now uses the unified `/api/chat/unified` path with explicit channel-mode routing
- Direct agent chat paths (`/api/chat-agent` and `/chat` with `targetAgent`) now return inline replies instead of dispatch-only task IDs
- Swarm room history can exclude direct-chat noise so autonomous room threads stay focused on channel traffic
- Telegram and WhatsApp direct-target chats now route through the same direct-chat semantics as dashboard agent chat
- Smoke coverage exists for main-chat direct agent routing, `/api/chat-agent`, `/chat targetAgent`, and swarm room dispatch/completion flows

**Later scope**:
- Summaries
- Rules
- Job proposal / claim
- Channel UI panels

**Documentation:** See `docs/AGENTCHATTR-HYBRID-PDD.md`, `docs/AGENTCHATTR-HYBRID-ARCHITECTURE.md`, and `docs/AGENTCHATTR-HYBRID-ROADMAP.md`

### Background Agent System (AutoFix) 🆕
**Priority:** High  
**Effort:** 10-14 days  
**Inspired by:** GitHub Copilot Autofix, GitHub Advanced Security

**What it does**: Background autonomous agent that automatically detects and fixes:
- Security vulnerabilities (CVEs, secrets, dependency issues)
- Code quality issues (linter errors, code smells)
- Test failures (flaky tests, missing coverage)
- Documentation drift (broken links, outdated docs)

**How it works**:
1. **Scan** → Detect issues (CodeQL, ESLint, npm audit, etc.)
2. **Route** → Dispatch to specialized agent (crew-security, crew-fixer, crew-qa)
3. **Fix** → Generate fix in isolated sandbox
4. **Review** → Self-review (run tests, security scan, blast radius)
5. **PR** → Create pull request with full context

**Key features**:
- ✅ Multi-platform (GitHub, GitLab, Bitbucket, local)
- ✅ 14 specialized agents (vs GitHub's single agent)
- ✅ Multi-provider LLMs (not locked to one vendor)
- ✅ More issue types (security, quality, tests, docs, deps)
- ✅ Self-hosted option (keep data private)
- ✅ Configurable limits (max PRs/day, confidence thresholds)

**Competitive advantage**:
- GitHub Copilot: 3x faster vulnerability remediation, but GitHub-only + requires Advanced Security ($)
- crewswarm: Open-source, works anywhere, more powerful, specialized agents

**Scheduling options**:
1. GitHub Actions (daily cron job)
2. Continuous daemon (local/self-hosted)
3. On-demand CLI: `crew autofix run`

**Configuration**:
```json
// .crew/autofix.json
{
  "enabled": true,
  "schedule": "0 2 * * *",
  "scanners": {
    "security": {"enabled": true, "severity": ["high", "critical"]},
    "quality": {"enabled": true, "autofix": true},
    "tests": {"enabled": true, "fixFlaky": true}
  },
  "limits": {"maxPRsPerRun": 3, "minConfidence": 0.7}
}
```

**Status:** PDD written, not yet started  
**Documentation:** See `PDD-BACKGROUND-AGENT-AUTOFIX.md` for complete plan

---

### Public Release Preparation
**Priority:** High  
**Effort:** 2-3 days

**Tasks:**
- [x] Final documentation audit (AGENTS.md, README.md, CONTRIBUTING.md)  ✗ 12:50:57 AM  ✓ 1:34:43 AM (crew-copywriter)
- [x] Remove development logs from repo (125 files → archive)  ✓ 1:01:29 AM (crew-github)
- [x] Version tagging (`0.1.0-beta`)  ✓ 1:01:47 AM (crew-github)
- [!] Demo video production  ✗ 1:07:05 AM  ✗ 1:40:10 AM
- [x] Launch announcement (blog, X/Twitter, HN)  ✗ 1:23:22 AM  ✓ 1:50:30 AM (crew-copywriter)

---

### crew-cli Enhancements (Optional)

**Medium priority:**
- Real-world cost/speed benchmark (validate 3-tier architecture claims)
- LSP auto-fix integration (type errors → auto-dispatch to crew-fixer)
- Repository map visualization (`crew map --visualize`)

**Low priority:**
- Semantic memory deduplication (reduce AgentKeeper size)
- Skill marketplace/registry (`crew skills install <name>`)
- Agent collaboration patterns (workflow DSL)


---

## Next Steps

### Immediate (March 2026)
1. **Public release preparation** (2-3 days)
   - Documentation audit
   - Remove development logs
   - Version tagging `0.1.0-beta`
   - Demo video
   - Launch announcement

2. **Browser automation** (2-3 days)
   - Add basic Puppeteer/Playwright tool surface for agents
   - Start with navigate, screenshot, click, type, and simple permission controls
   - Use existing analysis in `OPENCLAW-COMPARISON-FINAL.md` and `BROWSER-AUTOMATION-GUIDE.md`

3. **Background Agent System (AutoFix)** (10-14 days)
   - Competitive feature matching GitHub Copilot
   - Automatic vulnerability + quality fixes
   - See `PDD-BACKGROUND-AGENT-AUTOFIX.md`

4. **Discord bridge execution** (5-7 days)
   - Planning docs already exist; move from spec into implementation
   - See `docs/DISCORD-BRIDGE-ROADMAP.md`

### Future Enhancements (Optional)
- Real-world cost/speed benchmark (validate 3-tier claims)
- Slack bridge
- LSP auto-fix integration
- Skill marketplace/registry
- Agent collaboration patterns (workflow DSL)

---

## Model Recommendations

**See**: `crew-cli/MODEL-RECOMMENDATIONS.md` for full details

**Recommended stack:**
- **Router:** `google/gemini-2.5-flash` (fast, cheap)
- **Executor:** `anthropic/claude-sonnet-4.5` (high quality)
- **Workers:** `groq/llama-3.3-70b-versatile` (parallel tasks)

**Expected savings:** ~73% cost reduction vs single-tier, 3x faster

---

## Competitive Position

**vs GitHub Copilot:**
- ✅ Full feature parity (slash commands, GitHub integration, autopilot)
- ✅ More agents (20 vs 1 generic assistant)
- ✅ Multi-provider (not locked to one LLM vendor)
- ✅ Self-hosted option (keep data private)
- ✅ Grok integration (real-time X/Twitter intelligence)
- ⏳ Background autofix (planned, matches their latest feature)

**Unique capabilities:**
- Multi-engine support (OpenCode, Cursor CLI, Claude Code, Codex)
- Domain-aware planning (subsystem specialists)
- MCP server (works in any MCP-compatible tool)
- Workflow automation (cron-based scheduling)

---

**Last updated:** March 16, 2026
