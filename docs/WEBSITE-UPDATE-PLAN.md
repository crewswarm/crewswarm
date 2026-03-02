# Website Update Plan — Missing Features & Docs

## Major Features NOT on Website

### 1. ✅ Agno Integration (NEW - 2026-03-01)
**What:** Docker deployment template, user/session isolation, three-tier approval, unified REST API
**Status:** Implemented (`AGNO-IMPROVEMENTS-COMPLETE.md`, `crewswarm-docker-template/`)
**Website needs:**
- Docker deployment section
- API documentation link
- Multi-tenancy mention

### 2. ✅ Elvis/Ralph Improvements (NEW - 2026-03-01)
**What:** Worktree isolation, multi-AI review, CI monitoring, external context
**Status:** Scripts implemented (`ELVIS-IMPROVEMENTS-COMPLETE.md`)
**Website needs:**
- Git worktree workflow docs
- Multi-LLM code review feature
- CI auto-retry feature

### 3. ✅ Flow Cleanup (NEW - 2026-03-01)
**What:** One-shot mode (fresh context), progress tracking, deprecated old orchestrators
**Status:** Just completed (`FLOW-CLEANUP-COMPLETE.md`)
**Website needs:**
- One-shot mode explanation
- Progress tracking feature
- Clean 3-flow architecture diagram

### 4. SwiftBar Integration
**What:** macOS menu bar plugin for quick access
**Status:** Complete (`SWIFTBAR-INTEGRATION-COMPLETE.md`)
**Website needs:**
- macOS menu bar feature
- Screenshot
- Install instructions

### 5. Shared Memory System
**What:** Unified knowledge across all agents (AgentMemory + AgentKeeper + Collections)
**Status:** Complete (multiple docs)
**Website needs:**
- Memory architecture explanation
- Migration guide link
- Cross-session learning feature

### 6. Five Execution Engines
**What:** OpenCode, Cursor CLI, Claude Code, Codex CLI, Gemini CLI
**Status:** All integrated
**Website current:** Only mentions "Five execution engines" in feature list
**Website needs:**
- Dedicated engines section
- Per-engine benefits/use cases
- Configuration guide

### 7. Skills System (46 Skills)
**What:** API skills (.json) + Knowledge skills (SKILL.md folders)
**Status:** 46 skills installed
**Website current:** Not mentioned
**Website needs:**
- Skills catalog
- How to add skills
- Built-in skill list

### 8. MCP Integration
**What:** Expose agents as MCP tools to Cursor/Claude Code/OpenCode
**Status:** Complete
**Website current:** Not mentioned
**Website needs:**
- MCP server feature
- "Use CrewSwarm from any IDE" section

### 9. Telegram Mini App
**What:** Native Telegram Mini App UI
**Status:** Complete (`TELEGRAM-MINIAPP-INTEGRATION.md`)
**Website current:** Only mentions "Telegram bridge"
**Website needs:**
- Mini App screenshots
- Feature comparison (bridge vs mini app)

### 10. Scheduled Pipelines (Cron)
**What:** Run workflows or skills on schedule
**Status:** Complete
**Website current:** Not mentioned
**Website needs:**
- Automation section
- Cron examples

### 11. Three-Tier Approval System
**What:** auto/user/admin approval levels with policy-driven governance
**Status:** Complete (`THREE-TIER-APPROVAL.md`)
**Website current:** Only mentions "Command approval gate"
**Website needs:**
- Governance section
- Security/compliance angle
- Enterprise features

### 12. User/Session Isolation
**What:** Multi-tenancy support, scoped chat history and memory
**Status:** Complete (`USER-SESSION-ISOLATION-MIGRATION.md`)
**Website current:** Not mentioned
**Website needs:**
- Multi-user support
- Team/enterprise positioning

---

## Documentation That Should Be Linked

### Architecture Docs
- `docs/SYSTEM-ARCHITECTURE.md` — Full system overview
- `docs/ORCHESTRATION-PROTOCOL.md` — How agents coordinate
- `docs/FLOW-CLEANUP-COMPLETE.md` — Clean 3-flow architecture

### API Docs
- `docs/UNIFIED-API.md` — REST API spec
- `scripts/unified-api.mjs` — OpenAPI 3.0 schema
- `docs/API-UNIFIED-v1.md` — Endpoint reference

### Integration Docs
- `docs/MCP-OPENAI-WRAPPER-SPEC.md` — MCP + OpenAI API
- `docs/TELEGRAM-MINIAPP-INTEGRATION.md` — Telegram Mini App
- `crewswarm-docker-template/README.md` — Docker deployment

### Developer Docs
- `CONTRIBUTING.md` — How to contribute
- `docs/TROUBLESHOOTING.md` — Common issues
- `docs/SETUP-NEW-AGENTS.md` — Add custom agents

---

## Website Structure Needs

### Missing Pages
1. **`/docs`** — Documentation hub (currently scattered)
2. **`/features`** — Detailed feature breakdown (skills, engines, memory, approval)
3. **`/integrations`** — MCP, Telegram, WhatsApp, Docker
4. **`/enterprise`** — Multi-tenancy, governance, three-tier approval
5. **`/api`** — REST API docs (link to unified API)
6. **`/changelog`** — Recent improvements (Agno, Elvis, Flow Cleanup)

### Current Website Gaps
- Hero doesn't mention multi-agent orchestration clearly
- No mention of skills system
- No mention of MCP server
- No Docker deployment option
- No governance/approval system explanation
- No shared memory explanation
- No engine routing explanation

---

## Recommended Actions

### Priority 1 (Missing Core Features)
1. Add **Skills** section — "46 built-in skills for engineering, PM, and GTM"
2. Add **Five Engines** explainer — comparison table showing when to use each
3. Add **Shared Memory** section — "Zero context loss across sessions"
4. Add **MCP Server** — "Use CrewSwarm from any IDE"

### Priority 2 (Recent Improvements)
1. Add **One-Shot Mode** — "Fresh 200k context per task"
2. Add **Docker Deployment** — enterprise-ready containerized setup
3. Add **Three-Tier Approval** — governance for enterprise
4. Add **Multi-Tenancy** — user/session isolation

### Priority 3 (Documentation)
1. Create `/docs` page with links to all major docs
2. Add Changelog page with recent releases
3. Link to GitHub docs/ folder
4. Add troubleshooting guide link

---

## Quick Wins for Homepage

1. **Update hero tagline:**
   - Current: "One requirement in. Real files out."
   - Better: "PM-led multi-agent orchestration. One requirement → real files."

2. **Add feature badges:**
   - 46 Built-in Skills
   - 5 Execution Engines
   - 20 Specialist Agents
   - Docker Ready
   - MCP Server

3. **Add "What's New" section:**
   - One-Shot Mode (fresh context)
   - Docker Template (production ready)
   - Three-Tier Approval (governance)
   - 46 Skills (engineering + PM + GTM)

4. **Add comparison section:**
   - vs LangChain/AutoGen/CrewAI
   - Highlight: real file writes, PM-led, any model per agent

Want me to update the website with these features?